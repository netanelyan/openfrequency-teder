import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { ROOT } from '../src/core/paths.js';
import { getSetting } from '../src/core/store.js';
import * as operator from '../src/notify/operator.js';
import { INTERNAL_TOKEN, opened, serverFree, tempHome } from './helpers.js';

// Teder's alerts reach the owner's own WhatsApp through Toran (the owner, 2026-11-03: "alerts can be sent to my own
// whatsapp"): each alert that is due is posted to Toran on this machine, POST /internal/ops/alert with the bearer
// OF_INTERNAL_TOKEN, as test/fixtures/ops-alert.json says (the same file in openfrequency-toran), and Toran sends it on.
// Teder's own command (OF_ALERT_CMD, /usr/local/bin/of-alert) runs beside it, as before. Toran is a fake here.

const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'ops-alert.json'), 'utf8'));
const SENT = EXAMPLE.routes[0].request.body;
const ALERT = { key: SENT.key, title: SENT.title, body: SENT.body, every: SENT.everyMinutes * 60_000 };
const T = Date.parse('2026-11-03T08:30:00.000Z');

/** A Toran on this machine that takes alerts: every request it was sent, and what it answers (`answer`). */
async function fakeToran({ status = 200, json = { ok: true, due: true } } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'] || null, forwarded: req.headers['x-forwarded-for'] || null, raw: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  const port = await serverFree(server);
  return { port, calls, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

function context() {
  const home = tempHome({ packs: {} });
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const logs = [];
  return { ctx: { db, log: (m) => logs.push(m) }, logs, cleanup: home.cleanup };
}

/** The command as a fake: each run's command and arguments. */
function fakeRun() {
  const runs = [];
  const run = (cmd, args, opts, cb) => (runs.push([cmd, ...args, opts.timeout]), cb(null));
  return { runs, run };
}

const say = (ctx, { env, run, t = T } = {}) => operator.alertOperator(ctx, ALERT.key, { title: ALERT.title, body: ALERT.body }, { t, every: ALERT.every, env, ...(run ? { run } : {}) });

test("Toran's address: http://127.0.0.1:4710 unless OF_TORAN_INTERNAL names another, and off turns the handing over off", () => {
  assert.equal(operator.TORAN_INTERNAL, 'http://127.0.0.1:4710');
  assert.equal(operator.toranAlertUrl?.({}), 'http://127.0.0.1:4710/internal/ops/alert');
  assert.equal(operator.toranAlertUrl?.({ OF_TORAN_INTERNAL: ' http://127.0.0.1:4799/ ' }), 'http://127.0.0.1:4799/internal/ops/alert');
  assert.equal(operator.toranAlertUrl?.({ OF_TORAN_INTERNAL: 'off' }), null);
});

test('an alert is handed to Toran once, with the bearer token, as the shared example has it; the same key inside its window is not', async () => {
  const toran = await fakeToran();
  const { ctx, logs, cleanup } = context();
  try {
    const env = { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_TORAN_INTERNAL: toran.url, OF_ALERT_CMD: path.join(ROOT, 'no-such-alert-command') };
    assert.equal(await say(ctx, { env }), true);
    assert.equal(toran.calls.length, 1, 'posted once');
    const [c] = toran.calls;
    assert.deepEqual([c.method, c.url, c.auth, c.type, c.forwarded], ['POST', '/internal/ops/alert', `Bearer ${INTERNAL_TOKEN}`, 'application/json', null]);
    assert.deepEqual(JSON.parse(c.raw), SENT, 'the body test/fixtures/ops-alert.json shows, which Toran is tested against');
    assert.ok(logs.includes(`[alert] ${ALERT.title}: ${ALERT.body}`), 'the log line, as before');
    assert.ok(!logs.some((l) => l.includes(INTERNAL_TOKEN)), 'the token is never said');
    assert.equal(getSetting(ctx.db, `alert:${ALERT.key}`).title, ALERT.title, 'kept for the health table, as before');

    assert.equal(await say(ctx, { env, t: T + 3_600_000 }), false, 'inside its 20 hours');
    assert.equal(toran.calls.length, 1, 'not posted again');
    assert.equal(await say(ctx, { env, t: T + ALERT.every }), true, 'past them');
    assert.equal(toran.calls.length, 2);
  } finally {
    await toran.close();
    cleanup();
  }
});

test('Toran down, refusing or not on this machine is a log line: the alert is still kept and logged, nothing throws, and Teder goes on', async () => {
  const { ctx, logs, cleanup } = context();
  const gone = await fakeToran();
  await gone.close(); // a port nobody listens on any more
  const refusing = await fakeToran({ status: 401, json: { error: 'bad_token' } });
  try {
    const base = { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_ALERT_CMD: path.join(ROOT, 'no-such-alert-command') };
    const started = Date.now();
    assert.equal(await say(ctx, { env: { ...base, OF_TORAN_INTERNAL: gone.url } }), true, 'said');
    assert.ok(Date.now() - started < 5_000, 'a port that is closed answers at once');
    assert.ok(logs.some((l) => l.startsWith(`[alert] Toran did not take ${ALERT.key}:`)), logs.join('\n'));
    assert.ok(getSetting(ctx.db, `alert:${ALERT.key}`), 'kept');

    logs.length = 0;
    assert.equal(await say(ctx, { env: { ...base, OF_TORAN_INTERNAL: refusing.url }, t: T + ALERT.every }), true);
    assert.equal(refusing.calls.length, 1, 'asked once, not again');
    assert.ok(logs.some((l) => l === `[alert] Toran did not take ${ALERT.key}: HTTP 401 bad_token`), logs.join('\n'));

    // Only a service on this machine is ever asked: another host is refused before anything is sent.
    logs.length = 0;
    assert.equal(await say(ctx, { env: { ...base, OF_TORAN_INTERNAL: 'http://toran.example' }, t: T + 2 * ALERT.every }), true);
    assert.ok(logs.some((l) => /\[alert\] Toran did not take .*only a service on this machine/.test(l)), logs.join('\n'));

    // No token, or off: not handed over, and no line about it.
    for (const env of [{ OF_ALERT_CMD: base.OF_ALERT_CMD, OF_TORAN_INTERNAL: refusing.url }, { ...base, OF_TORAN_INTERNAL: 'off' }]) {
      logs.length = 0;
      assert.equal(await operator.alertOperator(ctx, `k:${Object.keys(env).length}:${env.OF_TORAN_INTERNAL}`, { title: 'Teder: x', body: 'y' }, { t: T, env }), true);
      assert.deepEqual(logs, ['[alert] Teder: x: y']);
    }
    assert.equal(refusing.calls.length, 1);
  } finally {
    await refusing.close();
    cleanup();
  }
});

test('the command path still works beside it: the command runs with the title and the body, and Toran is told too', async () => {
  const toran = await fakeToran();
  const { ctx, cleanup } = context();
  const cmd = fakeRun();
  let open = true;
  try {
    const env = { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_TORAN_INTERNAL: toran.url, OF_ALERT_CMD: process.execPath };
    assert.equal(await say(ctx, { env, run: cmd.run }), true);
    assert.deepEqual(cmd.runs, [[process.execPath, ALERT.title, ALERT.body, 15_000]], 'the command, as before');
    assert.equal(toran.calls.length, 1, 'and Toran');
    // Toran down does not stop the command.
    await toran.close();
    open = false;
    assert.equal(await say(ctx, { env, run: cmd.run, t: T + ALERT.every }), true);
    assert.equal(cmd.runs.length, 2);
  } finally {
    if (open) await toran.close();
    cleanup();
  }
});

// ---- the example both sides read

/**
 * Toran's copy of test/fixtures/ops-alert.json, when its checkout is beside this one: walking up from this repo's root,
 * the first openfrequency-toran found; its worktree of this checkout's own name when this is a worktree and it has one
 * (one change in flight on both sides), else its main checkout.
 */
function toranExample() {
  const ours = path.basename(path.dirname(ROOT)) === 'worktrees' && path.basename(path.dirname(path.dirname(ROOT))) === '.claude' ? path.basename(ROOT) : null;
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
    const toran = path.join(dir, 'openfrequency-toran');
    if (!existsSync(toran)) continue;
    const paired = ours ? path.join(toran, '.claude', 'worktrees', ours, 'test', 'fixtures', 'ops-alert.json') : null;
    if (paired && existsSync(paired)) return paired;
    const main = path.join(toran, 'test', 'fixtures', 'ops-alert.json');
    return existsSync(main) ? main : null;
  }
  return null;
}

test("the example is Toran's own: test/fixtures/ops-alert.json is byte-identical to Toran's when that checkout is beside this one", (t) => {
  const theirs = toranExample();
  if (!theirs) {
    t.diagnostic('no openfrequency-toran checkout with test/fixtures/ops-alert.json beside this one: not compared (as in CI)');
    return;
  }
  assert.ok(readFileSync(path.join(ROOT, 'test', 'fixtures', 'ops-alert.json')).equals(readFileSync(theirs)), `test/fixtures/ops-alert.json differs from ${theirs}: copy it again`);
  t.diagnostic(`byte-identical to ${theirs}`);
  assert.equal(EXAMPLE.routes[0].path, '/internal/ops/alert');
  assert.equal(operator.TORAN_ALERT_PATH, EXAMPLE.routes[0].path, 'the path Teder posts to is the example\'s');
});
