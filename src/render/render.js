import { chromium } from 'playwright';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../core/paths.js';
import { tokenOf } from '../verify/claims.js';
import { page, SIZES } from './html.js';
import { buildSlide, TEMPLATE_IMPL } from './templates/index.js';
import { endParts } from './end.js';
import { everyPhoto, kindName, ranksOf } from '../formats/kinds.js';
import { slideHasVisual } from './visuals.js';
import { focusOf } from '../images/safety.js';
import { overlayOf } from '../rules/overlay.js';
import { fillsCover, imageSize } from '../images/size.js';
import { stylePage } from './styles/index.js';
import { mediaSizes } from '../core/platforms.js';

// Slides to JPEG, through headless Chromium, because Hebrew needs real
// bidirectional layout and shaping and the browser is the thing that has it.
//
// What the renderer refuses, rather than quietly drawing:
//   - a post whose text does not hash to the token the fact gate issued
//     (HARD RULE 3: nothing is rendered that was not checked)
//   - a page whose fonts did not load (Hebrew would come out as tofu boxes, or
//     silently in a fallback face)
//   - a text block that still overflows at the smallest size the fit pass allows
//     (a cut line is a post nobody can act on after it is published)
//
// The render context has no network at all: every request is aborted, so a slide
// can only draw what was inlined into it (fonts and the photograph as data URIs).
//
// The legibility gate: theme colours are checked for contrast when the pack is
// validated; a photograph is measured here, and the scrim over it is set to the
// alpha that gets white type to 7:1 over the brightest patch where the type sits.
// Text that sits straight on a picture (a photograph, or the account's blurred
// backdrop) is outlined as well, in the dark of the scrim or the theme's own
// ground, so a bright patch anywhere behind a line cannot take it away
// (pack.json overlay.outline).
//
// The safe zone: no line of text may sit in the top or bottom band the account
// keeps clear (pack.json overlay.safeZone). The frame's padding keeps text out of
// it; every line is measured here, and a slide with one inside is refused.

let browserPromise = null;
let idle = null;

export function getBrowser() {
  browserPromise ??= chromium.launch({ args: ['--font-render-hinting=none'] });
  return browserPromise;
}

export async function closeBrowser() {
  if (idle) clearTimeout(idle);
  idle = null;
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

/**
 * At most this many pages are drawn at once (OF_RENDER_SLOTS, 2 by default). Every build shares the one Chromium,
 * and when a day's batch ends every post resumes together: without a queue each opened its own page at once, and the
 * memory went with it, on a server the website, the runner and the other services share.
 */
export const RENDER_SLOTS = Math.max(1, Math.floor(Number(process.env.OF_RENDER_SLOTS)) || 2);
let inUse = 0;
const waiting = [];

/** Run fn with one of the render slots, waiting for one when all are taken; first come, first served. */
export async function renderSlot(fn) {
  if (inUse < RENDER_SLOTS) inUse++;
  else await new Promise((r) => waiting.push(r)); // the slot is handed over by the one that leaves
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inUse--;
  }
}

/** The slots taken and the pages waiting for one, for the tests and the log. */
export const renderLoad = () => ({ inUse, waiting: waiting.length });

function keepWarm() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => closeBrowser(), 120_000);
  idle.unref?.();
}

export class RenderError extends Error {
  constructor(message, code = 'render') {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

const FIT_FLOOR = 0.6;
// The smallest size a post's content slides are evened down to (renderPost): below it, a slide keeps its own.
const EVEN_FLOOR = 0.8;

/** One HTML page to one JPEG, in its turn (renderSlot). Returns { file, fitted }. */
export const renderHtml = (html, opts) => renderSlot(() => drawHtml(html, opts));

async function drawHtml(html, { size, file, floor = FIT_FLOOR, scale = 1, lenient = false }) {
  // A preview (the style picker, a review) is drawn even when it does not fit, and says so: { warnings }.
  const warnings = [];
  const refuse = (message, code) => {
    if (lenient && ['overflow', 'safe_zone', 'fit'].includes(code)) warnings.push({ code, message });
    else throw new RenderError(message, code);
  };
  const geo = SIZES[size];
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: geo.w, height: geo.h }, deviceScaleFactor: 1, locale: 'he-IL', javaScriptEnabled: true });
  await context.route('**/*', (route) => route.abort());
  const tab = await context.newPage();
  try {
    await tab.setContent(html, { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);

    // Every declared face must load, and Hebrew set in it must measure differently
    // from Hebrew set in a face that cannot exist. document.fonts.check() is not
    // enough: it answers true when ANY face, fallback included, can draw the text.
    const font = await tab.evaluate(async () => {
      const faces = [...document.fonts];
      await Promise.all(faces.map((f) => f.load().catch(() => null)));
      const measure = (family) => {
        const el = document.createElement('span');
        el.textContent = 'בדיקת גופן בעברית 123';
        el.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:700 100px ${family}`;
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      };
      const families = [...new Set(faces.map((f) => f.family.replace(/['"]/g, '')))];
      return {
        broken: faces.filter((f) => f.status !== 'loaded').map((f) => `${f.family} ${f.weight}`),
        same: families.filter((fam) => Math.abs(measure(`'${fam}'`) - measure("'__no_such_font__'")) < 0.5),
      };
    });
    if (font.broken.length || font.same.length) {
      throw new RenderError(`fonts did not load (${[...font.broken, ...font.same].join(', ')}): refusing to render, the Hebrew would not be ours`, 'fonts');
    }

    // A guess-who's cover: its answer's photograph as a coarse mosaic, nine blocks across. Blurred, half the readers
    // still knew Zlatan at a glance; in blocks a hand wide there is colour and mood, and no face.
    await tab.evaluate(async () => {
      for (const img of document.querySelectorAll('img.photo.blur')) {
        await img.decode().catch(() => {});
        if (!img.naturalWidth) continue;
        const cols = 9;
        const rows = Math.max(1, Math.round((cols * innerHeight) / innerWidth));
        const c = document.createElement('canvas');
        c.width = cols;
        c.height = rows;
        const g = c.getContext('2d');
        const r = Math.max(cols / img.naturalWidth, rows / img.naturalHeight);
        g.drawImage(img, (cols - img.naturalWidth * r) / 2, (rows - img.naturalHeight * r) * 0.3, img.naturalWidth * r, img.naturalHeight * r);
        img.src = c.toDataURL('image/png');
        await img.decode().catch(() => {});
      }
    });

    // A photograph: measure the brightest band where the text sits and set the scrim.
    await tab.evaluate(() => {
      const img = document.querySelector('img.photo, img.ph.full');
      const scrim = document.querySelector('[data-scrim]');
      if (!img || !scrim) return;
      const W = 54;
      const H = Math.round((W * innerHeight) / innerWidth);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      const r = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      g.drawImage(img, (W - img.naturalWidth * r) / 2, (H - img.naturalHeight * r) / 2, img.naturalWidth * r, img.naturalHeight * r);
      const d = g.getImageData(0, 0, W, H).data;
      const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = (i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      // The text lives in the lower 70% on a photo cover; take the brightest
      // window one line tall across it.
      let worst = 0;
      const winH = Math.max(1, Math.round(H * 0.06));
      for (let y = Math.round(H * 0.3); y + winH <= H; y++) {
        for (let x0 = 0; x0 < W; x0 += Math.round(W / 4)) {
          let s = 0;
          let n = 0;
          for (let yy = y; yy < y + winH; yy++) for (let x = x0; x < Math.min(W, x0 + W / 2); x++) (s += lum((yy * W + x) * 4)), n++;
          worst = Math.max(worst, s / n);
        }
      }
      // White text over (1 - a) * L + a * scrim(~0.003) must reach 7:1:  1.05 / (L' + 0.05) >= 7
      const want = 1.05 / 7 - 0.05;
      const a = worst <= want ? 0.35 : Math.min(0.96, (worst - want) / (worst - 0.003));
      // A style sets its own layer (B's flat dark one, from 0.45): it is raised for a bright photograph, never past its
      // ceiling, so the photograph is still there to see.
      const lo = Number(scrim.dataset.min || 0.35);
      const hi = Number(scrim.dataset.max || 0.96);
      scrim.style.setProperty('--scrim', String(Math.min(hi, Math.max(lo, a)).toFixed(2)));
      document.body.dataset.scrim = String(a.toFixed(2));
    });

    // Latin words and numbers inside a Hebrew line, each isolated as one left-to-right run.
    // Left to the bidi algorithm, digits after a Latin word join its run, so "ל-Gnrgy. 450,000
    // דולר" came out as "Gnrgy.-ל" and "000,450" across a line break (a blind review caught
    // it). A run joins words with a space ("UFC 193", "Better Place") and digits with a
    // comma, a point, a colon or a dash, never across a sentence's end. Text already
    // isolated (a source name, a keyword, a handle) is left as it is.
    await tab.evaluate(() => {
      // An underscore is part of a name ("budget_tokens" came out "tokens_budget"), and so are the brackets of a call.
      // A command's flags are part of it: "npx frugon --demo" came out "demo--" when the dashes were left outside.
      const RUN = /(?:(?:(?<!\S)--?|(?<![^\s-])\/)(?=[A-Za-z]))?[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9$€£](?:[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9$€£%&+'’_]|[.,:/–=-](?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9_])|-(?=-[A-Za-z])|\(\)|[.,;:!?](?= [A-Za-zÀ-ÖØ-öø-ɏ])| (?=[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9$€£]|--?[A-Za-z]))*/g;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        // A node with no Hebrew is set right to left too: a graphic's "2003–04" came out "04–2003".
        if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9]/.test(n.nodeValue)) continue;
        if (n.parentElement.closest('bdi,.probe,style,script')) continue;
        // The page itself is dir="rtl"; an element inside it that sets its own direction is already isolated.
        const own = n.parentElement.closest('[dir]');
        if (own && own !== document.documentElement && own !== document.body) continue;
        nodes.push(n);
      }
      for (const n of nodes) {
        // A number and the word it counts stay on one line: a cover broke as "פותחים עסק? 5",
        // the 5 left dangling at the end of the line and "דברים" on the next.
        n.nodeValue = n.nodeValue.replace(/(\d) (?=[֐-׿])/g, '$1 ');
        const frag = document.createDocumentFragment();
        let at = 0;
        for (const m of n.nodeValue.matchAll(RUN)) {
          if (m.index > at) frag.append(n.nodeValue.slice(at, m.index));
          const b = document.createElement('bdi');
          b.dir = 'ltr';
          // A score, a range or a name with no space in it never breaks across lines ("3–0" broke as "3–" and "0").
          if (!/\s/.test(m[0])) b.style.whiteSpace = 'nowrap';
          b.textContent = m[0];
          frag.append(b);
          at = m.index + m[0].length;
        }
        frag.append(n.nodeValue.slice(at));
        n.replaceWith(frag);
      }
      // A run isolated when the page was built never breaks either: "GPT-5.6" wrapped at its hyphen, and the line
      // reversed the pieces ("GPT--ב 5.6").
      for (const b of document.querySelectorAll('bdi')) if (!/\s/.test(b.textContent)) b.style.whiteSpace = 'nowrap';
    });

    // A styled slide (src/render/styles): each text is set at its style's size and, while it takes more lines than
    // the writer broke it in (or more than the style allows), a step smaller, down to its floor; at the floor it may
    // take another line, never more than the style's. Then the block must fit its room: a block too tall moves up
    // where the style lets it (data-lift: over C's and D's photograph, which gets shorter in C), then its texts are
    // set smaller together down to their floors. What still does not fit is refused, and said which text it is.
    const styled = await tab.evaluate(({ scale }) => {
      const b = document.body;
      if (!b.dataset.style) return null;
      const lineCount = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const mids = [];
        for (const x of r.getClientRects()) {
          if (!x.width || !x.height) continue;
          const mid = (x.top + x.bottom) / 2;
          if (!mids.some((m) => Math.abs(m - mid) < fs * 0.45)) mids.push(mid);
        }
        return mids.length;
      };
      const sideways = (el) => {
        const box = el.getBoundingClientRect();
        const r = document.createRange();
        r.selectNodeContents(el);
        const ink = r.getBoundingClientRect();
        return ink.width > 0 && (ink.left < box.left - 2 || ink.right > box.right + 2);
      };
      const text = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
      const els = [...document.querySelectorAll('.sf')];
      const at = new Map();
      const set = (el, px) => {
        at.set(el, px);
        el.style.fontSize = `${px}px`;
      };
      const bad = [];
      // Words held together (the last two of a line, a number and the word it counts) are held only where they fit:
      // a pair wider than the slide at the floor is let go, and the text is set again, breaking like any other.
      const letGo = (el) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/ /g, ' ');
        for (const b of el.querySelectorAll('bdi')) if (/\s/.test(b.textContent)) b.style.whiteSpace = '';
      };
      const fitOne = (el) => {
        const d = el.dataset;
        const floor = Number(d.floor);
        let px = Math.max(floor, Number(d.px) * scale);
        set(el, px);
        while ((lineCount(el) > Number(d.want) || sideways(el)) && px > floor) {
          px = Math.max(floor, px - Number(d.step) * Math.min(1, scale + 0.2));
          set(el, px);
        }
      };
      for (const el of els) {
        fitOne(el);
        if (sideways(el) && !el.classList.contains('num')) {
          letGo(el);
          fitOne(el);
        }
      }
      // A number and its unit on one row: a long number is set smaller until the row fits the slide's width.
      for (const row of document.querySelectorAll('.nrow, .sides')) {
        const nums = [...row.querySelectorAll('.num')];
        const wide = () => {
          const box = row.getBoundingClientRect();
          return [...row.querySelectorAll('*')].some((c) => {
            const r = c.getBoundingClientRect();
            return r.width && (r.left < box.left - 2 || r.right > box.right + 2);
          });
        };
        while (wide() && nums.some((el) => at.get(el) > Number(el.dataset.floor))) {
          for (const el of nums) set(el, Math.max(Number(el.dataset.floor), at.get(el) - Number(el.dataset.step)));
        }
        if (wide()) bad.push({ code: 'fit', text: text(row), why: 'the number and its unit are wider than the slide' });
      }
      const blk = document.querySelector('.blk');
      const over = () => {
        if (!blk) return false;
        const box = blk.getBoundingClientRect();
        return [...blk.children].some((c) => {
          const r = c.getBoundingClientRect();
          return r.height > 0 && (r.bottom > box.bottom + 1 || r.top < box.top - 1);
        });
      };
      let bt = parseFloat(getComputedStyle(b).getPropertyValue('--bt'));
      const lift = b.dataset.lift ? Number(b.dataset.lift) : null;
      while (over() && lift != null && bt > lift) {
        bt = Math.max(lift, bt - 8);
        b.style.setProperty('--bt', `${bt}px`);
      }
      // Smaller together: the texts beside the headline first, then the headline, each to its own floor.
      for (const group of [els.filter((el) => !el.classList.contains('hl') && !el.classList.contains('num')), els.filter((el) => el.classList.contains('hl'))]) {
        let moved = true;
        while (over() && moved) {
          moved = false;
          for (const el of group) {
            const px = at.get(el);
            const floor = Number(el.dataset.floor);
            if (px > floor) {
              set(el, Math.max(floor, px - Math.max(1, px * 0.04)));
              moved = true;
            }
          }
        }
      }
      for (const el of els) {
        const n = lineCount(el);
        if (n > Number(el.dataset.max)) bad.push({ code: 'fit', text: text(el), why: `${n} lines at ${Math.round(at.get(el))}px, the style allows ${el.dataset.max}` });
        else if (sideways(el)) bad.push({ code: 'fit', text: text(el), why: `wider than the slide at ${Math.round(at.get(el))}px` });
      }
      if (over()) bad.push({ code: 'overflow', text: text(blk), why: 'the block is taller than its room even with every text at its floor' });
      return { bad, bt, fitted: els.map((el) => ({ text: text(el), from: Math.round(Number(el.dataset.px)), to: Math.round(at.get(el)), fits: true })) };
    }, { scale });
    if (styled?.bad.length) for (const x of styled.bad) refuse(`too long for the style: "${x.text}..." (${x.why})`, x.code);

    // Shrink any block that overflows, 2% a step, down to the floor. `scale` sets every block smaller first: the size
    // the rest of the post's content slides came out at (renderPost), so a post's text is one size from slide to slide.
    const fitted = await tab.evaluate(({ floor, scale }) => {
      // An overflow is a line whose letters are cut: its baseline falls below the bottom of its
      // box. A tall face's descenders spilling out of a tight line box (line-height 0.9) are not;
      // measured by overflow alone the two look alike, and a half-cut last line once passed as a
      // descender (the launch set's review caught it). The baseline is measured, not guessed: a
      // zero-size marker after the last letter sits on it. A guess from the face's descent
      // (0.28 em) let a cut "2002" through in a face whose descent is 0.16 em.
      const over = (el) => {
        const box = el.getBoundingClientRect();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let last = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) last = n;
        if (!last) return el.scrollHeight - el.clientHeight > Math.max(2, (parseFloat(getComputedStyle(el).lineHeight) || 40) * 0.6);
        const mark = document.createElement('span');
        mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        last.after(mark);
        const baseline = mark.getBoundingClientRect().bottom;
        mark.remove();
        // A line wider than its box is cut as surely as one below it: "$120 מיליון" lost its last letters on a cover.
        // Measured on the text itself: a box's scroll width also counts what is not drawn.
        const range = document.createRange();
        range.selectNodeContents(el);
        const ink = range.getBoundingClientRect();
        const sideways = ink.width > 0 && (ink.left < box.left - 2 || ink.right > box.right + 2);
        return baseline > box.bottom + 1 || sideways || (el.classList.contains('vis') && inside(el, box));
      };
      // A graphic is cut inside itself: a price card ran past the graphic's bottom, and "CodeFast" broke as "CodeF / ast"
      // in a card too narrow for it, while the graphic's last line of text fitted. So every box in it must sit inside
      // the graphic, and every line of text inside the box that holds it. A word never breaks: it is set smaller.
      const inside = (el, box) => {
        // A part a box of the graphic clips on purpose (a bar's segments inside their track) is not cut.
        const clipped = (d) => {
          for (let p = d.parentElement; p && p !== el; p = p.parentElement) if (getComputedStyle(p).overflow !== 'visible') return true;
          return false;
        };
        for (const d of el.querySelectorAll('*')) {
          if (clipped(d)) continue;
          const r = d.getBoundingClientRect();
          if (r.width && r.height && (r.bottom > box.bottom + 1 || r.right > box.right + 2 || r.left < box.left - 2)) return true;
        }
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.nodeValue.trim()) continue;
          let holder = n.parentElement;
          while (holder !== el && /^(inline|contents)$/.test(getComputedStyle(holder).display)) holder = holder.parentElement;
          const h = holder.getBoundingClientRect();
          range.selectNodeContents(n);
          const t = range.getBoundingClientRect();
          if (t.width && (t.right > h.right + 2 || t.left < h.left - 2)) return true;
        }
        return false;
      };
      const els = [...document.querySelectorAll('.fit')];
      const base = new Map(els.map((el) => [el, parseFloat(getComputedStyle(el).fontSize)]));
      if (scale < 1) for (const el of els) el.style.fontSize = `${base.get(el) * scale}px`;
      let out = [];
      for (const el of els) {
        if (!over(el)) continue;
        const from = base.get(el);
        let px = from * scale;
        while (over(el) && px > from * floor) {
          px *= 0.98;
          el.style.fontSize = `${px}px`;
        }
        out.push({ text: el.textContent.trim().slice(0, 40), from: Math.round(from), to: Math.round(px), fits: !over(el) });
      }
      // Boxes that share a slide take room from each other: a title, a graphic and a text squeezed one box to
      // nothing, and no size of it alone could fit. Then everything on the slide is set smaller together.
      if (out.some((f) => !f.fits)) {
        for (let all = scale * 0.96; all >= floor; all *= 0.96) {
          for (const el of els) el.style.fontSize = `${base.get(el) * all}px`;
          if (!els.some(over)) {
            out = els.map((el) => ({ text: el.textContent.trim().slice(0, 40), from: Math.round(base.get(el)), to: Math.round(base.get(el) * all), fits: true }));
            break;
          }
        }
      }
      return out;
    }, { floor, scale });
    const failed = fitted.filter((f) => !f.fits);
    if (failed.length) refuse(`too long for the slide even at ${Math.round(floor * 100)}% size: "${failed[0].text}..."`, 'overflow');
    // A styled slide's texts are what its size is measured by; its graphic's fit is the shared pass's.
    if (styled) fitted.unshift(...styled.fitted);

    // The outline on text over a picture, and every line measured against the safe zone.
    const zone = await tab.evaluate(() => {
      const b = document.body;
      const H = innerHeight;
      // A styled slide keeps all four bands clear, in px (data-safe: top, right, bottom, left); the older templates
      // keep the top and the bottom, as a share of the height.
      const safe = b.dataset.safe ? b.dataset.safe.split(',').map(Number) : null;
      const top = safe ? safe[0] : Number(b.dataset.zoneTop || 0) * H;
      const bottom = H - (safe ? safe[2] : Number(b.dataset.zoneBottom || 0) * H);
      const left = safe ? safe[3] : -Infinity;
      const right = safe ? innerWidth - safe[1] : Infinity;
      const em = Number(b.dataset.outline || 0);
      const photo = b.classList.contains('has-photo');
      const over = photo || b.classList.contains('has-bg');
      const color = photo ? 'rgba(0,0,0,.85)' : `rgba(${getComputedStyle(b).getPropertyValue('--bg-rgb').trim()},.95)`;
      // Text on a box of its own (a card, a button, a badge) does not touch the picture: it keeps its own look.
      const ground = (el) => {
        for (let p = el; p && p !== b; p = p.parentElement) {
          const cs = getComputedStyle(p);
          const m = /^rgba?\(([^)]+)\)$/.exec(cs.backgroundColor);
          const a = m ? Number(m[1].split(',')[3] ?? 1) : 0;
          if (a >= 0.5 || cs.backgroundImage !== 'none') return true;
        }
        return false;
      };
      const bad = [];
      const outlined = new Set();
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue;
        const el = n.parentElement;
        // A giant ghost numeral or question mark is ornament, not a line anyone reads.
        if (el.closest('.probe,.ghost,.qmark,style,script,title')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        range.selectNodeContents(n);
        const r = [...range.getClientRects()].filter((x) => x.width && x.height);
        if (!r.length) continue;
        // A line's box is its face's ascent and descent, taller than the letters in a display face: the letters sit in
        // the em box at its middle, and that is what must clear the zone ("02/06" in a 56 px face measured 73 px tall).
        const inkPad = (x) => Math.max(0, (x.height - parseFloat(cs.fontSize)) / 2);
        const hit = r.find((x) => x.top + inkPad(x) < top - 2 || x.bottom - inkPad(x) > bottom + 2 || x.left < left - 2 || x.right > right + 2);
        if (hit) bad.push({ text: n.nodeValue.trim().slice(0, 40), top: Math.round(hit.top), bottom: Math.round(hit.bottom), left: Math.round(hit.left), right: Math.round(hit.right) });
        if (over && em > 0 && !ground(el)) outlined.add(el);
      }
      for (const el of outlined) {
        el.style.webkitTextStroke = `${em}em ${color}`;
        el.style.paintOrder = 'stroke fill';
      }
      return { bad, outlined: outlined.size, top: Math.round(top), bottom: Math.round(bottom), sides: safe ? [Math.round(left), Math.round(right)] : null };
    });
    if (zone.bad.length) {
      const x = zone.bad[0];
      const sides = zone.sides ? `, between ${zone.sides[0]}px and ${zone.sides[1]}px across` : '';
      refuse(`text in the safe zone (clear above ${zone.top}px and below ${zone.bottom}px${sides}): "${x.text}" sits at ${x.top}-${x.bottom}px${zone.sides ? `, ${x.left}-${x.right}px across` : ''}`, 'safe_zone');
    }

    const dir = await tab.evaluate(() => [document.documentElement.dir, document.documentElement.lang]);
    if (dir[0] !== 'rtl' || dir[1] !== 'he') throw new RenderError('the slide is not right to left Hebrew', 'rtl');

    const buf = await tab.screenshot({ type: 'jpeg', quality: 90 });
    ensureDir(path.dirname(file));
    writeFileSync(`${file}.tmp`, buf);
    renameSync(`${file}.tmp`, file);
    return { file, fitted, outlined: zone.outlined, bytes: buf.length, warnings };
  } finally {
    await context.close().catch(() => {});
    keepWarm();
  }
}

/**
 * Where each slide sits in its post, for the parts that count: its place among
 * the content slides, and its place among the slides of its own role (clue 2 of
 * 3, layer 4 of 5, the 2nd case), a ranking's places, and whether it is last.
 */
export function slidePlaces(slides) {
  const content = slides.filter((s) => s.kind === 'item');
  const ranks = ranksOf(content);
  const lastIdx = slides.length - 1;
  const byRole = (role) => content.filter((s) => s.role === role).length;
  const seen = {};
  let pos = 0;
  return slides.map((s, i) => {
    if (s.kind !== 'item') return { pos: 0, total: content.length, isLast: i === lastIdx };
    pos++;
    seen[s.role] = (seen[s.role] || 0) + 1;
    const timeline = ['then', 'turn', 'now', 'context', 'moment', 'after', 'beat', 'payoff'].includes(s.role);
    return {
      pos, total: content.length, isLast: i === lastIdx, rank: ranks[pos - 1],
      n: timeline ? pos : seen[s.role], of: timeline ? content.length : byRole(s.role), clues: byRole('clue'),
    };
  });
}

/** A scene with no name in it ("football stadium night"), never one of a named place ("Anfield", "Camp Nou"). */
export const genericScene = (query) => Boolean(query) && !/(?:^|\s)\p{Lu}\p{Ll}/u.test(String(query));

/**
 * Which photograph each slide of a styled post stands on: Map(slide index -> key of `byIdx`), and how often each is
 * used. Pure. (The rules are said where renderPost calls it.)
 */
export function planPhotos({ slides, byIdx, postKind }) {
  const has = (k) => Boolean(byIdx.get(k)?.file);
  const MAX_USES = 2;
  const manySubjects = ['guess-who', 'ranking', 'head-to-head', 'list', 'facts'].includes(postKind);
  const sceneKeys = ['bg', 'bg2', 'bg3'].filter((k) => has(k)).sort((a, b) => Number(!genericScene(byIdx.get(a)?.query)) - Number(!genericScene(byIdx.get(b)?.query)));
  const answer = postKind === 'guess-who' ? slides.length - 1 : null;
  const plan = new Map();
  const uses = new Map();
  const use = (i, k) => {
    plan.set(i, k);
    uses.set(k, (uses.get(k) || 0) + 1);
  };
  const splitCover = postKind === 'head-to-head' && has('ca') && has('cb');
  slides.forEach((s, i) => {
    if (has(i) && !(s.kind === 'cover' && postKind === 'guess-who')) use(i, i);
  });
  const candidates = (s, i) => {
    const q = String(s.imageQuery || '').toLowerCase().trim();
    const own = [...byIdx].filter(([k, p]) => p?.file && typeof k === 'number' && k !== i && k !== answer);
    const same = q ? own.filter(([, p]) => String(p.query || '').toLowerCase().trim() === q).map(([k]) => k) : [];
    const subject = manySubjects || postKind === 'guess-who' ? [] : own.map(([k]) => k).sort((a, b) => a - b);
    return [...new Set([...same, ...subject, ...sceneKeys])];
  };
  slides.forEach((s, i) => {
    if (plan.has(i) || (s.kind === 'cover' && splitCover)) return;
    const c = candidates(s, i);
    const free = c.find((k) => (uses.get(k) || 0) < MAX_USES);
    const k = free ?? c.sort((a, b) => (uses.get(a) || 0) - (uses.get(b) || 0))[0];
    if (k != null) use(i, k);
  });
  return { plan, uses, sceneKeys };
}

const dataUri = (file) => `data:${/\.png$/i.test(file) ? 'image/png' : /\.svg$/i.test(file) ? 'image/svg+xml' : 'image/jpeg'};base64,${readFileSync(file).toString('base64')}`;

/**
 * Render every slide of a post for every platform of its pack.
 * post: { id, hook, sub, caption, token, extra }; slides: [{ kind, role, title, body, a, b, factKeys, sources, visual }];
 * photos: Map(slide index -> image row with .file): the cover's (or the last slide's)
 * is drawn behind the whole slide, a content slide's as a framed picture; or, from
 * an older caller, one photo drawn on the cover or on the last slide (photoOn).
 * Returns { tiktok: [files], instagram: [files] }.
 */
export async function renderPost({ pack, post, slides, photos = null, photo = null, photoOn = 'cover', format = null, outDir, only = null, platforms = null, lenient = false }) {
  const expected = tokenOf({ slides, caption: post.caption, hook: post.hook, sub: post.sub, extra: post.extra || {} });
  if (!post.token || post.token !== expected) {
    throw new RenderError('refused: this text was not checked by the fact gate (or changed after it)', 'unverified');
  }
  const byIdx = photos instanceof Map ? photos : new Map(photo ? [[photoOn === 'last' ? slides.length - 1 : 0, photo]] : []);
  const uri = new Map([...byIdx].filter(([, p]) => p?.file).map(([i, p]) => [i, dataUri(p.file)]));
  // Each photograph cropped around its face, where its screen measured one.
  const focus = new Map([...byIdx].filter(([, p]) => p?.file).map(([i, p]) => [i, focusOf(p)]));
  const brand = pack.brandLogo ? dataUri(pack.brandLogo) : null;
  const opts = pack.theme.options || {};
  const overlay = overlayOf(pack);
  const noHandle = opts.handleTag === false;
  // The closing "follow" slide, when the account has one, takes the call to action off the last content slide.
  // A post on a photograph a slide ends on its best slide instead (everyPhoto).
  const end = pack.meta.endSlide?.title && !(format && everyPhoto(pack, format)) ? pack.meta.endSlide : null;
  const kindNow = format ? kindName(format) : 'list';
  // A do-dont's rules are someone else's guidance, under licences that ask for credit: its slides name their source
  // even on an account that keeps its sources off the slides.
  const noSources = opts.sourceLine === false && kindNow !== 'do-dont';
  // Every slide on a photograph (theme.options.backgroundPhoto): its own, else one of the post's, in turn, else the
  // one found for the post's scene ('bg'). Never a guess-who's answer, whose face would show through the blur.
  // The post's own subject (the cover's photograph, never a guess-who's answer) and its scene; a slide's portrait of
  // someone else stays on that slide.
  // Only a post about one subject puts its cover's face behind the other slides: a ranking's number one sat behind
  // the slide about number two, and one side of a head-to-head behind the other's.
  const oneSubject = !['guess-who', 'ranking', 'head-to-head', 'list'].includes(kindNow);
  // One ground for the whole post: the slides used to stand on their own photographs in turn, a different picture
  // and colour behind every slide. A slide's own photograph is in its frame; the ground behind every slide is one.
  const ground = opts.backgroundPhoto ? (uri.has(0) && oneSubject ? uri.get(0) : uri.get('bg') || null) : null;
  const bgFor = () => ground;
  // A template that stands every slide on a photograph (photocard): a content slide's own fills it, else the post's
  // (the cover's when the post is about one subject, else the one found for its scene), sharp, never blurred.
  const impl = TEMPLATE_IMPL[pack.theme.template] || {};
  const bleed = impl.fullBleed && pack.theme.options?.coverPhoto !== false;
  const postPhoto = (oneSubject && uri.get(0)) || uri.get('bg') || null;
  const items = slides.filter((s) => s.kind === 'item').length;
  const places = slidePlaces(slides);
  // Photographs left off a slide that could not fit them, per platform: not shown, not credited.
  const dropped = {};
  const postKind = format ? kindName(format) : 'list';
  const extra = post.extra || {};
  const out = {};
  const scales = {};
  // An account drawn in one of the slide styles (src/render/styles): each slide is a page of its own.
  const styled = Boolean(pack.theme.style);
  const warnings = [];
  // One slide drawn, at `scale` of its type's size: a slide that does not fit with everything on it is drawn again
  // without its framed photograph (a presentation choice: the text and the graphic are what was checked), then with
  // its type allowed smaller. Returns the size its text came out at, as a share of the design's.
  const drawSlide = async ({ i, s, slide, look, file, size, scale = 1 }) => {
    // Style E puts its text over the photograph before it gives the photograph up: a ranking's number, title and line did
    // not fit on the black above a landscape photograph, and two slides of a countdown went out black.
    const over = styled && pack.theme.style?.name === 'E' && slide.photo ? [{ ...slide, textOver: true }] : [];
    const bare = slide.photo ? [{ ...slide, photo: null, hasVisual: s.kind === 'item' && slideHasVisual({ ...slide, photo: null }) }] : [];
    // A styled slide keeps its photograph down to smaller type before it gives the photograph up: a slide with none is
    // a dark ground, which the owner refused.
    const keep = styled && slide.photo ? [[0.45, { ...slide }]] : [];
    const attempts = [...[{ ...slide }, ...over].map((t) => [FIT_FLOOR, t]), ...keep, ...bare.map((t) => [FIT_FLOOR, t]), [0.45, bare[0] || { ...slide }]];
    for (const [k, sl] of attempts.entries()) {
      const html = styled ? stylePage({ theme: pack.theme, overlay, size, slide: sl[1] }) : page({ theme: pack.theme, overlay, size, slide: sl[1], parts: buildSlide(pack.theme, sl[1]), ...look });
      try {
        const r = await renderHtml(html, { size, file, floor: sl[0], scale, lenient });
        for (const w of r.warnings || []) warnings.push({ size, slide: i, ...w });
        if (slide.photo && !sl[1].photo) (dropped[size] ??= new Set()).add(i);
        return Math.min(scale, ...r.fitted.filter((f) => f.from).map((f) => f.to / f.from));
      } catch (e) {
        if (e.code !== 'overflow' || k === attempts.length - 1) throw e;
      }
    }
    throw new RenderError('the slide did not render', 'overflow');
  };
  // Every slide of a styled post stands on a photograph, in every style, and no photograph stands on every slide (the
  // owner, 2026-10-27: "the same background image can't be in all of the slides... an image has to be present, not a
  // dark background"). One plan for the post, the same on every platform: each slide its own photograph; a slide with
  // none takes the least-used of those it may show, at most MAX_USES slides a photograph while another is left:
  //   - one the post has of the same person or place (the cover's search took the query first, and a slide does not
  //     search twice);
  //   - on a post about one subject, the post's other photographs of it, the cover's first;
  //   - the post's scenes, one with no place's name first (a World Cup countdown stood on Anfield, its crest on the
  //     wall), then any.
  // Never a guess-who's answer before its reveal, never one side of a head-to-head on a slide of both, never another
  // subject's face on a facts, ranking or list slide (those take scenes).
  const { plan, uses, sceneKeys } = planPhotos({ slides, byIdx, postKind });
  // The closing slide, when the account has one, stands on the least-used scene (or photograph) of the post.
  const endKey = [...sceneKeys, ...[...uses.keys()]].sort((a, b) => (uses.get(a) || 0) - (uses.get(b) || 0))[0] ?? null;
  // Each size once: a Facebook Page's post is sent Instagram's slides (src/core/platforms.js).
  for (const size of platforms || mediaSizes(pack.meta.platforms)) {
    out[size] = [];
    const drawn = [];
    let n = 0;
    for (const [i, s] of slides.entries()) {
      if (s.kind === 'item') n++;
      const slide = {
        n,
        of: items,
        ...s,
        ...places[i],
        ...(postKind === 'list' ? { n, of: items } : {}),
        hook: post.hook,
        sub: post.sub,
        handle: pack.meta.handle,
        noHandle,
        noSources,
        noKeywords: opts.slideKeywords === false,
        displayName: pack.meta.displayName,
        postKind,
        subject: extra.subject || {},
        keywords: extra.keywords || [],
        cta: extra.cta && !end ? { kind: post.ctaKind || 'save', text: extra.cta } : null,
        coverVisual: extra.coverVisual || null,
        // The mark goes on the last slide only: on the cover the platform's own page already shows whose post it is,
        // and a logo there reads as an advert (the owner's call).
        brand: brand && !end && i === slides.length - 1 && s.kind !== 'cover' ? brand : null,
      };
      // The cover's photograph, and a guess-who's reveal, fill the slide; a content slide's sits in a frame.
      const full = uri.has(i) && (s.kind === 'cover' || (i === slides.length - 1 && s.role === 'reveal') || (bleed && s.kind === 'item')) && pack.theme.options?.coverPhoto !== false;
      // A guess-who's cover shows its answer's photograph blurred past recognition: a real picture that teases, never tells.
      const tease = !full && s.kind === 'cover' && postKind === 'guess-who' && uri.has(slides.length - 1) && pack.theme.options?.coverPhoto !== false;
      if (uri.has(i) && !full) slide.photo = uri.get(i);
      // A head-to-head's cover: both sides, each on its own half.
      const split = s.kind === 'cover' && postKind === 'head-to-head' && uri.has('ca') && uri.has('cb') ? [uri.get('ca'), uri.get('cb')] : null;
      // Nothing of its own on a full-bleed template: the post's photograph (a guess-who's answer is never one of them).
      const stand = !full && !tease && !split && bleed ? postPhoto : null;
      slide.hasPhoto = Boolean(full || tease || split || stand);
      slide.tease = Boolean(tease);
      slide.hasVisual = s.kind === 'item' && slideHasVisual(slide);
      const file = path.join(outDir, `${size}-${String(i + 1).padStart(2, '0')}.jpg`);
      if (only && !only.has(i)) continue;
      if (styled) {
        // A style draws a slide's own photograph, sharp, or none: never the cover's behind another slide, never a
        // blurred one, never a guess-who's answer on its cover. A cover photograph too small to fill is left off.
        // A cover with no photograph of its own stands on the post's scene ('bg'), sharp, when the post has one.
        // Style E is a slideshow made in the app: every slide on a photograph. A slide the search found none for
        // stands on the post's own (its cover's, when the post is about one subject) or its scene's, never on a black
        // ground with words alone, never a guess-who's answer before its reveal, never another subject's face.
        const from = plan.has(i) ? plan.get(i) : null;
        const own = from != null ? uri.get(from) : null;
        // A small photograph is shown all the same (E shows it whole, on black; A to D blow it up): a photograph, never a
        // dark ground (the owner's call).
        slide.photo = split ? null : own;
        slide.photoPos = slide.photo ? focus.get(from) || null : null;
        if (slide.photo) {
          const sz = imageSize(readFileSync(byIdx.get(from).file));
          slide.photoSize = sz ? { w: sz.width, h: sz.height } : null;
        }
        slide.split = split;
        slide.splitPos = split ? [focus.get('ca'), focus.get('cb')] : null;
        slide.hasPhoto = Boolean(slide.photo || split);
        slide.hasVisual = s.kind === 'item' && slideHasVisual(slide);
        slide.highlight = s.highlight || '';
        if (s.kind === 'cover') {
          const subj = extra.subject || {};
          const names = postKind === 'head-to-head' && subj.a && subj.b ? `${subj.a} מול ${subj.b}` : '';
          const day = postKind === 'on-this-day' && subj.date ? String(subj.date) : '';
          // Style C's key line, at the foot of the cover: the day, or the two sides. Nothing is set over a headline.
          slide.keyLine = day || names;
        }
        drawn.push({ i, s, slide, look: {}, file, ratio: await drawSlide({ i, s, slide, look: {}, file, size }) });
        out[size].push(file);
        continue;
      }
      // A cover photograph smaller than FULL_BLEED_MIN is framed over its own blurred copy, never stretched to fill.
      const framed = full && s.kind === 'cover' && !fillsCover(readFileSync(byIdx.get(i).file));
      const look = { photo: full ? uri.get(i) : tease ? uri.get(slides.length - 1) : stand, photoPos: full ? focus.get(i) : null, blur: tease, split, splitPos: split ? [focus.get('ca'), focus.get('cb')] : null, bg: bgFor(i), framed };
      drawn.push({ i, s, slide, look, file, ratio: await drawSlide({ i, s, slide, look, file, size }) });
      out[size].push(file);
    }
    // One type size for the content slides: each was fitted on its own, and a post came out with a title at full size
    // beside one set at 70%. The slides set larger are drawn again at the size the others came out at (never below
    // EVEN_FLOOR: one long slide does not shrink every other one to its size).
    const content = drawn.filter((d) => d.s.kind === 'item');
    const even = Math.max(EVEN_FLOOR, Math.min(1, ...content.map((d) => d.ratio)));
    if (content.length > 1 && even < 0.97) {
      for (const d of content) {
        if (d.ratio <= even + 0.03) continue;
        dropped[size]?.delete(d.i);
        d.ratio = await drawSlide({ ...d, size, scale: even });
      }
    }
    (scales[size] = drawn.map((d) => Math.round(d.ratio * 100) / 100));
    if (end && styled && !only) {
      const file = path.join(outDir, `${size}-${String(slides.length + 1).padStart(2, '0')}.jpg`);
      const r = await renderHtml(stylePage({ theme: pack.theme, overlay, size, slide: { kind: 'end', title: end.title, body: end.body || '', handle: pack.meta.handle, photo: endKey != null ? uri.get(endKey) : null } }), { size, file, lenient });
      for (const w of r.warnings || []) warnings.push({ size, slide: slides.length, ...w });
      out[size].push(file);
    } else if (end && !only) {
      const sl = { kind: 'end', handle: pack.meta.handle, noHandle, brand };
      const file = path.join(outDir, `${size}-${String(slides.length + 1).padStart(2, '0')}.jpg`);
      // A template with its own closing slide draws it on the post's photograph.
      const own = impl.end && bleed && postPhoto;
      await renderHtml(page({ theme: pack.theme, overlay, size, slide: own ? { ...sl, brand: null } : sl, parts: own ? impl.end(pack) : endParts(pack), ...(own ? { photo: postPhoto } : { bg: bgFor(slides.length) }) }), { size, file, floor: 0.45 });
      out[size].push(file);
    }
  }
  Object.defineProperty(out, 'dropped', { value: dropped, enumerable: false });
  // The size each slide's text came out at, per platform, as a share of the design's.
  Object.defineProperty(out, 'scales', { value: scales, enumerable: false });
  // What a lenient render (a preview) drew although it did not fit, per slide.
  Object.defineProperty(out, 'warnings', { value: warnings, enumerable: false });
  return out;
}
