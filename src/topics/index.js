import { getJson } from '../core/net.js';
import { now, nowIso, DAY } from '../core/clock.js';
import { audit, cachedLookup, getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';
import { record } from '../budget/ledger.js';
import { askJson } from '../llm/index.js';
import { NoRecording } from '../llm/recorded.js';
import { research } from '../sources/research.js';
import { youtubeClient, youtubeConfigured } from '../trends/index.js';

// Topics first. A post used to start from whatever document a source had that day, and the outline found a topic in
// it. Now it starts from what people are already looking at, and only then are the approved sources searched for the
// facts that hold it up:
//
//   1. SIGNALS, once a day per account: a name on the account's watch list whose Wikipedia page is read far more this
//      week than in the four before, and the Shorts most viewed in the last two weeks for the account's searches
//      (their titles and numbers only). Each is a candidate.
//   2. THE BANK: topics the owner knows went viral, typed in on the website, with why and where. They come first.
//   3. THE SCORE: one model call scores the new candidates 0 to 10 for how hard they stop a scroll (shock, money,
//      rivalry, a hidden story, "I didn't know that"). A signal under 6 is never drafted. A bank topic is scored to be
//      shown, never skipped: the owner already knows it works.
//   4. THE FACTS: the post's topic is searched in the account's stored documents and through its approved research
//      sources. A topic nothing approved supports is marked so and left; the post is then drafted the old way, from
//      the day's documents.
//
// The link of a candidate is where it went viral or was seen, never a fact's source: facts come only from approved
// sources, checked against their stored text, as before.

export const PASS = 6;
export const PARTS = [
  ['shock', 'הלם'],
  ['money', 'כסף'],
  ['rivalry', 'יריבות'],
  ['hidden', 'סיפור נסתר'],
  ['didntKnow', 'לא ידעתי'],
];
const SIGNAL_DAYS = 7;
const SHORTS_DAYS = 14;

const row = (r) => (r ? { ...r, terms: j(r.terms_json, []), signal: j(r.signal_json, {}), parts: j(r.score_json, null) } : null);
export const topicById = (db, id) => row(db.get('SELECT * FROM topics WHERE id = ?', id));
export const topicsOf = (db, accountId) => db.all("SELECT * FROM topics WHERE account_id = ? AND status != 'removed' ORDER BY origin = 'bank' DESC, score IS NULL, score DESC, created_at DESC", accountId).map(row);

/** Add a candidate once (its key per account); a candidate seen again keeps what it had. Returns its id. */
export function addTopic(db, accountId, { origin, key, title, why = null, url = null, signal = null, expiresAt = null }) {
  const have = db.get('SELECT id FROM topics WHERE account_id = ? AND key = ?', accountId, key);
  if (have) return have.id;
  return db.insert('topics', { account_id: accountId, origin, key, title: String(title).trim().slice(0, 300), why: why ? String(why).trim().slice(0, 600) : null, url, signal_json: signal, status: 'new', created_at: nowIso(), expires_at: expiresAt });
}

/** A topic the owner knows went viral. */
export function addBankTopic(db, accountId, { title, why, url }, actor = 'engine') {
  const t = String(title || '').trim();
  if (t.length < 3) throw Object.assign(new Error('נושא צריך לפחות כמה מילים'), { field: 'title' });
  const link = String(url || '').trim();
  if (link && !/^https?:\/\/\S+$/.test(link)) throw Object.assign(new Error('הקישור צריך להתחיל ב-https://'), { field: 'url' });
  const n = (db.get('SELECT COUNT(*) AS n FROM topics WHERE account_id = ? AND origin = ?', accountId, 'bank').n || 0) + 1;
  const id = addTopic(db, accountId, { origin: 'bank', key: `bank:${Date.now().toString(36)}:${n}`, title: t, why: String(why || '').trim() || null, url: link || null });
  audit(db, { actor, action: 'topic_added', accountId, detail: { title: t } });
  return id;
}

/** The names whose Wikipedia pages an account watches: the owner's list on the website, else the pack's. */
export function watchList(db, pack) {
  const saved = getSetting(db, `watch:${pack.id}`, null);
  if (Array.isArray(saved)) return saved;
  return (pack.meta.interest?.wikipedia || []).map(String);
}
export function setWatchList(db, pack, text) {
  const names = [...new Set(String(text || '').split(/\n|,/).map((s) => s.trim()).filter(Boolean))].slice(0, 60);
  setSetting(db, `watch:${pack.id}`, names);
  return names;
}

const HEBREW = /[֐-׿]/;
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * This week's reading of a page against the four weeks before it: { ratio, week, before } (daily means), from the
 * daily views oldest first. Pure.
 */
export function spikeOf(daily) {
  const v = daily.map((x) => Number(x) || 0);
  if (v.length < 14) return null;
  const week = v.slice(-SIGNAL_DAYS);
  const before = v.slice(0, -SIGNAL_DAYS).slice(-28);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const w = mean(week);
  const b = Math.max(1, mean(before));
  return { ratio: w / b, week: Math.round(w), before: Math.round(b) };
}

/** The watched names whose pages people read far more this week. fetchJson is injectable for tests. */
export async function wikipediaSpikes(names, { t = now(), fetchJson = getJson, minRatio = 1.5, minDaily = { en: 300, he: 40 } } = {}) {
  const out = [];
  const end = ymd(t - DAY);
  const start = ymd(t - 36 * DAY);
  for (const name of names) {
    const lang = HEBREW.test(name) ? 'he' : 'en';
    const title = name.replace(/ /g, '_');
    try {
      const body = await fetchJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/user/${encodeURIComponent(title)}/daily/${start}/${end}`);
      const s = spikeOf((body?.items || []).map((x) => x.views));
      if (!s || s.ratio < minRatio || s.week < (minDaily[lang] ?? 0)) continue;
      let extract = '';
      try {
        extract = String((await fetchJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`))?.extract || '').slice(0, 400);
      } catch {
        /* the numbers stand without the summary */
      }
      out.push({ name, lang, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`, ...s, extract });
    } catch {
      /* a name with no page, or a page with no views yet, is not a signal */
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

/** The Shorts most viewed in the last two weeks for the account's searches: titles and YouTube's own numbers. */
export async function topShorts(db, pack, { yt, t = now(), keep = 8 } = {}) {
  const cfg = pack.formats.trends || {};
  const raw = new Map();
  for (const lang of ['he', 'en']) {
    for (const q of cfg.queries?.[lang] || []) {
      try {
        // A day-old answer to the same search is reused: search.list has a daily quota.
        const { value, cached } = await cachedLookup(db, `youtube:topics:${lang}:${q}`, 1, () => yt.search(q, { lang, t, days: SHORTS_DAYS }));
        for (const v of value || []) if (!raw.has(v.id)) raw.set(v.id, { ...v, lang, query: q });
        if (!cached) record(db, { accountId: pack.id, api: 'youtube', usd: 0, tag: 'topics' });
      } catch (e) {
        if (e.status === 403) break;
      }
    }
  }
  const stats = raw.size ? await yt.stats([...raw.keys()]).catch(() => new Map()) : new Map();
  return [...raw.values()]
    .map((v) => ({ ...v, ...(stats.get(v.id) || {}) }))
    .filter((v) => v.views != null && v.views >= (cfg.minViews?.[v.lang] ?? 10_000))
    .sort((a, b) => b.views - a.views)
    .slice(0, keep);
}

/** Read the signals of one account into candidates. Live only: nothing is invented offline. */
export async function collectSignals(ctx, pack, { t = now(), fetchJson = getJson, yt = youtubeConfigured() ? youtubeClient() : null } = {}) {
  const { db } = ctx;
  const found = { wikipedia: 0, youtube: 0 };
  const week = new Date(t - (new Date(t).getUTCDay() * DAY)).toISOString().slice(0, 10);
  for (const s of await wikipediaSpikes(watchList(db, pack), { t, fetchJson })) {
    addTopic(db, pack.id, {
      origin: 'wikipedia', key: `wiki:${s.lang}:${s.name}:${week}`, title: s.name, url: s.url,
      why: `הדף בוויקיפדיה נקרא השבוע פי ${s.ratio.toFixed(1)} מבחודש שלפני (${s.week} ביום מול ${s.before})`,
      signal: { ratio: Number(s.ratio.toFixed(2)), week: s.week, before: s.before, extract: s.extract }, expiresAt: new Date(t + SIGNAL_DAYS * DAY).toISOString(),
    });
    found.wikipedia++;
  }
  if (yt) {
    for (const v of await topShorts(db, pack, { yt, t })) {
      addTopic(db, pack.id, {
        origin: 'youtube', key: `yt:${v.id}`, title: String(v.title).slice(0, 200), url: v.url,
        why: `${v.views.toLocaleString('en-US')} צפיות בשורט מ-${String(v.publishedAt || '').slice(0, 10)}`,
        signal: { views: v.views, likes: v.likes ?? null, query: v.query, publishedAt: v.publishedAt }, expiresAt: new Date(t + SHORTS_DAYS * DAY).toISOString(),
      });
      found.youtube++;
    }
  }
  return found;
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          fits: { type: 'boolean' },
          shock: { type: 'integer' }, money: { type: 'integer' }, rivalry: { type: 'integer' }, hidden: { type: 'integer' }, didntKnow: { type: 'integer' },
          score: { type: 'integer' },
          angle: { type: 'string' },
          terms: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
        },
        required: ['id', 'fits', 'shock', 'money', 'rivalry', 'hidden', 'didntKnow', 'score', 'angle', 'terms', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['topics'],
  additionalProperties: false,
};

function scoreSystem(pack) {
  return `You choose topics for "${pack.meta.displayName}", a Hebrew TikTok and Instagram slideshow account about ${(pack.meta.topics || []).join(', ')}. Its audience: ${pack.meta.audience || 'Hebrew speakers'}.

For each candidate topic, judge how hard a slideshow on it would stop someone scrolling, for this audience. Score each part 0 to 10:
- shock: something that should not have happened, or a number that does not seem possible
- money: what it cost, earned, lost or is worth
- rivalry: two sides against each other, a feud, a record taken
- hidden: the story behind the story that most people never heard
- didntKnow: the "I didn't know that" a reader repeats to a friend
score: 0 to 10 overall: how likely this stops a scroll and gets shared. One strong part can carry a topic; a topic strong in nothing is a 3 at most.
fits: false when the topic is outside this account's subject, or is news nobody here cares about. A topic that does not fit scores 0.
angle: the post's topic in a few Hebrew words, the angle that makes it stop a scroll, true to what the candidate says. Never a claim the candidate does not make: the facts are found later, in approved sources.
terms: 1 to 3 English Wikipedia article titles or short search phrases naming the people, teams, companies or events, to search the sources for.
why: one short Hebrew sentence, why it would or would not stop a scroll.
Return every candidate, by its id.`;
}

/**
 * Score the account's new candidates in one call. A signal at PASS or more is ready; under it, or outside the
 * niche, it is low and never drafted. A bank topic is ready whatever its score. Offline with no recording, the
 * candidates wait unscored. Returns { scored, ready }.
 */
export async function scoreTopics(ctx, pack, { max = 30 } = {}) {
  const { db } = ctx;
  const fresh = db.all("SELECT * FROM topics WHERE account_id = ? AND status = 'new' AND (expires_at IS NULL OR expires_at > ?) ORDER BY origin = 'bank' DESC, id LIMIT ?", pack.id, nowIso(), max).map(row);
  if (!fresh.length) return { scored: 0, ready: 0 };
  const user = fresh
    .map((x) => [`[${x.id}] ${x.origin === 'bank' ? 'THE OWNER KNOWS THIS WENT VIRAL' : x.origin === 'wikipedia' ? 'A WIKIPEDIA PAGE PEOPLE ARE READING NOW' : 'A SHORT PEOPLE ARE WATCHING NOW'}: ${x.title}`, x.why ? `  why: ${x.why}` : '', x.signal?.extract ? `  about: ${x.signal.extract}` : ''].filter(Boolean).join('\n'))
    .join('\n');
  let data;
  try {
    ({ data } = await askJson(ctx.withPack ? ctx.withPack(pack) : { ...ctx, pack }, {
      task: 'topics', role: 'rank', system: scoreSystem(pack), user, schema: SCORE_SCHEMA, effort: 'low', maxTokens: 6000, expectOut: 160 * fresh.length, tag: 'topics',
      meta: { recordingsDir: pack.recordingsDir, docKey: `topics:${fresh.map((x) => x.id).join(',')}`, attempt: 0 },
    }));
  } catch (e) {
    if (e instanceof NoRecording) return { scored: 0, ready: 0 };
    throw e;
  }
  const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
  let ready = 0;
  let scored = 0;
  for (const r of data.topics || []) {
    const x = fresh.find((f) => f.id === r.id);
    if (!x) continue;
    const parts = Object.fromEntries(PARTS.map(([k]) => [k, clamp(r[k])]));
    const score = r.fits === false ? 0 : clamp(r.score);
    const ok = x.origin === 'bank' || score >= PASS;
    db.update('topics', x.id, {
      score, score_json: { ...parts, fits: r.fits !== false, why: String(r.why || '').slice(0, 300) }, angle: String(r.angle || '').trim().slice(0, 120) || null,
      terms_json: (r.terms || []).map(String).filter(Boolean).slice(0, 3), status: ok ? 'ready' : 'low', note: ok ? null : r.fits === false ? 'מחוץ לנושא של החשבון' : `ציון ${score}, מתחת ל-${PASS}`, scored_at: nowIso(),
    });
    scored++;
    if (ok) ready++;
  }
  return { scored, ready };
}

/**
 * The topics a post may be drafted about, best first: the bank's (scored or not yet), then the ready signals by
 * score. Expired signals are not offered.
 */
export function readyTopics(db, accountId, { limit = 2 } = {}) {
  return db
    .all(
      "SELECT * FROM topics WHERE account_id = ? AND ((origin = 'bank' AND status IN ('new', 'ready', 'low')) OR (origin != 'bank' AND status = 'ready')) AND (expires_at IS NULL OR expires_at > ?) ORDER BY origin = 'bank' DESC, score DESC, created_at LIMIT ?",
      accountId,
      nowIso(),
      limit
    )
    .map(row);
}

/** What to search for a topic: its terms, else its title. */
export const termsOf = (topic) => (topic.terms?.length ? topic.terms : [topic.title]).map(String).filter(Boolean);

/**
 * The documents that hold a topic up: the account's stored documents (approved sources) that name it, and what the
 * research sources find for it. [] when nothing approved says a word about it.
 */
export async function topicDocs(ctx, pack, topic, { max = 4 } = {}) {
  const { db } = ctx;
  const terms = termsOf(topic);
  const names = terms.filter((x) => x.length >= 3);
  const sources = new Map(db.all("SELECT id, name, key FROM sources WHERE account_id = ? AND status = 'approved'", pack.id).map((s) => [s.id, s]));
  if (!sources.size || !names.length) return [];
  const like = names.map(() => 'LOWER(d.text) LIKE ?').join(' OR ');
  const stored = db.all(
    `SELECT d.* FROM documents d JOIN sources s ON s.id = d.source_id WHERE s.account_id = ? AND s.status = 'approved' AND (${like}) ORDER BY COALESCE(d.published_at, d.fetched_at) DESC LIMIT ?`,
    pack.id,
    ...names.map((n) => `%${n.toLowerCase()}%`),
    max
  );
  const seen = new Set(stored.map((d) => String(d.url).toLowerCase()));
  const found = stored.length >= max ? [] : await research(ctx, { pack, terms, names, have: [...seen], max: max - stored.length, docKey: `topic-${topic.id}` }).catch(() => []);
  return [...stored, ...found].slice(0, max).map((d) => ({ ...d, sourceName: sources.get(d.source_id)?.name || '', sourceKey: sources.get(d.source_id)?.key || '' }));
}

/** What became of a topic a post tried. */
export function markTopic(db, id, status, { postId = null, note = null } = {}) {
  db.update('topics', id, { status, ...(postId ? { post_id: postId } : {}), note });
}

/** A candidate that is no longer wanted (the owner removed it from the bank, or it was a bad signal). */
export function removeTopic(db, accountId, id, actor = 'engine') {
  const t = db.get('SELECT id, title FROM topics WHERE id = ? AND account_id = ?', id, accountId);
  if (!t) return false;
  db.update('topics', t.id, { status: 'removed' });
  audit(db, { actor, action: 'topic_removed', accountId, detail: { title: t.title } });
  return true;
}
