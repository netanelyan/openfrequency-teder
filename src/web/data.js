import { latestFeedback } from '../metrics/feedback.js';
import { styleTest } from '../render/style.js';
import { DAY, monthKey, now } from '../core/clock.js';
import { waitingImages } from '../images/index.js';
import { KEYS, isSet } from '../core/env.js';
import { settings } from '../core/store.js';
import { j } from '../db/index.js';
import { costPerPost, monthSpend } from '../budget/ledger.js';
import { lastMonths, ledger, usage } from '../budget/quota.js';
import { loadPost } from '../pipeline/build.js';
import { photoChoices } from '../pipeline/light.js';
import { israelDate, israelInstant, addDays } from '../schedule/israel.js';
import { groupsOf, hookStats, mixOf, relative, postScore, resting, templateStats } from '../formats/rotation.js';
import { MECHANISMS, speakerOf, templatesFor, voiced } from '../formats/hooks.js';
import { hookPatterns, kindOf } from '../formats/kinds.js';
import { takedowns } from '../publish/takedown.js';
import { engineMode } from '../engine.js';
import { publisherFor, tiktokMode, wantedPublisher } from '../publish/index.js';
import { zernioConfigured } from '../publish/zernio.js';
import { igConfig, instagramConfigured } from '../publish/instagram.js';
import { getSetting } from '../core/store.js';
import { resolveFormat } from '../trends/index.js';
import { factProblems, factState, readTopics } from '../sources/facts.js';
import { rivalsOf, timesBeside } from '../pipeline/rivals.js';
import { SOUNDS, soundsOf, recentSoundIds } from '../pipeline/sounds.js';
import { vapid } from '../notify/index.js';
import path from 'node:path';
import { PASS, topicById, topicsOf, watchList } from '../topics/index.js';
import { youtubeConfigured } from '../trends/index.js';
import { owns } from './workspace.js';
import { prefsOf } from '../assistant/data.js';
import { connectData } from './connect.js';
import { zernioCost } from '../publish/connect.js';
import { scheduleOf, timesOf } from '../schedule/choice.js';
import { scheduleData } from './schedule.js';
import { emailPrefsOf } from '../notify/email.js';
import { unconnectedPlatforms } from '../publish/hold.js';
import { autonomyMode, isCustomerAccount, mayResume } from '../autonomy/rails.js';

// What each page shows, as plain queries. Pages never touch the database
// themselves, so what a page can see is listed here.

/**
 * The site seen from one account: every page lists ctx.packs, so a context whose packs are that account alone shows
 * that account alone.
 */
export function scoped(ctx, pack) {
  const s = Object.create(ctx.root || ctx);
  s.root = ctx.root || ctx;
  s.packs = pack ? [pack] : [];
  return s;
}

/** The ids of the accounts a context shows, and the SQL that keeps a query to them; a context without packs is every one. */
const inAccounts = (ctx, col = 'account_id') => (ctx.packs ? [`${col} IN (${ctx.packs.map(() => '?').join(', ') || 'NULL'})`, ctx.packs.map((p) => p.id)] : ['1 = 1', []]);

export function header(ctx) {
  const s = settings(ctx.db);
  // What waits, per account: the switcher says it beside each name, the Posts tab for the account shown.
  const per = Object.fromEntries(ctx.db.all("SELECT account_id, COUNT(*) AS n FROM posts WHERE status = 'queued' AND sample = 0 GROUP BY account_id").map((r) => [r.account_id, r.n]));
  // The switcher lists the context's accounts: a workspace's, or every one for the operator.
  const waiting = ctx.packs.reduce((a, p) => a + (per[p.id] || 0), 0);
  const all = (ctx.root || ctx).packs;
  const accounts = all.map((p) => ({ id: p.id, name: p.meta.displayName, handle: p.meta.handle, waiting: per[p.id] || 0 }));
  // The month's suggestions of the accounts shown, against their plans (src/budget/quota.js): the header's number.
  const quota = ctx.packs.map((p) => usage(ctx.db, p.id).suggested).reduce((a, x) => ({ used: a.used + x.used, limit: a.limit + x.limit }), { used: 0, limit: 0 });
  return {
    quota,
    waiting,
    accounts,
    current: ctx.packs.length === 1 ? ctx.packs[0].id : null,
    globalKill: s.globalKill,
  };
}

export function accountRows(ctx) {
  return ctx.packs.map((pack) => {
    const acc = ctx.db.get('SELECT * FROM accounts WHERE id = ?', pack.id);
    // The customer's month: suggestions and redos used of their plan. What it cost is the operator's to see.
    // The mode the engine acts on (a customer's is approve, whatever is stored: src/autonomy/rails.js), and whether this
    // session may lift a pause (the operator's kill switch and a strike are the operator's).
    const mode = autonomyMode(ctx.db, pack.id);
    const customer = isCustomerAccount(ctx.db, pack.id);
    const resumable = mayResume(ctx.db, pack.id, { operator: ctx.workspaceId == null });
    return { pack, acc, mode, customer, resumable, spend: monthSpend(ctx.db, pack.id).usd, publishers: publishersOf(ctx, pack), quota: usage(ctx.db, pack.id), connect: connectData(ctx, pack) };
  });
}

/** Each platform's publisher: what the pack asks for, and what it really goes through now. */
export function publishersOf(ctx, pack) {
  return pack.meta.platforms.map((platform) => ({ platform, wants: wantedPublisher(pack, platform), via: publisherFor(pack, platform, { db: ctx.db }) }));
}

/** How long a post that did not go out stays on the lists, to be sent again. */
export const FAILED_DAYS = 14;

/** Today: what waits for a decision, what is scheduled, what was refused and what went out. */
export function today(ctx, t = now()) {
  const day = israelDate(t);
  const from = israelInstant(day, '00:00').toISOString();
  const groups = accountRows(ctx).filter((row) => row.acc?.status !== 'onboarding').map((row) => {
    const id = row.pack.id;
    const ids = (sql, ...a) => ctx.db.all(sql, ...a).map((r) => loadPost(ctx.db, r.id));
    return {
      ...row,
      waiting: ids("SELECT id FROM posts WHERE account_id = ? AND status = 'queued' AND sample = 0 ORDER BY slot_at IS NULL, slot_at, created_at", id),
      scheduled: ids("SELECT id FROM posts WHERE account_id = ? AND status = 'approved' ORDER BY slot_at", id),
      // Approved, and waiting for TikTok or Instagram to be connected (src/publish/hold.js); what is not connected.
      held: ids("SELECT id FROM posts WHERE account_id = ? AND status = 'held' ORDER BY slot_at", id),
      // Posts that did not go out, the last two weeks, newest first: each with "לנסות שוב" (src/web/actions.js retryPublish).
      failed: ctx.db.all("SELECT id, hook, topic, reason, slot_at, updated_at, publish_json FROM posts WHERE account_id = ? AND status = 'failed' AND sample = 0 AND updated_at >= ? ORDER BY updated_at DESC", id, new Date(t - FAILED_DAYS * DAY).toISOString()),
      unconnected: unconnectedPlatforms(ctx.db, row.pack),
      blocked: ctx.db.all("SELECT id, hook, topic, reason, format_id, created_at FROM posts WHERE account_id = ? AND status = 'blocked' AND created_at >= ? ORDER BY created_at DESC", id, from),
      published: ctx.db.all("SELECT id, hook, published_at, publish_json FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? ORDER BY published_at DESC", id, from),
      // TikTok drafts of the last day and a half, each with where it stands (src/publish/draft.js); a duplicate stays
      // on the page until it is a day old.
      drafts: ctx.db
        .all("SELECT id, hook, slot_at, published_at, publish_json FROM posts WHERE account_id = ? AND publish_json LIKE '%\"flow\"%' AND published_at >= ? ORDER BY published_at DESC", id, new Date(t - 36 * 3_600_000).toISOString())
        .map((p) => ({ id: p.id, hook: p.hook, slotAt: p.slot_at || p.published_at, flow: j(p.publish_json, {}).tiktok?.flow || {} })),
    };
  });
  const overall = ctx.db.get('SELECT * FROM summaries WHERE account_id IS NULL ORDER BY day DESC LIMIT 1');
  const live = new Set(groups.map((g) => g.pack.id));
  const summaryRows = overall
    ? ctx.db
        .all('SELECT account_id, data_json FROM summaries WHERE day = ? AND account_id IS NOT NULL', overall.day)
        .filter((r) => live.has(r.account_id))
        .map((r) => ({ account_id: r.account_id, data: j(r.data_json, {}) }))
    : [];
  // The overall summary's text names every account on the server: a workspace gets its own rows, or no summary.
  const summary = ctx.workspaceId == null ? overall : summaryRows.length ? { ...overall, text: '' } : null;
  return { day, groups, summary, summaryRows, attention: attention(ctx) };
}

/** The last 7 Israel days for one account: posts published per day, and reach where it is known. */
export function week(ctx, accountId, t = now()) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(israelDate(t), -i);
    const from = israelInstant(d, '00:00').toISOString();
    const to = israelInstant(addDays(d, 1), '00:00').toISOString();
    const n = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? AND published_at < ?", accountId, from, to).n;
    days.push({ day: d, n, at: from });
  }
  const since = new Date(t - 7 * DAY).toISOString();
  const views = ctx.db.get(
    "SELECT SUM(m.views) AS v FROM metrics m JOIN posts p ON p.id = m.post_id WHERE p.account_id = ? AND p.published_at >= ? AND m.id IN (SELECT MAX(id) FROM metrics GROUP BY post_id, platform)",
    accountId,
    since
  ).v;
  const counts = Object.fromEntries(ctx.db.all("SELECT status, COUNT(*) AS n FROM posts WHERE account_id = ? AND created_at >= ? AND sample = 0 GROUP BY status", accountId, since).map((r) => [r.status, r.n]));
  return { days, views, counts };
}

/** Results: per post (newest reading per platform) and per format, with what is being dropped. */
export function results(ctx, t = now()) {
  const since = new Date(t - 30 * DAY).toISOString();
  const [mine, ids] = inAccounts(ctx, 'p.account_id');
  const posts = ctx.db
    .all(`SELECT p.id, p.account_id, p.hook, p.format_id, p.published_at FROM posts p WHERE p.status = 'published' AND p.published_at >= ? AND ${mine} ORDER BY p.published_at DESC`, since, ...ids)
    .map((p) => {
      const m = ctx.db.all('SELECT * FROM metrics WHERE post_id = ? AND id IN (SELECT MAX(id) FROM metrics WHERE post_id = ? GROUP BY platform)', p.id, p.id);
      const per = Object.fromEntries(m.map((r) => [r.platform, { ...r, score: postScore(r.platform, r), demo: j(r.raw_json, {})?.source === 'demo-seed' }]));
      return { ...p, metrics: per };
    });
  const demo = posts.some((p) => Object.values(p.metrics).some((m) => m.demo));
  const medians = {};
  for (const plat of ['tiktok', 'instagram']) {
    const xs = posts.map((p) => p.metrics[plat]?.score).filter((x) => x != null).sort((a, b) => a - b);
    medians[plat] = xs.length ? xs[Math.floor(xs.length / 2)] : null;
  }
  const rel = (p) => {
    const r = ['tiktok', 'instagram'].map((pl) => (p.metrics[pl]?.score != null && medians[pl] ? p.metrics[pl].score / medians[pl] : null)).filter((x) => x != null);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
  };
  const scored = posts.map((p) => ({ ...p, rel: rel(p) })).filter((p) => p.rel != null);
  // A post is a winner at or above the median and a loser under it, never both.
  const winners = scored.filter((p) => p.rel >= 1).sort((a, b) => b.rel - a.rel).slice(0, 5);
  const losers = scored.filter((p) => p.rel < 1).sort((a, b) => a.rel - b.rel).slice(0, 5);
  const formats = ctx.packs.map((pack) => {
    const rows = ctx.db.all('SELECT * FROM formats WHERE account_id = ? ORDER BY status, kind DESC, format_key', pack.id).map((f) => ({ ...f, results: j(f.results_json, []) }));
    const r = relative(rows, { t });
    return {
      pack,
      rows: rows.map((f) => {
        const mine = (r[f.format_key] || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        const avg = mine.length ? mine.reduce((s, x) => s + x.rel, 0) / mine.length : null;
        const last = mine.slice(-3);
        const atRisk = f.status === 'active' && last.length >= 2 && last.slice(-2).every((x) => x.rel < 0.7);
        const def = resolveFormat(ctx.db, pack, f.format_key);
        return { ...f, name: def?.name || f.format_key, avg, last, atRisk, n: mine.length };
      }),
    };
  });
  const trends = ctx.db.all(`SELECT * FROM trend_formats WHERE ${mine.replace('p.account_id', 'account_id')} ORDER BY found_at DESC LIMIT 30`, ...ids).map((x) => ({ ...x, card: j(x.card_json, null) }));
  // The mix of entertaining and number posts, and the cover patterns, per account, in words.
  const learning = ctx.packs.map((pack) => {
    const share = mixOf(ctx.db, pack);
    const learned = getSetting(ctx.db, `mix:${pack.id}`, null);
    const stats = hookStats(ctx.db, pack.id, { t });
    const hooks = (pack.formats.formats || []).flatMap((f) =>
      hookPatterns(f).map((h) => ({ format: f.name, kind: kindOf(f).name, id: h.id, pattern: h.pattern, n: stats[f.id]?.[h.id]?.n || 0, avg: stats[f.id]?.[h.id]?.avg ?? null, used: ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND format_id = ? AND hook_pattern = ? AND status NOT IN ('blocked')", pack.id, f.id, h.id).n }))
    );
    // The cover templates are the engine's, learned over every format of the account (src/formats/rotation.js).
    const tstats = templateStats(ctx.db, pack.id, { t });
    const tpls = [...new Map((pack.formats.formats || []).flatMap((f) => templatesFor(pack, f)).map((x) => [x.id, x])).values()];
    for (const x of tpls) {
      const used = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND hook_pattern = ? AND status NOT IN ('blocked')", pack.id, `tpl:${x.id}`).n;
      hooks.push({ format: `תבנית שער: ${MECHANISMS[x.mechanism]?.he || x.mechanism}`, kind: '', id: `tpl:${x.id}`, pattern: voiced(x, speakerOf(pack)), n: tstats[x.id]?.n || 0, avg: tstats[x.id]?.avg ?? null, used, resting: resting(tstats[x.id], { t }), template: true });
    }
    const groups = groupsOf(pack);
    const recent = ctx.db.all("SELECT format_id, grp FROM posts WHERE account_id = ? AND status IN ('published', 'approved', 'queued') ORDER BY created_at DESC LIMIT 30", pack.id);
    const ent = recent.filter((p) => (p.grp || groups[p.format_id]) === 'entertaining').length;
    return { pack, share, learned, hooks, recent: recent.length, recentEnt: ent };
  });
  // The morning's feedback: each account's latest report and what became of its plans.
  const feedback = latestFeedback(ctx.db, ctx.packs);
  // Each account's style test (src/render/style.js), running or settled.
  const styleTests = ctx.packs.map((pack) => ({ pack, test: styleTest(ctx.db, pack) })).filter((x) => x.test);
  return { posts, scored, winners, losers, formats, medians, demo, trends, learning, feedback, blocks: blockRates(ctx, t), styleTests };
}

/**
 * Which checks stop posts: of the posts drafted in the last 30 days, how many each check blocked, and how many
 * first drafts failed it (the repair and the redraft mend most of those). A block with no checks recorded (one
 * before they were, or one that is not a check's: no source, no photograph, the reviewer) counts under its kind.
 */
export function blockRates(ctx, t = now()) {
  const since = new Date(t - 30 * DAY).toISOString();
  const [mine, ids] = inAccounts(ctx);
  const posts = ctx.db.all(`SELECT id, account_id, status FROM posts WHERE created_at >= ? AND sample = 0 AND status NOT IN ('drafting') AND ${mine}`, since, ...ids);
  const rows = new Map();
  const row = (check) => rows.get(check) || rows.set(check, { check, blocked: 0, firstFail: 0 }).get(check);
  let blocked = 0;
  for (const p of posts) {
    const steps = ctx.db.all("SELECT step, detail_json FROM steps WHERE post_id = ? AND step IN ('slides', 'blocked') ORDER BY id", p.id).map((x) => ({ step: x.step, d: j(x.detail_json, {}) }));
    const first = steps.find((x) => x.step === 'slides');
    for (const c of first?.d.checks || []) row(c).firstFail++;
    const b = p.status === 'blocked' ? steps.filter((x) => x.step === 'blocked').pop() : null;
    if (!b) continue;
    blocked++;
    for (const c of b.d.checks?.length ? b.d.checks : [`kind:${b.d.kind || 'other'}`]) row(c).blocked++;
  }
  const list = [...rows.values()].sort((a, b) => b.blocked - a.blocked || b.firstFail - a.firstFail);
  return { total: posts.length, blocked, rows: list };
}

/** A pack's hand-checked facts, each with its state today and anything wrong with it. */
export function factsFor(ctx, pack) {
  return readTopics(path.join(pack.dir, 'facts')).map((t) => ({
    ...t,
    owner: t.owner,
    facts: t.facts.map((f) => ({ ...f, state: factState(f, undefined, { owner: t.owner }), problems: factProblems(f, { maxQuoteWords: pack.rules.maxQuoteWords || 40, owner: t.owner }) })),
  }));
}

/** An account's sound list, how its TikTok posts go out, and which sounds its last drafts had. */
export function soundsFor(ctx, pack) {
  return { current: pack, sounds: soundsOf(ctx.db, pack.id), mode: tiktokMode(pack, ctx.db), recent: recentSoundIds(ctx.db, pack.id), limits: SOUNDS };
}

/** An account's topics before documents: the bank, the signals with their scores, and what feeds them. */
export function topicsFor(ctx, pack) {
  const all = topicsOf(ctx.db, pack.id);
  return { current: pack, topics: all, pass: PASS, watch: watchList(ctx.db, pack), queries: pack.formats.trends?.queries || {}, youtube: youtubeConfigured(), live: ctx.mode === 'live' };
}

/** An account's rivals, and their posting hours beside the account's own slots. */
export function rivalsFor(ctx, pack) {
  const rivals = rivalsOf(ctx.db, pack.id);
  return { current: pack, rivals, times: timesBeside(rivals, timesOf(scheduleOf(ctx.db, pack))) };
}

export function sourcesFor(ctx, accountId) {
  return ctx.db.all("SELECT s.*, (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id) AS docs FROM sources s WHERE s.account_id = ? ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, s.name", accountId).map((s) => ({ ...s, score: j(s.score_json, null), config: j(s.config_json, {}) }));
}

/** Settings. A workspace sees its own accounts, browsers and spend; the server's keys, engine and log are the operator's. */
export function settingsData(ctx) {
  const s = settings(ctx.db);
  const operator = ctx.workspaceId == null;
  // Every account of the workspace, not only the one shown.
  const mine = (ctx.root || ctx).packs.map((p) => p.id);
  return {
    settings: s,
    spend: operator ? monthSpend(ctx.db, undefined) : { usd: mine.reduce((a, id) => a + monthSpend(ctx.db, id).usd, 0), month: monthKey() },
    month: monthKey(),
    // What each account cost this month, and per post over 30 days: the operator's, to read. Nothing is capped.
    costs: operator ? (ctx.root || ctx).packs.map((pack) => ({ id: pack.id, name: pack.meta.displayName, spent: monthSpend(ctx.db, pack.id).usd, perPost: costPerPost(ctx.db, pack.id) })) : [],
    perAccount: accountRows(ctx),
    keys: KEYS.map((k2) => ({ ...k2, set: isSet(k2.name) })),
    mode: engineMode(),
    publishers: ctx.packs.map((p) => ({ id: p.id, name: p.meta.displayName, platforms: publishersOf(ctx, p) })),
    // What is known about each pack's Instagram token without asking Meta: the check script asks.
    instagram: ctx.packs
      .filter((p) => p.meta.platforms.includes('instagram') && wantedPublisher(p, 'instagram') === 'instagram')
      .map((p) => {
        const cfg = igConfig(p);
        const saved = getSetting(ctx.db, `instagram:token:${p.id}`, null);
        return { id: p.id, name: p.meta.displayName, auth: cfg.auth, tokenEnv: cfg.tokenEnv, userId: cfg.userId, configured: instagramConfigured(ctx.db, p), daysLeft: saved?.expiresAt ? Math.floor((saved.expiresAt - now()) / DAY) : null };
      }),
    zernio: zernioConfigured(),
    liveSwitch: process.env.PUBLISH_MODE === 'live',
    push: { key: vapid(ctx.db).publicKey, browsers: operator ? ctx.db.get('SELECT COUNT(*) AS n FROM push_subs WHERE failed < 5').n : ctx.db.get('SELECT COUNT(*) AS n FROM push_subs WHERE failed < 5 AND workspace_id = ?', ctx.workspaceId).n },
    audit: operator ? ctx.db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 40').map((a) => ({ ...a, detail: j(a.detail_json, null) })) : [],
    quotas: operator ? quotasData(ctx) : null,
    // The customer's month, account by account: what the plan promises and what is used of it.
    plans: (ctx.root || ctx).packs.map((pack) => ({ pack, usage: usage(ctx.db, pack.id) })),
    // The customer's choices for the WhatsApp assistant: a workspace's own, the operator has none.
    assistant: operator ? null : prefsOf(ctx.db, ctx.workspaceId),
    // The days and times the account shown posts on (src/schedule/choice.js): its owner chooses them here.
    schedule: ctx.packs[0] ? scheduleData(ctx.db, ctx.packs[0]) : null,
    // Which emails the workspace's owners get (src/notify/email.js).
    email: operator ? null : emailPrefsOf(ctx.db, ctx.workspaceId),
  };
}

/**
 * The operator's view of every customer's month: each account's plan and where it stands, and what it really cost
 * by what the money was for (src/budget/quota.js ledger), this month and the two before it.
 */
export function quotasData(ctx, t = now()) {
  const months = lastMonths(3, t);
  return {
    months,
    // Zernio's bill for the account's profile, next to the API spend: a subscription, billed per connected account.
    accounts: (ctx.root || ctx).packs.map((pack) => ({ pack, usage: usage(ctx.db, pack.id, t), ledgers: months.map((m) => ledger(ctx.db, pack.id, m)), zernio: Object.fromEntries(months.map((m) => [m, zernioCost(ctx.db, pack.id, m)])) })),
  };
}

export const postFull = (ctx, id) => {
  const post = loadPost(ctx.db, id);
  // Another workspace's post is not found, as one that never was.
  if (!post || !owns(ctx, post.account_id)) return null;
  return {
    post,
    pack: ctx.pack(post.account_id),
    steps: ctx.db.all('SELECT * FROM steps WHERE post_id = ? ORDER BY id', id).map((s) => ({ ...s, detail: j(s.detail_json, null) })),
    spend: ctx.db.all('SELECT api, model, usd, estimated, tag FROM spend WHERE post_id = ? ORDER BY id', id),
    // The photograph the page asks a person about: the first still waiting, else the lead one.
    image: waitingImages(ctx.db, post)[0] || (post.checks?.image ? ctx.db.get('SELECT * FROM images WHERE id = ?', post.checks.image) : null),
    metrics: ctx.db.all('SELECT * FROM metrics WHERE post_id = ? ORDER BY collected_at DESC', id),
    takedowns: takedowns(ctx.db, { limit: 200 }).filter((x) => x.post_id === id),
    // The topic it was drafted about, when it started from one (src/topics): its scores are shown on the post.
    topic: post.topic_id ? topicById(ctx.db, post.topic_id) : null,
    // The photographs a slide may take instead (light edits: nothing new is searched for).
    photos: photoChoices(ctx.db, post),
    // The post it replaced, the one that replaced it, and the customer's month (redos left).
    redoOf: post.redo_of ? ctx.db.get('SELECT id, hook, reason FROM posts WHERE id = ?', post.redo_of) : null,
    replacement: post.reject?.replacement ? ctx.db.get('SELECT id, hook, status FROM posts WHERE id = ?', post.reject.replacement) : null,
    quota: usage(ctx.db, post.account_id),
  };
};

/**
 * What waits for a person outside the queue: posts to delete by hand after a
 * takedown notice, and photographs the image screen could not clear.
 */
export function attention(ctx) {
  const shown = new Set(ctx.packs.map((p) => p.id));
  const waitingDeletes = takedowns(ctx.db, { limit: 200 }).filter((x) => x.waiting.length && shown.has(x.account_id || x.acc));
  const images = ctx.db
    .all("SELECT DISTINCT p.id, p.hook, p.account_id, i.id AS image_id, i.safety_json FROM posts p JOIN images i ON i.id = json_extract(p.checks_json, '$.image') OR i.id IN (SELECT image_id FROM slides WHERE post_id = p.id) WHERE p.status IN ('queued', 'approved') AND i.safety IS NOT NULL AND i.safety != 'ok' AND i.reviewed_at IS NULL GROUP BY p.id")
    .filter((r) => shown.has(r.account_id))
    .map((r) => ({ ...r, screen: j(r.safety_json, null) }));
  return { waitingDeletes, images };
}
