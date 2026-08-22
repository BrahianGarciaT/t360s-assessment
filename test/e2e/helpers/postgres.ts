import { Client } from 'pg';

export interface OutboxEventRow {
  id: string;
  status: string;
  attempts: number;
}

/**
 * Host-side connection: the e2e process runs outside the Docker network, so
 * it must reach Postgres via the mapped `localhost:5432` port from
 * `docker-compose.yml` — never `ORDERS_DB_HOST` (that resolves to the
 * `postgres` service name, only reachable from inside the compose network).
 * User/password/db default to the values already checked into `.env.example`.
 */
function resolveConnectionConfig() {
  return {
    host: 'localhost',
    port: Number(process.env.ORDERS_DB_PORT ?? 5432),
    user: process.env.ORDERS_DB_USER ?? 'orders_user',
    password: process.env.ORDERS_DB_PASSWORD ?? 'orders_pass',
    database: process.env.ORDERS_DB_NAME ?? 'orders_db',
  };
}

export function createOutboxDbClient(): Client {
  return new Client(resolveConnectionConfig());
}

/**
 * Latest `outbox_events` row for a given orderId. TypeORM's default naming
 * strategy keeps camelCase column names verbatim (no snake_case
 * transformation), hence the quoted `"createdAt"` identifier.
 *
 * A single order transition can now fan out to more than one outbox row
 * (e.g. `order.status_changed` plus an `inventory.*` finalize event on
 * CONFIRMED/CANCELLED). Pass `eventType` to pin the query to one of them —
 * without it, "latest" is ambiguous between sibling rows inserted in the
 * same transaction and delivered independently.
 */
export async function findLatestOutboxEventForOrder(
  client: Client,
  orderId: string,
  eventType?: string,
): Promise<OutboxEventRow | null> {
  const result = await client.query<OutboxEventRow>(
    `SELECT id, status, attempts
     FROM outbox_events
     WHERE payload ->> 'orderId' = $1
       AND ($2::text IS NULL OR "eventType" = $2)
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    [orderId, eventType ?? null],
  );
  return result.rows[0] ?? null;
}
