---
title: "GraphQL, DataLoader и gRPC: три протокола — три мира"
description: "GraphQL: схема, резолверы в NestJS, N+1 и DataLoader, persisted queries. gRPC: Protocol Buffers, четыре вида RPC, генерация кода, микросервисный транспорт. Сравнение REST/GraphQL/gRPC."
---

REST из прошлой главы — не единственный способ отдать данные. В этой главе два альтернативных мира. **GraphQL** переворачивает контракт: не сервер решает, что отдать, а клиент описывает, какие поля ему нужны — удобно для сложных фронтендов, но приносит свои демоны вроде N+1. **gRPC** — противоположный полюс: жёсткий контракт, бинарный формат, HTTP/2-стримы; язык общения сервисов между собой, а не с браузером.

Ты напишешь резолвер в NestJS, поймаешь N+1 руками и вылечишь его DataLoader'ом, опишешь сервис на Protocol Buffers и поднимешь gRPC-транспорт через `@nestjs/microservices`. В конце — честное сравнение и критерии выбора.

## GraphQL: клиент диктует форму ответа

Проблема REST, которую GraphQL решает: фронтенд ходит в `GET /user`, потом в `GET /user/42/orders`, потом в `GET /orders/7/items` — три запроса, три оверхеда, лишние данные в каждом. GraphQL предлагает один эндпоинт, на котором клиент шлёт **query** — декларативное описание нужного графа данных:

```graphql
query {
  user(id: 42) {
    email
    orders(status: PAID, limit: 5) {
      total
      items { title price }
    }
  }
}
```

Ответ — ровно тот же JSON по форме, без лишних полей. Один запрос — одна сетевая поездка. Это главная ценность: устранение over-fetching (поля, которые не нужны) и under-fetching (не хватило — иди ещё раз).

### Схема и типы

Схема — типизированный контракт. Типы: `String`, `Int`, `Float`, `Boolean`, `ID` и пользовательские `type`/`enum`/`input`:

```graphql
# schema.graphql
type User {
  id: ID!
  email: String!
  role: Role!
  orders(status: OrderStatus, limit: Int = 20, cursor: String): OrderPage!
}

type Order {
  id: ID!
  total: Int!          # деньги — в минорных единицах, копейках/центах
  status: OrderStatus!
  items: [OrderItem!]!
}

type OrderPage {
  items: [Order!]!
  nextCursor: String
  hasMore: Boolean!
}

enum Role { USER ADMIN }
enum OrderStatus { DRAFT PAID SHIPPED CANCELLED }

type Query {
  user(id: ID!): User
  orders(userId: ID!, limit: Int = 20, cursor: String): OrderPage!
}

type Mutation {
  createOrder(input: CreateOrderInput!): Order!
  cancelOrder(id: ID!): Order!
}

input CreateOrderInput {
  userId: ID!
  itemIds: [ID!]!
}
```

`!` — non-nullable. Всё в схеме строго: сервер не сможет отдать `null` там, где стоит `!`, — это защищает клиент от «а вдруг поля нет».

### Queries, Mutations, Subscriptions

- **Query** — чтение. Может быть несколько параллельных полей в одном запросе.
- **Mutation** — изменение. Выполняются последовательно, в порядке следования.
- **Subscription** — поток событий поверх WebSocket: клиент подписался — сервер пушит.

```graphql
subscription {
  orderUpdated(userId: 42) {
    id status total
  }
}
```

Подписки — самая громоздкая часть GraphQL: нужен отдельный WebSocket-транспорт, при нескольких инстансах — брокер (Redis Pub/Sub) между ними, и авторизация на уровне события. По умолчанию бери SSE или WebSocket-гейтвей напрямую; subscriptions — когда фронт реально ждёт богатый граф событий.

Инструментальная заметка: в разработке включай GraphiQL/Apollo Sandbox (включается одной опцией `playground`/в новых версиях — по дефолту) — это REPL для схемы: автодополнение полей, документация типов, история запросов. Закрывай его в проде или прячь за авторизацией: открытый playground — рабочий конструктор запросов против твоего API.

### Резолверы в NestJS

Подключение — `@nestjs/graphql` с code-first (декораторы генерируют схему) или schema-first (пишешь `.graphql`, пишешь резолверы). Разберём code-first, он доминирует в Nest-экосистеме:

```bash
npm i @nestjs/graphql @apollo/server graphql
```

```ts
// users.resolver.ts
import { Resolver, Query, Args, ID, Parent, ResolveField } from '@nestjs/graphql';

@Resolver(() => UserModel)
export class UsersResolver {
  constructor(
    private readonly users: UsersService,
    private readonly ordersLoader: OrdersDataLoader, // DataLoader — ниже
  ) {}

  @Query(() => UserModel, { nullable: true })
  async user(@Args('id', { type: () => ID }) id: string) {
    return this.users.findById(id);
  }

  // ResolveField — «виртуальное поле»: вызывается, когда клиент запросил orders
  @ResolveField(() => OrderPageModel)
  async orders(
    @Parent() user: UserModel,
    @Args('limit', { type: () => Int, defaultValue: 20 }) limit: number,
    @Args('cursor', { nullable: true }) cursor?: string,
  ) {
    return this.users.ordersOf(user.id, { limit, cursor });
  }
}
```

`@ResolveField` — ключевая механика: поле `orders` в типе `User` не хранится в таблице users, оно «резолвится» лениво — только если клиент его запросил. Именно здесь прячется демон N+1.

## N+1: проклятие GraphQL и DataLoader

Запрос:

```graphql
query { users(limit: 50) { email orders { total } } }
```

Наивная реализация: 1 запрос за 50 пользователей, потом **50 запросов** за заказами каждого — итого 51 SQL-запрос. Клиент наращивает глубину — нагрузка растёт экспоненциально. Это N+1, и это причина номер один падения GraphQL-продакшенов.

**DataLoader** решает это батчингом и кэшированием в рамках одного запроса:

```ts
// orders.dataloader.ts
import DataLoader from 'dataloader';

@Injectable()
export class OrdersDataLoader {
  create() {
    return new DataLoader<string, Order[]>(async (userIds) => {
      // вызывается ОДИН раз на тик Event Loop со всеми накопленными id
      const orders = await this.db.query.orders.findMany({
        where: inArray(Orders.userId, [...userIds]),
      });
      // порядок ответа должен совпадать с порядком входных id
      return userIds.map((id) => orders.filter((o) => o.userId === id));
    });
  }
}
```

```ts
// в ResolveField
@ResolveField(() => [OrderModel])
orders(@Parent() user: UserModel) {
  return this.ordersLoader.load(user.id); // выглядит как запрос, но батчится
}
```

Механика: `load()` не ходит в БД, а кладёт id во внутреннюю очередь. DataLoader ждёт конца текущей итерации Event Loop, собирает все id и делает **один** запрос `WHERE user_id IN (...)`. Все 50 вызовов получают свои массивы заказов.

:::caution[DataLoader создаётся на каждый запрос]
Синглтон-DataLoader смешает батчи разных клиентов и утечёт данными между запросами. Создавай инстанс в провайдере с `Scope.REQUEST` или в `context` функции GraphQL-модуля. Это самая частая ошибка — и самая опасная: с виду всё работает, а чужие данные утекают.
:::

```ts
// context: фабрика на каждый GraphQL-запрос
GraphQLModule.forRoot<ApolloDriverConfig>({
  driver: ApolloDriver,
  autoSchemaFile: true,
  context: ({ req }) => ({
    user: req.user,
    loaders: {
      orders: ordersDataLoader.create(), // свой DataLoader на запрос
    },
  }),
}),
```

Дополнительно: **persisted queries** — клиент шлёт не текст запроса, а хеш (`hash` + `extensions`), сервер хранит текст заранее. Плюсы: меньше трафик, быстрее парсинг, закрытие поверхности для произвольных тяжёлых запросов (безопасность). Минус — нужен процесс публикации запросов из сборки фронта. Используются в мобильных приложениях и высоконагруженных API.

:::tip[Дедлайн на весь GraphQL-запрос]
Помимо лимитов сложности поставь общий дедлайн на выполнение запроса (например, 10 секунд, как в interceptor-главе): суммарное время всех резолверов. Иначе один медленный резолвер в глубине графа завесит весь ответ, и клиент уйдёт по своему таймауту раньше, чем сервер заметит проблему.
:::

### Когда GraphQL уместен

Уместен: сложный фронт с разнообразными экранами из одних данных (дашборды, админки, B2B-кабинеты), много клиентов с разными потребностями, сильно связный граф сущностей. Неуместен: простой CRUD (REST проще), публичный API без доверия к клиентам (нужен rate-limit по сложности запросов — `graphql-query-complexity`), команда без опыта диагностики (дедлайны запросов отлаживать сложнее, чем HTTP-логи).

Обязательный набор для GraphQL в проде: ограничение глубины и сложности запроса, пагинация каждой коллекции, DataLoader везде, трейсинг резолверов (Apollo Studio/OpenTelemetry), persisted queries для мобильных клиентов.

## gRPC: жёсткий контракт и скорость

gRPC — RPC-фреймворк от Google для общения **сервисов между собой**. Противоположность GraphQL: контракт фиксируется в `.proto`-файле, из него генерируются сервер и клиенты на любом языке, передача — бинарная (protobuf) поверх HTTP/2.

### Protocol Buffers: синтаксис

```protobuf
// orders/v1/orders.proto
syntax = "proto3";

package orders.v1; // неймспейс: версия — в пакете

// --- Сообщения: контракты данных ---
message GetOrderRequest {
  string id = 1; // теги (1, 2, 3...) — бинарная сериализация, не меняй номера
}

message Order {
  string id = 1;
  string user_id = 2;
  int64 total_cents = 3;  // деньги — integer, никогда float
  OrderStatus status = 4;
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0; // нулевое значение обязательно
  ORDER_STATUS_DRAFT = 1;
  ORDER_STATUS_PAID = 2;
  ORDER_STATUS_SHIPPED = 3;
}

message CreateOrderRequest {
  string user_id = 1;
  repeated string item_ids = 2; // repeated = массив
}

message OrderEvent {
  string order_id = 1;
  OrderStatus new_status = 2;
}

message WatchOrdersRequest {
  string user_id = 1;
}

// --- Сервис: четыре вида RPC ---
service OrdersService {
  // 1. Unary: запрос → ответ (как обычный HTTP)
  rpc GetOrder (GetOrderRequest) returns (Order);

  // 2. Server streaming: один запрос → поток событий
  rpc WatchOrders (WatchOrdersRequest) returns (stream OrderEvent);

  // 3. Client streaming: поток загрузки → один ответ (импорт логов, чанки файла)
  rpc UploadOrderAttachments (stream OrderAttachment) returns (UploadSummary);

  // 4. Bidirectional streaming: оба потока (чат, realtime-репликация)
  rpc SyncOrders (stream SyncRequest) returns (stream SyncResponse);
}
```

Правила protobuf: номера полей — часть бинарного формата, не менять и не переиспользовать; новые поля добавляются новыми номерами — старые клиенты их просто проигнорируют (это и есть эволюция схемы без брейкинга); `0` у enum — всегда «unspecified».

### Генерация кода

```bash
# protoc — компилятор; плагины генерируют TS
npm i -D grpc-tools grpc_tools_node_protoc_ts
protoc \
  --proto_path=./proto \
  --js_out=import_style=commonjs,binary:./src/generated \
  --grpc_out=grpc_js:./src/generated \
  --ts_out=grpc_js:./src/generated \
  orders/v1/orders.proto
```

Из одного `.proto` получаешь типы сообщений и клиентские стабы. В Go/Rust/Java — свои генераторы из того же файла. Контракт един, реализации — любые.

### Микросервисный транспорт в NestJS

`@nestjs/microservices` превращает Nest-приложение в gRPC-сервер/клиент:

```bash
npm i @nestjs/microservices @grpc/grpc-js @grpc/proto-loader
```

```ts
// grpc-server: users.service.ts как микросервис
// main.ts
const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  transport: Transport.GRPC,
  options: {
    package: 'users.v1',
    protoPath: join(__dirname, 'proto/users/v1/users.proto'),
    url: '0.0.0.0:50051', // gRPC живёт на своём порту
  },
});
await app.listen();
```

```ts
// users.controller.ts — хендлеры RPC как обычные методы
@Controller()
export class UsersGrpcController {
  constructor(private readonly users: UsersService) {}

  @GrpcMethod('UsersService', 'GetUser')
  getUser(data: GetUserRequest) { // data — распарсенный protobuf
    return this.users.findById(data.id); // вернёшь message — сериализуется сам
  }

  @GrpcStreamMethod('UsersService', 'WatchUsers')
  watchUsers(data: WatchUsersRequest): Observable<UserEvent> {
    return this.users.watch(data.userId); // RxJS Observable → серверный стрим
  }
}
```

```ts
// grpc-client: orders-service вызывает users-service
@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'USERS_PACKAGE',
        transport: Transport.GRPC,
        options: {
          package: 'users.v1',
          protoPath: join(__dirname, 'proto/users/v1/users.proto'),
          url: 'users-service:50051', // service discovery / k8s DNS
        },
      },
    ]),
  ],
})
export class OrdersModule {}

@Injectable()
export class OrdersService {
  @Inject('USERS_PACKAGE') private readonly client: ClientGrpc;
  private usersSvc!: UsersServiceClient;

  onModuleInit() {
    this.usersSvc = this.client.getService<UsersServiceClient>('UsersService');
  }

  async createOrder(dto: CreateOrderDto) {
    const user = await firstValueFrom(this.usersSvc.getUser({ id: dto.userId }));
    if (!user) throw new NotFoundException('Пользователь не найден');
    // ...
  }
}
```

Плюсы, которые делают gRPC стандартом внутри микросервисных сетей: строгий контракт (поменял `.proto` — компилятор поймает всех), бинарная скорость (protobuf компактнее JSON в разы), HTTP/2 (мультиплексирование, дедлайны через `deadline` из коробки), стримы как примитив языка.

Ограничения: браузер не говорит gRPC напрямую (нужен grpc-web-прокси — Envoy), отладка curl'ом невозможна (бинарь), схема эволюционирует жёстче JSON. Поэтому gRPC — внутри периметра, REST/GraphQL — наружу.

## Сравнение: REST vs GraphQL vs gRPC

| Критерий | REST | GraphQL | gRPC |
|---|---|---|---|
| Контракт | OpenAPI, мягкий | Схема, строгая | `.proto`, строгая + codegen |
| Кто выбирает поля | Сервер (фикс. ресурсы) | Клиент (query) | Сервер (фикс. сообщения) |
| Формат | JSON, текст | JSON, текст | Protobuf, бинарь |
| Транспорт | HTTP/1.1–2 | HTTP + WS | HTTP/2 |
| Стримы | SSE/WebSocket вручную | Subscriptions (WS) | 4 вида из коробки |
| Клиент | Браузер, всё | Браузер, приложения | Сервис ↔ сервис |
| Нагрузка | Предсказуемая | Требует лимитов сложности | Максимальная плотность |
| Отладка | curl, легко | Тяжелее (глубокие query) | grpcurl + рефлексия |

Выбор на практике: публичный и клиентский API — REST (+OpenAPI) по умолчанию, GraphQL — если фронт сложный и данные сильно связаны. Между сервисами — gRPC, если больше 2–3 сервисов и высокий трафик; REST между сервисами приемлем и часто проще в маленьких командах. Реалтайм в браузер — WebSocket/SSE поверх REST, не «subscriptions по умолчанию».

## Переменные, фрагменты и ошибки GraphQL

Практические примитивы языка, без которых реальные запросы не пишут:

```graphql
query UserCard($id: ID!, $withOrders: Boolean!) {
  user(id: $id) {
    ...UserBase
    orders @include(if: $withOrders) { total }
  }
}

fragment UserBase on User {
  id
  email
  role
}
```

**Переменные** — параметры запроса, чтобы не конкатенировать строки (инъекции через query string — это реальность). **Фрагменты** — переиспользуемые куски схемы: фронтенд-дублирование полей исчезает. **Директивы** (`@include`, `@skip`) — условное включение полей на уровне клиента.

Модель ошибок в GraphQL отличается от HTTP-стиля: ответ может содержать **и данные, и ошибки одновременно**:

```json
{
  "data": { "user": { "email": "a@b.c", "orders": null } },
  "errors": [
    { "message": "Orders service timeout", "path": ["user", "orders"], "extensions": { "code": "UPSTREAM_TIMEOUT" } }
  ]
}
```

Это partial data: один резолвер упал — остальное отдалось. Клиент обязан проверять `errors`, а не только `data`. Для типизации `extensions.code` — машиночитаемый код ошибки, аналог твоего `type` из RFC 7807.

В мульти-командных системах поверх схем возникает **федерация** (Apollo Federation) — каждый сервис владеет своими типами, gateway склеивает из них единый граф. Мощно, но это целая под-инфраструктура: начинай с одного GraphQL-сервера, федерацию подключай только когда граф реально разрезается по командам.

## gRPC в проде: ошибки, дедлайны, health-checks

Три вещи, отличающие игрушечный gRPC от продакшен-интеграции.

**Коды ошибок.** gRPC не несёт HTTP-статусы — у него свои status codes, и их надо маппить осознанно:

```ts
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';

if (!user) throw new RpcException({ code: status.NOT_FOUND, message: 'Пользователь не найден' });
// INVALID_ARGUMENT -> 400, UNAUTHENTICATED -> 401, PERMISSION_DENIED -> 403,
// ALREADY_EXISTS -> 409, UNAVAILABLE -> апстрим упал (ретрайбельно)
```

`UNAVAILABLE` — единственный из частых кодов, который по умолчанию стоит **ретраить**: сеть моргнула, инстанс ушёл на рестарт. Остальное — постоянные ошибки, ретрай лишь умножит нагрузку.

**Дедлайны.** Каждый вызов должен иметь дедлайн — иначе зависший апстрим повесит всю цепочку:

```ts
import { Metadata } from '@grpc/grpc-js';

const metadata = new Metadata();
metadata.set('deadline', String(Date.now() + 2000)); // 2 секунды на вызов

this.usersSvc.getUser({ id }, metadata).subscribe({ ... });
```

В распределённой цепочке (gateway → orders → users → payments) дедлайн **наследуется**: каждый хоп вычитает уже потраченное время. Это тот же таймаут, что мы обсуждали в interceptor-главе, только на уровне транспорта.

**Health-checks и reflection.** Оркестратор (Kubernetes) должен знать, жив ли gRPC-процесс: используй `grpc_health_v1` (probe-интеграция через `grpc_health_probe` или `@grpc/grpc-js`-health-check). Reflection — runtime-описание сервисов для `grpcurl`: без неё отладка бинарного протокола превращается в угадайку, включай её хотя бы на staging.

## Типичные ошибки и грабли

- **DataLoader-синглтон.** Общий на приложение DataLoader смешивает батчи запросов → утечка данных между пользователями. На каждый запрос — новый инстанс.
- **Резолверы без пагинации.** `User.orders` без limit на пользователе с 100 000 заказами = OOM. Любое поле-коллекция — только с пагинацией.
- **GraphQL без лимита сложности.** Клиент шлёт глубокий рекурсивный запрос, сервер считает минуты. `depthLimit` + query-complexity — обязательны для публичных API.
- **Мутация с сайд-эффектами без идемпотентности.** Ретрай мутации создаёт дубли — те же идемпотентные ключи, что и в REST, только через headers/input.
- **Float для денег в proto.** `float total = 1` — классическая ошибка; деньги — всегда `int64` в минорных единицах. Потеря копеек на округлениях в бинарном формате — не теория.
- **Правка номеров полей в .proto.** Поменял `string id = 1` на `int64 id = 1` — старые клиенты распарсят мусор. Только новые номера для новых полей; удалённые номера не переиспользовать.
- **gRPC наружу без прокси.** Браузер не поймёт HTTP/2-фреймы gRPC; публичный gRPC без grpc-web/Envoy — неработающая архитектура.

## Вопросы на собеседовании

1. **Что такое N+1 в GraphQL и как его лечат?** Связные поля резолвятся по одному запросу на родителя: 50 пользователей → 50 запросов за заказами. Лечение — DataLoader: батчинг всех `load()` в рамках одного тика Event Loop в один запрос `IN (...)`, плюс кэш в рамках запроса.
2. **Почему DataLoader на каждый запрос?** Батч-кэш живёт в инстансе. Общий инстанс смешает данные разных клиентов — утечка. Создаётся в context/REQUEST-scope на каждый GraphQL-запрос.
3. **Query vs Mutation vs Subscription?** Query — чтение (поля параллельны), Mutation — изменение (последовательно), Subscription — поток событий по WebSocket.
4. **Четыре вида RPC в gRPC?** Unary (1→1), server streaming (1→поток), client streaming (поток→1), bidirectional (поток↔поток). Через `stream` в объявлении rpc.
5. **Почему поля в protobuf имеют номера и почему их нельзя менять?** Номер — позиция в бинарном формате. Смена номера/типа сломает сериализацию для старых клиентов. Эволюция — только добавление новых номеров.
6. **Когда GraphQL, а когда REST?** GraphQL — сложный связный фронт, разные клиенты, over/under-fetching больно. REST — простые ресурсы, публичный API, предсказуемая нагрузка. GraphQL дороже в эксплуатации.
7. **Почему gRPC не для браузера?** HTTP/2-фрейминг и бинарный формат не поддерживаются браузером напрямую; нужен grpc-web-прокси. Плюс человекочитаемая отладка. Поэтому gRPC — внутри, REST наружу.
8. **Как версионировать gRPC API?** Версия в package (`orders.v1`/`orders.v2`) и в пути proto-файла. Поля эволюционируют без брейкинга; брейкинг — новый пакет.

## Практика

1. Подними `@nestjs/graphql` (Apollo, code-first): типы `User`/`Order`, Query `user(id)`, ResolveField `orders` с cursor-пагинацией. Критерий: один запрос `user(id:1){ email orders{ total } }` возвращает вложенные данные.
2. Воспроизведи N+1: залогируй число SQL-запросов при 20 пользователях (будет 21), подключи DataLoader (станет 2). Скриншот логов — в репозиторий.
3. Ограничь глубину запроса через `graphql-depth-limit` и сложность через `graphql-query-complexity`; докажи, что рекурсивный запрос отклоняется.
4. Опиши `orders.proto` (unary `GetOrder` + server-streaming `WatchOrders`), сгенерируй TS-клиент, вызови метод из второго Nest-сервиса через `ClientsModule` и RxJS `Observable`.
5. Реализуй идемпотентную мутацию `createOrder` в GraphQL (ключ в input) и gRPC-unary с дедлайном 2 секунды на клиенте (`metadata.set('deadline', ...)` через call options).

## Что почитать

- [GraphQL: Learn](https://graphql.org/learn/) — официальный тур по языку запросов.
- [DataLoader на GitHub](https://github.com/graphql/dataloader) — README с механикой батчинга и кэширования.
- [NestJS GraphQL](https://docs.nestjs.com/graphql/quick-start) и [NestJS Microservices (gRPC)](https://docs.nestjs.com/microservices/grpc) — интеграция в обоих направлениях.
- [Protocol Buffers: Language Guide (proto3)](https://protobuf.dev/programming-guides/proto3/) — правила эволюции схем.
- [gRPC Core Concepts](https://grpc.io/docs/what-is-grpc/core-concepts/) — четыре вида RPC и дедлайны.
- [ persisted queries в Apollo](https://www.apollographql.com/docs/apollo-server/performance/apq/) — automatic persisted queries.
