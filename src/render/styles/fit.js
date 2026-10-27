import { readFileSync } from 'node:fs';
import { STYLES } from './tokens.js';
import { displayText, highlightIn, slideModel } from './model.js';
import { zonesFor } from '../../rules/overlay.js';
import { LIMITS } from '../../voice/tells.js';

// Does a text fit its style, before anything is rendered?
//
// Each style sets a headline at a size, in at most so many lines, and may set it smaller, in steps, down to a floor,
// before it takes another line. A headline that still takes too many lines at the floor is the writer's to shorten:
// a check here, in code, sends it back through the repair loop (src/pipeline/repair.js) with the numbers, instead of
// a render that fails after every other check has passed.
//
// The widths come from the bundled faces, measured once in the browser (scripts/style-metrics.js); a line is broken
// where the browser breaks it (between words, never inside the words displayText holds together). The renderer
// measures again, on the real page, and refuses what still does not fit (src/render/render.js): this is the early
// answer, within a few percent of it.

const WIDTHS = JSON.parse(readFileSync(new URL('./metrics.json', import.meta.url), 'utf8'));

/** The step a headline is set smaller by, in px at 1080 wide. */
export const STEP = 4;
/** A text with no floor of its own (a body) may be set this much smaller before it takes another line. */
export const BODY_FLOOR = 0.85;

const W = 1080;
const H = { tiktok: 1920, instagram: 1350 };
const SIZE_SCALE = { tiktok: 1, instagram: 0.85 };

/** The width of one string in a face at a size, in px. */
export function widthOf(str, face, px, tracking = 0) {
  const table = WIDTHS[face] || WIDTHS['Rubik 400'];
  const avg = table['ה'] || 50;
  let w = 0;
  for (const ch of str) w += (table[ch] ?? avg) + tracking * (100 / px);
  return (w * px) / 100;
}

/** How many lines one display line takes in a box: Infinity when a word held together is wider than the box. */
export function wrapCount(line, box, face, px, tracking = 0) {
  const space = widthOf(' ', face, px, tracking);
  let n = 1;
  let at = 0;
  for (const w of line.split(' ').filter(Boolean)) {
    const ww = widthOf(w, face, px, tracking);
    if (ww > box + 1) return Infinity;
    if (at === 0) at = ww;
    else if (at + space + ww <= box + 1) at += space + ww;
    else {
      n++;
      at = ww;
    }
  }
  return n;
}

const linesAt = (text, box, face, px, tracking) => text.split('\n').reduce((n, l) => n + wrapCount(l, box, face, px, tracking), 0);

/**
 * One text in one spec of a style: { ok, px, lines, want, max, chars }. The text is set at the spec's size; while it
 * takes more lines than the writer's (or than the style allows) it is set a step smaller, down to its floor; at the
 * floor it may take more lines than the writer's, never more than the style's. `chars`: about how many characters
 * the style's lines hold at the floor, for the writer.
 */
export function fitText(text, spec, { box, scale = 1 }) {
  const face = `${spec.family} ${spec.weight}`;
  const breaks = spec.breaks !== false;
  // As the renderer sets it: a number held to the word it counts (render.js), the last two words held together.
  const held = displayText(text, { breaks }).replace(/(\d) (?=[א-ת])/g, '$1 ');
  if (!held) return { ok: true, px: spec.px * scale, lines: 0, want: 0, max: spec.lines, chars: 0 };
  const writer = held.split('\n').length;
  const max = spec.lines || 99;
  const want = breaks ? Math.min(writer, max) : max;
  const base = spec.px * scale;
  const floor = (spec.floor || spec.px * BODY_FLOOR) * scale;
  const set = (t) => {
    let px = base;
    let lines = linesAt(t, box, face, px, spec.tracking || 0);
    while (lines > want && px > floor) {
      px = Math.max(floor, px - STEP * scale);
      lines = linesAt(t, box, face, px, spec.tracking || 0);
    }
    return { px, lines };
  };
  // Words are held together only where they fit: a pair wider than the slide at the floor ("ב-23 במרץ 1988" in a
  // poster's headline) breaks like any other words, as the renderer lets it, rather than refusing a text the writer
  // could never fix.
  let r = set(held);
  if (r.lines === Infinity) r = set(held.replace(/ /g, ' '));
  const chars = Math.floor((max * box) / widthOf('ה', face, floor, spec.tracking || 0) * 0.92);
  return { ok: r.lines <= max, px: Math.round(r.px), lines: r.lines, want, max, chars };
}

/** The width a style's text has on one platform: the slide less its side bands, less a card's inset. */
export function boxFor(spec, size = 'tiktok', overlay = null, style = null) {
  const z = sidesOf(zonesFor(size, overlay, H[size]), STYLES[style], size);
  return W - z.left - z.right - (spec.inset || 0) - (spec.mark ? 2 * spec.mark : 0);
}

/** A style's own side bands, where it sets them (E's), in place of the shared ones. */
export const sidesOf = (z, S, size) => (S?.sides?.[size] ? { ...z, left: S.sides[size], right: S.sides[size] } : z);

const SPOKEN = { hook: 'the cover line', sub: 'the line under the cover', title: 'the title', ntitle: 'the title', body: 'the text', tbody: 'the text' };

/**
 * Every text of a draft too long for the style it will be drawn in, as check problems ({ where, code: 'fit', msg }),
 * and every highlight that is not one short phrase of its own headline. `style`: the style's name; none, none.
 */
export function styleFitProblems(draft, { style, platforms = ['tiktok'], overlay = null, places = null, postKind = 'list' } = {}) {
  const S = STYLES[style];
  if (!S) return [];
  const size = platforms.includes('tiktok') ? 'tiktok' : 'instagram';
  const scale = SIZE_SCALE[size];
  const out = [];
  const add = (where, field, text, r) =>
    out.push({ where, code: 'fit', msg: `${SPOKEN[field]} is too long for this account's style: ${r.lines === Infinity ? 'a word in it is wider than the slide' : `${r.lines} lines`} even at ${Math.round((S.text[field].floor || S.text[field].px * BODY_FLOOR) * scale)}px, the smallest it is set, and the style allows ${r.max}. Shorten it to about ${r.chars} characters` });
  const check = (where, field, text, highlight = '') => {
    const spec = S.text[field];
    if (!text || !spec) return;
    // A highlight block is wider than its words by its padding: measured on a narrower box, the line it is on fits.
    const box = boxFor({ ...spec, mark: highlight && highlightIn(text, highlight) ? spec.mark : 0 }, size, overlay, style);
    const r = fitText(text, spec, { box, scale: field === 'hook' || field === 'title' || field === 'ntitle' ? scale : 1 });
    if (!r.ok) add(where, field, text, r);
  };
  draft.slides.forEach((s0, i) => {
    const s = { ...s0, ...(places?.[i] || {}), postKind, hook: draft.hook, sub: draft.sub, subject: draft.subject || {} };
    const m = slideModel(s);
    // A style that sets a ranking's place before its title (E) has the title's first line that much shorter.
    const title = S.rank && m.rank && m.title ? `${m.rank}. ${m.title}` : m.title;
    if (m.kind === 'cover') {
      check('cover', 'hook', m.hook, m.highlight);
      check('cover line 2', 'sub', m.sub);
    } else if (m.kind === 'number') {
      check(`slide ${i} title`, 'ntitle', title, m.highlight);
      check(`slide ${i} text`, 'body', m.body);
    } else if (s.kind === 'item' && !m.list) {
      check(`slide ${i} title`, 'title', title, m.highlight);
      check(`slide ${i} text`, 'tbody', m.body);
    }
  });
  return [...out, ...highlightProblems(draft)];
}

/** A highlight is one word or a short phrase of its slide's own headline, or nothing. */
export function highlightProblems(draft) {
  const out = [];
  draft.slides.forEach((s, i) => {
    const h = String(s.highlight || '').trim();
    if (!h) return;
    const head = s.kind === 'cover' ? draft.hook : s.title;
    const where = s.kind === 'cover' ? 'cover' : `slide ${i} title`;
    const n = h.split(/\s+/).length;
    if (!highlightIn(head, h)) out.push({ where, code: 'fit', msg: `the highlight "${h}" is not words of ${s.kind === 'cover' ? 'the cover line' : 'the title'}: it marks words already there, copied exactly, or is ""` });
    else if (n > 3 || [...h].length > 24) out.push({ where, code: 'fit', msg: `the highlight "${h}" is ${n} words: one word or a short phrase (up to 3 words), or ""` });
    else if (h.replace(/\s+/g, ' ') === String(head || '').replace(/\s+/g, ' ').trim()) out.push({ where, code: 'fit', msg: 'the highlight is the whole headline: it marks one word or a short phrase in it' });
  });
  return out;
}

/** What a writer is told about a style's room, one line: about how many characters each text holds. */
export function styleRoom(style, { platforms = ['tiktok'] } = {}) {
  const S = STYLES[style];
  if (!S) return '';
  const size = platforms.includes('tiktok') ? 'tiktok' : 'instagram';
  // Never more than the voice allows a cover or a title (LIMITS): E's room is 77 characters a title, the voice's 60,
  // and a writer told 77 wrote 67 and went back to be cut, slide after slide.
  const cap = { hook: LIMITS.cover.maxChars, title: LIMITS.slideTitle.maxChars };
  const room = (field, scale = 1) => Math.min(cap[field] || Infinity, fitText('ה', S.text[field], { box: boxFor(S.text[field], size, null, style), scale }).chars);
  const sc = SIZE_SCALE[size];
  return `STYLE ${S.name}: this account's slides are drawn large. The cover line holds about ${room('hook', sc)} characters (${S.text.hook.lines} lines at most), the line under it about ${room('sub')}; a slide's title about ${room('title', sc)}; a slide's text about ${room('tbody')} characters, and on a slide whose point is a number about ${room('body')} beside the number. A longer text is sent back to be shortened.`;
}
