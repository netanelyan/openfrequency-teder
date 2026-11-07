import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { PROVIDERS } from '../src/images/index.js';
import { detailGrid } from '../src/images/safety.js';
import { LAYOUTS, TEXTURES } from '../src/render/textures.js';
import { closeBrowser, getBrowser } from '../src/render/render.js';
import { copyPack, keepOnly, opened, setDraft, tempHome } from './helpers.js';

// Whole posts, built from the demo's recorded drafts with the photograph search run for real against a fake library
// (no network, no model): no post is queued, or kept as a sample, with a slide on no photograph, and a slide that
// names someone stands on a photograph of them (the owner, 2026-10-31: "the slides dont have images. no slide can be
// empty", "names cant be written without an image that connects them visually"). The account is drawn in style E,
// as a customer's account is, and its theme has no scenes, as the setup wrote them before.
//
// This file uses only what the engine exported before the change, so it runs against the code before it too: there,
// every test below fails (the commit message has the output).

const realPexels = PROVIDERS.pexels;
after(async () => {
  PROVIDERS.pexels = realPexels;
  await closeBrowser();
});

let jpeg = null;
async function photoFile(home) {
  if (!jpeg) {
    const tab = await (await getBrowser()).newPage();
    const b64 = await tab.evaluate(() => {
      const cv = document.createElement('canvas');
      cv.width = 1080;
      cv.height = 1600;
      const g = cv.getContext('2d');
      g.fillStyle = '#2f6f3a';
      g.fillRect(0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    await tab.close();
    jpeg = Buffer.from(b64, 'base64');
  }
  const file = path.join(home, 'photo.jpg');
  writeFileSync(file, jpeg);
  return file;
}

/**
 * A stand-in for Pexels: every search answers one photograph, which passes or is refused as `answer(query)` says:
 * 'ok', 'logo' (its description names a logo: refused), 'someone else' (its title names another person: refused for a
 * query that names someone), or 'none' (no result). `asked` keeps every search.
 */
function library(file, answer) {
  const asked = [];
  PROVIDERS.pexels = {
    id: 'pexels',
    ready: () => true,
    search: async (query) => {
      asked.push(query);
      const a = answer(query);
      if (a === 'none') return [];
      const title = a === 'someone else' ? 'Lee Sample at the Harbour Arena' : query;
      return [{ provider: 'pexels', providerId: `px-${query.replace(/\W+/g, '-')}`, title, file, url: null, license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', author: 'A. Photographer', authorUrl: null, sourceUrl: 'https://www.pexels.com/photo/1', alt: a === 'logo' ? `${query} logo` : query }];
    },
  };
  return asked;
}

// The demo's ranking of drought-proof plants, its five places given photograph searches: slide 2 names a person.
const QUERIES = ['clay pot close up', 'Dana Example', 'snake plant leaves', 'cactus close up', 'jade plant'];
const SCENE = /green leaves|potted plant|garden soil|house plants|houseplant care/;

function account(home) {
  const dir = copyPack(home, 'demo', (f) => {
    f.pack.style = { name: 'E' };
    f.pack.imagery = { providers: ['pexels'] };
    f.theme.options = { radius: 24, coverPhoto: false };
    delete f.theme.backgroundQueries;
  });
  keepOnly(dir, ['drought-ranking']);
  setDraft(dir, 'drought-ranking', (d) => {
    // The cover's own search too: a post is all photographs only when its cover has one of its own (build.js postMode).
    d.outline.imageQuery = 'aloe plant pot';
    d.slides.slides.forEach((s, i) => (s.imageQuery = QUERIES[i]));
  });
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  // Recorded drafts, photographs searched for real (as the launch set runs).
  ctx.imagesLive = true;
  return { ctx, dir, pack: ctx.pack('demo') };
}

const steps = (db, postId, name) => db.all('SELECT status, detail_json FROM steps WHERE post_id = ? AND step = ?', postId, name).map((r) => ({ status: r.status, ...JSON.parse(r.detail_json || '{}') }));

/** Every slide of a post, the closing slide's included, on its texture in one layout: what a post in text mode is. */
function allText(ctx, postId, label) {
  const post = loadPost(ctx.db, postId);
  assert.equal(post.checks.mode, 'text', `${label}: the post is in text mode`);
  assert.ok(TEXTURES.includes(post.checks.texture?.kind) && LAYOUTS.includes(post.checks.texture?.layout), `${label}: one texture and one layout`);
  const [photos] = steps(ctx.db, postId, 'photos').filter((p) => p.grounds);
  for (const [size, list] of Object.entries(photos.grounds)) {
    assert.equal(list.length, post.slides.length + 1, `${label} ${size}: every slide and the closing slide`);
    list.forEach((on, i) => assert.deepEqual(on, ['texture'], `${label} ${size} slide ${i + 1}: on the texture, no photograph or scene`));
  }
  assert.deepEqual(steps(ctx.db, postId, 'mode').map((x) => x.mode), ['text']);
  return post;
}

test("every slide's own photograph refused: the whole post is designed text on its texture, never a scene behind some slides", { timeout: 240_000 }, async () => {
  // Since the owner's word of 2026-11-06 ("a slideshows cant contain some slides with a photo and some without. if a
  // slideshow is without picture, the format is the nice text design"): a scene behind a slide is not its photograph.
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, dir, pack } = account(home);
    const file = await photoFile(home);
    const asked = library(file, (q) => (SCENE.test(q) ? 'ok' : q === 'Dana Example' ? 'someone else' : 'logo'));
    setDraft(dir, 'drought-ranking', (d) => (d.slides.slides[1].imageQuery = 'aloe vera pot'));
    const res = await buildPost(ctx, { pack });
    assert.equal(res.status, 'queued', res.reason);
    assert.ok(asked.length, 'the photographs were searched');
    for (const s of steps(ctx.db, res.postId, 'image').filter((x) => typeof x.slide === 'number')) assert.equal(s.status, 'skipped', `slide ${s.slide}'s own photograph was refused`);
    const post = allText(ctx, res.postId, 'refused');
    assert.ok(!post.checks.bgImage, 'no scene behind it');
  } finally {
    cleanup();
  }
});

test("a post about something to see (the outline's needsPhotos) with a slide on no photograph is another post, never designed text", { timeout: 240_000 }, async () => {
  // The owner, 2026-11-07: "a slideshow about nature, that talks about places must have images, same with specific food,
  // things like that - treat it as a rule."
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, dir, pack } = account(home);
    const file = await photoFile(home);
    library(file, (q) => (q === 'aloe plant pot' || SCENE.test(q) ? 'ok' : 'none'));
    setDraft(dir, 'drought-ranking', (d) => {
      d.outline.needsPhotos = true;
      d.slides.slides[1].imageQuery = 'aloe vera pot';
    });
    const res = await buildPost(ctx, { pack });
    assert.equal(res.status, 'blocked', 'blocked, not drawn as text');
    assert.match(res.reason, /רק עם תמונות/);
    assert.ok(!steps(ctx.db, res.postId, 'mode').length, 'never drawn');
  } finally {
    cleanup();
  }
});

test('a slide whose own search finds nothing gets new searches from the model, and the post stays on its photographs', { timeout: 240_000 }, async () => {
  // The owner, 2026-11-07: "the AI inside the teder engine should fight to get a slideshow with nice images, and cool
  // backgrounds are only the last last last fallback".
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, dir, pack } = account(home);
    const file = await photoFile(home);
    const asked = library(file, (q) => (q === 'clay pot close up' || q === 'pot close up' ? 'none' : 'ok'));
    setDraft(dir, 'drought-ranking', (d) => (d.slides.slides[1].imageQuery = 'aloe vera pot'));
    const told = [];
    const real = ctx.llm.json.bind(ctx.llm);
    ctx.llm = {
      ...ctx.llm,
      json: async (req) => {
        if (req.task !== 'image-search') return real(req);
        told.push(req.user);
        const slides = [...req.user.matchAll(/^Slide (\d+)/gm)].map((m) => ({ slide: Number(m[1]), queries: ['clay pot close up', 'terracotta pot'] }));
        return { data: { slides }, usage: null, estimated: true };
      },
    };
    const res = await buildPost(ctx, { pack });
    assert.equal(res.status, 'queued', res.reason);
    assert.equal(told.length, 1, 'one call for the slides still without a photograph');
    assert.match(told[0], /Searched: "clay pot close up"/, 'told what was searched');
    assert.ok(asked.includes('terracotta pot'), 'the new search was made');
    const rescued = steps(ctx.db, res.postId, 'image').filter((x) => x.rescue);
    assert.equal(rescued.length, 1);
    assert.equal(rescued[0].query, 'terracotta pot', 'never the search it already tried');
    assert.deepEqual(steps(ctx.db, res.postId, 'mode').map((x) => x.mode), ['photos'], 'on its photographs, not designed text');
  } finally {
    cleanup();
  }
});

test("nothing found at all, not even a scene: every slide stands on the post's texture, never on a bare ground", { timeout: 240_000 }, async () => {
  // The owner, 2026-11-06: "if a slideshow ... fails because of them, we can use generated background, but from a few
  // options: a cutting mat, paper texture, fabric texture, liquid glass, artisan texture" (src/render/textures.js).
  for (const sample of [false, true]) {
    const { home, cleanup } = tempHome({ packs: {} });
    try {
      const { ctx, pack } = account(home);
      // The libraries answer nothing (Openverse's 504s, Commons' refusals), the scenes included.
      const asked = library(await photoFile(home), () => 'none');
      const res = await buildPost(ctx, { pack, sample });
      assert.equal(res.status, sample ? 'sample' : 'queued', res.reason);
      assert.ok(asked.some((q) => SCENE.test(q)), 'the scenes were searched too');
      const post = loadPost(ctx.db, res.postId);
      assert.ok(TEXTURES.includes(post.checks.texture?.kind), 'the post has its texture');
      const [photos] = steps(ctx.db, res.postId, 'photos').filter((p) => p.grounds);
      for (const [size, list] of Object.entries(photos.grounds)) list.forEach((on, i) => assert.deepEqual(on, ['texture'], `${size} slide ${i + 1} on the texture`));
      // Not flat: the drawn slide has detail everywhere (a flat ground measures 0).
      const grid = await detailGrid(readFileSync(post.slides[1].files.tiktok), 'image/jpeg');
      assert.ok(grid.cells.filter((v) => v > 0.004).length > grid.cells.length * 0.5, 'the texture is drawn, not a flat ground');
    } finally {
      cleanup();
    }
  }
});

test('one slide whose photograph is refused makes the whole post designed text; with every photograph found, all photographs', { timeout: 240_000 }, async () => {
  // The text-first fallback (a named slide on the post's scene, 2026-11-06 morning) is gone: a post is all photographs
  // or all designed text (build.js postMode), whichever slide it was that had none.
  for (const dana of ['someone else', 'ok', 'three']) {
    const { home, cleanup } = tempHome({ packs: {} });
    try {
      const { ctx, dir, pack } = account(home);
      const NAMES = ['Dana Example', 'Avi Tester', 'Noa Person'];
      if (dana === 'three') setDraft(dir, 'drought-ranking', (d) => NAMES.forEach((n, i) => (d.slides.slides[i + 1].imageQuery = n)));
      const asked = library(await photoFile(home), (q) => (NAMES.includes(q) ? (dana === 'ok' ? 'ok' : 'someone else') : 'ok'));
      const res = await buildPost(ctx, { pack, sample: true });
      assert.equal(res.status, 'sample', res.reason);
      assert.ok(asked.includes('Dana Example'));
      if (dana === 'ok') {
        const post = loadPost(ctx.db, res.postId);
        assert.equal(post.checks.mode, 'photos', JSON.stringify(steps(ctx.db, res.postId, 'image').map((x) => [x.slide, x.status, x.why || x.reason || x.code])));
        const grounds = steps(ctx.db, res.postId, 'photos').at(-1).grounds;
        assert.deepEqual(grounds.tiktok[2], [2], 'slide 3 stands on her own photograph');
        for (const list of Object.values(grounds)) list.forEach((on, i) => assert.ok(on.length && !on.includes('texture'), `slide ${i + 1} on a photograph: ${JSON.stringify(on)}`));
        continue;
      }
      const post = allText(ctx, res.postId, dana);
      assert.deepEqual(post.checks.textLed || [], [], 'no slide text first on a scene');
    } finally {
      cleanup();
    }
  }
});

test('every photograph search failing on the network: the post stands on its texture, never on bare slides', { timeout: 240_000 }, async () => {
  // 2026-11-06: a re-run whose every Commons and Openverse request timed out drew a post of white words on black
  // slides. The engine's own rule stops it: no photograph found, no post (buildPost), whatever the reason.
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, pack } = account(home);
    const asked = [];
    PROVIDERS.pexels = { id: 'pexels', ready: () => true, search: async (q) => { asked.push(q); throw new Error(`fetch failed: ETIMEDOUT (${q})`); } };
    const res = await buildPost(ctx, { pack, sample: true });
    assert.ok(asked.length > 0, 'the photographs were searched');
    assert.equal(res.status, 'sample', res.reason);
    const post = loadPost(ctx.db, res.postId);
    const [photos] = steps(ctx.db, res.postId, 'photos').filter((p) => p.grounds);
    assert.ok(Object.values(photos.grounds).every((list) => list.every((on) => on.length === 1 && on[0] === 'texture')), 'every slide on the texture');
    // One texture for the whole post, on every slide.
    assert.equal(new Set(post.slides.map(() => post.checks.texture.kind)).size, 1);
  } finally {
    cleanup();
  }
});

test("a cover that names someone is not given up for text: a post whose other slide has no photograph is another post", { timeout: 240_000 }, async () => {
  // The one exception to text mode (build.js): a cover whose line names a person shows that person, so a post that
  // cannot be all photographs is blocked rather than drawn as text with the face dropped. Her photograph is found.
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, dir, pack } = account(home);
    setDraft(dir, 'drought-ranking', (d) => {
      d.outline.imageQuery = 'Dana Example';
      d.slides.slides[2].imageQuery = 'Avi Tester';
    });
    library(await photoFile(home), (q) => (q === 'Avi Tester' ? 'someone else' : 'ok'));
    const res = await buildPost(ctx, { pack, sample: true });
    assert.equal(res.status, 'blocked', res.reason);
    assert.match(res.reason, /Dana Example|השער/);
    assert.equal(steps(ctx.db, res.postId, 'photos').at(-1).mode, 'text');
  } finally {
    cleanup();
  }
});
