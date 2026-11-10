import { HOUR, monthKey, now, nowIso } from '../core/clock.js';
import { lastKnown } from '../billing/entitlement.js';
import { customerWorkspace } from '../billing/own.js';
import { monthSpend } from './ledger.js';
import { israelDate, israelInstant } from '../schedule/israel.js';

// A customer's month: how many posts they got, how many rejected ones are written again their way, and what it costs
// us. Every count is read from the posts themselves, never kept beside them, so nothing can drift.
//
// THE PROMISE IS POSTS THE CUSTOMER GOT, NOT POSTS WE OFFERED (the owner, 2026-11-09: "because we promise 40 videos a
// month, there cant be a day without posts. even if 10 posts are being declined, the customer has to get the 11th").
// Until then a post counted against the 40 the moment it reached the customer, so every decline ate one of their 40
// and could leave its day empty. Now the plan's number (`suggested`, the name kept for the code that reads it) counts
// the posts the customer got: approved, by them or by the engine for the company's own accounts, and on its way or
// out (GOT below). A post that waits for them holds its place while it waits (`waiting`), as a draft in progress does
// (`held`), so the day's posts cannot together go past the plan; a declined post, or one left to expire, gives its
// place back. A declined post's day is drafted again (src/autonomy/every-day.js), as many times as it takes, so a
// decline never leaves a day without a post. What keeps that from running away is ours and the customer never sees
// it: DRAFTS_PER_DAY below, with the operator told when an account reaches it.
//
// THE PLAN IS THE ONLY LIMIT, AND IT IS THE CUSTOMER'S. A workspace (one paying customer) gets its plan's slideshows
// and redos a month, shared by every account (page) it has: the full plan 40 and 10, the small one 15 and 4, as accounts
// says in its entitlement answer (src/billing/entitlement.js, `plan`; no answer, or none with a plan, is the full one).
// Opening another account gives a customer more pages, never more posts. No money cap blocks or slows anything
// (docs/decisions.md, "The budget is gone, the plan is the limit"), and there is no cap on how many accounts a
// workspace opens: the paid plan is the ceiling.
//
// An account in no workspace (the operator's own) has a month of its own: 40 and 10, or the operator's numbers for it
// (setPlan). So does an account in one of the company's own workspaces (OF_OWN_WORKSPACES, src/billing/own.js): it is
// ours, in a workspace only so that its people see it, and shares nothing with the workspace's other accounts. A
// customer's plan is changed in accounts, never here.
//
//   suggestion   a post that passed every check and reached the customer for approval, in the month it reached them.
//                It is one of the plan's posts once they got it (approved, then out), and only then; declined or left
//                to expire, it counts for nothing
//   redo         a post written again their way because the customer rejected one with their reason and asked for
//                it. It is one of the plan's posts once they got it, as a suggestion is; and it is one of the month's
//                redos once it reached them, whatever they did with it after. When the redos are used up, a rejection
//                that asks for one gets a new post for the day instead (src/web/actions.js reject)
//   retry        a post our checks blocked, and every repair call inside a post: our cost, never counted
//
// A post still being drafted holds its place (for a day at most: a batch takes hours, a draft that never finished
// was lost to a restart), and so does one waiting for the customer. When the posts the customer got, with those
// waiting and those being written, reach the plan, nothing more is generated for the account until the next month
// (runner.js, buildPost).
//
// What the posts cost is recorded (ledger.js) and shown to the operator, by what it went to (ledger() below). It
// never stops a post.

export const DEFAULT_PLAN = { suggested: 40, redos: 10 };
/**
 * Which posts count: every one that reached the customer, except one that failed to publish with nothing of it out
 * (published_at is when a part went out): that one is not theirs to lose. Sent again and out, it counts again.
 */
const COUNTS = "NOT (status = 'failed' AND published_at IS NULL)";
/**
 * The posts the customer got, what the plan's number counts: approved (by them, or by the engine for the company's
 * own accounts), held for a connection, being sent, out, or in their TikTok inbox as a draft; or failed with a part
 * already out. A failed post with nothing out is not theirs yet: sent again and out, it counts.
 */
const GOT = "(status IN ('approved', 'held', 'publishing', 'published', 'drafted') OR (status = 'failed' AND published_at IS NOT NULL))";
/** Of those, the ones already out: what "פורסמו" says. */
const OUT = "(status IN ('published', 'drafted') OR (status = 'failed' AND published_at IS NOT NULL))";
/** How long a draft in progress holds a place in the quota. */
export const HOLD_MS = 24 * HOUR;
/**
 * The most posts drafted for one account in one Israel day, every kind together (the day-ahead batch, a declined
 * day's new post, a redo, a blocked post's second try). Ours, never shown to the customer: a guard against a loop
 * that would draft and pay without end. A day of an account at its most (2 slots today, 2 tomorrow, a second try
 * each) is under 10, and the owner's "even if 10 posts are being declined, the customer has to get the 11th" is
 * under 15; past 20 something is wrong, the account drafts nothing more that day and the operator hears it
 * (src/pipeline/build.js DraftCapError).
 */
export const DRAFTS_PER_DAY = 20;
/** The most the operator may set, so a typo cannot open an account to thousands of posts. */
export const MAX_PLAN = { suggested: 1000, redos: 1000 };

/** The reasons a customer rejects a post for, in the order the form lists them. */
export const REDO_REASONS = ['topic', 'shorter', 'tone', 'photo', 'other'];
/** Each reason as the rejection form offers it. */
export const REJECT_REASON_HE = { topic: 'הנושא לא מתאים', shorter: 'ארוך מדי', tone: 'הטון לא נכון', photo: 'התמונות לא מתאימות', other: 'משהו אחר' };
/** What the replacement is, said after "במקום הפוסט ההוא". */
export const REDO_REASON_HE = { topic: 'עם נושא אחר', shorter: 'בגרסה קצרה יותר', tone: 'בטון אחר', photo: 'עם תמונות אחרות', other: 'עם השינוי שביקשתם' };

/** The plan names accounts sells, as a customer reads them. */
export const PLAN_HE = { full: 'החבילה המלאה', small: 'החבילה הקטנה' };

/** A workspace's plan, as accounts last said it: { name, suggested, redos }, the full plan's when it never said one. */
export function workspacePlan(db, workspaceId) {
  const p = lastKnown(db, workspaceId)?.plan;
  return p ? { name: p.name, suggested: p.slideshows, redos: p.redos } : { name: 'full', ...DEFAULT_PLAN };
}

/**
 * An account's plan: { suggested, redos, scope, workspaceId, name, set }. A customer's account has its workspace's
 * (scope 'workspace': the month is shared with the workspace's other accounts); the operator's own, in no workspace or
 * in one of ours, has its own (scope 'account': the operator's number or the default, 40 and 10, and `set` says which
 * ones the operator set).
 */
export function planOf(db, accountId) {
  const row = db.get('SELECT plan_suggested, plan_redos, workspace_id FROM accounts WHERE id = ?', accountId) || {};
  if (customerWorkspace(row.workspace_id ?? null)) {
    const w = workspacePlan(db, row.workspace_id);
    return { suggested: w.suggested, redos: w.redos, scope: 'workspace', workspaceId: row.workspace_id, name: w.name, set: { suggested: false, redos: false } };
  }
  const int = (v, d) => (v == null ? d : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    suggested: int(row.plan_suggested, DEFAULT_PLAN.suggested),
    redos: int(row.plan_redos, DEFAULT_PLAN.redos),
    scope: 'account',
    workspaceId: null,
    name: null,
    set: { suggested: row.plan_suggested != null, redos: row.plan_redos != null },
  };
}

/** The accounts that share an account's month: its workspace's, or itself alone. */
export function sharing(db, accountId, plan = planOf(db, accountId)) {
  if (plan.scope !== 'workspace') return [accountId];
  const ids = db.all('SELECT id FROM accounts WHERE workspace_id = ? ORDER BY id', plan.workspaceId).map((r) => r.id);
  return ids.includes(accountId) ? ids : [...ids, accountId];
}

/**
 * How many of the month's slideshows an account's schedule is thinned to (src/schedule/choice.js): the whole plan for
 * an account that has it alone, an even share for one that shares it with the workspace's other running accounts, so
 * each of them posts all month instead of the first one using it up. The plan itself stays one: an account that writes
 * less leaves more for the others.
 */
export function monthShare(db, accountId) {
  const plan = planOf(db, accountId);
  if (plan.scope !== 'workspace') return plan.suggested;
  const others = db.get("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ? AND id <> ? AND status IN ('active', 'paused')", plan.workspaceId, accountId).n;
  return Math.ceil(plan.suggested / (others + 1));
}

/**
 * The operator sets an account's plan. Each value is a whole number from 0 to MAX_PLAN, or '' / null for the default.
 * Returns { problems } when a value is not one, else the plan as saved.
 */
export function setPlan(db, accountId, { suggested, redos }) {
  const problems = [];
  const read = (v, key) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_PLAN[key] || !Number.isInteger(n)) {
      problems.push(key);
      return undefined;
    }
    return n;
  };
  const patch = { plan_suggested: read(suggested, 'suggested'), plan_redos: read(redos, 'redos') };
  if (problems.length) return { problems };
  // A customer's plan is their workspace's, set in accounts: numbers here would be read by nothing. Ours are set here,
  // in a workspace of ours too.
  if (customerWorkspace(db.get('SELECT workspace_id FROM accounts WHERE id = ?', accountId)?.workspace_id ?? null)) return { problems: ['workspace'] };
  db.update('accounts', accountId, { ...patch, updated_at: nowIso() });
  return planOf(db, accountId);
}


/**
 * Where an account stands this month, all of the month it has (its workspace's, shared, or its own):
 *   suggested   the plan's posts: `used` the posts the customer got (GOT), `out` those of them already out, `waiting`
 *               the ones waiting for them, `held` drafts in progress (redos too: a redo is a post of the plan as well),
 *               and `left` what a new draft may still take: limit - used - waiting - held
 *   redos       the month's redos: `used` every redo that reached the customer, `held` redos being written, `left`
 * `accounts` is each sharing account's own count (posts got, redos), for the pages that list them; and what the
 * account has cost so far, for the operator's eyes.
 */
export function usage(db, accountId, t = now()) {
  const month = monthKey(t);
  const plan = planOf(db, accountId);
  const ids = sharing(db, accountId, plan);
  const inIds = `(${ids.map(() => '?').join(', ')})`;
  const rows = db.all(
    `SELECT account_id, quota_kind, SUM(CASE WHEN ${GOT} THEN 1 ELSE 0 END) AS got, SUM(CASE WHEN ${OUT} THEN 1 ELSE 0 END) AS out,
       SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN ${COUNTS} THEN 1 ELSE 0 END) AS reached
     FROM posts WHERE account_id IN ${inIds} AND quota_month = ? AND quota_kind IN ('suggestion', 'redo') GROUP BY account_id, quota_kind`,
    ...ids,
    month
  );
  const posts = { got: 0, out: 0, waiting: 0 };
  let redos = 0;
  const accounts = Object.fromEntries(ids.map((id) => [id, { suggested: 0, redos: 0 }]));
  for (const r of rows) {
    posts.got += r.got;
    posts.out += r.out;
    posts.waiting += r.waiting;
    accounts[r.account_id].suggested += r.got;
    if (r.quota_kind === 'redo') {
      redos += r.reached;
      accounts[r.account_id].redos += r.reached;
    }
  }
  const since = new Date(t - HOLD_MS).toISOString();
  const held = Object.fromEntries(
    db.all(`SELECT CASE WHEN redo_of IS NULL THEN 'suggestion' ELSE 'redo' END AS k, COUNT(*) AS n FROM posts WHERE account_id IN ${inIds} AND status = 'drafting' AND sample = 0 AND created_at >= ? GROUP BY k`, ...ids, since).map((r) => [r.k, r.n])
  );
  const drafting = (held.suggestion || 0) + (held.redo || 0);
  return {
    month,
    suggested: { used: posts.got, out: posts.out, waiting: posts.waiting, held: drafting, limit: plan.suggested, left: Math.max(0, plan.suggested - posts.got - posts.waiting - drafting) },
    redos: { used: redos, held: held.redo || 0, limit: plan.redos, left: Math.max(0, plan.redos - redos - (held.redo || 0)) },
    cost: { spent: monthSpend(db, accountId, t).usd },
    plan,
    accounts,
    shared: ids.length > 1,
  };
}

/**
 * How many posts were drafted for an account in the Israel day of `t`, every kind (not samples): what DRAFTS_PER_DAY
 * is weighed against.
 */
export function draftsToday(db, accountId, t = now()) {
  const from = israelInstant(israelDate(t), '00:00').toISOString();
  return db.get('SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND sample = 0 AND created_at >= ? AND created_at <= ?', accountId, from, new Date(t).toISOString()).n;
}

/**
 * The months of a set of accounts, each counted once: a workspace's accounts share one, and adding theirs up would count
 * it again for each. { used, out, limit } of the plan's posts: got, out, and the plan.
 */
export function monthsOf(db, accountIds, t = now()) {
  const seen = new Set();
  const out = { used: 0, out: 0, limit: 0 };
  for (const id of accountIds) {
    const u = usage(db, id, t);
    const key = u.plan.scope === 'workspace' ? `ws:${u.plan.workspaceId}` : `acc:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.used += u.suggested.used;
    out.out += u.suggested.out;
    out.limit += u.suggested.limit;
  }
  return out;
}

/**
 * May a new draft start? { ok, why, full, usage }. Every draft needs a place among the plan's posts (a redo too: it is
 * a post the customer may get); a redo also needs one of the month's redos. `full` says which ran out: 'posts' or
 * 'redos'.
 */
export function room(db, accountId, { redo = false, t = now() } = {}) {
  const u = usage(db, accountId, t);
  const s = u.suggested;
  const r = u.redos;
  if (s.left <= 0) return { ok: false, full: 'posts', why: `${accountId}: this month's posts are all taken (${s.used} got${s.waiting ? `, ${s.waiting} waiting` : ''}${s.held ? `, ${s.held} in progress` : ''}, of ${s.limit})`, usage: u };
  if (redo && r.left <= 0) return { ok: false, full: 'redos', why: `${accountId}: this month's redos are used up (${r.used}${r.held ? ` and ${r.held} in progress` : ''} of ${r.limit})`, usage: u };
  return { ok: true, full: null, why: null, usage: u };
}

/** The Israel month a post that reached the customer now is counted in. */
export const quotaMonth = (t = now()) => monthKey(t);

/**
 * What one account really cost in a month, by what each dollar was for:
 *   suggestion, redo, retry   the posts of each kind, and every call made for them (a suggestion's own repair rounds
 *                             included: they are inside the post)
 *   edit                      the fact check of a customer's light edit
 *   account                   the account's work that is no one post's (the morning's feedback, scoring topics)
 *   drafting, sample          a post still being written; an onboarding sample
 * Counts are of posts by the month they reached the customer (or were blocked); dollars are by the month they were
 * spent. `perDelivered` is every dollar over the suggestions and redos that reached the customer; `got` the posts of
 * the month the customer got, what the plan counts.
 */
export function ledger(db, accountId, month = monthKey()) {
  const rows = db.all(
    `SELECT CASE WHEN s.tag = 'edit-check' THEN 'edit' WHEN s.post_id IS NULL THEN 'account'
       ELSE COALESCE(p.quota_kind, CASE WHEN p.sample = 1 THEN 'sample' ELSE 'drafting' END) END AS bucket,
       COALESCE(SUM(s.usd), 0) AS usd, COUNT(*) AS calls, MAX(s.estimated) AS estimated
     FROM spend s LEFT JOIN posts p ON p.id = s.post_id WHERE s.account_id = ? AND s.month = ? GROUP BY bucket`,
    accountId,
    month
  );
  const posts = Object.fromEntries(db.all('SELECT quota_kind, COUNT(*) AS n FROM posts WHERE account_id = ? AND quota_month = ? AND quota_kind IS NOT NULL GROUP BY quota_kind', accountId, month).map((r) => [r.quota_kind, r.n]));
  // What the plan counts (GOT): the posts of the month the customer got, of both kinds.
  const got = db.get(`SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND quota_month = ? AND quota_kind IN ('suggestion', 'redo') AND ${GOT}`, accountId, month).n;
  // Named bucket, not kind: posts has a kind of its own (the format's), and GROUP BY kind would group by that.
  const by = Object.fromEntries(rows.map((r) => [r.bucket, { usd: r.usd, calls: r.calls, estimated: Boolean(r.estimated) }]));
  const kinds = ['suggestion', 'redo', 'retry', 'edit', 'account', 'drafting', 'sample'];
  const out = kinds.map((kind) => ({ kind, posts: posts[kind] ?? null, usd: by[kind]?.usd || 0, calls: by[kind]?.calls || 0, estimated: by[kind]?.estimated || false }));
  const total = out.reduce((s, r) => s + r.usd, 0);
  const delivered = (posts.suggestion || 0) + (posts.redo || 0);
  return { accountId, month, rows: out, total, delivered, got, perDelivered: delivered ? total / delivered : null, estimated: out.some((r) => r.estimated) };
}

/** The last `n` Israel months, newest first: for the ledger's table. */
export function lastMonths(n = 3, t = now()) {
  const out = [];
  let [y, m] = monthKey(t).split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (!m) [y, m] = [y - 1, 12];
  }
  return out;
}
