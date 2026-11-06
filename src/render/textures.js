// The grounds a slide stands on when it has no photograph: a cutting mat, paper, fabric, liquid glass or an artisan's
// plaster, drawn by the renderer itself as SVG (noise, lines and gradients), never a generated picture and never fetched
// (the site says "תדר לא מייצר תמונות ב-AI", and it stays true).
//
// The owner, 2026-11-06: "if a slideshow is about something that doesnt require photos, or it fails because of them,
// we can use generated background, but from a few options: a cutting mat, paper texture, fabric texture, liquid glass,
// artisan texture. each time it should look different, one of these options".
//
// One texture a post, on every slide of it that has no photograph, with its own variation: its tone from the account's
// style (dark under the dark styles' light letters, light under C's dark ones), a tint of its own and of the account's
// accent, a seed and an angle from the post's id. A post does not take the texture its account's last post had
// (pickTexture). The tones stay in a band where the style's text keeps its contrast (textureTones, tested).

import { contrast, luminance } from './color.js';

/** The five textures, in a fixed order. */
export const TEXTURES = ['mat', 'paper', 'fabric', 'glass', 'artisan'];

/** The designed text slide's four layouts (src/render/styles/index.js drawText): one a post, with its texture. */
export const LAYOUTS = ['marker', 'boxes', 'corner', 'card'];

/** Each texture's own colour, mixed into the style's ground: a cutting mat's green, kraft paper, slate linen, clay. */
const TINT = { mat: '#2f6b57', paper: '#8a6f4d', fabric: '#56606e', glass: null, artisan: '#9a5b3c' };

// FNV-1a, then an avalanche, so two ids a letter apart get unrelated textures.
const hash = (s) => {
  let h = 0x811c9dc5;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
const hex2 = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
const rgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
const toHex = (c) => `#${c.map(hex2).join('')}`;
const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

/**
 * The texture of one post: { kind, seed, angle, dark, layout }. `kind` and `layout` the post's own (hash of its id),
 * never `avoid` and `avoidLayout` (the account's last post's) when another is left. Pure.
 */
export function textureFor(postId, { avoid = null, avoidLayout = null, dark = true } = {}) {
  const h = hash(postId);
  const kinds = TEXTURES.filter((k) => k !== avoid);
  const layouts = LAYOUTS.filter((k) => k !== avoidLayout);
  return { kind: kinds[h % kinds.length], seed: (h >>> 3) % 997, angle: ((h >>> 7) % 12) * 15, dark, layout: layouts[(h >>> 13) % layouts.length] };
}

/**
 * The colours of a texture for a style's ground (`ground`, the style's own bg or panel) and the account's `accent`:
 * { base, light, line, glow }, every one of them a tone the style's `text` reads on at `need`:1 at least (7 for the
 * slides' body text, as the styles ask of their grounds). Pure.
 */
export function textureTones(tex, { ground, text, accent }, need = 7) {
  const tint = TINT[tex.kind] || accent || ground;
  let base = mix(ground, tint, tex.dark ? 0.3 : 0.12);
  // Darker (or lighter) until the text reads on the texture's lightest (or darkest) tone too.
  const toward = tex.dark ? '#000000' : '#FFFFFF';
  const lift = (c) => mix(c, tex.dark ? '#FFFFFF' : '#000000', 0.16);
  for (let k = 0; k < 20 && contrast(text, lift(base)) < need; k++) base = mix(base, toward, 0.12);
  return { base, light: lift(base), line: mix(base, tex.dark ? '#FFFFFF' : '#000000', 0.16), glow: mix(base, accent || tint, 0.45), dark: luminance(base) < 0.5 };
}

const svg = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
// Fine grain over every texture, so no ground is flat: fractal noise at a low opacity.
const grain = (id, seed, freq, opacity) => `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${opacity} 0"/></filter>`;

/** A texture as an SVG document W x H px. Pure. */
export function textureSvg(tex, tones, W, H) {
  const { base, light, line, glow } = tones;
  const s = tex.seed;
  const a = tex.angle;
  const g = (id, f, o) => `<defs>${grain(id, s, f, o)}</defs><rect width="100%" height="100%" filter="url(#${id})"/>`;
  if (tex.kind === 'mat') {
    // A self-healing cutting mat: a fine grid, a heavier line every five squares, two 45-degree guides, worn grain.
    const step = 36;
    const off = (s % step) - step;
    const lines = [];
    for (let x = off, i = 0; x < W; x += step, i++) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${line}" stroke-opacity="${i % 5 ? 0.5 : 0.95}" stroke-width="${i % 5 ? 1.2 : 2.6}"/>`);
    for (let y = off, i = 0; y < H; y += step, i++) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${line}" stroke-opacity="${i % 5 ? 0.5 : 0.95}" stroke-width="${i % 5 ? 1.2 : 2.6}"/>`);
    const d = Math.max(W, H);
    // The ruler along the top and the left edge: a mark every square, a longer one every five, numbered in centimetres.
    const ruler = [];
    for (let x = off, i = 0; x < W; x += step, i++) ruler.push(`<line x1="${x}" y1="0" x2="${x}" y2="${i % 5 ? 14 : 30}" stroke="${light}" stroke-width="2"/>${i % 5 || x < 20 ? '' : `<text x="${x + 5}" y="46" font-family="sans-serif" font-size="18" fill="${light}">${i}</text>`}`);
    for (let y = off, i = 0; y < H; y += step, i++) ruler.push(`<line x1="0" y1="${y}" x2="${i % 5 ? 14 : 30}" y2="${y}" stroke="${light}" stroke-width="2"/>${i % 5 || y < 60 ? '' : `<text x="36" y="${y + 6}" font-family="sans-serif" font-size="18" fill="${light}">${i}</text>`}`);
    return svg(W, H, `<rect width="100%" height="100%" fill="${base}"/><g>${lines.join('')}</g><g opacity=".85">${ruler.join('')}</g><g stroke="${line}" stroke-opacity=".45" stroke-width="1.6"><line x1="0" y1="${H - (a % 30) * 8}" x2="${d}" y2="${H - (a % 30) * 8 - d}"/><line x1="0" y1="${(a % 30) * 8}" x2="${d}" y2="${(a % 30) * 8 + d}"/></g>${g('n', 0.9, 0.06)}`);
  }
  if (tex.kind === 'paper') {
    // Paper: a soft cloud of light and shade, long fibres at the post's angle, and a fine tooth.
    return svg(W, H, `<defs><filter id="c" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="2" seed="${s}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .1 0"/></filter><filter id="f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.002 0.35" numOctaves="2" seed="${s + 3}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .2 0"/></filter><linearGradient id="fold" gradientTransform="rotate(90)"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="${base}"/><rect width="100%" height="100%" filter="url(#c)"/><g transform="rotate(${a} ${W / 2} ${H / 2})"><rect x="${-H}" y="${-H}" width="${W + 2 * H}" height="${3 * H}" filter="url(#f)"/></g><g transform="rotate(${(a % 40) - 20} ${W / 2} ${H * 0.58})"><rect x="${-W}" y="${Math.round(H * 0.58) - 30}" width="${3 * W}" height="60" fill="url(#fold)"/><line x1="${-W}" y1="${Math.round(H * 0.58)}" x2="${2 * W}" y2="${Math.round(H * 0.58)}" stroke="#fff" stroke-opacity=".12" stroke-width="2"/></g>${g('t', 1.3, 0.08)}`);
  }
  if (tex.kind === 'fabric') {
    // A linen weave: warp and weft threads a few pixels apart, each a little uneven, at a slight angle.
    const p = 9;
    return svg(W, H, `<defs><pattern id="w" width="${p}" height="${p}" patternUnits="userSpaceOnUse" patternTransform="rotate(${(a % 30) - 15})"><rect width="${p}" height="${p}" fill="${base}"/><rect width="${p}" height="${p / 2}" fill="${line}" fill-opacity=".42"/><rect width="${p / 2}" height="${p}" fill="${light}" fill-opacity=".34"/></pattern><filter id="u" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.004" numOctaves="2" seed="${s}"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .18 0"/></filter></defs><rect width="100%" height="100%" fill="url(#w)"/><rect width="100%" height="100%" filter="url(#u)"/>${g('n', 1.1, 0.05)}`);
  }
  if (tex.kind === 'glass') {
    // Liquid glass: soft pools of the account's colour behind a frosted pane, a sheen across it at the post's angle.
    // Three pools spread over the slide (top, middle, foot), each moved by the seed.
    const pts = [[0.22, 0.2], [0.8, 0.52], [0.3, 0.86]].map(([x, y], i) => [x + (((s * (i + 3)) % 21) - 10) / 100, y + (((s * (i + 5)) % 15) - 7) / 100]);
    const blobs = pts.map(([x, y], i) => `<circle cx="${Math.round(x * W)}" cy="${Math.round(y * H)}" r="${Math.round((0.35 + 0.1 * i) * W)}" fill="url(#b${i % 2})"/>`).join('');
    return svg(W, H, `<defs><radialGradient id="b0"><stop offset="0" stop-color="${glow}" stop-opacity=".55"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient><radialGradient id="b1"><stop offset="0" stop-color="${light}" stop-opacity=".5"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient><linearGradient id="s" gradientTransform="rotate(${a})"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="bl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="60"/></filter></defs><rect width="100%" height="100%" fill="${base}"/><g filter="url(#bl)">${blobs}</g><rect width="100%" height="100%" fill="url(#s)"/>${[0, 1, 2, 3].map((i) => `<rect x="${-W}" y="${Math.round(H * (0.12 + 0.24 * i))}" width="${3 * W}" height="${26 + 18 * (i % 2)}" fill="#fff" fill-opacity="${i % 2 ? 0.05 : 0.08}" transform="rotate(${(a % 30) - 15 + i * 4} ${W / 2} ${H / 2})" filter="url(#soft)"/>`).join('')}<defs><filter id="soft" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="6"/></filter></defs>${g('n', 0.8, 0.05)}`);
  }
  // Artisan plaster: a low relief of trowel strokes, lit from the post's angle.
  return svg(W, H, `<defs><filter id="p" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" seed="${s}" result="t"/><feDiffuseLighting in="t" lighting-color="${light}" surfaceScale="14" result="l"><feDistantLight azimuth="${a}" elevation="55"/></feDiffuseLighting><feComposite in="l" in2="SourceGraphic" operator="in"/></filter></defs><rect width="100%" height="100%" fill="${base}"/><rect width="100%" height="100%" fill="${base}" filter="url(#p)" opacity=".95"/>${g('n', 1, 0.05)}`);
}

/** A texture as a CSS background (a data URI of its SVG), for a W x H slide. Pure. */
export function textureCss(tex, colors, W, H) {
  const tones = textureTones(tex, colors);
  return `background:${tones.base} url('data:image/svg+xml;base64,${Buffer.from(textureSvg(tex, tones, W, H)).toString('base64')}') center/cover no-repeat`;
}
