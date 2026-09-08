---
title: "Realtime API: WebSocket и SSE"
description: "Чем realtime отличается от request/response: WebSocket handshake и фреймы под капотом, NestJS Gateway с комнатами, авторизация JWT в handshake, SSE для односторонних событий, reconnect с backoff, backpressure и heartbeat, масштабирование через Redis Pub/Sub adapter и проксирование через Nginx."
---

Весь REST, который ты спроектировал в прошлой главе, стоит на одной модели: клиент спрашивает — сервер отвечает. Запрос порождает ответ, один к одному, и между запросами соединение не существует. Эта модель покрывает 95% задач, но есть класс сценариев, где она работает плохо: уведомления, чаты, статусы «кто онлайн», прогресс длительных операций, коллаборативное редактирование. Пользователь создал задачу — и её исполнитель должен увидеть уведомление через миллисекунды, а не через 30 секунд, когда мобильное приложение вспомнит про polling.

Первая реакция новичка — polling: «давай клиент будет раз в N секунд дёргать `GET /notifications`». На малой нагрузке это работает, но математика беспощадна: 10 000 онлайн-пользователей с polling раз в 10 секунд — это 1000 запросов в секунду на эндпоинт, который почти всегда отвечает «ничего нового». Ты платишь полной ценой HTTP-запроса (TLS-handshake, заголовки, middleware, поход в БД) за пустой ответ.

В этой главе разбираем два инструмента, которые переворачивают модель: сервер сам пушит данные в открытое соединение. **WebSocket** — полнодуплексный канал поверх TCP, где и клиент, и сервер пишут в любой момент. **SSE (Server-Sent Events)** — односторонний поток событий поверх обычного HTTP, куда сервер пишет, а клиент только читает. Увидишь, как устроен WebSocket handshake и фреймы под капотом, как в NestJS оформляется gateway с комнатами и авторизацией через JWT, и почему в продакшене без reconnect-логики, heartbeat и Redis-адаптера realtime ломается при первом же рестарте пода: соединение живёт минутами, а деплой убивает инстансы каждую неделю.

## Realtime против request/response

В модели request/response сервер не может сказать клиенту ничего, пока клиент не спросил. Двигаться можно в трёх направлениях:

| Подход | Как работает | Задержка | Цена соединения |
|---|---|---|---|
| Polling | Клиент дёргает API по таймеру | До периода polling | Полный HTTP-запрос на тик |
| Long polling | Клиент ждёт ответ, пока не появятся данные | ~мгновенно | Одно соединение висит, но каждый цикл — новый запрос |
| WebSocket / SSE | Постоянное соединение, сервер пушит сам | ~мгновенно | Одно соединение на всю сессию |

Long polling — разумный компромисс эпохи до WebSocket, но у него утечка: каждый цикл «запрос → событие → новый запрос» — это заново заголовки, куки, TLS (если keep-alive не спас), заново маршрутизация по middleware. WebSocket платит эти издержки один раз — при установке соединения.

Ключевое отличие realtime-архитектуры — **состояние соединения**. В REST обработчик запроса живёт миллисекунды и не помнит ничего между вызовами. В realtime у тебя долгоживущие объекты: сокет с авторизацией, комнаты, подписки, буферы исходящих сообщений. Это меняет всё — от хранения сессии до стратегии деплоя: перезапуск инстанса рвёт тысячи живых соединений разом.

:::note[Когда НЕ нужен realtime]
Realtime — это дорого в эксплуатации: соединения едят файловые дескрипторы и память, нужны heartbeat, балансировка липких соединений, обработка reconnect-штормов. Если данные обновляются раз в минуту и никто не умрёт от задержки — оставь polling или refetch-on-focus. Правило: событие должно быть значимым с точки зрения времени (чат, аукцион, алерт) — тогда пуш. Просто «свежие данные» — тогда пусть клиент спрашивает.
:::

## WebSocket под капотом: handshake и фреймы

WebSocket начинается с обычного HTTP — и это не совпадение, а способ пройти через существующие прокси, балансировщики и файрволы.

### Handshake: HTTP 101

Клиент шлет GET с двумя заголовками, «прося» перейти на другой протокол:

```http
GET /ws/notifications HTTP/1.1
Host: api.petproject.dev
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

Сервер, если согласен, отвечает **101 Switching Protocols** — с этого байта HTTP заканчивается, и дальше по TCP-соединению идёт уже WebSocket-протокол:

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

`Sec-WebSocket-Key` — случайный base64-ключ, а `Sec-WebSocket-Accept` — его хеш вместе с магической константой (`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`). Это не безопасность, а защита от случайных некорректных «апгрейдов» со стороны прокси и кэшей. Настоящий TLS ты обеспечиваешь как обычно — wss:// поверх TLS.

:::tip[Проверь handshake руками]
В DevTools → Network → WS видишь фреймы WebSocket-кадров; `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" ...` покажет, отвечает ли сервер 101, а не 401 или 404. Дебаг realtime начинается с проверки, что handshake вообще проходит.
:::

### Фреймы: как устроен поток

После handshake данные идут **фреймами** — небольшими кадрами с заголовком: финальный ли это кадр сообщения (флаг FIN), тип опкода (текст 0x1, бинарный 0x2, ping 0x9, pong 0xA, close 0x8), маска (обязательна со стороны клиента по RFC) и длина полезной нагрузки. Сообщение может быть разбито на несколько фреймов (фрагментация) — для больших бинарных данных. Протокольный оверхед — от 2 байт на кадр: вот почему WebSocket в сотни раз дешевле polling на том же объёме данных.

Важны два служебных опкода. **Ping/pong** — механизм keepalive: любая сторона может послать ping, другая обязана ответить pong с тем же payload. **Close** — штатное закрытие с кодом и причиной (1000 — норма, 1001 — «ушёл», 1006 — аномальный разрыв без close-кадра, 1011 — серверная ошибка). Различай «сокет закрылся с кодом 1006» (сеть, краш) и «с кодом 1008» (выгнали за невалидный токен) — это разная диагностика.

## NestJS Gateway: события и комнаты

В NestJS WebSocket логика живёт в **gateway** — классе с декораторами, который фреймворк поднимает на отдельном порту (или path) поверх библиотеки `socket.io` (или `ws` — сырого WebSocket, без фолбэков и комнат из коробки).

```ts
// notifications.gateway.ts
import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  ConnectedSocket, MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UseGuards } from '@nestjs/common';
import { WsJwtGuard } from './ws-jwt.guard';

@WebSocketGateway({ namespace: '/ws/notifications', cors: { origin: true } })
@UseGuards(WsJwtGuard)
export class NotificationsGateway {
  @WebSocketServer()
  server: Server;

  // Клиент подписался на события задачи
  @SubscribeMessage('task:subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { taskId: string },
  ) {
    // Валидация: клиент имеет доступ к этой задаче?
    client.join(`task:${body.taskId}`);
    return { ok: true };
  }

  // Шлём событие всем в комнате задачи
  notifyTaskUpdate(taskId: string, payload: unknown) {
    this.server.to(`task:${taskId}`).emit('task:updated', payload);
  }

  // Личная комната пользователя — для уведомлений «только тебе»
  notifyUser(userId: string, payload: unknown) {
    this.server.to(`user:${userId}`).emit('notification:new', payload);
  }
}
```

**Комнаты (rooms)** — фундаментальная абстракция socket.io: сокет может входить в сколько угодно комнат, сервер шлёт кадр всем сокетам комнаты одним вызовом. Модель «личная комната `user:<id>`» — стандарт для персональных уведомлений: когда бизнес-логика создаёт уведомление, сервис просто вызывает `notifyUser(userId, dto)` и не думает, онлайн ли пользователь. Оффлайн-события добираются до клиента отдельным путём — через список непрочитанных в БД (см. [главу про паттерн Outbox](/07-nestjs-api/messaging-outbox/): событие пишется в БД транзакционно, а доставка через WebSocket — лучшее усилие, не гарантия).

:::caution[WebSocket — не гарантия доставки]
TCP даёт порядок и надёжность на уровне байтов, но не «сообщение дошло до логики клиента». Пока событие летело, клиент мог потерять сеть — и событие пропало навсегда. Не строй критичные процессы (деньги, заказы) на «клиент точно получил по сокету». Критичное — в БД и в retryable-очередь, сокет — для UX-мгновенности.
:::

## Авторизация в handshake: JWT до первого фрейма

Классическая ошибка — принимать любое WebSocket-соединение, а токен проверять в первом `@SubscribeMessage`. К этому моменту клиент уже занял соединение, файловый дескриптор и слот в памяти, а твой guard отвечает «не авторизован» — удобная лазейка для исчерпания ресурсов.

Правильно — проверять JWT **в handshake**, до апгрейда на 101. У socket.io токен приходит в `auth` при подключении:

```ts
// ws-jwt.guard.ts — проверка в момент handshake
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // В контексте WebSocket handshake аргумент — объект с socket
    const client = context.switchToWs().getClient();
    const token = client.handshake.auth?.token ?? client.handshake.headers.authorization?.replace('Bearer ', '');

    if (!token) throw new UnauthorizedException('Нет токена');
    try {
      const payload = await this.jwt.verifyAsync(token);
      // Кладём userId прямо в socket — дальше везде под рукой
      client.data.userId = payload.sub;
      // Личная комната — сразу при подключении
      client.join(`user:${payload.sub}`);
      return true;
    } catch {
      throw new UnauthorizedException('Токен просрочен или невалиден');
    }
  }
}
```

Теперь любой handler читает `client.data.userId`, а личная комната `user:<id>` готова с первой секунды. Дополнительно в каждом `task:subscribe` проверяй **авторизацию на ресурс**: членство в комнате задачи — не право, а следствие права, которое ты проверяешь по БД (владелец, исполнитель, наблюдатель — иначе любой подключится к чужому `task:1` и начнёт получать события).

:::tip[Почему не cookie]
Cookie в handshake-заголовках работает, но realtime-токен чище передавать явно через `auth`: он не утекает в логи прокси как Cookie header, и появляется свобода — для WS выпускать короткоживущий scoped-токен, а долгоживущий refresh оставить только REST.
:::

## SSE: простая альтернатива для односторонних событий

Если данные текут только **от сервера к клиенту** (уведомления, прогресс, логи, котировки), WebSocket — избыточен. SSE — это обычный HTTP GET с ответом `Content-Type: text/event-stream`, который никогда не заканчивается:

```http
GET /api/v1/notifications/stream HTTP/1.1
Authorization: Bearer eyJhbGciOi...

# ответ — бесконечный поток:
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"type":"task.assigned","taskId":42}

data: {"type":"task.updated","taskId":42}

```

Каждое событие — текст `data: <json>\n\n`, опционально с `id:` (тогда клиент шлёт `Last-Event-ID` при переподключении — бесплатная дедупликация на уровне протокола) и `event:` (тип события). В NestJS это тривиальный стрим поверх Observable:

```ts
// notifications.controller.ts
@Sse('stream')
@UseGuards(JwtAuthGuard) // обычный HTTP-guard — это обычный GET
stream(@Req() req: Request): Observable<MessageEvent> {
  return this.notificationsService.streamForUser(req.user.id);
}
```

Плюсы: обычный HTTP (работает через любой прокси, HTTP/2 мультиплексирует потоки в одно соединение), авторизация стандартными средствами, авто-переподключение из коробки у браузерного `EventSource`. Минусы: односторонность (для команд нужен отдельный POST), лимит в 6 соединений на домен у HTTP/1.1 (лечится HTTP/2), бинарные данные — только через base64. Правило: **нужен диалог — WebSocket, нужна лента событий — SSE**.

## Клиент: reconnect и backoff

Сеть рвётся. Wi-Fi переключается, ноутбук засыпает, мобильное приложение уходит в фон — твой сокет умирает, и это нормальное состояние, а не исключение. Клиент обязан уметь переподключаться. Но наивный «переподключайся сразу» убивает сервер при инциденте: тысячи клиентов одновременно ломятся в ранее павший инстанс — **reconnect-шторм**.

Решение — **экспоненциальный backoff с jitter**: пауза растёт (1s → 2s → 4s → …, cap ~30s), а случайный jitter (±20%) размазывает волну:

```ts
// ws-client.ts — reconnect с экспоненциальным backoff
import { io, Socket } from 'socket.io-client';

let attempt = 0;
let socket: Socket;

function connect() {
  socket = io('wss://api.petproject.dev/ws/notifications', {
    auth: { token: getAccessToken() },
    // НЕ доверяем авто-reconnect socket.io — сами управляем политикой
    reconnection: false,
  });

  socket.on('connect', () => {
    attempt = 0;
    resyncMissedEvents(); // после разрыва — догнать пропущенное через REST
  });

  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') {
      connect(); // сервер выгнал (деплой) — можно сразу
      return;
    }
    // Сетевая причина — ждём с backoff
    const delay = Math.min(30000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
    attempt += 1;
    setTimeout(connect, delay);
  });
}
```

Два принципа делают reconnect безопасным. Первый — **resync после connect**: сокет не хранит историю, поэтому после переподключения клиент запрашивает через REST «что пропустил с timestamp X» и накатывает. Именно здесь SSE с `Last-Event-ID` выигрывает — повторная доставка встроена в протокол. Второй — **рефреш токена при reconnect**: соединение жило часами — JWT протух; сначала обнови access token, потом подключайся, иначе получишь цикл 401 → reconnect → 401.

:::note[Jitter — обязателен]
Backoff без jitter — половина решения. Если у всех клиентов пауза ровно 8 секунд, при возврате сервера они снова стукятся в одну миллисекунду. Jitter (случайный разброс) разводит их по временной оси — классика из практики распределённых систем, стоит одна строка кода.
:::

## Backpressure и heartbeat

Два физических ограничения, о которых забывают, пока не упадёт прод.

**Heartbeat** — отличие «мёртвого» соединения от живого. TCP не детектирует разрыв, если маршрут просто пропал (кабель выдернули, процесс убит `-9`, мобильный клиент исчез в тоннеле): сторона «думает», что соединение живо, и держит его бесконечно. Решение — периодический ping (socket.io делает сам, с `pingInterval`/`pingTimeout`) и разрыв по таймауту. Без heartbeat слоты сокетов заканчиваются за сутки, а уведомления уходят в никуда.

**Backpressure** — клиент не успевает читать. Сокет — это буфер: если сервер шлёт быстрее, чем клиент потребляет (слабый телефон, просевшая сеть), буфер растёт в памяти обеих сторон. Признаки: latency сообщений растёт, память инстанса ползёт вверх. Лечение: мониторить `bufferedAmount` на клиенте, на сервере — ограничивать rate отправки и дропать/схлопывать неактуальные события (котировка заменяет предыдущую, а не добавляется в очередь: «latest wins»). Правило простое: для потоковых обновлений состояния очередь из одного последнего события лучше очереди из ста устаревших.

## Масштабирование: Redis Pub/Sub adapter

По умолчанию socket.io держит комнаты **в памяти одного процесса**. Это значит: два реплики пода, пользователь подключён к первой — `emit` со второй до него не дойдёт. Всё, для чего ты строил комнаты, молча ломается при второй реплике.

Решение — **adapter**: `emit` публикуется в Redis Pub/Sub, все инстансы получают и шлют своим сокетам:

```ts
// main.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

export class RedisIoAdapter extends IoAdapter {
  async connectToRedis(): Promise<void> {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }
}

// bootstrap()
const redisIoAdapter = new RedisIoAdapter(app);
await redisIoAdapter.connectToRedis();
app.useWebSocketAdapter(redisIoAdapter);
```

Важно понимать семантику Redis Pub/Sub: это **fire-and-forget fan-out**. Сообщение получают только те, кто подписан в момент публикации; нет ни персистентности, ни ack. Пользователь оффлайн — событие в эфире потерялось. Поэтому цепочка доставки в зрелой системе такая: бизнес-событие → транзакционная запись в БД (источник истины, см. [Postgres-репликацию и бэкапы](/08-data/postgres-backups/)) → публикация в Redis для мгновенной доставки онлайн-клиентам. Оффлайн-клиенты забирают из БД при следующем подключении. Двойной путь кажется избыточным, пока не получишь тикет «не пришло уведомление о платеже» — а восстановить его можно только из БД.

## Nginx: проксирование WebSocket и SSE

Nginx по умолчанию **рубит Upgrade-заголовки** и буферизует ответы — то есть WebSocket не проходит, а SSE идёт кусками с задержкой. Нужны явные заголовки:

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:3000;
    # Ключевые строки для WebSocket:
    proxy_http_version 1.1;              # HTTP/1.1 обязателен для Upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # Реальные IP и Host — для guard'ов и rate limiting:
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Долгоживущее соединение: без read_timeout Nginx рвёт idle-сокеты
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /api/v1/notifications/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";       # НЕ "upgrade" — это SSE, не WS
    proxy_buffering off;                  # отдаём каждое событие сразу
    proxy_cache off;
    proxy_read_timeout 3600s;             # иначе SSE умрёт каждые 60 секунд
}
```

Три грабли здесь. Первая: забыть `proxy_read_timeout` — дефолтные 60 секунд убивают любое молчащее соединение, и ты неделями ищешь «почему сокеты отваливаются ровно раз в минуту». Вторая: `proxy_buffering` для SSE — события скапливаются в буфере и доезжают пачкой. Третья: несколько инстансов за балансировщиком — sticky sessions (ip_hash или cookie) не нужны с Redis-адаптером, но обязательны без него.

## Типичные ошибки и грабли

- **Авторизация после подключения, а не в handshake.** Плохо: принимаешь любой сокет, токен проверяешь в первом сообщении — чужой процесс держит соединение и дескриптор. Хорошо: guard на handshake, невалидный токен → отказ в 101 до апгрейда.
- **Наивный мгновенный reconnect.** Плохо: `onclose -> connect()` — при падении сервера тысячи клиентов долбят его в одну секунду. Хорошо: экспоненциальный backoff с jitter и cap ~30s.
- **События по сокету как единственный источник.** Плохо: «уведомление о платеже ушло по WS — значит, дошло». Хорошо: событие в БД (Outbox) + push как лучшее усилие, догон после reconnect через REST.
- **Комнаты без проверки доступа.** Плохо: клиент шлёт `task:subscribe` с чужим `taskId` и получает чужие события. Хорошо: каждая подписка на комнату = проверка прав по БД, членство в комнате — следствие права.
- **Забытый heartbeat.** Плохо: соединения копятся, «живых» 50k, половина — мёртвые дни. Хорошо: ping/pong с таймаутом на сервере, клиент разрывает по своему таймауту.
- **SSE за прокси без настроек.** Плохо: `proxy_buffering on` и дефолтный `proxy_read_timeout` — события идут пачками раз в минуту. Хорошо: `proxy_buffering off`, таймаут в час.
- **Масштабирование без адаптера.** Плохо: две реплики, emit со второй не доходит до сокетов первой — «комнаты работают странно». Хорошо: Redis Pub/Sub adapter с первого дня, если планируешь больше одной реплики.

## Вопросы на собеседование

1. **Чем WebSocket отличается от SSE?** WebSocket — полнодуплексный бинарный канал поверх TCP после HTTP 101 upgrade; клиент и сервер пишут в любой момент. SSE — односторонний текстовый поток поверх обычного HTTP, только сервер → клиент, с авто-reconnect и `Last-Event-ID` в браузере.
2. **Как происходит WebSocket handshake?** Обычный GET с `Upgrade: websocket` и `Connection: Upgrade`, сервер отвечает `101 Switching Protocols` и хешом ключа в `Sec-WebSocket-Accept`; дальше по соединению идут WebSocket-фреймы, HTTP закончился.
3. **Как авторизовать WebSocket-соединение?** Проверять JWT в handshake (до 101) — в socket.io через `handshake.auth.token` или заголовок Authorization; отклонять невалидный до установки соединения. Подписки на комнаты проверять отдельно, по правам на ресурс.
4. **Почему нужен heartbeat?** TCP не детектирует молчаливый разрыв (выдернутый кабель, убитый процесс): стороны хранят мёртвые соединения вечно. Ping/pong с таймаутом очищает их и даёт клиенту сигнал на reconnect.
5. **Что такое backpressure и как с ним жить?** Производитель шлёт быстрее, чем потребитель читает; буфер сокета растёт. Лечится мониторингом `bufferedAmount`, ограничением rate и политикой «latest wins» для потоковых состояний.
6. **Как масштабировать socket.io на несколько инстансов?** Через Redis Pub/Sub adapter: emit публикуется в Redis, все инстансы ретранслируют своим сокетам. Помни, что Pub/Sub — fire-and-forget: для гарантии доставки нужен отдельный путь через БД.
7. **Nginx режет WebSocket — что делать?** Нужны `proxy_http_version 1.1`, `Upgrade`/`Connection "upgrade"` заголовки и большой `proxy_read_timeout`; для SSE наоборот `proxy_buffering off` и `Connection ""`.

## Практика

Мини-проект: **realtime-уведомления для pet-проекта** (задачник). Полный цикл: авторизация в handshake → личная комната → событие из бизнес-логики → reconnect с догоном пропущенного.

1. **Gateway с JWT в handshake.** `NotificationsGateway` на namespace `/ws/notifications` + `WsJwtGuard`, который верифицирует токен из `handshake.auth`, кладёт `userId` в `socket.data` и join'ит личную комнату `user:<id>`. Критерий: подключение с валидным токеном → 101 и комната в `socket.rooms`; с протухшим → отказ без установки соединения.
2. **Событие из бизнес-логики.** При назначении задачи исполнителю сервис пишет уведомление в БД (таблица `notifications`) и вызывает `notifyUser(userId, dto)` с событием `notification:new`. Критерий: два открытых клиента с разными токенами — уведомление приходит только назначенному.
3. **Клиент с reconnect и resync.** Клиент (Node-скрипт на `socket.io-client`) с экспоненциальным backoff + jitter; после `connect` дёргает `GET /notifications?after=<lastSeenId>` и выводит итоговую ленту. Критерий: убей сервер на 10 секунд, подними — клиент переподключился, события за время даунтайма не потерялись (догнал из БД), нет reconnect-шторма в логах.
4. **Redis-адаптер и две реплики.** Подними два инстанса приложения на разных портах, подключи `@socket.io/redis-adapter` к общему Redis. Критерий: клиент, подключённый к инстансу A, получает событие, опубликованное через инстанс B (проверь логами, кто куда emit'ит).
5. **Nginx перед gateway.** Один server-блок: `/ws/` проксирует на оба инстанса (round-robin, это нормально с адаптером) с Upgrade-заголовками и `proxy_read_timeout 3600s`. Критерий: `wss://` через Nginx работает, SSE-стрим (если добавил) отдаёт события без задержки, соединение живёт дольше минуты без трафика.

## Что почитать

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455.html) — первоисточник: handshake, фреймы, опкоды, close-коды.
- [NestJS: Gateways](https://docs.nestjs.com/websockets/gateways) — официальный разбор `@WebSocketGateway`, `@SubscribeMessage`, guards и adapter'ов.
- [socket.io: Rooms and Redis adapter](https://socket.io/docs/v4/redis-adapter/) — как устроены комнаты и что именно даёт масштабирование через Redis.
- [MDN: Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) — формат `text/event-stream`, `EventSource`, `Last-Event-ID`.
- [Nginx: WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) — официальная заметка про Upgrade-заголовки и таймауты.
- [Google SRE Book: Handling Overload](https://sre.google/sre-book/handling-overload/) — backoff, jitter и защита от reconnect-штормов в разделе про распределённые системы.
