import { monthKey, now, nowIso } from '../core/clock.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { alertOperator } from '../notify/operator.js';
import { lastKnown } from './entitlement.js';
import { customerWorkspace } from './own.js';

// What a paying customer's month of AI costs us, against what they pay for it. The owner, 2026-11-11: "also make sure
// toran and teder ai are smart. even if a slideshow gets to 0.5$, and even if toran costs 1.5x themselves. just make sure
// there is a cap where if ai costs of an account reach 30% of the payment of the customer, we get alerted. them on 50% it
// stops."
//
// Until then nothing refused a call for money (docs/decisions.md, "The budget is gone, the plan is the limit"): the plan
// of posts bounded the month, at about $0.17 to $0.21 a slideshow made on Sonnet. The writing is on Claude Opus 5.5 now
// (src/llm/index.js), about twice that (docs/costs.md), and this is the ceiling over it, per customer (a workspace):
//
//   THE COST   everything the spend ledger recorded this Israel calendar month for the workspace's accounts
//              (src/budget/ledger.js: Claude, Brave, every paid API), in dollars, made shekels at USD_ILS. A call the
//              Claude Code CLI answered on a laptop counts at its API price (api_usd), as the setup's cap counts it, so
//              a laptop weighs what the server would. Zernio is a subscription per connected account, not AI: not here
//   THE BASE   what a month costs the workspace before VAT: accounts' entitlement answer, `monthlyIls`
//              (docs/contracts/entitlement.json: the subscription's price, or its plan's list price when it is
//              complimentary); from an accounts that does not give it yet, the plan's list price here (LIST_ILS)
//   30%        the operator hears it (src/notify/operator.js: the log, /all, their WhatsApp through Toran), once a month
//              a workspace, in Hebrew: which customer, what it cost in ₪ and $, the share, the month
//   50%        the AI stops for the workspace's accounts until the next month: nothing new is drafted, no redo, no
//              sample, no step of a new account's setup, no model call from a light edit or the assistant. Posts already
//              approved still go out. The operator hears it, once, and the customer reads one calm line on Today, with no
//              cost and no share in it (src/web/ai-share.js). Weighed live: the runner and the jobs skip the workspace's
//              accounts (src/autonomy/rails.js canGenerate), buildPost refuses before it spends, and askJson refuses any
//              call left (src/llm/index.js), so the call that crosses the line is the last
//   LIFTED     the operator may let the AI go on for the rest of the month (Settings, developer mode, src/web/ai-share.js),
//              audited. A new month starts with none of it: no alert, no stop, no lift
//
// The company's own workspaces (OF_OWN_WORKSPACES, src/billing/own.js) and accounts in no workspace are never weighed. A
// workspace that has not paid generates nothing (the paywall), and its setup has its own cap (src/billing/setup-cap.js).
// What happened in a month is kept in the settings table, ai-share:<workspace> = { month, alertedAt, stoppedAt, liftedAt,
// liftedBy }; a record of another month is none of this one's.

/** The owner's two lines, as shares of what the customer pays a month before VAT. */
export const ALERT_SHARE = 0.3;
export const STOP_SHARE = 0.5;

/** Shekels a dollar unless USD_ILS says otherwise: the Bank of Israel's representative rate on 2026-11-11 was 3.172 (edge.boi.gov.il, RER_USD_ILS). */
export const DEFAULT_USD_ILS = 3.17;

/** The rate in force: USD_ILS when it is a rate a shekel could have (1 to 10), else DEFAULT_USD_ILS. Read at every call. */
export function usdIls(env = process.env) {
  const raw = String(env.USD_ILS ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 1 && n <= 10 ? n : DEFAULT_USD_ILS;
}

/** Teder's plans' list prices a month before VAT (openfrequency-accounts src/accounts/subscriptions.js PLANS), for an answer without monthlyIls. */
export const LIST_ILS = { full: 790, small: 490 };

/** Why buildPost and askJson refuse: the code callers know it by (a PausedError's, src/pipeline/build.js, carries it too). */
export const AI_PAUSED = 'ai_paused';

/**
 * What the customer reads while their AI is stopped: what stopped, that we are on it, and what still goes on; never a
 * cost or a share. `title` and `text` are Today's line (src/web/ai-share.js); `title` alone is also a post's reason when
 * one was cut off by the stop. `setup` refuses a step of a new account, `edit` a light edit's text.
 */
export const PAUSED_HE = {
  title: 'כרגע לא נכתבות מצגות חדשות, ואנחנו כבר מטפלים בזה.',
  text: 'מה שכבר אישרתם עולה בזמן, כרגיל.',
  setup: 'כרגע לא נכתבות מצגות חדשות, ואנחנו כבר מטפלים בזה. מה שכבר בניתם נשמר, ונמשיך מאותה נקודה.',
  edit: 'שינויים בטקסט לא נשמרים כרגע, ואנחנו כבר מטפלים בזה. אפשר בינתיים להחליף תמונה או להוריד שקף.',
};

/** A model call refused because the account's workspace reached STOP_SHARE this month (askJson's backstop). */
export class AiPausedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiPausedError';
    this.code = AI_PAUSED;
  }
}

/** The workspace's cost this Israel month, in dollars: every row of the ledger for its accounts, at the dearer of usd and api_usd. */
export function monthUsd(db, workspaceId, t = now()) {
  return db.get('SELECT COALESCE(SUM(MAX(usd, COALESCE(api_usd, 0))), 0) AS usd FROM spend WHERE month = ? AND account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)', monthKey(t), workspaceId).usd;
}

/** What a month costs the workspace before VAT, in shekels: accounts' monthlyIls, else its plan's list price, else the full plan's. */
export function baseIls(db, workspaceId) {
  const k = lastKnown(db, workspaceId);
  if (typeof k?.monthlyIls === 'number' && Number.isFinite(k.monthlyIls) && k.monthlyIls > 0) return k.monthlyIls;
  return LIST_ILS[k?.plan?.name] ?? LIST_ILS.full;
}

const keyOf = (workspaceId) => `ai-share:${workspaceId}`;

/** What happened in the month (YYYY-MM): { month, alertedAt?, stoppedAt?, liftedAt?, liftedBy? }. */
function stateOf(db, workspaceId, month) {
  const s = getSetting(db, keyOf(workspaceId), null);
  return s?.month === month ? s : { month };
}

/**
 * Where a workspace stands this month: { workspace, month, usd, ils, base, share, rate, customer, alertedAt, stoppedAt,
 * liftedAt, liftedBy, stopped }. `stopped`: a customer's workspace at STOP_SHARE or past it, not lifted this month.
 */
export function aiShare(db, workspaceId, { t = now(), env = process.env } = {}) {
  const month = monthKey(t);
  const rate = usdIls(env);
  const usd = monthUsd(db, workspaceId, t);
  const base = baseIls(db, workspaceId);
  const ils = usd * rate;
  const share = ils / base;
  const s = stateOf(db, workspaceId, month);
  const customer = customerWorkspace(workspaceId ?? null, env);
  return {
    workspace: Number(workspaceId), month, usd, ils, base, share, rate, customer,
    alertedAt: s.alertedAt || null, stoppedAt: s.stoppedAt || null, liftedAt: s.liftedAt || null, liftedBy: s.liftedBy || null,
    stopped: customer && share >= STOP_SHARE && !s.liftedAt,
  };
}

/** Is the AI stopped for this workspace now? Never for one of ours, never for none. */
export const workspaceAiPaused = (db, workspaceId, { t = now(), env = process.env } = {}) => customerWorkspace(workspaceId ?? null, env) && aiShare(db, workspaceId, { t, env }).stopped;

/** Is the AI stopped for this account: its workspace's? */
export const accountAiPaused = (db, accountId, opts = {}) => workspaceAiPaused(db, db.get('SELECT workspace_id FROM accounts WHERE id = ?', accountId)?.workspace_id ?? null, opts);

/* ------------------------------------------------------------------ what the operator hears */

const MONTH_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
/** "בנובמבר 2026", from "2026-11". */
const inMonthHe = (month) => `ב${MONTH_HE[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** The first day of the next month as the pages write a day: "1.12.2026". */
export const nextMonthHe = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `1.1.${y + 1}` : `1.${m + 1}.${y}`;
};
/** A whole share, never rounded up to a line it has not reached: 0.4996 is 49%. */
const pct = (share) => Math.floor(share * 100 + 1e-9);
const shekels = (n) => Math.round(n).toLocaleString('en-US');
const dollars = (n) => n.toFixed(2);

/** The customer in the operator's words: the workspace and its accounts' names, as the health table on /all names them. */
export function customerHe(db, workspaceId) {
  const names = db.all("SELECT display_name FROM accounts WHERE workspace_id = ? AND status != 'onboarding' ORDER BY id", workspaceId).map((r) => r.display_name).filter(Boolean);
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` ועוד ${names.length - 3}` : '');
  return `סביבת עבודה ${workspaceId}${list ? ` (${list.slice(0, 120)})` : ''}`;
}

/** The two alerts, as the operator's WhatsApp gets them (Toran's operator_alert: a title and a body, each one line). */
export function alertWords(db, a, kind) {
  const who = customerHe(db, a.workspace);
  const cost = `${inMonthHe(a.month)} עלה לנו עד עכשיו ${shekels(a.ils)} ₪ (${dollars(a.usd)} דולר), ${pct(a.share)}% מ-${shekels(a.base)} ₪ שהוא משלם לחודש לפני מע״מ`;
  if (kind === 'stop') {
    return {
      title: `תדר: עצרתי את ה-AI של לקוח, העלות הגיעה ל-${pct(a.share)}% ממה שהוא משלם`,
      body: `${who}. ${cost}. עד ${nextMonthHe(a.month)} לא נכתב לו שום דבר חדש, ומה שכבר אושר עולה כרגיל. אפשר לפתוח לו עד סוף החודש בהגדרות של תדר, במצב מפתח.`,
    };
  }
  return {
    title: `תדר: עלות ה-AI של לקוח הגיעה ל-${pct(a.share)}% ממה שהוא משלם`,
    body: `${who}. ${cost}. ב-${Math.round(STOP_SHARE * 100)}% אני עוצר לו את ה-AI עד סוף החודש.`,
  };
}

/** How long Toran holds an alert's key: the most its contract takes (43,200 minutes). The key carries the month anyway. */
const EVERY_MS = 30 * 86_400_000;

/**
 * The runner's pass (src/autonomy/runner.js): every customer's workspace that has an account, weighed; the operator told
 * when it reaches ALERT_SHARE and when it reaches STOP_SHARE, once a month each (a workspace that goes past both between
 * two passes hears the stop alone). What was said is kept before it is said, so a slow Toran never says it twice.
 * Returns [{ workspace, share, said: 'alert' | 'stop' }] of what was said now. Never throws.
 */
export async function aiShareTick(ctx, { t = now(), env = process.env, alert = alertOperator } = {}) {
  const { db } = ctx;
  const out = [];
  const ids = db.all('SELECT DISTINCT workspace_id AS ws FROM accounts WHERE workspace_id IS NOT NULL ORDER BY ws').map((r) => r.ws).filter((ws) => customerWorkspace(ws, env));
  for (const ws of ids) {
    try {
      const a = aiShare(db, ws, { t, env });
      if (a.share < ALERT_SHARE) continue;
      const kind = a.share >= STOP_SHARE ? 'stop' : 'alert';
      const s = stateOf(db, ws, a.month);
      if (kind === 'stop' ? s.stoppedAt : s.alertedAt) continue;
      const at = new Date(t).toISOString();
      setSetting(db, keyOf(ws), { ...s, alertedAt: s.alertedAt || at, ...(kind === 'stop' ? { stoppedAt: at } : {}) });
      audit(db, { action: kind === 'stop' ? 'ai_stopped' : 'ai_alert', detail: { workspace: ws, month: a.month, usd: Number(a.usd.toFixed(4)), ils: Number(a.ils.toFixed(2)), base: a.base, share: Number(a.share.toFixed(4)) } });
      ctx.log?.(`[ai-share] workspace ${ws}: ${pct(a.share)}% of ${a.base} ILS in ${a.month}${kind === 'stop' ? ': its AI stops until the next month' : ''}`);
      await alert(ctx, `ai-share-${kind === 'stop' ? 50 : 30}:${ws}:${a.month}`, alertWords(db, a, kind), { t, every: EVERY_MS, env });
      out.push({ workspace: ws, share: a.share, said: kind });
    } catch (e) {
      ctx.log?.(`[ai-share] workspace ${ws}: ${e.message}`);
    }
  }
  return out;
}

/**
 * The operator lets the workspace's AI go on for the rest of this month, though it is past STOP_SHARE. Audited.
 * { lifted: true } or { lifted: false, why: 'not_stopped' } (nothing to lift: under the line, lifted already, or ours).
 */
export function liftStop(db, workspaceId, { by, t = now(), env = process.env } = {}) {
  const a = aiShare(db, workspaceId, { t, env });
  if (!a.stopped) return { lifted: false, why: 'not_stopped' };
  const s = stateOf(db, workspaceId, a.month);
  setSetting(db, keyOf(workspaceId), { ...s, stoppedAt: s.stoppedAt || nowIso(), liftedAt: new Date(t).toISOString(), liftedBy: String(by || 'operator').slice(0, 120) });
  audit(db, { actor: by || 'operator', action: 'ai_stop_lifted', detail: { workspace: Number(workspaceId), month: a.month, share: Number(a.share.toFixed(4)), ils: Number(a.ils.toFixed(2)), base: a.base } });
  return { lifted: true };
}

/**
 * Every customer's workspace that has an account, as the operator's panel lists them (src/web/ai-share.js), the dearest
 * share first: aiShare() with `who`, the customer in the operator's words.
 */
export function aiShares(db, { t = now(), env = process.env } = {}) {
  return db
    .all('SELECT DISTINCT workspace_id AS ws FROM accounts WHERE workspace_id IS NOT NULL ORDER BY ws')
    .map((r) => r.ws)
    .filter((ws) => customerWorkspace(ws, env))
    .map((ws) => ({ ...aiShare(db, ws, { t, env }), who: customerHe(db, ws) }))
    .sort((x, y) => y.share - x.share);
}
