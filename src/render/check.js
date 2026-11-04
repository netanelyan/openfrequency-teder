import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { examplesDir } from '../core/paths.js';
import { readPack } from '../packs/load.js';
import { page } from './html.js';
import { buildSlide } from './templates/index.js';
import { closeBrowser, renderHtml } from './render.js';

// The browser every slide is drawn in, checked before the website listens (scripts/web.js). The owner, 2026-11-04:
// "at startup, check that the browser Playwright needs is installed and works (render one test slide). If not, refuse
// to start with a clear error."
//
// One slide of the fictional demo pack (its theme and its fonts, Hebrew) is drawn through renderHtml, the path every
// post's slides take, into a folder of its own that is removed after, and the browser is closed. Chromium missing,
// Chromium that cannot run on this machine, or a slide not drawn within BROWSER_CHECK_MS, is one line saying what
// failed and what fixes it, and scripts/web.js exits 1 before it listens: systemd's restarts fail the same way, the
// unit's OnFailure tells the operator, and deploy/deploy.sh puts the previous release back when /readyz never answers.
//
// Where Playwright looks is PLAYWRIGHT_BROWSERS_PATH (openfrequency.service sets /opt/open-frequency/.browsers, where
// deploy/deploy.sh installs Chromium as the service user); without it, the cache of the user running the process. A
// Chromium installed by another user, or without that variable, is not found: the line names the variable and the path.
//
// The tests start the website through listen() (test/helpers.js listenFree), never through scripts/web.js, so no test
// draws this slide unless it asks (test/browser-check.test.js).

export const BROWSER_CHECK_MS = 30_000;

const INSTALL = 'npx playwright install chromium';

/** The one line said when the check fails: what failed, and the fix. `e` is what the launch or the render threw. */
export function browserProblem(e, env = process.env) {
  const msg = String(e?.message || e || 'unknown error');
  const dir = String(env.PLAYWRIGHT_BROWSERS_PATH || '').trim();
  const where = dir ? `PLAYWRIGHT_BROWSERS_PATH=${dir}` : "PLAYWRIGHT_BROWSERS_PATH is not set, so Playwright looked in the cache of the user running Teder";
  const flat = (s) => s.replace(/[\s║╔╗╚╝═]+/g, ' ').trim();
  const missing = /Executable doesn't exist at (\S+)/.exec(msg);
  if (missing) return `[browser] Teder did not start: Chromium is not installed where Playwright looks, ${missing[1]} is not there (${where}). Fix: as the user that runs Teder, with that same PLAYWRIGHT_BROWSERS_PATH, run ${INSTALL}`;
  if (/missing dependencies to run browsers|error while loading shared libraries|cannot open shared object file/i.test(msg)) {
    const libs = [...new Set(msg.match(/\blib[\w.+-]*\.so(?:\.[\w.]+)?/g) || [])].slice(0, 6);
    return `[browser] Teder did not start: Chromium is installed but cannot run here, system libraries it needs are missing${libs.length ? ` (${libs.join(', ')})` : ''}. Fix: as root, run npx playwright install --with-deps chromium`;
  }
  if (e?.code === 'browser_timeout') return `[browser] Teder did not start: Chromium did not draw the test slide within ${Math.round(BROWSER_CHECK_MS / 1000)} s (${where}). Fix: check the machine's memory and that ${INSTALL} completes, then start again`;
  return `[browser] Teder did not start: Chromium did not draw the test slide: ${flat(msg).slice(0, 300)} (${where}). Fix: ${INSTALL}, with --with-deps (as root) if a system library is named`;
}

/** The test slide: the demo pack's cover, in Instagram's size. */
function testSlide() {
  const pack = readPack(path.join(examplesDir, 'demo'));
  const slide = { kind: 'cover', role: 'cover', hook: 'בדיקה של הדפדפן לפני שהאתר עולה', sub: '', handle: pack.meta.handle, hasPhoto: false };
  return { size: 'instagram', html: page({ theme: pack.theme, size: 'instagram', slide, parts: buildSlide(pack.theme, slide) }) };
}

/**
 * Launch Chromium and draw the test slide. { ok: true, ms } or { ok: false, line } (browserProblem's), never throws.
 * `render` stands for renderHtml in the tests, `timeoutMs` for BROWSER_CHECK_MS.
 */
export async function checkBrowser({ env = process.env, timeoutMs = BROWSER_CHECK_MS, render = renderHtml } = {}) {
  const t0 = Date.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'of-browser-check-'));
  let timer = null;
  try {
    const { size, html } = testSlide();
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`no slide in ${timeoutMs} ms`), { code: 'browser_timeout' })), timeoutMs);
      timer.unref?.();
    });
    const r = await Promise.race([render(html, { size, file: path.join(dir, 'check.jpg') }), late]);
    if (!r?.bytes) throw new Error('the test slide came out empty');
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, line: browserProblem(e, env) };
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    // A launch still hanging is not waited for: the process is about to exit.
    if (render === renderHtml) await Promise.race([closeBrowser(), new Promise((r) => setTimeout(r, 2000).unref?.())]);
  }
}
