import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { accountsClient, CACHE_MS, sessionIdFrom } from '../src/web/accounts.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, operator, opened, tempHome } from './helpers.js';

// Who is signed in is openfrequency-accounts' answer (its docs/internal-session.md). One test per row of that
// document's errors table, what Teder sends, which cookie it reads, the minute a page may reuse an answer, and that
// every POST asks afresh.

let home;
let ctx;
let fake;
let server;
let base;
let port;

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'z'.repeat(40), ...fake.env } });
  server = s.server;
  port = s.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie, headers = {}) => fetch(`${base}${p}`, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers } });
const post = (p, cookie, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1', ...headers }, body: new URLSearchParams(body).toString() });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/settings', cookie)).text())[1];
const loginTo = (p) => `https://accounts.test/login?next=${encodeURIComponent(`http://127.0.0.1:${port}${p}`)}`;

/** A Teder with its own settings, against the same fake accounts. */
async function another(env) {
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'z'.repeat(40), ...env } });
  return { url: `http://127.0.0.1:${s.port}`, close: () => s.server.close() };
}

test('what Teder sends: GET /internal/session?product=teder, the bearer token, the session id in a header and never in the address', async () => {
  const { sid, cookie } = fake.session(customer(1));
  assert.equal((await get('/', cookie)).status, 200);
  assert.equal(fake.last.path, '/internal/session');
  assert.equal(fake.last.product, 'teder');
  assert.equal(fake.last.auth, `Bearer ${INTERNAL_TOKEN}`);
  assert.equal(fake.last.session, sid);
});

// ---- the errors table, a row each

test('401 no_session: a page goes to the login with its full address; a button gets 401 and where to sign in', async () => {
  const { cookie } = fake.session({ status: 401, body: { error: 'no_session' } });
  const res = await get('/posts?account=demo', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), loginTo('/posts?account=demo'));
  const b = await post('/settings/kill', cookie, { on: '1' });
  assert.equal(b.status, 401);
  assert.match((await b.json()).login, /^https:\/\/accounts\.test\/login\?next=/);
  // No cookie at all is the same answer, without asking accounts.
  const calls = fake.calls;
  assert.equal((await get('/')).headers.get('location'), loginTo('/'));
  assert.equal(fake.calls, calls, 'no cookie, no question');
});

test('409 choose_workspace: to the login, which shows the picker', async () => {
  const { cookie } = fake.session({ status: 409, body: { error: 'choose_workspace' } });
  const res = await get('/accounts', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), loginTo('/accounts'));
});

test('403 no_membership: to the login', async () => {
  const { cookie } = fake.session({ status: 403, body: { error: 'no_membership' } });
  const res = await get('/', cookie);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), loginTo('/'));
});

test('403 workspace_disabled: "this account is closed", with no way in and no redirect', async () => {
  const { cookie } = fake.session({ status: 403, body: { error: 'workspace_disabled' } });
  const res = await get('/', cookie);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('location'), null);
  const html = await res.text();
  assert.match(html, /החשבון סגור/);
  assert.doesNotMatch(html, /accounts\.test\/login/, 'no way in');
  assert.equal((await post('/settings/kill', cookie, { on: '1' })).status, 403);
});

test('403 product_disabled: "not part of your plan", a link to accounts, no redirect', async () => {
  const { cookie } = fake.session({ status: 403, body: { error: 'product_disabled' } });
  const res = await get('/', cookie);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('location'), null);
  const html = await res.text();
  assert.match(html, /תדר לא מופעל בחשבון שלכם/);
  assert.match(html, /href="https:\/\/accounts\.test"/);
});

test('400 bad_product, 503 not_configured, 403 not_local and bad_host: fail closed, a page that says so, no redirect loop', async () => {
  for (const error of ['bad_product', 'not_configured', 'not_local', 'bad_host']) {
    const status = { bad_product: 400, not_configured: 503, not_local: 403, bad_host: 403 }[error];
    const { cookie } = fake.session({ status, body: { error } });
    const res = await get('/', cookie);
    assert.equal(res.status, 503, error);
    assert.equal(res.headers.get('location'), null, error);
    assert.match(await res.text(), /אי אפשר לבדוק כרגע מי נכנס/, error);
  }
});

test('401 bad_token: a wrong OF_INTERNAL_TOKEN fails closed, and is not sent round to the login', async () => {
  const t = await another({ ...fake.env, OF_INTERNAL_TOKEN: 'a-different-token-of-forty-characters-xx' });
  try {
    const { cookie } = fake.session(customer(1));
    const res = await fetch(`${t.url}/`, { redirect: 'manual', headers: { cookie } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('location'), null);
  } finally {
    t.close();
  }
});

test('no OF_INTERNAL_TOKEN here: nobody gets in, and accounts is not even asked', async () => {
  const t = await another({ ...fake.env, OF_INTERNAL_TOKEN: '' });
  try {
    const { cookie } = fake.session(customer(1));
    const calls = fake.calls;
    const res = await fetch(`${t.url}/`, { redirect: 'manual', headers: { cookie } });
    assert.equal(res.status, 503);
    assert.equal(fake.calls, calls);
  } finally {
    t.close();
  }
});

test('anything else (a refused connection, a timeout, a 5xx, a 200 in the wrong shape) is not signed in', async () => {
  // Nothing listens on port 9 of this machine.
  const t = await another({ ...fake.env, OF_ACCOUNTS_INTERNAL: 'http://127.0.0.1:9' });
  try {
    const res = await fetch(`${t.url}/`, { redirect: 'manual', headers: { cookie: fake.session(customer(1)).cookie } });
    assert.equal(res.status, 503);
  } finally {
    t.close();
  }
  const slow = fake.session((req, res) => setTimeout(() => res.end('{}'), 3000));
  assert.equal((await get('/', slow.cookie)).status, 503, 'accounts gets two seconds');
  assert.equal((await get('/', fake.session({ status: 500, body: {} }).cookie)).status, 503);
  for (const bad of [{ ...customer(1), products: ['toran'] }, { ...customer(1), workspace: null }, { ...customer(1), readOnly: 'no' }, { ...customer(1), viewAs: { by: { id: 1 } }, readOnly: false }, { user: {} }]) {
    assert.equal((await get('/', fake.session(bad).cookie)).status, 503, JSON.stringify(bad));
  }
});

// ---- the cookie

test('over HTTPS only __Secure-of_session counts; on plain HTTP only of_session', async () => {
  const { sid } = fake.session(customer(1));
  const https = { 'x-forwarded-proto': 'https' };
  assert.equal((await get('/', `__Secure-of_session=${sid}`, https)).status, 200);
  // A sibling subdomain can plant a plain of_session for the whole domain; over HTTPS it is not read.
  assert.equal((await get('/', `of_session=${sid}`, https)).status, 303);
  assert.equal((await get('/', `__Secure-of_session=${sid}`)).status, 303);
  assert.equal(sessionIdFrom({ of_session: 'short' }, { https: false }), null, 'a malformed id is not sent anywhere');
});

// ---- the minute a page may reuse, and the buttons that never do

test('a page reuses an answer for up to a minute; every POST asks afresh, and a refusal ends the reuse at once', async () => {
  const { sid, cookie } = fake.session(customer(1));
  let calls = fake.calls;
  assert.equal((await get('/', cookie)).status, 200);
  assert.equal((await get('/posts', cookie)).status, 200);
  assert.equal((await get('/accounts', cookie)).status, 200);
  assert.equal(fake.calls - calls, 1, 'three pages, one question');
  const csrf = await csrfOf(cookie);
  calls = fake.calls;
  await post('/accounts/demo/mode', cookie, { _csrf: csrf, mode: 'approve' });
  await post('/accounts/demo/mode', cookie, { _csrf: csrf, mode: 'approve' });
  assert.equal(fake.calls - calls, 2, 'every POST asks');
  // Signed out in accounts: the next button is refused even though a page a moment ago was fine.
  fake.answer(sid, null);
  const before = ctx.db.get("SELECT mode FROM accounts WHERE id = 'demo'").mode;
  const res = await post('/accounts/demo/mode', cookie, { _csrf: csrf, mode: 'auto' });
  assert.equal(res.status, 401);
  assert.equal(ctx.db.get("SELECT mode FROM accounts WHERE id = 'demo'").mode, before, 'nothing changed');
  // ...and the refusal dropped the remembered answer, so the next page goes to the login too.
  assert.equal((await get('/', cookie)).status, 303);
});

test('the client: a minute, then it asks again; only "signed in" is remembered', async () => {
  let t = 1_000_000;
  let answer = { status: 200, body: customer(1) };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['x-of-session']);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  const c = accountsClient({ env: fake.env, fetchImpl, clock: () => t });
  const sid = 'session-id-of-the-test-0000000000000';
  assert.equal((await c.whoIs(sid)).status, 200);
  t += CACHE_MS - 1;
  assert.equal((await c.whoIs(sid)).cached, true);
  t += 2;
  assert.equal((await c.whoIs(sid)).cached, false, 'after a minute it asks again');
  assert.equal(seen.length, 2);
  answer = { status: 503, body: { error: 'not_configured' } };
  assert.equal((await c.whoIs(sid, { live: true })).status, 503);
  assert.equal(c.size, 0, 'an error is never remembered, and it removes what was');
  assert.equal((await c.whoIs(sid)).cached, false);
});

// ---- CSRF stays Teder's own

test("a CSRF token is good only with the session it was made for", async () => {
  const a = fake.session(customer(1));
  const b = fake.session(customer(1));
  const tokenOfA = await csrfOf(a.cookie);
  const res = await post('/accounts/demo/kill', b.cookie, { _csrf: tokenOfA });
  assert.equal(res.status, 403);
  assert.equal(ctx.db.get("SELECT status FROM accounts WHERE id = 'demo'").status, 'active');
  const other = await post('/accounts/demo/kill', a.cookie, { _csrf: tokenOfA }, { origin: 'https://evil.example' });
  assert.equal(other.status, 403, 'and the Origin must be ours');
});

test("the operator's settings: a customer is refused on the server; the operator may", async () => {
  const owner = fake.session(customer(1)).cookie;
  const csrf = await csrfOf(owner);
  const before = ctx.db.all('SELECT key, value_json FROM settings ORDER BY key');
  for (const [p, body] of [['/settings/kill', { on: '1' }], ['/settings/generate-at', { at: '05:00' }], ['/settings/dev', { on: '1' }]]) {
    const res = await post(p, owner, { _csrf: csrf, ...body });
    assert.equal(res.status, 403, p);
  }
  assert.deepEqual(ctx.db.all('SELECT key, value_json FROM settings ORDER BY key'), before, 'nothing changed');
  const page = await (await get('/settings', owner)).text();
  for (const p of ['/settings/kill', '/settings/generate-at']) assert.ok(!page.includes(`action="${p}"`), `no ${p} form for a customer`);
  assert.match(page, /נכנסתם בתור <b class="ltr">owner1@example\.test<\/b>, בחשבון <b>Workspace 1<\/b>/);
  assert.match(page, /href="https:\/\/accounts\.test\/logout"/, 'signing out is accounts\'');

  const op = fake.session(operator()).cookie;
  const ok = await post('/settings/generate-at', op, { _csrf: await csrfOf(op), at: '06:15' });
  assert.equal(ok.status, 200);
  assert.match(ctx.db.get("SELECT value_json FROM settings WHERE key = 'generateAt'").value_json, /06:15/);
});

test('a request for another host is still refused before anything else', async () => {
  const status = await new Promise((resolve) => http.get(`${base}/`, { headers: { host: 'evil.example.com' } }, (r) => (r.resume(), resolve(r.statusCode))));
  assert.equal(status, 421);
});
