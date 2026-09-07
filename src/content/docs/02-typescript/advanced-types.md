---
title: "Условные и mapped-типы, keyof и утилиты"
description: "Условные типы и дистрибутивность, mapped types с модификаторами as/?/+readonly, keyof, template literal types и внутреннее устройство Partial, Pick, Omit, Record, ReturnType, Parameters, Awaited."
---

Дженерики из прошлой главы — это переменные. Теперь берём переменные и строим из них **вычисления на уровне типов**: условные типы как if, mapped-типы как цикл по ключам, template literal types как интерполяция строк. Это тот момент, когда TypeScript перестаёт быть «аннотациями» и становится языком метапрограммирования, в котором ты пишешь код, исполняемый компилятором во время проверки.

В краткой версии ты уже видел `Nullable<T>`, `Unwrap<T>` и встроенные утилиты. Здесь откроем капот: как именно устроены `Partial` и `Pick`, почему `Partial` «съедает» методы объекта, как работает `as` внутри mapped-типа для переписывания ключей, и когда условный тип распределяется по union, а когда — нет.

## Условные типы: if на уровне типов

Условный тип — это `T extends U ? X : Y`, вычисляемый компилятором при каждой инстанциации:

```ts
// Наш любимый пример из главы про дженерики
type Unwrap<T> = T extends Array<infer U> ? U : T;

type A = Unwrap<number[]>; // number
type B = Unwrap<string>; // string
```

`extends` здесь означает «совместимо ли T с U» в структурном смысле. Если да — результат `X`, иначе `Y`. С `infer` в правой части это превращается в сопоставление с образцом.

### Дистрибутивность — главная ловушка

Если `T` в левой части `extends` стоит «голым» (просто параметр), а правый аргумент — union, условный тип **распределяется** по каждому элементу:

```ts
type ToArray<T> = T extends unknown ? T[] : never;

type A = ToArray<string>; // string[]
type B = ToArray<string | number>; // string[] | number[] — распределилось!
```

Без дистрибутивности получилось бы `(string | number)[]` — один массив смешанного типа. Чтобы отключить распределение, оберни `T` в кортеж:

```ts
type ToArrayNonDist<T> = [T] extends [unknown] ? T[] : never;

type C = ToArrayNonDist<string | number>; // (string | number)[]
```

Дистрибутивность — поведение по умолчанию именно для голого параметра типа. Внутри более сложных выражений (например, `Array<T> extends ...`) она не работает. Запомни этот факт — половина «магии» в чужих типах объясняется именно распределением по union. Официальный разбор — в [TypeScript Handbook: Conditional Types, раздел distributive conditional types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html#distributive-conditional-types).

:::note[Реальный пример дистрибутивности]
Паттерн `T extends unknown ? ...` — способ применить mapped- или условный тип к каждому элементу union по отдельности. То же самое делает встроенный `Exclude<T, U>`: он распределяет `T` и отбрасывает ветки, совместимые с `U`.
:::

### never: «пустая ветка» условного типа

Когда ни одна ветка не подходит, результат — `never`. Это позволяет фильтровать union:

```ts
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;

type All = 'a' | 'b' | 'c' | 42;
type Letters = Exclude<All, number>; // 'a' | 'b' | 'c'
type OnlyC = Extract<All, 'c'>; // 'c'
```

`never` в union «растворяется»: `string | never` = `string`. Поэтому отброшенные ветки просто исчезают из результата.

## keyof и индексные типы

`keyof T` — union всех ключей объекта (строки, числа, символы). В комбинации с дженериком — основа всех типобезопасных утилит:

```ts
interface Server {
  host: string;
  port: number;
  tls: boolean;
}

type Keys = keyof Server; // 'host' | 'port' | 'tls'

// Индексный доступ: тип значения по ключу
type HostType = Server['host']; // string
type AllTypes = Server[keyof Server]; // string | number | boolean — union всех значений
```

`Server[keyof Server]` — мощный приём: union всех типов значений объекта. Им пользуются валидаторы и мапперы, чтобы сказать «любое значение из этого объекта».

Для массивов `keyof` даёт числовые ключи и методы, поэтому работай с `keyof` осторожно на коллекциях. Для фильтрации «только данных» существуют приёмы с mapped-типами, см. ниже.

## Mapped types: цикл по ключам

Mapped-тип перебирает ключи и строит новый объект. Синтаксис — `in` по union ключей. Вся механика модификаторов и key remapping описана в [TypeScript Handbook: Mapped Types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html):

```ts
type Nullable<T> = { [K in keyof T]: T[K] | null };

interface Config {
  host: string;
  port: number;
}

type NullableConfig = Nullable<Config>;
// { host: string | null; port: number | null }
```

`keyof T` разворачивается в union ключей, `in` идёт по каждому, `T[K]` — индексный доступ к типу значения. Это цикл, результат — объект.

### Модификаторы: ?, readonly, + и -

Mapped-типы могут добавлять или убирать модификаторы у каждого свойства:

```ts
type Partial2<T> = { [K in keyof T]?: T[K] }; // добавить ?
type Required2<T> = { [K in keyof T]-?: T[K] }; // убрать ? (-?)

type Readonly2<T> = { readonly [K in keyof T]: T[K] }; // добавить readonly
type Mutable2<T> = { -readonly [K in keyof T]: T[K] }; // убрать readonly (-)
```

`-?` — «минус опциональность», применяется и к явным `undefined` в значении. `-readonly` снимает защиту от записи. Плюс можно явно писать (`+?`, `+readonly`), но он подразумевается по умолчанию.

:::caution[Мелкие модификаторы — поверхностные]
`Readonly<T>` и `Partial<T>` действуют только на первый уровень. Вложенные объекты остаются изменяемыми и полными. Для глубоких версий нужна рекурсия — это задание из практики в конце главы.
:::

### Переписывание ключей через as

Самая мощная возможность mapped-типов — переписать ключи через `as`:

```ts
// Ключи-геттеры: getHost, getPort, ...
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type ServerGetters = Getters<Server>;
// { getHost: () => string; getPort: () => number; getTls: () => boolean }

// Фильтрация ключей: убрать всё, начинающееся с underscore
type Public<T> = {
  [K in keyof T as K extends `_${string}` ? never : K]: T[K];
};

interface Internal {
  id: number;
  _secret: string;
  name: string;
}

type PublicOnly = Public<Internal>; // { id: number; name: string }
```

В выражении `as` можно: применять template literal types (см. ниже), использовать условные типы для отсева (`? never : K` — ключ исчезает), преобразовывать регистр. Это закрывает 90% задач «мне нужен тип, как X, но с другими ключами/фильтром».

## Template literal types

Типы-строки, построенные интерполяцией — на уровне типов. Строковые утилиты (`Capitalize`, `Uppercase` и друзья) и ограничения интерполяции рассмотрены в [TypeScript Handbook: Template Literal Types](https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html):

```ts
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Endpoint = `/${string}`;
type Route = `${Method} ${Endpoint}`; // 'GET /users' | 'POST /users' | ...

// Утилиты для строк в типах: Capitalize, Uppercase, Lowercase, Uncapitalize
type EventName = 'click' | 'focus';
type HandlerName = `on${Capitalize<EventName>}`; // 'onClick' | 'onFocus'
```

Их сила — в комбинации с mapped-типами и `as`. Паттерн «роуты API как union литералов»:

```ts
const routes = ['/users', '/users/:id', '/health'] as const;
type Route = (typeof routes)[number]; // union литералов

// И типобезопасный объект обработчиков ровно под эти пути
type Handlers = { [K in Route]: (req: Request) => Response };
```

Плюс `as const` и mapped-тип — и у тебя объект, в который нельзя записать обработчик для несуществующего пути. Об этом подробнее в следующей главе.

## Утилиты: внутреннее устройство

Все встроенные утилиты — обычные типы в `lib.d.ts`, написанные на том же синтаксисе. Открой их определение в IDE (Ctrl+клик) — и они перестанут быть магией.

### Partial и Required

```ts
// Реальное определение из lib.d.ts:
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
```

Просто mapped-тип с модификатором опциональности. `Partial` — для черновиков, форм, патчей; `Required` — когда из API пришло «всё может отсутствовать», а бизнес-логике нужны гарантии.

### Pick и Omit

```ts
// Реальное определение:
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
```

`Pick` — mapped-тип по подмножеству ключей. Ограничение `K extends keyof T` делает второй параметр типобезопасным: передать несуществующий ключ — ошибка. `Omit` — через комбинацию `Pick` и `Exclude`: исключаем ключи из union и забираем остаток.

```ts
interface User {
  id: number;
  name: string;
  email: string;
  passwordHash: string;
}

type PublicUser = Omit<User, 'passwordHash'>; // для ответа API
type UserPreview = Pick<User, 'id' | 'name'>; // для списка

// Попытка Omit<User, 'passwrd'> — ошибка: опечатка поймана сразу
```

### Record

```ts
// Реальное определение:
type Record<K extends keyof any, T> = { [P in K]: T };
```

Словарь: ключ из `K`, значение `T`. Ограничение `keyof any` = `string | number | symbol`. Классика — мапа сущностей по ID и словари переводов:

```ts
type UsersById = Record<number, User>;
type LocaleMessages = Record<'en' | 'ru', { welcome: string }>;
```

### ReturnType и Parameters

```ts
// Реальное определение:
type ReturnType<T extends (...args: any) => any> =
  T extends (...args: any) => infer R ? R : any;
type Parameters<T extends (...args: any) => any> =
  T extends (...args: infer P) => any ? P : never;
```

Условный тип с `infer` на типе функции. Ограничение отсекает всё, что не функция. Практика — синхронизация типов без дублирования:

```ts
async function fetchUser(id: number): Promise<User> {
  /* ... */
}

type FetchUserReturn = ReturnType<typeof fetchUser>; // Promise<User>
type FetchUserArgs = Parameters<typeof fetchUser>; // [id: number]

// Тип handler под функцию — аргументы совпадут автоматически
type Handler<F extends (...args: never[]) => unknown> =
  (result: Awaited<ReturnType<F>>) => void;
```

### Awaited

```ts
// Упрощённое определение:
type Awaited<T> = T extends null | undefined
  ? T
  : T extends object & { then(onfulfilled: infer F): unknown }
    ? F extends (value: infer V) => unknown
      ? Awaited<V>
      : never
    : T;
```

Разбор на части: если `T` — thenable (объект с методом `then`), вытаскиваем тип значения колбэка `onfulfilled` и **рекурсивно** ждём его — поэтому `Awaited<Promise<Promise<number>>>` даёт `number`, а не `Promise<number>`. Если не thenable — возвращаем как есть. Это тот самый тип, который использует `async/await` под капотом при выводе возвращаемого значения.

:::tip[Чтение lib.d.ts — лучшее упражнение]
Бери любой встроенный тип, Ctrl+клик, читай определение. Всё построено из конструкций этой главы: mapped, conditional, infer, keyof. Через десяток таких разборов ты сможешь читать типы из любой библиотеки.
:::

## Типичные ошибки и грабли

**1. Ожидание глубокости от Partial/Readonly.**

```ts
interface State {
  user: { name: string };
}

const draft: Partial<State> = {};
// draft.user?.name = 'x'; — нельзя: Partial только верхний уровень,
// user остался { name: string }, просто опциональным
```

Решение — `DeepPartial<T>` через рекурсию (практика).

**2. Путаница с дистрибутивностью.**

```ts
type Wrap<T> = T extends any ? [T] : never;
type A = Wrap<string | number>; // [string] | [number]
```

Если нужен один кортеж от всего union — оберни обе стороны: `[T] extends [any] ? [T] : never` даст `[string | number]`.

**3. keyof по union или any.**

`keyof any` — `string | number | symbol`, не конкретные ключи. `keyof (A | B)` — пересечение ключей. Если keyof «не работает» — проверь, не union ли у тебя вместо объекта.

**4. Omit с опечаткой в ключе.**

```ts
type X = Omit<User, 'pasword'>; // ошибка? Нет — Omit принимает любой keyof T...
```

Ой. В точном определении `Omit<T, K extends keyof T>` — опечатка `'pasword'` действительно ошибка. Но если обернуть в свой алиас без ограничения — нет. Проверяй, что в проекте используется настоящий `Omit`.

**5. Template literal types на non-literal union.**

```ts
type K = string;
type T = `get${K}`; // просто string — растворился литерал
```

Если `K` — `string`, интерполяция не создаёт бесконечный union, а коллапсирует в `string`. Работает только с литеральными union.

**6. Переусердствование с типами.**

Не пиши тип, который проще заменить явным интерфейсом. Сложные conditional/mapped — для библиотек и обобщённых обвязок. В прикладном коде простой `interface` читается лучше десяти вложенных infer.

## Вопросы на собеседовании

**1. Чем отличается `Partial<T>` от `{ [K in keyof T]?: T[K] }`?**

Ничем — это его точное определение из lib.d.ts. Вопрос проверяет, заглядывал ли ты в исходники встроенных типов. То же с `Required` (`-?`) и `Pick` (mapped по подмножеству ключей).

**2. Что такое дистрибутивность условных типов и как её отключить?**

Для «голого» параметра типа в левой части extends условный тип применяется к каждому элементу union отдельно, а результат объединяется. Отключить — обернуть обе стороны в кортежи: `[T] extends [U]`. Это даёт поведение «всего union как единого значения».

**3. Как устроен `Record` и чем он отличается от объекта с индексной сигнатурой?**

`Record<K, T>` = mapped-тип `{ [P in K]: T }` с ограничением `K extends keyof any`. Практически эквивалентен `{ [key in K]: T }`. Отличие от `{ [key: string]: T }`: Record требует конкретный union ключей, индексная сигнатура допускает любую строку.

**4. Как работает `Omit` внутри?**

`Pick<T, Exclude<keyof T, K>>`: из union всех ключей `keyof T` исключаем `K` через дистрибутивный `Exclude` (условный тип, возвращающий `never` для совпадений), остаток передаём в `Pick`. Отсюда и ограничение `K extends keyof T` — иначе `Exclude` просто вернёт `keyof T` без изменений.

**5. Что делает `Awaited` и почему он рекурсивен?**

Извлекает тип значения из thenable/Promise, рекурсивно применяя себя к результату — чтобы схлопнуть `Promise<Promise<T>>` в `T`. Рекурсия нужна, потому что `await` во вложенных промисах разворачивает все уровни, и тип должен повторять это поведение.

**6. Что такое `as` в mapped-типах и для чего фильтровать ключи через never?**

`as` переписывает ключ: `[K in keyof T as NewKey]: ...`. Если `NewKey` вычисляется в `never`, свойство исчезает из результата — это способ фильтрации (убрать приватные ключи, переименовать по шаблону).

**7. Когда условный тип не дистрибутивен?**

Когда параметр не «голый»: стоит внутри другой конструкции — `Array<T> extends ...`, `{ x: T } extends ...`, или обёрнут в кортеж `[T] extends [U]`. Тогда `T` рассматривается как единое значение.

## Практика

1. Реализуй `DeepReadonly<T>`: рекурсивно делает все вложенные объекты и массивы readonly. Проверь на `{ a: { b: number[] } }` — вложенный массив тоже должен стать `readonly number[]`.
2. Напиши `FlattenKeys<T>`: из `{ a: { b: { c: number } } }` делает `{ 'a.b.c': number }`. Подсказка: mapped-тип с `as` для конкатенации ключей и рекурсия на вложенных объектах.
3. Собери `RequireKeys<T, K>` — `Pick` по обязательным ключам + `Partial` остального, но так, чтобы ключи `K` были `-?`, а остальные остались опциональными.
4. Возьми тип `typeof fetchUser` из примера и построй `Handler` через `ReturnType`/`Parameters`, затем типизируй обёртку `withLogging(fn)` без единой явной аннотации аргументов.
5. Напиши `UnionToIntersection<U>` через условный тип с `infer` в позиции функции (подсказка: `(U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never`). Разбери, почему это работает.

Критерий результата: каждый тип компилируется, проверяется на примерах с `// ^?` или явными алиасами, вложенные структуры обрабатываются рекурсивно, нет `any` в реализации.

## Что почитать

- [TypeScript Handbook: Mapped Types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html) — модификаторы и key remapping.
- [TypeScript Handbook: Conditional Types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html) — infer, дистрибутивность.
- [TypeScript Handbook: Template Literal Types](https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html) — интерполяция и утилиты для строк.
- [Type Challenges](https://github.com/type-challenges/type-challenges) — сотни задач на уровне типов, от easy до hell.
- [TypeScript lib.d.ts на GitHub](https://github.com/microsoft/TypeScript/blob/main/lib/lib.es5.d.ts) — первоисточник всех встроенных утилит.
