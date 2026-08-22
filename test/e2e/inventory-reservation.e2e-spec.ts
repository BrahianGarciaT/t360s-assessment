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

// This spec deliberately stops/starts the `inventory` container (down
// scenario). It runs first alphabetically among the e2e specs
// (`inventory-reservation` < `order-flow` < `outbox-resilience`) under
// `--runInBand`, and its `afterAll` always restores `inventory` before
// the suite finishes — so the later specs, which both depend on a
// healthy `inventory` for their own stock seeding, are never perturbed.
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
      // `ConflictException({ reason, shortfalls })` — passing a plain
      // object to Nest's HttpException constructor uses it verbatim as
      // the response body, unwrapped (no `statusCode`/`message` envelope).
      expect(res.data.reason).toBe('INSUFFICIENT_STOCK');
      expect(Array.isArray(res.data.shortfalls)).toBe(true);

      const orderCount = await countOrdersByUserId(ordersDbClient, userId);
      expect(orderCount).toBe(0);
    });

    it('fails hard with 503 when inventory is unreachable — no order row created', async () => {
      const productId = 'prod-e2e-inv-down';
      const userId = 'user-e2e-inv-down';

      // Seed stock while inventory is still up — the point of this test is
      // the transport failure, not a shortfall.
      const seedRes = await inventoryApi.put(`/stock/${productId}`, {
        quantity: 100,
      });
      expect(seedRes.status).toBe(200);

      stopService('inventory');

      try {
        // Confirm inventory really is down before asserting on the gate —
        // otherwise a slow container stop could let the request race a
        // still-healthy instance and produce a false pass.
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
        // Always restart, even if an assertion above failed — otherwise
        // every later e2e spec in this run starts from a broken state.
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

      // Reserve happens synchronously inside POST /orders, before the order
      // row is even created, so the reservation is visible immediately.
      const reservedStock = (
        await inventoryApi.get<StockLevel>(`/stock/${productId}`)
      ).data;
      expect(reservedStock.quantity).toBe(100);
      expect(reservedStock.reserved).toBe(10);

      const confirmRes = await ordersApi.put(`/orders/${orderId}/status`, {
        status: 'CONFIRMED',
      });
      expect(confirmRes.status).toBe(200);

      // Delivery of `inventory.commit_requested` depends on the outbox
      // poller's interval — poll instead of a fixed sleep.
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

      // Cancellation restores availability without touching total quantity
      // on hand — release, not commit.
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

      // Reserve the entire stock and never confirm or cancel it.
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

      // A second order for the same fully-reserved product must be
      // rejected while the first reservation is still held.
      const shortfallRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(secondUserId, productId, 10),
      );
      expect(shortfallRes.status).toBe(409);

      // Force the held reservation's TTL into the past instead of sleeping
      // the real 15-minute `INVENTORY_RESERVATION_TTL_MINUTES` window — see
      // `forceExpireReservation`'s docstring for why this is the only
      // test-friendly option without restarting the `inventory` container.
      await forceExpireReservation(inventoryDbClient, heldOrderId);

      // `ReservationReaperService` runs on `@Cron(EVERY_MINUTE)`, so the
      // next tick auto-releases it within roughly a minute.
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

      // Proof the released stock is genuinely available again: a brand
      // new order for the full quantity now succeeds.
      const secondCreateRes = await ordersApi.post(
        '/orders',
        buildOrderPayload(secondUserId, productId, 10),
      );
      expect(secondCreateRes.status).toBe(201);
    }, 120_000);
  },
);
