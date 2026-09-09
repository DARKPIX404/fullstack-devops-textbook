---
title: "CSS-in-JS глубоко: styled-components, Emotion, Linaria, vanilla-extract"
description: "История и внутреннее устройство CSS-in-JS: runtime-стилизация через styled-components и Emotion, zero-runtime альтернативы Linaria и vanilla-extract с типизированными стилями, честный разбор того, почему категория пошла на спад с приходом Server Components и Tailwind."
---

CSS-in-JS — самый спорный подход в истории стилизации фронтенда. В 2016–2020 он казался будущим: стили живут рядом с компонентом, темизация — через контекст, мёртвый код удаляется сам, всё типизируется. В 2024–2026 его обвиняют в тормозах гидратации и избыточном рантайме. Обе стороны правы — в своих контекстах. Чтобы понимать, когда CSS-in-JS уместен, а когда нет, надо разобраться, как он работает под капотом: где выполняется стилизация (в браузере или на сборке), чем это оплачивается и какие проблемы он вообще решал.

В этой главе — полный разбор: от проблем «до», через runtime-реализации (styled-components, Emotion), к zero-runtime (Linaria, vanilla-extract), сравнительная таблица и честный ответ на вопрос «стоит ли брать сегодня». Глава намеренно длинная: это категория, которую ты гарантированно встретишь в legacy-коде, и понимание её механики — обязательная часть фундамента.

## Что такое CSS-in-JS и какие проблемы решал

Идея: стили описываются внутри JavaScript и привязываются к компоненту, а не живут в отдельном CSS-файле. В классическом runtime-варианте CSS генерируется в браузере во время рендеринга. Исторический контекст — болезни эпохи 2014–2016:

1. **Глобальное пространство имён CSS.** Класс `.button` в одном файле ломал `.button` в другом; БЭМ-конвенция (`block__element--modifier`) была обходом, а не решением. CSS-in-JS генерирует уникальные имена классов автоматически — изоляция бесплатно.
2. **Мёртвый код.** CSS растёт монолитно: удалил компонент — стили остались. В CSS-in-JS стили живут в JS-модуле компонента: удали импорт — стили не попадают в бандл (в идеальной реализации).
3. **Динамические стили.** «Кнопка красная в состоянии ошибки, иначе серая» в CSS — борьба с классами-состояниями. В CSS-in-JS — обычный тернарный оператор над пропсами.
4. **Темизация и зависимость от пропсов.** Токены темы как JS-объект, доступный в любом стиле через контекст. В чистом CSS 2016 года — только Custom Properties (ещё свежие) или CSS-переменные через препроцессоры.
5. **Критический CSS и SSR.** Разметка рождается в JS — можно на сервере собрать использованные стили и вставить в `<style>` первого ответа.

Эти проблемы решались реально — поэтому взлёт был стремительным. Расплата пришла позже, и о ней — в разборе под капотом.

## styled-components: runtime-стилизация как стандарт

styled-components (2016, Мишель Байер / Глен Маддерн) — эталонный синтаксис категории: «компонент = тег + стилевая функция». [Официальная документация](https://styled-components.com/docs) покрывает API, темизацию и SSR.

```bash
npm i styled-components
```

```tsx
import styled, { ThemeProvider } from 'styled-components';

// Базовый синтаксис: styled.тег`стили`
const Title = styled.h1`
  font-size: 2rem;
  color: #1e293b;
  margin-bottom: 1rem;
`;

// Интерполяция функции — стили зависят от пропсов
const Button = styled.button<{ $primary?: boolean }>`
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;

  /* пропс $primary: $ — конвенция, чтобы styled-components
     не прокидывал его в DOM (transient props) */
  background: ${(p) => (p.$primary ? '#7c3aed' : 'transparent')};
  color: ${(p) => (p.$primary ? 'white' : '#7c3aed')};
  border: 1px solid #7c3aed;

  &:hover {
    background: ${(p) => (p.$primary ? '#6d28d9' : '#f5f3ff')};
  }
`;

// Композиция: styled(Компонент) наследует стили
const IconButton = styled(Button)`
  padding: 0.5rem;
  border-radius: 50%;
`;
```

Под капотом на каждый рендер работает сериализатор: шаблонные строки компилируются Babel-плагином в массивы `[strings[], interpolations[]]`, интерполяции вычисляются с пропсами, результат скармливается CSS-парсеру (stylis), который генерирует валидный CSS и заменяет вложенность на плоские селекторы. Из хэша CSS получается имя класса (`sc-xyz123`), правило вставляется в `<style>`-тег в `<head>` (или в SSR-стрим). Всё это — в рантайме, в браузере, при каждом первом рендере каждого уникального набора стилей.

:::caution[Не создавай styled-компоненты внутри рендера]
Объявление ``const Btn = styled.button`...` `` в теле компонента создаёт новый класс на каждый рендер: пересоздание стилей, потеря фокуса у вложенных элементов, разрастание `<style>`-тегов. Styled-компоненты — всегда на уровне модуля, динамику выноси в пропсы.
:::

### Темизация через ThemeProvider

Тема — объект в контексте, доступный в каждой интерполяции:

```tsx
// theme.ts — контракт темы (в идеале типизирован)
export const lightTheme = {
  colors: {
    bg: '#ffffff',
    surface: '#f8fafc',
    text: '#1e293b',
    primary: '#7c3aed',
  },
  spacing: (n: number) => `${n * 4}px`,
  radii: { md: '8px', lg: '12px' },
};

// styled.d.ts — расширение дефолтной темы (TypeScript)
declare module 'styled-components' {
  export interface DefaultTheme {
    colors: { bg: string; surface: string; text: string; primary: string };
    spacing: (n: number) => string;
    radii: { md: string; lg: string };
  }
}
```

```tsx
// App.tsx
<ThemeProvider theme={lightTheme}>
  <Card>…</Card>
</ThemeProvider>
```

```tsx
const Card = styled.div`
  background: ${(p) => p.theme.colors.surface};
  color: ${(p) => p.theme.colors.text};
  padding: ${(p) => p.theme.spacing(4)};
  border-radius: ${(p) => p.theme.radii.lg};
`;
```

Переключение темы — замена объекта в ThemeProvider: все styled-компоненты перерендериваются с новой темой. Это работает, но обрати внимание на цену: смена темы = полный ре-рендер всего дерева + пересерилизация всех стилей. В чистом CSS смена `data-theme` — перекраска браузером без единой строчки JS (см. [Bootstrap color modes](/02-css-frameworks/bootstrap/) и [Tailwind-токены](/05-styling-perf/tailwind-deep/)).

### Компонент кнопки с вариантами: полный пример

```tsx
import styled, { css } from 'styled-components';

type Variant = 'primary' | 'outline' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps {
  $variant?: Variant;
  $size?: Size;
}

const variantStyles = {
  primary: css`
    background: #7c3aed;
    color: #fff;
    &:hover:not(:disabled) { background: #6d28d9; }
  `,
  outline: css`
    background: transparent;
    color: #7c3aed;
    border: 1px solid #7c3aed;
    &:hover:not(:disabled) { background: #f5f3ff; }
  `,
  danger: css`
    background: #dc2626;
    color: #fff;
    &:hover:not(:disabled) { background: #b91c1c; }
  `,
};

const sizeStyles = {
  sm: css`padding: 0.375rem 0.75rem; font-size: 0.875rem;`,
  md: css`padding: 0.5rem 1rem; font-size: 1rem;`,
  lg: css`padding: 0.75rem 1.5rem; font-size: 1.125rem;`,
};

export const Button = styled.button<ButtonProps>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  border: none;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  ${(p) => variantStyles[p.$variant ?? 'primary']}
  ${(p) => sizeStyles[p.$size ?? 'md']}
`;

// Использование
<Button $variant="danger" $size="sm" onClick={handleDelete}>
  Удалить
</Button>
```

Это полноценная замена компонентной библиотеке на уровне одного компонента: вариативность типизирована, стили локальны, мёртвый код не выживет. Заметь карту `variantStyles` — она важна: при такой структуре styled-components может вычислить на сервере, какие стили понадобятся (все три варианта, а не один), что влияет на SSR.

## Emotion: css prop и конкурентная механика

Emotion (2017, Эммануэль Майя-Ардипон) — второй гигант, синтаксически близкий, но с флагманской фичей: `css` prop на любом элементе. Документация — [emotion.sh](https://emotion.sh/docs/introduction).

```bash
npm i @emotion/react @emotion/styled
```

```tsx
/** @jsxImportSource @emotion/react */   // либо настройка в tsconfig
import { css } from '@emotion/react';

const highlight = css`
  background: #fef9c3;
  padding: 0 4px;
  border-radius: 4px;
`;

export function Note({ tone }: { tone: 'info' | 'warn' }) {
  return (
    <p
      css={css`
        border-left: 3px solid ${tone === 'warn' ? '#f59e0b' : '#3b82f6'};
        padding-left: 12px;
        color: #334155;
        ${highlight}    // композиция стилей
      `}
    >
      Текст заметки
    </p>
  );
}
```

Механика идентична styled-components: сериализация в рантайме, класс из хэша, вставка в `<style>`. Отличия:

- **Сериализация быстрее** за счёт другого парсера и кэширования (Emotion historically быстрее styled-components на больших списках).
- **Стили как данные**: объект `css` можно передавать, комбинировать, вычислять — гибче шаблонных строк.
- **@emotion/css** — фреймворко-независимое ядро, можно в Vue/Svelte.

На практике styled-components и Emotion взаимозаменяемы; выбор — вкус команды и экосистема (например, Chakra UI исторически строился на Emotion, MUI — на собственном движке, похожем по механике).

## Linaria: zero-runtime, как это работает

[Linaria](https://github.com/callstack/linaria) (2017, Callstack) — попытка сохранить удобство CSS-in-JS, выкинув рантайм: стили извлекаются в статический CSS на этапе сборки, в рантайме остаётся только привязка классов.

```bash
npm i @linaria/core @linaria/react @linaria/babel-preset
```

```tsx
import { css } from '@linaria/core';
import { styled } from '@linaria/react';

// Статический стиль → обычный CSS-файл на сборке
const title = css`
  font-size: 2rem;
  color: #1e293b;
`;

// styled с динамическими пропсами: динамика через CSS-переменные!
export const Button = styled.button<{ $primary?: boolean }>`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  background: ${(p) => (p.$primary ? '#7c3aed' : 'transparent')};
`;
```

Механика под капотом:

1. Babel-плагин на сборке находит `css`-вызовы и `styled`-теги, вычисляет всё статичное.
2. Результат записывается в `.linaria-cache/*.css` — обычный CSS-файл, который попадает в бандл как любой другой CSS.
3. Динамические интерполяции (от пропсов) заменяются на **CSS Custom Properties**: `background: ${p => ...}` превращается в `background: var(--btn-bg)`, а рантайм-код выставляет значение переменной на элементе через `style`.

```css
/* То, что реально окажется в CSS-файле после сборки Linaria */
.b1x2a { padding: .5rem 1rem; border-radius: 8px; background: var(--b1x2a-bg); }
```

```html
<!-- Рантайм-код выставляет только переменную — дёшево -->
<button class="b1x2a" style="--b1x2a-bg: #7c3aed;">Кнопка</button>
```

Плюсы: нулевой рантайм-стоимости стилизации, мгновенный первый рендер (CSS уже в `<link>`), всё удобство шаблонных строк. Грабли:

- **Нужен Babel-конвейер** — в Vite-эпоху это отдельная точка хрупкости (плагин для Vite существует, но исторически отставал от esbuild-сборки).
- **Не всё можно вычислить статически**: стили, зависящие от внешнего состояния (значение пропса извне в момент рендера), либо падают в ошибку сборки, либо идут через CSS-переменные с ограничениями (нельзя вложить медиа-запрос в переменную).
- **Темизация через JS-контекст невозможна** как в styled-components: тема должна быть CSS-переменными, значит вся мощь ThemeProvider заменяется ручным выставлением `--`-переменных.
- **Горячая перезагрузка и дебаг** — через Babel-плагин, дополнительная сложность против нативного CSS HMR.

:::note[Babel-конвейер — цена входа]
Linaria требует Babel-плагин в цепочке сборки. В Vite-эпохе это отдельная точка хрупкости: официальный плагин существует, но исторически отставал от esbuild-сборки на новых мажорных версиях. Прежде чем выбрать Linaria, подними пустой Vite-проект с ней и убедись, что dev/HMR/production-сборка работают на твоём стеке.
:::

## vanilla-extract: TypeScript-стили как контракт

[vanilla-extract](https://vanilla-extract.style/) (Seek, 2021) — zero-runtime, но с другой философией: стили пишутся не в компоненте, а в отдельных `.css.ts` файлах как TypeScript-код, компилируются в статический CSS на сборке, а в JS попадают только хэшированные имена классов. Полная типизация + нулевой рантайм.

```bash
npm i @vanilla-extract/css
```

```ts
// styles/app.css.ts
import { createTheme, style, globalStyle } from '@vanilla-extract/css';

// 1. Тема = контракт с типами
export const [themeClass, vars] = createTheme({
  color: {
    primary: '#7c3aed',
    surface: '#f8fafc',
    text: '#1e293b',
  },
  spacing: { sm: '8px', md: '16px', lg: '24px' },
  radius: { md: '8px' },
});

// 2. Стили как типизированные функции
export const button = style({
  padding: `${vars.spacing.sm} ${vars.spacing.md}`,
  borderRadius: vars.radius.md,
  border: 'none',
  cursor: 'pointer',
  background: vars.color.primary,
  color: '#fff',
  selectors: {
    '&:hover:not(:disabled)': { filter: 'brightness(0.95)' },
    '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
  },
});

// Варианты через recipe (@vanilla-extract/recipes)
import { recipe } from '@vanilla-extract/recipes';

export const buttonRecipe = recipe({
  base: button,
  variants: {
    variant: {
      primary: { background: vars.color.primary },
      outline: {
        background: 'transparent',
        color: vars.color.primary,
        border: `1px solid ${vars.color.primary}`,
      },
      danger: { background: '#dc2626', color: '#fff' },
    },
    size: {
      sm: { padding: '6px 12px', fontSize: '0.875rem' },
      md: { padding: '8px 16px' },
      lg: { padding: '12px 24px', fontSize: '1.125rem' },
    },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});
```

```tsx
// App.tsx
import { themeClass, buttonRecipe } from './styles/app.css';

export function App() {
  return (
    <div className={themeClass}>
      <button className={buttonRecipe({ variant: 'danger', size: 'sm' })}>
        Удалить
      </button>
    </div>
  );
}
```

Под капотом: `.css.ts` файлы компилируются esbuild/SWC-плагином в `.css` + `.css.js` (классы — строковые константы). Темы — наборы CSS-переменных, привязанные к классу `themeClass`. Sprinkles — аналог утилитарного слоя: ты декларируешь атомы (padding, color, display...), а композитор собирает из них классы, как Tailwind, но из твоих токенов:

```ts
import { createSprinkles, defineProperties } from '@vanilla-extract/sprinkles';

const properties = defineProperties({
  properties: {
    padding: { sm: vars.spacing.sm, md: vars.spacing.md },
    color: { primary: vars.color.primary, text: vars.color.text },
    display: ['block', 'flex', 'none'],
  },
});

export const sprinkles = createSprinkles(properties);
// sprinkles({ padding: 'md', color: 'primary', display: 'flex' }) → строка классов
```

Плюсы vanilla-extract: типизация стилей и тем (опечатка в токене — ошибка компиляции), нулевой рантайм, дизайн-токены как единый источник, отличный tree-shaking (неиспользуемые стили не попадают в CSS). Минусы: отдельные `.css.ts`-файлы разрывают «стили рядом с компонентом», требуется плагин сборки, экосистема меньше Tailwind.

:::tip[Тема как контракт, а не как соглашение]
В vanilla-extract опечатка в токене (`vars.color.primry`) — ошибка компиляции, а не серый цвет в продакшене. Держи токены в одном `.css.ts`-файле, импортируй оттуда везде: дизайн-система получает настоящий публичный API с типами.
:::

## Сравнительная таблица

| Критерий | styled-components | Emotion | Linaria | vanilla-extract |
|---|---|---|---|---|
| Рантайм | Сериализация в браузере | Сериализация в браузере | Только CSS-переменные | Ноль (чистый CSS) |
| SSR | Вытаскивание стилей из renderToString | Аналогично | CSS-файл из коробки | CSS-файл из коробки |
| Первый рендер | Стиль вставляется в <head> при рендере | Аналогично | CSS уже в бандле | CSS уже в бандле |
| Темизация | ThemeProvider + контекст | ThemeProvider + контекст | CSS-переменные | createTheme, CSS-переменные |
| Типизация | Дженерики пропсов | Аналогично | Средняя | Отличная (контракт темы) |
| Гидратация | Дорогая: стили пересчитываются | Аналогично | Дёшево | Дёшево |
| RSC-совместимость | ❌ Клиентский рантайм | ❌ | ✅ Стили — на сервере | ✅ |
| Экосистема / зрелость | Огромная legacy | Огромная legacy | Средняя | Растущая |
| Зависимость от сборки | Babel-плагин опционален | Аналогично | Babel — обязателен | esbuild/SWC-плагин |

## Почему CSS-in-JS потерял популярность: честный разбор

Категория runtime CSS-in-JS действительно ушла на спад. Причины по весу:

**1. Server Components и новая модель React.** RSC рендерятся на сервере и не имеют рантайм-состояния; styled-components и Emotion — клиентские библиотеки, требующие исполнения в браузере. Гидрировать их нужно всё равно, а значит вся модель «стили рождаются в браузере» конфликтует с направлением React. Next.js App Router прямо рекомендует CSS Modules, Tailwind или zero-runtime решения.

**2. Стоимость гидратации.** Исследования (например, метрики от Shopify и Salesforce за 2022–2023) показывали: на типичной странице runtime CSS-in-JS добавлял десятки килобайт JS и миллисекунды главного потока на сериализацию. Учитывая, что INP — третья метрика Core Web Vitals ([подробный разбор INP — на web.dev](https://web.dev/articles/inp), см. также [web-vitals](/05-styling-perf/web-vitals/)), это прямая потеря бизнес-метрик.

**3. Tailwind съел сценарий «скорость разработки».** Большинство команд брали CSS-in-JS ради вариативности и изоляции. Tailwind решает обе проблемы: изоляция через утилиты, вариативность через `cva` — без рантайм-стоимости и с куда меньшим бандлом JS.

**4. Нативный CSS догнал.** Custom Properties, `@layer`, `:has()`, нативная вложенность — проблемы 2016 года решены стандартом. То, ради чего терпели рантайм, сегодня бесплатно.

Где CSS-in-JS по-прежнему уместен: существующие кодовые базы (миграция дороже выгоды), изолированные виджеты сторонних скриптов (всё в одном JS-файле — фича), небольшие клиентские приложения без SSR, где удобство команды важнее метрик, и zero-runtime ветка (vanilla-extract) там, где нужна типизация токенов.

## Типичные ошибки и грабли

1. **Непрокинутый `$`-префикс у transient props.** `<Button primary>` в styled-components кладёт `primary="true"` в DOM → React warning о неизвестном атрибуте. Используй `$primary` — styled-components вырежет его из DOM.
2. **Создание styled-компонентов внутри рендера.** ``const Btn = styled.button`...` `` в теле компонента создаёт новый класс-компонент на каждый рендер → пересоздание стилей, потеря фокуса, утечки `<style>`-тегов. Styled-компоненты объявляются на уровне модуля.
3. **Динамическая интерполяция тяжёлых вычислений.** `${(p) => computeExpensiveGradient(p)}` выполняется на каждый рендер каждого экземпляра. Выноси вычисления наружу, мемоизируй, либо переноси в CSS-переменные.
4. **SSR без вытаскивания стилей.** Рендеришь на сервере, но не вставляешь `<style>` в HTML → flash of unstyled content (FOUC) до гидратации. styled-components: `ServerStyleSheet`; Emotion: `createEmotionServer`/`@emotion/server`.
5. **Тема как JS-объект вместо CSS-переменных в дизайн-системе.** Команда строит «темизацию через ThemeProvider», а потом нужен тёмный режим для виджета, встроенного в чужой сайт по iframe. CSS-переменные решают это декларативно; JS-тема — через прокидывание провайдеров. Правило: дизайн-токены — CSS-переменные, JS-тема — только для значений, реально зависящих от рантайм-логики.
6. **Linaria: попытка темизировать через контекст.** Линария не поддерживает ThemeProvider-паттерн: всё, что зависит от контекста, не вычисляется на сборке. Проектируй тему через CSS-переменные сразу, иначе получишь серию ошибок «cannot evaluate» на сборке.
7. **Смешивание styled-components и Emotion в одном проекте.** Два рантайма сериализации, две копии stylis, двойная стоимость гидратации. Мигрируй одной библиотекой целиком.

## Вопросы на собеседовании

1. **Что такое CSS-in-JS и какие проблемы решает?**
   Стили описываются в JS и привязываются к компоненту. Решает: изоляцию имён (генерация уникальных классов), удаление мёртвого кода, динамические стили через пропсы, темизацию через контекст, критический CSS при SSR.
2. **Как styled-components работает под капотом?**
   Babel-плагин компилирует шаблонные строки в массивы строк+интерполяций; на рендере интерполяции вычисляются с пропсами, stylis парсит CSS и генерирует класс из хэша; правило вставляется в `<style>` в `<head>`. Всё — в браузере, при первом рендере уникального набора стилей.
3. **Что такое transient props и зачем `$`-префикс?**
   Пропсы с `$` (например, `$primary`) не прокидываются в DOM — styled-components вырезает их из итоговых атрибутов. Без `$` нестандартный атрибут попадает в HTML и React выдаёт warning.
4. **Чем Linaria достигает zero-runtime? Чем ограничена?**
   Babel-плагин извлекает статические стили в CSS-файлы на сборке; динамика от пропсов — через CSS Custom Properties, которые рантайм выставляет на элементе. Ограничена: темизация только через CSS-переменные (нет ThemeProvider), сложные динамические стили не компилируются статически, нужен Babel-конвейер.
5. **Что такое vanilla-extract и чем отличается от Linaria?**
   Стили в `.css.ts`-файлах как TypeScript-код, компилируются в статический CSS + классы-хэши. Отличие от Linaria: строгая типизация тем (createTheme-контракт), встроенный слой атомарных утилит (Sprinkles) и рецепты (recipe), философия «токены как код, а не как интерполяции».
6. **Почему runtime CSS-in-JS конфликтует с React Server Components?**
   RSC не гидрируются и не имеют клиентского состояния; runtime-библиотеки требуют исполнения в браузере для генерации стилей — либо принудительно делают компонент клиентским, либо требуют двойного рендера. Рекомендация React-экосистемы: CSS Modules, Tailwind, zero-runtime.
7. **Как устроена темизация в styled-components и какова её цена?**
   ThemeProvider кладёт объект темы в контекст; интерполяции читают его через callback-пропсы. Цена: смена темы — полный перерендер дерева с пересериализацией всех стилей; против переключения CSS-переменных, где браузер просто перекрашивает.
8. **Когда CSS-in-JS всё ещё оправдан в 2026?**
   Legacy-кодовые базы (миграция дороже пользы), изолированные виджеты «всё-в-одном-JS», небольшие клиентские SPA без SSR, и zero-runtime ветка (vanilla-extract) там, где нужна типизация токенов без рантайм-стоимости.

## Практика

1. Настрой styled-components проект: компонент кнопки с вариантами (primary/outline/danger) и размерами (sm/md/lg) через карты стилей, типизация пропсов, transient props. Критерий: кнопка рендерится без React warnings, варианты переключаются, мёртвые стили не в бандле.
2. Реализуй SSR с styled-components: `renderToString` + `ServerStyleSheet`, вставка `<style>` в HTML. Критерий: первый ответ сервера содержит стили кнопки из задания 1, нет FOUC.
3. Перепиши кнопку на Linaria: статические варианты извлекаются в CSS, динамика цвета — через CSS-переменную. Критерий: в продакшен-бандле нет кода Linaria-рантайма, стили — в отдельном CSS-файле.
4. Собери мини-дизайн-систему на vanilla-extract: `createTheme` с токенами, `recipe` для кнопки, Sprinkles для утилит. Критерий: смена темы — замена одного класса на контейнере, опечатка в токене — ошибка TypeScript.
5. Эксперимент с гидратацией: сравни INP и размер JS на одном и том же списке из 500 элементов, стилизованном (а) styled-components, (б) vanilla-extract. Критерий: замеры в Lighthouse/INP-поле и таблица с разницей.
6. Спланируй миграцию условного проекта со styled-components на Tailwind + cva: инвентаризация компонентов, порядок (листья → контейнеры), критерии приёмки. Критерий: план с оценкой и рисками, первый мигрированный компонент.

## Что почитать

- [styled-components: документация](https://styled-components.com/) — API, темизация, SSR, tooling.
- [Emotion: документация](https://emotion.sh/docs/introduction) — css prop, серверный рендеринг, производительность.
- [Linaria: репозиторий](https://github.com/callstack/linaria) — механика zero-runtime, ограничения, интеграции.
- [vanilla-extract: документация](https://vanilla-extract.style/) — темы, recipes, sprinkles.
- [Why We're Breaking Up with CSS-in-JS (Sam Magura, 2022)](https://dev.to/srmagura/why-were-breaking-up-with-css-in-js-4h9n) — эссе-разбор проблем runtime-подхода с цифрами и контекстом.
- [React docs: стилизация и Server Components](https://react.dev/reference/react-dom/server) — официальная позиция по совместимости подходов с RSC.
