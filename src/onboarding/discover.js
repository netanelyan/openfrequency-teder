import { isSet } from '../core/env.js';
import { getJson, getText, isSocial } from '../core/net.js';
import { DAY, now } from '../core/clock.js';
import { API_PRICES, record } from '../budget/ledger.js';
import { cachedLookup } from '../core/store.js';
import { askJson } from '../llm/index.js';
import { declaredFeeds, parseFeed } from '../sources/rss.js';
import { titleOf } from '../sources/text.js';
import { youtubeClient, youtubeConfigured } from '../trends/index.js';
import { suggestApis } from './apis.js';

// Finding sources for a new account, from a seed: a niche, a language, an
// audience, and a few example sites.
//
//   1. Brave Search for authority sites: government, official docs, established
//      publications (needs BRAVE_API_KEY; $5 per 1,000 queries, recorded in the ledger)
//   2. the feeds those sites and the example sites declare about themselves
//      (<link rel="alternate">), read by fetching the home page
//   3. structured APIs from a catalog, where the niche has one
//   4. formats that work in the niche on YouTube Shorts, with their real numbers
//   5. a score for each candidate: authority, freshness, terms of use, and a
//      one-line reason. Claude when there is a key; a transparent heuristic
//      otherwise, labelled as such
//
// Nothing found here is approved. The owner approves each source on the website.

const AUTHORITY = [
  [/\.gov\.il$|\.gov$|\.gov\.[a-z]{2}$|\.mil\.il$|europa\.eu$|\.int$/, 9, 'אתר ממשלתי או בינלאומי רשמי'],
  [/\.ac\.il$|\.edu$|\.ac\.[a-z]{2}$/, 8, 'מוסד אקדמי'],
  [/wikipedia\.org$|wikidata\.org$|wikimedia\.org$/, 6, 'ויקי: טוב לעובדות יבשות, כל דף נבדק לגופו'],
  [/\.org\.il$|\.org$/, 6, 'ארגון'],
  [/reuters\.com$|apnews\.com$|bbc\.co\.uk$|bbc\.com$|nytimes\.com$|theguardian\.com$|haaretz\.co\.il$|ynet\.co\.il$|calcalist\.co\.il$|globes\.co\.il$|themarker\.com$|geektime\.co\.il$|theverge\.com$|wired\.com$|espn\.com$|uefa\.com$|fifa\.com$/, 7, 'גוף תקשורת מבוסס'],
];

/** The heuristic score, used when there is no model to ask. */
export function heuristicScore(c, t = now()) {
  let host = '';
  try {
    host = new URL(c.url).hostname.replace(/^www\./, '');
  } catch {
    /* scored as unknown */
  }
  const a = AUTHORITY.find(([re]) => re.test(host));
  const authority = a ? a[1] : c.origin === 'api' ? 8 : 4;
  const age = c.newest ? (t - Date.parse(c.newest)) / DAY : null;
  const freshness = age == null ? (c.type === 'api' ? 7 : 4) : age < 7 ? 9 : age < 30 ? 7 : age < 120 ? 5 : 2;
  const terms = c.terms || (c.origin === 'api' ? 'ok' : 'check');
  const reason = [a ? a[2] : c.origin === 'api' ? 'מקור נתונים מובנה ופתוח' : 'מקור לא מוכר: לבדוק מי עומד מאחוריו', age != null ? `עדכון אחרון לפני ${Math.round(age)} ימים` : null].filter(Boolean).join(', ');
  return { authority, freshness, terms, reason, by: 'heuristic' };
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, authority: { type: 'integer' }, freshness: { type: 'integer' }, terms: { type: 'string', enum: ['ok', 'check', 'no'] }, reason: { type: 'string' } },
        required: ['i', 'authority', 'freshness', 'terms', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

async function scoreWithClaude(ctx, seed, list) {
  const system = `You vet sources for a Hebrew social account about "${seed.niche}" for ${seed.audience || 'Hebrew speakers in Israel'}. Every fact the account posts must be quoted from an approved source, so a source is only as good as its authority.

For each candidate return:
- authority 0-10: who publishes it. Government, regulators, official documentation and the subject's own governing bodies score high; established publications next; anonymous blogs, content farms, affiliate and SEO sites low.
- freshness 0-10: how current it is likely to be for this niche.
- terms: "ok" if quoting short facts from it is clearly fine, "check" if its terms are unknown or restrictive, "no" if it forbids reuse or is a social platform.
- reason: one short Hebrew line, the deciding fact.`;
  const user = list.map((c, i) => `[${i}] ${c.type} ${c.url} | ${c.name}${c.snippet ? ` | ${c.snippet.slice(0, 200)}` : ''}${c.newest ? ` | newest item ${c.newest}` : ''}`).join('\n');
  const { data } = await askJson(ctx, { task: 'score_sources', role: 'judge', system, user, schema: SCORE_SCHEMA, effort: 'low', maxTokens: 8000, expectOut: 2500, tag: 'onboarding' });
  return list.map((c, i) => {
    const s = (data.scores || []).find((x) => x.i === i);
    return s ? { authority: s.authority, freshness: s.freshness, terms: s.terms, reason: s.reason, by: 'claude' } : heuristicScore(c);
  });
}

/** A Brave search, from the cache when the same query ran in the last 30 days; paid ($0.005) only when it did not. */
async function brave(ctx, q, notes) {
  const { value } = await cachedLookup(ctx.db, `brave:${q}`, 30, async () => {
    const body = await getJson(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: '15', search_lang: 'he', safesearch: 'moderate' })}`, {
      headers: { 'x-subscription-token': String(process.env.BRAVE_API_KEY || '').trim(), 'accept-encoding': 'gzip' },
    });
    record(ctx.db, { api: 'brave', usd: API_PRICES.brave, tag: 'onboarding' });
    return (body?.web?.results || []).map((r) => ({ url: r.url, title: String(r.title || '').replace(/<[^>]+>/g, ''), description: String(r.description || '').replace(/<[^>]+>/g, '') }));
  }).catch((e) => (notes.push(e.message), { value: [] }));
  return value;
}

/** Read a site's home page for its declared feeds; returns feed candidates with their newest item. */
async function feedsOf(url, notes) {
  const out = [];
  try {
    const page = await getText(url, { timeoutMs: 12_000 });
    // The site's two feeds at once, kept in the order the page declares them.
    const feeds = await Promise.all(
      declaredFeeds(page.body, page.finalUrl)
        .slice(0, 2)
        .map(async (f) => {
          try {
            const items = parseFeed((await getText(f.url, { timeoutMs: 12_000 })).body);
            const newest = items.map((x) => x.publishedAt).filter(Boolean).sort().pop() || null;
            return { type: 'rss', url: f.url, name: f.title || titleOf(page.body) || new URL(url).hostname, newest, items: items.length };
          } catch (e) {
            notes.push(`${f.url}: ${e.message}`);
            return null;
          }
        })
    );
    out.push(...feeds.filter(Boolean));
    if (!out.length) out.push({ type: 'web', url: page.finalUrl, name: titleOf(page.body) || new URL(url).hostname, newest: null });
  } catch (e) {
    notes.push(`${url}: ${e.message}`);
  }
  return out;
}

/** How many sites (and Brave queries) are read at once. Each fetch has its own timeout (12 seconds, feedsOf). */
export const PARALLEL = 4;

/** fn over every item, at most `n` at a time; the results in the items' order. Stops starting new ones once `signal` aborts. */
export async function mapLimit(items, n, fn, signal = null) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const stopped = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('discovery stopped: it ran out of time'), { code: 'timeout' });
};

const NICHE_EN_SCHEMA = { type: 'object', properties: { en: { type: 'string' } }, required: ['en'], additionalProperties: false };

/** The niche in English, for searching formats on YouTube: the model's few words, or null without one. */
export async function nicheInEnglish(ctx, niche) {
  if (ctx.llm?.kind !== 'claude' || !niche) return null;
  const { data } = await askJson(ctx, {
    task: 'niche_en', role: 'judge', effort: 'low', maxTokens: 200, expectOut: 30, tag: 'onboarding', schema: NICHE_EN_SCHEMA,
    system: 'Translate the niche of a Hebrew social account into the two to five English words a person would type into YouTube search to find short videos about it. Return { en }.',
    user: niche,
  });
  const en = String(data?.en || '').replace(/[^\p{L}\p{N} '&-]/gu, '').trim().slice(0, 80);
  return en || null;
}

/**
 * The whole discovery for a seed. Returns { candidates, formats, notes, said, nicheEn }: `notes` are the operator's
 * (what was skipped and why, every failed fetch); `said` is what the customer is told, in plain Hebrew; `nicheEn` the
 * niche in English when the model gave it (the seed has no such field to fill in).
 * seed: { niche, language, audience, examples: [urls or @handles], topics }
 * onProgress({ step, done, total }): 'search', 'sites' (with counts), 'formats', 'score'.
 */
export async function discover(ctx, seed, { t = now(), yt = youtubeConfigured() ? youtubeClient() : null, onProgress = () => {}, signal = null, parallel = PARALLEL, readSite = feedsOf } = {}) {
  const notes = [];
  const said = [];
  const byUrl = new Map();
  const add = (c) => {
    if (!c?.url || byUrl.has(c.url)) return;
    try {
      if (isSocial(new URL(c.url).hostname)) return notes.push(`${c.url}: רשת חברתית, לא מקור`);
    } catch {
      return;
    }
    byUrl.set(c.url, c);
  };

  // 0. the niche in English (the owner writes it in Hebrew alone): for the catalog's words and YouTube's search
  onProgress({ step: 'search' });
  const nicheEn = seed.nicheEn || (await nicheInEnglish(ctx, seed.niche).catch((e) => (notes.push(`תרגום הנישה לאנגלית נכשל: ${e.message}`), null)));

  // 1. authority sites through Brave, the queries at once, their results taken in the queries' order
  const hosts = new Set();
  if (isSet('BRAVE_API_KEY')) {
    const qs = [`${seed.niche} site:gov.il`, `${seed.niche} רשמי`, `${nicheEn || seed.niche} official guide`, ...(seed.topics || []).slice(0, 2).map((x) => `${x} מידע רשמי`)];
    const results = await mapLimit(qs, parallel, (q) => brave(ctx, q, notes).catch((e) => (notes.push(`Brave "${q}": ${e.message}`), [])), signal);
    for (const list of results) {
      for (const r of list || []) {
        try {
          const h = new URL(r.url).hostname;
          if (isSocial(h) || hosts.has(h)) continue;
          hosts.add(h);
          add({ type: 'web', url: r.url, name: r.title, snippet: r.description, origin: 'brave' });
        } catch {
          /* a result with no address is skipped */
        }
      }
    }
  } else {
    notes.push('אין BRAVE_API_KEY: לא חיפשתי אתרים, רק בדקתי את הדוגמאות שנתתם');
  }
  stopped(signal);

  // 2. feeds: the example sites, and the top authority hosts found, a few at a time
  const examples = (seed.examples || []).map((x) => String(x).trim()).filter((x) => /^https?:\/\//.test(x));
  const social = (seed.examples || []).filter((x) => /^@|instagram|tiktok|youtube/.test(String(x)));
  for (const h of social) notes.push(`${h}: חשבון ברשת חברתית, נשמר כדוגמה לסגנון בלבד ולא נקרא`);
  if (social.length) said.push('את החשבונות ברשתות החברתיות שנתתם שמרנו כדוגמה לסגנון. עובדות לוקחים רק מאתרים.');
  const probe = [...examples, ...[...hosts].slice(0, 6).map((h) => `https://${h}/`)];
  let done = 0;
  onProgress({ step: 'sites', done, total: probe.length });
  const read = await mapLimit(
    probe,
    parallel,
    async (url) => {
      const before = notes.length;
      const found = await readSite(url, notes);
      done += 1;
      onProgress({ step: 'sites', done, total: probe.length });
      return { url, found, failed: !found.length && notes.length > before };
    },
    signal
  );
  stopped(signal);
  for (const r of read) for (const c of r.found) add({ ...c, origin: examples.includes(r.url) ? 'example' : 'feed' });
  const unread = read.filter((r) => r.failed && examples.includes(r.url)).map((r) => {
    try {
      return new URL(r.url).hostname.replace(/^www\./, '');
    } catch {
      return r.url;
    }
  });
  if (unread.length) said.push(`לא הצלחנו לקרוא את ${unread.join(', ')}. אפשר לבחור מהמקורות האחרים, או לנסות שוב מאוחר יותר.`);

  // 3. structured APIs from the catalog
  for (const api of suggestApis({ ...seed, nicheEn })) add({ ...api, origin: 'api' });

  // 4. formats that work now in the niche, searched in English in the niche's English words
  onProgress({ step: 'formats' });
  const formats = [];
  if (yt) {
    for (const lang of ['he', 'en']) {
      stopped(signal);
      const q = lang === 'he' ? `טיפים ${seed.niche}` : `${nicheEn || seed.niche} tips`;
      try {
        const found = await yt.search(q, { lang, t });
        const stats = await yt.stats(found.map((f) => f.id));
        for (const f of found) {
          const s = stats.get(f.id);
          if (s?.views != null) formats.push({ url: f.url, title: f.title, views: s.views, likes: s.likes, lang });
        }
      } catch (e) {
        notes.push(`YouTube: ${e.message}`);
      }
    }
    formats.sort((a, b) => b.views - a.views);
  } else {
    notes.push('אין YOUTUBE_API_KEY: לא חיפשתי פורמטים, ושום מספר לא הומצא במקום');
  }

  // 5. scores
  stopped(signal);
  onProgress({ step: 'score' });
  const list = [...byUrl.values()];
  let scores;
  if (ctx.llm?.kind === 'claude' && list.length) {
    try {
      scores = await scoreWithClaude(ctx, seed, list);
    } catch (e) {
      notes.push(`הדירוג עם Claude נכשל (${e.message}), הדירוג הוא היוריסטי`);
    }
  }
  scores ??= list.map((c) => heuristicScore(c, t));
  const candidates = list.map((c, i) => ({ id: `c${i + 1}`, ...c, score: scores[i], approved: false })).sort((a, b) => b.score.authority - a.score.authority || b.score.freshness - a.score.freshness);
  return { candidates, formats: formats.slice(0, 8), notes, said, nicheEn };
}
