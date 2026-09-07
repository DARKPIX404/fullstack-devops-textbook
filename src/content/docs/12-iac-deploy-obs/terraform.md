---
title: "Terraform в деталях: state, модули, workspaces"
description: "Как HCL превращается в граф ресурсов, зачем нужен state с блокировкой, чем модуль отличается от workspace, drift-detection в CI и импорт существующей инфраструктуры."
---

В краткой версии ты уже поднял сервер Hetzner декларативным конфигом и понял главное: Terraform не «выполняет скрипт», а сравнивает желаемое состояние с реальным и строит план. Теперь посмотрим, что происходит под капотом этой магии — потому что именно недопонимание внутреннего устройства state приводит к самым болезненным инцидентам: дублирующимся серверам, потерянным DNS-записям и «apply, который всё сломал». В продакшене Terraform — это не утилита, а система с источником истины, конкурентным доступом и жизненным циклом, который ты обязан контролировать.

Мы пройдём путь от атомов языка HCL до полной инфраструктуры pet-проекта: блоки, выражения, ресурсы и data-источники, локалы и выводы. Разберём state — где Terraform хранит карту «код ↔ облако» и почему local-файл `terraform.tfstate` годится только для экспериментов. Настроим remote backend с блокировкой, разложим по полочкам `init/plan/apply/destroy`, научимся модулям, workspaces, dynamic blocks и `count`/`for_each`. Завершим двумя практиками выживания: drift-detection в CI и импортом уже существующей инфраструктуры.

## HCL: анатомия блока

HCL (HashiCorp Configuration Language) — декларативный язык конфигурации (исчерпывающий разбор синтаксиса — в [документации языка Terraform](https://developer.hashicorp.com/terraform/language)). Он не исполняется сверху вниз: Terraform сначала парсит все файлы `.tf` в директории, строит **граф зависимостей** и только потом решает порядок операций. Каждый блок имеет вид:

```hcl
# <тип блока> "<лейбл 1>" "<лейбл 2>" { тело }
resource "hcloud_server" "pet" {
  name = "pet-prod"          # аргумент: имя = выражение
}
```

Выражения — это не только строки. Ссылки на другие ресурсы (`hcloud_server.pet.ipv4_address`), условия (`var.env == "prod" ? "cx22" : "cx11"`), коллекции и функции (`merge`, `lookup`, `cidrsubnet`, `templatefile`). Именование ресурса — его адрес внутри кода и state: переименование ресурса `pet` в `main` Terraform воспримет как «старый удалить, новый создать», то есть **пересоздаст сервер**. Переименование — всегда осознанное действие с `terraform state mv` или `moved`-блоком.

```hcl
# moved — явное переименование без пересоздания (Terraform 1.1+)
moved {
  from = hcloud_server.pet
  to   = hcloud_server.main
}
```

:::tip[Файловая структура проекта]
Terraform читает все `.tf`-файлы директории как один. Принятое соглашение: `main.tf` (ресурсы), `variables.tf` (входные переменные), `outputs.tf` (выводы), `versions.tf` (constraints версий провайдера и Terraform), `backend.tf` (конфигурация state), `terraform.tfvars` (значения переменных — в `.gitignore`, если содержат секреты).
:::

## Провайдеры: Hetzner, DigitalOcean, AWS

Провайдер — плагин, который знает API конкретного облака. Объявляется в блоке `terraform`, а его экземпляр — в блоке `provider`. Пример на трёх провайдерах одновременно:

```hcl
# versions.tf
terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"        # ~> = «от 1.45.0 до 2.0.0»
    }
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token       # TF_VAR_hcloud_token из окружения
}

provider "digitalocean" {
  token = var.do_token
}

provider "aws" {
  region = "eu-central-1"
  # доступ — через env AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
}
```

Разные провайдеры — одинаковая модель: `resource "<тип>" "<имя>"`. Сравни создание сервера в трёх облаках:

```hcl
# Hetzner: сервер + его приватная сеть
resource "hcloud_server" "pet" {
  name        = "pet-prod"
  server_type = "cx22"          # 2 vCPU / 4 GB
  image       = "ubuntu-24.04"
  location    = "fsn1"
  ssh_keys    = [hcloud_ssh_key.admin.id]
}

# DigitalOcean: droplet с user_data (cloud-init)
resource "digitalocean_droplet" "pet" {
  name   = "pet-prod"
  size   = "s-2vcpu-4gb"
  image  = "ubuntu-24-04-x64"
  region = "fra1"
  ssh_keys = [digitalocean_ssh_key.admin.id]

  user_data = file("${path.module}/cloud-init.yml")
}

# AWS: EC2 в конкретной подсети и security group
resource "aws_instance" "pet" {
  ami           = data.aws_ami.ubuntu.id      # data-источник ниже
  instance_type = "t3.medium"
  subnet_id     = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.pet.id]

  tags = { Name = "pet-prod", Env = "prod" }
}
```

Версии провайдеров фиксируй всегда: мажорное обновление провайдера может изменить поведение ресурсов, и `terraform init -upgrade` без ревью чейнджлога — классический источник инцидентов.

## Ресурсы, data-источники, локалы, выводы

Четыре кирпича любой конфигурации:

- **`resource`** — создаёт/изменяет/удаляет объект в облаке. Имеет жизненный цикл.
- **`data`** — только читает существующий объект (чужой VPC, AMI-образ, зона DNS) без управления им.
- **`locals`** — вычисляемые внутри модуля значения, чтобы не дублировать выражения.
- **`output`** — значения, которые Terraform печатает после apply и отдаёт другим системам.

```hcl
# Data-источник: найти официальный AMI Ubuntu 24.04 в AWS
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]              # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*"]
  }
}

locals {
  name_prefix = "${var.project}-${var.env}"   # pet-prod
  common_tags = { Project = var.project, Env = var.env }
}

resource "hcloud_server" "pet" {
  name = "${local.name_prefix}-api"
  labels = local.common_tags
}

# Вывод — интерфейс модуля наружу
output "server_ip" {
  value       = hcloud_server.pet.ipv4_address
  description = "Публичный IP для Ansible-inventory"
}
```

:::caution[Data-источник не защищает от удаления]
Data-источник читает объект на момент plan. Если объект удалили между plan и apply — apply упадёт. Ресурс, на который ссылается код, должен жить в том же state, иначе ты получаешь скрытую внешнюю зависимость.
:::

## State: источник истины и его защита

State — JSON-карта, где Terraform хранит соответствие: `hcloud_server.pet` ↔ реальный ID сервера `1234567`, его IP, приватные ключи, пароли (модель state детально разобрана в [официальной документации](https://developer.hashicorp.com/terraform/language/state)). Без state Terraform **не может управлять существующими ресурсами** — он их просто не помнит. В state лежат секреты в открытом виде (пароли БД, приватные ключи), поэтому правило железное: **state не в git, не в мессенджерах, не на десктопе.**

Local state (`terraform.tfstate` рядом с кодом) — только для локальных экспериментов. Как только в команде больше одного человека или запуск идёт из CI, нужен remote backend. Канонический вариант — S3-совместимый бакет с блокировкой:

```hcl
# backend.tf
terraform {
  backend "s3" {
    bucket       = "darkpix-tfstate"
    key          = "pet/terraform.tfstate"     # путь внутри бакета
    region       = "eu-central-1"
    encrypt      = true                       # шифрование на стороне бакета

    # DynamoDB больше не нужен: use_lockfile использует S3-объект-лок
    use_lockfile = true                       # блокировка одновременных apply
  }
}
```

Блокировка решает гонку: два `terraform apply` из разных мест одновременно испортили бы state. С `use_lockfile = true` второй процесс получает ошибку «Error acquiring the state lock» и ждёт, пока первый не отпустит. Для Hetzner есть нативный бэкенд `hcloud`, у DigitalOcean — `spaces`-совместимый S3, у Terraform Cloud/Enterprise — бесплатный remote state с UI-просмотром и run-логами.

Доступ к бакету — только у CI и админов через отдельные IAM-ключи с минимальными правилами (`s3:GetObject/PutObject` на один префикс). Сам бакет: версионирование включено (откат state после плохого apply), публичный доступ запрещён, шифрование обязательно.

:::caution[Сломанный state — recoverable, потерянный — нет]
Если state испорчен (конфликт версий), помогает версионирование бакета. Если state **потерян** — Terraform перестаёт знать о существующих ресурсах, и следующий apply создаст дубликаты. Единственный выход — `terraform import` каждого ресурса вручную. Делай регулярный `state pull > backup-$(date +%F).tfstate` перед масштабными изменениями.
:::

## Workflow: init → plan → apply → destroy

Четыре команды, из которых состоит жизнь:

```bash
terraform init          # скачать провайдеры, настроить backend, модули
terraform plan          # дифф: что создать/изменить/уничтожить — читаем ВСЕГДА
terraform apply         # применить план (по умолчанию переспрашивает)
terraform apply -auto-approve     # только из CI после review плана
terraform destroy       # удалить всё, что описано (dev-окружения только!)
```

`init` — идемпотентен, безопасно запускать каждый раз в CI. `plan` не меняет ничего — это твоё окно ревью: смотри на `+ create`, `~ update in-place`, `-/+ replace` (пересоздание = даунтайм) и `Plan: 3 to add, 1 to change, 0 to destroy`. Сохраняй план в артефакт для apply: `terraform plan -out=tfplan && terraform apply tfplan` — гарантирует, что применится ровно то, что ревьюили, а не свежий дифф.

:::tip[Destroy — тоже тест]
Прогоняй `terraform destroy && terraform apply` на staging минимум раз в квартал. Он ловит ресурсы, которые создаются, но не удаляются (зависимости, неочевидные циклы), и доказывает, что инфраструктура действительно воспроизводима с нуля.
:::

## Модули и версионирование

[Модуль](https://developer.hashicorp.com/terraform/language/modules) — директория с `.tf`-файлами, принимающая входные переменные и отдающая outputs. Корневая директория — тоже модуль (корневой). Правило: **модуль не знает про окружение** — env, размеры и токены передаются извне.

```text
infra/
├── main.tf               # собирает модули под конкретное окружение
├── variables.tf
├── outputs.tf
└── modules/
    └── server/
        ├── main.tf
        ├── variables.tf
        └── outputs.tf
```

```hcl
# modules/server/variables.tf
variable "name"        { type = string }
variable "server_type" { type = string }
variable "ssh_key_ids" { type = list(string) }
variable "enable_backups" { type = bool, default = false }

# modules/server/main.tf
resource "hcloud_server" "this" {
  name        = var.name
  server_type = var.server_type
  image       = "ubuntu-24.04"
  ssh_keys    = var.ssh_key_ids
  backups     = var.enable_backups
}

# modules/server/outputs.tf
output "ipv4"    { value = hcloud_server.this.ipv4_address }
output "server_id" { value = hcloud_server.this.id }

# main.tf — корневой модуль
module "pet_server" {
  source      = "./modules/server"
  name        = "pet-prod"
  server_type = var.env == "prod" ? "cx22" : "cx11"
  ssh_key_ids = [hcloud_ssh_key.admin.id]
  enable_backups = var.env == "prod"
}

output "pet_ip" {
  value = module.pet_server.ipv4
}
```

Для переиспользования между репозиториями модуль публикуется в git и подключается с версией — тегом:

```hcl
module "vpc" {
  source  = "git::https://github.com/darkpix/tf-modules.git//modules/network?ref=v1.2.0"
  # ?ref=v1.2.0 — НЕ main! Без ref Terraform кэширует main намертво
  cidr = "10.0.0.0/16"
}
```

Версионирование модуля позволяет обновлять потребителей по одному: сначала staging на `v1.3.0`, потом prod. Менять интерфейс модуля (переименование переменных, удаление outputs) — только с новой мажорной версией.

## Workspaces: изоляция окружений

Workspace — изолированный state поверх одного кода. Физически это отдельные файлы state в бакете (`env:/staging/pet/terraform.tfstate`).

```bash
terraform workspace new staging
terraform workspace new prod
terraform workspace select staging
terraform workspace list        # * — текущий
terraform apply                 # пишет в state staging
```

Окружения отличаются значениями переменных, которые принято держать в файлах `staging.tfvars` / `prod.tfvars`. Опасность workspaces: один код, но разное поведение от переменных. Для pet-проекта двух workspace хватает с головой; при росте команды переходят на директории `envs/staging`, `envs/prod` (явнее, проще review в PR).

```hcl
# prod.tfvars
env         = "prod"
server_type = "cx22"
```

## dynamic blocks, count, for_each

Три механизма, убирающие копипасту:

**`count`** — N копий ресурса по индексу (список):

```hcl
resource "hcloud_server" "api" {
  count       = var.api_replicas          # 2
  name        = "pet-api-${count.index}"  # pet-api-0, pet-api-1
  server_type = "cx11"
  image       = "ubuntu-24.04"
}
output "api_ips" { value = hcloud_server.api[*].ipv4_address }
```

**`for_each`** — ресурс на элемент коллекции (предпочтительнее count: удаление из середины списка не сдвигает индексы и не пересоздаёт хвост):

```hcl
resource "hcloud_firewall" "rules" {
  for_each = toset(["80", "443", "22"])
  name     = "allow-${each.key}"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = each.value
    source_ips = ["0.0.0.0/0"]
  }
}
```

**`dynamic`** — генерирует повторяющиеся вложенные блоки из коллекции (внутри ресурса, где for_each недоступен; [документация](https://developer.hashicorp.com/terraform/language/expressions/dynamic-blocks)):

```hcl
resource "aws_security_group" "pet" {
  name = "pet-sg"
  description = "Правила из переменной"

  dynamic "ingress" {
    for_each = var.allowed_ports          # [80, 443, 22]
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }
}
```

## Drift detection в CI и импорт инфраструктуры

Реальность расходится с кодом: кто-то открыл порт в консоли облака, изменил тип сервера «на пять минут». Лечение — регулярный `plan` по расписанию:

```yaml
# .github/workflows/drift.yml
name: drift
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch:
jobs:
  plan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init -input=false
        env: { TF_VAR_hcloud_token: ${{ secrets.HCLOUD_TOKEN }} }
      - run: terraform plan -detailed-exitcode -no-color
        env: { TF_VAR_hcloud_token: ${{ secrets.HCLOUD_TOKEN }} }
```

`-detailed-exitcode` возвращает `0` (нет изменений), `1` (ошибка) или `2` (есть дрейф) — job падает, и ты получаешь уведомление «код ≠ реальность». Для prod-apply — отдельный workflow с ручным запуском и обязательным ревью плана в PR.

Обратная задача — инфраструктура существует, а кода нет (legacy, ручное создание). Terraform умеет «усыновлять» ресурсы:

```bash
# 1. Описываем ресурс пустым блоком
# main.tf
resource "hcloud_server" "legacy" {
  name        = "old-prod"
  server_type = "cx11"
  image       = "ubuntu-24.04"
  location    = "fsn1"
  # не запускай apply до import! Будет создан дубликат
}

# 2. Узнаём ID у провайдера (веб-консоль или API)
# 3. Импортируем в state — код остаётся девственно чистым
terraform import hcloud_server.legacy 1234567

# 4. Теперь сравниваем: terraform plan покажет дифф кода и реальности.
# Подгоняем код до "No changes" — инфраструктура теперь под управлением.
```

Импорт — не «одна кнопка»: Terraform не знает, какие атрибуты ресурса задавались при создании, поэтому план после import почти всегда предлагает что-то поменять. Итеративно выравнивай код, пока не получишь пустой plan.

## Полный пример: сервер + DNS-запись + вывод IP

Собираем всё вместе — воспроизводимый кусок pet-проекта:

```hcl
# versions.tf
terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.45" }
  }
}

# main.tf
resource "hcloud_ssh_key" "admin" {
  name       = "darkpix-admin"
  public_key = file("~/.ssh/id_ed25519.pub")
}

resource "hcloud_server" "pet" {
  name        = "pet-prod"
  server_type = "cx22"
  image       = "ubuntu-24.04"
  location    = "fsn1"
  ssh_keys    = [hcloud_ssh_key.admin.id]

  # cloud-init: первая настройка при создании — базовая гигиена
  user_data = <<-EOF
    #cloud-config
    package_update: true
    packages: [fail2ban, ufw]
    runcmd:
      - ufw allow OpenSSH
      - ufw --force enable
  EOF
}

# DNS-запись через того же провайдера (Hetzner DNS)
resource "hcloud_dns_record" "pet" {
  zone_id = data.hcloud_dns_zone.main.id
  name    = "pet"
  value   = hcloud_server.pet.ipv4_address
  type    = "A"
  ttl     = 300
}

data "hcloud_dns_zone" "main" {
  name = "darkpix.dev"
}

# outputs.tf
output "server_ip" {
  value       = hcloud_server.pet.ipv4_address
  description = "IP для Ansible-inventory"
}

output "fqdn" {
  value = "${hcloud_dns_record.pet.name}.darkpix.dev"
}
```

```bash
export TF_VAR_hcloud_token="твой-токен"
terraform init
terraform plan -out=tfplan          # ревьюим: 3 to add, 0 to change, 0 to destroy
terraform apply tfplan
# Apply complete! Outputs:
# server_ip = "116.203.10.20"
# fqdn      = "pet.darkpix.dev"

# IP уходит в inventory, Ansible продолжает настройку — см. следующую главу
```

## Типичные ошибки и грабли

1. **State в git.** `terraform.tfstate` попадает в репозиторий вместе с приватными ключами и паролями БД в открытом виде. Плохо: `git add .` без `.gitignore`. Хорошо: remote backend с шифрованием с первого дня, `.gitignore` с `*.tfstate*`, `crash.log`, `.terraform/`.
2. **Ручная правка в консоли облака.** Открыл порт в веб-интерфейсе «на минуту» — через неделю `apply` его удалит, и всё сломается. Плохо: чинить в консоли. Хорошо: правка в коде → PR → apply; консоль — только read-only диагностика.
3. **`apply` без чтения плана в prod.** В плане было `-/+ hcloud_server.pet (tainted/переименован)` — то есть пересоздание сервера с даунтайном, а ты нажал enter. Хорошо: `plan -out=tfplan`, ревью, `apply tfplan`; в prod — обязательный approve второго человека.
4. **`count` вместо `for_each` для разнородных ресурсов.** Удалил второй элемент из середины списка — Terraform пересоздал все ресурсы с бо́льшими индексами. Хорошо: `for_each = toset(...)` или `for_each = { for s in var.servers : s.name => s }` — адресация по ключу стабильна.
5. **Модуль без версии из git.** `source = "git::...?ref=main"` — все окружения живут на плавающей main, обновление модуля ломает prod при следующем apply. Хорошо: `?ref=v1.2.0` и обновление по одному окружению.
6. **Переименование ресурса руками в коде.** Terraform видит «удалить старый, создать новый» — сносит боевой сервер. Хорошо: блок `moved` или `terraform state mv` до правки кода.
7. **`terraform destroy` в shared workspace.** Выполнил destroy, не заметив, что сидишь в `prod`, а не в `staging`. Хорошо: явные префиксы имен в tfvars per workspace, защита `lifecycle { prevent_destroy = true }` на критичных ресурсах.

## Вопросы на собеседовании

1. **Зачем Terraform нужен state? Почему нельзя каждый раз смотреть в облако?** State — кэш соответствия ресурсов кода реальным ID облака и единственный источник истины о том, что «принадлежит» конфигурации. Опрос облака (refresh) не покажет, какой ресурс какому блоку принадлежит, особенно после ручных правок; state хранит и метаданные (зависимости, провайдеры), без которых план невозможен. Плюс в state лежат атрибуты, которые API не возвращает обратно.
2. **Что произойдёт, если потерять state?** Terraform «забудет» всю инфраструктуру: следующий apply создаст дубликаты ресурсов, старые останутся сиротами и продолжат списывать деньги. Восстановление — только через `terraform import` каждого ресурса по ID. Поэтому remote backend с версионированием и блокировкой — обязателен.
3. **Чем модуль отличается от workspace?** Модуль — переиспользуемый кускок кода с входами/выходами. Workspace — изоляция state одного и того же кода под разные окружения. Дублировать код под окружения (антипаттерн) — не то же, что workspace; а выносить в модуль — не то же, что разделять окружения.
4. **Как работает блокировка state в S3?** `use_lockfile = true` создаёт в бакете объект-лок (`<key>.tflock`): первый процесс его создаёт, второй при попытке acquire получает ошибку и ждёт. Гарантирует, что plan/apply не перемешают записи двух операторов. Блокировка снимается автоматически после завершения операции; при аварийном завершении лок живёт до TTL и снимается `force-unlock`.
5. **`count` vs `for_each`: когда что?** `count` — для N одинаковых ресурсов, где порядок не важен и удаление только с конца. `for_each` — когда ресурсы разнородны или адресация должна быть стабильной по ключу; удаление элемента из середины не трогает остальные. Для почти всего предпочтительнее `for_each`.
6. **Что такое drift и как с ним бороться?** Drift — расхождение реальной инфраструктуры и кода (ручные правки, изменения вне Terraform). Борьба: ничего не менять в консоли, регулярный `terraform plan -detailed-exitcode` в CI по расписанию, алерт при exit code 2, лечение — коммитом с правкой кода, а не повторной ручной правкой.
7. **Как безопасно переименовать ресурс?** Через блок `moved { from, to }` (Terraform обновит state без пересоздания) или `terraform state mv <old> <new>` до правки кода. Без этого Terraform планирует destroy+create — для stateful-ресурсов это потеря данных.
8. **Как устроен `terraform apply` под капотом?** Парсинг конфигурации → refresh (чтение реального состояния ресурсов) → построение графа зависимостей (по ссылкам и `depends_on`) → план (create/update/delete/replace) → apply в топологическом порядке с параллельностью по ветвям графа → обновление state. Поэтому порядок блоков в файлах не важен — важны ссылки.

## Практика

1. Вынеси конфигурацию pet-сервера из этой главы в модуль `modules/server` с входами `name`, `server_type`, `ssh_key_ids`, `enable_backups` и выводом `ipv4`. Корневой код собирает два вызова модуля: `staging` (cx11, без бэкапов) и `prod` (cx22, с бэкапами).
2. Настрой remote backend: S3-совместимый бакет с `encrypt = true`, `use_lockfile = true` и включённым версионированием. Докажи блокировку: запусти два `terraform apply` одновременно из разных терминалов — второй должен получить ошибку state lock.
3. Напиши workflow drift-detection из примера, добавь план как артефакт и проверь: открой порт в веб-консоли Hetzner → job упал на plan → верни всё кодом → job зелёный.
4. Реализуй DNS-запись через Hetzner DNS API (`hcloud_dns_record`) с `ttl = 60`, а IP сервера — через `output`. После apply проверь резолвинг: `dig +short pet.darkpix.dev` возвращает выведенный IP.
5. Найди в облаке один существующий ресурс (или создай вручную через консоль), опиши его пустым блоком, выполни `terraform import` и доведи код до пустого плана. Зафиксируй, какие атрибуты пришлось «угадать».
6. Смоделируй disaster recovery: скопируй state из бакета в сторону, выполни `terraform destroy` на staging, верни state на место и прогони `plan` — убедись, что Terraform снова видит ресурсы без пересоздания.

## Что почитать

- [Terraform Language documentation](https://developer.hashicorp.com/terraform/language) — ресурсы, переменные, выражения
- [State: purpose, backends, locking](https://developer.hashicorp.com/terraform/language/state) — официальное объяснение модели state
- [Module composition](https://developer.hashicorp.com/terraform/language/modules/develop/composition) — как проектировать интерфейсы модулей
- [Import: existing resources](https://developer.hashicorp.com/terraform/cli/import) и [moved blocks](https://developer.hashicorp.com/terraform/language/modules/develop/refactoring)
- [Hetzner Cloud provider](https://registry.terraform.io/providers/hetznercloud/hcloud/latest/docs) — примеры ресурсов и data-источников
- [Terraform in CI/CD best practices](https://developer.hashicorp.com/terraform/cloud-docs/recommended-practices) — ревью планов, drift, безопасность
