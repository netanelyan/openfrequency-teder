import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { adminCookies, adminJar, underBase } from '../src/web/server.js';
import { customer, fakeAccounts, INTERNAL_TOKEN, listenFree, opened, operator, tempHome } from './helpers.js';

// Teder stays Teder, for the operator too (the owner, 2026-11-10: "Make teder and toran of natikyan153@gmail.com
// regular, just like a customer's. Everything else, leads etc should be in other places. The admin dashboard is for
// that. Toran and teder should stay toran and teder, even for admins"; accounts' docs/admin-split.md). On Teder's own
// name the superadmin is in their own workspace as its owner, and an operator page goes to accounts' /admin/teder,
// which accounts proxies here with X-OF-Admin-Prefix and a signed X-OF-Operator, as /admin/toran to Toran.

const PUBLIC = 'teder.test';
let home;
let db;
let fake;
let server;
let port;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'a'.repeat(40), ...fake.env, PUBLIC_HOST: PUBLIC } });
  server = s.server;
  port = s.port;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup?.();
});

/** A request as node:http sends it, so the Host header can be the public name. */
function raw(p, headers = {}, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(new URLSearchParams(body).toString());
    req.end();
  });
}

/** On Teder's own name, over HTTPS through the proxy, with a session accounts answers `answer` for. */
const onName = (p, answer) => raw(p, { host: PUBLIC, 'x-forwarded-proto': 'https', cookie: fake.session(answer).cookie.replace('of_session', '__Secure-of_session') });

/** X-OF-Operator as accounts signs it (its src/web/admin-toran.js operatorAssertion). */
function statement({ exp = Date.now() + 60_000, token = INTERNAL_TOKEN, ses = 'S'.repeat(32) } = {}) {
  const payload = Buffer.from(JSON.stringify({ id: 1, email: 'admin@example.com', name: 'Admin', ses, exp })).toString('base64url');
  return `${payload}.${createHmac('sha256', token).update(payload).digest('base64url')}`;
}
const ADMIN = (extra = {}) => ({ host: `127.0.0.1:${port}`, 'x-of-admin-prefix': '/admin/teder', 'x-of-operator': statement(), ...extra });

const navOf = (html) => /<nav class="nav" aria-label="ראשי">([^]*?)<\/nav>/.exec(html)?.[1] || '';

test('a body under the prefix: links, forms, polls, redirects in JSON and CSS fonts move under it; cookies are td_* for the prefix', () => {
  const html = '<html lang="he"><a href="/demos/3">x</a><form action="/settings/kill"></form><div data-poll="/leads/status.json" data-href="/leads?tab=new"></div><a href="https://wa.me/1">w</a><p>/leads in text</p>';
  const out = underBase(html, 'text/html', '/admin/teder');
  assert.match(out, /<html data-base="\/admin\/teder" lang="he">/);
  for (const re of [/href="\/admin\/teder\/demos\/3"/, /action="\/admin\/teder\/settings\/kill"/, /data-poll="\/admin\/teder\/leads\/status\.json"/, /data-href="\/admin\/teder\/leads\?tab=new"/, /href="https:\/\/wa\.me\/1"/, /<p>\/leads in text<\/p>/]) assert.match(out, re);
  assert.equal(underBase('{"ok":true,"redirect":"/demos/2"}', 'application/json', '/admin/teder'), '{"ok":true,"redirect":"/admin/teder/demos/2"}');
  assert.equal(underBase('src: url(/static/fonts/Assistant.ttf)', 'text/css', '/admin/teder'), 'src: url(/admin/teder/static/fonts/Assistant.ttf)');
  assert.deepEqual(adminCookies(['of_flash=hi; Path=/; Max-Age=20', 'of_acct=demo; Path=/; HttpOnly'], '/admin/teder'), ['td_flash=hi; Path=/admin/teder; Max-Age=20', 'td_acct=demo; Path=/admin/teder; HttpOnly']);
  assert.deepEqual(adminJar({ td_acct: 'demo', of_flash: 'accounts own', of_session: 'x', 'of-theme': 'dark', tn_side: 'mini' }), { of_acct: 'demo', 'of-theme': 'dark' });
});

test("the operator's pages under /admin/teder: the demos, the leads, every account and the server's settings, with the prefix kept", async () => {
  for (const p of ['/admin/teder/demos', '/admin/teder/leads', '/admin/teder/all', '/admin/teder/settings']) {
    const r = await raw(p, ADMIN());
    assert.equal(r.status, 200, p);
    assert.match(r.body, /<html data-base="\/admin\/teder"/, p);
    assert.match(r.body, /href="\/admin\/teder\/static\/style\.css/, p);
    assert.doesNotMatch(r.body, /<link rel="manifest"/, `${p}: not offered as the app on a phone`);
  }
  const s = await raw('/admin/teder/settings', ADMIN());
  assert.match(s.body, /עצירת חירום/);
  assert.match(s.body, /action="\/admin\/teder\/settings\/generate-at"/);
  assert.match(navOf(s.body), /href="\/admin\/teder\/leads"/, 'the leads in the operator\'s nav there');

  // A form from there: the CSRF token of the statement's ses, accounts' origin, and back to its page under the prefix.
  const csrf = /name="_csrf" value="([^"]+)"/.exec(s.body)[1];
  const r = await raw('/admin/teder/settings/generate-at', ADMIN({ origin: 'https://accounts.test', referer: 'https://accounts.test/admin/teder/settings' }), { method: 'POST', body: { _csrf: csrf, at: '07:00' } });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/admin/teder/settings');
  assert.ok(r.headers['set-cookie'].every((c) => /^td_/.test(c) && /Path=\/admin\/teder/.test(c)), String(r.headers['set-cookie']));
  // Another session's ses: the token is not good.
  assert.equal((await raw('/admin/teder/settings/generate-at', ADMIN({ origin: 'https://accounts.test', 'x-of-operator': statement({ ses: 'T'.repeat(32) }) }), { method: 'POST', body: { _csrf: csrf, at: '07:00' } })).status, 403);
});

test('/admin/teder refuses a missing, forged or stale statement, and never serves the internal routes or the public doors there', async () => {
  for (const bad of [null, 'forged.statement', statement({ token: 'x'.repeat(40) }), statement({ exp: Date.now() - 1 })]) {
    const r = await raw('/admin/teder/demos', ADMIN(bad ? { 'x-of-operator': bad } : { 'x-of-operator': '' }));
    assert.equal(r.status, 303, String(bad));
    assert.equal(r.headers.location, `https://accounts.test/admin/login?next=${encodeURIComponent('/admin/teder/demos')}`);
  }
  for (const p of ['/admin/teder/internal/demos', '/admin/teder/s/some-demo', '/admin/teder/m/p1/tiktok/0', '/admin/teder/connect/demo/tiktok', '/admin/teder/sw.js']) assert.equal((await raw(p, ADMIN())).status, 404, p);
  // Without the prefix header, the same path is no page of Teder's.
  assert.notEqual((await raw('/admin/teder/demos', { host: `127.0.0.1:${port}`, 'x-of-operator': statement() })).status, 200);
});

test("on Teder's own name the superadmin is in their workspace as its owner: the customer's nav and pages, and the operator's pages sent to /admin", async () => {
  const mine = { ...customer(1), user: { id: 1, email: 'operator@example.test', name: 'operator', superadmin: true } };
  const today = await onName('/', mine);
  assert.equal(today.status, 200);
  assert.equal(navOf(today.body), navOf((await onName('/', customer(1))).body), 'the same nav as the workspace\'s owner');
  assert.doesNotMatch(navOf(today.body), /\/leads/);
  for (const p of ['/demos', '/demos/4', '/leads', '/leads?tab=new']) {
    const r = await onName(p, mine);
    assert.equal(r.status, 303, p);
    assert.equal(r.headers.location, `https://accounts.test/admin/teder${p}`, p);
  }
  // Settings: no server-wide panel (the stop for everything, when posts are written), and developer mode one tap-run away.
  const s = await onName('/settings', mine);
  assert.doesNotMatch(s.body, /עצירת חירום|מתי נכתבים הפוסטים|דמואים לחנויות/);
  assert.match(s.body, /class="ver" data-devtap/);
  // A customer is as before: no operator page, and no seven taps.
  assert.equal((await onName('/demos', customer(1))).status, 404);
  assert.doesNotMatch((await onName('/settings', customer(1))).body, /data-devtap/);
});

test("on Teder's own name the superadmin with no workspace there gets a page pointing to /admin, and any other address goes there", async () => {
  const home_ = await onName('/', operator());
  assert.equal(home_.status, 200);
  assert.match(home_.body, /הניהול של תדר נמצא בלוח הניהול/);
  assert.match(home_.body, /<a class="btn primary" href="https:\/\/accounts\.test\/admin\/teder\/">ללוח הניהול<\/a>/);
  for (const p of ['/all', '/leads', '/settings']) {
    const r = await onName(p, operator());
    assert.equal(r.status, 303, p);
    assert.equal(r.headers.location, `https://accounts.test/admin/teder${p}`);
  }
});
