import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { examplesDir } from '../src/core/paths.js';
import { addDays, israelDate, israelInstant } from '../src/schedule/israel.js';

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

/** The end of an Israel day (YYYY-MM-DD) as accounts sends it: its last millisecond, in UTC. */
export const dayEnd = (day) => new Date(israelInstant(addDays(day, 1), '00:00').getTime() - 1).toISOString();

// ---- a port the tests can reach
//
// A test server listens on port 0, and the system picks the port. fetch (undici, in Node) and the browsers refuse to
// connect to some ports whatever answers there, and on a machine whose dynamic range starts low (the development
// machine's starts at 1024, `netsh int ipv4 show dynamicport tcp`; Windows' own default is 49152) the system can pick
// one of them: every request of that test file then fails with "fetch failed: bad port" (test/switch.test.js did, 2026-11-02).
// So every test listens through onFreePort, which listens again until the port is one fetch accepts.

/**
 * The ports fetch will not connect to: the Fetch standard's "bad port" list (https://fetch.spec.whatwg.org/#port-blocking),
 * as undici, Node's fetch, carries it (undici lib/web/fetch/constants.js, badPorts). Checked 2026-11-02 against Node
 * 24.18.0's own fetch (undici 7.28.0), port by port from 1 to 65535: it refused exactly these 82 with "bad port" and
 * tried every other one. test/ports.test.js asks this Node's fetch about each of them on every run.
 */
export const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * Listen on a port the system picks, and again while it picks one fetch refuses. `open()` starts one listener on port 0
 * and resolves to { port, close() } (close resolving once it is closed); what it resolved to last is returned. Gives up
 * after `tries`, which a machine never reaches by chance: 82 ports of 64511.
 */
export async function onFreePort(open, { tries = 20, blocked = BAD_PORTS } = {}) {
  for (let i = 0; i < tries; i++) {
    const got = await open();
    if (!blocked.has(got.port)) return got;
    await got.close();
  }
  throw new Error(`no port fetch accepts in ${tries} tries`);
}

/**
 * Teder's own server (src/web/server.js listen) for a test, on a port fetch accepts: what listen() resolves to,
 * { server, port, handler }, and close(). `opts` are listen()'s, without the port. Imported when first called, so the
 * server's modules load after this file has set the test environment above.
 */
export async function listenFree(ctx, opts = {}) {
  const { listen } = await import('../src/web/server.js');
  return onFreePort(async () => {
    const s = await listen(ctx, { ...opts, port: 0 });
    return { ...s, close: () => new Promise((resolve) => s.server.close(() => resolve())) };
  });
}

/** A server of a test's own (http, https, net) listening on `host` at a port fetch accepts. Resolves to the port. */
export async function serverFree(server, host = '127.0.0.1') {
  const got = await onFreePort(
    () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
          server.off('error', reject);
          resolve({ port: server.address().port, close: () => new Promise((done) => server.close(() => done())) });
        });
      })
  );
  return got.port;
}

/**
 * Answers each session id with what it was given ({ status, body }, or a 200 body), and anything else with 401
 * no_session; a wrong token gets 401 bad_token, as accounts does. `calls` counts the questions, `last` is the last one.
 */
export async function fakeAccounts() {
  const answers = new Map();
  // GET /internal/entitlement: each workspace paid unless told otherwise. POST /internal/notify: every email kept.
  const entitlements = new Map();
  const notified = [];
  const state = { calls: 0, last: null, entitlementCalls: 0, notifyStatus: 202, sentOf: {} };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');
    const out = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/internal/entitlement') {
      state.entitlementCalls++;
      if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
      const ws = Number(url.searchParams.get('workspace'));
      const a = entitlements.get(ws) ?? 'paid';
      if (typeof a === 'function') return a(req, res);
      if (a && typeof a === 'object' && a.status) return out(a.status, a.body);
      const access = typeof a === 'string' ? a : a.access || 'paid';
      // As accounts answers (its docs/contracts/entitlement.json): paidThrough the last millisecond of an Israel day, in
      // UTC; `due` is the grace after a paid period, still allowed; Teder's answers carry the plan and what a month costs
      // before VAT (monthlyIls, the full plan's 790 ₪ at its list price). The days are counted
      // from the day the test runs, a month paid ahead and the grace to the end of the day after tomorrow, so a page of a
      // test is never in the last week paid for (the reminder to pay, test/pay-reminder.test.js) by the calendar alone.
      const paid = ['paid', 'comp', 'due'].includes(access);
      const product = url.searchParams.get('product');
      const today = israelDate(Date.now());
      return out(200, { workspace: ws, product, enabled: access !== 'off', access, allowed: paid, paidThrough: paid ? dayEnd(addDays(today, access === 'due' ? -1 : 30)) : null, cancelAt: null, graceUntil: access === 'due' ? dayEnd(addDays(today, 2)) : null, ...(product === 'teder' ? { plan: { name: 'full', slideshows: 40, redos: 10 }, monthlyIls: 790 } : {}), ...(typeof a === 'object' ? a : {}) });
    }
    if (url.pathname === '/internal/notify') {
      if (req.method !== 'POST') return out(405, { error: 'method' });
      if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      if (state.notifyStatus >= 300) return out(state.notifyStatus, { error: 'down' });
      const raw = Buffer.concat(chunks);
      if (raw.length > 256 * 1024) return out(413, { error: 'too_large' });
      const b = JSON.parse(raw.toString('utf8'));
      // The checks accounts makes, a code per bad field.
      if (typeof b.workspace !== 'number') return out(400, { error: 'bad_workspace' });
      // Teder's five kinds, and the notice ai_paused (accounts' NOTICES_OF), which reaches the owners whatever they chose.
      if (!['posts_waiting', 'weekly', 'monthly', 'connect_needed', 'publish_failed', 'ai_paused'].includes(b.kind)) return out(400, { error: 'bad_kind' });
      if (typeof b.subject !== 'string' || !b.subject || b.subject.length > 200) return out(400, { error: 'bad_subject' });
      if (typeof b.text !== 'string' || !b.text || b.text.length > 5000) return out(400, { error: 'bad_text' });
      let link;
      try {
        link = new URL(b.link);
      } catch {
        return out(400, { error: 'bad_link' });
      }
      if (link.protocol !== 'https:' || link.port || !/^([a-z0-9-]+\.)*openfrequency\.co\.il$/.test(link.hostname)) return out(400, { error: 'bad_link' });
      // Three of a kind per workspace and product in a rolling day.
      const k = `${b.workspace}:${b.product}:${b.kind}`;
      const n = (state.sentOf[k] || 0) + 1;
      if (n > 3) return out(429, { error: 'rate_limited' });
      state.sentOf[k] = n;
      notified.push(b);
      return out(202, { ok: true, sent: 1 });
    }
    state.calls++;
    state.last = { path: url.pathname, product: url.searchParams.get('product'), auth: req.headers.authorization, session: req.headers['x-of-session'] };
    if (url.pathname !== '/internal/session') return out(404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
    const a = answers.get(req.headers['x-of-session']);
    if (!a) return out(401, { error: 'no_session' });
    if (typeof a === 'function') return a(req, res);
    return a.status ? out(a.status, a.body) : out(200, a);
  });
  const port = await serverFree(server);
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
    /** What /internal/entitlement answers for a workspace: an access ('paid', 'unpaid', ...), a body to merge, { status, body }, or a handler. */
    entitlement(workspaceId, answer) {
      if (answer == null) entitlements.delete(workspaceId);
      else entitlements.set(workspaceId, answer);
    },
    get entitlementCalls() {
      return state.entitlementCalls;
    },
    /** The emails accounts was asked to send, in order. */
    notified,
    /** What /internal/notify answers from now on (a 5xx: accounts is down). */
    notifyStatus(status) {
      state.notifyStatus = status;
    },
    /** Forget the emails sent and the day's limits (a new day, as far as the fake knows). */
    resetNotify() {
      notified.length = 0;
      state.sentOf = {};
      state.notifyStatus = 202;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Mark workspaces paid in the database, as the entitlement client keeps accounts' answer (src/billing/entitlement.js):
 * for a test that runs the engine for a workspace's accounts without a website request having asked first. `plan` is
 * the plan accounts gave ({ name, slideshows, redos }); none is the full plan's 40 and 10.
 */
export function paidWorkspaces(db, ids, { at = new Date().toISOString(), plan = null } = {}) {
  for (const ws of ids) db.run('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', `entitlement:${ws}`, JSON.stringify({ allowed: true, access: 'paid', paidThrough: null, cancelAt: null, plan, stoppedAt: null, checkedAt: at }), at);
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
