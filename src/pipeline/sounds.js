import { DAY, now, nowIso } from '../core/clock.js';
import { j } from '../db/index.js';

// The trending sounds an account's owner picked for its TikTok drafts, written in by hand: a name, an artist, a
// link to the sound on TikTok if they have one, and the day it was added. TikTok's viral sounds are reachable by no
// API (Zernio lists only the Commercial Music Library's), so on an account in draft-fallback mode
// (zernio.tiktokMode) each TikTok post goes as a draft and the owner adds the sound in the app, the one this list
// names for it. The engine never opens the link: it is the owner's, to tap.
//
// A sound trends for days, not weeks: one added more than SOUNDS.staleDays ago is marked for a look, and named only
// when no fresh one is left. A post never takes a sound one of the account's last SOUNDS.recent TikTok posts had.

export const SOUNDS = { min: 3, max: 5, staleDays: 7, recent: 5, chars: 80 };

// A business account (pack.json "business": true, a shop or a brand) may only use TikTok's Commercial Music Library:
// a trending song from the For You feed is licensed for personal accounts, and a business that posts one can have the
// sound muted or the post taken down. 24 of 25 slideshows that spread had a sound, so the list still matters; for a
// business every sound on it is one the owner confirmed is in the library.
export const isBusiness = (pack) => pack?.meta?.business === true;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A sound as the form sent it, made into a row's fields, and what is wrong with it. Pure. */
export function readSound(form) {
  const problems = [];
  const name = clean(form.name);
  const artist = clean(form.artist);
  const link = clean(form.link);
  if (!name) problems.push('שם הסאונד');
  if (!artist) problems.push('שם האמן');
  if (name.length > SOUNDS.chars || artist.length > SOUNDS.chars) problems.push(`עד ${SOUNDS.chars} תווים לשם ולאמן`);
  if (link && !/^https:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/\S+$/i.test(link)) problems.push('קישור: כתובת של טיקטוק שמתחילה ב-https://');
  return { sound: { name, artist, link: link || null }, problems };
}

const rowOut = (r, t = now()) => {
  const age = Math.floor((t - Date.parse(r.added_at)) / DAY);
  return { id: r.id, accountId: r.account_id, name: r.name, artist: r.artist, link: r.link || null, addedAt: r.added_at, addedBy: r.added_by, age, stale: age >= SOUNDS.staleDays };
};

/** An account's sounds, newest first, each with its age in days and whether it is stale. */
export function soundsOf(db, accountId, { t = now() } = {}) {
  return db.all('SELECT * FROM sounds WHERE account_id = ? ORDER BY added_at DESC, id DESC', accountId).map((r) => rowOut(r, t));
}

/** Add a sound from the form. Returns { id } or { problems }. A sixth, or one already on the list, is refused. */
export function saveSound(db, accountId, form, { by = null, business = false } = {}) {
  const { sound, problems } = readSound(form);
  if (business && form.commercial !== '1') problems.push('בחשבון עסקי רק סאונד מהספרייה המסחרית של טיקטוק (Commercial Music Library): סמנו שהוא משם');
  const have = db.all('SELECT name, artist FROM sounds WHERE account_id = ?', accountId);
  if (have.length >= SOUNDS.max) problems.push(`עד ${SOUNDS.max} סאונדים לחשבון: הסירו אחד ישן`);
  const key = (x) => `${x.name}|${x.artist}`.toLowerCase();
  if (have.some((x) => key(x) === key(sound))) problems.push(`"${sound.name}" כבר ברשימה`);
  if (problems.length) return { problems };
  return { id: db.insert('sounds', { account_id: accountId, ...sound, added_at: nowIso(), added_by: by }) };
}

export function removeSound(db, accountId, id) {
  const r = db.get('SELECT * FROM sounds WHERE id = ? AND account_id = ?', Number(id), accountId);
  if (!r) return null;
  db.run('DELETE FROM sounds WHERE id = ?', r.id);
  return rowOut(r);
}

/** The ids of the sounds the account's last SOUNDS.recent TikTok drafts were given, newest first. */
export function recentSoundIds(db, accountId) {
  return db
    .all("SELECT publish_json FROM posts WHERE account_id = ? AND publish_json LIKE '%\"flow\"%' ORDER BY published_at DESC, updated_at DESC LIMIT ?", accountId, SOUNDS.recent)
    .map((r) => j(r.publish_json, {}).tiktok?.flow?.sound?.id)
    .filter(Boolean);
}

/**
 * The sound for the next TikTok draft: a fresh one none of the last SOUNDS.recent drafts had, the newest first;
 * then a stale one they did not have; then, when every sound was used lately, the one used longest ago. Pure on
 * its inputs. Returns { id, name, artist, link, stale } or null for an empty list.
 */
export function pickSound(sounds, recent = []) {
  if (!sounds.length) return null;
  const unused = sounds.filter((s) => !recent.includes(s.id));
  const pick = unused.find((s) => !s.stale) || unused[0] || [...sounds].sort((a, b) => recent.indexOf(b.id) - recent.indexOf(a.id))[0];
  return { id: pick.id, name: pick.name, artist: pick.artist, link: pick.link, stale: pick.stale };
}

/** The sound assigned to an account's next TikTok draft, or null when its list is empty. */
export const assignSound = (db, accountId, { t = now() } = {}) => pickSound(soundsOf(db, accountId, { t }), recentSoundIds(db, accountId));
