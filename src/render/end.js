import { esc, he, ICON, padFor, page, SIZES } from './html.js';
import { OVERLAY, zonesFor } from '../rules/overlay.js';

// The closing slides of the older templates (an account with no slide style: the operator's own accounts; every
// customer's account is drawn in a style, src/render/styles, which draws its own).
//
// The account's own follow slide (pack.json "endSlide"): one fixed line asking to follow, in place of a call to action
// on the last content slide, which posts made before the closing slide still end on. It is the account's own approved
// text, not a claim, so it is drawn after the fact gate and is not part of the post's token. "{handle}" in it becomes
// the handle.
//
// A post's closing slide (src/pipeline/closing.js), closingPage: one simple design for every older template, in the
// account's own colours and faces. The post's photograph, sharp, from the top of the slide over all the room the words
// leave, cut to that room around its face, fading into the theme's ground at its foot; the words on the ground, so
// they read as they were designed to (no outline and no shadow on anything, which these templates otherwise draw on
// text over a picture): the account's logo first when it has one, on its own tile; the line in the display face; the
// action under it on the accent, in the ink the theme checked on it. The frame keeps
// out of TikTok's bands on all four sides (src/rules/overlay.js SAFE_ZONES, or the template's wider padding), and the
// renderer measures every line against all four (data-safe): a long line can never reach the button rail.

const END_CSS = `
.end-frame{justify-content:center;align-items:center;text-align:center}
.end{display:flex;flex-direction:column;align-items:center;gap:48px;max-width:100%}
.end-title{font:800 112px/1.06 var(--headline);color:var(--ink);max-height:560px;text-wrap:balance}
.s-instagram .end-title{font-size:90px;max-height:400px}
.end-body{font:500 50px/1.35 var(--text);color:var(--muted);max-height:300px;text-wrap:balance}
.s-instagram .end-body{font-size:42px;max-height:220px}
.end-handle{display:inline-flex;align-items:center;gap:18px;padding:22px 46px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 56px var(--text)}
.s-instagram .end-handle{font-size:46px;padding:18px 38px}
.end-handle .icon{width:48px;height:48px}
`;

const handleRun = (handle) => `<bdi dir="ltr">@${esc(handle)}</bdi>`;
const withHandle = (text, handle) => String(text || '').split('{handle}').map((part) => he(part)).join(handleRun(handle));

/**
 * A closing slide's action (src/pipeline/closing.js closingActions) as one run: its words, and the address or the handle
 * beside them kept left to right.
 */
export const actionHtml = (a) => (a ? `${he(a.lead || a.text || '')}${a.chip ? ` <bdi dir="ltr">${esc(a.chip)}</bdi>` : ''}` : '');

/** The account's own follow slide (pack.json endSlide), as template parts for page(). */
export function endParts(pack) {
  const e = pack.meta.endSlide || {};
  const handle = pack.meta.handle;
  return {
    css: END_CSS,
    html: `<div class="frame end-frame"><div class="end"><div class="end-title fit">${withHandle(e.title, handle)}</div>${e.body ? `<div class="end-body fit">${withHandle(e.body, handle)}</div>` : ''}<div class="end-handle"><span class="icon">${ICON.arrow}</span>${handleRun(handle)}</div></div></div>`,
  };
}

/** The frame of an older template's closing slide on one platform: its padding, or TikTok's bands where wider. */
export function closingPad(size, overlay = OVERLAY) {
  const p = padFor(size, overlay);
  const z = zonesFor(size, overlay, SIZES[size].h);
  return { top: Math.max(p.top, z.top), right: Math.max(p.right, z.right), bottom: Math.max(p.bottom, z.bottom), left: Math.max(p.left, z.left) };
}

const CLOSING_CSS = (pad, ig, h) => {
  const s = (px) => Math.round(ig ? px * 0.85 : px);
  return `
.cl-frame{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;justify-content:flex-end;gap:${s(12)}px;padding:${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px}
.cl-frame:not(:has(.cl-pw)){justify-content:center}
.cl-pw{position:relative;flex:1 1 0;min-height:${ig ? 220 : 320}px;margin:-${pad.top}px -${pad.right}px 0 -${pad.left}px;overflow:hidden}
.cl-pw::after{content:'';position:absolute;left:0;right:0;bottom:0;height:40%;background:linear-gradient(to bottom,rgba(var(--bg-rgb),0),rgba(var(--bg-rgb),.75) 60%,rgba(var(--bg-rgb),1))}
.cl-ph{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 30%}
.cw{position:relative;z-index:1;display:flex;flex-direction:column;align-items:flex-start;gap:${s(40)}px;max-height:${h}px}
.cl-line{font:800 ${s(100)}px/1.08 var(--headline);font-synthesis:none;color:var(--ink);max-width:100%;max-height:${Math.ceil(s(100) * 1.08 * 4) + 8}px;text-wrap:balance}
.cl-act{font:700 ${s(42)}px/1.25 var(--text);font-synthesis:none;background:var(--accent);color:var(--on-accent);border-radius:var(--radius);padding:${s(16)}px ${s(34)}px;max-width:100%;max-height:${Math.ceil(s(42) * 1.25 * 2 + s(32)) + 4}px}
.lg{display:flex;align-items:center;justify-content:center;background:#FFFFFF;border-radius:${s(22)}px;padding:${s(18)}px ${s(28)}px;max-width:100%}
.lg.dark{background:#141414}
.lg img{display:block;height:${s(92)}px;width:auto;max-width:${s(380)}px;object-fit:contain}
/* No letter, box or tile on a closing slide has an outline or a shadow. */
.cl,.cl *{text-shadow:none!important;-webkit-text-stroke:0!important;box-shadow:none!important}
`;
};

/**
 * An older template's closing slide, the whole page: { pack, size, closing, action } (this platform's), the account's
 * logo and the photograph it stands on as data URIs, where the photograph's face is (photoPos), and the account's
 * overlay rules. The page is drawn with no outline (data-outline 0) and every band checked (data-safe).
 */
export function closingPage({ pack, size, closing, action, logo = null, photo = null, photoPos = null, overlay = OVERLAY }) {
  const ig = size === 'instagram';
  const pad = closingPad(size, overlay);
  const line = closing.line ? `<div class="cl-line fit">${he(closing.line)}</div>` : '';
  // The action keeps its proportion to the line (render.js): a line set smaller to fit sets it smaller, to its floor.
  const act = action ? `<div class="cl-act fit" data-of=".cl-line" data-ratio="0.42" data-floor="${ig ? 30 : 34}">${actionHtml(action)}</div>` : '';
  const parts = {
    css: CLOSING_CSS(pad, ig, SIZES[size].h),
    bodyClass: 'cl',
    safe: [pad.top, pad.right, pad.bottom, pad.left],
    closing: true,
    html: `<div class="cl-frame">${photo ? `<div class="cl-pw"><img class="cl-ph" src="${photo}" alt=""${photoPos ? ` style="object-position:${esc(photoPos)}"` : ''}></div>` : ''}<div class="cw">${logo ? `<div class="lg"><img class="logo" src="${logo}" alt=""></div>` : ''}${line}${act}</div></div>`,
  };
  return page({ theme: pack.theme, size, slide: { kind: 'end', title: closing.line || '' }, parts, overlay: { ...(overlay || OVERLAY), outline: 0 } });
}
