---
title: "Роутинг: React Router v6+ и data routers"
description: "Data routers: createBrowserRouter, loaders, actions, useNavigation, errorElement, вложенные маршруты и интеграция с TanStack Query."
---

Роутинг — это не только «показать компонент по URL». В современном React Router это ещё и когда грузить данные, как обрабатывать ошибки загрузки, где ловить исключения и как не превратить каждую страницу в спагетти из `useEffect` с `fetch`. Шестая версия React Router перевернула философию: появились **[data routers](https://reactrouter.com/start/data/routing)** — роутеры, у которых маршруты знают про данные. Data loader грузит до рендера, action обрабатывает мутации, а компонент страницы получает готовые данные. Разберём эту модель до конца и покажем, как она сосуществует с TanStack Query.

## От declarative к data router

До v6.4 роутинг описывался декларативно через `<Routes><Route /></Routes>`, а данные грузились в компонентах через эффекты. Модель работала, но каждая страница тащила одни и те же куски: стейт загрузки, стейт ошибки, эффект с fetch, cleanup с AbortController (глава 2). Data routers перемещают загрузку данных из компонента в конфигурацию маршрута:

```tsx
import {
  createBrowserRouter,
  RouterProvider,
} from 'react-router-dom';

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />, // каркас: шапка, сайдбар, <Outlet />
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'products',
        element: <ProductsPage />,
        loader: productsLoader, // данные грузятся ДО рендера страницы
      },
      {
        path: 'products/:productId',
        element: <ProductPage />,
        loader: productLoader,
        action: productAction, // мутации этого маршрута
        errorElement: <ProductError />, // ошибки лоадера ловятся здесь
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

Ключевые отличия от старой модели:

- Данные грузятся **до** рендера компонента страницы. Пользователь не видит промежуточное состояние «страница отрисована, но данных нет» — роутер ждёт loader и только потом рендерит (или показывает индикатор через `useNavigation`).
- Loader/action — обычные функции вне компонентов. Их легко тестировать, типизировать и переиспользовать.
- Ошибки в loader/action попадают в ближайший `errorElement` — декларативная обработка, без try/catch в каждом компоненте.

## Loaders: данные до рендера

[Loader](https://reactrouter.com/start/data/data-loading) — функция, которая выполняется роутером при навигации на маршрут. Она получает объект с `params`, `request` и должна вернуть данные (или бросить ошибку/`Response`):

```tsx
import { LoaderFunctionArgs } from 'react-router-dom';

interface Product {
  id: string;
  name: string;
  price: number;
}

export async function productLoader({ params }: LoaderFunctionArgs): Promise<Product> {
  const res = await fetch(`/api/products/${params.productId}`);

  if (!res.ok) {
    // throw Response — роутер покажет errorElement этого маршрута
    throw new Response('Товар не найден', { status: res.status });
  }
  return res.json();
}

// в компоненте страницы — данные уже здесь
import { useLoaderData } from 'react-router-dom';

export function ProductPage() {
  const product = useLoaderData() as Product;
  return (
    <article>
      <h1>{product.name}</h1>
      <p>{product.price} ₽</p>
    </article>
  );
}
```

Обрати внимание: `useLoaderData` возвращает `unknown` — приводим к типу (или используем типизацию через дженерик лоадера с учётом возвращаемого типа, если выдерживаешь строгость).

Loader выполняется в момент навигации — **параллельно для всех совпавших маршрутов** (вложенные). Это значит, что каркас приложения не ждёт данные конкретной страницы: layout рендерится сразу, страница — когда её loader завершится. Для глубоко вложенных страниц это заметный UX-выигрыш.

`params` типизируются как `string | undefined` — для строгой типизации есть паттерн с `as` + валидация (в проде — через тот же Zod из главы про формы):

```tsx
export async function productLoader({ params }: LoaderFunctionArgs) {
  const parsed = z.object({ productId: z.string().uuid() }).safeParse(params);
  if (!parsed.success) throw new Response('Некорректный id', { status: 400 });
  // ...
}
```

## Actions: мутации на уровне маршрута

[Action](https://reactrouter.com/start/data/actions) — симметричный loader'у обработчик мутаций: вызывается при `Form`-сабмите или программной `submit()`. Паттерн HTML-форм, но без перезагрузки страницы:

```tsx
import { ActionFunctionArgs, Form, redirect } from 'react-router-dom';

export async function productAction({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const name = formData.get('name');
  const price = Number(formData.get('price'));

  // та же Zod-схема — валидация на серверной границе
  const parsed = productSchema.safeParse({ name, price });
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }; // вернём на форму
  }

  await api.updateProduct(params.productId!, parsed.data);
  return redirect(`/products/${params.productId}`); // редирект после успеха
}

// в компоненте — обычная форма, роутинг сам перехватит сабмит
import { useActionData } from 'react-router-dom';

export function EditProductPage() {
  const actionData = useActionData() as { errors?: Record<string, string> } | undefined;

  return (
    <Form method="post">
      <input name="name" />
      {actionData?.errors?.name && <p role="alert">{actionData.errors.name}</p>}
      <input name="price" type="number" />
      <button type="submit">Сохранить</button>
    </Form>
  );
}
```

Action возвращает данные (`useActionData`) или `redirect`. Loader и action вместе закрывают CRUD-страницу без единого `useState` для состояния формы — минимальный и надёжный вариант для простых случаев.

## Состояния навигации: useNavigation

Роутер сам отслеживает жизненный цикл навигации. [`useNavigation`](https://reactrouter.com/api/hooks/useNavigation) даёт три ключевых состояния:

```tsx
import { useNavigation } from 'react-router-dom';

function AppLayout() {
  const navigation = useNavigation();

  // 'idle' | 'loading' (идёт loader) | 'submitting' (идёт action)
  const isBusy = navigation.state !== 'idle';

  return (
    <>
      {/* полоса загрузки как в GitHub — глобальный индикатор навигации */}
      {isBusy && <div className="progress-bar" />}
      <Outlet />
    </>
  );
}
```

Это убирает ручное управление спиннерами: один индикатор на верхнем уровне покрывает все навигации приложения. Для кнопок сабмита есть `useSubmit`-интеграция и `navigation.formData` (данные текущего сабмита — можно рисовать optimistic UI на уровне роутера).

## errorElement и обработка ошибок

Loader или action бросил исключение или `Response` — роутер ищет ближайший [`errorElement`](https://reactrouter.com/docs) вверх по дереву маршрутов и рендерит его вместо компонента. Ошибка доступна через `useRouteError`:

```tsx
import { useRouteError, isRouteErrorResponse } from 'react-router-dom';

export function ProductError() {
  const error = useRouteError();

  // Response из loader — имеет status
  if (isRouteErrorResponse(error)) {
    return (
      <div>
        <h1>{error.status === 404 ? 'Товар не найден' : 'Ошибка загрузки'}</h1>
        <p>{error.statusText}</p>
        <Link to="/products">← К каталогу</Link>
      </div>
    );
  }

  // Неожиданное исключение — рендерим общий fallback, ошибка уходит в Sentry
  return <h1>Что-то пошло не так. Мы уже разбираемся.</h1>;
}
```

Иерархия errorElement'ов работает как иерархия маршрутов: ошибка в лоадере глубокой страницы ломает только эту страницу (и её вложенные), шапка и навигация живы. Это важное UX-отличие от «ошибка в useEffect сломала всё приложение».

## Вложенные маршруты и Outlet

Вложенность — сильнейшая сторона модели: каркас с шапкой и сайдбаром описывается один раз, страницы — как children, рендерятся в `<Outlet />`:

```tsx
const router = createBrowserRouter([
  {
    path: '/',
    element: <DashboardLayout />, // <Header /> <Sidebar /> <Outlet /> <Footer />
    children: [
      { index: true, element: <OverviewPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />, // вторая вложенность: табы настроек
        children: [
          { index: true, element: <GeneralSettings /> },
          { path: 'security', element: <SecuritySettings /> },
        ],
      },
    ],
  },
]);
```

При навигации между `settings/*` рендерится только Outlet-часть — layout'ы не перерендериваются, состояние шапки (открытый дропдаун поиска) сохраняется. Index-маршрут — «страница по умолчанию» для родителя.

Динамические сегменты (`:productId`) и search-параметры (`?page=2`) — стандарт: `useParams`, `useSearchParams`. Помни классификацию из главы про состояние: если фильтр/пагинация должны переживать перезагрузку и шариться ссылкой — они обязаны жить в URL.

### Search-параметры: состояние, которым можно делиться ссылкой

Классический паттерн списка с пагинацией и фильтрами — всё в URL, ничего в сторе:

```tsx
import { useSearchParams } from 'react-router-dom';

export function ProductsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Number(searchParams.get('page') ?? '1');
  const sort = searchParams.get('sort') ?? 'popular';

  const updateParams = (next: Record<string, string | null>) => {
    // setSearchParams мержит: меняем только переданные ключи
    setSearchParams((prev) => {
      const merged = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(next)) {
        if (value === null) merged.delete(key);
        else merged.set(key, value);
      }
      return merged;
    });
  };

  return (
    <>
      <select
        value={sort}
        onChange={(e) => updateParams({ sort: e.target.value, page: null })}
      >
        <option value="popular">По популярности</option>
        <option value="price">По цене</option>
      </select>
      <ProductList page={page} sort={sort} />
      <button onClick={() => updateParams({ page: String(page + 1) })}>Дальше</button>
    </>
  );
}
```

При смене search-параметров роутер пере-исполняет loader с новым `request.url` — данные перезагружаются, URL обновляется, кнопка «назад» работает как ожидает пользователь. Бонус: ссылка `?sort=price&page=3` открывается на любом устройстве в том же состоянии — бесплатный «шаринг представления».

### defer и Await: стриминг медленных данных

Если часть данных медленная (например, рекомендации грузятся 2 с, а товар — 200 мс), не блокируй всю страницу. `defer` позволяет loader'у вернуть промисы вместо значений:

```tsx
import { defer, Await, useLoaderData } from 'react-router-dom';

export function productLoader({ params }: LoaderFunctionArgs) {
  const product = fetchProduct(params.productId!); // быстрый
  const recommendations = fetchRecommendations(params.productId!); // медленный
  return defer({ product, recommendations }); // оба — промисы
}

export function ProductPage() {
  const data = useLoaderData() as {
    product: Promise<Product>;
    recommendations: Promise<Product[]>;
  };

  return (
    <>
      {/* быстрые данные ждём через Suspense-границу */}
      <React.Suspense fallback={<Skeleton />}>
        <Await resolve={data.product}>{(product) => <ProductCard {...product} />}</Await>
      </React.Suspense>
      {/* медленные — со своим спиннером, страница уже интерактивна */}
      <React.Suspense fallback={<RecommendationsSkeleton />}>
        <Await resolve={data.recommendations}>
          {(items) => <Recommendations items={items} />}
        </Await>
      </React.Suspense>
    </>
  );
}
```

### useFetcher: мутации без навигации

Action обычно сопровождается навигацией (redirect). А если нужна кнопка «в избранное», которая шлёт POST и остаётся на месте? `useFetcher` — action без перехода:

```tsx
import { useFetcher } from 'react-router-dom';

export function FavoriteButton({ productId }: { productId: string }) {
  const fetcher = useFetcher();
  const favorite = fetcher.formData?.get('favorite') === 'true'; // optimistic из formData

  return (
    <fetcher.Form method="post" action={`/products/${productId}/favorite`}>
      <button
        type="submit"
        name="favorite"
        value={favorite ? 'false' : 'true'}
        disabled={fetcher.state !== 'idle'}
      >
        {favorite ? '★ В избранном' : '☆ В избранное'}
      </button>
    </fetcher.Form>
  );
}
```

Fetcher имеет собственные состояния (`state`, `data`, `formData`) — кнопка показывает прогресс, не трогая остальной UI. Отличная альтернатива `useMutation`, когда приложение уже построено на data routers и Query поверх него не нужен.

### Защищённые маршруты: проверка в loader

Авторизация на уровне роутинга — проверка в loader родительского маршрута: если сессии нет, бросаем redirect, который ловится роутером как навигация:

```tsx
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    // redirect — специальный Response; роутер выполнит навигацию
    throw redirect('/login?from=' + encodeURIComponent(location.pathname));
  }
  return session;
}

export const dashboardLoader = async () => {
  const session = await requireAuth(); // все дети защищены
  return { user: session.user };
};
```

Проверка в loader (а не в useEffect) важна: она гарантированно выполнится до рендера защищённого экрана — никакой «мигания» приватного контента.

### Ленивые маршруты и код-сплиттинг

Каждый маршрут — потенциальная граница сплиттинга: страницу админки не нужно грузить обычному пользователю, а тяжёлую страницу отчётов — грузить до первого визита. Data router поддерживает `lazy` прямо в конфигурации:

```tsx
const router = createBrowserRouter([
  { index: true, element: <HomePage /> },
  {
    path: 'reports',
    // code splitting на уровне маршрута: chunk грузится при первом переходе
    lazy: () => import('./pages/ReportsPage'), // экспортирует Component, loader, action
  },
  {
    path: 'admin',
    lazy: () => import('./pages/AdminPage'),
  },
]);
```

Ленивый модуль экспортирует не только компонент, но и его `loader`/`action` — они попадут в тот же chunk и не раздувают основной бандл. В сочетании с `defer` (выше) это даёт контроль над весом приложения на уровне навигации: метрика — не «сколько весит бандл», а «сколько весит путь до первого взаимодействия» (route-level code splitting — главный инструмент её улучшения; подробно про метрики и размеры — в разделе о сборке).

## Интеграция с TanStack Query

Возникает конфликт: TanStack Query (глава 5) тоже грузит данные, тоже кэширует. Два загрузчика на одной странице — избыточность. Решение — разделить роли: **Query — владелец данных, Router — владелец навигации**. Loader становится тонким мостом, дёргающим Query-клиент:

```tsx
import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();

export const productLoader =
  (queryClient: QueryClient) =>
  async ({ params }: LoaderFunctionArgs) => {
    // prefetchQuery: данные попадут в кэш Query, повторного запроса не будет
    await queryClient.ensureQueryData({
      queryKey: ['product', params.productId],
      queryFn: () => fetchProduct(params.productId!),
      staleTime: 60_000,
    });
    return null; // данные возьмём в компоненте из Query
  };

// конфигурация
{
  path: 'products/:productId',
  loader: productLoader(queryClient),
  element: <ProductPage />,
}

// в компоненте — обычный useQuery, кэш уже тёплый
export function ProductPage() {
  const { productId } = useParams();
  const { data: product } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => fetchProduct(productId!),
  });
  // ...
}
```

Теперь у тебя одна система данных (Query: кэш, инвалидация, дедупликация), а роутер отвечает только за тайминг: показать индикатор навигации, дождаться данных до рендера, словить ошибку в errorElement. Мутации по-прежнему идут через `useMutation` с `invalidateQueries` — action роутера здесь не нужен, иначе будет две системы мутаций.

Альтернатива — чистые data routers без Query (loader/action напрямую ходят в fetch, как в примерах выше): оправдано для простых приложений, где кэширование и оптимистичные обновления не нужны. Порог входа ниже, но на росте проекта ты начнёшь воссоздавать Query вручную — типичный момент миграции.

## Типичные ошибки и грабли

1. **Грузить данные в компоненте, хотя есть loader.** Двойная загрузка: loader ждёт, компонент сразу фетчит ещё раз. Выбери одну точку входа (loader как prefetch для Query, либо только useQuery).
2. **params без валидации.** `params.productId` — это `string | undefined` из URL, а значит — недоверенный ввод. Zod-парсинг в loader защищает и от невалидных id, и от ложных типов.
3. **Loader'ы с тяжёлой логикой блокируют навигацию.** Loader выполняется до рендера целевой страницы; медленный API = «залипшая» кнопка. Решение: стримить данные (defer/Await), вынести медленное в Query с staleTime, или показать fallback через navigation.state.
4. **Мутации через loader.** Loader — только чтение. Записи через action или useMutation; смешение (fetch POST внутри loader) — антипаттерн, ломает семантику и кэширование.
5. **Забытый errorElement.** Loader бросает Response, а errorElement не задан — ошибка всплывёт к корню, сломав layout. Ставь errorElement на каждый маршрут с loader.
6. **useLoaderData с неправильным типом.** Возвращает unknown; любой `as` без валидации — ловушка. Или типизируй строго через дженерики лоадера, или валидируй Zod и возвращай результат parse.

## Вопросы на собеседовании

**Чем data router отличается от классического React Router?**
Данные грузятся в loader'ах маршрутов до рендера, мутации — в action'ах, ошибки ловятся в errorElement. Компоненты получают готовые данные через useLoaderData вместо эффектов с fetch и ручных состояний loading/error.

**Что такое loader и когда он выполняется?**
Функция маршрута, вызываемая роутером при навигации на маршрут (и при параметрических изменениях). Получает params/request, возвращает данные или бросает Response/Error. Вложенные loader'ы выполняются параллельно.

**Как обрабатывать ошибки в loader?**
Бросать Response (для статусов) или Error; ближайший errorElement вверх по дереву ловит её и рисует fallback, useRouteError отдаёт ошибку компоненту. Иерархия errorElement изолирует сбои страницы от каркаса.

**Зачем action, если есть onSubmit?**
Action интегрирован с роутером: перехватывает Form-сабмит без перезагрузки, отслеживается через navigation.state, возвращает данные в useActionData и поддерживает redirect — то есть закрывает весь цикл мутации декларативно. OnSubmit — императив, вся обвязка руками.

**Что даёт useNavigation?**
Состояние текущей навигации: idle/loading/submitting. Один глобальный индикатор на layout покрывает все переходы и сабмиты без прокидывания флагов.

**Как совместить Router loaders с TanStack Query?**
Loader дёргает queryClient.ensureQueryData (prefetch в кэш), компонент читает тем же ключом через useQuery. Роли разделены: Query — кэш и инвалидация, Router — тайминг навигации и ошибки. Мутации остаются на useMutation.

**Куда складывать состояние пагинации/фильтров?**
В search-параметры URL через useSearchParams: ссылки шарибельны, кнопка «назад» работает, при перезагрузке состояние восстанавливается. Стор для этого — антипаттерн.

## Практика

1. **Каркас и страницы.** Настрой createBrowserRouter: layout с шапкой/подвалом, страницы Home, Products, ProductDetail (:productId). Убедись, что навигация между страницами не перерендеривает шапку.
2. **Loader с валидацией.** Products page: loader грузит список через fetch, params валидируй Zod, ошибки лови в errorElement с кнопкой «повторить» (useRevalidator).
3. **Action-форма.** Страница создания товара: <Form method="post">, action валидирует Zod (та же схема, что и на клиенте), при ошибках возвращает fieldErrors на форму, при успехе — redirect на детали.
4. **Индикатор навигации.** Глобальная полоса загрузки на layout через useNavigation. Задержай API на 1 с (setTimeout в loader) и проверь UX.
5. **Интеграция с Query.** ProductDetail: loader делает ensureQueryData, компонент — useQuery с тем же ключом. Докажи одним запросом в сетевой вкладке (повторный заход на страницу в пределах staleTime не фетчит). Мутация «добавить в избранное» — useMutation с invalidateQueries.

## Что почитать

- [React Router: Picking a Router](https://reactrouter.com/en/main/routers/picking-a-router) — почему createBrowserRouter, а не старые BrowserRouter.
- [React Router: Loaders](https://reactrouter.com/en/main/route/loader) и [Actions](https://reactrouter.com/en/main/route/action) — официальные гайды.
- [React Router: Error Handling](https://reactrouter.com/en/main/start/overview#error-handling) — модель errorElement.
- [React Router: useNavigation](https://reactrouter.com/en/main/hooks/use-navigation) — состояния навигации.
- [TkDodo's Blog: React Router + React Query](https://tkdodo.eu/blog/react-router-react-query) — эталонная статья об интеграции двух систем.
