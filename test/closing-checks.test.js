import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { documentYears, formatOfPost, gateDraft, buildPost, loadPost, postDraft } from '../src/pipeline/build.js';
import { publishPost, sendDraft } from '../src/publish/index.js';
import { approve, publishNow, retryPublish } from '../src/web/actions.js';
import { tick } from '../src/autonomy/runner.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { postFull } from '../src/web/data.js';
import { postPage } from '../src/web/pages.js';
import { opened, tempHome } from './helpers.js';

// Item 3 of the closing slide (the owner, 2026-11-02): "The checks: a slideshow without a closing slide, or whose
// closing slide doesn't mention the promo, goes through the repair loop and doesn't go out like that. Add a test that
// every format produces one." The writer is stubbed: the demo's recorded answers, with the closing line and the repair
// answers set here. New code is loaded inside the tests, so that before it existed each test failed on its own.

after(() => closeBrowser());
afterEach(() => setNow(null));

const STORE = { name: 'עציץ ושמש', promise: 'צמחי בית ועציצים עם משלוח עד הבית' };
const PRODUCT = { ...STORE, target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://atzitz.example/zz-plant' } };
const GOOD = 'לחדר בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה';
const NEITHER = 'לחדר בלי חלון יש לנו בדיוק את הצמח שמתאים';
const BANNED = 'הזמיוקולקס בעציץ קרמיקה הכי טוב, רק היום';
const SAFE = 'זמיוקולקס בעציץ קרמיקה אצל עציץ ושמש';
const owner = { id: 1, name: 'owner' };
const tuesday = (hhmm) => israelInstant('2026-10-13', hhmm).getTime();

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

/**
 * The demo's recorded writer, with the closing line of its slides answer set by `line(n)` (undefined: the answer has
 * no closing field at all), and each repair call answered for the closing slide by `repairs[k]` ("" or past the end:
 * an answer that repairs nothing). Counts the repair calls and keeps their requests.
 */
const writer = (ctx, { line = () => GOOD, repairs = [] } = {}) => {
  const calls = { repair: 0, users: [], slides: 0 };
  return {
    calls,
    llm: {
      ...ctx.llm,
      async json(req) {
        if (req.task === 'repair') {
          calls.users.push(req.user);
          const text = repairs[calls.repair++];
          return { data: { repairs: text ? [{ target: 'closing', text, title: '', body: '', a: '', b: '', facts: [] }] : [] }, usage: null, model: req.model, estimated: true };
        }
        const r = await ctx.llm.json(req);
        if (req.task !== 'slides') return r;
        const data = structuredClone(r.data);
        const l = line(calls.slides++);
        if (l === undefined) delete data.closing;
        else data.closing = { line: l };
        return { ...r, data };
      },
    },
  };
};

const stepsOf = (db, postId, name) => db.all('SELECT status, detail_json FROM steps WHERE post_id = ? AND step = ? ORDER BY id', postId, name).map((s) => ({ status: s.status, ...JSON.parse(s.detail_json || '{}') }));

test('every format of the demo pack ends on a closing slide on both platforms, the account with a promo and without', { timeout: 900_000 }, async () => {
  const { closingRecheck } = await import('../src/publish/index.js');
  assert.equal(typeof closingRecheck, 'function', 'the check before publishing knows the closing slide');
  for (const promo of [PRODUCT, null]) {
    const { home, cleanup } = tempHome({ packs: { demo: (f) => promo && (f.pack.promo = promo) } });
    try {
      const ctx = contextFor(home);
      const pack = ctx.pack('demo');
      // Every format id the pack has, so a format added later is built here too.
      const ids = pack.formats.formats.map((f) => f.id);
      assert.ok(ids.length >= 14);
      for (const [i, formatKey] of ids.entries()) {
        // In turn: the writer's line passes; it breaks a rule and the repair mends it; the answer has no line at all and
        // the repair mends it.
        const which = i % 3;
        const ok = promo ? GOOD : 'עוד צמחים שמחזיקים מעמד בדירה קטנה, בפוסטים הבאים';
        const { llm } = writer(ctx, { line: () => (which === 0 ? ok : which === 1 ? BANNED : undefined), repairs: [ok, ok] });
        const kind = pack.formats.formats[i].kind;
        const res = await buildPost({ ...ctx, llm }, { pack, formatKey, day: kind === 'on-this-day' ? '2026-10-14' : null });
        assert.equal(res.status, 'queued', `${formatKey}: ${res.reason}`);
        const post = loadPost(ctx.db, res.postId);
        const c = post.data.closing;
        assert.ok(c?.line && c.actions?.tiktok && c.actions?.instagram && c.actions?.facebook, `${formatKey}: a closing slide with its line and an action on every platform`);
        assert.equal(c.kind, promo ? 'product' : 'follow');
        assert.equal(c.line, ok, `${formatKey}: the line that passed`);
        assert.equal(c.by, which === 0 ? 'writer' : 'repair', formatKey);
        for (const p of ['tiktok', 'instagram']) {
          assert.equal(post.media[p].length, post.slides.length + 1, `${formatKey}: the closing slide last on ${p}`);
          assert.ok(existsSync(post.media[p].at(-1)));
        }
        assert.deepEqual(closingRecheck(post, pack), [], `${formatKey}: the stored post passes the check before publishing`);
      }
    } finally {
      cleanup();
    }
  }
});

/** One sample post of the story format, with the account's promo and the writer above. */
async function story(promo, w) {
  const { home, cleanup } = tempHome({ packs: { demo: (f) => promo && (f.pack.promo = promo) } });
  const ctx = contextFor(home);
  const { calls, llm } = writer(ctx, w);
  const res = await buildPost({ ...ctx, llm }, { pack: ctx.pack('demo'), formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });
  return { ctx, res, calls, cleanup };
}

test('a closing line that is missing, names neither the product nor the store, or breaks a rule goes to the repair and comes out fixed', { timeout: 300_000 }, async () => {
  for (const [what, line, rule] of [
    ['no line at all', () => undefined, /closing slide has no line/],
    ['an empty line', () => '', /closing slide has no line/],
    ['a line that names neither', () => NEITHER, /names the product/],
    ['a banned line', () => BANNED, /claim the store did not make|urgency/],
  ]) {
    const { ctx, res, calls, cleanup } = await story(PRODUCT, { line, repairs: [GOOD] });
    try {
      assert.equal(res.status, 'sample', `${what}: ${res.reason}`);
      const c = loadPost(ctx.db, res.postId).data.closing;
      assert.deepEqual([c.line, c.by], [GOOD, 'repair'], what);
      assert.equal(calls.repair, 1, `${what}: one repair call`);
      // The repair is told the line, the rule it broke, the post's topic and the promo, like any repaired text.
      const asked = calls.users[0];
      assert.match(asked, /\[closing\]/, what);
      assert.match(asked, rule, what);
      assert.match(asked, /TOPIC: /);
      assert.match(asked, /CLOSING SLIDE/);
      for (const s of ['זמיוקולקס בעציץ קרמיקה', 'עציץ ושמש', '"הלינק בביו"']) assert.ok(asked.includes(s), `${what}: the repair is told ${s}`);
      const [rep] = stepsOf(ctx.db, res.postId, 'repair');
      assert.deepEqual(rep.targets, ['closing']);
      assert.deepEqual(rep.kept.map((k) => k.target), ['closing']);
      const [cl] = stepsOf(ctx.db, res.postId, 'closing');
      assert.equal(cl.by, 'repair');
      assert.match(cl.broke.join(' '), rule, `${what}: the trace keeps what the writer's line broke`);
      // The owner reads it on the post's page, in developer mode (the steps are its since the audit of 2026-11-12): the
      // closing slide's step, whose line it is now, and the line.
      const page = postPage({ csrf: 'x', dev: true }, postFull(ctx, res.postId));
      assert.match(page, /השקף האחרון[\s\S]*הבדיקה עצרה את השורה הראשונה, וזו נכתבה בתיקון/);
      assert.ok(page.includes(GOOD), 'and the line itself');
    } finally {
      cleanup();
    }
  }
});

test('a repair that fails twice ends on the promo\'s own words; with none that passes, the post is blocked and said', { timeout: 300_000 }, async () => {
  // Two tries, both still banned: the promo's own words, checked by the same rules, and the trace says so.
  let s = await story(PRODUCT, { line: () => BANNED, repairs: [BANNED, NEITHER] });
  try {
    assert.equal(s.res.status, 'sample', s.res.reason);
    assert.equal(s.calls.repair, 2, 'at most two repairs (REPAIR_ATTEMPTS)');
    const c = loadPost(s.ctx.db, s.res.postId).data.closing;
    assert.deepEqual([c.line, c.by], [SAFE, 'safe']);
    const [cl] = stepsOf(s.ctx.db, s.res.postId, 'closing');
    assert.equal(cl.by, 'safe');
    assert.equal(cl.repairs, 2);
    assert.match(postPage({ csrf: 'x', dev: true }, postFull(s.ctx, s.res.postId)), /הבדיקה עצרה את השורה גם אחרי התיקונים, ובמקומה שורה מהפרטים של החשבון/);
  } finally {
    s.cleanup();
  }
  // A promo whose own words break the rules too (a store's name is its own and passes the word lists, but a fake badge
  // breaks honesty wherever it stands): no line can pass, and the post is blocked, never queued.
  const loud = { name: 'מספר 1 בישראל', promise: 'הצמחים הכי טובים בארץ, רק היום', target: { kind: 'product', name: 'צמח מספר 1 בישראל', url: 'https://atzitz.example/sale' } };
  s = await story(loud, { line: () => BANNED, repairs: [BANNED, BANNED] });
  try {
    assert.equal(s.res.status, 'blocked');
    assert.equal(s.res.kind, 'shape');
    assert.match(s.res.reason, /closing/);
    const post = loadPost(s.ctx.db, s.res.postId);
    assert.equal(post.slides.length, 0, 'nothing stored to publish');
    assert.ok(!post.media?.tiktok, 'nothing drawn');
    const [cl] = stepsOf(s.ctx.db, s.res.postId, 'closing');
    assert.equal(cl.status, 'failed');
  } finally {
    s.cleanup();
  }
});

/** A queued post of the care guide (no Shabbat, no review hold), its slot Tuesday 12:45, on an account in draft-now. */
async function queued(promo) {
  const { home, cleanup } = tempHome({ packs: { demo: (f) => promo && (f.pack.promo = promo) } });
  const ctx = contextFor(home);
  const pack = ctx.pack('demo');
  delete pack.meta.zernio.tiktokMode;
  const { llm } = writer(ctx, { line: () => (promo ? GOOD : 'עוד צמחים שמחזיקים מעמד בדירה קטנה, בפוסטים הבאים') });
  const res = await buildPost({ ...ctx, llm }, { pack, formatKey: 'care-guide' });
  assert.equal(res.status, 'queued', res.reason);
  ctx.db.update('posts', res.postId, { slot_at: new Date(tuesday('12:45')).toISOString() });
  return { ctx, db: ctx.db, id: res.postId, pack, cleanup };
}

/**
 * The stored post's closing slide broken in one way, and the post signed again as it now reads: what an older post, a
 * hand edit or a slipped check would leave. The fact gate still holds, so only the closing slide's check can stop it.
 */
function breakClosing(db, pack, id, how) {
  const post = loadPost(db, id);
  const data = { ...post.data };
  if (how === 'missing') delete data.closing;
  else if (how === 'neither') data.closing = { ...data.closing, line: NEITHER };
  else if (how === 'banned') data.closing = { ...data.closing, line: BANNED };
  else if (how === 'empty') data.closing = { ...data.closing, line: '' };
  db.update('posts', id, { data_json: data });
  const now = loadPost(db, id);
  const facts = now.facts.map((f) => ({ ...f, verified: Boolean(f.verified) }));
  const token = gateDraft(formatOfPost(db, pack, now), postDraft(now), facts, { allow: documentYears(db, facts) }).token;
  db.update('posts', id, { checks_json: { ...now.checks, token } });
}

const reset = (db, id, status) => db.update('posts', id, { status, reason: null, approved_by: status === 'queued' ? null : 'owner', publish_json: null });

test('a stored post whose closing slide is missing or broken goes out on no path: the check, approve, the TikTok draft, the runner, publish now, publish again', { timeout: 600_000 }, async () => {
  const { closingRecheck } = await import('../src/publish/index.js');
  const { CLOSING_HE } = await import('../src/publish/errors.js');
  assert.ok(CLOSING_HE, 'the customer is told why in Hebrew');
  for (const how of ['missing', 'empty', 'neither', 'banned', 'promo changed']) {
    const q = await queued(PRODUCT);
    const { ctx, db, id, pack } = q;
    try {
      assert.deepEqual(closingRecheck(loadPost(db, id), pack), [], 'the post as made passes');
      if (how === 'promo changed') pack.meta.promo = { ...PRODUCT, target: { kind: 'product', name: 'סנסיווריה גבוהה', url: 'https://atzitz.example/snake' } };
      else breakClosing(db, pack, id, how);
      const problems = closingRecheck(loadPost(db, id), pack);
      assert.ok(problems.length, `${how}: the check before publishing refuses it`);
      const blocked = (where) => {
        const p = loadPost(db, id);
        assert.equal(p.status, 'blocked', `${how}, ${where}: blocked`);
        assert.equal(p.reason, CLOSING_HE, `${how}, ${where}: the reason in Hebrew`);
        assert.ok(!p.publish?.tiktok && !p.publish?.instagram, `${how}, ${where}: nothing sent`);
        assert.ok(stepsOf(db, id, 'closing').some((s) => s.status === 'failed' && s.problems?.length), `${how}, ${where}: the trace says what failed`);
        // A customer reads the reason on the post's page, in Hebrew; in developer mode the trace's step says the closing
        // slide stopped it.
        const page = postPage({ csrf: 'x' }, postFull(ctx, id));
        assert.ok(page.includes(CLOSING_HE), `${how}, ${where}: the page says why`);
        assert.match(postPage({ csrf: 'x', dev: true }, postFull(ctx, id)), /השקף האחרון לא עבר את הבדיקה, ולכן המצגת לא תעלה/);
      };
      // Approve, on an account whose TikTok draft goes at the approval.
      setNow(tuesday('09:00'));
      assert.throws(() => approve(ctx, owner, { id }), (e) => e.message === CLOSING_HE, `${how}: approve refuses`);
      blocked('approve');
      // The TikTok draft of a post someone approved before.
      reset(db, id, 'approved');
      assert.equal((await sendDraft(ctx, id, { t: tuesday('09:00') })).state, 'blocked', `${how}: no TikTok draft`);
      blocked('the TikTok draft');
      // The runner at the slot (drafting off for the tick: it is the send that is tested).
      reset(db, id, 'approved');
      const r = await tick({ ...ctx, generating: true }, { t: tuesday('12:46') });
      assert.ok(!r.published.some((x) => x.post === id && x.ok), `${how}: the runner does not publish it`);
      blocked('the runner');
      // Publish now.
      reset(db, id, 'approved');
      await assert.rejects(publishNow(ctx, owner, { id }), (e) => e.message === CLOSING_HE, `${how}: publish now refuses`);
      blocked('publish now');
      // Publish again, after a failed send.
      reset(db, id, 'failed');
      await assert.rejects(retryPublish(ctx, owner, { id }), (e) => e.message === CLOSING_HE, `${how}: publish again refuses`);
      blocked('publish again');
    } finally {
      q.cleanup();
    }
  }
});

test('an account with no promo passes every path with its follow line', { timeout: 300_000 }, async () => {
  const { closingRecheck } = await import('../src/publish/index.js');
  const q = await queued(null);
  try {
    const { ctx, db, id, pack } = q;
    const post = loadPost(db, id);
    assert.equal(post.data.closing.kind, 'follow');
    assert.equal(post.data.closing.actions.tiktok.text, 'תעקבו אחרי @demo.atzitz');
    assert.deepEqual(closingRecheck(post, pack), []);
    setNow(tuesday('09:00'));
    const a = approve(ctx, owner, { id });
    assert.equal((await a.job).state, 'drafted', 'the TikTok draft goes');
    const p = await publishPost(ctx, id, { t: tuesday('12:45') });
    assert.ok(p.ok);
    assert.equal(loadPost(db, id).status, 'published');
  } finally {
    q.cleanup();
  }
});

test("the draft-fallback's direct send, an hour after the slot, checks the closing slide again: Settings changed, it stops", { timeout: 300_000 }, async () => {
  const { watchDrafts } = await import('../src/publish/draft.js');
  const q = await queued(PRODUCT);
  try {
    const { ctx, db, id, pack } = q;
    pack.meta.zernio.tiktokMode = 'draft-fallback';
    db.update('posts', id, { status: 'approved', approved_by: 'owner' });
    await publishPost(ctx, id, { t: tuesday('12:45') });
    assert.equal(loadPost(db, id).publish.tiktok.flow.state, 'waiting', 'the draft went at the slot');
    // The customer points the closing slide at another product before the hour is up.
    pack.meta.promo = { ...PRODUCT, target: { kind: 'product', name: 'סנסיווריה גבוהה', url: 'https://atzitz.example/snake' } };
    const none = async () => [];
    await watchDrafts(ctx, { t: tuesday('13:16'), list: none });
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:46'), list: none }), [{ post: id, state: 'stopped' }]);
    const tk = loadPost(db, id).publish.tiktok;
    assert.equal(tk.flow.state, 'stopped');
    assert.match(tk.flow.error, /השקף האחרון/);
    assert.ok(!existsSync(path.join(tk.path, 'zernio-request.tiktok.fallback.json')), 'nothing published directly');
  } finally {
    q.cleanup();
  }
});

test('the closing slide is a repair target of its own: whatever rule its line broke, its line alone is mended', async () => {
  const { applyRepair, repairPlan, targetsOf } = await import('../src/pipeline/repair.js');
  const { closingFrom, closingProblems } = await import('../src/pipeline/closing.js');
  const pack = { meta: { handle: 'demo.atzitz', promo: PRODUCT }, rules: {} };
  const draft = { hook: 'x', slides: [{ kind: 'cover' }, { kind: 'item', title: 'א', body: 'ב', factKeys: [] }], closing: closingFrom(pack, NEITHER) };
  const [p] = closingProblems(draft.closing, { pack });
  assert.match(p.msg, /names the product/);
  assert.deepEqual(targetsOf(draft, p), ['closing']);
  // An honesty problem of the closing line is still its line's (the line is the writer's only text there).
  assert.deepEqual(targetsOf(draft, { where: 'closing', code: 'closing', msg: 'claims an experience nobody had' }), ['closing']);
  const plan = repairPlan(draft, [p, { where: 'slide 1 title', code: 'length', msg: 'the title is over 70 characters' }]);
  assert.deepEqual([...plan.targets.keys()], ['closing', 'slide 1']);
  const fixed = applyRepair(draft, 'closing', { text: 'לחדר בלי חלון —\nיש אצלנו זמיוקולקס בעציץ קרמיקה' }, { facts: [] });
  assert.equal(fixed.draft.closing.line, 'לחדר בלי חלון, יש אצלנו זמיוקולקס בעציץ קרמיקה');
  assert.equal(fixed.draft.closing.by, 'repair');
  assert.deepEqual(fixed.draft.closing.actions, draft.closing.actions, 'the action stays the code\'s');
  assert.deepEqual(closingProblems(fixed.draft.closing, { pack }), []);
  assert.equal(draft.closing.line, NEITHER, 'the draft it was given is not changed');
  assert.match(applyRepair(draft, 'closing', { text: '' }, { facts: [] }).refused, /empty/);
  // No closing slide at all, or one with an action missing, fails the check too.
  assert.match(closingProblems(null, { pack })[0].msg, /no closing slide/);
  const noIg = { ...draft.closing, line: GOOD, actions: { ...draft.closing.actions, instagram: null } };
  assert.match(closingProblems(noIg, { pack }).map((x) => x.msg).join(' '), /no action for instagram/);
});
