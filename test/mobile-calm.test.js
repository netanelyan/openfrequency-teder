import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { fold } from '../src/web/ui.js';
import { customer, fakeAccounts, listenFree, opened, tempHome } from './helpers.js';

// The owner, 2026-11-05, on an iPhone: "The mobile pages (each) has too many information, too many things jump to the
// eyes at the same time. Even the main page. Fix that." Under 700px a page leads with one thing and one action, and the
// rest is a row to open (ui.js fold) or lower; from 700px the pages are as they were. And the accessibility button,
// which floated over a field of /new, sits beside the tab bar, in its row. Here: the fold's markup, and in a real
// browser the phone's pages folded and the desk's open, a row that opens and stays open after the page comes back, a
// link into a fold, a slide's facts, home's side tile, and no field or button left under the floating bars.

let home;
let db;
let fake;
let server;
let base;
let postId;
let sid;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  const a = await buildPost(ctx, { pack: ctx.pack('demo') });
  assert.equal(a.status, 'queued', a.reason);
  postId = a.postId;
  await closeBrowser();
  const t = new Date().toISOString();
  db.insert('onboarding', { id: 'o-calm', seed_json: { niche: 'צמחי בית' }, status: 'review', workspace_id: 1, candidates_json: { candidates: [] }, created_at: t, updated_at: t });
  fake = await fakeAccounts();
  sid = fake.session(customer(1)).sid;
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'c'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = async (p) => (await fetch(`${base}${p}`, { headers: { cookie: `of_session=${sid}` } })).text();

test('a fold is a details open by default, its row the name, its key on it; nothing for nothing inside', () => {
  assert.equal(fold('plan', 'החבילה <החודשית>', '<section class="panel">x</section>'), '<details class="mfold one" data-mfold="plan" open><summary>החבילה &lt;החודשית&gt;</summary><section class="panel">x</section></details>');
  assert.equal(fold('caption', 'הטקסט', '<p>x</p>', { inCard: true, one: false }), '<details class="mfold in" data-mfold="caption" open><summary>הטקסט</summary><p>x</p></details>');
  assert.equal(fold('x', 'y', ''), '');
});

test('the pages carry their folds: Settings each part, a post its slides for Instagram, its captions, its small changes and its checks, Sources its form; /new is steps instead', async () => {
  const settings = await get('/settings');
  for (const key of ['design', 'promo', 'logo', 'schedule', 'plan', 'push', 'email', 'me']) assert.match(settings, new RegExp(`<details class="mfold one" data-mfold="${key}" open><summary>`), `Settings: ${key}`);
  // The panel inside each is the panel it was, so its links (#plan, #schedule) still land on it.
  assert.match(settings, /data-mfold="plan" open><summary>החבילה החודשית<\/summary><section class="panel" id="plan">/);
  const post = await get(`/post/${postId}`);
  for (const key of ['caption', 'light', 'details']) assert.match(post, new RegExp(`data-mfold="${key}" open>`), `the post page: ${key}`);
  // Instagram's slides are no fold under TikTok's: one row, by a switch (the owner, 2026-11-13: "2 rows into 1 row").
  assert.doesNotMatch(post, /data-mfold="instagram"/);
  assert.match(post, /<div class="pf-ig"><div class="strip ig" data-strip>/);
  assert.match(post, /<details class="mfold in" data-mfold="caption" open><summary>הטקסט שעולה עם המצגת<\/summary><div class="capwrap">/);
  assert.match(post, /<details class="mfold" data-mfold="details" open><summary>העובדות והבדיקות<\/summary>/);
  const sources = await get('/sources');
  assert.match(sources, /data-mfold="add" open><summary>הוספת מקור<\/summary><section class="panel"><header><h2>הוספת מקור<\/h2>/);
  assert.match(sources, /<nav class="list m-only mlinks" aria-label="עוד במקורות"><a href="\/topics">/, 'the topics and the hand-checked facts, rows on a phone');
  // /new's sources step is steps, a step at a time (test/setup-steps.test.js): nothing in a step folds, and connecting
  // and the days and times are not on it.
  const review = await get('/new/o-calm');
  assert.doesNotMatch(review, /data-mfold=/, "/new's sources step: no folds");
  assert.match(review, /data-step="1"/);
  const account = await get('/accounts');
  assert.match(account, /<details class="panel m-only acct-about"><summary><h3>איך זה עובד<\/h3><\/summary><p class="m0">כל פוסט מחכה לאישור שלכם לפני שהוא עולה\.<\/p><p class="m6">המצגות מגיעות לטיוטות בטיקטוק\./);
  assert.match(account, /<section class="panel acct-mode about">/);
});

test('in a real browser, a phone opens each page with its parts folded and a desk with all of them open, a row opens and stays open after the page comes back, a link into a fold opens it, and a slide opens its facts', async () => {
  let browser;
  try {
    browser = await chromium.launch();
    const open = async (width, height) => {
      const context = await browser.newContext({ viewport: { width, height }, ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      const refused = [];
      page.on('pageerror', (e) => refused.push(e.message));
      // The test's home has no rendered slides to serve: a picture that is not found is not what this checks.
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && refused.push(m.text()));
      return { context, page, refused };
    };
    const folds = (page) => page.evaluate(() => [...document.querySelectorAll('details[data-mfold]')].map((d) => ({ key: d.dataset.mfold, open: d.open, row: getComputedStyle(d.querySelector(':scope > summary')).display !== 'none' })));

    // A phone: Settings is a list of rows, each folded.
    {
      const { context, page, refused } = await open(390, 844);
      await page.goto(`${base}/settings`, { waitUntil: 'load' });
      let f = await folds(page);
      assert.ok(f.length >= 8, 'Settings has its parts as folds');
      assert.deepEqual(f.filter((x) => x.open || !x.row), [], 'on a phone every part is a row, folded');
      await page.click('details[data-mfold="schedule"] > summary');
      assert.equal(await page.isVisible('#schedule'), true, 'a tap on the row opens it');
      await page.reload({ waitUntil: 'load' });
      f = await folds(page);
      assert.deepEqual(f.filter((x) => x.open).map((x) => x.key), ['schedule'], 'and it is open again after the page comes back (a save reloads it), the others folded');
      // A link into a fold (home's "בהגדרות", the bar's month count) opens the one it points into.
      await page.goto(`${base}/settings#plan`, { waitUntil: 'load' });
      f = await folds(page);
      assert.equal(f.find((x) => x.key === 'plan').open, true, '#plan opens the plan');
      assert.equal(await page.isVisible('#plan'), true);
      // Home: what went out leads; the counts beside it are Posts' on a phone.
      await page.goto(`${base}/`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('.kpi.lead'), true);
      assert.equal(await page.isVisible('.kpi.side'), false, 'no side tile of counts on a phone');
      // A post: its slides and its decision, the rest folded; a slide opens its facts.
      await page.goto(`${base}/post/${postId}`, { waitUntil: 'load' });
      f = await folds(page);
      assert.deepEqual(f.filter((x) => x.open), [], 'the post page: every fold folded');
      assert.equal(await page.isVisible('.actionbar .btn.primary'), true, 'the approval in reach');
      const slide = await page.$('.strip a[href^="#s-"]');
      if (slide) {
        await slide.click();
        assert.equal(await page.evaluate(() => document.querySelector('details[data-mfold="details"]').open), true, 'tapping a slide opens the fold its facts are in');
      }
      assert.deepEqual(refused, [], 'no error, no CSP refusal');
      await context.close();
    }

    // A desk: every fold open, with no row of its own, and home's side tile beside what went out.
    {
      const { context, page } = await open(1280, 900);
      for (const p of ['/settings', `/post/${postId}`, '/results', '/sources', '/new/o-calm']) {
        await page.goto(`${base}${p}`, { waitUntil: 'load' });
        const f = await folds(page);
        assert.deepEqual(f.filter((x) => !x.open || x.row), [], `${p} on a desk: every fold open, no row drawn`);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.m-only')].some((e) => e.checkVisibility())), false, `${p} on a desk: nothing that is a phone's only`);
      }
      await page.goto(`${base}/`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('.kpi.side'), true, 'the side tile on a desk');
      await context.close();
    }

    // A phone turned wide opens what it folded.
    {
      const { context, page } = await open(390, 844);
      await page.goto(`${base}/settings`, { waitUntil: 'load' });
      await page.setViewportSize({ width: 1000, height: 800 });
      await page.waitForFunction(() => [...document.querySelectorAll('details[data-mfold]')].every((d) => d.open));
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});

test('in a real browser on a phone, the accessibility button is beside the tab bar, in its row, and on no page does it or the bar sit on a field or a button at the page\'s foot', async () => {
  let browser;
  try {
    browser = await chromium.launch();
    for (const width of [360, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      for (const p of ['/', '/posts', `/post/${postId}`, '/accounts', '/results', '/sources', '/settings', '/new', '/new/o-calm']) {
        await page.goto(`${base}${p}`, { waitUntil: 'load' });
        const m = await page.evaluate(async () => {
          const box = (sel) => document.querySelector(sel).getBoundingClientRect();
          const btn = box('.a11y-btn');
          const bar = box('.tabbar');
          // Every row of a fold open, so its fields count too; then the page's foot, where nothing scrolls further.
          for (const d of document.querySelectorAll('details[data-mfold]')) d.open = true;
          window.scrollTo(0, document.documentElement.scrollHeight);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const floats = [box('.a11y-btn'), box('.tabbar')];
          const under = [...document.querySelectorAll('main input:not([type=hidden]), main select, main textarea, main button, main a.btn, main summary')]
            .filter((el) => !el.closest('.actionbar') && el.checkVisibility())
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return floats.some((q) => Math.min(r.right, q.right) - Math.max(r.left, q.left) > 2 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 2);
            })
            .map((el) => `${el.tagName.toLowerCase()} ${(el.name || el.textContent || '').trim().slice(0, 20)}`);
          // Beside the tabs: in the glass look the bar itself stops short of the button; in the pro look (style-pro.css, the
          // default) the bar runs the full width and keeps an empty slot at its end, so the tabs are what it stays beside.
          const tabsLeft = Math.min(...[...document.querySelectorAll('.tabbar a')].map((a) => a.getBoundingClientRect().left));
          return { row: Math.abs((btn.top + btn.bottom) / 2 - (bar.top + bar.bottom) / 2) < 2, beside: btn.right <= Math.max(bar.left, tabsLeft) - 4 && btn.left >= 0, under, side: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        assert.ok(m.row, `${p} at ${width}: the button in the tab bar's row`);
        assert.ok(m.beside, `${p} at ${width}: beside the tabs, on none of them, on the screen`);
        assert.deepEqual(m.under, [], `${p} at ${width}: nothing to tap under the bar or the button`);
        assert.equal(m.side, 0, `${p} at ${width}: no sideways scroll`);
      }
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});
