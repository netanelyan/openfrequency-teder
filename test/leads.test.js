import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { ROOT } from '../src/core/paths.js';
import { running } from '../src/web/demos.js';
import { checkDraft } from '../src/demos/write.js';
import { DemoError } from '../src/demos/store.js';
import { leadsSource, leadsTick, refreshStages, syncLeads } from '../src/leads/sync.js';
import { le, notOnShabbat, reminderDue, reminderReady, TEDER_COLD_FIRST, TEDER_REMINDER, topicOf } from '../src/leads/messages.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, listenFree, operator, opened, serverFree, tempHome, viewingAs } from './helpers.js';

// The operator's leads (src/leads, src/web/leads.js): the stores Toran found, copied once an hour from Toran's
// GET /internal/stores (a stub here, answering as test/fixtures/toran-stores.json says), each a card on /leads with
// its one next step. Paging and the cursor, a contact kept when Toran stops sending it, a store that asked not to be
// written to hidden, a store one of our customers already has left out, nothing asked without the token; the page the
// operator's alone; the demo built on a click only, through the stand-in builder (ctx.demoIo: no model is ever
// called), with no WhatsApp number; the first message and every way to send it; the one reminder four days later and
// never on Shabbat; and the move to "פתחו" when the store opens its page. Each card says what the store says about
// itself (Toran's about) or its platform and domain, and, once its demo has a topic, the idea for their TikTok and
// Instagram, which the first message names.

const EXAMPLE = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'toran-stores.json'), 'utf8'));
const KETTLES = EXAMPLE.routes[0].answers[0].body.stores[0];
const EPOCH = '1970-01-01T00:00:00.000Z';
const T1 = '2026-11-05T09:30:00.000001Z';

const store = (id, domain, extra = {}) => ({
  id,
  domain,
  url: `https://${domain}/`,
  name: `חנות ${id}`,
  platform: 'shopify',
  score: 60,
  toranStatus: 'page_ready',
  contact: { email: null, whatsapp: null, phone: null },
  social: { instagram: null, tiktok: null, facebook: null },
  optedOut: false,
  updatedAt: '2026-11-05T09:00:00.000001Z',
  ...extra,
});
// No social profile, the highest score; one on TikTok with a low one; one with nothing Toran sent fit to keep.
const PLAIN = store(42, 'plain.example.co.il', { name: 'החנות הפשוטה', score: 90, updatedAt: '2026-11-05T09:20:00.000001Z' });
const SOCIAL = store(43, 'social.example.co.il', { score: 40, social: { instagram: null, tiktok: 'https://www.tiktok.com/@social.example', facebook: null }, updatedAt: '2026-11-05T09:30:00.000001Z' });
const CUSTOMER = store(44, 'www.customer-shop.example.co.il', { updatedAt: '2026-11-05T09:25:00.000000Z' });
const BAD = store(45, 'broken.example.co.il', {
  contact: { email: 'not an address', whatsapp: 'call me', phone: '<b>' },
  social: { instagram: 'javascript:alert(1)', tiktok: 'http://www.tiktok.com/@x', facebook: 'https://evil.example/facebook.com' },
  updatedAt: '2026-11-05T09:40:00.000001Z',
});
const GONE = store(46, 'asked-not.example.co.il', { optedOut: true, updatedAt: '2026-11-05T09:41:00.000001Z' });

const product = (id, title, src, price = '289.00') => ({ id, title, handle: `p${id}`, published_at: '2026-10-01', images: [{ src }, { src: `${src}?2` }], variants: [{ price, available: true }], options: [] });
const shopOf = (url) => {
  const domain = new URL(url).hostname;
  return { origin: `https://${domain}`, domain, name: 'החנות הפשוטה', currency: 'ILS', accent: '#0A7D4F', products: [product(11, 'קומקום חשמלי', 'https://cdn.example.test/kettle.jpg'), product(12, 'קנקן תה', 'https://cdn.example.test/teapot.jpg', '149.90')], collections: ['קומקומים', 'תה'] };
};
const ARTICLE = { url: 'https://he.wikipedia.org/wiki/%D7%AA%D7%94', title: 'תה', text: 'התה הוא משקה שמכינים מעלים של צמח התה. לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה כשעלים נפלו לתוך מים רותחים.' };
const QUOTE = 'לפי המסורת הסינית, התה התגלה לפני כ-5000 שנה כשעלים נפלו לתוך מים רותחים.';
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

let home;
let ctx;
let db;
let fake;
let server;
let base;
let op;
let cust;
let viewer;
let toran;
let toranBase;
let PHOTO;
const logs = [];
// What the stand-in builder was asked: the store's address of each build, and what each one wrote.
const built = [];
let gate = null;

const io = {
  read: async (url) => {
    built.push(url);
    if (gate) await gate.promise;
    if (/broken\.example/.test(url)) throw new DemoError('לא מצאנו בחנות מוצרים עם תמונה, מחיר ומלאי');
    return shopOf(url);
  },
  topic: async () => ({ niche: 'הסיפור של התה', angle: 'how tea was discovered', articles: [{ lang: 'he', title: 'תה' }] }),
  wiki: async () => [ARTICLE],
  fetchImage: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  write: async (_ctx, { store: s, docs }) => checkDraft(docs, DRAFT, { domain: s.domain }),
  photo: async () => ({ file: PHOTO, author: 'A Photographer', license: 'Pexels License', source_url: 'https://www.pexels.com/photo/1' }),
  render: async ({ outDir }) => {
    const out = { tiktok: [], instagram: [] };
    for (const p of ['tiktok', 'instagram']) {
      const file = path.join(outDir, `${p}-01.jpg`);
      writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      out[p].push(file);
    }
    return out;
  },
};

/** A stand-in for Toran's GET /internal/stores: `pages(since)` answers, `status` overrides, `asked` keeps each request. */
async function stubToran() {
  const state = { asked: [], status: null, pages: () => ({ stores: [], next: null }) };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://toran');
    const out = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname !== '/internal/stores') return out(404, { error: 'not_found' });
    state.asked.push({ since: url.searchParams.get('since'), limit: url.searchParams.get('limit'), auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) return out(401, { error: 'bad_token' });
    if (state.status) return out(state.status, { error: 'down' });
    return out(200, state.pages(url.searchParams.get('since')));
  });
  const port = await serverFree(srv);
  return { state, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) };
}

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: (m) => logs.push(m) });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  mkdirSync(ctx.mediaDir, { recursive: true });
  ctx.demoIo = io;
  PHOTO = path.join(home.home, 'pexels.jpg');
  writeFileSync(PHOTO, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  toran = await stubToran();
  toranBase = toran.base;
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'l'.repeat(40), ...fake.env, OF_TORAN_INTERNAL: toranBase } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
  op = fake.session(operator()).cookie;
  cust = fake.session(customer(1)).cookie;
  viewer = fake.session(viewingAs(1)).cookie;
});

after(async () => {
  setNow(null);
  gate?.open();
  await Promise.all([...running.values()]);
  server?.close();
  await fake?.close();
  await toran?.close();
  home?.cleanup();
});

const env = () => ({ OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_TORAN_INTERNAL: toranBase });
const get = (p, cookie = '') => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/settings', cookie)).text())[1];
const post = async (p, cookie, body = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: await csrfOf(cookie), ...body }).toString() });
const lead = (domain) => db.get('SELECT * FROM leads WHERE domain = ?', domain);
const settle = () => Promise.all([...running.values()]);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** One lead's card in a page. */
const cardOf = (html, id) => {
  const m = new RegExp(`<article class="card lead[^"]*" id="lead-${id}">([\\s\\S]*?)</article>`).exec(html);
  assert.ok(m, `the card of lead ${id} is on the page`);
  return m[1];
};
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => unesc(m[1]));
const opener = (d) => ({ id: db.insert('demos', { slug: `${d.split('.')[0]}-a1b2c3`, url: `https://${d}`, domain: d, whatsapp: '972500000001', origin: 'website', status: 'approved', store_json: { name: 'x' }, media_json: { tiktok: [], instagram: [] }, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z', approved_at: '2026-11-01T10:00:00.000Z' }), slug: `${d.split('.')[0]}-a1b2c3` });

test('the sync: two pages from the cursor, a customer\'s store and one that asked not to be written to left out, what Toran sent checked', async () => {
  // One of our customers typed this site on /new: the store is theirs already, and Teder is not offered to it.
  db.insert('onboarding', { id: 'o-customer', seed_json: { niche: 'קומקומים', site: 'https://customer-shop.example.co.il' }, status: 'live', workspace_id: 7, created_at: '2026-11-01T10:00:00.000Z', updated_at: '2026-11-01T10:00:00.000Z' });
  // The store already asked for a demo on the website: its lead is linked to it, its page ready to send.
  const asked = opener('kettles.example.co.il');
  toran.state.pages = (since) => (since === EPOCH ? { stores: [KETTLES, PLAIN, CUSTOMER], next: T1 } : since === T1 ? { stores: [SOCIAL, BAD, GONE], next: null } : { stores: [], next: null });
  const r = await syncLeads(ctx, { env: env() });
  assert.deepEqual(r, { added: 4, updated: 0, hidden: 1, customers: 1, skipped: 0, pages: 2 });
  assert.deepEqual(toran.state.asked.map((a) => [a.since, a.limit, a.auth]), [[EPOCH, '500', `Bearer ${INTERNAL_TOKEN}`], [T1, '500', `Bearer ${INTERNAL_TOKEN}`]], 'asked from the start, then from next exactly as Toran wrote it');
  assert.equal(db.get("SELECT value_json FROM settings WHERE key = 'leads:cursor'").value_json, JSON.stringify(GONE.updatedAt), 'the next hour asks from the latest change, to the microsecond');

  const k = lead('kettles.example.co.il');
  assert.deepEqual(
    { name: k.name, platform: k.platform, about: k.about, score: k.score, toran: k.toran_status, email: k.email, whatsapp: k.whatsapp, phone: k.phone, ig: k.instagram, tt: k.tiktok, fb: k.facebook, stage: k.stage, demo: k.demo_id, toranId: k.toran_id },
    { name: 'חנות הקומקומים', platform: 'shopify', about: KETTLES.about, score: 78, toran: 'page_ready', email: 'hello@kettles.example.co.il', whatsapp: '972501234567', phone: '035551234', ig: 'https://www.instagram.com/kettles.example/', tt: 'https://www.tiktok.com/@kettles.example', fb: null, stage: 'demo_ready', demo: asked.id, toranId: '41' }
  );
  assert.ok(KETTLES.about, "the contract's example has a line about the store");
  assert.equal(lead('plain.example.co.il').stage, 'new');
  assert.equal(lead('plain.example.co.il').about, null, 'a store Toran sent no about for has none');
  assert.equal(lead('customer-shop.example.co.il'), null, "a customer's store is not a lead, with or without www.");
  assert.equal(lead('asked-not.example.co.il'), null, 'a store that asked not to be written to is not kept');
  const b = lead('broken.example.co.il');
  assert.deepEqual([b.email, b.whatsapp, b.phone, b.instagram, b.tiktok, b.facebook], [null, null, null, null, null, null], 'nothing Toran sent that is not an address, a number or an https profile on its own network');

  // The next hour: Toran has the kettles store's email no more and a new number, and the broken one asked to stop.
  toran.state.asked.length = 0;
  toran.state.pages = () => ({ stores: [{ ...KETTLES, about: null, contact: { email: null, whatsapp: '972509999999', phone: null }, social: { instagram: null, tiktok: null, facebook: null }, updatedAt: '2026-11-05T10:00:00.000002Z' }, { ...BAD, optedOut: true, updatedAt: '2026-11-05T10:00:00.000003Z' }], next: null });
  const r2 = await syncLeads(ctx, { env: env() });
  assert.equal(r2.updated, 1);
  assert.equal(r2.hidden, 1);
  assert.deepEqual(toran.state.asked.map((a) => a.since), [GONE.updatedAt], 'from where the last one ended');
  const k2 = lead('kettles.example.co.il');
  assert.deepEqual([k2.email, k2.whatsapp, k2.phone, k2.instagram, k2.tiktok, k2.about], ['hello@kettles.example.co.il', '972509999999', '035551234', KETTLES.social.instagram, KETTLES.social.tiktok, KETTLES.about], 'a value is replaced by another, never by nothing, the line about the store too');
  // Toran's about changes: the new line replaces the old one, whitespace collapsed.
  toran.state.pages = () => ({ stores: [{ ...KETTLES, about: '  קומקומים חשמליים,\n קנקנים וכלי תה מכל העולם. ', contact: { email: null, whatsapp: '972509999999', phone: null }, social: { instagram: null, tiktok: null, facebook: null }, updatedAt: '2026-11-05T10:00:00.000004Z' }], next: null });
  assert.equal((await syncLeads(ctx, { env: env() })).updated, 1);
  assert.equal(lead('kettles.example.co.il').about, 'קומקומים חשמליים, קנקנים וכלי תה מכל העולם.');
  assert.ok(lead('broken.example.co.il').opted_out_at, 'opted out');
  const page = await (await get('/leads?tab=new', op)).text();
  assert.doesNotMatch(page, /broken\.example/, 'and hidden from the page');
  assert.match(page, /עודכן מתורן/);
});

test('without the token or with OF_TORAN_INTERNAL off nothing is asked and the page says so; Toran down is a log line; once an hour', async () => {
  toran.state.asked.length = 0;
  assert.deepEqual(await syncLeads(ctx, { env: { OF_TORAN_INTERNAL: toranBase } }), { why: 'token' });
  assert.deepEqual(await syncLeads(ctx, { env: { OF_INTERNAL_TOKEN: INTERNAL_TOKEN, OF_TORAN_INTERNAL: 'off' } }), { why: 'off' });
  assert.equal(toran.state.asked.length, 0, 'Toran was not asked');
  assert.deepEqual(leadsSource({ OF_INTERNAL_TOKEN: INTERNAL_TOKEN }), { url: 'http://127.0.0.1:4710/internal/stores' }, "Toran's own port when OF_TORAN_INTERNAL is empty, as the alerts have it");
  // A server whose Toran is off says it on the page, plainly, and offers no sync.
  const off = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'l'.repeat(40), ...fake.env, OF_TORAN_INTERNAL: 'off' } });
  try {
    const html = await (await fetch(`http://127.0.0.1:${off.port}/leads`, { headers: { cookie: op } })).text();
    assert.match(html, /הלידים לא מגיעים מתורן/);
    assert.match(html, /OF_TORAN_INTERNAL מוגדר off/);
    assert.doesNotMatch(html, /action="\/leads\/sync"/);
  } finally {
    await off.close();
  }

  toran.state.status = 500;
  logs.length = 0;
  const r = await syncLeads(ctx, { env: env() });
  assert.match(r.error, /HTTP 500/);
  assert.ok(logs.some((l) => /^\[leads\] Toran's stores were not read: .*HTTP 500/.test(l)), 'a log line');
  assert.ok(!logs.join('\n').includes(INTERNAL_TOKEN), 'the token is in no line');
  assert.match(await (await get('/leads', op)).text(), /העדכון האחרון מתורן לא הצליח/);
  toran.state.status = null;

  const t0 = Date.parse('2026-11-05T12:00:00.000Z');
  db.run("DELETE FROM settings WHERE key = 'leads:synced'");
  toran.state.asked.length = 0;
  assert.ok(await leadsTick(ctx, { t: t0, env: env() }), 'the first tick asks');
  assert.equal(await leadsTick(ctx, { t: t0 + 59 * 60_000, env: env() }), null, 'not again inside the hour');
  assert.ok(await leadsTick(ctx, { t: t0 + 61 * 60_000, env: env() }), 'and again after it');
  assert.equal(toran.state.asked.length, 2);
});

test("the page is the operator's: a customer finds no such page or button, view-as changes nothing, the menu has it for the operator only", async () => {
  const id = lead('plain.example.co.il').id;
  for (const p of ['/leads', '/leads?tab=ready', '/leads/status.json']) {
    const res = await get(p, cust);
    assert.equal(res.status, 404, p);
    assert.doesNotMatch(await res.text(), /plain\.example|החנות הפשוטה/, p);
    assert.equal((await get(p, viewer)).status, 404, `${p} in view-as`);
  }
  const before = JSON.stringify(lead('plain.example.co.il'));
  const no = await post(`/leads/${id}/irrelevant`, cust);
  assert.equal(no.status, 404);
  const ro = await post(`/leads/${id}/irrelevant`, viewer);
  assert.equal(ro.status, 403);
  assert.match((await ro.json()).message, /צפייה בלבד/);
  assert.equal((await post('/leads/sync', cust)).status, 404);
  assert.equal(JSON.stringify(lead('plain.example.co.il')), before, 'nothing changed');
  assert.match(await (await get('/settings', op)).text(), /<a href="\/leads" title="לידים">/, "in the operator's menu");
  for (const who of [cust, viewer]) {
    const html = await (await get('/settings', who)).text();
    assert.match(html, /<a href="\/settings"/, 'a page with the menu');
    assert.doesNotMatch(html, /href="\/leads"/, "in nobody else's menu, view-as included");
  }
});

test('the tabs count each stage, and a store on TikTok or Instagram comes first in its tab', async () => {
  const html = await (await get('/leads', op)).text();
  assert.match(html, /<a href="\/leads\?tab=new" aria-current="true">חדש<span class="num">2<\/span><\/a>/, 'plain and social; broken is hidden');
  assert.match(html, /<a href="\/leads\?tab=ready">דמו מוכן<span class="num">1<\/span><\/a>/);
  for (const label of ['נשלח', 'פתחו', 'ענו והצטרפו', 'לא רלוונטי']) assert.match(html, new RegExp(`>${label}<span class="num">0</span>`));
  const social = lead('social.example.co.il').id;
  const plain = lead('plain.example.co.il').id;
  assert.ok(html.indexOf(`id="lead-${social}"`) < html.indexOf(`id="lead-${plain}"`), 'the store on TikTok first, though its score is lower');
  assert.match(cardOf(html, social), /כבר בטיקטוק/);
  assert.match(cardOf(html, social), /href="https:\/\/www\.tiktok\.com\/@social\.example"/);
  for (const id of [social, plain]) {
    const card = cardOf(html, id);
    assert.equal((card.match(/btn primary/g) || []).length, 1, 'one blue button a card');
    assert.match(card, /לבנות דמו/);
    // Toran sent nothing about these two: the line under the name is the platform and the domain, and the platform
    // is not said again in a chip.
    const domain = lead(id === social ? 'social.example.co.il' : 'plain.example.co.il').domain;
    assert.match(card, new RegExp(`</h2><p class="lead-about"><span class="ltr">Shopify</span> · <span class="ltr">${domain.replace(/\./g, '\\.')}</span></p></div>`));
    assert.doesNotMatch(card, /<span class="chip">Shopify<\/span>/);
    assert.doesNotMatch(card, /הדמו נבנה רק כשלוחצים/, 'not on each card');
    assert.doesNotMatch(card, /רעיון לטיקטוק/, 'no idea before there is a demo: building it is the step the operator pays for');
    assert.doesNotMatch(card, /class="lead-body"/, 'and no empty box where the sentence was');
  }
  assert.equal((html.match(/הדמו נבנה רק כשלוחצים על "לבנות דמו": מצגת אחת על נושא מהתחום של החנות, ועמוד שאפשר לשלוח לה\./g) || []).length, 1, 'said once, above the new stores');
  assert.ok(html.indexOf('class="leads-lede"') < html.indexOf('class="posts leads"'));
  // The kettles store said something about itself: that is the line under its name, muted, and its platform is a chip.
  const ready = await (await get('/leads?tab=ready', op)).text();
  const kettles = cardOf(ready, lead('kettles.example.co.il').id);
  assert.match(kettles, /<\/h2><p class="lead-about" dir="auto">קומקומים חשמליים, קנקנים וכלי תה מכל העולם\.<\/p><\/div>/);
  assert.doesNotMatch(kettles, /<span class="ltr">kettles\.example\.co\.il<\/span>/, 'the line about it instead of its domain');
  assert.match(kettles, /<span class="chip">Shopify<\/span>/);
  assert.doesNotMatch(ready, /הדמו נבנה רק כשלוחצים/, 'the sentence is about the new stores only');
});

test('"לבנות דמו" builds on the click only, with no WhatsApp number, through the stand-in builder; the website still needs a number', async () => {
  assert.deepEqual(built, [], 'nothing was built by the sync or by opening the page');
  const id = lead('plain.example.co.il').id;
  let release;
  gate = { promise: new Promise((r) => (release = r)), open: () => release() };
  const res = await post(`/leads/${id}/demo`, op);
  assert.equal(res.status, 200, await res.clone().text());
  const d = db.get("SELECT * FROM demos WHERE domain = 'plain.example.co.il'");
  assert.deepEqual([d.whatsapp, d.origin], [null, 'outreach']);
  assert.equal(lead('plain.example.co.il').demo_id, d.id);
  // While it is built, the card says so, the page asks how it goes, and a second click builds nothing more.
  const page = await (await get('/leads?tab=new', op)).text();
  assert.match(cardOf(page, id), /בונים את הדמו/);
  assert.doesNotMatch(cardOf(page, id), /לבנות דמו/);
  assert.match(page, /data-poll="\/leads\/status\.json"/);
  assert.equal((await (await get('/leads/status.json', op)).json()).busy, true);
  const again = await post(`/leads/${id}/demo`, op);
  assert.equal(again.status, 400);
  assert.match((await again.json()).message, /נבנה עכשיו/);
  gate.open();
  gate = null;
  await settle();
  assert.deepEqual(built, ['https://plain.example.co.il'], 'one build, of the store the lead is');
  assert.equal(db.get('SELECT status FROM demos WHERE id = ?', d.id).status, 'approved');
  assert.equal((await (await get('/leads/status.json', op)).json()).busy, false);
  assert.equal(lead('plain.example.co.il').stage, 'demo_ready', 'its page is up, so it is ready to send');
  // The topic the build chose for its slideshow is kept on the demo, and is the card's idea for their accounts.
  assert.equal(topicOf(db.get('SELECT topic_json FROM demos WHERE id = ?', d.id).topic_json), 'הסיפור של התה');
  const ready = cardOf(await (await get('/leads?tab=ready', op)).text(), id);
  assert.match(ready, /<p class="lead-idea">רעיון לטיקטוק ולאינסטגרם שלהם: <bdi>הסיפור של התה<\/bdi><\/p>/);
  assert.equal((ready.match(/רעיון לטיקטוק ולאינסטגרם שלהם/g) || []).length, 1, 'one line');

  // A build that fails says why on the card, and the one step is to try again.
  const broken = lead('broken.example.co.il');
  db.run('UPDATE leads SET opted_out_at = NULL WHERE id = ?', broken.id);
  assert.equal((await post(`/leads/${broken.id}/demo`, op)).status, 200);
  await settle();
  const card = cardOf(await (await get('/leads?tab=new', op)).text(), broken.id);
  assert.match(card, /הדמו לא נבנה: לא מצאנו בחנות מוצרים עם תמונה, מחיר ומלאי/);
  assert.match(card, /<button class="btn primary" type="submit">לנסות שוב<\/button>/);
  db.run('UPDATE leads SET opted_out_at = ? WHERE id = ?', '2026-11-05T10:00:00.000Z', broken.id);

  // The website's path is as it was: a number is needed, and its demos are the ones Toran's dashboard reads.
  const intake = (body) => fetch(`${base}/internal/lead`, { method: 'POST', headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await intake({ url: 'https://asked.example.co.il' })).status, 400);
  assert.equal((await intake({ url: 'https://asked.example.co.il', whatsapp: '972501112233' })).status, 200);
  await settle();
  const feed = await (await fetch(`${base}/internal/demos`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json();
  const domains = feed.demos.map((x) => x.domain);
  assert.ok(domains.includes('asked.example.co.il') && domains.includes('kettles.example.co.il'), 'the demos stores asked for');
  assert.ok(!domains.includes('plain.example.co.il') && !domains.includes('broken.example.co.il'), "a lead's demo is not offered on Toran as one a store asked for");
});

test('"דמו מוכן": the cold first message, never "ביקשתם", and a button for every way to reach the store; "שלחתי" with the way', async () => {
  const k = lead('kettles.example.co.il');
  const slug = db.get('SELECT slug FROM demos WHERE id = ?', k.demo_id).slug;
  const card = cardOf(await (await get('/leads?tab=ready', op)).text(), k.id);
  const msg = TEDER_COLD_FIRST({ storeName: 'חנות הקומקומים', url: `${base}/s/${slug}` });
  assert.equal(unesc(/<textarea id="msg-\d+" rows="9" readonly dir="rtl">([\s\S]*?)<\/textarea>/.exec(card)[1]), msg);
  assert.doesNotMatch(card, /ביקשתם/);
  assert.ok(msg.startsWith('היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין'));
  assert.match(msg, /הכנו לחנות הקומקומים מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם:\n/);
  assert.match(msg, /אפשר לענות "לא" ולא נכתוב שוב\.$/);
  const links = hrefs(card);
  assert.ok(links.includes(`https://wa.me/972509999999?text=${encodeURIComponent(msg)}`), 'WhatsApp with the message written in');
  assert.ok(links.includes(`mailto:hello@kettles.example.co.il?subject=${encodeURIComponent('מצגת לדוגמה לחנות הקומקומים')}&body=${encodeURIComponent(msg.replace(/\n/g, '\r\n'))}`), 'mail with its subject and body');
  assert.ok(links.includes('tel:035551234'));
  assert.ok(links.includes(KETTLES.social.instagram) && links.includes(KETTLES.social.tiktok), 'the profiles, to copy the message into');
  assert.match(card, /<a class="btn primary" href="https:\/\/wa\.me\//, 'WhatsApp is the one blue button');
  assert.equal((card.match(/btn primary/g) || []).length, 1);
  assert.match(card, /<select id="via-\d+" name="via"><option value="whatsapp">וואטסאפ<\/option><option value="email">מייל<\/option><option value="phone">טלפון<\/option><option value="instagram">אינסטגרם<\/option><option value="tiktok">טיקטוק<\/option><option value="other">דרך אחרת<\/option><\/select>/);

  // The plain store has no way to reach it: the page says so, and the message is still there to copy.
  assert.doesNotMatch(card, /רעיון לטיקטוק/, 'a demo with no topic (asked for on the website before topics were kept) has no idea');
  const plain = cardOf(await (await get('/leads?tab=ready', op)).text(), lead('plain.example.co.il').id);
  // Its demo has a topic: the message tells them the idea the card shows.
  const plainSlug = db.get('SELECT slug FROM demos WHERE id = ?', lead('plain.example.co.il').demo_id).slug;
  const told = TEDER_COLD_FIRST({ storeName: 'החנות הפשוטה', url: `${base}/s/${plainSlug}`, topic: 'הסיפור של התה' });
  assert.equal(unesc(/<textarea id="msg-\d+" rows="9" readonly dir="rtl">([\s\S]*?)<\/textarea>/.exec(plain)[1]), told);
  assert.match(told, /\nהכנו .+ מצגת אחת לדוגמה, על הסיפור של התה, כדי שתראו איך זה ייראה אצלכם:\n/);
  assert.match(plain, /לא מצאנו לחנות וואטסאפ, מייל, טלפון או פרופיל ברשתות/);
  assert.match(plain, /<button class="btn primary" type="submit">שלחתי<\/button>/, 'then "שלחתי" is its one blue button');
  assert.equal((plain.match(/btn primary/g) || []).length, 1);

  assert.equal((await post(`/leads/${k.id}/sent`, op, { via: 'nowhere' })).status, 400);
  const res = await post(`/leads/${k.id}/sent`, op, { via: 'whatsapp' });
  assert.equal(res.status, 200);
  const after = lead('kettles.example.co.il');
  assert.deepEqual([after.stage, after.sent_via], ['sent', 'whatsapp']);
  assert.ok(Date.now() - Date.parse(after.sent_at) < 60_000);
});

test('the one reminder: four days after, never on Shabbat (Toran\'s rule), once', async () => {
  // Toran's rule, ported: Israel time is UTC+2 in November 2026.
  assert.equal(new Date(reminderDue('2026-11-08T08:00:00.000Z')).toISOString(), '2026-11-12T08:00:00.000Z', 'Sunday 10:00 is Thursday 10:00');
  assert.equal(new Date(reminderDue('2026-11-09T12:00:00.000Z')).toISOString(), '2026-11-15T07:00:00.000Z', 'Monday 14:00 lands on Friday afternoon: Sunday 09:00');
  assert.equal(new Date(reminderDue('2026-11-10T18:00:00.000Z')).toISOString(), '2026-11-15T07:00:00.000Z', 'Tuesday 20:00 lands on Saturday night: Sunday 09:00');
  assert.equal(new Date(reminderDue('2026-11-09T09:00:00.000Z')).toISOString(), '2026-11-13T09:00:00.000Z', 'Friday 11:00 is before 13:00: it stands');
  assert.equal(new Date(reminderDue('2026-11-11T01:00:00.000Z')).toISOString(), '2026-11-15T07:00:00.000Z', 'Wednesday 03:00 lands on Sunday 03:00: it waits for 09:00');
  assert.equal(notOnShabbat(Date.parse('2026-11-12T10:00:00.000Z')), Date.parse('2026-11-12T10:00:00.000Z'), 'a Thursday noon is left as it is');
  assert.equal(reminderReady('2026-11-08T08:00:00.000Z', Date.parse('2026-11-12T07:59:00.000Z')), false, 'not before it is due');
  assert.equal(reminderReady('2026-11-08T08:00:00.000Z', Date.parse('2026-11-12T08:00:00.000Z')), true);
  assert.equal(reminderReady('2026-11-08T08:00:00.000Z', Date.parse('2026-11-14T10:00:00.000Z')), false, 'due since Thursday, and still not on Saturday');
  assert.equal(reminderReady('2026-11-08T08:00:00.000Z', Date.parse('2026-11-13T11:30:00.000Z')), false, 'nor on Friday from 13:00');
  assert.equal(reminderReady('2026-11-08T08:00:00.000Z', Date.parse('2026-11-15T07:00:00.000Z')), true, 'Sunday from 09:00');

  const k = lead('kettles.example.co.il');
  db.run('UPDATE leads SET sent_at = ? WHERE id = ?', '2026-11-09T12:00:00.000Z', k.id);
  const slug = db.get('SELECT slug FROM demos WHERE id = ?', k.demo_id).slug;
  try {
    setNow('2026-11-14T10:00:00.000Z'); // Saturday 12:00, the reminder due Sunday 09:00
    let card = cardOf(await (await get('/leads?tab=sent', op)).text(), k.id);
    assert.doesNotMatch(card, /<textarea id="rem-/);
    assert.match(card, /התזכורת האחת תהיה מוכנה ב־/);
    assert.match(card, /<button class="btn primary" type="submit">ענו<\/button>/, 'meanwhile the one step is to mark an answer');
    const early = await post(`/leads/${k.id}/reminded`, op, { via: 'whatsapp' });
    assert.equal(early.status, 400);
    assert.match((await early.json()).message, /עוד לא הזמן לתזכורת/);

    setNow('2026-11-15T07:30:00.000Z'); // Sunday 09:30
    card = cardOf(await (await get('/leads?tab=sent', op)).text(), k.id);
    const text = TEDER_REMINDER({ storeName: 'חנות הקומקומים', url: `${base}/s/${slug}` });
    assert.equal(unesc(/<textarea id="rem-\d+" rows="9" readonly dir="rtl">([\s\S]*?)<\/textarea>/.exec(card)[1]), text);
    assert.ok(hrefs(card).includes(`https://wa.me/972509999999?text=${encodeURIComponent(text)}`), 'the way the first one went comes first');
    assert.equal((await post(`/leads/${k.id}/reminded`, op, { via: 'whatsapp' })).status, 200);
    assert.ok(lead('kettles.example.co.il').reminder_sent_at);
    const twice = await post(`/leads/${k.id}/reminded`, op, { via: 'whatsapp' });
    assert.equal(twice.status, 400);
    assert.match((await twice.json()).message, /כבר נשלחה/);
    card = cardOf(await (await get('/leads?tab=sent', op)).text(), k.id);
    assert.match(card, /התזכורת נשלחה ב־/);
    assert.doesNotMatch(card, /<textarea id="rem-/, 'and no third message');
  } finally {
    setNow(null);
  }
});

test('"נשלח" moves to "פתחו" once the store opens its page after the message, not for an open before it', async () => {
  const p = lead('plain.example.co.il');
  const slug = db.get('SELECT slug FROM demos WHERE id = ?', p.demo_id).slug;
  // An open before the message (someone at the store found it some other way) does not count.
  db.insert('demo_opens', { demo_id: p.demo_id, visitor: 'v-before-the-message', at: '2026-11-01T10:00:00.000Z' });
  assert.equal((await post(`/leads/${p.id}/sent`, op, { via: 'other' })).status, 200);
  refreshStages(ctx);
  assert.equal(lead('plain.example.co.il').stage, 'sent');
  // The store opens its page, not signed in: one open, and the lead moves by itself.
  assert.equal((await get(`/s/${slug}`)).status, 200);
  const html = await (await get('/leads?tab=opened', op)).text();
  assert.equal(lead('plain.example.co.il').stage, 'opened');
  assert.match(cardOf(html, p.id), /העמוד נפתח פעם אחת מאז/);
  // Nobody opened the kettles store's page: it stays where it is.
  assert.equal(lead('kettles.example.co.il').stage, 'sent');
});

test('every card has "ענו", "הצטרפו" and "לא רלוונטי" and a note; "לא רלוונטי" can be undone; a store that became a customer joins', async () => {
  const s = lead('social.example.co.il');
  assert.equal((await post(`/leads/${s.id}/notes`, op, { notes: 'דיברתי עם הבעלים, לחזור אחרי החגים' })).status, 200);
  let card = cardOf(await (await get('/leads?tab=new', op)).text(), s.id);
  assert.match(card, /<p class="lead-note">דיברתי עם הבעלים, לחזור אחרי החגים<\/p>/);
  for (const act of ['replied', 'joined', 'irrelevant']) assert.match(card, new RegExp(`action="/leads/${s.id}/${act}"`));
  assert.equal((await post(`/leads/${s.id}/irrelevant`, op)).status, 200);
  assert.ok(lead('social.example.co.il').skipped_at);
  card = cardOf(await (await get('/leads?tab=irrelevant', op)).text(), s.id);
  assert.match(card, /סימנתם ב־.* שזה לא רלוונטי/);
  assert.equal((await post(`/leads/${s.id}/back`, op)).status, 200);
  assert.deepEqual([lead('social.example.co.il').stage, lead('social.example.co.il').skipped_at], ['new', null]);
  assert.equal((await post(`/leads/${s.id}/replied`, op)).status, 200);
  card = cardOf(await (await get('/leads?tab=replied', op)).text(), s.id);
  assert.match(card, /<button class="btn primary" type="submit">הצטרפו<\/button>/, 'after an answer, the one step is that they joined');

  // The kettles store opens a Teder account and its closing slide sends people to its site: it joined.
  const pack = ctx.packs[0];
  const was = pack.meta.promo;
  db.run('UPDATE accounts SET workspace_id = 9 WHERE id = ?', pack.id);
  pack.meta.promo = { name: 'חנות הקומקומים', promise: 'קומקומים וקנקנים לתה מכל העולם', target: { kind: 'site', url: 'https://www.kettles.example.co.il/' } };
  try {
    refreshStages(ctx);
    assert.equal(lead('kettles.example.co.il').stage, 'joined');
  } finally {
    pack.meta.promo = was;
    db.run('UPDATE accounts SET workspace_id = NULL WHERE id = ?', pack.id);
  }
});

test('the first message names the demo\'s topic when it has one, and is word for word as it was without one', () => {
  const url = 'https://teder.example/s/kettles-a1b2c3';
  const opening = 'היי, כאן OpenFrequency. בנינו את תדר, שמכין לחנויות אונליין מצגות בעברית לטיקטוק ולאינסטגרם. הוא קורא את האתר של החנות, וכותב ומעצב מצגות על נושאים מהתחום שלה. כל מצגת מחכה לאישור שלכם לפני שהיא עולה.';
  const ending = 'אם זה מעניין אתכם, אפשר לענות כאן ונספר עוד. אם לא, אפשר לענות "לא" ולא נכתוב שוב.';
  assert.equal(
    TEDER_COLD_FIRST({ storeName: 'חנות הקומקומים', url }),
    `${opening}\n\nהכנו לחנות הקומקומים מצגת אחת לדוגמה, כדי שתראו איך זה ייראה אצלכם:\n${url}\n\n${ending}`
  );
  assert.equal(
    TEDER_COLD_FIRST({ storeName: 'חנות הקומקומים', url, topic: 'הסיפור של התה' }),
    `${opening}\n\nהכנו לחנות הקומקומים מצגת אחת לדוגמה, על הסיפור של התה, כדי שתראו איך זה ייראה אצלכם:\n${url}\n\n${ending}`
  );
  assert.equal(TEDER_COLD_FIRST({ storeName: 'Kettles', url, topic: null }), TEDER_COLD_FIRST({ storeName: 'Kettles', url }), 'no topic: as it was');
  assert.match(TEDER_COLD_FIRST({ storeName: 'Kettles', url, topic: 'קפה טורקי' }), /הכנו ל־Kettles מצגת אחת לדוגמה, על קפה טורקי, כדי/);
  for (const m of [TEDER_COLD_FIRST({ storeName: 'x', url }), TEDER_COLD_FIRST({ storeName: 'x', url, topic: 'קפה טורקי' })]) assert.doesNotMatch(m, /[—–!]/, 'no dashes, no exclamation marks');

  // The topic as the build kept it on the demo: its niche, in Hebrew; none when there is none.
  assert.equal(topicOf(JSON.stringify({ niche: ' הסיפור  של התה. ', angle: 'how tea was discovered', articles: [] })), 'הסיפור של התה');
  assert.equal(topicOf({ niche: 'קפה טורקי' }), 'קפה טורקי');
  for (const none of [null, undefined, '', '{', '{}', JSON.stringify({ niche: '' }), JSON.stringify({ niche: 7 }), JSON.stringify({ niche: 'א'.repeat(81) })]) assert.equal(topicOf(none), null, String(none));
});

test('the migration that adds about forgets the cursor, so the leads already kept get theirs on the next sync, and keeps the rest', () => {
  const file = path.join(home.home, 'leads-before-about.db');
  const raw = new DatabaseSync(file);
  for (let v = 0; v < MIGRATIONS.length - 1; v++) raw.exec(MIGRATIONS[v]);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  raw.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run('leads:cursor', JSON.stringify('2026-11-05T09:41:00.000001Z'), '2026-11-05T10:00:00.000Z');
  raw.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run('leads:sync', JSON.stringify({ ok: true }), '2026-11-05T10:00:00.000Z');
  raw.prepare("INSERT INTO leads (domain, url, name, stage, notes, created_at, updated_at) VALUES ('kept.example.co.il', 'https://kept.example.co.il', 'נשמרה', 'sent', 'הערה', ?, ?)").run('2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z');
  raw.close();
  const migrated = new Db(file);
  opened.push(migrated);
  assert.equal(migrated.get("SELECT value_json FROM settings WHERE key = 'leads:cursor'"), null, 'the next sync reads from the start');
  assert.ok(migrated.get("SELECT value_json FROM settings WHERE key = 'leads:sync'"), 'the last sync is still said');
  const kept = migrated.get("SELECT * FROM leads WHERE domain = 'kept.example.co.il'");
  assert.deepEqual([kept.name, kept.stage, kept.notes, kept.about], ['נשמרה', 'sent', 'הערה', null]);
});

test('le: "ל" joined to a Hebrew name, "ל־" before any other, "בשביל" before one that opens with ה (never "להחנות")', () => {
  assert.equal(le('כלי חרס של נורית'), 'לכלי חרס של נורית');
  assert.equal(le('Nike'), 'ל־Nike');
  assert.equal(le('החנות של דנה'), 'בשביל החנות של דנה');
  assert.equal(le('הום סטייל'), 'בשביל הום סטייל');
  assert.doesNotMatch(TEDER_COLD_FIRST({ storeName: 'החנות של דנה', url: 'https://x.test/s/a' }), /להחנות/);
  assert.match(TEDER_REMINDER({ storeName: 'החנות של דנה', url: 'https://x.test/s/a' }), /שהכנו בשביל החנות של דנה\?/);
});
