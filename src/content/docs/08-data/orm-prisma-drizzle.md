---
title: "Prisma, Drizzle и пулинг соединений"
description: "Prisma: схема, генерация клиента, миграции и drift, N+1 и include/select, interactive transactions, ограничения ORM. Drizzle: SQL-like синтаксис и миграции. PgBouncer: режимы session и transaction, интеграция с Prisma, сиды."
---

ORM — компромисс. Ты отдаёшь контроль над SQL в обмен на типобезопасность, миграции и скорость разработки. Хороший инженер знает, что получает, и — что важнее — что теряет. Эта глава про два доминирующих ORM в экосистеме TypeScript: Prisma (схема-центричный, комфортный) и Drizzle (SQL-like, прозрачный). А также про то, что происходит под ними: пулинг соединений через PgBouncer, без которого твоё приложение умрёт под нагрузкой.

## Prisma: схема как источник истины

Prisma держит схему в `schema.prisma` и генерирует типизированный клиент. Изменение БД — всегда через миграцию, генерируемую из diff'а схемы.

```prisma
// schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  orders    Order[]
  createdAt DateTime @default(now()) @map("created_at")

  @@map("users")
}

model Order {
  id        String   @id @default(uuid())
  user      User     @relation(fields: [userId], references: [id])
  userId    String   @map("user_id")
  total     Decimal  @db.Decimal(12, 2)
  status    OrderStatus @default(NEW)
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId, createdAt])  // составной индекс
  @@map("orders")
}

enum Role {
  USER
  ADMIN
  SUPPORT
}

enum OrderStatus {
  NEW
  PAID
  SHIPPED
  CANCELLED
}
```

Команды:

```bash
npx prisma migrate dev --name add_user_role  # создать и применить миграцию
npx prisma generate                          # перегенерировать клиент
npx prisma db pull                           # интроспекция: схема из существующей БД
npx prisma studio                            # GUI для данных
```

### Миграции и drift

`migrate dev` генерирует SQL из diff'а `schema.prisma` и применяет его. Но что если схему поменяли руками в БД? Это **drift** — расхождение между схемой в коде и реальной БД.

```bash
npx prisma migrate diff \
  --from-url $DATABASE_URL \
  --to-schema-datamodel schema.prisma \
  --script
# покажет разницу, если БД уехала от схемы
```

На CI проверяй drift: `prisma migrate deploy` падает, если есть необработанные миграции или drift. Никогда не правь БД руками в проде — только новой миграцией из git.

### N+1 и include/select

Классическая проблема ORM: загрузил 100 пользователей, потом в цикле запросил заказы каждого — 101 запрос.

```ts
// ПЛОХО: N+1
const users = await prisma.user.findMany();
for (const user of users) {
  user.orders = await prisma.order.findMany({ where: { userId: user.id } });
  // 1 + 100 запросов
}

// ХОРОШО: один запрос с JOIN
const users = await prisma.user.findMany({
  include: { orders: true },  // или select для точечного выбора
});
// 1 запрос с LEFT JOIN
```

`select` позволяет выбрать только нужные поля и урезать нагрузку:

```ts
const users = await prisma.user.findMany({
  select: {
    id: true,
    email: true,
    orders: {
      select: { id: true, total: true },
      where: { status: 'PAID' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    },
  },
});
```

### Interactive transactions

Когда нужна бизнес-логика внутри транзакции с доступом к результатам промежуточных запросов:

```ts
await prisma.$transaction(async (tx) => {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'NEW') throw new Error('Invalid order state');

  await tx.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
  await tx.payment.create({ data: { orderId, amount: order.total } });
  // throw — откатит всё
}, { isolationLevel: 'Serializable', timeout: 5000 });
```

Без callback-формы — batch-операции, но без интерактивности и с фиксированным порядком.

### Ограничения Prisma

Prisma удобна, но закрывает не всё. Для чего-то придётся писать raw SQL или расширять через `$queryRaw`:

1. **Нет partial index нативно.** `@@index` не поддерживает `WHERE`. Обход: миграция с `CREATE INDEX CONCURRENTLY` вручную + `--create-only` для `migrate dev`.
2. **Нет GIN для jsonb.** Для `attributes @> '{"color":"red"}'` — только raw query.
3. **Нет `SELECT ... FOR UPDATE SKIP LOCKED`.** Очереди на Prisma — только через raw SQL.
4. **N+1 в сложных include.** Вложенные `include` могут генерировать неожиданные JOIN-деревья. Проверяй через `prisma query` logging.
5. **Decimal → string.** `Decimal` в Prisma-клиенте — строка, не number. Не забудь конвертацию для расчётов.

```ts
// Расширение клиента для raw-операций
const orders = await prisma.$queryRaw<Order[]>`
  SELECT * FROM orders WHERE user_id = ${userId} AND status = 'PAID'
  ORDER BY created_at DESC LIMIT 10
`;
```

## Drizzle: SQL, который ты уже знаешь

Drizzle — тонкий слой поверх `pg`, синтаксис близок к SQL. Нет codegen, нет Prisma-Engine — чистый SQL с типами.

```ts
// schema.ts
import { pgTable, uuid, text, numeric, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  status: text('status').notNull().default('NEW'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

Запросы — как SQL:

```ts
import { eq, and, desc, sql } from 'drizzle-orm';

const paidOrders = await db
  .select()
  .from(orders)
  .where(and(eq(orders.userId, userId), eq(orders.status, 'PAID')))
  .orderBy(desc(orders.createdAt))
  .limit(10);

// Транзакция
await db.transaction(async (tx) => {
  await tx.update(orders).set({ status: 'PAID' }).where(eq(orders.id, orderId));
  await tx.insert(payments).values({ orderId, amount });
});

// Raw, когда нужно
await db.execute(sql`SELECT * FROM orders WHERE attributes @> '{"color":"red"}'`);
```

Миграции через `drizzle-kit`:

```bash
npx drizzle-kit generate:pg  # сгенерировать SQL из schema.ts
npx drizzle-kit push:pg      # применить без файлов миграций (для прототипов)
```

### Сравнение

| Критерий | Prisma | Drizzle |
|----------|--------|---------|
| Подход | Schema-first, codegen | SQL-first, тонкий слой |
| Типы | Генерируются из схемы | Инференс из schema.ts |
| Learning curve | Свой DSL | Похож на SQL |
| Миграции | `migrate dev`, строгие | `drizzle-kit`, гибкие |
| Raw SQL | `$queryRaw`, но отдельно | `sql` template встроен |
| Размер | Тяжёлый (engine) | Лёгкий |
| Ecosystem | Зрелая, большая | Растущая |

Для pet-проекта и быстрого старта — Prisma. Для контроля и production-гибкости — Drizzle. Оба валидны, оба требуют понимания SQL под капотом.

## Пулинг соединений: max_connections ловушка

PostgreSQL дорого держит соединение: каждое — отдельный процесс (~10 MB RAM). `max_connections` по умолчанию — 100. Если 50 подов Kubernetes держат по 5 коннектов — 250 процессов, и БД падает по памяти или отказывает в соединении.

Решение — **PgBouncer**: лёгкий прокси перед PostgreSQL. Клиенты коннектятся к нему в большом количестве, а он держит маленький пул реальных серверных соединений.

```
App Pods (200 connections)
    ↓
PgBouncer (port 6432)
    ↓ pool_size = 20
PostgreSQL (port 5432, max_connections = 100)
```

### Режимы PgBouncer

- **Session** (по умолчанию): серверное соединение закреплено за клиентом на всю сессию. Нужно для prepared statements, advisory locks, временных таблиц. Но пул не эффективен: клиент думает — коннект простаивает.
- **Transaction** (рекомендуется): серверное соединение выдаётся на одну транзакцию и возвращается в пул. 200 клиентов → 20 реальных коннектов. Ограничение: нельзя использовать сессионное состояние вне транзакций (`SET`, `LISTEN/NOTIFY`, advisory locks).

```ini
# pgbouncer.ini
[databases]
mydb = host=postgres port=5432 dbname=mydb

[pgbouncer]
listen_port = 6432
auth_type = scram-sha-256
pool_mode = transaction
default_pool_size = 20
max_client_conn = 1000
```

```bash
# Запуск
docker run -d -p 6432:6432 -v $PWD/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini pgbouncer/pgbouncer

# Проверка пула
psql -h localhost -p 6432 -U postgres pgbouncer -c "SHOW POOLS;"
```

### PgBouncer + Prisma

Prisma по умолчанию использует prepared statements, которые ломаются в transaction-режиме. Решение — добавить `pgbouncer=true` в строку подключения:

```env
# .env
DATABASE_URL="postgresql://user:pass@localhost:6432/mydb?pgbouncer=true&connection_limit=10"
```

`pgbouncer=true` отключает prepared statements и включает совместимость с transaction pooling. `connection_limit` в приложении должен быть **меньше** `default_pool_size` в PgBouncer, иначе приложение займёт все серверные коннекты и станет в очередь.

```ts
// Для Drizzle — тот же принцип
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,  // меньше pool_size PgBouncer
});
const db = drizzle(pool);
```

:::caution[Пул в приложении всё равно нужен]
PgBouncer не отменяет пул в коде. Он защищает PostgreSQL, но клиенты всё равно должны переиспользовать коннекты, иначе latency на установку TCP-соединения съест выигрыш.
:::

## Сиды: наполнение данными для разработки

Для локальной разработки и тестов нужны данные. Не руками, а кодом:

```ts
// seed.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Admin',
      role: 'ADMIN',
      orders: {
        create: Array.from({ length: 10 }, (_, i) => ({
          total: (i + 1) * 100.5,
          status: i % 3 === 0 ? 'PAID' : 'NEW',
        })),
      },
    },
  });
  console.log({ user });
}

main().finally(() => prisma.$disconnect());
```

```bash
# package.json
"prisma": {
  "seed": "tsx seed.ts"
}
npx prisma db seed
```

Идемпотентность через `upsert` — сиды можно гонять сколько угодно раз. Для тестов — faker-js для генерации реалистичных данных, для интеграционных тестов — отдельная БД с миграциями + сиды в `beforeAll`.

## Типичные ошибки и грабли

1. **Игнорирование N+1.** `include` забыт — в цикле запросы. Включи `log: ['query']` в Prisma, найди паттерн `findMany` в цикле.
2. **Drift после ручного фикса в проде.** Поменял колонку через psql, забыл миграцию. `migrate deploy` падает, CI красный. Только миграции из git.
3. **`connection_limit` больше pool_size PgBouncer.** Приложение заняло все серверные коннекты, PgBouncer качает клиентов в очередь. `connection_limit` всегда меньше.
4. **Prepared statements с transaction pooling.** Prisma без `pgbouncer=true` в transaction-режиме — ошибки `prepared statement already exists`. Добавь параметр или перейди на session.
5. **Денежные расчёты с Prisma Decimal.** `Decimal` — строка. `order.total * 1.2` — конкатенация. Конвертируй через `Number()` или библиотеку `decimal.js`.
6. **Сиды без идемпотентности.** `create` вместо `upsert` — второй запуск падает на unique constraint. Сиды должны быть replayable.

## Вопросы на собеседовании

1. **Что такое drift и как его детектить?** Расхождение схемы в коде и реальной БД. `prisma migrate diff`, `prisma migrate deploy` на CI, запрет ручных правок в проде.
2. **Как решается N+1 в Prisma?** `include`/`select` для eager loading, `findMany` с `where` вместо цикла, DataLoader для сложных графов.
3. **Разница Prisma и Drizzle?** Prisma — schema-first с codegen и engine, удобен, но тяжеловесен. Drizzle — SQL-like, тонкий, прозрачный, без codegen. Выбор — проектные предпочтения.
4. **Зачем PgBouncer и в чём разница режимов?** Пулинг коннектов: много клиентов → мало серверных процессов. Session — коннект на сессию, transaction — на транзакцию (нельзя сессионное состояние).
5. **Как Prisma работает с PgBouncer?** Параметр `pgbouncer=true` в строке подключения отключает prepared statements для совместимости с transaction pooling.
6. **Что нельзя сделать в Prisma без raw SQL?** Partial index, GIN для jsonb, `FOR UPDATE SKIP LOCKED`, некоторые типы (ltree, geometric). `$queryRaw` — запасной выход.

## Практика

1. Спроектируй схему pet-проекта в Prisma: users, products, orders с enum-статусами и составным индексом. Прогони `migrate dev`, изучи сгенерированный SQL.
2. Найди N+1: загрузи 50 пользователей с заказами в цикле, замерь количество запросов через `log: ['query']`. Исправь через `include`, сравни.
3. Подними PgBouncer в Docker в режиме `transaction`. Подключи Prisma с `pgbouncer=true`. Проверь `SHOW POOLS;` — серверных коннектов должно быть меньше клиентских.
4. Реализуй seed с `upsert` для 100 пользователей и 1000 заказов через faker-js. Убедись, что повторный запуск не падает.
5. Напиши raw query в Prisma для `SELECT ... FOR UPDATE SKIP LOCKED` очереди. Объясни, почему ORM этого не умеет.

## Что почитать

- [Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate)
- [Prisma Client API](https://www.prisma.io/docs/orm/reference/prisma-client-reference)
- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview)
- [PgBouncer Features](https://www.pgbouncer.org/features.html)
- [faker-js](https://fakerjs.dev/)
