import { Client } from 'pg';

/**
 * Host-side connection to `postgres-inventory` — the e2e process runs
 * outside the Docker network, so it must reach Postgres via the mapped
 * `localhost:5433` port from `docker-compose.yml` (`5433:5432`, a
 * different host port than the container's own 5432, unlike `orders`'s
 * `postgres`). User/password/db default to the values already checked
 * into `.env.example`. Mirrors `createOutboxDbClient()` in
 * `./postgres.ts`.
 */
function resolveConnectionConfig() {
  return {
    host: 'localhost',
    port: 5433,
    user: process.env.INVENTORY_DB_USER ?? 'inventory_user',
    password: process.env.INVENTORY_DB_PASSWORD ?? 'inventory_pass',
    database: process.env.INVENTORY_DB_NAME ?? 'inventory_db',
  };
}

export function createInventoryDbClient(): Client {
  return new Client(resolveConnectionConfig());
}

/**
 * Forces a `held` reservation's `expiresAt` into the past, one minute
 * before now, so the next `@Cron(EVERY_MINUTE)` reaper tick
 * (`ReservationReaperService`) releases it on its own.
 *
 * `INVENTORY_RESERVATION_TTL_MINUTES` (default 15) is read once into
 * `ReservationReaperService`'s config at process startup
 * (`getInventoryConfig()`), so it cannot be overridden per-test without
 * restarting the `inventory` container — manipulating `expiresAt`
 * directly is the only way to exercise the reaper's auto-release path in
 * an e2e test without sleeping 15 real minutes. No-op (0 rows affected)
 * if the reservation is not currently `held` (e.g. already
 * committed/released).
 */
export async function forceExpireReservation(
  client: Client,
  orderId: string,
): Promise<void> {
  await client.query(
    `UPDATE reservations
     SET "expiresAt" = now() - interval '1 minute'
     WHERE "orderId" = $1 AND status = 'held'`,
    [orderId],
  );
}
