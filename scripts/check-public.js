#!/usr/bin/env node
// npm run check:public
//
// The repository is public. This fails if anything committed (or staged for the
// next commit) looks private:
//
//   - any file under private/ (the default $OF_HOME), however it got there
//   - a .env file other than .env.example, or a key-shaped string anywhere
//   - a database (by extension or by the SQLite header)
//   - a pack outside examples/ (a pack.json, or a folder with theme.json and sources.json)
//   - rendered or downloaded media outside docs/screenshots/ (the site's icons and the
//     brand marks in assets/brand/ are public too)
//   - the name of a real account: every pack in $OF_HOME/packs (and the archived
//     ones in packs/_archive) contributes its id, handle, display name, Zernio ids
//     and Instagram ids, and $OF_HOME/public-denylist.txt adds any other words (a
//     real source, a person, a sister project); a line "id:<word>" there is a pack
//     id that is also an ordinary word, refused in code where it is used as an id
//     and as a word in a Markdown file (prose about a real account belongs in private/)
//
// It reads file contents from the git index, so the pre-commit hook checks what
// would actually be committed, not what happens to be on disk.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT as REPO, ofHome } from '../src/core/paths.js';

// The tests point this at a throwaway repository.
const ROOT = process.env.CHECK_PUBLIC_ROOT || REPO;

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

let files;
try {
  files = git('ls-files', '--cached', '-z').toString('utf8').split('\0').filter(Boolean);
} catch {
  console.error('check:public: not a git repository');
  process.exit(1);
}

/** Every indexed file's content, in one git call. */
function indexContents(list) {
  if (!list.length) return new Map();
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: ROOT, input: list.map((f) => `:${f}`).join('\n') + '\n', maxBuffer: 512 * 1024 * 1024 });
  const map = new Map();
  let at = 0;
  for (const f of list) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString('utf8');
    const m = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!m) {
      at = nl + 1;
      continue;
    }
    const size = Number(m[2]);
    map.set(f, out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return map;
}

const contents = indexContents(files);
const problems = [];
const fail = (file, why) => problems.push(`${file}: ${why}`);

const MEDIA = /\.(jpe?g|png|webp|gif|mp4|mov|webm|heic)$/i;
const MEDIA_OK = [/^docs\/screenshots\//, /^src\/web\/static\//, /^assets\/brand\/png\//];
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'ZERNIO_API_KEY', 'BRAVE_API_KEY', 'YOUTUBE_API_KEY', 'PEXELS_API_KEY', 'UNSPLASH_ACCESS_KEY', 'OPENVERSE_TOKEN', 'SESSION_SECRET', 'OF_ADMIN_PASSWORD', 'OF_INTERNAL_TOKEN', 'META_APP_SECRET', 'IG_TOKEN_[A-Z0-9_]+'];
const KEY_SHAPES = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic key'],
  [/\bEAA[A-Za-z0-9]{60,}\b/, 'a Meta (Facebook) access token'],
  [/\bIG(?:QV|AA)[A-Za-z0-9_-]{60,}\b/, 'an Instagram access token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'an API key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'a private key'],
  [new RegExp(`^\\s*(?:export\\s+)?(?:${KEY_NAMES.join('|')})\\s*=\\s*['"]?[^\\s'"#]{6,}`, 'm'), 'a key assigned a value'],
];

// ---- what the private folder says is real
const real = [];
const home = ofHome();
const packsDir = path.join(home, 'packs');
// The packs in use, and the ones archived (packs/_archive/<id>): an old account's
// name is still private.
const packFolders = (dir) => (existsSync(dir) ? readdirSync(dir).map((d) => path.join(dir, d)) : []);
if (existsSync(packsDir)) {
  for (const dir of [...packFolders(packsDir), ...packFolders(path.join(packsDir, '_archive'))]) {
    const d = path.basename(dir);
    const f = path.join(dir, 'pack.json');
    if (!existsSync(f)) continue;
    let p;
    try {
      p = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const id = String(p.id || d);
    real.push({ term: id, kind: 'pack id', packId: true });
    if (p.handle) real.push({ term: String(p.handle), kind: 'account handle' });
    if (p.displayName) real.push({ term: String(p.displayName), kind: 'account name' });
    for (const v of [p.zernio?.profileId, ...Object.values(p.zernio?.accounts || {})]) if (v && String(v).length >= 6) real.push({ term: String(v), kind: 'Zernio id' });
    for (const v of [p.instagram?.userId, p.instagram?.pageId]) if (v && String(v).length >= 6) real.push({ term: String(v), kind: 'Instagram or Facebook id' });
  }
}
const deny = path.join(home, 'public-denylist.txt');
if (existsSync(deny)) {
  for (const line of readFileSync(deny, 'utf8').split(/\r?\n/)) {
    const t = line.replace(/#.*$/, '').trim();
    // "id:travel": a pack id that is also an ordinary word (see the matchers below).
    const id = /^id:\s*(\S+)$/.exec(t);
    if (id) real.push({ term: id[1], kind: 'pack id', packId: true, prose: true });
    else if (t.length >= 3) real.push({ term: t, kind: 'denylisted word' });
  }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const L = '[\\p{L}\\p{N}_]';
const matchers = real.map((r) => {
  const t = esc(r.term);
  // A distinctive id (a dash or a digit in it) is refused anywhere; a plain word
  // that happens to be an id ("travel") is refused in code where it is used as one,
  // because the engine may use the word itself; one listed in the denylist is also
  // refused as a word in a Markdown file, since the docs have no reason to say it
  // but to describe the account. The account's handle and display name are matched
  // everywhere either way.
  if (r.packId && !/[-\d]/.test(r.term)) {
    return { ...r, mdRe: r.prose ? new RegExp(`(?<!${L})${t}(?!${L})`, 'iu') : null, re: new RegExp(`(?:packs[\\\\/]${t}(?!${L})|--pack[ =]['"]?${t}(?!${L})|(?:pack|packId|pack_id|account|accountId|account_id)['"]?\\s*[:=]\\s*['"]${t}['"])`, 'iu') };
  }
  return { ...r, re: new RegExp(`(?<!${L})@?${t}(?!${L})`, 'iu') };
});

// ---- the checks
const dirsWith = new Map();
for (const f of files) {
  const base = path.posix.basename(f);
  const dir = path.posix.dirname(f);
  if (f.startsWith('private/') || f === 'private') fail(f, 'the private folder must never be tracked');
  if (/^\.env($|\.)/.test(base) && base !== '.env.example') fail(f, 'an .env file');
  if (/\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(base)) fail(f, 'a database file');
  if (MEDIA.test(f) && !MEDIA_OK.some((re) => re.test(f))) fail(f, 'rendered or downloaded media (only docs/screenshots/ is allowed)');
  if (!f.startsWith('examples/') && base === 'pack.json') fail(f, 'a pack outside examples/: real packs live in $OF_HOME/packs');
  if (!f.startsWith('examples/')) dirsWith.set(dir, [...(dirsWith.get(dir) || []), base]);

  const buf = contents.get(f);
  if (!buf) continue;
  if (buf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') fail(f, 'an SQLite database');
  if (buf.includes(0)) continue; // binary: fonts and screenshots have nothing to read
  const text = buf.toString('utf8');
  for (const [re, what] of KEY_SHAPES) {
    if (base === '.env.example' && what === 'a key assigned a value') {
      const m = re.exec(text);
      if (m) fail(f, `.env.example must list keys with empty values (${m[0].split('=')[0].trim()})`);
      continue;
    }
    const m = re.exec(text);
    if (m) fail(f, `${what} (line ${text.slice(0, m.index).split('\n').length})`);
  }
  for (const r of matchers) {
    const m = (f.endsWith('.md') && r.mdRe ? r.mdRe : r.re).exec(text);
    if (m) fail(f, `names a real ${r.kind} (line ${text.slice(0, m.index).split('\n').length})`);
  }
}
for (const [dir, names] of dirsWith) {
  if (names.includes('theme.json') && names.includes('sources.json')) fail(`${dir}/`, 'looks like a pack (theme.json and sources.json) outside examples/');
}

if (problems.length) {
  console.error(`check:public FAILED: ${problems.length} problem(s) in tracked files\n  - ${problems.join('\n  - ')}`);
  console.error('\nNothing private belongs in this repository. Move it to $OF_HOME (./private/ by default).');
  process.exit(1);
}
console.log(`check:public ok: ${files.length} tracked files, ${real.length} private names checked${existsSync(home) ? '' : ' (no private folder here, so only the generic checks ran)'}`);
