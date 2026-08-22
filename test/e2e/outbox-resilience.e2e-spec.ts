import axios, { AxiosInstance } from 'axios';
import { Client } from 'pg';
import {
  isDockerComposeAvailable,
  startService,
  stopService,
} from './helpers/docker';
import {
  createOutboxDbClient,
  findLatestOutboxEventForOrder,
  OutboxEventRow,
} from './helpers/postgres';
import {
  waitForAuditLogs,
  waitUntil,
  withTransientRetry,
} from './helpers/wait';

const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:3000';
const AUDIT_URL = process.env.AUDIT_URL ?? 'http://localhost:3001';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://localhost:3002';
const API_KEY = process.env.API_KEY ?? 'your-secret-api-key-here';

const ORDER_PAYLOAD = {
  userId: 'user-e2e-resilience',
  items: [
    {
      productId: 'prod-e2e-resilience',
      productName: 'Resilience Widget',
      quantity: 1,
      price: 20,
    },
  ],
  notes: 'outbox resilience demo',
};

// Este spec detiene/inicia deliberadamente el contenedor `audit`. Se ejecuta en
// orden alfabético después de `order-flow.e2e-spec.ts` (`order-flow` < `outbox-resilience`)
// bajo `--runInBand`, por lo que no puede afectar la suite del camino feliz.
const dockerAvailable = isDockerComposeAvailable();

(dockerAvailable ? describe : describe.skip)(
  'Outbox resilience — audit outage and recovery (e2e)',
  () => {
    let ordersApi: AxiosInstance;
    let auditApi: AxiosInstance;
    let inventoryApi: AxiosInstance;
    let dbClient: Client;

    beforeAll(async () => {
      ordersApi = axios.create({
        baseURL: ORDERS_URL,
        headers: { 'x-api-key': API_KEY },
        validateStatus: () => true,
      });
      auditApi = axios.create({
        baseURL: AUDIT_URL,
        validateStatus: () => true,
        timeout: 8000,
      });
      inventoryApi = axios.create({
        baseURL: INVENTORY_URL,
        headers: { 'x-api-key': API_KEY },
        validateStatus: () => true,
      });

      // Gate: POST /orders ahora reserva stock de forma síncrona contra
      // `inventory` antes de crear la orden (409/503 en caso contrario). Sembrar
      // stock suficiente para el ítem que el ORDER_PAYLOAD de esta suite solicita.
      const seedRes = await inventoryApi.put('/stock/prod-e2e-resilience', {
        quantity: 1000,
      });
      expect(seedRes.status).toBe(200);

      dbClient = createOutboxDbClient();
      await dbClient.connect();
    }, 120_000);

    afterAll(async () => {
      // Siempre reiniciar `audit`, incluso si alguna aserción anterior falló — de lo
      // contrario, cada corrida de tests posterior (local o CI) arranca desde un estado roto.
      try {
        startService('audit');
        await waitUntil<boolean>(
          async () => {
            const res = await auditApi
              .get('/audit/health-check-probe')
              .catch(() => null);
            return res !== null && res.status === 200 ? true : false;
          },
          {
            timeoutMs: 90_000,
            description: 'audit to accept connections again',
          },
        );
      } finally {
        await dbClient?.end().catch(() => undefined);
      }
    }, 120_000);

    it('commits the status change while audit is down, then delivers once audit recovers', async () => {
      // 1. Crear la orden mientras audit está saludable (evento de audit base #1).
      const createRes = await ordersApi.post('/orders', ORDER_PAYLOAD);
      expect(createRes.status).toBe(201);
      const orderId: string = createRes.data.id;

      await waitForAuditLogs(auditApi, orderId, 1, 20_000);

      // 2. Derribar audit.
      stopService('audit');

      // 3. Cambiar el estado — debe seguir haciendo commit rápido, desacoplado de audit.
      //
      // Envuelto en `withTransientRetry`: esta solicitud específica, justo después
      // de detener un contenedor hermano en la misma red bridge de Docker, es
      // la que ocasionalmente presenta un ECONNRESET/"socket hang up" transitorio
      // en CI (el demonio Docker Linux de GitHub Actions) — no es un
      // crash de `orders` (verificado mediante logs de CI ininterrumpidos en dos corridas) ni
      // algo que la app `orders` pueda controlar (el handler de PUT nunca
      // se comunica con `audit`). Ver el docstring de `withTransientRetry` en
      // `helpers/wait.ts` para la investigación y evidencia completas. `start`
      // se captura después de cualquier reintento para que la aserción de `elapsedMs` de abajo
      // siga midiendo únicamente la solicitud que realmente tuvo éxito.
      let start = Date.now();
      const statusRes = await withTransientRetry(() => {
        start = Date.now();
        return ordersApi.put(`/orders/${orderId}/status`, {
          status: 'CONFIRMED',
        });
      });
      const elapsedMs = Date.now() - start;

      expect(statusRes.status).toBe(200);
      expect(statusRes.data.status).toBe('CONFIRMED');
      expect(elapsedMs).toBeLessThan(2000);

      // 4. El evento del outbox para esta transición está pendiente en Postgres.
      // Fijado a `order.status_changed`: CONFIRMED ahora también genera una
      // fila de `inventory.commit_requested` en la misma transacción, e
      // inventory (nunca derribado en esta suite) entrega de forma independiente
      // de la caída de audit — "latest" sin un filtro por tipo generaría una condición de carrera.
      const pendingRow = await waitUntil<OutboxEventRow>(
        async () => {
          const row = await findLatestOutboxEventForOrder(
            dbClient,
            orderId,
            'order.status_changed',
          );
          return row && row.status === 'pending' ? row : false;
        },
        {
          timeoutMs: 10_000,
          description: `outbox_events row for order ${orderId} to be pending`,
        },
      );
      expect(pendingRow.status).toBe('pending');

      // 5. audit realmente está caído — la solicitud debe fallar a nivel de
      // transporte (conexión rechazada), nunca resolver con un status HTTP.
      let downError: unknown;
      try {
        await auditApi.get(`/audit/${orderId}`);
      } catch (err) {
        downError = err;
      }
      expect(downError).toBeInstanceOf(Error);

      // 6. Volver a levantar audit.
      startService('audit');

      // 7. Hacer polling hasta que el poller entregue: el endpoint de audit vuelve a responder.
      await waitUntil<boolean>(
        async () => {
          const res = await auditApi.get(`/audit/${orderId}`).catch(() => null);
          return res && res.status === 200 ? true : false;
        },
        {
          timeoutMs: 90_000,
          description: 'audit to respond again after restart',
        },
      );

      // 8. Hacer polling sobre outbox_events hasta que el poller lo marque como sent. Mismo
      // fijado a `order.status_changed` que en el paso 4 — de lo contrario esto podría tomar
      // la fila hermana `inventory.commit_requested`, que llega a `sent` según
      // su propio cronograma y nunca coincidirá con el eventId del log de audit de abajo.
      const sentRow = await waitUntil<OutboxEventRow>(
        async () => {
          const row = await findLatestOutboxEventForOrder(
            dbClient,
            orderId,
            'order.status_changed',
          );
          return row && row.status === 'sent' ? row : false;
        },
        {
          timeoutMs: 60_000,
          description: `outbox_events row for order ${orderId} to be sent`,
        },
      );

      // 9. Exactamente un log de audit para esta transición — entrega + dedup en
      // una sola aserción. El total es 2: el evento de creación + este evento CONFIRMED.
      const logs = (await waitForAuditLogs(
        auditApi,
        orderId,
        2,
        30_000,
      )) as Array<{ toStatus: string; eventId?: string }>;

      const confirmedLogs = logs.filter((log) => log.toStatus === 'CONFIRMED');
      expect(confirmedLogs).toHaveLength(1);
      expect(confirmedLogs[0].eventId).toBe(sentRow.id);
    }, 180_000);
  },
);
