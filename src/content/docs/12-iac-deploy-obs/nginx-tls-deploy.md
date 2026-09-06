---
title: "Nginx глубоко: архитектура, TLS и стратегии деплоя"
description: "Master/worker-модель, upstream-балансировка, сжатие, кэширование, rate limiting, production TLS с HSTS и OCSP stapling, blue-green/rolling/canary и Cloudflare перед origin."
---

Nginx — самый распространённый фронтенд веб-инфраструктуры: по статистике, за ним стоит треть топовых сайтов мира. В краткой версии ты настроил reverse proxy, получил сертификат от Certbot и включил gzip. Но конфиг «сработал» и конфиг «правильный» — разные вещи: первый выдержит нагрузку твоего ноутбука, второй — внезапный всплеск трафика, медленного клиента с мобильного интернета и попытку брутфорса логина. Разница в понимании того, как Nginx устроен внутри.

Разберём архитектуру: почему один master и несколько worker-процессов — это фундамент его производительности и как правильно управлять конфигурацией без даунтайма. Соберём полный production-конфиг: upstream-балансировка со стратегиями round-robin/least_conn/ip_hash и весами, gzip и brotli, кэширование статики, rate limiting зонами. Настроим TLS по всем канонам: протоколы, шифры, HSTS, OCSP stapling, HTTP→HTTPS редирект. Завершим стратегиями выкатки — rolling, blue-green, canary с взвешенным upstream — и местом Cloudflare как CDN/WAF перед origin.

## Архитектура: master и workers

Nginx работает как набор процессов, а не потоков. Один **master** читает конфигурацию, открывает порты 80/443, порождает workers и никогда не обрабатывает соединения сам. Workers (по числу ядер CPU) — обработчики: каждый ведёт тысячи соединений через event-driven цикл `epoll`/`kqueue`. Это и есть причина его скорости: один процесс обрабатывает соединения асинхронно, блокируясь только на реальных операциях ввода-вывода.

```bash
ps aux | grep nginx
# root      812  nginx: master process /usr/sbin/nginx
# www-data  813  nginx: worker process
# www-data  814  nginx: worker process
```

Управление без даунтайма:

```bash
sudo nginx -t                    # ВСЕГДА перед изменением конфига
sudo systemctl reload nginx      # master перечитывает конфиг, workers старые завершают свои соединения, новые берут обновлённую конфигурацию
sudo systemctl restart nginx     # жёсткий рестарт — рвёт соединения
```

Reload — золотой стандарт: пользователи не замечают деплоя конфигурации. В Ansible это handler с `state: reloaded`, а не `restarted`.

## Полный конфиг: reverse proxy, балансировка, сжатие, кэш

Собираем production-конфиг для pet-проекта по кирпичикам.

### Upstream: стратегии балансировки

Upstream — группа бэкендов. Nginx поддерживает три базовые стратегии и веса:

```conf
# /etc/nginx/conf.d/upstream.conf

# 1. Round-robin (по умолчанию) — по кругу. Просто, но слепо к нагрузке.
upstream app_roundrobin {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
}

# 2. least_conn — следующий запрос идёт к серверу с наименьшим числом активных соединений.
#    Лучший выбор для неравномерных по длительности запросов (Long Polling, тяжёлые отчёты).
upstream app_least_conn {
    least_conn;
    server 127.0.0.1:3000 max_fails=3 fail_timeout=30s;
    server 127.0.0.1:3001 max_fails=3 fail_timeout=30s;
    keepalive 32;                       # переиспользование соединений к бэкенду
}

# 3. ip_hash — клиент привязывается к серверу по хешу IP. Для stateful-сессий
#    в памяти приложения (но ломается за NAT-корпоративных сетей — все ходят с одного IP).
upstream app_ip_hash {
    ip_hash;
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;
}

# 4. Взвешенный round-robin — трафик распределяется пропорционально весам.
#    Основа для canary-деплоя (подробности ниже).
upstream app_weighted {
    server 127.0.0.1:3000 weight=95;    # стабильная версия, 95%
    server 127.0.0.1:3001 weight=5;     # canary-версия, 5%
}
```

`max_fails=3 fail_timeout=30s` — пассивный health-check: три неудачи за 30 секунд, и нода выводится из ротации до конца fail_timeout. Для активных проверок нужен модуль `nginx_upstream_check_module` или внешний мониторинг (см. главу про метрики).

### Сжатие: gzip и brotli

```conf
# /etc/nginx/conf.d/gzip.conf
gzip on;
gzip_vary on;                          # добавляет Vary: Accept-Encoding (критично для CDN)
gzip_min_length 1024;                  # не жать маленькие ответы — оверхед больше выгоды
gzip_comp_level 5;                     # 1-9: выше = лучше сжатие, но больше CPU
gzip_types
    text/css
    application/javascript
    application/json
    image/svg+xml
    text/xml;
gzip_proxied any;                      # сжимать и ответы за прокси (Cloudflare → origin)
```

Brotli — преемник gzip от Google, выигрывает 15-20% на тексте, но требует динамического модуля (`libnginx-mod-brotli`):

```conf
# /etc/nginx/conf.d/brotli.conf
brotli on;
brotli_comp_level 5;
brotli_types text/css application/javascript application/json image/svg+xml;
```

Заметь порядок: Nginx отдаёт brotli браузерам, которые его поддерживают (Chrome, Firefox), gzip — остальным. Детекция по `Accept-Encoding`.

### Кэширование статики

Статику (CSS/JS/шрифты/картинки) должен отдавать Nginx напрямую с диска, не нагружая приложение:

```conf
location /static/ {
    root /opt/pet-app/public;           # или alias — в зависимости от структуры
    expires 30d;                        # заголовок Expires
    add_header Cache-Control "public, immutable";   # браузер и CDN не проверяют условия
    access_log off;                     # не писать в access log — меньше I/O
    sendfile on;                        # zero-copy отдача файла
    tcp_nopush on;
}
```

`immutable` корректен только для файлов с хешем в имени (`app.a1b2c3.js` от Vite/webpack) — тогда обновление версии = новый URL. Для `index.html` кэширование минимальное (`expires -1` или короткое), иначе пользователи получат старый HTML со ссылками на удалённые ассеты.

### Rate limiting зонами

```conf
# 1. Объявляем зоны в http-контексте (nginx.conf или conf.d/*)
limit_req_zone $binary_remote_addr zone=global:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=login:10m rate=2r/s;
limit_conn_zone $binary_remote_addr zone=addr:10m;

# 2. Применяем в server/location
server {
    location /api/login {
        limit_req zone=login burst=5 nodelay;   # 2 r/s + всплеск 5 без задержки
        proxy_pass http://app_least_conn;
    }

    location / {
        limit_req zone=global burst=40 nodelay;
        limit_conn addr 20;                       # не более 20 одновременных соединений с IP
        proxy_pass http://app_least_conn;
    }
}
```

Zone — разделяемая память (`10m` хватает на ~160k IP-адресов). `rate` задаётся в r/s или r/m. `burst=N` — очередь из N запросов, которые ждут свободного слота; `nodelay` — обработать их немедленно, не ждя, с риском превышения rate кратковременно. Без `nodelay` пользователи заметят задержки (недопустимо для API). Превышение — `503 Service Temporarily Unavailable`.

### Полный server-блок (HTTP, перед TLS)

```conf
# /etc/nginx/sites-available/pet
server {
    listen 80;
    listen [::]:80;
    server_name pet.darkpix.dev;

    # Логи с разделением времени: Nginx vs upstream
    log_format main '$remote_addr - $status "$request" rt=$request_time '
                    'urt=$upstream_response_time "$http_user_agent"';
    access_log /var/log/nginx/access.log main;

    limit_req_zone $binary_remote_addr zone=global:10m rate=20r/s;

    location /api/ {
        limit_req zone=global burst=40 nodelay;
        proxy_pass http://app_least_conn;
        proxy_http_version 1.1;
        proxy_set_header Connection "";          # keepalive к бэкенду работает
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # приложение знает про HTTPS
        proxy_read_timeout 30s;
        proxy_buffering on;                       # Nginx буферизует ответ — бэкенд не держит медленных клиентов
    }

    location /static/ {
        root /opt/pet-app/public;
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location / {
        proxy_pass http://app_least_conn;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health-check для мониторинга (Prometheus, LB)
    location /healthz {
        access_log off;
        return 200 "ok\n";
    }
}
```

Ключевые механики: `proxy_set_header X-Forwarded-*` — без них приложение генерирует `http://` ссылки и теряет реальный IP клиента; `proxy_buffering on` — Nginx собирает ответ от бэкенда и отдаёт клиенту своим темпом: медленный смартфон не держит бэкенд-воркер занятым; `$upstream_response_time` в логе разделяет вину: большой `urt` при маленьком `rt` — тормозит приложение, оба большие — сеть или очередь соединений.

:::tip[Балансировка — это механизм переживания отказа]
Даже с одним инстансом приложения заводи upstream: когда появится вторая реплика, добавишь её строкой в server-блок, без рефакторинга конфига. А `max_fails`/`fail_timeout` начнут работать сразу.
:::

## TLS: certbot, полный SSL-блок, редирект

### Получение сертификата: standalone и webroot

Certbot выпускает бесплатные сертификаты Let's Encrypt на 90 дней с авто-продлением. Два режима:

```bash
# 1. standalone — certbot сам поднимает временный веб-сервер на 80 порту.
#    Подходит для первого выпуска, когда Nginx ещё не настроен или остановлен.
sudo certbot certonly --standalone -d pet.darkpix.dev

# 2. webroot — certbot кладёт challenge-файл в каталог Nginx.
#    Безопаснее: не конфликтует с работающим Nginx, сертификат продлевается без остановки сервиса.
sudo certbot certonly --webroot -w /var/www/certbot -d pet.darkpix.dev

# Авто-продление: systemd-таймер certbot.timer или cron
sudo certbot renew --dry-run     # проверка продления
```

Для webroot нужен location:

```conf
location /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
```

### Полный production SSL-блок

```conf
# /etc/nginx/sites-available/pet-ssl
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name pet.darkpix.dev;

    ssl_certificate     /etc/letsencrypt/live/pet.darkpix.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pet.darkpix.dev/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/pet.darkpix.dev/chain.pem;  # для OCSP stapling

    # Протоколы: TLS 1.2 минимум, 1.3 предпочтителен
    ssl_protocols TLSv1.2 TLSv1.3;

    # Шифры для TLS 1.2 (1.3 игнорирует эту директиву и имеет собственный набор)
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;    # отдать выбор клиенту (для TLS 1.3 — безразлично, он быстрее)

    # Сессии: кэширование session tickets ускоряет повторные соединения
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;          # отключить tickets — они stateless и не отзываются при компрометации ключа

    # OCSP stapling: Nginx сам проверяет сертификат у Let's Encrypt
    # и прикрепляет подписанный ответ — клиент не ходит на OCSP-сервер сам,
    # нет утечки приватности (какие сайты посещает пользователь) и быстрее
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 1.1.1.1 1.0.0.1 valid=300s;   # резолвер для проверки OCSP

    # HSTS: браузер будет ходить на сайт ТОЛЬКО по HTTPS
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    # Безопасность по умолчанию
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # ... остальной конфиг (location /api/, /static/ и т.д.) — как в HTTP-блоке
}
```

Проверка снаружи: `curl -sI https://pet.darkpix.dev | grep -i strict` и [SSL Labs](https://www.ssllabs.com/ssltest/) — цель A/A+.

:::caution[HSTS — механизм без пути назад]
Пока `max-age` не истёк, браузер не даст зайти по HTTP даже если сертификат протух или ты случайно сломал HTTPS. Порядок включения: отладить весь сайт на HTTPS → включить `max-age=300` (5 минут) на несколько дней → увеличить до `63072000` (2 года) только когда уверен. `includeSubDomains` не используй, пока нет HTTPS на всех поддоменах.
:::

### HTTP→HTTPS редирект

```conf
server {
    listen 80;
    listen [::]:80;
    server_name pet.darkpix.dev;

    # challenge для продления сертификата — без редиректа
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}
```

Важно: challenge-location должен идти ДО редиректа, иначе certbot не сможет продлить сертификат (Let's Encrypt ходит по HTTP и получит 301 вместо challenge-файла).

## Стратегии деплоя

### Rolling update (по одному)

Обновляем реплики по одной: убиваем одну, поднимаем новую, ждём health-check, следующая. Дефолт в Docker Swarm и Kubernetes. На одном VPS с Nginx:

```bash
# 1. Поднимаем новую версию на свободном порту
docker run -d --name app-v2 -p 3001:3000 pet-app:1.5.0

# 2. Проверяем health-check
curl -f http://127.0.0.1:3001/healthz

# 3. Переключаем upstream (правим конфиг, reload)
# upstream app { server 127.0.0.1:3001; }  # v2 полностью заменила v1
sudo nginx -t && sudo systemctl reload nginx

# 4. Убиваем старую
docker stop app-v1 && docker rm app-v1
```

Для двух реплик: `docker compose up -d --no-deps --scale app=2 app` — поднимается вторая, health-check, затем переключение upstream и уменьшение до одной новой. Даунтайма нет, но если новая версия падает после переключения — откат долгий (пересоздание старой).

### Blue-green (две среды, мгновенный откат)

Две полные среды: blue (текущая) и green (новая). Переключение мгновенное: upstream на green, всё ок — оставили; проблемы — вернули на blue за секунду.

```conf
# upstream управляется симлинком: current -> /etc/nginx/upstreams/blue.conf | green.conf
upstream app_bluegreen {
    include /etc/nginx/upstreams/current;
}

# blue.conf:
#     server 127.0.0.1:3000;
# green.conf:
#     server 127.0.0.1:3001;
```

```bash
# Деплой green
docker run -d --name app-green -p 3001:3000 pet-app:1.5.0
curl -f http://127.0.0.1:3001/healthz

# Переключение — атомарно для новых соединений
ln -sf /etc/nginx/upstreams/green.conf /etc/nginx/upstreams/current
sudo nginx -t && sudo systemctl reload nginx

# Откат, если что-то не так — мгновенный
ln -sf /etc/nginx/upstreams/blue.conf /etc/nginx/upstreams/current
sudo systemctl reload nginx
```

Цена: двойной расход ресурсов на время выкатки (RAM, CPU, соединения к БД). Для stateful-приложений с сессиями в памяти — синхронизация сессий или sticky sessions через `ip_hash`.

### Canary (взвешенный трафик)

Новая версия получает 1-5% трафика. Метрики (error rate, latency) сравниваются со старой. Если в норме — доля растёт до 100%. Самая безопасная: при плохом раскладе пострадает только 1-5% запросов.

```conf
upstream app_canary {
    server 127.0.0.1:3000 weight=95;    # стабильная версия, 95% трафика
    server 127.0.0.1:3001 weight=5;     # canary, 5%
}
```

```bash
# Деплой canary
docker run -d --name app-canary -p 3001:3000 pet-app:1.5.0
curl -f http://127.0.0.1:3001/healthz
sudo nginx -t && sudo systemctl reload nginx   # upstream выше уже активен

# Мониторинг: error rate на 3001 vs 3000 (см. главу про метрики)
# Если ошибок < 1% и latency в норме 15 минут — увеличиваем вес:
#   sed -i 's/weight=5/weight=50/' /etc/nginx/sites-available/pet && reload
# Затем weight=100, старую версию убиваем
```

Веса в Nginx — приблизительные: распределение не идеально точное (особенно на малых весах). Для точного canary (по процентам с точностью до запроса) — Envoy, Traefik или Kubernetes с Argo Rollouts. Для pet-проекта на одном VPS — Nginx-весов достаточно.

| Стратегия | Даунтайм | Откат | Стоимость | Сложность |
|---|---|---|---|---|
| Rolling | Нет | Медленный (пересоздание) | Базовая | Низкая |
| Blue-green | Нет | Мгновенный | 2× ресурсы | Средняя |
| Canary | Нет | Мгновенный (уменьшение веса) | Нужна метрика | Высокая |

## Cloudflare как CDN и WAF перед origin

Переведи NS домена на Cloudflare (оранжевое облачко) — и получаешь:

- **CDN**: статика кэшируется на 300+ пулах по миру, пользователь получает её из ближайшего дата-центра.
- **WAF**: фильтрация SQL-инъекций, XSS, ботов на уровне edge — до того, как запрос дошёл до твоего сервера.
- **DDoS-гасение**: трафик атаки поглощается инфраструктурой Cloudflare (террабиты), origin не видит его.
- **TLS на edge**: Cloudflare терминирует HTTPS у себя и может ходить на origin по HTTP (Flexible) или HTTPS (Full/Strict — рекомендуется).

Нюансы при настройке:

```conf
# Nginx должен доверять заголовкам Cloudflare, а не клиента
# Список IP-диапазонов Cloudflare: https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
# ... остальные диапазоны
real_ip_header CF-Connecting-IP;    # Cloudflare передаёт реальный IP в этом заголовке

# Rate limiting теперь работает с реальными IP, а не адресами Cloudflare
limit_req_zone $binary_remote_addr zone=global:10m rate=20r/s;
```

Если пропустить `set_real_ip_from` — все клиенты будут видны как IP Cloudflare: rate limiting превратится в глушение всего трафика, а аналитика покажет один IP. Для SSL между Cloudflare и origin — режим Full (Strict) с самоподписанным или Cloudflare Origin Certificate, иначе возможен downgrade до HTTP на последней миле.

:::tip[Порядок внедрения]
Сначала Nginx с production-конфигом и TLS → затем деплой-стратегия (rolling → blue-green) → только потом Cloudflare. Каждый слой усложняет диагностику: при проблемах снимай их в обратном порядке, чтобы локализовать источник.
:::

## Типичные ошибки и грабли

1. **`systemctl restart nginx` вместо `reload` при деплое конфига.** Рвётся десятки тысяч соединений — пользователи видят ошибку. Хорошо: handler с `state: reloaded`, `nginx -t` перед любым изменением.
2. **Потеря `X-Forwarded-Proto` → бесконечный HTTP→HTTPS редирект за Cloudflare.** Приложение не знает, что исходный запрос был HTTPS, генерирует `http://` ссылки, Nginx редиректит снова. Хорошо: всегда передавать `X-Forwarded-Proto $scheme`, в приложении читать `req.protocol`.
3. **HSTS с `max-age=63072000` с первого дня.** Сломал HTTPS-сертификат — браузер пользователя на два года запомнил «только HTTPS» и не даст зайти даже по HTTP для диагностики. Хорошо: начать с `max-age=300`, увеличивать постепенно.
4. **OCSP stapling без `resolver`.** Nginx не сможет резолвить адрес OCSP-сервера Let's Encrypt, stapling молча не работает. Хорошо: явный `resolver 1.1.1.1 1.0.0.1` и проверка `openssl s_client -connect pet.darkpix.dev:443 -status | grep -A 2 "OCSP response"`.
5. **Rate limiting без учёта Cloudflare.** `limit_req` видит тысячи запросов с IP Cloudflare, блокирует «одного пользователя» (весь трафик). Хорошо: `set_real_ip_from` + список диапазонов CF, либо rate limiting на уровне Cloudflare (Rules), а на origin — только как запасной вариант.
6. **Canary с весом 5 без мониторинга.** 5% трафика идёт на новую версию, которая падает с 500 — но ты узнаешь об этом из жалоб, а не из метрик. Хорошо: dashboard с error rate по `upstream_addr` (3000 vs 3001), алерт на разницу, и только потом увеличение веса.
7. **Кэширование `index.html` с `expires 30d`.** Пользователи получают старый HTML со ссылками на несуществующие JS/CSS-бандлы. Хорошо: `immutable` только для хешированных ассетов, для HTML — `no-cache` или короткий TTL.

## Вопросы на собеседовании

1. **Как работает модель master/worker в Nginx и почему она быстрая?** Master читает конфиг, открывает порты и управляет workers, не обрабатывая соединения. Workers ведут event-driven цикл (epoll), обрабатывая тысячи соединений на процесс без потоков. Это убирает overhead контекстного переключения потоков и блокировки — скорость на статике и keepalive-соединениях.
2. **Разница между `least_conn` и `ip_hash`: когда что использовать?** `least_conn` — распределяет нагрузку по актуальной занятости серверов, хорош для неравномерных запросов (отчёты, Long Polling). `ip_hash` — привязывает клиента к серверу, нужен для stateful-сессий в памяти, но ломается за NAT (много клиентов с одного IP уйдут на одну ноду).
3. **Что такое `proxy_buffering` и почему он важен?** Nginx собирает ответ от бэкенда в буфер и отдаёт клиенту своим темпом. Бэкенд освобождается сразу после полного ответа в буфер — не держит воркер занятым на медленного клиента (смартфон в метро). Без буферинга бэкенд занят на всё время скачивания клиентом.
4. **Как работает OCSP stapling и зачем он нужен?** Nginx периодически запрашивает у Let's Encrypt подписанный ответ о валидности сертификата и прикрепляет его к TLS-handshake. Клиент проверяет его локально, не обращаясь к OCSP-серверу: быстрее и без утечки данных о посещаемых сайтах третьей стороне.
5. **Чем blue-green отличается от canary?** Blue-green — две полные среды, переключение мгновенное и обратимое, но новая версия получает 100% трафика сразу. Canary — новая версия получает долю трафика (1-5%), постепенно увеличиваемую по результатам метрик; безопаснее для рискованных изменений, требует наблюдаемости.
6. **Как Nginx определяет реальный IP клиента за Cloudflare?** Cloudflare передаёт IP в заголовке `CF-Connecting-IP`. Nginx с директивами `set_real_ip_from <диапазоны CF>` и `real_ip_header CF-Connecting-IP` заменяет `$remote_addr` на реальный IP, доверяя только запросам с адресов Cloudflare.
7. **Зачем нужен `keepalive` в upstream и `proxy_http_version 1.1`?** HTTP/1.0 по умолчанию закрывает соединение после каждого запроса. `proxy_http_version 1.1` + `proxy_set_header Connection ""` + `keepalive N` включают переиспользование соединений к бэкенду — без тройного TCP-handshake на каждый запрос.
8. **Почему `nginx -t` обязателен перед reload?** Один неверный символ в конфиге — и reload оставит Nginx со старой конфигурацией (или вовсе не применит её), а restart — не стартует вообще. `nginx -t` проверяет синтаксис до применения, спасая от человеческой ошибки в продакшене.

## Практика

1. Настрой upstream с двумя инстансами приложения (3000/3001), стратегия `least_conn`, `max_fails=3 fail_timeout=30s`, `keepalive 32`. Убей один инстанс и прогони `hey -n 1000 http://localhost/` — убедись, что запросы идут только на живой (в логе `urt` и `upstream_addr`).
2. Включи gzip (level 5, типы css/js/json/svg) и сравни размер ответа: `curl -s -H "Accept-Encoding: gzip" -o /dev/null -w '%{size_download}' http://localhost/api/data` до и после. Затем добавь brotli и повтори с `Accept-Encoding: br`.
3. Настрой две зоны rate limiting: `global` (20 r/s) на `/` и `login` (2 r/s) на `/api/login`. Прогони 50 параллельных запросов (`hey -n 50 -c 10`) на оба эндпоинта, изучи 503 в логе и убедись, что `/api/login` ограничивается жёстче.
4. Выпусти сертификат через `certbot --webroot`, собери полный SSL-блок с HSTS (`max-age=300` первые 3 дня), OCSP stapling и `ssl_session_tickets off`. Проверь на SSL Labs — цель A. Настрой авто-продление через systemd-таймер и проверь `certbot renew --dry-run`.
5. Реализуй blue-green деплой на одном VPS: `app-blue` на 3000, `app-green` на 3001, upstream через include симлинка `current`. Отработай сценарий: деплой green → health-check → переключение → обнаружение ошибки → откат на blue за < 10 секунд.
6. Настрой canary с весами 95/5, подними метрики error rate по `upstream_addr` (Prometheus + nginx log parsing или две метрики приложения). Сымитируй ошибку в canary-версии (50% 500) и убедись, что dashboard показывает рост error rate на 3001, а на 3000 — нет. Уменьши вес до 0 без даунтайма.

## Что почитать

- [Nginx — Reverse Proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/) и [HTTP Load Balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/)
- [Nginx — Rate Limiting](https://www.nginx.com/blog/rate-limiting-nginx/) — механика зон и burst
- [Certbot — инструкции](https://certbot.eff.org/instructions) и [Let's Encrypt — как это работает](https://letsencrypt.org/how-it-works/)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/) — актуальные шифры и протоколы
- [martinfowler.com — BlueGreenDeployment](https://martinfowler.com/bliki/BlueGreenDeployment.html)
- [Cloudflare — IP ranges](https://www.cloudflare.com/ips/) и [Learning Center](https://www.cloudflare.com/learning/)
