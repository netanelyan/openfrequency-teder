import { bestInk, rgbList } from './color.js';
import { fontFaces, headlineFaces, headlineFamily } from './fonts.js';
import { VISUAL_CSS } from './visuals.js';
import { OVERLAY } from '../rules/overlay.js';

// The page every slide is drawn on, whatever the template.
//
// HARD RULE 8: right to left at the root, lang="he", so bidi resolves once and
// every run inherits it. A Latin run inside a Hebrew line (a product name, a
// number with a unit) is isolated with <bdi> so neighbouring punctuation stays on
// the right side of it.
//
// Two sizes, one design: TikTok is 1080x1920 with safe zones for the player's
// own furniture (the search bar on top, the caption and the button rail at the
// bottom and on the right); Instagram is 1080x1350, what the feed crops to.
//
// The account's safe zone (pack.json overlay.safeZone: no text in the top 10% or
// the bottom 20% by default) widens the padding where it asks for more than the
// platform does, so the layout keeps text out of it; the renderer then measures
// every line of text and refuses a slide with one inside it (render.js).

export const SIZES = {
  // TikTok draws its tabs at the top, its buttons down the right edge (where a Hebrew line starts) and the caption,
  // the account and the sound across the bottom: nothing of the slide's own goes there.
  tiktok: { w: 1080, h: 1920, pad: { top: 250, bottom: 560, right: 190, left: 100 } },
  instagram: { w: 1080, h: 1350, pad: { top: 96, bottom: 96, right: 92, left: 92 } },
};

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// A run joins words with a space ("UFC 193", "Better Place") and parts of a name with a
// point, a colon, a slash or a dash ("monday.com"), never across a sentence's end: as
// one run, "Gnrgy. 450,000" put the period and half the number on the wrong side.
// Accented letters are Latin too: "L'Équipe" came out "quipeÉ'L" when the run stopped at the É and the apostrophe.
// A slash command keeps its slash: "/clear" came out "clear/".
const LATIN_RUN = /((?:(?<![^\s-])\/(?=[A-Za-z]))?[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F](?:[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9+#&_]|['’](?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F])|[.:/=-](?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9_])|-(?=-[A-Za-z])|\(\)|[.,;:!?](?= [A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F])|(?<![.!?]) (?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9]|--?[A-Za-z])|(?<=[.,;:!?]) (?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]))*)/;

/**
 * Escape, and isolate every Latin run so bidi cannot reorder punctuation around it.
 * The runs are found in the raw text and each piece escaped after: finding them in
 * escaped text would wrap the "quot" of &quot; and break ש"ח, צה"ל or AT&T.
 */
export function he(text) {
  return String(text ?? '')
    .split(LATIN_RUN)
    .map((part, i) => (i % 2 ? `<bdi>${esc(part)}</bdi>` : esc(part)))
    .join('');
}

/** The first number in a text with its unit, for templates that set one large. */
export function leadNumber(text) {
  const m = /(₪\s?)?(\d+(?:[.,]\d+)*)(\s?%|\s?₪)?/.exec(String(text || ''));
  return m ? { value: m[2], pre: (m[1] || '').trim(), post: (m[3] || '').trim() } : null;
}

/**
 * A title that opens with its number: the number, to draw big, and the rest of the
 * title without it. A number inside the title stays in it and nothing is drawn big:
 * drawing it big above a title that also holds it showed "7,703" twice, stacked.
 */
export function splitLead(text) {
  const t = String(text || '').trim();
  const m = /^(₪\s?)?(\d+(?:[.,]\d+)*)(\s?%|\s?₪)?(?![\d.,])/.exec(t);
  if (!m) return { lead: null, rest: t };
  return { lead: { value: m[2], pre: (m[1] || '').trim(), post: (m[3] || '').trim() }, rest: t.slice(m[0].length).replace(/^[\s:,.–-]+/, '').trim() };
}

export const two = (n) => String(n).padStart(2, '0');

/** Inline icons, drawn here so nothing is fetched. */
export const ICON = {
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z" fill="currentColor"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l7 7h-4.5v9h-5v-9H5z" fill="currentColor"/></svg>',
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z" fill="currentColor"/></svg>',
  leaf: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4C9 4 4 9.5 4 16c0 1.5.3 2.8.8 4 1.2-4.6 4.6-8.5 9.2-10.5-3.7 2.6-6.3 6.4-7 10.8C8.2 21 9.8 21.4 11.5 21.4 17.4 21.4 20 15.5 20 4z" fill="currentColor"/></svg>',
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.2l3.3 2.4-1.3 3.9H10l-1.3-3.9z" fill="currentColor"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

/** The padding of the frame on one platform: the platform's own, or the account's safe zone where that is wider. */
export function padFor(size, overlay = OVERLAY) {
  const geo = SIZES[size];
  const z = { ...OVERLAY.safeZone, ...(overlay?.safeZone || {}) };
  return { ...geo.pad, top: Math.max(geo.pad.top, Math.ceil(z.top * geo.h)), bottom: Math.max(geo.pad.bottom, Math.ceil(z.bottom * geo.h)) };
}

/** :root variables from a theme, shared by every template. */
export function rootCss(theme, size, overlay = OVERLAY) {
  const c = theme.colors;
  const geo = { ...SIZES[size], pad: padFor(size, overlay) };
  const onAccent = c.onAccent || bestInk(c.accent, c.ink, c.bg);
  const onAccent2 = bestInk(c.accent2, c.ink, c.bg);
  return `
:root{
  --w:${geo.w}px; --h:${geo.h}px;
  --pt:${geo.pad.top}px; --pb:${geo.pad.bottom}px; --pr:${geo.pad.right}px; --pl:${geo.pad.left}px;
  --bg:${c.bg}; --surface:${c.surface}; --ink:${c.ink}; --muted:${c.muted}; --accent:${c.accent}; --accent2:${c.accent2};
  --on-accent:${onAccent}; --on-accent2:${onAccent2};
  --bg-rgb:${rgbList(c.bg)}; --ink-rgb:${rgbList(c.ink)}; --accent-rgb:${rgbList(c.accent)}; --accent2-rgb:${rgbList(c.accent2)};
  --display:'${theme.fonts.display}'; --text:'${theme.fonts.text}'; --headline:${headlineFamily(theme.fonts.display)};
  --radius:${Number(theme.options?.radius ?? 28)}px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:var(--w);height:var(--h);overflow:hidden}
body{direction:rtl;text-align:right;background:var(--bg);color:var(--ink);font-family:var(--text),'Heebo',sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:'kern' 1;position:relative}
bdi{unicode-bidi:isolate}
.frame{position:absolute;inset:0;padding:var(--pt) var(--pr) var(--pb) var(--pl);display:flex;flex-direction:column}
.fit{overflow:hidden}
/* The writer breaks the lines on a slide by hand (src/rules/overlay.js): a break is kept, and a line too wide for its box still wraps. */
.hook,.sub,.title,.body,.rtitle,.rbody,.answer,.myth-text,.punch,.setup,.q,h1.fit,h2.fit,p.fit{white-space:pre-line;text-wrap:balance}
.probe{position:absolute;top:-400px;left:-400px;font-family:'Heebo';font-weight:700;font-size:40px;color:transparent}
.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%}
.scrim{position:absolute;inset:0;background:linear-gradient(to top, rgba(8,10,14,var(--scrim,0.82)) 0%, rgba(8,10,14,calc(var(--scrim,0.82)*0.85)) 45%, rgba(8,10,14,0) 85%)}
.icon svg{width:100%;height:100%;display:block}
body.has-photo{--ink:#ffffff;--muted:rgba(255,255,255,.84);--ink-rgb:255,255,255;color:#fff}
body.has-photo .frame{z-index:2}
.bgphoto{position:absolute;top:-60px;left:-60px;width:calc(100% + 120px);height:calc(100% + 120px);object-fit:cover;object-position:50% 30%;filter:blur(var(--bg-blur,14px)) saturate(1.1)}
.bgveil{position:absolute;inset:0;background:rgba(var(--bg-rgb),var(--bg-veil,.74))}
body.has-bg .frame{z-index:2}
body.has-bg .frame{text-shadow:0 2px 12px rgba(var(--bg-rgb),.95),0 0 3px rgba(var(--bg-rgb),.9)}
body.has-photo .frame{text-shadow:0 2px 14px rgba(0,0,0,.7),0 0 3px rgba(0,0,0,.55)}
.cta,.cta *,.end-handle,.end-handle *,.opinion,.duel .vs-dot{text-shadow:none}
/* A cover photograph too small to fill the slide (src/images/size.js): in a frame, over its own copy blurred to fill. */
.photo.fill{filter:blur(32px) saturate(1.15);transform:scale(1.2)}
.cframe{position:absolute;left:var(--pl);right:var(--pr);top:19%;aspect-ratio:4/5;border-radius:var(--radius);overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5),0 0 0 2px rgba(255,255,255,.18)}
.cframe img{width:100%;height:100%;object-fit:cover;object-position:50% 25%;display:block}
.split{position:absolute;inset:0;display:flex;gap:6px;background:var(--bg)}
.split .half{flex:1;min-width:0;height:100%;object-fit:cover;object-position:50% 22%}
body.no-handle .tag,body.no-handle .who,body.no-handle .kick,body.no-handle .stamp,body.no-handle .band{visibility:hidden}
`;
}

// Lines of text set in the display face take the headline family: the same face, or its
// composite with readable digits (fonts.js), and so do the small slide counters ("01 / 07"):
// at that size a crossbarred 7 reads as a letter. Big numbers on their own keep the face's digits.
const HEADLINE_CSS = '.hook,.title,.rtitle,.k-closer h2,.versus,.answer,.myth-text,.meme .punch,.vs .val,.q,.count,.cnt,.head .n{font-family:var(--headline)}';

/**
 * The whole page for one slide. `parts` is what a template returns: { css, html, bodyClass, bodyStyle }, and for a
 * closing slide (src/render/end.js closingPage) `safe`, the bands kept clear on all four sides in px, which the
 * renderer then measures every line against as it does a styled slide's, and `closing`, which has it measured as one.
 */
export function page({ theme, size, slide, parts, photo, photoPos = null, blur = false, bg = null, split = null, splitPos = null, overlay = OVERLAY, framed = false }) {
  const zone = { ...OVERLAY.safeZone, ...(overlay?.safeZone || {}) };
  const outline = Number(overlay?.outline ?? OVERLAY.outline);
  const at = (pos) => (pos ? ` style="object-position:${esc(pos)}"` : '');
  // Behind a slide with no photograph of its own, the account's background photograph, blurred and veiled in the
  // theme's own ground colour so its text keeps the contrast it was designed with.
  const backdrop = bg && !photo && !split;
  const families = [theme.fonts.display, theme.fonts.text, 'Heebo'];
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>${esc(slide.title || slide.hook || '')}</title>
<style>
${fontFaces(families)}
${headlineFaces(theme.fonts.display)}
${rootCss(theme, size, overlay)}
${parts.css}
${VISUAL_CSS}
${HEADLINE_CSS}
</style></head>
<body class="t-${theme.template} v-${theme.variant || 'a'} k-${slide.kind} s-${size}${photo || split ? ' has-photo' : ''}${backdrop ? ' has-bg' : ''}${slide.noHandle ? ' no-handle' : ''}${slide.hasVisual ? ' has-vis' : ''}${parts.bodyClass ? ` ${parts.bodyClass}` : ''}"${parts.bodyStyle ? ` style="${esc(parts.bodyStyle)}"` : ''} data-zone-top="${zone.top}" data-zone-bottom="${zone.bottom}" data-outline="${outline}"${parts.safe ? ` data-safe="${parts.safe.map(Number).join(',')}"` : ''}${parts.closing ? ' data-closing="1"' : ''}>
${photo && framed ? `<img class="photo fill" src="${photo}" alt=""><div class="cframe"><img src="${photo}"${at(photoPos)} alt=""></div><div class="scrim" data-scrim></div>` : ''}
${photo && !framed ? `<img class="photo${blur ? ' blur' : ''}" src="${photo}"${blur ? '' : at(photoPos)} alt=""><div class="scrim" data-scrim></div>` : ''}
${split ? `<div class="split"><img class="half" src="${split[0]}"${at(splitPos?.[0])} alt=""><img class="half" src="${split[1]}"${at(splitPos?.[1])} alt=""></div><div class="scrim" data-scrim></div>` : ''}
${backdrop ? `<img class="bgphoto" src="${bg}" alt=""><div class="bgveil"${theme.options?.backgroundVeil != null ? ` style="--bg-veil:${Number(theme.options.backgroundVeil)}"` : ''}></div>` : ''}
${parts.html}
${slide.brand ? `<img class="brand" src="${slide.brand}" alt="">` : ''}
<div class="probe">א</div>
</body></html>`;
}

/** "מקור: X" under a slide, from its facts' sources. */
export function sourceLine(slide) {
  // An account can keep its sources off the slides (theme.options.sourceLine false); every fact still has its
  // source in the post's record, and a photograph's credit stays in the caption.
  if (slide.noSources) return '';
  const names = [...new Set((slide.sources || []).filter(Boolean))];
  // Each name is one isolated run with its own direction: "Wikipedia (English)"
  // must not have its parenthesis pulled across a Latin word by the Hebrew line.
  // An article after the source's name ("ויקיפדיה: 2002–03 UEFA Champions League")
  // is a run of its own: inside the Hebrew run its years came out reversed ("03–2002").
  const one = (n) => {
    const at = n.indexOf(': ');
    return at > 0 ? `<bdi dir="auto">${esc(n.slice(0, at))}</bdi>: <bdi dir="auto">${esc(n.slice(at + 2))}</bdi>` : `<bdi dir="auto">${esc(n)}</bdi>`;
  };
  return names.length ? `<div class="src">מקור: ${names.map(one).join(' · ')}</div>` : '';
}

/** The counter on a content slide: "2/5". */
export const counter = (slide) => (slide.kind === 'item' ? `<div class="count"><bdi>${slide.n}/${slide.of}</bdi></div>` : '');
