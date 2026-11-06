import { now, nowIso } from '../core/clock.js';
import { getSetting, setSetting } from '../core/store.js';
import { askJson } from '../llm/index.js';
import { isSocial } from '../core/net.js';
import { meterSetup } from '../billing/setup-cap.js';
import { discover, offered } from './discover.js';

// Searching for new sources, each round deeper than the last.
//
// The owner, 2026-11-06: "the problem is searching for sources. there should be a button that searches for new sources,
// and every search should be better, it can take more time but results should come better". The setup's search
// (discover.js) runs once, on the niche's own words; a niche whose own sites are a few home pages (OpenFrequency's:
// entrepreneurship and business for everyone) has nowhere else to go. "לחפש מקורות חדשים", on the setup's sources step
// and on the Sources page, runs one more round, and every round:
//
//   - remembers what the earlier rounds searched and found (searchMemory: their searches, every site they read, the
//     sources they offered), and the sites the owner dropped; none of it is searched, read or offered again;
//   - widens (WIDEN): the niche's own publications the first search missed, then the subjects next to it, then what the
//     audience cares about beyond the product (the people, companies and stories of the field), then reference pages;
//   - goes deeper (roundPlan): more searches, more sites read, more pages of each source (a feed's items, a page's own
//     articles followed from it: discover.js sourceHints), and more time.
//
// What it finds is offered, never approved: on the setup it joins the list, marked "חדש", for the owner to tick or
// leave; on an account it is added as pending, for the owner to approve or remove on the Sources page.
//
// THE CAP. At most DEEPER_ROUNDS rounds for one account (its setup's rounds count), the fourth the widest. A round is
// at most 12 Brave searches ($0.005 each, $0.06), one small call to plan it and one to score what it read (the judge
// model, Haiku: a few cents), so all four together stay under about $0.40, inside a workspace's setup cap before it
// pays (src/billing/setup-cap.js meterSetup counts every call of it); and at most 12 minutes a round (timeoutMs).

/** The most rounds of the deeper search for one account, its setup's included. */
export const DEEPER_ROUNDS = 4;

/** What each round widens to, in turn. */
export const WIDEN = [
  'publications about this exact subject that a first search missed: specialist magazines, blogs of known practitioners, newsletters, the subject\'s section of large outlets, Hebrew first',
  'the subjects right next to this one that the same audience reads about (for a business tool: small business, marketing, selling online, startups), and the publications that cover them',
  'what this audience is interested in beyond the product itself: the famous people, companies and stories of the field, its history and its news, interviews and long reads',
  'reference pages that explain the field: encyclopedias and glossaries, schools and courses, official bodies and their open data, research and annual reports',
];

/** One round's size: deeper each time, capped at the last. Pure. */
export function roundPlan(n) {
  const k = Math.min(Math.max(1, Math.floor(n) || 1), DEEPER_ROUNDS);
  return {
    n: k,
    // Brave searches (the setup's own search runs 6)
    searches: 4 + 2 * k,
    // sites the model names
    sites: 6 + 2 * k,
    // sites read for feeds, besides the examples (the setup's own reads 14)
    probed: 8 + 4 * k,
    // pages each source reads every time: a feed's items, a page's own articles (a source otherwise reads 6, or 1)
    depth: 4 + 2 * k,
    // how long the round may run before it is stopped (the setup's own search has 4 minutes)
    timeoutMs: (4 + 2 * k) * 60_000,
    widen: WIDEN[k - 1],
  };
}

const keyOf = (scope) => `sourceSearch:${scope}`;

/** What the earlier rounds of a scope (an account, or a setup before its account exists) did: { rounds: [...] }. */
export function searchMemory(db, scope) {
  const m = getSetting(db, keyOf(scope), null);
  return { rounds: Array.isArray(m?.rounds) ? m.rounds : [] };
}

/** One more round, remembered: { n, at, queries, hosts (every site read or found), offered (urls), found }. */
export function rememberRound(db, scope, round) {
  const m = searchMemory(db, scope);
  setSetting(db, keyOf(scope), { rounds: [...m.rounds, round] });
}

/** A setup's rounds become its account's when the account is made. */
export function carryMemory(db, from, to) {
  const m = searchMemory(db, from);
  if (m.rounds.length && !searchMemory(db, to).rounds.length) setSetting(db, keyOf(to), m);
}

/** The next round's number, or null once DEEPER_ROUNDS were run. */
export function nextRound(db, scope) {
  const n = searchMemory(db, scope).rounds.length + 1;
  return n > DEEPER_ROUNDS ? null : n;
}

/** A site's host without "www.", or '' for an address that is not a web page (the model's own, "model:..."). */
export const hostOf = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sites: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' }, why: { type: 'string' } }, required: ['url', 'name', 'why'], additionalProperties: false } },
    queries: { type: 'array', items: { type: 'string' } },
  },
  required: ['sites', 'queries'],
  additionalProperties: false,
};

/**
 * The searches and sites without a model: the niche's words with each round's widening. Pure. The setup's own search
 * ran the niche, "<niche> מגזין", "<en> blog" and "<en> news", so none of those.
 */
export function plainQueries(seed, plan) {
  const he = seed.niche;
  const en = seed.nicheEn || seed.niche;
  const byRound = [
    [`${he} בלוג`, `${he} מדריך`, `${en} magazine`, `${en} newsletter`, `${he} כתבות`, `${en} guide`],
    [`${he} עסקים קטנים`, `${he} שיווק`, `${en} small business`, `${en} marketing blog`, `${he} סטארטאפ`, `${en} industry news`],
    [`${he} סיפור הצלחה`, `${he} ראיון`, `${en} success story`, `${en} interview`, `${en} history`, `${he} חברות מוכרות`],
    [`${he} ויקיפדיה`, `${he} מילון מונחים`, `${en} glossary`, `${en} course`, `${en} annual report`, `${he} נתונים`],
  ][plan.n - 1];
  const topics = (seed.topics || []).slice(0, 2).map((t) => `${t} ${plan.n % 2 ? 'מדריך' : 'בלוג'}`);
  return [...new Set([...byRound, ...topics])].slice(0, plan.searches);
}

/**
 * The model's plan for one round: { sites, queries }, sites it has not named before, on hosts nobody found yet. The
 * model is told everything the earlier rounds did, and the code keeps none of it anyway.
 */
export async function planRound(ctx, seed, plan, { searched = [], hosts = new Set(), dropped = [] } = {}) {
  if (ctx.llm?.kind !== 'claude' || !seed.niche) return { sites: [], queries: plainQueries(seed, plan).filter((q) => !searched.includes(q)) };
  const { data } = await askJson(ctx, {
    task: 'deeper_sites', role: 'judge', effort: 'low', maxTokens: 5000, expectOut: 1800, tag: 'onboarding', schema: PLAN_SCHEMA,
    system: `A Hebrew social account posts short slideshows about a subject. Every fact it posts is quoted from a website it reads every day, through the site's RSS or Atom feed or its articles. Earlier searches found too little to write from, so this is search round ${plan.n} of ${DEEPER_ROUNDS}, wider than the last.

This round looks for: ${plan.widen}.

- sites: up to ${plan.sites} real websites that publish often and have articles a post can be written from (not a shop, a forum, a social network, a video platform, or a site of links). Only sites you are confident exist, at their real address; a section's address rather than a home page where the site covers much else. For each: url, name, why in one short English line.
- queries: ${plan.searches} web searches, in Hebrew and in English, that would find more such publications for this round.

Never a site on the list of sites already found or dropped, never a search already run: the owner wants new sources, not the same ones again.`,
    user: [
      `Subject: ${seed.niche}`,
      seed.audience ? `Audience: ${seed.audience}` : '',
      seed.topics?.length ? `Topics they care about: ${seed.topics.join(', ')}` : '',
      `Sites already found or read (do not name them): ${[...hosts].slice(0, 120).join(', ') || '(none)'}`,
      dropped.length ? `Sites the owner dropped (find other kinds than these): ${dropped.slice(0, 40).join(', ')}` : '',
      `Searches already run (do not repeat them): ${searched.slice(0, 80).join(' | ') || '(none)'}`,
    ].filter(Boolean).join('\n'),
  });
  const sites = [];
  const seen = new Set(hosts);
  for (const s of data?.sites || []) {
    const h = hostOf(String(s.url || '').trim());
    if (!h || seen.has(h) || isSocial(h)) continue;
    seen.add(h);
    sites.push({ url: new URL(String(s.url).trim()).href, name: String(s.name || h).slice(0, 80), why: String(s.why || '').slice(0, 200) });
    if (sites.length >= plan.sites) break;
  }
  const said = new Set(searched.map((q) => q.toLowerCase()));
  const queries = [...new Set((data?.queries || []).map((q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 100)).filter((q) => q && !said.has(q.toLowerCase())))].slice(0, plan.searches);
  return { sites, queries: queries.length ? queries : plainQueries(seed, plan).filter((q) => !said.has(q.toLowerCase())) };
}

/**
 * One round of the deeper search. `known`: the addresses already there (a setup's candidates, an account's sources);
 * `dropped`: the hosts the owner did not keep. Returns { round, plan, candidates (new ones only, each with its round),
 * notes }. The round is remembered by the caller once what it found is kept (startDeeper).
 */
export async function searchDeeper(ctx, seed, { scope, known = [], dropped = [], signal = null, onProgress = () => {}, discoverOpts = {} } = {}) {
  const memory = searchMemory(ctx.db, scope);
  const n = memory.rounds.length + 1;
  if (n > DEEPER_ROUNDS) throw Object.assign(new Error(`all ${DEEPER_ROUNDS} rounds were run`), { code: 'cap' });
  const plan = roundPlan(n);
  const searched = memory.rounds.flatMap((r) => r.queries || []);
  const hosts = new Set([...memory.rounds.flatMap((r) => r.hosts || []), ...known.map(hostOf), ...dropped].filter(Boolean));
  const urls = new Set([...known, ...memory.rounds.flatMap((r) => r.offered || [])]);
  onProgress({ step: 'search', round: n });
  const asked = await planRound(ctx, seed, plan, { searched, hosts, dropped }).catch((e) => ({ sites: [], queries: plainQueries(seed, plan), failed: e.message }));
  const out = await discover(ctx, seed, {
    ...discoverOpts,
    yt: null,
    apis: false,
    plan: { sites: asked.sites, queries: asked.queries },
    probed: plan.probed,
    searches: plan.searches,
    depth: plan.depth,
    skip: hosts,
    signal,
    onProgress: (p) => onProgress({ ...p, round: n }),
  });
  const candidates = out.candidates.filter((c) => !urls.has(c.url) && !hosts.has(hostOf(c.url))).map((c) => ({ ...c, round: n }));
  const read = [...new Set([...asked.sites.map((s) => hostOf(s.url)), ...out.candidates.map((c) => hostOf(c.url))].filter(Boolean))];
  return {
    round: { n, at: nowIso(), queries: asked.queries, hosts: read, offered: candidates.filter(offered).map((c) => c.url), found: candidates.filter(offered).length },
    plan,
    candidates,
    notes: [...(asked.failed ? [`תכנון הסבב נכשל: ${asked.failed}`] : []), ...out.notes],
  };
}

/* ------------------------------------------------------------------ the round in the background */

const jobs = new Map();

/** Is a round running for this scope? */
export const deeperBusy = (scope) => jobs.has(scope);
/** What a running round is doing: { step, round, done, total }. */
export const deeperProgress = (scope) => jobs.get(scope)?.progress || null;

/** The progress line of a running round, in the words of the setup's own search. Pure. */
export function deeperLine(p) {
  const head = p?.round ? `סבב ${p.round} מתוך ${DEEPER_ROUNDS}. ` : '';
  if (p?.step === 'sites' && p.total) return `${head}קוראים אתרים, ${p.done} מתוך ${p.total}.`;
  if (p?.step === 'score') return `${head}כמעט סיימנו, בודקים כל מקור.`;
  return `${head}מחפשים מקורות חדשים.`;
}

/**
 * Start a round in the background for `scope`. `keep(result)` keeps what it found (the caller's: a setup's list, an
 * account's pending sources) and the round is remembered after it, so a round that broke is not counted and the next
 * press runs it again. `counts`: metered against a workspace's setup before it pays (src/billing/setup-cap.js); the
 * operator's are not. Returns false when one is running already.
 */
export function startDeeper(ctx, scope, { seed, known, dropped, keep, workspaceId = null, counts = true, log = null } = {}) {
  if (jobs.has(scope)) return false;
  const n = nextRound(ctx.db, scope);
  if (!n) return false;
  const plan = roundPlan(n);
  const stop = new AbortController();
  const job = { progress: { step: 'search', round: n } };
  jobs.set(scope, job);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(Object.assign(new Error(`round ${n} ran past ${Math.round(plan.timeoutMs / 60_000)} minutes and was stopped`), { code: 'timeout' }));
    }, ctx.deeperTimeoutMs ?? plan.timeoutMs);
    timer.unref?.();
  });
  const work = () => searchDeeper(ctx, seed, { scope, known, dropped, signal: stop.signal, onProgress: (p) => (job.progress = p), discoverOpts: ctx.discoverOpts || {} });
  const run = counts && workspaceId != null ? meterSetup(ctx.db, workspaceId, work) : work();
  job.promise = Promise.race([run, timeout])
    .then((res) => {
      keep(res);
      rememberRound(ctx.db, scope, res.round);
      log?.(`[sources] ${scope}: round ${n}: ${res.round.queries.length} search(es), ${res.round.hosts.length} site(s) read, ${res.candidates.length} new, ${res.round.found} offered`);
    })
    .catch((e) => log?.(`[sources] ${scope}: round ${n} stopped: ${e.message}`))
    .finally(() => {
      clearTimeout(timer);
      jobs.delete(scope);
    });
  return true;
}

/** For the tests: wait for a scope's round to end. */
export const deeperJob = (scope) => jobs.get(scope)?.promise || Promise.resolve();

/** When the last round of a scope ended, and how many it offered: what the page says after it. */
export function lastRound(db, scope, t = now()) {
  const r = searchMemory(db, scope).rounds.at(-1);
  return r ? { ...r, recent: t - Date.parse(r.at) < 86_400_000 } : null;
}
