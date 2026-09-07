---
title: "Формы: React Hook Form и Zod"
description: "Неконтролируемые формы на RHF: register, Controller, меньше ререндеров. Схемная валидация Zod: типы из схемы, refine, async-проверки, server-side валидация."
---

Формы — то, что пользователи заполняют десятки раз в день и то, что разработчики ненавидят писать. Причина ненависти обычно одна: формы на «чистом» React. Контролируемый инпут на каждую клавишу меняет стейт → рендерится вся форма → на пятом поле форма начинает подтормаживать, а на двадцатом превращается в слайд-шоу. Решение давно стандартизировано: **React Hook Form** держит состояние в DOM и следит за ним через ref, а **Zod** отвечает за валидацию с выводом типов. Разберём, как это работает и почему это быстро.

## Ментальная модель RHF: состояние в DOM

[React Hook Form (RHF)](https://react-hook-form.com/docs) строится на **неконтролируемых** инпутах. Значение поля живёт в DOM-узле, а RHF читает его через `ref` при необходимости: при сабмите, при валидации, при показе ошибок. Сравни с контролируемым подходом:

```tsx
// ❌ Контролируемый инпут: каждая клавиша → setState → рендер ВСЕЙ формы
const [email, setEmail] = useState('');
<input value={email} onChange={(e) => setEmail(e.target.value)} />;

// ✅ RHF: значение в DOM, React не участвует в каждом keystroke
<input {...register('email')} />;
```

Это даёт главный выигрыш: **ввод в поле не вызывает рендер React вообще**. Рендер случается только тогда, когда меняется что-то видимое: появилась ошибка, форма перешла в состояние submitting, изменилось поле с `watch`. Для формы с 20 полями разница — порядок.

## register: подписка через ref

`register('fieldName')` возвращает набор пропсов (`name`, `ref`, `onChange`, `onBlur`), которые ты разворачиваешь на нативный инпут. RHF использует их, чтобы читать значение и валидировать по событиям:

```tsx
import { useForm } from 'react-hook-form';

interface LoginForm {
  email: string;
  password: string;
}

function LoginPage() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>();

  const onSubmit = async (data: LoginForm) => {
    // data — валидированные данные формы, типизированы через дженерик
    await login(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <input
        type="email"
        {...register('email', {
          required: 'Email обязателен',
          pattern: {
            value: /^\S+@\S+\.\S+$/,
            message: 'Некорректный email',
          },
        })}
        aria-invalid={!!errors.email}
      />
      {errors.email && <p role="alert">{errors.email.message}</p>}

      <input
        type="password"
        {...register('password', { required: 'Пароль обязателен', minLength: 8 })}
      />
      {errors.password && <p role="alert">{errors.password.message}</p>}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Входим…' : 'Войти'}
      </button>
    </form>
  );
}
```

Ключевые детали:

- `handleSubmit(onSubmit)` — обёртка: RHF валидирует, при успехе вызывает `onSubmit` с данными, при ошибке — фокусирует первое невалидное поле. Твоя функция **никогда не получит невалидные данные**.
- `noValidate` на форме отключает нативные браузерные сообщения — мы показываем свои, единообразные.
- Ошибки показываем с `role="alert"` — скринридеры объявят их сразу (см. главу тестирования).

Правила валидации в `register` годятся для простого. Но как только правила повторяются между формами, появляются кросс-филдовые проверки («пароли совпадают») или нужна одна схема на клиенте и сервере — на сцену выходит Zod.

## Zod: схема как источник правды

[Zod](https://zod.dev/) описывает форму данных декларативно, и из описания выводит TypeScript-тип. Один артефакт — три роли: рантайм-валидация, статическая типизация, документация контракта.

```tsx
import { z } from 'zod';

const registerSchema = z.object({
  email: z.string().email('Некорректный email'),
  password: z
    .string()
    .min(8, 'Минимум 8 символов')
    .regex(/[A-Z]/, 'Нужна хотя бы одна заглавная буква')
    .regex(/[0-9]/, 'Нужна хотя бы одна цифра'),
  age: z.coerce.number().min(18, 'Только для взрослых').int('Целое число'),
});

// тип формы выводится из схемы — руками не пишем, не расходятся
type RegisterForm = z.infer<typeof registerSchema>;
// { email: string; password: string; age: number }
```

Пара деталей, которые часто упускают:

- `z.coerce.number()` — приводит строку из инпута к числу (все значения инпутов приходят строками). Без coerce пришлось бы вручную трансформировать в `valueAsNumber` или в сабмите.
- Сообщения об ошибках живут прямо в схеме — они показываются пользователю, а не разработчику. Пиши их человеческим языком, с указанием конкретного требования.

Подключение к RHF — резолвер:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';

const {
  register,
  handleSubmit,
  formState: { errors, isSubmitting },
} = useForm<RegisterForm>({
  resolver: zodResolver(registerSchema),
  mode: 'onBlur', // валидировать при потере фокуса, а не при каждом keystroke
});
```

Теперь правила из `register(...)` убраны — схема решает. Ошибки приходят в той же форме: `errors.email?.message` — это строка из схемы.

## Кросс-филдовая валидация: refine и superRefine

«Пароль и подтверждение совпадают», «дата окончания позже даты начала» — проверки над несколькими полями. В Zod — через `refine` на объекте:

```tsx
const schema = z
  .object({
    password: z.string().min(8, 'Минимум 8 символов'),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Пароли не совпадают',
    path: ['confirm'], // ошибка привяжется к полю confirm, а не ко всей форме
  });
```

`path` важен: без него ошибка повиснет на корне формы и не отобразится у конкретного инпута. Для нескольких кросс-правил используй `superRefine` — он позволяет добавлять несколько issue с разными path.

## Async-валидация: проверка уникальности на сервере

Классика: «это имя пользователя уже занято». Проверка требует запроса — делается на blur сабмита через `refineAsync`:

```tsx
const schema = z.object({
  username: z
    .string()
    .min(3, 'Минимум 3 символа')
    .refine(async (name) => {
      const taken = await api.checkUsername(name); // запрос к серверу
      return !taken;
    }, 'Это имя уже занято'),
});
```

RHF вызывает async-проверки с debounce-подобным поведением и отслеживает их состояние через `formState.validatingFields`. Важно: асинхронная валидация не должна блокировать ввод — она работает на blur, а не на каждый символ (и это правильно и для UX, и для нагрузки на сервер).

Полноценная проверка уникальности всё равно повторяется на бэкенде при сабмите: гонка «два пользователя одновременно взяли одно имя» решается только сервером. Клиентская async-проверка — про UX, серверная — про корректность.

## Server-side валидация: единая схема на обеих сторонах

Сильнейшая сторона связки: схема живёт в shared-модуле и исполняется везде. NestJS, Next.js Route Handlers, tRPC — любой серверный слой может переиспользовать ту же схему:

```ts
// shared/schemas/register.ts — импортируется и клиентом, и сервером
import { registerSchema } from '@/shared/schemas/register';

// Сервер (Next.js Route Handler) — валидация НЕзависимо от клиента
export async function POST(req: Request) {
  const body = await req.json();
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    // 400 с деталями — клиент не сможет «обмануть» валидацию отключением JS
    return Response.json(
      { errors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  await createUser(parsed.data); // parsed.data — уже типизировано
  return Response.json({ ok: true });
}
```

Правило безопасности, которое нельзя нарушать: **клиентская валидация — для удобства, серверная — для гарантий**. Любой запрос можно отправить curl'ом в обход твоего красивого React-приложения. `safeParse` (не `parse`) не бросает исключение — возвращает результат с `success`-флагом, удобно отдавать 400 с полями ошибок.

Ошибки сервера возвращаем в форму через `setError` или `setErrors` RHF — пользователь видит единообразные сообщения из одного источника:

```tsx
const { setError } = useForm<RegisterForm>();

const onSubmit = async (data: RegisterForm) => {
  const res = await fetch('/api/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (res.status === 400) {
    const { errors } = await res.json();
    // сервер прислал ошибки по полям — показываем как свои
    Object.entries(errors).forEach(([field, message]) => {
      setError(field as keyof RegisterForm, { message: message as string });
    });
    return;
  }
  // успех — редирект
};
```

## Controller: поля из UI-библиотек

`register` работает с нативными инпутами. А если поле — кастомный компонент из дизайн-системы (React Select, MUI, Radix), который не принимает `ref` в твой DOM? Для этого есть [`Controller`](https://react-hook-form.com/docs/usecontroller/controller) — мост между RHF и контролируемыми компонентами:

```tsx
import { Controller, useForm } from 'react-hook-form';
import Select from 'react-select';

function ProductForm() {
  const { control, handleSubmit } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Controller
        name="category" // имя поля в данных формы
        control={control} // объект управления RHF
        render={({ field, fieldState }) => (
          <Select
            {...field} // value, onChange — подключены к RHF
            options={categories}
            isInvalid={!!fieldState.error}
          />
        )}
      />
      {/* fieldState.error — ошибка валидации этого поля */}
    </form>
  );
}
```

Внутри `Controller` RHF хранит значение в своём реактивном состоянии — это контролируемый компонент, и он **будет рендериться на каждое изменение**. Поэтому правило: `Controller` — только там, где без него никак (сторонние компоненты). Свои простые инпуты — всегда `register`.

## Наблюдение и значения по умолчанию

Для зависимых полей («при смене страны сбросить город») есть `watch`:

```tsx
const country = watch('country');

useEffect(() => {
  if (country !== 'RU') setValue('city', ''); // сброс зависимого поля
}, [country, setValue]);
```

`watch` возвращает значение и подписывает компонент на его изменения — помни, что каждый подписанный компонент рендерится на изменение. Для тяжёлых зависимостей есть `useWatch` с селектором.

Значения по умолчанию при редактировании — через `defaultValues` в `useForm` (они же используются `reset`). Не управляй значениями через `value` — это превратит поле в контролируемое и убьёт весь выигрыш.

## Динамические поля: useFieldArray

Формы со списками переменной длины (опыт работы в резюме, товары в накладной, участники команды) решаются через [`useFieldArray`](https://react-hook-form.com/docs/usefieldarray):

```tsx
import { useFieldArray, useForm } from 'react-hook-form';

const schema = z.object({
  members: z.array(
    z.object({
      email: z.string().email('Некорректный email'),
      role: z.enum(['admin', 'editor', 'viewer']),
    }),
  ).min(1, 'Нужен хотя бы один участник'),
});

function TeamForm() {
  const { register, control, handleSubmit } = useForm<TeamForm>({
    resolver: zodResolver(schema),
    defaultValues: { members: [{ email: '', role: 'viewer' }] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'members' });

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {fields.map((field, index) => (
        // field.id — стабильный ключ для динамического списка (см. главу про рендеринг)
        <div key={field.id}>
          <input {...register(`members.${index}.email`)} />
          <select {...register(`members.${index}.role`)}>
            <option value="viewer">Наблюдатель</option>
            <option value="editor">Редактор</option>
          </select>
          <button type="button" onClick={() => remove(index)}>Удалить</button>
        </div>
      ))}
      <button type="button" onClick={() => append({ email: '', role: 'viewer' })}>
        Добавить участника
      </button>
    </form>
  );
}
```

Имена полей строятся строковыми путями (`members.2.email`) — RHF сам разложит их в вложенный объект. Валидация массива целиком — на схеме: `min(1)`, уникальность email через `refine` на уровне массива.

## Состояния формы: dirty, touched, isValid

`formState` даёт больше, чем `errors` и `isSubmitting`:

- `dirtyFields` — какие поля отличны от `defaultValues`. Классика: предупреждение «у вас несохранённые изменения» при уходе со страницы.
- `touchedFields` — какие поля побывали в фокусе. Показывать ошибку сразу при первом символе — плохой UX; принято — показывать после blur первый раз (`mode: 'onTouched'`).
- `isValid` — прошла ли форма валидацию сейчас. Дизейблить кнопку сабмита, пока форма невалидна — спорный паттерн (пользователь не понимает, почему кнопка мертва; ошибки видны только после попытки), но для длинных форм с кросс-правилами оправдан.
- `isDirty` — любое отличие от дефолтов; дублируется на уровне формы.

```tsx
const { formState: { isDirty, isSubmitting } } = useForm({ ... });

// предупреждение о несохранённом уходе
useEffect(() => {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (isDirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
}, [isDirty]);
```

## Составные схемы: выборка и расширение

Реальные проекты переиспользуют схемы: базовая схема пользователя для регистрации, расширенная — для админки, урезанная — для публичного профиля. Zod поддерживает композицию:

```ts
const userBase = z.object({
  email: z.string().email(),
  name: z.string().min(2),
});

// регистрация = база + пароль
const registerSchema = userBase.and(z.object({
  password: passwordSchema,
}));

// публичный профиль = только часть полей (выборка из схемы — через pick)
const publicProfileSchema = userBase.pick({ name: true });

// редактирование профиля = база + опциональное фото
const editProfileSchema = userBase.extend({
  avatarUrl: z.string().url().optional(),
});
```

Так как тип выводится из схемы, все производные схемы остаются типобезопасными: поменял `userBase` — TypeScript покажет все места, где сломалась композиция. Для кросс-форменных правил (пароль и подтверждение) комбинируй `and` + `refine`.

## FormProvider: глубоко вложенные поля

Когда поле живёт в компоненте на пять уровней ниже формы, прокидывать `register` через пропсы — мучение. `FormProvider` передаёт методы формы через контекст:

```tsx
const methods = useForm<FormData>({ resolver: zodResolver(schema) });

<FormProvider {...methods}>
  <form onSubmit={methods.handleSubmit(onSubmit)}>
    <AddressSection /> {/* внутри — useFormContext() вместо пропсов */}
  </form>
</FormProvider>
```

```tsx
// AddressSection.tsx — на любом уровне вложенности
import { useFormContext } from 'react-hook-form';

export function AddressSection() {
  const { register, formState: { errors } } = useFormContext<FormData>();
  return (
    <fieldset>
      <input {...register('address.city')} />
      {errors.address?.city && <p role="alert">{errors.address.city.message}</p>}
    </fieldset>
  );
}
```

Платишь слепотой типов в месте вызова `useFormContext` (дженерик указываешь руками) — поэтому провайдера хватает на секции формы, а не на всё приложение.

## Типичные ошибки и грабли

1. **Контролируемый инпут вместо register.** `<input value={...} onChange={...} />` + `register` одновременно — конфликт источников правды. Выбери один подход: нативное поле — `register`, сторонний компонент — `Controller`.
2. **Валидация только на клиенте.** Любая форма, отправляющая данные на сервер, обязана валидироваться на сервере той же схемой. Иначе API открыт для мусора.
3. **async-проверка на каждый keystroke.** Запрос на сервер при каждом символе — это DDoS своего же бэкенда. Async-правила — на blur (mode: 'onBlur' / 'onSubmit'), синхронные — можно чаще.
4. **Ошибка refine без path.** «Пароли не совпадают» привязанная к корню формы не показывается у поля confirm. Всегда указывай path.
5. **Кнопка сабмита без isSubmitting.** Двойной клик — два запроса. Два запроса — дубликаты на сервере. Блокируй кнопку через `isSubmitting` (RHF сам его выставляет, пока onSubmit не завершится).
6. **watch внутри большого компонента.** Подписка рендерит весь компонент-форму. Вынеси зависимую часть в отдельный компонент или используй `useWatch` на уровне нужного поддерева.

## Вопросы на собеседовании

**Почему RHF быстрее контролируемых форм?**
Состояние инпутов живёт в DOM, RHF читает его через ref при валидации/сабмите. Каждый keystroke не проходит через React-рендер — форма из 20 полей не рендерится на каждый введённый символ. Рендер только при изменении ошибок/статусов.

**Что делает register?**
Возвращает пропсы (name, ref, onChange, onBlur) для нативного инпута, через которые RHF подписывается на поле, читает значение и запускает валидацию по событиям.

**Как вывести тип формы из Zod-схемы?**
`z.infer<typeof schema>` — TypeScript выводит тип из структуры схемы. Данные сабмита типизированы автоматически; при изменении схемы тип обновляется — расхождения исключены.

**Как проверить, что два поля совпадают?**
`.refine((data) => data.a === data.b, { message, path: ['b'] })` на уровне объекта схемы. Path привязывает ошибку к конкретному полю.

**Как работает async-валидация в Zod?**
`refine(async (value) => ..., 'Сообщение')` — Zod дожидается промиса. RHF вызывает при onBlur/onSubmit и показывает состояние через validatingFields. Серверная проверка обязательна дублируется при сабмите — гонки решает только сервер.

**Когда нужен Controller, а когда register?**
register — нативные инпуты/селекты/текстареа. Controller — сторонние контролируемые компоненты, не принимающие ref на нужный DOM (React Select, календари, кастомные дизайн-системы). Controller дороже (рендер на каждое изменение) — применяй точечно.

**Как переиспользовать схему на сервере?**
Схема в shared-модуле; сервер вызывает `safeParse` на теле запроса и отдаёт 400 с fieldErrors. Клиент через setError показывает их как свои. Одна схема — два исполнителя, гарантия одинаковых правил.

## Практика

1. **Форма регистрации.** RHF + Zod: email, пароль, подтверждение пароля (refine + path), возраст (coerce). Режим валидации onBlur. Ошибки через role="alert", кнопка блокируется через isSubmitting.
2. **Уникальность имени пользователя.** Добавь async-refine с реальным (или замоканным) эндпоинтом проверки. Проверь, что запрос уходит на blur, а не на каждый символ, и что состояние валидации видно пользователю.
3. **Единая схема клиент/сервер.** Вынеси схему в shared-файл. Сделай серверный роут (хотя бы mock) с safeParse и 400-ответом. Сымитируй обход клиента (curl) и убедись, что сервер отклоняет невалидные данные.
4. **Зависимые поля.** Форма адреса: страна → регион → город. При смене страны сбрасывай зависимые поля через watch + setValue. Вынеси зависимую часть в отдельный компонент, чтобы watch не рендерил всю форму.
5. **UI-библиотека.** Подключи React Select (или аналог) через Controller к полю «категория» с валидацией required. Проверь, что ошибка валидации показывается у компонента.

## Что почитать

- [React Hook Form: Get Started](https://react-hook-form.com/get-started) и [API Reference](https://react-hook-form.com/docs) — register, Controller, setError, useWatch.
- [Zod: документация](https://zod.dev/) — все типы, refine/superRefine, async-проверки, ошибки.
- [@hookform/resolvers](https://github.com/react-hook-form/resolvers) — резолверы для Zod, Valibot, Yup и других.
- [RHF: Form State](https://react-hook-form.com/docs/useform/formstate) — все флаги состояния формы (isSubmitting, validatingFields, dirtyFields).
- [Valibot](https://valibot.dev/) — альтернатива Zod с лучшим tree-shaking; тот же подход «схема → тип».
