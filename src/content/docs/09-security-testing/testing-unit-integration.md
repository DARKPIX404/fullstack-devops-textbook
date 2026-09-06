---
title: "Unit и интеграционные тесты: пирамида, Vitest и Testcontainers"
description: "Философия тестирования и пирамида, AAA-паттерн, полный конфиг Vitest, моки vi.fn и vi.mock, coverage-пороги и их пределы, Supertest, Testcontainers с PostgreSQL и Redis, изоляция тестов и фабрики данных."
---

Краткая версия дала тебе запускаемый скелет: Vitest с порогами coverage, пара unit-тестов, Supertest и один Testcontainers-пример. Этого хватает, чтобы тесты бежали, но не хватает, чтобы ответить на вопросы, которые решает зрелая тестовая инфраструктура: почему 100% coverage не остановил баг на проде? Где граница между unit и интеграционным тестом — и что именно мокать? Как сделать так, чтобы 500 интеграционных тестов не мешали друг другу через общую базу? Эта глава — про инженерную сторону тестирования: паттерны, изоляцию, фабрики данных и матрицу, по которой видно, чего в системе вообще не проверяют.

## Философия: зачем тесты и почему пирамида

Тест — это исполняемая спецификация поведения. Его главный потребитель — не CI, а ты через три месяца, во время рефакторинга: зелёный прогон означает «контракт сохранён», красный — «вот поведение, которое ты сломал, заодно пример использования». Тесты, написанные ради процента coverage, этого не дают — они тестируют код, а не поведение.

Пирамида тестов — распределение по уровням:

```
        ╱  E2E (мало,    ╲   дорогие, медленные,  ~5% — критические пути
       ╱   интеграционные  ╲  Supertest + Testcontainers, ~20% — границы
      ╱   unit (много)      ╲ чистые функции, моки, ~75% — бизнес-логика
```

Логика проста: чем выше по пирамиде, тем дороже тест (поднимается больше инфраструктуры) и тем хуже диагностика (падает через пять слоёв — причина где-то внутри). Бизнес-логика живёт внизу, быстро и точно; границы системы (HTTP, БД) проверяются интеграционными; пользовательские сценарии — E2E в следующей главе. Тестировщик-самоучка ошибается в обе стороны: тестирует приватные методы класса через рефлексию (тесты знают слишком много и ломаются при любом рефакторинге) или гоняет всё через браузер (пирамида перевернута — часы на прогон и визг при каждом чихе).

:::tip[Правило пальца]
Новая бизнес-фича = unit-тесты на доменную логику + один интеграционный тест «вход → БД → выход». E2E — только если фича на деньгах пользователя (оплата, регистрация, главный сценарий).
:::

## AAA-паттерн

Хороший unit-тест читается как предложение из трёх частей:

```ts
// Arrange — готовим мир: входные данные, зависимости
const cart = [{ sku: 'BOOK-1', price: 500, qty: 2 }];

// Act — один вызов тестируемого поведения
const total = calcTotal(cart, promoCode);

// Assert — проверяем один наблюдаемый эффект
expect(total).toBe(900); // 500*2*0.9 (промокод SALE10)
```

Один тест — одно поведение. Пять ассертов про один вызов — нормально; пять вызовов и пять групп ассертов — это пять тестов, притворяющихся одним: упадёт он один раз, а виноватых найдёшь час. Arrange, который разросся до 20 строк, выноси в фабрику или `beforeEach` — но следи, чтобы `beforeEach` не превратился в скрытый контекст, который читатель теста не видит.

## Vitest: полный конфиг

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    globals: false, // явные импорты: describe/it/expect — поиск по коду работает
    setupFiles: ['./tests/setup.ts'], // моки таймеров/переменных окружения
    include: ['src/**/*.spec.ts', 'tests/**/*.int-spec.ts'],
    testTimeout: 10_000,
    pool: 'forks', // изоляция: один упавший процесс не тащит за собой остальных
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
        // порог только на домен — UI/сборку не мучаем
        './src/domain/**': { branches: 85, functions: 90 },
      },
      exclude: [
        'src/main.ts', '**/*.module.ts', 'src/generated/**',
        '**/*.d.ts', 'tests/**',
      ],
    },
  },
});
```

```ts
// tests/setup.ts — окружение для каждого файла тестов
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-at-least-32-bytes-long!';
```

Обрати внимание на per-path пороги: требовать 85% от автогенерированного кода — значит заставлять людей писать бессмысленные тесты, а доменную логику оставлять без присмотра. Пороги — не цель, а сигнал «ниже этой планки сюда страшно смотреть ревьюеру».

## Моки: глубина и инструменты

Мокай **границу мира**: сеть, файловую систему, часы, случайность. Не мокай то, что принадлежит твоему коду, — иначе тест проверяет мок, а не код.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendWelcomeEmail } from './notifier';
import { registerUser } from './registration';
import * as mailer from './mailer';

// vi.fn — шпион-функция: запоминает вызовы, подменяет поведение
const sendMail = vi.fn().mockResolvedValue({ id: 'msg-1' });

// vi.mock — подмена целого модуля для всех импортов в файле (хоистится)
vi.mock('./mailer', () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

// vi.spyOn — точечная подмена метода существующего объекта,
// остальное поведение объекта сохраняется
const spy = vi.spyOn(mailer, 'sendMail').mockResolvedValue({ id: 'msg-2' });

// вижу, как звали, чем и сколько раз:
expect(spy).toHaveBeenCalledWith('iva@example.com', expect.stringContaining('добро пожаловать'));
expect(spy).toHaveBeenCalledTimes(1);
spy.mockRestore(); // вернуть оригинал — чтобы не течь между тестами

// таймеры и время
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
// ... код, который смотрит на Date.now / setTimeout
vi.useRealTimers();
```

`vi.mock` с `importOriginal` — когда нужно подменить кусок модуля, оставив остальное: `vi.mock('./db', async (importOriginal) => ({ ...(await importOriginal()), query: fakeQuery }))`. Порядок разрешения: `vi.mock` хоистится выше импортов — поэтому фабрика должна быть самодостаточной и не ссылаться на переменные из замыкания (отсюда паттерн с верхнеуровневым `sendMail`).

:::tip[Читай моки как контракты]
Перегруженный мок, повторяющий логику реального сервиса («если аргумент такой-то, верни то-то»), — это скрытая копия продакшен-кода в тестах: разойдётся с реальностью и тест будет проверять мир, которого нет. Хороший мок тупой и предсказуемый: принял вызов, вернул фиксированный ответ. Вся мудрость — в ассертах, а не в фейке.
:::

## Чистые функции против классов

Тестопригодность различается на порядок:

- **Чистая функция** (вход → выход, без состояния): тест — это одна строка `expect`. Идеал для доменной логики.
- **Класс с зависимостями через конструктор** (DI): тоже нормально — передаёшь моки конструктором, тестируешь публичный контракт. Не тестируй приватные методы: они — деталь реализации, иначе любой рефакторинг класса превращается в переписывание тестов.
- **Класс, сам тянущий зависимости** (`new Database()` внутри): тест превращается в цирк с `Rewire`/proxyquire. Если встретил — это сигнал рефакторить код, а не изощряться в тестах.

```ts
// тестируем через публичный контракт, зависимости — снаружи
class PricingService {
  constructor(private readonly promoRepo: PromoRepository) {}

  price(cart: Cart): Money {
    const promo = this.promoRepo.activeFor(cart.userId);
    return cart.items.reduce((sum, i) => sum.plus(i.price.times(i.qty)), Money.zero())
      .times(promo?.factor ?? 1);
  }
}

// в тесте: fake-репозиторий на vi.fn(), никакой БД
const promoRepo = { activeFor: vi.fn().mockReturnValue({ factor: 0.9 }) };
const service = new PricingService(promoRepo);
```

## Coverage: пороги и что они не гарантируют

Coverage отвечает на один вопрос: «выполнялась ли эта строка хотя бы раз». Из него следует ровно одно — «этот код не падает на пути, который прошёл тест». Он не отвечает: «проверили ли мы результат», «были ли ассерты осмысленными», «покрыли ли мы все комбинации ввода».

```ts
it('работает', () => {
  service.price(cart); // строки выполнились, coverage вырос
  // ни одного expect — тест ничего не проверяет
});
```

Мутационное тестирование (Stryker) закрывает дыру методично: оно мутирует код (`>` на `<`, `&&` на `||`) и проверяет, падает ли тест. Живучий мутант = тест, который его не заметил. На доменном ядре это бесценно; на всём проекте — дорого, ограничь 2–3 критичными модулями.

:::caution[Пороги — это флуд-контроль, а не цель]
Порог 80% удерживает команду от обвала, но не гарантирует качества. Плохая метрика, нацеленная на процент, порождает тесты «прощупыванием» — вызвал всё, ничего не проверил. Ревьюеру смотреть на смысл ассертов, а CI — на пороги: это разные стражи.
:::

## Интеграционные тесты: Supertest полный цикл

Unit-тесты проверяют логику; интеграционные — контракт системы: роутинг, валидация границы, сериализация, коды статусов, реальные SQL-запросы.

```ts
// src/users/users.int-spec.ts
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app';
import { startTestDb, stopTestDb, cleanDb } from '../../tests/db';
import { createUser } from '../../tests/factories';
import type { PrismaClient } from '@prisma/client';

describe('PATCH /api/users/:id', () => {
  let app: Express;
  let prisma: PrismaClient;
  let alice: User;
  let aliceToken: string;

  beforeAll(async () => {
    prisma = await startTestDb();      // PostgreSQL в Docker
    app = buildApp(prisma);
    alice = await createUser(prisma, { email: 'alice@example.com' });
    aliceToken = signAccess(alice.id); // тестовый подписыватель своим тестовым ключом
  });

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await cleanDb(prisma); // изоляция между тестами — ниже разберём
  });

  it('владелец может менять своё имя; получает 200 и обновлённую запись', async () => {
    const res = await request(app)
      .patch(`/api/users/${alice.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'Alice Cooper' })
      .expect(200)
      .expect('Content-Type', /json/);

    expect(res.body).toMatchObject({ id: alice.id, name: 'Alice Cooper' });

    const inDb = await prisma.user.findUnique({ where: { id: alice.id } });
    expect(inDb?.name).toBe('Alice Cooper'); // реально в базе, а не только в ответе
  });

  it('пользователь не может менять чужую запись — 403, а не 404', async () => {
    const bob = await createUser(prisma, { email: 'bob@example.com' });
    await request(app)
      .patch(`/api/users/${bob.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'hijacked' })
      .expect(403);
  });

  it('невалидное тело отсекается до БД — 400 и ничего не записалось', async () => {
    await request(app)
      .patch(`/api/users/${alice.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 42 })
      .expect(400);

    const inDb = await prisma.user.findUnique({ where: { id: alice.id } });
    expect(inDb?.name).not.toBe(42);
  });
});
```

Три приёма, которые здесь важны: проверка состояния **в базе**, а не только в ответе (мок слоя репозитория ответил бы «успех», не писав ничего); проверка негативных кодов (403, 400) — безопасность тестируется именно так; различие 403/404 для «чужой ресурс» — деталь, но пентестер её проверит.

## Testcontainers: настоящие PostgreSQL и Redis

In-memory SQLite «вместо Postgres» — ложная уверенность: иной диалект SQL, иные транзакции, никаких constraint'ов, которые ловят баги в миграциях. Testcontainers поднимает настоящие контейнеры под тесты:

```ts
// tests/db.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

let pg: StartedPostgreSqlContainer;
let redisC: StartedRedisContainer;

export async function startTestDb() {
  [pg, redisC] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').withDatabase('app_test').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.REDIS_URL = redisC.getConnectionUri();

  const prisma = new PrismaClient();
  execSync('npx prisma migrate deploy', { env: process.env }); // миграции до тестов, как в проде
  return prisma;
}

export async function cleanDb(prisma: PrismaClient) {
  // TRUNCATE ... CASCADE быстрее DELETE и сбрасывает счётчики
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map(t => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
}

export async function stopTestDb() {
  await Promise.all([pg.stop(), redisC.stop()]); // контейнеры удаляются полностью
}
```

Порядок «миграции до тестов» принципиален: `prisma migrate deploy` прогоняет те же миграции, что и прод. Если миграция сломана — узнаешь здесь, а не в проде. Дёшево держать контейнер на файл тестов через `globalSetup` Vitest, а не поднимать по контейнеру на каждый тест — запуск PostgreSQL занимает секунды, и его стоит амортизировать.

## Изоляция тестов и фабрики данных

Изоляция — свойство «любые два теста проходят в любом порядке, результат тот же». Антипаттерны: тесты, делящие одного пользователя (порядок выполнения внезапно становится значимым), порядковые номера в ассертах («должно быть 3 заказа» — а в соседнем файле тоже создали), время «сейчас» без фиксации.

```ts
// tests/factories.ts — фабрики вместо простыней beforeEach
import { faker } from '@faker-js/faker';

export async function createUser(prisma: PrismaClient, overrides: Partial<User> = {}) {
  return prisma.user.create({
    data: {
      email: faker.internet.email(),
      name: faker.person.fullName(),
      passwordHash: await argon2.hash('test-password-123'),
      ...overrides, // в тесте указываешь только значимое: role: 'admin'
    },
  });
}

export async function createOrder(prisma: PrismaClient, user: User, items: Partial<Item>[] = []) {
  // создаёт заказ со всеми зависимостями: позиции, статус PENDING
  // тест читает как: "дан заказ пользователя с двумя позициями" — одна строка
}
```

Фабрика инкапсулирует «правдоподобный объект»: тест говорит, чем объект значим (`createOrder(prisma, user, [{ sku: 'X', qty: 2 }])`), а не как он устроен. Переименование поля в схеме правится в одном месте, а не в сорока тестах. Для негативных сценариев заводи фабрику-«сломанную» версию: `createUnverifiedUser`, `createExpiredSession`.

Изоляция техниками: чистый `TRUNCATE` между тестами (код выше), уникальные значения через faker (email всегда уникален), фиксированное время через `vi.setSystemTime` вместо `Date.now`, тесты не ходят в сеть — внешние API подменяются `vi.mock` или nock'ом на уровне интеграционного теста.

## Мокирование сети на границе

Интеграционные тесты не должны ходить в реальный мир: платёжный шлюз в дауне не должен красить твою сборку. На границе ставится перехватчик HTTP: **nock** (process-wide перехват в Node) или **MSW** (Mock Service Worker — единый API для Node-тестов и браузера, удобен, когда фронтенд и бэкенд делят сценарии). Правило: мокаем только внешние домены; внутренние вызовы своих сервисов идут по-настоящему — иначе интеграционный тест вырождается в unit с тяжёлой декорацией.

```ts
import nock from 'nock';

nock('https://api.stripe.com')
  .post('/v1/charges')
  .reply(200, { id: 'ch_test', status: 'succeeded' });
```

Зафиксируй в CI переменную, запрещающую реальные исходящие запросы (например, `NOCK_OFF=true` вне тестов и egress-файрвол на CI-раннерах) — тест, случайно стукнувшийся в прод-API третьей стороны, обнаружится мгновенно, а не счётом от вендора.

## Тестовая матрица

Когда тестов много, по ним должно быть видно, что не проверено. Матрица «сценарий × слой»:

| Сценарий | Unit (домен) | Интеграция (API+БД) | E2E (след. глава) |
|---|---|---|---|
| Регистрация: пароль хешируется Argon2 | ✔ параметры хеша | ✔ запись в БД, пароля нет в ответе | ✔ сценарий формы |
| Логин: неверный пароль | — | ✔ 401, одинаковое время для «нет юзера» | ✔ сообщение об ошибке |
| Логин: rate limit | — | ✔ 429 после 5 попыток (Redis реальный) | — |
| Заказ: итог с промокодом | ✔ все ветки скидок | ✔ цена в БД = цене в ответе | ✔ чекаут целиком |
| Авторизация: чужой ресурс | — | ✔ 403 на чужой id | — |
| XSS в комментарии | ✔ санитайзер | ✔ HTML в ответе экранирован | ✔ CSP не роняет скрипт |

Пустая ячейка — сознательное решение (E2E на rate limit не пишем — хрупко и медленно) или дыра. Ревью матрицы при добавлении фичи занимает минуту и отвечает на вопрос «а что тестируем?» системно.

## Типичные ошибки и грабли

1. **Тесты приватных методов и моки собственного кода.** Тест знает устройство, а не контракт — рефакторинг ломает всё. Тестируй публичное поведение, мокай только внешний мир.
2. **`vi.mock` со ссылками на переменные из замыкания.** Хоистинг съедает — используй верхнеуровневые переменные или `importOriginal`.
3. **Тесты, зависящие от порядка.** «Ожидаю 3 записи в списке» ломается, когда соседний файл дочистил базу. Чистый TRUNCATE + уникальные данные + ассерты относительно своих объектов.
4. **SQLite вместо Postgres «для скорости».** Перестают ловиться constraint-ошибки, ILIKE, транзакционные тонкости. Testcontainers стоит секунд — плати их.
5. **Coverage 100% без ассертов.** Строки выполнились, ничего не проверено. Ловится мутационным тестированием и ревью.
6. **Ложная изоляция через beforeEach, который не ждёт.** `prisma.$executeRaw` без await, фоновые джобы между тестами — флаки. Каждое асинхронное действие в тесте — awaited и видимое.
7. **Интеграционные тесты против staging-API третьих сторон.** Тесты падают, когда чужой API лежит. Внешний мир мокается — на своём периметре интегрируйся.

## Вопросы на собеседовании

1. **Где граница между unit и интеграционным тестом?** Unit — доменная логика с моками внешнего мира, миллисекунды. Интеграционный — реальный HTTP + реальная БД (Testcontainers): проверяет валидацию, SQL, сериализацию. E2E — только критические пути через браузер.
2. **Что мокать, а что нет?** Мокать внешние системы: сеть, файлы, таймеры, рандом. Не мокать свою доменную логику и репозитории в интеграционных — иначе тестируешь моки.
3. **Почему 100% coverage не гарантирует отсутствия багов?** Coverage меряет выполнение строк, а не осмысленность ассертов: тест без expect поднимает процент. Плюс он не покрывает комбинации ввода и ошибки проектирования. Мутационное тестирование (Stryker) — шаг вперёд.
4. **Как изолировать интеграционные тесты?** Контейнер на файл (или globalSetup), `TRUNCATE ... CASCADE` между тестами, уникальные данные через faker, фиксированное время, явные await.
5. **Зачем миграции прогонять в тестах, а не `db.push`/`sync`?** `migrate deploy` — те же SQL-файлы, что в проде: ловит сломанные миграции, переименования колонок и constraint-ошибки на этапе CI.
6. **Что такое фабрики данных и чем лучше fixtures?** Фабрика создаёт объект кодом с переопределениями — локально и читаемо; fixtures — статичные JSON/YAML, дублируются и быстро протухают при смене схемы.
7. **Пирамида перевернулась: 200 E2E, 10 unit. Что не так?** Дорого, медленно, диагностика через пять слоёв. Переноси бизнес-логику вниз: unit на домен, E2E оставь на деньги/регистрацию.

## Практика

1. Перенеси полный конфиг Vitest из главы в pet-проект: пороги, per-path порог на `src/domain/**`, setup-файл с тестовым секретом. Критерий: `vitest run --coverage` в CI падает при снижении покрытия домена ниже 85%.
2. Выбери модуль бизнес-логики и напиши unit-тесты по AAA: happy path + каждая ветка `if` + каждая ошибка. Затем прогони Stryker на модуле и добейся ≥ 85% убитых мутантов.
3. Подними Testcontainers-стек (PostgreSQL + Redis), прогони `prisma migrate deploy` в globalSetup, напиши интеграционный тест логина: реальный Redis-счётчик попыток должен отдать 429 после 5 неудачных логинов.
4. Напиши фабрики `createUser`, `createOrder` с faker и переvedи 5 существующих тестов на них; убедись, что прогон файла тестов проходит в изоляции (`vitest run src/users/users.int-spec.ts`) и в полном наборе.
5. Заполни тестовую матрицу pet-проекта (как в главе) и найди три пустые ячейки, которые закрываешь тестами в первую очередь.

## Что почитать

- [Vitest Guide — моки, покрытие, конфигурация](https://vitest.dev/guide/)
- [Testcontainers for Node.js](https://node.testcontainers.org/) — официальные модули PostgreSQL, Redis, Kafka
- [Supertest — README](https://github.com/ladjs/supertest)
- [Stryker — мутационное тестирование JS/TS](https://stryker-mutator.io/)
- [JavaScript Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [Prisma — тестирование и тестовые среды](https://www.prisma.io/docs/orm/prisma-client/testing/unit-testing)
