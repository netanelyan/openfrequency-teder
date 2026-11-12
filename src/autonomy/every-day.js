import { now } from '../core/clock.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';
import { addDays, israelDate, israelInstant } from '../schedule/israel.js';
import { buildPost, PausedError } from '../pipeline/build.js';
import { notify } from '../notify/index.js';
import { HOLD_MS, room } from '../budget/quota.js';
import { autonomyMode, canGenerate } from './rails.js';

// A post every day. The owner, 2026-11-09: "because we promise 40 videos a month, there cant be a day without posts.
// even if 10 posts are being declined, the customer has to get the 11th".
//
// Until then a declined post left its slot empty: the slot still had a post (a rejected one), so the day's
// generation never drafted it again, and a decline without a redo, or with the month's redos used up, was the
// day's last word. Now a declined post's day gets another post, as many times as it is declined:
//
//   - the customer still chooses what the next one is (the owner, 2026-11-08: "not every rejection should trigger a
//     redo. user chooses it"). "לדחות ולכתוב מחדש" writes the same post again their way, with their reason
//     (src/pipeline/redo.js), while the month has redos; "לדחות", or a redo asked for when the redos are used up, gets
//     a new post for that day instead: another topic, written as any day's post is (refillSlot below, started by the
//     rejection itself, src/web/actions.js reject)
//   - whatever is left without one (a redo our checks stopped twice, a new post that was blocked, a rejection while
//     the account could not run), the runner drafts again for that day, a minute later at most (refillDeclined, in
//     every tick), each slot no sooner than REFILL_AGAIN_MS after its last try
//   - a declined post gives its place in the month back (src/budget/quota.js: the plan counts the posts the customer
//     got, not the ones offered), so the new one never eats into their 40. When the month's posts are all taken,
//     nothing more is drafted: the promise is kept
//   - what stops a loop is ours, never the customer's: DRAFTS_PER_DAY (src/budget/quota.js) drafts an account a day,
//     every kind together, then nothing until tomorrow and the operator is told (src/pipeline/build.js DraftCapError)
//
// In approval mode nothing changes about publishing: a post is never sent without the customer's approval, and one
// not approved by the end of its day expires (src/autonomy/runner.js, step 3). The new post keeps the declined one's
// slot even when that time has passed: it waits for them, and approved on the same day it goes out at once. So a day
// whose post was declined always has another one waiting. A day that is over is not drafted again: its post would
// expire unseen.

/** Today's declined slots are drafted again only while this much of the Israel day is left. */
export const DAY_LEFT_MS = 60 * 60_000;
/** The runner tries a declined slot again no sooner than this after its last try. */
export const REFILL_AGAIN_MS = 20 * 60_000;
/** The most declined slots the runner drafts in one tick: the rest wait for the next, so publishing is not held up. */
export const REFILL_PER_TICK = 2;

/** The statuses of a post that holds its day: waiting, approved, on its way, out, or failed to send (a person sends it again). */
const HOLDS = "status IN ('queued', 'approved', 'held', 'publishing', 'published', 'drafted', 'failed')";

/**
 * The slot a post stands for: its own; or, for a replacement written without one (a redo whose slot was too close,
 * src/pipeline/redo.js), the slot of the post it replaced, up the chain. null when none has one.
 */
export function daySlotOf(db, post) {
  let p = post;
  const seen = new Set();
  while (p && !p.slot_at && p.redo_of && !seen.has(p.id)) {
    seen.add(p.id);
    p = db.get('SELECT id, slot_at, redo_of FROM posts WHERE id = ?', p.redo_of);
  }
  return p?.slot_at || null;
}

/** Is the day of this slot still worth a new post: a later day, or today with DAY_LEFT_MS of it left. */
export function dayOpen(slotAt, t = now()) {
  const day = israelDate(Date.parse(slotAt));
  const today = israelDate(t);
  if (day > today) return true;
  return day === today && t < israelInstant(addDays(today, 1), '00:00').getTime() - DAY_LEFT_MS;
}

/**
 * Does the slot have a post that holds it: one at that time, or one written to replace a post at that time (a redo,
 * and a redo of a redo), that waits, is approved or out, or is being written now (a draft younger than HOLD_MS).
 */
export function slotCovered(db, accountId, slotAt, t = now()) {
  const since = new Date(t - HOLD_MS).toISOString();
  return Boolean(
    db.get(
      `WITH RECURSIVE chain(id) AS (SELECT id FROM posts WHERE account_id = ? AND slot_at = ? UNION SELECT p.id FROM posts p JOIN chain c ON p.redo_of = c.id)
       SELECT 1 AS y FROM posts WHERE id IN (SELECT id FROM chain) AND sample = 0 AND (${HOLDS} OR (status = 'drafting' AND created_at >= ?)) LIMIT 1`,
      accountId,
      slotAt,
      since
    )
  );
}

/** An account's slots, today's and later, whose post was declined and that nothing holds now, earliest first. */
export function declinedSlots(db, pack, { t = now() } = {}) {
  const from = israelInstant(israelDate(t), '00:00').toISOString();
  return db
    .all("SELECT DISTINCT slot_at FROM posts WHERE account_id = ? AND sample = 0 AND status = 'rejected' AND slot_at IS NOT NULL AND slot_at >= ? ORDER BY slot_at", pack.id, from)
    .map((r) => r.slot_at)
    .filter((s) => dayOpen(s, t) && !slotCovered(db, pack.id, s, t));
}

/** What became of the declined post's day, kept on it for its page: { day: 'writing'|'queued'|'failed', dayPost }. */
function noteDay(db, postId, patch) {
  if (!postId) return;
  const row = db.get('SELECT reject_json FROM posts WHERE id = ?', postId);
  if (row) db.update('posts', postId, { reject_json: { ...j(row.reject_json, {}), ...patch } });
}

/**
 * Draft a new post for a declined slot, directly (minutes, never a batch), and tell the customer once it waits for
 * them. `declined` is the rejected post, when there is one to note it on. The drafting row is inserted before this
 * returns its promise (buildPost holds its place before it first waits), so a second rejection or the runner a moment
 * later already sees the slot held. Resolves to { ok, postId, status, why }; never throws.
 */
export async function refillSlot(ctx, pack, slotAt, { declined = null } = {}) {
  const { db } = ctx;
  let res;
  try {
    res = await buildPost(ctx, { pack, slotAt });
  } catch (e) {
    // Paused, killed, the month's posts all taken, or the day's drafts at their most: nothing drafted.
    if (!(e instanceof PausedError)) ctx.log?.(`refill ${pack.id} ${slotAt}: ${e.stack || e.message}`);
    noteDay(db, declined, { day: 'failed' });
    return { ok: false, postId: null, status: null, why: e.message };
  }
  db.update('posts', res.postId, { mode_at_queue: autonomyMode(db, pack.id) });
  if (res.status !== 'queued') {
    noteDay(db, declined, { day: 'failed' });
    return { ok: false, postId: res.postId, status: res.status, why: res.reason };
  }
  noteDay(db, declined, { day: 'queued', dayPost: res.postId });
  audit(db, { action: 'day_refilled', accountId: pack.id, postId: res.postId, detail: { slotAt, declined } });
  // A post deleted from the schedule (src/web/actions.js deletePost) is said as deleted.
  const deleted = Boolean(declined && j(db.get('SELECT reject_json FROM posts WHERE id = ?', declined)?.reject_json, {})?.deleted);
  await notify(ctx, { accountId: pack.id, postId: res.postId, kind: 'refill', title: 'פוסט חדש מחכה לאישור', body: `במקום הפוסט ש${deleted ? 'מחקתם' : 'דחיתם'}, לאותו יום.`, url: `/post/${res.postId}` }).catch((e) => ctx.log?.(`notify: ${e.message}`));
  return { ok: true, postId: res.postId, status: res.status, why: null };
}

/**
 * Every tick: the declined slots of the accounts that run, today's and later, that nothing holds, drafted again
 * directly, REFILL_PER_TICK at most, each slot no sooner than REFILL_AGAIN_MS after its last try (settings
 * refill:<account>:<slot>). `report.refilled` lists them.
 */
export async function refillDeclined(ctx, report, { t = now() } = {}) {
  const { db } = ctx;
  const plans = [];
  for (const pack of ctx.packs) {
    if (plans.length >= REFILL_PER_TICK) break;
    const acc = db.get('SELECT status FROM accounts WHERE id = ?', pack.id);
    if (!acc || acc.status === 'onboarding' || !canGenerate(db, pack.id).ok) continue;
    for (const slotAt of declinedSlots(db, pack, { t })) {
      if (plans.length >= REFILL_PER_TICK) break;
      const key = `refill:${pack.id}:${slotAt}`;
      const last = getSetting(db, key);
      if (last && t - Date.parse(last) < REFILL_AGAIN_MS) continue;
      if (!room(db, pack.id, { t }).ok) break;
      setSetting(db, key, new Date(t).toISOString());
      const declined = db.get("SELECT id FROM posts WHERE account_id = ? AND slot_at = ? AND status = 'rejected' ORDER BY updated_at DESC LIMIT 1", pack.id, slotAt)?.id || null;
      plans.push({ pack, slotAt, declined });
    }
  }
  for (const p of plans) {
    const r = await refillSlot({ ...ctx, batchApi: null }, p.pack, p.slotAt, { declined: p.declined });
    (report.refilled ||= []).push({ account: p.pack.id, slotAt: p.slotAt, post: r.postId, status: r.status, why: r.why });
  }
  return report;
}

