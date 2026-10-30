import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { notify, subscribe } from '../src/notify/index.js';
import { __onboarding } from '../src/web/onboarding.js';
import { monthKey, nowIso } from '../src/core/clock.js';
import { closeBrowser } from '../src/render/render.js';
import { ROOT } from '../src/core/paths.js';
import { customer, fakeAccounts, operator, opened, tempHome, viewingAs } from './helpers.js';

// Workspace A sees nothing of workspace B, and changes nothing of it.
//
// Three accounts on one server: alpha is workspace 1's (A), bravo workspace 2's (B), loose is in no workspace yet
// (the operator's alone). B fills its account through the website as a customer would (a rival, a sound, a topic, a
// hand-checked fact, a source, a browser for notifications) and the engine leaves the rest (a post, a takedown, a
// notification, a summary, spend, a new-account flow). Then A's session opens every page and presses every button
// with B's ids. Every page and button the site has is listed here: a route added without a case fails the test.
//
// The positive controls (B and the operator do see B's things) show that what A's pages are searched for would be
// found if it were there.

let home;
let ctx;
let db;
let fake;
let server;
let handler;
let base;
const B = {};
const A = {};

const MARK = /bravo|loose/i; // every name, handle and id of B's account and of the loose one has one of these

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
  ctx.mediaRoot = home.home;
  ctx.robotsAllows = async () => ({ ok: true });
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  A.post = (await buildPost(ctx, { pack: ctx.pack('alpha'), formatKey: 'care-guide' })).postId;
  B.post = (await buildPost(ctx, { pack: ctx.pack('bravo'), formatKey: 'care-guide' })).postId;
  await buildPost(ctx, { pack: ctx.pack('loose'), formatKey: 'care-guide' });
  assert.ok(A.post && B.post, 'both posts were drafted');

  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'w'.repeat(40), ...fake.env } });
  server = s.server;
  handler = s.handler;
  base = `http://127.0.0.1:${s.port}`;
  A.cookie = fake.session(customer(1, { wsName: 'Alpha Shop' })).cookie;
  B.cookie = fake.session(customer(2, { wsName: 'Bravo Shop' })).cookie;
  A.csrf = await csrfOf(A.cookie);
  B.csrf = await csrfOf(B.cookie);

  // ---- B fills its account through the website
  const ok = async (p, body) => {
    const res = await post(p, B.cookie, { _csrf: B.csrf, ...body });
    assert.equal(res.status, 200, `${p}: ${await res.clone().text()}`);
    return res.json();
  };
  await ok('/rivals/save', { account: 'bravo', handle: '@bravo.rival', platform: 'tiktok', hooks: 'שער של bravo', formats: 'דירוג', times: '18:00', gaps: 'bravo gap' });
  await ok('/sounds/save', { account: 'bravo', name: 'BravoSound', artist: 'Bravo Artist', link: 'https://www.tiktok.com/music/BravoSound-123' });
  await ok('/topics/add', { account: 'bravo', title: 'BravoTopic הצמח ששרד', why: 'מיליון צפיות ל-bravo', url: 'https://www.tiktok.com/@bravo/video/1' });
  await ok('/facts/add', { account: 'bravo', topic: 'BravoFacts', quote: 'צמחי התבלין של bravo בעציץ צריכים השקיה כשהשכבה העליונה של האדמה יבשה למגע.', source: 'Bravo Ministry', url: 'https://www.example.org/bravo', checkedAt: '2026-10-13', expires: '2027-06-30' });
  await ok('/sources/add', { account: 'bravo', url: 'https://bravo-source.example.org/feed', type: 'rss', why: 'the bravo trade paper, read for years', name: 'BravoSource' });
  await ok('/topics/watch', { account: 'bravo', names: 'Bravo Person' });
  await ok('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/bravo-browser' });
  B.rival = db.get("SELECT id FROM rivals WHERE account_id = 'bravo'").id;
  B.sound = db.get("SELECT id FROM sounds WHERE account_id = 'bravo'").id;
  B.topic = db.get("SELECT id FROM topics WHERE account_id = 'bravo'").id;
  B.source = db.get("SELECT id FROM sources WHERE account_id = 'bravo' AND name = 'BravoSource'").id;
  const factFile = readdirSync(path.join(home.home, 'packs', 'bravo', 'facts'))[0];
  const facts = JSON.parse(readFileSync(path.join(home.home, 'packs', 'bravo', 'facts', factFile), 'utf8'));
  B.factTopic = 'BravoFacts';
  B.factId = (facts.facts || facts)[0].id;
  assert.ok(B.factId, 'the fact has an id');

  // ---- and what the engine leaves in it
  const t = nowIso();
  B.takedown = db.insert('takedowns', { post_id: B.post, account_id: 'bravo', platform: 'tiktok', claimant: 'Bravo Claimant', notice: 'a bravo notice', received_at: t, recorded_by: 'engine', deleted_json: { tiktok: { state: 'by_hand' } }, created_at: t });
  db.insert('notifications', { account_id: 'bravo', post_id: B.post, kind: 'draft', title: 'BravoNotice: a draft waits', body: 'bravo body', url: `/post/${B.post}`, created_at: t });
  db.insert('notifications', { account_id: 'loose', kind: 'draft', title: 'LooseNotice', body: 'loose body', url: '/', created_at: t });
  B.onboarding = 'o-bravo-flow';
  db.insert('onboarding', { id: B.onboarding, seed_json: { niche: 'BravoNiche' }, status: 'review', workspace_id: 2, candidates_json: { candidates: [], formats: [] }, created_at: t, updated_at: t });
  B.demo = db.insert('demos', { slug: 'loose-shop-abcdef', url: 'https://loose-shop.example', domain: 'loose-shop.example', whatsapp: '972500000000', status: 'ready', store_json: { name: 'Loose Shop' }, topic_json: { niche: 'loose topic', angle: 'loose', articles: [], products: [] }, media_json: { tiktok: [], instagram: [] }, created_at: t, updated_at: t });
  db.insert('spend', { account_id: 'bravo', api: 'anthropic', usd: 5, tag: 'bravo-test', month: monthKey(), at: t });
  const day = '2026-10-21';
  db.run('INSERT INTO summaries (day, account_id, text, data_json, at) VALUES (?, NULL, ?, NULL, ?)', day, 'חשבון bravo: 3 פורסמו\nחשבון loose: 1 פורסמו', t);
  db.run('INSERT INTO summaries (day, account_id, text, data_json, at) VALUES (?, ?, ?, ?, ?)', day, 'bravo', 'חשבון bravo: 3 פורסמו', JSON.stringify({ published: [{ id: B.post, hook: 'bravo' }], spend: 5 }), t);
});

after(async () => {
  await Promise.all([...__onboarding.running.values()]);
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const post = (p, cookie, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams(body).toString() });
async function csrfOf(cookie) {
  return /name="_csrf" value="([^"]+)"/.exec(await (await get('/settings', cookie)).text())[1];
}

/** Everything of B's, and the server's settings: any change to it by A is a failure. */
function snapshotB() {
  const factsDir = path.join(home.home, 'packs', 'bravo', 'facts');
  return JSON.stringify({
    account: db.get("SELECT * FROM accounts WHERE id = 'bravo'"),
    posts: db.all("SELECT * FROM posts WHERE account_id = 'bravo' ORDER BY id"),
    slides: db.all("SELECT s.* FROM slides s JOIN posts p ON p.id = s.post_id WHERE p.account_id = 'bravo' ORDER BY s.id"),
    images: db.all("SELECT i.id, i.reviewed_by, i.reviewed_at FROM images i WHERE i.id IN (SELECT image_id FROM slides s JOIN posts p ON p.id = s.post_id WHERE p.account_id = 'bravo') ORDER BY i.id"),
    sources: db.all("SELECT * FROM sources WHERE account_id = 'bravo' ORDER BY id"),
    rivals: db.all("SELECT * FROM rivals WHERE account_id = 'bravo' ORDER BY id"),
    sounds: db.all("SELECT * FROM sounds WHERE account_id = 'bravo' ORDER BY id"),
    topics: db.all("SELECT * FROM topics WHERE account_id = 'bravo' ORDER BY id"),
    takedowns: db.all("SELECT * FROM takedowns WHERE account_id = 'bravo' ORDER BY id"),
    notifications: db.all("SELECT * FROM notifications WHERE account_id = 'bravo' ORDER BY id"),
    edits: db.all("SELECT * FROM edits WHERE account_id = 'bravo' ORDER BY id"),
    push: db.all('SELECT * FROM push_subs WHERE workspace_id = 2 ORDER BY id'),
    onboarding: db.all('SELECT * FROM onboarding WHERE workspace_id = 2 ORDER BY id'),
    demos: db.all('SELECT * FROM demos ORDER BY id'),
    assistant: db.all('SELECT * FROM assistant_prefs WHERE workspace_id = 2'),
    // A's own email choices are A's to change; what accounts said of each workspace's payment is kept as it is asked.
    settings: db.all("SELECT key, value_json FROM settings WHERE key != 'email:prefs:1' AND key NOT LIKE 'entitlement:%' ORDER BY key"),
    facts: existsSync(factsDir) ? readdirSync(factsDir).map((f) => [f, readFileSync(path.join(factsDir, f), 'utf8')]) : [],
  });
}

// Every page, as A would open it, and as A might try to reach B's: by ?account=, by B's ids in the address.
const pagesFor = () => [
  '/', '/posts', '/all', '/accounts', '/results', '/sources', '/facts', '/topics', '/rivals', '/sounds', '/settings', '/more', '/new', '/styles',
  '/static/accounts.css', '/notifications/latest.json',
  '/?account=bravo', '/posts?account=bravo', '/accounts?account=bravo', '/results?account=bravo', '/sources?account=bravo', '/facts?account=bravo', '/topics?account=bravo', '/rivals?account=bravo', '/sounds?account=bravo', '/settings?account=loose',
  `/post/${B.post}`, `/media/${B.post}/tiktok/0`, `/media/${B.post}/instagram/0`, `/new/${B.onboarding}`, `/new/${B.onboarding}/status`,
  '/styles?account=bravo', `/styles/img/bravo/${B.post}-000000/A/0`,
  '/demos', `/demos/${B.demo}`, `/demos/${B.demo}/img/tiktok/0`,
];

test('workspace A sees nothing of workspace B, or of an account in no workspace: on every page, by every way in', async () => {
  for (const cookie of [A.cookie, `${A.cookie}; of_acct=bravo; of_dev=1`]) {
    for (const p of pagesFor()) {
      const res = await get(p, cookie);
      assert.ok([200, 404].includes(res.status), `${p}: ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, MARK, `${p} shows something of B's`);
      assert.ok(!body.includes(B.post), `${p} shows B's post id`);
      assert.doesNotMatch(res.headers.get('set-cookie') || '', /of_acct=(bravo|loose)/, `${p} switched A to another workspace's account`);
    }
  }
  assert.equal((await get(`/post/${B.post}`, A.cookie)).status, 404, "B's post is not found, as one that never was");
  assert.equal((await get(`/media/${B.post}/tiktok/0`, A.cookie)).status, 404, "nor its slides");
  assert.equal((await get(`/new/${B.onboarding}`, A.cookie)).status, 404, "nor its new-account flow");
  assert.deepEqual(await (await get('/notifications/latest.json', A.cookie)).json(), {}, "B's notification is not A's latest, though it is the newest");
});

test('the positive controls: B sees its own things, and the operator sees every workspace and the account in none', async () => {
  for (const [p, re] of [['/rivals', /bravo\.rival/], ['/sounds', /BravoSound/], ['/topics', /BravoTopic/], ['/facts', /BravoFacts/], ['/sources', /BravoSource/], [`/post/${B.post}`, /bravo/i], ['/new', /BravoNiche/], ['/', /bravo/]]) {
    const res = await get(p, B.cookie);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), re, p);
  }
  assert.match((await (await get('/notifications/latest.json', B.cookie)).json()).title, /BravoNotice/);
  assert.equal((await get(`/media/${B.post}/tiktok/0`, B.cookie)).status, 200);
  for (const p of pagesFor().filter((x) => !x.startsWith('/static') && !x.startsWith('/notifications'))) {
    if (/alpha/.test(await (await get(p, B.cookie)).text())) assert.fail(`${p}: B sees A's account`);
  }
  const op = fake.session(operator()).cookie;
  const all = await (await get('/all', op)).text();
  for (const id of ['alpha', 'bravo', 'loose']) assert.match(all, new RegExp(`acc-${id}`), `the operator sees ${id}`);
  assert.match((await (await get('/notifications/latest.json', op)).json()).title, /LooseNotice/, "the operator's latest is any account's");
});

test("A's month is A's: the suggestions in A's header are its own account's, and no page shows A the money", async () => {
  const [used, limit] = /הצעות החודש: (\d+) מתוך (\d+)/.exec(await (await get('/', A.cookie)).text()).slice(1).map(Number);
  const own = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'alpha' AND quota_kind = 'suggestion'").n;
  assert.ok(own > 0, 'A has a suggestion this month');
  assert.equal(used, own, "A's header counts A's suggestions, none of B's or the loose account's");
  assert.equal(limit, 40, 'at the default plan');
  for (const p of ['/', '/accounts', '/settings', `/post/${A.post}`]) {
    const body = await (await get(p, A.cookie)).text();
    assert.doesNotMatch(body, /טוקנ|\$\d/, `${p} shows A tokens or dollars`);
  }
  const settings = await (await get('/settings', A.cookie)).text();
  assert.doesNotMatch(settings, MARK);
});

/** Every button, pressed by A with B's ids. `ownOk`: A acting on its own things may succeed; B must still be untouched. */
const casesFor = () => {
  const fact = { topic: B.factTopic, id: B.factId };
  const rival = { handle: '@taken.over', platform: 'tiktok', hooks: 'x', formats: 'x', times: '18:00', gaps: 'x' };
  return [
    [`/post/${B.post}/approve`],
    ['/posts/approve-all', { ids: B.post }],
    [`/post/${B.post}/unapprove`],
    [`/post/${B.post}/reject`, { reason: 'A rejects B' }],
    [`/post/${B.post}/edit`, { hook: 'A was here', sub: '', caption: 'A was here' }],
    [`/post/${B.post}/slide/1/photo`, { image: 'none' }],
    [`/post/${B.post}/slide/1/remove`],
    [`/post/${B.post}/publish-now`],
    [`/post/${B.post}/publish-again`],
    [`/post/${B.post}/takedown`, { notice: 'a takedown notice from A for B', platform: 'tiktok' }],
    [`/post/${B.post}/image-ok`],
    [`/post/${B.post}/old-drafts-deleted`],
    [`/takedowns/${B.takedown}/deleted`, { platform: 'tiktok' }],
    ['/accounts/bravo/mode', { mode: 'auto' }],
    ['/accounts/bravo/style'],
    ['/accounts/bravo/style-pick', { style: 'B' }],
    ['/accounts/bravo/style-test', { on: '1' }],
    ['/accounts/bravo/kill'],
    ['/accounts/bravo/resume'],
    ['/accounts/bravo/quota', { suggested: '1', redos: '0', cap: '0' }],
    // The days and times B posts on are B's to choose.
    ['/accounts/bravo/schedule', { day_1: 'on', t1_1: '10:00' }],
    // Connecting B's TikTok or Instagram, reading B's connections, or setting how B's TikTok goes out: B's alone.
    ['/accounts/bravo/connect/tiktok'],
    ['/accounts/bravo/connect/instagram'],
    ['/accounts/bravo/connections'],
    ['/accounts/bravo/tiktok', { mode: 'direct' }],
    ['/accounts/loose/kill'],
    ['/settings/kill', { on: '1' }],
    ['/settings/generate-at', { at: '05:00' }],
    ['/settings/dev', { on: '1' }],
    ['/account/switch', { to: 'bravo' }],
    [`/sources/${B.source}/approve`],
    [`/sources/${B.source}/remove`],
    ['/sources/add', { account: 'bravo', url: 'https://a.example.org/feed', type: 'rss', why: 'A adds to B, which must fail', name: 'A' }],
    ['/sources/catalog', { account: 'bravo', niche: 'plants', id: 'x' }],
    ['/facts/add', { account: 'bravo', topic: 'A', quote: 'צמחי תבלין בעציץ צריכים השקיה כשהשכבה העליונה של האדמה יבשה למגע.', source: 'A', url: 'https://www.example.org/a', checkedAt: '2026-10-13', expires: '2027-06-30' }],
    ['/facts/confirm', { account: 'bravo', ...fact, expires: '2028-01-01' }],
    ['/facts/confirm', { account: 'alpha', ...fact, expires: '2028-01-01' }],
    ['/facts/remove', { account: 'bravo', ...fact }],
    ['/facts/remove', { account: 'alpha', ...fact }],
    ['/topics/add', { account: 'bravo', title: 'A in B', why: 'x', url: 'https://www.tiktok.com/@a/video/2' }],
    ['/topics/remove', { account: 'bravo', id: B.topic }],
    ['/topics/remove', { account: 'alpha', id: B.topic }],
    ['/topics/watch', { account: 'bravo', names: 'A Person' }],
    ['/rivals/save', { account: 'bravo', ...rival }],
    ['/rivals/save', { account: 'alpha', id: B.rival, ...rival }],
    ['/rivals/remove', { account: 'bravo', id: B.rival }],
    ['/rivals/remove', { account: 'alpha', id: B.rival }],
    ['/sounds/save', { account: 'bravo', name: 'A', artist: 'A', link: 'https://www.tiktok.com/music/A-1' }],
    ['/sounds/remove', { account: 'bravo', id: B.sound }],
    ['/sounds/remove', { account: 'alpha', id: B.sound }],
    // A browser's endpoint is a secret only that browser has; A turning off B's is refused, A's own is A's.
    ['/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/bravo-browser' }, { ownOk: true }],
    ['/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/alpha-browser' }, { ownOk: true }],
    // The WhatsApp assistant's choices are the session's workspace's: A sets A's, whatever the form names.
    ['/settings/whatsapp', { workspace: '2', 'ev_post.ready': '1', quiet_nights: '1' }, { ownOk: true }],
    // The email choices too: A turning emails off turns off A's.
    ['/settings/email', { workspace: '2', em_weekly: '1' }, { ownOk: true }],
    ['/new', { niche: 'AlphaNiche' }, { ownOk: true }],
    [`/new/${B.onboarding}/create`, { displayName: 'A in B', handle: 'a.in.b' }],
    [`/new/${B.onboarding}/samples`],
    [`/new/${B.onboarding}/reviewed`],
    [`/new/${B.onboarding}/live`],
    [`/new/${B.onboarding}/retry`],
    // The setup done while the sources are searched: the name, the days and times, TikTok and Instagram, a search again.
    [`/new/${B.onboarding}/name`, { displayName: 'A in B', handle: 'a.in.b' }],
    [`/new/${B.onboarding}/schedule`, { day_1: 'on', t1_1: '10:00' }],
    [`/new/${B.onboarding}/connect/tiktok`],
    [`/new/${B.onboarding}/connections`],
    [`/new/${B.onboarding}/more`, { examples: 'https://a.example.org/' }],
    // A store's demo is the operator's alone: no customer approves, rewrites or takes one down, or sets its price.
    [`/demos/${B.demo}/approve`],
    [`/demos/${B.demo}/redo`],
    [`/demos/${B.demo}/other`],
    [`/demos/${B.demo}/remove`],
    ['/demos/offer', { monthly: '1', setup: '1', vat: 'included' }],
  ];
};

test('every route the site answers has a case here', () => {
  const cases = casesFor().map(([p]) => p);
  const gets = pagesFor().map((p) => p.split('?')[0]);
  for (const [method, re] of handler.routes) {
    const list = method === 'POST' ? cases : gets;
    assert.ok(list.some((p) => re.test(p)), `${method} ${re} has no isolation case: add one to test/workspaces.test.js`);
  }
});

// The routes written inline in src/web/server.js that need no session or name no account: each with the test file that
// covers it, or null for a file of ours with nothing of anyone's in it. A session's pages are in pagesFor, its buttons
// in casesFor.
const DOORS = [
  ['/healthz', 'test/ops.test.js'],
  ['/readyz', 'test/ops.test.js'],
  ['/favicon.ico', 'test/web.test.js'],
  ['/sw.js', 'test/web.test.js'],
  ...['/static/style.css', '/static/app.js', '/static/icon.svg', '/static/icon-180.png', '/static/icon-512.png', '/static/manifest.webmanifest', '/static/fonts/Assistant.ttf', '/static/demo.css'].map((p) => [p, null]),
  ['/theme', null], // the browser's light or dark, a cookie of its own
  ['/m/p1/tiktok/0', 'test/assistant.test.js'],
  ['/connect/alpha/tiktok', 'test/zernio.test.js'],
  ['/connect/alpha/tiktok/done', 'test/zernio.test.js'],
  ['/connect/pick/0123456789abcdef0123456789abcdef', 'test/parallel-setup.test.js'],
  ['/new/o1/connect/tiktok/done', 'test/parallel-setup.test.js'],
  ['/s/a-store', 'test/demos.test.js'],
  ['/internal/lead', 'test/demos.test.js'],
  ['/internal/demos', 'test/demos.test.js'],
  ['/internal/setup', 'test/setup.test.js'],
  ['/internal/workspaces/1/delete', 'test/workspace-delete.test.js'],
];

test('every route written inline in src/web/server.js has a case: a page or a button here, or a door and the test that covers it', () => {
  const src = readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const literals = [...src.matchAll(/\bp === '([^']+)'/g)].map((m) => m[1]);
  // A regular expression literal tested against the path: its body, escapes and character classes included.
  const patterns = [...src.matchAll(/\/(\^(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])*)\/[a-z]*\.(?:exec|test)\(p\)/g)].map((m) => new RegExp(m[1]));
  assert.ok(literals.length > 20 && patterns.length > 8, `the source was read (${literals.length} paths, ${patterns.length} patterns)`);
  const known = [...pagesFor().map((p) => p.split('?')[0]), ...casesFor().map(([p]) => p), ...DOORS.map(([p]) => p)];
  for (const l of literals) assert.ok(known.includes(l), `${l} has no case: add it to pagesFor, casesFor or DOORS in test/workspaces.test.js`);
  for (const re of patterns) assert.ok(known.some((p) => re.test(p)), `${re} has no case: add it to pagesFor, casesFor or DOORS in test/workspaces.test.js`);
  for (const [p, file] of DOORS) if (file) assert.ok(existsSync(path.join(ROOT, file)), `${p}: ${file} is the test that covers it`);
});

test('workspace A changes nothing of workspace B: every button, with B\'s ids, is refused and B is as it was', async () => {
  const before = snapshotB();
  for (const [p, body = {}, { ownOk = false } = {}] of casesFor()) {
    const res = await post(p, A.cookie, { _csrf: A.csrf, ...body });
    const text = await res.text();
    if (!ownOk) assert.ok(res.status >= 400 && res.status < 500, `${p}: ${res.status} ${text.slice(0, 200)}`);
    assert.equal(snapshotB(), before, `${p} changed something of B's`);
  }
  assert.equal(db.get('SELECT COUNT(*) AS n FROM push_subs WHERE workspace_id = 2').n, 1, "B's browser is still subscribed");
  assert.equal(db.get("SELECT workspace_id FROM push_subs WHERE endpoint LIKE '%alpha-browser'").workspace_id, 1, "A's browser is A's");
});

test("a notification of B's account wakes B's browsers and the operator's, never A's", async () => {
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/operator-browser' }, { workspaceId: null });
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/alpha-phone' }, { workspaceId: 1 });
  const woken = [];
  const send = async (_db, endpoint) => (woken.push(endpoint.split('/').pop()), { status: 201 });
  await notify(ctx, { accountId: 'bravo', kind: 'draft', title: 'BravoNotice 2', body: 'b' }, { send });
  assert.deepEqual(woken.sort(), ['bravo-browser', 'operator-browser']);
  woken.length = 0;
  await notify(ctx, { accountId: 'loose', kind: 'draft', title: 'LooseNotice 2', body: 'b' }, { send });
  assert.deepEqual(woken, ['operator-browser'], 'an account in no workspace wakes the operator alone');
  woken.length = 0;
  await notify(ctx, { accountId: 'alpha', kind: 'draft', title: 'AlphaNotice', body: 'b' }, { send });
  assert.ok(!woken.includes('bravo-browser'), "A's notification never wakes B's browser");
});

test('the operator viewing B as its customer sees B, with the banner, and changes nothing: every button is refused', async () => {
  const view = fake.session(viewingAs(2, 'Bravo Shop')).cookie;
  const home = await (await get('/', view)).text();
  assert.match(home, /אתם צופים ב-Bravo Shop כמו שהלקוח רואה אותו\. זו צפייה בלבד, ושום שינוי לא נשמר\./);
  assert.match(home, /href="https:\/\/accounts\.test\/admin">סיום צפייה<\/a>/);
  assert.match(home, /<body class="readonly">/);
  assert.match(home, /bravo/i);
  assert.doesNotMatch(home, /alpha/, 'and only B');
  for (const p of ['/posts', '/settings', '/accounts', `/post/${B.post}`]) assert.match(await (await get(p, view)).text(), /סיום צפייה/, `${p} has the banner`);
  const csrf = await csrfOf(view);
  const before = snapshotB();
  // B's own ids this time: the refusal is read-only's, not the workspace's.
  for (const [p, body = {}] of casesFor()) {
    const fixed = { ...body, ...(body.account === 'alpha' ? { account: 'bravo' } : {}) };
    const res = await post(p, view, { _csrf: csrf, ...fixed });
    assert.equal(res.status, 403, `${p}: ${res.status}`);
    assert.equal(snapshotB(), before, `${p} changed something in view-as`);
  }
});
