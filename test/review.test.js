import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { recordedClient } from '../src/llm/recorded.js';
import { closeBrowser } from '../src/render/render.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// The second look reads the post as a skeptical Israeli would and scores each
// text 0 (person) to 10 (bot), on the cheapest model, and only scores. Anything
// at 4 or more is rewritten in one more call by the drafting model, only then,
// and the rewrite replaces the original only if it passes every check the
// original had to pass.

after(() => closeBrowser());

function withReviewer(home, review, rewrite = () => ({ rewrites: [] }), calls = []) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  const recorded = recordedClient();
  // Drafting answers from the recordings; the review answers as a live reviewer would.
  ctx.llm = {
    kind: 'claude',
    json: async (req) => {
      calls.push({ task: req.task, model: req.model });
      if (req.task === 'review') return { data: review(req), usage: { input_tokens: 3000, output_tokens: 600 }, model: req.model };
      if (req.task === 'rewrite') return { data: rewrite(req), usage: { input_tokens: 4000, output_tokens: 300 }, model: req.model };
      return recorded.json(req);
    },
  };
  return ctx;
}

test('a text scored 4 or more is rewritten, and the rewrite is kept when it passes every check', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const calls = [];
    let reviews = 0;
    const ctx = withReviewer(
      home,
      // The first look flags the cover; the second reads the rewrite as a person's.
      () => ({ reviews: [{ index: 0, botScore: reviews++ ? 2 : 7, tells: ['too polished'], factProblem: '' }] }),
      () => ({ rewrites: [{ index: 0, text: '5 דברים שהבזיליקום במרפסת צריך מכם כדי לשרוד!' }] }),
      calls
    );
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    const post = loadPost(ctx.db, res.postId);
    assert.equal(post.hook, '5 דברים שהבזיליקום במרפסת\nצריך מכם כדי לשרוד.', 'the rewrite is kept, its exclamation mark fixed and its line broken in code');
    assert.equal(post.checks.rewrites.length, 1);
    assert.equal(post.review_score, 2, 'the score is the rewrite measured again, not 3 put down unread');
    assert.deepEqual(calls.filter((c) => c.task === 'review').length, 2, 'the rewritten text is scored again');
    assert.equal(post.checks.reviewer, 'claude');
    assert.equal(calls.find((c) => c.task === 'review').model, 'claude-sonnet-5-5', 'the review runs on Sonnet: Haiku was measured and missed what it is for');
    assert.equal(calls.find((c) => c.task === 'rewrite').model, 'claude-sonnet-5-5', 'the rewrite on the drafting model');
  } finally {
    cleanup();
  }
});

test('a post the reviewer does not flag costs one cheap review call and no rewrite', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const calls = [];
    const ctx = withReviewer(home, (req) => ({ reviews: [...req.user.matchAll(/^\[(\d+)\]/gm)].map((m) => ({ index: Number(m[1]), botScore: 2, tells: [], factProblem: '' })) }), undefined, calls);
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    assert.deepEqual(calls.map((c) => c.task), ['outline', 'details', 'slides', 'review']);
  } finally {
    cleanup();
  }
});

test('a rewrite that invents a number is thrown away, and a text still scored 9 blocks the post', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const ctx = withReviewer(
      home,
      () => ({ reviews: [{ index: 0, botScore: 9, tells: ['brochure tone'], factProblem: '' }] }),
      () => ({ rewrites: [{ index: 0, text: 'בזיליקום במרפסת: 9 דברים שהוא צריך מכם' }] })
    );
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.equal(res.status, 'blocked');
    assert.equal(res.kind, 'voice');
    assert.match(res.reason, /בוט/);
  } finally {
    cleanup();
  }
});

test('a text the reviewer says goes beyond its facts is rewritten with the problem named, or the post is blocked', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    let rewriteUser = '';
    const ctx = withReviewer(
      home,
      (req) => ({ reviews: [...req.user.matchAll(/^\[(\d+)\]/gm)].map((m) => ({ index: Number(m[1]), botScore: 1, tells: [], factProblem: m[1] === '2' ? 'the facts do not say it grows all year' : '' })) }),
      (req) => ((rewriteUser = req.user), { rewrites: [] })
    );
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.match(rewriteUser, /FACT PROBLEM: the facts do not say it grows all year/, 'the rewriter is told what is wrong');
    assert.equal(res.status, 'blocked', 'not fixed: blocked');
    assert.equal(res.kind, 'review', 'a review block does not pause the account');
    assert.match(res.reason, /יותר מהעובדות/);
  } finally {
    cleanup();
  }
});

test('a text the reviewer still scores 7 after its rewrite is not thrown away: the post waits for the owner with its score', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const ctx = withReviewer(
      home,
      () => ({ reviews: [{ index: 0, botScore: 7, tells: ['too polished'], factProblem: '' }] }),
      () => ({ rewrites: [{ index: 0, text: '5 דברים שהבזיליקום במרפסת צריך מכם כדי לשרוד' }] })
    );
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    const { REWRITE_AT } = await import('../src/voice/review.js');
    assert.ok(ctx.db.get('SELECT review_score FROM posts WHERE id = ?', res.postId).review_score >= REWRITE_AT, 'held for the owner in every mode');
  } finally {
    cleanup();
  }
});

test('a generic closing question is dropped in code, and a question already in the caption is not asked twice', async () => {
  const { joinCaption } = await import('../src/pipeline/build.js');
  assert.equal(joinCaption('הבזיליקום אוהב שמש.', 'ידעתם את זה?'), 'הבזיליקום אוהב שמש.');
  assert.equal(joinCaption('הבזיליקום אוהב שמש. כבר ניסיתם?', 'כבר ניסיתם?'), 'הבזיליקום אוהב שמש. כבר ניסיתם?');
  assert.equal(joinCaption('הבזיליקום אוהב שמש.', 'איזה צמח הכי קשה לכם לשמור בחיים?'), 'הבזיליקום אוהב שמש. איזה צמח הכי קשה לכם לשמור בחיים?');
  // A caption with no full stop of its own does not run into the question.
  assert.equal(joinCaption('Air Canada ניסתה להתנער ממנו', 'הייתם סומכים על צ׳טבוט?'), 'Air Canada ניסתה להתנער ממנו. הייתם סומכים על צ׳טבוט?');
});

test('a rewritten text is scored again as it now reads, and one that still reads as a bot blocks the post', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const seen = [];
    const ctx = withReviewer(
      home,
      (req) => (seen.push(req.user), { reviews: [{ index: 0, botScore: 9, tells: ['too polished'], factProblem: '' }] }),
      () => ({ rewrites: [{ index: 0, text: '5 דברים שהבזיליקום במרפסת צריך מכם כדי לשרוד' }] })
    );
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    assert.equal(seen.length, 2);
    assert.match(seen[1], /^\[0\] \(cover[^)]*\) 5 דברים שהבזיליקום במרפסת/m, 'the second look reads the rewrite alone');
    assert.equal(res.status, 'blocked');
    assert.equal(res.kind, 'voice');
    assert.match(res.reason, /נשמע כמו בוט \(9\/10\) גם אחרי שכתוב/);
  } finally {
    cleanup();
  }
});

test("a fact note that clears itself is no fact problem; one that names a wrong fact still is", async () => {
  const { CLEARED } = await import('../src/voice/review.js');
  assert.ok(CLEARED.test('The text ties the term to AI code, while it means not checking it - minor. No real unsupported claim.'));
  assert.ok(CLEARED.test('This is not a problem.'));
  assert.ok(!CLEARED.test('The source says it was the first final since 1985, not the first win.'));
  assert.ok(!CLEARED.test('The caption names three of the six players as if they were all of them.'));
});
