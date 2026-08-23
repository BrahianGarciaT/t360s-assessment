# Orders Audit System

Sistema de gestión de órdenes compuesto por tres microservicios NestJS que se comunican entre sí vía TCP: uno gestiona el ciclo de vida de las órdenes sobre PostgreSQL, otro reserva y compensa stock sobre su propio PostgreSQL, y el tercero mantiene un log de auditoría inmutable en MongoDB ante cada cambio de estado de una orden y cada movimiento de inventario.

Es un proyecto personal pensado para explorar y mostrar patrones de arquitectura de microservicios en NestJS: comunicación TCP entre servicios, full-text search nativo de PostgreSQL, un repository pattern desacoplado del ORM, un gate de reserva de stock que resuelve consistencia distribuida sin 2PC/saga, y documentación de API con Swagger — todo corriendo con Docker Compose sin dependencias externas.

### Features

- CRUD de órdenes con validación de items y cálculo automático de `totalAmount`
- Máquina de estados con transiciones válidas (`PENDING → CONFIRMED → SHIPPED → DELIVERED`, con `CANCELLED` como salida)
- Gate de reserva de stock síncrono: `POST /orders` reserva contra `inventory` antes de crear la orden, con `409`/`503` y compensación por TTL (ver [Flujo de reserva de inventory](#flujo-de-reserva-de-inventory))
- Búsqueda full-text sobre órdenes (PostgreSQL `tsvector` + índice GIN)
- Log de auditoría inmutable en MongoDB — cubre tanto el ciclo de vida de la orden como el de su reserva de stock (reservado/confirmado/liberado), poblado automáticamente vía eventos TCP
- Autenticación por API key (HTTP y TCP) y rate limiting en el servicio de órdenes
- Documentación interactiva de la API con Swagger/OpenAPI
- Suite de tests unitarios y e2e con Jest

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 24 |
| Framework | NestJS 11 |
| ORM (orders, inventory) | TypeORM |
| ODM (audit) | Mongoose |
| DB orders | PostgreSQL 18 |
| DB inventory | PostgreSQL 18 (base propia, separada de orders) |
| DB audit | MongoDB 8 |
| Comunicación inter-servicios | NestJS TCP transport |
| Contenedores | Docker + docker-compose |
| Lenguaje | TypeScript strict |

> `synchronize: true` de TypeORM está habilitado en `orders` e `inventory` solo para desarrollo. En producción se usarían migraciones explícitas.

---

## Arquitectura

```
POST /orders
  │
  ▼
┌────────────────────────────┐   TCP :4002, síncrono    ┌──────────────────────────────┐
│   orders  (HTTP :3000)     │ ── inventory.reserve ──▶ │   inventory  (HTTP :3002)    │
│   NestJS + PostgreSQL      │ ◀─ ok / 409 / 503 ──────  │   NestJS + PostgreSQL propio │
└────────────────────────────┘                           └──────────────────────────────┘
  │                                                          │
  │ outbox transaccional (async, vía poller)                 │ fire-and-forget (async)
  ├─ order.status_changed ────────────────────┐              │ inventory.reserved /
  │  TCP :4001                                │              │ .committed / .released
  └─ inventory.commit_requested /             │              │ TCP :4001
     inventory.release_requested              ▼              ▼
     TCP :4002 ──▶ inventory            ┌──────────────────────────────┐
                                         │   audit  (HTTP :3001)        │
                                         │   NestJS + MongoDB           │
                                         └──────────────────────────────┘
```

- **orders** gestiona el ciclo de vida de las órdenes. Antes de crear una orden, reserva stock síncronamente contra `inventory`. Tras cada cambio de estado, escribe en su outbox transaccional los eventos que correspondan (`order.status_changed` siempre; `inventory.commit_requested`/`inventory.release_requested` en `CONFIRMED`/`CANCELLED`), que un poller entrega de forma asíncrona.
- **inventory** posee las cantidades de stock por `productId` (sin catálogo de productos) y las reservas asociadas a cada orden. Además de responder a `orders`, emite hacia `audit` (fire-and-forget, best-effort — nunca bloquea la operación real) un evento por cada cambio real de estado de una reserva: `inventory.reserved`, `inventory.committed`, `inventory.released`. Ver [Flujo de reserva de inventory](#flujo-de-reserva-de-inventory) para el detalle completo.
- **audit** escucha los eventos `order.status_changed` (desde `orders`) e `inventory.reserved`/`committed`/`released` (desde `inventory`), y persiste un log inmutable en MongoDB. Expone `GET /audit/:orderId` (protegido por `x-api-key`) para consultar el historial completo de una orden — cambios de estado y movimientos de inventario, mezclados y ordenados por fecha.

Todo mensaje TCP entre servicios lleva la API key como campo `apiKey` dentro del propio payload (no hay headers HTTP en RPC) — ver [Autenticación](#autenticación).

---

## Requisitos previos

- [Docker](https://www.docker.com/) y Docker Compose
- (Opcional para desarrollo local) Node.js 24 + npm

---

## Levantar el proyecto

### 1. Clonar el repositorio

```bash
git clone <repo-url>
cd orders-audit-system
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

El `.env.example` incluye valores por defecto listos para desarrollo local. No es necesario modificarlos para correr con Docker.

### 3. Levantar con Docker

```bash
docker-compose up --build
```

Los servicios arrancan en este orden:
1. PostgreSQL (orders), PostgreSQL (inventory) y MongoDB (con healthcheck)
2. `audit` (espera a que Mongo esté healthy) e `inventory` (espera a que su Postgres esté healthy), en paralelo
3. `orders` (espera a que su Postgres, `audit` e `inventory` estén healthy)

Una vez levantado:
- **orders** → `http://localhost:3000`
- **inventory** → `http://localhost:3002`
- **audit** → `http://localhost:3001`

Los puertos TCP (`4001` audit, `4002` inventory) no se publican al host — solo son alcanzables entre containers dentro de la red de docker-compose, que es como los servicios realmente se comunican entre sí.

### Solo las bases de datos (útil en desarrollo local)

```bash
docker-compose up postgres postgres-inventory mongo
```

```bash
# En terminales separadas
npm run start:dev orders
npm run start:dev inventory
npm run start:dev audit
```

---

## Endpoints

### orders — `http://localhost:3000`

#### Crear una orden
```
POST /orders
Content-Type: application/json

{
  "userId": "user-123",
  "items": [
    { "productId": "prod-1", "productName": "Widget A", "quantity": 2, "price": 15.50 },
    { "productId": "prod-2", "productName": "Widget B", "quantity": 1, "price": 9.00 }
  ],
  "notes": "Deliver in the morning"
}
```

#### Listar órdenes (con filtros y paginación)
```
GET /orders
GET /orders?status=PENDING
GET /orders?userId=user-123
GET /orders?status=CONFIRMED&userId=user-123&page=1&limit=10
```

#### Consultar una orden por id
```
GET /orders/:id
```

#### Cambiar estado de una orden
```
PUT /orders/:id/status
Content-Type: application/json

{ "status": "CONFIRMED" }
```

#### Healthcheck
```
GET /health
```
Chequea la conexión a PostgreSQL (`TypeOrmHealthIndicator`) y reporta la causa cuando el servicio no está saludable. Público, sin `x-api-key`.

### audit — `http://localhost:3001`

#### Historial de una orden (cambios de estado + movimientos de inventory)
```bash
curl -H "x-api-key: tu-api-key" http://localhost:3001/audit/<orderId>
```

#### Healthcheck
```
GET /health
```
Chequea la conexión a MongoDB (`MongooseHealthIndicator`) y reporta la causa cuando el servicio no está saludable.

### inventory — `http://localhost:3002`

Fixture/demo seam para fijar y consultar stock — no es una API de reabastecimiento. Requiere `x-api-key` (mismo guard que `orders`). Ver [Flujo de reserva de inventory](#flujo-de-reserva-de-inventory) para el flujo completo de reserva.

```bash
# Fijar (upsert idempotente) la cantidad total en stock de un producto
curl -X PUT http://localhost:3002/stock/prod-1 \
  -H "x-api-key: tu-api-key" \
  -H "Content-Type: application/json" \
  -d '{"quantity": 100}'

# Consultar el stock actual de un producto
curl -H "x-api-key: tu-api-key" http://localhost:3002/stock/prod-1
```

#### Healthcheck
```
GET /health
```
Chequea la conexión a PostgreSQL (`TypeOrmHealthIndicator`), sin `x-api-key`.

---

## Documentación de la API (Swagger)

Cada servicio expone su propio Swagger UI, generado automáticamente a partir de los DTOs y decoradores de los controllers:

- **orders** → `http://localhost:3000/api`
- **audit** → `http://localhost:3001/api`
- **inventory** → `http://localhost:3002/api`

Los tres declaran el esquema de seguridad `x-api-key` — podés autenticarte desde el botón "Authorize" de cada Swagger UI para probar los endpoints protegidos directamente.

---

## Estados y transiciones válidas

```
PENDING → CONFIRMED | CANCELLED
CONFIRMED → SHIPPED | CANCELLED
SHIPPED → DELIVERED
DELIVERED → (estado terminal)
CANCELLED → (estado terminal)
```

Cualquier transición fuera de este mapa retorna `400 Bad Request`.

---

## Validaciones

- `items` debe tener al menos 1 elemento
- `quantity` de cada item debe ser ≥ 1
- `price` de cada item debe ser ≥ 0
- `totalAmount` se calcula automáticamente como la suma de `quantity × price` por item
- El campo `status` en `PUT /orders/:id/status` debe ser un valor válido del enum `OrderStatus`

---

## Full-Text Search

El endpoint `GET /orders/search` permite buscar órdenes por texto libre sobre el campo `notes` y el `productName` de cada item.

### Cómo funciona

Cada vez que se crea o actualiza una orden, se recalcula automáticamente una columna `tsvector` (`searchVector`) que contiene el texto de `notes` y los `productName` de los items procesado por PostgreSQL:

```sql
to_tsvector('english',
  coalesce(notes, '') || ' ' ||
  coalesce((
    SELECT string_agg(item->>'productName', ' ')
    FROM jsonb_array_elements(items) AS item
  ), '')
)
```

Al buscar, PostgreSQL convierte el texto de búsqueda en una `tsquery` y la compara contra ese vector usando el operador `@@`. Los resultados se ordenan por relevancia con `ts_rank`.

El campo `searchVector` tiene un índice GIN que hace esta comparación eficiente incluso con grandes volúmenes de datos.

### Supuesto de diseño

Se usa el idioma `'english'` tanto al indexar (`to_tsvector`) como al buscar (`plainto_tsquery`). Ambos deben coincidir para que el stemming funcione correctamente — si se indexa con un idioma y se busca con otro, no hay resultados. En un sistema multilenguaje este valor debería ser configurable.

### `plainto_tsquery` vs `to_tsquery`

Se usa `plainto_tsquery` en lugar de `to_tsquery` porque acepta texto libre sin sintaxis especial. El usuario puede escribir `"blue widget"` y PostgreSQL lo interpreta internamente como `blue & widget`, sin que el usuario tenga que conocer los operadores de tsquery.

### Uso

```bash
# Búsqueda básica
curl "http://localhost:3000/orders/search?q=widget"

# Con paginación
curl "http://localhost:3000/orders/search?q=blue+widget&page=1&limit=5"
```

Respuesta:
```json
{
  "data": [...],
  "total": 12,
  "page": 1,
  "limit": 5
}
```

Errores:
- `400 Bad Request` — si `q` está vacío o tiene menos de 2 caracteres
- `429 Too Many Requests` — si se supera el rate limit global

---

## Autenticación

Todos los endpoints HTTP de **orders**, **inventory** (rutas de fixture) y **audit** requieren el header `x-api-key`. Sin él, o con un valor incorrecto, la petición es rechazada antes de llegar al controller.

Los mensajes TCP entre servicios (`inventory.reserve`, `inventory.commit`, `inventory.release`, `order.status_changed`, `inventory.reserved`/`committed`/`released`) llevan la misma key como campo `apiKey` dentro del payload — no hay headers HTTP en un transporte RPC. `RpcApiKeyGuard` la valida ahí de la misma forma que `ApiKeyGuard` valida el header en HTTP, con la misma comparación en tiempo constante.

Es una única variable de entorno, `API_KEY`, compartida por los tres servicios (docker-compose la pasa a los tres desde el mismo `.env`).

### Cómo incluir el header

```bash
# Listar órdenes
curl -H "x-api-key: tu-api-key" http://localhost:3000/orders

# Crear una orden
curl -X POST http://localhost:3000/orders \
  -H "x-api-key: tu-api-key" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","items":[{"productId":"p1","productName":"Widget","quantity":2,"price":10}]}'

# Cambiar estado
curl -X PUT http://localhost:3000/orders/<id>/status \
  -H "x-api-key: tu-api-key" \
  -H "Content-Type: application/json" \
  -d '{"status":"CONFIRMED"}'
```

### Respuestas de error

| Situación | HTTP | Mensaje |
|-----------|------|---------|
| Header `x-api-key` ausente | `401 Unauthorized` | `Missing x-api-key header` |
| Header `x-api-key` con valor incorrecto | `401 Unauthorized` | `Invalid API key` |

### Configuración

```bash
# .env — misma clave para orders, inventory y audit
API_KEY=your-secret-api-key-here
```

---

## Rate Limiting

El servicio **orders** aplica rate limiting global en todos sus endpoints mediante `@nestjs/throttler`.

| Variable | Descripción | Default |
|----------|-------------|---------|
| `THROTTLE_TTL` | Ventana de tiempo en milisegundos | `60000` (60 s) |
| `THROTTLE_LIMIT` | Número máximo de requests permitidos en la ventana | `100` |

Con los valores por defecto, un cliente que supere las **100 requests en 60 segundos** recibirá:

```
HTTP 429 Too Many Requests
```

Para ajustar los límites sin rebuild, modifica las variables en `.env` y reinicia el servicio:

```bash
THROTTLE_TTL=60000
THROTTLE_LIMIT=50
```

---

## Flujo de reserva de inventory

`inventory` es un tercer microservicio NestJS con base de datos PostgreSQL propia (`postgres-inventory`, separada de `orders`), con dos tablas:

- **`stock_items`** — cantidad total por `productId` y cuánto de esa cantidad está `reserved`. La disponibilidad (`quantity - reserved`) nunca se almacena, siempre se deriva.
- **`reservations`** — una reserva por orden (`orderId` como PK, también su clave de idempotencia), con los items reservados, su estado (`held` / `committed` / `released`) y su vencimiento (`expiresAt`).

`inventory` **no** es un catálogo de productos ni una API de reabastecimiento: no hay nombres, precios, ni endpoints de recepción de mercadería. `PUT /stock/:productId` es un fixture de pruebas para fijar cantidades (usado por el seed de los tests e2e y para probar el flujo manualmente), no una operación de negocio.

### El flujo: gate síncrono, compensación asíncrona

```
POST /orders
  │
  ├─▶ inventory.reserve (TCP, síncrono, antes de crear la orden)
  │     ├─ stock insuficiente en algún item ──▶ 409 Conflict, sin crear la orden
  │     └─ inventory caído / timeout ──────────▶ 503 Service Unavailable, sin crear la orden
  │
  └─▶ orden creada (PENDING) — solo si la reserva fue exitosa

PUT /orders/:id/status { CONFIRMED }  ──▶ outbox: inventory.commit_requested
                                             └─▶ inventory: reserva pasa a committed, stock se decrementa

PUT /orders/:id/status { CANCELLED }  ──▶ outbox: inventory.release_requested
                                             └─▶ inventory: reserva pasa a released, se libera lo reservado

(orden nunca confirmada ni cancelada) ──▶ reaper (@Cron, cada minuto) libera la reserva
                                            al vencer su TTL (INVENTORY_RESERVATION_TTL_MINUTES, default 15)

(el cliente deja de esperar el reserve por timeout,     ──▶ release best-effort inmediato hacia inventory,
 pero inventory en realidad SÍ había reservado)              en vez de esperar el TTL completo
```

La reserva es **síncrona y bloqueante**: `POST /orders` no crea ninguna fila hasta que `inventory` confirma que hay stock para *todos* los items — todo o nada, nunca una reserva parcial. Una vez creada la orden, el commit/release en `CONFIRMED`/`CANCELLED` viaja por el mismo outbox transaccional que ya usa `order.status_changed` (ver [Entrega de eventos](#entrega-de-eventos-outbox)): la fila de outbox se escribe en la misma transacción que el cambio de estado, así que ambos son todo-o-nada.

`orders` no abre una transacción de Postgres que abarque la base de datos de `inventory` (fuera de alcance sin XA), así que la reserva ocurre *antes* y *fuera* de la transacción de `orders`. El costo aceptado es una ventana entre "reservado en `inventory`" y "orden confirmada en `orders`", acotada por el TTL de la reserva (15 minutos por defecto). Si una orden queda `PENDING` para siempre, el reaper libera la reserva sola al vencer el TTL — sin eso, un cliente que abandona el checkout dejaría stock reservado indefinidamente.

Toda mutación real de una reserva (`held → committed`/`released`, incluida la liberación por TTL) se emite hacia `audit` como evento `inventory.committed`/`inventory.released` — ver [Arquitectura](#arquitectura).

### Semántica HTTP

| Resultado de `inventory.reserve` | HTTP |
|---|---|
| Stock insuficiente en uno o más items (`INSUFFICIENT_STOCK`) o `productId` desconocido (`UNKNOWN_PRODUCT`) | `409 Conflict` — el body incluye `reason` y `shortfalls[]` |
| `inventory` no responde, el timeout se cumple (`INVENTORY_SEND_TIMEOUT_MS`, default 3000ms), o el circuit breaker está abierto | `503 Service Unavailable` — el sistema nunca degrada abierto: prefiere rechazar la orden antes que crearla sin garantía de stock. Mismo contrato de respuesta en los tres casos, sin distinción observable para el cliente |

Ver `test/e2e/inventory-reservation.e2e-spec.ts` para la prueba end-to-end de los cinco escenarios: stock insuficiente, `inventory` caído, commit en `CONFIRMED`, release en `CANCELLED` y auto-liberación por TTL.

### Circuit breaker en la llamada síncrona a inventory

La llamada TCP síncrona a `inventory.reserve` dentro de `reserveStock()` está protegida por un circuit breaker en memoria (`InventoryCircuitBreaker`), con tres estados (`closed` / `open` / `half-open`):

- **Closed (normal)**: cada llamada se intenta contra `inventory` como siempre. Solo cuentan como falla las fallas de **transporte** (timeout, conexión rechazada) — una respuesta resuelta con `ok: false` (stock insuficiente) sigue siendo un `409 Conflict` de negocio y nunca incrementa el contador del breaker.
- **Open (disparado)**: tras `INVENTORY_BREAKER_FAILURE_THRESHOLD` fallas de transporte consecutivas (default `5`), el breaker abre. Mientras está abierto, `reserveStock()` **no intenta ninguna llamada TCP** — falla rápido con el mismo `503 Service Unavailable` de siempre. Como no hubo intento de reserva, tampoco se dispara el release best-effort de reserva huérfana.
- **Half-open (prueba de recuperación)**: pasados `INVENTORY_BREAKER_RESET_TIMEOUT_MS` (default `15000`ms) desde que abrió, el breaker admite **una sola** solicitud de prueba; cualquier solicitud concurrente mientras esa prueba está en curso sigue fallando rápido. Si la prueba tiene éxito, el breaker cierra y el contador de fallas se reinicia a cero; si falla, vuelve a abrir de inmediato y el reset timeout arranca de nuevo desde ese momento.

Detalles operativos importantes:

- **Estado por réplica, no compartido**: cada instancia de `orders` mantiene su propio breaker en memoria — no hay store compartido (Redis u otro). Con `N` réplicas de `orders`, una caída de `inventory` puede disparar hasta `N` breakers independientes, cada uno con su propio conteo y su propio reloj de reset.
- **Solo logging, sin auditoría**: cada transición de estado (`closed→open`, `open→half-open`, `half-open→closed`, `half-open→open`) se loguea vía `pino` (nivel `warn` al abrir, `info` en las demás) y **no** se escribe hacia `audit` ni a ninguna colección de MongoDB — es un detalle operativo interno de `orders`, no un evento de negocio.
- **Rollback / caveat conocido**: `parseIntEnv` solo acepta valores enteros `> 0` — poner `INVENTORY_BREAKER_FAILURE_THRESHOLD=0` (o negativo) **no desactiva** el breaker, cae en el default de `5`. Para desactivarlo efectivamente en caso de rollback, usar un valor muy alto (p. ej. `1000000`) o revertir el cambio.

Ver `test/e2e/inventory-circuit-breaker.e2e-spec.ts` para la prueba end-to-end del disparo por fallas consecutivas, el fail-fast en estado abierto y la recuperación vía half-open.

---

## Entrega de eventos (outbox)

Cada cambio de estado de una orden escribe, en **una sola transacción** de Postgres, tanto la orden como una fila en `outbox_events` (`status='pending'`). Un poller (`@Interval`, cada `OUTBOX_POLL_INTERVAL_MS`) drena esa tabla y entrega cada fila por TCP con `send()` (exige un ack real de aplicación del destino, no solo que los bytes llegaron al socket), reintentando con backoff exponencial hasta `OUTBOX_MAX_ATTEMPTS` — después de lo cual el evento queda `failed` (consultable directamente en la tabla, sin alertas activas).

Esto da una garantía de entrega **al menos una vez**: `audit` e `inventory` pueden recibir el mismo evento más de una vez si el poller reintenta después de un timeout cuyo lado remoto sí procesó a tiempo.

### Deduplicación por `eventId`

Cada evento lleva un `eventId` único, generado dentro de la misma transacción que lo escribe (la PK de la fila de `outbox_events` para eventos de orders; un UUID sintetizado para los eventos fire-and-forget de `inventory`). El lado que recibe indexa por ese `eventId` con una restricción de unicidad (`AuditLog.eventId` en Mongo, `reservations.processedEventId` en Postgres) y trata un duplicado como no-op exitoso en vez de reprocesarlo — así el reintento del poller nunca aplica el mismo efecto dos veces, y tampoco queda reintentando para siempre un evento que el destino ya registró.

> ⚠️ **Migración manual si venís de una versión anterior a la introducción del índice único sobre `eventId`**: los documentos `AuditLog` preexistentes rompen el `autoIndex` de Mongoose al arrancar `audit`. Corré una vez antes de reiniciar `audit`: `docker compose exec mongo mongosh audit_db --eval "db.auditlogs.drop()"` (o `docker compose down -v` para reiniciar los volúmenes desde cero).

### Purga

`OutboxPurgeService` corre un job diario (`@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`) que borra las filas `sent` más viejas que `OUTBOX_PURGE_RETENTION_DAYS` (default 30). Las filas `pending` o `failed` nunca se tocan.

---

## Logging y trazabilidad

Los tres servicios loguean en JSON estructurado vía `nestjs-pino` en lugar del logger de texto plano por defecto.

`orders` genera o propaga un correlation ID por request HTTP: si llega el header `x-correlation-id`, se reutiliza; si no, se genera un UUID nuevo. Ese ID se devuelve en la respuesta (mismo header) y viaja como `metadata.correlationId` dentro de los eventos que van por outbox — primero en la fila de `outbox_events`, después en el mensaje TCP que consumen `audit`/`inventory`, que lo loguean al recibir el evento. Con eso, un `grep` por el correlation ID en los logs de los tres servicios reconstruye el ciclo de vida completo de una orden.

Los headers sensibles (`x-api-key`) se redactan en los logs de acceso HTTP.

---

## Variables de entorno

| Variable | Descripción | Default |
|----------|-------------|---------|
| `ORDERS_HTTP_PORT` | Puerto HTTP del servicio orders | `3000` |
| `ORDERS_DB_HOST` | Host de PostgreSQL | `postgres` |
| `ORDERS_DB_PORT` | Puerto de PostgreSQL | `5432` |
| `ORDERS_DB_USER` | Usuario de PostgreSQL | `orders_user` |
| `ORDERS_DB_PASSWORD` | Contraseña de PostgreSQL | `orders_pass` |
| `ORDERS_DB_NAME` | Nombre de la base de datos | `orders_db` |
| `AUDIT_HTTP_PORT` | Puerto HTTP del servicio audit | `3001` |
| `AUDIT_TCP_PORT` | Puerto TCP del servicio audit | `4001` |
| `AUDIT_MONGO_URI` | URI de conexión a MongoDB | `mongodb://mongo:27017/audit_db` |
| `AUDIT_TCP_HOST` | Host del servicio audit — usado por orders (outbox) e inventory (eventos fire-and-forget) para conectarse por TCP | `audit` |
| `THROTTLE_TTL` | Ventana de rate limiting en ms (orders) | `60000` |
| `THROTTLE_LIMIT` | Requests máximos por ventana (orders) | `100` |
| `API_KEY` | Clave compartida por orders, inventory y audit — header `x-api-key` en HTTP, campo `apiKey` en payloads TCP | — |
| `OUTBOX_POLL_INTERVAL_MS` | Intervalo del poller de `outbox_events` en ms (orders) | `2000` |
| `OUTBOX_BATCH_SIZE` | Máximo de eventos procesados por tick del poller | `20` |
| `OUTBOX_MAX_ATTEMPTS` | Intentos antes de marcar un evento como `failed` | `10` |
| `OUTBOX_SEND_TIMEOUT_MS` | Timeout del `send()` TCP hacia audit/inventory por intento, en ms | `5000` |
| `OUTBOX_BACKOFF_BASE_MS` | Backoff base entre reintentos, en ms (exponencial) | `1000` |
| `OUTBOX_BACKOFF_MAX_MS` | Techo del backoff exponencial, en ms | `60000` |
| `OUTBOX_PURGE_RETENTION_DAYS` | Días que se conserva una fila `sent` de `outbox_events` antes de purgarla | `30` |
| `INVENTORY_HTTP_PORT` | Puerto HTTP del servicio inventory | `3002` |
| `INVENTORY_TCP_PORT` | Puerto TCP del servicio inventory | `4002` |
| `INVENTORY_DB_HOST` | Host de PostgreSQL de inventory | `postgres-inventory` |
| `INVENTORY_DB_PORT` | Puerto de PostgreSQL de inventory | `5432` |
| `INVENTORY_DB_USER` | Usuario de PostgreSQL de inventory | `inventory_user` |
| `INVENTORY_DB_PASSWORD` | Contraseña de PostgreSQL de inventory | `inventory_pass` |
| `INVENTORY_DB_NAME` | Nombre de la base de datos de inventory | `inventory_db` |
| `INVENTORY_RESERVATION_TTL_MINUTES` | Minutos antes de que una reserva `held` sin confirmar/cancelar expire y se libere sola | `15` |
| `INVENTORY_REAP_BATCH_SIZE` | Máximo de reservas expiradas liberadas por tick del reaper | `100` |
| `INVENTORY_TCP_HOST` | Host del servicio inventory (para TCP, usado por orders) | `inventory` |
| `INVENTORY_SEND_TIMEOUT_MS` | Timeout del `send()` TCP síncrono de orders hacia inventory al crear una orden, en ms | `3000` |
| `INVENTORY_BREAKER_FAILURE_THRESHOLD` | Fallas de transporte consecutivas antes de que el circuit breaker de inventory abra (ver [Circuit breaker en la llamada síncrona a inventory](#circuit-breaker-en-la-llamada-síncrona-a-inventory)). Solo acepta enteros `> 0`; `0` o negativo cae en el default, **no** desactiva el breaker | `5` |
| `INVENTORY_BREAKER_RESET_TIMEOUT_MS` | Tiempo en ms que el circuit breaker de inventory permanece abierto antes de pasar a half-open y admitir una solicitud de prueba | `15000` |

---

## Tests

```bash
npm run test        # unit tests
npm run test:e2e    # e2e tests
npm run test:cov    # cobertura
```

---

## Tests e2e

Los tests e2e corren contra los servicios reales levantados con Docker — no hay mocks. Esto prueba el sistema completo incluyendo los endpoints HTTP, las bases de datos (PostgreSQL y MongoDB) y la comunicación TCP entre los tres servicios.

### Prerequisito

```bash
docker-compose up --build -d
# Esperar que todos los servicios estén healthy antes de continuar
```

### Comando

```bash
npm run test:e2e
```

### Casos cubiertos

| # | Caso |
|---|------|
| 1 | `POST /orders` — crea una orden y verifica status `PENDING` y `totalAmount` calculado correctamente |
| 2 | `GET /orders` — lista paginada y confirma que la orden creada aparece en los resultados |
| 3 | `GET /orders/search?q=Widget Pro` — búsqueda full-text encuentra la orden por `productName` |
| 4 | `PUT /orders/:id/status` — transición válida `PENDING → CONFIRMED` |
| 5 | `PUT /orders/:id/status` — transición inválida `CONFIRMED → PENDING` retorna `400` |
| 6 | `PUT /orders/:id/status` — transición válida `CONFIRMED → SHIPPED` |
| 7 | `GET /orders?status=SHIPPED` — filtro por status devuelve la orden correcta |
| 8 | `GET /audit/:orderId` — los 3 cambios de estado de la orden están registrados en orden `ASC` con `fromStatus` y `toStatus` correctos (filtrando por `eventType='order.status_changed'`, ya que el mismo endpoint también devuelve los eventos `inventory.reserved`/`committed` de esta orden) |
| 9 | `POST /orders` sin header `x-api-key` — retorna `401` |
| 10 | `POST /orders` con `x-api-key` incorrecto — retorna `401` |

> Los tests corren en serie (`--runInBand`) porque comparten estado: el `orderId` creado en el test 1 se reutiliza en todos los tests siguientes.

### Prueba de resiliencia del outbox (`outbox-resilience.e2e-spec.ts`)

Suite separada que corre después de `order-flow.e2e-spec.ts` (orden alfabético bajo `--runInBand`) para no interferir con el happy path. Demuestra el ciclo completo de outage y recuperación:

1. Detiene el contenedor `audit` con `docker compose stop audit` (no afecta a `orders`: `depends_on: condition: service_healthy` solo gobierna el orden de arranque, no el runtime).
2. Cambia el estado de una orden — el `PUT` responde `200` en menos de 2s, probando que la escritura queda desacoplada de `audit`.
3. Verifica, con una conexión directa vía `pg`, que la fila correspondiente en `outbox_events` queda `pending`.
4. Confirma que `audit` realmente no responde.
5. Reinicia `audit` con `docker compose start audit` y espera (polling, no `setTimeout` fijo) a que el poller entregue el evento pendiente.
6. Verifica que existe exactamente un log de `order.status_changed` para esa transición, con `eventId` igual al id de la fila de `outbox_events` (entrega + deduplicación en una sola aserción).

Si el CLI de `docker compose` no está disponible en el entorno donde corre `npm run test:e2e`, la suite se salta automáticamente (`describe.skip`) en vez de fallar.

### Prueba del gate de reserva de inventory (`inventory-reservation.e2e-spec.ts`)

Corre primero alfabéticamente (`inventory-reservation` < `order-flow` < `outbox-resilience`), así que su escenario de caída de `inventory` siempre se restaura antes de que las siguientes suites, que también dependen de `inventory` para su propio seed de stock, se ejecuten. Cubre los cinco escenarios del [gate de reserva síncrono](#flujo-de-reserva-de-inventory):

| # | Caso |
|---|------|
| 1 | Stock insuficiente → `409 Conflict`, cero filas de orden creadas (verificado con una consulta directa a `orders` por `userId`) |
| 2 | `inventory` caído (`docker compose stop inventory`) → `503 Service Unavailable`, cero filas de orden creadas |
| 3 | `CONFIRMED` → la reserva pasa a `committed` y el stock se decrementa realmente (`quantity` baja, `reserved` vuelve a 0) |
| 4 | `CANCELLED` → la reserva pasa a `released` (`reserved` vuelve a 0, `quantity` no cambia) |
| 5 | Reserva nunca confirmada ni cancelada → el reaper la auto-libera al vencer su TTL, y el stock liberado queda disponible para una orden nueva |

El escenario 5 fuerza el vencimiento de la reserva escribiendo directamente `expiresAt` en el pasado vía una conexión de `pg` a `postgres-inventory` (`forceExpireReservation` en `test/e2e/helpers/inventory-db.ts`), en vez de dormir los 15 minutos reales del TTL por defecto — `INVENTORY_RESERVATION_TTL_MINUTES` se lee una sola vez al arrancar el contenedor `inventory`, así que no hay forma de sobreescribirlo por test sin reiniciarlo.
