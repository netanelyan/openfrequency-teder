import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { ROOT } from '../src/core/paths.js';
import { NetError } from '../src/core/net.js';
import { getSetting } from '../src/core/store.js';
import { listen } from '../src/web/server.js';
import { joinUrl, signupOpen } from '../src/web/demos.js';
import { accountsSignup, ALERT_FLOOR_MS, checkSignupSwitch, NOTES, SITE_EXPORT, siteSignup } from '../src/web/signup-switch.js';
import { INTERNAL_TOKEN, opened, tempHome } from './helpers.js';

// One sign-up switch in three places (the owner, 2026-11-02): Teder's OF_SIGNUP_OPEN, accounts' OF_SIGNUP and
// OF_SIGNUP_PRODUCTS (GET /internal/signup), the website's "signup" (signup.teder in its support.json). Checked once at
// start, after the website listens: one quiet line when they agree; a loud line and one alert when they do not; "couldn't check"
// and the alert when one cannot be asked. accounts and the website are fakes here, handed in as their fetch: no network.

const LOUD = /THE SIGN-UP SWITCH DISAGREES/;
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// accounts as its contract answers (docs/contracts/signup.json), and the website's support.json with its signup field.
const ACCOUNTS = { open: reply.bind(null, 200, { open: true, products: ['teder'] }), closed: reply.bind(null, 200, { open: false, products: [] }), toranOnly: reply.bind(null, 200, { open: true, products: ['toran'] }) };
const SITE = { open: reply.bind(null, 200, { status: 'x', signup: { teder: 'open', toran: 'closed' } }), closed: reply.bind(null, 200, { status: 'x', signup: { teder: 'closed', toran: 'closed' } }) };

/** A fetch that answers with `answer()` (a Response, or a throw), and keeps what it was asked. */
function fake(answer) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), signal: init.signal });
    return answer(url, init);
  };
  f.calls = calls;
  return f;
}

/** A fetch that never answers until its signal gives up, as a stuck service does. */
const stuck = () => fake((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));

/**
 * The check on a fresh database, the alert command a fake: { r, logs, alerts, db, accounts, site }. The token is never in
 * what is said, in any case.
 */
async function check({ teder = '1', accounts = ACCOUNTS.open, site = SITE.open, env = {}, db = null, t } = {}) {
  const home = db ? null : tempHome({ packs: {} });
  const d = db || new Db(path.join(home.home, 'data.db'));
  if (!db) opened.push(d);
  const logs = [];
  const alerts = [];
  const fetchLocal = typeof accounts === 'function' && accounts.calls ? accounts : fake(accounts);
  const fetchSite = typeof site === 'function' && site.calls ? site : fake(site);
  const run = (cmd, args, opts, cb) => (alerts.push(args), cb(null));
  const fullEnv = { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: 'http://127.0.0.1:4741', OF_ALERT_CMD: process.execPath, ...(teder == null ? {} : { OF_SIGNUP_OPEN: teder }), ...env };
  const r = await checkSignupSwitch({ db: d, log: (m) => logs.push(m) }, { env: fullEnv, fetchLocal, fetchSite, run, t });
  for (const said of [...logs, ...alerts.flat(), JSON.stringify(getSetting(d, 'alert:signup-switch', null))]) assert.ok(!said.includes(INTERNAL_TOKEN), `the token is never said: ${said}`);
  return { r, logs, alerts, db: d, accounts: fetchLocal, site: fetchSite, cleanup: () => home?.cleanup() };
}

test('the three agree, open or closed: one quiet line says so and nobody is alerted', async () => {
  for (const [teder, accounts, site, open] of [['1', ACCOUNTS.open, SITE.open, true], [null, ACCOUNTS.closed, SITE.closed, false], ['', ACCOUNTS.toranOnly, SITE.closed, false]]) {
    const c = await check({ teder, accounts, site });
    try {
      assert.deepEqual(c.logs, [`[signup] all three agree: ${open ? 'open' : 'closed'}`], `one quiet line: ${teder}`);
      assert.deepEqual(c.alerts, []);
      assert.equal(c.r.agree, true);
      assert.deepEqual([c.r.teder.open, c.r.accounts.open, c.r.site.open], [open, open, open]);
      assert.equal(getSetting(c.db, 'alert:signup-switch', null), null, 'nothing kept for the health table');
      // accounts asked on this machine with the bearer token, the website at its published support.json, once each.
      assert.deepEqual(c.accounts.calls.map((x) => [x.url, x.auth]), [['http://127.0.0.1:4741/internal/signup', `Bearer ${INTERNAL_TOKEN}`]]);
      assert.deepEqual(c.site.calls.map((x) => [x.url, x.auth]), [[SITE_EXPORT, null]]);
      assert.equal(SITE_EXPORT, 'https://openfrequency.co.il/support.json');
    } finally {
      c.cleanup();
    }
  }
});

test('each kind of disagreement is one loud line saying which one says what, and one alert to the operator', async () => {
  const cases = [
    // [Teder, accounts, website, what each one says in the line]
    ['1', ACCOUNTS.closed, SITE.open, ['Teder (OF_SIGNUP_OPEN) says open', 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) says closed', 'the website (site.config.json "signup") says open']],
    ['1', ACCOUNTS.toranOnly, SITE.open, ['Teder (OF_SIGNUP_OPEN) says open', 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) says closed for Teder (it takes toran)', 'the website (site.config.json "signup") says open']],
    [null, ACCOUNTS.open, SITE.open, ['Teder (OF_SIGNUP_OPEN) says closed', 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) says open', 'the website (site.config.json "signup") says open']],
    ['1', ACCOUNTS.open, SITE.closed, ['Teder (OF_SIGNUP_OPEN) says open', 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) says open', 'the website (site.config.json "signup") says closed']],
    ['0', ACCOUNTS.closed, SITE.open, ['Teder (OF_SIGNUP_OPEN) says closed', 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) says closed', 'the website (site.config.json "signup") says open']],
  ];
  for (const [teder, accounts, site, says] of cases) {
    const c = await check({ teder, accounts, site });
    try {
      const loud = c.logs.filter((l) => LOUD.test(l));
      assert.equal(loud.length, 1, `one loud line: ${c.logs.join(' | ')}`);
      assert.match(loud[0], /^\[signup\] !!! THE SIGN-UP SWITCH DISAGREES: /);
      for (const s of says) assert.ok(loud[0].includes(s), `${s} in: ${loud[0]}`);
      assert.ok(loud[0].endsWith(`Make the three the same: ${NOTES}`), 'and where it says how');
      assert.ok(!c.logs.some((l) => /couldn't check/.test(l)), 'all three were asked');
      // The alert: the server's command once, with the title and what each says; the log's line; kept for /all.
      assert.equal(c.alerts.length, 1);
      assert.equal(c.alerts[0][0], 'Teder: the sign-up switch disagrees');
      for (const s of says) assert.ok(c.alerts[0][1].includes(s), `${s} in the alert`);
      assert.equal(c.logs.filter((l) => l.startsWith('[alert] Teder: the sign-up switch disagrees: ')).length, 1);
      assert.equal(getSetting(c.db, 'alert:signup-switch').title, 'Teder: the sign-up switch disagrees');
      assert.deepEqual([c.r.agree, c.r.alerted], [false, true]);
    } finally {
      c.cleanup();
    }
  }
});

test("a source that cannot be asked: \"couldn't check <it>: <why>\", and one alert for the start, whatever else was found", async () => {
  const refused = () => {
    throw new NetError('fetch failed: http://127.0.0.1:4741/internal/signup', { code: 'network' });
  };
  const cases = [
    // [what is changed, the lines expected, the alert's title]
    [{ accounts: refused }, ["couldn't check accounts: fetch failed: http://127.0.0.1:4741/internal/signup"], "Teder: couldn't check the sign-up switch (accounts)"],
    [{ accounts: () => reply(401, { error: 'bad_token' }) }, ["couldn't check accounts: 401 bad_token"], "Teder: couldn't check the sign-up switch (accounts)"],
    [{ accounts: () => reply(503, { error: 'not_configured' }) }, ["couldn't check accounts: 503 not_configured"], "Teder: couldn't check the sign-up switch (accounts)"],
    // An accounts deployed before the route.
    [{ accounts: () => reply(404, { error: 'not_found' }) }, ["couldn't check accounts: 404 not_found: this accounts has no /internal/signup yet"], "Teder: couldn't check the sign-up switch (accounts)"],
    [{ accounts: () => reply(200, { open: 'yes' }) }, ["couldn't check accounts: a 200 that does not match the contract"], "Teder: couldn't check the sign-up switch (accounts)"],
    [{ env: { OF_INTERNAL_TOKEN: 'short' } }, ["couldn't check accounts: OF_INTERNAL_TOKEN is not set (32 characters or more)"], "Teder: couldn't check the sign-up switch (accounts)"],
    [{ site: () => reply(404, 'not found') }, ["couldn't check the website: HTTP 404"], "Teder: couldn't check the sign-up switch (the website)"],
    // The website as it is live today (2026-11-02): support.json from before its signup field.
    [{ site: () => reply(200, { status: 'x', products: { toran: 'soon', teder: 'live' } }) }, ["couldn't check the website: its support.json has no signup.teder"], "Teder: couldn't check the sign-up switch (the website)"],
    [{ site: () => reply(200, '<html>') }, ["couldn't check the website: its support.json is not JSON"], "Teder: couldn't check the sign-up switch (the website)"],
    [{ accounts: refused, site: () => reply(502, '') }, ["couldn't check accounts: fetch failed: http://127.0.0.1:4741/internal/signup", "couldn't check the website: HTTP 502"], "Teder: couldn't check the sign-up switch (accounts, the website)"],
  ];
  for (const [change, lines, title] of cases) {
    const c = await check(change);
    try {
      assert.deepEqual(c.logs.filter((l) => !l.startsWith('[alert]')), lines.map((l) => `[signup] ${l}`), title);
      assert.equal(c.alerts.length, 1, `one alert: ${title}`);
      assert.equal(c.alerts[0][0], title);
      for (const l of lines) assert.ok(c.alerts[0][1].includes(l.replace(/^couldn't check /, '')), `${l} in the alert`);
      assert.deepEqual([c.r.agree, c.r.alerted], [null, true]);
    } finally {
      c.cleanup();
    }
  }
  // Without the token accounts is not asked at all.
  const c = await check({ env: { OF_INTERNAL_TOKEN: '' } });
  try {
    assert.equal(c.accounts.calls.length, 0);
  } finally {
    c.cleanup();
  }
  // One down and the other two disagreeing: the loud line, the line for the one down, and still one alert.
  const both = await check({ teder: '1', accounts: refused, site: SITE.closed });
  try {
    assert.equal(both.logs.filter((l) => LOUD.test(l)).length, 1);
    assert.ok(both.logs.some((l) => l.includes('accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS) couldn\'t be checked')));
    assert.ok(both.logs.includes("[signup] couldn't check accounts: fetch failed: http://127.0.0.1:4741/internal/signup"));
    assert.deepEqual(both.alerts.map((a) => a[0]), ['Teder: the sign-up switch disagrees']);
    assert.deepEqual([both.r.agree, both.r.alerted], [false, true]);
  } finally {
    both.cleanup();
  }
});

test("every answer in accounts' signup contract is read as the contract says: a 200 is open for Teder when teder is in its products, anything else is accounts not answering", async () => {
  // A copy of openfrequency-accounts' docs/contracts/signup.json: the two must agree (test/contracts.test.js).
  const contract = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'contracts', 'signup.json'), 'utf8'));
  const answers = contract.routes[0].answers;
  assert.deepEqual([contract.routes[0].method, contract.routes[0].path], ['GET', '/internal/signup']);
  assert.ok(contract.calledBy.includes('teder'));
  for (const a of answers) {
    const got = await accountsSignup({ env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN }, fetchImpl: fake(() => reply(a.status, a.body)) });
    if (a.status === 200) assert.deepEqual(got, { open: a.body.open && a.body.products.includes('teder'), says: a.body.open ? 'open' : 'closed' }, a.case);
    else assert.deepEqual(got, { error: `${a.status} ${a.body.error}` }, a.case);
  }
});

test('a source that never answers is given up on its own timeout, and the website serves while the check waits; the start asks only after it listens, and never waits', async () => {
  // Each question has its timeout.
  const t0 = Date.now();
  assert.deepEqual(await accountsSignup({ env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN }, fetchImpl: stuck(), timeoutMs: 50 }), { error: 'timed out' });
  assert.deepEqual(await siteSignup({ fetchImpl: stuck(), timeoutMs: 50 }), { error: 'timed out' });
  assert.ok(Date.now() - t0 < 2000, 'given up, not waited for');

  // The website answers while both questions are out, and the check ends once they do.
  const { home, cleanup } = tempHome();
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 's'.repeat(40) } });
    try {
      let release;
      const held = new Promise((r) => (release = r));
      const waiting = fake(async () => (await held, reply(200, { open: true, products: ['teder'] })));
      const site = fake(async () => (await held, SITE.open()));
      let done = false;
      const pending = checkSignupSwitch(ctx, { env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_SIGNUP_OPEN: '1' }, fetchLocal: waiting, fetchSite: site }).then((r) => ((done = true), r));
      const h = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      assert.equal(h.status, 200);
      assert.equal(done, false, 'the check is still out');
      assert.ok(waiting.calls[0].signal && site.calls[0].signal, 'each question carries its timeout');
      release();
      assert.equal((await pending).agree, true);
    } finally {
      await new Promise((r) => s.server.close(r));
    }
  } finally {
    cleanup();
  }

  // scripts/web.js, which only the service runs: the check comes after `await listen(`, is not awaited, and catches.
  const src = readFileSync(path.join(ROOT, 'scripts', 'web.js'), 'utf8');
  const listened = src.indexOf('await listen(ctx)');
  const asked = src.indexOf('checkSignupSwitch(ctx)');
  assert.ok(listened > 0 && asked > listened, 'asked after the website listens');
  assert.equal(src.match(/checkSignupSwitch\(ctx\)/g).length, 1, 'once a start');
  assert.doesNotMatch(src, /await\s+checkSignupSwitch/, 'never waited for');
  assert.match(src, /^checkSignupSwitch\(ctx\)\.catch\(/m, 'a failure is caught, never a crash');
});

test('a service that restarts over and over: each start says it, the alert goes once in ten minutes', async () => {
  const t = Date.parse('2026-11-02T08:00:00Z');
  const first = await check({ teder: '1', accounts: ACCOUNTS.closed, t });
  try {
    assert.equal(first.alerts.length, 1);
    const again = await check({ teder: '1', accounts: ACCOUNTS.closed, db: first.db, t: t + 5 * 60_000 });
    assert.equal(again.logs.filter((l) => LOUD.test(l)).length, 1, 'the line, every start');
    assert.deepEqual([again.alerts.length, again.r.alerted], [0, false]);
    const later = await check({ teder: '1', accounts: ACCOUNTS.closed, db: first.db, t: t + ALERT_FLOOR_MS + 60_000 });
    assert.deepEqual([later.alerts.length, later.r.alerted], [1, true]);
    assert.equal(ALERT_FLOOR_MS, 10 * 60_000);
  } finally {
    first.cleanup();
  }
});

test("Teder's half is read the way the demo page reads it: OF_SIGNUP_OPEN 1, true, yes or on", () => {
  for (const v of ['1', 'true', 'YES', ' on ']) assert.equal(signupOpen({ OF_SIGNUP_OPEN: v }), true, v);
  for (const v of [undefined, '', '0', 'no', 'open']) assert.equal(signupOpen({ OF_SIGNUP_OPEN: v }), false, String(v));
  assert.equal(joinUrl({ OF_SIGNUP_OPEN: '1' }), 'https://accounts.openfrequency.co.il/signup');
  assert.equal(joinUrl({}), 'https://openfrequency.co.il/join?p=teder');
});
