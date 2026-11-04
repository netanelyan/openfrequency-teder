import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { closingFrom, closingProblems } from '../src/pipeline/closing.js';
import { BOXES, latestFeedback, morningFeedback, withDirectives } from '../src/metrics/feedback.js';
import { closingRecheck } from '../src/publish/index.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { postFull } from '../src/web/data.js';
import { feedbackPanels, postPage } from '../src/web/pages.js';
import { opened, tempHome } from './helpers.js';

// Item 6 of the closing slide (the owner, 2026-11-04): "Feedback: the morning loop that changes the cta keeps working,
// and now changes the text of the closing slide." The numbers are the test's own, on posts the test made; the writer is
// stubbed (the demo's recorded answers, with the closing line and the repair answers set here). New code is loaded
// inside the tests, so that before it existed each test failed on its own.

after(() => closeBrowser());

const HOUR = 3_600_000;
const T = israelInstant('2026-10-13', '07:05').getTime();
const PRODUCT = { name: 'עציץ ושמש', promise: 'צמחי בית ועציצים עם משלוח עד הבית', target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://atzitz.example/zz-plant' } };
// The line of the post that many saw and few acted on, and the one that did better on action.
const LOSER = 'לחדר בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה';
const WINNER = 'שוכחים להשקות? זמיוקולקס בעציץ קרמיקה מחכה בסבלנות';
const NEW = 'פוטוס ששרד חודשים? גם זמיוקולקס בעציץ קרמיקה יחזיק אצלכם';
// The promo's own words, in the order the slide takes them (src/pipeline/closing.js safeLines).
const SAFE = ['זמיוקולקס בעציץ קרמיקה אצל עציץ ושמש', 'זמיוקולקס בעציץ קרמיקה. צמחי בית ועציצים עם משלוח עד הבית'];

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

function account() {
  const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = PRODUCT) } });
  const ctx = contextFor(home);
  return { ctx, db: ctx.db, pack: ctx.pack('demo'), cleanup };
}

/** A published post with its closing slide and its readings: [[ageHours, views, engagement]]. */
function seed(db, pack, { id, hoursAgo, line = null, by = 'writer', cta = null, readings }) {
  const at = new Date(T - hoursAgo * HOUR).toISOString();
  const closing = line ? closingFrom(pack, line, by) : undefined;
  db.insert('posts', { id, account_id: 'demo', format_id: 'plant-story', hook: `השער של ${id}`, topic: `topic ${id}`, hook_pattern: 'came-back', status: 'published', data_json: { cta: cta ? { kind: 'send', text: cta } : null, coverVisual: { type: 'stat' }, ...(closing ? { closing } : {}) }, published_at: at, created_at: at, updated_at: at });
  for (const [age, views, eng] of readings) reading(db, id, at, age, views, eng);
}
const reading = (db, id, at, age, views, eng) => db.insert('metrics', { post_id: id, platform: 'tiktok', collected_at: new Date(Date.parse(at) + age * HOUR).toISOString(), age_hours: age, views, likes: eng, comments: 0, shares: 0, saves: null, link_clicks: null });

/**
 * Four earlier posts that reach 1,000 views by a day and a half and 5,000 by two and a half days, at 5% and then 1%
 * action; "pB", a day and a half old, at 3,000 views and 1% (high views, low action), its line LOSER; "pC" at 300 views
 * and 10% (low views, high action), its line WINNER.
 */
function seedBoxes(db, pack, { pBline = LOSER, pBby = 'writer', pCline = WINNER, pCby = 'writer' } = {}) {
  for (const [i, days] of [10, 8, 6, 5].entries()) seed(db, pack, { id: `base${i}`, hoursAgo: days * 24, line: LOSER, readings: [[12, 1000, 50], [36, 1000, 50], [60, 5000, 50], [84, 5000, 50]] });
  seed(db, pack, { id: 'pB', hoursAgo: 36, line: pBline, by: pBby, cta: 'תשלחו למי שוויתר על העציץ שלו', readings: [[36, 3000, 30]] });
  seed(db, pack, { id: 'pC', hoursAgo: 36, line: pCline, by: pCby, cta: 'תשמרו לעונה הבאה', readings: [[36, 300, 30]] });
}

/**
 * The demo's recorded writer, its slides answer given `line`, and each repair call answered by `repairs[k]` ("" or past
 * the end: an answer that repairs nothing). Keeps every request it was sent.
 */
const writer = (ctx, { line, repairs = [] }) => {
  const calls = { slides: [], repair: [] };
  return {
    calls,
    llm: {
      ...ctx.llm,
      async json(req) {
        if (req.task === 'repair') {
          const text = repairs[calls.repair.length];
          calls.repair.push(req.user);
          return { data: { repairs: text ? [{ target: 'closing', text, title: '', body: '', a: '', b: '', facts: [] }] : [] }, usage: null, model: req.model, estimated: true };
        }
        const r = await ctx.llm.json(req);
        if (req.task !== 'slides') return r;
        calls.slides.push(req.user);
        return { ...r, data: { ...structuredClone(r.data), closing: { line } } };
      },
    },
  };
};

const planOf = (db, postId) => db.all("SELECT * FROM directives WHERE post_id = ? AND status = 'open' ORDER BY id", postId).map((d) => ({ id: d.id, box: d.box, ...JSON.parse(d.plan_json) }));
const stepOf = (db, postId, name) => {
  const s = db.get('SELECT status, detail_json FROM steps WHERE post_id = ? AND step = ? ORDER BY id DESC LIMIT 1', postId, name);
  return s ? { status: s.status, ...JSON.parse(s.detail_json || '{}') } : null;
};

test('the morning loop still runs, and its choice moves with the numbers: the line changed after high views and low action, kept after low views and high action', async () => {
  const { closingNote } = await import('../src/pipeline/closing.js');
  assert.equal(typeof closingNote, 'function', 'the loop keeps what a closing line taught');
  const { ctx, db, pack, cleanup } = account();
  try {
    seedBoxes(db, pack);
    const fb = await morningFeedback(ctx, pack, { t: T, pull: false });
    assert.deepEqual(Object.fromEntries(fb.posts.filter((p) => p.box).map((p) => [p.post, p.box])), { pB: 'hl', pC: 'lh' });
    const [b] = planOf(db, 'pB');
    const [c] = planOf(db, 'pC');
    // The format's call to action is still changed and kept, as before.
    assert.equal(b.avoidCta, 'תשלחו למי שוויתר על העציץ שלו');
    assert.equal(c.ctaText, 'תשמרו לעונה הבאה');
    assert.deepEqual([b.steer.kind, c.steer.kind], ['new-cta', 'new-hooks']);
    // And now the closing slide's line, the post's call to action: change pB's, keep pC's way.
    assert.deepEqual([b.closing.line, b.closing.keep, b.closing.hook, b.closing.measure, b.closing.kind, b.closing.product], [LOSER, false, 'השער של pB', 'engagement', 'product', PRODUCT.target.name]);
    assert.deepEqual([c.closing.line, c.closing.keep], [WINNER, true]);
    // Results says what each box changes, in the closing slide's words.
    const html = feedbackPanels(latestFeedback(db, [pack]));
    assert.ok(html.includes(BOXES.hl.todo) && /שורה אחרת בשקף האחרון/.test(BOXES.hl.todo));
    assert.ok(html.includes(BOXES.lh.todo) && /השורה בשקף האחרון באותה דרך/.test(BOXES.lh.todo));

    // A day later pB has kept drawing action while its views stalled under what the account's posts reach by then: the
    // loop changes its mind, and the next post keeps pB's line's way. Yesterday's plan no slot took is replaced.
    reading(db, 'pB', new Date(T - 36 * HOUR).toISOString(), 60, 3200, 400);
    await morningFeedback(ctx, pack, { t: T + 24 * HOUR, pull: false });
    const [again] = planOf(db, 'pB');
    assert.equal(again.box, 'lh');
    assert.deepEqual([again.closing.line, again.closing.keep], [LOSER, true]);
    assert.equal(again.ctaText, 'תשלחו למי שוויתר על העציץ שלו', 'and the format\'s call to action is kept with it');
    assert.equal(db.get("SELECT status FROM directives WHERE id = ?", b.id).status, 'expired');
    // A post made before the closing slide teaches nothing about it, and its plan is as it was.
    db.run("UPDATE posts SET data_json = json_remove(data_json, '$.closing') WHERE id = 'pC'");
    assert.equal(closingNote(loadPost(db, 'pC').data.closing, { keep: true }), null);
  } finally {
    cleanup();
  }
});

test('the next post\'s closing line follows the change: the writer is told, the losing line is refused and repaired, the checks still hold, and the trace says why', { timeout: 300_000 }, async () => {
  const { closingLesson } = await import('../src/pipeline/closing.js');
  assert.equal(typeof closingLesson, 'function');
  const { ctx, db, pack, cleanup } = account();
  try {
    seedBoxes(db, pack);
    await morningFeedback(ctx, pack, { t: T, pull: false });
    // The slot takes pB's plan as the runner gives it out (the winners' plan first, so pC's is set aside here).
    db.run("UPDATE directives SET status = 'expired' WHERE post_id = 'pC'");
    const [slot] = withDirectives(db, pack, [{ slotAt: new Date(T + 5 * HOUR).toISOString() }]);
    assert.equal(slot.directive.box, 'hl');
    // The writer writes the very line that did not lead people on; the repair writes another.
    const w = writer(ctx, { line: LOSER, repairs: [NEW] });
    const res = await buildPost({ ...ctx, llm: w.llm }, { pack, directive: slot.directive });
    assert.equal(res.status, 'queued', res.reason);
    // The writer was told what the morning learned, and what to do with it.
    const asked = w.calls.slides[0];
    assert.match(asked, /CLOSING SLIDE/);
    assert.match(asked, /FROM THE RESULTS: the closing line of "השער של pB" was "[^"]+"\. More people saw that post than usual, but few of them acted on it, so this closing line is written another way/);
    assert.ok(asked.includes(LOSER));
    assert.match(asked, /The call to action is the closing slide's line: CLOSING SLIDE says how it changes/);
    // The check refused the line it asked to change, and the repair was told why.
    assert.equal(w.calls.repair.length, 1);
    assert.match(w.calls.repair[0], /the line the morning's results asked to change/);
    assert.match(w.calls.repair[0], /FROM THE RESULTS: the closing line of/);
    const post = loadPost(db, res.postId);
    const c = post.data.closing;
    assert.deepEqual([c.line, c.by], [NEW, 'repair']);
    // The rules are the same for this line: 60 characters at most, the product named, the action the code's.
    assert.ok([...c.line].length <= 60);
    assert.deepEqual(closingProblems(c, { pack }), []);
    assert.deepEqual(closingRecheck(post, pack), [], 'and it passes the check before any send');
    assert.equal(c.actions.instagram.text, 'באתר atzitz.example/zz-plant');
    assert.equal(c.actions.tiktok.text, 'הלינק בביו');
    // The trace says what the loop chose and why, in plain Hebrew, on the post's page.
    const fb = stepOf(db, res.postId, 'feedback');
    assert.deepEqual([fb.closing.line, fb.closing.keep], [LOSER, false]);
    assert.equal(stepOf(db, res.postId, 'closing').lesson, 'change');
    const page = postPage({ csrf: 'x' }, postFull(ctx, res.postId));
    assert.match(page, /<b>המשוב של הבוקר<\/b>/);
    assert.ok(page.includes(`יותר אנשים מהרגיל ראו את המצגת &quot;השער של pB&quot;, אבל פחות מהם עשו לייק, הגיבו, שיתפו או שמרו. השורה בשקף האחרון שלה הייתה &quot;${LOSER}&quot;, אז כאן בחרנו לכתוב אותה אחרת.`), 'why, and what we chose');
    assert.ok(page.includes(BOXES.hl.todo));
  } finally {
    cleanup();
  }
});

test('when the writer cannot get it right, the promo\'s own words follow the loop too: a line to change is skipped, a line to keep comes first', { timeout: 300_000 }, async () => {
  const { closingLesson } = await import('../src/pipeline/closing.js');
  assert.equal(typeof closingLesson, 'function');
  for (const [box, keep, old, want] of [
    // pB closed on the promo's first line and few acted on it: the next post never closes on it again.
    ['hl', false, SAFE[0], SAFE[1]],
    // pC closed on the promo's second line and did well on action: the next post's line of the promo's words is that one.
    ['lh', true, SAFE[1], SAFE[1]],
  ]) {
    const { ctx, db, pack, cleanup } = account();
    try {
      seedBoxes(db, pack, { pBline: old, pBby: 'safe', pCline: old, pCby: 'safe' });
      await morningFeedback(ctx, pack, { t: T, pull: false });
      const [plan] = planOf(db, box === 'hl' ? 'pB' : 'pC');
      assert.deepEqual([plan.box, plan.closing.keep, plan.closing.line], [box, keep, old]);
      // The writer's line names neither, and both repairs fail: the promo's own words are the last step.
      const w = writer(ctx, { line: 'לחדר בלי חלון יש לנו בדיוק את הצמח שמתאים', repairs: [] });
      const res = await buildPost({ ...ctx, llm: w.llm }, { pack, directive: { id: 90, ...plan } });
      assert.equal(res.status, 'queued', res.reason);
      const post = loadPost(db, res.postId);
      assert.deepEqual([post.data.closing.line, post.data.closing.by], [want, 'safe'], `${box}: the promo's own words, as the loop chose`);
      assert.deepEqual(closingRecheck(post, pack), []);
      assert.match(w.calls.slides[0], keep ? /keeps its way: one sentence that ties this post's own topic to "זמיוקולקס בעציץ קרמיקה" as that one did/ : /written another way/);
      const page = postPage({ csrf: 'x' }, postFull(ctx, res.postId));
      assert.ok(page.includes(keep ? 'אז כאן בחרנו לכתוב אותה באותה דרך, על הנושא של המצגת הזו.' : 'אז כאן בחרנו לכתוב אותה אחרת.'), box);
      // Without the lesson the slide would have taken the promo's first line.
      const { closingSlide } = await import('../src/pipeline/closing.js');
      assert.equal(closingSlide(pack, { line: '' }).closing.line, SAFE[0]);
    } finally {
      cleanup();
    }
  }
});

test('a lesson holds only for where the slide sends people now; the request and the check say it in their own words', async () => {
  const { closingLesson, closingNote, closingRequest, safeLines, sameLine, closingBase } = await import('../src/pipeline/closing.js');
  const { ctx, pack, cleanup } = account();
  try {
    const note = closingNote(closingFrom(pack, LOSER), { keep: false, hook: 'h', measure: 'link_clicks' });
    const lesson = closingLesson(note, pack);
    assert.deepEqual(lesson, { line: LOSER, keep: false, hook: 'h', measure: 'link_clicks' });
    // A promo changed since the post was written: the lesson was about another product, and this post has none.
    const other = { ...pack, meta: { ...pack.meta, promo: { ...PRODUCT, target: { kind: 'product', name: 'סנסיווריה גבוהה', url: 'https://atzitz.example/snake' } } } };
    assert.equal(closingLesson(note, other), null);
    assert.equal(closingLesson(null, pack), null);
    // The line to change is refused in any punctuation, and a line to keep is not held to anything more.
    const again = closingFrom(pack, 'לחדר בלי חלון, יש אצלנו זמיוקולקס בעציץ קרמיקה.');
    assert.ok(sameLine(again.line, LOSER));
    assert.match(closingProblems(again, { pack, lesson }).map((p) => p.msg).join(' '), /asked to change/);
    assert.deepEqual(closingProblems(again, { pack, lesson: { ...lesson, keep: true } }), []);
    assert.deepEqual(closingProblems(again, { pack }), [], 'and nothing at all without a lesson, as before any send');
    // The request: "another way" with another shape, or "the same way" with its shape; a follow account by its handle.
    assert.match(closingRequest(pack, { topic: 't', lesson }), /written another way: another tie between this post's topic and "זמיוקולקס בעציץ קרמיקה", a short question and its answer, for one/);
    assert.match(closingRequest(pack, { topic: 't', lesson: { ...lesson, line: WINNER, keep: true } }), /keeps its way: a short question and its answer that ties/);
    assert.doesNotMatch(closingRequest(pack, { topic: 't' }), /FROM THE RESULTS/);
    const follow = { ...pack, meta: { ...pack.meta, promo: null } };
    assert.match(closingRequest(follow, { topic: 't', lesson: { ...lesson, line: 'עוד צמחים בפוסטים הבאים' } }), /following @demo\.atzitz/);
    // The promo's own words: the one to change left out, the one to keep first.
    const base = closingBase(pack);
    assert.deepEqual(safeLines(base, pack).slice(0, 2), SAFE);
    assert.ok(!safeLines(base, pack, { line: SAFE[0], keep: false }).includes(SAFE[0]));
    assert.equal(safeLines(base, pack, { line: SAFE[1], keep: true })[0], SAFE[1]);
    void ctx;
  } finally {
    cleanup();
  }
});
