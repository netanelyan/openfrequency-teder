import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dbPath, ensureDir } from '../core/paths.js';
import { MIGRATIONS } from './schema.js';

// One SQLite file holds all state: posts, sources, documents, facts, metrics,
// spend, the audit log. node:sqlite is built into Node (22.13+), so there is no
// native module to compile on the VPS and nothing to install.
//
// Rows that carry structure (a fact list, a check result) keep it as JSON text;
// `json()` and `j()` convert at the edge so callers see objects.

export class Db {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') ensureDir(path.dirname(file));
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      this.migrate();
    } catch (e) {
      this.raw.close();
      throw e;
    }
  }

  /**
   * Run the migrations this database has not had, after two checks that stop the process before it touches anything:
   *   - a database ahead of this build (user_version above MIGRATIONS.length) is refused: an older build would run on
   *     a schema it does not know, which a rollback past a migration does
   *   - each migration already run is recorded by its position and a checksum of its text (schema_checks). One whose
   *     text at that position is now another is refused: a merge that put a new entry in the middle of the list
   *     renumbered it, and this database would skip one migration and run another twice. A database that has no record
   *     yet (every one before this check) has its run migrations recorded as they are, once.
   */
  migrate() {
    const have = this.raw.prepare('PRAGMA user_version').get().user_version;
    const recorded = recordedChecks(this.raw);
    const problem = schemaProblem(have, recorded);
    if (problem) throw new SchemaError(problem);
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_checks (position INTEGER PRIMARY KEY, sha TEXT NOT NULL, at TEXT NOT NULL)');
    const record = this.raw.prepare('INSERT OR REPLACE INTO schema_checks (position, sha, at) VALUES (?, ?, ?)');
    for (let v = 0; v < have; v++) if (!recorded.has(v + 1)) record.run(v + 1, migrationSha(MIGRATIONS[v]), new Date().toISOString());
    for (let v = have; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        record.run(v + 1, migrationSha(MIGRATIONS[v]), new Date().toISOString());
      });
    }
  }

  run(sql, ...params) {
    return this.raw.prepare(sql).run(...params.map(bind));
  }

  get(sql, ...params) {
    return this.raw.prepare(sql).get(...params.map(bind)) || null;
  }

  all(sql, ...params) {
    return this.raw.prepare(sql).all(...params.map(bind));
  }

  /** Run fn inside a transaction; nested calls join the outer one. */
  tx(fn) {
    if (this.inTx) return fn();
    this.inTx = true;
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  /** Insert an object as a row; JSON-encodes objects and arrays. Returns lastInsertRowid. */
  insert(table, row) {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    return Number(this.run(sql, ...keys.map((k) => row[k])).lastInsertRowid);
  }

  update(table, id, patch, key = 'id') {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${key} = ?`, ...keys.map((k) => patch[k]), id);
  }

  close() {
    this.raw.close();
  }
}

/** The database and this build disagree about the schema: the process must not start on it. */
export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** A migration's checksum: its text, with line endings made one (a Windows checkout writes CRLF). */
export const migrationSha = (sql) => createHash('sha256').update(String(sql).replace(/\r\n/g, '\n').trim()).digest('hex');

/** The checksums a database recorded, by position (empty before the first build that records them). */
export function recordedChecks(raw) {
  if (!raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_checks'").get()) return new Map();
  return new Map(raw.prepare('SELECT position, sha FROM schema_checks').all().map((r) => [r.position, r.sha]));
}

/**
 * Why this build may not run on a database that ran `have` migrations, with these checksums recorded by position
 * (Map), or null. Pure: the start of the process (Db.migrate) and scripts/schema-check.js, which deploy/deploy.sh and
 * deploy/rollback.sh run before they switch a release, both ask it.
 */
export function schemaProblem(have, recorded, migrations = MIGRATIONS) {
  if (have > migrations.length) {
    return `the database is at migration ${have} and this build knows ${migrations.length}: it was made by a newer build. Deploy that build again (a rollback cannot go back past a migration), or restore the backup taken before it`;
  }
  for (let v = 0; v < have; v++) {
    const sha = migrationSha(migrations[v]);
    const was = recorded.get(v + 1);
    if (was && was !== sha) {
      return `migration ${v + 1} in this build is not the one this database ran (checksum ${sha.slice(0, 12)}, recorded ${was.slice(0, 12)}): an entry was inserted, removed or edited before it in src/db/schema.js. Put the list back in the order the database ran it, and add new migrations at the end`;
    }
  }
  return null;
}

/** Values node:sqlite will not bind directly. */
function bind(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

/** Parse a JSON column, tolerating null and garbage. */
export function j(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

let shared = null;

/** The process's database, at $OF_HOME/data/openfrequency.db unless a file is given. */
export function openDb(file = null) {
  if (file) return new Db(file);
  shared ??= new Db(dbPath());
  return shared;
}

export function closeDb() {
  shared?.close();
  shared = null;
}
