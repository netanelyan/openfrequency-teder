import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, loadPack } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { createPack } from '../src/onboarding/pack.js';
import { SCENES, cleanScene, fallbackScenes, scenesFor, seedOfPack, writeScenes } from '../src/images/scenes.js';
import { ALWAYS_BLOCK, imageCredit, shows, waitingImages, whoIn } from '../src/images/index.js';
import { gapReason, namedOn, photoGaps } from '../src/pipeline/build.js';
import { closeBrowser, planPhotos } from '../src/render/render.js';
import { lockedStyle } from '../src/render/style.js';
import { getSetting } from '../src/core/store.js';
import { copyPack, opened, tempHome } from './helpers.js';

// No slide goes out empty (the owner, 2026-10-31, on a customer's sample slideshows that were plain dark slides with
// white text: "the slides dont have images. no slide can be empty"), and a name is never written without a photograph
// of whom it names ("also names cant be written without an image that connects them visually. i did not understand who
// מאנה is first"). Here: the scenes a new account is given and an older one gets, who a slide names, and what a post
// may not go out with. test/no-bare-slides.test.js builds whole posts.

after(() => closeBrowser());

function contextFor(home, llm = null, file = 'data.db') {
  const db = new Db(path.join(home, file));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  if (llm) ctx.llm = llm;
  return ctx;
}

const SOURCE = { id: 'c1', type: 'api', url: 'https://query.wikidata.org/sparql', name: 'Wikidata', why: 'Structured, sourced facts under CC0.', approved: true, api: { kind: 'wikidata-sparql', query: 'SELECT 1' } };

/** A model that writes the scenes it is given (and a voice too short to keep), and remembers every request. */
function fakeModel(scenes) {
  const asked = [];
  return {
    asked,
    llm: {
      kind: 'claude',
      json: async (req) => {
        asked.push(req);
        if (req.task === 'scenes') return { data: { scenes }, estimated: true };
        if (req.task === 'voice') return { data: { voice: '' }, estimated: true };
        throw new Error(`unexpected call: ${req.task}`);
      },
    },
  };
}

const clean = (list) => {
  assert.ok(list.length >= SCENES.min && list.length <= SCENES.max, `${SCENES.min} to ${SCENES.max} scenes: ${list.join(', ')}`);
  for (const q of list) {
    assert.equal(q, q.toLowerCase(), `"${q}" is lowercase: no one's name`);
    assert.doesNotMatch(q, /\b(?:people|player|fans?|crowd|man|woman|face)\b/, `"${q}" has no one in it`);
    for (const w of [...ALWAYS_BLOCK, 'brand']) assert.ok(!q.split(/\s+/).includes(w), `"${q}" has no "${w}"`);
  }
};

test('a scene is a place or a thing: no one in it, no name, nothing the screen refuses', () => {
  assert.equal(cleanScene('Football stadium at night'), 'football stadium at night', 'a capital that opens the line is only a capital');
  for (const bad of ['football fans cheering', 'Camp Nou stadium', 'Lionel Messi', 'club logo wall', 'jersey on a hanger', 'nike brand store', 'כדור על דשא', 'a b c d e f', '']) assert.equal(cleanScene(bad), null, bad);
  assert.equal(cleanScene('house plants', ['plants']), null, "the pack's own imageQueryBlock counts");
  // With no model: the niche's own, in Hebrew or English, then its English words, then anything quiet.
  const football = fallbackScenes({ niche: 'כדורגל אירופי', topics: ['ליגת האלופות'] });
  clean(football);
  assert.ok(football.includes('football pitch grass'), football.join(', '));
  const unknown = fallbackScenes({ niche: 'קליגרפיה', nicheEn: 'calligraphy' });
  clean(unknown);
  assert.deepEqual(unknown.slice(0, 2), ['calligraphy', 'calligraphy close up']);
  clean(fallbackScenes({}));
});

test('who a slide names: a person or a club, never a competition, a place or a scene', () => {
  assert.deepEqual(whoIn('Sadio Mané'), ['Sadio', 'Mané']);
  assert.deepEqual(whoIn('Fenerbahce'), ['Fenerbahce']);
  assert.deepEqual(whoIn('Real Madrid'), ['Real', 'Madrid']);
  assert.deepEqual(whoIn('Lionel Messi at Camp Nou stadium'), ['Lionel', 'Messi'], "the place's name is not his");
  for (const q of ['Champions League trophy', 'Wembley Stadium', 'football stadium at night', 'UFC 300', 'Football pitch grass', 'World Cup final 2026', '']) assert.deepEqual(whoIn(q), [], q);
  assert.deepEqual(whoIn('Revivo goal Spain 1998'), ['Revivo', 'Spain']);
  // A photograph shows them when its own search, title or description names them, or its search had their surname.
  assert.ok(shows({ query: 'Sadio Mane', provider_id: 'File:IMG_1.jpg' }, 'Sadio Mane Liverpool'));
  assert.ok(shows({ query: 'Mane Liverpool 2019', provider_id: 'File:IMG_1.jpg' }, 'Sadio Mane'));
  assert.ok(shows({ query: 'football pitch', provider_id: 'File:Sadio_Mané_2018.jpg' }, 'Sadio Mané'));
  assert.ok(shows({ query: 'Haim Revivo', provider_id: 'File:IMG_2.jpg' }, 'Revivo goal Spain 1998'), "the post's subject by name, for a cover's search");
  assert.ok(!shows({ query: 'Lionel Scaloni', provider_id: 'File:IMG_3.jpg' }, 'Lionel Messi'), 'a first name is not enough');
  assert.ok(!shows({ query: 'football stadium at night', provider_id: 'File:Stadium.jpg', alt: 'a stadium' }, 'Sadio Mane'), 'a scene does not show him');
  assert.ok(shows({ query: 'football stadium at night' }, 'football pitch grass'), 'a query that names no one takes any photograph');
});

test("a new account's theme has scenes, written by the model in one small call", async () => {
  const { home, cleanup } = tempHome();
  try {
    const model = fakeModel(['Football stadium at night', 'football fans cheering', 'Camp Nou stadium', 'club logo on a wall', 'football pitch grass', 'goal net close up', 'corner flag on grass']);
    const ctx = contextFor(home, model.llm);
    const made = await createPack(ctx, { seed: { niche: 'כדורגל', nicheEn: 'football', audience: 'אוהדים', topics: ['ליגת האלופות'] }, candidates: [SOURCE], displayName: 'שער בדוגמה', handle: 'goal.sample' });
    const theme = JSON.parse(readFileSync(path.join(made.dir, 'theme.json'), 'utf8'));
    assert.deepEqual(theme.backgroundQueries, ['football stadium at night', 'football pitch grass', 'goal net close up', 'corner flag on grass'], "the model's, less the crowd, the named place and the logo");
    assert.equal(theme.options.backgroundPhoto, true, 'a slide with no photograph of its own stands on one of them');
    const call = model.asked.find((r) => r.task === 'scenes');
    assert.ok(call, 'one call for the scenes');
    assert.equal(model.asked.filter((r) => r.task === 'scenes').length, 1);
    assert.equal(call.role, 'judge');
    assert.equal(call.effort, 'low');
    assert.equal(call.tag, 'onboarding');
    assert.deepEqual(call.schema.required, ['scenes']);
    assert.match(call.user, /כדורגל \(football\)/);
    assert.match(call.system, /never a person/);
    // The pack loads and validates with the others (backgroundPhoto needs backgroundQueries).
    assert.equal(loadAll({ dir: path.join(home, 'packs') }).length, 2);
  } finally {
    cleanup();
  }
});

test("without a model a new account's scenes come from its niche, and a short list from the model is filled", async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    assert.notEqual(ctx.llm.kind, 'claude', 'offline: no model to ask');
    const made = await createPack(ctx, { seed: { niche: 'כדורגל', audience: 'אוהדים', topics: [] }, candidates: [SOURCE], displayName: 'כדורגל בדוגמה', handle: 'football.offline' });
    const theme = made.pack.theme;
    clean(theme.backgroundQueries);
    assert.ok(theme.backgroundQueries.includes('football stadium at night'), theme.backgroundQueries.join(', '));
    assert.equal(theme.options.backgroundPhoto, true);
    // Two usable from the model: two more from the niche, so there are always four.
    const short = await writeScenes({ ...ctx, llm: fakeModel(['empty stadium seats', 'football fans', 'goal net close up']).llm }, { niche: 'כדורגל' });
    assert.equal(short.by, 'model+fallback');
    clean(short.scenes);
    assert.deepEqual(short.scenes.slice(0, 2), ['empty stadium seats', 'goal net close up']);
    // A model that fails leaves the niche's.
    const broken = { kind: 'claude', json: async () => { throw new Error('overloaded'); } };
    const failed = await writeScenes({ ...ctx, llm: broken }, { niche: 'כדורגל' });
    assert.equal(failed.by, 'fallback');
    clean(failed.scenes);
  } finally {
    cleanup();
  }
});

test('an account the setup made before scenes gets them once, kept in the database, its theme.json and its look untouched', async () => {
  const { home, cleanup } = tempHome();
  try {
    const dir = copyPack(home, 'demo', (f) => {
      delete f.theme.backgroundQueries;
      f.theme.options = { radius: 24, coverPhoto: false };
      f.pack.style = { name: 'E' };
      f.pack.topics = ['כדורגל', 'ליגת האלופות'];
      f.formats.trends = { queries: { he: ['טיפים כדורגל'], en: ['football tips'] }, minViews: { he: 1000, en: 20000 } };
    });
    const before = readFileSync(path.join(dir, 'theme.json'), 'utf8');
    const model = fakeModel(['football stadium at night', 'football pitch grass', 'empty stadium seats', 'goal net close up', 'corner flag on grass']);
    const ctx = contextFor(home, model.llm);
    const pack = ctx.pack('demo');
    assert.deepEqual(seedOfPack(pack), { niche: 'כדורגל', nicheEn: 'football', audience: pack.meta.audience, topics: ['ליגת האלופות'], displayName: pack.meta.displayName });
    const look = lockedStyle(ctx.db, pack, ctx.packs);
    const first = await scenesFor(ctx, pack);
    assert.deepEqual(first, ['football stadium at night', 'football pitch grass', 'empty stadium seats', 'goal net close up', 'corner flag on grass']);
    assert.deepEqual(getSetting(ctx.db, 'scenes:demo').scenes, first, 'kept for the next post');
    assert.deepEqual(await scenesFor(ctx, pack), first);
    assert.equal(model.asked.filter((r) => r.task === 'scenes').length, 1, 'written once');
    assert.equal(readFileSync(path.join(dir, 'theme.json'), 'utf8'), before, "theme.json is the owner's: not written");
    assert.equal(lockedStyle(ctx.db, pack, ctx.packs).pending, null, 'and no new look waits on the account page');
    assert.equal(lockedStyle(ctx.db, pack, ctx.packs).hash, look.hash);

    // Offline: the niche's own scenes, made again each time and not kept, so a model later writes the account's own.
    const off = contextFor(home, null, 'offline.db');
    const offPack = off.pack('demo');
    const fallback = await scenesFor(off, offPack);
    clean(fallback);
    assert.ok(fallback.includes('football pitch grass'));
    assert.equal(getSetting(off.db, 'scenes:demo'), null);
    // theme.json's own scenes always win.
    assert.deepEqual(await scenesFor(ctx, { ...pack, theme: { ...pack.theme, backgroundQueries: ['octagon cage'] } }), ['octagon cage']);
  } finally {
    cleanup();
  }
});

test('a slide with no photograph, or a name on no photograph of whom it names, is a gap; a scene under no name is not', () => {
  const ph = (id, query, extra = {}) => ({ id, query, provider_id: `px-${id}`, alt: query, file: 'x.jpg', ...extra });
  const photos = new Map([[1, ph(1, 'clay pot close up')], [3, ph(3, 'Dana Example')], ['bg', ph(9, 'garden soil')], ['ca', ph(5, 'Dana Example')], ['cb', ph(6, 'Lee Sample')]]);
  const draft = { slides: [{ kind: 'cover' }, { kind: 'item', imageQuery: 'clay pot close up' }, { kind: 'item', imageQuery: 'Dana Example' }, { kind: 'item', imageQuery: 'Dana Example Harbour' }, { kind: 'item', role: 'clue', imageQuery: 'Dana Example' }] };
  const named = namedOn({ format: { kind: 'ranking' }, draft, outline: { imageQuery: '' } });
  assert.deepEqual([...named.keys()], [2, 3], 'a clue names no one, and neither does a scene');
  // Slide 2 names Dana and stands on the scene; slide 3 on her own photograph; the cover on a scene; slide 4 on nothing.
  const grounds = { tiktok: [['bg'], [1], ['bg'], [3], []], instagram: [['bg'], [1], ['bg'], [3], []] };
  const gaps = photoGaps({ grounds, photos, named, slides: 5 });
  assert.deepEqual(gaps.map((g) => [g.slide, g.why]), [[2, 'name'], [4, 'none']]);
  assert.deepEqual(gaps[0].names, ['Dana Example']);
  assert.equal(gapReason(gaps), 'אין תמונה מורשית של Dana Example לשקף 3, ושם לא נכתב בלי תמונה שמראה אותו · בשקף 5 אין תמונה: לא נמצאה תמונה מורשית, וגם לא סצנה של החשבון');
  assert.deepEqual(photoGaps({ grounds: { tiktok: [['bg'], [1], [3], [3]] }, photos, named, slides: 4 }), [], 'every name on its own face, every other slide on a photograph');
  // A head-to-head's cover names both sides: its two halves show them; a scene under the two names does not.
  const vs = namedOn({ format: { kind: 'head-to-head' }, draft: { slides: [{ kind: 'cover' }] }, outline: { imageQuery: 'Dana Example', imageQueryB: 'Lee Sample' } });
  assert.deepEqual(vs.get(0), ['Dana Example', 'Lee Sample']);
  assert.deepEqual(photoGaps({ grounds: { tiktok: [['ca', 'cb']] }, photos, named: vs, slides: 1 }), []);
  assert.deepEqual(photoGaps({ grounds: { tiktok: [['bg']] }, photos, named: vs, slides: 1 })[0].names, ['Dana Example', 'Lee Sample']);
  assert.match(gapReason(photoGaps({ grounds: { tiktok: [['bg']] }, photos, named: vs, slides: 1 })), /^אין תמונה מורשית של Dana Example ושל Lee Sample לשער/);
  // A facts cover's famous face is not named on it; a guess-who's reveal names its answer.
  assert.equal(namedOn({ format: { kind: 'facts' }, draft: { slides: [{ kind: 'cover' }] }, outline: { imageQuery: 'Dana Example' } }).size, 0);
  assert.deepEqual(namedOn({ format: { kind: 'guess-who' }, draft: { slides: [{ kind: 'cover' }, { kind: 'item', role: 'clue', imageQuery: '' }, { kind: 'item', role: 'reveal', imageQuery: '' }] }, outline: { imageQuery: 'Dana Example' } }).get(2), ['Dana Example']);
});

test('a slide about someone takes the photograph another slide found of them, by another search', () => {
  const ph = (query) => ({ file: 'x.jpg', query });
  const slides = [{ kind: 'cover' }, { kind: 'item', imageQuery: 'Sadio Mane Liverpool' }, { kind: 'item', imageQuery: 'football stadium at night' }, { kind: 'item', imageQuery: 'Sadio Mane Senegal' }];
  const { plan } = planPhotos({ slides, byIdx: new Map([[1, ph('Sadio Mane Liverpool')], ['bg', ph('football pitch grass')]]), postKind: 'facts' });
  assert.equal(plan.get(3), 1, "Mané's photograph, not a scene under his name");
  assert.equal(plan.get(2), 'bg', 'a slide about no one stands on a scene');
});

test("the scenes a post stands on are credited in its caption, and one the screen could not clear waits for a person", () => {
  const { cleanup } = tempHome();
  try {
    const db = new Db(':memory:');
    const img = (author, license, safety = 'ok') => db.insert('images', { provider: 'commons', provider_id: 'File:x.jpg', license, author, file: 'x', sha256: author, created_at: 'now', ai_generated: 0, realistic: 0, safety });
    const own = img('Jane Roe', 'CC BY-SA 4.0');
    const scene = img('Max Mustermann', 'CC BY 2.0', 'review');
    const post = { slides: [{ image_id: own }, { image_id: null }], checks: { bgImage: null, sceneImages: [scene], coverImages: [] } };
    assert.equal(imageCredit(db, post), 'צילומים: Jane Roe · CC BY-SA 4.0 · Wikimedia Commons | Max Mustermann · CC BY 2.0 · Wikimedia Commons');
    assert.deepEqual(waitingImages(db, post).map((x) => x.id), [scene]);
  } finally {
    cleanup();
  }
});

test('the validator still asks for scenes wherever a theme stands every slide on a photograph', async () => {
  const { home, cleanup } = tempHome();
  try {
    const dir = copyPack(home, 'demo', (f) => {
      f.theme.options = { ...f.theme.options, backgroundPhoto: true };
      delete f.theme.backgroundQueries;
    });
    assert.throws(() => loadPack(dir), (e) => (e.problems || [e.message]).join(' ').includes('backgroundPhoto needs backgroundQueries'));
  } finally {
    cleanup();
  }
});
