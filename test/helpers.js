import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { examplesDir } from '../src/core/paths.js';

// Every test runs against a throwaway OF_HOME built from the fictional demo
// pack, never against ./private/ or any real pack. A test that wants a variant
// (a second account, another format) copies the demo and edits the copy.

process.env.OF_MODE = 'recorded';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ZERNIO_API_KEY;

export const DEMO = path.join(examplesDir, 'demo');

/** Databases opened by a test, closed before its folder is removed (Windows will not delete an open file). */
export const opened = [];

/** A fresh private folder with the demo pack in packs/demo. */
export function tempHome({ packs = { demo: null } } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'of-test-'));
  for (const [id, edit] of Object.entries(packs)) copyPack(home, id, edit);
  process.env.OF_HOME = home;
  return {
    home,
    cleanup: () => {
      while (opened.length) {
        try {
          opened.pop().close();
        } catch {
          /* already closed */
        }
      }
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* a leftover temp folder is harmless */
      }
    },
  };
}

const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));

/**
 * Copy the demo pack into <home>/packs/<id>. `edit(files)` may change any of
 * pack, theme, sources, formats, rules (objects) or voice (a string) before it
 * is written.
 */
export function copyPack(home, id, edit = null) {
  const dest = path.join(home, 'packs', id);
  cpSync(DEMO, dest, { recursive: true });
  const files = {
    pack: readJ(path.join(dest, 'pack.json')),
    theme: readJ(path.join(dest, 'theme.json')),
    sources: readJ(path.join(dest, 'sources.json')),
    formats: readJ(path.join(dest, 'formats.json')),
    rules: readJ(path.join(dest, 'rules.json')),
    voice: readFileSync(path.join(dest, 'voice.md'), 'utf8'),
  };
  files.pack.id = id;
  if (id !== 'demo') {
    files.pack.handle = `${id.replace(/-/g, '.')}.test`;
    files.pack.displayName = `חשבון ${id}`;
  }
  edit?.(files);
  for (const k of ['pack', 'theme', 'sources', 'formats', 'rules']) writeFileSync(path.join(dest, `${k}.json`), JSON.stringify(files[k], null, 2));
  writeFileSync(path.join(dest, 'voice.md'), files.voice);
  return dest;
}

/** Overwrite one recorded draft in a copied pack. */
export function setDraft(packDir, key, mutate) {
  const f = path.join(packDir, 'recordings', 'drafts', `${key}.json`);
  const d = readJ(f);
  mutate(d);
  writeFileSync(f, JSON.stringify(d, null, 2));
}

/** Keep only these recorded documents (and their drafts) in a copied pack. */
export function keepOnly(packDir, keys) {
  for (const sub of ['documents', 'drafts']) {
    const dir = path.join(packDir, 'recordings', sub);
    for (const f of readdir(dir)) if (!keys.includes(f.replace(/\.json$/, ''))) rmSync(path.join(dir, f));
  }
}

import { readdirSync } from 'node:fs';
const readdir = (d) => readdirSync(d);

// ---- a stand-in for openfrequency-accounts' GET /internal/session (that repository's docs/internal-session.md)

export const INTERNAL_TOKEN = 'test-internal-token-000000000000000000000';

/**
 * Answers each session id with what it was given ({ status, body }, or a 200 body), and anything else with 401
 * no_session; a wrong token gets 401 bad_token, as accounts does. `calls` counts the questions, `last` is the last one.
 */
export async function fakeAccounts() {
  const answers = new Map();
  const state = { calls: 0, last: null };
  const server = http.createServer((req, res) => {
    state.calls++;
    const url = new URL(req.url, 'http://internal');
    state.last = { path: url.pathname, product: url.searchParams.get('product'), auth: req.headers.authorization, session: req.headers['x-of-session'] };
    const out = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== '/internal/session') return out(404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
    const a = answers.get(req.headers['x-of-session']);
    if (!a) return out(401, { error: 'no_session' });
    if (typeof a === 'function') return a(req, res);
    return a.status ? out(a.status, a.body) : out(200, a);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let n = 0;
  return {
    port,
    env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ACCOUNTS_INTERNAL: `http://127.0.0.1:${port}`, OF_ACCOUNTS_URL: 'https://accounts.test' },
    get calls() {
      return state.calls;
    },
    get last() {
      return state.last;
    },
    /** A new session id that answers `answer`; returns { sid, cookie } (the cookie as a browser on plain HTTP sends it). */
    session(answer) {
      const sid = `s${String(++n).padStart(3, '0')}${randomBytes(24).toString('base64url')}`;
      answers.set(sid, answer);
      return { sid, cookie: `of_session=${sid}` };
    },
    /** Change what a session answers from now on (signed out: answer(sid, null)). */
    answer(sid, answer) {
      if (answer == null) answers.delete(sid);
      else answers.set(sid, answer);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const LATER = '2099-01-01T00:00:00.000Z';

/** A customer of one workspace, as /internal/session describes them. */
export function customer(workspaceId, { role = 'client_owner', email = `owner${workspaceId}@example.test`, name = 'owner', wsName = `Workspace ${workspaceId}` } = {}) {
  return { user: { id: 100 + workspaceId, email, name, superadmin: false }, workspace: { id: workspaceId, slug: `ws${workspaceId}`, name: wsName, disabled: false }, role, products: ['teder'], readOnly: false, viewAs: null, expiresAt: LATER };
}

/** The superadmin outside view-as: Teder's operator. */
export const operator = ({ name = 'owner' } = {}) => ({ user: { id: 1, email: 'operator@example.test', name, superadmin: true }, workspace: null, role: 'superadmin', products: ['teder', 'toran'], readOnly: false, viewAs: null, expiresAt: LATER });

/** The superadmin viewing one workspace as its customer sees it: read-only. */
export const viewingAs = (workspaceId, wsName = `Workspace ${workspaceId}`) => ({
  user: { id: 1, email: 'operator@example.test', name: '', superadmin: true },
  workspace: { id: workspaceId, slug: `ws${workspaceId}`, name: wsName, disabled: false },
  role: 'superadmin',
  products: ['teder'],
  readOnly: true,
  viewAs: { by: { id: 1, email: 'operator@example.test' }, since: '2026-10-22T10:00:00.000Z' },
  expiresAt: LATER,
});
