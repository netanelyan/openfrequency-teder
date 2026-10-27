import { existsSync } from 'node:fs';
import path from 'node:path';
import { mediaDir } from '../../core/paths.js';
import { formatOfPost, loadPost, postDraft } from '../../pipeline/build.js';
import { tokenOf } from '../../verify/claims.js';
import { renderPost, slidePlaces } from '../render.js';
import { kindName } from '../../formats/kinds.js';
import { slideModel } from './model.js';
import { STYLE_NAMES } from './tokens.js';
import { themeOf } from './index.js';

// An account's last post drawn again in every style, side by side: what the owner picks a style from (Accounts),
// and what a review of the styles is made of. The post's own checked text and photographs, nothing else: drawn
// leniently (a text too long for a style is drawn anyway and said), never stored on the post, never published.
//
// A post written before highlights has none. The preview marks one chosen in code, so the owner sees how the style
// treats one: the post's first number, else its first name in Latin letters, else none. A new post's highlight is
// the writer's.

/** The highlight a preview marks in a headline that has none: its first number, or its first Latin name. */
export function previewHighlight(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const num = /[$€£₪]?\d[\d,.]*(?:%|₪)?/.exec(t);
  const latin = /[A-Za-z][A-Za-z.'’-]*(?: [A-Za-z][A-Za-z.'’-]*){0,2}/.exec(t);
  const pick = (num?.[0] || latin?.[0] || '').replace(/[.,]$/, '');
  // Never the whole headline: a highlight is the words that stand out of it.
  return pick && pick !== t.replace(/[.?!]$/, '') ? pick : '';
}

/** The slides a preview shows: the cover, then a number slide and a text slide when the post has both, else the first two. */
export function previewSlides(slides, postKind) {
  const places = slidePlaces(slides);
  const content = slides.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === 'item');
  const kind = ({ s, i }) => slideModel({ ...s, ...places[i], postKind }).kind;
  const num = content.find((x) => kind(x) === 'number');
  const txt = content.find((x) => kind(x) === 'text');
  const two = num && txt ? [num, txt].sort((a, b) => a.i - b.i) : content.slice(0, 2);
  return [0, ...two.map((x) => x.i)];
}

/** The last post of an account that was drawn: rendered, with its slides on disk. */
export function lastPost(db, accountId) {
  const row = db.get(
    "SELECT id FROM posts WHERE account_id = ? AND media_json IS NOT NULL AND status IN ('queued','approved','published','publishing','sample') ORDER BY COALESCE(slot_at, created_at) DESC LIMIT 1",
    accountId
  );
  return row ? loadPost(db, row.id) : null;
}

/**
 * One post drawn in one style (`style`: 'A'..'E'): { files, slides: [idx], warnings, highlights }. `size`: one
 * platform. The files go to `outDir`.
 */
export async function renderStylePreview(db, { pack, post, style, outDir, size = 'tiktok', highlights = true }) {
  const draft = postDraft(post);
  const names = new Map(db.all('SELECT id, name FROM sources WHERE account_id = ?', pack.id).map((r) => [r.id, r.name]));
  const sourceOf = new Map(post.facts.map((f) => [f.key, names.get(f.source_id)]));
  const marked = [];
  const slides = draft.slides.map((s, i) => {
    const own = post.slides[i]?.data?.highlight || '';
    const head = s.kind === 'cover' ? draft.hook : s.title;
    const hl = own || (highlights ? previewHighlight(head) : '');
    if (hl && !own) marked.push(i);
    return { ...s, sources: s.factKeys.map((k) => sourceOf.get(k)), highlight: hl };
  });
  // A photograph recorded under a data folder that has since moved is looked for in this one, by its name.
  const img = (id) => {
    const row = id ? db.get('SELECT * FROM images WHERE id = ?', id) : null;
    if (!row?.file || existsSync(row.file)) return row;
    const here = path.join(mediaDir(), 'images', path.basename(row.file.replace(/\\/g, '/')));
    return existsSync(here) ? { ...row, file: here } : row;
  };
  const photos = new Map(
    [...post.slides.map((s) => [s.idx, img(s.image_id)]), ['bg', img(post.checks?.bgImage)], ...(post.checks?.coverImages || []).map((x, k) => [k ? 'cb' : 'ca', img(x)])].filter(([, p]) => p?.file && existsSync(p.file))
  );
  const format = formatOfPost(db, pack, post);
  const extra = { captionIg: draft.captionIg || '', keywords: draft.keywords || [], subject: draft.subject || {}, cta: draft.cta?.text || '', ...(draft.coverVisual ? { coverVisual: draft.coverVisual } : {}) };
  const token = tokenOf({ slides, caption: draft.caption, hook: draft.hook, sub: draft.sub, extra });
  // The text drawn is the text the fact gate signed: a post whose stored text no longer hashes to its token is not drawn.
  if (post.checks?.token && post.checks.token !== token) throw new Error('the post\'s text is not the text the fact gate signed');
  const only = new Set(previewSlides(slides, kindName(format)));
  const files = await renderPost({
    pack: { ...pack, theme: themeOf(pack, style) }, format, post: { id: post.id, hook: draft.hook, sub: draft.sub, caption: draft.caption, token, extra, ctaKind: draft.cta?.kind },
    slides, photos, outDir: path.join(outDir, style), only, platforms: [size], lenient: true,
  });
  return { files: files[size], slides: [...only], warnings: files.warnings, highlights: marked };
}

/** The post in every style. */
export async function renderAllStyles(db, { pack, post, outDir, size = 'tiktok' }) {
  const out = {};
  for (const style of STYLE_NAMES) out[style] = await renderStylePreview(db, { pack, post, style, outDir, size });
  return out;
}
