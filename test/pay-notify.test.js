import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { accountAllowed, entitlementClient, FRESH_MS, lastKnown, refreshEntitlements, RETRY_MS } from '../src/billing/entitlement.js';
import { entitlementChangedRoute } from '../src/web/entitlement-changed.js';
import { RECHECK_MS } from '../src/web/server.js';
import { GATE, RECHECK_HE } from '../src/web/pages.js';
import { csrfFor } from '../src/web/auth.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, listenFree, opened, operator, tempHome, viewingAs } from './helpers.js';

// The paywall clears its cache (the owner's audit, 2026-11-02, Teder item 3: "The paywall clears the cache: support the
// notification from accounts (item 3 there), and add a "בדקו שוב" button on the paywall that forces a fresh check.").
//
//   POST /internal/entitlement/changed   accounts says a workspace's access changed (a payment recorded): the answer
//                                        Teder keeps 5 minutes is marked, and the next page, or the runner's next tick,
//                                        asks accounts afresh. Bearer OF_INTERNAL_TOKEN, this machine only, POST only.
//   POST /paywall/check                  "בדקו שוב": accounts asked now, at most once in 30 seconds for a workspace, then
//                                        back to the page the customer was on: the product once paid, else the paywall
//                                        with a line saying what was found. A plain form; no script needed.
//
// alpha is workspace 1's, bravo workspace 2's. The clock is pinned, so "inside the 5 minutes" is exact.

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const SECRET = 'n'.repeat(40);
let home;
let ctx;
let db;
let fake;
let site;
let bare;
let base;
let t;

before(async () => {
  t = T0;
  setNow(t);
  home = tempHome({
    packs: {
      alpha: null,
      // Each pack its own brand (src/packs/validate.js), as test/paywall.test.js makes them.
      bravo: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  fake = await fakeAccounts();
  const env = { ...process.env, SESSION_SECRET: SECRET, ...fake.env };
  site = await listenFree(ctx, { env });
  base = `http://127.0.0.1:${site.port}`;
  // The same Teder with no OF_INTERNAL_TOKEN of its own.
  bare = await listenFree(ctx, { env: { ...env, OF_INTERNAL_TOKEN: '' } });
});

after(async () => {
  setNow(null);
  site?.server.close();
  bare?.server.close();
  await fake?.close();
  home?.cleanup();
});

beforeEach(() => {
  // Each test starts a minute on, so a press of "בדקו שוב" (30 seconds) or a failed question (a minute) in one never
  // holds up the next.
  later(Math.max(RECHECK_MS, RETRY_MS) + 1000);
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, null);
  fake.entitlement(2, null);
});

const later = (ms) => setNow((t += ms));
/** accounts' notice, as accounts sends it (src/web/changed.js), unless a test changes a part of it. */
const changed = (body, { token = INTERNAL_TOKEN, method = 'POST', headers = {}, raw = undefined, at = site } = {}) =>
  fetch(`http://127.0.0.1:${at.port}/internal/entitlement/changed`, {
    method,
    headers: { ...(token == null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(body) }),
  });
const got = async (r) => ({ status: r.status, json: await r.json().catch(() => null) });
const page = (cookie, p = '/', extra = {}) => fetch(`${base}${p}`, { headers: { cookie, ...extra }, redirect: 'manual' });

test('accounts says it changed: the next page asks accounts again, inside the 5 minutes, and the customer who just paid sees Teder', async () => {
  fake.entitlement(2, 'unpaid');
  const cookie = fake.session(customer(2)).cookie;
  assert.equal((await page(cookie)).status, 402, 'not paid: the paywall');
  const asked = fake.entitlementCalls;
  // The payment is recorded in accounts. Within the 5 minutes Teder still has its answer, and does not ask.
  fake.entitlement(2, 'paid');
  later(60_000);
  assert.equal((await page(cookie)).status, 402);
  assert.equal(fake.entitlementCalls, asked, 'kept: not asked');

  assert.deepEqual(await got(await changed({ workspace: 2, reason: 'paid' })), { status: 200, json: { ok: true, workspace: 2, cleared: true } });
  const kept = lastKnown(db, 2);
  assert.equal(kept.allowed, false, 'the notice opens nothing by itself: accounts says what is allowed');
  assert.equal(kept.changedAt, new Date(t).toISOString(), 'it is marked, and kept for the 24 hours accounts may be down');

  later(1000);
  const res = await page(cookie);
  assert.equal(res.status, 200, 'the next page: the product, 61 seconds after the last answer');
  assert.equal(fake.entitlementCalls, asked + 1, 'accounts asked once');
  assert.equal(lastKnown(db, 2).allowed, true);
  assert.equal(lastKnown(db, 2).changedAt, undefined, 'the new answer is kept as any answer is');
  assert.equal((await page(cookie)).status, 200);
  assert.equal(fake.entitlementCalls, asked + 1, 'and used for its 5 minutes, as before');
});

test("the runner's next tick asks again too: an account whose workspace was just paid for is allowed to run without waiting the 5 minutes", async () => {
  fake.entitlement(1, 'unpaid');
  await refreshEntitlements(ctx);
  assert.equal(accountAllowed(db, 'alpha'), false);
  fake.entitlement(1, 'paid');
  later(30_000);
  await refreshEntitlements(ctx);
  assert.equal(accountAllowed(db, 'alpha'), false, 'within the 5 minutes the kept answer stands');
  assert.equal((await changed({ workspace: 1, reason: 'paid' })).status, 200);
  await refreshEntitlements(ctx);
  assert.equal(accountAllowed(db, 'alpha'), true, 'asked again at once');
});

test('a workspace Teder never asked about is fine: 200, cleared false, and nothing is written for it', async () => {
  assert.deepEqual(await got(await changed({ workspace: 999, reason: 'paid' })), { status: 200, json: { ok: true, workspace: 999, cleared: false } });
  assert.equal(lastKnown(db, 999), null);
  // A reason Teder does not know is acted on the same way.
  fake.entitlement(2, 'unpaid');
  await page(fake.session(customer(2)).cookie);
  assert.equal((await got(await changed({ workspace: 2, reason: 'a-new-one' }))).json.cleared, true);
  assert.equal((await got(await changed({ workspace: 2 }))).json.cleared, true, 'and none at all');
});

test('refused, and nothing cleared: no token, a wrong one, through Caddy, from another machine, another method, no token here, no workspace', async () => {
  fake.entitlement(2, 'unpaid');
  await page(fake.session(customer(2)).cookie);
  const wrong = 'w'.repeat(INTERNAL_TOKEN.length);
  const cases = [
    ['no token', changed({ workspace: 2 }, { token: null }), 401, 'bad_token'],
    ['a wrong token', changed({ workspace: 2 }, { token: wrong }), 401, 'bad_token'],
    ['through Caddy', changed({ workspace: 2 }, { headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
    ['GET', changed(null, { method: 'GET' }), 405, 'method_not_allowed'],
    ['PUT', changed({ workspace: 2 }, { method: 'PUT' }), 405, 'method_not_allowed'],
    ['DELETE', changed({ workspace: 2 }, { method: 'DELETE' }), 405, 'method_not_allowed'],
    ['GET without the token', changed(null, { method: 'GET', token: null }), 401, 'bad_token'],
    ['GET through Caddy', changed(null, { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' } }), 403, 'forbidden'],
    ['OF_INTERNAL_TOKEN unset here', changed({ workspace: 2 }, { at: bare }), 503, 'not_configured'],
    ['no workspace', changed({}), 400, 'bad_workspace'],
    ['a workspace as a string', changed({ workspace: '2' }), 400, 'bad_workspace'],
    ['zero', changed({ workspace: 0 }), 400, 'bad_workspace'],
    ['a fraction', changed({ workspace: 2.5 }), 400, 'bad_workspace'],
    ['not JSON', changed(null, { raw: 'workspace=2' }), 400, 'bad_workspace'],
    ['a list', changed([2]), 400, 'bad_workspace'],
    ['too large', changed({ workspace: 2, reason: 'x'.repeat(5000) }), 400, 'bad_workspace'],
  ];
  for (const [label, call, status, error] of cases) assert.deepEqual(await got(await call), { status, json: { error } }, label);
  assert.equal(lastKnown(db, 2).changedAt, undefined, 'none of them marked anything');

  // A socket that is not this machine's (the route's own check: in production Teder listens on 127.0.0.1 only).
  const req = { method: 'POST', socket: { remoteAddress: '203.0.113.9' }, headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, async *[Symbol.asyncIterator]() {} };
  assert.deepEqual(await entitlementChangedRoute(ctx, req, fake.env), [403, { error: 'forbidden' }]);
  assert.deepEqual(await entitlementChangedRoute(ctx, { ...req, socket: { remoteAddress: '::ffff:10.0.0.4' } }, fake.env), [403, { error: 'forbidden' }]);
  assert.equal(lastKnown(db, 2).changedAt, undefined);
});

test('the client: changed() makes the next check ask, past the minute a failed question waits; a question out at that moment brings back an answer that is kept marked', async () => {
  let now = Date.parse('2026-11-02T12:00:00.000Z');
  const answers = [];
  let hold = null;
  const fetchImpl = async () => {
    if (hold) await hold;
    const access = answers.shift() || 'paid';
    const allowed = access === 'paid';
    return new Response(JSON.stringify({ workspace: 2, product: 'teder', enabled: true, access, allowed, paidThrough: null, cancelAt: null, graceUntil: null }), { status: 200 });
  };
  let calls = 0;
  const c = entitlementClient({ db, env: fake.env, clock: () => now, fetchImpl: (...a) => (calls++, fetchImpl(...a)) });

  answers.push('unpaid');
  assert.equal((await c.check(2)).allowed, false);
  now += 1000;
  assert.equal((await c.check(2)).source, 'cache');
  assert.equal(c.changed(2), true);
  answers.push('paid');
  const a = await c.check(2);
  assert.deepEqual([a.allowed, a.source, calls], [true, 'fresh', 2]);

  // accounts down after a notice: the last answer still stands; a failed question waits a minute before the next, unless
  // accounts says it changed.
  let down = true;
  let flakyCalls = 0;
  const flaky = entitlementClient({ db, env: fake.env, clock: () => now, fetchImpl: async (...x) => (flakyCalls++, down ? Promise.reject(new Error('down')) : fetchImpl(...x)) });
  c.changed(2);
  const s = await flaky.check(2);
  assert.deepEqual([s.allowed, s.source, flakyCalls], [true, 'stale', 1], 'a paying customer is not stopped by accounts being down');
  now += 1000;
  assert.deepEqual([(await flaky.check(2)).source, flakyCalls], ['stale', 1], 'not asked again within the minute');
  down = false;
  flaky.changed(2);
  now += 1000;
  assert.deepEqual([(await flaky.check(2)).source, flakyCalls], ['fresh', 2], 'a notice: asked at once');
  assert.ok(RETRY_MS > 2000 && FRESH_MS > 2000);

  // A question already out when accounts says it changed (it left before the payment was committed): what it brings back
  // is kept, marked, and the next check asks again.
  c.changed(2);
  answers.push('unpaid', 'paid');
  let release;
  hold = new Promise((r) => (release = r));
  now += 1000;
  const out = c.check(2);
  now += 10;
  c.changed(2);
  hold = null;
  release();
  assert.equal((await out).allowed, false, 'the answer from before the payment');
  assert.ok(lastKnown(db, 2).changedAt, 'kept marked');
  now += 10;
  const next = await c.check(2);
  assert.deepEqual([next.allowed, next.source], [true, 'fresh'], 'asked again: paid');
  assert.equal(lastKnown(db, 2).changedAt, undefined);
});

// ---- "בדקו שוב"

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const backOf = (html) => /<form method="post" action="\/paywall\/check">.*?name="back" value="([^"]*)"/.exec(html)?.[1];
/** Pressing "בדקו שוב" as a browser does without the script: the form's fields, its Origin, no x-of-ajax. */
const press = (cookie, fields, { origin = base } = {}) =>
  fetch(`${base}/paywall/check`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: new URLSearchParams(fields), redirect: 'manual' });
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith('of_recheck=')) || null;
const withCookie = (cookie, res) => {
  const c = cookieOf(res);
  return c ? `${cookie}; ${c.split(';')[0]}` : cookie;
};

test('the paywall has "בדקו שוב": a plain form after the way to pay, carrying the page the customer is on', async () => {
  fake.entitlement(2, 'unpaid');
  const cookie = fake.session(customer(2)).cookie;
  const res = await page(cookie, '/posts?account=bravo');
  assert.equal(res.status, 402);
  const html = await res.text();
  assert.match(html, /<div class="links"><a class="btn primary" href="https:\/\/accounts\.test\/setup">איך משלמים<\/a><form method="post" action="\/paywall\/check"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="back" value="\/posts\?account=bravo"><button class="btn" type="submit">בדקו שוב<\/button><\/form><a class="btn" href="[^"]+">יציאה<\/a><\/div>/);
  assert.doesNotMatch(html, /static\/app\.js/, 'nothing on the page needs the script');
  assert.doesNotMatch(html, /class="said"/, 'no line before it is pressed');
  assert.doesNotMatch(html, /[—–]/);
  // Not on the other gates: accounts not answering, or another refusal.
  fake.entitlement(5, { status: 503, body: { error: 'down' } });
  const lost = await (await page(fake.session(customer(5)).cookie)).text();
  assert.match(lost, new RegExp(GATE.error.title));
  assert.doesNotMatch(lost, /paywall\/check/);
});

test('"בדקו שוב" after paying: accounts asked at once, inside the 5 minutes, and back to the page, now the product', async () => {
  fake.entitlement(2, 'unpaid');
  const cookie = fake.session(customer(2)).cookie;
  const html = await (await page(cookie, '/posts')).text();
  fake.entitlement(2, 'paid'); // the payment is recorded, and the notice did not reach Teder
  later(20_000);
  const asked = fake.entitlementCalls;
  const res = await press(cookie, { _csrf: csrfOf(html), back: backOf(html) });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/posts']);
  assert.equal(cookieOf(res), null, 'no line to leave');
  assert.equal(fake.entitlementCalls, asked + 1, 'accounts asked, though the answer was 20 seconds old');
  assert.equal((await page(cookie, '/posts')).status, 200, 'the product');
  assert.equal(fake.entitlementCalls, asked + 1, 'with the answer it just got');
});

test('"בדקו שוב" before paying: the paywall again with a calm line; again within 30 seconds does not ask accounts; accounts down says so', async () => {
  fake.entitlement(2, 'unpaid');
  const cookie = fake.session(customer(2)).cookie;
  let html = await (await page(cookie, '/')).text();
  const asked = fake.entitlementCalls;
  let res = await press(cookie, { _csrf: csrfOf(html), back: '/' });
  assert.deepEqual([res.status, res.headers.get('location')], [303, '/']);
  assert.match(cookieOf(res), /^of_recheck=unpaid; Path=\/; Max-Age=30; SameSite=Strict; HttpOnly$/);
  assert.equal(fake.entitlementCalls, asked + 1);
  let back = await page(withCookie(cookie, res), '/');
  assert.equal(back.status, 402);
  html = await back.text();
  assert.ok(html.includes(`<p class="said" role="status">${RECHECK_HE.said.unpaid}</p><div class="links">`), 'the line, above the buttons');
  assert.ok(back.headers.getSetCookie().some((c) => /^of_recheck=; .*Max-Age=0/.test(c)), 'said once: the cookie goes');
  assert.doesNotMatch((await (await page(cookie, '/')).text()), /class="said"/, 'and the page after it has no line');

  // A finger held on it: within 30 seconds accounts is not asked again, and the line says it was checked a moment ago.
  for (let i = 0; i < 5; i++) {
    later(1000);
    res = await press(cookie, { _csrf: csrfOf(html), back: '/' });
    assert.equal(res.status, 303);
    assert.match(cookieOf(res), /^of_recheck=soon;/);
  }
  assert.equal(fake.entitlementCalls, asked + 1, 'one question in 30 seconds, for six presses');
  html = await (await page(withCookie(cookie, res), '/')).text();
  assert.ok(html.includes(RECHECK_HE.said.soon));
  // Another workspace is not held up by this one.
  fake.entitlement(1, 'unpaid');
  const other = fake.session(customer(1)).cookie;
  const otherHtml = await (await page(other, '/')).text();
  const n = fake.entitlementCalls;
  assert.match(cookieOf(await press(other, { _csrf: csrfOf(otherHtml), back: '/' })), /^of_recheck=unpaid;/);
  assert.equal(fake.entitlementCalls, n + 1);

  // 30 seconds on, it asks again; accounts down: the last answer stands, and the line says the check failed.
  later(RECHECK_MS);
  fake.entitlement(2, { status: 503, body: { error: 'down' } });
  res = await press(cookie, { _csrf: csrfOf(html), back: '/' });
  assert.match(cookieOf(res), /^of_recheck=failed;/);
  html = await (await page(withCookie(cookie, res), '/')).text();
  assert.ok(html.includes(RECHECK_HE.said.failed));
  assert.match(html, /תדר מחכה לתשלום/, 'still the paywall: the last answer said not paid');
});

test('"בדקו שוב" is refused without the form\'s token or from another site, goes only back to a page here, and never stops the operator or view-as', async () => {
  fake.entitlement(2, 'unpaid');
  const cookie = fake.session(customer(2)).cookie;
  const first = await page(cookie, '/');
  assert.equal(first.status, 402);
  const html = await first.text();
  const asked = fake.entitlementCalls;
  const stale = await press(cookie, { back: '/' });
  assert.equal(stale.status, 403, 'no CSRF token');
  assert.match(await stale.text(), /הדף ישן/);
  assert.equal((await press(cookie, { _csrf: 'x'.repeat(43), back: '/' })).status, 403, 'a wrong one');
  assert.equal((await press(cookie, { _csrf: csrfOf(html), back: '/' }, { origin: 'https://evil.example' })).status, 403, 'another site');
  assert.equal(fake.entitlementCalls, asked, 'none of them asked accounts');
  for (const back of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '']) {
    later(RECHECK_MS);
    const r = await press(cookie, { _csrf: csrfOf(html), back });
    assert.deepEqual([r.status, r.headers.get('location')], [303, '/'], JSON.stringify(back));
  }
  const get = await fetch(`${base}/paywall/check`, { headers: { cookie }, redirect: 'manual' });
  assert.deepEqual([get.status, get.headers.get('location')], [303, '/'], 'opened as a page: home, nothing asked');

  for (const who of [operator(), viewingAs(2)]) {
    const { sid, cookie: c } = fake.session(who);
    assert.equal((await page(c, '/')).status, 200);
    const n = fake.entitlementCalls;
    const r = await press(c, { _csrf: csrfFor(sid, SECRET), back: '/posts' });
    assert.deepEqual([r.status, r.headers.get('location'), cookieOf(r)], [303, '/posts', null]);
    assert.equal(fake.entitlementCalls, n, 'never behind the paywall, so nothing to ask');
  }
});
