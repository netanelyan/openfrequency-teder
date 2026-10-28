import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { assertAllowed, WRITE_RULES } from '../src/core/net.js';
import { israelInstant } from '../src/schedule/israel.js';
import { monthKey } from '../src/core/clock.js';
import { publishPost, publisherFor, sendDraft } from '../src/publish/index.js';
import { zernioAnalytics, ZernioError } from '../src/publish/zernio.js';
import { collectMetrics } from '../src/metrics/collect.js';
import { quotasData } from '../src/web/data.js';
import { DIR, signature } from '../src/assistant/sign.js';
import { deliver, detect, payloadOf } from '../src/assistant/events.js';
import {
  connectLink,
  connectLinkOk,
  connectState,
  doneLink,
  doneLinkOk,
  ensureProfile,
  GONE,
  profileIdOf,
  recordCosts,
  refreshConnections,
  startConnect,
  zernioAccountId,
  zernioCost,
  zernioTick,
} from '../src/publish/connect.js';
import { customer, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// Zernio as the publisher of customer accounts (src/publish/connect.js, src/publish/zernio.js): one profile per
// account, the customer's own connect, its health, TikTok drafts and Instagram carousels to the connected accounts,
// per-post numbers, and what Zernio bills. Zernio is a fake under the engine's own network door: every request still
// passes the door's rules, so a path the rules refuse fails here as it would live.
//
// Two customers on one server: alpha is workspace 1's, bravo workspace 2's.

const SECRET = 'z'.repeat(48);
const realFetch = globalThis.fetch;
let home;
let ctx;
let db;
let fake;
let server;
let base;
let Z;

/** A fake Zernio: profiles, connect links, accounts and their health, posts, analytics, usage. Records every call. */
function fakeZernio() {
  const st = { calls: [], profiles: [], accounts: [], health: {}, posts: [], analytics: {}, usage: { supported: true, attribution: { groups: [], totals: { totalUsd: 0 } } }, n: 0 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  st.handle = (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init.headers || {});
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const q = Object.fromEntries(u.searchParams);
    st.calls.push({ method, path: p, q, body, idem: headers.get('idempotency-key'), auth: headers.get('authorization') });
    if (method === 'POST' && p === '/profiles') {
      if (st.profiles.some((x) => x.externalId === body.externalId)) return reply(409, { error: 'A profile with this externalId exists', code: 'profile_external_id_conflict' });
      const prof = { _id: `prof${++st.n}`, name: body.name, externalId: body.externalId };
      st.profiles.push(prof);
      return reply(201, { message: 'created', profile: prof });
    }
    if (method === 'GET' && p === '/profiles') return reply(200, { profiles: st.profiles.filter((x) => !q.externalId || x.externalId === q.externalId) });
    const cm = /^\/connect\/(tiktok|instagram)$/.exec(p);
    if (method === 'GET' && cm) return reply(200, { authUrl: `https://zernio.com/connect/welcome/${cm[1]}?state=s${++st.n}`, state: 'x' });
    if (method === 'GET' && p === '/accounts') return reply(200, { accounts: st.accounts.filter((a) => !q.profileId || a.profileId === q.profileId) });
    if (method === 'GET' && p === '/accounts/health') return reply(200, { accounts: st.accounts.filter((a) => a.profileId === q.profileId).map((a) => ({ accountId: a._id, platform: a.platform, ...(st.health[a._id] || { tokenValid: true, needsReconnect: false, canPost: true, issues: [] }) })) });
    if (method === 'POST' && p === '/posts') {
      const id = `zp${++st.n}`;
      st.posts.push({ id, body });
      const pl = body.platforms[0].platform;
      return reply(201, { post: { _id: id, status: 'published', platforms: [{ platform: pl, status: 'published', platformPostId: `${pl}-${id}`, platformPostUrl: `https://www.${pl}.com/p/${id}` }] } });
    }
    if (method === 'GET' && p === '/analytics') {
      const a = st.analytics[q.postId];
      return a ? reply(a.status || 200, a.body) : reply(404, { error: 'not found' });
    }
    if (method === 'GET' && p === '/usage') return reply(200, st.usage);
    return reply(404, { error: `no such endpoint: ${method} ${p}` });
  };
  return st;
}

const pack = (id) => ctx.pack(id);
const at = (day, hm) => israelInstant(day, hm).getTime();
/** A Tuesday at noon, Israel time: not Shabbat, inside the posting windows. */
const TUE = at('2026-10-13', '12:45');

before(async () => {
  home = tempHome({
    packs: {
      alpha: (f) => {
        delete f.pack.publisher;
        f.pack.publishers = { tiktok: 'zernio', instagram: 'auto' };
      },
      bravo: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
        // Typed in by hand before profiles were made here: kept.
        f.pack.zernio = { ...(f.pack.zernio || {}), profileId: 'handprof', accounts: { tiktok: 'handtk', instagram: '' } };
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  paidWorkspaces(db, [1, 2]);
  globalThis.fetch = async (url, init) => (new URL(String(url)).hostname === 'zernio.com' ? Z.handle(url, init) : realFetch(url, init));
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'w'.repeat(40), OF_ASSISTANT_SECRET: SECRET, ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

beforeEach(() => {
  Z = fakeZernio();
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  for (const k of ['PUBLISH_MODE', 'MEDIA_PUBLIC_BASE_URL', 'IG_TOKEN_ALPHA']) delete process.env[k];
  db.run('DELETE FROM zernio_connections');
  db.run('DELETE FROM zernio_costs');
  db.run("DELETE FROM settings WHERE key LIKE 'zernio:%'");
  db.run('UPDATE accounts SET zernio_profile_id = NULL');
  delete pack('alpha').meta.instagram;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ZERNIO_API_KEY;
  await new Promise((r) => (server ? server.close(r) : r()));
  await fake?.close();
  await closeBrowser();
  home.cleanup();
});

/** A connected account in the fake, in a profile. */
const connected = (profileId, platform, id, username, extra = {}) => Z.accounts.push({ _id: id, platform, profileId, username, isActive: true, needsReconnection: false, ...extra });

test('the door opens exactly a profile create, the connect link, the accounts and their health, the bill, and a deleted customer\'s disconnect: never an inbox', () => {
  assert.ok(WRITE_RULES.some((r) => r.host === 'zernio.com' && r.path.test('/api/v1/profiles')));
  for (const [m, u] of [
    ['POST', 'https://zernio.com/api/v1/profiles'],
    ['GET', 'https://zernio.com/api/v1/profiles?externalId=alpha'],
    ['GET', 'https://zernio.com/api/v1/connect/tiktok?profileId=p'],
    ['GET', 'https://zernio.com/api/v1/connect/instagram?profileId=p'],
    ['GET', 'https://zernio.com/api/v1/accounts/health?profileId=p'],
    ['GET', 'https://zernio.com/api/v1/usage?range=custom'],
    // A customer who deleted their workspace (src/web/workspace-delete.js): their accounts and profile leave our team.
    ['DELETE', 'https://zernio.com/api/v1/accounts/abc'],
    ['DELETE', 'https://zernio.com/api/v1/profiles/abc'],
  ]) assert.ok(assertAllowed(m, u), `${m} ${u}`);
  for (const [m, u] of [
    ['DELETE', 'https://zernio.com/api/v1/accounts/abc/posts'],
    ['DELETE', 'https://zernio.com/api/v1/posts/abc'],
    ['PUT', 'https://zernio.com/api/v1/profiles/abc'],
    ['GET', 'https://zernio.com/api/v1/connect/twitter'],
    ['GET', 'https://zernio.com/api/v1/inbox/conversations'],
    ['POST', 'https://zernio.com/api/v1/connect/tiktok'],
  ]) assert.throws(() => assertAllowed(m, u), /refused/, `${m} ${u}`);
});

test('one profile per account, made once: named for it, its externalId the pack id, safe to retry; a profile typed into pack.json is kept', async () => {
  const id = await ensureProfile(db, pack('alpha'));
  assert.equal(id, 'prof1');
  assert.equal(db.get("SELECT zernio_profile_id AS p FROM accounts WHERE id = 'alpha'").p, 'prof1');
  const create = Z.calls.find((c) => c.method === 'POST' && c.path === '/profiles');
  assert.equal(create.body.externalId, 'alpha');
  assert.match(create.body.name, /alpha/);
  assert.equal(create.idem, 'of-profile-alpha', 'the same key on a retry gets the same profile');
  assert.equal(create.auth, 'Bearer zk_test_key', 'the key from private/.env, never stored with the account');
  assert.equal(await ensureProfile(db, pack('alpha')), 'prof1');
  assert.equal(Z.calls.filter((c) => c.method === 'POST').length, 1, 'never twice');

  // The answer was lost and the row never written: the create meets its own profile (409), and finds it.
  db.run("UPDATE accounts SET zernio_profile_id = NULL WHERE id = 'alpha'");
  assert.equal(await ensureProfile(db, pack('alpha')), 'prof1');
  assert.equal(Z.profiles.length, 1);

  assert.equal(await ensureProfile(db, pack('bravo')), 'handprof', "pack.json's profile, typed in by hand");
  assert.equal(db.get("SELECT zernio_profile_id AS p FROM accounts WHERE id = 'bravo'").p, 'handprof', 'and copied in');
  assert.equal(zernioAccountId(db, pack('bravo'), 'tiktok'), 'handtk', "pack.json's account until Zernio was read");
  // Zernio read: a hand-typed account in another profile of the team is still there; one nowhere on the team is gone.
  connected('Default', 'tiktok', 'handtk', 'bravo.tt');
  assert.deepEqual(await refreshConnections(db, pack('bravo')), []);
  assert.equal(zernioAccountId(db, pack('bravo'), 'tiktok'), 'handtk');
  Z.accounts = [];
  assert.deepEqual((await refreshConnections(db, pack('bravo'))).map((c) => [c.platform, c.to]), [['tiktok', 'reconnect']]);
  assert.equal(connectState(db, pack('bravo'), 'tiktok').issue, GONE);
  assert.equal(zernioAccountId(db, pack('bravo'), 'tiktok'), null);
  assert.deepEqual(await refreshConnections(db, pack('bravo')), [], 'the same break, once');
});

test('connecting: a fresh link each time, what is connected read from Zernio, a broken token marked once, reconnected to the same account', async () => {
  const p = pack('alpha');
  const url = await startConnect(db, p, 'tiktok', { doneUrl: 'https://teder.test/connect/alpha/tiktok/done?e=1&s=x' });
  assert.match(url, /^https:\/\/zernio\.com\/connect\/welcome\/tiktok/);
  const ask = Z.calls.find((c) => c.path === '/connect/tiktok');
  assert.equal(ask.q.profileId, 'prof1', 'the profile is made first');
  assert.equal(ask.q.redirect_url, 'https://teder.test/connect/alpha/tiktok/done?e=1&s=x');
  assert.equal(ask.q.headless, 'true', 'headless: no Zernio welcome screen or picker');
  assert.equal(ask.q.welcome, undefined, 'Zernio refuses welcome with headless');
  assert.equal(ask.q.reconnectAccountId, undefined, 'nothing to reconnect yet');
  assert.equal(connectState(db, p, 'tiktok').state, 'none');

  connected('prof1', 'tiktok', 'tk1', 'alpha.tt');
  connected('otherprof', 'tiktok', 'tkX', 'someone.else');
  let changes = await refreshConnections(db, p, { prefer: { tiktok: 'tkX' } });
  assert.deepEqual(changes, [{ platform: 'tiktok', from: 'none', to: 'connected', username: 'alpha.tt' }], "an account Zernio named on the way back counts only if it is in the account's profile");
  assert.deepEqual([connectState(db, p, 'tiktok').state, connectState(db, p, 'tiktok').username], ['connected', 'alpha.tt']);
  assert.equal(zernioAccountId(db, p, 'tiktok'), 'tk1');

  // The token expires: Zernio's health says so.
  Z.health.tk1 = { tokenValid: false, needsReconnect: true, canPost: false, issues: ['Token expired'] };
  changes = await refreshConnections(db, p, { t: TUE });
  assert.deepEqual(changes.map((c) => [c.platform, c.from, c.to]), [['tiktok', 'connected', 'reconnect']]);
  const row = db.get("SELECT * FROM zernio_connections WHERE account_id = 'alpha' AND platform = 'tiktok'");
  assert.equal(row.issue, 'Token expired');
  assert.equal(row.broken_at, new Date(TUE).toISOString());
  await refreshConnections(db, p, { t: TUE + 3_600_000 });
  assert.equal(db.get("SELECT broken_at FROM zernio_connections WHERE account_id = 'alpha'").broken_at, new Date(TUE).toISOString(), 'the same break, not a new one each hour');

  await startConnect(db, p, 'tiktok', { doneUrl: 'https://teder.test/done' });
  assert.equal(Z.calls.filter((c) => c.path === '/connect/tiktok').at(-1).q.reconnectAccountId, 'tk1', 'the same account, its history kept');

  // Disconnected in Zernio (as production found all three TikTok accounts on 2026-10-24): it needs connecting again,
  // the break is recorded, and nothing more is sent to an id Zernio refuses.
  Z.accounts = Z.accounts.filter((a) => a._id !== 'tk1');
  await refreshConnections(db, p, { t: TUE + 7_200_000 });
  const gone = connectState(db, p, 'tiktok');
  assert.deepEqual([gone.state, gone.issue], ['reconnect', GONE]);
  assert.equal(zernioAccountId(db, p, 'tiktok'), null);
  await startConnect(db, p, 'tiktok', { doneUrl: 'https://teder.test/done' });
  assert.equal(Z.calls.filter((c) => c.path === '/connect/tiktok').at(-1).q.reconnectAccountId, undefined, 'nothing left to reconnect: a new connect');
  connected('prof1', 'tiktok', 'tk2', 'alpha.tt');
  await refreshConnections(db, p, { t: TUE + 7_300_000 });
  assert.deepEqual([connectState(db, p, 'tiktok').state, zernioAccountId(db, p, 'tiktok')], ['connected', 'tk2']);
  assert.equal(db.get("SELECT broken_at FROM zernio_connections WHERE account_id = 'alpha'").broken_at, null);
});

test('Instagram is connected through Zernio only where our own Meta app does not publish it', async () => {
  const p = pack('alpha');
  assert.equal(connectState(db, p, 'instagram').state, 'none');
  p.meta.instagram = { userId: '17841400000000001', auth: 'facebook' };
  process.env.IG_TOKEN_ALPHA = 'tok';
  assert.equal(connectState(db, p, 'instagram').state, 'meta');
  await assert.rejects(() => startConnect(db, p, 'instagram', { doneUrl: 'https://teder.test/done' }), (e) => e.code === 'not_connectable');
  assert.equal(Z.calls.filter((c) => c.path === '/connect/instagram').length, 0);
});

test('the publisher: Instagram by our own Meta app when it is set up, else Zernio once connected; our own TikTok app is not built and writes to disk', async () => {
  const p = pack('alpha');
  process.env.PUBLISH_MODE = 'live';
  assert.equal(publisherFor(p, 'instagram', { db }), 'dry', 'nothing connected, no Meta token');
  await ensureProfile(db, p);
  connected('prof1', 'instagram', 'ig1', 'alpha.ig');
  await refreshConnections(db, p);
  assert.equal(publisherFor(p, 'instagram', { db }), 'zernio');
  p.meta.instagram = { userId: '17841400000000001', auth: 'facebook' };
  process.env.IG_TOKEN_ALPHA = 'tok';
  assert.equal(publisherFor(p, 'instagram', { db }), 'instagram', 'our own Meta app first');
  assert.equal(publisherFor(p, 'tiktok', { db }), 'zernio');
  const own = { ...p, meta: { ...p.meta, publishers: { tiktok: 'own-app', instagram: 'auto' } } };
  assert.equal(publisherFor(own, 'tiktok', { db }), 'dry', 'own-app is kept in code for later, and is not built');
  delete process.env.ZERNIO_API_KEY;
  delete process.env.IG_TOKEN_ALPHA;
  assert.equal(publisherFor(p, 'instagram', { db }), 'dry', 'no key, no Zernio');
});

test('publishing to what the customer connected: TikTok to its drafts, Instagram as a carousel, each with its own Zernio post', async () => {
  const p = pack('alpha');
  process.env.PUBLISH_MODE = 'live';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com';
  await ensureProfile(db, p);
  connected('prof1', 'tiktok', 'tk1', 'alpha.tt');
  connected('prof1', 'instagram', 'ig1', 'alpha.ig');
  await refreshConnections(db, p);
  const id = (await buildPost(ctx, { pack: p, formatKey: 'care-guide' })).postId;
  db.run("UPDATE posts SET status = 'approved', slot_at = ? WHERE id = ?", new Date(TUE).toISOString(), id);

  // Approved: TikTok goes to the inbox as a draft (the owner adds a trending sound and publishes it).
  assert.equal((await sendDraft(ctx, id, { t: TUE - 3_600_000 })).state, 'drafted');
  const draft = Z.posts[0].body;
  assert.deepEqual(draft.platforms, [{ platform: 'tiktok', accountId: 'tk1' }]);
  assert.equal(draft.tiktokSettings.draft, true);
  assert.equal(draft.tiktokSettings.media_type, 'photo');
  assert.ok(draft.mediaItems.length >= 2 && draft.mediaItems.every((m) => m.type === 'image' && m.url.startsWith('https://media.example.com/')));

  // At the slot: Instagram straight out, as a carousel, to the connected account; TikTok is not sent again.
  const r = await publishPost(ctx, id, { t: TUE });
  assert.equal(r.ok, true, r.results?.instagram?.error);
  assert.equal(Z.posts.length, 2);
  const ig = Z.posts[1].body;
  assert.deepEqual(ig.platforms, [{ platform: 'instagram', accountId: 'ig1' }]);
  assert.equal(ig.publishNow, true);
  assert.ok(ig.mediaItems.length >= 2 && ig.mediaItems.length <= 10, 'a carousel');
  assert.equal(ig.tiktokSettings, undefined);
  const post = loadPost(db, id);
  assert.equal(post.publish.instagram.zernioId, Z.posts[1].id);
  assert.equal(post.publish.tiktok.draftId, Z.posts[0].id, "a draft's id is not the post's: nothing is out on TikTok yet");
  assert.equal(post.publish.tiktok.zernioId, undefined);
});

test("per-post numbers: Zernio's answer for one post, a platform still syncing left out, a plan without analytics said once", async () => {
  Z.analytics.z1 = { status: 202, body: { postId: 'z1', status: 'published', syncStatus: 'partial', platformAnalytics: [
    { platform: 'tiktok', syncStatus: 'synced', analytics: { views: 1200, reach: 900, likes: 80, comments: 4, shares: 12, saves: 30, follows: 3, profileViews: 15, websiteClicks: 2, clicks: 0 } },
    { platform: 'instagram', syncStatus: 'pending', analytics: { views: 0 } },
  ] } };
  const got = await zernioAnalytics('z1');
  assert.deepEqual(Object.keys(got), ['tiktok'], 'a platform still syncing is not a zero');
  assert.deepEqual(got.tiktok, { views: 1200, reach: 900, likes: 80, comments: 4, shares: 12, saves: null, linkClicks: 2, follows: 3, profileVisits: 15 });
  Z.analytics.gone = { status: 424, body: { status: 'failed' } };
  assert.equal(await zernioAnalytics('gone'), null);
  Z.analytics.paid = { status: 402, body: { error: 'Analytics add-on required', code: 'analytics_addon_required' } };
  await assert.rejects(() => zernioAnalytics('paid'), (e) => e instanceof ZernioError && e.code === 'analytics_addon_required');

  // Two Zernio posts on one of ours (TikTok published from the owner's draft, Instagram through Zernio): both read.
  const t0 = '2026-10-10T10:00:00.000Z';
  db.insert('posts', { id: 'mz1', account_id: 'alpha', format_id: 'f', status: 'published', published_at: t0, publish_json: { tiktok: { zernioId: '7400000000000000001', flow: { state: 'mine' } }, instagram: { via: 'zernio', zernioId: 'zig1' } }, created_at: t0, updated_at: t0 });
  Z.analytics['7400000000000000001'] = { body: { postId: 'e1', platform: 'tiktok', isExternal: true, syncStatus: 'synced', analytics: { views: 5000, likes: 300, comments: 20, shares: 40 }, platformAnalytics: [{ platform: 'tiktok', syncStatus: 'synced', analytics: { views: 5000, likes: 300, comments: 20, shares: 40 } }] } };
  Z.analytics.zig1 = { body: { postId: 'zig1', platformAnalytics: [{ platform: 'instagram', syncStatus: 'synced', analytics: { views: 2000, reach: 1500, likes: 100, comments: 5, shares: 9, saves: 44, clicks: 3 } }] } };
  const out = await collectMetrics(ctx, { t: Date.parse('2026-10-13T12:00:00Z'), only: ['mz1'] });
  assert.equal(out.got, 2);
  const m = Object.fromEntries(db.all("SELECT * FROM metrics WHERE post_id = 'mz1'").map((r) => [r.platform, r]));
  assert.equal(m.tiktok.views, 5000);
  assert.equal(m.tiktok.saves, null);
  assert.equal(m.instagram.reach, 1500);
  assert.equal(m.instagram.saves, 44);

  db.insert('posts', { id: 'mz2', account_id: 'alpha', format_id: 'f', status: 'published', published_at: t0, publish_json: { tiktok: { zernioId: 'paid' }, instagram: { zernioId: 'paid2' } }, created_at: t0, updated_at: t0 });
  Z.analytics.paid2 = Z.analytics.paid;
  const before = Z.calls.length;
  const o2 = await collectMetrics(ctx, { t: Date.parse('2026-10-13T12:00:00Z'), only: ['mz2'] });
  assert.match(o2.why, /Analytics add-on/);
  assert.equal(Z.calls.length - before, 1, 'one refusal is the answer for every post: not asked again');
});

test("what Zernio bills each account's profile this month, read daily into the ledger next to the API spend", async () => {
  const t = TUE;
  await ensureProfile(db, pack('alpha'));
  await ensureProfile(db, pack('bravo'));
  Z.usage = { supported: true, totals: { total: 12 }, attribution: { groupBy: 'profile', groups: [{ key: 'prof1', totalUsd: 6, byProduct: { accounts: 6 } }, { key: 'handprof', totalUsd: 6 }], totals: { totalUsd: 12 } } };
  const r = await recordCosts(ctx, { t });
  assert.deepEqual([r.supported, r.accounts], [true, 2]);
  const ask = Z.calls.find((c) => c.path === '/usage');
  assert.deepEqual([ask.q.range, ask.q.groupBy, ask.q.from], ['custom', 'profile', `${monthKey(t)}-01`]);
  assert.equal(zernioCost(db, 'alpha', monthKey(t)).usd, 6);
  const q = quotasData(ctx, t);
  assert.equal(q.accounts.find((a) => a.pack.id === 'alpha').zernio[monthKey(t)].usd, 6);

  // A legacy plan has no usage-based invoice to split: nothing is written, nothing is guessed.
  db.run('DELETE FROM zernio_costs');
  Z.usage = { supported: false, days: [] };
  assert.equal((await recordCosts(ctx, { t })).supported, false);
  assert.equal(zernioCost(db, 'alpha', monthKey(t)), null);

  // The runner: each profile's connections once an hour, the bill once a day.
  Z.usage = { supported: true, attribution: { groups: [{ key: 'prof1', totalUsd: 7 }] } };
  const a = await zernioTick(ctx, { t });
  assert.equal(a.checked, 2);
  assert.equal(a.costs.supported, true);
  const b = await zernioTick(ctx, { t: t + 10 * 60_000 });
  assert.deepEqual([b.checked, b.costs], [0, undefined]);
  assert.equal((await zernioTick(ctx, { t: t + 61 * 60_000 })).checked, 2);
  delete process.env.ZERNIO_API_KEY;
  assert.equal(await zernioTick(ctx, { t }), null, 'without a key, nothing');
});

test('signed connect links: that account, that platform, until they expire; the return address is not a connect link', () => {
  const t = TUE;
  const link = connectLink(SECRET, { base: 'https://teder.test', accountId: 'alpha', platform: 'tiktok', t });
  const u = new URL(link);
  assert.equal(u.pathname, '/connect/alpha/tiktok');
  const sig = { e: u.searchParams.get('e'), s: u.searchParams.get('s') };
  assert.equal(connectLinkOk(SECRET, { accountId: 'alpha', platform: 'tiktok', ...sig, t: t + 71 * 3_600_000 }), true);
  assert.equal(connectLinkOk(SECRET, { accountId: 'alpha', platform: 'tiktok', ...sig, t: t + 73 * 3_600_000 }), false, '72 hours');
  assert.equal(connectLinkOk(SECRET, { accountId: 'alpha', platform: 'instagram', ...sig, t }), false);
  assert.equal(connectLinkOk(SECRET, { accountId: 'bravo', platform: 'tiktok', ...sig, t }), false);
  assert.equal(connectLinkOk('x'.repeat(48), { accountId: 'alpha', platform: 'tiktok', ...sig, t }), false);
  assert.equal(doneLinkOk(SECRET, { accountId: 'alpha', platform: 'tiktok', ...sig, t }), false);
  const done = new URL(doneLink(SECRET, { base: 'https://teder.test', accountId: 'alpha', platform: 'tiktok', t }));
  assert.equal(done.pathname, '/connect/alpha/tiktok/done');
  assert.equal(connectLinkOk(SECRET, { accountId: 'alpha', platform: 'tiktok', e: done.searchParams.get('e'), s: done.searchParams.get('s'), t }), false);
});

/* ------------------------------------------------------------------ the website */

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function csrfOf(cookie) {
  const html = await (await get('/accounts', cookie)).text();
  return /name="_csrf" value="([^"]+)"/.exec(html)[1];
}
const form = (p, cookie, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: new URLSearchParams(body).toString() });

test("the account page: each platform's state and its button, which goes on to Zernio's link; another workspace's account is not found", async () => {
  const cookie = fake.session(customer(1)).cookie;
  const page = await (await get('/accounts?account=alpha', cookie)).text();
  assert.match(page, /לחבר את טיקטוק/);
  assert.match(page, /לחבר את אינסטגרם/);
  assert.doesNotMatch(page, /Zernio החודש/, "what Zernio costs us is the operator's");
  const csrf = await csrfOf(cookie);
  const res = await form('/accounts/alpha/connect/tiktok', cookie, { _csrf: csrf });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /http-equiv="refresh" content="0;url=https:\/\/zernio\.com\/connect\/welcome\/tiktok/, 'a page that goes on, not a redirect the CSP would stop');
  const ask = Z.calls.find((c) => c.path === '/connect/tiktok');
  const back = new URL(ask.q.redirect_url);
  assert.equal(back.pathname, '/connect/alpha/tiktok/done');

  // Back from Zernio: what is connected is read from Zernio, whatever the address says.
  connected(ask.q.profileId, 'tiktok', 'tk1', 'alpha.tt');
  const done = await get(`${back.pathname}${back.search}&connected=tiktok&accountId=tk1&username=alpha.tt`);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /טיקטוק מחובר/);
  assert.equal(connectState(db, pack('alpha'), 'tiktok').state, 'connected');
  const after = await (await get('/accounts?account=alpha', cookie)).text();
  assert.match(after, /alpha\.tt/);
  assert.match(after, /לחבר חשבון אחר/);

  const failed = await (await get(`${back.pathname}${back.search}&error=oauth_denied&platform=tiktok&is_user_fixable=true`)).text();
  assert.match(failed, /החיבור לא הצליח/);
  assert.equal((await get(`${back.pathname}?e=${back.searchParams.get('e')}&s=${'0'.repeat(64)}`)).status, 404, 'a forged return address');

  const other = await fetch(`${base}/accounts/bravo/connect/tiktok`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
  assert.equal(other.status, 404, "another workspace's account");
  assert.equal(Z.calls.filter((c) => c.path === '/connect/tiktok').length, 1);
});

test('drafts by default, straight to the profile if the account says so; direct is public', async () => {
  const cookie = fake.session(customer(1)).cookie;
  const csrf = await csrfOf(cookie);
  const res = await fetch(`${base}/accounts/alpha/tiktok`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: csrf, mode: 'direct', via: 'own-app' }).toString() });
  assert.equal(res.status, 200);
  const file = JSON.parse(readFileSync(path.join(pack('alpha').dir, 'pack.json'), 'utf8'));
  assert.equal(file.zernio.tiktokMode, 'direct');
  assert.equal(file.zernio.tiktokPrivacy, 'PUBLIC_TO_EVERYONE');
  assert.equal(file.publishers.tiktok, 'zernio', 'only the operator picks what TikTok is published through');
  await fetch(`${base}/accounts/alpha/tiktok`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: csrf, mode: 'draft-now' }).toString() });
  assert.equal(pack('alpha').meta.zernio.tiktokMode, 'draft-now');
});

/* ------------------------------------------------------------------ the WhatsApp assistant */

async function call(p) {
  const sig = signature(SECRET, { dir: DIR.in, method: 'GET', path: p, body: '' });
  const res = await fetch(`${base}${p}`, { headers: { 'x-of-signature': sig } });
  return { status: res.status, body: await res.json() };
}

test('the assistant gets a "tap here to connect" link per platform, that opens Zernio at the tap; a broken connection is told once, with a fresh link', async () => {
  const r = await call('/internal/assistant/customers/1/accounts/alpha/connect');
  assert.equal(r.status, 200);
  const tk = r.body.platforms.find((x) => x.platform === 'tiktok');
  assert.equal(tk.state, 'none');
  const u = new URL(tk.url);
  assert.equal(u.pathname, '/connect/alpha/tiktok');
  assert.equal((await call('/internal/assistant/customers/1/accounts/bravo/connect')).status, 404, "another customer's account");

  // The customer taps it on their phone: no session, the signature is the permission, and on to a fresh Zernio link.
  const tap = await get(`${u.pathname}${u.search}`);
  assert.equal(tap.status, 302);
  assert.match(tap.headers.get('location'), /^https:\/\/zernio\.com\/connect\/welcome\/tiktok/);
  assert.equal((await get(`${u.pathname}?e=${u.searchParams.get('e')}&s=${'a'.repeat(64)}`)).status, 404);

  // Connected, then the token expires.
  connected('prof1', 'tiktok', 'tk1', 'alpha.tt');
  await refreshConnections(db, pack('alpha'), { t: TUE });
  assert.equal((await call('/internal/assistant/customers/1/accounts/alpha/connect')).body.platforms.find((x) => x.platform === 'tiktok').url, null, 'nothing to connect');
  Z.health.tk1 = { tokenValid: false, needsReconnect: true, canPost: false, issues: ['Token expired'] };
  await refreshConnections(db, pack('alpha'), { t: TUE + 60_000 });
  const found = detect(ctx, { t: TUE + 120_000 });
  assert.equal(found['account.reconnect'], 1);
  assert.equal(detect(ctx, { t: TUE + 180_000 })['account.reconnect'], undefined, 'once per break');
  const row = db.get("SELECT * FROM assistant_events WHERE type = 'account.reconnect'");
  assert.equal(row.workspace_id, 1);
  const data = payloadOf(ctx, row, { secret: SECRET, base: 'https://teder.test', t: TUE + 120_000 });
  assert.equal(data.platform, 'tiktok');
  assert.equal(data.username, 'alpha.tt');
  assert.match(data.connectUrl, /^https:\/\/teder\.test\/connect\/alpha\/tiktok\?e=\d+&s=[0-9a-f]{64}$/);

  // Fixed before the message went out: it is no longer true, and it is not sent.
  delete Z.health.tk1;
  await refreshConnections(db, pack('alpha'), { t: TUE + 150_000 });
  assert.equal(payloadOf(ctx, row, { secret: SECRET, base: 'https://teder.test', t: TUE + 160_000 }), null);
  assert.equal(profileIdOf(db, pack('alpha')), 'prof1');
});

test("an event the assistant refuses (400: a type it does not take yet) is failed once and holds nothing behind it", async () => {
  db.run("DELETE FROM assistant_events");
  await ensureProfile(db, pack('alpha'));
  connected('prof1', 'tiktok', 'tk1', 'alpha.tt');
  connected('prof1', 'instagram', 'ig1', 'alpha.ig');
  await refreshConnections(db, pack('alpha'), { t: TUE });
  Z.health = { tk1: { needsReconnect: true, tokenValid: false, issues: ['Token expired'] }, ig1: { needsReconnect: true, tokenValid: false, issues: ['Token expired'] } };
  await refreshConnections(db, pack('alpha'), { t: TUE + 60_000 });
  assert.equal(detect(ctx, { t: TUE + 120_000 })['account.reconnect'], 2);
  const got = [];
  let refused = false;
  const send = async (_url, { body, type }) => {
    if (type !== 'account.reconnect') return { status: 200 };
    got.push(JSON.parse(body));
    if (refused) return { status: 200 };
    refused = true;
    return { status: 400 };
  };
  const out = await deliver(ctx, { t: TUE + 120_000, env: { OF_ASSISTANT_SECRET: SECRET, OF_TORAN_URL: 'http://127.0.0.1:1/internal/teder/events' }, send });
  assert.equal(got.length, 2, 'the refusal did not hold the next one');
  assert.equal(out.failed, 1);
  const states = db.all("SELECT state, last_error FROM assistant_events WHERE type = 'account.reconnect' ORDER BY id").map((r) => [r.state, r.last_error]);
  assert.deepEqual(states, [['failed', 'HTTP 400'], ['sent', null]]);
  // A down assistant still holds the queue and tries again later.
  const out2 = await deliver(ctx, { t: TUE + 180_000, env: { OF_ASSISTANT_SECRET: SECRET }, send: async () => ({ status: 503 }) });
  assert.equal(out2.failed, 0, 'nothing left to send');
});
