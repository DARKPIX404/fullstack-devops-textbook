---
title: "Streams и backpressure"
description: "Readable, Writable, Transform, Duplex: режимы flowing и paused, pipe против pipeline, ручное управление backpressure через highWaterMark и drain. Практика: файловый копировщик, gzip-трансформ и CSV-парсер на стримах."
---

Любой сервис рано или поздно встречается с данными, которые не влезают в память целиком: выгрузка из базы на миллион строк, импорт CSV, проксирование файла, gzip-ответ на скачивание. Копировать такое через `readFile` + `writeFile` — значит держать весь буфер в памяти и вылететь по OOM на первом же файле больше свободного RAM. Стримы решают это: данные идут кусками (chunks), обрабатываются по мере поступления, а потребитель регулирует скорость производителя. Этот механизм регулировки называется **backpressure** — и он главный предмет этой главы.

Краткая версия показала `pipe` и упомянула `highWaterMark`. Здесь — полная картина: четыре класса стримов, два режима чтения, разница между `pipe` и `pipeline`, ручное управление backpressure и три рабочих примера, которые можно сразу взять в проект.

## Четыре класса

Всё построено на базовых классах модуля `node:stream`:

| Класс | Роль | Пример из ядра |
|---|---|---|
| `Readable` | Источник данных | `fs.createReadStream`, HTTP-запрос (входящий) |
| `Writable` | Приёмник данных | `fs.createWriteStream`, HTTP-ответ |
| `Transform` | Читает → преобразует → отдаёт | `zlib.createGzip`, `crypto.createCipheriv` |
| `Duplex` | Независимые каналы чтения и записи | TCP-сокет |

`Transform` — наследник и Readable, и Writable одновременно: пишешь в него чанками, читаешь трансформированные чанки. Именно поэтому цепочка «файл → gzip → файл» собирается в одну строку.

:::note[Объектный режим против байтового]
По умолчанию стримы работают с Buffer'ами и строками, а `highWaterMark` — в байтах (16 КБ для файлов). Если передать `objectMode: true`, стрим носит **объекты** (строки таблицы, JSON-документы), и `highWaterMark` считается в объектах (по умолчанию 16). Это фундаментально для парсеров и ETL: не парси CSV в гигантский массив, а крути объекты через стрим.
:::

## Режимы чтения: flowing и paused

`Readable` имеет два состояния:

- **Paused (по умолчанию).** Данные не текут, пока ты их не запросишь: через `read()`, `pipe()` или `for await`.
- **Flowing.** Данные текут сами, собираются через события `data`. Включается подпиской на `data` или вызовом `resume()`.

```js
import { createReadStream } from 'node:fs';

// Flowing: получаешь каждый чанк событием, сколько бы их ни было
createReadStream('big.iso')
  .on('data', (chunk) => console.log('получил', chunk.length, 'байт'))
  .on('end', () => console.log('конец'));

// Paused: ручное управление, удобно для протоколов с заголовками
const stream = createReadStream('file.bin');
stream.on('readable', () => {
  let chunk;
  while ((chunk = stream.read()) !== null) {
    // обработать chunk
  }
});
```

Главное отличие — контроль скорости. В flowing-режиме данные льются как придут, и если обработка внутри `data` медленная, чанки копятся в памяти (Node буферизует их внутри стрима). В paused-режиме ты сам решаешь, когда забрать следующий кусок. Про `for await` — ниже, он делает paused-режим удобным.

:::tip[for await — идиоматичный paused-режим]
`for await (const chunk of stream)` ведёт себя как paused: цикл забирает следующий чанк, только когда тело итерации завершилось. Асинхронная обработка внутри цикла автоматически тормозит чтение — backpressure из коробки. Это предпочтительный способ ручной работы со стримами в современном коде.
:::

## Backpressure: механика

У каждого `Writable` есть внутренний буфер и порог — `highWaterMark`. Правила простые:

1. `writable.write(chunk)` возвращает `boolean`: `true` — «могу принять ещё», `false` — «буфер заполнен до highWaterMark, замедляйся».
2. `false` — это не ошибка и не отказ: чанк принят в буфер. Но продолжать писать, игнорируя `false`, — значит неограниченно раздувать память.
3. Когда буфер дренируется (реальный I/O завершён), стрим испускает событие `drain`. Продолжать писать после `false` нужно только после `drain`.

```js
import { once } from 'node:events';

async function writeLots(writable, chunks) {
  for (const chunk of chunks) {
    const ok = writable.write(chunk);
    if (!ok) {
      // буфер полон — ждём, пока не уйдёт хотя бы highWaterMark данных
      await once(writable, 'drain');
    }
  }
  writable.end();
  await once(writable, 'finish');
}
```

`highWaterMark` задаётся при создании стрима. Для файлов умолчание 16 КБ — мелко для быстрых дисков; для прокси через сеть 16–64 КБ нормально. Не ставь «на всякий случай» 10 МБ: backpressure перестанет работать раньше, чем тебе нужно.

:::caution[write() после end() и двойной end()]
Вызов `write()` после `end()` бросает `ERR_STREAM_WRITE_AFTER_END`. Вызов `end()` дважды — `ERR_STREAM_ALREADY_FINISHED`. В сложных пайплайнах (ранний выход из цикла, ошибки) легко наступить на это — поэтому и нужен `pipeline`, который ведёт жизненный цикл за тебя.
:::

## pipe против pipeline

```js
// Вариант 1: ручная склейка
readStream.pipe(gzip).pipe(writeStream);
```

`pipe` возвращает **последний** стрим в цепочке, поэтому `a.pipe(b).pipe(c)` выглядит красиво. Проблема в обработке ошибок: событие `error` всплывает только на том стриме, где оно случилось. Если `readStream` упал, `writeStream` останется висеть открытым, сокеты не закроются — утечка дескрипторов.

```js
// Вариант 2: pipeline — ошибки и очистка из коробки
import { pipeline } from 'node:stream/promises';

await pipeline(readStream, gzip, writeStream);
// Ошибка в любом звене → все стримы уничтожены, промис отклонён.
// Успех → все корректно закрыты.
```

`pipeline` (в промисной версии из `node:stream/promises`) — единственный правильный способ собирать цепочки в новом коде. Он уничтожает стримы (`destroy()`), корректно обрабатывает `abort` через `AbortSignal`, и ошибка в одном звене приводит к чистой остановке всех.

Единственный кейс, где `pipe` ещё жив: мгновенная склейка двух стримов с последующей ручной обработкой ошибок на каждом. Но честно — таких кейсов почти не осталось.

## Пример 1: файловый копировщик с замером памяти

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function copyFile(src, dest) {
  await pipeline(
    createReadStream(src, { highWaterMark: 64 * 1024 }),
    createWriteStream(dest),
  );
  console.log('скопировано:', dest);
}

const src = process.argv[2];
const dest = process.argv[3];

// смотрим пик памяти процесса
copyFile(src, dest).then(() => {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`heapUsed после копирования: ${used.toFixed(1)} МБ`);
});
```

Сравни с `await writeFile(dest, await readFile(src))` на файле в 2 ГБ: второй вариант выделит 2 ГБ под входной буфер и ещё около 2 ГБ под выходной, а стримовый — держит в памяти два куска по 64 КБ. Это разница между «работает на VPS с 1 ГБ RAM» и OOM-киллером.

## Пример 2: gzip-трансформ на лету

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// сжимаем файл, не создавая промежуточных близнецов в памяти
await pipeline(
  createReadStream('access.log'),
  createGzip({ level: 6 }),
  createWriteStream('access.log.gz'),
);
```

`createGzip` — это `Transform`: читает несжатые чанки, отдаёт сжатые. Степень сжатия (`level: 1..9`) — классический размен скорость/размер. Для HTTP-ответов gzip-стрим ставится прямо в цепочку ответа — и заголовок `Content-Encoding: gzip` ставится до того, как известен итоговый размер, поэтому ответ идёт chunked.

## Пример 3: CSV-парсер в объектном режиме

Вот где стримы раскрываются полностью: читаем CSV любого размера, отдаём наружу объекты по одному.

```js
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// мини-парсер CSV: предполагаем простые строки без кавычек-переносов
function parseCsv() {
  let buffer = '';
  let headers = null;

  return new Transform({
    objectMode: true, // на выходе объекты, а не байты

    transform(chunk, _enc, callback) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // последняя строка может быть неполной — в буфер

      for (const line of lines) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        if (!headers) {
          headers = cells.map((h) => h.trim());
          continue;
        }
        const row = Object.fromEntries(headers.map((h, i) => [h, cells[i]?.trim()]));
        this.push(row); // отдаём объект дальше по цепочке
      }
      callback(); // этот чанк обработан, можно слать следующий
    },

    flush(callback) {
      if (buffer.trim()) {
        const cells = buffer.split(',');
        this.push(Object.fromEntries(headers.map((h, i) => [h, cells[i]?.trim()])));
      }
      callback(); // конец стрима
    },
  });
}

// использование: читаем построчно, обрабатываем с backpressure из коробки
await pipeline(
  createReadStream('users.csv', { encoding: 'utf8' }),
  parseCsv(),
  async function* (source) {
    for await (const row of source) {
      // тут может быть запись в БД — await реально тормозит чтение файла
      console.log('обрабатываю:', row.email);
      yield row;
    }
  },
);
```

Два ключевых момента. Во-первых, `objectMode: true` — стрим носит объекты, и `this.push(row)` не блокируется на заполнении байтового буфера. Во-вторых, финальное звено — асинхронный генератор: `for await` + `yield` превращает любую асинхронную обработку в Transform, и backpressure работает автоматически — файл читается ровно с той скоростью, с какой обработка успевает.

:::tip[CSV в проде]
Этот парсер — учебный (нет экранирования кавычками, нет BOM, нет многобайтовых разрывов UTF-8 между чанками). Для реальных файлов возьми `csv-parse` — она сама стримовая и корректно обрабатывает все граничные случаи. Но механика, которую ты здесь понял, позволит тебе писать собственные стримовые парсеры для бинарных форматов и логов.
:::

## Типичные ошибки и грабли

1. **Цепочка из `pipe` без обработки ошибок.** Ошибка в середине оставляет хвостовые стримы открытыми: файловые дескрипторы, сокеты, таймеры — утечка до перезапуска процесса. Лечение: `pipeline` всегда.
2. **Игнорирование возврата `write()`.** `writable.write(chunk)` в цикле без проверки `false` и `drain` — классическая утечка памяти: буфер растёт быстрее, чем успевает I/O. Симптом — растущий `heapUsed` и RSS без видимых причин.
3. **`data`-обработчик, который думает, что успевает.** В flowing-режиме события `data` идут так быстро, что тяжёлая обработка внутри обработчика копит чанки. Лечение: `for await` или paused-режим с явным `read()`.
4. **Событие `end` вместо `finish`.** `end` — у Readable («мне больше нечего читать»), `finish` — у Writable («я всё записал»). В коде копирования `writeStream.on('end')` никогда не сработает, и `await` завершения теряется.
5. **Смешение объектного и байтового режимов.** Подключить `objectMode: true` Transform после файлового Readable без перекодировки — и получишь `ERR_INVALID_ARG_TYPE` или молчаливую порчу данных. В `pipeline` между байтовым и объектным звеном всегда должно быть явное звено-конвертер.
6. **Потеря хвоста при ручном парсинге.** Строки, разорванные границей чанков, — баг №1 самописных парсеров. Правило: всегда оставляй «хвост» в буфере до следующего чанка и добирай его во `flush`.

## Вопросы на собеседовании

1. **Что такое backpressure и зачем он нужен?** Механизм, при котором медленный потребитель тормозит быстрого производителя. У Writable есть буфер и highWaterMark; `write()` возвращает `false` — производитель обязан дождаться `drain`. Без этого память растёт безгранично.
2. **Чем `pipeline` лучше цепочки `pipe`?** `pipeline` пробрасывает ошибку из любого звена, уничтожает все стримы (`destroy`), корректно закрывает цепочку и возвращает промис. `pipe` не передаёт ошибки по цепочке — хвостовые стримы висят.
3. **В чём разница flowing и paused режимов?** Flowing: данные текут событиями `data`, скорость не контролируется без дополнительного кода. Paused: данные забираются явно (`read()`, `for await`), потребитель сам регулирует темп. По умолчанию Readable — paused.
4. **Что такое `highWaterMark`?** Порог внутреннего буфера стрима. Для байтовых стримов — в байтах (16 КБ по умолчанию), для объектных — в объектах (16). Достижение порога переводит `write()` в возврат `false` и событие `readable` у Readable.
5. **Как правильно дождаться окончания записи в Writable?** `writable.end()` затем `await once(writable, 'finish')` — или `await pipeline(...)`, который делает это сам. Событие `finish` означает: все буферизованные данные реально ушли на диск/в сеть.
6. **Что такое объектный режим и где он нужен?** `objectMode: true` позволяет стриму носить произвольные JS-объекты вместо Buffer/строк. Нужен в ETL, парсерах CSV/JSON Lines, очередях обработки — везде, где единица данных — запись, а не байт.
7. **`for await` над Readable — flowing или paused?** Paused: следующий чанк запрашивается только после завершения тела итерации. Асинхронная работа внутри цикла автоматически создаёт backpressure на источник.

## Практика

1. **Прокси с замером.** HTTP-сервер, который по `GET /file/:name` стримит файл из директории в ответ, с HTTP-таймаутом и `pipeline`. Нагрузи его `autocannon` и смотри `process.memoryUsage()`: память должна оставаться плоской независимо от размера файла. Сравни с вариантом `readFile`.
2. **Генератор + gzip + счётчик.** Напиши `Readable`, который генерирует N случайных строк, склей через `pipeline` с `createGzip` и Writable, считающим байты на выходе. Убедись, что при `N = 10_000_000` память не растёт.
3. **JSON Lines парсер.** Расширь CSV-парсер до формата JSONL (каждая строка — JSON-объект). Обработай случай строки, разорванной между чанками, и невалидного JSON: невалидные строки должны уходить в отдельный error-стрим или счётчик, не роняя пайплайн.
4. **Backpressure вручную.** Напиши Writable, который «записывает» с задержкой 100 мс на чанк, и наполняй его из цикла с проверкой возврата `write()` и ожиданием `drain`. Замерь размер внутреннего буфера (`writable.writableLength`) и убедись, что он не превышает `highWaterMark + размер одного чанка`. Потом убери проверку и смотри, как буфер раздувается.
5. **Рефакторинг на `pipeline`.** Найди в своём pet-проекте место, где читается/пишется файл или проксируется ответ, и переведи его на `pipeline` с корректной обработкой ошибок. Добавь тест с обрывом соединения на середине передачи.

## Что почитать

- [Документация Node.js: Stream](https://nodejs.org/api/stream.html) — API всех четырёх классов и событий.
- [Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams) — официальный гайд по backpressure.
- [Stream Handbook (substack)](https://github.com/substack/stream-handbook) — классика, чуть устарела по API, но не по идеям.
- [Node.js Streams: everything you need to know](https://www.freecodecamp.org/news/node-js-streams-everything-you-need-to-know-c9141306be93/) — подробный обзор с диаграммами.
- [API Compatibility / DON'T USE pipe](https://nodejs.org/api/stream.html#stream_stream_pipeline_source_transforms_destination_callback) — официальная рекомендация по pipeline.
