---
title: "Компонентные библиотеки React: MUI, Chakra UI, Mantine, Ant Design"
description: "Готовые UI-компоненты для React: Material UI и его система тем, Chakra UI со style props, Mantine с хуками из коробки, Ant Design для enterprise. Огромная сравнительная таблица, критерии выбора и антипаттерн смешивания двух библиотек."
---

Слоёная архитектура стилизации заканчивается верхним этажом: готовыми компонентами. Если препроцессоры — это инструменты, утилиты — кирпичи, CSS-in-JS — способ склеивания, то компонентные библиотеки — это дома под ключ: кнопки, формы, таблицы, модалки с доступностью, клавиатурной навигацией и локализацией из коробки. Выбор библиотеки — одно из самых дорогих фронтенд-решений: миграция с одной на другую — это переписывание каждого экрана, и вовлечённость библиотеки в кодовую базу растёт экспоненциально.

В этой главе — четыре главных игрока: Material UI (MUI) — флагман с самой большой экосистемой, Chakra UI — баланс скорости и кастомизации, Mantine — современный полный набор с хуками, Ant Design — стандарт enterprise в Азии и не только. Отдельно разбираем критерии выбора и антипаттерн, который видел каждый, кто работал в крупных командах: две библиотеки в одном проекте.

## Material UI (MUI): флагман

MUI — самая популярная React-библиотека (GitHub stars ~90k, npm загрузки ~4 млн в неделю). Реализация Material Design Google, но с v5 перешла с JSS на Emotion и стала гораздо гибче кастомизации.

```bash
npm i @mui/material @emotion/react @emotion/styled
```

### Система тем: createTheme

Всё строится вокруг объекта темы — словаря токенов:

```tsx
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { Button, CssBaseline } from '@mui/material';

const theme = createTheme({
  palette: {
    mode: 'light',                    // 'dark' — тёмная тема из коробки
    primary: { main: '#7c3aed' },     // основной брендовый
    secondary: { main: '#f59e0b' },
    background: { default: '#f8fafc', paper: '#ffffff' },
    text: { primary: '#1e293b' },
    // MUI автоматически вычисляет light/dark/contrastText оттенки
  },
  typography: {
    fontFamily: '"Inter", system-ui, sans-serif',
    h1: { fontSize: '2.5rem', fontWeight: 600 },
    button: { textTransform: 'none' }, // убрать дефолтный uppercase
  },
  spacing: 8,   // базовая единица: theme.spacing(2) = 16px
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: { padding: '8px 20px' },       // глобально для всех кнопок
      },
      defaultProps: { disableElevation: true }, // без тени по умолчанию
    },
  },
});

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />   {/* normalize + цвета фона из темы */}
      <Button variant="contained" color="primary">
        Сохранить
      </Button>
    </ThemeProvider>
  );
}
```

Ключевая механика: `palette` не просто цвета — MUI вычисляет из `main` производные оттенки (hover-состояния, контрастный текст) через колористику. `typography` — типографическая школа. `spacing` — ритм отступов (по умолчанию 8px, как в Material). `components` — точечные перекрытия стилей конкретных компонентов по имени (`MuiButton`).

### Три уровня кастомизации

```tsx
// 1. sx prop — «инлайн-стили на стероидах»: доступ ко всем токенам темы
<Box sx={{
  p: 2,                     // = theme.spacing(2) = 16px
  bgcolor: 'background.paper',
  color: 'text.primary',
  borderRadius: 2,
  '&:hover': { bgcolor: 'action.hover' },
  display: { xs: 'block', md: 'flex' },   // адаптив через брейкпоинты!
}}>
  Карточка
</Box>

// 2. styled() — как styled-components, но с доступом к теме
import { styled } from '@mui/material/styles';
const PillButton = styled(Button)(({ theme }) => ({
  borderRadius: 999,
  padding: theme.spacing(1, 3),
}));

// 3. theme.components — глобальные переопределения (см. createTheme выше)
```

:::tip[MUI v6: что нового]
В шестой версии (2024) — CSS-переменные как первоклассный режим темы (меньше рантайм-стоимости Emotion), улучшенная пигмента-совместимость, `slotProps` вместо разрозненных `*Props`, ускорение сборки. Для новых проектов бери v6; v5 — встретишь в legacy.
:::

Когда брать MUI: продукт со сложным UI, большая команда, нужна максимальная готовность (DataGrid, Autocomplete, DatePicker через MUI X — платные для продвинутых сценариев). Когда нет: нужен уникальный бренд, независимый от «материального» визуала — кастомизация возможна, но борьба с дефолтами дороже старта на Tailwind.

:::tip[Доступность — главный скрытый актив]
Все четыре библиотеки вкладываются в a11y: focus-стили, ARIA-атрибуты, клавиатурная навигация в компонентах. Это не «плюс», а снятие обязательства: команда без специального a11y-инженера получает доступный дефолт бесплатно. Проверяй его axe-core в CI — см. [a11y](/fullstack-devops-textbook/05-styling-perf/a11y/).
:::

## Chakra UI: style props как философия

Chakra UI (2019, Сегун Адебуйи) — библиотека, где стилизация — это пропсы, а не CSS. Каждый компонент принимает стилевые пропсы, смапленные на токены темы.

```bash
npm i @chakra-ui/react @emotion/react @emotion/styled framer-motion
```

```tsx
import { ChakraProvider, extendTheme, Button, Box, Stack } from '@chakra-ui/react';
import { useDisclosure, Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalCloseButton } from '@chakra-ui/react';

const theme = extendTheme({
  colors: {
    brand: {
      50: '#f5f3ff', 100: '#ede9fe', 500: '#7c3aed', 600: '#6d28d9', 700: '#5b21b6',
    },
  },
  fonts: { body: 'Inter, system-ui', heading: 'Inter, system-ui' },
  components: {
    Button: {
      baseStyle: { fontWeight: 500 },
      variants: {
        brand: (props) => ({   // вариант как функция темы
          bg: props.colorMode === 'dark' ? 'brand.200' : 'brand.500',
          color: 'white',
          _hover: { bg: 'brand.600' },
        }),
      },
    },
  },
});

export function ProfileCard() {
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <ChakraProvider theme={theme}>
      <Box maxW="md" borderWidth="1px" borderRadius="lg" p={6} boxShadow="sm">
        <Stack spacing={4}>
          <Button variant="brand" onClick={onOpen}>Редактировать</Button>
          <Button variant="ghost">Отмена</Button>
        </Stack>
      </Box>

      <Modal isOpen={isOpen} onClose={onClose} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Редактирование</ModalHeader>
          <ModalCloseButton />
          <ModalBody pb={6}>Форма профиля…</ModalBody>
        </ModalContent>
      </Modal>
    </ChakraProvider>
  );
}
```

Механика: style props (`p`, `bg`, `boxShadow`, `borderRadius`) трансформируются Emotion-рантаймом в CSS с lookup по теме. Синтаксис сокращений: `p` = padding, `px`/`py` = по осям, `bg` = background, `_hover`/`_focus` = псевдосостояния, адаптив через массивы (`fontSize={['sm', 'md', 'lg']}` = sm на мобильном, md на планшете, lg на десктопе).

Важное обновление: Chakra UI v3 (2024–2025) — значительная переработка: отказ от проприетарного рантайма в пользу Ark UI (headless-примитивы поверх Zag.js) и Panda CSS (zero-runtime стили). Старая модель style props через Emotion объявлена legacy. Для новых проектов — v3 и её новая архитектура; старый синтаксис выше — то, что ты встретишь в существующих кодовых базах.

Когда брать Chakra: нужна скорость разработки с удобной кастомизацией, команда любит style props, продукт средней сложности. Когда нет: жёсткие требования к размеру бандла (рантайм Emotion в v2), или наоборот — enterprise с таблицами на 10к строк (смотри Ant Design).

:::caution[Проверяй лицензию до выбора]
MUI X DataGrid Pro/Premium и Date Range Picker — коммерческие лицензии для продакшена (подписка на разработчика). Бесплатный DataGrid покрывает базовые сценарии, но виртуализация, группировка строк и некоторые фильтры — за деньги. Если бюджета нет, заложи в оценку Mantine Table или TanStack Table.
:::

## Mantine: полный набор с хуками

Mantine (2021, Виталий Ртищев) — самый быстрорастущий игрок: ~150+ хуков и компонентов, вплоть до Rich Text Editor, Carousel, Dates, Spotlight (cmd+k-палитра). Философия: «всё, что нужно продукту, в одном пакете».

```bash
npm i @mantine/core @mantine/hooks dayjs
```

```tsx
import { MantineProvider, createTheme, Button, TextInput, Group } from '@mantine/core';
import { useDisclosure, useDebouncedValue, useLocalStorage } from '@mantine/hooks';
import { Modal } from '@mantine/core';

const theme = createTheme({
  primaryColor: 'violet',
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui',
  components: {
    Button: {
      defaultProps: { size: 'md' },
    },
  },
});

export function SearchPanel() {
  // Хуки из коробки — то, за что Mantine любят
  const [opened, { open, close }] = useDisclosure(false);
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query, 300);
  const [history, setHistory] = useLocalStorage<string[]>({ key: 'search-history', defaultValue: [] });

  return (
    <MantineProvider theme={theme}>
      <TextInput
        label="Поиск"
        placeholder="Начни печатать…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <Group mt="md">
        <Button onClick={open}>Фильтры</Button>
      </Group>

      <Modal opened={opened} onClose={close} title="Фильтры поиска">
        Контент фильтров…
      </Modal>
    </MantineProvider>
  );
}
```

Чем Mantine выделяется:

- **`@mantine/hooks`** — десятки production-готовых хуков: `useDisclosure`, `useDebouncedValue`, `useLocalStorage`, `useMediaQuery`, `useIntersection`, `useForm` (через `@mantine/form` — альтернатива React Hook Form), `useHotkeys`. Часто ставят пакет хуков даже без компонентов.
- **Темизация**: функции-темы (как и Chakra v2), CSS-переменные под капотом, тёмная тема по `data-mantine-color-scheme`.
- **Компоненты без пробелов**: Slider, DatePicker, MultiSelect с поиском, Notification system, Stepper — то, что в MUI часто платное (MUI X), здесь бесплатно.

Когда брать Mantine: нужен максимум функционала за минимум зависимостей, админки и дашборды, команда ценит хуки. Когда нет: нужен проверенный enterprise-стек с огромной экосистемой интеграций (Ant Design), или строгий Material-визуал.

## Ant Design: enterprise-стандарт

Ant Design (Ant Group / Alibaba, 2015) — доминирующая библиотека в китайской экосистеме и серьёзный игрок в enterprise по всему миру. Сильнейшая сторона — сложные data-компоненты: Table с виртуализацией, фиксированными колонками, вложенностью; Form с декларативной валидацией; Tree, Transfer, Calendar.

```bash
npm i antd dayjs
```

```tsx
import { ConfigProvider, Table, Form, Input, Button, DatePicker } from 'antd';
import ruRU from 'antd/locale/ru_RU';           // локализация
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
dayjs.locale('ru');

const columns = [
  { title: 'Имя', dataIndex: 'name', key: 'name', sorter: (a, b) => a.name.localeCompare(b.name) },
  { title: 'Статус', dataIndex: 'status', key: 'status', filters: [
      { text: 'Активен', value: 'active' }, { text: 'Отключён', value: 'disabled' }
    ], onFilter: (v, r) => r.status === v },
  { title: 'Создан', dataIndex: 'createdAt', key: 'createdAt', render: (d) => d.format('DD.MM.YYYY') },
];

export function UsersPage() {
  return (
    <ConfigProvider locale={ruRU} theme={{
      token: { colorPrimary: '#7c3aed', borderRadius: 8 },
      components: { Table: { headerBg: '#f8fafc' } },
    }}>
      <Form layout="vertical" onFinish={(v) => console.log(v)}>
        <Form.Item name="name" label="Имя" rules={[{ required: true, message: 'Обязательное поле' }]}>
          <Input placeholder="Иван" />
        </Form.Item>
        <Form.Item name="birth" label="Дата рождения">
          <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} />
        </Form.Item>
        <Button type="primary" htmlType="submit">Создать</Button>
      </Form>

      <Table
        columns={columns}
        dataSource={[{ key: '1', name: 'Иван', status: 'active', createdAt: dayjs() }]}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 800 }}      // горизонтальный скролл на мобильных
      />
    </ConfigProvider>
  );
}
```

Механика: тема v5+ — CSS-переменные через `token` (design tokens из коробки, а не «вычисленные цвета» как раньше). Table — мощнейший компонент категории: сортировка, фильтры, группировка, expandable rows, виртуальный скролл на сотни тысяч строк, фиксация шапки и колонок.

Особенности и оговорки:

- **Локализация**: полная (включая русский, китайский, десятки других) через ConfigProvider; даты — dayjs (обязательная зависимость).
- **Размер**: antd — большой (~1 МБ с tree-shaking ощутимо меньше, но всё равно крупнее Mantine/Chakra по неубираемой базе).
- **Визуал**: «enterprise-китайский» — чистый, но узнаваемый; кастомизация возможна, но глубокий ребрендинг дорог.
- **Лицензия**: MIT.

Когда брать Ant Design: enterprise с data-heavy экранами (CRM, ERP, аналитика), команда с опытом, нужна Table мирового класса. Когда нет: маркетинговые сайты, продукт с уникальным брендом, жёсткие бюджеты размера.

## Radix и Shadcn: отсылка к разделу 05

Headless-примитивы (Radix) и способ владения кодом компонентов (Shadcn) — не «библиотека», а другая философия: вся логика доступности из библиотеки, вся стилизация — твоя. Разбор `asChild`, `cn()`, cva и кастомизации темы — в главе [Radix UI и Shadcn](/fullstack-devops-textbook/05-styling-perf/radix-shadcn/), дублировать не будем. Краткая роль в этой главе: Radix/Shadcn — выбор «контроль и бренд» против «скорость и готовность» четырёх библиотек выше.

## Огромная сравнительная таблица

| Критерий | MUI v6 | Chakra UI v3 | Mantine 8 | Ant Design 5 | Radix + Shadcn |
|---|---|---|---|---|---|
| **Стиль кастомизации** | Тема + sx/styled + overrides | Style props (v2) / recipes (v3) | Функции-темы + props | token + ConfigProvider | Твой CSS целиком |
| **Размер (npm, примерно)** | ~500 КБ+ | ~300 КБ | ~400 КБ | ~1 МБ | ~0 (только примитивы) |
| **Tree-shaking** | Хороший (ESM) | Средний | Хороший | Средний (база тяжёлая) | Отличный |
| **Доступность (a11y)** | Отличная | Хорошая | Отличная | Хорошая (локализация сильна) | Максимальная (фокус библиотеки) |
| **TypeScript** | Отличная | Отличная | Отличная | Хорошая | Отличная |
| **Экосистема** | Максимальная (MUI X, шаблоны, интеграции) | Большая | Быстрорастущая | Огромная (особенно в Азии) | Экосистема Tailwind |
| **Data-компоненты** | DataGrid (частично платный) | Слабые | Хорошие (Table базовый) | Лучшие в категории | Нет (собираешь сам) |
| **Хуки из коробки** | Мало | useDisclosure и др. | 100+ хуков | Мало | Radix + твои |
| **SSR/Next.js** | Отлично | Хорошо | Хорошо | Хорошо | Идеально (zero-runtime CSS) |
| **Лицензия** | MIT | MIT | MIT | MIT | MIT |
| **Кривая обучения** | Средняя | Низкая | Низкая | Средняя | Средняя-высокая |

## Критерии выбора

**Для pet-проекта:** скорость разработки решает. Mantine или Chakra — минимум кода для максимума результата, хуки закрывают типовые задачи (debounce, localStorage, disclosure) без пакетов. Если pet-проект — портфолио и важен «крафт»: Shadcn + Tailwind покажет зрелость подхода.

**Для продукта с брендом (SaaS):** главное — контроль визуала и предсказуемость при найме. Три расклада: (а) дизайн-система уже есть и совпадает с библиотекой — бери её (MUI для Material-подобных, Mantine для нейтральных); (б) бренд уникален — headless (Radix) + Tailwind + cva, цена — время на сборку собственных компонентов; (в) сроки горят, дизайн не критичен — Mantine/daisyUI и вперёд.

**Для enterprise (data-heavy):** Ant Design если нужны таблицы мирового класса и русская/китайская локализация из коробки; MUI если экосистема и найм важнее конкретных компонентов; Mantine — компромисс «всё бесплатно, что в MUI платное».

**Универсальные проверки перед выбором:** размер бандла на реальном прототипе (не на странице docs), совместимость с твоим SSR-стеком, активность репозитория (закрытые issues, частота релизов), лицензия (все MIT — но проверяй платные надстройки типа MUI X), наличие русской локализации если нужна.

## Антипаттерн: микс двух библиотек

Самая дорогая ошибка категории — «каждый разработчик выбрал свою библиотеку». Кнопки из MUI, формы из Ant Design, модалки из Chakra. Цена:

- **Размер бандла**: две-три полных системы тем, два рантайма стилизации (Emotion + CSS-in-JS Ant), иконсеты — легко +1.5–2 МБ JS. Прямой удар по LCP и INP ([web-vitals](/fullstack-devops-textbook/05-styling-perf/web-vitals/)).
- **Когнитивная стоимость**: у каждой библиотеки — свой API модалок, своё управление состоянием форм, свои пропсы. Разработчик платит переключением контекста на каждом файле.
- **Визуальная непоследовательность**: отступы, радиусы, тени разных систем рядом выглядят «слепленными» даже при одинаковой палитре.
- **Невозможность темизации**: одна тёмная тема должна пробиться через две системы компонентов с разными контрактами тем — обычно заканчивается хаками.

Правило: **одна библиотека на продукт**. Исключения — осознанные: headless-примитивы (Radix) поверх одной стилизованной библиотеки для специфических виджетов, либо этап миграции с жёстким дедлайном удаления старого.

## Типичные ошибки и грабли

1. **Кастомизация через `!important` и глобальный CSS поверх библиотеки.** Ломается при обновлении, непредсказуемая специфичность. Правильные рычаги: theme overrides (все четыре библиотеки их имеют), sx/style props, styled-обёртки.
2. **Игнорирование tree-shaking при импортах.** `import { Button } from 'antd'` — ок; подключение всего бандла через UMD или неправильный импорт — катастрофа размера. Проверяй анализатором бандла (source-map-explorer, bundlephobia) на первой неделе, не на первом инциденте.
3. **Переопределение стилей без понимания CSS-переменных темы.** В v5+ Ant, Mantine, MUI-v6 токены — CSS custom properties; перекрывать их надо на уровне `:root`/темы, а не классами компонентов. Читай сгенерированный CSS — там всё прозрачно.
4. **Использование DataGrid/Pro-компонентов без проверки лицензии.** MUI X DataGrid Pro/Premium — платные для коммерческого использования. На собеседовании спросят «а платили?» — знай ответ про лицензию.
5. **Модалка/дропдаун порталов без настройки z-index и контейнера.** Библиотеки рендерят в `document.body`; вложенность в layout с `transform`/`filter` ломает позиционирование (stacking context, см. [CSS Core: позиционирование](/fullstack-devops-textbook/02-css-core/positioning/)). Знай prop `container`/portal target своей библиотеки.
6. **Отсутствие русской локализации в Ant Design.** Без `ConfigProvider locale={ruRU}` и dayjs-locale получаешь английские «Submit», даты в US-формате и пагинацию «10条/页». Первое, что проверяй в i18n-чеклисте.
7. **Обновление мажорной версии библиотеки без codemod.** MUI v4→v5, Chakra v2→v3, Ant v4→v5 — у всех есть официальные codemod'ы и миграционные гайды. Ручная миграция тысячи файлов — недели боли; codemod — день.

## Вопросы на собеседовании

1. **Чем MUI отличается от Chakra UI архитектурно?**
   MUI — полная Material-реализация с вычисляемой палитрой (main → light/dark/contrastText), тремя уровнями кастомизации (sx, styled, theme.components) и коммерческими расширениями (MUI X). Chakra — style props поверх токенов темы, фокус на удобстве; v3 перешла на Ark UI + Panda CSS, отказавшись от Emotion-рантайма.
2. **Как устроена темизация в Mantine?**
   createTheme с функциями-темы (значения как функции от других токенов), CSS-переменные под капотом, переключение color-scheme через data-атрибут, перекрытия на уровне компонентов через theme.components. Полная типизация контракта.
3. **Почему Ant Design популярен в enterprise?**
   Лучшие в категории data-компоненты (Table с виртуализацией, фиксацией, группировкой), декларативные формы с валидацией, полная локализация (русский включён), стабильность API на годы, огромная экосистема в Азии. Цена — размер и менее гибкий визуал.
4. **Что такое Shadcn и почему его сравнивают с библиотеками?**
   Shadcn — не npm-зависимость, а CLI, копирующий код компонентов (построенных на Radix + Tailwind) в твой репозиторий. Ты владеешь кодом: кастомизируешь без ограничений, но обновления — ручное сравнение. Подробности — в [radix-shadcn](/fullstack-devops-textbook/05-styling-perf/radix-shadcn/).
5. **Как оценить размер библиотеки в бандле до принятия решения?**
   Прототип с реальными компонентами + анализатор (source-map-explorer/webpack-bundle-analyzer), не bundlephobia (теория). Смотри гзип, распределение по чанкам, стоимость одного компонента при tree-shaking.
6. **Антипаттерн микса библиотек: почему это дорого?**
   Несколько рантаймов стилизации и систем тем в одном бандле (+мегабайты), двойной API на каждый компонент (когнитивная нагрузка), несогласованный визуал, тёмная тема должна пробиться через разные контракты. Правило: одна библиотека на продукт.
7. **Когда выбрать headless (Radix) вместо стилизованной библиотеки?**
   Уникальный бренд и дизайн-система, жёсткие требования к размеру бандла, SSR-приложение с RSC, готовность инвестировать в собственную библиотеку компонентов. Не выбирать при сжатых сроках и отсутствии дизайн-ресурса.
8. **MUI X платный — что это меняет?**
   DataGrid Pro/Premium, DatePicker Pro, некоторые компоненты — коммерческая лицензия для продакшена. Меняет: бюджет (подписка на разработчика), либо поиск альтернатив (Mantine DataGrid, TanStack Table + своя стилизация), либо ограничение функционала бесплатной версии.

## Практика

1. Собери одну и ту же страницу (шапка, карточка, форма с валидацией, модалка) на MUI и на Mantine. Критерий: рабочие обе версии, таблица сравнения — количество строк кода, размер бандла (анализатор), впечатление от API.
2. Настрой тёмную тему в MUI или Mantine: переключатель в шапке, сохранение в localStorage, `prefers-color-scheme` как дефолт. Критерий: переключение без перезагрузки, все компоненты перекрашены (проверь границы инпутов — их забывают чаще всего).
3. В Ant Design построй Table с серверной сортировкой, фильтрацией и пагинацией (симулируй API задержкой 300 мс) с русской локализацией. Критерий: состояние сортировки/фильтров синхронизировано с «сервером», даты в формате ДД.ММ.ГГГГ, пагинация на русском.
4. Реализуй кастомный компонент поверх библиотеки: свой BrandedButton с тремя вариантами через theme overrides + styled-обёртку, не ломая обновления. Критерий: библиотечный Button в проекте не тронут, BrandedButton использует токены темы.
5. Спланируй миграцию условного проекта с Chakra v2 на v3 (или MUI v5 на v6): инвентаризация API-различий, порядок этапов, риски. Критерий: план с codemod-шагами и критериями приёмки каждого этапа.
6. Проведи аудит вымышленного репозитория с тремя UI-библиотеками в зависимостях: оцени бандл, составь план консолидации до одной библиотеки с минимальным риском. Критерий: план миграции по спринтам, метрика успеха — размер бандла и количество зависимостей до/после.

## Что почитать

- [MUI: документация](https://mui.com/material-ui/getting-started/) — темизация, sx, кастомизация, MUI X.
- [Chakra UI: документация](https://chakra-ui.com/) — v3, миграция с v2, философия style props.
- [Mantine: документация](https://mantine.dev/) — компоненты, хуки, темизация.
- [Ant Design: документация](https://ant.design/) — Table, Form, ConfigProvider, дизайн-токены v5.
- [Radix UI: документация](https://www.radix-ui.com/) — примитивы и доступность; связка с Shadcn — [глава раздела 05](/fullstack-devops-textbook/05-styling-perf/radix-shadcn/).
- [Component Party](https://component-party.dev/) — одни и те же задачи на разных фреймворках и библиотеках — лучший способ «пощупать» API до установки.
