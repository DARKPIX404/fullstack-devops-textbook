---
title: "Наблюдаемость в Kubernetes"
description: "kube-prometheus-stack, ServiceMonitor и PodMonitor, метрики control plane и нод, дашборды Grafana, логирование через Loki и Promtail, Alertmanager с реальными правилами и события кластера."
---

Кластер, в который нельзя заглянуть, — это чёрный ящик, который однажно ты откроешь с отвёрткой в три часа ночи. Наблюдаемость в Kubernetes — три кита: **метрики** (числа во времени: CPU, latency, количество рестартов), **логи** (что именно случилось) и **алерты** (когда человеку пора проснуться). Плюс четвёртый, бесплатный: **события кластера** — то, что Kubernetes сам пишет о своих решениях.

В этой главе собираем стек, который стоит в половине продакшенов мира: Prometheus + Alertmanager + Grafana + Loki одним чартом `kube-prometheus-stack`, и учимся читать кластер как открытую книгу.

## Стек: kube-prometheus-stack

Один чарт ставит всю связку с правильными дефолтами:

```bash
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.adminPassword=changeme \
  --set prometheus.prometheusSpec.retention=15d   # сколько метрик хранить
```

Что внутри и кто за что отвечает:

| Компонент | Роль |
|---|---|
| **Prometheus** | Сбор метрик по HTTP-скрапингу (`/metrics`), хранение TSDB, evaluation правил алертов |
| **Alertmanager** | Получает firing-алерты от Prometheus, дедуплицирует, группирует, шлёт в Telegram/Slack/PagerDuty |
| **Grafana** | Дашборды поверх Prometheus (и Loki) |
| **kube-state-metrics** | Метрики *объектов* кластера: количество подов по статусам, деплойменты, PVC |
| **node-exporter** (DaemonSet) | Метрики *железа* нод: CPU, память, диск, сеть |
| **metrics-server** | Источник метрик для `kubectl top` и HPA |

Доступ для разработки:

```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
# логин admin / пароль из: kubectl -n monitoring get secret \
#   monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090
```

## Как Prometheus находит цели: ServiceMonitor и PodMonitor

Prometheus не знает про твои приложения. В vanilla-варианте ты правишь `scrape_configs` — в K8s этим управляют CRD: **ServiceMonitor** говорит «собирай метрики с подов за этим Service», **PodMonitor** — «с этих подов напрямую» (stateful-приложения без Service, агенты). Оператор видит монитор, находит подходящие эндпоинты и переписывает конфиг Prometheus — поля обоих CRD описаны в [API-референсе Prometheus Operator](https://prometheus-operator.dev/docs/api-reference/api/):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api
  namespace: pet
  labels:
    release: monitoring          # чтобы оператор его подхватил (селектор в values)
spec:
  selector:
    matchLabels: { app: api }
  namespaceSelector: { matchNames: [pet] }
  endpoints:
    - port: http                 # имя порта в Service/поде
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

Приложение обязано отдавать метрики в формате Prometheus (Node.js: `prom-client`, NestJS: `@willsoto/nestjs-prometheus`). Проверка: `kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090` → Status → Targets — твои поды должны быть в состоянии UP.

## Что собирается из коробки

- **Control plane** (apiserver, scheduler, controller-manager, etcd): длительность запросов API, количество подов в очереди scheduler'а (`scheduler_pending_pods`), ошибки etcd — критично: деградация etcd = деградация всего кластера.
- **Ноды** (node-exporter): load average, память, дисковое пространство и inode, сеть.
- **Объекты** (kube-state-metrics): `kube_pod_container_status_restarts_total` — главная метрика нестабильности, `kube_deployment_status_replicas_available` против `spec_replicas`, `kube_persistentvolumeclaim_status_phase`.
- **Поды и контейнеры** (cAdvisor встроен в kubelet): CPU/memory usage против requests и limits — здесь видно OOM *до* того, как он случился.

Готовые дашборды уже в Grafana (импортированы через sidecar): начни с **«Kubernetes / Compute Resources / Namespace (Pods)»** и **«Kubernetes / Persistent Volumes»**. Для ingress-nginx ставится отдельный dashboard по аннотации на подах контроллера.

## Логирование: Loki + Promtail + Grafana

Prometheus хранит числа, не строки. Логи — в **Loki**: он индексирует только лейблы (namespace, pod, container), а сами строки хранит сжатыми — дёшево и масштабируется.

```bash
helm upgrade --install loki grafana/loki-stack \
  --namespace monitoring \
  --set promtail.enabled=true \
  --set grafana.enabled=false            # Grafana уже есть из kube-prometheus-stack
```

**Promtail** (DaemonSet на каждой ноде) хватает stdout/stderr всех контейнеров с ноды, добавляет лейблы из Kubernetes API и пушит в Loki. Поэтому правило «пиши логи в stdout» из главы про Docker здесь становится железным: никаких файлов внутри контейнера — их никто не прочитает после перезапуска пода. Архитектурные варианты сбора логов (node-level, sidecar, агенты) разобраны в [документации Kubernetes по логированию](https://kubernetes.io/docs/concepts/cluster-administration/logging/).

Подключение Loki как datasource в Grafana (через values kube-prometheus-stack):

```yaml
grafana:
  additionalDataSources:
    - name: Loki
      type: loki
      url: http://loki.loki:3100
```

Типовые запросы в LogQL:

```logql
# Все логи пода за последний час
{namespace="pet", pod=~"api-.*"}

# Ошибки с агрегацией: сколько error в минуту по подам
sum(count_over_time({namespace="pet"} |= "ERROR" [1m])) by (pod)

# Логи рядом с ошибкой (паттерн «обвиняемый»): 1 строка до и 3 после
{namespace="pet", container="api"} |= "ERROR" | line_format "{{.}}"
```

Связка метрик и логов — суперсила: на графике latency видишь пик → клик → «View logs» → тот же timeframe в Loki → видишь стектрейс.

## Alertmanager: от firing-алерта до Telegram

Prometheus *вычисляет* правила, Alertmanager *доставляет*. Два ресурса: PrometheusRule (логика) и секрет/конфиг Alertmanager (куда слать).

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-alerts
  namespace: monitoring
  labels: { release: monitoring }
spec:
  groups:
    - name: api.rules
      rules:
        - alert: ApiHighErrorRate
          expr: |
            sum(rate(http_requests_total{namespace="pet",status=~"5.."}[5m]))
              /
            sum(rate(http_requests_total{namespace="pet"}[5m])) > 0.05
          for: 10m                    # горит 10 минут подряд — не флейк
          labels: { severity: critical, team: backend }
          annotations:
            summary: "API отдаёт >5% 5xx"
            description: "Доля 5xx за 5 мин: {{ $value | humanizePercentage }}"

        - alert: PodCrashLooping
          expr: increase(kube_pod_container_status_restarts_total{namespace="pet"}[15m]) > 3
          for: 0m
          labels: { severity: warning }
          annotations:
            summary: "Под {{ $labels.pod }} перезапускается"

        - alert: DeploymentReplicasMismatch
          expr: |
            kube_deployment_spec_replicas{namespace="pet"}
              != kube_deployment_status_replicas_available{namespace="pet"}
          for: 15m
          labels: { severity: warning }
          annotations:
            summary: "Деплоймент {{ $labels.deployment }} недосдал реплик"

        - alert: PersistentVolumeFillingUp
          expr: |
            kubelet_volume_stats_available_bytes{namespace="pet"}
              / kubelet_volume_stats_capacity_bytes{namespace="pet"} < 0.15
          for: 10m
          labels: { severity: warning }
          annotations:
            summary: "PVC {{ $labels.persistentvolumeclaim }} заполнен на 85%"
```

Настройка Alertmanager (фрагмент values чарта): маршрутизация по лейблу severity, ингибирование (поднялся кластерный алерт — гаси шумные производные), receiver в Telegram-бота:

```yaml
alertmanager:
  config:
    route:
      receiver: telegram
      routes:
        - match: { severity: critical }
          continue: true
      inhibit_rules:
        - source_match: { alertname: Watchdog }   # служебный «всё живо»
          target_match: { severity: critical }
    receivers:
      - name: telegram
        telegram_configs:
          - bot_token: ${ALERTMANAGER_BOT_TOKEN}
            chat_id: -1001234567890
            message: "{{ .CommonAnnotations.summary }}\n{{ .CommonAnnotations.description }}"
```

Три принципа, которые отличают рабочий алертинг от спама: **for** гасит флейки (метрика дёрнулась на секунду — не алерт), **inhibit_rules** гасят каскады (нода умерла — не надо 50 алертов про поды на ней), алерт без runbook — антипаттерн: в annotations всегда пиши, *что делать* первым шагом.

:::tip[Watchdog]
Ставь служебный алерт `expr: vector(1)` (always-firing). Он не молчит никогда — и его тишина в чате значит, что молчит весь Alertmanager, а не «всё хорошо, просто нет проблем». Пропал Watchdog — проблема с доставкой, а не отсутствие инцидентов.
:::

## Метрики приложения: методика RED

Стек собирает инфраструктуру, но алерты на бизнес-уровне строятся на *твоих* метриках. Методика **RED** для каждого пользовательского сервиса:

- **Rate** — запросов в секунду: `sum(rate(http_requests_total{namespace="pet"}[5m]))`. Резкое падение rate = сервис умер или всё зависло до таймаутов.
- **Errors** — доля ошибок: та формула из правила `ApiHighErrorRate` выше. Алертится на неё, не на абсолютное число.
- **Duration** — латентность: гистограмма `http_request_duration_seconds_bucket` даёт p50/p95/p99 через `histogram_quantile`:

```promql
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket{namespace="pet"}[5m])) by (le))
```

Правило эксплуатации: алертишься на SLO, а не на «метрика выглядит странно». Например, SLO «p95 < 300 мс и error rate < 1%» переводится в два правила с окном `for: 15m` — этого достаточно, чтобы не будить дежурного из-за пятиминутного хвоста GC. Для ресурсов нод используй симметричную методику **USE** (Utilization, Saturation, Errors): `node_cpu_seconds_total`, `node_load5` против числа ядер, `node_filesystem_avail_bytes`.

Дашборды держи **as code**: json-модели в git рядом с чартом приложения и sidecar-загрузка через ConfigMap (`dashboards.configMaps` в values стека). Дашборд, который нельзя восстановить из git, — это дашборд, который исчезнет в самый неподходящий момент.

## События кластера: kubectl get events

Самый бедный родственник наблюдаемости и самый недооценённый. Каждое решение кластера фиксируется событием: почему под не запланировался, почему PVC не приаттачился, кто и когда перезапустил контейнер. Схема объекта Event — в [Kubernetes API reference](https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/):

```bash
# Лента событий namespace в реальном времени
kubectl get events -n pet --sort-by=.lastTimestamp -w

# Только предупреждения, без нормы
kubectl get events -n pet --field-selector type=Warning --sort-by=.lastTimestamp

# События конкретного объекта — почему Deployment в ступоре
kubectl describe deployment api -n pet | tail -n 20
```

В проде events надо выгружать наружу (Loki умеет собирать их через eventrouter, или просто fluent-bit), потому что в etcd они живут около часа — как раз за этот час ты обычно и разбираешь инцидент.

## Типичные ошибки и грабли

1. **ServiceMonitor без лейбла release.** Оператор подхватывает только мониторы, попадающие под его селектор (`release: monitoring` — дефолт чарта). Монитор есть, поды в targets нет — первым делом проверяй лейбл.
2. **Алерты без `for` и группировки.** Метрика дёрнулась на 5 секунд — пошла ночная эскалация. Добавляй `for` от 5 минут для warning и ингибирование для каскадов.
3. **Логи в файлы внутри контейнера.** После перезапуска пода файлы умерли вместе с контейнером, а Promtail их не видел никогда. Только stdout/stderr.
4. **retention по дефолту.** Стандартный retention Prometheus в стеке — 24 часа (в старых версиях) или несколько дней; для разбора «что было в прошлую пятницу» нужно 15-30 дней, а для долгой истории — remote write в объектное хранилище (S3/Thanos/Mimir).
5. **Смотрят только Grafana, игнорируя events.** Графики показывают *что* (CPU вырос), events — *почему (под evicted по причине node pressure). Половина инцидентов разрешается в `kubectl describe` за минуту.
6. **Watchdog не настроен.** Тишина в канале алертов воспринимается как здоровье. Без always-firing алерта ты не узнаешь, что Alertmanager умер, до первого реального инцидента.

## Вопросы на собеседовании

1. **Чем метрики отличаются от логов и когда что использовать?** Метрики — дешёвые числа во времени для трендов и алертинга (CPU, RPS, error rate). Логи — подробные события для расследования конкретного случая. Правило: алерты строятся на метриках, руткоз — по логам.
2. **Как Prometheus узнаёт, у кого собирать метрики?** Через ServiceMonitor/PodMonitor (CRD оператора) — они декларативно описывают селектор подов и порт; оператор генерирует scrape-конфиг. Нативный путь — kubernetes_sd_configs в scrape_configs.
3. **ServiceMonitor против PodMonitor?** ServiceMonitor — через Service (стандарт для HTTP-приложений), PodMonitor — поды напрямую (stateful-приложения без Service, DaemonSet-агенты).
4. **Зачем нужен Alertmanager, если Prometheus умеет строить алерты?** Prometheus вычисляет правила и шлёт firing-состояния; Alertmanager занимается доставкой: группировка (не 200 сообщений, а 1 сводка), дедупликация, ингибирование каскадов, маршрутизация по severity/team, повторные уведомления и silence-окна.
5. **Что такое inhibit_rules?** Подавление шумных алертов при наличии более общего: нода NotReady → гасим алерты про поды этой ноды. Ключ к алертингу, который не спамит.
6. **Как Loki дешевле классического ELK?** Индексирует только лейблы, не полный текст: меньше индекс, дешевле хранение, дешевле запись. Плата — менее богатый поиск по тексту (нужен фильтр |= после селектора по лейблам).
7. **kube-state-metrics против node-exporter?** kube-state-metrics — метрики объектов API (поды, деплойменты, PVC: счётчики и статусы). node-exporter — метрики ОС ноды (CPU, память, диски). Вместе дают полную картину: «что хочет кластер» и «что есть у железа».

## Практика

1. Установи kube-prometheus-stack, открой Prometheus → Status → Targets. Найди, откуда метрики apiserver и kubelet, и какой job отвечает за node-exporter.
2. Экспортируй `/metrics` из своего приложения (prom-client), создай ServiceMonitor, добейся появления подов в UP. Имитируй нагрузку и построй в Grafana панель RPS и p95 latency.
3. Добавь PrometheusRule: алерт на рост 5xx, алерт на рестарты подов, DeploymentReplicasMismatch. Сломай приложение (включи endpoint, всегда отдающий 500) и дождись firing; проверь, что Alertmanager сгруппировал повторные срабатывания.
4. Поставь loki-stack, подключи Loki как datasource. Найди по LogQL все ERROR-логи за час и агрегируй их по подам. Сравни таймфрейм с графиком latency в Prometheus.
5. Собери «шпаргалку инцидента»: убей под, выпиши по шагам — что показывает `kubectl get events`, какой алерт сработал бы, какие логи смотрел бы в Loki, какая метрика подтвердила бы причину.

## Что почитать

- [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) — README чарта и дефолтные values
- [Prometheus: alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) и [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Grafana Loki](https://grafana.com/docs/loki/latest/) и [LogQL](https://grafana.com/docs/loki/latest/logql/) — синтаксис запросов
- [Kubernetes metrics reference](https://kubernetes.io/docs/reference/instrumentation/metrics/) — метрики control plane
- [awesome-prometheus-alerts](https://samber.github.io/awesome-prometheus-alerts/) — готовая библиотека правил для K8s, etcd, Postgres
