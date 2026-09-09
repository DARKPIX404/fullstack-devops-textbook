import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

/**
 * GitObjects — интерактив «как рождаются объекты Git».
 * Считает настоящий SHA-1 (как `git hash-object`) прямо в браузере
 * и показывает рождение цепочки blob → tree → commit → parent.
 */

// --- Компактная реализация SHA-1 (соответствует sha1sum) ---
function sha1(bytes: Uint8Array): string {
  const rl = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  const ml = bytes.length;
  const bitLen = ml * 8;
  const withPad = new Uint8Array(Math.ceil((ml + 9) / 64) * 64);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296), false);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rl(a, 5) + f + e + k + w[j]) | 0;
      e = d; d = c; c = rl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const hex = (n: number) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

const encoder = new TextEncoder();
const short = (h: string) => h.slice(0, 7);

const COMMIT_MESSAGES = [
  'feat: начальная версия',
  'docs: дописал пояснения',
  'fix: поправил опечатку',
];

const C = {
  bg: 'var(--sl-color-bg)',
  bgAccent: 'var(--sl-color-bg-accent)',
  accent: 'var(--sl-color-accent)',
  text: 'var(--sl-color-text)',
  textAccent: 'var(--sl-color-text-accent)',
  border: 'var(--sl-color-border)',
  mono: "ui-monospace, 'JetBrains Mono', 'Fira Code', monospace",
};

type Commit = { n: number; msg: string; tree: string; hash: string; parent: string | null };

export default function GitObjects() {
  const [content, setContent] = useState('hello');
  const [commitCount, setCommitCount] = useState(0);
  const [showDisk, setShowDisk] = useState(false);

  // Реальный blob-хэш: sha1("blob <байт>\0" + содержимое) — ровно то, что делает git hash-object
  const blobHash = useMemo(() => {
    const body = encoder.encode(content);
    const header = encoder.encode(`blob ${body.length}\0`);
    const full = new Uint8Array(header.length + body.length);
    full.set(header); full.set(body, header.length);
    return sha1(full);
  }, [content]);

  const byteLen = useMemo(() => encoder.encode(content).length, [content]);

  // tree и commit-хэши — детерминированные производные от blob-хэша (учебная модель)
  const treeHash = useMemo(() => sha1(encoder.encode(`tree\n100644 file.txt ${blobHash}`)), [blobHash]);

  const commits: Commit[] = useMemo(() => {
    const list: Commit[] = [];
    for (let i = 0; i < commitCount; i++) {
      const parent = i === 0 ? null : list[i - 1].hash;
      const hash = sha1(encoder.encode(`commit\n${treeHash}\n${parent ?? ''}\n${COMMIT_MESSAGES[i]}`));
      list.push({ n: i + 1, msg: COMMIT_MESSAGES[i], tree: treeHash, hash, parent });
    }
    return list;
  }, [commitCount, treeHash]);

  const addCommit = () => {
    if (commitCount < COMMIT_MESSAGES.length) setCommitCount(commitCount + 1);
  };
  const reset = () => setCommitCount(0);

  // Геометрия SVG
  const rowH = 78;
  const commitRows = commits.length;
  const treeY = 46 + commitRows * rowH + 20;
  const blobY = treeY + 92;
  const svgH = blobY + 64;
  const colCommit = 150;
  const colTree = 150;
  const colBlob = 150;

  const insight = (key: string, text: string, color = C.accent) => (
    <li key={key} style={{ marginBottom: 6, lineHeight: 1.5 }}>
      <span style={{ color, fontWeight: 700 }}>→ </span>
      {text}
    </li>
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
      <p style={{ margin: '0 0 0.9rem', fontWeight: 700, color: C.textAccent }}>
        Интерактив: как рождается объект blob
      </p>

      <label htmlFor="git-objects-input" style={{ display: 'block', marginBottom: 6, fontSize: '0.85rem' }}>
        Содержимое файла <code style={{ fontFamily: C.mono }}>file.txt</code> (поменяй — хэш пересчитается):
      </label>
      <textarea
        id="git-objects-input"
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          // Объекты неизменяемы: новое содержимое = другой blob,
          // уже показанные коммиты пересобирать нельзя — сбрасываем схему.
          setCommitCount(0);
        }}
        rows={3}
        spellCheck={false}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: C.mono,
          fontSize: '0.9rem',
          padding: '0.6rem 0.7rem',
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          background: C.bgAccent,
          color: C.text,
          resize: 'vertical',
        }}
      />

      <div
        style={{
          marginTop: 10,
          padding: '0.7rem 0.8rem',
          borderRadius: 8,
          background: C.bgAccent,
          border: `1px solid ${C.border}`,
          fontFamily: C.mono,
          fontSize: '0.82rem',
          lineHeight: 1.7,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <div>
          <span style={{ color: C.textAccent }}>заголовок:</span>{' '}
          <span style={{ color: C.accent }}>blob {byteLen}\0</span>
        </div>
        <div>
          <span style={{ color: C.textAccent }}>sha1(заголовок + содержимое) = </span>
          {blobHash}
        </div>
        <div>
          <span style={{ color: C.textAccent }}>git log покажет:</span>{' '}
          <strong style={{ color: C.accent }}>{short(blobHash)}</strong>
          <span style={{ color: C.textAccent }}> — первые 7 символов полного хэша</span>
        </div>
      </div>

      <p style={{ fontSize: '0.85rem', margin: '0.8rem 0 0.4rem', color: C.textAccent }}>
        Теперь собери цепочку объектов — это то, что делает <code style={{ fontFamily: C.mono }}>git commit</code>:
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '0.8rem' }}>
        <button
          type="button"
          aria-label="Сделать коммит"
          onClick={addCommit}
          disabled={commitCount >= COMMIT_MESSAGES.length}
          style={btnStyle(commitCount >= COMMIT_MESSAGES.length)}
        >
          {commitCount === 0 ? 'Сделать коммит' : 'Ещё коммит'}
        </button>
        <button type="button" aria-label="Сбросить схему" onClick={reset} style={btnStyle(false, true)}>
          Сбросить
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showDisk}
            onChange={(e) => setShowDisk(e.target.checked)}
            aria-label="Показать, как объект лежит на диске"
          />
          показать, как лежит на диске (.git/objects/ab/…)
        </label>
      </div>

      {commitCount > 0 && (
        <svg
          viewBox={`0 0 480 ${svgH}`}
          role="img"
          aria-label="Схема объектов Git: commit ссылается на tree, tree на blob, commit на parent"
          style={{ width: '100%', maxWidth: 480, display: 'block', margin: '0 auto' }}
        >
          <defs>
            <marker id="go-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={C.accent} />
            </marker>
          </defs>

          {/* стрелки commit → parent */}
          {commits.map((c, i) => {
            if (!c.parent || i === 0) return null;
            const y1 = 46 + i * rowH;
            const y2 = 46 + (i - 1) * rowH;
            return (
              <g key={`p-${c.n}`}>
                <line x1={colCommit} y1={y1 - 26} x2={colCommit} y2={y2 + 26} stroke={C.accent} strokeWidth={1.5} markerEnd="url(#go-arrow)" />
                <text x={colCommit + 10} y={(y1 + y2) / 2 + 4} fontSize={11} fill={C.textAccent} fontFamily={C.mono}>
                  parent
                </text>
              </g>
            );
          })}

          {/* стрелки commit → tree */}
          {commits.map((c) => {
            const y1 = 46 + (c.n - 1) * rowH;
            return (
              <g key={`t-${c.n}`}>
                <line x1={colCommit + 52} y1={y1} x2={colTree + 40} y2={treeY} stroke={C.border} strokeWidth={1.2} markerEnd="url(#go-arrow)" strokeDasharray="4 3" />
                <text x={(colCommit + colTree) / 2 + 44} y={(y1 + treeY) / 2} fontSize={10} fill={C.textAccent} fontFamily={C.mono}>
                  tree
                </text>
              </g>
            );
          })}

          {/* стрелка tree → blob */}
          <line x1={colTree} y1={treeY + 26} x2={colBlob} y2={blobY - 26} stroke={C.accent} strokeWidth={1.5} markerEnd="url(#go-arrow)" />
          <text x={colTree + 12} y={(treeY + blobY) / 2 + 4} fontSize={11} fill={C.textAccent} fontFamily={C.mono}>
            {short(blobHash)}
          </text>

          {/* узлы commit */}
          {commits.map((c, i) => {
            const y = 46 + i * rowH;
            return (
              <g key={c.n}>
                <rect x={colCommit - 78} y={y - 26} width={156} height={52} rx={9} fill={C.bgAccent} stroke={C.accent} strokeWidth={1.5} />
                <text x={colCommit} y={y - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.text}>
                  commit {c.n}
                </text>
                <text x={colCommit} y={y + 8} textAnchor="middle" fontSize={10.5} fill={C.textAccent} fontFamily={C.mono}>
                  {short(c.hash)} · {c.msg.split(':')[0]}
                </text>
                <text x={colCommit} y={y + 21} textAnchor="middle" fontSize={9.5} fill={C.textAccent} fontFamily={C.mono}>
                  author: ты · parent: {c.parent ? short(c.parent) : '—'}
                </text>
              </g>
            );
          })}

          {/* узел tree */}
          <g>
            <rect x={colTree - 78} y={treeY - 26} width={156} height={52} rx={9} fill={C.bgAccent} stroke={C.border} strokeWidth={1.5} />
            <text x={colTree} y={treeY - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.text}>
              tree
            </text>
            <text x={colTree} y={treeY + 8} textAnchor="middle" fontSize={10.5} fill={C.textAccent} fontFamily={C.mono}>
              {short(treeHash)}
            </text>
            <text x={colTree} y={treeY + 21} textAnchor="middle" fontSize={9.5} fill={C.textAccent} fontFamily={C.mono}>
              100644 file.txt → {short(blobHash)}
            </text>
          </g>

          {/* узел blob */}
          <g>
            <rect x={colBlob - 78} y={blobY - 26} width={156} height={52} rx={9} fill={C.bgAccent} stroke={C.border} strokeWidth={1.5} />
            <text x={colBlob} y={blobY - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.text}>
              blob
            </text>
            <text x={colBlob} y={blobY + 8} textAnchor="middle" fontSize={10.5} fill={C.textAccent} fontFamily={C.mono}>
              {short(blobHash)}
            </text>
            <text x={colBlob} y={blobY + 21} textAnchor="middle" fontSize={9.5} fill={C.textAccent} fontFamily={C.mono}>
              "{content.length > 14 ? content.slice(0, 14) + '…' : content}"
            </text>
          </g>
        </svg>
      )}

      {commitCount > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.8rem 0 0', fontSize: '0.88rem' }}>
          {insight('immutable', 'Объекты неизменяемы: хэш вычисляется из содержимого, поэтому «поправить» объект нельзя — только создать новый.')}
          {commitCount >= 2 &&
            insight('linked', 'Каждый commit хранит хэш родителя — история это связный список, идущий от новых коммитов к старым.')}
          {commitCount >= 2 &&
            insight('dedup', 'tree и blob у обоих коммитов совпадают: содержимое не менялось — новых объектов не появилось, сработала дедупликация.', C.textAccent)}
        </ul>
      )}

      {showDisk && (
        <div
          style={{
            marginTop: '0.9rem',
            padding: '0.7rem 0.8rem',
            borderRadius: 8,
            border: `1px dashed ${C.border}`,
            fontFamily: C.mono,
            fontSize: '0.85rem',
            lineHeight: 2,
          }}
        >
          <div style={{ color: C.textAccent, marginBottom: 4 }}>.git/objects/ — loose-объект на диске:</div>
          <div>
            <span style={{ color: C.accent, fontWeight: 700 }}>{blobHash.slice(0, 2)}</span>
            <span style={{ color: C.textAccent }}>/</span>
            <span>{blobHash.slice(2)}</span>
          </div>
          <div style={{ color: C.textAccent, fontSize: '0.78rem' }}>
            первые 2 символа — папка-распределитель, остальные 38 — имя файла; внутри лежит zlib("blob {byteLen}\0{content}").
          </div>
        </div>
      )}
    </div>
  );
}

function btnStyle(disabled: boolean, secondary = false): CSSProperties {
  return {
    font: 'inherit',
    fontSize: '0.85rem',
    padding: '0.45rem 0.9rem',
    borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: `1px solid ${secondary ? C.border : C.accent}`,
    background: secondary ? 'transparent' : C.accent,
    color: secondary ? C.text : 'var(--sl-color-black)',
    fontWeight: 600,
  };
}
