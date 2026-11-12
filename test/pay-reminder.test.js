import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { setSetting } from '../src/core/store.js';
import { REMIND_DAYS, payReminder } from '../src/billing/entitlement.js';
import { PAY_HE, payBanner, untilHe } from '../src/web/ui.js';
import { addDays, israelDate } from '../src/schedule/israel.js';
import { customer, dayEnd, fakeAccounts, listenFree, opened, operator, tempHome, viewingAs } from './helpers.js';

// The owner, 2026-11-03: "add a reminder to pay for the new month, whatsapp, email and dashboard. A user has 72 hours to
// pay for a new month once their subscription has ended". The dashboard's part: a line at the top of every page of a
// customer's workspace, from the answer accounts gives the paywall. In the last week paid for, calm: paid until <date>,
// and the way to pay. While the month is over and the grace runs (access due), clearer: Teder works until <day, date>,
// then stops until it is paid. Never for comp, cancelled, off, the operator, view-as, or an answer that cannot say.
//
// alpha and bravo are workspace 1's.

let home;
let ctx;
let db;
let fake;
let server;
let base;

const PAY = 'https://accounts.test/setup';
/** The end of an Israel day (YYYY-MM-DD), as accounts sends paidThrough and graceUntil. */
const endOf = dayEnd;
const today = () => israelDate(Date.now());

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
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id IN ('alpha', 'bravo')");
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'r'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

beforeEach(() => {
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, null);
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
/** The reminder on a page: its whole banner, or null. */
const bannerOf = (html) => /<div class="banner [a-z]+ pay" id="pay">.*?<\/a><\/div>/.exec(html)?.[0] ?? null;

// ---- what the answer says

const PAID_THROUGH = '2026-11-10T21:59:59.999Z'; // the end of Tuesday 10 November, Israel time (UTC+2)
const GRACE_UNTIL = '2026-11-13T21:59:59.999Z'; // the end of Friday 13 November: the 72 hours after it
const answer = (o) => ({ known: true, allowed: true, access: 'paid', paidThrough: null, graceUntil: null, cancelAt: null, ...o });
const at = (iso) => Date.parse(iso);

test('the last week paid for: from the first minute of the seventh day before its end, Israel days, until its last millisecond', () => {
  assert.equal(REMIND_DAYS, 7);
  const paid = answer({ paidThrough: PAID_THROUGH });
  assert.equal(payReminder(paid, at('2026-10-20T10:00:00Z')), null, 'three weeks before: nothing');
  // The edge: Tuesday 3 November 23:59:59.999 in Israel is exactly seven days before the end, and not yet; the next
  // millisecond is Wednesday 4 November, the first of the last seven days paid for (4 to 10).
  assert.equal(payReminder(paid, at('2026-11-03T21:59:59.999Z')), null, 'the last millisecond before the week');
  assert.deepEqual(payReminder(paid, at('2026-11-03T22:00:00.000Z')), { state: 'soon', until: PAID_THROUGH }, 'its first');
  assert.deepEqual(payReminder(paid, at('2026-11-07T09:00:00Z')), { state: 'soon', until: PAID_THROUGH });
  assert.deepEqual(payReminder(paid, at(PAID_THROUGH)), { state: 'soon', until: PAID_THROUGH }, 'the last millisecond paid for');
  // A kept answer that still says paid once the day is over (accounts not answering since) has no grace to tell of.
  assert.equal(payReminder(paid, at(PAID_THROUGH) + 1), null, 'over: never a day of our own');

  // Israel days, not 7 x 24 hours: the clocks go forward on Friday 26 March 2027, so the week before the end of Monday
  // 29 March starts at midnight of Tuesday 23 March, Israel time, an hour after 7 x 24 hours before the end.
  const spring = answer({ paidThrough: '2027-03-29T20:59:59.999Z' });
  assert.equal(endOf('2027-03-29'), '2027-03-29T20:59:59.999Z', 'the end of 29 March 2027 in summer time');
  assert.equal(payReminder(spring, at('2027-03-22T21:30:00Z')), null, '7 x 24 hours before, Monday 22 March 23:30 in Israel');
  assert.deepEqual(payReminder(spring, at('2027-03-22T22:00:00Z')), { state: 'soon', until: '2027-03-29T20:59:59.999Z' }, 'Tuesday 23 March 00:00');
});

test('the grace: while access is due, until graceUntil as accounts gives it, never a count of our own', () => {
  const due = answer({ access: 'due', paidThrough: PAID_THROUGH, graceUntil: GRACE_UNTIL });
  assert.deepEqual(payReminder(due, at('2026-11-10T22:00:00Z')), { state: 'due', until: GRACE_UNTIL }, 'the first minute after the month');
  assert.deepEqual(payReminder(due, at(GRACE_UNTIL)), { state: 'due', until: GRACE_UNTIL }, 'its last millisecond');
  assert.equal(payReminder(due, at(GRACE_UNTIL) + 1), null, 'over: the paywall says the rest');
  // Whatever grace accounts gives is the one said: three days, or the fourteen it gave before.
  const long = '2026-11-25T21:59:59.999Z';
  assert.deepEqual(payReminder({ ...due, graceUntil: long }, at('2026-11-20T08:00:00Z')), { state: 'due', until: long });
  // Due without its instant (or one that is not one): nothing, rather than paidThrough plus days we counted.
  for (const graceUntil of [null, undefined, '', 'soon', 1763071199999, '2026-13-40']) assert.equal(payReminder({ ...due, graceUntil }, at('2026-11-11T08:00:00Z')), null, String(graceUntil));
});

test('never for comp, cancelled, off, unpaid, an access not known here, or an answer that cannot say', () => {
  const t = at('2026-11-07T09:00:00Z');
  for (const access of ['comp', 'cancelled', 'off', 'unpaid', 'trial', null]) {
    assert.equal(payReminder(answer({ access, paidThrough: PAID_THROUGH, cancelAt: access === 'cancelled' ? PAID_THROUGH : null, graceUntil: GRACE_UNTIL }), t), null, String(access));
  }
  // Not allowed is the paywall's to say; an answer older than a day, or none, is no answer.
  assert.equal(payReminder(answer({ allowed: false, paidThrough: PAID_THROUGH }), t), null, 'paid and not allowed (a refund)');
  assert.equal(payReminder(answer({ known: false, paidThrough: PAID_THROUGH }), t), null, 'older than a day');
  for (const none of [null, undefined, {}]) assert.equal(payReminder(none, t), null, String(none));
  // The operator, view-as and our own workspaces are never asked (server.js: ent is null), and so never reminded.
});

test('the banner: each state in its words, the day in Israel time, one way to pay, the paywall\'s', () => {
  setNow('2026-11-05T10:00:00Z');
  try {
    const links = { setup: PAY };
    const soon = payBanner({ pay: { state: 'soon', until: PAID_THROUGH }, links });
    assert.equal(
      soon,
      `<div class="banner info pay" id="pay"><svg class="i" aria-hidden="true"><use href="#i-clock"/></svg><div><b>המנוי לתדר שולם עד 10 בנובמבר.</b><p>אפשר כבר לשלם על החודש הבא, כדי שתדר ימשיך לעבוד בלי הפסקה.</p></div><a class="btn sm" href="${PAY}">איך משלמים</a></div>`,
      'calm: the glass of an info banner, a grey button'
    );
    const due = payBanner({ pay: { state: 'due', until: GRACE_UNTIL }, links });
    assert.equal(
      due,
      `<div class="banner warn pay" id="pay"><svg class="i" aria-hidden="true"><use href="#i-alert"/></svg><div><b>החודש ששילמתם עליו נגמר, והתשלום על החודש הבא עוד לא הגיע אלינו.</b><p>תדר ממשיך לעבוד עד סוף יום שישי, 13 בנובמבר, ואז ייעצר עד שהתשלום יגיע. 3 ימים אחרי העצירה החיבורים לרשתות מתנתקים.</p></div><a class="btn sm primary" href="${PAY}">איך משלמים</a></div>`,
      'clearer: the warning\'s colour, the day and date, the one blue button'
    );
    for (const html of [soon, due]) assert.equal((html.match(/<a /g) || []).length, 1, 'one action');

    // The day is Israel's: 00:30 on 11 November there is still 10 November in UTC.
    assert.equal(untilHe('2026-11-10T22:30:00.000Z'), '11 בנובמבר');
    assert.equal(untilHe('2026-11-10T22:30:00.000Z', { weekday: true }), 'יום רביעי, 11 בנובמבר');
    // The year only when it is not this one.
    assert.equal(untilHe('2027-01-02T21:59:59.999Z', { t: at('2026-12-30T10:00:00Z') }), '2 בינואר 2027');
    assert.equal(untilHe('2027-01-02T21:59:59.999Z', { weekday: true, t: at('2026-12-30T10:00:00Z') }), 'יום שבת, 2 בינואר 2027');
    assert.equal(untilHe('2027-01-02T21:59:59.999Z', { t: at('2027-01-01T10:00:00Z') }), '2 בינואר');

    // Nothing to remind of, or no way to pay: no banner at all.
    assert.equal(payBanner({ pay: null, links }), '');
    assert.equal(payBanner({ links }), '');
    assert.equal(payBanner({ pay: { state: 'soon', until: PAID_THROUGH }, links: {} }), '');
    assert.equal(payBanner({ pay: { state: 'later', until: PAID_THROUGH }, links }), '');
  } finally {
    setNow(null);
  }
  // Plain punctuation (hebrew-voice): no dash as a break, no exclamation mark, a sentence a line.
  const lines = [PAY_HE.soon.title('10 בנובמבר'), PAY_HE.soon.text(), PAY_HE.due.title(), PAY_HE.due.text('יום שישי, 13 בנובמבר'), PAY_HE.button];
  for (const l of lines) assert.doesNotMatch(l, /[—–!]/, l);
});

// ---- on the pages

const PAGES = ['/', '/posts', '/accounts', '/results', '/sources', '/settings', '/topics', '/facts', '/more', '/new', '/all', '/no-such-page'];

test('on every page of the workspace, for its owner and its members: the last week with its date, then the grace with its day', async () => {
  const owner = fake.session(customer(1)).cookie;
  const member = fake.session(customer(1, { role: 'client_member', email: 'member1@example.test' })).cookie;
  const paidThrough = endOf(addDays(today(), 3));
  fake.entitlement(1, { access: 'paid', paidThrough });
  for (const p of PAGES) {
    for (const [who, cookie] of [['owner', owner], ['member', member]]) {
      const res = await get(p, cookie);
      assert.equal(res.status, p === '/no-such-page' ? 404 : 200, `${who} ${p}`);
      const html = await res.text();
      const b = bannerOf(html);
      assert.ok(b, `${who} ${p}: the reminder`);
      assert.ok(b.startsWith('<div class="banner info pay" id="pay">'), `${who} ${p}: calm`);
      assert.ok(b.includes(`<b>${PAY_HE.soon.title(untilHe(paidThrough))}</b>`), `${who} ${p}: paid until its day`);
      assert.ok(b.includes(`<a class="btn sm" href="${PAY}">איך משלמים</a>`), `${who} ${p}: the paywall's way to pay`);
      assert.equal(html.split('id="pay"').length, 2, `${who} ${p}: once`);
      // At the top of the page, in it: after the bar, before the page's own headline.
      assert.ok(html.indexOf('<main class="wrap" id="main">') < html.indexOf('id="pay"'), `${who} ${p}: in the page`);
      const head = html.indexOf('<div class="head">');
      if (head > 0) assert.ok(html.indexOf('id="pay"') < head, `${who} ${p}: above the headline`);
    }
  }

  // The 7-day edge, in Israel days: the last day paid for seven days from now starts the week tomorrow.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, { access: 'paid', paidThrough: endOf(addDays(today(), REMIND_DAYS)) });
  assert.equal(bannerOf(await (await get('/', owner)).text()), null, 'eight days left: nothing yet');
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, { access: 'paid', paidThrough: endOf(addDays(today(), REMIND_DAYS - 1)) });
  assert.ok(bannerOf(await (await get('/', owner)).text()), 'seven days left, today among them: the reminder');
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, { access: 'paid', paidThrough: endOf(today()) });
  assert.ok(bannerOf(await (await get('/', owner)).text()), 'the last day paid for');

  // The month is over: the grace accounts gives, its day and date, the blue button.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  const graceUntil = endOf(addDays(today(), 2));
  fake.entitlement(1, { access: 'due', paidThrough: endOf(addDays(today(), -1)), graceUntil });
  for (const p of PAGES) {
    const res = await get(p, owner);
    assert.equal(res.status, p === '/no-such-page' ? 404 : 200, p);
    const b = bannerOf(await res.text());
    assert.ok(b?.startsWith('<div class="banner warn pay" id="pay">'), `${p}: the warning`);
    assert.ok(b.includes(`<b>${PAY_HE.due.title()}</b><p>${PAY_HE.due.text(untilHe(graceUntil, { weekday: true }))}</p>`), `${p}: until the end of its day`);
    assert.match(b, /עד סוף יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת), \d{1,2} ב\S+, ואז/, `${p}: the day and the date`);
    assert.ok(b.includes(`<a class="btn sm primary" href="${PAY}">איך משלמים</a>`), p);
  }
  // A button pressed during the grace works as ever: Teder is open.
  const r = await fetch(`${base}/settings/email`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1', origin: base }, body: '_csrf=nope' });
  assert.notEqual(r.status, 402, 'not the paywall');
});

test('never for comp, cancelled, a month far from its end, the operator, view-as, and the operator\'s every-account page says it in its table', async () => {
  const owner = fake.session(customer(1)).cookie;
  const inWeek = endOf(addDays(today(), 2));
  for (const [why, a] of [
    ['comp', { access: 'comp', paidThrough: inWeek }],
    ['cancelled, still open to its last day', { access: 'cancelled', allowed: true, paidThrough: inWeek, cancelAt: inWeek }],
    ['paid, three weeks left', { access: 'paid', paidThrough: endOf(addDays(today(), 21)) }],
    ['paid, no paidThrough', { access: 'paid', paidThrough: null }],
    ['due without graceUntil', { access: 'due', paidThrough: endOf(addDays(today(), -1)), graceUntil: null }],
  ]) {
    db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
    fake.entitlement(1, a);
    for (const p of ['/', '/posts', '/all', '/settings']) {
      const res = await get(p, owner);
      assert.equal(res.status, 200, `${why} ${p}`);
      assert.equal(bannerOf(await res.text()), null, `${why} ${p}`);
    }
  }

  // Workspace 1 in its grace: its customer is reminded; the operator and the operator viewing it are not.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  fake.entitlement(1, { access: 'due', paidThrough: endOf(addDays(today(), -1)), graceUntil: inWeek });
  assert.ok(bannerOf(await (await get('/', owner)).text()), 'the customer');
  const op = fake.session(operator()).cookie;
  for (const p of ['/', '/all', '/settings']) assert.equal(bannerOf(await (await get(p, op)).text()), null, `operator ${p}`);
  const view = fake.session(viewingAs(1)).cookie;
  for (const p of ['/', '/all', '/settings']) assert.equal(bannerOf(await (await get(p, view)).text()), null, `view-as ${p}`);
  // The operator's /all already has each workspace's payment in its table, now in Hebrew for the grace as well.
  const all = await (await get('/all', op)).text();
  assert.match(all, /<b>עסק <span class="ltr">#1<\/span><\/b>[^]*?<td data-k="תשלום"><span class="chip warn">מחכה לתשלום<\/span><\/td>/);
  assert.doesNotMatch(all, />due</);
});

test('a stale or missing answer: what accounts said last still reminds while it stands, never of a day that has passed', async () => {
  const owner = fake.session(customer(1)).cookie;
  const keep = (k, ageMs) => setSetting(db, 'entitlement:1', { allowed: true, cancelAt: null, plan: null, stoppedAt: null, graceUntil: null, ...k, checkedAt: new Date(Date.now() - ageMs).toISOString() });
  const down = () => fake.entitlement(1, { status: 503, body: { error: 'down' } });

  // accounts is down, the answer kept 10 minutes ago stands (as it does for the paywall): it still reminds.
  const paidThrough = endOf(addDays(today(), 3));
  down();
  keep({ access: 'paid', paidThrough }, 10 * 60_000);
  let res = await get('/', owner);
  assert.equal(res.status, 200);
  assert.ok(bannerOf(await res.text())?.includes(PAY_HE.soon.title(untilHe(paidThrough))), 'the kept answer, its day');

  // Kept from before the month ended: still open (the answer stands), and nothing said, since accounts' grace is not known.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  keep({ access: 'paid', paidThrough: endOf(addDays(today(), -1)) }, 60 * 60_000);
  res = await get('/', owner);
  assert.equal(res.status, 200, 'open');
  assert.equal(bannerOf(await res.text()), null, 'no "paid until" a day gone, no grace made up');
  // A grace kept that has run out: nothing either.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  keep({ access: 'due', paidThrough: endOf(addDays(today(), -4)), graceUntil: endOf(addDays(today(), -1)) }, 60 * 60_000);
  assert.equal(bannerOf(await (await get('/', owner)).text()), null);

  // Older than a day, or never answered: the page that says the check failed, with no reminder on it.
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  keep({ access: 'paid', paidThrough }, 25 * 3_600_000);
  res = await get('/', owner);
  assert.equal(res.status, 503);
  let html = await res.text();
  assert.match(html, /אי אפשר לבדוק כרגע/);
  assert.equal(bannerOf(html), null);
  db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
  res = await get('/', owner);
  assert.equal(res.status, 503);
  html = await res.text();
  assert.equal(bannerOf(html), null);
  assert.doesNotMatch(html, /id="pay"/);

  // accounts back: asked again, and the reminder from its answer.
  ctx.entitlements.changed(1);
  fake.entitlement(1, { access: 'paid', paidThrough });
  assert.ok(bannerOf(await (await get('/', owner)).text()));
});

test('in a real browser, on a phone and a desk, light and dark: the reminder fits, its button clear of its words, 24px above the headline, nothing sideways', async () => {
  const { sid } = fake.session(customer(1));
  let browser;
  try {
    browser = await chromium.launch();
    for (const [state, a] of [
      ['soon', { access: 'paid', paidThrough: endOf(addDays(today(), 4)) }],
      ['due', { access: 'due', paidThrough: endOf(addDays(today(), -1)), graceUntil: endOf(addDays(today(), 2)) }],
    ]) {
      db.run("DELETE FROM settings WHERE key LIKE 'entitlement:%'");
      fake.entitlement(1, a);
      for (const [width, height] of [[390, 844], [1280, 800]]) {
        for (const theme of ['light', 'dark']) {
          for (const p of ['/', '/posts']) {
            const context = await browser.newContext({ viewport: { width, height }, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
            await context.addCookies([{ name: 'of_session', value: sid, url: base }, ...(theme === 'dark' ? [{ name: 'of-theme', value: 'dark', url: base }] : [])]);
            const page = await context.newPage();
            await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded' });
            // In the page's pixels: a desk draws the page at 90% (style.css --z), and the screen's are divided by it.
            const m = await page.evaluate(() => {
              const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
              const box = (el) => (({ left, right, top, bottom, height }) => ({ left: Math.round(left / z), right: Math.round(right / z), top: Math.round(top / z), bottom: Math.round(bottom / z), height: Math.round(height / z) }))(el.getBoundingClientRect());
              const b = document.getElementById('pay');
              const words = box(b.querySelector(':scope > div'));
              const btn = box(b.querySelector('.btn'));
              const r = box(b);
              return {
                sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                banner: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
                words: { left: words.left, right: words.right, bottom: words.bottom },
                btn: { left: btn.left, right: btn.right, top: btn.top, bottom: btn.bottom, height: btn.height },
                below: box(b.nextElementSibling).top - r.bottom,
                bar: box(document.querySelector('header.top')).bottom,
                vw: document.documentElement.clientWidth,
              };
            });
            const at = `${state} ${p} ${width} ${theme}`;
            assert.equal(m.sideways, 0, `${at}: nothing sideways`);
            assert.ok(m.banner.left >= 16 && m.banner.right <= m.vw - 16, `${at}: within the page's margins`);
            assert.ok(m.btn.left >= m.banner.left + 16 && m.btn.right <= m.banner.right - 16 && m.btn.bottom <= m.banner.bottom - 12, `${at}: the button inside the banner, off its edges`);
            if (width < 600) {
              // On a phone the button goes under the words, 12px under them, at a thumb's height.
              assert.ok(m.btn.top - m.words.bottom >= 12, `${at}: under the words`);
              assert.ok(m.btn.height >= 36, `${at}: a thumb's button`);
              assert.ok(m.banner.top - m.bar >= 16, `${at}: clear of the bar`);
            } else {
              // On a desk it sits at the end of the words' line (the left, right to left), apart from them.
              assert.ok(m.words.left - m.btn.right >= 12, `${at}: beside the words`);
            }
            assert.equal(Math.round(m.below), 24, `${at}: 24px above the headline`);
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser?.close();
  }
});
