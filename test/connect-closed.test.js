import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { connectLink, onboardingDoneLink } from '../src/publish/connect.js';
import { publicConnect, publicOnboardingConnect } from '../src/web/connect.js';
import { setupSteps } from '../src/web/setup.js';
import { __onboarding } from '../src/web/onboarding.js';
import { customer, fakeAccounts, listenFree, opened, paidWorkspaces, tempHome } from './helpers.js';

// Connecting while this server has no Zernio key (ZERNIO_API_KEY unset, as helpers.js leaves it): the customer reads
// what happened and the one thing to do, "כתבו לנו", a link to our WhatsApp (OF_SUPPORT_WA) where a page shows it and
// the words alone where it is unset or nothing shows a link, and never what the server is missing. The words are
// src/web/connect.js CONNECT_CLOSED_HE: on the connect panel (the account page and the new account's page), as the
// buttons' answer, on the signed links' pages and in accounts' setup checklist.
//
// demo is workspace 1's; the onboarding o-closed is workspace 1's too, still choosing its sources. Beside the panel, the
// new account's page says nothing of connecting now while it cannot be done.

const NUMBER = '972500000001';
const LINK = `<a href="https://wa.me/${NUMBER}" target="_blank" rel="noopener noreferrer">כתבו לנו</a>`;
const CLOSED = 'החיבור לרשתות עוד לא פתוח אצלנו. כתבו לנו ונגיד לכם מתי הוא נפתח.';
const LINKED = CLOSED.replace('כתבו לנו', LINK);
// What it said before: the server, and nothing to do.
const OLD = /לא זמין|בשרת|מטפלים בזה|ZERNIO_API_KEY/;
const SECRET = 'c'.repeat(48);
const LINKS = { base: 'https://teder.test', secret: SECRET };
const AT = '2026-11-04T10:00:00.000Z';

let home;
let ctx;
let db;
let fake;
let server;
let base;
let cookie;

before(async () => {
  delete process.env.OF_SUPPORT_WA;
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run('UPDATE accounts SET workspace_id = 1');
  paidWorkspaces(db, [1]);
  db.insert('onboarding', { id: 'o-closed', seed_json: { niche: 'קרמיקה' }, status: 'review', candidates_json: { candidates: [] }, workspace_id: 1, created_at: AT, updated_at: AT });
  // While the sources are searched the page offers connecting, after its steps (the sources step does not: connecting
  // is not a step of making the account).
  db.insert('onboarding', { id: 'o-search', seed_json: { niche: 'קרמיקה' }, status: 'discovering', workspace_id: 1, created_at: AT, updated_at: AT });
  __onboarding.running.set('o-search', new Promise(() => {}));
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 's'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
  cookie = fake.session(customer(1)).cookie;
});

afterEach(() => {
  delete process.env.OF_SUPPORT_WA;
});

after(async () => {
  __onboarding.running.delete('o-search');
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const read = async (p) => (await fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } })).text();
const csrfOf = async () => /name="_csrf" value="([^"]+)"/.exec(await read('/accounts'))[1];
const post = async (p, { ajax = true } = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded', ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: await csrfOf() }).toString() });

test('the connect panel, on the account page and the new account page: what happened and "כתבו לנו", a link to our WhatsApp when there is one', async () => {
  const pages = { account: '/accounts?account=demo', onboarding: '/new/o-search' };
  for (const [what, p] of Object.entries(pages)) {
    const html = await read(p);
    assert.ok(html.includes(`<p class="muted small m0">${CLOSED}</p>`), `${what}: the words`);
    assert.doesNotMatch(html, /wa\.me/, `${what}: no number, no link`);
    assert.doesNotMatch(html, OLD, `${what}: the server is not mentioned`);
    assert.doesNotMatch(html, /לחבר את (טיקטוק|אינסטגרם|פייסבוק)/, `${what}: no button that cannot work`);
  }
  process.env.OF_SUPPORT_WA = NUMBER;
  for (const [what, p] of Object.entries(pages)) {
    const html = await read(p);
    assert.ok(html.includes(`<p class="muted small m0">${LINKED}</p>`), `${what}: the link`);
    assert.doesNotMatch(html, OLD, what);
  }
});

test('the new account page says nothing of connecting now while it cannot be done, at any stage, and says it again once it can', async () => {
  const at = { discovering: '/new/o-search', samples: '/new/o-samples' };
  // What each stage says to connect now, beside the panel.
  const now = { discovering: /ואת החיבור לטיקטוק, לאינסטגרם ולפייסבוק/, samples: /מחברים כאן את החשבונות/ };
  db.insert('onboarding', { id: 'o-samples', seed_json: { niche: 'קרמיקה' }, status: 'samples', pack_id: 'demo', workspace_id: 1, created_at: AT, updated_at: AT });
  try {
    // The sources step has no connecting at all, open or closed.
    for (const open of [false, true]) {
      if (open) process.env.ZERNIO_API_KEY = 'zk_test_key';
      const html = await read('/new/o-closed');
      assert.doesNotMatch(html, /id="connect"|אפשר לחבר כבר עכשיו/, `review, ${open ? 'open' : 'closed'}: no connecting`);
      delete process.env.ZERNIO_API_KEY;
    }
    for (const [stage, p] of Object.entries(at)) {
      const html = await read(p);
      assert.doesNotMatch(html, now[stage], `${stage}: closed`);
      assert.ok(html.includes(`<p class="muted small m0">${CLOSED}</p>`), `${stage}: the panel says why`);
    }
    process.env.ZERNIO_API_KEY = 'zk_test_key';
    for (const [stage, p] of Object.entries(at)) {
      const html = await read(p);
      assert.match(html, now[stage], `${stage}: open`);
      assert.ok(!html.includes(CLOSED), `${stage}: open`);
    }
  } finally {
    delete process.env.ZERNIO_API_KEY;
    db.run("DELETE FROM onboarding WHERE id = 'o-samples'");
  }
});

test("the buttons' answer, had a page kept one: the same words in a toast, which shows text, so with no link", async () => {
  process.env.OF_SUPPORT_WA = NUMBER;
  for (const p of ['/accounts/demo/connect/tiktok', '/accounts/demo/connections', '/new/o-closed/connect/facebook', '/new/o-closed/connections']) {
    const res = await post(p);
    assert.equal(res.status, 400, p);
    const { message } = await res.json();
    assert.equal(message, CLOSED, p);
    // Without the page's script: back to the page, the words in its toast.
    const form = await post(p, { ajax: false });
    assert.equal(form.status, 303, p);
    assert.ok(form.headers.get('set-cookie').includes(`of_flash=${encodeURIComponent(CLOSED)};`), p);
  }
});

test('a signed connect link and a return from Zernio: the same words on their page, with the link when there is one', async () => {
  const link = new URL(connectLink(SECRET, { base: LINKS.base, accountId: 'demo', platform: 'tiktok' }));
  const back = new URL(onboardingDoneLink(SECRET, { base: LINKS.base, onboardingId: 'o-closed', platform: 'instagram' }));
  const open = () => publicConnect(ctx, { account: 'demo', platform: 'tiktok', done: false, query: link.searchParams, links: LINKS });
  const done = () => publicOnboardingConnect(ctx, { onboardingId: 'o-closed', platform: 'instagram', query: back.searchParams, links: LINKS });
  for (const [what, page] of [['link', open], ['return', done]]) {
    let [status, html] = await page();
    assert.equal(status, 503, what);
    assert.ok(html.includes('<h1>עוד אי אפשר לחבר</h1>'), what);
    assert.ok(html.includes(`<p>${CLOSED}</p>`), `${what}: the words`);
    assert.doesNotMatch(html, /wa\.me/, what);
    assert.doesNotMatch(html, OLD, what);
    process.env.OF_SUPPORT_WA = NUMBER;
    [status, html] = await page();
    assert.ok(html.includes(`<p>${LINKED}</p>`), `${what}: the link`);
    delete process.env.OF_SUPPORT_WA;
  }
});

test("accounts' setup checklist: the same words, which accounts shows as text, and no address to open", () => {
  process.env.OF_SUPPORT_WA = NUMBER;
  const { steps } = setupSteps(ctx, 1, { base: LINKS.base });
  const soon = steps.filter((s) => s.status === 'soon');
  assert.deepEqual(soon.map((s) => s.key), ['connect', ...ctx.pack('demo').meta.platforms]);
  for (const s of soon) assert.deepEqual([s.detail, s.href], [CLOSED, null], s.key);
  assert.doesNotMatch(JSON.stringify(steps), OLD);
});
