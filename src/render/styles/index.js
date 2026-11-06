import { esc, he } from '../html.js';
import { fontFaces, headlineFaces } from '../fonts.js';
import { bestInk, contrast, rgbList } from '../color.js';
import { VISUAL_CSS, visualHtml } from '../visuals.js';
import { zonesFor } from '../../rules/overlay.js';
import { familiesOf, resolveStyle, STYLES, themeColors } from './tokens.js';
import { displayText, slideModel, sourcesOf, textHtml } from './model.js';
import { BODY_FLOOR, sidesOf, STEP } from './fit.js';
import { actionHtml } from '../end.js';
import { calmRoom } from '../crop.js';
import { LAYOUTS, textureCss } from '../textures.js';

// The five slide styles, drawn (tokens.js has what each one sets, model.js what each slide shows).
//
// A styled slide is its own page, not a template inside the shared one (html.js): none of the shared furniture
// comes with it. No progress bar, counter, dots or ghost numeral, no handle on a slide (TikTok draws its own), and no
// blurred photograph: a slide with no photograph of its own stands on the style's solid ground, its text moved up.
// In A to D no letter has an outline or a shadow either: legibility comes from where the text sits, on the ground, on
// a card, under a fade into the ground, or over a flat dark layer.
//
// E is the one exception, on purpose: its text over a photograph is drawn as TikTok's own text tool draws it, and
// that tool's plain text is white with a thin dark edge (the "shadow" look; the "box" look, the default, is the tool's
// white box behind each line and has none). A native slideshow looks like that; text that copies it without the edge
// reads as a template's. The edge is thin and drawn under the letters (paint-order), never a glow or an outline
// around a block, and only on E's own lines: every other letter of every style still has none.
//
// Every block of text is placed at the style's own position and kept out of the safe zones on all four sides
// (src/rules/overlay.js SAFE_ZONES). The renderer (src/render/render.js) then fits it: a headline is set smaller in
// steps to its floor before it takes another line, a block too tall for its room moves up where the style lets it
// (C and D, over their photograph's fade or by a shorter photograph), and what still does not fit is refused.

/** An account's look, with its style when it has one: what the renderer and the lock (src/render/style.js) take. */
export function themeOf(pack, name = null) {
  const spec = name ? { ...(pack.meta?.style || {}), name } : pack.meta?.style;
  if (!spec?.name || !STYLES[spec.name]) return pack.theme;
  const style = resolveStyle(spec, pack.theme?.colors?.accent);
  return { ...pack.theme, style: { name: style.name, colors: style.colors, ...(style.text ? { text: style.text } : {}) } };
}

/** The style a pack draws in, by name, or null for the older templates. */
export const styleNameOf = (pack) => (pack?.meta?.style?.name && STYLES[pack.meta.style.name] ? pack.meta.style.name : null);

/** The geometry of one platform: its height, its bands, and how the design's px (TikTok's) are scaled to it. */
export function geo(size, overlay = null, style = null) {
  const ig = size === 'instagram';
  const h = ig ? 1350 : 1920;
  const z = sidesOf(zonesFor(size, overlay, h), STYLES[style], size);
  return { size, ig, w: 1080, h, z, limit: h - z.bottom, y: (v) => Math.round(ig ? v * 0.7 : v), hs: (px) => Math.round(ig ? px * 0.85 : px) };
}

const HEADS = new Set(['hook', 'title', 'ntitle']);
// The closing slide's line and action are set in the same proportion on both platforms: both scale as a headline does.
const SCALED = new Set([...HEADS, 'closing', 'action']);

/** Where A, C and D start a slide's photograph (TikTok px): under the status bar and the tabs, so no face is behind them. */
const PHOTO_TOP = 150;

/**
 * One text block the renderer fits: its size, its floor, the lines it may take, in data attributes. In a style whose
 * text is one inline run (E) its words are in a span, for the box behind each line; `pre` is HTML set before them in
 * the same run (E's ranking place).
 */
function txt(tag, cls, S, field, text, g, { highlight = '', pre = '' } = {}) {
  const spec = S.text[field];
  if (!String(text || '').trim()) return '';
  const breaks = spec.breaks !== false;
  const px = SCALED.has(field) ? g.hs(spec.px) : spec.px;
  const floor = Math.round(SCALED.has(field) ? g.hs(spec.floor || spec.px * BODY_FLOOR) : spec.floor || spec.px * BODY_FLOOR);
  const writer = displayText(text, { breaks }).split('\n').length;
  const max = spec.lines || 99;
  // A spec's own `want` (the closing line's): the lines it is set smaller to keep to, short of the most it may take.
  const want = spec.want ? Math.min(spec.want, max) : breaks ? Math.min(writer, max) : max;
  const words = `${pre}${textHtml(text, { breaks, highlight })}`;
  return `<${tag} class="sf ${cls}${breaks ? '' : ' nb'}" style="font-size:${px}px" data-px="${px}" data-floor="${floor}" data-max="${max}" data-want="${want}" data-step="${HEADS.has(field) || field === 'closing' ? STEP : 2}">${S.inline ? ln(words) : words}</${tag}>`;
}

/** One inline run of text: E draws its box behind each of the run's lines. */
const ln = (html) => `<span class="ln">${html}</span>`;

/** A number set large: it never breaks, and a long one is set smaller (down to 40%) to stay inside the slide. */
const bigNum = (num, px, cls = 'num') => `<b class="sf ${cls}" style="font-size:${px}px" data-px="${px}" data-floor="${Math.round(px * 0.4)}" data-max="1" data-want="1" data-step="8" dir="ltr">${he(num)}</b>`;

const photoHtml = (slide, cls = 'ph') => {
  if (slide.split) return `<div class="${cls} split"><img src="${slide.split[0]}" alt=""${pos(slide.splitPos?.[0])}><img src="${slide.split[1]}" alt=""${pos(slide.splitPos?.[1])}></div>`;
  return slide.photo ? `<img class="${cls}" src="${slide.photo}" alt=""${pos(slide.photoPos)}>` : '';
};
const pos = (p) => (p ? ` style="object-position:${esc(p)}"` : '');
const hasPhoto = (slide) => Boolean(slide.photo || slide.split);

const ctaHtml = (m) => (m.cta ? `<div class="cta">${he(m.cta)}</div>` : '');
const srcHtml = (slide) => {
  const s = sourcesOf(slide);
  return s ? `<div class="src">${s}</div>` : '';
};
// A content slide's place in the post, as a badge before its line (its ranking place, else "1 מתוך 4"): a label of the
// post's structure, never its text. In the block, with the words, never alone at the top of the screen.
const badge = (m, cls = 'badge') => {
  const t = m.rank ? String(m.rank) : m.label || '';
  return t ? `<span class="${cls}${m.rank ? ' rank' : ''}">${he(t)}</span>` : '';
};
const gfx = (m) => (m.visual ? `<div class="gfx">${visualHtml(m.visual)}</div>` : '');
const unitOf = (v) => (v ? [v.pre, v.post].filter(Boolean) : []);

/* ------------------------------------------------------------------------------------------------ A: editorial */

function drawA(m, slide, g, S) {
  const photo = hasPhoto(slide);
  if (m.kind === 'cover') {
    return {
      bt: photo ? g.y(260) : g.y(460),
      html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk cov${photo ? '' : ' mid'}"><i class="arule"></i>${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}</div>`,
    };
  }
  if (m.kind === 'end') return m.closing ? closingA(m, slide, g, S) : endHtml(m, g, S);
  if (m.kind === 'number') {
    const v = m.value;
    const row = m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(104), 'num sm')}</div>`).join('')}</div>`
      : `<div class="nrow">${v.pre ? `<span class="unit">${he(v.pre)}</span>` : ''}${bigNum(v.num, g.hs(S.text.number.px))}${v.post ? `<span class="unit">${he(v.post)}</span>` : ''}</div>`;
    return {
      bt: photo ? g.y(780) : g.y(300),
      html: `${photoHtml(slide, slide.fullPhoto ? 'ph full' : 'ph')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${txt('h2', 'hl', S, 'ntitle', m.title, g, { highlight: m.highlight })}${m.meta ? `<div class="meta">${he(m.meta)}</div>` : ''}
<div class="card">${m.kicker ? `<div class="clbl">${he(m.kicker)}</div>` : ''}${row}${m.body ? `<i class="rule"></i>${txt('p', 'bd', S, 'body', m.body, g)}` : ''}</div>${ctaHtml(m)}${srcHtml(slide)}</div>`,
    };
  }
  // The slide's photograph fills it, as the cover's does, and the text stands at the bottom, over the fade into the
  // ground (stylePage sets fullPhoto on every slide of A since 2026-11-06; it was a store demo's option).
  return {
    bt: photo ? (slide.fullPhoto ? g.y(700) : g.y(780)) : g.y(300),
    html: `${photoHtml(slide, slide.fullPhoto ? 'ph full' : 'ph')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${photo ? `<div class="wcard">${badge(m)}` : ''}${txt('h2', 'hl', S, 'title', m.title, g, { highlight: m.highlight })}${gfx(m)}${m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g)}${ctaHtml(m)}${photo ? '</div>' : ''}${srcHtml(slide)}</div>`,
  };
}

// A's polish (2026-11-06, the owner: "like it was designed on photoshop"): the photograph darkened a little at the top
// (under TikTok's tabs) and fading into the ground under the words, so the slide has depth; a short bar of the colour
// over the cover's line; a content slide's words on A's card (as its number slide and its closing slide have them),
// laid over the foot of the photograph with a soft shadow under it, its place on a pill of the colour at its top.
const VIGNETTE = (g) => `linear-gradient(to bottom,rgba(0,0,0,.42) 0,rgba(0,0,0,.18) ${g.y(170)}px,rgba(0,0,0,0) ${g.y(380)}px)`;

const CSS_A = (g, S) => `
/* The photograph starts under TikTok's tabs (PHOTO_TOP), so a face is never behind them, and the words come down with it. */
.ph{top:${g.y(PHOTO_TOP)}px;height:${g.y(900)}px}
.ph.full{top:0;height:100%}
.ov{position:absolute;inset:${g.y(PHOTO_TOP)}px 0 auto 0;height:${g.y(900)}px;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0) ${g.y(480)}px,rgba(var(--bg-rgb),1) ${g.y(900)}px)}
.k-cover .ov{top:0;height:100%;background:${VIGNETTE(g)},linear-gradient(to bottom,rgba(var(--bg-rgb),0) 35%,rgba(var(--bg-rgb),.92) 72%,rgba(var(--bg-rgb),1) 100%)}
.full-photo.k-item .ov{top:0;height:100%;background:${VIGNETTE(g)},linear-gradient(to bottom,rgba(var(--bg-rgb),0) 0%,rgba(var(--bg-rgb),0) 52%,rgba(var(--bg-rgb),.45) 72%,rgba(var(--bg-rgb),.7) 100%)}
.wcard{display:flex;flex-direction:column;gap:${g.y(30)}px;background:rgba(var(--bg-rgb),.93);border-radius:${g.hs(40)}px;padding:${g.y(52)}px ${g.hs(54)}px ${g.y(56)}px;box-shadow:0 ${g.y(30)}px ${g.y(80)}px rgba(0,0,0,.38)}
.wcard>*{flex:none;max-width:100%}
.full-photo.k-item .blk{justify-content:flex-end}
.arule{display:block;width:${g.hs(110)}px;height:${g.y(12)}px;border-radius:${g.hs(6)}px;background:var(--accent)}
.badge{align-self:flex-start;font:800 ${g.hs(30)}px/1 'Assistant';color:var(--on-accent);background:var(--accent);padding:${g.y(12)}px ${g.hs(26)}px ${g.y(14)}px;border-radius:999px;white-space:nowrap}
.badge.rank{font:900 ${g.hs(44)}px/1 'Heebo';padding:${g.y(10)}px ${g.hs(30)}px}
.blk{gap:${g.y(36)}px}
.blk.cov{justify-content:flex-end;bottom:${g.z.bottom + g.y(40)}px}
.blk.cov.mid{justify-content:center;top:${g.y(400)}px}
.hl{font-family:'Heebo';font-weight:900;letter-spacing:-1px;line-height:1.04}
.k-item .hl{line-height:1.05}
.hl mark.hi{color:var(--accent)}
.sub{font:700 ${S.text.sub.px}px/1.3 'Assistant';color:var(--accent)}
.meta{font:400 32px/1.35 'Assistant';color:var(--muted);margin-top:-${g.y(18)}px}
.card{background:var(--card);border:2px solid var(--card-border);border-radius:36px;padding:${g.ig ? 40 : 52}px;display:flex;flex-direction:column;gap:${g.y(28)}px}
.clbl{font:700 28px/1.2 'Assistant';color:var(--accent)}
.nrow{display:flex;align-items:baseline;gap:24px;flex-wrap:nowrap}
.num{font-family:'Heebo';font-weight:900;line-height:1;letter-spacing:-2px;white-space:nowrap;unicode-bidi:isolate}
.unit{font:600 44px/1.1 'Assistant';white-space:nowrap}
.sides{display:flex;gap:30px}
.side{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.side span{font:700 30px/1.2 'Assistant';color:var(--muted)}
.side+.side{padding-inline-start:30px;border-inline-start:2px solid var(--card-border)}
.rule{display:block;height:2px;background:var(--card-border)}
.bd{font-family:'Assistant';font-weight:400;line-height:1.45}
.k-item .blk>.bd{color:var(--fg)}
.cta{font:700 34px/1.3 'Assistant';color:var(--accent)}
.src{font:400 24px/1.3 'Assistant'}
.list li{font:400 36px/1.4 'Assistant'}
`;

/* -------------------------------------------------------------------------------------------------- B: poster */

// The highlight block of B and D: a band of the accent behind the letters, from just above the tallest to just below
// the lowest (Karantina's letters stand from 23% to 96% of its line's box, its baseline at 86%), so it never reaches
// the line above or below, with a little room to each side of the words. A plain background fills the whole box of a
// face this tall and ran over the lines around it.
const BAND = '.hl mark.hi{background:linear-gradient(to bottom,transparent 14%,var(--accent) 14%,var(--accent) 97%,transparent 97%);color:var(--on-accent);padding:0 .12em;margin:0 .04em;-webkit-box-decoration-break:clone;box-decoration-break:clone}';


function drawB(m, slide, g, S) {
  const photo = hasPhoto(slide);
  if (m.kind === 'cover') {
    return {
      bt: photo ? g.y(560) : g.y(380),
      html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="tone"></div><div class="ov" data-scrim data-min="0.45" data-max="0.7"></div><i class="frame"></i>' : ''}
<div class="blk cov">${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}</div>
<div class="cue">החליקו ←</div>`,
    };
  }
  if (m.kind === 'end') return m.closing ? closingB(m, slide, g, S) : endHtml(m, g, S);
  // The slide's photograph over the whole slide under B's dark layer, as B's cover has it: a frame of it sat over its own
  // blurred copy, which the owner refused (2026-11-06).
  const under = photo ? `${photoHtml(slide, 'ph full')}<div class="tone"></div><div class="ov" data-scrim data-min="0.5" data-max="0.72"></div><i class="frame"></i>` : '';
  if (m.kind === 'number') {
    const v = m.value;
    const big = m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(200))}</div>`).join('')}</div>`
      : `<div class="nrow">${bigNum(v.num, g.hs(S.text.number.px))}${unitOf(v).length ? `<span class="unit">${he(unitOf(v).join(' '))}</span>` : ''}</div>`;
    return {
      bt: g.y(260),
      html: `${under}<div class="blk">${big}${txt('div', 'cap', S, 'ntitle', m.title, g, { highlight: m.highlight })}${txt('p', 'bd', S, 'body', m.body, g)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
    };
  }
  return {
    bt: g.y(260),
    html: `${under}<div class="blk">${txt('h2', 'hl', S, 'title', m.title, g, { highlight: m.highlight })}${photo ? '' : gfx(m)}${m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_B = (g, S) => `
.ph.full{height:100%}
/* B's polish (2026-11-06): the photograph in the account's colour (a duotone: its tones in grey, the colour laid over
   them), under B's dark layer; a poster's thin frame inside the slide's edge. (B's words start under the tabs: no badge of the slide's place over them,
   which would be a label at the top of the screen.) */
.st-B.has-photo .ph,.st-B.has-photo .ph img{filter:grayscale(1) contrast(1.12) brightness(1.04)}
.tone{position:absolute;inset:0;background:var(--accent);mix-blend-mode:multiply;opacity:.62}
.frame{position:absolute;inset:${g.hs(30)}px;border:${g.hs(3)}px solid rgba(255,255,255,.5);pointer-events:none}
.ov{position:absolute;inset:0;background:rgba(10,10,10,var(--scrim,.45))}
.blk{gap:${g.y(32)}px}
.blk.cov{gap:${g.y(40)}px;bottom:${g.z.bottom + 36 + g.y(28)}px}
.hl{font-family:'Karantina Headline';font-weight:700;line-height:.86;color:var(--fg)}
.k-item .hl{line-height:.9}
${BAND}
.sub{font:600 ${S.text.sub.px}px/1.3 'Rubik';color:var(--fg)}
.cue{position:absolute;right:${g.z.right}px;bottom:${g.z.bottom}px;font:600 30px/1.2 'Rubik';color:var(--muted)}
.nrow{display:flex;align-items:baseline;gap:24px}
.num{font-family:'Karantina';font-weight:700;line-height:.8;color:var(--accent);white-space:nowrap;unicode-bidi:isolate}
.unit{font:800 56px/1.1 'Rubik';color:var(--accent);white-space:nowrap}
.sides{display:flex;gap:40px}
.side{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.side span{font:600 30px/1.2 'Rubik';color:var(--muted)}
.cap{font-family:'Rubik';font-weight:800;line-height:1.2;color:var(--fg)}
.cap mark.hi{background:var(--accent);color:var(--on-accent);padding:0 12px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.fr{display:block;width:100%;height:${g.y(480)}px;border-radius:12px;object-fit:cover;object-position:50% 30%}
.fr.split{display:flex;gap:6px;overflow:hidden}
.fr.split img{flex:1;min-width:0;object-fit:cover}
.bd{font-family:'Rubik';font-weight:400;line-height:1.45;color:var(--muted)}
.has-photo .bd,.has-photo .list li{color:var(--fg)}
.cta{font:700 36px/1.3 'Rubik';color:var(--accent)}
.src{font:400 24px/1.3 'Rubik'}
.list li{font:400 38px/1.4 'Rubik';color:var(--muted)}
`;

/* --------------------------------------------------------------------------------------------------- C: split */

function drawC(m, slide, g, S) {
  const photo = hasPhoto(slide);
  if (m.kind === 'cover') {
    return {
      bt: photo ? g.y(1160) : g.y(560),
      lift: photo ? g.y(860) : null,
      html: `${photoHtml(slide)}
<div class="blk cov${m.key ? ' keyed' : ''}"><i class="bar"></i>${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}</div>
${m.key ? `<div class="key">${he(m.key)}</div>` : ''}`,
    };
  }
  if (m.kind === 'end') return m.closing ? closingC(m, slide, g, S) : endHtml(m, g, S);
  // The label sits on the photograph's lower edge; a slide with no photograph has no edge for it, and no label at the
  // top of the screen (a line over the headline reads as an eyebrow, a mark of machine-made posts).
  const chip = m.label && photo ? `<div class="chip">${he(m.label)}</div>` : '';
  const num = m.kind === 'number'
    ? m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(96))}</div>`).join('')}</div>`
      : `<div class="nrow">${m.value.pre ? `<span class="unit">${he(m.value.pre)}</span>` : ''}${bigNum(m.value.num, g.hs(S.text.number.px))}${m.value.post ? `<span class="unit">${he(m.value.post)}</span>` : ''}</div>`
    : '';
  const body = m.kind === 'number' ? txt('p', 'bd', S, 'body', m.body, g) : m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g);
  return {
    bt: photo ? g.y(1000) : g.y(260),
    lift: photo ? g.y(700) : null,
    html: `${photoHtml(slide)}${chip}
<div class="blk">${num || '<i class="bar"></i>'}${txt('h2', 'hl', S, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: m.highlight })}${body}${m.kind === 'number' ? '' : gfx(m)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_C = (g, S) => `
/* C's polish (2026-11-06): the photograph a card laid on C's light panel, inside the side margins, rounded, a soft
   shadow under it; the label on its lower edge; a bar of the colour over every line. */
.ph{top:${g.y(PHOTO_TOP)}px;height:calc(var(--bt) - ${g.y(80 + PHOTO_TOP)}px);left:${g.hs(56)}px;width:calc(100% - ${2 * g.hs(56)}px);border-radius:${g.hs(44)}px;box-shadow:0 ${g.y(26)}px ${g.y(70)}px rgba(20,16,10,.22),0 ${g.y(4)}px ${g.y(12)}px rgba(20,16,10,.12)}
.k-item .ph{height:calc(var(--bt) - ${g.y(120 + PHOTO_TOP)}px)}
.blk{gap:${g.y(32)}px}
.blk.cov{gap:${g.y(36)}px}
.blk.cov.keyed{bottom:${g.z.bottom + 36 + g.y(20)}px}
.bar{display:block;width:96px;height:12px;background:var(--accent)}
.hl{font-family:'Rubik';font-weight:900;line-height:1.04;color:var(--fg)}
.k-item .hl{line-height:1.08}
.hl mark.hi{background:none;color:var(--accent)}
.sub{font:500 ${S.text.sub.px}px/1.35 'Rubik';color:var(--muted)}
.key{position:absolute;right:${g.z.right}px;left:${g.z.left}px;bottom:${g.z.bottom}px;font:800 30px/1.2 'Rubik';color:var(--accent)}
.chip{position:absolute;right:${g.z.right}px;top:calc(var(--bt) - ${g.y(192)}px);max-width:${1080 - g.z.left - g.z.right}px;font:900 ${g.hs(S.text.label.px)}px/1.2 'Rubik';color:#fff;background:var(--accent);padding:16px 36px;white-space:nowrap;overflow:hidden;border-radius:${g.hs(16)}px;box-shadow:0 ${g.y(10)}px ${g.y(26)}px rgba(20,16,10,.2)}
.k-item .bar{width:${g.hs(72)}px;height:${g.y(10)}px}
.nrow{display:flex;align-items:baseline;gap:20px}
.num{font-family:'Rubik';font-weight:900;line-height:1;color:var(--accent);white-space:nowrap;unicode-bidi:isolate}
.unit{font:800 40px/1.1 'Rubik';color:var(--accent);white-space:nowrap}
.sides{display:flex;gap:40px}
.side{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.side span{font:700 30px/1.2 'Rubik';color:var(--muted)}
.bd{font-family:'Rubik';font-weight:400;line-height:1.5;color:var(--muted)}
.cta{font:800 34px/1.3 'Rubik';color:var(--accent)}
.src{font:400 24px/1.3 'Rubik'}
.list li{font:400 38px/1.45 'Rubik';color:var(--muted)}
`;

/* --------------------------------------------------------------------------------------------- D: native dark */

function drawD(m, slide, g, S) {
  const photo = hasPhoto(slide);
  if (m.kind === 'cover') {
    return {
      bt: photo ? g.y(960) : g.y(560),
      lift: photo ? g.y(640) : null,
      html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk cov">${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}<i class="bar"></i></div>`,
    };
  }
  if (m.kind === 'end') return m.closing ? closingD(m, slide, g, S) : endHtml(m, g, S);
  const chip = m.label ? `<span class="chip">${he(m.label)}</span>` : '';
  const num = m.kind === 'number'
    ? m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(150))}</div>`).join('')}</div>`
      : `<div class="nrow">${bigNum(m.value.num, g.hs(S.text.number.px))}${unitOf(m.value).length || m.kicker ? `<span class="unit">${he(unitOf(m.value).join(' ') || m.kicker)}</span>` : ''}</div>`
    : '';
  const body = m.kind === 'number' ? txt('p', 'bd', S, 'body', m.body, g) : m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g);
  return {
    bt: photo ? g.y(880) : g.y(300),
    lift: photo ? g.y(500) : null,
    html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${chip}${txt('h2', 'hl', S, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: m.highlight })}${num}${body}${m.kind === 'number' ? '' : gfx(m)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_D = (g, S) => `
/* The photograph over the whole slide (2026-11-06: no photograph in a band), fading into the dark ground behind the
   words from just above where they start. */
.ph{top:0;height:100%}
.ov{position:absolute;inset:0;background:${VIGNETTE(g)},linear-gradient(to bottom,rgba(var(--bg-rgb),0) 0,rgba(var(--bg-rgb),0) calc(var(--bt) - ${g.y(360)}px),rgba(var(--bg-rgb),.9) calc(var(--bt) - ${g.y(40)}px),rgba(var(--bg-rgb),.96) 100%)}
.blk{gap:${g.y(28)}px}
.blk.cov{gap:${g.y(8)}px}
.hl{font-family:'Karantina Headline';font-weight:700;line-height:.9;color:var(--fg)}
.k-item .hl{line-height:.92}
${BAND}
.sub{font:500 ${S.text.sub.px}px/1.4 'Rubik';color:var(--muted);margin-top:${g.y(28)}px}
.bar{display:block;width:88px;height:6px;background:var(--accent);margin-top:${g.y(20)}px}
/* D's polish (2026-11-06): the photograph darkened under the tabs as A's; the place on a chip a size up, a bar of the
   colour between each line and its words, as the cover has under its line. */
.chip{align-self:flex-start;font:800 ${g.hs(34)}px/1.2 'Rubik';color:var(--on-accent);background:var(--accent);padding:${g.y(8)}px ${g.hs(24)}px;white-space:nowrap}
.k-item .blk>.hl+.bd,.k-item .blk>.hl+.list{border-top:${g.y(6)}px solid var(--accent);padding-top:${g.y(26)}px;margin-top:${g.y(6)}px}
.nrow{display:flex;align-items:baseline;gap:20px}
.num{font-family:'Karantina';font-weight:700;line-height:.9;color:var(--accent);white-space:nowrap;unicode-bidi:isolate}
.unit{font:800 38px/1.1 'Rubik';color:var(--fg);white-space:nowrap}
.sides{display:flex;gap:40px}
.side{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.side span{font:800 28px/1.2 'Rubik';color:var(--muted)}
.bd{font-family:'Rubik';font-weight:400;line-height:1.5;color:var(--muted)}
.cta{font:800 32px/1.3 'Rubik';color:var(--accent)}
.src{font:400 22px/1.3 'Rubik'}
.list li{font:400 32px/1.45 'Rubik';color:var(--muted)}
`;

/* -------------------------------------------------------------------------------------------------- E: native */

// What a slideshow made in TikTok's own app looks like: the slide's own photograph over the whole screen, sharp and
// whole (never framed, blurred or veiled), and over it a line or two in the middle of the screen, centred, as the
// app's text tool sets them. On a box: each line on its own white box with rounded corners, the words near-black. Or
// in white with a thin dark edge. A cover is its hook (and its line under it, small); a content slide is its title
// and at most two short lines of text; a number slide's number is a line of its own, on a box of the accent.
//
// One thing a slide: a slide with a photograph shows the photograph, not its graphic as well; a slide with no
// photograph stands on the solid ground, its graphic drawn there as every style draws it. The source is a line in
// small type at the foot of the room the text has, faint: the account's credit, not a part of the design.

// How E shows a slide's photograph: over the whole slide, always, cut around its subject (render.js sets the cut,
// src/render/crop.js cropFor). It was shown whole as a band over its own blurred copy when it was too small to fill,
// and the owner refused it (2026-11-06: "tiktok format should be 9:16. no landscape images with blurred background"):
// a photograph that cannot fill a 9:16 slide, or whose subject a 9:16 cut would lose, is not chosen for one
// (src/images/index.js findImage). `mode` is kept for the callers.
export function fitE() {
  return { mode: 'cover' };
}

// The room E's words have, top and bottom in px: the photograph's calmest band, clear of its subject (the owner, on the
// pets post: "the text should appear in an empty space in the background ... not on top of the nuts, but in a place
// where it looks natural (the wall in the background)"). `slide.calm` is how busy each band of the slide is, measured
// on the photograph as it is cut (render.js, src/render/crop.js bandProfile), `slide.subjectBand` where its subject
// stands. A photograph whose band was not measured (the closing slide, a picture the browser could not read) takes
// the larger part of the slide above or below its subject, when its subject was measured, else the whole band.
// (photoPos is the cut's offset since 2026-11-06, not the face's place: it says nothing of where the subject is.)
function roomE(slide, g, need = g.y(560)) {
  const top = g.z.top;
  const bottom = g.h - g.z.bottom;
  // A block too tall for its room (render.js tries this before it gives the photograph up).
  if (slide.textOver || !slide.photo) return { top, bottom };
  const calm = slide.calm ? calmRoom({ profile: slide.calm, H: g.h, top, bottom, need, avoid: slide.subjectBand || null }) : null;
  if (calm) return { top: calm.top, bottom: calm.bottom };
  const sb = slide.subjectBand || null;
  if (!sb) return { top, bottom };
  const below = { top: Math.max(top, Math.min(bottom - need, sb.bottom)), bottom };
  const above = { top, bottom: Math.min(bottom, Math.max(top + need, sb.top)) };
  return below.bottom - below.top >= above.bottom - above.top ? below : above;
}

/**
 * About how tall a slide's words come out in E, in px: its lines as the writer broke them, a long one wrapping at
 * about E's width (18 to 34 characters, by its size), at E's sizes (tokens.js). The room roomE looks for: a window of
 * this height in the photograph's calmest band. Pure.
 */
export function needE(m, g) {
  const lines = (t, per) => String(t || '').split(/\n/).filter((l) => l.trim()).reduce((n, l) => n + Math.max(1, Math.ceil(l.trim().length / per)), 0);
  const px = m.kind === 'cover'
    ? lines(m.hook, 18) * 118 + (m.sub ? lines(m.sub, 34) * 66 + 30 : 0)
    : lines(m.title, 20) * 109 + (m.body ? lines(m.body, 34) * 66 + 22 : 0) + (m.kind === 'number' ? 150 : 0);
  return Math.round(Math.min(g.h * 0.6, Math.max(g.y(300), g.y(px + 60))));
}

function drawE(m, slide, g, S) {
  const photo = hasPhoto(slide);
  // The closing slide keeps its line in the middle of the band, as it is designed (closingE).
  const room = roomE(m.kind === 'end' ? { ...slide, calm: null, subjectBand: null } : slide, g, needE(m, g));
  // A soft shade behind the text only, so white text reads on a bright photograph: its depth is measured on the
  // photograph by the renderer (render.js, data-scrim) between these bounds, so a dark picture keeps all of its colour.
  // A box carries its own ground: under it the shade is the faintest.
  const box = slide.textLook !== 'shadow';
  const [lo, hi] = box ? [0.06, 0.14] : [0.12, 0.42];
  const mid = Math.round((room.top + room.bottom) / 2);
  const img = photoHtml(slide, 'ph full');
  const under = photo ? `${img}<div class="ov" data-scrim data-min="${lo}" data-max="${hi}" style="--mid:${mid}px;--scrim:${lo}"></div>` : '';
  const blk = (cls, inner) => `<div class="blk${cls}${room.hug ? ' hug' : ''}" style="bottom:${g.h - room.bottom}px">${inner}</div>`;
  // The native look marks nothing: no highlighter, no coloured word. A box look keeps its highlight.
  const mark = (h) => (box ? h : '');
  if (m.kind === 'cover') {
    return {
      bt: room.top,
      html: `${under}${blk(' cov', `${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: mark(m.highlight) })}${txt('p', 'sub', S, 'sub', m.sub, g)}`)}`,
    };
  }
  // The closing slide stands in the middle of the band, as every other slide of E does.
  if (m.kind === 'end') return m.closing ? closingE(m, slide, g, S, { room, img }) : { ...endHtml(m, g, S), bt: g.z.top };
  const rank = S.rank && m.rank ? `<span class="rk">${he(m.rank)}.</span> ` : '';
  const head = txt('h2', 'hl', S, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: mark(m.highlight), pre: rank });
  // A number's line is one row that never breaks (the renderer sets a long one smaller), on a box of its own.
  const unit = (u) => (u ? `<span class="unit">${he(u)}</span>` : '');
  const num = m.kind === 'number'
    ? m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="nrow"><span class="unit">${he(x.who)}</span>${bigNum(x.value, g.hs(84))}</div>`).join('')}</div>`
      : `<div class="nrow">${unit(m.value.pre)}${bigNum(m.value.num, g.hs(S.text.number.px))}${unit(m.value.post)}</div>`
    : '';
  const body = m.kind === 'number' ? txt('p', 'bd', S, 'body', m.body, g) : m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g);
  const cta = m.cta ? `<div class="cta">${ln(he(m.cta))}</div>` : '';
  // The native look draws no source line: no viral slideshow had one, and the post's sources are in its caption. A
  // do-dont's rules, whose licences ask for credit on the slide, keep theirs.
  const src = box || slide.postKind === 'do-dont' ? srcHtml(slide) : '';
  return {
    bt: room.top,
    html: `${under}${blk('', `${head}${num}${m.kind === 'text' && !photo ? gfx(m) : ''}${body}${cta}`)}${src}`,
  };
}

const CSS_E = (g, S) => {
  const t = S.tokens;
  return `
:root{--box:${t.box};--box-ink:${t.ink}}
.ph.full{height:100%}
.blk.hug{justify-content:flex-end}
/* Darkest behind the middle of the text's room (--mid, drawE), fading out to every side: a soft shade behind the
   words, not a band across the photograph. */
.ov{position:absolute;inset:0;background:radial-gradient(ellipse 78% ${g.y(460)}px at 50% var(--mid),rgba(0,0,0,var(--scrim,.3)) 0%,rgba(0,0,0,calc(var(--scrim,.3) * .7)) 50%,rgba(0,0,0,0) 100%)}
.blk{justify-content:center;align-items:center;text-align:center;gap:${g.y(22)}px}
.blk>.sf{max-width:100%}
.blk.cov{gap:${g.y(30)}px}
.blk>.gfx{align-self:stretch;text-align:right}
.hl{font-family:'Heebo';font-weight:800;line-height:1.24;letter-spacing:-.5px;color:var(--fg)}
.sub{font-family:'Heebo';font-weight:700;line-height:1.3;color:var(--fg)}
.bd{font-family:'Heebo';font-weight:700;line-height:1.3;color:var(--fg)}
.nrow{display:flex;align-items:baseline;gap:${g.hs(16)}px;white-space:nowrap;max-width:100%;padding:${g.y(4)}px ${g.hs(30)}px ${g.y(10)}px;border-radius:${g.hs(18)}px;color:var(--fg)}
.num{font-family:'Heebo';font-weight:900;line-height:1.05;letter-spacing:-1px;white-space:nowrap;unicode-bidi:isolate}
.unit{font:800 ${g.hs(52)}px/1.1 'Heebo';white-space:nowrap}
.sides{display:flex;flex-direction:column;align-items:center;gap:${g.y(14)}px}
.cta{font:800 ${g.hs(44)}px/1.3 'Heebo';color:var(--fg)}
.list{align-items:center;gap:${g.y(12)}px}
.list li{font:700 38px/1.3 'Heebo';color:var(--fg)}
.src{position:absolute;right:${g.z.right}px;left:${g.z.left}px;bottom:${g.z.bottom}px;text-align:center;font:400 ${S.text.label.px}px/1.2 'Heebo';color:rgba(255,255,255,.62)}
/* The box: each line of a run on its own white box, its corners rounded, as the app draws it. A highlight is a
   highlighter's stroke of the accent inside it; a number's line is a box of the accent. */
.tx-box .ln{background:var(--box);color:var(--box-ink);padding:.05em .3em .09em;border-radius:.2em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.tx-box mark.hi{background:var(--accent);color:var(--on-accent);border-radius:.12em;padding:0 .06em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.tx-box .nrow{background:var(--accent);color:var(--on-accent)}
/* White with a thin dark edge (drawn under the letters, so half of it shows) and a soft shadow: the app's plain text.
   On E's own lines only, past the rule that no other letter has one (base, .st *). */
.st.st-E.tx-shadow .ln,.st.st-E.tx-shadow .ln *,.st.st-E.tx-shadow .nrow,.st.st-E.tx-shadow .nrow *{color:#fff;text-shadow:0 0 .08em rgba(0,0,0,.5),0 .02em .1em rgba(0,0,0,.6)!important;-webkit-text-stroke:.03em rgba(0,0,0,.55)!important;paint-order:stroke fill}
/* The highlight's words in the accent; a number stays white, large enough to stand out by its size alone (an accent
   of the account's own, set over any photograph, read badly on a dark one). */
.st.st-E.tx-shadow .ln mark.hi,.st.st-E.tx-shadow .ln mark.hi *{color:var(--accent)}
/* The source's line is small and faint; over a photograph it keeps a soft shadow, so it is there when it is looked for. */
.st.st-E.has-photo .src,.st.st-E.has-photo .src *{text-shadow:0 1px 3px rgba(0,0,0,.6)!important}
`;
};

/* ----------------------------------------------------------------------------------- the designed text slide */

// A slide with no photograph is a post's text designed, on its texture (the owner, 2026-11-06: "when there is no
// background image, the main visual eye catcher is the text design. you cant just put white text on a background and
// think that the post will go viral", and "if a slideshow is without picture, the format is the nice text design"). A
// post in text mode (src/pipeline/build.js postMode) has every slide so, in one of four layouts, the same on every
// slide of it (its texture's `layout`, src/render/textures.js):
//   marker  the line huge and bold at the start of the slide, its key word on a stroke of the account's colour, the
//           words under it smaller and lighter, a bar of the colour above it
//   boxes   each line on its own solid box, as TikTok's own text tool sets it, the key word's box in the colour, the
//           words under it on dark boxes, set off from the line
//   corner  the slide's number (its place, or the number it is about) huge in a corner, on a sticker of the colour, the
//           line and the words stacked under it
//   card    the words on a card laid on the texture, turned the other way, a strip of tape across its top, the line in
//           the display face with a bar of the colour under it
// The fit is the styles' own (render.js): each text an `.sf` that is set smaller to its floor before it takes a line.
export { LAYOUTS };

/** The number a slide shows big in the corner layout: the number it is about, else its place in the post. Pure. */
export function cornerNumber(m, slide) {
  if (m.kind === 'number' && m.value?.num) return String(m.value.num);
  if (m.kind === 'cover') return /^\s*([\d][\d,.]*)/.exec(String(m.hook || ''))?.[1] || '';
  // A content slide's place (a countdown's from its top), never a number its line happens to start with.
  return m.rank || (slide.n ? String(slide.n) : '');
}

function drawText(m, slide, g, S) {
  const layout = LAYOUTS.includes(slide.texture?.layout) ? slide.texture.layout : 'marker';
  // The display line a size up from the style's own, its floor and its lines kept (the writer wrote to those).
  // Its floor a little under the style's: the boxes and the heavier weight take some of the width the writer wrote to.
  const up = (spec, f) => ({ ...spec, px: Math.round(spec.px * f), floor: Math.round((spec.floor || spec.px * BODY_FLOOR) * 0.85) });
  // The line is the slide's picture: it keeps its size and takes a line more than the style allows on a photograph
  // before it is set smaller, where on a photograph it keeps to the lines the writer broke it into.
  const lead = (spec, f) => ({ ...up(spec, f), want: (spec.lines || 2) + 1, lines: (spec.lines || 2) + 1 });
  // C's face runs wide on its panel: its line a size up less.
  const k = S.name === 'C' ? 1.12 : 1.36;
  const D = { ...S, inline: layout === 'boxes', text: { ...S.text, hook: lead(S.text.hook, k * 0.9), title: lead(S.text.title, k), ntitle: lead(S.text.ntitle || S.text.title, k * 0.95), tbody: up(S.text.tbody, 1.1) } };
  const cover = m.kind === 'cover';
  const head = cover ? txt('h1', 'hl tl-head', D, 'hook', m.hook, g, { highlight: m.highlight }) : txt('h2', 'hl tl-head', D, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: m.highlight });
  const under = cover ? txt('p', 'tl-sub', D, 'sub', m.sub, g) : m.list ? listHtml(m.body, D, g) : txt('p', 'tl-sub', D, m.kind === 'number' ? 'body' : 'tbody', m.body, g);
  const unit = (v) => (v ? `<span class="tl-unit">${he(v)}</span>` : '');
  const num = m.kind === 'number' && layout !== 'corner' ? `<div class="tl-num">${unit(m.value.pre)}${bigNum(m.value.num, g.hs(S.text.number.px))}${unit(m.value.post)}</div>` : '';
  const big = layout === 'corner' ? cornerNumber(m, slide) : '';
  const src = cover ? '' : srcHtml(slide);
  const inner = {
    marker: `<i class="tl-bar"></i>${head}${num}${under}`,
    boxes: `${head}${num}${under}`,
    corner: `${big ? `<div class="tl-sticker">${bigNum(big, g.hs(Math.min(260, S.text.number.px * 1.5)), 'num tl-big')}</div>` : '<i class="tl-bar"></i>'}${head}${under}`,
    card: `<div class="tl-card"><i class="tl-tape"></i>${head}<i class="tl-rule"></i>${num}${under}</div>`,
  }[layout];
  return { bt: cover ? g.y(360) : g.y(300), html: `<div class="blk tl tl-${layout}${cover ? ' tl-cover' : ''}">${inner}${src}</div>` };
}

/** The card layout's own colours: a light card with near-black ink, its accent where it reads at 3:1, else the ink. */
const cardColors = (c) => {
  const ground = '#F6F1E7';
  const accent = contrast(c.accent, ground) >= 3 ? c.accent : '#7A3B12';
  return `:root{--card-ground:${ground};--card-ink:#16130F;--card-muted:#4A443B;--card-accent:${accent}}`;
};

/** The designed text slide's own CSS, over the style's: the four layouts, in the style's faces and the account's colour. */
const CSS_TEXT = (g, S) => `
/* Inside TikTok's own side margins on every style (C's text runs wider on its panel). */
.st .blk.tl{justify-content:center;gap:${g.y(34)}px;right:${Math.max(g.z.right, g.ig ? g.z.right : 168)}px;left:${Math.max(g.z.left, g.ig ? g.z.left : 168)}px}
.st .blk.tl>*,.tl .tl-card>*{max-width:100%}
.tl .tl-head{font-family:'${S.text.title.family}';font-weight:900;line-height:1.02;letter-spacing:-.5px;color:var(--fg)}
.tl .tl-sub{font-family:'${S.text.tbody.family}';font-weight:500;line-height:1.35;color:var(--muted)}
.tl .tl-num{display:flex;align-items:baseline;gap:${g.hs(16)}px;color:var(--accent)}
.tl .tl-unit{font:800 ${g.hs(48)}px/1.1 '${S.text.tbody.family}';color:var(--accent)}
/* marker: the key word on a stroke of the colour, a short bar of the colour above it */
.st .blk.tl-marker{align-items:flex-start;text-align:right;justify-content:flex-end;padding-bottom:${g.y(40)}px}
.tl .tl-bar{display:block;width:${g.hs(120)}px;height:${g.y(14)}px;background:var(--accent);border-radius:${g.hs(8)}px}
.tl-marker .tl-head mark.hi{background:linear-gradient(to bottom,transparent 52%,var(--accent) 52%,var(--accent) 92%,transparent 92%);color:inherit;padding:0 .08em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
/* boxes: each line on its own solid box, as TikTok's text tool sets it */
.st .blk.tl-boxes{align-items:flex-start;text-align:right}
/* The boxes reach past the words by their padding: the line's own box is that much wider, so they stay inside it. */
.tl-boxes .tl-head{padding:0 .3em}
.tl-boxes .tl-sub{padding:0 .37em}
.tl-marker .tl-head{padding:0 .1em}
.tl-boxes .tl-head .ln{background:#FFFFFF;color:#111111;padding:.04em .28em .1em;border-radius:.16em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.tl-boxes .tl-head mark.hi{background:var(--accent);color:var(--on-accent);border-radius:.12em;padding:0 .06em}
.tl-boxes .tl-sub{margin-inline-start:${g.hs(70)}px}
.tl-boxes .tl-sub .ln{background:rgba(0,0,0,.62);color:#FFFFFF;padding:.1em .35em .16em;border-radius:.2em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.tl-boxes .tl-num{background:var(--accent);color:var(--on-accent);align-self:flex-start;padding:${g.y(6)}px ${g.hs(28)}px;border-radius:${g.hs(18)}px}
/* corner: the number huge on a sticker of the colour at the start of the slide, the words stacked under it */
.st .blk.tl-corner{justify-content:center;align-items:flex-start;text-align:right}
.tl-corner .tl-sticker{align-self:flex-start;background:var(--accent);color:var(--on-accent);border-radius:${g.hs(36)}px;padding:${g.y(6)}px ${g.hs(36)}px ${g.y(12)}px;transform:rotate(-4deg);margin:${g.y(30)}px 0 ${g.y(12)}px}
.tl-corner .tl-big{color:var(--on-accent);letter-spacing:-3px}
.tl-corner .tl-head mark.hi{color:var(--accent)}
/* card: the words on a card laid on the texture, turned the other way, a strip of tape across it */
.st .blk.tl-card{align-items:stretch}
.tl-card .tl-card{position:relative;display:flex;flex-direction:column;gap:${g.y(26)}px;background:var(--card-ground);padding:${g.y(64)}px ${g.hs(52)}px ${g.y(56)}px;border-radius:${g.hs(10)}px;transform:rotate(1.6deg)}
.tl-card .tl-card .tl-head{color:var(--card-ink)}
.tl-card .tl-card .tl-sub{color:var(--card-muted)}
.tl-card .tl-card .tl-head mark.hi{color:var(--card-accent)}
.tl-card .tl-tape{position:absolute;top:-${g.y(22)}px;left:50%;width:${g.hs(200)}px;height:${g.y(48)}px;margin-left:-${g.hs(100)}px;background:rgba(255,248,220,.72);transform:rotate(-3deg)}
.tl-card .tl-rule{display:block;width:${g.hs(150)}px;height:${g.y(12)}px;background:var(--card-accent)}
/* The source under the words, in the block (E sets it at the foot of the screen, which a card or a sticker can reach). */
.st .blk.tl .src{position:static;text-align:inherit;color:var(--muted);font:400 ${g.hs(24)}px/1.3 '${S.text.tbody.family}';margin-top:${g.y(10)}px}
`;

/* --------------------------------------------------------------------------------------------- shared parts */

/** A body that is a list (places 10 to 6, an iceberg's layer): one item a line, as its kind is checked. */
function listHtml(body, S, g) {
  const ls = String(body || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return ls.length ? `<ul class="list">${ls.map((l) => `<li>${S.inline ? ln(he(displayText(l))) : he(displayText(l))}</li>`).join('')}</ul>` : '';
}

/* ------------------------------------------------------------------------------------------ the closing slide */

// A post's closing slide (src/pipeline/closing.js), item 4 of it, the design (the owner, 2026-11-02: "draw the closing
// slide in all four styles (A, B, C, D) and style E. It stays inside TikTok's safe zones and keeps the rules (no
// outlines, no shadows, no page numbers). The customer's logo appears if there is one. A URL appears only on
// Instagram/Facebook; on TikTok the slide says 'link in bio', because a link in a TikTok image isn't clickable").
//
// One design in each style's own terms. The writer's line is the slide: in the style's headline face (tokens.js
// `closing`), from its full size down to a floor that holds 60 characters in four lines on both platforms. Under it the
// action the code wrote for this platform (TikTok's never has an address), smaller (the line is at least 1.25 times its
// size, however the two are fitted), on a block of the account's colour in the style's own shape: A's pill, B's block,
// C's and D's square chip, E's box. Its words are white or near-black, whichever reads at 4.5:1 on that colour; an
// accent neither reads on is left off, and the block takes the style's text colour on its ground. The account's logo,
// when it has one, comes first, on a tile of its own (white, or dark for a light logo: the renderer looks at it); with
// none, nothing stands in its place and the group closes up. The line and the action are scaled together, so TikTok and
// Instagram show the same slide.
//
// The photograph is the post's own (the least used), sharp and in sight, and the words never sit on it bare:
//   A  the photograph over the whole slide; the logo, the line and the action on A's card at the foot of the band
//   B  the photograph framed, wide, over the top of the slide; the line huge on B's ground under it, the product's or
//      the store's name on a block of colour
//   C  the photograph on top; the line and the action on C's light panel under it, never on it
//   D  the photograph over the whole slide, fading into D's dark ground just above the words; the name on a block
//   E  the photograph over the whole slide, unveiled; the line on TikTok's white boxes and the action on a box of the
//      colour, in the middle of the band, whatever E's look: its "shadow" look is an edge and a shadow, and the closing
//      slide has neither in any style
// Nothing else is on it: no counter, page number, progress bar, handle, source or call to action, and no letter, box or
// tile has an outline or a shadow (the renderer measures every letter's contrast on it and refuses one of either).

/** The action's block: the accent with the ink that reads on it at 4.5:1, else the style's text colour on its ground. */
export function chipOf(c, name) {
  const ink = bestInk(c.accent, '#FFFFFF', '#111111');
  if (contrast(ink, c.accent) >= 4.5) return { bg: c.accent, ink, accent: true };
  return name === 'E' ? { bg: '#111111', ink: '#FFFFFF', accent: false } : { bg: c.text, ink: c.bg, accent: false };
}

const logoHtml = (m) => (m.logo ? `<div class="lg"><img class="logo" src="${m.logo}" alt=""></div>` : '');

/** The action, one text the renderer fits like any other: smaller before it takes a second line. */
function actionTxt(m, S, g) {
  if (!m.action) return '';
  const spec = S.text.action;
  const px = g.hs(spec.px);
  const words = actionHtml(m.action);
  // It keeps its proportion to the line (data-of, data-ratio): a line set smaller to fit sets the action smaller with it,
  // down to the action's own floor, so the slide is the same on both platforms whatever their widths do to the line.
  return `<div class="sf act cl-act" style="font-size:${px}px" data-px="${px}" data-floor="${g.hs(spec.floor)}" data-max="${spec.lines}" data-want="1" data-step="2" data-of=".cl-line" data-ratio="${(spec.px / S.text.closing.px).toFixed(4)}">${S.inline ? ln(words) : words}</div>`;
}

/** The logo, the line and the action, one group. B and D mark the product's or the store's name on a block. */
function closingGroup(m, S, g, { cls = '', mark = false, rule = false } = {}) {
  const line = txt('h2', 'hl cl-line', S, 'closing', m.title, g, { highlight: mark ? m.mark : '' });
  return `<div class="cw${cls}">${logoHtml(m)}${rule && line ? '<i class="mk"></i>' : ''}${line}${actionTxt(m, S, g)}</div>`;
}

function closingA(m, slide, g, S) {
  return {
    bt: g.z.top,
    html: `${photoHtml(slide, 'ph full')}${hasPhoto(slide) ? '<div class="cl-ov"></div>' : ''}<div class="blk cl">${closingGroup(m, S, g, { cls: ' card' })}</div>`,
  };
}

function closingB(m, slide, g, S) {
  return { bt: g.y(160), html: `<div class="blk cl">${photoHtml(slide, 'cl-fr')}${closingGroup(m, S, g, { mark: true })}</div>` };
}

/** The photograph over the room the words leave above them, edge to edge, cut to that room around its face. */
const photoRoom = (slide, cls = '') => (hasPhoto(slide) ? `<div class="cl-pw${cls}">${photoHtml(slide, 'cl-im')}</div>` : '');

function closingC(m, slide, g, S) {
  return { bt: hasPhoto(slide) ? g.y(150) : g.z.top, html: `<div class="blk cl">${photoRoom(slide)}${closingGroup(m, S, g, { rule: true })}</div>` };
}

function closingD(m, slide, g, S) {
  return { bt: hasPhoto(slide) ? 0 : g.z.top, html: `<div class="blk cl">${photoRoom(slide, ' fade')}${closingGroup(m, S, g, { mark: true })}</div>` };
}

function closingE(m, slide, g, S, { room, img }) {
  return {
    bt: room.top,
    html: `${hasPhoto(slide) ? img : ''}<div class="blk cl${room.hug ? ' hug' : ''}" style="bottom:${g.h - room.bottom}px">${closingGroup(m, S, g)}</div>`,
  };
}

/** What every closing slide shares, and each style's own: the group, the logo's tile, the action's block, the photograph. */
const CLOSING_CSS = (g, S, chip) => {
  // The photograph's room (C, D): the slide's width, as tall as the words leave it (at least a sixth of the slide).
  const room = `.cl-pw{position:relative;flex:1 1 0;min-height:${g.y(320)}px;margin:0 -${g.z.right}px 0 -${g.z.left}px;overflow:hidden}
.cl-im{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%}`;
  const own = {
    // The photograph over the whole slide, sharp; the card carries the words, and the slide's foot fades into the ground
    // where TikTok sets its caption.
    A: `.blk.cl{justify-content:flex-end}
.cw.card{align-self:stretch;align-items:flex-start;gap:${g.y(34)}px}
.cl-ov{position:absolute;left:0;right:0;bottom:0;height:${g.z.bottom + g.y(120)}px;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0),rgba(var(--bg-rgb),.92))}
.cl-line{font-family:'Heebo';font-weight:900;letter-spacing:-1px;line-height:1.06;color:var(--fg)}
.cl-act{font-family:'Assistant';font-weight:700;border-radius:999px}`,
    // The photograph in B's frame, wider than the words (the frame is no text, the bands are the words'), as tall as the
    // words leave it; the words on B's ground under it.
    B: `.blk.cl{gap:${g.y(48)}px}
.cl-fr{display:block;flex:1 1 0;min-height:${g.y(300)}px;width:calc(100% + ${2 * (g.z.left - g.hs(48))}px);margin:0 -${g.z.left - g.hs(48)}px;border-radius:12px;object-fit:cover;object-position:50% 30%}
.cl-line{font-family:'Karantina Headline';font-weight:700;line-height:.88;color:var(--fg)}
.cl-act{font-family:'Rubik';font-weight:800;border-radius:12px}`,
    // C: the photograph on top, under TikTok's tabs, the words on C's panel under it with a clear edge between.
    C: `.blk.cl{justify-content:flex-end;gap:${g.y(64)}px}
${room}
.st-C .cl-pw{margin:0 -${g.z.right - g.hs(56)}px 0 -${g.z.left - g.hs(56)}px;border-radius:${g.hs(44)}px}
.mk{display:block;width:96px;height:12px;background:var(--accent)}
.cl-line{font-family:'Rubik';font-weight:900;line-height:1.08;color:var(--fg)}
.cl-act{font-family:'Rubik';font-weight:800;border-radius:0}`,
    // D: the photograph from the top of the slide, fading into D's ground over its last stretch, the words on the ground.
    D: `.blk.cl{justify-content:flex-end;gap:${g.y(8)}px}
${room}
.cl-pw.fade::after{content:'';position:absolute;left:0;right:0;bottom:0;height:42%;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0),rgba(var(--bg-rgb),.75) 60%,rgba(var(--bg-rgb),1))}
.cl-line{font-family:'Karantina Headline';font-weight:700;line-height:.92;color:var(--fg)}
.cl-act{font-family:'Rubik';font-weight:800;border-radius:0}`,
    // E: the photograph unveiled; each line on a white box, the action's on a box of the colour.
    E: `.cw{align-items:center;text-align:center}
.cl-line{font-family:'Heebo';font-weight:800;line-height:1.24;letter-spacing:-.5px}
.cl-act{font-family:'Heebo';font-weight:800;line-height:1.3;background:none;padding:0}
.st-E .cl-act .ln{background:var(--chip);color:var(--chip-ink)}`,
  };
  return `
:root{--chip:${chip.bg};--chip-ink:${chip.ink}}
.cw{position:relative;z-index:1;display:flex;flex-direction:column;align-items:flex-start;gap:${g.y(40)}px;max-width:100%}
.cl-line{max-width:100%}
.cl-line mark.hi{background:linear-gradient(to bottom,transparent 14%,var(--chip) 14%,var(--chip) 97%,transparent 97%);color:var(--chip-ink);padding:0 .12em;margin:0 .04em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.cl-act{background:var(--chip);color:var(--chip-ink);line-height:1.2;padding:${g.hs(16)}px ${g.hs(34)}px;max-width:100%}
.lg{display:flex;align-items:center;justify-content:center;background:#FFFFFF;border-radius:${g.hs(22)}px;padding:${g.hs(18)}px ${g.hs(28)}px;max-width:100%}
.lg.dark{background:#141414}
.lg img{display:block;height:${g.hs(92)}px;width:auto;max-width:${g.hs(380)}px;object-fit:contain}
/* No letter, box or tile on a closing slide has an outline or a shadow. */
.st.k-end *{text-shadow:none!important;-webkit-text-stroke:0!important;box-shadow:none!important}
${own[S.name]}
`;
};

/** The account's own follow slide (pack.json endSlide), which the posts made before the closing slide end on. */
function endHtml(m, g, S) {
  return {
    bt: g.y(560),
    html: `<div class="blk">${txt('h2', 'hl', S, 'title', m.title, g)}${txt('p', 'sub', S, 'sub', m.body, g)}<div class="handle"><bdi dir="ltr">@${esc(m.handle)}</bdi></div></div>`,
  };
}

const DRAW = { A: drawA, B: drawB, C: drawC, D: drawD, E: drawE };
const CSS = { A: CSS_A, B: CSS_B, C: CSS_C, D: CSS_D, E: CSS_E };

const base = (g, c, S) => `
:root{
  --bg:${c.bg}; --fg:${c.text}; --muted:${c.muted}; --accent:${c.accent}; --on-accent:${c.onAccent};
  --card:${c.card || c.bg}; --card-border:${c.cardBorder || 'transparent'};
  --bg-rgb:${rgbList(c.bg)}; --ink:${c.text}; --ink-rgb:${rgbList(c.text)}; --accent-rgb:${rgbList(c.accent)};
  --accent2:${c.muted}; --accent2-rgb:${rgbList(c.muted)}; --on-accent2:${c.bg}; --surface:${c.card || c.bg};
  --text:'${S.text.tbody.family}'; --headline:'${S.text.title.family}'; --display:'${S.text.title.family}'; --radius:${S.name === 'B' ? 12 : 28}px;
  --pt:${g.z.top}px; --pb:${g.z.bottom}px; --pr:${g.z.right}px; --pl:${g.z.left}px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:${g.h}px;overflow:hidden}
body{direction:rtl;text-align:right;background:var(--bg);color:var(--fg);font-family:var(--text),sans-serif;-webkit-font-smoothing:antialiased;font-kerning:normal;position:relative}
bdi{unicode-bidi:isolate}
.probe{position:absolute;top:-400px;left:-400px;font:700 40px 'Rubik';color:transparent}
.ph{position:absolute;top:0;left:0;width:100%;object-fit:cover;object-position:50% 30%;display:block}
.ph.split{display:flex;gap:6px;overflow:hidden}
.ph.split img{flex:1;min-width:0;height:100%;object-fit:cover}
.blk{position:absolute;right:${g.z.right}px;left:${g.z.left}px;top:var(--bt);bottom:${g.z.bottom}px;display:flex;flex-direction:column}
.blk>*{flex:none}
.blk>.gfx{flex:0 1 auto;min-height:0;display:flex;flex-direction:column}
.gfx>.vis{flex:1 1 auto;min-height:0}
.sf{white-space:pre-line;text-wrap:balance;overflow-wrap:normal;word-break:keep-all}
.sf.nb{white-space:normal}
mark.hi{color:inherit;background:none}
.src{color:var(--muted)}
.list{list-style:none;display:flex;flex-direction:column;gap:14px}
.handle{font:700 48px/1.2 var(--text);color:var(--accent)}
/* No outline and no shadow on any letter, the shared graphics' included: the text reads by where it sits. E's own
   lines in its "shadow" look are the one exception, set over this in CSS_E. */
.st *{text-shadow:none!important;-webkit-text-stroke:0!important}
/* A slide with no photograph: its text moves up, into the middle of the room the photograph left. */
.no-photo:not(.k-cover) .blk{justify-content:center}
/* The post's texture, behind everything else on a slide with no photograph. */
.texg{position:absolute;inset:0}
.s-instagram .vis{font-size:38px}
`;

// No slide is its own photograph blurred behind a frame of it: the blurred copy behind every framed or banded
// photograph (the owner, 2026-10-31: "at least add a blurred background, the same picture") is gone at the owner's
// word (2026-11-06: "no landscape images with blurred background"). A, B, D and E draw a slide's photograph over the
// whole slide, cut around its subject; C keeps its photograph on top and its light panel under it, by design.

/** The whole page of one styled slide. `slide.photo` (or `slide.split`) is its own photograph, when it has one. */
export function stylePage({ theme, size, slide: given, overlay = null }) {
  const st = theme.style;
  const slide0 = st.name === 'A' ? { ...given, fullPhoto: true } : given;
  // A post's closing slide (its own design above).
  const closing = given.kind === 'end' && Boolean(given.closing);
  // E's text look (resolveStyle: "box" unless the pack asks for "shadow"). A closing slide is set on E's boxes in either
  // look: the "shadow" look is an edge and a shadow, and no closing slide has either.
  const look = st.name === 'E' ? (closing || st.text === 'box' ? 'box' : 'shadow') : null;
  const slide = look ? { ...slide0, textLook: look } : slide0;
  const S = STYLES[st.name];
  const g = geo(size, overlay, st.name);
  const m = slideModel(slide);
  // A slide with no photograph on its post's texture is the post's text designed (drawText), in every style.
  const textMode = !hasPhoto(slide) && Boolean(slide.texture) && m.kind !== 'end';
  const d0 = textMode ? drawText(m, slide, g, S) : DRAW[st.name](m, slide, g, S);
  // The account's old follow slide on a photograph of the post, under a veil of the style's own ground, so its words
  // read as they do on the ground: no slide of a post is a bare dark ground (the owner's call). A post's closing slide
  // shows its photograph as its style's design says.
  const d = m.kind === 'end' && !closing && slide.photo
    ? { ...d0, html: `<img src="${slide.photo}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><div style="position:absolute;inset:0;background:rgba(var(--bg-rgb),.78)"></div>${d0.html}` }
    : d0;
  // A slide with no photograph stands on the post's texture (src/render/textures.js), never on a flat ground.
  const ground = !hasPhoto(slide) && slide.texture ? `<div class="texg" style="${textureCss({ ...slide.texture, dark: S.dark !== false }, { ground: st.colors.bg, text: st.colors.text, accent: st.colors.accent }, 1080, g.h)}"></div>` : '';
  const families = familiesOf(st.name);
  const karantina = families.includes('Karantina');
  const z = g.z;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>${esc(slide.title || slide.hook || '')}</title>
<style>
${fontFaces(families)}
${karantina ? headlineFaces('Karantina') : ''}
${base(g, st.colors, S)}
${CSS[st.name](g, S)}
${VISUAL_CSS}
${closing ? CLOSING_CSS(g, S, chipOf(st.colors, st.name)) : ''}
${textMode ? `${CSS_TEXT(g, S)}
${cardColors(st.colors)}` : ''}
</style></head>
<body class="st st-${st.name} k-${slide.kind === 'cover' ? 'cover' : slide.kind === 'end' ? 'end' : 'item'} s-${size}${hasPhoto(slide) ? ' has-photo' : ' no-photo'}${slide.fullPhoto && hasPhoto(slide) ? ' full-photo' : ''}${look && !textMode ? ` tx-${look}` : ''}${ground ? ` on-texture tex-${slide.texture.kind}` : ''}" style="--bt:${d.bt}px" data-style="${st.name}" data-safe="${z.top},${z.right},${z.bottom},${z.left}"${d.lift != null ? ` data-lift="${d.lift}"` : ''} data-outline="0"${closing ? ' data-closing="1"' : ''}>
${ground}${d.html}
<div class="probe">א</div>
</body></html>`;
}

export { STYLES, resolveStyle, themeColors };
