import path from 'node:path';
import { isSet } from '../core/env.js';
import { ofHome } from '../core/paths.js';
import { PLATFORM_LIST } from '../core/platforms.js';
import { j } from '../db/index.js';
import { alertOperator } from '../notify/operator.js';

// Whether posts really leave this server, and what a post that did not is called.
//
// A post leaves only with PUBLISH_MODE=live and the publisher's key (src/publish/index.js publisherFor): anything less
// and the dry publisher writes it to disk, with the request it would have sent, and the post is done ('published', its
// parts { via: 'dry', status: 'written' }) and never sent again. The owner, 2026-11-04: "Posts don't go out silently:
// if PUBLISH_MODE isn't live or ZERNIO_API_KEY is missing, alert the operator at startup and once a day, and make /all
// show it in red. A customer never sees a post as "published" when it was only written to disk." So:
//
//   - the runner tells the operator (src/notify/operator.js, key publishing-off) on its first beat after a start and
//     on every beat after it, the alert's own window (a day) keeping it to once a day (src/autonomy/runner.js)
//   - /all shows the operator the same words in red, at the top (src/web/pages.js allPage)
//   - a post written to disk and nothing else is 'written' wherever a post's state is shown, and is in no count of
//     published posts: the chip, the post's page, home's "פורסמו היום", Posts, the account's week, Results, the day's
//     summary and the weekly and monthly emails (diskOnly below). Its stored status stays 'published'.

/** What keeps every post on the dry publisher, [] when nothing does: 'PUBLISH_MODE' (not live), 'ZERNIO_API_KEY' (unset). */
export function notLive(env = process.env) {
  const off = [];
  if (env.PUBLISH_MODE !== 'live') off.push('PUBLISH_MODE');
  if (!isSet('ZERNIO_API_KEY', env)) off.push('ZERNIO_API_KEY');
  return off;
}

/**
 * The alert's words, and /all's: what is off, that nothing goes out, and what to set. The operator's, so technical.
 * { head, title (head, with "Teder: " before it as every alert has), body }. `mark` is given each Latin part as it is
 * (a page isolates them, `<bdi>`, so a path keeps its slashes where they are); the alert's text has none of that.
 */
export function notLiveWords(off, env = process.env, { mark = (x) => x } = {}) {
  const mode = String(env.PUBLISH_MODE ?? '').trim();
  const said = [];
  if (off.includes('PUBLISH_MODE')) said.push(mode ? `${mark('PUBLISH_MODE')} הוא ${mark(`"${mode}"`)} ולא ${mark('live')}.` : `${mark('PUBLISH_MODE')} לא מוגדר, ולכן הוא לא ${mark('live')}.`);
  if (off.includes('ZERNIO_API_KEY')) said.push(`${mark('ZERNIO_API_KEY')} לא מוגדר.`);
  said.push('כל פוסט שמגיעה השעה שלו נכתב לדיסק ולא נשלח לטיקטוק, לאינסטגרם או לפייסבוק, והלקוח רואה אותו כ"לא נשלח".');
  const set = [off.includes('PUBLISH_MODE') ? mark('PUBLISH_MODE=live') : '', off.includes('ZERNIO_API_KEY') ? mark('ZERNIO_API_KEY') : ''].filter(Boolean).join(' ו-');
  said.push(`כדי לפרסם באמת צריך ${set} ב-${mark(path.join(ofHome(env), '.env'))}, ואז ${mark('systemctl restart openfrequency')}.`);
  const head = 'הפרסום כבוי, ופוסטים לא יוצאים לרשתות';
  return { head, title: `Teder: ${head}`, body: said.join(' ') };
}

/**
 * Tell the operator when posts are not going out. Returns what alertOperator does: true when it was said now, false when
 * it was said within the day (or publishing is live). `opts` are alertOperator's (t, run, fetchImpl), and its env.
 */
export async function alertNotLive(ctx, { env = process.env, ...opts } = {}) {
  const off = notLive(env);
  if (!off.length) return false;
  const { title, body } = notLiveWords(off, env);
  return alertOperator(ctx, 'publishing-off', { title, body }, { env, ...opts });
}

/** A post's publish record, from the post (publish) or its row (publish_json); {} for none. */
const recordOf = (publish) => (typeof publish === 'string' ? j(publish, null) : publish) || {};
/** A platform's part that was sent somewhere: a platform skipped (not connected) is not one. */
const sent = (r) => Boolean(r && typeof r === 'object' && r.via && !r.skipped);

/** The platforms a post's parts were sent to, in order: ['tiktok', 'instagram']. */
export const sentPlatforms = (publish) => {
  const rec = recordOf(publish);
  return PLATFORM_LIST.filter((p) => sent(rec[p]));
};

/**
 * A post's publish record (an object, or its JSON) of which nothing left the server: every part it sent the dry
 * publisher wrote to disk. The demo's posts (scripts/demo.js) say demo on their parts: they are shown as out, as its
 * made-up numbers are.
 */
export function diskOnly(publish) {
  const rec = recordOf(publish);
  const parts = sentPlatforms(rec).map((p) => rec[p]);
  return parts.length > 0 && parts.every((r) => r.via === 'dry' && !r.demo);
}

/**
 * A post's state as a page shows it: 'written' for a published post that was only written to disk; 'deleted' for a
 * scheduled post its owner deleted (src/web/actions.js deletePost: a rejection, said as a deletion); else its status.
 */
export const shownStatus = (post) => (post?.status === 'published' && diskOnly(post.publish ?? post.publish_json) ? 'written' : post?.status === 'rejected' && post.reject?.deleted ? 'deleted' : post?.status);
