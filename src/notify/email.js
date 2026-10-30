import { DAY, monthKey, now, nowIso } from '../core/clock.js';
import { OPERATOR_PAUSES } from '../autonomy/rails.js';
import { localFetch } from '../core/net.js';
import { getSetting, setSetting, settings } from '../core/store.js';
import { oneLine } from '../rules/overlay.js';
import { israelDate, israelInstant, weekday } from '../schedule/israel.js';
import { workspaceAllowed } from '../billing/entitlement.js';
import { connectLine, unconnectedPlatforms } from '../publish/hold.js';

// What the owner hears by email. Teder writes the words; openfrequency-accounts sends them to the workspace's owners
// (and keeps their own opt-out):
//
//   POST {OF_ACCOUNTS_INTERNAL}/internal/notify, bearer OF_INTERNAL_TOKEN
//   { workspace, product: "teder", kind, subject, text, html, link }  ->  202 { ok: true, sent }
//
// Accounts builds the email from `text` alone (html is checked and ignored), so the text carries everything, the
// link included. A subject is at most 200 characters (cut to 150 there: we cut it to 150 here), the text 5,000, the body
// 256 KB; the link must be https on openfrequency.co.il or a subdomain, so PUBLIC_HOST has to be one. Accounts refuses
// for good what it will refuse again (400 a field, 404 no such workspace, 409 Teder off for it, 413 too large, 429 three
// of a kind in 24 hours for the workspace): that email is given up at once, 409 and 429 without a word in the log.
// Anything else (down, a timeout, a 5xx) is tried again.
//
//   posts_waiting   once a day, after the day's posts are written (a batch still running is waited for), when posts wait
//                   for approval: how many, and that a post not approved by the end of its day does not go out
//   weekly          Sunday at 09:00 Israel time: the week's posts out, what waits, what is scheduled for the week ahead
//   monthly         the 1st at 09:00: last month's results, as the Results page reads them (posts out, views and likes
//                   where the platforms gave them, the most viewed post)
//   connect_needed  posts held because nothing is connected (src/publish/hold.js), at most once a day
//   publish_failed  a post that did not go out and will not be tried again by itself, once per post
//
// Every email is found from the database at a tick, like the assistant's events, so nothing in the pipeline has to
// remember to send one, and one missed while the server was down is found when it is back (within its own window).
// Each is sent once (settings email:sent:<key>). A send that fails is tried again later, four times at most; nothing
// here throws into the runner. A workspace that has not paid gets none, and each kind can be turned off by the customer
// in Settings (email:prefs:<workspace>). The link is always to Teder's public name (https://PUBLIC_HOST): without one on
// openfrequency.co.il there is nothing accounts would link to, and no email is sent.

export const EMAIL_KINDS = ['posts_waiting', 'weekly', 'monthly', 'connect_needed', 'publish_failed'];
/** Each kind as the Settings page offers it. */
export const EMAIL_HE = {
  posts_waiting: 'כשמצגות חדשות מחכות לאישור',
  weekly: 'סיכום שבועי, ביום ראשון בבוקר',
  monthly: 'דוח תוצאות בתחילת כל חודש',
  connect_needed: 'כשמצגות מחכות לחיבור של טיקטוק או אינסטגרם',
  publish_failed: 'כשמצגת לא עלתה',
};
export const WEEKLY_AT = { day: 0, at: '09:00' };
export const MONTHLY_AT = '09:00';
/** Waits before each retry of a send that failed; after the last one it is given up. */
export const RETRY_MIN = [15, 60, 180];
const MAX_PER_TICK = 25;
const MIN_TOKEN = 32;
export const MAX_SUBJECT = 150;
export const MAX_TEXT = 5000;
/** Accounts' answers that will be the same next time: the email is given up. */
const FINAL = new Set([400, 404, 409, 413, 429]);
/** Of those, the ones that are normal (Teder off for the workspace, its daily limit): not logged. */
const QUIET = new Set([409, 429]);
/** The link accounts accepts: https on openfrequency.co.il or a subdomain, on the default port. */
export const linkHostOk = (host) => /^([a-z0-9-]+\.)*openfrequency\.co\.il$/.test(String(host || ''));

const MONTH_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthHe = (key) => `${MONTH_HE[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ------------------------------------------------------------------ the customer's choices */

/** Which emails a workspace gets: every kind unless the customer turned it off. */
export function emailPrefsOf(db, workspaceId) {
  const saved = getSetting(db, `email:prefs:${workspaceId}`, {}) || {};
  return Object.fromEntries(EMAIL_KINDS.map((k) => [k, saved[k] !== false]));
}

/** Save a workspace's choices: { kind: boolean }, anything not named is on. */
export function setEmailPrefs(db, workspaceId, prefs, { by = null } = {}) {
  const out = Object.fromEntries(EMAIL_KINDS.map((k) => [k, prefs[k] !== false]));
  setSetting(db, `email:prefs:${workspaceId}`, { ...out, by, at: nowIso() });
  return out;
}

/* ------------------------------------------------------------------ the client */

/** The link base (https://PUBLIC_HOST) and the sender. `fetchImpl` replaces the network for the tests. */
export function notifyClient({ env = process.env, fetchImpl = localFetch, timeoutMs = 5000, log = () => {} } = {}) {
  const base = String(env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  const host = String(env.PUBLIC_HOST || '').trim().toLowerCase();
  return {
    // Without a public name on openfrequency.co.il there is no link accounts would take, and so no email.
    configured: token.length >= MIN_TOKEN && linkHostOk(host),
    link: (p) => `https://${host}${p}`,
    /** One email. Returns { ok, status, final } (final: accounts will refuse it again); never throws. */
    async send(payload) {
      const body = { ...payload, subject: String(payload.subject || '').slice(0, MAX_SUBJECT), text: String(payload.text || '').slice(0, MAX_TEXT) };
      try {
        const r = await fetchImpl(`${base}/internal/notify`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        let answer = null;
        try {
          answer = await r.json();
        } catch {
          /* the status says enough */
        }
        if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, final: false };
        if (!QUIET.has(r.status)) log(`[email] ${payload.kind} for workspace ${payload.workspace}: accounts answered ${r.status}${answer?.error ? ` ${answer.error}` : ''}`);
        return { ok: false, status: r.status, final: FINAL.has(r.status) };
      } catch (e) {
        log(`[email] ${payload.kind} for workspace ${payload.workspace}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
        return { ok: false, status: null, final: false };
      }
    },
  };
}

/* ------------------------------------------------------------------ the words */

const lines = (...xs) => xs.flat().filter((x) => x != null && x !== '');
/** The plain text, and the same as simple HTML, the link last. */
function message({ subject, body, link, label }) {
  return {
    subject,
    text: `${body.join('\n')}\n\n${label}: ${link}`,
    html: `<div dir="rtl" lang="he">${body.map((l) => `<p>${esc(l)}</p>`).join('')}<p><a href="${esc(link)}">${esc(label)}</a></p></div>`,
    link,
  };
}

const many = (n, one, few) => (n === 1 ? one : few.replace('{n}', num(n)));

/** posts_waiting. `per` is [{ name, n }], one per account. */
export function postsWaitingEmail({ per, link }) {
  const n = per.reduce((a, x) => a + x.n, 0);
  return message({
    subject: many(n, 'מצגת אחת מחכה לאישור', '{n} מצגות מחכות לאישור'),
    body: lines(many(n, 'מצגת חדשה מחכה לאישור שלכם בתדר.', '{n} מצגות חדשות מחכות לאישור שלכם בתדר.'), per.length > 1 ? per.filter((x) => x.n).map((x) => `${x.name}: ${num(x.n)}`) : [], 'מצגת שלא תאשרו עד סוף היום שלה לא תעלה.'),
    link,
    label: 'לאישור המצגות',
  });
}

/** weekly. `per` is [{ name, published, views, waiting, scheduled }]. */
export function weeklyEmail({ per, link }) {
  const sum = (k) => per.reduce((a, x) => a + (x[k] || 0), 0);
  const pub = sum('published');
  const views = per.some((x) => x.views != null) ? sum('views') : null;
  const waiting = sum('waiting');
  const scheduled = sum('scheduled');
  return message({
    subject: 'השבוע שלכם בתדר',
    body: lines(
      pub ? `${many(pub, 'בשבוע שעבר עלתה מצגת אחת', 'בשבוע שעבר עלו {n} מצגות')}${views ? `, ו${pub === 1 ? 'היא נצפתה' : 'הן נצפו'} ${num(views)} פעמים` : ''}.` : 'בשבוע שעבר לא עלו מצגות.',
      waiting ? many(waiting, 'מצגת אחת מחכה לאישור שלכם.', '{n} מצגות מחכות לאישור שלכם.') : '',
      scheduled ? many(scheduled, 'מצגת אחת מתוזמנת לשבוע הקרוב.', '{n} מצגות מתוזמנות לשבוע הקרוב.') : 'לשבוע הקרוב עוד אין מצגות מתוזמנות.',
      per.length > 1 ? per.map((x) => `${x.name}: ${num(x.published)} עלו, ${num(x.waiting)} מחכות, ${num(x.scheduled)} מתוזמנות`) : []
    ),
    link,
    label: 'לתדר',
  });
}

/** monthly. `per` is [{ name, published, views, likes, best: { hook, views } | null }], `month` YYYY-MM. */
export function monthlyEmail({ month, per, link }) {
  const sum = (k) => (per.some((x) => x[k] != null) ? per.reduce((a, x) => a + (x[k] || 0), 0) : null);
  const pub = per.reduce((a, x) => a + x.published, 0);
  const views = sum('views');
  const likes = sum('likes');
  const best = per.map((x) => x.best).filter(Boolean).sort((a, b) => b.views - a.views)[0] || null;
  const m = monthHe(month);
  return message({
    subject: `דוח התוצאות של ${m}`,
    body: lines(
      `${many(pub, `ב${m} עלתה מצגת אחת`, `ב${m} עלו {n} מצגות`)}.`,
      views != null ? `${pub === 1 ? 'היא נצפתה' : 'הן נצפו'} ${num(views)} פעמים${likes != null ? ` וקיבלו ${num(likes)} לייקים` : ''}.` : 'את מספרי הצפיות עוד לא קיבלנו מטיקטוק ומאינסטגרם. הם יופיעו בדף התוצאות.',
      best && best.views ? `הכי נצפתה "${oneLine(best.hook || '')}", עם ${num(best.views)} צפיות.` : '',
      per.length > 1 ? per.map((x) => `${x.name}: ${num(x.published)} מצגות${x.views != null ? `, ${num(x.views)} צפיות` : ''}`) : []
    ),
    link,
    label: 'לכל התוצאות',
  });
}

/** connect_needed. `per` is [{ name, held, platforms }]. */
export function connectNeededEmail({ per, link }) {
  const platforms = [...new Set(per.flatMap((x) => x.platforms))];
  return message({
    subject: connectLine(platforms.length ? platforms : ['tiktok']),
    body: lines(
      per.map((x) => `${many(x.held, 'מצגת מאושרת אחת מחכה', '{n} מצגות מאושרות מחכות')} לחיבור ב${x.name}.`),
      'החיבור לוקח דקה או שתיים, ואחרי זה המצגות יעלו בשעות הפנויות הבאות.'
    ),
    link,
    label: 'לחיבור',
  });
}

/**
 * publish_failed. `paused` is 'ours' when the account waits for the operator (a platform's strike, the kill switch:
 * src/autonomy/rails.js OPERATOR_PAUSES), any other truthy value when the owner can switch it on again. A reason with
 * the engine's English in it is left out: the post's page says it in Hebrew.
 */
export function publishFailedEmail({ name, hook, reason, paused, link }) {
  const said = reason && !/[A-Za-z]{4,}/.test(reason) ? reason : '';
  return message({
    subject: `המצגת "${oneLine(hook || '').slice(0, 60)}" לא עלתה`,
    body: lines(`המצגת "${oneLine(hook || '')}" של ${name} לא עלתה.`, said, paused === 'ours' ? 'החשבון הושהה, ומצגות לא עולות בו בינתיים. אנחנו בודקים מה קרה ונחזור אליכם.' : paused ? 'החשבון הושהה, ומצגות לא יעלו עד שמפעילים אותו מחדש בדף החשבון.' : 'בדף המצגת רואים מה קרה, ויש שם כפתור לנסות שוב.'),
    link,
    label: 'לדף המצגת',
  });
}

/* ------------------------------------------------------------------ what is due */

/** The accounts of each workspace there is an owner to tell: on air, of a workspace that has paid. */
function workspacesOf(ctx, t) {
  const by = new Map();
  for (const pack of ctx.packs) {
    const acc = ctx.db.get('SELECT workspace_id, status, paused_reason FROM accounts WHERE id = ?', pack.id);
    if (!acc || acc.workspace_id == null || acc.status === 'onboarding' || !workspaceAllowed(ctx.db, acc.workspace_id, t)) continue;
    if (!by.has(acc.workspace_id)) by.set(acc.workspace_id, []);
    by.get(acc.workspace_id).push({ pack, status: acc.status, pausedReason: acc.paused_reason });
  }
  return by;
}

/** Latest reading per post and platform, summed over these posts: { views, likes } (null when none was read). */
function numbersOf(db, postIds) {
  if (!postIds.length) return { views: null, likes: null, per: new Map() };
  const rows = db.all(`SELECT post_id, views, likes FROM metrics WHERE post_id IN (${postIds.map(() => '?').join(', ')}) AND id IN (SELECT MAX(id) FROM metrics GROUP BY post_id, platform)`, ...postIds);
  const per = new Map();
  for (const r of rows) {
    const x = per.get(r.post_id) || { views: null, likes: null };
    if (r.views != null) x.views = (x.views || 0) + r.views;
    if (r.likes != null) x.likes = (x.likes || 0) + r.likes;
    per.set(r.post_id, x);
  }
  const total = (k) => ([...per.values()].some((x) => x[k] != null) ? [...per.values()].reduce((a, x) => a + (x[k] || 0), 0) : null);
  return { views: total('views'), likes: total('likes'), per };
}

/** Each email due now, for one workspace: [{ key, kind, build }]. */
function due(ctx, ws, accounts, { t, link }) {
  const { db } = ctx;
  const today = israelDate(t);
  const iso = (ms) => new Date(ms).toISOString();
  const name = (p) => p.meta.displayName;
  const home = accounts.length > 1 ? '/all' : `/posts?account=${encodeURIComponent(accounts[0].pack.id)}`;
  const out = [];
  const count = (sql, ...a) => db.get(sql, ...a).n;

  // posts_waiting: today's posts written (no batch still running), and some wait.
  const generated = accounts.some(({ pack }) => getSetting(db, `generated:${pack.id}:${today}`));
  if (generated && !ctx.generating && t >= israelInstant(today, settings(db).generateAt).getTime()) {
    const per = accounts.map(({ pack }) => ({ name: name(pack), n: count("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'queued' AND sample = 0", pack.id) }));
    if (per.some((x) => x.n)) out.push({ key: `posts_waiting:${ws}:${today}`, kind: 'posts_waiting', build: () => postsWaitingEmail({ per, link: link(home) }) });
  }

  // weekly: Sunday morning, the seven days before it.
  const weekAt = israelInstant(today, WEEKLY_AT.at).getTime();
  if (weekday(today) === WEEKLY_AT.day && t >= weekAt && t - weekAt < 2 * DAY) {
    out.push({
      key: `weekly:${ws}:${today}`,
      kind: 'weekly',
      build: () => {
        const per = accounts.map(({ pack }) => {
          const pub = db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 0 AND status = 'published' AND published_at >= ? AND published_at < ?", pack.id, iso(weekAt - 7 * DAY), iso(weekAt)).map((r) => r.id);
          return {
            name: name(pack),
            published: pub.length,
            views: numbersOf(db, pub).views,
            waiting: count("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'queued' AND sample = 0", pack.id),
            scheduled: count("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'approved' AND slot_at >= ? AND slot_at < ?", pack.id, iso(t), iso(t + 7 * DAY)),
          };
        });
        return weeklyEmail({ per, link: link(home) });
      },
    });
  }

  // monthly: the 1st, last month's results.
  const monthAt = israelInstant(today, MONTHLY_AT).getTime();
  if (today.endsWith('-01') && t >= monthAt && t - monthAt < 3 * DAY) {
    const month = monthKey(t - 2 * DAY);
    const from = iso(israelInstant(`${month}-01`, '00:00').getTime());
    const to = iso(israelInstant(today, '00:00').getTime());
    const per = accounts.map(({ pack }) => {
      const posts = db.all("SELECT id, hook FROM posts WHERE account_id = ? AND sample = 0 AND status = 'published' AND published_at >= ? AND published_at < ?", pack.id, from, to);
      const m = numbersOf(db, posts.map((p) => p.id));
      const best = posts.map((p) => ({ hook: p.hook, views: m.per.get(p.id)?.views || 0 })).sort((a, b) => b.views - a.views)[0] || null;
      return { name: name(pack), published: posts.length, views: m.views, likes: m.likes, best };
    });
    if (per.some((x) => x.published)) out.push({ key: `monthly:${ws}:${month}`, kind: 'monthly', build: () => monthlyEmail({ month, per, link: link(accounts.length > 1 ? '/results' : `/results?account=${encodeURIComponent(accounts[0].pack.id)}`) }) });
  }

  // connect_needed: posts held because nothing is connected, once a day.
  const held = accounts.map(({ pack }) => ({ pack, name: name(pack), held: count("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'held'", pack.id), platforms: unconnectedPlatforms(db, pack) })).filter((x) => x.held);
  if (held.length) {
    const first = held[0].pack.id;
    out.push({ key: `connect_needed:${ws}:${today}`, kind: 'connect_needed', build: () => connectNeededEmail({ per: held, link: link(`/accounts?account=${encodeURIComponent(first)}#connect-${encodeURIComponent(first)}`) }) });
  }

  // publish_failed: a post that failed for good in the last two days, once per post.
  for (const { pack, status, pausedReason } of accounts) {
    const paused = status === 'paused' ? (OPERATOR_PAUSES.includes(pausedReason) ? 'ours' : 'yours') : null;
    for (const p of db.all("SELECT id, hook, reason FROM posts WHERE account_id = ? AND status = 'failed' AND sample = 0 AND updated_at >= ?", pack.id, iso(t - 2 * DAY))) {
      out.push({ key: `publish_failed:${p.id}`, kind: 'publish_failed', build: () => publishFailedEmail({ name: name(pack), hook: p.hook, reason: p.reason, paused, link: link(`/post/${encodeURIComponent(p.id)}`) }) });
    }
  }
  return out;
}

/**
 * The runner's pass: find what is due and send it. `send` replaces the client's sender for the tests. Returns
 * { sent, failed, off } or null when emails cannot be sent here (no token, no public name).
 */
export async function emailTick(ctx, { t = now(), env = process.env, client = null } = {}) {
  const c = client || notifyClient({ env, log: (m) => ctx.log?.(m) });
  if (!c.configured) return null;
  const { db } = ctx;
  const out = { sent: 0, failed: 0, off: 0 };
  let budget = MAX_PER_TICK;
  for (const [ws, accounts] of workspacesOf(ctx, t)) {
    const prefs = emailPrefsOf(db, ws);
    for (const e of due(ctx, ws, accounts, { t, link: c.link })) {
      const key = `email:sent:${e.key}`;
      const had = getSetting(db, key, null);
      if (had?.state === 'sent' || had?.state === 'off' || had?.state === 'gave_up') continue;
      if (!prefs[e.kind]) {
        setSetting(db, key, { state: 'off', at: new Date(t).toISOString() });
        out.off++;
        continue;
      }
      if (had?.state === 'failed' && t < Date.parse(had.retryAt)) continue;
      if (budget-- <= 0) return out;
      let r;
      try {
        r = await c.send({ workspace: ws, product: 'teder', kind: e.kind, ...e.build() });
      } catch (x) {
        ctx.log?.(`[email] ${e.key}: ${x.message}`);
        r = { ok: false };
      }
      if (r.ok) {
        setSetting(db, key, { state: 'sent', at: new Date(t).toISOString() });
        out.sent++;
      } else {
        const tries = (had?.tries || 0) + 1;
        // Refused for good (a limit, Teder off, a field): not sent again. Down or slow: again later.
        const wait = r.final ? null : RETRY_MIN[tries - 1];
        setSetting(db, key, wait == null ? { state: 'gave_up', at: new Date(t).toISOString(), tries, status: r.status ?? null } : { state: 'failed', at: new Date(t).toISOString(), tries, retryAt: new Date(t + wait * 60_000).toISOString() });
        out.failed++;
      }
    }
  }
  return out;
}

