import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { publishPost } from '../src/publish/index.js';
import { startRunner, writeSummaries } from '../src/autonomy/runner.js';
import { emailTick } from '../src/notify/email.js';
import { alertNotLive, diskOnly, notLive, shownStatus } from '../src/publish/live.js';
import { getSetting } from '../src/core/store.js';
import { setNow } from '../src/core/clock.js';
import { ROOT } from '../src/core/paths.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, listenFree, operator, paidWorkspaces, tempHome } from './helpers.js';

// Posts do not go out silently (the owner, 2026-11-04): while PUBLISH_MODE is not live or ZERNIO_API_KEY is unset,
// every post that comes due is only written to disk (src/publish/live.js). The operator hears it when the runner starts
// and once a day, /all shows it in red at the top, and no customer page calls such a post published.

const DAY = 86_400_000;
const TUE = (hm) => israelInstant('2026-10-13', hm).getTime();
const iso = (t) => new Date(t).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** No alert command and no Toran: the alert is logged and kept, and nothing leaves the test. */
const QUIET = { OF_ALERT_CMD: path.join(ROOT, 'no-such-alert-command'), OF_TORAN_INTERNAL: 'off' };

let home;
let db;
let ctx;
let fake;
let server;
let base;
let env;

before(async () => {
  home = tempHome({
    packs: {
      // As a customer's account is made: TikTok and Instagram through Zernio.
      demo: (f) => {
        delete f.pack.publisher;
        f.pack.publishers = { tiktok: 'zernio', instagram: 'zernio' };
      },
    },
  });
  // Not in `opened`: closed in after().
  db = new Db(path.join(home.home, 'data.db'));
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  // Paid, as accounts said it; dated after every clock this file pins.
  paidWorkspaces(db, [1], { at: '2026-12-31T00:00:00.000Z' });
  fake = await fakeAccounts();
  // The server's environment, read at each request: the tests below turn publishing on in it.
  env = { ...process.env, SESSION_SECRET: 'n'.repeat(40), ...fake.env, PUBLISH_MODE: 'dry' };
  delete env.ZERNIO_API_KEY;
  const s = await listenFree(ctx, { env });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  setNow(null);
  await new Promise((r) => (server ? server.close(r) : r()));
  await fake?.close();
  await closeBrowser();
  db?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function page(p, cookie) {
  const res = await get(p, cookie);
  assert.equal(res.status, 200, p);
  return res.text();
}

/* ------------------------------------------------------------------ what is off */

test('what keeps every post on disk: PUBLISH_MODE not live, ZERNIO_API_KEY unset; live with a key is nothing', () => {
  assert.deepEqual(notLive({}), ['PUBLISH_MODE', 'ZERNIO_API_KEY']);
  assert.deepEqual(notLive({ PUBLISH_MODE: 'dry', ZERNIO_API_KEY: 'zk_test' }), ['PUBLISH_MODE']);
  assert.deepEqual(notLive({ PUBLISH_MODE: 'live', ZERNIO_API_KEY: '  ' }), ['ZERNIO_API_KEY']);
  assert.deepEqual(notLive({ PUBLISH_MODE: 'Live', ZERNIO_API_KEY: 'zk_test' }), ['PUBLISH_MODE'], 'exactly "live", as the publisher reads it');
  assert.deepEqual(notLive({ PUBLISH_MODE: 'live', ZERNIO_API_KEY: 'zk_test' }), []);
  // A post is only on disk when every part it sent was written there; a skipped platform is not a part.
  assert.equal(diskOnly({ tiktok: { via: 'dry', status: 'written' }, instagram: { via: 'dry', status: 'written' } }), true);
  assert.equal(diskOnly(JSON.stringify({ tiktok: { via: 'dry', status: 'written' }, facebook: { via: 'zernio', skipped: 'not_connected' } })), true);
  assert.equal(diskOnly({ tiktok: { via: 'zernio', zernioId: 'z1', status: 'published' }, instagram: { via: 'dry', status: 'written' } }), false, 'out on one platform is out');
  assert.equal(diskOnly({ tiktok: { via: 'dry', status: 'written', demo: true } }), false, "the demo's posts are shown as out");
  assert.equal(diskOnly(null), false, 'a post with no record (one made by hand) is as it says');
  assert.equal(shownStatus({ status: 'published', publish: { tiktok: { via: 'dry' } } }), 'written');
  assert.equal(shownStatus({ status: 'approved', publish: { tiktok: { via: 'dry' } } }), 'approved');
});

/* ------------------------------------------------------------------ the alert */

/** Start the runner and wait for its first tick to end; returns stop(). */
async function started(c, opts) {
  const stop = startRunner(c, opts);
  const st = c.runnerState;
  for (let i = 0; i < 400 && !(st.endedAt >= st.startedAt); i++) await sleep(25);
  return () => {
    stop();
    return st;
  };
}

test('the operator hears that posts are not going out when the runner starts, and once a day after it, and not while publishing is live', async () => {
  // A database of its own, beside the file's.
  const h = home.home;
  const d = new Db(path.join(h, 'alerts.db'));
  const logs = [];
  try {
    const c = makeContext({ db: d, packs: loadAll({ dir: path.join(h, 'packs') }), log: (m) => logs.push(m) });
    // Accounts still being set up: the runner's ticks have nothing else to do.
    d.run("UPDATE accounts SET status = 'onboarding'");
    const off = { OF_HOME: h, PUBLISH_MODE: 'dry', ...QUIET };
    const said = () => logs.filter((l) => l.startsWith('[alert] Teder: הפרסום כבוי, ופוסטים לא יוצאים לרשתות: '));

    setNow(TUE('09:00'));
    (await started(c, { env: off }))();
    assert.equal(said().length, 1, `at the start: ${logs.join('\n')}`);
    const kept = getSetting(d, 'alert:publishing-off');
    assert.equal(kept.title, 'Teder: הפרסום כבוי, ופוסטים לא יוצאים לרשתות', 'kept for the health table on /all');
    assert.equal(kept.at, iso(TUE('09:00')));
    for (const s of ['PUBLISH_MODE הוא "dry" ולא live.', 'ZERNIO_API_KEY לא מוגדר.', 'נכתב לדיסק ולא נשלח לטיקטוק, לאינסטגרם או לפייסבוק', 'כדי לפרסם באמת צריך PUBLISH_MODE=live ו-ZERNIO_API_KEY ב-', path.join(h, '.env'), 'systemctl restart openfrequency']) {
      assert.ok(kept.body.includes(s), `"${s}" in: ${kept.body}`);
    }

    // Started again the same day: the alert's own window (a day) says it once.
    setNow(TUE('15:00'));
    (await started(c, { env: off }))();
    assert.equal(said().length, 1, 'once a day, a restart included');

    // A day after the first, a beat of the running runner says it again, with no restart.
    const stop = await started(c, { env: off, everyMs: 20 });
    setNow(TUE('09:00') + DAY + 60_000);
    for (let i = 0; i < 400 && said().length < 2; i++) await sleep(10);
    const st = stop();
    for (let i = 0; i < 400 && !(st.endedAt >= st.startedAt); i++) await sleep(25);
    assert.equal(said().length, 2, 'the next day');
    assert.equal(getSetting(d, 'alert:publishing-off').at, iso(TUE('09:00') + DAY + 60_000));

    // Live with a key: nothing to say, whatever the window.
    assert.equal(await alertNotLive(c, { t: TUE('09:00') + 5 * DAY, env: { ...off, PUBLISH_MODE: 'live', ZERNIO_API_KEY: 'zk_test' } }), false);
    // Live without a key: still off, and said.
    assert.equal(await alertNotLive(c, { t: TUE('09:00') + 5 * DAY, env: { ...off, PUBLISH_MODE: 'live' } }), true);
    assert.match(said().at(-1), /ZERNIO_API_KEY לא מוגדר\./);
    assert.doesNotMatch(said().at(-1), /PUBLISH_MODE הוא/);
  } finally {
    setNow(null);
    d.close();
  }
});

/* ------------------------------------------------------------------ /all */

test('/all is red at the top for the operator while posts are not going out, never for a customer, and not once publishing is live with a key', async () => {
  const op = fake.session(operator()).cookie;
  try {
    let html = await page('/all', op);
    const red = /<div class="banner bad" id="not-live">[\s\S]*?<\/div><\/div>/.exec(html)?.[0];
    assert.ok(red, 'the red banner');
    assert.ok(html.indexOf('id="not-live"') < html.indexOf('class="acctab"'), 'at the top, above the accounts');
    assert.ok(html.indexOf('<h1>כל החשבונות</h1>') < html.indexOf('id="not-live"'), 'under the heading');
    assert.match(red, /<b>הפרסום כבוי, ופוסטים לא יוצאים לרשתות<\/b>/);
    assert.match(red, /<bdi>PUBLISH_MODE<\/bdi> הוא <bdi>&quot;dry&quot;<\/bdi> ולא <bdi>live<\/bdi>\./);
    assert.match(red, /<bdi>ZERNIO_API_KEY<\/bdi> לא מוגדר\./);
    assert.match(red, /כדי לפרסם באמת צריך <bdi>PUBLISH_MODE=live<\/bdi> ו-<bdi>ZERNIO_API_KEY<\/bdi> ב-<bdi>[^<]+\.env<\/bdi>, ואז <bdi>systemctl restart openfrequency<\/bdi>\./);

    const mine = await page('/all', fake.session(customer(1)).cookie);
    assert.doesNotMatch(mine, /not-live|הפרסום כבוי|PUBLISH_MODE/, "a customer's /all has none of it");

    env.PUBLISH_MODE = 'live';
    html = await page('/all', op);
    assert.match(html, /id="not-live"/, 'live without a key: still red');
    assert.doesNotMatch(/<div class="banner bad" id="not-live">[\s\S]*?<\/div><\/div>/.exec(html)[0], /PUBLISH_MODE/);

    env.ZERNIO_API_KEY = 'zk_test_key';
    html = await page('/all', op);
    assert.doesNotMatch(html, /id="not-live"/, 'live with a key: nothing red');
  } finally {
    env.PUBLISH_MODE = 'dry';
    delete env.ZERNIO_API_KEY;
  }
});

/* ------------------------------------------------------------------ a post written to disk */

/** A copy of a built post (a recorded draft builds once), slides and facts included. */
function copyOf(id, to) {
  const cols = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  const pc = cols('posts').filter((c) => c !== 'id');
  db.run(`INSERT INTO posts (id, ${pc.join(', ')}) SELECT ?, ${pc.join(', ')} FROM posts WHERE id = ?`, to, id);
  for (const t of ['slides', 'facts']) {
    const c = cols(t).filter((x) => x !== 'post_id' && x !== 'id');
    db.run(`INSERT INTO ${t} (post_id, ${c.join(', ')}) SELECT ?, ${c.join(', ')} FROM ${t} WHERE post_id = ?`, to, id);
  }
  return to;
}

test('a post written to disk is never called published on a customer page: its page, home, Posts, /all, the account, Results, the summary, the email and the button', async () => {
  setNow(TUE('13:00'));
  try {
    const b = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide', slotAt: iso(TUE('12:40')) });
    assert.equal(b.status, 'queued', `the recorded draft builds: ${b.reason}`);
    const id = b.postId;
    const later = copyOf(id, `${id}-later`);
    db.run("UPDATE posts SET status = 'approved', approved_by = 'owner', approved_at = ? WHERE id IN (?, ?)", iso(TUE('11:00')), id, later);
    db.run('UPDATE posts SET slot_at = ? WHERE id = ?', iso(TUE('18:40')), later);

    // PUBLISH_MODE is not live in this process: the post goes to disk, and is done.
    const r = await publishPost(ctx, id, { t: TUE('12:45') });
    assert.deepEqual([r.ok, r.via], [true, 'dry']);
    const p = loadPost(db, id);
    assert.equal(p.status, 'published', 'stored as done, so never sent again');
    assert.deepEqual([p.publish.tiktok.via, p.publish.tiktok.status, p.publish.instagram.via, p.publish.instagram.status], ['dry', 'written', 'dry', 'written']);
    assert.equal(shownStatus(p), 'written');

    const cookie = fake.session(customer(1)).cookie;
    const published = /<span class="chip ok">פורסם<\/span>|עלתה ב-/;

    // Its page: "לא נשלח", why, and nothing that says it waits in TikTok or can be taken down there.
    let html = await page(`/post/${id}`, cookie);
    assert.doesNotMatch(html, published);
    assert.match(html, /<span class="sub"><span class="chip warn">לא נשלח<\/span><\/span>/);
    assert.match(html, /<div class="banner warn" id="written">[\s\S]*?<b>המצגת לא נשלחה לרשתות<\/b><p>הפרסום אצלנו כבוי כרגע, אז שמרנו אותה ולא שלחנו אותה לטיקטוק ולאינסטגרם\. אם היא צריכה לעלות, כתבו לנו\.<\/p><\/div><\/div>/);
    assert.match(html, /<span class="chip"><svg[^>]*><use href="#i-clock"\/><\/svg>לא נשלחה לרשתות<\/span>/, 'the line of when it went up says it did not');
    assert.doesNotMatch(html, /טיוטה מחכה לכם|הטיוטה בתיבת הטיוטות|בטיוטות של טיקטוק|הודעות הסרה|נכתבה לדיסק/);
    // The steps are developer mode's and the operator's since the audit of 2026-11-12: there it says it was not sent.
    assert.doesNotMatch(html, /<ol class="trace">/);
    assert.match(await page(`/post/${id}`, `${fake.session(operator()).cookie}; of_dev=1`), /<b>פרסום<\/b> <span class="muted small num">[^<]*<\/span><div class="d">טיקטוק: נכתב לדיסק בפרסום יבש · אינסטגרם: נכתב לדיסק בפרסום יבש<\/div>/, 'its trace too');
    // The operator reads where it was written.
    assert.match(await page(`/post/${id}`, fake.session(operator()).cookie), /<p>נכתבה לדיסק ב-<bdi>[^<]+<\/bdi><\/p>/);

    // Home: nothing went out today, and the line under says this one did not.
    html = await page('/', cookie);
    assert.match(html, /<a class="kpi lead" href="\/posts#written"><span class="l">פורסמו היום<\/span><span class="v num">0<\/span><span class="s">מצגת אחת של היום לא נשלחה לרשתות<\/span><\/a>/);
    assert.doesNotMatch(html, published);
    assert.doesNotMatch(html, /טיוטות בטיקטוק|טיוטה מחכה לך|טיוטה בטיקטוק/, 'and no TikTok draft to publish: it was written to disk too');

    // Posts: not among what was published today, but in a list of its own that says why.
    html = await page('/posts', cookie);
    const pubSection = /<section class="panel home-panel" id="published">[\s\S]*?<\/section>/.exec(html)[0];
    assert.match(pubSection, /עוד לא פורסם היום\./);
    const written = /<section class="panel home-panel" id="written">[\s\S]*?<\/section>/.exec(html)?.[0];
    assert.ok(written, 'its own list');
    assert.match(written, /<h2>לא נשלחו היום<\/h2><\/header><p class="muted small">הפרסום אצלנו כבוי כרגע, אז שמרנו את המצגת הזו ולא שלחנו אותה לרשתות\.<\/p>/);
    assert.match(written, new RegExp(`href="/post/${id}"`));

    // /all, the customer's: no post counted as published.
    html = await page('/all', cookie);
    const row = /<a class="r" role="row" href="\/\?account=demo">[\s\S]*?<\/a>/.exec(html)[0];
    assert.match(row, /<span role="cell"><b class="cnt num zero">0<\/b><\/span><\/a>$/, 'published: 0');

    // The account's week, and Results.
    assert.match(await page('/accounts', cookie), /<p class="stat"><b class="num">0<\/b><span>פורסמו<\/span>/);
    html = await page('/results', cookie);
    assert.doesNotMatch(html, new RegExp(`/post/${id}`));
    assert.match(html, /אין עדיין מספרים/);

    // The day's summary counts it apart, and home's table of it says none went out.
    writeSummaries(ctx, '2026-10-13');
    const sum = db.get("SELECT text, data_json FROM summaries WHERE day = '2026-10-13' AND account_id = 'demo'");
    assert.match(sum.text, /: 0 פורסמו, 1 נכתבו לדיסק ולא נשלחו, \d+ נחסמו$/);
    assert.deepEqual(JSON.parse(sum.data_json).published, []);
    assert.match(await page('/', cookie), /<table class="table sumtab">[\s\S]*?<b class="cnt num zero">0<\/b>/);

    // "Publish now" on another one: its answer does not say published either.
    html = await page(`/post/${later}`, cookie);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
    const res = await fetch(`${base}/post/${later}/publish-now`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
    const said = await res.json();
    assert.equal(said.message, 'המצגת לא נשלחה. הפרסום אצלנו כבוי כרגע, אז שמרנו אותה ולא שלחנו אותה לרשתות.');
    assert.equal(shownStatus(loadPost(db, later)), 'written');

    // One that really went out the same day is published, and the only one counted.
    db.insert('posts', { id: 'out-1', account_id: 'demo', status: 'published', hook: 'מצגת שעלתה באמת', sample: 0, created_at: iso(TUE('08:00')), updated_at: iso(TUE('12:50')), published_at: iso(TUE('12:50')), publish_json: JSON.stringify({ tiktok: { via: 'zernio', zernioId: 'z-1', status: 'published' } }) });
    html = await page('/', cookie);
    assert.match(html, /<span class="l">פורסמו היום<\/span><span class="v num">1<\/span><span class="s">האחרון ב-[\d:]+: מצגת שעלתה באמת<\/span>/);
    html = await page('/posts', cookie);
    assert.match(/id="published">[\s\S]*?<\/section>/.exec(html)[0], /href="\/post\/out-1"/);
    assert.doesNotMatch(/id="published">[\s\S]*?<\/section>/.exec(html)[0], new RegExp(`/post/${id}"`));
    assert.match(/id="written">[\s\S]*?<\/section>/.exec(html)[0], /שמרנו את המצגות האלה ולא שלחנו אותן לרשתות/);
    assert.match(await page('/post/out-1', cookie), /<span class="sub"><span class="chip ok">פורסם<\/span><\/span>/);
    assert.match(await page('/accounts', cookie), /<p class="stat"><b class="num">1<\/b><span>פורסמו<\/span>/);

    // The weekly email, the Sunday after: one went up, not three.
    const sent = [];
    const client = { configured: true, link: (p2) => `https://teder.openfrequency.co.il${p2}`, send: async (m) => (sent.push(m), { ok: true, status: 202, final: false }) };
    const sunday = israelInstant('2026-10-18', '09:01').getTime();
    setNow(sunday);
    await emailTick(ctx, { t: sunday, client });
    const weekly = sent.find((m) => m.kind === 'weekly');
    assert.ok(weekly, JSON.stringify(sent.map((m) => m.kind)));
    assert.match(weekly.text, /בשבוע שעבר עלתה מצגת אחת\./);
  } finally {
    setNow(null);
  }
});
