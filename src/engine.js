import { isSet, loadEnv } from './core/env.js';
import { openDb } from './db/index.js';
import { allowApiFlag, apiGate, makeLlm, ofEnv } from './llm/index.js';
import { claudeBatchApi } from './llm/claude.js';
import { liveSources, recordedSources } from './sources/index.js';
import { loadAll, lookGroups, syncAccounts } from './packs/load.js';

// The engine's working context, built once per process: the database, the
// packs, the model client, and how sources are read.
//
// MODE. 'live' reads the real sources and calls Claude; 'recorded' reads each
// pack's recordings and answers drafting calls from them, so the whole engine
// runs offline. Live is the default when there is a model to call: in development
// the Claude Code CLI, in production the API key. OF_MODE overrides either way.
// The two halves never mix: a recorded draft is keyed to a recorded document.
//
// THE MODEL. src/llm/index.js picks the backend by OF_ENV: the CLI in dev, the
// API in prod (with its Message Batches API), and refuses the API in dev unless
// the command was run with --allow-api.

export function engineMode(env = process.env) {
  if (env.OF_MODE === 'live' || env.OF_MODE === 'recorded') return env.OF_MODE;
  if (ofEnv(env) === 'dev') return 'live';
  return isSet('ANTHROPIC_API_KEY', env) ? 'live' : 'recorded';
}

export function makeContext({ db = null, packs = null, mode = null, log = (m) => console.log(m), env = process.env, allowApi = allowApiFlag() } = {}) {
  loadEnv(env);
  const m = mode || engineMode(env);
  const database = db || openDb();
  // A customer's accounts are kept apart from each other, the operator's from each other (lookGroups).
  const all = packs || loadAll({ groupOf: lookGroups(database) });
  syncAccounts(database, all);
  const live = liveSources();
  const recorded = new Map();
  const llm = makeLlm({ ...env, OF_LLM: m === 'recorded' ? 'recorded' : env.OF_LLM }, { allowApi });
  return {
    db: database,
    packs: all,
    mode: m,
    log,
    llm,
    // The day's drafts go through the Message Batches API when the API is the backend
    // (production); the CLI answers one call at a time.
    batchApi: llm.backend === 'api' ? claudeBatchApi({ apiKey: env.ANTHROPIC_API_KEY, workspaceId: env.ANTHROPIC_WORKSPACE_ID, gate: apiGate({ env, allowApi }) }) : null,
    sourcesFor(pack) {
      if (m === 'live') return live;
      if (!recorded.has(pack.id)) recorded.set(pack.id, recordedSources(pack));
      return recorded.get(pack.id);
    },
    pack(id) {
      return this.packs.find((p) => p.id === id) || null;
    },
    /** Read the packs again (a new account from onboarding) and sync the database. */
    reloadPacks() {
      this.packs = loadAll({ groupOf: lookGroups(this.db) });
      syncAccounts(this.db, this.packs);
      return this.packs;
    },
  };
}
