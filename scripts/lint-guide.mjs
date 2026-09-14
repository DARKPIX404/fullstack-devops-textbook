#!/usr/bin/env node
// Линтер глав учебника. Проверяет соответствие STYLE_GUIDE.md:
// объём текста, число асайдов, frontmatter, обязательные заголовки,
// пиновку docker-образов и баланс скобок в заголовках асайдов.
//
// Запуск: node scripts/lint-guide.mjs
// Exit code: 1 при наличии ошибок, 0 если только предупреждения или чисто.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DOCS_DIR = join(ROOT, "src", "content", "docs");

// Разделы, которые не являются главами и не проверяются.
const EXCLUDED_DIRS = new Set(["intro", "appendix"]);

// Нормы объёма (слова текста без code-блоков, frontmatter и таблиц).
const CHAPTER_MIN_WORDS = 1800;
const CHAPTER_MAX_WORDS = 2600;
const INDEX_MAX_WORDS = 1000;

// Норма асайдов на главу.
const ASIDE_MIN = 3;
const ASIDE_MAX = 5;
const ASIDE_SOFT_MAX = 7;

// Жёсткость проверок норм содержания (объём глав, число асайдов).
// Часть глав пока не дотягивает до нормы, поэтому правила работают
// в режиме предупреждений. После приведения контента к STYLE_GUIDE
// поднять до "error".
const CONTENT_NORM_LEVEL = "warn";

const ASIDE_TYPES = "(?:note|tip|caution|danger)";
const RE_ASIDE_OPEN = new RegExp(`^:{3,}${ASIDE_TYPES}\\b`);
const RE_ASIDE_TITLE = new RegExp(`^:{3,}${ASIDE_TYPES}\\[(.*)\\]\\s*$`);

const problems = [];

function report(level, file, rule, detail) {
  problems.push({ level, file, rule, detail });
}

// Рекурсивный список .md/.mdx в src/content/docs.
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (/\.(md|mdx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

// Извлекает frontmatter и тело документа.
function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: raw };
  return { frontmatter: m[1], body: raw.slice(m[0].length) };
}

// Разбивает тело на строки прозы и строки fenced code-блоков.
// Возвращает { prose: string[], code: { line, lang }[] }.
function splitProseAndCode(body) {
  const prose = [];
  const code = [];
  let inFence = false;
  let fenceLang = "";
  for (const line of body.split("\n")) {
    const fence = line.trim().match(/^(```|~~~)\s*(\w*)/);
    if (fence) {
      if (!inFence) fenceLang = fence[2].toLowerCase();
      inFence = !inFence;
      if (!inFence) fenceLang = "";
      continue;
    }
    if (inFence) code.push({ line, lang: fenceLang });
    else prose.push(line);
  }
  return { prose, code };
}

// Число слов: токены, разделённые пробелами, без таблиц.
function countWords(proseLines) {
  const text = proseLines
    .filter((l) => !l.trim().startsWith("|"))
    .join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}

function checkVolume(rel, isIndex, words) {
  if (isIndex) {
    if (words > INDEX_MAX_WORDS) {
      report("error", rel, "volume", `обзор раздела: ${words} слов текста при лимите <=${INDEX_MAX_WORDS}`);
    }
    return;
  }
  if (words < CHAPTER_MIN_WORDS || words > CHAPTER_MAX_WORDS) {
    report(
      CONTENT_NORM_LEVEL,
      rel,
      "volume",
      `${words} слов текста при норме ${CHAPTER_MIN_WORDS}-${CHAPTER_MAX_WORDS}`,
    );
  }
}

function checkAsides(rel, body) {
  const count = body.split("\n").filter((l) => RE_ASIDE_OPEN.test(l)).length;
  if (count < ASIDE_MIN) {
    report(CONTENT_NORM_LEVEL, rel, "asides", `${count} асайдов при норме ${ASIDE_MIN}-${ASIDE_MAX}`);
  } else if (count > ASIDE_SOFT_MAX) {
    report(CONTENT_NORM_LEVEL, rel, "asides", `${count} асайдов при норме ${ASIDE_MIN}-${ASIDE_MAX}`);
  } else if (count > ASIDE_MAX) {
    report("warn", rel, "asides", `${count} асайдов при норме ${ASIDE_MIN}-${ASIDE_MAX} (допустимо до ${ASIDE_SOFT_MAX})`);
  }
}

function checkFrontmatter(rel, frontmatter) {
  for (const field of ["title", "description"]) {
    const m = frontmatter.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
    const value = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
    if (!value) {
      report("error", rel, "frontmatter", `поле "${field}" отсутствует или пустое`);
    }
  }
}

function checkInterviewHeading(rel, proseLines) {
  const headings = proseLines.filter((l) => /^#{1,6}\s/.test(l));
  const hasCorrect = headings.some((h) => /^#{1,6}\s+Вопросы на собеседовании\s*$/.test(h));
  if (!hasCorrect) {
    report("error", rel, "interview-heading", 'нет заголовка "Вопросы на собеседовании"');
  }
  const wrong = headings.filter((h) => /Вопросы на собеседование\b/.test(h) && !/собеседовании/.test(h));
  for (const h of wrong) {
    report("error", rel, "interview-heading", `вариант без «и»: "${h.replace(/^#+\s*/, "")}"`);
  }
}

// Образ из строки вида image:/image =/FROM. Возвращает null, если строка не про образ.
function extractImageRef(line, lang) {
  const trimmed = line.trim();
  // image:/image = проверяем только в yaml-подобных блоках: в hcl/ts и т.п.
  // это чаще всего облачный образ VM, а не docker-образ.
  let m = null;
  if (lang === "yaml" || lang === "yml" || lang === "") {
    m = trimmed.match(/^image\s*[:=]\s*["']?([^\s"'#]+)/);
  }
  if (!m && lang === "dockerfile") {
    m = trimmed.match(/^FROM\s+([^\s]+)/i);
  }
  if (!m) return null;
  const image = m[1];
  // Шаблоны (Helm {{ ... }}), inline-объекты JS и переменные — не образы.
  if (image.startsWith("{") || image.startsWith("$")) return null;
  return image;
}

function checkDockerImages(rel, codeLines) {
  const stageAliases = new Set();
  for (const { line, lang } of codeLines) {
    const trimmed = line.trim();
    // Алиасы стадий multi-stage Dockerfile: FROM x AS builder -> далее FROM builder.
    if (lang === "dockerfile") {
      const alias = trimmed.match(/^FROM\s+\S+\s+[Aa][Ss]\s+(\S+)/);
      if (alias) stageAliases.add(alias[1]);
    }
    const image = extractImageRef(line, lang);
    if (!image) continue;
    if (image.includes("${")) continue; // переменные окружения
    if (stageAliases.has(image) || image === "scratch") continue; // локальные стадии
    const lastSegment = image.includes("/") ? image.slice(image.lastIndexOf("/") + 1) : image;
    const tagMatch = lastSegment.match(/:(.+)$/);
    if (tagMatch && tagMatch[1] === "latest") {
      report("error", rel, "docker-pin", `тег :latest в "${trimmed}"`);
    } else if (!tagMatch && !image.includes("@sha256:")) {
      report("warn", rel, "docker-pin", `образ без тега/дайджеста в "${trimmed}"`);
    }
  }
}

function checkAsideTitleParens(rel, body) {
  for (const line of body.split("\n")) {
    const m = line.trim().match(RE_ASIDE_TITLE);
    if (!m) continue;
    const title = m[1];
    const open = (title.match(/\(/g) || []).length;
    const close = (title.match(/\)/g) || []).length;
    if (open !== close) {
      report("error", rel, "aside-title-parens", `непарная скобка в заголовке асайда: "${title}"`);
    }
  }
}

const files = collectFiles(DOCS_DIR);
let chapterCount = 0;
let indexCount = 0;

for (const file of files) {
  const rel = relative(DOCS_DIR, file);
  const topDir = rel.split(/[\\/]/)[0];
  const isIndex = /^index\.(md|mdx)$/.test(basename(file));
  if (EXCLUDED_DIRS.has(topDir)) continue;

  const raw = readFileSync(file, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const { prose, code } = splitProseAndCode(body);
  const words = countWords(prose);

  if (isIndex) {
    indexCount++;
    checkVolume(rel, true, words);
    continue;
  }

  chapterCount++;
  checkVolume(rel, false, words);
  checkAsides(rel, body);
  checkFrontmatter(rel, frontmatter);
  checkInterviewHeading(rel, prose);
  checkDockerImages(rel, code);
  checkAsideTitleParens(rel, body);
}

const errors = problems.filter((p) => p.level === "error");
const warnings = problems.filter((p) => p.level === "warn");

for (const p of problems) {
  const tag = p.level === "error" ? "ERROR" : "WARN ";
  console.log(`${tag}  ${p.file}  [${p.rule}] ${p.detail}`);
}

console.log("");
console.log(
  `Проверено: ${chapterCount} глав, ${indexCount} обзоров разделов. ` +
    `Ошибок: ${errors.length}, предупреждений: ${warnings.length}.`,
);

if (CONTENT_NORM_LEVEL === "warn" && warnings.length > 0) {
  console.log("Нормы объёма и числа асайдов пока работают в режиме предупреждений (см. CONTENT_NORM_LEVEL).");
}

process.exit(errors.length > 0 ? 1 : 0);
