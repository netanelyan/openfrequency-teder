import { monthKey, now, nowIso } from '../core/clock.js';
import { BATCH_FACTOR, MODEL_RATES } from './pricing.js';

// What every paid call cost, recorded after it: for the operator (Settings, the ledger by customer), for the cost per
// post (docs/costs.md), and for nothing else. Nothing here refuses a call. There is no money cap: a customer's month is
// a plan of posts (src/budget/quota.js, 40 suggestions and 10 redos), and that plan is what bounds the spend
// (docs/decisions.md, "The budget is gone, the plan is the limit").
//
// Claude is priced from the usage block the API returned, at the published rates in pricing.js. A model that is not
// there, and an estimate for a recorded answer, are priced at the dearest rate there is, so a cost is overstated rather
// than hidden. Zernio is a subscription per connected account, recorded beside this in zernio_costs.

export { BATCH_FACTOR, MODEL_RATES, PRICES_VERIFIED } from './pricing.js';
export const WORST = Object.values(MODEL_RATES).reduce((a, b) => (b.in + b.out > a.in + a.out ? b : a));

const ratesFor = (model, promptTokens = 0) => {
  const r = MODEL_RATES[model] || WORST;
  return r.long && promptTokens > r.long.over ? r.long : r;
};

/** Dollars for one Claude response's usage block. */
export function claudeCost(usage = {}, model, { batch = false } = {}) {
  const fresh = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  const r = ratesFor(model, fresh + write + read);
  // The usage block splits cache writes by duration when it can; without the
  // split, a write is billed at the dearer 1-hour rate (overstating, never hiding).
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens;
  const w5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const writeUsd = w1h != null || w5m != null ? (w1h || 0) * r.write1h + (w5m || 0) * r.write5m : write * r.write1h;
  const usd = (fresh * r.in + writeUsd + read * r.cacheRead + out * r.out) / 1e6;
  return batch ? usd * BATCH_FACTOR : usd;
}

/** Metered APIs other than Claude, per call. Zernio is a per-account subscription, recorded on its own. */
export const API_PRICES = {
  brave: 5 / 1000,
  youtube: 0,
  pexels: 0,
  unsplash: 0,
  commons: 0,
  openverse: 0,
};

/** This month's spend: one account's, or everything when accountId is undefined. */
export function monthSpend(db, accountId, t = now()) {
  const month = monthKey(t);
  const row =
    accountId === undefined
      ? db.get('SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls FROM spend WHERE month = ?', month)
      : db.get('SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls FROM spend WHERE month = ? AND account_id IS ?', month, accountId);
  return { usd: row.usd, calls: row.calls, month };
}

export function record(db, { accountId = null, postId = null, api, model = null, units = 1, usd, estimated = false, tag = null, t = now(), batch = false, usage = null, apiUsd = null }) {
  db.insert('spend', { account_id: accountId, post_id: postId, api, model, units, usd, estimated: estimated ? 1 : 0, tag, month: monthKey(t), at: nowIso(), batch: batch ? 1 : 0, usage_json: usage, api_usd: apiUsd });
  return usd;
}

/**
 * What a call answered by the Claude Code CLI would cost through the API, from
 * the tokens the CLI reported. `cachedShare` is the share of the prompt that is
 * the stable system prefix (the pack and the task), which production reads from
 * the cache. Returns { list: every token at the full rate, as a direct call
 * without a cache; prod: batched, the prefix read from the cache, as the runner
 * sends it }. A cache write (once per pack and task per batch) is left out of
 * prod: a fraction of a cent a day.
 */
export function apiEquivalent(usage = {}, model, { cachedShare = 0, batch = true } = {}) {
  const total = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const out = usage.output_tokens || 0;
  const cached = Math.round(total * Math.min(1, Math.max(0, cachedShare)));
  return {
    list: claudeCost({ input_tokens: total, output_tokens: out }, model),
    prod: claudeCost({ input_tokens: total - cached, cache_read_input_tokens: cached, output_tokens: out }, model, { batch }),
  };
}

/** A post's own total, for the cost-per-post figure. */
export const postSpend = (db, postId) => db.get('SELECT COALESCE(SUM(usd), 0) AS usd, MAX(estimated) AS estimated FROM spend WHERE post_id = ?', postId);

/**
 * AI spend per produced post over the last 30 days, every call included (the ones for posts our checks stopped too):
 * what Settings shows the operator. null until the account has four posts, or while its costs are estimates.
 */
export function costPerPost(db, accountId, t = now()) {
  const since = new Date(t - 30 * 86_400_000).toISOString();
  const spend = db.get("SELECT COALESCE(SUM(usd), 0) AS usd, MAX(estimated) AS est FROM spend WHERE account_id = ? AND api = 'claude' AND at >= ?", accountId, since);
  const made = db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND sample = 0 AND created_at >= ? AND status NOT IN ('blocked', 'drafting')", accountId, since).n;
  if (made < 4 || spend.est) return null;
  return spend.usd / made;
}
