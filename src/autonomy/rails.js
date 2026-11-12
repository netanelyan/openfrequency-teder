import { nowIso } from '../core/clock.js';
import { audit, settings } from '../core/store.js';
import { workspaceAllowed } from '../billing/entitlement.js';
import { accountAiPaused, AI_PAUSED, PAUSED_HE } from '../billing/ai-share.js';
import { customerWorkspace } from '../billing/own.js';

// The safety rails, in every mode:
//   - a kill switch per account and a global one
//   - auto-pause on a platform strike, a streak of publish errors, or repeated
//     takedown notices. A failed fact check blocks its post and nothing else: the
//     account goes on
// A paused account says why, on the website, and stays paused until the owner
// resumes it. An account of a customer's workspace that has not paid for Teder (src/billing/entitlement.js) is stopped the same
// way without being paused: nothing is drafted or published for it until accounts says it is allowed again. The month's
// plan (40 slideshows, 10 redos) stops the drafting without pausing (src/budget/quota.js), and so does the one money line:
// a customer's workspace whose AI cost this month reached half of what it pays writes nothing new until the next month,
// while what is approved still goes out (canGenerate below, src/billing/ai-share.js).

// In the words a customer reads them, on every page of a paused account and as the reason a send was refused (the
// audit, 2026-11-12: "מתג הכיבוי הופעל" and "רצף שגיאות פרסום" were the engine's words).
export const PAUSE_REASONS = {
  kill: 'עצרנו את החשבון',
  manual: 'הושהה ידנית',
  fact_check: 'בדיקת עובדות נכשלה', // no longer set; an account paused for it before still says so
  strike: 'הפלטפורמה דחתה פוסט כהפרת מדיניות',
  publish_errors: 'כמה מצגות ברצף לא עלו',
  takedowns: 'הודעות הסרה חוזרות',
};

/** Why nothing writes or publishes while the operator's stop for everything is on, as a customer reads it. */
export const GLOBAL_KILL_HE = 'תדר עצר זמנית את הכתיבה והפרסום';

/** Why an account of a workspace that has not paid writes and publishes nothing. */
export const UNPAID = 'התשלום על תדר לא פעיל בחשבון';

// A CUSTOMER'S POST GOES OUT ONLY WHEN A PERSON APPROVED IT. An account in a workspace is a customer's: it acts in
// approve mode whatever accounts.mode says, and its TikTok goes to the app's drafts (src/publish/index.js tiktokMode).
// Digest and auto, and TikTok straight to the profile, are the operator's, for the company's own accounts (no
// workspace, or one of the company's own workspaces, OF_OWN_WORKSPACES: src/billing/own.js). The rule is read here,
// where the mode is used, not only where it is set: a mode stored before the rule (a customer could once pick digest
// or auto on the Accounts page) is ignored, not trusted. The website says Teder never publishes without approval, and
// TikTok asks for the owner's preview and consent on each post it publishes.

/** Is this account a customer's (in a workspace that is not one of the company's own)? */
export const isCustomerAccount = (db, accountId) => customerWorkspace(db.get('SELECT workspace_id FROM accounts WHERE id = ?', accountId)?.workspace_id ?? null);

/** The autonomy mode the engine acts on: approve for a customer's account, the stored one for the operator's own. */
export function autonomyMode(db, accountId) {
  const row = db.get('SELECT mode, workspace_id FROM accounts WHERE id = ?', accountId);
  if (!row || customerWorkspace(row.workspace_id)) return 'approve';
  return ['approve', 'digest', 'auto'].includes(row.mode) ? row.mode : 'approve';
}

/** Did a person approve this post? The engine's own approvals (digest, auto) are `engine:<mode>`; a demo's are 'auto'. */
export const approvedByPerson = (post) => Boolean(post?.approved_by) && !/^engine:/.test(post.approved_by) && post.approved_by !== 'auto';

export function pauseAccount(db, accountId, reason, detail = null, actor = 'engine') {
  const acc = db.get('SELECT status, paused_reason FROM accounts WHERE id = ?', accountId);
  if (!acc) return;
  // A kill switch outranks any automatic reason; never overwrite it. Nor does a customer's own pause overwrite a pause
  // only the operator lifts: their resume would then lift that one too.
  if (acc.status === 'paused' && acc.paused_reason === 'kill' && reason !== 'kill') return;
  if (acc.status === 'paused' && OPERATOR_PAUSES.includes(acc.paused_reason) && reason === 'manual') return;
  db.update('accounts', accountId, { status: 'paused', paused_reason: reason, paused_detail: detail ? String(detail).slice(0, 500) : null, paused_at: nowIso(), updated_at: nowIso() });
  audit(db, { actor, action: 'pause', accountId, detail: { reason, detail } });
}

/**
 * Pauses only the operator lifts: the operator's kill switch, and a platform's strike (a post refused as a breach of
 * its rules). The customer's own switch on the Accounts page is a 'manual' pause, and repeated takedown notices wait
 * for the customer to look: both are theirs to lift (src/web/actions.js).
 */
export const OPERATOR_PAUSES = ['kill', 'strike'];

/** May this person resume this paused account? The operator any pause; anyone else not OPERATOR_PAUSES. */
export function mayResume(db, accountId, { operator = false } = {}) {
  if (operator) return true;
  const acc = db.get('SELECT status, paused_reason FROM accounts WHERE id = ?', accountId);
  return !(acc?.status === 'paused' && OPERATOR_PAUSES.includes(acc.paused_reason));
}

export function resumeAccount(db, accountId, actor = 'engine') {
  db.update('accounts', accountId, { status: 'active', paused_reason: null, paused_detail: null, paused_at: null, updated_at: nowIso() });
  audit(db, { actor, action: 'resume', accountId });
}

/** Can this account publish or generate right now? { ok, why } */
export function canRun(db, accountId) {
  if (settings(db).globalKill) return { ok: false, why: GLOBAL_KILL_HE };
  const acc = db.get('SELECT status, paused_reason, workspace_id FROM accounts WHERE id = ?', accountId);
  if (!acc) return { ok: false, why: 'אין חשבון כזה' };
  if (acc.status !== 'active') return { ok: false, why: PAUSE_REASONS[acc.paused_reason] || acc.status };
  // The paywall is a customer's: an account in no workspace, or in one of ours, is never asked about.
  if (customerWorkspace(acc.workspace_id) && !workspaceAllowed(db, acc.workspace_id)) return { ok: false, why: UNPAID, code: 'unpaid' };
  return { ok: true, why: null };
}

/**
 * May the engine write for this account now? canRun, and its workspace's AI not stopped this month (the owner,
 * 2026-11-11: "if ai costs of an account reach 30% of the payment of the customer, we get alerted. them on 50% it
 * stops"; src/billing/ai-share.js). Every drafting the runner and the jobs start asks this; publishing asks canRun
 * alone, so what is approved still goes out. { ok, why, code }.
 */
export function canGenerate(db, accountId) {
  const run = canRun(db, accountId);
  if (!run.ok) return run;
  return accountAiPaused(db, accountId) ? { ok: false, why: PAUSED_HE.title, code: AI_PAUSED } : run;
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
