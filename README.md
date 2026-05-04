# Orders Audit System

Mini sistema de gestión de órdenes compuesto por dos microservicios NestJS que se comunican entre sí vía TCP. Construido como prueba técnica para el proceso de selección Senior Backend Engineer.

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js 20 |
| Framework | NestJS 10 |
| ORM (orders) | TypeORM |
| ODM (audit) | Mongoose |
| DB orders | PostgreSQL 16 |
| DB audit | MongoDB 7 |
| Comunicación inter-servicios | NestJS TCP transport |
| Contenedores | Docker + docker-compose |
| Lenguaje | TypeScript strict |

---

## Arquitectura

```
┌─────────────────────────────┐        TCP :4001               ┌──────────────────────────────┐
│   orders  (HTTP :3000)      │ ──── order.status_changed ───▶ │   audit  (HTTP :3001)        │
│   NestJS + PostgreSQL       │                                │   NestJS + MongoDB           │
└─────────────────────────────┘                                └──────────────────────────────┘
```

- **orders** gestiona el ciclo de vida de las órdenes. Tras cada cambio de estado emite un evento TCP al servicio audit.
- **audit** escucha esos eventos y persiste un log inmutable en MongoDB. Expone un endpoint HTTP para consultar el historial de una orden.

---

## Requisitos previos

- [Docker](https://www.docker.com/) y Docker Compose
- (Opcional para desarrollo local) Node.js 20 + npm

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
1. PostgreSQL y MongoDB (con healthcheck)
2. `audit` (espera a que Mongo esté healthy)
3. `orders` (espera a que Postgres y `audit` estén healthy)

Una vez levantado:
- **orders** → `http://localhost:3000`
- **audit** → `http://localhost:3001`

### Solo las bases de datos (útil en desarrollo local)

```bash
docker-compose up postgres mongo
```

```bash
# En terminales separadas
npm run start:dev orders
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
    { "productId": "prod-1", "quantity": 2, "price": 15.50 },
    { "productId": "prod-2", "quantity": 1, "price": 9.00 }
  ]
}
```

#### Listar órdenes (con filtros y paginación)
```
GET /orders
GET /orders?status=PENDING
GET /orders?userId=user-123
GET /orders?status=CONFIRMED&userId=user-123&page=1&limit=10
```

#### Cambiar estado de una orden
```
PUT /orders/:id/status
Content-Type: application/json

{ "status": "CONFIRMED" }
```

### audit — `http://localhost:3001`

#### Historial de cambios de una orden
```
GET /audit/:orderId
```

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
to_tsvector('english', coalesce(notes, '') || ' ' || coalesce(items::text, ''))
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
| `AUDIT_TCP_HOST` | Host del servicio audit (para TCP) | `audit` |
| `THROTTLE_TTL` | Ventana de rate limiting en ms (orders) | `60000` |
| `THROTTLE_LIMIT` | Requests máximos por ventana (orders) | `100` |

---

## Decisiones de diseño

### 1. TCP sobre EventEmitter
Los servicios corren en contenedores separados. `EventEmitter` de NestJS es in-process y no funcionaría entre contenedores. Se usa el transport TCP nativo de `@nestjs/microservices`.

### 2. Validación de quantity en lugar de un campo stock
El enunciado menciona "validar stock mínimo". Se optó por no agregar un campo `stock` a la entidad `Order` porque no tiene sentido semántico en el contexto de una orden: una orden no tiene stock propio, sino items con cantidades. La validación equivalente y semánticamente correcta es `quantity ≥ 1` por cada item, implementada en el DTO con `@Min(1)`.

### 3. Repository pattern
El servicio no accede directamente a TypeORM — delega en una clase `OrdersRepository` propia. Esto desacopla la lógica de negocio del ORM y facilita el testing.

### 4. Monorepo NestJS
Permite compartir `libs/shared` (enums, interfaces, nombres de eventos) entre los dos servicios sin publicar un paquete npm, manteniendo una única fuente de verdad para el dominio.

### 5. `synchronize: true` en TypeORM
Habilitado solo para desarrollo. En producción se usarían migraciones explícitas.

### 6. `fromStatus: null` en el primer evento de auditoría
Cuando se crea una orden (estado inicial `PENDING`), no existe estado previo. El campo `fromStatus` se persiste como `null` para representar ese origen.

---

## Tests

```bash
npm run test        # unit tests
npm run test:e2e    # e2e tests
npm run test:cov    # cobertura
```
