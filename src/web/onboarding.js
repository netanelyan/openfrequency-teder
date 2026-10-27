import { newId, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { discover } from '../onboarding/discover.js';
import { createPack } from '../onboarding/pack.js';
import { buildPost, loadPost } from '../pipeline/build.js';
import { ActionError } from './actions.js';
import { postCard } from './pages.js';
import { connectData, connectPanel } from './connect.js';
import { accDot, csrfField, esc, icon, k, layout, postButton, stamp } from './ui.js';

// The new-account flow, on the website:
//
//   seed  ->  discovery (in the background)  ->  approve sources, name the account
//         ->  the pack is written (no code)  ->  5 sample posts to review
//         ->  live, in Approve mode
//
// Nothing goes live before five samples exist and the owner has looked at them.
//
// A new account is its workspace's: the one of the session that started it (src/web/workspace.js). Every route gets
// the request's context; the engine's work in the background (discovery, the pack, the samples) gets the engine's
// whole context, so a new account's look and handle are checked against every account on the server.

const STATUS_HE = { discovering: 'מחפש מקורות', review: 'לבחירת מקורות', failed: 'נכשל', samples: 'פוסטים לדוגמה', ready: 'מוכן לעלות', live: 'באוויר' };
const TERMS_HE = { ok: 'תנאים בסדר', check: 'לבדוק תנאי שימוש', no: 'אסור לשימוש' };
const TYPE_HE = { rss: 'פיד', web: 'דף', api: 'API' };
const running = new Map();

const engine = (ctx) => ctx.global || ctx;

const row = (ctx, id) => {
  const r = ctx.db.get('SELECT * FROM onboarding WHERE id = ?', id);
  if (!r || (ctx.workspaceId != null && r.workspace_id !== ctx.workspaceId)) throw new ActionError('אין תהליך כזה', 404);
  return { ...r, seed: j(r.seed_json, {}), found: j(r.candidates_json, {}), notes: j(r.notes_json, []) };
};

function startDiscovery(ctx, id) {
  if (running.has(id)) return;
  const r = row(ctx, id);
  ctx = engine(ctx);
  const job = discover(ctx, r.seed)
    .then((out) => ctx.db.update('onboarding', id, { status: 'review', candidates_json: { candidates: out.candidates, formats: out.formats }, notes_json: out.notes, updated_at: nowIso() }))
    .catch((e) => ctx.db.update('onboarding', id, { status: 'failed', notes_json: [String(e.message)], updated_at: nowIso() }))
    .finally(() => running.delete(id));
  running.set(id, job);
}

function startSamples(ctx, id) {
  if (running.has(id)) return;
  const r = row(ctx, id);
  ctx = engine(ctx);
  const pack = ctx.pack(r.pack_id);
  const job = (async () => {
    const notes = [];
    for (let i = 0; i < 5; i++) {
      const res = await buildPost(ctx, { pack, sample: true });
      if (res.status !== 'sample') notes.push(`פוסט ${i + 1}: ${res.reason}`);
    }
    const n = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", pack.id).n;
    if (n < 5 && ctx.mode === 'recorded') notes.push('המנוע במצב הקלטות: בלי ANTHROPIC_API_KEY אין מי שיכתוב פוסטים מהמקורות החדשים. עם מפתח, או עם הקלטות (npm run record), הפוסטים ייכתבו כאן.');
    ctx.db.update('onboarding', id, { status: 'samples', notes_json: [...r.notes, ...notes], updated_at: nowIso() });
  })()
    .catch((e) => ctx.db.update('onboarding', id, { notes_json: [...r.notes, String(e.message)], status: 'samples', updated_at: nowIso() }))
    .finally(() => running.delete(id));
  running.set(id, job);
}

function listPage(ctx, pc) {
  const rows = (ctx.workspaceId == null ? ctx.db.all('SELECT * FROM onboarding ORDER BY updated_at DESC LIMIT 20') : ctx.db.all('SELECT * FROM onboarding WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 20', ctx.workspaceId)).map((r) => ({ ...r, seed: j(r.seed_json, {}) }));
  return layout(
    { ...pc, title: 'חשבון חדש', active: 'new' },
    `<div class="head"><h1>חשבון חדש</h1><span class="sub">בוחרים נישה ודוגמאות, מאשרים מקורות, ומקבלים חמישה פוסטים לדוגמה.</span></div>
<div class="cols"><section class="panel"><header><h2>מתחילים מכאן</h2></header>
<p class="muted">המנוע מחפש אתרים שאפשר לסמוך עליהם (משרדי ממשלה, תיעוד רשמי, כלי תקשורת ותיקים), מוצא להם פידים ומקורות נתונים, בודק אילו פורמטים עובדים בנישה, ונותן לכל מקור ציון עם הסבר. מקור נכנס רק אחרי שאתם מאשרים אותו.</p>
<form method="post" action="/new" class="formgrid">${csrfField(pc)}
<label class="f">הנישה <small>בעברית, כמו שהייתם מתארים לחבר</small><input type="text" name="niche" required maxlength="80" placeholder="למשל: בישול טבעוני לסטודנטים"></label>
<label class="f">הנישה באנגלית <small>לחיפוש פורמטים ביוטיוב</small><input type="text" name="nicheEn" maxlength="80" dir="ltr"></label>
<label class="f">שפה<select name="language"><option value="he">עברית</option></select></label>
<label class="f">הקהל<input type="text" name="audience" maxlength="160" placeholder="מי קורא, ומה הוא רוצה"></label>
<label class="f">נושאים <small>מופרדים בפסיקים</small><input type="text" name="topics" maxlength="200"></label>
<label class="f">דוגמאות <small>אתרים (https://...) או חשבונות שאתם אוהבים, אחד בכל שורה</small><textarea name="examples" rows="4" dir="ltr"></textarea></label>
<button class="btn primary" type="submit">${icon('spark')}לחפש מקורות</button></form></section>
<section class="panel"><header><h2>בתהליך</h2></header>${rows.length ? `<ul class="factlist">${rows.map((r) => `<li><a href="/new/${esc(r.id)}"><b>${esc(r.seed.niche)}</b></a> <span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span> <span class="muted small">${esc(stamp(r.updated_at))}</span></li>`).join('')}</ul>` : '<p class="muted">אין עדיין.</p>'}</section></div>`
  );
}

function detailPage(ctx, pc, r) {
  const head = `<div class="head"><div><a class="muted small back" href="/new">${icon('chev')}חשבון חדש</a><h1>${esc(r.seed.niche)}</h1></div><span class="end"><span class="chip">${esc(STATUS_HE[r.status] || r.status)}</span></span></div>`;
  const notes = r.notes.length ? `<div class="banner info">${icon('alert')}<div><b>הערות מהחיפוש</b>${r.notes.slice(0, 8).map((n) => `<p>${esc(n)}</p>`).join('')}</div></div>` : '';
  if (r.status === 'discovering') {
    return layout({ ...pc, title: 'מחפש מקורות', active: 'new' }, `${head}<div class="empty">${icon('spark')}<b>מחפש מקורות</b>הדף יתרענן לבד. זה לוקח עד דקה.</div><meta http-equiv="refresh" content="3">`);
  }
  if (r.status === 'failed') return layout({ ...pc, title: 'נכשל', active: 'new' }, `${head}${notes}`);
  const cands = r.found.candidates || [];
  if (r.status === 'review') {
    return layout(
      { ...pc, title: 'בחירת מקורות', active: 'new' },
      `${head}${notes}
<form method="post" action="/new/${esc(r.id)}/create">${csrfField(pc)}
<div class="cols"><div class="grid12">${cands
        .map(
          (c) => `<article class="card srccard"><div class="meta p0"><label class="chip ghost"><input type="checkbox" name="approve_${esc(c.id)}"${c.score.authority >= 7 && c.score.terms !== 'no' ? ' checked' : ''}> לאשר</label><span class="chip ghost">${esc(TYPE_HE[c.type] || c.type)}</span><span class="chip ${c.score.authority >= 7 ? 'ok' : c.score.authority >= 5 ? '' : 'warn'}">סמכות ${c.score.authority}/10</span><span class="chip">עדכניות ${c.score.freshness}/10</span><span class="chip ${c.score.terms === 'ok' ? 'ok' : c.score.terms === 'no' ? 'bad' : 'warn'}">${esc(TERMS_HE[c.score.terms])}</span></div>
<h3 class="srcname" dir="auto">${esc(c.name)}</h3><a class="small ltr" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a>
<p class="muted small m6">${esc(c.score.reason)}${c.score.by === 'heuristic' ? ' · דירוג היוריסטי (בלי מפתח API)' : ''}</p>
<label class="f mt12">למה סומכים עליו<input type="text" dir="auto" name="why_${esc(c.id)}" value="${esc(c.why || c.score.reason)}" maxlength="300"></label></article>`
        )
        .join('') || `<div class="empty">${icon('sources')}<b>לא נמצאו מקורות</b>נסו דוגמאות של אתרים, או הגדירו BRAVE_API_KEY.</div>`}</div>
<div class="grid12"><section class="panel"><header><h2>שם לחשבון</h2></header><div class="formgrid">
<label class="f">שם החשבון<input type="text" name="displayName" required maxlength="40"></label>
<label class="f">שם המשתמש <small>אותיות לטיניות, ממנו נגזר מזהה החבילה</small><input type="text" name="handle" required maxlength="30" dir="ltr" pattern="@?[A-Za-z0-9._-]{2,30}"></label>
<p class="muted small">העיצוב, הצבעים והגופן נבחרים לבד, כך שהחשבון לא ייראה כמו אף חשבון אחר. הכל נשמר כקבצים בתיקייה הפרטית, ואפשר לשנות אחר כך.</p>
<button class="btn primary" type="submit">${icon('check')}ליצור את החבילה</button></div></section>
<section class="panel"><header><h2>פורמטים שעובדים בנישה</h2></header>${(r.found.formats || []).length ? `<ul class="factlist">${r.found.formats.map((f) => `<li><a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${k(f.views)} צפיות ${icon('ext')}</a> <span class="muted small" dir="auto">${esc(f.title)}</span></li>`).join('')}</ul>` : '<p class="muted">לא נבדק (בלי YOUTUBE_API_KEY).</p>'}</section></div></div></form>`
    );
  }
  const pack = ctx.pack(r.pack_id);
  const samples = ctx.db.all("SELECT id FROM posts WHERE account_id = ? AND sample = 1 ORDER BY created_at", r.pack_id).map((x) => loadPost(ctx.db, x.id));
  const good = samples.filter((p) => p.status === 'sample').length;
  const busy = running.has(r.id);
  const reviewed = r.status === 'ready';
  return layout(
    { ...pc, title: 'פוסטים לדוגמה', active: 'new' },
    `${head}${notes}
<section class="panel"><header>${accDot(r.pack_id)}<h2>${esc(pack?.meta.displayName || r.pack_id)}</h2><span class="end muted small ltr">@${esc(pack?.meta.handle || '')}</span></header>
<p class="muted">החבילה נכתבה לתיקייה הפרטית (${esc(r.pack_id)}). החשבון לא יעלה לאוויר לפני שיש חמישה פוסטים לדוגמה ועברתם עליהם. פוסט לדוגמה לא מתפרסם, גם אחרי שהחשבון באוויר.</p>
<div class="actions p0">${busy ? `<span class="chip warn">${icon('clock')}כותב פוסטים לדוגמה, הדף יתרענן</span><meta http-equiv="refresh" content="4">` : postButton(pc, `/new/${r.id}/samples`, `${icon('spark')}${samples.length ? 'עוד פוסטים לדוגמה' : 'ליצור 5 פוסטים לדוגמה'}`, { cls: 'btn' })}
${good >= 5 && !reviewed && r.status !== 'live' ? postButton(pc, `/new/${r.id}/reviewed`, `${icon('check')}עברתי על הדוגמאות`, { cls: 'btn' }) : ''}
${reviewed ? postButton(pc, `/new/${r.id}/live`, `${icon('power')}להעלות לאוויר, במצב אישור`, { cls: 'btn primary', confirm: 'לחצו שוב כדי להעלות לאוויר' }) : ''}
${r.status === 'live' ? '<span class="chip ok">באוויר</span>' : ''}</div>
<p class="muted small mt12">${good} מתוך 5 דוגמאות עברו את כל הבדיקות.</p>
${pack ? `<p class="muted mt12">כדי שהפוסטים יגיעו לטיקטוק ולאינסטגרם, מחברים כאן את החשבונות. אפשר לעשות את זה גם אחרי שהחשבון באוויר, מדף החשבון.</p>${connectPanel(pc, connectData(ctx, pack))}` : ''}</section>
<div class="posts mt16">${samples.map((p) => postCard(pc, p, pack)).join('')}</div>`
  );
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
        if (niche.length < 2) throw new ActionError('צריך לכתוב את הנישה');
        const id = newId('o');
        const seed = { niche, nicheEn: String(f.nicheEn || '').trim(), language: 'he', audience: String(f.audience || '').trim(), topics: String(f.topics || '').split(/[,،]/).map((x) => x.trim()).filter(Boolean), examples: String(f.examples || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 10) };
        ctx.db.insert('onboarding', { id, seed_json: seed, status: 'discovering', workspace_id: ctx.workspaceId ?? null, created_at: nowIso(), updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', detail: { niche } });
        startDiscovery(ctx, id);
        return { ok: true, message: 'מחפש מקורות.', redirect: `/new/${id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/create$/,
      async (ctx, user, m, f) => {
        const r = row(ctx, m[1]);
        const candidates = (r.found.candidates || []).map((c) => ({ ...c, approved: f[`approve_${c.id}`] === 'on', why: String(f[`why_${c.id}`] || c.why || c.score?.reason || '').trim() }));
        let made;
        try {
          made = await createPack(engine(ctx), { seed: r.seed, candidates, displayName: f.displayName, handle: f.handle, examplesFromOwner: r.seed.examples });
        } catch (e) {
          // Pack ids are the server's, so a handle another workspace has is refused without naming whose it is.
          if (/already exists/.test(e.message)) throw new ActionError('שם המשתמש הזה כבר תפוס. בחרו שם אחר.');
          throw new ActionError([e.message, ...(e.problems || [])].join(' · '));
        }
        // The account starts in onboarding: the runner leaves it alone until it goes live.
        ctx.db.insert('accounts', { id: made.id, display_name: made.pack.meta.displayName, handle: made.pack.meta.handle, mode: 'approve', status: 'onboarding', workspace_id: r.workspace_id ?? null, created_at: nowIso(), updated_at: nowIso() });
        ctx.reloadPacks();
        ctx.db.update('onboarding', r.id, { status: 'samples', pack_id: made.id, candidates_json: { ...r.found, candidates }, updated_at: nowIso() });
        audit(ctx.db, { actor: user.name, action: 'onboarding', accountId: made.id, detail: { sources: candidates.filter((c) => c.approved).length } });
        return { ok: true, message: 'החבילה נוצרה.', redirect: `/new/${r.id}` };
      },
    ],
    [
      'POST',
      /^\/new\/([\w-]+)\/samples$/,
      (ctx, _user, m) => {
        const r = row(ctx, m[1]);
        if (!r.pack_id) throw new ActionError('קודם יוצרים את החבילה');
        startSamples(ctx, r.id);
        return { ok: true, message: 'כותב פוסטים לדוגמה.', redirect: `/new/${r.id}` };
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

export const __onboarding = { running };
