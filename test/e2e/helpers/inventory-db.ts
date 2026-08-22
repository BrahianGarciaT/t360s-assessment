import { Client } from 'pg';

/**
 * Conexión desde el lado del host hacia `postgres-inventory` — el proceso e2e
 * corre fuera de la red de Docker, por lo que debe llegar a Postgres a través del
 * puerto mapeado `localhost:5433` de `docker-compose.yml` (`5433:5432`, un
 * puerto de host distinto al 5432 propio del contenedor, a diferencia del
 * `postgres` de `orders`). Usuario/contraseña/db por defecto usan los valores ya
 * versionados en `.env.example`. Refleja a `createOutboxDbClient()` en
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
 * Fuerza el `expiresAt` de una reserva `held` hacia el pasado, un minuto
 * antes de ahora, para que el próximo tick del reaper `@Cron(EVERY_MINUTE)`
 * (`ReservationReaperService`) la libere por su cuenta.
 *
 * `INVENTORY_RESERVATION_TTL_MINUTES` (15 por defecto) se lee una sola vez hacia
 * la configuración de `ReservationReaperService` al arrancar el proceso
 * (`getInventoryConfig()`), por lo que no se puede sobrescribir por test sin
 * reiniciar el contenedor `inventory` — manipular `expiresAt`
 * directamente es la única forma de ejercitar el camino de auto-liberación del reaper en
 * un test e2e sin dormir 15 minutos reales. Es un no-op (0 filas afectadas)
 * si la reserva no está actualmente `held` (por ejemplo, ya
 * confirmada/liberada).
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
