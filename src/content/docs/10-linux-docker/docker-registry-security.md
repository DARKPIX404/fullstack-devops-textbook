---
title: "Реестры образов и безопасность контейнеров"
description: "Docker Hub, GHCR, Gitea и собственный registry 2.0 с TLS и htpasswd. Trivy-сканирование, подпись Cosign, non-root, read-only, capabilities drop, seccomp/AppArmor и runtime-лимиты."
---

Образ — это артефакт доставки, а реестр — его склад. Секунда между `docker push` и `docker pull` на проде — это цепочка доверия: кому ты веришь настолько, чтобы исполнять его бинарник на своих серверах? В краткой версии ты видел теги и GHCR; здесь — полная картина: собственный registry с TLS и аутентификацией, сканирование на уязвимости, криптографическая подпись и жёсткий runtime-контур, где даже скомпрометированное приложение не может навредить соседям.

:::note[Ментальная модель безопасности]
Защита контейнера — это луковица слоёв: доверенная сборка (подписанный, просканированный образ) → ограниченный запуск (non-root, read-only, capabilities drop) → лимиты (cgroups, seccomp/AppArmor). Каждый слой сдерживает атаку, которую пропустил предыдущий. Ни один слой не является «достаточным».
:::

## Ландшафт реестров

**Docker Hub** — дефолт индустрии. Образы по имени без registry-префикса (`nginx:1.27`) тянутся отсюда. Плюсы: всё есть. Минусы: rate limits на анонимный pull (100 запросов/6ч на IP), публичность, supply-chain-риски (загрязнённые «популярные» имена). Для прод-образов — всегда префикс с твоим namespace и точные теги.

**GitHub Container Registry (ghcr.io)** — registry внутри GitHub. Ключевая фишка: `GITHUB_TOKEN` в Actions уже имеет право пушить в `ghcr.io/<org>/<repo>` — отдельные credentials не нужны. OIDC-сценарии и тонкие права на уровне пакета.

**Gitea Registry** — встроен в self-hosted Gitea. Для команды с собственным Gitea это естественный выбор: образы живут рядом с кодом, единая аутентификация (логин Gitea = логин registry, токен — от Gitea).

```bash
# Gitea: токен с правами write:package
docker login git.example.com -u darkpix -p gitea_token_xxx
docker build -t git.example.com/darkpix/pet-app:1.4.2 .
docker push git.example.com/darkpix/pet-app:1.4.2
```

## Собственный registry 2.0 с TLS и htpasswd

Для приватной инфраструктуры (серверы в закрытом контуре, образы с коммерческой логикой) — свой registry. Официальный образ `registry:2` — реализация OCI Distribution Spec, хранит blobs в файловой системе или S3.

```yaml
# docker-compose.yml для registry
services:
  registry:
    image: registry:2
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      REGISTRY_AUTH: htpasswd
      REGISTRY_AUTH_HTPASSWD_REALM: registry-realm
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd
      REGISTRY_HTTP_TLS_CERTIFICATE: /certs/fullchain.pem
      REGISTRY_HTTP_TLS_KEY: /certs/privkey.pem
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
      REGISTRY_STORAGE_DELETE_ENABLED: "true"   # позволяет удалять образы (GC)
    volumes:
      - ./auth:/auth:ro
      - ./certs:/certs:ro
      - registry-data:/var/lib/registry

volumes:
  registry-data:
```

```bash
# 1. Пользователи: bcrypt-хэши (обязателен -B для registry!)
docker run --rm httpd:2-alpine htpasswd -nbB darkpix 'S3cretPass' > auth/htpasswd
chmod 600 auth/htpasswd

# 2. TLS: сертификат на домен registry.example.com (Let's Encrypt или внутренний CA)
#    Самоподписанный — только для лаборатории: каждому клиенту нужен --insecure-registry

# 3. Клиенты: логин и работа
docker login registry.example.com:5000
docker build -t registry.example.com:5000/pet-app:1.4.2 .
docker push registry.example.com:5000/pet-app:1.4.2
```

Три обязательных элемента: **TLS** (иначе docker-клиент откажется работать без insecure-registry, а это отключение проверки сертификатов для всех), **htpasswd с bcrypt** (`-B`; дефолтный md5 registry не примет), **том для данных** (registry-data — иначе образы умрут с контейнером). `REGISTRY_STORAGE_DELETE_ENABLED` — чтобы `docker rmi` + сборка мусора реально освобождали место.

Два эксплуатационных момента, о которых забывают: **сборка мусора** не происходит сама по себе — удалённые manifests оставляют блобы-сироты, которые копятся месяцами. Раз в неделю запускай в контейнере registry `registry garbage-collect /etc/docker/registry/config.yml` (или cron-задачу внутрь). И **ретенция**: без политики старых тегов реестр разрастается бесконечно — скрипт из cron, оставляющий последние N тегов на образ, решает это за вечер.

Для прод-подобного доступа извне registry ставят за Nginx/Traefik с нормальным TLS (443) и basic auth на уровне registry — это то, что делает Gitea/GitLab внутри себя.

Отдельный паттерн — **pull-through cache**: registry как прозрачный кэш Docker Hub, чтобы прод-серверы не упирались в rate limits и не зависели от внешней сети. На каждом хосте в `/etc/docker/daemon.json`:

```json
{
  "registry-mirrors": ["https://registry-cache.example.com"]
}
```

```yaml
# registry-cache как кэш: docker.io-образы льются через него и кэшируются
environment:
  REGISTRY_PROXY_REMOTEURL: https://registry-1.docker.io
```

Первый pull образа идёт в Docker Hub, все последующие — с твоего кэша. Для контура без постоянного интернета это разница между работающим и мёртвым деплоем.

:::caution[Публичный registry без auth]
Самая частая катастрофа self-hosted registry: порт 5000 открыт миру без аутентификации, «чтобы CI было удобнее». Через месяц туда пушат майнеры (registry как анонимное хранилище), а через два — твои образы скачивают конкуренты. Auth + firewall (только IP CI и продов) — не опция, а необходимость.
:::

## Сканирование: Trivy

Прежде чем образ попадёт в прод, он проходит сканер. **[Trivy](https://trivy.dev/)** — стандарт де-факто: сканирует уязвимости OS-пакетов (alpine/debian), языковых зависимостей (package-lock, requirements.txt), IaaC-конфиги и сам Dockerfile.

```bash
# Сканирование образа
trivy image --severity HIGH,CRITICAL myapp:1.4.2

# Только что появилось (exit-code 1 при критических — для CI)
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed myapp:1.4.2

# Все образы на хосте + сводка
trivy image --format table $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>')

# Сканирование fs проекта до сборки (ранняя обратная связь)
trivy fs --severity HIGH,CRITICAL .
```

Флаги, которые важны: `--ignore-unfixed` — не паниковать на CVE, для которых в дистрибутиве ещё нет патча (в alpine их много, и это не значит, что ты уязвим прямо сейчас); `--exit-code 1` — падать при находках, это дверь в CI: стадия `security-scan`, которая блокирует деплой образа с критическими CVE.

```yaml
# Фрагмент CI: образ не уходит в prod без чистого скана
security-scan:
  image: aquasec/trivy:0.70.0
  script:
    - trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed
        $CI_REGISTRY_IMAGE:$CI_COMMIT_TAG
```

Trivy умеет и `trivy server` + `trivy client` — центральная база уязвимостей в закрытом контуре, если серверы без интернета.

## Подпись образов: Cosign

Сканирование отвечает на «нет ли в образе дыр». Подпись — на вопрос «это точно тот образ, который собрал наш CI, а не подмена». **[Cosign](https://docs.sigstore.dev/cosign/)** (Sigstore) — инструмент подписи, не требующий управления ключами: в простейшем варианте подпись хранится рядом с образом в registry, а верификация — через прозрачный лог (Rekor) или статический ключ.

```bash
# Генерация пары (один раз, ключи — в секретах CI)
cosign generate-key-pair

# Подпись: подписывается дайджест, а не тег!
DIGEST=$(docker inspect $IMAGE:$TAG --format='{{index .RepoDigests 0}}')
cosign sign --key cosign.key $DIGEST

# Проверка на проде перед pull
cosign verify --key cosign.pub $IMAGE@$DIGEST
```

Ключевой момент — подпись по **дайджесту** (`image@sha256:...`), а не по тегу. Тег подвижен: подписал `app:1.4.2`, а завтра кто-то перезапушил тег на другой образ — подпись «тега» ничего не стоит. Дайджест — криптографический отпечаток содержимого.

```bash
# Полный контур: CI подписывает, прод верифицирует
# CI:
cosign sign --key env://COSIGN_PRIVATE_KEY $IMAGE@$DIGEST
# Prod (в скрипте деплоя):
cosign verify --key cosign.pub $IMAGE@$DIGEST || { echo "ПОДПИСЬ НЕВЕРНА"; exit 1; }
docker pull $IMAGE@$DIGEST
```

Продвинутый вариант — keyless-подпись через OIDC в CI (GitHub Actions выдаёт короткоживущий сертификат, привязанный к репозиторию и commit SHA — никаких ключей вообще). Но и статический ключ в секретах CI решает 95 % задач.

## Runtime-безопасность: пять слоёв

Образ в реестре — доверенный. Теперь убедимся, что его взлом не станет катастрофой.

**1. Не root.** В Dockerfile: `USER app` (или `USER 1000:1000` — uid без имени в /etc/passwd, ещё меньше поверхности). В Compose:

```yaml
services:
  app:
    user: "1000:1000"
    read_only: true          # корневая ФС контейнера — только чтение
    tmpfs:
      - /tmp                 # куда писать временное
    volumes:
      - app-data:/var/lib/app:rw   # только рабочие данные — запись
```

**2. Read-only rootfs.** `read_only: true` — взломавший процесс не может перезаписать бинарники, библиотеки или `/etc`. Легитимные места записи — только явные: tmpfs для `/tmp`, volume для данных.

**3. Capabilities drop.** По умолчанию Docker даёт контейнеру 14 capabilities ([рекомендации по безопасности Docker](https://docs.docker.com/develop/security-best-practices/) строятся на их срезании: NET_BIND_SERVICE, CHOWN, SETUID…). Продакшен-приложению почти ничего из этого не нужно:

```yaml
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE      # если приложение слушает :443 само; обычно и это не нужно — порт >1024 + nginx
```

`cap_drop: ALL` + точечные `cap_add` — паттерн «deny by default». Node-приложение на порту 3000 не нуждается ни в одной capability.

**4. seccomp и AppArmor.** seccomp-фильтр ограничивает системные вызовы (clone, mount, ptrace…). Docker ставит дефолтный профиль; можно свой (только нужные syscall'ы):

```yaml
    security_opt:
      - no-new-privileges:true
      - seccomp=/etc/docker/seccomp-profiles/app.json
      - apparmor=docker-app       # кастомный AppArmor-профиль на хосте
```

`no-new-privileges` — процесс не может получить больше прав через setuid-бинарники: даже если в образ прокрался вредоносный suid-файл, он бесполезен.

**5. Ресурсные лимиты.** Уже знакомые cgroups-лимиты (memory, cpus, pids) — и они не только про стабильность, но и про безопасность: fork-бомба упирается в `pids_limit`, exfiltration-трафик — в лимиты CPU/сети.

```yaml
    pids_limit: 100
    mem_limit: 512m
    cpus: 0.5
```

## Проверка образа перед запуском

Собери весь контур в скрипт приёмки образа:

```bash
#!/usr/bin/env bash
# verify-image.sh — что делает хост перед первым запуском образа
set -euo pipefail
IMAGE="${1:?Укажи образ}"
DIGEST="${2:?Укажи дайджест sha256}"

# 1. Подпись — это наш образ?
cosign verify --key /etc/deploy/cosign.pub "${IMAGE}@${DIGEST}"

# 2. Скан — нет ли критических дыр?
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed "${IMAGE}@${DIGEST}"

# 3. Конфигурация — не root, есть healthcheck?
CONFIG=$(docker inspect "${IMAGE}@${DIGEST}" --format '{{json .Config}}')
echo "$CONFIG" | jq -e '.User != "" and .User != "root"' > /dev/null \
    || { echo "Образ запускается от root"; exit 1; }

docker pull "${IMAGE}@${DIGEST}"
echo "Образ принят: ${IMAGE}@${DIGEST}"
```

Три проверки, которые должны быть автоматическими: подпись (доверие), скан (уязвимости), конфиг (non-root). Этот скрипт — ручной аналог admission controller'а в Kubernetes, и ментальная модель для него.

Важно понимать границы контроля: verify-image.sh проверяет образ на момент приёмки. Если после этого кто-то с docker-доступом перезапустит контейнер с другим образом, подпись уже ничего не гарантирует. Поэтому вторая линия — наблюдаемость: периодический аудит того, какие дайджесты реально запущены на хостах (`docker ps --format '{{.Image}}'` против эталонного списка), и алерт на любое расхождение. Доверие без наблюдения — это надежда, а не контроль.

## Типичные ошибки и грабли

:::note[Золотой образ]
Практичный паттерн для боевых базовых образов: один `base` (alpine + патчи + ca-certificates + пользователь), из него — `base-node`, `base-python` и т.д. Патчишь один раз в базе — и сканер зеленеет сразу на всех приложениях. Trivy в CI на `base` ставит ритм: «обновить базовые образы» становится регулярной задачей, а не пожаром.
:::

1. **Теги в прод вместо дайджестов.** `image: app:latest` в проде — рулетка: что именно сейчас за этим тегом, знает только реестр. Критический инцидент отката превращается в археологию. Правило: прод хранит дайджесты, теги — для людей.
2. **`docker login` на shared CI-раннерах.** Credentials в `~/.docker/config.json` доступны следующей job'е на том же раннере. В CI — всегда `--password-stdin` с токеном из секретов и ephemeral-конфиг: `docker --config $(mktemp -d) login`.
3. **Сканирование после деплоя.** Trivy в cron на проде — это мониторинг, а не контроль. Критические CVE должны блокировать путь в реестр/прод (gate в CI), иначе это вечное «пофиксим завтра».
4. **`cap_drop: ALL` ломает приложение, и флаги снимают.** Симптом: «работало на dev, на проде падает с permission denied». Причина — не хватает capabilities (часто NET_BIND_SERVICE при прослушке <1024 или SETGID у старых процессов). Правильно: разобрать, какая именно нужна, и добавить только её — а не отключать hardening.
5. **Приватный registry без бэкапа тома.** `registry-data` — единственная копия образов. Диск умер — пересобирай всё, что не под git. Том registry бэкапится так же, как данные БД: restic/rclone на S3.
6. **Секреты в Dockerfile через ARG.** `ARG TOKEN` → `RUN curl -H "Authorization: $TOKEN"` запечёт токен в слое, и `docker history` покажет его всем. Только BuildKit secret mounts (см. главу docker-deep) или мультистейдж без секрета в финале.

## Вопросы на собеседовании

**Чем registry отличается от обычного файлового хранилища и что такое OCI Distribution Spec?**
Registry — это API-сервер с аутентификацией, адресацией по имени/тегу/дайджесту и раздельным хранением blobs (слои) и manifests (описание образа). OCI Distribution Spec — стандарт этого API: благодаря ему `docker`, `podman`, `crane`, `helm` и любой registry (Docker Hub, GHCR, Harbor, registry:2) взаимодействуют одинаково.

**Почему подписывать образ нужно по дайджесту, а не по тегу?**
Тег — изменяемый указатель: сегодня `app:1.4.2` — один образ, завтра другой. Подпись тега подтверждает «в какой-то момент кто-то подписал нечто под этим именем». Подпись дайджеста (`sha256:...`) криптографически привязана к содержимому: подмена хоть одного байта делает подпись невалидной.

**Что покрывает Trivy и что не покрывает?**
Trivy ищет известные CVE в OS-пакетах и языковых зависимостях, плохие практики в Dockerfile и IaC-конфиги, секреты в слоях. Не покрывает: zero-day, бизнес-логику, уязвимости в собственном коде (для этого SAST/фuzzing). Вывод: Trivy — necessary, not sufficient.

**Объясни разницу между capabilities drop, seccomp и AppArmor.**
Capabilities режут привилегии root-набора (chown, net_admin, sys_ptrace) — «что процесс может». seccomp фильтрует системные вызовы — «какими дверями в ядро он может стучать». AppArmor (или SELinux) — мандатный контроль доступа к путям и ресурсам — «к каким файлам и сокетам». Три ортогональных слоя: привилегии, syscall'ы, доступ к файлам.

**Как устроен docker login и где лежат credentials?**
`docker login` сохраняет base64-кодированный `username:password` в `~/.docker/config.json` (или credential helper'е — так правильно). Все последующие команды подставляют его в HTTP-заголовок `Authorization` при обращении к registry. Отсюда правило: на shared-раннерах — изолированный `--config` и токены с минимальным сроком жизни.

**Зачем no-new-privileges и как это работает?**
Флаг `no-new-privileges:true` в security_opt запрещает процессу получать привилегии через setuid/setgid-бит: даже если в образе есть suid-бинарник, выполняемый код не получит эффективный uid 0. Атака через найденный в образе `sudo`/уязвимый setuid-бинарник нейтрализуется на уровне ядра.

**Твой образ скомпрометирован на проде. Что ты делаешь?**
План: (1) изолируем хост (остановка контейнера, снапшот volume для форензики); (2) ротация всех секретов, доступных процессу (DB, токены, TLS-ключи); (3) разбор входа: trivy-скан образа на свежие CVE, проверка слоёв через dive на предмет инжектов; (4) пересборка из чистого git-коммита, подпись, повторный скан; (5) постмортем: как образ без критических дыр и с подписью прошёл admission — обычно находится дыра в процессе (неподписанный перезапуск, ручной `docker run`).

## Практика

1. **Свой registry.** Подними `registry:2` с TLS (mkcert для локалки) и htpasswd. Запушь свой образ, скачай на «второй машине» (или втором контексте docker). Критерий: pull без `--insecure-registry` работает, анонимный pull отклонён 401.
2. **Gate в CI.** Добавь стадию: Trivy с `--exit-code 1 --severity CRITICAL` между сборкой и пушем. Собери образ с заведомо уязвимым пакетом (например, старый openssl в alpine 3.15), убедись, что CI красный. Почини базовый образ — CI зелёный.
3. **Подпись и верификация.** Сгенерируй пару cosign, подпиши образ по дайджесту, напиши verify-image.sh, подмени образ (пересобери с добавленной строкой) и покажи, что верификация падает. Критерий: подменённый образ не проходит, оригинальный — проходит.
4. **Hardened-запуск.** Возьми app из Compose-главы и примени полный набор: `user: 1000:1000`, `read_only: true`, `cap_drop: ALL`, `no-new-privileges`. Найди через trial-and-error, какие capabilities реально нужны (скорее всего — ни одной, если порт >1024). Критерий: приложение работает, `docker inspect` показывает пустой CapAdd.
5. **Приёмка образа.** Собери verify-image.sh из главы, прогони свой свежий образ через него, затем специально сломай каждую из трёх проверок (подпись, скан, root) и зафиксируй поведение.

## Что почитать

- [OCI Distribution Spec](https://github.com/opencontainers/distribution-spec) — API реестров, на котором стоит всё
- [Trivy документация](https://aquasecurity.github.io/trivy/) — режимы image/fs/repo, фильтры, CI-интеграция
- [Sigstore Cosign](https://docs.sigstore.dev/cosign/overview/) — подпись образов, keyless-режим
- [Docker security best practices](https://docs.docker.com/develop/security-best-practices/) — non-root, seccomp, capabilities
- [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html) — полный список capabilities и что каждая позволяет
