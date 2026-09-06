---
title: "Память: утечки, GC, WeakRef"
description: "Mark-and-sweep и reachability, типичные утечки (таймеры, слушатели, замыкания, кэши), DevTools Memory Profiler, WeakMap/WeakRef/FinalizationRegistry и краткий обзор оптимизаций V8."
---

«JS управляет памятью сам» — правда, которая оборачивается болью, когда приложение после двух часов работы съедает гигабайты. Сборщик мусора освобождает только то, до чего **невозможно добраться** из живого кода. Утечка в JS — почти никогда не «потерянный указатель», а наоборот: лишняя **ссылка**, которую ты не заметил.

Эта глава закрывает раздел: понимание окружений, замыканий и Event Loop здесь сходится в практический навык — держать память под контролем. Разберём алгоритм GC, четыре типичные утечки с реальными сценариями, DevTools как инструмент диагностики и семейство Weak*-структур.

## Как работает сборка мусора: reachability

V8 (и все современные движки) используют **tracing garbage collection** с алгоритмом **mark-and-sweep**. Модель простая:

1. Движок поддерживает набор **корней (roots)**: глобальный объект, стек вызовов, активные слушатели событий, внутренние структуры.
2. От корней начинается обход всех reachable-объектов: от корня до ссылки → объект помечается (mark). От него — дальше по его ссылкам.
3. Всё, до чего не дошли — **мусор**. Фаза sweep освобождает память.

Ключевое понятие — **достижимость (reachability)**: объект жив, пока существует путь ссылок от корня до него. Разорви путь — объект станет мусором (не сразу физически, а при следующем проходе GC).

```js
let user = { name: 'Влад', settings: { theme: 'dark' } };
user = null;
// Объект { name: 'Влад', ... } больше недостижим — GC соберёт его
// (и вложенный settings тоже, если больше нет ссылок)
```

Это объясняет всё из прошлых глав: замыкание держит окружение живым, пока жива функция; промис удерживает свои реакции; DOM-нода в глобальной переменной — корень для всего поддерева.

:::note[Нет детерминированного момента освобождения)]
Ты не знаешь, когда GC пройдёт. Поэтому нельзя «очистить ресурс в деструкторе» — в JS нет деструкторов. Файлы, сокеты, соединения — закрывай явно (finally, try-with-resources-паттерн), память — доверяй GC.
:::

## Типичные утечки: четыре сценария

### 1. Забытые таймеры и интервалы

`setInterval` живёт, пока его не остановят. Колбэк удерживает всё своё окружение:

```js
// ПЛОХО: компонент монтируется много раз, каждый раз новый интервал
function startMetrics() {
  const bigBuffer = new Array(1_000_000).fill('📊');
  setInterval(() => {
    report(bigBuffer.slice(0, 10)); // ссылка на bigBuffer — удерживается навсегда
  }, 1000);
}

// ХОРОШО: сохраняем id, очищаем при остановке
let timerId = null;
function startMetrics() {
  timerId = setInterval(() => report(), 1000);
}
function stopMetrics() {
  clearInterval(timerId);
  timerId = null;
}
```

Даже `setTimeout` с длинной задержкой — ловушка: если компонент размонтировался раньше, колбэк всё равно выполнится и обратится к «мёртвому» состоянию. Храни id и делай `clearTimeout`.

### 2. Слушатели событий

Каждый `addEventListener` — потенциальный удержатель объекта. Добавил слушатель на `document`/`window` и потерял ссылку на элемент — слушатель живёт, элемент (и всё, что он замыкает) живёт:

```js
// ПЛОХО: слушатель на document держит panel и её 50 МБ данных
function attachGlobalHandler(panel) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.close();
  });
  // panel никогда не будет собран, даже после удаления из DOM
}

// ХОРОШО: AbortSignal — современный способ групповой отмены
function attachGlobalHandler(panel, signal) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.close();
  }, { signal }); // signal.abort() снимет слушатель
}
```

Старый код — ручной `removeEventListener` с той же ссылкой на функцию (поэтому колбэки выносят в именованные переменные, а не анонимные стрелки).

### 3. Замыкания на большие структуры

Разбиралось в главе про замыкания, но повторим как утечку: колбэк удерживает всё лексическое окружение, даже если использует одну переменную:

```js
// ПЛОХО: обработчик клика удерживает 100 МБ данных «на всякий случай»
function initDashboard() {
  const hugeDataset = loadData(); // 100 МБ
  document.querySelector('#export').addEventListener('click', () => {
    exportCsv(hugeDataset);
  });
}

// ХОРОШО: захватываем минимум — ссылку на «ленивый» источник
function initDashboard() {
  const getData = () => loadData(); // данные грузятся по требованию
  document.querySelector('#export').addEventListener('click', async () => {
    exportCsv(await getData());
  });
}
```

### 4. Глобальные кэши и реестры

Кэш «растёт бесконечно» — классика. Любая Map в module-scope живёт вечно:

```js
// ПЛОХО: кэш растёт безгранично
const cache = new Map();
async function getUser(id) {
  if (!cache.has(id)) {
    cache.set(id, await fetchUser(id));
  }
  return cache.get(id);
}

// ХОРОШО: ограниченный размер + WeakMap (GC удалит записи вместе с ключами,
// если ключи — объекты) или LRU
const cache = new Map();
const MAX = 1000;
async function getUser(id) {
  if (cache.has(id)) {
    const v = cache.get(id);
    cache.delete(id); cache.set(id, v); // refresh порядка (LRU)
    return v;
  }
  const user = await fetchUser(id);
  cache.set(id, user);
  if (cache.size > MAX) cache.delete(cache.keys().next().value);
  return user;
}
```

:::caution[Detached DOM-узлы)]
Узел удалён из документа (`removeChild`), но на него есть ссылка в JS (массив, замыкание, jQuery-данные) — узел и всё его поддерево висят в памяти. DevTools Memory → «Detached DOM tree» — прямой диагноз.
:::

## Allocation pressure: когда GC становится проблемой

Поколенческая сборка (см. блок про V8 ниже) делает мелкие аллокации почти бесплатными — до порога. «Allocation pressure» — ситуация, когда код создаёт объекты быстрее, чем scavenge успевает их собирать: движок тратит на GC больше времени, чем на твой код. Симптомы — рост CPU на GC в профайлере (Performance → Bottom-Up → GC), «пилы» в allocation timeline с уклоном вверх.

Типичные источники в «обычном» коде:

```js
// ПЛОХО: миллионы временных объектов в горячем цикле
function processRows(rows) {
  return rows
    .filter((r) => r.active)                    // новый массив
    .map((r) => ({ ...r, score: calc(r) }))     // новый объект на каждую строку
    .sort((a, b) => b.score - a.score);         // ещё копирования
}

// ХОРОШО: один проход с мутируемым аккумулятором (или генератором)
function* processRowsLazy(rows) {
  const scored = [];
  for (const r of rows) {
    if (!r.active) continue;
    scored.push({ row: r, score: calc(r) }); // один объект вместо трёх
  }
  scored.sort((a, b) => b.score - a.score);
  yield* scored;
}
```

Это не призыв «никогда не использовать map/filter». В бизнес-коде читаемость важнее; оптимизировать стоит только профилированные горячие пути (обработка стримов, рендер-циклы, парсеры). Замеряй allocation sampling в DevTools — он покажет конкретные строки, которые аллоцируют больше всего.

Ещё один сюрприз — **retained size против shallow size**: объект сам по себе маленький (24 байта), но держит массив на миллион элементов. В heap snapshot смотри именно retained size: он показывает, сколько памяти реально освободится, если объект собрать.

## DevTools Memory Profiler

Диагностика утечек — навык, а не гадание. Chrome DevTools → Memory:

1. **Heap snapshot** — фотография объектов в куче. Делай два снимка: до и после подозрительной операции (например, 10 открытий-закрытий модалки). Сравни (Comparison view): объекты, чей счётчик вырос и не упал — кандидаты.
2. **Allocation instrumentation on timeline** — записывает, где и когда выделялась память. Видно «лесенку» (память растёт и не падает — утечка) против «пилы» (GC работает).
3. **Allocation sampling** — лёгкий профайлер выделений: показывает, какие функции аллоцируют больше всего.

Типичный сценарий отладки:

```
1. Открыть приложение, прогреть (сделать действие 3-5 раз)
2. Heap snapshot → «Take snapshot» (baseline)
3. Повторить действие 10-20 раз
4. Snapshot #2 → Comparison → filter по retained size ↑
5. Посмотреть retaining path: кто держит объект (Listener? Map? Closure?)
6. Исправить код → повторить: retained size после серии действий должен вернуться к baseline
```

Allocation timeline с лесенкой:

```
memory
  │    ┌─┐     ┌─┐
  │   ┌┘ └┐   ┌┘ └┐        ← каждое действие добавляет, GC не возвращает
  │  ┌┘   └┐ ┌┘   └┐
  └──┴─────┴─┴─────┴──► действия
```

:::tip[Дистанционные сессии)]
В продакшене утечки ищут по метрикам: `performance.memory` (Chrome, `usedJSHeapSize`), метрики RSS в Node (`process.memoryUsage()`), снапшоты heap из Node (`node --inspect` + Chrome DevTools, или `v8.getHeapSnapshot()`).
:::

## WeakMap, WeakRef, FinalizationRegistry

Семейство «слабых» структур — ключи/значения, которые не мешают сборке мусора.

### WeakMap и WeakSet

Ключи — только объекты; на них — **слабые ссылки**: если объект недостижим больше никак, запись удаляется GC автоматически:

```js
// Приватные данные объектов без полей: meta «привязана» к жизни объекта
const meta = new WeakMap();

function createWidget(id) {
  const widget = { id };
  meta.set(widget, { createdAt: Date.now(), clicks: 0 });
  return widget;
}

const w = createWidget('btn-1');
console.log(meta.get(w)); // { createdAt: ..., clicks: 0 }
w = null; // объект + его метаданные соберутся GC, записи в WeakMap не мешают
```

Применения: метаданные DOM-узлов, результаты вычислений для объектов, приватность без `#`-полей (старый приём до ES2022).

Ограничения: не итерируемы (GC может удалять в любой момент — порядок не определён), нет `.size`, `.clear()` (в современных спецификациях нет — обход через пересоздание).

### WeakRef

`WeakRef` даёт явную слабую ссылку на объект: `ref.deref()` вернёт объект, если жив, или `undefined`:

```js
let cachedPreview = new WeakRef(loadHugePreview());

function showPreview() {
  const preview = cachedPreview.deref();
  if (preview) {
    render(preview); // объект ещё жив
  } else {
    cachedPreview = new WeakRef(loadHugePreview()); // пересоздаём
    render(cachedPreview.deref());
  }
}
```

Используется редко — обычно WeakMap решает задачу чище. Сценарий: кэш больших объектов, которые дорого держать, но и дорого пересоздавать (превью, декодированные буферы).

### FinalizationRegistry

Колбэк при сборке объекта — для внешних ресурсов (нативные хендлы, файлы):

```js
const registry = new FinalizationRegistry((fileHandle) => {
  fileHandle.close(); // движок гарантирует: объект собран
});

function openTracked(file) {
  const handle = nativeOpen(file);
  registry.register(handle, handle, handle); // target, heldValue, unregisterToken
  return handle;
}
```

:::caution[FinalizationRegistry — не деструктор)]
Колбэк выполняется **неизвестно когда** (после GC, в отдельной задаче) и без гарантий порядка. Для детерминированной очистки — всегда явный `close()`/`finally`. Registry — страховка, не протокол.
:::

## Кратко об оптимизациях V8

Понимание GC дополняется знанием, как V8 исполняет код:

- **Скрытые классы (hidden classes / shapes)**: объекты с одинаковой структурой делят описание формы. Менять форму на лету (`obj.a = 1; obj.b = 2;` в разных ветках) — деоптимизация.
- **Inline caches**: вызовы `obj.method()` кешируются по форме объекта; полиморфные вызовы (разные формы) медленнее мономорфных.
- **Орпанство поколений (generational GC)**: молодые объекты (allocation) собираются часто и быстро (scavenge), старые — редко (mark-compact). «Выжившие» объекты promoted в старое поколение. Отсюда правило: не держи живыми временные объекты дольше нужного.
- **Типизация через наблюдение**: V8 оптимизирует под фактически встречающиеся типы; `Array(1000)` смешанных типов (числа + строки + объекты) медленнее типизированных.

Практический вывод: пиши естественно, избегай менять форму объектов в горячих путях и не оптимизируй преждевременно — профилируй (Performance-вкладка).

## Типичные ошибки и грабли

1. **«GC соберёт, я не обязан снимать слушатели».** Соберёт — когда все ссылки исчезнут. Слушатель на `window` — ссылка навсегда, если не снят.
2. **Кэш без eviction.** Любая бесконечная Map в module scope — утечка по определению. Лимит, TTL, WeakMap.
3. **Интервалы в React/Vue/Svelte без очистки на unmount.** Хук `useEffect(() => { const id = setInterval(...); return () => clearInterval(id); }, [])`.
4. **Замыкание на DOM-ноду в долгоживущем колбэке** (WebSocket onmessage, подписка). Отписывайся или используй AbortSignal.
5. **Детали в `console.log` объектов** в DevTools — не утечка, но в проде держать включённым логирование больших объектов дорого (сериализация, retained memory логгером).
6. **Ожидание детерминированного вызова FinalizationRegistry.** Нет гарантий «когда»; явная очистка обязательна.
7. **Detached DOM из таблиц виртуализации.** Виртуальные списки пересоздают узлы; старые строки, на которые ссылаются обработчики/анимации, висят в памяти.

## Вопросы на собеседовании

1. **Какой алгоритм GC использует V8 и что такое reachability?**
   Mark-and-sweep (tracing GC): от корней (глобал, стек, внутренние структуры) помечаются все достижимые объекты, остальное — мусор. Объект жив, пока есть путь ссылок от корня.
2. **Назови три типичные утечки в SPA и их лечение.**
   (1) Неснятые слушатели/таймеры — clear/remove + AbortSignal; (2) замыкания на большие структуры в долгоживущих колбэках — минимизировать захват; (3) бесконечные кэши/реестры — лимиты, TTL, WeakMap.
3. **Чем WeakMap отличается от Map?**
   Ключи-объекты по слабым ссылкам: недостижимый ключ вместе с записью удаляется GC. Не итерируется, нет size. Для метаданных и кэшей по объектам.
4. **Как найти утечку в DevTools?**
   Heap snapshots до/после повторяемого действия, Comparison view по retained size, retaining path к виновнику; либо Allocation timeline — «лесенка» роста.
5. **Что такое WeakRef и FinalizationRegistry? Когда использовать?**
   Явная слабая ссылка (deref → объект или undefined) и колбэк при сборке объекта. Редкие инструменты для нативных ресурсов и оптимизаций; не замена явному close().
6. **Почему нельзя полагаться на GC для закрытия файлов/соединений?**
   GC недетерминирован: момент сбора неизвестен, объект может быть собран поздно или (при ссылке) никогда. Ресурсы закрываются явно — try/finally.

## Практика

1. Напиши `createLRUCache(max)`: Map с вытеснением least-recently-used. Критерий: после превышения max самые старые записи удаляются; get/update обновляют «свежесть».
2. Реализуй класс `TimerRegistry`: методы `setInterval(fn, ms)` и `disposeAll()`. Критерий: после dispose все интервалы остановлены, колбэки не вызываются, замкнутые ими объекты становятся unreachable (проверь в DevTools двумя снапшотами).
3. Создай `observeSize(element)`: WeakRef-подобная утилита, возвращающая `{ get(): number|null }` — текущую ширину элемента или null, если элемент собран GC. Сымитируй: создай элемент, получи get(), удали все ссылки, форсируй GC (если доступно) и покажи null.
4. Найди утечку в коде (придумай/получи сниппет с setInterval + замыканием на массив и слушателем на window). Исправь двумя способами: ручная отписка и AbortSignal. Проверь Heap snapshots до/после 20 циклов монтирования/размонтирования.
5. Реализуй `trackResource(nativeHandle)`: обёртка с `close()` (детерминированная очистка) + FinalizationRegistry как страховка. Критерий: явный close вызывает cleanup ровно один раз; сборка без close тоже вызывает cleanup (проверь в Node с --expose-gc).

## Что почитать

- [MDN: Управление памятью](https://developer.mozilla.org/ru/docs/Web/JavaScript/Memory_management)
- [MDN: WeakMap](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Global_Objects/WeakMap)
- [MDN: FinalizationRegistry](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)
- [V8 Blog: Trash talk (сборка мусора)](https://v8.dev/blog/trash-talk)
- [Chrome DevTools: Fix memory problems](https://developer.chrome.com/docs/devtools/memory-problems/)
