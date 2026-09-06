---
title: "Структуры данных Redis: от строк до Streams"
description: "Строки, хэши, списки, сеты, Sorted Sets с полными примерами команд. Лидерборд на ZADD/ZREVRANGE/ZRANGEBYSCORE. Pub/Sub против Streams с consumer groups, Redis Streams как очередь, RedisJSON и RediSearch, персистентность RDB против AOF, eviction-политики."
---

Redis — не просто «ключ-значение». Это набор специализированных структур данных, каждая из которых решает свой класс задач. Знание структур — это разница между «Redis как кэш строк» и «Redis как основа для лидербордов, очередей, геопоиска и pub/sub».

В этой главе — полный обход всех структур с командами, паттернами и компромиссами. К концу ты выберешь правильную структуру для любой задачи.

## Строки: база и счётчики

Строка — простейшая структура, но с мощными операциями.

```bash
SET user:1:name "Alice" EX 3600        # строка с TTL 1 час
GET user:1:name                        # "Alice"
SET counter:page:home 0                # инициализация счётчика
INCR counter:page:home                 # 1 — атомарный инкремент
INCRBY counter:page:home 10            # 11
DECR counter:page:home                 # 10
GETSET counter:page:home 100           # вернёт 10, установит 100

# Для rate limiting: INCR + EXPIRE
INCR rl:ip:1.2.3.4                     # 1
EXPIRE rl:ip:1.2.3.4 60                # TTL 60 секунд, только если ключ новый
```

Строки хранят до 512 MB. Бинарно-безопасны — можно хранить JPEG, сериализованные объекты, что угодно.

## Хэши: объекты с полями

Хэш — мини-таблица внутри ключа. Удобен для профилей, настроек, объектов с частичным обновлением.

```bash
HSET user:1 name "Alice" email "alice@example.com" age 30
HGET user:1 name                          # "Alice"
HGETALL user:1                            # все поля и значения
HSET user:1 age 31                        # обновление одного поля
HDEL user:1 age                           # удаление поля
HEXISTS user:1 email                      # 1 — существует
HINCRBY user:1 login_count 1              # атомарный счётчик внутри хэша
HKEYS user:1                              # список полей
```

В Node.js:

```ts
await redis.hSet('user:1', { name: 'Alice', email: 'alice@example.com' });
const user = await redis.hGetAll('user:1');  // { name: 'Alice', email: 'alice@example.com' }
await redis.hIncrBy('user:1', 'login_count', 1);
```

Преимущество перед JSON-строкой: обновление одного поля без чтения-перезаписи всего объекта. Для объектов с 20 полями, из которых часто меняется одно — существенно.

## Списки: очереди и стеки

Список — упорядоченная коллекция строк, двусторонняя.

```bash
LPUSH queue:jobs "job:1"                  # в начало
LPUSH queue:jobs "job:2"                  # в начало
RPUSH queue:jobs "job:3"                  # в конец
LRANGE queue:jobs 0 -1                    # [job:2, job:1, job:3] — от начала к концу
LPOP queue:jobs                           # job:2 — из начала (FIFO)
BRPOP queue:jobs 0                        # blocking pop из конца, ждёт бесконечно
BRPOP queue:jobs 5                        # ждёт до 5 секунд
LLEN queue:jobs                           # 2
```

Паттерн producer-consumer:

```bash
# Producer
RPUSH queue:email '{"to":"a@b.c","template":"welcome"}'

# Consumer (в цикле)
BRPOP queue:email 0  # ждёт, блокируется, возвращает когда появится
```

Ограничение: нет повторной доставки. Если consumer взял задачу и упал — задача потеряна. Для надёжности — Redis Streams.

## Сеты: уникальные коллекции

Сет — неупорядоченная коллекция уникальных строк. Мгновенная проверка принадлежности, пересечения, объединения.

```bash
SADD tags:post:1 "redis" "database" "cache"
SADD tags:post:2 "redis" "queue"
SADD tags:post:3 "database" "sql"

SISMEMBER tags:post:1 "redis"          # 1 — есть
SISMEMBER tags:post:1 "sql"            # 0 — нет
SCARD tags:post:1                      # 3 — количество

# Кто лайкнул оба поста?
SINTER tags:post:1 tags:post:2         # ["redis"]
# Все теги из двух постов?
SUNION tags:post:1 tags:post:2         # ["redis", "database", "cache", "queue"]
# Разница: что в первом, чего нет во втором?
SDIFF tags:post:1 tags:post:2          # ["database", "cache"]
```

Классика: «кто из друзей онлайн» — `SINTER online users:friends:42`. Проверка «лакнул ли пользователь пост» — `SISMEMBER likes:post:1 user:7`, O(1), без запроса к БД.

## Sorted Sets: лидерборды и рейтинги

Sorted Set — сет с числовым score. Redis держит его отсортированным. Каждая операция — O(log N), даже на миллионах элементов.

```bash
ZADD leaderboard 950 "user:7"            # добавить/обновить очки
ZADD leaderboard 820 "user:3" 1250 "user:9"

ZREVRANGE leaderboard 0 9 WITHSCORES     # топ-10 (по убыванию)
# 1) "user:9" 2) "1250" 3) "user:7" 4) "950" ...

ZREVRANK leaderboard "user:7"            # 1 — место (0-based)
ZSCORE leaderboard "user:7"              # 950
ZRANGEBYSCORE leaderboard 800 1000       # диапазон по очкам
ZINCRBY leaderboard 50 "user:7"          # +50 очков, атомарно
ZCARD leaderboard                        # количество игроков
ZREM leaderboard "user:3"                # удалить
```

Полноценный лидерборд в Node.js:

```ts
// Добавить результат игры
await redis.zAdd('leaderboard', { score: 1250, value: `user:${userId}` });

// Топ-10 с очками
const top = await redis.zRevRangeWithScores('leaderboard', 0, 9);
// [{ value: 'user:9', score: 1250 }, ...]

// Место текущего игрока
const rank = await redis.zRevRank('leaderboard', `user:${userId}`);

// Топ вокруг игрока (круто для «ты на 127 месте»)
const around = await redis.zRevRangeWithScores('leaderboard', rank - 2, rank + 2);

// Диапазон: кто с 1000 до 2000 очками
const mid = await redis.zRangeByScoreWithScores('leaderboard', 1000, 2000);
```

:::tip[Обнуление лидерборда]
Не удаляй ключ — это O(N). Создай новый ключ с timestamp: `leaderboard:2024-W23`. Старый дай TTL на неделю для истории. Или используй `ZREMRANGEBYRANK` для очистки хвоста.
:::

## Pub/Sub: мгновенно, но без гарантий

Один паблишер — много подписчиков. Доставка мгновенная, но если подписчик был оффлайн — сообщение потеряно.

```ts
// Подписчик
const subscriber = redis.duplicate();
await subscriber.connect();
await subscriber.subscribe('orders:events', (message) => {
  const event = JSON.parse(message);
  console.log('Новый заказ:', event.id);
});

// Паблишер (в другом процессе)
await redis.publish('orders:events', JSON.stringify({ id: 123, total: 4500 }));
```

Применение: уведомления по WebSocket, инвалидация кэша между инстансами, события для real-time дашбордов. Не применение: надёжная доставка, очереди задач.

## Streams: очереди с гарантиями

Redis Streams (5.0+) — append-only log с consumer groups. Сообщения сохраняются, есть подтверждение обработки, перечитывание недоставленных.

```bash
# Продьюсер: XADD stream key * field value
XADD orders:stream * order_id 123 total 4500
XADD orders:stream * order_id 124 total 3200

# Консьюмер в группе: XREADGROUP
XGROUP CREATE orders:stream processors 0          # создать группу с начала
XREADGROUP GROUP processors worker-1 COUNT 10 STREAMS orders:stream >
# > — новые сообщения, ещё не выданные группе

# Подтверждение обработки
XACK orders:stream processors 1623456789012-0

# Недоставленные (worker упал, не подтвердил)
XPENDING orders:stream processors - + 10
```

Ключевые отличия от Pub/Sub: сообщения хранятся, consumer groups распределяют нагрузку, `XACK` подтверждает обработку, `XPENDING` показывает зависшие. Это настоящая очередь.

```ts
// Node.js: продьюсер
await redis.xAdd('orders:stream', '*', { orderId: '123', total: '4500' });

// Консьюмер
const messages = await redis.xReadGroup(
  'processors', 'worker-1',
  { key: 'orders:stream', id: '>' },  // новые сообщения
  { COUNT: 10, BLOCK: 5000 }          // ждать до 5 секунд
);

for (const msg of messages) {
  try {
    await processOrder(msg.message);
    await redis.xAck('orders:stream', 'processors', msg.id);
  } catch (e) {
    // Не ack — вернётся в pending, перечитаем позже
  }
}
```

:::caution[Streams vs списки vs Pub/Sub]
Список — простая очередь, без повторной доставки. Pub/Sub — мгновенно, но без гарантий. Streams — надёжно, с группами, но сложнее. Выбирай по требованиям к доставке.
:::

## RedisJSON и RediSearch кратко

Модули Redis Stack:

- **RedisJSON**: нативный JSON с путями `$.a.b[0]`.
  ```bash
  JSON.SET user:1 $ '{"name":"Alice","address":{"city":"Moscow"}}'
  JSON.GET user:1 $.address.city          # "\"Moscow\""
  JSON.NUMINCRBY user:1 $.login_count 1
  ```
- **RediSearch**: индексы и полнотекстовый поиск по JSON и хэшам.
  ```bash
  FT.CREATE userIdx ON JSON PREFIX 1 user: SCHEMA $.name AS name TEXT
  FT.SEARCH userIdx "@name:Alice"
  ```

Полезно для прототипов и специфических случаев, но не заменяет Elasticsearch для серьёзного поиска или PostgreSQL jsonb для сложных запросов с джойнами и агрегациями. Правило простое: если поиск — ядро продукта, бери специализированный движок; если это удобная фича поверх ключа — модулей Redis хватит.

## Персистентность: RDB против AOF

По умолчанию Redis держит всё в памяти и теряет при рестарте. Два механизма персистентности:

**RDB (snapshot)**: форк, сброс дампа на диск. Компактно, быстро на чтение, но потеряешь всё с последнего снапшота.

```conf
# redis.conf
save 900 1        # снапшот каждые 15 минут, если ≥1 изменение
save 300 10       # каждые 5 минут, если ≥10 изменений
dbfilename dump.rdb
```

**AOF (append-only file)**: журнал каждой записи. Максимум потеряешь 1 секунду (с `everysec`). Больше файлы, медленнее рестарт.

```conf
appendonly yes
appendfsync everysec    # fsync каждую секунду — баланс скорости/надёжности
appendfsync always      # fsync на каждую команду — максимум надёжности, медленно
appendfsync no          # ОС решает — быстро, рискованно
```

Рекомендация: AOF с `everysec` для сессий, лидербордов, очередей. RDB для кэша (или вообще без персистентности). Оба включены — максимум надёжности.

## Eviction-политики: что удалять при нехватке памяти

Когда память заполнена, Redis удаляет ключи по политике:

| Политика | Что удаляет | Когда использовать |
|----------|-------------|-------------------|
| `noeviction` | Ничего, ошибка на запись | По умолчанию. Для важных данных. |
| `allkeys-lru` | Наименее используемые (LRU) | Чистый кэш. |
| `allkeys-lfu` | Наименее часто используемые (LFU) | Кэш с горячими ключами. |
| `volatile-lru` | LRU среди ключей с TTL | Кэш + важные ключи без TTL. |
| `volatile-ttl` | С наименьшим TTL | Приоритет свежим данным. |
| `allkeys-random` | Случайные | Редко, для тестов. |

```conf
maxmemory 1gb
maxmemory-policy allkeys-lfu    # лучше LRU для большинства кэшей
```

LFU (Least Frequently Used) учитывает частоту обращений, а не только давность. Для кэша с «горячими» ключами — лучше LRU.

:::caution[noeviction — не всегда правильно]
Для чистого кэша `noeviction` — ошибка: один всплеск памяти, и Redis отказывает в записи. Кэш должен вытесняться. Для очередей и сессий — наоборот, потерять данные нельзя.
:::

## Типичные ошибки и грабли

1. **Pub/Sub для надёжных событий.** Подписчик оффлайн — событие потеряно. Для важного — Streams.
2. **Большие ключи.** `KEYS *` на проде — блокировка. `SMEMBERS` на сет с миллионом элементов — та же беда. Используй `SCAN`, `SSCAN`, ограничивай размеры.
3. **Списки как надёжные очереди.** `LPOP`/`BRPOP` без ack — потеря задач при падении consumer. Используй Streams или ack-механизм.
4. **Игнорирование eviction-политики.** По умолчанию `noeviction` — Redis упадёт по памяти. Для кэша поставь `allkeys-lfu`.
5. **Хранение больших объектов в хэшах без срока.** Хэш растёт бесконечно, память течёт. TTL на весь ключ, не на поля.
6. **Один Redis на всё.** Кэш, сессии, очереди в одном инстансе с разными требованиями к персистентности. Разделяй или используй разные logical databases (0-15).

## Вопросы на собеседовании

1. **Разница Pub/Sub и Streams?** Pub/Sub — мгновенно, без хранения, потеря при оффлайне. Streams — хранит, consumer groups, ack, повторная доставка.
2. **Как устроен лидерборд на Sorted Sets?** `ZADD` для очков, `ZREVRANGE` для топа, `ZREVRANK` для места, `ZRANGEBYSCORE` для диапазонов. O(log N) на операцию.
3. **RDB против AOF?** RDB — снапшоты, компактно, потеря данных. AOF — журнал, больше, до 1 секунды потери. Для важного — AOF everysec.
4. **Что делать, если consumer Streams упал?** Не ack — сообщение остаётся в pending. `XPENDING` показывает, `XCLAIM` переназначает другому consumer.
5. **Когда использовать хэш, а не JSON-строку?** Когда нужно обновлять отдельные поля без чтения всего объекта. Хэш — O(1) на поле, JSON — перезапись целиком.
6. **Eviction-политики: чем отличаются LRU и LFU?** LRU — по давности последнего использования. LFU — по частоте. LFU лучше для «горячих» ключей, которые используются часто.

## Практика

1. Реализуй лидерборд на Sorted Sets: добавление очков, топ-10, место игрока, топ-5 вокруг игрока. Симулируй 1000 игроков, замери latency.
2. Собери очередь на Streams: продьюсер пушит задачи, три воркера в consumer group обрабатывают. Убей одного воркера посреди обработки, проверь `XPENDING` и переназначь через `XCLAIM`.
3. Реализуй rate limiting sliding window на Sorted Set без Lua. Сравни с Lua-версией: гонки, производительность.
4. Подними Redis с AOF `everysec` и `maxmemory-policy allkeys-lfu`. Заполни память, наблюдай eviction через `INFO stats` (`evicted_keys`).
5. Построй «кто онлайн» на сетах: `SADD online user:1`, `SINTER` с друзьями. Добавь TTL через отдельный ключ-сердцебиение.

## Что почитать

- [Redis Data Types](https://redis.io/docs/latest/develop/data-types/)
- [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/)
- [Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis Eviction Policies](https://redis.io/docs/latest/reference/eviction/)
- [RedisJSON](https://redis.io/docs/latest/data-types/json/) и [RediSearch](https://redis.io/docs/latest/interact/search-and-query/)
