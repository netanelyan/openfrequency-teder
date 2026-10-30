import { existsSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { dataDir, mediaDir, ofHome, outDir, packsDir } from '../core/paths.js';
import { nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { fromWebsite } from './demos.js';
import { deleteProfile, disconnectAccount, zernioConfigured } from '../publish/zernio.js';
import { queueRemovals, zernioOf } from '../billing/retention.js';

// POST /internal/workspaces/<id>/delete: a customer deleted their workspace in openfrequency-accounts, and accounts asks
// Teder to forget it. Under the checks /internal/setup has (src/web/demos.js fromWebsite): this machine only, the bearer
// OF_INTERNAL_TOKEN, nothing that came through Caddy. Accounts waits 10 seconds and aborts the whole deletion on any
// failure, so the answer comes from what is fast and certain, and the slow part follows it:
//
//   before the answer   every account of the workspace paused, then its rows deleted in one transaction: the posts and
//                       their slides, facts, steps and numbers, the sources and their documents, the topics, rivals,
//                       sounds, formats, feedback, notifications, the new-account flows, the browsers that asked for
//                       notifications, the WhatsApp assistant's queue and choices, the email choices and the settings
//                       kept per account; the pack folders (so nothing reads them back in), and the engine's packs
//   after it            the rendered slides and their public copies and what dry publishing wrote; on Zernio, each
//                       TikTok and Instagram connected into the account's own profile disconnected from our team, then
//                       the profile removed (Zernio bills per connected account). An account typed into pack.json by
//                       hand is not disconnected: it may be the operator's own. What Zernio did not do (an error, or no
//                       key on this server) is kept and tried again every day until it is done (src/billing/retention.js
//                       REMOVALS), and is in the audit entry (workspace_cleaned) and the log, for the operator.
//
// What stays is ours: the audit log, what the calls cost (spend) and what Zernio billed (zernio_costs), which name the
// account by its id and nothing else. The audit rows of the deleted accounts lose who did each thing (a person's name or
// email becomes "deleted") and their details (niches, addresses, handles, quoted facts); the overall daily summaries
// lose the lines that named the accounts. A workspace with nothing left (asked twice, or never seen) answers 200 with
// zeros.
//
//   200 { ok: true, deleted: { accounts, posts, sources, documents, onboarding, connections }, after: { files, zernio } }
//
// `after` is what was left to do once the answer went: files to remove, Zernio accounts and profiles to remove.

/** Rows that are the operator's books, not the customer's data: kept, by account id alone. */
const KEPT = new Set(['accounts', 'audit', 'spend', 'zernio_costs']);

/** The clean-ups still running, for the tests to wait on. */
const running = new Set();
export const workspaceCleanups = () => Promise.all([...running]);

/** Inside the private folder, and not the folder itself: the only paths ever removed. */
function inHome(target) {
  if (!target) return null;
  const home = path.resolve(ofHome());
  const p = path.resolve(target);
  return p !== home && p.startsWith(home + path.sep) ? p : null;
}

/** The tables with an account_id column, read from the database itself so a table added later is not forgotten. */
const accountTables = (db) =>
  db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((r) => r.name)
    .filter((t) => db.all(`PRAGMA table_info(${t})`).some((c) => c.name === 'account_id'));

/**
 * Delete one workspace's accounts and everything that is theirs. `ctx` is the engine's (every pack). Returns
 * { body, cleanup }: the answer, and the promise of what follows it (never rejects).
 */
export function deleteWorkspace(ctx, workspaceId, { log = ctx.log } = {}) {
  const { db } = ctx;
  const rows = db.all('SELECT id, zernio_profile_id FROM accounts WHERE workspace_id = ?', workspaceId);
  const ids = rows.map((r) => r.id);
  const deleted = { accounts: ids.length, posts: 0, sources: 0, documents: 0, onboarding: 0, connections: 0 };

  // ---- what follows the answer, read before the rows go: the files, and what we connected on Zernio
  const media = ctx.mediaDir || mediaDir();
  const publicDir = path.join(dataDir(), 'public');
  const publicCopies = ids.length && existsSync(publicDir) ? readdirSync(publicDir) : [];
  const files = new Set();
  for (const r of rows) {
    for (const p of db.all('SELECT id, media_json FROM posts WHERE account_id = ?', r.id)) {
      for (const list of Object.values(j(p.media_json, {}) || {})) for (const f of Array.isArray(list) ? list : []) files.add(f);
      files.add(path.join(media, 'posts', p.id));
      for (const d of publicCopies.filter((n) => n.startsWith(`${p.id}-`))) files.add(path.join(publicDir, d));
    }
    files.add(path.join(outDir(), 'published', r.id));
  }
  // What it connected on Zernio, its accounts' and what a new account's onboarding connected before its account existed
  // (src/publish/connect.js), unless an account took that profile over.
  const zernio = zernioOf(db, workspaceId).map(({ onboarding, ...z }) => z);
  // The names the overall daily summaries gave the accounts, read before the rows go.
  const names = ids.map((id) => db.get('SELECT display_name FROM accounts WHERE id = ?', id)?.display_name).filter(Boolean);

  // ---- 1. nothing more is written or published for it, then its rows go, children before their parents
  db.tx(() => {
    if (!ids.length) {
      // Nothing of it but what hangs off the workspace itself (an onboarding begun, a browser): that goes too.
      deleted.onboarding = db.run('DELETE FROM onboarding WHERE workspace_id = ?', workspaceId).changes;
      for (const t of ['push_subs', 'assistant_events', 'assistant_prefs']) db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, workspaceId);
      return;
    }
    for (const id of ids) db.update('accounts', id, { status: 'paused', paused_reason: 'manual', paused_detail: 'the workspace was deleted', paused_at: nowIso(), updated_at: nowIso() });
    const inIds = `(${ids.map(() => '?').join(', ')})`;
    deleted.posts = db.get(`SELECT COUNT(*) AS n FROM posts WHERE account_id IN ${inIds}`, ...ids).n;
    deleted.sources = db.get(`SELECT COUNT(*) AS n FROM sources WHERE account_id IN ${inIds}`, ...ids).n;
    deleted.connections = db.get(`SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id IN ${inIds}`, ...ids).n;
    for (const t of accountTables(db).filter((x) => !KEPT.has(x) && !['posts', 'sources'].includes(x))) db.run(`DELETE FROM ${t} WHERE account_id IN ${inIds}`, ...ids);
    db.run(`DELETE FROM posts WHERE account_id IN ${inIds}`, ...ids); // slides, facts, steps and metrics go with them
    deleted.documents = db.run(`DELETE FROM documents WHERE source_id IN (SELECT id FROM sources WHERE account_id IN ${inIds})`, ...ids).changes;
    db.run(`DELETE FROM sources WHERE account_id IN ${inIds}`, ...ids);
    deleted.onboarding = db.run(`DELETE FROM onboarding WHERE workspace_id = ? OR pack_id IN ${inIds}`, workspaceId, ...ids).changes;
    for (const t of ['push_subs', 'assistant_events', 'assistant_prefs']) db.run(`DELETE FROM ${t} WHERE workspace_id = ?`, workspaceId);
    // The settings kept per workspace (the payment answer, the email choices and what was sent) and per account.
    db.run("DELETE FROM settings WHERE key = ? OR key = ? OR key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'", `entitlement:${workspaceId}`, `email:prefs:${workspaceId}`, `email:sent:%:${workspaceId}:%`, `email:sent:%:${workspaceId}`);
    for (const id of ids) {
      const like = id.replace(/[\\%_]/g, (c) => `\\${c}`);
      db.run("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\'", `%:${like}`, `%:${like}:%`);
    }
    db.run("DELETE FROM settings WHERE key = ?", `stopped:${workspaceId}`);
    // Our books keep what happened, never who it was or what it said: the person and the details go.
    db.run(`UPDATE audit SET actor = CASE WHEN actor IN ('engine', 'accounts') OR actor LIKE 'engine:%' THEN actor ELSE 'deleted' END, detail_json = NULL WHERE account_id IN ${inIds}`, ...ids);
    if (names.length) {
      for (const s of db.all('SELECT day, text FROM summaries WHERE account_id IS NULL')) {
        const kept = String(s.text).split('\n').filter((line) => !names.some((n) => line.startsWith(`${n}:`)));
        if (kept.join('\n') !== s.text) db.run('UPDATE summaries SET text = ? WHERE day = ? AND account_id IS NULL', kept.join('\n') || 'אין חשבונות פעילים', s.day);
      }
    }
    db.run(`DELETE FROM accounts WHERE id IN ${inIds}`, ...ids);
  });

  // ---- 2. the pack folders now, small and quick (a reload must not find them and bring the accounts back), and the
  // engine forgets the packs: nothing of them is listed, found or ticked again
  for (const id of ids) {
    const pack = ctx.pack(id);
    const dir = inHome(pack?.dir && path.resolve(pack.dir).startsWith(path.resolve(packsDir()) + path.sep) ? pack.dir : path.join(packsDir(), id));
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  const gone = new Set(ids);
  ctx.packs = ctx.packs.filter((p) => !gone.has(p.id));
  if (ids.length) {
    audit(db, { actor: 'accounts', action: 'workspace_deleted', detail: { workspace: workspaceId, accounts: ids, deleted } });
    log?.(`[workspace delete] workspace ${workspaceId}: ${ids.join(', ')} deleted (${deleted.posts} posts); ${files.size} files and ${zernio.length} on Zernio to go`);
  }

  // ---- 3. after the answer: the files, then Zernio. Never rejects.
  const cleanup = (async () => {
    const out = { files: 0, zernio: { removed: 0, failed: 0 } };
    for (const f of files) {
      const p = inHome(f);
      if (!p || !existsSync(p)) continue;
      try {
        await rm(p, { recursive: true, force: true, maxRetries: 3 });
        out.files++;
      } catch (e) {
        log?.(`[workspace delete] ${workspaceId}: ${p} not removed: ${e.message}`);
      }
    }
    const left = [];
    if (zernio.length && zernioConfigured()) {
      // The accounts first: a profile with an account still in it may be refused.
      for (const z of [...zernio.filter((x) => x.kind === 'account'), ...zernio.filter((x) => x.kind === 'profile')]) {
        try {
          await (z.kind === 'account' ? disconnectAccount(z.id) : deleteProfile(z.id));
          out.zernio.removed++;
        } catch (e) {
          out.zernio.failed++;
          left.push(z);
          log?.(`[workspace delete] ${workspaceId} ${z.account}: Zernio did not remove ${z.kind} ${z.id}${z.platform ? ` (${z.platform})` : ''}: ${e.message}`);
        }
      }
    } else left.push(...zernio);
    // Tried again every day until Zernio does it (src/billing/retention.js).
    if (left.length) queueRemovals(db, left.map((z) => ({ ...z, workspace: workspaceId, reason: 'deleted' })));
    if (ids.length || zernio.length) audit(db, { actor: 'accounts', action: 'workspace_cleaned', detail: { workspace: workspaceId, ...out, left: zernio.length && !zernioConfigured() ? zernio.map((z) => `${z.kind}:${z.id}`) : [] } });
    return out;
  })().catch((e) => log?.(`[workspace delete] ${workspaceId}: ${e.stack || e.message}`));
  running.add(cleanup);
  cleanup.finally(() => running.delete(cleanup));

  return { body: { ok: true, deleted, after: { files: [...files].filter((f) => inHome(f) && existsSync(f)).length, zernio: zernio.length } }, cleanup };
}

/** POST /internal/workspaces/<id>/delete. Returns [status, body]; what follows the answer runs on its own. */
export function workspaceDeleteRoute(ctx, req, env, rawId) {
  if (!fromWebsite(req, env)) return [403, { ok: false, error: 'forbidden' }];
  const workspaceId = /^[1-9]\d{0,9}$/.test(String(rawId)) ? Number(rawId) : null;
  if (!Number.isSafeInteger(workspaceId)) return [400, { ok: false, error: 'bad_workspace' }];
  return [200, deleteWorkspace(ctx, workspaceId).body];
}
