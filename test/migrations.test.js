import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { Db, SchemaError, migrationSha } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { ROOT } from '../src/core/paths.js';
import { tempHome } from './helpers.js';

// The database and the build must agree on the schema before anything runs (PRA-OPS-005): an older build does not
// start on a database a newer one migrated, and a list renumbered by a merge does not start either.

function withFile(fn) {
  const { home, cleanup } = tempHome();
  try {
    return fn(path.join(home, 'schema.db'));
  } finally {
    cleanup();
  }
}

test('a new database records a checksum for every migration it ran', () => {
  withFile((file) => {
    const db = new Db(file);
    const rows = db.all('SELECT position, sha FROM schema_checks ORDER BY position');
    assert.equal(rows.length, MIGRATIONS.length);
    rows.forEach((r, i) => assert.deepEqual([r.position, r.sha], [i + 1, migrationSha(MIGRATIONS[i])]));
    db.close();
    // Opened again by the same build: nothing to say.
    new Db(file).close();
  });
});

test('a database ahead of this build is refused before anything is touched', () => {
  withFile((file) => {
    new Db(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    assert.throws(() => new Db(file), (e) => e instanceof SchemaError && /newer build/.test(e.message));
  });
});

test('a migration whose text at its position is not the one the database ran is refused: a merge renumbered the list', () => {
  withFile((file) => {
    new Db(file).close();
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE schema_checks SET sha = ? WHERE position = 5').run(migrationSha('-- the entry that used to be fifth'));
    raw.close();
    assert.throws(() => new Db(file), (e) => e instanceof SchemaError && /migration 5 in this build is not the one this database ran/.test(e.message));
  });
});

test('a database from before the check has its migrations recorded as they are, once, and goes on', () => {
  withFile((file) => {
    const raw = new DatabaseSync(file);
    for (let v = 0; v < 10; v++) raw.exec(MIGRATIONS[v]);
    raw.exec('PRAGMA user_version = 10');
    raw.close();
    const db = new Db(file);
    assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_checks').n, MIGRATIONS.length);
    db.close();
  });
});

test('line endings do not change a checksum: a Windows checkout and the server agree', () => {
  assert.equal(migrationSha('CREATE TABLE a (x);\r\nCREATE TABLE b (y);\r\n'), migrationSha('CREATE TABLE a (x);\nCREATE TABLE b (y);\n'));
});

test('scripts/schema-check.js: what deploy and rollback ask before they switch a release, without migrating anything', () => {
  const { home, cleanup } = tempHome();
  try {
    const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'schema-check.js')], { env: { ...process.env, OF_HOME: home }, encoding: 'utf8' });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no database yet/);
    const file = path.join(home, 'data', 'openfrequency.db');
    mkdirSync(path.dirname(file), { recursive: true });
    const raw = new DatabaseSync(file);
    for (let v = 0; v < 5; v++) raw.exec(MIGRATIONS[v]);
    raw.exec('PRAGMA user_version = 5');
    raw.close();
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`ran 5 migration(s), this build knows ${MIGRATIONS.length}, and runs the ${MIGRATIONS.length - 5} new one(s)`), r.stdout);
    const again = new DatabaseSync(file);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 5, 'nothing was migrated');
    again.exec(`PRAGMA user_version = ${MIGRATIONS.length + 2}`);
    again.close();
    r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /made by a newer build/);
  } finally {
    cleanup();
  }
});

test('scripts/backup-check.js: the newest copy is opened and read, and a damaged or missing one fails the backup unit', () => {
  const { home, cleanup } = tempHome();
  try {
    const env = { ...process.env, OF_HOME: home };
    const run = (script, args = []) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { env, encoding: 'utf8' });
    let r = run('backup-check.js');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no backups folder|no database copy/);
    new Db(path.join(home, 'data', 'openfrequency.db')).close();
    assert.equal(run('backup.js').status, 0);
    r = run('backup-check.js');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`is whole (migration ${MIGRATIONS.length}, 0 account(s), 0 post(s)`), r.stdout);
    const dir = path.join(home, 'data', 'backups');
    const newest = readdirSync(dir).filter((f) => f.endsWith('.db')).sort().pop();
    writeFileSync(path.join(dir, newest), 'not a database at all, just bytes');
    r = run('backup-check.js');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not open as a Teder database|is damaged/);
  } finally {
    cleanup();
  }
});
