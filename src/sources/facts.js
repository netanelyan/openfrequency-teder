import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../core/clock.js';
import { ensureDir, packsDir } from '../core/paths.js';
import { addDays, israelDate } from '../schedule/israel.js';

// Hand-checked facts: what the owner read on a site the engine may not read.
//
// Some of the best sources for rights and grants (Kol Zchut, gov.il) answer an
// automated reader with bot protection, and the engine does not get past it.
// The owner reads them in a browser and writes the fact down here, with the
// exact sentence, the page it is on, the day it was checked, and the day after
// which it may not be used until it is checked again. These are rules that
// rarely change: a grant's conditions, a deadline, an amount set once a year.
//
// A pack's facts live in <pack>/facts/<topic>.json:
//
//   { "topic": "דמי לידה",
//     "facts": [ { "id": "f1", "quote": "the sentence, exactly as on the page",
//                  "source": "כל זכות", "url": "https://...", "checkedAt": "2026-10-13",
//                  "checkedBy": "owner", "expires": "2026-12-31", "note": "" } ] }
//
// and <pack>/facts/source.json says what the source is: { name, why, url, approvedAt }.
//
// A topic marked "owner": true is the owner's own story: what happened in their business, in their own words ("we
// sold 100,000 in the first year and still lost money", "I bought a used fridge for 4,000 and it died in a month").
// The small-business slideshows that spread on TikTok are exactly this, told on the owner's own photographs, and an
// account may say it in the first person only from these facts (src/rules/check.js): the owner is the source, so
// such a fact needs no page and no expiry, and its document is keyed "story-" so the checks know whose words it is.
//
//   { "topic": "השנה הראשונה", "owner": true,
//     "facts": [ { "id": "s1", "quote": "the owner's sentence, as they wrote it", "checkedAt": "2026-10-27" } ] }
//
// Each topic becomes one document of the pack's "facts" source, holding only the
// facts not yet expired, each quote with its page and dates under it. The
// fact gate checks a post's quotes against that document like any other, and a
// document stops being evidence on the earliest expiry of the facts in it
// (src/verify/claims.js), so a post drafted before a fact expired is blocked
// before it is published after.

export const factsDir = (accountId, base = packsDir()) => path.join(base, accountId, 'facts');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The title an owner's-story document opens with: how the writer knows whose words it is. */
export const OWNER_TITLE = 'הסיפור של בעל העסק: ';
/** Is this stored document the owner's own story? (its key, from factDocuments) */
export const isOwnerDoc = (key) => String(key || '').startsWith('story-');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/** The source.json of a facts folder, or null when the pack has no facts. */
export function factsSource(dir) {
  if (!existsSync(dir)) return null;
  const f = path.join(dir, 'source.json');
  const meta = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const topics = readTopics(dir);
  const firstUrl = topics.flatMap((t) => t.facts).find((x) => /^https:\/\//.test(x.url || ''))?.url;
  return {
    name: meta.name || 'עובדות שנבדקו ביד',
    why: meta.why || 'Facts the owner read on official pages the engine may not read, each with its page, the day it was checked and the day it expires.',
    url: meta.url || (firstUrl ? `${new URL(firstUrl).origin}/` : 'https://www.gov.il/'),
    approvedAt: meta.approvedAt || '2026-10-13',
  };
}

/** Every topic file in a facts folder: [{ file, topic, facts }]. */
export function readTopics(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'source.json')
    .sort()
    .map((f) => {
      const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      return { file: f, topic: String(j.topic || f.replace(/\.json$/, '')), owner: j.owner === true, facts: Array.isArray(j.facts) ? j.facts : [] };
    });
}

/** Problems with one fact, as Hebrew lines for the website. Empty when it is fine. */
export function factProblems(f, { maxQuoteWords = 40, owner = false } = {}) {
  const p = [];
  const n = words(f.quote);
  if (n < 4) p.push('הציטוט קצר מדי: לפחות 4 מילים, בדיוק כמו בעמוד');
  if (n > maxQuoteWords) p.push(`הציטוט ארוך מדי: עד ${maxQuoteWords} מילים, עובדה קצרה ולא פסקה`);
  if (/\.\.\.|…/.test(f.quote || '')) p.push('בלי שלוש נקודות: ציטוט שלם, מילה במילה');
  // The owner's own story is its own source: no page to point to, and what happened does not expire.
  if (owner) {
    if (!DATE.test(f.checkedAt || '')) p.push('תאריך הכתיבה בפורמט YYYY-MM-DD');
    return p;
  }
  if (!/^https:\/\//.test(f.url || '')) p.push('כתובת העמוד חייבת להתחיל ב-https://');
  if (!String(f.source || '').trim()) p.push('צריך את שם המקור');
  if (!DATE.test(f.checkedAt || '')) p.push('תאריך הבדיקה בפורמט YYYY-MM-DD');
  if (!DATE.test(f.expires || '')) p.push('תאריך התפוגה בפורמט YYYY-MM-DD');
  if (DATE.test(f.checkedAt || '') && DATE.test(f.expires || '')) {
    if (f.expires <= f.checkedAt) p.push('התפוגה חייבת להיות אחרי תאריך הבדיקה');
    if (f.expires > addDays(f.checkedAt, 731)) p.push('עובדה נבדקת שוב לפחות פעם בשנתיים: התפוגה עד שנתיים אחרי הבדיקה');
  }
  return p;
}

/** A fact's state on a date: 'valid', 'soon' (within 30 days) or 'expired'. */
export function factState(f, t = now(), { owner = false } = {}) {
  if (owner) return 'valid';
  const today = israelDate(t);
  if (!DATE.test(f.expires || '') || f.expires < today) return 'expired';
  return f.expires <= addDays(today, 30) ? 'soon' : 'valid';
}

/**
 * The documents a facts folder yields today: one per topic, with only the facts
 * that are valid and well formed, and its expiry, the earliest of theirs.
 */
export function factDocuments(dir, { t = now(), maxQuoteWords = 40 } = {}) {
  const docs = [];
  for (const { file, topic, owner, facts } of readTopics(dir)) {
    const live = facts.filter((f) => factState(f, t, { owner }) !== 'expired' && !factProblems(f, { maxQuoteWords, owner }).length);
    if (!live.length) continue;
    if (owner) {
      docs.push({
        key: `story-${file.replace(/[.]json$/, '')}`,
        url: `story:${encodeURIComponent(file.replace(/[.]json$/, ''))}`,
        title: `${OWNER_TITLE}${topic}`,
        text: live.map((f) => `${f.quote.trim()}\n(בעל העסק, נכתב ב-${f.checkedAt})`).join('\n\n'),
        publishedAt: null,
        expiresAt: null,
      });
      continue;
    }
    const text = live.map((f) => `${f.quote.trim()}\n(${f.source}, ${f.url}, נבדק ב-${f.checkedAt}, בתוקף עד ${f.expires})`).join('\n\n');
    docs.push({
      key: `facts-${file.replace(/[.]json$/, '')}`,
      url: live[0].url,
      title: topic,
      text,
      publishedAt: null,
      expiresAt: live.map((f) => f.expires).sort()[0],
    });
  }
  return docs;
}

const slug = (s) => String(s).trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'topic';

/**
 * Add a fact to a topic (created if new), or replace the one with the same id.
 * Returns { file, fact }. The caller has checked factProblems().
 */
export function saveFact(dir, topic, fact, { owner = false } = {}) {
  ensureDir(dir);
  const topics = readTopics(dir);
  const have = topics.find((x) => x.topic === topic.trim());
  // A topic stays the owner's story once it is one (and a story fact never goes into a topic of checked pages).
  const mine = have ? have.owner : owner;
  const file = have?.file || `${slug(topic)}.json`;
  const facts = have?.facts.slice() || [];
  const id = fact.id || `f${Date.now().toString(36)}`;
  const i = facts.findIndex((f) => f.id === id);
  const row = mine
    ? { id, quote: fact.quote.trim(), checkedAt: fact.checkedAt, checkedBy: fact.checkedBy || 'owner', note: String(fact.note || '').trim() }
    : { id, quote: fact.quote.trim(), source: fact.source.trim(), url: fact.url.trim(), checkedAt: fact.checkedAt, checkedBy: fact.checkedBy || 'owner', expires: fact.expires, note: String(fact.note || '').trim() };
  if (i >= 0) facts[i] = row;
  else facts.push(row);
  writeFileSync(path.join(dir, file), `${JSON.stringify({ topic: topic.trim(), ...(mine ? { owner: true } : {}), facts }, null, 2)}\n`);
  return { file, fact: row };
}

/** Remove a fact from its topic; a topic left empty keeps its file, empty. Returns the removed fact or null. */
export function removeFact(dir, topic, id) {
  const t = readTopics(dir).find((x) => x.topic === topic);
  if (!t) return null;
  const gone = t.facts.find((f) => f.id === id) || null;
  writeFileSync(path.join(dir, t.file), `${JSON.stringify({ topic: t.topic, ...(t.owner ? { owner: true } : {}), facts: t.facts.filter((f) => f.id !== id) }, null, 2)}\n`);
  return gone;
}
