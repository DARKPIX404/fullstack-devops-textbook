---
title: "Promise под капотом"
description: "Состояния и переходы промисов, then-цепочки и возврат значений, промисификация колбэков, комбинаторы all/race/allSettled/any, обработка ошибок и async-стек трейсов."
---

Promise — это не «способ писать async/await», а самостоятельный примитив синхронизации с точной семантикой состояний. Понимание этой семантики — разница между разработчиком, который ловит «unhandled rejection» в логах продакшена, и тем, кто пишет цепочки, которые не ломаются.

В краткой версии мы использовали промисы как обёртку над `fetch`. Здесь — как они устроены внутри: состояния, почему состояние меняется ровно один раз, как then-цепочки передают значения и ошибки, все четыре комбинатора и почему async-стек трейсов в современном V8 наконец-то читаемые.

## Состояния и переходы

У промиса есть ровно три состояния:

- **pending** — ожидание; результат неизвестен.
- **fulfilled** — успех; есть значение.
- **rejected** — провал; есть причина (ошибка).

Переходы строго односторонние: pending → fulfilled ИЛИ pending → rejected. **Назад и повторно — нельзя.** Первый вызов `resolve`/`reject` побеждает, остальные игнорируются:

```js
const p = new Promise((resolve, reject) => {
  resolve('первый');
  resolve('второй');  // проигнорирован
  reject(new Error()); // тоже проигнорирован
});

p.then((v) => console.log(v)); // «первый»
```

Промис «замораживает» результат: если в `resolve` передать thenable (объект с методом `then`), промис **расплющит** его — дождётся его разрешения и примет итоговое значение:

```js
const nested = Promise.resolve(Promise.resolve(42));
nested.then((v) => console.log(v)); // 42, а не Promise<42>

// То же с thenable «на коленке»:
Promise.resolve({ then(resolve) { resolve('готово'); } })
  .then((v) => console.log(v)); // «готово»
```

Это свойство — основа then-цепочек: любой `then` возвращает промис, и если колбэк вернул промис, цепочка ждёт его.

:::note[Executor выполняется синхронно)]
Функция, переданная в `new Promise(...)` (executor), выполняется **немедленно, синхронно**. Асинхронны только реакции `.then`. Поэтому `new Promise` без асинхронной операции внутри — код-пахнет: «промисификация» синхронного кода добавляет лишнюю микрозадачу без пользы.
:::

## then-цепочки: как передаются значения и ошибки

Каждый вызов `.then(onFulfilled, onRejected)` возвращает **новый промис**. Его судьба зависит от того, что вернул/бросил колбэк:

1. Вернул значение → новый промис fulfilled с этим значением.
2. Вернул промис/thenable → новый промис ждёт его (flattening).
3. Бросил ошибку → новый промис rejected с этой ошибкой.
4. Колбэка нет (`undefined`) → значение/ошибка **протекает** дальше как есть.

```js
Promise.resolve(1)
  .then((v) => v + 1)            // 2
  .then((v) => {                 // бросаем ошибку
    throw new Error(`баг на значении ${v}`);
  })
  .then(() => 'не выполнится')   // onFulfilled пропущен из-за rejected
  .catch((err) => {
    console.log(err.message);    // «баг на значении 2»
    return 'восстановились';     // fulfilled снова!
  })
  .then((v) => console.log(v));  // «восстановились»

// Пропуск колбэка = проброс:
Promise.reject(new Error('x'))
  .then((v) => v)      // нет — протекает ошибка
  .then((v) => v)      // нет
  .catch((e) => 'ок'); // да — поймали
```

Ключевой ментальный сдвиг: **catch — это тоже then**. Он возвращает промис, и если внутри не бросить ошибку дальше, цепочка «восстанавливается» в fulfilled. Это позволяет строить конвейеры с локальной обработкой сбоев:

```js
fetch('/api/user')
  .then((r) => {
    if (r.status === 404) return null; // «не найден» — не ошибка, а данные
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((user) => {
    // user может быть null — обрабатываем штатно
    renderHeader(user);
  })
  .catch((err) => showFatalError(err));
```

:::tip[fetch не реджектит на HTTP-статутах)]
`fetch` отклоняет промис только при сетевой ошибке. `404`/`500` — успешный fulfilled с `response.ok === false`. Проверяй вручную — классическая грабля.
:::

## Паттерн Deferred: промис, которым управляют извне

Иногда промис создаётся в одном месте, а `resolve`/`reject` вызываются из другого — например, тестовый мок сервера или очередь сообщений, где ответ приходит колбэком за пределами `new Promise`. Паттерн **Deferred** выносит ручки управления наружу:

```js
function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Промис уже создан; resolve/reject вызовутся позже, из любого места
  return { promise, resolve, reject };
}

// Пример: мок WebSocket-сервера в тестах
function createMockSocket() {
  const incoming = createDeferred();

  setTimeout(() => {
    incoming.resolve({ type: 'welcome', userId: 42 }); // «ответ сервера»
  }, 100);

  return {
    waitForWelcome: () => incoming.promise,
  };
}

const socket = createMockSocket();
const msg = await socket.waitForWelcome(); // ждём «сервер» из теста
console.log(msg.userId); // 42
```

В прикладном коде deferred встречается в обёртках над event-driven API (шина событий, `once`-подписки), в тестах — для контроля времени. В бизнес-коде чаще предпочитают `new Promise` с логикой внутри executor'а: deferred даёт лишнюю свободу и риск forget-to-resolve.

Отсюда производное правило: **промис должен резолвиться или отклоняться всегда**. «Вечно pending» — тоже утечка (потребители висят на await навсегда). Поэтому в таймаутах и реальных системах добавляют `Promise.race` с таймаутом или `AbortSignal` (см. следующую главу).

## Промисификация колбэков

Node.js и старые браузерные API живут в стиле «последний аргумент — колбэк». Оборачивай в промисы через `new Promise`, всегда вызывая `resolve`/`reject` ровно один раз:

```js
// Старый Node-style колбэк: fs.readFile(path, options, cb)
import { readFile } from 'node:fs';

function readFileAsync(path, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    readFile(path, encoding, (err, data) => {
      if (err) reject(err);   // ошибка — reject
      else resolve(data);     // успех — resolve
    });
  });
}

const content = await readFileAsync('./config.json');
```

В Node.js для этого есть утилита `promisify` (и многие модули `node:fs/promises` уже промисные):

```js
import { promisify } from 'node:util';
import { readFile } from 'node:fs';

const readFileAsync = promisify(readFile);
// Под капотом: та же обёртка, плюс проверка сигнатуры колбэка.
```

Правила честной промисификации: reject — только на реальные ошибки; resolve — с результатом; колбэк не должен вызываться повторно (движок промиса сам гарантирует игнорирование повторных вызовов, но лучше не полагаться).

## Комбинаторы: all, race, allSettled, any

Четыре статических метода с разной семантикой отказа:

```js
const urls = ['/api/a', '/api/b', '/api/broken'];

// Promise.all: ждём ВСЕ успешно; первая ошибка — весь all rejected
const all = await Promise.all(urls.map((u) => fetch(u).then((r) => r.json())));
// Получаем массив результатов в ИСХОДНОМ порядке, независимо от скорости.

// Promise.allSettled: ждём ВСЕ, ошибки не прерывают; результат — статусы
const settled = await Promise.allSettled(urls.map((u) => fetch(u)));
// [{status:'fulfilled', value:...}, {status:'rejected', reason:...}, ...]

// Promise.race: первый завершившийся (успех ИЛИ провал)
const fastest = await Promise.race([
  fetch('/api/data'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
]);
// Паттерн «гонка с таймаутом».

// Promise.any: первый УСПЕШНЫЙ; rejected только если ВСЕ упали
const any = await Promise.any(urls.map((u) => fetch(u)));
// Полезно для зеркал/CDN: берём первое ответившее зеркало.
```

| Комбинатор | Успех | Провал |
|---|---|---|
| `all` | Все fulfilled → массив значений по порядку | Первый reject |
| `allSettled` | Всегда → массив `{status, value/reason}` | Никогда (кроме синхронных багов) |
| `race` | Первый settled (любой) | Первый settled (если reject) |
| `any` | Первый fulfilled | Все reject → `AggregateError` |

Порядок в `all`/`allSettled` — порядок массива входных промисов, не скорость исполнения. Это позволяет делать деструктуризацию: `const [user, settings] = await Promise.all([...])`.

:::caution[all падает на первой ошибке — данные других запросов теряются)]
Если нужно «загрузить всё, что смогли», используй `allSettled` и фильтруй успешные. `all` — когда результат бессмысленен без полноты (например, страница дашборда).
:::

## Ошибки: catch, наконец-то, unhandled rejection

Цепочки без catch на конце — источник `unhandledrejection`. Браузер печатает его в консоль; в Node.js — это крэш процесса (по умолчанию). Гигиена: **каждая создаваемая цепочка имеет завершающий `.catch`**:

```js
async function loadDashboard() {
  try {
    const [user, stats] = await Promise.all([loadUser(), loadStats()]);
    render(user, stats);
  } catch (err) {
    // Один catch ловит ошибку любого из промисов
    showError(err);
  } finally {
    hideSpinner(); // finally в async — то же, что и finally синхронного
  }
}
```

Тонкость с `catch(onRejected)` в середине цепочки: он ловит только ошибки выше, но сам может бросить новую — она пойдёт в следующий catch, мимо предыдущего «успешного» then.

## Микрозадачи в промисах (повторение со смыслом)

Реакции `.then` — микрозадачи. Отсюда два практических следствия:

1. **Порядок:** несколько `.then` подряд выполнятся раньше любого `setTimeout` (см. главу про Event Loop).
2. **Отладка:** стек вызовов к моменту выполнения микрозадачи уже пуст — ошибка в `.then` не покажет, кто её поставил, по синхронному стеку.

Третье следствие реже упоминают, но оно самое интересное: **синхронный resolve тоже идёт через микрозадачу**. Даже если промис уже fulfilled на момент вызова `.then`, колбэк выполнится не сейчас, а после текущего синхронного кода:

```js
const p = Promise.resolve(42); // промис УЖЕ fulfilled

console.log('до then');
p.then((v) => console.log('then:', v));
console.log('после then');

// «до then» → «после then» → «then: 42»
// then всегда асинхронен, даже для готового промиса
```

Это гарантия спецификации: промисные реакции никогда не выполняются синхронно, внутри текущего стека. Благодаря этому неоднозначность «а вдруг колбэк вызвался раньше присваивания» исчезает: всегда есть как минимум один проход Event Loop между созданием промиса и его реакцией.

Побочный эффект для производительности: `await` в «горячем» коде (миллионы итераций) дороже прямого накопления промисов — каждый await ставит микрозадачу. В критичных местах (обработка потоков данных) предпочитают обычные then-цепочки или вообще колбэки; в бизнес-коде читаемость важнее.

## Async-стек трейсов

Классическая боль: ошибка внутри `.then` показывает стек только от точки взрыва, без истории «кто вызвал». Современный V8 (Node 12+, Chrome 73+) сохраняет **async stack traces**: стек включает цепочку await/then до самого корня async-функции:

```js
async function fetchUser() {
  const r = await fetch('/api/user/42');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function showProfile() {
  const user = await fetchUser();  // в стеке появится showProfile
  render(user);
}

showProfile().catch((err) => console.error(err.stack));
// Error: HTTP 500
//   at fetchUser (...)
//   at async showProfile (...) ← async-стек, без магии sourcemap
```

Условия: ошибка проброшена через `await`/`then` (а не через колбэки внутри `new Promise`), и нет разрыва цепочки через `.catch`, который «съел» ошибку молча. Длинные цепочки `.then` без async/await — стек обрывается на каждом шаге; отсюда ещё один аргумент писать async/await.

:::tip[Zero-cost async stack traces)]
В V8 сохранение async-стека почти бесплатно — механизм «zero-cost async stack traces» (V8 7.3+). Не экономь на читаемости логов: бросай осмысленные ошибки на каждом уровне.
:::

## then-цепочки против async/await: что выбрать

Обе конструкции эквивалентны по мощности — async/await буквально «синтаксический сахар» над then. Но стилистически они подходят для разного:

```js
// Цепочка уместна для коротких преобразований потока данных
const avatarUrl = await fetchUser(id)
  .then((u) => fetchAvatar(u.avatarId))
  .then((a) => a.url); // «конвейер»: каждый шаг — одно преобразование

// async/await уместен для ветвлений, циклов, try/catch с логикой
async function syncUser(id) {
  const user = await fetchUser(id);
  if (!user.confirmed) {
    await sendConfirmation(user);
    return { synced: false, sent: true };
  }
  const orders = await fetchOrders(user.id); // зависит от условия выше
  return { synced: true, count: orders.length };
}
```

Практические правила:

- **Ветвления и циклы** → async/await (в цепочке они выражаются косвенно и читаются плохо).
- **Короткий конвейер** «получил → преобразовал → вернул» → then-цепочка компактнее.
- **Параллельность внутри шага** → в цепочке нужен `Promise.all` вручную; в async/await тот же `Promise.all`, но вокруг — обычный код.
- **Обработка ошибок** → try/catch естественнее читается, чем `.catch` в середине цепочки.

Производительность: разницы для бизнес-кода нет. В экстремально горячем коде then-цепочки чуть предсказуее по аллокациям (async-функции создают несколько внутренних объектов на вызов), но это редкий случай, достойный оптимизации только после профилирования.

## Типичные ошибки и грабли

1. **Unhanded rejection.** Цепочка без `.catch` на конце. В Node — падение процесса. Лови везде, где создаёшь промисы.

2. **Забыть, что `then` возвращает новый промис.** «Порвать» цепочку — присвоить `p.then(...)` в переменную и ждать исходный `p`: результат реакции потерян.

3. **`.catch` рано — съесть ошибку, которую должна видеть внешняя логика.** Ставь catch близко к месту восстановления, не «на всякий случай» в начале цепочки.

4. **`Promise.all` с картой, которая бросает синхронно.** Ошибка в `.map`-колбэке до создания промисов — синхронный взрыв, не rejected промис. Оборачивай тело в `Promise.resolve().then(...)` или используй `allSettled`.

5. **Гонка `race` с таймаутом без очистки.** Таймер продолжает тикать после победы запроса — мелкая утечка; очищай `clearTimeout` в finally, или используй `AbortSignal.timeout` (следующая глава).

6. **Ожидать от `fetch` reject на 4xx/5xx.** См. выше — проверяй `response.ok`.

## Вопросы на собеседовании

1. **Сколько состояний у промиса и какие переходы возможны?**
   Три: pending, fulfilled, rejected. Только pending → (fulfilled | rejected), один раз, без возврата. Первый resolve/reject побеждает.
2. **Что возвращает `.then` и как обрабатывается возврат промиса из колбэка?**
   Новый промис. Возврат thenable вызывает flattening: цепочка ждёт его разрешения; бросок — reject нового промиса; отсутствие колбэка — проброс значения/ошибки.
3. **Разница `all`, `allSettled`, `race`, `any`?**
   Таблица выше: полнота против скорости, успех против первого settled.
4. **Как промисифицировать колбэковый API?**
   `new Promise((resolve, reject) => api(args, (err, res) => err ? reject(err) : resolve(res)))`; в Node — `util.promisify`.
5. **Что такое unhandled rejection и чем опасен в Node.js?**
   Отклонённый промис без обработчика. В браузере — консольное предупреждение, в Node — завершение процесса с кодом 1 по умолчанию.
6. **Почему ошибка в `.then` теряет контекст вызова и как это исправить?**
   Реакции — микрозадачи, синхронный стек уже пуст. Решение: async/await (V8 сохраняет async-стек), осмысленные сообщения ошибок, логирование на границах.

## Практика

1. Напиши `delay(ms)`: промис, резолвящийся через `ms`. Критерий: `await delay(100)` работает, повторный resolve игнорируется.
2. Реализуй `promisify(fn)` руками: принимает функцию вида `(args..., cb)` и возвращает промисную версию. Критерий: работает с `readFile`-подобными API, вызов cb дважды не ломает результат.
3. Напиши `timeout(promise, ms)`: возвращает промис с результатом входного или reject `TimeoutError` через `ms` (race-обёртка с очисткой таймера). Критерий: после успеха входного промиса таймер очищен (проверь через счётчик).
4. Реализуй `reflect(promise)`: возвращает промис, который никогда не rejected, а fulfilled с `{status:'fulfilled', value}` или `{status:'rejected', reason}`. Покажи, как на его основе собрать `allSettled` через `Promise.all`.
5. Напиши `retryWithBackoff(fn, {attempts, delay, factor})`: вызывает `fn`, при ошибке ждёт `delay`, потом `delay*factor` и т.д. Критерий: после исчерпания попыток — reject с последней ошибкой; успех на 2-й попытке не выполняет 3-ю.

## Что почитать

- [MDN: Promise](https://developer.mozilla.org/ru/docs/Web/JavaScript/Reference/Global_Objects/Promise)
- [MDN: Использование промисов](https://developer.mozilla.org/ru/docs/Web/JavaScript/Guide/Using_promises)
- [ECMA-262: Promise Objects](https://tc39.es/ecma262/#sec-promise-objects)
- [V8 Blog: Zero-cost async stack traces](https://v8.dev/blog/fast-async)
- [Promisees (интерактивная визуализация цепочек)](https://bevacqua.github.io/promisees/)
