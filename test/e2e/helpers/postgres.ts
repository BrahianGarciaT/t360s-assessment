import { Client } from 'pg';

export interface OutboxEventRow {
  id: string;
  status: string;
  attempts: number;
}

/**
 * Conexión desde el lado del host: el proceso e2e corre fuera de la red de
 * Docker, por lo que debe llegar a Postgres a través del puerto mapeado
 * `localhost:5432` de `docker-compose.yml` — nunca `ORDERS_DB_HOST` (eso resuelve
 * al nombre del servicio `postgres`, solo accesible desde dentro de la red de compose).
 * Usuario/contraseña/db por defecto usan los valores ya versionados en `.env.example`.
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
 * La fila más reciente de `outbox_events` para un orderId dado. La estrategia de
 * nombrado por defecto de TypeORM mantiene los nombres de columna en camelCase
 * tal cual (sin transformación a snake_case), de ahí el identificador entre comillas `"createdAt"`.
 *
 * Una sola transición de orden ahora puede generar más de una fila de outbox
 * (por ejemplo, `order.status_changed` más un evento finalize de `inventory.*` en
 * CONFIRMED/CANCELLED). Pasar `eventType` para fijar la consulta a una de ellas —
 * sin esto, "la más reciente" es ambiguo entre filas hermanas insertadas en la
 * misma transacción y entregadas de forma independiente.
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

/**
 * Cuenta filas de `orders` para un `userId` dado — se usa para probar que un
 * `POST /orders` rechazado (409 stock insuficiente, 503 inventory inalcanzable)
 * nunca creó una fila de orden, sin depender del listado paginado de
 * `GET /orders` (que mezcla filas de todos los demás tests e2e).
 * Cada spec usa un `userId` único por escenario, así que esto es exacto.
 */
export async function countOrdersByUserId(
  client: Client,
  userId: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM orders WHERE "userId" = $1`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
