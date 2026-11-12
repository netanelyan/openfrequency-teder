import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { ROOT } from '../src/core/paths.js';
import { running } from '../src/web/demos.js';
import { reminderDue, reminderReady } from '../src/leads/messages.js';
import { checkDraft } from '../src/demos/write.js';
import { INTERNAL_TOKEN, listenFree, opened, tempHome } from './helpers.js';

// Toran's lead page and Teder, about the same store (src/web/leads-internal.js, test/fixtures/teder-leads.json, the
// same file in Toran): what Teder has of it, its demo built from Toran's store (through the stand-in builder, ctx.demoIo:
// no model is called), and the lead marked sent when one message carried both demos. Every answer has the contract's
// shape; every refusal is in the operator's words; the doors are this machine's, with the token.

const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'teder-leads.json'), 'utf8'));
const route = (p) => CONTRACT.routes.find((r) => r.path === p);
const STORE = route('/internal/leads/demo').request.body.store;

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
  cta: { title: 'ומה מרתיחים אצלכם', body: 'כלים לתה מחכים לכם באתר', facts: [], image: 'kettle on a kitchen counter' },
  caption: 'לפי המסורת, התה התחיל בטעות. מה אתם שותים בבוקר?',
};
const product = (id, title, src) => ({ id, title, handle: `p${id}`, published_at: '2026-10-01', images: [{ src }, { src: `${src}?2` }], variants: [{ price: '149.00', available: true }], options: [] });

let home;
let ctx;
let db;
let server;
let base;
let PHOTO;
let gate = null;

const io = {
  read: async (url) => {
    if (gate) await gate.promise;
    const domain = new URL(url).hostname;
    return { origin: `https://${domain}`, domain, name: 'כלי חרס של נורית', currency: 'ILS', accent: '#0A7D4F', products: [product(11, 'ספל חרס', 'https://cdn.example.test/mug.jpg'), product(12, 'קערת חרס', 'https://cdn.example.test/bowl.jpg')], collections: ['ספלים'] };
  },
  topic: async () => ({ niche: 'הסיפור של התה', angle: 'how tea was discovered', articles: [{ lang: 'he', title: 'תה' }] }),
  wiki: async () => [{ url: 'https://he.wikipedia.org/wiki/%D7%AA%D7%94', title: 'תה', text: `התה הוא משקה. ${QUOTE}` }],
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
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'i'.repeat(40), OF_INTERNAL_TOKEN: INTERNAL_TOKEN, PUBLIC_HOST: 'teder.openfrequency.co.il' } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  setNow(null);
  gate?.open();
  await Promise.all([...running.values()]);
  server?.close();
  home?.cleanup();
});

const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const state = (q, headers = auth) => fetch(`${base}/internal/leads/state?${new URLSearchParams(q)}`, { headers });
const post = (p, body, headers = auth) => fetch(`${base}${p}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const settle = () => Promise.all([...running.values()]);

/** Every key the contract's example has is in the answer, with the same kind of value (or null where it may be). */
function sameShape(got, want, nullable = [], where = 'body') {
  for (const [k, v] of Object.entries(want)) {
    assert.ok(k in got, `${where}.${k} is in the answer`);
    if (got[k] === null && (nullable.includes(k) || v === null)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) sameShape(got[k], v, nullable, `${where}.${k}`);
    else if (v !== null) assert.equal(typeof got[k], typeof v, `${where}.${k} is a ${typeof v}`);
  }
}

test('the doors: this machine with the token only, each route its own method, a request that is not one refused', async () => {
  const common = Object.fromEntries(CONTRACT.common.map((c) => [c.status, c.body]));
  const none = await state({ toran: '12', domain: STORE.domain }, {});
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), common[401]);
  const wrong = await state({ toran: '12' }, { authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
  const proxied = await state({ toran: '12' }, { ...auth, 'x-forwarded-for': '203.0.113.9' });
  assert.equal(proxied.status, 403);
  assert.deepEqual(await proxied.json(), common[403]);
  assert.equal((await post('/internal/leads/state', {})).status, 405);
  const getMark = await fetch(`${base}/internal/leads/mark`, { headers: auth });
  assert.equal(getMark.status, 405);
  assert.deepEqual(await getMark.json(), common[405]);
  for (const bad of [{ toran: 'a b' }, {}]) {
    const r = await state(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.deepEqual(await r.json(), common[400]);
  }
  assert.equal((await post('/internal/leads/demo', 'not json')).status, 400);
  assert.equal((await post('/internal/leads/demo', { store: { id: 12 } })).status, 400, 'a store with no domain');
  assert.equal((await post('/internal/leads/mark', { toran: '12', stage: 'later' })).status, 400);
});

test("a store Teder does not have yet: lead null; Toran's build adds it and builds its demo, through the stand-in builder", async () => {
  const before = await (await state({ toran: String(STORE.id), domain: STORE.domain })).json();
  assert.deepEqual(before, route('/internal/leads/state').answers[1].body);
  let release;
  gate = { promise: new Promise((r) => (release = r)), open: () => release() };
  const res = await post('/internal/leads/demo', route('/internal/leads/demo').request.body);
  assert.equal(res.status, 200);
  const b = await res.json();
  const want = route('/internal/leads/demo').answers[0];
  sameShape(b, want.body, ['sentAt', 'reminderSentAt', 'whatsapp', 'pageUrl', 'error']);
  assert.equal(b.ok, true);
  assert.equal(b.message, want.body.message);
  assert.equal(b.lead.demo.building, true);
  const lead = db.get('SELECT * FROM leads WHERE domain = ?', STORE.domain);
  assert.deepEqual([lead.toran_id, lead.whatsapp], [String(STORE.id), '972500000123'], 'added the way the hourly sync adds it');
  const demo = db.get('SELECT * FROM demos WHERE id = ?', lead.demo_id);
  assert.deepEqual([demo.origin, demo.whatsapp], ['outreach', null], 'nobody asked: no number on the demo');
  // A second press while it is built builds nothing more.
  const again = await (await post('/internal/leads/demo', route('/internal/leads/demo').request.body)).json();
  assert.equal(again.ok, false);
  assert.match(again.error, /נבנה עכשיו/);
  gate.open();
  gate = null;
  await settle();
  // A demo that passed every check is its page at once (src/demos/build.js): built, it is approved.
  const built = await (await state({ toran: String(STORE.id) })).json();
  assert.equal(built.lead.demo.status, 'approved');
  assert.equal(built.lead.demo.building, false);
  // The operator opens it on accounts' /admin/teder: Teder's own site shows the product only (accounts' docs/admin-split.md).
  assert.equal(built.lead.demo.reviewUrl, `https://accounts.openfrequency.co.il/admin/teder/demos/${lead.demo_id}`);
});

test('approved: the state says demo_ready with its page; marking first sends it to "sent", once; the reminder only when it is due', async () => {
  const lead = db.get('SELECT * FROM leads WHERE domain = ?', STORE.domain);
  const ready = await (await state({ toran: String(STORE.id), domain: STORE.domain })).json();
  sameShape(ready, route('/internal/leads/state').answers[0].body, route('/internal/leads/state').answers[0].nullable);
  assert.equal(ready.lead.stage, 'demo_ready');
  assert.match(ready.lead.demo.pageUrl, /^https:\/\/teder\.openfrequency\.co\.il\/s\/[\w-]+$/);
  assert.equal(ready.lead.leadUrl, `https://accounts.openfrequency.co.il/admin/teder/leads?tab=ready#lead-${lead.id}`);
  // Found by the domain alone too (www. left out).
  assert.equal((await (await state({ domain: `www.${STORE.domain}` })).json()).lead.id, lead.id);
  // The whole list, for the shared lead dashboard on accounts' /admin: the same lead, with Toran's id and its domain;
  // only GET, and only with the token.
  const listed = await fetch(`${base}/internal/leads/list`, { headers: auth });
  assert.equal(listed.status, 200);
  const list = await listed.json();
  const want = route('/internal/leads/list').answers[0];
  sameShape(list.leads[0], want.body.leads[0], want.nullable);
  const mine = list.leads.find((x) => x.id === lead.id);
  assert.deepEqual([mine.toranId, mine.domain, mine.stage], [String(STORE.id), STORE.domain, 'demo_ready']);
  assert.equal((await fetch(`${base}/internal/leads/list`)).status, 401);
  assert.equal((await post('/internal/leads/list', {})).status, 405);

  const early = await (await post('/internal/leads/mark', { toran: String(STORE.id), stage: 'reminder', by: 'Demo' })).json();
  assert.equal(early.ok, false, 'no reminder before the first message');
  const marked = await (await post('/internal/leads/mark', route('/internal/leads/mark').request.body)).json();
  sameShape(marked, route('/internal/leads/mark').answers[0].body, ['reminderSentAt', 'whatsapp', 'pageUrl', 'error']);
  assert.equal(marked.ok, true);
  assert.equal(marked.lead.stage, 'sent');
  const after = db.get('SELECT * FROM leads WHERE id = ?', lead.id);
  assert.deepEqual([after.stage, after.sent_via], ['sent', 'whatsapp']);
  assert.ok(db.get("SELECT 1 FROM audit WHERE action = 'lead_sent' AND detail_json LIKE '%\"by\":\"toran\"%'"), 'the audit says it came from Toran');
  const twice = await (await post('/internal/leads/mark', route('/internal/leads/mark').request.body)).json();
  assert.deepEqual(twice, route('/internal/leads/mark').answers[1].body, 'a second first message is refused in the contract\'s words');
  const notYet = await (await post('/internal/leads/mark', { toran: String(STORE.id), stage: 'reminder' })).json();
  assert.match(notYet.error, /עוד לא הזמן/);
  // Four days later (never on Shabbat) the reminder is due, and marked once.
  let t = reminderDue(after.sent_at);
  while (!reminderReady(after.sent_at, t)) t += 3_600_000;
  setNow(t);
  assert.equal((await (await state({ toran: String(STORE.id) })).json()).lead.reminderDue, true);
  assert.equal((await (await post('/internal/leads/mark', { toran: String(STORE.id), stage: 'reminder' })).json()).ok, true);
  assert.equal((await (await post('/internal/leads/mark', { toran: String(STORE.id), stage: 'reminder' })).json()).ok, false);
  setNow(null);
});

test('a store that asked not to be written to is not built, and an unknown lead is not marked', async () => {
  const gone = await (await post('/internal/leads/demo', { store: { ...STORE, id: 99, domain: 'asked-not.example.co.il', url: 'https://asked-not.example.co.il/', optedOut: true } })).json();
  assert.equal(gone.ok, false);
  assert.match(gone.error, /ביקשה שלא נכתוב/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM demos WHERE domain = 'asked-not.example.co.il'").n, 0);
  const none = await (await post('/internal/leads/mark', { toran: '555', domain: 'nobody.example.co.il', stage: 'first' })).json();
  assert.equal(none.ok, false);
});

test('the shared lead dashboard moves the lead and works its demo, with the same rules as /leads and /demos/<id>', async () => {
  const lead = db.get('SELECT * FROM leads WHERE domain = ?', STORE.domain);
  const at = { toran: String(STORE.id), domain: STORE.domain, by: 'Demo' };
  // The demo's topic is the idea /leads shows on the card.
  assert.equal((await (await state({ toran: String(STORE.id) })).json()).lead.demo.topic, 'הסיפור של התה');

  const stage = route('/internal/leads/stage');
  const nullable = ['reminderSentAt', 'whatsapp', 'pageUrl', 'error', 'topic'];
  const replied = await (await post('/internal/leads/stage', { ...at, stage: 'replied' })).json();
  sameShape(replied, stage.answers[0].body, nullable);
  assert.deepEqual([replied.ok, replied.message, replied.lead.stage], [true, stage.answers[0].body.message, 'replied']);
  assert.deepEqual(await (await post('/internal/leads/stage', { ...at, stage: 'replied' })).json(), stage.answers[1].body, 'there already: refused in the contract\'s words');
  assert.equal((await (await post('/internal/leads/stage', { ...at, stage: 'irrelevant' })).json()).lead.stage, 'irrelevant');
  assert.ok(db.get('SELECT skipped_at FROM leads WHERE id = ?', lead.id).skipped_at, '"לא רלוונטי" keeps when, as on /leads');
  const back = await (await post('/internal/leads/stage', { ...at, stage: 'back' })).json();
  assert.equal(back.lead.stage, 'sent', 'back to where it was: sent, and nobody opened it since');
  assert.equal(db.get('SELECT skipped_at FROM leads WHERE id = ?', lead.id).skipped_at, null);
  assert.match((await (await post('/internal/leads/stage', { ...at, stage: 'back' })).json()).error, /כבר ברשימה/);
  for (const bad of [{ ...at, stage: 'later' }, { stage: 'replied' }]) assert.equal((await post('/internal/leads/stage', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await (await post('/internal/leads/stage', { toran: '555', domain: 'nobody.example.co.il', stage: 'replied' })).json()).ok, false);

  const act = route('/internal/leads/demo-act');
  assert.match((await (await post('/internal/leads/demo-act', { ...at, act: 'approve' })).json()).error, /רק דמו שמוכן לבדיקה/, 'approved by itself: nothing to approve');
  let release;
  gate = { promise: new Promise((r) => (release = r)), open: () => release() };
  const other = await (await post('/internal/leads/demo-act', { ...at, act: 'other' })).json();
  sameShape(other, act.answers[0].body, nullable);
  assert.deepEqual([other.ok, other.message], [true, act.answers[0].body.message]);
  assert.deepEqual(await (await post('/internal/leads/demo-act', { ...at, act: 'redo' })).json(), act.answers[1].body, 'one build at a time');
  gate.open();
  gate = null;
  await settle();
  const rebuilt = await (await state({ toran: String(STORE.id) })).json();
  assert.equal(rebuilt.lead.demo.status, 'approved', 'written again, it approved itself again');
  assert.ok(db.get("SELECT 1 FROM audit WHERE action = 'demo_other'"), 'the audit says who asked');

  const removed = await (await post('/internal/leads/demo-act', { ...at, act: 'remove' })).json();
  assert.equal(removed.ok, true);
  assert.deepEqual([removed.lead.demo.status, removed.lead.demo.pageUrl, removed.lead.demo.topic], ['removed', null, null], 'taken down: its page no longer opens');
  assert.equal(db.get('SELECT status FROM demos WHERE id = ?', lead.demo_id).status, 'removed');
  assert.match((await (await post('/internal/leads/demo-act', { ...at, act: 'redo' })).json()).error, /הורד/, 'a demo taken down is not written again: a new one is built');
  assert.equal((await post('/internal/leads/demo-act', { ...at, act: 'publish' })).status, 400);
  assert.equal((await (await post('/internal/leads/demo-act', { toran: '555', domain: 'nobody.example.co.il', act: 'redo' })).json()).ok, false);
});
