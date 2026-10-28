import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/index.js';
import { gate, numbersIn, verifyFact, tokenOf } from '../src/verify/claims.js';
import { renderPost } from '../src/render/render.js';
import { tempHome } from './helpers.js';
import { htmlToText } from '../src/sources/text.js';
import { he } from '../src/render/html.js';
import { loadPack } from '../src/packs/load.js';
import path from 'node:path';

// HARD RULE 3: every fact on a slide traces to an approved source, checked in
// code before rendering. An unsourced fact must fail.

function setup() {
  const db = new Db(':memory:');
  const at = new Date().toISOString();
  db.insert('accounts', { id: 'demo', display_name: 'd', handle: 'd', created_at: at, updated_at: at });
  db.insert('accounts', { id: 'other', display_name: 'o', handle: 'o', created_at: at, updated_at: at });
  const src = db.insert('sources', { account_id: 'demo', key: 's', type: 'web', url: 'https://www.example.com/', name: 'Example', status: 'approved', origin: 'pack', created_at: at });
  const pending = db.insert('sources', { account_id: 'demo', key: 'p', type: 'web', url: 'https://www.example.com/p', name: 'Pending', status: 'pending', origin: 'discovered', created_at: at });
  const foreign = db.insert('sources', { account_id: 'other', key: 'f', type: 'web', url: 'https://www.example.net/', name: 'Foreign', status: 'approved', origin: 'pack', created_at: at });
  const text = 'Basil needs at least 6 hours of direct sunlight a day. With less light, the stems stretch.\nUse a pot at least 20 cm wide with drainage holes.';
  const doc = (source_id, sha) => db.insert('documents', { source_id, url: 'https://www.example.com/basil', text, sha256: sha, fetched_at: at });
  return { db, doc: doc(src, 'a'), pendingDoc: doc(pending, 'b'), foreignDoc: doc(foreign, 'c') };
}

test('a fact whose quote is in the stored document, from an approved source, passes', () => {
  const { db, doc } = setup();
  const r = verifyFact(db, { claim: 'בזיליקום צריך 6 שעות שמש', quote: 'Basil needs at least 6 hours of direct sunlight a day.', document_id: doc }, { accountId: 'demo' });
  assert.deepEqual(r, { ok: true, error: null });
});

test('an unsourced fact fails', () => {
  const { db } = setup();
  assert.equal(verifyFact(db, { claim: 'x', quote: 'Basil needs at least 6 hours', document_id: null }, { accountId: 'demo' }).ok, false);
  assert.match(verifyFact(db, { claim: 'x', quote: 'Basil needs at least 6 hours', document_id: 999 }, { accountId: 'demo' }).error, /not stored/);
});

test('a paraphrased quote fails: it must be in the document word for word', () => {
  const { db, doc } = setup();
  const r = verifyFact(db, { claim: 'x', quote: 'Basil wants six or more hours of direct sun every day', document_id: doc }, { accountId: 'demo' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not in the source document/);
});

test('a source that is not approved, or belongs to another account, vouches for nothing', () => {
  const { db, pendingDoc, foreignDoc } = setup();
  const q = 'Basil needs at least 6 hours of direct sunlight a day.';
  assert.match(verifyFact(db, { claim: 'x', quote: q, document_id: pendingDoc }, { accountId: 'demo' }).error, /not approved/);
  assert.match(verifyFact(db, { claim: 'x', quote: q, document_id: foreignDoc }, { accountId: 'demo' }).error, /another account/);
});

test('an invented number fails: every number in the claim must be in the quote', () => {
  const { db, doc } = setup();
  const r = verifyFact(db, { claim: 'בזיליקום צריך 8 שעות שמש', quote: 'Basil needs at least 6 hours of direct sunlight a day.', document_id: doc }, { accountId: 'demo' });
  assert.match(r.error, /states 8/);
});

test('a quote too long to be a short fact fails (copyright: short facts only)', () => {
  const { db, doc } = setup();
  const q = 'Basil needs at least 6 hours of direct sunlight a day. With less light, the stems stretch.';
  assert.match(verifyFact(db, { claim: 'x', quote: q, document_id: doc }, { accountId: 'demo', maxQuoteWords: 8 }).error, /more than 8/);
});

test('numbers are compared as numbers: "1,000" is 1000', () => {
  assert.deepEqual([...numbersIn('עלה ל-1,000 ₪ ואז 2.5%')], ['1000', '2.5']);
});

test('a count written in Hebrew words is a number too, and ordinary Hebrew is not', () => {
  assert.deepEqual([...numbersIn('ניצחה חמש פעמים, ובשלושת המשחקים', { hebrew: true })], ['5', '3']);
  assert.deepEqual([...numbersIn('the fourteenth title, five goals', { words: true })], ['14', '5']);
  // "One of", "Monday" and a city that ends in "seven" state no number.
  assert.deepEqual([...numbersIn('אחד הצמחים, ביום שני, בבאר שבע', { hebrew: true })], []);
  // "מליון" alone is from Lyon (a true fact about Benzema was refused as a million); after a number it is a million.
  assert.deepEqual([...numbersIn('90 שערים ב-152 הופעות, מליון ועד ריאל מדריד', { hebrew: true })], ['90', '152']);
  assert.deepEqual([...numbersIn('שני מליון צופים', { hebrew: true })], ['2000000']);
  assert.deepEqual([...numbersIn('מיליון צופים', { hebrew: true })], ['1000000']);
  const facts = [{ key: 'f1', quote: 'Basil needs at least 6 hours of direct sunlight a day.', verified: true }];
  const cover = { kind: 'cover', title: '', body: '', factKeys: [] };
  const words = gate({ slides: [cover, { kind: 'item', title: 'שמונה שעות שמש', body: '', factKeys: ['f1'] }], facts });
  assert.match(words.problems.join(), /number 8/);
  const right = gate({ slides: [cover, { kind: 'item', title: 'שש שעות שמש', body: '', factKeys: ['f1'] }], facts });
  assert.equal(right.ok, true, right.problems.join('; '));
});

test('page text keeps quotes intact: tags with ">" in attributes and wiki markers leave nothing behind', () => {
  const html = '<p data-mw=\'{"a":"<b>x</b>"}\'>From <b>October</b> 2025 it ships.[3][citation needed]</p><span title="a > b">Second</span> line{{cite}}';
  assert.equal(htmlToText(html), 'From October 2025 it ships.\nSecond line');
});

test('the gate refuses a slide with no fact, an unverified fact, or a number its facts do not hold', () => {
  const facts = [
    { key: 'f1', quote: 'Basil needs at least 6 hours of direct sunlight a day.', verified: true },
    { key: 'f2', quote: 'something else entirely here', verified: false, error: 'not in the source' },
  ];
  const cover = { kind: 'cover', title: '', body: '', factKeys: [] };
  const ok = gate({ hook: '2 דברים', slides: [cover, { kind: 'item', title: '6 שעות שמש', body: '', factKeys: ['f1'] }, { kind: 'item', title: 'ועוד', body: '', factKeys: ['f1'] }], facts });
  assert.equal(ok.ok, true, ok.problems.join('; '));
  const none = gate({ slides: [cover, { kind: 'item', title: 'טענה', body: 'בלי מקור', factKeys: [] }], facts });
  assert.match(none.problems.join(), /states no sourced fact/);
  const bad = gate({ slides: [cover, { kind: 'item', title: 'טענה', body: '', factKeys: ['f2'] }], facts });
  assert.match(bad.problems.join(), /failed verification/);
  const num = gate({ slides: [cover, { kind: 'item', title: '8 שעות שמש', body: '', factKeys: ['f1'] }], facts });
  assert.match(num.problems.join(), /number 8/);
  const capt = gate({ slides: [cover, { kind: 'item', title: '6 שעות', body: '', factKeys: ['f1'] }], facts, caption: 'מעל 90% מצליחים' });
  assert.match(capt.problems.join(), /caption: the number 90/);
});

test('the renderer refuses text that did not pass the gate', async () => {
  const { home, cleanup } = tempHome();
  try {
    const pack = loadPack(path.join(home, 'packs', 'demo'));
    const slides = [{ kind: 'cover', title: '', body: '', factKeys: [] }];
    const post = { id: 'x', hook: 'שלום', sub: '', caption: '' };
    await assert.rejects(renderPost({ pack, post: { ...post, token: 'forged' }, slides, outDir: home }), /not checked by the fact gate/);
    await assert.rejects(renderPost({ pack, post: { ...post, token: tokenOf({ slides, caption: '', hook: 'אחר', sub: '' }) }, slides, outDir: home }), /not checked/);
  } finally {
    cleanup();
  }
});

test('slide text keeps Hebrew quote marks and isolates Latin runs (hard rule 8)', () => {
  assert.equal(he('עד 1,200 ש"ח, צה"ל ו-AT&T'), 'עד 1,200 ש&quot;ח, צה&quot;ל ו-<bdi>AT&amp;T</bdi>');
  assert.equal(he('<b> ב-Gemini 2.5'), '&lt;<bdi>b</bdi>&gt; ב-<bdi>Gemini 2.5</bdi>');
});

test('digits inside a product name are part of the name, not a number to quote', async () => {
  const { numbersIn } = await import('../src/verify/claims.js');
  const n = (t) => [...numbersIn(t, { hebrew: true })].join(',');
  assert.equal(n('Base44 נקנתה'), '');
  assert.equal(n('GPT-4o ו-H100'), '');
  assert.equal(n('Web3 ב-2022'), '2022');
  // A token that starts with its digits is a number, and so is a version after a space.
  assert.equal(n('גייסו 20M'), '20');
  assert.equal(n('Claude 3.5'), '3.5');
  assert.equal(n('UFC 193'), '193');
});

test("a fighter's infobox row is evidence however short, once in the document and as whole words", () => {
  const { db } = setup();
  const at = new Date().toISOString();
  const src = db.get("SELECT id FROM sources WHERE key = 's'").id;
  const text = 'Ilia Topuria\nReach | 69 in (175 cm)\nMixed martial arts record\nTotal | 18\nWins | 17\nBy knockout | 7\nBy submission | 8\nLosses | 1\nBy knockout | 1\nRanked | 170';
  const doc = db.insert('documents', { source_id: src, url: 'https://en.wikipedia.org/wiki/Ilia_Topuria', text, sha256: 'row', fetched_at: at });
  const check = (claim, quote) => verifyFact(db, { claim, quote, document_id: doc }, { accountId: 'demo' });
  assert.equal(check('לטופוריה 17 ניצחונות', 'Wins | 17').ok, true);
  assert.equal(check('7 ניצחונות בנוקאאוט', 'By knockout | 7').ok, true);
  assert.equal(check('טווח ידיים של 175 ס"מ', 'Reach | 69 in (175 cm)').ok, true);
  assert.match(check('הפסד אחד בנוקאאוט', 'By knockout | 1').error || 'ok', /ok/, 'the losses row is once in the text');
  assert.match(check('17 ניצחונות', 'Wins 17').error, /too short/, 'two words that are no table row are no evidence');
  assert.match(check('דירוג 17', 'Ranked | 17').error, /only inside a longer one/, '"Ranked | 17" is not in "Ranked | 170"');
});

test("a stat's year from the note that dates its table may be said with it; no other number may", () => {
  const { db } = setup();
  const at = new Date().toISOString();
  const src = db.get("SELECT id FROM sources WHERE key = 's'").id;
  const text = 'Senior career*\nYears | Team | Apps | (Gls)\n2023– | Barcelona | 111 | (38)\n* Club domestic league appearances and goals as of 23:11, 25 October 2026 (UTC)\nHe was born in 2007.';
  const doc = db.insert('documents', { source_id: src, url: 'https://en.wikipedia.org/wiki/Lamine_Yamal', text, sha256: 'asof', fetched_at: at });
  const check = (claim, quote) => verifyFact(db, { claim, quote, document_id: doc }, { accountId: 'demo' });
  assert.equal(check('עד 2026 ימאל כבש 38 שערים ב-111 הופעות בברצלונה', '2023– | Barcelona | 111 | (38)').ok, true, 'the note dates the row');
  assert.match(check('ב-2007 ימאל כבש 38 שערים ב-111 הופעות', '2023– | Barcelona | 111 | (38)').error, /2007/, 'a year from anywhere else in the page is not the row\'s');
  assert.match(check('ימאל כבש 40 שערים ב-111 הופעות', '2023– | Barcelona | 111 | (38)').error, /40/, 'nor is another number');
});

test("a story is told through its moment: its verified facts go on the payoff slide, and a story whose moment no verified fact tells is refused", async () => {
  const { planFrom } = await import('../src/pipeline/build.js');
  const { db } = setup();
  const at = new Date().toISOString();
  const src = db.get("SELECT id FROM sources WHERE key = 's'").id;
  const text = 'Gaethje and Holloway met for the BMF title at UFC 300 in April 2024. Holloway knocked Gaethje out with one second left in the fifth round. Gaethje had won 17 post-fight bonuses in 16 appearances.';
  const doc = db.insert('documents', { source_id: src, url: 'https://en.wikipedia.org/wiki/UFC_300', text, sha256: 'moment', fetched_at: at });
  const cand = { key: 'k', refs: [{ id: doc, source_id: src, ref: 'D1' }] };
  const facts = [
    { id: 'f1', claim: 'גייתג\' והולוואי נפגשו על חגורת ה-BMF ב-UFC 300', quote: 'Gaethje and Holloway met for the BMF title at UFC 300', doc: 'D1', who: '', whoHe: '' },
    { id: 'f2', claim: 'הולוואי הפיל את גייתג\' שנייה לפני הסוף', quote: 'Holloway knocked Gaethje out with one second left in the fifth round', doc: 'D1', who: '', whoHe: '' },
    { id: 'f3', claim: 'לגייתג\' 17 בונוסים ב-16 הופעות', quote: 'Gaethje had won 17 post-fight bonuses in 16 appearances', doc: 'D1', who: '', whoHe: '' },
  ];
  const items = [{ role: 'beat', point: 'a', facts: ['f1'] }, { role: 'beat', point: 'b', facts: ['f3'] }, { role: 'beat', point: 'c', facts: ['f1'] }, { role: 'payoff', point: 'd', facts: ['f3'] }];
  const format = { id: 'fight-story', kind: 'story' };
  const pack = { id: 'demo', rules: {} };
  const outline = { topic: 't', facts, items: structuredClone(items), moment: { point: 'הנוקאאוט בשנייה האחרונה', facts: ['f2'] } };
  const made = planFrom({ db }, { pack, format, outline, cand });
  assert.ok(!made.why, made.why);
  assert.deepEqual(outline.momentKeys, ['f2']);
  assert.ok(made.items.find((it) => it.role === 'payoff').facts.includes('f2'), 'the payoff slide is given the moment');
  const unsure = { topic: 't', facts: facts.map((f) => (f.id === 'f2' ? { ...f, quote: 'Holloway knocked Gaethje out in the first round' } : f)), items: structuredClone(items), moment: { point: 'הנוקאאוט', facts: ['f2'] } };
  assert.match(planFrom({ db }, { pack, format, outline: unsure, cand }).why || '', /הרגע שהסיפור נשען עליו/);
});
