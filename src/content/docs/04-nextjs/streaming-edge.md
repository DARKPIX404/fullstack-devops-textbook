---
title: "Streaming, Middleware, Edge и оптимизация ассетов"
description: "Suspense на сервере и гранулярный стриминг, loading.tsx, middleware с rewrite/redirect/headers и его ограничения, Edge Runtime, next/image с remotePatterns и next/font."
---

Эта глава собирает четыре механизма Next.js, которые превращают «сайт работает» в «сайт быстрый и отзывчивый»: streaming рендеринга, middleware как дешёвый слой до приложения, Edge Runtime для низких задержек и оптимизация ассетов через `next/image` и `next/font`. Они решают разные задачи, но объединены одной целью — время до первой осмысленной отрисовки и интерактивности.

Контекст из продакшена: страница дашборда грузит шесть виджетов, два из них — тяжёлые аналитические блоки по 1,5 секунды каждый. Без стриминга пользователь смотрит на белый экран три секунды. Со стримингом — шапка и навигация появляются за 100 миллисекунд, аналитика «доезжает» потом. Пользователь уже работает. Middleware решает другую задачу: гео-редиректы и A/B-тесты не должны стоить полного рендера страницы. А оптимизация картинок и шрифтов — самый дешёвый способ улучшить Core Web Vitals без переписывания приложения.

## Streaming: Suspense на сервере

Классический SSR — all-or-nothing: сервер собирает весь HTML, и только потом отдаёт его целиком. Streaming меняет модель: сервер отдаёт документ по частям, как только те готовы (механика — в [Loading UI and Streaming](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming)). Механизм — React Suspense на сервере: компоненты, обёрнутые в `<Suspense>`, рендерятся независимо, и их куски HTML вставляются в поток по мере готовности.

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';

export default function Dashboard() {
  return (
    <main>
      {/* статическая часть — уходит сразу */}
      <Header />
      <Nav />

      {/* медленные блоки не блокируют остальную страницу */}
      <Suspense fallback={<AnalyticsSkeleton />}>
        <SlowAnalytics /> {/* fetch с no-store, 1.5s */}
      </Suspense>

      <Suspense fallback={<FeedSkeleton />}>
        <ActivityFeed /> {/* второй независимый поток */}
      </Suspense>
    </main>
  );
}
```

Пользователь получает shell страницы мгновенно, а fallback'и заменяются реальным контентом по мере готовности каждого блока — без единой перезагрузки. На уровне HTTP это chunked transfer encoding: браузер начинает рендерить, не дожидаясь конца тела ответа.

`loading.tsx` — файловое соглашение, которое создаёт Suspense-границу автоматически:

```tsx
// app/orders/loading.tsx — показывается, пока рендерится любая страница раздела
export default function Loading() {
  return <OrdersTableSkeleton />;
}
```

Разница с явным `<Suspense>`: `loading.tsx` — граница уровня сегмента (вся страница-скелетон), явный Suspense — гранулярный контроль внутри страницы. В проде комбинируют: `loading.tsx` для быстрого первого отклика, вложенные Suspense — чтобы частичный контент доехал раньше.

:::tip[Стриминг и статика совместимы]
Streaming работает не только для SSR. Статическая страница с динамическим островком (`no-store` fetch внутри Suspense) стримится с CDN: кэшируется статический shell, динамический кусок рендерится на запрос и подставляется на клиенте через инструкции RSC. Это один из самых элегантных паттернов App Router.
:::

### Гранулярность стриминга и оптимизация

Правило гранулярности: каждый независимый асинхронный блок — своя Suspense-граница. Типичные ошибки настройки:

- один Suspense на всю страницу — теряется весь смысл;
- Suspense-граница вокруг блока, который не делает асинхронной работы — лишний слой без пользы;
- медленный блок выше быстрого по дереве — быстрый ждёт медленный при последовательном рендеринге (React рендерит siblings слева направо, хотя сами промисы резолвятся параллельно).

Практический приём: выносите самые медленные данные вниз дерева или в отдельные границы — shell и быстрые блоки уходят первыми.

## Middleware: rewrite, redirect, headers

`middleware.ts` в корне (или в `src/`) выполняется **до** того, как запрос попал в роутер приложения (см. [документацию по middleware](https://nextjs.org/docs/app/building-your-application/routing/middleware)). Это точка входа для дешёвых решений:

```ts
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = request.cookies.get('session');

  // 1. redirect — полный переход
  if (!session && pathname.startsWith('/account')) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', pathname); // вернём после логина
    return NextResponse.redirect(login);
  }

  // 2. rewrite — URL для пользователя не меняется,
  //    а рендерится другой маршрут (A/B тесты, фичефлаги)
  if (pathname === '/landing' && request.cookies.get('exp')?.value === 'b') {
    return NextResponse.rewrite(new URL('/landing-variant-b', request.url));
  }

  // 3. headers — добавить/переписать заголовки
  const response = NextResponse.next();
  response.headers.set('x-request-id', crypto.randomUUID());
  return response;
}

export const config = {
  // matcher — где middleware работает. ВАЖНО: исключаем статику и картинки-оптимизатор
  matcher: ['/account/:path*', '/landing', '/api/:path*'],
};
```

Matcher — критически важная часть: без него middleware выполняется на каждый запрос, включая `_next/static`, `_next/image`, favicon. Это сожжёт CPU впустую. Стандартный безопасный паттерн:

```ts
export const config = {
  matcher: [
    // всё, кроме _next, api и файлов с расширением
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg)$).*)',
  ],
};
```

Что middleware умеет и чем он ограничен:

| Возможно | Невозможно |
|---|---|
| redirect, rewrite, задание headers/cookies | Рендерить React-компоненты |
| Проверять cookies/headers запроса | Полноценная авторизация с проверкой БД (нет доступа к твоим модулям с Prisma — только fetch к собственному API) |
| Гео/ботов-данные (по IP) | Тяжёлая логика: лимиты времени и памяти жёсткие |
| Matcher с негативными lookahead'ами | Любые Node API: fs, crypto (нативный), модули с native-кодом |

:::caution[Middleware ≠ авторизация]
Middleware подходит для «дешёвого» редиректа (нет cookie → на /login). Настоящая проверка прав — внутри Server Actions и серверных компонентов (см. [главу про Server Actions](/04-nextjs/server-actions/)). Middleware легко обойти, и у него нет доступа к твоей БД.
:::

## Edge Runtime: что работает и что нет

Middleware всегда исполняется на Edge Runtime ([обзор рантаймов](https://nextjs.org/docs/app/building-your-application/rendering/edge-and-nodejs-runtimes)) — среде, близкой к браузерному V8/Worker: изолированный контекст, холодный старт около нуля, но жёсткие лимиты. Можно опционально перевести на Edge отдельные сегменты приложения:

```tsx
// app/api/geo/route.ts
export const runtime = 'edge';

export async function GET(request: Request) {
  // только Web-standard API: fetch, Request/Response, URL, crypto.subtle
  return Response.json({ country: request.headers.get('x-vercel-ip-country') });
}
```

Что работает: Fetch API, Web Streams, `crypto.subtle`, `URLPattern`, часть TextEncoder'ов и прочего Web-платформенного. Что не работает: `fs`, нативные Node-модули (`bcrypt`, `prisma` с обычными адаптерами), большие вычисления — лимит памяти и времени исполнения сильно ниже, чем у Node.js runtime.

Задержки: Edge-функция холодный старт — единицы миллисекунд (против сотен у Node-контейнера). Но если Edge-функция сама ходит в твою БД через fetch — сетевая задержка до региона БД остаётся. Классическая ошибка: «переведём всё на Edge для скорости», а БД в другом регионе — итоговый TTFB вырос, потому что запрос из Edge до БД идёт дольше, чем из Node-сервера рядом с БД.

Правило выбора: Edge — для коротких, независимых от состояния операций (гео, A/B, модификация headers). Node — для всего, что трогает БД, файловую систему или тяжёлые вычисления.

## next/image: оптимизация изображений

[`<Image>`](https://nextjs.org/docs/app/api-reference/components/image) — не просто обёртка над `<img>`, а пайплайн оптимизации: автоматический ресайз под размер экрана, конвертация в WebP/AVIF (при наличии), ленивая загрузка ниже fold, резервирование места под картинку (борьба с CLS), приоритизация LCP-изображений.

```tsx
import Image from 'next/image';

export function Hero({ src, alt }: { src: string; alt: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={1600}
      height={900}
      priority              // LCP-картинка: грузить сразу, не лениво
      sizes="(max-width: 768px) 100vw, 1600px"
      placeholder="blur"
      blurDataURL={tinyBase64} // низкокачественный плейсхолдер ~10px
    />
  );
}
```

`remotePatterns` в `next.config` — whitelist внешних хостов, с которых можно тянуть картинки через оптимизатор. Это защита от SSRF-атак (когда злоумышленник просит оптимизатор скачать картинку из внутренней сети):

```ts
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.example.com', pathname: '/uploads/**' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
    formats: ['image/avif', 'image/webp'], // AVIF приоритетнее, fallback WebP
  },
};

export default nextConfig;
```

Под капотом: запрос к `/_next/image?url=...&w=...&q=...` → сервер скачивает оригинал (с кэшем), ресайзит, конвертирует, кэширует результат. В проде это означает: первая генерация thumbnail'а — медленная (скачать + обработать), последующие — из кэша мгновенные. При самостоятельном хостинии держи в уме CPU-нагрузку оптимизатора: либо `loaderFile` на внешний CDN (Cloudinary, Imgix), либо статичный экспорт оптимизированных версий на этапе сборки.

Паттерн blur-плейсхолдера: генерируешь на сборке (или в момент загрузки) крошечную base64-версию (~20 байт), передаёшь в `blurDataURL` — пользователь видит мыльную картинку мгновенно, резкая подменяет её без скачка раскладки. Ощутимо на медленных сетях.

:::tip[Анализ бандла]
`@next/bundle-analyzer` покажет, что реально попало в клиентский бандл: островки, их зависимости, тяжёлые библиотеки. Запускай после каждого крупного рефакторинга границы сервер/клиент — регрессии ловятся сразу, а не «почему сайт стал тяжёлым» через месяц.
:::

## next/font: шрифты без скачков

Шрифты — классический источник CLS и блокировки рендера (FOIT/FOUT). [`next/font`](https://nextjs.org/docs/app/api-reference/components/font) решает оба: шрифт скачивается на этапе сборки (self-host), подключается с `font-display: swap` и автоматически встраивается CSS `size-adjust`, чтобы метрики запасного шрифта совпадали с кастомным — скачок текста минимален.

```tsx
// app/layout.tsx
import { Inter, JetBrains_Mono } from 'next/font/google';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  variable: '--font-inter', // CSS-переменная для tailwind
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
```

Плюсы self-hosting: нет зависимости от Google Fonts CDN (приватность, доступность в РФ без VPN), нет лишнего DNS/TLS-раундтрипа, предзагрузка через `rel="preload"` автоматически.

## Типичные ошибки и грабли

1. **Middleware без matcher.** Каждый запрос (включая статику и `/_next/image`) проходит через middleware — лишняя нагрузка впустую. Всегда настраивай `matcher` с исключениями.

2. **Авторизация только в middleware.** «Защищённый» раздел проверяется в middleware по cookie, но Server Actions раздела проверки не имеют — экшен вызывают напрямую. Плохо: редирект в middleware как единственная защита. Хорошо: middleware + проверка в каждом экшене/серверном компоненте.

3. **`<img>` вместо `<Image>` «для простоты».** Потеряешь ресайз, WebP, lazy-loading и борьбу с CLS. На мобильном это +2 МБ картинок и скачки раскладки. Миграция: механическая, `next lint` подсветит все `<img>`.

4. **next/image и внешний хост без remotePatterns.** Картинка не отображается с ошибкой 500 в `/_next/image`. Добавь hostname в конфиг; для загружаемых пользователями картинок — wildcard с ограничением pathname.

5. **Перенос тяжёлой логики на Edge.** «Edge быстрее» — перевели API с Prisma на Edge Runtime, словили ошибки `Can't resolve 'fs'` и выросшие задержки до БД. Edge — только для stateless-логики.

6. **Шрифты через link на Google Fonts.** Внешний CDN для шрифтов — лишний раундтрип, приватность и блокировка рендера. `next/font` решает всё это на сборке; ручной `<link>` — шаг назад.

## Вопросы на собеседовании

1. **Как работает streaming рендеринг в Next.js?** React Suspense на сервере: компоненты внутри `<Suspense>` рендерятся независимо, их HTML-чанки отдаются по мере готовности через chunked encoding. `loading.tsx` — автоматическая Suspense-граница сегмента.
2. **Чем redirect отличается от rewrite в middleware?** Redirect — полный переход браузера на другой URL (виден в адресной строке, новый запрос). Rewrite — внутренняя подмена маршрута: URL не меняется, рендерится другая страница (A/B, фичефлаги).
3. **Почему нельзя Node API в middleware и Edge Runtime?** Edge — изолированный V8-контекст без Node-окружения: нет fs, нативных модулей, привычного crypto. Лимиты памяти/времени жёсткие. Middleware и Edge-сегменты — для короткой stateless-логики.
4. **Что даёт next/image по сравнению с img?** Ресайз под viewport, WebP/AVIF, lazy-loading, резервирование места (CLS), `priority` для LCP, SSRF-защита через remotePatterns.
5. **Как сделать blur-плейсхолдер для удалённой картинки?** Генерируешь base64-миниатюру (например, через `plaiceholder`), передаёшь в `placeholder="blur"` и `blurDataURL`. Пользователь видит мыло мгновенно, без скачка раскладки.
6. **Когда выбрать Edge Runtime для сегмента, а когда Node?** Edge — короткая stateless-логика без БД (гео, headers, кэши). Node — всё с БД, fs, нативными зависимостями. Проверяй, откуда сегмент ходит в данные.
7. **Зачем next/font, если можно link на Google Fonts?** Self-host на этапе сборки: нет внешнего CDN (приватность, доступность), автоматический preload, `size-adjust` против CLS, `display: swap` по умолчанию.

## Практика

1. Добавь в pet-проект страницу дашборда с тремя блоками: быстрым (100 мс), средним (800 мс) и медленным (2 с, `await new Promise(r => setTimeout(r, 2000))`). Оберни каждый в Suspense со скелетонами, замерь «время до первого контента» через throttled-соединение в DevTools.
2. Напиши middleware: редирект неавторизованных с `/account` на `/login?next=...`, rewrite `/landing` на `/landing-b` для 50% пользователей (по cookie), исключающий matcher для статики и `/_next/image`.
3. Замени все `<img>` в проекте на `<Image>`: добавь `remotePatterns` для CDN с товарами, настрой `sizes` под адаптивную сетку, сделай LCP-картинку главной страницы `priority`.
4. Подключи `next/font`: основной шрифт и моноширинный через CSS-переменные, интегрируй с Tailwind (`fontFamily.sans: var(--font-inter)`). Проверь отсутствие FOIT через DevTools → Rendering → emulate slow network.
5. Задеплой pet-проект на VPS из раздела про Docker (предварительно) и замерь реальные Core Web Vitals через PageSpeed Insights: до и после оптимизации изображений и шрифтов.

Критерий результата: дашборд стримится с видимым shell за <200 мс; middleware не трогает статику; картинки отдаются в WebP/AVIF с правильными размерами; CLS страницы — близок к нулю.

## Что почитать

- [Next.js: Loading UI and Streaming](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming)
- [Next.js: Middleware](https://nextjs.org/docs/app/building-your-application/routing/middleware)
- [Next.js: Edge Runtime](https://nextjs.org/docs/app/building-your-application/rendering/edge-and-nodejs-runtimes)
- [Next.js: next/image](https://nextjs.org/docs/app/api-reference/components/image)
- [Next.js: next/font](https://nextjs.org/docs/app/api-reference/components/font)
- [web.dev: Optimize LCP](https://web.dev/articles/optimize-lcp)
