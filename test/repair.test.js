import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { REPAIR_SCHEMA, repairPrompt } from '../src/pipeline/prompts.js';
import { REPAIR_ATTEMPTS, applyRepair, repairPlan, targetsOf } from '../src/pipeline/repair.js';
import { gate, numbersIn, verifyFact } from '../src/verify/claims.js';
import { closeBrowser } from '../src/render/render.js';
import { opened, tempHome } from './helpers.js';

after(() => closeBrowser());

// A draft the code checks refused is mended where it failed, with the checks' own words, before it is blocked
// (src/pipeline/repair.js); and a number written in words is the number it means (src/verify/claims.js).

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

/**
 * The recorded writer, with its slides answer changed by `edit`, and each repair answered by `repairs[n]`
 * (a function of the request's targets). Counts the repair calls.
 */
const writer = (ctx, edit, repairs = []) => {
  const calls = { repair: 0, users: [] };
  return {
    calls,
    llm: { ...ctx.llm, async json(req) {
      if (req.task === 'repair') {
        const answer = repairs[calls.repair++];
        calls.users.push(req.user);
        if (!answer) return { data: { repairs: [] }, usage: null, model: req.model, estimated: true };
        return { data: { repairs: answer(req.user) }, usage: null, model: req.model, estimated: true };
      }
      const r = await ctx.llm.json(req);
      if (req.task !== 'slides') return r;
      const data = structuredClone(r.data);
      edit(data);
      return { ...r, data };
    } },
  };
};

const build = (ctx, llm) => buildPost({ ...ctx, llm }, { pack: ctx.pack('demo'), formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
const stepsOf = (ctx, postId, name) => ctx.db.all('SELECT status, detail_json FROM steps WHERE post_id = ? AND step = ? ORDER BY id', postId, name).map((s) => ({ status: s.status, ...JSON.parse(s.detail_json || '{}') }));
const slide = (target, s) => ({ target, text: '', title: s.title, body: s.body, a: '', b: '', facts: s.facts });

// The recorded second slide of pothos-story, as the writer wrote it.
const JUNE = { title: 'מה חיכה להם ביוני', body: 'האדמה יבשה לגמרי ורוב העלים צהובים. אבל 3 גבעולים עוד היו ירוקים.', facts: ['f3'] };
const STORY = {
  hook: 'פוטוס אחד נשאר לבד במשרד סגור 81 יום.',
  problem: 'אף אחד לא השקה אותו, וכשהעובדים חזרו רוב העלים כבר היו צהובים.',
  discovery: 'אבל שלושה גבעולים החזיקו מעמד, ומהם יצאו ייחורים.',
  result: 'הייחורים מילאו חמישה עציצים, והצמח המקורי צומח מחדש על אותו מדף.',
};

test('each refused check is traced to the one text it is about; the law, honesty and post-wide problems are not', () => {
  const draft = {
    hook: 'פוטוס אחד ו-9 ימים', sub: '', caption: '', captionShort: '', keywords: ['פוטוס', 'pothos'],
    slides: [{ kind: 'cover' }, { kind: 'item', title: 'א', body: 'ב', factKeys: [] }, { kind: 'item', title: 'ג', body: 'ד', factKeys: [] }],
  };
  assert.deepEqual(targetsOf(draft, { where: 'slide 2 title', code: 'length', msg: 'the title is over 70 characters' }), ['slide 2']);
  assert.deepEqual(targetsOf(draft, { where: 'slide 1', code: 'overlay', msg: '1 lines of text' }), ['slide 1']);
  assert.deepEqual(targetsOf(draft, { where: 'facts', code: 'verify', msg: 'slide 2: the number 4 is not in the quotes it cites' }), ['slide 2']);
  assert.deepEqual(targetsOf(draft, { where: 'facts', code: 'verify', msg: 'the cover: the number 9 is not in any cited quote' }), ['cover']);
  assert.deepEqual(targetsOf(draft, { where: 'caption', code: 'caption', msg: 'the TikTok caption is a story in 4 lines' }), ['caption']);
  assert.deepEqual(targetsOf(draft, { where: 'shape', code: 'shape', msg: 'slide 1: a stat slide needs both values (a and b)' }), ['slide 1']);
  // The cover short of lines can take the missing line in the line under it.
  assert.deepEqual(targetsOf(draft, { where: 'cover', code: 'overlay', msg: '2 lines of text: at least 3 on a slide (title and text together)' }), ['cover', 'cover line 2']);
  assert.deepEqual(targetsOf(draft, { where: 'facts', code: 'verify', msg: "slide 2: the visual's number 90 is not in the quotes the slide cites" }), ['slide 2']);
  for (const p of [
    { where: 'slide 1 text', code: 'compliance:financial', msg: 'a recommendation' },
    { where: 'cover', code: 'honesty:experience', msg: 'claims to have tried it' },
    { where: 'caption', code: 'rule:no-brands', msg: 'names a brand' },
    { where: 'shape', code: 'shape', msg: "the slides must follow the outline's roles in order (beat, payoff)" },
    { where: 'details', code: 'shape', msg: 'the slides use 1 of the details' },
    { where: 'visual', code: 'shape', msg: 'only 1 of the 5 content slides carry a visual' },
    { where: 'slide 0 title', code: 'length', msg: 'the cover is not a content slide' },
  ]) assert.equal(targetsOf(draft, p), null, p.msg);
  const plan = repairPlan(draft, [{ where: 'slide 2 title', code: 'length', msg: 'x' }, { where: 'caption', code: 'caption', msg: 'y' }, { where: 'slide 2 text', code: 'voice:x', msg: 'z' }]);
  assert.deepEqual([...plan.targets.keys()], ['slide 2', 'caption']);
  assert.equal(plan.targets.get('slide 2').length, 2);
  assert.equal(repairPlan(draft, [{ where: 'slide 2 title', code: 'length', msg: 'x' }, { where: 'cover', code: 'honesty:badge', msg: 'y' }]).stuck.length, 1);
});

test('a number the quotes do not hold is repaired by removing it or citing a verified fact, never by another number or source', () => {
  const facts = [{ key: 'f1', quote: 'three stems stayed green, 3 of them', verified: true }, { key: 'f2', quote: 'and 4 stems', verified: true }, { key: 'f9', quote: '7 stems', verified: false }];
  const draft = { hook: 'x', slides: [{ kind: 'cover' }, { kind: 'item', title: '4 גבעולים', body: 'נשארו ירוקים', factKeys: ['f1'] }] };
  const r = (title, cites = ['f1']) => ({ text: '', title, body: 'נשארו ירוקים', a: '', b: '', facts: cites });
  assert.match(applyRepair(draft, 'slide 1', r('7 גבעולים'), { facts, factLock: true }).refused, /states 7, which no quote it cites holds/);
  // The quote's own number, or the number of a fact the slide now cites, is a correction, not an invention.
  assert.equal(applyRepair(draft, 'slide 1', r('3 גבעולים'), { facts, factLock: true }).draft.slides[1].title, '3 גבעולים');
  assert.match(applyRepair(draft, 'slide 1', r('7 גבעולים', ['f9']), { facts, factLock: true }).refused, /f9/);
  assert.match(applyRepair(draft, 'slide 1', r('ארבעה גבעולים ועוד שבעה'), { facts, factLock: true }).refused, /states 7/);
  assert.match(applyRepair(draft, 'slide 1', r('4 גבעולים', ['f1', 'f3']), { facts, factLock: true }).refused, /cites f3, which is not one of this post's verified facts/);
  assert.match(applyRepair(draft, 'slide 1', r('4 גבעולים', ['f9']), { facts, factLock: false }).refused, /f9/);
  // Removed, or cited: both stand.
  assert.equal(applyRepair(draft, 'slide 1', r('כמה גבעולים'), { facts, factLock: true }).draft.slides[1].title, 'כמה גבעולים');
  assert.deepEqual(applyRepair(draft, 'slide 1', r('4 גבעולים', ['f1', 'f2']), { facts, factLock: true }).draft.slides[1].factKeys, ['f1', 'f2']);
  // The draft it was given is never changed.
  assert.equal(draft.slides[1].title, '4 גבעולים');
});

test('the repair is asked on the account\'s cached prefix, in its own small schema', () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const p = repairPrompt(ctx.pack('demo'), { ttl: '1h' });
    assert.equal(p.system.length, 2);
    assert.deepEqual(p.system.map((b) => b.cache), ['1h', '1h']);
    assert.match(p.system[1].text, /remove the number, or cite \(in facts\) a listed fact whose quote holds it/);
    assert.deepEqual(REPAIR_SCHEMA.properties.repairs.items.required, ['target', 'text', 'title', 'body', 'a', 'b', 'facts']);
  } finally {
    cleanup();
  }
});

test('a slide refused by the fact gate is repaired in place; a repair that swaps the number is refused and told why', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const w = writer(
      ctx,
      (d) => (d.slides[1].body = JUNE.body.replace('3 גבעולים', '4 גבעולים')),
      [() => [slide('slide 2', { ...JUNE, body: JUNE.body.replace('3 גבעולים', '7 גבעולים') })], () => [slide('slide 2', JUNE)]]
    );
    const res = await build(ctx, w.llm);
    assert.equal(res.status, 'sample', res.reason);
    assert.equal(w.calls.repair, 2);
    // The writer was sent the refused slide alone, with the gate's own words, and the second time why it was refused.
    assert.match(w.calls.users[0], /\[slide 2\] role: beat/);
    assert.match(w.calls.users[0], /REFUSED BY THE CHECKS: slide 2: the number 4 is not in the quotes it cites/);
    assert.doesNotMatch(w.calls.users[0], /\[slide 1\]|\[caption\]/);
    assert.match(w.calls.users[1], /REFUSED AGAIN: states 7, which no quote it cites holds/);
    const rounds = stepsOf(ctx, res.postId, 'repair');
    assert.deepEqual(rounds.map((r) => r.status), ['failed', 'ok']);
    assert.equal(rounds[1].kept[0].target, 'slide 2');
    // Mended, not drafted again: no redraft of the whole post.
    assert.equal(stepsOf(ctx, res.postId, 'redraft').length, 0);
    assert.match(ctx.db.get('SELECT body FROM slides WHERE post_id = ? AND idx = 2', res.postId).body, /3 גבעולים/);
    // Each repair call is recorded like any other call.
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM spend WHERE post_id = ? AND tag = 'repair'", res.postId).n, 2);
  } finally {
    cleanup();
  }
});

test('a graphic that draws a number its slide\'s quotes do not hold is dropped when the writer cannot mend it', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const stat = { type: 'stat', title: '', a: '', b: '', style: '', items: [{ label: 'גבעולים ירוקים', value: '90', value2: '', sub: '' }] };
    // The writer is not shown the graphic: it sends the slide back as it was.
    const w = writer(ctx, (d) => (d.slides[1].visual = stat), [() => [slide('slide 2', JUNE)]]);
    const res = await build(ctx, w.llm);
    assert.equal(res.status, 'sample', res.reason);
    assert.equal(w.calls.repair, 1);
    const [round] = stepsOf(ctx, res.postId, 'repair');
    assert.deepEqual(round.visualsDropped, ['slide 2']);
    assert.doesNotMatch(ctx.db.get('SELECT data_json FROM slides WHERE post_id = ? AND idx = 2', res.postId).data_json || '', /"90"/);
  } finally {
    cleanup();
  }
});

test('a caption in one paragraph and a title over its length are repaired together, in one call', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const long = 'מה חיכה להם ביוני כשהם חזרו למשרד אחרי שלושה חודשים ארוכים של שיפוץ ושקט מוחלט';
    const w = writer(
      ctx,
      (d) => {
        d.slides[1].title = long;
        d.caption = Object.values(d.story).join(' ');
        delete d.story;
      },
      [(user) => {
        assert.match(user, /\[caption\]/);
        assert.match(user, /\[slide 2\]/);
        return [slide('slide 2', JUNE), { target: 'caption', text: `${Object.values(STORY).join('\n')} יש לכם צמח שכמעט ויתרתם עליו?`, title: '', body: '', a: '', b: '', facts: [] }];
      }]
    );
    const res = await build(ctx, w.llm);
    assert.equal(res.status, 'sample', res.reason);
    assert.equal(w.calls.repair, 1);
    assert.equal(ctx.db.get('SELECT caption FROM posts WHERE id = ?', res.postId).caption.split('\n\n').length, 4);
  } finally {
    cleanup();
  }
});

test('a repair is tried twice at most, then the post is blocked and says so; a problem no text owns is never sent', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const same = () => [slide('slide 2', { ...JUNE, body: JUNE.body.replace('3 גבעולים', '4 גבעולים') })];
    const w = writer(ctx, (d) => (d.slides[1].body = JUNE.body.replace('3 גבעולים', '4 גבעולים')), [same, same, same]);
    const res = await build(ctx, w.llm);
    assert.equal(res.status, 'blocked');
    assert.equal(w.calls.repair, REPAIR_ATTEMPTS);
    assert.match(res.reason, /the number 4 is not in the quotes it cites \(אחרי 2 תיקונים\)/);
    assert.equal(res.kind, 'fact_check');

    // Slides out of the outline's order: the post's redraft, not a repair (and the recorded writer has none).
    ctx.db.run('DELETE FROM posts');
    const w2 = writer(ctx, (d) => (d.slides[4].role = 'beat'), [same]);
    const res2 = await build(ctx, w2.llm);
    assert.equal(res2.status, 'blocked');
    assert.equal(w2.calls.repair, 0);
  } finally {
    cleanup();
  }
});

test('a number written in words is the number it means, on the slide and in the quote', () => {
  const n = (t, o = { hebrew: true }) => [...numbersIn(t, o)];
  assert.deepEqual(n('עשרים ושלושה שערים'), ['23']);
  assert.deepEqual(n('מאה שבעים וחמישה שערים בפרמייר ליג'), ['175']);
  assert.deepEqual(n('מאה ושבעים וחמישה'), ['175']);
  assert.deepEqual(n('שלוש עשרה עונות, אחד עשר שחקנים, שנים עשר'), ['13', '11', '12']);
  assert.deepEqual(n('שלושת אלפים ומאתיים וחמישים'), ['3250']);
  assert.deepEqual(n('עשרים ושתיים'), ['22']);
  assert.deepEqual(n('זכה בה פעמיים'), ['2']);
  assert.deepEqual(n('twenty-three goals, one hundred and seventy-five, twice', { words: true }), ['23', '175', '2']);
  // Two numbers in a row are two numbers, a one or a two alone is none (years, not two); a plural with no number
  // is no number; a century is not 100.
  assert.deepEqual(n('עשרים ושלושים'), ['20', '30']);
  assert.deepEqual(n('ארבע שנים, שלוש שנים ושני חודשים'), ['4', '3']);
  assert.deepEqual(n('מאות אוהדים ואלפים בבית'), []);
  assert.deepEqual(n('במאה ה-20'), ['20']);
  // A unit after digits is those digits' (the ranking's question), not a number of its own.
  assert.deepEqual(n('25 מיליון דולר ו-3 אלף'), ['25', '3']);
  // What was never a number still is not.
  assert.deepEqual(n('אחד השחקנים, ביום שני, בבאר שבע'), []);

  // Henry and Salah: a slide that writes the quote's number in words passes the gate; a different number does not.
  const facts = [
    { key: 'f1', quote: 'Henry scored 175 Premier League goals for Arsenal.', verified: true },
    { key: 'f2', quote: 'Salah won the Golden Boot twenty-three goals ahead of the rest.', verified: true },
  ];
  const cover = { kind: 'cover', title: '', body: '', factKeys: [] };
  const ok = gate({ slides: [cover, { kind: 'item', title: 'מאה שבעים וחמישה שערים', body: 'של הנרי בארסנל', factKeys: ['f1'] }, { kind: 'item', title: '23 שערים', body: 'ונעל הזהב של סלאח', factKeys: ['f2'] }], facts });
  assert.equal(ok.ok, true, ok.problems.join('; '));
  const off = gate({ slides: [cover, { kind: 'item', title: 'מאה שבעים ושישה שערים', body: '', factKeys: ['f1'] }], facts });
  assert.match(off.problems.join(), /the number 176 is not in the quotes it cites/);
});

test('a fact whose claim writes the quote\'s number in words verifies', () => {
  const db = new Db(':memory:');
  opened.push(db);
  const at = new Date().toISOString();
  db.insert('accounts', { id: 'demo', display_name: 'd', handle: 'd', created_at: at, updated_at: at });
  const src = db.insert('sources', { account_id: 'demo', key: 's', type: 'web', url: 'https://www.example.com/', name: 'Example', status: 'approved', origin: 'pack', created_at: at });
  const doc = db.insert('documents', { source_id: src, url: 'https://www.example.com/henry', text: 'Thierry Henry scored 175 Premier League goals for Arsenal between 1999 and 2007.', sha256: 'h', fetched_at: at });
  const v = verifyFact(db, { claim: 'הנרי כבש מאה שבעים וחמישה שערים בפרמייר ליג', quote: 'Thierry Henry scored 175 Premier League goals for Arsenal', document_id: doc }, { accountId: 'demo' });
  assert.equal(v.ok, true, v.error);
  const w = verifyFact(db, { claim: 'הנרי כבש מאה שמונים שערים', quote: 'Thierry Henry scored 175 Premier League goals for Arsenal', document_id: doc }, { accountId: 'demo' });
  assert.match(w.error, /states 180/);
});
