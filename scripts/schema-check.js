#!/usr/bin/env node
// node scripts/schema-check.js
//
// May this build run on the database in $OF_HOME? It opens the database read-only, migrates nothing, and asks the
// same question the process asks when it starts (src/db/index.js schemaProblem): is the database ahead of this build
// (a rollback past a migration), and is every migration it ran the one at the same place in this build's list (a merge
// that renumbered the list). deploy/deploy.sh and deploy/rollback.sh run it from the release they are about to switch
// to, so a release that would refuse to start is never switched to. Exit 0 and "ok", or exit 1 and why.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from '../src/core/paths.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { recordedChecks, schemaProblem } from '../src/db/index.js';

const file = dbPath();
if (!existsSync(file)) {
  console.log(`ok: no database yet at ${file}; this build creates it with its ${MIGRATIONS.length} migrations`);
  process.exit(0);
}
const raw = new DatabaseSync(file, { readOnly: true });
const have = raw.prepare('PRAGMA user_version').get().user_version;
const problem = schemaProblem(have, recordedChecks(raw));
raw.close();
if (problem) {
  console.error(`schema-check: ${problem}`);
  process.exit(1);
}
console.log(`ok: the database ran ${have} migration(s), this build knows ${MIGRATIONS.length}${have < MIGRATIONS.length ? `, and runs the ${MIGRATIONS.length - have} new one(s) when it starts` : ''}`);
