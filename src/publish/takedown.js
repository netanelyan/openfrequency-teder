import { DAY, now, nowIso } from '../core/clock.js';
import { audit, step } from '../core/store.js';
import { j } from '../db/index.js';
import { pauseAccount } from '../autonomy/rails.js';
import { loadPost } from '../pipeline/build.js';
import { deleteMedia, igConfig } from './instagram.js';
import { unpublishFacebook } from './zernio.js';

// Takedown notices. A notice is recorded on the website; the post it names is
// taken down at once:
//
//   - Instagram, through Facebook Login: deleted through the Graph API (DELETE
//     /{media-id}, the instagram_manage_contents permission). If Meta refuses,
//     or the account uses Instagram Login, it is listed to delete by hand.
//   - a Facebook Page's post (through Zernio): taken down through Zernio's
//     unpublish (POST /v1/posts/{id}/unpublish, platform facebook). If Zernio
//     refuses, it is listed to delete by hand.
//   - TikTok: listed to delete by hand. Neither Zernio nor any official TikTok API
//     deletes a published post (Zernio's own delete only removes its record).
//   - a post that never left (dry, not published): nothing to delete.
//
// The website shows every notice and every deletion still waiting for a hand,
// until the owner confirms it. A second notice for the same account within 90
// days pauses it: two notices are a pattern, and the account stays paused until
// the owner resumes it.

export const PAUSE_AFTER = 2;
export const WINDOW_DAYS = 90;

/** Where each platform of a post stands after a notice: deleted | by_hand | not_published | failed. */
async function takeDown(ctx, pack, post, only = null) {
  const out = {};
  for (const [platform, r] of Object.entries(post.publish || {})) {
    if (platform.startsWith('_') || (only && platform !== only)) continue;
    if (!r || r.via === 'dry' || r.error || !(r.mediaId || r.zernioId || r.status === 'published')) {
      out[platform] = { state: 'not_published' };
      continue;
    }
    if (platform === 'instagram' && r.via === 'instagram' && r.mediaId && igConfig(pack).auth === 'facebook') {
      try {
        await (ctx.deleteInstagram || deleteMedia)(ctx.db, pack, r.mediaId);
        out[platform] = { state: 'deleted', at: nowIso() };
      } catch (e) {
        out[platform] = { state: 'by_hand', why: `Meta did not delete it: ${String(e.message).slice(0, 200)}`, url: r.permalink || null };
      }
      continue;
    }
    if (platform === 'facebook' && r.via === 'zernio' && r.zernioId) {
      try {
        await (ctx.unpublishFacebook || unpublishFacebook)(r.zernioId);
        out[platform] = { state: 'deleted', at: nowIso() };
      } catch (e) {
        out[platform] = { state: 'by_hand', why: `Zernio did not take it down: ${String(e.message).slice(0, 200)}`, url: r.url || null };
      }
      continue;
    }
    out[platform] = {
      state: 'by_hand',
      why: platform === 'tiktok' ? 'TikTok has no delete for a published post through any official API: delete it in the TikTok app' : platform === 'facebook' ? 'delete it on the Facebook Page' : 'delete it in the Instagram app (Instagram Login has no delete through the API)',
      url: r.url || r.permalink || null,
    };
  }
  return out;
}

/**
 * Record a notice, take the post down, and pause the account on the second
 * notice in 90 days. Returns { id, deleted, paused }.
 */
export async function recordTakedown(ctx, { postId, platform = null, claimant = '', notice, receivedAt = null, by = 'owner', t = now() }) {
  const { db } = ctx;
  const post = loadPost(db, postId);
  if (!post) throw new Error(`no post ${postId}`);
  if (!String(notice || '').trim()) throw new Error('the notice text is required');
  const pack = ctx.pack(post.account_id);
  const deleted = await takeDown(ctx, pack, post, platform);
  const at = receivedAt || new Date(t).toISOString();
  const id = db.insert('takedowns', {
    post_id: postId, account_id: post.account_id, platform, claimant: String(claimant).slice(0, 200), notice: String(notice).slice(0, 4000),
    received_at: at, recorded_by: by, deleted_json: deleted, created_at: nowIso(),
  });
  db.update('posts', postId, { status: 'taken_down', reason: `הודעת הסרה${claimant ? ` מ-${claimant}` : ''}: ${String(notice).slice(0, 160)}`, updated_at: nowIso() });
  step(db, postId, 'takedown', 'info', { takedown: id, platform, deleted });
  audit(db, { actor: by, action: 'takedown', accountId: post.account_id, postId, detail: { id, platform, deleted } });
  const since = new Date(t - WINDOW_DAYS * DAY).toISOString();
  const n = db.get('SELECT COUNT(*) AS n FROM takedowns WHERE account_id = ? AND received_at >= ?', post.account_id, since).n;
  let paused = false;
  if (n >= PAUSE_AFTER) {
    pauseAccount(db, post.account_id, 'takedowns', `${n} הודעות הסרה ב-${WINDOW_DAYS} ימים: החשבון עוצר עד שתבדקו`, by);
    paused = true;
  }
  return { id, deleted, paused, count: n };
}

/** The owner deleted it by hand: mark that platform done. */
export function confirmDeleted(db, { id, platform, by = 'owner' }) {
  const row = db.get('SELECT * FROM takedowns WHERE id = ?', id);
  if (!row) throw new Error(`no takedown ${id}`);
  const d = j(row.deleted_json, {});
  if (!d[platform] || d[platform].state !== 'by_hand') throw new Error(`nothing to confirm on ${platform}`);
  d[platform] = { ...d[platform], state: 'deleted_by_hand', at: nowIso(), by };
  db.update('takedowns', id, { deleted_json: d });
  audit(db, { actor: by, action: 'takedown_deleted', accountId: row.account_id, postId: row.post_id, detail: { id, platform } });
  return d;
}

/** Every notice, newest first, with what is still waiting for a hand. */
export function takedowns(db, { accountId = null, limit = 50 } = {}) {
  return db
    .all(`SELECT t.*, p.hook, p.account_id AS acc FROM takedowns t LEFT JOIN posts p ON p.id = t.post_id ${accountId ? 'WHERE t.account_id = ?' : ''} ORDER BY t.received_at DESC LIMIT ?`, ...(accountId ? [accountId, limit] : [limit]))
    .map((r) => {
      const deleted = j(r.deleted_json, {});
      return { ...r, deleted, waiting: Object.entries(deleted).filter(([, v]) => v.state === 'by_hand').map(([p, v]) => ({ platform: p, ...v })) };
    });
}
