import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/core/paths.js';
import { KEYS } from '../src/core/env.js';

// HARD RULE 10 and the public repository: nothing secret or private is ever
// tracked, and check:public is what proves it.

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'of-public-'));
  // The private folder lives outside the repository under test, as it would on a real install.
  const home = mkdtempSync(path.join(os.tmpdir(), 'of-private-'));
  mkdirSync(path.join(home, 'packs', 'zz-real-pack'), { recursive: true });
  writeFileSync(path.join(home, 'packs', 'zz-real-pack', 'pack.json'), JSON.stringify({ id: 'zz-real-pack', handle: 'zz.real.handle', displayName: 'שם אמיתי לגמרי' }));
  // An archived account's names stay private too.
  mkdirSync(path.join(home, 'packs', '_archive', 'zz-old-pack'), { recursive: true });
  writeFileSync(path.join(home, 'packs', '_archive', 'zz-old-pack', 'pack.json'), JSON.stringify({ id: 'zz-old-pack', handle: 'zz.old.handle', displayName: 'שם ישן לגמרי' }));
  writeFileSync(path.join(home, 'public-denylist.txt'), 'secretsourcename\nid:gardening\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return { dir, home, cleanup: () => [dir, home].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

function check(r, files) {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(r.dir, f)), { recursive: true });
    writeFileSync(path.join(r.dir, f), body);
  }
  execFileSync('git', ['add', '-f', '.'], { cwd: r.dir });
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-public.js')], { env: { ...process.env, CHECK_PUBLIC_ROOT: r.dir, OF_HOME: r.home }, encoding: 'utf8' });
}

test('a clean repository passes check:public', () => {
  const r = repo();
  try {
    // A pack id that is an ordinary word ("id:gardening" in the denylist) is fine as a word.
    const out = check(r, { 'src/a.js': 'export const x = 1; // gardening tips\n', '.env.example': 'ANTHROPIC_API_KEY=\n' });
    assert.equal(out.status, 0, out.stderr);
  } finally {
    r.cleanup();
  }
});

for (const [why, files, expect] of [
  ['a real account handle', { 'docs/a.md': 'posted by @zz.real.handle today\n' }, /real account handle/],
  ['a real pack id', { 'src/a.js': "const p = 'zz-real-pack';\n" }, /real pack id/],
  ['a real display name', { 'README.md': 'שם אמיתי לגמרי\n' }, /real account name/],
  ['a denylisted word', { 'docs/b.md': 'from secretsourcename\n' }, /denylisted/],
  ['an archived account handle', { 'docs/c.md': 'the old @zz.old.handle\n' }, /real account handle/],
  ['an archived pack id', { 'scripts/x.js': "run('--pack zz-old-pack');\n" }, /real pack id/],
  ['a denylisted pack id used as one', { 'scripts/y.js': "const p = { pack: 'gardening' };\n" }, /real pack id/],
  ['a denylisted pack id in the docs', { 'docs/d.md': 'the Gardening account draws its own covers\n' }, /real pack id/],
  // Assembled at run time, so this file itself carries no key-shaped string.
  ['a key', { 'config.js': `const k = "${['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123'].join('-')}";\n` }, /Anthropic key/],
  ['a filled .env.example', { '.env.example': 'ZERNIO_API_KEY=abcdef123456\n' }, /empty values/],
  ['an .env file', { '.env': 'X=1\n' }, /\.env file/],
  ['a database', { 'state.db': 'SQLite format 3\0xxxx' }, /database/],
  ['a pack outside examples', { 'packs/x/pack.json': '{}\n' }, /pack outside examples/],
  ['anything under private/', { 'private/notes.txt': 'hello\n' }, /private folder/],
  ['rendered media', { 'out/slide.jpg': 'not really a jpeg' }, /media/],
]) {
  test(`check:public fails on ${why}`, () => {
    const r = repo();
    try {
      const out = check(r, files);
      assert.equal(out.status, 1, `expected a failure for ${why}`);
      assert.match(out.stderr, expect);
    } finally {
      r.cleanup();
    }
  });
}

test("check:public in a worktree reads the main checkout's private folder, so a commit made there is checked too", () => {
  // 2026-11-03: two commits made in .claude/worktrees/<name>, which has no private/ of its own, put a real handle and
  // pack ids into the public repository; the check had read no private name at all there.
  const main = mkdtempSync(path.join(os.tmpdir(), 'of-public-main-'));
  const tree = path.join(main, '.claude', 'worktrees', 'w');
  const run = (cwd, files, env = {}) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
      writeFileSync(path.join(cwd, f), body);
    }
    execFileSync('git', ['add', '-f', '.'], { cwd });
    const { OF_HOME, ...rest } = process.env;
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-public.js')], { env: { ...rest, CHECK_PUBLIC_ROOT: cwd, ...env }, encoding: 'utf8' });
  };
  try {
    const git = (...a) => execFileSync('git', a, { cwd: main, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(path.join(main, '.gitignore'), 'private/\n.claude/\n');
    writeFileSync(path.join(main, 'a.js'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
    git('worktree', 'add', '-q', tree, '-b', 'w');
    // With no private folder beside either, only the generic checks run, as before.
    const bare = run(tree, { 'docs/a.md': 'posted by @zz.real.handle today\n' });
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.stdout, /0 private names checked/);
    // The main checkout's private folder names the account: the worktree's commit is refused.
    mkdirSync(path.join(main, 'private', 'packs', 'zz-real-pack'), { recursive: true });
    writeFileSync(path.join(main, 'private', 'packs', 'zz-real-pack', 'pack.json'), JSON.stringify({ id: 'zz-real-pack', handle: 'zz.real.handle' }));
    const out = run(tree, {});
    assert.equal(out.status, 1, 'the handle is refused in the worktree');
    assert.match(out.stderr, /real account handle/);
    // OF_HOME still decides when it is set.
    const empty = mkdtempSync(path.join(os.tmpdir(), 'of-private-'));
    try {
      assert.equal(run(tree, {}, { OF_HOME: empty }).status, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test('.gitignore keeps the private folder, keys, databases and media out', () => {
  const gi = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const line of ['/private/', '.env', '*.db', '/data/', '/packs/', '/out/', '*.jpg', '*.png', '*.mp4']) assert.ok(gi.split(/\r?\n/).includes(line), `.gitignore lacks ${line}`);
});

test('.env.example lists every variable the code reads, each with a comment and no value', () => {
  const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const listed = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => (assert.equal(m[2].trim(), '', `${m[1]} has a value`), m[1])));
  const read = new Set();
  const walk = (d) => {
    for (const n of execFileSync('git', ['ls-files', d], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((x) => /\.js$/.test(x))) {
      const src = readFileSync(path.join(ROOT, n), 'utf8');
      for (const m of src.matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})/g)) read.add(m[1]);
      for (const m of src.matchAll(/isSet\('([A-Z][A-Z0-9_]+)'/g)) read.add(m[1]);
    }
  };
  walk('src');
  walk('scripts');
  for (const k of KEYS) read.add(k.name);
  const internal = new Set(['CHECK_PUBLIC_ROOT', 'NODE_ENV', 'PATH']);
  const missing = [...read].filter((k) => !listed.has(k) && !internal.has(k));
  assert.deepEqual(missing, [], 'add these to .env.example with a comment');
  for (const k of listed) {
    const i = example.split('\n').findIndex((l) => l.startsWith(`${k}=`));
    assert.ok(/^#/.test(example.split('\n')[i - 1] || ''), `${k} needs a comment line above it`);
  }
});
