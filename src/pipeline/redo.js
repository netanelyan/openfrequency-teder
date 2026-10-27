import { now, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { buildPost, PausedError } from './build.js';
import { docKeyOf } from '../metrics/feedback.js';
import { notify } from '../notify/index.js';
import { REDO_REASON_HE } from '../budget/quota.js';

// A rejected post, written again with the customer's reason (src/budget/quota.js counts it as a redo, never as a
// suggestion). What the reason changes:
//
//   topic     another topic: the rejected post's documents and topic count as used, as any post's do
//   shorter   the same document and format, told shorter
//   tone      the same document and format, in another tone and under another cover pattern
//   photo     the same document and format, and none of the rejected post's photographs
//   other     the same document and format, with the customer's own words for the writer
//
// The replacement takes the rejected post's slot while that is still ahead, and waits without one otherwise. A
// replacement our checks block is our retry, not their redo: it is tried once more, and if that is blocked too the
// customer is told and nothing is counted. The rails act on it as on any post (a failed fact check blocks it and is
// tried again).

/** Attempts at a replacement before the customer is told it could not be written. */
export const REDO_ATTEMPTS = 2;
/** A slot this close is not kept: the replacement waits for the customer without one. */
const SLOT_LEAD_MS = 30 * 60_000;

/** The photographs a post was drawn with, as `${provider}:${provider_id}`, for findImage to skip. */
export function photosOf(db, post) {
  const ids = new Set([...(post.checks?.images || []), post.checks?.image, post.checks?.bgImage, ...(post.checks?.sceneImages || []), ...(post.checks?.coverImages || []), ...(post.slides || []).map((s) => s.image_id)].filter(Boolean));
  return [...ids].map((id) => db.get('SELECT provider, provider_id FROM images WHERE id = ?', id)).filter(Boolean).map((i) => `${i.provider}:${i.provider_id}`);
}

/** The directive buildPost takes for a redo (the same shape the morning's feedback plans with). */
export function redoDirective(db, post, { reason, note = '' }) {
  const steer = { kind: 'redo', reason, note, hook: post.hook, topic: post.topic };
  const docKey = reason === 'topic' ? null : docKeyOf(db, post.id);
  if (!docKey) return { steer };
  return {
    formatKey: post.format_id,
    docKey,
    reuseDocs: true,
    steer,
    ...(reason === 'tone' && post.hook_pattern ? { avoidHook: post.hook_pattern } : {}),
    ...(reason === 'photo' ? { avoidImages: photosOf(db, post) } : {}),
  };
}

/** What became of the redo, kept on the rejected post. */
function note(db, postId, patch) {
  const row = db.get('SELECT reject_json FROM posts WHERE id = ?', postId);
  db.update('posts', postId, { reject_json: { ...j(row?.reject_json, {}), ...patch } });
}

/**
 * Write the replacement for a rejected post. The first drafting row (which holds the redo in the quota) is inserted
 * before this returns its promise, so a second rejection a moment later already sees it. Resolves to
 * { ok, postId, status, why }.
 */
export async function redoPost(ctx, post, { reason, note: said = '' }) {
  const { db } = ctx;
  const pack = ctx.pack(post.account_id);
  const directive = redoDirective(db, post, { reason, note: said });
  const slotAt = post.slot_at && Date.parse(post.slot_at) > now() + SLOT_LEAD_MS ? post.slot_at : null;
  const tried = [];
  let why = null;
  for (let attempt = 0; attempt < REDO_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await buildPost(ctx, { pack, slotAt, directive, redoOf: post.id });
    } catch (e) {
      // Paused, killed, or the redos used up since the rejection: nothing was drafted and nothing is counted.
      if (!(e instanceof PausedError)) ctx.log?.(`redo ${post.id}: ${e.stack || e.message}`);
      why = e.message;
      break;
    }
    tried.push(res.postId);
    db.update('posts', res.postId, { mode_at_queue: db.get('SELECT mode FROM accounts WHERE id = ?', pack.id)?.mode });
    if (res.status === 'queued') {
      note(db, post.id, { redo: 'queued', replacement: res.postId, tried });
      audit(db, { action: 'redo', accountId: pack.id, postId: res.postId, detail: { of: post.id, reason, attempts: attempt + 1 } });
      await notify(ctx, { accountId: pack.id, postId: res.postId, kind: 'redo', title: 'הפוסט החלופי מחכה לאישור', body: `במקום "${String(post.hook || post.topic || '').slice(0, 80)}", ${REDO_REASON_HE[reason] || REDO_REASON_HE.other}.`, url: `/post/${res.postId}` }).catch((e) => ctx.log?.(`notify: ${e.message}`));
      return { ok: true, postId: res.postId, status: res.status, why: null };
    }
    why = res.reason;
  }
  note(db, post.id, { redo: 'failed', why: String(why || '').slice(0, 300), tried, at: nowIso() });
  audit(db, { action: 'redo_failed', accountId: pack.id, postId: post.id, detail: { reason, why, tried } });
  const body = tried.length ? 'הבדיקות שלנו עצרו את מה שנכתב במקומו, ולכן ההחלפה לא ירדה מהמכסה.' : 'הכתיבה בחשבון עצורה כרגע, ולכן לא נכתב פוסט במקומו וההחלפה לא ירדה מהמכסה.';
  await notify(ctx, { accountId: pack.id, postId: post.id, kind: 'redo_failed', title: 'הפוסט החלופי לא נכתב', body, url: `/post/${post.id}` }).catch((e) => ctx.log?.(`notify: ${e.message}`));
  return { ok: false, postId: tried.at(-1) || null, status: 'blocked', why };
}
