---
title: "NestJS: модули, провайдеры и DI-контейнер под капотом"
description: "Философия NestJS, модули как границы кода, как DI-контейнер разрешает зависимости через рефлексию метаданных, scope'ы провайдеров, кастомные токены и forwardRef."
---

В краткой версии учебника ты видел NestJS по верхам: модули объединяют контроллеры и сервисы, DI отдаёт зависимости в конструктор, запрос проходит через guards и pipes. Здесь мы лезем под капот. Главный вопрос главы: **как фреймворк вообще узнаёт, что вписать в параметры конструктора?** Ответ на него — рефлексия метаданных, декораторы и дизайн DI-контейнера — объясняет 90% «магии» NestJS и делает тебя человеком, который чинит `UnknownDependenciesException`, а не гуглит его.

Почему это важно в проде: типичный сервис на NestJS содержит 50–200 провайдеров — репозитории, клиенты, очереди, конфиги. Если каждый из них создавать руками через `new`, ты получишь болото из скрытых зависимостей, которое невозможно тестировать. DI-контейнер решает три задачи разом: создание объектов в одном месте, подмена реализаций (в тестах и при смене провайдера), и явный граф зависимостей, который виден в декларативных модулях.

## Философия: архитектура как код

NestJS переносит в Node.js идеи из мира Angular и enterprise-Java: **инверсия управления**, **внедрение зависимостей**, **модули как границы**. Фреймворк не спрашивает, хочешь ли ты архитектуру — он просто даёт один правильный способ её выразить. Это ограничение — фича: проекты на NestJS в разных компаниях устроены одинаково, и онбординг занимает дни.

Два следствия, которые важно понять сразу:

1. **Под капотом — Express или Fastify.** Nest не пишет свой HTTP-сервер. `NestFactory.create()` собирает приложение поверх адаптера, и весь твой код про Event Loop, стримы и бэкпрессуру из прошлого раздела работает здесь без изменений.
2. **Вся «магия» — это runtime-метаданные.** Декораторы — обычные функции, вызываемые при загрузке модуля. Они записывают информацию в объекты/классы, а DI-контейнер читает её при старте. Ниже разберём механику.

```ts
// main.ts — точка входа
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule); // собирает граф модулей и провайдеров
  await app.listen(3000);
}
bootstrap();
```

## Модули: границы кода

Модуль — класс с декоратором `@Module()` (см. [официальный гайд по модулям](https://docs.nestjs.com/modules)), который описывает, что внутри и что наружу:

```ts
// users.module.ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController], // принимают HTTP-запросы
  providers: [UsersService],      // всё, чем владеет контейнер
  exports: [UsersService],        // что доступно другим модулям
})
export class UsersModule {}
```

Правило владения жёсткое: **провайдер живёт ровно в одном модуле**. Если `OrdersService` хочет `UsersService`, он не импортирует файл напрямую (это скрытая зависимость мимо контейнера), а заимпортирует `UsersModule` — и тогда получает доступ ко всему из `exports`.

```ts
// orders.module.ts
@Module({
  imports: [UsersModule], // теперь провайдеры из exports UsersModule доступны здесь
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
```

Корневой `AppModule` — просто композиция feature-модулей:

```ts
@Module({ imports: [UsersModule, OrdersModule, BillingModule] })
export class AppModule {}
```

:::tip[Feature-модули, а не слои]
Дроби по бизнес-областям (`UsersModule`, `OrdersModule`, `BillingModule`), а не по техническим слоям (`ControllersModule`, `ServicesModule`). Второе через полгода превращается в модуль-мусорку, где сцеплено всё со всем.
:::

## Как работает DI-контейнер: рефлексия под капотом

Вот сервис с двумя зависимостями. Вопрос: откуда контейнер знает, что в конструктор нужно передать `Repository<User>` и `ConfigService`? (База — [глава про providers](https://docs.nestjs.com/providers); ниже — механика под капотом.)

```ts
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  findById(id: string) {
    return this.repo.findOneBy({ id });
  }
}
```

Механика состоит из трёх частей.

### 1. Декораторы — это просто функции

`@Injectable()` — функция, которая вызывается с классом сразу после его объявления. В простейшем виде она ничего не делает — лишь помечает класс как «это провайдер, управляй им». Реальную работу делают другие декораторы: `@Controller()`, `@Module()`, `@Inject()` — все они пишут метаданные в объекты через Reflect API.

### 2. reflect-metadata и emitDecoratorMetadata

Nest опирается на стандартный (пока предложенный) API `Reflect.metadata`. В `tsconfig.json` проекта стоит два ключевых флага:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

`experimentalDecorators` включает синтаксис декораторов. А вот `emitDecoratorMetadata` — настоящий трюк: компилятор **автоматически эмитит метаданные о типах** для конструкторов, методов и свойств. Для кода выше TypeScript сгенерирует примерно такое:

```ts
// То, что делает компилятор с emitDecoratorMetadata (упрощённо)
UsersService = __decorate(
  [Injectable(), __metadata('design:paramtypes', [Repository, ConfigService])],
  UsersService,
);
```

Ключ `design:paramtypes` содержит **массив конструкторов параметров конструктора**. Вот откуда контейнер знает типы: он читает `Reflect.getMetadata('design:paramtypes', UsersService)` и получает `[Repository, ConfigService]`.

### 3. Разрешение графа при старте

При `NestFactory.create(AppModule)` контейнер:

1. Рекурсивно обходит дерево модулей из `imports`.
2. Собирает реестр токенов: классы из `providers` и кастомные токены (об них ниже).
3. Для каждого провайдера читает `design:paramtypes`, сопоставляет типы с токенами реестра и рекурсивно строит зависимости.
4. Создаёт экземпляры в правильном порядке (топологическая сортировка) и кэширует их.

Если зависимость не обязательна (плагин, опциональный клиент), есть декоратор `@Optional()` — контейнер подставит `undefined` вместо ошибки. И обратный ход: если один и тот же провайдер нужен в разных формах, внедряй оба через разные токены, помечая параметр `@Inject(...)` явно — автоматический вывод типов по `design:paramtypes` всегда проигрывает явному токену.

Если тип параметра — класс, зарегистрированный в `providers`, всё просто. Если это абстракция (интерфейс — чисто compile-time сущность, в runtime его не существует!) или примитив (`string`, конфиг), нужен явный токен через `@Inject('MAIL_TRANSPORT')` или `@Inject(CACHE_OPTIONS)` — иначе контейнер кинет `UnknownDependenciesException`.

:::note[Почему интерфейсы не работают как токены]
TypeScript-интерфейсы стираются при компиляции — в runtime от `interface Mailer {}` не остаётся ничего, что можно положить в реестр. Поэтому для абстракций используют классы, строки или `Symbol`. Это фундаментальное ограничение, а не каприз NestJS.
:::

## Scope'ы: сколько экземпляров создавать

По умолчанию каждый провайдер — синглтон на всё приложение (`DEFAULT`, см. [Injection scopes](https://docs.nestjs.com/fundamentals/injection-scopes)). Это правильно для сервисов, репозиториев, клиентов БД. Но есть два других scope:

| Scope | Экземпляров | Когда нужен |
|---|---|---|
| `DEFAULT` | Один на приложение | Сервисы, репозитории, HTTP-клиенты |
| `REQUEST` | Один на каждый запрос | Контекст запроса, трейсинг, tenant из JWT |
| `TRANSIENT` | Новый при каждом внедрении | Лёгкие stateful-хелперы |

```ts
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService {
  // Новый экземпляр на каждый входящий запрос.
  // Через внедрение REQUEST-объекта можно достать req:
  constructor(@Inject(REQUEST) private readonly req: Request) {}
}
```

Цена `REQUEST`-scope'а реальна: провайдер с этим scope и **все его зависимости** становятся request-scoped. Контейнер перестраивает подграф на каждый запрос — для горячего эндпоинта это заметная нагрузка. В проде это бьётся через `AsyncLocalStorage` из Node.js: один синглтон-сервис читает контекст запроса из ALS, а подграф не пересоздаётся. Тема следующего уровня, но держи в голове: `Scope.REQUEST` — не способ «прокинуть userId в сервис», а инструмент последнего резорта.

## Кастомные токены: useClass, useValue, useFactory

Не всё удобно выражать классом. Конфигурация, подключение к внешним системам, выбор реализации под флаг — для этого у провайдера есть несколько форм записи (полный разбор — [Custom providers](https://docs.nestjs.com/fundamentals/custom-providers)):

```ts
// constants.ts — токен как Symbol, чтобы не пересечься со строками
export const MAILER = Symbol('MAILER');
export const APP_CONFIG = Symbol('APP_CONFIG');

@Module({
  providers: [
    // 1. useClass — классическая подмена реализации
    //    В e2e-тестах заменишь SmtpMailer на MockMailer без правки кода
    { provide: MAILER, useClass: SmtpMailer },

    // 2. useValue — готовый объект (конфиг, фиктурный клиент)
    {
      provide: APP_CONFIG,
      useValue: { port: 3000, dbUrl: process.env.DATABASE_URL },
    },

    // 3. useFactory — вычисление на старте, зависимости внедряются в фабрику
    {
      provide: 'PRICE_CALCULATOR',
      inject: [APP_CONFIG],
      useFactory: (config: { dbUrl?: string }) =>
        config.dbUrl ? new SqlPriceCalculator() : new StaticPriceCalculator(),
    },

    // 4. useExisting — алиас на уже зарегистрированный провайдер
    { provide: LoggerService, useExisting: DevLoggerService },
  ],
})
export class CoreModule {}
```

Использование через `@Inject` с тем же токеном:

```ts
@Injectable()
export class NotificationService {
  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async notifyUser(email: string) {
    await this.mailer.send(email, 'Событие произошло');
  }
}
```

### Асинхронные провайдеры

Если провайдеру нужно подключиться к чему-то асинхронно (старт TCP-соединения, миграция, чтение секретов из Vault), используй `useFactory` с промисом — Nest дождётся его перед тем, как поднять приложение:

```ts
{
  provide: 'DB_CLIENT',
  useFactory: async () => {
    const client = await createDbClient(process.env.DATABASE_URL!);
    await client.migrate(); // миграции до первого запроса
    return client;
  },
}
```

:::note[Секреты — только асинхронно]
Секреты из Vault/AWS Secrets Manager доступны только по сети, поэтому конфиг-провайдер почти всегда `useFactory`-асинхронный. Синхронный `useValue` с `process.env` оставь для локальной разработки, в проде — строго через асинхронную фабрику с кэшем и ретраями.
:::

:::caution[Тяжёлые фабрики блокируют старт]
`await NestFactory.create()` не завершится, пока не отработают все асинхронные провайдеры. Проверка внешнего сервиса с таймаутом 30 секунд в фабрике — это 30 секунд до первого health-check. Держи стартовые фабрики лёгкими, тяжёлую инициализацию выноси в lazy-фабрики или `onModuleInit`.
:::

## Жизненный цикл модуля

Помимо конструктора, провайдеры и модули могут реализовывать хуки: `onModuleInit` (после разрешения всех зависимостей), `onApplicationBootstrap` (после инициализации всех модулей), `onModuleDestroy` / `beforeApplicationShutdown` (аккуратное закрытие). Для graceful shutdown с длинными соединениями это правильное место закрывать пулы и дожидаться фоновых задач.

## Глобальные модули, динамические модули и тестирование

Три паттерна, без которых реальный проект не собирается.

### @Global: модуль без импорта везде

`ConfigModule`, `LoggerModule` нужны почти каждому модулю. Импортировать их в сорок модулей — шум. `@Global()` решает это: провайдеры глобального модуля доступны **всем** модулям без `imports`:

```ts
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: config }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
```

:::caution[@Global — экономно]
Глобальный модуль прячет зависимость: модуль использует `APP_CONFIG`, но в его `imports` этого не видно. Глобальными делай инфраструктуру (конфиг, логирование, кэш-клиент). Бизнес-сервисы — всегда через явные импорты, иначе граф зависимостей превращается в кашу.
:::

### Dynamic modules: паттерн forRoot/forRootAsync

Библиотечные модули (TypeORM, Bull, JwtModule) настраиваются через статический метод, возвращающий `DynamicModule`:

```ts
@Module({})
export class DbModule {
  static forRootAsync(options: {
    inject: any[];
    useFactory: (...args: any[]) => Promise<{ url: string }>;
  }): DynamicModule {
    return {
      module: DbModule,
      providers: [
        { provide: 'DB_OPTIONS', ...options },
        {
          provide: 'DB_CLIENT',
          inject: ['DB_OPTIONS'],
          useFactory: async (opts: { url: string }) => createClient(opts.url),
        },
      ],
      exports: ['DB_CLIENT'],
      global: true,
    };
  }
}

// app.module.ts
@Module({
  imports: [
    DbModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: async (config: AppConfig) => ({ url: config.dbUrl }),
    }),
  ],
})
export class AppModule {}
```

`forRoot` — синхронная конфигурация, `forRootAsync` — с DI и асинхронными фабриками, `register` — обычно неглобальные feature-модули, `forFeature` — привязка к конкретной сущности (как `TypeOrmModule.forFeature([User])`). Знание этой конвенции экономит часы при чтении чужого кода.

### Testing providers: подмена без боли

DI окупается в тестах. В unit-тесте провайдера подменяешь зависимости моками через тот же механизм токенов:

```ts
const moduleRef = await Test.createTestingModule({
  providers: [
    OrdersService,
    { provide: UsersService, useValue: { findById: jest.fn().mockResolvedValue(user) } },
    { provide: PAYMENT_GATEWAY, useClass: FakeGateway },
  ],
}).compile();

const service = moduleRef.get(OrdersService); // контейнер собрал сервис с моками
```

А в e2e — `overrideProvider` поверх реального модуля:

```ts
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(MailerService)
  .useClass(MockMailer)
  .compile();
```

Код под тестом не меняется ни на символ — это и есть инверсия управления в действии.

## Циклические зависимости и forwardRef

Иногда зависимости цикличны по дизайну: `UsersService` шлёт события в `AuditService`, а `AuditService` подгружает пользователя для контекста. Без подсказки контейнер упрётся в неразрешимый граф и упадёт с `UnknownDependenciesException`.

Решение — `forwardRef()`: ленивая ссылка «разрешишь позже»:

```ts
// audit.service.ts
@Injectable()
export class AuditService {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private readonly users: UsersService,
  ) {}
}

// users.service.ts
@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => AuditService))
    private readonly audit: AuditService,
  ) {}
}
```

Сами модули тоже могут ссылаться друг на друга — там `forwardRef(() => UsersModule)` в `imports`.

`forwardRef` лечит симптом. Если циклов много — архитектура просит рефакторинга: выдели третий модуль (`EventsModule` / шину событий), в котором оба сервиса публикуют и слушают события через `EventEmitter2` — и цикл исчезнет сам.

## Типичные ошибки и грабли

- **Класс с `@Injectable()` не добавлен в `providers`.** Самая частая ошибка: файл создан, декоратор стоит, а регистрации в модуле нет → `UnknownDependenciesException` на старте. Проверяй `providers` первым делом.
- **Импорт файла вместо модуля.** `import { UsersService } from '../users/users.service'` работает (TS скомпилирует), но ломает контейнер: сервис не из `exports`, scope и моки не применятся. Ходи к чужому провайдеру только через `imports: [UsersModule]`.
- **`Scope.REQUEST` по цепочке.** Пометил один сервис request-scoped — весь его подграф стал request-scoped. Внезапно «проседает» RPS на 30%. Прокидывай контекст через `AsyncLocalStorage`, а не через scope.
- **`emitDecoratorMetadata: false` в своём tsconfig.** Всё падает со странными `UnknownDependenciesException` на примитивах. Генерируй проект через `nest new` или копируй tsconfig оттуда.
- **Циклы через `forwardRef` везде.** `forwardRef` — бинт, а не лекарство. Три и больше цикла в графе — сигнал выделить событийную шину.
- **Логика в `useFactory` без учёта ошибок.** Фабрика, которая кидает исключение при недоступном Redis, уронит весь старт приложения. Решай сознательно: падать или деградировать.

## Вопросы на собеседовании

1. **Как NestJS узнаёт типы параметров конструктора?** Через `emitDecoratorMetadata`: компилятор эмитит `design:paramtypes` с конструкторами параметров, контейнер читает их через `Reflect.getMetadata` и сопоставляет с токенами из реестра провайдеров.
2. **Почему нельзя внедрить интерфейс?** Интерфейсы стираются при компиляции — в runtime их не существует. Для абстракций используют классы, строки или `Symbol` как токены с `@Inject()`.
3. **Разница между scope DEFAULT и REQUEST?** DEFAULT — один синглтон на приложение. REQUEST — новый экземпляр на каждый запрос вместе со всем подграфом зависимостей; дорого и поэтому подходит для tenant-контекста, а не для прокидывания userId.
4. **Когда `useFactory`, а когда `useClass`?** `useClass` — когда нужна подмена реализации одного класса. `useFactory` — когда создание требует логики, конфига или асинхронной инициализации (подключения, миграции, выбор реализации по флагу).
5. **Что такое `forwardRef` и почему его не должно быть много?** Ленивая ссылка для разрыва циклических зависимостей на этапе построения графа. Много циклов — симптом того, что два сервиса знают слишком много друг о друге; лечится выделением посредника (шина событий, отдельный модуль).
6. **Что произойдёт, если асинхронный провайдер не ответит?** `NestFactory.create()` зависнет, приложение не поднимется, оркестратор (Docker/K8s) перезапустит контейнер по health-check. Поэтому в фабриках — таймауты и явная политика деградации.
7. **useValue vs useExisting?** `useValue` отдаёт конкретный объект. `useExisting` — алиас: оба токена указывают на один и тот же экземпляр существующего провайдера, сохраняя scope.

## Практика

1. Сгенерируй проект (`npm i -g @nestjs/cli && nest new api`) и создай три feature-модуля: `UsersModule`, `OrdersModule`, `BillingModule`. `BillingModule` должен использовать `UsersService` — строго через `imports`/`exports`, без прямого импорта файла.
2. Напиши токен `PAYMENT_GATEWAY` с двумя реализациями: `StripeGateway` и `FakeGateway`. Переключай реализацию через переменную окружения `NODE_ENV=test` в `useFactory`.
3. Сделай `useFactory`-провайдер, который на старте подключается к PostgreSQL, прогоняет миграции и отдаёт клиент; обеспечь таймаут 5 секунд и понятную ошибку при недоступности.
4. Воспроизведи циклическую зависимость (`UsersService` ↔ `AuditService`), почини через `forwardRef`, а затем перепиши через `EventEmitter2` из `@nestjs/event-emitter` — убедись, что цикл исчез.
5. Создай `RequestContextService` на `Scope.REQUEST` и замерь разницу в RPS через `autocannon` против варианта на `AsyncLocalStorage` (синглтон).

Критерий результата: `curl localhost:3000` отвечает, `UsersService` и `BillingModule` общаются через контейнер, циклов нет, в тестах `PAYMENT_GATEWAY` подменяется на фейк без правки кода.

## Что почитать

- [NestJS Fundamentals: Custom providers](https://docs.nestjs.com/fundamentals/custom-providers) — официальный разбор всех форм провайдеров.
- [NestJS Fundamentals: Injection scopes](https://docs.nestjs.com/fundamentals/injection-scopes) — scope'ы и производительность.
- [reflect-metadata на GitHub](https://github.com/rbuckton/reflect-metadata) — стандарт, на котором стоит вся рефлексия.
- [TypeScript: Decorators](https://www.typescriptlang.org/docs/handbook/decorators.html) — что именно эмитит компилятор.
- [InversifyJS](https://inversify.io/) — альтернативный DI-контейнер; полезно сравнить подходы.
- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html) — как прокидывать контекст запроса без `Scope.REQUEST`.
