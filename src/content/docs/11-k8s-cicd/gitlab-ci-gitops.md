---
title: "GitLab CI и GitOps"
description: "Полный .gitlab-ci.yml: stages, rules/when, artifacts против cache, docker:dind против kaniko, runner'ы, безопасность пайплайна через Trivy и Snyk и GitOps: pull против push, ArgoCD, app-of-apps, Flux и бамп тега образа в инфра-репозитории."
---

Если GitHub Actions — оркестратор экшенов, то GitLab CI — оркестратор job'ов, описанных одним файлом. Синтаксис иной, концепции те же: стадии, кэш, артефакты, матрицы, секреты. Но главный сюжет этой главы — не синтаксис, а **GitOps**: способ деплоя, при котором CI теряет прямой доступ к кластерам, а правда о состоянии системы живёт в git. Это то, как деплоят системы, которым нельзя просто «не работать сегодня».

## Анатомия .gitlab-ci.yml

Полный пример для Node.js-приложения с безопасностью и GitOps-финалом:

```yaml
# .gitlab-ci.yml
stages: [lint, test, build, scan, deploy]

variables:
  IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
  DOCKER_TLS_CERTDIR: "/certs"          # TLS между клиентом и dind-сервисом

# ── Тесты: кэш node_modules между job'ами пайплайна ─────────────────
lint:eslint:
  stage: lint
  image: node:22-alpine
  script:
    - npm ci
    - npm run lint
  cache:
    key: $CI_COMMIT_REF_SLUG            # имя ветки: кэш общий для всех job'ов ветки
    paths: [node_modules/]

test:unit:
  stage: test
  image: node:22-alpine
  script:
    - npm ci
    - npm test -- --coverage
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths: [node_modules/]
  artifacts:                             # отчёт покрытия гарантированно доступен дальше
    when: always
    paths: [coverage/]
    expire_in: 1 week

# ── Сборка образа: docker-in-docker ─────────────────────────────────
build:image:
  stage: build
  image: docker:27
  services: [docker:27-dind]             # отдельный под-контейнер с Docker daemon
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
    - docker build --pull -t $IMAGE .
    - docker push $IMAGE
  rules:
    - if: $CI_COMMIT_BRANCH == "main"    # образы собираем только из main
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: manual                       # в MR — по кнопке (проверка Dockerfile)

# ── Сканирование ────────────────────────────────────────────────────
scan:trivy:
  stage: scan
  image: aquasec/trivy:latest
  script:
    - trivy image --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed $IMAGE
    - trivy fs --severity HIGH --exit-code 1 .
  rules:
    - if: $CI_COMMIT_BRANCH == "main"

# ── GitOps: бамп тега в инфра-репозитории ───────────────────────────
deploy:gitops:
  stage: deploy
  image: alpine/git:latest
  script:
    - git clone --depth 1 https://gitlab-ci-token:$INFRA_TOKEN@gitlab.darkpix.dev/infra/pet-infra.git
    - cd pet-infra
    - sed -i "s|image: .*pet-api:.*|image: $IMAGE|" apps/api/deployment.yaml
    - |
      git config user.name "ci-bot"
      git config user.email "ci@darkpix.dev"
      git commit -am "deploy(api): $CI_COMMIT_SHORT_SHA [skip ci]"
      git push
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

### rules/when: дешёвый аналог if

`rules` — список условий, ищется первое совпадение сверху вниз; несовпадение всех — job пропущен. `when: manual` — пауза до нажатия, `when: never` — явный запрет, `changes:` — path-filter (только если поменялись файлы):

```yaml
deploy:gitops:
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
      when: never                          # никогда из расписания
    - if: $CI_COMMIT_BRANCH == "main"
      changes: [apps/api/**, .gitlab-ci.yml] # только если тронули api
```

:::tip[Метка «skip ci» важна]
Коммит-бамп от CI, пушащий в инфра-репозиторий, запускает пайплайн там — бесконечный цикл. `[skip ci]` в сообщении коммита гасит триггер. Проверь, что в инфра-репо нет webhook-запуска, игнорирующего этот флаг.
:::

### Artifacts против cache

Путаница номер один в GitLab CI. Механика разная:

| | **cache** | **artifacts** |
|---|---|---|
| Назначение | Ускорение: `node_modules` между job'ами и пайплайнами | Передача результата: бинарники, отчёты, покрытие |
| Гарантия | Нет: может отсутствовать, ключ устарел | Да: скачивается `needs` job'ами и после прогона |
| Ключ | Свой (ветка, lockfile) | Привязан к job'у |
| Скачивание | Автоматически (если ключ совпал) | `needs: [job]` или вручную |

Практика: `node_modules/` — кэш (если пропал — `npm ci` просто дольше), `coverage/`, `dist/` — артефакты. Секреты — никогда ни в кэш, ни в артефакты: `.dockerignore` и `.gitignore` в артефактах проверяй дважды.

### docker:dind против kaniko

Сборка внутри контейнера — известная боль. Три пути:

```yaml
# Вариант 1: docker-in-docker — демон как сервис (как выше).
# + Привычный docker build; — привилегированный режим, тяжело, требует TLS.

# Вариант 2: kaniko — сборка без демона, userspace, без привилегий.
build:kaniko:
  stage: build
  image:
    name: gcr.io/kaniko-project/executor:v1.23.2-debug
    entrypoint: [""]
  script:
    - mkdir -p /kaniko/.docker
    - echo "{\"auths\":{\"$CI_REGISTRY\":{\"auth\":\"$(echo -n $CI_REGISTRY_USER:$CI_REGISTRY_PASSWORD | base64)\"}}}" > /kaniko/.docker/config.json
    - /kaniko/executor
        --context $CI_PROJECT_DIR
        --destination $IMAGE
        --cache=true                        # кэш слоёв в registry

# Вариант 3: buildah — аналог kaniko, стандарт OpenShift.
```

Для shared runner'ов без privileged-режима kaniko — единственный вариант. Для своего runner'а dind удобнее и быстрее (слоёный кэш buildx лучше). Kaniko-кэш живёт в registry (`--cache=true`) — работает даже с чистыми runner'ами.

### Runner'ы

Job'ы исполняет **runner** — агент, опрашивающий GitLab. Типы:

- **Shared** (gitLab.com) — чужие машины, ограничения по минутам, не для приватного кода с секретами.
- **Specific/Group/Project runner** — свой. Классика: Docker executor (каждый job — контейнер на хосте), shell executor (job'ы прямо на хосте), Kubernetes executor (job'ы — поды в кластере, автомасштабирование).

```bash
# Регистрация (docker executor)
gitlab-runner register \
  --url https://gitlab.darkpix.dev \
  --token glrt-xxxxxxxx \
  --executor docker \
  --docker-image alpine:latest \
  --docker-volumes /var/run/docker.sock:/var/run/docker.sock
```

Ключевые теги в конфиге: `concurrent` (сколько job'ов параллельно), `limit` на проект, кэш через S3 (`[runners.cache]`) — дефолтный локальный кэш виден только одному runner'у, с S3 — всеми. Untagged job'ы: решай явно, брать ли их на runner (по умолчанию — нет, тег `run_untagged = false`).

## Безопасность в пайплайне

Сканирование — стадия между сборкой и деплоем. **Trivy** — два режима: образ (OS-пакеты + зависимости приложения) и filesystem (IaC-конфиги: Dockerfile, .gitlab-ci.yml, манифесты K8s):

```yaml
scan:trivy-image:
  stage: scan
  image: aquasec/trivy:0.57.1
  script:
    - trivy image --severity CRITICAL,HIGH --exit-code 1
        --ignore-unfixed --format table $IMAGE
  # отчёт артефактом для аудита
  after_script:
    - trivy image --severity CRITICAL,HIGH --format json -o trivy-report.json $IMAGE || true
  artifacts: { when: always, paths: [trivy-report.json], expire_in: 4 weeks }
```

**Snyk** (кратко): глубже по зависимостям — умеет анализировать license compliance, remediation-советы («обнови до 2.3.1, там фикс») и мониторить уже задеплоенные образы. Платный для коммерческого использования, для pet-проекта — бесплатный tier:

```yaml
scan:snyk:
  stage: scan
  image: node:22-alpine
  script:
    - npm install -g snyk
    - snyk test --severity-threshold=high
    - snyk container test $IMAGE --severity-threshold=high
  variables:
    SNYK_TOKEN: $SNYK_TOKEN          # masked + protected variable в настройках проекта
```

Секреты в GitLab: **CI/CD Variables** с флагами `masked` (не показывать в логах) и `protected` (только на protected-ветках — т.е. в main). Правило: токены с минимальными правами (deploy-роль в registry, бранч-протекшн на main), срок жизни — короткий, аудит использования — включённый.

## GitOps: pull против push

Классический деплой из CI — **push**: пайплайн берёт креденшелы кластера и что-то меняет (`kubectl apply`, `helm upgrade`, `ssh docker pull`). Проблемы: креденшелы живут в CI (утечка = доступ к проду), история «что сейчас в кластере» неизвестна (кто-то мог применить манифест руками), откат — ручной.

**GitOps (pull)**: CI лишь пушит новый тег образа в *инфра-репозиторий* (как job `deploy:gitops` выше). Агент в кластере — **ArgoCD** или **Flux** — следит за репозиторием и **сам** приводит кластер к состоянию из git. Креденшелов кластера в CI нет вообще: кластер тянет, а не CI толкает.

```text
  PUSH-модель                    PULL-модель (GitOps)
┌────────┐  kubectl apply ┌──────────┐     ┌────────┐ commit    ┌──────────┐
│   CI   │ ─────────────► │  Кластер │     │   CI   │ ────────► │ Infra git│
│(секреты│                │(секреты! │     │(только │           │(правда!) │
│ кластер│◄────────────── │          │     │  push) │           │          │
└────────┘                └──────────┘     └────────┘           └────┬─────┘
                                                                     │ watch+pull
                                                                ┌────▼─────┐
                                                                │  ArgoCD  │
                                                                │ в кластере│
                                                                └────┬─────┘
                                                                ┌────▼─────┐
                                                                │  Кластер │
                                                                └──────────┘
```

Бонусы: откат = `git revert` (история деплоев — история git), дрейф конфигурации сам подсвечивается (OutOfSync в ArgoCD), кластер доступен только изнутри.

### ArgoCD: установка и Application

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd port-forward svc/argocd-server 8080:443
# пароль: kubectl -n argocd get secret argocd-initial-admin-secret \
#   -o jsonpath='{.data.password}' | base64 -d
```

Минимальный Application (декларативное описание «следи за этим git, приводи этот namespace к нему»):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: pet-api
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://gitlab.darkpix.dev/infra/pet-infra.git
    targetRevision: main
    path: apps/api
  destination:
    server: https://kubernetes.default.svc   # свой кластер
    namespace: pet
  syncPolicy:
    automated:                    # автосинхронизация: увидел diff — применил
      prune: true                 # удалять ресурсы, удалённые из git
      selfHeal: true              # лечить дрейф (ручные правки в кластере)
    syncOptions: [CreateNamespace=true]
    retry: { limit: 5, backoff: { duration: 5s, factor: 2, maxDuration: 3m } }
```

Теперь цикл деплоя: CI бампает тег в `apps/api/deployment.yaml` инфра-репозитория → ArgoCD видит diff (polling каждые 3 минуты или webhook) → синхронизирует. Откат плохого релиза: `git revert` коммита бампа — ArgoCD сам вернёт старый образ. Ручной `kubectl set image` теперь бессмысленен: selfHeal вернёт состояние из git за 3 минуты — а это фича, а не баг.

### App-of-apps и Flux кратко

Когда приложений много, Application'ы становятся boilerplate. **App-of-apps**: один корневой Application следит за директорией, в которой лежат Application'ы (helm-чартом или простыми манифестами) — ArgoCD рекурсивно разворачивает их:

```
pet-infra/
├── root-application.yaml      # Application на всю директорию clusters/
└── clusters/prod/
    ├── pet-api.yaml           # Application (api)
    ├── pet-frontend.yaml      # Application (frontend)
    ├── monitoring.yaml        # Application (kube-prometheus-stack)
    └── argocd.yaml            # Application (сам ArgoCD — self-management)
```

Плюс отделение сред: **ApplicationSet** генерирует Application на каждый кластер/окружение из шаблона + списка сред (dev/stage/prod) — одна правда, три кластера.

**Flux** — альтернатива от CNCF (тот же pull, иная реализация): не GUI, а набор контроллеров (source-controller, kustomize-controller, helm-controller, notification-controller); состояние в CRD `GitRepository` + `Kustomization`/`HelmRelease`. Выбор: ArgoCD — визуализация и управление из UI, богатые sync-стратегии; Flux — «всё кодом», нативный GitOps-нрав, легче старт в существующем кластере. Механика одна, термины разные.

## Типичные ошибки и грабли

1. **Артефакты вместо кэша для `node_modules`.** Артефакт пересобирается каждый job и перекачивается целиком — медленнее, чем честный `npm ci` без кэша. node_modules — кэш, результаты — артефакты.
2. **dind без TLS (`DOCKER_TLS_CERTDIR`).** Демон с открытым API на 2375 — любой job в сети runner'а рутовый доступ к хосту. Всегда TLS-директория, либо kaniko.
3. **Кэш слоёв Docker «из коробки» нет.** dind стартует чистым каждый раз; слои теряются. Кэшируй: kaniko `--cache=true`, buildkit с registry-кэшем, или `docker:buildx` с экспортом кэша в registry.
4. **Ручной `kubectl apply` в обход ArgoCD.** SelfHeal молча откатит. Изменения — только через git. Прямой доступ к кластеру для разработчиков убирай вовсе (а доступ CI — в предыдущем пункте).
5. **CI пушит в main инфра-репозитория без проверки.** Сломанный манифест уронит прод при автосинке. Включи в инфра-репо: обязательный MR + `kubeval`/`kube-linter` в пайплайне + branch protection.
6. **Тег `:latest` в GitOps-репозитории.** ArgoCD сравнивает состояние; `latest` не меняется при новых пушах в registry (тег перезаписывается, манифест — нет), и синхронизация не срабатывает. Всегда иммутабельные теги: `$CI_COMMIT_SHORT_SHA` или semver.
7. **`[skip ci]` забыт на бамп-коммите.** Пайплайн в инфра-репе запускается, пытается бампнуть то же самое, конфликт пуша. Мелочь, а отлаживать больно — особенно ночью.

## Вопросы на собеседовании

1. **Artifacts против cache в GitLab CI?** Cache — оптимизация без гарантий (общий по ключу, может отсутствовать). Artifacts — гарантированная передача результатов job'а следующим и после прогона, с ограниченным временем жизни.
2. **dind против kaniko?** dind — полноценный демон, быстрый, но требует privileged-режима и TLS. kaniko — userspace-сборка без демона и привилегий, кэш в registry; безопаснее на shared-инфраструктуре, чуть ограниченнее по директивам Dockerfile.
3. **rules против only/except?** `rules` — современный механизм: первое совпавшее правило побеждает, комбинирует условия (if/changes/exists/when). `only/except` — legacy с двусмысленной семантикой OR. В новых конфигах — только rules.
4. **В чём суть GitOps и чем pull лучше push?** Правда о состоянии в git; агент в кластере сам приводит его к git-ревизии. Креденшелов кластера в CI нет, откат = revert, дрейф виден и лечится автоматически.
5. **Как ArgoCD узнаёт об изменениях?** Polling репозитория (по умолчанию 3 мин) или webhook из GitLab/GitHub; дальше diff текущего состояния кластера (live) с желаемым (git) и синхронизация по syncPolicy.
6. **Что такое app-of-apps?** Паттерн: корневой Application следит за директорией, содержащей другие Application'ы — декларативное управление самими приложениями ArgoCD (GitOps для GitOps-конфигурации).
7. **Зачем selfHeal и prune?** selfHeal возвращает ручные правки в кластере к git-состоянию (борьба с дрейфом), prune удаляет ресурсы, исчезнувшие из git. Без них кластер и git расходятся незаметно.
8. **ArgoCD против Flux?** Одна механика (pull из git в кластер), разная реализация: ArgoCD — сервер с UI, визуальный diff, Application CRD; Flux — набор контроллеров, всё через GitRepository/Kustomization CRD, без UI из коробки.

## Практика

1. Разверни GitLab Runner (docker executor) на VPS, зарегистрируй в проекте. Прогони пайплайн из главы, сравни: job с кэшем против job без (удали ключ кэша) — разница во времени.
2. Перепиши `build:image` на kaniko с `--cache=true`. Сделай пять сборок подряд: первую после изменения кода, вторую без изменений. Объясни по логам, какие слои взяты из кэша.
3. Добавь Trivy: собери образ со старой версией пакета (`npm i lodash@4.17.15`), убедись, что scan падает с `exit-code 1` и артефакт-отчёт содержит CVE.
4. Установи ArgoCD в k3s/kind, вынеси манифесты Deployment+Service в инфра-репозиторий, создай Application с automated+selfHeal. Сделай деплой через бамп тега из CI (или руками в git), проверь синхронизацию в UI.
5. Инциент-учение: отредактируй Deployment руками (`kubectl scale`), посмотри на OutOfSync в ArgoCD, дождись selfHeal. Затем удали ресурс из git — проверь prune. Наконец, откати деплой `git revert` бамп-коммита.

## Что почитать

- [GitLab CI/CD YAML reference](https://docs.gitlab.com/ee/ci/yaml/) — полный справочник ключей
- [GitLab Runners](https://docs.gitlab.com/runner/) — executors, кэш через S3, регистрация
- [Trivy](https://trivy.dev/latest/) — image/fs/config сканирование
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/en/stable/) — core concepts, Application, app-of-apps, ApplicationSet
- [Flux CD](https://fluxcd.io/flux/) — альтернативная реализация GitOps
