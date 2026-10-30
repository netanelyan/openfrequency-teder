import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { workspaceCleanups } from '../src/web/workspace-delete.js';
import { audit, getSetting, setSetting } from '../src/core/store.js';
import { REMOVALS, retentionPass } from '../src/billing/retention.js';
import { setEmailPrefs } from '../src/notify/email.js';
import { closeBrowser } from '../src/render/render.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// A customer deleted their workspace in accounts, and accounts asks Teder to forget it: POST
// /internal/workspaces/<id>/delete, from this machine alone, with OF_INTERNAL_TOKEN. Its accounts are paused and go,
// with their posts, files, sources, new-account flows and Zernio connections (disconnected on Zernio first). Another
// workspace's accounts and the operator's are untouched. Asked twice, the second answer is zeros.
//
// alpha and bravo are workspace 3's, gamma workspace 4's.

const realFetch = globalThis.fetch;
let home;
let ctx;
let db;
let fake;
let server;
let base;
const zernio = [];
let gate = null;

before(async () => {
  home = tempHome({
    packs: {
      alpha: null,
      bravo: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
      gamma: (f) => {
        f.theme.variant = 'b';
        f.theme.fonts.display = 'Karantina';
        Object.assign(f.theme.colors, { bg: '#2B1B3D', surface: '#3A2850', ink: '#F7F2FB', muted: '#C9BCD8', accent: '#F59E0B', onAccent: '#2B1B3D' });
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'data', 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 3 WHERE id IN ('alpha', 'bravo')");
  db.run("UPDATE accounts SET workspace_id = 4 WHERE id = 'gamma'");
  paidWorkspaces(db, [3, 4]);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'zernio.com') return realFetch(url, init);
    if (gate) await gate;
    zernio.push(`${(init.method || 'GET').toUpperCase()} ${u.pathname}`);
    // One account Zernio no longer has: a 404 is gone already, which is fine.
    const status = u.pathname.endsWith('/gone1') ? 404 : u.pathname.endsWith('/fail1') ? 503 : 200;
    return new Response(JSON.stringify(status === 200 ? { message: 'deleted' } : { error: 'not found' }), { status, headers: { 'content-type': 'application/json' } });
  };
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ZERNIO_API_KEY;
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

// As accounts sends it: the bearer, a JSON body of {}.
const del = (ws, headers = {}) => fetch(`${base}/internal/workspaces/${ws}/delete`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json', ...headers }, body: '{}' });
const count = (sql, ...a) => db.get(sql, ...a).n;

test('from this machine alone, with the token, not through the proxy, a POST, for a workspace id', async () => {
  // Refused as accounts' contract says (test/fixtures/contracts/workspaces-delete.json): 401 bad_token, 403 through the proxy.
  for (const [headers, why, status, error] of [[{ authorization: '' }, 'no token', 401, 'bad_token'], [{ authorization: 'Bearer wrong' }, 'a wrong token', 401, 'bad_token'], [{ 'x-forwarded-for': '203.0.113.9' }, 'through Caddy', 403, 'forbidden']]) {
    const res = await del(3, headers);
    assert.equal(res.status, status, why);
    assert.deepEqual(await res.json(), { error }, why);
  }
  for (const ws of ['abc', '0', '-1', '99999999999']) assert.equal((await del(ws)).status, 400, ws);
  assert.notEqual((await fetch(`${base}/internal/workspaces/3/delete`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }, redirect: 'manual' })).status, 200, 'a POST only');
  assert.equal(count("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = 3"), 2, 'nothing refused deleted anything');
});

test("a workspace's accounts and everything theirs go; Zernio is told; the others are as they were", async () => {
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  const a = (await buildPost(ctx, { pack: ctx.pack('alpha'), formatKey: 'care-guide' })).postId;
  const g = (await buildPost(ctx, { pack: ctx.pack('gamma'), formatKey: 'care-guide' })).postId;
  const files = Object.values(loadPost(db, a).media).flat();
  assert.ok(files.length && files.every((f) => existsSync(f)), 'alpha has rendered slides');
  // A public copy of a slide (what Zernio fetched), and what a dry publish wrote.
  const pub = path.join(home.home, 'data', 'public', `${a}-abc123`);
  mkdirSync(pub, { recursive: true });
  writeFileSync(path.join(pub, '1.jpg'), 'x');
  const dry = path.join(home.home, 'data', 'out', 'published', 'alpha');
  mkdirSync(dry, { recursive: true });
  db.update('accounts', 'alpha', { zernio_profile_id: 'prof-alpha' });
  db.insert('zernio_connections', { account_id: 'alpha', platform: 'tiktok', zernio_account_id: 'tk-alpha', username: 'a', status: 'connected', connected_at: 'x', checked_at: 'x' });
  db.insert('zernio_connections', { account_id: 'bravo', platform: 'instagram', zernio_account_id: 'gone1', username: 'b', status: 'connected', connected_at: 'x', checked_at: 'x' });
  db.insert('onboarding', { id: 'ob-3', seed_json: '{}', status: 'review', workspace_id: 3, created_at: 'x', updated_at: 'x' });
  db.insert('onboarding', { id: 'ob-4', seed_json: '{}', status: 'review', workspace_id: 4, created_at: 'x', updated_at: 'x' });
  db.insert('push_subs', { endpoint: 'https://fcm.googleapis.com/fcm/send/ws3', workspace_id: 3, created_at: 'x' });
  db.insert('notifications', { account_id: 'alpha', kind: 'draft', title: 't', body: 'b', created_at: 'x' });
  db.insert('spend', { account_id: 'alpha', api: 'anthropic', usd: 0.5, at: 'x', month: '2026-10' });
  setEmailPrefs(db, 3, { weekly: false });
  setSetting(db, 'generated:alpha:2026-10-13', 'x');
  setSetting(db, 'generated:gamma:2026-10-13', 'x');
  const sources = count("SELECT COUNT(*) AS n FROM sources WHERE account_id IN ('alpha', 'bravo')");
  const gammaBefore = JSON.stringify([db.get("SELECT * FROM accounts WHERE id = 'gamma'"), count("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'gamma'"), count("SELECT COUNT(*) AS n FROM sources WHERE account_id = 'gamma'")]);

  // Zernio is slow today: the answer does not wait for it (accounts gives up after 10 seconds and aborts).
  let open;
  gate = new Promise((r) => (open = r));
  const res = await del(3, { 'content-type': 'application/json' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual([body.deleted.accounts, body.deleted.posts, body.deleted.sources, body.deleted.onboarding, body.deleted.connections], [2, 1, sources, 1, 2]);
  assert.ok(body.after.files >= 3, `the slides, the public copy and the dry output, after the answer: ${body.after.files}`);
  assert.equal(body.after.zernio, 3, 'two connected accounts and a profile, after the answer');
  assert.equal(count("SELECT COUNT(*) AS n FROM accounts WHERE id IN ('alpha', 'bravo')"), 0, 'the rows are gone before the answer');
  assert.ok(!existsSync(path.join(home.home, 'packs', 'alpha')), 'and the pack folders: nothing reads them back in');
  open();
  await workspaceCleanups();
  assert.deepEqual(zernio.sort(), ['DELETE /api/v1/accounts/gone1', 'DELETE /api/v1/accounts/tk-alpha', 'DELETE /api/v1/profiles/prof-alpha'].sort());
  const cleaned = JSON.parse(db.get("SELECT detail_json FROM audit WHERE action = 'workspace_cleaned' ORDER BY id DESC LIMIT 1").detail_json);
  assert.deepEqual(cleaned.zernio, { removed: 3, failed: 0 }, 'one gone already (404) counts as removed');
  assert.ok(cleaned.files >= 3);

  // Gone: the rows, the files, the pack folders, the settings; the engine no longer has the packs.
  assert.equal(count("SELECT COUNT(*) AS n FROM accounts WHERE id IN ('alpha', 'bravo')"), 0);
  for (const t of ['posts', 'sources', 'zernio_connections', 'notifications', 'formats']) assert.equal(count(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id IN ('alpha', 'bravo')`), 0, t);
  assert.equal(count("SELECT COUNT(*) AS n FROM slides WHERE post_id = ?", a), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM onboarding WHERE workspace_id = 3"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM push_subs WHERE workspace_id = 3"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM settings WHERE key IN ('entitlement:3', 'email:prefs:3', 'generated:alpha:2026-10-13')"), 0);
  for (const f of [...files, pub, dry, path.join(home.home, 'packs', 'alpha'), path.join(home.home, 'packs', 'bravo')]) assert.equal(existsSync(f), false, f);
  assert.equal(ctx.pack('alpha'), null);
  assert.deepEqual(ctx.packs.map((p) => p.id), ['gamma']);
  // What stays is ours: the audit log and what the calls cost.
  assert.ok(count("SELECT COUNT(*) AS n FROM spend WHERE account_id = 'alpha'") >= 1);
  assert.ok(db.get("SELECT id FROM audit WHERE action = 'workspace_deleted'"));

  // Workspace 4's account, its post, its files and its pack: untouched.
  assert.equal(JSON.stringify([db.get("SELECT * FROM accounts WHERE id = 'gamma'"), count("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'gamma'"), count("SELECT COUNT(*) AS n FROM sources WHERE account_id = 'gamma'")]), gammaBefore);
  assert.ok(Object.values(loadPost(db, g).media).flat().every((f) => existsSync(f)));
  assert.equal(count("SELECT COUNT(*) AS n FROM onboarding WHERE workspace_id = 4"), 1);
  assert.ok(db.get("SELECT key FROM settings WHERE key = 'generated:gamma:2026-10-13'"));

  // A session of the deleted workspace finds nothing there.
  const { cookie } = fake.session(customer(3));
  const page = await (await fetch(`${base}/accounts`, { headers: { cookie } })).text();
  assert.doesNotMatch(page, /חשבון alpha|חשבון bravo/);

  // Asked again: the same answer, nothing left.
  zernio.length = 0;
  const zeros = { ok: true, deleted: { accounts: 0, posts: 0, sources: 0, documents: 0, onboarding: 0, connections: 0 }, after: { files: 0, zernio: 0 } };
  assert.deepEqual(await (await del(3)).json(), zeros);
  // A workspace Teder never saw: the same.
  assert.deepEqual(await (await del(77)).json(), zeros);
  await workspaceCleanups();
  assert.deepEqual(zernio, []);
});

test("a deleted account's audit rows keep what happened, never who or what it said; the summaries lose its name; what Zernio did not remove is tried again", async () => {
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  db.run("DELETE FROM settings WHERE key = ?", REMOVALS);
  const name = db.get("SELECT display_name FROM accounts WHERE id = 'gamma'").display_name;
  audit(db, { actor: 'owner4@example.test', action: 'rival', accountId: 'gamma', detail: { handle: '@someone', gaps: 'free text the customer typed' } });
  audit(db, { action: 'auto_approved', accountId: 'gamma', detail: { mode: 'approve' } });
  db.run('INSERT OR REPLACE INTO summaries (day, account_id, text, data_json, at) VALUES (?, NULL, ?, NULL, ?)', '2026-10-20', `${name}: 2 פורסמו, 0 נחסמו
אחר: 1 פורסמו, 0 נחסמו`, 'x');
  db.insert('zernio_connections', { account_id: 'gamma', platform: 'tiktok', zernio_account_id: 'fail1', username: 'g', status: 'connected', connected_at: 'x', checked_at: 'x' });
  const res = await del(4);
  assert.equal(res.status, 200);
  await workspaceCleanups();
  const rows = db.all("SELECT actor, detail_json FROM audit WHERE account_id = 'gamma'");
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.detail_json == null), 'no details');
  assert.ok(rows.some((r) => r.actor === 'deleted') && rows.some((r) => r.actor === 'engine'), 'a person is "deleted", the engine stays the engine');
  assert.ok(!rows.some((r) => /example\.test/.test(r.actor)));
  assert.equal(db.get("SELECT text FROM summaries WHERE day = '2026-10-20' AND account_id IS NULL").text, 'אחר: 1 פורסמו, 0 נחסמו');
  // Zernio refused the disconnect: kept, and the daily pass tries it again.
  assert.deepEqual(getSetting(db, REMOVALS).map((x) => [x.kind, x.id, x.reason]), [['account', 'fail1', 'deleted']]);
  zernio.length = 0;
  const out = await retentionPass(ctx, { force: true });
  assert.deepEqual(zernio, ['DELETE /api/v1/accounts/fail1']);
  assert.equal(out.removals.failed, 1);
  assert.equal(getSetting(db, REMOVALS)[0].tries, 1);
});
