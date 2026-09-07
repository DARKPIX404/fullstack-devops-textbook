---
title: "Удалённые репозитории и PR"
description: "Устройство распределённого Git: что скачивает clone, чем fetch отличается от pull, почему отказывает push, как устроены tracking-ветки, форк-воркфлоу, цикл code review и релизы через теги."
---

До этого момента весь Git жил у тебя на диске: объекты, ветки, индекс — всё локально. Но Git задумывался как **распределённая** система: у каждого разработчика — полная копия истории, а синхронизация — явные команды, которые ты контролируешь. Понимание того, что именно летает по сети и что лежит в `.git` после каждой операции, отличает человека, который «пользуется GitHub», от человека, который понимает Git.

В краткой версии ты делал `clone`, `pull`, `push` по памяти. Здесь разберём под капотом: remote-tracking ветки, разницу `fetch` и `pull` на уровне объектов, отказ `non-fast-forward`, форк-воркфлоу, цикл code review и то, как виды мержа меняют историю. Это глава, после которой `git push --force` перестаёт быть магией и становится предсказуемой механикой.

## Что скачивает clone

`git clone` (см. [git-clone(1)](https://git-scm.com/docs/git-clone)) — это не «скачать файлы». Это **полная копия репозитория**: все объекты (блобы, деревья, коммиты, теги), все ветки, вся история с самого первого коммита.

```bash
git clone git@github.com:octo/example.git
cd example
```

Что появляется на диске:

```text
СЕРВЕР (origin)                      ТВОЙ ДИСК
.                                    example/
├── objects/  ← все коммиты,        └── .git/
│   деревья, блобы                    ├── objects/      ← ПОЛНАЯ КОПИЯ
├── refs/heads/  ← ветки              ├── refs/heads/   ← твои ветки
│   main, feature-x                   │   main
└── refs/tags/                        ├── refs/remotes/ ← ОСОБАЯ ЗОНА
                                      │   origin/main   ← remote-tracking!
                                      │   origin/feature-x
                                      └── refs/tags/    ← все теги
```

Два важных следствия:

1. **После clone можно работать офлайн.** Все коммиты за последние годы лежат у тебя. `git log`, `git diff`, даже `git rebase` — всё работает без сети.
2. **`origin/main` и `main` — разные ветки.** `main` — твоя локальная ветка, которую ты можешь двигать. `origin/main` — это **снимок** того, где была ветка `main` на сервере в момент последней синхронизации. Git хранит его в отдельном namespace `refs/remotes/`, и ты не можешь «закоммитить в origin/main» напрямую — только обновить через `fetch`/`push`.

:::note[Что НЕ скачивает clone]
А вот незащищённым тайнами clone не является: `git config`, хуки из `.git/hooks`, стэши (`refs/stash`) и ignored-файлы (`node_modules`, локальные `.env`) — всё это локально для каждого клона и по сети не ходит. А вот если нужен минимальный clone без истории — есть shallow clone: `git clone --depth 1` скачает только последний коммит (полезно для CI-агентов, где история не нужна), а `git fetch --unshallow` потом доскачёт остальное.
:::

```text
refs/heads/main         → твоя ветка (куда указывает твой HEAD при checkout main)
refs/remotes/origin/main → «зеркало» серверной ветки (обновляется только синхронизацией)
```

Кстати, почему репозиторий называется `origin`? Просто дефолтное имя: Git присваивает удалённому репозиторию, из которого клонировали, имя `origin`. Это просто ярлык на URL:

```bash
git remote -v
# origin  git@github.com:octo/example.git (fetch)
# origin  git@github.com:octo/example.git (push)
```

В конфиге это обычная запись в `.git/config`:

```bash
git config --get remote.origin.url
# git@github.com:octo/example.git
```

## Несколько remote

Один репозиторий может знать о многих удалённых. Классика — добавить «апстрим», когда твой форк отстал от оригинала:

```bash
# ты склонировал свой форк
git clone git@github.com:you/project.git
cd project

# добавляем оригинальный репозиторий под именем upstream
git remote add upstream git@github.com:octo/project.git
git fetch upstream

# теперь доступны чужие ветки
git log upstream/main --oneline -5
```

```text
                ┌─────────────────────────────┐
                │  github.com/octo/project    │  ← upstream (оригинал)
                │  main: C1─C2─C3─C4          │
                └──────────────┬──────────────┘
                               │ fetch
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
 refs/remotes/          refs/remotes/          твои ветки
 upstream/main   ≠     origin/main      ≠     main
 (оригинал)            (твой форк)            (твоя работа)
```

Имена — произвольные ярлыки. Можно назвать `upstream`, `fork`, `backup`. Git не делает различий, различаешь ты.

Один тонкий момент: fetch- и push-URL у remote могут **различаться**. Классика — читать по HTTPS (работает за строгим прокси), пушить по SSH:

```bash
git remote set-url origin https://github.com/octo/project.git          # fetch
git remote set-url --push origin git@github.com:octo/project.git       # push
git remote -v   # (push) и (fetch) теперь разные
```

Ещё полезный трюк — push в несколько remote одной командой: `git remote set-url --add --push origin git@gitlab.com:you/project.git` теперь `git push` отправляет и на GitHub, и на GitLab (зеркалирование для надёжности).

## fetch vs pull: ключевая разница

Это вопрос, который спрашивают на каждом втором собеседовании. Разберём на уровне объектов.

**`git fetch`** (см. [git-fetch(1)](https://git-scm.com/docs/git-fetch)) скачивает из remote всё новое (объекты, ветки, теги) и **обновляет только remote-tracking ветки**. Твои локальные ветки, рабочая директория и индекс не трогаются:

```bash
git fetch origin
# теперь origin/main показывает актуальное состояние сервера,
# а твоя main — где была до fetch
```

```text
ДО fetch:                          ПОСЛЕ fetch:

origin/main:  C1─C2─C3             origin/main:  C1─C2─C3─C4─C5   ← обновилась
main:         C1─C2─C3             main:         C1─C2─C3          ← НЕ тронута
рабочая папка: совпадает с main    рабочая папка: НЕ изменилась
```

**`git pull`** (см. [git-pull(1)](https://git-scm.com/docs/git-pull)) = `git fetch` + слияние (или ребейз) изменений из апстрим-ветки в твою текущую ветку:

```bash
git pull origin main
# эквивалентно:
git fetch origin
git merge origin/main      # либо git rebase origin/main при pull --rebase
```

```text
git pull (= fetch + merge):

до:                               после:
main:      C1─C2─C3               main:      C1─C2─C3─────┐
origin/main: C1─C2─C3─C4─C5       origin/main: C1─C2─C3─C4─C5
                                             \__________/
                                             merge-коммит M
```

:::tip[Почему я предпочитаю ручной fetch]
`git fetch` — единственная сетевая операция, которая **не может ничего сломать**: она только добавляет объекты и двигает «зеркала». Посмотрел `git log main..origin/main` (что нового на сервере), оценил риски — и уже сознательно делаешь `merge` или `rebase`. `git pull` всё это делает вслепую одной командой.
:::

Полезные диагностические команды после fetch:

```bash
# что нового появилось на сервере (коммиты, которых нет у тебя)
git log main..origin/main --oneline

# что есть у тебя, но ещё не на сервере
git log origin/main..main --oneline

# какие ветки на сервере удалены (при --prune)
git fetch --prune origin
```

Запомни синтаксис `ветка..ветка`: он работает везде в Git, где есть диапазоны коммитов, и читается как «коммиты, до которых можно дойти из правой ветки, но не из левой». Двойные точки — «только справа», тройные (`A...B`) — «симметричная разница» (есть в любой, но не в обеих).

## push и отказ non-fast-forward

`git push` (см. [git-push(1)](https://git-scm.com/docs/git-push)) — зеркальная операция fetch: отправляет объекты и просит сервер передвинуть ветку. Но сервер защищён от потери истории.

**Fast-forward** — это когда твоя ветка строго продолжает серверную: сервер просто двигает указатель вперёд, ничего не теряя.

```text
ТЫ push-ишь: всё ОК (fast-forward)

origin/main:  C1─C2─C3
твоя main:    C1─C2─C3─C4─C5     ← новые коммиты ДОБАВЛЯЮТСЯ к истории

после push:   C1─C2─C3─C4─C5     ← сервер просто передвинул указатель
```

**Non-fast-forward** — серверная ветка ушла вперёд (кто-то запушил), а твоя история разошлась:

```text
ТЫ push-ишь: ОТКАЗ non-fast-forward

origin/main:  C1─C2─C3───C6───C7     ← кто-то успел запушить
твоя main:    C1─C2─C3─C4─C5         ← твои коммиты из ДРУГОЙ ветки истории
                         \      \
                          \______ разошлись — перезапись потеряла бы C6, C7

Git отказывает: push был бы ПЕРЕЗАПИСЬЮ, а сервер терять чужие коммиты не будет.
```

Правильный порядок действий:

```bash
git pull --rebase origin main   # либо merge — твои коммиты становятся поверх C7
git push origin main            # теперь это fast-forward
```

```text
после pull --rebase:              после push:

C1─C2─C3─C6─C7                    C1─C2─C3─C6─C7─C4'─C5'
          \                              ↑ origin/main и main совпали
           C4─C5 → ребейз на C7 → C4'─C5'
```

`--force` (точнее `--force-with-lease`) нужен только когда ты **сознательно переписываешь** опубликованную историю — например, после интерактивного ребейза своей ветки в PR. Подробнее — в главе про merge и rebase.

## Upstream и tracking-ветки

Когда ты создаёшь ветку и пушишь её первый раз, Git связывает локальную и удалённую ветку:

```bash
git switch -c feature-login
git push -u origin feature-login
# -u (--set-upstream): установить отслеживание
```

Теперь `feature-login` **отслеживает** `origin/feature-login`, и Git знает «против чего» сравнивать:

```bash
git status
# On branch feature-login
# Your branch is ahead of 'origin/feature-login' by 2 commits.
#   (use "git push" to publish your local commits)

git pull   # без аргументов — знает, откуда тянуть
git push   # без аргументов — знает, куда пушить
```

Что хранится под капотом — в конфиге ветки:

```bash
git config --get branch.feature-login.remote   # origin
git config --get branch.feature-login.merge    # refs/heads/feature-login
```

```text
tracking-связка:

локальная ветка          удалённая ветка
feature-login    ←→    origin/feature-login
   │                        │
   └── push публикует ──────┘
   └── pull забирает отсюда ┘
```

Апстрим-ветка имеет короткий синтаксис `@{u}` («upstream текущей ветки»), который пригождается в алиасах и скриптах:

```bash
git log @{u}..            # что ты уже сделал, но ещё не запушил
git diff @{u}             # дифф против апстрима
git rev-parse @{u}        # хэш апстрим-коммита
```

## Форк-воркфлоу

В опенсорсе и многих компаниях ты не имеешь права пушить в основной репозиторий напрямую. Схема такая:

```text
1. FORK          2. CLONE        3. BRANCH        4. PUSH        5. PULL REQUEST
                   свою копию      фичу из main     в СВОЙ форк    в оригинал

octo/project ──► you/project ──► you/project ──► you/project ──► octo/project
(оригинал)       (форк на        (ветка            (ветка          (PR: предложение
                  GitHub)         feature-login)    на форке)       слить feature-login
                                                                  в octo/project:main)
```

```bash
# полный цикл руками
git clone git@github.com:you/project.git
cd project
git remote add upstream git@github.com:octo/project.git

git switch -c fix-typo-readme       # ветка от актуальной main
# ... правки ...
git commit -am "docs: fix typo"
git push -u origin fix-typo-readme  # в СВОЙ форк

# затем в браузере: Compare & Pull Request → описание → Create PR
```

Перед созданием PR полезно подтянуть свежий апстрим:

```bash
git fetch upstream
git rebase upstream/main   # твои коммиты — поверх свежей main
git push --force-with-lease origin fix-typo-readme
```

:::note[Почему ветки, а не коммиты прямо в main форка?]
PR привязан к ветке: пока он на ревью, ты можешь пушить правки в ту же ветку — PR обновится сам. А `main` форка остаётся чистой «копией оригинала», что сильно упрощает следующую фичу: `git switch -c next-feature main` после `git fetch upstream && git rebase upstream/main`.
:::

## Цикл code review и виды мержа

PR (подробно — [документация GitHub о пул-реквестах](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)) — не кнопка «слить», а **процесс**. Классический цикл:

```text
┌──────────┐   комментарии   ┌──────────┐
│ ревьюер  │ ───────────────►│ разраб   │
│          │                 │          │
└────┬─────┘                 └────┬─────┘
     │ approve                    │ правки + git push (PR обновляется)
     │                            │
     ▼                            │
┌─────────────────────────────────┴────┐
│ maintainer нажимает Merge            │
└──────────────────────────────────────┘
```

Каждый новый `push` в ветку PR автоматически подтягивается в интерфейс, старые комментарии помечаются «outdated», если код изменился. Поэтому правки делаются **новыми коммитами или amend + force-push** (в ветке PR переписывать историю допустимо — она твоя), но не новым PR.

Качество ревью напрямую зависит от размера диффа: PR на 50 строк ревьюер разбирает за пять минут и ловит реальные баги, PR на 2000 строк получает «LGTM» через страдание. Поэтому большую задачу режут на серию мелких PR за фича-флагами — каждый самодостаточен, тестируем и ревьюится за один заход.

При нажатии Merge у тебя обычно три варианта, и они дают **разную историю**:

| Вариант | История | Когда использовать |
|---|---|---|
| **Merge commit** | вся ветка целиком + merge-коммит | сохранить контекст ветки, дефолт в классическом Git |
| **Squash and merge** | все коммиты ветки схлопываются в один | «WIP», «fix», «oops» не должны попадать в main; PR = одна атомарная правка |
| **Rebase and merge** | коммиты ветки переписываются поверх main, без merge-коммита | линейная история, но сохраняем гранулярность коммитов |

```text
ИСХОДНАЯ ВЕТКА В PR (main = C1─C2):

C1─C2─C3─C4─A─B        A, B — коммиты фичи (3, 4 — промежуточные «WIP»)

Merge commit:            Squash and merge:        Rebase and merge:

C1─C2───────M            C1─C2───────S            C1─C2─A'─B'
     \     /                                A'=A переписан
      C3─C4                                 без merge-коммита
      A────B          S = один коммит
      (вся ветка      «feat: login form»
       сохранена)
```

После любого из вариантов ветку PR обычно удаляют — история фиксируется в main, а feature-ветки живут неделями, не годами.

## Теги и GitHub Releases

Теги — неизменяемые указатели на коммиты. Для релизов используют **аннотированные теги** (хранят автора, дату, сообщение):

```bash
git tag -a v1.4.0 -m "Release 1.4.0: dark theme, export to CSV"
git push origin v1.4.0        # теги пушатся отдельно!
git push origin --tags        # или все разом
```

```text
история main:   C1─C2─C3─C4─C5
                          ▲
                          └─ tag: v1.4.0 (аннотированный, не двигается)
```

По тегам принято ориентироваться в **семантическом версионировании** (`MAJOR.MINOR.PATCH`; спецификация — [semver.org](https://semver.org/lang/ru/)): ломающие изменения — новый MAJOR, фичи — MINOR, багфиксы — PATCH. Сам тег — неизменяемый: если обнаружил баг в `v1.4.0`, исправление выходит как `v1.4.1`, а тег не переставляется (переписывание опубликованных тегов ломает чужие сборки и блокировки зависимостей).

GitHub **Release** — это тег + страница с changelog, собранными артефактами и ссылками на скачивание:

```bash
# через gh CLI — удобно для релизного пайплайна
gh release create v1.4.0 \
  --title "v1.4.0 — Dark theme" \
  --notes-file CHANGELOG.md \
  dist/app.tar.gz
```

В продакшене тег обычно ставит CI после успешного деплоя: код ушёл на серверы → только тогда `v1.4.0` получает тег. Деплой «по тегу», а не «по main», даёт возможность откатиться: `git checkout v1.3.2` — и раскатываешь старую версию.

## Типичные ошибки и грабли

1. **Пушить в main вместо своей ветки.** После `git commit` на main быстрый `git push` отправляет прямо в защищённую ветку. Лечится дисциплиной «сначала `git switch -c`, потом код», либо branch protection на сервере.

2. **`git pull` по привычке вместо `fetch`.** Если под руками есть незакоммиченные правки, merge из pull может устроить конфликт в полусделанной работе. Сначала `fetch`, оцени `git log main..origin/main`, потом решай.

3. **`--force` вместо `--force-with-lease`.** Обычный форс не проверяет, что на сервере никто не успел запушить. `--force-with-lease` откажет, если серверная ветка сдвинулась с момента твоего последнего fetch — не даст случайно снести чужую работу.

4. **Забыть `-u` при первом push ветки.** Тогда `git push` в следующий раз ругнётся «no upstream». Исправление: `git push -u origin ветка` или `git branch --set-upstream-to=origin/ветка`.

5. **Коммитить секреты, полагаясь на «потом удалю».** Удаление коммита из истории — это rebase/force-push по всем, кто уже склонировал. Включая ботов, которые мгновенно сканируют свежие пуши. См. главу «Продвинутый Git» про gitleaks.

6. **Держать ветки неделями без синхронизации.** Чем дольше ветка живёт врозь от main, тем дороже ребейз/мерж и тем больше шанс конфликтов. Интегрируйся маленькими порциями — ребейз на свежую main каждые 1–2 дня.

## Вопросы на собеседовании

1. **Чем fetch отличается от pull?**
   `fetch` скачивает объекты и обновляет remote-tracking ветки, не трогая рабочую директорию и локальные ветки. `pull` = `fetch` + `merge` (или `rebase`) апстрим-ветки в текущую. Fetch безопасен всегда, pull меняет историю.

2. **Что такое remote-tracking ветка?**
   Локальный снимок состояния ветки на remote (`refs/remotes/origin/main`). Обновляется только при синхронизации; сравнение `main..origin/main` показывает, что пришло с сервера.

3. **Почему push иногда отказывает с non-fast-forward?**
   Серверная ветка ушла вперёд, твоя история разошлась. Пуш стал бы перезаписью и потерял бы чужие коммиты. Решение: `pull --rebase` и push заново, либо `--force-with-lease`, если перезапись сознательная.

4. **Для чего нужен форк?**
   Чтобы работать по fork-воркфлоу: у разработчика нет прав на запись в оригинал, поэтому он пушит в свой форк и предлагает изменения через PR. Плюс изоляция CI-квот и веток.

5. **Чем squash merge отличается от rebase merge и merge commit?**
   Squash схлопывает всю ветку в один коммит (чистая main, теряется гранулярность). Merge commit сохраняет всю топологию ветки. Rebase merge переносит коммиты поверх main линейно, без коммита слияния.

6. **Как правильно обновить PR после замечаний ревьюера?**
   Правки в ту же ветку и `git push` (или amend + `--force-with-lease`). PR обновляется автоматически. Новый PR создавать не нужно.

7. **Что пушится командой `git push` без аргументов?**
   Текущая ветка в её апстрим (`branch.X.remote/merge`). Если апстрим не настроен — ошибка; настроить: `git push -u origin ветка`.

## Практика

1. Создай тестовый репозиторий на GitHub (или локальный bare-репозиторий через `git init --bare`). Склонируй его, сделай 3 коммита в новой ветке и запушь с `-u`. Критерий: `git branch -vv` показывает tracking-связь.
2. Сэмулируй конфликт push: запушь ветку из одной копии репозитория, затем из второй копии сделай другой коммит и попробуй запушить. Критерий: ты видишь отказ non-fast-forward и исправляешь его через `pull --rebase` без потери коммитов.
3. Настрой два remote (`origin` и `upstream`) в одном репозитории. Сделай fetch из обоих и покажи разницу `git log origin/main..upstream/main`. Критерий: оба remote отображаются в `git remote -v`.
4. Создай PR в своём репозитории с тремя коммитами, из них один с сообщением «WIP». Проведи squash merge. Критерий: в main остался ровно один коммит с осмысленным сообщением.
5. Поставь аннотированный тег `v0.1.0` на текущий коммит и запушь его. Критерий: тег виден в `git ls-remote --tags origin` и на странице репозитория.

## Что почитать

- [Pro Git: Удалённые репозитории (глава 2.5)](https://git-scm.com/book/ru/v2/Основы-Git-Работа-с-удалёнными-репозиториями)
- [Pro Git: Ветвление в Git — удалённые ветки (глава 3.5)](https://git-scm.com/book/ru/v2/Ветвление-в-Git-Удалённые-ветки)
- [GitHub Docs: About pull requests](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests)
- [GitHub Docs: About merge methods](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github)
- [Semantic Versioning](https://semver.org/lang/ru/)
- [Atlassian: Comparing workflows](https://www.atlassian.com/git/tutorials/comparing-workflows)
