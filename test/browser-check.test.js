import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/core/paths.js';
import { browserProblem, checkBrowser } from '../src/render/check.js';
import { closeBrowser } from '../src/render/render.js';
import { serverFree, tempHome } from './helpers.js';

// Before the website listens, scripts/web.js has Chromium draw one test slide (src/render/check.js); without a Chromium
// that does, it says what failed and the fix on one line and exits 1. The tests start the website through listen(),
// never through scripts/web.js: only this file draws the slide, and only scripts/web.js runs it at a start.

after(() => closeBrowser());

const WEB = path.join(ROOT, 'scripts', 'web.js');

/** A port nothing listens on now, picked as test/helpers.js picks them, for a scripts/web.js of a test's own. */
async function freePort() {
  const s = http.createServer();
  const port = await serverFree(s);
  await new Promise((r) => s.close(r));
  return port;
}

const BOX = '\n╔════════════════════════════════════════════════════════════╗\n║ Looks like Playwright was just installed or updated.       ║\n║ Please run the following command to download new browsers: ║\n║                                                            ║\n║     npx playwright install                                 ║\n╚════════════════════════════════════════════════════════════╝';

test("the check draws the test slide with this machine's Chromium, quickly", async () => {
  const r = await checkBrowser();
  assert.equal(r.ok, true, r.line);
  assert.ok(r.ms > 0 && r.ms < 30_000, `${r.ms} ms`);
});

test('a Chromium that is not there, cannot run, hangs or fails is one line: what failed and the fix', async () => {
  const fails = (message) => async () => {
    throw new Error(message);
  };
  const env = { PLAYWRIGHT_BROWSERS_PATH: '/opt/example/.browsers' };
  const exe = '/opt/example/.browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';

  // Not installed where Playwright looks: the variable, the path, and the install as the user that runs Teder.
  let r = await checkBrowser({ env, render: fails(`browserType.launch: Executable doesn't exist at ${exe}${BOX}`) });
  assert.equal(r.ok, false);
  assert.equal(r.line, `[browser] Teder did not start: Chromium is not installed where Playwright looks, ${exe} is not there (PLAYWRIGHT_BROWSERS_PATH=/opt/example/.browsers). Fix: as the user that runs Teder, with that same PLAYWRIGHT_BROWSERS_PATH, run npx playwright install chromium`);
  r = await checkBrowser({ env: {}, render: fails(`browserType.launch: Executable doesn't exist at ${exe}${BOX}`) });
  assert.match(r.line, /\(PLAYWRIGHT_BROWSERS_PATH is not set, so Playwright looked in the cache of the user running Teder\)/);

  // Installed, but the machine lacks its libraries: --with-deps, as root, with the libraries named.
  r = await checkBrowser({ env, render: fails('browserType.launch: \n╔══════╗\n║ Host system is missing dependencies to run browsers. ║\n║ Missing libraries:                                   ║\n║     libnss3.so                                       ║\n║     libgbm.so.1                                      ║\n╚══════╝') });
  assert.equal(r.line, '[browser] Teder did not start: Chromium is installed but cannot run here, system libraries it needs are missing (libnss3.so, libgbm.so.1). Fix: as root, run npx playwright install --with-deps chromium');
  r = await checkBrowser({ env, render: fails('browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n/opt/x/chrome: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory') });
  assert.match(r.line, /system libraries it needs are missing \(libatk-1\.0\.so\.0\)\. Fix: as root, run npx playwright install --with-deps chromium$/);

  // A launch that never answers: the check gives up at its time.
  r = await checkBrowser({ env, timeoutMs: 50, render: () => new Promise(() => {}) });
  assert.match(r.line, /^\[browser\] Teder did not start: Chromium did not draw the test slide within 30 s \(PLAYWRIGHT_BROWSERS_PATH=\/opt\/example\/\.browsers\)\. Fix: /);

  // Anything else: its first words, flattened, and the install.
  r = await checkBrowser({ env, render: fails('fonts did not load (Rubik 700): refusing to render\nmore') });
  assert.match(r.line, /Chromium did not draw the test slide: fonts did not load \(Rubik 700\): refusing to render more \(PLAYWRIGHT_BROWSERS_PATH=\/opt\/example\/\.browsers\)\. Fix: npx playwright install chromium, with --with-deps \(as root\) if a system library is named$/);

  for (const line of [r.line, browserProblem(new Error(`a\nb${BOX}`), env)]) assert.doesNotMatch(line, /\n/, 'one line');
});

test('Teder does not start, and never listens, when Playwright finds no Chromium: one line names PLAYWRIGHT_BROWSERS_PATH and the fix', async () => {
  const { home, cleanup } = tempHome();
  const empty = mkdtempSync(path.join(os.tmpdir(), 'of-no-browsers-'));
  try {
    const port = await freePort();
    const r = spawnSync(process.execPath, [WEB], { cwd: ROOT, env: { ...process.env, OF_HOME: home, PORT: String(port), PLAYWRIGHT_BROWSERS_PATH: empty }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, `exit 1 (status ${r.status}, signal ${r.signal})\n${r.stdout}\n${r.stderr}`);
    const lines = r.stderr.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^\[browser\] Teder did not start: Chromium is not installed where Playwright looks, \S+chromium\S* is not there \(PLAYWRIGHT_BROWSERS_PATH=(.+)\)\. Fix: as the user that runs Teder, with that same PLAYWRIGHT_BROWSERS_PATH, run npx playwright install chromium$/);
    assert.ok(lines[0].includes(`PLAYWRIGHT_BROWSERS_PATH=${empty})`), lines[0]);
    assert.doesNotMatch(r.stdout, /open-frequency: http:/, 'it never listened');
    assert.equal(existsSync(path.join(home, 'data', 'openfrequency.db')), false, 'nor opened the database');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    cleanup();
  }
});

test('with a working Chromium, Teder draws the test slide, says so, and then listens', async () => {
  const { home, cleanup } = tempHome();
  const port = await freePort();
  const child = spawn(process.execPath, [WEB], { cwd: ROOT, env: { ...process.env, OF_HOME: home, PORT: String(port) } });
  let out = '';
  let err = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (err += b));
  const exited = new Promise((r) => child.once('exit', r));
  try {
    const up = await Promise.race([
      new Promise((r) => {
        const poll = setInterval(() => out.includes('open-frequency: http://') && (clearInterval(poll), r(true)), 50);
        exited.then(() => (clearInterval(poll), r(false)));
      }),
      new Promise((r) => setTimeout(() => r(false), 60_000).unref()),
    ]);
    assert.ok(up, `it listens\n${out}\n${err}`);
    assert.match(out, /^browser: Chromium drew a test slide in \d+ ms$/m);
    assert.ok(out.indexOf('browser: Chromium drew') < out.indexOf('open-frequency: http://'), 'the check came first');
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    child.kill();
    await exited;
    cleanup();
  }
});
