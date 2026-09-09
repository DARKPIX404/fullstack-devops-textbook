import { useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * GitGraph — интерактивный граф веток: коммиты, указатели веток и HEAD,
 * merge (ff и merge-коммит с двумя родителями), rebase (пересоздание
 * коммитов с новыми хэшами), reset --hard. Режим «предскажи результат»
 * задаёт вопрос до выполнения merge/rebase.
 *
 * Модель: коммиты — это неизменяемые узлы с родителями; ветки и HEAD —
 * подвижные указатели. Достижимость из веток определяет «видимость» узла.
 */

type GCommit = { id: string; msg: string; parents: string[]; col: 0 | 1; row: number; branch: string };

type Quiz =
  | { op: 'merge'; answered: boolean; correct: boolean }
  | { op: 'rebase'; answered: boolean; correct: boolean }
  | null;

const C = {
  bg: 'var(--sl-color-bg)',
  bgAccent: 'var(--sl-color-bg-accent)',
  accent: 'var(--sl-color-accent)',
  text: 'var(--sl-color-text)',
  textAccent: 'var(--sl-color-text-accent)',
  border: 'var(--sl-color-border)',
  feature: '#22a7d8',
  warn: '#e8a13a',
  mono: "ui-monospace, 'JetBrains Mono', 'Fira Code', monospace",
};

const COL_X = [90, 250];
const ROW_H = 64;
const TOP = 50;

const MERGE_MSG = "Merge branch 'feature'";
const COMMIT_MSGS = ['feat: форма входа', 'feat: валидация', 'fix: опечатка', 'feat: новый экран', 'docs: README'];

export default function GitGraph() {
  const [commits, setCommits] = useState<GCommit[]>([
    { id: 'c1', msg: 'init', parents: [], col: 0, row: 0, branch: 'main' },
  ]);
  const [branches, setBranches] = useState<Record<string, string>>({ main: 'c1', feature: 'c1' });
  const [head, setHead] = useState<'main' | 'feature'>('main');
  const [counter, setCounter] = useState(2);
  const [note, setNote] = useState<string | null>(null);
  const [predictMode, setPredictMode] = useState(false);
  const [quiz, setQuiz] = useState<Quiz>(null);
  const [showRefs, setShowRefs] = useState(false);

  const byId = new Map(commits.map((c) => [c.id, c]));

  // Достижимость из любой ветки: недостижимые узлы — «сироты» (reflog держит их ~90 дней)
  const reachable = new Set<string>();
  const stack = Object.values(branches);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const c = byId.get(id);
    if (c) stack.push(...c.parents);
  }

  const isAncestor = (anc: string, desc: string): boolean => {
    const seen = new Set<string>();
    const st = [desc];
    while (st.length) {
      const id = st.pop()!;
      if (id === anc) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = byId.get(id);
      if (c) st.push(...c.parents);
    }
    return false;
  };

  const nextRow = () => Math.max(...commits.map((c) => c.row)) + 1;

  const doCommit = () => {
    const msg = COMMIT_MSGS[(counter - 2) % COMMIT_MSGS.length];
    const id = `c${counter}`;
    const cur = branches[head];
    const curCommit = byId.get(cur)!;
    setCommits((prev) => [
      ...prev,
      { id, msg, parents: [cur], col: curCommit.col, row: nextRow(), branch: head },
    ]);
    setBranches((prev) => ({ ...prev, [head]: id }));
    setCounter((n) => n + 1);
    setNote(`git commit: создан ${id}, указатель ${head} передвинут. HEAD смотрит на ${head} — поэтому двигается ветка.`);
    setQuiz(null);
  };

  const switchTo = (b: 'main' | 'feature') => {
    setHead(b);
    setNote(`git switch ${b}: HEAD теперь указывает на refs/heads/${b}. Коммиты и ветки не тронуты — сдвинулся только указатель.`);
  };

  const canMerge = head === 'main';
  const ffPossible = canMerge && isAncestor(branches.main, branches.feature);

  const doMerge = () => {
    if (!canMerge) return;
    setQuiz(null);
    if (ffPossible) {
      setBranches((prev) => ({ ...prev, main: branches.feature }));
      setNote(
        `fast-forward: новых коммитов нет — указатель main просто передвинулся к ${branches.feature}. История осталась линейной, хэши не изменились.`
      );
      return;
    }
    const id = `m${counter}`;
    setCommits((prev) => [
      ...prev,
      { id, msg: MERGE_MSG, parents: [branches.main, branches.feature], col: 0, row: nextRow(), branch: 'main' },
    ]);
    setBranches((prev) => ({ ...prev, main: id }));
    setCounter((n) => n + 1);
    setNote(
      `merge commit ${id}: у него ДВА родителя — ${branches.main} (наша линия) и ${branches.feature} (вливаемая). Новый объект, новый хэш.`
    );
  };

  const doRebase = () => {
    if (head !== 'feature') return;
    setQuiz(null);
    // коммиты feature, достижимые из feature, но не из main, от старого к новому
    const ordered = commits
      .filter((c) => c.branch === 'feature' && isAncestor(c.id, branches.feature) && !isAncestor(c.id, branches.main))
      .sort((a, b) => a.row - b.row);
    if (ordered.length === 0) {
      setNote('rebase: нечего пересаживать — feature уже содержит все коммиты main (или не ушла от него).');
      return;
    }
    let base = branches.main;
    const created: GCommit[] = [];
    let row = nextRow();
    let localCounter = counter;
    for (const c of ordered) {
      const id = `${c.id}'`;
      created.push({ id, msg: c.msg, parents: [base], col: 1, row: row++, branch: 'feature' });
      base = id;
      localCounter++;
    }
    setCommits((prev) => [...prev, ...created]);
    setBranches((prev) => ({ ...prev, feature: base }));
    setCounter(localCounter);
    const orphans = ordered.map((c) => c.id).join(', ');
    setNote(
      `rebase: коммиты ${orphans} пересозданы как ${created.map((c) => c.id).join(', ')} поверх main. ХЭШИ ИЗМЕНИЛИСЬ: хэш коммита включает хэш родителя. Старые объекты (${orphans}) живут в reflog, пока не прогонишь gc.`
    );
  };

  const doReset = () => {
    const tip = byId.get(branches[head]);
    if (!tip || tip.parents.length === 0) return;
    const ok = window.confirm(
      `git reset --hard ${tip.parents[0]} откатит ветку ${head} и «выбросит» коммит ${tip.id} из истории (объект останется в reflog). Продолжить?`
    );
    if (!ok) return;
    setBranches((prev) => ({ ...prev, [head]: tip.parents[0] }));
    setNote(
      `reset --hard: ${head} теперь указывает на ${tip.parents[0]}. Коммит ${tip.id} не удалён — он безымянный, но достижим через reflog. Спасение: git reflog → git switch -c rescue ${tip.id}`
    );
  };

  const askMerge = () => {
    if (predictMode) setQuiz({ op: 'merge', answered: false, correct: false });
    else doMerge();
  };
  const askRebase = () => {
    if (predictMode) setQuiz({ op: 'rebase', answered: false, correct: false });
    else doRebase();
  };

  const answerQuiz = (correct: boolean) => {
    setQuiz((q) => (q ? { ...q, answered: true, correct } : q));
  };

  const maxRow = Math.max(...commits.map((c) => c.row));
  const svgH = TOP + maxRow * ROW_H + 60;

  const nodePos = (c: GCommit) => ({ x: COL_X[c.col], y: TOP + c.row * ROW_H });

  return (
    <div
      style={{
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        padding: '1.1rem 1.2rem',
        margin: '1.5rem 0',
        background: C.bg,
        color: C.text,
        fontSize: '0.95rem',
        maxHeight: 620,
        overflowY: 'auto',
      }}
    >
      <p style={{ margin: '0 0 0.6rem', fontWeight: 700, color: C.textAccent }}>
        Интерактив: ветки, merge и rebase на графе
      </p>
      <p style={{ margin: '0 0 0.8rem', fontSize: '0.85rem' }}>
        Кружки — неизменяемые коммиты, ярлыки — подвижные указатели. Серые кружки: коммит недостижим ни из одной ветки
        (живёт в reflog, пока не прогонишь gc).
      </p>

      {/* Панель команд */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        <button
          type="button"
          aria-label="git commit в текущей ветке"
          onClick={doCommit}
          style={btnStyle(false)}
        >
          git commit (в {head})
        </button>
        <button type="button" aria-label="git switch main" onClick={() => switchTo('main')} disabled={head === 'main'} style={btnStyle(head === 'main', true)}>
          switch main
        </button>
        <button type="button" aria-label="git switch feature" onClick={() => switchTo('feature')} disabled={head === 'feature'} style={btnStyle(head === 'feature', true)}>
          switch feature
        </button>
        <button
          type="button"
          aria-label="git merge feature"
          onClick={askMerge}
          disabled={!canMerge}
          title={canMerge ? '' : 'merge выполняется из той ветки, в которую вливаешь (HEAD сейчас на ' + head + ')'}
          style={btnStyle(!canMerge)}
        >
          merge feature
        </button>
        <button
          type="button"
          aria-label="git rebase feature на main"
          onClick={askRebase}
          disabled={head !== 'feature'}
          title={head === 'feature' ? '' : 'rebase делается стоя на пересаживаемой ветке'}
          style={btnStyle(head !== 'feature')}
        >
          rebase feature на main
        </button>
        <button type="button" aria-label="git reset --hard HEAD~1" onClick={doReset} style={btnStyle(false, true)}>
          reset --hard HEAD~1
        </button>
      </div>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer', marginBottom: '0.7rem' }}>
        <input type="checkbox" checked={predictMode} onChange={(e) => setPredictMode(e.target.checked)} aria-label="Режим предсказания результата" />
        режим «предскажи результат» (вопрос перед merge/rebase)
      </label>

      {/* Викторина */}
      {quiz && !quiz.answered && (
        <div style={{ ...panel(), marginBottom: '0.7rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 700, fontSize: '0.85rem' }}>
            {quiz.op === 'merge'
              ? ffPossible
                ? 'Вопрос: main — предок feature. Что сделает git merge feature?'
                : 'Вопрос: ветки разошлись. Сколько родителей будет у нового коммита?'
              : 'Вопрос: что произойдёт с хэшами коммитов ветки feature при rebase на main?'}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {quiz.op === 'merge' ? (
              ffPossible ? (
                <>
                  <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(true)}>fast-forward: новых коммитов не будет</button>
                  <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(false)}>появится merge-коммит с двумя родителями</button>
                </>
              ) : (
                <>
                  <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(false)}>один родитель</button>
                  <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(true)}>два родителя</button>
                  <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(false)}>не создастся новый коммит</button>
                </>
              )
            ) : (
              <>
                <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(true)}>изменятся: rebase переписывает историю</button>
                <button type="button" style={btnStyle(false, true)} onClick={() => answerQuiz(false)}>не изменятся: patch тот же</button>
              </>
            )}
          </div>
        </div>
      )}
      {quiz && quiz.answered && (
        <div style={{ ...panel(), marginBottom: '0.7rem', borderLeft: `3px solid ${quiz.correct ? C.accent : C.warn}` }}>
          <p style={{ margin: 0, fontSize: '0.85rem' }}>
            {quiz.correct ? 'Верно. ' : 'Не совсем. '}
            {quiz.op === 'merge'
              ? ffPossible
                ? 'main просто передвинется к feature — это fast-forward, новых объектов нет.'
                : 'Ветки разошлись, Git построит merge-коммит с двумя родителями, сравнив общего предка и обе головы.'
              : 'Хэш коммита включает хэш родителя: новая база — новые хэши. Содержимое (patch) то же, идентичность другая.'}
          </p>
          <button
            type="button"
            style={{ ...btnStyle(false), marginTop: 8 }}
            onClick={quiz.op === 'merge' ? doMerge : doRebase}
            aria-label="Выполнить команду"
          >
            Выполнить команду и посмотреть
          </button>
        </div>
      )}

      {/* Граф */}
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 400 ${svgH}`} role="img" aria-label="Граф коммитов с указателями веток и HEAD" style={{ width: '100%', maxWidth: 420, display: 'block', margin: '0 auto' }}>
          <defs>
            <marker id="gg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={C.textAccent} />
            </marker>
          </defs>

          {/* рёбра parent */}
          {commits.flatMap((c) => {
            const p1 = nodePos(c);
            const orphan = !reachable.has(c.id);
            return c.parents.map((pid) => {
              const pc = byId.get(pid);
              if (!pc) return null;
              const p2 = nodePos(pc);
              const mx = (p1.x + p2.x) / 2;
              return (
                <path
                  key={`${c.id}-${pid}`}
                  d={`M ${p1.x} ${p1.y - 14} C ${mx} ${p1.y - 40}, ${mx} ${p2.y + 40}, ${p2.x} ${p2.y + 14}`}
                  fill="none"
                  stroke={orphan ? C.border : c.branch === 'feature' ? C.feature : C.accent}
                  strokeWidth={orphan ? 1 : 1.6}
                  strokeDasharray={orphan ? '4 4' : undefined}
                  opacity={orphan ? 0.5 : 0.8}
                  markerEnd="url(#gg-arrow)"
                  style={{ transition: 'all 0.5s ease' }}
                />
              );
            });
          })}

          {/* узлы-коммиты */}
          {commits.map((c) => {
            const p = nodePos(c);
            const orphan = !reachable.has(c.id);
            return (
              <g key={c.id} style={{ transition: 'transform 0.6s ease', transform: `translate(${p.x}px, ${p.y}px)` }}>
                <circle r={14} fill={C.bgAccent} stroke={orphan ? C.border : c.branch === 'feature' ? C.feature : C.accent} strokeWidth={2} opacity={orphan ? 0.45 : 1} />
                <text textAnchor="middle" dy={3.5} fontSize={9.5} fontFamily={C.mono} fill={orphan ? C.textAccent : C.text} opacity={orphan ? 0.7 : 1}>
                  {c.id}
                </text>
                <text textAnchor="middle" dy={28} fontSize={9} fontFamily={C.mono} fill={C.textAccent} opacity={orphan ? 0.6 : 1}>
                  {c.msg.length > 20 ? c.msg.slice(0, 20) + '…' : c.msg}
                </text>
              </g>
            );
          })}

          {/* ярлыки веток и HEAD */}
          {(['main', 'feature'] as const).map((b) => {
            const tip = byId.get(branches[b]);
            if (!tip) return null;
            const p = nodePos(tip);
            const isHead = head === b;
            return (
              <g key={b} style={{ transition: 'transform 0.6s ease', transform: `translate(${p.x + 30}px, ${p.y - 26}px)` }}>
                <rect x={0} y={-11} width={b.length * 7 + 34} height={20} rx={10} fill={isHead ? C.accent : C.bgAccent} stroke={b === 'feature' ? C.feature : C.accent} strokeWidth={1.4} />
                <text x={7} y={3} fontSize={10} fontFamily={C.mono} fill={isHead ? 'var(--sl-color-black)' : C.text}>
                  {b}
                </text>
                {isHead && (
                  <text x={b.length * 7 + 9} y={3} fontSize={9} fontWeight={700} fontFamily={C.mono} fill="var(--sl-color-black)">
                    ◀ HEAD
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Пояснение последней операции */}
      {note && (
        <div style={{ ...panel(), marginTop: '0.6rem', borderLeft: `3px solid ${C.accent}`, fontSize: '0.85rem', lineHeight: 1.6 }}>
          {note}
        </div>
      )}

      {/* Что видит Git */}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer', marginTop: '0.8rem' }}>
        <input type="checkbox" checked={showRefs} onChange={(e) => setShowRefs(e.target.checked)} aria-label="Показать, что видит Git: ветки как файлы с хэшем" />
        показать, что видит Git
      </label>
      {showRefs && (
        <div style={{ ...panel(), marginTop: '0.5rem', fontFamily: C.mono, fontSize: '0.8rem', lineHeight: 1.9 }}>
          <div style={{ color: C.textAccent }}># ветка — это файл со строкой хэша:</div>
          {(['main', 'feature'] as const).map((b) => (
            <div key={b}>
              $ cat .git/refs/heads/{b}
              <br />
              &nbsp;&nbsp;<span style={{ color: b === 'feature' ? C.feature : C.accent }}>{branches[b]}</span>
            </div>
          ))}
          <div style={{ color: C.textAccent }}>$ cat .git/HEAD → ref: refs/heads/{head}</div>
        </div>
      )}

      <div style={{ marginTop: '0.8rem' }}>
        <button
          type="button"
          aria-label="Сбросить граф"
          style={btnStyle(false, true)}
          onClick={() => {
            setCommits([{ id: 'c1', msg: 'init', parents: [], col: 0, row: 0, branch: 'main' }]);
            setBranches({ main: 'c1', feature: 'c1' });
            setHead('main');
            setCounter(2);
            setNote(null);
            setQuiz(null);
          }}
        >
          Сбросить граф
        </button>
      </div>
    </div>
  );
}

function btnStyle(disabled: boolean, secondary = false): CSSProperties {
  return {
    font: 'inherit',
    fontSize: '0.8rem',
    padding: '0.4rem 0.75rem',
    borderRadius: 7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    border: `1px solid ${secondary ? C.border : C.accent}`,
    background: secondary ? 'transparent' : C.accent,
    color: secondary ? C.text : 'var(--sl-color-black)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
}

function panel(): CSSProperties {
  return {
    padding: '0.6rem 0.75rem',
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.bgAccent,
  };
}
