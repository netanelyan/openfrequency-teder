import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { PROVIDERS } from '../src/images/index.js';
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
  setDraft(dir, 'drought-ranking', (d) => d.slides.slides.forEach((s, i) => (s.imageQuery = QUERIES[i])));
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  // Recorded drafts, photographs searched for real (as the launch set runs).
  ctx.imagesLive = true;
  return { ctx, dir, pack: ctx.pack('demo') };
}

const steps = (db, postId, name) => db.all('SELECT status, detail_json FROM steps WHERE post_id = ? AND step = ?', postId, name).map((r) => ({ status: r.status, ...JSON.parse(r.detail_json || '{}') }));

test("every slide's own photograph refused: every slide still stands on a photograph, the account's scenes", { timeout: 240_000 }, async () => {
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, dir, pack } = account(home);
    const file = await photoFile(home);
    // Every photograph of a slide refused (a logo in it, or someone else's face); only the scenes pass.
    const asked = library(file, (q) => (SCENE.test(q) ? 'ok' : q === 'Dana Example' ? 'someone else' : 'logo'));
    // Dana is named on no slide here: slide 2 is about a plant like the others.
    setDraft(dir, 'drought-ranking', (d) => (d.slides.slides[1].imageQuery = 'aloe vera pot'));
    const res = await buildPost(ctx, { pack });
    assert.equal(res.status, 'queued', res.reason);
    const post = loadPost(ctx.db, res.postId);
    assert.ok(asked.some((q) => SCENE.test(q)), `the scenes were searched: ${asked.join(', ')}`);
    assert.ok(post.checks.bgImage, 'a scene was found');
    for (const s of steps(ctx.db, res.postId, 'image').filter((x) => typeof x.slide === 'number')) assert.equal(s.status, 'skipped', `slide ${s.slide}'s own photograph was refused`);
    const [photos] = steps(ctx.db, res.postId, 'photos');
    assert.equal(photos?.status, 'ok', 'the post says what every slide stands on');
    for (const [size, list] of Object.entries(photos.grounds)) {
      assert.equal(list.length, post.slides.length, size);
      list.forEach((on, i) => assert.ok(on.length && on.every((k) => /^bg/.test(k)), `${size} slide ${i + 1} stands on a scene: ${JSON.stringify(on)}`));
    }
    assert.ok(!JSON.parse(readFileSync(path.join(dir, 'theme.json'), 'utf8')).backgroundQueries, "the scenes came without a change to theme.json");
  } finally {
    cleanup();
  }
});

test('nothing found at all, not even a scene: the post is refused, not queued, and no sample is kept', { timeout: 240_000 }, async () => {
  // A post and a sample, each from a fresh account (a document a post was drafted from is not drafted from again).
  for (const sample of [false, true]) {
    const { home, cleanup } = tempHome({ packs: {} });
    try {
      const { ctx, pack } = account(home);
      // The libraries answer nothing (Openverse's 504s, Commons' refusals), the scenes included.
      const asked = library(await photoFile(home), () => 'none');
      const res = await buildPost(ctx, { pack, sample });
      assert.equal(res.status, 'blocked', `${sample ? 'a sample' : 'a post'} with no photograph is refused`);
      assert.equal(res.kind, 'no_photo');
      assert.match(res.reason, /תמונה/);
      assert.ok(asked.some((q) => SCENE.test(q)), 'the scenes were searched too');
      const post = loadPost(ctx.db, res.postId);
      assert.equal(post.status, 'blocked');
      assert.equal(steps(ctx.db, res.postId, 'queue').length, 0, 'never queued');
      assert.equal(post.slides.length, 0, 'no slides stored');
      assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE status IN ('queued', 'sample')").n, 0);
    } finally {
      cleanup();
    }
  }
});

test('a slide that names someone whose photograph is refused: the post is refused, though the scenes were found', { timeout: 240_000 }, async () => {
  for (const dana of ['someone else', 'ok']) {
    const { home, cleanup } = tempHome({ packs: {} });
    try {
      const { ctx, pack } = account(home);
      // Every plant and every scene passes; the one photograph found for Dana is of someone else, or (the positive
      // control) of her.
      const asked = library(await photoFile(home), (q) => (q === 'Dana Example' ? dana : 'ok'));
      const res = await buildPost(ctx, { pack, sample: true });
      assert.equal(res.status, dana === 'ok' ? 'sample' : 'blocked', dana === 'ok' ? res.reason : 'a scene is not enough under a name');
      assert.ok(asked.includes('Dana Example'));
      assert.ok(asked.some((q) => SCENE.test(q)), 'the scenes were there');
      const [photos] = steps(ctx.db, res.postId, 'photos');
      if (dana === 'ok') {
        assert.deepEqual(photos.grounds.tiktok[2], [2], 'slide 3 stands on her own photograph');
        assert.ok(photos.grounds.tiktok.every((on) => on.length), 'and every slide on one');
        continue;
      }
      assert.equal(res.kind, 'no_photo');
      assert.match(res.reason, /Dana Example/);
      assert.match(res.reason, /לשקף 3/);
      assert.equal(photos?.status, 'failed');
      assert.deepEqual(photos.gaps.map((g) => [g.slide, g.why]), [[2, 'name']]);
      assert.ok(!existsSync(path.join(home, 'media', 'posts', res.postId)), "a refused post's slides are not kept");
    } finally {
      cleanup();
    }
  }
});
