---
title: "Radix UI и Shadcn: доступные примитивы и владение кодом"
description: "Философия Radix: нестилизованные доступные примитивы, composition pattern с asChild, управление состоянием диалогов. Shadcn: установка через CLI, components/ui, cn() и cva-варианты, кастомизация темы. Почему это не библиотека компонентов."
---

В краткой версии ты добавил Dialog через `npx shadcn add dialog` и он просто заработал — с клавиатурой, с фокусом, с Escape. В этой главе разбираем, почему он заработал, и главное — чем это принципиально отличается от установки Material UI. Разница фундаментальна: MUI — это зависимость, чей код живёт в `node_modules` и обновляется когда захочет мейнтейнер. Shadcn — это код в твоём репозитории, который ты читаешь, правишь и несёшь за него ответственность. А под ним — Radix: примитивы, которые знают про доступность больше, чем знаешь ты, и это комплимент обеим сторонам.

Продакшен-контекст: диалог, дропдаун или тост — это один из самых опасных участков интерфейса с точки зрения доступности. Руками написать корректный focus trap (фокус не выходит за границы модалки при Tab), вернуть фокус на триггер после закрытия, заблокировать скролл body, управлять `aria-hidden` для фона — это часы работы и десятки краевых случаев. Радикс делает всё это за тебя, оставляя тебе только внешний вид.

## Radix UI: философия доступных примитивов

### Почему «примитивы», а не «компоненты»

Radix не даёт готовых кнопок и карточек. Он даёт **части поведения**: `Dialog.Root`, `Dialog.Trigger`, `Dialog.Content`, `Dialog.Close`. Поведение — полностью доступное; внешний вид — нулевой, ты добавляешь свои классы. Это разделение ответственности: доступность — сложная и стандартизированная (WAI-ARIA Authoring Practices), внешний вид — уникальный для каждого продукта.

```tsx
import * as Dialog from '@radix-ui/react-dialog';

export function ConfirmDialog() {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="rounded-lg bg-indigo-600 px-4 py-2 text-white">
        Удалить проект
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-semibold">
            Удалить проект безвозвратно?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-slate-600">
            Все данные проекта исчезнут. Это действие нельзя отменить.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close className="rounded-md px-4 py-2 text-sm">Отмена</Dialog.Close>
            <button className="rounded-md bg-red-600 px-4 py-2 text-sm text-white">
              Удалить
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Обрати внимание на обязательные части: `Title` и `Description` — не для красоты. Скринридер объявляет их при открытии диалога (`aria-labelledby`, `aria-describedby` расставлены автоматически). Без `Title` Radix выведет warning в консоль — слушай его.

### Что Radix делает автоматически

- **Focus management**: при открытии фокус переходит внутрь контента, Tab циклится внутри (focus trap), Escape закрывает, при закрытии фокус возвращается на триггер.
- **Скролл и стек**: body-скролл блокируется, несколько вложенных диалогов управляются корректно (последний открытый получает Escape).
- **ARIA-атрибуты**: `role="dialog"`, `aria-modal`, связи label/describedby, `aria-expanded` на триггере.
- **Взаимодействия**: клик по оверлею закрывает, `pointer-events` фона отключаются.

### Composition pattern и asChild

Ключевая идиома Radix — сборка из частей в JSX. А когда нужно встроить свою обёртку (Link из роутера как триггер), есть `asChild`: Radix передаст всё поведение и пропсы на твой единственный дочерний элемент.

```tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link } from 'react-router-dom';

<DropdownMenu.Root>
  <DropdownMenu.Trigger asChild>
    <button className="icon-button" aria-label="Действия с файлом">
      <DotsIcon />
    </button>
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content className="menu" sideOffset={8}>
      <DropdownMenu.Item asChild>
        <Link to="/edit">Редактировать</Link>
      </DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item-danger" onSelect={duplicate}>
        Дублировать
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="my-1 h-px bg-slate-200" />
      <DropdownMenu.Item disabled>Архивировать</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
```

Клавиатурная навигация в меню работает из коробки: стрелки, Home/End, буквенный поиск, Escape, Tab выходит из меню. `onSelect` срабатывает на Enter/Space и клик; событие можно отменить через `event.preventDefault()` (полезно: открыть вложенное меню вместо закрытия).

:::note[Popover vs DropdownMenu]
Частая путаница. `DropdownMenu` — это меню действий (роль `menu`, стрелочная навигация). `Popover` — произвольный всплывающий блок (роль `dialog`): фильтры, подсказки, превью. Выбирай по семантике, а не по внешнему виду — скринридеры их озвучивают по-разному. Подробности — в главе [Доступность](/fullstack-devops-textbook/05-styling-perf/a11y/).
:::

### Управление состоянием

Radix поддерживает оба режима — контролируемый и неконтролируемый, как нативные инпуты:

```tsx
// неконтролируемый: Radix сам держит open/closed
<Dialog.Root>
  <Dialog.Trigger>Открыть</Dialog.Trigger>
</Dialog.Root>

// контролируемый: состояние живёт в твоём сторе/URL
function DeleteProject({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => !open && navigate('/projects')}
    >
      {/* ... */}
    </Dialog.Root>
  );
}
```

Контролируемый режим мощный: диалог как маршрут (`/projects/42/delete`) — глубокие ссылки работают, кнопка «назад» закрывает модалку. Для форм внутри диалога не забывай `onOpenAutoFocus={(e) => e.preventDefault()}` если не хочешь автофокус на первом поле.

### Toast и стек уведомлений

Третий паттерн состояния после диалога и меню — уведомления. Radix Toast решает то, что обычно делают криво: очередь сообщений, политика удаления, привязка к viewport и `aria-live` из коробки:

```tsx
import * as Toast from '@radix-ui/react-toast';

export function Toaster() {
  return (
    <Toast.Provider swipeDirection="right" duration={5000}>
      <Toast.Root className="toast">
        <Toast.Title className="font-medium">Проект сохранён</Toast.Title>
        <Toast.Description className="text-sm text-slate-500">
          Изменения появятся у команды через минуту
        </Toast.Description>
      </Toast.Root>
      <Toast.Viewport className="fixed bottom-4 right-4 flex flex-col gap-2" />
    </Toast.Provider>
  );
}
```

Почему не `alert()` или самодельный стор тостов: Toast-провайдер управляет фокусом по спецификации (фокус остаётся на месте, сообщение объявляется вежливо через live-регион), свайп/таймаут закрытия доступны с клавиатуры, несколько тостов не конкурируют за `aria-live`. Детали работы live-регионов — в главе [Доступность](/fullstack-devops-textbook/05-styling-perf/a11y/).

### Portal, z-index и стек оверлеев

Все «всплывающие» примитивы (Dialog, Popover, DropdownMenu, Toast) рендерятся через `Portal` — подписку в `document.body` вне твоего дерева компонентов. Это решает две проблемы разом: `overflow: hidden` и `transform` на предке больше не ломают позиционирование (они создают новый containing block для `position: absolute`), и оверлей не втягивается в `z-index`-войны внутри страницы.

Но портал не отменяет конфликты между самими оверлеями: диалог поверх дропдауна, тост поверх диалога. Рабочая стратегия — слои с именами из твоей системы: Radix расставляет `data-*`-атрибуты состояний, а shadcn-проекты заводят токены з-индексов в конфиге Tailwind (`z-overlay: 40, z-modal: 50, z-popover: 60, z-toast: 70`). Правило: никаких магических `z-[9999]` — они выигрывают сегодняшний спор и ломают завтрашний дропдаун.

:::note[SSR и гидратация порталов]
Портал рендерится на клиенте, поэтому его содержимое не попадает в серверный HTML — для диалогов это правильно по определению (закрытый диалог не должен быть в DOM). Но следи за гидратационными расхождениями: условный рендер портала на основе `typeof window` без подавления предупреждений — классический источник «hydration mismatch» в Next.js.
:::

### Тестирование Radix-компонентов

Поскольку поведение живёт в примитивах, тесты пишешь против пользовательского контракта, а не имплементации — это стойко к рефакторингам:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

it('закрывается по Escape и возвращает фокус на триггер', async () => {
  const user = userEvent.setup();
  render(<ConfirmDialog />);
  const trigger = screen.getByRole('button', { name: /удалить проект/i });
  await user.click(trigger);

  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAccessibleName(/удалить проект безвозвратно/i); // Title на месте

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus(); // фокус вернулся — без Radix писал бы сам
});
```

Заметь: `getByRole('dialog')` проверяет и разметку, и доступное имя — если Title потеряется, тест упадёт раньше, чем axe в CI.

## Shadcn UI: не библиотека, а способ владения кодом

### Что происходит при `shadcn add`

```bash
npx shadcn@latest init        # задаёт вопросы про стиль, базовый цвет, CSS-переменные
npx shadcn@latest add dialog  # копирует dialog.tsx в src/components/ui
```

Команда `add` скачивает исходник компонента (Radix-примитив + Tailwind-классы + `cva`-варианты) и кладёт его **в твой репозиторий**. Никакой зависимости `shadcn` в `package.json` нет. Дальше код — твой: можешь удалить вариант, поменять px на rem, добавить проп. Обновления shadcn для тебя — это референс, а не миграция: смотришь diff на сайте и переносишь руками, что нужно.

### Структура components/ui

```
src/
├── components/ui/        # компоненты из shadcn — правь свободно
│   ├── button.tsx
│   ├── dialog.tsx
│   └── input.tsx
├── lib/utils.ts          # cn() = clsx + tailwind-merge
└── components/           # ТВОИ компоненты, построенные на ui/
    └── project-card.tsx
```

Дисциплина слоёв: `ui/` — тонкие обёртки над Radix с вариантами; бизнес-компоненты собираются из них и живут отдельно. Так обновления shadcn не конфликтуют с твоей логикой.

### cn() и cva: система вариантов

```tsx
// components/ui/button.tsx (упрощённо)
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // базовые классы — всегда
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline: 'border border-input hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-10 px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
```

Разбор механики:

- **`cva`** (class-variance-authority) — типизированная фабрика классов. Варианты комбинируются декартово: `variant="destructive" size="sm"` даёт базу + destructive + sm. TypeScript выводит пропсы из определения — опечатка в имени варианта не скомпилируется.
- **`cn(...)`** — сначала `clsx` склеивает условные классы (`cn(isActive && 'bg-accent')`), затем `tailwind-merge` разрешает конфликты, оставляя последнюю утилиту (`cn('px-4', 'px-2')` → `px-2`). `className` из пропсов идёт последним — точка кастомизации всегда побеждает.

```tsx
// использование: вариант + локальная правка
<Button variant="outline" size="sm" className="ml-auto">
  Отмена
</Button>
```

### Кастомизация темы через CSS-переменные

`shadcn init` создаёт в `globals.css` семантические токены как CSS-переменные:

```css
:root {
  --primary: 222.2 47.4% 11.2%;        /* hsl без hsl() — для alpha-модификаторов */
  --primary-foreground: 210 40% 98%;
  --destructive: 0 84.2% 60.2%;
  --radius: 0.5rem;
}
.dark {
  --primary: 210 40% 98%;
  --primary-foreground: 222.2 47.4% 11.2%;
}
```

Хитрость в формате: переменные хранятся компонентами HSL (`222.2 47.4% 11.2%`), и Tailwind собирает `hsl(var(--primary) / <alpha-value>)`. Поэтому `bg-primary/50` и hover `bg-primary/90` работают с твоими токенами. Смена темы — это переключение класса `.dark` на `<html>`, никакого дублирования палитры в JS.

Меняешь бренд — правишь `--primary` в одном месте, и весь интерфейс (кнопки, фокусы, бейджи) перекрашивается.

### Отличие от библиотеки компонентов

| | MUI / Ant Design | Radix + Shadcn |
|---|---|---|
| Код компонента | в `node_modules`, закрыт | в твоём репо, открыт |
| Внешний вид | чужой дизайн, переопределяешь через API | твой с первой строки |
| Обновления | semver-миграции, ломают визуал | ты сам решаешь, что перенести |
| Доступность | частично, зависит от библиотеки | WAI-ARIA-примитивы полностью |
| Размер бандла | вся библиотека + иконки | только используемые примитивы |

Цена владения: ты отвечаешь за этот код. Рефакторинг стиля кнопки — твоя задача; баг в фокусе — ты чинишь в своём репо, а не ждёшь релиза. Для продуктовой команды это плюс: контроль выше зависимости.

:::tip[Когда НЕ брать shadcn]
Если нужен интерфейс «вчера» и дизайн не важен (админка внутреннего инструмента) — скорее возьми готовую библиотеку с темой из коробки. Shadcn окупается там, где дизайн-система своя и живёт долго.
:::

## Типичные ошибки и грабли

1. **Забыли Title/Description в Dialog.** Консоль кричит, скринридер не объявляет содержимое. Хорошо: всегда оба компонента, скрытие визуально — через `className="sr-only"`, если дизайн требует.
2. **`asChild` с несколькими детьми.** Radix клонирует единственный дочерний элемент; `<Trigger asChild><a/><span/></Trigger>` упадёт с ошибкой. Оберни в один фрагмент-узел.
3. **Меню внутри Popover «ради красоты».** Ты получишь фокус-ловушку внутри фокус-ловушки и сломанную клавиатуру. Нужно меню — бери DropdownMenu; нужен произвольный блок — Popover без menu-семантики.
4. **Кастомизация через пропсы-стили.** `<Button style={{ background: 'red' }}>` размазывает систему. Хорошо: править варианты в `buttonVariants` или добавлять тематический класс через `className` + `cn()`.
5. **Диалог, не привязанный к состоянию.** `open` без `onOpenChange` — пользователь закрывает модалку, а стор думает, что она открыта; следующий рендер снова её показывает. Контролируемый режим — только в паре с обработчиком.
6. **Ручное позиционирование Popover.** Рассчитывать `top/left` самому вместо `Popover.Anchor` + `Popover.Content sideOffset` — ловишь съезды при скролле и ресайзе. Radix позиционирует через Floating UI, доверься ему.

## Вопросы на собеседовании

1. **Чем Radix отличается от MUI?** Radix — нестилизованные доступные примитивы (поведение без внешнего вида); MUI — готовые компоненты с чужим дизайном. Radix даёт контроль и минимальный бандл, MUI — скорость старта.
2. **Что такое composition pattern в Radix?** Компонент собирается из частей (`Root/Trigger/Content/Portal`), каждая отвечает за аспект поведения или разметки. Это даёт гибкость: поменять структуру можно, не ломая поведение.
3. **Зачем `asChild`?** Проброс всех поведенческих пропсов и рефов на один дочерний элемент, чтобы триггером меню мог быть Link из роутера или свой Button, сохраняя доступность.
4. **Как работает `cva`?** Типизированная маппинг-функция: базовые классы + декартово произведение вариантов, вызывается как функция `buttonVariants({ variant, size })`. TS выводит допустимые значения вариантов.
5. **Почему `cn()` последним аргументом принимает `className` из пропсов?** `tailwind-merge` разрешает конфликты, оставляя последнюю утилиту — так точка кастомизации всегда побеждает базовые стили компонента.
6. **Как в shadcn сделать тёмную тему?** CSS-переменные семантических токенов в `:root` и `.dark`, переключение класса на `<html>`. Переменные в формате HSL-компонентов дают работающий alpha-синтаксис (`bg-primary/50`).
7. **Как открыть диалог по прямой ссылке?** Контролируемый режим: состояние в URL/сторе, `open` + `onOpenChange` маппятся на навигацию. Неконтролируемый режим глубоких ссылок не даёт.
8. **Что происходит с фокусом при открытии/закрытии Dialog Radix?** При открытии — в контент (focus trap, цикл по Tab), Escape закрывает, при закрытии — возврат на триггер. Всё из коробки, руками реализовывать не нужно.

## Практика

1. **Диалог как маршрут.** Сделай страницу проектов, где удаление — URL `/projects/:id/delete`, открывающий контролируемый Dialog. Критерий: кнопка «назад» браузера закрывает модалку; при открытой модалке скролл фона заблокирован, фокус не выходит за её пределы (проверь Tab).
2. **Свой ui-компонент на Radix.** Собери `Tabs` на Radix-примитивах с тремя вариантами размера через `cva`. Критерий: переключение стрелками работает, активный таб помечен `aria-selected` (проверь в DevTools).
3. **Кастомная тема.** Перекрась shadcn-токены под бренд pet-проекта (основной, destructive, акценты), добавь `.dark`-вариант с переключателем. Критерий: ни одного hex в `components/ui/*` — только токены; alpha-модификаторы работают.
4. **Расширение Button.** Добавь в `buttonVariants` вариант `success` и размер `xs`, обнови типы. Критерий: TypeScript подсказывает новые значения; старые использования не сломались.
5. **Аудит граблей.** Пройди чек-лист: у каждого Dialog есть Title и Description, ни у одного `asChild` нет двух детей, контролируемые диалоги имеют `onOpenChange`. Критерий: пустой чек-лист + axe-проверка без критических нарушений.

## Что почитать

- [Radix UI Primitives: документация](https://www.radix-ui.com/primitives)
- [WAI-ARIA Authoring Practices: Dialog и Menu](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Shadcn UI: установка и философия](https://ui.shadcn.com/docs)
- [class-variance-authority: README](https://github.com/joe-bell/cva)
- [Floating UI: позиционирование](https://floating-ui.com/)
