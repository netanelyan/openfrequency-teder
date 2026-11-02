import { esc, he, sourceLine, two } from '../html.js';
import { depthLabel, ROLE_LABEL } from '../roles.js';
import { KINDS } from '../../formats/kinds.js';
import { actionHtml } from '../end.js';

// A photograph behind every slide, sharp, and the facts on one dark card under it.
//
// Every slide stands on a full-bleed photograph (its own, else the post's) that fades into the theme's dark ground
// at the bottom. A content slide of a numbers post (a ranking, a head-to-head, a list) carries a small label in the
// accent and the account's wordmark on top, a huge title, a meta line, then a rounded card: a label, one giant
// number, a short line, a divider and up to three labelled lines. Any other kind (a story, a guess-who) keeps the
// light version: the photograph, the label, the title and two lines. One accent per account, the theme's dark
// neutrals, and nothing else drawn.
//
// The card is cut from the slide's checked text and nothing else: the number and its label from the slide's
// graphic or from its body's first clause, the line under it from the body's first sentence, the labelled lines
// from the graphic's other items and the body's other sentences. The only words written here are fixed labels of
// the post's structure ("מקום 3", "נתון 2 מתוך 5"), as roles.js writes its own.
//
// Variants (HARD RULE 2: one per account): a, the giant number in white; b, the giant number in the accent;
// c, the labels in the accent and a card with square corners and no border.

const CARD_KINDS = new Set(Object.keys(KINDS).filter((k) => KINDS[k].group === 'number'));

const NUM = /[$€£₪]?\s?\d[\d,.]*\s?(%|₪)?/;
const sentences = (t) => String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
const norm = (t) => String(t || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A value as the card draws it: the number giant, the words before and after it small. */
export function valueParts(value) {
  const t = String(value || '').trim();
  const m = NUM.exec(t);
  if (!m) return { pre: '', num: t, post: '' };
  return { pre: t.slice(0, m.index).trim(), num: m[0].trim(), post: t.slice(m.index + m[0].length).trim() };
}

/** The first clause of a text, when it holds a number: "$1.20 למיליון טוקנים של פלט, התשובה..." gives its first part. */
const leadClause = (t) => {
  const c = String(t || '').split(/[,.](?=\s)/)[0].trim();
  return NUM.test(c) && c.split(/\s+/).length <= 6 ? c : '';
};

/** A text with a value at its start taken off it ("67 מיליון יורו, 56 מיליון פאונד" without "67 מיליון יורו"). */
const without = (text, value) => {
  const t = String(text || '').trim();
  return value && t.startsWith(value) ? t.slice(value.length).replace(/^[\s,:;.–-]+/, '').trim() : t;
};

export const NOTE = 'שווה לדעת';

/**
 * What a content slide's card holds, cut from its own checked text: { label, meta, card } or null for the light
 * version. card: { label, value | sides, sub, sections: [{ label, text }] }.
 */
export function cardOf(s) {
  if (s.kind !== 'item' || !CARD_KINDS.has(s.postKind || 'list')) return null;
  const vis = s.visual && Array.isArray(s.visual.items) ? s.visual : null;
  const items = (vis?.items || []).filter((i) => i && (i.label || i.value));
  const [first, ...more] = items;
  const said = sentences(s.body);
  const subj = s.subject || {};
  const extra = (list) => list.filter((i) => i.label && (i.value || i.value2)).map((i) => ({ label: i.label, text: [i.value, i.value2].filter(Boolean).join(' · ') }));

  if (s.role === 'stat' && (s.a || s.b)) {
    // A head-to-head's stat: both values, each under its side's name. A compare graphic's rows are the lines.
    const rows = vis?.type === 'compare' ? items.filter((i) => i.label).map((i) => ({ label: i.label, text: `${subj.a || ''} ${i.value} · ${subj.b || ''} ${i.value2}`.trim() })) : [];
    const sections = [...rows, ...(said.length ? [{ label: NOTE, text: said.join(' ') }] : [])].slice(0, 3);
    // No meta line: the card already names both sides.
    return { label: `נתון ${s.n} מתוך ${s.of}`, meta: '', card: { label: s.title || '', sides: [{ who: subj.a || '', value: s.a || '' }, { who: subj.b || '', value: s.b || '' }], sub: '', sections } };
  }
  if (s.role === 'verdict' || s.role === 'ranks') return null;

  // A ranking's place, or a list's item: one number.
  const value = (first && /\d/.test(first.value) ? first.value : '') || leadClause(said[0]);
  if (!value) return null;
  const head = vis?.title || '';
  const label = head || (vis?.type === 'stat' ? first?.label || '' : '');
  // The graphic's item label is the meta line when the card already has its own label and it says something else.
  const metaCand = head && first?.label && !norm(first.label).includes(norm(head)) && !norm(head).includes(norm(first.label)) ? first.label : '';
  const sub = said.length ? without(said[0], value) : '';
  const lines = vis?.type === 'stat' ? extra(more) : extra(items.slice(first && first.value === value ? 1 : 0));
  // A sentence that only repeats numbers the card already shows is left out ("בהקשר ארוך הפלט עולה $18.00" under a line for $18.00).
  const shown = [value, ...lines.map((x) => x.text)].join(' ');
  const nums = (t) => t.match(/\d[\d,.]*\d|\d/g) || [];
  const rest = said.slice(1).filter((t) => !nums(t).length || nums(t).some((n) => !shown.includes(n)));
  const sections = [...lines, ...(rest.length ? [{ label: NOTE, text: rest.join(' ') }] : [])].slice(0, 3);
  const place = s.role === 'rank' && s.rank ? `מקום ${s.rank}` : s.of ? `${s.n} מתוך ${s.of}` : '';
  return { label: place, meta: metaCand, card: { label, value, sub, sections } };
}

/** The small label over a light slide: what the role is, in the fixed words roles.js uses. */
export function lightLabel(s) {
  const r = s.role;
  if (r === 'rank' && s.rank) return `מקום ${s.rank}`;
  if (r === 'layer') return depthLabel(s.n, s.of);
  if (r === 'clue') return `רמז ${s.n} מתוך ${s.clues}`;
  if (r === 'case') return `נימוק ${s.n}`;
  if (r === 'ask') return 'דעה';
  if (ROLE_LABEL[r]) return ROLE_LABEL[r];
  return s.of > 1 ? `${s.n} מתוך ${s.of}` : '';
}

/** The account's wordmark: its display name up to the bar ("הספסל | כדורגל" is "הספסל"). */
export const wordmark = (s) => String(s.displayName || s.handle || '').split('|')[0].trim();

const CSS = `
body{background:var(--bg)}
/* The photograph fades into the ground: clear at the top, the theme's own dark under the text. */
.scrim{background:linear-gradient(to top,rgba(var(--bg-rgb),1) 0%,rgba(var(--bg-rgb),.97) 34%,rgba(var(--bg-rgb),var(--scrim,.8)) 56%,rgba(var(--bg-rgb),0) 82%)}
/* A content slide's photograph takes the top of the slide, where the card is not: a face is never behind the facts. */
.k-item .photo{height:60%}
.s-instagram.k-item .photo{height:64%}
.k-item .scrim{background:linear-gradient(to top,rgba(var(--bg-rgb),1) 0%,rgba(var(--bg-rgb),1) 40%,rgba(var(--bg-rgb),var(--scrim,.8)) 58%,rgba(var(--bg-rgb),0) 84%)}
body.has-photo::after{content:'';position:absolute;inset:0 0 auto 0;height:22%;background:linear-gradient(to bottom,rgba(0,0,0,.38),rgba(0,0,0,0));z-index:1}
body.has-photo{--ink:#fff;--muted:rgba(255,255,255,.78)}
.frame{z-index:2;justify-content:flex-end;gap:0}
.top{position:absolute;z-index:3;top:var(--pt);left:var(--pl);right:var(--pr);display:flex;justify-content:space-between;align-items:center;gap:30px}
.lbl{font:700 30px/1.2 var(--text);color:var(--accent);letter-spacing:.06em}
.mark{font:700 30px/1.2 var(--text);color:var(--ink);letter-spacing:.14em;white-space:nowrap}
.hook{font:800 132px/1.02 var(--headline);letter-spacing:-1px;color:var(--ink);max-height:820px;text-wrap:balance}
.s-instagram .hook{font-size:104px;max-height:560px}
.sub{font:700 46px/1.3 var(--text);color:var(--accent);margin-top:34px;max-height:250px}
.s-instagram .sub{font-size:40px;max-height:170px;margin-top:26px}
/* Not .title: the shared graphic styles set a .title smaller on a slide with a graphic, and this one draws none. */
.ptitle{font:800 124px/1.0 var(--headline);letter-spacing:-1px;color:var(--ink);max-height:270px;white-space:pre-line;text-wrap:balance}
.s-instagram .ptitle{font-size:96px;max-height:200px}
.meta{font:400 40px/1.3 var(--text);color:var(--muted);margin-top:18px;max-height:110px}
.s-instagram .meta{font-size:34px;margin-top:12px;max-height:90px}
.dots{display:flex;align-items:center;gap:14px;margin-top:22px;font:700 26px var(--text);color:var(--ink);letter-spacing:.1em}
.dots i{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.22)}
.dots i.on{background:var(--accent);border-color:var(--accent)}
.card{margin-top:40px;background:rgba(var(--bg-rgb),.9);border:2px solid rgba(255,255,255,.10);border-radius:var(--radius);padding:44px 48px 46px;display:flex;flex-direction:column;min-height:0}
.s-instagram .card{margin-top:28px;padding:34px 40px 36px}
.v-c .card{border:0;border-radius:0;background:var(--surface)}
.clbl{font:700 28px/1.2 var(--text);color:var(--accent);letter-spacing:.08em;max-height:72px}
.s-instagram .clbl{font-size:24px}
.big{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 18px;margin-top:14px;color:var(--ink);max-height:250px}
.big b{font:800 168px/1 var(--headline);letter-spacing:-2px;white-space:nowrap;direction:ltr;unicode-bidi:isolate}
.big small{font:700 46px/1.2 var(--text);color:var(--ink)}
.s-instagram .big b{font-size:128px}
.s-instagram .big small{font-size:38px}
.v-b .big b,.v-b .side b{color:var(--accent)}
.sides{display:flex;gap:30px;margin-top:16px}
.side{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.side span{font:700 30px/1.2 var(--text);color:var(--muted)}
.side b{font:800 112px/1 var(--headline);color:var(--ink);letter-spacing:-1px;max-height:240px}
.side b.m{font-size:80px}
.side b.l{font-size:58px}
.s-instagram .side b{font-size:88px}
.s-instagram .side b.m{font-size:64px}
.s-instagram .side b.l{font-size:48px}
.side+.side{padding-inline-start:30px;border-inline-start:2px solid rgba(255,255,255,.12)}
.csub{font:400 38px/1.35 var(--text);color:var(--muted);margin-top:14px;max-height:160px}
.s-instagram .csub{font-size:32px;max-height:130px}
.rule{height:2px;background:rgba(255,255,255,.12);margin:30px 0 6px}
.s-instagram .rule{margin:22px 0 2px}
.sec{margin-top:22px}
.s-instagram .sec{margin-top:14px}
.sec span{display:block;font:700 26px/1.2 var(--text);color:var(--muted);letter-spacing:.1em}
.v-c .sec span{color:var(--accent)}
.sec p{font:400 38px/1.32 var(--text);color:var(--ink);margin-top:6px;max-height:160px}
.s-instagram .sec span{font-size:22px}
.s-instagram .sec p{font-size:31px;max-height:126px}
.foot{display:flex;justify-content:space-between;align-items:flex-end;gap:30px;margin-top:26px}
.foot .src,.foot .note{font:400 25px/1.3 var(--text);color:var(--muted)}
.pg{font:700 28px var(--text);color:var(--muted);letter-spacing:.12em;direction:ltr;margin-inline-start:auto}
.body2{font:400 46px/1.36 var(--text);color:var(--ink);opacity:.92;margin-top:26px;max-height:380px}
.s-instagram .body2{font-size:38px;max-height:250px}
/* The wordmark is on every slide already: the logo the last slide would carry is not drawn. */
.brand{display:none}
.k-closer h2{font:800 112px/1.04 var(--headline);max-height:520px}
/* The last slide: one sentence and the handle, on the photograph. */
.end-line{font:800 104px/1.06 var(--headline);color:var(--ink);max-height:640px;text-wrap:balance}
.s-instagram .end-line{font-size:86px;max-height:440px}
.end-handle{margin-top:36px;font:700 54px var(--text);color:var(--accent)}
.s-instagram .end-handle{font-size:46px}
`;

const top = (label, s) => `<div class="top"><span class="lbl">${he(label)}</span><span class="mark">${he(wordmark(s))}</span></div>`;
const page = (s) => (s.pos ? `<span class="pg">${two((s.pos || 0) + 1)}</span>` : '');
const foot = (s) => `<div class="foot">${sourceLine(s)}${page(s)}</div>`;

const sideSize = (v) => {
  const n = [...String(v || '')].length;
  return n <= 5 ? '' : n <= 9 ? ' m' : ' l';
};

function bigValue(value) {
  const p = valueParts(value);
  return `<div class="big fit">${p.pre ? `<small>${he(p.pre)}</small>` : ''}<b>${he(p.num)}</b>${p.post ? `<small>${he(p.post)}</small>` : ''}</div>`;
}

function cardSlide(s, c) {
  const k = c.card;
  const dots = s.rating && s.rating.of ? `<div class="dots">${s.rating.label ? `<span>${he(s.rating.label)}</span>` : ''}${Array.from({ length: s.rating.of }, (_, i) => `<i class="${i < s.rating.value ? 'on' : ''}"></i>`).join('')}</div>` : '';
  const number = k.sides
    ? `<div class="sides">${k.sides.map((x) => `<div class="side"><span>${he(x.who)}</span><b class="fit${sideSize(x.value)}" dir="auto">${he(x.value)}</b></div>`).join('')}</div>`
    : bigValue(k.value);
  const secs = k.sections.length ? `<div class="rule"></div>${k.sections.map((x) => `<div class="sec"><span>${he(x.label)}</span><p class="fit">${he(x.text)}</p></div>`).join('')}` : '';
  return `${top(c.label, s)}<div class="frame">
<div class="ptitle fit">${he(s.title)}</div>${c.meta ? `<div class="meta fit">${he(c.meta)}</div>` : ''}${dots}
<div class="card">${k.label ? `<div class="clbl fit">${he(k.label)}</div>` : ''}${number}${k.sub ? `<p class="csub fit">${he(k.sub)}</p>` : ''}${secs}</div>
${foot(s)}</div>`;
}

/** The light version: the photograph, the label, the title and two lines. */
function lightSlide(s) {
  const lines = sentences(s.body).slice(0, 2).join(' ');
  return `${top(lightLabel(s), s)}<div class="frame"><div class="ptitle fit">${he(s.title)}</div>${lines ? `<p class="body2 fit">${he(lines)}</p>` : ''}${foot(s)}</div>`;
}

export const photocard = {
  // Every content slide's photograph fills the slide, and a slide without its own stands on the post's.
  fullBleed: true,
  // Every kind is drawn here, the role parts included: the card is this template's own.
  ownsRoles: true,
  css: () => CSS,
  html: (s) => {
    if (s.kind === 'cover') return `<div class="frame"><h1 class="hook fit">${he(s.hook)}</h1>${s.sub ? `<p class="sub fit">${he(s.sub)}</p>` : ''}</div>`;
    if (s.kind === 'item') {
      const c = cardOf(s);
      return c ? cardSlide(s, c) : lightSlide(s);
    }
    return `<div class="frame"><h2 class="fit">${he(s.title)}</h2>${s.body ? `<p class="body2 fit">${he(s.body)}</p>` : ''}</div>`;
  },
  /** The closing slide: the photograph, one sentence and the handle; a post's closing slide, its line and its action. */
  end: (pack, { closing = null, action = null } = {}) => {
    if (closing) return { css: CSS, html: `<div class="frame">${closing.line ? `<div class="end-line fit">${he(closing.line)}</div>` : ''}<div class="end-handle">${actionHtml(action)}</div></div>` };
    const e = pack.meta.endSlide || {};
    const line = e.body || e.title || '';
    return { css: CSS, html: `<div class="frame"><div class="end-line fit">${he(line)}</div><div class="end-handle"><bdi dir="ltr">@${esc(pack.meta.handle)}</bdi></div></div>` };
  },
};
