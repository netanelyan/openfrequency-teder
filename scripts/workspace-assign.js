#!/usr/bin/env node
// npm run workspace:assign -- --list
// npm run workspace:assign -- --workspace <id> <account> [<account> ...] --dry-run
// npm run workspace:assign -- --workspace <id> <account> [<account> ...] [--move]
//
// Puts accounts (packs) in an openfrequency-accounts workspace: the people of that workspace see them in Teder,
// nobody else does (src/web/workspace.js). The id is the workspace's number in accounts (the superadmin console,
// or `workspace.id` in /internal/session).
//
//   --list      every account and the workspace it is in, "ours" beside a workspace OF_OWN_WORKSPACES names (the
//               company's own: its accounts are the operator's, src/billing/own.js). Reads only.
//   --dry-run   what would change, and nothing else: the database is opened read-only, not even migrated.
//   --move      also move an account that is already in another workspace (without it, that is refused: it
//               would take the account, and everything in it, away from that workspace's people).
//
// A real run needs a backup from the last 24 hours (npm run backup), changes all the accounts named or none, and
// writes each change to the audit log.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, dbPath, requireHome } from '../src/core/paths.js';
import { loadEnv } from '../src/core/env.js';
import { ownWorkspace } from '../src/billing/own.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const usage = () => {
  console.error('usage: npm run workspace:assign -- --list\n       npm run workspace:assign -- --workspace <id> <account> [<account> ...] [--dry-run] [--move]');
  process.exit(2);
};

requireHome();
loadEnv();
const file = dbPath();
if (!existsSync(file)) {
  console.error(`no database at ${file}`);
  process.exit(1);
}

const wsAt = args.indexOf('--workspace');
const workspace = wsAt >= 0 ? Number(args[wsAt + 1]) : null;
const names = args.filter((a, i) => !a.startsWith('--') && i !== wsAt + 1);
const where = (w) => (w == null ? 'no workspace' : `workspace ${w}`);

/** The accounts as they are, from a read-only handle: no migration, no write. */
function readOnly() {
  const db = new DatabaseSync(file, { readOnly: true });
  const has = db.prepare('PRAGMA table_info(accounts)').all().some((c) => c.name === 'workspace_id');
  const rows = db.prepare(`SELECT id, display_name, status${has ? ', workspace_id' : ''} FROM accounts ORDER BY id`).all().map((r) => ({ ...r, workspace_id: has ? r.workspace_id : null }));
  db.close();
  return { has, rows };
}

if (flag('list')) {
  const { has, rows } = readOnly();
  if (!has) console.log('(the workspace column does not exist yet: it is added when the new Teder first opens the database)');
  for (const r of rows) console.log(`${r.id.padEnd(24)} ${`${where(r.workspace_id)}${ownWorkspace(r.workspace_id) ? ', ours' : ''}`.padEnd(22)} ${r.status}  ${r.display_name}`);
  process.exit(0);
}

if (!Number.isInteger(workspace) || workspace < 1 || !names.length) usage();
for (const n of names) if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) usage();

/** What would change, given the accounts as they are. Problems stop a real run before anything is written. */
function plan(rows) {
  const by = new Map(rows.map((r) => [r.id, r]));
  const changes = [];
  const problems = [];
  for (const id of new Set(names)) {
    const r = by.get(id);
    if (!r) problems.push(`${id}: no such account`);
    else if (r.workspace_id === workspace) changes.push({ id, from: r.workspace_id, same: true });
    else if (r.workspace_id != null && !flag('move')) problems.push(`${id}: already in ${where(r.workspace_id)}; add --move to take it to ${where(workspace)}`);
    else changes.push({ id, from: r.workspace_id, same: false });
  }
  return { changes, problems };
}

const print = ({ changes, problems }) => {
  for (const c of changes) console.log(c.same ? `  ${c.id}: already in ${where(workspace)}` : `  ${c.id}: ${where(c.from)} -> ${where(workspace)}`);
  for (const p of problems) console.log(`  REFUSED ${p}`);
};

if (flag('dry-run')) {
  const { has, rows } = readOnly();
  console.log(`dry run on ${file} (opened read-only; nothing is written)`);
  if (!has) console.log('  the workspace column does not exist yet: the real run adds it first (the migration), then:');
  const p = plan(rows);
  print(p);
  const others = rows.filter((r) => !names.includes(r.id));
  if (others.length) console.log(`  not named, left as they are: ${others.map((r) => `${r.id} (${where(r.workspace_id)})`).join(', ')}`);
  console.log(p.problems.length ? 'a real run would refuse: fix the lines marked REFUSED' : `a real run would change ${p.changes.filter((c) => !c.same).length} account(s)`);
  process.exit(p.problems.length ? 1 : 0);
}

// ---- the real run
const backups = existsSync(backupsDir()) ? readdirSync(backupsDir()).filter((f) => f.startsWith('openfrequency-') && f.endsWith('.db')).map((f) => path.join(backupsDir(), f)) : [];
const fresh = backups.map((f) => ({ f, at: statSync(f).mtimeMs })).filter((b) => Date.now() - b.at < 24 * 3_600_000).sort((a, b) => b.at - a.at)[0];
if (!fresh) {
  console.error('no backup from the last 24 hours in ' + backupsDir() + ': run `npm run backup` first');
  process.exit(1);
}
console.log(`backup: ${fresh.f}`);

const { openDb } = await import('../src/db/index.js');
const { audit } = await import('../src/core/store.js');
const db = openDb(); // runs the migrations: the workspace column exists from here on
const p = plan(db.all('SELECT id, display_name, status, workspace_id FROM accounts ORDER BY id'));
print(p);
if (p.problems.length) {
  console.error('nothing changed');
  process.exit(1);
}
db.tx(() => {
  for (const c of p.changes.filter((x) => !x.same)) {
    db.run('UPDATE accounts SET workspace_id = ?, updated_at = ? WHERE id = ?', workspace, new Date().toISOString(), c.id);
    audit(db, { actor: 'workspace:assign', action: 'workspace_assigned', accountId: c.id, detail: { from: c.from, to: workspace } });
  }
});
console.log(`done: ${p.changes.filter((c) => !c.same).length} account(s) in ${where(workspace)}`);
