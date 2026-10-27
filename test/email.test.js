import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { emailPrefsOf, emailTick, notifyClient, setEmailPrefs } from '../src/notify/email.js';
import { setSetting } from '../src/core/store.js';
import { israelDate, israelInstant } from '../src/schedule/israel.js';
import { customer, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// What the owner hears by email: Teder writes it, accounts sends it to the workspace's owners (POST /internal/notify).
// Posts waiting for approval once a day after they are written, Sunday's week, the 1st's month of results (what the
// website's "דוח תוצאות בכל חודש" promises), posts held for a connection, and a post that did not go out. Each once,
// each one the customer can turn off, none for a workspace that has not paid, and a send that fails never stops the
// runner.
//
// alpha is workspace 1's, bravo workspace 2's.

let home;
let ctx;
let db;
let fake;
let server;
let base;
let client;

const at = (day, hm) => israelInstant(day, hm).getTime();
const TUE = (hm) => at('2026-10-13', hm);

before(async () => {
  home = tempHome({
    packs: {
      alpha: (f) => {
        delete f.pack.publisher;
        f.pack.publishers = { tiktok: 'zernio', instagram: 'zernio' };
      },
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
  client = notifyClient({ env: { ...fake.env, PUBLIC_HOST: 'teder.openfrequency.co.il' } });
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'e'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

beforeEach(() => {
  delete process.env.ZERNIO_API_KEY;
  fake.resetNotify();
  db.run('DELETE FROM posts');
  db.run('DELETE FROM metrics');
  db.run("DELETE FROM settings WHERE key LIKE 'email:%' OR key LIKE 'generated:%' OR key LIKE 'entitlement:%'");
  // Paid, as accounts said it; dated after every test's clock, so no answer here is too old.
  paidWorkspaces(db, [1, 2], { at: '2026-12-31T00:00:00.000Z' });
  delete ctx.generating;
});

let n = 0;
const post = (accountId, status, patch = {}) => {
  const id = `p${++n}`;
  db.insert('posts', { id, account_id: accountId, status, hook: `כותרת ${n}`, sample: 0, created_at: '2026-10-01T08:00:00.000Z', updated_at: '2026-10-01T08:00:00.000Z', ...patch });
  return id;
};
const run = (t) => emailTick(ctx, { t, client });
const kinds = () => fake.notified.map((e) => e.kind);
const plain = (e) => {
  // The words the owner reads: Hebrew, no dashes, no gendered slashes; the link is the only Latin.
  const words = `${e.subject}\n${e.text.replace(e.link, '')}`;
  assert.doesNotMatch(words, /[—–]|\/ה\b|\/ת\b/, e.kind);
  assert.doesNotMatch(words, /[A-Za-z]/, `${e.kind}: ${words}`);
  assert.match(e.link, /^https:\/\/teder.openfrequency.co.il\//);
  // Accounts builds the email from the text alone: the link is in it, last.
  assert.ok(e.text.endsWith(e.link), 'the text carries the link');
  assert.ok(e.subject.length <= 150 && e.text.length <= 5000);
  assert.equal(e.product, 'teder');
};

test('posts waiting: once a day, after the posts are written, with how many and that they drop at the end of their day', async () => {
  const today = israelDate(TUE('07:30'));
  for (let i = 0; i < 3; i++) post('alpha', 'queued');
  assert.deepEqual(await run(TUE('07:30')), { sent: 0, failed: 0, off: 0 }, 'not written today yet: nothing');
  setSetting(db, `generated:alpha:${today}`, new Date(TUE('07:01')).toISOString());
  ctx.generating = Promise.resolve();
  await run(TUE('07:30'));
  assert.deepEqual(kinds(), [], 'a batch still writing: wait for it');
  delete ctx.generating;
  await run(TUE('07:31'));
  assert.deepEqual(kinds(), ['posts_waiting']);
  const e = fake.notified[0];
  assert.equal(e.workspace, 1);
  assert.equal(e.subject, '3 מצגות מחכות לאישור');
  assert.match(e.text, /מצגת שלא תאשרו עד סוף היום שלה לא תעלה/);
  assert.equal(e.link, 'https://teder.openfrequency.co.il/posts?account=alpha');
  plain(e);
  await run(TUE('09:00'));
  assert.equal(fake.notified.length, 1, 'once a day');
});

test('accounts down: tried again later, a few times, and the runner goes on', async () => {
  const today = israelDate(TUE('07:30'));
  post('alpha', 'queued');
  setSetting(db, `generated:alpha:${today}`, new Date().toISOString());
  fake.notifyStatus(503);
  assert.deepEqual(await run(TUE('07:30')), { sent: 0, failed: 1, off: 0 });
  fake.notifyStatus(202);
  await run(TUE('07:35'));
  assert.equal(fake.notified.length, 0, 'not before its retry');
  await run(TUE('07:46'));
  assert.deepEqual(kinds(), ['posts_waiting']);
  assert.equal(fake.notified[0].subject, 'מצגת אחת מחכה לאישור');
  // Nobody listening at all: no throw, a failure counted.
  const dead = notifyClient({ env: { ...fake.env, OF_ACCOUNTS_INTERNAL: 'http://127.0.0.1:9', PUBLIC_HOST: 'teder.openfrequency.co.il' }, timeoutMs: 500 });
  post('bravo', 'queued');
  setSetting(db, `generated:bravo:${today}`, new Date().toISOString());
  const r = await emailTick(ctx, { t: TUE('07:50'), client: dead });
  assert.equal(r.failed, 1);
});

test('each email can be turned off, and a workspace that has not paid, or a server with no public name, sends none', async () => {
  const today = israelDate(TUE('07:30'));
  post('alpha', 'queued');
  post('bravo', 'queued');
  for (const id of ['alpha', 'bravo']) setSetting(db, `generated:${id}:${today}`, new Date().toISOString());
  setEmailPrefs(db, 2, { posts_waiting: false });
  assert.deepEqual(emailPrefsOf(db, 2), { posts_waiting: false, weekly: true, monthly: true, connect_needed: true, publish_failed: true });
  const r = await run(TUE('07:30'));
  assert.deepEqual([r.sent, r.off], [1, 1]);
  assert.deepEqual(fake.notified.map((e) => e.workspace), [1]);
  // Turned on again later: what was off that day stays off; tomorrow it is sent.
  setEmailPrefs(db, 2, {});
  await run(TUE('08:00'));
  assert.equal(fake.notified.length, 1);

  db.run("DELETE FROM settings WHERE key LIKE 'email:sent:%'");
  db.run("DELETE FROM settings WHERE key = 'entitlement:1'");
  fake.notified.length = 0;
  await run(TUE('08:10'));
  assert.deepEqual(fake.notified.map((e) => e.workspace), [2], 'workspace 1 has no answer from accounts: no emails');
  assert.equal(await emailTick(ctx, { t: TUE('08:10'), client: notifyClient({ env: fake.env }) }), null, 'no PUBLIC_HOST: nothing to link to');
  assert.equal(await emailTick(ctx, { t: TUE('08:10'), client: notifyClient({ env: { PUBLIC_HOST: 'teder.openfrequency.co.il' } }) }), null, 'no token');
  assert.equal(await emailTick(ctx, { t: TUE('08:10'), client: notifyClient({ env: { ...fake.env, PUBLIC_HOST: 'teder.example.com' } }) }), null, 'a public name accounts would not link to');
});

test("accounts' limit (three of a kind a day) and its other refusals give the email up at once, without a word for 429", async () => {
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  post('alpha', 'held');
  const log = [];
  const quiet = notifyClient({ env: { ...fake.env, PUBLIC_HOST: 'teder.openfrequency.co.il' }, log: (m) => log.push(m) });
  for (const day of ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']) await emailTick(ctx, { t: at(day, '13:00'), client: quiet });
  assert.equal(fake.notified.filter((e) => e.kind === 'connect_needed').length, 3);
  const fourth = JSON.parse(db.get("SELECT value_json FROM settings WHERE key = 'email:sent:connect_needed:1:2026-10-16'").value_json);
  assert.deepEqual([fourth.state, fourth.status], ['gave_up', 429]);
  assert.deepEqual(log, [], '429 is said quietly');
  await emailTick(ctx, { t: at('2026-10-16', '14:00'), client: quiet });
  assert.equal(fake.notified.length, 3, 'not tried again');
  // A field accounts refuses (here a workspace sent as a string) is given up too, and logged.
  const r = await quiet.send({ workspace: '1', product: 'teder', kind: 'weekly', subject: 's', text: 't', link: 'https://teder.openfrequency.co.il/' });
  assert.deepEqual([r.ok, r.status, r.final], [false, 400, true]);
  assert.match(log.at(-1), /400 bad_workspace/);
  // A subject longer than accounts keeps is cut to 150 here.
  fake.resetNotify();
  assert.equal((await quiet.send({ workspace: 2, product: 'teder', kind: 'weekly', subject: 'א'.repeat(190), text: 't', link: 'https://teder.openfrequency.co.il/' })).ok, true);
  assert.equal(fake.notified[0].subject.length, 150);
});

test("Sunday's week: what went out and how often it was seen, what waits, what is scheduled", async () => {
  const sun = (hm) => at('2026-10-18', hm);
  const out1 = post('alpha', 'published', { published_at: new Date(at('2026-10-14', '12:40')).toISOString() });
  post('alpha', 'published', { published_at: new Date(at('2026-10-16', '12:15')).toISOString() });
  post('alpha', 'published', { published_at: new Date(at('2026-10-05', '12:40')).toISOString() }); // the week before
  db.insert('metrics', { post_id: out1, platform: 'tiktok', collected_at: '2026-10-15T10:00:00Z', views: 1200, likes: 40 });
  db.insert('metrics', { post_id: out1, platform: 'tiktok', collected_at: '2026-10-17T10:00:00Z', views: 2000, likes: 70 });
  post('alpha', 'queued');
  post('alpha', 'approved', { slot_at: new Date(at('2026-10-19', '12:40')).toISOString() });
  await run(sun('08:59'));
  assert.deepEqual(kinds(), []);
  await run(sun('09:01'));
  const e = fake.notified.find((x) => x.kind === 'weekly' && x.workspace === 1);
  assert.ok(e, JSON.stringify(fake.notified));
  assert.equal(e.subject, 'השבוע שלכם בתדר');
  assert.match(e.text, /בשבוע שעבר עלו 2 מצגות, והן נצפו 2,000 פעמים\./, 'the latest reading, not the sum of readings');
  assert.match(e.text, /מצגת אחת מחכה לאישור שלכם/);
  assert.match(e.text, /מצגת אחת מתוזמנת לשבוע הקרוב/);
  plain(e);
  const quiet = fake.notified.find((x) => x.kind === 'weekly' && x.workspace === 2);
  assert.match(quiet.text, /בשבוע שעבר לא עלו מצגות/);
  await run(sun('10:00'));
  assert.equal(fake.notified.filter((x) => x.kind === 'weekly').length, 2, 'once a week');
});

test('the 1st: last month\'s results, as the Results page counts them', async () => {
  const first = (hm) => at('2026-11-01', hm);
  const a = post('alpha', 'published', { hook: 'שלושה צמחים שאוהבים צל', published_at: new Date(at('2026-10-03', '12:40')).toISOString() });
  const b = post('alpha', 'published', { hook: 'מתי משקים', published_at: new Date(at('2026-10-20', '12:40')).toISOString() });
  post('alpha', 'published', { published_at: new Date(at('2026-11-01', '08:00')).toISOString() }); // this month's
  post('alpha', 'published', { published_at: new Date(at('2026-09-30', '20:00')).toISOString() }); // September's
  db.insert('metrics', { post_id: a, platform: 'tiktok', collected_at: '2026-10-06T10:00:00Z', views: 3000, likes: 120 });
  db.insert('metrics', { post_id: a, platform: 'instagram', collected_at: '2026-10-06T10:00:00Z', views: 500, likes: 30 });
  db.insert('metrics', { post_id: b, platform: 'tiktok', collected_at: '2026-10-23T10:00:00Z', views: 800, likes: 10 });
  await run(first('09:05'));
  const e = fake.notified.find((x) => x.kind === 'monthly');
  assert.ok(e, JSON.stringify(kinds()));
  assert.equal(e.workspace, 1);
  assert.equal(e.subject, 'דוח התוצאות של אוקטובר 2026');
  assert.match(e.text, /באוקטובר 2026 עלו 2 מצגות\./);
  assert.match(e.text, /הן נצפו 4,300 פעמים וקיבלו 160 לייקים\./);
  assert.match(e.text, /הכי נצפתה "שלושה צמחים שאוהבים צל", עם 3,500 צפיות\./);
  assert.equal(e.link, 'https://teder.openfrequency.co.il/results?account=alpha');
  plain(e);
  assert.ok(!fake.notified.some((x) => x.kind === 'monthly' && x.workspace === 2), 'nothing out last month: no report');
  await run(first('12:00'));
  assert.equal(fake.notified.filter((x) => x.kind === 'monthly').length, 1, 'once a month');
});

test('posts held for a connection: at most once a day, with where to connect; a post that did not go out: once', async () => {
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  post('alpha', 'held');
  post('alpha', 'held');
  const failed = post('alpha', 'failed', { hook: 'הפוסט שנפל', reason: 'החיבור לטיקטוק הפסיק לעבוד. מחברים אותו מחדש בדף החשבון.', updated_at: new Date(TUE('12:41')).toISOString() });
  await run(TUE('13:00'));
  const c = fake.notified.find((x) => x.kind === 'connect_needed');
  assert.equal(c.subject, 'כדי שהמצגות יעלו, מחברים את טיקטוק ואת אינסטגרם');
  assert.match(c.text, /2 מצגות מאושרות מחכות לחיבור בחשבון alpha\.|2 מצגות מאושרות מחכות לחיבור ב/);
  assert.equal(c.link, 'https://teder.openfrequency.co.il/accounts?account=alpha#connect-alpha');
  const f = fake.notified.find((x) => x.kind === 'publish_failed');
  assert.equal(f.subject, 'המצגת "הפוסט שנפל" לא עלתה');
  assert.match(f.text, /החיבור לטיקטוק הפסיק לעבוד/);
  assert.equal(f.link, `https://teder.openfrequency.co.il/post/${failed}`);
  for (const e of [c, f]) assert.doesNotMatch(`${e.subject}\n${e.text}`, /[—–]/);
  await run(TUE('18:00'));
  assert.equal(fake.notified.length, 2, 'once a day, and once per post');
  await run(at('2026-10-14', '09:00'));
  assert.deepEqual(kinds().slice(2), ['connect_needed'], 'still held the next day: told again, the failure not');
});

test('the Settings page: a box per email, saved for the workspace alone', async () => {
  const { cookie } = fake.session(customer(1));
  const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  assert.match(page, /<h2>מיילים<\/h2>/);
  for (const k of ['posts_waiting', 'weekly', 'monthly', 'connect_needed', 'publish_failed']) assert.match(page, new RegExp(`name="em_${k}" value="1" checked`), k);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const res = await fetch(`${base}/settings/email`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1', origin: base }, body: new URLSearchParams({ _csrf: csrf, em_weekly: '1', em_monthly: '1' }) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(emailPrefsOf(db, 1), { posts_waiting: false, weekly: true, monthly: true, connect_needed: false, publish_failed: false });
  assert.deepEqual(emailPrefsOf(db, 2), { posts_waiting: true, weekly: true, monthly: true, connect_needed: true, publish_failed: true });
});
