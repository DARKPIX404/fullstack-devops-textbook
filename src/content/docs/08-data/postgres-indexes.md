---
title: "Индексы в PostgreSQL: от B-Tree до bloat"
description: "Устройство B-Tree и его слепые зоны, составные индексы и leftmost prefix, покрывающие индексы INCLUDE, GIN для jsonb и полнотекста, частичные индексы, чтение плана EXPLAIN ANALYZE, VACUUM и bloat."
---

Индекс — это структура данных, которая превращает полное сканирование таблицы в точечный поиск. Но индекс — не магия: он работает только тогда, когда запрос укладывается в геометрию структуры. Понимание этого — разница между «добавил индекс, стало быстро» и «понимаю, почему `LIKE '%foo%'` индекс не использует, и что с этим делать».

В краткой версии ты видел обзор B-Tree, GIN, GiST и `EXPLAIN ANALYZE`. Здесь копаем глубже: как устроен B-Tree страница за страницей, почему составные индексы подчиняются leftmost prefix, как работают покрывающие и частичные индексы, и почему твоя таблица раздувается, даже когда ты ничего не делаешь.

## B-Tree под капотом

B-Tree в PostgreSQL — сбалансированное дерево. Корень и внутренние узлы — навигация, листья — данные.

```
            [ 50 ]
           /      \
      [ 20 35 ]   [ 70 90 ]
     /    |    \   /   |   \
  leaves: [1..20) [20..35) [35..50) [50..70) [70..90) [90..∞)
```

Каждая страница — 8 KB. Ключи внутри страницы отсортированы, поиск — бинарный. Для таблицы в миллиард строк глубина дерева — 4-5 уровней, значит любой поиск — 4-5 чтений с диска (или из кэша). Вот почему `WHERE id = 123` мгновенно, а `WHERE id != 123` — полное сканирование.

### Когда B-Tree не работает

B-Tree ищет **точное совпадение или диапазон с префикса**. Если запрос не даёт «якоря» — индекс бесполезен.

```sql
-- Использует индекс: якорь слева
SELECT * FROM users WHERE email = 'a@b.c';
SELECT * FROM users WHERE created_at > '2024-01-01';
SELECT * FROM users WHERE name LIKE 'Ann%';  -- префикс!

-- НЕ использует индекс: нет якоря
SELECT * FROM users WHERE email LIKE '%@b.c';  -- префикс справа
SELECT * FROM users WHERE upper(name) = 'ANN'; -- функция над колонкой
SELECT * FROM users WHERE created_at::date = '2024-05-14'; -- каст
```

Решение — **функциональный индекс**:

```sql
CREATE INDEX users_email_lower_idx ON users (lower(email));
SELECT * FROM users WHERE lower(email) = 'a@b.c';  -- теперь индекс работает
```

:::tip[Почему `!=` не использует индекс]
`WHERE status != 'active'` — это 99% строк. PostgreSQL понимает, что дешевле прочитать всю таблицу последовательно, чем ходить по индексу туда-сюда. Planner прав — но если у тебя 1% не-'active', нужен **частичный индекс**: `CREATE INDEX ON users (id) WHERE status != 'active'`.
:::

## Составные индексы и leftmost prefix

Индекс `(a, b, c)` — это сортированный список кортежей `(a, b, c)`. Поиск возможен только по префиксу: `a`, `(a, b)`, `(a, b, c)`. Поиск по `b` или `(b, c)` — как искать в телефонной книге по имени без фамилии.

```sql
CREATE INDEX orders_user_status_idx ON orders (user_id, status, created_at DESC);

-- Использует индекс:
WHERE user_id = 5
WHERE user_id = 5 AND status = 'paid'
WHERE user_id = 5 AND status = 'paid' AND created_at > '2024-01-01'
WHERE user_id = 5 ORDER BY status, created_at DESC  -- сортировка тоже из индекса!

-- НЕ использует (или использует частично):
WHERE status = 'paid'  -- пропускаем user_id
WHERE user_id = 5 OR user_id = 7  -- OR — два разных префикса, иногда BitmapOr
```

Порядок колонок: равенства первыми, диапазоны последними. `WHERE a = 5 AND b > 10 AND c = 'x'` — индекс `(a, c, b)` эффективнее `(a, b, c)`, потому что `b > 10` — диапазон, и после него `c` уже не используется для поиска.

## Покрывающие индексы INCLUDE

Если индекс содержит все колонки запроса, PostgreSQL не трогает таблицу — только индекс. Это **Index Only Scan**, самый быстрый тип доступа.

```sql
-- Запрос: SELECT id, status FROM orders WHERE user_id = 5;
-- Обычный индекс: находим строки в индексе, потом идём в таблицу за status.
CREATE INDEX orders_user_id_idx ON orders (user_id);

-- Покрывающий: status прямо в листьях, таблица не нужна
CREATE INDEX orders_user_covering_idx ON orders (user_id) INCLUDE (status, created_at);
```

`INCLUDE` — колонки в листьях, но не в дереве. Они не увеличивают глубину, но раздувают индекс. Используй для колонок, которые часто селектишь, но редко фильтруешь.

## GIN: jsonb, массивы, полнотекст

GIN — инвертированный индекс: для каждого элемента (ключа jsonb, слова, тега) — список строк, где он встречается. Поиск `jsonb @> '{"color": "red"}'` — мгновенно.

```sql
-- JSONB с GIN
CREATE INDEX products_attrs_idx ON products USING gin (attributes);
SELECT * FROM products WHERE attributes @> '{"color": "red", "size": "XL"}';

-- Полный текст
CREATE INDEX posts_fts_idx ON posts USING gin (
  to_tsvector('russian', title || ' ' || body)
);
SELECT * FROM posts
WHERE to_tsvector('russian', title || ' ' || body) @@ plainto_tsquery('russian', 'транзакции изоляция');
```

:::caution[GIN — дорогая запись]
Каждая вставка обновляет много элементов индекса. Для write-heavy таблиц GIN — узкое место. Рассмотри `jsonb_path_ops` (меньше, быстрее на запись, но меньше операторов) или триггерную денормализацию в `tsvector`.
:::

## GiST кратко

GiST — сбалансированное дерево для данных с перекрытием: геометрия (`&&` — пересечение), диапазоны (`&&`, `@>`, `<@`), полнотекст (близость). Для `GEO`-запросов «рестораны в радиусе 500 м» — только GiST.

```sql
CREATE INDEX places_location_idx ON places USING gist (ll_to_earth(lat, lng));
SELECT * FROM places WHERE earth_box(ll_to_earth(55.7, 37.6), 500) @> ll_to_earth(lat, lng);
```

## Частичные индексы

Индекс на подмножество строк. Меньше размер, быстрее запись, и planner понимает условие.

```sql
-- Индекс только для незавершённых заказов
CREATE INDEX orders_pending_idx ON orders (created_at)
  WHERE status = 'pending';

-- Planner использует его ТОЛЬКО если запрос явно фильтрует status = 'pending'
SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at;
```

## Bitmap Index Scan: между Index Scan и Seq Scan

Когда запрос возвращает 10-30% таблицы, PostgreSQL часто выбирает не Index Scan и не Seq Scan, а **Bitmap Index Scan**:

```
Bitmap Index Scan on orders_status_idx (actual time=0.050..0.050 rows=45000)
  Index Cond: (status = 'paid')
  -> Bitmap Heap Scan on orders (actual time=0.100..45.2 rows=45000)
     Recheck Cond: (status = 'paid')
     Heap Blocks: exact=1234 lossy=456
```

Механика: индекс сканируется один раз и строится битовая карта (bitmap) подходящих страниц таблицы. Потом страницы читаются **последовательно** — диск рад, но порядок строк теряется (поэтому `ORDER BY` без индекса потребует сортировку). Для 45000 из 500000 строк Index Scan дал бы случайный доступ к диску 45000 раз — это медленнее, чем прочитать 1700 страниц подряд.

Если видишь в плане `lossy` — bitmap не влез в память (`work_mem`), и PostgreSQL перешёл на битовую карту по страницам без точной привязки к строкам: потом дорогой Recheck на каждой строке страницы. Лечится: `SET work_mem = '64MB'` для тяжёлого запроса или глобально.

## Индексы на выражениях и джойны

Всё, что можно вычислить из строки детерминированно, можно проиндексировать:

```sql
-- Поиск по домену email
CREATE INDEX users_email_domain_idx ON users ((split_part(email, '@', 2)));
SELECT * FROM users WHERE split_part(email, '@', 2) = 'gmail.com';
-- Index Scan используется — выражение в индексе совпало с выражением в WHERE

-- COALESCE для «soft-архива»: deleted_at NULL = активная запись
CREATE INDEX orders_active_created_idx ON orders (created_at) WHERE deleted_at IS NULL;
```

Правило: выражение в `WHERE` должно **текстуально совпадать** (после нормализации) с выражением в индексе. `lower(email)` в индексе и `WHERE lower(email) = ...` — работают. `WHERE email ILIKE 'ann%'` против индекса на `lower(email)` — нет, потому что `ILIKE` и `lower` — разные выражения.

## EXPLAIN ANALYZE: чтение плана

`EXPLAIN` показывает план, `EXPLAIN ANALYZE` — выполняет и показывает реальные цифры.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE user_id = 5 ORDER BY created_at DESC LIMIT 10;
```

Типичный вывод и как его читать:

```
Limit  (actual time=0.123..0.456 rows=10 loops=1)
  ->  Index Scan Backward using orders_user_created_idx on orders
      (actual time=0.100..0.400 rows=10 loops=1)
        Index Cond: (user_id = 5)
        Buffers: shared hit=15
```

- `Index Scan` — хорошо. `Seq Scan` на большой таблице — плохо (если не ожидаешь >10% строк).
- `rows=10` vs `rows` в `EXPLAIN` без `ANALYZE` — если сильно расходятся, статистика устарела: `ANALYZE orders;`.
- `Buffers: shared hit=15` — 15 страниц из кэша. `read=1000` — 1000 с диска, медленно.
- `loops=10000` — вложенный цикл, часто N+1.

## VACUUM, autovacuum и bloat

PostgreSQL не удаляет строки при `UPDATE`/`DELETE` — создаёт новую версию (MVCC). Старые версии — «мёртвые кортежи». `VACUUM` их подчищает, освобождает место для переиспользования.

```sql
SELECT schemaname, relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000;
```

**Bloat** — раздувание таблиц и индексов от мёртвых кортежей и фрагментации. Симптомы: таблица «пустая», а занимает 100 GB. Лечение — `VACUUM (FULL)` (блокирует!) или `pg_repack` (онлайн). Профилактика — настроенный autovacuum:

```sql
ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.05);  -- вакуумить после 5% изменений, не 20%
```

:::caution[Autovacuum по умолчанию ленив]
`autovacuum_vacuum_scale_factor = 0.2` — вакуум после 20% изменений. Для таблицы в 100 млн строк это 20 млн мёртвых кортежей. На hot-таблицах ставь 0.01–0.05 или по абсолютному порогу `autovacuum_vacuum_threshold`.
:::

## Типичные ошибки и грабли

1. **Индекс на всё подряд.** Каждый индекс замедляет `INSERT`/`UPDATE`. Таблица с 20 индексами — это 20 деревьев на каждую строку. Удаляй неиспользуемые: `SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0`.
2. **`LIKE '%foo%` без pg_trgm.** B-Tree бессилен. Решение: `CREATE EXTENSION pg_trgm; CREATE INDEX ON posts USING gin (title gin_trgm_ops);`.
3. **Функция над индексированной колонкой.** `WHERE upper(email) = '...'` игнорирует индекс на `email`. Функциональный индекс на `upper(email)` — лекарство.
4. **Игнорирование leftmost prefix.** Индекс `(a, b)`, запрос `WHERE b = 5` — Seq Scan. Проверяй план, не предполагай.
5. **Autovacuum по умолчанию на hot-таблицах.** Bloat растёт, запросы тормозят, диск заполняется. Настрой per-table.
6. **`EXPLAIN` без `ANALYZE`.** План — предсказание, не факт. Всегда `EXPLAIN (ANALYZE, BUFFERS)` на реальных данных.

## Вопросы на собеседовании

1. **Почему `LIKE '%foo%'` не использует B-Tree?** Нет префикса-якоря: дерево сортировано слева, поиск возможен только от начала. Решение — pg_trgm или полнотекст.
2. **Что такое leftmost prefix?** Составной индекс `(a,b,c)` работает для фильтров по `a`, `(a,b)`, `(a,b,c)`, но не по `b` или `c`. Порядок колонок решает.
3. **Index Only Scan — что это и когда возможен?** Когда индекс покрывает все колонки запроса (через `INCLUDE` или сам ключ). PostgreSQL не трогает таблицу, читает только индекс.
4. **Разница B-Tree и GIN?** B-Tree — один ключ → одна строка, точный поиск и диапазоны. GIN — один элемент → много строк, для массивов, jsonb, полнотекста.
5. **Зачем VACUUM, если есть autovacuum?** Autovacuum по умолчанию ленив (20% изменений). На больших таблицах мёртвые кортежи копятся быстрее. Нужна настройка или ручной `VACUUM ANALYZE`.
6. **Что показывает Buffers в EXPLAIN ANALYZE?** Сколько страниц (8 KB) прочитано из кэша (`hit`) и с диска (`read`). `read` — главный индикатор медленного запроса.

## Практика

1. Создай таблицу `products` с 1 млн строк. Замери `SELECT * FROM products WHERE price BETWEEN 100 AND 200`. Добавь B-Tree на `price`, замери снова. Объясни разницу в плане.
2. Воспроизведи `LIKE '%foo%'` без индекса. Добавь `pg_trgm` GIN-индекс, сравни планы.
3. Создай составной индекс `(user_id, status, created_at)`. Проверь планы для запросов с `user_id`, `(user_id, status)`, `(status)`. Объясни результаты через leftmost prefix.
4. Сделай `UPDATE` на 100 тыс. строк. Посмотри `n_dead_tup` в `pg_stat_user_tables`. Запусти `VACUUM VERBOSE orders` и посмотри, что изменилось.
5. Найди bloat: сравни `pg_relation_size('orders')` с `SELECT count(*) * 200 FROM orders`. Если разница >50% — `pg_repack` или `VACUUM FULL`.

## Что почитать

- [PostgreSQL Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html) и [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [pg_repack](https://reorg.github.io/pg_repack/)
- [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)
