import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/index.js';
import { findImage } from '../src/images/index.js';

// A search that found no photograph says why, so an account whose posts come out bare can be told (npm run
// images:check): a blocked word in the query, no library ready, or what each candidate was passed over for.

test('a search that finds nothing records why', async () => {
  const db = new Db(':memory:');
  const ctx = { db, mode: 'live', log: () => {} };
  const why = {};
  // A query that is the blocked word alone is refused; one that names someone is searched without it.
  assert.equal(await findImage(ctx, { pack: { id: 'a', meta: { imagery: { providers: ['pexels'] } }, rules: { imageQueryBlock: ['belt'] } }, query: 'belt', why }), null);
  assert.deepEqual(why, { 'the query has a blocked word ("belt")': 1 });
  const logs = [];
  const whyBelt = {};
  const keyed = process.env.PEXELS_API_KEY;
  delete process.env.PEXELS_API_KEY;
  try {
    await findImage({ ...ctx, log: (m) => logs.push(m) }, { pack: { id: 'a', meta: { imagery: { providers: ['pexels'] } }, rules: { imageQueryBlock: ['belt'] } }, query: 'Islam Makhachev belts', why: whyBelt });
  } finally {
    if (keyed !== undefined) process.env.PEXELS_API_KEY = keyed;
  }
  assert.deepEqual(logs, ['image query without "belt": Islam Makhachev'], 'searched for the fighter, never for his belt');
  assert.deepEqual(whyBelt, { 'no photo library is ready (its key is missing)': 1 });
  const why2 = {};
  const keyless = { ...process.env };
  delete process.env.PEXELS_API_KEY;
  try {
    assert.equal(await findImage(ctx, { pack: { id: 'a', meta: { imagery: { providers: ['pexels'] } }, rules: {} }, query: 'Islam Makhachev', why: why2 }), null);
  } finally {
    process.env.PEXELS_API_KEY = keyless.PEXELS_API_KEY ?? '';
    if (keyless.PEXELS_API_KEY === undefined) delete process.env.PEXELS_API_KEY;
  }
  assert.deepEqual(why2, { 'no photo library is ready (its key is missing)': 1 });
});

test("a photograph's size floor depends on where it goes, so today's fighters, kept small on Commons, are not thrown out", async () => {
  const { commonsUsable, MIN_SIDE } = await import('../src/images/index.js');
  const c = (mime, w, h, title = 'File:Kamaru Usman.jpg', alt = 'Kamaru Usman at UFC 274') => ({ url: 'https://upload.wikimedia.org/x', mime, original: [w, h], license: 'CC BY-SA 4.0', author: 'someone', providerId: title, alt });
  assert.equal(commonsUsable(c('image/png', 794, 715), MIN_SIDE.cover), true, 'a PNG photograph on a cover');
  assert.equal(commonsUsable(c('image/jpeg', 622, 893), MIN_SIDE.cover), true, 'Merab Dvalishvili at UFC 316, cropped');
  assert.equal(commonsUsable(c('image/jpeg', 387, 436), MIN_SIDE.cover), false, 'too small to fill a cover');
  assert.equal(commonsUsable(c('image/jpeg', 460, 700), MIN_SIDE.framed), true, 'big enough for a framed slide');
  assert.equal(commonsUsable(c('image/png', 1200, 900, 'File:UFC app screenshot.png', 'a screenshot of the app'), MIN_SIDE.cover), false, 'never a screenshot');
  assert.equal(commonsUsable({ ...c('image/jpeg', 1200, 900), license: 'CC BY-NC 2.0' }, MIN_SIDE.cover), false, 'the licence still decides');
});

test('a small cover photograph is framed over its own blurred copy, and a see-through PNG is flattened onto a ground', async () => {
  const { imageSize, fillsCover, FULL_BLEED_MIN } = await import('../src/images/size.js');
  const { flatten } = await import('../src/images/safety.js');
  const { getBrowser, closeBrowser } = await import('../src/render/render.js');
  const { page } = await import('../src/render/html.js');
  try {
    // Real files, made by the render browser's canvas: a see-through PNG and a JPEG.
    const tab = await (await getBrowser()).newPage();
    const [png, jpg] = await tab.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 794;
      c.height = 715;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(200,30,30,0.5)';
      g.fillRect(100, 100, 300, 300);
      return [c.toDataURL('image/png').split(',')[1], c.toDataURL('image/jpeg', 0.9).split(',')[1]];
    });
    await tab.close();
    const p = Buffer.from(png, 'base64');
    const j = Buffer.from(jpg, 'base64');
    assert.deepEqual(imageSize(p), { type: 'png', width: 794, height: 715, alpha: true });
    assert.deepEqual(imageSize(j), { type: 'jpeg', width: 794, height: 715, alpha: false });
    assert.equal(fillsCover(j), false, `under ${FULL_BLEED_MIN} pixels: framed`);
    const flat = await flatten(p, '#0B0B0D');
    assert.deepEqual(imageSize(flat), { type: 'jpeg', width: 794, height: 715, alpha: false });
    const theme = { template: 'card', variant: 'a', colors: { bg: '#0B0B0D', surface: '#16161A', ink: '#FFFFFF', muted: '#A0A0A8', accent: '#E10600', accent2: '#FFFFFF' }, fonts: { display: 'Heebo', text: 'Heebo' }, options: {} };
    const html = page({ theme, size: 'tiktok', slide: { kind: 'cover', hook: 'x' }, parts: { css: '', html: '' }, photo: 'data:image/jpeg;base64,AAAA', framed: true });
    assert.match(html, /<img class="photo fill"[^>]*><div class="cframe"><img/);
    assert.doesNotMatch(page({ theme, size: 'tiktok', slide: { kind: 'cover', hook: 'x' }, parts: { css: '', html: '' }, photo: 'data:image/jpeg;base64,AAAA' }), /cframe"/);
  } finally {
    await closeBrowser();
  }
});
