---
title: "Kubernetes: продвинутое"
description: "Ingress и Ingress Controller, TLS через cert-manager, Helm-чарты полного цикла, StatefulSet, NetworkPolicies, RBAC с CI-сервис-аккаунтом, PodDisruptionBudget и HPA."
---

Базовые Deployment и Service делают кластер *работающим*. Эта глава — про то, что делает его *боевым*: входящий HTTPS-трафик с автоматическими сертификатами, шаблонизацию десятков манифестов, базу данных, которая переживает перезапуск ноды, сетевую изоляцию, минимально необходимые права и автомасштабирование под нагрузкой. Каждый механизм здесь — ответ на инцидент, который случился у кого-то в продакшене.

## Ingress и Ingress Controller

Service типа NodePort открывает порт на нодах, но это не HTTP-маршрутизация: ни доменов, ни путей, ни TLS-терминации. За это отвечает связка из двух объектов:

- **Ingress** — декларативное правило: «домен `api.darkpix.dev`, путь `/api` → Service backend, TLS сертификат из секрета `api-tls`». Формат ресурса — в [документации по Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/).
- **Ingress Controller** — демон, который *реализует* эти правила. Самый распространённый — **ingress-nginx**: читает все Ingress'ы через API-сервер и перегенерирует конфиг nginx + reload.

```bash
# Контроллер ставится как обычный деплоймент (helm или манифесты)
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api
  namespace: pet
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "20"        # анти-DDoS на уровне nginx
    nginx.ingress.kubernetes.io/proxy-body-size: 10m
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.darkpix.dev]
      secretName: api-tls                              # cert-manager создаст сам
  rules:
    - host: api.darkpix.dev
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: api, port: { number: 80 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: frontend, port: { number: 80 } } }
```

Под капотом: контроллер на каждое изменение Ingress пересобирает конфиг nginx и делает reload (без разрыва соединений — через unix-socket и `nginx -s reload`). Важно понимать: **Ingress без контроллера — мёртвый YAML**, `kubectl apply` примет его, но трафик никуда не пойдёт. Диагностика — `kubectl -n ingress-nginx logs deploy/ingress-nginx-controller` и проверка, что Ingress получил адрес: `kubectl get ingress` (колонка ADDRESS).

## TLS через cert-manager

Ручное продление сертификатов — ритуал, который однажды забывают. **cert-manager** — оператор в кластере, который сам выпускает и обновляет сертификаты Let's Encrypt через ACME-протокол (challenge http-01: спрятать файл по пути, который проверит LE). Концепции issuance и настройки ACME-issuer'ов — в [документации cert-manager](https://cert-manager.io/docs/).

```bash
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true
```

```yaml
# ClusterIssuer: кто и как выпускает сертификаты (аккаунт LE + способ проверки)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory   # staging для тестов!
    email: ops@darkpix.dev
    privateKeySecretRef: { name: letsencrypt-account }
    solvers:
      - http01:
          ingress:
            class: nginx          # cert-manager временно создаст Ingress для проверки
```

Дальше достаточно аннотации на Ingress — `cert-manager.io/cluster-issuer: letsencrypt` (как в примере выше), и оператор сам создаст Certificate → Order → Challenge, выпустит сертификат, положит его в указанный Secret и **будет обновлять за 30 дней до истечения**. Ручной режим для тестов: `kubectl create secret tls api-tls --cert=fullchain.pem --key=privkey.pem`.

:::tip[Тестируй на staging-сервере LE]
Let's Encrypt имеет rate limits: 5 неудачных валидаций в час на домен. Пока манифесты не отлажены, используй `server: https://acme-staging-v02...` — сертификаты фейковые, но лимиты не жгутся. Переведёшь на продовый сервер, когда всё зелёное.
:::

## Helm: шаблонизация манифестов

Когда манифестов много и они отличаются значениями между окружениями, правят одни и те же файлы — пора в Helm. Чарт — это Go-шаблоны + `values.yaml` + метаданные; релиз — установленный в кластер экземпляр чарта. Шаблонизация, values и жизненный цикл релизов подробно описаны в [документации Helm](https://helm.sh/docs/).

```
charts/api/
├── Chart.yaml              # имя, версия чарта, версия приложения
├── values.yaml             # дефолты (переопределяются при install/upgrade)
├── values.prod.yaml        # оверлей окружения
├── templates/
│   ├── deployment.yaml     # {{- if .Values.probes.enabled }} ... {{- end }}
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   └── _helpers.tpl        # имена релизов: {{ include "api.fullname" . }}
└── charts/                 # зависимые чарты (postgresql, redis)
```

Шаблон с типичными приёмами:

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "api.fullname" . }}
  labels:
    {{- include "api.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      {{- include "api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        # Перезапуск подов при изменении ConfigMap/Secret
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          {{- if .Values.probes.enabled }}
          readinessProbe:
            httpGet: { path: /ready, port: http }
          {{- end }}
```

values.yaml:

```yaml
replicas: 2
image:
  repository: ghcr.io/darkpix/pet-api
  tag: ""                      # пусто → Chart.AppVersion
probes:
  enabled: true
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   { cpu: 500m, memory: 256Mi }
postgresql:                    # зависимость из Chart.yaml (dependencies)
  enabled: true
  auth: { database: appdb, username: app }
```

Управление релизом и жизненный цикл:

```bash
helm dependency update charts/api            # скачать зависимости в charts/
helm template charts/api -f values.prod.yaml | less   # посмотреть, что получится БЕЗ кластера
helm upgrade --install api charts/api -n pet \
  -f charts/api/values.yaml -f charts/api/values.prod.yaml \
  --set image.tag=1.4.3
helm history api -n pet
helm rollback api 2 -n pet                   # откат релиза
helm diff upgrade api charts/api -n pet      # через плагин helm-diff: что изменится
```

**Хуки** — Job'ы, выполняющиеся на событиях жизненного цикла. Классика — миграции перед апгрейдом:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "api.fullname" . }}-migrate
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install   # запустить до обновления деплоймента
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["npm", "run", "db:migrate"]
```

Важно: helm diff/rollback не откатывают данные — хук миграций, изменивший схему, нельзя «откатить» командой `helm rollback`. Миграции должны быть обратимо-совместимыми (expand-migrate-contract) — иначе откат релиза сломает старую версию приложения.

## StatefulSet: stateful-приложения

База данных — не Deployment: ей нужны стабильное имя (`db-0`, `db-1`), свой диск у каждой реплики, упорядоченный запуск и останов.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: pet }
spec:
  serviceName: db                 # headless-сервис для DNS db-0.db, db-1.db
  replicas: 1                     # PostgreSQL-кластер (Patroni) — отдельная история
  podManagementPolicy: OrderedReady
  updateStrategy: { type: RollingUpdate }
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      terminationGracePeriodSeconds: 60   # время на checkpoint WAL
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_DB, value: appdb }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql/data }
  volumeClaimTemplates:           # PVC на каждый под: data-db-0, data-db-1
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: local-path
        resources: { requests: { storage: 10Gi } }
```

Ключевые отличия от Deployment: PVC создаётся из шаблона и **не удаляется** при удалении/пересоздании пода (диск переживает под, пока жив StatefulSet); поды стартуют и останавливаются по порядку (db-0 → db-1); DNS через headless-сервис даёт прямой доступ к конкретной реплике. Гарантии упорядочения и персистентности — в [документации StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/). Для pet-проекта хватит одной реплики; кластеризация Postgres (Patroni, CloudNativePG) — отдельная большая глава.

## NetworkPolicy: сетевой фаервол внутри кластера

По умолчанию любой под может достучаться до любого пода — любой скомпрометированный контейнер видит базу. NetworkPolicy (реализует CNI: Calico, Cilium) ограничивает трафик на L3/L4 — синтаксис и семантика селекторов разобраны в [документации по NetworkPolicies](https://kubernetes.io/docs/concepts/services-networking/network-policies/):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: db-allow-only-api, namespace: pet }
spec:
  podSelector: { matchLabels: { app: db } }   # к кому применяется
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: api } }   # только поды api
      ports: [{ port: 5432 }]
```

Вариант «default deny» + точечные разрешения — стандарт харднинга: отдельная полития блокирует весь входящий трафик в namespace (`podSelector: {}`, `policyTypes: [Ingress]` без rules), затем разрешается нужное.

:::caution[Политика без поддержки CNI — декорация]
NetworkPolicy срабатывает только если CNI-плагин её реализует. kind/minikube с kindnet её **игнорируют** — политики «работают», но трафик не режется. Проверяй реализацию Calico/Cilium на реальных кластерах.
:::

## RBAC: ServiceAccount, Role, RoleBinding

RBAC в K8s отвечает на вопрос «кто может что». Субъект (ServiceAccount/пользователь) + много действий (Role с правилами) + связка (RoleBinding). Разница Role/ClusterRole — область: namespace или весь кластер. Модель авторизации целиком — в [документации по RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/).

Главный практический кейс — **сервис-аккаунт для CI/GitOps**, который может деплоить только одно приложение и ничего больше:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: deployer, namespace: pet }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: deployer, namespace: pet }
rules:
  # Деплойменты и поды — читать и обновлять
  - apiGroups: ["apps"]
    resources: [deployments, deployments/scale]
    verbs: [get, list, watch, patch, update]
  - apiGroups: [""]
    resources: [pods]
    verbs: [get, list, watch]
  # Конфиги — но НЕ секреты: образы с секретами в env читаются из vault-провайдера
  - apiGroups: [""]
    resources: [configmaps]
    verbs: [get, list, watch, update, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: deployer, namespace: pet }
subjects:
  - { kind: ServiceAccount, name: deployer, namespace: pet }
roleRef: { kind: Role, name: deployer, apiGroup: rbac.authorization.k8s.io }
```

Токен этого SA CI забирает так и кладёт в секрет пайплайна:

```bash
kubectl create token deployer -n pet --duration=8760h   # либо секрет с токеном SA
```

Принцип минимальных прав: deployer не читает secrets, не трогает другие namespace, не создаёт поды напрямую — утечка токена компрометирует одно приложение, а не кластер. Cluster-admin в CI — антипаттерн, за который на ревью инфраструктуры заворачивают.

## PodDisruptionBudget: защита от «добрых» перебоев

Rolling update, drain ноды, автоскейлинг — всё это *добровольные* исчезновения подов. PodDisruptionBudget гарантирует, что добровольных не станет слишком много:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: api, namespace: pet }
spec:
  minAvailable: 2            # либо maxUnavailable: 1 — что удобнее
  selector: { matchLabels: { app: api } }
```

Теперь `kubectl drain` и rolling update под Deployment с репликами 2 будут заблокированы: eviction API откажет, если после удаления пода останется меньше 2 доступных. Важно: PDB не спасает от *недобровольных* исчезновений (нода сгорела) — только от плановых операций. Классическая пара: PDB + две реплики минимум.

## HPA: горизонтальное автомасштабирование

HorizontalPodAutoscaler смотрит на метрики (обычно CPU от metrics-server) и масштабирует Deployment между min и max:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: api, namespace: pet }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }  # 70% от requests
  behavior:                              # необязательно: сглаживание флуктуаций
    scaleDown:
      stabilizationWindowSeconds: 300    # не ужиматься чаще раза в 5 минут
```

Механика: metrics-server собирает usage подов; HPA каждые 15 секунд считает ratio = current/target и решает о масштабировании; решение исполняется через scale API Deployment. Грабли: автомасштабирование по CPU бессмысленно для приложений без CPU-bound нагрузки (I/O-bound Node.js живёт на 5% CPU при любом RPS) — для них ставь кастомные метрики через Prometheus Adapter (RPS из ingress, длина очереди из брокера). И помни про PDB: раскатка на 10 реплик с PDB minAvailable: 2 даст гигантский rolling surge — балансируй значения.

## Типичные ошибки и грабли

1. **Ingress создан, контроллер не установлен.** `kubectl get ingress` показывает объект, ADDRESS пустой, трафик не идёт. Проверь: `kubectl get pods -n ingress-nginx` и `ingressClassName`.
2. **cert-manager на продовом LE без отладки.** Пять неудачных попыток — час бана домена. Сначала staging, смотри `kubectl describe certificate` (события Order/Challenge).
3. **Helm upgrade, а миграция сломала схему.** Хук pre-upgrade отработал, новые поды не стартуют, `helm rollback` откатывает Deployment, но схему БД — нет. Миграции только expand → migrate → contract.
4. **NetworkPolicy «работает» в kind/minikube.** Без поддерживающего CNI политика — текст без эффекта. Проверяй реальную изоляцию tcpdump'ом или `kubectl exec` с пода-нарушителя.
5. **HPA на CPU для I/O-bound сервиса.** Метрика плоская, HPA не срабатывает, а очередь растёт. Автомасштабирование по CPU имеет смысл только если CPU — твой реальный лимит.
6. **RBAC: ClusterRoleBinding роли cluster-admin для CI.** Один утёкший токен — полный доступ к кластеру. Role в одном namespace с 4-5 verbs закрывает 95% кейсов деплоя.
7. **PDB minAvailable: 2 при replicas: 2.** Любой rolling update встаёт: нечего эвиктить. minAvailable должен быть строго меньше реплик минус surge.

## Вопросы на собеседовании

1. **Чем Ingress отличается от Ingress Controller?** Ingress — декларативное правило маршрутизации (ресурс API). Controller — демон (nginx, traefik, haproxy), который эти правила реализует, генерируя конфиг прокси. Без контроллера Ingress не имеет эффекта.
2. **Как cert-manager выпускает сертификат?** Certificate → ACME Order → http-01 Challenge: временный Ingress отдаёт файл на пути `/.well-known/acme-challenge/`, LE проверяет, сертификат кладётся в Secret, обновляется до истечения.
3. **Что делает `helm rollback` и чего он не делает?** Откатывает манифесты на ревизию (через историю релизов), не трогает данные и не отменяет хуки/миграции. Данные, изменённые приложением или миграциями, откат не затрагивает.
4. **StatefulSet против Deployment: три ключевых отличия.** Стабильные имена подов и DNS, PVC из volumeClaimTemplates переживает под, упорядоченный старт/стоп. Deployment — для stateless, StatefulSet — для stateful.
5. **Role против ClusterRole?** Область действия: namespace против кластера. RoleBinding может ссылаться и на ClusterRole — тогда права ClusterRole применяются только в namespace биндинга (паттерн «одна роль — много namespace»).
6. **PDB защищает от чего и от чего нет?** От добровольных перебоев (drain, rolling update): eviction API откажет. От недобровольных (краш ноды, OOM) — нет.
7. **HPA: откуда метрики и как работает цикл?** metrics-server (CPU/память) или Prometheus Adapter (кастомные). HPA каждые 15 c считает utilization относительно target и вызывает scale; behavior позволяет сгладить решения.

## Практика

1. Установи ingress-nginx и cert-manager в kind, настрой ClusterIssuer на staging LE, выпусти сертификат для `api.127.0.0.1.nip.io` и проверь цепочку: `kubectl describe certificate` → Order → Challenge.
2. Сделай `helm create api` и перенеси в чарт Deployment/Service/Ingress из предыдущей главы. Добавь `values.prod.yaml` с 3 репликами, `helm template` → сравни с ручными манифестами.
3. Добавь хук `pre-upgrade` с Job миграции (например, `node migrate.js`). Сделай `helm upgrade` с изменённым тегом и убедись по логам, что миграция отработала до обновления подов.
4. Задеплой StatefulSet Postgres с volumeClaimTemplate. Запиши данные, удали под, убедись, что PVC `data-db-0` жив и данные на месте.
5. Создай ServiceAccount `deployer` с Role из главы, выпусти токен, настрой `kubectl` с ним и попробуй: прочитать ConfigMap (успех), прочитать Secret (доступ запрещён), обновить Deployment в другом namespace (запрещено).

## Что почитать

- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/) и [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/) — документация K8s
- [cert-manager documentation](https://cert-manager.io/docs/) — issuance, ACME, challenges
- [Helm Docs](https://helm.sh/docs/) — charts, values, hooks, best practices
- [StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/) и [PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) и [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
