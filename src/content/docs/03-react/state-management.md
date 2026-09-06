---
title: "Управление состоянием: Zustand, Redux Toolkit, TanStack Query"
description: "Четыре категории состояния, клиентские сторы Zustand и Redux Toolkit, серверное состояние через TanStack Query: кэш, мутации, инвалидация."
---

«Какую библиотеку состояния выбрать?» — вопрос, на который нельзя ответить, не задав другой: **какое именно состояние ты имеешь в виду?** Опыт показывает, что в реальных приложениях живут четыре разных зверя, и попытка держать их всех в одном сторе порождает монстров: тысячи строк бойлерплейта, ручной кэш поверх данных из API и дублирование того, что браузер уже умеет (URL). Разложим зверей по клеткам, а потом разберём инструменты, которые лучше всех справляются со своей клеткой.

## Четыре категории состояния

1. **Локальное (UI-состояние компонента).** Значение инпута, открыт ли дропдаун, hover-флаг. Живёт внутри одного компонента и умирает вместе с ним. Инструмент: `useState`/`useReducer`. Никакие сторы не нужны — их введение здесь это over-engineering.
2. **Серверное состояние.** Данные из API: список товаров, профиль пользователя, статус заказа. Характеристики: живёт на сервере, может устареть, одинаково нужно многим компонентам, требует кэширования, дедупликации, ретраев и инвалидации. Инструмент: **TanStack Query** (подробно ниже).
3. **URL-состояние.** Текущий маршрут, query-параметры (`?page=2&sort=price`), выбранная вкладка, которой можно поделиться ссылкой. Инструмент: React Router (глава 7). Правило: если состояние можно восстановить из URL — держи его в URL, а не в сторе. «Пофиксить» баг «при обновлении страницы сбрасывается фильтр» можно только так.
4. **Клиентское глобальное состояние.** Тема оформления, открыт ли сайдбар, корзина, состояние авторизации. Живёт в браузере, не хранится на сервере (или хранится, но кэшируется), нужно многим несвязанным компонентам. Инструменты: **Zustand** или Redux Toolkit.

Главный вывод этой классификации: локальное состояние в стор не тащим, серверное состояние в стор не тащим (ему нужен кэш-менеджер), URL-состояние в стор не тащим. В глобальный стор остаётся четвёртая категория — и её немного.

## Zustand: клиентский стор без церемоний

Zustand — минималистичный стейт-менеджер: один хук, ноль провайдеров, ноль бойлерплейта. Стор создаётся функцией `create`, которая принимает колбэк с `set`/`get` и возвращает хук:

```tsx
import { create } from 'zustand';

interface CartState {
  items: CartItem[];
  isOpen: boolean;
  addItem: (product: Product) => void;
  removeItem: (id: string) => void;
  toggleCart: () => void;
  total: () => number; // или селектором снаружи
}

export const useCart = create<CartState>((set, get) => ({
  items: [],
  isOpen: false,
  addItem: (product) =>
    set((state) => {
      const existing = state.items.find((i) => i.id === product.id);
      return existing
        ? {
            items: state.items.map((i) =>
              i.id === product.id ? { ...i, qty: i.qty + 1 } : i,
            ),
          }
        : { items: [...state.items, { ...product, qty: 1 }] };
    }),
  removeItem: (id) =>
    set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
  toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
  total: () => get().items.reduce((sum, i) => sum + i.price * i.qty, 0),
}));
```

Использование — как обычный хук, но с **селектором**:

```tsx
// ✅ Подписались ТОЛЬКО на items — рендер при изменении items
const items = useCart((s) => s.items);
const addItem = useCart((s) => s.addItem);

// ❌ Подписка на весь стор — рендер при ЛЮБОМ изменении
const { items, isOpen } = useCart();
```

Селекторы — гранулярность подписки. Zustand сравнивает результат селектора с предыдущим (по `Object.is`) и рендерит только если он изменился. Плохой селектор возвращает новый объект каждый раз → лишние рендеры:

```tsx
// ❌ Новый объект каждый вызов — подписка срабатывает всегда
const { items, total } = useCart((s) => ({
  items: s.items,
  total: s.items.reduce((a, i) => a + i.price * i.qty, 0),
}));

// ✅ Или два отдельных селектора, или useShallow из zustand/react/shallow
const items = useCart((s) => s.items);
const total = useCart((s) => s.items.reduce((a, i) => a + i.price * i.qty, 0));
```

### Почему не Context

Классический вопрос собеседований. Context — механизм **продвижения значений вниз по дереву**, а не стейт-менеджер:

| Критерий | Context + useState | Zustand |
|---|---|---|
| Подписка | Все потребители рендерятся при любом изменении значения | Гранулярно по селекторам |
| Провайдеры | Нужны, вложенность, влияние на дерево | Не нужны |
| Вне React | Нет (только внутри компонентов) | Да: `useCart.getState()`, подписка вне компонентов |
| Перформанс | Значение-объект в контексте ломает мемоизацию детей | Вне дерева — на рендеры не влияет |

Правило: Context — для зависимостей, меняющихся редко (тема, локаль). Для часто обновляемого состояния (корзина, формы, чат) Context создаёт каскад лишних рендеров — бери Zustand.

### Мидлвары и devtools

Zustand поддерживает мидлвары — обёртки над `set`:

```tsx
import { devtools, persist } from 'zustand/middleware';

export const useCart = create<CartState>()(
  devtools(
    persist(
      (set) => ({ /* ... */ }),
      { name: 'cart-storage' }, // корзина переживёт перезагрузку
    ),
    { name: 'CartStore' }, // имя в Redux DevTools
  ),
);
```

`persist` — сериализация в localStorage с мерджем при загрузке. `devtools` — интеграция с Redux DevTools: тайм-тревел, инспекция actions. Для продакшен-отладки это дёшево и бесценно одновременно.

## Redux Toolkit: когда он оправдан

Redux Toolkit (RTK) — современное лицо Redux: `createSlice` убирает 80% старого бойлерплейта, Immer встроен, thunk-ы из коробки. Но философия прежняя: **единый стор, actions, reducer'ы, однонаправленный поток**.

```tsx
import { createSlice, configureStore } from '@reduxjs/toolkit';

const cartSlice = createSlice({
  name: 'cart',
  initialState: { items: [] as CartItem[] },
  reducers: {
    addItem(state, action: PayloadAction<Product>) {
      // Immer позволяет «мутировать» draft — под капотом иммутабельное обновление
      const existing = state.items.find((i) => i.id === action.payload.id);
      if (existing) existing.qty += 1;
      else state.items.push({ ...action.payload, qty: 1 });
    },
  },
});

const store = configureStore({
  reducer: { cart: cartSlice.reducer },
});

export type RootState = ReturnType<typeof store.getState>;
export const { addItem } = cartSlice.actions;
```

Когда RTK **оправдан**:

- Крупная legacy-кодбаза уже на Redux — консистентность важнее моды.
- Команда большая и привыкла к строгой структуре: единые соглашения, кодогенерация, фича-слайсы.
- Нужны продвинутые devtools-инспекции, time-travel debugging, строгая трассировка каждого изменения состояния (финансовые приложения, админки с аудитом).
- RTK Query уже встроен — если нужен и стор, и кэш в одном фреймворке.

Когда **не оправдан**: новый проект с нуля, маленькая команда, обычный продукт. Zustand даст те же задачи на 60% меньше кода. Дисциплина «actions → reducers» в Zustand воспроизводится самим собой: действия — именованные методы стора, переходы — чистые функции в `set`. Тестируемость тоже на месте.

## TanStack Query: серверное состояние как первоклассный житель

Вернёмся к категории 2. Список товаров из API — это не «состояние» в реактивном смысле, это **кэш удалённых данных**. Ручной подход (useState + useEffect + fetch) заставляет тебя самому решать: когда перезапрашивать, как дедуплицировать параллельные запросы, что показывать при повторном посещении страницы, как обновлять после мутации. TanStack Query (React Query) решает это инфраструктурно.

### Queries: чтение с кэшем

```tsx
import { useQuery } from '@tanstack/react-query';

function ProductsPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ['products', { page, sort }], // ключ = идентичность данных
    queryFn: () => fetchProducts({ page, sort }),
    staleTime: 60_000, // минута «свежести» — повторных запросов не будет
  });

  if (isPending) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return <ProductList items={data} />;
}
```

Ключ `queryKey` — сердце библиотеки: это идентификатор данных в кэше. Тот же ключ = те же данные: два компонента с одинаковым ключом получат один запрос (дедупликация), повторный визит страницы в пределах staleTime — данные из кэша без запроса, устаревшие данные — фоновый refetch с мгновенным показом старого (cache-then-network). Поведение, за которое раньше писали сотни строк, появляется из декларации ключа.

### Mutations: запись с инвалидацией

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

function AddToCartButton({ product }: { product: Product }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (p: Product) => api.addToCart(p.id),
    onSuccess: () => {
      // закэшированные списки, зависящие от корзины, устарели — перезапросим
      queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
  });

  return (
    <button disabled={mutation.isPending} onClick={() => mutation.mutate(product)}>
      {mutation.isPending ? 'Добавляем…' : 'В корзину'}
    </button>
  );
}
```

Мутация — императивная операция (`mutate`). Её флаги (`isPending`, `isError`, `isSuccess`) заменяют ручное состояние кнопки. Главное — `invalidateQueries`: точечный сброс кэша по префиксу ключа, после чего Query сам перезапросит активные подписчики. Больше никаких «забыл обновить список после добавления».

### Инвалидация и optimistic updates

Базовый цикл: мутация → onSuccess → invalidate. Для отзывчивости — **optimistic update**: сразу меняем кэш, при ошибке — откат:

```tsx
const mutation = useMutation({
  mutationFn: toggleTodo,
  onMutate: async (id) => {
    await queryClient.cancelQueries({ queryKey: ['todos'] }); // заморозить фоновые обновления
    const previous = queryClient.getQueryData(['todos']);
    queryClient.setQueryData(['todos'], (old: Todo[]) =>
      old.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
    return { previous }; // контекст для отката
  },
  onError: (_err, _vars, context) => {
    queryClient.setQueryData(['todos'], context.previous); // откат
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: ['todos'] }),
});
```

Это паттерн «предсказание + сверка»: UI мгновенный, сервер — источник правды, расхождения лечатся инвалидацией.

### Query против ручного fetch

| Задача | Ручной fetch в useEffect | TanStack Query |
|---|---|---|
| Кэш между компонентами | Нет (или руками) | По queryKey |
| Дедупликация одновременных запросов | Нет | Да |
| Фоновое обновление устаревших данных | Нет | Автоматически (refetchOnWindowFocus, staleTime) |
| Состояния loading/error | Ручные useState | isPending, error, isFetching |
| Обновление после мутации | Ручная синхронизация | invalidateQueries |
| Отмена запросов | AbortController руками | signal из queryFn + автоотмена |

Когда ручной fetch всё же уместен: разовые вызовы, не кэшируемые данные (аналитика), формы с отправкой. Для всего, что читается и перечитывается, — Query.

:::tip[DevTools]
TanStack Query Devtools показывают кэш целиком: какие ключи живы, какие устарели, когда был последний fetch. При дебаге «почему страница не перезапросилась» это первое место для смотреть.
:::

### Стор вне React: подписка без компонентов

Zustand умеет работать там, где нет хуков: внешние модули, обработчики запросов, WebSocket-клиенты. Доступ через `getState`/`setState` и подписка через `subscribe`:

```tsx
// модуль apiClient.ts — токен доступен вне компонентов
import { useAuth } from './authStore';

apiClient.interceptors.request.use((config) => {
  // getState() — мгновенный снимок, без подписки на обновления
  const token = useAuth.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// реакция на изменение: обновили токен — переустановили соединение WS
useAuth.subscribe((state, prev) => {
  if (state.token !== prev.token) {
    wsClient.reconnect(state.token);
  }
});
```

Это закрывает задачу «как получить актуальный токен в axios-интерцепторе» — классическую боль, для которой в Redux приходилось выносить store в отдельный модуль и импортировать его кругами. В Zustand стор — самодостаточный объект, удобный и внутри React, и снаружи.

### Пагинация и предзагрузка в Query

Query хорошо ложится на «бесконечные» списки и позволяет предзагружать следующую страницу до того, как пользователь до неё доскроллил:

```tsx
import { useInfiniteQuery } from '@tanstack/react-query';

function useProducts() {
  return useInfiniteQuery({
    queryKey: ['products', 'infinite'],
    queryFn: ({ pageParam = 1 }) => fetchProducts(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextPage ?? undefined,
    staleTime: 30_000,
  });
}

// предзагрузка при наведении на кнопку «Дальше» — мгновенный переход
const queryClient = useQueryClient();
const prefetchNext = () => {
  if (!hasNextPage) return;
  queryClient.prefetchQuery({
    queryKey: ['products', 'infinite'],
    // точный ключ следующей страницы — Query сам доклеит данные
    queryFn: () => fetchProducts(data.pages.length + 1),
  });
};
```

`getNextPageParam` объясняет Query, где конец списка; `fetchNextPage` доклеивает страницы в один массив `data.pages`. Предзагрузка по hover — дешёвый трюк, превращающий «спиннер на странице» в мгновенную реакцию. Тот же `prefetchQuery` работает и для карточек товаров: при наведении на ссылку грузим детали — страница открывается сразу с данными.

## Типичные ошибки и грабли

1. **Всё в один стор.** Серверные данные в Zustand/Redux → ручной кэш без TTL, инвалидации и дедупликации. Классифицируй состояние до выбора инструмента.
2. **Селектор возвращает новый объект.** `useStore((s) => ({ a: s.a }))` — рендер на каждое обновление стора. Правило: селектор возвращает примитив или стабильную ссылку; нужно несколько значений — несколько селекторов или `useShallow`.
3. **Корзина/тема в Context.** Каждое изменение рендерит всех потребителей и ломает мемоизацию веток. Часто обновляемое глобальное состояние — территория Zustand.
4. **Query без staleTime.** По умолчанию данные «устаревают» мгновенно и refetch'атся при каждом монтировании. Поставь осмысленный staleTime (30–60 с) — и половина «лишних» запросов исчезнет.
5. **Ключи queryKey неполные.** `['products']` вместо `['products', page, sort]` — разные страницы делят кэш, данные перемешиваются. Ключ должен однозначно идентифицировать ответ.
6. **Забытая инвалидация после мутации.** Данные обновились на сервере, кэш — нет; пользователь видит старое до перезагрузки. Проверка проста: после каждой мутации должен быть либо invalidate, либо setQueryData.

## Вопросы на собеседовании

**Какие категории состояния выделяют в React-приложениях?**
Локальное (компонент, useState), серверное (кэш API — TanStack Query), URL-состояние (роутер), клиентское глобальное (Zustand/Redux). Ключевой навык — правильно классифицировать данные до выбора инструмента.

**Zustand против Context: в чём принципиальная разница?**
Context — транспорт значений вниз по дереву: любое изменение рендерит всех потребителей, нужны провайдеры, не работает вне React. Zustand — вне дерева, подписка по селекторам гранулярна, есть доступ извне (`getState`). Для часто меняющегося состояния Zustand выигрывает по перформансу и эргономике.

**Когда Redux Toolkit оправдан в новом проекте?**
Редко: большая команда со сложившимися Redux-соглашениями, требование аудита/time-travel, интеграция с RTK Query как единым фреймворком. Для большинства новых проектов Zustand проще и достаточен.

**Что такое queryKey в TanStack Query и почему он важен?**
Идентификатор кэшируемых данных. Определяет дедупликацию, персистентность кэша между компонентами, инвалидацию по префиксу. Правило: ключ должен однозначно описывать параметры запроса.

**Как TanStack Query обновляет данные после мутации?**
`invalidateQueries({ queryKey })` помечает кэш устаревшим — активные подписчики автоматически перезапросятся. Для мгновенного UX — optimistic update через `onMutate`/`setQueryData` с откатом в `onError`.

**Что показывает флаг isPending в useQuery и чем он отличается от isFetching?**
`isPending` — данных ещё нет вообще (первый запрос), для показа полноэкранного спиннера. `isFetching` — идёт любой запрос (включая фоновый refetch при наличии кэша), для индикатора «обновляется».

**Почему нельзя хранить URL-состояние в сторе?**
Потому что теряются глубокие ссылки, кнопка «назад» и восстановление сессии. Если состояние выводимо в адресную строку — оно обязано там жить. Стор для того, чего в URL быть не может.

## Практика

1. **Классификация.** Возьми свой текущий или воображаемый проект, выпиши 15 кусков состояния и разложи по четырём категориям. Найди хотя бы один кусок серверного состояния, который ты бы положил в стор, — перенеси его ментально в Query.
2. **Корзина на Zustand.** Стор: товары, добавление (с увеличением количества), удаление, очистка. Итоговая сумма — через селектор. Добавь `persist` и проверь переживание перезагрузки. Замерь рендеры: подписка на весь стор против селекторов.
3. **Query с пагинацией.** Список постов: `useQuery` с ключом `['posts', page]`, кнопки «назад/вперёд». Проверь: возврат на предыдущую страницу не шлёт запрос (кэш), staleTime 30 с.
4. **Мутация с инвалидацией.** Добавление поста: `useMutation` → `invalidateQueries(['posts'])`. Затем — optimistic update с откатом при ошибке. Сравни UX обоих вариантов при медленной сети (эмулируй в DevTools).
5. **Два стора и их граница.** Сделай Zustand-стор для UI (тема, сайдбар) и Query для данных (профиль). Покажи, что смена темы не перезапрашивает профиль, а смена профиля не трогает тему. Это и есть правильная граница ответственности.

## Что почитать

- [Zustand: документация](https://zustand.docs.pmnd.rs/getting-started/introduction) — гайды по селекторам, мидлварам, TypeScript-типизации.
- [Redux Toolkit: официальный туториал](https://redux-toolkit.js.org/tutorials/quick-start) — современный Redux за один вечер.
- [TanStack Query: Queries](https://tanstack.com/query/latest/docs/framework/react/guides/queries) и [Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations) — фундамент серверного состояния.
- [TanStack Query: Query Keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys) — как проектировать ключи.
- [You Might Not Need Redux (Dan Abramov)](https://medium.com/@dan_abramov/you-might-not-need-redux-be46360cf367) — классическая статья о том, чем Redux заменяется, — до сих пор актуальна.
