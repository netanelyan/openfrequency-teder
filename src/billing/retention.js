import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DAY, now, nowIso } from '../core/clock.js';
import { dataDir, mediaDir, ofHome } from '../core/paths.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';
import { israelDate } from '../schedule/israel.js';
import { deleteProfile, disconnectAccount, zernioConfigured } from '../publish/zernio.js';
import { workspaceAllowed } from './entitlement.js';
import { ownWorkspace } from './own.js';

// What Teder keeps, and for how long, as openfrequency.co.il's privacy policy and terms say (openfrequency-web,
// src/pages/legal.mjs, "כמה זמן המידע נשמר"). One pass a day in the runner (retentionPass, step 7), logged with what it
// removed, so the operator can show the policy is kept:
//
//   a store's demo        "פניות מהטופס: 6 חודשים מהפנייה האחרונה" (legal.leadMonths). A demo (src/demos) is a store's
//                         request on the website: its WhatsApp number, its catalogue and its slides. Removed, with its
//                         page's opens and its pictures, LEAD_MONTHS after its last contact: the later of its last
//                         update (a new request for the same store updates it) and the last time its page was opened.
//   TikTok and Instagram  "הרשאות של חשבונות ברשתות: עד שמנתקים אותן, או עד שהשירות נעצר". Once a workspace's Teder has
//                         stopped (accounts' entitlement answer says not allowed, src/billing/entitlement.js stoppedAt),
//                         everything it connected through Zernio is disconnected from our team and its connection rows
//                         go, STOP_GRACE_DAYS after the stop: a payment recorded a day late, or one answer by mistake,
//                         does not cost the customer their connections. The 14 days the terms give a payment that did
//                         not go through ("אם הוא לא הוסדר תוך 14 יום") are accounts' `due`, which is still allowed, so
//                         an unpaid answer means they are over. Their posts, sources and settings stay: the policy
//                         promises nothing about them after a stop, and the customer deletes them by deleting the
//                         workspace (src/web/workspace-delete.js). One of the company's own workspaces
//                         (OF_OWN_WORKSPACES, src/billing/own.js) is never disconnected: its Teder is ours, not sold.
//   Zernio removals       a disconnect or a profile delete Zernio did not do (a delete, or a stop) is kept in settings
//                         (REMOVALS) and tried again every day until Zernio does it or says it is gone. One for a stopped
//                         workspace that has paid again since is dropped: it is theirs again.
//   public slide copies   the copies under data/public that Zernio and Meta fetch a post's slides from are needed for
//                         minutes; removed PUBLIC_KEEP_DAYS after they were made, unless their post is being published.
//
// Nothing else is deleted here: the policy's other periods are sessions and sign-in links (accounts) and invoices
// (seven years, accounts).

export const LEAD_MONTHS = 6;
export const STOP_GRACE_DAYS = 1;
export const PUBLIC_KEEP_DAYS = 3;
export const REMOVALS = 'zernio:removals';

/** The moment `months` calendar months before t. */
const monthsBefore = (t, months) => {
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
};

/** Inside the private folder, and not the folder itself: the only paths ever removed. */
function inHome(target) {
  if (!target) return null;
  const home = path.resolve(ofHome());
  const p = path.resolve(target);
  return p !== home && p.startsWith(home + path.sep) ? p : null;
}

/* ------------------------------------------------------------------ Zernio removals, kept until done */

/**
 * Keep removals Zernio has not done yet: [{ kind: 'account' | 'profile', id, platform?, account, workspace, reason:
 * 'deleted' | 'stopped' }]. Kept once per kind and id.
 */
export function queueRemovals(db, items) {
  const list = getSetting(db, REMOVALS, []) || [];
  const have = new Set(list.map((x) => `${x.kind}:${x.id}`));
  for (const it of items) {
    if (!it?.id || have.has(`${it.kind}:${it.id}`)) continue;
    have.add(`${it.kind}:${it.id}`);
    list.push({ ...it, since: it.since || nowIso(), tries: it.tries || 0 });
  }
  setSetting(db, REMOVALS, list);
  return list.length;
}

/**
 * Try every kept removal once: the accounts first, a profile after them (one with an account still in it may be
 * refused). Returns { removed, failed, dropped, left }. Never throws.
 */
export async function retryRemovals(ctx, { log = ctx.log } = {}) {
  const { db } = ctx;
  const list = getSetting(db, REMOVALS, []) || [];
  const out = { removed: 0, failed: 0, dropped: 0, left: 0 };
  if (!list.length) return out;
  if (!zernioConfigured()) {
    out.left = list.length;
    return out;
  }
  const keep = [];
  for (const it of [...list.filter((x) => x.kind === 'account'), ...list.filter((x) => x.kind !== 'account')]) {
    // A stopped workspace that is allowed again, or one of ours: what it connected is in use.
    if (it.reason === 'stopped' && it.workspace != null && (workspaceAllowed(db, it.workspace) || ownWorkspace(it.workspace))) {
      out.dropped++;
      continue;
    }
    try {
      await (it.kind === 'account' ? disconnectAccount(it.id) : deleteProfile(it.id));
      out.removed++;
    } catch (e) {
      out.failed++;
      keep.push({ ...it, tries: (it.tries || 0) + 1, lastError: String(e.message).slice(0, 200), lastTry: nowIso() });
      log?.(`[retention] Zernio did not remove ${it.kind} ${it.id}${it.platform ? ` (${it.platform})` : ''} of ${it.account}: ${e.message}`);
    }
  }
  setSetting(db, REMOVALS, keep);
  out.left = keep.length;
  if (out.removed || out.dropped) audit(db, { action: 'zernio_removals', detail: { removed: out.removed, dropped: out.dropped, failed: out.failed, left: out.left } });
  return out;
}

/* ------------------------------------------------------------------ what a workspace connected */

/**
 * Everything a workspace has on Zernio: the TikTok and Instagram connected into its accounts' profiles, the profiles,
 * and what its onboardings connected before their account existed (unless an account took that profile over).
 */
export function zernioOf(db, workspaceId) {
  const rows = db.all('SELECT id, zernio_profile_id FROM accounts WHERE workspace_id = ?', workspaceId);
  const out = [];
  for (const r of rows) {
    for (const c of db.all('SELECT platform, zernio_account_id FROM zernio_connections WHERE account_id = ?', r.id)) out.push({ account: r.id, kind: 'account', id: c.zernio_account_id, platform: c.platform });
    if (r.zernio_profile_id) out.push({ account: r.id, kind: 'profile', id: r.zernio_profile_id });
  }
  const taken = new Set(rows.map((r) => r.zernio_profile_id).filter(Boolean));
  for (const o of db.all('SELECT id, setup_json FROM onboarding WHERE workspace_id = ?', workspaceId)) {
    const z = j(o.setup_json, {})?.zernio;
    if (!z?.profileId || taken.has(z.profileId)) continue;
    for (const [platform, c] of Object.entries(z.connections || {})) if (c?.id) out.push({ account: o.id, kind: 'account', id: c.id, platform, onboarding: true });
    out.push({ account: o.id, kind: 'profile', id: z.profileId, onboarding: true });
  }
  return out;
}

/**
 * A workspace whose Teder stopped: disconnect what it connected (kept as removals and tried now), and forget the
 * connections, so its pages say nothing is connected. The profiles stay: an empty folder on our team, which a paying
 * customer connects into again. Returns how many connections went.
 */
function disconnectWorkspace(db, workspaceId, { access }) {
  const items = zernioOf(db, workspaceId).filter((x) => x.kind === 'account');
  queueRemovals(db, items.map((x) => ({ ...x, workspace: workspaceId, reason: 'stopped' })));
  db.tx(() => {
    db.run('DELETE FROM zernio_connections WHERE account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)', workspaceId);
    for (const o of db.all('SELECT id, setup_json FROM onboarding WHERE workspace_id = ?', workspaceId)) {
      const s = j(o.setup_json, {}) || {};
      if (!s.zernio?.connections || !Object.keys(s.zernio.connections).length) continue;
      db.update('onboarding', o.id, { setup_json: { ...s, zernio: { ...s.zernio, connections: {} } }, updated_at: nowIso() });
    }
  });
  audit(db, { action: 'connections_removed', detail: { workspace: workspaceId, connections: items.length, access, why: 'the service stopped (privacy policy)' } });
  return items.length;
}

/**
 * The customers' workspaces whose Teder stopped long enough ago, not yet disconnected for that stop: [{ workspace,
 * access, stoppedAt }]. One of the company's own is never among them, whatever answer is kept for it.
 */
export function stoppedWorkspaces(db, t = now()) {
  const out = [];
  for (const r of db.all("SELECT key, value_json FROM settings WHERE key LIKE 'entitlement:%'")) {
    const ws = Number(r.key.slice('entitlement:'.length));
    const k = j(r.value_json, null);
    if (!Number.isInteger(ws) || ownWorkspace(ws) || !k || k.allowed !== false || !k.stoppedAt) continue;
    if (t - Date.parse(k.stoppedAt) < STOP_GRACE_DAYS * DAY) continue;
    if (getSetting(db, `stopped:${ws}`, null)?.stoppedAt === k.stoppedAt) continue;
    out.push({ workspace: ws, access: k.access, stoppedAt: k.stoppedAt });
  }
  return out;
}

/* ------------------------------------------------------------------ the demos and the public copies */

/** Remove the demos whose last contact is more than LEAD_MONTHS ago, with their opens and pictures. Returns how many. */
async function forgetDemos(ctx, t) {
  const { db } = ctx;
  const cut = new Date(monthsBefore(t, LEAD_MONTHS)).toISOString();
  const old = db.all(
    `SELECT d.id, d.media_json FROM demos d
     WHERE MAX(d.updated_at, d.created_at, COALESCE((SELECT MAX(o.at) FROM demo_opens o WHERE o.demo_id = d.id), '')) < ?`,
    cut
  );
  if (!old.length) return 0;
  const media = ctx.mediaDir || mediaDir();
  const files = [];
  for (const d of old) {
    files.push(path.join(media, 'demos', String(d.id)));
    for (const list of Object.values(j(d.media_json, {}) || {})) for (const f of Array.isArray(list) ? list : typeof list === 'string' ? [list] : []) files.push(f);
  }
  db.tx(() => {
    for (const d of old) {
      db.run('DELETE FROM demo_opens WHERE demo_id = ?', d.id);
      db.run('DELETE FROM demos WHERE id = ?', d.id);
    }
  });
  for (const f of files) {
    const p = inHome(f);
    if (p && existsSync(p)) await rm(p, { recursive: true, force: true, maxRetries: 3 }).catch((e) => ctx.log?.(`[retention] ${p} not removed: ${e.message}`));
  }
  return old.length;
}

/** Remove the public copies of slides made more than PUBLIC_KEEP_DAYS ago, unless their post is being published now. */
async function forgetPublicCopies(ctx, t) {
  const root = path.join(dataDir(), 'public');
  if (!existsSync(root)) return 0;
  const busy = new Set(ctx.db.all("SELECT id FROM posts WHERE status IN ('approved', 'publishing')").map((r) => r.id));
  let n = 0;
  for (const name of readdirSync(root)) {
    const p = inHome(path.join(root, name));
    if (!p) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory() || t - st.mtimeMs < PUBLIC_KEEP_DAYS * DAY) continue;
    // `<post id>-<12 hex>` (src/publish/index.js publicUrls).
    const postId = name.replace(/-[0-9a-f]{12}$/, '');
    if (busy.has(postId)) continue;
    await rm(p, { recursive: true, force: true, maxRetries: 3 }).then(
      () => n++,
      (e) => ctx.log?.(`[retention] ${p} not removed: ${e.message}`)
    );
  }
  return n;
}

/* ------------------------------------------------------------------ the pass */

/**
 * The day's pass (the runner calls it every tick; it works once per Israel day). Returns what it did, or null when it
 * already ran today. Every part is tried even when another fails; the log says what each did.
 */
export async function retentionPass(ctx, { t = now(), force = false } = {}) {
  const { db } = ctx;
  const key = `retention:${israelDate(t)}`;
  if (!force && getSetting(db, key)) return null;
  setSetting(db, key, new Date(t).toISOString());
  const out = { demos: 0, publicCopies: 0, stopped: [], removals: null, errors: [] };
  try {
    out.demos = await forgetDemos(ctx, t);
  } catch (e) {
    out.errors.push(`demos: ${e.message}`);
  }
  try {
    out.publicCopies = await forgetPublicCopies(ctx, t);
  } catch (e) {
    out.errors.push(`public copies: ${e.message}`);
  }
  try {
    for (const s of stoppedWorkspaces(db, t)) {
      const n = disconnectWorkspace(db, s.workspace, s);
      setSetting(db, `stopped:${s.workspace}`, { stoppedAt: s.stoppedAt, disconnectedAt: new Date(t).toISOString(), connections: n });
      out.stopped.push({ workspace: s.workspace, access: s.access, connections: n });
    }
  } catch (e) {
    out.errors.push(`stopped workspaces: ${e.message}`);
  }
  out.removals = await retryRemovals(ctx);
  // An old day's marker is of no use: one row per day would pile up.
  db.run("DELETE FROM settings WHERE key LIKE 'retention:%' AND key < ?", `retention:${israelDate(t - 7 * DAY)}`);
  ctx.log?.(`[retention] ${out.demos} demo(s) past ${LEAD_MONTHS} months removed, ${out.publicCopies} public slide copies removed, ${out.stopped.length} stopped workspace(s) disconnected (${out.stopped.reduce((a, s) => a + s.connections, 0)} connections), Zernio removals: ${out.removals.removed} done, ${out.removals.failed} failed, ${out.removals.left} left${out.errors.length ? `; errors: ${out.errors.join('; ')}` : ''}`);
  if (out.demos || out.publicCopies) audit(db, { action: 'retention', detail: { demos: out.demos, publicCopies: out.publicCopies } });
  return out;
}
