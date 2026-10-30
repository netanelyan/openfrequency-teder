import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { now, setNow } from '../src/core/clock.js';
import { israelInstant } from '../src/schedule/israel.js';
import { DIR, signature, verify, mediaLink } from '../src/assistant/sign.js';
import { prefsOf, setPrefs } from '../src/assistant/data.js';
import { assistantTick, deliver, detect, quietUntil, UNPOSTED_MIN } from '../src/assistant/events.js';
import { fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// The WhatsApp assistant's door (src/assistant): signed requests and nothing else, each once; one customer never
// reaches another's posts; the quota and the redos counted as the website counts them; and the events, found once,
// held through quiet hours, signed on the way out.
//
// Two customers on one server: alpha is workspace 1's, bravo workspace 2's.

const SECRET = 'a'.repeat(48);
const ENV = { OF_ASSISTANT_SECRET: SECRET };
let home;
let ctx;
let db;
let fake;
let server;
let handler;
let port;
let base;
const A = {};
const B = {};

before(async () => {
  home = tempHome({
    packs: {
      alpha: null,
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
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  // Both customers have paid (src/billing/entitlement.js): the assistant's approvals reach the engine.
  paidWorkspaces(db, [1, 2]);
  A.post = (await buildPost(ctx, { pack: ctx.pack('alpha'), formatKey: 'care-guide' })).postId;
  B.post = (await buildPost(ctx, { pack: ctx.pack('bravo'), formatKey: 'care-guide' })).postId;
  assert.equal(loadPost(db, A.post).status, 'queued');
  assert.equal(loadPost(db, B.post).status, 'queued');
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'w'.repeat(40), ...fake.env, ...ENV } });
  server = s.server;
  handler = s.handler;
  port = s.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (handler) await Promise.all(handler.assistant.jobs);
  await new Promise((r) => (server ? server.close(r) : r()));
  await fake?.close();
  await closeBrowser();
  home.cleanup();
});

afterEach(() => setNow(null));

/** A request as the assistant signs it. `sign` overrides any part of the signature; `raw` sends other bytes than were signed. */
async function call(method, p, body = null, { secret = SECRET, sign = {}, raw = null, headers = {}, header = undefined } = {}) {
  const text = body == null ? '' : JSON.stringify(body);
  const sig = header !== undefined ? header : signature(secret, { dir: DIR.in, method, path: p, body: text, ...sign });
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(sig ? { 'x-of-signature': sig } : {}), ...headers }, body: method === 'GET' ? undefined : (raw ?? text) });
  return { status: res.status, body: await res.json().catch(() => null), sig };
}

/** The same through node:http, which may name any Host and any header (fetch keeps Host to itself). */
function rawCall(p, headers) {
  return new Promise((resolve, reject) => {
    const sig = signature(SECRET, { dir: DIR.in, method: 'GET', path: p, body: '' });
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { 'x-of-signature': sig, ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

let n = 0;
/**
 * A copy of a drafted post, waiting for its customer, with its slides and facts (the demo pack has few documents, and
 * a draft from a used one is blocked). Created at the clock's now.
 */
function clone(fromId, accountId = null, patch = {}) {
  const src = db.get('SELECT * FROM posts WHERE id = ?', fromId);
  const id = `${fromId}c${++n}`;
  const at = new Date(now()).toISOString();
  const { id: _i, ...rest } = src;
  db.insert('posts', { ...rest, id, account_id: accountId || src.account_id, status: 'queued', created_at: at, updated_at: at, publish_json: null, reject_json: null, approved_at: null, approved_by: null, published_at: null, quota_month: null, ...patch });
  for (const table of ['slides', 'facts']) {
    for (const row of db.all(`SELECT * FROM ${table} WHERE post_id = ?`, fromId)) {
      const { id: _r, ...r } = row;
      db.insert(table, { ...r, post_id: id });
    }
  }
  return id;
}

const by = { name: 'דנה', userId: 101 };
const c1 = (rest) => `/internal/assistant/customers/1/${rest}`;
const c2 = (rest) => `/internal/assistant/customers/2/${rest}`;

/* ------------------------------------------------------------------ signing */

test('a request is answered only when it is signed with the secret, for this direction, this body and now', async () => {
  const p = c1('posts/pending');
  assert.equal((await call('GET', p)).status, 200);

  const none = await call('GET', p, null, { header: null });
  assert.deepEqual([none.status, none.body.error], [401, 'bad_signature']);
  assert.equal((await call('GET', p, null, { header: 't=1,n=xxxxxxxxxxxxxxxx,s=nothex' })).status, 401);
  assert.equal((await call('GET', p, null, { secret: 'b'.repeat(48) })).body.error, 'bad_signature', 'another secret');
  assert.equal((await call('GET', p, null, { sign: { dir: DIR.out } })).body.error, 'bad_signature', "signed for Teder's own events, not for a request");
  assert.equal((await call('GET', p, null, { sign: { path: c2('posts/pending') } })).body.error, 'bad_signature', 'signed for another customer');
  const stale = await call('GET', p, null, { sign: { t: Math.floor(Date.now() / 1000) - 600 } });
  assert.deepEqual([stale.status, stale.body.error], [401, 'stale']);
  assert.equal((await call('GET', p, null, { sign: { t: Math.floor(Date.now() / 1000) + 600 } })).body.error, 'stale', 'from the future too');

  // The body is signed: the same signature over other bytes is refused, and nothing is changed.
  const tampered = await call('POST', c1(`posts/${A.post}/approve`), { by }, { raw: JSON.stringify({ by: { name: 'מישהו אחר' } }) });
  assert.deepEqual([tampered.status, tampered.body.error], [401, 'bad_signature']);
  assert.equal(loadPost(db, A.post).status, 'queued');
});

test('the same signed request is refused the second time, also after a restart', async () => {
  const p = c1('status');
  const first = await call('GET', p);
  assert.equal(first.status, 200);
  const again = await call('GET', p, null, { header: first.sig });
  assert.deepEqual([again.status, again.body.error], [401, 'replay']);

  // A second server on the same database (a restart) knows the nonce too.
  const s2 = await listen(ctx, { port: 0, env: { ...process.env, ...fake.env, ...ENV } });
  try {
    const res = await fetch(`http://127.0.0.1:${s2.port}${p}`, { headers: { 'x-of-signature': first.sig } });
    assert.deepEqual([res.status, (await res.json()).error], [401, 'replay']);
  } finally {
    await new Promise((r) => s2.server.close(r));
  }

  // A nonce is kept only once its signature holds: a forged request cannot use up the assistant's next nonce.
  const nonce = 'n'.repeat(24);
  assert.equal((await call('GET', p, null, { secret: 'b'.repeat(48), sign: { nonce } })).body.error, 'bad_signature');
  assert.equal((await call('GET', p, null, { sign: { nonce } })).status, 200);
});

test('the API is never answered through the proxy, under the public name or without the secret', async () => {
  const p = c1('posts/pending');
  assert.equal((await rawCall(p, { host: `127.0.0.1:${port}` })).status, 200, 'straight from this machine');
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }]) {
    assert.equal((await rawCall(p, { host: `127.0.0.1:${port}`, ...h })).status, 404, JSON.stringify(h));
  }
  // Under the public name, as the proxy would pass it on.
  const s2 = await listen(ctx, { port: 0, env: { ...process.env, ...fake.env, ...ENV, PUBLIC_HOST: 'teder.test' } });
  try {
    const res = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s2.port, path: p, headers: { host: 'teder.test', 'x-forwarded-proto': 'https', 'x-of-signature': signature(SECRET, { dir: DIR.in, method: 'GET', path: p, body: '' }) } }, resolve);
      req.end();
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await new Promise((r) => s2.server.close(r));
  }
  // No secret, no API.
  const s3 = await listen(ctx, { port: 0, env: { ...process.env, ...fake.env, OF_ASSISTANT_SECRET: '' } });
  try {
    const res = await fetch(`http://127.0.0.1:${s3.port}${p}`, { headers: { 'x-of-signature': signature(SECRET, { dir: DIR.in, method: 'GET', path: p, body: '' }) } });
    assert.deepEqual([res.status, (await res.json()).error], [503, 'not_configured']);
  } finally {
    await new Promise((r) => s3.server.close(r));
  }
});

/* ------------------------------------------------------------------ one customer, never another */

test("one customer never sees or touches another's posts", async () => {
  const mine = await call('GET', c1('posts/pending'));
  assert.deepEqual(mine.body.posts.map((p) => p.id), [A.post]);
  assert.deepEqual(new Set(mine.body.posts.map((p) => p.account.id)), new Set(['alpha']));
  const theirs = await call('GET', c2('posts/pending'));
  assert.deepEqual(theirs.body.posts.map((p) => p.id), [B.post]);

  // Customer 1 names B's post on every route: not found, the same answer as a post that never was.
  const before = db.get('SELECT status, hook, updated_at FROM posts WHERE id = ?', B.post);
  for (const [method, rest, body] of [
    ['POST', `posts/${B.post}/approve`, { by }],
    ['POST', `posts/${B.post}/reject`, { by, reason: 'topic' }],
    ['POST', `posts/${B.post}/edit`, { by, slide: 1, newText: 'כותרת אחרת' }],
    ['GET', `posts/${B.post}/bundle`, null],
    ['POST', 'posts/no-such-post/approve', { by }],
  ]) {
    const r = await call(method, c1(rest), body);
    assert.deepEqual([r.status, r.body.error], [404, 'not_found'], `${method} ${rest}`);
  }
  assert.deepEqual(db.get('SELECT status, hook, updated_at FROM posts WHERE id = ?', B.post), before, "B's post is as it was");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit WHERE post_id = ?", B.post).n, 0);

  // A customer with no accounts here has nothing, and a status names only the customer's own accounts.
  assert.deepEqual((await call('GET', '/internal/assistant/customers/99/posts/pending')).body.posts, []);
  assert.deepEqual((await call('GET', '/internal/assistant/customers/99/status')).body.accounts, []);
  assert.deepEqual((await call('GET', c1('status'))).body.accounts.map((a) => a.account.id), ['alpha']);

  // A slide link opens that slide alone, until it expires: B's post with A's signature does not open.
  const link = mine.body.posts[0].slides[0].image;
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/m\//);
  const img = await fetch(link);
  assert.deepEqual([img.status, img.headers.get('content-type')], [200, 'image/jpeg']);
  assert.equal((await fetch(link.replace(A.post, B.post))).status, 404);
  assert.equal((await fetch(link.replace(/s=[0-9a-f]+/, `s=${'0'.repeat(64)}`))).status, 404);
  const old = mediaLink(SECRET, { base, postId: A.post, platform: 'tiktok', idx: 0, t: Date.now() - 2 * 86_400_000 });
  assert.equal((await fetch(old)).status, 404, 'an expired link');
});

/* ------------------------------------------------------------------ the buttons */

test('approve, edit and the ready-to-post bundle, each recorded as the person via WhatsApp', async () => {
  const id = clone(A.post);
  const notYet = await call('GET', c1(`posts/${id}/bundle`));
  assert.deepEqual([notYet.status, notYet.body.error], [409, 'not_approved']);

  // A light edit of one slide: the cover's headline. Checked, drawn again, every other text as it was.
  const was = loadPost(db, id);
  const item = was.slides.findIndex((s) => s.kind === 'item');
  const other = was.slides.findIndex((s, i) => s.kind === 'item' && i !== item);
  const tooLong = await call('POST', c1(`posts/${id}/edit`), { by, slide: 1, newText: 'א'.repeat(91) });
  assert.deepEqual([tooLong.status, tooLong.body.error], [422, 'too_long']);
  assert.equal((await call('POST', c1(`posts/${id}/edit`), { by, slide: was.slides.length + 1, newText: 'x' })).body.error, 'bad_slide');
  assert.equal((await call('POST', c1(`posts/${id}/edit`), { slide: 1, newText: 'x' })).body.error, 'no_actor', 'nobody named');
  const e = await call('POST', c1(`posts/${id}/edit`), { by, slide: item + 1, field: 'title', newText: was.slides[other].title });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const edited = loadPost(db, id);
  assert.equal(edited.slides[item].title, was.slides[other].title);
  assert.equal(edited.hook, was.hook);
  assert.equal(e.body.post.slides[item].title, was.slides[other].title);
  assert.equal(db.get("SELECT user_id FROM edits WHERE post_id = ? AND field = 'title'", id).user_id, 101);

  const a = await call('POST', c1(`posts/${id}/approve`), { by });
  assert.deepEqual([a.status, a.body.post.status], [200, 'approved']);
  assert.equal((await call('POST', c1(`posts/${id}/approve`), { by })).status, 409, 'approved already');
  await Promise.all(handler.assistant.jobs);

  for (const action of ['approve', 'edit']) {
    const row = db.get('SELECT actor, detail_json FROM audit WHERE post_id = ? AND action = ?', id, action);
    assert.equal(row.actor, 'דנה');
    assert.equal(JSON.parse(row.detail_json).via, 'whatsapp', action);
  }
  const trace = db.all("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'whatsapp' ORDER BY id", id).map((s) => JSON.parse(s.detail_json));
  assert.deepEqual(trace.map((s) => [s.action, s.by, s.via]), [['edit', 'דנה', 'whatsapp'], ['approve', 'דנה', 'whatsapp']]);

  const b = await call('GET', c1(`posts/${id}/bundle`));
  assert.equal(b.status, 200);
  const tk = b.body.post.platforms.tiktok;
  assert.ok(tk.images.length >= 5);
  assert.ok(tk.caption && !/#/.test(tk.caption), 'the caption without its hashtags');
  assert.deepEqual(tk.hashtags, loadPost(db, id).hashtags);
  assert.ok(tk.text.startsWith(tk.caption) && tk.hashtags.every((h) => tk.text.includes(h)), 'and all of it as it goes out');
  assert.equal((await fetch(tk.images.at(-1))).status, 200);
});

test('a rejection uses a redo per the quota, as on the website, and the status counts it', async () => {
  // A customer's month is their workspace's plan, from accounts (src/budget/quota.js): one redo.
  paidWorkspaces(db, [2], { plan: { name: 'full', slideshows: 40, redos: 1 } });
  const first = (await call('GET', c2('posts/pending'))).body.posts[0];
  const r = await call('POST', c2(`posts/${first.id}/reject`), { by, reason: 'shorter', freeText: 'שלוש שורות לכל היותר' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.post.status, r.body.redo], ['rejected', 'writing']);
  assert.deepEqual([r.body.quota.redos.held, r.body.quota.redos.left], [1, 0], 'the replacement holds the redo while it is written');
  assert.equal((await call('POST', c2(`posts/${first.id}/reject`), { by, reason: 'shorter' })).status, 409, 'rejected already');
  await Promise.all(handler.assistant.jobs);

  const old = loadPost(db, first.id);
  assert.equal(old.reject.redo, 'queued');
  assert.equal(old.reject.note, 'שלוש שורות לכל היותר');
  const replacement = old.reject.replacement;
  const pending = (await call('GET', c2('posts/pending'))).body.posts;
  assert.deepEqual(pending.map((p) => p.id), [replacement], 'the replacement waits in its place');

  const st = (await call('GET', c2('status'))).body.accounts[0];
  assert.deepEqual([st.quota.redos.used, st.quota.redos.limit, st.quota.redos.left], [1, 1, 0]);
  assert.equal(st.quota.suggestions.used, 1, 'the replacement is a redo, never a suggestion');
  assert.equal(st.quota.suggestions.limit, 40);
  assert.ok(st.week && 'views' in st.week && 'best' in st.week);

  // The redos are used up: the next rejection only discards the post.
  const again = await call('POST', c2(`posts/${replacement}/reject`), { by, reason: 'tone' });
  assert.deepEqual([again.body.redo, again.body.quota.redos.left], ['none', 0]);
  await Promise.all(handler.assistant.jobs);
  assert.deepEqual((await call('GET', c2('posts/pending'))).body.posts, []);
  assert.equal((await call('POST', c2(`posts/${replacement}/reject`), { by, reason: 'nonsense' })).body.error, 'bad_reason');
  assert.equal(JSON.parse(db.get("SELECT detail_json FROM audit WHERE post_id = ? AND action = 'reject'", first.id).detail_json).via, 'whatsapp');
});

test('a customer turns each message on or off and sets quiet hours', async () => {
  const got = await call('GET', c1('settings'));
  assert.equal(Object.values(got.body.events).every(Boolean), true);
  assert.deepEqual(got.body.quiet, { nights: true, shabbat: true });
  const set = await call('POST', c1('settings'), { by, events: { 'post.reminder': false }, quiet: { nights: false } });
  assert.equal(set.status, 200);
  assert.deepEqual([set.body.events['post.reminder'], set.body.events['post.ready'], set.body.quiet.nights, set.body.quiet.shabbat], [false, true, false, true]);
  assert.equal((await call('POST', c1('settings'), { by, events: { 'post.nope': true } })).body.error, 'bad_settings');
  assert.equal(prefsOf(db, 2).events['post.reminder'], true, "another customer's are their own");
  setPrefs(db, 1, { events: { 'post.reminder': true }, quiet: { nights: true } });
});

/* ------------------------------------------------------------------ events */

test('quiet hours: nights from 22:00 to 08:00, Shabbat and the festivals until nightfall, each as the customer chose', () => {
  const both = { nights: true, shabbat: true };
  const tue23 = israelInstant('2026-10-27', '23:00').getTime();
  assert.equal(quietUntil(tue23, both), israelInstant('2026-10-28', '08:00').getTime());
  assert.equal(quietUntil(israelInstant('2026-10-28', '07:59').getTime(), both), israelInstant('2026-10-28', '08:00').getTime());
  assert.equal(quietUntil(israelInstant('2026-10-28', '08:00').getTime(), both), null);
  assert.equal(quietUntil(tue23, { nights: false, shabbat: true }), null);
  // Shabbat: from before candle lighting on Friday to after nightfall on Saturday, which is past 08:00 Saturday.
  const fri = israelInstant('2026-10-30', '17:30').getTime();
  const end = quietUntil(fri, both);
  assert.ok(end > israelInstant('2026-10-31', '17:30').getTime() && end < israelInstant('2026-10-31', '19:30').getTime(), new Date(end).toISOString());
  assert.equal(quietUntil(israelInstant('2026-10-31', '12:00').getTime(), { nights: true, shabbat: false }), null);
});

const TUE = israelInstant('2026-10-27', '10:00').getTime();

/** A sender that keeps what it was given, and checks every signature as the assistant would. */
function catcher(status = 200) {
  const got = [];
  const send = async (url, { secret, body, type }) => {
    got.push({ url, type, body: JSON.parse(body), raw: body, secret });
    return { status };
  };
  return { got, send };
}

test('events are found once, sent signed for the assistant, and say what is true when they go', async () => {
  setNow(TUE);
  const id = clone(A.post);
  db.update('posts', id, { slot_at: new Date(TUE + 3 * 3_600_000).toISOString() });
  const c = catcher();
  const r = await assistantTick(ctx, { t: TUE, env: ENV, send: c.send });
  assert.ok(r.found['post.ready'] >= 1);
  const ready = c.got.find((g) => g.type === 'post.ready' && g.body.data.post.id === id);
  assert.ok(ready, 'post.ready sent');
  assert.equal(ready.body.customer, 1);
  assert.equal(ready.body.data.post.account.id, 'alpha');
  assert.match(ready.body.data.post.slides[0].image, /\/m\//);
  assert.ok(!c.got.some((g) => g.body.customer === 2 && g.body.data.post?.account?.id === 'alpha'));
  assert.equal(ready.url, 'http://127.0.0.1:4710/internal/teder/events');

  // The webhook is signed one way: the assistant's check passes, a request's check (toran->teder) does not.
  const header = signature(SECRET, { dir: DIR.out, method: 'POST', path: '/internal/teder/events', body: ready.raw });
  assert.equal(verify(db, SECRET, { header, method: 'POST', path: '/internal/teder/events', body: ready.raw, dir: DIR.out, t: TUE }).ok, true);
  const asRequest = signature(SECRET, { dir: DIR.out, method: 'POST', path: '/internal/teder/events', body: ready.raw });
  assert.equal(verify(db, SECRET, { header: asRequest, method: 'POST', path: '/internal/teder/events', body: ready.raw, dir: DIR.in, t: TUE }).error, 'bad_signature');

  // Found once: the next ticks send nothing new about it.
  const c2x = catcher();
  await assistantTick(ctx, { t: TUE + 60_000, env: ENV, send: c2x.send });
  assert.ok(!c2x.got.some((g) => g.type === 'post.ready' && g.body.data.post.id === id));

  // At the slot: approved, its TikTok draft in the app. The reminder says it waits in the drafts, with the sound.
  const slot = TUE + 3 * 3_600_000;
  db.update('posts', id, { status: 'approved', publish_json: { tiktok: { via: 'zernio', draftId: 'd1', flow: { mode: 'now', state: 'waiting', sentAt: new Date(TUE).toISOString(), slotAt: new Date(slot).toISOString(), sound: { name: 'שיר', artist: 'זמר' } } } } });
  const c3 = catcher();
  await assistantTick(ctx, { t: slot + 60_000, env: ENV, send: c3.send });
  const rem = c3.got.find((g) => g.type === 'post.reminder');
  assert.deepEqual([rem.body.data.post.id, rem.body.data.delivery, rem.body.data.sound.name], [id, 'drafts', 'שיר']);

  // An hour on, still not out: unposted.
  const c4 = catcher();
  await assistantTick(ctx, { t: slot + UNPOSTED_MIN * 60_000 + 60_000, env: ENV, send: c4.send });
  const un = c4.got.find((g) => g.type === 'post.unposted');
  assert.equal(un.body.data.post.id, id);
  assert.ok(un.body.data.minutesLate >= UNPOSTED_MIN);

  // The customer posted it, and the draft watch found their post: published, with its link.
  db.update('posts', id, { status: 'published', published_at: new Date(slot).toISOString(), publish_json: { tiktok: { via: 'zernio', flow: { mode: 'now', state: 'mine', externalUrl: 'https://www.tiktok.com/@x/photo/1', sentAt: new Date(TUE).toISOString(), slotAt: new Date(slot).toISOString() } } } });
  const c5 = catcher();
  await assistantTick(ctx, { t: slot + 2 * 3_600_000, env: ENV, send: c5.send });
  const pub = c5.got.find((g) => g.type === 'post.published');
  assert.deepEqual([pub.body.data.post.id, pub.body.data.tiktokUrl], [id, 'https://www.tiktok.com/@x/photo/1']);
});

test('a post that never reached TikTok is ready to post by hand', async () => {
  setNow(TUE);
  const id = clone(A.post);
  const slot = TUE + 3_600_000;
  db.update('posts', id, { status: 'published', slot_at: new Date(slot).toISOString(), published_at: new Date(slot).toISOString(), publish_json: { tiktok: { via: 'dry', status: 'written', draft: true, flow: { mode: 'now', state: 'waiting', sentAt: new Date(slot).toISOString(), slotAt: new Date(slot).toISOString() } } } });
  const c = catcher();
  await assistantTick(ctx, { t: slot + 60_000, env: ENV, send: c.send });
  const rem = c.got.find((g) => g.type === 'post.reminder' && g.body.data.post.id === id);
  assert.equal(rem.body.data.delivery, 'by_hand');
  assert.ok(!c.got.some((g) => g.type === 'post.published' && g.body.data.post.id === id), 'a dry publish is not out');
});

test('a message off stays off; one at night waits for the morning; one no longer true is dropped; a failed send is tried again', async () => {
  const night = israelInstant('2026-10-27', '23:30').getTime();
  setNow(night);
  setPrefs(db, 1, { events: { 'post.ready': false } });
  const offId = clone(A.post);
  const quietId = clone(B.post);
  const c = catcher();
  await assistantTick(ctx, { t: night, env: ENV, send: c.send });
  assert.equal(db.get('SELECT state FROM assistant_events WHERE key = ?', `post.ready:${offId}`).state, 'off');
  const held = db.get('SELECT state, not_before FROM assistant_events WHERE key = ?', `post.ready:${quietId}`);
  assert.deepEqual([held.state, held.not_before], ['pending', israelInstant('2026-10-28', '08:00').toISOString()]);
  assert.equal(c.got.length, 0, 'nothing at night');
  setPrefs(db, 1, { events: { 'post.ready': true } });

  // The morning, with the assistant down: tried, kept, tried again later.
  const morning = israelInstant('2026-10-28', '08:00').getTime();
  setNow(morning);
  const down = catcher(503);
  await deliver(ctx, { t: morning, env: ENV, send: down.send });
  assert.equal(down.got.length, 1, 'the rest wait while the assistant is down');
  const after1 = db.get('SELECT state, attempts, not_before, last_error FROM assistant_events WHERE id = ?', Number(down.got[0].body.id.slice(4)));
  assert.deepEqual([after1.state, after1.attempts, after1.last_error], ['pending', 1, 'HTTP 503']);
  assert.equal(after1.not_before, new Date(morning + 60_000).toISOString());
  const up = catcher();
  await deliver(ctx, { t: morning + 60_000, env: ENV, send: up.send });
  assert.ok(up.got.some((g) => g.body.data.post?.id === quietId));
  assert.equal(db.get('SELECT state FROM assistant_events WHERE key = ?', `post.ready:${offId}`).state, 'off', 'turned on later, never sent');

  // Approved on the website before its turn came: its post.ready is dropped as stale.
  const t2 = morning + 3_600_000;
  setNow(t2);
  const staleId = clone(B.post);
  detect(ctx, { t: t2 });
  db.update('posts', staleId, { status: 'approved' });
  const c3 = catcher();
  await deliver(ctx, { t: t2, env: ENV, send: c3.send });
  assert.equal(db.get('SELECT state FROM assistant_events WHERE key = ?', `post.ready:${staleId}`).state, 'stale');
  assert.ok(!c3.got.some((g) => g.body.data.post?.id === staleId));
});

test('quota.low once a month at 8 left, and the weekly summary on Sunday at 09:00, one per customer', async () => {
  const t = israelInstant('2026-11-01', '09:30').getTime(); // a Sunday
  setNow(t);
  clone(A.post, null, { quota_kind: 'suggestion', quota_month: '2026-11' });
  paidWorkspaces(db, [1], { plan: { name: 'full', slideshows: 9, redos: 10 } });
  const c = catcher();
  await assistantTick(ctx, { t, env: ENV, send: c.send });
  const low = c.got.filter((g) => g.type === 'quota.low');
  assert.deepEqual(low.map((g) => [g.body.customer, g.body.data.account.id, g.body.data.quota.suggestions.left]), [[1, 'alpha', 8]]);
  const weekly = c.got.filter((g) => g.type === 'weekly.summary');
  assert.deepEqual(weekly.map((g) => g.body.customer).sort(), [1, 2]);
  const w1 = weekly.find((g) => g.body.customer === 1).body.data;
  assert.deepEqual(w1.accounts.map((a) => a.account.id), ['alpha'], "a customer's summary is of their own accounts");
  assert.equal(w1.to, israelInstant('2026-11-01', '09:00').toISOString());
  const again = catcher();
  await assistantTick(ctx, { t: t + 3_600_000, env: ENV, send: again.send });
  assert.ok(!again.got.some((g) => g.type === 'quota.low' || g.type === 'weekly.summary'), 'once');
  // Saturday has no summary.
  assert.equal(detect(ctx, { t: israelInstant('2026-10-31', '21:00').getTime() })['weekly.summary'], undefined);
});

test('nothing is found or sent while the secret is not set', async () => {
  const before = db.get('SELECT COUNT(*) AS n FROM assistant_events').n;
  clone(A.post);
  assert.equal(await assistantTick(ctx, { env: {} }), null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM assistant_events').n, before);
});

test("a customer who has not paid gets nothing through the assistant either, as on the website", async () => {
  db.run('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', 'entitlement:1', JSON.stringify({ allowed: false, access: 'unpaid', paidThrough: null, cancelAt: null, plan: null, stoppedAt: new Date().toISOString(), checkedAt: new Date().toISOString() }), new Date().toISOString());
  try {
    for (const [method, p, body] of [['GET', c1('status')], ['GET', c1('posts/pending')], ['POST', c1(`posts/${A.post}/approve`), { by }]]) {
      const r = await call(method, p, body);
      assert.deepEqual([r.status, r.body.error], [403, 'not_paid'], p);
    }
    assert.equal((await call('GET', c2('status'))).status, 200, 'another customer, who has paid, is answered');
  } finally {
    paidWorkspaces(db, [1]);
  }
});
