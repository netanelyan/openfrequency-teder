import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setSetting } from '../src/core/store.js';
import { listen } from '../src/web/server.js';
import { demoPage, offerOf } from '../src/web/demos.js';
import { fakeAccounts, operator, opened, tempHome } from './helpers.js';

// A store's demo page (src/web/demos.js demoPage) is minimal, and shows both of Teder's plans (the owner, 2026-11-01,
// on the live page: "in demo, there is also a cheaper option"; of "ככה מתחילים": "remove that, unnecessary
// information. has to be minimal"; and "also spacing, everywhere, go over that"). The price comes from the offer the
// operator sets on /demos: with the small plan filled in, a card for each plan as openfrequency.co.il shows them
// (openfrequency-web src/sections.mjs tederPricing: the figure, VAT, the slideshows and redos, the setup fee, and its
// own button to accounts' sign-up with &plan=small or full); with only the full plan, the one card it always had.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SIGNUP = 'https://accounts.openfrequency.co.il/signup';
const JOIN = 'https://openfrequency.co.il/join?p=teder';
const FULL = { monthly: 790, setup: 1490, vat: 'excluded' };
const SMALL = { monthly: 490, setup: 990, slideshows: 15, redos: 4 };

let home;
let db;
let fake;
let server;
let base;
let op;
const SLUG = 'kettles-a1b2c3';

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaRoot = home.home;
  const dir = path.join(home.home, 'media', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = (name) => {
    const f = path.join(dir, name);
    writeFileSync(f, PNG);
    return f;
  };
  const shelf = ['קומקום חשמלי', 'קנקן תה מזכוכית', 'סט כוסות תה', 'מסננת תה', 'קופסת תה', 'מגש הגשה'].map((title, i) => ({ title, price: [289, 149.9, 89, 39, 120, 75][i], file: file(`p-${i}.png`) }));
  const t = new Date().toISOString();
  db.insert('demos', {
    slug: SLUG, url: 'https://kettles.example.co.il', domain: 'kettles.example.co.il', status: 'approved', created_at: t, updated_at: t, approved_at: t, approved_by: 'auto',
    // The page beside its products on a desk, with a price range as wide as the hero's numbers get.
    store_json: { name: 'חנות הקומקומים', accent: '#0A7D4F', logo: file('logo.png'), shelf, stats: { products: 128, images: 412, categories: 9, low: 39, high: 1290 } },
    topic_json: { niche: 'הסיפור של התה' },
    docs_json: [{ key: 'w1', title: 'תה (Wikipedia בעברית)' }, { key: 'w2', title: 'קומקום (Wikipedia בעברית)' }],
    post_json: {
      hook: 'התה התחיל בטעות', caption: 'לפי המסורת, התה התחיל בטעות. מה אתם שותים בבוקר?', slides: [{}, { title: 'עלים במים רותחים' }, { title: 'לפני 5000 שנה' }],
      facts: [{ claim: 'לפי המסורת הסינית, התה התגלה לפני 5000 שנה', quote: 'לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה.', url: 'https://he.wikipedia.org/wiki/x', source: 'תה (Wikipedia בעברית)', verified: true }],
      photos: [{ author: 'A' }],
    },
    media_json: { tiktok: [0, 1, 2].map((i) => file(`tt-${i}.png`)), instagram: [0, 1, 2].map((i) => file(`ig-${i}.png`)) },
  });
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
  op = fake.session(operator()).cookie;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie = '') => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/demos', cookie)).text())[1];
const post = async (p, cookie, body = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: await csrfOf(cookie), ...body }).toString() });
const demo = () => {
  const row = db.get('SELECT * FROM demos WHERE slug = ?', SLUG);
  return { ...row, store: JSON.parse(row.store_json), topic: JSON.parse(row.topic_json), docs: JSON.parse(row.docs_json), post: JSON.parse(row.post_json), media: JSON.parse(row.media_json) };
};
const priceOf = (html) => html.match(/<section class="price"[\s\S]*?<\/section>/)?.[0] || '';
const cards = (sec) => sec.match(/<article class="glass plan">[\s\S]*?<\/article>/g) || [];

test('with both plans set, a card for each as on openfrequency.co.il: its figures, VAT, its setup fee and its own way in', () => {
  const sec = priceOf(demoPage(demo(), { offer: { ...FULL, small: SMALL }, join: SIGNUP }));
  assert.match(sec, /<h2 id="price-h">אם תפעילו את תדר<\/h2>/);
  assert.ok(sec.includes('שתי חבילות, לפי מספר המצגות בחודש. כל השאר זהה בשתיהן.'), "the website's line over the cards");
  const [small, full] = cards(sec);
  assert.equal(cards(sec).length, 2, 'two cards');
  assert.ok(small.includes('<h3 class="plan-name">חבילה קטנה</h3>') && full.includes('<h3 class="plan-name">חבילה מלאה</h3>'), 'the small one first');
  assert.ok(small.includes('<span class="num">490</span><span class="cur">₪</span><span class="per">לחודש</span>'));
  assert.ok(full.includes('<span class="num">790</span><span class="cur">₪</span><span class="per">לחודש</span>'));
  for (const c of [small, full]) assert.ok(c.includes('<p class="plan-vat">לא כולל מע״מ</p>'), 'VAT on each');
  assert.ok(small.includes('<b>15</b> מצגות מוצעות בחודש, ועד <b>4</b> החלפות'), "the small plan's slideshows and redos, from the offer");
  assert.ok(full.includes('<b>40</b> מצגות מוצעות בחודש, ועד <b>10</b> החלפות'), "the full plan's, Teder's own (DEFAULT_PLAN)");
  assert.ok(small.includes('בחודש הראשון יש גם 990 ₪ דמי הקמה, פעם אחת. דמי ההקמה לא מוחזרים.'));
  assert.ok(full.includes('בחודש הראשון יש גם 1,490 ₪ דמי הקמה, פעם אחת. דמי ההקמה לא מוחזרים.'));
  // The website's links (openfrequency-web src/lib.mjs signupUrl('teder', plan)), escaped in the attribute.
  assert.ok(small.includes(`<a class="go" href="${SIGNUP}?p=teder&amp;plan=small">להצטרף בחבילה הקטנה</a>`));
  assert.ok(full.includes(`<a class="go" href="${SIGNUP}?p=teder&amp;plan=full">להצטרף בחבילה המלאה</a>`));
  assert.ok(sec.includes('<h3>מה יש בשתי החבילות</h3>'));
  for (const line of ['מצגות בעברית שתדר כותב ומעצב בשבילכם', 'כל מצגת מחכה לאישור שלכם לפני שהיא עולה', 'גרסה חדשה כשמצגת לא יצאה כמו שצריך, עד מספר ההחלפות של החבילה']) assert.ok(sec.includes(`<li>${line}</li>`), line);
  assert.ok(!sec.includes('להפעיל את תדר'), 'each plan has its own way in');

  // A sign-up address that already names the product keeps it; the plan is added.
  const own = priceOf(demoPage(demo(), { offer: { ...FULL, small: SMALL }, join: 'https://accounts.example.test/signup?p=teder' }));
  assert.ok(own.includes('href="https://accounts.example.test/signup?p=teder&amp;plan=small"'), own);

  // Until sign-up is open here, both plans and the website's /join, which takes no plan: one way in under them.
  const closed = priceOf(demoPage(demo(), { offer: { ...FULL, small: SMALL }, join: JOIN }));
  assert.equal(cards(closed).length, 2);
  assert.doesNotMatch(closed, /plan=|להצטרף ב|לא מוחזרים/, 'no plan link and no sign-up terms');
  assert.equal(closed.match(/<a class="go"/g).length, 1);
  assert.ok(closed.includes(`<a class="go" href="${JOIN}">להפעיל את תדר</a>`));

  // VAT included, and a plan with no setup fee says so, as the website does.
  const free = priceOf(demoPage(demo(), { offer: { ...FULL, vat: 'included', small: { ...SMALL, setup: 0 } }, join: SIGNUP }));
  assert.ok(cards(free)[0].includes('<p class="plan-fee">אין דמי הקמה.</p>'));
  assert.ok(cards(free).every((c) => c.includes('<p class="plan-vat">כולל מע״מ</p>')));
});

test('with only the full plan, the one card the page always had; with no price, none', () => {
  const one = (offer) => priceOf(demoPage(demo(), { offer, join: SIGNUP }));
  for (const [offer, why] of [
    [FULL, 'an offer saved before the small plan existed'],
    [{ ...FULL, small: { monthly: null, setup: null, slideshows: null, redos: null } }, 'the small plan left empty'],
    [{ ...FULL, small: { ...SMALL, slideshows: null } }, "the small plan's price without its slideshows"],
    [{ ...FULL, small: { ...SMALL, redos: null } }, 'nor its redos'],
  ]) {
    const sec = one(offer);
    assert.equal(cards(sec).length, 0, why);
    assert.ok(sec.includes('<span class="num">790</span><span class="cur">₪</span><span class="per">לחודש</span>'), why);
    assert.ok(sec.includes('לא כולל מע״מ. בחודש הראשון יש גם 1,490 ₪ דמי הקמה, פעם אחת.'), why);
    assert.ok(sec.includes(`<a class="go" href="${SIGNUP}">להפעיל את תדר</a>`), why);
    assert.ok(sec.includes('<h3>מה כלול במחיר</h3>'), why);
    assert.doesNotMatch(sec, /[^,\d]490|חבילה קטנה|plan=/, why);
  }
  const none = one({ monthly: null, setup: null, vat: null, small: SMALL });
  assert.doesNotMatch(none, /לחודש|490|חבילה קטנה/,'no price until the full plan has one: the small plan alone is not shown');
  assert.ok(none.includes('<h3>מה תדר עושה</h3>') && none.includes('להפעיל את תדר'));
});

test('the operator sets the small plan on /demos; the pages show both; a count that is not a whole number is refused', async () => {
  setSetting(db, 'demo-offer', FULL);
  assert.deepEqual(offerOf(db), { ...FULL, small: { monthly: null, setup: null, slideshows: null, redos: null } }, 'an offer saved before reads with an empty small plan');
  assert.equal(cards(priceOf(await (await get(`/s/${SLUG}`)).text())).length, 0, 'and its pages show one plan');
  const form = await (await get('/demos', op)).text();
  for (const name of ['monthly', 'setup', 'small_monthly', 'small_setup', 'small_slideshows', 'small_redos', 'vat']) assert.match(form, new RegExp(`name="${name}"`), name);
  assert.match(form, /<legend>החבילה המלאה, 40 מצגות ו-10 החלפות בחודש<\/legend>/);
  assert.match(form, /החבילה הקטנה תופיע כשיהיו לה מחיר לחודש, מספר מצגות ומספר החלפות/, 'the operator is told what the small plan needs');

  const body = { monthly: '790', setup: '1,490', vat: 'excluded', small_monthly: '490', small_setup: '990', small_slideshows: '15', small_redos: '4' };
  for (const bad of [{ small_slideshows: '15.5' }, { small_redos: 'abc' }, { small_slideshows: '5000' }, { small_monthly: '-1' }]) {
    assert.equal((await post('/demos/offer', op, { ...body, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(offerOf(db), { ...FULL, small: { monthly: null, setup: null, slideshows: null, redos: null } }, 'nothing refused was kept');
  assert.equal((await post('/demos/offer', op, body)).status, 200);
  assert.deepEqual(offerOf(db), { ...FULL, small: SMALL });
  const sec = priceOf(await (await get(`/s/${SLUG}`)).text());
  assert.equal(cards(sec).length, 2, 'both plans on the live page');
  assert.ok(cards(sec)[0].includes('<span class="num">490</span>') && cards(sec)[1].includes('<span class="num">790</span>'));
  const after = await (await get('/demos', op)).text();
  assert.match(after, /name="small_slideshows" inputmode="numeric" value="15"/);
  assert.ok(after.includes('שתי חבילות, לא כולל מע״מ. הקטנה 490 ₪ לחודש, ועוד 990 ₪ דמי הקמה, פעם אחת, ל-15 מצגות ו-4 החלפות בחודש. המלאה 790 ₪ לחודש, ועוד 1,490 ₪ דמי הקמה, פעם אחת, ל-40 מצגות ו-10 החלפות בחודש.'));
});

test('"ככה מתחילים" is gone, and the page keeps what it is for: the slideshow, the price and the way in', async () => {
  const page = await (await get(`/s/${SLUG}`)).text();
  assert.ok(!page.includes('ככה מתחילים') && !page.includes('links-note'), 'no steps of a sign-up');
  assert.doesNotMatch(readFileSync(new URL('../src/web/static/demo.css', import.meta.url), 'utf8'), /links-note/, 'nor its CSS');
  assert.match(page, new RegExp(`src="/s/${SLUG}/tiktok-0\\.jpg"`), 'the slideshow');
  // Nor the line under the slideshow (the owner, 2026-11-01, chose to cut it); a photo credit alone stays, and only
  // under a slideshow with photographs.
  assert.doesNotMatch(page, /את הנושא בחר תדר|לא שינינו בה מילה/);
  assert.doesNotMatch(page, /<p class="caption">\s*<\/p>/, 'no empty line in its place');
  assert.match(page, /<p class="caption">התמונות מ־<a href="https:\/\/www\.pexels\.com" rel="noopener noreferrer">Pexels<\/a>\.<\/p>/, 'the photographs credited');
  assert.match(page, /<section class="links"[\s\S]*?בתדר אתם בוחרים על מה החשבון כותב/, 'what Teder is');
  assert.ok(priceOf(page).includes('<span class="num">790</span>'), 'the price');
  assert.ok(priceOf(page).includes(`<a class="go" href="${JOIN}">להפעיל את תדר</a>`), 'and the way in');
});

test('in a real browser, at 1440, 390 and 360, light and dark: buttons apart, nothing on a card\'s edge, no word cut, no sideways scroll', async () => {
  const was = process.env.OF_SIGNUP_OPEN;
  let browser;
  try {
    browser = await chromium.launch();
    // Every button 8px or more from every other, side by side or one over the other; every line of text, button and
    // icon in a card 8px or more inside it; no word on a tile cut short; the page as wide as the screen.
    const measure = () => {
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
      };
      const what = (el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} "${(el.textContent || '').trim().slice(0, 30)}"`;
      const page = (el) => {
        const r = el.getBoundingClientRect();
        return { l: r.left + scrollX, r: r.right + scrollX, t: r.top + scrollY, b: r.bottom + scrollY };
      };
      // The two sizes' tabs are one control (a segmented switch), measured as one.
      const buttons = [...document.querySelectorAll('a.go, button, summary, .tabs')].filter(shown);
      const close = [];
      for (let i = 0; i < buttons.length; i++) {
        for (let j = i + 1; j < buttons.length; j++) {
          const [a, b] = [page(buttons[i]), page(buttons[j])];
          const gap = Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b);
          if (gap < 8) close.push(`${what(buttons[i])} and ${what(buttons[j])}: ${Math.round(gap)}px`);
        }
      }
      const edges = [];
      for (const card of [...document.querySelectorAll('.glass, .plan, .stats div, .cap')].filter(shown)) {
        const c = card.getBoundingClientRect();
        const parts = [];
        const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent.trim() || !shown(n.parentElement) || n.parentElement.closest('.d-strip')) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (r.width > 0) parts.push([r, `"${n.textContent.trim().slice(0, 30)}"`]);
        }
        for (const el of card.querySelectorAll('a.go, svg, .tabs, .logo, .initial')) if (shown(el) && !el.closest('.d-strip')) parts.push([el.getBoundingClientRect(), what(el)]);
        for (const [r, part] of parts) {
          const inset = Math.min(r.left - c.left, c.right - r.right, r.top - c.top, c.bottom - r.bottom);
          if (inset < 8) edges.push(`${part} is ${Math.round(inset)}px from the edge of ${what(card)}`);
        }
      }
      const cut = [...document.querySelectorAll('.stats dt, .stats dd')].filter((el) => el.scrollWidth > el.clientWidth + 1).map(what);
      const side = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return { close, edges: [...new Set(edges)], cut, side };
    };
    for (const [offer, signup] of [[{ ...FULL, small: SMALL }, '1'], [{ ...FULL, small: SMALL }, ''], [FULL, '1']]) {
      setSetting(db, 'demo-offer', offer);
      process.env.OF_SIGNUP_OPEN = signup;
      const kind = `${offer.small ? 'two plans' : 'one plan'}, sign-up ${signup ? 'open' : 'closed'}`;
      for (const [width, height] of [[1440, 900], [390, 844], [360, 780]]) {
        for (const colorScheme of ['light', 'dark']) {
          const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce', ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
          const page = await context.newPage();
          await page.goto(`${base}/s/${SLUG}`, { waitUntil: 'load' });
          await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
          const at = `${kind}, ${width} ${colorScheme}`;
          const m = await page.evaluate(measure);
          assert.deepEqual(m.close, [], `${at}: buttons closer than 8px`);
          assert.deepEqual(m.edges, [], `${at}: on a card's edge`);
          assert.deepEqual(m.cut, [], `${at}: words cut on a tile`);
          assert.equal(m.side, 0, `${at}: sideways scroll`);
          if (offer.small) {
            const tops = await page.$$eval('article.plan', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
            assert.equal(tops.length, 2, at);
            if (width === 1440) assert.equal(tops[0], tops[1], `${at}: the two plans side by side`);
            else assert.ok(tops[1] > tops[0], `${at}: one over the other on a phone`);
          }
          await context.close();
        }
      }
    }
  } finally {
    if (was === undefined) delete process.env.OF_SIGNUP_OPEN;
    else process.env.OF_SIGNUP_OPEN = was;
    await browser?.close();
  }
});
