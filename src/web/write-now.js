// "לכתוב פוסט עכשיו": one post written now for an account, the way the runner writes one for a slot, at the account's
// next free slot, waiting for approval like any other. The operator's alone, in developer mode on the accounts page
// (the owner, 2026-11-07: "i want some opening posts for openfrequency. any way to generate them? maybe a developer
// code?"): it fills a new account's grid before its first day, and each press is one post's cost on the project's key.
// One at a time an account; what it made, or what stopped it, is in the post's trace and the log.

import { audit } from '../core/store.js';
import { nextFreeSlot } from '../autonomy/runner.js';
import { buildPost } from '../pipeline/build.js';
import { ActionError } from './actions.js';

const writing = new Map();

/** Whether a post is being written now for this account. */
export const writingNow = (accountId) => writing.has(accountId);

/** The job of the press, for the tests to wait on. */
export const writeNowJob = (accountId) => writing.get(accountId) || Promise.resolve();

export function writeNowRoutes() {
  return [
    [
      'POST',
      /^\/accounts\/([\w-]+)\/write$/,
      (ctx, user, m) => {
        if (!user.operator) throw new ActionError('אין חשבון כזה', 404);
        const e = ctx.global || ctx;
        const pack = e.pack(m[1]);
        if (!pack) throw new ActionError('אין חשבון כזה', 404);
        const back = '/accounts';
        if (writing.has(pack.id)) return { ok: true, message: 'כבר כותבים פוסט לחשבון הזה. אחריו אפשר ללחוץ שוב.', redirect: back };
        const slotAt = nextFreeSlot(e.db, pack);
        audit(e.db, { actor: user.name, action: 'write_now', accountId: pack.id, detail: { slotAt } });
        const build = e.writeNowBuild || buildPost;
        const job = (async () => {
          try {
            const res = await build(e, { pack, slotAt });
            e.log?.(`[write-now] ${pack.id}: ${res.status}${res.reason ? ` (${res.reason})` : ''}`);
          } catch (err) {
            e.log?.(`[write-now] ${pack.id}: ${err.message}`);
          }
        })().finally(() => writing.delete(pack.id));
        writing.set(pack.id, job);
        return { ok: true, message: 'כותבים פוסט חדש. בעוד כמה דקות הוא יחכה לאישור בבית.', redirect: back };
      },
    ],
  ];
}
