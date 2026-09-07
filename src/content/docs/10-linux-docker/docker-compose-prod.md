---
title: "Docker Compose в продакшене: боевой стек"
description: "Полный стек app + PostgreSQL + Redis + Nginx с двумя сетями, healthcheck-зависимости, профили, секреты, логирование с ротацией, лимиты ресурсов и стратегия бэкапа томов."
---

`docker compose up` на ноутбуке и тот же стек на продакшен-сервере — разные миры. Локально тебе важно быстро поднять; в бою важно, чтобы приложение не стартовало раньше базы, секреты не лежали в git, логи не съели диск за ночь, а упавший контейнер не утащил за собой соседей. В краткой версии ты видел стек с healthcheck; здесь — версия, которую не стыдно отдать под нагрузку: профили, секреты, лимиты, ротация и бэкапы.

:::note[Почему Compose, а не Kubernetes]
Compose — это оркестрация одного хоста. Для pet-проекта, MVP и небольших продов это правильный выбор: вся мощь зависимостей, сетей и healthcheck'ов без операционной сложности кластера. Правильный Compose-файл потом мигрирует в K8s манифесты почти один в один — концепции те же.
:::

## Целевая архитектура

```
                 ┌──────────────────────────────────────────┐
   интернет      │                 хост                     │
      │          │                                          │
      ▼          │   ┌──────────┐      ┌──────────┐         │
 ┌─────────┐     │   │  nginx   │──────│   app    │         │
 │  :443   │─────┼──▶│ (frontend│      │(backend) │         │
 └─────────┘     │   │  сеть)   │      │          │         │
                 │   └──────────┘      └────┬─────┘         │
                 │                          │               │
                 │              ┌───────────┴────┐          │
                 │              │   backend      │          │
                 │              │   сеть         │          │
                 │         ┌────┴────┐      ┌────┴────┐     │
                 │         │ postgres│      │  redis  │     │
                 │         └─────────┘      └─────────┘     │
                 └──────────────────────────────────────────┘
```

Две сети: `frontend` — куда смотрит мир (только Nginx), `backend` — приватная сеть приложения. PostgreSQL и Redis физически недоступны снаружи: в `frontend` их никто не подключает.

## Полный боевой файл

```yaml
# docker-compose.yml
name: petapp

x-app-defaults: &app-defaults
  restart: unless-stopped
  logging: &default-logging
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"
      compress: "true"

services:
  app:
    <<: *app-defaults
    image: ghcr.io/darkpix/pet-app:${APP_VERSION:?Задай APP_VERSION в .env}
    environment:
      DATABASE_URL: postgresql://app:${DB_PASSWORD}@db:5432/appdb
      REDIS_URL: redis://redis:6379
      NODE_ENV: production
    secrets:
      - tls_key          # секреты монтируются в /run/secrets/
    networks:
      - backend
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000/health"]
      interval: 15s
      timeout: 3s
      retries: 5
      start_period: 20s
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
        reservations:
          memory: 128M
    read_only: true
    tmpfs:
      - /tmp

  db:
    <<: *app-defaults
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD обязателен}
      POSTGRES_DB: appdb
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - backend
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 1G
    shm_size: 256mb            # shared memory для сортировок/индексов

  redis:
    <<: *app-defaults
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redisdata:/data
    networks:
      - backend
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 320M

  nginx:
    <<: *app-defaults
    image: nginx:1.27-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ./certs:/etc/nginx/certs:ro
    networks:
      - frontend
      - backend
    depends_on:
      app:
        condition: service_healthy

  backup:
    <<: *app-defaults
    profiles: ["backup"]           # не стартует по умолчанию
    image: postgres:16-alpine
    environment:
      PGHOST: db
      PGUSER: app
      PGPASSWORD: ${DB_PASSWORD}
    volumes:
      - ./backup.sh:/backup.sh:ro
      - /var/backups/petapp:/backups
    networks:
      - backend
    entrypoint: ["/backup.sh"]

secrets:
  tls_key:
    file: ./secrets/tls_key.pem

volumes:
  pgdata:
  redisdata:

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true              # нет маршрута наружу вообще
```

Пройдёмся по каждому механизму.

## depends_on с условиями: никаких гонок

Без условий `depends_on` лишь задаёт порядок старта контейнеров — а не готовности. `condition: service_healthy` говорит Compose ждать, пока healthcheck зависимости не вернёт healthy:

```yaml
depends_on:
  db:
    condition: service_healthy   # ждём pg_isready
  redis:
    condition: service_started   # только факт старта (redis почти мгновенен)
```

Варианты условий: `service_started` (контейнер запущен), `service_healthy` (healthcheck healthy), `service_completed_successfully` (для init-контейнеров с `profiles`/oneshot — миграции). Полная семантика условий — в [спецификации Compose](https://docs.docker.com/compose/compose-file/). Healthcheck в app нужен самому себе: nginx ждёт его, прежде чем считать стек поднятым.

Важно: healthcheck — не замена retry-логике в приложении. Между «pg_isready вернул ok» и «приложение реально подключилось» есть секунды, и соединение может оборваться в любой момент жизни. Клиенты БД должны уметь переподключаться — healthcheck решает только стартовую гонку.

## Профили: опциональные сервисы

[Профили](https://docs.docker.com/compose/how-tos/profiles/) отделяют то, что должно работать постоянно, от того, что запускается по требованию:

```bash
docker compose up -d                          # app, db, redis, nginx — без backup
docker compose run --rm backup                # одноразовый запуск бэкапа
docker compose --profile backup up -d backup  # поднять профиль явно
```

Практическое применение: `debug`-профиль с pgAdmin/redisinsight, `migrate`-профиль с job'ой миграций, `backup` для крон-задач. Сервис в профиле не участвует в `up -d` по умолчанию — стек остаётся чистым.

## Env-файлы и секреты

```bash
# .env (лежит рядом с compose-файлом, в git — только .env.example)
APP_VERSION=1.4.2
DB_PASSWORD=s3cret-from-vault
```

Compose подставляет `${VAR}` из shell и из `.env`. Два правила: обязательные переменные помечай `:?сообщение` — забытый `.env` даст понятную ошибку вместо пустого пароля; `.env` в `.gitignore` всегда, в репе — `.env.example` с пустыми значениями.

Compose-secrets ([документация](https://docs.docker.com/compose/use-secrets/); файл `secrets/tls_key.pem` монтируется в `/run/secrets/tls_key` внутри контейнера): лучше env-переменных, потому что не видны в `docker inspect` (переменные окружения там видны всем, у кого есть доступ к docker-сокету!) и не попадают в логи при ошибках. Для Compose на одном хосте это «почти» security: физически файл на том же диске, но граница «не в inspect/не в env» уже снимает целый класс утечек.

:::caution[docker inspect — публичное достояние]
Кто угодно с доступом к docker-сокету (а это часто все в группе docker, т.е. фактически root) видит `Config.Env` каждого контейнера. Пароль БД в `environment:` — плохо; тот же пароль через `secrets:` — терпимо; лучше всего — внешний секрет-менеджер (Vault, SOPS), но на уровне Compose секреты уже правильный шаг.
:::

## Restart-политики и логирование

`restart: unless-stopped` — стандарт продакшена: перезапуск при падении и после ребута хоста, но уважает явный `docker compose stop`. Не используй `always` там, где конфигурация может быть битой — иначе цикл падений без таймаута.

Блок `logging` критичен: по умолчанию json-file пишет логи безгранично. Один говорливый контейнер заполнит весь диск за сутки. `max-size` + `max-file` + `compress` — минимум для каждого сервиса (мы вынесли это в якорь `&default-logging` и переиспользуем). Для централизованных логов драйвер меняется на `fluentd`/`loki` — но ротация нужна и там, и там, как страховка.

## Ресурсные лимиты

`deploy.resources.limits` в Compose v2 работает без Docker Swarm:

```yaml
deploy:
  resources:
    limits:
      memory: 512M      # жёсткий потолок: OOM-killer при превышении
      cpus: "0.5"       # половина ядра
    reservations:
      memory: 128M      # гарантия при нехватке памяти на хосте
```

Смысл лимитов — изоляция отказов: утечка в app не должна убить postgres. Метод подбора: снимаешь `docker stats` под реальной нагрузкой неделю, ставишь лимит = пик + 30 %. Слишком щедрый лимит памяти — та же утечка, только с задержкой; слишком жёсткий — ложные OOM в пиках.

`shm_size` у postgres — часто забывают: без неё контейнер получает дефолтные 64 МБ shared memory, и сложные запросы с сортировкой падают с `could not resize shared memory segment`.

## Сети: internal как принцип

```yaml
networks:
  backend:
    internal: true
```

`internal: true` — мост без маршрута наружу. Postgres физически не может инициировать соединение в интернет: даже если его скомпрометируют, exfiltration данных через curl/wget невозможен. Это не замена фаерволу хоста, но сильный слой изоляции, который стоит одной строкой.

## Стратегия бэкапа volumes

Данные живут в named volumes. Бэкап = сдампить данные приложения, а не копировать файлы тома на горячую (Postgres файлы под записью — битый бэкап гарантирован).

```bash
#!/bin/sh
# backup.sh — вызывается entrypoint'ом сервиса backup (profiles: ["backup"])
set -eu

TS=$(date +%Y%m%d-%H%M%S)
OUT=/backups

# 1. Логический дамп PostgreSQL (pg_dump — консистентен при работающей БД)
pg_dump -Fc appdb -f "$OUT/pg-$TS.dump"
pg_dump требует, чтобы БД принимала соединения — она в internal-сети, backup там же

# 2. Redis: RDB-дамп через SAVE на slave-коннекте
redis-cli -h redis --rdb "$OUT/redis-$TS.rdb" || true

# 3. Проверка: дамп должен распаковываться
pg_restore --list "$OUT/pg-$TS.dump" > /dev/null

# 4. Ротация: 14 ежедневных + 8 еженедельных
find "$OUT" -name 'pg-*.dump' -mtime +14 -not -name '*-Sunday*' -delete
```

Запуск по расписанию — через cron хоста или systemd-таймер (глава systemd), который делает `docker compose run --rm backup`. Принципы стратегии:

- **Логические дампы, а не копии файлов.** `pg_dump -Fc` восстанавливается в любую версию >= дампа, копия каталога данных — только в идентичную среду.
- **3-2-1**: три копии, два носителя, одна вне офиса. Локальный `/var/backups` + объектное хранилище (S3/MinIO) через `rclone`/restic.
- **Проверка восстановления.** Бэкап, который не восстанавливался — это надежда, а не бэкап. Раз в месяц: поднять отдельный Compose-проект из дампа, прогнать smoke-проверку.
- **Шифрование.** `gpg --symmetric` на диске + TLS при передаче в S3. Дамп БД — это вся твоя компания в одном файле.

```bash
# Отправка в S3-compatible хранилище (в конец backup.sh)
rclone copy "$OUT/pg-$TS.dump.gpg" s3:petapp-backups/ --s3-no-check-bucket
```

## Обновление стека: zero-downtime на одном хосте

```bash
# 1. Новая версия собирается и пушится CI
docker compose pull app          # скачать новый образ по тегу из .env
# 2. Миграции — отдельным контейнером, до переключения
docker compose run --rm --no-deps app npx knex migrate:latest
# 3. Пересоздать только app; nginx держит соединения, db/redis не трогаем
docker compose up -d --no-deps app
docker image prune -f            # почистить старые слои
```

`--no-deps` — ключ: без него `up -d app` пересоздаст и зависимости. Порядок важен: сначала миграции (приложение старой версии работает с новой схемой обратимо), потом приложение. Для строгого zero-downtime нужны два инстанса app за Nginx upstream + drain, но на одном хосте Compose даёт «почти бесшовно» — соединения Nginx переживают пересоздание бэкенда за секунды.

## Валидация, дрейф и Compose в разработке

Прежде чем `up -d`, прогоняй конфигурацию через рендер: `docker compose config` выводит итоговый YAML со всеми подстановками `${VAR}` и якорями. Это дешёвый способ поймать опечатку в имени сервиса или забытую переменную до того, как контейнеры тронутся. В CI — `docker compose config --quiet` как линт: конфиг с ошибкой не должен доехать до сервера.

Вторая привычка — фиксировать версию Compose-файла в репе и следить за дрейфом: `docker compose version` на проде и в CI должна совпадать, иначе директива, работающая локально (например, `develop.watch`), на проде молча игнорируется старым плагином.

Для разработки рядом с продовым файлом живёт `docker-compose.override.yml` — Compose подхватывает его автоматически:

```yaml
# docker-compose.override.yml (в git: да — это конфиг локалки)
services:
  app:
    build: .                    # локально собираем, в проде — image из registry
    develop:
      watch:
        - action: rebuild
          path: ./src
    ports:
      - "127.0.0.1:3000:3000"   # дебаг-порт не торчит наружу
    command: npm run dev        # hot reload вместо node dist
```

Продовый сервер запускает стек с `--project-directory` и без override (`docker compose -f docker-compose.yml up -d`), разработчик просто `docker compose up`. Один источник правды, два режима жизни.

:::tip[Один сервер — один проект]
`name: petapp` в шапке файла фиксирует имя проекта: контейнеры будут `petapp-app-1`, тома — `petapp_pgdata`, независимо от каталога, из которого запущен Compose. Без этого имя проекта берётся из имени каталога, и один и тот же стек, развёрнутый из `/opt/petapp` и `~/petapp`, получит разные сети и тома — классический источник «где мои данные?!».
:::

## Типичные ошибки и грабли

1. **Приложение стартует раньше БД без healthcheck-условий.** Классика: `depends_on` без `condition` не ждёт готовности, приложение падает, restart-политика долбит reconnect-спамом логи. Решение: healthcheck БД + `condition: service_healthy` + retry-логика в коде.
2. **Секреты в `environment:` и git.** `${DB_PASSWORD}` в environment — это пароль в `docker inspect` у любого в группе docker и в `.env`, который «случайно» закоммитили. Secrets + `.env` в gitignore + `:?` для обязательных.
3. **Нет ротации логов.** Дефолтный json-file без `max-size` растёт до конца диска. Диск забивается в 3 часа ночи — и падает не один контейнер, а весь стек. Якорь `&default-logging` на все сервисы.
4. **Бэкап = `cp -r` каталога данных postgres.** Файлы под записью, WAL полусброшен — дамп не восстанавливается никогда, узнаётся это в момент катастрофы. Только `pg_dump`/`pg_basebackup` или snapshot на уровне СХД.
5. **`restart: always` + битый конфиг.** Контейнер падает на старте, Docker перезапускает мгновенно, падает снова — бесконечный цикл без единой паузы, плюс спам логов. `unless-stopped` + ограничение `StartLimitBurst` (если через systemd) или хотя бы осмысленный entrypoint.
6. **Один bridge на всё.** Без `internal: true` скомпрометированный Nginx (единственный публичный сервис) имеет сетевой доступ к Redis и Postgres. Две сети с изоляцией — минуту работы, целый класс атак закрыт.

## Вопросы на собеседовании

**Чем `depends_on: service_healthy` отличается от просто `depends_on` и от retry-логики в приложении?**
Простой `depends_on` ждёт только факт старта контейнера — процесс postgres запущен, но ещё не принимает соединения. `service_healthy` ждёт успешного healthcheck. Retry-логика в приложении нужна всегда: healthcheck решает только стартовую гонку, а соединение может оборваться в любой момент. Правильный ответ: все три слоя — стартовый порядок, готовность, runtime-переподключение.

**Как передать секреты в Compose и чем `secrets:` лучше `environment:`?**
Через файлы в `secrets:` секции — Compose монтирует их в `/run/secrets/`. Отличия: не видны в `docker inspect` (все env видны через docker-сокет), не светятся в `docker compose config` при сборке, не наследуются дочерним процессами случайно. На одном хосте это не полноценный Vault, но снимает целый класс утечек.

**Почему нельзя просто копировать каталог данных PostgreSQL для бэкапа?**
Потому что файлы находятся в непротиворечивом состоянии только при остановленной БД или через механизмы СУБД. Горячее копирование каталога даёт рассинхронизированные файлы данных и WAL — восстановление невозможно. Правильно: `pg_dump` (логический) или `pg_basebackup` + WAL-архив (физический) или снапшот блочного устройства с frozen FS.

**Как устроить zero-downtime деплой на одном хосте с Compose?**
Новый образ → `docker compose run --rm --no-deps app migrate` (миграции до переключения) → `docker compose up -d --no-deps app`. Nginx держит соединения и переподключается к новому контейнеру за секунды. Для полной бесшовности — два инстанса app в upstream с drain-стратегией, но Compose на одном хосте даёт «почти бесшовно». Критично: `--no-deps`, иначе пересоздастся вся цепочка.

**Зачем `internal: true` на backend-сети?**
Мост без маршрута в интернет. Даже полный контроль над контейнером в internal-сети не даёт возможности скачать эксплоит или слить данные наружу — только через другие контейнеры. Это один из самых дешёвых слоёв изоляции: одна строка YAML.

**Как подобрать лимиты памяти для сервисов?**
Метрики прежде догм: неделю снимаешь `docker stats` под реальной нагрузкой, лимит = пик + 30 %. Слишком жёсткий лимит даёт ложные OOM в пиках, слишком мягкий — утечка живёт неделями. Обязательно смотреть `OOMKilled` в inspect и алертить на него.

**Что происходит при `docker compose up -d` после изменения образа тега в .env?**
Compose сравнивает желаемое состояние с фактическим: контейнеры, у которых изменился image/config, пересоздаются; неизменённые — не трогаются. Именно поэтому деплой — это правка `APP_VERSION` + `up -d`, а не ручные `docker rm`.

## Практика

1. **Боевой стек с нуля.** Подними стек из главы: app (из своего Dockerfile прошлой главы) + postgres с healthcheck + redis + nginx с двумя сетями. Критерий: с хоста `curl localhost` отдаёт приложение; `docker compose exec db pg_isready` healthy; `nc -z хост 5432` снаружи — connection refused.
2. **Гонка старта.** Убери `condition: service_healthy`, добавь в app вывод «подключился к БД» при старте, сделай `docker compose up -d` десять раз подряд. Посчитай, сколько раз app упал до готовности postgres. Верни условия — сравни.
3. **Секреты.** Переведи пароль БД из `environment` в `secrets:` (монтирование файла). Докажи разницу: `docker inspect` контейнера — пароль виден/не виден. Критерий: приложение читает пароль из `/run/secrets/db_password`.
4. **Бэкап и восстановление.** Напиши backup.sh (pg_dump + ротация + rclone в MinIO/S3), настрой systemd-таймер для `docker compose run --rm backup`. Потом сделай учебную катастрофу: `docker compose down -v`, подними стек, восстановись из последнего дампа. Критерий: данные на месте, время восстановления зафиксировано.
5. **Лимиты и OOM.** Поставь app лимит 128M, прогони нагрузку (аб -n 10000). Наблюдай `docker stats`, `docker inspect` после OOMKill. Подбери реальный лимит по метрикам и пересобери конфигурацию.

## Что почитать

- [Compose specification](https://docs.docker.com/compose/compose-file/) — depends_on conditions, profiles, secrets, deploy.resources
- [Compose: использование profiles](https://docs.docker.com/compose/profiles/) — паттерны опциональных сервисов
- [PostgreSQL backup & restore](https://www.postgresql.org/docs/current/backup.html) — логический против физического бэкапа
- [restic / rclone](https://restic.net/) — шифрованные дедуплицированные бэкапы в S3
- [Awesome Compose](https://github.com/docker/awesome-compose) — образцовые стеки под разные стеки технологий
