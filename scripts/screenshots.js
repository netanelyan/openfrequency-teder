#!/usr/bin/env node
// npm run screenshots [-- --out docs/screenshots] [-- --dark] [-- --only today,post]
//
// Every page of the website at phone width (390x844) and desktop width
// (1440x900), in a headless browser, from the fictional demo only: it builds the
// demo home first, so no real account can ever appear in a picture that goes in
// the public repository.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../src/core/paths.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const out = path.resolve(ROOT, opt('out', 'docs/screenshots'));
const only = opt('only', null)?.split(',');
const themes = args.includes('--dark') ? ['light', 'dark'] : args.includes('--dark-only') ? ['dark'] : ['light'];
mkdirSync(out, { recursive: true });

const port = 4791;
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demo.js'), '--port', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d;
    if (buf.includes('open http://')) resolve();
  });
  server.on('exit', (c) => reject(new Error(`demo exited ${c}`)));
  // The demo builds its posts first; on a busy machine that takes minutes.
  setTimeout(() => reject(new Error('demo did not start')), 900_000);
});

// localhost, not 127.0.0.1: the demo's sign-in cookie belongs to that name (scripts/demo-accounts.js).
const base = `http://localhost:${port}`;
const browser = await chromium.launch();
const shots = [];
try {
  for (const theme of themes) {
    for (const [device, viewport, extra] of [
      ['phone', { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
      ['desktop', { width: 1440, height: 900 }, { deviceScaleFactor: 1 }],
    ]) {
      const context = await browser.newContext({ viewport, ...extra, locale: 'he-IL', colorScheme: theme });
      // Dark is the browser's choice, the cookie every OpenFrequency site shares (src/web/static/theme.js), never the
      // device's setting.
      await context.addCookies([{ name: 'of-theme', value: theme, url: base }]);
      const page = await context.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      // The first visit goes through the demo's stand-in for accounts, which signs the browser in and comes back.
      await page.goto(`${base}/`);
      // Home is an overview with no cards; the cards, and so a post to picture, are on Posts.
      await page.goto(`${base}/posts`);
      const postId = await page.evaluate(() => document.querySelector('[data-post]')?.id?.replace('post-', ''));
      if (!postId) throw new Error('no post on /posts to picture');
      const pages = [
        ['today', '/'],
        ['all', '/all'],
        ['post', `/post/${postId}`],
        ['accounts', '/accounts'],
        ['results', '/results'],
        ['sources', '/sources'],
        ['rivals', '/rivals'],
        ['new', '/new'],
        ['settings', '/settings'],
        ...(device === 'phone' ? [['more', '/more']] : []),
      ];
      // The onboarding review, from a fictional seed, offline: discovery runs, the page lists what it found.
      if (!only || only.includes('new-review')) {
        await page.goto(`${base}/new`);
        await page.fill('input[name=niche]', 'בישול טבעוני לסטודנטים');
        await page.fill('input[name=audience]', 'סטודנטים עם מטבח קטן ותקציב קטן');
        await page.fill('input[name=topics]', 'מתכונים, תקציב, תזונה');
        await Promise.all([page.waitForNavigation(), page.click('form[action="/new"] button[type=submit]')]);
        for (let i = 0; i < 30 && !(await page.content()).includes('שם לחשבון'); i++) {
          await page.waitForTimeout(500);
          await page.reload();
        }
        shots.push(await shot(page, `new-review-${device}${theme === 'dark' ? '-dark' : ''}`));
      }
      for (const [name, url] of pages) {
        if (only && !only.includes(name)) continue;
        await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
        shots.push(await shot(page, `${name}-${device}${theme === 'dark' ? '-dark' : ''}`));
      }
      if (errors.length) console.log(`${device}/${theme} console errors:\n  ${[...new Set(errors)].join('\n  ')}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}

async function shot(page, name) {
  // A full-page picture of a lazy page: load every image first, or the ones below the fold come out blank.
  // A lazy image that has not started can already report `complete`, so wait for pixels.
  await page.evaluate(async () => {
    const imgs = [...document.images];
    imgs.forEach((i) => (i.loading = 'eager'));
    for (let t = 0; t < 50 && imgs.some((i) => !i.naturalWidth); t++) await new Promise((r) => setTimeout(r, 100));
    await document.fonts.ready;
    // Anything that draws itself in: picture it drawn.
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  });
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) console.log(`  ${name}: the page scrolls sideways`);
  return file;
}
console.log(`${shots.length} screenshots in ${path.relative(ROOT, out)}`);
