import { useEffect, useState } from 'react';
import './EventLoopViz.css';

type Mode = 'browser' | 'node';
type Phase = 'sync' | 'timers' | 'pending' | 'poll' | 'check' | 'close';

interface VizState {
  note: string;
  codeLine?: number;
  stack: string[];
  micro: string[];
  macro: string[];
  nextTick?: string[];
  raf?: string[];
  consoleOut: string[];
  phase?: Phase;
  iteration?: number;
  render?: boolean;
  ioPending?: boolean;
}

interface Snippet {
  id: string;
  title: string;
  code: string[];
  trace: VizState[];
}

const BROWSER_SNIPPETS: Snippet[] = [
  {
    id: 'browser-classic',
    title: 'Классика: всё вместе',
    code: [
      "console.log('script start');",
      '',
      "setTimeout(() => console.log('timeout'), 0);",
      '',
      "Promise.resolve().then(() => console.log('promise.then'));",
      '',
      "requestAnimationFrame(() => console.log('rAF'));",
      '',
      "console.log('script end');",
    ],
    trace: [
      {
        note: 'Макрозадача <script> вошла в Call Stack — выполняется синхронно.',
        codeLine: 0,
        stack: ['<script>'],
        micro: [],
        macro: [],
        consoleOut: [],
      },
      {
        note: 'console.log выполняется прямо сейчас, пока стек занят.',
        codeLine: 0,
        stack: ['<script>'],
        micro: [],
        macro: [],
        consoleOut: ['script start'],
      },
      {
        note: 'setTimeout ставит колбэк в очередь макрозадач. Он ждёт своей итерации цикла.',
        codeLine: 2,
        stack: ['<script>'],
        micro: [],
        macro: ['setTimeout cb (0 мс)'],
        consoleOut: ['script start'],
      },
      {
        note: 'Реакция промиса — микрозадача. Пока стек не пуст, она ждёт в очереди.',
        codeLine: 4,
        stack: ['<script>'],
        micro: ['Promise.then'],
        macro: ['setTimeout cb (0 мс)'],
        consoleOut: ['script start'],
      },
      {
        note: 'requestAnimationFrame: колбэк ждёт ближайшего рендеринга (после микрозадач).',
        codeLine: 6,
        stack: ['<script>'],
        micro: ['Promise.then'],
        macro: ['setTimeout cb (0 мс)'],
        raf: ['rAF cb'],
        consoleOut: ['script start'],
      },
      {
        note: 'Стек пуст. Event Loop опустошает ВСЕ микрозадачи, потом отрисует кадр.',
        codeLine: 8,
        stack: [],
        micro: ['Promise.then'],
        macro: ['setTimeout cb (0 мс)'],
        raf: ['rAF cb'],
        consoleOut: ['script start', 'script end'],
      },
      {
        note: 'Микрозадача promise.then выполняется — до рендеринга и до таймера.',
        codeLine: 4,
        stack: ['Promise.then cb'],
        micro: [],
        macro: ['setTimeout cb (0 мс)'],
        raf: ['rAF cb'],
        consoleOut: ['script start', 'script end', 'promise.then'],
      },
      {
        note: 'Рендеринг: rAF-колбэк → layout → paint. Только теперь кадр.',
        codeLine: 6,
        stack: [],
        micro: [],
        macro: ['setTimeout cb (0 мс)'],
        raf: [],
        render: true,
        consoleOut: ['script start', 'script end', 'promise.then', 'rAF'],
      },
      {
        note: 'Следующая итерация: макрозадача-таймер. Выполнено.',
        codeLine: 2,
        stack: ['setTimeout cb'],
        micro: [],
        macro: [],
        consoleOut: ['script start', 'script end', 'promise.then', 'rAF', 'timeout'],
      },
    ],
  },
  {
    id: 'browser-micro-chain',
    title: 'await против таймера',
    code: [
      'async function demo() {',
      "  console.log('A');",
      '  await Promise.resolve();',
      "  console.log('B');",
      '}',
      '',
      'demo();',
      "console.log('C');",
      "setTimeout(() => console.log('D'), 0);",
    ],
    trace: [
      {
        note: 'Макрозадача <script> вошла в Call Stack.',
        codeLine: 6,
        stack: ['<script>'],
        micro: [],
        macro: [],
        consoleOut: [],
      },
      {
        note: 'Вызов async-функции — обычный синхронный вызов: demo ложится на стек.',
        codeLine: 6,
        stack: ['<script>', 'demo()'],
        micro: [],
        macro: [],
        consoleOut: [],
      },
      {
        note: 'Тело demo выполняется синхронно до первого await.',
        codeLine: 1,
        stack: ['<script>', 'demo()'],
        micro: [],
        macro: [],
        consoleOut: ['A'],
      },
      {
        note: 'await приостанавливает функцию: её продолжение уходит в микрозадачи.',
        codeLine: 2,
        stack: ['<script>'],
        micro: ['продолжение demo: log B'],
        macro: [],
        consoleOut: ['A'],
      },
      {
        note: 'Остаток скрипта выполняется синхронно.',
        codeLine: 7,
        stack: ['<script>'],
        micro: ['продолжение demo: log B'],
        macro: [],
        consoleOut: ['A', 'C'],
      },
      {
        note: 'setTimeout ставит макрозадачу — она встанет в очередь ПОСЛЕ микрозадач.',
        codeLine: 8,
        stack: ['<script>'],
        micro: ['продолжение demo: log B'],
        macro: ['setTimeout cb (D)'],
        consoleOut: ['A', 'C'],
      },
      {
        note: 'Стек пуст. Сначала дрени́руем микрозадачи.',
        codeLine: 8,
        stack: [],
        micro: ['продолжение demo: log B'],
        macro: ['setTimeout cb (D)'],
        consoleOut: ['A', 'C'],
      },
      {
        note: 'Микрозадача (продолжение после await) обгоняет таймер.',
        codeLine: 3,
        stack: ['продолжение demo'],
        micro: [],
        macro: ['setTimeout cb (D)'],
        consoleOut: ['A', 'C', 'B'],
      },
      {
        note: 'Теперь макрозадача-таймер. Выполнено: A → C → B → D.',
        codeLine: 8,
        stack: ['setTimeout cb'],
        micro: [],
        macro: [],
        consoleOut: ['A', 'C', 'B', 'D'],
      },
    ],
  },
  {
    id: 'browser-nested-promise',
    title: 'setTimeout с вложенным промисом',
    code: [
      'console.log(1);',
      'setTimeout(() => console.log(2));',
      'Promise.resolve().then(() => console.log(3));',
      'setTimeout(() => {',
      '  console.log(4);',
      '  Promise.resolve().then(() => console.log(5));',
      '});',
      'console.log(6);',
    ],
    trace: [
      {
        note: 'Макрозадача <script> вошла в Call Stack.',
        codeLine: 0,
        stack: ['<script>'],
        micro: [],
        macro: [],
        consoleOut: [],
      },
      {
        note: 'Синхронный вывод.',
        codeLine: 0,
        stack: ['<script>'],
        micro: [],
        macro: [],
        consoleOut: ['1'],
      },
      {
        note: 'Первый таймер — в очередь макрозадач.',
        codeLine: 1,
        stack: ['<script>'],
        micro: [],
        macro: ['таймер: 2'],
        consoleOut: ['1'],
      },
      {
        note: 'Промис — в микрозадачи.',
        codeLine: 2,
        stack: ['<script>'],
        micro: ['промис: 3'],
        macro: ['таймер: 2'],
        consoleOut: ['1'],
      },
      {
        note: 'Второй таймер встаёт в очередь макрозадач ПОСЛЕ первого (FIFO).',
        codeLine: 3,
        stack: ['<script>'],
        micro: ['промис: 3'],
        macro: ['таймер: 2', 'таймер: 4, 5'],
        consoleOut: ['1'],
      },
      {
        note: 'Синхронный вывод, скрипт закончился.',
        codeLine: 7,
        stack: ['<script>'],
        micro: ['промис: 3'],
        macro: ['таймер: 2', 'таймер: 4, 5'],
        consoleOut: ['1', '6'],
      },
      {
        note: 'Стек пуст — дрени́руем микрозадачи.',
        codeLine: 7,
        stack: [],
        micro: ['промис: 3'],
        macro: ['таймер: 2', 'таймер: 4, 5'],
        consoleOut: ['1', '6'],
      },
      {
        note: 'Микрозадача промиса выполняется до любой макрозадачи.',
        codeLine: 2,
        stack: ['Promise.then cb'],
        micro: [],
        macro: ['таймер: 2', 'таймер: 4, 5'],
        consoleOut: ['1', '6', '3'],
      },
      {
        note: 'Первая макрозадача-таймер (2).',
        codeLine: 1,
        stack: ['таймер cb'],
        micro: [],
        macro: ['таймер: 4, 5'],
        consoleOut: ['1', '6', '3', '2'],
      },
      {
        note: 'Вторая макрозадача-таймер (4). Внутри неё ставится новая микрозадача.',
        codeLine: 4,
        stack: ['таймер cb'],
        micro: ['промис: 5'],
        macro: [],
        consoleOut: ['1', '6', '3', '2', '4'],
      },
      {
        note: 'Микрозадача из таймера выполняется сразу после него — до следующей макрозадачи. Выполнено: 1 → 6 → 3 → 2 → 4 → 5.',
        codeLine: 5,
        stack: ['Promise.then cb'],
        micro: [],
        macro: [],
        consoleOut: ['1', '6', '3', '2', '4', '5'],
      },
    ],
  },
];

const NODE_SNIPPETS: Snippet[] = [
  {
    id: 'node-phases',
    title: 'Фазы: timers → poll → check',
    code: [
      "const fs = require('node:fs');",
      '',
      "console.log('start');",
      '',
      'setTimeout(() => {',
      "  console.log('timer 1');",
      "  process.nextTick(() => console.log('nextTick in timer'));",
      "  Promise.resolve().then(() => console.log('promise in timer'));",
      '}, 0);',
      '',
      "setImmediate(() => console.log('immediate'));",
      '',
      'fs.readFile(__filename, () => {',
      "  console.log('io callback');",
      "  setTimeout(() => console.log('timer inside io'), 0);",
      "  setImmediate(() => console.log('immediate inside io'));",
      '});',
      '',
      "Promise.resolve().then(() => console.log('promise 1'));",
      "process.nextTick(() => console.log('nextTick 1'));",
      '',
      "console.log('end');",
    ],
    trace: [
      {
        note: 'Главный модуль выполняется синхронно ДО входа в Event Loop.',
        codeLine: 2,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: [],
        nextTick: [],
        consoleOut: [],
      },
      {
        note: 'Синхронный вывод.',
        codeLine: 2,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: [],
        nextTick: [],
        consoleOut: ['start'],
      },
      {
        note: 'setTimeout попадёт в фазу timers.',
        codeLine: 4,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: ['[timers] timer 1'],
        nextTick: [],
        consoleOut: ['start'],
      },
      {
        note: 'setImmediate попадёт в фазу check — после poll.',
        codeLine: 10,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: [],
        consoleOut: ['start'],
      },
      {
        note: 'fs.readFile ушёл в thread pool libuv. Главный поток не ждёт — продолжает исполнение.',
        codeLine: 12,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start'],
      },
      {
        note: 'Реакция промиса — в очередь промисов.',
        codeLine: 18,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1'],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start'],
      },
      {
        note: 'process.nextTick — отдельная очередь с приоритетом над промисами.',
        codeLine: 19,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1'],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: ['nextTick 1'],
        ioPending: true,
        consoleOut: ['start'],
      },
      {
        note: 'Синхронный код закончился. Дрена́ж: сначала ВСЯ очередь nextTick, потом промисы.',
        codeLine: 21,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1'],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: ['nextTick 1'],
        ioPending: true,
        consoleOut: ['start', 'end'],
      },
      {
        note: 'nextTick 1 выполняется раньше любого промиса.',
        codeLine: 19,
        phase: 'sync',
        stack: [],
        micro: ['promise 1'],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start', 'end', 'nextTick 1'],
      },
      {
        note: 'Теперь очередь промисов.',
        codeLine: 18,
        phase: 'sync',
        stack: [],
        micro: [],
        macro: ['[timers] timer 1', '[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1'],
      },
      {
        note: 'Итерация 1, фаза timers: истёкший таймер. Внутри колбэка ставятся nextTick и промис.',
        codeLine: 5,
        phase: 'timers',
        iteration: 1,
        stack: ['timer 1 cb'],
        micro: ['promise in timer'],
        macro: ['[check] immediate'],
        nextTick: ['nextTick in timer'],
        ioPending: true,
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1'],
      },
      {
        note: 'После КАЖДОГО колбэка цикл дрени́рует nextTick.',
        codeLine: 6,
        phase: 'timers',
        iteration: 1,
        stack: [],
        micro: ['promise in timer'],
        macro: ['[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer'],
      },
      {
        note: 'Затем промисы.',
        codeLine: 7,
        phase: 'timers',
        iteration: 1,
        stack: [],
        micro: [],
        macro: ['[check] immediate'],
        nextTick: [],
        ioPending: true,
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer', 'promise in timer'],
      },
      {
        note: 'Фаза poll: колбэк файлового I/O. setImmediate внутри попадёт в check ЭТОГО прохода, а таймер — в следующую итерацию.',
        codeLine: 13,
        phase: 'poll',
        iteration: 1,
        stack: ['readFile cb'],
        micro: [],
        macro: ['[timers] timer inside io', '[check] immediate inside io'],
        nextTick: [],
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer', 'promise in timer', 'io callback'],
      },
      {
        note: 'Фаза check текущего прохода: immediate, поставленный внутри I/O-колбэка.',
        codeLine: 15,
        phase: 'check',
        iteration: 1,
        stack: ['immediate cb'],
        micro: [],
        macro: ['[timers] timer inside io'],
        nextTick: [],
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer', 'promise in timer', 'io callback', 'immediate inside io'],
      },
      {
        note: 'check дрени́рует свою очередь до конца: immediate из главного модуля.',
        codeLine: 10,
        phase: 'check',
        iteration: 1,
        stack: ['immediate cb'],
        micro: [],
        macro: ['[timers] timer inside io'],
        nextTick: [],
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer', 'promise in timer', 'io callback', 'immediate inside io', 'immediate'],
      },
      {
        note: 'Итерация 2, фаза timers: таймер, поставленный внутри I/O-колбэка. Выполнено.',
        codeLine: 14,
        phase: 'timers',
        iteration: 2,
        stack: ['timer cb'],
        micro: [],
        macro: [],
        nextTick: [],
        consoleOut: ['start', 'end', 'nextTick 1', 'promise 1', 'timer 1', 'nextTick in timer', 'promise in timer', 'io callback', 'immediate inside io', 'immediate', 'timer inside io'],
      },
    ],
  },
  {
    id: 'node-nexttick-vs-promise',
    title: 'nextTick против промисов',
    code: [
      "Promise.resolve().then(() => console.log('promise 1'));",
      'process.nextTick(() => {',
      "  console.log('nextTick 1');",
      "  process.nextTick(() => console.log('nextTick 2'));",
      '});',
      "Promise.resolve().then(() => console.log('promise 2'));",
    ],
    trace: [
      {
        note: 'Главный модуль выполняется синхронно.',
        codeLine: 0,
        phase: 'sync',
        stack: ['<main>'],
        micro: [],
        macro: [],
        nextTick: [],
        consoleOut: [],
      },
      {
        note: 'Первая реакция промиса — в очередь промисов.',
        codeLine: 0,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1'],
        macro: [],
        nextTick: [],
        consoleOut: [],
      },
      {
        note: 'nextTick — в свою отдельную очередь.',
        codeLine: 1,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1'],
        macro: [],
        nextTick: ['nextTick 1'],
        consoleOut: [],
      },
      {
        note: 'Второй промис встаёт в очередь промисов ПОСЛЕ первого.',
        codeLine: 5,
        phase: 'sync',
        stack: ['<main>'],
        micro: ['promise 1', 'promise 2'],
        macro: [],
        nextTick: ['nextTick 1'],
        consoleOut: [],
      },
      {
        note: 'Стек пуст. Дрена́ж микроочередей перед входом в цикл.',
        codeLine: 5,
        phase: 'sync',
        stack: [],
        micro: ['promise 1', 'promise 2'],
        macro: [],
        nextTick: ['nextTick 1'],
        consoleOut: [],
      },
      {
        note: 'Сначала — очередь nextTick: nextTick 1 выполняется до любого промиса.',
        codeLine: 2,
        phase: 'sync',
        stack: ['nextTick 1 cb'],
        micro: ['promise 1', 'promise 2'],
        macro: [],
        nextTick: [],
        consoleOut: ['nextTick 1'],
      },
      {
        note: 'nextTick внутри nextTick ставится в ту же очередь — она дрени́руется до конца.',
        codeLine: 3,
        phase: 'sync',
        stack: [],
        micro: ['promise 1', 'promise 2'],
        macro: [],
        nextTick: ['nextTick 2'],
        consoleOut: ['nextTick 1'],
      },
      {
        note: 'nextTick 2 выполняется в той же дрена́же. Промисы всё ещё ждут.',
        codeLine: 3,
        phase: 'sync',
        stack: ['nextTick 2 cb'],
        micro: ['promise 1', 'promise 2'],
        macro: [],
        nextTick: [],
        consoleOut: ['nextTick 1', 'nextTick 2'],
      },
      {
        note: 'Теперь — очередь промисов.',
        codeLine: 0,
        phase: 'sync',
        stack: ['Promise.then cb'],
        micro: ['promise 2'],
        macro: [],
        nextTick: [],
        consoleOut: ['nextTick 1', 'nextTick 2', 'promise 1'],
      },
      {
        note: 'Выполнено: nextTick 1 → nextTick 2 → promise 1 → promise 2. Отдельная очередь nextTick всегда раньше промисов.',
        codeLine: 5,
        phase: 'sync',
        stack: ['Promise.then cb'],
        micro: [],
        macro: [],
        nextTick: [],
        consoleOut: ['nextTick 1', 'nextTick 2', 'promise 1', 'promise 2'],
      },
    ],
  },
];

const NODE_PHASES: Array<{ id: Phase; label: string }> = [
  { id: 'timers', label: 'timers' },
  { id: 'pending', label: 'pending' },
  { id: 'poll', label: 'poll' },
  { id: 'check', label: 'check' },
  { id: 'close', label: 'close' },
];

const RENDER_STAGES = ['rAF', 'layout', 'paint', 'composite'];

export default function EventLoopViz({ mode }: { mode: Mode }) {
  const snippets = mode === 'browser' ? BROWSER_SNIPPETS : NODE_SNIPPETS;
  const [snippetIdx, setSnippetIdx] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(800);
  const [predict, setPredict] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const snippet = snippets[snippetIdx];
  const step = snippet.trace[stepIdx];
  const lastStep = snippet.trace.length - 1;
  const isNode = mode === 'node';

  useEffect(() => {
    setStepIdx(0);
    setPlaying(false);
    setRevealed(false);
  }, [snippetIdx]);

  useEffect(() => {
    if (!playing) return;
    if (stepIdx >= lastStep) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      setStepIdx((i) => Math.min(i + 1, lastStep));
    }, speed);
    return () => clearTimeout(timer);
  }, [playing, stepIdx, speed, lastStep]);

  const reset = () => {
    setStepIdx(0);
    setPlaying(false);
    setRevealed(false);
  };

  const reveal = () => {
    setRevealed(true);
    setStepIdx(0);
    setPlaying(true);
  };

  const consoleHidden = predict && !revealed;

  return (
    <div className="elv">
      <div className="elv__header">
        <span className="elv__badge">
          {isNode ? 'Node.js: фазы libuv' : 'Браузер: task + microtask queue'}
        </span>
        <div className="elv__tabs" role="tablist" aria-label="Выбор сниппета">
          {snippets.map((s, i) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={i === snippetIdx}
              className={`elv__tab${i === snippetIdx ? ' elv__tab--active' : ''}`}
              onClick={() => setSnippetIdx(i)}
            >
              {s.title}
            </button>
          ))}
        </div>
      </div>

      <div className="elv__body">
        <pre className="elv__code" aria-label="Код сниппета">
          {snippet.code.map((line, i) => (
            <div
              key={i}
              className={`elv__code-line${step.codeLine === i ? ' elv__code-line--active' : ''}`}
            >
              <span className="elv__code-num">{i + 1}</span>
              <span>{line || ' '}</span>
            </div>
          ))}
        </pre>

        <div className="elv__board">
          {isNode && step.phase && step.phase !== 'sync' && (
            <div className="elv__phases" aria-label="Таймлайн фаз Event Loop">
              <span className="elv__phase-chip elv__phase-chip--iter">
                итерация {step.iteration ?? 1}
              </span>
              {NODE_PHASES.map((p) => (
                <span
                  key={p.id}
                  className={`elv__phase-chip${step.phase === p.id ? ' elv__phase-chip--active' : ''}`}
                >
                  {p.label}
                </span>
              ))}
            </div>
          )}
          {isNode && step.phase === 'sync' && (
            <div className="elv__phases" aria-label="Текущая фаза">
              <span className="elv__phase-chip elv__phase-chip--sync">главный модуль (до цикла)</span>
            </div>
          )}

          {!isNode && (
            <div
              className={`elv__render${step.render ? ' elv__render--active' : ''}`}
              aria-label="Этап рендеринга"
            >
              {step.raf && step.raf.length > 0 && (
                <span className="elv__raf-queue">rAF-очередь: {step.raf.length}</span>
              )}
              {RENDER_STAGES.map((s) => (
                <span key={s} className="elv__render-stage">
                  {s}
                </span>
              ))}
              <span className="elv__render-hint">
                {step.render
                  ? 'кадр отрисовывается'
                  : 'рендеринг между итерациями: после микрозадач'}
              </span>
            </div>
          )}

          <div className={`elv__columns${isNode ? ' elv__columns--node' : ''}`}>
            <div className="elv__col" aria-label="Call Stack">
              <div className="elv__col-title">Call Stack</div>
              <div className="elv__col-body">
                {step.stack.length === 0 && <div className="elv__empty">пусто</div>}
                {step.stack.map((f, i) => (
                  <div
                    key={`${i}-${f}`}
                    className={`elv__frame${i === step.stack.length - 1 ? ' elv__frame--top' : ''}`}
                  >
                    {f}
                  </div>
                ))}
              </div>
            </div>

            {isNode ? (
              <>
                <div className="elv__col" aria-label="Очередь process.nextTick">
                  <div className="elv__col-title">nextTick</div>
                  <div className="elv__col-body">
                    {(!step.nextTick || step.nextTick.length === 0) && (
                      <div className="elv__empty">пусто</div>
                    )}
                    {step.nextTick?.map((t, i) => (
                      <div key={`${i}-${t}`} className="elv__task elv__task--nexttick">
                        {t}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="elv__col" aria-label="Очередь промисов">
                  <div className="elv__col-title">Промисы</div>
                  <div className="elv__col-body">
                    {step.micro.length === 0 && <div className="elv__empty">пусто</div>}
                    {step.micro.map((t, i) => (
                      <div key={`${i}-${t}`} className="elv__task elv__task--micro">
                        {t}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="elv__col" aria-label="Очередь микрозадач">
                <div className="elv__col-title">Микрозадачи</div>
                <div className="elv__col-body">
                  {step.micro.length === 0 && <div className="elv__empty">пусто</div>}
                  {step.micro.map((t, i) => (
                    <div key={`${i}-${t}`} className="elv__task elv__task--micro">
                      {t}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="elv__col" aria-label="Очередь макрозадач">
              <div className="elv__col-title">
                {isNode ? 'Очереди фаз' : 'Макрозадачи'}
              </div>
              <div className="elv__col-body">
                {step.macro.length === 0 && !step.ioPending && (
                  <div className="elv__empty">пусто</div>
                )}
                {isNode && step.ioPending && (
                  <div className="elv__task elv__task--io">I/O в thread pool: readFile</div>
                )}
                {step.macro.map((t, i) => (
                  <div key={`${i}-${t}`} className="elv__task elv__task--macro">
                    {t}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <p className="elv__note" aria-live="polite">
            {step.note}
          </p>

          <div className="elv__console" aria-label="Консоль">
            <div className="elv__console-title">Console</div>
            {consoleHidden ? (
              <div className="elv__console-cover">
                <p>Консоль скрыта. Пройди шаги и мысленно предскажи порядок вывода.</p>
                <button type="button" className="elv__btn elv__btn--accent" onClick={reveal}>
                  Показать ответ
                </button>
              </div>
            ) : (
              <div className="elv__console-body">
                {step.consoleOut.length === 0 && (
                  <span className="elv__empty">вывод появится по мере выполнения</span>
                )}
                {step.consoleOut.map((l, i) => (
                  <div key={`${i}-${l}`} className="elv__console-line">
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="elv__controls">
        <button
          type="button"
          className="elv__btn"
          onClick={reset}
          aria-label="Сначала: сбросить выполнение"
        >
          Сначала
        </button>
        <button
          type="button"
          className="elv__btn"
          onClick={() => {
            setPlaying(false);
            setStepIdx((i) => Math.max(0, i - 1));
          }}
          disabled={stepIdx === 0}
          aria-label="Шаг назад"
        >
          Шаг назад
        </button>
        <button
          type="button"
          className="elv__btn elv__btn--accent"
          onClick={() => {
            if (stepIdx >= lastStep) {
              setStepIdx(0);
              setPlaying(true);
            } else {
              setPlaying((p) => !p);
            }
          }}
          aria-label={playing ? 'Пауза' : 'Запуск: проиграть до конца'}
        >
          {playing ? 'Пауза' : 'Запуск'}
        </button>
        <button
          type="button"
          className="elv__btn"
          onClick={() => {
            setPlaying(false);
            setStepIdx((i) => Math.min(lastStep, i + 1));
          }}
          disabled={stepIdx >= lastStep}
          aria-label="Шаг вперёд"
        >
          Шаг вперёд
        </button>
        <label className="elv__speed">
          Скорость
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Скорость проигрывания"
          >
            <option value={1200}>медленно</option>
            <option value={800}>нормально</option>
            <option value={350}>быстро</option>
          </select>
        </label>
        <button
          type="button"
          className={`elv__btn${predict ? ' elv__btn--active' : ''}`}
          onClick={() => {
            setPredict((p) => !p);
            setRevealed(false);
            setPlaying(false);
          }}
          aria-pressed={predict}
          aria-label="Режим предсказания: скрыть консоль до ответа"
        >
          Сначала предскажи
        </button>
        <span className="elv__progress" aria-label="Прогресс">
          Шаг {stepIdx} / {lastStep}
        </span>
      </div>
    </div>
  );
}
