import { normHe } from '../voice/tells.js';

// The text that sits on a slide, as a reader meets it over a picture: short
// lines broken by hand, a few of them, reactions rather than labels, clear of
// the platform's own furniture, and outlined so any picture behind it reads.
//
//   wordsPerLine   [min, max] words on a line. A text block's last line may be
//                  shorter (the punch: "ואיך הוא חזר"); every other line is in range
//   linesPerSlide  [min, max] lines on a slide: the cover's line and the line
//                  under it, or a slide's title and body, counted together
//   safeZone       the share of the slide's height at the top and at the bottom
//                  where no text goes (TikTok's tabs; its caption and buttons)
//   outline        the outline around text over a picture, in em of the text's
//                  own size (drawn under the letters, so half of it shows)
//   labels         more words that are labels in this account's niche, never a
//                  title on their own
//
// Each pack may set any of them in pack.json "overlay"; these are the defaults.
// The line breaks are the writer's: the model is asked for them, and a block
// that comes without them is broken here, in code, at the best places (after a
// comma or a full stop, never between a number and what it counts), so no
// model call is spent on a missing newline. What code cannot fix (a slide with
// too many words, a line too short, a label) is a problem the redraft is told.
//
// A body that is a list (places 10 to 6, an iceberg's layer) is one item a
// line by its kind's design: it is neither broken nor counted here, and its
// kind's own check bounds it.

export const OVERLAY = {
  wordsPerLine: [4, 6],
  linesPerSlide: [3, 4],
  safeZone: { top: 0.1, bottom: 0.2 },
  outline: 0.12,
  labels: [],
};

/**
 * The bands of a slide drawn in a style (src/render/styles) that hold no text, in px, per platform. TikTok mirrors
 * its own furniture in Hebrew (the button rail moves to the left, the caption's start to the right), so both sides
 * are kept clear, as well as the tabs on top and the caption, the account and the sound at the bottom. Instagram's
 * 4:5 crop has only its own edges to keep. An account that keeps a wider band (overlay.safeZone) gets the wider one.
 * TikTok's own furniture, measured on a 1080x1920 slide (2026): the status bar and the "Following | For You" tabs take
 * the top 220 px, the account, the caption and the sound the bottom 450 to 480, and the column of buttons some 180 px
 * of one side from 840 px down. The owner saw a slide's words and its face under them: the bands are those now.
 */
export const SAFE_ZONES = {
  tiktok: { top: 220, bottom: 470, right: 160, left: 160 },
  instagram: { top: 80, bottom: 120, right: 96, left: 96 },
};

/** The bands kept clear on one platform for a styled slide: the platform's, widened where the account asks for more. */
export function zonesFor(size, overlay = null, h = size === 'instagram' ? 1350 : 1920) {
  const z = { ...SAFE_ZONES[size] };
  const own = overlay?.safeZone || {};
  // Only a band the account set itself widens it: the shared default (OVERLAY.safeZone) is the older templates'.
  for (const k of ['top', 'bottom']) if (Number.isFinite(own[k]) && own[k] !== OVERLAY.safeZone[k]) z[k] = Math.max(z[k], Math.ceil(own[k] * h));
  return z;
}

/** Roles whose body lines are items, one a line. */
export const LIST_ROLES = new Set(['ranks', 'layer']);

/** The overlay rules for one pack: the defaults, with whatever pack.json "overlay" sets. */
export function overlayOf(pack = null) {
  const own = pack?.meta?.overlay || {};
  return {
    ...OVERLAY,
    ...own,
    safeZone: { ...OVERLAY.safeZone, ...(own.safeZone || {}) },
    labels: [...OVERLAY.labels, ...(own.labels || [])],
  };
}

/** What is wrong with a pack.json "overlay", one line each. */
export function overlayConfigProblems(o) {
  if (o === undefined) return [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['pack.json: overlay must be an object'];
  const p = [];
  const range = (k, lo, hi) => {
    const v = o[k];
    if (v === undefined) return;
    if (!(Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= lo && n <= hi) && v[0] <= v[1])) p.push(`pack.json: overlay.${k} is [min, max], whole numbers from ${lo} to ${hi}`);
  };
  range('wordsPerLine', 1, 12);
  range('linesPerSlide', 1, 8);
  const z = o.safeZone;
  if (z !== undefined) {
    const ok = (n) => n === undefined || (Number.isFinite(n) && n >= 0 && n <= 0.4);
    if (!z || typeof z !== 'object' || !ok(z.top) || !ok(z.bottom)) p.push('pack.json: overlay.safeZone is { top, bottom }, each a share of the slide from 0 to 0.4');
  }
  if (o.outline !== undefined && !(Number.isFinite(o.outline) && o.outline >= 0.04 && o.outline <= 0.3)) p.push('pack.json: overlay.outline is the outline in em, from 0.04 to 0.3');
  if (o.labels !== undefined && !(Array.isArray(o.labels) && o.labels.every((w) => typeof w === 'string' && w.trim()))) p.push('pack.json: overlay.labels is a list of words');
  for (const k of Object.keys(o)) if (!(k in OVERLAY)) p.push(`pack.json: overlay.${k} is not an overlay rule (${Object.keys(OVERLAY).join(', ')})`);
  return p;
}

/** The words of a line, as a reader counts them: a dash or an emoji on its own is not a word. */
export const wordsOf = (line) => String(line || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** A slide's text as one line, for where the slide's breaks mean nothing: a caption, a post's title on the platform. */
export const oneLine = (text) => String(text || '').replace(/\s*\n\s*/g, ' ').trim();

/** The lines of a text block, as written. */
export const linesOf = (text) => String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * One line too long for its rule, broken into lines of [min, max] words: as few
 * lines as it can be, then the breaks where a reader pauses (after a comma or a
 * full stop), never between a number and the word it counts, and lines of even
 * length. Only the last line may come out under min. Pure.
 */
export function breakLine(line, [min, max]) {
  const words = wordsForBreak(line);
  const n = words.length;
  if (n <= max) return [words.join(' ')];
  const goal = n / Math.ceil(n / max);
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - max); j < i; j++) {
      if (best[j] === Infinity) continue;
      const len = i - j;
      const last = i === n;
      if (len < min && !last) continue;
      let cost = best[j] + 100 + (len - goal) ** 2;
      if (last && len < min) cost += 6;
      if (!last) cost += breakCost(words, i);
      if (cost < best[i]) {
        best[i] = cost;
        from[i] = j;
      }
    }
  }
  if (best[n] === Infinity) return [words.join(' ')];
  const out = [];
  for (let i = n; i > 0; i = from[i]) out.unshift(words.slice(from[i], i).join(' '));
  return out;
}

/**
 * A line's words broken into exactly k lines of [min, max] words, or null when they do not fit. Only the last line
 * may come out under min, and never as one word alone. The breaks go where breakLine puts them. Pure.
 */
export function breakInto(line, [min, max], k) {
  const words = wordsForBreak(line);
  const n = words.length;
  if (k === 1) return n <= max ? [words.join(' ')] : null;
  if (n < min * (k - 1) + 2 || n > max * k) return null;
  const goal = n / k;
  // best[c][i]: the cheapest c lines that end after word i.
  const best = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const from = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(-1));
  best[0][0] = 0;
  for (let c = 1; c <= k; c++) {
    for (let i = 1; i <= n; i++) {
      const last = c === k;
      if (last && i !== n) continue;
      for (let j = Math.max(0, i - max); j < i; j++) {
        if (best[c - 1][j] === Infinity) continue;
        const len = i - j;
        if (last ? len < 2 : len < min) continue;
        let cost = best[c - 1][j] + (len - goal) ** 2;
        if (!last) cost += breakCost(words, i);
        if (cost < best[c][i]) {
          best[c][i] = cost;
          from[c][i] = j;
        }
      }
    }
  }
  if (best[k][n] === Infinity) return null;
  const out = [];
  for (let c = k, i = n; c > 0; i = from[c][i], c--) out.unshift(words.slice(from[c][i], i).join(' '));
  return out;
}

// A dash or an emoji standing alone rides with the word before it, so it never starts a line.
function wordsForBreak(line) {
  const words = [];
  for (const t of String(line).trim().split(/\s+/).filter(Boolean)) {
    if (!/[\p{L}\p{N}]/u.test(t) && words.length) words[words.length - 1] += ` ${t}`;
    else words.push(t);
  }
  return words;
}

// What a break after word i costs: dear where a reader does not pause; dearer than a line more between a number and
// what it counts ("ל-10" at a line's end and "מתוך 12" at the next one's start reads as two numbers).
function breakCost(words, i) {
  const end = words[i - 1];
  return (/[,.;:!?…]$/.test(end) ? 0 : 4) + (/\d$/.test(end) && /^[\p{L}]/u.test(words[i]) ? 150 : 0);
}

/**
 * A block with every overlong line broken. Lines the writer broke are kept as they are while they keep the rule;
 * a block with a line under min before its last is broken again as a whole: in as many lines when its words fit
 * them, else in as few as breakLine makes.
 */
export function breakBlock(text, range) {
  const lines = linesOf(text).flatMap((l) => (wordsOf(l).length > range[1] ? breakLine(l, range) : [l]));
  if (lines.slice(0, -1).every((l) => wordsOf(l).length >= range[0])) return lines.join('\n');
  const all = lines.join(' ');
  return (breakInto(all, range, lines.length) || breakLine(all, range)).join('\n');
}

/** The overlay blocks of a draft, per slide: [{ slide, where, blocks: [{ where, get, set }] }]. */
function slidesOf(draft) {
  const out = [{ slide: 0, where: 'cover', list: false, blocks: [
    { where: 'cover', get: () => draft.hook, set: (v) => (draft.hook = v) },
    { where: 'cover line 2', get: () => draft.sub, set: (v) => (draft.sub = v) },
  ] }];
  draft.slides.forEach((s, i) => {
    if (s.kind !== 'item') return;
    out.push({ slide: i, where: `slide ${i}`, list: LIST_ROLES.has(s.role), blocks: [
      { where: `slide ${i} title`, title: true, get: () => s.title, set: (v) => (s.title = v) },
      { where: `slide ${i} text`, body: true, get: () => s.body, set: (v) => (s.body = v) },
    ] });
  });
  return out;
}

/** Break, in code, every overlay line the writer left too long. In place; returns what changed. */
export function lineDraft(draft, pack = null) {
  const { wordsPerLine } = overlayOf(pack);
  const out = [];
  // A highlight marks words of its headline: one whose words a rewrite or an edit took out is dropped, not checked.
  const flatWs = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  (draft.slides || []).forEach((s, i) => {
    const head = s.kind === 'cover' ? draft.hook : s.title;
    if (s.highlight && !flatWs(head).includes(flatWs(s.highlight))) {
      s.highlight = '';
      out.push(`${s.kind === 'cover' ? 'cover' : `slide ${i}`}: highlight dropped, its words are no longer in the headline`);
    }
  });
  for (const sl of slidesOf(draft)) {
    for (const b of sl.blocks) {
      if (sl.list && b.body) continue;
      const before = String(b.get() || '');
      if (!before.trim()) continue;
      const after = breakBlock(before, wordsPerLine);
      if (after !== before.trim()) {
        b.set(after);
        out.push(`${b.where}: line breaks`);
      }
    }
  }
  return out;
}

// A label names a part of the post instead of saying something about it: "טיפ 3", "עובדה:", "שלב שני", "התפנית".
const ORDINAL = '(?:#?\\d+|מס[\'׳]?\\s*\\d+|מספר\\s*\\d+|ראשון|ראשונה|שני|שנייה|שלישי|שלישית|רביעי|רביעית|חמישי|חמישית|אחרון|אחרונה)';
const LABEL_WORDS = [
  'טיפ', 'שלב', 'עובדה', 'מיתוס', 'סיבה', 'חלק', 'טעות', 'כלל', 'נקודה', 'פרק', 'רמז', 'נימוק', 'נתון', 'מקום', 'שכבה', 'בדיחה',
  'רקע', 'הרגע', 'התפנית', 'הסוף', 'התשובה', 'אחרי', 'השורה התחתונה', 'סיכום', 'מבוא', 'הקדמה', 'לסיכום', 'בונוס',
  'step', 'tip', 'fact', 'myth', 'reason', 'part', 'rule', 'mistake', 'bonus', 'summary', 'intro',
];
const flat = (s) => normHe(String(s || '')).toLowerCase().replace(/[^\p{L}\p{N}#\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Why a line reads as a label, or null. `extra`: the pack's own label words. */
export function labelIn(line, extra = []) {
  const s = String(line || '').trim();
  if (!s) return null;
  if (/^(?:#|מס['׳]?\s*)?\d+[.)]?$/.test(s)) return 'a number on its own';
  const words = [...LABEL_WORDS, ...extra].map(flat).filter(Boolean);
  const f = flat(s);
  for (const w of words) {
    if (new RegExp(`^(?:ה)?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+${ORDINAL})?$`, 'u').test(f)) return `"${s}" names the part, it does not react to it`;
  }
  // "עובדה: ...", "טיפ 3: ...": a heading glued to the front of the line.
  const head = /^([^\s:]{2,14}(?:\s+[^\s:]{1,14})?)\s*:\s+\S/u.exec(s);
  if (head && words.some((w) => new RegExp(`^(?:ה)?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+${ORDINAL})?$`, 'u').test(flat(head[1])))) return `"${head[1]}:" is a label in front of the line`;
  return null;
}

/**
 * Every way a draft's slide text breaks the overlay rules, as [{ where, code, msg }].
 * Run after lineDraft, so what is left is what a writer must change.
 */
export function overlayProblems(draft, pack = null) {
  const o = overlayOf(pack);
  const [minW0, maxW] = o.wordsPerLine;
  const [minL0, maxL] = o.linesPerSlide;
  // A post drawn in a slide style (src/render/styles) sets its headlines far larger than text over a picture: a line
  // holds a few words, and the style bounds the length itself (its fit check). Only the maximums apply to it.
  const minW = draft.style ? 1 : minW0;
  const minL = draft.style ? 1 : minL0;
  const out = [];
  const add = (where, msg) => out.push({ where, code: 'overlay', msg });
  for (const sl of slidesOf(draft)) {
    let count = 0;
    for (const b of sl.blocks) {
      const text = String(b.get() || '');
      const lines = linesOf(text);
      if (sl.list && b.body) continue;
      count += lines.length;
      lines.forEach((l, k) => {
        const n = wordsOf(l).length;
        if (n > maxW) add(b.where, `line ${k + 1} has ${n} words: at most ${maxW} a line, broken by hand`);
        else if (n < minW && k < lines.length - 1) add(b.where, `line ${k + 1} has ${n} words: at least ${minW} a line (only the last line may be shorter)`);
      });
      // A title is a reaction a person would say, never the name of the part ("טיפ 3", "התפנית").
      if (b.title || sl.slide === 0) for (const l of lines) {
        const why = labelIn(l, o.labels);
        if (why) add(b.where, `a label, not a reaction: ${why}`);
      } else for (const l of lines) {
        const why = /:\s+\S/.test(l) ? labelIn(l, o.labels) : null;
        if (why) add(b.where, `a label, not a reaction: ${why}`);
      }
    }
    if (sl.list) continue;
    if (count > maxL) add(sl.where, `${count} lines of text: at most ${maxL} on a slide (title and text together)`);
    else if (count < minL) add(sl.where, `${count === 1 ? 'one line' : `${count} lines`} of text: at least ${minL} on a slide (title and text together)`);
  }
  return out;
}
