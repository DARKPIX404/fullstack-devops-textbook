---
title: "Жизненный цикл запроса: Middleware → Guards → Pipes → Interceptors → Filters"
description: "Полный путь запроса через NestJS: middleware, guards с ролевой моделью на metadata, pipes с class-validator, interceptors для логирования и кэша, exception filters с единым форматом ошибок."
---

В прошлой главе ты собрал приложение: модули склеены, DI-контейнер отдал сервисы. Теперь разберёмся, что происходит с каждым HTTP-запросом после того, как Express передал его в руки NestJS. Эта цепочка — middleware → guards → interceptors → pipes → handler → interceptors → filters — выглядит как академическая схема, но на собеседованиях спрашивают в первую очередь, а в проде именно она определяет, где у тебя тормоза и где дыра в безопасности.

Почему порядок — не произвол. Guard стоит **до** pipes, потому что неавторизованный запрос не должен тратить ресурсы на валидацию тела. Pipe стоит **до** handler, потому что бизнес-логика имеет право считать входные данные валидными. Filter стоит **в конце**, потому что ошибку может кинуть любой этап. Понимание этого контракта — то, что отличает человека, который настраивает фреймворк, от человека, который им владеет.

## Общая схема

```text
Request
  → Middleware            ( express-стиль: req/res, логирование, CORS )
  → Guards                ( «можно ли?»: 401/403 до любой работы )
  → Interceptors (pre)    ( обёртка: таймер, кэш-запрос )
  → Pipes                 ( валидация и трансформация входа )
  → Controller handler    ( твой код )
  → Service / DB          ( бизнес-логика )
  → Interceptors (post)   ( маппинг ответа, финализация таймера )
  → Exception Filters     ( единый формат ошибок, если что-то бросили )
  → Response
```

Каждый этап — точка расширения с чётким контрактом. Дальше по одному.

## Middleware: дедовский слой Express

Middleware — единственный слой, который NestJS не изобретал: это обычные функции `(req, res, next)`. Применяются через `configure(consumer: MiddlewareConsumer)` в модуле, порядок важен:

```ts
// logger.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const started = Date.now();
    res.on('finish', () => {
      // лог после отправки ответа: метод, путь, статус, мс
      console.log(JSON.stringify({
        method: req.method, url: req.url,
        status: res.statusCode, ms: Date.now() - started,
      }));
    });
    next();
  }
}

// app.module.ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .forRoutes('*'); // или UsersController, или { path: 'users', method: RequestMethod.GET }
  }
}
```

Для аутентификации на уровне всего приложения (парсинг JWT и подстановка `req.user`) middleware подходит отлично: он работает до всех остальных слоёв. Но middleware не знает о маршрутах, metadata и DI-контейнере — для всего остального есть специализированные слои.

## Guards: «можно ли вообще»

Guard отвечает на один вопрос: **пропустить запрос или нет?** Реализует `CanActivate` и возвращает `boolean` (или Promise). Выполняется до pipes и controller — это принципиально.

```ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new UnauthorizedException('Нет токена');

    try {
      req.user = await this.jwt.verifyAsync(token); // дальше user доступен в handler
      return true;
    } catch {
      throw new UnauthorizedException('Токен недействителен');
    }
  }
}
```

### Ролевая модель: декоратор @Roles + metadata + Reflector

Классический паттерн: декоратор пишет требуемые роли в metadata, guard их читает через `Reflector`. Декоратор — функция, которая применяет `SetMetadata`:

```ts
// roles.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

Guard читает metadata сначала с обработчика, потом с класса — метод бьёт настройки класса:

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(), // metadata метода — приоритет
      ctx.getClass(),   // metadata контроллера
    ]);
    if (!required || required.length === 0) return true; // роли не требуются

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) throw new UnauthorizedException();

    const ok = required.some((role) => user.roles?.includes(role));
    if (!ok) throw new ForbiddenException(`Нужна роль: ${required.join(', ')}`);
    return true;
  }
}
```

Применение — guards складываются в массив и выполняются **в порядке объявления**:

```ts
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard) // сначала JWT, потом роли — порядок важен
export class AdminController {
  @Get('stats')
  @Roles('admin')
  getStats() { /* ... */ }

  @Get('moderation')
  @Roles('admin', 'moderator')
  getModeration() { /* ... */ }
}
```

:::tip[Привязывай Guards глобально, роли — локально]
`APP_GUARD` provider регистрирует guard глобально — тогда JWT-проверка работает на всех маршрутах, и забытый `@UseGuards` не оставит эндпоинт открытым. Роли через `@Roles(...)` навешиваешь точечно. Это «secure by default»: новый эндпоинт закрыт, пока не разрешишь.
:::

```ts
// глобальная регистрация
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: RolesGuard },
```

## Pipes: валидация и трансформация входа

Pipe получает входные данные, может их **трансформировать** (строку в число) или **валидировать** (бросить `BadRequestException`). Бывают параметровые (на одном аргументе) и глобальные.

### Валидация DTO через class-validator

Эталонный стек: `class-validator` + `class-transformer` + глобальный `ValidationPipe`:

```bash
npm i class-validator class-transformer
```

```ts
// create-user.dto.ts
import { IsEmail, IsInt, IsOptional, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @Length(8, 72)
  password!: string;

  @IsOptional()
  @IsInt()
  @Min(18)
  @Max(120)
  @Type(() => Number) // query-параметры приходят строками — явно кастим
  age?: number;
}
```

```ts
// main.ts — глобальный пайп, настройки критичны
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,            // отсекает поля, не описанные в DTO
    forbidNonWhitelisted: true, // 400, если клиент прислал лишнее поле
    transform: true,            // приводит plain object к экземпляру DTO-класса
    transformOptions: { enableImplicitConversion: false }, // явные @Type() важнее
  }),
);
```

```ts
@Post()
create(@Body() dto: CreateUserDto) {
  // dto — экземпляр класса, email точно email, лишние поля отброшены
}
```

`whitelist` + `forbidNonWhitelisted` — защита от **mass assignment**: клиент не сможет прислать `{"role": "admin"}` в форму регистрации, потому что поля `role` нет в DTO. Классическая дыра, закрывающаяся одним флагом.

### ParseIntPipe и кастомные pipes

Для примитивов есть готовые пайпы:

```ts
@Get(':id')
findOne(@Param('id', ParseIntPipe) id: number) {
  // id гарантированно число; "abc" вернёт 400 до входа в handler
}
```

Свой pipe — класс с методом `transform(value, metadata)`:

```ts
@Injectable()
export class ParseUUIDPipe implements PipeTransform<string, string> {
  transform(value: string) {
    if (!/^[0-9a-f-]{36}$/i.test(value)) {
      throw new BadRequestException('id должен быть UUID');
    }
    return value;
  }
}
```

### Параметризованные pipes и привязка на уровне параметра

Pipe может принимать опции через конструктор — тогда создаёшь его инстанс прямо в декораторе аргумента. А через `Param`/`Body`/`Query` пайп цепляется к **конкретному параметру**, минуя все глобальные:

```ts
@Get(':id')
findOne(
  @Param('id', new ParseIntPipe({ errorHttpStatusCode: 400 })) id: number,
  @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
) { /* id — число, limit — число или 20 */ }
```

Параметризованный пример — пайп с конфигом:

```ts
@Injectable()
export class TrimPipe implements PipeTransform<string, string> {
  constructor(private readonly maxLength: number) {}

  transform(value: string) {
    const trimmed = value.trim().slice(0, this.maxLength);
    return trimmed;
  }
}

// применение: инстанс создаётся вручную, DI не работает на уровне параметра
@Post()
search(@Body('q', new TrimPipe(100)) q: string) { /* ... */ }
```

Важный нюанс: пайп на уровне параметра создаётся через `new`, поэтому внутри него нельзя внедрять зависимости через конструктор. Нужен DI — регистрируй пайп глобально или на контроллере через `@UsePipes(ParseUUIDPipe)`; тогда контейнер соберёт его сам, но применится он уже ко всем параметрам сразу. Выбор между «гибко, но без DI» и «с DI, но грубо» — вечный компромисс этого слоя.

:::tip[Таймауты на уровне interceptor]
Если внешний вызов в handler может зависнуть, оборачивай `next.handle()` в `timeout(5000)` из RxJS: по истечении — `TimeoutException`, которую единый exception filter приведёт к 408. Это транспортный таймаут, как дедлайны в gRPC-главе, только для HTTP-стека.
:::

:::caution[DTO не заменяют проверку в БД]
Pipe гарантирует форму, а не смысл: email валиден по форме, но может быть занят. Уникальность, существование записи, бизнес-инварианты проверяются в сервисе. Иначе получишь 500 вместо 409.
:::

## Interceptors: обёртка вокруг handler

Interceptor оборачивает выполнение контроллера как `Promise`/`Observable`: до handler и после. Три рабочих сценария.

### Логирование с длительностью

```ts
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const started = Date.now();

    return next.handle().pipe(
      tap(() => {
        const res = ctx.switchToHttp().getResponse();
        console.log(JSON.stringify({
          method: req.method, url: req.url,
          status: res.statusCode, ms: Date.now() - started,
        }));
      }),
      catchError((err) => {
        console.log(JSON.stringify({
          method: req.method, url: req.url,
          error: err.message, ms: Date.now() - started,
        }));
        return throwError(() => err); // пробрасываем дальше, в exception filter
      }),
    );
  }
}
```

### Кэширование

```ts
@Injectable()
export class CacheInterceptor implements NestInterceptor {
  private readonly cache = new Map<string, { expires: number; data: unknown }>();

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest();
    if (req.method !== 'GET') return next.handle();

    const hit = this.cache.get(req.url);
    if (hit && hit.expires > Date.now()) {
      return of(hit.data); // handler вообще не вызвался
    }

    return next.handle().pipe(
      tap((data) => this.cache.set(req.url, {
        data, expires: Date.now() + 60_000,
      })),
    );
  }
}
```

В проде кэш так не пишут — берут `@nestjs/cache-manager` с Redis-стораджем. Логика та же: `of(cached)` до `next.handle()` экономит весь путь.

### Маппинг ответа

Старый фронт ждёт `{ data: ..., meta: ... }`, а сервис отдаёт голый массив. Маппинг — работа interceptor, а не контроллера: один interceptor на модуль, а не `return { data: ... }` в каждом handler.

## Exception Filters: единый формат ошибок

Без фильтра Nest отдаёт свои дефолтные ответы, а непойманные ошибки превращаются в стектрейс наружу. Фильтр перехватывает всё и приводит к контракту.

### Иерархия исключений

Nest приводит ответ к статусу по типу исключения:

- `HttpException` (и наследники: `BadRequestException`, `NotFoundException`, `ForbiddenException`...) → их HTTP-статус.
- Всё остальное (`TypeError`, ошибки БД, баги) → **500**.

```ts
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      this.logger.error(exception); // полный стектрейс — только в логи
    }

    res.status(status).json({
      statusCode: status,
      message: exception instanceof HttpException
        ? (exception.getResponse() as { message?: string | string[] }).message ?? exception.message
        : 'Internal server error', // никогда не отдавай текст бага клиенту
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
```

```ts
// main.ts
app.useGlobalFilters(new HttpExceptionFilter());
```

Кастомные исключения наследуют `HttpException` и несут бизнес-смысл:

```ts
export class InsufficientFundsException extends HttpException {
  constructor(balance: number, required: number) {
    super(
      { message: 'Недостаточно средств', balance, required },
      HttpStatus.CONFLICT, // 409 — конфликт с текущим состоянием ресурса
    );
  }
}
```

Бросил его из сервиса — фильтр сам отдаст 409 с деталями. Контроллер не знает про HTTP вообще — это главный смысл разделения.

:::caution[Не отдавай внутренности наружу]
Текст ошибки БД, пути к файлам, стектрейсы — только в логи. Клиент получает `statusCode`, понятный `message` и `traceId` для связки с логами. Иначе ты даришь атакующему карту приложения.
:::

## Локальная vs глобальная привязка: контекст применения

Любой слой (кроме middleware) можно привязать тремя способами, и выбор влияет на порядок и предсказуемость:

```ts
// 1. Глобально — через токены APP_*, порядок = порядок регистрации в массиве providers
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_PIPE, useFactory: () => new ValidationPipe({ whitelist: true, transform: true }) },
{ provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
{ provide: APP_FILTER, useClass: HttpExceptionFilter },

// 2. На контроллере — все методы
@UseGuards(RolesGuard)

// 3. На обработчике — самый высокий приоритет
@UseInterceptors(CacheInterceptor)
```

Порядок выполнения при нескольких привязках: глобальные → контроллер → обработчик. Это важно для guards: глобальный `JwtAuthGuard` отработает раньше локального `RolesGuard`, поэтому локальный guard всегда может рассчитывать на `req.user`. Для фильтров действует обратное правило — ближайший к месту броска исключение перехватывает первым.

### ExecutionContext: что видят все слои

Все слои после middleware получают не сырой `req/res`, а `ExecutionContext` — обёртку над аргументами вызова, знающую о типе приложения (HTTP, RPC, WebSocket):

```ts
const req = ctx.switchToHttp().getRequest();     // HTTP
// ctx.switchToRpc().getContext()                 // микросервисы
// ctx.switchToWs().getClient()                   // WebSocket-гейтвей
ctx.getHandler();   // MethodDescriptor — конкретный метод
ctx.getClass();     // ClassDescriptor — класс контроллера
```

Через `getHandler()`/`getClass()` читается metadata — так работают guards, ролевые декораторы и кастомные пайпы, которым нужно знать, куда именно пришёл запрос. Это единая точка расширения: один и тот же guard работает и в HTTP, и в WebSocket-гейтвее без изменений.

## Маппинг ответа: конверт data/meta в interceptor

Раньше мы маппили ответ «вручную» в конверте REST-главы. Interceptor делает это декларативно — один раз на приложение:

```ts
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // пропускаем стримы (SSE, файловые потоки) — их нельзя завернуть в { data }
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data;
        return { data }; // единый конверт для всех JSON-ответов
      }),
    );
  }
}
```

Тонкость с порядком: envelope-interceptor должен стоять **после** cache-interceptor в цепочке — иначе кэш сохранит развёрнутый объект, а отдаст его клиенту в другом виде, или наоборот. Цепочка interceptors выполняется по принципу луковицы: первый объявленный — крайний снаружи, последний — ближайший к handler.

## Метрики в interceptor: интеграция с наблюдаемостью

Interceptor — естественное место для RED-метрик (Rate, Errors, Duration), которые потом уйдут в Prometheus (раздел про наблюдаемость):

```ts
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.metrics.observe(req, 200, Date.now() - started),
        error: (err: HttpException) =>
          this.metrics.observe(req, err.getStatus?.() ?? 500, Date.now() - started),
      }),
    );
  }
}
```

Один интерсептор — и каждый эндпоинт получает длительность и счётчик по статусам без единой строки в контроллерах. Логирование, метрики, трейсинг, таймауты, кэш, envelope — пять типовых задач, которые живут именно здесь, а не в бизнес-логике.

## Сводка: что на каком слое делать

| Задача | Слой | Почему |
|---|---|---|
| Лог запроса, CORS, парсинг JWT | Middleware | Работает до роутинга, дёшево |
| Аутентификация, роли, feature-flag | Guard | Видит metadata, выполняется до валидации |
| Валидация формы, каст типов | Pipe | Бизнес-логика получает гарантированный вход |
| Кэш, метрики, envelope, таймауты | Interceptor | Оборачивает handler целиком, видит результат |
| Единый формат ошибок | Exception Filter | Ловит всё, включая ошибки guards и pipes |

### Производительность: где стоят твои миллисекунды

Когда эндпоинт «тормозит», порядок диагностики следует пайплайну: сначала смотри middleware и guards (выполняются на каждый запрос, даже отброшенный), потом pipes (валидация тяжёлого body — не бесплатна), потом сам handler. Полезный приём — тайминги по этапам через `Date.now()` в локальном логирующем interceptor: за один день ты увидишь, что 80% длительности уходит не в бизнес-логику, а в guard, который синхронно ходит в Redis без кэша. Оптимизируй по данным, а не интуиции: классическая ошибка — оптимизировать сервис, когда запрос висит на `@Roles`-проверке с N+1 в БД.

Ещё два тонких момента. Первый: guards и pipes могут возвращать и Promise, и Observable — но `canActivate` и `transform` по умолчанию ожидают Promise/значение, асинхронные стримы оборачивай явно. Второй: глобальные guards/pipes/filters регистрируются вне DI-контекста конкретного модуля, поэтому их собственные зависимости должны быть доступны в том модуле, где объявлен `{ provide: APP_GUARD, ... }` — чаще всего это корневой `AppModule`, импортирующий всё нужное.

Отдельно про files и стримы: если handler возвращает `StreamableFile` или SSE-поток, помни, что interceptor-обёртка с `map()` разрушит поток, попытавшись собрать его в память. Для файловых ответов проверяй тип и пропускай, а для SSE используй `ctx.switchToHttp().getResponse()` напрямую — оборачивать в envelope или кэшировать потоковые ответы нельзя в принципе.

## Типичные ошибки и грабли

- **Порядок guards перепутан.** `RolesGuard` до `JwtAuthGuard` → `req.user` ещё нет → вечный 403. JWT всегда первым.
- **`whitelist` не включён.** Клиент шлёт `{"isAdmin": true}` — лишнее поле молча игнорируется, но в сервисе через spread (`{ ...dto }`) попадает в UPDATE. Mass assignment в чистом виде.
- **`transform: true` без явных `@Type()`.** Неявная конверсия превращает `"0"` в `0`, `""` в `false` — тихие баги. Включай `enableImplicitConversion: false` и аннотируй поля.
- **Interceptor глотающий ошибки.** `catchError(() => of(fallback))` без проброса — handler упал, а клиент получил 200 с дефолтом. Ошибки из interceptor обязаны долетать до filter.
- **Pipe с тяжёлым I/O.** Pipe вызывается на каждый запрос; проверка существования в БД в кастомном пайпе превратится в нагрузку. Валидация формы — в pipe, существование — в сервис.
- **Фильтр, раскрывающий `exception.message` для 500.** Внутренние ошибки (`ECONNREFUSED`, SQL-синтаксис) не должны уходить клиенту. Только `logger.error`, клиенту — «Internal server error» + `traceId`.

## Вопросы на собеседовании

1. **Нарисуй порядок обработки запроса.** Middleware → Guards → Interceptors (pre) → Pipes → Handler → Interceptors (post) → Exception Filters → Response. Guard до pipes — чтобы неавторизованный запрос не тратил ресурсы; filters в конце — ловят ошибки любого этапа.
2. **Guard vs Middleware: в чём разница?** Middleware — Express-функция без знания о маршрутах и DI. Guard — класс в контейнере, видит `ExecutionContext` (handler, класс, metadata), умеет читать `@Roles`, выполняется после middleware, но до валидации.
3. **Как работает ролевая модель на metadata?** Декоратор `@Roles(...)` пишет массив ролей через `SetMetadata`. Guard через `Reflector.getAllAndOverride` читает metadata с handler'а (приоритет) и класса, сравнивает с `req.user.roles`.
4. **Что делает `ValidationPipe` с `whitelist: true`?** Отсекает из body/query все поля, не описанные декораторами в DTO. `forbidNonWhitelisted` дополнительно кидает 400 при попытке прислать лишнее.
5. **Interceptor vs Middleware?** Middleware оборачивает запрос на уровне req/res до роутинга. Interceptor оборачивает именно handler (знает класс, метод, результат), умеет маппить ответ и видеть ошибки после handler.
6. **Какой статус у непойманной ошибки и почему?** 500. Nest отличает `HttpException` (известный статус) от всего остального; всё остальное — баг, и по контракту это 500 с обезличенным сообщением.
7. **Зачем кастомные исключения-наследники HttpException?** Бизнес-логика (сервис) не импортирует HTTP. Кидает `InsufficientFundsException`, а маппинг исключение→статус живёт в одном месте — в самом классе исключения.

## Практика

1. Глобально зарегистрируй `JwtAuthGuard` и `RolesGuard` через `APP_GUARD`. Сделай публичный эндпоинт через кастомный декоратор `@Public()` (metadata + проверка в guard). Критерий: забытый `@UseGuards` не оставляет эндпоинт открытым.
2. Напиши DTO регистрации с `whitelist: true, forbidNonWhitelisted: true` и докажи через `curl`, что поле `role` из body отсекается с 400.
3. Сделай `ParseUUIDPipe` для параметра `:id` и `LoggingInterceptor` с JSON-логом `{method, url, status, ms}` на успех и на ошибку.
4. Напиши глобальный `HttpExceptionFilter` с форматом `{ statusCode, message, path, timestamp, traceId }` (traceId — через `AsyncLocalStorage` или uuid на запрос) и кастомное исключение `DomainConflictException` → 409. Покрой filter e2e-тестом.
5. Реализуй `CacheInterceptor` с `cache-manager` + Redis (потом, после раздела про Redis) или in-memory Map с TTL и инвалидацией по ключу.

## Что почитать

- [NestJS: Guards](https://docs.nestjs.com/guards) и [NestJS: Pipes](https://docs.nestjs.com/pipes) — официальные главы с контрактами.
- [class-validator](https://github.com/typestack/class-validator) — декораторы валидации, все правила.
- [NestJS: Interceptors](https://docs.nestjs.com/interceptors) и [Exception filters](https://docs.nestjs.com/exception-filters) — RxJS-подход и маппинг ошибок.
- [Reflector и metadata](https://docs.nestjs.com/fundamentals/execution-context) — `ExecutionContext` и работа с metadata.
- [OWASP Mass Assignment](https://owasp.org/www-community/attacks/Mass_Assignment_Cheat_Sheet) — почему `whitelist` обязателен.
