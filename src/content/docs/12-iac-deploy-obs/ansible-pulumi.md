---
title: "Ansible и Pulumi: настройка серверов и IaC на TypeScript"
description: "Полный Ansible-пайплайн: инвентари, плейбуки с template и handlers, роли, vault, идемпотентность, --check/--diff. Pulumi: стеки, конфиг, ресурсы на TypeScript и сравнение с Terraform."
---

Terraform выдал IP сервера — и здесь заканчивается его зона ответственности. Всё, что происходит внутри машины после первой загрузки, — территория Ansible: пакеты, пользователи, юниты, конфиги Nginx, деплой приложения. В краткой версии ты написал первый плейбук и почувствовал магию: повторный прогон не ломает ничего, а просто подтверждает, что система уже в нужном состоянии. Теперь разберёмся, как эта магия устроена, где её границы и как строить Ansible-проекты так, чтобы их не стыдно было показать в продакшене.

А затем посмотрим в другую сторону: Pulumi — тот же IaC-подход, но без HCL. Ресурсы описываются программой на TypeScript (или Python, Go, C#), состояние живёт в Pulumi Cloud или своём бэкенде, а циклы, условия и функции — обычные конструкции языка. Сравним честно: где Pulumi выигрывает, где проигрывает и стоит ли он нарушения привычного Terraform-пайплайна.

## Ansible под капотом: как это работает

Ansible — агентless: на целевых серверах ничего ставить не нужно, только SSH и Python (архитектура и каталог модулей — в [документации Ansible](https://ansible.readthedocs.io/)). Запуск плейбука — это опрос инвентаря, установка временных Python-модулей на удалённую машину через SSH и выполнение модулей один за другим. Каждый модуль идемпотентен по дизайну: он сначала читает текущее состояние («установлен ли пакет? совпадает ли файл?»), сравнивает с желаемым и меняет только разницу. Жёлтый `changed` в выводе — состояние реально изменилось; зелёный `ok` — уже было как надо.

Это принципиально отличает Ansible от bash-скриптов: скрипт «apt install docker» падает или ломает при повторном запуске, модуль `ansible.builtin.apt` с `state: present` — просто отчитывается `ok`. Идемпотентность — не свойство «обычно работает», а контракт модуля.

## Инвентари: от статики к динамике

Инвентарь — список хостов и переменных. Минимум:

```text
# inventory.ini
[pet]
pet-prod ansible_host=116.203.10.20 ansible_user=ubuntu

[pet:vars]
env=prod
app_domain=pet.darkpix.dev
```

Более гибкий формат — YAML, он же позволяет группы внутри групп:

```yaml
# inventory.yml
all:
  children:
    pet:
      hosts:
        pet-prod:
          ansible_host: 116.203.10.20
          ansible_user: ubuntu
      vars:
        env: prod
        app_domain: pet.darkpix.dev
    monitoring:
      hosts:
        mon-01:
          ansible_host: 116.203.10.21
```

Хосты в группы, переменные — на уровне группы (`group_vars/pet.yml`) или хоста (`host_vars/pet-prod.yml`). Terraform выводит IP — инвентарь строится автоматически через `templatefile` или плагин `terraform-inventory`. Для облаков с автомасштабированием вместо статики — **dynamic inventory**: плагин ходит в API провайдера и собирает хосты сам (`-i inventory/hcloud.yml`).

:::tip[Собирай инвентарь из Terraform]
В корневом Terraform-модуле: `resource "local_file" "inventory" { content = templatefile("inventory.tpl", { ip = module.pet_server.ipv4 }) }`. CI-цепочка: `terraform apply` → артефакт `inventory.ini` → `ansible-playbook`. Руки к inventory не прикасаются — иначе расхождение гарантировано.
:::

## Ad-hoc команды

Быстрые разовые действия без плейбука:

```bash
# Проверка связи со всеми хостами
ansible -i inventory.ini all -m ping

# Факты о системе (дистрибутив, ядро, память) — кладутся в переменные ansible_*
ansible -i inventory.ini pet -m setup | less

# Разовая команда: свободное место на диске
ansible -i inventory.ini pet -m shell -a "df -h /"

# Перезапуск сервиса на всех хостах группы (become = sudo)
ansible -i inventory.ini pet -m service -a "name=nginx state=restarted" --become
```

Ad-hoc хорош для диагностики и разовых операций; всё, что повторяется больше одного раза или содержит логику, — в плейбук.

## Полный плейбук: Docker + деплой приложения + Nginx

Соберём production-grade плейбук для pet-проекта. Структура:

```text
ansible/
├── inventory.ini
├── playbook.yml
├── group_vars/
│   └── all/
│       ├── vars.yml        # обычные переменные
│       └── vault.yml       # зашифрованные секреты
├── templates/
│   └── nginx.conf.j2       # Jinja2-шаблон
└── files/
    └── docker-compose.yml  # статичный файл, копируется как есть
```

```yaml
# playbook.yml
- name: Настройка pet-сервера: Docker, приложение, Nginx
  hosts: pet
  become: true                       # sudo для всех задач
  vars:
    app_user: app
    app_dir: /opt/pet-app
    app_version: "1.4.2"

  tasks:
    # --- Базовая гигиена ---
    - name: Обновить кэш пакетов
      ansible.builtin.apt:
        update_cache: true
        cache_valid_time: 3600       # не дёргать apt чаще раза в час
      tags: [base]

    - name: Установить зависимости Docker
      ansible.builtin.apt:
        name: [ca-certificates, curl, gnupg]
        state: present
      tags: [base]

    # --- Docker из официального репозитория ---
    - name: Ключ репозитория Docker
      ansible.builtin.apt_key:
        url: https://download.docker.com/linux/ubuntu/gpg
        keyring: /etc/apt/keyrings/docker.gpg
      tags: [docker]

    - name: Репозиторий Docker
      ansible.builtin.apt_repository:
        repo: "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu {{ ansible_facts['distribution_release'] }} stable"
        filename: docker
      tags: [docker]

    - name: Установить Docker
      ansible.builtin.apt:
        name: [docker-ce, docker-ce-cli, containerd.io, docker-compose-plugin]
        state: present
        update_cache: true
      tags: [docker]

    - name: Docker запущен и в автозапуске
      ansible.builtin.service:
        name: docker
        state: started
        enabled: true
      tags: [docker]

    - name: Пользователь приложения в группе docker
      ansible.builtin.user:
        name: "{{ app_user }}"
        groups: docker
        append: true
      tags: [docker]

    # --- Деплой приложения ---
    - name: Каталог приложения
      ansible.builtin.file:
        path: "{{ app_dir }}"
        state: directory
        owner: "{{ app_user }}"
        mode: "0755"
      tags: [app]

    - name: Выкатить compose-файл версии {{ app_version }}
      ansible.builtin.template:
        src: docker-compose.yml.j2
        dest: "{{ app_dir }}/docker-compose.yml"
        owner: "{{ app_user }}"
        mode: "0644"
      register: compose_file                  # запомнили, изменился ли файл
      tags: [app]

    - name: Поднять контейнеры приложения
      ansible.builtin.command:
        cmd: docker compose up -d --remove-orphans
        chdir: "{{ app_dir }}"
      when: compose_file.changed              # только если конфиг изменился
      become_user: "{{ app_user }}"
      tags: [app]

    # --- Nginx через шаблон ---
    - name: Конфиг Nginx из шаблона
      ansible.builtin.template:
        src: nginx.conf.j2
        dest: /etc/nginx/sites-available/pet
        mode: "0644"
      notify: Перезапустить Nginx             # handler — только при реальном diff
      tags: [nginx]

    - name: Включить сайт
      ansible.builtin.file:
        src: /etc/nginx/sites-available/pet
        dest: /etc/nginx/sites-enabled/pet
        state: link
      notify: Перезапустить Nginx
      tags: [nginx]

    - name: Проверить конфиг перед reload
      ansible.builtin.command: nginx -t
      tags: [nginx]

  # Handlers: выполняются ОДИН раз в конце, если хотя бы один notify сработал
  handlers:
    - name: Перезапустить Nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
        enabled: true
```

Шаблон `templates/nginx.conf.j2` — обычный конфиг Nginx с Jinja2-подстановками:

```conf
# templates/nginx.conf.j2
upstream app_backend {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name {{ app_domain }};

    location / {
        proxy_pass http://app_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Один шаблон — любое окружение: для staging подставляется `app_domain: staging.pet.darkpix.dev` из `group_vars`. Tags позволяют гонять части плейбука: `ansible-playbook playbook.yml -t docker` обновит только Docker, не трогая приложение.

:::caution[Handler не сработал, потому что имя отличается]
`notify: Restart nginx`, а handler называется `Перезапустить Nginx` — notify молча игнорируется. Имена в notify и handler совпадают до символа. Следи за этим при копировании плейбуков.
:::

## Роли и ansible-galaxy

Когда плейбук обрастает задачами, его раскладывают по ролям — стандартной структуре с жёсткими каталогами:

```text
roles/
└── nginx/
    ├── tasks/main.yml        # что делать
    ├── handlers/main.yml     # реакции на изменения
    ├── templates/nginx.conf.j2
    ├── defaults/main.yml     # значения по умолчанию (переопределяются)
    └── vars/main.yml         # внутренние переменные роли
```

```yaml
# playbook.yml с ролями
- hosts: pet
  become: true
  roles:
    - role: docker
    - role: nginx
      vars:                              # параметризация роли
        nginx_server_name: pet.darkpix.dev
```

`ansible-galaxy` — и каталог ролей сообщества, и тулза для управления зависимостями:

```bash
ansible-galaxy install geerlingguy.docker          # из Galaxy
ansible-galaxy install -r requirements.yml         # зависимости проекта
```

```yaml
# requirements.yml
roles:
  - name: geerlingguy.docker
    version: 7.1.0           # фиксируем версию!
```

Стороннюю роль бери только после чтения её кода: качество в Galaxy неравномерное, а чужая роль с `shell`-задачами и `state: latest` под пятницу уронит тебе сервис.

## Секреты: ansible-vault

Пароли БД и API-токены в репозитории — только в зашифрованном виде ([ansible-vault](https://docs.ansible.com/ansible/latest/vault_guide/index.html)). Vault шифрует целые файлы или отдельные значения:

```bash
# Зашифрованный файл переменных (редактор откроется сам)
ansible-vault create group_vars/all/vault.yml

# Правка существующего
ansible-vault edit group_vars/all/vault.yml

# Шифруем одно значение прямо в vars.yml
ansible-vault encrypt_string 's3cr3t-db-password' --name vault_db_password
```

```yaml
# group_vars/all/vars.yml — открытый файл, секреты через vault_*
db_host: pet-postgres
db_password: "{{ vault_db_password }}"     # значение из расшифрованного vault.yml
```

```bash
# Запуск с passphrase
ansible-playbook -i inventory.ini playbook.yml --ask-vault-pass

# В CI — через файл с правами 0600, удаляемый после прогона
echo "$ANSIBLE_VAULT_PASSWORD" > /tmp/.vault && chmod 600 /tmp/.vault
ANSIBLE_VAULT_PASSWORD_FILE=/tmp/.vault ansible-playbook -i inventory.ini playbook.yml
rm -f /tmp/.vault
```

Ключевые правила: passphrase от vault — в CI-secrets, а не рядом с репозиторием; в git-коммитах не должно быть ни одного расшифрованного секрета (проверяй `git grep -l vault_` в review); для prod и staging — разные vault-файлы с разными passphrase.

## Проверка до применения: --check и --diff

Две флаги, которые делают Ansible предсказуемым:

```bash
# Dry-run: что ИЗМЕНИЛОСЬ бы, без применения
ansible-playbook -i inventory.ini playbook.yml --check

# + показать diff по файлам, которые перезапишутся
ansible-playbook -i inventory.ini playbook.yml --check --diff

# Смотреть diff только на одной машине (наш любимый канареечный хост)
ansible-playbook -i inventory.ini playbook.yml --check --diff --limit pet-prod
```

Важная оговорка: `--check` работает идеально только для идемпотентных модулей. Модули с побочными эффектами (`command`, `shell`, некоторые cloud-модули) в check-режиме могут либо пропустить проверку, либо дать неверный прогноз — поэтому критичные ветки плейбука проверяй на staging, а не только `--check` на prod.

## Pulumi: IaC на TypeScript

Pulumi — IaC-движок, где конфигурация — обычная программа ([документация](https://www.pulumi.com/docs/)). Инициализация проекта:

```bash
mkdir infra-pulumi && cd infra-pulumi
pulumi new typescript                    # шаблон с package.json и index.ts
pulumi stack init prod                   # стек = изолированный state + конфиг
pulumi config set hcloud:token --secret  # секреты — в конфиге стека, зашифрованы
```

**Стек** — аналог workspace в Terraform: изолированный набор ресурсов со своим state и конфигом. `pulumi stack select` переключает окружение. **Конфиг** стека — key-value, значения могут быть секретными (`--secret`), в коде читаются через `config.require`/`getSecret`.

Ресурсы — классы из пакетов провайдеров; ссылки между ними работают как обычные переменные TypeScript:

```ts
// index.ts — тот же pet-сервер, что и в Terraform-главе
import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";

const config = new pulumi.Config();
const env = config.get("env") ?? "staging";

const sshKey = new hcloud.SshKey("admin", {
  publicKey: process.env.SSH_PUBLIC_KEY!,
});

// Две реплики API — цикл языка, а не count/for_each
const servers = Array.from({ length: env === "prod" ? 2 : 1 }, (_, i) =>
  new hcloud.Server(`pet-api-${i}`, {
    serverType: env === "prod" ? "cx22" : "cx11",
    image: "ubuntu-24.04",
    location: "fsn1",
    sshKeys: [sshKey.id],
    userData: `#!/bin/bash
      apt-get update && apt-get install -y fail2ban ufw
      ufw allow OpenSSH && ufw --force enable`,
  }),
);

// DNS-запись: зависимость выражается ссылкой на свойство ресурса
const zone = hcloud.getDnsZone({ name: "darkpix.dev" });
new hcloud.DnsRecord("pet-a", {
  zoneId: zone.then((z) => z.id),
  name: env === "prod" ? "pet" : `pet-${env}`,
  type: "A",
  value: servers[0].ipv4Address,
  ttl: 300,
});

// Stack outputs — аналог terraform output
export const serverIps = servers.map((s) => s.ipv4Address);
export const fqdn = env === "prod" ? "pet.darkpix.dev" : `pet-${env}.darkpix.dev`;
```

```bash
pulumi preview      # как terraform plan
pulumi up           # preview + подтверждение + apply
pulumi destroy      # удалить ресурсы стека
pulumi stack output serverIps   # прочитать выводы (например, для CI)
```

Программа выполняется Pulumi-движком, который сравнивает желаемое состояние с state и считает дифф — декларативность сохраняется, хотя синтаксис императивный. Данные-зависимости (нужен ID зоны до создания записи) Pulumi разрешает сам, превращая свойства ресурсов в Promise-подобные `Output<T>`.

### Pulumi vs Terraform

| Критерий | Terraform | Pulumi |
|---|---|---|
| Язык | HCL (декларативный DSL) | TS/JS, Python, Go, C# |
| Логика (циклы, условия) | count/for_each/dynamic, ограниченно | полноценный язык |
| State | local файл, S3, Terraform Cloud | Pulumi Cloud (бесплатно), S3, файловый |
| Экосистема | огромная: 3000+ провайдеров, модули в Registry | меньше, но есть все крупные облака |
| Тестирование | terratest (Go), tflint | обычные unit-тесты на TS |
| Командный опыт | стандарт де-факто, все умеют | требует Node-туулчейна |
| Ревью | HCL читается даже непрограммистами | нужно читать код |

Практический вывод: для стандартной облачной инфраструктуры Terraform — безопасный выбор по экосистеме и найму. Pulumi окупается, когда логика инфраструктуры сложная (генерация сотен похожих ресурсов из данных, переиспользование библиотек, тестирование), либо когда команда целиком на TypeScript и HCL воспринимается как чужеродный слой.

:::tip[Правило императивности]
В Pulumi циклы и условия — для генерации ресурсов, но не для побочных эффектов: запросы в сеть и запись файлов внутри кода во время preview ломают модель. Если в пульми-программе появился `fetch` — это тревожный сигнал.
:::

## Типичные ошибки и грабли

1. **Скриптовое мышление в плейбуках.** `shell: apt install docker` вместо модуля `apt` — плейбук перестаёт быть идемпотентным и ломается при повторе. Хорошо: модули везде, где возможно; `command/shell` — только для того, чего нет модулем, с `creates:`/`removes:`-ограничителями.
2. **Копирование файлов через `copy` вместо `template`.** Конфиг с хардкодом домена вместо Jinja2-переменной — окружения расходятся, правка руками на сервере. Хорошо: всё, что меняется между env, — в `group_vars`, файлы выкатываются `template`.
3. **Notify на handler с опечаткой в имени.** Сайт обновился, Nginx не перечитал конфиг — час «недоступности», который лечился reload. Хорошо: `--diff` прогон на staging, проверка что handler числится в recap `changed` → handler запускается в `RUNNING HANDLER`.
4. **Секреты в открытых переменных.** `db_password: hunter2` в `group_vars/all/vars.yml` — попал в git вместе с коммитом. Хорошо: vault с первого дня, `ansible-vault encrypt_string` для точечных значений, pre-commit проверка на незашифрованные `vault_*`.
5. **`--check` как единственная защита prod.** Модули `command`/`shell` в check-режиме врут или пропускаются; «в dry-run всё чисто» ≠ «на prod не сломается». Хорошо: сначала `--limit` на одном staging-хосте, потом prod.
6. **Pulumi-программа с побочными эффектами.** HTTP-запросы и запись файлов в теле index.ts выполнятся и при preview — создавая мусор и непредсказуемые диффы. Хорошо: только создание ресурсов; данные — через data-source аналоги (`hcloud.getDnsZone`), секреты — через `config.getSecret`.
7. **Сторонние Galaxy-роли без аудита.** Роль с `state: latest` для всех пакетов или открытым 0.0.0.0/0 в фаерволе — подарок для инцидента. Хорошо: читать код роли до установки, фиксировать версию в requirements.yml, оборачивать чужие роли своими defaults.

## Вопросы на собеседовании

1. **Почему Ansible называют agentless и в чём это плюс?** Управляющая нода подключается по SSH и доставляет временные Python-модули на целевую машину — агентов ставить не надо. Плюс: работает с любым свежим Linux из коробки, нет проблем с обновлением агентов на флоте, меньше поверхность атаки. Минус: требует Python и SSH на таргетах и медленнее агентных систем на тысячах хостов.
2. **Что такое идемпотентность в Ansible и кто её обеспечивает?** Свойство повторного прогона приводить систему к тому же состоянию без побочных эффектов. Обеспечивают сами модули: они читают текущее состояние и применяют только разницу. Неидемпотентные `command/shell` — зона ответственности автора плейбука.
3. **Зачем нужны handlers, если можно перезапускать сервис в task?** Handler выполняется один раз в конце и только если сработал notify — сервис не перезапускается трижды при трёх изменённых файлах. Перезапуск внутри task — при каждом прогоне, что лишние даунтаймы и потеря соединений (`nginx reload` вместо restart — ещё и без разрыва).
4. **Как устроено хранение секретов в Ansible?** `ansible-vault` шифрует файлы или строки AES256; passphrase вводится интерактивно, через `--vault-password-file` или переменную окружения. В CI passphrase — в secrets, файл с правами 0600 удаляется после прогона. Расшифрованные значения подставляются в рантайме, в git попадает только шифртекст.
5. **В чём разница роли и плейбука?** Плейбук — сценарий применения: хосты, порядок, vars. Роль — переиспользуемый пакет (tasks/handlers/templates/defaults/vars) с чёткой структурой каталогов и параметризацией через defaults. Плейбук оркестрирует роли.
6. **Когда выбрать Pulumi вместо Terraform?** Когда логика инфраструктуры требует полноценного языка (генерация ресурсов из структур данных, переиспользование npm-пакетов, unit-тесты), когда команда целиком пишет на TypeScript, или когда один стек должен совмещать инфраструктуру и runtime-код. Для стандартных облачных ресурсов Terraform выигрывает экосистемой и зрелостью.
7. **Что такое стек в Pulumi и чем он похож на workspace?** Стек — изолированный экземпляр инфраструктуры со своим state, конфигом и выводами — прямой аналог Terraform workspace. Отличия: конфиг хранится вместе со state в бэкенде, у стека есть выводы-outputs, читаемые через CLI и из других стеков (stack references — как outputs модулей в Terraform).
8. **Как построить цепочку Terraform → Ansible в CI?** `terraform apply` генерирует inventory через `templatefile`/local_file → артефакт `inventory.ini` → job `ansible-playbook -i inventory.ini playbook.yml --diff` → при падении — откат по логам. Критично: inventory никогда не редактируется руками, иначе state Terraform и реальность расходятся.

## Практика

1. Разбей плейбук из главы на три роли (`docker`, `app`, `nginx`) со структурой `tasks/`, `handlers/`, `templates/`, `defaults/`. Плейбук вызывает роли с параметрами из `group_vars`; прогони `--check --diff` и убедись, что повторный прогон даёт только `ok`.
2. Настрой `ansible-vault` для `group_vars/all/vault.yml` с паролем БД. Проверь: `git grep` по репозиторию не находит открытого пароля; запуск из CI через `ANSIBLE_VAULT_PASSWORD_FILE` проходит успешно.
3. Напиши ad-hoc диагностику: одной командой собери версии Docker и свободное место по всем хостам группы `pet` и выведи таблицей. Сравни с ручным SSH на каждый хост — что быстрее?
4. Перепиши сервер из Terraform-главы на Pulumi (TypeScript): SSH-ключ, сервер cx22, DNS-запись, stack outputs. Сравни длину кода, время `preview` и читаемость диффа с Terraform-версией.
5. Сымитируй handler-баг: опечатайся в имени notify, прогони плейбук с изменённым шаблоном и убедись, что сервис не перезапустился (нет строки `RUNNING HANDLER`). Затем исправь имя и проверь, что handler отработал.
6. Добавь в CI пайплайн канареечный прогон: сначала `ansible-playbook --limit pet-staging --check --diff`, затем полный прогон staging, только потом prod. Сымитируй падение на staging и убедись, что prod не тронут.

## Что почитать

- [Ansible Playbooks](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_intro.html) и [Best Practices](https://docs.ansible.com/ansible/latest/tips_tricks/ansible_tips_tricks.html)
- [Ansible Vault](https://docs.ansible.com/ansible/latest/vault_guide/index.html) — шифрование секретов
- [Ansible Galaxy](https://galaxy.ansible.com/) — каталог ролей и коллекций
- [Pulumi: Get Started](https://www.pulumi.com/docs/get-started/) и [Pulumi vs Terraform](https://www.pulumi.com/docs/intro/vs/terraform/)
- [Hetzner Cloud provider для Pulumi](https://www.pulumi.com/registry/packages/hcloud/) — ресурсы и примеры
- [Molecule](https://molecule.readthedocs.io/) — тестирование Ansible-ролей
