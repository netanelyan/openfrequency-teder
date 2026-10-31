import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { accountsPage } from '../src/web/pages.js';
import { accountRows, week } from '../src/web/data.js';
import { monthKey } from '../src/core/clock.js';
import { pauseAccount } from '../src/autonomy/rails.js';
import { customer, fakeAccounts, operator, opened, tempHome } from './helpers.js';

// The account page, designed again (the owner, 2026-10-31: "design this page better"): one account across the width, a
// header with its name, handle and state, then a grid of panels (pages.js accountsPage). Every piece of information,
// link, form and button it had is still there, a customer sees what is theirs and the operator what is the operator's,
// several accounts are a section each, and a phone never scrolls sideways.

let home;
let ctx;
let db;
let fake;
let server;
let base;
const H = 3_600_000;

before(async () => {
  home = tempHome({
    packs: {
      demo: (f) => {
        f.pack.platforms = ['tiktok', 'instagram', 'facebook'];
      },
      second: (f) => {
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
  // demo is a customer's (workspace 1), second the company's own (no workspace).
  db.run("UPDATE accounts SET workspace_id = 1, zernio_profile_id = 'prof-1' WHERE id = 'demo'");
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  const t0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let n = 0;
  const post = (status, { at, published = null, quota = 'suggestion' }) =>
    db.insert('posts', { id: `p-acc-${++n}`, account_id: 'demo', status, hook: `פוסט ${n}`, created_at: iso(at), updated_at: iso(at), published_at: published ? iso(published) : null, quota_kind: quota, quota_month: monthKey(), sample: 0 });
  // Three went out, on two days of the last seven; two wait, one is approved, one was stopped.
  post('published', { at: t0 - 2 * 24 * H, published: t0 - 2 * 24 * H + H });
  post('published', { at: t0 - 2 * 24 * H, published: t0 - 2 * 24 * H + 2 * H });
  post('published', { at: t0 - 30 * 60_000, published: t0 - 60_000 });
  post('queued', { at: t0 - 3 * H });
  post('queued', { at: t0 - 2 * H });
  post('approved', { at: t0 - 24 * H });
  post('blocked', { at: t0 - 24 * H, quota: 'retry' });
  // TikTok connected, Instagram asked to be connected again, no Facebook Page.
  const conn = (platform, username, status) => db.insert('zernio_connections', { account_id: 'demo', platform, zernio_account_id: `z-${platform}`, username, status, issue: status === 'reconnect' ? 'token expired' : null, connected_at: iso(t0 - 9 * 24 * H), checked_at: iso(t0 - H) });
  conn('tiktok', 'atzitz.shemesh', 'connected');
  conn('instagram', 'atzitz.shemesh', 'reconnect');

  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'k'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  delete process.env.ZERNIO_API_KEY;
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

test("a customer's account page: the header, the month, the week, the queue, approval, the networks, TikTok, the look and the switch, with every link and form", async () => {
  const { cookie } = fake.session(customer(1, { wsName: 'עציץ ושמש' }));
  const res = await get('/accounts', cookie);
  assert.equal(res.status, 200);
  const html = await res.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];

  // The header: name, handle, state, and the way to the account's other pages.
  assert.match(html, /<section class="acct acc acc-demo" id="acc-demo" aria-labelledby="acct-name-demo">/, 'the section home links to (#acc-demo)');
  assert.match(html, /<header class="panel acct-head"><span class="dot acc-demo" aria-hidden="true"><\/span><div class="who"><h2 id="acct-name-demo">עציץ ושמש<\/h2><span class="muted ltr">@demo\.atzitz<\/span><\/div><span class="chip ok">פעיל<\/span>/);
  for (const p of ['sources', 'rivals', 'sounds']) assert.match(html, new RegExp(`<a class="btn sm" href="/${p}\\?account=demo">`), p);
  assert.match(html, /<a class="btn sm" href="\/new">/, 'a new account starts here, as before');

  // The month, a meter for each part of the plan.
  assert.match(html, /<span>הצעות שנוצלו<\/span><span class="num"><b>6<\/b> מתוך 40<\/span>/, 'six suggestions this month (the stopped one is not counted)');
  assert.match(html, /<span>החלפות שנוצלו<\/span><span class="num"><b>0<\/b> מתוך 10<\/span>/);
  assert.equal((html.match(/<meter /g) || []).length, 2);
  assert.doesNotMatch(html, /עלות החודש|\$\d/, "what it cost is the operator's");

  // The last 7 days: the total, then a bar a day, today's the last.
  assert.match(html, /<h3>7 הימים האחרונים<\/h3><\/header>\n<p class="stat"><b class="num">3<\/b><span>פורסמו<\/span>/);
  const days = /<div class="week"[^>]*>([\s\S]*?)<\/div><\/section>/.exec(html)[1];
  assert.equal((days.match(/<span/g) || []).length, 7, 'seven days');
  assert.equal((days.match(/class="today"/g) || []).length, 1);
  assert.match(days, /<span class="today" title="[^"]+: 1"><b class="num">1<\/b><i class="h\d"><\/i>/, 'today, with its count over its bar');

  // What waits, each count a link to it.
  assert.match(html, /<a href="\/posts\?account=demo"><span class="l">ממתינים<\/span><b class="cnt num sig">2<\/b><\/a>/);
  assert.match(html, /<a href="\/posts\?account=demo#scheduled"><span class="l">מאושרים<\/span><b class="cnt num">1<\/b><\/a>/);
  assert.match(html, /<span class="l">נחסמו השבוע<\/span><b class="cnt num">1<\/b>/);

  // Approval, fixed for a customer; how TikTok posts go out; the look and the way to another.
  assert.match(html, /<h3>אישור<\/h3><\/header><p class="m0">כל פוסט מחכה לאישור שלכם לפני שהוא עולה\.<\/p>/);
  assert.doesNotMatch(html, /name="mode"/);
  assert.match(html, /<h3>איך פוסטים עולים לטיקטוק<\/h3><\/header><p class="m0">המצגות מגיעות לטיוטות בטיקטוק\./);
  assert.match(html, /<h3>סגנון<\/h3>[\s\S]*?נעול מ-[\s\S]*?<a class="btn sm" href="\/styles\?account=demo">להחליף סגנון<\/a>/);

  // The networks: their names the panel's heading, a check, and a row each with its state, its account and its button.
  assert.match(html, /<div class="connect" id="connect-demo"><header><h3>טיקטוק, אינסטגרם ופייסבוק<\/h3><span class="end"><form method="post" action="\/accounts\/demo\/connections">/, 'the panel home links to (#connect-demo), with "לבדוק שוב"');
  assert.match(html, /<li class="net"><span class="who"><b>טיקטוק<\/b> <span class="chip ok">מחובר<\/span> <span class="ltr muted">@atzitz\.shemesh<\/span><\/span><span class="act"><form method="post" action="\/accounts\/demo\/connect\/tiktok">[^]*?לחבר חשבון אחר<\/button><\/form><\/span><\/li>/);
  assert.match(html, /<b>אינסטגרם<\/b> <span class="chip warn">צריך לחבר מחדש<\/span>[^]*?אינסטגרם ביקש לאשר את החיבור מחדש\.[^]*?action="\/accounts\/demo\/connect\/instagram"[^]*?לחבר מחדש את אינסטגרם/);
  assert.match(html, /<b>פייסבוק<\/b> <span class="chip ghost">לא מחובר<\/span><\/span><span class="act"><form method="post" action="\/accounts\/demo\/connect\/facebook">[^]*?לחבר את פייסבוק/);
  assert.match(html, /בפייסבוק מחברים עמוד של העסק שאתם מנהלים/, 'what each platform still to connect needs');

  // The switch, last, with its second tap and what it does.
  assert.match(html, /<div class="acct-foot"><form method="post" action="\/accounts\/demo\/kill">[^]*?data-confirm="לחצו שוב כדי לכבות"[^]*?לכבות את החשבון<\/button><\/form><p class="muted small m0">אחרי הכיבוי שום דבר לא ייכתב ולא יפורסם בחשבון עד שתפעילו אותו מחדש\.<\/p><\/div>/);

  // Every form on the page posts with this session's token.
  const forms = html.match(/<form method="post"[^>]*>/g) || [];
  assert.equal(forms.length, 6, 'the check, three connects, the kinds of slideshow (src/web/formats.js) and the switch');
  assert.equal((html.match(new RegExp(`name="_csrf" value="${csrf}"`, 'g')) || []).length, forms.length);
});

test('a paused account says why, with the way back on and no switch; a new look waits in its panel with the button that takes it', async () => {
  const { cookie } = fake.session(customer(1));
  pauseAccount(db, 'demo', 'manual', 'owner כיבה את החשבון', 'owner');
  const pack = ctx.pack('demo');
  const accent = pack.theme.colors.accent;
  try {
    await get('/accounts', cookie);
    pack.theme.colors.accent = '#0F5E9C';
    const html = await (await get('/accounts', cookie)).text();
    assert.match(html, /<span class="chip warn">מושהה<\/span>/);
    assert.match(html, /<div class="banner warn">[^]*?<b>הושהה ידנית<\/b><p>owner כיבה את החשבון<\/p><\/div><form method="post" action="\/accounts\/demo\/resume">[^]*?הפעלה מחדש/);
    assert.doesNotMatch(html, /action="\/accounts\/demo\/kill"/, 'no switch on an account already off');
    assert.match(html, /<div class="notice">[^]*?<b>יש לחשבון סגנון חדש<\/b>[^]*?<form method="post" action="\/accounts\/demo\/style">[^]*?לעבור לסגנון החדש/);
  } finally {
    pack.theme.colors.accent = accent;
    db.run("UPDATE accounts SET status = 'active', paused_reason = NULL, paused_detail = NULL, paused_at = NULL WHERE id = 'demo'");
  }
});

test("the operator's own account: approval chosen, TikTok chosen, the month's cost and what each platform goes out through", async () => {
  const { cookie } = fake.session(operator());
  const html = await (await get('/accounts?account=second', cookie)).text();
  assert.match(html, /id="acc-second"/);
  assert.match(html, /<form method="post" action="\/accounts\/second\/mode" data-autosubmit>[^]*?name="mode" value="auto"/, 'the selector, which sends itself (app.js data-autosubmit)');
  assert.match(html, /<div class="mrow cost"><span>עלות החודש<\/span><b class="num"><span class="num ltr">\$0\.00<\/span><\/b><\/div>/);
  assert.match(html, /<dt>פרסום<\/dt><dd>טיקטוק: /);
  assert.match(html, /<section class="panel acct-tiktok"><header><h3>איך פוסטים עולים לטיקטוק<\/h3><\/header><form method="post" action="\/accounts\/second\/tiktok">[^]*?value="direct"/);
  assert.doesNotMatch(html, /אחרי הכיבוי/, "the line under the switch is the customer's");
  // A customer's account, seen by the operator: approval fixed, said so.
  const theirs = await (await get('/accounts?account=demo', cookie)).text();
  assert.match(theirs, /חשבון של לקוח: תמיד במצב אישור\./);
  assert.doesNotMatch(theirs, /action="\/accounts\/demo\/mode"/);
});

test('a Facebook Page is named as it is, with no @: a Page has a name, not a handle', async () => {
  db.insert('zernio_connections', { account_id: 'demo', platform: 'facebook', zernio_account_id: 'z-facebook', username: 'עציץ ושמש', status: 'connected', issue: null, connected_at: new Date().toISOString(), checked_at: new Date().toISOString() });
  try {
    const html = await (await get('/accounts', fake.session(customer(1)).cookie)).text();
    assert.match(html, /<b>פייסבוק<\/b> <span class="chip ok">מחובר<\/span> <bdi class="muted" dir="auto">עציץ ושמש<\/bdi>/);
    assert.doesNotMatch(html, /@עציץ ושמש/);
    assert.match(html, /<span class="ltr muted">@atzitz\.shemesh<\/span>/, 'TikTok keeps its @');
  } finally {
    db.run("DELETE FROM zernio_connections WHERE account_id = 'demo' AND platform = 'facebook'");
  }
});

test('several accounts are a section each, in the same layout, one under the other', () => {
  const rows = accountRows(ctx).map((r) => ({ ...r, week: week(ctx, r.pack.id), style: null }));
  assert.deepEqual(rows.map((r) => r.pack.id), ['demo', 'second']);
  const html = accountsPage({ csrf: 'x', operator: true, user: { name: 'op' } }, rows);
  const sections = [...html.matchAll(/<section class="acct acc acc-([\w-]+)" id="acc-\1"/g)].map((m) => m[1]);
  assert.deepEqual(sections, ['demo', 'second']);
  for (const id of sections) {
    const one = html.slice(html.indexOf(`id="acc-${id}"`)).split('<section class="acct ')[0];
    for (const part of ['acct-head', 'acct-grid', 'acct-month', 'acct-week', 'acct-queue', 'acct-net', 'acct-mode', 'acct-tiktok']) assert.match(one, new RegExp(`class="[^"]*${part}`), `${id}: ${part}`);
    assert.match(one, new RegExp(`action="/accounts/${id}/kill"`), `${id}: its switch`);
    assert.match(one, new RegExp(`id="connect-${id}"`), `${id}: its networks`);
  }
});

test('in a real browser: no sideways scroll on a phone, and on a desk the panels fill the width', async () => {
  const { sid } = fake.session(customer(1));
  let browser;
  try {
    browser = await chromium.launch();
    const open = async (width, height, colorScheme) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/accounts`);
      return page;
    };
    const box = (page, sel) => page.locator(sel).first().boundingBox();

    const phone = await open(390, 844, 'dark');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll at 390');
    // Every panel in one column, each within the screen.
    const cols = await phone.$$eval('.acct-grid > .panel', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
    assert.equal(cols.length, 8, 'month, week, queue, networks, approval, TikTok, look, the kinds of slideshow');
    for (const [l, r] of cols) assert.ok(l >= 0 && r <= 390, `${l}..${r} within the phone`);
    assert.equal(new Set(cols.map(([l]) => l)).size, 1, 'one column');
    // The two taps of the switch still work: the first arms it.
    await phone.locator('.acct-foot button').click();
    assert.equal(await phone.locator('.acct-foot button').textContent(), 'לחצו שוב כדי לכבות');

    for (const scheme of ['light', 'dark']) {
      const desk = await open(1440, 900, scheme);
      assert.equal(await desk.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `no sideways scroll at 1440 (${scheme})`);
      const head = await box(desk, '.acct-head');
      const main = await box(desk, '#main');
      assert.ok(head.width > 900, `the header runs across the page (${head.width}px)`);
      // The month, the week and the queue side by side, and the networks two columns wide.
      const [m, w, q] = await Promise.all(['.acct-month', '.acct-week', '.acct-queue'].map((s) => box(desk, s)));
      assert.equal(Math.round(m.y), Math.round(w.y));
      assert.equal(Math.round(w.y), Math.round(q.y));
      assert.ok(m.x > w.x && w.x > q.x, 'right to left: the month first');
      const net = await box(desk, '.acct-net');
      assert.ok(net.width > 1.9 * m.width, 'the networks take two columns');
      assert.ok(q.x - main.x < 80, 'no empty half: the last column reaches the page edge');
      // The colours follow the system setting: the page's own background is the theme's.
      const bg = await desk.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, scheme === 'dark' ? 'rgb(17, 17, 19)' : 'rgb(238, 239, 242)');
    }
  } finally {
    await browser?.close();
  }
});
