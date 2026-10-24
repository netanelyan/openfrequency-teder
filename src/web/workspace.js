// One workspace's Teder. Accounts (openfrequency-accounts) says which workspace a session is in; every account
// (pack) here belongs to one workspace (accounts.workspace_id), and everything else hangs off an account: its posts,
// sources, facts, topics, rivals, sounds, spend and notifications.
//
// A request in a workspace gets a context whose packs and pack() are that workspace's alone. Every page and every
// button reads accounts through them, so an account of another workspace is simply not there: not listed, not
// found by id, not switched to. A row found by its own id (a post, a source, a takedown) is checked against them
// too, before it is shown or changed (ownPost and the like, in actions.js and data.js).
//
// The operator (the superadmin outside view-as) gets the context as it is: every account, every workspace, and the
// settings that are the whole server's (the kill switch, when posts are written, each account's plan).

export const workspaceOfAccount = (db, accountId) => db.get('SELECT workspace_id FROM accounts WHERE id = ?', accountId)?.workspace_id ?? null;

/** The account ids of one workspace. */
export const accountIdsOf = (db, workspaceId) => new Set(db.all('SELECT id FROM accounts WHERE workspace_id = ?', workspaceId).map((r) => r.id));

/** The context seen from one workspace. `ctx` is the engine's (every pack); the result shadows packs and pack(). */
export function forWorkspace(ctx, workspaceId) {
  if (!Number.isInteger(workspaceId)) throw new Error('forWorkspace needs a workspace id');
  const w = Object.create(ctx);
  const read = () => {
    const ids = accountIdsOf(ctx.db, workspaceId);
    return ctx.packs.filter((p) => ids.has(p.id));
  };
  w.workspaceId = workspaceId;
  w.global = ctx;
  w.packs = read();
  w.pack = (id) => w.packs.find((p) => p.id === id) || null;
  // A new account from onboarding: the engine reads every pack again, and this workspace sees its own.
  w.reloadPacks = () => {
    ctx.reloadPacks();
    w.packs = read();
    return w.packs;
  };
  return w;
}

/** May this context see this account's rows? A workspace only its own; the operator every one, even an account whose pack is gone. */
export const owns = (ctx, accountId) => (ctx.workspaceId == null ? true : Boolean(accountId) && Boolean(ctx.pack(accountId)));
