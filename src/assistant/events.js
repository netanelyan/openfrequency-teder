import { HOUR, now } from '../core/clock.js';
import { j } from '../db/index.js';
import { localFetch } from '../core/net.js';
import { usage } from '../budget/quota.js';
import { loadPost } from '../pipeline/build.js';
import { addDays, israelDate, israelHour, israelInstant, weekday } from '../schedule/israel.js';
import { restWindow } from '../schedule/shabbat.js';
import { oneLine } from '../rules/overlay.js';
import { assistantSecret, DIR, linkBase, signature } from './sign.js';
import { accountOf, connectionsOf, delivery, isOut, numbers, platformStates, postView, prefsOf, quotaOf } from './data.js';
import { CONNECT_LINK_TTL_S } from '../publish/connect.js';

// What Teder tells the WhatsApp assistant (openfrequency-toran), which tells the customer (docs/assistant-api.md):
//
//   post.ready       a post reached the customer and waits for their decision (a redo's replacement too)
//   post.reminder    the slot came: the post waits in their TikTok drafts, or is ready to post by hand
//   post.published   it is out: on TikTok when it goes there (the customer's own post found, or the fallback's)
//   post.unposted    an hour after the slot it is still not out
//   quota.low        QUOTA_LOW suggested slideshows left this month
//   weekly.summary   Sunday at 09:00 Israel time: the week's posts, views and best post, per account
//   account.reconnect  Zernio says the TikTok or Instagram the customer connected stopped working (an expired or
//                    revoked token, a missing permission): with a link to connect it again, once per break
//
// Every event is found from the database at each tick, never raised from inside the pipeline, so nothing that
// writes a post has to remember to tell anyone, and an event missed while the server was down is found when it comes
// back (within the event's own lookback). Each has a key and is written once (assistant_events.key is unique).
//
// An event is kept, then sent: when the customer's quiet hours allow (no messages from 22:00 to 08:00, nor on Shabbat
// and the festivals, each the customer's choice), signed (src/assistant/sign.js), to the assistant on this machine.
// What it says is read when it is sent, not when it was found: the slide links are fresh, and an event that is no
// longer true by then (a post approved on the website before its post.ready went out, a reminder for a post since
// published) is dropped as stale. A type the customer turned off is kept as "off" and never sent, also if they turn
// it on later. A send that fails is tried again, later each time; an event past its use expires.
//
// Only accounts in a workspace have a customer to tell. Nothing is found or sent while OF_ASSISTANT_SECRET is unset.

/** Suggested slideshows left in the month at which the customer is told. */
export const QUOTA_LOW = 8;
/** How long after the slot a post that is not out is "unposted". */
export const UNPOSTED_MIN = 60;
/** The weekly summary: Sunday (0), at this Israel hour. */
export const WEEKLY = { day: 0, at: '09:00' };
/** Quiet nights, Israel time: from this hour to that one. */
export const NIGHT = { from: 22, to: 8 };
/** How long each event is worth sending after it was found; past it, it expires. Quiet hours can hold one this long. */
export const KEEP_MS = {
  'post.ready': 48 * HOUR,
  'post.reminder': 3 * HOUR,
  'post.published': 24 * HOUR,
  'post.unposted': 14 * HOUR,
  'quota.low': 7 * 24 * HOUR,
  'weekly.summary': 3 * 24 * HOUR,
  'account.reconnect': 3 * 24 * HOUR,
};
/** Waits before each retry of a failed send; after the last one the event has failed. */
export const RETRY_MIN = [1, 5, 15, 60, 180];
/** Where the assistant listens, unless OF_TORAN_URL says otherwise. */
export const TORAN_URL = 'http://127.0.0.1:4710/internal/teder/events';

/** When the customer's quiet hours end, if they are on at `t`; null when a message may go now. */
export function quietUntil(t, quiet) {
  let at = t;
  for (let i = 0; i < 8; i++) {
    let moved = false;
    if (quiet.nights) {
      const h = israelHour(at);
      if (h >= NIGHT.from || h < NIGHT.to) {
        const day = israelDate(at);
        at = israelInstant(h >= NIGHT.from ? addDays(day, 1) : day, `${String(NIGHT.to).padStart(2, '0')}:00`).getTime();
        moved = true;
      }
    }
    if (quiet.shabbat) {
      const w = restWindow(at);
      if (w) {
        at = w.to.getTime();
        moved = true;
      }
    }
    if (!moved) break;
  }
  return at > t ? at : null;
}

/** Keep one event, once. A type the customer turned off is kept as "off". Returns whether it was new. */
function enqueue(db, { key, type, workspaceId, accountId = null, postId = null, data = null, t }) {
  const on = prefsOf(db, workspaceId).events[type];
  const at = new Date(t).toISOString();
  return (
    db.run(
      'INSERT OR IGNORE INTO assistant_events (key, type, workspace_id, account_id, post_id, data_json, state, not_before, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      key,
      type,
      workspaceId,
      accountId,
      postId,
      data ? JSON.stringify(data) : null,
      on ? 'pending' : 'off',
      at,
      new Date(t + KEEP_MS[type]).toISOString(),
      at
    ).changes > 0
  );
}

/** The accounts there is a customer to tell: each with its workspace. */
function customersOf(ctx) {
  return ctx.packs
    .map((pack) => ({ pack, acc: ctx.db.get('SELECT workspace_id, status FROM accounts WHERE id = ?', pack.id) }))
    .filter(({ acc }) => acc && acc.workspace_id != null && acc.status !== 'onboarding')
    .map(({ pack, acc }) => ({ pack, workspaceId: acc.workspace_id }));
}

/** Find what happened since the last tick and keep it. Returns the events kept, by type. */
export function detect(ctx, { t = now() } = {}) {
  const { db } = ctx;
  const iso = (ms) => new Date(ms).toISOString();
  const found = {};
  const keep = (e) => {
    if (enqueue(db, { ...e, t })) found[e.type] = (found[e.type] || 0) + 1;
  };
  const posts = (sql, ...a) => db.all(sql, ...a).map((r) => loadPost(db, r.id));
  const live = "sample = 0 AND status IN ('approved', 'publishing', 'published')";
  for (const { pack, workspaceId } of customersOf(ctx)) {
    const base = { workspaceId, accountId: pack.id };
    for (const p of posts("SELECT id FROM posts WHERE account_id = ? AND status = 'queued' AND sample = 0 AND created_at >= ?", pack.id, iso(t - KEEP_MS['post.ready']))) {
      keep({ ...base, type: 'post.ready', key: `post.ready:${p.id}`, postId: p.id });
    }
    // At the slot, a post that is not out yet: its reminder. An hour on, still not out: unposted.
    for (const p of posts(`SELECT id FROM posts WHERE account_id = ? AND ${live} AND slot_at IS NOT NULL AND slot_at <= ? AND slot_at >= ?`, pack.id, iso(t), iso(t - KEEP_MS['post.unposted']))) {
      if (isOut(p, pack)) continue;
      const slot = Date.parse(p.slot_at);
      if (t - slot < KEEP_MS['post.reminder']) keep({ ...base, type: 'post.reminder', key: `post.reminder:${p.id}`, postId: p.id });
      if (t - slot >= UNPOSTED_MIN * 60_000) keep({ ...base, type: 'post.unposted', key: `post.unposted:${p.id}`, postId: p.id });
    }
    for (const p of posts("SELECT id FROM posts WHERE account_id = ? AND sample = 0 AND status = 'published' AND published_at >= ?", pack.id, iso(t - KEEP_MS['post.published']))) {
      if (isOut(p, pack)) keep({ ...base, type: 'post.published', key: `post.published:${p.id}`, postId: p.id });
    }
    // A connection that broke (src/publish/connect.js records when): one message per break, with a fresh link at sending.
    for (const r of db.all("SELECT platform, broken_at FROM zernio_connections WHERE account_id = ? AND status = 'reconnect' AND broken_at IS NOT NULL", pack.id)) {
      keep({ ...base, type: 'account.reconnect', key: `account.reconnect:${pack.id}:${r.platform}:${r.broken_at}`, data: { platform: r.platform } });
    }
    const u = usage(db, pack.id, t);
    // A month the workspace's accounts share runs low for all of them at once: said once, not once per account.
    const whose = u.plan.scope === 'workspace' ? `ws${u.plan.workspaceId}` : pack.id;
    if (u.suggested.used > 0 && u.suggested.left <= QUOTA_LOW) keep({ ...base, type: 'quota.low', key: `quota.low:${whose}:${u.month}`, data: { month: u.month } });
  }
  // Sunday morning: one summary per customer, of the seven days before it.
  const today = israelDate(t);
  const at = israelInstant(today, WEEKLY.at).getTime();
  if (weekday(today) === WEEKLY.day && t >= at) {
    for (const workspaceId of new Set(customersOf(ctx).map((x) => x.workspaceId))) {
      keep({ type: 'weekly.summary', key: `weekly.summary:${workspaceId}:${today}`, workspaceId, data: { from: iso(at - 7 * 24 * HOUR), to: iso(at) } });
    }
  }
  return found;
}

const lite = (post, pack) => ({ id: post.id, account: accountOf(pack), coverLine: oneLine(post.hook || ''), slotAt: post.slot_at || null });

/** The sound a TikTok draft was sent with, for the customer to add in the app. */
const soundOf = (post) => {
  const s = post.publish?.tiktok?.flow?.sound;
  return s ? { name: s.name, artist: s.artist } : null;
};

/**
 * What one event says now, or null when it is no longer true (stale). `link` is { secret, base, t } for the slide
 * links. The engine's context: the event's row already names its workspace.
 */
export function payloadOf(ctx, row, link) {
  const { db } = ctx;
  const t = link.t;
  const data = j(row.data_json, {});
  const pack = row.account_id ? ctx.pack(row.account_id) : null;
  if (row.account_id && !pack) return null;
  const post = row.post_id ? loadPost(db, row.post_id) : null;
  if (row.post_id && !post) return null;
  const ready = post && ['approved', 'publishing', 'published'].includes(post.status);
  switch (row.type) {
    case 'post.ready':
      if (post.status !== 'queued') return null;
      return { post: postView(post, pack, link), redoOf: post.redo_of || null };
    case 'post.reminder':
      if (!ready || isOut(post, pack) || t - Date.parse(post.slot_at) >= UNPOSTED_MIN * 60_000) return null;
      return { post: lite(post, pack), delivery: delivery(post, pack), platforms: platformStates(post, pack), sound: soundOf(post) };
    case 'post.unposted':
      if (!ready || isOut(post, pack)) return null;
      return { post: lite(post, pack), delivery: delivery(post, pack), platforms: platformStates(post, pack), minutesLate: Math.round((t - Date.parse(post.slot_at)) / 60_000) };
    case 'post.published': {
      const flow = post.publish?.tiktok?.flow;
      return { post: lite(post, pack), platforms: platformStates(post, pack), tiktokUrl: flow?.externalUrl || flow?.fallback?.url || post.publish?.tiktok?.url || null };
    }
    case 'quota.low': {
      const q = quotaOf(db, pack.id, t);
      if (q.month !== data.month) return null;
      return { account: accountOf(pack), quota: q };
    }
    case 'weekly.summary': {
      const mine = customersOf(ctx).filter((x) => x.workspaceId === row.workspace_id);
      if (!mine.length) return null;
      const from = Date.parse(data.from);
      const to = Date.parse(data.to);
      return { from: data.from, to: data.to, accounts: mine.map(({ pack: p }) => ({ account: accountOf(p), week: numbers(db, p.id, from, to), quota: quotaOf(db, p.id, t) })) };
    }
    case 'account.reconnect': {
      const c = connectionsOf(db, pack, link).find((x) => x.platform === data.platform);
      if (!c || c.state !== 'reconnect' || !c.url) return null;
      return { account: accountOf(pack), platform: c.platform, username: c.username, issue: c.issue, connectUrl: c.url, linkExpiresAt: new Date(t + CONNECT_LINK_TTL_S * 1000).toISOString() };
    }
    default:
      return null;
  }
}

/** POST one signed event to the assistant. Returns { status }. */
async function post(url, { secret, body, type }) {
  const u = new URL(url);
  const res = await localFetch(u.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-of-event': type, 'x-of-signature': signature(secret, { dir: DIR.out, method: 'POST', path: u.pathname + u.search, body }) },
    body,
  });
  await res.arrayBuffer().catch(() => null);
  return { status: res.status };
}

/**
 * Send what is due. `send(url, { secret, body, type })` replaces the network for the tests. Stops at the first send
 * that fails: the assistant is down, and the rest wait with it. A 400 is the assistant refusing that one event, given up
 * at once while the rest go on. Returns { sent, held, stale, expired, off, failed }.
 */
export async function deliver(ctx, { t = now(), env = process.env, send = null, limit = 50 } = {}) {
  const { db } = ctx;
  const secret = assistantSecret(env);
  const out = { sent: 0, held: 0, stale: 0, expired: 0, off: 0, failed: 0 };
  if (!secret) return out;
  const url = String(env.OF_TORAN_URL || '').trim() || TORAN_URL;
  const iso = new Date(t).toISOString();
  const link = { secret, base: linkBase({ env }), t };
  const set = (id, patch) => db.update('assistant_events', id, patch);
  for (const row of db.all("SELECT * FROM assistant_events WHERE state = 'pending' AND not_before <= ? ORDER BY id LIMIT ?", iso, limit)) {
    if (row.expires_at <= iso) {
      set(row.id, { state: 'expired' });
      out.expired++;
      continue;
    }
    const prefs = prefsOf(db, row.workspace_id);
    if (!prefs.events[row.type]) {
      set(row.id, { state: 'off' });
      out.off++;
      continue;
    }
    const until = quietUntil(t, prefs.quiet);
    if (until) {
      set(row.id, { not_before: new Date(until).toISOString() });
      out.held++;
      continue;
    }
    const data = payloadOf(ctx, row, link);
    if (!data) {
      set(row.id, { state: 'stale' });
      out.stale++;
      continue;
    }
    const body = JSON.stringify({ id: `evt_${row.id}`, type: row.type, at: row.created_at, sentAt: iso, customer: row.workspace_id, data });
    let why = null;
    try {
      const r = await (send || post)(url, { secret, body, type: row.type });
      if (r.status >= 200 && r.status < 300) {
        set(row.id, { state: 'sent', sent_at: iso, attempts: row.attempts + 1, last_error: null });
        out.sent++;
        continue;
      }
      why = `HTTP ${r.status}`;
      // The assistant read this event and refused it (400: a type or a shape it does not take): sending it again changes
      // nothing, and it must not hold the rest of the queue. A signature it refused (401), a refusal of where it came
      // from (403), a timeout, a rate limit or a server error is the assistant's state, not the event's: those wait.
      if (r.status >= 400 && r.status < 500 && ![401, 403, 408, 429].includes(r.status)) {
        set(row.id, { state: 'failed', attempts: row.attempts + 1, last_error: why });
        out.failed++;
        ctx.log?.(`[assistant] ${row.type} ${row.id}: ${why}, refused for good`);
        continue;
      }
    } catch (e) {
      why = String(e.message).slice(0, 300);
    }
    const attempts = row.attempts + 1;
    const wait = RETRY_MIN[attempts - 1];
    set(row.id, wait == null ? { state: 'failed', attempts, last_error: why } : { attempts, last_error: why, not_before: new Date(t + wait * 60_000).toISOString() });
    out.failed++;
    ctx.log?.(`[assistant] ${row.type} ${row.id}: ${why}`);
    break;
  }
  return out;
}

/** The runner's pass (src/autonomy/runner.js): find, then send. Null while the assistant is not configured. */
export async function assistantTick(ctx, { t = now(), env = process.env, send = null } = {}) {
  if (!assistantSecret(env)) return null;
  const found = detect(ctx, { t });
  const sent = await deliver(ctx, { t, env, send });
  return { found, ...sent };
}
