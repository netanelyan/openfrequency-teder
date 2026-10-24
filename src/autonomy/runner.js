import { now, nowIso } from '../core/clock.js';
import { audit, getSetting, setSetting, settings } from '../core/store.js';
import { j } from '../db/index.js';
import { israelDate, israelInstant, addDays, hhmm } from '../schedule/israel.js';
import { inRest } from '../schedule/shabbat.js';
import { inWindows, slotsFor, postsOn } from '../schedule/slots.js';
import { buildPost, PausedError } from '../pipeline/build.js';
import { publishPost, sendWaitingDrafts } from '../publish/index.js';
import { watchDrafts } from '../publish/draft.js';
import { REWRITE_AT } from '../voice/review.js';
import { collectMetrics, learn } from '../metrics/collect.js';
import { canRun } from './rails.js';
import { usage } from '../budget/quota.js';
import { runTrends, youtubeConfigured } from '../trends/index.js';
import { collectSignals, scoreTopics } from '../topics/index.js';
import { makeBatcher, recoverBatches } from '../llm/batch.js';
import { wantedPublisher } from '../publish/index.js';
import { currentToken, igConfig, refreshToken } from '../publish/instagram.js';
import { fightWeekSlots, parseEvents, recapsDue, saveEvents } from '../schedule/events.js';
import { refreshSource } from '../sources/index.js';
import { morningFeedback, withDirectives } from '../metrics/feedback.js';
import { assistantTick } from '../assistant/events.js';
import { zernioTick } from '../publish/connect.js';

// The engine running on its own: one tick a minute.
//
//   1. the calendars of the packs that follow events
//   1b. the morning's feedback, at settings.feedbackAt (never after generateAt):
//      the last three days' posts read fresh and put in their boxes, and what
//      each box asks becomes a directive the day's generation hands to a slot
//      (src/metrics/feedback.js)
//   2. generate, a day ahead: once a day, at settings.generateAt (Israel time),
//      each running account gets a post for each of tomorrow's slots (Shabbat,
//      the festivals and out-of-window slots are dropped by slotsFor and never
//      planned), plus any of today's slots that have none and are far enough
//      away. With Claude live, the whole day's posts are drafted together through
//      the Message Batches API at half price, in the background, while the ticks
//      go on publishing. No more posts than the account's month has left
//      (src/budget/quota.js, 40 suggestions and 10 redos): when its suggestions
//      are used up, nothing until the next month. No money cap stops or slows
//      anything.
//   3. modes, at each post's slot:
//        approve  the post waits for the owner; unapproved by the end of its
//                 day, it expires
//        digest   it is approved by the engine at its slot unless the owner
//                 rejected it before then
//        auto     it is approved by the engine and goes out; a daily summary
//                 says what happened
//      In digest and auto, a post the reviewer scored as sounding a little like
//      a bot (4 or 5) waits for the owner instead.
//   4. publish what is approved and due, inside the account's windows, outside
//      Shabbat and the festivals
//   4b. tell the WhatsApp assistant what happened (src/assistant/events.js): a post
//      that waits, the slot, a post out or still not out an hour on, the month's
//      last suggestions, Sunday's summary; held through the customer's quiet hours
//   5. read metrics, credit them to formats at 72 hours, judge the formats
//   6. write yesterday's summary
//
// The rails (kill switches, pauses) are checked before every generation and
// every publish.

/** Batches draft in minutes to hours: today's empty slots are filled only when this far away. */
export const CATCH_UP_LEAD_MS = 3 * 3_600_000;

/** The slots to draft for one account at today's generation: tomorrow's, and today's that have no post yet. */
export function generationTargets(db, pack, { t = now(), lead = 0 } = {}) {
  const today = israelDate(t);
  const sched = pack.meta.schedule;
  const live = db.all("SELECT slot_at FROM posts WHERE account_id = ? AND slot_at IS NOT NULL AND status NOT IN ('blocked', 'drafting')", pack.id).map((r) => r.slot_at);
  const have = new Set(live);
  const onDay = (d) => live.filter((s) => israelDate(Date.parse(s)) === d).length;
  const out = [];
  for (const [day, notBefore] of [[today, t + lead], [addDays(today, 1), null]]) {
    const room = Math.max(0, (postsOn(day, sched.postsPerDay) ?? Infinity) - onDay(day));
    const free = slotsFor(day, sched, { notBefore }).slots.filter((s) => !have.has(s.toISOString()));
    out.push(...free.slice(0, room).map((s) => s.toISOString()));
  }
  return out;
}

/**
 * Draft posts for these slots: [{ pack, slotAt }]. Through a batch when Claude
 * is live, every post at once; otherwise one after another.
 */
export async function generate(ctx, plans, report) {
  const { db } = ctx;
  const useBatch = ctx.llm.kind === 'claude' && ctx.batchApi && process.env.OF_BATCH !== 'off';
  const stopped = new Set();
  const one = async (gctx, { pack, slotAt, formatKey = null, subject = null, directive = null }) => {
    if (stopped.has(pack.id)) return;
    try {
      const res = await buildPost(gctx, { pack, slotAt, formatKey, subject, directive });
      if (directive?.id) db.update('directives', directive.id, { used_post_id: res.postId });
      db.update('posts', res.postId, { mode_at_queue: db.get('SELECT mode FROM accounts WHERE id = ?', pack.id)?.mode });
      // A failed fact check blocks that post alone: the account goes on with the rest of its day.
      report.generated.push({ account: pack.id, post: res.postId, status: res.status, reason: res.reason, cost: res.cost });
    } catch (e) {
      if (e instanceof PausedError) stopped.add(pack.id);
      else report.errors.push({ account: pack.id, step: 'generate', error: e.message });
    }
  };
  if (!useBatch) {
    for (const p of plans) await one(ctx, p);
    return report;
  }
  const batcher = makeBatcher(ctx, { api: ctx.batchApi });
  ctx.batchesInFlight = batcher.owned;
  const bctx = { ...ctx, llm: batcher };
  await Promise.all(plans.map((p) => batcher.run(() => one(bctx, p))));
  return report;
}

/**
 * The day-ahead plans for these slots, with a fight week laid over them: the
 * tale of the tape and the prediction take their day's first slot, with their
 * format and the event as the subject; the recap's slot is held back, to be
 * drafted on the morning after, once the results exist.
 */
export function fightWeekPlans(db, pack, slots) {
  if (!pack.meta.schedule?.fightWeek) return slots.map((slotAt) => ({ slotAt }));
  const out = [];
  for (const day of [...new Set(slots.map((s) => israelDate(Date.parse(s))))]) {
    const ofDay = slots.filter((s) => israelDate(Date.parse(s)) === day);
    const { assign, reserved } = fightWeekSlots(db, pack, day, ofDay);
    for (const slotAt of ofDay) {
      if (reserved.has(slotAt)) continue;
      const w = assign.get(slotAt);
      out.push(w ? { slotAt, formatKey: w.formatKey, subject: w.subject } : { slotAt });
    }
  }
  return out;
}

/** The calendar of a pack that follows events, read from its listing once a day. */
export async function syncEvents(ctx, pack, { t = now() } = {}) {
  const cfg = pack.meta.events;
  if (!cfg?.source) return 0;
  const key = `events:synced:${pack.id}`;
  const last = getSetting(ctx.db, key);
  if (last && t - Date.parse(last) < 20 * 3_600_000) return 0;
  setSetting(ctx.db, key, new Date(t).toISOString());
  const src = ctx.db.get("SELECT * FROM sources WHERE account_id = ? AND key = ? AND status = 'approved'", pack.id, cfg.source);
  if (!src) return 0;
  let n = 0;
  for (const d of await refreshSource(ctx.db, ctx.sourcesFor ? ctx.sourcesFor(pack) : ctx.sources, src)) n += saveEvents(ctx.db, pack.id, parseEvents(d.text), { sourceId: src.id, url: d.url });
  return n;
}

/**
 * The morning after a card: once it is over, its recap is drafted directly (a
 * batch could take hours), and drafted again every 45 minutes until there is a
 * post, if the results were not in the sources yet.
 */
export async function generateRecaps(ctx, report, { t = now() } = {}) {
  const { db } = ctx;
  const today = israelDate(t);
  for (const pack of ctx.packs) {
    if (!pack.meta.schedule?.fightWeek || !canRun(db, pack.id).ok) continue;
    for (const w of recapsDue(db, pack, t)) {
      const slots = slotsFor(today, pack.meta.schedule).slots.map((s) => s.toISOString());
      const slot = [...fightWeekSlots(db, pack, today, slots).assign].find(([, x]) => x.role === 'recap')?.[0];
      if (!slot || t > Date.parse(slot) - 30 * 60_000) continue;
      if (db.get("SELECT id FROM posts WHERE account_id = ? AND slot_at = ? AND status NOT IN ('blocked')", pack.id, slot)) continue;
      const key = `recap:${pack.id}:${w.event.key}`;
      const last = getSetting(db, key);
      if (last && t - Date.parse(last) < 45 * 60_000) continue;
      setSetting(db, key, new Date(t).toISOString());
      await generate({ ...ctx, batchApi: null }, [{ pack, slotAt: slot, formatKey: w.formatKey, subject: w.subject }], report);
    }
  }
}

export async function tick(ctx, { t = now() } = {}) {
  const { db } = ctx;
  const today = israelDate(t);
  const cfg = settings(db);
  const report = { at: new Date(t).toISOString(), generated: [], published: [], expired: [], approved: [], errors: [] };

  // ---- 0. a batch a restart left behind is recorded, so no paid call goes unbilled
  if (ctx.batchApi && db.get("SELECT id FROM batches WHERE status != 'recorded' LIMIT 1")) {
    const last = getSetting(db, 'batches:recovered');
    if (!last || t - Date.parse(last) > 10 * 60_000) {
      setSetting(db, 'batches:recovered', new Date(t).toISOString());
      report.recovered = await recoverBatches(ctx, { api: ctx.batchApi, skip: ctx.batchesInFlight || new Set() }).catch((e) => (report.errors.push({ step: 'batches', error: e.message }), []));
    }
  }

  // ---- 1a. the calendars of the packs that follow events, once a day
  for (const pack of ctx.packs) await syncEvents(ctx, pack, { t }).catch((e) => report.errors.push({ account: pack.id, step: 'events', error: e.message }));

  // ---- 1b. the morning's feedback, before anything is drafted: once a day per account
  const feedbackAt = cfg.feedbackAt < cfg.generateAt ? cfg.feedbackAt : cfg.generateAt;
  if (t >= israelInstant(today, feedbackAt).getTime()) {
    for (const pack of ctx.packs) {
      const key = `feedback:${pack.id}:${today}`;
      const acc = db.get('SELECT status FROM accounts WHERE id = ?', pack.id);
      if (!acc || acc.status === 'onboarding' || getSetting(db, key)) continue;
      setSetting(db, key, new Date(t).toISOString());
      try {
        const fb = await morningFeedback(ctx, pack, { t });
        report.feedback = { ...(report.feedback || {}), [pack.id]: { posts: fb.posts.length, directives: fb.directives.length } };
      } catch (e) {
        report.errors.push({ account: pack.id, step: 'feedback', error: e.message });
      }
    }
  }

  // ---- 1c. topics before documents (src/topics): what people are looking at, read and scored once a day per account,
  // before anything is drafted. The signals are live only; the bank's topics are scored wherever a model answers.
  if (t >= israelInstant(today, feedbackAt).getTime()) {
    for (const pack of ctx.packs) {
      const key = `topics:${pack.id}:${today}`;
      const acc = db.get('SELECT status FROM accounts WHERE id = ?', pack.id);
      if (!acc || acc.status === 'onboarding' || getSetting(db, key)) continue;
      setSetting(db, key, new Date(t).toISOString());
      try {
        const found = ctx.mode === 'live' ? await collectSignals(ctx, pack, { t }) : null;
        const scored = await scoreTopics(ctx, pack);
        report.topics = { ...(report.topics || {}), [pack.id]: { found, ...scored } };
      } catch (e) {
        report.errors.push({ account: pack.id, step: 'topics', error: e.message });
      }
    }
  }

  // ---- 2. generate, a day ahead, once a day
  const plans = [];
  if (!ctx.generating && t >= israelInstant(today, cfg.generateAt).getTime()) {
    for (const pack of ctx.packs) {
      const acc = db.get('SELECT * FROM accounts WHERE id = ?', pack.id);
      const genKey = `generated:${pack.id}:${today}`;
      if (!acc || acc.status === 'onboarding' || getSetting(db, genKey) || !canRun(db, pack.id).ok) continue;
      // The customer's month, before the day is marked generated: a quota the operator raises later in the day lets
      // the account's posts be drafted the same day.
      const month = usage(db, pack.id, t);
      if (month.suggested.left <= 0) {
        (report.quotaFull ||= []).push(pack.id);
        continue;
      }
      setSetting(db, genKey, nowIso());
      const lead = ctx.llm.kind === 'claude' && ctx.batchApi && process.env.OF_BATCH !== 'off' ? CATCH_UP_LEAD_MS : 0;
      // No more slots than the month has suggestions left, the earliest first; cut before the directives are handed
      // out, so none is marked used by a slot that will not be drafted.
      const mine = withDirectives(db, pack, fightWeekPlans(db, pack, generationTargets(db, pack, { t, lead })).slice(0, month.suggested.left));
      for (const p of mine) plans.push({ pack, ...p });
    }
  }
  if (plans.length) {
    const job = generate(ctx, plans, report);
    if (ctx.llm.kind === 'claude' && ctx.batchApi && process.env.OF_BATCH !== 'off') {
      // A batch takes minutes to hours: it runs beside the ticks, which go on publishing.
      ctx.generating = job
        .then((r) => ctx.log?.(`generated ${r.generated.length}: ${r.generated.map((g) => `${g.account} ${g.status}`).join(', ')}`))
        .catch((e) => ctx.log?.(`generation: ${e.stack || e.message}`))
        .finally(() => (ctx.generating = null));
      report.generating = plans.length;
    } else await job;
  }

  // ---- 2a. the morning after a card: its recap, once the results exist
  await generateRecaps(ctx, report, { t }).catch((e) => report.errors.push({ step: 'recap', error: e.message }));

  for (const pack of ctx.packs) {
    const acc = db.get('SELECT * FROM accounts WHERE id = ?', pack.id);
    if (!acc || acc.status === 'onboarding') continue;
    const run = canRun(db, pack.id);

    // ---- 3. modes at the slot
    const due = db.all("SELECT * FROM posts WHERE account_id = ? AND status = 'queued' AND slot_at IS NOT NULL AND slot_at <= ?", pack.id, new Date(t).toISOString());
    for (const p of due) {
      if (acc.mode === 'approve' || (p.review_score ?? 0) >= REWRITE_AT) {
        if (israelDate(Date.parse(p.slot_at)) < today) {
          db.update('posts', p.id, { status: 'expired', reason: acc.mode === 'approve' ? 'לא אושר עד סוף היום' : 'נשמע קצת כמו בוט וחיכה לאישור', updated_at: nowIso() });
          report.expired.push(p.id);
        }
        continue;
      }
      db.update('posts', p.id, { status: 'approved', approved_at: nowIso(), approved_by: `engine:${acc.mode}`, updated_at: nowIso() });
      audit(db, { action: 'auto_approved', accountId: pack.id, postId: p.id, detail: { mode: acc.mode } });
      report.approved.push(p.id);
    }

    // ---- 3a. draft-now: an approved post's TikTok draft goes to the app as soon as the rails let it (the owner's
    // approval sends it at once; this catches the engine's approvals, and drafts held by Shabbat, a pause or a picture)
    try {
      const sent = await sendWaitingDrafts({ ...ctx, packs: [pack] }, { t });
      if (sent.length) report.drafted = [...(report.drafted || []), ...sent.map((x) => ({ account: pack.id, ...x }))];
    } catch (e) {
      report.errors.push({ account: pack.id, step: 'tiktok draft', error: e.message });
    }

    // ---- 4. publish what is approved and due
    if (!run.ok || inRest(t) || !inWindows(t, pack.meta.schedule?.windows)) continue;
    const ready = db.all("SELECT id FROM posts WHERE account_id = ? AND status = 'approved' AND (slot_at IS NULL OR slot_at <= ?) ORDER BY slot_at", pack.id, new Date(t).toISOString());
    for (const p of ready.slice(0, 1)) {
      try {
        const r = await publishPost(ctx, p.id, { t });
        report.published.push({ account: pack.id, post: p.id, ok: r.ok, via: r.via });
      } catch (e) {
        report.errors.push({ account: pack.id, post: p.id, step: 'publish', error: e.message });
      }
    }
  }

  // ---- 4a. TikTok drafts after their slot: the owner's post found, a reminder, the fallback, a duplicate
  try {
    report.drafts = await watchDrafts(ctx, { t });
  } catch (e) {
    report.errors.push({ step: 'drafts', error: e.message });
  }

  // ---- 4b. what the WhatsApp assistant tells the customer, once OF_ASSISTANT_SECRET is set
  try {
    const told = await assistantTick(ctx, { t });
    if (told) report.assistant = told;
  } catch (e) {
    report.errors.push({ step: 'assistant', error: e.message });
  }

  // ---- 4c. Zernio: what each customer connected and whether it still works (hourly), what Zernio billed (daily)
  try {
    const z = await zernioTick(ctx, { t });
    if (z) {
      report.zernio = z;
      for (const e of z.errors) report.errors.push(e);
    }
  } catch (e) {
    report.errors.push({ step: 'zernio', error: e.message });
  }

  // ---- 5. metrics and learning, every few hours
  const lastM = getSetting(db, 'metrics:last');
  if (!lastM || t - Date.parse(lastM) > 6 * 3_600_000) {
    setSetting(db, 'metrics:last', new Date(t).toISOString());
    report.metrics = await collectMetrics(ctx, { t });
    report.formats = learn(ctx, { t });
  }

  // ---- 5a. an Instagram Login token is refreshed before its 60 days run out (once a day it is asked)
  for (const pack of ctx.packs) {
    if (wantedPublisher(pack, 'instagram') !== 'instagram' || igConfig(pack).auth !== 'instagram' || !currentToken(db, pack)) continue;
    const key = `instagram:refreshed:${pack.id}`;
    const last = getSetting(db, key);
    if (last && t - Date.parse(last) < 86_400_000) continue;
    setSetting(db, key, new Date(t).toISOString());
    try {
      const r = await refreshToken(db, pack, { t });
      if (r.refreshed) audit(db, { action: 'instagram_token_refreshed', accountId: pack.id, detail: { daysLeft: Math.floor(r.daysLeft) } });
    } catch (e) {
      report.errors.push({ account: pack.id, step: 'instagram token', error: e.message });
    }
  }

  // ---- 5b. formats that work now, once a week per account, when YouTube is connected
  if (youtubeConfigured()) {
    for (const pack of ctx.packs) {
      const key = `trends:${pack.id}`;
      const last = getSetting(db, key);
      if (last && t - Date.parse(last) < 7 * 86_400_000) continue;
      setSetting(db, key, new Date(t).toISOString());
      try {
        report.trends = { ...(report.trends || {}), [pack.id]: await runTrends(ctx, pack, { t }) };
      } catch (e) {
        report.errors.push({ account: pack.id, step: 'trends', error: e.message });
      }
    }
  }

  // ---- 6. yesterday's summary
  const yesterday = addDays(today, -1);
  if (!db.get('SELECT id FROM summaries WHERE day = ? AND account_id IS NULL', yesterday) && t >= israelInstant(today, cfg.generateAt).getTime()) {
    writeSummaries(ctx, yesterday);
  }
  return report;
}

/** One summary per account and one overall, for a past Israel date. */
export function writeSummaries(ctx, day) {
  const { db } = ctx;
  const from = israelInstant(day, '00:00').toISOString();
  const to = israelInstant(addDays(day, 1), '00:00').toISOString();
  const lines = [];
  for (const pack of ctx.packs) {
    const pub = db.all("SELECT id, hook, publish_json FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? AND published_at < ?", pack.id, from, to);
    const blocked = db.all("SELECT reason FROM posts WHERE account_id = ? AND status = 'blocked' AND created_at >= ? AND created_at < ?", pack.id, from, to);
    const spend = db.get('SELECT COALESCE(SUM(usd),0) AS usd FROM spend WHERE account_id = ? AND at >= ? AND at < ?', pack.id, from, to).usd;
    const text = `${pack.meta.displayName}: ${pub.length} פורסמו, ${blocked.length} נחסמו`;
    db.run('INSERT OR REPLACE INTO summaries (day, account_id, text, data_json, at) VALUES (?, ?, ?, ?, ?)', day, pack.id, text, JSON.stringify({ published: pub.map((p) => ({ id: p.id, hook: p.hook, via: Object.values(j(p.publish_json, {}))[0]?.via })), blocked: blocked.map((b) => b.reason), spend }), nowIso());
    lines.push(text);
  }
  db.run('INSERT OR REPLACE INTO summaries (day, account_id, text, data_json, at) VALUES (?, NULL, ?, NULL, ?)', day, lines.join('\n') || 'אין חשבונות פעילים', nowIso());
}

/** Run tick() every minute until stopped. One at a time: a slow tick delays the next, never overlaps it. */
export function startRunner(ctx, { everyMs = 60_000 } = {}) {
  let busy = false;
  let stopped = false;
  // A post still "drafting" when the process starts lost its builder in a restart.
  // Its batch, if it had one, is recorded by the first tick; the post itself is closed.
  const orphans = ctx.db.run("UPDATE posts SET status = 'blocked', reason = 'הכתיבה נקטעה באתחול של המערכת', updated_at = ? WHERE status = 'drafting'", nowIso()).changes;
  if (orphans) ctx.log?.(`runner: ${orphans} post(s) interrupted by a restart were closed`);
  const go = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const r = await tick(ctx);
      const n = r.generated.length + r.published.length + r.expired.length + r.approved.length + r.errors.length;
      if (n) ctx.log?.(`runner ${hhmm(Date.parse(r.at))}: ${r.generated.length} generated, ${r.approved.length} auto-approved, ${r.published.length} published, ${r.expired.length} expired${r.errors.length ? `, errors: ${r.errors.map((e) => e.error).join('; ')}` : ''}`);
    } catch (e) {
      ctx.log?.(`runner: ${e.stack || e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(go, everyMs);
  go();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
