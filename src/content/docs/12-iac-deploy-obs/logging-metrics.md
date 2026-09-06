---
title: "Наблюдаемость: логирование и метрики"
description: "Структурированные JSON-логи на pino с request_id, Loki-стек с Promtail и LogQL, Grafana-дашборды, ELK как альтернатива, Prometheus-скрейпинг и практический PromQL."
---

Приложение, которое ты не видишь изнутри, — чёрный ящик. Оно может работать идеально неделями, а потом уронить запрос на десятую секунду, и ты узнаешь об этом из твита разозлённого пользователя. Наблюдаемость превращает чёрный ящик в стеклянный: по трём сигналам — логам, метрикам и трейсам (третий — в следующей главе) — ты отвечаешь на вопросы «что случилось», «насколько плохо» и «где именно». В этой главе разберём первые два столпа до уровня, когда диагностика инцидента занимает минуты, а не часы грепа по SSH.

Начнём с логов: почему текстовые строки «INFO User logged in» — мёртвый формат, и как структурированный JSON превращает лог в запрашиваемую базу данных. Поднимем Loki-стек для агрегации и научимся писать LogQL-запросы. Затем метрики: как Prometheus собирает time-series, чем Node Exporter отличается от cAdvisor, как экспонировать собственные метрики из Node.js через prom-client и как читать PromQL — `rate`, `increase`, `histogram_quantile` — без магии.

## Три столпа наблюдаемости

| Столп | Отвечает на вопрос | Примеры | Инструменты |
|---|---|---|---|
| **Логи** | Что случилось? | «Оплата #4821 не прошла: timeout upstream» | pino → Loki/ELK |
| **Метрики** | Насколько плохо и как меняется? | «Доля 5xx выросла с 0.1% до 2% за 10 минут» | Prometheus + exporters |
| **Трейсы** | Где именно по цепочке? | «650 из 800 мс запроса — SELECT без индекса» | OpenTelemetry → Jaeger |

Столпы усиливают друг друга: метрика показывает скачок, лог даёт контекст события, трейс — точное место. Без склейки (`request_id`/`trace_id` в каждом сигнале) расследование превращается в археологию.

## Логи: структура вместо текста

Текстовый лог непарсим машиной: `User 1234 logged in from 1.2.3.4` — чтобы найти все логины пользователя, нужен regex, который ломается на первом изменении формата. Структурированный JSON — самоописываемый:

```text
{"ts":"2026-09-06T12:04:11Z","level":"error","msg":"payment failed","request_id":"a1b2c3d4","user_id":4821,"duration_ms":231,"error":"timeout upstream","service":"pet-api"}
```

Правила хорошего лога: одно событие — одна строка JSON, `request_id` на каждый запрос для склейки цепочки, уровни по делу, избыточные поля лучше недостающих.

### pino: самый быстрый JSON-логгер для Node.js

```ts
// logger.ts — конфигурация через переменные окружения
import { pino } from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",   // debug в dev, info в prod
  base: { service: "pet-api", env: process.env.NODE_ENV },  // в каждую строку
  timestamp: pino.stdTimeFunctions.isoTime,                  // ISO 8601
  formatters: {
    level: (label) => ({ level: label }),    // level: "info" вместо level: 30
  },
});
```

```ts
// app.ts — request_id на каждый запрос через дочерний логгер
import { randomUUID } from "node:crypto";
import { log } from "./logger";

app.use((req, res, next) => {
  req.log = log.child({ request_id: randomUUID() });
  req.log.info({ method: req.method, url: req.url }, "incoming request");
  next();
});

// В обработчиках — лог с контекстом запроса
app.post("/api/payments", async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const result = await processPayment(userId, amount);
    req.log.info({ user_id: userId, amount, duration_ms: result.ms }, "payment ok");
    res.json(result);
  } catch (err) {
    req.log.error({ user_id: userId, err: err.message }, "payment failed");
    res.status(502).json({ error: "payment failed" });
  }
});
```

Pino на порядок быстрее winston/console.log: запись в stdout через потоки без блокировки event loop. Логи идут в stdout → Docker перехватывает → файлы `/var/lib/docker/containers/*/*.log` → Promtail забирает. Это 12-факторный путь: приложение не знает, куда пишет файлы, лог-сборщик решает сам.

### Уровни и сэмплирование

Уровни — контракт: `debug` (только локально), `info` (значимые события: запрос, деплой, старт), `warn` (неожиданное, но система работает: retry, fallback), `error` (операция не выполнена: timeout, 500). В prod `LOG_LEVEL=info` — debug-логи съедают диск и CPU на парсинг.

Когда `info` слишком много (10k RPS с логом на каждый запрос) — **сэмплирование**: логируем долю успешных запросов, ошибки — всегда:

```ts
// Сэмплирование 10% успешных запросов, 100% ошибок
app.use((req, res, next) => {
  req.shouldLog = Math.random() < 0.1 || req.path.startsWith("/api/");
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (!req.shouldLog && res.statusCode < 400) return;   // пропускаем 90% успешных
    req.log.info(
      { method: req.method, url: req.url, status: res.statusCode, duration_ms: Date.now() - start },
      "request completed",
    );
  });
  next();
});
```

Сэмплирование — компромисс: теряем точность (90% запросов не видим), но сохраняем диск и возможность агрегации. Для highload — стандарт, для pet-проекта — избыточно.

## Loki-стек: агрегация и LogQL

Сырой stdout контейнера — не хранилище. Loki (Grafana Labs) забирает логи и индексирует **только метки** (labels), не содержимое: дешевле ELK на порядок, родной выбор для Grafana-стека.

```yaml
# docker-compose.yml — стек наблюдаемости
services:
  loki:
    image: grafana/loki:3
    command: -config.file=/etc/loki/loki.yml
    volumes:
      - ./loki.yml:/etc/loki/loki.yml:ro
      - loki-data:/loki

  promtail:
    image: grafana/promtail:3
    volumes:
      - /var/lib/docker/containers:/var/lib/docker/containers:ro   # логи контейнеров
      - /var/run/docker.sock:/var/run/docker.sock:ro               # service discovery
      - ./promtail.yml:/etc/promtail/config.yml:ro
    command: -config.file=/etc/promtail/config.yml

  grafana:
    image: grafana/grafana:11
    ports: ["3000:3000"]
    volumes: [grafana-data:/var/lib/grafana]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD}

volumes:
  loki-data:
  grafana-data:
```

```yaml
# promtail.yml — скрейпинг docker-логов с маппингом меток
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml      # смещение в файлах — не читать заново

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: ["__meta_docker_container_name"]
        target_label: container
      - source_labels: ["__meta_docker_container_log_stream"]
        target_label: stream           # stdout / stderr
      - source_labels: ["__meta_docker_container_label_com_docker_compose_service"]
        target_label: service          # метка из compose service
```

Promtail читает JSON-логи Docker'а, парсит каждую строку (pipeline stages) и шлёт в Loki. Ключевая концепция — **метки**: `{container="/pet-app", service="pet-api"}`. Меток мало, значения дискретны (не уникальные ID!) — иначе Loki превратится в медленный grep.

### LogQL: язык запросов

LogQL-запрос = селектор меток + фильтр/агрегация:

```text
# Все логи контейнера приложения
{container="/pet-app"}

# Только ошибки (фильтр по подстроке)
{container="/pet-app"} |= "level":"error"

# Regex: ошибки и warning'и
{container="/pet-app"} |~ "level\":\"(error|warn)\""

# Извлечь поля из JSON и отфильтровать по ним
{container="/pet-app"} | json | duration_ms > 500

# Агрегация: rate ошибок за 5 минут
sum(rate({container="/pet-app"} |= "error" [5m])) by (service)

# Подсчёт логинов по user_id за час
sum(count_over_time({container="/pet-app"} |= "login ok" | json [1h])) by (user_id)
```

В Grafana: Explore → Loki → вводишь запрос → видишь строки, график по времени. Скорость: селектор меток отсекает 99% данных, фильтры работают по оставшемуся.

:::tip[Цена логов]
Debug-логи в prod выключены (`LOG_LEVEL=info`), retention в Loki 7-14 дней. Иначе диск съеден за неделю. Для долгосрочного хранения — экспорт агрегатов в S3 (ошибки за год), сырые логи недолговечны.
:::

:::tip[Сначала метки, потом фильтры]
Loki ищет по селектору меток за миллисекунды, а фильтры `|=` и `|~` сканируют содержимое уже найденного. Запрос `{container="/pet-app"} |= "error"` работает за секунду на гигабайтах логов, а поиск той же строки без селектора меток — полный scan всего хранилища. Правило: сужай метками до нужного сервиса/контейнера, содержимое фильтруй внутри.
:::

### Grafana-дашборд логов

Grafana подключается к Loki как datasource. Типичная панель для приложения:

1. **Time series**: rate ошибок `sum(rate({service="pet-api"} |= "error" [5m]))` — видишь всплески.
2. **Logs panel**: `{service="pet-api"} | json | level="error"` — сами строки с подсветкой.
3. **Stats**: топ эндпоинтов по количеству 5xx — `sum by (url) (count_over_time({service="pet-api"} | json | status >= 500 [1h]))`.

Дашборд сохраняется JSON'ом, версионируется в git рядом с конфигами (`grafana/dashboards/pet-logs.json`), подключается provisioning'ом — не руками в UI.

### ELK как альтернатива

ELK (Elasticsearch + Logstash + Kibana) — классический стек: Logstash парсит, Elasticsearch индексирует **полное содержимое** (полнотекст), Kibana визуализирует. Мощнее Loki на сложном поиске («найди все запросы с телом, содержащим X»), но тяжелее: Elasticsearch жрёт RAM (heap от 4GB), требует шардирования при росте, эксплуатация — отдельная профессия. Выбор простой: Loki по умолчанию, ELK когда нужен полнотекст по сырым логам или когда экосистема уже на Elasticsearch (другие системы пишут туда).

## Метрики: Prometheus-архитектура

Prometheus — time-series БД: приложения и экспортеры отдают метрики на `/metrics`, Prometheus опрашивает (scrape) по расписанию и хранит. Модель pull (а не push, как у многих) — Prometheus сам решает, кого опрашивать: не нужны агенты на каждом хосте, детекция недоступности цели из коробки (`up{job="x"} == 0`).

### Типы метрик

- **Counter** — только растёт (запросы, ошибки, байты). `http_requests_total 48213`.
- **Gauge** — растёт и падает (температура, соединения, память). `node_memory_MemAvailable_bytes 3.2e9`.
- **Histogram** — распределение значений по бакетам (латентность, размер ответа). `http_request_duration_seconds_bucket{le="0.1"} 39123`.
- **Summary** — как histogram, но с квантилями на стороне клиента. Редко, предпочитай histogram.

### Scrape-конфиги

```yaml
# prometheus.yml
global:
  scrape_interval: 15s          # как часто опрашивать
  evaluation_interval: 15s      # как часто проверять alert-правила

scrape_configs:
  - job_name: node              # железо и ОС VPS
    static_configs:
      - targets: ["node-exporter:9100"]

  - job_name: cadvisor          # метрики контейнеров Docker
    static_configs:
      - targets: ["cadvisor:8080"]

  - job_name: nginx             # stub_status через exporter
    static_configs:
      - targets: ["nginx-exporter:9113"]

  - job_name: app               # свои метрики приложения
    static_configs:
      - targets: ["pet-app:3000"]
    scrape_interval: 10s
    metrics_path: /metrics
```

Экспортеры — sidecar-процессы, отдающие метрики:

- **Node Exporter** (`:9100`): CPU, память, диск, сеть, load average хоста. Ставится на каждую VM.
- **cAdvisor** (`:8080`): per-container метрики — CPU, RSS, сеть, I/O по каждому контейнеру Docker. Единственный способ увидеть, кто из контейнеров жрёт память.
- **nginx-prometheus-exporter**: парсит `stub_status` Nginx → активные соединения, запросы/с.

```bash
docker run -d --name node-exporter --net=obs \
  --pid="host" -v "/:/host:ro,rslave" \
  prom/node-exporter --path.rootfs=/host

docker run -d --name cadvisor --net=obs \
  -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro \
  -v /var/lib/docker/:/var/lib/docker:ro \
  gcr.io/cadvisor/cadvisor:latest
```

### Приложение: prom-client

Свои метрики из Node.js — библиотекой `prom-client`:

```ts
// metrics.ts
import client from "prom-client";

export const register = new client.Registry();
client.collectDefaultMetrics({ register });   // event loop lag, heap, GC

// Счётчик запросов по эндпоинту и статусу
export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Количество HTTP-запросов",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

// Гистограмма латентности — основа для RED-метрик
export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Длительность HTTP-запросов",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],   // бакеты в секундах
  registers: [register],
});
```

```ts
// app.ts — middleware, собирающее метрики
import { register, httpRequestsTotal, httpDuration } from "./metrics";

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ?? req.path;        // /api/users/:id, а не /api/users/123
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpDuration.observe({ method: req.method, route, status: res.statusCode }, duration);
  });
  next();
});

app.get("/metrics", async (req, res) => {            // Prometheus ходит сюда
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
});
```

Важно: метка `route` — шаблон пути (`/api/users/:id`), не реальный URL с ID. Иначе cardinality взорвётся: каждый уникальный URL = новая временная серия, Prometheus захлёбывается через час.

:::caution[Cardinality — главный убийца Prometheus]
Каждая уникальная комбинация меток = отдельная временная серия в памяти. Правило: метки с бесконечным доменом значений (user_id, request_id, url с параметрами) — в логи, не в метрики. Оставляй в метках то, что группируется: route, method, status, instance, job.
:::

### PromQL-практика

PromQL — язык запросов к time-series. Три функции закрывают 90% задач:

**`rate()` — скорость изменения counter'а.** Всегда используй с `[Xm]`-окном:

```text
# Запросов в секунду за 5 минут
sum(rate(http_requests_total[5m]))

# Ошибок в секунду (только 5xx)
sum(rate(http_requests_total{status=~"5.."}[5m]))

# Доля ошибок: ошибки / все запросы
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))
```

**`increase()` — абсолютный прирост counter'а за окно:**

```text
# Сколько ошибок было за последний час
increase(http_requests_total{status=~"5.."}[1h])

# Сколько запросов обработал каждый инстанс за сутки
sum by (instance) (increase(http_requests_total[24h]))
```

**`histogram_quantile()` — квантиль по бакетам гистограммы:**

```text
# P95 латентности за 5 минут
histogram_quantile(
  0.95,
  sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
)

# P50 (медиана) по конкретному эндпоинту
histogram_quantile(
  0.5,
  sum by (le) (rate(http_request_duration_seconds_bucket{route="/api/payments"}[5m]))
)
```

Механика: гистограмма хранит счётчики попаданий в бакеты (`le` = less or equal). `histogram_quantile` интерполирует квантиль между бакетами. Важно: квантиль считается по агрегированным данным — `sum by (le)` объединяет бакеты всех инстансов. Ошибка новичка: считать квантиль по каждому инстансу отдельно и усреднять — результат будет занижен.

### Метод RED: на что смотреть

Сто метрик парализуют. Для каждого HTTP-сервиса хватит трёх (RED — Rate, Errors, Duration):

| Метрика | PromQL | Вопрос |
|---|---|---|
| Rate | `sum(rate(http_requests_total[5m]))` | Сколько запросов/с? База для сравнения при инцидентах |
| Errors | `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` | Доля 5xx. Порог алерта: > 1% за 5 минут |
| Duration | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` | P95 латентности. Рост в 2× от базовой линии — сигнал |

Базовая линия — твой ориентир: записывай нормальные значения RED на неделю, получишь пороги из жизни системы, а не из головы. «P95 вырос с 120 до 400 мс» — действуем; «P95 > 500 мс» в вакууме — нет.

Дашборд в Grafana: три панели RED + панели node-exporter (CPU, RAM, диск). Этого достаточно для диагностики 90% инцидентов pet-проекта.

## Типичные ошибки и грабли

1. **Текстовые логи без структуры.** `grep "error"` по 10 ГБ логов — часы вместо секунд, regex ломается при изменении формата. Хорошо: JSON с первого дня, pino/winston с фиксированной схемой полей.
2. **Уникальные значения в метках Prometheus.** `http_requests_total{url="/users/123"}` — каждый пользователь новая серия, через час Prometheus OOM. Хорошо: `route` с параметризованным путем, user_id/request_id — только в логи.
3. **`rate()` без окна или на gauge.** `rate(node_memory_MemAvailable_bytes[5m])` — бессмыслица: rate только для counter'ов. Хорошо: `rate` для counter'ов, `deriv`/`delta` для gauge, всегда с `[Xm]`.
4. **`LOG_LEVEL=debug` в prod.** Диск съеден за неделю, лог-агент захлёбывается, полезные логи утонули. Хорошо: `info` в prod, `debug` включается точечно и временно при диагностике.
5. **Promtail без `positions`.** Перезапуск Promtail — чтение всех логов с начала: дубли в Loki, нагрузка на диск. Хорошо: `positions.filename` — Promtail помнит смещение и продолжает с места остановки.
6. **Метрики без `route`-маппинга.** Middleware считает метрики по `req.path` вместо `req.route?.path` — cardinality-взрыв (п.2 в другой одежде). Хорошо: параметризованный роут из роутера Express/Fastify.
7. **ELK «на всякий случай».** Elasticsearch на VPS с 4 ГБ RAM — тормоза и OOM вместо наблюдаемости. Хорошо: Loki для старта, ELK только при реальной потребности в полнотексте и ресурсах под него.

## Вопросы на собеседовании

1. **Почему структурированные логи лучше текстовых?** JSON самоописываем: поля парсятся без regex, типизированы (duration_ms — число), фильтруются и агрегируются в Loki/ELK запросами. Текстовый лог требует regex, ломается при смене формата, не даёт агрегаций «по полю» без парсинга.
2. **Чем Loki отличается от ELK архитектурно?** Loki индексирует только метки (labels), содержимое хранит сырым и фильтрует на чтение: дёшево, просто, но медленный сложный полнотекст. Elasticsearch индексирует всё содержимое инвертированным индексом: мощный поиск, но тяжёлая эксплуатация (RAM, шарды, кластер).
3. **Когда использовать counter, gauge, histogram?** Counter — монотонно растущие события (запросы, ошибки). Gauge — значения, меняющиеся в обе стороны (память, соединения). Histogram — распределения (латентность, размер): считает бакеты и сумму, откуда `histogram_quantile`.
4. **Что делает `histogram_quantile` и почему нельзя усреднять квантили?** Интерполирует квантиль между бакетами агрегированной гистограммы. Усреднение квантилей по инстансам некорректно: P95 инстанса A и P95 инстанса B не дают общий P95 (скрывают выбросы на одном инстансе). Правильно: `sum by (le)` бакетов, затем один `histogram_quantile`.
5. **Почему Prometheus — pull, а не push?** Pull-модель: Prometheus сам опрашивает цели — упавшая цель видна из коробки (`up == 0`), конфигурация целей централизована, не нужны агенты с буфером. Push требует агента с локальной очередью и отдельного механизма детекции недоступности.
6. **Что такое cardinality и почему это проблема?** Число уникальных комбинаций меток. Каждая комбинация — серия в памяти Prometheus (метки + чанки сэмплов). High cardinality (user_id, request_id в метках) взрывает память и замедляет запросы. Правило: метки с конечным множеством значений (route, status), неограниченные — в логи.
7. **Как работает сэмплирование логов и когда его применять?** Логируется фракция событий (например, 10% успешных запросов), ошибки — всегда. Применять при высоком RPS, когда полные логи непомерно дороги. Инструменты: хвостовое сэмплирование в OTel Collector (решение после завершения запроса: логировать, если ошибка), вероятностное — в приложении.
8. **Метод RED: что это и почему именно эти три?** Rate (запросы/с), Errors (доля ошибок), Duration (латентность P95). Это минимальный полный набор для HTTP-сервиса: нагрузка, корректность, скорость. Покрывает симптомы большинства инцидентов без паралича от сотни метрик.

## Практика

1. Переведи логирование pet-проекта на pino: JSON, `request_id` на каждый запрос, `level` из env. Подними Loki + Promtail + Grafana через compose. Найди через LogQL все `error` за сутки и построй time series их rate за 5 минут.
2. Настрой Promtail с `positions` и метками `container`/`service` из Docker-метаданных. Перезапусти Promtail и убедись, что логи не продублировались (смещение сохранилось).
3. Подними Node Exporter и cAdvisor, подключи к Prometheus. Собери Grafana-дашборд: CPU, RAM, диск хоста + CPU/RSS по каждому контейнеру. Найди самый прожорливый контейнер.
4. Добавь `/metrics` в приложение через prom-client: counter запросов, гистограмма латентности с меткой `route` (параметризованный путь!). Построй график P95 по эндпоинтам в Grafana и убедись, что cardinality разумная (`count by (route) (http_requests_total)` < 50).
5. Реализуй сэмплирование логов: 10% успешных запросов, 100% ошибок и все 5xx. Замерь размер логов за час до и после (нагрузка через `hey`).
6. Напиши 5 PromQL-запросов для RED pet-проекта: rate запросов, доля 5xx, P95, P50, запросы в сутки по эндпоинтам. Сохрани их в Grafana как дашборд и экспортируй JSON в git.

## Что почитать

- [Grafana Loki](https://grafana.com/docs/loki/latest/) — архитектура, LogQL, retention
- [Promtail configuration](https://grafana.com/docs/loki/latest/send-data/promtail/) — pipeline stages, relabeling
- [Prometheus — getting started](https://prometheus.io/docs/prometheus/latest/getting_started/) и [Querying basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [prom-client](https://github.com/siimon/prom-client) — метрики для Node.js
- [Google SRE Book — Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) — RED, базовые линии, алертинг-философия
- [ELK Stack vs Loki](https://grafana.com/docs/loki/latest/get-started/compare/) — честное сравнение
