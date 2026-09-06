---
title: "Тестирование: Vitest и Testing Library"
description: "Философия тестирования поведения, запросы по ролям, userEvent, асинхронные тесты, MSW для сети и список того, что тестировать не нужно."
---

Тесты — это страховка рефакторинга. Код, покрытый тестами поведения, можно переписывать смело: сменить Zustand на Redux, перестроить внутреннее состояние компонента, обновить зависимости — тесты скажут, сломалось ли то, что видит пользователь. Код без тестов рефакторить страшно, и он медленно гниет под слоями «не трогай, работает». Но тесты бывают двух видов: актив и балласт. Разница — в том, *на что* они смотрят. Эта глава про набор, который превращает тестирование из ритуала в инструмент: Vitest как раннер, Testing Library как философия, MSW как сетевой слой.

## Философия: тестируй поведение, а не имплементацию

Главный принцип Testing Library, вытекающий из [пяти вопросов документации](https://testing-library.com/docs/guiding-principles/): пиши тест так, будто ты пользователь. Пользователь не знает про `useState`, `dispatch` и внутренние имена переменных. Он ищет кнопку по тексту, вводит email, кликает «Отправить» и ждёт подтверждения.

```tsx
// ❌ Тест на имплементацию: ломается при любом рефакторинге
it('вызывает setState с новым значением', () => {
  const setState = vi.fn();
  render(<SearchInput onChange={setState} />);
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'кофе' } });
  expect(setState).toHaveBeenCalledWith('кофе');
});

// ✅ Тест на поведение: переживёт любой внутренний редизайн
it('показывает результаты поиска после ввода запроса', async () => {
  const user = userEvent.setup();
  render(<SearchPage />);

  await user.type(screen.getByRole('searchbox'), 'кофе');

  expect(await screen.findByRole('list', { name: /результаты/i })).toBeInTheDocument();
  expect(screen.getByText(/кофемолка/i)).toBeVisible();
});
```

Первый тест привязан к деталям: что сеттер — внешний колбэк, что у инпута testId именно такой. Поменялся API компонента (сеттер стал внутренним, testId убрали) — тест красный, хотя пользователь ничего не заметил. Второй тест описывает контракт с пользователем: ввёл запрос — увидел результаты. Он переживёт переписывание компонента на другие хуки, перенос состояния в стор, замену fetch на Query.

Практическое следствие: **запросы элементов — по ролям, меткам и видимому тексту**, как ищет пользователь; `data-testid` — крайняя мера, когда семантического способа нет (графики, виртуализированные списки с обрезанным DOM).

## Запросы по ролям: приоритет Testing Library

Testing Library выстраивает запросы по степени «близости к пользователю» (от лучшего к худшему):

1. `getByRole` — по ARIA-роли (`button`, `textbox`, `alert`, `list`). Ловит и проблемы доступности: если у кнопки нет доступного имени — тест её не найдёт, и это фича, а не баг.
2. `getByLabelText` — по связанному label (как пользователь читает форму).
3. `getByPlaceholderText`, `getByText` — по видимому тексту.
4. `getByDisplayValue` — текущее значение поля.
5. `getByTestId` — только если предыдущие не работают.

```tsx
// ✅ Поиск как пользователь: кнопка по имени, поле по метке
screen.getByRole('button', { name: /зарегистрироваться/i });
screen.getByLabelText(/email/i);

// ❌ Слабый запрос: цепляется за разметку, а не за смысл
container.querySelector('.btn-primary');
screen.getByTestId('submit-btn');
```

`getByRole` с опцией `name` решает большинство задач и бесплатно держит a11y-качество: если кнопка состоит из одной иконки без `aria-label`, тест потребует её добавить.

## userEvent против fireEvent

`fireEvent` — тонкая обёртка над DOM-событиями: кинул `change` — и всё. `userEvent` — симуляция реального взаимодействия с клавиатурой/мышью: типит посимвольно, с фокусом, с реальными keydown/keypress/keyup, с hover-логикой.

```tsx
// ❌ fireEvent: один скачок, без последовательности
fireEvent.change(input, { target: { value: 'ab' } });

// ✅ userEvent: как человек — a, потом b, с событиями клавиатуры
const user = userEvent.setup();
await user.type(input, 'ab');
await user.click(button); // с hover, focus, pointer events
```

Разница критична для кода с валидацией по событию, масками ввода, обработкой стрелок клавиатуры. `userEvent.setup()` создаёт экземпляр с настройкой (pointerEventsCheck, delay) — создавай его в начале теста. Всё API асинхронное — `await` обязателен.

Исключение, где `fireEvent` уместен: `fireEvent.scroll` для бесконечных списков и редкие low-события. Интерактив пользователя — всегда userEvent.

## Асинхронные тесты: findBy и waitFor

React-обновления и сетевые ответы — асинхронны. `getBy*` выбрасывает исключение сразу, если элемент не найден. Три инструмента для ожидания:

```tsx
// findBy* — промис, ждёт появления до таймаута (по умолчанию 1 с)
expect(await screen.findByRole('alert')).toHaveTextContent('Некорректный email');
// синтаксис expect(await ...) лучше findBy* внутри expect, читается как сценарий

// waitFor — для утверждений не на элементах
await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

// queryBy* — для проверки ОТСУТСТВИЯ (не выбрасывает, возвращает null)
await waitForElementToBeRemoved(() => screen.queryByRole('progressbar'));
```

Порядок: сначала действие, потом `await findBy*` результата. Никаких `await new Promise(r => setTimeout(r, 500))` — хрупко и медленно; Testing Library ждёт реальные изменения DOM с интервалом опроса.

Типичная ошибка — `await` на действии и синхронный `getBy` результата: `await user.click(...)` ждёт только сам клик, а не последующий рендер. Результат ищи через `findBy*`.

## Структура теста: AAA и setup

```
Arrange — рендер + моки
Act     — действия пользователя
Assert  — проверки результата
```

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RegisterForm } from './RegisterForm';

describe('RegisterForm', () => {
  afterEach(() => {
    vi.restoreAllMocks(); // чистим между тестами
  });

  it('показывает ошибку валидации при невалидном email', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<RegisterForm />);

    // Act
    await user.type(screen.getByLabelText(/email/i), 'не-email');
    await user.click(screen.getByRole('button', { name: /зарегистрироваться/i }));

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent('Некорректный email');
  });

  it('отправляет валидные данные на сервер', async () => {
    // Arrange
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<RegisterForm />);

    // Act
    await user.type(screen.getByLabelText(/email/i), 'a@b.ru');
    await user.type(screen.getByLabelText(/пароль/i), 'Secret123');
    await user.click(screen.getByRole('button', { name: /зарегистрироваться/i }));

    // Assert
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/register',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('a@b.ru'),
        }),
      ),
    );
  });
});
```

Vitest работает из коробки с Vite-проектами: конфиг в `vitest.config.ts` (jsdom: `environment: 'jsdom'` + `@testing-library/jest-dom` для матчеров `toBeInTheDocument`). `describe/it/expect` — глобально или импортом из `vitest` — на вкус.

## MSW: мокать сеть, а не fetch

Для компонентов с сетевыми запросами два пути. Простой (виден выше): `vi.stubGlobal('fetch', mock)` — достаточно для «проверили, что вызвали с нужными аргументами». Настоящий: **MSW (Mock Service Worker)** — перехватывает запросы на уровне Service Worker/Node-интерцептора, и приложение не замечает подмены:

```ts
// src/test/server.ts
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

export const server = setupServer(
  http.post('/api/register', async ({ request }) => {
    const body = (await request.json()) as { email: string };
    if (body.email === 'taken@mail.ru') {
      return HttpResponse.json(
        { errors: { email: 'Email уже занят' } },
        { status: 400 },
      );
    }
    return HttpResponse.json({ ok: true });
  }),
);

// src/setupTests.ts
import { server } from './test/server';
import { beforeAll, afterEach, afterAll } from 'vitest';

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers()); // сброс моков между тестами
afterAll(() => server.close());
```

```tsx
it('показывает ошибку сервера при занятом email', async () => {
  const user = userEvent.setup();
  render(<RegisterForm />);

  await user.type(screen.getByLabelText(/email/i), 'taken@mail.ru');
  await user.type(screen.getByLabelText(/пароль/i), 'Secret123');
  await user.click(screen.getByRole('button', { name: /зарегистрироваться/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Email уже занят');
});
```

Выигрыш MSW перед стабом fetch: тестируется весь путь — компонент, хук, сериализация, разбор ответа, обработка статусов. Стаб fetch'а проверяет только аргументы вызова; если хук сломает URL или забудет JSON.stringify — MSW-тест упадёт, стаб — нет. Плюс один источник моков и для юнит-тестов, и для E2E (Playwright умеет MSW через свой сервер).

Для TanStack Query в тестах добавь `QueryClientProvider` с отключёнными ретраями: `new QueryClient({ defaultOptions: { queries: { retry: false } } })` — иначе упавший запрос будет ретраиться в тесте десять раз.

## Чего НЕ тестировать

Список, который сэкономит тебе недели жизни:

1. **Третьи стороны.** Не тестируй, что React корректно ставит класс или что Zod валидирует email — это работа мейнтейнеров. Тестируй свою интеграцию: «форма показывает ошибку, когда схема отклонила значение».
2. **Стили.** `expect(element).toHaveStyle('color: red')` — хрупко и бессмысленно. Визуальная регрессия решается скриншот-тестами (Chromatic, Playwright screenshots), а не юнит-тестами.
3. **Константы, типы, простые маппинги.** `expect(sum(2, 2)).toBe(4)` на функцию из одной строки — шум. Исключение: сложная чистая логика (редьюсеры, парсеры, нормализация) — их тестируй напрямую без рендера, это дёшево и ценно.
4. **Детали реализации хуков.** Не проверяй «вызвался ли useEffect N раз» — это имплементация. Проверяй видимый результат: «после смены вкладки данные обновились».
5. **Каждую ветку JSX.** Покрывай пользовательские сценарии, а не все комбинации пропсов. Комбинаторный взрыв тестов = медленный прогон = тесты перестают запускаться.
6. **Очевидные вещи.** Тест «компонент рендерится» без дальнейших действий редко чем-то помогает. Каждый тест должен отвечать на вопрос «какое поведение защищаем?».

Правило покрытия: 100% кода — не цель; 100% критических пользовательских сценариев — цель. Сценарии с деньгами, авторизацией и необратимыми действиями покрываются в первую очередь; сценарий «hover меняет прозрачность карточки» может жить без теста.

## Кастомные хуки: renderHook

Хуки тестируются изолированно через `renderHook` из `@testing-library/react`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from './useDebounce';

it('отдаёт значение с задержкой', async () => {
  const { result, rerender } = renderHook(
    ({ value }) => useDebounce(value, 100),
    { initialProps: { value: 'a' } },
  );

  expect(result.current).toBe('a');

  rerender({ value: 'abc' });
  expect(result.current).toBe('a'); // ещё старое — дебаунс не прошёл

  await act(async () => {
    await new Promise((r) => setTimeout(r, 150)); // ждём таймер
  });
  expect(result.current).toBe('abc');
});
```

`act` оборачивает обновления, вызванные вне штатного рендера (таймеры, промисы) — без него React ругается на непредвиденное обновление. Для хуков с таймерами Vitest-фейки (`vi.useFakeTimers()`) удобнее реального ожидания: `vi.advanceTimersByTime(150)` — мгновенно.

## Тестирование сторов: Zustand без рендера

Клиентские сторы Zustand тестируются напрямую, без React вообще — это одно из их преимуществ:

```tsx
import { useCart } from './cartStore';
import { beforeEach } from 'vitest';

beforeEach(() => {
  // сброс стора между тестами (или через export создания стора-фабрики)
  useCart.setState({ items: [], isOpen: false });
});

it('увеличивает количество при повторном добавлении', () => {
  useCart.getState().addItem({ id: 'p1', price: 100 });
  useCart.getState().addItem({ id: 'p1', price: 100 });

  expect(useCart.getState().items).toHaveLength(1);
  expect(useCart.getState().items[0].qty).toBe(2);
});

it('корректно считает итоговую сумму', () => {
  const s = useCart.getState();
  s.addItem({ id: 'p1', price: 100 });
  s.addItem({ id: 'p2', price: 250 });

  const total = useCart.getState().items.reduce((sum, i) => sum + i.price * i.qty, 0);
  expect(total).toBe(350);
});
```

Никаких `render`, `screen` и `act` — чистые юнит-тесты на чистые функции переходов. Тестируется та же dispatch-модель, что и у редьюсеров из главы 3: действие → новое состояние. Для сторов с `persist` сбрасывай `localStorage` в `beforeEach`.

## Доступность: jest-axe

Тесты на роли уже ловят половину a11y-проблем (нет label — нет getByLabelText). Оставшуюся половину добирает автоматический аудит axe:

```tsx
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

it('форма доступна', async () => {
  const { container } = render(<RegisterForm />);
  const results = await axe(container);
  expect(results).toHaveNoViolations(); // контраст, aria-атрибуты, роли
});
```

Включи его не на каждый тест (медленновато), а как smoke-тест на ключевые страницы — регрессия доступности ловится CI до того, как до неё дойдёт пользователь со скринридером.

## Отладка упавших тестов

Три инструмента, экономящие часы:

```tsx
// 1. screen.debug — печатает текущий DOM теста (взялось из Testing Library)
screen.debug();

// 2. logRoles — все роли и доступные имена контейнера
import { logRoles } from '@testing-library/react';
logRoles(container);

// 3. --reporter=verbose при запуске: видно имена тестов и где именно упало
// vitest run --reporter=verbose
```

Самая частая причина «не находит элемент» — искал до асинхронного обновления или не та роль. Открой debug-вывод: элемент есть, но называется `textbox`, а ты искал `searchbox`? Меняй запрос. Элемента нет вообще — логика рендера не сработала, смотри условия показа.

## CI: прогон и пороги

Тесты, которые не гоняются в CI, мертвы. Минимальная настройка:

```json
// package.json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

Порог покрытия задавай осторожно: `coverage.thresholds` в 80% по строкам — стимул писать тесты; 100% по веткам — источник бессмысленных тестов ради цифры. Обновляй бейдж в README или отчёт в CI-пайплайне — видимость прогона повышает дисциплину.

## Типичные ошибки и грабли

1. **`fireEvent` вместо userEvent.** Протестированный код с масками, валидацией по событию или клавиатурной навигацией проходит тест и падает у пользователя. Дефолт — userEvent.
2. **Синхронный getBy после асинхронного действия.** Клик → запрос → рендер. `getByRole('alert')` после `await user.click(...)` найдёт DOM до обновления. Результат — через `findBy*`.
3. **Моки без сброса.** Состояние протекает между тестами: счётчики вызовов растут, моки из теста А отвечают в тесте Б. `afterEach`: `vi.restoreAllMocks()` + `server.resetHandlers()`.
4. **Тест на testId и классы.** Тесты молчаливо разрешают плохую разметку: нет label у инпута, нет имени у кнопки-иконки. Тест на роли это ловит сам — пользуйся.
5. **Слишком много в одном тесте.** «Заполнил форму, сабмитнул, увидел спиннер, дождался ответа, увидел успех, проверил редирект» — при падении непонятно, где. Один тест — один сценарий: ошибка валидации / успех / ошибка сервера / состояние загрузки.
6. **Неотключённые ретраи Query в тестах.** `retry: false` в тестовом QueryClient, иначе тест с упавшим запросом висит в ретраях и флаки.

## Вопросы на собеседовании

**Почему Testing Library советует запросы по ролям?**
Потому что они воспроизводят способ нахождения элементов реальным пользователем (включая пользователей скринридеров) и бесплатно проверяют доступность: нет label — нет getByLabelText, тест падает. Плюс устойчивость к рефакторингу разметки.

**Чем userEvent отличается от fireEvent?**
userEvent симулирует полную последовательность событий устройства (набор посимвольно, hover перед кликом, фокус), fireEvent кинул один DOM-эвент. Для пользовательских сценариев — userEvent; fireEvent — для низкоуровневых случаев (scroll).

**Что такое findBy* и когда его использовать?**
Асинхронный вариант getBy*: возвращает промис, ждёт появления элемента (до таймаута). Используется после действий, запускающих асинхронное обновление: сетевой ответ, таймер, переход состояния.

**Зачем MSW, если можно замокать fetch?**
Стаб fetch'а проверяет только факт и аргументы вызова; MSW проходит через весь реальный код запроса (сериализация, заголовки, разбор ответа, обработка статусов). Один источник моков на юнит- и E2E-тесты, ближе к реальности.

**Как тестировать кастомные хуки?**
renderHook + act: рендерим хук в изолированной среде, проверяем result.current, дёргаем возвращённые функции внутри act, rerender с новыми пропсами. Таймеры — через vi.useFakeTimers.

**Что не стоит покрывать юнит-тестами?**
Третьи стороны, стили, очевидные маппинги, детали реализации (количество вызовов хуков, внутренние состояния). Плюс все визуальные проверки — их территория скриншот-тестов.

**Почему тесты на имплементацию хрупкие?**
Они привязаны к внутренней структуре (имена хуков, порядок вызовов, внутренние переменные), которая меняется при любом рефакторинге без изменения поведения. Такие тесты падают без причины, и их перестают доверять — а значит, перестают запускать.

## Практика

1. **Форма от регистрации до ошибки.** Покрой три сценария формы из главы про формы: невалидный email (ошибка через findByRole('alert')), валидный сабмит (MSW вернул 200 → показан успех), серверная ошибка (MSW вернул 400 → ошибка на поле). Запросы — только по ролям и меткам.
2. **Дебаунс-хук.** Напиши тест для useDebounce через renderHook: смена значения не меняет результат до задержки, после advanceTimersByTime — меняет. Перепиши на vi.useFakeTimers и сравни скорость прогона.
3. **Список с Query.** Компонент с useQuery списка постов: MSW отдаёт данные → посты видны; MSW отдаёт 500 → показан errorElement. QueryClient в тестах с retry: false.
4. **Рефакторинг под тестами.** Возьми любой свой компонент, напиши на него тест поведения, затем перепиши внутренности (useState → useReducer, локальный стейт → Zustand) и убедись, что тест зелёный. Это и есть ощущение «страховки».
5. **Чек-лист чего не тестировать.** Пройдись по своему существующему набору тестов (или представь его) и выпиши тесты, которые привязаны к имплементации. Перепиши два из них на поведение.

## Что почитать

- [Testing Library: Guiding Principles](https://testing-library.com/docs/guiding-principles/) — философия, на которой стоит всё остальное.
- [Testing Library: Queries priority](https://testing-library.com/docs/queries/about#priority) — порядок предпочтительности запросов.
- [userEvent: API](https://testing-library.com/docs/user-event/intro) — полный набор взаимодействий и отличия от fireEvent.
- [Vitest: Getting Started](https://vitest.dev/guide/) — раннер, фейки таймеров, моки, покрытие.
- [MSW: Getting Started](https://mswjs.io/docs/getting-started) — мокание сети для тестов и разработки.
