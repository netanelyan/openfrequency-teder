import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { opened, tempHome } from './helpers.js';
import { makeContext } from '../src/engine.js';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { recordedClient } from '../src/llm/recorded.js';
import { aboutSubject, research } from '../src/sources/research.js';
import { buildPost, gatherDetails, subjectNames } from '../src/pipeline/build.js';
import { detailsUser } from '../src/pipeline/prompts.js';

// Research before drafting: more documents about the topic, the details a fan
// would want pulled out of them and verified, and a topic without three of them
// left for another. Offline, on the demo pack: its research is a recording.

const RESEARCH_DOC = {
  url: 'https://www.example.com/encyclopedia/office-pothos',
  title: 'The office pothos (Encyclopedia)',
  text: [
    'The office pothos became a small local story in the summer of 2025.',
    'The gardener who found it, Dana Levi, said: "I was sure it was dead, the soil was like sand."',
    'On day 81 the plant had only 3 green stems left, all of them near the window.',
    'Before the renovation the plant had been watered every Sunday for four years.',
    'After the story was told in the building newsletter, 40 employees asked for a cutting.',
    'An unrelated paragraph about the building parking lot and its opening hours.',
  ].join('\n'),
};

function withResearch(home, minDetails) {
  const dir = path.join(home, 'packs', 'demo');
  const pack = JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  pack.research = { minDetails };
  writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack));
  const s = JSON.parse(readFileSync(path.join(dir, 'sources.json'), 'utf8'));
  s.sources.push({ id: 'encyclopedia', type: 'api', url: 'https://www.example.com/encyclopedia/', name: 'האנציקלופדיה לדוגמה', lang: 'en', why: 'מקור בדיוני למחקר בחבילת הדמו.', approvedAt: '2026-10-14', api: { kind: 'wikipedia', lang: 'en', titles: [] } });
  writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(s));
  mkdirSync(path.join(dir, 'recordings', 'research'), { recursive: true });
  writeFileSync(path.join(dir, 'recordings', 'research', 'pothos-story.json'), JSON.stringify({ docs: [RESEARCH_DOC] }));
}

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, mode: 'recorded', packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

const DETAILS = [
  { id: 'X1', item: 0, kind: 'quote', claim: 'הגננת דנה לוי: "הייתי בטוחה שהוא מת, האדמה הייתה כמו חול"', quote: 'said: "I was sure it was dead, the soil was like sand."', doc: 'R1' },
  { id: 'X2', item: 0, kind: 'backstory', claim: 'לפני השיפוץ השקו אותו כל יום ראשון, ארבע שנים', quote: 'had been watered every Sunday for four years', doc: 'R1' },
  { id: 'X3', item: 0, kind: 'after', claim: 'אחרי שהסיפור פורסם, 40 עובדים ביקשו ייחור', quote: 'the building newsletter, 40 employees asked for a cutting', doc: 'R1' },
  { id: 'f2', item: 0, kind: 'number', claim: 'פרט שאין לו מקור', quote: 'this sentence is in no document at all', doc: 'R1' },
];

/** The recorded client, with the details call answered and the slides citing three details. */
function llmWith(details, { cite = true } = {}) {
  const rec = recordedClient();
  return {
    kind: 'claude',
    async json(req) {
      if (req.task === 'details') return { data: { details }, usage: null, model: req.model, estimated: true };
      if (req.task === 'review') return { data: { reviews: [] }, usage: null, model: req.model, estimated: true };
      const r = await rec.json(req);
      if (req.task === 'slides' && cite) r.data.slides.slice(0, 3).forEach((s, i) => s.facts.push(`X${i + 1}`));
      return r;
    },
  };
}

test('the part of a long article about the subject is kept, in its own order', () => {
  const text = 'Parking opens at 8.\nThe gardener Dana Levi said "it was dead".\nUnrelated weather for the week ahead in the city.\nOn day 81 Levi found 3 green stems.';
  const kept = aboutSubject(text, ['Levi'], 90);
  assert.match(kept, /Dana Levi said/);
  assert.doesNotMatch(kept, /weather/);
  assert.ok(kept.indexOf('Dana') < kept.indexOf('day 81') || !kept.includes('day 81'));
  assert.deepEqual(subjectNames({ subject: { a: 'Steven Gerrard', b: '', answer: '', date: '' }, topic: 'הנס של איסטנבול', research: ['2005 UEFA Champions League final'] }).slice(0, 3), ['Steven', 'Gerrard', 'הנס']);
});

test('research stores what it reads under an approved source, so every detail can be traced', async () => {
  const { home, cleanup } = tempHome();
  try {
    withResearch(home, 3);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const docs = await research(ctx, { pack, terms: ['office pothos'], names: ['pothos', 'Levi'], docKey: 'pothos-story' });
    assert.equal(docs.length, 1);
    const row = ctx.db.get('SELECT d.*, s.key AS skey FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ?', docs[0].id);
    assert.equal(row.skey, 'encyclopedia');
    assert.match(row.text, /parking lot/, 'the whole text is stored, for the quotes');
    // The user turn the details call reads: the plan, the facts, the documents by id.
    const user = detailsUser({ format: { id: 'plant-story', kind: 'story', name: 'x' }, outline: { topic: 't', subject: {}, items: [{ role: 'beat', point: 'p' }] }, facts: [{ claim: 'עובדה' }], docs: [{ ...docs[0], ref: 'R1' }] });
    assert.match(user, /<document id="R1"/);
    assert.match(user, /do not repeat them/);
  } finally {
    cleanup();
  }
});

test("research reads a Wikipedia page with its infobox, kept whole at the top: a fighter's record is in no paragraph", async () => {
  const { home, cleanup } = tempHome();
  const realFetch = globalThis.fetch;
  try {
    withResearch(home, 3);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const career = Array.from({ length: 40 }, (_, i) => `In fight ${i + 1} Fighter A won against a contender in round ${(i % 3) + 1}.`).join('\n');
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.includes('/rest_v1/page/html/')) return new Response('<html><head><title>Fighter_A</title></head><body><section data-mw-section-id="0"><table class="infobox"><tr><th>Wins</th><td>29</td></tr><tr><th>Losses</th><td>0</td></tr></table><p>Fighter A is a retired champion.</p></section></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      if (u.searchParams.get('list') === 'search') return Response.json({ query: { search: [{ title: 'Fighter A' }] } });
      return Response.json({ query: { pages: [{ title: 'Fighter A', extract: `Fighter A is a retired champion.\n== Career ==\n${career}` }] } });
    };
    const [doc] = await research({ ...ctx, mode: 'live' }, { pack, terms: ['Fighter A'], names: ['Fighter'] });
    assert.match(doc.text, /^Wins \| 29\nLosses \| 0/, 'the record first, whole');
    assert.match(doc.text, /In fight \d+ Fighter A won/);
    const row = ctx.db.get('SELECT text FROM documents WHERE id = ?', doc.id);
    assert.match(row.text, /Losses \| 0/, 'stored too, so a quote of the record is verified');
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
});

test('details are verified against their documents; fewer than the minimum leaves the topic', async () => {
  const { home, cleanup } = tempHome();
  try {
    withResearch(home, 3);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const outline = { topic: 'הפוטוס', subject: {}, items: [], facts: [{ id: 'f2' }], research: ['office pothos'] };
    const cand = { key: 'pothos-story', docs: [], refs: [] };
    const full = await gatherDetails({ ...ctx, llm: llmWith(DETAILS) }, { pack, format: { id: 'plant-story', kind: 'story' }, outline, cand });
    assert.equal(full.verified, 3);
    assert.equal(full.short, false);
    // The id the outline already used is renamed, never shadowed.
    assert.ok(full.facts.some((f) => f.key === 'Xf2' && !f.verified));
    assert.ok(full.facts.every((f) => f.detail));
    const thin = await gatherDetails({ ...ctx, llm: llmWith(DETAILS.slice(0, 2)) }, { pack, format: { id: 'plant-story', kind: 'story' }, outline, cand });
    assert.equal(thin.short, true);
  } finally {
    cleanup();
  }
});

test('a post is drafted only with three verified details, and the slides must use them', async () => {
  const { home, cleanup } = tempHome();
  try {
    withResearch(home, 3);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const ok = await buildPost({ ...ctx, llm: llmWith(DETAILS) }, { pack, formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
    assert.equal(ok.status, 'sample', ok.reason);
    const kept = ctx.db.all('SELECT key, detail, verified FROM facts WHERE post_id = ? AND detail IS NOT NULL', ok.postId);
    assert.equal(kept.filter((f) => f.verified).length, 3);
    const step = ctx.db.get("SELECT status FROM steps WHERE post_id = ? AND step = 'details'", ok.postId);
    assert.equal(step.status, 'ok');

    const fresh = () => ctx.db.run('DELETE FROM posts');
    fresh();
    // Two details where three are asked: the outline's own spare facts (8 verified for 5 slides) count as details
    // (detailsDepth, 2026-11-06), so the topic stands. Asked for six, two and three spare are short, and it does not.
    const two = await buildPost({ ...ctx, llm: llmWith(DETAILS.slice(0, 2)) }, { pack, formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
    const twoStep = JSON.parse(ctx.db.get("SELECT status, detail_json FROM steps WHERE post_id = ? AND step = 'details'", two.postId).detail_json);
    assert.equal(ctx.db.get("SELECT status FROM steps WHERE post_id = ? AND step = 'details'", two.postId).status, 'ok');
    assert.deepEqual([twoStep.verified, twoStep.spare, twoStep.bar], [2, 3, 3]);
    fresh();
    const packFile = path.join(home, 'packs', 'demo', 'pack.json');
    writeFileSync(packFile, JSON.stringify({ ...JSON.parse(readFileSync(packFile, 'utf8')), research: { minDetails: 6 } }));
    const six = contextFor(home);
    const thin = await buildPost({ ...six, llm: llmWith(DETAILS.slice(0, 2)) }, { pack: six.pack('demo'), formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
    assert.equal(thin.status, 'blocked');
    assert.equal(six.db.get("SELECT status FROM steps WHERE post_id = ? AND step = 'details'", thin.postId).status, 'failed');

    fresh();
    // Details found but left off the slides: the redraft is told, and without a second recording the post stops there.
    const unused = await buildPost({ ...ctx, llm: llmWith(DETAILS, { cite: false }) }, { pack, formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
    assert.equal(unused.status, 'blocked');
    assert.match(ctx.db.get("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'slides'", unused.postId).detail_json, /at least 3 of them belong on the slides/);
  } finally {
    cleanup();
  }
});

test('a graphic still malformed after the redraft is dropped, and the post goes on without it', async () => {
  const { home, cleanup } = tempHome();
  try {
    withResearch(home, 3);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const base = llmWith(DETAILS);
    // Every slides answer carries a compare of one row: two to five are the rule.
    const llm = { ...base, async json(req) {
      const r = await base.json(req);
      if (req.task === 'slides') r.data.slides[0].visual = { type: 'compare', a: 'לפני', b: 'אחרי', items: [{ label: 'מצב העציץ', value: 'יבש', value2: 'ירוק' }] };
      return r;
    } };
    const ok = await buildPost({ ...ctx, llm }, { pack, formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
    assert.equal(ok.status, 'sample', ok.reason);
    const st = ctx.db.get("SELECT status, detail_json FROM steps WHERE post_id = ? AND step = 'visual'", ok.postId);
    assert.equal(st.status, 'ok');
    assert.deepEqual(JSON.parse(st.detail_json).dropped, ['slide 1']);
  } finally {
    cleanup();
  }
});

test("a slide's uncited number is cited when exactly one verified fact holds it", async () => {
  const { citeNumbers } = await import('../src/pipeline/build.js');
  const facts = [
    { key: 'f1', quote: 'Messi lifted the trophy in Lusail', verified: true },
    { key: 'f2', quote: 'the 2022 FIFA World Cup final', verified: true },
    { key: 'f3', quote: 'in 2014 and again in 2022 the final', verified: false },
    { key: 'f4', quote: 'a crowd of 88,966 watched', verified: true },
    { key: 'f5', quote: '88,966 people were in the stadium', verified: true },
  ];
  const draft = { slides: [{ kind: 'cover', factKeys: [] }, { kind: 'item', title: 'מסי ב-2022', body: 'מול 88,966 צופים', factKeys: ['f1'], visual: null }] };
  assert.deepEqual(citeNumbers(draft, facts), ['slide 1: cites f2 for 2022']);
  // 88,966 is in two facts: which one the slide meant is not the code's to guess, so the gate decides.
  assert.deepEqual(draft.slides[1].factKeys, ['f1', 'f2']);
});

test("a plan with too many slides of one role keeps the ones with the most facts, in their order", async () => {
  const { fitShape } = await import('../src/pipeline/build.js');
  const format = { kind: 'what-happened' };
  const items = [
    { role: 'then', point: 'a', facts: ['f1'] },
    { role: 'turn', point: 'b', facts: ['f2'] },
    { role: 'turn', point: 'c', facts: ['f3', 'f4'] },
    { role: 'turn', point: 'd', facts: ['f5', 'f6'] },
    { role: 'now', point: 'e', facts: ['f7'] },
  ];
  const { items: kept, trimmed } = fitShape(format, items);
  assert.deepEqual(kept.map((it) => it.point), ['a', 'c', 'd', 'e']);
  assert.deepEqual(trimmed, ['turn: b']);
  // A run within its size is left alone, and a kind that repeats its pairs is not touched.
  assert.equal(fitShape(format, items.filter((it) => it.point !== 'b')).trimmed.length, 0);
  assert.equal(fitShape({ kind: 'myth-fact' }, items).items.length, 5);
});
