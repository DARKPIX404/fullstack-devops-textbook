import { useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * GitStaging — симулятор трёх областей Git: рабочая директория / index / HEAD.
 * Модель точно повторяет семантику: git add (workdir → index), git commit
 * (index → HEAD), git reset (mixed: index = HEAD), git restore --staged
 * (index = HEAD для файла), git checkout -- файл (workdir = index).
 *
 * У каждого файла три «версии содержимого»: head, index, workdir.
 * null = файла нет в этой области. Статусы выводятся из сравнения версий.
 */

type Area = 'head' | 'index' | 'workdir';
type FileEntry = { name: string; head: string | null; index: string | null; workdir: string | null };

const initialFiles = (): FileEntry[] => [
  { name: 'app.js', head: 'v1', index: 'v1', workdir: 'v2' },      // modified, unstaged
  { name: 'fixes.js', head: 'v1', index: 'v1', workdir: 'v2' },    // modified, unstaged
  { name: 'README.md', head: 'v1', index: 'v1', workdir: 'v2' },   // modified, unstaged
  { name: 'config.env', head: null, index: null, workdir: 'v1' },  // untracked
  { name: 'old.js', head: 'v1', index: 'v1', workdir: null },      // deleted в workdir
];

type Status =
  | { kind: 'staged-new' }
  | { kind: 'staged-modified' }
  | { kind: 'staged-deleted' }
  | { kind: 'unstaged-modified' }
  | { kind: 'unstaged-deleted' }
  | { kind: 'untracked' }
  | { kind: 'partial' } // staged и снова изменён
  | { kind: 'clean' };

function stagedStatus(f: FileEntry): 'none' | 'new' | 'modified' | 'deleted' {
  if (f.index === f.head) return 'none';
  if (f.index === null) return 'deleted';
  if (f.head === null) return 'new';
  return 'modified';
}

function unstagedStatus(f: FileEntry): 'none' | 'modified' | 'deleted' | 'untracked' {
  if (f.workdir === f.index) return 'none';
  if (f.workdir === null) return 'deleted';
  if (f.index === null && f.head === null) return 'untracked';
  return 'modified';
}

function statusOf(f: FileEntry): Status {
  const st = stagedStatus(f);
  const us = unstagedStatus(f);
  if (st !== 'none' && us !== 'none') return { kind: 'partial' };
  if (st !== 'none') return { kind: `staged-${st}` as Status['kind'] };
  if (us === 'untracked') return { kind: 'untracked' };
  if (us !== 'none') return { kind: `unstaged-${us}` as Status['kind'] };
  return { kind: 'clean' };
}

const C = {
  bg: 'var(--sl-color-bg)',
  bgAccent: 'var(--sl-color-bg-accent)',
  accent: 'var(--sl-color-accent)',
  text: 'var(--sl-color-text)',
  textAccent: 'var(--sl-color-text-accent)',
  border: 'var(--sl-color-border)',
  warn: '#e8a13a',
  mono: "ui-monospace, 'JetBrains Mono', 'Fira Code', monospace",
};

export default function GitStaging() {
  const [files, setFiles] = useState<FileEntry[]>(initialFiles);
  const [lastCommit, setLastCommit] = useState<string[] | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [practiceResult, setPracticeResult] = useState<'idle' | 'ok' | 'fail'>('idle');

  const mutate = (cmd: string, fn: (f: FileEntry) => FileEntry) => {
    setFiles((prev) => prev.map(fn).filter((f) => !(f.head === null && f.index === null && f.workdir === null)));
    setLog((prev) => [cmd, ...prev].slice(0, 4));
    setPracticeResult('idle');
  };

  const addFile = (name: string) =>
    mutate(`$ git add ${name}`, (f) => (f.name === name ? { ...f, index: f.workdir } : f));

  const addAll = () => mutate('$ git add .', (f) => ({ ...f, index: f.workdir }));

  const commit = () => {
    if (!files.some((f) => stagedStatus(f) !== 'none')) return;
    const committed = files.filter((f) => stagedStatus(f) !== 'none').map((f) => f.name);
    setFiles((prev) =>
      prev
        .map((f) => (stagedStatus(f) !== 'none' ? { ...f, head: f.index } : f))
        .filter((f) => !(f.head === null && f.index === null && f.workdir === null))
    );
    setLastCommit(committed);
    setLog((prev) => ['$ git commit -m "feat: мой коммит"', ...prev].slice(0, 4));
    setPracticeResult(
      committed.length === 2 && committed.includes('fixes.js') && committed.includes('README.md')
        ? 'ok'
        : 'fail'
    );
  };

  const resetMixed = () =>
    mutate('$ git reset  (mixed)', (f) => ({ ...f, index: f.head }));

  const restoreStaged = (name: string) =>
    mutate(`$ git restore --staged ${name}`, (f) => (f.name === name ? { ...f, index: f.head } : f));

  const checkoutFile = (name: string) => {
    const f = files.find((x) => x.name === name);
    if (!f || f.workdir === f.index) return;
    const ok = window.confirm(
      `git checkout -- ${name} перезапишет рабочую версию из index. Изменения будут потеряны. Продолжить?`
    );
    if (!ok) return;
    mutate(`$ git checkout -- ${name}`, (x) => (x.name === name ? { ...x, workdir: x.index } : x));
  };

  const staged = files.filter((f) => stagedStatus(f) !== 'none');
  const unstaged = files.filter((f) => ['modified', 'deleted'].includes(unstagedStatus(f)));
  const untracked = files.filter((f) => unstagedStatus(f) === 'untracked');

  const statusLine = (f: FileEntry): { label: string; color: string } => {
    const s = statusOf(f).kind;
    switch (s) {
      case 'staged-new': return { label: 'new file (в коммит)', color: C.accent };
      case 'staged-modified': return { label: 'modified (в коммит)', color: C.accent };
      case 'staged-deleted': return { label: 'deleted (в коммит)', color: C.accent };
      case 'unstaged-modified': return { label: 'modified (не в коммите)', color: C.warn };
      case 'unstaged-deleted': return { label: 'deleted (не в коммите)', color: C.warn };
      case 'untracked': return { label: 'untracked', color: C.textAccent };
      case 'partial': return { label: 'staged + снова изменён', color: C.warn };
      default: return { label: 'без изменений', color: C.textAccent };
    }
  };

  const areaFiles = (area: Area) =>
    files.filter((f) => f[area] !== null);

  const column = (title: string, area: Area) => (
    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
      <p style={{ margin: '0 0 0.5rem', fontWeight: 700, fontSize: '0.85rem', color: C.textAccent }}>{title}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {areaFiles(area).length === 0 && (
          <div style={fileBox(C.textAccent, true)}>(пусто)</div>
        )}
        {areaFiles(area).map((f) => {
          const st = area === 'workdir' ? statusLine(f) : null;
          return (
            <div key={f.name} style={fileBox(st ? st.color : C.textAccent)} title={f.name}>
              <code style={{ fontFamily: C.mono, fontSize: '0.82rem', overflowWrap: 'anywhere' }}>{f.name}</code>
              {area === 'workdir' && st && (
                <span style={{ fontSize: '0.72rem', color: st.color }}>{st.label}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

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
        Интерактив: три области — workdir / index / HEAD
      </p>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem' }}>
        Выполняй команды и смотри, как файлы мигрируют между областями. Статусы справа в workdir — то, что покажет{' '}
        <code style={{ fontFamily: C.mono }}>git status</code>.
      </p>

      {/* Команды по файлам */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: '1rem' }}>
        {files.map((f) => (
          <div
            key={f.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              padding: '0.35rem 0.5rem',
              borderRadius: 8,
              background: C.bgAccent,
              border: `1px solid ${C.border}`,
            }}
          >
            <code style={{ fontFamily: C.mono, fontSize: '0.82rem', minWidth: 110 }}>{f.name}</code>
            <span style={{ fontSize: '0.78rem', color: statusLine(f).color, flex: 1 }}>{statusLine(f).label}</span>
            <button type="button" aria-label={`git add ${f.name}`} onClick={() => addFile(f.name)} style={btnStyle(false, true)}>
              git add
            </button>
            <button
              type="button"
              aria-label={`git restore --staged ${f.name}`}
              onClick={() => restoreStaged(f.name)}
              disabled={stagedStatus(f) === 'none'}
              style={btnStyle(stagedStatus(f) === 'none', true)}
            >
              restore --staged
            </button>
            <button
              type="button"
              aria-label={`git checkout -- ${f.name}`}
              onClick={() => checkoutFile(f.name)}
              disabled={f.workdir === null || f.workdir === f.index}
              style={btnStyle(f.workdir === null || f.workdir === f.index, true)}
            >
              checkout --
            </button>
          </div>
        ))}
      </div>

      {/* Общие команды */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
        <button type="button" aria-label="git add ." onClick={addAll} style={btnStyle(false, true)}>git add .</button>
        <button
          type="button"
          aria-label="git commit"
          onClick={commit}
          disabled={staged.length === 0}
          style={btnStyle(staged.length === 0)}
        >
          git commit -m "feat: мой коммит"
        </button>
        <button type="button" aria-label="git reset mixed" onClick={resetMixed} style={btnStyle(false, true)}>
          git reset (mixed)
        </button>
      </div>

      {/* Три колонки */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: '1rem' }}>
        {column('Рабочая директория', 'workdir')}
        {column('Индекс (staging)', 'index')}
        {column('Последний коммит (HEAD)', 'head')}
      </div>

      {/* Что покажет git status */}
      <div style={{ ...panel(), fontFamily: C.mono, fontSize: '0.8rem', lineHeight: 1.8 }}>
        <div style={{ color: C.textAccent }}>$ git status</div>
        {staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && (
          <div style={{ color: C.accent }}>nothing to commit, working tree clean</div>
        )}
        {staged.length > 0 && (
          <>
            <div style={{ color: C.accent }}>Changes to be committed:</div>
            {staged.map((f) => (
              <div key={f.name}>&nbsp;&nbsp;{stagedStatus(f) === 'new' ? 'new file:' : stagedStatus(f) === 'deleted' ? 'deleted:' : 'modified:'}&nbsp;&nbsp;&nbsp;{f.name}</div>
            ))}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <div style={{ color: C.warn }}>Changes not staged for commit:</div>
            {unstaged.map((f) => (
              <div key={f.name}>&nbsp;&nbsp;{unstagedStatus(f) === 'deleted' ? 'deleted:' : 'modified:'}&nbsp;&nbsp;&nbsp;{f.name}</div>
            ))}
          </>
        )}
        {untracked.length > 0 && (
          <>
            <div style={{ color: C.textAccent }}>Untracked files:</div>
            {untracked.map((f) => (
              <div key={f.name}>&nbsp;&nbsp;{f.name}</div>
            ))}
          </>
        )}
      </div>

      {/* Журнал команд */}
      {log.length > 0 && (
        <div style={{ ...panel(), fontFamily: C.mono, fontSize: '0.78rem', color: C.textAccent }}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {/* Мини-практика */}
      <div style={{ ...panel(), marginTop: '0.9rem' }}>
        <p style={{ margin: '0 0 0.5rem', fontWeight: 700, fontSize: '0.85rem' }}>Мини-практика</p>
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
          Задание: сделай так, чтобы в следующий коммит попали <strong>только</strong>{' '}
          <code style={{ fontFamily: C.mono }}>fixes.js</code> и <code style={{ fontFamily: C.mono }}>README.md</code>.
          Коммить через кнопку выше — проверка сработает на нём.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" aria-label="Проверить решение" onClick={commit} disabled={staged.length === 0} style={btnStyle(staged.length === 0)}>
            Закоммитить и проверить
          </button>
          <button
            type="button"
            aria-label="Сбросить симулятор"
            onClick={() => { setFiles(initialFiles()); setLastCommit(null); setLog([]); setPracticeResult('idle'); }}
            style={btnStyle(false, true)}
          >
            Сбросить
          </button>
          {practiceResult === 'ok' && (
            <span style={{ color: C.accent, fontWeight: 700, fontSize: '0.85rem' }}>
              Верно: в коммит вошли ровно fixes.js и README.md. Это и есть атомарный коммит.
            </span>
          )}
          {practiceResult === 'fail' && lastCommit && (
            <span style={{ color: C.warn, fontSize: '0.85rem' }}>
              В коммит попало: {lastCommit.join(', ') || '—'}. Нужно было проиндексировать только два файла
              (git add fixes.js и git add README.md), а config.env и old.js оставить вне коммита.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function fileBox(color: string, dimmed = false): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '0.4rem 0.55rem',
    borderRadius: 8,
    border: `1px solid ${dimmed ? 'transparent' : C.border}`,
    borderLeft: `3px solid ${dimmed ? C.border : color}`,
    background: C.bgAccent,
    opacity: dimmed ? 0.6 : 1,
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

function btnStyle(disabled: boolean, secondary = false): CSSProperties {
  return {
    font: 'inherit',
    fontSize: '0.78rem',
    padding: '0.35rem 0.7rem',
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
