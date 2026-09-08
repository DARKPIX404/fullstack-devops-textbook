---
title: "Управление секретами и конфигурацией"
description: "12-factor config, валидация env через Zod, опасности .env и git, SOPS/age для репозиториев, Vault и динамические секреты, External Secrets Operator в Kubernetes, OIDC в CI вместо долгоживущих ключей, ротация и аудит."
---

В двух предыдущих главах ты поднял сервер Terraform'ом и настроил его Ansible'ом. Плейбук накатывает приложение, Nginx слушает 443-й порт, CI выкатывает релизы. И в какой-то момент возникает вопрос, который раньше решался стыдливо: а где лежит пароль к базе данных, который подставляется в `DATABASE_URL`? В варианте «по-быстрому» — в файле `.env` на сервере, написанном руками по SSH. В варианте «как у взрослых» — там, откуда его можно выдать, ограничить, отозвать и проверить, кто и когда читал.

Краткая версия учебника коснулась темы мимоходом: секреты — в CI-variables и `ansible-vault`, не в git. Этого хватает, чтобы не светить пароль в открытом репозитории, но не хватает, чтобы ответить на вопросы продакшена: как код на старте убеждается, что в env всё на месте? Как раздать секреты десятимикросервисному кластеру, не копируя их вручную через `kubectl create secret`?

Эта глава строится по принципу «от простого к сложному»: фундамент — конфигурация по [12-factor](https://12factor.net/config) и её валидация в коде; затем SOPS/age для секретов прямо в репозитории; дальше Vault с динамическими секретами, External Secrets Operator в Kubernetes и OIDC в CI вместо статических ключей. Финал — ротация и аудит, без которых всё остальное превращается в театр безопасности.

## Конфигурация по 12-factor: env как единственный источник

Третий фактор методологии 12-factor гласит: конфигурация, меняющаяся между деплоями (credentials к БД, токены внешних API, адреса очередей), хранится в **переменных окружения**, а не в коде и не в файлах, зашитых в артефакт. Аргумент простой: один и тот же Docker-образ должен проходить путь staging → prod без пересборки. Если пароль БД зашит в образ — придётся собирать два образа, и каждый несёт внутри чужой секрет.

Приложение не знает, откуда пришло значение: в Docker — `--env-file`, в docker-compose — `environment:`, в Kubernetes — через `envFrom` со ссылкой на Secret. Рантайм видит один интерфейс — переменные окружения, наполняемые при старте процесса.

:::tip[Разделяй config и secrets механизмом подачи]
Хороший паттерн: обычная конфигурация (порт, лог-уровень, имя очереди) живёт в ConfigMap, а секреты — только из Secret и только в env. Тогда аудит упрощается: «кто менял ConfigMap» — не критично, «кто читал Secret» — всегда событие.
:::

## Валидация env на старте: fail fast через Zod

Классика продакшена: приложение стартовало, `DATABASE_URL` был пустым, ORM подключилась к `localhost:5432` и падала с `ECONNREFUSED` через двадцать секунд таймаута. Под тремя репликами в Kubernetes — минуты недоступности и алерты, видные только в логах. Правильное поведение — **упасть на старте с читаемой ошибкой**: нет `DATABASE_URL` — процесс не поднимается, rollout откатывается.

Решается одним модулем, который выполняется первым, до инициализации БД и HTTP-сервера:

```ts
// src/config/env.ts — единственное место, где читается process.env
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().startsWith("postgres://"),
  REDIS_URL: z.string().url().startsWith("redis://"),
  // Токен для исходящих вызовов — минимальная длина, без значения по умолчанию
  PAYMENTS_API_KEY: z.string().min(32),
  // Публичные значения могут иметь дефолты, секретные — никогда
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

// Парсим один раз на старте. Провал — исключение до инициализации БД и HTTP
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Невалидная конфигурация окружения:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1); // fail fast: под не поднимется, деплой откатится
}

// Дальше по коду импортируем только готовый, типизированный объект
export const env = parsed.data;
```

Три приёма. Первый: **у секретов нет значений по умолчанию** — если `PAYMENTS_API_KEY` забыли выдать, приложение упадёт сразу, а не через полчаса при первом платеже. Второй: `z.coerce.number()` переводит строку из env в число. Третий: тип `env` выводится из схемы, поэтому опечатка в имени переменной ловится компилятором, а не сегфолтом в рантайме.

```ts
// src/db.ts — конфиг читаем только из валидированного объекта
import { env } from "./config/env.js";

export const db = createPool({ connectionString: env.DATABASE_URL });
```

## .env и git: как секреты утекают

Файл `.env` — удобный локальный формат, и проблема не в нём, а в том, как с ним обращаются. Разберём механику утечки по шагам — она почти всегда идёт одинаково:

1. Разработчик создаёт `.env` локально, кладёт туда реальный токен из staging.
2. `.env` нет в `.gitignore` — или есть, но файл закоммичен *до* того, как строку добавили.
3. Токен уезжает в репозиторий. Даже если удалить файл следующим коммитом, он остаётся в истории — `git log -p -- .env` его находит.
4. Если репозиторий хоть раз стал публичным, боты-сканеры находят секрет за минуты — по паттернам вроде `AKIA[0-9A-Z]{16}` для AWS-ключей, `ghp_` для GitHub-токенов.

Важно понимать: **удаление коммита не спасает** — коммит остался в истории, ветках форков, клонах коллег. Единственный честный ответ — **считать секрет скомпрометированным и отозвать**: сменить пароль БД, перевыпустить токен, отозвать ключ в облачной консоли.

Дополнительные ловушки `.env`: его копируют на серверы по scp «на пять минут» и забывают удалить; docker-compose поднимает его в контейнер, и секрет виден через `docker inspect`; `.env.example` коммитят, а потом правят, забыв убрать реальные значения. Защита: сканер в pre-commit ([gitleaks](https://github.com/gitleaks/gitleaks)), push protection, `.gitignore` с `.env*` — но это сети-ловушки, а не замена отзыву скомпрометированного секрета.

:::caution[.env — для локальной разработки, не для продакшена]
В проде `.env` не должен существовать как руками созданный файл. Секрет подаётся механизмом среды: переменные CI, Vault, External Secrets Operator. Если на сервере есть файл с секретами, который кто-то правит по SSH, — у тебя есть неотслеживаемый источник правды, и подробности — в главе про [инцидент-менеджмент](/12-iac-deploy-obs/incident-management/).
:::

## SOPS + age: секреты прямо в репозитории

От противоречия «секреты не в git» и «инфраструктура в git» есть элегантный выход: **хранить в репозитории зашифрованные секреты**. Тогда у секрета есть git-история, review изменений, откат версии — но прочитать его может только владелец ключа.

Два основных инструмента: [Mozilla SOPS](https://getsops.io/) — шифровальщик YAML/JSON/ENV, и [age](https://age-encryption.org/) — современная замена GPG: один публичный ключ-строка, один приватный файл, никакой инфраструктуры доверия. Для небольших команд это стандарт де-факто, куда проще Vault.

```bash
# age-keygen выдаёт файл с приватным ключом и комментарием с публичным
age-keygen -o key.txt
# Public key: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
# key.txt — в .gitignore и в password manager, публичный ключ — в репозиторий
```

Приватный ключ — единственное, что не лезет в git: его хранят в менеджере паролей команды и подкладывают в CI через secrets (`SOPS_AGE_KEY`). Какие файлы шифровать и на чей ключ — задаёт `.sops.yaml` в корне репозитория:

```yaml
# .sops.yaml — правила шифрования: маска файла → список получателей
creation_rules:
  - path_regex: secrets/staging/.*\.yaml$
    age: age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq
  - path_regex: secrets/prod/.*\.yaml$
    # Для prod добавь ключ второго инженера: расшифрует любой из владельцев
    age: age1qqqq...,age1abcd...
```

Исходный файл — обычный YAML с реальными значениями. Шифруется одной командой, в git уезжает только шифртекст:

```bash
# secrets/staging.yaml — ДО шифрования; открытым он никогда не коммитится
cat > secrets/staging.yaml <<'EOF'
database:
  url: postgres://app:staging-password-123@db.internal:5432/app
payments:
  api_key: staging-payments-key-with-32-chars-minimum
EOF

sops --encrypt --in-place secrets/staging.yaml
```

```yaml
# secrets/staging.yaml — ПОСЛЕ sops --encrypt (так и хранится в git)
database:
    url: ENC[AES256_GCM,data:K7v...==,iv:...,tag:...,type:str]
payments:
    api_key: ENC[AES256_GCM,data:Xm2...==,iv:...,tag:...,type:str]
sops:
    age:
        - recipient: age1qqqq...
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            ...
            -----END AGE ENCRYPTED FILE-----
    # Метаданные sops: кому зашифровано, MAC — для контроля целостности
```

Ключевое свойство SOPS: шифруются **только значения**, ключи и структура остаются открытыми. Code review показывает: «в этом PR поменялся `database.url` для staging» — без раскрытия самого значения. Расшифровка — в момент использования:

```bash
# Локально — через переменную с приватным ключом
export SOPS_AGE_KEY_FILE=~/keys/sops-key.txt
sops --decrypt secrets/staging.yaml | kubectl apply -f -

# В CI — ключ из secrets, использование и забывание в рамках одного job'а
echo "$SOPS_AGE_KEY" > /tmp/sops-key && chmod 600 /tmp/sops-key
export SOPS_AGE_KEY_FILE=/tmp/sops-key
sops -d secrets/staging.yaml > /tmp/secrets.yaml && rm /tmp/sops-key
```

Приватный ключ SOPS — тоже секрет, просто один на команду вместо десятков: его компрометация вскрывает все файлы. Поэтому для prod добавляй второго получателя и перешифровывай (`sops updatekeys`) после изменений в составе команды.

## Vault: хранилище с доступом по политикам и динамические секреты

SOPS хорош, пока секретов немного. Когда сервисов много, возникают вопросы, на которые он не отвечает: кто имел доступ к секрету в прошлом месяце? Как выдать пароль к БД на четыре часа, а не навсегда? Как отозвать доступ ушедшего разработчика?

[HashiCorp Vault](https://www.vaultproject.io/) решает это, вводя **сервер секретов**: единственную точку, которая умеет выдавать, ограничивать, отзывать и журналировать доступ. Архитектура на словах проста: приложение аутентифицируется в Vault по какому-то фактору (Kubernetes ServiceAccount, IAM-роль, токен), получает краткоживущий Vault-токен с набором политик, разрешающих доступ к определённым путям, — и читает секреты по API.

Поднимем dev-сервер — один бинарь без конфигурации, в памяти, для экспериментов:

```bash
# Dev-сервер: in-memory, root-токен прямо в выводе, перезапуск = чистый лист
vault server -dev

# В выводе пригодятся:
# Root Token: hvs.XXXXXXXXXXXXXXXX  (в dev — root, в prod его разбирают на политики)
# Unseal Key: ...                   (ключи раскрытия хранилища — отдельная механика)
```

Dev-режим полезен, чтобы пощупать механику, но ограничен: всё в памяти, один root-токен на всё, нет ни аудита, ни высокой доступности. Продовый Vault — отдельный проект: автоматический unseal через KMS или Shamir-разделение ключей, кластер из нод, storage backend, TLS, политики.

### Идея динамических секретов

Главная фишка Vault, которую невозможно повторить файлами, — **динамические секреты**. Вместо хранения одного вечного пароля Vault при запросе сам идёт в PostgreSQL, создаёт пользователя с ограниченным TTL и отдаёт его приложению. По истечении срока — или сразу при отзыве — пользователь удаляется.

```
Приложение ──► Vault (auth: k8s SA) ──► PostgreSQL: CREATE USER ... VALID UNTIL 'now+1h'
    ◄───── credentials: u_token_xxx / p_token_yyy ──────◄
```

```bash
# Включаем движок баз данных и настраиваем роль с TTL
vault secrets enable database
vault write database/config/pet-db \
    plugin_name=postgresql-database-plugin \
    connection_url="postgresql://{{username}}:{{password}}@db.internal:5432/postgres" \
    allowed_roles=["app"] \
    username="vault-admin" password="<пароль служебной учётки>"

vault write database/roles/app \
    db_name=pet-db \
    creation_statements="CREATE ROLE \"{{name}}\" LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
    default_ttl="1h" max_ttl="24h"

# Приложение при старте получает уникальную пару на час
vault read database/creds/app
# Key                Value
# ---                -----
# lease_id           database/creds/app/AbCdEf...
# lease_duration     1h
# data.username      v-token-app-AbCd-x1
# data.password      A9f...   # существует только в Postgres, Vault его не хранит постоянно
```

Заметь: пароль появляется без участия человека и не существует ни в одном файле — ни в репозитории, ни в `.env`, ни в CI. Утечка ограничена часом жизни, а выдача привязана к идентичности запросившего: не «вечный файл с паролем».

:::note[Vault — это не только про секреты]
Та же механика с TTL и отзывом работает для облачных ключей (Vault выпускает временную пару AWS access key/secret), PKI-сертификатов (TLS-сертификат на домен на 30 дней) и SSH (одноразовые ключи для хостов). Общий принцип: секрет с временем жизни и точкой отзыва бьёт статический секрет по всем параметрам, кроме простоты.
:::

## External Secrets Operator: секреты в Kubernetes без ручного kubectl

В Kubernetes секреты — объекты `Secret`, и антипаттерн номер один — создавать их руками: `kubectl create secret generic db --from-literal=password=...`. Такой секрет живёт в etcd (по умолчанию незашифрованным!), не имеет истории, никто не знает, кто и когда его создал, а при пересоздании кластера не восстанавливается. Хранилище — Vault или облачный Secrets Manager — должно оставаться источником правды.

[External Secrets Operator](https://external-secrets.io/) (ESO) строит мост: оператор в кластере периодически читает секреты из хранилища и синхронизирует их в нативные `Secret`. Приложения видят привычный `envFrom: secretRef` и не знают ни о Vault, ни об операторе.

```yaml
# 1. ClusterSecretStore — как кластер подключается к Vault
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "http://vault.vault.svc:8200"
      path: "secret"            # KV-движок
      version: "v2"
      auth:
        kubernetes:             # аутентификация по ServiceAccount пода
          mountPath: "kubernetes"
          role: "pet-app"
          serviceAccountRef:
            name: pet-app-sa
            namespace: prod
---
# 2. ExternalSecret — что именно и куда синхронизировать
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: pet-app-secrets
  namespace: prod
spec:
  refreshInterval: "1m"         # оператор перечитывает хранилище раз в минуту
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: pet-app-secrets       # так будет называться нативный Secret
  data:
    - secretKey: DATABASE_URL   # ключ в Kubernetes Secret
      remoteRef:
        key: prod/pet-app       # путь в Vault
        property: database_url  # поле внутри KV-v2
---
# 3. Deployment — приложение видит обычный Secret
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pet-app
  namespace: prod
spec:
  template:
    spec:
      serviceAccountName: pet-app-sa
      containers:
        - name: app
          image: registry.example.com/pet-app:1.4.2
          envFrom:
            - secretRef:
                name: pet-app-secrets   # управляется ESO, руками не трогаем
```

Плюсы схемы: ротация в Vault автоматически доезжает в поды в течение `refreshInterval`; отзыв секрета в хранилище — через минуту и в кластере; аудит чтений — на стороне Vault, а не размазан по истории bash на админских машинах.

## CI/CD: OIDC вместо долгоживущих ключей

Последний участник — CI. Классика: в переменных репозитория лежат `AWS_ACCESS_KEY_ID` и `AWS_SECRET_ACCESS_KEY` IAM-пользователя с правами на деплой. Ключи живут месяцами, видны всем job'ам, а при утечке дают полный доступ до ручного отзыва.

Замена — **OIDC (OpenID Connect)**: CI при каждом запуске обменивает свой identity-токен на временные облачные credentials. Ключей не существует до запуска и после: ничего хранить, ничего ротировать, утечке нечему быть. В GitHub Actions это выглядит так:

```yaml
# .github/workflows/deploy.yml
permissions:
  id-token: write   # разрешаем job'у выпрашивать OIDC-токен GitHub
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Вместо хранения AWS_ACCESS_KEY_ID: обмен OIDC-токена на временные credentials
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-deploy-pet
          aws-region: eu-central-1
          role-session-name: github-actions-${{ github.run_id }}  # для аудита в CloudTrail

      # Временные credentials уже в окружении: живут ~1 час, привязаны к этому запуску
      - run: aws s3 sync ./dist s3://pet-app-static
      - run: aws ecs update-service --cluster pet --service api --force-new-deployment
```

Со стороны облака настраивается **trust policy роли**: AWS принимает токен только от конкретного репозитория и environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:darkpix/pet-project:environment:production"
        }
      }
    }
  ]
}
```

Условие по `sub`-клейму — самое важное: роль получит только запуск из environment `production` нашего репозитория. Pull request из форка токен получить не сможет. Заодно в CloudTrail видно ровно: какой коммит, какого workflow, какого run'а выполнил деплой.

## Ротация и аудит

Всё вышеперечисленное сводится к двум вопросам: **как быстро мы можем заменить секрет** (ротация) и **как узнаём, что кто-то дотронулся** (аудит). Требование к ротации: возможность замены без простоя и желательно автоматизм. Если смена пароля к БД требует «зайти на сервер, поправить `.env`, перезапустить сервис» — секрет будут менять только после инцидента. В схеме с динамическими секретами ротация происходит сама при каждом запуске; с SOPS — скриптом, перешифровывающим файлы; в CI с OIDC — автоматически, потому что долгоживущих ключей нет.

Аудит отвечает на вопросы: кто читал этот секрет? Когда в последний раз использовался этот доступ? Источники: журнал хранилища (Vault audit device пишет каждый запрос: токен, путь, время), RBAC-аудит Kubernetes, облачный аудит (CloudTrail покажет использование ролей). Регулярная процедура: раз в квартал выгрузить список секретов и доступов, проверить, что у каждого есть владелец, последнее использование не «два года назад» и способ ротации задокументирован. Мёртвые секреты — компромисс без пользы: чем их больше, тем труднее заметить живую утечку.

## Типичные ошибки и грабли

1. **Секреты с дефолтными значениями в коде.** `process.env.DATABASE_URL || "postgres://localhost/app"` — приложение стартует с «удобным» локальным паролем и падает странно в проде, а то и молча подключается к неправильной БД. Хорошо: валидация env без дефолтов для секретов.
2. **«Удалил файл из git — секрет спасён».** Нет: история коммитов, форки и клоны уже содержат его. Хорошо: немедленный отзыв (перевыпуск пароля/токена) — единственный ответ; gitleaks в pre-commit и push protection — профилактика.
3. **Один SOPS/age-ключ на все окружения и всю команду.** Компрометация одного файла вскрывает и staging, и prod; ушедший разработчик сохраняет доступ. Хорошо: разные получатели для prod, ключ минимум у двоих, `sops updatekeys` после изменений в команде.
4. **Vault dev в проде.** Dev-сервер — in-memory, root-токен в логах, нет ни TLS, ни аудита; перезапуск стирает всё. Хорошо: dev — только для изучения механики; прод — кластер с автоматическим unseal и политиками.
5. **Ручное `kubectl create secret` как «временное» решение.** Секрет в etcd без истории, вне хранилища и вне пайплайна; через месяц никто не помнит его значение, но приложение продолжает его читать. Хорошо: External Secrets Operator с первого дня кластера.
6. **Долгоживущие облачные ключи в CI «пока не дошли руки до OIDC».** Ключи живут месяцами, доступны всем job'ам, утечка из лога = полный доступ до ручного отзыва. Хорошо: OIDC + trust policy с условием на `sub`.
7. **Секреты в build-аргументах и слоях образа.** `ARG DB_PASSWORD` в Dockerfile — пароль остаётся в слое и виден через `docker history` любому, кто получил образ. Хорошо: секреты только на этапе runtime через env, никогда на этапе build.

## Вопросы на собеседование

1. **Что говорит 12-factor про конфигурацию?** Конфигурация, меняющаяся между деплоями (credentials, URL внешних сервисов), хранится в env, а не в коде или зашитых в артефакт файлах. Следствие: один собранный образ проходит staging → prod без пересборки — значит, без риска собрать «другой» бинарь на прод.
2. **Зачем валидировать env на старте?** Fail fast: невалидный или отсутствующий секрет обнаруживается до инициализации БД и HTTP-сервера, деплой откатывается чисто. Чтение env в трёх местах кода даёт опечатки и дефолты-«обезьянки», маскирующие отсутствие секрета до первого запроса.
3. **Секрет попал в git-историю. Твои действия?** Немедленно считать его скомпрометированным: отозвать/перевыпустить (сменить пароль БД, отозвать токен). Удаление файла или переписывание истории токен не отозовёт — клоны и форки его уже содержат. Потом — разбор, как попал и почему не сработали gitignore/gitleaks/push protection.
4. **Чем SOPS+age отличается от Vault и когда выбрать каждый?** SOPS+age — шифрование файлов в репозитории: просто, git-нативно, без инфраструктуры; подходит для небольших команд. Vault — централизованный сервис с выдачей по политикам, TTL, динамическими секретами и аудитом; окупается при множестве сервисов и необходимости отзыва без перешифрования репозитория.
5. **Что такое динамический секрет и в чём его преимущество?** Секрет, создаваемый хранилищем в момент запроса и имеющий время жизни: Vault при запросе создаёт пользователя в PostgreSQL на час и удаляет его по истечении TTL. Утечка ограничена TTL, отзыв = удаление учётки, а «вечного» пароля, который можно украсть из файла, не существует.
6. **Как External Secrets Operator решает проблему секретов в Kubernetes?** ESO синхронизирует секреты из внешнего хранилища в нативные Secret по расписанию: хранилище остаётся источником правды с аудитом и ротацией, приложения видят обычные Secret. Убирает ручное `kubectl create secret` — главный источник «невидимых» секретов в etcd.
7. **Чем OIDC в CI лучше хранения AWS-ключей в secrets?** Job обменивает identity-токен CI на временные credentials — долгоживущих ключей нет в принципе, утечке нечему быть, ротация не нужна. Trust policy ограничивает, кто получит роль (repo/branch/environment), закрывая и fork-атаки.

## Практика

1. Подключи SOPS+age к репозиторию pet-проекта: сгенерируй ключ, добавь `.sops.yaml` с правилом для `secrets/*.yaml`, создай `secrets/staging.yaml` с `DATABASE_URL` и API-ключом платёжки, зашифруй и закоммить. Критерий: значения — `ENC[AES256_GCM,...]`, структура читается; `git grep -i password` не находит открытых значений; расшифровка через `SOPS_AGE_KEY_FILE` выдаёт исходник.
2. Настрой CI-джобу, которая расшифровывает `secrets/staging.yaml` и кладёт значения в окружение деплоя. Ключ — из CI-secrets, временный файл с правами 0600 удаляется в `post:`-секции. Критерий: job зелёный, в логах нет ни значений секретов, ни пути к ключу.
3. Подними Vault dev-сервер, включи KV-v2 на пути `secret/`, положи секрет `secret/prod/pet-app` с ключом `database_url`. Разверни External Secrets Operator в локальном kind/minikube-кластере, создай `ClusterSecretStore` и `ExternalSecret` в namespace `prod`. Критерий: `kubectl get secret pet-app-secrets -n prod` показывает `DATABASE_URL` со значением из Vault; удаление секрета в Vault через `refreshInterval` убирает его из кластера.
4. Переведи GitHub Actions-деплой на OIDC: создай IAM-роль с trust policy на `repo:<твой>:environment:production`, убери `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` из переменных, используй `configure-aws-credentials`. Критерий: деплой работает, в CloudTrail виден `role-session-name` с ID запуска, `assume-role` из fork'а или другой ветки отклоняется условием trust policy.
5. Напиши скрипт ротации для схемы SOPS: принимает список файлов, перешифровывает их на новый набор ключей (`sops updatekeys`), коммитит изменение. Прогони на копии репозитория: старый ключ больше не расшифровывает файлы, новый — расшифровывает.
6. Проведи аудит: выгрузи все Secret в кластере (`kubectl get secrets -A`), все IAM-ключи с доступом к деплою и запусти `gitleaks detect` по репозиториям. Для каждого секрета зафиксируй владельца, последнее использование и способ ротации. Критерий: у каждого секрета есть владелец и документированная замена.

## Что почитать

- [The Twelve-Factor App: Config](https://12factor.net/config) — фактор III, на котором строится вся глава
- [SOPS](https://getsops.io/) — шифрование YAML/JSON/ENV в репозитории, документация по `.sops.yaml`
- [age](https://age-encryption.org/) — современное шифрование файлов, на котором построен SOPS
- [HashiCorp Vault](https://www.vaultproject.io/docs) — auth-методы, секретные движки, динамические секреты для БД
- [External Secrets Operator](https://external-secrets.io/) — синхронизация внешних хранилищ в Kubernetes Secrets
- [GitHub Actions: OIDC в AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services) — обмен identity-токена на временные credentials
