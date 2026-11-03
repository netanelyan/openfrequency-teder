import { monthKey, newId, now, nowIso } from '../core/clock.js';
import { customerWorkspace } from '../billing/own.js';
import { meterSetup, setupRoom } from '../billing/setup-cap.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { FEW, discover, offered, strong } from '../onboarding/discover.js';
import { createPack } from '../onboarding/pack.js';
import { NAME_HE, checkName, handleFromUsername, saveSetup, setupOf } from '../onboarding/setup.js';
import { buildPost, candidateDocs, loadPost } from '../pipeline/build.js';
import { carryOnboardingZernio, doneLink, onboardingDoneLink, onboardingStates, refreshOnboardingConnections, startConnect, startOnboardingConnect } from '../publish/connect.js';
import { zernioConfigured } from '../publish/zernio.js';
import { defaultChoiceFor, readChoice, saveChoice } from '../schedule/choice.js';
import { ActionError } from './actions.js';
import { FORMATS_FEW, formatsSection } from './formats.js';
import { designPanel } from './styles.js';
import { lockedStyle } from '../render/style.js';
import { DEFAULT_PICKED, MIN_PICKED, pickedFrom } from '../formats/library.js';
import { READY_LINE, postCard } from './pages.js';
import { PLATFORM_NAME, connectData, connectPanel } from './connect.js';
import { scheduleData, schedulePanel } from './schedule.js';
import { accDot, csrfField, esc, icon, k, layout, postButton, stamp, withSupport } from './ui.js';
import { storeOrigin } from '../demos/store.js';
import { reading, startLogoFetch, startSiteRead } from '../onboarding/promo.js';
import { draftFromForm, newPromoPanel, promoFromForm, promoLater, settlePromo } from './promo.js';

// The new-account flow, on the website:
//
//   seed  ->  discovery (in the background)  ->  approve sources, name the account
//         ->  the pack is written (no code)  ->  sample posts to review (a press asks for 5), the days and times
//         ->  live, in Approve mode
//
// Nothing goes live before three samples (SAMPLE_ENOUGH) exist and the owner has looked at them (the owner,
// 2026-10-31, asked whether setup could finish at 3 instead of 5: "ok").
//
// WHILE THE SOURCES ARE SEARCHED the owner does the rest of the setup on the same page, and each part is kept on the
// onboarding (setup_json, src/onboarding/setup.js) until the account exists: the name and the handle (offered again on
// the sources step), the days and times (written to schedule:<account> at create), and TikTok and Instagram, connected
// into a Zernio profile made for the onboarding that the account takes over at create (src/publish/connect.js). The
// page never reloads itself: a small script asks GET /new/<id>/status and changes only the progress line, and when the
// search ends it moves on to the sources, or, when the owner is typing, says the sources are ready and waits. Without
// the script there is a link to look again.
//
// A new account is its workspace's: the one of the session that started it (src/web/workspace.js). Every route gets
// the request's context; the engine's work in the background (discovery, the pack, the samples) gets the engine's
// whole context, so a new account's look and handle are checked against every account on the server.
//
// THE DISCOVERY'S STATE IS THE ROW'S. status 'discovering' while it runs; 'review' with what it found; 'failed' with
// candidates_json.failure, one of:
//   timeout   it ran past DISCOVERY_TIMEOUT_MS and was stopped
//   restart   the server restarted while it ran: at boot (recoverOnboarding) or when its page is opened, a row still
//             'discovering' with no job in this process is one
//   error     anything else
// Each is retryable: POST /new/<id>/retry runs the discovery again on the same seed. Too few good sources found, and
// POST /new/<id>/more searches again with more example sites.
//
// THE SAMPLES. The approved sources are read first ("קוראים את המקורות שבחרתם"), then the samples are written one by
// one, each shown as it is ready; a refused one is followed by another (on another document) up to SAMPLE_ATTEMPTS,
// and an error is tried once more. Fewer than SAMPLE_ENOUGH, and the customer is told what happened and what helps
// (candidates_json.samples.failure: nofacts | unreadable | error | refused). Every refusal and error goes to the log.
//
// WHAT THE CUSTOMER READS IS PLAIN HEBREW. The discovery's own notes (a missing key, a site that did not answer, a
// fallback ranking) are the operator's: notes_json, shown only to the operator, and explained in docs/operator-notes.md.
// The customer is told only what they can act on (candidates_json.said). A source's scores and terms are the
// operator's too: the customer is offered only the sources worth offering (src/onboarding/discover.js offered).

const STATUS_HE = { discovering: 'מחפשים מקורות', review: 'בוחרים מקורות', failed: 'החיפוש נעצר', samples: 'פוסטים לדוגמה', ready: 'מוכן לעלות', live: 'באוויר' };
/** The operator's alone: the customer never reads a source's terms (docs/operator-notes.md). */
const TERMS_HE = { ok: 'תנאים בסדר', check: 'לבדוק תנאי שימוש', no: 'אסור לשימוש' };
const TYPE_HE = { rss: 'פיד', web: 'דף', api: 'נתונים' };
const FAILURE_HE = { timeout: 'החיפוש לקח יותר מדי זמן ונעצר.', restart: 'החיפוש נקטע באמצע.', error: 'משהו השתבש בחיפוש.' };
/** The most a discovery may run before it is stopped and marked failed (retryable). Four minutes since it reads the
 * sites the model names for the niche too (src/onboarding/discover.js nicheSites), up to 14 besides the examples. */
export const DISCOVERY_TIMEOUT_MS = 4 * 60_000;

/**
 * A list typed in the form, a new account's topics or sites: one item a line, as the page's pills send them (static/app.js
 * data-pills), or, with `commas` (topics), by commas too, as the field reads without the page's script. Trimmed, each
 * to `len` characters, empty ones and repeats left out, at most `max`.
 */
export const listField = (v, { commas = false, max = 10, len = 300 } = {}) =>
  [...new Set(String(v || '').split(commas ? /\r?\n|[,،]/ : /\r?\n/).map((x) => x.trim().slice(0, len)).filter(Boolean))].slice(0, max);
/** A new account's topics: 12 at most, 60 characters each. */
const TOPICS = { commas: true, max: 12, len: 60 };
/** How long POST /new waits for the business's site to be read before it opens the page (the read goes on after). */
export const SITE_WAIT_MS = 6000;

/**
 * One Teder account a subscription (the owner, 2026-10-31): a customer's plan is their one account's, never split
 * between accounts. Another account is another subscription, at the same price, opened by us. Our own workspaces keep
 * as many as they have.
 */
export const ONE_ACCOUNT = 'לכל חשבון בתדר יש מנוי משלו, והחשבון שלכם כבר פתוח. רוצים עוד חשבון? כתבו לנו, ונפתח לכם עוד מנוי באותו מחיר.';
/** Whether a customer's workspace already has its one account. */
export const hasAccount = (db, workspaceId) => customerWorkspace(workspaceId) && Boolean(db.get('SELECT 1 FROM accounts WHERE workspace_id = ? LIMIT 1', workspaceId));
/** The samples one press asks for, the fewest that count as done, and the most tries to get there. */
export const SAMPLE_TARGET = 5;
export const SAMPLE_ENOUGH = 3;
export const SAMPLE_ATTEMPTS = 9;

/** How many samples passed, and while that is fewer than SAMPLE_ENOUGH, that it takes three to go on. */
export const samplesLine = (good) => {
  const need = `צריך לפחות ${SAMPLE_ENOUGH}`;
  if (!good) return `${need} דוגמאות שעוברות את כל הבדיקות כדי להמשיך.`;
  const passed = `${good === 1 ? 'דוגמה אחת עברה' : `${good} דוגמאות עברו`} את כל הבדיקות.`;
  return good >= SAMPLE_ENOUGH ? passed : `${passed} ${need} כדי להמשיך.`;
};

/**
 * How many rounds of samples a customer may ask for: two for each new account (the first five, and one more press), and
 * six in a calendar month across all their new accounts. Each round is up to SAMPLE_ATTEMPTS full-price builds outside
 * the month's plan, so the plan alone would not bound it. A round counts once it starts writing; one that wrote nothing
 * because something broke on our side (failure 'error') does not. None once the account is live: its posts come from the
 * plan. The operator is not limited, and the month's six do not count in one of the company's own workspaces
 * (OF_OWN_WORKSPACES, src/billing/own.js), as in none.
 */
export const SAMPLE_ROUNDS = { perOnboarding: 2, perWorkspaceMonth: 6 };

const counted = (found) => (found?.rounds || []).filter((x) => x.counted !== false);

/**
 * May this onboarding's customer start another round of samples? { ok, why: null | 'live' | 'onboarding' | 'month' | 'cap' }.
 * 'cap': the workspace has not paid and its setup reached the cap for that (src/billing/setup-cap.js).
 */
export function sampleRoom(db, r, t = now()) {
  if (r.status === 'live') return { ok: false, why: 'live' };
  if (counted(r.found).length >= SAMPLE_ROUNDS.perOnboarding) return { ok: false, why: 'onboarding' };
  if (customerWorkspace(r.workspace_id ?? null)) {
    const month = monthKey(t);
    const used = db
      .all('SELECT candidates_json FROM onboarding WHERE workspace_id = ?', r.workspace_id)
      .reduce((n, o) => n + counted(j(o.candidates_json, {})).filter((x) => monthKey(Date.parse(x.at)) === month).length, 0);
    if (used >= SAMPLE_ROUNDS.perWorkspaceMonth) return { ok: false, why: 'month' };
  }
  if (!setupRoom(db, r.workspace_id ?? null, { t }).ok) return { ok: false, why: 'cap' };
  return { ok: true, why: null };
}

/**
 * The setup of a workspace that has not paid reached its cap (src/billing/setup-cap.js): what the customer reads. With
 * samples, that they are ready and what opens once Teder is paid for; without, that what they built is kept.
 */
export const CAP_HE = {
  more: 'עוד דוגמאות, החיבור לרשתות והעלייה לאוויר נפתחים אחרי ההפעלה.',
  after: 'אחרי ההפעלה החשבון עולה לאוויר, ואפשר לחבר אותו לטיקטוק, לאינסטגרם ולפייסבוק.',
  noneTitle: 'ההמשך נפתח אחרי ההפעלה',
  none: 'מה שכבר בניתם נשמר, ואחרי ההפעלה ממשיכים מאותה נקודה.',
  connect: 'את החיבור לטיקטוק, לאינסטגרם ולפייסבוק עושים אחרי ההפעלה. כל השאר אפשר לסדר כבר עכשיו.',
};

/** Samples that passed, in a workspace's accounts. */
const goodSamples = (db, workspaceId) => db.get("SELECT COUNT(*) AS n FROM posts WHERE sample = 1 AND status = 'sample' AND account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)", workspaceId).n;

/** What a paid step refused at the cap says: the samples are ready, or what was built is kept. */
const capMessage = (db, workspaceId) => (goodSamples(db, workspaceId) ? `${READY_LINE}. ${CAP_HE.more}` : `${CAP_HE.noneTitle}. ${CAP_HE.none}`);

/** A paid step of the setup (a search, creating the account): refused once a workspace that has not paid reached the cap. */
function capCheck(ctx, user, workspaceId) {
  if (user.operator) return;
  if (!setupRoom(ctx.db, workspaceId ?? null).ok) throw new ActionError(capMessage(ctx.db, workspaceId), 409);
}

/** Why no more samples, as the customer reads it. */
export const ROUNDS_HE = {
  live: 'החשבון כבר באוויר. מעכשיו הפוסטים שלו נכתבים כל יום, לפי הימים והשעות שבחרתם.',
  onboarding: `כבר כתבנו לחשבון הזה פוסטים לדוגמה ${SAMPLE_ROUNDS.perOnboarding} פעמים, וזה המקסימום לחשבון חדש. אם צריך עוד דוגמאות, כתבו לנו.`,
  month: `החודש כבר כתבנו לכם פוסטים לדוגמה ${SAMPLE_ROUNDS.perWorkspaceMonth} פעמים, בכל החשבונות החדשים יחד, וזה המקסימום לחודש. אם צריך עוד, כתבו לנו.`,
  cap: `${READY_LINE}. ${CAP_HE.more}`,
};
const running = new Map();
/** What a running job is doing now: { step, done, total } (src/onboarding/discover.js onProgress, and the samples). */
const progress = new Map();

const engine = (ctx) => ctx.global || ctx;

const RESTARTED = 'the server restarted while the discovery ran';
const RECORDED_NOTE = 'המנוע במצב הקלטות: בלי ANTHROPIC_API_KEY אין מי שיכתוב פוסטים מהמקורות החדשים. עם מפתח, או עם הקלטות (npm run record), הפוסטים ייכתבו כאן.';

/** Every discovery a restart left 'discovering' is failed, retryable. Called at boot (scripts/web.js). */
export function recoverOnboarding(db) {
  return db.run("UPDATE onboarding SET status = 'failed', candidates_json = ?, notes_json = ?, updated_at = ? WHERE status = 'discovering'", JSON.stringify({ failure: 'restart' }), JSON.stringify([RESTARTED]), nowIso()).changes;
}

const row = (ctx, id, { recover = true } = {}) => {
  let r = ctx.db.get('SELECT * FROM onboarding WHERE id = ?', id);
  if (!r || (ctx.workspaceId != null && r.workspace_id !== ctx.workspaceId)) throw new ActionError('אין תהליך כזה', 404);
  // Still searching with nobody searching: this process never started it, so a restart cut it off.
  if (recover && r.status === 'discovering' && !running.has(id)) {
    ctx.db.update('onboarding', id, { status: 'failed', candidates_json: { failure: 'restart' }, notes_json: [RESTARTED], updated_at: nowIso() });
    r = ctx.db.get('SELECT * FROM onboarding WHERE id = ?', id);
  }
  return { ...r, seed: j(r.seed_json, {}), found: j(r.candidates_json, {}), notes: j(r.notes_json, []), setup: j(r.setup_json, {}) || {} };
};

/** A paid step, counted against the workspace's setup while it has not paid (src/billing/setup-cap.js); the operator's is not. */
const metered = (db, r, fn, counts = true) => (counts ? meterSetup(db, r.workspace_id ?? null, fn) : fn());

function startDiscovery(ctx, id, { counted: counts = true } = {}) {
  if (running.has(id)) return;
  const r = row(ctx, id, { recover: false });
  ctx = engine(ctx);
  const limit = ctx.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const stop = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stop.abort();
      reject(Object.assign(new Error(`the discovery ran past ${Math.round(limit / 1000)} seconds and was stopped`), { code: 'timeout' }));
    }, limit);
    timer.unref?.();
  });
  progress.set(id, { step: 'search' });
  const found = metered(ctx.db, r, () => discover(ctx, r.seed, { ...(ctx.discoverOpts || {}), signal: stop.signal, onProgress: (p) => progress.set(id, p) }), counts);
  const job = Promise.race([found, timeout])
    .then((out) => {
      // The niche's English words, found by the model, are kept with the seed for the pack (YouTube's search).
      const seed = out.nicheEn && !r.seed.nicheEn ? { ...r.seed, nicheEn: out.nicheEn } : r.seed;
      ctx.db.update('onboarding', id, { status: 'review', seed_json: seed, candidates_json: { candidates: out.candidates, formats: out.formats, said: out.said || [] }, notes_json: out.notes, updated_at: nowIso() });
    })
    .catch((e) => ctx.db.update('onboarding', id, { status: 'failed', candidates_json: { failure: e.code === 'timeout' ? 'timeout' : 'error' }, notes_json: [String(e.message)], updated_at: nowIso() }))
    .finally(() => {
      clearTimeout(timer);
      running.delete(id);
      progress.delete(id);
    });
  running.set(id, job);
}

/** Read the account's approved sources before a sample is written: { docs, sources, failed: [{ name, error }] }. */
async function readSources(ctx, pack) {
  const pctx = { ...ctx, pack, sources: ctx.sourcesFor ? ctx.sourcesFor(pack) : ctx.sources };
  const docs = await candidateDocs(pctx, pack);
  const srcs = ctx.db.all("SELECT name, last_error FROM sources WHERE account_id = ? AND status = 'approved'", pack.id);
  return { docs: docs.length, sources: srcs.length, failed: srcs.filter((s) => s.last_error).map((s) => ({ name: s.name, error: s.last_error })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The samples, in the background: the sources read first, then one sample at a time. `ctx.samplesOpts` ({ build, read,
 * retryMs }) stands in for buildPost and the read in the tests. The round is recorded on the onboarding when it starts
 * writing (sampleRoom counts it), `counted` false for the operator's, which limit nobody.
 */
function startSamples(ctx, id, { counted: counts = true } = {}) {
  if (running.has(id)) return;
  const r = row(ctx, id);
  ctx = engine(ctx);
  const opts = ctx.samplesOpts || {};
  const build = opts.build || buildPost;
  const read = opts.read || readSources;
  const pack = ctx.pack(r.pack_id);
  const say = (m) => ctx.log?.(`[onboarding] ${id} (${pack.id}): ${m}`);
  const count = () => ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", pack.id).n;
  const notes = [];
  let round = null;
  const save = (samples) => {
    const now = row(ctx, id, { recover: false });
    // A round that wrote nothing because something broke on our side, or because the setup's cap stopped it before
    // paying, is not the customer's.
    const rounds = (now.found.rounds || []).map((x) => (x.at === round && ['error', 'cap'].includes(samples.failure) && !samples.made ? { ...x, counted: false } : x.at === round ? { ...x, made: samples.made } : x));
    ctx.db.update('onboarding', id, { status: now.status === 'ready' || now.status === 'live' ? now.status : 'samples', candidates_json: { ...now.found, rounds, samplesFailed: Boolean(samples.failure), samples }, notes_json: [...now.notes, ...notes], updated_at: nowIso() });
  };
  const job = metered(ctx.db, r, async () => {
    const before = count();
    progress.set(id, { step: 'read' });
    const got = await read(ctx, pack);
    if (got.failed.length) notes.push(...got.failed.map((s) => `${s.name}: ${s.error}`));
    say(`read ${got.sources} source(s): ${got.docs} document(s)${got.failed.length ? `, ${got.failed.length} failed (${got.failed.map((s) => `${s.name}: ${s.error}`).join(' · ')})` : ''}`);
    if (!got.docs) {
      const failure = got.sources && got.failed.length === got.sources ? 'unreadable' : 'nofacts';
      notes.push(failure === 'unreadable' ? 'אף מקור מאושר לא נקרא' : 'המקורות נקראו, ואין בהם מסמך לכתוב ממנו');
      if (ctx.mode === 'recorded') notes.push(RECORDED_NOTE);
      say(`no samples written: ${failure}`);
      return save({ made: 0, failure, at: nowIso() });
    }
    let tries = 0;
    let errors = 0;
    let empty = 0;
    // The round starts writing: from here it costs, and it is counted (sampleRoom).
    round = nowIso();
    const at = row(ctx, id, { recover: false });
    ctx.db.update('onboarding', id, { candidates_json: { ...at.found, rounds: [...(at.found.rounds || []), { at: round, by: counts ? 'customer' : 'operator', ...(counts ? {} : { counted: false }) }] }, updated_at: nowIso() });
    progress.set(id, { step: 'write', done: 0, total: SAMPLE_TARGET });
    let capped = false;
    while (count() - before < SAMPLE_TARGET && tries < SAMPLE_ATTEMPTS) {
      // A workspace that has not paid stops at its setup's cap (src/billing/setup-cap.js), before the next sample costs.
      if (counts && !setupRoom(ctx.db, r.workspace_id ?? null).ok) {
        capped = true;
        say(`stopped before try ${tries + 1}: the setup of a workspace that has not paid reached its cap`);
        break;
      }
      tries++;
      let res;
      try {
        res = await build(ctx, { pack, sample: true });
      } catch (e) {
        res = { status: 'blocked', kind: 'error', reason: String(e.message).slice(0, 300) };
      }
      if (res.status === 'sample') {
        errors = 0;
        empty = 0;
        progress.set(id, { step: 'write', done: count() - before, total: SAMPLE_TARGET });
        continue;
      }
      const kind = res.kind || 'error';
      notes.push(`ניסיון ${tries}: ${res.reason || res.status}`);
      say(`sample try ${tries} refused (${kind}): ${res.reason || res.status}`);
      if (kind === 'error') {
        // Once more after a moment: a model that did not answer usually answers the second time.
        if (++errors >= 2) break;
        await sleep(opts.retryMs ?? 5000);
      } else if (kind === 'no_source') {
        // Nothing new left to write from.
        if (++empty >= 2) break;
      }
    }
    const made = count() - before;
    const failure = made >= SAMPLE_ENOUGH ? null : capped ? 'cap' : errors >= 2 ? 'error' : empty >= 2 ? 'nofacts' : 'refused';
    if (made < SAMPLE_TARGET && ctx.mode === 'recorded') notes.push(RECORDED_NOTE);
    say(`${made} sample(s) in ${tries} tries${failure ? `, failed: ${failure}` : ''}`);
    return save({ made, failure, at: nowIso() });
  }, counts)
    .catch((e) => {
      say(`the samples stopped: ${e.stack || e.message}`);
      notes.push(String(e.message));
      return save({ made: 0, failure: 'error', at: nowIso() });
    })
    .finally(() => {
      running.delete(id);
      progress.delete(id);
    });
  running.set(id, job);
}

/** The operator's notes, folded away: what was skipped and why, in the discovery's own words. */
const operatorNotes = (pc, notes) =>
  pc.operator && notes.length ? `<details class="mt12"><summary class="muted small">הערות למפעיל (${notes.length})</summary><ul class="factlist">${notes.slice(0, 30).map((n) => `<li class="muted small" dir="auto">${esc(n)}</li>`).join('')}</ul><p class="muted small">מה כל הערה אומרת ומה עושים: docs/operator-notes.md</p></details>` : '';

/** What the customer is told: a line or two they can act on. */
const saidBanner = (lines) => (lines?.length ? `<div class="banner info">${icon('alert')}<div>${lines.slice(0, 4).map((n) => `<p>${esc(n)}</p>`).join('')}</div></div>` : '');

function progressLine(p) {
  if (!p) return '';
  if (p.step === 'sites' && p.total) return `עכשיו בודקים אתרים, ${p.done} מתוך ${p.total}.`;
  if (p.step === 'formats') return 'עכשיו בודקים מה עובד בתחום שלכם.';
  if (p.step === 'score') return 'כמעט סיימנו, בודקים כל מקור.';
  if (p.step === 'read') return 'קוראים את המקורות שבחרתם.';
  if (p.step === 'write') return `כותבים פוסטים לדוגמה, ${p.done} מתוך ${p.total} מוכנים.`;
  return 'עכשיו מחפשים אתרים.';
}

/* ------------------------------------------------------------------ the status the page polls */

const sampleCount = (db, packId) => (packId ? db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND sample = 1 AND status = 'sample'", packId).n : 0);

/**
 * GET /new/<id>/status: { status, busy, key, line, ready, go }. `key` changes whenever the page would show something
 * else (the search ended, a sample is ready); `line` is the progress line; `ready` and `go` the call shown when the
 * page waits for the customer to finish typing.
 */
export function statusOf(ctx, r) {
  const busy = running.has(r.id);
  const n = sampleCount(ctx.db, r.pack_id);
  const key = `${r.status}:${busy ? 'busy' : 'idle'}:${n}`;
  const line = busy ? progressLine(progress.get(r.id)) : '';
  const ready = r.status === 'review' || r.status === 'discovering' ? 'המקורות מוכנים, אפשר לבחור.' : r.status === 'failed' ? 'החיפוש נעצר.' : busy ? 'פוסט לדוגמה חדש מוכן.' : 'הפוסטים לדוגמה מוכנים.';
  const go = r.status === 'review' || r.status === 'discovering' ? 'לבחור מקורות' : 'להמשיך';
  return { status: r.status, busy, key, line, ready, go };
}

/**
 * A new account's work in the background, for the home page's block (src/web/progress.js): its search for sources and
 * its sample posts, each while it runs (with the progress line its own page shows), then done, with where to go, until
 * the next step is taken (the sources chosen, the samples gone through) and `within` at most after it ended (the
 * samples' own time; a search's is the setup's last change, the search's end unless something was saved since). A
 * search that stopped is said too, with the way to try again. The setups are those /new lists: the workspace's, every
 * one for the operator. A search left 'discovering' with no job in this process was cut off by a restart: said as
 * stopped, without writing anything (its own page marks it, as before). Items: { id, state: running | ready | stopped,
 * title, subject, line, href, go, at }.
 */
export function onboardingWork(ctx, { t = now(), within = DAY_MS } = {}) {
  const since = new Date(t - within).toISOString();
  const busy = [...running.keys()];
  const mine = ctx.workspaceId == null ? '' : ' AND workspace_id = ?';
  const rows = ctx.db.all(`SELECT * FROM onboarding WHERE (updated_at >= ? OR id IN (${busy.map(() => '?').join(', ') || 'NULL'}))${mine} ORDER BY updated_at DESC LIMIT 20`, since, ...busy, ...(mine ? [ctx.workspaceId] : []));
  const out = [];
  for (const raw of rows) {
    const r = { ...raw, seed: j(raw.seed_json, {}), found: j(raw.candidates_json, {}) };
    const job = running.has(r.id);
    const recent = (at) => Date.parse(at || r.updated_at) >= t - within;
    const page = `/new/${r.id}`;
    const niche = r.seed.niche || '';
    if (['discovering', 'review', 'failed'].includes(r.status)) {
      const base = { id: `o:${r.id}:sources`, subject: niche, at: r.updated_at };
      if (r.status === 'discovering' && job) out.push({ ...base, state: 'running', title: STATUS_HE.discovering, line: progressLine(progress.get(r.id)) });
      else if (r.status === 'review' && recent()) out.push({ ...base, state: 'ready', title: 'המקורות מוכנים, אפשר לבחור', line: '', href: `${page}#sources`, go: 'לבחור מקורות' });
      else if (r.status !== 'review' && recent()) out.push({ ...base, state: 'stopped', title: STATUS_HE.failed, line: 'אפשר לנסות שוב עם אותם פרטים.', href: page, go: 'להמשיך' });
      continue;
    }
    if (!r.pack_id) continue;
    const base = { id: `o:${r.id}:samples`, subject: ctx.pack(r.pack_id)?.meta.displayName || niche };
    if (job) {
      out.push({ ...base, state: 'running', title: STATUS_HE.samples, line: progressLine(progress.get(r.id)), at: r.updated_at });
      continue;
    }
    // Done writing, and not yet gone through ('ready' and 'live' are the steps after).
    const s = r.found.samples;
    if (r.status !== 'samples' || !s?.at || !recent(s.at)) continue;
    const made = s.made || 0;
    if (s.failure) out.push({ ...base, state: 'stopped', title: made ? `${made} מתוך ${SAMPLE_TARGET} פוסטים לדוגמה מוכנים` : 'אף פוסט לדוגמה לא נכתב', line: SAMPLES_HE[s.failure] || SAMPLES_HE.error, href: page, go: 'להמשיך', at: s.at });
    else out.push({ ...base, state: 'ready', title: 'הפוסטים לדוגמה מוכנים', line: samplesLine(sampleCount(ctx.db, r.pack_id)), href: page, go: 'להמשיך', at: s.at });
  }
  return out;
}

/** The progress line and the call to move on, polled by the page's script (src/web/static/app.js data-poll). */
function pollBox(ctx, r, { href }) {
  const s = statusOf(ctx, r);
  return `<div class="pollbox" data-poll="/new/${esc(r.id)}/status" data-key="${esc(s.key)}" data-href="${esc(href)}">
<p class="m0" data-progress aria-live="polite">${esc(s.line)}</p>
<div class="banner info mt12" data-ready hidden>${icon('check')}<div><b data-ready-text>${esc(s.ready)}</b><p>מה שכתבתם כאן נשמר רק אחרי שלוחצים על שמירה.</p></div><a class="btn sm primary" href="${esc(href)}" data-ready-go>${esc(s.go)}</a></div>
<p class="small m6 js-hide"><a href="/new/${esc(r.id)}">לבדוק שוב</a></p></div>`;
}

/* ------------------------------------------------------------------ the parts done while waiting */

/** A name to start from: the one saved, else the workspace's (the business), else the site the owner gave. */
function nameOf(pc, r) {
  if (r.setup.displayName) return r.setup.displayName;
  if (pc.workspace?.name) return String(pc.workspace.name).slice(0, 40);
  const site = (r.found.candidates || []).find((c) => c.origin === 'example' && c.name);
  return site ? String(site.name).split(/\s[|·\-–]\s/)[0].trim().slice(0, 40) : '';
}

/** A handle to start from: the one saved, else the username of a TikTok or Instagram connected already. */
function handleOf(r) {
  if (r.setup.handle) return r.setup.handle;
  const c = r.setup.zernio?.connections || {};
  return handleFromUsername(c.tiktok?.username) || handleFromUsername(c.instagram?.username) || '';
}

/** The name and handle fields, the same wherever they are asked. */
function nameFields(pc, r) {
  return `<p class="muted m0">שם המשתמש מופיע על כל מצגת, כדי שמי שרואה אותה יידע איפה למצוא אתכם. השם של העסק מופיע כאן באתר, ובחלק מהעיצובים גם על המצגות.</p>
<label class="f">השם של העסק <small>כמו שהלקוחות מכירים אתכם</small><input type="text" name="displayName" required maxlength="40" value="${esc(nameOf(pc, r))}"></label>
<label class="f">שם המשתמש שלכם בטיקטוק ובאינסטגרם <small>באותיות באנגלית, למשל cafe.yafo</small><span class="atfield" dir="ltr"><span aria-hidden="true">@</span><input type="text" name="handle" required maxlength="31" dir="ltr" autocapitalize="off" spellcheck="false" pattern="@?[A-Za-z0-9._\\-]{2,30}" value="${esc(handleOf(r))}"></span></label>`;
}

const NAME_TITLE = 'השם שלכם על המצגות';

function namePanel(pc, r) {
  return `<section class="panel" id="name"><header><h2>${NAME_TITLE}</h2></header>
<form method="post" action="/new/${esc(r.id)}/name" class="formgrid">${csrfField(pc)}${nameFields(pc, r)}
<p class="muted small m0">אפשר לשנות את זה גם בשלב הבא, כשבוחרים מקורות.</p>
<div><button class="btn" type="submit">שמירה</button></div></form></section>`;
}

/** What the connect panel reads for an onboarding with no account yet. */
const obConnectData = (ctx, r) => ({
  pack: { id: r.id, meta: { platforms: ['tiktok', 'instagram', 'facebook'] } },
  configured: zernioConfigured(),
  hasProfile: Boolean(r.setup.zernio?.profileId),
  platforms: onboardingStates(ctx.db, r.id),
  mode: 'draft-now',
  via: 'zernio',
  zernio: null,
});

function connectSection(ctx, pc, r) {
  // Before paying, connecting is the paywall's (src/web/server.js SETUP_OPEN): said, with no button that leads to it.
  if (pc.unpaid) return `<section class="panel" id="connect"><header><h2>חיבור לטיקטוק, לאינסטגרם ולפייסבוק</h2></header><p class="muted m0">${esc(CAP_HE.connect)}</p></section>`;
  return `<section class="panel" id="connect"><header><h2>חיבור לטיקטוק, לאינסטגרם ולפייסבוק</h2></header>
<p class="muted">אפשר לחבר כבר עכשיו, עוד לפני שהחשבון מוכן. כשהחשבון ייווצר החיבור יעבור אליו, ולא תצטרכו לחבר שוב.</p>
${connectPanel(pc, obConnectData(ctx, r), { base: `/new/${r.id}` })}</section>`;
}

/**
 * Before paying (the owner, 2026-11-02: "המצגות שלכם מוכנות, נשאר רק להפעיל"): the samples are ready and the rest opens
 * once Teder is paid for, with the paywall's own way to pay (accounts' /setup page). `capped`: the setup reached its cap
 * (src/billing/setup-cap.js), so more samples wait too. Without a sample, that what was built is kept.
 */
function activateBanner(pc, { good, capped }) {
  const pay = `<a class="btn sm primary" href="${esc(pc.links?.setup || '')}">איך משלמים</a>`;
  if (!good) return `<div class="banner info" id="activate">${icon('check')}<div><b>${esc(CAP_HE.noneTitle)}</b><p>${esc(CAP_HE.none)}</p></div>${pay}</div>`;
  return `<div class="banner info" id="activate">${icon('check')}<div><b>${esc(READY_LINE)}</b><p>${esc(capped ? CAP_HE.more : CAP_HE.after)}</p></div>${pay}</div>`;
}

/** The days and times, before the account exists: the onboarding's choice, else the one a new account starts with. */
function scheduleSection(ctx, pc, r) {
  const pseudo = { id: r.id, meta: { displayName: r.setup.displayName || r.seed.niche, schedule: {} } };
  const d = scheduleData(ctx.db, pseudo, { choice: r.setup.choice?.byDay ? r.setup.choice : { byDay: defaultChoiceFor(r.id) } });
  return schedulePanel(pc, d, { action: `/new/${r.id}/schedule`, back: `/new/${r.id}`, lede: `בחרנו ימים ושעות שמספיקים ל-${d.month.plan} הפוסטים שבחבילה. אפשר לשנות אותם עכשיו, או אחר כך בהגדרות.` });
}

/* ------------------------------------------------------------------ the pages */

function listPage(ctx, pc) {
  // A customer whose one account is open gets no form for another (ONE_ACCOUNT); the setups in progress stay listed,
  // the way back to their account's samples step among them.
  const one = hasAccount(ctx.db, ctx.workspaceId);
  const rows = (ctx.workspaceId == null ? ctx.db.all('SELECT * FROM onboarding ORDER BY updated_at DESC LIMIT 20') : ctx.db.all('SELECT * FROM onboarding WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 20', ctx.workspaceId)).map((r) => ({ ...r, seed: j(r.seed_json, {}) }));
  // Before paying, at the setup's cap: no form for a search that would be refused, the way to pay instead.
  const capped = !one && !pc.operator && !setupRoom(ctx.db, ctx.workspaceId ?? null).ok;
  return layout(
    { ...pc, title: 'חשבון חדש', active: 'new' },
    `<div class="head"><h1>חשבון חדש</h1>${one || capped ? '' : '<span class="sub">כותבים במה החשבון יעסוק, מאשרים מקורות ומקבלים פוסטים לדוגמה.</span>'}</div>
${capped ? activateBanner(pc, { good: goodSamples(ctx.db, ctx.workspaceId), capped: true }) : ''}
<div class="cols">${capped ? '' : one ? `<section class="panel"><header><h2>עוד חשבון הוא עוד מנוי</h2></header><p>${withSupport(ONE_ACCOUNT)}</p>
<div class="actions p0"><a class="btn" href="/accounts">לחשבון שלכם</a></div></section>` : `<section class="panel"><header><h2>מתחילים מכאן</h2></header>
<p class="muted">תדר מחפש אתרים שאפשר לסמוך עליהם, כמו משרדי ממשלה, גופים רשמיים וכלי תקשורת ותיקים, ובודק שכל אחד מהם באמת עוסק בנושא שלכם. מקור נכנס לחשבון רק אחרי שאתם מאשרים אותו.</p>
<form method="post" action="/new" class="formgrid">${csrfField(pc)}<input type="hidden" name="language" value="he">
<label class="f">במה החשבון יעסוק <small>כמו שהייתם מספרים לחבר</small><input type="text" name="niche" required maxlength="80" placeholder="למשל: בישול טבעוני לסטודנטים"></label>
<label class="f">למי הוא מיועד<input type="text" name="audience" maxlength="160" placeholder="למשל: סטודנטים שמבשלים בתקציב קטן"></label>
<label class="f">האתר של העסק <small>לא חובה. ממנו נמלא את השקף האחרון של כל מצגת</small><input type="text" name="site" maxlength="300" dir="ltr" inputmode="url" autocapitalize="off" autocomplete="url" spellcheck="false" placeholder="shop.co.il"></label>
<label class="f">נושאים שחשובים לכם <small class="js-hide">מופרדים בפסיקים, לא חובה</small><small class="js-show">כותבים נושא ולוחצים Enter, לא חובה</small><input type="text" name="topics" maxlength="800" data-pills="commas" data-max="12"></label>
<label class="f">אתרים או חשבונות שאתם אוהבים <small class="js-hide">כתובת אחת בכל שורה, לא חובה</small><small class="js-show">כותבים כתובת ולוחצים Enter, לא חובה</small><textarea name="examples" rows="4" dir="ltr" data-pills data-max="10"></textarea></label>
<button class="btn primary" type="submit">${icon('spark')}לחפש מקורות</button></form></section>`}
<section class="panel"><header><h2>בתהליך</h2></header>${rows.length ? `<ul class="factlist">${rows.map((r) => `<li><a href="/new/${esc(r.id)}"><b>${esc(r.seed.niche)}</b></a> <span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span> <span class="muted small">${esc(stamp(r.updated_at))}</span></li>`).join('')}</ul>` : '<p class="muted">אין עדיין.</p>'}</section></div>`
  );
}

const DAY_MS = 86_400_000;

/** A source's site, for its row: the host without "www.". */
const siteOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www./, '');
  } catch {
    return String(url || '');
  }
};

/**
 * A source as one row (the owner, 2026-10-31: compact, not a page of cards): the box to approve it, its name on one
 * line with its site under it, a plain word where one helps, and the site to open. The operator also sees every score
 * and the reasons, with why it is trusted to edit, folded under the row; the customer's is the reason found, as it is.
 */
function sourceRow(pc, c, { on = strong(c), why = null } = {}) {
  const s = c.score || {};
  const fresh = c.newest && Date.now() - Date.parse(c.newest) < 2 * DAY_MS;
  const chips = pc.operator
    ? `<span class="chip ghost">${esc(TYPE_HE[c.type] || c.type)}</span><span class="chip ${s.authority >= 7 ? 'ok' : s.authority >= 5 ? '' : 'warn'}">סמכות ${s.authority}/10</span><span class="chip">עדכניות ${s.freshness}/10</span>${s.relevance != null ? `<span class="chip ${s.relevance >= 6 ? '' : 'warn'}">רלוונטיות ${s.relevance}/10</span>` : ''}<span class="chip ${s.terms === 'ok' ? 'ok' : s.terms === 'no' ? 'bad' : 'warn'}">${esc(TERMS_HE[s.terms] || s.terms)}</span>`
    : `${c.origin === 'example' ? '<span class="chip">מהאתרים שלכם</span>' : ''}${s.authority >= 8 ? '<span class="chip ok">מקור מוביל</span>' : ''}${fresh ? '<span class="chip">מתעדכן כל יום</span>' : ''}`;
  const more = pc.operator
    ? `<details class="srcmore"><summary class="muted small" dir="auto">${esc(`${s.reason || ''}${s.relevanceReason ? ` · ${s.relevanceReason}` : ''}${s.by === 'heuristic' ? ' · דירוג היוריסטי (בלי מפתח API)' : ''}`)}</summary><label class="f">למה סומכים עליו<input type="text" dir="auto" name="why_${esc(c.id)}" value="${esc(why ?? (c.why || s.reason))}" maxlength="300"></label></details>`
    : '';
  return `<li class="srcrow"><label><input type="checkbox" name="approve_${esc(c.id)}"${on ? ' checked' : ''}${s.terms === 'no' ? ' disabled' : ''}><span class="srcwho"><b dir="auto">${esc(c.name)}</b><span class="ltr">${esc(siteOf(c.url))}</span></span>${chips ? `<span class="srctags">${chips}</span>` : ''}</label><a class="srcopen" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`לפתוח את ${c.name}`)}" title="${esc(c.url)}">${icon('ext')}</a>${more}</li>`;
}

/**
 * What the customer chose on the sources step, from the form they sent: every source's tick and (the operator) reason by
 * its address, and the kinds of slideshow. Kept on the onboarding (setup.chosen) before anything is checked, so the
 * step that comes back after a refusal shows what they chose, with or without the page's script (the
 * follow-up on item 1, 2026-11-02: "Source ticks and every other field the customer changed must survive any redirect").
 */
const chosenFrom = (r, f) => {
  const cands = r.found.candidates || [];
  return {
    shown: cands.map((c) => c.url),
    approve: cands.filter((c) => f[`approve_${c.id}`] === 'on').map((c) => c.url),
    why: Object.fromEntries(cands.filter((c) => f[`why_${c.id}`] != null).map((c) => [c.url, String(f[`why_${c.id}`]).trim().slice(0, 300)])),
    formats: f.formats_shown ? pickedFrom(f) : null,
  };
};

/** setup.chosen read back for the step's page: { on(c), why(c), formats }, or null before the step was ever sent. A source
 * the last send did not have (a search since) starts as it is offered. */
function chosenOf(r) {
  const ch = r.setup.chosen;
  if (!Array.isArray(ch?.shown)) return null;
  const seen = new Set(ch.shown);
  const approve = new Set(ch.approve || []);
  return {
    on: (c) => (seen.has(c.url) ? approve.has(c.url) : strong(c)),
    why: (c) => (seen.has(c.url) ? (ch.why?.[c.url] ?? null) : null),
    formats: Array.isArray(ch.formats) ? ch.formats : null,
  };
}

/** How many sources the list shows open; the rest fold away (still sent with the form, ticked or not). */
const SOURCES_SHOWN = 8;

/**
 * The sources found, as rows: the ticked ones first, 8 in all, the rest under "עוד", and (the operator) those not offered.
 * `chosen` is what the customer ticked when this step last came back (chosenOf): those ticks, in the same order.
 */
function sourcesPanel(pc, shown, hidden, chosen = null) {
  const ticked = shown.filter(strong);
  const ordered = [...ticked, ...shown.filter((c) => !strong(c))];
  const first = ordered.slice(0, SOURCES_SHOWN);
  const rest = ordered.slice(SOURCES_SHOWN);
  const on = (c) => (chosen ? chosen.on(c) : strong(c));
  const restTicked = rest.filter(on).length;
  const rows = (list) => `<ul class="srclist">${list.map((c) => sourceRow(pc, c, { on: on(c), why: chosen?.why(c) ?? null })).join('')}</ul>`;
  const said = `${ticked.length ? `סימנו ${ticked.length === 1 ? 'מקור חזק אחד' : `${ticked.length} מקורות חזקים`}. ` : ''}תדר כותב רק ממקורות מסומנים.`;
  const more = `${rest.length === 1 ? 'עוד מקור אחד' : `עוד ${rest.length} מקורות`}${restTicked ? `, ${restTicked === rest.length ? (rest.length === 1 ? 'מסומן' : 'כולם מסומנים') : restTicked === 1 ? 'אחד מהם מסומן' : `${restTicked} מהם מסומנים`}` : ''}`;
  return `<section class="panel" id="found"><header><h2>המקורות שמצאנו</h2></header><p class="muted small m0">${esc(said)}</p>
${rows(first)}
${rest.length ? `<details class="srcrest"><summary>${esc(more)}</summary>${rows(rest)}</details>` : ''}
${pc.operator && hidden.length ? `<details class="srcrest"><summary class="muted small">מקורות שלא הוצגו ללקוח (${hidden.length})</summary>${rows(hidden)}</details>` : ''}</section>`;
}

/** Too few good sources: said plainly, with a search again with more of the owner's own sites. */
function fewPanel(pc, r, n) {
  return `<section class="panel" id="more"><header><h2>מצאנו מעט מקורות טובים לנושא הזה</h2></header>
<p class="muted">${n ? `יש כאן ${n === 1 ? 'מקור אחד' : `${n} מקורות`} שאפשר לעבוד איתם.` : 'לא מצאנו מקור שבאמת עוסק בנושא.'} עדיף להוסיף אתרים שאתם סומכים עליהם ולחפש שוב, במקום למלא את החשבון במקורות חלשים.</p>
<form method="post" action="/new/${esc(r.id)}/more" class="formgrid">${csrfField(pc)}
<label class="f">אתרים שאתם סומכים עליהם <small class="js-hide">כתובת אחת בכל שורה</small><small class="js-show">כותבים כתובת ולוחצים Enter</small><textarea name="examples" rows="3" dir="ltr" required data-pills data-max="10"></textarea></label>
<div><button class="btn" type="submit">${icon('spark')}לחפש שוב</button></div></form></section>`;
}

const SAMPLES_HE = {
  nofacts: 'במקורות שבחרתם לא מצאנו מספיק עובדות לכתוב מהן. אפשר להוסיף מקורות או לבחור אחרים, ואז לנסות שוב.',
  unreadable: 'לא הצלחנו לקרוא את המקורות שבחרתם. אפשר להוסיף מקורות או לבחור אחרים, או לנסות שוב בעוד כמה דקות.',
  error: 'משהו נתקע אצלנו באמצע הכתיבה. אפשר לנסות שוב.',
  refused: 'הפוסטים שכתבנו לא עברו את הבדיקות שלנו, ולכן לא הראינו אותם. אפשר לנסות שוב, או להוסיף מקורות עם יותר עובדות.',
  // Stopped at the setup's cap before paying (src/billing/setup-cap.js). While the cap still holds, the page says what
  // opens after activating instead (activateBanner); this is for once it no longer does.
  cap: 'הכתיבה נעצרה לפני ההפעלה. אפשר לנסות שוב.',
};

/** The samples' outcome, said with what helps. `more` is sampleRoom's answer: whether another round may be asked for. */
function samplesSaid(pc, r, pack, { busy, more = { ok: true } }) {
  const s = r.found.samples;
  const failed = busy ? null : s ? s.failure : r.found.samplesFailed ? 'error' : null;
  if (!failed) return '';
  // At the setup's cap before paying, the page says what opens after activating instead (activateBanner).
  if (more.why === 'cap') return '';
  const made = s?.made || 0;
  const kept = made ? `${made === 1 ? 'פוסט אחד לדוגמה מוכן' : `${made} פוסטים לדוגמה מוכנים`}, והם כאן למטה. ` : '';
  const toSources = failed !== 'error' && pack ? `<a class="btn sm" href="/sources?account=${esc(encodeURIComponent(pack.id))}">לבחור מקורות</a>` : '';
  const again = more.ok ? postButton(pc, `/new/${r.id}/samples`, 'לנסות שוב', { cls: 'btn sm primary' }) : '';
  return `<div class="banner warn">${icon('alert')}<div><b>${esc(kept)}${esc(SAMPLES_HE[failed] || SAMPLES_HE.error)}</b>${more.ok ? '' : `<p>${withSupport(ROUNDS_HE[more.why])}</p>`}</div><div class="actions p0">${toSources}${again}</div></div>`;
}

function detailPage(ctx, pc, r) {
  const head = `<div class="head"><div><a class="muted small back" href="/new">${icon('chev')}חשבון חדש</a><h1>${esc(r.seed.niche)}</h1></div><span class="end"><span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span></span></div>`;
  const ops = operatorNotes(pc, r.notes);
  // Before paying, at the setup's cap (src/billing/setup-cap.js): a search or a new account would be refused.
  const capped = !pc.operator && !setupRoom(ctx.db, r.workspace_id ?? null).ok;
  if (r.status === 'discovering') {
    return layout(
      { ...pc, title: 'מחפשים מקורות', active: 'new' },
      `${head}<section class="panel" id="progress"><header>${icon('spark')}<h2>מחפשים מקורות</h2></header>
<p class="muted">זה לוקח בדרך כלל כמה דקות, ואפשר גם לסגור את הדף ולחזור אחר כך.</p>
${pollBox(ctx, r, { href: `/new/${r.id}#sources` })}
<p class="muted mt12">${pc.unpaid ? 'בינתיים אפשר לסדר כאן את השם, את השקף האחרון ואת הימים והשעות.' : 'בינתיים אפשר לסדר כאן את השם, את השקף האחרון, את הימים והשעות ואת החיבור לטיקטוק, לאינסטגרם ולפייסבוק.'} מה ששומרים נשאר, ונכנס לחשבון כשהוא נוצר.</p></section>
<div class="cols"><div class="grid12">${namePanel(pc, r)}${newPromoPanel(pc, r, { action: `/new/${r.id}/promo`, busy: reading.has(r.id), nameDefault: nameOf(pc, r) })}${connectSection(ctx, pc, r)}</div><div class="grid12">${scheduleSection(ctx, pc, r)}</div></div>`
    );
  }
  if (r.status === 'failed') {
    return layout(
      { ...pc, title: 'החיפוש נעצר', active: 'new' },
      `${head}${capped ? activateBanner(pc, { good: 0, capped }) : `<div class="empty">${icon('alert')}<b>${esc(FAILURE_HE[r.found.failure] || FAILURE_HE.error)}</b>${withSupport('אפשר לנסות שוב עם אותם פרטים. מה שכבר שמרתם נשאר. אם זה חוזר, כתבו לנו ונבדוק.')}</div>
<div class="actions">${postButton(pc, `/new/${r.id}/retry`, `${icon('spark')}לנסות שוב`, { cls: 'btn primary' })}<a class="btn" href="/new">להתחיל מחדש</a></div>`}${ops}`
    );
  }
  const cands = r.found.candidates || [];
  if (r.status === 'review') {
    const formats = r.found.formats || [];
    const formatsPanel = formats.length
      ? `<section class="panel"><header><h2>פורמטים שעובדים בנישה</h2></header><ul class="factlist">${formats.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${k(f.views)} צפיות ${icon('ext')}</a> <span class="muted small" dir="auto">${esc(f.title)}</span></li>`).join('')}</ul></section>`
      : pc.operator
        ? '<section class="panel"><header><h2>פורמטים שעובדים בנישה</h2></header><p class="muted small">לא נבדק (בלי YOUTUBE_API_KEY). למפעיל בלבד.</p></section>'
        : '';
    // The customer is offered the good ones only; the operator sees the rest too, folded away.
    const shown = cands.filter(offered);
    const hidden = cands.filter((c) => !offered(c));
    // Back after a refusal: the ticks, the kinds of slideshow, the name and the closing slide as the customer left them.
    const chosen = chosenOf(r);
    const picked = chosen?.formats ? Object.fromEntries(chosen.formats.map((id) => [`fmt_${id}`, 'on'])) : null;
    return layout(
      { ...pc, title: 'בחירת מקורות', active: 'new' },
      `${head}${capped ? activateBanner(pc, { good: 0, capped }) : ''}${saidBanner(r.found.said)}${shown.length < FEW && !capped ? fewPanel(pc, r, shown.length) : ''}
<form method="post" action="/new/${esc(r.id)}/create" id="sources">${csrfField(pc)}
<div class="cols"><div class="grid12">${shown.length || (pc.operator && hidden.length) ? sourcesPanel(pc, shown, hidden, chosen) : `<div class="empty">${icon('sources')}<b>לא נמצאו מקורות</b>אפשר להוסיף כאן למעלה אתרים שאתם סומכים עליהם, או <a href="/new">להתחיל שוב</a>.</div>`}</div>
<div class="grid12">${formatsSection(picked)}${newPromoPanel(pc, r, { busy: reading.has(r.id), nameDefault: nameOf(pc, r) })}<section class="panel" id="name"><header><h2>${NAME_TITLE}</h2></header><div class="formgrid">
${nameFields(pc, r)}
<p class="muted small m0">את העיצוב של המצגות אפשר להחליף אחר כך בדף החשבון.</p>
<button class="btn primary" type="submit">${icon('check')}ליצור את החשבון</button></div></section>
${formatsPanel}</div></div></form>
<div class="cols"><div class="grid12">${connectSection(ctx, pc, r)}</div><div class="grid12">${scheduleSection(ctx, pc, r)}</div></div>${ops}`
    );
  }
  const pack = ctx.pack(r.pack_id);
  const samples = ctx.db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 1 ORDER BY created_at", r.pack_id).map((x) => loadPost(ctx.db, x.id));
  const good = samples.filter((p) => p.status === 'sample').length;
  const busy = running.has(r.id);
  const reviewed = r.status === 'ready';
  // Another round of samples: the customer's are limited (sampleRoom), the operator's are not.
  const more = pc.operator ? { ok: true, why: null } : sampleRoom(ctx.db, r);
  // Before paying (src/web/server.js SETUP_OPEN), what is the paywall's is not offered here: going live, connecting, the
  // designs page and the account's days and times. The samples ready, the page says what is left, with the way to pay.
  const locked = Boolean(pc.unpaid);
  const sched = pack && r.status !== 'live' && !locked ? scheduleData(ctx.db, pack) : null;
  const activate = locked && r.status !== 'live' && (more.why === 'cap' || good >= SAMPLE_ENOUGH) ? activateBanner(pc, { good, capped: more.why === 'cap' }) : '';
  // The samples lead the page (the owner, 2026-10-31: "why are the slideshows at the end of the page? make them at the
  // top"): how many passed and the buttons that act on them, the progress while more are written, the cards; then the
  // account, its networks and its days and times.
  return layout(
    { ...pc, title: 'פוסטים לדוגמה', active: 'new' },
    `${head}${activate}${samplesSaid(pc, r, pack, { busy, more })}${pack && r.setup.promoUnfinished && !pack.meta.promo ? promoLater(pack, { locked }) : ''}
<section class="samples" id="samples" aria-label="פוסטים לדוגמה"><div class="samplebar"><p class="muted small m0">${samplesLine(good)}</p>
<div class="actions p0">${busy ? `<span class="chip warn">${icon('clock')}כותבים פוסטים לדוגמה</span>` : more.ok ? postButton(pc, `/new/${r.id}/samples`, `${icon('spark')}${samples.length ? 'עוד פוסטים לדוגמה' : 'ליצור 5 פוסטים לדוגמה'}`, { cls: 'btn' }) : more.why === 'cap' ? '' : `<span class="muted small">${withSupport(ROUNDS_HE[more.why])}</span>`}
${good >= SAMPLE_ENOUGH && !reviewed && r.status !== 'live' ? postButton(pc, `/new/${r.id}/reviewed`, `${icon('check')}עברתי על הדוגמאות`, { cls: 'btn' }) : ''}
${reviewed && !locked ? postButton(pc, `/new/${r.id}/live`, `${icon('power')}להעלות לאוויר, במצב אישור`, { cls: 'btn primary', confirm: 'לחצו שוב כדי להעלות לאוויר' }) : ''}
${r.status === 'live' ? '<span class="chip ok">באוויר</span>' : ''}</div></div>
${busy ? pollBox(ctx, r, { href: `/new/${r.id}` }) : ''}
${samples.length ? `<div class="posts">${samples.map((p) => postCard(pc, p, pack)).join('')}</div>` : ''}</section>
${pack && good && !locked ? designPanel(pack, lockedStyle(ctx.db, pack, engine(ctx).packs).theme.style?.name || null, { back: `/new/${r.id}` }) : ''}
<section class="panel"><header>${accDot(r.pack_id)}<h2>${esc(pack?.meta.displayName || r.pack_id)}</h2><span class="end muted small ltr">@${esc(pack?.meta.handle || '')}</span></header>
<p class="muted">החשבון נוצר. הוא לא יעלה לאוויר לפני שיש לפחות שלושה פוסטים לדוגמה ועברתם עליהם. פוסט לדוגמה לא מתפרסם, גם אחרי שהחשבון באוויר.</p>${pc.operator ? `<p class="muted small">התיקייה הפרטית: <span class="ltr">${esc(r.pack_id)}</span></p>` : ''}
${pack && locked ? `<p class="muted mt12" id="connect">${esc(CAP_HE.connect)}</p>` : pack ? `<div id="connect"><p class="muted mt12">כדי שהפוסטים יגיעו לטיקטוק, לאינסטגרם ולפייסבוק, מחברים כאן את החשבונות. אפשר לעשות את זה גם אחרי שהחשבון באוויר, מדף החשבון.</p>${connectPanel(pc, connectData(ctx, pack))}</div>` : ''}</section>
${sched ? schedulePanel(pc, sched, { back: `/new/${r.id}`, lede: `בחרנו ימים ושעות שמספיקים ל-${sched.month.plan} הפוסטים שבחבילה. אפשר לשנות אותם עכשיו, או אחר כך בהגדרות.` }) : ''}
${ops}`
  );
}

/** A pack that could not be written, said to the customer: what they can fix, else that it failed on our side. */
function createError(ctx, e) {
  // Pack ids are the server's, so a handle another workspace has is refused without naming whose it is.
  if (/already exists/.test(e.message)) return new ActionError(NAME_HE.taken);
  if (/handle must be latin/.test(e.message)) return new ActionError(NAME_HE.badHandle);
  if (/approve at least one source/.test(e.message)) return new ActionError('צריך לאשר לפחות מקור אחד.');
  ctx.log?.(`[onboarding] the pack was not written: ${[e.message, ...(e.problems || [])].join(' · ')}`);
  return new ActionError('לא הצלחנו ליצור את החשבון הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו לנו.', 500);
}

/** Before the account exists: the parts that wait for it. After, they are the account's own pages. */
const beforeAccount = (r) => {
  if (r.pack_id) throw new ActionError('החשבון כבר נוצר, ואת זה משנים עכשיו בדף שלו.', 409);
};

/** The name and handle as typed, kept so a form that will not do comes back with them. */
const typed = (f) => ({ displayName: String(f.displayName || '').trim().slice(0, 40), handle: String(f.handle || '').trim().replace(/^@+/, '').slice(0, 30) });

/**
 * The routes, each (ctx, user, match, form or query, page context) with the request's context. `links()` is
 * { base, secret }: where Zernio sends the browser back after a connect, and what that address is signed with.
 */
export function onboardingRoutes(links = () => ({ base: '', secret: '' })) {
  return [
    ['GET', /^\/new$/, (ctx, _u, _m, _q, pc) => listPage(ctx, pc)],
    ['GET', /^\/new\/([\w-]+)$/, (ctx, _u, m, _q, pc) => detailPage(ctx, pc, row(ctx, m[1]))],
    // What the waiting page's script asks for (JSON): the progress line, and whether there is something new to show.
    ['GET', /^\/new\/([\w-]+)\/status$/, (ctx, _u, m) => ({ json: statusOf(ctx, row(ctx, m[1])) })],
    [
      'POST',
      /^\/new$/,
      async (ctx, user, _m, f) => {
        if (hasAccount(ctx.db, ctx.workspaceId)) throw new ActionError(ONE_ACCOUNT, 409);
        capCheck(ctx, user, ctx.workspaceId);
        const niche = String(f.niche || '').trim();
        if (niche.length < 2) throw new ActionError('צריך לכתוב במה החשבון יעסוק');
        const id = newId('o');
        // The business's own site, optional: the closing slide is filled in from it (src/onboarding/promo.js).
        const typedSite = String(f.site || '').trim().slice(0, 300);
        const site = typedSite ? storeOrigin(typedSite) : null;
        // No English niche to fill in: the discovery asks the model for it (src/onboarding/discover.js nicheInEnglish).
        const seed = { niche, nicheEn: String(f.nicheEn || '').trim(), language: 'he', audience: String(f.audience || '').trim(), topics: listField(f.topics, TOPICS), examples: listField(f.examples), ...(site ? { site } : {}) };
        ctx.db.insert('onboarding', { id, seed_json: seed, status: 'discovering', workspace_id: ctx.workspaceId ?? null, ...(typedSite && !site ? { setup_json: { siteRead: 'failed' } } : {}), created_at: nowIso(), updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche } });
        startDiscovery(ctx, id, { counted: !user.operator });
        if (site) {
          // A moment's wait, so the page usually opens with it filled in; a slow site goes on in the background.
          const job = startSiteRead(ctx.db, id, site, { opts: engine(ctx).siteOpts || {}, log: ctx.log });
          await new Promise((done) => {
            const t = setTimeout(done, engine(ctx).siteWaitMs ?? SITE_WAIT_MS);
            t.unref?.();
            job.finally(() => (clearTimeout(t), done()));
          });
        }
        return { ok: true, message: 'מחפשים מקורות.', redirect: `/new/${id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/retry$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'failed') throw new ActionError('החיפוש הזה לא נעצר, אין מה לנסות שוב.', 409);
        capCheck(ctx, user, r.workspace_id);
        ctx.db.update('onboarding', r.id, { status: 'discovering', candidates_json: {}, notes_json: [], updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, retry: true } });
        startDiscovery(ctx, r.id, { counted: !user.operator });
        return { ok: true, message: 'מחפשים שוב.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/more$/,
      (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'review') throw new ActionError('אפשר לחפש שוב רק לפני שהחשבון נוצר.', 409);
        const added = listField(f.examples);
        if (!added.length) throw new ActionError('צריך לכתוב לפחות כתובת אחת של אתר.');
        capCheck(ctx, user, r.workspace_id);
        const seed = { ...r.seed, examples: [...new Set([...(r.seed.examples || []), ...added])].slice(0, 10) };
        ctx.db.update('onboarding', r.id, { status: 'discovering', seed_json: seed, candidates_json: {}, notes_json: [], updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, more: added.length } });
        startDiscovery(ctx, r.id, { counted: !user.operator });
        return { ok: true, message: 'מחפשים שוב, עם האתרים שהוספתם.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/name$/,
      (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        beforeAccount(r);
        saveSetup(ctx.db, r.id, typed(f));
        const n = checkName(f, { packs: engine(ctx).packs });
        if (n.problems) throw new ActionError(n.problems.join(' '), 422, { problems: n.problems });
        saveSetup(ctx.db, r.id, { displayName: n.displayName, handle: n.handle });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, name: true } });
        return { ok: true, message: 'נשמר. אפשר לשנות גם בשלב הבא.', redirect: `/new/${r.id}#name` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/promo$/,
      (ctx, user, m, f) => {
        // The closing slide, accepted as it was filled in or changed (src/web/promo.js). What was typed is kept even
        // when it will not do, so the form comes back with it; the account takes it only once it does.
        const r = row(ctx, m[1]);
        beforeAccount(r);
        const got = promoFromForm(f);
        saveSetup(ctx.db, r.id, { promo: got.draft, promoBy: 'customer' });
        if (got.problems) throw new ActionError(got.problems.join(' '), 422, { problems: got.problems, back: `/new/${r.id}#promo` });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, promo: Boolean(got.promo) } });
        return { ok: true, message: 'נשמר. אפשר לשנות גם בשלב הבא.', redirect: `/new/${r.id}#promo` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/schedule$/,
      (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        beforeAccount(r);
        const c = readChoice(f);
        if (c.problems) throw new ActionError(c.problems.join('. '), 422, { problems: c.problems });
        saveSetup(ctx.db, r.id, { choice: { ...c, at: nowIso() } });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, schedule: c.byDay } });
        return { ok: true, message: 'נשמר. החשבון יפרסם בימים ובשעות שבחרתם.', redirect: `/new/${r.id}#schedule` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/connect\/(tiktok|instagram|facebook)$/,
      async (ctx, user, m) => {
        const r = row(ctx, m[1]);
        if (!zernioConfigured()) throw new ActionError('החיבור עוד לא זמין בשרת הזה.');
        const { base, secret } = links();
        const pack = r.pack_id ? ctx.pack(r.pack_id) : null;
        let url;
        try {
          url = pack
            ? await startConnect(ctx.db, pack, m[2], { doneUrl: doneLink(secret, { base, accountId: pack.id, platform: m[2] }), actor: user.name })
            : await startOnboardingConnect(ctx.db, r.id, m[2], { doneUrl: onboardingDoneLink(secret, { base, onboardingId: r.id, platform: m[2] }), name: r.setup.displayName || r.seed.niche, actor: user.name });
        } catch (e) {
          if (e.code === 'not_connectable') throw new ActionError(`${PLATFORM_NAME[m[2]]} לא צריך חיבור בחשבון הזה.`);
          ctx.log?.(`[connect] onboarding ${r.id} ${m[2]}: ${e.message}`);
          throw new ActionError('אי אפשר לפתוח עכשיו את מסך החיבור. נסו שוב בעוד כמה דקות.', 502);
        }
        return { ok: true, message: `עוברים ל${PLATFORM_NAME[m[2]]}`, go: url, goName: PLATFORM_NAME[m[2]] };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/connections$/,
      async (ctx, _user, m) => {
        const r = row(ctx, m[1]);
        beforeAccount(r);
        if (!zernioConfigured()) throw new ActionError('החיבור עוד לא זמין בשרת הזה.');
        try {
          await refreshOnboardingConnections(ctx.db, r.id);
        } catch (e) {
          ctx.log?.(`[connect] onboarding ${r.id}: ${e.message}`);
          throw new ActionError('לא הצלחנו לבדוק עכשיו. נסו שוב בעוד כמה דקות.', 502);
        }
        return { ok: true, message: 'החיבורים עודכנו.', redirect: `/new/${r.id}#connect` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/create$/,
      async (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'review') throw new ActionError('החשבון הזה כבר נוצר, או שהחיפוש עוד לא הסתיים.', 409);
        // An older setup finished after the workspace's account was made: still one account.
        if (hasAccount(ctx.db, r.workspace_id ?? null)) throw new ActionError(ONE_ACCOUNT, 409);
        // A source the customer was not offered is not theirs to approve (the operator may); one whose terms forbid
        // reuse is nobody's.
        const may = (c) => c.score?.terms !== 'no' && (offered(c) || user.operator);
        const candidates = (r.found.candidates || []).map((c) => ({ ...c, approved: f[`approve_${c.id}`] === 'on' && may(c), why: String(f[`why_${c.id}`] || c.why || c.score?.reason || '').trim() }));
        // Everything chosen here is kept before anything is checked, so a refusal brings the step back as it was left:
        // the name and handle, the ticks and kinds of slideshow (chosenFrom), and the closing slide as typed.
        saveSetup(ctx.db, r.id, { ...typed(f), chosen: chosenFrom(r, f), ...(f.promo_shown ? { promo: draftFromForm(f), promoBy: 'customer' } : {}) });
        const n = checkName(f, { packs: engine(ctx).packs });
        if (n.problems) throw new ActionError(n.problems.join(' '), 422, { problems: n.problems });
        // The kinds of slideshow picked on this step (src/web/formats.js), at least three; a form that did not show the
        // choice (an older page) gets the defaults.
        const formatIds = f.formats_shown ? pickedFrom(f) : DEFAULT_PICKED;
        if (formatIds.length < MIN_PICKED) throw new ActionError(FORMATS_FEW, 422);
        // What the last slide sends people to, as this step showed it (src/web/promo.js; an older page's form, the
        // setup's draft). It never stops the account (the follow-up on item 1, 2026-11-02: "A half-filled promo must never block
        // creating the account or lose what the customer chose"): one that is not finished makes an account without one,
        // the draft stays on the onboarding for Settings to offer, and the next page says it can be finished there.
        const { promo, unfinished } = settlePromo(f.promo_shown ? draftFromForm(f) : r.setup.promo);
        // The account's voice and scenes are paid calls: before paying, under the setup's cap and counted against it.
        capCheck(ctx, user, r.workspace_id);
        let made;
        try {
          made = await metered(ctx.db, r, () => createPack(engine(ctx), { seed: r.seed, candidates, displayName: n.displayName, handle: n.handle, examplesFromOwner: r.seed.examples, workspaceId: r.workspace_id ?? null, formatIds, promo }), !user.operator);
        } catch (e) {
          throw createError(ctx, e);
        }
        // The account starts in onboarding: the runner leaves it alone until it goes live.
        ctx.db.insert('accounts', { id: made.id, display_name: made.pack.meta.displayName, handle: made.pack.meta.handle, mode: 'approve', status: 'onboarding', workspace_id: r.workspace_id ?? null, created_at: nowIso(), updated_at: nowIso() });
        // Its days and times: what the owner chose while the sources were searched, else the default the page showed
        // (moved a few minutes by this onboarding, so customers do not all post on the same minute), which reaches the
        // month's plan. The owner may change them before it goes live.
        const choice = setupOf(ctx.db, r.id).choice;
        if (choice?.byDay) saveChoice(ctx.db, made.id, choice.byDay, { actor: user.name, shabbat: Boolean(choice.shabbat), holidays: Boolean(choice.holidays) });
        else saveChoice(ctx.db, made.id, defaultChoiceFor(r.id), { actor: user.name });
        // TikTok and Instagram connected before the account existed: the account takes the profile over.
        carryOnboardingZernio(ctx.db, r.id, made.id, { actor: user.name });
        ctx.reloadPacks();
        // The logo the site read found, fetched into the account in the background: the account is made whether or not
        // it comes (src/onboarding/promo.js startLogoFetch).
        if (r.seed.site) startLogoFetch(engine(ctx), r.id, made.id, { opts: engine(ctx).siteOpts || {}, log: ctx.log });
        saveSetup(ctx.db, r.id, { promoUnfinished: unfinished });
        ctx.db.update('onboarding', r.id, { status: 'samples', pack_id: made.id, candidates_json: { ...r.found, candidates }, updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', accountId: made.id, detail: { sources: candidates.filter((c) => c.approved).length } });
        return { ok: true, message: 'החשבון נוצר.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/samples$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        if (!r.pack_id) throw new ActionError('קודם יוצרים את החשבון');
        if (!user.operator) {
          const more = sampleRoom(ctx.db, r);
          if (!more.ok) throw new ActionError(more.why === 'cap' ? capMessage(ctx.db, r.workspace_id) : ROUNDS_HE[more.why], 409);
        }
        startSamples(ctx, r.id, { counted: !user.operator });
        return { ok: true, message: 'כותבים פוסטים לדוגמה.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/reviewed$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        const n = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", r.pack_id).n;
        if (n < SAMPLE_ENOUGH) throw new ActionError(`צריך לפחות ${SAMPLE_ENOUGH} דוגמאות שעברו את הבדיקות, יש ${n}`);
        ctx.db.update('onboarding', r.id, { status: 'ready', updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', accountId: r.pack_id, detail: { reviewed: n } });
        return { ok: true, message: 'סומן שעברתם על הדוגמאות.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/live$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'ready') throw new ActionError('קודם עוברים על הדוגמאות');
        ctx.db.update('accounts', r.pack_id, { status: 'active', mode: 'approve', updated_at: nowIso() });
        ctx.db.update('onboarding', r.id, { status: 'live', updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'went_live', accountId: r.pack_id });
        return { ok: true, message: 'החשבון באוויר, במצב אישור: כל פוסט יחכה לכם.', redirect: '/accounts' };
      },
    ],
  ];
}

/** Whether this onboarding has work running in the background (its discovery, or its sample posts). */
export const onboardingBusy = (id) => running.has(id);

/** The most samples the paywall shows. */
export const PAYWALL_SAMPLES = 6;

/**
 * What the paywall shows a customer whose workspace has not paid (src/web/server.js, pages.js gatePage), while its setup
 * is not done: { href, started, samples: [{ src, alt }] }, the first slide of each sample that passed (PAYWALL_SAMPLES at
 * most) and where the setup goes on. null once an account of the workspace has been live: that customer stopped paying,
 * and the paywall says what it said before.
 */
export function beforePaying(ctx, workspaceId) {
  const { db } = ctx;
  if (db.get("SELECT 1 FROM accounts WHERE workspace_id = ? AND status <> 'onboarding' LIMIT 1", workspaceId)) return null;
  const ob = db.get("SELECT id, pack_id FROM onboarding WHERE workspace_id = ? AND status NOT IN ('live', 'abandoned') ORDER BY pack_id IS NULL, updated_at DESC LIMIT 1", workspaceId);
  const posts = ob?.pack_id ? db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 1 AND status = 'sample' ORDER BY created_at LIMIT ?", ob.pack_id, PAYWALL_SAMPLES).map((x) => loadPost(db, x.id)) : [];
  const first = (p) => {
    const platform = p.media?.tiktok?.length ? 'tiktok' : p.media?.instagram?.length ? 'instagram' : null;
    return platform ? { src: `/media/${encodeURIComponent(p.id)}/${platform}/0`, alt: String(p.hook || '') } : null;
  };
  return { href: ob ? `/new/${ob.id}` : '/new', started: Boolean(ob), samples: posts.map(first).filter(Boolean) };
}

export const __onboarding = { running, progress };
