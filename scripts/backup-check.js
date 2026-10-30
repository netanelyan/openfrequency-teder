#!/usr/bin/env node
// node scripts/backup-check.js [--max-age-hours 26]
//
// Is the newest database copy in $OF_HOME/data/backups one we could restore? It is opened read-only and asked:
// SQLite's integrity_check, the schema it is at, and how many accounts and posts it holds. A copy that is missing,
// older than --max-age-hours, damaged, or without those tables fails with exit 1 and says why: the backup unit runs
// this after scripts/backup.js, so a bad copy fails the unit and its OnFailure tells the operator.
//
// It checks the database copies only (openfrequency-*.db). What else the nightly backup keeps beside them is checked
// by whatever writes it.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupsDir, requireHome } from '../src/core/paths.js';

requireHome();
const arg = (name, d) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : d);
const maxAgeH = arg('--max-age-hours', 26);
const fail = (why) => {
  console.error(`backup-check: ${why}`);
  process.exit(1);
};

const dir = backupsDir();
let files = [];
try {
  files = readdirSync(dir).filter((f) => /^openfrequency-.*\.db$/.test(f)).sort();
} catch (e) {
  fail(`no backups folder at ${dir} (${e.code || e.message})`);
}
if (!files.length) fail(`no database copy in ${dir}`);
const file = path.join(dir, files[files.length - 1]);
const ageH = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
if (ageH > maxAgeH) fail(`the newest copy, ${path.basename(file)}, is ${ageH.toFixed(1)} hours old (more than ${maxAgeH})`);

let raw;
try {
  raw = new DatabaseSync(file, { readOnly: true });
  const integrity = raw.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  if (integrity.length !== 1 || integrity[0] !== 'ok') fail(`${path.basename(file)} is damaged: ${integrity.slice(0, 5).join('; ')}`);
  const version = raw.prepare('PRAGMA user_version').get().user_version;
  const accounts = raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const posts = raw.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  if (!version) fail(`${path.basename(file)} has no schema`);
  console.log(`backup-check: ${path.basename(file)} is whole (migration ${version}, ${accounts} account(s), ${posts} post(s), ${ageH.toFixed(1)} hours old)`);
} catch (e) {
  fail(`${path.basename(file)} does not open as a Teder database: ${e.message}`);
} finally {
  raw?.close();
}
