---
title: "satisfies, as const, branded types и строгий tsconfig"
description: "satisfies против as, as const и readonly-вывод, брендированные типы для ID и денег, enum против as const, разбор strict-флагов tsconfig и типизация API-клиента с генерацией из OpenAPI и Prisma."
---

Первые три главы дали механику: типизация, дженерики, вычисления на уровне типов. Эта глава — чистая практика. Здесь собраны четыре приёма, которые отличают проект «с типами» от проекта «с типобезопасностью», плюс настройка компилятора и типизация границы с внешним миром — API-клиента.

В продакшене именно эти вещи ловят баги. Брендированный `UserId`, который нельзя перепутать с `OrderId`. `satisfies` в конфиге деплоя, который поймает опечатку в названии режима. `as const` в списке роутов, после которого IDE автодополняет только реальные пути. И tsconfig, который не даст твоему коллеге протащить `any` в ревью.

## satisfies против as

Оба оператора говорят компилятору «доверься мне», но по-разному. `as` — приведение: «считай это типом T и замолчи». Оно может расширять тип, сужать его и даже лгать (`as unknown as Target`). `satisfies` — проверка: «проверь, что это выражение совместимо с T, но сохрани его точный тип».

```ts
const config = {
  mode: 'production', // без аннотаций: { mode: string }
  workers: 4,
} satisfies Record<string, string | number>;

// config.mode: 'production' — литеральный тип сохранился!
// А опечатка в значении поймана: satisfies сравнивает с Record<string, string | number>
// и режим 'production' туда входит, а 'produciton' — тоже, оба string.
// Но union из допустимых режимов — уже другая история:

const strictConfig = {
  mode: 'production',
} satisfies { mode: 'production' | 'staging' | 'development' };
// 'produciton' — ошибка компиляции
```

Разница критична для объектов, где ты хочешь и проверку, и точный вывод:

```ts
// ПЛОХО: as расширит тип до string — потеряли точность
const modes = ['dev', 'prod'] as string[];

// ХОРОШО: satisfies проверит массивность, элементы останутся литералами
const routes = ['/', '/dashboard', '/settings'] as const satisfies readonly string[];
// readonly ['/', '/dashboard', '/settings'] — и проверено, и точно
```

`satisfies` особенно силён для конфигурационных объектов, которые сразу проверяются по схеме (часто — по типу из zod-схемы), но дальше используются с точными литеральными типами.

:::tip[Правило выбора]
Нужна проверка совместимости без потери точности — `satisfies`. Нужно сказать компилятору «я знаю больше» (бренды, DOM-элементы, результаты JSON.parse) — `as`. Если тянешься к `as` — спроси себя, нельзя ли заменить это на `satisfies` или предикат.
:::

## as const и readonly-вывод

`as const` — директива компилятору: «выведи из этого выражения максимально узкий readonly тип». Для литералов — литеральные типы, для массивов и объектов — `readonly` на все уровни:

```ts
const STATUS = {
  ok: 200,
  created: 201,
  notFound: 404,
} as const;
// { readonly ok: 200; readonly created: 201; readonly notFound: 404 }

const ROUTES = ['/', '/dashboard', '/settings'] as const;
// readonly ['/', '/dashboard', '/settings']

type StatusCode = (typeof STATUS)[keyof typeof STATUS]; // 200 | 201 | 404
type Route = (typeof ROUTES)[number]; // '/' | '/dashboard' | '/settings'
```

Паттерн «объект как const + выборка union» заменяет enum в большинстве сценариев. `Route` теперь тип, который нельзя нарушить: передать `'dashbord'` в функцию, принимающую `Route`, — ошибка компиляции.

При этом readonly-вывод — поверхностная подсказка: `as const` глубокий. Все вложенные массивы и объекты тоже становятся readonly, в отличие от `Readonly<T>`, который, как мы помним из прошлой главы, действует лишь на первый уровень.

## Branded types: типизация ID и денег

Структурная типизация говорит: `number` — это `number`. Но в домене `userId: 42` и `orderId: 42` — разные сущности, и их перепутать — баг. Branded types — паттерн, вводящий «искусственную» разницу на уровне типов без рантайм-стоимости:

```ts
// Бренд — фантомное свойство, существующее только в типах
type Brand<T, B> = T & { __brand: B };

type UserId = Brand<number, 'UserId'>;
type OrderId = Brand<number, 'OrderId'>;
type Email = Brand<string, 'Email'>;

declare const userId: UserId;
declare const orderId: OrderId;

function getUser(id: UserId): void { /* ... */ }

getUser(userId); // ок
getUser(orderId); // ошибка: OrderId ≠ UserId
getUser(42); // ошибка: number ≠ UserId

// Создание — только через фабрику с валидацией (или cast, где допустимо)
function createEmail(raw: string): Email {
  if (!raw.includes('@')) {
    throw new Error('Невалидный email');
  }
  return raw as Email; // здесь as оправдан: валидация уже в рантайме
}
```

Ключевой момент: бренд — только в типах. В рантайме это обычный `number`/`string`, никакой обёртки и накладных расходов. Платишь один раз при создании (валидация/каст), получаешь защиту на всём пути данных.

Для денег бренд работает вместе с дисциплиной хранения — минорные единицы (копейки/центы) в целых числах:

```ts
type MinorUnits = Brand<number, 'MinorUnits'>; // копейки
type MajorUnits = Brand<number, 'MajorUnits'>; // рубли

function rublesFromMinor(k: MinorUnits): MajorUnits {
  return (k / 100) as MajorUnits;
}

// price: MinorUnits + метод toDisplay() — и никогда не сложишь
// копейки с рублями молча
```

:::caution[Где бренды не нужны]
Не брендируй всё подряд. Бренд — для значений, которые пересекаются по типу примитива, но различаются по домену: ID сущностей, email, деньги, slug, пути. Для простых счётчиков и индексов это шум.
:::

## enum против as const

`enum` — рантайм-конструкция: генерирует объект с обратным маппингом числовых значений. Это неожиданные байты в бандле и сюрпризы при сериализации:

```ts
enum Status {
  Active,
  Banned,
}

// В рантайме Status — объект: { 0: 'Active', 1: 'Banned', Active: 0, Banned: 1 }
const s = JSON.stringify(Status.Active); // "0" — число, не строка!
```

С `as const` поведение предсказуемее: чистые литеральные типы, нулевой рантайм-код, сериализация — строки:

```ts
const STATUS = {
  Active: 'active',
  Banned: 'banned',
} as const;

type Status = (typeof STATUS)[keyof typeof STATUS]; // 'active' | 'banned'
const s = JSON.stringify(STATUS.Active); // "\"active\""
```

Когда enum всё же уместен: битовые флаги (`enum Flags { Read = 1, Write = 2 }`), когда нужен числовой маппинг для протокола, и легаси-интеграции. В новом коде по умолчанию — `as const`.

## Строгий tsconfig: разбор флагов

Типы работают, когда компилятор настроен строго. Вот боевой минимум с пояснением, что именно ловит каждый флаг:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true
  }
}
```

**`strict`** — мастер-выключатель, включающий: `noImplicitAny` (запрет неявного any — главный), `strictNullChecks` (null/undefined проверяются отдельно, а не совместимы со всем), `strictFunctionTypes` (контравариантность параметров), `strictBindCallApply`, `strictPropertyInitialization` (поля класса инициализируются или имеют дефолт), `noImplicitThis`, `alwaysStrict`.

**`noUncheckedIndexedAccess`** — гвоздь программы: индексация `arr[i]`, `obj[key]` даёт `T | undefined`. Без него TS врёт, что индекс всегда валиден. В проде это ловит целый класс рантайм-ошибок за счёт обязательных проверок:

```ts
declare const ports: number[];

// Без флага: number — ложь, может быть undefined
// С флагом: number | undefined — честно
const p = ports[10];
if (p !== undefined) {
  usePort(p);
}
```

**`exactOptionalPropertyTypes`** — различает `email?: string` и `email: string | undefined`. При включении передавать явный `undefined` в опциональное поле — ошибка. Ломает часть старых библиотек, на новых проектах — включать сразу.

**`noImplicitOverride`** — метод, перекрывающий родительский, обязан иметь ключевое слово `override`. Защита от случайной перезаписи при рефакторинге иерархий.

**`noFallthroughCasesInSwitch`** — запрет проваливания между case без `break`/`return`. Дублирует `assertNever`-паттерн для дискриминированных union-ов.

**`noPropertyAccessFromIndexSignature`** — обращение к свойствам, описанным индексной сигнатурой, только через квадратные скобки: `obj['key']`, не `obj.key`. Отделяет «задокументированные» поля от «любых строк».

:::caution[Включение на легаси]
`noUncheckedIndexedAccess` на старом коде может выдать сотни ошибок. Стратегия: включить в отдельной ветке, пройти по файлам, чинить проверками на undefined; где критично и безопасно — локальный `!` с комментарием. Зафиксируй в отчёте, сколько реальных потенциальных багов нашёл флаг — это сильный аргумент в пользу строгости.
:::

## Типизация API-клиента и генерация из OpenAPI/Prisma

Типы — это контракт. На границе с внешним миром (HTTP API, БД) контракт лучше не писать руками, а генерировать из источника правды.

### Ручной типобезопасный клиент

Перед генерацией — пойми механику. Дженерик-клиент, выводящий тип ответа из пути:

```ts
// Контракт эндпоинтов: путь → параметры + ответ
interface Endpoints {
  '/users': { params: { page?: number }; response: UserList };
  '/users/:id': { params: { id: number }; response: User };
}

async function apiGet<P extends keyof Endpoints>(
  path: P,
  params: Endpoints[P]['params'],
): Promise<Endpoints[P]['response']> {
  const url =
    path.replace(':id', String((params as { id?: number }).id ?? '')) +
    ('page' in params ? `?page=${params.page}` : '');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Endpoints[P]['response'];
}

const users = await apiGet('/users', { page: 1 }); // UserList
const user = await apiGet('/users/:id', { id: 42 }); // User
// await apiGet('/usres', {}); — опечатка в пути: ошибка компиляции
```

Типы здесь проверяют путь, параметры и возвращаемое значение. Но помни: типы исчезают при компиляции. Рантайм-данные могут быть чем угодно — поэтому в проде поверх ответа валидируют схемой (zod) или доверяют генерации из OpenAPI.

### Генерация из OpenAPI

OpenAPI-схема (Swagger) — описание эндпоинтов, параметров и схем ответов. Генератор создаёт типы из этой схемы:

```bash
# Установка и генерация типов в types/api.d.ts
npm install -D openapi-typescript
npx openapi-typescript https://api.example.com/openapi.json -o src/types/api.d.ts
```

Получаешь типы `paths['/users']['get']['responses']['200']['content']['application/json']` — точные ответы по каждому пути и методу. Ошибка 400/500 тоже типизирована. Обновление схемы на сервере → перегенерация → клиент сразу видит изменения контракта.

### Генерация из Prisma

Prisma — ORM, где схема БД — источник правды. Генератор типов создаёт клиент с точными типами моделей:

```prisma
// schema.prisma
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  posts Post[]
}
```

```bash
npx prisma generate
```

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const user = await prisma.user.findUnique({
  where: { id: 1 },
  include: { posts: true },
});
// user: { id: number; email: string; posts: Post[] } | null — вывод точный,
// включая include-ассоциации; изменение схемы → ошибки компиляции в запросах
```

Миграция, добавившая поле в `User`, немедленно ломает все места, где это поле не обрабатывается. Это и есть типобезопасность на границе с данными.

## Типичные ошибки и грабли

**1. `as` вместо валидации на границе.**

```ts
const data = JSON.parse(await res.text()) as User;
// Компилятор доволен. Рантайм получает любой мусор.
```

Защита: zod-схема с `z.infer` для типа, или генерация из OpenAPI + валидация ответов в dev-режиме.

**2. Бренд через `as` без валидации.**

`raw as Email` в любой точке кода обнуляет смысл бренда. Бренд — только через фабрику с проверкой (createEmail) или на границе после валидации схемой. Иначе через полгода `as UserId` размножится по коду, как раньше размножался `any`.

**3. `as const` на мутабельном конфиге.**

```ts
const config = { retries: 3 } as const;
config.retries = 5; // ошибка — забыли, что as const замораживает
```

`as const` — для констант. Для изменяемого конфига — отдельный интерфейс и `satisfies`.

**4. enum в API-контракте.**

Числовой enum сериализуется числом, а при десериализации JSON — остаётся числом. Если сервер ждёт строку `'active'`, а клиент шлёт `0` — молчаливая поломка. Для API — строковые литералы из `as const`.

**5. Отключение strict-флагов «временно».**

`// @ts-ignore` и `strict: false` «на время миграции» живут годами. Правило: каждое отключение — с комментарием и тикетом; `strict: false` не коммитить в main.

**6. Дублирование типов сервера и клиента руками.**

Ручные `interface User` на фронте и бэке рассинхронизируются. Источник правды — один: OpenAPI для HTTP, Prisma для БД, общий пакет типов в монорепо.

## Вопросы на собеседовании

**1. Чем `satisfies` отличается от `as`?**

`satisfies` проверяет совместимость выражения с типом, сохраняя точный выведенный тип выражения; `as` — приведение, которое может расширять/сужать тип и отключает проверку на несовместимость. `satisfies` для проверки конфигов и литералов без потери литеральности; `as` — когда программист реально знает лучше компилятора (бренды, DOM, JSON.parse после валидации).

**2. Что делает `as const` на уровне типов?**

Выводит максимально узкий readonly-тип: литералы вместо примитивов, readonly-модификаторы на всех уровнях вложенности. Результат можно индексировать для получения union литералов: `(typeof CONST)[keyof typeof CONST]`.

**3. Как устроены branded types и почему это ноль в рантайме?**

Пересечение примитива с фантомным свойством: `type Email = string & { __brand: 'Email' }`. Свойство не существует в рантайме — только в типах, поэтому значение остаётся обычной строкой. Создание — через фабрику с валидацией и единственный `as` внутри неё.

**4. Когда enum уместен, а когда лучше as const?**

enum — для битовых флагов и числовых протоколов; в остальном `as const` предпочтительнее: ноль рантайм-кода, предсказуемая сериализация, типы-литералы. Строковый enum и `as const` почти эквивалентны по типам, но enum добавляет объект в бандл.

**5. Что ловит `noUncheckedIndexedAccess`?**

Индексный доступ (`arr[i]`, `obj[key]`, `Map.get`) даёт `T | undefined` вместо `T`, заставляя проверять наличие перед использованием. Ловит выход за границы массива, отсутствие ключей в словарях, пустые результаты Map — целый класс рантайм-ошибок.

**6. Как типизировать API-клиент без дублирования контракта?**

Генерация из OpenAPI (openapi-typescript) — типы путей, параметров, ответов по каждому методу. Внутри — дженерик-клиент с `Endpoints`-мапой, выводящий тип по ключу пути. Для БД — Prisma generate. Ручные интерфейсы только для внутренних структур, не контрактов.

**7. Чем `exactOptionalPropertyTypes` меняет семантику `?`?**

Различает «поле отсутствует» и «поле есть, но значение undefined». При включении `obj.key = undefined` для `key?: string` — ошибка; нужен явный union `string | undefined`. Ловит лишние `undefined` в API-пейлоадах и конфигах.

## Практика

1. Возьми конфиг деплоя из своего проекта (порты, хосты, фича-флаги) и перепиши его через `satisfies` по интерфейсу с union-литералами для среды (`'dev' | 'staging' | 'prod'`); добавь опечатку в среду и убедись, что она поймана.
2. Внедри branded types: `UserId`, `OrderId`, `MinorUnits` (копейки) с фабриками валидации. Рефактори функцию `transfer(fromId, toId, amount)`, где раньше шли три `number`, — убедись, что перестановка аргументов теперь невозможна.
3. Включи в своём проекте `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`; пройди по всем ошибкам, чиня проверками на undefined и корректными опциональными полями. Запиши в отчёт: сколько мест было потенциально опасным.
4. Сгенерируй типы из любого публичного OpenAPI (GitHub, Petstore): установи `openapi-typescript`, скачай схему, сгенерируй типы и напиши `apiGet` из примера, проверив автодополнение путей и типов ответов.
5. Замени числовой enum статусов на объект с `as const` и union-тип; проверь сериализацию в JSON до и после — зафиксируй разницу.

Критерий результата: ни одного `as` вне фабрик брендов и границ с валидацией; включены `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; клиент API выводит типы без ручных дублирующих интерфейсов.

## Что почитать

- [TypeScript 4.9 Release Notes — satisfies](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html) — официальное введение оператора.
- [TypeScript Handbook: Enums](https://www.typescriptlang.org/docs/handbook/enums.html) и [TypeScript ESLint: no-enum](https://typescript-eslint.io/rules/no-enum/) — аргументы за и против.
- [Total TypeScript — Branded Types](https://www.totaltypescript.com/branded-types) — паттерн в деталях, включая вывод брендов из схем.
- [openapi-typescript](https://openapi-ts.dev/) — генерация типов из OpenAPI с примерами.
- [Prisma Client — type safety](https://www.prisma.io/docs/orm/prisma-client/type-safety) — как устроен генератор типов Prisma.
