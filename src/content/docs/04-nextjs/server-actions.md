---
title: "Server Actions: мутации без ручного API"
description: "'use server', мутации и ревалидация, валидация через Zod, прогрессивное улучшение, useFormState/useFormStatus, обработка ошибок, безопасность: авторизация и rate limiting внутри экшена."
---

Server Actions — механизм, который стёр границу между фронтендом и бэкендом внутри Next.js. Это асинхронные функции, которые исполняются **на сервере**, но вызываются из клиентского кода так, будто это обычные функции: без ручного `fetch`, без эндпоинтов, с типобезопасностью сквозь границу. Мутация + ревалидация кэша + прогрессивное улучшение (форма работает даже без JavaScript) — всё в одном.

Раньше мутация выглядела так: клиентский `fetch('/api/posts', { method: 'POST' })`, ручная сериализация, ручная обработка ошибок, ручная инвалидация кэша, ручной no-JS fallback. Server Actions сжимают это до передачи функции в `action` формы. Но за удобством прячется важное: экшен — это публичный эндпоинт, и все правила безопасности бэкенда к нему применяются в полной мере.

В этой главе разберём механику `'use server'`, мутации с ревалидацией, валидацию через Zod, состояние форм через `useFormState`/`useFormStatus`, обработку ошибок и два обязательных слоя безопасности: авторизацию внутри экшена и rate limiting.

## 'use server': как это устроено

Директива ставится либо на уровне файла (все экспорты — экшены), либо на уровне отдельной функции:

```ts
// app/actions/feedback.ts — весь файл из экшенов
'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';

export async function createFeedback(formData: FormData) {
  const email = formData.get('email');
  const text = formData.get('text');

  await db.feedback.create({ data: { email, text } });
  revalidatePath('/feedback');
}
```

```tsx
// или отдельная функция в серверном файле
export async function deleteProduct(formData: FormData) {
  'use server';
  const id = formData.get('id');
  await db.product.delete({ where: { id: String(id) } });
  revalidateTag('products');
}
```

Под капотом Next.js создаёт для каждого экшена HTTP-эндпоинт (внутренний, на тот же origin) и подменяет вызов функции в клиентском коде на `fetch` к нему с сериализованными аргументами. Сигнатура функции при этом сохраняется — TypeScript проверяет типы на обеих сторонах границы.

:::caution[Экшен = публичный эндпоинт]
Несмотря на то что URL экшена не виден в коде, любой может вызвать его curl'ом. Всё, что внутри экшена, обязано само проверять: кто вызывает, откуда данные, не слишком ли часто. Никакого доверия к клиенту — только серверная валидация.
:::

## Мутации и ревалидация

Сценарий полного цикла: пользователь отправляет форму → экшен валидирует и пишет в БД → ревалидируются кэши → UI обновлён. Без единого ручного `fetch`:

```tsx
// app/actions/products.ts
'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '@/lib/db';
import { productSchema } from './schemas';

export async function createProduct(prevState: unknown, formData: FormData) {
  const parsed = productSchema.safeParse({
    name: formData.get('name'),
    priceCents: Number(formData.get('price')),
  });

  if (!parsed.success) {
    // вернём ошибки в форму — покажем рядом с полями
    return { errors: parsed.error.flatten().fieldErrors };
  }

  const product = await db.product.create({
    data: {
      name: parsed.data.name,
      priceCents: Math.round(parsed.data.priceCents * 100),
    },
  });

  revalidateTag('products');   // сбросить Data Cache каталога
  revalidatePath('/catalog');  // и Full Route Cache страницы
  redirect(`/products/${product.id}`); // 303-редирект на карточку
}
```

Здесь задействованы три стандартных приёма: `revalidateTag` для концептуальной инвалидации данных, `revalidatePath` для страницы, `redirect` — только после всех операций (выброс исключения под капотом, поэтому его нельзя обернуть в try/catch вместе с бизнес-логикой).

## Валидация входа через Zod

Клиентская валидация — про UX, серверная — про безопасность. Экшен обязан проверять всё сам:

```ts
// app/actions/schemas.ts
import { z } from 'zod';

export const productSchema = z.object({
  name: z.string().min(2, 'Минимум 2 символа').max(120),
  priceCents: z.number().positive('Цена должна быть положительной'),
});

export type ProductInput = z.infer<typeof productSchema>;
```

Паттерн `safeParse` + возврат структуры ошибок в форму — стандарт де-факто. Альтернативы (Yup, Valibot) работают так же; важна сама дисциплина: никаких `formData.get('price') as number` без проверки. Любой вызов экшена может прийти не из твоей формы.

## Прогрессивное улучшение и JS-fallback

Ключевое свойство экшенов в форме — **работа без JavaScript**. Если JS ещё не загрузился или отключён, нативная отправка формы попадёт на тот же серверный экшен, результат — редирект на обновлённую страницу. С JS — тот же экшен выполняется через `fetch`, страница не перезагружается, кэш обновляется местно.

```tsx
// app/products/new/page.tsx — серверная страница
import { createProduct } from '@/app/actions/products';
import { ProductForm } from './product-form';

export default function NewProductPage() {
  // ⚠️ передаём bound action: первый аргумент уже зафиксирован
  const create = createProduct.bind(null, null);
  return <ProductForm action={create} />;
}
```

```tsx
// app/products/new/product-form.tsx — клиентский островок
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus(); // состояние ближайшей формы
  return (
    <button disabled={pending}>
      {pending ? 'Сохраняем…' : 'Создать товар'}
    </button>
  );
}

export function ProductForm({ action }: { action: (formData: FormData) => Promise<unknown> }) {
  // [state, formAction] — обёртка экшена с состоянием
  const [state, formAction] = useActionState(action, { errors: {} });

  return (
    <form action={formAction}>
      <input name="name" required />
      {state.errors?.name && <p className="error">{state.errors.name}</p>}

      <input name="price" type="number" step="0.01" required />
      {state.errors?.priceCents && <p className="error">{state.errors.priceCents}</p>}

      <SubmitButton />
    </form>
  );
}
```

Два хука, которые надо различать:

- **`useActionState`** (React 19, раньше `useFormState` из `react-dom`) — принимает экшен с сигнатурой `(prevState, formData) => newState`, возвращает текущее состояние и обёрнутый action для формы. Это мост «экшен вернул объект — форма его показала».
- **`useFormStatus`** — даёт `pending` и `data` для ближайшей родительской формы. Используется в дочерних компонентах (кнопка внутри формы), не принимает аргументов.

:::tip[Экшен не обязан возвращать объект]
Удобный трюк: экшен, завершившийся успехом, может просто вызвать `redirect` — тогда `useActionState` получит `null` и форма сбросится. Для простых мутаций (лайк, удаление) возврат состояния не нужен вообще.
:::

## Обработка ошибок

Три уровня обработки ошибок в экшенах:

1. **Ошибки валидации** — возвращаются как данные (через `useActionState`), показываются рядом с полями.
2. **Ожидаемые бизнес-ошибки** («товар закончился», «email занят») — тоже данные: `{ error: 'Товар закончился' }`.
3. **Неожиданные ошибки** (БД упала, сеть порвалась) — `throw`. Проброс падёт в ближайший `error.tsx` маршрута. Форма при этом не получит состояние — пользователь увидит общий экран ошибки.

```ts
export async function purchaseProduct(prevState: unknown, formData: FormData) {
  const parsed = purchaseSchema.safeParse(/* ... */);
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors };

  try {
    await db.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: parsed.data.productId } });
      if (!product || product.stock < 1) {
        throw new BusinessError('Товар закончился');
      }
      await tx.order.create({ data: parsed.data });
      await tx.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });
    });
  } catch (e) {
    if (e instanceof BusinessError) return { error: e.message };
    throw; // инфраструктурное — дальше, в error.tsx
  }

  revalidateTag('products');
  redirect('/orders/success');
}
```

Плохой паттерн — `try/catch` на всё подряд с возвратом `{ error: 'Что-то пошло не так' }`: ты скроешь реальные баги и лишишь себя стектрейса в логах.

## Безопасность: авторизация и rate limit

Экшен исполняется с полномочиями сервера. Два обязательных слоя защиты:

### Авторизация внутри экшена

Проверяй сессию **первой строкой** экшена, до любой обработки:

```ts
// app/actions/admin.ts
'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { revalidateTag } from 'next/cache';

export async function banUser(formData: FormData) {
  const session = await auth(); // читаем cookies() внутри — маршрут динамический
  if (!session?.user || session.user.role !== 'admin') {
    throw new Error('Forbidden'); // или redirect('/login')
  }

  const userId = String(formData.get('userId'));
  await db.user.update({ where: { id: userId }, data: { banned: true } });
  revalidateTag('users');
}
```

Проверка роли на клиенте (скрытая кнопка) не защищает ничего — экшен вызовут напрямую. Проверка роли в middleware защищает страницы, но не экшены: middleware не выполняется для вызовов экшенов. Только внутри.

### Rate limiting

Экшен, изменяющий состояние, обязан иметь ограничение частоты — иначе его зафлудят:

```ts
// lib/rate-limit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(5, '60 s'),
});

export async function assertRateLimit(key: string) {
  const { success } = await ratelimit.limit(key);
  if (!success) throw new Error('Слишком много запросов, попробуй позже');
}
```

```ts
export async function createFeedback(prevState: unknown, formData: FormData) {
  const ip = (await headers()).get('x-forwarded-for') ?? 'anon';
  await assertRateLimit(`feedback:${ip}`); // 5 попыток в минуту

  // ... валидация, запись в БД
}
```

Без Redis можно in-memory счётчиком (работает только на одном инстансе; при нескольких репликах — только общее хранилище). В разделе про Redis вернёмся к этой теме детальнее.

:::caution[Экшен может быть вызван кем угодно]
Усилим ещё раз, потому что это горит в продакшене регулярно: URL экшена извлекается из клиентского бандла, и любой скрипт его дергает. Никакой «секретности по незнанию» — только проверки внутри.
:::

## Типичные ошибки и грабли

1. **Нет серверной валидации.** Клиентская проверка input'ов — только UX. Экшен, принимающий `formData.get('email')` без `zod.safeParse`, — дыра: придёт null, SQL-инъекция или мегабайт мусора. Плохо: `as string` и вперёд. Хорошо: `safeParse` → 400 при провале.

2. **Нет авторизации в экшене.** Кнопка «Удалить» скрыта по роли в UI, но экшен не проверяет роль — любой авторизованный (или вообще аноним) шлёт curl и удаляет. Проверка сессии — первая строка каждого экшена.

3. **`useActionState` и старые сигнатуры.** Путаница между `useFormState` (react-dom, deprecated) и `useActionState` (React 19), плюс забытый первый аргумент `prevState` в сигнатуре экшена. Следи, чтобы экшен принимал `(prevState, formData)`, а хук — правильную обёртку.

4. **Мутация без ревалидации.** Создал запись, редиректнул — а на странице списка старое из Router Cache. Правило: каждый экшен, меняющий данные, ревалидирует затронутые теги/пути. Пропустил — получи «призрачные» данные.

5. **Тяжёлая работа в экшене без индикации pending.** `useFormStatus` не используется, кнопка не блокируется — пользователь жмёт пять раз, создаётся пять заказов. Блокируй сабмит и показывай состояние загрузки всегда.

6. **rate limit «потом».** На демо не настраивают, в прод забывают — и форма обратной связи становится спам-шлюзом. Добавляй ограничение сразу, на этапе написания экшена.

## Вопросы на собеседовании

1. **Что такое Server Action и как он работает под капотом?** Серверная функция с директивой `'use server'`; Next.js создаёт внутренний эндпоинт, а клиентский вызов превращает в fetch с сериализацией аргументов. Типы проверяются на обеих сторонах.
2. **Работает ли форма с экшеном без JavaScript?** Да — нативная отправка формы попадает на тот же экшен, результат обрабатывается сервером (редирект/рендер). С JS — тот же экшен через fetch без перезагрузки.
3. **Чем useActionState отличается от useFormStatus?** Первый оборачивает экшен и хранит возвращённое им состояние (для показа ошибок); второй даёт статус ближайшей формы (pending) для дочерних элементов.
4. **Как обработать ошибку валидации в экшене?** Возвращать объект с ошибками через `useActionState` и показывать рядом с полями. Неожиданные ошибки — throw в `error.tsx`.
5. **Почему нельзя доверять данным из FormData?** Экшен — публичный эндпоинт: его вызывают не только твоя форма. Валидация обязательна на сервере (Zod), авторизация — тоже.
6. **Что делать с rate limiting для экшенов?** Лимитер (Upstash/Redis или in-memory для одного инстанса) по ключу (IP + имя экшена), проверка первой строкой экшена, понятная ошибка при превышении.
7. **Может ли экшен вернуть JSX?** Технически экшен возвращает сериализуемые данные; React 19 позволяет вернуть и серверные компоненты (RSC payload), но паттерн экзотический. Практика: данные + ревалидация + redirect.

## Практика

1. Реализуй форму создания товара в pet-проекте: серверная страница, клиентский островок формы, экшен с Zod-валидацией, `useActionState` для показа ошибок по полям, `useFormStatus` для кнопки.
2. Добавь проверку роли внутри экшена удаления товара. Убедись, что вызов curl'ом с чужой сессией (или без) отклоняется.
3. Подключи in-memory rate limit (5 вызовов/минута на IP) к форме обратной связи. Проверь границу: 6-й вызов должен вернуть ошибку.
4. Сделай экшен «лайк поста» без `useActionState`: просто форма с кнопкой и экшеном, ревалидирующим тег `post:<slug>`. Проверь работу с отключённым JS.

Критерий результата: мутации проходят цикл «валидация → запись → ревалидация → обновлённый UI» без ручного fetch; формы работают с выключенным JS; в каждом экшене есть проверка сессии и лимит вызовов.

## Что почитать

- [Next.js: Server Actions and Mutations](https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations)
- [React: useActionState](https://react.dev/reference/react/useActionState)
- [React: useFormStatus](https://react.dev/reference/react-dom/hooks/useFormStatus)
- [Zod: документация по safeParse](https://zod.dev/?id=safeparse)
- [Upstash Ratelimit: лимитер на Redis](https://upstash.com/docs/oss/sdks/ts/ratelimit/overview)
