// The company's own workspaces: OF_OWN_WORKSPACES, openfrequency-accounts' workspace ids, comma-separated (empty: none).
//
// Our own accounts are put in a workspace of accounts (`npm run workspace:assign`) so that the people of that workspace
// see them in Teder. That makes them accounts in a workspace, and every rule the code keeps for a customer's accounts
// would then hold for ours. An account in a workspace named here is the operator's, exactly as an account in no
// workspace is, for every rule that is a customer's:
//
//   - approval and TikTok drafts: the mode and the TikTok choice stored for it stand, and only the operator sets them
//     (src/autonomy/rails.js isCustomerAccount and autonomyMode, src/publish/index.js tiktokMode)
//   - the plan: a month of its own, the default or the operator's numbers (setPlan), never shared with the workspace's
//     other accounts and never thinned to a share (src/budget/quota.js planOf)
//   - the caps on sample rounds and light-edit checks (src/web/onboarding.js sampleRoom, src/web/actions.js)
//   - the paywall: accounts is never asked, and nothing is refused for it, on the website, in the engine, through the
//     WhatsApp assistant or in the owners' emails (src/billing/entitlement.js)
//   - the retention pass's disconnect of a workspace whose Teder stopped: never (src/billing/retention.js)
//
// Who sees what does not change: the workspace's people see its accounts and nobody else does (src/web/workspace.js),
// and its accounts' looks are kept apart among themselves (src/packs/load.js lookGroups). Read from the environment at
// every call, so a restart with a new .env, or a test, changes it.

/** The workspace ids OF_OWN_WORKSPACES names: whole numbers from 1, anything else in it ignored. */
export function ownWorkspaces(env = process.env) {
  const out = new Set();
  for (const part of String(env.OF_OWN_WORKSPACES || '').split(/[\s,]+/)) {
    if (/^[1-9]\d{0,8}$/.test(part)) out.add(Number(part));
  }
  return out;
}

/** Is this workspace one of the company's own? No workspace (null) is not a workspace at all, so no. */
export const ownWorkspace = (workspaceId, env = process.env) => workspaceId != null && ownWorkspaces(env).has(Number(workspaceId));

/** Is this workspace a customer's: a workspace, and not one of ours? The customer rules hold for it alone. */
export const customerWorkspace = (workspaceId, env = process.env) => workspaceId != null && !ownWorkspace(workspaceId, env);
