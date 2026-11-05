import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { __onboarding } from '../src/web/onboarding.js';
import { setupOf } from '../src/onboarding/setup.js';
import { DEFAULT_PICKED, LIBRARY, pickedOf } from '../src/formats/library.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, listenFree, opened, paidWorkspaces, tempHome } from './helpers.js';

// The owner, 2026-11-05, on /new's sources step on a desk: "the page is very strange when setting up. i think setting up
// should be step by step, not 2 blocks near each other. if 2 blocks are near each other, why do some have an empty space
// near them..?" /new is one column in every state, and the setup is steps (src/web/onboarding.js steps, static/app.js):
// one shown at a time, "שלב 2 מתוך 4", "הקודם" and one main button, the step kept in the address. Without the script
// every step shows, numbered, in order. A create the server refuses comes back to the step whose field it is, its words
// right above that step's button (the owner pressed "ליצור את החשבון" and saw the same page, the button looking stuck).

let home;
let ctx;
let db;
let fake;
let server;
let base;
let sid;
let cookie;

const T = new Date().toISOString();
const cand = (id, over = {}) => ({ id, type: 'web', url: `https://${id}.example.org/`, name: `Site ${id}`, origin: 'brave', score: { authority: 8, freshness: 7, terms: 'ok', reason: 'גוף תקשורת מבוסס', relevance: 9, relevanceReason: 'x', by: 'heuristic' }, ...over });
const review = (id, ws = 1) =>
  db.insert('onboarding', { id, seed_json: { niche: 'צמחי בית' }, status: 'review', workspace_id: ws, candidates_json: { candidates: [cand('c1'), cand('c2'), cand('c3')] }, setup_json: { displayName: 'משתלת הכפר' }, created_at: T, updated_at: T });

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  // The demo account is another workspace's: workspace 1 has none yet, and may make its one.
  db.run("UPDATE accounts SET workspace_id = 9 WHERE id = 'demo'");
  paidWorkspaces(db, [1, 2, 3]);
  for (const [id, ws] of [['o-steps', 1], ['o-refused', 2], ['o-nojs', 3]]) review(id, ws);
  db.insert('onboarding', { id: 'o-wait', seed_json: { niche: 'צמחי בית' }, status: 'discovering', workspace_id: 1, created_at: T, updated_at: T });
  __onboarding.running.set('o-wait', new Promise(() => {}));
  fake = await fakeAccounts();
  ({ sid, cookie } = fake.session(customer(1)));
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'z'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  __onboarding.running.delete('o-wait');
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = async (p, c = cookie) => (await fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie: c } })).text();
const csrfOf = async (c) => /name="_csrf" value="([^"]+)"/.exec(await get('/new', c))[1];
const post = async (p, c, body) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie: c, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrfOf(c), ...body }).toString() });
const order = (html, marks) => marks.map((m) => html.indexOf(m));

test('the sources step is four steps in one form, in order, numbered, one column; the operator-free page has no connecting, no days and times and no two columns', async () => {
  const html = await get('/new/o-steps');
  assert.doesNotMatch(html, /class="cols|class="grid12/, 'no two columns');
  const at = order(html, ['action="/new/o-steps/create" id="sources"', 'id="step-1" data-step="1" data-step-key="sources"', 'id="step-2" data-step="2" data-step-key="formats"', 'id="step-3" data-step="3" data-step-key="promo"', 'id="step-4" data-step="4" data-step-key="name"', 'ליצור את החשבון', '</form>']);
  assert.ok(at.every((x) => x >= 0), `every part is there: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order, the create button last, inside the form');
  for (const [n, label] of [[1, 'המקורות'], [2, 'סוגי המצגות'], [3, 'השקף האחרון'], [4, 'השם שלכם על המצגות']]) {
    assert.match(html, new RegExp(`data-step="${n}"[^>]*aria-label="${label}">\\n<p class="stepline" tabindex="-1"><span>שלב ${n} מתוך 4</span>`), `step ${n}: ${label}, numbered`);
  }
  // Each step's buttons: "הקודם" from the second, "הבא" until the last, whose one main button makes the account.
  const navs = [...html.matchAll(/<div class="stepnav">(.*?)<\/div><\/section>/g)].map((m) => m[1]);
  assert.equal(navs.length, 4);
  assert.equal(navs[0], '<button class="btn primary" type="button" data-step-go="next">הבא</button>');
  for (const nav of navs.slice(1, 3)) assert.equal(nav, '<button class="btn ghost" type="button" data-step-go="prev">הקודם</button><button class="btn primary" type="button" data-step-go="next">הבא</button>');
  assert.match(navs[3], /^<button class="btn ghost" type="button" data-step-go="prev">הקודם<\/button><button class="btn primary" type="submit"><svg[^]*<\/svg>ליצור את החשבון<\/button>$/);
  assert.equal((html.match(/class="btn primary"/g) || []).length, 4, 'one main button a step');
  assert.doesNotMatch(html, /id="connect"|id="schedule"|data-mfold=/, 'connecting and the days come after the account exists; nothing folds in a step');
  const words = html.slice(html.indexOf('<main'), html.indexOf('</main>')).replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(words, /[—–!]/, 'no dashes, no exclamation marks');
  // The list of setups is one column too.
  assert.doesNotMatch(await get('/new'), /class="cols|class="grid12/);
});

test('while the sources are searched: the progress first, then the name, the closing slide and the days as steps, each sent by its own button, and connecting after them', async () => {
  const html = await get('/new/o-wait');
  assert.doesNotMatch(html, /class="cols|class="grid12/);
  const at = order(html, ['id="progress"', 'data-step="1" data-step-key="name"', 'data-step="2" data-step-key="promo"', 'data-step="3" data-step-key="schedule"', 'id="connect"']);
  assert.ok(at.every((x) => x >= 0), `${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  assert.match(html, /<form method="post" action="\/new\/o-wait\/name" class="formgrid" id="name-form">/);
  assert.match(html, /<button class="btn primary" type="submit" form="name-form">הבא<\/button>/);
  assert.match(html, /<button class="btn primary" type="submit" form="promo-form">הבא<\/button>/);
  assert.match(html, /<button class="btn primary" type="submit" form="schedule-form">שמירה<\/button>/);
  assert.match(html, /<form method="post" action="\/new\/o-wait\/schedule" class="prefs" id="schedule-form">/);
  assert.equal((html.match(/<button class="btn" type="submit">שמירה<\/button>/g) || []).length, 0, "no save button of a panel's own beside the step's");
  // Each one saved moves on to the next step.
  const r = await post('/new/o-wait/name', cookie, { displayName: 'משתלת הכפר', handle: 'mishtala' });
  assert.equal(r.headers.get('location'), '/new/o-wait#step-2');
  const bad = await post('/new/o-wait/name', cookie, { displayName: 'משתלת הכפר', handle: 'משתלה' });
  assert.equal(bad.headers.get('location'), '/new/o-wait#name', 'a refusal comes back to the step it is in');
});

test('a create the server refuses comes back to the step whose field it is, with the words right above its button in role="alert"', async () => {
  const c = fake.session(customer(2)).cookie;
  // A handle another account has: the name step, the last one.
  let r = await post('/new/o-refused/create', c, { approve_c1: 'on', formats_shown: '1', fmt_facts: 'on', fmt_tips: 'on', fmt_story: 'on', displayName: 'משתלת הכפר', handle: 'demo' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/new/o-refused#step-4');
  let html = await get('/new/o-refused', c);
  const said = setupOf(db, 'o-refused').refused;
  assert.equal(said.step, 'name');
  const step4 = html.slice(html.indexOf('id="step-4"'), html.indexOf('</section>', html.lastIndexOf('<div class="stepnav">')));
  assert.match(step4, new RegExp(`<p class="problems steperr" role="alert"><b>${said.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</b></p>\\n<div class="stepnav"><button class="btn ghost" type="button" data-step-go="prev">הקודם</button><button class="btn primary" type="submit">`), 'right above the create button');
  assert.equal((html.match(/role="alert"/g) || []).length, 1, 'once, on that step');
  assert.match(html, /name="handle"[^>]*value="demo"/, 'what was typed is kept');
  // Two kinds of slideshow: the kinds' step, its words above its "הבא".
  r = await post('/new/o-refused/create', c, { approve_c1: 'on', formats_shown: '1', fmt_facts: 'on', fmt_tips: 'on', displayName: 'משתלת הכפר', handle: 'mishtala.two' });
  assert.equal(r.headers.get('location'), '/new/o-refused#step-2');
  html = await get('/new/o-refused', c);
  assert.match(html, /<p class="problems steperr" role="alert"><b>צריך לבחור לפחות 3 סוגים[^<]*<\/b><\/p>\n<div class="stepnav"><button class="btn ghost" type="button" data-step-go="prev">הקודם<\/button><button class="btn primary" type="button" data-step-go="next">הבא<\/button>/);
  assert.equal((html.match(/role="alert"/g) || []).length, 1, 'the earlier refusal is done with');
});

test('in a real browser: one step at a time, "הבא" and "הקודם", the step in the address through a reload and Back, "הבא" held by a field that is not valid, create sends every field, a refusal back on its step, and without the script every step in order', async () => {
  let browser;
  try {
    browser = await chromium.launch();
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, ...(width < 700 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
      const shown = () => page.evaluate(() => [...document.querySelectorAll('[data-step]')].filter((s) => s.checkVisibility()).map((s) => Number(s.dataset.step)));
      const hash = () => page.evaluate(() => location.hash);
      const step = (n) => `[data-step="${n}"]`;

      await page.goto(`${base}/new/o-steps`, { waitUntil: 'load' });
      assert.deepEqual(await shown(), [1], `${width}: the first step alone`);
      assert.equal(await page.isVisible(`${step(1)} .stepline`), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${width}: nothing sideways`);
      await page.click(`${step(1)} [data-step-go="next"]`);
      assert.deepEqual(await shown(), [2]);
      assert.equal(await hash(), '#step-2');
      // The step is kept through a reload and Back.
      await page.reload({ waitUntil: 'load' });
      assert.deepEqual(await shown(), [2], `${width}: the reload keeps the step`);
      await page.click(`${step(2)} [data-step-go="next"]`);
      assert.deepEqual(await shown(), [3]);
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#step-2');
      assert.deepEqual(await shown(), [2], 'Back goes to the step before');
      await page.click(`${step(2)} [data-step-go="prev"]`);
      assert.deepEqual(await shown(), [1]);
      assert.equal(await hash(), '#step-1');

      // A field of a step that is not valid holds "הבא": the browser says why, on it.
      await page.goto(`${base}/new/o-steps#step-3`, { waitUntil: 'load' });
      assert.deepEqual(await shown(), [3], 'a link to a step opens it');
      await page.evaluate(() => { document.querySelector('[name=promo_promise]').required = true; });
      await page.click(`${step(3)} [data-step-go="next"]`);
      assert.deepEqual(await shown(), [3], `${width}: "הבא" does not move on`);
      assert.equal(await hash(), '#step-3');
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'promo_promise', 'the field is the one in focus');
      assert.ok(await page.evaluate(() => document.activeElement.validationMessage.length > 0), "the browser's own message");
      // The create button with a field not valid in another step: that step shows, and the field says why.
      await page.fill('[name=promo_promise]', '');
      await page.evaluate(() => { location.hash = '#step-4'; });
      await page.waitForFunction(() => document.querySelector('[data-step="4"]').checkVisibility());
      await page.click(`${step(4)} button[type=submit]`);
      assert.deepEqual(await shown(), [3], 'back to the step with the field');
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'promo_promise');
      // Step 4's own required field holds the create button (a fresh page: the hash alone would keep this one).
      await page.goto(`${base}/new/o-steps#step-4`, { waitUntil: 'load' });
      await page.reload({ waitUntil: 'load' });
      await page.fill('[name=handle]', '');
      await page.click(`${step(4)} button[type=submit]`);
      assert.deepEqual(await shown(), [4]);
      assert.equal(await page.evaluate(() => location.pathname), '/new/o-steps', 'nothing sent');
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'handle');
      // Enter in a field of an earlier step goes to the next one, never sends the form from there.
      await page.goto(`${base}/new/o-steps#step-3`, { waitUntil: 'load' });
      await page.reload({ waitUntil: 'load' });
      await page.press('[name=promo_name]', 'Enter');
      assert.deepEqual(await shown(), [4], 'Enter moves on');
      assert.equal(await page.evaluate(() => location.pathname), '/new/o-steps');
      assert.deepEqual(errors, [], 'no error, no CSP refusal');
      await context.close();
    }

    // Create sends every step's fields, walked through one step at a time.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/new/o-steps`, { waitUntil: 'load' });
      await page.uncheck('[name=approve_c3]');
      await page.click('[data-step="1"] [data-step-go="next"]');
      await page.check('[name=fmt_iceberg]');
      await page.click('[data-step="2"] [data-step-go="next"]');
      await page.fill('[name=promo_promise]', 'צמחי בית ועציצים, עם הוראות טיפול לכל צמח');
      await page.fill('[name=promo_site]', 'mishtala.example.co.il');
      await page.click('[data-step="3"] [data-step-go="next"]');
      await page.fill('[name=handle]', 'mishtala.kfar');
      await Promise.all([page.waitForURL(/\/new\/o-steps$/), page.click('[data-step="4"] button[type=submit]')]);
      const acc = db.get("SELECT id, display_name, handle FROM accounts WHERE workspace_id = 1");
      assert.deepEqual([acc?.display_name, acc?.handle], ['משתלת הכפר', 'mishtala.kfar'], 'the name step');
      const pack = ctx.pack(acc.id) || loadAll({ dir: path.join(home.home, 'packs') }).find((p) => p.id === acc.id);
      const ob = db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-steps'");
      const approved = JSON.parse(ob.candidates_json).candidates.filter((x) => x.approved).map((x) => x.id);
      assert.deepEqual(approved, ['c1', 'c2'], 'the sources step');
      assert.deepEqual(pickedOf(pack), [...DEFAULT_PICKED, 'iceberg'].filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => LIBRARY.findIndex((f) => f.id === a) - LIBRARY.findIndex((f) => f.id === b)), 'the kinds step');
      assert.equal(pack.meta.promo?.promise, 'צמחי בית ועציצים, עם הוראות טיפול לכל צמח', 'the closing slide step');
      await context.close();
    }

    // A refusal in a real browser: back on the name step, the words above the button, the button not busy.
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'of_session', value: fake.session(customer(2)).sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/new/o-refused#step-4`, { waitUntil: 'load' });
      await page.click('[data-step="4"] [data-step-go="prev"]');
      await page.click('[data-step="3"] [data-step-go="prev"]');
      await page.check('[name=fmt_story]');
      await page.click('[data-step="2"] [data-step-go="next"]');
      await page.click('[data-step="3"] [data-step-go="next"]');
      await page.fill('[name=handle]', 'demo');
      await Promise.all([page.waitForNavigation(), page.click('[data-step="4"] button[type=submit]')]);
      await page.waitForLoadState('load');
      assert.equal(await page.evaluate(() => location.hash), '#step-4');
      assert.equal(await page.isVisible('[data-step="4"] [role=alert]'), true, 'the words, on the step shown');
      const gap = await page.evaluate(() => {
        const a = document.querySelector('[data-step="4"] [role=alert]').getBoundingClientRect();
        const b = document.querySelector('[data-step="4"] button[type=submit]').getBoundingClientRect();
        return b.top - a.bottom;
      });
      assert.ok(gap >= 0 && gap < 40, `right above the button (${gap}px)`);
      assert.equal(await page.getAttribute('[data-step="4"] button[type=submit]', 'aria-busy'), null, 'the button is not busy');
      await context.close();
    }

    // While the sources are searched: the progress, then one step; "הבא" saves the step and opens the next, and a field
    // that is not valid holds it.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      const shown = () => page.evaluate(() => [...document.querySelectorAll('[data-step]')].filter((s) => s.checkVisibility()).map((s) => Number(s.dataset.step)));
      await page.goto(`${base}/new/o-wait`, { waitUntil: 'load' });
      assert.equal(await page.isVisible('#progress'), true, 'the progress first');
      assert.deepEqual(await shown(), [1]);
      await page.fill('[name=handle]', '');
      await page.click('[data-step="1"] button[form="name-form"]');
      assert.equal(await page.evaluate(() => document.activeElement?.name), 'handle', 'held on the field');
      assert.equal(await page.evaluate(() => location.hash), '', 'nothing sent');
      // (A name of its own: the account made above has משתלת הכפר.)
      await page.fill('[name=displayName]', 'משתלת העמק');
      await page.fill('[name=handle]', 'mishtala.wait');
      await Promise.all([page.waitForURL(/#step-2$/), page.click('[data-step="1"] button[form="name-form"]')]);
      await page.waitForLoadState('load');
      assert.deepEqual(await shown(), [2], 'saved, and on to the closing slide');
      assert.equal(setupOf(db, 'o-wait').handle, 'mishtala.wait');
      await context.close();
    }

    // Without the script: every step, numbered, in order, the create button at the end and no "הבא" or "הקודם".
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
      await context.addCookies([{ name: 'of_session', value: fake.session(customer(3)).sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}/new/o-nojs`, { waitUntil: 'load' });
      const m = await page.evaluate(() => {
        const steps = [...document.querySelectorAll('[data-step]')];
        const tops = steps.map((s) => s.getBoundingClientRect().top);
        const lefts = steps.map((s) => Math.round(s.getBoundingClientRect().left));
        return {
          visible: steps.filter((s) => s.checkVisibility()).length,
          lines: steps.map((s) => s.querySelector('.stepline').textContent),
          ordered: tops.every((t, i) => !i || t > tops[i - 1]),
          oneColumn: new Set(lefts).size === 1,
          goes: [...document.querySelectorAll('[data-step-go]')].filter((b) => b.checkVisibility()).length,
          create: document.querySelector('[data-step="4"] button[type=submit]').checkVisibility(),
        };
      });
      assert.equal(m.visible, 4, 'every step shows');
      assert.deepEqual(m.lines, ['שלב 1 מתוך 4', 'שלב 2 מתוך 4', 'שלב 3 מתוך 4', 'שלב 4 מתוך 4']);
      assert.ok(m.ordered && m.oneColumn, 'one under the other, in one column');
      assert.equal(m.goes, 0, 'no button that needs the script');
      assert.equal(m.create, true, 'the create button at the end');
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});
