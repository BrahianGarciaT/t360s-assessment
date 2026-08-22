import axios, { AxiosInstance } from 'axios';
import {
  isDockerComposeAvailable,
  startService,
  stopService,
} from './helpers/docker';
import { waitUntil } from './helpers/wait';

const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:3000';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://localhost:3002';
const API_KEY = process.env.API_KEY ?? 'your-secret-api-key-here';

// Deben coincidir con los defaults documentados en `orders.constants.ts`
// (`INVENTORY_BREAKER_FAILURE_THRESHOLD` / `INVENTORY_BREAKER_RESET_TIMEOUT_MS`).
// Este spec no sobreescribe esas variables de entorno — ejercita el
// comportamiento por defecto tal como lo vería un despliegue real.
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_RESET_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOrderPayload(userId: string, productId: string, qty: number) {
  return {
    userId,
    items: [
      {
        productId,
        productName: 'Circuit Breaker Test Widget',
        quantity: qty,
        price: 10,
      },
    ],
    notes: 'inventory circuit breaker e2e',
  };
}

// Este spec detiene/inicia deliberadamente el contenedor `inventory`, igual que
// `inventory-reservation.e2e-spec.ts`. Se ejecuta en un archivo separado (uno
// por concern, siguiendo la convención existente de `outbox-resilience` e
// `inventory-reservation`) porque prueba el circuit breaker en sí — el
// conteo de fallas consecutivas, el fail-fast en estado abierto y la
// recuperación vía half-open — no el gate de reserva/stock que ya cubre
// `inventory-reservation.e2e-spec.ts`. Su `afterAll`/`finally` siempre
// restaura `inventory` antes de terminar, para no afectar specs posteriores
// bajo `--runInBand`.
const dockerAvailable = isDockerComposeAvailable();

(dockerAvailable ? describe : describe.skip)(
  'Inventory circuit breaker (e2e)',
  () => {
    let ordersApi: AxiosInstance;
    let inventoryApi: AxiosInstance;

    beforeAll(() => {
      ordersApi = axios.create({
        baseURL: ORDERS_URL,
        headers: { 'x-api-key': API_KEY },
        validateStatus: () => true,
      });
      inventoryApi = axios.create({
        baseURL: INVENTORY_URL,
        headers: { 'x-api-key': API_KEY },
        validateStatus: () => true,
      });
    }, 30_000);

    afterAll(async () => {
      // Red de seguridad final: si alguna aserción de abajo falla antes de
      // llegar al `finally` del test, esto igual deja `inventory` arriba para
      // que cualquier suite posterior no arranque sobre un contenedor caído.
      startService('inventory');
      await waitUntil<boolean>(
        async () => {
          const res = await inventoryApi.get('/health').catch(() => null);
          return res !== null && res.status === 200 ? true : false;
        },
        {
          timeoutMs: 90_000,
          description: 'inventory to accept connections again',
        },
      ).catch(() => undefined);
    }, 120_000);

    it('trips open after consecutive transport failures, fails fast while open, then recovers via half-open', async () => {
      const productId = 'prod-e2e-cb-fastfail';

      // Sembrar stock mientras inventory todavía está saludable — necesario
      // para que la solicitud de recuperación al final del test pueda
      // completar una reserva real, no solo pasar el gate del breaker.
      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 10,
      });
      expect(seedRes.status).toBe(200);

      stopService('inventory');

      try {
        // Confirmar que inventory realmente está caído antes de disparar los
        // intentos que deben contar como fallas de transporte — de lo
        // contrario un stop lento del contenedor podría dejar pasar una
        // solicitud contra una instancia aún saludable y desbalancear el
        // conteo consecutivo del breaker.
        await waitUntil<boolean>(
          async () => {
            const res = await inventoryApi.get('/health').catch(() => null);
            return res === null ? true : false;
          },
          {
            timeoutMs: 30_000,
            description: 'inventory to stop accepting connections',
          },
        );

        // 1-5: exactamente `BREAKER_FAILURE_THRESHOLD` fallas de transporte
        // consecutivas — cada una incrementa el contador del breaker; la
        // quinta lo dispara a open. Todas deben seguir devolviendo el mismo
        // contrato 503 de siempre (sin cambio observable de status code).
        for (let attempt = 1; attempt <= BREAKER_FAILURE_THRESHOLD; attempt++) {
          const res = await ordersApi.post(
            '/orders',
            buildOrderPayload(`user-e2e-cb-${attempt}`, productId, 1),
          );
          expect(res.status).toBe(503);
        }

        // El breaker ya está open. La siguiente solicitud debe fallar rápido
        // sin siquiera intentar la llamada TCP — mismo contrato 503 de
        // siempre, pero muy por debajo del send-timeout de 3000ms. El timing
        // aquí es evidencia corroborativa (una falla de transporte real
        // contra un contenedor detenido también suele ser casi instantánea
        // por ECONNREFUSED); la garantía no-flaky autoritativa de que la
        // operación jamás se invocó vive a nivel unitario en
        // `inventory-circuit-breaker.spec.ts`.
        const openedAt = Date.now();
        const rejectedRes = await ordersApi.post(
          '/orders',
          buildOrderPayload('user-e2e-cb-open', productId, 1),
        );
        const elapsedMs = Date.now() - openedAt;

        expect(rejectedRes.status).toBe(503);
        expect(elapsedMs).toBeLessThan(300);

        // Recuperación: reiniciar inventory y esperar a que vuelva a aceptar
        // conexiones antes de esperar el reset timeout — de lo contrario el
        // trial de half-open fallaría igual por transporte y reabriría el
        // circuito, extendiendo la espera otros 15s.
        startService('inventory');
        await waitUntil<boolean>(
          async () => {
            const res = await inventoryApi.get('/health').catch(() => null);
            return res !== null && res.status === 200 ? true : false;
          },
          {
            timeoutMs: 90_000,
            description: 'inventory to accept connections again',
          },
        );

        // Esperar el resto del reset timeout desde que el breaker abrió (con
        // un margen de 1s) para que el próximo POST caiga en half-open y
        // admita el trial, en vez de seguir siendo rechazado en open.
        const elapsedSinceOpen = Date.now() - openedAt;
        const remainingMs = BREAKER_RESET_TIMEOUT_MS - elapsedSinceOpen + 1000;
        if (remainingMs > 0) {
          await sleep(remainingMs);
        }

        // El trial de half-open tiene éxito (inventory ya está arriba) → el
        // breaker cierra y la orden se crea normalmente, con una reserva real.
        const recoveredRes = await ordersApi.post(
          '/orders',
          buildOrderPayload('user-e2e-cb-recovered', productId, 1),
        );
        expect(recoveredRes.status).toBe(201);
      } finally {
        startService('inventory');
        await waitUntil<boolean>(
          async () => {
            const res = await inventoryApi.get('/health').catch(() => null);
            return res !== null && res.status === 200 ? true : false;
          },
          {
            timeoutMs: 90_000,
            description: 'inventory to accept connections again',
          },
        );
      }
    }, 180_000);
  },
);
