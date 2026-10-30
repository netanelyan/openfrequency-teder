import { HOUR, now } from '../core/clock.js';
import { localFetch } from '../core/net.js';
import { audit, getSetting, setSetting } from '../core/store.js';

// Whether a workspace has paid for Teder: openfrequency-accounts owns subscriptions, Teder asks.
//
//   GET {OF_ACCOUNTS_INTERNAL}/internal/entitlement?workspace=<id>&product=teder, bearer OF_INTERNAL_TOKEN
//   -> { workspace, product: "teder", enabled, access: paid | comp | due | unpaid | cancelled | off, allowed, paidThrough,
//        cancelAt, graceUntil, plan: { name: "full" | "small", slideshows, redos } }
//
// The contract is openfrequency-accounts' docs/contracts/entitlement.json. `due` (2026-10-29) is a paid period that is
// over while the 14 days of grace the terms give run (graceUntil, allowed: true); then it is unpaid. An access this file
// does not know yet is still an answer: the decision is `allowed`'s alone, and `access` only says why.
//
// `allowed` is the only thing that opens or stops Teder. `plan` is the size of the workspace's month (src/budget/quota.js:
// the slideshows and redos all its accounts share); an answer without one, or with one not in that shape, is the full
// plan (40 and 10), and the rest of the answer stands. The day the workspace stopped being allowed is kept with the
// answer (`stoppedAt`, cleared when it is allowed again): the retention pass (src/billing/retention.js) disconnects its
// TikTok and Instagram once the service has stopped, as the privacy policy says.
//
// `allowed` is the only thing acted on here. The answer is kept in the settings table (entitlement:<workspace>), so the
// website and the runner read the same one and a restart keeps it:
//
//   - an answer under FRESH_MS (5 minutes) old is used as it is, nothing is asked
//   - 404 no_workspace (an id accounts never had) is an answer: not allowed. A deleted workspace is a 200, access off.
//   - when accounts cannot answer (down, a timeout, a 5xx, a 401 or 405, a shape that is not the contract's), the last answer it gave
//     stands for up to STALE_MS (24 hours): a paying customer is never stopped by a hiccup. Asked again after RETRY_MS.
//   - a workspace accounts never answered for, or whose last answer is older than that, is not allowed. Fail closed.
//
// What stops (src/autonomy/rails.js canRun, the website's paywall in src/web/server.js): an account whose workspace is
// not allowed writes nothing, drafts nothing to TikTok and publishes nothing; its posts, sources and settings stay as
// they are. An account in no workspace (the operator's own) is never asked about.

export const PRODUCT = 'teder';
export const FRESH_MS = 5 * 60_000;
export const STALE_MS = 24 * HOUR;
export const RETRY_MS = 60_000;
/** The access values the contract lists today. One not listed is still a well-formed answer (it only says why). */
export const ACCESS = ['paid', 'comp', 'due', 'unpaid', 'cancelled', 'off'];
const MIN_TOKEN = 32;

const keyOf = (workspaceId) => `entitlement:${workspaceId}`;

/** The last answer accounts gave for a workspace, as kept: { allowed, access, paidThrough, cancelAt, graceUntil, plan, stoppedAt, checkedAt }, or null. */
export const lastKnown = (db, workspaceId) => getSetting(db, keyOf(workspaceId), null);

/** Allowed now, from the last answer kept: its `allowed`, while it is under STALE_MS old. Never known is no. */
export function workspaceAllowed(db, workspaceId, t = now()) {
  const k = lastKnown(db, workspaceId);
  return Boolean(k && k.allowed === true && t - Date.parse(k.checkedAt) < STALE_MS);
}

/** May this account's engine run? Its workspace allowed, or no workspace (the operator's). */
export function accountAllowed(db, accountId, t = now()) {
  const ws = db.get('SELECT workspace_id FROM accounts WHERE id = ?', accountId)?.workspace_id ?? null;
  return ws == null || workspaceAllowed(db, ws, t);
}

/** The most slideshows or redos a plan from accounts may give a month: a typo there must not open thousands of posts. */
export const MAX_PLAN_SIZE = 1000;

/**
 * The plan in an answer, as kept: { name, slideshows, redos }, or null when there is none or it is not in the contract's
 * shape (the full plan's numbers stand then, src/budget/quota.js). Never a reason to doubt the rest of the answer.
 */
export function planOfAnswer(b) {
  const p = b?.plan;
  if (!p || typeof p !== 'object') return null;
  const n = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PLAN_SIZE;
  if (typeof p.name !== 'string' || !/^[a-z][a-z0-9-]{0,19}$/.test(p.name) || !n(p.slideshows) || !n(p.redos)) return null;
  return { name: p.name, slideshows: p.slideshows, redos: p.redos };
}

/** A 200 is believed only in the shape the contract gives it, and for the workspace asked about. */
function wellFormed(b, workspaceId) {
  if (!b || typeof b !== 'object') return false;
  if (b.workspace !== workspaceId || b.product !== PRODUCT || typeof b.allowed !== 'boolean') return false;
  if (b.access != null && (typeof b.access !== 'string' || !/^[a-z_]{1,20}$/.test(b.access))) return false;
  return true;
}

/**
 * The client. `fetchImpl` and `clock` replace the network and the time for the tests.
 * check(workspaceId, { live }) returns { workspace, allowed, known, access, paidThrough, cancelAt, checkedAt, source }, source
 * fresh (asked now) | cache (under 5 minutes) | stale (accounts did not answer: the last answer) | unknown (never answered).
 */
export function entitlementClient({ db, env = process.env, fetchImpl = localFetch, clock = now, timeoutMs = 2000, log = () => {} } = {}) {
  const base = String(env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  const failedAt = new Map();
  const asking = new Map();

  const view = (workspaceId, k, source, t) => ({
    workspace: workspaceId,
    allowed: Boolean(k && k.allowed === true && t - Date.parse(k.checkedAt) < STALE_MS),
    // Whether there is an answer to go by at all: not allowed and not known is accounts not answering, not unpaid.
    known: Boolean(k && t - Date.parse(k.checkedAt) < STALE_MS),
    access: k?.access ?? null,
    paidThrough: k?.paidThrough ?? null,
    graceUntil: k?.graceUntil ?? null,
    cancelAt: k?.cancelAt ?? null,
    checkedAt: k?.checkedAt ?? null,
    source: k ? source : 'unknown',
  });

  async function ask(workspaceId) {
    if (token.length < MIN_TOKEN) {
      log('[entitlement] OF_INTERNAL_TOKEN is not set (32 characters or more): no workspace is allowed');
      return null;
    }
    let r;
    try {
      r = await fetchImpl(`${base}/internal/entitlement?${new URLSearchParams({ workspace: String(workspaceId), product: PRODUCT })}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      log(`[entitlement] accounts unreachable at ${base}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
      return null;
    }
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* not JSON: handled below */
    }
    if (r.status === 200 && wellFormed(body, workspaceId)) return body;
    // A workspace accounts never had is an answer, not an error: not allowed. (A deleted one is a 200 with access off.)
    if (r.status === 404 && body?.error === 'no_workspace') return { workspace: workspaceId, product: PRODUCT, allowed: false, access: null, paidThrough: null, cancelAt: null, graceUntil: null };
    log(`[entitlement] workspace ${workspaceId}: ${r.status === 200 ? 'a 200 that does not match the contract' : `${r.status} ${body?.error || ''}`.trim()}: the last answer stands`);
    return null;
  }

  async function refresh(workspaceId, t) {
    const had = lastKnown(db, workspaceId);
    const a = await ask(workspaceId);
    if (!a) {
      failedAt.set(workspaceId, t);
      return view(workspaceId, had, 'stale', t);
    }
    failedAt.delete(workspaceId);
    const at = new Date(t).toISOString();
    // The plan accounts gave; one it no longer gives (or never gave) is the full plan's. When it stopped: kept from the
    // first answer that said not allowed, until one says allowed again.
    const stoppedAt = a.allowed ? null : had && had.allowed === false && had.stoppedAt ? had.stoppedAt : at;
    const next = { allowed: a.allowed, access: a.access ?? null, paidThrough: a.paidThrough ?? null, cancelAt: a.cancelAt ?? null, graceUntil: a.graceUntil ?? null, plan: planOfAnswer(a), stoppedAt, checkedAt: at };
    setSetting(db, keyOf(workspaceId), next);
    // Said once per change, not on every answer: the log and the audit.
    if (!had || had.allowed !== next.allowed) {
      log(`[entitlement] workspace ${workspaceId}: ${next.allowed ? 'allowed' : 'not allowed'} (${next.access || 'no access'})${next.allowed ? '' : ': nothing is written or published for it'}`);
      audit(db, { action: 'entitlement', detail: { workspace: workspaceId, allowed: next.allowed, access: next.access, was: had ? had.allowed : null } });
    }
    return view(workspaceId, next, 'fresh', t);
  }

  return {
    async check(workspaceId, { live = false } = {}) {
      if (!Number.isInteger(workspaceId)) throw new Error('entitlement check needs a workspace id');
      const t = clock();
      const k = lastKnown(db, workspaceId);
      if (!live && k && t - Date.parse(k.checkedAt) < FRESH_MS) return view(workspaceId, k, 'cache', t);
      const failed = failedAt.get(workspaceId);
      if (!live && failed != null && t - failed < RETRY_MS) return view(workspaceId, k, 'stale', t);
      // One question at a time per workspace: the pages of one browser opened together ask once.
      if (!asking.has(workspaceId)) asking.set(workspaceId, refresh(workspaceId, t).finally(() => asking.delete(workspaceId)));
      return asking.get(workspaceId);
    },
  };
}

/** The engine's client, made once per context (the website and the runner share the context, and so the client). */
export function entitlementsOf(ctx, env = process.env) {
  const root = ctx.global || ctx;
  root.entitlements ||= entitlementClient({ db: root.db, env, log: (m) => root.log?.(m) });
  return root.entitlements;
}

/** The runner's pass: every workspace that has an account, asked (or answered from the cache). Never throws. */
export async function refreshEntitlements(ctx, { env = process.env } = {}) {
  const ids = ctx.db.all('SELECT DISTINCT workspace_id AS ws FROM accounts WHERE workspace_id IS NOT NULL').map((r) => r.ws);
  const client = entitlementsOf(ctx, env);
  const out = {};
  for (const ws of ids) {
    try {
      out[ws] = (await client.check(ws)).allowed;
    } catch (e) {
      ctx.log?.(`[entitlement] workspace ${ws}: ${e.message}`);
    }
  }
  return out;
}
