import { HOUR, now, nowIso } from '../core/clock.js';
import { audit, step } from '../core/store.js';
import { addDays, israelDate } from '../schedule/israel.js';
import { slotsFor } from '../schedule/slots.js';
import { scheduleOf } from '../schedule/choice.js';
import { zernioAccountId } from './connect.js';
import { instagramConfigured } from './instagram.js';
import { retireDraft, wantedPublisher } from './index.js';
import { loadPost } from '../pipeline/build.js';
import { zernioConfigured } from './zernio.js';
import { OPTIONAL_PLATFORMS } from '../core/platforms.js';

// A post approved for a platform the customer has not connected yet is held, not failed.
//
// Before this, a post at its slot went to Zernio with no account id, failed in English ("no Zernio tiktok account id in
// pack.json"), and three such failures paused the account. Now:
//
//   - at the slot (publishPost), a post whose every platform still to go has nothing connected is "held": nothing is
//     sent, nothing fails, nothing counts toward the publish-error streak. One of two platforms connected: the post goes
//     to that one, and the other is marked skipped (not_connected) on the post.
//   - the website shows a banner to connect, and accounts emails the owner once a day (src/notify/email.js).
//   - a Facebook Page is optional (src/core/platforms.js): a post goes to TikTok and Instagram without one, a Page not
//     connected is skipped like any platform left unconnected, and no banner or email asks for it while the account
//     posts anywhere else.
//   - once a platform is connected, the runner gives each held post the account's next free slot, in order, and it is
//     approved again: it goes out at that slot like any other post (releaseHeld below).
//
// Only a real send can be held: in dry mode (PUBLISH_MODE not live) or without a Zernio key nothing goes to Zernio, and
// a post is written to disk as before.

export const PLATFORM_HE = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
/** What to ask for, by name: an optional platform only when it is the one to ask for. */
const asked = (platforms) => (platforms.some((p) => !OPTIONAL_PLATFORMS.includes(p)) ? platforms.filter((p) => !OPTIONAL_PLATFORMS.includes(p)) : platforms);
const both = (platforms) => asked(platforms).map((p) => PLATFORM_HE[p] || p).join(' ואת ');

/** Would this platform's part go through Zernio, the pack asking for it (auto: Instagram without our own Meta app)? */
function viaZernio(db, pack, platform, env) {
  const want = wantedPublisher(pack, platform);
  return want === 'zernio' || (want === 'auto' && platform === 'instagram' && !instagramConfigured(db, pack, env));
}

/** The platforms of the account with nothing connected that a post would need: what the banner and the email ask for. */
export function unconnectedPlatforms(db, pack, env = process.env) {
  if (!zernioConfigured()) return [];
  return pack.meta.platforms.filter((p) => viaZernio(db, pack, p, env) && !zernioAccountId(db, pack, p));
}

/**
 * What the banner and the email ask the customer to connect: the platforms with nothing connected, less a Facebook Page
 * while the account has another platform to post to.
 */
export function missingConnections(db, pack, env = process.env) {
  const open = unconnectedPlatforms(db, pack, env);
  return pack.meta.platforms.some((p) => !OPTIONAL_PLATFORMS.includes(p)) ? open.filter((p) => !OPTIONAL_PLATFORMS.includes(p)) : open;
}

/** At the slot: is there nothing to send this platform's part to? Live sends only. */
export const needsConnection = (db, pack, platform, env = process.env) => env.PUBLISH_MODE === 'live' && unconnectedPlatforms(db, pack, env).includes(platform);

/** The reason a held post shows. */
export const heldReason = (platforms) => `מחכה שתחברו את ${both(platforms)}. אחרי החיבור המצגת תעלה בשעה הפנויה הבאה.`;

/** The banner's line, for one account's missing platforms. */
export const connectLine = (platforms) => `כדי שהמצגות יעלו, מחברים את ${both(platforms)}`;

/** How many free slots ahead a held post may be given. */
const LOOK_DAYS = 14;

/** The account's next free slots after `t`, up to `n`, earliest first: none another live post holds. */
function freeSlots(db, pack, n, t) {
  const taken = new Set(db.all("SELECT slot_at FROM posts WHERE account_id = ? AND slot_at IS NOT NULL AND status IN ('queued', 'approved', 'publishing')", pack.id).map((r) => r.slot_at));
  const free = [];
  const today = israelDate(t);
  // The account's own schedule: the days and times its owner chose, and Shabbat and the festivals as they chose.
  const sched = scheduleOf(db, pack);
  for (let i = 0; i < LOOK_DAYS && free.length < n; i++) {
    for (const s of slotsFor(addDays(today, i), sched, { notBefore: t + 5 * 60_000 }).slots) {
      const iso = s.toISOString();
      if (!taken.has(iso) && !free.includes(iso)) free.push(iso);
    }
  }
  return free.sort().slice(0, n);
}

/**
 * The runner's pass for one account: a platform is connected now, so every held post is approved again with the
 * account's next free slot (the earliest held first). With no slot in the next two weeks (no schedule), it goes out at
 * the next tick inside the account's windows. Returns the posts released.
 */
export function releaseHeld(db, pack, { t = now(), env = process.env } = {}) {
  const held = db.all("SELECT id, slot_at FROM posts WHERE account_id = ? AND status = 'held' ORDER BY slot_at IS NULL, slot_at, created_at", pack.id);
  if (!held.length) return [];
  const missing = new Set(unconnectedPlatforms(db, pack, env));
  if (pack.meta.platforms.every((p) => missing.has(p))) return [];
  const free = freeSlots(db, pack, held.length, t);
  const out = held.map((p, i) => {
    const slot = free[i] || null;
    db.update('posts', p.id, { status: 'approved', slot_at: slot, reason: null, updated_at: nowIso() });
    return { post: p.id, slotAt: slot };
  });
  audit(db, { action: 'held_released', accountId: pack.id, detail: { posts: out } });
  return out;
}

// An approved post whose slot passed while the account could not run (a pause, the kill switch, a month not paid for)
// used to go out the moment it could, one a minute, however old: posts about "tonight" went out days later, back to
// back. Now it takes the way a held post takes: the account's next free slot. Lateness counts from the slot, or from
// the approval when a person approved it after its slot (they chose to send it late, and it goes at once as before).

/** An approved post this late is given a new slot instead of going out at once. */
export const OVERDUE_MS = 2 * HOUR;
/** An approved post this late is not sent at all: it expires. */
export const OVERDUE_EXPIRE_MS = 24 * HOUR;
export const OVERDUE_REASON = 'השעה של המצגת עברה לפני יותר מיום, בזמן שהחשבון היה עצור, ולכן היא לא עלתה.';

/** The runner's pass for one account that can run: overdue approved posts re-slotted, or expired. Returns what it did. */
export function reslotOverdue(db, pack, { t = now() } = {}) {
  const rows = db.all("SELECT id, slot_at, approved_at FROM posts WHERE account_id = ? AND status = 'approved' AND slot_at IS NOT NULL AND slot_at < ? ORDER BY slot_at", pack.id, new Date(t - OVERDUE_MS).toISOString());
  const late = rows.map((r) => ({ ...r, since: Math.max(Date.parse(r.slot_at), Date.parse(r.approved_at || r.slot_at) || 0) })).filter((r) => t - r.since > OVERDUE_MS);
  if (!late.length) return [];
  const out = [];
  const keep = late.filter((r) => t - r.since <= OVERDUE_EXPIRE_MS);
  for (const r of late.filter((x) => t - x.since > OVERDUE_EXPIRE_MS)) {
    // A TikTok draft already in the app stays there: the owner is asked to delete it, as with a cancelled approval.
    const left = retireDraft(db, loadPost(db, r.id));
    db.update('posts', r.id, { status: 'expired', reason: OVERDUE_REASON, updated_at: nowIso() });
    step(db, r.id, 'publish', 'info', { overdue: true, slotAt: r.slot_at, draftLeft: left });
    out.push({ post: r.id, expired: true });
  }
  const free = freeSlots(db, pack, keep.length, t);
  keep.forEach((r, i) => {
    const slot = free[i] || null;
    db.update('posts', r.id, { slot_at: slot, updated_at: nowIso() });
    step(db, r.id, 'publish', 'info', { overdue: true, from: r.slot_at, to: slot });
    out.push({ post: r.id, slotAt: slot });
  });
  audit(db, { action: 'overdue_reslotted', accountId: pack.id, detail: { posts: out } });
  return out;
}
