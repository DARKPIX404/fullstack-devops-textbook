---
title: "E2E-тестирование, качество кода и контракты: Playwright, ESLint 9 и Pact"
description: "Playwright в деталях: конфиг, фикстуры, автоожидания, локаторы по ролям, tracing, retries, codegen, storageState для авторизации, проекты для изоляции. Сравнение с Cypress, ESLint 9 flat config, Husky, conventional commits и контрактное тестирование Pact."
---

E2E-тест — единственный тест, который проверяет систему так, как её видит пользователь: настоящий браузер, настоящий рендеринг, настоящие сетевые запросы. За это приходится платить: браузеры медленные, тайминги недетерминированы, и каждый крошечный флак съедает доверие к всему набору. В краткой версии ты видел пример с автоожиданиями и codegen — здесь разберём инфраструктуру вокруг: изоляцию состояний через проекты и storageState, расследование падений через tracing, дисциплину против флаков. Вторая половина главы — про инженерную гигиену (линтеры, хуки, conventional commits) и контрактное тестирование Pact для систем, которые релизятся независимо.

## Playwright: конфиг, который живёт в проде

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,              // файлы гоняются параллельно внутри раннера
  workers: process.env.CI ? 4 : undefined,
  retries: process.env.CI ? 2 : 0,  // локально падай сразу — чини, а не маскируй
  timeout: 30_000,
  expect: { timeout: 5_000 },       // ассерты ждут условия, а не моментальный снимок
  reporter: [
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }], // для CI
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',     // трейс только упавших — дёшево и всегда под рукой
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },      // один раз: логин всех ролей
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',               // залогиненный state для всех тестов
      },
      dependencies: ['setup'],                              // setup обязан пройти первым
    },
    // можно держать и другие роли/браузеры отдельными проектами
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'npm run start:e2e',       // поднимает приложение + seed-данные
    url: 'http://localhost:3000/health',
    reuseExistingServer: !process.env.CI, // локально не перезапускай, если уже живо
    timeout: 120_000,
  },
});
```

Ключевые решения здесь: `webServer` — тесты сами поднимают приложение, окружение воспроизводимо на любой машине; `projects` с `dependencies` — изоляция по состояниям, ниже разберём; `retain-on-failure` — записываем следы только там, где они нужны, иначе артефакты раздуваются.

## Фикстуры и автоожидания

Playwright строится на фикстурах — функциях, которые готовят контекст теста (page, данные, маскировка сети). Стандартные фикстуры расширяются своими:

```ts
// e2e/fixtures.ts
import { test as base, expect } from '@playwright/test';
import { seedOrder } from './helpers/seed';

type Fixtures = {
  seededOrder: { id: string; total: number };
};

export const test = base.extend<Fixtures>({
  seededOrder: async ({ page, request }, use) => {
    // до теста: создаём данные через API (быстро и надёжно, не через UI)
    const order = await seedOrder(request);
    await use(order);          // тест получает объект
    // после теста: очистка, если нужна
  },
});

export { expect };

// e2e/orders.spec.ts
import { test, expect } from './fixtures';

test('пользователь видит свой заказ в списке', async ({ page, seededOrder }) => {
  await page.goto('/orders');
  await expect(page.getByRole('link', { name: `Заказ №${seededOrder.id}` })).toBeVisible();
});
```

**Автоожидания** — фундамент, который отличает Playwright от эпохи `sleep()`: каждое действие (click, fill) само ждёт, пока элемент станет attached, visible, stable, enabled, а ассерты (`toBeVisible`, `toHaveURL`) ждут условие до таймаута. Поэтому тест выше корректен без единого `waitForTimeout`: если заказ появляется через 300 мс после рендера — ассерт просто подождёт.

:::caution[Единственное законное исключение]
`waitForTimeout` допустим только для воспроизведения реального пользовательского темпа (анимации, debounce) и с комментарием «почему». Каждый `waitForTimeout(2000)` в наборе — будущий флак: на быстрой машине он лишний, на загруженной CI — недостаточен.
:::

## Локаторы по ролям

Локатор должен описывать то, что видит пользователь, а не то, как устроён DOM:

```ts
// УСТОЙЧИВО: роли, подписи, текст (под капотом — Testing Library-подобные запросы)
page.getByRole('button', { name: 'Оформить заказ' });
page.getByLabel('Email');
page.getByRole('heading', { name: 'Список заказов' });
page.getByTestId('order-total');   // крайняя мера, когда роль/подпись не выразить

// ХРУПКО: селекторы умирают при редизайне и не говорят, что тестируешь
page.locator('div.container > button.btn-primary:nth-child(2)');
page.locator('css=#root > div > div > ul > li:first-child');
```

Бонус, о котором часто забывают: ролевые локаторы — это бесплатная проверка доступности. Если у кнопки нет имени, которое видит `getByRole`, её не увидит и screen reader.

## Tracing, видео и расследование падений

Когда тест падает в CI, у тебя есть три артефакта из конфига выше: **trace** (пошаговый слепок: DOM, скриншот, сеть, консоль на каждом действии), **screenshot**, **video**. Рабочий цикл:

```bash
npx playwright show-report            # HTML-отчёт, клик на упавший тест
npx playwright show-trace trace.zip   # полная временная шкала: что видел браузер
```

В trace смотри: на каком действии таймаут, какой DOM был реально на экране (а не какой ты ожидал), какие сетевые запросы ушли и что вернули. В 90% случаев причина видна за минуту: эндпоинт отдал 500, кнопка была disabled из-за валидации, элемент был перекрыт другим. Оставшиеся 10% — собственно флаки.

:::tip[Правило первого падения]
Не чини тест, не посмотрев trace. Догадки («наверное, просто флакнуло») — как ретрай без диагностики: маскируют проблему и учат набор падать тише. Каждое падение в CI — это или баг в продукте, или баг в тесте, или баг в инфраструктуре; все три надо классифицировать, прежде чем нажимать «re-run».
:::

## Retries и флаки: дисциплина

Retry в CI — это не «исправление», а инструмент диагностики и смягчение неустранимой недетерминированности (shared CI-окружение, сеть). Правила:

1. Retry маскирует, но не лечит. Если тест флакает чаще раза на десять прогонов — заводи задачу и чини.
2. Флак почти всегда имеет причину: гонка за данными (тест читает то, что ещё не записалось), время (анимация), сеть (запрос не замокирован/не дождался), состояние (тесты не изолированы и мешают друг другу).
3. Детектируй: `npx playwright test --repeat-each=20` на подозрительном тесте — быстрый способ поймать гонку локально.
4. Статистика в отчёте: html-reporter показывает флак-рейтр per-теста. Тест с retry-рейтом > 5% — кандидат на переписывание.

## Codegen: запись сценария

```bash
npx playwright codegen http://localhost:3000
```

Откроется браузер и инспектор: действия записываются в код. Вывод: пригодится для **разведки** — быстро понять селекторы и шаги сценария. Не используй codegen-как-есть в наборе: там `locator('css=...')` и лишние шаги. Переписывай на `getByRole`, разбивай по тестам, добавляй ассерты на каждом значимом шаге (видимость результата, URL, текст).

## Аутентификация: storageState

Логинить пользователя через UI в каждом тесте — медленно и дублирует то, что уже покрыто одним тестом логина. Решение — сохранить состояние (куки, localStorage) после логина и переиспользовать:

```ts
// e2e/auth.setup.ts — проект 'setup' из конфига
import { test as setup, expect } from '@playwright/test';

setup('авторизация как обычный пользователь', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_USER_EMAIL!);
  await page.getByLabel('Пароль').fill(process.env.E2E_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/dashboard/); // дождались — значит сессия жива
  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});

// все тесты проекта chromium стартуют с этим state (см. use.storageState в конфиге)
// тест на защищённую страницу теперь — это просто goto, без логина
```

Храни несколько ролей так же: `admin.json`, `manager.json` — разные проекты (`chromium-admin`, `chromium-user`) с собственным storageState. Граница ролей в E2E: один тест «юзер не видит админку» (403), а не полный обход админки юзером.

## Изоляция через проекты

Проекты в Playwright — изолированные окружения прогона: свой браузер, свой storageState, свои зависимости (`dependencies`). Паттерн: `setup`-проект пишет storageState, тестовые проекты его потребляют. Параллельность внутри проекта — между файлами, состояние не делится. Если тесты портят друг другу данные на бэкенде — изоляция решается на уровне данных (seed уникальных пользователей через API в фикстуре), а не через отключение параллелизма: последовательный прогон вдвое-втрое медленнее.

## Данные для E2E: через API, а не через UI

E2E-тест проверяет сценарий, а не подготовку. Создание десятка сущностей через интерфейс ради одного ассерта — медленно и проверяет форму там, где она уже покрыта. Дисциплина подготовки: **данные — через API** (фикстура `request` из Playwright шлёт прямые запросы к бэкенду тестового окружения), **действия и проверки — через UI**. Если подготовка требует состояния, недостижимого по API (например, платёж прошёл через webhook внешнего шлюза) — поднимай мок внешнего сервиса на уровне тестового окружения и дёргай его же из фикстуры. И помни про детерминизм: случайные данные через faker, даты через фиксированные значения — E2E, зависящий от «сегодня», краснеет первого числа каждого месяца.

Соседний инструмент, который стоит знать — **визуальное регрессионное тестирование** (`toHaveScreenshot()` в Playwright или Chromatic для Storybook): снимок компонента сравнивается с эталоном, и редизайн, случайно съевший отступ кнопки, ловится автоматически. Вводи осознанно: шрифты и антиалиасинг дают шум, лучше снапшотить изолированные компоненты, чем целые страницы.

## Playwright vs Cypress

| Критерий | Playwright | Cypress |
|---|---|---|
| Архитектура | Драйвер из Node, управляет браузером извне | JS внутри браузера + сервер-прокси |
| Мульти-домены/вкладки/iframe | Штатно | Ограничено (cy.origin — компромиссы) |
| Язык/стиль | Vitest/jest-style API, TS из коробки | Mocha + цепочки команд |
| Скорость | Параллелизм из коробки, быстрее на больших наборах | Одна вкладка = один поток |
| Трейсинг | Действия, DOM-снапшоты, сеть, консоль | Видео, скриншоты, time travel |
| Экосистема | Моложе, растёт быстрее | Зрелая, много плагинов |

Для новых проектов в 2026-м разумный дефолт — Playwright. Cypress остаётся оправдан там, где уже есть написанный набор и обученная команда.

## Качество кода: ESLint 9 flat config

Flat config — обычный ES-модуль вместо каскада `.eslintrc`: явный порядок, импорты, условия по файлам.

```js
// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'playwright-report', 'test-results', 'e2e/.auth'] },

  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked, // типо-осведомлённые: нужен projectService
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    rules: {
      // баги, которые тайпскрипт не ловит:
      '@typescript-eslint/no-floating-promises': 'error',   // promise без await
      '@typescript-eslint/no-misused-promises': 'error',    // async в boolean-контексте
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // гигиена:
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'import/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
    },
  },

  {
    files: ['e2e/**/*.ts', '**/*.spec.ts', '**/*.int-spec.ts'],
    rules: {
      // в тестах non-null assertion и any уместнее правилами
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier, // ВСЕГДА последним: глушит правила, конфликтующие с форматтером
);
```

Что даёт типо-осведомлённый уровень: `no-floating-promises` ловит `db.query(...)` без await — классический источник «запрос не записался, а тест прошёл». Стоит включать с первого дня: нарастающая куча подавлений правил потом не чинится.

**Prettier** — только форматирование (кавычки, отступы, ширина), никакой логики. `.editorconfig` — для редакторов, которые не знают Prettier (целевые: `end_of_line`, `insert_final_newline`, `charset`); настройки пересечения (indent) держи в одном месте — EditorConfig, Prettier подхватит его через `editorconfig: true`.

```json
// .prettierrc
{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all" }
```

## Husky + lint-staged: хуки, которые не раздражают

Полный прогон линтера на каждый коммит утомляет — lint-staged гоняет проверки только на staged-файлах:

```bash
npm install -D husky lint-staged
npx husky init
```

```bash
# .husky/pre-commit
npx lint-staged
```

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"]
  }
}
```

`--fix` чинит автоматически исправимое (импорты, кавычки) и коммитит уже исправленное. Помни: хук обходится `git commit --no-verify`, поэтому CI обязан продублировать `eslint . && prettier --check . && vitest run --coverage` — хуки сокращают петлю, а не заменяют ворота.

**Conventional Commits (кратко).** Формат `type(scope): subject` (`feat(auth): add refresh rotation`) — машиночитаемая история: из неё автоматически строятся changelog'и и semver-релизы (semantic-release), а `commitlint` в хуке `commit-msg` отклоняет неформатные сообщения. На «ты» — это не бюрократия, а способ через год понять по логу, где что сломалось.

## Контрактное тестирование: Pact

Интеграционный тест поднимает обе стороны. Контрактный — фиксирует **соглашение** между ними и проверяет каждую сторону независимо. Схема consumer-driven:

```
consumer (фронт)                    provider (бэкенд)
┌─────────────────┐                 ┌──────────────────┐
│ тест с моком    │  1. записывает │                  │
│ provider'а      │ ── pact.json ─▶│  верификация:    │
│ → сохраняет     │                │  прогон пактов   │
│   взаимодействие│                │  против реального│
└─────────────────┘                │  API             │
        │                          └──────────────────┘
        ▼                                   ▲
   Pact Broker: хранилище пактов, кто что нарушил, вебхуки в CI
```

**Consumer-тест** (фронтенд, jest/vitest + Pact):

```ts
// consumer/pact/orders.pact.spec.ts
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { fetchOrders } from '../api/orders';

const { eachLike, like, integer, string, regex } = MatchersV3;

const pact = new PactV3({
  consumer: 'web-app',
  provider: 'orders-api',
  dir: './pacts',
});

describe('GET /api/orders', () => {
  it('список заказов текущего пользователя', () => {
    pact
      .given('у пользователя есть два заказа')
      .uponReceiving('GET /api/orders с валидным токеном')
      .withRequest('GET', '/api/orders', (b) =>
        b.setHeaders({ Authorization: regex(/^Bearer .+$/, 'Bearer abc') }),
      )
      .willRespondWith(200, (b) =>
        b.setHeaders({ 'Content-Type': 'application/json' }).setBody({
          orders: eachLike({
            id: like('ord_1'),
            status: regex(/^(PENDING|PAID|SHIPPED)$/, 'PAID'),
            total: integer(1990),
            items: eachLike({ sku: string('BOOK-1'), qty: integer(1) }),
          }),
        }),
      )
      .executeTest(async (mockserver) => {
        process.env.API_URL = mockserver.url; // клиент ходит в мок-провайдер
        const orders = await fetchOrders();
        expect(orders[0].status).toBe('PAID');
      });
  });
});
```

Матчеры (`like`, `regex`, `eachLike`) — суть контракта: `like` говорит «тип важен, значение — нет», `regex` — «формат обязан соблюдаться». После прогона появляется `pacts/web-app-orders-api.json` — он публикуется в **Pact Broker** (`pactfoundation/pact-broker` — docker-образ, жить в инфраструктуре проекта).

**Provider-верификация** (CI бэкенда):

```ts
// provider/test/pact-verifier.spec.ts
import { Verifier } from '@pact-foundation/pact';

it('выполняет контракты от consumers', async () => {
  await new Verifier({
    provider: 'orders-api',
    providerBaseUrl: 'http://localhost:4000', // реальный поднятый API
    pactBrokerUrl: process.env.PACT_BROKER_URL,
    pactBrokerToken: process.env.PACT_BROKER_TOKEN,
    publishVerificationResult: true,          // брокер видит статус
    providerVersion: process.env.GIT_SHA,
    stateHandlers: {
      'у пользователя есть два заказа': async () => {
        await seedOrders(2); // брокер шлёт given-состояния, provider их поднимает
      },
    },
  }).verifyProvider();
});
```

Получается цикл: фронт меняет контракт (ждёт новое поле) → consumer-тест публикует новый пакт → провайдер в своём CI **краснеет**, пока не реализует → деплой-ворота (can-i-deploy в брокере) не пускают несовместимые версии друг к другу. Ломать контракт сознательно — можно: версии согласуются через брокер.

:::caution[Когда Pact не нужен]
Один фронт + один бэкенд, релизятся вместе из одного монорепо — достаточно типизированного клиента и пары E2E. Pact окупается, когда: независимые команды/сервисы, разные циклы релизов, публичный API с внешними интеграторами. Иначе это инфраструктурные затраты без дивидендов.
:::

## Типичные ошибки и грабли

1. **`waitForTimeout` вместо ожиданий.** Маскирует гонки и возвращается флаком на загруженном CI. Заменяй на `expect(...).toBeVisible()` / `toHaveURL` — они ждут условие.
2. **Логин через UI в каждом тесте.** Десятки секунд на тест и дублирование покрытия. Один setup-тест → storageState, остальные стартуют авторизованными.
3. **CSS-селекторы из codegen без переработки.** Хрупкие и нечитаемые. Роли и подписи — устойчивы к редизайну и проверяют a11y заодно.
4. **Тесты, зависящие от порядка файлов.** Изоляция через уникальные seed-данные в фикстурах и проекты с разными состояниями.
5. **Prettier-правила в ESLint.** Двойная система истины — конфликты и шум. `eslint-config-prettier` последним в конфиге, форматирование — только Prettier.
6. **Хуки без дублирования в CI.** `--no-verify` существует; ворота закрывает пайплайн.
7. **Pact на монолите с одним релизом.** Инфраструктура брокера, верификаций и given-состояний без выигрыша — когда стороны деплоятся вместе, хватает типов и E2E.

## Вопросы на собеседовании

1. **Почему Playwright не нуждается в ручных слипах?** Автоожидания: каждое действие ждёт видимость/доступность элемента, ассерты ждут условие до таймаута. `waitForTimeout` остаётся только для воспроизведения пользовательского темпа.
2. **Что писать в storageState и почему это безопасно в тестах?** Куки/localStorage сессии после логина. Это артефакт тестового окружения: seed-данные, тестовый бэкенд, таймлайф сессии секунды — в прод-набор его не пускают, в CI он пересоздаётся.
3. **Тест флакает в CI, локально зелёный. Твои шаги?** Артефакты: trace/video из отчёта → смотрю шаг таймаута, DOM, сеть. Типовые причины: гонки за данными, время, незамокированный внешний вызов, загруженный shared-раннер. Подтверждаю `--repeat-each=20`, чиню, слежу за флак-рейтр.
4. **Зачем типо-осведомлённый ESLint, чем не хватает обычного?** Обычный не видит типы: `no-floating-promises` ловит promise без await, `no-misused-promises` — async там, где ждут boolean. Это класс рантайм-багов, которые TS компиляцией не ловит.
5. **Consumer-driven контракт: кто пишет пакт и кто его проверяет?** Consumer тестирует клиент против мок-провайдера и записывает пакт; provider в своём CI воспроизводит пакты против реального API. Брокер хранит пакты, результаты верификаций и отвечает на can-i-deploy.
6. **Когда Pact избыточен?** Совместные релизы одной команды — достаточно типов клиента и E2E. Pact — для независимых циклов релизов и внешних интеграторов.
7. **Husky pre-commit ловит всё?** Нет: `--no-verify` обходит локально. Хуки — быстрая петля, CI — ворота.

## Практика

1. Переведи конфиг Playwright из главы в pet-проект: setup-проект с записью `e2e/.auth/user.json`, тестовый проект с этим storageState, `webServer` с health-check URL. Критерий: тест на защищённый экран не содержит шагов логина.
2. Сгенерируй сценарий codegen'ом, затем перепиши его: роли вместо CSS, ассерт после каждого значимого шага, ноль `waitForTimeout`. Добавь тест «залогиненный пользователь не попадает на /login (редирект на /dashboard)».
3. Намеренно сломай селектор кнопки и прогони тест в CI с `trace: retain-on-failure`; открой trace в `show-trace`, найди момент ошибки и сделай скриншот DOM-снапшота шага — приложи к README папки e2e как инструкцию «как дебажить падения».
4. Переведи ESLint на flat config с `recommendedTypeChecked` и `projectService`; исправь все `no-floating-promises` в коде; настрой Husky + lint-staged и докажи намеренно сломанным файлом, что коммит отклоняется; продублируй проверки в CI-джобе.
5. Подними Pact Broker (`pactfoundation/pact-broker` в docker-compose), напиши consumer-тест на эндпоинт списка заказов с двумя матчерами (`like`, `regex`), подключи верификацию с `stateHandlers` к CI бэкенда и добейся зелёного can-i-deploy.

## Что почитать

- [Playwright — Auto-waiting, Trace Viewer, Auth](https://playwright.dev/docs/intro) (разделы Trace viewer, Authentication)
- [Playwright — Best Practices (локаторы, изоляция)](https://playwright.dev/docs/best-practices)
- [ESLint — Flat Config и типизированные правила](https://typescript-eslint.io/getting-started/typed-linting/)
- [Pact — философия и документация](https://docs.pact.io/)
- [Conventional Commits](https://www.conventionalcommits.org/ru/v1.0.0/)
- [Testing Library — принципы ролевых запросов](https://testing-library.com/docs/queries/about/)
