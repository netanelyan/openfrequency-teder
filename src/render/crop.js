// How a photograph fills a slide, and where on it the words may stand. Pure, with no imports: the image search uses it
// to choose a photograph a slide can be cut from (src/images/index.js findImage), and the renderer to cut it and to
// place the words (src/render/render.js, src/render/styles/index.js).
//
// The owner, 2026-11-06, on the five samples: "tiktok format should be 9:16. no landscape images with blurred
// background", and on the pets post: "the text should appear in an empty space in the background. for example, not on
// top of the nuts, but in a place where it looks natural (the wall in the background). if an image is too official and
// does not have a place like that, it should be regenerated."
//
// A photograph always fills its slide (object-fit: cover), cut around its main subject: a photograph whose subject a
// 9:16 cut would lose is not chosen (subjectFits). The words of a slide drawn over its photograph stand in its calmest
// band, the one with the least detail, away from the subject (calmRoom); a photograph with no such band is not chosen
// for a style that sets its words on the photograph.

/** The frame of a platform's slide, in px. */
export const FRAMES = { tiktok: { W: 1080, H: 1920 }, instagram: { W: 1080, H: 1350 } };

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * The main subject of a photograph as its screen measured it, in fractions of the picture: { cx, cy, w, h }. The
 * screen gives its centre (faceX, faceY: a face, else the main subject) and, since 2026-11-06, its size (subjectW,
 * subjectH). `known` is false for a picture screened before that, or by no model: it is cut at its centre (its screen
 * said 50 and 30 for "no face"), taken as a subject a third of it across, and the words are not kept off a subject
 * nobody measured. Pure.
 */
export function subjectOf(screen) {
  const m = screen?.model || screen || {};
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  const known = ok(m.subjectW) && ok(m.subjectH);
  const n = (v, d) => (ok(v) ? clamp(v / 100) : d);
  return known ? { cx: n(m.faceX, 0.5), cy: n(m.faceY, 0.4), w: n(m.subjectW, 1 / 3), h: n(m.subjectH, 1 / 3), known } : { cx: n(m.faceX, 0.5), cy: 0.5, w: 1 / 3, h: 1 / 3, known };
}

/**
 * The part of a w x h photograph a W x H frame shows when the photograph fills it, cut so that its subject is as near
 * the middle as the picture allows: { x0, x1, y0, y1 } in fractions of the picture, and `pos`, the CSS object-position
 * that cuts it so ("37.5% 20%"). Pure.
 */
export function cropFor(size, frame, subject = { cx: 0.5, cy: 0.4 }) {
  const a = size.w / size.h;
  const A = frame.W / frame.H;
  // The share of the picture's width (or height) the frame keeps.
  const kx = a > A ? A / a : 1;
  const ky = a > A ? 1 : a / A;
  const x0 = clamp(subject.cx - kx / 2, 0, 1 - kx);
  const y0 = clamp(subject.cy - ky / 2, 0, 1 - ky);
  // object-position p% puts the picture's p% point on the frame's p% point: the offset is p * (1 - k).
  const px = kx < 1 ? (x0 / (1 - kx)) * 100 : 50;
  const py = ky < 1 ? (y0 / (1 - ky)) * 100 : 50;
  return { x0, x1: x0 + kx, y0, y1: y0 + ky, pos: `${Math.round(px * 10) / 10}% ${Math.round(py * 10) / 10}%` };
}

/** Whether the frame's cut keeps the whole subject (a hair of its edge may go). Pure. */
export function subjectFits(size, frame, subject) {
  const c = cropFor(size, frame, subject);
  const slack = 0.01;
  return subject.w <= c.x1 - c.x0 + slack && subject.h <= c.y1 - c.y0 + slack;
}

/**
 * How busy each band of the slide is, top to bottom: the picture's detail (its grid, src/images/safety.js
 * detailGrid: the mean edge strength of each cell, 0 to 1) inside the part the frame shows, averaged across the
 * frame's width, in `bands` bands of equal height. Pure.
 */
export function bandProfile(grid, crop, bands = 48) {
  if (!grid?.cells?.length) return null;
  const { cols, rows, cells } = grid;
  const c0 = Math.floor(crop.x0 * cols);
  const c1 = Math.max(c0 + 1, Math.ceil(crop.x1 * cols));
  const out = [];
  for (let b = 0; b < bands; b++) {
    const r0 = Math.floor((crop.y0 + ((crop.y1 - crop.y0) * b) / bands) * rows);
    const r1 = Math.max(r0 + 1, Math.floor((crop.y0 + ((crop.y1 - crop.y0) * (b + 1)) / bands) * rows));
    let sum = 0;
    let n = 0;
    for (let r = r0; r < Math.min(rows, r1); r++) for (let k = c0; k < Math.min(cols, c1); k++) (sum += cells[r * cols + k]), n++;
    out.push(n ? sum / n : 0);
  }
  return out;
}

/**
 * The subject's band on the slide that the words keep off, in px from its top, once the photograph is cut to the
 * frame: its middle 70%, so a line may touch the edge of a bowl or the top of a head but never cross the subject. Pure.
 */
export function subjectBand(crop, subject, H) {
  const y = (v) => ((v - crop.y0) / (crop.y1 - crop.y0)) * H;
  const half = (subject.h * 0.7) / 2;
  return { top: clamp(y(subject.cy - half), 0, H), bottom: clamp(y(subject.cy + half), 0, H) };
}

/** Detail at or under this, in a band the words stand in, reads as calm: a wall, a sky, a table, a blurred distance. */
export const CALM_MAX = 0.11;

/**
 * Where a block of words `need` px tall stands on a photograph: the window between `top` and `bottom` (the slide's safe
 * area, px) with the least detail (`profile`, bandProfile over the slide's height H), never over the subject (`avoid`,
 * px), the middle of the slide preferred a little when two read alike. Returns { top, bottom, detail, calm } or null
 * when no window keeps clear of the subject. `calm`: the window's detail is at most CALM_MAX. Pure.
 */
export function calmRoom({ profile, H, top, bottom, need, avoid = null }) {
  if (!profile?.length || bottom - top < need) return null;
  const band = H / profile.length;
  const step = Math.max(8, Math.round(band / 2));
  let best = null;
  for (let t = top; t + need <= bottom; t += step) {
    if (avoid && t < avoid.bottom && t + need > avoid.top) continue;
    const b0 = Math.floor(t / band);
    const b1 = Math.min(profile.length, Math.ceil((t + need) / band));
    const slice = profile.slice(b0, b1);
    // The window's busiest stretch counts as much as its mean: words over one busy line read badly however calm the rest.
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    const detail = 0.6 * mean + 0.4 * Math.max(...slice);
    const score = detail + 0.02 * Math.abs((t + need / 2) / H - 0.5);
    if (!best || score < best.score) best = { top: t, bottom: t + need, detail, score };
  }
  return best ? { top: best.top, bottom: best.bottom, detail: Math.round(best.detail * 1000) / 1000, calm: best.detail <= CALM_MAX } : null;
}
