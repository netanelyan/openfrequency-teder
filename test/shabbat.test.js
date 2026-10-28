import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { setSetting } from '../src/core/store.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { publishPost, PublishRefused } from '../src/publish/index.js';
import { releaseHeld } from '../src/publish/hold.js';
import { saveSound } from '../src/pipeline/sounds.js';
import { generationTargets, tick } from '../src/autonomy/runner.js';
import { approve } from '../src/web/actions.js';
import { scheduleData, schedulePanel, scheduleRoutes } from '../src/web/schedule.js';
import { DEFAULT_CHOICE, choiceOf, choiceRules, monthOf, readChoice, rulesFor, saveChoice, scheduleOf } from '../src/schedule/choice.js';
import { datesOf, monthSlots, slotsFor } from '../src/schedule/slots.js';
import { restAt, restDay, rulesOf } from '../src/schedule/shabbat.js';
import { validatePack } from '../src/packs/validate.js';
import { hhmm, israelDate, israelInstant, weekday } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// Posting on Shabbat and on the festivals is the owner's choice (src/schedule/choice.js), off unless they tick it.
// Off, everything is as it was: nothing posts from candle lighting to nightfall. On, the account's Saturday and Friday
// evening times (or its festival days) are ordinary times, at every rail: the slots, the runner, the publish path,
// the TikTok draft, a held post's release. One account's choice is its own.
//
// demo and beta are the same pack in two looks; gamma's pack.json posts on Shabbat itself (an operator's pack).

const at = (day, hm) => israelInstant(day, hm).getTime();
const sched = (byDay, extra = {}) => ({ slots: [], slotsByDay: byDay, windows: [], postsPerDay: 2, perMonth: null, ...extra });
const EVERY_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ['12:30', '19:30']]));
const months = () => {
  const out = [];
  for (let y = 2026; y <= 2028; y++) for (let m = 1; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`);
  return out;
};
const owner = { id: 1, name: 'owner' };

let home;
let ctx;
let db;

before(() => {
  home = tempHome({
    packs: {
      demo: null,
      beta: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
      gamma: (f) => {
        f.pack.schedule.shabbat = true;
        f.theme.variant = 'b';
        f.theme.fonts.display = 'Karantina';
        Object.assign(f.theme.colors, { bg: '#2B1B3D', surface: '#3A2850', ink: '#F7F2FB', muted: '#C9BCD8', accent: '#F59E0B', onAccent: '#2B1B3D' });
      },
    },
  });
  for (const id of ['demo', 'beta']) keepOnly(path.join(home.home, 'packs', id), ['basil-containers']);
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
});

after(async () => {
  await closeBrowser();
  home?.cleanup();
});
afterEach(() => setNow(null));

test('off is exactly as before: every day of three years gives the same slots, and the rest days are the same', () => {
  for (const month of months()) {
    for (const d of datesOf(month)) {
      const before = slotsFor(d, sched(EVERY_DAY));
      const off = slotsFor(d, sched(EVERY_DAY, { shabbat: false, holidays: false }));
      assert.deepEqual(off, before, d);
      assert.equal(restDay(d, { shabbat: false, holidays: false }), restDay(d), d);
    }
    // The default still reaches the plan of 40 in every month, festivals included.
    assert.equal(monthSlots(month, sched(DEFAULT_CHOICE, { perMonth: 40 })).slots.length, 40, month);
  }
  assert.deepEqual(rulesOf({}), { shabbat: false, holidays: false });
  assert.deepEqual(rulesOf({ shabbat: 'yes' }), { shabbat: false, holidays: false }, 'only true turns it on');
  for (const t of [at('2026-10-16', '19:40'), at('2026-10-17', '12:00'), at('2026-09-21', '12:30')]) assert.ok(restAt(t, {}) && restAt(t, {}) === restAt(t));
});

test('Shabbat on: Friday evening and Saturday post like any day; the festivals stay off', () => {
  const on = { shabbat: true };
  // 2026-10-16 is a Friday, 10-17 a Saturday; Shabbat runs about 17:06 to 18:35.
  assert.deepEqual(slotsFor('2026-10-16', sched({ 5: ['12:30', '20:00'] }, on)).slots.map((s) => hhmm(s)), ['12:30', '20:00']);
  assert.deepEqual(slotsFor('2026-10-17', sched({ 6: ['12:00', '21:30'] }, on)).slots.map((s) => hhmm(s)), ['12:00', '21:30']);
  assert.equal(restAt(at('2026-10-17', '12:00'), on), null);
  // Yom Kippur 5787 is a Monday, 2026-09-21; the first day of Sukkot a Saturday, 2026-09-26: still festivals.
  assert.deepEqual(slotsFor('2026-09-21', sched({ 1: ['12:30'] }, on)).slots, []);
  const sukkot = slotsFor('2026-09-26', sched({ 6: ['12:00'] }, on));
  assert.equal(weekday('2026-09-26'), 6);
  assert.equal(sukkot.slots.length, 0);
  assert.notEqual(sukkot.dropped[0].why, 'שבת', 'a festival on a Saturday is still the festival');
  // More days, the same plan: thinned to 40, and some of the 40 are on Saturdays now.
  for (const month of months()) {
    const kept = monthSlots(month, sched(EVERY_DAY, { ...on, perMonth: 40 })).slots;
    assert.equal(kept.length, 40, month);
    assert.ok(monthSlots(month, sched(EVERY_DAY, on)).all > monthSlots(month, sched(EVERY_DAY)).all, month);
    assert.ok(kept.some((s) => weekday(israelDate(s.getTime())) === 6), `${month}: a Saturday keeps a post`);
    assert.equal(monthSlots(month, sched(DEFAULT_CHOICE, { ...on, perMonth: 40 })).slots.length, 40, `${month}: the default too`);
  }
});

test('festivals on: the festival days post, Shabbat stays off, and a festival on a Saturday needs both', () => {
  const on = { holidays: true };
  assert.deepEqual(slotsFor('2026-09-21', sched({ 1: ['12:30'] }, on)).slots.map((s) => hhmm(s)), ['12:30'], 'Yom Kippur');
  assert.deepEqual(slotsFor('2026-09-20', sched({ 0: ['19:30'] }, on)).slots.map((s) => hhmm(s)), ['19:30'], 'the evening before');
  assert.equal(slotsFor('2026-10-17', sched({ 6: ['12:00'] }, on)).dropped[0].why, 'שבת');
  assert.equal(slotsFor('2026-09-26', sched({ 6: ['12:00'] }, on)).dropped[0].why, 'שבת', 'Sukkot on a Saturday is Shabbat');
  assert.deepEqual(slotsFor('2026-09-26', sched({ 6: ['12:00'] }, { shabbat: true, holidays: true })).slots.map((s) => hhmm(s)), ['12:00']);
});

test('the choice is read from two boxes, saved with the days, and laid over the pack; choiceOf still gives the days', () => {
  const pack = ctx.pack('demo');
  const f = { day_6: 'on', t1_6: '12:00', day_2: 'on', t1_2: '12:30' };
  assert.deepEqual(readChoice(f), { byDay: { 0: [], 1: [], 2: ['12:30'], 3: [], 4: [], 5: [], 6: ['12:00'] }, shabbat: false, holidays: false });
  const r = readChoice({ ...f, shabbat: 'on', holidays: 'on' });
  assert.equal(r.shabbat, true);
  assert.equal(r.holidays, true);
  assert.ok(readChoice({ shabbat: 'on' }).problems, 'the boxes alone are no choice');

  assert.deepEqual(choiceRules(db, 'demo'), { shabbat: null, holidays: null }, 'nothing saved');
  assert.equal(scheduleOf(db, pack), pack.meta.schedule, 'untouched');
  saveChoice(db, 'demo', r.byDay, { shabbat: true });
  assert.deepEqual(choiceOf(db, 'demo')[6], ['12:00'], 'the days, as before');
  assert.deepEqual(choiceRules(db, 'demo'), { shabbat: true, holidays: false });
  assert.deepEqual(rulesFor(db, pack), { shabbat: true, holidays: false });
  assert.equal(scheduleOf(db, pack).shabbat, true);
  saveChoice(db, 'demo', r.byDay);
  assert.deepEqual(rulesFor(db, pack), { shabbat: false, holidays: false }, 'off unless chosen');
  // A choice saved before the boxes existed keeps the pack's.
  setSetting(db, 'schedule:gamma', { byDay: r.byDay, at: new Date().toISOString() });
  assert.deepEqual(rulesFor(db, ctx.pack('gamma')), { shabbat: true, holidays: false });
  db.run("DELETE FROM settings WHERE key IN ('schedule:demo', 'schedule:gamma')");
});

test("an operator's pack may post on Shabbat; the owner's saved choice wins over it", () => {
  const gamma = ctx.pack('gamma');
  assert.deepEqual(validatePack(gamma).filter((p) => /schedule\.(shabbat|holidays)/.test(p)), []);
  assert.match(validatePack({ ...gamma, meta: { ...gamma.meta, schedule: { ...gamma.meta.schedule, holidays: 'yes' } } }).join(' '), /schedule\.holidays must be true or false/);
  // gamma's Saturday is 21:00, after Shabbat in October anyway; its weekday 12:40 on a Saturday shows the rule.
  const sat = { ...scheduleOf(db, gamma), slotsByDay: { 6: ['12:40'] } };
  assert.equal(sat.shabbat, true);
  assert.deepEqual(slotsFor('2026-10-17', sat).slots.map((s) => hhmm(s)), ['12:40']);
  saveChoice(db, 'gamma', { 6: ['12:40'] }, { shabbat: false });
  assert.deepEqual(slotsFor('2026-10-17', scheduleOf(db, gamma)).slots, [], 'the owner said no');
  saveChoice(db, 'gamma', { 6: ['12:40'] }, { shabbat: true });
  assert.deepEqual(slotsFor('2026-10-17', scheduleOf(db, gamma)).slots.map((s) => hhmm(s)), ['12:40']);
  db.run("DELETE FROM settings WHERE key = 'schedule:gamma'");
});

test("one account's choice is its own: demo posts on Saturday, beta with the same days does not", () => {
  const byDay = { 2: ['12:30'], 6: ['12:00'] };
  saveChoice(db, 'demo', byDay, { shabbat: true });
  saveChoice(db, 'beta', byDay);
  const friday = at('2026-10-16', '07:05');
  assert.deepEqual(generationTargets(db, ctx.pack('demo'), { t: friday }).map((x) => [israelDate(Date.parse(x)), hhmm(Date.parse(x))]), [['2026-10-17', '12:00']]);
  assert.deepEqual(generationTargets(db, ctx.pack('beta'), { t: friday }), []);
  assert.deepEqual(rulesFor(db, ctx.pack('beta')), { shabbat: false, holidays: false });
  assert.deepEqual(rulesFor(db, ctx.pack('gamma')), { shabbat: true, holidays: false }, "gamma's pack, untouched by either");
});

test('end to end on a Saturday: the TikTok draft, the runner and the publish path follow each account', async () => {
  // The choices from the test before: demo posts on Shabbat, beta does not.
  const slot = at('2026-10-17', '12:00');
  const posts = {};
  for (const id of ['demo', 'beta']) {
    const pack = ctx.pack(id);
    delete pack.meta.zernio.tiktokMode;
    saveSound(db, id, { name: 'Espresso', artist: 'Sabrina Carpenter' });
    const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    db.update('posts', res.postId, { slot_at: new Date(slot).toISOString() });
    posts[id] = res.postId;
  }
  // Approved on Saturday morning: demo's draft goes to TikTok now, beta's waits for Shabbat to end.
  setNow(at('2026-10-17', '10:00'));
  const a = approve(ctx, owner, { id: posts.demo });
  assert.match(a.message, /הטיוטה נשלחת לטיקטוק/);
  assert.equal((await a.job).state, 'drafted');
  const b = approve(ctx, owner, { id: posts.beta });
  assert.match(b.message, /הטיוטה תישלח לטיקטוק כששבת ייגמר/);
  const held = await b.job;
  assert.equal(held.state, 'held');
  assert.equal(held.code, 'shabbat');
  setNow(null);

  // The runner at the slot: demo's post goes out, beta's does not. Nothing else is drafted at this tick.
  const t = slot + 5 * 60_000;
  for (const id of ['demo', 'beta', 'gamma']) for (const k of ['generated', 'feedback', 'topics']) setSetting(db, `${k}:${id}:2026-10-17`, new Date(t).toISOString());
  const r = await tick(ctx, { t });
  assert.deepEqual(r.published.map((x) => x.account), ['demo'], JSON.stringify(r.errors));
  assert.equal(loadPost(db, posts.demo).status, 'published');
  assert.equal(loadPost(db, posts.beta).status, 'approved');
  // Asked by hand, beta is still refused; Saturday night it goes.
  await assert.rejects(publishPost(ctx, posts.beta, { t }), (e) => e instanceof PublishRefused && e.code === 'shabbat');
  assert.ok((await publishPost(ctx, posts.beta, { t: at('2026-10-17', '21:00') })).ok);
});

test("a held post is released to the account's next free slot, Saturday's for an account that posts on Shabbat", async () => {
  const byDay = { 0: ['12:30'], 6: ['12:00'] };
  saveChoice(db, 'demo', byDay, { shabbat: true });
  saveChoice(db, 'beta', byDay);
  const t = at('2026-10-24', '08:00'); // a Saturday
  for (const id of ['demo', 'beta']) {
    const row = db.get("SELECT id FROM posts WHERE account_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 1", id);
    db.update('posts', row.id, { status: 'held', slot_at: null });
    const [out] = releaseHeld(db, ctx.pack(id), { t });
    const s = Date.parse(out.slotAt);
    assert.deepEqual([israelDate(s), hhmm(s)], id === 'demo' ? ['2026-10-24', '12:00'] : ['2026-10-25', '12:30'], id);
  }
  db.run("DELETE FROM settings WHERE key IN ('schedule:demo', 'schedule:beta')");
});

test('the panel shows the two boxes and says what the month gives, for each choice', () => {
  const pack = ctx.pack('demo');
  const page = (choice, t = at('2026-10-27', '10:00')) => {
    const d = scheduleData(db, pack, { t, choice });
    return { d, html: schedulePanel({ csrf: 'x' }, d) };
  };
  // Off: the boxes unticked, Friday's and Saturday's notes, and the Saturdays at noon counted as Shabbat.
  const off = page({ byDay: { 6: ['12:00'] } });
  assert.match(off.html, /<input type="checkbox" name="shabbat"> לפרסם גם בשבת/);
  assert.match(off.html, /<input type="checkbox" name="holidays"> לפרסם גם בחגים/);
  assert.match(off.html, /בשבת ובחג לא מפרסמים, אלא אם תסמנו כאן/);
  assert.match(off.html, /אחרי צאת השבת/);
  assert.equal(off.d.month.rest, 4);
  assert.match(off.html, /4 מהשעות שבחרתם נופלות בחודש הבא בשבת, ובהן לא מפרסמים/);
  assert.match(off.html, /יוצאים בחודש הבא 0 פוסטים/);
  // Shabbat on: the box ticked, no notes, November's four Saturdays post.
  const on = page({ byDay: { 6: ['12:00'] }, shabbat: true });
  assert.match(on.html, /name="shabbat" checked/);
  assert.doesNotMatch(on.html, /name="holidays" checked/);
  assert.doesNotMatch(on.html, /צאת השבת|כניסת השבת/);
  assert.match(on.html, /מפרסמים גם בשבת\. בחגים לא מפרסמים/);
  assert.deepEqual([on.d.month.all, on.d.month.rest], [4, 0]);
  assert.match(on.html, /יוצאים בחודש הבא 4 פוסטים/);
  assert.doesNotMatch(on.html, /נופלות|נופלת/);
  // September 2026's Mondays: Yom Kippur is one of them. Off, it is said as a festival; on, it posts.
  const august = at('2026-08-20', '10:00');
  const yk = page({ byDay: { 1: ['12:30'] } }, august);
  assert.equal(yk.d.month.month, '2026-09');
  assert.deepEqual(yk.d.month.restBy, { shabbat: 0, holidays: 1 });
  assert.match(yk.html, /אחת השעות שבחרתם נופלת בחודש הבא בחג, ובה לא מפרסמים/);
  const ykOn = page({ byDay: { 1: ['12:30'] }, holidays: true }, august);
  assert.equal(ykOn.d.month.rest, 0);
  assert.equal(ykOn.d.month.all, yk.d.month.all + 1);
  assert.match(ykOn.html, /מפרסמים גם בחגים\. בשבת לא מפרסמים/);
  assert.match(page({ byDay: { 1: ['12:30'] }, shabbat: true, holidays: true }).html, /מפרסמים גם בשבת וגם בחגים/);
  // Both kinds in one month: said as both.
  const both = page({ byDay: { 1: ['12:30'], 6: ['12:00'] } }, august);
  assert.match(both.html, /נופלות בחודש הבא בשבת או בחג/);
  // A saved choice is what the panel shows without one standing in.
  saveChoice(db, 'demo', { 6: ['12:00'] }, { holidays: true });
  assert.match(page(null).html, /name="holidays" checked/);
  assert.equal(monthOf(db, pack, { t: at('2026-10-27', '10:00') }).rules.holidays, true);
  db.run("DELETE FROM settings WHERE key = 'schedule:demo'");
  for (const html of [off.html, on.html, yk.html]) assert.doesNotMatch(html, /—|–/, 'no dashes');
});

test('the form saves the boxes; a form without them saves them off', () => {
  const [, , save] = scheduleRoutes()[0];
  const res = save(ctx, owner, [null, 'beta'], { day_6: 'on', t1_6: '12:00', shabbat: 'on', back: '/settings' });
  assert.equal(res.ok, true);
  assert.deepEqual(choiceRules(db, 'beta'), { shabbat: true, holidays: false });
  assert.deepEqual(choiceRules(db, 'demo'), { shabbat: null, holidays: null }, 'only that account');
  save(ctx, owner, [null, 'beta'], { day_6: 'on', t1_6: '12:00' });
  assert.deepEqual(rulesFor(db, ctx.pack('beta')), { shabbat: false, holidays: false });
  db.run("DELETE FROM settings WHERE key = 'schedule:beta'");
});
