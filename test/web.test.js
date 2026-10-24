import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, operator, opened, tempHome } from './helpers.js';

// The website: a session accounts vouches for on everything, a CSRF token on every change, Hebrew right to left
// on every page, and the approve and edit flows end to end. Signed in as the owner of the workspace the demo
// account is in, except where a setting is the operator's (the kill switch, each account's plan, developer mode).

let home;
let ctx;
let server;
let base;
let postId;
let fake;
let port;

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  postId = (await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' })).postId;
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'x'.repeat(40), ...fake.env } });
  server = s.server;
  port = s.port;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

/** A session of the demo account's workspace (or the operator's), as the browser's cookie. */
const login = async () => fake.session(customer(1)).cookie;
const loginOperator = async () => fake.session(operator()).cookie;
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function csrfOf(cookie) {
  const html = await (await get('/accounts', cookie)).text();
  return /name="_csrf" value="([^"]+)"/.exec(html)[1];
}
const post = (p, cookie, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams(body).toString() });

test('every page needs a session: without one the browser goes to accounts\' login, with where it was going', async () => {
  for (const p of ['/', '/posts', '/accounts', '/results', '/sources', '/rivals', '/settings', `/post/${postId}`, `/media/${postId}/tiktok/0`, '/sources?account=demo']) {
    const res = await get(p);
    assert.equal(res.status, 303, p);
    assert.equal(res.headers.get('location'), `https://accounts.test/login?next=${encodeURIComponent(`http://127.0.0.1:${port}${p}`)}`, p);
  }
  assert.equal((await fetch(`${base}/login`, { redirect: 'manual' })).status, 303, "Teder's own login page is gone");
});

test('a session accounts does not know is sent to the login, and a request for another host is refused', async () => {
  const res = await get('/', 'of_session=not-a-session-accounts-knows-0000');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^https:\/\/accounts\.test\/login\?next=/);
  // fetch cannot set Host, so this one goes through node:http.
  const status = await new Promise((resolve) => http.get(`${base}/`, { headers: { host: 'evil.example.com' } }, (r) => (r.resume(), resolve(r.statusCode))));
  assert.equal(status, 421);
});

test('every page is Hebrew, right to left, and escapes what it shows (hard rule 8)', async () => {
  const cookie = await login();
  for (const p of ['/', '/posts', '/accounts', '/results', '/sources', '/rivals', '/settings', '/more', '/new', `/post/${postId}`]) {
    const res = await get(p, cookie);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.match(html, /<html lang="he" dir="rtl"/, p);
    assert.ok(!/<script>/.test(html), `${p} has no inline script`);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  }
  // The page a session sees when accounts says Teder is not in its plan stands alone: Hebrew, Teder's wave, no redirect.
  const gate = await get('/', fake.session({ status: 403, body: { error: 'product_disabled' } }).cookie);
  assert.equal(gate.status, 403);
  const gateHtml = await gate.text();
  assert.match(gateHtml, /<html lang="he" dir="rtl"/);
  assert.match(gateHtml, /<link rel="icon" href="\/static\/icon\.svg\?v=\w+"/, 'the favicon link carries the version, so a new icon is fetched');
  assert.match(gateHtml, /<div class="hero"><span class="mark teder"[^>]*><svg viewBox="0 0 100 100"><path [^>]*stroke="currentColor"/, "the page shows Teder's wave");
  const fav = await get('/favicon.ico');
  assert.equal(fav.status, 200, 'the favicon is served without a session, not redirected to the login');
  assert.equal(fav.headers.get('content-type'), 'image/png');
});

test('results lead with what the published posts did; the formats and the blocks wait behind a button each', async () => {
  const cookie = await login();
  const html = await (await get('/results', cookie)).text();
  assert.match(html, /<div class="kpi lead"><span class="l">צפיות<\/span>/, 'views lead');
  assert.ok(html.indexOf('class="kpi lead"') < html.indexOf('<details class="more" id="formats">'), 'the formats come after the numbers');
  assert.match(html, /<details class="more" id="formats"><summary class="btn sm">[\s\S]*?פורמטים<\/summary><div class="more-in">[\s\S]*? · פורמטים<\/h2>/, 'the formats tables are inside the fold');
  assert.doesNotMatch(html, /<h2>מנצחים<\/h2>/);
});

test('home is the overview: what went out leads, what needs you, one row per account; the cards are on Posts', async () => {
  const cookie = await login();
  const home = await (await get('/', cookie)).text();
  assert.match(home, /class="kpis"/);
  assert.match(home, /class="kpi lead" href="\/posts#published"><span class="l">פורסמו היום<\/span><span class="v num">0<\/span>/, 'what went out leads');
  assert.match(home, /<span class="l">מחכים לאישור<\/span><b class="cnt num sig">1<\/b>/);
  assert.doesNotMatch(home, /נחסמו/, 'what the checks stopped is not on home');
  assert.match(home, /<footer class="foot"><span class="mark of"[^>]*>.*OpenFrequency<sup>™<\/sup><\/span><\/footer>/s, "the foot is the company's mark and the trademark");
  assert.match(home, /<a class="brand"[^>]*><span class="mark teder"/, "the header carries Teder's mark");
  assert.doesNotMatch(home, /מצב הקלטות|מצב חי/, 'no mode or user name as a watermark');
  assert.match(home, new RegExp(`href="/posts#post-${postId}"`), 'the waiting post is one line that leads to its card');
  assert.doesNotMatch(home, /data-post/, 'no post card, no slides, no captions on home');
  assert.doesNotMatch(home, /class="strip/);
  const posts = await (await get('/posts', cookie)).text();
  assert.match(posts, new RegExp(`id="post-${postId}"[^>]*data-post`));
  assert.match(posts, /aria-current="page"[^>]*>.*?<span>פוסטים<\/span>/s);
});

test('a change without its CSRF token is refused', async () => {
  const cookie = await login();
  const res = await post(`/post/${postId}/approve`, cookie, {});
  assert.equal(res.status, 403);
  assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', postId).status, 'queued');
});

test('a slide image is served only to a session, and only from inside the data folder', async () => {
  const cookie = await login();
  const res = await get(`/media/${postId}/tiktok/0`, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await get(`/media/${postId}/tiktok/99`, cookie)).status, 404);
});

test('an edit that invents a number is refused and nothing is saved', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  const before = ctx.db.get('SELECT body FROM slides WHERE post_id = ? AND idx = 1', postId).body;
  const res = await post(`/post/${postId}/edit`, cookie, { _csrf: csrf, hook: 'בזיליקום במרפסת: 5 דברים שקובעים אם הוא ישרוד', sub: '', title_0: 'שמש', body_0: 'בזיליקום צריך לפחות 12 שעות שמש ישירה ביום.', caption: 'כיתוב קצר ופשוט לבדיקה.' });
  assert.equal(res.status, 422);
  const out = await res.json();
  assert.match(out.problems.join(' '), /number 12/);
  assert.equal(ctx.db.get('SELECT body FROM slides WHERE post_id = ? AND idx = 1', postId).body, before);
});

test('a clean edit is checked, re-rendered and remembered as an example of the owner\'s voice', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  const res = await post(`/post/${postId}/edit`, cookie, { _csrf: csrf, hook: '5 דברים שקובעים אם הבזיליקום במרפסת ישרוד', sub: 'ההבדל בין עציץ עייף לשיח מלא', caption: 'בזיליקום הוא צמח של קיץ, וכל אחד מהדברים האלה משפיע עליו.' });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(ctx.db.get('SELECT sub FROM posts WHERE id = ?', postId).sub, 'ההבדל בין עציץ עייף לשיח מלא');
  assert.ok(ctx.db.get('SELECT COUNT(*) AS n FROM edits WHERE post_id = ?', postId).n >= 1);
});

test('approve in one tap, with the token', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  const res = await post(`/post/${postId}/approve`, cookie, { _csrf: csrf });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const row = ctx.db.get('SELECT status, approved_by FROM posts WHERE id = ?', postId);
  assert.deepEqual({ ...row }, { status: 'approved', approved_by: 'owner' });
});

test('the kill switch and the mode are set from the Accounts page', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  await post('/accounts/demo/mode', cookie, { _csrf: csrf, mode: 'digest' });
  assert.equal(ctx.db.get("SELECT mode FROM accounts WHERE id = 'demo'").mode, 'digest');
  await post('/accounts/demo/kill', cookie, { _csrf: csrf });
  const acc = ctx.db.get("SELECT status, paused_reason FROM accounts WHERE id = 'demo'");
  assert.deepEqual({ ...acc }, { status: 'paused', paused_reason: 'kill' });
  const page = await (await get('/accounts', cookie)).text();
  assert.match(page, /מתג הכיבוי הופעל/);
  await post('/accounts/demo/resume', cookie, { _csrf: csrf });
  assert.equal(ctx.db.get("SELECT status FROM accounts WHERE id = 'demo'").status, 'active');
});

test("Settings are the operator's; developer mode, opened from the version line, shows which keys are set, never their values", async () => {
  process.env.PEXELS_API_KEY = 'secret-value-that-must-not-show';
  const cookie = await loginOperator();
  const plain = await (await get('/settings', cookie)).text();
  assert.ok(!plain.includes('PEXELS_API_KEY'), "no keys on the owner's page");
  assert.ok(!plain.includes('npm run'), 'no commands either');
  assert.match(plain, /<form method="post" action="\/settings\/dev" class="ver" data-devtap>/);
  const csrf = await csrfOf(cookie);
  const res = await fetch(`${base}/settings/dev`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, on: '1' }).toString() });
  assert.match(res.headers.get('set-cookie'), /of_dev=1; .*HttpOnly/);
  const html = await (await get('/settings', `${cookie}; of_dev=1`)).text();
  delete process.env.PEXELS_API_KEY;
  assert.ok(html.includes('<h2>מצב מפתח</h2>'));
  assert.ok(html.includes('PEXELS_API_KEY'));
  assert.ok(!html.includes('secret-value-that-must-not-show'));
});

test('hand-checked facts are added from the website, refused when malformed, and confirmed again with a new expiry', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  let res = await post('/facts/add', cookie, { _csrf: csrf, account: 'demo', topic: 'השקיה', quote: 'קצר', source: 'משרד החקלאות', url: 'https://www.example.org/x', checkedAt: '2026-10-13', expires: '2027-06-30' });
  assert.equal(res.status, 422);
  assert.ok((await res.json()).problems.some((p) => /קצר מדי/.test(p)));
  res = await post('/facts/add', cookie, { _csrf: csrf, account: 'demo', topic: 'השקיה', quote: 'צמחי תבלין בעציץ צריכים השקיה כשהשכבה העליונה של האדמה יבשה למגע.', source: 'משרד החקלאות', url: 'https://www.example.org/x', checkedAt: '2026-10-13', expires: '2027-06-30' });
  assert.equal(res.status, 200, await res.clone().text());
  // The first fact made the folder, and the folder made the pack's facts source.
  assert.ok(ctx.db.get("SELECT id FROM sources WHERE account_id = 'demo' AND key = 'facts' AND status = 'approved'"));
  const page = await (await get('/facts?account=demo', cookie)).text();
  assert.match(page, /צמחי תבלין בעציץ/);
  assert.match(page, /בתוקף/);
  const id = /name="id" value="([^"]+)"/.exec(page)[1];
  res = await post('/facts/confirm', cookie, { _csrf: csrf, account: 'demo', topic: 'השקיה', id, expires: '2027-10-01' });
  assert.equal(res.status, 200);
  assert.match((await res.json()).message, /2027-10-01/);
});

test('rivals are typed in by hand per account: refused when malformed, shown, updated and removed', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  let html = await (await get('/rivals?account=demo', cookie)).text();
  assert.match(html, /המנוע לא קורא חשבונות של אחרים/);
  assert.match(html, /עוד אין מתחרים/);
  let res = await post('/rivals/save', cookie, { _csrf: csrf, account: 'demo', handle: 'לא תקין', platform: 'tiktok', hooks: '' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).problems.length, 2);
  const rival = { _csrf: csrf, account: 'demo', handle: '@balcony.greens', platform: 'tiktok', hooks: 'הבזיליקום שלכם מת בגלל דבר אחד\n<script>x</script>', formats: 'דירוג', times: '18:00', gaps: 'אף אחד לא מדבר על חורף' };
  res = await post('/rivals/save', cookie, rival);
  assert.equal(res.status, 200, await res.clone().text());
  html = await (await get('/rivals?account=demo', cookie)).text();
  assert.match(html, /@balcony\.greens/);
  assert.match(html, /הבזיליקום שלכם מת בגלל דבר אחד/);
  assert.ok(!html.includes('<script>x</script>'), 'what was typed is escaped');
  assert.match(html, /עוד 2/, 'fewer than three asks for more');
  const id = /name="id" value="(\d+)"/.exec(html)[1];
  res = await post('/rivals/save', cookie, { ...rival, id, hooks: 'שער אחר', gaps: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(ctx.db.get('SELECT hooks_json FROM rivals WHERE id = ?', Number(id)).hooks_json), ['שער אחר']);
  assert.match(await (await get('/accounts', cookie)).text(), /href="\/rivals\?account=demo"/);
  res = await post('/rivals/remove', cookie, { _csrf: csrf, account: 'demo', id });
  assert.equal(res.status, 200);
  assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM rivals').n, 0);
  assert.ok(ctx.db.get("SELECT id FROM audit WHERE action = 'rival_removed'"));
});

test("the Settings page shows the operator what the month cost, with no cap to set; each account's cost per post is developer mode's", async () => {
  const cookie = await loginOperator();
  const html = await (await get('/settings', cookie)).text();
  assert.match(html, /id="costs"/);
  assert.match(html, /אין תקרת הוצאה/);
  for (const s of ['תקציב חודשי', 'תחזית לסוף החודש', 'OF_BUDGET_MONTHLY_USD', 'action="/settings/budget"', 'name="cap"']) assert.ok(!html.includes(s), s);
  const dev = await (await get('/settings', `${cookie}; of_dev=1`)).text();
  assert.ok(dev.includes('לפוסט, 30 יום'));
  // The operator reads dollars, as the ledger counts: there are no tokens.
  assert.doesNotMatch(html, /טוקנ/);
  const csrf = await csrfOf(cookie);
  const res = await post('/settings/budget', cookie, { _csrf: csrf, budget: '10' });
  assert.equal(res.status, 404, 'the old cap form is gone');
});

test("a customer's Settings say the plan: 40 suggestions, 10 redos, small changes free; never the budget or money", async () => {
  const cookie = await login();
  const html = await (await get('/settings', cookie)).text();
  assert.match(html, /id="plan"/);
  assert.match(html, /40 הצעות לפוסטים, ו-10 החלפות/);
  assert.match(html, /שינויים קטנים לא נספרים בכלל/);
  assert.match(html, /נוצלו \d+ מתוך 40 הצעות · \d+ מתוך 10 החלפות/);
  assert.ok(!html.includes('תקציב חודשי'), "the budget is the operator's");
  for (const p of ['/', '/settings', '/accounts']) assert.doesNotMatch(await (await get(p, cookie)).text(), /טוקנ|\$\d/, `${p} shows tokens or dollars`);
  assert.match(await (await get('/', cookie)).text(), /<span class="lbl">הצעות<\/span>/, "the header counts the month's suggestions");
});

test('a changed theme.json waits on the Accounts page until the owner applies it', async () => {
  const cookie = await login();
  const pack = ctx.pack('demo');
  const before = pack.theme.colors.accent;
  try {
    await get('/accounts', cookie);
    pack.theme.colors.accent = '#0F5E9C';
    const page = await (await get('/accounts', cookie)).text();
    assert.match(page, /הסגנון בקובץ theme.json השתנה/);
    const csrf = await csrfOf(cookie);
    const res = await post('/accounts/demo/style', cookie, { _csrf: csrf });
    assert.equal(res.status, 200);
    assert.doesNotMatch(await (await get('/accounts', cookie)).text(), /הסגנון בקובץ theme.json השתנה/);
  } finally {
    pack.theme.colors.accent = before;
  }
});

test('sounds are added per account, the service worker is served from the root, and a browser can ask for notifications', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  let res = await post('/sounds/save', cookie, { _csrf: csrf, account: 'demo', name: 'Espresso', artist: 'Sabrina Carpenter', link: 'https://www.tiktok.com/music/Espresso-123' });
  assert.equal(res.status, 200);
  const page = await (await get('/sounds?account=demo', cookie)).text();
  assert.match(page, /Espresso/);
  assert.match(page, /טרי/);
  res = await post('/sounds/save', cookie, { _csrf: csrf, account: 'demo', name: 'x', artist: 'y', link: 'https://evil.example/a' });
  assert.equal(res.status, 422);
  const sw = await get('/sw.js');
  assert.equal(sw.status, 200, 'the service worker needs no session');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  res = await post('/push/subscribe', cookie, { _csrf: csrf, endpoint: 'https://fcm.googleapis.com/fcm/send/test-browser' });
  assert.equal(res.status, 200);
  assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM push_subs').n, 1);
  assert.match(await (await get('/settings', cookie)).text(), /data-push="[A-Za-z0-9_-]{80,}"/, 'the page carries the public key the browser subscribes with');
  ctx.db.insert('notifications', { account_id: 'demo', kind: 'draft', title: 'עציץ ושמש: טיוטה מחכה בטיקטוק', body: 'b', url: '/', created_at: new Date().toISOString() });
  assert.equal((await get('/notifications/latest.json')).status, 303, 'what a notification says is behind the session');
  assert.match((await (await get('/notifications/latest.json', cookie)).json()).title, /טיוטה מחכה/);
});

test('the topics page: a topic added to the bank waits first in line, and its form refuses a link that is not one', async () => {
  const cookie = await login();
  const csrf = await csrfOf(cookie);
  let res = await post('/topics/add', cookie, { _csrf: csrf, account: 'demo', title: 'הצמח ששרד שנה בלי מים', why: 'מיליון צפיות', url: 'not a link' });
  assert.equal(res.status, 422);
  res = await post('/topics/add', cookie, { _csrf: csrf, account: 'demo', title: 'הצמח ששרד שנה בלי מים', why: 'מיליון צפיות', url: 'https://www.tiktok.com/@x/video/1' });
  assert.equal(res.status, 200);
  const html = await (await get('/topics', cookie)).text();
  assert.match(html, /<h2>הבאים בתור<\/h2>[\s\S]*הצמח ששרד שנה בלי מים[\s\S]*<span class="tscore none"/, 'in line, waiting for its score');
  assert.match(html, /name="names"/, 'the watch list is edited here');
  res = await post('/topics/watch', cookie, { _csrf: csrf, account: 'demo', names: 'Epipremnum aureum\nMonstera deliciosa' });
  assert.equal(res.status, 200);
  assert.match(await (await get('/topics', cookie)).text(), /Epipremnum aureum\nMonstera deliciosa/);
});
