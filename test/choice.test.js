import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { generationTargets } from '../src/autonomy/runner.js';
import { DEFAULT_CHOICE, choiceOf, monthOf, readChoice, saveChoice, scheduleOf, timesOf } from '../src/schedule/choice.js';
import { datesOf, monthSlots, slotsFor } from '../src/schedule/slots.js';
import { restAt } from '../src/schedule/shabbat.js';
import { hhmm, israelDate, israelInstant, weekday } from '../src/schedule/israel.js';
import { customer, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// The days and times an account posts on, chosen by its owner (src/schedule/choice.js): validated, laid over the
// pack's schedule, never on Shabbat or a festival, and thinned to the month's plan so the plan lasts the month.

let home;
let ctx;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'c'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const sched = (byDay, perMonth = null) => ({ slots: [], slotsByDay: byDay, windows: [], postsPerDay: 2, perMonth });
const form = (byDay) => Object.fromEntries(Object.entries(byDay).flatMap(([d, list]) => (list.length ? [[`day_${d}`, 'on'], [`t1_${d}`, list[0] || ''], [`t2_${d}`, list[1] || '']] : [])));
const months = () => {
  const out = [];
  for (let y = 2026; y <= 2028; y++) for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
};

test('a choice is read from the form: days on, up to two times each, sorted; anything else is refused in Hebrew', () => {
  assert.deepEqual(readChoice(form(DEFAULT_CHOICE)).byDay, Object.fromEntries(Object.entries(DEFAULT_CHOICE).map(([d, l]) => [d, [...l].sort()])));
  const r = readChoice({ day_0: 'on', t1_0: '19:30', t2_0: '09:00', t1_1: '10:00' });
  assert.deepEqual(r.byDay[0], ['09:00', '19:30'], 'sorted');
  assert.deepEqual(r.byDay[1], [], 'a day whose box is off posts nothing, whatever its times say');
  const bad = (f) => readChoice(f).problems?.join(' ') || '';
  assert.match(bad({}), /לפחות יום אחד/);
  assert.match(bad({ day_2: 'on' }), /ביום שלישי חסרה שעה/);
  assert.match(bad({ day_2: 'on', t1_2: '7pm' }), /כמו 19:30/);
  assert.match(bad({ day_2: 'on', t1_2: '25:00' }), /כמו 19:30/);
  assert.match(bad({ day_2: 'on', t1_2: '03:00' }), /בין 06:00 ל-23:30/);
  assert.match(bad({ day_2: 'on', t1_2: '12:00', t2_2: '12:30' }), /לפחות שעה בין/);
  assert.equal(readChoice({ day_2: 'on', t1_2: '12:00', t2_2: '12:00' }).byDay[2].length, 1, 'the same time twice is one');
  for (const f of [{}, { day_2: 'on' }, { day_2: 'on', t1_2: '03:00' }]) assert.doesNotMatch(bad(f), /[A-Za-z]{3,}/, 'no English in what the customer reads');
});

test('the default reaches the plan of 40 in every month for three years, festivals included, and never more', () => {
  for (const month of months()) {
    const all = monthSlots(month, sched(DEFAULT_CHOICE)).all;
    const kept = monthSlots(month, sched(DEFAULT_CHOICE, 40)).slots;
    assert.ok(all >= 40, `${month}: ${all} slots before the plan`);
    assert.equal(kept.length, 40, `${month}: exactly the plan`);
    for (const s of kept) assert.equal(restAt(s), null, `${month}: ${s.toISOString()} is on Shabbat or a festival`);
    // The same count, day by day, as the runner reads it.
    assert.equal(datesOf(month).reduce((n, d) => n + slotsFor(d, sched(DEFAULT_CHOICE, 40)).slots.length, 0), 40, `${month}: day by day`);
  }
});

test('thinning keeps the plan spread over the whole month: a day\'s second slot goes first, every day keeps one', () => {
  const s = sched(DEFAULT_CHOICE, 40);
  const month = '2026-11';
  const kept = monthSlots(month, s).slots;
  const days = datesOf(month).filter((d) => slotsFor(d, sched(DEFAULT_CHOICE)).slots.length);
  for (const d of days) assert.ok(kept.some((x) => israelDate(x.getTime()) === d), `${d} keeps a post`);
  const last = days.at(-1);
  assert.ok(kept.some((x) => israelDate(x.getTime()) === last), 'the month does not run out early');
  assert.ok(slotsFor('2026-11-01', s).dropped.every((x) => ['מעבר לחבילה החודשית'].includes(x.why)), 'what was thinned is named');
  assert.equal(monthSlots(month, sched(DEFAULT_CHOICE, 0)).slots.length, 0, 'a plan of 0 posts nothing');
  assert.equal(monthSlots(month, sched(DEFAULT_CHOICE, 1000)).slots.length, monthSlots(month, sched(DEFAULT_CHOICE)).all, 'a big plan keeps every slot');
  // Fewer slots than the plan: all of them.
  const once = { 0: ['19:30'] };
  assert.equal(monthSlots(month, sched(once, 40)).slots.length, monthSlots(month, sched(once)).all);
});

test('Shabbat and the festivals stay off whatever is chosen', () => {
  const s = sched({ 5: ['12:30', '20:00'], 6: ['12:00', '21:30'] });
  // 2026-10-16 is a Friday, 10-17 a Saturday; Shabbat begins about 17:26.
  assert.deepEqual(slotsFor('2026-10-16', s).slots.map((d) => hhmm(d)), ['12:30']);
  assert.deepEqual(slotsFor('2026-10-17', s).slots.map((d) => hhmm(d)), ['21:30']);
  // Yom Kippur 5787 is 2026-09-21, a Monday.
  assert.equal(weekday('2026-09-21'), 1);
  assert.deepEqual(slotsFor('2026-09-21', sched({ 1: ['12:30', '19:30'] })).slots.map((d) => hhmm(d)), ['19:30'], 'the day of the fast posts only after it ends');
});

test("an account without a choice keeps its pack's schedule; with one, the choice, the plan and no posting windows", () => {
  const pack = ctx.pack('demo');
  db.run("DELETE FROM settings WHERE key = 'schedule:demo'");
  assert.equal(scheduleOf(db, pack), pack.meta.schedule, 'untouched');
  assert.equal(choiceOf(db, 'demo'), null);
  saveChoice(db, 'demo', { 0: ['09:00'], 2: ['09:00', '20:00'] });
  const s = scheduleOf(db, pack);
  assert.equal(s.chosen, true);
  assert.equal(s.perMonth, 40);
  assert.deepEqual(s.windows, []);
  assert.deepEqual(timesOf(s), ['09:00', '20:00']);
  // A customer's account is thinned to the plan accounts gives its workspace (src/budget/quota.js).
  paidWorkspaces(db, [1], { plan: { name: 'small', slideshows: 12, redos: 4 } });
  assert.equal(scheduleOf(db, pack).perMonth, 12, "the workspace's plan");
  db.run("DELETE FROM settings WHERE key = 'entitlement:1'");
  // Tuesday 2026-10-13 at 07:05: today's 09:00 and tomorrow's (Wednesday, nothing chosen) none. 09:00 is outside the
  // pack's windows (12-14, 19-22) and is drafted all the same: the customer chose it.
  const t = israelInstant('2026-10-13', '07:05').getTime();
  assert.deepEqual(generationTargets(db, pack, { t }).map((x) => hhmm(Date.parse(x))), ['09:00', '20:00']);
  db.run("DELETE FROM settings WHERE key = 'schedule:demo'");
});

test("what a choice gives next month is said: the plan reached, fewer than the plan, or more and thinned", () => {
  const pack = ctx.pack('demo');
  const t = israelInstant('2026-10-27', '10:00').getTime();
  const m = monthOf(db, pack, { t, byDay: DEFAULT_CHOICE });
  assert.equal(m.month, '2026-11');
  assert.equal(m.plan, 40);
  assert.ok(m.all > 40);
  assert.equal(m.slots, 40);
  assert.equal(m.rest, 0, 'Friday at 12:30 is before Shabbat and Saturday at 21:00 after it, all November');
  const sat = monthOf(db, pack, { t, byDay: { 6: ['12:00'] } });
  assert.equal(sat.all, 0);
  assert.equal(sat.rest, 4, "November 2026's four Saturdays at noon are Shabbat, and counted to be said");
  const few = monthOf(db, pack, { t, byDay: { 0: ['19:30'] } });
  assert.ok(few.all < 40 && few.slots === few.all);
});

test('the owner chooses the days and times on Settings; the form keeps to the account and refuses a bad time', async () => {
  const { cookie } = fake.session(customer(1));
  const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  assert.match(page, /id="schedule"/);
  assert.match(page, /<h2>מתי מפרסמים<\/h2>/);
  assert.match(page, /בשבת ובחג לא מפרסמים/);
  assert.match(page, /name="t1_0"/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)[1];
  const send = (body, ajax = true) => fetch(`${base}/accounts/demo/schedule`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });
  const badRes = await send({ day_1: 'on', t1_1: '02:00' });
  assert.equal(badRes.status, 422);
  assert.match((await badRes.json()).message, /בין 06:00 ל-23:30/);
  assert.equal(choiceOf(db, 'demo'), null, 'nothing saved');
  const ok = await send({ day_1: 'on', t1_1: '10:00', t2_1: '18:00', day_4: 'on', t1_4: '12:00', back: '/settings' }, false);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/settings');
  assert.deepEqual(choiceOf(db, 'demo')[1], ['10:00', '18:00']);
  assert.deepEqual(choiceOf(db, 'demo')[4], ['12:00']);
  const after2 = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  assert.match(after2, /name="day_1" checked/);
  assert.match(after2, /name="t2_1" value="18:00"/);
  assert.match(after2, /name="day_0">/, 'Sunday is off now');
  const elsewhere = await send({ day_1: 'on', t1_1: '10:00', back: 'https://evil.example/' }, false);
  assert.equal(elsewhere.headers.get('location'), '/settings#schedule', 'the form returns only to our own pages');
  // Another workspace's session cannot set this account's times.
  const other = fake.session(customer(9)).cookie;
  const oc = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/settings`, { headers: { cookie: other } })).text())[1];
  const refused = await fetch(`${base}/accounts/demo/schedule`, { method: 'POST', redirect: 'manual', headers: { cookie: other, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: oc, day_2: 'on', t1_2: '10:00' }).toString() });
  assert.equal(refused.status, 404);
  assert.deepEqual(choiceOf(db, 'demo')[2], []);
  db.run("DELETE FROM settings WHERE key = 'schedule:demo'");
});

test('the home page says the next posts are written for the days and times chosen in Settings', async () => {
  const { cookie } = fake.session(customer(1));
  const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
  assert.doesNotMatch(page, /בשעה שקבעתם/);
  if (/אין מה לאשר כרגע/.test(page)) assert.match(page, /לימים ולשעות שבחרתם <a href="\/settings#schedule">בהגדרות<\/a>/);
});
