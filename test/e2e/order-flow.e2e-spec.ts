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
  headers: { 'x-api-key': API_KEY },
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
    // Gate: POST /orders ahora reserva stock de forma síncrona contra `inventory`
    // antes de crear la orden (409/503 en caso contrario). Sembrar stock suficiente
    // para cada ítem que el ORDER_PAYLOAD de esta suite solicita.
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
    // La latencia de entrega ahora depende del intervalo del poller del outbox
    // (`OUTBOX_POLL_INTERVAL_MS`, 2s por defecto) en lugar de ser casi inmediata,
    // por lo que un sleep fijo sería inestable o innecesariamente lento — mejor hacer polling.
    // Filtrado a `order.status_changed`: el create y el CONFIRMED de esta orden
    // también generan `inventory.reserved`/`inventory.committed` en la misma
    // `orderId`, y este test solo verifica el lifecycle de la orden.
    await waitForAuditLogs(
      auditApi,
      orderId,
      3,
      20_000,
      'order.status_changed',
    );

    const res = await auditApi.get(`/audit/${orderId}`);
    expect(res.status).toBe(200);

    const orderLogs = res.data.filter(
      (log: { eventType: string }) => log.eventType === 'order.status_changed',
    );
    expect(orderLogs).toHaveLength(3);

    expect(orderLogs[0].fromStatus).toBeNull();
    expect(orderLogs[0].toStatus).toBe('PENDING');

    expect(orderLogs[1].fromStatus).toBe('PENDING');
    expect(orderLogs[1].toStatus).toBe('CONFIRMED');

    expect(orderLogs[2].fromStatus).toBe('CONFIRMED');
    expect(orderLogs[2].toStatus).toBe('SHIPPED');

    const timestamps: number[] = orderLogs.map((log: { timestamp: string }) =>
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

describe('Correlation id propagation into inventory audit trail (e2e)', () => {
  const productId = 'prod-e2e-correlation-01';

  const buildPayload = (userId: string) => ({
    userId,
    items: [
      {
        productId,
        productName: 'Correlation Widget',
        quantity: 1,
        price: 9.99,
      },
    ],
    notes: 'correlation id propagation e2e',
  });

  beforeAll(async () => {
    const res = await inventoryApi.put(`/stock/${productId}`, {
      quantity: 1000,
    });
    expect(res.status).toBe(200);
  }, 30_000);

  it('propagates x-correlation-id from POST /orders through inventory.reserved, inventory.committed, and order.status_changed rows', async () => {
    const correlationId = 'e2e-corr-reserve-commit';

    const createRes = await ordersApi.post(
      '/orders',
      buildPayload('user-e2e-correlation-01'),
      { headers: { 'x-correlation-id': correlationId } },
    );
    expect(createRes.status).toBe(201);
    const orderId: string = createRes.data.id;

    await waitForAuditLogs(auditApi, orderId, 1, 20_000, 'inventory.reserved');

    const confirmRes = await ordersApi.put(
      `/orders/${orderId}/status`,
      { status: 'CONFIRMED' },
      { headers: { 'x-correlation-id': correlationId } },
    );
    expect(confirmRes.status).toBe(200);

    await waitForAuditLogs(
      auditApi,
      orderId,
      1,
      20_000,
      'inventory.committed',
    );

    const res = await auditApi.get(`/audit/${orderId}`);
    expect(res.status).toBe(200);

    const reservedLog = res.data.find(
      (log: { eventType: string }) => log.eventType === 'inventory.reserved',
    );
    const committedLog = res.data.find(
      (log: { eventType: string }) => log.eventType === 'inventory.committed',
    );
    const statusChangedLogs = res.data.filter(
      (log: { eventType: string }) => log.eventType === 'order.status_changed',
    );

    expect(reservedLog.metadata?.correlationId).toBe(correlationId);
    expect(committedLog.metadata?.correlationId).toBe(correlationId);
    expect(statusChangedLogs.length).toBeGreaterThan(0);
    statusChangedLogs.forEach(
      (log: { metadata?: { correlationId?: string } }) => {
        expect(log.metadata?.correlationId).toBe(correlationId);
      },
    );
  }, 30_000);

  it('propagates x-correlation-id through inventory.released when an order is cancelled', async () => {
    const correlationId = 'e2e-corr-release';

    const createRes = await ordersApi.post(
      '/orders',
      buildPayload('user-e2e-correlation-02'),
      { headers: { 'x-correlation-id': correlationId } },
    );
    expect(createRes.status).toBe(201);
    const orderId: string = createRes.data.id;

    await waitForAuditLogs(auditApi, orderId, 1, 20_000, 'inventory.reserved');

    const cancelRes = await ordersApi.put(
      `/orders/${orderId}/status`,
      { status: 'CANCELLED' },
      { headers: { 'x-correlation-id': correlationId } },
    );
    expect(cancelRes.status).toBe(200);

    const releasedLogs = await waitForAuditLogs(
      auditApi,
      orderId,
      1,
      20_000,
      'inventory.released',
    );

    expect(
      (releasedLogs[0] as { metadata?: { correlationId?: string } }).metadata
        ?.correlationId,
    ).toBe(correlationId);
  }, 30_000);

  it('auto-generates a correlation id when no x-correlation-id header is sent — inventory.reserved row still carries a defined non-empty id (not an error)', async () => {
    const createRes = await ordersApi.post(
      '/orders',
      buildPayload('user-e2e-correlation-03'),
    );
    expect(createRes.status).toBe(201);
    const orderId: string = createRes.data.id;

    const reservedLogs = await waitForAuditLogs(
      auditApi,
      orderId,
      1,
      20_000,
      'inventory.reserved',
    );

    const reservedLog = reservedLogs[0] as {
      metadata?: { correlationId?: string };
    };
    // pino-http's genReqId auto-generates a UUID whenever the header is
    // absent (see libs/shared/src/config/pino-logger.config.ts) — the
    // request-level correlationId is therefore never truly undefined at the
    // HTTP boundary, only server-generated instead of client-supplied.
    expect(typeof reservedLog.metadata?.correlationId).toBe('string');
    expect(reservedLog.metadata?.correlationId?.length).toBeGreaterThan(0);
  }, 30_000);
});
