#!/usr/bin/env node
// npm run backup [-- --keep 14]
//
// The database and every account's pack folder, into $OF_HOME/data/backups/, keeping the newest --keep copies of each
// (src/db/backup.js says what is copied, what is left out, and how to restore). The database copy is opened and
// checked before the run counts as done: a copy that fails the check is removed and this exits 1, so the timer's unit
// fails instead of leaving a file nobody can restore. On the VPS it runs from deploy/openfrequency-backup.timer; the
// copy off the server is a separate step.

import { backup, BackupError } from '../src/db/backup.js';
import { requireHome } from '../src/core/paths.js';

requireHome();
const keep = Number(process.argv.includes('--keep') ? process.argv[process.argv.indexOf('--keep') + 1] : 14);
try {
  const out = backup({ keep });
  console.log(`backup: ${out.db} (${out.check.accounts} accounts, ${out.check.posts} posts, integrity ok)${out.packs ? `; ${out.packs}` : '; no packs folder'} (${out.kept.db} kept)`);
} catch (e) {
  console.error(`backup failed: ${e instanceof BackupError ? e.message : e.stack || e.message}`);
  process.exitCode = 1;
}
