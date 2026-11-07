import { nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { setupRoom } from '../billing/setup-cap.js';
import { offered } from '../onboarding/discover.js';
import { DEEPER_ROUNDS, deeperBusy, deeperLine, deeperProgress, hostOf, lastRound, nextRound, startDeeper } from '../onboarding/deeper.js';
import { MODEL_KEY } from '../sources/model.js';
import { ActionError } from './actions.js';
import { owns } from './workspace.js';
import { csrfField, esc, icon, withSupport } from './ui.js';

// "לחפש מקורות חדשים" (src/onboarding/deeper.js), on the two pages where an account's sources are seen: the setup's
// sources step (src/web/onboarding.js, POST /new/<id>/deeper) and the Sources page (POST /sources/search, here). A
// press starts one round in the background; while it runs the panel says what it is doing (the poll the setup's own
// search uses, static/app.js data-poll), and the button's line says it in turn while the press is sent (data-wait, as
// the create button's); when it ends the page shows what it found, for the owner to keep or drop.

export const DEEPER_HE = {
  title: 'מקורות חדשים',
  lede: 'עוד חיפוש, רחב יותר מהקודם: אתרים שעוד לא בדקנו, נושאים קרובים ומה שהקהל שלכם קורא. זה לוקח כמה דקות, ואפשר לסגור את הדף בינתיים.',
  button: 'לחפש מקורות חדשים',
  wait: ['מתחילים לחפש', 'מחפשים אתרים חדשים', 'קוראים מקורות'],
  running: 'מחפשים מקורות חדשים. אפשר לסגור את הדף, החיפוש ממשיך.',
  none: 'בחיפוש האחרון לא מצאנו מקורות חדשים. החיפוש הבא רחב יותר.',
  cap: `חיפשנו כבר ${DEEPER_ROUNDS} פעמים, וזה המקסימום לחשבון אחד. אפשר להוסיף מקור בעצמכם, ואם צריך עוד, כתבו לנו.`,
  ready: 'המקורות החדשים מוכנים.',
  go: 'להציג',
};

/** What the last round found, as the panel says it: on the setup they join the list; on an account they wait for approval. */
const foundLine = (n, { account }) =>
  n ? `בחיפוש האחרון מצאנו ${n === 1 ? 'מקור חדש אחד' : `${n} מקורות חדשים`}. ${account ? 'הם למעלה, ומחכים שתאשרו או תסירו.' : 'הם ברשימה, עם התווית "חדש".'}` : DEEPER_HE.none;

/** The status the panel's poll asks for: { busy, key, line, ready, go }. `key` changes when a round starts or ends. */
export function deeperStatus(db, scope) {
  const busy = deeperBusy(scope);
  const rounds = lastRound(db, scope);
  return { busy, key: `${busy ? 'busy' : 'idle'}:${rounds?.n || 0}`, line: busy ? deeperLine(deeperProgress(scope)) : '', ready: DEEPER_HE.ready, go: DEEPER_HE.go };
}

/**
 * The panel: the button, or the round running, or what the last one found, or that every round was run. `action` is
 * where the press goes and `fields` what it sends; `poll` the status address and `href` where the page goes when the
 * round ends. `formId`: a form of its own outside the page's (the setup's sources step sits inside its create form),
 * the button tied to it by form=. `account`: on an account's Sources page (new sources are pending there).
 */
export function deeperPanel(pc, db, scope, { action, fields = {}, poll, href, formId = null, account = false } = {}) {
  const s = deeperStatus(db, scope);
  const last = lastRound(db, scope);
  const n = nextRound(db, scope);
  let body;
  if (s.busy) {
    body = `<div class="pollbox" data-poll="${esc(poll)}" data-key="${esc(s.key)}" data-href="${esc(href)}">
<p class="m0" data-progress aria-live="polite">${esc(s.line || DEEPER_HE.running)}</p>
<div class="banner info mt12" data-ready hidden>${icon('check')}<div><b data-ready-text>${esc(s.ready)}</b></div><a class="btn sm primary" href="${esc(href)}" data-ready-go>${esc(s.go)}</a></div>
<p class="small m6 js-hide"><a href="${esc(href)}">לבדוק שוב</a></p></div>`;
  } else if (!n) {
    body = `${last ? `<p class="muted m0">${esc(foundLine(last.found, { account }))}</p>` : ''}<p class="muted m0">${withSupport(DEEPER_HE.cap)}</p>`;
  } else {
    const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    const button = `<button class="btn" type="submit"${formId ? ` form="${esc(formId)}"` : ''}>${icon('spark')}${esc(DEEPER_HE.button)}</button>`;
    const wait = `<p class="stepwait muted small" role="status" aria-live="polite" data-wait="${esc(DEEPER_HE.wait.join('|'))}"></p>`;
    // Inside the page's own form the press is its own form's (form=), and the line under the button is found by its box
    // (static/app.js data-wait-box); on a page of its own, the form holds both.
    const press = formId ? `<div data-wait-box>${button}${wait}</div>` : `<form method="post" action="${esc(action)}">${csrfField(pc)}${hidden}${button}${wait}</form>`;
    body = `${last?.recent ? `<p class="m0">${esc(foundLine(last.found, { account }))}</p>` : ''}<p class="muted m0">${esc(DEEPER_HE.lede)}</p>${press}`;
  }
  return `<section class="panel" id="deeper"><header>${icon('spark')}<h2>${esc(DEEPER_HE.title)}</h2></header>${body}</section>`;
}

/** The form a panel inside another form presses (deeperPanel formId): placed outside that form. */
export const deeperForm = (pc, id, action, fields = {}) =>
  `<form method="post" action="${esc(action)}" id="${esc(id)}">${csrfField(pc)}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}</form>`;

/** What an account's search starts from: its setup's seed when it had one, else its pack. */
export function accountSeed(db, pack) {
  const ob = db.get('SELECT seed_json FROM onboarding WHERE pack_id = ? ORDER BY updated_at DESC LIMIT 1', pack.id);
  const seed = j(ob?.seed_json, null);
  if (seed?.niche) return seed;
  const m = pack.meta || {};
  return { niche: (m.topics || [])[0] || m.description || m.displayName, audience: m.audience || '', topics: m.topics || [], language: m.language || 'he', examples: [] };
}

/** The new sources of a round, added to an account as pending: the owner approves or removes each on the Sources page. */
export function keepForAccount(db, accountId, candidates) {
  const at = nowIso();
  let added = 0;
  for (const c of candidates.filter(offered)) {
    if (db.get('SELECT 1 FROM sources WHERE account_id = ? AND url = ?', accountId, c.url)) continue;
    const key = `found-${c.round || 0}-${hostOf(c.url).replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${(Date.now() + added).toString(36)}`;
    db.insert('sources', {
      account_id: accountId, key, type: c.type, url: c.url, name: String(c.name || hostOf(c.url)).slice(0, 120), lang: /[֐-׿]/.test(c.name || '') ? 'he' : 'en',
      why: [c.why, c.score?.reason].map((w) => String(w || '').trim()).find((w) => w.length >= 10) || 'נמצא בחיפוש מקורות חדשים',
      status: 'pending', origin: 'discovered', score_json: c.score || null, config_json: { api: c.api || null, hints: c.hints || null }, created_at: at,
    });
    added += 1;
  }
  return added;
}

/** What an account already has (every address, so none is offered again) and what its owner removed. */
export function accountKnown(db, accountId) {
  const rows = db.all('SELECT url, status FROM sources WHERE account_id = ? AND key <> ?', accountId, MODEL_KEY);
  return { known: rows.map((r) => r.url), dropped: [...new Set(rows.filter((r) => r.status === 'removed').map((r) => hostOf(r.url)).filter(Boolean))] };
}

/** The account a request names, if it is this session's. */
function accountOf(ctx, id) {
  const pack = ctx.pack(String(id || ''));
  if (!pack || !owns(ctx, pack.id)) throw new ActionError('אין חשבון כזה', 404);
  return pack;
}

const engine = (ctx) => ctx.global || ctx;

/** The Sources page's routes: the press, and the status its panel polls. */
export function deeperRoutes() {
  return [
    ['GET', /^\/sources\/search\/status$/, (ctx, _u, _m, q) => ({ json: deeperStatus(ctx.db, accountOf(ctx, q.account).id) })],
    [
      'POST',
      /^\/sources\/search$/,
      (ctx, user, _m, f) => {
        const pack = accountOf(ctx, f.account);
        const back = `/sources?account=${encodeURIComponent(pack.id)}#deeper`;
        if (deeperBusy(pack.id)) return { ok: true, message: DEEPER_HE.running, redirect: back };
        if (!nextRound(ctx.db, pack.id)) throw new ActionError(DEEPER_HE.cap, 409);
        const workspaceId = ctx.db.get('SELECT workspace_id FROM accounts WHERE id = ?', pack.id)?.workspace_id ?? null;
        // A paid step: before paying, under the setup's cap and counted against it (src/billing/setup-cap.js).
        if (!user.operator && !setupRoom(ctx.db, workspaceId).ok) throw new ActionError('החיפוש נפתח שוב אחרי ההפעלה.', 409);
        const e = engine(ctx);
        const { known, dropped } = accountKnown(ctx.db, pack.id);
        startDeeper(e, pack.id, { seed: accountSeed(ctx.db, pack), known, dropped, workspaceId, counts: !user.operator, log: e.log, keep: (res) => keepForAccount(e.db, pack.id, res.candidates) });
        audit(ctx.db, { actor: user.name, action: 'sources_search', accountId: pack.id, detail: { round: nextRound(ctx.db, pack.id) } });
        return { ok: true, message: 'מחפשים מקורות חדשים.', redirect: back };
      },
    ],
  ];
}
