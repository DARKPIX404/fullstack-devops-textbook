---
title: "Трейсинг и алертинг: OpenTelemetry, SLO и on-call"
description: "Распределённый трейсинг на OpenTelemetry: trace/span, propagation, Jaeger, инструментация Node.js. Алертинг: Alertmanager, правила Prometheus, SLI/SLO, error budget и on-call ротация."
---

Логи отвечают «что случилось», метрики — «насколько плохо». Но есть вопрос, на который не отвечает ни один из них: «где именно по цепочке сервисов потерялись 800 миллисекунд?». Запрос прошёл через Nginx, Node.js, очередь, воркер, PostgreSQL — и каждый компонент честно отрапортовал «всё ок, я работал». Только трейсинг показывает цепочку как единое целое: 50 мс в Nginx, 80 в API, 650 в `SELECT` без индекса.

В этой главе разберём третий столп наблюдаемости — распределённый трейсинг на OpenTelemetry: концепции trace и span, распространение контекста через HTTP-заголовки, развёртывание Jaeger и инструментацию Node.js-приложения. Научимся связывать трейсы с логами через `trace_id` — когда по одному идентификатору из алерта ты за секунду видишь и метрику, и лог, и «водопад» спанов. А затем перейдём к алертингу как инженерной дисциплине: Alertmanager с маршрутизацией и подавлением шума, полные примеры правил Prometheus, SLI/SLO с error budget и основы on-call ротации.

## Трейсинг: концепции OpenTelemetry

### Trace, span, контекст

- **Trace** — полный путь одного запроса через систему. Состоит из деревьев спанов.
- **Span** — одна операция с началом, длительностью, статусом и атрибутами. HTTP-запрос к API — span; SQL-запрос внутри него — дочерний span; DNS-резолвинг — ещё один.
- **Context propagation** — механизм передачи идентификатора трейса между сервисами. HTTP-клиент добавляет заголовки `traceparent: 00-<trace-id>-<span-id>-01`, следующий сервис читает их и продолжает трейс вместо начала нового.

```text
Trace a1b2c3d4e5f6... (запрос GET /api/orders)
├── Span: nginx → 12 ms
├── Span: express middleware → 3 ms
├── Span: GET /api/orders handler → 800 ms
│   ├── Span: authenticate (JWT verify) → 15 ms
│   ├── Span: SELECT orders (PostgreSQL) → 650 ms   ← вот оно
│   └── Span: serialize response → 20 ms
└── Span: send response → 5 ms
```

Ключевое свойство: трейс собирается **автоматически** из инструментированных компонентов. Разработчик не пишет «начать трейс здесь, закончить там» для каждого вызова — SDK делает это за него через автоматическую инструментацию HTTP-клиентов, фреймворков и драйверов БД.

### Развёртывание Jaeger

Jaeger — система хранения и визуализации трейсов от Uber. Архитектура: приложения шлют спаны OTLP-коллектору, Jaeger хранит их в БД (для pet-проекта — in-memory или Badger, для продакшена — Elasticsearch/ClickHouse) и показывает в UI.

```yaml
# docker-compose.yml — Jaeger all-in-one для pet-проекта
services:
  jaeger:
    image: jaegertracing/all-in-one:1.60
    ports:
      - "16686:16686"        # UI
      - "4318:4318"          # OTLP HTTP (приём спанов)
    environment:
      COLLECTOR_OTLP_ENABLED: true
      SPAN_STORAGE_TYPE: badger   # badger = локальное хранилище на диске
      BADGER_EPHEMERAL: false
      BADGER_DIRECTORY_VALUE: /badger/data
      BADGER_DIRECTORY_KEY: /badger/key
    volumes: [jaeger-data:/badger]

volumes:
  jaeger-data:
```

Открой `http://localhost:16686` — UI Jaeger: выбор сервиса, поиск по trace_id, «водопад» спанов. All-in-one годится для pet-проекта; при росте нагрузки переезжай на коллектор + отдельное хранилище.

### Инструментация Node.js

OpenTelemetry SDK для Node.js: автоматическая инструментация Express, HTTP-клиента, PostgreSQL через `pg`, плюс ручные спаны для бизнес-операций.

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
            @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
            @opentelemetry/semantic-conventions
```

```ts
// tracing.ts — инициализация при старте приложения (первый импорт!)
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "pet-api",           // имя сервиса в Jaeger
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT   // http://jaeger:4318/v1/traces
                                                     // или http://localhost:4318/v1/traces
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
// Graceful shutdown: при SIGTERM — sdk.shutdown(), чтобы успели уйти последние спаны
```

```ts
// index.ts — ПЕРВАЯ строка: трассировка до любого другого импорта
import "./tracing";
import express from "express";
// ... остальной код

// Ручной спан для бизнес-операции (внутри автоматических спанов HTTP)
import { trace } from "@opentelemetry/api";

app.post("/api/payments", async (req, res) => {
  const tracer = trace.getTracer("pet-api");
  await tracer.startActiveSpan("process-payment", async (span) => {
    span.setAttribute("payment.amount", req.body.amount);   // атрибут — в Jaeger
    try {
      const result = await chargeCard(req.body);
      span.setStatus({ code: SpanStatusCode.OK });
      res.json(result);
    } catch (err) {
      span.recordException(err);                              // стек в спане
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      res.status(502).json({ error: "payment failed" });
    } finally {
      span.end();                                             // спан завершён
    }
  });
});
```

Важная деталь: инструментация `pg` оборачивает каждый SQL-запрос в span с текстом запроса (без параметров — конфиденциальность). В Jaeger видишь: `SELECT ... FROM orders WHERE user_id = $1` — 650 мс. Проблема найдена без единого grep по логам.

### Сэмплирование трейсов

Каждый запрос → трейс из десятков спанов. При 1000 RPS полное собирание убьёт сеть и хранилище. Решение — **head-based sampling**: решение о записи принимается на старте трейса (голове) и распространяется контекстом:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node";

const sdk = new NodeSDK({
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.1),   // 10% трейсов на старте
  }),
  // ...
});
```

`ParentBasedSampler` — если входящий запрос уже в трейсе (заголовок `traceparent` присутствует), решение родителя уважается: сервис B продолжает трейс, который сервис A решил записать. Это гарантирует целостность: не будет трейсов, обрывающихся посередине цепочки. Для ошибок есть **tail-based sampling** в OTel Collector: решение после завершения трейса («записать, если есть error-спан») — мощнее, но требует централизованного коллектора.

:::tip[Начни с монолита]
Трейсинг окупается не с количества сервисов, а с первого же фонового воркера или вызова внешнего API: уже в монолите спан покажет, что из 800 мс запроса 650 ушло в `setTimeout` без причины или в запрос к платёжному шлюзу. Не откладывай инструментацию «пока не станет микросервисов».
:::

## Связывание логов и трейсов

По отдельности лог и трейс — полкартины. Вместе — полная: лог даёт контекст («payment failed for user 4821»), трейс — место и время каждой операции. Связка через `trace_id`, который OTel проставляет в логи:

```ts
// logger.ts — pino с trace_id из активного спана
import { pino } from "pino";
import { trace } from "@opentelemetry/api";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "pet-api" },
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const ctx = span.spanContext();
    return { trace_id: ctx.traceId, span_id: ctx.spanId };   // в каждую строку лога
  },
});
```

Теперь расследование — три клика: алерт «error rate вырос» → в логе ошибки `trace_id: a1b2c3...` → в Jaeger открываешь трейс по этому ID → видишь водопад: где именно упало. И наоборот: из трейса с медленным спаном берёшь `trace_id`, грепишь логи — контекст бизнес-операции.

:::tip[Сквозной request_id vs trace_id]
Если ты уже прокидываешь `request_id` (глава про логирование) — отлично, он остаётся для читаемости людьми. `trace_id` — для машинной склейки лог↔трейс↔метрики (Prometheus-экспортеры OTel умеют добавлять trace_id в метки спанов). Два идентификатора не конфликтуют: request_id — внутри одного сервиса, trace_id — сквозь все.
:::

## Алертинг: от метрики до человека

Метрики без алертов — картинка. Цепочка: Prometheus правило → Alertmanager → маршрутизация → получатель (Telegram, webhook, PagerDuty). Каждое звено решает свою задачу: Prometheus определяет «что случилось», Alertmanager — «кому и как сказать».

### Alertmanager: routes, inhibit_rules, receivers

```yaml
# alertmanager.yml
global:
  smtp_smarthost: "smtp.example.com:587"
  smtp_from: "alerts@darkpix.dev"

route:
  receiver: default                    # приёмник по умолчанию
  group_by: [alertname, severity]      # группировать похожие алерты в одно сообщение
  group_wait: 30s                      # ждать 30 секунд, собирая группу
  group_interval: 5m                   # между отправкой обновлений группы
  repeat_interval: 4h                  # не спамить: повторяем алерт раз в 4 часа

  routes:
    - match: { severity: critical }    # critical — сразу в Telegram
      receiver: telegram-ops
      continue: false
    - match: { severity: warning }     # warning — дайджестом в вебхук
      receiver: webhook-digest
      group_wait: 5m
      repeat_interval: 24h

# Подавление: если ApiDown (critical) — глушим все latency/error-rate алерты warning,
# иначе получишь 20 сообщений об одном инциденте
inhibit_rules:
  - source_match:
      severity: critical
    target_match:
      severity: warning
    equal: [instance]

receivers:
  - name: default
    webhook_configs:
      - url: "http://localhost:5001/alerts"

  - name: telegram-ops
    telegram_configs:
      - bot_token: ${TG_BOT_TOKEN}
        chat_id: ${TG_CHAT_ID}
        message: |
          🚨 {{ .CommonAnnotations.summary }}
          {{ range .Alerts }}
            Instance: {{ .Labels.instance }}
            {{ .Annotations.description }}
          {{ end }}
        parse_mode: ""

  - name: webhook-digest
    webhook_configs:
      - url: "https://hooks.slack.com/services/XXX/YYY/ZZZ"
        send_resolved: false              # resolved-уведомления не шлём для warning
```

Ключевые механики: `group_by` склеивает «CPU high на 3 инстансах» в одно сообщение вместо трёх; `inhibit_rules` решает проблему «шторма алертов» — когда упал сервис, latency/error rate алерты этого же инстанса глушатся, потому что уже ясно: сервис лежит; `repeat_interval` ограничивает спам.

### Правила алертов: полные примеры

```yaml
# alert.rules.yml — монтирование: prometheus --config.file=prometheus.yml,
# где prometheus.yml: rule_files: [alert.rules.yml]
groups:
  - name: pet-infrastructure
    interval: 30s

    rules:
      # --- Доступность ---
      - alert: InstanceDown
        expr: up{job=~"app|node"} == 0
        for: 2m                          # не мигать: держится 2 минуты
        labels: { severity: critical, team: ops }
        annotations:
          summary: "Инстанс {{ $labels.instance }} недоступен"
          description: "Prometheus не может достучаться до {{ $labels.job }} на {{ $labels.instance }} уже 2 минуты."

      # --- Ресурсы ---
      - alert: DiskAlmostFull
        expr: node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes < 0.15
        for: 10m
        labels: { severity: warning, team: ops }
        annotations:
          summary: "Диск {{ $labels.instance }} заполнен на {{ $value | humanizePercentage }}"
          description: "На {{ $labels.instance }} свободно меньше 15% на {{ $labels.mountpoint }}. Очисти логи/бэкапы."

      - alert: CpuHigh
        expr: 100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
        for: 15m
        labels: { severity: warning, team: ops }
        annotations:
          summary: "CPU {{ $labels.instance }} загружен на {{ $value | humanize }}%"
          description: "Средняя загрузка CPU за 15 минут выше 90%. Проверь топ-процессы (cAdvisor/Node Exporter)."

      - alert: MemoryHigh
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
        for: 10m
        labels: { severity: warning, team: ops }
        annotations:
          summary: "Мало свободной памяти на {{ $labels.instance }}"
          description: "Available memory < 10%. Возможен OOM."

      # --- Приложение (RED) ---
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
            /
          sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        labels: { severity: critical, team: app }
        annotations:
          summary: "Доля 5xx выше 1% ({{ $value | humanizePercentage }})"
          description: "Проверь логи: {service=\"pet-api\"} |= \"error\". Возможен баг в последнем деплое."

      - alert: HighLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
          ) > 0.5
        for: 10m
        labels: { severity: warning, team: app }
        annotations:
          summary: "P95 латентности {{ $value }} сек (порог 0.5)"
          description: "P95 выше 500 мс 10 минут. Базовая линия: 120 мс. Проверь медленные запросы в Jaeger."

      - alert: PodRestartLoop          # для Docker: контейнер перезапускается
        expr: increase(container_start_time_seconds[15m]) > 3
        for: 0m
        labels: { severity: critical, team: app }
        annotations:
          summary: "Контейнер {{ $labels.name }} перезапускается в цикле"
          description: "Более 3 рестартов за 15 минут. Смотри docker logs {{ $labels.name }}."
```

Каждое правило — по формуле: `expr` (PromQL) + `for` (длительность) + `labels` (severity для маршрутизации) + `annotations` (summary/description — это текст, который получит человек). Пороги выводи из базовой линии, а не из головы: замерил нормальный P95 = 120 мс → порог 500 мс; нормальная доля 5xx = 0.05% → порог 1%.

:::caution[Сигнал важен шума]
Алерт, который пищит раз в неделю по пустяку, отключают — и пропускают настоящий инцидент. Правило: на каждый алерт должно быть понятное действие («чистить диск», «рестартовать», «откатить деплой»). Нет действия — нет алерта. Проверяй: за последний месяц каждый алерт закончился действием? Если нет — порог слишком чувствительный.
:::

## SLI, SLO и error budget

Алерты «CPU > 90%» — технические, но бизнесу плевать на CPU. **SLI (Indicator)** — измеримый показатель качества сервиса: доля успешных запросов (availability), P95 латентности. **SLO (Objective)** — цель по SLI за период: «99.9% запросов успешны за 30 дней». **Error budget** — допустимый объём нарушений: 0.1% от всех запросов за месяц.

```text
SLO: 99.9% availability за 30 дней
→ Error budget: 0.1% запросов могут быть 5xx
→ При 1M запросов/мес: 1000 запросов «в копилке»
→ Сгорели за неделю: 950 → стоп деплоя новых фич, стабилизация
→ Сгорели: 100 → откат последнего деплоя, инцидент-ревью
```

Error budget — рычаг баланса скорости и стабильности: пока бюджет есть — команда деплоит смело; бюджет кончается — фиксируем стабильность, замораживаем фичи. Это объективный аргумент в споре «деплоить быстрее» vs «стабильнее»: цифры вместо мнений.

| SLI | SLO (пример) | Чем измеряем |
|---|---|---|
| Availability | 99.9% запросов без 5xx за 30 дн | `1 - sum(rate(5xx[30d]))/sum(rate(all[30d]))` |
| Latency | P95 < 300 мс за 30 дн | `histogram_quantile(0.95, ...)` |
| Freshness (для очередей) | лаг < 5 мин | queue depth/rate |

Для pet-проекта формализуй хотя бы availability SLO — он же источник порогов алертов: SLO 99.9% → алерт на быстрое сгорание бюджета (например, 5xx rate > 1% за 5 минут = тратим бюджет в 6 раз быстрее нормы).

## On-call ротация

Когда алерты приходят в 3 часа ночи, должен быть человек, который отвечает. On-call — расписание дежурств: первичный (ответить за 5 минут) и вторичный (если первичный недоступен).

Практика для маленькой команды (2-3 человека):

- **Период**: неделя на человека, ротация в понедельник утром (не в пятницу вечером).
- **Уведомление**: critical алерты — звонок/PagerDuty, не молчаливый webhook. Telegram-пинг — минимум.
- **Эскалация**: если за 15 минут нет ack — вторичному, ещё через 15 — всем.
- **Компенсация**: дежурство — работа. Оплачивается/отгуливается; это не «просто держи телефон рядом».

Инструменты: PagerDuty/Opsgenie (платные, для команд), Grafana OnCall (open source, интеграция с Alertmanager), простой вариант для pet-проекта — Telegram-бот с кнопкой «принял» и эскалацией через cron-скрипт.

## Сквозной чек-лист наблюдаемости

Перед тем как считать наблюдаемость «готовой», спровоцируй инцидент и замерь время реакции:

- Убей процесс приложения → алерт `InstanceDown` пришёл за 2-5 минут? В сообщении — инстанс, ссылка на дашборд, понятное действие?
- Заполни диск до 90% → `DiskAlmostFull` с указанием, что чистить (логи Docker? бэкапы?)?
- Разлей 5xx на 2% трафика (фича-флаг в canary) → `HighErrorRate` раньше, чем жалобы пользователей?
- По `trace_id` из алерта → трейс в Jaeger открывается за секунды, показывает спан-виновник?

Если хоть один ответ «нет» — не хватает сигнала, а не дисциплины. Верись к главам про логирование/метрики/трейсинг и закрывай пробел.

## Типичные ошибки и грабли

1. **Трейсинг без сэмплирования.** 100% трейсов при 500 RPS: Jaeger захлёбывается, диск полон, сеть забита спанами. Хорошо: head-based sampling 1-10%, tail-based для ошибок через OTel Collector.
2. **OTel-инициализация после импорта Express.** `import "./tracing"` должен быть первой строкой — иначе HTTP-инструментация не перехватит require фреймворка и спанов не будет. Хорошо: проверь `tracer.startSpan("test")` в стартап-логе.
3. **Шторм алертов без inhibit_rules.** Упал сервис → 15 алертов (down, latency, error rate, CPU) в Telegram за минуту → телефон выключен, настоящий инцидент пропущен. Хорошо: critical глушит warning той же инстанс-группы, group_by склеивает похожие.
4. **Алерты без `for` (мгновенные).** Сетевой глитч на 3 секунды → алерт «InstanceDown» → паника → алерт resolved через 5 секунд. Хорошо: `for: 2m` минимум для availability, 5-10 минут для ресурсов — исключает шум.
5. **`trace_id` не в логах.** В Jaeger видишь медленный спан, но не можешь найти лог этого запроса — контекст потерян. Хорошо: pino-mixin с `trace_id`/`span_id` из активного спана (код выше), одинаковый формат во всех сервисах.
6. **SLO «100% availability».** Недостижимо: любой деплой, любой сетевой глитч — нарушение. Команда либо игнорирует SLO, либо не деплоит вообще. Хорошо: 99.9% для старта (43 минуты даунтайма в месяц — реально), error budget управляет скоростью.
7. **On-call «кто-нибудь да посмотрит».** Алерт пришёл в общий чат, никто не ответил 2 часа. Хорошо: один ответственный по расписанию, ack-кнопка, эскалация вторичному, ревью каждого пропущенного алерта.

## Вопросы на собеседовании

1. **Чем трейсинг отличается от логирования?** Лог — точечное событие в одном сервисе; трейс — сквозной путь запроса через все сервисы с длительностями каждой операции. Лог отвечает «что случилось», трейс — «где потерялось время/где упало». Трейс строится автоматически из спанов, лог — явно пишется разработчиком.
2. **Как OpenTelemetry распространяет контекст между сервисами?** Через заголовок `traceparent` (W3C Trace Context): `00-<trace-id>-<parent-span-id>-<flags>`. HTTP-клиент инструментированного сервиса добавляет его, входящий middleware следующего сервиса извлекает и делает спан дочерним. Решение о сэмплировании тоже передаётся в флагах.
3. **Что такое head-based и tail-based sampling?** Head — решение на старте трейса (быстро, просто, но не знаем, будет ли трейс ошибочным). Tail — решение после завершения трейса (можем записать все ошибки, но требует буферизации в коллекторе и отложенной отправки). Для большинства — head с ratio 1-10%, tail — в OTel Collector для точного контроля.
4. **Как связать логи и трейсы?** Добавить `trace_id` и `span_id` из активного OTel-спана в каждую JSON-строку лога (pino mixin). Тогда по ID из трейса в Jaeger находишь логи, и наоборот. Требует: единый формат JSON, автоматическая инструментация спанов.
5. **Зачем нужен Alertmanager, если Prometheus умеет в webhook?** Prometheus шлёт сырые алерты; Alertmanager добавляет маршрутизацию по severity/labels, группировку (одно сообщение вместо 20), подавление (inhibit_rules), повторные отправки и интервалы, интеграцию с разными получателями (Telegram, PagerDuty, Slack). Без него — шторм и хаос.
6. **Что такое error budget и как его использовать?** Допустимый объём нарушений SLO за период (например, 0.1% 5xx при SLO 99.9%). Пока бюджет не исчерпан — деплоим смело; при исчерпании — стабилизация, заморозка фич, фокус на надёжности. Объективный баланс скорости и стабильности, аргумент в планировании.
7. **Почему алерты должны иметь `for` и как подобрать длительность?** `for` требует, чтобы условие держалось N минут — отсекает кратковременные всплески (сетевые глитчи, GC-паузы). Длительность из SLO: если SLO 99.9% за 30 дней, алерт с `for: 2m` на error rate 1% сигнализирует о трате бюджета в 6 раз быстрее допустимого — успеем среагировать.
8. **SLI vs SLA: в чём разница?** SLI — измеряемый показатель (доля 200/300 ответов). SLO — внутренняя цель команды по SLI (99.9%). SLA — внешний контракт с пользователем/клиентом, обычно мягче SLO (99.5%) с компенсациями (кредиты). SLO должен быть строже SLA, чтобы успеть исправить до нарушения контракта.

## Практика

1. Подними Jaeger all-in-one через compose, инструментируй pet-приложение OTel SDK (service name `pet-api`, экспорт в OTLP). Найди в UI самый медленный трейс за час: какой спан занимает 80% времени? Оптимизируй и сравни.
2. Настрой pino-mixin с `trace_id`/`span_id`. Сымитируй ошибку в API, найди её лог по `trace_id` в Loki, открой трейс в Jaeger по этому же ID — три клика от алерта до корня.
3. Напиши 5 alert-правил из примера (InstanceDown, DiskAlmostFull, CpuHigh, HighErrorRate, HighLatencyP95) с порогами из твоей базовой линии. Сымитируй каждый (убей процесс, заполни диск tmp-файлом, нагрузи CPU `stress-ng`, верни 500 из эндпоинта, добавь `sleep(600)` в handler) и убедись: алерт пришёл, содержит summary/instance, resolved пришёл после восстановления.
4. Настрой Alertmanager с двумя маршрутами: critical → Telegram сразу, warning → вебхук-дайджест раз в сутки. Добавь inhibit_rule: InstanceDown глушит warning-алерты того же инстанса. Проверь шторм: убей сервис и убедись, что пришло ОДНО сообщение, а не пять.
5. Формализируй SLO для pet-проекта: availability 99.9% за 30 дней. Посчитай error budget в запросах (твой RPS × 2592000 × 0.001). Настрой алерт «быстрое сгорание бюджета»: error rate > 0.1% за час. Отслеживай остаток бюджета на дашборде.
6. Спроектируй on-call для команды из двух человек: расписание недельной ротации, эскалация (5 мин → вторичный → все), отчёт по инциденту (timeline, root cause, action items). Проведи учебный инцидент: один «спит», алерт эскалируется ко второму.

## Что почитать

- [OpenTelemetry — Node.js instrumentation](https://opentelemetry.io/docs/instrumentation/js/) и [Trace Context (W3C)](https://www.w3.org/TR/trace-context/)
- [Jaeger — getting started](https://www.jaegertracing.io/docs/latest/getting-started/) и [architecture](https://www.jaegertracing.io/docs/latest/architecture/)
- [Prometheus — alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) и [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Google SRE Book — Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) — SLI/SLO, error budget
- [Google SRE Book — Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) — burn rate alerting
- [Grafana OnCall](https://grafana.com/docs/oncall/latest/) — open source on-call ротация
