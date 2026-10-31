import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { __onboarding } from '../src/web/onboarding.js';
import { INTERNAL_TOKEN, fakeAccounts, opened, tempHome } from './helpers.js';

// Accounts' setup checklist reads a workspace's steps in Teder at GET /internal/setup?workspace=<id> (src/web/setup.js):
// from this machine alone, with OF_INTERNAL_TOKEN, never through the proxy. The steps follow the new-account flow
// (account, sources, samples, live) and then the optional TikTok and Instagram connections; each one that has a page to
// open links to it under Teder's public name. Two packs, alpha and beta, are the workspaces' accounts.

const T = 'https://teder.test';
const AT = '2026-10-20T10:00:00.000Z';
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
      beta: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 's'.repeat(40), ...fake.env, PUBLIC_HOST: 'teder.test' } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

// Every test starts from accounts in no workspace, no onboarding, no posts and nothing connected.
afterEach(() => {
  delete process.env.ZERNIO_API_KEY;
  __onboarding.running.clear();
  db.run('DELETE FROM zernio_connections');
  db.run('DELETE FROM posts');
  db.run('DELETE FROM onboarding');
  db.run("UPDATE accounts SET workspace_id = NULL, status = 'active', created_at = ?", AT);
});

const setup = (ws, headers = {}) => fetch(`${base}/internal/setup?workspace=${ws}`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, ...headers } });
const steps = async (ws) => {
  const res = await setup(ws);
  assert.equal(res.status, 200);
  return res.json();
};
const byKey = (out) => Object.fromEntries(out.steps.map((s) => [s.key, s]));
const onboarding = (id, ws, status, patch = {}) => db.insert('onboarding', { id, seed_json: { niche: 'בישול' }, status, workspace_id: ws, created_at: AT, updated_at: AT, ...patch });
const account = (id, ws, status, patch = {}) => db.run(`UPDATE accounts SET workspace_id = ?, status = ?${patch.created_at ? ', created_at = ?' : ''} WHERE id = ?`, ...[ws, status, ...(patch.created_at ? [patch.created_at] : []), id]);
const samples = (accountId, n, from = 0) => {
  for (let i = from; i < from + n; i++) db.insert('posts', { id: `s-${accountId}-${i}`, account_id: accountId, status: 'sample', sample: 1, created_at: AT, updated_at: AT });
};
const connection = (accountId, platform, status, username = 'someone') => db.insert('zernio_connections', { account_id: accountId, platform, zernio_account_id: `z-${platform}`, username, status, issue: status === 'reconnect' ? 'token expired' : null, connected_at: AT, checked_at: AT });

test('from this machine alone, with the token, not through the proxy, and for a workspace id', async () => {
  // Refused as accounts' contract says (test/fixtures/contracts/setup.json): 401 bad_token, 403 through the proxy.
  for (const [headers, why, status, error] of [[{ authorization: '' }, 'no token', 401, 'bad_token'], [{ authorization: 'Bearer wrong' }, 'a wrong token', 401, 'bad_token'], [{ authorization: `Bearer ${INTERNAL_TOKEN}x` }, 'a longer one', 401, 'bad_token'], [{ 'x-forwarded-for': '203.0.113.9' }, 'through Caddy', 403, 'forbidden']]) {
    const res = await setup(1, headers);
    assert.equal(res.status, status, why);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { error }, why);
  }
  for (const ws of ['', 'abc', '0', '-1', '1.5', '99999999999']) assert.equal((await setup(ws)).status, 400, `workspace=${ws}`);
  assert.notEqual((await fetch(`${base}/internal/setup?workspace=1`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).status, 200, 'a GET only');
  const res = await setup(1);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /^application\/json/);
});

test('a new workspace with nothing: open an account, at /new; the rest waits, and Zernio unconfigured is soon', async () => {
  const out = await steps(5);
  assert.deepEqual(Object.keys(out), ['product', 'ready', 'steps']);
  assert.equal(out.product, 'teder');
  assert.equal(out.ready, false);
  assert.deepEqual(out.steps.map((s) => s.key), ['account', 'sources', 'samples', 'live', 'connect', 'tiktok', 'instagram', 'facebook']);
  for (const s of out.steps) {
    assert.deepEqual(Object.keys(s), ['key', 'title', 'status', 'detail', 'href', 'required']);
    assert.match(s.title, /[א-ת]/, 'a Hebrew title');
    assert.equal(typeof s.detail, 'string');
    assert.doesNotMatch(`${s.title}${s.detail}`, /[—–]|\/ה\b|\/ת\b/, 'no dashes, no gendered slashes');
  }
  const k = byKey(out);
  assert.deepEqual([k.account.status, k.account.href, k.account.required], ['todo', `${T}/new`, true]);
  for (const key of ['sources', 'samples', 'live']) assert.deepEqual([k[key].status, k[key].href, k[key].required], ['todo', null, true], key);
  for (const key of ['tiktok', 'instagram']) assert.deepEqual([k[key].status, k[key].href, k[key].required], ['soon', null, false], key);
  assert.deepEqual([k.connect.status, k.connect.href, k.connect.required], ['soon', null, true], 'nothing can be connected here, and nothing published');
  // Another workspace's accounts are not this one's: alpha in workspace 6 leaves workspace 5 where it was.
  account('alpha', 6, 'active');
  assert.equal(byKey(await steps(5)).account.status, 'todo');
});

test('each onboarding stage: searching, failed, sources to pick, samples being written and to review, ready, live', async () => {
  onboarding('o1', 6, 'discovering');
  let k = byKey(await steps(6));
  assert.deepEqual([k.account.status, k.account.href], ['working', `${T}/new/o1`]);
  assert.equal(k.sources.status, 'todo');

  db.run("UPDATE onboarding SET status = 'failed' WHERE id = 'o1'");
  k = byKey(await steps(6));
  assert.deepEqual([k.account.status, k.account.href], ['attention', `${T}/new/o1`]);

  db.run("UPDATE onboarding SET status = 'review' WHERE id = 'o1'");
  k = byKey(await steps(6));
  assert.deepEqual([k.account.status, k.sources.status, k.sources.href, k.samples.href], ['todo', 'todo', `${T}/new/o1`, null], 'the pack is written from the sources page');

  // POST /new/o1/create: the pack exists, in onboarding.
  account('alpha', 6, 'onboarding');
  db.run("UPDATE onboarding SET status = 'samples', pack_id = 'alpha' WHERE id = 'o1'");
  k = byKey(await steps(6));
  assert.deepEqual([k.account.status, k.account.detail, k.sources.status], ['done', 'חשבון alpha', 'done']);
  assert.match(k.sources.detail, /מקור/);
  assert.deepEqual([k.samples.status, k.samples.href, k.live.status, k.live.href], ['todo', `${T}/new/o1`, 'todo', null]);

  __onboarding.running.set('o1', Promise.resolve());
  k = byKey(await steps(6));
  assert.deepEqual([k.samples.status, k.samples.href], ['working', `${T}/new/o1`], 'samples being written');
  __onboarding.running.clear();

  samples('alpha', 2);
  assert.equal(byKey(await steps(6)).samples.detail, '2 דוגמאות עברו את כל הבדיקות. צריך לפחות 3 כדי להמשיך. אפשר ליצור עוד.');
  samples('alpha', 1, 2);
  k = byKey(await steps(6));
  assert.deepEqual([k.samples.status, k.samples.href], ['todo', `${T}/new/o1`], 'three are enough to look over');
  assert.equal(k.samples.detail, 'הפוסטים לדוגמה מוכנים ומחכים שתעברו עליהם.');

  db.run("UPDATE onboarding SET status = 'ready' WHERE id = 'o1'");
  k = byKey(await steps(6));
  assert.deepEqual([k.samples.status, k.live.status, k.live.href], ['done', 'todo', `${T}/new/o1`]);

  // POST /new/o1/live
  account('alpha', 6, 'active');
  db.run("UPDATE onboarding SET status = 'live' WHERE id = 'o1'");
  const out = await steps(6);
  k = byKey(out);
  assert.deepEqual(['account', 'sources', 'samples', 'live'].map((x) => k[x].status), ['done', 'done', 'done', 'done']);
  assert.equal(out.ready, false, 'on air, but nothing is connected: nothing would go out');
  assert.equal(k.connect.required, true);

  // One platform connected is enough: the other stays optional.
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  connection('alpha', 'instagram', 'connected', 'alpha.ig');
  const connected = await steps(6);
  assert.equal(connected.ready, true, 'every required step is done; TikTok is optional once Instagram is connected');
  assert.deepEqual([byKey(connected).connect.status, byKey(connected).tiktok.status, byKey(connected).tiktok.required], ['done', 'todo', false]);
  assert.match(byKey(connected).connect.detail, /אינסטגרם מחובר \(@alpha\.ig\)/);

  account('alpha', 6, 'paused');
  const paused = await steps(6);
  assert.deepEqual([byKey(paused).live.status, byKey(paused).live.href, paused.ready], ['attention', `${T}/accounts?account=alpha`, false]);
});

test('several accounts: the newest on air is reported, and a second account being added does not undo the setup', async () => {
  account('alpha', 6, 'active', { created_at: '2026-10-01T10:00:00.000Z' });
  account('beta', 6, 'onboarding', { created_at: '2026-10-25T10:00:00.000Z' });
  onboarding('o2', 6, 'samples', { pack_id: 'beta' });
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  connection('alpha', 'tiktok', 'connected');
  const out = await steps(6);
  assert.equal(out.ready, true);
  assert.equal(byKey(out).account.detail, 'חשבון alpha');
  // With nothing on air, the one still onboarding.
  account('alpha', 6, 'onboarding');
  onboarding('o3', 6, 'review', { created_at: '2026-10-26T10:00:00.000Z' });
  assert.equal(byKey(await steps(6)).sources.href, `${T}/new/o3`, 'the newest onboarding');
});

test('TikTok and Instagram: connected is done, reconnect needs attention, none links to the connect panel', async () => {
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  // Before there is an account there is nothing to connect yet.
  let k = byKey(await steps(8));
  assert.deepEqual([k.tiktok.status, k.tiktok.href], ['todo', null]);

  assert.deepEqual([k.connect.status, k.connect.href, k.connect.required], ['todo', null, true]);

  account('alpha', 6, 'active');
  k = byKey(await steps(6));
  for (const p of ['tiktok', 'instagram']) assert.deepEqual([k[p].status, k[p].href, k[p].required], ['todo', `${T}/accounts?account=alpha#connect-alpha`, false], p);
  assert.deepEqual([k.connect.status, k.connect.href], ['todo', `${T}/accounts?account=alpha#connect-alpha`]);
  assert.match(k.connect.detail, /מקצועי/, 'what Instagram needs, said before the connect');

  // A connection that stopped working, and nothing else: attention.
  connection('alpha', 'instagram', 'reconnect');
  assert.deepEqual([byKey(await steps(6)).connect.status, (await steps(6)).ready], ['attention', false]);

  connection('alpha', 'tiktok', 'connected', 'alpha.tt');
  k = byKey(await steps(6));
  assert.deepEqual([k.tiktok.status, k.tiktok.detail, k.tiktok.href], ['done', '@alpha.tt', null]);
  assert.deepEqual([k.instagram.status, k.instagram.href], ['attention', `${T}/accounts?account=alpha#connect-alpha`]);
  assert.equal(k.connect.status, 'done', 'one platform that works is enough');

  // While the account is in onboarding, the panel is on its onboarding page.
  account('beta', 7, 'onboarding');
  onboarding('o4', 7, 'samples', { pack_id: 'beta' });
  k = byKey(await steps(7));
  assert.deepEqual([k.tiktok.status, k.tiktok.href], ['todo', `${T}/new/o4#connect-beta`]);

  // Zernio unconfigured: soon, whatever is kept.
  delete process.env.ZERNIO_API_KEY;
  k = byKey(await steps(6));
  for (const p of ['tiktok', 'instagram']) assert.deepEqual([k[p].status, k[p].href], ['soon', null], p);
});
