import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { DEFAULT_PICKED, LIBRARY } from '../src/formats/library.js';
import { customer, fakeAccounts, operator, opened, tempHome } from './helpers.js';

// The kinds of slideshow, picked by the customer (the owner, 2026-10-31: "i want the customer to pick the formats he
// likes. it is changable, and each slideshow is in a different format."): on the sources step of a new account, and on
// the account page whenever they like. src/web/formats.js.

let home;
let ctx;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome({ packs: { demo: () => {}, second: (p) => { p.theme.template = 'poster'; p.theme.fonts.display = 'Secular One'; Object.assign(p.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' }); } } });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: (m) => process.env.FMT_DEBUG && console.error(m) });
  ctx.mediaDir = path.join(home.home, 'media');
  // demo is a customer's (workspace 1); second is the company's own, its formats hand-written.
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'f'.repeat(40), ...fake.env } });
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
const post = async (p, cookie, body, from = '/accounts') =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrfOf(from, cookie), ...body }).toString() });
const ticks = (ids) => Object.fromEntries(ids.map((id) => [`fmt_${id}`, 'on']));
const formatsFile = () => JSON.parse(readFileSync(path.join(home.home, 'packs', 'demo', 'formats.json'), 'utf8'));

test("the account page: the customer's panel shows every format in the library, theirs ticked; the company's own account has none", async () => {
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/accounts', cookie)).text();
  assert.match(html, /<section class="panel acct-formats" id="formats-demo">/);
  assert.match(html, /סוגי המצגות/);
  for (const f of LIBRARY) assert.ok(html.includes(`name="fmt_${f.id}"`), f.id);
  // The demo's own formats that are the library's are ticked (what-happened, myth-fact, hot-take), the rest not.
  assert.match(html, /name="fmt_myth-fact" checked/);
  assert.doesNotMatch(html, /name="fmt_facts" checked/);
  const op = fake.session(operator()).cookie;
  const own = await (await get('/accounts?account=second', op)).text();
  assert.doesNotMatch(own, /acct-formats/, "the company's own hand-written formats are not replaced from here");
});

test('changing them: fewer than three is refused and nothing changes; three or more become the account\'s, in turn', async () => {
  const { cookie } = fake.session(customer(1));
  const before = formatsFile();
  const few = await post('/accounts/demo/formats', cookie, ticks(['facts', 'story']));
  assert.equal(few.status, 303);
  assert.match(decodeURIComponent(few.headers.get('set-cookie') || ''), /לפחות 3/);
  assert.deepEqual(formatsFile(), before, 'the file is as it was');
  const ok = await post('/accounts/demo/formats', cookie, ticks(['ranking', 'facts', 'story', 'nope']));
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /\/accounts\?account=demo#formats-demo$/);
  const after = formatsFile();
  assert.deepEqual(after.formats.map((f) => f.id), ['facts', 'story', 'ranking']);
  assert.equal(after.rotate, 'turns');
  const html = await (await get('/accounts', cookie)).text();
  for (const id of ['facts', 'story', 'ranking']) assert.match(html, new RegExp(`name="fmt_${id}" checked`), id);
  assert.match(html, /3 נבחרו/);
  assert.ok(db.get("SELECT 1 FROM audit WHERE action = 'formats' AND account_id = 'demo'"), 'the change is in the audit log');
  // Another workspace's session cannot (test/workspaces.test.js tries every button); the account is not theirs.
  const other = fake.session(customer(2)).cookie;
  const refused = await post('/accounts/demo/formats', other, ticks(['facts', 'tips', 'iceberg']), '/new');
  assert.notEqual(refused.headers.get('location'), '/accounts?account=demo#formats-demo');
  assert.deepEqual(formatsFile().formats.map((f) => f.id), ['facts', 'story', 'ranking']);
});

test('a new account: the sources step shows the formats with the defaults ticked, and the picks become the pack\'s', async () => {
  db.insert('onboarding', {
    id: 'o-fmt', seed_json: { niche: 'אפייה ביתית', examples: [] }, status: 'review', workspace_id: 3,
    candidates_json: { candidates: [{ id: 'c1', type: 'rss', url: 'https://bake.example.org/feed', name: 'Bread Lab', origin: 'feed', why: 'בית ספר לאפייה שכותב כל שבוע על לחם ומחמצת', score: { authority: 8, freshness: 8, terms: 'ok', reason: 'אתר אפייה', relevance: 9 } }], formats: [], said: [] },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const { cookie } = fake.session(customer(3));
  const html = await (await get('/new/o-fmt', cookie)).text();
  assert.match(html, /<section class="panel" id="formats">/);
  assert.match(html, /name="formats_shown" value="1"/);
  for (const f of LIBRARY) assert.equal(new RegExp(`name="fmt_${f.id}" checked`).test(html), DEFAULT_PICKED.includes(f.id), f.id);
  // The picker is inside the form that creates the account.
  const form = html.slice(html.indexOf('action="/new/o-fmt/create"'), html.indexOf('</form>', html.indexOf('action="/new/o-fmt/create"')));
  assert.ok(form.includes('name="fmt_facts"'), 'the ticks are sent with the account');
  const make = (picks) => post('/new/o-fmt/create', cookie, { approve_c1: 'on', displayName: 'לחם בבית', handle: 'lechem.babait', formats_shown: '1', ...ticks(picks) }, '/new/o-fmt');
  const few = await make(['facts', 'tips']);
  assert.match(decodeURIComponent(few.headers.get('set-cookie') || ''), /לפחות 3/);
  assert.equal(db.get("SELECT status FROM onboarding WHERE id = 'o-fmt'").status, 'review', 'not created');
  const res = await make(['tips', 'guess-who', 'iceberg', 'facts']);
  assert.equal(res.status, 303);
  assert.doesNotMatch(decodeURIComponent(res.headers.get('set-cookie') || ''), /לא הצלחנו|לפחות/, 'created, no error');
  const made = db.get("SELECT pack_id FROM onboarding WHERE id = 'o-fmt'").pack_id;
  const file = JSON.parse(readFileSync(path.join(home.home, 'packs', made, 'formats.json'), 'utf8'));
  assert.deepEqual(file.formats.map((f) => f.id), ['facts', 'tips', 'guess-who', 'iceberg']);
  assert.equal(file.rotate, 'turns');
});

test('on a phone the picker is two cards to a row and nothing scrolls sideways; on a desk several to a row', async () => {
  const { sid } = fake.session(customer(1));
  const browser = await chromium.launch();
  try {
    for (const [width, perRow] of [[390, 2], [360, 2], [1440, 3]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/accounts`);
      const box = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('#formats-demo .fmt-pick')].map((c) => c.getBoundingClientRect());
        return { cards: cards.length, firstRow: cards.filter((r) => Math.abs(r.top - cards[0].top) < 2).length, sideways: document.documentElement.scrollWidth > window.innerWidth };
      });
      assert.equal(box.cards, LIBRARY.length);
      assert.equal(box.sideways, false, `${width}: no sideways scroll`);
      assert.ok(perRow === 2 ? box.firstRow === 2 : box.firstRow >= perRow, `${width}: ${box.firstRow} to a row`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
