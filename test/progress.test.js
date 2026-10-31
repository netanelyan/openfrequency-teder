import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { __onboarding } from '../src/web/onboarding.js';
import { customer, fakeAccounts, operator, opened, tempHome, viewingAs } from './helpers.js';

// Home's block of work in progress (src/web/progress.js; the owner, 2026-10-31: "when something is being done, i want
// the main dashboard page show a block that shows whats loading, and when done, a url to the place"). A new account's
// search for sources and its sample posts, and the slideshows being written for the account shown: while they run, with
// how far they got; done, with the way to the result, until the next step is taken and a day at most; none of it when
// nothing runs. The page asks GET /progress.json while something runs and changes in place, never a reload.

let home;
let ctx;
let db;
let fake;
let server;
let base;
const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'g'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

afterEach(() => {
  __onboarding.running.clear();
  __onboarding.progress.clear();
  db.run('DELETE FROM onboarding');
  db.run("DELETE FROM posts WHERE id LIKE 'p-prog-%'");
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const status = async (cookie) => (await get('/progress.json', cookie)).json();
const homeOf = async (cookie) => (await get('/', cookie)).text();

/** A new account's search for sources, still running in this process, `done` of `total` sites checked. */
function searching(id, ws, { done = 3, total = 8, niche = 'כדורגל' } = {}) {
  const t = iso(Date.now());
  db.insert('onboarding', { id, seed_json: { niche, examples: [] }, status: 'discovering', workspace_id: ws, created_at: t, updated_at: t });
  __onboarding.running.set(id, new Promise(() => {}));
  __onboarding.progress.set(id, { step: 'sites', done, total });
}
/** The search ended: its sources wait to be chosen. */
function found(id) {
  __onboarding.running.delete(id);
  __onboarding.progress.delete(id);
  db.run("UPDATE onboarding SET status = 'review', candidates_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ candidates: [] }), iso(Date.now()), id);
}
let n = 0;
const post = (status, over = {}) => {
  const id = `p-prog-${++n}`;
  const t = iso(Date.now());
  db.insert('posts', { id, account_id: 'demo', status, hook: status === 'drafting' ? null : `כותרת ${n}`, sample: 0, created_at: t, updated_at: t, ...over });
  return id;
};

test('nothing running and nothing done today: no block on home, and the JSON is empty', async () => {
  const { cookie } = fake.session(customer(1));
  const html = await homeOf(cookie);
  assert.doesNotMatch(html, /class="panel home-panel inprog"|data-poll|<h2 id="inprog-h">/);
  const res = await get('/progress.json', cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { busy: false, key: '', lines: {}, items: [], html: '' });
});

test('a search for sources: on home with how far it got, polled; its line moves alone; done, the block says so with the way to choose', async () => {
  const { cookie } = fake.session(customer(1));
  searching('o-run', 1);
  const html = await homeOf(cookie);
  // Under the day's numbers, over what needs the owner; asked about while it runs, and drawn again in place.
  assert.match(html, /<section class="panel home-panel inprog" id="inprog" aria-labelledby="inprog-h" data-poll="\/progress\.json" data-key="o:o-run:sources:running" data-swap><header><h2 id="inprog-h">בתהליך<\/h2><\/header>/);
  assert.ok(html.indexOf('class="kpis"') < html.indexOf('id="inprog"') && html.indexOf('id="inprog"') < html.indexOf('<h2>צריך אותך</h2>'), 'under the numbers, over what needs you');
  assert.match(html, /<li class="running" data-item="o:o-run:sources"><span class="ico"><span class="spin" aria-hidden="true"><\/span><\/span><span class="tx"><b>מחפשים מקורות<\/b><span class="sub"><bdi>כדורגל<\/bdi><span data-progress="o:o-run:sources" aria-live="polite">עכשיו בודקים אתרים, 3 מתוך 8\.<\/span><\/span><\/span><\/li>/);
  assert.doesNotMatch(html.slice(html.indexOf('id="inprog"'), html.indexOf('<h2>צריך אותך</h2>')), /class="btn/, 'no link while it runs');
  assert.match(html, /<p class="small m6 js-hide"><a href="\/">לבדוק שוב<\/a><\/p>/, 'without the script, a link to look again');

  const s1 = await status(cookie);
  assert.equal(s1.busy, true);
  assert.equal(s1.key, 'o:o-run:sources:running');
  assert.deepEqual(s1.lines, { 'o:o-run:sources': 'עכשיו בודקים אתרים, 3 מתוך 8.' });
  assert.deepEqual(s1.items, [{ id: 'o:o-run:sources', state: 'running', title: 'מחפשים מקורות', subject: 'כדורגל', line: 'עכשיו בודקים אתרים, 3 מתוך 8.', href: null, go: null }]);
  // Further on: only the line changes, not the key (no drawing again).
  __onboarding.progress.set('o-run', { step: 'score' });
  const s2 = await status(cookie);
  assert.equal(s2.key, s1.key);
  assert.equal(s2.lines['o:o-run:sources'], 'כמעט סיימנו, בודקים כל מקור.');

  // Done: the key changes, the item is ready with the way to the sources, nothing is asked any more.
  found('o-run');
  const s3 = await status(cookie);
  assert.equal(s3.busy, false);
  assert.equal(s3.key, 'o:o-run:sources:ready');
  assert.deepEqual(s3.items, [{ id: 'o:o-run:sources', state: 'ready', title: 'המקורות מוכנים, אפשר לבחור', subject: 'כדורגל', line: '', href: '/new/o-run#sources', go: 'לבחור מקורות' }]);
  assert.match(s3.html, /<li class="ready" data-item="o:o-run:sources"><span class="ico"><svg class="i" aria-hidden="true"><use href="#i-check"\/><\/svg><\/span><span class="tx"><b>המקורות מוכנים, אפשר לבחור<\/b><span class="sub"><bdi>כדורגל<\/bdi><\/span><\/span><a class="btn sm" href="\/new\/o-run#sources">לבחור מקורות<\/a><\/li>/);
  assert.doesNotMatch(s3.html, /לבדוק שוב/);
  const done = await homeOf(cookie);
  assert.match(done, /<section class="panel home-panel inprog" id="inprog" aria-labelledby="inprog-h"><header>/, 'drawn by the server too, and not polled');
  assert.match(done, /href="\/new\/o-run#sources">לבחור מקורות<\/a>/);

  // The next step taken (the account created from the sources), and the block is gone.
  db.run("UPDATE onboarding SET status = 'samples' WHERE id = 'o-run'");
  assert.deepEqual((await status(cookie)).items, []);
  assert.doesNotMatch(await homeOf(cookie), /id="inprog"/);
  // Or not taken, a day later: gone too, and still listed on /new.
  db.run("UPDATE onboarding SET status = 'review', updated_at = ? WHERE id = 'o-run'", iso(Date.now() - 25 * H));
  assert.deepEqual((await status(cookie)).items, []);
  assert.match(await (await get('/new', cookie)).text(), /href="\/new\/o-run"/);
});

test('a search that stopped, or that a restart cut off, is said with the way to try again; nothing is written', async () => {
  const { cookie } = fake.session(customer(1));
  const t = iso(Date.now());
  db.insert('onboarding', { id: 'o-cut', seed_json: { niche: 'צילום' }, status: 'discovering', workspace_id: 1, created_at: t, updated_at: t });
  const s = await status(cookie);
  assert.deepEqual(s.items, [{ id: 'o:o-cut:sources', state: 'stopped', title: 'החיפוש נעצר', subject: 'צילום', line: 'אפשר לנסות שוב עם אותם פרטים.', href: '/new/o-cut', go: 'להמשיך' }]);
  assert.equal(db.get("SELECT status FROM onboarding WHERE id = 'o-cut'").status, 'discovering', 'home only reads; the setup page marks it, as before');
  assert.match(s.html, /<li class="stopped"[^>]*><span class="ico"><svg class="i" aria-hidden="true"><use href="#i-alert"\/>/);
  db.run("UPDATE onboarding SET status = 'failed', candidates_json = ? WHERE id = 'o-cut'", JSON.stringify({ failure: 'timeout' }));
  assert.equal((await status(cookie)).items[0].state, 'stopped');
});

test('sample posts: being written with how many are ready, then ready with the way to them, until they are gone through', async () => {
  const { cookie } = fake.session(customer(1));
  const t = iso(Date.now());
  db.insert('onboarding', { id: 'o-smp', seed_json: { niche: 'צמחים' }, status: 'samples', pack_id: 'demo', workspace_id: 1, created_at: t, updated_at: t });
  __onboarding.running.set('o-smp', new Promise(() => {}));
  __onboarding.progress.set('o-smp', { step: 'read' });
  const name = ctx.pack('demo').meta.displayName;
  assert.deepEqual((await status(cookie)).items, [{ id: 'o:o-smp:samples', state: 'running', title: 'פוסטים לדוגמה', subject: name, line: 'קוראים את המקורות שבחרתם.', href: null, go: null }]);
  __onboarding.progress.set('o-smp', { step: 'write', done: 2, total: 5 });
  assert.equal((await status(cookie)).lines['o:o-smp:samples'], 'כותבים פוסטים לדוגמה, 2 מתוך 5 מוכנים.');

  // Five written: ready, with the way to them.
  __onboarding.running.delete('o-smp');
  for (let i = 0; i < 5; i++) post('sample', { sample: 1 });
  db.run('UPDATE onboarding SET candidates_json = ? WHERE id = ?', JSON.stringify({ samples: { made: 5, failure: null, at: iso(Date.now()) } }), 'o-smp');
  const ready = await status(cookie);
  assert.deepEqual(ready.items, [{ id: 'o:o-smp:samples', state: 'ready', title: 'הפוסטים לדוגמה מוכנים', subject: name, line: '5 דוגמאות עברו את כל הבדיקות.', href: '/new/o-smp', go: 'להמשיך' }]);
  // Too few, and why, from the setup page's own words.
  db.run('UPDATE onboarding SET candidates_json = ? WHERE id = ?', JSON.stringify({ samples: { made: 2, failure: 'nofacts', at: iso(Date.now()) } }), 'o-smp');
  const few = (await status(cookie)).items[0];
  assert.deepEqual([few.state, few.title, few.go], ['stopped', '2 מתוך 5 פוסטים לדוגמה מוכנים', 'להמשיך']);
  assert.match(few.line, /^במקורות שבחרתם לא מצאנו מספיק עובדות לכתוב מהן\./);
  // Gone through: the next step, and the block is gone.
  db.run("UPDATE onboarding SET status = 'ready' WHERE id = 'o-smp'");
  assert.deepEqual((await status(cookie)).items, []);
});

test('a slideshow being written, a new one or a replacement; once written it waits with the way to it, until it is decided', async () => {
  const { cookie } = fake.session(customer(1));
  const fresh = post('drafting');
  const redo = post('drafting', { redo_of: 'p-old' });
  post('drafting', { sample: 1 });
  const s = await status(cookie);
  assert.equal(s.busy, true);
  assert.deepEqual(s.items.map((x) => [x.id, x.state, x.title, x.line]).sort(), [
    [`p:${fresh}`, 'running', 'מצגת חדשה בכתיבה', 'תהיה מוכנה בעוד כמה דקות.'],
    [`p:${redo}`, 'running', 'פוסט חלופי נכתב עכשיו', 'הוא יגיע לאישור בעוד כמה דקות.'],
  ], 'a sample is the setup\'s, not listed here');
  // Written: each waits for approval with the way to it; the one the checks stopped leaves the list.
  db.run("UPDATE posts SET status = 'queued', hook = 'חמש טעויות עם בזיליקום' WHERE id = ?", fresh);
  db.run("UPDATE posts SET status = 'blocked' WHERE id = ?", redo);
  const done = await status(cookie);
  assert.deepEqual(done.items, [{ id: `p:${fresh}`, state: 'ready', title: 'מצגת חדשה מחכה לאישור', subject: 'חמש טעויות עם בזיליקום', line: '', href: `/post/${fresh}`, go: 'לפוסט' }]);
  assert.notEqual(done.key, s.key);
  // Approved: decided, gone. One written two days ago that still waits is on Posts, not here.
  db.run("UPDATE posts SET status = 'approved' WHERE id = ?", fresh);
  post('queued', { created_at: iso(Date.now() - 48 * H) });
  assert.deepEqual((await status(cookie)).items, []);
});

test("the block keeps to its workspace: another customer sees none of it, the operator sees every setup, view-as sees the customer's", async () => {
  searching('o-ws1', 1, { niche: 'בישול טבעוני' });
  post('drafting');
  const other = fake.session(customer(2)).cookie;
  assert.deepEqual(await status(other), { busy: false, key: '', lines: {}, items: [], html: '' });
  const otherHome = await homeOf(other);
  assert.doesNotMatch(otherHome, /id="inprog"|בישול טבעוני|מצגת חדשה בכתיבה/);
  // The operator: every workspace's setups, as /new lists them, and the account shown's posts.
  const op = await status(fake.session(operator()).cookie);
  assert.deepEqual(op.items.map((x) => x.id).sort(), ['o:o-ws1:sources', op.items.find((x) => x.id.startsWith('p:')).id].sort());
  // The operator viewing workspace 1 as its customer sees what the customer sees, and changes nothing by looking.
  const view = await status(fake.session(viewingAs(1)).cookie);
  assert.equal(view.items.length, 2);
  const theirs = await status(fake.session(customer(1)).cookie);
  assert.deepEqual(view, theirs);
});

test('in a real browser: the line moves in place, and when the search ends the block shows the way to the sources without a reload', async () => {
  const { sid } = fake.session(customer(1));
  searching('o-live', 1, { done: 1, total: 8 });
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
    const page = await context.newPage();
    let loads = 0;
    page.on('framenavigated', (f) => f === page.mainFrame() && loads++);
    await page.goto(`${base}/`);
    const line = page.locator('[data-progress="o:o-live:sources"]');
    assert.equal(await line.textContent(), 'עכשיו בודקים אתרים, 1 מתוך 8.');
    assert.equal(await page.getByText('לבדוק שוב').isVisible(), false, 'the no-script link is hidden with the script');
    await page.evaluate(() => (window.__same = true));

    __onboarding.progress.set('o-live', { step: 'sites', done: 5, total: 8 });
    await page.waitForFunction(() => document.querySelector('[data-progress="o:o-live:sources"]')?.textContent === 'עכשיו בודקים אתרים, 5 מתוך 8.', null, { timeout: 15_000 });

    found('o-live');
    const go = page.locator('#inprog a[href="/new/o-live#sources"]');
    await go.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await go.textContent(), 'לבחור מקורות');
    assert.equal(await page.locator('#inprog .spin').count(), 0);
    assert.equal(await page.evaluate(() => window.__same), true, 'the same page: drawn again in place');
    assert.equal(loads, 1, 'never reloaded');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll at 390');
    // The link goes where it says.
    await go.click();
    await page.waitForURL(`${base}/new/o-live#sources`);
  } finally {
    await browser?.close();
  }
});
