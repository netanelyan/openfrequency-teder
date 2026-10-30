import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { tick } from '../src/autonomy/runner.js';
import { canRun, UNPAID } from '../src/autonomy/rails.js';
import { buildPost } from '../src/pipeline/build.js';
import { publishPost, PublishRefused } from '../src/publish/index.js';
import { entitlementClient, FRESH_MS, lastKnown, RETRY_MS, STALE_MS, workspaceAllowed } from '../src/billing/entitlement.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, opened, operator, tempHome, viewingAs } from './helpers.js';

// Teder is sold self-serve, and accounts owns who has paid (GET /internal/entitlement). A workspace that has not paid
// sees a paywall instead of the product, and the engine writes, drafts and publishes nothing for its accounts; its
// posts stay. A paying customer is never stopped by accounts being down for a while: the last answer stands 24 hours.
// An account in no workspace (the operator's own) never asks.
//
// alpha is workspace 1's, bravo workspace 2's, loose is in no workspace.

let home;
let ctx;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome({
    packs: {
      alpha: null,
      bravo: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
      loose: (f) => {
        f.theme.variant = 'b';
        f.theme.fonts.display = 'Karantina';
        Object.assign(f.theme.colors, { bg: '#2B1B3D', surface: '#3A2850', ink: '#F7F2FB', muted: '#C9BCD8', accent: '#F59E0B', onAccent: '#2B1B3D' });
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'p'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

beforeEach(() => {
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, null);
  fake.entitlement(2, null);
});

const client = (opts = {}) => entitlementClient({ db, env: fake.env, ...opts });

test('the client: asked once, kept five minutes, the last answer standing 24 hours while accounts is down, never known is no', async () => {
  let t = Date.parse('2026-10-20T10:00:00Z');
  const c = client({ clock: () => t });
  const calls = fake.entitlementCalls;
  let a = await c.check(1);
  assert.deepEqual([a.allowed, a.access, a.source], [true, 'paid', 'fresh']);
  assert.equal(lastKnown(db, 1).allowed, true, 'kept where the runner reads it');
  t += FRESH_MS - 1000;
  assert.equal((await c.check(1)).source, 'cache');
  assert.equal(fake.entitlementCalls, calls + 1, 'one question in five minutes');

  // accounts falls over: the paying customer goes on, for a day.
  fake.entitlement(1, { status: 503, body: { error: 'down' } });
  t += 2000;
  a = await c.check(1);
  assert.deepEqual([a.allowed, a.source], [true, 'stale']);
  t += RETRY_MS - 1000;
  const before = fake.entitlementCalls;
  await c.check(1);
  assert.equal(fake.entitlementCalls, before, 'not asked again within the minute');
  t = Date.parse(lastKnown(db, 1).checkedAt) + STALE_MS + 1000;
  assert.equal((await c.check(1)).allowed, false, 'a day without an answer: no longer believed');
  assert.equal(workspaceAllowed(db, 1, t), false);

  // Never answered for: not allowed, whatever the reason.
  fake.entitlement(2, { status: 500, body: {} });
  assert.deepEqual([(await c.check(2)).allowed, (await c.check(2)).source], [false, 'unknown']);
  // An id accounts never had (404 no_workspace) is an answer: not allowed, and known; a deleted one is a 200, off.
  fake.entitlement(6, { status: 404, body: { error: 'no_workspace' } });
  a = await c.check(6);
  assert.deepEqual([a.allowed, a.known, a.source], [false, true, 'fresh']);
  fake.entitlement(6, 'off');
  assert.deepEqual([(await c.check(6, { live: true })).allowed, (await c.check(6)).access], [false, 'off']);
  // 401 and 405 are accounts' trouble, not the customer's: the last answer stands.
  assert.equal((await c.check(7)).allowed, true);
  for (const status of [401, 405, 503]) {
    fake.entitlement(7, { status, body: { error: 'x' } });
    const s = await c.check(7, { live: true });
    assert.deepEqual([s.allowed, s.source], [true, 'stale'], String(status));
  }
  // A 200 that is not the contract (another workspace's answer, allowed not a boolean) is not believed.
  fake.entitlement(2, { workspace: 99 });
  assert.equal((await c.check(2, { live: true })).allowed, false);
  fake.entitlement(2, { allowed: 'yes' });
  assert.equal((await c.check(2, { live: true })).allowed, false);
  // The wrong token, or none: nobody is allowed.
  assert.equal((await entitlementClient({ db, env: { ...fake.env, OF_INTERNAL_TOKEN: 'x'.repeat(40) }, clock: () => t }).check(2, { live: true })).allowed, false);
  assert.equal((await entitlementClient({ db, env: { OF_ACCOUNTS_INTERNAL: fake.env.OF_ACCOUNTS_INTERNAL }, clock: () => t }).check(2, { live: true })).allowed, false);
});

test('allowed is the only thing acted on, and a change is logged once', async () => {
  const log = [];
  const mark = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM audit').id;
  const c = client({ log: (m) => log.push(m) });
  for (const [access, allowed] of [['paid', true], ['comp', true], ['due', true], ['unpaid', false], ['cancelled', false], ['off', false]]) {
    fake.entitlement(1, access);
    assert.equal((await c.check(1, { live: true })).allowed, allowed, access);
  }
  // accounts may say paid and not allowed (a refund): allowed wins.
  fake.entitlement(1, { access: 'paid', allowed: false });
  assert.equal((await c.check(1, { live: true })).allowed, false);
  const changes = db.all("SELECT detail_json FROM audit WHERE action = 'entitlement' AND id > ? ORDER BY id", mark).map((r) => JSON.parse(r.detail_json)).filter((d) => d.workspace === 1);
  assert.deepEqual(changes.map((d) => [d.was, d.allowed]), [[null, true], [true, false]], 'paid, comp, due: one change; unpaid, cancelled, off, refunded: one more');
  assert.equal(log.filter((l) => /workspace 1: /.test(l) && /allowed/.test(l)).length, 2);
});

const GATE_TEXT = 'תדר נפתח אחרי שהתשלום מגיע אלינו. בחשבון שלכם כתוב איך משלמים. המצגות, המקורות וההגדרות שלכם נשמרים כמו שהם.';

test('the website: a workspace that has not paid sees where to read how to pay, its new-account flow too; the operator never does', async () => {
  fake.entitlement(2, 'unpaid');
  const unpaid = fake.session(customer(2)).cookie;
  for (const p of ['/', '/posts', '/new', '/settings', '/accounts']) {
    const res = await fetch(`${base}${p}`, { headers: { cookie: unpaid }, redirect: 'manual' });
    assert.equal(res.status, 402, p);
    const html = await res.text();
    assert.match(html, /תדר מחכה לתשלום/, p);
    // True whichever way accounts takes the payment: Teder opens once it is in, and how to pay is on accounts' setup
    // page, where the button goes.
    assert.ok(html.includes(`<p>${GATE_TEXT}</p>`), p);
    assert.ok(html.includes('<a class="btn primary" href="https://accounts.test/setup">איך משלמים</a>'), `${p}: the way to accounts' setup page`);
    assert.doesNotMatch(html, /משלמים בחשבון|לתשלום בחשבון/, `${p}: no promise of paying in the account`);
    assert.doesNotMatch(html, /bravo/i, `${p}: nothing of the product`);
    assert.doesNotMatch(html, /[—–]/);
  }
  // A button is refused too, before anything else is looked at.
  const res = await fetch(`${base}/posts/approve-all`, { method: 'POST', headers: { cookie: unpaid, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: 'ids=x' });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.message, GATE_TEXT);
  assert.equal(body.pay, 'https://accounts.test/setup');

  // The paying workspace, the operator, and the operator viewing the unpaid one as its customer: the product.
  for (const [who, cookie] of [['paid', fake.session(customer(1)).cookie], ['operator', fake.session(operator()).cookie], ['view-as', fake.session(viewingAs(2)).cookie]]) {
    const r = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(r.status, 200, who);
  }

  // Paid since: within five minutes the page still says to pay; once asked again, the product.
  fake.entitlement(2, 'paid');
  assert.equal((await fetch(`${base}/`, { headers: { cookie: unpaid }, redirect: 'manual' })).status, 402, 'the answer is kept five minutes');
  db.run("DELETE FROM settings WHERE key = 'entitlement:2'");
  assert.equal((await fetch(`${base}/`, { headers: { cookie: unpaid }, redirect: 'manual' })).status, 200);

  // accounts never answered for this workspace: the check failed, which is not the same as not having paid.
  fake.entitlement(5, { status: 503, body: { error: 'down' } });
  const lost = await fetch(`${base}/`, { headers: { cookie: fake.session(customer(5)).cookie }, redirect: 'manual' });
  assert.equal(lost.status, 503);
  const page = await lost.text();
  assert.match(page, /אי אפשר לבדוק כרגע/);
  assert.doesNotMatch(page, /איך משלמים|לתשלום/);
});

test('the engine: nothing is written, drafted or published for an account whose workspace has not paid; nothing is deleted', async () => {
  const tue = (hm) => israelInstant('2026-10-13', hm).getTime();
  fake.entitlement(1, 'unpaid');
  ctx.entitlements = client();
  try {
    // A post bravo had before it stopped paying stays, approved, and does not go out.
    fake.entitlement(2, 'paid');
    await ctx.entitlements.check(2, { live: true });
    const kept = (await buildPost(ctx, { pack: ctx.pack('bravo'), formatKey: 'care-guide' })).postId;
    db.run("UPDATE posts SET status = 'approved', approved_by = 'owner', slot_at = ? WHERE id = ?", new Date(tue('12:40')).toISOString(), kept);
    fake.entitlement(2, 'cancelled');
    db.run("DELETE FROM settings WHERE key = 'entitlement:2'");

    const r = await tick(ctx, { t: tue('07:05') });
    const by = (id) => r.generated.filter((g) => g.account === id).length;
    assert.equal(by('alpha'), 0, 'unpaid: nothing drafted');
    assert.equal(by('bravo'), 0, 'cancelled: nothing drafted');
    assert.ok(by('loose') > 0, 'the operator\'s own account, in no workspace, goes on');
    for (const id of ['alpha', 'bravo']) {
      const run = canRun(db, id);
      assert.deepEqual([run.ok, run.why, run.code], [false, UNPAID, 'unpaid'], id);
      assert.equal(db.get('SELECT status FROM accounts WHERE id = ?', id).status, 'active', `${id} is not paused: nothing to resume when it pays`);
    }
    const r2 = await tick(ctx, { t: tue('12:45') });
    assert.equal(r2.published.filter((p) => p.account === 'bravo').length, 0);
    assert.equal(db.get('SELECT status FROM posts WHERE id = ?', kept).status, 'approved', 'kept, not failed, not expired');
    await assert.rejects(() => publishPost(ctx, kept, { t: tue('12:46') }), (e) => e instanceof PublishRefused && e.message === UNPAID);

    // It pays: the next tick that asks lets it through.
    fake.entitlement(2, 'paid');
    db.run("DELETE FROM settings WHERE key = 'entitlement:2'");
    const r3 = await tick(ctx, { t: tue('12:47') });
    assert.deepEqual(r3.published.filter((p) => p.account === 'bravo').map((p) => p.post), [kept]);
    assert.equal(db.get('SELECT status FROM posts WHERE id = ?', kept).status, 'published');
  } finally {
    delete ctx.entitlements;
  }
});

test('the token is checked: a wrong one is refused by accounts and nobody is allowed', async () => {
  const res = await fetch(`${fake.env.OF_ACCOUNTS_INTERNAL}/internal/entitlement?workspace=1&product=teder`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
  const ok = await fetch(`${fake.env.OF_ACCOUNTS_INTERNAL}/internal/entitlement?workspace=1&product=teder`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
  assert.deepEqual(Object.keys(await ok.json()).sort(), ['access', 'allowed', 'cancelAt', 'enabled', 'graceUntil', 'paidThrough', 'plan', 'product', 'workspace'], "the fake answers in the contract's shape");
});
