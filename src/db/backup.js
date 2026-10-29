import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, dbPath, ensureDir, packsDir } from '../core/paths.js';

// The nightly backup (scripts/backup.js, run by deploy/openfrequency-backup.timer): everything under OF_HOME that
// cannot be made again, into $OF_HOME/data/backups/, the newest `keep` of each kept.
//
//   openfrequency-<stamp>.db   the database: a consistent copy while the engine runs (SQLite's VACUUM INTO reads a
//                              snapshot), then opened and checked (PRAGMA integrity_check, and its accounts and posts
//                              counted). A copy that fails the check is removed and the run fails, so a bad night is
//                              a failed unit and not a file nobody can restore.
//   packs-<stamp>/             every account's pack folder: pack.json, theme.json, sources, formats, rules, voice.md,
//                              the facts the customer checked by hand (facts/) and their own photographs (photos/).
//                              Onboarding writes a customer's pack on the server, so the private git repository on the
//                              laptop never has it. Checked by counting the pack.json files on both sides.
//
// Left out on purpose: rendered slides and their public copies, downloaded photographs and the dry runs' output
// (all drawn or fetched again), the logs, and .env. The keys in .env are not copied next to the data they open: keep
// the file somewhere off the server (a password manager), and restore it by hand.
//
// RESTORE, on the server (OF_HOME is /opt/open-frequency/private there), from OF_HOME, with the service stopped
// (systemctl stop openfrequency):
//   1. cp data/backups/openfrequency-<stamp>.db data/openfrequency.db, and remove data/openfrequency.db-wal and -shm
//   2. move packs/ aside and cp -a data/backups/packs-<stamp> packs   (the same <stamp> as the database)
//   3. chown -R openfrequency: data/openfrequency.db packs, then systemctl start openfrequency
// The slides are drawn again when a post needs them. Copying data/backups/ off the server is the off-site step's job.

const STAMP = () => new Date().toISOString().replace(/[:.]/g, '-');

export class BackupError extends Error {}

/**
 * Open a database copy and check it: { ok, problems, accounts, posts }. A copy that is not a whole SQLite file, or
 * whose integrity check says anything but "ok", or that has no accounts table, is not ok.
 */
export function verifyCopy(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
    if (check.length !== 1 || check[0] !== 'ok') return { ok: false, problems: check.slice(0, 10).map(String), accounts: null, posts: null };
    const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
    const posts = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    return { ok: true, problems: [], accounts, posts };
  } catch (e) {
    return { ok: false, problems: [e.message], accounts: null, posts: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* never opened */
    }
  }
}

/** The pack folders under a packs directory: the ones with a pack.json. */
const packCount = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(path.join(dir, n, 'pack.json'))).length : 0);

/** Keep the newest `keep` entries whose name starts with `prefix` (and ends with `suffix`); remove the rest. */
function rotate(dir, prefix, suffix, keep) {
  const all = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(path.join(dir, f), { recursive: true, force: true });
  return Math.min(all.length, keep);
}

/**
 * One backup: the database and the packs. Returns { db, packs, kept, check }. Throws BackupError (after removing what it
 * wrote) when the copy is not whole.
 */
export function backup({ keep = 14, env = process.env } = {}) {
  const dir = ensureDir(backupsDir(env));
  const stamp = STAMP();
  const file = path.join(dir, `openfrequency-${stamp}.db`);
  const live = new DatabaseSync(dbPath(env), { readOnly: true });
  try {
    live.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
  const check = verifyCopy(file);
  if (!check.ok) {
    rmSync(file, { force: true });
    throw new BackupError(`the database copy failed its check: ${check.problems.join('; ')}`);
  }

  const from = packsDir(env);
  const packs = path.join(dir, `packs-${stamp}`);
  if (existsSync(from) && statSync(from).isDirectory()) {
    cpSync(from, packs, { recursive: true, dereference: false, preserveTimestamps: true });
    const want = packCount(from);
    const got = packCount(packs);
    if (got !== want) {
      rmSync(packs, { recursive: true, force: true });
      throw new BackupError(`the packs copy has ${got} of ${want} packs`);
    }
  }

  const kept = { db: rotate(dir, 'openfrequency-', '.db', keep), packs: existsSync(packs) ? rotate(dir, 'packs-', '', keep) : 0 };
  return { db: file, packs: existsSync(packs) ? packs : null, kept, check };
}
