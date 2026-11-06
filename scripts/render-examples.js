#!/usr/bin/env node
// The examples Teder's pickers show beside each kind of slideshow and each slide style (src/web/formats.js,
// src/web/styles.js): one slide of a post of each, drawn by the engine itself from the demo pack's recordings, never at
// request time and never with a key (the owner, 2026-11-06: "the teder website should show an example of the format,
// not only a description").
//
//   node scripts/render-examples.js
//
// Each post is built offline (recorded drafts, OF_MODE=recorded), its photographs the demo's own: the public-domain and
// CC0 plant photographs in src/web/static/examples/photos (credits.json), given to the demo as the owner's photographs.
// Each is drawn in a designed style (FORMAT_STYLE: the look a business is given first, never the native E), and the
// story post in every style; the slide is written small (270 x 480) to
// src/web/static/examples/format-<id>.jpg and style-<A..E>.jpg, which the site serves as they are.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|ZERNIO_|UNSPLASH_|PEXELS_|BRAVE_|OPENVERSE_TOKEN)/.test(k)) delete process.env[k];
process.env.OF_MODE = 'recorded';
const home = mkdtempSync(path.join(os.tmpdir(), 'of-examples-'));
process.env.OF_HOME = home;

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { examplesDir } = await import('../src/core/paths.js');
const { Db } = await import('../src/db/index.js');
const { loadAll } = await import('../src/packs/load.js');
const { makeContext } = await import('../src/engine.js');
const { buildPost, loadPost } = await import('../src/pipeline/build.js');
const { renderStylePreview } = await import('../src/render/styles/preview.js');
const { getBrowser, closeBrowser } = await import('../src/render/render.js');
const { LIBRARY } = await import('../src/formats/library.js');
const { STYLE_NAMES } = await import('../src/render/styles/tokens.js');
const FORMAT_STYLE = 'A';

const OUT = path.join(root, 'src', 'web', 'static', 'examples');
const PHOTOS = path.join(OUT, 'photos');
const credits = JSON.parse(readFileSync(path.join(PHOTOS, 'credits.json'), 'utf8'));
const tags = credits.map((c) => c.file.replace(/\.jpg$/, ''));

// Each kind of the library, from the demo's recording of a format of the same kind (facts and tips from its lists).
const FROM = {
  facts: ['winter-herbs', 'quick-facts'], tips: ['watering-mistakes', 'mistakes'], story: ['pothos-story', 'plant-story'], 'what-happened': ['fern-fall', 'what-happened'],
  'guess-who': ['guess-aloe', 'guess-plant'], 'head-to-head': ['mint-vs-basil', 'plant-vs'], ranking: ['drought-ranking', 'plant-ranking'], 'myth-fact': ['plant-myths', 'myth-fact'],
  iceberg: ['basil-iceberg', 'plant-iceberg'], 'hot-take': ['overwatering-take', 'hot-take'], 'on-this-day': ['balcony-day', 'garden-day'], explainer: ['basil-containers', 'care-guide'],
};

/** A fresh demo account whose photographs are the examples' own, its recorded slides searching for them. */
function account(n) {
  const dir = path.join(home, `h${n}`);
  const pack = path.join(dir, 'packs', 'demo');
  cpSync(path.join(examplesDir, 'demo'), pack, { recursive: true });
  const meta = JSON.parse(readFileSync(path.join(pack, 'pack.json'), 'utf8'));
  // Built in the demo's own theme, for which its drafts were written, every slide on a photograph (the examples' as its
  // scenes too); drawn in the styles after (renderStylePreview, as the style page draws an account's post).
  writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ ...meta, imagery: { providers: ['pack'] } }));
  const theme = JSON.parse(readFileSync(path.join(pack, 'theme.json'), 'utf8'));
  writeFileSync(path.join(pack, 'theme.json'), JSON.stringify({ ...theme, backgroundQueries: tags, options: { ...(theme.options || {}), backgroundPhoto: true, coverPhoto: true } }));
  cpSync(PHOTOS, path.join(pack, 'photos'), { recursive: true });
  writeFileSync(path.join(pack, 'photos', 'photos.json'), JSON.stringify({ photos: credits.map((c, i) => ({ file: c.file, subject: tags[i], description: `${tags[i]} plant`, tags: [tags[i]], license: c.license, credit: c.artist || 'Wikimedia Commons', origin: c.source })) }));
  // Each slide of every recording searches one of the photographs, in turn.
  const drafts = path.join(pack, 'recordings', 'drafts');
  for (const key of Object.values(FROM).map(([k]) => k)) {
    const f = path.join(drafts, `${key}.json`);
    const d = JSON.parse(readFileSync(f, 'utf8'));
    d.outline.imageQuery = tags[0];
    (d.slides.slides || []).forEach((s, i) => (s.imageQuery = tags[(i + key.length) % tags.length]));
    // A guess-who's reveal is its answer (the aloe), a head-to-head's two sides two of the photographs.
    if (key === 'guess-aloe') d.slides.slides.at(-1).imageQuery = 'aloe';
    if (key === 'mint-vs-basil') Object.assign(d.outline, { imageQuery: 'fern', imageQueryB: 'succulent' });
    writeFileSync(f, JSON.stringify(d));
  }
  process.env.OF_HOME = dir;
  const db = new Db(path.join(dir, 'data.db'));
  const ctx = makeContext({ db, mode: 'recorded', packs: loadAll({ dir: path.join(dir, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(dir, 'media');
  ctx.imagesLive = true;
  return { ctx, db, pack: ctx.pack('demo'), dir };
}

/** A slide written small, as JPEG, through the render browser's canvas. */
async function small(file, to) {
  const tab = await (await getBrowser()).newPage();
  try {
    const b64 = await tab.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 270;
      c.height = 480;
      c.getContext('2d').drawImage(img, 0, 0, 270, 480);
      return c.toDataURL('image/jpeg', 0.82).split(',')[1];
    }, `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`);
    writeFileSync(to, Buffer.from(b64, 'base64'));
  } finally {
    await tab.close();
  }
}

const made = [];
let n = 0;
for (const f of LIBRARY) {
  const [docKey, formatKey] = FROM[f.id] || [];
  if (!docKey) continue;
  const { ctx, db, pack, dir } = account(n++);
  // The on-this-day recording is about the 14th of October.
  const res = await buildPost(ctx, { pack, sample: true, formatKey, docKey, ...(f.id === 'on-this-day' ? { day: '2026-10-14' } : {}) });
  if (res.status !== 'sample') {
    console.log(`${f.id}: no example (${res.kind}: ${res.reason})`);
    continue;
  }
  const post = loadPost(db, res.postId);
  for (const style of f.id === 'story' ? STYLE_NAMES : [FORMAT_STYLE]) {
    const r = await renderStylePreview(db, { pack, post, style, outDir: path.join(dir, 'preview') });
    const slide = r.files[r.files.length > 1 ? 1 : 0];
    if (style === FORMAT_STYLE) await small(slide, path.join(OUT, `format-${f.id}.jpg`));
    if (f.id === 'story') await small(r.files[0], path.join(OUT, `style-${style}.jpg`));
  }
  made.push(f.id);
  db.raw.close();
  console.log(`${f.id}: ${res.postId}`);
}
await closeBrowser();
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* a file still open on Windows: the temporary folder is harmless */
}
console.log(`examples: ${made.length} formats (${made.join(', ')})${existsSync(path.join(OUT, 'style-E.jpg')) ? ', and the five styles' : ''}`);
