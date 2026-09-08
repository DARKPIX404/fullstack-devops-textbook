---
title: "Очереди и outbox на практике"
description: "Асинхронность между сервисами: проблема двойной записи, outbox pattern в PostgreSQL, RabbitMQ (exchange, binding, routing key), retry через TTL/DLX, DLQ, идемпотентный consumer, упорядоченность и честное сравнение брокеров."
---

В предыдущих главах ты отдавал данные клиенту: REST, GraphQL, gRPC. Но backend — это не только «принял запрос, отдал ответ». Значительная часть работы сервиса происходит *после* ответа: отправить письмо, обновить поисковый индекс, пересчитать агрегаты, отдать событие в аналитику. Если делать всё это синхронно внутри HTTP-запроса, пользователь ждёт, пока пятый по счёту апстрим ответит, а любой сбой в цепочке роняет весь запрос.

Эта глава — про то, как правильно разорвать цепочку: писать событие в ту же транзакцию, что и данные, и отдавать его в брокер отдельным ретранслятором. Это **outbox pattern**: без него системы теряют события — тихо и необратимо.

Ты разберёшь механику RabbitMQ под капотом: чем exchange отличается от очереди, куда деваются сообщения с истёкшим TTL и почему «ровно один раз» — ложь, которую переживают идемпотентным consumer'ом. Закончим мини-проектом: PostgreSQL + RabbitMQ + NestJS API + worker в docker-compose — от транзакции с outbox до ретраев и DLQ.

## Зачем вообще асинхронность

Синхронный вызов — это контракт «я жду тебя, и моя судьба — твоя». В цепочке `API → payments → fraud-check → bank` общий таймаут — сумма таймаутов, а вероятность сбоя — произведение. Под нагрузкой все потоки API висят на медленном апстриме, и сервис, который «ничего не делает», лежит.

Асинхронность меняет модель: сервис **ставит задачу в очередь и отвечает сразу**, а исполнитель разбирает задачи в своём темпе. Быстрый продюсер не утопает медленного консьюмера — очередь поглощает разницу скоростей, как буфер между стримами в Node.js. Дополнительные выигрыши:

- **Изоляция сбоев.** Упал consumer — сообщения ждут в очереди; поднялся — дочитал. Синхронная цепочка падает целиком при сбое любого звена.
- **Всплески.** Рассылка 100 000 писем: API быстро пишет 100 000 записей в БД и отвечает 201, worker'ы разгребают очередь часами.
- **Независимое масштабирование.** Медленная обработка лечится добавлением реплик consumer'а, а не ускорением API.

Плата тоже честная: eventual consistency (клиент не знает, когда задача выполнится), усложнённая отладка (запрос «улетел» куда-то и живёт своей жизнью) и необходимость думать о доставке минимум один раз, ретраях и порядке. Эта глава — про то, как платить эту цену без банкротства.

## Проблема двойной записи

Классическая схема «создать заказ и отправить событие» выглядит так:

```ts
// ПЛОХО: две независимые записи в две разные системы
async createOrder(dto: CreateOrderDto) {
  const order = await this.ordersRepo.save(dto);       // 1. запись в PostgreSQL
  await this.amqp.publish('orders', 'order.created', { // 2. отправка в RabbitMQ
    orderId: order.id,
  });
  return order;
}
```

Выглядит нормально, но это **две распределённые записи без транзакции между ними**. Сбоев ровно два, и оба плохи:

1. БД записала, publish упал (брокер недоступен) — заказ есть, события нет. Поисковый индекс и email-рассылка о заказе не узнают никогда.
2. Publish прошёл, а commit транзакции откатился (конфликт, валидация на уровне БД) — событие улетело о несуществующем заказе.

В проде первый сценарий случается регулярно: брокеры рестарту, сеть мерцает, DNS капризничает. И замечаешь ты его не сразу, а когда бизнес спрашивает «почему 30 заказов за вчера не попали в отчёт?».

Распространённое «решение» — publish *после* commit в `afterCommit`-хуке: сценарий 2 уходит, но сценарий 1 остаётся — между commit и publish процесс могут убить или брокер может лежать. Распределённой транзакции (two-phase commit) между PostgreSQL и RabbitMQ нет, и слава богу: 2PC блокирует обе системы и убивает доступность.

:::note[Transactional outbox]
Правильный паттерн называется **transactional outbox**: событие пишется в специальную таблицу *в той же транзакции*, что и изменение данных. Дальше отдельный процесс (**outbox relay**) читает таблицу и публикует события в брокер. Двойная запись превращается в одну транзакцию — а промежуточное хранилище даёт атомарность, которой не было.
:::

## Таблица outbox в PostgreSQL

Таблица тривиальна: идентификатор, тип события, полезная нагрузка, статус и метки времени:

```sql
-- migrations/001_outbox.sql
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT        NOT NULL,              -- "notification.requested"
  payload      JSONB       NOT NULL,              -- тело события
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ                          -- NULL = ещё не отправлено
);

-- relay выбирает пачку неотправленных событий быстро и без пропусков
CREATE INDEX outbox_unprocessed_idx
  ON outbox (id)
  WHERE processed_at IS NULL;
```

Частичный индекс (`WHERE processed_at IS NULL`) — важная деталь: таблица outbox растёт всегда, но горячий запрос relay затрагивает лишь хвост. Без частичного индекса relay со временем начнёт сканировать миллионы обработанных строк.

Теперь создание уведомления — одна транзакция, и обе записи либо есть, либо нет:

```ts
// notifications.service.ts
@Injectable()
export class NotificationsService {
  constructor(private readonly dataSource: DataSource) {}

  async request(dto: RequestNotificationDto): Promise<Notification> {
    // DataSource.transaction: всё внутри колбека — одна транзакция
    return this.dataSource.transaction(async (em) => {
      const notification = await em.getRepository(Notification).save({
        userId: dto.userId,
        channel: dto.channel,
        body: dto.body,
        status: 'pending',
      });

      // событие — в той же транзакции; либо обе записи закоммитятся, либо ни одной
      await em.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ($1, $2)`,
        [
          'notification.requested',
          JSON.stringify({ notificationId: notification.id, ...dto }),
        ],
      );

      return notification;
    });
  }
}
```

С точки зрения HTTP-клиента всё: 201, уведомление в статусе `pending`. Событие гарантированно лежит в БД и рано или поздно попадёт в брокер — даже если relay сейчас лежит.

:::caution[Outbox ≠ event sourcing]
Outbox — механизм надёжной доставки: строка живёт недолго, пока relay её не отправит. Event sourcing — модель хранения состояния как цепочки событий, которые не удаляют никогда. Начать хранить outbox как историю — через год получишь таблицу на сотни гигабайт, которую боишься трогать. В проде outbox-строки чистят (retention 7–30 дней), бэкап — обычный, как для любой таблицы (см. [главу про бэкапы PostgreSQL](/08-data/postgres-backups/)).
:::

## Outbox relay: из таблицы в брокер

Relay — отдельный процесс (лучше выделенный worker, не API). Цикл простой:

1. `SELECT ... FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`.
2. Опубликовать каждое событие в брокер.
3. Пометить `processed_at = now()` — пачкой, в отдельной короткой транзакции.

Ключевые слова тут — `FOR UPDATE SKIP LOCKED`: несколько реплик relay могут работать параллельно, и каждая возьмёт себе непересекающийся срез строк, не блокируя друг друга. Без `SKIP LOCKED` реплики вставали бы в очередь на блокировку строк.

```ts
// outbox-relay.service.ts — запускается интервалом, например каждые 500 мс
@Interval(500)
async relay(): Promise<void> {
  const batch = await this.dataSource.query(
    `UPDATE outbox
        SET processed_at = now()
      WHERE id IN (
            SELECT id FROM outbox
             WHERE processed_at IS NULL
             ORDER BY id
             LIMIT 100
             FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_type, payload`,
  );

  for (const row of batch) {
    await this.amqp.publish('notifications', row.event_type, row.payload, {
      messageId: String(row.id), // дедупликация downstream
    });
  }
}
```

Заметь хитрость: здесь запись `processed_at` идёт **до** публикации, а не после. Если помечать после успешного publish и упасть между publish и UPDATE — событие отправится дважды при следующем проходе. Лучше редкий «потерянный» ретрай в брокере (consumer идемпотентен — ниже), чем регулярные дубли.

Более строгий вариант — держать `processed_at` NULL до успешной публикации и хранить счётчик попыток. Это усложняет relay, но даёт наблюдаемость: алерт на число необработанных строк outbox ловит и мёртвый relay, и лежащий брокер (см. [главу про управление инцидентами](/12-iac-deploy-obs/incident-management/)).

## RabbitMQ под капотом: exchange, queue, binding

Главное, что нужно понять про RabbitMQ: **producer никогда не шлёт сообщение напрямую в очередь**. Всё идёт через посредника — exchange:

```
producer ──publish──▶ exchange ──routing──▶ queue ──consume──▶ consumer
                        ▲                       ▲
                        │ binding (queue ↔ routing key pattern)
```

- **Exchange** — точка входа. Получает сообщение и решает, в какие очереди его копировать по правилам маршрутизации.
- **Binding** — связь «очередь ↔ exchange + pattern». Это записи вида «очередь `email-sender` интересуется сообщениями с routing key `notification.*`».
- **Routing key** — строка-маршрут, которую producer кладёт в сообщение (например, `notification.requested`).

Типы exchange: **direct** (точное совпадение routing key), **topic** (паттерны с `*` и `#`: `notification.*` — один сегмент, `#` — любой хвост), **fanout** (копия во все привязанные очереди), **headers** (маршрутизация по атрибутам, редкость).

Почему такая схема, а не «очередь как pipe»? Потому что один факт должен интересовать разных получателей независимо: событие `order.created` должно попасть в очередь email-рассылки, в очередь поискового индексатора и в очередь аналитики. Producer публикует **один раз** в fanout/topic exchange — RabbitMQ сам размножает по очередям, каждая со своим consumer'ом и своей скоростью.

Объявляем топологию в consumer'е, а не только в producer'е — каждый процесс должен выживать, если запустился раньше брокера:

```ts
// topology.ts — идемпентно, можно вызывать на старте каждого процесса
async function assertTopology(ch: amqp.Channel) {
  await ch.assertExchange('notifications', 'topic', { durable: true });

  // основная очередь с DLX (о нём — в следующем разделе)
  await ch.assertQueue('notifications.send', {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'notifications.dlx',
    },
  });
  await ch.bindQueue('notifications.send', 'notifications', 'notification.requested');

  // dead-letter очередь
  await ch.assertExchange('notifications.dlx', 'topic', { durable: true });
  await ch.assertQueue('notifications.send.dlq', { durable: true });
  await ch.bindQueue('notifications.send.dlq', 'notifications.dlx', 'notification.requested');
}
```

`durable: true` — переживать рестарт брокера. Обменники и очереди без `durable` исчезают при перезапуске RabbitMQ вместе с сообщениями. Для продакшен-топологии это первое, что проверяют при аудите.

Consumer в worker-процессе:

```ts
// worker: notifications.worker.ts
await ch.consume('notifications.send', async (msg) => {
  if (!msg) return; // consumer отменён
  const event = JSON.parse(msg.content.toString());
  try {
    await this.sender.send(event);      // реальная работа: SMTP, внешний API…
    ch.ack(msg);                        // готово, сними с очереди
  } catch (err) {
    // requeue=false: сообщение уйдёт в DLX (ниже), а не обратно в голову очереди
    ch.nack(msg, false, false);
  }
}, { prefetch: 10 });
```

`prefetch` — сколько неподтверждённых сообщений RabbitMQ отдаёт consumer'у за раз. Без лимита медленный consumer выкачает всю очередь в память и упадёт по OOM.

## Retry через TTL и DLX, DLQ

Сообщение упало: SMTP-сервер ответил 502, внешний API таймаутнул. Что делать? Три варианта:

1. `nack(requeue=true)` — вернуть в голову очереди. Плохо: упавшее сообщение немедленно вернётся тому же consumer'у и будет крутиться в цикле, забивая очередь и спамя логи.
2. Ретрай с задержкой — вернуть позже, когда апстрим, возможно, ожил.
3. Сдаться — отправить в **dead-letter queue** (DLQ) для ручного разбора.

Варианты 2 и 3 реализуются связкой **TTL + DLX** (dead-letter exchange): отклонённое с `requeue=false` сообщение (или с истёкшим TTL) попадает в dead-letter exchange и дальше в очередь-отстойник. Для задержки используют очередь-«тюрьму» с TTL:

```
notifications.send ──nack──▶ notifications.dlx ──▶ notifications.retry (TTL 30 с)
                                     ▲                    │ TTL истёк / nack
                                     └────────────────────┘  (сообщение возвращается
                                                              в основную очередь)

nack без requeue в retry → notifications.dlx → notifications.send.dlq (навсегда, для разбора)
```

```ts
// retry-очередь: сообщения живут здесь 30 секунд, потом возвращаются в основную
await ch.assertQueue('notifications.retry', {
  durable: true,
  arguments: {
    'x-message-ttl': 30_000,                        // ждём 30 секунд
    'x-dead-letter-exchange': 'notifications',       // куда вернуться
    'x-dead-letter-routing-key': 'notification.requested',
  },
});
```

Итоговая схема: consumer ловит ошибку → считает попытки по заголовку `x-retry-count` → если меньше лимита (например, 5), шлёт в retry-очередь → через 30 секунд сообщение возвращается → лимит исчерпан — в DLQ с алертом разработчику (см. [главу про управление инцидентами](/12-iac-deploy-obs/incident-management/)).

:::tip[Экспоненциальная задержка]
Фиксированные 30 секунд — старт. Дальше задержку растят: 30 с → 2 мин → 10 мин → 30 мин. Апстрим, лежащий минуту, и апстрим в даунтайме на час требуют разного наступления — проще всего сделать несколько retry-очередей с разным TTL и переключать сообщение между ними по счётчику попыток.
:::

## Идемпотентный consumer

Настала правда, которую RabbitMQ не любит афишировать: **exactly once доставки не существует**. Гарантия — «at least once»: сообщение гарантированно дойдёт, но может дойти дважды. Почему:

- Consumer обработал сообщение, но упал **до** `ack` → RabbitMQ вернёт его другому consumer'у.
- Relay перезапустился между публикацией и пометкой `processed_at` → событие опубликовано дважды.

Значит, обработчик обязан быть **идемпотентным**: повторная обработка того же события не меняет результат. Два рабочих приёма:

1. **Дедупликация по messageId.** Relay кладёт id строки outbox в `messageId`. Consumer ведёт таблицу обработанных id и игнорирует повторы:

```sql
CREATE TABLE processed_messages (
  message_id   BIGINT PRIMARY KEY,     -- id строки outbox = messageId
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```ts
const inserted = await em.query(
  `INSERT INTO processed_messages (message_id)
   VALUES ($1) ON CONFLICT DO NOTHING`,
  [Number(msg.properties.messageId)],
);
if (inserted.rowCount === 0) {
  ch.ack(msg); // уже обрабатывали — просто подтверждаем
  return;
}
```

2. **Натуральная идемпотентность бизнес-операции.** Перед тем как отправить письмо, проверь статус уведомления: если `sent` — выходи. Многие операции можно сделать идемпотентными по смыслу (upsert вместо insert, «установить статус X» вместо «увеличить счётчик»), и это надёжнее таблицы дедупликации.

`ON CONFLICT DO NOTHING` возвращает `rowCount=0` при дубле — атомарная проверка «обрабатывал ли кто-то уже», без отдельного SELECT, который гоняется с параллельным INSERT.

## Упорядоченность и её ограничения

Хочется верить, что сообщения обрабатываются в порядке отправки. Иногда это правда, но с оговорками, которые надо знать наизусть:

- **Внутри одной очереди** порядок сохраняется, пока один consumer и нет ретраев: упавшее сообщение А уходит в retry на 30 секунд, Б обрабатывается раньше — порядок нарушен.
- **Между несколькими consumer'ами** порядка нет: два параллельных обработчика заканчивают в случайном порядке.
- **Между разными очередями** порядка нет по определению — это разные буферы.

Если порядок критичен (например, `order.paid` раньше `order.shipped`), паттерны такие: один consumer на очередь (жертвуем параллелизмом), шардирование по ключу сущности (все события заказа N — в одну очередь-шард), или application-level sequencing — в событии несёшь версию агрегата, а consumer игнорирует события с версией ниже уже применённой (optimistic concurrency из главы про PostgreSQL работает и здесь). Честный совет: если бизнес-требование звучит как «все события строго по порядку» — сначала попробуй перефразировать его как «конечное состояние корректно при любом порядке».

## RabbitMQ, Kafka, NATS, SQS: честное сравнение

Не превращая главу в обзор — критерии выбора, которыми пользуются на практике:

| Критерий | RabbitMQ | Kafka | NATS | SQS |
|---|---|---|---|---|
| Модель | Брокер очередей, маршрутизация | Распределённый лог | Лёгкий брокер, pub/sub | Управляемая очередь (AWS) |
| Доставка | At least once, ack/nack | At least once, offset'ы | At most once (core) / at least once (JetStream) | At least once |
| Хранение | В памяти/на диске, до consumer'а | Ретеншн по времени/размеру, replay всей истории | JetStream: ретеншн | До 14 дней |
| Порядок | В очереди (с оговорками) | Внутри партиции — строго | Ограниченно | Группами до 10 |
| Роутинг | Богатое (topic/direct/fanout) | Никакого, только топики | Subject-шаблоны | Никакого |
| Операции | Самостоятельный кластер | Тяжёлый кластер (KRaft) | Очень лёгкий | Нет (managed) |

Практические правила: **RabbitMQ** — задачи и команды, сложная маршрутизация, ретраи/DLX. **Kafka** — событийная шина и аналитика: высокие объёмы, replay истории, несколько независимых reader'ов одного потока, строгий порядок в партиции. **NATS** — простой pub/sub без гарантий или JetStream для персистентности; любят за минимальные эксплуатационные расходы. **SQS** — живёшь в AWS, хочешь нулевую эксплуатацию и готов мириться с рисками дублей и видимости таймаутов.

Ключевой водораздел: нужен ли **лог событий** (Kafka: события — источник истины, их перечитывают) или **очередь задач** (RabbitMQ: сообщение живёт, пока не обработано, и исчезает). Большинство бэкенд-приложений — второе.

## Типичные ошибки и грабли

- **Публикация в брокер вне транзакции с данными.** «INSERT + publish» — потеряшки при любом сбое между записями. Хорошо: outbox-таблица в той же транзакции + relay.
- **`nack(requeue=true)` на постоянную ошибку.** Битое сообщение крутится в цикле и блокирует очередь (head-of-line blocking). Плохо: requeue вслепую. Хорошо: счётчик попыток → retry с задержкой → DLQ после лимита.
- **Consumer без идемпотентности.** Падение после обработки, но до `ack` — и письмо улетает повторно, клиент получает дважды. Плохо: «у нас RabbitMQ, он exactly once». Хорошо: дедупликация по messageId или идемпотентная бизнес-операция.
- **Безлимитный prefetch.** Consumer выкачал всю очередь в память → OOM. Хорошо: `prefetch` под контролем, для тяжёлых задач — единицы.
- **Недюрабельные очереди и сообщения.** Все `durable/persistent` выключены «для скорости» → рестарт брокера стирает всё. В проде durable — дефолт, а non-durable — сознательное исключение.
- **Ожидание глобального порядка.** «События должны идти строго по порядку» на кластере из пяти consumer'ов — невыполнимо. Хорошо: версии агрегата / шардирование по ключу / проектирование под произвольный порядок.
- **Вечный outbox без очистки.** Таблица разрастается, индексы деградируют, relay тормозит. Хорошо: retention и регулярный `DELETE` обработанных строк.

## Вопросы на собеседование

1. **Что такое проблема двойной записи и как её решает outbox?** Две записи (БД + брокер) без общей транзакции: любой сбой между ними — потеря события или событие о несохранённых данных. Outbox пишет событие в таблицу в той же транзакции, что и данные; relay отдельно перекладывает его в брокер.
2. **Почему «exactly once» — миф?** Подтверждение (ack) и обработка — неатомарны: consumer может обработать и упасть до ack, тогда сообщение вернётся. Поэтому гарантия at least once, а корректность обеспечивает идемпотентный consumer.
3. **Exchange, queue, binding, routing key — что есть что?** Exchange — точка входа сообщений; queue — буфер для consumer'ов; binding — связь очереди с exchange по pattern; routing key — метка сообщения, по которой exchange раскидывает копии по очередям.
4. **Как устроен ретрай через TTL/DLX?** Очередь с `x-message-ttl` и `x-dead-letter-exchange`: nack'нутое сообщение ждёт TTL, затем dead-letter'ится обратно в основную очередь. Лимит попыток исчерпан — публикуем в DLQ.
5. **Как сделать consumer идемпотентным?** Дедупликация по messageId через таблицу `processed_messages` с `ON CONFLICT DO NOTHING` либо идемпотентная по смыслу операция (upsert, проверка статуса «уже отправлено»).
6. **RabbitMQ или Kafka — как выбрать?** Очередь задач и команд с маршрутизацией и ретраями — RabbitMQ. Лог событий с replay, высоким трафиком и несколькими независимыми reader'ами — Kafka. Вопрос «лог или очередь» решает выбор.
7. **Что такое head-of-line blocking в очереди?** Первое в очереди битое сообщение бесконечно ретраится и не даёт обрабатываться остальным. Лечится retry с задержкой (вынести битое из головы), DLQ и, в Kafka, отдельными партициями/топиками.
8. **Зачем `FOR UPDATE SKIP LOCKED` в relay?** Несколько реплик relay берут пачки outbox параллельно без блокировок: каждая сразу получает следующие необработанные строки, а не ждёт чужих транзакций.

## Практика

Мини-проект: **сервис уведомлений с outbox и DLQ**. Стек: docker-compose с PostgreSQL 16, RabbitMQ 3.13 (management-плагин), NestJS API и worker-процесс.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: notifications
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s

  rabbitmq:
    image: rabbitmq:3.13-management
    ports: ["5672:5672", "15672:15672"] # 15672 — веб-консоль
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 5s

  api:
    build: ./app
    command: npm run start:dev
    depends_on:
      postgres: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
    ports: ["3000:3000"]

  worker:
    build: ./app
    command: npm run worker   # тот же образ, другая точка входа
    depends_on:
      postgres: { condition: service_healthy }
      rabbitmq: { condition: service_healthy }
```

Задания (критерии результата в скобках):

1. Создай таблицы `outbox` и `notifications` миграцией; частичный индекс по необработанным строкам. (Миграция применяется чисто на пустой БД.)
2. Эндпоинт `POST /notifications` пишет уведомление и событие outbox **одной транзакцией** — продемонстрируй это, кинув исключение после `INSERT INTO outbox` в отладочном флаге: в БД не должно остаться ни уведомления, ни события.
3. Реализуй relay с `FOR UPDATE SKIP LOCKED` и публикацией по 100 событий; останови RabbitMQ, создай 200 уведомлений, подними брокер — все события должны доехать. (Проверка: счётчик `processed_at IS NULL` = 0.)
4. Worker-консьюмер с retry: `x-retry-count` в заголовках, до 5 попыток с задержкой 30 с через retry-очередь, затем DLQ. Сделай отправку заведомо падающей (невалидный SMTP-хост) и покажи сообщение в DLQ через консоль RabbitMQ на `:15672`.
5. Идемпотентность: эмулируй дубль — опубликуй то же событие дважды с одним `messageId`; письмо/запись в `processed_messages` должны появиться один раз.
6. Добавь алерт: метрика «число необработанных строк outbox» (простой SQL в cron или Prometheus exporter) с порогом «> 100 в течение 5 минут → сообщение в Telegram/лог». Проверь, остановив relay.

## Что почитать

- [RabbitMQ Tutorials](https://www.rabbitmq.com/tutorials) — официальный цикл от «hello world» до topics и RPC; лучший старт по exchange/binding.
- [Reliable Delivery в RabbitMQ](https://www.rabbitmq.com/docs/reliability) — publisher confirms, consumer acknowledgements и связка TTL/DLX из первоисточника.
- [microservices.io: Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html) — паттерн и его вариации от Криса Ричардсона.
- [Документация Kafka: дизайн](https://kafka.apache.org/documentation/#design) — почему лог, партиции и порядок; контраст с брокерами очередей.
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) — персистентный слой NATS: streams, consumers, ретеншн.
- [AWS SQS: ат-least-once доставка и видимость](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html) — стандартные очереди, дубли и таймауты видимости.
