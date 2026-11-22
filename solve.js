// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Pure stdlib ES module. Same answers byte for byte as the reference; the pipeline,
// report strings and every edge-case rule follow baselines/makefun-site/vendor/makefun-site/
// (README.md states the rules, its code is the reference where they differ).
// Optimisations vs the reference:
//  - Markdown inline rendering is a single chunked pass (no per-character escapeHtml regex).
//  - escapeHtml scans once and returns the input untouched when nothing needs escaping.
//  - The Markdown lexer is fused into the renderer with manual line classifiers (no regex
//    per line), no token objects, and blocks pushed straight into one output array.
//  - slugify has an ASCII fast path and a per-build cache (tag names repeat a lot; a
//    cache never crosses cases: it is created inside build()).
//  - Front matter is located with indexOf instead of splitting the whole body into lines.
//  - Template rendering pushes into one shared array instead of concatenating strings.

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const INCLUDE_DEPTH = 8;
const SLUG_MAX = 64;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ------------------------------------------------------------------ text */

// The HTML escape table, in this order: & < > " '.
const ESC_RE = /[&<>"']/;
function escapeHtml(text) {
  if (!ESC_RE.test(text)) return text;
  const n = text.length;
  let out = null;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let e;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    else continue;
    if (out === null) out = [];
    if (i > start) out.push(text.slice(start, i));
    out.push(e);
    start = i + 1;
  }
  if (out === null) return text;
  if (start < n) out.push(text.slice(start));
  return out.join('');
}

const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/** The slug of `text`, cached per build in `cache` (a Map created by build()). */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Non-ASCII whitespace (JS \s beyond the ASCII six): used only off the fast path.
function isWSCode(c) {
  return c === 160 || c === 1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII whitespace is exactly 9, 10, 11, 12, 13, 32; printable ASCII is never whitespace.
    if (c > 32 && c < 127) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || isWSCode(c)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------- front matter */

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. The closing line is found with indexOf so the body
 * is never split into lines and re-joined.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // First line after the opening one that is exactly '---'.
  const idx = text.indexOf('\n---\n', nl);
  let closeStart;
  let body;
  if (idx !== -1) {
    closeStart = idx + 1;
    body = text.slice(idx + 5);
  } else if (text.endsWith('\n---') && text.length - 3 > nl) {
    closeStart = text.length - 3;
    body = '';
  } else {
    return { error: 'the front matter is not closed' };
  }
  const fmText = text.slice(nl + 1, closeStart - 1);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (line === '' || /^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${j + 2} is not "key: value"` };
    let keyOk = true;
    for (let k = 0; k < colon; k++) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let value;
    if (colon === line.length - 1) value = '';
    else if (line.charCodeAt(colon + 1) === 32) value = line.slice(colon + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    let e = value.length;
    while (e > 0 && (value.charCodeAt(e - 1) === 32 || value.charCodeAt(e - 1) === 9)) e--;
    const raw = value.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

/* --------------------------------------------------------------- markdown */

// Line classifiers (manual, no regex per line).

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(n - 1);
  if (c0 !== 32 && c0 !== 9 && c1 !== 32 && c1 !== 9) return line;
  let a = 0;
  let b = n;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Fence open: returns the language ('' when none) or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < 6 && line.charCodeAt(d) === 35) d++;
  if (d === 0) return null;
  if (d === 6 && line.charCodeAt(6) === 35) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let a = d;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: d, text: line.slice(a, b) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const m = c0 === 45 ? '---' : '***';
  if (!line.startsWith(m)) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9 || line.length === 0) return isBlank(line);
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** Bullet marker: the item's text after '- ' / '* ', or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** Ordered marker: { num, text } or null (1-9 digits, then '. '). */
function orderedOf(line) {
  let i = 0;
  while (i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

const WS_AFTER_SPACES = /\s/;

/** A list continuation: 2+ spaces then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  return i < line.length && !WS_AFTER_SPACES.test(line[i]);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\` *_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const HAS_WS = /\s/;

/** The first index from `from` (below `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= end) {
    const k = s.indexOf(what, from);
    return k !== -1 && k + what.length <= end ? k : -1;
  }
  for (let j = from; j <= end - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (below `end`; one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= end) {
    let j = s.indexOf('*', from);
    while (j !== -1 && j < end) {
      if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
      return j;
    }
    return -1;
  }
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `text[a..b)` HTML-escaped, appended to `out` (no intermediate string). */
const ESC_G = /[&<>"']/g;
function escapeHtmlInto(text, a, b, out) {
  ESC_G.lastIndex = a;
  const m = ESC_G.exec(text);
  if (m === null || m.index >= b) {
    if (b > a) out.push(text.slice(a, b));
    return;
  }
  let start = a;
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    let e;
    if (c === 38) e = '&amp;';
    else if (c === 60) e = '&lt;';
    else if (c === 62) e = '&gt;';
    else if (c === 34) e = '&quot;';
    else if (c === 39) e = '&#39;';
    else continue;
    if (i > start) out.push(text.slice(start, i));
    out.push(e);
    start = i + 1;
  }
  if (b > start) out.push(text.slice(start, b));
}

const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s[from..to)` rendered inline, appended to `out` (an array of string chunks).
 * The next markup character is found with one native regex scan instead of a
 * per-character JS loop; plain runs are sliced out whole. Only code spans,
 * links and the recursive strong/em bodies need escaping or recursion.
 * `env.link(target)` is a link's href.
 */
function inline(s, env, out, from, to) {
  let start = from;
  const n = to;
  INLINE_SPECIAL.lastIndex = from;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null && m.index < n) {
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      if (j + 1 < n && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
        if (j > start) out.push(s.slice(start, j));
        const nc = s.charCodeAt(j + 1);
        out.push(nc === 38 ? '&amp;' : nc === 60 ? '&lt;' : nc === 62 ? '&gt;' : nc === 34 ? '&quot;' : nc === 39 ? '&#39;' : s[j + 1]);
        start = j + 2;
        INLINE_SPECIAL.lastIndex = start;
      } else {
        INLINE_SPECIAL.lastIndex = j + 1;
      }
      continue;
    }
    if (j > start) out.push(s.slice(start, j));
    if (c === 96) { // backtick
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < n && k > j + 1) {
        out.push('<code>');
        escapeHtmlInto(s, j + 1, k, out);
        out.push('</code>');
        start = k + 1;
        INLINE_SPECIAL.lastIndex = start;
      } else {
        out.push('`');
        start = j + 1;
        INLINE_SPECIAL.lastIndex = start;
      }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, n);
        if (k > j + 2) {
          out.push('<strong>');
          inline(s, env, out, j + 2, k);
          out.push('</strong>');
          start = k + 2;
          INLINE_SPECIAL.lastIndex = start;
        } else {
          out.push('**');
          start = j + 2;
          INLINE_SPECIAL.lastIndex = start;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, n);
      if (k > j + 1) {
        out.push('<em>');
        inline(s, env, out, j + 1, k);
        out.push('</em>');
        start = k + 1;
        INLINE_SPECIAL.lastIndex = start;
      } else {
        out.push('*');
        start = j + 1;
        INLINE_SPECIAL.lastIndex = start;
      }
      continue;
    }
    if (c === 91) { // [
      const k = findUnescaped(s, ']', j + 1, n);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm >= n ? '' : s.slice(k + 2, mm);
      if (target !== '' && !HAS_WS.test(target)) {
        const href = env.link(target);
        out.push('<a href="');
        escapeHtmlInto(href, 0, href.length, out);
        out.push('">');
        inline(s, env, out, j + 1, k);
        out.push('</a>');
        start = mm + 1;
        INLINE_SPECIAL.lastIndex = start;
        continue;
      }
      out.push('[');
      start = j + 1;
      INLINE_SPECIAL.lastIndex = start;
      continue;
    }
    // & < > " '
    out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
    start = j + 1;
    INLINE_SPECIAL.lastIndex = start;
  }
  if (n > start) out.push(s.slice(start, n));
}

/**
 * `src` rendered in one fused lex+render pass: its HTML, its table of contents
 * (every level 2 and 3 heading) and its excerpt (the first paragraph's inline
 * HTML, or ""). `slugCache` is the build's slug cache.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const L = lines.length;
  const starts = new Array(L);
  starts[0] = 0;
  for (let k = 0; k < L - 1; k++) starts[k + 1] = starts[k] + lines[k].length + 1;
  const ids = new Set();
  const parts = [];
  const toc = [];
  const tmp = [];
  let excerpt = null;
  let i = 0;
  while (i < L) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Dispatch on the first character: a line can only be a blank, a fence, a
    // heading, a break, a quote or a list when it opens on that block's mark.
    // Anything else is a paragraph line (indented lines are text, not code).
    if (c0 === 32 || c0 === 9 || line.length === 0) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        parts.push('<pre><code');
        if (lang !== '') parts.push(' class="language-', escapeHtml(lang), '"');
        parts.push('>');
        i++;
        while (i < L && !fenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        tmp.length = 0;
        inline(heading.text, env, tmp, 0, heading.text.length);
        const html = tmp.join('');
        parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        parts.push('<hr>\n');
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < L) {
          const l = lines[i];
          const nb = bulletOf(l);
          if (nb !== null) {
            items.push([trimLine(nb)]);
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        parts.push('<ul>\n');
        for (const item of items) {
          tmp.length = 0;
          const it = item.join('\n');
          inline(it, env, tmp, 0, it.length);
          parts.push('<li>', tmp.join(''), '</li>\n');
        }
        parts.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const cleaned = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') cleaned.push(t);
      }
      if (cleaned.length === 0) {
        parts.push('<blockquote>\n</blockquote>\n');
      } else {
        tmp.length = 0;
        const bq = cleaned.join('\n');
        inline(bq, env, tmp, 0, bq.length);
        parts.push('<blockquote>\n<p>', tmp.join(''), '</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        while (i < L) {
          const l = lines[i];
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
            continue;
          }
          if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        const open = Number(ordered.num) !== 1 ? `<ol start="${Number(ordered.num)}">` : '<ol>';
        parts.push(open, '\n');
        for (const item of items) {
          tmp.length = 0;
          const it = item.join('\n');
          inline(it, env, tmp, 0, it.length);
          parts.push('<li>', tmp.join(''), '</li>\n');
        }
        parts.push('</ol>\n');
        continue;
      }
    }
    const a = i;
    let needsTrim = false;
    {
      const l0 = lines[a];
      const n0 = l0.length;
      if (n0 > 0) {
        const c0 = l0.charCodeAt(0), c1 = l0.charCodeAt(n0 - 1);
        if (c0 === 32 || c0 === 9 || c1 === 32 || c1 === 9) needsTrim = true;
      }
    }
    i++;
    while (i < L && !endsParagraph(lines[i])) {
      const ln = lines[i];
      const nn = ln.length;
      if (nn > 0) {
        const c0 = ln.charCodeAt(0), c1 = ln.charCodeAt(nn - 1);
        if (c0 === 32 || c0 === 9 || c1 === 32 || c1 === 9) needsTrim = true;
      }
      i++;
    }
    const b = i - 1;
    tmp.length = 0;
    if (!needsTrim) {
      inline(src, env, tmp, starts[a], starts[b] + lines[b].length);
    } else {
      const body = [];
      for (let k = a; k <= b; k++) body.push(trimLine(lines[k]));
      const pt = body.join('\n');
      inline(pt, env, tmp, 0, pt.length);
    }
    const html = tmp.join('');
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`.
 * `ctx` holds the parsed templates, the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { [n.name]: xs[0], loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          const cl = ctx.classify.get(n.name);
          if (cl !== undefined && cl.kind !== 'dyn' && depth + 1 + cl.height <= INCLUDE_DEPTH) {
            if (cl.kind === 'const') {
              let s = ctx.cacheConst.get(n.name);
              if (s === undefined) {
                const tmp = [];
                renderNodes(t, scope, ctx, depth + 1, tmp);
                s = tmp.join('');
                ctx.cacheConst.set(n.name, s);
              }
              out.push(s);
            } else {
              const key = lookup(scope, [cl.arg]);
              let m = ctx.cacheArg.get(n.name);
              if (m === undefined) { m = new Map(); ctx.cacheArg.set(n.name, m); }
              let s = m.get(key);
              if (s === undefined) {
                const tmp = [];
                renderNodes(t, scope, ctx, depth + 1, tmp);
                s = tmp.join('');
                m.set(key, s);
              }
              out.push(s);
            }
          } else {
            renderNodes(t, scope, ctx, depth + 1, out);
          }
        }
        break;
      }
    }
  }
}

/* ------------------------------------------------- template constancy */

// The names every render sees without a template naming them: the base scope.
const BASE_VARS = new Set(['site', 'tags', 'recent']);

/**
 * Each template's free variable roots (names it reads that no enclosing
 * `for` binds), to a fixpoint over includes. A template that only reads
 * base-scope names renders the same string every time in a build; one that
 * reads a single further name renders the same string for the same value.
 * Unknown node kinds force dynamic (never cached).
 */
function templateFreeVars(templates) {
  const free = new Map();
  for (const name of templates.keys()) free.set(name, new Set());
  let bad = false;
  const walk = (nodes, bound, into) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) into.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) into.add(n.path[0]);
        walk(n.then, bound, into);
        if (n.else !== null) walk(n.else, bound, into);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) into.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2, into);
      } else if (n.kind === 'include') {
        const sub = free.get(n.name);
        if (sub) for (const r of sub) if (!bound.has(r)) into.add(r);
      } else if (n.kind !== 'text') {
        bad = true;
      }
    }
  };
  for (let iter = 0; iter < 32; iter++) {
    let changed = false;
    for (const [name, nodes] of templates) {
      const into = new Set();
      walk(nodes, new Set(), into);
      const cur = free.get(name);
      for (const r of into) if (!cur.has(r)) { cur.add(r); changed = true; }
    }
    if (!changed) break;
  }
  return { free, bad };
}

/** Longest include chain below each template (Infinity on a cycle). */
function templateHeights(templates) {
  const height = new Map();
  const visiting = new Set();
  const calc = (name) => {
    if (height.has(name)) return height.get(name);
    if (visiting.has(name)) return Infinity;
    visiting.add(name);
    let h = 0;
    const walkH = (ns) => {
      for (const n of ns) {
        if (n.kind === 'include') {
          const sub = calc(n.name);
          h = Math.max(h, 1 + sub);
        } else if (n.kind === 'if') {
          walkH(n.then);
          if (n.else) walkH(n.else);
        } else if (n.kind === 'for') walkH(n.body);
      }
    };
    const nodes = templates.get(name);
    if (nodes) walkH(nodes);
    visiting.delete(name);
    height.set(name, h);
    return h;
  };
  for (const name of templates.keys()) calc(name);
  return height;
}

/**
 * Per template: { kind: 'const' } (only base-scope names — one string per
 * build), { kind: 'arg', arg } (one further name — one string per value of
 * it), or { kind: 'dyn' } (anything else — always re-rendered). `height` is
 * the include depth below the template, used to keep the depth cap exact.
 */
function classifyTemplates(templates) {
  const { free, bad } = templateFreeVars(templates);
  const heights = templateHeights(templates);
  const out = new Map();
  for (const [name, roots] of free) {
    const h = heights.get(name);
    if (bad || h === undefined || h === Infinity) { out.set(name, { kind: 'dyn', height: Infinity }); continue; }
    let arg = null;
    let dyn = false;
    for (const r of roots) {
      if (BASE_VARS.has(r)) continue;
      if (arg === null) arg = r;
      else if (arg !== r) { dyn = true; break; }
    }
    if (dyn) out.set(name, { kind: 'dyn', height: h });
    else if (arg === null) out.set(name, { kind: 'const', height: h });
    else out.set(name, { kind: 'arg', arg, height: h });
  }
  return out;
}

/* ------------------------------------------------------------------- build */

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CRLF = /\r\n?/g;

/** A source's tags, each slug once, in its own order (slug computed once per name). */
function ownTags(s, slugCache) {
  const seen = new Set();
  const out = [];
  for (const name of (s.data.tags ?? [])) {
    const slug = slugify(name, slugCache);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug });
  }
  return out;
}

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache,
  };

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CRLF, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      s.words = wordsOf(s.body);
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const { name, slug } of ownTags(p, slugCache)) {
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) s.tagRefs = ownTags(s, slugCache).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil((s.words ?? wordsOf(s.body)) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil((s.words ?? wordsOf(s.body)) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, escape: escapeHtml, classify: classifyTemplates(b.templates), cacheConst: new Map(), cacheArg: new Map() };
    const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
      return out.join('');
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
