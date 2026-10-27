#!/usr/bin/env node
// npm run redraw -- --pack <id> [--post <id>] [--style E] [--out <dir>]
//
// Draws a dry run's posts again, in the pack's style as it is now (or the one named), from what the dry run stored:
// its text, its facts' sources and its photographs. No model is called and nothing is searched: it is for looking
// at a change to a style on posts already made. Its slides go to <out>/<post>/, next to nothing else.

import path from 'node:path';
import { ofHome } from '../src/core/paths.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const packId = opt('pack');
if (!packId) {
  console.error('usage: npm run redraw -- --pack <id> [--post <id>] [--style E] [--out <dir>]');
  process.exit(1);
}

const { loadEnv } = await import('../src/core/env.js');
loadEnv();
const { Db } = await import('../src/db/index.js');
const { loadPack, resolvePackDir } = await import('../src/packs/load.js');
const { loadPost, postDraft, formatOfPost, sourceLabel } = await import('../src/pipeline/build.js');
const { renderPost, closeBrowser } = await import('../src/render/render.js');
const { themeOf } = await import('../src/render/styles/index.js');
const { tokenOf } = await import('../src/verify/claims.js');

const pack = loadPack(resolvePackDir(packId));
const db = new Db(path.join(ofHome(), 'data', `dry-${packId}.db`));
const ids = opt('post') ? [opt('post')] : db.all("SELECT id FROM posts WHERE status NOT IN ('blocked', 'drafting') ORDER BY created_at").map((r) => r.id);
const out = opt('out', path.join(ofHome(), 'data', 'out', 'redraw', packId));
const theme = themeOf(pack, opt('style') || null);
for (const id of ids) {
  const post = loadPost(db, id);
  const draft = postDraft(post);
  const format = formatOfPost(db, pack, post);
  const source = new Map(post.facts.map((f) => [f.key, sourceLabel(db, f)]));
  const slides = draft.slides.map((s) => ({ ...s, sources: s.factKeys.map((k) => source.get(k)) }));
  const img = (imageId) => (imageId ? db.get('SELECT * FROM images WHERE id = ?', imageId) : null);
  const photos = new Map([...post.slides.map((s, i) => [i, img(s.image_id)]), ['bg', img(post.checks?.bgImage)], ...(post.checks?.sceneImages || []).map((x, k) => [`bg${k + 2}`, img(x)]), ...(post.checks?.coverImages || []).map((x, k) => [k ? 'cb' : 'ca', img(x)])].filter(([, p]) => p?.file));
  const extra = { captionIg: draft.captionIg || '', keywords: draft.keywords || [], subject: draft.subject || {}, cta: draft.cta?.text || '', ...(draft.coverVisual ? { coverVisual: draft.coverVisual } : {}) };
  const token = tokenOf({ slides, caption: draft.caption, hook: draft.hook, sub: draft.sub, extra });
  const files = await renderPost({ pack: { ...pack, theme }, format, post: { id, hook: draft.hook, sub: draft.sub, caption: draft.caption, token, extra, ctaKind: draft.cta?.kind }, slides, photos, outDir: path.join(out, id), lenient: true });
  console.log(`${id} ${format.id}: ${Object.values(files).flat().length} slides -> ${path.join(out, id)}`);
}
await closeBrowser();
