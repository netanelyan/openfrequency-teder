import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { HOUR, now, nowIso } from '../core/clock.js';
import { outDir } from '../core/paths.js';
import { audit, step } from '../core/store.js';
import { j } from '../db/index.js';
import { oneLine } from '../rules/overlay.js';
import { restAt } from '../schedule/shabbat.js';
import { rulesFor } from '../schedule/choice.js';
import { israelDate } from '../schedule/israel.js';
import { loadPost } from '../pipeline/build.js';
import { exportPost } from '../pipeline/export.js';
import { waitingImages } from '../images/index.js';
import { approvedByPerson, canRun } from '../autonomy/rails.js';
import { notify } from '../notify/index.js';
import { externalPosts, matchDraft, postBody, publishZernio, zernioConfigured } from './zernio.js';
import { captionOf, publicUrls, publisherFor, recheck, soundFor, tiktokModeFor } from './index.js';
import { zernioAccountId } from './connect.js';

const MINUTE = 60_000;

// Draft-fallback, after the slot (pack.json zernio.tiktokMode: "draft-fallback").
//
// At the slot a TikTok post goes to the app's inbox as a draft, with a sound from the account's list named for it
// (src/publish/index.js), and the owner is told. Then, at every tick:
//
//   - the account's TikTok posts that did not go through Zernio are read (Zernio's analytics, source=external, the
//     read the metrics use) and matched to the draft by its caption: a match is the owner's post, and the watch ends;
//   - at REMIND_MIN after the slot, the owner is reminded once;
//   - at FALLBACK_MIN, a draft still not out is published directly, the same post, with a Commercial Music Library
//     track, through every rail a post at its slot goes through (Shabbat waits, a paused account waits, the facts are
//     checked again, a photograph waiting for a person waits), and the owner is told to delete the draft;
//   - for WATCH_HOURS after that, a draft the owner publishes late is a duplicate: it is flagged, never deleted.
//
// NEVER TWICE. The state is written before the direct publish is sent ('sending'), and a post found in that state is
// never sent again: a call whose answer was lost may be a post that is out. It becomes 'failed', and the owner is
// told to look.
//
// Instagram is not touched: it went out at the slot as always.
//
// Draft-now (the default mode) sends its draft at approval and its one reminder at the slot (src/publish/index.js);
// here its drafts are only matched to the owner's post, so the numbers can be read. Never a fallback.
//
// A post whose only part sent is its TikTok draft is 'drafted', not published, until the owner's post is found here
// (or the fallback publishes it): only then is it out, and only then counted in results, summaries and emails.
//
// The fallback publishes a post straight to the profile, which TikTok allows only on its owner's preview and consent:
// it runs only for a post a person approved, never one the engine approved (src/publish/index.js tiktokModeFor), and
// never on a customer's account, which is draft-now.

export const REMIND_MIN = 30;
export const FALLBACK_MIN = 60;
export const WATCH_HOURS = 24;

/** A drafted post is out once the owner's post is found, or the fallback's: published, as of then. */
function nowOut(db, post, t) {
  if (loadPost(db, post.id)?.status === 'drafted') db.update('posts', post.id, { status: 'published', published_at: new Date(t).toISOString(), updated_at: nowIso() });
}

/** What a TikTok draft post is now, in the owner's words. */
export const FLOW_HE = {
  drafted: ['בטיוטות של טיקטוק', 'ghost'],
  waiting: ['טיוטה מחכה לך', 'sig'],
  mine: ['פורסם על ידך', 'ok'],
  sending: ['מפרסם אוטומטית', 'warn'],
  fallback: ['פורסם אוטומטית', 'warn'],
  duplicate: ['פורסם פעמיים', 'bad'],
  failed: ['הפרסום האוטומטי נכשל', 'bad'],
  stopped: ['נעצר בבדיקה', 'bad'],
};

/** A flow's key in FLOW_HE: a draft-now draft before its hour is only sitting in the drafts; at the hour it waits for you. */
export const flowState = (flow) => (flow?.mode === 'now' && flow.state === 'waiting' && !flow.remindedAt ? 'drafted' : flow?.state);

/** The line under a draft that waits: its sound, and what happens next. */
export function draftNote(flow, slotAt, timeOf) {
  const sound = flow.sound ? `סאונד: ${flow.sound.name} · ${flow.sound.artist}` : 'בלי סאונד מהרשימה';
  if (flow.mode !== 'now') return `${sound} · עולה אוטומטית ב-${timeOf(new Date(Date.parse(slotAt) + FALLBACK_MIN * MINUTE).toISOString())}`;
  return flow.remindedAt ? `${sound} · השעה הגיעה: פרסמו מהטיוטות` : `${sound} · תזכורת ב-${timeOf(slotAt)}`;
}

const save = (db, postId, results) => db.update('posts', postId, { publish_json: results, updated_at: nowIso() });

/**
 * One pass over every account's TikTok drafts. `list(pack, from)` reads the account's external TikTok posts
 * (Zernio's by default), and `send` replaces the push for the tests. Returns what happened, per post.
 */
export async function watchDrafts(ctx, { t = now(), list = null, send = null } = {}) {
  const { db } = ctx;
  const out = [];
  for (const pack of ctx.packs) {
    const rows = db.all("SELECT id FROM posts WHERE account_id = ? AND publish_json LIKE '%\"flow\"%' AND published_at >= ?", pack.id, new Date(t - (WATCH_HOURS + 6) * HOUR).toISOString());
    const posts = rows.map((r) => loadPost(db, r.id)).filter((p) => ['waiting', 'sending', 'fallback'].includes(p.publish?.tiktok?.flow?.state));
    if (!posts.length) continue;
    // The account's external posts, read once per pass, from the oldest draft's sending.
    let ext = null;
    const external = async () => {
      if (ext) return ext;
      const from = Math.min(...posts.map((p) => Date.parse(p.publish.tiktok.flow.sentAt))) - 10 * MINUTE;
      const accountId = zernioAccountId(db, pack, 'tiktok');
      try {
        ext = list ? await list(pack, from) : zernioConfigured() && accountId ? await externalPosts(accountId, { from }) : [];
      } catch (e) {
        ctx.log?.(`drafts ${pack.id}: ${e.message}`);
        ext = [];
      }
      return ext;
    };
    // An external post claimed by one draft is no other draft's.
    const claimed = db
      .all("SELECT publish_json FROM posts WHERE account_id = ? AND publish_json LIKE '%externalId%'", pack.id)
      .map((r) => j(r.publish_json, {}).tiktok?.flow?.externalId)
      .filter(Boolean);
    for (const post of posts) {
      const results = post.publish;
      const flow = results.tiktok.flow;
      const slot = Date.parse(flow.slotAt);
      const said = (kind, title, body) => notify(ctx, { accountId: pack.id, postId: post.id, kind, title, body, url: `/post/${post.id}` }, { send }).catch((e) => ctx.log?.(`notify ${post.id}: ${e.message}`));
      const head = oneLine(post.hook);

      if (flow.state === 'sending') {
        // Found mid-send: the answer was lost, and the post may be out. Never sent again.
        flow.state = 'failed';
        flow.error = 'הפרסום האוטומטי נקטע באמצע: בדקו בטיקטוק אם הפוסט עלה';
        save(db, post.id, results);
        await said('fallback_failed', `${pack.meta.displayName}: לא ברור אם הפוסט עלה`, `${head}\n${flow.error}`);
        out.push({ post: post.id, state: 'failed' });
        continue;
      }

      if (flow.state === 'fallback') {
        if (t - Date.parse(flow.fallback.at) > WATCH_HOURS * HOUR) continue;
        const m = matchDraft({ caption: post.caption, sentAt: flow.sentAt }, await external(), claimed);
        if (!m) continue;
        // The draft went out after the fallback did: two of the same post. Flagged for the owner; nothing is deleted.
        Object.assign(flow, { state: 'duplicate', externalId: m.id, externalUrl: m.url, foundAt: new Date(t).toISOString() });
        claimed.push(m.id);
        save(db, post.id, results);
        step(db, post.id, 'tiktok', 'failed', { flow: 'duplicate', external: m.id, url: m.url });
        audit(db, { action: 'tiktok_duplicate', accountId: pack.id, postId: post.id, detail: { external: m.id } });
        await said('duplicate', `${pack.meta.displayName}: הפוסט עלה פעמיים בטיקטוק`, `${head}\nהטיוטה פורסמה אחרי הפרסום האוטומטי: מחקו אחד מהשניים.`);
        out.push({ post: post.id, state: 'duplicate' });
        continue;
      }

      // ---- waiting
      const m = matchDraft({ caption: post.caption, sentAt: flow.sentAt }, await external(), claimed);
      if (m) {
        Object.assign(flow, { state: 'mine', externalId: m.id, externalUrl: m.url, foundAt: new Date(t).toISOString() });
        // The post's numbers are read from the owner's post (Zernio's analytics take an external id too).
        results.tiktok.zernioId = m.id;
        claimed.push(m.id);
        save(db, post.id, results);
        nowOut(db, post, t);
        step(db, post.id, 'tiktok', 'ok', { flow: 'mine', external: m.id, url: m.url });
        out.push({ post: post.id, state: 'mine' });
        continue;
      }
      // Draft-now: the reminder went with the slot (src/publish/index.js), and the engine never publishes it itself.
      if (flow.mode === 'now') continue;
      if (t >= slot + FALLBACK_MIN * MINUTE) {
        out.push({ post: post.id, ...(await fallback(ctx, pack, post, { t, said })) });
        continue;
      }
      if (t >= slot + REMIND_MIN * MINUTE && !flow.remindedAt) {
        flow.remindedAt = new Date(t).toISOString();
        save(db, post.id, results);
        const s = flow.sound;
        await said('reminder', `${pack.meta.displayName}: הטיוטה עוד מחכה`, `${head}${s ? `\nסאונד: ${s.name} · ${s.artist}` : ''}\nבעוד ${FALLBACK_MIN - REMIND_MIN} דקות הפוסט יעלה אוטומטית.`);
        out.push({ post: post.id, state: 'reminded' });
      }
    }
  }
  return out;
}

/** The same post, published directly with a Commercial Music Library track, through the rails. */
async function fallback(ctx, pack, post, { t, said }) {
  const { db } = ctx;
  const results = post.publish;
  const flow = results.tiktok.flow;
  // The rails a post at its slot meets, met again: they wait, and the draft waits with them.
  const rest = restAt(t, rulesFor(db, pack));
  if (rest) return { state: 'waiting', why: rest };
  const run = canRun(db, pack.id);
  if (!run.ok) return { state: 'waiting', why: run.why };
  if (waitingImages(db, post).length) return { state: 'waiting', why: 'image review' };
  if (tiktokModeFor(db, pack, post) !== 'draft-fallback') return { state: 'waiting', why: 'the account is no longer in draft-fallback, or no person approved the post' };
  const problems = recheck(db, post, pack);
  if (problems.length) {
    flow.state = 'stopped';
    flow.error = `בדיקת העובדות נכשלה לפני הפרסום האוטומטי: ${problems[0]}`;
    save(db, post.id, results);
    step(db, post.id, 'tiktok', 'failed', { flow: 'stopped', kind: 'fact_check', problems });
    await said('fallback_failed', `${pack.meta.displayName}: הפרסום האוטומטי נעצר`, `${oneLine(post.hook)}\n${flow.error}`);
    return { state: 'stopped' };
  }

  // Written before anything is sent: a post found 'sending' is never sent again.
  flow.state = 'sending';
  save(db, post.id, results);
  const via = publisherFor(pack, 'tiktok', { db });
  try {
    let r;
    if (via === 'zernio') {
      const accountId = zernioAccountId(db, pack, 'tiktok');
      r = await publishZernio({
        platform: 'tiktok', accountId, caption: captionOf(db, post, 'tiktok'), imageUrls: publicUrls(post, 'tiktok'), privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY',
        // Direct, label and all (HARD RULE 4): a platform that refuses the label refuses the post, never takes it unlabelled.
        aiLabel: Boolean(post.ai_label), aiAsDraft: false, title: oneLine(post.hook), sound: await soundFor(db, pack, accountId),
        consented: approvedByPerson(post),
      });
    } else {
      const dir = path.join(outDir(), 'published', pack.id, israelDate(t), post.id);
      exportPost(db, post.id, dir);
      const urls = (post.media.tiktok || []).map((f) => `<public url>/${path.basename(f)}`);
      const body = postBody({ platform: 'tiktok', accountId: zernioAccountId(db, pack, 'tiktok') || '<account id>', caption: captionOf(db, post, 'tiktok'), imageUrls: urls, privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY', aiLabel: Boolean(post.ai_label), aiAsDraft: false, title: oneLine(post.hook) });
      writeFileSync(path.join(dir, 'zernio-request.tiktok.fallback.json'), `${JSON.stringify(body, null, 2)}\n`);
      r = { via: 'dry', path: dir, status: 'written' };
    }
    flow.state = 'fallback';
    flow.fallback = { at: new Date(t).toISOString(), via, zernioId: r.zernioId || null, url: r.url || null, sound: r.sound || null };
    if (r.zernioId) results.tiktok.zernioId = r.zernioId;
    save(db, post.id, results);
    nowOut(db, post, t);
    step(db, post.id, 'tiktok', 'ok', { flow: 'fallback', via, zernioId: r.zernioId || null });
    audit(db, { action: 'tiktok_fallback', accountId: pack.id, postId: post.id, detail: { via } });
    await said('fallback', `${pack.meta.displayName}: פורסם אוטומטית`, `${oneLine(post.hook)}\nהפוסט עלה עם מוזיקה מהספרייה. מחקו את הטיוטה מתיבת הטיוטות בטיקטוק.`);
    return { state: 'fallback' };
  } catch (e) {
    flow.state = 'failed';
    flow.error = String(e.message).slice(0, 300);
    save(db, post.id, results);
    step(db, post.id, 'tiktok', 'failed', { flow: 'failed', error: flow.error });
    await said('fallback_failed', `${pack.meta.displayName}: הפרסום האוטומטי נכשל`, `${oneLine(post.hook)}\nהטיוטה עדיין בתיבה: פרסמו אותה בעצמכם. (${flow.error})`);
    return { state: 'failed' };
  }
}
