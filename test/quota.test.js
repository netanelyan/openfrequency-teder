import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost, QuotaError } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { setNow } from '../src/core/clock.js';
import { monthSpend } from '../src/budget/ledger.js';
import { DEFAULT_PLAN, ledger, planOf, room, setPlan, usage } from '../src/budget/quota.js';
import { tick } from '../src/autonomy/runner.js';
import { redoDirective } from '../src/pipeline/redo.js';
import { steerLine } from '../src/pipeline/prompts.js';
import { docKeyOf } from '../src/metrics/feedback.js';
import { recheck } from '../src/publish/index.js';
import { EDIT_CHECKS_PER_DAY, edit, editChecksToday, reject, removeSlide, setQuota, swapPhoto } from '../src/web/actions.js';
import { israelInstant } from '../src/schedule/israel.js';
import { accountRows, postFull, quotasData, week } from '../src/web/data.js';
import { accountsPage, postPage, quotasPanel } from '../src/web/pages.js';
import { opened, tempHome } from './helpers.js';

// A customer's month (src/budget/quota.js): 40 suggested slideshows and 10 redos by default, counted from the posts
// themselves; what our checks block is ours; no money cap anywhere, what the posts cost only recorded; and a new month
// starts every count again.

after(() => closeBrowser());
afterEach(() => {
  setNow(null);
});

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

const OCT = israelInstant('2026-10-13', '09:00').getTime();
const NOV = israelInstant('2026-11-02', '09:00').getTime();
const owner = { id: 1, name: 'owner', operator: true };
const customer = { id: 2, name: 'customer', operator: false };

let n = 0;
/** A post row as the pipeline leaves it. */
const row = (db, patch) => {
  const at = new Date(patch.at ?? OCT).toISOString();
  const id = `q${++n}`;
  db.insert('posts', { id, account_id: 'demo', status: 'queued', created_at: at, updated_at: at, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'at')) });
  return id;
};

test('a suggestion counts once it reaches the customer, whatever they do with it; a blocked post, a sample and an old draft never count', () => {
  const { home, cleanup } = tempHome();
  try {
    const { db } = contextFor(home);
    setNow(OCT);
    for (const status of ['queued', 'approved', 'rejected', 'expired', 'published']) row(db, { status, quota_kind: 'suggestion', quota_month: '2026-10' });
    row(db, { status: 'blocked', quota_kind: 'retry', quota_month: '2026-10' });
    row(db, { status: 'blocked', quota_kind: 'retry', quota_month: '2026-10' });
    row(db, { status: 'sample', sample: 1 });
    row(db, { status: 'queued', quota_kind: 'redo', quota_month: '2026-10', redo_of: 'q1' });
    // Drafts in progress hold a place, a redo's against the redos; one a restart left a day and a half ago does not.
    row(db, { status: 'drafting' });
    row(db, { status: 'drafting', redo_of: 'q3' });
    row(db, { status: 'drafting', at: OCT - 36 * 3_600_000 });
    const u = usage(db, 'demo');
    assert.deepEqual(u.suggested, { used: 5, held: 1, limit: DEFAULT_PLAN.suggested, left: 34 });
    assert.deepEqual(u.redos, { used: 1, held: 1, limit: DEFAULT_PLAN.redos, left: 8 });
    // The default plan, and the operator's own.
    assert.deepEqual([planOf(db, 'demo').suggested, planOf(db, 'demo').redos], [40, 10]);
    assert.deepEqual([setPlan(db, 'demo', { suggested: '6', redos: '2' }).suggested, planOf(db, 'demo').redos], [6, 2]);
    assert.deepEqual(usage(db, 'demo').suggested.left, 0, 'five used and one in progress of six');
    assert.equal(room(db, 'demo').ok, false);
    assert.equal(room(db, 'demo', { redo: true }).ok, false, 'one used and one in progress of two');
    assert.deepEqual(setPlan(db, 'demo', { suggested: '2.5', redos: '-1' }).problems, ['suggested', 'redos']);
    assert.equal(planOf(db, 'demo').suggested, 6, 'a refused plan changes nothing');
    setPlan(db, 'demo', { suggested: '', redos: '' });
    assert.equal(planOf(db, 'demo').suggested, 40, 'an empty field is the default again');
  } finally {
    cleanup();
  }
});

test("a failed post with nothing out is not the customer's to lose; one with a part out counts; a TikTok post drafted in the inbox counts; the same whether the month is the account's or its workspace's", () => {
  const { home, cleanup } = tempHome();
  try {
    const { db } = contextFor(home);
    setNow(OCT);
    const at = new Date(OCT).toISOString();
    row(db, { status: 'published', quota_kind: 'suggestion', quota_month: '2026-10', published_at: at });
    const failed = row(db, { status: 'failed', quota_kind: 'suggestion', quota_month: '2026-10' });
    row(db, { status: 'failed', quota_kind: 'suggestion', quota_month: '2026-10', published_at: at });
    row(db, { status: 'drafted', quota_kind: 'suggestion', quota_month: '2026-10' });
    row(db, { status: 'failed', quota_kind: 'redo', quota_month: '2026-10' });
    const count = () => [usage(db, 'demo').suggested.used, usage(db, 'demo').redos.used];
    assert.deepEqual(count(), [3, 0], 'the one that failed with nothing out, and the failed redo, do not count; the drafted one does');
    // In a workspace, the same predicate over its accounts together.
    db.run("UPDATE accounts SET workspace_id = 6 WHERE id = 'demo'");
    assert.equal(usage(db, 'demo').plan.scope, 'workspace');
    assert.deepEqual(count(), [3, 0]);
    // Sent again and out: it counts again.
    db.update('posts', failed, { status: 'published', published_at: at });
    assert.deepEqual(count(), [4, 0]);
  } finally {
    cleanup();
  }
});

test('a new month starts every count again: suggestions, redos and what the customer\'s posts cost', () => {
  const { home, cleanup } = tempHome();
  try {
    const { db } = contextFor(home);
    setNow(OCT);
    for (let i = 0; i < 40; i++) row(db, { quota_kind: 'suggestion', quota_month: '2026-10' });
    for (let i = 0; i < 10; i++) row(db, { quota_kind: 'redo', quota_month: '2026-10', redo_of: 'q1' });
    db.insert('spend', { account_id: 'demo', api: 'claude', usd: 12, month: '2026-10', at: new Date(OCT).toISOString() });
    let u = usage(db, 'demo');
    assert.equal(u.suggested.left, 0);
    assert.equal(u.redos.left, 0);
    assert.equal(u.cost.spent, 12);
    // October's last evening is still October in Israel; November's first minutes are November.
    const lastMinute = israelInstant('2026-10-31', '23:59').getTime();
    assert.equal(usage(db, 'demo', lastMinute).suggested.left, 0);
    setNow(NOV);
    u = usage(db, 'demo');
    assert.equal(u.month, '2026-11');
    assert.deepEqual([u.suggested.used, u.redos.used, u.cost.spent], [0, 0, 0]);
    assert.equal(room(db, 'demo').ok, true);
    assert.equal(usage(db, 'demo', israelInstant('2026-11-01', '00:01').getTime()).suggested.used, 0);
  } finally {
    cleanup();
  }
});

test('when the month\'s suggestions are used up, nothing is drafted and nothing is spent; a sample is not the customer\'s', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    setPlan(ctx.db, 'demo', { suggested: '0' });
    await assert.rejects(buildPost(ctx, { pack, formatKey: 'care-guide' }), (e) => e instanceof QuotaError && /suggested slideshows are used up \(0 of 0\)/.test(e.message));
    assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM posts').n, 0, 'no post was started');
    assert.equal(monthSpend(ctx.db, 'demo').usd, 0, 'nothing was spent');
    // One left: a queued post is a suggestion of this month, and the next one is refused.
    setPlan(ctx.db, 'demo', { suggested: '1' });
    const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    assert.deepEqual({ ...ctx.db.get('SELECT quota_kind, quota_month FROM posts WHERE id = ?', res.postId) }, { quota_kind: 'suggestion', quota_month: '2026-10' });
    await assert.rejects(buildPost(ctx, { pack, formatKey: 'care-guide' }), QuotaError);
    // An onboarding sample is drafted all the same, and is nobody's suggestion, whatever its checks say.
    const sample = await buildPost(ctx, { pack, formatKey: 'mistakes', sample: true });
    assert.ok(['sample', 'blocked'].includes(sample.status));
    assert.equal(ctx.db.get('SELECT quota_kind FROM posts WHERE id = ?', sample.postId).quota_kind, null);
  } finally {
    cleanup();
  }
});

test('the runner drafts no more than the month has left, and nothing once it is used up, until a raised quota or the next month', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const tuesday = israelInstant('2026-10-13', '07:05').getTime();
    setNow(tuesday);
    // Four slots today and tomorrow, two suggestions left.
    for (let i = 0; i < 38; i++) row(ctx.db, { status: 'published', quota_kind: 'suggestion', quota_month: '2026-10' });
    let r = await tick(ctx, { t: tuesday });
    assert.equal(r.generated.length, 2, JSON.stringify(r.generated));
    assert.ok(r.generated.every((g) => g.status === 'queued'), JSON.stringify(r.generated));
    assert.equal(usage(ctx.db, 'demo').suggested.left, 0);
    // A blocked post would have been ours; here the two reached the customer and the month is used up.
    const wed = israelInstant('2026-10-14', '07:05').getTime();
    setNow(wed);
    r = await tick(ctx, { t: wed });
    assert.equal(r.generated.length, 0);
    assert.deepEqual(r.quotaFull, ['demo']);
    // The operator raises the quota the same morning: the next tick drafts.
    setQuota(ctx, owner, { id: 'demo' }, { suggested: '41' });
    r = await tick(ctx, { t: wed + 60_000 });
    assert.equal(r.generated.length, 1, JSON.stringify(r.generated));
  } finally {
    cleanup();
  }
});

test('no cost cap: a month that has cost $500 still drafts up to its plan, and the operator sets posts, never dollars', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const tuesday = israelInstant('2026-10-13', '07:05').getTime();
    setNow(tuesday);
    ctx.db.insert('spend', { account_id: 'demo', api: 'claude', usd: 500, month: '2026-10', at: new Date(tuesday).toISOString() });
    const r = await tick(ctx, { t: tuesday });
    assert.ok(r.generated.length >= 2, JSON.stringify(r.generated));
    assert.ok(r.generated.every((g) => g.status === 'queued'), JSON.stringify(r.generated));
    assert.equal(ctx.db.get("SELECT status FROM accounts WHERE id = 'demo'").status, 'active', 'money pauses nothing');
    assert.ok(usage(ctx.db, 'demo').cost.spent > 500, 'what the posts cost is recorded on top, for the operator');
    // The plan is posts only: a cap sent with it is not read, and nothing about money is kept.
    const saved = setQuota(ctx, owner, { id: 'demo' }, { suggested: '45', redos: '', cap: '0.01' });
    assert.equal(saved.message, 'נשמר: 45 הצעות ו-10 החלפות בחודש.');
    assert.deepEqual(Object.keys(planOf(ctx.db, 'demo')).sort(), ['name', 'redos', 'scope', 'set', 'suggested', 'workspaceId']);
    assert.equal(planOf(ctx.db, 'demo').scope, 'account', "the operator's own account has a month of its own");
    assert.ok(!ctx.db.all('PRAGMA table_info(accounts)').some((c) => c.name === 'cap_usd'), 'the column is gone');
    // A customer cannot set their own plan.
    assert.throws(() => setQuota(ctx, customer, { id: 'demo' }, { suggested: '100' }), /רק מי שמפעיל את תדר/);
  } finally {
    cleanup();
  }
});

test('a rejection writes a replacement with its reason, counted as a redo and never as a suggestion; when the redos are gone it only discards', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const first = await buildPost(ctx, { pack, formatKey: 'care-guide', slotAt: israelInstant('2026-10-14', '12:45').toISOString() });
    assert.equal(first.status, 'queued', first.reason);
    setPlan(ctx.db, 'demo', { redos: '1' });
    const r = reject(ctx, customer, { id: first.postId }, { reason: 'shorter', note: 'שלוש שורות לכל היותר' });
    assert.match(r.message, /פוסט חלופי נכתב עכשיו/);
    assert.match(r.message, /זו ההחלפה האחרונה של החודש/);
    // Held before the answer went back: a second rejection now would find no redo left.
    assert.deepEqual([usage(ctx.db, 'demo').redos.held, usage(ctx.db, 'demo').redos.left], [1, 0]);
    const done = await r.job;
    assert.equal(done.ok, true, done.why);
    const old = loadPost(ctx.db, first.postId);
    const neu = loadPost(ctx.db, done.postId);
    assert.equal(old.status, 'rejected');
    assert.match(old.reason, /^ארוך מדי: שלוש שורות לכל היותר$/);
    assert.deepEqual([old.reject.reason, old.reject.redo, old.reject.replacement], ['shorter', 'queued', done.postId]);
    assert.deepEqual([neu.status, neu.quota_kind, neu.redo_of, neu.slot_at], ['queued', 'redo', first.postId, old.slot_at]);
    assert.equal(docKeyOf(ctx.db, neu.id), docKeyOf(ctx.db, old.id), 'the same story, told shorter');
    const steer = JSON.parse(ctx.db.get("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'feedback'", neu.id).detail_json).steer;
    assert.deepEqual([steer.kind, steer.reason, steer.note], ['redo', 'shorter', 'שלוש שורות לכל היותר']);
    const u = usage(ctx.db, 'demo');
    assert.deepEqual([u.suggested.used, u.redos.used], [1, 1], 'the rejected post stays a suggestion; the replacement is a redo');
    // The redos are used up: rejecting the replacement discards it, and nothing is written.
    const before = ctx.db.get('SELECT COUNT(*) AS n FROM posts').n;
    const again = reject(ctx, customer, { id: neu.id }, { reason: 'tone' });
    assert.equal(again.job, undefined);
    assert.match(again.message, /כל 1 ההחלפות של החודש נוצלו/);
    assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM posts').n, before);
    assert.deepEqual([loadPost(ctx.db, neu.id).status, loadPost(ctx.db, neu.id).reject.redo], ['rejected', 'none']);
    // The pages: each post links to the other, and a queued post's form offers the reasons and says what is left.
    assert.match(postPage({ csrf: 'x' }, postFull(ctx, first.postId)), /נכתב פוסט חלופי[\s\S]*href="\/post\//);
    assert.match(postPage({ csrf: 'x' }, postFull(ctx, neu.id)), /פוסט חלופי<\/b><p>נכתב במקום/);
    assert.match(postPage({ csrf: 'x' }, postFull(ctx, neu.id)), /לא נכתב פוסט חלופי/);
  } finally {
    cleanup();
  }
});

test('what each reason asks of the replacement: another topic, the same story shorter or in another tone, other photographs', () => {
  const { home, cleanup } = tempHome();
  try {
    const { db } = contextFor(home);
    const post = { id: 'p1', hook: 'הפוטוס שלא מת', topic: 'פוטוס במשרד', format_id: 'plant-story', hook_pattern: 'number', checks: { images: [7] }, slides: [{ image_id: 8 }] };
    db.insert('images', { id: 7, provider: 'pexels', provider_id: '111', license: 'Pexels', created_at: 'now' });
    db.insert('images', { id: 8, provider: 'commons', provider_id: 'File:Pothos.jpg', license: 'CC BY-SA', created_at: 'now' });
    assert.deepEqual(redoDirective(db, post, { reason: 'topic' }), { steer: { kind: 'redo', reason: 'topic', note: '', hook: post.hook, topic: post.topic } });
    // Without a document of its own a post cannot be told again: it gets a new topic whatever the reason.
    assert.equal(redoDirective(db, post, { reason: 'shorter' }).docKey, undefined);
    assert.match(steerLine({ kind: 'redo', reason: 'topic', topic: 'פוטוס', hook: 'h' }), /for its topic \("פוטוס"\)\. This post is about something else entirely/);
    assert.match(steerLine({ kind: 'redo', reason: 'shorter', hook: 'h', note: 'פחות מילים' }), /told shorter.*In their words: "פחות מילים"/);
    assert.match(steerLine({ kind: 'redo', reason: 'tone', hook: 'h' }), /different tone, never its words/);
    assert.match(steerLine({ kind: 'redo', reason: 'photo', hook: 'h' }), /different image searches/);
    assert.match(steerLine({ kind: 'redo', reason: 'other', hook: 'h', note: 'בלי שאלה בסוף' }), /"בלי שאלה בסוף"/);
    // With its document: the same story, and for the photographs, none of the old ones.
    db.insert('accounts', { id: 'x', display_name: 'x', handle: 'x', created_at: 'now', updated_at: 'now' });
    const src = db.insert('sources', { account_id: 'x', key: 's', type: 'web', url: 'https://x.test', name: 's', status: 'approved', origin: 'manual', created_at: 'now' });
    const doc = db.insert('documents', { source_id: src, key: 'pothos-story', url: 'https://x.test/a', text: 't', sha256: 'h', fetched_at: 'now' });
    db.insert('posts', { id: 'p1', account_id: 'x', status: 'rejected', created_at: 'now', updated_at: 'now' });
    db.insert('facts', { post_id: 'p1', key: 'f1', claim: 'c', quote: 'q', document_id: doc });
    const photo = redoDirective(db, post, { reason: 'photo' });
    assert.deepEqual([photo.docKey, photo.formatKey, photo.reuseDocs], ['pothos-story', 'plant-story', true]);
    assert.deepEqual(photo.avoidImages.sort(), ['commons:File:Pothos.jpg', 'pexels:111']);
    assert.equal(redoDirective(db, post, { reason: 'tone' }).avoidHook, 'number', 'another tone, under another cover pattern');
  } finally {
    cleanup();
  }
});

test('two rejections at once with one redo left: the first is rewritten, the second only discarded', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const a = await buildPost(ctx, { pack, formatKey: 'care-guide' });
    const b = await buildPost(ctx, { pack, formatKey: 'mistakes' });
    assert.equal(b.status, 'queued', b.reason);
    setPlan(ctx.db, 'demo', { redos: '1' });
    const ra = reject(ctx, customer, { id: a.postId }, { reason: 'topic' });
    const rb = reject(ctx, customer, { id: b.postId }, { reason: 'topic' });
    assert.ok(ra.job);
    assert.equal(rb.job, undefined, 'the first redo already holds the last one');
    await ra.job;
    assert.ok(usage(ctx.db, 'demo').redos.used + usage(ctx.db, 'demo').redos.held <= 1);
  } finally {
    cleanup();
  }
});

test('the ledger: every dollar of a customer\'s month by what it was for', () => {
  const { home, cleanup } = tempHome();
  try {
    const { db } = contextFor(home);
    setNow(OCT);
    const at = new Date(OCT).toISOString();
    const s1 = row(db, { quota_kind: 'suggestion', quota_month: '2026-10' });
    const s2 = row(db, { quota_kind: 'suggestion', quota_month: '2026-10', status: 'rejected' });
    const r1 = row(db, { quota_kind: 'redo', quota_month: '2026-10', redo_of: s2 });
    const b1 = row(db, { quota_kind: 'retry', quota_month: '2026-10', status: 'blocked' });
    const spend = (post_id, usd, tag = 'slides') => db.insert('spend', { account_id: 'demo', post_id, api: 'claude', usd, tag, month: '2026-10', at });
    spend(s1, 0.1);
    spend(s1, 0.02, 'repair');
    spend(s2, 0.1);
    spend(r1, 0.11);
    spend(b1, 0.07);
    spend(s1, 0.004, 'edit-check');
    spend(null, 0.03, 'topics');
    db.insert('spend', { account_id: 'demo', api: 'claude', usd: 5, month: '2026-09', at });
    const l = ledger(db, 'demo', '2026-10');
    const by = Object.fromEntries(l.rows.map((r) => [r.kind, r]));
    assert.deepEqual([by.suggestion.posts, by.redo.posts, by.retry.posts], [2, 1, 1]);
    assert.ok(Math.abs(by.suggestion.usd - 0.22) < 1e-9, 'a suggestion\'s own repair rounds are inside it');
    assert.ok(Math.abs(by.redo.usd - 0.11) < 1e-9);
    assert.ok(Math.abs(by.retry.usd - 0.07) < 1e-9);
    assert.ok(Math.abs(by.edit.usd - 0.004) < 1e-9);
    assert.ok(Math.abs(by.account.usd - 0.03) < 1e-9);
    assert.ok(Math.abs(l.total - 0.434) < 1e-9, 'September is September\'s');
    assert.equal(l.delivered, 3);
    assert.ok(Math.abs(l.perDelivered - 0.434 / 3) < 1e-9);
  } finally {
    cleanup();
  }
});

test('light edits: a photograph the post already has, a slide removed, and text fact-checked where it changed; none is a redo', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    const id = res.postId;
    let post = loadPost(ctx.db, id);

    // Two photographs this post fetched (here, copies of its own slides, so a file is there to draw).
    const photo = (k) => {
      const file = path.join(home, `photo-${k}.jpg`);
      copyFileSync(post.media.tiktok[k], file);
      return ctx.db.insert('images', { provider: 'pexels', provider_id: `p${k}`, license: 'Pexels', file, safety: 'ok', query: `photo ${k}`, created_at: 'now' });
    };
    const [a, b] = [photo(1), photo(2)];
    const stranger = ctx.db.insert('images', { provider: 'pexels', provider_id: 'other', license: 'Pexels', file: post.media.tiktok[0], safety: 'ok', created_at: 'now' });
    ctx.db.run('UPDATE slides SET image_id = ? WHERE post_id = ? AND idx = 1', a, id);
    ctx.db.update('posts', id, { checks_json: { ...post.checks, images: [a, b] } });
    const r1 = await swapPhoto(ctx, customer, { id, idx: '1' }, { image: String(b) });
    assert.match(r1.message, /התמונה הוחלפה/);
    post = loadPost(ctx.db, id);
    assert.equal(post.slides[1].image_id, b);
    await assert.rejects(swapPhoto(ctx, customer, { id, idx: '1' }, { image: String(stranger) }), /לא מהפוסט הזה/);
    await swapPhoto(ctx, customer, { id, idx: '1' }, { image: 'none' });
    assert.equal(loadPost(ctx.db, id).slides[1].image_id, null);

    // A slide removed: the rest close up, every slide drawn again, and the gate before publishing still holds.
    post = loadPost(ctx.db, id);
    const n0 = post.slides.length;
    const second = post.slides[2].title;
    const r2 = await removeSlide(ctx, customer, { id, idx: '1' });
    assert.match(r2.message, /השקף הוסר/);
    post = loadPost(ctx.db, id);
    assert.equal(post.slides.length, n0 - 1);
    assert.deepEqual(post.slides.map((s) => s.idx), [...Array(n0 - 1).keys()]);
    assert.equal(post.slides[1].title, second);
    assert.equal(post.media.tiktok.length, n0 - 1);
    assert.ok(post.media.tiktok.every((f) => existsSync(f)));
    assert.deepEqual(recheck(ctx.db, post, pack), []);
    await assert.rejects(removeSlide(ctx, customer, { id, idx: '0' }), /אין שקף תוכן כזה/);

    // Text: the reviewer is asked about the changed text only, and a sentence that says more than its facts is refused.
    const asked = [];
    let verdict = { factIssue: true, factProblem: 'הטקסט אומר יותר מהעובדה' };
    const llm = {
      kind: 'claude',
      async json(req) {
        asked.push(req.user);
        return { data: { reviews: [{ index: 0, botScore: 2, tells: [], ...verdict }] }, usage: { input_tokens: 400, output_tokens: 60 }, model: req.model };
      },
    };
    const page = postPage({ csrf: 'x' }, postFull(ctx, id));
    assert.match(page, /שינויים קטנים/);
    assert.match(page, new RegExp(`action="/post/${id}/slide/1/remove"`));
    for (const r of ['topic', 'shorter', 'tone', 'photo', 'other']) assert.match(page, new RegExp(`<option value="${r}">`));
    assert.match(page, /נשארו 10 החלפות החודש/);
    const lctx = { ...ctx, llm };
    const form = () => {
      const p = loadPost(ctx.db, id);
      const f = { hook: p.hook, sub: p.sub || '', caption: p.caption, caption_short: p.data?.captionShort || '' };
      p.slides.filter((s) => s.kind === 'item').forEach((s, i) => Object.assign(f, { [`title_${i}`]: s.title, [`body_${i}`]: s.body }));
      return f;
    };
    await edit(lctx, customer, { id }, form());
    assert.equal(asked.length, 0, 'nothing changed: no model call');
    // One word for a shorter one: the slide keeps its lines, so only the fact check can refuse it.
    const changed = { ...form(), title_0: form().title_0.replace('השעון', 'הלוח') };
    assert.notEqual(changed.title_0, form().title_0);
    await assert.rejects(edit(lctx, customer, { id }, changed), (e) => e.status === 422 && /הטקסט אומר יותר מהעובדה/.test(e.problems.join(' ')));
    assert.equal(asked.length, 1);
    assert.equal(loadPost(ctx.db, id).slides[1].title, form().title_0, 'nothing saved');
    const check = ctx.db.get("SELECT * FROM spend WHERE post_id = ? AND tag = 'edit-check'", id);
    assert.ok(check && check.usd > 0, 'the fact check is billed to the post, as an edit');
    verdict = { factIssue: false, factProblem: '' };
    await edit(lctx, customer, { id }, changed);
    assert.equal(loadPost(ctx.db, id).slides[1].title, changed.title_0);
    const u = usage(ctx.db, 'demo');
    assert.deepEqual([u.suggested.used, u.redos.used], [1, 0], 'light edits are neither a suggestion nor a redo');
    assert.equal(ledger(ctx.db, 'demo', '2026-10').rows.find((r) => r.kind === 'edit').calls, 2);
  } finally {
    cleanup();
  }
});

test("a customer's light edits are fact-checked up to 30 times a day across their accounts; the operator's are not limited", async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    setNow(OCT);
    ctx.db.run("UPDATE accounts SET workspace_id = 5 WHERE id = 'demo'");
    const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
    const id = res.postId;
    const asked = [];
    const llm = { kind: 'claude', async json(req) { asked.push(req.user); return { data: { reviews: [{ index: 0, botScore: 2, tells: [], factIssue: false, factProblem: '' }] }, usage: { input_tokens: 400, output_tokens: 60 }, model: req.model }; } };
    const form = () => {
      const p = loadPost(ctx.db, id);
      const f = { hook: p.hook, sub: p.sub || '', caption: p.caption, caption_short: p.data?.captionShort || '' };
      p.slides.filter((s) => s.kind === 'item').forEach((s, i) => Object.assign(f, { [`title_${i}`]: s.title, [`body_${i}`]: s.body }));
      return f;
    };
    // 30 checks billed today for the workspace's accounts.
    for (let i = 0; i < EDIT_CHECKS_PER_DAY; i++) ctx.db.insert('spend', { account_id: 'demo', post_id: id, api: 'anthropic', usd: 0.001, tag: 'edit-check', month: '2026-10', at: new Date(OCT).toISOString() });
    assert.equal(editChecksToday(ctx.db, 5, OCT), EDIT_CHECKS_PER_DAY);
    const changed = () => ({ ...form(), title_1: form().title_1.replace('השעון', 'הלוח') });
    const customerCtx = { ...ctx, llm, workspaceId: 5 };
    await assert.rejects(edit(customerCtx, customer, { id }, changed()), (e) => e.status === 429 && /היום כבר בדקנו 30 עריכות טקסט בחשבונות שלכם/.test(e.message));
    assert.equal(asked.length, 0, 'refused before the model is asked');
    // The operator's context (no workspace) is not limited.
    await edit({ ...ctx, llm }, customer, { id }, changed());
    assert.equal(asked.length, 1);
    // The next day counts again.
    assert.equal(editChecksToday(ctx.db, 5, OCT + 86_400_000), 0);
  } finally {
    cleanup();
  }
});

test("the account page says 'X of 40 used, Y of 10 redos'; the operator sees every customer's month and its ledger", () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    setNow(OCT);
    for (let i = 0; i < 3; i++) row(ctx.db, { quota_kind: 'suggestion', quota_month: '2026-10' });
    row(ctx.db, { quota_kind: 'redo', quota_month: '2026-10', redo_of: 'x' });
    ctx.db.insert('spend', { account_id: 'demo', api: 'claude', usd: 0.5, month: '2026-10', at: new Date(OCT).toISOString() });
    const rows = accountRows(ctx).map((r) => ({ ...r, week: week(ctx, r.pack.id), style: null }));
    assert.match(accountsPage({ csrf: 'x' }, rows), /נוצלו 3 מתוך 40 הצעות · 1 מתוך 10 החלפות/);
    const html = quotasPanel({ csrf: 'x' }, quotasData(ctx));
    assert.match(html, /3\/40/);
    assert.match(html, /data-k="עלות"><span class="num ltr">\$0\.50<\/span><\/td>/);
    assert.doesNotMatch(html, /name="cap"|תקרה/, 'no cap to set');
    assert.match(html, /action="\/accounts\/demo\/quota"/);
    assert.match(html, /placeholder="40"/);
    // Used up: the card says when it starts again.
    for (let i = 0; i < 37; i++) row(ctx.db, { quota_kind: 'suggestion', quota_month: '2026-10' });
    assert.match(accountsPage({ csrf: 'x' }, accountRows(ctx).map((r) => ({ ...r, week: week(ctx, r.pack.id), style: null }))), /ההצעות של החודש נוצלו<\/span> פוסטים חדשים ייכתבו מתחילת החודש הבא/);
  } finally {
    cleanup();
  }
});
