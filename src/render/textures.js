// The grounds a slide stands on when it has no photograph: a cutting mat, paper, fabric, liquid glass or an artisan's
// plaster, drawn by the renderer itself as SVG (noise, lines and gradients), never a generated picture and never fetched
// (the site says "תדר לא מייצר תמונות ב-AI", and it stays true).
//
// The owner, 2026-11-06: "if a slideshow is about something that doesnt require photos, or it fails because of them,
// we can use generated background, but from a few options: a cutting mat, paper texture, fabric texture, liquid glass,
// artisan texture. each time it should look different, one of these options".
//
// One texture a post, on every slide of it that has no photograph, with its own variation: its tone from the account's
// style (dark under the dark styles' light letters, light under C's dark ones), a seed and an angle from the post's id.
// A post does not take the texture its account's last post had (pickTexture). The tones stay in a band where the
// style's text keeps its contrast (textureTones, tested).
//
// The owner, 2026-11-07, on a post on one brown paper throughout: "each slide should have a different background, or at
// least look a bit different from the first slide ... the background should always be playful". So a post keeps its
// one material (the series reads as one), and each slide of it (`slide`, its place) takes the next colour of the post's
// playful palette (PALETTES), its own seed and angle, and its own cut-outs at its edges (decor): scraps and tape on
// paper, cut shapes on the mat, felt patches and buttons on fabric, bubbles on glass, brush strokes on plaster, and a
// few doodles. They stay in the bands above and below the words, so no letter stands on them.

import { contrast, luminance } from './color.js';

/** The five textures, in a fixed order. */
export const TEXTURES = ['mat', 'paper', 'fabric', 'glass', 'artisan'];

/** The designed text slide's four layouts (src/render/styles/index.js drawText): one a post, with its texture. */
export const LAYOUTS = ['marker', 'boxes', 'corner', 'card'];

/** The playful palettes, four colours each: a post takes one (by its id), each slide of it the next colour. */
export const PALETTES = [
  ['#ff5d73', '#ffc145', '#3ec9a7', '#4d8bff'],
  ['#f72585', '#7b2cbf', '#4cc9f0', '#ffbe0b'],
  ['#ff8c42', '#2ec4b6', '#e71d36', '#3a86ff'],
  ['#ef476f', '#ffd166', '#06d6a0', '#118ab2'],
  ['#e76f51', '#e9c46a', '#2a9d8f', '#8ab17d'],
  ['#9b5de5', '#f15bb5', '#fee440', '#00bbf9'],
];

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
  return { kind: kinds[h % kinds.length], seed: (h >>> 3) % 997, angle: ((h >>> 7) % 12) * 15, dark, layout: layouts[(h >>> 13) % layouts.length], palette: (h >>> 17) % PALETTES.length };
}

/** One slide's texture: the post's, with the slide's place (`slide`), which gives it its colour, seed, angle and decor. Pure. */
export const slideTexture = (tex, slide) => (tex ? { ...tex, slide } : tex);

/** The colours of a slide's palette: its own (its ground's tint) and the others (its decor). null for a post before palettes. */
function paletteOf(tex) {
  if (tex.palette == null) return null;
  const pal = PALETTES[tex.palette % PALETTES.length];
  // Under light letters a pale colour (a yellow, a mint) deepened to the text's contrast turns olive (2026-11-07): it
  // decorates, and the grounds take the palette's deeper colours in turn.
  const grounds = tex.dark === false ? pal : pal.filter((c) => luminance(c) < 0.35);
  // Past the last of them the colours come round again, each round turned a little toward the next colour of the
  // palette, so no two slides of a post share one ground.
  const k = tex.slide || 0;
  const round = Math.floor(k / grounds.length) % 3;
  const own = round ? mix(grounds[k % grounds.length], pal[(pal.indexOf(grounds[k % grounds.length]) + 1) % pal.length], 0.22 * round) : grounds[k % grounds.length];
  return { own, others: pal.filter((c) => c !== own) };
}

/**
 * The colours of a texture for a style's ground (`ground`, the style's own bg or panel) and the account's `accent`:
 * { base, light, line, glow }, every one of them a tone the style's `text` reads on at `need`:1 at least (7 for the
 * slides' body text, as the styles ask of their grounds). Pure.
 */
export function textureTones(tex, { ground, text, accent }, need = 7) {
  const pal = paletteOf(tex);
  const tint = pal?.own || TINT[tex.kind] || accent || ground;
  // A palette's colour is taken pure and deepened (or paled) only as far as the text needs, so it stays a colour: mixed
  // into a dark style's ground first, every slide came out olive or maroon (2026-11-07). Words on their own card or
  // boxes need less of the ground: its small lines (the source) read at 4.5:1.
  if (pal && ['card', 'boxes'].includes(tex.layout)) need = Math.min(need, 4.5);
  let base = pal ? tint : mix(ground, tint, tex.dark ? 0.3 : 0.12);
  // Darker (or lighter) until the text reads on the texture's lightest (or darkest) tone too.
  const toward = tex.dark ? '#000000' : '#FFFFFF';
  const lift = (c) => mix(c, tex.dark ? '#FFFFFF' : '#000000', 0.16);
  for (let k = 0; k < 30 && contrast(text, lift(base)) < need; k++) base = mix(base, toward, pal ? 0.08 : 0.12);
  return { base, light: lift(base), line: mix(base, tex.dark ? '#FFFFFF' : '#000000', 0.16), glow: mix(base, pal ? pal.others[0] : accent || tint, 0.45), dark: luminance(base) < 0.5 };
}

const svg = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
// Fine grain over every texture, so no ground is flat: fractal noise at a low opacity.
const grain = (id, seed, freq, opacity) => `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${opacity} 0"/></filter>`;

/** A texture as an SVG document W x H px. Pure. */
export function textureSvg(tex, tones, W, H) {
  const k = tex.slide || 0;
  const s = (tex.seed + k * 53) % 997;
  const a = (tex.angle + k * 25) % 360;
  return svg(W, H, ground(tex, tones, W, H, s, a) + decor(tex, tones, W, H));
}

function ground(tex, tones, W, H, s, a) {
  const { base, light, line, glow } = tones;
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
    return `<rect width="100%" height="100%" fill="${base}"/><g>${lines.join('')}</g><g opacity=".85">${ruler.join('')}</g><g stroke="${line}" stroke-opacity=".45" stroke-width="1.6"><line x1="0" y1="${H - (a % 30) * 8}" x2="${d}" y2="${H - (a % 30) * 8 - d}"/><line x1="0" y1="${(a % 30) * 8}" x2="${d}" y2="${(a % 30) * 8 + d}"/></g>${g('n', 0.9, 0.06)}`;
  }
  if (tex.kind === 'paper') {
    // Paper: a soft cloud of light and shade, long fibres at the post's angle, and a fine tooth.
    return `<defs><filter id="c" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.004" numOctaves="2" seed="${s}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .1 0"/></filter><filter id="f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.002 0.35" numOctaves="2" seed="${s + 3}"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .2 0"/></filter><linearGradient id="fold" gradientTransform="rotate(90)"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="${base}"/><rect width="100%" height="100%" filter="url(#c)"/><g transform="rotate(${a} ${W / 2} ${H / 2})"><rect x="${-H}" y="${-H}" width="${W + 2 * H}" height="${3 * H}" filter="url(#f)"/></g><g transform="rotate(${(a % 40) - 20} ${W / 2} ${H * 0.58})"><rect x="${-W}" y="${Math.round(H * 0.58) - 30}" width="${3 * W}" height="60" fill="url(#fold)"/><line x1="${-W}" y1="${Math.round(H * 0.58)}" x2="${2 * W}" y2="${Math.round(H * 0.58)}" stroke="#fff" stroke-opacity=".12" stroke-width="2"/></g>${g('t', 1.3, 0.08)}`;
  }
  if (tex.kind === 'fabric') {
    // A linen weave: warp and weft threads a few pixels apart, each a little uneven, at a slight angle.
    const p = 9;
    return `<defs><pattern id="w" width="${p}" height="${p}" patternUnits="userSpaceOnUse" patternTransform="rotate(${(a % 30) - 15})"><rect width="${p}" height="${p}" fill="${base}"/><rect width="${p}" height="${p / 2}" fill="${line}" fill-opacity=".42"/><rect width="${p / 2}" height="${p}" fill="${light}" fill-opacity=".34"/></pattern><filter id="u" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.02 0.004" numOctaves="2" seed="${s}"/><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .18 0"/></filter></defs><rect width="100%" height="100%" fill="url(#w)"/><rect width="100%" height="100%" filter="url(#u)"/>${g('n', 1.1, 0.05)}`;
  }
  if (tex.kind === 'glass') {
    // Liquid glass: soft pools of the account's colour behind a frosted pane, a sheen across it at the post's angle.
    // Three pools spread over the slide (top, middle, foot), each moved by the seed.
    const pts = [[0.22, 0.2], [0.8, 0.52], [0.3, 0.86]].map(([x, y], i) => [x + (((s * (i + 3)) % 21) - 10) / 100, y + (((s * (i + 5)) % 15) - 7) / 100]);
    const blobs = pts.map(([x, y], i) => `<circle cx="${Math.round(x * W)}" cy="${Math.round(y * H)}" r="${Math.round((0.35 + 0.1 * i) * W)}" fill="url(#b${i % 2})"/>`).join('');
    return `<defs><radialGradient id="b0"><stop offset="0" stop-color="${glow}" stop-opacity=".55"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient><radialGradient id="b1"><stop offset="0" stop-color="${light}" stop-opacity=".5"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient><linearGradient id="s" gradientTransform="rotate(${a})"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="bl" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="60"/></filter></defs><rect width="100%" height="100%" fill="${base}"/><g filter="url(#bl)">${blobs}</g><rect width="100%" height="100%" fill="url(#s)"/>${[0, 1, 2, 3].map((i) => `<rect x="${-W}" y="${Math.round(H * (0.12 + 0.24 * i))}" width="${3 * W}" height="${26 + 18 * (i % 2)}" fill="#fff" fill-opacity="${i % 2 ? 0.05 : 0.08}" transform="rotate(${(a % 30) - 15 + i * 4} ${W / 2} ${H / 2})" filter="url(#soft)"/>`).join('')}<defs><filter id="soft" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="6"/></filter></defs>${g('n', 0.8, 0.05)}`;
  }
  // Artisan plaster: a low relief of trowel strokes, lit from the post's angle.
  return `<defs><filter id="p" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.006" numOctaves="4" seed="${s}" result="t"/><feDiffuseLighting in="t" lighting-color="${light}" surfaceScale="14" result="l"><feDistantLight azimuth="${a}" elevation="55"/></feDiffuseLighting><feComposite in="l" in2="SourceGraphic" operator="in"/></filter></defs><rect width="100%" height="100%" fill="${base}"/><rect width="100%" height="100%" fill="${base}" filter="url(#p)" opacity=".95"/>${g('n', 1, 0.05)}`;
}

// Mulberry32: a slide's decor from its own seed, the same on every render.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const P = (n) => Math.round(n);

/**
 * A slide's cut-outs and doodles, in its palette's other colours: two pieces at two of its corners (the next two each
 * slide, so no two slides in a row match), peeking in from the edge, and three doodles in the bands above and below
 * the words (the top 15% and the bottom 13%). "" for a post before palettes. Pure.
 */
export function decor(tex, tones, W, H) {
  const pal = paletteOf(tex);
  if (!pal) return '';
  const k = tex.slide || 0;
  const r = rng(tex.seed * 31 + k * 977 + 7);
  const pick = (i) => pal.others[(i + k) % pal.others.length];
  const corners = [[0, 0], [1, 1], [1, 0], [0, 1]];
  const out = [];
  for (let n = 0; n < 2; n++) {
    const [cx, cy] = corners[(k + n * 2 + (k >> 2)) % 4];
    const sz = W * (0.2 + r() * 0.1);
    const x = cx ? W - sz * (0.15 + r() * 0.25) : sz * (0.15 + r() * 0.25);
    const y = cy ? H - sz * (0.25 + r() * 0.25) : sz * (0.25 + r() * 0.25);
    out.push(piece(tex.kind, r, x, y, sz, pick(n), pick(n + 1), tones));
  }
  for (let n = 0; n < 3; n++) {
    const x = W * (0.12 + r() * 0.76);
    const y = n % 2 ? H * (0.88 + r() * 0.08) : H * (0.04 + r() * 0.09);
    out.push(doodle(r, x, y, W * (0.03 + r() * 0.025), pick(n + 2)));
  }
  return `<g>${out.join('')}</g>`;
}

/** One cut-out of a texture's own kind, centred at x, y, about `sz` across. */
function piece(kind, r, x, y, sz, c1, c2, tones) {
  const rot = P(r() * 70 - 35);
  const tf = `transform="rotate(${rot} ${P(x)} ${P(y)})"`;
  if (kind === 'paper') {
    // A torn scrap of coloured paper, a strip of tape holding it down.
    const pts = Array.from({ length: 18 }, (_, i) => {
      const t = (i / 18) * 2 * Math.PI;
      const rr = (sz / 2) * (0.86 + r() * 0.14) * (i % 2 ? 0.94 : 1);
      return `${P(x + Math.cos(t) * rr * 1.2)},${P(y + Math.sin(t) * rr * 0.85)}`;
    });
    return `<g ${tf}><polygon points="${pts.join(' ')}" fill="${c1}"/><rect x="${P(x - sz * 0.32)}" y="${P(y - sz * 0.5)}" width="${P(sz * 0.64)}" height="${P(sz * 0.17)}" fill="#fff" fill-opacity=".55" transform="rotate(${P(r() * 20 - 10)} ${P(x)} ${P(y - sz * 0.42)})"/></g>`;
  }
  if (kind === 'mat') {
    // A shape cut from card (a circle, a triangle or a half moon), its cut line dashed beside it.
    const h = sz / 2;
    const shape = [
      (o) => `<circle cx="${P(x + o)}" cy="${P(y + o)}" r="${P(h)}"`,
      (o) => `<polygon points="${P(x + o)},${P(y - h + o)} ${P(x + h + o)},${P(y + h * 0.8 + o)} ${P(x - h + o)},${P(y + h * 0.8 + o)}"`,
      (o) => `<path d="M${P(x - h + o)} ${P(y + o)} A${P(h)} ${P(h)} 0 0 1 ${P(x + h + o)} ${P(y + o)} Z"`,
    ][Math.floor(r() * 3)];
    return `<g ${tf}>${shape(14)} fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="4" stroke-dasharray="14 10"/>${shape(0)} fill="${c1}"/></g>`;
  }
  if (kind === 'fabric') {
    // A felt patch, stitched round its edge, and a button.
    const b = sz * 0.16;
    return `<g ${tf}><rect x="${P(x - sz / 2)}" y="${P(y - sz * 0.4)}" width="${P(sz)}" height="${P(sz * 0.8)}" rx="${P(sz * 0.18)}" fill="${c1}"/><rect x="${P(x - sz / 2 + 14)}" y="${P(y - sz * 0.4 + 14)}" width="${P(sz - 28)}" height="${P(sz * 0.8 - 28)}" rx="${P(sz * 0.14)}" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="4" stroke-dasharray="16 11"/><circle cx="${P(x + sz * 0.5)}" cy="${P(y + sz * 0.4)}" r="${P(b)}" fill="${c2}"/>${[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dy]) => `<circle cx="${P(x + sz * 0.5 + dx * b * 0.3)}" cy="${P(y + sz * 0.4 + dy * b * 0.3)}" r="${P(b * 0.12)}" fill="${tones.base}"/>`).join('')}</g>`;
  }
  if (kind === 'glass') {
    // A glass bubble of colour with its highlight, a smaller one beside it.
    const bub = (bx, by, br, c) => `<circle cx="${P(bx)}" cy="${P(by)}" r="${P(br)}" fill="${c}" fill-opacity=".72"/><circle cx="${P(bx)}" cy="${P(by)}" r="${P(br)}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="3"/><ellipse cx="${P(bx - br * 0.35)}" cy="${P(by - br * 0.4)}" rx="${P(br * 0.28)}" ry="${P(br * 0.16)}" fill="#fff" fill-opacity=".5" transform="rotate(-35 ${P(bx - br * 0.35)} ${P(by - br * 0.4)})"/>`;
    return bub(x, y, sz / 2, c1) + bub(x + sz * 0.55 * (x > 540 ? -1 : 1), y + sz * 0.35, sz * 0.16, c2);
  }
  // Artisan: a broad brush stroke of paint and its splatter.
  const dots = Array.from({ length: 6 }, () => `<circle cx="${P(x + (r() - 0.5) * sz * 1.6)}" cy="${P(y + (r() - 0.5) * sz)}" r="${P(4 + r() * 10)}" fill="${c2}"/>`).join('');
  return `<g ${tf}><path d="M${P(x - sz * 0.7)} ${P(y)} C${P(x - sz * 0.3)} ${P(y - sz * 0.35)}, ${P(x + sz * 0.2)} ${P(y + sz * 0.3)}, ${P(x + sz * 0.7)} ${P(y - sz * 0.05)}" fill="none" stroke="${c1}" stroke-width="${P(sz * 0.3)}" stroke-linecap="round" stroke-opacity=".92"/>${dots}</g>`;
}

/** A small doodle: a sparkle, a squiggle or a ring of dots. */
function doodle(r, x, y, d, c) {
  const n = Math.floor(r() * 3);
  if (n === 0) return `<path d="M${P(x)} ${P(y - d)} Q${P(x)} ${P(y)} ${P(x + d)} ${P(y)} Q${P(x)} ${P(y)} ${P(x)} ${P(y + d)} Q${P(x)} ${P(y)} ${P(x - d)} ${P(y)} Q${P(x)} ${P(y)} ${P(x)} ${P(y - d)} Z" fill="${c}"/>`;
  if (n === 1) return `<path d="M${P(x - d * 1.5)} ${P(y)} q${P(d / 2)} ${P(-d / 2)} ${P(d)} 0 t${P(d)} 0 t${P(d)} 0" fill="none" stroke="${c}" stroke-width="${P(d / 4)}" stroke-linecap="round"/>`;
  return [0, 1, 2].map((i) => `<circle cx="${P(x + (i - 1) * d * 0.9)}" cy="${P(y)}" r="${P(d / 4)}" fill="${c}"/>`).join('');
}

/** A texture as a CSS background (a data URI of its SVG), for a W x H slide. Pure. */
export function textureCss(tex, colors, W, H) {
  const tones = textureTones(tex, colors);
  return `background:${tones.base} url('data:image/svg+xml;base64,${Buffer.from(textureSvg(tex, tones, W, H)).toString('base64')}') center/cover no-repeat`;
}
