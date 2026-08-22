import axios, { AxiosInstance } from 'axios';
import { Client } from 'pg';
import {
  isDockerComposeAvailable,
  startService,
  stopService,
} from './helpers/docker';
import { countOrdersByUserId, createOutboxDbClient } from './helpers/postgres';
import {
  createInventoryDbClient,
  forceExpireReservation,
} from './helpers/inventory-db';
import { waitUntil } from './helpers/wait';

const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:3000';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://localhost:3002';
const API_KEY = process.env.API_KEY ?? 'your-secret-api-key-here';

interface StockLevel {
  productId: string;
  quantity: number;
  reserved: number;
}

function buildOrderPayload(userId: string, productId: string, qty: number) {
  return {
    userId,
    items: [
      {
        productId,
        productName: 'Reservation Test Widget',
        quantity: qty,
        price: 10,
      },
    ],
    notes: 'inventory reservation e2e',
  };
}

// Este spec detiene/inicia deliberadamente el contenedor `inventory` (escenario
// down). Se ejecuta primero en orden alfabético entre los specs e2e
// (`inventory-reservation` < `order-flow` < `outbox-resilience`) bajo
// `--runInBand`, y su `afterAll` siempre restaura `inventory` antes de
// que finalice la suite — así los specs posteriores, que dependen ambos de un
// `inventory` saludable para sembrar su propio stock, nunca se ven afectados.
const dockerAvailable = isDockerComposeAvailable();

(dockerAvailable ? describe : describe.skip)(
  'Inventory reservation gate (e2e)',
  () => {
    let ordersApi: AxiosInstance;
    let inventoryApi: AxiosInstance;
    let ordersDbClient: Client;
    let inventoryDbClient: Client;

    beforeAll(async () => {
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

      ordersDbClient = createOutboxDbClient();
      await ordersDbClient.connect();

      inventoryDbClient = createInventoryDbClient();
      await inventoryDbClient.connect();
    }, 30_000);

    afterAll(async () => {
      await ordersDbClient?.end().catch(() => undefined);
      await inventoryDbClient?.end().catch(() => undefined);
    });

    it('rejects an order with insufficient stock — 409, no order row created', async () => {
      const productId = 'prod-e2e-inv-shortage';
      const userId = 'user-e2e-inv-shortage';

      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 1,
      });
      expect(seedRes.status).toBe(200);

      const res = await ordersApi.post(
        '/orders',
        buildOrderPayload(userId, productId, 5),
      );

      expect(res.status).toBe(409);
      // `ConflictException({ reason, shortfalls })` — pasar un objeto plano
      // al constructor de HttpException de Nest lo usa tal cual como
      // cuerpo de la respuesta, sin envoltorio (sin `statusCode`/`message`).
      expect(res.data.reason).toBe('INSUFFICIENT_STOCK');
      expect(Array.isArray(res.data.shortfalls)).toBe(true);

      const orderCount = await countOrdersByUserId(ordersDbClient, userId);
      expect(orderCount).toBe(0);
    });

    it('fails hard with 503 when inventory is unreachable — no order row created', async () => {
      const productId = 'prod-e2e-inv-down';
      const userId = 'user-e2e-inv-down';

      // Sembrar stock mientras inventory todavía está arriba — el propósito de
      // este test es la falla de transporte, no un faltante de stock.
      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 100,
      });
      expect(seedRes.status).toBe(200);

      stopService('inventory');

      try {
        // Confirmar que inventory realmente está caído antes de verificar el gate —
        // de lo contrario, un stop lento del contenedor podría dejar que la
        // solicitud compita con una instancia aún saludable y produzca un falso positivo.
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

        const res = await ordersApi.post(
          '/orders',
          buildOrderPayload(userId, productId, 1),
        );

        expect(res.status).toBe(503);

        const orderCount = await countOrdersByUserId(ordersDbClient, userId);
        expect(orderCount).toBe(0);
      } finally {
        // Siempre reiniciar, incluso si alguna aserción anterior falló — de lo
        // contrario, todos los specs e2e posteriores en esta corrida arrancan desde un estado roto.
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
    }, 150_000);

    it('CONFIRMED commits the reservation — stock is actually decremented', async () => {
      const productId = 'prod-e2e-inv-commit';
      const userId = 'user-e2e-inv-commit';

      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 100,
      });
      expect(seedRes.status).toBe(200);

      const createRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(userId, productId, 10),
      );
      expect(createRes.status).toBe(201);
      const orderId: string = createRes.data.id;

      // La reserva ocurre de forma síncrona dentro de POST /orders, antes de que
      // se cree siquiera la fila de la orden, por lo que la reserva es visible de inmediato.
      const reservedStock = (
        await inventoryApi.get<StockLevel>(`/stock/${productId}`)
      ).data;
      expect(reservedStock.quantity).toBe(100);
      expect(reservedStock.reserved).toBe(10);

      const confirmRes = await ordersApi.put(`/orders/${orderId}/status`, {
        status: 'CONFIRMED',
      });
      expect(confirmRes.status).toBe(200);

      // La entrega de `inventory.commit_requested` depende del intervalo del
      // poller del outbox — hacer polling en lugar de un sleep fijo.
      const committedStock = await waitUntil<StockLevel>(
        async () => {
          const res = await inventoryApi.get<StockLevel>(`/stock/${productId}`);
          return res.data.reserved === 0 ? res.data : false;
        },
        {
          timeoutMs: 20_000,
          description: `stock/${productId} to reach reserved=0 after commit`,
        },
      );

      expect(committedStock.quantity).toBe(90);
      expect(committedStock.reserved).toBe(0);
    }, 30_000);

    it('CANCELLED releases the reservation — reserved returns to available, quantity unchanged', async () => {
      const productId = 'prod-e2e-inv-cancel';
      const userId = 'user-e2e-inv-cancel';

      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 50,
      });
      expect(seedRes.status).toBe(200);

      const createRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(userId, productId, 5),
      );
      expect(createRes.status).toBe(201);
      const orderId: string = createRes.data.id;

      const reservedStock = (
        await inventoryApi.get<StockLevel>(`/stock/${productId}`)
      ).data;
      expect(reservedStock.reserved).toBe(5);

      const cancelRes = await ordersApi.put(`/orders/${orderId}/status`, {
        status: 'CANCELLED',
      });
      expect(cancelRes.status).toBe(200);

      const releasedStock = await waitUntil<StockLevel>(
        async () => {
          const res = await inventoryApi.get<StockLevel>(`/stock/${productId}`);
          return res.data.reserved === 0 ? res.data : false;
        },
        {
          timeoutMs: 20_000,
          description: `stock/${productId} to reach reserved=0 after cancel`,
        },
      );

      // La cancelación restaura la disponibilidad sin tocar la cantidad total
      // en existencia — es release, no commit.
      expect(releasedStock.quantity).toBe(50);
      expect(releasedStock.reserved).toBe(0);
    }, 30_000);

    it('an unconfirmed reservation auto-releases via TTL, freeing stock for a new order', async () => {
      const productId = 'prod-e2e-inv-ttl';
      const firstUserId = 'user-e2e-inv-ttl-first';
      const secondUserId = 'user-e2e-inv-ttl-second';

      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 10,
      });
      expect(seedRes.status).toBe(200);

      // Reservar todo el stock y nunca confirmarlo ni cancelarlo.
      const createRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(firstUserId, productId, 10),
      );
      expect(createRes.status).toBe(201);
      const heldOrderId: string = createRes.data.id;

      const heldStock = (
        await inventoryApi.get<StockLevel>(`/stock/${productId}`)
      ).data;
      expect(heldStock.reserved).toBe(10);

      // Una segunda orden para el mismo producto totalmente reservado debe ser
      // rechazada mientras la primera reserva se mantenga vigente.
      const shortfallRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(secondUserId, productId, 10),
      );
      expect(shortfallRes.status).toBe(409);

      // Forzar el TTL de la reserva retenida hacia el pasado en lugar de esperar
      // la ventana real de 15 minutos de `INVENTORY_RESERVATION_TTL_MINUTES` — ver
      // el docstring de `forceExpireReservation` para entender por qué esta es la
      // única opción viable para tests sin reiniciar el contenedor `inventory`.
      await forceExpireReservation(inventoryDbClient, heldOrderId);

      // `ReservationReaperService` se ejecuta con `@Cron(EVERY_MINUTE)`, por lo que
      // el próximo tick la auto-libera en aproximadamente un minuto.
      const autoReleasedStock = await waitUntil<StockLevel>(
        async () => {
          const res = await inventoryApi.get<StockLevel>(`/stock/${productId}`);
          return res.data.reserved === 0 ? res.data : false;
        },
        {
          timeoutMs: 90_000,
          description: `stock/${productId} to auto-release via the reaper`,
        },
      );
      expect(autoReleasedStock.quantity).toBe(10);
      expect(autoReleasedStock.reserved).toBe(0);

      // Prueba de que el stock liberado está genuinamente disponible de nuevo: una
      // orden completamente nueva por la cantidad total ahora tiene éxito.
      const secondCreateRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(secondUserId, productId, 10),
      );
      expect(secondCreateRes.status).toBe(201);
    }, 120_000);

    it('never oversells under truly concurrent reservations against the same SKU', async () => {
      // La propia estrategia de testing del diseño (obs #210) exige "N reservas
      // paralelas contra Postgres real; verificar reserved <= quantity" como
      // prueba a nivel de Integration. Este repo no tiene un harness de
      // integración con la BD más liviano que hable con la instancia real de
      // Postgres de inventory fuera de esta capa e2e (los specs unitarios simulan
      // `manager.query()` por completo — las llamadas mock secuenciales no pueden
      // probar la seguridad ante solicitudes concurrentes), por lo que aquí se
      // disparan solicitudes HTTP verdaderamente concurrentes contra el stack real
      // en ejecución (orders -> TCP -> inventory -> UPDATE condicional real
      // contra Postgres real), que es la única forma de ejercitar concurrencia
      // genuina a nivel de BD en lugar de llamadas secuenciales a nivel de aplicación.
      const productId = 'prod-e2e-inv-concurrent';
      const seedQuantity = 10;
      const qtyPerOrder = 3;
      const concurrentOrderCount = 5; // 5 * 3 = 15 solicitadas vs 10 disponibles

      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: seedQuantity,
      });
      expect(seedRes.status).toBe(200);

      const userIds = Array.from(
        { length: concurrentOrderCount },
        (_, i) => `user-e2e-inv-concurrent-${i}`,
      );

      // Promise.all dispara cada POST /orders en paralelo — sin await entre
      // solicitudes — de modo que los cinco intentos de reserva compiten entre sí
      // dentro de la transacción real de Postgres de inventory, no uno a la vez.
      const results = await Promise.all(
        userIds.map((userId) =>
          ordersApi.post(
            '/orders',
            buildOrderPayload(userId, productId, qtyPerOrder),
          ),
        ),
      );

      const succeeded = results.filter((res) => res.status === 201);
      const rejected = results.filter((res) => res.status === 409);

      // Exactamente floor(10/3) = 3 órdenes caben; el COUNT determinístico prueba
      // que no ocurrió doble aceptación bajo concurrencia real, sin importar
      // cuáles 3 de las 5 solicitudes concurrentes ganaron efectivamente el row lock.
      const expectedSuccessCount = Math.floor(seedQuantity / qtyPerOrder);
      expect(succeeded.length).toBe(expectedSuccessCount);
      expect(rejected.length).toBe(concurrentOrderCount - expectedSuccessCount);
      rejected.forEach((res) => {
        expect(res.data.reason).toBe('INSUFFICIENT_STOCK');
      });

      const finalStock = (
        await inventoryApi.get<StockLevel>(`/stock/${productId}`)
      ).data;
      // La garantía central de "no oversell": la cantidad total reservada nunca
      // excede el stock disponible, probado contra escritores concurrentes reales.
      expect(finalStock.reserved).toBeLessThanOrEqual(finalStock.quantity);
      expect(finalStock.reserved).toBe(succeeded.length * qtyPerOrder);
      expect(finalStock.quantity).toBe(seedQuantity);
    }, 30_000);
  },
);
