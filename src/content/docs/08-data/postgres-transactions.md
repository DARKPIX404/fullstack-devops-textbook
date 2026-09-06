---
title: "Транзакции, изоляция и блокировки в PostgreSQL"
description: "ACID под капотом: WAL и MVCC. Уровни изоляции с воспроизводимыми аномалиями на двух сессиях, READ COMMITTED против REPEATABLE READ, SERIALIZABLE и SSI, дедлоки, FOR UPDATE и SKIP LOCKED для очередей, advisory locks."
---

Транзакция — это обещание: либо выполнятся все операции, либо ни одной. Но в многопользовательской системе этого мало: что происходит, когда две транзакции работают с одними данными одновременно? Ответ определяет уровень изоляции — и именно здесь кроются самые трудноуловимые баги: данные, которые исчезают, счётчики, которые уходят в минус, отчёты, которые не сходятся.

В краткой версии ты видел ACID и таблицу уровней изоляции. Здесь мы воспроизведём каждую аномалию вживую на двух сессиях, разберём как работает MVCC под капотом, научимся читать разбор дедлока и соберём очередь на `SKIP LOCKED`.

## ACID под капотом

### Durability: WAL

PostgreSQL не пишет данные сразу в таблицы. Сначала запись попадает в **WAL** (Write-Ahead Log) — последовательный журнал на диске. Только после fsync WAL транзакция считается зафиксированной. Падение сервера? При старте PostgreSQL проигрывает WAL с момента последнего checkpoint и восстанавливает состояние. Именно поэтому `COMMIT` быстрый, а данные в таблицах могут лежать несвежими — их запишут фоновые процессы позже.

### Atomicity и Consistency: undo через MVCC

В отличие от MySQL с undo-log, PostgreSQL хранит **все версии строк прямо в таблице**. Каждая строка несёт `xmin` (транзакция-создатель) и `xmax` (транзаккация-удалитель, 0 = живая). Снапшот транзакции — список активных транзакций на момент старта. Строка видима, если её `xmin` зафиксирован и не в снапшоте, а `xmax` пуст или не зафиксирован.

```sql
SELECT xmin, xmax, * FROM accounts WHERE id = 1;
--  xmin   | xmax | id | balance
-- --------+------+----+---------
--  482130 |    0 |  1 |   1000
```

`UPDATE` — это `INSERT` новой версии + пометка старой как удалённой. Старая версия остаётся для транзакций, которые ещё смотрят на неё. Отсюда и bloat, и необходимость VACUUM — но об этом в главе про индексы.

### Isolation: уровни как контракты

Стандарт SQL определяет четыре уровня с аномалиями, которые они допускают. PostgreSQL реализует три из них (READ UNCOMMITTED работает как READ COMMITTED).

| Уровень | Dirty Read | Non-Repeatable Read | Phantom Read | Serialization Anomaly |
|---------|------------|---------------------|--------------|----------------------|
| READ COMMITTED | нет | **да** | **да** | да |
| REPEATABLE READ | нет | нет | **нет*** | да |
| SERIALIZABLE | нет | нет | нет | нет |

*В PostgreSQL REPEATABLE READ фактически предотвращает фантомы через снапшот.

## Аномалии вживую: две сессии

Открой два терминала с `psql`. Все примеры на таблице:

```sql
CREATE TABLE accounts (id int PRIMARY KEY, balance numeric(12,2) CHECK (balance >= 0));
INSERT INTO accounts VALUES (1, 1000), (2, 1000);
```

### Dirty Read — невозможен в PostgreSQL

```sql
-- Сессия A                          -- Сессия B
BEGIN;
UPDATE accounts SET balance = 500 WHERE id = 1;
-- не коммитим
                                     BEGIN;
                                     SELECT balance FROM accounts WHERE id = 1;
                                     -- 1000 — старое значение, не 500
-- PostgreSQL не читает незафиксированные данные. Грязное чтение невозможно на любом уровне.
```

### Non-Repeatable Read на READ COMMITTED

```sql
-- Сессия A                          -- Сессия B
BEGIN;
SELECT balance FROM accounts WHERE id = 1;  -- 1000
                                     BEGIN;
                                     UPDATE accounts SET balance = 777 WHERE id = 1;
                                     COMMIT;
SELECT balance FROM accounts WHERE id = 1;  -- 777!
-- Та же транзакция, тот же запрос — другой результат.
```

### Phantom Read на READ COMMITTED

```sql
-- Сессия A                          -- Сессия B
BEGIN;
SELECT count(*) FROM accounts;      -- 2
                                     INSERT INTO accounts VALUES (3, 500);
                                     COMMIT;
SELECT count(*) FROM accounts;      -- 3 — призрак!
```

### REPEATABLE READ: снапшот на всю транзакцию

```sql
-- Сессия A                          -- Сессия B
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM accounts WHERE id = 1;  -- 1000
                                     UPDATE accounts SET balance = 777 WHERE id = 1;
                                     COMMIT;
SELECT balance FROM accounts WHERE id = 1;  -- 1000 — снапшот!
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
-- ОШИБКА: could not serialize access due to concurrent update
-- PostgreSQL не даст перезаписать строку, изменённую после твоего снапшота.
```

REPEATABLE READ в PostgreSQL — это снапшотная изоляция: ты видишь базу на момент старта транзакции. Попытка изменить строку, которую кто-то изменил и зафиксировал после твоего старта — ошибка сериализации. Приложение обязано повторить транзакцию.

## SERIALIZABLE и SSI

SERIALIZABLE гарантирует: результат любого набора параллельных транзакций эквивалентен их последовательному выполнению. Реализация — SSI (Serializable Snapshot Isolation): отслеживаются read-write конфликты между снапшотами.

```sql
-- Классика: два перевода с проверкой баланса
-- Сессия A                          -- Сессия B
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT balance FROM accounts WHERE id = 1;  -- 1000
                                     BEGIN ISOLATION LEVEL SERIALIZABLE;
                                     SELECT balance FROM accounts WHERE id = 1;  -- 1000
                                     -- обе видят 1000, обе решат, что списание возможно
UPDATE accounts SET balance = balance - 800 WHERE id = 1;
                                     UPDATE accounts SET balance = balance - 800 WHERE id = 1;
                                     -- ОШИБКА: could not serialize
COMMIT;  -- успех
```

SSI детектирует опасную структуру: обе транзакции прочитали одну строку и обе пишут в неё. Одну убивает. Код приложения должен ловить `40001` и ретраить:

```ts
async function transfer(fromId: number, toId: number, amount: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const from = await tx.accounts.findByIdForUpdate(fromId);
        if (from.balance < amount) throw new Error('Insufficient funds');
        await tx.accounts.decrement(fromId, amount);
        await tx.accounts.increment(toId, amount);
      });
    } catch (e) {
      if (e.code === '40001') continue; // serialization failure, ретрай
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}
```

:::caution[SERIALIZABLE не бесплатно]
Каждый ретрай — это повторная работа. На hot-таблицах с высокой конкуренцией SERIALIZABLE может убить throughput. Используй точечно, где инвариант критичен.
:::

## Блокировки: строки и таблицы

PostgreSQL блокирует на уровне строк. `UPDATE`, `DELETE`, `SELECT FOR UPDATE` — берут `ROW EXCLUSIVE`. Две транзакции не могут одновременно блокировать одну строку на запись.

```sql
-- Сессия A                          -- Сессия B
BEGIN;
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
-- блокировка строки
                                     BEGIN;
                                     SELECT * FROM accounts WHERE id = 1 FOR UPDATE;
                                     -- ВИСИТ, ждёт сессию A
UPDATE accounts SET balance = 100 WHERE id = 1;
-- снимает блокировку при COMMIT
                                     -- разблокировалось, продолжает
```

`FOR SHARE` — блокировка на чтение с запретом изменения. `FOR NO KEY UPDATE` — как `FOR UPDATE`, но не блокирует внешние ключи (для репликации).

### Дедлоки и как их читать

Дедлок — цикл ожиданий. Классика: две транзакции обновляют две строки в разном порядке.

```sql
-- Сессия A                          -- Сессия B
BEGIN;
UPDATE accounts SET balance = 900 WHERE id = 1;
                                     BEGIN;
                                     UPDATE accounts SET balance = 800 WHERE id = 2;
UPDATE accounts SET balance = 700 WHERE id = 2;
-- ждёт B                             UPDATE accounts SET balance = 600 WHERE id = 1;
-- ждёт A
-- PostgreSQL детектирует цикл, убивает одну:
-- ERROR: deadlock detected
-- DETAIL: Process 12345 waits for ShareLock on transaction 67890; blocked by process 54321.
--         Process 54321 waits for ShareLock on transaction 67889; blocked by process 12345.
--         Process 12345: UPDATE accounts SET balance = 600 WHERE id = 1;
```

Читаем разбор: процесс 12345 ждёт транзакцию 67890, которую держит процесс 54321. Процесс 54321 ждёт транзакцию 67889, которую держит 12345. Цикл. PostgreSQL убивает ту транзакцию, которая меньше сделала (детект меньшего отката).

Профилактика: одинаковый порядок обновления строк во всех транзакциях, короткие транзакции, ретрай после дедлока.

## SKIP LOCKED: очереди без блокировок

Задача: забрать следующую задачу из очереди. `SELECT ... FOR UPDATE` — все воркеры повиснут на первой строке. Решение — `SKIP LOCKED`: пропустить заблокированные строки.

```sql
-- Таблица задач
CREATE TABLE jobs (
  id serial PRIMARY KEY,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending_idx ON jobs (created_at) WHERE status = 'pending';

-- Воркер: атомарно забрать задачу
WITH next_job AS (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs SET status = 'processing'
WHERE id = (SELECT id FROM next_job)
RETURNING *;
```

Каждый воркер получает свою задачу, не блокируя других. Это основа job-очередей вместо тяжёлых брокеров для простых случаев.

:::tip[Частичный индекс для очереди]
`WHERE status = 'pending'` — индекс маленький, воркеры видят только актуальное. Когда задача станет 'done', она выпадет из индекса.
:::

## Advisory locks: блокировки без таблиц

Нужно заблокировать «ресурс», а не строку: не запускать две сверки баланса одновременно, не гонять два деплоя сразу.

```sql
-- Блокировка по ключу 42, сессионная
SELECT pg_advisory_lock(42);
-- ... критическая секция ...
SELECT pg_advisory_unlock(42);

-- Попробовать взять, не блокируясь
SELECT pg_try_advisory_lock(42);  -- true/false

-- Транзакционная: отпустится при COMMIT/ROLLBACK
SELECT pg_advisory_xact_lock(42);
```

Из Node.js через `pg`:

```ts
await client.query('SELECT pg_advisory_xact_lock($1)', [hashString('nightly-report')]);
// транзакция держит блокировку, другие инстансы ждут
```

## Типичные ошибки и грабли

1. **«Проверил и записал» без FOR UPDATE.** Две транзакции одновременно проверяют `balance >= 100`, обе списывают, баланс -100. `SELECT FOR UPDATE` или `SERIALIZABLE` обязательны.
2. **Длинные транзакции с HTTP-вызовами.** Открыл транзакцию, вызвал платёжный API (3 секунды), закрыл. Все блокировки держатся 3 секунды — дедлоки и таймауты. Делай внешние вызовы вне транзакции.
3. **Игнорирование ретраев на SERIALIZABLE.** Ошибка `40001` — не фатальная, а сигнал повторить. Без ретраев приложение падает под нагрузкой.
4. **Дедлоки от разного порядка обновлений.** Транзакция А: 1→2, Б: 2→1. Всегда сортируй `id`: `UPDATE ... WHERE id IN (1,2) ORDER BY id`.
5. **SKIP LOCKED без частичного индекса.** `FOR UPDATE SKIP LOCKED` по полной таблице — Seq Scan на каждый воркер. Частичный индекс решает.
6. **Advisory lock без unlock.** Сессионная блокировка переживает транзакцию. Используй `pg_advisory_xact_lock` или не забудь unlock.

## Вопросы на собеседовании

1. **Что такое MVCC и чем PostgreSQL отличается от MySQL?** Multi-Version Concurrency Control: каждая транзакция видит снапшот. PostgreSQL хранит версии в таблице (xmin/xmax), MySQL — в undo-log. Отсюда bloat в PostgreSQL и rollback-фрагментация в MySQL.
2. **Разница READ COMMITTED и REPEATABLE READ в PostgreSQL?** RC — новый снапшот на каждый запрос, видишь свежие коммиты. RR — снапшот на всю транзакцию, попытка записать в изменённую строку — ошибка сериализации.
3. **Что такое фантомное чтение и как PostgreSQL его предотвращает?** Повторный запрос видит новые строки от другой транзакции. В PostgreSQL REPEATABLE READ уже предотвращает фантомы через снапшот — стандарт SQL это не требует.
4. **Как работает SKIP LOCKED и где применяется?** `SELECT ... FOR UPDATE SKIP LOCKED` пропускает заблокированные строки. Основа job-очередей: каждый воркер атомарно забирает свою задачу.
5. **Как читать deadlock detail?** `Process X waits for ShareLock on transaction Y; blocked by process Z` — строишь граф кто кого ждёт, находишь цикл. Убиваемая транзакция — меньший откат.
6. **Зачем advisory locks, если есть таблицы?** Блокировка логического ресурса без строки: один сверщик, один деплой, один ребилд кэша. Дешевле и чище, чем lock-таблица.

## Практика

1. Воспроизведи non-repeatable read на READ COMMITTED двумя сессиями. Переключи на REPEATABLE READ, убедись, что аномалия исчезла.
2. Реализуй перевод денег с `SELECT ... FOR UPDATE` и проверкой баланса. Напиши тест с двумя параллельными переводами, докажи, что баланс не уходит в минус.
3. Собери дедлок: две транзакции обновляют `accounts` в разном порядке. Зафиксируй `deadlock detected`, исправь порядок обновлений на `ORDER BY id`.
4. Реализуй очередь задач на `SKIP LOCKED`: три воркера в разных процессах забирают `pending` задачи. Убедись, что ни одна задача не взята дважды.
5. Напиши функцию, которая берёт `pg_advisory_xact_lock` по хешу имени отчёта. Запусти два инстанса, убедись, что второй ждёт завершения первого.

## Что почитать

- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [SSI: A Critique of ANSI SQL Isolation Levels](https://www.cs.cmu.edu/~pavlo/courses/15721-fall2019/papers/05-serializability-berenson1995.pdf)
- [PostgreSQL 14 Internals: MVCC](https://www.interdb.jp/pg/)
