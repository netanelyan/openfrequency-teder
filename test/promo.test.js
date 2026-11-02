import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, loadPack } from '../src/packs/load.js';
import { validatePack } from '../src/packs/validate.js';
import { makeContext } from '../src/engine.js';
import { __onboarding } from '../src/web/onboarding.js';
import { setupOf } from '../src/onboarding/setup.js';
import { promiseFrom, readSitePromo, reading } from '../src/onboarding/promo.js';
import { CLOSING, closingOf, httpsUrl, onDomain, promoConfigProblems, promoOf, promoProblems, promoText } from '../src/packs/promo.js';
import { setPackPromo } from '../src/packs/write.js';
import { siteDescription } from '../src/demos/store.js';
import { PROMO_HE, promoFromForm, readNote, settlePromo } from '../src/web/promo.js';
import { closeBrowser } from '../src/render/render.js';
import { copyPack, customer, fakeAccounts, listenFree, opened, tempHome } from './helpers.js';

// What every slideshow sends people to (the owner, 2026-11-02, item 1 of the closing slide: "a `promo` field in the
// pack/settings with a name, a short promise (what the viewer gets), and a target (a site, a product, or "link in bio").
// Fill it in automatically during setup on `/new` from the store's site, and the customer can edit it in Settings. Our
// own accounts can have no promo; in that case the last slide sends people to follow the account.").
// src/packs/promo.js (the shape and its checks), src/onboarding/promo.js (read from the site), src/web/promo.js (the
// fields on /new and Settings). The store is a fake, on .example; nothing here goes to the network or to a model.

const SITE = { name: 'שתיל ועלה', kind: 'site', url: 'https://shatil-vaale.example/' };
const good = (over = {}) => ({ name: 'שתיל ועלה', promise: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח', target: { kind: 'site', url: SITE.url }, ...over });

test('a promo: the three targets pass; each bad value is named', () => {
  assert.deepEqual(promoProblems(good()), []);
  assert.deepEqual(promoProblems(good({ target: { kind: 'product', name: 'מונסטרה בעציץ קרמיקה', url: 'https://shatil-vaale.example/products/monstera' } })), []);
  assert.deepEqual(promoProblems(good({ target: { kind: 'bio' } })), []);
  assert.deepEqual(promoProblems(null), [], 'no promo is fine');
  assert.deepEqual(promoProblems(undefined), []);
  const cases = [
    ['a list', ['x'], 'shape'],
    ['no name', good({ name: '   ' }), 'name'],
    ['a long name', good({ name: 'א'.repeat(41) }), 'nameLong'],
    ['a promise too short', good({ promise: 'צמחים' }), 'promise'],
    ['a promise too long', good({ promise: 'צמחי בית '.repeat(11) }), 'promiseLong'],
    ['no target', good({ target: null }), 'target'],
    ['an unknown target', good({ target: { kind: 'shop', url: SITE.url } }), 'target'],
    ['a site with no address', good({ target: { kind: 'site', url: '' } }), 'siteUrl'],
    ['an http address with a port', good({ target: { kind: 'site', url: 'http://shatil-vaale.example:8080/' } }), 'url'],
    ['ftp', good({ target: { kind: 'site', url: 'ftp://shatil-vaale.example/' } }), 'url'],
    ['javascript', good({ target: { kind: 'site', url: 'javascript:alert(1)' } }), 'url'],
    ['a sign-in in the address', good({ target: { kind: 'site', url: 'https://me:pw@shatil-vaale.example/' } }), 'url'],
    ['a port', good({ target: { kind: 'site', url: 'https://shatil-vaale.example:8443/' } }), 'url'],
    ['no host', good({ target: { kind: 'site', url: 'https://localhost/' } }), 'url'],
    ['spaces', good({ target: { kind: 'site', url: 'atziz veshemesh.example' } }), 'url'],
    ['a product with no name', good({ target: { kind: 'product', name: '', url: 'https://shatil-vaale.example/p/1' } }), 'product'],
    ['a product name too long', good({ target: { kind: 'product', name: 'מ'.repeat(61), url: 'https://shatil-vaale.example/p/1' } }), 'productLong'],
    ['a product with no page', good({ target: { kind: 'product', name: 'מונסטרה' } }), 'productUrl'],
  ];
  for (const [what, p, code] of cases) assert.ok(promoProblems(p).includes(code), `${what}: ${code}, got ${promoProblems(p)}`);
  // Lengths are counted in letters, Hebrew's as one each: 40 and 90 exactly are fine.
  assert.deepEqual(promoProblems(good({ name: 'א'.repeat(40), promise: 'ב'.repeat(90) })), []);
});

test("an address: https, a bare domain and http:// made https without a word, and what the engine fills in itself stays on the store's domain", () => {
  assert.deepEqual(httpsUrl('shatil-vaale.example'), { url: 'https://shatil-vaale.example/' });
  assert.deepEqual(httpsUrl(' https://www.shatil-vaale.example/products/a?x=1 '), { url: 'https://www.shatil-vaale.example/products/a?x=1' });
  // http:// typed by the customer is upgraded silently (the owner, 2026-11-02); its own default port 80 too.
  assert.deepEqual(httpsUrl('http://shatil-vaale.example/products/a?x=1'), { url: 'https://shatil-vaale.example/products/a?x=1' });
  assert.deepEqual(httpsUrl('HTTP://Shatil-Vaale.example:80'), { url: 'https://shatil-vaale.example/' });
  // Other schemes, a sign-in and a port are still refused, on http:// as on https://.
  assert.deepEqual(httpsUrl('http://shatil-vaale.example:8080/'), { problem: 'url' });
  assert.deepEqual(httpsUrl('http://me:pw@shatil-vaale.example/'), { problem: 'url' });
  assert.deepEqual(httpsUrl('https://shatil-vaale.example:443x/'), { problem: 'url' });
  assert.deepEqual(httpsUrl('ftp://shatil-vaale.example/'), { problem: 'url' });
  assert.deepEqual(httpsUrl(''), { problem: 'missing' });
  assert.ok(onDomain('https://www.shatil-vaale.example/a', 'shatil-vaale.example'));
  assert.ok(onDomain('https://shop.shatil-vaale.example/a', 'www.shatil-vaale.example'));
  assert.ok(!onDomain('https://shatil-vaale.example.evil.example/', 'shatil-vaale.example'));
  assert.ok(!onDomain('https://other.example/', 'shatil-vaale.example'));
  // The domain is checked when it is given (the engine's own fill), not on what the customer typed.
  const elsewhere = good({ target: { kind: 'site', url: 'https://linktr.ee/atziz' } });
  assert.deepEqual(promoProblems(elsewhere), [], 'typed by the customer: anywhere, https');
  assert.deepEqual(promoProblems(elsewhere, { domain: 'shatil-vaale.example' }), ['domain']);
  assert.deepEqual(promoProblems(good(), { domain: 'shatil-vaale.example' }), []);
});

test('text is kept as it goes on a slide: direction and control marks out, one space, trimmed', () => {
  assert.equal(promoText('  \u200fשתיל   ועלה\u202e \n'), 'שתיל ועלה');
  const p = promoFromForm({ promo_name: '  שתיל ועלה ', promo_promise: '\u200eצמחי בית   ועציצים מקרמיקה ', promo_target: 'site', promo_site: 'shatil-vaale.example' });
  assert.deepEqual(p.promo, { name: 'שתיל ועלה', promise: 'צמחי בית ועציצים מקרמיקה', target: { kind: 'site', url: 'https://shatil-vaale.example/' } });
  // Only the chosen target's own fields are kept.
  const bio = promoFromForm({ promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה', promo_target: 'bio', promo_site: 'shatil-vaale.example', promo_product: 'מונסטרה' });
  assert.deepEqual(bio.promo.target, { kind: 'bio' });
});

test('the form: left empty it is no promo; half filled in it is refused in Hebrew, with what is missing', () => {
  assert.deepEqual(promoFromForm({ promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'site', promo_site: '' }).promo, null, 'the name alone is filled in for them: no promo');
  const half = promoFromForm({ promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'site', promo_site: 'shatil-vaale.example' });
  assert.deepEqual(half.problems, ['צריך לכתוב במשפט אחד מה מקבלים אצלכם.']);
  const bad = promoFromForm({ promo_name: '', promo_promise: 'צמחי בית ועציצים מקרמיקה', promo_target: 'product', promo_product: '', promo_product_url: 'ftp://shatil-vaale.example/p' });
  assert.deepEqual(bad.problems, ['צריך לכתוב את השם שיופיע בשקף.', 'צריך לכתוב את שם המוצר.', 'הכתובת לא נראית כמו כתובת של אתר, למשל shop.co.il']);
  // An http:// address is no problem: it is kept as https.
  const http = promoFromForm({ promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה', promo_target: 'product', promo_product: 'מונסטרה', promo_product_url: 'http://shatil-vaale.example/products/monstera' });
  assert.equal(http.problems, undefined);
  assert.equal(http.promo.target.url, 'https://shatil-vaale.example/products/monstera');
  // As a new account takes a draft: whole, it is the promo; empty, none; half done, none and unfinished.
  assert.deepEqual(settlePromo(http.draft), { promo: http.promo, unfinished: false });
  assert.deepEqual(settlePromo(half.draft), { promo: null, unfinished: true });
  assert.deepEqual(settlePromo({ name: 'שתיל ועלה', promise: '', target: { kind: 'site', url: '' } }), { promo: null, unfinished: false });
  assert.deepEqual(settlePromo(null), { promo: null, unfinished: false });
  // What /new says beside it: nothing about the site once the customer saved their own, even if the read failed after.
  assert.equal(readNote({ promoBy: 'customer', siteRead: 'failed' }, { busy: true }), '');
  assert.match(readNote({ siteRead: 'failed' }), /לא הצלחנו לקרוא את האתר שלכם/);
  assert.match(readNote({ promoBy: 'site', promo: { promise: '' } }), /צריך לכתוב בעצמכם/);
  assert.match(readNote({}, { busy: true }), /עוד קוראים את האתר שלכם/);
  // Plain Hebrew: no English word but the address people see in the address bar, no long dash.
  for (const line of Object.values(PROMO_HE)) assert.doesNotMatch(line.replace(/https(:\/\/shop\.co\.il)?|shop\.co\.il/g, ''), /[A-Za-z]{2,}|—|–/, `plain Hebrew: ${line}`);
});

test('in a pack: checked like the rest of pack.json; none, or null, is "follow the account"', () => {
  // A folder of its own: tempHome() would move OF_HOME and close the server's database below.
  const own = mkdtempSync(path.join(os.tmpdir(), 'of-promo-'));
  try {
    copyPack(own, 'demo');
    const dir = path.join(own, 'packs', 'demo');
    const pack = loadPack(dir);
    assert.equal(pack.meta.promo, undefined, 'the demo pack, like every pack before this, has none');
    assert.deepEqual(validatePack(pack), [], 'and loads as it did');
    assert.deepEqual(closingOf(pack), { kind: CLOSING.follow, handle: pack.meta.handle });
    assert.deepEqual(closingOf({ ...pack, meta: { ...pack.meta, promo: null } }), { kind: 'follow', handle: pack.meta.handle });
    assert.deepEqual(validatePack({ ...pack, meta: { ...pack.meta, promo: null } }), []);
    assert.deepEqual(validatePack({ ...pack, meta: { ...pack.meta, promo: good() } }), []);
    assert.deepEqual(closingOf({ ...pack, meta: { ...pack.meta, promo: good() } }), { kind: 'promo', ...good() });
    const bad = validatePack({ ...pack, meta: { ...pack.meta, promo: good({ promise: '', target: { kind: 'site', url: 'ftp://x.example' } }) } });
    assert.deepEqual(bad, ['pack.json: promo.promise says what the viewer gets, at least 6 characters', 'pack.json: promo.target.url is not an https address (no other scheme, sign-in or port)']);
    // A hand-written http:// address passes, and is read as https.
    const http = { ...pack, meta: { ...pack.meta, promo: good({ target: { kind: 'site', url: 'http://shatil-vaale.example/' } }) } };
    assert.deepEqual(validatePack(http), []);
    assert.equal(promoOf(http).target.url, 'https://shatil-vaale.example/');
    assert.deepEqual(promoConfigProblems('a string'), ['pack.json: promo is { name, promise, target }, or left out (the closing slide then asks to follow the account)']);
    // Written by the website as the style is: the rest of pack.json kept, a bad one refused with nothing written.
    const before = JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.throws(() => setPackPromo(pack, good({ name: '' })), /promo.name is required/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8')), before);
    setPackPromo(pack, good({ name: ' שתיל ועלה ' }));
    const after = JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    assert.deepEqual(after.promo, good());
    assert.deepEqual({ ...after, promo: undefined }, { ...before, promo: undefined }, 'nothing else changed');
    assert.deepEqual(promoOf(loadPack(dir)), good(), 'and it loads');
    setPackPromo(pack, null);
    assert.equal('promo' in JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8')), false, 'none takes the key out');
    assert.equal(closingOf(loadPack(dir)).kind, 'follow');
    // The set loads as before.
    assert.equal(loadAll({ dir: path.join(own, 'packs') }).length, 1);
  } finally {
    rmSync(own, { recursive: true, force: true, maxRetries: 3 });
  }
});

/* --------------------------------------------------------------- the store's own words */

const HOME = (description, { platform = 'shopify', name = 'שתיל ועלה' } = {}) =>
  `<html><head><title>${name} | צמחי בית</title><meta name="description" content="${description}"><meta property="og:site_name" content="${name}">${platform === 'shopify' ? '<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/theme.css">' : ''}</head><body><h1>${name}</h1></body></html>`;

/** A store on Shopify that answers what readStore asks, every request kept; `down` answers nothing at all. */
function fakeStore({ host = 'shatil-vaale.example', description, platform = 'shopify', down = false, name = 'שתיל ועלה' } = {}) {
  const origin = `https://${host}`;
  const asked = [];
  const nope = (u) => Promise.reject(Object.assign(new Error(`HTTP 404: ${u}`), { status: 404 }));
  const json = {
    [`${origin}/products.json?limit=100`]: { products: [{ id: 1, title: 'מונסטרה בעציץ קרמיקה', handle: 'monstera', product_type: 'צמחים', images: [{ src: `https://cdn.shopify.com/s/files/1/monstera.jpg` }], variants: [{ price: '89.00', available: true }] }] },
    [`${origin}/meta.json`]: { name, currency: 'ILS' },
    [`${origin}/collections.json?limit=50`]: { collections: [{ title: 'צמחי בית' }] },
  };
  return {
    asked,
    get: async (u) => (asked.push(u), down || platform !== 'shopify' || !json[u] ? nope(u) : structuredClone(json[u])),
    getPage: async (u) => (asked.push(u), down || u !== origin ? nope(u) : { body: HOME(description, { platform, name }), finalUrl: u }),
  };
}

test("the homepage's description is read in either quote, a geresh or an apostrophe kept", () => {
  assert.equal(siteDescription(`<meta name="description" content="צ'יפס וגלידה, כל יום">`), "צ'יפס וגלידה, כל יום");
  assert.equal(siteDescription(`<meta content='אוכל "ביתי" בתל אביב' property='og:description'>`), 'אוכל "ביתי" בתל אביב');
  assert.equal(siteDescription('<meta name="twitter:description" content="  שורה &amp; עוד  ">'), 'שורה & עוד');
  assert.equal(siteDescription('<meta name="keywords" content="a, b">'), '');
});

test("the promise is the store's own sentence: Hebrew, short enough, and never 'the best' or a hurry", () => {
  const name = 'שתיל ועלה';
  assert.equal(promiseFrom('שתיל ועלה - צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח. משלוח עד הבית.', { name }), 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח');
  assert.equal(promiseFrom('החנות הכי גדולה לצמחים בישראל! צמחי בית ועציצים מקרמיקה עם הוראות טיפול.', { name }), 'צמחי בית ועציצים מקרמיקה עם הוראות טיפול', 'the superlative is passed over');
  assert.equal(promiseFrom('מבצע ענק רק היום. אל תפספסו את הצמחים הטובים ביותר.', { name }), '', 'nothing but hurry and superlatives: the customer writes it');
  assert.equal(promiseFrom('The #1 plant shop. Free shipping.', { name }), '', 'not Hebrew');
  assert.equal(promiseFrom('שתיל ועלה | צמחים, עציצים, אדמה, דשנים, כלים', { name }), '', 'a list of keywords is no promise');
  assert.equal(promiseFrom('שתיל ועלה', { name }), '', 'its own name is no promise');
  // A sentence too long for a slide is kept to its first clauses, at a comma.
  const long = 'צמחי בית ועציצים מקרמיקה שנעשים בסטודיו שלנו ביפו, עם הוראות טיפול לכל צמח ולכל עונה, ומשלוח עד הבית בכל הארץ';
  const got = promiseFrom(long, { name });
  assert.equal(got, 'צמחי בית ועציצים מקרמיקה שנעשים בסטודיו שלנו ביפו, עם הוראות טיפול לכל צמח ולכל עונה');
  assert.equal([...got].length, 84);
  // Two clauses would be 92 letters: one is kept.
  assert.equal(promiseFrom(long.replace('טיפול', 'טיפול מפורטות'), { name }), 'צמחי בית ועציצים מקרמיקה שנעשים בסטודיו שלנו ביפו');
});

test('a site gives a draft: its name, its own promise and itself as the target; a site on no store platform by its homepage; a dead one only its address', async () => {
  const shop = fakeStore({ description: 'שתיל ועלה - צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח.' });
  const got = await readSitePromo('shatil-vaale.example', shop);
  assert.equal(got.read, true);
  assert.deepEqual(got.draft, { name: 'שתיל ועלה', promise: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח', target: { kind: 'site', url: 'https://shatil-vaale.example/' } });
  assert.deepEqual(promoProblems(got.draft, { domain: 'shatil-vaale.example' }), [], "on the store's own domain, and valid as it is");
  assert.ok(shop.asked.includes('https://shatil-vaale.example/meta.json'), 'read the way a demo reads a store (readStore)');
  // A clinic's site on no store platform: readStore refuses it, and the homepage alone is read.
  const clinic = fakeStore({ host: 'mirpaat-shinayim.example', platform: 'none', name: 'מרפאת השיניים של רונית', description: 'מרפאת שיניים משפחתית ברמת גן, עם תורים גם בערב.' });
  const c = await readSitePromo('https://mirpaat-shinayim.example/', clinic);
  assert.deepEqual(c.draft, { name: 'מרפאת השיניים של רונית', promise: 'מרפאת שיניים משפחתית ברמת גן, עם תורים גם בערב', target: { kind: 'site', url: 'https://mirpaat-shinayim.example/' } });
  // A site that does not answer: the address the customer typed, nothing made up.
  const dead = await readSitePromo('shatil-vaale.example', fakeStore({ down: true }));
  assert.deepEqual(dead, { draft: { name: '', promise: '', target: { kind: 'site', url: 'https://shatil-vaale.example/' } }, read: false });
  assert.equal(await readSitePromo('not an address', shop), null);
  // A name that is only the domain is no name to offer.
  const bare = await readSitePromo('shatil-vaale.example', fakeStore({ name: 'shatil-vaale.example', description: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול.' }));
  assert.equal(bare.draft.name, '');
});

/* --------------------------------------------------------------- /new and Settings, through the server */

let home;
let ctx;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'r'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

// Each test's new accounts go after it, and the demo's pack.json is put back.
let demoJson;
afterEach(() => {
  __onboarding.running.clear();
  __onboarding.progress.clear();
  delete ctx.siteOpts;
  delete ctx.discoverOpts;
  const made = ctx.packs.filter((p) => p.id !== 'demo');
  db.raw.exec('PRAGMA foreign_keys = OFF');
  for (const p of made) {
    for (const table of ['posts', 'sources', 'accounts']) db.run(`DELETE FROM ${table} WHERE ${table === 'accounts' ? 'id' : 'account_id'} = ?`, p.id);
    rmSync(p.dir, { recursive: true, force: true });
  }
  db.raw.exec('PRAGMA foreign_keys = ON');
  if (demoJson) writeFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), demoJson);
  ctx.reloadPacks();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie, from = '/new') => /name="_csrf" value="([^"]+)"/.exec(await (await get(from, cookie)).text())[1];
const post = async (p, cookie, body = {}, { from = '/new', ajax = false } = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: await csrfOf(cookie, from), ...body }).toString() });
const value = (html, name) => new RegExp(`<textarea name="${name}"[^>]*>([^<]*)</textarea>`).exec(html)?.[1] ?? new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1];
const checked = (html) => /name="promo_target" value="(\w+)"[^>]*checked/.exec(html)?.[1];
const settle = async () => {
  await Promise.all([...reading.values()]);
  await Promise.all([...__onboarding.running.values()]);
};
/** The discovery held until `open()`, so the page that waits for it can be looked at. */
function holdDiscovery() {
  let open;
  const gate = new Promise((r) => (open = r));
  ctx.discoverOpts = { readSite: async () => (await gate, []) };
  return () => open();
}

test('/new asks for the business\'s site, once and optional, and fills the closing slide in from it; the customer accepts it or changes it', async () => {
  const { cookie } = fake.session(customer(7));
  const start = await (await get('/new', cookie)).text();
  assert.match(start, /<label class="f">האתר של העסק <small>לא חובה[^<]*<\/small><input type="text" name="site"(?![^>]*required)[^>]*dir="ltr"/, 'one optional field, read left to right');
  assert.equal(start.match(/name="site"/g).length, 1);
  const shop = fakeStore({ description: 'שתיל ועלה - צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח.' });
  ctx.siteOpts = shop;
  const open = holdDiscovery();
  const r = await post('/new', cookie, { niche: 'צמחי בית', audience: 'מי שגר בדירה', site: 'shatil-vaale.example', examples: 'https://garden.example/' });
  assert.equal(r.status, 303);
  const id = r.headers.get('location').split('/').pop();
  assert.equal(JSON.parse(db.get('SELECT seed_json FROM onboarding WHERE id = ?', id).seed_json).site, 'https://shatil-vaale.example');
  // The page opens filled in: POST /new waited the moment the fake store took.
  const waiting = await (await get(`/new/${id}`, cookie)).text();
  assert.match(waiting, /id="progress"/, 'the sources are still being searched');
  assert.match(waiting, /<section class="panel" id="promo"><header><h2>השקף האחרון<\/h2>/);
  assert.match(waiting, /<form method="post" action="\/new\/[\w-]+\/promo" class="formgrid promo mt12">/);
  assert.equal(value(waiting, 'promo_name'), 'שתיל ועלה');
  assert.equal(value(waiting, 'promo_promise'), 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח');
  assert.equal(checked(waiting), 'site');
  assert.equal(value(waiting, 'promo_site'), 'https://shatil-vaale.example/');
  assert.match(waiting, /מילאנו את זה ממה שכתוב באתר שלכם/);
  assert.deepEqual(setupOf(db, id).promoBy, 'site');
  // Accepted as it is.
  const okd = await post(`/new/${id}/promo`, cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח', promo_target: 'site', promo_site: 'https://shatil-vaale.example/' });
  assert.equal(okd.status, 303);
  assert.match(okd.headers.get('location'), /#promo$/);
  assert.equal(setupOf(db, id).promoBy, 'customer');
  assert.doesNotMatch(await (await get(`/new/${id}`, cookie)).text(), /מילאנו את זה/, 'their own now: nothing said about the site');
  // Changed: one product.
  await post(`/new/${id}/promo`, cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: 'מונסטרה גדולה בעציץ קרמיקה, עם הוראות טיפול', promo_target: 'product', promo_product: 'מונסטרה בעציץ קרמיקה', promo_product_url: 'shatil-vaale.example/products/monstera' });
  // Half done comes back with what was typed, and says what is missing.
  const half = await post(`/new/${id}/promo`, cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'product', promo_product: 'מונסטרה בעציץ קרמיקה', promo_product_url: 'shatil-vaale.example/products/monstera' }, { ajax: true });
  assert.equal(half.status, 422);
  assert.match((await half.json()).message, /צריך לכתוב במשפט אחד מה מקבלים אצלכם/);
  await post(`/new/${id}/promo`, cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: 'מונסטרה גדולה בעציץ קרמיקה, עם הוראות טיפול', promo_target: 'product', promo_product: 'מונסטרה בעציץ קרמיקה', promo_product_url: 'shatil-vaale.example/products/monstera' });
  open();
  await settle();
  // The sources step shows the closing slide as it was left, inside the form that makes the account.
  const review = await (await get(`/new/${id}`, cookie)).text();
  const form = review.slice(review.indexOf(`action="/new/${id}/create"`), review.indexOf('</form>', review.indexOf('ליצור את החשבון')));
  assert.ok(form.length > 0, 'the form that makes the account');
  assert.match(form, /id="promo"[\s\S]*name="promo_shown"/);
  assert.equal(checked(form), 'product');
  assert.equal(value(form, 'promo_product'), 'מונסטרה בעציץ קרמיקה');
  assert.ok(form.indexOf('id="promo"') < form.indexOf('ליצור את החשבון'), 'before the button that makes the account');
  // The account is made with it as shown.
  const cand = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const fields = { [`approve_${cand}`]: 'on', displayName: 'שתיל ועלה', handle: 'shatil.vaale', promo_shown: '1', promo_name: value(form, 'promo_name'), promo_promise: value(form, 'promo_promise'), promo_target: 'product', promo_product: value(form, 'promo_product'), promo_product_url: value(form, 'promo_product_url') };
  const made = await post(`/new/${id}/create`, cookie, fields, { ajax: true });
  assert.deepEqual([made.status, (await made.json()).message], [200, 'החשבון נוצר.']);
  const packId = db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id;
  const meta = JSON.parse(readFileSync(path.join(home.home, 'packs', packId, 'pack.json'), 'utf8'));
  assert.deepEqual(meta.promo, { name: 'שתיל ועלה', promise: 'מונסטרה גדולה בעציץ קרמיקה, עם הוראות טיפול', target: { kind: 'product', name: 'מונסטרה בעציץ קרמיקה', url: 'https://shatil-vaale.example/products/monstera' } });
  assert.equal(closingOf(ctx.pack(packId)).kind, 'promo');
});

test('a site that cannot be read: the customer types it; the waiting page\'s own save refuses half done and, with no script, comes back with what was typed', async () => {
  const { cookie } = fake.session(customer(8));
  ctx.siteOpts = fakeStore({ down: true });
  const open = holdDiscovery();
  const id = (await post('/new', cookie, { niche: 'צמחי בית', site: 'shatil-vaale.example', examples: 'https://garden.example/' })).headers.get('location').split('/').pop();
  const waiting = await (await get(`/new/${id}`, cookie)).text();
  assert.match(waiting, /לא הצלחנו לקרוא את האתר שלכם, אז צריך לכתוב את זה כאן/);
  assert.equal(value(waiting, 'promo_promise'), '');
  assert.equal(value(waiting, 'promo_site'), 'https://shatil-vaale.example/', 'the address they typed is kept');
  assert.equal(value(waiting, 'promo_name'), 'Workspace 8', "the business's name is offered");
  // A plain form post, as a browser with no script sends it: refused, back to the page, which shows what was typed.
  const typed = { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'product', promo_product: 'מונסטרה בעציץ קרמיקה', promo_product_url: 'http://shatil-vaale.example/products/monstera' };
  const refused = await post(`/new/${id}/promo`, cookie, typed);
  assert.equal(refused.status, 303);
  assert.equal(refused.headers.get('location'), `/new/${id}#promo`, 'back to the form itself, with no referer to go by');
  assert.match(decodeURIComponent(refused.headers.get('set-cookie') || ''), /צריך לכתוב במשפט אחד מה מקבלים אצלכם/, 'the message comes with it');
  const back = await (await get(`/new/${id}`, cookie)).text();
  assert.equal(checked(back), 'product');
  assert.equal(value(back, 'promo_name'), 'שתיל ועלה');
  assert.equal(value(back, 'promo_product'), 'מונסטרה בעציץ קרמיקה');
  assert.equal(value(back, 'promo_product_url'), 'http://shatil-vaale.example/products/monstera', 'as typed');
  assert.doesNotMatch(back, /לא הצלחנו לקרוא את האתר/, 'their own now');
  open();
  await settle();
  const cand = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const made = await post(`/new/${id}/create`, cookie, { [`approve_${cand}`]: 'on', displayName: 'שתיל ועלה', handle: 'shatil.second', ...typed, promo_promise: 'מונסטרה גדולה בעציץ קרמיקה' }, { ajax: true });
  assert.deepEqual([made.status, (await made.json()).message], [200, 'החשבון נוצר.']);
  assert.equal(promoOf(ctx.pack(db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id)).target.url, 'https://shatil-vaale.example/products/monstera', 'http:// kept as https');
});

test('the sources step never loses a choice: a refused send comes back with every tick, kind and field as left, and a half-done closing slide never stops the account', async () => {
  const { cookie } = fake.session(customer(11));
  // Two sites of the customer's own (always offered) and what the search adds.
  ctx.discoverOpts = { readSite: async (url) => [{ type: 'web', url, name: url.includes('leaves') ? 'Leaves' : 'Garden', newest: null }] };
  const id = (await post('/new', cookie, { niche: 'צמחי בית', examples: 'https://garden.example/\nhttps://leaves.example/' })).headers.get('location').split('/').pop();
  await settle();
  const cands = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates;
  const box = (html, c) => new RegExp(`name="approve_${c.id}"[^>]*?( checked)?[ >]`).exec(html)?.[1] === ' checked';
  const first = await (await get(`/new/${id}`, cookie)).text();
  const offeredHere = cands.filter((c) => new RegExp(`name="approve_${c.id}"`).test(first));
  assert.ok(offeredHere.length >= 2, `two sources or more to choose from, got ${offeredHere.length}`);
  // The customer turns every tick around, picks four kinds, and leaves the closing slide half done.
  const ticks = Object.fromEntries(offeredHere.filter((c) => !box(first, c)).map((c) => [`approve_${c.id}`, 'on']));
  assert.ok(Object.keys(ticks).length >= 1);
  const kinds = { formats_shown: '1', fmt_facts: 'on', fmt_story: 'on', fmt_ranking: 'on', fmt_iceberg: 'on' };
  const half = { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה', promo_target: 'product', promo_product: '', promo_product_url: 'shatil-vaale.example/products/monstera' };
  // Refused for its name (left empty), as a browser with no script sends it.
  const refused = await post(`/new/${id}/create`, cookie, { ...ticks, ...kinds, ...half, displayName: '', handle: 'shatil.kept' });
  assert.equal(refused.status, 303);
  assert.equal(db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id, null);
  const back = await (await get(`/new/${id}`, cookie)).text();
  for (const c of offeredHere) assert.equal(box(back, c), Boolean(ticks[`approve_${c.id}`]), `${c.name}: as the customer left it`);
  for (const f of ['facts', 'story', 'ranking', 'iceberg', 'tips', 'myth-fact']) assert.equal(new RegExp(`name="fmt_${f}" checked`).test(back), Boolean(kinds[`fmt_${f}`]), `the kind ${f}`);
  assert.equal(value(back, 'handle'), 'shatil.kept');
  assert.equal(checked(back), 'product');
  assert.equal(value(back, 'promo_product_url'), 'shatil-vaale.example/products/monstera');
  assert.equal(value(back, 'promo_promise'), 'צמחי בית ועציצים מקרמיקה');
  // Sent again with the name: the account is made, the closing slide half done or not.
  const made = await post(`/new/${id}/create`, cookie, { ...ticks, ...kinds, ...half, displayName: 'שתיל ועלה', handle: 'shatil.kept' });
  assert.equal(made.status, 303);
  assert.equal(made.headers.get('location'), `/new/${id}`);
  const packId = db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id;
  assert.ok(packId, 'the account exists');
  const pack = ctx.pack(packId);
  assert.equal('promo' in JSON.parse(readFileSync(path.join(pack.dir, 'pack.json'), 'utf8')), false, 'with no promo: one is whole or it is none');
  assert.equal(closingOf(pack).kind, 'follow');
  const approved = db.all("SELECT url FROM sources WHERE account_id = ? AND status = 'approved'", packId).map((s) => s.url).sort();
  assert.deepEqual(approved, offeredHere.filter((c) => ticks[`approve_${c.id}`]).map((c) => c.url).sort(), 'the sources it was made with are the ticked ones');
  assert.deepEqual(pack.formats.formats.map((f) => f.id).sort(), ['facts', 'iceberg', 'ranking', 'story']);
  // The next page says, once and calmly, where to finish it.
  const next = await (await get(`/new/${id}`, cookie)).text();
  assert.equal(next.match(/id="promo-later"/g)?.length, 1);
  assert.match(next, /השקף האחרון עוד לא גמור, ובינתיים הוא מבקש לעקוב אחרי החשבון. אפשר <a href="\/settings\?account=shatil-kept#promo-shatil-kept">להשלים אותו בהגדרות<\/a>/);
  // Settings offers what was typed, to finish.
  const settings = await (await get(`/settings?account=${packId}`, cookie)).text();
  assert.match(settings, /כאן מה שכתבתם כשפתחתם את החשבון/);
  assert.equal(checked(settings), 'product');
  assert.equal(value(settings, 'promo_promise'), 'צמחי בית ועציצים מקרמיקה');
  assert.equal(value(settings, 'promo_product_url'), 'shatil-vaale.example/products/monstera');
  // Finished there: the account has it, and neither page says it is unfinished.
  const done = await post(`/accounts/${packId}/promo`, cookie, { ...half, promo_product: 'מונסטרה בעציץ קרמיקה' }, { from: '/settings', ajax: true });
  assert.equal(done.status, 200);
  assert.equal(promoOf(ctx.pack(packId)).target.name, 'מונסטרה בעציץ קרמיקה');
  assert.doesNotMatch(await (await get(`/new/${id}`, cookie)).text(), /id="promo-later"/);
  // Emptied on purpose later, Settings does not bring the old draft back.
  await post(`/accounts/${packId}/promo`, cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'site', promo_site: '' }, { from: '/settings', ajax: true });
  const empty = await (await get(`/settings?account=${packId}`, cookie)).text();
  assert.match(empty, /עוד לא מילאתם את זה/);
  assert.equal(value(empty, 'promo_promise'), '');
});

test('an account set up with no site and the step left empty has no promo, and its last slide asks to follow it', async () => {
  const { cookie } = fake.session(customer(9));
  const id = (await post('/new', cookie, { niche: 'צמחי בית' })).headers.get('location').split('/').pop();
  assert.equal(reading.size, 0, 'no site, nothing read');
  assert.equal(JSON.parse(db.get('SELECT seed_json FROM onboarding WHERE id = ?', id).seed_json).site, undefined);
  await settle();
  const review = await (await get(`/new/${id}`, cookie)).text();
  assert.doesNotMatch(review, /מילאנו|לא הצלחנו לקרוא/, 'nothing said about a site nobody gave');
  const cand = JSON.parse(db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id).candidates_json).candidates[0].id;
  const made = await post(`/new/${id}/create`, cookie, { [`approve_${cand}`]: 'on', displayName: 'בלי אתר', handle: 'no.site.here', promo_shown: '1', promo_name: 'בלי אתר', promo_promise: '', promo_target: 'site', promo_site: '' }, { ajax: true });
  assert.deepEqual([made.status, (await made.json()).message], [200, 'החשבון נוצר.']);
  const pack = ctx.pack(db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id);
  assert.equal('promo' in JSON.parse(readFileSync(path.join(pack.dir, 'pack.json'), 'utf8')), false);
  assert.deepEqual(closingOf(pack), { kind: 'follow', handle: 'no.site.here' });
  // A typed site that is no address is not read, and the customer is told to type the slide.
  const odd = (await post('/new', fake.session(customer(10)).cookie, { niche: 'צמחי בית', site: 'not a site' })).headers.get('location');
  assert.equal(setupOf(db, odd.split('/').pop()).siteRead, 'failed');
  await settle();
});

test('Settings: the closing slide as it is, saved, read again after a reload, refused when half done, and emptied back to none', async () => {
  demoJson = readFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), 'utf8');
  const { cookie } = fake.session(customer(1));
  const page = await (await get('/settings', cookie)).text();
  assert.match(page, /<section class="panel" id="promo-demo"><header><h2>השקף האחרון<\/h2>/);
  assert.ok(page.indexOf('id="design-demo"') < page.indexOf('id="promo-demo"') && page.indexOf('id="promo-demo"') < page.indexOf('id="push"'), 'after the design, before the notifications');
  assert.match(page, /עוד לא מילאתם את זה, אז בינתיים השקף האחרון מבקש לעקוב אחרי החשבון/);
  assert.equal(value(page, 'promo_name'), ctx.pack('demo').meta.displayName, "the account's name is offered");
  assert.match(page, /action="\/accounts\/demo\/promo" class="formgrid promo mt12" data-ajax="reload"/);
  const fields = { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח', promo_target: 'site', promo_site: 'shatil-vaale.example' };
  const saved = await post('/accounts/demo/promo', cookie, fields, { from: '/settings' });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/settings#promo-demo');
  const onDisk = JSON.parse(readFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), 'utf8')).promo;
  assert.deepEqual(onDisk, { name: 'שתיל ועלה', promise: 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח', target: { kind: 'site', url: 'https://shatil-vaale.example/' } });
  assert.deepEqual(validatePack(loadPack(path.join(home.home, 'packs', 'demo'))), [], 'pack.json still valid');
  // A reload of the engine reads it from the file; the page shows it.
  ctx.reloadPacks();
  const again = await (await get('/settings', cookie)).text();
  assert.equal(value(again, 'promo_promise'), 'צמחי בית ועציצים מקרמיקה, עם הוראות טיפול לכל צמח');
  assert.equal(value(again, 'promo_site'), 'https://shatil-vaale.example/');
  assert.equal(checked(again), 'site');
  assert.doesNotMatch(again, /עוד לא מילאתם/);
  // Link in bio.
  await post('/accounts/demo/promo', cookie, { ...fields, promo_target: 'bio' }, { from: '/settings' });
  assert.deepEqual(ctx.pack('demo').meta.promo.target, { kind: 'bio' });
  assert.equal(checked(await (await get('/settings', cookie)).text()), 'bio');
  // Half done: refused in Hebrew, the file as it was (in the page, the form stays as typed: data-ajax).
  const before = readFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), 'utf8');
  const bad = await post('/accounts/demo/promo', cookie, { ...fields, promo_target: 'product', promo_product: '', promo_product_url: 'https://shatil-vaale.example:8443/p' }, { from: '/settings', ajax: true });
  assert.equal(bad.status, 422);
  assert.deepEqual((await bad.json()).problems, ['צריך לכתוב את שם המוצר.', 'הכתובת לא נראית כמו כתובת של אתר, למשל shop.co.il']);
  assert.equal(readFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), 'utf8'), before);
  // An http:// address is saved, as https.
  await post('/accounts/demo/promo', cookie, { ...fields, promo_site: 'http://shatil-vaale.example/' }, { from: '/settings' });
  assert.equal(ctx.pack('demo').meta.promo.target.url, 'https://shatil-vaale.example/');
  // Emptied: no promo, and the last slide asks to follow.
  const none = await post('/accounts/demo/promo', cookie, { promo_shown: '1', promo_name: 'שתיל ועלה', promo_promise: '', promo_target: 'site', promo_site: '' }, { from: '/settings', ajax: true });
  assert.equal(none.status, 200);
  assert.match((await none.json()).message, /השקף האחרון מבקש לעקוב אחרי החשבון/);
  assert.equal('promo' in JSON.parse(readFileSync(path.join(home.home, 'packs', 'demo', 'pack.json'), 'utf8')), false);
  assert.equal(closingOf(ctx.pack('demo')).kind, 'follow');
  // Another workspace's account is not there to change.
  const other = await post('/accounts/demo/promo', fake.session(customer(2)).cookie, fields, { from: '/new', ajax: true });
  assert.equal(other.status, 404);
});
