import axios, { AxiosInstance } from 'axios';
import { waitForAuditLogs } from './helpers/wait';

const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:3000';
const AUDIT_URL = process.env.AUDIT_URL ?? 'http://localhost:3001';
const INVENTORY_URL = process.env.INVENTORY_URL ?? 'http://localhost:3002';
const API_KEY = process.env.API_KEY ?? 'your-secret-api-key-here';

const ordersApi: AxiosInstance = axios.create({
  baseURL: ORDERS_URL,
  headers: { 'x-api-key': API_KEY },
  validateStatus: () => true,
});

const auditApi: AxiosInstance = axios.create({
  baseURL: AUDIT_URL,
  validateStatus: () => true,
});

const inventoryApi: AxiosInstance = axios.create({
  baseURL: INVENTORY_URL,
  headers: { 'x-api-key': API_KEY },
  validateStatus: () => true,
});

const ORDER_PAYLOAD = {
  userId: 'user-e2e-01',
  items: [
    {
      productId: 'prod-e2e-01',
      productName: 'Widget Pro',
      quantity: 2,
      price: 15.5,
    },
  ],
  notes: 'urgent delivery',
};

describe('Order flow (e2e)', () => {
  let orderId: string;

  beforeAll(async () => {
    // Gate: POST /orders now reserves stock synchronously against `inventory`
    // before creating the order (409/503 otherwise). Seed enough stock for
    // every item this suite's ORDER_PAYLOAD requests.
    const res = await inventoryApi.put('/stock/prod-e2e-01', {
      quantity: 1000,
    });
    expect(res.status).toBe(200);
  }, 30_000);

  it('POST /orders — creates order with PENDING status', async () => {
    const res = await ordersApi.post('/orders', ORDER_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.data.status).toBe('PENDING');
    expect(Number(res.data.totalAmount)).toBe(31); // 2 * 15.50
    expect(res.data.id).toBeDefined();

    orderId = res.data.id;
  });

  it('GET /orders — returns paginated list with the created order', async () => {
    const res = await ordersApi.get('/orders');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data.some((o: { id: string }) => o.id === orderId)).toBe(
      true,
    );
  });

  it('GET /orders/search?q=Widget Pro — finds order by full-text search', async () => {
    const res = await ordersApi.get('/orders/search', {
      params: { q: 'Widget Pro' },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data.some((o: { id: string }) => o.id === orderId)).toBe(
      true,
    );
  });

  it('PUT /orders/:id/status — valid transition PENDING → CONFIRMED', async () => {
    const res = await ordersApi.put(`/orders/${orderId}/status`, {
      status: 'CONFIRMED',
    });

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('CONFIRMED');
  });

  it('PUT /orders/:id/status — invalid transition CONFIRMED → PENDING', async () => {
    const res = await ordersApi.put(`/orders/${orderId}/status`, {
      status: 'PENDING',
    });

    expect(res.status).toBe(400);
  });

  it('PUT /orders/:id/status — valid transition CONFIRMED → SHIPPED', async () => {
    const res = await ordersApi.put(`/orders/${orderId}/status`, {
      status: 'SHIPPED',
    });

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('SHIPPED');
  });

  it('GET /orders — filters by status SHIPPED', async () => {
    const res = await ordersApi.get('/orders', {
      params: { status: 'SHIPPED' },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data.some((o: { id: string }) => o.id === orderId)).toBe(
      true,
    );
  });

  it('GET /audit/:orderId — recorded all status changes', async () => {
    // Delivery latency now depends on the outbox poller's interval
    // (`OUTBOX_POLL_INTERVAL_MS`, default 2s) instead of being near-immediate,
    // so a fixed sleep would be either flaky or wastefully slow — poll instead.
    await waitForAuditLogs(auditApi, orderId, 3, 20_000);

    const res = await auditApi.get(`/audit/${orderId}`);

    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(3);

    expect(res.data[0].fromStatus).toBeNull();
    expect(res.data[0].toStatus).toBe('PENDING');

    expect(res.data[1].fromStatus).toBe('PENDING');
    expect(res.data[1].toStatus).toBe('CONFIRMED');

    expect(res.data[2].fromStatus).toBe('CONFIRMED');
    expect(res.data[2].toStatus).toBe('SHIPPED');

    const timestamps: number[] = res.data.map((log: { timestamp: string }) =>
      new Date(log.timestamp).getTime(),
    );
    expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeLessThanOrEqual(timestamps[2]);
  });

  it('POST /orders — rejects request without API key', async () => {
    const res = await axios.post(`${ORDERS_URL}/orders`, ORDER_PAYLOAD, {
      validateStatus: () => true,
    });

    expect(res.status).toBe(401);
  });

  it('POST /orders — rejects request with wrong API key', async () => {
    const res = await axios.post(`${ORDERS_URL}/orders`, ORDER_PAYLOAD, {
      headers: { 'x-api-key': 'wrong-key' },
      validateStatus: () => true,
    });

    expect(res.status).toBe(401);
  });
});
