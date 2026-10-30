import { now, nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { usage } from '../budget/quota.js';
import { loadPost } from '../pipeline/build.js';
import { captionOf, tiktokMode } from '../publish/index.js';
import { imageCredit } from '../images/index.js';
import { oneLine } from '../rules/overlay.js';
import { mediaLink } from './sign.js';
import { connectLink, connectState } from '../publish/connect.js';
import { zernioConfigured } from '../publish/zernio.js';
import { mediaOf } from '../core/platforms.js';

// What the WhatsApp assistant reads (docs/assistant-api.md), in the shapes it gets them. Every function here takes a
// workspace's context (src/web/workspace.js) or rows already checked against one; nothing here decides who may see
// what.

/** Every event Teder sends the assistant, in the order the settings list them. */
export const EVENT_TYPES = ['post.ready', 'post.reminder', 'post.published', 'post.unposted', 'quota.low', 'weekly.summary', 'account.reconnect'];

/* ------------------------------------------------------------------ the customer's choices */

/** A workspace's choices: { events: { type: on }, quiet: { nights, shabbat } }. No row is every event, quiet at night and on Shabbat. */
export function prefsOf(db, workspaceId) {
  const row = db.get('SELECT * FROM assistant_prefs WHERE workspace_id = ?', workspaceId);
  const saved = j(row?.events_json, {});
  return {
    events: Object.fromEntries(EVENT_TYPES.map((k) => [k, saved[k] !== false])),
    quiet: { nights: row ? Boolean(row.quiet_nights) : true, shabbat: row ? Boolean(row.quiet_shabbat) : true },
  };
}

/**
 * Change some of a workspace's choices: { events: { type: bool }, quiet: { nights: bool, shabbat: bool } }, each part
 * optional. Returns { problems } for a type or a value that is not one, else the choices as saved.
 */
export function setPrefs(db, workspaceId, patch, { by = null } = {}) {
  const problems = [];
  const cur = prefsOf(db, workspaceId);
  const events = { ...cur.events };
  for (const [k, v] of Object.entries(patch?.events || {})) {
    if (!EVENT_TYPES.includes(k)) problems.push(`no event ${k}`);
    else if (typeof v !== 'boolean') problems.push(`${k}: true or false`);
    else events[k] = v;
  }
  const quiet = { ...cur.quiet };
  for (const [k, v] of Object.entries(patch?.quiet || {})) {
    if (!['nights', 'shabbat'].includes(k)) problems.push(`no quiet setting ${k}`);
    else if (typeof v !== 'boolean') problems.push(`quiet.${k}: true or false`);
    else quiet[k] = v;
  }
  if (problems.length) return { problems };
  db.run(
    `INSERT INTO assistant_prefs (workspace_id, events_json, quiet_nights, quiet_shabbat, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET events_json = excluded.events_json, quiet_nights = excluded.quiet_nights, quiet_shabbat = excluded.quiet_shabbat, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    workspaceId,
    JSON.stringify(events),
    quiet.nights ? 1 : 0,
    quiet.shabbat ? 1 : 0,
    nowIso(),
    by
  );
  return prefsOf(db, workspaceId);
}

/* ------------------------------------------------------------------ posts */

/** The platform whose slides the assistant shows: TikTok's when the post has them. */
export const shownPlatform = (post) => (post.media?.tiktok?.length ? 'tiktok' : 'instagram');

export const accountOf = (pack) => ({ id: pack.id, name: pack.meta.displayName, handle: pack.meta.handle });

/**
 * Each of the account's platforms and its connection (src/publish/connect.js): { platform, state, username, issue,
 * url }. state is connected, reconnect, none, or meta (Instagram through our own Meta app). url is the link to send the
 * customer ("tap here to connect"), signed for 72 hours, where there is something to connect and Zernio is set up;
 * null otherwise, and always without `link`.
 */
export function connectionsOf(db, pack, link = null) {
  return pack.meta.platforms.map((platform) => {
    const s = connectState(db, pack, platform);
    const open = Boolean(link) && zernioConfigured() && (s.state === 'none' || s.state === 'reconnect');
    return { ...s, url: open ? connectLink(link.secret, { base: link.base, accountId: pack.id, platform, t: link.t }) : null };
  });
}

/** Signed links to a platform's slides. `link` is { secret, base, t }. */
export const slideLinks = (post, platform, link) => (post.media?.[platform] || []).map((_, idx) => mediaLink(link.secret, { base: link.base, postId: post.id, platform, idx, t: link.t }));
// A Facebook Page's part is sent Instagram's slides (src/core/platforms.js): its links are to those.

/** A post as the assistant shows it: the cover line, the slot, every slide with its text and a link to its image, the caption. */
export function postView(post, pack, link) {
  const platform = shownPlatform(post);
  const images = slideLinks(post, platform, link);
  return {
    id: post.id,
    account: accountOf(pack),
    status: post.status,
    coverLine: oneLine(post.hook || ''),
    slotAt: post.slot_at || null,
    caption: post.caption || '',
    slides: post.slides.map((s, i) => ({ n: i + 1, kind: s.kind, title: s.title || '', body: s.body || '', image: images[i] || null })),
  };
}

/** A platform's part of a post that a publisher really put out. A dry publish only wrote it to disk: nothing is out. */
const done = (r) => Boolean(r && !r.error && !r.flow && r.via !== 'dry' && (r.status === 'published' || r.zernioId || r.mediaId));

/**
 * Where each of the post's platforms stands, in one word: out, drafts (a TikTok draft waits in the app), by_hand (it
 * waits for the customer to post it themselves: a draft that never reached TikTok, a dry publish), failed, or waiting
 * (not sent anywhere yet).
 */
export function platformStates(post, pack) {
  const out = {};
  for (const platform of pack.meta.platforms) {
    const r = post.publish?.[platform];
    const flow = r?.flow;
    if (flow) out[platform] = ['mine', 'fallback', 'duplicate'].includes(flow.state) ? 'out' : flow.state === 'failed' || flow.state === 'stopped' ? 'failed' : r.via === 'zernio' ? 'drafts' : 'by_hand';
    else if (r?.via === 'dry' && !r.error) out[platform] = 'by_hand';
    else if (done(r)) out[platform] = 'out';
    else if (r?.error) out[platform] = 'failed';
    else out[platform] = 'waiting';
  }
  return out;
}

/** Is the post out where it matters: on TikTok when it goes to TikTok, else on every platform it goes to. */
export function isOut(post, pack) {
  const s = platformStates(post, pack);
  return 'tiktok' in s ? s.tiktok === 'out' : Object.values(s).every((v) => v === 'out');
}

/** How the customer posts this one now: from TikTok's drafts, or by hand from the bundle. */
export function delivery(post, pack, db = null) {
  const s = platformStates(post, pack);
  return s.tiktok === 'drafts' && tiktokMode(pack, db) !== 'direct' ? 'drafts' : 'by_hand';
}

/** Everything a customer who posts by hand needs, per platform: the slides, the caption, the hashtags, and all of it as it goes out. */
export function bundleOf(db, post, pack, link) {
  const credit = imageCredit(db, post);
  const platforms = {};
  for (const platform of pack.meta.platforms) {
    if (!post.media?.[mediaOf(platform)]?.length) continue;
    const caption = [(platform === 'instagram' || platform === 'facebook') && post.caption_ig ? post.caption_ig : post.caption, credit].filter(Boolean).join('\n\n');
    platforms[platform] = { images: slideLinks(post, mediaOf(platform), link), caption, hashtags: post.hashtags || [], text: captionOf(db, post, platform) };
  }
  return { id: post.id, account: accountOf(pack), status: post.status, coverLine: oneLine(post.hook || ''), slotAt: post.slot_at || null, aiLabel: Boolean(post.ai_label), platforms };
}

/* ------------------------------------------------------------------ numbers */

/**
 * The posts published between two instants: how many, their views (each platform's newest reading, added), and the
 * one with the most.
 */
export function numbers(db, accountId, from, to) {
  const rows = db.all(
    `SELECT p.id, p.hook, p.published_at, COALESCE(SUM(m.views), 0) AS views, COUNT(m.id) AS readings
     FROM posts p LEFT JOIN metrics m ON m.post_id = p.id AND m.id IN (SELECT MAX(id) FROM metrics GROUP BY post_id, platform)
     WHERE p.account_id = ? AND p.status = 'published' AND p.published_at >= ? AND p.published_at < ? GROUP BY p.id`,
    accountId,
    new Date(from).toISOString(),
    new Date(to).toISOString()
  );
  const read = rows.filter((r) => r.readings);
  const best = read.reduce((b, r) => (!b || r.views > b.views ? r : b), null);
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    published: rows.length,
    views: read.length ? read.reduce((s, r) => s + r.views, 0) : null,
    best: best ? { id: best.id, coverLine: oneLine(best.hook || ''), views: best.views, publishedAt: best.published_at } : null,
  };
}

const part = (p) => ({ used: p.used, held: p.held, limit: p.limit, left: p.left });

/** One account's month: suggestions and redos used of the plan, and what is held by drafts in progress. */
export function quotaOf(db, accountId, t = now()) {
  const u = usage(db, accountId, t);
  return { month: u.month, suggestions: part(u.suggested), redos: part(u.redos) };
}

/** One account as the status answers it: its month, the next posts, and the last seven days. */
export function accountStatus(db, pack, t = now()) {
  const next = db
    .all("SELECT id FROM posts WHERE account_id = ? AND sample = 0 AND status IN ('queued', 'approved') AND slot_at >= ? ORDER BY slot_at LIMIT 5", pack.id, new Date(t).toISOString())
    .map((r) => loadPost(db, r.id))
    .map((p) => ({ id: p.id, coverLine: oneLine(p.hook || ''), slotAt: p.slot_at, status: p.status }));
  return { account: accountOf(pack), quota: quotaOf(db, pack.id, t), next, week: numbers(db, pack.id, t - 7 * 86_400_000, t), connections: connectionsOf(db, pack) };
}
