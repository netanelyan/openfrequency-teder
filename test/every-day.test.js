import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, DraftCapError, loadPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { setNow } from '../src/core/clock.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { DRAFTS_PER_DAY, draftsToday, monthsOf, usage } from '../src/budget/quota.js';
import { tick } from '../src/autonomy/runner.js';
import { dayOpen, declinedSlots, REFILL_AGAIN_MS, refillDeclined, slotCovered } from '../src/autonomy/every-day.js';
import { approve, reject } from '../src/web/actions.js';
import { israelDate, israelInstant } from '../src/schedule/israel.js';
import { postFull, settingsData } from '../src/web/data.js';
import { postPage, settingsPage } from '../src/web/pages.js';
import { layout } from '../src/web/ui.js';
import { forWorkspace } from '../src/web/workspace.js';
import { opened, tempHome } from './helpers.js';

// A post every day (src/autonomy/every-day.js). The owner, 2026-11-09: "because we promise 40 videos a month, there
// cant be a day without posts. even if 10 posts are being declined, the customer has to get the 11th". And from
// 2026-11-08, still standing: "not every rejection should trigger a redo. user chooses it".

after(() => closeBrowser());
afterEach(() => setNow(null));

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

const OCT = israelInstant('2026-10-13', '09:00').getTime();
const SLOT = israelInstant('2026-10-14', '12:45').toISOString();
const customer = { id: 2, name: 'customer', operator: false };

let n = 0;
/** A post row as the pipeline leaves it. */
const row = (db, patch) => {
  const at = new Date(patch.at ?? OCT).toISOString();
  const id = `e${++n}`;
  db.insert('posts', { id, account_id: 'demo', status: 'queued', created_at: at, updated_at: at, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'at')) });
  return id;
};

test('ten declines in a row on one day, and the customer still gets the eleventh; their choice of a redo is kept, and the declines eat none of their 40', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const first = await buildPost(ctx, { pack, slotAt: SLOT });
    assert.equal(first.status, 'queued', first.reason);
    let current = first.postId;
    let t = OCT;
    const kinds = [];
    const waiting = () => ctx.db.all("SELECT id FROM posts WHERE account_id = 'demo' AND status = 'queued' AND slot_at = ?", SLOT).map((r) => r.id);
    for (let i = 0; i < 10; i++) {
      // The customer chooses: the first three written again their way, the other seven declined outright.
      const redo = i < 3 ? '1' : '0';
      const r = reject(ctx, customer, { id: current }, { reason: i < 3 ? 'shorter' : 'topic', redo });
      assert.ok(r.job, `decline ${i + 1}: something is written for the day (${r.message})`);
      const done = await r.job;
      // What the rejection wrote may be stopped by our own checks (a recorded draft's cover that does not fit, say):
      // then the runner writes the day again, as many times as it takes.
      for (let k = 0; k < 4 && !waiting().length; k++) {
        t += REFILL_AGAIN_MS;
        setNow(t);
        await refillDeclined(ctx, {}, { t });
      }
      const ids = waiting();
      assert.equal(ids.length, 1, `decline ${i + 1}: one post waits for the day (${done.why || 'written'})`);
      const next = loadPost(ctx.db, ids[0]);
      assert.equal(israelDate(Date.parse(next.slot_at)), '2026-10-14', 'the same day');
      if (done.ok) assert.equal(next.redo_of, i < 3 ? current : null, i < 3 ? 'a redo of the declined post' : 'a new post, not a redo');
      kinds.push(next.quota_kind);
      current = next.id;
    }
    assert.deepEqual(kinds.slice(3), Array(7).fill('suggestion'), 'declined outright: new posts, no redo');
    assert.ok(kinds.slice(0, 3).every((k) => k === 'redo' || k === 'suggestion'));
    // The eleventh waits for the customer, at the day's slot.
    const eleventh = loadPost(ctx.db, current);
    assert.deepEqual([eleventh.status, eleventh.slot_at], ['queued', SLOT]);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE status = 'rejected'").n, 10);
    const redos = kinds.filter((k) => k === 'redo').length;
    // None of the ten declines counts: the eleventh holds one place while it waits.
    let u = usage(ctx.db, 'demo');
    assert.deepEqual([u.suggested.used, u.suggested.waiting, u.suggested.left, u.redos.used], [0, 1, 39, redos]);
    approve(ctx, customer, { id: current });
    u = usage(ctx.db, 'demo');
    assert.deepEqual([u.suggested.used, u.suggested.waiting, u.suggested.left], [1, 0, 39], 'the one they got is the one counted');
    assert.ok(draftsToday(ctx.db, 'demo', t) >= 11);
    assert.ok(draftsToday(ctx.db, 'demo', t) < DRAFTS_PER_DAY, 'well within the guard');
    assert.deepEqual(declinedSlots(ctx.db, pack, { t }), [], 'nothing left for the runner to fill');
  } finally {
    cleanup();
  }
});

test("declines and expired posts never eat into the customer's 40: only what they got counts, and the pages say 'פורסמו X מתוך 40'", () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    setNow(OCT);
    for (let i = 0; i < 30; i++) row(ctx.db, { status: 'rejected', quota_kind: 'suggestion', quota_month: '2026-10' });
    for (let i = 0; i < 5; i++) row(ctx.db, { status: 'expired', quota_kind: 'suggestion', quota_month: '2026-10' });
    for (let i = 0; i < 3; i++) row(ctx.db, { status: 'blocked', quota_kind: 'retry', quota_month: '2026-10' });
    for (let i = 0; i < 10; i++) row(ctx.db, { status: 'published', quota_kind: 'suggestion', quota_month: '2026-10' });
    for (let i = 0; i < 2; i++) row(ctx.db, { status: 'approved', quota_kind: 'suggestion', quota_month: '2026-10' });
    row(ctx.db, { status: 'queued', quota_kind: 'suggestion', quota_month: '2026-10' });
    const u = usage(ctx.db, 'demo');
    assert.deepEqual(u.suggested, { used: 12, out: 10, waiting: 1, held: 0, limit: 40, left: 27 }, 'forty-eight offered, twelve got');
    assert.deepEqual(monthsOf(ctx.db, ['demo']), { used: 12, out: 10, limit: 40 });
    // The same in a customer's workspace, shared by its accounts.
    ctx.db.run("UPDATE accounts SET workspace_id = 7 WHERE id = 'demo'");
    assert.deepEqual([usage(ctx.db, 'demo').plan.scope, usage(ctx.db, 'demo').suggested.used], ['workspace', 12]);
    // What the customer reads: the side bar's ring and the plan on Settings, in posts, never in suggestions.
    const bar = layout({ title: 'x', quota: monthsOf(ctx.db, ['demo']), links: {} }, '');
    assert.match(bar, /title="פורסמו 10 מתוך 40 החודש"/);
    assert.match(bar, /<span class="lbl">פורסמו<\/span><span class="amt num ltr"><b>10<\/b><span> \/ 40<\/span>/);
    const settings = settingsPage({ csrf: 'x', user: { name: 'owner' }, operator: false, workspace: { id: 7, name: 'W' }, links: {} }, settingsData(forWorkspace(ctx, 7)));
    assert.match(settings, /פורסמו 10 מתוך 40/);
    assert.match(settings, /ועוד 2 פוסטים מאושרים שמחכים לשעה שלהם/);
    assert.match(settings, /פוסט נספר רק כשאישרתם אותו. פוסט שדחיתם לא נספר, ובמקומו מגיע פוסט אחר לאותו יום/);
    assert.doesNotMatch(settings, /הצעות/, 'no "suggestions" left on the customer\'s page');
  } finally {
    cleanup();
  }
});

test('the runner gives a declined day its post when the rejection could not (a pause), tries a slot again only after REFILL_AGAIN_MS, and leaves a day that is over', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const first = await buildPost(ctx, { pack, slotAt: SLOT });
    assert.equal(first.status, 'queued', first.reason);
    // Declined while the account is paused: nothing can be written now.
    ctx.db.run("UPDATE accounts SET status = 'paused', paused_reason = 'owner' WHERE id = 'demo'");
    const r = reject(ctx, customer, { id: first.postId }, { reason: 'topic', redo: '0' });
    assert.equal(r.job, undefined);
    assert.match(r.message, /הכתיבה בחשבון עצורה כרגע/);
    assert.deepEqual(declinedSlots(ctx.db, pack, { t: OCT }), [SLOT]);
    let report = await refillDeclined(ctx, {}, { t: OCT });
    assert.equal(report.refilled, undefined, 'a paused account drafts nothing');
    // Running again: the next tick drafts the day (generation is set for the evening, so only this happens).
    ctx.db.run("UPDATE accounts SET status = 'active', paused_reason = NULL WHERE id = 'demo'");
    setSetting(ctx.db, 'generateAt', '23:00');
    setSetting(ctx.db, 'feedbackAt', '22:00');
    const t1 = OCT + 60_000;
    setNow(t1);
    report = await tick(ctx, { t: t1 });
    assert.equal(report.refilled?.length, 1, JSON.stringify(report.refilled || report.errors));
    const day = loadPost(ctx.db, report.refilled[0].post);
    assert.deepEqual([day.status, day.slot_at, day.quota_kind], ['queued', SLOT, 'suggestion']);
    assert.equal(slotCovered(ctx.db, 'demo', SLOT, t1), true);
    assert.equal(loadPost(ctx.db, first.postId).reject.day, 'queued');
    // Declined again while paused, then running: the slot was tried a minute ago, so not again until REFILL_AGAIN_MS.
    ctx.db.run("UPDATE accounts SET status = 'paused', paused_reason = 'owner' WHERE id = 'demo'");
    reject(ctx, customer, { id: day.id }, { reason: 'tone', redo: '0' });
    ctx.db.run("UPDATE accounts SET status = 'active', paused_reason = NULL WHERE id = 'demo'");
    report = await refillDeclined(ctx, {}, { t: t1 + 5 * 60_000 });
    assert.equal(report.refilled, undefined, 'tried five minutes ago');
    const t2 = t1 + REFILL_AGAIN_MS;
    setNow(t2);
    report = await refillDeclined(ctx, {}, { t: t2 });
    assert.equal(report.refilled?.[0]?.status, 'queued', JSON.stringify(report.refilled));
    // A day that is over, or nearly (less than an hour of it left), is not drafted again: its post would expire unseen.
    assert.equal(dayOpen(SLOT, israelInstant('2026-10-14', '22:30').getTime()), true);
    assert.equal(dayOpen(SLOT, israelInstant('2026-10-14', '23:10').getTime()), false);
    assert.equal(dayOpen(SLOT, israelInstant('2026-10-15', '09:00').getTime()), false);
    const late = israelInstant('2026-10-15', '09:00').getTime();
    ctx.db.run("UPDATE posts SET status = 'rejected' WHERE status = 'queued'");
    assert.deepEqual(declinedSlots(ctx.db, pack, { t: late }), []);
  } finally {
    cleanup();
  }
});

test('in approval mode a new post for a passed slot waits for the customer, never goes out on its own, and goes out the same day once approved', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    // Approval mode: the one a customer's account is always in (src/autonomy/rails.js), here on the operator's own
    // account so that an approved post goes out (written to disk) without a platform to connect.
    ctx.db.run("UPDATE accounts SET mode = 'approve' WHERE id = 'demo'");
    setSetting(ctx.db, 'generateAt', '23:00');
    setSetting(ctx.db, 'feedbackAt', '22:00');
    const slot = israelInstant('2026-10-13', '12:45').toISOString();
    setNow(OCT);
    const first = await buildPost(ctx, { pack, slotAt: slot });
    // Declined after its time had passed, the same afternoon.
    const afternoon = israelInstant('2026-10-13', '15:00').getTime();
    setNow(afternoon);
    const r = reject(ctx, customer, { id: first.postId }, { reason: 'topic', redo: '0' });
    const done = await r.job;
    assert.equal(done.ok, true, done.why);
    assert.equal(loadPost(ctx.db, done.postId).slot_at, slot, 'the declined post\'s slot, though it has passed');
    // The ticks after: it is not approved by the engine and not sent.
    for (const t of [afternoon + 60_000, afternoon + 2 * 60_000]) {
      setNow(t);
      await tick(ctx, { t });
    }
    assert.equal(loadPost(ctx.db, done.postId).status, 'queued', 'waits for the customer');
    assert.match(postPage({ csrf: 'x' }, postFull(ctx, first.postId)), /נכתב פוסט אחר לאותו יום/);
    // Approved the same evening, inside the account's publishing window (the demo's evening one, from 19:00; a
    // customer's own schedule has none): it goes out at the next tick.
    setNow(israelInstant('2026-10-13', '19:00').getTime());
    approve(ctx, customer, { id: done.postId });
    const t = israelInstant('2026-10-13', '19:01').getTime();
    setNow(t);
    const report = await tick(ctx, { t });
    assert.ok(report.published.some((p) => p.post === done.postId), JSON.stringify({ published: report.published, errors: report.errors, status: loadPost(ctx.db, done.postId).status }));
  } finally {
    cleanup();
  }
});

test('the guard: DRAFTS_PER_DAY drafts an account a day, then nothing and the operator hears it once; never a limit the customer reads', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const first = await buildPost(ctx, { pack, slotAt: SLOT });
    assert.equal(first.status, 'queued', first.reason);
    // A runaway morning: the rest of the day's drafts, all declined.
    for (let i = 1; i < DRAFTS_PER_DAY; i++) row(ctx.db, { status: 'rejected', quota_kind: 'suggestion', quota_month: '2026-10', slot_at: SLOT, at: OCT - 60 * 60_000 });
    assert.equal(draftsToday(ctx.db, 'demo', OCT), DRAFTS_PER_DAY);
    const before = ctx.db.get('SELECT COUNT(*) AS n FROM posts').n;
    await assert.rejects(buildPost(ctx, { pack, slotAt: SLOT }), (e) => e instanceof DraftCapError && new RegExp(`the most a day is ${DRAFTS_PER_DAY}`).test(e.message));
    assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM posts').n, before, 'nothing started, nothing spent');
    const alert = getSetting(ctx.db, 'alert:draft-cap:demo');
    assert.match(alert.title, new RegExp(`drafted ${DRAFTS_PER_DAY} posts today`));
    // Once a day: the next refusal says nothing new.
    await assert.rejects(buildPost(ctx, { pack, slotAt: SLOT }), DraftCapError);
    assert.equal(getSetting(ctx.db, 'alert:draft-cap:demo').at, alert.at);
    // The customer declines the one waiting: nothing more is written today, and nothing they read names a limit.
    const r = reject(ctx, customer, { id: first.postId }, { reason: 'topic', redo: '0' });
    const done = await r.job;
    assert.equal(done.ok, false);
    assert.match(done.why, /drafted today/);
    const page = postPage({ csrf: 'x' }, postFull(ctx, first.postId));
    assert.doesNotMatch(`${r.message} ${page}`, new RegExp(`${DRAFTS_PER_DAY} פוסטים|מגבלה|הגבלה|מכסה יומית`));
    assert.equal((await refillDeclined(ctx, {}, { t: OCT + REFILL_AGAIN_MS })).refilled?.[0]?.post ?? null, null, 'the runner is held by the guard too');
    // The next morning the day is drafted again: it is still open.
    const next = israelInstant('2026-10-14', '08:00').getTime();
    setNow(next);
    const report = await refillDeclined(ctx, {}, { t: next });
    assert.equal(report.refilled?.[0]?.status, 'queued', JSON.stringify(report.refilled));
    assert.equal(loadPost(ctx.db, report.refilled[0].post).slot_at, SLOT);
  } finally {
    cleanup();
  }
});
