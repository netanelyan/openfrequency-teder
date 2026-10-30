import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every JavaScript file of the repository parses, the entry scripts included. The suite imports the modules it tests,
// but never scripts/web.js, which only the service runs. On 2026-10-30 a quote inside a string of accounts' own
// scripts/web.js stopped that service from starting, sign-in down for three minutes, with every one of its tests
// passing; this is the same test as accounts' test/syntax.test.js. node --check reads each file without running it.

const root = fileURLToPath(new URL('..', import.meta.url));
const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

test('every JavaScript file parses (node --check), the entry scripts no test imports included', () => {
  assert.ok(files.includes('scripts/web.js'), 'the service entry is among the files checked');
  const bad = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      bad.push(`${f}: ${String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
