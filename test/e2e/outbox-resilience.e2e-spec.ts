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
import { waitForAuditLogs, waitUntil } from './helpers/wait';

const ORDERS_URL = process.env.ORDERS_URL ?? 'http://localhost:3000';
const AUDIT_URL = process.env.AUDIT_URL ?? 'http://localhost:3001';
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

// This spec deliberately stops/starts the `audit` container. Runs alphabetically
// after `order-flow.e2e-spec.ts` (`order-flow` < `outbox-resilience`) under
// `--runInBand`, so it cannot perturb the happy-path suite.
const dockerAvailable = isDockerComposeAvailable();

(dockerAvailable ? describe : describe.skip)(
  'Outbox resilience — audit outage and recovery (e2e)',
  () => {
    let ordersApi: AxiosInstance;
    let auditApi: AxiosInstance;
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

      dbClient = createOutboxDbClient();
      await dbClient.connect();
    }, 120_000);

    afterAll(async () => {
      // Always restart `audit`, even if an assertion above failed — otherwise
      // every subsequent test run (local or CI) starts from a broken state.
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
      // 1. Create the order while audit is healthy (baseline audit event #1).
      const createRes = await ordersApi.post('/orders', ORDER_PAYLOAD);
      expect(createRes.status).toBe(201);
      const orderId: string = createRes.data.id;

      await waitForAuditLogs(auditApi, orderId, 1, 20_000);

      // 2. Take audit down.
      stopService('audit');

      // 3. Change status — must still commit fast, decoupled from audit.
      const start = Date.now();
      const statusRes = await ordersApi.put(`/orders/${orderId}/status`, {
        status: 'CONFIRMED',
      });
      const elapsedMs = Date.now() - start;

      expect(statusRes.status).toBe(200);
      expect(statusRes.data.status).toBe('CONFIRMED');
      expect(elapsedMs).toBeLessThan(2000);

      // 4. The outbox event for this transition is pending in Postgres.
      const pendingRow = await waitUntil<OutboxEventRow>(
        async () => {
          const row = await findLatestOutboxEventForOrder(dbClient, orderId);
          return row && row.status === 'pending' ? row : false;
        },
        {
          timeoutMs: 10_000,
          description: `outbox_events row for order ${orderId} to be pending`,
        },
      );
      expect(pendingRow.status).toBe('pending');

      // 5. audit really is down — the request must fail at the transport
      // level (connection refused), never resolve with an HTTP status.
      let downError: unknown;
      try {
        await auditApi.get(`/audit/${orderId}`);
      } catch (err) {
        downError = err;
      }
      expect(downError).toBeInstanceOf(Error);

      // 6. Bring audit back up.
      startService('audit');

      // 7. Poll until the poller delivers: audit endpoint responds again.
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

      // 8. Poll outbox_events until the poller marks it sent.
      const sentRow = await waitUntil<OutboxEventRow>(
        async () => {
          const row = await findLatestOutboxEventForOrder(dbClient, orderId);
          return row && row.status === 'sent' ? row : false;
        },
        {
          timeoutMs: 60_000,
          description: `outbox_events row for order ${orderId} to be sent`,
        },
      );

      // 9. Exactly one audit log for this transition — delivery + dedup in
      // one assertion. Total is 2: creation event + this CONFIRMED event.
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
