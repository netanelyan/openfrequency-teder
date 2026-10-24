import { nowIso } from '../core/clock.js';
import { audit, settings } from '../core/store.js';

// The safety rails, in every mode:
//   - a kill switch per account and a global one
//   - auto-pause on a platform strike, a streak of publish errors, or repeated
//     takedown notices. A failed fact check blocks its post and nothing else: the
//     account goes on
// A paused account says why, on the website, and stays paused until the owner
// resumes it. Money pauses nothing: there is no cap, and the month's plan (40
// slideshows, 10 redos) stops the drafting without pausing (src/budget/quota.js).

export const PAUSE_REASONS = {
  kill: 'מתג הכיבוי הופעל',
  manual: 'הושהה ידנית',
  fact_check: 'בדיקת עובדות נכשלה', // no longer set; an account paused for it before still says so
  strike: 'הפלטפורמה דחתה פוסט כהפרת מדיניות',
  publish_errors: 'רצף שגיאות פרסום',
  takedowns: 'הודעות הסרה חוזרות',
};

export function pauseAccount(db, accountId, reason, detail = null, actor = 'engine') {
  const acc = db.get('SELECT status, paused_reason FROM accounts WHERE id = ?', accountId);
  if (!acc) return;
  // A kill switch outranks any automatic reason; never overwrite it.
  if (acc.status === 'paused' && acc.paused_reason === 'kill' && reason !== 'kill') return;
  db.update('accounts', accountId, { status: 'paused', paused_reason: reason, paused_detail: detail ? String(detail).slice(0, 500) : null, paused_at: nowIso(), updated_at: nowIso() });
  audit(db, { actor, action: 'pause', accountId, detail: { reason, detail } });
}

export function resumeAccount(db, accountId, actor = 'engine') {
  db.update('accounts', accountId, { status: 'active', paused_reason: null, paused_detail: null, paused_at: null, updated_at: nowIso() });
  audit(db, { actor, action: 'resume', accountId });
}

/** Can this account publish or generate right now? { ok, why } */
export function canRun(db, accountId) {
  if (settings(db).globalKill) return { ok: false, why: 'מתג הכיבוי הכללי מופעל' };
  const acc = db.get('SELECT status, paused_reason FROM accounts WHERE id = ?', accountId);
  if (!acc) return { ok: false, why: 'אין חשבון כזה' };
  if (acc.status !== 'active') return { ok: false, why: PAUSE_REASONS[acc.paused_reason] || acc.status };
  return { ok: true, why: null };
}

/** Consecutive failed publishes, newest first, until the last success. */
export function publishErrorStreak(db, accountId) {
  const rows = db.all("SELECT status FROM posts WHERE account_id = ? AND status IN ('published','failed') ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 20", accountId);
  let n = 0;
  for (const r of rows) {
    if (r.status !== 'failed') break;
    n++;
  }
  return n;
}
