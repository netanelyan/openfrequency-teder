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
import { customer, fakeAccounts, opened, tempHome } from './helpers.js';

// What the owner saw (2026-10-31), "the text is not centered." and "the text in here is without any space. fix every
// visual that is incorrect. also mobile": a sample the checks stopped, on a new account's setup page, drawn with its
// last line on the card's bottom edge; the month on Settings, "החודשנוצלו 0 מתוך 40 הצעות", the label and the count
// glued; and the samples themselves at the foot of that page ("why are the slideshows at the end of the page? make them
// at the top"). Here: each of those as the owner reads it, in the HTML and in a real browser, and the pages a customer
// opens, on a phone of 390 and of 360, with nothing that scrolls sideways.

let home;
let ctx;
let db;
let fake;
let server;
let base;
let postId;
const iso = (ms) => new Date(ms).toISOString();

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  const pack = ctx.pack('demo');
  // One post waiting, with its slides; one sample with its slides, two the checks stopped before they had any.
  const a = await buildPost(ctx, { pack });
  assert.equal(a.status, 'queued', a.reason);
  postId = a.postId;
  const b = await buildPost(ctx, { pack });
  assert.equal(b.status, 'queued', b.reason);
  db.run("UPDATE posts SET status = 'sample', sample = 1 WHERE id = ?", b.postId);
  await closeBrowser();
  // The two stopped ones were written first, so on a desk they are the first row, side by side, as the owner saw them.
  const t = iso(Date.now());
  const earlier = iso(Date.now() - 3_600_000);
  for (const id of ['p-lay-stop-1', 'p-lay-stop-2']) db.insert('posts', { id, account_id: 'demo', status: 'blocked', reason: 'refused', hook: null, topic: null, sample: 1, created_at: earlier, updated_at: earlier });
  // And a post of the account the checks stopped before it had slides.
  db.insert('posts', { id: 'p-lay-blocked', account_id: 'demo', status: 'blocked', reason: 'cover: 2 lines of text', hook: 'נעלי ריצה', topic: null, sample: 0, created_at: earlier, updated_at: earlier });
  db.insert('onboarding', { id: 'o-lay', seed_json: { niche: 'צמחי בית' }, status: 'samples', pack_id: 'demo', workspace_id: 1, candidates_json: { samples: { made: 1, failure: 'refused', at: t } }, created_at: t, updated_at: t });

  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'l'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  // /styles draws its previews on request, with the renderer's browser.
  await closeBrowser();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

test('the month on Settings: the label and the count are apart, never "החודשנוצלו"', async () => {
  const html = await (await get('/settings', fake.session(customer(1)).cookie)).text();
  assert.match(html, /<div class="row"><span>החודש<\/span> <b class="num">נוצלו \d+ מתוך 40 הצעות · \d+ מתוך 10 החלפות<\/b><\/div>/);
  assert.doesNotMatch(html, /החודש<\/span><b/);
});

test('the setup page opens on its samples: the count, the buttons and the cards first, then the account, its networks and its days', async () => {
  const html = await (await get('/new/o-lay', fake.session(customer(1)).cookie)).text();
  const first = html.indexOf('<article class="card acc acc-demo post');
  assert.ok(first > 0, 'the cards are there');
  const count = html.indexOf('דוגמה אחת עברה את כל הבדיקות. צריך לפחות 3 כדי להמשיך.');
  const more = html.indexOf(`action="/new/o-lay/samples"`);
  const connect = html.indexOf('id="connect"');
  const schedule = html.indexOf('id="schedule"');
  assert.ok(count > 0 && more > 0 && count < first && more < first, 'how many passed and the button for more, over the cards');
  assert.ok(first < connect && connect < schedule, 'then the networks, then the days and times');
  assert.ok(html.indexOf('<section class="samples" id="samples"') < html.indexOf('החשבון נוצר.'), 'the account panel after the samples');
  // Every card is in the samples' block: the two stopped ones and the one with slides.
  const block = html.slice(html.indexOf('id="samples"'), connect);
  assert.equal((block.match(/<article class="card acc acc-demo post/g) || []).length, 3);
  assert.equal((block.match(/מצגת שלא הושלמה/g) || []).length, 2);
});

test('a post the checks stopped before it had slides: its page draws no "TikTok view" over nothing and no empty caption', async () => {
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/post/p-lay-blocked', cookie)).text();
  assert.match(html, /<section class="card acc acc-demo post stopped">/);
  assert.doesNotMatch(html, /תצוגת טיקטוק|class="capwrap"|<h3 class="lbl">/);
  // One with slides keeps them, the view and its caption.
  const full = await (await get(`/post/${postId}`, cookie)).text();
  assert.match(full, /<section class="card acc acc-demo post"><div class="meta">/);
  assert.match(full, /<h3 class="lbl">טיקטוק <span>9:16<\/span><\/h3><input type="checkbox" class="ttv"[^>]*><label class="ttv-l"[^>]*>[^]*?תצוגת טיקטוק<\/label><div class="strip"/);
  assert.match(full, /<div class="capwrap"><p class="caption">/);
});

test('the slide styles page: every style\'s previews are images, the fifth (E, נייטיב) too, never a broken one', async () => {
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/styles', cookie)).text();
  const srcs = [...html.matchAll(/<img src="(\/styles\/img\/demo\/[\w-]+\/([A-Z])\/\d+)"/g)];
  assert.deepEqual([...new Set(srcs.map((m) => m[2]))], ['A', 'B', 'C', 'D', 'E'], 'a column a style');
  for (const [, src] of srcs) {
    const res = await get(src, cookie);
    assert.equal(res.status, 200, src);
    assert.equal(res.headers.get('content-type'), 'image/jpeg', src);
    await res.arrayBuffer();
  }
  assert.equal((await get(srcs[0][1].replace(/\/[A-Z]\/(\d+)$/, '/Z/$1'), cookie)).status, 404, 'a style that does not exist has no preview');
});

test('in a real browser: a stopped sample keeps its words off the card\'s edge, the month reads apart, and no customer page scrolls sideways on a phone', async () => {
  const { sid } = fake.session(customer(1));
  let browser;
  try {
    browser = await chromium.launch();
    const open = async (url, width, height, colorScheme = 'light') => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
      return page;
    };
    const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // A: the stopped samples, side by side on a desk and one under the other on a phone.
    for (const [width, height, scheme] of [[1440, 900, 'light'], [390, 844, 'dark'], [360, 780, 'light']]) {
      const page = await open('/new/o-lay', width, height, scheme);
      // The cards with no slides, found by what they are (no strip), not by the class the fix gave them.
      const stopped = 'article.post:not(:has(.strip))';
      const cards = await page.$$eval(stopped, (els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const parts = [...el.querySelectorAll('.chip, .hook, .subline')].map((x) => x.getBoundingClientRect());
          return { above: Math.min(...parts.map((q) => q.top)) - r.top, below: r.bottom - Math.max(...parts.map((q) => q.bottom)), clipped: el.scrollHeight - el.clientHeight };
        })
      );
      assert.equal(cards.length, 2, `${width}: both stopped samples`);
      for (const c of cards) {
        assert.ok(c.below >= 16, `${width}: the last line is ${c.below}px from the card's bottom edge`);
        assert.ok(Math.abs(c.above - c.below) <= 6, `${width}: the words sit in the middle of the card (${c.above}px over, ${c.below}px under)`);
        assert.ok(c.clipped <= 1, `${width}: nothing cut off`);
      }
      if (width === 1440) {
        const tops = await page.$$eval(stopped, (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
        assert.equal(tops[0], tops[1], 'two side by side on a desk');
      }
      assert.equal(await sideways(page), 0, `${width}: no sideways scroll`);
      await page.context().close();
    }

    // B: the label and the count of the month, apart on the same line (or on two), never touching.
    for (const width of [1440, 390, 360]) {
      const page = await open('/settings', width, 900);
      const gap = await page.$eval('#plan .row', (row) => {
        const [a, b] = [...row.children].map((x) => x.getBoundingClientRect());
        const sameLine = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < Math.min(a.height, b.height) / 2;
        return sameLine ? Math.max(a.left - b.right, b.left - a.right) : 99;
      });
      assert.ok(gap >= 8, `${width}: ${gap}px between "החודש" and the count`);
      await page.context().close();
    }

    // Every page a customer opens, on two phones: nothing past the screen's edge, the account's name readable in the
    // bar, and a post's slides with the first one's dot lit.
    const pages = ['/', '/posts', `/post/${postId}`, '/accounts', '/results', '/sources', '/facts', '/topics', '/rivals', '/sounds', '/settings', '/more', '/styles', '/new', '/new/o-lay'];
    for (const [width, height] of [[390, 844], [360, 780]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, colorScheme: 'light' });
      await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
      const page = await context.newPage();
      for (const url of pages) {
        await page.goto(`${base}${url}`, { waitUntil: 'domcontentloaded' });
        assert.equal(await sideways(page), 0, `${url} at ${width}: no sideways scroll`);
      }
      await page.goto(`${base}/posts`, { waitUntil: 'domcontentloaded' });
      const name = await page.$eval('.acctswitch > summary .nm b', (b) => ({ shown: b.clientWidth, needs: b.scrollWidth }));
      assert.ok(name.shown >= name.needs, `${width}: the account's name whole in the bar (${name.shown} of ${name.needs}px)`);
      await page.waitForFunction(() => document.querySelector('.dots i.on'));
      assert.equal(await page.$eval('.dots', (d) => [...d.children].findIndex((i) => i.classList.contains('on'))), 0, `${width}: the first slide's dot, as the first slide shows`);
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});
