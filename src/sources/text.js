// HTML to readable text, and the cleanup that keeps the evidence pool honest.
//
// Load-bearing for HARD RULE 3: a fact is proven by its quote appearing in the
// stored text of the document, so anything left in that text is something a
// claim can be grounded in. A quote lifted from a cookie banner would pass the
// check and publish, which is why the boilerplate goes.
//
// Regex-based on purpose: nothing fetched is ever rendered or executed here, it
// is only read, matched against, and shown to the drafting model.

const BLOCK = 'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // A tag ends at the first ">" outside quotes: some sites (Wikipedia's data-mw)
  // put ">" inside attribute values, and a naive [^>]* leaves tag pieces behind.
  const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;
  s = s.replace(new RegExp(`</?(?:${BLOCK})\\b${ATTRS}>`, 'gi'), '\n');
  // Inline tags collapse to nothing, not to a space: "From <b>October</b>." must
  // stay "From October." or an exact quote of it fails.
  s = s.replace(new RegExp(`<${ATTRS}>`, 'g'), '');
  // Wiki furniture that survives as text: citation markers, "[update]", template remnants.
  s = s.replace(/\[(?:\d{1,3}|update|citation needed|note \d+|[a-z])\]/gi, '').replace(/\{\{[^{}]*\}\}/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t ​]+/g, ' ');
  return stripBoilerplate(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  ).join('\n');
}

const BOILERPLATE =
  /^(?:accept|reject|view|hide|manage|change)\b.*\bcookie|^cookies?\b|\bcookie (?:settings|policy|preferences)\b|^skip to |^sign (?:in|up)\b|^log ?in$|^menu$|^search\b|^back to top$|^share this\b|^follow us\b|^subscribe\b|^privacy (?:policy|notice)$|^terms (?:and conditions|of (?:use|service))$|^accessibility statement$|^we\b.{0,40}\buse\b.{0,60}\bcookies\b|^all rights reserved|^©|^דלג לתוכן|^לדלג לתוכן|^תפריט$|^חיפוש$|^הצהרת נגישות$|^מדיניות פרטיות$|^תנאי שימוש$|^עוגיות|באתר זה נעשה שימוש בעוגיות|^כל הזכויות שמורות/i;

export function stripBoilerplate(lines) {
  const kept = lines.filter((l) => !BOILERPLATE.test(l));
  if (!kept.length) return lines;
  const size = (ls) => ls.reduce((n, l) => n + l.length, 0);
  // Distrust the filter only when it removed nearly all of a substantial page.
  if (size(lines) > 2000 && size(kept) < size(lines) * 0.15) return lines;
  return kept;
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', deg: '°', euro: '€', pound: '£', shy: '', copy: '©', reg: '®', trade: '™', times: '×', middot: '·', laquo: '«', raquo: '»',
};

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** A page's <title>, decoded. */
export const titleOf = (html) => decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''))?.[1] || '').replace(/\s+/g, ' ').trim());

/**
 * The main part of a page, when it marks one: <main> or <article>. Narrowing to
 * it keeps the menus and related-links lists of a big site out of the evidence.
 */
export function mainHtml(html, selector = null) {
  const s = String(html || '');
  if (selector) {
    const m = new RegExp(`<([a-z0-9]+)[^>]*(?:id|class)=["'][^"']*\\b${selector.replace(/[^a-z0-9_-]/gi, '')}\\b[^"']*["'][^>]*>([\\s\\S]*)`, 'i').exec(s);
    if (m) return m[2];
  }
  return /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s)?.[1] || /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(s)?.[1] || s;
}

// Words a page uses for its own buttons, never content.
const UI = /^(?:הדפס|הדפסה|שלח לחבר|שתף|שיתוף|קרא עוד|לקריאה נוספת|מידע נוסף\.{0,3}|חזרה|לראש העמוד|print|share|read more|more|back|next|previous|close|×)$/i;
const menuLike = (l) => l.length <= 40 && !/\d/.test(l) && !/[.:?!,;]$/.test(l) && !/,/.test(l) && l.split(/\s+/).length <= 6;

/**
 * The part of a stored document worth sending to the model: the document
 * without its menus. Runs of three or more short lines with no number and no
 * punctuation are navigation, a page's own buttons are dropped, repeated lines
 * are kept once, and the rest is cut at a line boundary at maxChars. Only what
 * is sent is narrowed: every quote is still checked against the whole stored
 * text, and every kept line is a line of it.
 */
export function focusText(text, { maxChars = 7000, numbersFirst = false } = {}) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let k = i;
    while (k < lines.length && menuLike(lines[k])) k++;
    if (k - i >= 3) {
      i = k;
      continue;
    }
    for (const end = Math.max(k, i + 1); i < end; i++) {
      const l = lines[i];
      if (UI.test(l) || seen.has(l)) continue;
      seen.add(l);
      out.push(l);
    }
  }
  let size = 0;
  const kept = [];
  if (numbersFirst && out.reduce((n, l) => n + l.length + 1, 0) > maxChars) {
    // A head-to-head or a ranking stands on numbers: when the document is longer
    // than its room, its lines with a number go in first, the rest after, and all
    // in the document's own order.
    const take = new Set();
    for (const pass of [(l) => /\d/.test(l), (l) => !/\d/.test(l)]) {
      for (const [i, l] of out.entries()) {
        if (!pass(l) || size + l.length + 1 > maxChars) continue;
        take.add(i);
        size += l.length + 1;
      }
    }
    return out.filter((_, i) => take.has(i)).join('\n');
  }
  for (const l of out) {
    if (size + l.length + 1 > maxChars) break;
    kept.push(l);
    size += l.length + 1;
  }
  return kept.join('\n');
}

const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * A Markdown table's rows, each labelled with its header: "Model: Claude Opus |
 * Batch input: $2 / MTok". A row quoted alone ("| Claude Opus | $2 | $10 |") did not
 * say which number was which, and a post titled its stats "the first price in the
 * table". Rows whose cells do not match the header stay as they are.
 */
export function labelTables(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (/^\s*\|.*\|\s*$/.test(head) && isRule(lines[i + 1] || '')) {
      const names = cellsOf(head).map((h) => h.replace(/[*_`]/g, '').slice(0, 40));
      out.push(names.join(' | '));
      i += 2;
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        const cells = cellsOf(lines[i]);
        out.push(cells.length === names.length && names.every(Boolean) ? cells.map((c, k) => `${names[k]}: ${c}`).join(' | ') : cells.join(' | '));
      }
      i--;
      continue;
    }
    out.push(head);
  }
  return out.join('\n');
}

/**
 * A page too short to carry a post: a web page that is a site's name and a headline (a magazine's home page read as
 * 89 characters, 2026-11-06) never reaches the outline, which can only refuse it. A feed's item and a data source's
 * table are not pages: a month of climate data is dense in 357 characters.
 */
export const THIN_DOC = 400;

/**
 * Why a read text is not text, or null: a PDF's bytes read as a page, a page read in an encoding it is not written in
 * (a windows-1255 page read as UTF-8 is mostly U+FFFD), or a binary file's control bytes. Each reached the 2026-11-06
 * samples as a document: an education ministry's PDF and a makorrishon.co.il article of 5,607 replacement marks. Pure.
 */
export function unreadable(text) {
  const t = String(text || '');
  if (/^\s*%PDF-/.test(t)) return 'a PDF file read as text';
  const n = Math.max(1, t.length);
  const marks = (t.match(/�/g) || []).length;
  if (marks >= 20 && marks / n > 0.02) return 'text read in an encoding it is not written in';
  // eslint-disable-next-line no-control-regex
  const bytes = (t.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  if (bytes >= 10 && bytes / n > 0.01) return 'the bytes of a file, not text';
  return null;
}
