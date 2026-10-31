import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { backOf } from '../src/web/styles.js';
import { customer, fakeAccounts, opened, tempHome } from './helpers.js';

// Settings is where an account's slideshows are set: their kinds (src/web/formats.js) and their design, A to E, with
// the way to the page that shows the last one in every design (the owner, 2026-10-31: "also choosing the design of the
// slideshow. format A-E", "סוגי המצגות should be in settings", "i did not find the /styles page. make it more
// accessible"). A new account's setup leads there too once it has a sample, and a pick comes back to where it began.
// Settings' panels flow in two columns on a desk ("many blocks go on top of each other on the right side").

let home;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (p, cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get(p, cookie)).text())[1];
const post = async (p, cookie, body, from) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrfOf(from, cookie), ...body }).toString() });

test('Settings carries the kinds of slideshow and the design first, the design with the way to all five', async () => {
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/settings', cookie)).text();
  const formats = html.indexOf('id="formats-demo"');
  const design = html.indexOf('id="design-demo"');
  assert.ok(formats > 0 && design > formats, 'both, the kinds first');
  assert.ok(design < html.indexOf('id="push"'), 'before the notifications');
  assert.match(html, /<h2>עיצוב המצגות<\/h2>/);
  assert.match(html, /href="\/styles\?account=demo&amp;back=%2Fsettings"/);
  assert.match(html, /לראות את כל העיצובים ולבחור/);
});

test('the designs page goes back where it was opened from, and only to Settings or a setup', async () => {
  assert.deepEqual(backOf('/settings'), { href: '/settings', label: 'חזרה להגדרות', active: 'settings' });
  assert.equal(backOf('/new/o-1').href, '/new/o-1');
  for (const bad of ['https://evil.example/', '//evil.example', '/new/../accounts', '/new/x?y=1', '']) assert.equal(backOf(bad), null, bad);
  const { cookie } = fake.session(customer(1));
  const page = await (await get('/styles?account=demo&back=/settings', cookie)).text();
  assert.match(page, /<a class="muted small back" href="\/settings">[^]*?חזרה להגדרות<\/a><h1>עיצוב המצגות<\/h1>/);
  assert.match(page, /<a href="\/settings"[^>]*aria-current="page"/, 'Settings is the page the nav marks');
  const plain = await (await get('/styles?account=demo&back=https://evil.example/', cookie)).text();
  assert.match(plain, /<a class="muted small back" href="\/accounts">/, 'another address is never followed');
  // A pick goes back to Settings; a forged back stays on the designs page.
  const back = await post('/accounts/demo/style-pick', cookie, { style: 'C', back: '/settings' }, '/settings');
  assert.equal(back.headers.get('location'), '/settings');
  const forged = await post('/accounts/demo/style-pick', cookie, { style: 'B', back: 'https://evil.example/' }, '/settings');
  assert.equal(forged.headers.get('location'), '/styles?account=demo');
  assert.match(await (await get('/settings', cookie)).text(), /סגנון B · פוסטר/, 'Settings says the design picked last');
});

test('a new account\'s setup shows the design once it has a sample, and the pick comes back to the setup', async () => {
  db.insert('onboarding', { id: 'o-smp', seed_json: { niche: 'גינון', examples: [] }, status: 'samples', workspace_id: 1, pack_id: 'demo', candidates_json: { candidates: [], formats: [], said: [] }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const { cookie } = fake.session(customer(1));
  const none = await (await get('/new/o-smp', cookie)).text();
  assert.doesNotMatch(none, /id="design-demo"/, 'no sample yet, nothing to show it on');
  const at = new Date().toISOString();
  db.insert('posts', { id: 'p-smp', account_id: 'demo', status: 'sample', sample: 1, hook: 'דוגמה', created_at: at, updated_at: at });
  const html = await (await get('/new/o-smp', cookie)).text();
  assert.match(html, /href="\/styles\?account=demo&amp;back=%2Fnew%2Fo-smp"/);
  assert.ok(html.indexOf('id="samples"') < html.indexOf('id="design-demo"'), 'under the samples');
  const page = await (await get('/styles?account=demo&back=/new/o-smp', cookie)).text();
  assert.match(page, /href="\/new\/o-smp">[^]*?חזרה להגדרת החשבון/);
  const pick = await post('/accounts/demo/style-pick', cookie, { style: 'E', back: '/new/o-smp' }, '/settings');
  assert.equal(pick.headers.get('location'), '/new/o-smp');
});

test('in a browser, Settings\' panels sit in two columns on a desk and in one on a phone, nothing sideways', async () => {
  const { sid } = fake.session(customer(1));
  const browser = await chromium.launch();
  try {
    for (const [width, cols] of [[1440, 2], [390, 1]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/settings`);
      const got = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('.set-cols > .panel')].map((p) => p.getBoundingClientRect());
        const lefts = [...new Set(boxes.map((b) => Math.round(b.left)))];
        // Where each column ends, and the tallest panel: two columns are even when they end within one panel of each other.
        const ends = lefts.map((l) => Math.max(...boxes.filter((b) => Math.round(b.left) === l).map((b) => b.bottom)));
        return { lefts, ends, tallest: Math.max(...boxes.map((b) => b.height)), sideways: document.documentElement.scrollWidth > window.innerWidth };
      });
      assert.equal(got.lefts.length, cols, `${width}: ${got.lefts.length} column(s)`);
      if (cols === 2) assert.ok(Math.abs(got.ends[0] - got.ends[1]) <= got.tallest, `${width}: the columns end ${Math.round(Math.abs(got.ends[0] - got.ends[1]))}px apart, the tallest panel is ${Math.round(got.tallest)}px`);
      assert.equal(got.sideways, false, `${width}: no sideways scroll`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
