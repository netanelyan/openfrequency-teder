import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { CLOSER_SYSTEM, closerUser, writeClosing } from '../src/pipeline/closer.js';
import { closingFrom } from '../src/pipeline/closing.js';
import { endKeyOf } from '../src/render/render.js';
import { opened, tempHome } from './helpers.js';

// The closing slide's own call (src/pipeline/closer.js) and its own background (the art director's scene, 'end'): the
// owner, 2026-11-08, on "רוצים לספר סיפור עסקי כזה? ב-OpenFrequency כותבים מצגות" over a random photograph: "CTA is
// not the best", and "involve AI in setting up the page and creating slideshows, even if it X3 the cost of a slideshow".

function setup() {
  const { home, cleanup } = tempHome();
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  const pack = ctx.pack('demo');
  const draft = {
    hook: '5 טעויות של בזיליקום במרפסת',
    sub: '',
    slides: [
      { kind: 'cover', title: '', body: '' },
      { kind: 'item', role: 'item', title: 'משקים כל יום', body: 'השורשים נרקבים תוך שבוע כשהאדמה לא מתייבשת.' },
      { kind: 'item', role: 'item', title: 'עציץ בלי חור', body: 'המים נשארים למטה, והצמח טובע בלי שרואים.' },
    ],
    closing: closingFrom(pack, 'עוד על בזיליקום בפוסטים הבאים', 'writer'),
  };
  return { ctx, pack, draft, cleanup };
}

test('the closer reads the whole slideshow, what the business offers and the writer\'s line, and writes the turn from the story to it', async () => {
  const { ctx, pack, draft, cleanup } = setup();
  try {
    const user = closerUser({ pack, draft, outline: { topic: 'בזיליקום במרפסת' } });
    assert.match(user, /THE POST: 5 טעויות של בזיליקום במרפסת/);
    assert.match(user, /1\. משקים כל יום \/ השורשים נרקבים/);
    assert.match(user, /CLOSING SLIDE:/, "the closing's own rules");
    assert.match(user, /Write its one line in "line"/);
    assert.match(user, /The line written with the slides \(improve on it, or keep it if it is already the best\): עוד על בזיליקום בפוסטים הבאים/);
    assert.match(CLOSER_SYSTEM, /no "רוצים\.\.\.\?" or "מחפשים\.\.\.\?" opener/);
    const asked = [];
    const live = { ...ctx, llm: { kind: 'claude', json: async (req) => (asked.push(req), { data: { line: 'בזיליקום שלא טובע מתחיל בעציץ עם חור, והטיפים הבאים כבר בדרך', why: 'picks up the drowning pot' }, estimated: true }) } };
    const r = await writeClosing(live, { pack, draft, outline: { topic: 'בזיליקום במרפסת' } });
    assert.equal(asked[0].task, 'closing');
    assert.equal(r.closing.by, 'closer');
    assert.equal(r.closing.kind, draft.closing.kind, 'the same destination: the action stays the code\'s');
    assert.equal(draft.closing.line, 'עוד על בזיליקום בפוסטים הבאים', 'the caller decides whether to take it');
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM spend WHERE tag = 'closing'").n, 1, 'its cost is in the ledger');
  } finally {
    cleanup();
  }
});

test('a line that breaks the closing\'s rules comes back with what it broke; a recorded run and a post with no closing slide make no call', async () => {
  const { ctx, pack, draft, cleanup } = setup();
  try {
    const bad = { ...ctx, llm: { kind: 'claude', json: async () => ({ data: { line: 'הבזיליקום הכי טוב בעולם, רק היום! לחצו על הלינק בביו', why: '' }, estimated: true }) } };
    const r = await writeClosing(bad, { pack, draft, outline: {} });
    assert.ok(r.problems.length, 'refused');
    assert.ok(r.problems.some((p) => /הכי|urgency|רק היום|action|לינק|exclamation/i.test(p)), r.problems.join(' | '));
    const none = { ...ctx, llm: { kind: 'recorded', json: async () => assert.fail('no call') } };
    assert.equal(await writeClosing(none, { pack, draft, outline: {} }), null);
    assert.equal(await writeClosing({ ...ctx, llm: bad.llm }, { pack, draft: { ...draft, closing: null }, outline: {} }), null);
    const broken = { ...ctx, llm: { kind: 'claude', json: async () => { throw new Error('overloaded'); } } };
    assert.equal(await writeClosing(broken, { pack, draft, outline: {} }), null, 'a failed call leaves the writer\'s line');
  } finally {
    cleanup();
  }
});

test('the closing slide stands on its own background when the art director\'s scene was found, else on the post\'s least-used one', () => {
  const photo = (file) => ({ file });
  const uses = new Map([['bg', 2], ['bg2', 1], [1, 1]]);
  assert.equal(endKeyOf({ byIdx: new Map([['end', photo('e.jpg')], ['bg', photo('b.jpg')]]), sceneKeys: ['bg', 'bg2'], uses }), 'end');
  assert.equal(endKeyOf({ byIdx: new Map([['bg', photo('b.jpg')], ['bg2', photo('c.jpg')]]), sceneKeys: ['bg', 'bg2'], uses }), 'bg2');
  assert.equal(endKeyOf({ byIdx: new Map([['end', { file: null }]]), sceneKeys: [], uses: new Map() }), null);
});
