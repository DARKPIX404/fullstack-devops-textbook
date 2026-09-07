---
title: "systemd и сети: что держит сервер живым"
description: "Юниты service и timer до последней директивы, journalctl как база логов, изоляция зависимостей; ip/ss/DNS, полный firewall на nftables, tcpdump и SSH-туннели."
---

Сервер — это не просто железо с Linux: это процессы, которые должны стартовать в правильном порядке после перезагрузки, логи, которые нужно читать через год, и сеть, через которую всё это доступно и защищено. В краткой версии ты видел базовый юнит, таймер вместо cron и первые шаги nftables. Здесь — полная механика: все значимые директивы unit-файлов, journalctl как структурированная база данных, sandbox-изоляция сервисов и сетевой блок от `ip route` до полноценного firewall.

:::note[Ментальная модель]
systemd воспринимай как «систему оркестрации процессов на одной машине»: он решает те же задачи, что Kubernetes, — зависимости, рестарты, лимиты ресурсов, логи, — но на уровне одного хоста. Если поймёшь systemd, Kubernetes покажется знакомым.
:::

## Unit-файлы: анатомия

Юнит — декларативное описание того, что systemd должен запустить и как это сопровождать (полный справочник директив — [systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) и [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)). Файл кладётся в `/etc/systemd/system/myapp.service` (свои юниты — только туда; `/usr/lib/systemd/system/` — территория пакетного менеджера, её правки сотрутся при обновлении).

```ini
# /etc/systemd/system/myapp.service
[Unit]
Description=Backend pet-проекта
Documentation=https://gitlab.example.com/myapp
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service
OnFailure=alert-myapp@%n.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
Environment=NODE_ENV=production
EnvironmentFile=-/etc/myapp/env        # "-" — файл опционален
ExecStartPre=/opt/myapp/bin/migrate --dry-run
ExecStart=/usr/bin/node /opt/myapp/dist/server.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=20
KillSignal=SIGTERM
KillMode=mixed

# --- Лимиты ресурсов (cgroups v2) ---
MemoryMax=512M
MemoryHigh=400M
CPUQuota=80%
TasksMax=200
LimitNOFILE=65536

# --- Sandbox и изоляция ---
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/myapp /var/log/myapp

[Install]
WantedBy=multi-user.target
```

Разбор по секциям.

**`[Unit]`** — метаданные и зависимости. `After` — порядок старта (не создаёт жёсткую зависимость, просто «после»). `Wants`/`Requires` — мягкая и жёсткая зависимости: при `Requires=postgresql.service` падение postgres остановит и myapp. `OnFailure` — юнит, который запустится при неудаче (туда — скрипт алерта в Telegram). `StartLimit*` — ограничение частоты рестартов: если сервис упал 5 раз за 5 минут — systemd сдаётся и помечает юнит failed, а не долбит рестарты бесконечно.

**`[Service]`** — сам процесс. `Type=simple` — процесс главный (большинство случаев), `Type=oneshot` — команда, которая выполняется и завершается (миграции, бэкапы), `Type=notify` — процесс сам сообщает о готовности через sd_notify (правильный способ «я поднялся», но требует поддержки в приложении), `Type=forking` — демон, который форкается (старое наследие, избегай). `ExecStartPre` — проверка перед стартом (миграции, проверка конфига: nginx -t). `Restart=on-failure` — рестарт только при падении, а не при `systemctl stop`; альтернативы: `always` (рестартить даже после штатной остановки), `on-abnormal` (по сигналам и таймаутам).

Остановка — отдельная наука. По умолчанию systemd шлёт `SIGTERM`, ждёт `TimeoutStopSec`, потом `SIGKILL`. Приложение обязано корректно обрабатывать SIGTERM: закрыть соединения с БД, дождаться незавершённых запросов. `KillMode=mixed` убивает главный процесс SIGTERM, а его детей — SIGKILL сразу (для node-приложений с воркерами обычно `control-group` + обработка в коде).

**`[Install]`** — когда юнит включается: `WantedBy=multi-user.target` — «в многопользовательском режиме без графики», стандарт для серверов.

После любой правки файла: `sudo systemctl daemon-reload` — иначе systemd продолжит использовать старый вариант из кэша. Забыть daemon-reload — причина половины «почему мои изменения не применились».

## Таймеры: cron, который не теряет запуски

```ini
# /etc/systemd/system/myapp-backup.timer
[Unit]
Description=Ежедневный бэкап myapp

[Timer]
OnCalendar=Mon-Sat *-*-* 03:00:00
OnCalendar=Sun    *-*-* 02:00:00
Persistent=true
RandomizedDelaySec=600
Unit=myapp-backup.service

[Install]
WantedBy=timers.target
```

```ini
# /etc/systemd/system/myapp-backup.service
[Unit]
Description=Бэкап БД myapp

[Service]
Type=oneshot
User=myapp
EnvironmentFile=/etc/myapp/backup.env
ExecStart=/opt/myapp/bin/backup.sh
# oneshot + TimeoutStartSec=0 снимает лимит на время работы длинного бэкапа
TimeoutStartSec=0
```

`OnCalendar` — синтаксис [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) мощнее cron: дни недели, конкретные даты, `*-*-* 03:00:00`, интервалы. `Persistent=true` — ключевое отличие от cron: если сервер был выключен в 03:00, таймер догонит пропущенный запуск сразу после загрузки. `RandomizedDelaySec` — размазывает запуски по флоту серверов, чтобы тысяча машин не ударила в бэкенд бэкапа одновременно.

Проверка расписания до включения: `systemd-analyze calendar "Mon-Sat *-*-* 03:00:00"` — покажет ближайшие моменты запуска. Статус: `systemctl list-timers --all`.

## journalctl: логи как база данных

systemd собирает stdout/stderr и syslog всех сервисов в структурированный журнал (интерфейс запросов к нему — [journalctl(1)](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)). Это не «grep по файлам», это запросы:

```bash
journalctl -u myapp -f                          # живое слежение за сервисом
journalctl -u myapp --since "1 hour ago"        # окно по времени
journalctl -u myapp -p err                      # только приоритет err и выше (emerg..err)
journalctl -b -u myapp                          # с момента текущей загрузки
journalctl -b -1 -u myapp                       # предыдущая загрузка (до ребута!)
journalctl --disk-usage                         # сколько съел журнал
journalctl _PID=1234 _SYSTEMD_UNIT=sshd.service # произвольные поля
journalctl --field=PRIORITY | sort | uniq -c    # что уровней в журнале

# Логи в приложение через structured logging (приоритет из сообщения):
logger -p user.notice -t deploy "Версия 1.4.2 развёрнута"
journalctl -t deploy --since today
```

Три вещи, которые нужно настроить сразу на сервере: ротация (`/etc/systemd/journald.conf`: `SystemMaxUse=500M`, `MaxRetentionSec=1month`), форвардинг в центральное хранилище (Loki/ELK через rsyslog или vector) — локальный журнал переживает ребут, но не смерть диска, и `Storage=persistent`, иначе после аварийного ребута логи прошлой загрузки (`-b -1`) недоступны.

## Изоляция и зависимости через systemctl

```bash
systemctl cat myapp            # итоговый юнит со всеми drop-in переопределениями
systemctl show myapp -p MemoryCurrent -p MemoryMax   # фактическое потребление
systemctl edit myapp           # создать drop-in /etc/systemd/system/myapp.service.d/override.conf
systemctl isolate multi-user.target    # перейти в другой target (аналог runlevel)
systemctl list-dependencies myapp      # дерево зависимостей
systemctl mask myapp           # запретить запуск вообще (симлинк в /dev/null)
```

`systemctl edit` — правильный способ менять юниты пакетов: drop-in файлы лежат отдельно и не конфликтуют с обновлениями пакета. Пример drop-in, который удваивает лимит памяти конкретного сервиса без правки оригинального файла:

```bash
sudo systemctl edit myapp
# откроется редактор с пустым override.conf:
[Service]
MemoryMax=1G
```

После сохранения — `systemctl daemon-reload && systemctl restart myapp`. Финальную конфигурацию всегда смотри через `systemctl cat myapp`: она покажет и оригинал, и все drop-in'ы в порядке применения. Для анализа скорости загрузки есть пара полезных инструментов: `systemd-analyze` (сколько стартовала система целиком и кто тормозил) и `systemd-analyze critical-chain myapp` — цепочка юнитов, определяющих, когда именно myapp получил возможность стартовать.

`systemctl mask` — грубый, но надёжный способ убить сервис навсегда (симлинк юнита в `/dev/null`): например, `systemctl mask postfix` на сервере, где почта не нужна, — иначе его периодически «вежливо» запускают зависимости.

`systemctl isolate` — для экспериментов с target'ами есть rescue и emergency: `systemctl rescue` — однопользовательский режим с сетью, `emergency` — без всего. Это твой запасной вход, когда конфигурация сломана.

## Сети: ip, ss и DNS

Классический набор `ifconfig`/`route`/`netstat` устарел. Современный стек:

```bash
ip addr show                          # адреса и интерфейсы
ip -brief addr                        # компактная таблица: интерфейс | state | адреса
ip route show                         # таблица маршрутизации
ip route add 10.20.0.0/16 via 192.168.1.1      # статический маршрут (до перезагрузки)
ip neigh show                         # ARP/NDP таблица: кто рядом

ss -tulpn                             # слушающие сокеты с процессами — главная команда диагностики
ss -tlnp 'sport = :5432'              # кто слушает 5432
ss -s                                 # сводка по соединениям
ss -ti                                # детали TCP (rwnd, rtt) — при подозрении на медленную сеть
```

`ss -tulpn` — первое, что вводится при «не открывается порт»: `-t` tcp, `-u` udp, `-l` listening, `-p` процесс, `-n` без резолва имён. Не видишь сервис в списке — он не слушает. Видишь `0.0.0.0:3000` — слушает на всех интерфейсах; `127.0.0.1:3000` — только локально, снаружи не достучаться.

DNS-диагностика:

```bash
dig +short example.com A              # быстрый ответ без церемоний
dig example.com @1.1.1.1              # через конкретный резолвер — исключает локальный кэш
dig +trace example.com                # полный путь от корневых серверов (делегирование)
dig -x 93.184.216.34                  # PTR-запись: IP → имя
dig MX gmail.com +short               # почтовые серверы домена

nslookup example.com                  # устаревший, но живучий
host example.com                      # самый короткий вывод

# А что реально использует система:
resolvectl status                     # systemd-resolved: какие DNS и в каком порядке
cat /etc/resolv.conf                  # классика; внимание на symlink
getent hosts example.com              # резолв глазами libc — то, что видит приложение
```

Классический сценарий расследования: «сервер не резолвит домены». Смотришь `resolvectl status` — DNS указывает на `127.0.0.53`; смотришь `dig @127.0.0.53 example.com` — таймаут; поднимаешься выше: `dig @8.8.8.8 example.com` — работает. Значит, сломался upstream резолвера. `getent` важен потому, что приложения ходят через nsswitch (`files dns myhostname`), а не через dig напрямую — разница объясняет «dig работает, а curl — нет».

## nftables: firewall как код

iptables умер, жив [nftables](https://wiki.nftables.org/wiki-nftables/index.php/Main_Page): атомарное применение всего набора правил, читаемый синтаксис, единые таблицы для IPv4/IPv6 (`inet`). Полный рабочий firewall для одного сервера:

```nft
#!/usr/sbin/nft -f
# /etc/nftables.conf — полный набор для VPS: SSH + HTTP(S), остальное — drop

flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        # Легитимный ответный трафик — первым делом
        ct state established,related accept

        # Локалхост — всегда
        iif lo accept
        ip saddr 127.0.0.0/8 iif != lo drop   # анти-спуфинг: 127.* не должен приходить снаружи

        # ICMP — нужен для диагностики и MTU (v6 — обязателен для работы сети)
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # Защита от SYN-флуда: ограничение новых соединений
        tcp flags syn ct state new limit rate 20/second burst 40 packets accept
        tcp flags syn ct state new drop

        # SSH с ограничением попыток: 4 попытки в минуту, дальше — бан на 10 минут
        tcp dport 22 ct state new limit rate 4/minute burst 2 packets accept
        tcp dport 22 ct state new add @ssh_abuse { ip saddr timeout 10m } drop

        # Публичные сервисы
        tcp dport { 80, 443 } accept

        # Всё остальное — тишина (policy drop выше)
        counter log prefix "nft-input-drop: " drop
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }

    set ssh_abuse {
        type ipv4_addr
        flags timeout
        timeout 10m
    }
}
```

Применение и контроль:

```bash
sudo nft -c -f /etc/nftables.conf    # СНАЧАЛА dry-run: проверка синтаксиса (-c = check)
sudo nft -f /etc/nftables.conf       # атомарное применение: либо всё, либо ничего
sudo nft list ruleset                # что реально загружено
sudo nft monitor trace               # какое правило сработало для пакета
```

Принципы, которые здесь работают: established/related первой строкой (иначе ответы твоих же запросов уйдут в drop и ты отрежешь сам себя), политика по умолчанию — drop, счётчики и лог на «тихий» трафик (посмотри через `journalctl -k` что сканирует твой сервер — удивишься), rate-limit на SSH до публичного интернета — обязателен, боты брутфорсят круглосуточно.

:::caution[Как не остаться без SSH]
Применяя firewall удалённо, всегда: (1) `nft -c` сначала, (2) держи вторую сессию SSH открытой — проверь, что новая коннектится, (3) ставь `at now + 5 minutes` с откатом (`nft flush ruleset && nft -f /etc/nftables.conf.bak`) на случай, если отрежешь себя.
:::

## tcpdump: глаза на проводе

Когда «не работает» на уровне сети — tcpdump показывает реальные пакеты:

```bash
tcpdump -i any -n port 443                        # весь HTTPS-трафик
tcpdump -i any -n host 10.0.0.5 and port 5432     # конкретный разговор с БД
tcpdump -i any -n 'tcp[tcpflags] & tcp-syn != 0'  # только SYN: кто инициирует соединения
tcpdump -i any -n -A 'port 80'                    # тела пакетов ASCII (HTTP без TLS)
tcpdump -i any -n -w capture.pcap port 53         # в файл для Wireshark
tcpdump -i any -n -c 100 'icmp'                   # первые 100 ICMP-пакетов (ping/пути)

# Классика диагностики: SYN уходит, ответа нет — пакеты теряются где-то по пути
# SYN уходит, RST приходит — порт закрыт на той стороне
# SYN уходит, SYN-ACK приходит — соединение есть, проблема выше (приложение)
```

Практика безопасности: на проде с `-A` и `-w` по будням — норма, постоянный дамп — нет: трафик содержит секреты (токены в HTTP-заголовках до TLS-терминации). Правило интерпретации: RST от удалённой стороны = порт закрыт; молчание + ретрансмиты = firewall/роутинг; RST от своего хоста сразу = локальный порт никто не слушает (`ss -tulpn` это подтвердит).

## SSH-туннели и проброс портов

SSH — это не только shell, это зашифрованный транспорт:

```bash
# Локальный форвардинг (-L): база на удалённом сервере → localhost:5433
ssh -L 5433:localhost:5432 deploy@prod.example.com

# Удалённый форвардинг (-R): мой локальный порт 3000 доступен на bastion'е
ssh -R 8080:localhost:3000 user@bastion.example.com

# Динамический SOCKS-прокси (-D): весь трафик браузера через сервер
ssh -D 1080 deploy@prod.example.com

# Живучий туннель в фоне с автопереподключением
ssh -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 -L 5433:localhost:5432 deploy@prod.example.com
```

`-fN` — форк в фон без выполнения команды (чистый туннель). `ExitOnForwardFailure` — не молча продолжать, если порт занят. `ServerAliveInterval` — держит NAT-сессию и рвёт мёртвый туннель, чтобы autossh/systemd могли его переподнять.

Сценарий из практики: локально разрабатываешь бэкенд, а база — в приватной сети продакшена. Один `ssh -L 5433:db.internal:5432 deploy@bastion` — и `psql -h localhost -p 5433` работает с твоего ноутбука, при этом БД никогда не торчит в публичный интернет. Для постоянных туннелей оформляй systemd-юнит с `Restart=always` — тогда SSH-туннель становится сервисом с логами, зависимостями и автостартом.

## Типичные ошибки и грабли

:::caution[Проверка перед правкой]
Единственный способ навсегда избавиться от «отрезал себя SSH при настройке firewall» — дисциплина: второй открытый сеанс + `at now + 5 minutes` с командой отката. Применяй её к любому удалённому изменению сети, не только к nftables.
:::

1. **Правка unit-файла без `daemon-reload`.** systemd читает юниты в свой кэш; изменения в файле без перезагрузки демона игнорируются, и ты правишь «не тот конфиг». После КАЖДОЙ правки — `systemctl daemon-reload`.
2. **`Restart=always` при падающем старте.** Если приложение падает за секунду из-за ошибки конфига, `always` превращает сервер в генератор core-дампов. Всегда `on-failure` + `StartLimitBurst`.
3. **`KillSignal=SIGKILL` «для надёжности».** Жёсткое убийство без graceful shutdown — закрытые на середине транзакции соединения с БД, битые лок-файлы, потерянные сообщения из очередей. Оставляй SIGTERM и пиши обработку в приложении.
4. **Открытый `0.0.0.0` у сервиса, который должен быть локальным.** PostgreSQL, Redis, RabbitMQ — всегда `127.0.0.1` или приватный интерфейс + firewall. Проверка: `ss -tulpn`, всё, что слушает `0.0.0.0`, — подозрительно.
5. **`flush ruleset` в чужом конфиге.** Если в /etc/nftables.conf одной строкой написано `flush ruleset`, а дальше — ошибка, ты останешься без правил совсем (включая loopback-accept). Сегментируй наборы и проверяй `nft -c`.
6. **Логи в journald без ротации.** По умолчанию journald может съесть 4 ГБ и больше на говорливом сервисе. `SystemMaxUse` и `MaxRetentionSec` — первые настройки любого нового сервера.

## Вопросы на собеседовании

**Чем `Wants` отличается от `Requires` в `[Unit]`?**
`Wants` — мягкая зависимость: systemd попробует запустить зависимость до юнита, но если она недоступна — юнит стартует и так. `Requires` — жёсткая: зависимость обязана стартовать, при её остановке остановится и сам юнит. Для критичных связок (app + его БД) — `Requires`, для опциональных — `Wants`.

**В чём преимущество timer'ов перед cron?**
Три вещи: `Persistent=true` догоняет пропущенные запуски после простоя (cron молча пропускает); запуски пишутся в journald с stdout, кодом выхода и точным временем; `RandomizedDelaySec` и зависимости юнитов (`Requires`/`After`) делают оркестрацию осмысленной, а не строкой в таблице.

**Что покажет `ss -tulpn` и как прочитать его вывод?**
Все слушающие TCP/UDP-сокеты с PID и именем процесса. Колонка Local Address: `0.0.0.0:80` — слушает все интерфейсы (доступен снаружи), `127.0.0.1:6379` — только локально, `[::1]:3000` — IPv6 loopback. Если сервис должен быть доступен, но его нет в списке — он не запущен или слушает другой порт/интерфейс.

**Как правильно «открыть порт» в nftables и чем это отличается от iptables -A INPUT -p tcp --dport 80 -j ACCEPT?**
В nftables правило добавляется в цепочку конкретной таблицы (`add rule inet filter input tcp dport 80 accept`) и весь набор применяется атомарно через `nft -f`. В iptables правила применялись по одному: при ошибке посередине ты оставался с половиной набора. Плюс inet-таблица покрывает IPv4 и IPv6 разом.

**Пакеты доходят до сервера? Как диагностировать с tcpdump?**
Смотришь тройное рукопожатие: `tcp[tcpflags] & tcp-syn != 0`. Только исходящие SYN без ответов — фильтр/роутинг по пути; SYN и RST — порт закрыт на цели; SYN и SYN-ACK, потом FIN — TCP работает, проблема в приложении выше. Снимай на обоих концах одновременно — где пакет исчез, там и рвётся цепь.

**Зачем `ProtectSystem=strict` и `NoNewPrivileges` в сервисах?**
Это sandbox: сервис получает ФС только на чтение (кроме явных `ReadWritePaths`), не видит /home и /root, не может поднять привилегии через setuid-бинарники. Скомпрометированный процесс оказывается в клетке, а не на всей системе. В связке с `PrivateTmp` и `ProtectHome` — стандартный набор для любого публичного сервиса.

## Практика

1. **Боевой юнит приложения.** Оформи node-бэкенд как systemd-юнит: `User=myapp`, `EnvironmentFile`, `Restart=on-failure` + StartLimit, лимиты `MemoryMax`/`CPUQuota`, sandbox-директивы (`ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`). Критерий: `systemctl start` работает, `systemctl show` показывает лимиты, приложение пишет логи в journald.
2. **Таймер бэкапов.** Напиши пару timer+service для ежедневного дампа PostgreSQL в 03:00 с `Persistent=true` и `RandomizedDelaySec=900`. Проверь `systemd-analyze calendar`, убедись через `systemctl list-timers`, что расписание ближайшее срабатывание считает верно.
3. **Firewall с нуля.** На тестовой VM собери набор nftables: SSH с rate-limit, 80/443 открыты, established-first, логирование дропов. Примени через `nft -c`, проверь снаружи `nmap -Pn -p-`. Критерий: извне видны только 22/80/443, лог дропов пишет в journald.
4. **DNS-расследование.** Сломай намеренно резолвинг (укажи несуществующий DNS в netplan/resolved), потом почини, фиксируя каждый шаг: `resolvectl status` → `dig @upstream` → `getent`. Результат — заметка с картой «что смотреть, когда не резолвится».
5. **SSH-туннель как сервис.** Оформи `ssh -L 5433:localhost:5432` как systemd-юнит с `Restart=always` и автостартом. Критерий: после `systemctl restart` и после обрыва сети туннель сам восстанавливается, в логах видны переподключения.

## Что почитать

- [systemd.service(5) и systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) — все директивы, включая sandbox
- [systemd.timer(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) — синтаксис OnCalendar с примерами
- [Arch Wiki — nftables](https://wiki.archlinux.org/title/Nftables) — рабочие примеры наборов правил
- [iproute2 cheat sheet](https://jensd.be/1204/linux/ip-route-cheatsheet) — соответствие старых и новых команд
- [tcpdump examples](https://danielmiessler.com/study/tcpdump/) — подборка фильтров для боевых сценариев
