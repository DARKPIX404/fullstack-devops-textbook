---
title: "Продвинутые хуки: измерения, приоритеты и кастомные хуки"
description: "useLayoutEffect, useId, useTransition, useDeferredValue, правила хуков и кастомные хуки как механизм переиспользования логики."
---

Базовые хуки закрывают 90% задач. Оставшиеся 10% — особые ситуации: измерить DOM без визуального дёрганья, связать label с input безопасно для SSR, не дать тяжёлому списку подвесить ввод, и — самое важное — вынести логику из компонентов в переиспользуемые кастомные хуки. Эта глава про инструменты редкие, но каждый решает конкретную, узнаваемую проблему. А финал главы — контракт кастомных хуков, который превратит твой код из «компоненты на 300 строк» в композицию маленьких, тестируемых единиц.

## useLayoutEffect: синхронно до отрисовки

`useLayoutEffect` ведёт себя как `useEffect`, но с критичным отличием по таймингу:

```
useEffect:       render → commit (DOM обновлён) → paint → эффект
useLayoutEffect: render → commit (DOM обновлён) → эффект → paint
```

Эффект в `useLayoutEffect` выполняется **синхронно сразу после изменений DOM, но до того, как браузер нарисует кадр**. Пользователь не успеет увидеть промежуточное состояние.

Когда это нужно? Когда эффект меняет то, что пользователь увидит, и промежуточный кадр был бы заметен:

```tsx
// Тултип: позиционируем относительно якоря
function Tooltip({ anchorRef, children }: Props) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;

    const rect = anchor.getBoundingClientRect();
    // Считаем позицию и ставим её ДО paint — тултип появится сразу на месте
    setPosition({
      top: rect.bottom + window.scrollY + 8,
      left: rect.left + window.scrollX,
    });
  }, [anchorRef]);

  return (
    <div ref={tooltipRef} style={{ position: 'absolute', ...position }}>
      {children}
    </div>
  );
}
```

С обычным `useEffect` был бы виден кадр: тултип мелькнул бы в (0, 0), а потом «прыгнул» на место. С `useLayoutEffect` кадр с неправильной позицией просто не рисуется.

:::caution[Платишь за синхронность]
`useLayoutEffect` блокирует отрисовку: пока твой эффект не завершится, браузер не нарисует кадр. Тяжёлая логика внутри — это фризы интерфейса. Правило: если не уверен, что промежуточный кадр заметен — используй `useEffect`. `useLayoutEffect` — осознанное исключение.
:::

Ещё одно ограничение: на сервере (SSR) `useLayoutEffect` не вызывается, и React выдаёт предупреждение — изоморфные библиотеки обходят это через `useIsomorphicLayoutEffect` (выбор хука в зависимости от среды).

### На практике: ResizeObserver внутри layout-эффекта

Измерения DOM почти всегда сопровождаются наблюдением за изменениями размеров. Паттерн: layout-эффект создаёт observer, cleanup его отключает:

```tsx
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // первое измерение — синхронно, до paint, чтобы не было дёрганья
    setSize({ width: el.offsetWidth, height: el.offsetHeight });

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(el);

    return () => observer.disconnect(); // симметричная очистка
  }, []);

  return [ref, size] as const;
}

// const [boxRef, boxSize] = useElementSize<HTMLDivElement>();
```

Такой хук закрывает и задачу «текстовая область с автовысотой», и «виртуальный скролл, знающий высоту контейнера». Обрати внимание: первое измерение именно в layout-эффекте — если отложить его в обычный эффект, пользователь увидит кадр с неправильными размерами.

## useId: доступные связи без коллизий

Проблема: связать `<label htmlFor>` с `<input id>` уникальным id. Неуникальные id ломают a11y (клик по label фокусирует чужой инпут), а генерация через `Math.random()` в рендере ломает SSR-гидратацию: на сервере id один, в браузере после гидратации — другой, React ругается на несовпадение разметки.

`useId` генерирует детерминированный, уникальный в пределах приложения и **стабильный между сервером и клиентом** id:

```tsx
function EmailField() {
  const id = useId(); // ":r0:", ":r1:" — префиксный формат React

  return (
    <>
      <label htmlFor={id}>Email</label>
      <input id={id} type="email" aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`}>Мы не передаём email третьим лицам.</p>
    </>
  );
}
```

Префикс `:` в id невалиден для querySelector, но для htmlFor/aria-атрибутов валиден. Если нужен «чистый» id (например, для CSS или querySelector) — добавь префикс: `const fieldId = \`email-${useId()}\``. Важно: `useId` не предназначен для ключей списков — он уникален для *инстанса* компонента, а не для элемента данных.

## useTransition и startTransition: срочное vs отложенное

Вернёмся к Fiber из главы про рендеринг. Конкурентный рендеринг позволяет React прерывать несрочную работу ради срочной. Но как React узнаёт, что срочно? Только ты знаешь. `startTransition` — маркер: «всё внутри — несрочно, можно прервать».

```tsx
const [query, setQuery] = useState('');           // срочно: инпут должен отвечать мгновенно
const [results, setResults] = useState<Result[]>([]); // несрочно: список подстроится позже
const [isPending, startTransition] = useTransition();

const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const value = e.target.value;
  setQuery(value); // urgent update — вне transition

  startTransition(() => {
    setResults(filterHugeCatalog(value)); // non-urgent — можно прервать следующим keystroke
  });
};
```

Механика: urgent-обновления (ввод, клики) всегда имеют приоритет. Транзишен-обновление, если пришло новое — прерывается и пересчитывается с нуля. Пользователь печатает быстро — дорогая фильтрация списка не запускается на каждый символ подряд, а только на последний актуальный запрос. `isPending` — флаг «идёт фоновый пересчёт», для спиннера поверх устаревающего списка.

Без transition та же сцена: фильтрация на 5000 элементов блокирует рендер → инпут подтормаживает → ощущение «тяжёлого приложения». С transition: инпут летает, список догоняет. Это не ускоряет вычисление — оно управляет приоритетом.

Есть и императивная форма `startTransition(fn)` без хука — для случаев вне компонента (например, в обработчике сторонней библиотеки).

:::tip[Transition ≠ дебаунс]
Дебаунс откладывает работу на N мс после события. Transition начинает работу сразу, но с низким приоритетом и прерываемостью. Для фильтрации по вводу transition предпочтительнее: результат появляется быстрее, а UX не хуже.
:::

## useDeferredValue: отложенное значение

Иногда нельзя пометить сеттер как transition — значение приходит извне (пропс, стейт родителя). `useDeferredValue` отдаёт «отстающую копию» значения: срочный рендер идёт с новым значением, а дорогое поддерево, использующее отложенное, получит его позже:

```tsx
function SearchPage({ query }: { query: string }) {
  const deferredQuery = useDeferredValue(query);

  return (
    <>
      {/* индикатор фонового пересчёта */}
      {query !== deferredQuery && <Spinner />}
      {/* тяжёлый список рендерится с отставанием — не блокирует ввод */}
      <ProductList query={deferredQuery} />
    </>
  );
}
```

Классическая пара с дебаунсом: `useDeferredValue` — «рендери по свежим данным, но не блокируй», дебаунс — «жди тишины N мс». Для живого поиска часто берут оба: дебаунс на запрос к API, deferred на локальную фильтрацию.

## Правила хуков и почему они существуют

Два правила из v1, но теперь — с объяснением механизма:

1. **Хуки вызываются только на верхнем уровне** — не в `if`, циклах, вложенных функциях.
2. **Хуки вызываются только из React-компонентов и кастомных хуков.**

Почему: внутри React для каждого компонента хранится **связанный список хуков** (hook list) — массив ячеек состояния. Вызов `useState` не «по имени переменной» идентифицируется, а **по позиции в порядке вызовов**: первый `useState` → ячейка 0, второй → ячейка 1, и так далее. Условный вызов меняет длину списка между рендерами: в одном рендере ячеек три, в другом две — React привяжет состояние к чужой ячейке или упадёт с «Rendered fewer hooks than expected». Никакой магии с имёнами переменных — только порядок.

```tsx
// ❌ Ломаем порядок: в одном рендере 2 хука, в другом 3
function Bad({ isAdmin }: { isAdmin: boolean }) {
  const [name] = useState('Ann');
  if (isAdmin) {
    const [stats] = useState(null); // позиция «прыгает»
  }
  const [age] = useState(25);
}
```

Линтер `eslint-plugin-react-hooks/rules-of-hooks` статически анализирует код и ловит нарушения — ставь его обязательно. Кастомные хуки (`use`-префикс) распознаются им автоматически, что ведёт к последней, самой практичной теме главы.

:::note[React Compiler и будущее правил]
В React-команде развивается React Compiler — статический оптимизатор, который мемоизирует рендеры автоматически. Одно из его жёстких требований — **строгое соблюдение правил хуков и чистоты рендера**: компилятор строит модель данных потока и не может оптимизировать компонент, который читает или пишет внешнее состояние в рендере. Так что правила хуков — не временное ограничение старой архитектуры, а контракт, на который опираются и будущие оптимизации.
:::

## Кастомные хуки: контракт переиспользования

Кастомный хук — функция с префиксом `use`, которая вызывает другие хуки. Это **не** новый механизм React: тот же список хуков, просто код организован иначе. Контракт прост: хук получает входные данные, возвращает значения; внутри — любые хуки, эффекты, ref'ы. UI не возвращает никогда (это работа компонентов).

Ценность — тривиальная, но революционная: **логика отделяется от представления**. Один и тот же код подписки/таймера/запроса работает в компоненте, в другом хуке, в тесте без DOM.

### useLocalStorage: состояние с персистентностью

```tsx
import { useState, useEffect, useCallback } from 'react';

function useLocalStorage<T>(key: string, initialValue: T) {
  // Ленивая инициализация — читаем из хранилища один раз
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      return initialValue; // битый JSON — не падаем
    }
  });

  // Синхронизация с внешней системой (localStorage) — это эффект
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // квота переполнена — молча игнорируем или логируем
    }
  }, [key, value]);

  return [value, setValue] as const;
}

// использование — компонент не знает про JSON и эффекты
const [theme, setTheme] = useLocalStorage('theme', 'dark');
```

Обрати внимание: та же ментальная модель из главы 2 — состояние + эффект-синхронизация с внешним миром, упакованные в переиспользуемую единицу.

### useMediaQuery: подписка на внешний источник

```tsx
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);

    setMatches(mql.matches); // актуализируем при смене query
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange); // симметричная очистка
  }, [query]);

  return matches;
}

// const isMobile = useMediaQuery('(max-width: 768px)');
```

Здесь кастомный хук прячет подписку с корректным cleanup — та самая симметрия, которую StrictMode проверяет двойным вызовом.

### useDebounce: отложенное значение

```tsx
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer); // отменяем предыдущий таймер при смене value
  }, [value, delayMs]);

  return debounced;
}

// const debouncedQuery = useDebounce(query, 300);
// fetch срабатывает только когда пользователь перестал печатать
```

Этот же хук оборачивается вокруг API-вызова: `useEffect(() => { search(debouncedQuery) }, [debouncedQuery])` — и получаем классический «поиск с задержкой» без единой строки логики в компоненте.

:::tip[Когда выносить в хук]
Правило большого пальца: как только логика занимает больше ~10 строк, не связана напрямую с разметкой или используется в двух+ компонентах — выноси. Хук дешевле компонента, тестируется проще и читается как сценарий.
:::

### Композиция: хуки из хуков

Кастомные хуки компонуются друг с другом, как функции. Сложное поведение собирается из простых блоков — и каждый блок тестируется изолированно:

```tsx
// данные + состояние загрузки + отмена — всё спрятано в хуках
function useProductSearch(query: string) {
  const debounced = useDebounce(query, 300);
  const [page, setPage] = useState(1);

  const { data, isPending } = useQuery({
    queryKey: ['products', debounced, page],
    queryFn: ({ signal }) => searchProducts(debounced, page, signal),
  });

  return { data, isPending, page, setPage };
}

// в компоненте — декларативное описание поведения, ноль логики
function SearchPage() {
  const [query, setQuery] = useState('');
  const { data, isPending, page, setPage } = useProductSearch(query);

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      {isPending ? <Spinner /> : <ProductList items={data} />}
      <button onClick={() => setPage(page + 1)}>Дальше</button>
    </>
  );
}
```

Компонент из 10 строк описывает *что показываем*; хуки скрывают *как получаем*. Это тот же принцип разделения ответственности, что и в бэкенде: слой данных отдельно, представление отдельно. Заметь также передачу `signal` из queryFn в fetch — Query отменяет запрос при смене ключа, и AbortController из главы 2 работает здесь бесплатно.

## Типичные ошибки и грабли

1. **useLayoutEffect «на всякий случай».** Синхронность блокирует paint; тяжёлый layout-эффект = фризы. Начинай с `useEffect`, переходи на layout только если видишь визуальный скачок.
2. **useId в ключах списка.** Id уникален на инстанс компонента; два элемента списка, отрендеренные одним компонентом, получат один id. Для ключей — только стабильные id данных.
3. **Transition вокруг срочных обновлений.** Обернул в `startTransition` setState, управляющий вводом? Инпут начнёт отставать — ты сам понизил его приоритет. Transition — только для несрочной части.
4. **Нарушение правил хуков под условием.** «А если тут быстро вернуть до хука?» — сломанный порядок. Ранний return после всех хуков, условия — внутри них.
5. **Кастомный хук, возвращающий JSX.** Это уже не хук, а компонент под видом хука — ломает композицию и тестируемость. Хук возвращает данные и функции.
6. **Хук с нестабильным возвращаемым объектом.** Возвращаешь `{ a, b }` в новой обёртке каждый рендер — любой мемоизированный потребитель сломается. Возвращай `as const`-кортеж или мемоизируй объект.

## Вопросы на собеседовании

**В чём разница между useEffect и useLayoutEffect?**
Оба после commit, но useLayoutEffect — синхронно до отрисовки браузером. Нужен, когда эффект меняет видимое (позиционирование, размеры) и промежуточный кадр был бы заметен. Платёж — блокировка paint, поэтому по умолчанию используют useEffect.

**Для чего useId и почему нельзя Math.random()?**
Стабильные уникальные id для a11y-связей (label/input, aria-describedby), безопасные для SSR (одинаковые на сервере и клиенте). Math.random() в рендере даёт разные id при гидратации — React жалуется на несовпадение разметки.

**Что делает useTransition?**
Помечает обновления состояния как не срочные: React может прерывать и перезапускать такой рендер ради срочных (ввод, клик). Результат — интерактивность при тяжёлых пересчётах. `isPending` сигналит о фоновой работе.

**useTransition против useDeferredValue — что когда?**
Transition — когда контролируешь сеттер (маркируешь обновление). DeferredValue — когда значение приходит извне (пропс) и нужно дать «отстающую копию» для дорогого поддерева. Часто эквивалентны, выбор — по источнику данных.

**Почему хуки нельзя вызывать условно?**
React сопоставляет состояние с хуками по порядку вызова (связанный список ячеек), а не по имени. Условие меняет длину списка → состояние привязывается к чужой ячейке → крах или тихая порча данных.

**Что такое кастомный хук и зачем?**
Функция `useSomething`, вызывающая хуки; возвращает данные/функции, никогда JSX. Механизм переиспользования логики без дублирования компонентов: подписки, хранилища, отложенные значения.

**Как протестировать кастомный хук?**
`@testing-library/react` `renderHook` + `act`: рендерим хук в изолированной среде, дёргаем возвращённые функции, проверяем результат. Либо через компонент-обёртку в полноценном тесте.

## Практика

1. **Тултип без мерцания.** Реализуй тултип с позиционированием через `useLayoutEffect` (getBoundingClientRect якоря → setState позиции). Сравни визуально с версией на `useEffect`: мерцает ли первый кадр?
2. **Доступная форма.** Собери форму из трёх полей; свяжи label и input через `useId` (включая aria-describedby для подсказок). Проверь кликом по label и через скринридер.
3. **Transition-фильтр.** Список 2000 элементов + строка поиска. Замерь отзывчивость ввода, затем оберни фильтрацию в `startTransition` и добавь `isPending`-индикатор. Сравни измерения Profiler'ом.
4. **useDebounce в бою.** Напиши хук `useDebouncedValue` и используй для API-поиска: запрос уходит через 300 мс после остановки ввода. Обязательно с `AbortController` из главы 2 — старые запросы отменяются.
5. **Три кастомных хука.** Портируй логику из практики главы 2 (подписка на online, ref-таймер, localStorage-синхронизация) в хуки `useOnlineStatus`, `useInterval`, `useLocalStorage`. Напиши на один из них тест через `renderHook`.

## Что почитать

- [React Dev: useLayoutEffect](https://react.dev/reference/react/useLayoutEffect) — тайминги и предупреждение про SSR.
- [React Dev: useId](https://react.dev/reference/react/useId) — примеры a11y-связей.
- [React Dev: useTransition](https://react.dev/reference/react/useTransition) и [useDeferredValue](https://react.dev/reference/react/useDeferredValue) — конкурентные примитивы.
- [React Dev: Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks) — эталонный гайд по кастомным хукам.
- [React Dev: Rules of Hooks](https://react.dev/reference/rules/rules-of-hooks) — механика связанного списка хуков.
