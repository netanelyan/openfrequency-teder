import { now, nowIso } from '../core/clock.js';
import { getSetting, setSetting } from '../core/store.js';
import { meterSpend } from '../budget/ledger.js';
import { workspaceAllowed } from './entitlement.js';
import { customerWorkspace } from './own.js';

// Setting up before paying (the owner, 2026-11-02, item 2 of the audit: "Keep the per-workspace budget so unpaid
// onboarding can't run up costs. Set a cap for unpaid accounts, and show it to me").
//
// A customer whose workspace has not paid may go through /new and see the samples (src/web/server.js SETUP_OPEN). What
// that costs us is the setup's paid calls: the search for sources (three Haiku calls and up to six Brave searches), the
// account's voice and scenes when it is created (a Sonnet call and a Haiku one), and every sample written (a whole post
// each: outline, details, slides, review, rewrite, the photographs' checks, drawn twice). The per-workspace limits stay
// as they are (src/web/onboarding.js SAMPLE_ROUNDS: two rounds a new account, six a month); this is a lower ceiling over
// all of it, in dollars, while the workspace has not paid.
//
// THE CAP. UNPAID_SETUP_USD, $3.50 a workspace, for as long as it has not paid (not a month: it is not renewed), or
// OF_UNPAID_SETUP_USD in the environment. Where the number comes from (docs/costs.md, "Setting up before paying"): one
// normal setup is about $1.50, a search (about $0.035, most of it Brave), the account (about $0.03) and one round of
// samples (nine builds at most, about $0.16 each at the API's direct price, about $1.44); $3.50 is that and one more full
// round, with about $0.55 left for searching again. The cap is weighed before each paid step (a search, creating the
// account, each sample), so the step that crosses it finishes and nothing starts after it: at most one sample past it.
//
// WHAT IS COUNTED is what the ledger records (src/budget/ledger.js record) inside the setup's work, through a meter that
// follows it (meterSpend): its real cost from the usage block, or on a laptop the API price the Claude Code CLI's
// tokens come to. It is kept in the settings table, setup-spend:<workspace> = { usd, calls, at }, and only for a
// workspace that has not paid when the step starts. A workspace that pays is never weighed against it; nor is the
// operator, one of our own workspaces (src/billing/own.js) or an account in no workspace.

/** The most the setup of a workspace that has not paid may spend, in dollars, unless OF_UNPAID_SETUP_USD says otherwise. */
export const UNPAID_SETUP_USD = 3.5;

/** The cap in force: OF_UNPAID_SETUP_USD when it is a number of dollars from 0, else UNPAID_SETUP_USD. Read at every call. */
export function setupCapUsd(env = process.env) {
  const raw = String(env.OF_UNPAID_SETUP_USD ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : UNPAID_SETUP_USD;
}

/** Is this a customer's workspace that has not paid (the kept answer, src/billing/entitlement.js)? Never ours, never none. */
export const unpaidWorkspace = (db, workspaceId, t = now()) => customerWorkspace(workspaceId ?? null) && !workspaceAllowed(db, workspaceId, t);

const keyOf = (workspaceId) => `setup-spend:${workspaceId}`;

/** What the workspace's setup spent while it had not paid: { usd, calls, at }. */
export const setupSpend = (db, workspaceId) => ({ usd: 0, calls: 0, at: null, ...(getSetting(db, keyOf(workspaceId), null) || {}) });

/**
 * May the workspace's setup take another paid step? { ok, unpaid, spent, cap }. Always ok for a workspace that has paid
 * (and for ours, and for none); for one that has not, ok while what it spent is under the cap.
 */
export function setupRoom(db, workspaceId, { env = process.env, t = now() } = {}) {
  if (!unpaidWorkspace(db, workspaceId, t)) return { ok: true, unpaid: false, spent: null, cap: null };
  const spent = setupSpend(db, workspaceId).usd;
  const cap = setupCapUsd(env);
  return { ok: spent < cap, unpaid: true, spent, cap };
}

/**
 * Run a paid step of the setup (a search, creating the account, a round of samples), its spend counted against the
 * workspace while it has not paid. A workspace that has paid runs it as it is, uncounted.
 */
export function meterSetup(db, workspaceId, fn) {
  if (!unpaidWorkspace(db, workspaceId)) return fn();
  return meterSpend((usd) => {
    const s = setupSpend(db, workspaceId);
    setSetting(db, keyOf(workspaceId), { usd: s.usd + usd, calls: s.calls + 1, at: nowIso() });
  }, fn);
}
