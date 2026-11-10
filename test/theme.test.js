import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { THEME_COLOR, THEME_COOKIE, themeCookie, themeFrom } from '../src/web/static/theme.js';
import { layout, themeButton, themeOf } from '../src/web/ui.js';
import { errorPage, gatePage } from '../src/web/pages.js';
import { goPage } from '../src/web/connect.js';
import { demoPage, goneHtml } from '../src/web/demos.js';
import { readDemo } from '../src/demos/build.js';
import { customer, fakeAccounts, listenFree, opened, tempHome } from './helpers.js';
import { lookSheet } from '../src/web/look.js';

// Light or dark, one choice for every OpenFrequency site (the owner, 2026-11-02: "make sure that every repo starts on
// light mode. changing it on one subdomain changes it on all of the subdomains"). The four repos keep one contract: the
// cookie of-theme, "light" or "dark", under openfrequency.co.il for every subdomain (Path=/, a year, SameSite=Lax,
// Secure on https), host-only anywhere else; no cookie or any other value is light, and the device's setting is never
// followed. The server renders <html data-theme>, the color-scheme and one theme-color from the request, on every page
// it builds; the website's own button flips it, writes the cookie and the colours. Here: the cookie as the browser
// writes it, every page head for no cookie, dark and junk, the switch on the pages people use, no dark rule left on the
// device's setting, and in a real browser the switch, the next page, and the cookie crossing to another subdomain.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = 'theme-shop-a1b2c3';

let home;
let db;
let fake;
let server;
let base;
let paid;
let unpaid;
let long;
// The longest name an account may have (30 characters, pack validate.js), in the bar's pill on a phone.
const LONG = 'בישול טבעוני לסטודנטים בתקציב';

before(async () => {
  home = tempHome({
    packs: {
      demo: null,
      longname: (f) => {
        f.pack.displayName = LONG;
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'longname'");
  const t = new Date().toISOString();
  db.insert('demos', {
    slug: SLUG, url: 'https://shop.example.co.il', domain: 'shop.example.co.il', status: 'approved', created_at: t, updated_at: t, approved_at: t, approved_by: 'auto',
    store_json: { name: 'חנות לדוגמה', stats: { products: 12 } }, topic_json: { niche: 'תה' }, docs_json: [], post_json: { hook: 'וו', caption: 'כיתוב', slides: [{}] }, media_json: {},
  });
  fake = await fakeAccounts();
  fake.entitlement(3, 'unpaid');
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 't'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
  paid = fake.session(customer(1));
  unpaid = fake.session(customer(3));
  long = fake.session(customer(2));
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie = '') => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

test('the cookie, as the browser writes it: shared under openfrequency.co.il, this host\'s alone anywhere else, Secure on https', () => {
  assert.equal(THEME_COOKIE, 'of-theme');
  assert.deepEqual(THEME_COLOR, { light: '#eeeff2', dark: '#111113' });
  const at = (hostname, protocol, theme = 'dark') => themeCookie(theme, { hostname, protocol });
  assert.equal(at('teder.openfrequency.co.il', 'https:'), 'of-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.openfrequency.co.il; Secure');
  assert.equal(at('openfrequency.co.il', 'https:', 'light'), 'of-theme=light; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.openfrequency.co.il; Secure');
  assert.equal(at('Accounts.OpenFrequency.co.il', 'https:'), 'of-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Domain=.openfrequency.co.il; Secure', 'the name in any case');
  assert.equal(at('localhost', 'http:'), 'of-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax', 'a laptop: this host alone, no Secure on http');
  assert.equal(at('127.0.0.1', 'http:'), 'of-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax');
  assert.equal(at('localhost', 'https:'), 'of-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
  for (const other of ['openfrequency.co.il.example.com', 'notopenfrequency.co.il', 'openfrequency.co']) assert.doesNotMatch(at(other, 'https:'), /Domain/, `${other} is not ours`);
  assert.match(at('localhost', 'http:', 'blue'), /^of-theme=light;/, 'anything but dark is written as light');
  // What the browser sends back, read the way the server reads it.
  assert.equal(themeFrom('a=1; of-theme=dark; b=2'), 'dark');
  for (const c of ['', 'of-theme=light', 'of-theme=darkish', 'of-theme=DARK', 'xof-theme=dark', 'of_theme=dark']) assert.equal(themeFrom(c), 'light', c);
  assert.equal(themeOf({ 'of-theme': 'dark' }), 'dark');
  for (const jar of [undefined, {}, { 'of-theme': 'light' }, { 'of-theme': 'Dark' }, { 'of-theme': '<b>' }, { of_theme: 'dark' }]) assert.equal(themeOf(jar), 'light', JSON.stringify(jar));
});

/** The head a page in `theme` has: data-theme on <html>, its color-scheme, one theme-color in its colour, nothing for the device. */
function assertHead(html, theme, where) {
  assert.match(html, new RegExp(`^<!doctype html>\\s*<html lang="he" dir="rtl" data-theme="${theme}"`), `${where}: <html> in ${theme}`);
  assert.equal((html.match(/<meta name="color-scheme"/g) || []).length, 1, `${where}: one color-scheme`);
  assert.ok(html.includes(`<meta name="color-scheme" content="${theme}">`), `${where}: color-scheme ${theme}`);
  assert.deepEqual(html.match(/<meta name="theme-color"[^>]*>/g), [`<meta name="theme-color" content="${THEME_COLOR[theme]}">`], `${where}: one theme-color, ${THEME_COLOR[theme]}`);
  assert.doesNotMatch(html, /prefers-color-scheme|content="light dark"/, `${where}: nothing follows the device`);
}

/** The switch: the website's button, pressed while dark, invisible until its script runs, and that script. */
function assertSwitch(html, theme, where) {
  assert.equal((html.match(/data-theme-toggle/g) || []).length, 1, `${where}: one switch`);
  assert.ok(html.includes(themeButton(theme)), `${where}: the switch as ui.js builds it`);
  assert.match(themeButton(theme), new RegExp(`^<button class="theme" type="button" data-theme-toggle aria-pressed="${theme === 'dark'}" aria-label="מצב כהה"><svg class="moon" [^]*</svg><svg class="sun" [^]*</svg></button>$`));
  assert.match(html, /<script type="module" src="\/static\/theme\.js\?v=\w+"><\/script>/, `${where}: its script`);
  const at = html.indexOf('data-theme-toggle');
  const form = html.lastIndexOf('<form', at);
  assert.ok(form === -1 || html.indexOf('</form>', form) < at, `${where}: the switch is in no form`);
}

test('every page the server builds arrives in the browser\'s choice: no cookie and junk are light, of-theme=dark is dark, whatever else is in the cookie', async () => {
  const pages = [
    ['home', '/', paid.cookie, 200],
    ['posts', '/posts', paid.cookie, 200],
    ['accounts', '/accounts', paid.cookie, 200],
    ['settings', '/settings', paid.cookie, 200],
    ['a page that does not exist', '/no-such-page', paid.cookie, 404],
    ['the paywall', '/', unpaid.cookie, 402],
    ["a store's demo page", `/s/${SLUG}`, '', 200],
    ['a demo page that is gone', '/s/no-such-shop', '', 404],
    ['a connect link past its time', '/connect/demo/tiktok', '', 404],
  ];
  for (const [jar, theme] of [['', 'light'], ['of-theme=light', 'light'], ['of-theme=dark', 'dark'], ['of-theme=blue', 'light'], ['of-theme=', 'light'], ['of-theme=DARK', 'light'], ['of_theme=dark', 'light']]) {
    for (const [where, p, session, status] of pages) {
      const res = await get(p, [session, jar].filter(Boolean).join('; '));
      assert.equal(res.status, status, `${where} (${jar || 'no cookie'})`);
      const html = await res.text();
      assertHead(html, theme, `${where} (${jar || 'no cookie'})`);
      assertSwitch(html, theme, `${where} (${jar || 'no cookie'})`);
    }
    // A page that answers a refused form: the stale form's page.
    const stale = await fetch(`${base}/settings/kill`, { method: 'POST', redirect: 'manual', headers: { cookie: [paid.cookie, jar].filter(Boolean).join('; '), 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=old' });
    assert.equal(stale.status, 403);
    const html = await stale.text();
    assertHead(html, theme, `a stale form (${jar || 'no cookie'})`);
    assertSwitch(html, theme, `a stale form (${jar || 'no cookie'})`);
  }
  // Each builder on its own, the pages above and the one that goes on to Zernio.
  const demo = readDemo(db.get('SELECT * FROM demos WHERE slug = ?', SLUG));
  for (const theme of ['light', 'dark']) {
    for (const [where, html] of [
      ['layout', layout({ title: 'x', active: 'today', csrf: 'c', theme }, '<h1>x</h1>')],
      ['gatePage', gatePage({ kind: 'unpaid', links: { setup: '/s', logout: '/o', home: '/' }, theme })],
      ['errorPage', errorPage({ kind: 'broken', theme })],
      ['goPage', goPage('https://zernio.example/connect', { name: 'טיקטוק', theme })],
      ['demoPage', demoPage(demo, { offer: {}, theme })],
      ['goneHtml', goneHtml(theme)],
    ]) {
      assertHead(html, theme, `${where} ${theme}`);
      assertSwitch(html, theme, `${where} ${theme}`);
    }
  }
  // Without one, a builder's page is light.
  for (const [where, html] of [['layout', layout({ title: 'x', active: 'today', csrf: 'c' }, '')], ['errorPage', errorPage({})], ['goneHtml', goneHtml()], ['demoPage', demoPage(demo, { offer: {} })]]) assertHead(html, 'light', `${where}, no theme`);
});

test('every <html> of a page is written by ui.js htmlOpen and every colour meta by themeMeta, and the old /theme form is gone', async () => {
  const web = path.join(ROOT, 'src', 'web');
  for (const f of readdirSync(web).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(path.join(web, f), 'utf8');
    const own = f === 'ui.js' ? src.replace(/export const (htmlOpen|themeMeta) = [^\n]+/g, '') : src;
    assert.doesNotMatch(own, /<html lang=/, `src/web/${f} writes its own <html>: use htmlOpen`);
    assert.doesNotMatch(own, /name="theme-color"|name="color-scheme"/, `src/web/${f} writes its own colour metas: use themeMeta`);
  }
  const page = await (await get('/settings', paid.cookie)).text();
  const old = await fetch(`${base}/theme`, { method: 'POST', redirect: 'manual', headers: { cookie: paid.cookie, 'x-of-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${/name="_csrf" value="([^"]+)"/.exec(page)[1]}` });
  assert.equal(old.status, 404, 'POST /theme answers nothing: the choice is the cookie the browser writes');
  assert.doesNotMatch(readFileSync(path.join(web, 'static', 'app.js'), 'utf8'), /theme/, 'app.js keeps nothing of it');
});

test('no page stylesheet turns dark on the device\'s setting: every dark rule hangs on data-theme', async () => {
  for (const [file, url] of [['style.css', '/static/style.css'], ['demo.css', '/static/demo.css']]) {
    const css = await (await get(url)).text();
    // style.css goes out with the pro look's layer after it, the default (look.js); demo.css as it is.
    assert.equal(css, file === 'style.css' ? lookSheet('pro').toString('utf8') : readFileSync(path.join(ROOT, 'src', 'web', 'static', file), 'utf8'));
    assert.doesNotMatch(css, /prefers-color-scheme/, `${file}: no @media (prefers-color-scheme)`);
    assert.match(css, /:root\s*\{\s*color-scheme: light;/, `${file}: light first`);
    assert.match(css, /:root\[data-theme="dark"\] \{\s*color-scheme: dark;/, `${file}: dark by the attribute`);
    for (const part of ['.theme {', '.theme:not(.on) { visibility: hidden; }', '.theme .sun, [data-theme="dark"] .theme .moon { display: none; }', '[data-theme="dark"] .theme .sun { display: block; }']) assert.ok(css.includes(part), `${file}: ${part}`);
  }
  const js = await get('/static/theme.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await js.text(), readFileSync(path.join(ROOT, 'src', 'web', 'static', 'theme.js'), 'utf8'));
});

test('in a real browser, on a device that prefers dark: light, one tap makes it dark and keeps it for the next page, and back; the cookie this host\'s alone here, and under the company\'s name every subdomain\'s', async () => {
  let browser;
  try {
    browser = await chromium.launch();
    const state = (page) => page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      scheme: document.querySelector('meta[name="color-scheme"]').content,
      color: document.querySelector('meta[name="theme-color"]').content,
      pressed: document.querySelector('[data-theme-toggle]').getAttribute('aria-pressed'),
      shown: getComputedStyle(document.querySelector('[data-theme-toggle]')).visibility === 'visible',
      // The desk's pages paint the body, a store's page paints <html>.
      bg: `${getComputedStyle(document.documentElement).backgroundColor} ${getComputedStyle(document.body).backgroundColor}`,
    }));
    const LIGHT = { theme: 'light', scheme: 'light', color: '#eeeff2', pressed: 'false', shown: true };
    const DARK = { theme: 'dark', scheme: 'dark', color: '#111113', pressed: 'true', shown: true };
    const without = ({ bg, ...rest }) => rest;

    for (const [where, url, session, width] of [['home, a phone', '/', paid.sid, 390], ['the paywall, a desk', '/', unpaid.sid, 1280], ["a store's page, a phone", `/s/${SLUG}`, null, 390]]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: 'dark', ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
      if (session) await context.addCookies([{ name: 'of_session', value: session, url: base }]);
      const page = await context.newPage();
      const refused = [];
      page.on('console', (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && refused.push(m.text()));
      page.on('pageerror', (e) => refused.push(e.message));
      await page.goto(`${base}${url}`, { waitUntil: 'load' });
      assert.deepEqual(without(await state(page)), LIGHT, `${where}: light on a device that prefers dark`);
      const light = (await state(page)).bg;
      assert.equal((await context.cookies()).some((c) => c.name === THEME_COOKIE), false, `${where}: no theme cookie until the switch is used`);

      await page.click('[data-theme-toggle]');
      const dark = await state(page);
      assert.deepEqual(without(dark), DARK, `${where}: one tap, dark at once`);
      assert.notEqual(dark.bg, light, `${where}: the page itself changed`);
      const kept = (await context.cookies()).find((c) => c.name === THEME_COOKIE);
      assert.equal(kept.value, 'dark');
      assert.equal(kept.domain, '127.0.0.1', `${where}: this host's alone`);
      assert.equal(kept.path, '/');
      assert.equal(kept.sameSite, 'Lax');
      assert.equal(kept.secure, false, 'no Secure on http');
      assert.ok(Math.abs(kept.expires - (Date.now() / 1000 + 31536000)) < 120, 'kept a year');

      // The next page arrives dark from the server, before any script.
      const next = await page.goto(`${base}${url}`, { waitUntil: 'load' });
      assert.match(await next.text(), /<html lang="he" dir="rtl" data-theme="dark"/, `${where}: the server renders the next page dark`);
      assert.deepEqual(without(await state(page)), DARK);
      await page.click('[data-theme-toggle]');
      assert.deepEqual(without(await state(page)), LIGHT, `${where}: and back`);
      assert.equal((await context.cookies()).find((c) => c.name === THEME_COOKIE).value, 'light');
      assert.deepEqual(refused, [], `${where}: no CSP refusal and no error`);
      await context.close();
    }

    // A tab left open follows a choice made in another, when it is looked at again.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addCookies([{ name: 'of_session', value: paid.sid, url: base }]);
      const [a, b] = [await context.newPage(), await context.newPage()];
      await a.goto(`${base}/`, { waitUntil: 'load' });
      await b.goto(`${base}/posts`, { waitUntil: 'load' });
      await a.click('[data-theme-toggle]');
      assert.equal((await state(b)).theme, 'light', 'the other tab as it was');
      await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      assert.deepEqual(without(await state(b)), DARK, 'and dark once it is looked at');
      await context.close();
    }

    // Under the company's name: Teder at teder.openfrequency.co.il over https (this server behind a stand-in for the
    // proxy), and a sibling, accounts.openfrequency.co.il. The cookie the switch writes on one is sent to the other.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
      const sent = [];
      await context.route('https://*.openfrequency.co.il/**', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        sent.push([u.host, req.headers().cookie || '']);
        if (u.host !== 'teder.openfrequency.co.il') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>accounts</title>' });
        const res = await fetch(`${base}${u.pathname}${u.search}`, { headers: { cookie: req.headers().cookie || '' } });
        return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || 'text/html', body: Buffer.from(await res.arrayBuffer()) });
      });
      const page = await context.newPage();
      await page.goto(`https://teder.openfrequency.co.il/s/${SLUG}`, { waitUntil: 'load' });
      assert.deepEqual(without(await state(page)), LIGHT);
      await page.click('[data-theme-toggle]');
      assert.deepEqual(without(await state(page)), DARK);
      const kept = (await context.cookies()).find((c) => c.name === THEME_COOKIE);
      assert.deepEqual([kept.value, kept.domain, kept.path, kept.secure, kept.sameSite], ['dark', '.openfrequency.co.il', '/', true, 'Lax'], 'the company\'s name, every subdomain, Secure');
      await page.goto('https://accounts.openfrequency.co.il/', { waitUntil: 'load' });
      assert.match(sent.at(-1)[1], /(^|; )of-theme=dark(;|$)/, 'accounts is sent the choice');
      await page.goto(`https://teder.openfrequency.co.il/s/${SLUG}`, { waitUntil: 'load' });
      assert.deepEqual(without(await state(page)), DARK, 'and Teder renders it');
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});

// The coordinator, 2026-11-02, on the switch floating beside the accessibility button over a card's text: "On a phone,
// put the switch in the top bar instead, the way Toran does: between the meter (1 / 40) and the sign-out button, 8px
// from each, same size as those round buttons", at 320, 360 and 390 with the longest name; on a desk at the foot of the
// side bar, on the sign-out row.
test('in a real browser, the switch is in the bar: on a phone between the month\'s count and signing out, 8px from each and their size, at 320, 360 and 390, the longest name cut short, nothing wrapping or moving; on a desk on the sign-out row', async () => {
  let browser;
  try {
    browser = await chromium.launch();
    const bar = () => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON() || null;
      const [wrap, brand, pill, spend, theme, logout] = ['.top .wrap', '.top .brand', '.acctswitch > summary', '.top .spend', '.top .theme', '.top .logout'].map(box);
      const gap = (a, b) => Math.round(Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom));
      const name = document.querySelector('.acctswitch > summary .nm b');
      const el = document.querySelector('.top .wrap');
      return {
        order: [brand, pill, spend, theme, logout].every((r, i, all) => i === 0 || r.right <= all[i - 1].left),
        gaps: [gap(brand, pill), gap(pill, spend), gap(spend, theme), gap(theme, logout)],
        inside: [brand, pill, spend, theme, logout].every((r) => r.left >= wrap.left && r.right <= wrap.right && r.top >= wrap.top && r.bottom <= wrap.bottom),
        theme: [Math.round(theme.width), Math.round(theme.height)],
        logout: [Math.round(logout.width), Math.round(logout.height)],
        height: Math.round(wrap.height),
        overflow: el.scrollWidth - el.clientWidth,
        name: { shown: name.clientWidth, needs: name.scrollWidth, oneLine: name.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(name).fontSize) * 1.5, cut: getComputedStyle(name).textOverflow },
        pill: Math.round(pill.width),
        side: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    };
    for (const [who, sid, whole] of [['the demo account', paid.sid, [360, 390]], ['a 30-character name', long.sid, []]]) {
      for (const width of [320, 360, 390]) {
        const at = `${who} at ${width}`;
        const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
        await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
        const page = await context.newPage();
        await page.goto(`${base}/posts`, { waitUntil: 'load' });
        const m = await page.evaluate(bar);
        assert.ok(m.order, `${at}: the logo, the account, the month's count, the switch and signing out, in that order`);
        assert.ok(m.gaps.every((g) => g >= 8), `${at}: 8px or more between them (${m.gaps})`);
        assert.deepEqual(m.gaps.slice(2), [8, 8], `${at}: the switch 8px from the count and from signing out`);
        assert.deepEqual(m.theme, m.logout, `${at}: the switch the size of signing out`);
        assert.deepEqual(m.theme, [40, 40]);
        assert.ok(m.inside, `${at}: all of it inside the bar`);
        assert.equal(m.height, 56, `${at}: the bar one line high`);
        assert.equal(m.overflow, 0, `${at}: nothing past the bar`);
        assert.equal(m.side, 0, `${at}: no sideways scroll`);
        assert.ok(m.name.oneLine, `${at}: the name on one line`);
        if (whole.includes(width)) assert.ok(m.name.shown >= m.name.needs, `${at}: the name whole (${m.name.shown} of ${m.name.needs}px)`);
        else assert.equal(m.name.cut, 'ellipsis', `${at}: a name that does not fit is cut short with an ellipsis (${m.name.shown} of ${m.name.needs}px)`);
        // The bar is the same before the script shows the switch: its place is kept, so nothing moves when it appears.
        const still = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, javaScriptEnabled: false });
        await still.addCookies([{ name: 'of_session', value: sid, url: base }]);
        const before = await still.newPage();
        await before.goto(`${base}/posts`, { waitUntil: 'load' });
        assert.equal(await before.evaluate(() => getComputedStyle(document.querySelector('.top .theme')).visibility), 'hidden', `${at}: without the script the switch is not offered`);
        assert.equal((await before.evaluate(bar)).pill, m.pill, `${at}: the account's pill as wide before the script as after`);
        await still.close();
        await context.close();
      }
    }

    // A desk: the switch at the end of the sign-out row at the foot of the side bar; with the side bar folded, a third
    // icon in its column. 8px from the month's count and from signing out either way.
    for (const side of [null, 'mini']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: 'of_session', value: paid.sid, url: base }, ...(side ? [{ name: 'of_side', value: side, url: base }] : [])]);
      const page = await context.newPage();
      await page.goto(`${base}/`, { waitUntil: 'load' });
      const m = await page.evaluate(() => {
        const box = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
        const [wrap, spend, theme, logout] = ['.top .wrap', '.top .spend', '.top .theme', '.top .logout'].map(box);
        // In the page's pixels: a desk draws the page at 90% (style.css --z).
        const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
        const gap = (a, b) => Math.round(Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom) / z);
        return { shown: getComputedStyle(document.querySelector('.top .theme')).visibility === 'visible', spend: gap(spend, theme), logout: gap(theme, logout), row: Math.abs(theme.top - logout.top) < 2 && theme.right <= logout.left, column: theme.top >= spend.bottom && logout.top >= theme.bottom, inside: theme.left >= wrap.left && theme.right <= wrap.right && theme.bottom <= wrap.bottom };
      });
      const at = side ? 'a desk, the side bar folded' : 'a desk';
      assert.equal(m.shown, true, at);
      assert.ok(m.spend >= 8 && m.logout >= 8, `${at}: 8px or more from the count (${m.spend}) and from signing out (${m.logout})`);
      assert.ok(side ? m.column : m.row, `${at}: ${side ? 'between the count and signing out, in the column' : 'on the sign-out row, at its end'}`);
      assert.ok(m.inside, `${at}: in the side bar`);
      await page.click('.top .theme');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', `${at}: and it works there`);
      await context.close();
    }
  } finally {
    await browser?.close();
  }
});
