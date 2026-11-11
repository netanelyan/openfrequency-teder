import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { publishPost, sendWaitingDrafts, tiktokMode } from '../src/publish/index.js';
import { flowState, watchDrafts } from '../src/publish/draft.js';
import { saveSound } from '../src/pipeline/sounds.js';
import { subscribe, unsubscribe } from '../src/notify/index.js';
import { israelInstant } from '../src/schedule/israel.js';
import { validatePack } from '../src/packs/validate.js';
import { closeBrowser } from '../src/render/render.js';
import { pauseAccount, resumeAccount } from '../src/autonomy/rails.js';
import { approve, deletePost, oldDraftsDeleted, reject, unapprove } from '../src/web/actions.js';
import { postFull } from '../src/web/data.js';
import { postCard, postPage } from '../src/web/pages.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// Draft-now, the default: the moment the owner approves, TikTok's part goes to the app's drafts; at the slot,
// Instagram goes out as always and the owner gets one reminder. The engine never publishes to TikTok itself.

after(() => closeBrowser());
afterEach(() => setNow(null));

const owner = { id: 1, name: 'owner' };
const at = (day, hhmm) => israelInstant(day, hhmm).getTime();

/** A queued demo post for `slot`, on an account left in its default TikTok mode, with a sound on its list. */
async function queued(home, slot) {
  keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  const pack = ctx.pack('demo');
  delete pack.meta.zernio.tiktokMode;
  saveSound(db, 'demo', { name: 'Espresso', artist: 'Sabrina Carpenter' });
  const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
  assert.equal(res.status, 'queued', res.reason);
  db.update('posts', res.postId, { slot_at: new Date(slot).toISOString() });
  return { ctx, db, id: res.postId, pack };
}

test('the default mode is draft-now, and a pack may name it', () => {
  const { home, cleanup } = tempHome();
  try {
    const pack = loadAll({ dir: path.join(home, 'packs') })[0];
    delete pack.meta.zernio.tiktokMode;
    assert.equal(tiktokMode(pack), 'draft-now');
    pack.meta.zernio.tiktokMode = 'draft-now';
    assert.deepEqual(validatePack(pack).filter((p) => /tiktokMode/.test(p)), []);
  } finally {
    cleanup();
  }
});

test('approved: the TikTok draft goes at once, nobody is notified; at the slot one reminder, Instagram as always', async () => {
  const { home, cleanup } = tempHome();
  try {
    const slot = at('2026-10-13', '12:45');
    const { ctx, db, id } = await queued(home, slot);
    setNow(at('2026-10-13', '09:00'));
    const r = approve(ctx, owner, { id });
    assert.match(r.message, /הטיוטה נשלחת לטיקטוק\. תזכורת תגיע ב-12:45/);
    assert.equal(JSON.parse(JSON.stringify(r)).job, undefined, 'the send is not sent to the browser');
    assert.equal((await r.job).state, 'drafted');
    let post = loadPost(db, id);
    assert.equal(post.status, 'approved', 'the post waits for its slot');
    const tk = post.publish.tiktok;
    assert.equal(tk.flow.mode, 'now');
    assert.equal(flowState(tk.flow), 'drafted');
    assert.equal(tk.flow.sound.name, 'Espresso');
    assert.equal(JSON.parse(readFileSync(path.join(tk.path, 'zernio-request.tiktok.json'), 'utf8')).tiktokSettings.draft, true);
    assert.equal(post.publish.instagram, undefined, 'Instagram waits for the slot');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM notifications').n, 0, 'TikTok tells the owner of a new draft itself');
    assert.deepEqual(await sendWaitingDrafts(ctx, { t: at('2026-10-13', '09:05') }), [], 'never sent twice');

    const p = await publishPost(ctx, id, { t: slot });
    assert.ok(p.ok && p.reminded);
    post = loadPost(db, id);
    assert.equal(post.status, 'published');
    assert.equal(post.publish.instagram.via, 'dry');
    assert.equal(post.publish.tiktok.flow.sentAt, tk.flow.sentAt, 'the draft was not sent again');
    assert.equal(flowState(post.publish.tiktok.flow), 'waiting');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM steps WHERE post_id = ? AND step = 'tiktok'", id).n, 1);
    const n = db.all('SELECT * FROM notifications');
    assert.deepEqual(n.map((x) => x.kind), ['reminder']);
    assert.match(n[0].title, /הגיעה השעה לפרסם בטיקטוק/);
    assert.ok(n[0].body.includes('Espresso') && n[0].body.includes('בתיבת הטיוטות'), n[0].body);
    assert.equal(n[0].url, `/post/${id}`);

    // After the slot: no fallback, no second reminder; the owner's post, when it comes, is found for its numbers.
    assert.deepEqual(await watchDrafts(ctx, { t: slot + 3 * 3_600_000, list: async () => [] }), []);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM notifications').n, 1);
    const mine = async () => [{ id: 'ext3', publishedAt: new Date(slot + 4 * 3_600_000).toISOString(), content: loadPost(db, id).caption.split('\n')[0], url: 'https://tiktok/ext3' }];
    assert.deepEqual(await watchDrafts(ctx, { t: slot + 5 * 3_600_000, list: mine }), [{ post: id, state: 'mine' }]);
  } finally {
    cleanup();
  }
});

test('no draft on Shabbat or for a paused account (hard rule 9 and the rails): it goes when they let it', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await queued(home, at('2026-10-18', '12:45'));
    setNow(at('2026-10-17', '10:00'));
    const r = approve(ctx, owner, { id });
    assert.match(r.message, /הטיוטה תישלח לטיקטוק כש.+ייגמר/);
    const held = await r.job;
    assert.equal(held.state, 'held');
    assert.equal(held.code, 'shabbat');
    assert.equal(loadPost(db, id).publish?.tiktok, undefined);
    // Saturday night, a paused account: still held.
    pauseAccount(db, 'demo', 'kill', 'test');
    const paused = await sendWaitingDrafts(ctx, { t: at('2026-10-17', '21:00') });
    assert.equal(paused[0].code, 'paused');
    resumeAccount(db, 'demo');
    const sent = await sendWaitingDrafts(ctx, { t: at('2026-10-17', '21:05') });
    assert.deepEqual(sent.map((x) => x.state), ['drafted']);
    assert.equal(loadPost(db, id).publish.tiktok.flow.mode, 'now');
  } finally {
    cleanup();
  }
});

test('a reminder comes late when the server was down at the hour, but not twelve hours late', async () => {
  const { home, cleanup } = tempHome();
  try {
    const slot = at('2026-10-13', '08:00');
    const { ctx, db, id } = await queued(home, slot);
    setNow(at('2026-10-13', '07:00'));
    await approve(ctx, owner, { id }).job;
    const p = await publishPost(ctx, id, { t: slot + 13 * 3_600_000 });
    assert.ok(p.ok);
    assert.equal(p.reminded, false);
    assert.ok(loadPost(db, id).publish.tiktok.flow.missedAt);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'reminder'").n, 0);
  } finally {
    cleanup();
  }
});

test('approval taken back after the draft went: the owner is told to delete it in the app, and a new approval sends a new one', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id, pack } = await queued(home, at('2026-10-13', '12:45'));
    setNow(at('2026-10-13', '09:00'));
    await approve(ctx, owner, { id }).job;
    const u = unapprove(ctx, owner, { id });
    assert.match(u.message, /מחקו אותה באפליקציה/);
    let post = loadPost(db, id);
    assert.equal(post.status, 'queued');
    assert.equal(post.publish.tiktok, undefined);
    assert.equal(post.publish.oldDrafts.length, 1);
    const html = postPage({ csrf: 'x' }, { post, pack, steps: [], metrics: [], takedowns: [] });
    assert.match(html, /טיוטה ישנה של הפוסט הזה נמצאת בתיבת הטיוטות של טיקטוק/);
    assert.match(html, /old-drafts-deleted/);

    assert.equal((await approve(ctx, owner, { id }).job).state, 'drafted', 'a new approval, a new draft');
    post = loadPost(db, id);
    assert.equal(post.publish.oldDrafts.length, 1);
    assert.match(postPage({ csrf: 'x' }, { post, pack, steps: [], metrics: [], takedowns: [] }), /טיקטוק: בטיוטות של טיקטוק[\s\S]*תזכורת ב-12:45/);
    oldDraftsDeleted(ctx, owner, { id });
    assert.equal(loadPost(db, id).publish.oldDrafts, undefined);

    const rejected = reject(ctx, owner, { id }, { reason: 'x' });
    assert.match(rejected.message, /מחקו אותה באפליקציה/);
    assert.equal(loadPost(db, id).publish.oldDrafts.length, 1);
    // A rejection writes a replacement beside the answer (src/pipeline/redo.js): it finishes before the folder goes.
    await rejected.job;
  } finally {
    cleanup();
  }
});

// The owner, 2026-11-11: "let someone change his mind and delete a scheduled post" (src/web/actions.js deletePost).

test('a scheduled post deleted after its draft went: it never goes out, the draft is the owner\'s to delete in the app, and its page says "נמחק"', async () => {
  const { home, cleanup } = tempHome();
  try {
    const slot = at('2026-10-13', '12:45');
    const { ctx, db, id, pack } = await queued(home, slot);
    setNow(at('2026-10-13', '09:00'));
    await approve(ctx, owner, { id }).job;
    const r = deletePost(ctx, owner, { id }, { reason: 'topic', redo: '0' });
    assert.equal(r.message, 'הפוסט נמחק ולא ייצא. פוסט אחר לאותו יום נכתב עכשיו ויגיע לאישור בעוד כמה דקות. הטיוטה הקודמת כבר בתיבת הטיוטות של טיקטוק: מחקו אותה באפליקציה.');
    let post = loadPost(db, id);
    assert.deepEqual([post.status, post.reject.deleted, post.reject.redo], ['rejected', true, 'declined']);
    assert.equal(post.publish.tiktok, undefined);
    assert.equal(post.publish.oldDrafts.length, 1);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'delete_post' AND post_id = ?", id).n, 1);
    // At its hour nothing is sent: publishPost refuses a post that is not approved, and leaves it as it is.
    await assert.rejects(publishPost(ctx, id, { t: slot }), (e) => e.code === 'not_approved');
    post = loadPost(db, id);
    assert.equal(post.status, 'rejected');
    assert.equal(post.publish.instagram, undefined, 'nothing went to Instagram');
    const html = postPage({ csrf: 'x' }, { post, pack, steps: [], metrics: [], takedowns: [] });
    assert.match(html, /<span class="chip ghost">נמחק<\/span>/);
    assert.match(html, /טיוטה ישנה של הפוסט הזה נמצאת בתיבת הטיוטות של טיקטוק/);
    assert.doesNotMatch(html, /\/delete"|\/reject"|publish-now/, 'nothing left to delete or send');
    // The day's other post, written beside the answer, finishes before the folder goes.
    await r.job;
  } finally {
    cleanup();
  }
});

test('deleted a moment after the approval, while its draft is on its way: the draft that lands is kept as an old one, and the answer says to delete it', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id, pack } = await queued(home, at('2026-10-13', '12:45'));
    setNow(at('2026-10-13', '09:00'));
    const a = approve(ctx, owner, { id });
    assert.ok(loadPost(db, id).publish.tiktok.uploading, 'on its way');
    const r = deletePost(ctx, owner, { id }, { reason: 'tone', redo: '0' });
    assert.match(r.message, /^הפוסט נמחק ולא ייצא\. .* הטיוטה של הפוסט שנמחק בדרך לאפליקציה של טיקטוק: כשתגיע, מחקו אותה שם\.$/);
    assert.equal((await a.job).state, 'drafted');
    const post = loadPost(db, id);
    assert.equal(post.status, 'rejected');
    assert.equal(post.publish.tiktok, undefined, "no longer the post's draft");
    assert.equal(post.publish.oldDrafts.length, 1);
    assert.match(postPage({ csrf: 'x' }, { post, pack, steps: [], metrics: [], takedowns: [] }), /טיוטה ישנה של הפוסט הזה נמצאת בתיבת הטיוטות של טיקטוק/);
    await r.job;
  } finally {
    cleanup();
  }
});

test('only a scheduled post is deleted: one going out right now, one waiting for approval and one already out are refused, and say why', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await queued(home, at('2026-10-13', '12:45'));
    const refused = (status, re, code = 400) => {
      db.update('posts', id, { status });
      assert.throws(() => deletePost(ctx, owner, { id }, { reason: 'topic' }), (e) => re.test(e.message) && e.status === code, status);
      assert.equal(loadPost(db, id).status, status, `${status}: untouched`);
    };
    // publishPost marks a post 'publishing' before it sends anything: it is not stopped halfway.
    refused('publishing', /^הפוסט עולה ממש עכשיו, אז כבר אי אפשר למחוק אותו\.$/, 409);
    refused('queued', /^הפוסט עוד מחכה לאישור\. אם הוא לא מתאים, אפשר לדחות אותו\.$/);
    refused('published', /^אפשר למחוק רק פוסט מתוזמן שעוד לא עלה\.$/);
    refused('drafted', /^אפשר למחוק רק פוסט מתוזמן שעוד לא עלה\.$/);
    assert.throws(() => deletePost(ctx, owner, { id: 'nope' }, {}), (e) => e.status === 404);
  } finally {
    cleanup();
  }
});

test('a scheduled post\'s page: "לפרסם עכשיו" leads, "ביטול אישור" beside it, and apart, small and red, "למחוק את הפוסט" opens the reason form as a deletion; one held for a connection leads with connecting', async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id, pack } = await queued(home, at('2026-10-13', '12:45'));
    const page = () => postPage({ csrf: 'x' }, postFull(ctx, id));
    // Waiting for approval: the rejection form, as before.
    let html = page();
    assert.match(html, new RegExp(`action="/post/${id}/reject"`));
    assert.match(html, /למה לדחות\?[\s\S]*>לדחות<\/button>[\s\S]*>לדחות ולכתוב מחדש<\/button>/);
    assert.doesNotMatch(html, /\/delete"|למחוק/);

    db.update('posts', id, { status: 'approved', approved_by: 'owner' });
    html = page();
    assert.doesNotMatch(html, /\/reject"/);
    assert.match(html, new RegExp(`<form class="rejectbox" id="reject-${id}" method="post" action="/post/${id}/delete">`));
    assert.match(html, /למה למחוק\?[\s\S]*אחרי המחיקה מגיע פוסט אחר לאותו יום[\s\S]*<button class="btn danger" type="submit" name="redo" value="0">למחוק<\/button><button class="btn" type="submit" name="redo" value="1">למחוק ולכתוב מחדש<\/button>/);
    const bar = /<div class="actionbar">([\s\S]*?)<\/div>\n/.exec(html)[1];
    assert.match(bar, /class="btn primary"[^>]*>לפרסם עכשיו/);
    assert.match(bar, /ביטול אישור/);
    assert.doesNotMatch(bar, /למחוק/, 'the deletion is not in the bar beside the main button');
    assert.match(html, new RegExp(`<button class="btn sm ghost danger" type="button" data-toggle="#reject-${id}" aria-expanded="false">.*למחוק את הפוסט</button>`));
    assert.ok(html.indexOf('לפרסם עכשיו') < html.indexOf('למחוק את הפוסט'));
    // The card of an approved post (src/web/pages.js postCard): "מחיקה" beside "ביטול אישור", and the card leaves the list.
    const card = postCard({ csrf: 'x' }, loadPost(db, id), pack);
    assert.match(card, new RegExp(`data-toggle="#reject-${id}"[^>]*>.*מחיקה</button>`));
    assert.match(card, new RegExp(`action="/post/${id}/delete" data-ajax="remove"`));

    // Held for a connection (src/publish/hold.js): connecting is the main button, the deletion the same as above.
    db.update('posts', id, { status: 'held', reason: 'מחכה שתחברו את טיקטוק. אחרי החיבור המצגת תעלה בשעה הפנויה הבאה.' });
    html = page();
    assert.match(html, /<div class="actionbar"><a class="btn primary" href="\/accounts\?account=demo#connect-demo">לחבר<\/a><\/div>/);
    assert.match(html, new RegExp(`action="/post/${id}/delete"`));
    assert.doesNotMatch(html, /publish-now|unapprove/);

    // Out: nothing to delete here (a takedown is something else).
    db.update('posts', id, { status: 'published', published_at: new Date().toISOString() });
    assert.doesNotMatch(page(), /\/delete"|למחוק את הפוסט/);
  } finally {
    cleanup();
  }
});

test('the slot waits for a draft on its way; one cut off mid-send is sent at the slot, and the reminder goes with it', async () => {
  const { home, cleanup } = tempHome();
  try {
    const slot = at('2026-10-13', '12:45');
    const { ctx, db, id } = await queued(home, slot);
    db.update('posts', id, { status: 'approved', approved_by: 'owner', publish_json: { tiktok: { via: 'dry', uploading: new Date(slot - 60_000).toISOString(), tries: 1 } } });
    await assert.rejects(publishPost(ctx, id, { t: slot }), (e) => e.code === 'draft_in_flight');
    assert.equal(loadPost(db, id).status, 'approved', 'the next tick tries again');
    const p = await publishPost(ctx, id, { t: slot + 20 * 60_000 });
    assert.ok(p.ok && p.reminded);
    const post = loadPost(db, id);
    assert.equal(post.publish.tiktok.flow.mode, 'now');
    assert.equal(post.publish.tiktok.draft, true);
    assert.equal(post.publish.instagram.via, 'dry');
  } finally {
    cleanup();
  }
});

test('a device that turns notifications off is forgotten', () => {
  const db = new Db(':memory:');
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/a' });
  subscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/b' });
  assert.equal(unsubscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/a' }), 1);
  assert.equal(unsubscribe(db, { endpoint: 'https://fcm.googleapis.com/fcm/send/zz' }), 0);
  assert.deepEqual(db.all('SELECT endpoint FROM push_subs').map((r) => r.endpoint), ['https://fcm.googleapis.com/fcm/send/b']);
});
