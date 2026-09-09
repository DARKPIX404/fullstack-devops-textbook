/*
 * Интерактивный учебник: квиз «Вопросы на собеседовании» + прогресс чтения.
 * Чистый клиентский скрипт без зависимостей. Каждая фича изолирована:
 * ошибка в одной не ломает страницу и остальные фичи.
 */
(function () {
  'use strict';

  var READ_STORE_KEY = 'tbpx:read';
  var PLAN_STORE_KEY = 'tbpx:plan';
  var OK_COLOR = 'var(--sl-color-green, #3fb950)';

  /* ---------- общие утилиты ---------- */

  function safe(fn) {
    try {
      fn();
    } catch (e) {
      /* фича недоступна — страница продолжает работать без неё */
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function normalizePath(raw) {
    var path = raw;
    try {
      path = new URL(raw, window.location.origin).pathname;
    } catch (e) { /* оставляем как есть */ }
    path = path.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  }

  function readSet() {
    try {
      var data = JSON.parse(localStorage.getItem(READ_STORE_KEY) || '[]');
      return Array.isArray(data) ? data : [];
    } catch (e) {
      return [];
    }
  }

  function writeReadSet(set) {
    try {
      localStorage.setItem(READ_STORE_KEY, JSON.stringify(set));
    } catch (e) { /* хранилище недоступно — состояние не сохранится */ }
  }

  function isRead(path) {
    return readSet().indexOf(path) !== -1;
  }

  function setRead(path, value) {
    var set = readSet();
    var idx = set.indexOf(path);
    if (value && idx === -1) set.push(path);
    if (!value && idx !== -1) set.splice(idx, 1);
    writeReadSet(set);
    document.dispatchEvent(new CustomEvent('tbp:readchange', { detail: path }));
  }

  /* ---------- стили ---------- */

  function injectStyles() {
    if (document.getElementById('tbq-progress-styles')) return;
    var style = document.createElement('style');
    style.id = 'tbq-progress-styles';
    style.textContent = [
      /* === квиз === */
      '.tbq-quiz{margin:1.5rem 0;padding:1.25rem 1.5rem;border:1px solid var(--sl-color-border);border-radius:0.75rem;background:var(--sl-color-bg-accent);}',
      '.tbq-topbar{display:flex;flex-wrap:wrap;gap:0.5rem 1rem;align-items:center;justify-content:space-between;margin-bottom:1rem;font-size:0.9em;}',
      '.tbq-progress{font-weight:600;color:var(--sl-color-text);}',
      '.tbq-score{color:var(--sl-color-text-accent);}',
      '.tbq-q{font-size:1.05em;font-weight:600;margin:0 0 0.75rem;color:var(--sl-color-text);}',
      '.tbq-answer{margin:0 0 1rem;}',
      '.tbq-answer:empty{display:none;}',
      '.tbq-answer > p:first-child{margin-top:0;}',
      '.tbq-controls{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;}',
      '.tbq-btn{cursor:pointer;border-radius:0.5rem;padding:0.45rem 0.95rem;font:inherit;font-size:0.9em;border:1px solid var(--sl-color-border);background:transparent;color:var(--sl-color-text-accent);}',
      '.tbq-btn:hover{border-color:var(--sl-color-text-accent);}',
      '.tbq-btn:focus-visible{outline:2px solid var(--sl-color-text-accent);outline-offset:2px;}',
      '.tbq-btn--primary{background:var(--sl-color-text-accent);border-color:var(--sl-color-text-accent);color:var(--sl-color-bg);font-weight:600;}',
      '.tbq-btn--ok{border-color:' + OK_COLOR + ';color:' + OK_COLOR + ';font-weight:600;}',
      '.tbq-btn--ok:hover{background:' + OK_COLOR + ';color:var(--sl-color-bg);}',
      '.tbq-btn--bad:hover{border-color:var(--sl-color-text-accent);}',
      '.tbq-result{text-align:center;padding:0.5rem 0;}',
      '.tbq-result-title{font-size:1.2em;font-weight:700;margin:0 0 0.25rem;color:var(--sl-color-text);}',
      '.tbq-result-pct{font-size:2.2em;font-weight:700;color:var(--sl-color-text-accent);margin:0.25rem 0;}',
      '.tbq-result-note{color:var(--sl-color-text);opacity:0.85;margin:0 0 1rem;}',
      '.tbq-result .tbq-controls{justify-content:center;}',
      '.tbq-linkbtn{cursor:pointer;border:none;background:none;padding:0;font:inherit;font-size:0.9em;color:var(--sl-color-text-accent);text-decoration:underline;text-underline-offset:2px;}',
      '.tbq-linkbtn:focus-visible{outline:2px solid var(--sl-color-text-accent);outline-offset:2px;}',
      /* === прогресс чтения === */
      '.tbp-read-btn{margin-left:0.75rem;vertical-align:middle;cursor:pointer;border-radius:0.5rem;padding:0.3rem 0.8rem;font:inherit;font-size:0.72em;font-weight:600;border:1px solid var(--sl-color-border);background:transparent;color:var(--sl-color-text-accent);}',
      '.tbp-read-btn:hover{border-color:var(--sl-color-text-accent);}',
      '.tbp-read-btn:focus-visible{outline:2px solid var(--sl-color-text-accent);outline-offset:2px;}',
      '.tbp-read-btn.is-read{border-color:' + OK_COLOR + ';color:' + OK_COLOR + ';}',
      '.tbp-badge{display:inline-block;margin-left:0.35rem;padding:0 0.35rem;border-radius:0.4rem;font-size:0.72em;font-weight:700;color:' + OK_COLOR + ';border:1px solid ' + OK_COLOR + ';vertical-align:middle;}',
      'a.tbp-read-link{opacity:0.75;}',
      'a.tbp-read-link:hover{opacity:1;}',
      '.tbp-progress{margin:1rem 0;padding:0.75rem 1rem;border:1px solid var(--sl-color-border);border-radius:0.75rem;background:var(--sl-color-bg-accent);font-size:0.9em;}',
      '.tbp-progress-label{margin:0 0 0.4rem;color:var(--sl-color-text);}',
      '.tbp-bar{height:0.5rem;border-radius:0.25rem;background:var(--sl-color-border);overflow:hidden;}',
      '.tbp-bar-fill{height:100%;width:0;background:' + OK_COLOR + ';transition:width 0.2s ease;}',
      '.tbp-check{display:inline-flex;align-items:center;gap:0.4rem;margin:0 0 0.75rem;cursor:pointer;font-size:0.9em;color:var(--sl-color-text);}',
      '.tbp-check input{width:1rem;height:1rem;accent-color:' + OK_COLOR + ';cursor:pointer;margin:0;}',
      'li.task-list-item input[type="checkbox"]{width:1rem;height:1rem;accent-color:' + OK_COLOR + ';cursor:pointer;}'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---------- фича 1: квиз «Вопросы на собеседовании» ---------- */

  var Q_HEADING_RE = /Вопросы на собеседовани/i;
  var Q_NUM_RE = /^\s*\d+[.)]\s+/;

  function isHeadingWrapper(node, level) {
    if (!node || node.nodeType !== 1) return false;
    if (node.tagName === 'H2') return level === 'h2';
    if (node.tagName !== 'DIV') return false;
    var cls = node.className || '';
    if ((' ' + cls + ' ').indexOf(' sl-heading-wrapper ') === -1) return false;
    var h = node.querySelector('h2, h3');
    if (!h) return false;
    if (level === 'h2') return h.tagName === 'H2';
    return true;
  }

  /* Извлекает вопрос из li/p, чей первый значимый ребёнок — <strong>. */
  function extractQuestion(block) {
    var host = block;
    var strong = null;
    if (block.tagName === 'LI') {
      strong = firstStrong(block);
    } else if (block.tagName === 'P') {
      strong = firstStrong(block);
    }
    if (!strong) return null;

    var question = (strong.textContent || '').replace(Q_NUM_RE, '').trim();
    if (!question) return null;

    return { block: block, strong: strong, host: host, question: question };
  }

  function firstStrong(block) {
    var first = block.firstElementChild;
    if (first && first.tagName === 'STRONG') return first;
    if (first && first.tagName === 'P') {
      var inner = first.firstElementChild;
      if (inner && inner.tagName === 'STRONG') return inner;
    }
    return null;
  }

  /*
   * Собирает узлы ответа для пары «вопрос → ответ» и расставляет маркеры,
   * к которым узлы возвращаются при скрытии ответа / восстановлении вида.
   * Возвращает null, если ответ пуст (структура не распознана).
   */
  function extractAnswer(pair) {
    var strong = pair.strong;
    var strongParent = strong.parentNode;
    var inlineNodes = [];
    var blockNodes = [];

    if (strongParent.tagName === 'P' && strongParent !== pair.block) {
      /* strong внутри отдельного абзаца внутри li */
      var sib = strongParent.nextSibling;
      while (sib) {
        var next = sib.nextSibling;
        blockNodes.push(sib);
        sib = next;
      }
      /* остаток внутри самого p с strong (редко, но возможен) */
      var n = strong.nextSibling;
      while (n) {
        var nx = n.nextSibling;
        inlineNodes.push(n);
        n = nx;
      }
    } else {
      /* strong прямо в li или в p верхнего уровня */
      var node = strong.nextSibling;
      while (node) {
        var nodeNext = node.nextSibling;
        inlineNodes.push(node);
        node = nodeNext;
      }
      if (pair.block.tagName === 'LI') {
        var p = strongParent.nextElementSibling;
        while (p) {
          var pNext = p.nextElementSibling;
          blockNodes.push(p);
          p = pNext;
        }
      }
    }

    var hasInline = inlineNodes.some(function (n) {
      return n.nodeType !== 3 || n.textContent.trim() !== '';
    });
    var hasBlock = blockNodes.some(function (n) {
      return n.nodeType !== 3 || n.textContent.trim() !== '';
    });

    var inlineMarker = document.createComment('tbq-inline');
    strong.parentNode.insertBefore(inlineMarker, strong.nextSibling);

    var blockMarker = null;
    if (blockNodes.length) {
      blockMarker = document.createComment('tbq-block');
      blockNodes[0].parentNode.insertBefore(blockMarker, blockNodes[0]);
    }

    pair.inlineNodes = inlineNodes;
    pair.blockNodes = blockNodes;
    pair.inlineMarker = inlineMarker;
    pair.blockMarker = blockMarker;
    pair.hasInline = hasInline;
    pair.hasBlock = hasBlock;
    return pair;
  }

  function pairHasAnswer(pair) {
    if (pair.hasInline || pair.hasBlock) return true;
    return pair.blockNodes.some(function (n) {
      return n.nodeType !== 3 || n.textContent.trim() !== '';
    });
  }

  function stashAnswer(pair) {
    var i;
    if (pair.inlineNodes) {
      for (i = 0; i < pair.inlineNodes.length; i++) {
        pair.inlineMarker.parentNode.insertBefore(pair.inlineNodes[i], pair.inlineMarker.nextSibling);
      }
    }
    if (pair.blockNodes && pair.blockNodes.length) {
      for (i = 0; i < pair.blockNodes.length; i++) {
        pair.blockMarker.parentNode.insertBefore(pair.blockNodes[i], pair.blockMarker.nextSibling);
      }
    }
  }

  function showAnswerIn(pair, container) {
    var i;
    for (i = 0; i < pair.inlineNodes.length; i++) container.appendChild(pair.inlineNodes[i]);
    for (i = 0; i < pair.blockNodes.length; i++) container.appendChild(pair.blockNodes[i]);
  }

  function parseInterviewSection(headingWrap) {
    var nodes = [];
    var node = headingWrap.nextSibling;
    while (node) {
      var next = node.nextSibling;
      if (isHeadingWrapper(node, 'h2')) break;
      if (node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim() !== '')) {
        nodes.push(node);
      }
      node = next;
    }
    if (!nodes.length) return null;

    var pairs = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.nodeType !== 1) return null;
      if (n.tagName === 'OL' || n.tagName === 'UL') {
        var items = n.children;
        if (!items.length) return null;
        for (var k = 0; k < items.length; k++) {
          if (items[k].tagName !== 'LI') return null;
          var pair = extractQuestion(items[k]);
          if (!pair) return null;
          pair = extractAnswer(pair);
          pairs.push(pair);
        }
      } else if (n.tagName === 'P') {
        var qp = extractQuestion(n);
        if (qp) {
          qp = extractAnswer(qp);
          pairs.push(qp);
        } else {
          /* абзац без <strong> — продолжение ответа предыдущего вопроса */
          if (!pairs.length) return null;
          var prev = pairs[pairs.length - 1];
          if (!prev.blockNodes) prev.blockNodes = [];
          prev.blockNodes.push(n);
          if (!prev.blockMarker) {
            prev.blockMarker = document.createComment('tbq-block');
            n.parentNode.insertBefore(prev.blockMarker, n);
          }
        }
      } else {
        return null; /* неизвестный элемент внутри раздела — не трогаем страницу */
      }
    }
    if (pairs.length < 2) return null;
    for (var m = 0; m < pairs.length; m++) {
      if (!pairHasAnswer(pairs[m])) return null; /* вопрос без ответа — формат не распознан */
    }
    return { pairs: pairs };
  }

  function initQuiz() {
    var h2s = document.querySelectorAll('main h2');
    var heading = null;
    for (var i = 0; i < h2s.length; i++) {
      if (Q_HEADING_RE.test(h2s[i].textContent)) {
        heading = h2s[i];
        break;
      }
    }
    if (!heading) return;

    var headingWrap = heading.parentNode;
    if (!isHeadingWrapper(headingWrap, 'any')) headingWrap = heading;

    var parsed = parseInterviewSection(headingWrap);
    if (!parsed) return; /* структура не распознана — страница остаётся как есть */

    var pairs = parsed.pairs;
    var state = { idx: 0, revealed: {}, know: 0, dont: 0, done: false };

    /* оборачиваем исходный контент раздела: пока квиз активен, он скрыт */
    var original = el('div', 'tbq-original');
    var node = headingWrap.nextSibling;
    var sectionNodes = [];
    while (node) {
      var next = node.nextSibling;
      if (isHeadingWrapper(node, 'h2')) break;
      if (node.nodeType === 1) sectionNodes.push(node);
      original.appendChild(node);
      node = next;
    }
    original.hidden = true;
    headingWrap.parentNode.insertBefore(original, headingWrap.nextSibling);

    var quiz = el('section', 'tbq-quiz');
    quiz.setAttribute('role', 'region');
    quiz.setAttribute('aria-label', 'Интерактивный квиз по вопросам собеседования');
    headingWrap.parentNode.insertBefore(quiz, original);

    var topbar = el('div', 'tbq-topbar');
    var progress = el('span', 'tbq-progress');
    var score = el('span', 'tbq-score');
    var listBtn = el('button', 'tbq-linkbtn', 'Показать все вопросы списком');
    listBtn.type = 'button';
    topbar.appendChild(progress);
    topbar.appendChild(score);
    topbar.appendChild(listBtn);
    quiz.appendChild(topbar);

    var card = el('div', 'tbq-card');
    quiz.appendChild(card);

    function stashAll() {
      for (var i = 0; i < pairs.length; i++) {
        if (state.revealed[i]) stashAnswer(pairs[i]);
      }
    }

    function render() {
      card.textContent = '';
      progress.textContent = 'Вопрос ' + Math.min(state.idx + 1, pairs.length) + ' из ' + pairs.length;
      score.textContent = 'Знаю: ' + state.know + ' · Не знаю: ' + state.dont;

      if (state.done) {
        renderResult();
        return;
      }

      var pair = pairs[state.idx];
      card.appendChild(el('h3', 'tbq-q', pair.question));

      var answerBox = el('div', 'tbq-answer');
      answerBox.setAttribute('aria-live', 'polite');
      card.appendChild(answerBox);

      var controls = el('div', 'tbq-controls');
      card.appendChild(controls);

      if (state.revealed[state.idx]) {
        showAnswerIn(pair, answerBox);
        var knowBtn = el('button', 'tbq-btn tbq-btn--ok', 'Знаю ✓');
        knowBtn.type = 'button';
        var dontBtn = el('button', 'tbq-btn tbq-btn--bad', 'Не знаю ✗');
        dontBtn.type = 'button';
        knowBtn.addEventListener('click', function () { answer(true); });
        dontBtn.addEventListener('click', function () { answer(false); });
        controls.appendChild(knowBtn);
        controls.appendChild(dontBtn);
      } else {
        var showBtn = el('button', 'tbq-btn tbq-btn--primary', 'Показать ответ');
        showBtn.type = 'button';
        showBtn.addEventListener('click', function () {
          state.revealed[state.idx] = true;
          render();
        });
        controls.appendChild(showBtn);
      }

      if (state.idx > 0) {
        var backBtn = el('button', 'tbq-btn', 'Назад');
        backBtn.type = 'button';
        backBtn.addEventListener('click', function () {
          state.idx -= 1;
          render();
        });
        controls.appendChild(backBtn);
      }
    }

    function answer(know) {
      /* повторный ответ на тот же вопрос — корректируем счётчики */
      var prev = state['ans' + state.idx];
      if (prev === true) state.know -= 1;
      if (prev === false) state.dont -= 1;
      if (know) state.know += 1; else state.dont += 1;
      state['ans' + state.idx] = know;
      stashAnswer(pairs[state.idx]);
      if (state.idx + 1 >= pairs.length) {
        state.done = true;
      } else {
        state.idx += 1;
      }
      render();
    }

    function renderResult() {
      progress.textContent = 'Вопрос ' + pairs.length + ' из ' + pairs.length;
      var pct = Math.round((state.know / pairs.length) * 100);
      var wrap = el('div', 'tbq-result');
      var title = el('p', 'tbq-result-title', 'Квиз пройден');
      var pctEl = el('p', 'tbq-result-pct', pct + '%');
      var noteText = pct >= 80
        ? 'Отличный результат — тема закреплена.'
        : pct >= 50
          ? 'Неплохо. Прогони ещё раз вопросы, которые пропустил.'
          : 'Стоит вернуться к главе и повторить материал.';
      var note = el('p', 'tbq-result-note', noteText + ' Знаю: ' + state.know + ' · Не знаю: ' + state.dont);
      var controls = el('div', 'tbq-controls');
      var againBtn = el('button', 'tbq-btn tbq-btn--primary', 'Пройти ещё раз');
      againBtn.type = 'button';
      againBtn.addEventListener('click', function () {
        state.idx = 0;
        state.know = 0;
        state.dont = 0;
        state.done = false;
        state.revealed = {};
        render();
      });
      controls.appendChild(againBtn);
      wrap.appendChild(title);
      wrap.appendChild(pctEl);
      wrap.appendChild(note);
      wrap.appendChild(controls);
      card.appendChild(wrap);
    }

    function showList() {
      stashAll();
      quiz.hidden = true;
      original.hidden = false;
      var back = el('button', 'tbq-linkbtn', 'Вернуться к квизу');
      back.type = 'button';
      back.addEventListener('click', function () {
        back.parentNode.removeChild(back);
        original.hidden = true;
        quiz.hidden = false;
      });
      original.parentNode.insertBefore(back, original);
    }

    listBtn.addEventListener('click', showList);
    render();
  }

  /* ---------- фича 2.1: кнопка «Прочитано» ---------- */

  function initReadButton() {
    if (window.location.pathname === '/') return;
    var main = document.querySelector('main');
    if (!main) return;
    var h1 = main.querySelector('h1');
    if (!h1) return;

    var path = normalizePath(window.location.pathname);
    var btn = el('button', 'tbp-read-btn', isRead(path) ? 'Прочитано ✓' : 'Отметить прочитанным');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', isRead(path) ? 'true' : 'false');
    if (isRead(path)) btn.classList.add('is-read');

    btn.addEventListener('click', function () {
      var now = !isRead(path);
      setRead(path, now);
      btn.textContent = now ? 'Прочитано ✓' : 'Отметить прочитанным';
      btn.classList.toggle('is-read', now);
      btn.setAttribute('aria-pressed', now ? 'true' : 'false');
    });

    h1.parentNode.insertBefore(btn, h1.nextSibling);
  }

  /* ---------- фича 2.2: бейджи «прочитано» в сайдбаре ---------- */

  function decorateSidebar() {
    var nav = document.querySelector('nav.sidebar');
    if (!nav) return;
    var set = readSet();
    var links = nav.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var path = normalizePath(a.getAttribute('href'));
      var badge = a.querySelector('.tbp-badge');
      if (set.indexOf(path) !== -1) {
        a.classList.add('tbp-read-link');
        if (!badge) {
          var span = el('span', 'tbp-badge', '✓ прочитано');
          a.appendChild(span);
        }
      } else {
        a.classList.remove('tbp-read-link');
        if (badge) badge.parentNode.removeChild(badge);
      }
    }
  }

  /* ---------- фича 2.3: чеклист на обзорной странице раздела ---------- */

  function initSectionChecklist() {
    var match = window.location.pathname.match(/^\/(0\d-[a-z0-9-]+)\/?$/i);
    if (!match) return;
    var section = match[1];
    var main = document.querySelector('main');
    if (!main) return;

    var prefix = '/' + section + '/';
    var anchors = main.querySelectorAll('a[href]');
    var seen = {};
    var seenContainers = [];
    var items = [];
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].getAttribute('href');
      if (!href || href.charAt(0) !== '/') continue;
      if (anchors[i].closest('.pagination-links')) continue; /* ссылки «назад/вперёд» не главы */
      var path = normalizePath(href);
      if (path === '/' || path === normalizePath(window.location.pathname)) continue;
      if (path.indexOf(prefix) !== 0) continue;
      var rest = path.slice(prefix.length);
      if (rest === '' || rest.indexOf('/') !== -1) continue; /* только главы первого уровня */
      if (seen[path]) continue;
      var container = anchors[i].closest('li') || anchors[i].closest('p');
      if (!container) continue;
      if (seenContainers.indexOf(container) !== -1) continue;
      seen[path] = true;
      seenContainers.push(container);
      items.push({ path: path, title: (anchors[i].textContent || '').trim() || path, container: container });
    }
    if (!items.length) return;

    var progress = el('div', 'tbp-progress');
    progress.setAttribute('role', 'group');
    progress.setAttribute('aria-label', 'Прогресс чтения раздела');
    var label = el('p', 'tbp-progress-label');
    var bar = el('div', 'tbp-bar');
    var fill = el('div', 'tbp-bar-fill');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.appendChild(fill);
    progress.appendChild(label);
    progress.appendChild(bar);
    items[0].container.parentNode.insertBefore(progress, items[0].container);

    function refresh() {
      var done = 0;
      for (var i = 0; i < items.length; i++) {
        if (isRead(items[i].path)) done += 1;
        items[i].input.checked = isRead(items[i].path);
      }
      label.textContent = 'Прочитано ' + done + ' из ' + items.length + ' глав раздела';
      var pct = Math.round((done / items.length) * 100);
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(pct));
    }

    for (var j = 0; j < items.length; j++) {
      (function (item) {
        var lab = el('label', 'tbp-check');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('aria-label', item.title + ' — прочитано');
        lab.appendChild(input);
        lab.appendChild(el('span', '', 'прочитано'));
        item.input = input;
        input.addEventListener('change', function () {
          setRead(item.path, input.checked);
        });
        item.container.parentNode.insertBefore(lab, item.container);
      })(items[j]);
    }

    document.addEventListener('tbp:readchange', refresh);
    refresh();
  }

  /* ---------- фича 2.4: чеклист плана действий ---------- */

  function initActionPlan() {
    if (normalizePath(window.location.pathname) !== '/intro/action-plan') return;
    var main = document.querySelector('main');
    if (!main) return;
    var boxes = main.querySelectorAll('input[type="checkbox"]');
    if (!boxes.length) return;

    var state;
    try {
      state = JSON.parse(localStorage.getItem(PLAN_STORE_KEY) || '{}');
      if (typeof state !== 'object' || state === null) state = {};
    } catch (e) {
      state = {};
    }

    function save() {
      try {
        localStorage.setItem(PLAN_STORE_KEY, JSON.stringify(state));
      } catch (e) { /* не критично */ }
    }

    function itemKey(box) {
      var li = box.closest('li');
      var text = li ? li.textContent : box.parentNode.textContent;
      return (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    }

    var firstList = null;
    var items = [];
    for (var i = 0; i < boxes.length; i++) {
      (function (box) {
        var key = itemKey(box);
        box.disabled = false;
        box.checked = !!state[key];
        var li = box.closest('li');
        if (li && !firstList) firstList = li.parentNode;
        items.push({ box: box, key: key });
        box.addEventListener('change', function () {
          state[key] = box.checked;
          if (!box.checked) delete state[key];
          save();
          refresh();
        });
      })(boxes[i]);
    }

    var progress = el('div', 'tbp-progress');
    var label = el('p', 'tbp-progress-label');
    var bar = el('div', 'tbp-bar');
    var fill = el('div', 'tbp-bar-fill');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.appendChild(fill);
    progress.appendChild(label);
    progress.appendChild(bar);

    var target = main.querySelector('ul.contains-task-list') || firstList;
    if (target && target.parentNode) {
      target.parentNode.insertBefore(progress, target);
    } else {
      return;
    }

    function refresh() {
      var done = 0;
      for (var i = 0; i < items.length; i++) {
        if (items[i].box.checked) done += 1;
      }
      var pct = items.length ? Math.round((done / items.length) * 100) : 0;
      label.textContent = 'План выполнен на ' + pct + '%';
      fill.style.width = pct + '%';
      bar.setAttribute('aria-valuenow', String(pct));
    }

    refresh();
  }

  /* ---------- запуск ---------- */

  function init() {
    safe(injectStyles);
    safe(initQuiz);
    safe(initReadButton);
    safe(function () {
      decorateSidebar();
      document.addEventListener('tbp:readchange', decorateSidebar);
    });
    safe(initSectionChecklist);
    safe(initActionPlan);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
