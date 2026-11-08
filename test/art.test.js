import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { ART_SYSTEM, NO_FACE, applyArt, artDirect, artUser, notAFace } from '../src/pipeline/art.js';
import { coverClaim, namedOn } from '../src/pipeline/build.js';
import { outlinePrompt, slidesPrompt } from '../src/pipeline/prompts.js';
import { opened, tempHome } from './helpers.js';

// Art direction (src/pipeline/art.js): the owner, 2026-11-08, on an Airbnb post that opened on its founder's headshot
// and showed the founders on two slides: "an image of the owner is not it", and "involve AI in setting up the page and
// creating slideshows, even if it X3 the cost of a slideshow". A post about a company, a product, a place or an idea
// shows the thing and what happened; a face only on a slide about that person.

after(() => {
  for (const db of opened.splice(0)) db.close?.();
});

const STORY = { id: 'story', kind: 'story' };

function airbnb() {
  const draft = {
    hook: '5 דברים שלא ידעתם על אייר בי אן בי',
    sub: '',
    slides: [
      { kind: 'cover', title: '', body: '' },
      { kind: 'item', role: 'item', title: 'אין כסף לשכר דירה, אז השכירו מזרנים', body: '', imageQuery: 'Joe Gebbia' },
      { kind: 'item', role: 'item', title: 'מכרו דגני בוקר כדי לגייס כסף', body: '', imageQuery: 'Brian Chesky' },
      { kind: 'item', role: 'item', title: 'היום אין לאייר בי אן בי אף נכס משלה', body: '', imageQuery: 'Airbnb headquarters' },
    ],
  };
  const outline = { topic: 'אייר בי אן בי', imageQuery: 'Brian Chesky', subjectKind: 'company' };
  return { draft, outline };
}

const ANSWER = {
  subjectKind: 'company',
  cover: { query: 'cozy apartment living room', person: false, show: 'a cozy living room of a home guests rent' },
  slides: [
    { index: 1, query: 'air mattress living room floor', person: false, show: 'air mattresses laid out on a living room floor' },
    { index: 2, query: 'cereal boxes on a shelf', person: false, show: 'boxes of breakfast cereal on a shelf' },
    { index: 3, query: 'city apartment building', person: false, show: 'a city apartment building where hosts rent rooms' },
  ],
  closing: { query: 'bright guest bedroom', show: 'a bright, tidy guest bedroom ready for visitors' },
};

test('the art director puts each slide on what it says: the founders\' faces give way to the mattresses, the cereal and the home', () => {
  const { draft, outline } = airbnb();
  const changed = applyArt({ format: STORY, draft, outline }, ANSWER);
  assert.deepEqual(changed, [0, 1, 2, 3]);
  assert.equal(outline.imageQuery, 'cozy apartment living room');
  assert.deepEqual(outline.coverShot, { person: false, show: 'a cozy living room of a home guests rent' });
  assert.deepEqual(draft.slides.map((s) => s.imageQuery || ''), ['', 'air mattress living room floor', 'cereal boxes on a shelf', 'city apartment building']);
  assert.equal(draft.slides[1].shot.person, false);
  assert.deepEqual(draft.closingScene, { query: 'bright guest bedroom', show: 'a bright, tidy guest bedroom ready for visitors' });
  // Nothing on the post names a face any more: no slide may be held back for a founder's missing photograph.
  assert.equal(namedOn({ format: STORY, draft, outline }).size, 0);
});

test('a guess-who\'s answer and a head-to-head\'s sides stay the outline\'s faces; a slide the answer leaves out keeps the writer\'s search', () => {
  for (const kind of ['guess-who', 'head-to-head']) {
    const { draft, outline } = airbnb();
    applyArt({ format: { id: kind, kind }, draft, outline }, { ...ANSWER, slides: [ANSWER.slides[0]] });
    assert.equal(outline.imageQuery, 'Brian Chesky', kind);
    assert.equal(draft.slides[2].imageQuery, 'Brian Chesky', 'left as it was');
  }
});

test('a post about a person keeps faces: the cover and a slide about them are named, and the checks ask for the face', () => {
  const { draft, outline } = airbnb();
  outline.subjectKind = 'person';
  const named = namedOn({ format: STORY, draft, outline });
  assert.deepEqual(named.get(0), ['Brian Chesky'], 'a post about Chesky opens on Chesky');
  assert.ok(!notAFace(outline));
  assert.match(coverClaim('Brian Chesky', 'x'), /the face clearly visible/);
  // A company post: the cover is not named, and a face is what its check refuses.
  outline.subjectKind = 'company';
  assert.ok(notAFace(outline));
  assert.ok(!namedOn({ format: STORY, draft, outline }).has(0));
  assert.match(NO_FACE, /A portrait, a headshot or a press photograph of a founder/);
  // An outline that does not say keeps the engine as it was.
  delete outline.subjectKind;
  assert.ok(!notAFace(outline));
});

test('the prompts: the outline says what the post is about and shows a company by what it does; the art director\'s rules and request', () => {
  const pack = { id: 'p', meta: { displayName: 'OpenFrequency', description: 'סיפורי עסקים', topics: ['עסקים'], imagery: { providers: ['commons'] } }, formats: {}, theme: {} };
  const { draft, outline } = airbnb();
  const user = artUser({ pack, format: STORY, draft, outline });
  assert.match(user, /POST: a story post about אייר בי אן בי \(the writer says it is about a company\)/);
  assert.match(user, /1\. אין כסף לשכר דירה, אז השכירו מזרנים \[the writer searched: Joe Gebbia\]/);
  assert.match(ART_SYSTEM, /a post about Airbnb opens on a home its guests rent, never on Brian Chesky/);
  assert.match(ART_SYSTEM, /Every slide a different picture/);
});

test('artDirect: a live model rewrites the searches and its cost is recorded; a recorded run and an account without photographs keep the writer\'s', async () => {
  const { home, cleanup } = tempHome();
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    const pack = { ...ctx.pack('demo'), meta: { ...ctx.pack('demo').meta, imagery: { providers: ['commons'] } } };
    const asked = [];
    const live = { ...ctx, llm: { kind: 'claude', json: async (req) => (asked.push(req), { data: ANSWER, estimated: true }) } };
    const { draft, outline } = airbnb();
    const r = await artDirect(live, { pack, format: STORY, draft, outline, postId: null });
    assert.deepEqual(r.changed, [0, 1, 2, 3]);
    assert.equal(asked[0].task, 'art-direction');
    assert.equal(asked[0].role, 'draft');
    assert.ok(db.get("SELECT COUNT(*) AS n FROM spend WHERE tag = 'art'").n === 1, 'its cost is in the ledger');
    assert.equal(draft.slides[2].imageQuery, 'cereal boxes on a shelf');

    const kept = airbnb();
    assert.equal(await artDirect({ ...ctx, llm: { kind: 'recorded', json: async () => assert.fail('no call') } }, { pack, format: STORY, ...kept, postId: null }), null);
    assert.equal(await artDirect(live, { pack: { ...pack, meta: { ...pack.meta, imagery: { providers: [] } } }, format: STORY, ...kept, postId: null }), null);
    assert.equal(kept.draft.slides[1].imageQuery, 'Joe Gebbia');
    // A failed call leaves the post as it was, and the pictures are still searched.
    const broken = { ...ctx, llm: { kind: 'claude', json: async () => { throw new Error('overloaded'); } } };
    assert.equal(await artDirect(broken, { pack, format: STORY, ...kept, postId: null }), null);
    assert.equal(kept.outline.imageQuery, 'Brian Chesky');
  } finally {
    cleanup();
  }
});

test('the writer is told: a company is shown by what it does, and a founder\'s story slide by what happened', () => {
  const { home, cleanup } = tempHome();
  try {
    const pack = loadAll({ dir: path.join(home, 'packs') }).find((p) => p.id === 'demo');
    const outline = outlinePrompt(pack, {});
    const text = JSON.stringify(outline.system);
    assert.match(text, /subjectKind/);
    assert.match(text, /never the face of its founder, its boss or its owner/);
    assert.ok(outline.schema.properties.subjectKind.enum.includes('company'));
    assert.ok(!outline.schema.required.includes('subjectKind'), 'optional: a recorded outline without it still reads');
    const slides = JSON.stringify(slidesPrompt(pack, {}).system);
    if (pack.meta.imagery?.providers?.length) assert.match(slides, /shows what happened, not their face/);
  } finally {
    cleanup();
  }
});
