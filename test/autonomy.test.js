import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { publishPost, PublishRefused } from '../src/publish/index.js';
import { postBody, pickSound, AI_CAPTION_LINE } from '../src/publish/zernio.js';
import { tick } from '../src/autonomy/runner.js';
import { publishErrorStreak, pauseAccount } from '../src/autonomy/rails.js';
import { collectMetrics } from '../src/metrics/collect.js';
import { credit, judge, pickFormat, ensureFormats } from '../src/formats/rotation.js';
import { israelInstant } from '../src/schedule/israel.js';
import { setSetting } from '../src/core/store.js';
import { closeBrowser } from '../src/render/render.js';
import { opened, tempHome } from './helpers.js';

after(() => closeBrowser());

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

const tuesday = (hhmm) => israelInstant('2026-10-13', hhmm).getTime();

test('Approve mode, end to end: drafted a day ahead, waits, approved, published by the dry publisher at its slot', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    let r = await tick(ctx, { t: tuesday('07:05') });
    assert.equal(r.generated.length, 4, `today's two empty slots and tomorrow's two: ${JSON.stringify(r.generated)}`);
    assert.equal(ctx.db.all("SELECT id FROM posts WHERE account_id = 'demo' AND slot_at >= '2026-10-14'").length, 2, 'tomorrow is drafted today');
    r = await tick(ctx, { t: tuesday('08:00') });
    assert.equal(r.generated.length, 0, 'once a day');
    const posts = ctx.db.all("SELECT id, status, slot_at FROM posts WHERE account_id = 'demo' AND slot_at < '2026-10-14' ORDER BY slot_at");
    assert.ok(posts.every((p) => p.status === 'queued'));
    r = await tick(ctx, { t: tuesday('12:45') });
    assert.equal(r.published.length, 0, 'nothing goes out without approval');
    ctx.db.run("UPDATE posts SET status = 'approved', approved_by = 'owner' WHERE id = ?", posts[0].id);
    r = await tick(ctx, { t: tuesday('12:46') });
    assert.equal(r.published.length, 1);
    const pub = ctx.db.get('SELECT status, publish_json FROM posts WHERE id = ?', posts[0].id);
    assert.equal(pub.status, 'published');
    const out = JSON.parse(pub.publish_json);
    assert.equal(out.tiktok.via, 'dry');
    assert.ok(existsSync(path.join(out.tiktok.path, 'zernio-request.tiktok.json')));
    assert.ok(existsSync(path.join(out.tiktok.path, 'sources.md')));
    // The second post was never approved: it expires at the end of its day.
    r = await tick(ctx, { t: israelInstant('2026-10-14', '06:00').getTime() });
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', posts[1].id).status, 'expired');
  } finally {
    cleanup();
  }
});

test('Digest mode: the post goes out at its slot unless rejected first', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    ctx.db.run("UPDATE accounts SET mode = 'digest' WHERE id = 'demo'");
    await tick(ctx, { t: tuesday('07:05') });
    const [a, b] = ctx.db.all("SELECT id FROM posts WHERE account_id = 'demo' AND slot_at < '2026-10-14' ORDER BY slot_at");
    ctx.db.run("UPDATE posts SET status = 'rejected' WHERE id = ?", b.id);
    const r = await tick(ctx, { t: tuesday('12:41') });
    assert.deepEqual(r.approved, [a.id]);
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', a.id).status, 'published');
    await tick(ctx, { t: tuesday('19:45') });
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', b.id).status, 'rejected');
  } finally {
    cleanup();
  }
});

test('Auto mode publishes and writes a daily summary', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    ctx.db.run("UPDATE accounts SET mode = 'auto' WHERE id = 'demo'");
    await tick(ctx, { t: tuesday('07:05') });
    await tick(ctx, { t: tuesday('12:41') });
    await tick(ctx, { t: tuesday('19:41') });
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'demo' AND status = 'published'").n, 2);
    await tick(ctx, { t: israelInstant('2026-10-14', '07:05').getTime() });
    const s = ctx.db.get("SELECT text FROM summaries WHERE day = '2026-10-13' AND account_id = 'demo'");
    assert.match(s.text, /2 פורסמו/);
  } finally {
    cleanup();
  }
});

test('nothing publishes on Shabbat, even approved, even asked by hand (hard rule 9)', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const res = await buildPost(ctx, { pack: ctx.pack('demo') });
    ctx.db.run("UPDATE posts SET status = 'approved' WHERE id = ?", res.postId);
    const saturday = israelInstant('2026-10-17', '12:00').getTime();
    await assert.rejects(publishPost(ctx, res.postId, { t: saturday }), (e) => e instanceof PublishRefused && e.code === 'shabbat');
    const r = await tick(ctx, { t: saturday });
    assert.equal(r.published.length, 0);
    // Generation on a Friday plans only the slot before candle lighting.
    const ctx2 = contextFor(home);
    await tick(ctx2, { t: israelInstant('2026-10-16', '07:05').getTime() });
    const slots = ctx2.db.all("SELECT slot_at FROM posts WHERE account_id = 'demo' AND slot_at LIKE '2026-10-16%'").map((x) => x.slot_at);
    for (const s of slots) assert.ok(Date.parse(s) < israelInstant('2026-10-16', '17:00').getTime(), s);
  } finally {
    cleanup();
  }
});

test('a source removed after drafting blocks the post before publishing, and the account goes on (failed fact check)', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' });
    ctx.db.run("UPDATE posts SET status = 'approved' WHERE id = ?", res.postId);
    ctx.db.run("UPDATE sources SET status = 'removed' WHERE account_id = 'demo'");
    await assert.rejects(publishPost(ctx, res.postId, { t: tuesday('12:45') }), /fact check failed/);
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', res.postId).status, 'blocked');
    const acc = ctx.db.get("SELECT status, paused_reason FROM accounts WHERE id = 'demo'");
    assert.deepEqual({ ...acc }, { status: 'active', paused_reason: null });
  } finally {
    cleanup();
  }
});

test('the global kill switch stops publishing in every mode', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const res = await buildPost(ctx, { pack: ctx.pack('demo') });
    ctx.db.run("UPDATE posts SET status = 'approved' WHERE id = ?", res.postId);
    setSetting(ctx.db, 'globalKill', true);
    await assert.rejects(publishPost(ctx, res.postId, { t: tuesday('12:45') }), (e) => e.code === 'paused');
  } finally {
    cleanup();
  }
});

test('a streak of publish errors is counted; a kill is never overwritten by an automatic pause', () => {
  const db = new Db(':memory:');
  const at = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  for (const [i, s] of ['published', 'failed', 'failed', 'failed'].entries()) db.insert('posts', { id: `p${i}`, account_id: 'a', status: s, created_at: at, updated_at: `2026-10-0${i + 1}T10:00:00Z` });
  assert.equal(publishErrorStreak(db, 'a'), 3);
  pauseAccount(db, 'a', 'kill');
  pauseAccount(db, 'a', 'publish_errors');
  assert.equal(db.get("SELECT paused_reason FROM accounts WHERE id = 'a'").paused_reason, 'kill', 'a kill is never overwritten');
});

test('AI disclosure: a realistic AI image sets TikTok\'s flag and adds a caption line on Instagram (hard rule 4)', () => {
  const tt = postBody({ platform: 'tiktok', accountId: 'x', caption: 'c', imageUrls: ['a', 'b'], aiLabel: true });
  assert.equal(tt.tiktokSettings.video_made_with_ai, true);
  assert.equal(tt.tiktokSettings.draft, true, 'a photo post goes as a draft so the label is set in the app');
  const ig = postBody({ platform: 'instagram', accountId: 'y', caption: 'c', imageUrls: ['a'], aiLabel: true });
  assert.ok(ig.content.endsWith(AI_CAPTION_LINE));
  const plain = postBody({ platform: 'tiktok', accountId: 'x', caption: 'c', imageUrls: ['a', 'b'], aiLabel: false });
  assert.equal(plain.tiktokSettings.video_made_with_ai, undefined);
});

test("sound: a trending library track replaces TikTok's pick, never twice in a row, and a draft keeps TikTok's pick", () => {
  const chart = [
    { id: 'c1', rank: 1, clipSec: 36 },
    { id: 'c2', rank: 2, clipSec: 1 },
    { id: 'c3', rank: 3, clipSec: 60 },
  ];
  assert.equal(pickSound(chart).id, 'c1', 'the best-ranked track');
  assert.equal(pickSound(chart, ['c1']).id, 'c3', 'not one the account used lately, and not a clip too short to carry the slides');
  assert.equal(pickSound(chart, ['c1', 'c3']).id, 'c1', 'every top track used lately: the best one again');
  assert.equal(pickSound([]), null);
  const tt = postBody({ platform: 'tiktok', accountId: 'x', caption: 'c', imageUrls: ['a', 'b'], sound: { id: 'c1' } });
  assert.deepEqual(tt.tiktokSettings.musicSoundInfo, { musicSoundId: 'c1' });
  assert.equal(tt.tiktokSettings.auto_add_music, false);
  const none = postBody({ platform: 'tiktok', accountId: 'x', caption: 'c', imageUrls: ['a', 'b'] });
  assert.equal(none.tiktokSettings.auto_add_music, true);
  assert.equal(none.tiktokSettings.musicSoundInfo, undefined);
  const draft = postBody({ platform: 'tiktok', accountId: 'x', caption: 'c', imageUrls: ['a', 'b'], aiLabel: true, sound: { id: 'c1' } });
  assert.equal(draft.tiktokSettings.musicSoundInfo, undefined, 'TikTok ignores a track on a draft');
  assert.equal(draft.tiktokSettings.auto_add_music, true);
});

test('metrics: only what the API gave is stored, TikTok has no saves, scores count at 72 hours', async () => {
  const db = new Db(':memory:');
  const at = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  db.insert('posts', { id: 'p1', account_id: 'a', format_id: 'f', status: 'published', published_at: at, publish_json: { tiktok: { zernioId: 'z1' } }, created_at: at, updated_at: at });
  db.insert('posts', { id: 'p2', account_id: 'a', format_id: 'f', status: 'published', published_at: at, publish_json: { tiktok: { via: 'dry' } }, created_at: at, updated_at: at });
  const fake = async () => ({ tiktok: { views: 1000, likes: 50, comments: 2, shares: 10, saves: 99 }, instagram: { views: null } });
  const r = await collectMetrics({ db, packs: [] }, { t: Date.parse('2026-10-04T12:00:00Z'), source: fake });
  assert.equal(r.got, 1, 'the dry-published post has nothing to read; the null Instagram reading is not stored');
  const m = db.get("SELECT * FROM metrics WHERE post_id = 'p1'");
  assert.equal(m.saves, null, 'TikTok never gets a save count');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM metrics WHERE post_id = 'p2'").n, 0);
});

test('formats: 3 results in a row under 70% of the median drop a format, at least 2 proven stay, trials get 30%', () => {
  const db = new Db(':memory:');
  const at = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  const pack = { id: 'a', formats: { formats: [{ id: 'good', weight: 1 }, { id: 'ok', weight: 1 }, { id: 'bad', weight: 1 }, { id: 'new', weight: 1, trial: true }] } };
  ensureFormats(db, pack);
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  let n = 0;
  for (const [fmt, rate] of [['good', 0.1], ['ok', 0.06], ['bad', 0.02], ['good', 0.1], ['ok', 0.07], ['bad', 0.02], ['good', 0.11], ['ok', 0.06], ['bad', 0.01]]) {
    const id = `q${n++}`;
    const pubAt = new Date(t0 + n * 3_600_000).toISOString();
    db.insert('posts', { id, account_id: 'a', format_id: fmt, status: 'published', published_at: pubAt, created_at: pubAt, updated_at: pubAt });
    db.insert('metrics', { post_id: id, platform: 'tiktok', collected_at: pubAt, age_hours: 80, views: 1000, likes: rate * 1000, shares: 0 });
  }
  const t = t0 + 5 * 86_400_000;
  credit(db, 'a', { t });
  const changes = judge(db, 'a', { t });
  assert.deepEqual(changes.map((c) => `${c.format}:${c.change}`), ['bad:dropped']);
  assert.match(db.get("SELECT dropped_why FROM formats WHERE format_key = 'bad'").dropped_why, /3 פעמים ברצף/);
  // With nothing tried yet, the trial is offered before its 30% is used up.
  assert.equal(pickFormat(db, 'a', { recent: [{ kind: 'proven', format: 'good' }, { kind: 'proven', format: 'ok' }, { kind: 'proven', format: 'good' }], t }), 'new');
  assert.notEqual(pickFormat(db, 'a', { recent: [{ kind: 'trial', format: 'new' }, { kind: 'proven', format: 'good' }], rand: () => 0, t }), 'new');
});
