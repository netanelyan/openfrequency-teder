import { DAY, now, nowIso } from '../core/clock.js';
import { j } from '../db/index.js';

// The rivals an account's owner watches, written in by hand: their handle, the
// cover lines that did best for them, the formats they post, when they post,
// and the gaps they leave. The engine never reads a rival's account itself: a
// rival's posts are someone else's page, and the one fetch door refuses
// Instagram's business_discovery and every social web page (src/core/net.js).
// So the owner looks, the way a person scrolls their niche, and types what they
// saw here.
//
// What is typed is planning input, said to the writer: the gaps steer the
// topic and angle in the outline, the hooks and formats tell the slides what
// the niche already sees so the cover stands out from it, never copies it. Their
// posting times are shown beside the account's own slots; the slots stay the
// pack's (Shabbat, festivals and the posting windows are not the rivals' call).
//
// A rival not updated in RIVALS.staleDays is marked for a look; past
// RIVALS.dropDays it no longer reaches the writer, because a niche moves and
// last season's hooks steer wrong.

export const RIVALS = {
  min: 3, // fewer is allowed, but the page asks for more
  max: 5,
  hooks: 5,
  formats: 5,
  times: 6,
  staleDays: 30,
  dropDays: 60,
  lineChars: 120,
  gapChars: 400,
};

export const RIVAL_PLATFORMS = ['tiktok', 'instagram'];

const lines = (s) =>
  String(s ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/** "18:00, 9:30 21:15" → ['09:30', '18:00', '21:15'], or the parts that are not a time. */
export function parseTimes(s) {
  const ok = [];
  const bad = [];
  for (const t of String(s ?? '').split(/[\s,;،]+/).filter(Boolean)) {
    const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(t);
    if (m) ok.push(`${m[1].padStart(2, '0')}:${m[2]}`);
    else bad.push(t);
  }
  return { times: [...new Set(ok)].sort(), bad };
}

/** A handle as the platform shows it, without the @. */
export const cleanHandle = (s) => String(s ?? '').trim().replace(/^@+/, '').replace(/^https?:\/\/(?:www\.)?(?:tiktok\.com\/@|instagram\.com\/)/i, '').replace(/[/?#].*$/, '');

/**
 * A rival as the form sent it, made into a row's fields, and what is wrong with it. Pure.
 * { rival: { handle, platform, hooks, formats, times, gaps }, problems: [] }
 */
export function readRival(form) {
  const problems = [];
  const handle = cleanHandle(form.handle);
  if (!/^[A-Za-z0-9._]{2,30}$/.test(handle)) problems.push('שם משתמש: אותיות לועזיות, ספרות, נקודה וקו תחתון, עד 30');
  const platform = String(form.platform || '');
  if (!RIVAL_PLATFORMS.includes(platform)) problems.push('פלטפורמה: טיקטוק או אינסטגרם');
  const hooks = lines(form.hooks);
  if (!hooks.length) problems.push('לפחות שורת פתיחה אחת שעבדה להם');
  if (hooks.length > RIVALS.hooks) problems.push(`עד ${RIVALS.hooks} שורות פתיחה`);
  const formats = lines(form.formats);
  if (formats.length > RIVALS.formats) problems.push(`עד ${RIVALS.formats} פורמטים`);
  const long = [...hooks, ...formats].find((l) => l.length > RIVALS.lineChars);
  if (long) problems.push(`שורה ארוכה מ-${RIVALS.lineChars} תווים: "${long.slice(0, 30)}…"`);
  const { times, bad } = parseTimes(form.times);
  if (bad.length) problems.push(`שעות בצורה 18:30: "${bad.join(', ')}"`);
  if (times.length > RIVALS.times) problems.push(`עד ${RIVALS.times} שעות`);
  const gaps = String(form.gaps ?? '').replace(/\s+/g, ' ').trim();
  if (gaps.length > RIVALS.gapChars) problems.push(`הפערים: עד ${RIVALS.gapChars} תווים`);
  return { rival: { handle, platform, hooks, formats, times, gaps }, problems };
}

const rowOut = (r, t = now()) => {
  const age = Math.floor((t - Date.parse(r.updated_at)) / DAY);
  return {
    id: r.id,
    accountId: r.account_id,
    handle: r.handle,
    platform: r.platform,
    hooks: j(r.hooks_json, []),
    formats: j(r.formats_json, []),
    times: j(r.times_json, []),
    gaps: r.gaps || '',
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    age,
    state: age >= RIVALS.dropDays ? 'dropped' : age >= RIVALS.staleDays ? 'stale' : 'fresh',
  };
};

/** An account's rivals, most recently updated first, each with its age in days and its state (fresh, stale, dropped). */
export function rivalsOf(db, accountId, { t = now() } = {}) {
  return db.all('SELECT * FROM rivals WHERE account_id = ? ORDER BY updated_at DESC, id DESC', accountId).map((r) => rowOut(r, t));
}

/**
 * Save a rival from the form: a new one, or the one `id` names. Returns { id } or { problems }.
 * A sixth rival, or a handle the account already has on that platform, is refused.
 */
export function saveRival(db, accountId, form, { by = null } = {}) {
  const { rival, problems } = readRival(form);
  const id = form.id ? Number(form.id) : null;
  const have = db.all('SELECT id, handle, platform FROM rivals WHERE account_id = ?', accountId);
  if (id && !have.some((r) => r.id === id)) return { problems: ['אין מתחרה כזה בחשבון הזה'] };
  if (!id && have.length >= RIVALS.max) problems.push(`עד ${RIVALS.max} מתחרים לחשבון: עדכנו או הסירו אחד`);
  if (have.some((r) => r.id !== id && r.platform === rival.platform && r.handle.toLowerCase() === rival.handle.toLowerCase())) problems.push(`@${rival.handle} כבר ברשימה`);
  if (problems.length) return { problems };
  const row = { handle: rival.handle, platform: rival.platform, hooks_json: rival.hooks, formats_json: rival.formats, times_json: rival.times, gaps: rival.gaps, updated_at: nowIso(), updated_by: by };
  if (id) {
    db.update('rivals', id, row);
    return { id };
  }
  return { id: db.insert('rivals', { account_id: accountId, ...row, created_at: row.updated_at }) };
}

export function removeRival(db, accountId, id) {
  const r = db.get('SELECT * FROM rivals WHERE id = ? AND account_id = ?', Number(id), accountId);
  if (!r) return null;
  db.run('DELETE FROM rivals WHERE id = ?', r.id);
  return rowOut(r);
}

/** The rivals that still steer the writer: those updated within RIVALS.dropDays. */
export const plannable = (rivals) => rivals.filter((r) => r.state !== 'dropped');

const PLATFORM_EN = { tiktok: 'TikTok', instagram: 'Instagram' };

/**
 * The niche as the outline is told it: the gaps the rivals leave (a topic in one is worth more), and what the
 * niche already posts. "" with no rival to say.
 */
export function nicheForOutline(rivals) {
  const rs = plannable(rivals);
  if (!rs.length) return '';
  const gaps = rs.filter((r) => r.gaps);
  return [
    `THE NICHE (${rs.length === 1 ? 'one account' : `${rs.length} accounts`} like this one, as the owner saw them; never name or copy them):`,
    ...rs.map((r) => `- @${r.handle} (${PLATFORM_EN[r.platform] || r.platform})${r.formats.length ? `, posts: ${r.formats.join(' / ')}` : ''}${r.gaps ? `. What it leaves out: ${r.gaps}` : ''}`),
    gaps.length ? 'Where the documents allow, pick the topic and angle in one of the gaps above: what the niche does not give its audience is what this account is followed for.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The covers the niche already shows, as the slides are told them: this cover stands out from them. "" with none. */
export function nicheForSlides(rivals) {
  const hooks = plannable(rivals).flatMap((r) => r.hooks.map((h) => `"${h}"`));
  if (!hooks.length) return '';
  return `THE NICHE'S COVERS (what did best for similar accounts; its audience has seen these): ${hooks.join(' · ')}. Learn what makes them stop a thumb, then write a cover that stands apart from them: never their words, never their opening.`;
}

/**
 * The hours the rivals post at, counted ('18:00' → 2 rivals), beside the account's own slots: for each slot, how many
 * rivals post within an hour of it.
 */
export function timesBeside(rivals, slots = []) {
  const rs = plannable(rivals);
  const count = new Map();
  for (const r of rs) for (const t of r.times) count.set(t, (count.get(t) || 0) + 1);
  const theirs = [...count.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([at, n]) => ({ at, n }));
  const min = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const own = [...slots].sort().map((at) => ({ at, near: rs.filter((r) => r.times.some((t) => Math.abs(min(t) - min(at)) <= 60)).length }));
  return { theirs, own };
}
