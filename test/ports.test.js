import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { BAD_PORTS, listenFree, onFreePort, opened, serverFree, tempHome } from './helpers.js';

// Every test server listens through test/helpers.js onFreePort, which listens again while the system hands it a port
// fetch refuses ("fetch failed: bad port", test/switch.test.js on 2026-11-02, on a machine whose dynamic port range
// starts at 1024).

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** What this Node's fetch does with a port: 'bad' when it refuses it before connecting, else 'tried'. */
async function fetchSays(port) {
  const ac = new AbortController();
  const said = fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal }).then(
    () => 'tried',
    (e) => (e?.cause?.message === 'bad port' ? 'bad' : 'tried')
  );
  // A refused port is refused at once; any other is on its way to a connection by the next turn, and is let go.
  await new Promise((r) => setImmediate(r));
  ac.abort();
  return said;
}

test("the copy of fetch's blocked ports is this Node's own: each of the 82 refused, the ports beside them tried", async () => {
  assert.equal(BAD_PORTS.size, 82);
  for (const port of BAD_PORTS) assert.equal(await fetchSays(port), 'bad', `port ${port}`);
  for (const port of [2, 1718, 1721, 4044, 5059, 5062, 5999, 6001, 6664, 6670, 6696, 6698, 10079, 10081, 4700, 49152, 65535]) assert.equal(await fetchSays(port), 'tried', `port ${port}`);
});

/** A listener that hands out these ports in turn, keeping what it opened and closed. */
function handing(ports) {
  const log = { opened: [], closed: [] };
  let i = 0;
  const open = async () => {
    const port = ports[Math.min(i++, ports.length - 1)];
    log.opened.push(port);
    return { port, close: async () => log.closed.push(port) };
  };
  return { open, log };
}

test('a blocked port is let go and the port listened for again, until it is one fetch accepts', async () => {
  const { open, log } = handing([6000, 6665, 50123]);
  const got = await onFreePort(open);
  assert.equal(got.port, 50123);
  assert.deepEqual(log.opened, [6000, 6665, 50123]);
  assert.deepEqual(log.closed, [6000, 6665], 'each blocked one closed, the one kept left open');
  // A port fetch accepts the first time: kept, nothing closed.
  const once = handing([49200]);
  assert.equal((await onFreePort(once.open)).port, 49200);
  assert.deepEqual(once.log.closed, []);
});

test('a listener that only ever hands out blocked ports is given up on, each closed', async () => {
  const { open, log } = handing([10080]);
  await assert.rejects(onFreePort(open, { tries: 4 }), /no port fetch accepts in 4 tries/);
  assert.deepEqual(log.closed, [10080, 10080, 10080, 10080]);
});

test("a test's own server: listened again on the same server object while its port is blocked", async () => {
  // A stand-in for an http.Server whose system hands out 5060 first.
  const ports = [5060, 50124];
  const calls = [];
  let current = null;
  const fake = {
    once() {},
    off() {},
    listen(port, host, cb) {
      calls.push(['listen', port, host]);
      current = ports.shift();
      setImmediate(cb);
    },
    address: () => ({ port: current }),
    close(cb) {
      calls.push(['close', current]);
      setImmediate(cb);
    },
  };
  assert.equal(await serverFree(fake), 50124);
  assert.deepEqual(calls, [['listen', 0, '127.0.0.1'], ['close', 5060], ['listen', 0, '127.0.0.1']]);
});

test("Teder's own server through listenFree: a port fetch accepts, and it answers there", async () => {
  const { home, cleanup } = tempHome();
  let s;
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'p'.repeat(40) } });
    assert.ok(!BAD_PORTS.has(s.port));
    assert.equal(s.server.address().port, s.port);
    assert.match(await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).text(), /^ok/);
  } finally {
    await s?.close();
    cleanup();
  }
});

test('no test listens on a port the system picks except through the helpers', () => {
  const offenders = [];
  for (const name of readdirSync(HERE).filter((f) => f.endsWith('.js') && f !== 'helpers.js')) {
    const src = readFileSync(path.join(HERE, name), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/port:\s*0\b|\.listen\(\s*0\b|\blisten\(ctx\b(?!\)')/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/indexOf\(/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'listen through listenFree or serverFree (test/helpers.js)');
});
