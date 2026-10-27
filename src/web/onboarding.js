import { newId, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { discover } from '../onboarding/discover.js';
import { createPack } from '../onboarding/pack.js';
import { buildPost, loadPost } from '../pipeline/build.js';
import { DEFAULT_CHOICE, saveChoice } from '../schedule/choice.js';
import { ActionError } from './actions.js';
import { postCard } from './pages.js';
import { connectData, connectPanel } from './connect.js';
import { scheduleData, schedulePanel } from './schedule.js';
import { accDot, csrfField, esc, icon, k, layout, postButton, stamp } from './ui.js';

// The new-account flow, on the website:
//
//   seed  ->  discovery (in the background)  ->  approve sources, name the account
//         ->  the pack is written (no code)  ->  5 sample posts to review, the days and times to post on
//         ->  live, in Approve mode
//
// Nothing goes live before five samples exist and the owner has looked at them.
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
// Each is retryable: POST /new/<id>/retry runs the discovery again on the same seed.
//
// WHAT THE CUSTOMER READS IS PLAIN HEBREW. The discovery's own notes (a missing key, a site that did not answer, a
// fallback ranking) are the operator's: notes_json, shown only to the operator, and explained in docs/operator-notes.md.
// The customer is told only what they can act on (candidates_json.said).

const STATUS_HE = { discovering: 'מחפשים מקורות', review: 'בוחרים מקורות', failed: 'החיפוש נעצר', samples: 'פוסטים לדוגמה', ready: 'מוכן לעלות', live: 'באוויר' };
const TERMS_HE = { ok: 'תנאים בסדר', check: 'לבדוק תנאי שימוש', no: 'אסור לשימוש' };
const TYPE_HE = { rss: 'פיד', web: 'דף', api: 'נתונים' };
const FAILURE_HE = { timeout: 'החיפוש לקח יותר מדי זמן ונעצר.', restart: 'החיפוש נקטע באמצע.', error: 'משהו השתבש בחיפוש.' };
/** The most a discovery may run before it is stopped and marked failed (retryable). */
export const DISCOVERY_TIMEOUT_MS = 3 * 60_000;
const running = new Map();
/** What a running discovery is doing now: { step, done, total } (src/onboarding/discover.js onProgress). */
const progress = new Map();

const engine = (ctx) => ctx.global || ctx;

const RESTARTED = 'the server restarted while the discovery ran';

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
  return { ...r, seed: j(r.seed_json, {}), found: j(r.candidates_json, {}), notes: j(r.notes_json, []) };
};

function startDiscovery(ctx, id) {
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
  const found = discover(ctx, r.seed, { ...(ctx.discoverOpts || {}), signal: stop.signal, onProgress: (p) => progress.set(id, p) });
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

function startSamples(ctx, id) {
  if (running.has(id)) return;
  const r = row(ctx, id);
  ctx = engine(ctx);
  const pack = ctx.pack(r.pack_id);
  const count = () => ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", pack.id).n;
  const job = (async () => {
    const notes = [];
    const before = count();
    for (let i = 0; i < 5; i++) {
      const res = await buildPost(ctx, { pack, sample: true });
      if (res.status !== 'sample') notes.push(`פוסט ${i + 1}: ${res.reason}`);
    }
    const n = count();
    if (n < 5 && ctx.mode === 'recorded') notes.push('המנוע במצב הקלטות: בלי ANTHROPIC_API_KEY אין מי שיכתוב פוסטים מהמקורות החדשים. עם מפתח, או עם הקלטות (npm run record), הפוסטים ייכתבו כאן.');
    ctx.db.update('onboarding', id, { status: 'samples', candidates_json: { ...r.found, samplesFailed: n === before }, notes_json: [...r.notes, ...notes], updated_at: nowIso() });
  })()
    .catch((e) => ctx.db.update('onboarding', id, { candidates_json: { ...r.found, samplesFailed: true }, notes_json: [...r.notes, String(e.message)], status: 'samples', updated_at: nowIso() }))
    .finally(() => running.delete(id));
  running.set(id, job);
}

/** The operator's notes, folded away: what was skipped and why, in the discovery's own words. */
const operatorNotes = (pc, notes) =>
  pc.operator && notes.length ? `<details class="mt12"><summary class="muted small">הערות למפעיל (${notes.length})</summary><ul class="factlist">${notes.slice(0, 30).map((n) => `<li class="muted small" dir="auto">${esc(n)}</li>`).join('')}</ul><p class="muted small">מה כל הערה אומרת ומה עושים: docs/operator-notes.md</p></details>` : '';

/** What the customer is told: a line or two they can act on. */
const saidBanner = (lines) => (lines?.length ? `<div class="banner info">${icon('alert')}<div>${lines.slice(0, 4).map((n) => `<p>${esc(n)}</p>`).join('')}</div></div>` : '');

function progressLine(p) {
  if (!p) return '';
  if (p.step === 'sites' && p.total) return ` עכשיו בודקים אתרים, ${p.done} מתוך ${p.total}.`;
  if (p.step === 'formats') return ' עכשיו בודקים מה עובד בתחום שלכם.';
  if (p.step === 'score') return ' כמעט סיימנו, נותנים ציון לכל מקור.';
  return ' עכשיו מחפשים אתרים.';
}

function listPage(ctx, pc) {
  const rows = (ctx.workspaceId == null ? ctx.db.all('SELECT * FROM onboarding ORDER BY updated_at DESC LIMIT 20') : ctx.db.all('SELECT * FROM onboarding WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 20', ctx.workspaceId)).map((r) => ({ ...r, seed: j(r.seed_json, {}) }));
  return layout(
    { ...pc, title: 'חשבון חדש', active: 'new' },
    `<div class="head"><h1>חשבון חדש</h1><span class="sub">כותבים במה החשבון יעסוק, מאשרים מקורות ומקבלים חמישה פוסטים לדוגמה.</span></div>
<div class="cols"><section class="panel"><header><h2>מתחילים מכאן</h2></header>
<p class="muted">תדר מחפש אתרים שאפשר לסמוך עליהם, כמו משרדי ממשלה, גופים רשמיים וכלי תקשורת ותיקים, ונותן לכל אחד ציון עם הסבר. מקור נכנס לחשבון רק אחרי שאתם מאשרים אותו.</p>
<form method="post" action="/new" class="formgrid">${csrfField(pc)}<input type="hidden" name="language" value="he">
<label class="f">במה החשבון יעסוק <small>כמו שהייתם מספרים לחבר</small><input type="text" name="niche" required maxlength="80" placeholder="למשל: בישול טבעוני לסטודנטים"></label>
<label class="f">למי הוא מיועד<input type="text" name="audience" maxlength="160" placeholder="למשל: סטודנטים שמבשלים בתקציב קטן"></label>
<label class="f">נושאים שחשובים לכם <small>מופרדים בפסיקים, לא חובה</small><input type="text" name="topics" maxlength="200"></label>
<label class="f">אתרים או חשבונות שאתם אוהבים <small>כתובת אחת בכל שורה, לא חובה</small><textarea name="examples" rows="4" dir="ltr"></textarea></label>
<button class="btn primary" type="submit">${icon('spark')}לחפש מקורות</button></form></section>
<section class="panel"><header><h2>בתהליך</h2></header>${rows.length ? `<ul class="factlist">${rows.map((r) => `<li><a href="/new/${esc(r.id)}"><b>${esc(r.seed.niche)}</b></a> <span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span> <span class="muted small">${esc(stamp(r.updated_at))}</span></li>`).join('')}</ul>` : '<p class="muted">אין עדיין.</p>'}</section></div>`
  );
}

function detailPage(ctx, pc, r) {
  const head = `<div class="head"><div><a class="muted small back" href="/new">${icon('chev')}חשבון חדש</a><h1>${esc(r.seed.niche)}</h1></div><span class="end"><span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span></span></div>`;
  const ops = operatorNotes(pc, r.notes);
  if (r.status === 'discovering') {
    return layout(
      { ...pc, title: 'מחפשים מקורות', active: 'new' },
      `${head}<div class="empty">${icon('spark')}<b>מחפשים מקורות</b>זה לוקח בדרך כלל כמה דקות.${esc(progressLine(progress.get(r.id)))} הדף מתעדכן לבד, ואפשר גם לסגור אותו ולחזור אחר כך.</div><meta http-equiv="refresh" content="5">`
    );
  }
  if (r.status === 'failed') {
    return layout(
      { ...pc, title: 'החיפוש נעצר', active: 'new' },
      `${head}<div class="empty">${icon('alert')}<b>${esc(FAILURE_HE[r.found.failure] || FAILURE_HE.error)}</b>אפשר לנסות שוב עם אותם פרטים. אם זה חוזר, כתבו לנו ונבדוק.</div>
<div class="actions">${postButton(pc, `/new/${r.id}/retry`, `${icon('spark')}לנסות שוב`, { cls: 'btn primary' })}<a class="btn" href="/new">להתחיל מחדש</a></div>${ops}`
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
    return layout(
      { ...pc, title: 'בחירת מקורות', active: 'new' },
      `${head}${saidBanner(r.found.said)}
<form method="post" action="/new/${esc(r.id)}/create">${csrfField(pc)}
<div class="cols"><div class="grid12">${cands
        .map(
          (c) => `<article class="card srccard"><div class="meta p0"><label class="chip ghost"><input type="checkbox" name="approve_${esc(c.id)}"${c.score.authority >= 7 && c.score.terms !== 'no' ? ' checked' : ''}> לאשר</label><span class="chip ghost">${esc(TYPE_HE[c.type] || c.type)}</span><span class="chip ${c.score.authority >= 7 ? 'ok' : c.score.authority >= 5 ? '' : 'warn'}">סמכות ${c.score.authority}/10</span><span class="chip">עדכניות ${c.score.freshness}/10</span><span class="chip ${c.score.terms === 'ok' ? 'ok' : c.score.terms === 'no' ? 'bad' : 'warn'}">${esc(TERMS_HE[c.score.terms])}</span></div>
<h3 class="srcname" dir="auto">${esc(c.name)}</h3><a class="small ltr" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a>
<p class="muted small m6">${esc(c.score.reason)}${pc.operator && c.score.by === 'heuristic' ? ' · דירוג היוריסטי (בלי מפתח API)' : ''}</p>
<label class="f mt12">למה סומכים עליו<input type="text" dir="auto" name="why_${esc(c.id)}" value="${esc(c.why || c.score.reason)}" maxlength="300"></label></article>`
        )
        .join('') || `<div class="empty">${icon('sources')}<b>לא נמצאו מקורות</b>אפשר <a href="/new">להתחיל שוב</a> עם כתובות של אתרים שאתם סומכים עליהם.</div>`}</div>
<div class="grid12"><section class="panel"><header><h2>שם לחשבון</h2></header><div class="formgrid">
<label class="f">שם החשבון<input type="text" name="displayName" required maxlength="40"></label>
<label class="f">שם המשתמש <small>באותיות לועזיות, כמו בטיקטוק ובאינסטגרם</small><input type="text" name="handle" required maxlength="30" dir="ltr" pattern="@?[A-Za-z0-9._-]{2,30}"></label>
<p class="muted small">העיצוב, הצבעים והגופן נבחרים לבד, כך שהחשבון לא ייראה כמו אף חשבון אחר. אפשר לשנות אותם אחר כך.</p>
<button class="btn primary" type="submit">${icon('check')}ליצור את החשבון</button></div></section>
${formatsPanel}</div></div></form>${ops}`
    );
  }
  const pack = ctx.pack(r.pack_id);
  const samples = ctx.db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 1 ORDER BY created_at", r.pack_id).map((x) => loadPost(ctx.db, x.id));
  const good = samples.filter((p) => p.status === 'sample').length;
  const busy = running.has(r.id);
  const reviewed = r.status === 'ready';
  const said = !busy && r.found.samplesFailed ? ['לא הצלחנו לכתוב דוגמאות הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו לנו.'] : [];
  const sched = pack && r.status !== 'live' ? scheduleData(ctx.db, pack) : null;
  return layout(
    { ...pc, title: 'פוסטים לדוגמה', active: 'new' },
    `${head}${saidBanner(said)}
<section class="panel"><header>${accDot(r.pack_id)}<h2>${esc(pack?.meta.displayName || r.pack_id)}</h2><span class="end muted small ltr">@${esc(pack?.meta.handle || '')}</span></header>
<p class="muted">החשבון נוצר. הוא לא יעלה לאוויר לפני שיש חמישה פוסטים לדוגמה ועברתם עליהם. פוסט לדוגמה לא מתפרסם, גם אחרי שהחשבון באוויר.</p>${pc.operator ? `<p class="muted small">התיקייה הפרטית: <span class="ltr">${esc(r.pack_id)}</span></p>` : ''}
<div class="actions p0">${busy ? `<span class="chip warn">${icon('clock')}כותבים פוסטים לדוגמה, הדף מתעדכן לבד</span><meta http-equiv="refresh" content="4">` : postButton(pc, `/new/${r.id}/samples`, `${icon('spark')}${samples.length ? 'עוד פוסטים לדוגמה' : 'ליצור 5 פוסטים לדוגמה'}`, { cls: 'btn' })}
${good >= 5 && !reviewed && r.status !== 'live' ? postButton(pc, `/new/${r.id}/reviewed`, `${icon('check')}עברתי על הדוגמאות`, { cls: 'btn' }) : ''}
${reviewed ? postButton(pc, `/new/${r.id}/live`, `${icon('power')}להעלות לאוויר, במצב אישור`, { cls: 'btn primary', confirm: 'לחצו שוב כדי להעלות לאוויר' }) : ''}
${r.status === 'live' ? '<span class="chip ok">באוויר</span>' : ''}</div>
<p class="muted small mt12">${good} מתוך 5 דוגמאות עברו את כל הבדיקות.</p>
${pack ? `<p class="muted mt12">כדי שהפוסטים יגיעו לטיקטוק ולאינסטגרם, מחברים כאן את החשבונות. אפשר לעשות את זה גם אחרי שהחשבון באוויר, מדף החשבון.</p>${connectPanel(pc, connectData(ctx, pack))}` : ''}</section>
${sched ? schedulePanel(pc, sched, { back: `/new/${r.id}`, lede: `בחרנו ימים ושעות שמספיקים ל-${sched.month.plan} הפוסטים שבחבילה. אפשר לשנות אותם עכשיו, או אחר כך בהגדרות. בשבת ובחג לא מפרסמים.` }) : ''}
${ops}
<div class="posts mt16">${samples.map((p) => postCard(pc, p, pack)).join('')}</div>`
  );
}

/** A pack that could not be written, said to the customer: what they can fix, else that it failed on our side. */
function createError(ctx, e) {
  // Pack ids are the server's, so a handle another workspace has is refused without naming whose it is.
  if (/already exists/.test(e.message)) return new ActionError('שם המשתמש הזה כבר תפוס. בחרו שם אחר.');
  if (/handle must be latin/.test(e.message)) return new ActionError('שם המשתמש צריך להיות באותיות לועזיות ובמספרים, לפחות שני תווים.');
  if (/approve at least one source/.test(e.message)) return new ActionError('צריך לאשר לפחות מקור אחד.');
  ctx.log?.(`[onboarding] the pack was not written: ${[e.message, ...(e.problems || [])].join(' · ')}`);
  return new ActionError('לא הצלחנו ליצור את החשבון הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו לנו.', 500);
}

/** The routes, each (ctx, user, match, form or query, page context) with the request's context. */
export function onboardingRoutes() {
  return [
    ['GET', /^\/new$/, (ctx, _u, _m, _q, pc) => listPage(ctx, pc)],
    ['GET', /^\/new\/([\w-]+)$/, (ctx, _u, m, _q, pc) => detailPage(ctx, pc, row(ctx, m[1]))],
    [
      'POST',
      /^\/new$/,
      (ctx, user, _m, f) => {
        const niche = String(f.niche || '').trim();
        if (niche.length < 2) throw new ActionError('צריך לכתוב במה החשבון יעסוק');
        const id = newId('o');
        // No English niche to fill in: the discovery asks the model for it (src/onboarding/discover.js nicheInEnglish).
        const seed = { niche, nicheEn: String(f.nicheEn || '').trim(), language: 'he', audience: String(f.audience || '').trim(), topics: String(f.topics || '').split(/[,،]/).map((x) => x.trim()).filter(Boolean), examples: String(f.examples || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10) };
        ctx.db.insert('onboarding', { id, seed_json: seed, status: 'discovering', workspace_id: ctx.workspaceId ?? null, created_at: nowIso(), updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche } });
        startDiscovery(ctx, id);
        return { ok: true, message: 'מחפשים מקורות.', redirect: `/new/${id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/retry$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'failed') throw new ActionError('החיפוש הזה לא נעצר, אין מה לנסות שוב.', 409);
        ctx.db.update('onboarding', r.id, { status: 'discovering', candidates_json: {}, notes_json: [], updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche: r.seed.niche, retry: true } });
        startDiscovery(ctx, r.id);
        return { ok: true, message: 'מחפשים שוב.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/create$/,
      async (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        if (r.status !== 'review') throw new ActionError('החשבון הזה כבר נוצר, או שהחיפוש עוד לא הסתיים.', 409);
        const candidates = (r.found.candidates || []).map((c) => ({ ...c, approved: f[`approve_${c.id}`] === 'on', why: String(f[`why_${c.id}`] || c.why || c.score?.reason || '').trim() }));
        let made;
        try {
          made = await createPack(engine(ctx), { seed: r.seed, candidates, displayName: f.displayName, handle: f.handle, examplesFromOwner: r.seed.examples });
        } catch (e) {
          throw createError(ctx, e);
        }
        // The account starts in onboarding: the runner leaves it alone until it goes live.
        ctx.db.insert('accounts', { id: made.id, display_name: made.pack.meta.displayName, handle: made.pack.meta.handle, mode: 'approve', status: 'onboarding', workspace_id: r.workspace_id ?? null, created_at: nowIso(), updated_at: nowIso() });
        // Its days and times start at the default, which reaches the month's plan; the owner may change them before it goes live.
        saveChoice(ctx.db, made.id, DEFAULT_CHOICE, { actor: user.name });
        ctx.reloadPacks();
        ctx.db.update('onboarding', r.id, { status: 'samples', pack_id: made.id, candidates_json: { ...r.found, candidates }, updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', accountId: made.id, detail: { sources: candidates.filter((c) => c.approved).length } });
        return { ok: true, message: 'החשבון נוצר.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/samples$/,
      (ctx, _user, m) => {
        const r = row(ctx, m[1]);
        if (!r.pack_id) throw new ActionError('קודם יוצרים את החשבון');
        startSamples(ctx, r.id);
        return { ok: true, message: 'כותבים פוסטים לדוגמה.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/reviewed$/,
      (ctx, user, m) => {
        const r = row(ctx, m[1]);
        const n = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", r.pack_id).n;
        if (n < 5) throw new ActionError(`צריך חמש דוגמאות שעברו את הבדיקות, יש ${n}`);
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
        if (r.status !== 'ready') throw new ActionError('קודם עוברים על חמש הדוגמאות');
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

export const __onboarding = { running, progress };
