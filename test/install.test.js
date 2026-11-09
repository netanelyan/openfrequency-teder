import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { installCard, installOf, installPanel, installPlatform } from '../src/web/install.js';
import { customer, fakeAccounts, listenFree, opened, operator, tempHome } from './helpers.js';

// Adding Teder to the phone as an app (src/web/install.js; the owner, 2026-11-09: "both toran and teder, add a little
// tutorial on how to add the website as an app to the phone"): the manifest Chrome installs from, home's card on a
// phone until it is closed, never on a desk, and Settings' panel with this browser's steps.

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  desk: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

/** The steps a page shows: the one [data-for] block without hidden. */
const shown = (html) => [...html.matchAll(/<div data-for="([\w-]+)"( hidden)?>/g)].filter((m) => !m[2]).map((m) => m[1]);

let home;
let fake;
let server;
let base;
let sid;
let op;

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  sid = fake.session(customer(1)).sid;
  op = fake.session(operator()).sid;
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'i'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, { ua = UA.desk, cookie = '', session = sid } = {}) => fetch(`${base}${p}`, { headers: { 'user-agent': ua, cookie: `of_session=${session}${cookie}` }, redirect: 'manual' });
const page = async (p, opts) => (await get(p, opts)).text();

test('the browser by its user agent: Safari, Chrome and the rest on an iPhone, Chrome and the rest on Android, a desk', () => {
  assert.equal(installPlatform(UA.iphone), 'ios-safari');
  assert.equal(installPlatform(UA.iphoneChrome), 'ios-chrome');
  assert.equal(installPlatform(UA.iphoneInstagram), 'ios-other');
  assert.equal(installPlatform(UA.android), 'android-chrome');
  assert.equal(installPlatform(UA.samsung), 'android-other');
  assert.equal(installPlatform(UA.desk), 'desktop');
  assert.equal(installPlatform(undefined), 'desktop');
  assert.deepEqual(installOf(UA.iphone, { of_install: 'hide' }), { platform: 'ios-safari', closed: true });
  assert.equal(installCard(installOf(UA.desk, {})), '', 'no card on a desk');
  assert.equal(installCard(null), '');
  assert.equal(installPanel(null), '');
});

test('the manifest: Hebrew, right to left, standalone from the home page, icons of 192 and 512 and maskable ones, each served', async () => {
  const r = await fetch(`${base}/static/manifest.webmanifest`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('content-type')), /application\/manifest\+json/);
  const m = await r.json();
  assert.deepEqual([m.name, m.short_name, m.lang, m.dir, m.start_url, m.display], ['תדר', 'תדר', 'he', 'rtl', '/', 'standalone']);
  assert.equal(m.prefer_related_applications, undefined);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const has = (size, purpose) => m.icons.find((i) => i.sizes === size && i.type === 'image/png' && String(i.purpose || 'any').split(' ').includes(purpose));
  for (const size of ['192x192', '512x512']) for (const purpose of ['any', 'maskable']) assert.ok(has(size, purpose), `${size} ${purpose}`);
  for (const i of m.icons) {
    const got = await fetch(`${base}${i.src}`);
    assert.equal(got.status, 200, i.src);
    assert.equal(got.headers.get('content-type'), i.type, i.src);
    const png = Buffer.from(await got.arrayBuffer());
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, i.sizes, `${i.src}: the size it says`);
  }
  const html = await page('/', { ua: UA.iphone });
  assert.match(html, /<link rel="manifest" href="\/static\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/static\/icon-180\.png\?v=/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="תדר">/);
});

test('home\'s card: on a phone with that browser\'s steps, never on a desk, gone once closed or opened as the app', async () => {
  const iphone = await page('/', { ua: UA.iphone });
  assert.match(iphone, /data-install="card"/);
  assert.match(iphone, /להוסיף את תדר למסך הבית/);
  assert.deepEqual(shown(iphone), ['ios-safari']);
  assert.match(iphone, /<b>שיתוף<\/b>[^]*<b>הוספה למסך הבית<\/b>[^]*<b>הוסף<\/b>/);
  assert.match(iphone, /data-install-close aria-label="לסגור"/);
  assert.ok(!/ style="/.test(iphone.split('<main')[1] || ''), 'no inline style in the page');
  assert.deepEqual(shown(await page('/', { ua: UA.iphoneChrome })), ['ios-chrome']);
  assert.deepEqual(shown(await page('/', { ua: UA.iphoneInstagram })), ['ios-other']);
  const android = await page('/', { ua: UA.android });
  assert.deepEqual(shown(android), ['android-chrome']);
  assert.match(android, /data-for="prompt" hidden>[^]*data-install-go[^]*להתקין/, 'the one button waits for Chrome\'s offer');
  assert.ok(!/data-install=/.test(await page('/', { ua: UA.desk })), 'nothing on a desk');
  assert.ok(!/data-install=/.test(await page('/', { ua: UA.iphone, cookie: '; of_install=hide' })), 'closed in this browser');
  assert.ok(!/data-install=/.test(await page('/', { ua: UA.android, cookie: '; of_install=app' })), 'the app was opened in this browser');
  assert.match(await page('/', { ua: UA.iphone, session: op }), /data-install="card"/, 'the operator\'s home too');
});

test('Settings: "להוסיף לטלפון" always, folded on a phone, the desk\'s hint on a desk, a phone\'s steps on a phone, closed or not', async () => {
  const desk = await page('/settings');
  assert.match(desk, /<details class="mfold one" data-mfold="install" open><summary>להוסיף לטלפון<\/summary><section class="panel install" id="install" data-install="panel"/);
  assert.deepEqual(shown(desk), ['desktop']);
  assert.match(desk, /סמל ההתקנה בשורת הכתובת/);
  assert.match(desk, /<a href="#install">/, 'the iPhone\'s line under notifications points to it');
  const phone = await page('/settings', { ua: UA.iphone, cookie: '; of_install=hide' });
  assert.deepEqual(shown(phone), ['ios-safari'], 'closing home\'s card does not take it out of Settings');
});

test('the page\'s script keeps the x in a cookie the server reads, and the installed app shows none of it', () => {
  const js = readFileSync(new URL('../src/web/static/app.js', import.meta.url), 'utf8');
  assert.match(js, /of_install=\$\{v\}; Path=\/; Max-Age=31536000/);
  assert.match(js, /keep\('hide'\)/);
  assert.match(js, /navigator\.standalone === true/);
  assert.match(js, /beforeinstallprompt/);
  const css = readFileSync(new URL('../src/web/static/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(display-mode: standalone\)[^{]*\{ \[data-install\], details\.mfold\[data-mfold="install"\] \{ display: none !important; \} \}/);
});
