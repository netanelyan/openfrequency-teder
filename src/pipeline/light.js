import { existsSync } from 'node:fs';
import path from 'node:path';
import { kindOf } from '../formats/kinds.js';
import { renderPost } from '../render/render.js';
import { lockedStyle, styleByHash } from '../render/style.js';

// The customer's light edits on a post's page (src/web/actions.js): a slide's text, another of the post's own
// photographs, a slide removed. Each one draws the post again and calls no model, except the fact check of text that
// changed. None is a redo: the quota (src/budget/quota.js) does not see them.

/**
 * The photographs a slide may take instead of its own: every one this post already fetched, screened and recorded
 * (the cover's, each slide's, the one behind the slides, a head-to-head's two faces), that passed the screen or that a
 * person cleared, and whose file is still there. Nothing new is searched for: that would be a model call.
 */
export function photoChoices(db, post) {
  const ids = [...new Set([...(post.checks?.images || []), post.checks?.image, post.checks?.bgImage, ...(post.checks?.sceneImages || []), ...(post.checks?.coverImages || []), ...post.slides.map((s) => s.image_id)].filter(Boolean))];
  return ids
    .map((id) => db.get('SELECT * FROM images WHERE id = ?', id))
    .filter((img) => img && (img.safety == null || img.safety === 'ok' || img.reviewed_at) && img.file && existsSync(img.file));
}

/**
 * Draw a post again from a draft whose slides carry `imageId` (the photograph each one shows, or none): in the look it
 * went out in, with the photographs behind the slides and on a head-to-head's cover as they were. Returns { files, look }.
 */
export async function drawAgain(ctx, { post, pack, format, draft, token }) {
  const { db } = ctx;
  const names = new Map(db.all('SELECT id, name FROM sources WHERE account_id = ?', pack.id).map((r) => [r.id, r.name]));
  const sourceOf = new Map(post.facts.map((f) => [f.key, names.get(f.source_id)]));
  const slides = draft.slides.map((s) => ({ ...s, sources: s.factKeys.map((k) => sourceOf.get(k)) }));
  const image = post.checks?.image ? db.get('SELECT * FROM images WHERE id = ?', post.checks.image) : null;
  const outDir = path.dirname(post.media.tiktok?.[0] || post.media.instagram?.[0]);
  const extra = { captionIg: draft.captionIg || '', keywords: draft.keywords || [], subject: draft.subject || {}, cta: draft.cta?.text || '' };
  // Drawn again as it was drawn: in the look it went out in, with every photograph it had (each slide's, the one
  // behind the slides, a head-to-head's two faces). An edit used to bring back the cover's photograph alone.
  const look = styleByHash(db, pack, post.checks?.style) || lockedStyle(db, pack, (ctx.global || ctx).packs);
  const img = (imageId) => (imageId ? db.get('SELECT * FROM images WHERE id = ?', imageId) : null);
  const photos = new Map(
    [...draft.slides.map((s, i) => [i, img(s.imageId)]), ['bg', img(post.checks?.bgImage)], ...(post.checks?.sceneImages || []).map((x, k) => [`bg${k + 2}`, img(x)]), ...(post.checks?.coverImages || []).map((x, k) => [k ? 'cb' : 'ca', img(x)])].filter(([, p]) => p?.file)
  );
  const files = await renderPost({
    pack: { ...pack, theme: look.theme }, format, post: { id: post.id, hook: draft.hook, sub: draft.sub, caption: draft.caption, token, extra, ctaKind: draft.cta?.kind }, slides,
    ...(photos.size ? { photos } : { photo: image, photoOn: kindOf(format).photo }), outDir,
  });
  return { files, look };
}

/** The draft's slides with the photograph each one shows now, for drawAgain. */
export const withImages = (draft, post) => ({ ...draft, slides: draft.slides.map((s, i) => ({ ...s, imageId: post.slides[i]?.image_id ?? null })) });
