---
title: "App Router: файловая система как API"
description: "Файловые соглашения App Router: layout и вложенность, группы маршрутов, динамические сегменты, параллельные и перехватывающие роуты, route handlers против страниц."
---

App Router (стабилен с Next.js 13.4) заменил Pages Router и принёс с собой новую идею: **файловая система — это не просто роутинг, а полное описание UI-дерева**. Папки определяют URL, а файлы внутри определяют, какие «слоты» маршрута чем заполняются. Если Pages Router был «файл = страница», то App Router — «папка = маршрут, файлы = роли».

В краткой версии ты видел обзор соглашений. Здесь разберёмся, как эти соглашения комбинируются в реальные паттерны: разделение лейаутов маркетинга и приложения через группы, параллельные роуты с `default.tsx`, перехватывающие роуты для модалок, и вечный спор — когда писать route handler, а когда страницу.

Практический смысл для продакшена: правильная структура `app/` уменьшает количество клиентского кода, позволяет рендерить разные секции страницы разными стратегиями и делает навигацию мгновенной за счёт prefetch. Неправильная — превращает проект в кашу из вложенных лейаутов и непонятных, почему-то клиентских страниц.

## Файловые соглашения

Каждая папка внутри `app/` — сегмент URL. Назначение задаётся именем файла:

| Файл | Назначение |
|---|---|
| `page.tsx` | Страница маршрута. Только её наличие делает сегмент доступным по URL |
| `layout.tsx` | Общий каркас для себя и вложенных сегментов. Сохраняет состояние при навигации |
| `loading.tsx` | Fallback для Suspense-границы этого сегмента — показывается, пока рендерится страница |
| `error.tsx` | UI ошибки рендеринга (обязан быть клиентским, `'use client'`) |
| `not-found.tsx` | UI для 404 этого сегмента |
| `template.tsx` | Как layout, но пересоздаётся при каждой навигации (теряет состояние) |
| `default.tsx` | Fallback для параллельного слота, когда текущий URL его не заполняет |
| `route.ts` | Серверный эндпоинт (аналог API-роута из Pages Router) |

```tsx
// app/layout.tsx — корневой каркас: html и body существуют только здесь
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}

// app/products/layout.tsx — каркас только для раздела /products
export default function ProductsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="products-shell">
      <ProductsNav />
      {children}
    </div>
  );
}
```

Ключевая механика лейаутов: они **не перерисовываются** при навигации между вложенными страницами. Состояние инпута поиска в лейауте каталога сохранится при переходе между категориями. Поэтому лейаут — правильное место для тяжёлого, но стабильного UI: навигации, сайдбаров, плееров.

:::tip[page vs route.ts в одной папке]
`page.tsx` и `route.ts` в одном сегменте конфликтуют — выбери одно. Нужен и HTML, и API? Разнеси по сегментам: `app/products/page.tsx` и `app/api/products/route.ts` — стандартная схема.
:::

## Группы маршрутов: один URL — разные каркасы

Папка в круглых скобках **не попадает в URL**, но является полноценным сегментом дерева со своим лейаутом:

```
app/
  (marketing)/
    layout.tsx      // лёгкий каркас: только шапка, без сайдбара
    page.tsx        // → /
    about/page.tsx  // → /about
  (shop)/
    layout.tsx      // каркас магазина: шапка + корзина + сайдбар
    catalog/page.tsx   // → /catalog
    cart/page.tsx      // → /cart
```

Классический пример из документации — маркетинговые страницы без лишнего хрома и рабочая зона приложения со своей навигацией. Без групп пришлось бы городить условную логику внутри одного лейаута или дублировать ветки URL.

:::caution[Группы не для «организации кода»]
Если у двух веток одинаковый лейаут — группа не нужна, просто клади папки рядом. Группа оправдана только когда каркасы различаются. Иначе получишь фантомные сегменты, которые путают и фреймворк (при одинаковых путях в разных группах сборка упадёт с конфликтом), и людей.
:::

## Динамические сегменты и generateMetadata

Квадратные скобки — параметр URL. Параметры приходят асинхронно (в Next.js 15+ это `Promise`), и маршрут может быть статически сгенерирован для конкретного набора значений через `generateStaticParams` (см. [стратегии рендеринга](/04-nextjs/rendering-strategies/)).

```tsx
// app/blog/[slug]/page.tsx
type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  const posts = await getAllPosts();
  return posts.map((p) => ({ slug: p.slug }));
}

// метаданные тоже генерируются на сервере — никаких useEffect для title
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: { images: [post.coverUrl] },
  };
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  return <article dangerouslySetInnerHTML={{ __html: post.html }} />;
}
```

Есть ещё **catch-all** (`[...slug]`) — сегмент сгребает остаток пути массивом, и **optional catch-all** (`[[...slug]]`) — где пустой путь тоже валиден. Удобно для документации со вложенными разделами, но осторожно: catch-all на корне ловит вообще всё и ломает `not-found` для соседних маршрутов, если не настроить приоритеты.

## Параллельные роуты: @slot и default.tsx

Параллельный роут — слот, который рендерится в том же layout независимо от основного `children`. Слот объявляется папкой с `@` и принимается лейаутом как проп:

```
app/
  @analytics/
    page.tsx          // сегмент /, слот analytics
    loading.tsx       // свой loading для слота
  @team/
    page.tsx          // сегмент /, слот team
  layout.tsx          // принимает { children, analytics, team }
```

```tsx
// app/layout.tsx
export default function DashboardLayout(props: {
  children: React.ReactNode;
  analytics: React.ReactNode;
  team: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_320px]">
      <main>{props.children}</main>
      <aside>
        {props.analytics}
        {props.team}
      </aside>
    </div>
  );
}
```

Механика сложнее, чем кажется: слоты живут **внутри того же URL-пространства**. При навигации на маршрут, у которого нет страницы для слота, слот покажет либо `default.tsx`, либо «зависнет» на предыдущем состоянии. `default.tsx` — обязательный страховочный файл для каждого слота:

```tsx
// app/@analytics/default.tsx
import { Skeleton } from '@/components/skeleton';
export default function AnalyticsDefault() {
  return <Skeleton className="h-24" />; // или редирект, или null
}
```

Параллельные роуты дают настоящую силу в связке с перехватывающими роутами: слот-лейаут не перерисовывается, пока листаешь ленту, а модалка в слоте открывается и закрывается мгновенно.

## Перехватывающие роуты: модалки поверх страниц

Перехватывающий роут открывает маршрут **поверх** текущего контекста. Классика — фото в соцсети: в ленте клик открывает модалку с фото, прямая ссылка на то же фото открывает полноценную страницу.

```
app/
  feed/
    page.tsx                  // лента
    @modal/
      default.tsx             // слот пуст — модалки нет
      (.)photo/[id]/page.tsx  // перехват: клик из feed открывает модалку
  photo/[id]/page.tsx         // полная страница по прямой ссылке
```

Префиксы: `(.)` — тот же уровень, `(..)` — уровень выше, `(..)(..)` — два выше, `(...)` — из корня `app`. Точка считает **сегменты роутера, а не файловую систему** — с группами маршрутов это расходится, и это частый источник багов.

```tsx
// app/feed/@modal/(.)photo/[id]/page.tsx — модалка
'use client';
import { useRouter } from 'next/navigation';

export default function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  return (
    // клик по фону = «назад» — модалка закрывается, лента осталась
    <div className="modal-backdrop" onClick={() => router.back()}>
      <PhotoContent id={/* await params */} />
    </div>
  );
}
```

Требования: слот `@modal` в лейауте, `default.tsx` в слоте, полная страница-твин по прямому URL. Проверяй сценарий «обновил страницу с открытой модалкой» — должен открыться полноценный `/photo/[id]`.

## Route handlers против страниц

`route.ts` — серверные эндпоинты внутри той же файловой системы:

```ts
// app/api/webhooks/stripe/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const body = await request.text(); // сырой body для верификации подписи
  const signature = request.headers.get('stripe-signature')!;

  const event = verifyStripeSignature(body, signature); // throws при невалидной
  if (event.type === 'checkout.session.completed') {
    await fulfillOrder(event.data.object);
  }
  return NextResponse.json({ received: true });
}
```

Поддерживаются `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. Критерий выбора:

- **Нужен HTML/UI** → `page.tsx`. Никогда не отдавай HTML из route handler.
- **Нужен API для внешних систем** (вебхуки, мобильное приложение, cron) → `route.ts`.
- **Мутация из своего UI** → Server Action (см. [следующую главу](/04-nextjs/server-actions/)), а не ручной fetch к route handler. Экшен даёт типизацию, ревалидацию и прогрессивное улучшение бесплатно.

:::caution[Публичные API и CORS]
Route handler по умолчанию обслуживает тот же origin. Для внешних клиентов добавляй `OPTIONS` с CORS-заголовками вручную — Next.js не делает это автоматически, в отличие от некоторых бэкенд-фреймворков.
:::

## Типичные ошибки и грабли

1. **`params`/`searchParams` не await'ятся.** В Next.js 15 это `Promise`. Синхронный доступ работает с деприкейшен-ворнингом и сломается в следующем мажоре. Плохо: `function Page({ params }) { params.slug }`. Хорошо: `const { slug } = await params`.

2. **Лейаут как место для данных конкретной страницы.** Лейаут не получает `searchParams` и не пересоздаётся при навигации — данные, зависящие от конкретной страницы, грузи в `page.tsx`, а не в лейаут.

3. **Перехватывающий роут без полной страницы.** Модалка открывается из ленты, а прямой заход по `/photo/1` даёт 404. Правило: для каждого перехвата обязана существовать полная страница-цель вне слота.

4. **Слот без `default.tsx`.** При навигации на маршрут без страницы слота приложение «зависает» на прошлом состоянии слота или падает. Каждый `@slot` обязан иметь `default.tsx`.

5. **`route.ts` для мутаций из своего UI.** Ручной `fetch('/api/...')` вместо Server Action — потеря типизации, ревалидации и no-JS fallback. Route handlers оставь для внешних интеграций.

6. **Глубокая вложенность лейаутов ради «переиспользования».** Пять вложенных лейаутов — пять мест, где рендеринг может пойти не так, и пять waterfall-запросов данных. Если сегменты логически независимы — разнеси их параллельными роутами или вынеси общие части в компоненты, а не в лейауты.

## Вопросы на собеседовании

1. **Чем `layout.tsx` отличается от `template.tsx`?** Layout сохраняет состояние и не перерисовывается при навигации между вложенными сегментами; template пересоздаётся на каждую навигацию (теряет состояние, перезапускает эффекты). Template нужен редко — например, для enter-анимаций.
2. **Зачем нужны группы маршрутов `(marketing)`?** Чтобы дать разным веткам URL разные лейауты без изменения самих путей: `(marketing)/page.tsx` — это `/`, а `(shop)/catalog` — `/catalog`.
3. **Как работает перехватывающий роут `(.)photo/[id]`?** Это страница слота `@modal`, которая отображается вместо `default.tsx` слота при soft-навигации из `feed`. Прямая ссылка на `/photo/[id]` рендерит полную страницу из параллельной ветки.
4. **Обязателен ли `default.tsx` для параллельного роута?** Формально нет, но без него слот при навигации на «чужой» маршрут покажет устаревшее состояние или не отрендерится. В практике — обязателен.
5. **Когда `route.ts`, а когда `page.tsx`?** Нужен HTML для пользователя — `page.tsx`; нужен программный эндпоинт для внешних систем (вебхуки, API для мобильного клиента) — `route.ts`. Мутации из своего UI — через Server Actions.
6. **Почему `error.tsx` обязан быть клиентским компонентом?** Потому что ошибка может случиться в серверном рендеринге до того, как клиент получил хоть что-то — error boundary работает на клиенте поверх уже загруженного дерева, а значит нуждается в интерактивности.
7. **Что будет при конфликте путей в двух группах маршрутов?** `next build` упадёт с ошибкой конфликтующих маршрутов: группы не влияют на URL, поэтому `(a)/x/page.tsx` и `(b)/x/page.tsx` — один и тот же путь.

## Практика

1. Спроектируй структуру pet-проекта: группы `(marketing)` (главная, о нас — минимальный лейаут) и `(app)` (каталог, корзина, кабинет — лейаут с навигацией). Реализуй обе ветки и убедись, что лейауты независимы.
2. Сделай галерею с перехватывающим роутом: лента `/feed`, клик по фото открывает модалку в слоте `@modal`, прямая ссылка `/photo/[id]` — полноценную страницу. Проверь оба сценария и перезагрузку.
3. Напиши `generateMetadata` для страницы поста блога: title, description, OpenGraph-картинка. Проверь результат через «Просмотр кода страницы» и соцсетевой дебаггер.
4. Добавь route handler `app/api/health/route.ts` с `GET`, возвращающим `{ status: 'ok', uptime }` — это пригодится для мониторинга в разделе про деплой.

Критерий результата: проект собирается без конфликтов маршрутов, перехват модалки работает в обе стороны, а по дереву `app/` видно, какой файл за какую часть UI отвечает.

## Что почитать

- [Next.js: Routing — файловые соглашения](https://nextjs.org/docs/app/building-your-application/routing)
- [Next.js: Parallel Routes](https://nextjs.org/docs/app/building-your-application/routing/parallel-routes)
- [Next.js: Intercepting Routes](https://nextjs.org/docs/app/building-your-application/routing/intercepting-routes)
- [Next.js: Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
- [Next.js: generateMetadata](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
