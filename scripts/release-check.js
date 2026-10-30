#!/usr/bin/env node
// node scripts/release-check.js
//
// The check before a release: the whole test suite, then the public check (scripts/check-public.js), and a test that
// was skipped, left todo or cancelled fails it as surely as one that failed. `npm test` lets a test skip itself (a
// Node without full ICU data, say); a release does not. CI runs this (.github/workflows/test.yml), and
// deploy/deploy.sh with RUN_TESTS=1.

import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from '../src/core/paths.js';

const counts = {};
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', 'test/*.test.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
let rest = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const text = rest + chunk.toString('utf8');
  const lines = text.split('\n');
  rest = lines.pop();
  for (const l of lines) {
    const m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(l.trim());
    if (m) counts[m[1]] = Number(m[2]);
  }
});
const code = await new Promise((resolve) => child.on('close', resolve));
const m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(rest.trim());
if (m) counts[m[1]] = Number(m[2]);

const problems = [];
if (code !== 0) problems.push(`the suite exited with ${code}`);
if (counts.tests == null) problems.push('the suite printed no summary');
for (const k of ['fail', 'cancelled', 'skipped', 'todo']) if (counts[k]) problems.push(`${counts[k]} ${k}`);
console.log(`\nrelease-check: ${counts.pass ?? 0} of ${counts.tests ?? '?'} passed${problems.length ? `; ${problems.join(', ')}` : ''}`);
if (problems.length) process.exit(1);

const pub = spawnSync(process.execPath, ['scripts/check-public.js'], { cwd: ROOT, stdio: 'inherit' });
process.exit(pub.status ?? 1);
