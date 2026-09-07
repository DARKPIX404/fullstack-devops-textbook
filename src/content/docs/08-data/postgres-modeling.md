---
title: "Моделирование данных в PostgreSQL"
description: "Типы данных и их компромиссы, нормализация 1НФ–3НФ на полных примерах, денормализация, суррогатные ключи, ограничения CHECK и UNIQUE, ER-проектирование pet-проекта и миграции схемы."
---

Каждое приложение начинается с радостного `CREATE TABLE users (...)` — и каждое приложение заканчивает свой путь к продакшену с той же таблицей, но уже с тремя миграциями, двумя индексами и болью от решений, принятых в первый день. Проектирование схемы — это не «накидать колонок», а принять архитектурные решения: какие типы данных выбрать, как нормализовать, где сознательно нарушить правила и как эволюционировать схему без даунтайма.

В краткой версии ты видел нормализацию по формам на пальцах. Здесь — полный цикл: от выбора типов с разбором компромиссов, через нормализацию с реальными схемами pet-проекта, до миграций, которые ты будешь гонять на CI.

## Типы данных: решения, которые дорого откатывать

Выбор типа — контракт. Поменять `int` на `bigint` на таблице с миллиардом строк — это часы даунтайма и переписывание кода.

### numeric против float

Главное правило денег: **никогда `float`**. `numeric(12,2)` — точное десятичное, `float8` — двоичная апроксимация. Компромиссы обоих типов разобраны в [главе документации про числовые типы](https://www.postgresql.org/docs/current/datatype-numeric.html).

```sql
SELECT 0.1::float8 + 0.2::float8 = 0.3::float8;  -- false!
SELECT 0.10::numeric + 0.20::numeric = 0.30::numeric;  -- true
```

В двоичной системе 0.1 — бесконечная дробь, и сумма «складных» чисел даёт 0.30000000000000004. В заказе на 1 000 000 позиций такие ошибки накапливаются, и бухгалтерия находит расхождение в копейках. `numeric` считается медленнее, но для финансовых операций разница в микросекундах несущественна — а расхождение в балансе существенно.

```sql
CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total      numeric(12,2) NOT NULL CHECK (total >= 0),
  currency   char(3) NOT NULL DEFAULT 'RUB' CHECK (currency ~ '^[A-Z]{3}$')
);
```

:::caution[Цена numeric]
`numeric` без параметра — variable-length число с точностью до 16383 знаков после запятой. Всегда указывай точность: `numeric(12,2)` — 10 знаков до запятой, 2 после. Это и документация, и защита от кривых данных.
:::

### timestamptz против timestamp

Две ошибки новичка: использовать `timestamp` (без tz) и хранить время в локальной зоне сервера.

```sql
SELECT now();                    -- 2024-05-14 18:32:11.123456+03
SELECT '2024-05-14 18:00'::timestamptz;  -- та же точка на оси времени
SELECT '2024-05-14 18:00'::timestamp;    -- просто строка, зона неизвестна
```

`timestamp` без tz не хранит часовой пояс — это «18:00, и не знаем где». Когда сервер переедет из Москвы в Амстердам, все записи «поплывут». `timestamptz` хранит UTC и конвертирует в зону сессии для отображения. Всегда `timestamptz`, если у тебя не календарь настенный. Вводная по типам даты и времени — в [документации PostgreSQL](https://www.postgresql.org/docs/current/datatype-datetime.html).

### Текст и uuid

`varchar(n)` почти никогда не нужен — используй `text` с ограничением `CHECK (char_length(name) <= 255)`, если надо. `uuid` генерируй на стороне БД через `gen_random_uuid()` (расширение `pgcrypto` или встроенное в PG13+), а не в приложении — так проще гарантировать уникальность в распределённых системах.

## Нормализация: 1НФ–3НФ на живых примерах

### 1НФ — атомарность

В ячейке — одно значение. Массив строкой `"js,ts,node"` или JSON-строка — нарушение.

```sql
-- ПЛОХО: нарушение 1НФ
CREATE TABLE users_bad (
  id    serial PRIMARY KEY,
  name  text,
  tags  text  -- "js,ts,node" — неатомарно
);

-- ХОРОШО: отдельная таблица связей
CREATE TABLE users (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE user_tags (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag     text   NOT NULL,
  PRIMARY KEY (user_id, tag)
);
```

### 2НФ — зависимость от всего ключа

Каждый неключевой атрибут зависит от **всего** составного ключа, а не его части.

```sql
-- ПЛОХО: product_name зависит только от product_id, а не от (order_id, product_id)
CREATE TABLE order_items_bad (
  order_id     bigint NOT NULL,
  product_id   bigint NOT NULL,
  product_name text   NOT NULL,  -- избыточность!
  quantity     int    NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- ХОРОШО: наименование живёт в своей таблице
CREATE TABLE products (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  sku  text NOT NULL UNIQUE
);

CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  quantity   int    NOT NULL CHECK (quantity > 0),
  price      numeric(12,2) NOT NULL,  -- цена на момент покупки — факт заказа
  PRIMARY KEY (order_id, product_id)
);
```

`price` в `order_items` — не ошибка, а осознанная денормализация: цена товара меняется, а в заказе должна остаться историческая.

### 3НФ — неключевые не зависят от неключевых

```sql
-- ПЛОХО: city зависит от zip, а не от id пользователя
CREATE TABLE users_bad (
  id   serial PRIMARY KEY,
  name text,
  zip  text,
  city text  -- избыточно, выводится из zip
);

-- ХОРОШО: справочник
CREATE TABLE cities (
  zip  text PRIMARY KEY,
  city text NOT NULL
);

CREATE TABLE users (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   text NOT NULL,
  zip    text REFERENCES cities(zip)
);
```

На практике 3НФ — компромисс между чистотой и скоростью JOIN. Для справочников нормализуй; для hot-path запросов — денормализуй осознанно.

## Денормализация: когда оправдана

Денормализация — копия данных ради скорости чтения. Классика: счётчик комментариев в посте.

```sql
CREATE TABLE posts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title           text NOT NULL,
  comments_count  int NOT NULL DEFAULT 0  -- денормализовано
);

-- При добавлении комментария обновляем счётчик в той же транзакции
BEGIN;
INSERT INTO comments (post_id, body) VALUES ($1, $2);
UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1;
COMMIT;
```

Оправдана, когда: (1) запросы с JOIN занимают >50% CPU; (2) чтение в 100 раз чаще записи; (3) есть механизм восстановления (пересчёт из нормализованных данных). Неоправдана, когда «на всякий случай» — это техдолг без бизнес-цели.

## Суррогатные ключи и естественные

Суррогатный ключ — искусственный `id`, естественный — `email`, `isbn`, `inn`. Всегда суррогатный: естественные ключи меняются (пользователь меняет email), суррогатные — никогда. `GENERATED ALWAYS AS IDENTITY` — современный аналог `serial`, без дыр в sequence при откатах транзакций (sequence не откатывается, но IDENTITY-подход чище для логической репликации).

## Генерируемые колонки

PostgreSQL умеет хранить вычисляемые значения — **generated columns**. Два вида: `STORED` (вычисляется при записи, хранится на диске) и `VIRTUAL` (вычисляется при чтении, с PG18). Виртуальные не занимают место, но их нельзя индексировать напрямую. Синтаксис и ограничения — на странице [документации про generated columns](https://www.postgresql.org/docs/current/ddl-generated-columns.html).

```sql
CREATE TABLE order_items (
  order_id   bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  quantity   int    NOT NULL CHECK (quantity > 0),
  price      numeric(12,2) NOT NULL,
  total      numeric(14,2) GENERATED ALWAYS AS (quantity * price) STORED
);

-- total индексируется как обычная колонка
CREATE INDEX order_items_total_idx ON order_items (total) WHERE total > 10000;
```

Практический сценарий — «дорогие» выражения для поиска: `search_vector tsvector`, нормализованный телефон, хеш для дедупликации. Всё, что иначе пришлось бы считать в каждом запросе или денормализовать триггером.

:::tip[STORED нельзя обновить вручную]
`UPDATE order_items SET total = 999` упадёт с ошибкой: generated always. Это фича — защита от рассинхрона. Если бизнес-логика требует ручного переопределения — это не generated column, а обычная колонка с триггером.
:::

## Внешние ключи и ограничения

```sql
CREATE TABLE payments (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id  bigint NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount    numeric(12,2) NOT NULL CHECK (amount > 0),
  status    text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'completed', 'failed')),
  method    text NOT NULL CHECK (method IN ('card', 'sbp', 'crypto')),
  idempotency_key text NOT NULL UNIQUE  -- защита от двойного списания
);

CREATE INDEX payments_order_id_idx ON payments (order_id);  -- FK не создаёт индекс автоматически!
```

`CHECK` — бизнес-инвариант на уровне БД. `UNIQUE` — и целостность, и индекс. `ON DELETE CASCADE` для дочерних сущностей (комментарии поста), `RESTRICT` для финансовых связей (нельзя удалить заказ с платежами). Полный обзор ограничений — в [главе документации про constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

## ER-проектирование pet-проекта

Схема платформы заказов:

```
users 1───* addresses
users 1───* orders *───1 order_items *───1 products
users 1───* reviews *───1 products
orders 1───* payments
products *───1 categories (дерево через parent_id)
```

```sql
CREATE TABLE categories (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES categories(id),
  name      text NOT NULL,
  slug      text NOT NULL UNIQUE
);

CREATE TABLE products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES categories(id),
  name        text NOT NULL,
  description text,
  price       numeric(12,2) NOT NULL CHECK (price >= 0),
  stock       int NOT NULL DEFAULT 0 CHECK (stock >= 0),
  attributes  jsonb NOT NULL DEFAULT '{}'  -- гибкие характеристики
);

CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'paid', 'shipped', 'delivered', 'cancelled')),
  total      numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
```

`attributes jsonb` — сознательный компромисс: фильтрация по характеристикам через GIN-индекс, но без строгой схемы для разнородных товаров.

## Миграции схемы

Схема живёт в git. Изменение — только миграцией, прогнанной на CI.

```sql
-- migrations/20240515_add_user_role.sql
-- добавляем роль пользователям с безопасным дефолтом
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin', 'support'));

-- создаём индекс конкурентно, не блокируя таблицу
CREATE INDEX CONCURRENTLY users_role_idx ON users (role) WHERE role != 'user';
```

`CREATE INDEX CONCURRENTLY` не берёт блокировку `ACCESS EXCLUSIVE`, позволяя таблице работать. Откат — только новой миграцией, не `DROP TABLE` из консоли. Опции команды — на странице [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) в документации.

:::tip[Именование миграций]
`YYYYMMDDHHMM_description.sql` — порядок определяется timestamp, конфликтов при мерже двух веток меньше. Prisma и Drizzle генерируют так же.
:::

## Типичные ошибки и грабли

1. **`float` для денег.** «Почти 0.3» в бухгалтерии — расхождение в копейках на миллионах операций. Используй `numeric(p,s)`.
2. **`timestamp` без tz.** При переезде сервера в другую зону все времена «поплывут». `timestamptz` всегда.
3. **FK без индекса.** PostgreSQL не создаёт индекс автоматически. `JOIN` и `DELETE` родителя — полное сканирование дочерней таблицы.
4. **Денормализация без механизма восстановления.** Счётчик обновляется багом, расходится с реальностью, и никто не знает правду. Добавь пересчёт по cron или триггер.
5. **Миграции руками в проде.** «Быстро поправлю колонку через psql» — расход схемы и кода. Только миграции из git.

## Вопросы на собеседовании

1. **Почему numeric, а не float для денег?** `float` — двоичная апроксимация, 0.1+0.2 ≠ 0.3. `numeric` — точное десятичное. В финансах копейки копятся.
2. **Разница timestamp и timestamptz?** `timestamp` — без часового пояса, `timestamptz` — хранит UTC, конвертирует в зону сессии. Для серверов всегда `timestamptz`.
3. **Объясни 2НФ на примере.** Составной ключ (order_id, product_id), атрибут зависит от части ключа (product_name от product_id) — выносим в отдельную таблицу.
4. **Когда денормализация оправдана?** Чтение в 100 раз чаще записи, JOIN дорогой, есть механизм пересчёта. Осознанный компромисс, а не «на всякий случай».
5. **Почему FK не создаёт индекс?** PostgreSQL проверяет целостность через сканирование, но для производительности JOIN и каскадных операций нужен отдельный индекс.
6. **Что такое GENERATED ALWAYS AS IDENTITY?** Современный стандарт SQL для автоинкремента, в отличие от `serial` не создаёт sequence-объект отдельно, чище для репликации.

## Практика

1. Спроектируй схему pet-проекта (users, categories, products, orders, order_items, payments, reviews) в 3НФ. Определи все FK, CHECK, UNIQUE. Объясни каждое ограничение.
2. Добавь `numeric` поле с проверкой, попробуй вставить отрицательную цену — убедись, что CHECK срабатывает. Засеки ошибку.
3. Создай миграцию, добавляющую колонку `role` в `users` с `DEFAULT` и `CHECK`. Прогони её и откати новой миграцией.
4. Найди в своей схеме одно место для осознанной денормализации (например, `comments_count`). Реализуй обновление счётчика в транзакции с вставкой комментария.
5. Замени `timestamp` на `timestamptz` в одной таблице. Проверь, как меняется вывод `SELECT now()` в разных `SET TIME ZONE`.

## Что почитать

- [PostgreSQL Data Types](https://www.postgresql.org/docs/current/datatype.html)
- [Normalization (Wikipedia, примеры)](https://en.wikipedia.org/wiki/Database_normalization)
- [PostgreSQL Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [Identity Columns (SQL Standard)](https://www.postgresql.org/docs/current/sql-createtable.html)
