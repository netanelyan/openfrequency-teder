import { oneLine } from '../rules/overlay.js';
import { MAX_HASHTAGS, hashtagsIn } from '../rules/caption.js';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { HOUR, now, nowIso } from '../core/clock.js';
import { dataDir, ensureDir, outDir } from '../core/paths.js';
import { audit, settings, step } from '../core/store.js';
import { j } from '../db/index.js';
import { restAt } from '../schedule/shabbat.js';
import { israelDate } from '../schedule/israel.js';
import { verifyFact } from '../verify/claims.js';
import { documentYears, formatOfPost, gateDraft, loadPost, postDraft } from '../pipeline/build.js';
import { exportPost } from '../pipeline/export.js';
import { imageCredit, waitingImages } from '../images/index.js';
import { canRun, pauseAccount, publishErrorStreak } from '../autonomy/rails.js';
import { isStrike, postBody, publishZernio, trendingSound, zernioConfigured } from './zernio.js';
import { assignSound } from '../pipeline/sounds.js';
import { notify } from '../notify/index.js';
import { instagramConfigured, isRefusal, isThrottle, isTokenProblem, publishInstagram } from './instagram.js';
import { zernioAccountId } from './connect.js';
import { OWN_APP, publishTikTokApp, tiktokAppConfigured } from './tiktok-app.js';
import { heldReason, needsConnection } from './hold.js';
import { publishErrorHe } from './errors.js';

// Publishing one approved post, through the rails, to each of its pack's
// platforms, each by the publisher the pack names for it:
//
//   "publishers": { "tiktok": "zernio", "instagram": "zernio" }
//
// zernio      through Zernio, to the account the customer connected into the
//             account's Zernio profile (src/publish/connect.js)
// instagram   directly through Meta's Graph API, our own Meta app (src/publish/instagram.js)
// auto        Instagram only: our own Meta app when it is set up for the account,
//             otherwise Zernio when the customer connected Instagram there
// own-app     TikTok only: our own TikTok app, not built yet (src/publish/tiktok-app.js)
// dry         to disk, with the exact request a publisher would have received
//
// THE DRY PUBLISHER IS THE DEFAULT. A platform's post leaves only when all three
// say so: PUBLISH_MODE=live in the environment, the publisher's credentials
// (ZERNIO_API_KEY; or the pack's Instagram token and account id), and the pack's
// own choice for that platform. Anything less writes it to disk.
//
// A post publishes platform by platform. A platform that is already out (or
// still being processed) is never sent again, so a post that went out on
// TikTok and was throttled on Instagram resumes on Instagram alone at the next
// tick. A throttle or a network error waits for the next tick, three times at
// most; anything else stops the post where it is.
//
// Before anything goes anywhere, every time:
//   - not on Shabbat or a yom tov (HARD RULE 9: the scheduler never plans such a
//     slot, and this refuses one anyway)
//   - no kill switch, the account not paused
//   - the post approved
//   - every fact verified again against its stored document, with its source
//     still approved, and the text still hashing to the token the gate issued.
//     A failure here is a failed fact check: the post is blocked and the account
//     paused.
//
// A post with nothing connected to send it to is held, not failed (src/publish/hold.js). What a failure says to the
// customer is Hebrew (src/publish/errors.js); the publisher's own words go to the post's steps and the log.

/** What the pack asks for on a platform, whether or not it can be done now. */
export const wantedPublisher = (pack, platform) => pack.meta.publishers?.[platform] || pack.meta.publisher || 'dry';

/** The publisher a platform's post will really go through now: 'zernio', 'instagram', 'own-app' or 'dry'. */
export function publisherFor(pack, platform, { db = null, env = process.env } = {}) {
  const want = wantedPublisher(pack, platform);
  if (env.PUBLISH_MODE !== 'live') return 'dry';
  if (want === 'zernio' && zernioConfigured()) return 'zernio';
  if (want === 'instagram' && platform === 'instagram' && db && instagramConfigured(db, pack, env)) return 'instagram';
  if (want === 'auto' && platform === 'instagram' && db) {
    if (instagramConfigured(db, pack, env)) return 'instagram';
    if (zernioConfigured() && zernioAccountId(db, pack, 'instagram')) return 'zernio';
  }
  if (want === OWN_APP && platform === 'tiktok' && tiktokAppConfigured()) return OWN_APP;
  return 'dry';
}

/** The publisher a dry post's request is written for: the one the pack asks for, with auto resolved as it would be live. */
const dryShape = (db, pack, platform) => {
  const want = wantedPublisher(pack, platform);
  return want === 'auto' ? (db && instagramConfigured(db, pack) ? 'instagram' : 'zernio') : want;
};

const MAX_ATTEMPTS = 3;

export class PublishRefused extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PublishRefused';
    this.code = code;
  }
}

/** Re-run the fact gate on a stored post. Returns the problems, empty when it still holds. */
export function recheck(db, post, pack) {
  const problems = [];
  const facts = post.facts.map((f) => {
    const v = verifyFact(db, f, { accountId: pack.id, maxQuoteWords: pack.rules.maxQuoteWords || 40 });
    if (!v.ok && post.slides.some((s) => s.factKeys.includes(f.key))) problems.push(`${f.key}: ${v.error}`);
    return { ...f, verified: v.ok };
  });
  // The years the post's own documents give were allowed on its cover when it was made (documentYears), and still are.
  const g = gateDraft(formatOfPost(db, pack, post), postDraft(post), facts, { allow: documentYears(db, facts) });
  problems.push(...g.problems);
  if (post.checks?.token && g.token !== post.checks.token) problems.push('the text changed after it was checked');
  return problems;
}

/**
 * How the pack's TikTok posts go out (zernio.tiktokMode). Instagram is not touched by any of them.
 *
 *   draft-now       the default: the moment a post is approved, TikTok's part goes to the app's inbox as a draft
 *                   with a sound from the account's list named for it (sendDraft below), and at the slot the owner
 *                   gets one reminder to publish it. Nothing is ever published to TikTok by the engine.
 *   draft-fallback  the draft goes at the slot, a reminder at half an hour, and at an hour a draft still not out is
 *                   published directly (src/publish/draft.js).
 *   direct          published at the slot.
 */
export const tiktokMode = (pack) => pack.meta.zernio?.tiktokMode || 'draft-now';

/** A reminder that comes this late is no use: a server down at the hour sends it later, but not after this. */
export const REMIND_LATE_HOURS = 12;

/** The reminder at the slot, draft-now's only notification: the account, the cover line, the sound. */
export function reminderNotice(pack, post, sound) {
  return {
    title: `${pack.meta.displayName}: הגיעה השעה לפרסם בטיקטוק`,
    body: [oneLine(post.hook), 'הטיוטה מחכה בתיבת הטיוטות של טיקטוק.', sound ? `סאונד: ${sound.name} · ${sound.artist}${sound.stale ? ' (ישן, החליפו ברשימה)' : ''}` : ''].filter(Boolean).join('\n'),
  };
}

/** A platform's caption as it goes out: TikTok the long one, Instagram the short one, then the credits and the tags. */
export const captionOf = (db, post, platform) => [platform === 'instagram' && post.caption_ig ? post.caption_ig : post.caption, imageCredit(db, post), (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n');

/** The words of the notification that a TikTok draft is waiting: the account, the cover line, the sound. */
export function draftNotice(pack, post, sound) {
  return {
    title: `${pack.meta.displayName}: טיוטה מחכה בטיקטוק`,
    body: [oneLine(post.hook), sound ? `סאונד: ${sound.name} · ${sound.artist}${sound.stale ? ' (ישן, החליפו ברשימה)' : ''}` : 'אין סאונד ברשימה: הוסיפו בדף הסאונדים', 'אם לא תפרסמו תוך שעה, הפוסט יעלה אוטומטית עם מוזיקה מהספרייה.'].join('\n'),
  };
}

/** Copy a post's slides to the public media folder Caddy serves; returns their URLs. */
export function publicUrls(post, platform) {
  const base = String(process.env.MEDIA_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) throw new PublishRefused('MEDIA_PUBLIC_BASE_URL is not an https address: Zernio and Instagram fetch slides by URL', 'no_media_url');
  const token = `${post.id}-${randomBytes(6).toString('hex')}`;
  // Readable by the web server on purpose: the service runs with umask 0077, and a slide only it could read would be
  // a 403 to Instagram and Zernio. Only this folder; the rest of the private folder stays the service's own.
  const root = ensureDir(path.join(dataDir(), 'public'));
  const dir = ensureDir(path.join(root, token));
  for (const d of [root, dir]) chmodSync(d, 0o755);
  return (post.media[platform] || []).map((f) => {
    const to = path.join(dir, path.basename(f));
    copyFileSync(f, to);
    chmodSync(to, 0o644);
    return `${base}/${token}/${path.basename(f)}`;
  });
}

/** Sound ids on the account's last few TikTok posts: the next post takes another. */
const RECENT_SOUNDS = 5;

/**
 * A trending Commercial Music Library track for the pack's next TikTok post, or
 * null for TikTok's own pick. `zernio.sound: "auto"` in pack.json keeps TikTok's
 * pick; `zernio.soundCountry` names the chart (Israel's by default).
 */
export async function soundFor(db, pack, accountId) {
  if (pack.meta.zernio?.sound === 'auto' || !accountId) return null;
  const recent = db
    .all("SELECT publish_json FROM posts WHERE account_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT ?", pack.id, RECENT_SOUNDS)
    .map((r) => j(r.publish_json, {}).tiktok?.sound?.id)
    .filter(Boolean);
  return trendingSound(accountId, { countryCode: pack.meta.zernio?.soundCountry || 'IL', recent });
}

/**
 * The rails every send meets, a post at its slot and a draft at its approval alike. Throws PublishRefused; a fact
 * that no longer holds also blocks the post and pauses the account.
 */
function mustBeSendable(db, pack, post, t, platforms, { stepName = 'publish', before = 'לפני פרסום' } = {}) {
  const rest = restAt(t);
  if (rest) throw new PublishRefused(`${rest}: לא מפרסמים עכשיו`, 'shabbat');
  const run = canRun(db, pack.id);
  if (!run.ok) throw new PublishRefused(run.why, 'paused');
  if (post.status !== 'approved') throw new PublishRefused(`the post is ${post.status}, not approved`, 'not_approved');
  // A photograph the screen could not clear waits for a person to look at it: every one on the post, not only the cover's.
  if (waitingImages(db, post).length) throw new PublishRefused('התמונה מחכה לבדיקה של אדם (דם, פציעה, סימן מים): אשרו אותה בדף הפוסט', 'image_review');

  const problems = recheck(db, post, pack);
  if (problems.length) {
    db.update('posts', post.id, { status: 'blocked', reason: `בדיקת העובדות נכשלה ${before}: ${problems[0]}`, updated_at: nowIso() });
    step(db, post.id, stepName, 'failed', { kind: 'fact_check', problems });
    throw new PublishRefused(`fact check failed ${stepName === 'publish' ? 'before publishing' : 'before the TikTok draft'}: ${problems[0]}`, 'fact_check');
  }

  // Five hashtags at most, counted on the caption as it would go out: the post's own and any a caption picked up.
  for (const platform of platforms) {
    const n = hashtagsIn(captionOf(db, post, platform)).length;
    if (n > MAX_HASHTAGS) throw new PublishRefused(`${n} hashtags in the ${platform} caption: ${MAX_HASHTAGS} at most`, 'hashtags');
  }
}

/** A platform's part that is out, or a draft in the app: never sent again. */
const done = (r) => r && !r.error && (r.status === 'published' || r.status === 'written' || r.pending || r.zernioId || r.mediaId || r.flow);

export async function publishPost(ctx, postId, { t = now() } = {}) {
  const { db } = ctx;
  const post = loadPost(db, postId);
  if (!post) throw new PublishRefused(`no post ${postId}`, 'missing');
  const pack = ctx.pack(post.account_id);
  if (!pack) throw new PublishRefused(`no pack for ${post.account_id}`, 'no_pack');

  mustBeSendable(db, pack, post, t, pack.meta.platforms);
  // A draft-now draft still on its way (approved a minute before the slot): the next tick publishes, with it in hand.
  // One cut off mid-send is sent again below, as a draft.
  const up = post.publish?.tiktok?.uploading;
  if (up && t - Date.parse(up) < UPLOAD_STUCK_MS) throw new PublishRefused('the TikTok draft is on its way', 'draft_in_flight');
  // TikTok gets the long caption; Instagram the short one, which repeats the cover line.
  const captionFor = (platform) => captionOf(db, post, platform);

  // Nothing connected anywhere the post has to go, and nothing of it out yet: held until the customer connects.
  const pending = pack.meta.platforms.filter((p) => !done(post.publish?.[p]));
  const missing = pending.filter((p) => needsConnection(db, pack, p));
  if (missing.length && missing.length === pack.meta.platforms.length) {
    db.update('posts', postId, { status: 'held', reason: heldReason(missing), updated_at: nowIso() });
    step(db, postId, 'publish', 'info', { held: missing });
    audit(db, { action: 'publish_held', accountId: pack.id, postId, detail: { platforms: missing } });
    return { postId, ok: false, held: true, via: 'none', results: post.publish || {}, retry: false, reminded: false };
  }

  db.update('posts', postId, { status: 'publishing', updated_at: nowIso() });
  const results = { ...(post.publish || {}) };
  const attempts = (Number(results._attempts) || 0) + 1;
  delete results._attempts;
  let drafted = null;
  let failed = null;
  let failedOn = null;
  const vias = {};
  for (const platform of pack.meta.platforms) {
    if (done(results[platform])) continue; // out already: never twice
    // Not connected while the post's other platform is: that one goes, this one is skipped.
    if (missing.includes(platform)) {
      results[platform] = { via: 'zernio', skipped: 'not_connected', at: new Date(t).toISOString() };
      continue;
    }
    const via = publisherFor(pack, platform, { db });
    vias[platform] = via;
    // A TikTok draft (draft-now, or draft-fallback): the post goes to the app's inbox with a sound from the account's
    // list named for it. The draft's Zernio id is not the post's (nothing is out yet).
    const mode = tiktokMode(pack);
    const asDraft = platform === 'tiktok' && mode !== 'direct';
    const flow = asDraft ? newFlow(db, pack, post, t) : null;
    try {
      if (asDraft) {
        results[platform] = { ...(await draftRequest(db, pack, post, via, t)), flow };
      } else if (via === 'zernio') {
        const accountId = zernioAccountId(db, pack, platform);
        results[platform] = await publishZernio({
          platform,
          accountId,
          caption: captionFor(platform),
          imageUrls: publicUrls(post, platform),
          privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY',
          aiLabel: Boolean(post.ai_label),
          title: oneLine(post.hook),
          sound: platform === 'tiktok' ? await soundFor(db, pack, accountId) : null,
        });
      } else if (via === 'instagram') {
        results[platform] = await publishInstagram(db, pack, { caption: captionFor(platform), imageUrls: publicUrls(post, platform), aiLabel: Boolean(post.ai_label), priorCreationId: results[platform]?.creationId || null });
      } else if (via === OWN_APP) {
        results[platform] = await publishTikTokApp({ caption: captionFor(platform), imageUrls: publicUrls(post, platform), privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY', asDraft: false });
      } else {
        const dir = path.join(outDir(), 'published', pack.id, israelDate(t), postId);
        exportPost(db, postId, dir);
        const urls = (post.media[platform] || []).map((f) => `<public url>/${path.basename(f)}`);
        const want = dryShape(db, pack, platform);
        const body =
          want === 'instagram'
            ? { graph: 'POST /{ig-user-id}/media for each slide (is_carousel_item), then media_type=CAROUSEL with children and caption, then POST /{ig-user-id}/media_publish', userId: pack.meta.instagram?.userId || '<instagram user id>', slides: urls, caption: `${captionFor(platform)}${post.ai_label ? '\n\n<AI line>' : ''}`.slice(0, 2200) }
            : postBody({ platform, accountId: zernioAccountId(db, pack, platform) || '<account id>', caption: captionFor(platform), imageUrls: urls, privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY', aiLabel: Boolean(post.ai_label), title: oneLine(post.hook) });
        writeFileSync(path.join(dir, `${want === 'instagram' ? 'instagram' : 'zernio'}-request.${platform}.json`), `${JSON.stringify(body, null, 2)}\n`);
        results[platform] = { via: 'dry', path: dir, status: 'written', wanted: want };
      }
    } catch (e) {
      results[platform] = { ...(results[platform] || {}), via, error: String(e.message).slice(0, 300), code: e.code || null, creationId: e.creationId || results[platform]?.creationId || null };
      failed = e;
      failedOn = platform;
      ctx.log?.(`[publish] ${postId} ${platform} via ${via}: ${e.message}`);
      break; // a platform that might have half-posted is never retried blind; stop here and report
    }
    if (asDraft && mode === 'draft-fallback') drafted = flow;
  }

  // An Instagram throttle, or a container still processing, clears by itself: try
  // again at a later tick, a few times. Instagram publishes only at media_publish
  // and every retry first asks whether the last container went out, so a retry
  // cannot post twice. A Zernio error is never retried blind: a lost answer to a
  // create can be a post that exists.
  const retry = Boolean(failed) && attempts < MAX_ATTEMPTS && (isThrottle(failed) || failed.retryable === true);
  const ok = !failed;
  // Draft-now: the slot's only TikTok act is one reminder, sent with the rest of the post; late if the server was down
  // at the hour, and not at all past REMIND_LATE_HOURS.
  const tk = results.tiktok;
  let remind = null;
  if (tk?.flow?.mode === 'now' && !tk.error && !tk.flow.remindedAt && !tk.flow.missedAt) {
    tk.flow.slotAt = post.slot_at || new Date(t).toISOString();
    if (t - Date.parse(tk.flow.slotAt) <= REMIND_LATE_HOURS * HOUR) remind = tk.flow;
    tk.flow[remind ? 'remindedAt' : 'missedAt'] = new Date(t).toISOString();
  }
  const status = ok ? 'published' : retry ? 'approved' : 'failed';
  db.update('posts', postId, {
    status,
    reason: ok ? null : `${retry ? 'ננסה שוב: ' : ''}${publishErrorHe(failed, failedOn)}`,
    publish_json: { ...results, ...(retry ? { _attempts: attempts } : {}) },
    published_at: ok ? new Date(t).toISOString() : null,
    updated_at: nowIso(),
  });
  step(db, postId, 'publish', ok ? 'ok' : 'failed', { via: vias, results, attempt: attempts, retry });
  audit(db, { action: ok ? 'published' : retry ? 'publish_retry' : 'publish_failed', accountId: pack.id, postId, detail: { via: vias } });

  if (failed && !retry) {
    // What the customer reads on the paused account is Hebrew; the publisher's own words are in the post's steps.
    const he = publishErrorHe(failed, failedOn);
    if (isStrike(failed) || isRefusal(failed)) pauseAccount(db, pack.id, 'strike', he);
    else if (isTokenProblem(failed)) pauseAccount(db, pack.id, 'publish_errors', he);
    else if (publishErrorStreak(db, pack.id) >= Number(settings(db).publishErrorStreak || 3)) pauseAccount(db, pack.id, 'publish_errors', he);
  }
  // The owner is told the draft is waiting, and which sound to add.
  if (drafted) {
    try {
      await notify(ctx, { accountId: pack.id, postId, kind: 'draft', ...draftNotice(pack, post, drafted.sound), url: `/post/${postId}` });
    } catch (e) {
      ctx.log?.(`notify ${postId}: ${e.message}`);
    }
  }
  if (remind) {
    try {
      await notify(ctx, { accountId: pack.id, postId, kind: 'reminder', ...reminderNotice(pack, post, remind.sound), url: `/post/${postId}` });
    } catch (e) {
      ctx.log?.(`notify ${postId}: ${e.message}`);
    }
  }
  const via = [...new Set(Object.values(vias))].join('+') || 'none';
  return { postId, ok, via, results, retry, reminded: Boolean(remind) };
}

/** A new draft's state: waiting for the owner, with a sound from the account's list named for it. */
function newFlow(db, pack, post, t) {
  const at = new Date(t).toISOString();
  return { ...(tiktokMode(pack) === 'draft-now' ? { mode: 'now' } : {}), state: 'waiting', sentAt: at, slotAt: post.slot_at || at, sound: assignSound(db, pack.id, { t }), remindedAt: null };
}

/** One TikTok draft through `via`: to Zernio (or our own app, once built), or to disk with the exact request Zernio would have received. */
async function draftRequest(db, pack, post, via, t) {
  const accountId = zernioAccountId(db, pack, 'tiktok');
  const args = { platform: 'tiktok', caption: captionOf(db, post, 'tiktok'), privacy: pack.meta.zernio?.tiktokPrivacy || 'SELF_ONLY', aiLabel: Boolean(post.ai_label), title: oneLine(post.hook), asDraft: true };
  if (via === 'zernio') {
    const { zernioId, ...rest } = await publishZernio({ ...args, accountId, imageUrls: publicUrls(post, 'tiktok') });
    return { ...rest, draftId: zernioId };
  }
  if (via === OWN_APP) return publishTikTokApp({ caption: args.caption, imageUrls: publicUrls(post, 'tiktok'), privacy: args.privacy, asDraft: true });
  const dir = path.join(outDir(), 'published', pack.id, israelDate(t), post.id);
  exportPost(db, post.id, dir);
  const urls = (post.media.tiktok || []).map((f) => `<public url>/${path.basename(f)}`);
  writeFileSync(path.join(dir, 'zernio-request.tiktok.json'), `${JSON.stringify(postBody({ ...args, accountId: accountId || '<account id>', imageUrls: urls }), null, 2)}\n`);
  return { via: 'dry', path: dir, status: 'written', wanted: wantedPublisher(pack, 'tiktok'), draft: true };
}

/** A draft that did not take is tried again at the next ticks, this many times in all. */
const DRAFT_TRIES = 3;
/** A send that has been on its way this long was cut off (the server stopped mid-send). */
const UPLOAD_STUCK_MS = 15 * 60_000;

/**
 * Draft-now: an approved post's TikTok part goes to the app's inbox as a draft now, not at the slot. The post stays
 * approved, and at the slot publishPost sends Instagram as always and the owner one reminder.
 *
 * The draft meets every rail a post at its slot meets. HARD RULE 9: a draft is a write to TikTok, so none goes on
 * Shabbat or a yom tov. A draft the rails hold is sent at the runner's first tick that lets it through
 * (sendWaitingDrafts), and at the slot by publishPost at the latest.
 *
 * Returns { state: 'drafted' | 'held' | 'blocked' | 'failed' | 'skip', why, code }.
 */
export async function sendDraft(ctx, postId, { t = now() } = {}) {
  const { db } = ctx;
  const post = loadPost(db, postId);
  const pack = post && ctx.pack(post.account_id);
  if (!pack || tiktokMode(pack) !== 'draft-now' || !pack.meta.platforms.includes('tiktok')) return { state: 'skip', why: 'not draft-now' };
  const had = post.publish?.tiktok;
  const tries = Number(had?.tries) || 0;
  if (had?.uploading && t - Date.parse(had.uploading) < UPLOAD_STUCK_MS) return { state: 'skip', why: 'on its way' };
  if (had && !had.error && !had.uploading) return { state: 'skip', why: 'sent already' };
  if (tries >= DRAFT_TRIES) return { state: 'skip', why: 'gave up' };
  try {
    mustBeSendable(db, pack, post, t, ['tiktok'], { stepName: 'tiktok', before: 'לפני השליחה לטיקטוק' });
  } catch (e) {
    if (!(e instanceof PublishRefused)) throw e;
    return { state: e.code === 'fact_check' ? 'blocked' : 'held', why: e.message, code: e.code };
  }
  // Nothing connected on TikTok: no draft is tried (it could only fail); the post waits for the connection.
  if (needsConnection(db, pack, 'tiktok')) return { state: 'held', why: heldReason(['tiktok']), code: 'not_connected' };

  // Written before anything is sent, and before the first await: a tick or a click that comes while the draft is on
  // its way sends no other. One cut off mid-send is sent again after UPLOAD_STUCK_MS, so the inbox may then hold two
  // of it: a draft is only ever the owner's to publish or delete, never a post that is out.
  const via = publisherFor(pack, 'tiktok', { db });
  // Only TikTok's part is written, onto the post as it is then: the rest of it may have moved during the upload.
  const saveTiktok = (tk) => db.update('posts', postId, { publish_json: { ...(loadPost(db, postId)?.publish || {}), tiktok: tk }, updated_at: nowIso() });
  saveTiktok({ via, uploading: new Date(t).toISOString(), tries: tries + 1 });
  const flow = newFlow(db, pack, post, t);
  let tk;
  try {
    tk = { ...(await draftRequest(db, pack, post, via, t)), flow };
  } catch (e) {
    tk = { via, error: String(e.message).slice(0, 300), code: e.code || null, tries: tries + 1 };
    saveTiktok(tk);
    step(db, postId, 'tiktok', 'failed', { flow: 'draft', via, error: tk.error, attempt: tries + 1 });
    if (tries + 1 >= DRAFT_TRIES) {
      await notify(ctx, { accountId: pack.id, postId, kind: 'draft_failed', title: `${pack.meta.displayName}: הטיוטה לא הגיעה לטיקטוק`, body: `${oneLine(post.hook)}\n${publishErrorHe(e, 'tiktok')}`, url: `/post/${postId}` }).catch((x) => ctx.log?.(`notify ${postId}: ${x.message}`));
    }
    return { state: 'failed', why: tk.error };
  }
  saveTiktok(tk);
  step(db, postId, 'tiktok', 'ok', { flow: 'draft', via });
  audit(db, { action: 'tiktok_draft', accountId: pack.id, postId, detail: { via } });
  return { state: 'drafted', via };
}

/** The runner's pass: approved draft-now posts whose TikTok draft is not in the app yet, a few per account. */
export async function sendWaitingDrafts(ctx, { t = now(), perAccount = 3 } = {}) {
  const out = [];
  for (const pack of ctx.packs) {
    if (tiktokMode(pack) !== 'draft-now' || !pack.meta.platforms.includes('tiktok')) continue;
    const rows = ctx.db.all("SELECT id, publish_json FROM posts WHERE account_id = ? AND status = 'approved' ORDER BY slot_at", pack.id);
    const want = rows.filter((r) => {
      const tk = j(r.publish_json, {}).tiktok;
      return !tk || (tk.error && (Number(tk.tries) || 0) < DRAFT_TRIES) || (tk.uploading && t - Date.parse(tk.uploading) >= UPLOAD_STUCK_MS);
    });
    for (const r of want.slice(0, perAccount)) {
      const res = await sendDraft(ctx, r.id, { t });
      if (res.state !== 'skip') out.push({ post: r.id, ...res });
      if (['shabbat', 'paused', 'not_connected'].includes(res.code)) break; // the same answer for the account's other posts
    }
  }
  return out;
}

/**
 * A post whose draft is in TikTok's inbox, taken back (approval cancelled, rejected, edited): the draft stays in the
 * app, and only the owner can delete it there. It is kept on the post as `oldDrafts` until they say they did, and an
 * edited post that stays approved gets a fresh draft. Returns whether there was one.
 */
export function retireDraft(db, post) {
  const tk = post.publish?.tiktok;
  if (!tk?.flow || tk.flow.mode !== 'now') return false;
  const results = { ...post.publish };
  results.oldDrafts = [...(results.oldDrafts || []), { sentAt: tk.flow.sentAt, draftId: tk.draftId || null, via: tk.via }];
  delete results.tiktok;
  db.update('posts', post.id, { publish_json: results, updated_at: nowIso() });
  return true;
}
