import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, candidateDocs, coverClaim, detailsDepth, hashtagsFor, landingPage, namedGaps, pageRank, refusedOutlines, textLedGaps, TEXT_LED_MAX } from '../src/pipeline/build.js';
import { fillersFirst, fillsSlide, findImage, headWord, MAX_SCREENS, namesIn, namesThing, openverseFileUrl, PROVIDERS, whoIn } from '../src/images/index.js';
import { charsetOf, getText, notText } from '../src/core/net.js';
import { unreadable } from '../src/sources/text.js';
import { unreadablePage } from '../src/onboarding/discover.js';
import { nicheTags } from '../src/onboarding/pack.js';
import { research, researchSources, researchWiki, WIKI_KEY } from '../src/sources/research.js';
import { TEMPLATES } from '../src/formats/hooks.js';
import { TEASER } from '../src/voice/tells.js';
import { outlinePrompt } from '../src/pipeline/prompts.js';
import { israelDate } from '../src/schedule/israel.js';
import { closeBrowser, getBrowser } from '../src/render/render.js';
import { copyPack, opened, tempHome } from './helpers.js';

// The three problems a five-niche sample run found (2026-11-06, samples-2026-11-06/SUMMARY.md), and the small ones
// beside them, each with the case that showed it: a post blocked late for a photograph of a historical figure or a
// place, a cover that asked a dog for its face, a slide screened 28 times; an outline offered landing pages while dated
// articles waited, every format asking about the same six; one refused detail dropping a verified plan, a facts post on
// the model's page that could never pass, research that never ran for a new customer. Offline: the demo pack, fake
// libraries, fake pages, a fake model.

const realFetch = globalThis.fetch;
const realPexels = PROVIDERS.pexels;
afterEach(() => {
  globalThis.fetch = realFetch;
  PROVIDERS.pexels = realPexels;
});
after(() => closeBrowser());

function contextFor(home, mode = 'recorded') {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, mode, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

const at = () => new Date().toISOString();

/* ------------------------------------------------------------------ 1. photographs */

test('a place or a name with "of the" in it is matched as it is written, and a place names no one', () => {
  for (const q of ["Wadi Murabba'at", 'Shrine of the Book', 'Mount Hermon', 'Dead Sea Scrolls', 'Royal Albert Hall']) assert.deepEqual(whoIn(q), [], q);
  assert.deepEqual(whoIn('Bar Kokhba letter'), ['Bar', 'Kokhba']);
  assert.deepEqual(whoIn('Leonardo da Vinci'), ['Leonardo', 'Vinci'], 'one name, its "da" left out');
  assert.deepEqual(whoIn('Lionel Messi at Camp Nou stadium'), ['Lionel', 'Messi'], 'as before');
  // "Shrine Book" met none of 75 files named "Shrine_of_the_Book", and "Murabba'at" none filed as "Murabbaat".
  assert.ok(namesIn('File:Shrine_of_the_Book_2.jpg', ['Shrine', 'Book']));
  assert.ok(namesIn('File:Wadi_Murabbaat_caves.jpg', ['Wadi', "Murabba'at"]));
  assert.ok(namesIn('File:Leonardo_da_Vinci_-_presumed_self-portrait.jpg', ['Leonardo', 'Vinci']));
  assert.ok(!namesIn('File:Holly_with_very_unevenly_distributed_berries,_Holm_Hill.jpg', ['Holly', 'Holm']), 'two words apart are still not the name');
});

test("a facts cover asks a person for a face and anything else for itself", () => {
  const dog = coverClaim('golden retriever', '5 דברים שלא ידעתם על כלבים');
  assert.doesNotMatch(dog, /face|in person/i, 'a dog is not asked for its face');
  assert.match(dog, /golden retriever, large and clear as the main subject/);
  const star = coverClaim('Lionel Messi', '7 דברים על מסי');
  assert.match(star, /in person, the face clearly visible/);
  assert.match(star, /before photography, a painting, a bust or a coin/, 'a figure of antiquity has a likeness, not a photograph');
});

test('a named slide with no photograph of its name stands text first, any number of them; the cover and a reveal never', () => {
  const facts = { kind: 'facts' };
  const gap = (slide, extra = {}) => ({ slide, why: 'name', names: ['Satori Kato'], ...extra });
  // Two at most until the owner's word of 2026-11-06 on textures: "if a slideshow ... fails because of them, we can use
  // generated background".
  assert.equal(TEXT_LED_MAX, Infinity);
  // One private name (the coffee sample's Satori Kato), and two: the post goes out, those slides on its scene.
  assert.deepEqual(textLedGaps([gap(7)], { format: facts, slides: 8 }).led.map((g) => g.slide), [7]);
  assert.deepEqual(textLedGaps([gap(2), gap(4)], { format: facts, slides: 8 }).left, []);
  // Three (the Judaica sample's Antiochus, Josephus and Rabbi Oshaya, had their busts and coins been refused too).
  const three = textLedGaps([gap(2), gap(4), gap(6)], { format: facts, slides: 8 });
  assert.equal(three.led.length, 3);
  assert.equal(three.left.length, 0);
  assert.equal(textLedGaps([gap(0)], { format: { kind: 'story' }, slides: 8 }).left.length, 1, "the cover's face");
  assert.equal(textLedGaps([gap(7)], { format: { kind: 'guess-who' }, slides: 8 }).left.length, 1, "a guess-who's answer");
  assert.equal(textLedGaps([{ slide: 3, why: 'none' }], { format: facts, slides: 8 }).left.length, 1, 'a slide on no photograph at all');
  // Before anything is drawn: a slide is covered by any slide's photograph of the same person.
  const photos = new Map([[2, { query: 'Flavius Josephus', provider_id: 'File:Josephus.jpg' }], ['bg', { query: 'desert at dawn' }]]);
  const named = new Map([[2, ['Flavius Josephus']], [5, ['Flavius Josephus Rome']], [6, ['Rabbi Oshaya']]]);
  assert.deepEqual(namedGaps({ photos, named }), [{ slide: 6, why: 'name', names: ['Rabbi Oshaya'] }]);
});

let jpeg = null;
async function photoFile(home, name = 'photo.jpg') {
  if (!jpeg) {
    const tab = await (await getBrowser()).newPage();
    const b64 = await tab.evaluate(() => {
      const cv = document.createElement('canvas');
      cv.width = 1080;
      cv.height = 1600;
      const g = cv.getContext('2d');
      g.fillStyle = '#4a6b8a';
      g.fillRect(0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    await tab.close();
    jpeg = Buffer.from(b64, 'base64');
  }
  const file = path.join(home, name);
  writeFileSync(file, jpeg);
  return file;
}

test("one slide's photograph is screened at most MAX_SCREENS times, a picture refused for what it shows is not screened again, and the screen takes a sage's bust", { timeout: 120_000 }, async () => {
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    copyPack(home, 'demo', (f) => (f.pack.imagery = { providers: ['pexels'] }));
    const ctx = contextFor(home);
    ctx.imagesLive = true;
    const pack = ctx.pack('demo');
    const file = await photoFile(home);
    // Twenty candidates for every search, each a picture of the right name.
    PROVIDERS.pexels = { id: 'pexels', ready: () => true, search: async (q) => Array.from({ length: 20 }, (_, i) => ({ provider: 'pexels', providerId: `${q}-${i}`, title: `${q} ${i}`, file, url: null, width: 1080, height: 1600, license: 'Pexels License', author: 'A', alt: q })) };
    const screens = [];
    // The model refuses every one as not fitting the slide; the second search's pictures as showing a watermark.
    ctx.llm = {
      kind: 'claude',
      async json(req) {
        screens.push({ system: req.system, user: req.user });
        const watermark = /Rabbi Oshaya/.test(req.user);
        return { data: { consistent: false, mainSubject: 'a coin', blood: false, injury: false, unconscious: false, watermark, logoOrBelt: false, weapon: false, faceX: 50, faceY: 30, sure: true, note: 'x' }, usage: null, model: req.model, estimated: true };
      },
    };
    const why = {};
    const img = await findImage(ctx, { pack, query: 'Flavius Josephus', claim: 'Josephus wrote the history of the war', why });
    assert.equal(img, null);
    assert.equal(screens.length, MAX_SCREENS, 'one slide, eight screens, not twenty');
    assert.equal(why['the screens for this slide are used up'], 1);
    assert.match(screens[0].system, /A person who lived before photography .* a painting, a drawing, an engraving, a bust, a statue or a coin/, 'a bust or a coin is a likeness of a sage');
    assert.match(screens[0].system, /With no person, the centre of the main subject/, 'the crop follows the subject, not only a face');
    // A memo for the post: what one slide's screen refused for a watermark is not screened again for the next.
    const memo = { taken: new Set(), refused: new Set() };
    screens.length = 0;
    await findImage({ ...ctx, photoMemo: memo }, { pack, query: 'Rabbi Oshaya', claim: 'x', budget: { screens: 3 } });
    assert.equal(screens.length, 3);
    assert.equal(memo.refused.size, 3, 'refused for what they show');
    screens.length = 0;
    const again = {};
    await findImage({ ...ctx, photoMemo: memo }, { pack, query: 'Rabbi Oshaya', claim: 'another slide', why: again, budget: { screens: 3 } });
    assert.equal(again['refused earlier in this post'], 3, 'those three are skipped, not screened again');
  } finally {
    cleanup();
  }
});

test('a search for a thing takes only a picture whose own words name the thing, before any screen', () => {
  assert.deepEqual(['vintage french press', 'camping gear on grass', 'campfire at night', 'ancient silver coins', 'shabbat candles on table'].map(headWord), ['press', 'gear', 'campfire', 'coin', 'candle']);
  // What Commons answered for "vintage french press" on 2026-11-06, each screened and refused.
  for (const t of ['File:Erskine Caldwell reading a book - 6 January 1964.jpg', 'File:Vintage postcard - bathers.jpg']) assert.equal(namesThing(t, 'press'), false, t);
  assert.equal(namesThing('File:Bodum French Press.jpg Coffee brewing in a Bodum French Press', 'press'), true);
  assert.equal(namesThing('Ancient Greek Silver Coins', 'coin'), true, 'a plural names the thing');
});

test('a photograph that fills a 9:16 slide is tried before one that would be drawn as a band', () => {
  const band = { provider: 'openverse', providerId: 'b', width: 1024, height: 588 };
  const fill = { provider: 'commons', providerId: 'f', width: 1920, height: 2560 };
  const wide = { provider: 'commons', providerId: 'w', width: 3840, height: 2560 };
  assert.equal(fillsSlide(band), false, "the coffee sample's French press");
  assert.equal(fillsSlide({ provider: 'commons', width: 1498, height: 766 }), false, "the Judaica sample's cover of coins");
  assert.equal(fillsSlide(fill), true);
  assert.equal(fillsSlide(wide), true, 'a large landscape fills, cut around its subject');
  assert.deepEqual(fillersFirst([band, fill, wide]).map((c) => c.providerId), ['f', 'w', 'b']);
  // Openverse's copy of a Commons file is 1920 wide now: 1280 left every 3:2 photograph 853 pixels high.
  assert.match(openverseFileUrl('https://upload.wikimedia.org/wikipedia/commons/a/ab/Coin.jpg', 4000), /\/1920px-Coin\.jpg$/);
  assert.equal(openverseFileUrl('https://upload.wikimedia.org/wikipedia/commons/a/ab/Coin.jpg', 1600), 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Coin.jpg');
});

/* ------------------------------------------------------------------ 2. the documents the outline is offered */

/** A web source of the demo account with these documents, read today. */
function webSource(ctx, key, docs) {
  const src = ctx.db.insert('sources', { account_id: 'demo', key, type: 'web', url: `https://${key}.example.org/`, name: key, why: 'a test source of the niche', status: 'approved', origin: 'pack', approved_at: at(), created_at: at() });
  const ids = docs.map(([url, text, published_at = null]) => ctx.db.insert('documents', { source_id: src, url, title: key, text, sha256: `${key}:${url}`, published_at, fetched_at: at(), recorded: 0 }));
  ctx.db.update('sources', src, { last_ok_at: at(), last_docs_json: { day: israelDate(Date.now()), ids } });
  return { src, ids };
}
const liveRead = (ctx) => ({ ...ctx, sources: { kind: 'live', read: async () => [] } });

test('dated articles first, undated pages after them, landing pages after those, one document a page, and no text that is not text', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const long = (s) => `${s} `.repeat(60);
    // The pets sample's documents, as they were read: undated service, event and video pages and one approved twice,
    // a dated article, and a page read in the wrong encoding.
    webSource(ctx, 'vet', [
      ['https://vet.example.edu/hospital/specialty-services/nutrition', long('Our nutrition service.')],
      ['https://www.amc.example.org/event/pet-food-basics-choosing-the-right-diet/', long('Join us for an event.')],
      ['https://www.wsava.example.org/updates/understanding-what-vets-know-about-pet-nutrition/', long('An undated article.')],
      ['https://www.makor.example.co.il/nrg/online/55/ART2/049/703.html', '���� '.repeat(200)],
      ['https://mag.example.org/', long('Headlines.')],
    ]);
    webSource(ctx, 'vet-again', [['https://vet.example.edu/hospital/specialty-services/nutrition/', long('Our nutrition service, again.')]]);
    const feed = ctx.db.insert('sources', { account_id: 'demo', key: 'feed', type: 'rss', url: 'https://dogs.example.com/feed', name: 'feed', why: 'a test feed of the niche', status: 'approved', origin: 'pack', approved_at: at(), created_at: at() });
    const art = ctx.db.insert('documents', { source_id: feed, url: 'https://dogs.example.com/nutrition/dog-treats-how-many-are-too-many/', title: 'treats', text: long('Dog treats.'), sha256: 'feed:1', published_at: '2026-11-04T17:56:02Z', fetched_at: at(), recorded: 0 });
    ctx.db.update('sources', feed, { last_ok_at: at(), last_docs_json: { day: israelDate(Date.now()), ids: [art] } });
    const docs = (await candidateDocs(liveRead(ctx), pack)).filter((d) => ['vet', 'vet-again', 'feed'].includes(d.sourceKey));
    const urls = docs.map((d) => d.url);
    assert.deepEqual(urls.slice(0, 2), ['https://dogs.example.com/nutrition/dog-treats-how-many-are-too-many/', 'https://www.wsava.example.org/updates/understanding-what-vets-know-about-pet-nutrition/'], 'the dated article first, then the undated one');
    assert.deepEqual(urls.slice(2, 4).sort(), ['https://vet.example.edu/hospital/specialty-services/nutrition', 'https://www.amc.example.org/event/pet-food-basics-choosing-the-right-diet/'], 'the service and the event pages after them, the service page once');
    assert.deepEqual(urls.slice(4), ['https://mag.example.org/'], 'the home page last, and the garbled page never');
    assert.deepEqual(['https://x.example/about-us', 'https://x.example/events/open-day', 'https://x.example/subjects/camping/index.htm'].map(landingPage), [true, true, true]);
    assert.deepEqual(['https://x.example/news/tracks/872431', 'https://x.example/2026/10/how-a-small-shop-grew/'].map(landingPage), [false, false]);
    assert.equal(pageRank({ url: 'https://wiki.example/x', sourceType: 'api' }), 0, 'a data source is no web page');
  } finally {
    cleanup();
  }
});

test('a post blocked only for its photographs leaves its documents to the other formats, and its own format moves on', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const { src, ids } = webSource(ctx, 'caves', [['https://teva.example.org.il/news/tracks/872431', 'The caves of the Judean desert. '.repeat(40), '2026-11-01T08:00:00Z']]);
    const post = (id, kind) => {
      ctx.db.insert('posts', { id, account_id: 'demo', format_id: 'quick-facts', kind: 'facts', grp: 'number', status: 'blocked', sample: 1, created_at: at(), updated_at: at() });
      ctx.db.insert('facts', { post_id: id, key: 'f1', claim: 'c', quote: 'q', document_id: ids[0], source_id: src, verified: 1 });
      ctx.db.insert('steps', { post_id: id, step: 'blocked', status: 'failed', detail_json: { kind, reason: 'r', format: 'quick-facts', documents: ids }, at: at() });
    };
    post('p-photo', 'no_photo');
    const left = (await candidateDocs(liveRead(ctx), pack)).filter((d) => d.source_id === src);
    assert.equal(left.length, 1, 'the document is still offered');
    assert.ok(refusedOutlines(ctx.db, 'demo').has(`quick-facts|${ids[0]}`), 'but not to the format whose photographs failed');
    post('p-voice', 'voice');
    assert.equal((await candidateDocs(liveRead(ctx), pack)).filter((d) => d.source_id === src).length, 0, 'a post blocked for anything else still uses its documents up');
  } finally {
    cleanup();
  }
});

test('each format of a post asks about documents the formats before it did not', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const asked = [];
    // Every outline refused (the pets sample's thin pages); no model facts to fall back on.
    ctx.llm = {
      kind: 'fake',
      async json(req) {
        if (req.task === 'outline') asked.push({ format: req.meta.format, doc: req.meta.docKey });
        return { data: { usable: false, why: 'a landing page', topic: '', subject: { a: '', b: '', answer: '', date: '' }, facts: [], items: [], imageQuery: '', research: [] }, usage: null, model: req.model, estimated: true };
      },
    };
    const res = await buildPost(ctx, { pack, sample: true, maxDocs: 2 });
    assert.equal(res.status, 'blocked');
    const byFormat = [];
    for (const a of asked) (byFormat.find((x) => x.format === a.format) || byFormat[byFormat.push({ format: a.format, docs: [] }) - 1]).docs.push(a.doc);
    assert.ok(byFormat.length >= 2, JSON.stringify(byFormat));
    const all = new Set(asked.map((a) => a.doc));
    // While some document is still unasked, the next format starts with it, never with the first format's.
    assert.ok(all.size > 2, `${all.size} documents asked about in all`);
    assert.ok(!byFormat[0].docs.includes(byFormat[1].docs[0]) || all.size <= 2, `the second format began with ${byFormat[1].docs[0]}, which the first had: ${JSON.stringify(byFormat.slice(0, 2))}`);
  } finally {
    cleanup();
  }
});

test('a page that is not text is never stored, never offered, and a PDF or a page in windows-1255 is read for what it is', async () => {
  assert.equal(unreadable('%PDF-1.5\n%âã\n1 0 obj'), 'a PDF file read as text');
  assert.match(unreadable('����� - ��� nrg '.repeat(30)), /encoding/);
  assert.equal(unreadable('A normal article about coffee, with a stray � in it. '.repeat(10)), null);
  assert.equal(charsetOf('text/html', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1255">'), 'windows-1255');
  assert.equal(charsetOf('text/html; charset=UTF-8', '<meta charset="windows-1255">'), 'utf-8', 'the header first');
  assert.equal(charsetOf('', '<meta charset="no-such-thing">'), 'utf-8');
  assert.equal(notText('application/pdf'), 'application/pdf');
  assert.equal(notText('application/octet-stream', new TextEncoder().encode('%PDF-1.5')), 'application/pdf', 'by its bytes');
  assert.equal(notText('application/octet-stream', new TextEncoder().encode('a,b\n1,2')), null, 'a CSV served as bytes is text');
  // A windows-1255 page that says so only in its <meta>: שלום is F9 EC E5 ED.
  const page = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1255"></head><body><p>'), Buffer.from([0xf9, 0xec, 0xe5, 0xed]), Buffer.from('</p></body></html>')]);
  globalThis.fetch = async (url) => (String(url).endsWith('.pdf') ? new Response(Buffer.from('%PDF-1.5\n...'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }) : new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }));
  const read = await getText('https://www.example.co.il/old/article.html');
  assert.match(read.body, /<p>שלום<\/p>/);
  await assert.rejects(getText('https://www.example.gov.il/files/guide.pdf'), (e) => e.code === 'type' && /not a text page/.test(e.message));
});

test('discovery offers no page that is not text, too thin, or turned away on a second read', async () => {
  const article = `<html><body><article><p>${'A real article about natural skincare and what is in a cream. '.repeat(12)}</p></article></body></html>`;
  const ok = async () => ({ body: article });
  const page = (body) => ({ body, finalUrl: 'https://www.example.com/a' });
  assert.equal(await unreadablePage({ type: 'web' }, page(article), { read: ok }), null);
  assert.match(await unreadablePage({ type: 'web' }, page('<html><body><div id="app">Loading…</div></body></html>'), { read: ok }), /characters of text, too few/, 'a page its script draws');
  assert.equal(await unreadablePage({ type: 'web', hints: { follow: { pattern: 'x', max: 6 } } }, page('<html><body><a href="/x">x</a> headlines</body></html>'), { read: ok }), null, "a deeper search's page of links follows its articles");
  const refused = async () => {
    throw Object.assign(new Error('HTTP 403'), { status: 403 });
  };
  assert.match(await unreadablePage({ type: 'web' }, page(article), { read: refused }), /refused a second read \(HTTP 403\)/, 'Britannica, aaha.org');
  const timeout = async () => {
    throw new Error('timed out');
  };
  assert.equal(await unreadablePage({ type: 'web' }, page(article), { read: timeout }), null, 'a slow second read is no refusal');
});

/* ------------------------------------------------------------------ 3. the details rule and research */

test("a refused detail drops only itself, the outline's spare facts count, and a page of the model's facts asks only what it has", () => {
  const facts = (outlineVerified, details) => [...Array.from({ length: outlineVerified }, (_, i) => ({ key: `f${i}`, verified: true })), ...details.map((v, i) => ({ key: `X${i}`, verified: v, detail: 'number' }))];
  const items = (n) => Array.from({ length: n }, () => ({ role: 'fact' }));
  // Skincare: 7 facts for 6 slides, 2 of 4 details verified (one refused for its attribution, one for a 90 it lacked).
  const skin = detailsDepth({ need: 3, verified: 2 }, { facts: facts(7, [true, true, false, false]), items: items(6) });
  assert.deepEqual(skin, { short: false, spare: 1, bar: 3 });
  assert.equal(detailsDepth({ need: 3, verified: 2 }, { facts: facts(6, [true, true]), items: items(6) }).short, true, 'one a slide and two details: still short');
  // Pets: the model's page held 8 facts, the outline took 6, the details call found the 2 left.
  const page = [{ text: Array.from({ length: 8 }, (_, i) => `Fact number ${i} about dogs and food.`).join('\n') }];
  const pets = detailsDepth({ need: 3, verified: 2 }, { facts: facts(6, [true, true]), items: items(6) }, { modelPage: page, outline: { facts: Array(6).fill({}) } });
  assert.deepEqual(pets, { short: false, spare: 0, bar: 2 });
});

test("research reads the account's own Wikipedia when none of its sources is one: made once, approved, removable, read for the outline's terms only", async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    assert.deepEqual(researchSources(ctx.db, pack).wiki, {}, 'the demo has no Wikipedia, as no account the setup makes has');
    const hosts = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      hosts.push(u.hostname);
      if (u.searchParams.get('list') === 'search') return Response.json({ query: { search: [{ title: 'פדיון הבן' }] } });
      if (u.pathname.includes('/rest_v1/page/html/')) return new Response('<html><head><title>x</title></head><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return Response.json({ query: { pages: [{ title: 'פדיון הבן', extract: `פדיון הבן הוא מצווה שבה האב פודה את בנו הבכור מן הכהן בחמישה סלעים.\n${'הטקס נערך ביום השלושים ואחד ללידה, והכהן שואל את האב אם הוא רוצה בבנו. '.repeat(6)}` }] } });
    };
    const docs = await research({ ...ctx, mode: 'live' }, { pack, terms: ['פדיון הבן'], names: ['פדיון'] });
    assert.equal(docs.length, 1);
    const src = ctx.db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', 'demo', WIKI_KEY);
    assert.equal(src.status, 'approved');
    assert.deepEqual(JSON.parse(src.config_json).api.langs, ['he', 'en']);
    assert.equal(ctx.db.get('SELECT source_id FROM documents WHERE id = ?', docs[0].id).source_id, src.id, 'stored under it, so the slide names ויקיפדיה');
    assert.ok(hosts.includes('he.wikipedia.org'), 'a Hebrew term in the Hebrew Wikipedia');
    // It reads nothing on its own: the day's read leaves it out.
    const read = [];
    await candidateDocs({ ...ctx, sources: { kind: 'live', read: async (s) => (read.push(s.key), []) } }, pack);
    assert.ok(!read.includes(WIKI_KEY));
    // Removed on the Sources page, it is never made again, and research reads nothing.
    ctx.db.update('sources', src.id, { status: 'removed' });
    assert.equal(researchWiki(ctx.db, pack), null);
    assert.deepEqual(await research({ ...ctx, mode: 'live' }, { pack, terms: ['פדיון הבן'], names: [] }), []);
    assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM sources WHERE key = ?', WIKI_KEY).n, 1);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ the smaller ones */

test("the outline keeps to the account's own subject, and a list about no person opens on its subject", () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const text = outlinePrompt(ctx.pack('demo')).system.map((b) => b.text).join('\n');
    assert.match(text, /On the account's own subject\. The post is about the account's niche/);
    assert.match(text, /the birds on a camping trail/);
    assert.match(text, /a list that is about no person .* opens on its most striking subject instead, by name/);
  } finally {
    cleanup();
  }
});

test('no cover template is made of words the voice check calls a teaser', () => {
  const teasers = TEASER.map((t) => t.p);
  for (const t of TEMPLATES) assert.ok(!teasers.some((p) => t.text.includes(p)), `${t.id}: ${t.text}`);
  assert.ok(!TEMPLATES.some((t) => t.id === 'nobody-tells'));
});

test("a new account's hashtags are its niche and topics, and a post adds its own keywords", () => {
  const camping = nicheTags({ niche: 'ציוד קמפינג וטיולים', topics: ['לינת שטח', 'טיולים בישראל', 'ציוד ובטיחות בשטח'] });
  assert.ok(camping.includes('#ציודקמפינג'));
  assert.ok(camping.includes('#טיולים'), '"וטיולים" without its "and"');
  assert.ok(!camping.some((t) => /^#ו/.test(t)), camping.join(' '));
  assert.ok(camping.includes('#לינתשטח'));
  assert.ok(nicheTags({ niche: 'יודאיקה ומתנות', topics: [] }).includes('#מתנות'));
  const pack = { formats: { hashtags: { broad: ['#טיפים', '#ישראל'], niche: nicheTags({ niche: 'יודאיקה ומתנות', topics: ['חגי ישראל'] }) } } };
  const tags = hashtagsFor(pack, { hashtags: [] }, 's', 'חמישה סלעים לכהן ביום השלושים ואחד', ['פדיון הבן', 'מטבעות', 'Pidyon haben']);
  assert.deepEqual(tags.slice(2), ['#פדיוןהבן', '#מטבעות'], 'the Judaica sample went out with "#טיפים #ישראל" alone');
});

test("a feed's title becomes a source's name as text, not as its entities", async () => {
  const { declaredFeeds } = await import('../src/sources/rss.js');
  const page = '<link rel="alternate" type="application/rss+xml" title="My Jewish Learning &raquo; Feed" href="/feed"><link rel="alternate" type="application/rss+xml" title="Sprudge Coffee &amp;raquo; Feed" href="/coffee/feed">';
  assert.deepEqual(declaredFeeds(page, 'https://www.example.com/').map((f) => f.title), ['My Jewish Learning', 'Sprudge Coffee']);
});
