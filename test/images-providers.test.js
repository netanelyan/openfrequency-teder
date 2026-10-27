import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempHome } from './helpers.js';
import { Db } from '../src/db/index.js';
import { assertAllowed } from '../src/core/net.js';
import { DEFAULT_PROVIDERS, MIN_SIDE, PROVIDERS, findImage, imageCredit, openverseCandidate, openverseLicense, openverseUsable, packMatches, providerOrder } from '../src/images/index.js';
import { screenImage, screenRequest } from '../src/images/safety.js';
import { getBrowser, closeBrowser } from '../src/render/render.js';
import { validatePack } from '../src/packs/validate.js';

// More licensed photographs for every slide: the owner's own first, then the stock libraries, then Openverse (CC BY,
// CC BY-SA and CC0 from Flickr and others, each with its author). No test here touches the network: Openverse's
// answers are in the shape recorded from api.openverse.org on 2026-10-27, with fictional creators and ids.

const realFetch = globalThis.fetch;
const { cleanup } = tempHome();
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.OPENVERSE_TOKEN;
  await closeBrowser();
  cleanup();
});

/** An Openverse result as the API answers it. */
const result = (over = {}) => ({
  id: '0b6f1a52-0000-4000-8000-000000000001',
  title: 'Dana Example - City FC v Harbour United',
  indexed_on: '2024-03-11T22:17:06.247016Z',
  foreign_landing_url: 'https://www.flickr.com/photos/00000000@N00/50000000001',
  url: 'https://live.staticflickr.com/65535/50000000001_0a1b2c3d4e_b.jpg',
  creator: 'sam.lens',
  creator_url: 'https://www.flickr.com/photos/00000000@N00',
  license: 'by',
  license_version: '2.0',
  license_url: 'https://creativecommons.org/licenses/by/2.0/',
  provider: 'flickr',
  source: 'flickr',
  category: 'photograph',
  filesize: null,
  filetype: 'jpg',
  tags: [{ name: 'football', accuracy: null, unstable__provider: 'flickr' }, { name: 'text', accuracy: 0.91, unstable__provider: 'clarifai' }],
  attribution: '"Dana Example" by sam.lens is licensed under CC BY 2.0.',
  fields_matched: ['title'],
  mature: false,
  height: 683,
  width: 1024,
  thumbnail: 'https://api.openverse.org/v1/images/0b6f1a52-0000-4000-8000-000000000001/thumb/',
  ...over,
});

test('an Openverse result becomes a candidate with its licence, its author and where it came from, and only CC BY, BY-SA and CC0 are kept', () => {
  const c = openverseCandidate(result());
  assert.equal(c.provider, 'openverse');
  assert.equal(c.license, 'CC BY 2.0');
  assert.equal(c.author, 'sam.lens');
  assert.equal(c.authorUrl, 'https://www.flickr.com/photos/00000000@N00');
  assert.equal(c.sourceUrl, 'https://www.flickr.com/photos/00000000@N00/50000000001');
  assert.equal(c.upstream, 'flickr');
  assert.deepEqual(c.original, [1024, 683]);
  assert.equal(c.alt, 'Dana Example - City FC v Harbour United football', "the photographer's tags, not the machine's guess");
  assert.equal(openverseUsable(c, MIN_SIDE.cover), true);

  assert.equal(openverseLicense(result({ license: 'by-sa', license_version: '4.0' })), 'CC BY-SA 4.0');
  assert.equal(openverseLicense(result({ license: 'cc0', license_version: '1.0' })), 'CC0 1.0');
  for (const license of ['by-nc', 'by-nd', 'by-nc-sa', 'by-nc-nd', 'pdm', 'sampling+', 'nc-sampling+', '']) {
    assert.equal(openverseLicense(result({ license })), null, license);
    assert.equal(openverseUsable(openverseCandidate(result({ license }))), false, `never ${license || 'no licence'}`);
  }
  // CC BY asks for the author; CC0 does not.
  assert.equal(openverseUsable(openverseCandidate(result({ creator: '' }))), false, 'CC BY with no one to credit');
  assert.equal(openverseUsable(openverseCandidate(result({ creator: null, license: 'by-sa' }))), false, 'CC BY-SA with no one to credit');
  assert.equal(openverseUsable(openverseCandidate(result({ creator: '', license: 'cc0' }))), true, 'CC0 needs no credit');
});

test("an Openverse photograph must be big enough for where it goes, a photograph, not mature, and no agency's", () => {
  const small = openverseCandidate(result({ width: 500, height: 332 }));
  assert.equal(openverseUsable(small, MIN_SIDE.cover), false, 'too small for a cover');
  assert.equal(openverseUsable(openverseCandidate(result({ width: 728, height: 500 })), MIN_SIDE.framed), true, 'big enough for a framed slide');
  assert.equal(openverseUsable(openverseCandidate(result({ width: null, height: null }))), false, 'no size given');
  assert.equal(openverseUsable(openverseCandidate(result({ mature: true }))), false);
  assert.equal(openverseUsable(openverseCandidate(result({ category: 'illustration' }))), false, 'a drawing is not the person');
  assert.equal(openverseUsable(openverseCandidate(result({ category: null }))), true, 'most of Flickr is not classified');
  assert.equal(openverseUsable(openverseCandidate(result({ filetype: 'gif', url: 'https://live.staticflickr.com/x.gif' }))), false);
  // A press agency's picture re-uploaded under a CC licence is still the agency's.
  assert.equal(openverseUsable(openverseCandidate(result({ tags: [{ name: 'fbl', accuracy: null }, { name: 'topix', accuracy: null }] }))), false);
  assert.equal(openverseUsable(openverseCandidate(result({ title: 'Dana Example (AFP)' }))), false);
  assert.equal(openverseUsable(openverseCandidate(result({ creator: 'Reuters' }))), false);
  // A Commons original found through Openverse is downloaded as Commons' own 1280-pixel copy.
  const big = 'https://upload.wikimedia.org/wikipedia/commons/2/27/Dana_Example_City_FC_2025-178.jpg';
  assert.equal(openverseCandidate(result({ url: big, width: 3333, height: 5000, source: 'wikimedia' })).url, 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Dana_Example_City_FC_2025-178.jpg/1280px-Dana_Example_City_FC_2025-178.jpg');
  assert.equal(openverseCandidate(result({ url: big, width: 1000, height: 1400 })).url, big);
  // A slug for a title reads as words, so the name check finds the person in it.
  assert.equal(openverseCandidate(result({ title: 'soccer-dana-example-city-fc' })).title, 'soccer dana example city fc');
});

test('the Openverse search asks for photographs under CC BY, BY-SA or CC0 only, with the token when there is one, and anonymously when it expired', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const auth = new Headers(init.headers).get('authorization');
    seen.push({ url: new URL(url), auth });
    if (auth === 'Bearer expired') return new Response(JSON.stringify({ detail: 'Authentication credentials were not provided.' }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ result_count: 3, page_count: 1, page_size: 20, page: 1, results: [result(), result({ id: 'nc', license: 'by-nc' }), result({ id: 'small', width: 400, height: 300 })] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete process.env.OPENVERSE_TOKEN;
    const found = await PROVIDERS.openverse.search('Dana Example', { minSide: MIN_SIDE.cover });
    assert.deepEqual(found.map((c) => c.providerId), ['0b6f1a52-0000-4000-8000-000000000001']);
    const u = seen[0].url;
    assert.equal(u.hostname, 'api.openverse.org');
    assert.equal(u.pathname, '/v1/images/');
    assert.equal(u.searchParams.get('q'), 'Dana Example');
    assert.equal(u.searchParams.get('license'), 'by,by-sa,cc0');
    assert.equal(u.searchParams.get('category'), null, "asking for photographs drops every picture Openverse has not classified");
    assert.equal(seen[0].auth, null);
    process.env.OPENVERSE_TOKEN = 'good';
    await PROVIDERS.openverse.search('Dana Example');
    assert.equal(seen.at(-1).auth, 'Bearer good');
    process.env.OPENVERSE_TOKEN = 'expired';
    seen.length = 0;
    assert.equal((await PROVIDERS.openverse.search('Dana Example')).length, 1);
    assert.deepEqual(seen.map((s) => s.auth), ['Bearer expired', null], 'an expired token falls back to the anonymous allowance');
  } finally {
    delete process.env.OPENVERSE_TOKEN;
    globalThis.fetch = realFetch;
  }
});

test('the door reads Openverse and the photo hosts it points at, and never writes to them', () => {
  for (const u of [
    'https://api.openverse.org/v1/images/?q=Dana%20Example&license=by,by-sa,cc0',
    'https://api.openverse.org/v1/images/0b6f1a52-0000-4000-8000-000000000001/thumb/',
    'https://live.staticflickr.com/65535/50000000001_0a1b2c3d4e_b.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.jpg',
  ]) assert.doesNotThrow(() => assertAllowed('GET', u), u);
  // Trading a client id for a token is a write: it is done by hand, never by the engine.
  assert.throws(() => assertAllowed('POST', 'https://api.openverse.org/v1/auth_tokens/token/'), /refused/);
  assert.throws(() => assertAllowed('POST', 'https://api.openverse.org/v1/images/0b6f1a52-0000-4000-8000-000000000001/report/'), /refused/);
  assert.throws(() => assertAllowed('GET', 'http://live.staticflickr.com/65535/x.jpg'), /https only/);
});

/** A pack folder with the owner's photographs, and a real JPEG for each. */
async function packWithPhotos(photos, jpeg) {
  const dir = path.join(process.env.OF_HOME, `pack-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, 'photos'), { recursive: true });
  for (const p of photos) writeFileSync(path.join(dir, 'photos', p.file), jpeg);
  writeFileSync(path.join(dir, 'photos', 'photos.json'), JSON.stringify({ photos }));
  return dir;
}

async function jpegOf(color) {
  const tab = await (await getBrowser()).newPage();
  const b64 = await tab.evaluate((c) => {
    const cv = document.createElement('canvas');
    cv.width = 794;
    cv.height = 715;
    const g = cv.getContext('2d');
    g.fillStyle = c;
    g.fillRect(0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, color);
  await tab.close();
  return Buffer.from(b64, 'base64');
}

const OWNER = [
  { file: 'dana-1.jpg', subject: 'Dana Example', description: 'walking out at the Harbour Arena, March 2026', tags: ['football', 'City FC'], credit: 'The owner', origin: 'the club media day' },
  { file: 'arena.jpg', subject: 'Harbour Arena', description: 'the stands before kick-off', tags: 'stadium football' },
];

test("the owner's photographs are searched first whenever the pack has any, matched on their subject, description and tags", async () => {
  const jpeg = await jpegOf('#2f6f3a');
  const dir = await packWithPhotos(OWNER, jpeg);
  const pack = { id: 'acct', dir, meta: { imagery: { providers: ['pexels', 'commons'] } }, rules: {}, theme: {} };
  assert.deepEqual(providerOrder(pack), ['pack', 'pexels', 'commons'], "first, though imagery.providers leaves it out");
  assert.deepEqual(providerOrder({ ...pack, meta: { imagery: { providers: ['commons', 'pack', 'openverse'] } } }), ['pack', 'commons', 'openverse']);
  assert.deepEqual(providerOrder({ ...pack, meta: {} }), DEFAULT_PROVIDERS);
  assert.deepEqual(providerOrder({ id: 'x', dir: path.join(dir, 'none'), meta: { imagery: { providers: ['pack', 'commons'] } } }), ['commons'], 'no photographs, no search for them');
  assert.deepEqual(providerOrder({ id: 'x', meta: {} }), DEFAULT_PROVIDERS.filter((p) => p !== 'pack'));

  assert.deepEqual(packMatches(pack, 'Dana Example City FC').map((p) => p.file), ['dana-1.jpg']);
  assert.deepEqual(packMatches(pack, 'Harbour Arena football').map((p) => p.file), ['arena.jpg', 'dana-1.jpg'], 'the subject first, then the description and tags');
  assert.deepEqual(packMatches(pack, 'stadium football night').map((p) => p.file), ['arena.jpg'], 'tags count');
  assert.deepEqual(packMatches(pack, 'the photo of the day'), [], 'words that say nothing match nothing');

  // A spy library after the owner's: never asked when the owner's photograph fits and passes.
  const asked = [];
  PROVIDERS.spy = { id: 'spy', ready: () => true, search: async (q) => (asked.push(q), []) };
  const users = [];
  const llm = {
    kind: 'claude',
    json: async (req) => {
      users.push(req.user);
      return { data: { consistent: true, mainSubject: 'a footballer', blood: false, injury: false, unconscious: false, watermark: false, logoOrBelt: false, weapon: false, faceX: 50, faceY: 30, sure: true, note: 'fine' }, estimated: true };
    },
  };
  const db = new Db(':memory:');
  const ctx = { db, mode: 'live', log: () => {}, llm };
  try {
    const spyPack = { ...pack, meta: { imagery: { providers: ['spy'] } } };
    const img = await findImage(ctx, { pack: spyPack, query: 'Dana Example City FC', claim: 'Dana Example signed for City FC for 4 million', minSide: MIN_SIDE.framed });
    assert.equal(img.provider, 'pack');
    assert.equal(img.provider_id, 'dana-1.jpg');
    assert.deepEqual(asked, [], 'the stock library was never asked');
    assert.match(users[0], /content slide/, 'a framed photograph is checked as a content slide');
    assert.match(users[0], /The account's owner added this photograph and describes it as: "Dana Example: walking out at the Harbour Arena, March 2026"/);
    const why = {};
    assert.equal(await findImage(ctx, { pack: spyPack, query: 'Riverside Park sunrise', claim: 'x', why }), null);
    assert.deepEqual(asked, ['Riverside Park sunrise'], 'a query no photograph of the owner fits goes on to the libraries');
    assert.equal(why['pack: no results'], 1);
  } finally {
    delete PROVIDERS.spy;
  }
});

test('a content slide is checked for its subject, a cover for its whole claim, and the safety questions never ease', async () => {
  const content = screenRequest({ claim: 'The price of milk is capped by law', query: 'milk supermarket shelf', meta: 'Dairy aisle', role: 'content' });
  assert.match(content, /^The picture is for a content slide \(its photograph shows what the slide is about, not the claim itself\) that says: "The price of milk is capped by law"/);
  const cover = screenRequest({ claim: 'The price of milk is capped by law', query: 'milk', meta: 'x', role: 'cover' });
  assert.match(cover, /^The picture is for a slide that says/);
  assert.doesNotMatch(cover, /content slide|owner/);
  assert.equal(screenRequest({}), 'The photograph:');

  // The model still decides blood, weapons, watermarks and logos on a content slide and on the owner's own photograph.
  const buf = await jpegOf('#3a6d3a');
  const pack = { meta: { imagery: {} }, rules: {} };
  const saw = (over) => ({ kind: 'claude', json: async () => ({ data: { consistent: true, mainSubject: 'shelves', blood: false, injury: false, unconscious: false, watermark: false, logoOrBelt: false, weapon: false, faceX: 50, faceY: 30, sure: true, note: 'n', ...over }, estimated: true }) });
  const screen = (over) => screenImage({ db: new Db(':memory:'), log: () => {}, llm: saw(over) }, { pack, buf, type: 'image/jpeg', meta: 'Dairy aisle', query: 'milk', claim: 'The price of milk is capped', role: 'content', owner: 'our own shop' });
  assert.equal((await screen({})).safety, 'ok');
  for (const k of ['blood', 'weapon', 'watermark', 'logoOrBelt']) assert.equal((await screen({ [k]: true })).safety, 'refused', k);
  assert.equal((await screen({ consistent: false })).mismatch, true, 'the wrong subject is still refused');
});

test('an Openverse photograph is stored with its licence and author, credited to where Openverse found it', async () => {
  const jpeg = await jpegOf('#2f4f6f');
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.openverse.org') return new Response(JSON.stringify({ results: [result({ id: 'ov-1', title: 'Dana Example - City FC v Harbour United' })] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'live.staticflickr.com') return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response('no', { status: 404 });
  };
  const llm = { kind: 'claude', json: async () => ({ data: { consistent: true, mainSubject: 'a footballer', blood: false, injury: false, unconscious: false, watermark: false, logoOrBelt: false, weapon: false, faceX: 50, faceY: 30, sure: true, note: 'fine' }, estimated: true }) };
  const db = new Db(':memory:');
  try {
    const pack = { id: 'acct', meta: { imagery: { providers: ['openverse'] } }, rules: {}, theme: {} };
    const img = await findImage({ db, mode: 'live', log: () => {}, llm }, { pack, query: 'Dana Example', claim: 'Dana Example scored twice', minSide: MIN_SIDE.cover });
    assert.equal(img.provider, 'openverse');
    assert.equal(img.provider_id, 'ov-1');
    assert.equal(img.license, 'CC BY 2.0');
    assert.equal(img.license_url, 'https://creativecommons.org/licenses/by/2.0/');
    assert.equal(img.author, 'sam.lens');
    assert.equal(img.source_url, 'https://www.flickr.com/photos/00000000@N00/50000000001');
    assert.equal(JSON.parse(img.match_json).upstream, 'flickr');
    assert.equal(JSON.parse(img.match_json).role, 'cover');
    assert.equal(imageCredit(db, { slides: [{ image_id: img.id }] }), 'צילום: sam.lens · CC BY 2.0 · Flickr via Openverse');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a pack may name Openverse among its libraries', async () => {
  const { readPack } = await import('../src/packs/load.js');
  const { DEMO } = await import('./helpers.js');
  const pack = readPack(DEMO);
  const ok = (providers) => validatePack({ ...pack, meta: { ...pack.meta, imagery: { ...(pack.meta.imagery || {}), providers } } }).filter((p) => /imagery\.providers/.test(p));
  assert.deepEqual(ok(['pack', 'pexels', 'unsplash', 'commons', 'openverse']), []);
  assert.equal(ok(['google']).length, 1);
});
