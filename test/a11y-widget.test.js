import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { A11Y_URL, layout } from '../src/web/ui.js';
import { customer, fakeAccounts, opened, operator, tempHome } from './helpers.js';

// The owner (2026-10-31): "accesebillity widget should be available in each subdomain. not only on the web repo". The
// website's panel (openfrequency-web src/layout.mjs, site.js, style.css) is on every page of Teder's layout: the round
// button, four switches that are each a class on <html>, kept under the website's own key, a reset and the website's
// statement. Here: the markup on every page, the script and the styles that run it served, and in a real browser the
// keyboard, the switches surviving a reload, Escape and a click outside, no CSP refusal, the button clear of the tab
// bar and of a post's action bar, and no page scrolling sideways on a phone with the larger text on.

let home;
let db;
let fake;
let server;
let base;
let postId;

// Every page of the layout a customer opens, and the page of every account, and one that does not exist.
let PAGES;

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
  db.insert('onboarding', { id: 'o-a11y', seed_json: { niche: 'צמחי בית' }, status: 'samples', pack_id: 'demo', workspace_id: 1, candidates_json: { samples: { made: 0, at: t } }, created_at: t, updated_at: t });
  PAGES = ['/', '/posts', `/post/${postId}`, '/accounts', '/results', '/sources', '/facts', '/topics', '/rivals', '/sounds', '/settings', '/more', '/styles', '/new', '/new/o-a11y', '/all', '/no-such-page'];
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'a'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

/** The panel's parts, as the page sends them. */
function assertWidget(html, where) {
  assert.equal((html.match(/<div class="a11y-w" data-a11y hidden>/g) || []).length, 1, `${where}: the panel, once, hidden until the script shows it`);
  assert.match(html, /<button class="a11y-btn" type="button" aria-expanded="false" aria-controls="a11y-p">[^]*?<span class="sr">נגישות<\/span><\/button>\s*<div class="a11y-p" id="a11y-p" role="group" aria-labelledby="a11y-h" hidden>/, `${where}: the button, named, before its panel`);
  for (const [key, label] of [['big', 'טקסט גדול יותר'], ['contrast', 'ניגודיות גבוהה'], ['links', 'קו מתחת לקישורים'], ['still', 'לעצור תנועה']]) {
    assert.ok(html.includes(`<button type="button" data-a="${key}" aria-pressed="false">${label}</button>`), `${where}: the switch ${key}`);
  }
  assert.ok(html.includes(`<button type="button" class="a11y-reset" data-a11y-reset>לאפס</button><a href="https://openfrequency.co.il/accessibility">הצהרת הנגישות</a>`), `${where}: the reset and the website's statement`);
  assert.match(html, /<script src="\/static\/app\.js\?v=[\w]+" defer><\/script>/, `${where}: the script that runs it`);
  assert.doesNotMatch(html, / style="|<script>| on[a-z]+="/, `${where}: nothing inline (the CSP allows none)`);
}

test('every page of the layout carries the panel, with the website\'s statement, and the script and styles that run it are served', async () => {
  assert.equal(A11Y_URL, 'https://openfrequency.co.il/accessibility');
  assertWidget(layout({ title: 'x', active: 'today', csrf: 'c' }, '<h1>x</h1>'), 'layout()');
  for (const [who, session] of [['a customer', customer(1)], ['the operator', operator()]]) {
    const { cookie } = fake.session(session);
    for (const p of PAGES) {
      const res = await get(p, cookie);
      assert.ok([200, 404].includes(res.status), `${who} ${p}: ${res.status}`);
      assertWidget(await res.text(), `${who} ${p}`);
    }
  }
  const js = await (await get('/static/app.js')).text();
  for (const part of ["const KEY = 'of-a11y'", "document.querySelector('[data-a11y]')", "e.key === 'Escape' && !panel.hidden", "root.classList.toggle(`a-${k}`, on[k] === true)"]) assert.ok(js.includes(part), `app.js: ${part}`);
  // It runs first, on its own, so nothing else in the script can keep the saved switches off.
  assert.ok(js.indexOf("'of-a11y'") < js.indexOf("classList.add('js')"), 'the panel\'s part before the rest of the script');
  const css = await (await get('/static/style.css')).text();
  for (const part of ['.a11y-w {', '.a11y-btn {', '.a11y-p {', 'html.a-big body { zoom: 1.2; }', 'html.a-links a {', 'html.a-still *', 'html.a-contrast {']) assert.ok(css.includes(part), `style.css: ${part}`);
});

test('in a real browser: Tab reaches the button, a switch is a class on <html> that survives a reload, Escape and a click outside close the panel, nothing scrolls sideways with the larger text, and the button covers neither bar', async () => {
  const { sid } = fake.session(customer(1));
  let browser;
  try {
    browser = await chromium.launch();
    const open = async (width, height, init = null) => {
      const context = await browser.newContext({ viewport: { width, height }, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      if (init) await context.addInitScript((v) => localStorage.setItem('of-a11y', v), JSON.stringify(init));
      const page = await context.newPage();
      const refused = [];
      page.on('console', (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && refused.push(m.text()));
      page.on('pageerror', (e) => refused.push(e.message));
      return { context, page, refused };
    };
    const state = (page) => page.evaluate(() => ({
      cls: ['big', 'contrast', 'links', 'still'].filter((k) => document.documentElement.classList.contains(`a-${k}`)),
      open: !document.querySelector('.a11y-p').hidden,
      expanded: document.querySelector('.a11y-btn').getAttribute('aria-expanded'),
      focus: document.activeElement?.className || document.activeElement?.tagName,
      saved: localStorage.getItem('of-a11y'),
    }));

    // A phone: the keyboard all the way.
    {
      const { context, page, refused } = await open(390, 844);
      await page.goto(`${base}/`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('.a11y-btn'), true, 'the script shows the button');
      let tabs = 0;
      while (tabs < 120 && !(await page.evaluate(() => document.activeElement?.classList.contains('a11y-btn')))) {
        await page.keyboard.press('Tab');
        tabs++;
      }
      assert.ok(tabs < 120, 'Tab reaches the button');
      assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true, 'its focus shows');
      await page.keyboard.press('Enter');
      assert.deepEqual(await state(page), { cls: [], open: true, expanded: 'true', focus: 'a11y-btn', saved: null });
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.a), 'big', 'Tab goes on into the switches');
      await page.keyboard.press('Enter');
      assert.equal(await page.getAttribute('[data-a="big"]', 'aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      assert.deepEqual(await state(page), { cls: ['big'], open: false, expanded: 'false', focus: 'a11y-btn', saved: '{"big":true}' }, 'Escape closes it and gives the focus back');
      await page.reload({ waitUntil: 'load' });
      assert.deepEqual((await state(page)).cls, ['big'], 'the larger text survives a reload');
      assert.equal(await page.getAttribute('[data-a="big"]', 'aria-pressed'), 'true', 'and its switch says so');
      // A tap outside closes it; the reset takes every switch off.
      await page.click('.a11y-btn');
      await page.click('[data-a="contrast"]');
      assert.deepEqual((await state(page)).cls, ['big', 'contrast']);
      await page.click('h1');
      assert.equal((await state(page)).open, false, 'a tap outside closes it');
      await page.click('.a11y-btn');
      await page.click('[data-a11y-reset]');
      assert.deepEqual(await state(page), { cls: [], open: true, expanded: 'true', focus: 'a11y-reset', saved: '{}' });
      assert.equal(await page.getAttribute('.a11y-end a', 'href'), 'https://openfrequency.co.il/accessibility');
      assert.deepEqual(refused, [], 'no CSP refusal and no error');
      await context.close();
    }

    // Clear of the tab bar and of a post's action bar, with the larger text off and on.
    const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    for (const init of [null, { big: true }]) {
      const { context, page } = await open(390, 844, init);
      for (const p of ['/', `/post/${postId}`]) {
        await page.goto(`${base}${p}`, { waitUntil: 'load' });
        const r = await page.evaluate(() => Object.fromEntries(['.a11y-btn', '.tabbar', '.actionbar'].map((s) => [s, document.querySelector(s)?.getBoundingClientRect().toJSON()])));
        assert.ok(r['.a11y-btn'].bottom <= 844 && r['.a11y-btn'].left >= 0, `${p}: the button on the screen`);
        assert.ok(apart(r['.a11y-btn'], r['.tabbar']), `${p}${init ? ' big' : ''}: not over the tab bar`);
        if (r['.actionbar']) assert.ok(apart(r['.a11y-btn'], r['.actionbar']), `${p}${init ? ' big' : ''}: not over the action bar`);
      }
      await context.close();
    }

    // The larger text on, on a phone: no page scrolls sideways.
    {
      const { context, page, refused } = await open(390, 844, { big: true });
      for (const p of PAGES) {
        await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.documentElement.classList.contains('a-big'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${p} at 390 with the larger text: no sideways scroll`);
      }
      assert.deepEqual(refused, []);
      await context.close();
    }

    // A desk: in the corner, the panel whole on the screen.
    {
      const { context, page } = await open(1440, 900);
      await page.goto(`${base}/`, { waitUntil: 'load' });
      await page.click('.a11y-btn');
      const r = await page.evaluate(() => [document.querySelector('.a11y-btn'), document.querySelector('.a11y-p')].map((e) => e.getBoundingClientRect().toJSON()));
      assert.ok(r[0].left <= 40 && r[0].bottom >= 860, `the button in the bottom corner (${r[0].left}, ${r[0].bottom})`);
      assert.ok(r[1].top >= 0 && r[1].left >= 0 && r[1].right <= 1440 && r[1].bottom <= r[0].top, 'the panel over it, on the screen');
      await page.keyboard.press('Escape');
      assert.equal(await page.isHidden('.a11y-p'), true);
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});
