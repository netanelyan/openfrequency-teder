import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setupOpen } from '../src/web/server.js';
import { __onboarding, CAP_HE, PAYWALL_SAMPLES, sampleRoom } from '../src/web/onboarding.js';
import { BEFORE_PAY_HE, GATE, READY_LINE, gatePage } from '../src/web/pages.js';
import { UNPAID_SETUP_USD, meterSetup, setupCapUsd, setupRoom, setupSpend } from '../src/billing/setup-cap.js';
import { meterSpend, record } from '../src/budget/ledger.js';
import { canRun, UNPAID } from '../src/autonomy/rails.js';
import { accountAllowed } from '../src/billing/entitlement.js';
import { connectLink } from '../src/publish/connect.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { csrfFor } from '../src/web/auth.js';
import { customer, fakeAccounts, listenFree, opened, operator, tempHome } from './helpers.js';

// Setting up before paying (the owner, 2026-11-02, item 2 of the audit): a customer who signed up and has not paid goes
// through /new (niche, sources, samples) and sees the samples; the paywall stops only going live and connecting, and its
// page shows the samples with "המצגות שלכם מוכנות, נשאר רק להפעיל". What the setup may spend before paying is capped
// (src/billing/setup-cap.js, $3.50 a workspace); a paying or comp workspace is as it was.
//
// Workspaces: 3 unpaid (the whole flow), 4 comp, 5 paid, 6 unpaid (the cap), 7 unpaid at the cap before it began,
// 8 unpaid (the closing slide's promo saved while the sources are searched).
// The samples are written by a stand-in for buildPost that stores a sample with one slide and records what it cost.

let home;
let ctx;
let db;
let fake;
let server;
let base;
const SECRET = 'q'.repeat(40);
const SESSION = 'u'.repeat(40);
const PAY = 'https://accounts.test/setup';
/** What the stand-in records for each sample it writes, in dollars. */
let price = 0.1;
let built = 0;

async function stubBuild(c, { pack }) {
  built += 1;
  const id = `p-sb-${built}`;
  const file = path.join(home.home, 'data', 'slides', `${id}-0.jpg`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const at = new Date().toISOString();
  c.db.insert('posts', { id, account_id: pack.id, status: 'sample', sample: 1, hook: `דוגמה ${built}`, media_json: { tiktok: [file] }, created_at: at, updated_at: at });
  c.db.insert('slides', { post_id: id, idx: 0, kind: 'cover', title: `דוגמה ${built}`, files_json: {} });
  record(c.db, { accountId: pack.id, postId: id, api: 'claude', model: 'claude-sonnet-5-5', usd: price, tag: 'outline' });
  return { postId: id, status: 'sample' };
}

before(async () => {
  delete process.env.OF_UNPAID_SETUP_USD;
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.samplesOpts = { build: stubBuild, read: async () => ({ docs: 3, sources: 1, failed: [] }), retryMs: 0 };
  fake = await fakeAccounts();
  for (const ws of [3, 6, 7, 8]) fake.entitlement(ws, 'unpaid');
  fake.entitlement(4, 'comp');
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: SESSION, OF_ASSISTANT_SECRET: SECRET, ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  delete process.env.OF_UNPAID_SETUP_USD;
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const settle = () => Promise.all([...__onboarding.running.values()]);

/** A browser signed in as a workspace's owner (or the operator): get, and post with the session's CSRF token. */
function browser(answer) {
  const { sid, cookie } = fake.session(answer);
  const get = (p) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
  const csrf = csrfFor(sid, SESSION);
  const post = (p, body = {}, { ajax = false } = {}) =>
    fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });
  return { get, post };
}

const flash = (res) => decodeURIComponent(res.headers.get('set-cookie') || '');

/** The new-account flow from the niche to an account, without its samples yet: { id, pack, review } (the sources page). */
async function setUp(b, ws) {
  const r1 = await b.post('/new', { niche: 'גינון במרפסת', audience: 'שכנים בבניין' });
  assert.equal(r1.status, 303, `ws ${ws}: the search starts`);
  const id = r1.headers.get('location').split('/').pop();
  await settle();
  assert.equal(db.get('SELECT status FROM onboarding WHERE id = ?', id).status, 'review', `ws ${ws}: the sources are found`);
  const page = await b.get(`/new/${id}`);
  assert.equal(page.status, 200, `ws ${ws}: the sources page`);
  const review = await page.text();
  const first = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const r2 = await b.post(`/new/${id}/create`, { [`approve_${first}`]: 'on', displayName: `מרפסת ירוקה ${ws}`, handle: `green.balcony.ws${ws}` });
  assert.equal(r2.status, 303, `ws ${ws}: the account is created`);
  const pack = db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id;
  assert.ok(pack, `ws ${ws}: it has its account`);
  return { id, pack, review };
}

const sampleIds = (pack) => db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 1 AND status = 'sample' ORDER BY created_at", pack).map((r) => r.id);

let three = null;

test('before paying: the customer goes through /new end to end and sees the samples, here and on the paywall', async () => {
  const b = browser(customer(3));
  // Signed up, nothing set up yet: the paywall says so plainly and leads to the setup.
  let res = await b.get('/');
  assert.equal(res.status, 402);
  let html = await res.text();
  assert.match(html, /<h1>תדר מחכה לתשלום<\/h1>/, 'said plainly, not in the red box of a refusal');
  assert.ok(html.includes(`<p>${BEFORE_PAY_HE.setup}</p>`));
  assert.ok(html.includes('<a class="btn primary" href="/new">להקים את החשבון</a>'), 'the one clear action is the setup');
  assert.ok(html.includes(`<a class="btn" href="${PAY}">איך משלמים</a>`), 'and how to pay is there');

  res = await b.get('/new');
  assert.equal(res.status, 200, 'the new-account flow is open before paying');
  assert.match(await res.text(), /name="niche"/);

  price = 0.1;
  const { id, pack, review } = await setUp(b, 3);
  // The sources step, before the account: the sources and the name, and connecting said to come after paying.
  assert.match(review, new RegExp(`action="/new/${id}/create"`));
  assert.ok(review.includes(CAP_HE.connect));
  assert.doesNotMatch(review, /\/connect\/|אפשר לחבר כבר עכשיו/);
  three = { id, pack };
  assert.equal(db.get('SELECT status FROM accounts WHERE id = ?', pack).status, 'onboarding');
  assert.equal(db.get('SELECT workspace_id FROM accounts WHERE id = ?', pack).workspace_id, 3);

  const r3 = await b.post(`/new/${id}/samples`);
  assert.equal(r3.status, 303);
  await settle();
  const ids = sampleIds(pack);
  assert.equal(ids.length, 5, 'a round asks for five');
  res = await b.get(`/new/${id}`);
  assert.equal(res.status, 200, 'the samples page');
  html = await res.text();
  for (const p of ids) assert.ok(html.includes(`src="/media/${p}/tiktok/0`), `${p} on the page`);
  assert.match(html, /5 דוגמאות עברו את כל הבדיקות\./);
  assert.ok(html.includes(`<b>${READY_LINE}</b><p>${CAP_HE.after}</p>`), 'the samples ready, and what opens after paying');
  assert.ok(html.includes(`<a class="btn sm primary" href="${PAY}">איך משלמים</a>`), 'with the way to pay');
  assert.match(html, /action="\/new\/[\w-]+\/reviewed"/, '"עברתי על הדוגמאות" stays');
  assert.match(html, new RegExp(`action="/new/${id}/samples"`), 'another round is offered (under the cap)');
  // Nothing on the page leads to the paywall.
  assert.doesNotMatch(html, /\/live"|\/connect\/|\/connections"|\/styles\?|id="schedule"|#edit"/, 'no going live, connecting, designs, days and times or editing');
  assert.ok(html.includes(CAP_HE.connect), 'connecting is said to come after paying');
  assert.doesNotMatch(html, /[—–]/);

  const r4 = await b.post(`/new/${id}/reviewed`);
  assert.equal(r4.status, 303);
  assert.equal(db.get('SELECT status FROM onboarding WHERE id = ?', id).status, 'ready');
  html = await (await b.get(`/new/${id}`)).text();
  assert.doesNotMatch(html, /להעלות לאוויר, במצב אישור|\/live"/, 'reviewed, and still no going live');
  assert.ok(html.includes(READY_LINE));

  // Its own slides, and the accounts' colours, open; the paywall shows the samples with the owner's line.
  const img = await b.get(`/media/${ids[0]}/tiktok/0`);
  assert.deepEqual([img.status, img.headers.get('content-type')], [200, 'image/jpeg']);
  assert.equal((await b.get('/static/accounts.css')).status, 200);
  res = await b.get('/');
  assert.equal(res.status, 402);
  html = await res.text();
  assert.ok(html.includes(`<h1>${READY_LINE}</h1>`), 'the line');
  assert.ok(html.includes(`<title>${READY_LINE} · תדר</title>`));
  const shown = [...html.matchAll(/<li><img src="\/media\/([\w-]+)\/tiktok\/0"/g)].map((m) => m[1]);
  assert.deepEqual(shown, ids, 'the first slide of each sample');
  assert.ok(html.includes(`<p>${BEFORE_PAY_HE.ready}</p>`));
  assert.ok(html.includes(`<a class="btn primary" href="${PAY}">איך משלמים</a>`), 'the existing way to pay, the one primary button');
  assert.ok(html.includes(`<a href="/new/${id}#samples">${BEFORE_PAY_HE.all}</a>`));
  assert.doesNotMatch(html, /class="err"|[—–]/);
  for (const p of ['/posts', '/accounts', '/settings']) assert.ok((await (await b.get(p)).text()).includes(`<h1>${READY_LINE}</h1>`), `${p}: the same paywall`);

  // What it cost is counted against the workspace: the samples' spend, and nothing else was paid for offline.
  const spent = db.get('SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS n FROM spend WHERE account_id = ?', pack);
  assert.equal(spent.n, 5);
  assert.deepEqual([Number(setupSpend(db, 3).usd.toFixed(6)), setupSpend(db, 3).calls], [Number(spent.usd.toFixed(6)), 5]);
});

test('before paying: going live and connecting stay behind the paywall, every way in', async () => {
  assert.ok(three, 'the setup of the first test');
  const { id, pack } = three;
  const b = browser(customer(3));
  const sample = sampleIds(pack)[0];
  const paths = [
    // going live: the account, a post approved or published, the account's mode, days and times, a resume
    `/new/${id}/live`, '/posts/approve-all', `/post/${sample}/approve`, `/post/${sample}/publish-now`, `/post/${sample}/publish-again`,
    `/accounts/${pack}/mode`, `/accounts/${pack}/schedule`, `/accounts/${pack}/resume`, `/accounts/${pack}/tiktok`,
    // connecting: before the account and after it
    `/new/${id}/connect/tiktok`, `/new/${id}/connect/instagram`, `/new/${id}/connect/facebook`, `/new/${id}/connections`,
    `/accounts/${pack}/connect/tiktok`, `/accounts/${pack}/connect/instagram`, `/accounts/${pack}/connect/facebook`, `/accounts/${pack}/connections`,
    // and what else changes a live account: a sample's text and photographs, its design
    `/post/${sample}/edit`, `/post/${sample}/slide/0/photo`, `/accounts/${pack}/style-pick`,
  ];
  for (const p of paths) {
    for (const ajax of [true, false]) {
      const res = await b.post(p, { mode: 'auto', day_1: 'on', t1_1: '10:00' }, { ajax });
      assert.equal(res.status, 402, `${p}${ajax ? ' (script)' : ''}`);
      const body = await res.json();
      assert.deepEqual([body.ok, body.message, body.pay], [false, GATE.unpaid.text, PAY], p);
    }
  }
  assert.deepEqual({ ...db.get('SELECT status, mode FROM accounts WHERE id = ?', pack) }, { status: 'onboarding', mode: 'approve' }, 'not live');
  assert.equal(db.get('SELECT status FROM onboarding WHERE id = ?', id).status, 'ready');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status <> 'sample'", pack).n, 0, 'nothing approved');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id = ?', pack).n, 0, 'nothing connected');
  // Every other page is the paywall.
  for (const p of [`/post/${sample}`, '/posts', '/accounts', '/results', '/topics', `/facts?account=${pack}`, '/settings', '/all', '/more', `/styles?account=${pack}`, '/progress.json']) {
    const res = await b.get(p);
    assert.equal(res.status, 402, p);
  }
  // The signed link the assistant hands on, which needs no session: refused for the unpaid workspace's account, before
  // anything is asked of Zernio (here it is not configured, so a paying account gets as far as saying so).
  for (const platform of ['tiktok', 'instagram', 'facebook']) {
    const link = new URL(connectLink(SECRET, { base, accountId: pack, platform }));
    const res = await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' });
    assert.equal(res.status, 402, platform);
    assert.match(await res.text(), /החיבור נפתח אחרי ההפעלה/);
  }
  // The engine: nothing written, drafted or published for it, an account in setup and a workspace that has not paid.
  assert.equal(canRun(db, pack).ok, false);
  assert.equal(accountAllowed(db, pack), false);
  db.run("UPDATE accounts SET status = 'active' WHERE id = ?", pack);
  try {
    assert.deepEqual([canRun(db, pack).ok, canRun(db, pack).why, canRun(db, pack).code], [false, UNPAID, 'unpaid'], 'even were it live');
  } finally {
    db.run("UPDATE accounts SET status = 'onboarding' WHERE id = ?", pack);
  }
});

test('before paying: the sources page is open, with approving, removing and adding a source; nothing on it leads to the paywall, nothing is spent', async () => {
  assert.ok(three, 'the setup of the first test');
  const { pack } = three;
  const b = browser(customer(3));
  const spent = setupSpend(db, 3);
  const src = db.get("SELECT id FROM sources WHERE account_id = ? AND status = 'approved' ORDER BY id LIMIT 1", pack);
  assert.ok(src, 'the source chosen on /new');
  let res = await b.get('/sources');
  assert.equal(res.status, 200);
  let html = await res.text();
  assert.ok(html.includes(`action="/sources/${src.id}/remove"`), 'its source, with its button');
  assert.ok(html.includes('action="/sources/add"'), 'the form to add one');
  assert.doesNotMatch(html, /href="\/topics"|href="\/facts/, 'no topics or hand-checked facts: those are behind the paywall');
  assert.doesNotMatch(html, /class="err"|[—–]/);
  assert.equal((await b.get(`/sources?account=${pack}`)).status, 200);

  res = await b.post(`/sources/${src.id}/remove`);
  assert.equal(res.status, 303, 'removed');
  assert.equal(db.get('SELECT status FROM sources WHERE id = ?', src.id).status, 'removed');
  res = await b.post(`/sources/${src.id}/approve`, {}, { ajax: true });
  assert.equal(res.status, 200, 'approved again, by script');
  assert.equal((await res.json()).ok, true);
  assert.equal(db.get('SELECT status FROM sources WHERE id = ?', src.id).status, 'approved');
  res = await b.post('/sources/add', { account: pack, name: 'גינה עירונית', url: 'https://example.org/garden', type: 'web', why: 'אתר של גננים שבודקים כל צמח לפני שהם כותבים עליו' });
  assert.equal(res.status, 303, 'added');
  assert.equal(db.get("SELECT status FROM sources WHERE account_id = ? AND url = 'https://example.org/garden'", pack)?.status, 'approved');
  html = await (await b.get('/sources')).text();
  assert.ok(html.includes('גינה עירונית'));

  // The list of outlets is the operator's: before paying, it is the paywall like the rest.
  assert.equal((await b.post('/sources/catalog', { account: pack, niche: 'football', id: 'x' })).status, 402);
  // None of it is a paid call: the setup's tally is where it was.
  assert.deepEqual(setupSpend(db, 3), spent);
});

test('before paying: the closing slide promo is saved on /new before the account exists, not the paywall', async () => {
  const b = browser(customer(8));
  const r1 = await b.post('/new', { niche: 'צמחי בית', audience: 'דירות קטנות' });
  assert.equal(r1.status, 303);
  const id = r1.headers.get('location').split('/').pop();
  // The step is on the page whether the search still runs (its own save) or has finished (inside the account's form).
  const page = await (await b.get(`/new/${id}`)).text();
  assert.ok(page.includes('name="promo_name"'), 'the promo step is on the page');
  const res = await b.post(`/new/${id}/promo`, { promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה', promo_target: 'bio' });
  assert.equal(res.status, 303, 'saved, not 402');
  const setup = JSON.parse(db.get('SELECT setup_json FROM onboarding WHERE id = ?', id).setup_json);
  assert.equal(setup.promoBy, 'customer');
  assert.equal(setup.promo.name, 'שתיל ועלה');
  await settle();
  // Made with the promo half filled in: the account is made, and the note says Settings opens after activating, with no
  // link to it (Settings is the paywall's).
  const first = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const made = await b.post(`/new/${id}/create`, { [`approve_${first}`]: 'on', displayName: 'שתיל ועלה', handle: 'shatil.ws8', promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'site', promo_site: 'shatil-vaale.example' });
  assert.equal(made.status, 303, 'the account is made');
  assert.ok(db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id);
  const html = await (await b.get(`/new/${id}`)).text();
  assert.ok(html.includes('id="promo-later"'), 'the note');
  assert.ok(html.includes('אפשר להשלים אותו בהגדרות אחרי ההפעלה.'));
  const note = html.slice(html.indexOf('id="promo-later"'), html.indexOf('</div></div>', html.indexOf('id="promo-later"')));
  assert.doesNotMatch(note, /<a /, 'no link to Settings in it before paying');
});

test('a comp and a paid workspace: exactly as before, never counted against the cap', async () => {
  const b = browser(customer(4));
  assert.equal((await b.get('/')).status, 200, 'comp: the product');
  price = 0.1;
  const { id, pack, review } = await setUp(b, 4);
  // The connect panel itself: no Zernio key here, so it says connecting is not open yet (src/web/connect.js CONNECT_CLOSED_HE).
  assert.match(review, /<section class="panel" id="connect">[^]*?<div class="connect" id="connect-/, 'connecting offered on the sources page');
  assert.ok(!review.includes(CAP_HE.connect));
  await b.post(`/new/${id}/samples`);
  await settle();
  let html = await (await b.get(`/new/${id}`)).text();
  assert.doesNotMatch(html, /id="activate"/, 'no banner');
  assert.ok(!html.includes(CAP_HE.connect));
  assert.match(html, new RegExp(`<div id="connect"[^>]*><div class="connect" id="connect-${pack}"`), 'the connect panel');
  assert.match(html, /id="schedule"/, 'the days and times');
  assert.match(html, /עיצוב המצגות/, 'the designs');
  assert.match(html, /#edit"/, 'a sample can be edited');
  await b.post(`/new/${id}/reviewed`);
  html = await (await b.get(`/new/${id}`)).text();
  assert.match(html, new RegExp(`action="/new/${id}/live"`), 'going live is offered');
  const live = await b.post(`/new/${id}/live`);
  assert.equal(live.status, 303);
  assert.equal(db.get('SELECT status FROM accounts WHERE id = ?', pack).status, 'active', 'and it goes live');
  assert.equal(getSetting(db, 'setup-spend:4', null), null, 'nothing counted for a workspace that pays');
  // The signed connect link is not refused for it: it gets as far as Zernio (not configured here).
  const link = new URL(connectLink(SECRET, { base, accountId: pack, platform: 'tiktok' }));
  assert.equal((await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' })).status, 503);

  // A paid workspace with a tally far over the cap (say it set up before paying): the cap is not looked at.
  setSetting(db, 'setup-spend:5', { usd: 100, calls: 99, at: new Date().toISOString() });
  const p = browser(customer(5));
  assert.equal((await p.get('/')).status, 200);
  assert.deepEqual(setupRoom(db, 5), { ok: true, unpaid: false, spent: null, cap: null });
  const r = await p.post('/new', { niche: 'אפייה ביתית' });
  assert.equal(r.status, 303);
  assert.ok(db.get('SELECT 1 FROM onboarding WHERE workspace_id = 5'), 'the search started');
  await settle();
  // The operator, and an account in no workspace, are never weighed against it either.
  assert.equal(setupRoom(db, null).ok, true);
});

test('the cap: the samples stop at the limit, nothing more is spent, and the page says the samples are ready', async () => {
  assert.equal(UNPAID_SETUP_USD, 3.5, 'the cap the owner was shown');
  assert.equal(setupCapUsd({}), 3.5);
  for (const junk of ['', 'abc', '-1', ' ']) assert.equal(setupCapUsd({ OF_UNPAID_SETUP_USD: junk }), 3.5, `"${junk}" is the default`);
  assert.equal(setupCapUsd({ OF_UNPAID_SETUP_USD: '5' }), 5);
  assert.equal(setupCapUsd({ OF_UNPAID_SETUP_USD: '0' }), 0, 'nothing at all before paying, if the operator says so');

  const b = browser(customer(6));
  price = 1; // a dollar a sample: past $3.50 after the fourth
  const before = built;
  const { id, pack } = await setUp(b, 6);
  assert.equal(setupSpend(db, 6).usd, 0, 'offline, the search and the account cost nothing');
  await b.post(`/new/${id}/samples`);
  await settle();
  assert.equal(built - before, 4, 'three under the cap, the fourth crosses it, and no fifth is started');
  assert.equal(sampleIds(pack).length, 4);
  assert.deepEqual([setupSpend(db, 6).usd, setupSpend(db, 6).calls], [4, 4]);
  const r = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json);
  assert.deepEqual([r.samples.made, r.samples.failure], [4, null], 'four is more than enough to go on');
  assert.deepEqual(sampleRoom(db, { ...db.get('SELECT * FROM onboarding WHERE id = ?', id), found: r }), { ok: false, why: 'cap' });

  // The page: the samples are ready, the rest after activating, the way to pay; no button for more.
  let html = await (await b.get(`/new/${id}`)).text();
  assert.ok(html.includes(`<div class="banner info" id="activate">`));
  assert.ok(html.includes(`<b>${READY_LINE}</b><p>${CAP_HE.more}</p>`));
  assert.ok(html.includes(`<a class="btn sm primary" href="${PAY}">איך משלמים</a>`));
  assert.doesNotMatch(html, new RegExp(`action="/new/${id}/samples"`), 'no more samples offered');
  assert.doesNotMatch(html, /banner warn|כתבו לנו/, 'calm: no warning, nobody to write to');
  // Asked anyway: refused, nothing spent.
  const spentRows = () => db.get('SELECT COUNT(*) AS n FROM spend WHERE account_id = ?', pack).n;
  const rows = spentRows();
  const again = await b.post(`/new/${id}/samples`);
  assert.equal(again.status, 303);
  assert.ok(flash(again).includes(`${READY_LINE}. ${CAP_HE.more}`), 'the same calm words');
  const ajax = await b.post(`/new/${id}/samples`, {}, { ajax: true });
  assert.deepEqual([ajax.status, (await ajax.json()).message], [409, `${READY_LINE}. ${CAP_HE.more}`]);
  await settle();
  assert.equal(built - before, 4, 'no sample written');
  assert.equal(spentRows(), rows, 'nothing spent');

  // The operator is not limited, and what the operator asks for is not the customer's to count.
  const op = browser(operator());
  assert.equal((await op.post(`/new/${id}/samples`)).status, 303);
  await settle();
  assert.ok(built - before > 4, "the operator's round is written");
  assert.deepEqual([setupSpend(db, 6).usd, setupSpend(db, 6).calls], [4, 4], 'and not counted');

  // The operator raises the cap: more opens again. Paid since: no cap, no banner.
  process.env.OF_UNPAID_SETUP_USD = '10';
  try {
    assert.deepEqual(setupRoom(db, 6), { ok: true, unpaid: true, spent: 4, cap: 10 });
    html = await (await b.get(`/new/${id}`)).text();
    assert.match(html, new RegExp(`action="/new/${id}/samples"`));
  } finally {
    delete process.env.OF_UNPAID_SETUP_USD;
  }
  fake.entitlement(6, 'paid');
  db.run("DELETE FROM settings WHERE key = 'entitlement:6'");
  html = await (await b.get(`/new/${id}`)).text();
  assert.doesNotMatch(html, /id="activate"/);
  assert.match(html, /id="schedule"/);
  fake.entitlement(6, 'unpaid');
  db.run("DELETE FROM settings WHERE key = 'entitlement:6'");
});

test('the cap before any sample: no search, no account, the same calm words', async () => {
  setSetting(db, 'setup-spend:7', { usd: UNPAID_SETUP_USD, calls: 3, at: new Date().toISOString() });
  const b = browser(customer(7));
  const res = await b.get('/new');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /name="niche"/, 'no form for a search that would be refused');
  assert.ok(html.includes(`<b>${CAP_HE.noneTitle}</b><p>${CAP_HE.none}</p>`));
  assert.ok(html.includes(`<a class="btn sm primary" href="${PAY}">איך משלמים</a>`));
  const r = await b.post('/new', { niche: 'צילום' });
  assert.equal(r.status, 303);
  assert.ok(flash(r).includes(`${CAP_HE.noneTitle}. ${CAP_HE.none}`));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM onboarding WHERE workspace_id = 7').n, 0, 'nothing started');
  // A search that had stopped is not tried again either, and its page says so the same way.
  const at = new Date().toISOString();
  db.insert('onboarding', { id: 'o-cap7', seed_json: { niche: 'צילום' }, status: 'failed', workspace_id: 7, candidates_json: { failure: 'error' }, created_at: at, updated_at: at });
  const retry = await b.post('/new/o-cap7/retry');
  assert.ok(flash(retry).includes(CAP_HE.noneTitle));
  assert.equal(db.get("SELECT status FROM onboarding WHERE id = 'o-cap7'").status, 'failed');
  const page = await (await b.get('/new/o-cap7')).text();
  assert.ok(page.includes(`<b>${CAP_HE.noneTitle}</b>`));
  assert.doesNotMatch(page, /\/retry"/);
});

test('the meter hears every spend recorded inside the setup, however deep, and nothing outside it', async () => {
  const got = [];
  await meterSpend((usd) => got.push(usd), async () => {
    record(db, { api: 'claude', usd: 0.25, tag: 't' });
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([1, 2].map(async () => record(db, { api: 'claude-cli', usd: 0, apiUsd: 0.1, tag: 't' })));
    record(db, { api: 'pexels', usd: 0, tag: 't' });
  });
  record(db, { api: 'claude', usd: 9, tag: 'outside' });
  assert.deepEqual(got, [0.25, 0.1, 0.1], 'the API price of a CLI answer; a free call is not a call');
  // A workspace that pays runs uncounted; one that has not, counted.
  const paidBefore = getSetting(db, 'setup-spend:4', null);
  await meterSetup(db, 4, async () => record(db, { api: 'claude', usd: 1, tag: 't' }));
  assert.deepEqual(getSetting(db, 'setup-spend:4', null), paidBefore);
  const was = setupSpend(db, 3).usd;
  await meterSetup(db, 3, async () => record(db, { api: 'claude', usd: 0.5, tag: 't' }));
  assert.equal(Number((setupSpend(db, 3).usd - was).toFixed(6)), 0.5);
});

test('what is open before paying: the new-account flow up to its samples and the sources page, and nothing else', () => {
  const open = [
    ['GET', '/new'], ['GET', '/new/o-1'], ['HEAD', '/new/o-1'], ['GET', '/new/o-1/status'], ['POST', '/new'],
    ['POST', '/new/o-1/retry'], ['POST', '/new/o-1/more'], ['POST', '/new/o-1/name'], ['POST', '/new/o-1/promo'], ['POST', '/new/o-1/schedule'],
    ['POST', '/new/o-1/create'], ['POST', '/new/o-1/samples'], ['POST', '/new/o-1/reviewed'],
    ['GET', '/media/p-1/tiktok/0'], ['GET', '/media/p-1/instagram/3'], ['GET', '/static/accounts.css'],
    ['GET', '/sources'], ['HEAD', '/sources'], ['POST', '/sources/12/approve'], ['POST', '/sources/12/remove'], ['POST', '/sources/add'],
  ];
  const shut = [
    ['GET', '/'], ['POST', '/new/o-1/live'], ['POST', '/new/o-1/connect/tiktok'], ['POST', '/new/o-1/connections'],
    ['GET', '/new/o-1/connect/tiktok'], ['POST', '/accounts/a/connect/tiktok'], ['POST', '/post/p-1/approve'],
    ['GET', '/post/p-1'], ['GET', '/posts'], ['POST', '/new/o-1/status'], ['GET', '/new/o-1/samples'], ['POST', '/media/p-1/tiktok/0'],
    ['GET', '/new/o-1/x/status'], ['GET', '/newx'], ['POST', '/new/o-1/livex'],
    ['POST', '/sources/catalog'], ['POST', '/sources'], ['GET', '/sources/12'], ['POST', '/sources/x/approve'], ['POST', '/sources/12/approvex'],
    ['GET', '/topics'], ['GET', '/facts'], ['POST', '/facts/add'],
  ];
  for (const [m, p] of open) assert.equal(setupOpen(m, p), true, `${m} ${p}`);
  for (const [m, p] of shut) assert.equal(setupOpen(m, p), false, `${m} ${p}`);
});

test('the paywall page: the samples and the line once there are some, the way to set up before, the old page after an account was live', () => {
  const links = { setup: PAY, logout: 'https://accounts.test/logout', home: 'https://accounts.test' };
  const samples = Array.from({ length: PAYWALL_SAMPLES }, (_, i) => ({ src: `/media/p-${i}/tiktok/0`, alt: `דוגמה ${i}` }));
  const ready = gatePage({ kind: 'unpaid', links, setup: { href: '/new/o-9', started: true, samples } });
  assert.ok(ready.includes(`<h1>${READY_LINE}</h1>`));
  assert.equal([...ready.matchAll(/<li><img src="\/media\/p-\d\/tiktok\/0" alt="דוגמה \d"/g)].length, PAYWALL_SAMPLES);
  assert.ok(ready.includes(`<div class="links"><a class="btn primary" href="${PAY}">איך משלמים</a><a class="btn" href="${links.logout}">יציאה</a></div>`), 'one primary action: paying');
  assert.ok(ready.includes('<a href="/new/o-9#samples">'));
  const started = gatePage({ kind: 'unpaid', links, setup: { href: '/new/o-9', started: true, samples: [] } });
  assert.ok(started.includes('<a class="btn primary" href="/new/o-9">להמשיך בהקמת החשבון</a>'));
  assert.ok(started.includes(`<p>${BEFORE_PAY_HE.setup}</p>`));
  assert.doesNotMatch(started, /paysamples/);
  // A customer whose account was live and who stopped paying (beforePaying gives null): the paywall as it was.
  const lapsed = gatePage({ kind: 'unpaid', links, setup: null });
  assert.equal(lapsed, gatePage({ kind: 'unpaid', links }));
  assert.ok(lapsed.includes('<h1 class="err" role="alert">תדר מחכה לתשלום</h1>'));
  assert.ok(lapsed.includes(`<p>${GATE.unpaid.text}</p>`));
  assert.ok(lapsed.includes(`<a class="btn primary" href="${PAY}">איך משלמים</a>`));
  // The other gates never take the setup.
  assert.doesNotMatch(gatePage({ kind: 'error', links, setup: { href: '/new', started: false, samples } }), /paysamples|להקים/);
  for (const html of [ready, started, lapsed]) assert.doesNotMatch(html, /[—–]/);
});
