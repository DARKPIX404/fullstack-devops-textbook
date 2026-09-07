---
title: "Кэш-паттерны в Redis"
description: "Cache-aside с TTL и джиттером, защита от cache stampede через mutex и permValue, write-through и write-behind, стратегии инвалидации, сессии, rate limiting на Lua-скриптах, кэширование API-ответов, антипаттерны."
---

Кэш — это контракт между скоростью и консистентностью. Ты обещаешь: данные будут быстрыми, но, возможно, на пять минут устаревшими. Хороший инженер осознанно выбирает, что кэшировать, насколько, и как инвалидировать. Плохой — кэширует всё подряд и неделю ищет, почему админка показывает старые данные.

В этой главе разбираем паттерны, которые решают 95% задач кэширования, и антипаттерны, которые создают 95% проблем.

## Cache-aside: рабочая лошадка

Самый распространённый паттерн: приложение сначала смотрит в кэш, промах — идёт в БД и заполняет кэш.

```ts
import { createClient } from 'redis';
const redis = createClient({ url: 'redis://localhost:6379' });
await redis.connect();

async function getUser(id: string) {
  const key = `user:${id}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);  // hit — O(1), ~100 мкс

  const user = await db.users.findById(id);  // miss — идём в PostgreSQL
  if (user) {
    await redis.set(key, JSON.stringify(user), { EX: 300 });  // 5 минут TTL
  }
  return user;
}
```

TTL — компромисс: чем длиннее, тем реже бьём в БД, но тем дольше данные устаревшие. Для пользовательского профиля — 5-15 минут, для каталога товаров — 1-24 часа, для счётчиков — не кэшируем вообще.

:::tip[Джиттер против thundering herd]
Если 1000 ключей истекают одновременно, 1000 запросов ударят в БД разом. Добавляй случайность: `EX: 300 + Math.floor(Math.random() * 60)` — ±10% джиттер растянет истечения.
:::

## Cache stampede: защита мьютексом и permValue

Популярный ключ истёк, пришло 500 запросов. Все промахиваются, все идут в БД. БД падает. Решения:

**Mutex (lock)**: один запрос берёт лок через [`SET` с флагами `NX EX`](https://redis.io/docs/latest/commands/set/), остальные ждут или получают stale-данные.

```ts
async function getUserStampedeSafe(id: string) {
  const key = `user:${id}`;
  const lockKey = `lock:user:${id}`;

  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  // Пытаемся взять лок: SET NX EX — только если не существует
  const locked = await redis.set(lockKey, '1', { NX: true, EX: 10 });
  if (!locked) {
    // Кто-то уже обновляет — ждём 50 мс и пробуем снова
    await new Promise(r => setTimeout(r, 50));
    const retried = await redis.get(key);
    if (retried) return JSON.parse(retried);
    return null;  // или бросаем ошибку, зависит от требований
  }

  try {
    const user = await db.users.findById(id);
    if (user) await redis.set(key, JSON.stringify(user), { EX: 300 });
    return user;
  } finally {
    await redis.del(lockKey);  // важно: снимаем лок даже при ошибке
  }
}
```

**PermValue (permanent value)**: храним устаревшее значение вечно, обновляем фоном. Запросы всегда получают ответ, возможно чуть старый.

```ts
async function getUserPermValue(id: string) {
  const key = `user:${id}`;
  const value = await redis.get(key);
  if (value) {
    const { data, expired } = JSON.parse(value);
    if (!expired) return data;

    // Устарело, но есть — возвращаем и запускаем фоновое обновление
    refreshInBackground(id).catch(console.error);
    return data;
  }
  // Нет вообще — синхронно из БД
  const user = await db.users.findById(id);
  await redis.set(key, JSON.stringify({ data: user, expired: false }), { EX: 300 });
  return user;
}
```

## Write-through и write-behind

**Write-through**: запись сразу в БД и в кэш. Консистентно, но медленно (два вызова).

```ts
async function updateUser(id: string, data: Partial<User>) {
  const user = await db.users.update(id, data);  // сначала БД
  await redis.set(`user:${id}`, JSON.stringify(user), { EX: 300 });  // потом кэш
  return user;
}
```

**Write-behind**: запись сначала в кэш, в БД — асинхронно батчами. Максимально быстро, но риск потери данных при падении Redis. Только для некритичных данных: аналитика, счётчики просмотров, лайки.

```ts
async function incrementViewCount(postId: string) {
  await redis.incr(`views:${postId}`);
  // Фоновый воркер раз в 10 секунд: HGETALL views:* → UPDATE posts SET views = views + ? → DEL views:*
}
```

## Инвалидация: самое сложное в кэшировании

Фил Вирт: «There are only two hard things in Computer Science: cache invalidation and naming things».

**TTL** — просто, но данные устаревают. **Event-based** — сложно, но мгновенно:

```ts
// При обновлении пользователя публикуем событие
await db.users.update(id, data);
await redis.publish('cache:invalidate', JSON.stringify({ type: 'user', id }));

// Подписчик в другом процессе (механика Pub/Sub — в [документации Redis](https://redis.io/docs/latest/develop/interact/pubsub/))
subscriber.subscribe('cache:invalidate', (msg) => {
  const { type, id } = JSON.parse(msg);
  if (type === 'user') redis.del(`user:${id}`);
});
```

Для распределённых систем — [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/) или брокер вместо Pub/Sub (гарантии доставки). Кэш-теги: при обновлении продукта инвалидируем `product:{id}`, `category:{catId}:products`, `search:*`. Сложно, но решает проблему каскадной инвалидации.

:::caution[Инвалидация по тегам не бесплатна]
Нужна обратная индексация: `tag:product:1 → [key1, key2, ...]`. Каждая запись обновляет индекс. Для высоконагруженных систем — отдельная статья боли.
:::

## Сессии в Redis

Stateless-балансировщик требует, чтобы любой инстанс backend мог проверить сессию. Redis — идеальное место: быстро, с TTL.

```ts
// Логин
const sid = crypto.randomUUID();
await redis.set(`sess:${sid}`, JSON.stringify({ userId: user.id, role: user.role }), { EX: 60 * 60 * 24 * 7 });

// Middleware
const sid = req.cookies.sid;
const session = sid ? await redis.get(`sess:${sid}`) : null;
req.user = session ? JSON.parse(session) : null;

// Выход
await redis.del(`sess:${sid}`);
```

В отличие от хранения в памяти процесса: переживает рестарт, работает с несколькими репликами, TTL сам чистит протухшие. Описание типа данных «строка» с TTL — в [документации Redis](https://redis.io/docs/latest/develop/data-types/strings/).

## Rate limiting: от фиксированного окна к token bucket

### Fixed window: просто, но граница дырявая

```bash
# 100 запросов в минуту
INCR rl:ip:1.2.3.4        # первый запрос: 1
EXPIRE rl:ip:1.2.3.4 60   # ставим TTL только на первом

# Клиент делает 100 запросов в 00:59, ещё 100 в 01:00 — 200 за 2 секунды.
```

### Sliding window: точно, но дороже

Sorted Set: каждый запрос — элемент с timestamp. Очищаем старше окна, считаем остаток. Sorted Sets как структура разобраны в [документации Redis](https://redis.io/docs/latest/develop/data-types/sorted-sets/).

```ts
async function rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const member = `${now}-${Math.random()}`;
  const windowStart = now - windowSec * 1000;

  await redis.zRemRangeByScore(`rl:${key}`, 0, windowStart);
  await redis.zAdd(`rl:${key}`, { score: now, value: member });
  await redis.expire(`rl:${key}`, windowSec);
  const count = await redis.zCard(`rl:${key}`);

  return count <= limit;  // false — отвечаем 429
}
```

### Token bucket: гибко и честно

Ведро на `capacity` токенов, пополняется `rate` в секунду. Запрос берёт один токен. Нет токенов — отказ. Гладко, без скачков на границе окна.

```lua
-- rate_limit.lua — атомарно, иначе race condition
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local last = tonumber(bucket[2]) or now

tokens = math.min(capacity, tokens + (now - last) * rate)

if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, math.ceil(capacity / rate) * 1000)
  return 0
end

tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate) * 1000)
return 1
```

```ts
const allowed = await redis.eval(
  fs.readFileSync('rate_limit.lua', 'utf8'),
  { keys: [`rl:${userId}`], arguments: ['100', '10', Date.now().toString()] }
);
if (!allowed) return res.status(429).json({ error: 'Too many requests' });
```

:::tip[Зачем Lua-скрипт]
Без скрипта: читаем tokens, вычисляем, записываем — между чтением и записью другой запрос успевает прочитать то же значение. Гонка. Lua выполняется атомарно — никто не влезет.
:::

## Негативное кэширование и пустые результаты

Промах в кэш бывает двух видов: данных нет (key miss) и данных **не существует** (пользователь удалён, товар снят с продажи). Без защиты каждый запрос «несуществующего» пользователя — это запрос в БД, который тоже ничего не вернёт. **Negative caching** кэширует сам факт отсутствия:

```ts
async function getUserSafe(id: string) {
  const key = `user:${id}`;
  const cached = await redis.get(key);
  if (cached !== null) {
    return cached === '__null__' ? null : JSON.parse(cached);  // hit: либо данные, либо «нет»
  }

  const user = await db.users.findById(id);
  // Кэшируем и отсутствие — коротким TTL, чтобы случайная ошибка не «заперла» пользователя навсегда
  await redis.set(key, user ? JSON.stringify(user) : '__null__', { EX: user ? 300 : 60 });
  return user;
}
```

Тонкости: (1) TTL на `__null__` короче — данные могли появиться; (2) отличай «промах кэша» от «записи нет» — код выше использует `GET` + проверку на `null` из Redis (вернёт `null` для отсутствующего ключа), поэтому маркер `__null__` не конфликтует; (3) при записи нового пользователя не забудь удалить его `__null__`-ключ — event-based инвалидация из прошлого раздела решает и это.

Негативное кэширование критично для endpoint'ов, которые боты и сканеры долбят перебором ID: `/users/999999` без защиты — прямая дорога к нагрузке на БД.

## Кэширование API-ответов

Для GET-эндпоинтов с тяжёлыми вычислениями — кэшировать целиком:

```ts
app.get('/api/reports/sales', async (req, res) => {
  const cacheKey = `report:sales:${req.query.from}:${req.query.to}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(JSON.parse(cached));
  }

  const report = await generateSalesReport(req.query.from, req.query.to);  // тяжёлый запрос
  await redis.set(cacheKey, JSON.stringify(report), { EX: 300 });
  res.set('X-Cache', 'MISS');
  res.json(report);
});
```

Ключ — полный URL с query-параметрами. TTL — зависит от бизнеса: продажи за вчера можно кэшировать сутки, текущий день — минуты.

## Антипаттерны: чего не делать

1. **Кэшировать всё бездумно.** Каждый ключ — память и сложность инвалидации. Кэшируй только то, что реально тормозит.
2. **Игнорировать stampede.** TTL на популярный ключ без мьютекса — DDoS своей же БД.
3. **Кэшировать результаты мутаций.** POST/PUT/DELETE — не кэшируются. Если кэшируешь GET после POST — инвалидируй сразу.
4. **Хранить в кэше то, что нельзя потерять.** Redis — не БД. Данные, которые нельзя потерять, живут в PostgreSQL. Redis — ускоритель.
5. **Игнорировать сериализацию.** `JSON.stringify` на каждый запрос — CPU. Для горячих ключей — бинарные форматы (MessagePack, protobuf) или RedisJSON.

## Типичные ошибки и грабли

1. **TTL без джиттера.** Все ключи истекают одновременно — thundering herd. Добавляй ±10%.
2. **Mutex без finally.** Ошибка в обновлении — лок не снят, все ждут 10 секунд (пока не истечёт NX EX). Всегда `try/finally`.
3. **Инвалидация только через TTL.** Пользователь обновил профиль, видит старое 5 минут. Event-based инвалидация решает.
4. **Rate limiting на application level.** Один инстанс — ок. Десять инстансов — лимит умножается на 10. Только Redis или API Gateway.
5. **Ключи без namespace.** `user:1` от разных сервисов конфликтуют. Префикс: `app:user:1`, `app:sess:abc`.

## Вопросы на собеседовании

1. **Что такое cache stampede и как защититься?** Множество запросов на истёкший ключ одновременно. Мьютекс через `SET NX EX`, permValue (возврат stale + фоновое обновление), джиттер TTL.
2. **Разница write-through и write-behind?** Write-through: сразу в БД и кэш, консистентно, медленно. Write-behind: сначала в кэш, в БД асинхронно, быстро, но риск потери.
3. **Как работает token bucket?** Ведро на N токенов, пополняется rate/сек. Запрос берёт токен. Гладкий лимит без скачков. Атомарность через Lua.
4. **Зачем Lua для rate limiting?** Чтение-модификация-запись должны быть атомарны. Без Lua — race condition, лимит обходится.
5. **Как инвалидировать кэш при обновлении?** Publish событие, подписчики удаляют ключи. Или кэш-теги с обратной индексацией. TTL — fallback.
6. **Почему сессии в Redis, а не в памяти?** Переживает рестарт, общее состояние для всех реплик, TTL для автоочистки. Память процесса — локальна и эфемерна.

## Практика

1. Реализуй cache-aside для эндпоинта `/api/users/:id`. TTL 5 минут, джиттер ±10%, логирование hit/miss ratio.
2. Добавь mutex-защиту от stampede. Симулируй 10 параллельных запросов на истёкший ключ, убедись, что в БД пошёл один запрос.
3. Реализуй rate limiting token bucket на Lua-скрипте. Лимит: 100 запросов в минуту. Проверь границу: 99, 100, 101 запрос.
4. Переведи сессии из памяти Express в Redis. Проверь: рестарт backend не ломает сессию, две реплики видят одну сессию.
5. Добавь event-based инвалидацию: при обновлении пользователя публикуй `cache:invalidate`, подписчик удаляет ключ. Проверь, что изменения видны мгновенно.

## Что почитать

- [Redis Commands](https://redis.io/commands/)
- [Redis Lua Scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)
- [Cache-Aside Pattern (Microsoft)](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
- [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible)
- [Redis Best Practices: Keyspace](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/)
