import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { publishPost } from '../src/publish/index.js';
import { watchDrafts } from '../src/publish/draft.js';
import { matchDraft, postBody } from '../src/publish/zernio.js';
import { pickSound, readSound, saveSound, soundsOf } from '../src/pipeline/sounds.js';
import { notify, subscribe, vapid, vapidAuth } from '../src/notify/index.js';
import { assertAllowed } from '../src/core/net.js';
import { israelInstant } from '../src/schedule/israel.js';
import { validatePack } from '../src/packs/validate.js';
import { closeBrowser } from '../src/render/render.js';
import { pauseAccount } from '../src/autonomy/rails.js';
import { today } from '../src/web/data.js';
import { needsYou, todayPage } from '../src/web/pages.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// Draft-fallback on TikTok: the post goes as a draft with a sound from the owner's list, the owner is told, reminded
// at half an hour, and at an hour a draft still not out is published directly with a library track. Never twice:
// a draft published after that is flagged, and a send whose answer was lost is never sent again.

after(() => closeBrowser());

const MIN = 60_000;
const tuesday = (hhmm) => israelInstant('2026-10-13', hhmm).getTime();

test('a sound is a name and an artist, with a TikTok link or none; five at most, and none twice', () => {
  assert.deepEqual(readSound({ name: ' Espresso ', artist: 'Sabrina Carpenter', link: '' }).problems, []);
  assert.match(readSound({ name: 'x', artist: 'y', link: 'https://example.com/a' }).problems.join(' '), /טיקטוק/);
  assert.match(readSound({ name: '', artist: '' }).problems.join(' '), /שם הסאונד/);
  const db = new Db(':memory:');
  const at = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  for (const n of ['1', '2', '3', '4', '5']) assert.ok(saveSound(db, 'a', { name: `s${n}`, artist: 'x' }).id);
  assert.match(saveSound(db, 'a', { name: 's6', artist: 'x' }).problems.join(' '), /עד 5/);
  db.run('DELETE FROM sounds WHERE name = ?', 's5');
  assert.match(saveSound(db, 'a', { name: 'S1', artist: 'X' }).problems.join(' '), /כבר ברשימה/);
});

test('each draft takes a fresh sound the last five drafts did not have; stale after seven days', () => {
  const s = (id, stale = false) => ({ id, name: `n${id}`, artist: 'a', link: null, stale });
  assert.equal(pickSound([s(1), s(2), s(3)], [1]).id, 2);
  assert.equal(pickSound([s(1, true), s(2), s(3)], [2]).id, 3, 'fresh before stale');
  assert.equal(pickSound([s(1, true), s(2)], [2]).id, 1, 'a stale one before a repeat');
  assert.equal(pickSound([s(1), s(2)], [1, 2]).id, 2, 'all used lately: the one used longest ago');
  assert.equal(pickSound([], []), null);
  const db = new Db(':memory:');
  const at = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  db.insert('sounds', { account_id: 'a', name: 'old', artist: 'x', added_at: '2026-10-01T10:00:00Z' });
  db.insert('sounds', { account_id: 'a', name: 'new', artist: 'x', added_at: '2026-10-07T10:00:00Z' });
  const list = soundsOf(db, 'a', { t: Date.parse('2026-10-09T10:00:00Z') });
  assert.deepEqual(list.map((x) => [x.name, x.stale]), [['new', false], ['old', true]]);
});

test('a TikTok draft request carries draft and no library track; the pack names the mode', () => {
  const body = postBody({ platform: 'tiktok', accountId: 'z', caption: 'c', imageUrls: ['a', 'b'], asDraft: true, sound: { id: '99' } });
  assert.equal(body.tiktokSettings.draft, true);
  assert.equal(body.tiktokSettings.musicSoundInfo, undefined, 'the owner adds the sound in the app');
  assert.equal(postBody({ platform: 'tiktok', accountId: 'z', caption: 'c', imageUrls: ['a', 'b'] }).tiktokSettings.draft, undefined);
  const { home, cleanup } = tempHome();
  try {
    const packs = loadAll({ dir: path.join(home, 'packs') });
    const pack = packs[0];
    pack.meta.zernio.tiktokMode = 'sometimes';
    assert.match(validatePack(pack).join(' '), /tiktokMode must be one of draft-now, direct, draft-fallback/);
  } finally {
    cleanup();
  }
});

test("the owner's post is found by its caption, after the draft was sent, and never claimed twice", () => {
  const sentAt = '2026-10-13T09:45:00Z';
  const caption = 'בזיליקום במרפסת: חמישה דברים שהוא צריך\n\nעוד שורה';
  const p = (id, publishedAt, content) => ({ id, publishedAt, content, url: `https://tiktok/${id}` });
  const posts = [p('old', '2026-10-13T08:00:00Z', 'בזיליקום במרפסת: חמישה דברים שהוא צריך'), p('other', '2026-10-13T10:00:00Z', 'מתכון לפסטו'), p('ours', '2026-10-13T10:05:00Z', 'בזיליקום במרפסת: 5 דברים שהוא צריך #צמחים')];
  assert.equal(matchDraft({ caption, sentAt }, posts).id, 'ours');
  assert.equal(matchDraft({ caption, sentAt }, posts, ['ours']), null, 'claimed by another draft');
  assert.equal(matchDraft({ caption, sentAt }, [p('x', '2026-10-13T10:00:00Z', '')]).id, 'x', 'no caption to compare: the one new post');
  assert.equal(matchDraft({ caption, sentAt }, [p('x', '2026-10-13T10:00:00Z', ''), p('y', '2026-10-13T10:01:00Z', '')]), null, 'two uncaptioned posts: neither is assumed');

  // The post Zernio says was this draft is it, whatever its caption became; one it links to another draft is not ours.
  const linked = { ...p('linked', '2026-10-13T10:10:00Z', 'כיתוב שהבעלים כתבו מחדש'), draftId: 'draft-1' };
  const theirs = { ...p('theirs', '2026-10-13T10:06:00Z', 'בזיליקום במרפסת: חמישה דברים שהוא צריך'), draftId: 'draft-2' };
  assert.equal(matchDraft({ caption, sentAt, draftId: 'draft-1' }, [theirs, linked]).id, 'linked');
  assert.equal(matchDraft({ caption, sentAt, draftId: 'draft-9' }, [theirs]), null, "another draft's post, even with our caption");
  assert.equal(matchDraft({ caption, sentAt, draftId: 'draft-1' }, [linked], ['linked']), null, 'claimed already');
});

test('notifications go through the door to the push services only, empty and signed; Telegram stays refused', async () => {
  for (const u of ['https://fcm.googleapis.com/fcm/send/abc:APA91b', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA', 'https://web.push.apple.com/QGuQyavXut', 'https://wns2-par02p.notify.windows.com/w/']) assert.ok(assertAllowed('POST', u), u);
  assert.throws(() => assertAllowed('POST', 'https://api.telegram.org/bot123/sendMessage'), /refused/);
  assert.throws(() => assertAllowed('POST', 'https://fcm.googleapis.com/v1/projects/x/messages:send'), /refused/, 'Firebase messaging is not a browser push');
  const db = new Db(':memory:');
  const auth = vapidAuth(db, 'https://fcm.googleapis.com/fcm/send/abc', { t: Date.parse('2026-10-13T10:00:00Z') });
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  const [h, c, sig] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://fcm.googleapis.com');
  assert.equal(k, vapid(db).publicKey);
  const pub = createPublicKey({ key: { ...vapid(db).jwk, d: undefined }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signed with the key the browser was given');
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/live' });
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/gone' });
  assert.ok(subscribe(db, { endpoint: 'http://x' }).problem);
  const sent = [];
  const id = await notify({ db }, { kind: 'draft', title: 't', body: 'b' }, { send: async (_db, endpoint) => (sent.push(endpoint), { status: endpoint.endsWith('gone') ? 410 : 201 }) });
  assert.equal(sent.length, 2);
  assert.equal(db.get('SELECT pushed FROM notifications WHERE id = ?', id).pushed, 1);
  assert.deepEqual(db.all('SELECT endpoint FROM push_subs').map((r) => r.endpoint), ['https://fcm.googleapis.com/fcm/send/live'], 'a browser that is gone is forgotten');
});

/** A demo post approved for Tuesday 12:45, on an account in draft-fallback with two sounds on its list. */
async function draftPost(home) {
  keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  const pack = ctx.pack('demo');
  pack.meta.zernio.tiktokMode = 'draft-fallback';
  saveSound(db, 'demo', { name: 'Espresso', artist: 'Sabrina Carpenter' });
  saveSound(db, 'demo', { name: 'APT.', artist: 'ROSÉ & Bruno Mars' });
  const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
  assert.equal(res.status, 'queued', res.reason);
  db.update('posts', res.postId, { status: 'approved', approved_by: 'owner', slot_at: new Date(tuesday('12:45')).toISOString() });
  await publishPost(ctx, res.postId, { t: tuesday('12:45') });
  return { ctx, db, id: res.postId };
}

test('at the slot TikTok goes as a draft with a sound named for it, Instagram as always, and the owner is told', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { db, id } = await draftPost(home);
    const post = loadPost(db, id);
    assert.equal(post.status, 'published');
    assert.equal(post.publish.instagram.via, 'dry');
    assert.equal(post.publish.instagram.flow, undefined, 'Instagram is not touched');
    const tk = post.publish.tiktok;
    assert.equal(tk.flow.state, 'waiting');
    assert.equal(tk.draft, true);
    assert.ok(tk.flow.sound.name, 'a sound from the list');
    assert.equal(tk.zernioId, undefined, 'a draft has no numbers to read');
    const req = JSON.parse((await import('node:fs')).readFileSync(path.join(tk.path, 'zernio-request.tiktok.json'), 'utf8'));
    assert.equal(req.tiktokSettings.draft, true);
    const n = db.get("SELECT * FROM notifications WHERE kind = 'draft'");
    assert.match(n.title, /טיוטה מחכה בטיקטוק/);
    assert.ok(n.body.includes(tk.flow.sound.name) && n.body.includes('בזיליקום'), n.body);
  } finally {
    cleanup();
  }
});

test('reminded once at half an hour; published directly at an hour; a late draft is flagged as a duplicate', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await draftPost(home);
    const none = async () => [];
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:05'), list: none }), [], 'nothing before half an hour');
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:16'), list: none }), [{ post: id, state: 'reminded' }]);
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:20'), list: none }), [], 'reminded once');
    const r = await watchDrafts(ctx, { t: tuesday('13:46'), list: none });
    assert.deepEqual(r, [{ post: id, state: 'fallback' }]);
    const tk = loadPost(db, id).publish.tiktok;
    assert.equal(tk.flow.state, 'fallback');
    assert.ok(existsSync(path.join(tk.path, 'zernio-request.tiktok.fallback.json')));
    assert.equal(JSON.parse((await import('node:fs')).readFileSync(path.join(tk.path, 'zernio-request.tiktok.fallback.json'), 'utf8')).tiktokSettings.draft, undefined, 'the fallback is direct');
    assert.deepEqual(db.all('SELECT kind FROM notifications ORDER BY id').map((x) => x.kind), ['draft', 'reminder', 'fallback']);
    assert.match(db.get("SELECT body FROM notifications WHERE kind = 'fallback'").body, /מחקו את הטיוטה/);
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:50'), list: none }), [], 'never published twice');
    // The owner publishes the draft after all: two of the same post on the account.
    const late = async () => [{ id: 'ext1', publishedAt: new Date(tuesday('13:55')).toISOString(), content: loadPost(db, id).caption.split('\n')[0], url: 'https://tiktok/ext1' }];
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('14:00'), list: late }), [{ post: id, state: 'duplicate' }]);
    assert.equal(loadPost(db, id).publish.tiktok.flow.state, 'duplicate');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'duplicate'").n, 1);
    // Today shows it, and puts it first in what needs the owner.
    const d = today(ctx, tuesday('14:00'));
    const html = todayPage({ csrf: 'x' }, d);
    assert.match(html, /טיוטות בטיקטוק[\s\S]*פורסם פעמיים/);
    assert.match(needsYou(d).rows[0].sub, /פורסם פעמיים: מחקו אחד מהשניים/);
  } finally {
    cleanup();
  }
});

test("the owner's own post ends the watch, its numbers read from it; a send whose answer was lost is never sent again", async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await draftPost(home);
    const mine = async () => [{ id: 'ext9', publishedAt: new Date(tuesday('13:00')).toISOString(), content: loadPost(db, id).caption.split('\n')[0], url: 'https://tiktok/ext9' }];
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('13:02'), list: mine }), [{ post: id, state: 'mine' }]);
    const tk = loadPost(db, id).publish.tiktok;
    assert.equal(tk.flow.state, 'mine');
    assert.equal(tk.zernioId, 'ext9', 'the metrics read the owner’s post');
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('14:00'), list: async () => [] }), [], 'no fallback after the owner posted');
    // A post found mid-send: failed, told, not sent.
    const p = loadPost(db, id);
    p.publish.tiktok.flow.state = 'sending';
    db.update('posts', id, { publish_json: p.publish });
    assert.deepEqual(await watchDrafts(ctx, { t: tuesday('14:05'), list: async () => [] }), [{ post: id, state: 'failed' }]);
    assert.match(db.get("SELECT body FROM notifications WHERE kind = 'fallback_failed'").body, /בדקו בטיקטוק/);
  } finally {
    cleanup();
  }
});

test('the fallback waits for Shabbat to end and for a paused account (hard rule 9 and the rails)', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await draftPost(home);
    const p = loadPost(db, id);
    p.publish.tiktok.flow.slotAt = israelInstant('2026-10-17', '10:00').toISOString();
    db.update('posts', id, { publish_json: p.publish, published_at: israelInstant('2026-10-17', '10:00').toISOString() });
    const r = await watchDrafts(ctx, { t: israelInstant('2026-10-17', '12:00').getTime(), list: async () => [] });
    assert.equal(r[0].state, 'waiting');
    assert.match(r[0].why, /שבת/);
    assert.equal(loadPost(db, id).publish.tiktok.flow.state, 'waiting');
    // A paused account's draft waits too, however late.
    p.publish.tiktok.flow.slotAt = new Date(tuesday('12:45')).toISOString();
    db.update('posts', id, { publish_json: p.publish, published_at: new Date(tuesday('12:45')).toISOString() });
    pauseAccount(db, 'demo', 'kill', 'test');
    const r2 = await watchDrafts(ctx, { t: tuesday('14:00'), list: async () => [] });
    assert.equal(r2[0].state, 'waiting');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'fallback'").n, 0);
  } finally {
    cleanup();
  }
});
