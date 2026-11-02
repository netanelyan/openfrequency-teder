import { esc, he, ICON } from './html.js';

// The closing slide an account adds to every post (pack.json "endSlide"): one fixed
// line asking to follow, in place of a call to action on the last content slide.
// It is the account's own approved text, not a claim, so it is drawn after the fact
// gate and is not part of the post's token. "{handle}" in it becomes the handle.

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

/**
 * The end slide's template parts for page(). With a post's closing slide (`closing`, and the `action` of this
 * platform), its line and its action; without one, the account's own follow slide (pack.json endSlide).
 */
export function endParts(pack, { closing = null, action = null } = {}) {
  if (closing) {
    return {
      css: END_CSS,
      html: `<div class="frame end-frame"><div class="end">${closing.line ? `<div class="end-title fit">${he(closing.line)}</div>` : ''}<div class="end-handle"><span class="icon">${ICON.arrow}</span>${actionHtml(action)}</div></div></div>`,
    };
  }
  const e = pack.meta.endSlide || {};
  const handle = pack.meta.handle;
  return {
    css: END_CSS,
    html: `<div class="frame end-frame"><div class="end"><div class="end-title fit">${withHandle(e.title, handle)}</div>${e.body ? `<div class="end-body fit">${withHandle(e.body, handle)}</div>` : ''}<div class="end-handle"><span class="icon">${ICON.arrow}</span>${handleRun(handle)}</div></div></div>`,
  };
}
