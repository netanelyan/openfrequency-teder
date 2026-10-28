import { esc, he } from '../html.js';
import { fontFaces, headlineFaces } from '../fonts.js';
import { rgbList } from '../color.js';
import { VISUAL_CSS, visualHtml } from '../visuals.js';
import { zonesFor } from '../../rules/overlay.js';
import { familiesOf, resolveStyle, STYLES, themeColors } from './tokens.js';
import { displayText, slideModel, sourcesOf, textHtml } from './model.js';
import { BODY_FLOOR, sidesOf, STEP } from './fit.js';

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

/**
 * One text block the renderer fits: its size, its floor, the lines it may take, in data attributes. In a style whose
 * text is one inline run (E) its words are in a span, for the box behind each line; `pre` is HTML set before them in
 * the same run (E's ranking place).
 */
function txt(tag, cls, S, field, text, g, { highlight = '', pre = '' } = {}) {
  const spec = S.text[field];
  if (!String(text || '').trim()) return '';
  const breaks = spec.breaks !== false;
  const px = HEADS.has(field) ? g.hs(spec.px) : spec.px;
  const floor = Math.round(HEADS.has(field) ? g.hs(spec.floor || spec.px * BODY_FLOOR) : spec.floor || spec.px * BODY_FLOOR);
  const writer = displayText(text, { breaks }).split('\n').length;
  const max = spec.lines || 99;
  const want = breaks ? Math.min(writer, max) : max;
  const words = `${pre}${textHtml(text, { breaks, highlight })}`;
  return `<${tag} class="sf ${cls}${breaks ? '' : ' nb'}" style="font-size:${px}px" data-px="${px}" data-floor="${floor}" data-max="${max}" data-want="${want}" data-step="${HEADS.has(field) ? STEP : 2}">${S.inline ? ln(words) : words}</${tag}>`;
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
const gfx = (m) => (m.visual ? `<div class="gfx">${visualHtml(m.visual)}</div>` : '');
const unitOf = (v) => (v ? [v.pre, v.post].filter(Boolean) : []);

/* ------------------------------------------------------------------------------------------------ A: editorial */

function drawA(m, slide, g, S) {
  const photo = hasPhoto(slide);
  if (m.kind === 'cover') {
    return {
      bt: photo ? g.y(260) : g.y(460),
      html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk cov${photo ? '' : ' mid'}">${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}</div>`,
    };
  }
  if (m.kind === 'end') return endHtml(m, g, S);
  if (m.kind === 'number') {
    const v = m.value;
    const row = m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(104), 'num sm')}</div>`).join('')}</div>`
      : `<div class="nrow">${v.pre ? `<span class="unit">${he(v.pre)}</span>` : ''}${bigNum(v.num, g.hs(S.text.number.px))}${v.post ? `<span class="unit">${he(v.post)}</span>` : ''}</div>`;
    return {
      bt: photo ? g.y(660) : g.y(280),
      html: `${photoHtml(slide)}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${txt('h2', 'hl', S, 'ntitle', m.title, g, { highlight: m.highlight })}${m.meta ? `<div class="meta">${he(m.meta)}</div>` : ''}
<div class="card">${m.kicker ? `<div class="clbl">${he(m.kicker)}</div>` : ''}${row}${m.body ? `<i class="rule"></i>${txt('p', 'bd', S, 'body', m.body, g)}` : ''}</div>${ctaHtml(m)}${srcHtml(slide)}</div>`,
    };
  }
  // theme.options.fullPhoto (a store's demo, src/demos/build.js): the slide's photograph fills it, as the cover's
  // does, and the text stands at the bottom, over the fade into the ground.
  return {
    bt: photo ? (slide.fullPhoto ? g.y(700) : g.y(660)) : g.y(280),
    html: `${photoHtml(slide, slide.fullPhoto ? 'ph full' : 'ph')}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${txt('h2', 'hl', S, 'title', m.title, g, { highlight: m.highlight })}${gfx(m)}${m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_A = (g, S) => `
.ph{height:${g.y(940)}px}
.ph.full{height:100%}
.ov{position:absolute;inset:0 0 auto 0;height:${g.y(940)}px;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0) ${g.y(520)}px,rgba(var(--bg-rgb),1) ${g.y(940)}px)}
.k-cover .ov{height:100%;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0) 35%,rgba(var(--bg-rgb),.92) 72%,rgba(var(--bg-rgb),1) 100%)}
.full-photo.k-item .ov{height:100%;background:linear-gradient(to bottom,rgba(var(--bg-rgb),.05) 0%,rgba(var(--bg-rgb),.25) 30%,rgba(var(--bg-rgb),.9) 60%,rgba(var(--bg-rgb),.97) 100%)}
.full-photo.k-item .blk{justify-content:flex-end}
.blk{gap:${g.y(36)}px}
.blk.cov{justify-content:flex-end;bottom:${g.y(460)}px}
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
      html: `${photoHtml(slide, 'ph full')}${photo ? '<div class="ov" data-scrim data-min="0.45" data-max="0.7"></div>' : ''}
<div class="blk cov">${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}</div>
<div class="cue">החליקו ←</div>`,
    };
  }
  if (m.kind === 'end') return endHtml(m, g, S);
  const framed = photo ? photoHtml(slide, 'fr') : '';
  if (m.kind === 'number') {
    const v = m.value;
    const big = m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(200))}</div>`).join('')}</div>`
      : `<div class="nrow">${bigNum(v.num, g.hs(S.text.number.px))}${unitOf(v).length ? `<span class="unit">${he(unitOf(v).join(' '))}</span>` : ''}</div>`;
    return {
      bt: g.y(260),
      html: `<div class="blk">${big}${txt('div', 'cap', S, 'ntitle', m.title, g, { highlight: m.highlight })}${framed}${txt('p', 'bd', S, 'body', m.body, g)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
    };
  }
  return {
    bt: g.y(260),
    html: `<div class="blk">${txt('h2', 'hl', S, 'title', m.title, g, { highlight: m.highlight })}${framed || gfx(m)}${m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_B = (g, S) => `
.ph.full{height:100%}
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
  if (m.kind === 'end') return endHtml(m, g, S);
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
<div class="blk">${num}${txt('h2', 'hl', S, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: m.highlight })}${body}${m.kind === 'number' ? '' : gfx(m)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_C = (g, S) => `
.ph{height:calc(var(--bt) - ${g.y(80)}px)}
.k-item .ph{height:calc(var(--bt) - ${g.y(120)}px)}
.blk{gap:${g.y(32)}px}
.blk.cov{gap:${g.y(36)}px}
.blk.cov.keyed{bottom:${g.z.bottom + 36 + g.y(20)}px}
.bar{display:block;width:96px;height:12px;background:var(--accent)}
.hl{font-family:'Rubik';font-weight:900;line-height:1.04;color:var(--fg)}
.k-item .hl{line-height:1.08}
.hl mark.hi{background:none;color:var(--accent)}
.sub{font:500 ${S.text.sub.px}px/1.35 'Rubik';color:var(--muted)}
.key{position:absolute;right:${g.z.right}px;left:${g.z.left}px;bottom:${g.z.bottom}px;font:800 30px/1.2 'Rubik';color:var(--accent)}
.chip{position:absolute;right:${g.z.right}px;top:calc(var(--bt) - ${g.y(192)}px);max-width:${1080 - g.z.left - g.z.right}px;font:900 ${g.hs(S.text.label.px)}px/1.2 'Rubik';color:#fff;background:var(--accent);padding:16px 36px;white-space:nowrap;overflow:hidden}
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
      bt: photo ? g.y(880) : g.y(560),
      lift: photo ? g.y(560) : null,
      html: `${photoHtml(slide)}${photo ? '<div class="ov"></div>' : ''}
<div class="blk cov">${txt('h1', 'hl', S, 'hook', m.hook, g, { highlight: m.highlight })}${txt('p', 'sub', S, 'sub', m.sub, g)}<i class="bar"></i></div>`,
    };
  }
  if (m.kind === 'end') return endHtml(m, g, S);
  const chip = m.label ? `<span class="chip">${he(m.label)}</span>` : '';
  const num = m.kind === 'number'
    ? m.sides
      ? `<div class="sides">${m.sides.map((x) => `<div class="side"><span>${he(x.who)}</span>${bigNum(x.value, g.hs(150))}</div>`).join('')}</div>`
      : `<div class="nrow">${bigNum(m.value.num, g.hs(S.text.number.px))}${unitOf(m.value).length || m.kicker ? `<span class="unit">${he(unitOf(m.value).join(' ') || m.kicker)}</span>` : ''}</div>`
    : '';
  const body = m.kind === 'number' ? txt('p', 'bd', S, 'body', m.body, g) : m.list ? listHtml(m.body, S, g) : txt('p', 'bd', S, 'tbody', m.body, g);
  return {
    bt: photo ? g.y(800) : g.y(300),
    lift: photo ? g.y(420) : null,
    html: `${photoHtml(slide)}${photo ? '<div class="ov"></div>' : ''}
<div class="blk">${chip}${txt('h2', 'hl', S, m.kind === 'number' ? 'ntitle' : 'title', m.title, g, { highlight: m.highlight })}${num}${body}${m.kind === 'number' ? '' : gfx(m)}${ctaHtml(m)}${srcHtml(slide)}</div>`,
  };
}

const CSS_D = (g, S) => `
.ph{height:${g.y(1000)}px}
.k-cover .ph{height:${g.y(1120)}px}
.ov{position:absolute;inset:0 0 auto 0;height:${g.y(1000)}px;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0) ${g.y(520)}px,rgba(var(--bg-rgb),1) ${g.y(1000)}px)}
.k-cover .ov{height:${g.y(1120)}px;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0) ${g.y(560)}px,rgba(var(--bg-rgb),.92) ${g.y(1120)}px)}
.blk{gap:${g.y(28)}px}
.blk.cov{gap:${g.y(8)}px}
.hl{font-family:'Karantina Headline';font-weight:700;line-height:.9;color:var(--fg)}
.k-item .hl{line-height:.92}
${BAND}
.sub{font:500 ${S.text.sub.px}px/1.4 'Rubik';color:var(--muted);margin-top:${g.y(28)}px}
.bar{display:block;width:88px;height:6px;background:var(--accent);margin-top:${g.y(20)}px}
.chip{align-self:flex-start;font:800 ${S.text.label.px}px/1.2 'Rubik';color:var(--on-accent);background:var(--accent);padding:6px 18px;white-space:nowrap}
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

// How E shows a slide's photograph: over the whole slide when it is close to the slide's shape (a crop keeps at least
// four fifths of its width), else whole, the slide's width, in the middle of a black slide, as TikTok shows a photo
// uploaded at its own shape. A landscape press photograph cut to 9:16 kept a third of itself, blown up three times:
// soft, and often the wrong third. `slide.photoSize` is the photograph's own { w, h } (render.js).
export function fitE(slide, g) {
  const sz = slide.photoSize;
  if (!slide.photo || !sz?.w || !sz?.h) return { mode: 'cover' };
  const a = sz.w / sz.h;
  // Every slide is the whole screen of picture: a photograph fills it, cut around its face, whatever its shape (TikTok's
  // own guidance and every slideshow guide: 9:16, full screen; a landscape one shown whole looked like a letterbox to
  // the owner). Only one too small to fill without blowing it up past twice its size is shown whole, over a blurred,
  // darkened copy of itself that fills the rest (stylePage's backdrop): never a black band.
  const grow = Math.max(1080 / sz.w, g.h / sz.h);
  if (grow <= 2) return { mode: 'cover' };
  const ph = Math.min(g.h, Math.round(1080 / a));
  return { mode: 'contain', top: Math.round((g.h - ph) / 2), ph };
}

// The room E's text has, top and bottom in px, and whether it hugs the photograph from above (`hug`). The middle of
// the slide, as the app's text tool sets it, unless the photograph's screen found a face there: then the part of the
// slide above the face or below it, whichever is larger, so the words never cover the eyes. A photograph shown whole
// on black whose face (or whose unknown face) is in the middle takes its text on the black above it, close to its top
// edge, when the black has the room. object-position aligns the same point of the photograph and of the slide, so on
// a full slide the face's place on the slide is its place in the photograph (focusOf: "x% y%").
function roomE(slide, g, fit) {
  const top = g.z.top;
  const bottom = g.h - g.z.bottom;
  const need = g.y(560);
  const fy = slide.photo ? Number(/\s(\d+(?:\.\d+)?)%\s*$/.exec(String(slide.photoPos || ''))?.[1]) : NaN;
  const known = Number.isFinite(fy);
  // A block too tall for the black around the photograph (render.js tries this before it gives the photograph up).
  if (slide.textOver) return { top, bottom };
  if (fit.mode === 'contain') {
    const face = known ? fit.top + (fy / 100) * fit.ph : null;
    const clear = Math.round(fit.ph * 0.22);
    const mid = (top + bottom) / 2;
    // The face is clear of the middle: the text stays there, over the photograph.
    if (known && Math.abs(face - mid) > clear + need / 2) return { top, bottom };
    const above = { top, bottom: fit.top - g.y(28), hug: true };
    if (above.bottom - above.top >= g.y(300)) return above;
    const below = { top: fit.top + fit.ph + g.y(28), bottom };
    if (below.bottom - below.top >= g.y(300)) return below;
    if (!known) return { top, bottom };
  } else if (!known) return { top, bottom };
  const face = fit.mode === 'contain' ? fit.top + (fy / 100) * fit.ph : (fy / 100) * g.h;
  // About half a face's height on a portrait drawn to fill the slide: what is kept clear above or below its centre.
  const clear = fit.mode === 'contain' ? Math.round(fit.ph * 0.22) : g.y(260);
  const below = { top: Math.max(top, Math.min(bottom - need, face + clear)), bottom };
  const above = { top, bottom: Math.min(bottom, Math.max(top + need, face - clear)) };
  return below.bottom - below.top >= above.bottom - above.top ? below : above;
}

function drawE(m, slide, g, S) {
  const photo = hasPhoto(slide);
  const fit = fitE(slide, g);
  const room = roomE(slide, g, fit);
  // A soft shade behind the text only, so white text reads on a bright photograph: its depth is measured on the
  // photograph by the renderer (render.js, data-scrim) between these bounds, so a dark picture keeps all of its colour.
  // Text on the black around a photograph shown whole needs none. A box carries its own ground: under it the shade is
  // the faintest.
  const box = slide.textLook !== 'shadow';
  const onBlack = fit.mode === 'contain' && (room.bottom <= fit.top || room.top >= fit.top + fit.ph);
  const [lo, hi] = onBlack ? [0, 0] : box ? [0.06, 0.14] : [0.12, 0.42];
  const mid = Math.round((room.top + room.bottom) / 2);
  const img = fit.mode === 'contain'
    ? `<img class="ph fit" src="${slide.photo}" alt="" style="top:${fit.top}px;height:${fit.ph}px">`
    : photoHtml(slide, 'ph full');
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
  if (m.kind === 'end') return { ...endHtml(m, g, S), bt: g.z.top };
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
.ph.fit{object-fit:cover;object-position:50% 50%}
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

/* --------------------------------------------------------------------------------------------- shared parts */

/** A body that is a list (places 10 to 6, an iceberg's layer): one item a line, as its kind is checked. */
function listHtml(body, S, g) {
  const ls = String(body || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return ls.length ? `<ul class="list">${ls.map((l) => `<li>${S.inline ? ln(he(displayText(l))) : he(displayText(l))}</li>`).join('')}</ul>` : '';
}

/** The closing slide: its line, and the handle the account is followed at. */
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
/* The backdrop: the slide's own photograph, blurred past recognition of detail, filling the slide behind the design. */
.bf{position:absolute;top:-80px;left:-80px;width:calc(100% + 160px);height:calc(100% + 160px);object-fit:cover;filter:blur(42px) saturate(1.15);transform:scale(1.04)}
.bfv{position:absolute;inset:0}
/* A slide with no photograph: its text moves up, into the middle of the room the photograph left. */
.no-photo:not(.k-cover) .blk{justify-content:center}
.s-instagram .vis{font-size:38px}
`;

/**
 * The slide's own photograph, blurred and darkened, over the whole slide behind the design: TikTok is a visual feed,
 * and a slide whose photograph sits in a frame, a top half or a band on a flat ground read as empty to the owner ("at
 * least add a blurred background, the same picture"). A to D keep their design over it, the ground's colour laid over
 * the blur so their words read as they did; E has it only behind a photograph too small to fill the slide. Never behind
 * a photograph that already fills the slide, and never a guess-who's answer (its cover has none of its own).
 */
function backdrop(name, m, slide, g, d) {
  if (!slide.photo || slide.split || m.kind === 'end') return d;
  const full = name === 'E' ? fitE(slide, g).mode === 'cover' : m.kind === 'cover' && name !== 'C';
  if (full) return d;
  const veil = name === 'E' ? 'rgba(0,0,0,.42)' : 'rgba(var(--bg-rgb),.66)';
  return { ...d, html: `<img class="bf" src="${slide.photo}" alt=""><div class="bfv" style="background:${veil}"></div>${d.html}` };
}

/** The whole page of one styled slide. `slide.photo` (or `slide.split`) is its own photograph, when it has one. */
export function stylePage({ theme, size, slide: given, overlay = null }) {
  const st = theme.style;
  const slide0 = theme.options?.fullPhoto && st.name === 'A' ? { ...given, fullPhoto: true } : given;
  // E's text look (resolveStyle: "box" unless the pack asks for "shadow").
  const look = st.name === 'E' ? (st.text === 'box' ? 'box' : 'shadow') : null;
  const slide = look ? { ...slide0, textLook: look } : slide0;
  const S = STYLES[st.name];
  const g = geo(size, overlay, st.name);
  const m = slideModel(slide);
  const d0 = DRAW[st.name](m, slide, g, S);
  // The closing slide on a photograph of the post, under a veil of the style's own ground, so its words read as they do
  // on the ground: no slide of a post is a bare dark ground (the owner's call).
  const d = m.kind === 'end' && slide.photo
    ? { ...d0, html: `<img src="${slide.photo}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"><div style="position:absolute;inset:0;background:rgba(var(--bg-rgb),.78)"></div>${d0.html}` }
    : backdrop(st.name, m, slide, g, d0);
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
</style></head>
<body class="st st-${st.name} k-${slide.kind === 'cover' ? 'cover' : slide.kind === 'end' ? 'end' : 'item'} s-${size}${hasPhoto(slide) ? ' has-photo' : ' no-photo'}${slide.fullPhoto && hasPhoto(slide) ? ' full-photo' : ''}${look ? ` tx-${look}` : ''}" style="--bt:${d.bt}px" data-style="${st.name}" data-safe="${z.top},${z.right},${z.bottom},${z.left}"${d.lift != null ? ` data-lift="${d.lift}"` : ''} data-outline="0">
${d.html}
<div class="probe">א</div>
</body></html>`;
}

export { STYLES, resolveStyle, themeColors };
