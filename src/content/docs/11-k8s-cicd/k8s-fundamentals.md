---
title: "Kubernetes: фундамент"
description: "Архитектура control plane и нод, Pod как атомарная единица, Deployment с liveness/readiness/startup пробами, requests/limits и QoS, Services, ConfigMap/Secret, PV/PVC, CronJob для бэкапов и рабочий набор kubectl."
---

Kubernetes часто объясняют через сравнение с Docker: «Docker запускает контейнеры, а Kubernetes — управляет ими». Это правда, но слишком мягкая. Точнее так: Kubernetes — это операционная система для дата-центра. Как Linux управляет процессами, памятью и файлами одной машины, так Kubernetes управляет контейнерами, сетью и дисками флота машин. И как в Linux ты не создаёшь процесс, дергая напрямую scheduler ядра, а пишешь `systemd`-юнит, так и в Kubernetes ты не запускаешь контейнер — ты описываешь *желаемое состояние*, а control plane сам находит, где и как его достичь.

Краткая версия этой темы показала Deployment и Service за пять минут. Здесь мы разберём механику до уровня, на котором ты сможешь объяснить, почему под не стартует, глядя на события ноды, и почему «просто добавь памяти» иногда делает хуже. Всё в главе — исполняемо на kind или k3d за вечер.

## Архитектура: кто принимает решения, кто их исполняет

Кластер делится на две роли: **control plane** (мозг) и **ноды** (руки).

```text
                 ┌──────────── CONTROL PLANE ────────────┐
                 │  kube-apiserver   ← единственная      │
   kubectl ────► │                     точка входа,      │
   CI, всё ────► │                     REST + etcd       │
                 │  etcd             ← база состояния     │
                 │  scheduler        ← выбирает ноду     │
                 │  controller-mgr   ← гоняет реальность │
                 └───────────────────────────────────────┘
                    │        watch / report        │
        ┌───────────┴───────────┐       ┌──────────┴──────────┐
        │        NODE 1         │       │        NODE 2       │
        │ kubelet  ─ исполняет  │       │ kubelet             │
        │          поды по      │       │                     │
        │          спецификации │       │                     │
        │ kube-proxy ─ сеть,    │       │ kube-proxy          │
        │          iptables/    │       │                     │
        │          IPVS         │       │                     │
        │ containerd ─ рантайм  │       │ containerd          │
        └───────────────────────┘       └─────────────────────┘
```

Ключевой принцип: **kube-apiserver — единственная точка входа**. Когда ты пишешь `kubectl apply`, CLI шлёт манифест в API-сервер, тот валидирует его, сохраняет в **etcd** (распределённое хранилище всего состояния кластера) и возвращает ответ. Дальше за дело берутся controller'ы: Deployment controller замечает «хочется 3 реплики, живёт 0» и создаёт ReplicaSet; scheduler видит поды без ноды и назначает их, учитывая requests, аффинити и ограничения; kubelet на выбранной ноде скачивает образ и запускает контейнеры через containerd; kube-proxy прописывает правила, чтобы Service резолвился в живые поды. Ни один компонент не «знает всё» — каждый следит за своей частью состояния и двигает реальность к ней. Это и есть декларативная модель.

:::note[Почему под не стартует — порядок диагностики]
`kubectl describe pod` показывает события в хронологии: scheduler не нашёл ноду (Insufficient memory) → образ не скачался (ImagePullBackOff) → контейнер упал на старте (CrashLoopBackOff) → проба не прошла (Unhealthy). Читай Events снизу вверх — это журнал решений кластера о твоём поде.
:::

## Pod: атомарная единица

Pod — минимальная единица планирования. Не контейнер: под. Почему? Потому что некоторым приложениям нужно несколько процессов рядом — классика: основной контейнер + sidecar-логгер, или приложение + nginx-прокси. Контейнеры одного пода делят **сетевой namespace** (общий IP, localhost между ними) и **тома** (можно монтировать общий `emptyDir`).

Но под смертен: у него нет гарантий перезапуска, имя меняется при пересоздании, IP меняется всегда. Поэтому поды напрямую создают только для отладки (`kubectl run` запускает именно под), а всё прочее — через контроллеры: Deployment для stateless, StatefulSet для stateful, Job/CronJob для задач, DaemonSet для агентов на каждой ноде.

## Deployment: полный манифест

Deployment — самый частый объект в кластере. Вот рабочий манифест с полным набором механизмов самозаживления:

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: pet
  labels: { app: api }
spec:
  replicas: 3
  revisionHistoryLimit: 5              # сколько старых ReplicaSet хранить для отката
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0                # старые поды не убиваем, пока не поднялись новые
      maxSurge: 1                      # разрешаем +1 под на время раскатки
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      terminationGracePeriodSeconds: 30  # время на SIGTERM до SIGKILL
      containers:
        - name: api
          image: ghcr.io/darkpix/pet-api:1.4.2
          ports: [{ containerPort: 3000 }]
          envFrom:
            - configMapRef: { name: api-config }
            - secretRef:    { name: api-secrets }

          # Гарантия планировщику: на ноде должно быть свободно столько
          requests: { cpu: 100m, memory: 128Mi }
          # Потолок через cgroup: CPU — throttling, память — OOM-kill
          limits: { cpu: 500m, memory: 256Mi }

          # Startup: для приложений с долгой инициализацией (миграции, прогрев кэша).
          # Пока startup не прошла, liveness не проверяется — под не убьют раньше времени.
          startupProbe:
            httpGet: { path: /health, port: 3000 }
            failureThreshold: 30       # до 30 × 10s = 5 минут на старт
            periodSeconds: 10

          # Readiness: под НЕ получает трафик, пока проба не зелёная.
          # Отвечает на вопрос «могу ли я обрабатывать запросы?»
          readinessProbe:
            httpGet: { path: /ready, port: 3000 }
            initialDelaySeconds: 2
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 3

          # Liveness: проба красная N раз — kubelet перезапускает контейнер.
          # Отвечает на вопрос «не завис ли процесс?» — НЕ на «жив ли сервис»
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
            periodSeconds: 15
            timeoutSeconds: 2
            failureThreshold: 3
```

Три пробы — три разных вопроса, и смешивать их — классическая ошибка. Liveness-проба на `/health`, который проверяет связность с базой, убьёт все поды одновременно при падении БД — правильно: readiness должен «отключать» под от балансировки, а liveness должен смотреть только на сам процесс (event loop отвечает, память в норме).

### Requests, limits и QoS

Планировщик укладывает поды на ноды строго по **requests**: сумма requests всех подов на ноде не превысит её ёмкость. **Limits** — это потолок внутри пода: превышение CPU обрезается throttling'ом (процесс просто получает меньше времени), превышение памяти — OOM-kill от cgroup.

Отношение requests к limits даёт **QoS-класс**, который определяет очерёдность выселения при нехватке ресурсов на ноде:

| QoS | Условие | Кого убивают первым |
|---|---|---|
| `Guaranteed` | requests == limits у всех контейнеров, заданы оба | Последнего |
| `Burstable` | requests < limits (обычный случай) | Вторым, по превышению requests |
| `BestEffort` | requests не заданы вообще | Первым |

Реальная история из практики: кластер с BestEffort-подами, на ноде кончилась память — OOM-killer начал с нодовых агентов и побил kubelet. Нода ушла в `NotReady` вместе со всеми подами. Правило: **requests всегда**, limits — для всего, что может съесть память (БД, Node.js, всё с кэшем).

## Service: стабильная точка входа

П IP у пода меняется при каждом пересоздании, поэтому поды находят друг друга через Service — стабильное DNS-имя + виртуальный IP + балансировка:

```yaml
apiVersion: v1
kind: Service
metadata: { name: api, namespace: pet }
spec:
  selector: { app: api }        # все поды с этим лейблом — эндпоинты
  ports:
    - port: 80
      targetPort: 3000
---
# Доступ снаружи к нодам: NodePort открывает порт 30000-32767 на каждой ноде
apiVersion: v1
kind: Service
metadata: { name: api-nodeport, namespace: pet }
spec:
  type: NodePort
  selector: { app: api }
  ports: [{ port: 80, targetPort: 3000, nodePort: 30080 }]
---
# Облачный балансировщик: в AWS/GCP создаётся реальный LB
apiVersion: v1
kind: Service
metadata: { name: api-lb, namespace: pet }
spec:
  type: LoadBalancer
  selector: { app: api }
  ports: [{ port: 80, targetPort: 3000 }]
```

- **ClusterIP** — дефолт, доступ только внутри кластера. Так общаются сервисы между собой.
- **NodePort** — для bare-metal и отладки; в проде обычно скрыт за Ingress.
- **LoadBalancer** — в облаке создаёт внешний LB; на bare-metal нужен MetalLB.

Балансировка реализована через iptables/IPVS-правила kube-proxy: DNAT на случайный живой под. Поэтому Service не «владеет» соединениями и не терминирует TLS.

## ConfigMap и Secret: конфигурация вне образа

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: api-config, namespace: pet }
data:
  NODE_ENV: "production"
  LOG_LEVEL: "info"
  REDIS_URL: "redis://redis:6379"
---
apiVersion: v1
kind: Secret
metadata: { name: api-secrets, namespace: pet }
type: Opaque
stringData:                      # K8s сам закодирует в base64 при записи
  DATABASE_URL: postgres://app:changeme@db:5432/appdb
```

Подключение двумя способами. **env** — переменные в процессе (просто, но изменение ConfigMap не перезапустит под):

```yaml
          envFrom:
            - configMapRef: { name: api-config }
            - secretRef:    { name: api-secrets }
```

**volume** — файлы в директории (изменения подхватываются без рестарта, kubelet перезаписывает файлы):

```yaml
          volumeMounts:
            - { name: config, mountPath: /etc/api, readOnly: true }
      volumes:
        - name: config
          configMap: { name: api-config }       # каждый ключ — файл
```

:::caution[Secret ≠ шифрование]
`kubectl get secret -o yaml` показывает base64 — любой с правами чтения секретов в namespace видит всё. Для настоящей защиты — External Secrets Operator из Vault/AWS SM, или Sealed Secrets. И никогда не коммить манифесты секретов: в git должен попадать только зашифрованный вариант.
:::

## PV, PVC и StorageClass

Диски в Kubernetes двухуровневые. **PersistentVolume** — физический диск (диск ноды, NFS-том, облачный диск), созданный админом или provisioner'ом. **PersistentVolumeClaim** — заявка приложения «мне нужно 10 Gi с таким-то доступом». Планировщик пода учитывает, где лежит PVC с режимом `ReadWriteOnce`.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: db-data, namespace: pet }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path        # provisioner из k3s; в kind — standard
  resources: { requests: { storage: 10Gi } }
```

**StorageClass** — шаблон создания дисков: какой provisioner вызывать, какой тип диска, политику удаления (`Retain` — диск переживает PVC, `Delete` — удаляется вместе). Важное правило: PVC существует независимо от пода и переживает его — удаление Deployment данные не трогает, удаление PVC с `Delete`-классом — трогает.

## CronJob: бэкапы по расписанию

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: db-backup, namespace: pet }
spec:
  schedule: "15 3 * * *"          # каждую ночь в 03:15
  concurrencyPolicy: Forbid       # второй запуск, пока идёт первый, запрещён
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  startingDeadlineSeconds: 600    # окно наверстывания пропущенного запуска
  jobTemplate:
    spec:
      backoffLimit: 2             # перезапуски пода при падении
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: postgres:16-alpine
              envFrom: [{ secretRef: { name: api-secrets } }]
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -e
                  pg_dump "$DATABASE_URL" | gzip > /backup/dump-$(date +%F).sql.gz
                  # ротация: храним 14 последних
                  ls -1 /backup/dump-*.sql.gz | head -n -14 | xargs -r rm
              volumeMounts:
                - { name: backup, mountPath: /backup }
          volumes:
            - name: backup
              persistentVolumeClaim: { claimName: backup-pvc }
```

Job доводит под до `Completed` и останавливается. Логи — обычные `kubectl logs job/db-backup-28510347`, поэтому пиши всё в stdout, не в файлы. Для настоящего продакшена дамп ещё выгружается наружу (S3 через `rclone`/`aws s3 cp`) — локальный PVC сгорит вместе с нодой.

## Рабочий набор kubectl

```bash
# Деплой и статус
kubectl apply -f k8s/                          # идемпотентно применить директорию
kubectl apply -f deployment.yaml --dry-run=client -o yaml   # проверить манифест
kubectl get deploy,po,svc -n pet -o wide
kubectl get pods -n pet -w                     # watch в реальном времени

# Диагностика
kubectl describe pod api-7d9f4 -n pet          # Events — журнал решений кластера
kubectl logs deploy/api -n pet --previous      # логи прошлого контейнера (после краша)
kubectl logs -n pet -l app=api --tail=100 --since=10m
kubectl exec -it deploy/api -n pet -- sh       # зайти в контейнер
kubectl port-forward svc/api 8080:80 -n pet    # локальный доступ к сервису
kubectl debug -it pod/api-7d9f4 -n pet --image=busybox --target=api   # ephemeral-контейнер

# Раскатка и откат
kubectl rollout status deploy/api -n pet
kubectl rollout history deploy/api -n pet      # ревизии с ревизион-annotation
kubectl rollout undo deploy/api -n pet --to-revision=3
kubectl set image deploy/api api=ghcr.io/darkpix/pet-api:1.4.3 -n pet  # быстрый бамп тега

# События и ресурсы кластера
kubectl get events -n pet --sort-by=.lastTimestamp
kubectl top pods -n pet                        # требует metrics-server
kubectl api-resources | grep -i cron           # найти ресурс, если забыл название
kubectl explain deployment.spec.strategy       # справка по полям манифеста
```

Три команды экономят часы: `describe` (почему), `logs --previous` (что случилось до рестарта) и `explain` (как называется поле, которое ты забыл).

## Типичные ошибки и грабли

1. **Liveness-проба проверяет внешние зависимости.** Проба на `/health`, который пингует базу: база легла → все поды уходят в перезапуск → ещё больше нагрузки на базу → `CrashLoopBackOff` по кластеру. Liveness — только про сам процесс, внешние зависимости — в readiness.
2. **Нет requests.** Под планируется куда попало, при нехватке ресурсов его убивают первым (BestEffort). «Работало вчера» — потому что вчера на ноде было свободнее. Задавай requests по замерам (`kubectl top pods` после недели работы).
3. **Requests без limits для memory-ёмких сервисов.** Node.js с разрастающимся кэшем съедает память ноды и получает OOM — лучше раньше (limit на поде) и с restart, чем позже (OOM-killer всей ноды, где чужие поды).
4. **ConfigMap изменён, поды не перечитали.** `envFrom` зашивает значения на старте; изменение ConfigMap не рестартит поды. Либо volume-монтирование, либо `kubectl rollout restart`, либо checksum-аннотация в шаблоне пода.
5. **Удалён PVC с `Delete`-политикой — удалились и данные.** Для базы — потеря продакшена. StorageClass с `Retain` для всего важного, бэкапы — отдельно (CronJob выше).
6. **Деплой без проб вообще.** Под стартует, получает трафик, пока ещё прогревает кэш — первые сотни запросов падают. Минимум — readinessProbe, иначе rolling update не лучше `docker restart`.

## Вопросы на собеседовании

1. **Что происходит после `kubectl apply`?** CLI валидирует манифест и шлёт его в kube-apiserver → запись в etcd → controller'ы видят расхождение желаемого и текущего состояния → scheduler назначает поды на ноды → kubelet запускает контейнеры через рантайм → kube-proxy настраивает сеть.
2. **Отличие readiness от liveness?** Readiness: под не готов — он исключается из эндпоинтов Service (без перезапуска). Liveness: процесс завис — kubelet перезапускает контейнер. Startup защищает долгий старт от преждевременного срабатывания liveness.
3. **Что произойдёт, если контейнер превысит memory limit?** cgroup OOM-kill: процесс убивается, kubelet перезапускает контейнер по restartPolicy. Для CPU превышение — мягкое: throttling, процесс замедляется, но живёт.
4. **Почему не создавать Pod напрямую?** Под не переживает ноду, не перезапускается сам, теряет IP. Deployment обеспечивает реплики, self-healing, rolling update и rollback.
5. **ClusterIP, NodePort, LoadBalancer — разница?** ClusterIP — внутренний виртуальный IP. NodePort — ClusterIP + порт на каждой ноде (30000-32767). LoadBalancer — NodePort + внешний балансировщик (в облаке — автоматически).
6. **QoS-классы и их влияние?** Guaranteed (requests==limits) — последний кандидат на выселение; Burstable — по превышению requests; BestEffort — первый. Влияет на поведение при нехватке ресурсов ноды.
7. **`kubectl rollout undo` — что под капотом?** Deployment хранит историю ReplicaSet (ограничена `revisionHistoryLimit`). Откат — переключение на предыдущий ReplicaSet с масштабированием старого вверх и нового вниз.

## Практика

1. Подними kind-кластер (`kind create cluster --name lab`). Задеплой Deployment из главы (3 реплики) + Service ClusterIP. Убей один под (`kubectl delete pod`) и замерь время восстановления по `kubectl get pods -w`.
2. Добавь endpoint `/health` (всегда 200) и `/ready` (первые 10 секунд после старта — 503). Задеплой с readinessProbe и наблюдай через `kubectl get endpoints`: под появится в эндпоинтах только после прогрева.
3. Сломай liveness намеренно: пусть `/health` после 60 секунд работы начнёт возвращать 500. Наблюдай перезапуски: `kubectl get pods`, `kubectl describe pod` (события Unhealthy), `kubectl logs --previous`.
4. Создай PVC (10 Gi), подключи к поду Postgres, запиши данные. Удали Deployment, пересоздай — данные на месте. Удали PVC — проверь, что произошло с PV (зависит от reclaim policy).
5. Настрой CronJob бэкапа: ежедневный дамп в PVC с ротацией на 14 файлов. Сымитируй падение (`exit 1` в команде) и посмотри, как Job делает retry по `backoffLimit`.

## Что почитать

- [Kubernetes Documentation — Concepts](https://kubernetes.io/docs/concepts/) — поды, ворклоады, сеть, хранилище
- [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — первоисточник по пробам
- [kubectl Cheat Sheet](https://kubernetes.io/docs/reference/kubectl/cheatsheet/)
- [Assign Memory Resources to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/) и [CPU](https://kubernetes.io/docs/tasks/configure-pod-container/assign-cpu-resource/) — практика requests/limits
- [Configure a Pod to Use a PersistentVolume](https://kubernetes.io/docs/tasks/configure-pod-container/configure-persistent-volume-storage/)
