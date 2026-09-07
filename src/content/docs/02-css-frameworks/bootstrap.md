---
title: "Bootstrap 5 глубоко: сетка, утилиты, компоненты, кастомизация"
description: "Bootstrap изнутри: философия и история, сетка с контейнерами и breakpoints, конвенции именования утилит, компоненты на data-атрибутах, кастомизация через Sass-переменные и color modes. Когда Bootstrap уместен в 2026, а когда — красный флаг."
---

Bootstrap — самый изученный и самый высмеянный фреймворк в истории фронтенда. Его ставят в пример новичкам («начни с Bootstrap») и ругают на собеседованиях («не, мы такое не используем»). Обе реакции упрощают реальность: Bootstrap — это не «фреймворк для тех, кто не умеет в CSS», а попытка 2011 года решить системную проблему — отсутствие общей системы дизайна у веба, — решение, которое настолько удачно описало сетку, утилиты и компоненты, что его концепции до сих пор воспроизводят все остальные фреймворки.

Если ты поймёшь Bootstrap изнутри — сетку, конвенции именования, слои кастомизации — ты поймёшь архитектурную ДНК половины CSS-инструментов: Tailwind унаследовал его breakpoint-нотацию (`md:`, `lg:`), Bulma — сетку, Mantine и MUI — модель темизации через словари токенов. Эта глава — глубокий разбор: как устроена сетка и почему она устроена именно так, как работают утилиты и компоненты на data-атрибутах, как кастомизировать фреймворк, не ломая обновления, и где сегодня проходит граница «Bootstrap уместен / Bootstrap неуместен».

## Философия и история: почему стал стандартом

Bootstrap родился в Twitter в 2011 году как внутренний набор стилей (первое название — Twitter Blueprint). Разработчики были вынуждены верстать десятки внутренних страниц с одинаковыми кнопками, формами и таблицами — и собрали единый фреймворк, который потом отдали open source. Идея была революционной для 2011-го: вместо «каждый пишет свои стили с нуля» — «возьми готовую систему, где решены типографика, сетка, формы и кроссбраузерность».

Почему победил среди десятков конкурентов (Skeleton, Foundation, YAML, Blueprint):

1. **Согласованность.** Кнопки, формы, таблицы, алерты — всё в одном визуальном языке. Дизайнер не нужен, чтобы страница не выглядела «слепленной из кусков».
2. **Сетка с колонками.** Двенадцатиколоночная сетка с медиа-запросами — примерно за пять лет до CSS Grid — стала индустриальным стандартом.
3. **Mobile-first с версии 3.** Переход на «сначала мобильные стили, потом расширяем через медиа-запросы» задал паттерн, который потом унаследовали все.
4. **Документация как продукт.** Документация Bootstrap — образец: каждый компонент с примером, вариантами и кодом. Это снижало порог входа до нуля.

Цена известности: миллионы сайтов «на дефолтном Bootstrap» — одинаковые кнопки, одинаковая навигация. Слово «bootstrap-вый» стало синонимом «шаблонного». Но это не вина фреймворка — это вина использования «из коробки» без кастомизации.

## Сетка: контейнеры, row/col, breakpoints

Сетка Bootstrap — float-based изначально, с версии 4 — flexbox, с версии 5.3 — экспериментальный CSS Grid вариант. Классическая модель из трёх слоёв:

```html
<!-- Контейнер: центрирует контент и задаёт max-width под breakpoint -->
<div class="container">
  <!-- Row: обёртка-флекс-строка с отрицательными margin по бокам -->
  <div class="row">
    <!-- Колонки: flex-элементы с padding-gutter по бокам -->
    <div class="col-md-8">Основной контент</div>
    <div class="col-md-4">Сайдбар</div>
  </div>
</div>
```

### Контейнеры: fixed против fluid

| Класс | Поведение |
|---|---|
| `.container` | max-width меняется скачками по breakpoints: 540 → 720 → 960 → 1140 → 1320px |
| `.container-fluid` | width: 100% на всех размерах, padding 12px (gutter / 2) с каждой стороны |
| `.container-{bp}` | Адаптивный гибрид: 100% до breakpoint, потом фиксированный (`.container-md` = fluid на мобильных, fixed на ≥768px) |
| `.container-xxl` | Часто для «wide desktop» макетов |

Механика gutter: `.row` имеет `margin-inline: -12px`, колонки — `padding-inline: 12px`. Итог: контент колонок выровнен с краями контейнера, а между колонками — 24px ритм. Это классическая «gutter через padding» схема, которую повторяют все сетки.

### Колонки: десять правил из одной системы

- `.col` — равномерное деление: три `.col` в row = три колонки по 33.333%. Автоматический flex-basis: 0, flex-grow: 1.
- `.col-{1..12}` — точное число колонок из 12. `.col-md-6` = 50% на ≥768px.
- `.col-{bp}` — колонка появляется (перестаёт быть width: 100% и становится flex-элементом) на breakpoint и выше.
- Если сумма `.col-*` в row > 12 — лишние переносятся на новую строку (flex-wrap: wrap).

:::note[Почему двенадцать колонок]
Деление на 12 — компромисс делимости: 12 делится на 2, 3, 4, 6 — покрывает почти все раскладки без дробных колонок. Тринадцать и шестнадцать колонок встречались в других сетках, но двенадцать стало стандартом именно из-за делителей.
:::

### Таблица breakpoints

Bootstrap 5 mobile-first: базовые стили для «xs» (всё <576px), приставки — минимальная ширина, стили применяются **на breakpoint и выше**:

| Breakpoint | Класс | Min-width | Типичное устройство |
|---|---|---|---|
| X-Small | (без приставки) | <576px | Телефоны в портрете |
| Small | `sm` | ≥576px | Большие телефоны, маленькие планшеты |
| Medium | `md` | ≥768px | Планшеты |
| Large | `lg` | ≥992px | Ноутбуки |
| X-Large | `xl` | ≥1200px | Десктопы |
| XX-Large | `xxl` | ≥1400px | Широкие мониторы |

```html
<!-- Адаптивная карточка: 12 колонок на мобильном, 6 на планшете, 4 на десктопе -->
<div class="col-12 col-md-6 col-lg-4">Карточка</div>

<!-- Ещё компактнее: col-12 можно опустить — колонка и так на всю ширину -->
<div class="col-md-6 col-lg-4">Карточка</div>
```

### Offset, order и gutters

```html
<div class="row">
  <!-- offset-md-3: сдвиг на 3 колонки слева (margin-inline-start) -->
  <div class="col-md-6 offset-md-3">Центрированная колонка</div>
</div>

<div class="row">
  <!-- Порядок: order-1..5, order-first, order-last -->
  <div class="col order-last order-md-first">Сайдбар: снизу на мобильном, слева на десктопе</div>
  <div class="col">Контент первым на мобильном</div>
</div>

<!-- g-*, gx-*, gy-*: ручное управление gutter (0..5, rem-шкала) -->
<div class="row g-2">       <!-- 8px между колонками -->
  <div class="col">...</div>
  <div class="col">...</div>
</div>
```

Под капотом это обычный flexbox: `.row { display: flex; flex-wrap: wrap; margin-inline: calc(-.5 * var(--bs-gutter-x)); }`, `.col-md-6 { flex: 0 0 auto; width: 50%; padding-inline: calc(var(--bs-gutter-x) * .5); }`. Никакой магии — понимание этих трёх строк заменяет заучивание классов.

## Утилиты: конвенции именования

Bootstrap 5 содержит сотни утилит, и их соглашения — ещё одна часть наследия, которое пережило сам фреймворк. Пять групп, которые нужно знать наизусть:

```html
<!-- 1. Display: d-{value}, d-{bp}-{value} -->
<div class="d-none d-md-block d-lg-flex">Скрыто на мобильном, flex на lg+</div>

<!-- 2. Spacing: {property}{side}-{size}, с breakpoint-вариантом -->
<!-- m/mx/my/mt/mr/mb/ml/p/px/py/pt/pr/pb/pl, размеры 0..5 + auto (шкала × 0.25rem) -->
<div class="mt-2 mb-4 px-3 ms-auto">margin-top 8px, margin-bottom 24px, padding-inline 16px, margin-inline-start auto</div>

<!-- 3. Sizing: w-25/50/75/100/auto, h-*, mw-100, vh-100 -->
<img class="w-100 h-auto" src="..." alt="..." />

<!-- 4. Flex: контейнер justify-content-*, align-items-*, direction, wrap; элемент align-self-* -->
<div class="d-flex justify-content-between align-items-center gap-3">
  <span>Слева</span>
  <span class="ms-auto">Прижато вправо</span>
</div>

<!-- 5. Text: text-start/center/end, text-{bp}-*, text-uppercase, fw-bold, fs-1..6, lh-*, text-truncate -->
<h2 class="text-truncate fw-semibold">Длинный заголовок, обрежется многоточием</h2>
```

Две конвенции, перешедшие в Tailwind почти без изменений: breakpoint-приставка через дефис (`d-md-block`) и шкала spacing 0–5, где каждая единица = 0.25rem (4px). Tailwind раздул шкалу до 96, но ритм 4px — общий.

Оперативная справка по spacing-шкале: `1` = 0.25rem (4px), `2` = 0.5rem (8px), `3` = 1rem (16px), `4` = 1.5rem (24px), `5` = 3rem (48px), `auto` — только для margin.

## Компоненты: разметка и data-атрибуты

Компоненты Bootstrap — CSS + небольшой JS (Popper для позиционирования дропдаунов и тултипов). Управление поведением — через `data-bs-*` атрибуты, без написания JS.

### Кнопки и группы

```html
<!-- Варианты через контекстные классы: primary, secondary, success, danger, warning... -->
<button type="button" class="btn btn-primary">Сохранить</button>
<button type="button" class="btn btn-outline-danger btn-sm">Удалить</button>
<button type="button" class="btn btn-primary" disabled>Заблокировано</button>

<!-- Группа: склеенные кнопки с общей рамкой -->
<div class="btn-group" role="group" aria-label="Действия">
  <button class="btn btn-outline-primary">Назад</button>
  <button class="btn btn-outline-primary">Вперёд</button>
</div>
```

### Навигация

```html
<nav class="navbar navbar-expand-lg navbar-dark bg-dark">
  <div class="container">
    <a class="navbar-brand" href="#">Панель</a>
    <!-- data-bs-toggle="collapse" — JS-поведение без кода -->
    <button class="navbar-toggler" data-bs-toggle="collapse" data-bs-target="#menu"
            aria-controls="menu" aria-expanded="false" aria-label="Меню">
      <span class="navbar-toggler-icon"></span>
    </button>
    <div class="collapse navbar-collapse" id="menu">
      <ul class="navbar-nav ms-auto">
        <li class="nav-item"><a class="nav-link active" href="#">Дашборд</a></li>
        <li class="nav-item"><a class="nav-link" href="#">Отчёты</a></li>
        <li class="nav-item dropdown">
          <a class="nav-link dropdown-toggle" href="#" data-bs-toggle="dropdown">Ещё</a>
          <ul class="dropdown-menu">
            <li><a class="dropdown-item" href="#">Настройки</a></li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</nav>
```

Ключевые механики: `navbar-expand-lg` — кнопка-гамбургер ниже lg, полное меню на lg+; `ms-auto` — прижимает меню вправо; `data-bs-toggle="collapse"` + `data-bs-target` — связывает кнопку и блок, всё остальное делает bootstrap.js.

### Модальные окна

```html
<!-- Триггер -->
<button class="btn btn-danger" data-bs-toggle="modal" data-bs-target="#confirmModal">
  Удалить проект
</button>

<!-- Разметка модалки: фон, диалог, контент -->
<div class="modal fade" id="confirmModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Подтверди удаление</h5>
        <button class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть"></button>
      </div>
      <div class="modal-body">
        Проект и все данные будут удалены безвозвратно.
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-danger" id="confirmDelete">Удалить</button>
      </div>
    </div>
  </div>
</div>
```

Модалка из коробки умеет: focus trap (фокус не уходит за пределы окна), Esc для закрытия, scroll lock на body, ARIA-атрибуты. Под капотом — небольшой JS-плагин (~3 КБ) поверх DOM API, без зависимости от jQuery (в 5-й версии jQuery выкинули полностью). Для программного управления:

```js
import { Modal } from 'bootstrap';

const modal = new Modal('#confirmModal');
modal.show();
// или через data-атрибуты без импорта, если bootstrap.js подключён целиком
```

:::caution[Bootstrap 4 и jQuery-плагины]
В проектах на Bootstrap 4 модалки и дропдауны висят на jQuery (`$('#myModal').modal('show')`). При миграции на 5-й такой код молча умирает: плагинов jQuery больше нет, только data-атрибуты и ES-модули. Ищи `data-toggle` и `$().modal` в репозитории — это инвентаризация перед миграцией.
:::

### Карточки

```html
<div class="card shadow-sm h-100">
  <div class="card-body">
    <h5 class="card-title">Метрики за месяц</h5>
    <p class="card-text text-muted">Выручка выросла на 12% относительно прошлого периода.</p>
    <a href="#" class="btn btn-primary btn-sm">Открыть отчёт</a>
  </div>
  <div class="card-footer text-muted small">Обновлено сегодня</div>
</div>
```

Карточка — это просто рамка + padding + flex-колонка: удобный контейнер для дашбордов. `h-100` в связке с `.row > .col` решает классическую задачу «одинаковая высота карточек».

## Кастомизация: два пути

Путь первый, «быстрый и грязный» — CSS-переменные поверх готового bootstrap.min.css. Bootstrap 5 вывел ключевые токены в CSS custom properties (`--bs-primary`, `--bs-body-bg`, `--bs-border-radius` и десятки других), их можно перекрыть в `:root` или `.theme-custom`:

```css
:root {
  --bs-primary: #7c3aed;      /* брендовый вместо дефолтного синего */
  --bs-border-radius: 10px;
  --bs-font-sans-serif: "Inter", system-ui, sans-serif;
}
```

Путь второй, правильный — сборка из Sass-исходников (здесь пригодится [предыдущая глава](/02-css-frameworks/preprocessors/)): переопределяешь переменные **до** импорта Bootstrap, и в бандл попадает только нужное.

```scss
// styles/bootstrap-custom.scss
// 1. Переопределяем токены ДО @import
$primary: #7c3aed;
$border-radius: 10px;
$font-family-sans-serif: "Inter", system-ui, sans-serif;

// Шкала spacing: добавляем свою ступень
$spacer: 1rem;
$spacers: (
  0: 0,
  1: $spacer * 0.25,
  2: $spacer * 0.5,
  3: $spacer,
  4: $spacer * 1.5,
  5: $spacer * 3,
  6: $spacer * 4.5,   // своя: 72px
);

// 2. Импортируем нужные части (не всё подряд!)
@import "bootstrap/scss/functions";   // функции — первыми
@import "bootstrap/scss/variables";   // дефолтные переменные
@import "bootstrap/scss/variables-dark"; // токены dark mode
@import "bootstrap/scss/maps";
@import "bootstrap/scss/mixins";
@import "bootstrap/scss/root";        // CSS custom properties из переменных
@import "bootstrap/scss/reboot";      // нормализация, не reset
@import "bootstrap/scss/type";
@import "bootstrap/scss/grid";        // только сетка
@import "bootstrap/scss/buttons";
@import "bootstrap/scss/navbar";
@import "bootstrap/scss/card";
@import "bootstrap/scss/modal";
// utilities генерируется из maps — тоже можно подключать выборочно
@import "bootstrap/scss/utilities/api";
```

Порядок импортов важен: `functions` → `variables` → остальное. Выкинув `forms`, `tables`, `carousel` и прочее, ты легко срезаешь бандл с ~200 КБ (весь Bootstrap) до 60–80 КБ сжатого CSS под свою задачу.

:::tip[Почему не трогаем бандл CSS в node_modules]
Никогда не правь `node_modules/bootstrap/dist/css/bootstrap.css` — изменения сотрутся при `npm install`. Кастомизация — только через Sass-сборку или CSS-переменные поверх готового файла.
:::

## Color modes: dark mode из коробки

С версии 5.3 Bootstrap умеет color modes. Механика — через data-атрибут и CSS-переменные: `data-bs-theme="dark"` на `<html>` или любом контейнере переключает палитру целиком:

```html
<html lang="ru" data-bs-theme="dark">
```

```js
// Переключатель темы
const switchTheme = () => {
  const current = document.documentElement.getAttribute('data-bs-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('theme', next);
};
```

Под капотом: Bootstrap генерирует набор `--bs-body-bg`, `--bs-body-color`, `--bs-emphasis-color`, `--bs-border-color` и т.д. в двух вариантах — под `:root` (light) и под `[data-bs-theme="dark"]`. Компоненты читают эти переменные, а не хардкоженные цвета, поэтому переключение работает мгновенно, без перезагрузки CSS. Это та же архитектура, что у Tailwind-конфигов и Shadcn: система стилей на custom properties с двумя темами.

Кастомная третья тема — через Sass-переменные `$theme-colors` и карты цветов, либо вручную через `[data-bs-theme="contrast"] { --bs-body-bg: ...; }`.

## Bootstrap в 2026: когда брать, когда нет

| Сценарий | Вердикт |
|---|---|
| Внутренняя админка, CRM, дашборд «на вчера» | ✅ Лучший выбор: скорость, консистентность, никому не важен «уникальный дизайн» |
| Прототип / MVP для проверки гипотезы | ✅ Идеально: день вместо недели |
| Pet-проект для портфолио с уникальным дизайном | ❌ Дефолтный Bootstrap виден за километр; бери Tailwind |
| Публичный продукт с брендом и дизайн-системой | ❌ Кастомизация дешевле на Tailwind/headless |
| Enterprise с формами и таблицами | ⚠️ Смотри Ant Design / Mantine — специализированные под это |
| Legacy-проект на Bootstrap 3/4 | ⚠️ Мигрируй минимум на 5: jQuery-зависимость, уязвимости, отсутствие тем |

## Типичные ошибки и грабли

1. **Подключил весь bootstrap.min.css ради одной кнопки.** 200 КБ CSS против 8 КБ нужных. Решение: выборочный Sass-импорт (схема выше) или CSS-переменные + утилиты по мере надобности.
2. **Колонки без `.row` или контейнер без `.container`.** Колонки вне row теряют отрицательные margin → «плывущая» вёрстка с горизонтальным скроллом. Строгая тройка: container → row → col.
3. **`col-6` вместо `col-md-6` на адаптивной вёрстке.** Без breakpoint-приставки колонка фиксирована на всех экранах: на телефоне две колонки по 50% превращаются в микроскопический текст. Правило: мобильный layout — дефолт, приставки — для расширения.
4. **Кастомизация через `!important` в своём CSS.** Специфичность Bootstrap-утилит и так высока, `!important` в твоём файле начинает войны каскада, которые выигрывает случайный. Правильные рычаги: Sass-переменные до импорта, CSS-переменные поверх, или свой класс с тем же уровнем специфичности.
5. **Игнорирование data-атрибутов и написание своего JS для модалок.** Свой код для focus trap и Esc обработки — велосипед, который почти всегда хуже боевого плагина. Используй `data-bs-toggle`/`data-bs-target`, программный API — только когда нужна сложная логика.
6. **Модалка внутри фиксированного контейнера.** `.modal` должна лежать на верхнем уровне DOM: внутри `.card` с `transform` или `filter` она наследует трансформацию и ломает позиционирование (классическая проблема stacking context, см. [CSS Core: позиционирование](/02-css-core/positioning/)).
7. **Смешивание Bootstrap 4 и 5 в одном проекте.** Классы переименованы (`data-toggle` → `data-bs-toggle`, `.ml-*` → `.ms-*`, jQuery-плагины удалены). Смесь даст мёртвые кнопки и двойные стили. Миграция — целиком, по официальному гайду.

## Вопросы на собеседовании

1. **Чем `.container` отличается от `.container-fluid`?**
   Container — max-width, меняющийся скачками по breakpoints (540→720→960→1140→1320px); fluid — 100% ширины на всех экранах. Оба дают padding-gutter 12px с боков; `.container-{bp}` — гибрид: fluid ниже breakpoint, fixed выше.
2. **Как устроен gutter в сетке Bootstrap?**
   `.row` имеет отрицательные margin-inline (−12px), колонки — положительные padding-inline (12px). Контент колонок выравнивается с краями контейнера, промежуток между колонками — 24px, управляется через `.g-*`/`.gx-*`/`.gy-*`.
3. **Mobile-first: что это значит в Bootstrap?**
   Базовые стили пишутся для самого маленького экрана; breakpoint-приставки (`md`, `lg`...) — минимальная ширина, стили применяются на breakpoint и выше через `min-width` медиа-запросы. `col-md-6` = 100% ниже 768px, 50% на 768px+.
4. **Как правильно кастомизировать Bootstrap, не правя node_modules?**
   Два пути: переопределение CSS custom properties (`--bs-primary` и др.) поверх готового CSS, или сборка из Sass-исходников с переопределением переменных ($primary, $spacers...) до импорта нужных модулей — это же позволяет сократить бандл до используемых компонентов.
5. **Как работает dark mode в Bootstrap 5.3+?**
   Атрибут `data-bs-theme="dark"` на любом элементе переключает палитру: Bootstrap генерирует набор `--bs-*` custom properties для светлой и тёмной тем, компоненты читают их, переключение мгновенное и работает на уровне отдельных контейнеров.
6. **Что произойдёт, если сумма `.col-*` в row превысит 12?**
   Flex-wrap перенесёт лишние колонки на следующую строку. Это фича для «карточных» сеток, но чаще всего — признак ошибки в расчёте колонок.
7. **Bootstrap 5 отказался от jQuery — как теперь работают компоненты?**
   Собственные JS-плагины на чистом DOM API (Modal, Collapse, Dropdown и др.), поведение через `data-bs-*` атрибуты без единой строчки JS; программный API через импорт классов (`import { Modal } from 'bootstrap'`). Popper — единственная зависимость (дропдауны, тултипы).
8. **Когда Bootstrap — плохой выбор?**
   Публичный продукт с уникальным брендом и дизайн-системой: дефолтный вид «сдаёт» фреймворк, а глубокая кастомизация на Sass обходится дороже, чем старт на Tailwind/headless с нуля.

## Практика

1. Собери адаптивный лендинг-секцию: контейнер, row с `col-lg-6` для двух колонок (текст + картинка), на мобильном — стек. Критерий: ниже 992px колонки в столбик, без горизонтального скролла на 360px.
2. Воспроизведи сетку карточек: 1 колонка на мобильном, 2 на md, 3 на lg, 4 на xl с `g-4` между ними. Критерий: все карточки одинаковой высоты (`h-100` + `.row`), ровные отступы без «висячих» краёв.
3. Настрой страницу с тёмной темой: подключи Bootstrap 5.3 через CDN, добавь `data-bs-theme` и кнопку-переключатель с сохранением в localStorage. Критерий: переключение мгновенное, после перезагрузки тема восстанавливается.
4. Собери кастомную сборку: `npm i bootstrap`, создай SCSS-файл с переопределёнными `$primary`, `$border-radius` и выборочным импортом (grid + buttons + card + modal + utilities). Критерий: скомпилированный CSS заметно меньше полного bootstrap.min.css (проверь `du -h`), модалка работает.
5. Сверстай шапку с navbar: лого слева, меню с `ms-auto`, гамбургер ниже lg, один дропдаун. Критерий: на 375px меню скрыто за гамбургером и открывается по тапу; на 1200px — горизонтальное меню без гамбургера.
6. Найди и исправь баг: карточка внутри `.row` без `.col` обёртки — объясни, почему появляется горизонтальный скролл, и почини двумя способами (обёртка `.col` или padding вместо отрицательных margin). Критерий: письменное объяснение механики gutter + исправленная вёрстка.

## Что почитать

- [Bootstrap 5: документация](https://getbootstrap.com/docs/5.3/getting-started/introduction/) — первоисточник, образец документации как жанра.
- [Bootstrap 5: Grid](https://getbootstrap.com/docs/5.3/layout/grid/) — сетка, gutters, контейнеры, официальные схемы.
- [Bootstrap 5: Customize via Sass](https://getbootstrap.com/docs/5.3/customize/sass/) — структура импортов, переменные, оптимизация бандла.
- [Bootstrap 5: Color modes](https://getbootstrap.com/docs/5.3/customize/color-modes/) — механика тем через data-атрибуты и CSS-переменные.
- [Bootstrap 5 Migration guide](https://getbootstrap.com/docs/5.3/migration/) — что поменялось от 4 к 5: data-атрибуты, утилиты spacing, jQuery.
- [Excess CSS: The Cost of Bootstrap](https://www.zachleat.com/web/build-benchmark/) — замеры размера фреймворков и цены «подключил всё подряд».
