---
title: "async/await, AbortController, top-level await"
description: "Как await работает поверх промисов, последовательность и параллельность в циклах, отмена операций через AbortController и AbortSignal.timeout, top-level await и async-генераторы с for await."
---

`async/await` — это не новый механизм, а синтаксис над промисами и генераторами. Но знание этого факта само по себе ничего не даёт; важно понимать, как именно `await` приостанавливает функцию, где он теряет параллельность и как правильно отменять начатые операции. Три темы этой главы — самые практичные: параллельные запросы, отмена через `AbortController` и потоковая обработка через async-генераторы.

## Как await работает под капотом

`async`-функция при вызове **немедленно возвращает промис**. Тело выполняется синхронно до первого `await`, затем функция приостанавливается — управление возвращается вызывающему коду, а продолжение (всё после `await`) ставится в очередь микрозадач и выполнится, когда промис разрешится:

```js
async function demo() {
  console.log('A');              // синхронно при вызове
  const v = await Promise.resolve(42);
  console.log('B, получили:', v); // микрозадача: продолжение после await
  return v * 2;                   // результат — resolve промиса функции
}

const p = demo();
console.log('C — функция уже вернула промис');
p.then((r) => console.log('D, итог:', r));
// A → C → B → D (и итог: 84)
```

Механика приостановки: движок сохраняет локальные переменные и позицию выполнения (как у генератора — ранее async-функции буквально транспилировались в генераторы + `yield`). Поэтому цикл с `await` «помнит» свою итерацию — это не многопоточность, а кооперативная многозадачность в одном потоке.

Ошибки внутри async-функции (включая rejected `await`) превращаются в reject возвращаемого промиса — отсюда `try/catch/finally` вокруг `await`, как вокруг синхронного кода.

## await в циклах: последовательность против параллельности

Классическая ошибка — `await` в `for` при загрузке независимых данных:

```js
// ПЛОХО: запросы идут ОДИН ЗА ДРУГИМ — время = сумма задержек
async function loadSequentially(ids) {
  const users = [];
  for (const id of ids) {
    const r = await fetch(`/api/users/${id}`);
    users.push(await r.json());
  }
  return users; // 10 запросов × 300 мс = ~3 секунды
}
```

```js
// ХОРОШО: запросы стартуют сразу все, ждём вместе
async function loadParallel(ids) {
  const users = await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`/api/users/${id}`);
      return r.json();
    })
  );
  return users; // ~300 мс независимо от количества (в пределах лимитов)
}
```

Но есть ситуации, где последовательность **нужна**:

- Зависимость данных: сначала пользователь, потом его заказы (нужен `user.id`).
- Rate limiting: API разрешает N запросов/сек; параллельный залп получит 429.
- Ограничение нагрузки: чужой сервер, не флудим.

Компромисс — ограниченная параллельность (пул). Реализация через пакеты:

```js
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  // Запускаем `limit` «рабочих», каждый берёт следующий элемент
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Использование: не более 3 одновременных запросов
const avatars = await mapWithConcurrency(userIds, 3, async (id) => {
  const r = await fetch(`/api/users/${id}/avatar`);
  return r.blob();
});
```

:::tip[Маппинг сохраняет порядок)]
`Promise.all(ids.map(...))` вернёт результаты в порядке `ids`, независимо от порядка завершения запросов. Деструктуризация безопасна.
:::

:::caution[forEach не ждёт await)]
```js
ids.forEach(async (id) => { await save(id); });
console.log('готово'); // напечатается ДО завершения всех save!
```
`forEach` игнорирует возвращаемые промисы колбэков. Ждать — только `for...of` + `await` (последовательно) или `Promise.all` + `map` (параллельно).
:::

## Отмена операций: AbortController

`fetch`, `addEventListener`, `ReadableStream` и большинство современных асинхронных API принимают `signal` — объект-«флажок отмены». `AbortController` — источник этого сигнала:

```js
const controller = new AbortController();
const { signal } = controller;

// Отменим всё через 5 секунд
const timerId = setTimeout(() => controller.abort(), 5000);

try {
  const r = await fetch('/api/big-report', { signal });
  const data = await r.json();
  renderReport(data);
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Запрос отменён (таймаут)');
  } else {
    console.error('Сетевая ошибка:', err);
  }
} finally {
  clearTimeout(timerId);
}

// Любой момент: controller.abort() → все слушатели сигнала отменяются
```

Один контроллер отменяет **связку** операций — идеально для «пользователь ушёл со страницы»:

```js
function createPageLoader(signal) {
  return async function loadEverything() {
    const [user, feed, ads] = await Promise.all([
      fetch('/api/user', { signal }).then((r) => r.json()),
      fetch('/api/feed', { signal }).then((r) => r.json()),
      fetch('/api/ads', { signal }).then((r) => r.json()),
    ]);
    return { user, feed, ads };
  };
}

// В обработчике перехода:
const controller = new AbortController();
pageLoader = createPageLoader(controller.signal);
pageLoader().catch((e) => e.name === 'AbortError' || showError(e));

// При уходе со страницы:
controller.abort(); // все три fetch отменены разом
```

### AbortSignal.timeout — встроенный таймаут

Современные браузеры и Node 17.3+ имеют встроенный таймаут без ручного `setTimeout`:

```js
// Отмена fetch через 8 секунд, без контроллера и clearTimeout
const r = await fetch('/api/slow-endpoint', { signal: AbortSignal.timeout(8000) });
// При срабатывании: AbortError с именем 'AbortError' (причина — TimeoutError)
```

### Комбинирование сигналов

Отменять при «любой из причин» — через `AbortSignal.any` (браузеры, Node 20.3+):

```js
const pageLeave = new AbortController();
const userCancel = new AbortController();

const signal = AbortSignal.any([pageLeave.signal, userCancel.signal, AbortSignal.timeout(10_000)]);
await fetch('/api/data', { signal }); // отменится при уходе, клике «отмена» или 10 с
```

### Своя отменяемая операция

Если пишешь асинхронную утилиту — принимай `signal` и реагируй на него:

```js
function delay(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Отменено', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Отменено', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Теперь delay отменяем:
const c = new AbortController();
delay(5000, { signal: c.signal }).catch((e) => console.log(e.name)); // AbortError
setTimeout(() => c.abort(), 100);
```

:::note[AbortError — не ошибка)]
По конвенции отмена сигнализирует через `AbortError` (DOMException). Код потребителя обязан различать: отмена — штатный сценарий (молча завершить), сетевая ошибка — показать пользователю. Всегда проверяй `err.name === 'AbortError'` первым.
:::

## Top-level await

В ES-модулях `await` разрешён на верхнем уровне — без обёртки в `async`-функцию. Модуль «зависает» в состоянии загрузки, пока все top-level `await` не разрешатся, и экспорты становятся доступны только после:

```ts
// config.ts — модуль не считается загруженным, пока конфиг не получен
const response = await fetch('/config.json');
if (!response.ok) throw new Error('Конфиг недоступен — приложение не стартует');

export const config = await response.json();
export const apiUrl = config.apiUrl;
```

```ts
// main.ts — импорт «ждёт» config.ts автоматически
import { apiUrl } from './config';
// здесь apiUrl гарантированно инициализирован
```

Где это полезно:

- Инициализация перед экспортом (конфиг, подключение к БД, feature-flags).
- Динамический импорт с условием: `const mod = await import(cond ? './a' : './b')`.
- Fallback-цепочки: `let adapter; try { adapter = await import(' sharp'); } catch { adapter = await import('jimp'); }`.

Ограничения:

- Только ES-модули (`type: "module"` или `.mjs`). CommonJS не поддерживает.
- Блокирует дерево импорта: модуль-потребитель не выполнится раньше. Держи top-level await короткими; тяжёлую работу — в экспортированную async-функцию.
- В библиотеках — осторожно: потребители не ожидают, что `import` будет ждать сеть.

## Async-генераторы и for await

Генераторы (`function*`) лениво производят значения через `yield`. **Async-генераторы** (`async function*`) производят значения асинхронно — каждый `yield` может ждать промис:

```js
// Поток чтения большого списка порциями: не грузим всё в память
async function* fetchUsersInBatches(baseUrl, batchSize = 50) {
  let page = 1;
  while (true) {
    const r = await fetch(`${baseUrl}?page=${page}&limit=${batchSize}`);
    const batch = await r.json();
    if (batch.length === 0) return; // конец потока
    for (const user of batch) {
      yield user; // лениво отдаём по одному
    }
    page += 1;
  }
}

// Потребление: for await...of автоматически вызывает .next() и ждёт промисы
for await (const user of fetchUsersInBatches('/api/users')) {
  renderUserCard(user);
  if (user.id === targetId) break; // генератор корректно завершится (return вызовется)
}
```

Ключевые свойства:

- `for await...of` работает с async-итерабелями (объект с `[Symbol.asyncIterator]`) и с обычными итерируемыми (массив промисов).
- `break`/`return` в цикле вызывает `generator.return()` — finally-блоки внутри генератора выполнятся (отмена fetch, закрытие курсора).
- Async-генераторы — основа streaming-API: чтение файлов/ответов по кускам, подписки на события как потоки.

Пример с обработкой потока ответа (Web Streams API):

```js
async function* readLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock(); // освобождаем ресурс при break/ошибке
  }
}

const response = await fetch('/api/logs?follow=1');
for await (const line of readLines(response.body)) {
  console.log('лог:', line);
}
```

## Ошибки в параллельных операциях: точечный контроль

Когда в `Promise.all` падает один запрос из пяти, весь комбинатор rejected — и ты теряешь результаты остальных четырёх. В продакшене это часто не то, что нужно: страница профиля может отрисоваться без блока «рекомендации», но не без блока «основная информация». Решение — разделить критичность:

```js
async function loadProfilePage(userId) {
  // Критично: без этого страница бессмысленна — пусть весь рендер падает
  const user = await loadUser(userId);

  // Некритично: каждый блок грузим изолированно, ошибка → запасной контент
  const [stats, friends, activity] = await Promise.all([
    loadStats(userId).catch(() => null),        // «недоступно»
    loadFriends(userId).catch(() => []),        // пустой список
    loadActivity(userId).catch(() => []),       // пустая лента
  ]);

  return { user, stats, friends, activity };
}
```

Приём `.catch(() => fallback)` внутри `Promise.all` — стандартный способ сказать «этот кусок опционален». Важно ловить локально, а не оборачивать весь `all` в один try/catch: иначе не узнаешь, какой именно запрос упал, и не покажешь точечный fallback.

Если же нужно знать детали всех падений (например, для телеметрии), используй `allSettled` и разбирай статусы явно:

```js
const results = await Promise.allSettled([loadA(), loadB(), loadC()]);
const failures = results
  .map((r, i) => ({ ...r, index: i }))
  .filter((r) => r.status === 'rejected');
if (failures.length) {
  reportToSentry('Частичная загрузка профиля', { failures });
}
```

Этот паттерн — разновидность «circuit breaker на минималках»: система деградирует частично, но не падает целиком. В полноценном виде он вырастает в отдельный модуль устойчивости (retry, fallback-источники, дедлайны), но основа — именно разделение критичных и некритичных операций на уровне вызова.

## Async-генераторы как публичный API потоков

Если твоя функция возвращает поток данных, async-генератор часто честнее, чем «массив всего сразу» или колбэк `onItem`. Сравни контракты:

```js
// Вариант 1: массив — ждём всех перед стартом, память под всё сразу
const users = await fetchAllUsers(); // 100 000 записей в памяти

// Вариант 2: колбэки — инверсия контроля, сложно остановить
streamUsers((user) => render(user), { onDone, onError });

// Вариант 3: async-генератор — потребитель решает, когда брать следующий
for await (const user of streamUsers()) {
  render(user);
  if (enoughRendered()) break; // генератор завершится, ресурсы освобождены
}
```

Потребитель с `for await` получает полный контроль: пауза между итерациями (просто не вызывать `next`), ранний выход (`break` вызывает `return()` генератора), обработку ошибок обычным try/catch. А реализация скрывает детали постраничной загрузки, реконнекты и бэкоффы внутри.

Правило проектирования: если данные приходят порциями и потребитель может обработать их по частям — возвращай async-итерабель. Если нужен один конкретный результат — промис. Если «всё или ничего» — массив.

## Типичные ошибки и грабли

1. **`await` в `forEach`/`map` без `Promise.all`.** `forEach` не ждёт; `map` возвращает массив промисов, которые никто не ждёт — unhandled rejection при ошибках. См. блок выше.

2. **Последовательные запросы, где нужна параллельность.** Задержки суммируются. Проверяй: независимы ли запросы? Если да — `Promise.all`.

3. **Параллельный залп без лимита** на сотнях элементов — бан по rate limit, перегрузка памяти. Используй пул из примера `mapWithConcurrency`.

4. **Забытый `AbortController` при SPA-навигации.** Пользователь ушёл, а fetch продолжает качать мегабайты и потом пишет в размонтированный компонент. Передавай `signal` всем запросам страницы.

5. **Путать `AbortError` с реальной ошибкой** — показывать тост «Сеть недоступна» при штатной отмене. Проверяй `err.name` первым делом.

6. **Тяжёлый top-level await в библиотечном модуле** — потребители блокируются неожиданно. Документируй или убери в функцию.

7. **Не закрытый async-генератор**: `break` без finally в генераторе — удержание ресурсов (reader, соединение). Всегда `try/finally` с очисткой.

## Вопросы на собеседовании

1. **Что возвращает async-функция и что делает await внутри неё?**
   Промис. `await` приостанавливает функцию до разрешения промиса, продолжение — микрозадача; ошибки превращаются в reject возвращаемого промиса.
2. **Как выполнить независимые запросы параллельно?**
   `Promise.all(ids.map(async id => ...))` — стартуют сразу все, порядок результатов сохранён. Для лимита — пул рабочих поверх `Promise.all`.
3. **Как отменить fetch? Что такое AbortSignal.timeout?**
   Передать `{ signal }` от `AbortController` и вызвать `abort()`. `AbortSignal.timeout(ms)` — встроенный сигнал с автоматическим прерыванием через `ms` (Node 17.3+, современные браузеры).
4. **Что такое top-level await и где работает?**
   `await` на верхнем уровне ES-модуля; модуль не завершает загрузку, пока не разрешатся все await. Только ESM (браузер, Node 14.8+ с `.mjs`).
5. **Чем async-генератор отличается от обычного и как его потреблять?**
   `async function*` может `await` внутри и `yield` промисы; потребление через `for await...of`, который ждёт каждый `next()`. Корректно завершается через `break` (вызовет `return()`).
6. **Почему `arr.forEach(async ...)` не работает как ожидается?**
   `forEach` игнорирует промисы колбэков: не ждёт завершения и не ловит ошибки. Замена — `for...of` + await или `Promise.all(arr.map(...))`.

## Практика

1. Напиши `runWithConcurrency(tasks, limit)`: принимает массив функций-задач (каждая возвращает промис) и лимит одновременных выполнений. Критерий: не более `limit` активных задач (проверь счётчиком), порядок результатов — порядок задач, ошибка любой задачи отклоняет итог.
2. Реализуй `fetchWithRetry(url, { retries, delay, signal })`: fetch с N повторами при ошибках, бэкофф задержки `delay * 2^n`, полный уважение к `signal` (отмена прекращает ретраи). Критерий: сервер, падающий первые 2 раза, успешно обслуживает с 3-й попытки.
3. Создай утилиту `createCancellable()`: возвращает `{ promise, cancel }`, где `promise` резолвится через `resolve(value)`, а `cancel()` отклоняет с `AbortError`. Сымитируй компонент: две загрузки, отменяемые одним `cancel()`.
4. Напиши `watchFileChanges(path)` — async-генератор, лениво читающий растущий файл порциями (имитация `tail -f`): каждые 500 мс проверяет новые строки и `yield`-ит их. Критерий: `break` из `for await` останавливает таймер (finally), нет утечки.
5. Перепиши последовательный код на параллельный и обоснуй: загрузка пользователя, его заказов и рекомендаций; заказы зависят от `user.id`. Найди компромисс (заказы+рекомендации параллельно после пользователя) и реализуй его.

## Что почитать

- [MDN: async function](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Statements/async_function)
- [MDN: AbortController](https://developer.mozilla.org/ru/docs/Web/API/AbortController)
- [MDN: for await...of](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Statements/for-await...of)
- [V8 Blog: Async generators](https://v8.dev/blog/async-iteration)
- [MDN: Top-level await](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Operators/await#top-level-await)
