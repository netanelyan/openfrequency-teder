import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { fromWebsite, running } from '../src/web/demos.js';
import { checkDraft, checkFact } from '../src/demos/write.js';
import { readArticles } from '../src/demos/build.js';
import { storeDocument } from '../src/demos/store.js';
import { INTERNAL_TOKEN, fakeAccounts, customer, operator, opened, tempHome } from './helpers.js';

// A store's demo, from the website's request to the store's page (src/web/demos.js, src/demos):
// the request is taken only from this machine with the token; the demo is built in the background, on a topic from
// the store's field, its facts from Wikipedia, drawn on Pexels photographs; once it passes its checks its page is
// public at /s/<slug> with no one approving it, with the price once set; the operator's pages stay the operator's.
// Toran's dashboard reads every demo and its opens at /internal/demos, under the checks /internal/lead has; an open is
// a view of the page by someone not signed in, and its browsers are counted by a cookie.
// The store, the topic, Wikipedia, the writer, the photographs and the renderer are stand-ins (ctx.demoIo).

const product = (id, title, src, price = '289.00', at = '2026-10-01') => ({ id, title, handle: `p${id}`, published_at: at, images: [{ src }, { src: `${src}?2` }], variants: [{ price, available: true }], options: [] });
const KETTLE = product(11, 'קומקום חשמלי', 'https://cdn.example.test/kettle.jpg', '289.00', '2026-10-01');
const TEAPOT = product(12, 'קנקן תה מזכוכית', 'https://cdn.example.test/teapot.jpg', '149.90', '2026-09-01');
const SOLD = { ...product(13, 'קומקום שאזל', 'https://cdn.example.test/sold.jpg'), variants: [{ price: '99', available: false }] };
const STORE = { origin: 'https://kettles.example.co.il', domain: 'kettles.example.co.il', name: 'חנות הקומקומים', currency: 'ILS', accent: '#0A7D4F', products: [KETTLE, TEAPOT, SOLD], collections: ['קומקומים', 'תה'], logo: 'https://cdn.example.test/logo.png?v=1' };
const ARTICLE = { url: 'https://he.wikipedia.org/wiki/%D7%AA%D7%94', title: 'תה (Wikipedia בעברית)', text: 'התה הוא משקה שמכינים מעלים של צמח התה. לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה כשעלים נפלו לתוך מים רותחים.' };
const QUOTE = 'לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה כשעלים נפלו לתוך מים רותחים.';

let home;
let ctx;
let db;
let fake;
let server;
let base;
let op;
let cust;
let PHOTO;

const DRAFT = {
  facts: [{ id: 'f1', doc: 'w1', claim: 'לפי המסורת הסינית, התה התגלה לפני 5000 שנה', quote: QUOTE }],
  hook: 'התה התחיל בטעות',
  sub: 'הסיפור של המשקה שכולם שותים',
  coverImage: 'tea leaves in boiling water',
  items: [
    { title: 'עלים במים רותחים', body: 'לפי המסורת הסינית, עלים נפלו לתוך מים רותחים וכך התגלה התה.', facts: ['f1'], image: 'tea leaves falling into a cup' },
    { title: 'לפני 5000 שנה', body: 'כך מספרת המסורת הסינית על הרגע שבו הכול התחיל.', facts: ['f1'], image: 'ancient chinese tea garden' },
    { title: 'מסורת שנשארה', body: 'גם היום מכינים תה מעלים ומים רותחים, בדיוק כמו בסיפור.', facts: ['f1'], image: 'teapot pouring tea' },
  ],
  cta: { title: 'ומה מרתיחים אצלכם', body: 'קומקומים וקנקנים לתה מחכים לכם באתר', facts: [], image: 'kettle on a kitchen counter' },
  caption: 'לפי המסורת, התה התחיל בטעות. מה אתם שותים בבוקר?',
};

// What the image search was asked: each query, and the libraries it was allowed.
const searched = [];
const io = {
  read: async () => STORE,
  topic: async () => ({ niche: 'הסיפור של התה', angle: 'how tea was discovered', articles: [{ lang: 'he', title: 'תה' }] }),
  wiki: async (_src, api) => (api.title === 'תה' ? [ARTICLE] : []),
  fetchImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  write: async (_ctx, { store, docs }) => checkDraft(docs, DRAFT, { domain: store.domain }),
  photo: async (_ctx, { pack, query }) => {
    searched.push({ query, providers: pack.meta.imagery?.providers });
    if (query === DRAFT.cta.image) return null; // nothing found: the slide stands on the cover's photograph
    return { file: PHOTO, author: 'A Photographer', license: 'Pexels License', source_url: `https://www.pexels.com/photo/${encodeURIComponent(query)}` };
  },
  render: async ({ outDir, photos }) => {
    assert.equal(photos.size, 5, 'a Pexels photograph for every slide');
    for (const p of photos.values()) assert.doesNotMatch(p.file, /shelf|cdn\.example/, 'never a product of the store');
    const out = { tiktok: [], instagram: [] };
    for (const p of ['tiktok', 'instagram']) {
      for (const n of [1, 2]) {
        const file = path.join(outDir, `${p}-0${n}.jpg`);
        writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        out[p].push(file);
      }
    }
    return out;
  },
};

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  mkdirSync(ctx.mediaDir, { recursive: true });
  ctx.demoIo = io;
  PHOTO = path.join(home.home, 'pexels.jpg');
  writeFileSync(PHOTO, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
  op = fake.session(operator()).cookie;
  cust = fake.session(customer(1)).cookie;
});

after(async () => {
  await Promise.all([...running.values()]);
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const lead = (body, headers = {}) =>
  fetch(`${base}/internal/lead`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (p, cookie = '') => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/settings', cookie)).text())[1];
const post = async (p, cookie, body = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: await csrfOf(cookie), ...body }).toString() });
const feed = (headers = {}, at = base) => fetch(`${at}/internal/demos`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, ...headers } });
const opens = (id) => db.get('SELECT COUNT(*) AS opens, COUNT(DISTINCT visitor) AS visitors FROM demo_opens WHERE demo_id = ?', id);
const settle = () => Promise.all([...running.values()]);
const demo = () => db.get("SELECT * FROM demos WHERE domain = 'kettles.example.co.il'");

test("the store's document, its photographs, and the slideshow's checks: a topic from its field, facts from the articles", async () => {
  const doc = storeDocument(STORE);
  assert.match(doc.text, /הקטגוריות באתר: קומקומים, תה\./);
  assert.match(doc.text, /המחירים באתר: מ-149\.9 ₪ עד 289 ₪\./);
  assert.doesNotMatch(doc.text, /שאזל/, 'what is out of stock is not in it');
  const w1 = { key: 'w1', ...ARTICLE };
  assert.ok(checkFact(w1, { claim: 'התה התגלה לפני 5000 שנה', quote: QUOTE }).ok);
  assert.match(checkFact(w1, { claim: 'התה התגלה לפני 3000 שנה', quote: QUOTE }).error, /3000/, 'a number the quote does not say');
  assert.match(checkFact(w1, { claim: 'תה', quote: 'לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה…' }).error, /ellipsis/);
  assert.match(checkFact(null, { doc: 'w9', claim: 'תה', quote: QUOTE }).error, /no document/);
  const docs = [w1, { ...doc }];
  const ok = checkDraft(docs, DRAFT, { domain: STORE.domain });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.post.slides.length, 5, 'a cover, three content slides, and the last one');
  assert.equal(ok.post.slides.at(-1).role, 'cta');
  assert.equal(ok.post.extra.cta, 'kettles.example.co.il', "the last slide's line is the store's address");
  assert.equal(ok.post.facts[0].url, ARTICLE.url, 'each fact keeps where it came from');
  const bare = checkDraft(docs, { ...DRAFT, items: DRAFT.items.map((s) => ({ ...s, facts: [] })) }, { domain: STORE.domain });
  assert.ok(bare.problems.some((p) => /states no sourced fact/.test(p)), 'a content slide stands on a fact');
  const sold = checkDraft(docs, { ...DRAFT, cta: { ...DRAFT.cta, body: 'קומקומים מ-99 ₪ מחכים לכם באתר' } }, { domain: STORE.domain });
  assert.ok(sold.problems.some((p) => /99/.test(p)), 'the last slide says no number the documents do not');
  assert.deepEqual((await readArticles([{ lang: 'he', title: 'אין כזה' }, { lang: 'he', title: 'תה' }], { wiki: io.wiki })).map((a) => a.key), ['w1'], 'an article not found is left out');
});

test('the website hands in a request only from this machine, with the token, and not through the proxy', async () => {
  const body = { url: 'kettles.example.co.il', whatsapp: '972501234567' };
  assert.equal((await lead(body, { authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await lead(body, { authorization: '' })).status, 403);
  assert.equal((await lead(body, { 'x-forwarded-for': '203.0.113.9' })).status, 403, 'a request through Caddy is refused, token or not');
  assert.equal((await lead({ ...body, whatsapp: '12345' })).status, 400);
  assert.equal((await lead({ ...body, url: 'not a store' })).status, 400);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM demos').n, 0, 'none of these left a demo');
});

test('a request builds the demo in the background; asking again for the same store gives the same demo', async () => {
  const res = await lead({ url: 'https://kettles.example.co.il/collections/all', whatsapp: '972501234567' });
  assert.equal(res.status, 200);
  const first = await res.json();
  assert.equal(first.existing, false);
  await settle();
  const d = demo();
  assert.equal(d.status, 'approved', d.error);
  assert.equal(d.approved_by, 'auto', 'nobody approved it by hand');
  assert.match(d.slug, /^kettles-[0-9a-f]{6}$/);
  assert.match(d.docs_json, /התה התגלה/);
  assert.doesNotMatch(d.media_json, /"bg"/, 'no picture behind the page');
  assert.match(d.store_json, /logo\.jpg/, "the store's logo, saved");
  assert.deepEqual(searched.map((s) => s.query), [DRAFT.coverImage, ...DRAFT.items.map((s) => s.image), DRAFT.cta.image], "each slide's own search, in order");
  assert.ok(searched.every((s) => JSON.stringify(s.providers) === '["pexels"]'), 'Pexels only');
  assert.equal(JSON.parse(d.post_json).photos.length, 4, 'each photograph found, credited');
  const again = await (await lead({ url: 'kettles.example.co.il', whatsapp: '972529876543' })).json();
  assert.deepEqual([again.id, again.existing], [first.id, true]);
  assert.equal(demo().whatsapp, '972529876543', 'the latest number that asked');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM demos').n, 1);
});

test('the store\'s page is up once it is built; the operator\'s pages and buttons stay the operator\'s', async () => {
  const d = demo();
  assert.equal((await get(`/s/${d.slug}`)).status, 200);
  assert.equal((await get(`/s/${d.slug}/tiktok-0.jpg`)).status, 200);
  for (const p of ['/demos', `/demos/${d.id}`, `/demos/${d.id}/img/tiktok/0`]) {
    const res = await get(p, cust);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /kettles/, `${p} shows the store to a customer`);
  }
  for (const p of [`/demos/${d.id}/approve`, `/demos/${d.id}/remove`, `/demos/${d.id}/redo`, '/demos/offer']) {
    const res = await post(p, cust, { monthly: '1' });
    assert.ok(res.status >= 400 && res.status < 500, `${p}: ${res.status}`);
  }
  assert.equal(demo().status, 'approved');
  assert.equal(db.get("SELECT value_json FROM settings WHERE key = 'demo-offer'"), null);
});

test('the operator sees it, and the store\'s page shows its name, its slides, where each fact came from', async () => {
  const d = demo();
  const list = await (await get('/demos', op)).text();
  assert.match(list, /kettles\.example\.co\.il/);
  const one = await (await get(`/demos/${d.id}`, op)).text();
  assert.match(one, /לפי המסורת הסינית, התה התגלה לפני 5000 שנה/);
  assert.match(one, /הסיפור של התה/);
  assert.doesNotMatch(one, /לאשר ולהעלות את העמוד/, 'nothing to approve');
  assert.match(one, /באוויר/);
  const img = await get(`/demos/${d.id}/img/instagram/1`, op);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await post(`/demos/${d.id}/approve`, op)).status, 400, 'already up');
  const res = await get(`/s/${d.slug}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const page = await res.text();
  assert.match(page, /<meta name="robots" content="noindex/);
  assert.match(page, /<span class="hl"><bdi>חנות הקומקומים<\/bdi><\/span>/);
  assert.match(page, new RegExp(`src="/s/${d.slug}/tiktok-0\\.jpg"`));
  assert.match(page, new RegExp(`src="/s/${d.slug}/instagram-1\\.jpg"`));
  assert.match(page, /מאיפה כל עובדה/);
  assert.match(page, /התמונות מ־<a href="https:\/\/www\.pexels\.com"/);
  assert.match(page, /מצגת על <bdi>הסיפור של התה<\/bdi>/);
  assert.ok(page.includes(`<span class="logo"><img src="/s/${d.slug}/logo" alt="חנות הקומקומים"></span>`), "the store's own logo, not its initial");
  assert.equal((await get(`/s/${d.slug}/logo`)).headers.get('content-type'), 'image/jpeg');
  assert.doesNotMatch(page, /band-bg|bg.jpg/, 'the page stands on the silver wallpaper, no photograph behind it');
  assert.match(await (await get(`/s/${d.slug}/theme.css`)).text(), /--store:#0A7D4F/, "the store's own colour, where white reads on it");
  assert.equal((await get(`/s/${d.slug}/p-0.jpg`)).status, 200, 'its products beside the title');
  assert.ok(page.includes('<dt>מוצרים</dt><dd>2</dd>'), 'what was read on its site');
  assert.match(page, /https:\/\/openfrequency\.co\.il\/join\?p=teder/);
  assert.doesNotMatch(page, /לחודש/, 'no price until one is set');
  assert.doesNotMatch(page, /972/, "the number that asked is not on the store's page");
  const slide = await get(`/s/${d.slug}/tiktok-1.jpg`);
  assert.equal(slide.status, 200);
  assert.equal((await get(`/s/${d.slug}/tiktok-9.jpg`)).status, 404);
  assert.equal((await get(`/s/${d.slug.slice(0, -1)}x`)).status, 404, 'a slug guessed wrong finds nothing');
});

test('the price the operator sets is on the store\'s page, VAT and the setup fee with it', async () => {
  const d = demo();
  assert.equal((await post('/demos/offer', op, { monthly: 'abc' })).status, 400);
  assert.equal((await post('/demos/offer', op, { monthly: '790', setup: '1,490', vat: 'excluded' })).status, 200);
  const page = await (await get(`/s/${d.slug}`)).text();
  assert.ok(page.includes('<span class="num">790</span><span class="cur">₪</span><span class="per">לחודש</span>'), 'the figure');
  assert.ok(page.includes('לא כולל מע״מ. בחודש הראשון יש גם 1,490 ₪ דמי הקמה, פעם אחת.'), 'VAT and the setup fee under it');
  assert.ok(page.includes('מה כלול במחיר'));
});

test("the store's page says the team fits Teder to the business and connects it, with the systems' marks, before the price", async () => {
  const d = demo();
  const page = await (await get(`/s/${d.slug}`)).text();
  const sec = page.match(/<section class="links" aria-labelledby="links-h">[\s\S]*?<\/section>/)?.[0];
  assert.ok(sec, 'the section');
  assert.ok(page.indexOf(sec) < page.indexOf('<section class="price"'), 'before the price card');
  assert.ok(page.indexOf(sec) > page.indexOf('id="show"'), 'after the slideshow');
  assert.ok(sec.includes('<h2 id="links-h">מותאם לעסק שלכם. החיבורים עלינו.</h2>'));
  assert.ok(sec.includes('ההתאמה והחיבורים הם חלק מהשירות, בלי תוספת תשלום.'), 'the lede, at no extra cost');
  assert.ok(sec.includes('את ההדגמה הזו תדר בנה מהמוצרים שבאתר שלכם: חנות ב-Shopify, ב-WooCommerce או ב-Wix הוא קורא לבד.'), 'what it reads on its own, said as it is');
  for (const name of ['TikTok', 'Instagram', 'Facebook', 'YouTube', 'Shopify', 'WooCommerce', 'Wix', 'Google Drive', 'Canva'])
    assert.ok(sec.includes(`role="img" aria-label="${name}"`), name);
  assert.ok(sec.includes('<li class="wide" title="WooCommerce">'), 'the wordmark on a wider tile');
  assert.ok(sec.includes('<span>וכל חיבור נוסף שתרצו וקיים בעולם</span>'), 'the tile for anything else');
  assert.ok(sec.includes('<h3>וכשצריך משהו שעוד לא קיים, מפתחים אותו.</h3>'), 'the note');
  assert.ok(sec.includes('הצוות שבנה את תדר בונה גם אותם, וגם זה כלול בשירות.'));
  assert.doesNotMatch(sec, /style=|<img|https?:\/\//, 'inline SVG only, no inline style and nothing loaded from elsewhere');
});

test("a view of the store's page by someone not signed in is an open; a cookie counts the browsers; never the operator's, never its pictures", async () => {
  const d = demo();
  db.run('DELETE FROM demo_opens');
  const first = await get(`/s/${d.slug}`);
  assert.equal(first.status, 200);
  const set = first.headers.get('set-cookie');
  assert.match(set, /^of_v=[\w-]{16}; Path=\/s; Max-Age=31536000; SameSite=Lax; HttpOnly$/, 'a random id, a year, HttpOnly, Lax (Secure only over HTTPS)');
  const v = set.split(';')[0];
  const again = await get(`/s/${d.slug}`, v);
  assert.equal(again.headers.get('set-cookie'), null, 'a browser that has one keeps it');
  assert.deepEqual({ ...opens(d.id) }, { opens: 2, visitors: 1 }, 'the same browser twice: two opens, one visitor');
  await get(`/s/${d.slug}`);
  assert.deepEqual({ ...opens(d.id) }, { opens: 3, visitors: 2 }, 'another browser');
  for (const p of ['tiktok-0.jpg', 'instagram-1.jpg', 'p-0.jpg', 'logo', 'theme.css']) assert.equal((await get(`/s/${d.slug}/${p}`, v)).status, 200, p);
  await fetch(`${base}/s/${d.slug}`, { method: 'HEAD' });
  assert.equal(opens(d.id).opens, 3, 'its pictures, its colour and a HEAD are no opens');
  for (const who of [op, cust]) assert.equal((await get(`/s/${d.slug}`, `${who}; ${v}`)).status, 200);
  assert.equal(opens(d.id).opens, 3, 'a signed-in session, the operator or a customer, never counts');
  await get(`/s/${d.slug}`, 'of_session=not-a-session-anyone-has-000000');
  assert.equal(opens(d.id).opens, 4, 'a session cookie accounts does not know is a visitor');
  await get(`/s/${d.slug.slice(0, -1)}x`);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM demo_opens').n, 4, 'a page that is not there is no open');
  assert.doesNotMatch(JSON.stringify(db.all('SELECT * FROM demo_opens')), /127\.0\.0\.1|::1/, 'never the address');
  const list = await (await get('/demos', op)).text();
  assert.ok(list.includes('נפתח 4 פעמים, ב־3 דפדפנים'), "on the operator's list");
  const one = await (await get(`/demos/${d.id}`, op)).text();
  assert.match(one, /נפתח 4 פעמים, ב־3 דפדפנים, לאחרונה /, 'and on its page, with the last one');
});

test("Toran's dashboard reads every demo at /internal/demos: from this machine alone, with the token, not through the proxy", async () => {
  for (const [headers, why] of [[{ authorization: '' }, 'no token'], [{ authorization: 'Bearer wrong' }, 'a wrong token'], [{ authorization: `Bearer ${INTERNAL_TOKEN}x` }, 'a longer one'], [{ 'x-forwarded-for': '203.0.113.9' }, 'through Caddy']]) {
    const res = await feed(headers);
    assert.equal(res.status, 403, why);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await res.text(), /kettles/, why);
  }
  const req = (remoteAddress, headers = {}) => ({ headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, ...headers }, socket: { remoteAddress } });
  const env = { OF_INTERNAL_TOKEN: INTERNAL_TOKEN };
  assert.equal(fromWebsite(req('203.0.113.9'), env), false, 'a socket that is not loopback');
  assert.equal(fromWebsite(req('10.0.0.5'), env), false);
  assert.ok(fromWebsite(req('127.0.0.1'), env) && fromWebsite(req('::1'), env) && fromWebsite(req('::ffff:127.0.0.1'), env));
  assert.equal(fromWebsite(req('127.0.0.1'), { OF_INTERNAL_TOKEN: 'short' }), false, 'a token under 32 characters opens nothing');
  assert.notEqual((await fetch(`${base}/internal/demos`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).status, 200, 'a GET only');

  const res = await feed();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const { demos } = await res.json();
  const d = demo();
  assert.equal(demos.length, 1);
  assert.deepEqual(Object.keys(demos[0]), ['id', 'domain', 'url', 'name', 'status', 'whatsapp', 'pageUrl', 'createdAt', 'readyAt', 'approvedAt', 'removedAt', 'error', 'opens', 'visitors', 'lastOpenAt']);
  const last = db.get('SELECT MAX(at) AS at FROM demo_opens WHERE demo_id = ?', d.id).at;
  assert.deepEqual(demos[0], {
    id: d.id, domain: 'kettles.example.co.il', url: d.url, name: 'חנות הקומקומים', status: 'approved', whatsapp: '972529876543',
    pageUrl: `${base}/s/${d.slug}`, createdAt: d.created_at, readyAt: d.approved_at, approvedAt: d.approved_at, removedAt: null, error: null,
    opens: 4, visitors: 3, lastOpenAt: last,
  });
  assert.match(demos[0].readyAt, /^\d{4}-\d\d-\d\dT/);

  // On the VPS the page's address is the public name's, over HTTPS, whatever address Toran asked at.
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env, PUBLIC_HOST: 'teder.example.test' } });
  try {
    const out = await (await feed({}, `http://127.0.0.1:${s.port}`)).json();
    assert.equal(out.demos[0].pageUrl, `https://teder.example.test/s/${d.slug}`);
  } finally {
    s.server.close();
  }
});

test('taken down, the page is gone; a demo taken down is not written again', async () => {
  const d = demo();
  assert.equal((await post(`/demos/${d.id}/remove`, op)).status, 200);
  assert.equal((await get(`/s/${d.slug}`)).status, 404);
  assert.equal((await post(`/demos/${d.id}/redo`, op)).status, 400);
  const res = await lead({ url: 'kettles.example.co.il', whatsapp: '972501234567' });
  assert.equal((await res.json()).existing, false, 'asking after a takedown starts a new demo');
  await settle();
});

test('the dashboard sees a demo taken down without its page, and the new one first; at most 500, newest first', async () => {
  const { demos } = await (await feed()).json();
  assert.equal(demos.length, 2);
  const [fresh, gone] = demos;
  assert.ok(fresh.id > gone.id, 'newest first');
  assert.equal(gone.status, 'removed');
  assert.equal(gone.pageUrl, null, 'not public: no address');
  assert.match(gone.removedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(gone.opens, 4, 'its opens stay');
  assert.equal(fresh.status, 'approved');
  assert.equal(fresh.pageUrl, `${base}/s/${db.get('SELECT slug FROM demos WHERE id = ?', fresh.id).slug}`);
  assert.deepEqual([fresh.opens, fresh.visitors, fresh.lastOpenAt], [0, 0, null]);
  const t = '2020-01-01T00:00:00.000Z';
  db.tx(() => {
    for (let i = 0; i < 505; i++) db.insert('demos', { slug: `old-${String(i).padStart(4, '0')}`, url: `https://old${i}.example`, domain: `old${i}.example`, status: 'failed', error: 'x', created_at: t, updated_at: t });
  });
  const many = (await (await feed()).json()).demos;
  assert.equal(many.length, 500);
  assert.equal(many[0].id, fresh.id, 'the newest still first');
  assert.deepEqual([many.at(-1).name, many.at(-1).pageUrl, many.at(-1).readyAt], [null, null, null], 'a demo that knows nothing of its store has no name');
  db.run("DELETE FROM demos WHERE slug LIKE 'old-%'");
});
