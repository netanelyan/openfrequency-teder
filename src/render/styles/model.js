import { esc, he } from '../html.js';
import { cardOf, lightLabel, NOTE, valueParts } from '../templates/photocard.js';
import { LIST_ROLES } from '../../rules/overlay.js';

// What a slide shows in a style, cut from its checked text and nothing else: the same model for the renderer
// (index.js) and for the check that the text fits before anything is rendered (fit.js), so the two measure the
// same words.
//
// A content slide is a number slide or a text slide. A number slide is one whose point is a number, a price or a
// stat: a numbers post's place or item with a value (photocard's card, src/render/templates/photocard.js), a
// head-to-head's two values, or any slide whose graphic is one stat. Every other slide is a title and its text.

const LATIN = /^[A-Za-zÀ-ɏ0-9$€£%.,:;'’\-–/()&+#_!?]+$/;
const isLatin = (w) => LATIN.test(w) && /[A-Za-zÀ-ɏ]/.test(w);
const NBSP = ' ';
const words = (l) => l.split(' ').filter(Boolean);

/**
 * A text as a style sets it: the writer's lines (when the style keeps them), a one-word last line joined to the
 * line before it, and in every line the last two words held together, so no line ends with one word alone. A mark
 * on its own ("–") stays with the word before it. Two Latin words are never held: the space keeps them one run.
 */
export function displayText(text, { breaks = true } = {}) {
  let lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!breaks) lines = lines.length ? [lines.join(' ')] : [];
  if (lines.length > 1 && words(lines.at(-1)).length === 1) lines = [...lines.slice(0, -2), `${lines.at(-2)} ${lines.at(-1)}`];
  return lines
    .map((l) => {
      const w = words(l);
      const out = [];
      for (const x of w) {
        if (out.length && !/[\p{L}\p{N}]/u.test(x)) out[out.length - 1] += NBSP + x;
        else out.push(x);
      }
      if (out.length >= 2 && !(isLatin(out.at(-1)) && isLatin(out.at(-2)))) out.splice(-2, 2, `${out.at(-2)}${NBSP}${out.at(-1)}`);
      return out.join(' ');
    })
    .join('\n');
}

const pattern = (phrase) => new RegExp(String(phrase).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\u00A0]+'), 'u');

/**
 * The words of a closing line that name the product or the store (`names`, the product's first), as the line writes
 * them: the whole name, else its first two words, else its first, with a prefix written onto it ("בעציץ ושמש"), whole
 * words only, one short phrase (3 words and 24 characters at most, as any highlight). '' when the line names neither:
 * the mark is the line's own words, never a word added.
 */
export function closingMark(line, names = []) {
  const t = String(line || '');
  for (const name of names) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    for (const k of [...new Set([w.length, 2, 1])]) {
      if (k < 1 || k > w.length) continue;
      const phrase = w.slice(0, k).join(' ');
      if ([...phrase].length < 3) continue;
      const m = pattern(phrase).exec(t);
      if (!m) continue;
      let start = m.index;
      const end = m.index + m[0].length;
      for (let p = 0; p < 2 && start > 0 && /[ובלמשהכ]/.test(t[start - 1]); p++) start--;
      if ((start > 0 && /[\p{L}\p{N}]/u.test(t[start - 1])) || (end < t.length && /[\p{L}\p{N}]/u.test(t[end]))) continue;
      const mark = t.slice(start, end);
      if ([...mark].length <= 24 && mark.split(/\s+/).length <= 3) return mark;
    }
  }
  return '';
}

/** Is the highlight a phrase of the text? Only then is it drawn: it marks the checked words, it never adds any. */
export const highlightIn = (text, phrase) => Boolean(String(phrase || '').trim()) && pattern(phrase).test(String(text || '').replace(/\s+/g, ' '));

/** A text as HTML: displayText, isolated for bidi (he), and its highlight, the first time it occurs, in a mark. */
export function textHtml(text, { breaks = true, highlight = '' } = {}) {
  const t = displayText(text, { breaks });
  const m = highlight && String(highlight).trim() ? pattern(highlight).exec(t) : null;
  if (!m) return he(t);
  return `${he(t.slice(0, m.index))}<mark class="hi">${he(m[0])}</mark>${he(t.slice(m.index + m[0].length))}`;
}

const sentences = (t) => String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);

/** The number a slide is about, or null: { label, kicker, value: { pre, num, post } | null, sides | null, meta, body }. */
export function numberOf(s) {
  if (s.kind !== 'item') return null;
  const c = cardOf(s);
  if (c?.card.sides) {
    const note = c.card.sections.filter((x) => x.label === NOTE).map((x) => x.text).join(' ');
    return { label: c.label, kicker: '', value: null, sides: c.card.sides, meta: '', body: note };
  }
  if (c?.card.value) {
    const k = c.card;
    const lines = k.sections.filter((x) => x.label !== NOTE).map((x) => `${x.label} ${x.text}`);
    const note = k.sections.filter((x) => x.label === NOTE).map((x) => x.text);
    return { label: c.label, kicker: k.label, value: valueParts(k.value), sides: null, meta: [c.meta, ...lines].filter(Boolean).join(' · '), body: [k.sub, ...note].filter(Boolean).join(' ') };
  }
  // A slide of any other kind whose graphic is one stat with a number is a number slide too.
  const v = s.visual && !s.visual.bad && s.visual.type === 'stat' ? s.visual : null;
  const first = v?.items?.find((i) => i && /\d/.test(i.value || ''));
  if (first) return { label: lightLabel(s), kicker: v.title || first.label || '', value: valueParts(first.value), sides: null, meta: '', body: s.body || '' };
  return null;
}

/**
 * What one slide shows: { kind: 'cover'|'number'|'text'|'end', ... }, each text with the field it came from, so a
 * check can say which one is too long ("cover", "slide 3 title").
 */
export function slideModel(s) {
  if (s.kind === 'cover') {
    return { kind: 'cover', hook: s.hook || '', sub: s.sub || '', highlight: s.highlight || '', key: s.keyLine || '' };
  }
  // The closing slide: the account's own follow slide, or a post's closing slide (its line, this platform's action, the
  // account's logo, and the product's or the store's name where the line says it, for a style that marks it).
  if (s.kind === 'end') return { kind: 'end', title: s.title || '', body: s.body || '', handle: s.handle || '', ...(s.closing ? { closing: true, action: s.action || null, logo: s.logo || null, mark: closingMark(s.title, s.names || []) } : {}) };
  const cta = s.isLast && s.cta?.text ? s.cta.text : '';
  if (s.kind === 'item') {
    // A ranking's place, as a number: the one label of a post's structure style E draws, before the title ("5.").
    // A facts post counts down the same way, to its best fact as "1." (every viral countdown: "5. Yoel Romero was
    // never champion" ... "1. Khabib never bled").
    // A tips post numbers its tips from one, as the saved lists do ("1. Expertise Accelerator").
    const rank = s.role === 'rank' && s.rank ? String(s.rank) : s.role === 'fact' && s.postKind === 'facts' && s.of && s.n ? String(s.of - s.n + 1) : s.role === 'tip' && s.postKind === 'tips' && s.n ? String(s.n) : '';
    const n = numberOf(s);
    if (n) return { kind: 'number', ...n, title: s.title || '', highlight: s.highlight || '', cta, rank };
    const vis = s.visual && !s.visual.bad && s.role !== 'stat' ? s.visual : null;
    return { kind: 'text', label: lightLabel(s), title: s.title || '', highlight: s.highlight || '', body: s.body || '', list: LIST_ROLES.has(s.role), visual: vis, cta, rank };
  }
  // A list post's closing slide: its title and its line.
  return { kind: 'text', label: '', title: s.title || '', highlight: '', body: s.body || '', list: false, visual: null, cta: '', rank: '' };
}

/** "מקור: X" under a slide, when the account shows its sources, from its facts' sources. */
export function sourcesOf(s) {
  if (s.noSources) return '';
  const names = [...new Set((s.sources || []).filter(Boolean).map(unentity))];
  return names.length ? `מקור: ${names.map((n) => `<bdi dir="auto">${esc(n)}</bdi>`).join(' · ')}` : '';
}

// A feed's name as its feed wrote it, entities and all ("My Jewish Learning &raquo; Feed"): read as the letters they are
// before it is escaped for the slide, so the slide never shows "&raquo;".
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', raquo: '»', laquo: '«', ndash: '–', mdash: '—', hellip: '…' };
const unentity = (t) => String(t).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(n) && n > 31 ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

export { sentences };
