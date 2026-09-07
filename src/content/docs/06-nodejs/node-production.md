---
title: "Node.js в продакшене"
description: "Эксплуатация Node-сервисов: graceful shutdown по SIGTERM/SIGINT, keep-alive и таймауты HTTP, логирование через pino, валидация конфигурации через Zod, healthchecks, метрики prom-client, утечки памяти и отладка через --inspect."
---

Код, который работает на ноутбуке, и сервис, который живёт в проде месяцами без вмешательства, — разные артефакты. Прод не прощает: деплой без graceful shutdown обрывает запросы посередине, отсутствие таймаутов превращает один медленный апстрим в исчерпанные сокеты, конфиг без валидации падает спустя час после старта, а память, утекающая по 10 МБ в сутки, добирается до OOM-киллера ровно в выходные. Эта глава — про то, что отделяет «запускается» от «эксплуатируется»: девять обязательных практик для любого Node-сервиса.

Всё измеримое здесь (логи, метрики, healthchecks) станет фундаментом для [главы про наблюдаемость](/12-iac-deploy-obs/logging-metrics/) и [Docker/Kubernetes](/10-linux-docker/docker-deep/): оркестратор именно так и управляет контейнерами — сигналами и эндпоинтами.

## Graceful shutdown: умирать красиво

Когда оркестратор останавливает под (деплой, скейлинг, eviction), он отправляет `SIGTERM` и ждёт `terminationGracePeriodSeconds` (в Kubernetes по умолчанию 30). Если процесс не завершился — `SIGKILL`. Задача graceful shutdown — успеть за это время:

1. Перестать принимать новые соединения (`server.close()`).
2. Дождаться завершения текущих запросов (с разумным дедлайном).
3. Закрыть пулы соединений (БД, Redis), флашнуть буферы, сказать оркестратору «готово».

```js
import http from 'node:http';

const server = http.createServer(app);
server.listen(3000);

let shuttingDown = false;
server.on('request', (req, res) => {
  if (shuttingDown) {
    res.writeHead(503, { 'connection': 'close' });
    return res.end('сервер останавливается');
  }
  // ... обычная обработка
});

async function shutdown(signal) {
  console.log(`получен ${signal}, начинаю shutdown`);
  shuttingDown = true;

  // 1. перестаём принимать новые соединения
  server.close();

  // 2. ждём текущие запросы, но не вечно
  const forceExit = setTimeout(() => {
    console.error('дедлайн shutdown истёк, выхожу принудительно');
    process.exit(1);
  }, 25_000);
  forceExit.unref();

  // 3. закрываем инфраструктуру
  await db.pool.end();
  await redis.quit();

  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

Детали, которые важны: `SIGTERM` — основной сигнал оркестраторов, `SIGINT` — Ctrl+C в ручном запуске (докер без `-it` шлёт тоже SIGTERM). `server.close()` не рвёт активные соединения — он перестаёт принимать новые и ждёт текущие. Обязательно дедлайн: «ждать вечно» хуже принудительного выхода, потому что `SIGKILL` придёт и без флаша буферов.

:::caution[PM2, nodemon и сигналы]
Процесс-менеджеры по-разному передают сигналы. nodemon по умолчанию шлёт SIGUSR2 и перезапускает — в проде его нет, но знать стоит. PM2 шлёт SIGINT и ждёт `kill_timeout`. В Docker без exec-формы (`CMD node server.js` через shell-форму) сигнал получает shell, а не node — и shutdown не сработает: всегда `CMD ["node", "server.js"]`.
:::

## Keep-alive и агенты HTTP

По умолчанию исходящие HTTP-запросы (`fetch`, `http.request`) используют глобальный агент с keep-alive выключенным — каждый запрос открывает новый TCP-сокет (и TLS-хендшейк). На высоких RPS это тысячи сокетов в TIME_WAIT и лишний RTT на каждый запрос.

```js
// для fetch (undici) — глобальный агент с лимитами
import { setGlobalDispatcher, Agent } from 'undici';

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,     // как долго держать простаивающий сокет
  keepAliveMaxTimeout: 600_000,
  connections: 100,             // лимит на хост — защита от фан-аута
}));
```

```js
// для node:http клиента
import http from 'node:http';

const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
http.get('http://api.internal/data', { agent }, ...);
```

Вторая сторона медали — **таймауты**. Сетевой вызов без таймаута может висеть бесконечно, съедая сокет и, в перспективе, все свободные. Три уровня таймаутов, которые настраиваются раздельно: connect (установка соединения), headers (до ответа), body (между чанками ответа).

```js
import { setTimeout as delay } from 'node:timers/promises';

async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
```

:::tip[Таймауты — контракт, а не настройка]
Таймаут клиента должен быть меньше таймаута сервера-вызываемого и больше p99 его latency. Иначе получишь лавину ретраев или, наоборот, вечные ожидания. В распределённых системах это часть контракта API (см. [паттерны устойчивости](/13-cloud-design-ai/system-design-patterns/)).
:::

## Логирование: pino и структурные логи

`console.log` в проде не работает: нет уровней, нет контекста, синхронная запись в stdout тормозит цикл под нагрузкой. Стандарт — **pino**: быстрый (сериализация в worker'е), структурный (JSON-строки), с уровнями и дочерними логгерами.

```js
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // в dev — красивый вывод, в проде — чистый JSON для сбора
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty' },
  base: { service: 'api', version: process.env.APP_VERSION },
  // redact: никогда не логируем секреты и токены
  redact: ['req.headers.authorization', '*.password', '*.token'],
});

// дочерний логгер с контекстом запроса — requestId живёт во всех строках
export function childLogger(req) {
  return logger.child({ requestId: req.id, userId: req.user?.id });
}

// в хендлере
log.info({ userId: 42, durationMs: 87 }, 'user created');
// → {"level":30,"time":...,"service":"api","requestId":"...","userId":42,"durationMs":87,"msg":"user created"}
```

Практики: один JSON-объект на строку (журнал копится в Loki/ELK и парсится автоматически), контекст через `child`, `requestId` прокидывается через все вызовы (пропагация трейсинга — в [главе про трейсинг](/12-iac-deploy-obs/tracing-alerting/)), `redact` обязателен — пароль в логах это инцидент безопасности.

## Конфигурация: env + Zod

Конфиг из переменных окружения — стандарт 12-factor. Без валидации опечатка в имени переменной всплывёт через час (`undefined` в порте БД) или никогда. Правило: **схема, валидация на старте, падение при ошибке**.

```js
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // секреты — минимальная длина, никаких дефолтов для них
  JWT_SECRET: z.string().min(32),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('невалидный конфиг:', parsed.error.flatten().fieldErrors);
  process.exit(1); // не стартуем с битым конфигом
}

export const config = parsed.data;
```

Плюсы: `z.coerce` приводит строки env к числам, ошибки собираются по всем полям разом, TypeScript выводит тип из схемы — конфиг типизирован. Дефолты допустимы для несекретного, секреты — только из env.

## Healthchecks: liveness против readiness

Оркестратору нужны два разных ответа:

- **Liveness** (`/healthz`): процесс жив, Event Loop крутится, не дедлокнут. Если не отвечает — перезапуск.
- **Readiness** (`/readyz`): сервис готов принимать трафик — БД доступна, миграции применены, критичные зависимости отвечают. Если не отвечает — трафик не подаётся, но процесс жив.

```js
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/readyz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});
```

Частая ошибка — пихать проверки БД в liveness: кратковременная проблема с БД перезапустит все поды одновременно, усугубив инцидент (thundering herd). Liveness должен быть дешёвым и локальным.

## Метрики: prom-client

Prometheus-метрики — это не логи: агрегированные числа, по которым строятся дашборды и алерты. Минимальный набор для HTTP-сервиса: RPS, latency-гистограмма, event loop lag, память, счётчики ошибок.

```js
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register }); // cpu, memory, event loop lag и пр.

// гистограмма latency HTTP-запросов
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// middleware: замеряем каждый запрос
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route?.path || 'unknown', status: res.statusCode });
  });
  next();
});

// endpoint для сбора (Prometheus ходит сюда scrape'ом)
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

Обрати внимание на `collectDefaultMetrics` — там уже есть event loop lag из `perf_hooks.monitorEventLoopDelay()` (мы разбирали его в [главе про Event Loop](/06-nodejs/event-loop-node/)): сразу получаешь p50/p99 лага в метриках `nodejs_eventloop_lag_*`. По гистограмме HTTP-запросов Prometheus считает quantile'ы через `histogram_quantile`.

:::tip[Метрики против логов]
Метрики — для «что происходит со всеми запросами» (алерты, тренды), логи — для «что произошло с этим запросом» (расследование). Классическая связка: метрика показала рост 5xx → логи по requestId → причина. Дорожная карта полного стека — в разделе про [трейсинг](/12-iac-deploy-obs/tracing-alerting/).
:::

## Утечки памяти в долгоживущих процессах

Node-сервисы живут неделями, и утечки здесь болезненнее, чем в браузере: страницу перезагрузили, а процесс копит heap до OOM. Типовые источники:

1. **Растущие Map/Set/массивы** — кэш без вытеснения (максимум размера, TTL, LRU).
2. **Слушатели событий** — `emitter.on(...)` в цикле без `off()`; EventEmitter с >10 слушателями кричит `MaxListenersExceededWarning`.
3. **Замыкания, держащие большие объекты** — callback в таймере/очереди, ссылающийся на весь ответ целиком.
4. **Unbounded буферы стримов** — см. [главу про backpressure](/06-nodejs/streams-backpressure/): игнор `write() === false` = утечка.

Диагностика: `--max-old-space-size` задаёт лимит (дефолт ~2 ГБ на 64-бит) — OOM до лимита означает внешнюю память или нативные структуры; `process.memoryUsage()` в метрики (рост `heapUsed` при плоском RPS = утечка); снапшоты heap.

```js
// периодический снапшот heap по расписанию или по триггеру
import v8 from 'node:v8';
import { writeFileSync } from 'node:fs';

if (process.env.HEAP_SNAPSHOT === '1') {
  setInterval(() => {
    const snapshot = v8.getHeapSnapshot();
    const path = `/tmp/heap-${Date.now()}.heapsnapshot`;
    writeFileSync(path, snapshot);
    console.log('heap snapshot:', path);
  }, 6 * 60 * 60 * 1000).unref();
}
```

Снапшоты открываются в Chrome DevTools (Memory → Load) — там видно, какие объекты занимают место и кто их держит (retainers). Сравнение двух снапшотов через сутки сразу показывает растущие типы объектов.

## Отладка: --inspect

Node поддерживает протокол Chrome DevTools. Запуск с `--inspect` (или `--inspect-brk` — остановиться на первой строке):

```bash
node --inspect=0.0.0.0:9229 server.js
# открой в Chrome: chrome://inspect → Remote Target → inspect
```

В проде точечно: `--inspect` открывает порт отладки (в Docker пробрось 9229, в k8s — `kubectl port-forward`), DevTools покажет heap, CPU-профили, точки останова. Осторожно: порт отладки без авторизации — дыра; биндить на localhost и ходить через port-forward/tunnel. Для продовых инцидентов лучше способ: `kill -USR2 <pid>` с `inspector`-модулем программно или снапшоты heap (выше) — они не останавливают процесс.

Также полезно знать: `node --prof` (устаревает), `node --cpu-prof` — CPU-профиль в файл без DevTools, и диагностический репорт `process.report.writeReport()` при краше (покажет стек, память, ресурсы ОС на момент падения).

## Типичные ошибки и грабли

1. **Нет graceful shutdown или shutdown без дедлайна.** Первое — обрыв запросов при каждом деплое; второе — под висит до SIGKILL 30 секунд, деплой растягивается. Всегда оба: `server.close()` + форс-выход.
2. **Shell-форма CMD в Dockerfile.** `CMD node server.js` → сигналы до node не доходят, shutdown мёртв. Используй exec-форму `CMD ["node", "server.js"]`.
3. **Исходящие запросы без таймаутов.** Один зависший апстрим → исчерпание сокетов → сервис не может делать исходящие вызовы вообще. Всегда AbortController-таймаут на каждый вызов.
4. **Keep-alive не настроен** (дефолт fetch) → TIME_WAIT-флуд и лишний RTT. Глобальный агент с `keepAlive` — первое, что настраивают в любом сервисе с исходящими вызовами.
5. **БД-проверка в liveness.** Кратковременный сбой БД → все поды перезапускаются одновременно → каскад. Liveness — локальный, readiness — с зависимостями.
6. **Секреты в логах.** Отладочный `log.debug(req.headers)` — и токен авторизации в ELK навсегда. `redact` в pino и дисциплина: логируй идентификаторы, не значения.
7. **Конфиг читается в модулях на этапе импорта без валидации.** Опечатка `DATBASE_URL` всплывёт при первом запросе к БД. Валидация Zod на старте — падай сразу и громко.
8. **`process.exit()` без cleanup в тестах/скриптах.** Открытые handle'ы (таймеры, сокеты) молча рвутся. В скриптах — `unref()` служебных таймеров; в сервисах — централизованный shutdown.

## Вопросы на собеседовании

1. **Что должно происходить в graceful shutdown?** Перестать принимать новые соединения (`server.close()`), дождаться текущих запросов с дедлайном, закрыть пулы БД/Redis, сфлашнуть буферы, выйти. Обязателен форс-выход по таймауту — оркестратор всё равно убьёт через terminationGracePeriod.
2. **Чем liveness отличается от readiness?** Liveness: процесс жив и не дедлокнут — при провале перезапуск. Readiness: сервис готов к трафику (БД, миграции) — при провале трафик снимается, процесс жив. Проверки зависимостей — только в readiness.
3. **Зачем pino вместо console.log?** Структурный JSON с уровнями и контекстом, асинхронная сериализация (не блокирует цикл), redact секретов, дочерние логгеры с requestId. console.log — синхронный, без уровней, не машиночитаем.
4. **Как валидировать конфигурацию?** Схема (Zod) + safeParse на старте: невалидный конфиг → подробные ошибки всех полей → exit(1). Секреты — без дефолтов, только env. Тип TS выводится из схемы.
5. **Как искать утечку памяти в Node?** Метрики `heapUsed` (рост при плоском RPS), снапшоты `v8.getHeapSnapshot()` в Chrome DevTools сравнением двух точек во времени. Частые виновники: бесконечные Map/Set, слушатели без off, замыкания на большие объекты.
6. **Как безопасно отлаживать прод-процесс?** `--inspect` через port-forward (порт не публиковать), или снапшоты heap без остановки, или `node --cpu-prof` для CPU-профиля. Никогда не открывать 9229 наружу.
7. **Почему исходящие HTTP-вызовы без таймаута опасны?** Зависший вызов держит сокет бесконечно; множество таких вызовов исчерпывает пул соединений и файловые дескрипторы → сервис перестаёт делать вызовы вообще. Таймаут + лимиты агента обязательны.
8. **Что такое event loop lag и как его алертить?** Задержка между планируемым и фактическим выполнением таймера; измеряется `perf_hooks.monitorEventLoopDelay()`, экспортируется prom-client'ом (`nodejs_eventloop_lag_p99`). Алерт на устойчивый рост p99 (например, > 100 мс).

## Практика

1. **Shutdown под наблюдением.** HTTP-сервис с endpoint'ом, который работает 10 секунд. Запусти, начни запрос, отправь SIGTERM. Убедись: запрос завершился штатно, новые получают 503, процесс вышел до дедлайна. Повтори с shell-формой CMD в Docker — убедись, что сигнал не доходит (и исправь).
2. **Таймауты и ретраи.** Сервис с endpoint'ом `/proxy`, который зовёт апстрим с таймаутом 2 секунды и одним ретраем с экспоненциальной задержкой. Эмулируй апстрим, который спит 30 секунд: докажи, что твой сервис остаётся отзывчивым и не копит сокеты (`netstat`/`ss` в помощь).
3. **Полный обсервабилити-контур.** Добавь в pet-проект: pino с requestId и redact, Zod-валидацию конфига, `/healthz` + `/readyz`, prom-client с default-метриками и гистограммой HTTP-latency. Подними локальный Prometheus (docker) и собери метрики scrape'ом. Построй график `nodejs_eventloop_lag_p99`.
4. **Утечка по расписанию.** Намеренно создай утечку: модульный кэш `Map`, куда с каждым запросом пишется объект, без вытеснения. Прогони `autocannon` на 5 минут, сними два heap-снапшота (старт и конец), открой в DevTools и найди растущий тип. Потом замени на `lru-cache` с лимитом и убедись, что heap плато.
5. **CPU-профиль горячего места.** Endpoint с синтетически тяжёлой функцией. Запусти `node --cpu-prof server.js`, нагрузи endpoint, останови сервер, открой `*.cpuprofile` в DevTools → вкладка Performance. Найди функцию в топе и оптимизируй (подсказка: чаще всего это JSON.parse большого объекта или регулярка).

## Что почитать

- [Graceful shutdown в Node.js — официальный гайд](https://nodejs.org/en/learn/modules/dont-block-the-event-loop) — вместе с разбором блокировок цикла.
- [pino — документация](https://getpino.io/) — уровни, redact, transports, сериализация.
- [Zod — документация](https://zod.dev/) — схемы, coerce, вывод типов.
- [prom-client](https://github.com/siimon/prom-client) — метрики Prometheus для Node.js.
- [Kubernetes: Liveness and Readiness probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — как оркестратор использует healthchecks.
- [Node.js debugging — официальный гайд](https://nodejs.org/en/learn/getting-started/debugging) — --inspect, inspector, профилирование.
- [undici Agent](https://undici.nodejs.org/#/docs/api/Agent) — настройка исходящих соединений для fetch.
