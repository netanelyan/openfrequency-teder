import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { publishPost, sendDraft } from '../src/publish/index.js';
import { heldReason, needsConnection, releaseHeld, unconnectedPlatforms } from '../src/publish/hold.js';
import { connectErrorHe, publishErrorHe } from '../src/publish/errors.js';
import { ZernioError } from '../src/publish/zernio.js';
import { publishErrorStreak } from '../src/autonomy/rails.js';
import { tick } from '../src/autonomy/runner.js';
import { setSetting } from '../src/core/store.js';
import { israelDate, israelInstant } from '../src/schedule/israel.js';
import { doneLink } from '../src/publish/connect.js';
import { closeBrowser } from '../src/render/render.js';
import { fakeAccounts, opened, operator, tempHome } from './helpers.js';

// A post approved for a platform the customer has not connected waits for the connection instead of failing in English
// and pausing the account after three tries. The website says what to connect and what each platform needs; once one
// is connected, what waited goes out at the account's next free slots. What a customer reads of a failure is Hebrew.
//
// alpha publishes to TikTok and Instagram through Zernio, live, and nothing is connected yet.

const SECRET = 'h'.repeat(48);
const realFetch = globalThis.fetch;
let home;
let ctx;
let db;
let fake;
let server;
let base;
let Z;

const TUE = (hm) => israelInstant('2026-10-13', hm).getTime();

function fakeZernio() {
  const st = { calls: [], fail: null };
  st.handle = (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    st.calls.push({ method, path: u.pathname.replace(/^\/api\/v1/, ''), body });
    const reply = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && u.pathname === '/api/v1/posts') {
      if (st.fail) return reply(st.fail.status, st.fail.body);
      const pl = body.platforms[0].platform;
      return reply(201, { post: { _id: `zp${st.calls.length}`, status: 'published', platforms: [{ platform: pl, status: 'published', platformPostId: `${pl}-1`, platformPostUrl: `https://www.${pl}.com/p/1` }] } });
    }
    return reply(404, { error: 'no such endpoint' });
  };
  return st;
}

before(async () => {
  home = tempHome({
    packs: {
      alpha: (f) => {
        delete f.pack.publisher;
        f.pack.publishers = { tiktok: 'zernio', instagram: 'zernio' };
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  globalThis.fetch = async (url, init) => (new URL(String(url)).hostname === 'zernio.com' ? Z.handle(url, init) : realFetch(url, init));
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'h'.repeat(40), OF_ASSISTANT_SECRET: SECRET, ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

beforeEach(() => {
  Z = fakeZernio();
  Object.assign(process.env, { ZERNIO_API_KEY: 'zk_test_key', PUBLISH_MODE: 'live', MEDIA_PUBLIC_BASE_URL: 'https://media.test/p' });
  db.run('DELETE FROM zernio_connections');
  db.run("UPDATE accounts SET status = 'active', paused_reason = NULL, paused_detail = NULL");
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ['ZERNIO_API_KEY', 'PUBLISH_MODE', 'MEDIA_PUBLIC_BASE_URL']) delete process.env[k];
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const pack = () => ctx.pack('alpha');
const connect = (platform) => db.insert('zernio_connections', { account_id: 'alpha', platform, zernio_account_id: `z-${platform}`, username: `alpha.${platform}`, status: 'connected', connected_at: new Date().toISOString(), checked_at: new Date().toISOString() });
async function approvedPost(slot) {
  const id = (await buildPost(ctx, { pack: pack(), formatKey: 'care-guide' })).postId;
  db.run("UPDATE posts SET status = 'approved', approved_by = 'owner', slot_at = ? WHERE id = ?", new Date(slot).toISOString(), id);
  return id;
}

test('nothing connected: approved posts wait, untried, and never pause the account', async () => {
  assert.deepEqual(unconnectedPlatforms(db, pack()), ['tiktok', 'instagram']);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await approvedPost(TUE('12:40')));
  // The TikTok draft that draft-now sends at approval is not tried: it could only fail.
  const d = await sendDraft(ctx, ids[0], { t: TUE('12:00') });
  assert.deepEqual([d.state, d.code], ['held', 'not_connected']);
  for (const id of ids) {
    const r = await publishPost(ctx, id, { t: TUE('12:45') });
    assert.deepEqual([r.ok, r.held], [false, true]);
    const p = loadPost(db, id);
    assert.equal(p.status, 'held');
    assert.equal(p.reason, heldReason(['tiktok', 'instagram']));
    assert.doesNotMatch(p.reason, /[A-Za-z]/, 'Hebrew, no Zernio and no pack.json');
  }
  assert.equal(Z.calls.length, 0, 'nothing went to Zernio');
  assert.equal(publishErrorStreak(db, 'alpha'), 0, 'held is not failed');
  assert.equal(db.get("SELECT status FROM accounts WHERE id = 'alpha'").status, 'active', 'three of them pause nothing');

  // The website says what to connect, how many wait, and where; the connect panel says what each platform needs.
  const cookie = fake.session(operator()).cookie;
  const today_ = await (await fetch(`${base}/?account=alpha`, { headers: { cookie } })).text();
  assert.match(today_, /כדי שהמצגות יעלו, מחברים את טיקטוק ואת אינסטגרם/);
  assert.match(today_, /3 מצגות מאושרות מחכות לחיבור/);
  assert.match(today_, /href="\/accounts\?account=alpha#connect-alpha"/);
  const acc = await (await fetch(`${base}/accounts?account=alpha`, { headers: { cookie } })).text();
  assert.match(acc, /אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר/);
  assert.match(acc, /המצגות מגיעות לטיוטות בטיקטוק בכוונה, כדי שתבחרו סאונד פופולרי ותפרסמו משם/);
  assert.match(acc, /תדר מזכיר לכם/);

  // Still nothing connected: the runner leaves them.
  assert.deepEqual(releaseHeld(db, pack(), { t: TUE('12:50') }), []);
  // One connected: each held post gets the next free slot, the earliest first, and goes out there.
  connect('instagram');
  assert.deepEqual(unconnectedPlatforms(db, pack()), ['tiktok']);
  const today = israelDate(TUE('12:50'));
  for (const k of ['generated', 'feedback', 'topics']) setSetting(db, `${k}:alpha:${today}`, new Date().toISOString());
  const r = await tick(ctx, { t: TUE('12:50') });
  const back = r.released.map((x) => x.slotAt);
  assert.equal(back.length, 3);
  assert.deepEqual(back, [...back].sort(), 'in order');
  assert.equal(new Set(back).size, 3, 'one post a slot');
  assert.ok(back.every((s) => Date.parse(s) > TUE('12:50')), 'all ahead');
  assert.equal(back[0], israelInstant('2026-10-13', '19:40').toISOString(), "today's next slot first");
  for (const id of ids) assert.equal(loadPost(db, id).status, 'approved');

  // At its slot: Instagram goes, TikTok is skipped until it is connected; the post is out.
  const first = db.get("SELECT id FROM posts WHERE account_id = 'alpha' AND status = 'approved' ORDER BY slot_at LIMIT 1").id;
  const out = await publishPost(ctx, first, { t: TUE('19:41') });
  assert.equal(out.ok, true);
  const p = loadPost(db, first);
  assert.equal(p.status, 'published');
  assert.deepEqual([p.publish.instagram.via, p.publish.tiktok.skipped], ['zernio', 'not_connected']);
  assert.deepEqual(Z.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body.platforms[0].platform]), [['POST', '/posts', 'instagram']]);
});

test('a failure the customer reads is Hebrew; the publisher\'s own words stay in the post\'s steps', async () => {
  connect('instagram');
  connect('tiktok');
  db.run("DELETE FROM posts WHERE account_id = 'alpha'");
  const id = await approvedPost(TUE('12:40'));
  pack().meta.zernio = { ...(pack().meta.zernio || {}), tiktokMode: 'direct' };
  try {
    Z.fail = { status: 500, body: { error: { message: 'Internal upstream failure from TikTok API', code: 'upstream_error' } } };
    const r = await publishPost(ctx, id, { t: TUE('12:45') });
    assert.equal(r.ok, false);
    const p = loadPost(db, id);
    assert.equal(p.status, 'failed');
    assert.match(p.reason, /המצגת לא עלתה לטיקטוק/);
    assert.doesNotMatch(p.reason, /[A-Za-z]/);
    const s = db.get("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'publish' ORDER BY id DESC LIMIT 1", id);
    assert.match(s.detail_json, /Internal upstream failure/, 'the operator still reads what Zernio said');
  } finally {
    delete pack().meta.zernio.tiktokMode;
  }
});

test('the words: every known error and the general one are Hebrew, with what to do next', () => {
  const cases = [
    [new ZernioError('x', { code: 'no_account' }), 'tiktok', /לא מחובר/],
    [new ZernioError('x', { code: 'not_configured' }), 'tiktok', /לא זמין/],
    [new ZernioError('x', { code: 'card_images' }), 'instagram', /עד 10 תמונות/],
    [new ZernioError('token expired', { status: 401 }), 'instagram', /מחברים אותו מחדש/],
    [new ZernioError('x', { category: 'user_content', code: 'user_content' }), 'tiktok', /הכללים שלו/],
    [new ZernioError('rate limit exceeded', { status: 429 }), 'tiktok', /לחכות/],
    [Object.assign(new Error('timed out: https://zernio.com'), { code: 'network' }), 'tiktok', /להגיע/],
    [new Error('something nobody expected'), 'instagram', /המצגת לא עלתה לאינסטגרם/],
  ];
  for (const [e, platform, re] of cases) {
    const he = publishErrorHe(e, platform);
    assert.match(he, re, e.message);
    assert.doesNotMatch(he, /[A-Za-z—–]/, e.message);
  }
  for (const [args, re] of [
    [{ error: 'access_denied' }, /בוטל/],
    [{ error: 'invalid_account_type', message: 'Instagram personal accounts are not supported, use a Business or Creator account' }, /חשבון מקצועי/],
    [{ error: 'missing_permissions', message: 'scope instagram_business_content_publish not granted' }, /הרשאה/],
    [{ error: 'state_expired' }, /עבר יותר מדי זמן/],
    [{ error: 'weird_unknown_code' }, /לא אישר את החיבור/],
  ]) {
    const he = connectErrorHe('instagram', args);
    assert.match(he, re, args.error);
    assert.doesNotMatch(he, /[A-Za-z—–]/, args.error);
  }
  assert.equal(needsConnection(db, pack(), 'tiktok', { PUBLISH_MODE: 'dry' }), false, 'a dry run is written to disk, never held');
});

test("back from Zernio with an error: the customer reads it in Hebrew, Zernio's code goes to the audit", async () => {
  const link = new URL(doneLink(SECRET, { base, accountId: 'alpha', platform: 'instagram' }));
  link.searchParams.set('error', 'invalid_account_type');
  link.searchParams.set('error_message', 'Personal accounts cannot be connected, switch to a Business or Creator account');
  const res = await fetch(link, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /חשבון מקצועי, עסקי או יוצר/);
  assert.doesNotMatch(html, /invalid_account_type/, 'no code on the page');
  assert.ok(db.get("SELECT id FROM audit WHERE action = 'zernio_connect_failed' AND detail_json LIKE '%invalid_account_type%'"));
});
