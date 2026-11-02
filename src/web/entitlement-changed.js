import { markChanged } from '../billing/entitlement.js';
import { internalRefusal } from './demos.js';

// POST /internal/entitlement/changed: openfrequency-accounts says a workspace's access changed (a payment recorded, comp,
// a subscription saved by hand, a cancellation or its undo, a product or the workspace turned off or on; its
// src/web/changed.js), so the answer Teder keeps from GET /internal/entitlement (src/billing/entitlement.js, 5 minutes)
// is marked and the next page or tick asks afresh: a customer who just paid sees Teder on the next page. The contract is
// accounts' docs/contracts/entitlement-changed.json (test/fixtures/contracts here).
//
// Under the checks of src/web/demos.js internalRefusal (503 not_configured, 403 forbidden from anywhere but this machine
// or through Caddy, 401 bad_token), then 405 for another method and 400 bad_workspace, in the contract's order. accounts
// waits 2 seconds and never sends it again, so this is one row read and written, and the answer:
//
//   200 { ok: true, workspace, cleared }     cleared: an answer was kept for it (false: never asked about, or deleted)
//
// `reason` is for the log alone: every one is acted on the same way, one not known too.

export const CHANGED_PATH = '/internal/entitlement/changed';
const BODY_LIMIT = 4096;

/** The JSON body, or null for one that is not an object, or is too large. */
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(c);
  }
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

/**
 * The route. `clients` are the entitlement clients this process asks with (the website's, the runner's): each forgets
 * what it holds in memory for the workspace. Returns [status, body].
 */
export async function entitlementChangedRoute(ctx, req, env, clients = []) {
  const refused = internalRefusal(req, env);
  if (refused) return refused;
  if (req.method !== 'POST') return [405, { error: 'method_not_allowed' }];
  const body = await readBody(req);
  const workspace = body?.workspace;
  if (!Number.isSafeInteger(workspace) || workspace <= 0) return [400, { error: 'bad_workspace' }];
  const reason = typeof body.reason === 'string' && /^[a-z_]{1,20}$/.test(body.reason) ? body.reason : 'unknown';
  const live = [...new Set(clients)].filter((c) => typeof c?.changed === 'function');
  let cleared = false;
  if (live.length) for (const c of live) cleared = c.changed(workspace) || cleared;
  else cleared = markChanged(ctx.db, workspace);
  ctx.log?.(`[entitlement] workspace ${workspace}: accounts says its access changed (${reason})${cleared ? ': asked afresh on the next page or tick' : '; nothing was kept for it'}`);
  return [200, { ok: true, workspace, cleared }];
}
