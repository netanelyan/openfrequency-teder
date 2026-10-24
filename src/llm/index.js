import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { isSet } from '../core/env.js';
import { ensureDir, ofHome } from '../core/paths.js';
import { apiEquivalent, claudeCost, MODEL_RATES, record, WORST } from '../budget/ledger.js';
import { ClaudeError, claudeClient, requestParams } from './claude.js';
import { cliClient, systemText } from './cli.js';
import { recordedClient } from './recorded.js';

// One entry point for every model call, and what each one cost recorded after it.
// Nothing here refuses a call for money: there is no cap (docs/decisions.md, "The
// budget is gone, the plan is the limit").
//
// Which model does which job (docs/costs.md has the measurements behind it):
//   draft    the outline and the slides: Claude Sonnet 5.5
//   rewrite  a text the reviewer flagged, rewritten: Claude Sonnet 5.5
//   review   "does this sound like a bot, does it say more than its facts":
//            Claude Sonnet 5.5. Measured on the same drafts, Haiku scored
//            nearly every text 1 and found no fact problems, where Sonnet and
//            Opus both flagged the same stock lines and the same unsupported
//            claims. The review is the only check of the sentence around a
//            quoted number, so it gets the model that can do it; Opus found
//            nothing Sonnet missed, at twice the price.
//   judge    sorting and scoring: sources in onboarding, a trend's format: Claude Haiku 5.5
// Each is overridable in .env, because the right split is a question for the
// numbers, not for code.

export const ROLES = {
  draft: () => process.env.MODEL_DRAFT || 'claude-sonnet-5-5',
  rewrite: () => process.env.MODEL_REWRITE || process.env.MODEL_DRAFT || 'claude-sonnet-5-5',
  review: () => process.env.MODEL_REVIEW || 'claude-sonnet-5-5',
  judge: () => process.env.MODEL_JUDGE || 'claude-haiku-5-5',
};

// TWO BACKENDS, ONE INTERFACE. Every model call goes through askJson() below to
// a client with json(req):
//   claude-cli  the Claude Code CLI, headless, on the owner's subscription
//               (cli.js): what development runs on, at no cost per call
//   api         the Anthropic API through the official SDK, with the Message
//               Batches API and prompt caching (claude.js, batch.js): production
// and, for tests and the demo, the recorded client (recorded.js).
//
// OF_ENV picks: `dev` (the default: a laptop) runs on claude-cli, `prod` (set by
// the VPS's service unit) on the api. In dev, every API request is refused unless
// the command was given --allow-api, and each refusal is written to
// $OF_HOME/logs/api-refusals.log: development never spends API money by accident.
// OF_LLM forces one backend (recorded, claude-cli or api); an api forced in dev is
// still refused without --allow-api.

/** dev or prod. */
export const ofEnv = (env = process.env) => (String(env.OF_ENV || '').trim().toLowerCase() === 'prod' ? 'prod' : 'dev');

/** Was the command given --allow-api? */
export const allowApiFlag = (argv = process.argv) => argv.includes('--allow-api');

export class ApiRefused extends ClaudeError {
  constructor(what) {
    super(`refused in development: ${what} would call the Anthropic API. Run the command with --allow-api to allow it, or set OF_ENV=prod`, 'api_refused');
    this.name = 'ApiRefused';
  }
}

/** Write one refusal to the log, and say it. */
export function logRefusal(what, env = process.env, argv = process.argv) {
  const line = `${new Date().toISOString()}	${what}	${argv.slice(1).map((a) => path.basename(a)).join(' ').slice(0, 200)}
`;
  try {
    appendFileSync(path.join(ensureDir(path.join(ofHome(env), 'logs')), 'api-refusals.log'), line);
  } catch {
    /* the refusal stands without its log line */
  }
  console.warn(`API call refused (dev): ${what}`);
}

/**
 * The check every API request passes first: in dev without --allow-api it logs
 * the refusal and throws ApiRefused; in prod, or with the flag, it does nothing.
 */
export function apiGate({ env = process.env, allowApi = allowApiFlag() } = {}) {
  return (what) => {
    if (ofEnv(env) === 'prod' || allowApi) return;
    logRefusal(what, env);
    throw new ApiRefused(what);
  };
}

/** Which backend a context gets: 'recorded', 'claude-cli' or 'api'. */
export function llmBackend(env = process.env) {
  const forced = String(env.OF_LLM || '').trim().toLowerCase();
  if (['recorded', 'claude-cli', 'api'].includes(forced)) return forced;
  if (ofEnv(env) === 'prod') return isSet('ANTHROPIC_API_KEY', env) ? 'api' : 'recorded';
  return 'claude-cli';
}

/** The model client for this environment (see above). */
export function makeLlm(env = process.env, { allowApi = allowApiFlag(), cli = {} } = {}) {
  const backend = llmBackend(env);
  if (backend === 'recorded') return recordedClient();
  if (backend === 'claude-cli') return cliClient({ env, ...cli });
  return claudeClient({ apiKey: env.ANTHROPIC_API_KEY, workspaceId: env.ANTHROPIC_WORKSPACE_ID, gate: apiGate({ env, allowApi }) });
}

/**
 * Tokens in a string, approximately, for estimates when no usage block exists.
 * Hebrew costs more tokens per character than English; these ratios are a
 * conservative reading of what the current tokenizer does with each.
 */
export function estimateTokens(text) {
  const s = String(text || '');
  const he = (s.match(/[֐-׿]/g) || []).length;
  return Math.ceil(he / 2.2 + (s.length - he) / 3.6);
}

export function estimateUsd(model, inTokens, outTokens) {
  const r = MODEL_RATES[model] || WORST;
  return (inTokens * r.in + outTokens * r.out) / 1e6;
}

const textOf = (system) => (Array.isArray(system) ? system.map((b) => b?.text || '').join('\n') : String(system || ''));

/**
 * Ask for JSON. ctx: { db, pack, postId, llm }. req: { task, system, user, schema,
 * role, effort, maxTokens, image, meta, tag }.
 *
 * After the call, its real cost from the usage block is recorded (ledger.js), at
 * the batch rate when it went through a batch (the batcher records its own, and
 * says so with `settled`). A recorded answer has no usage block; it is recorded
 * as the estimate of what that exact prompt and answer would have cost, and
 * flagged as an estimate.
 */
export async function askJson(ctx, req) {
  const model = req.model || ROLES[req.role || 'draft']();
  const params = requestParams({ ...req, model });
  if (ctx.llm.backend === 'claude-cli') return askCli(ctx, req, { model, params });
  const batch = Boolean(ctx.llm.batch);
  const tag = req.tag || req.task;
  const row = { accountId: ctx.pack?.id ?? null, postId: ctx.postId, api: 'claude', tag, batch };

  let res;
  try {
    res = await ctx.llm.json({ ...req, model, params, meta: { ...(req.meta || {}), model, postId: ctx.postId, accountId: ctx.pack?.id ?? null } });
  } catch (e) {
    // A failed call that was billed (a refusal, a cut-off answer) still cost money.
    if (!e.settled && e.usage) record(ctx.db, { ...row, model: e.model || model, usd: claudeCost(e.usage, e.model || model, { batch }), usage: e.usage });
    throw e;
  }
  if (res.settled) return { data: res.data, usd: res.usd, estimated: false, model: res.model || model, usage: res.usage };
  let usd;
  if (res.usage) usd = claudeCost(res.usage, res.model || model, { batch });
  else {
    // A recorded answer: thinking and the answer, estimated from the answer's length.
    const inTokens = estimateTokens(textOf(req.system)) + estimateTokens(req.user) + estimateTokens(JSON.stringify(req.schema)) / 3 + (req.image ? 1600 : 0);
    usd = estimateUsd(model, inTokens, estimateTokens(JSON.stringify(res.data)) * 2.5);
  }
  record(ctx.db, { ...row, model: res.model || model, usd, estimated: res.estimated, usage: res.usage || null });
  return { data: res.data, usd, estimated: res.estimated, model: res.model || model, usage: res.usage || null };
}

/**
 * A call answered by the Claude Code CLI: nothing is spent (the
 * subscription pays), and the row records its tokens and what it would cost
 * through the API, for the forecast. The share of the prompt that production
 * reads from the cache is the system prefix's share of the request's bytes.
 */
async function askCli(ctx, req, { model, params }) {
  const tag = req.tag || req.task;
  const res = await ctx.llm.json({ ...req, model, params, meta: { ...(req.meta || {}), model, postId: ctx.postId, accountId: ctx.pack?.id ?? null } });
  const sys = Buffer.byteLength(systemText(params));
  const user = Buffer.byteLength(JSON.stringify(params.messages));
  const cachedShare = sys / Math.max(1, sys + user);
  const served = res.model || model;
  // When the CLI's own schema check sent the answer back, its usage adds up every round; production's
  // structured output answers in one request, so the API price is the last request's.
  const rounds = res.usage?.iterations || [];
  const last = rounds.length > 1 ? rounds.at(-1) : res.usage || {};
  const price = apiEquivalent(last, served, { cachedShare, batch: true });
  record(ctx.db, {
    accountId: ctx.pack?.id ?? null, postId: ctx.postId, api: 'claude-cli', model: served, usd: 0, tag, batch: false,
    usage: { ...(res.usage || {}), cachedShare: Number(cachedShare.toFixed(3)), listUsd: price.list, image: Boolean(req.image), cliRounds: Math.max(1, rounds.length), priced: { input: (last.input_tokens || 0) + (last.cache_creation_input_tokens || 0) + (last.cache_read_input_tokens || 0), output: last.output_tokens || 0 } }, apiUsd: price.prod,
  });
  return { data: res.data, usd: 0, apiUsd: price.prod, estimated: false, model: served, usage: res.usage || null };
}
