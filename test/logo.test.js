import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll, readPack } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { getBytes } from '../src/core/net.js';
import { fetchLogo, LOGO_MAX_BYTES, logoProblem, removeLogo, saveLogo } from '../src/packs/logo.js';
import { webpSize } from '../src/images/size.js';
import { fetchingLogos, readSitePromo, reading } from '../src/onboarding/promo.js';
import { setupOf } from '../src/onboarding/setup.js';
import { __onboarding } from '../src/web/onboarding.js';
import { LOGO_HE } from '../src/web/logo.js';
import { closingSlide } from '../src/pipeline/closing.js';
import { closeBrowser, getBrowser, renderPost } from '../src/render/render.js';
import { themeOf } from '../src/render/styles/index.js';
import { tokenOf } from '../src/verify/claims.js';
import { copyPack, customer, fakeAccounts, listenFree, operator, opened, tempHome, viewingAs } from './helpers.js';

// The customer's logo on the closing slide (the owner approved it on 2026-11-03): kept from the store's site when the
// account is made, and put there, replaced or removed on Settings (src/packs/logo.js, src/onboarding/promo.js
// startLogoFetch, src/web/logo.js). PNG, JPEG or WebP by the file's own bytes, never an SVG, 2 MB and 32 to 5000 pixels
// a side. The store is a fake on .example and every picture is drawn here; nothing goes to the network.

const out = mkdtempSync(path.join(os.tmpdir(), 'of-logo-'));

/** Pictures drawn in the browser: logos (dark, light), the same in each kind, a tiny one, and a photograph stand-in. */
async function draw() {
  const tab = await (await getBrowser()).newPage();
  try {
    const got = await tab.evaluate(() => {
      const logo = (ink, w = 480, h = 160) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = ink;
        g.beginPath();
        g.arc(h / 2, h / 2, h * 0.4, 0, Math.PI * 2);
        g.fill();
        g.fillRect(h * 1.06, h * 0.25, w - h * 1.3, h * 0.2);
        g.fillRect(h * 1.06, h * 0.57, (w - h * 1.3) * 0.7, h * 0.18);
        return c;
      };
      const photo = document.createElement('canvas');
      photo.width = 1200;
      photo.height = 1600;
      const p = photo.getContext('2d');
      p.fillStyle = '#5B7F4A';
      p.fillRect(0, 0, 1200, 1600);
      p.fillStyle = '#C9B48A';
      p.fillRect(0, 1000, 1200, 600);
      const b64 = (c, type) => c.toDataURL(type, 0.92).split(',')[1];
      return { png: b64(logo('#1F5A2E'), 'image/png'), jpg: b64(logo('#1F5A2E'), 'image/jpeg'), webp: b64(logo('#1F5A2E'), 'image/webp'), light: b64(logo('#FFFFFF'), 'image/png'), tiny: b64(logo('#1F5A2E', 20, 20), 'image/png'), photo: b64(photo, 'image/jpeg') };
    });
    return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  } finally {
    await tab.close();
  }
}

let pics;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><script>alert(1)</script><rect width="200" height="80"/></svg>');

before(async () => {
  pics = await draw();
});

after(async () => {
  await closeBrowser();
  rmSync(out, { recursive: true, force: true, maxRetries: 3 });
});

test('a logo is a PNG, a JPEG or a WebP by its own bytes, 2 MB at most and 32 to 5000 pixels a side; never an SVG, whatever it is called', () => {
  for (const k of ['png', 'jpg', 'webp', 'light']) assert.equal(logoProblem(pics[k]), null, k);
  assert.equal(logoProblem(SVG), 'type', 'an SVG');
  assert.equal(logoProblem(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')), 'type', 'a GIF');
  assert.equal(logoProblem(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), SVG])), 'type', "a PNG's first bytes and nothing a PNG has after them");
  assert.equal(logoProblem(Buffer.alloc(0)), 'empty');
  assert.equal(logoProblem(Buffer.concat([pics.png, Buffer.alloc(LOGO_MAX_BYTES)])), 'large', 'over 2 MB');
  assert.equal(LOGO_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(logoProblem(pics.tiny), 'small', '20 pixels a side');
  const wide = Buffer.from(pics.png);
  wide.writeUInt32BE(6000, 16);
  assert.equal(logoProblem(wide), 'sides', '6000 pixels wide');
  // A WebP's size in each of its three kinds of first chunk.
  assert.deepEqual(webpSize(pics.webp), { type: 'webp', width: 480, height: 160 });
  const riff = (chunk, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), body, Buffer.alloc(16)]);
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(299 | (99 << 14), 1);
  assert.deepEqual(webpSize(riff('VP8L', lossless)), { type: 'webp', width: 300, height: 100 });
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(639, 4, 3);
  extended.writeUIntLE(199, 7, 3);
  assert.deepEqual(webpSize(riff('VP8X', extended)), { type: 'webp', width: 640, height: 200 });
});

test("a logo is written whole into the pack's brand/ folder, the one before it taken out, and removing it leaves none", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'of-logo-pack-'));
  try {
    copyPack(home, 'demo');
    const dir = path.join(home, 'packs', 'demo');
    mkdirSync(path.join(dir, 'brand'));
    writeFileSync(path.join(dir, 'brand', 'logo.png'), pics.png);
    writeFileSync(path.join(dir, 'brand', 'logo.svg'), SVG);
    const pack = readPack(dir);
    assert.equal(path.basename(pack.brandLogo), 'logo.png');
    // A WebP after a PNG: the PNG is read first, so it must go, and the SVG with it.
    const file = saveLogo(pack, pics.webp);
    assert.deepEqual(readdirSync(path.join(dir, 'brand')), ['logo.webp'], 'one logo, no temporary file left');
    assert.equal(pack.brandLogo, file);
    assert.equal(path.basename(readPack(dir).brandLogo), 'logo.webp');
    assert.ok(readFileSync(file).equals(pics.webp));
    // An SVG is refused, and nothing is written.
    assert.throws(() => saveLogo(pack, SVG), (e) => e.code === 'type');
    assert.deepEqual(readdirSync(path.join(dir, 'brand')), ['logo.webp']);
    assert.equal(removeLogo(pack), true);
    assert.deepEqual(readdirSync(path.join(dir, 'brand')), []);
    assert.equal(pack.brandLogo, null);
    assert.equal(readPack(dir).brandLogo, null);
    assert.equal(removeLogo(pack), false, 'nothing left to remove');
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* --------------------------------------------------------------- from the store's site */

const SHOP = 'https://shatil-vaale.example';
const LOGO_URL = `${SHOP}/cdn/shop/files/logo-shatil.png?v=17`;
const HOME = ({ platform = 'shopify', logo = true } = {}) =>
  `<html><head><title>שתיל ועלה | צמחי בית</title><meta name="description" content="צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח."><meta property="og:site_name" content="שתיל ועלה">${platform === 'shopify' ? '<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/theme.css">' : ''}</head><body><header>${logo ? `<img src="//shatil-vaale.example/cdn/shop/files/logo-shatil.png?v=17&amp;width=300" alt="שתיל ועלה" class="header__heading-logo" width="300" height="100">` : ''}</header><h1>שתיל ועלה</h1></body></html>`;

/** The store as readStore and the logo's fetch read it, every request kept; `picture` is what its logo's address serves. */
function fakeStore({ platform = 'shopify', logo = true, down = false, picture = () => ({ buf: pics.png, type: 'image/png' }) } = {}) {
  const asked = [];
  const nope = (u) => Promise.reject(Object.assign(new Error(`HTTP 404: ${u}`), { status: 404 }));
  const json = {
    [`${SHOP}/products.json?limit=100`]: { products: [{ id: 1, title: 'מונסטרה בעציץ קרמיקה', handle: 'monstera', product_type: 'צמחים', images: [{ src: `${SHOP}/cdn/shop/files/monstera.jpg` }], variants: [{ price: '89.00', available: true }] }] },
    [`${SHOP}/meta.json`]: { name: 'שתיל ועלה', currency: 'ILS' },
    [`${SHOP}/collections.json?limit=50`]: { collections: [{ title: 'צמחי בית' }] },
  };
  return {
    asked,
    get: async (u) => (asked.push(u), down || platform !== 'shopify' || !json[u] ? nope(u) : structuredClone(json[u])),
    getPage: async (u) => (asked.push(u), down || u !== SHOP ? nope(u) : { body: HOME({ platform, logo }), finalUrl: u }),
    fetchImage: async (u, opts) => (asked.push({ u, opts }), picture(u, opts)),
  };
}

test("the site read keeps the address of the store's logo, on a store and on a site that is none, and a dead site gives none", async () => {
  const shop = await readSitePromo('shatil-vaale.example', fakeStore());
  assert.equal(shop.read, true);
  assert.equal(shop.logo, LOGO_URL, "the store's own logo, found as a demo finds it (src/demos/store.js logoOf)");
  const plain = await readSitePromo('shatil-vaale.example', fakeStore({ platform: 'none' }));
  assert.equal(plain.draft.name, 'שתיל ועלה', 'a site on no store platform is read by its homepage');
  assert.equal(plain.logo, LOGO_URL, 'and its logo with it');
  assert.equal('logo' in (await readSitePromo('shatil-vaale.example', fakeStore({ logo: false }))), false, 'a homepage with no logo: none');
  assert.deepEqual(await readSitePromo('shatil-vaale.example', fakeStore({ down: true })), { draft: { name: '', promise: '', target: { kind: 'site', url: `${SHOP}/` } }, read: false });
});

test('the logo is fetched through the one door, asked for in the kinds a slide takes and read no further than 2 MB; an SVG, a private address and a picture that keeps coming are refused', async () => {
  const store = fakeStore();
  const got = await fetchLogo(LOGO_URL, store);
  assert.deepEqual([got.ext, got.buf.equals(pics.png)], ['png', true]);
  const [{ u, opts }] = store.asked;
  assert.equal(u, `${LOGO_URL}&width=640`, "twice the slide's tile, on a CDN that draws it to size");
  assert.equal(opts.maxBytes, LOGO_MAX_BYTES);
  assert.match(opts.headers.accept, /^image\/png,image\/webp,image\/jpeg/);
  // A site that serves an SVG (as image/svg+xml or as anything else) has no logo of ours.
  await assert.rejects(fetchLogo(LOGO_URL, fakeStore({ picture: () => ({ buf: SVG, type: 'image/png' }) })), (e) => e.code === 'type');
  // The door itself (src/core/net.js): https only, the public internet only.
  await assert.rejects(fetchLogo('https://127.0.0.1/logo.png'), (e) => e.code === 'private_address');
  await assert.rejects(fetchLogo('https://[::ffff:169.254.169.254]/logo.png'), (e) => e.code === 'private_address');
  await assert.rejects(fetchLogo('http://shatil-vaale.example/logo.png'), (e) => e.code === 'refused');
  // getBytes stops at its cap: a picture that says it is larger is never read, one that keeps coming is cut off.
  const realFetch = globalThis.fetch;
  let pulled = 0;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(64 * 1024))) }), { headers: { 'content-type': 'image/png' } });
    await assert.rejects(getBytes('https://shatil-vaale.example/logo.png', { maxBytes: LOGO_MAX_BYTES }), (e) => e.code === 'too_large');
    assert.ok(pulled < 40, `read ${pulled} pieces of 64 KB, not the whole stream`);
    pulled = 0;
    globalThis.fetch = async () => new Response(new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(1024))) }), { headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) } });
    await assert.rejects(getBytes('https://shatil-vaale.example/logo.png', { maxBytes: LOGO_MAX_BYTES }), (e) => e.code === 'too_large');
    assert.ok(pulled <= 1, 'said to be 50 MB: not read');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* --------------------------------------------------------------- /new and Settings, through the server */

let home;
let ctx;
let db;
let fake;
let server;
let base;
const logs = [];

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: (m) => logs.push(m) });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  // The sources are searched without reading any site: the catalogue's are enough to make an account.
  ctx.discoverOpts = { readSite: async () => [] };
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'l'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie, from = '/settings') => /name="_csrf" value="([^"]+)"/.exec(await (await get(from, cookie)).text())[1];
const post = async (p, cookie, body = {}, { from = '/new', ajax = false } = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: await csrfOf(cookie, from), ...body }).toString() });
/** The logo form as a browser sends it: multipart, its CSRF token, and each file given as [bytes, name, type]. */
async function upload(cookie, id, files, { ajax = true, csrf, headers = {} } = {}) {
  const fd = new FormData();
  fd.append('_csrf', csrf ?? (await csrfOf(cookie)));
  for (const [buf, name, type] of files) fd.append('logo', new Blob([buf], { type }), name);
  return fetch(`${base}/accounts/${id}/logo`, { method: 'POST', redirect: 'manual', headers: { cookie, ...(ajax ? { 'x-of-ajax': '1' } : {}), ...headers }, body: fd });
}
const settle = async () => {
  await Promise.all([...reading.values()]);
  await Promise.all([...__onboarding.running.values()]);
};

/** A new account through /new with its store's site, made with what the site read filled in. Returns its pack id. */
async function newAccount(cookie, { handle, name }) {
  const r = await post('/new', cookie, { niche: 'צמחי בית', audience: 'מי שגר בדירה', site: 'shatil-vaale.example' });
  const id = r.headers.get('location').split('/').pop();
  await settle();
  const cand = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const made = await post(`/new/${id}/create`, cookie, { [`approve_${cand}`]: 'on', displayName: name, handle }, { from: `/new/${id}`, ajax: true });
  assert.deepEqual([made.status, (await made.json()).message], [200, 'החשבון נוצר.']);
  return { onboarding: id, packId: db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id };
}

const SLIDES = [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }, ...['מונסטרה', 'פוטוס', 'סנסיווריה'].map((title, i) => ({ kind: 'item', role: i === 2 ? 'payoff' : 'beat', title, body: 'שורה אחת על השקף.', factKeys: [], sources: ['מקור'], imageQuery: 'house plant' }))];

/** The closing slide of a post of this account, in style A on TikTok: what the renderer measured, and the slide. */
async function closingOf(pack) {
  const look = { ...pack, meta: { ...pack.meta, style: { ...(pack.meta.style || {}), name: 'A' } } };
  const styled = { ...look, theme: themeOf(look) };
  const { closing } = closingSlide(styled, { line: '' });
  assert.ok(closing.line, 'a line of the promo\'s own words');
  const extra = { captionIg: '', keywords: [], subject: {}, cta: '', closing };
  const p = { id: `logo-${pack.id}`, hook: 'חדר בלי שמש?', sub: '', caption: 'c', extra, ctaKind: 'save' };
  p.token = tokenOf({ slides: SLIDES, caption: p.caption, hook: p.hook, sub: p.sub, extra });
  const photo = path.join(out, 'photo.jpg');
  writeFileSync(photo, pics.photo);
  const ph = { id: 1, file: photo };
  const drawn = await renderPost({ pack: styled, format: { id: 't', kind: 'story', name: 'x', hooks: ['x'] }, post: p, slides: SLIDES, photos: new Map([[0, ph], [1, ph], [2, ph], ['bg', { ...ph, id: 2, query: 'house plants' }]]), outDir: path.join(out, pack.id), only: new Set([SLIDES.length]), platforms: ['tiktok'] });
  return { measured: drawn.closing.tiktok.closing, file: drawn.tiktok[0] };
}

test("/new keeps the store's logo; the account is made without waiting for it, the picture lands in its brand/ folder, and its closing slide draws it", { timeout: 300_000 }, async () => {
  let open;
  const gate = new Promise((r) => (open = r));
  ctx.siteOpts = fakeStore({ picture: async () => (await gate, { buf: pics.png, type: 'image/png' }) });
  try {
    const { cookie } = fake.session(customer(3));
    const { onboarding, packId } = await newAccount(cookie, { handle: 'shatil.vaale', name: 'שתיל ועלה' });
    assert.equal(setupOf(db, onboarding).siteLogo, LOGO_URL, 'the address is kept on the onboarding');
    // Made while the picture is still on its way: the account never waits for it.
    assert.ok(fetchingLogos.has(packId), 'the fetch runs in the background');
    assert.equal(ctx.pack(packId).brandLogo, null, 'no logo yet');
    open();
    const file = await fetchingLogos.get(packId);
    assert.equal(file, path.join(home.home, 'packs', packId, 'brand', 'logo.png'));
    assert.ok(readFileSync(file).equals(pics.png), "the store's own picture");
    assert.equal(ctx.pack(packId).brandLogo, file, 'the engine has it');
    assert.equal(readPack(path.join(home.home, 'packs', packId)).brandLogo, file, 'and so does the next read of the packs');
    // The closing slide picks it up, with nothing else changed: drawn, inside the bands, on a white tile.
    const { measured, file: slide } = await closingOf(ctx.pack(packId));
    assert.ok(measured.logo && measured.logo.width > 60 && measured.logo.height > 30, `the logo is drawn (${JSON.stringify(measured.logo)})`);
    assert.equal(measured.tile, 'light', 'a dark logo on a white tile');
    assert.ok(existsSync(slide));
    // Settings shows the customer the logo that came from their site.
    const page = await (await get('/settings', cookie)).text();
    assert.match(page, new RegExp(`<img src="/accounts/${packId}/logo\\?v=[0-9a-z]+" alt="הלוגו של שתיל ועלה">`));
    const served = await get(`/accounts/${packId}/logo`, cookie);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(pics.png));
  } finally {
    delete ctx.siteOpts;
  }
});

test('a logo that does not come, or will not do, is a line in the log and an account without one', { timeout: 120_000 }, async () => {
  for (const [ws, handle, picture, why] of [
    [4, 'shatil.svg', () => ({ buf: SVG, type: 'image/svg+xml' }), /not a logo \(type\)/],
    [5, 'shatil.down', () => Promise.reject(new Error('HTTP 503: the store is down')), /HTTP 503/],
  ]) {
    ctx.siteOpts = fakeStore({ picture });
    try {
      logs.length = 0;
      const { packId } = await newAccount(fake.session(customer(ws)).cookie, { handle, name: `שתיל ועלה ${ws}` });
      // A quick refusal may be over before the answer: then there is nothing left to wait for.
      await fetchingLogos.get(packId);
      assert.equal(ctx.pack(packId).brandLogo, null, 'made, with no logo');
      assert.equal(existsSync(path.join(home.home, 'packs', packId, 'brand')), false, 'nothing written');
      const line = logs.find((m) => m.includes(packId) && m.includes("the store's logo"));
      assert.match(line || '', why, `the operator's line: ${line}`);
      assert.ok(line.includes(LOGO_URL), 'it names the address');
    } finally {
      delete ctx.siteOpts;
    }
  }
});

test("Settings: the account's owner adds the logo, replaces it with one file and removes it; nobody else changes it, and nothing that is no logo is kept", { timeout: 120_000 }, async () => {
  const brand = path.join(home.home, 'packs', 'demo', 'brand');
  const files = () => (existsSync(brand) ? readdirSync(brand).sort() : []);
  const { cookie } = fake.session(customer(1));
  const page = await (await get('/settings', cookie)).text();
  assert.match(page, /<section class="panel" id="logo-demo"><header><h2>הלוגו<\/h2><\/header>/);
  assert.ok(page.indexOf('id="promo-demo"') < page.indexOf('id="logo-demo"') && page.indexOf('id="logo-demo"') < page.indexOf('id="push"'), 'beside the closing slide, before the notifications');
  assert.match(page, /עוד אין לוגו, אז השקף האחרון יוצא בלעדיו/);
  assert.match(page, /<form method="post" action="\/accounts\/demo\/logo" enctype="multipart\/form-data" class="logo-up" data-upload="2097152"[^>]*><input type="hidden" name="_csrf"/);
  assert.match(page, /<input class="logo-file" id="logo-file-demo" type="file" name="logo" accept="image\/png,image\/jpeg,image\/webp">/);
  assert.match(page, /להעלות לוגו/);
  assert.doesNotMatch(page, /logo\/remove/, 'nothing to remove yet');
  assert.equal((await get('/accounts/demo/logo', cookie)).status, 404);

  // Added, as the page sends it without its script: a redirect back to the panel, with the line said.
  const added = await upload(cookie, 'demo', [[pics.png, 'logo.png', 'image/png']], { ajax: false });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get('location'), '/settings#logo-demo');
  assert.match(decodeURIComponent(added.headers.get('set-cookie')), new RegExp(LOGO_HE.saved));
  assert.deepEqual(files(), ['logo.png']);
  assert.ok(readFileSync(path.join(brand, 'logo.png')).equals(pics.png));
  const shown = await (await get('/settings', cookie)).text();
  assert.match(shown, /זה הלוגו שמופיע בשקף האחרון של כל מצגת/);
  assert.match(shown, /להחליף את הלוגו/);
  assert.match(shown, /action="\/accounts\/demo\/logo\/remove"[^]*?data-confirm="לחצו שוב כדי להסיר">להסיר</);
  const served = await get('/accounts/demo/logo', cookie);
  assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'image/png']);
  assert.match(served.headers.get('content-security-policy'), /sandbox/);

  // Replaced: a WebP, and the PNG before it is gone.
  const webp = await upload(cookie, 'demo', [[pics.webp, 'new-logo.webp', 'image/webp']]);
  assert.deepEqual([webp.status, (await webp.json()).message], [200, LOGO_HE.saved]);
  assert.deepEqual(files(), ['logo.webp']);
  assert.equal((await get('/accounts/demo/logo', cookie)).headers.get('content-type'), 'image/webp');

  // Nothing that is no logo is kept, and the logo stays as it was.
  const refused = async (sent, message, status = 422) => {
    const r = await upload(cookie, 'demo', sent);
    assert.deepEqual([r.status, (await r.json()).message], [status, message], message);
    assert.deepEqual(files(), ['logo.webp']);
  };
  await refused([[SVG, 'logo.svg', 'image/svg+xml']], LOGO_HE.type);
  await refused([[SVG, 'logo.png', 'image/png']], LOGO_HE.type);
  await refused([[pics.png, 'a.png', 'image/png'], [pics.jpg, 'b.jpg', 'image/jpeg']], LOGO_HE.many);
  await refused([], LOGO_HE.empty);
  await refused([[Buffer.alloc(0), '', 'application/octet-stream']], LOGO_HE.empty);
  await refused([[pics.tiny, 'tiny.png', 'image/png']], LOGO_HE.small);
  await refused([[Buffer.concat([pics.png, Buffer.alloc(LOGO_MAX_BYTES - pics.png.length + 1)]), 'big.png', 'image/png']], LOGO_HE.large, 413);
  // A body far over the cap is not read: the page it came from says why.
  const huge = await upload(cookie, 'demo', [[Buffer.alloc(3 * 1024 * 1024), 'huge.png', 'image/png']], { ajax: false });
  assert.equal(huge.status, 303);
  assert.match(decodeURIComponent(huge.headers.get('set-cookie')), new RegExp(LOGO_HE.large));
  assert.deepEqual(files(), ['logo.webp']);

  // Nobody else: no CSRF token, another site, another workspace, the operator's read-only view.
  assert.equal((await upload(cookie, 'demo', [[pics.png, 'logo.png', 'image/png']], { csrf: 'nope' })).status, 403);
  assert.equal((await upload(cookie, 'demo', [[pics.png, 'logo.png', 'image/png']], { headers: { origin: 'https://evil.example' } })).status, 403);
  const other = fake.session(customer(2)).cookie;
  assert.equal((await upload(other, 'demo', [[pics.png, 'logo.png', 'image/png']])).status, 404);
  assert.equal((await post('/accounts/demo/logo/remove', other, {}, { from: '/settings', ajax: true })).status, 404);
  assert.equal((await get('/accounts/demo/logo', other)).status, 404, "another workspace's logo is not there to see");
  const view = fake.session(viewingAs(1)).cookie;
  assert.equal((await upload(view, 'demo', [[pics.png, 'logo.png', 'image/png']])).status, 403);
  assert.deepEqual(files(), ['logo.webp']);

  // The operator may, as on every other Settings field.
  const op = fake.session(operator()).cookie;
  assert.equal((await upload(op, 'demo', [[pics.jpg, 'logo.jpg', 'image/jpeg']])).status, 200);
  assert.deepEqual(files(), ['logo.jpg']);

  // Removed: no logo, and the closing slide closes up where it was.
  const removed = await post('/accounts/demo/logo/remove', cookie, {}, { from: '/settings', ajax: true });
  assert.deepEqual([removed.status, (await removed.json()).message], [200, LOGO_HE.removed]);
  assert.deepEqual(files(), []);
  assert.equal(ctx.pack('demo').brandLogo, null);
  assert.equal((await get('/accounts/demo/logo', cookie)).status, 404);
  assert.match(await (await get('/settings', cookie)).text(), /עוד אין לוגו/);
  assert.deepEqual(db.all("SELECT action FROM audit WHERE account_id = 'demo' AND action LIKE 'logo%' ORDER BY id").map((a) => a.action), ['logo', 'logo', 'logo', 'logo_removed']);
});

test("in a browser, Settings' logo panel on a phone and a desk: the logo on its tile, a light one on a dark tile, the buttons apart, nothing sideways", { timeout: 120_000 }, async () => {
  const { cookie, sid } = fake.session(customer(1));
  const browser = await chromium.launch();
  try {
    for (const [logo, dark] of [[pics.png, false], [pics.light, true]]) {
      await upload(cookie, 'demo', [[logo, 'logo.png', 'image/png']]);
      for (const width of [390, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
        const page = await context.newPage();
        await page.goto(`${base}/settings#logo-demo`);
        await page.waitForFunction(() => document.documentElement.classList.contains('js') && document.querySelector('[data-logo-tile] img')?.complete);
        await page.waitForTimeout(100);
        const got = await page.evaluate(() => {
          const panel = document.getElementById('logo-demo').getBoundingClientRect();
          const tile = document.querySelector('#logo-demo .logo-tile');
          const btns = [...document.querySelectorAll('#logo-demo .logo-acts .btn')].map((b) => b.getBoundingClientRect());
          const stage = document.querySelector('#logo-demo .logo-stage').getBoundingClientRect();
          return { panel: panel.toJSON(), stage: stage.toJSON(), btns: btns.map((b) => b.toJSON()), dark: tile.classList.contains('dark'), sideways: document.documentElement.scrollWidth > window.innerWidth, file: getComputedStyle(document.querySelector('#logo-demo .logo-file')).clipPath };
        });
        assert.equal(got.dark, dark, `${width}: ${dark ? 'a light logo on a dark tile' : 'a dark logo on a white tile'}`);
        assert.equal(got.btns.length, 2, `${width}: the two buttons, the file field hidden behind the first (${got.file})`);
        const [a, b] = got.btns;
        const apart = a.top === b.top ? Math.abs((a.left < b.left ? b.left - a.right : a.left - b.right)) : b.top - a.bottom;
        assert.ok(apart >= 8, `${width}: the buttons are ${apart}px apart`);
        assert.ok(a.top - got.stage.bottom >= 12, `${width}: ${a.top - got.stage.bottom}px between the logo and the buttons`);
        for (const r of [got.stage, a, b]) assert.ok(r.left >= got.panel.left && r.right <= got.panel.right, `${width}: inside the panel`);
        assert.equal(got.sideways, false, `${width}: no sideways scroll`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    removeLogo(ctx.pack('demo'));
  }
});
