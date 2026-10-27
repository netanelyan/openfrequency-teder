import { monthKey, now, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { TIKTOK_MODES } from '../packs/validate.js';
import { setPackPublishing } from '../packs/write.js';
import { tiktokMode, wantedPublisher } from '../publish/index.js';
import { OWN_APP } from '../publish/tiktok-app.js';
import { zernioConfigured } from '../publish/zernio.js';
import { GONE, connectLink, connectLinkOk, connectState, doneLink, doneLinkOk, refreshConnections, startConnect, zernioCost } from '../publish/connect.js';
import { ActionError } from './actions.js';
import { connectErrorHe } from '../publish/errors.js';
import { csrfField, esc, icon, postButton, tederMark, usd } from './ui.js';

// Connecting a customer's TikTok and Instagram (src/publish/connect.js), on the website:
//
//   - the account page and the onboarding page show each platform's state with a button. The button is a POST (a
//     session, the CSRF token, a workspace that owns the account): Teder asks Zernio for a fresh link and the browser
//     goes straight there.
//   - /connect/<account>/<platform>?e=&s= is the link the WhatsApp assistant hands on, and needs no session: its
//     signature is the permission, for that account and platform, for 72 hours.
//   - /connect/<account>/<platform>/done?e=&s= is where Zernio sends the browser back. It needs no session either (the
//     customer may have connected on their phone) and believes nothing in its address but the signature: what is
//     connected is read from Zernio there and then.

export const PLATFORM_NAME = { tiktok: 'טיקטוק', instagram: 'אינסטגרם' };
const STATE_CHIP = {
  connected: ['ok', 'מחובר'],
  reconnect: ['warn', 'צריך לחבר מחדש'],
  none: ['ghost', 'לא מחובר'],
  meta: ['ok', 'מחובר דרך Meta'],
};
const MODE_CHOICE = {
  'draft-now': ['לטיוטות בטיקטוק', 'מוסיפים סאונד טרנדי באפליקציה ומפרסמים משם'],
  direct: ['ישר לפרופיל', 'עולה בשעה שלו, ציבורי, עם מוזיקה מהספרייה של טיקטוק'],
  'draft-fallback': ['טיוטה, ואם לא פורסמה תוך שעה עולה לבד', 'עם מוזיקה מהספרייה של טיקטוק'],
};

/* ------------------------------------------------------------------ the panel */

/**
 * What each platform needs, said before its button, for the platforms still to connect: Instagram connects only as a
 * professional account (business or creator), as Zernio requires; TikTok any account the customer logs into, and in
 * draft-now its posts land in TikTok's drafts on purpose, for the owner to add a popular sound and post.
 */
export function requirements(d) {
  const open = d.platforms.filter((s) => s.state !== 'meta' && s.state !== 'connected').map((s) => s.platform);
  const lines = [];
  if (open.includes('instagram')) lines.push('אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר. חשבון פרטי מעבירים לחשבון מקצועי בהגדרות של אינסטגרם, בלי תשלום, ואז מחברים כאן.');
  if (open.includes('tiktok')) {
    lines.push('בטיקטוק נכנסים עם החשבון שאליו המצגות יעלו, ומאשרים את ההרשאות במסך של טיקטוק.');
    if (d.mode === 'draft-now') lines.push('המצגות מגיעות לטיוטות בטיקטוק בכוונה, כדי שתבחרו סאונד פופולרי ותפרסמו משם. כשמגיעה השעה, תדר מזכיר לכם.');
  }
  return lines.length ? `<ul class="needs muted small">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
}

/**
 * Each platform's state and its button, for the account page and the onboarding page. `d` is connectData's.
 */
export function connectPanel(ctx, d) {
  const { pack } = d;
  const rows = d.platforms
    .map((s) => {
      const [cls, he] = STATE_CHIP[s.state];
      const name = PLATFORM_NAME[s.platform] || s.platform;
      const action = `/accounts/${pack.id}/connect/${s.platform}`;
      const button =
        s.state === 'meta' || !d.configured
          ? ''
          : s.state === 'none'
            ? postButton(ctx, action, `${icon('plus')}לחבר את ${name}`, { cls: 'btn sm primary' })
            : s.state === 'reconnect'
              ? postButton(ctx, action, `לחבר מחדש את ${name}`, { cls: 'btn sm primary' })
              : postButton(ctx, action, 'לחבר חשבון אחר', { cls: 'btn sm ghost' });
      return `<li><b>${esc(name)}</b> <span class="chip ${cls}">${esc(he)}</span>${s.username ? ` <span class="ltr muted">@${esc(s.username)}</span>` : ''}${s.state === 'reconnect' && s.issue ? (s.issue === GONE ? `<div class="muted small">החשבון כבר לא מחובר ל-Zernio, ופוסטים לא מגיעים ל${esc(name)} עד שמחברים אותו שוב.</div>` : `<div class="muted small ltr">${esc(s.issue)}</div>`) : ''}${button ? `<div class="actions p0 m6">${button}</div>` : ''}</li>`;
    })
    .join('');
  const note = d.configured
    ? 'החיבור עובר דרך Zernio, השירות שמפרסם בשבילנו. נפתח מסך של טיקטוק או של אינסטגרם, מאשרים שם וחוזרים לכאן.'
    : ctx.operator
      ? 'אי אפשר לחבר עכשיו: בשרת לא מוגדר ZERNIO_API_KEY.'
      : 'החיבור עוד לא זמין בשרת הזה.';
  return `<div class="connect" id="connect-${esc(pack.id)}"><div class="row"><span>טיקטוק ואינסטגרם</span>${d.configured && d.hasProfile ? `<span class="end">${postButton(ctx, `/accounts/${pack.id}/connections`, 'לבדוק שוב', { cls: 'btn sm ghost' })}</span>` : ''}</div>
${d.configured ? requirements(d) : ''}<ul class="factlist">${rows}</ul><p class="muted small m0">${esc(note)}</p>${ctx.operator && d.zernio != null ? `<p class="muted small m0">Zernio החודש: ${usd(d.zernio.usd)}</p>` : ''}</div>`;
}

/** How the account's TikTok posts go out, and (the operator) through what. */
export function tiktokModePanel(ctx, d) {
  if (!d.pack.meta.platforms.includes('tiktok')) return '';
  const id = esc(d.pack.id);
  const modes = ['draft-now', 'direct', ...(d.mode === 'draft-fallback' ? ['draft-fallback'] : [])];
  const choice = modes.map((m) => `<input type="radio" name="mode" value="${m}" id="tt-${id}-${m}"${d.mode === m ? ' checked' : ''}><label for="tt-${id}-${m}">${esc(MODE_CHOICE[m][0])}<small>${esc(MODE_CHOICE[m][1])}</small></label>`).join('');
  const via = ctx.operator
    ? `<label class="f m6">דרך מה מפרסמים לטיקטוק<select name="via"><option value="zernio"${d.via !== OWN_APP ? ' selected' : ''}>Zernio</option><option value="${OWN_APP}"${d.via === OWN_APP ? ' selected' : ''}>האפליקציה שלנו בטיקטוק (עוד לא קיימת, הפוסטים נכתבים לדיסק)</option></select></label>`
    : '';
  return `<form method="post" action="/accounts/${id}/tiktok">${csrfField(ctx)}<div class="row"><span>איך פוסטים עולים לטיקטוק</span></div><div class="seg" role="radiogroup" aria-label="איך פוסטים עולים לטיקטוק">${choice}</div>${via}<div class="actions p0 m6"><button class="btn sm" type="submit">שמירה</button></div></form>`;
}

/** What the panels read, for one account. */
export function connectData(ctx, pack, { t = now(), env = process.env } = {}) {
  return {
    pack,
    configured: zernioConfigured(),
    hasProfile: Boolean(ctx.db.get('SELECT zernio_profile_id AS id FROM accounts WHERE id = ?', pack.id)?.id || pack.meta.zernio?.profileId),
    platforms: pack.meta.platforms.map((p) => connectState(ctx.db, pack, p, env)),
    mode: tiktokMode(pack),
    via: wantedPublisher(pack, 'tiktok'),
    zernio: zernioCost(ctx.db, pack.id, monthKey(t)),
  };
}

/* ------------------------------------------------------------------ the buttons (session routes) */

const mustPack = (ctx, id) => {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  return pack;
};

/**
 * The routes with a session, for server.js ROUTES. `links()` is { base, secret }: where Zernio sends the browser back,
 * and what the return address is signed with.
 */
export function connectRoutes(links) {
  return [
    [
      'POST',
      /^\/accounts\/([\w-]+)\/connect\/(tiktok|instagram)$/,
      async (ctx, user, m) => {
        const pack = mustPack(ctx, m[1]);
        if (!zernioConfigured()) throw new ActionError('החיבור עוד לא זמין בשרת הזה.');
        const { base, secret } = links();
        let url;
        try {
          url = await startConnect(ctx.db, pack, m[2], { doneUrl: doneLink(secret, { base, accountId: pack.id, platform: m[2] }), actor: user.name });
        } catch (e) {
          if (e.code === 'not_connectable') throw new ActionError(`${PLATFORM_NAME[m[2]]} לא צריך חיבור בחשבון הזה.`);
          ctx.log?.(`[connect] ${pack.id} ${m[2]}: ${e.message}`);
          throw new ActionError('Zernio לא ענה, ואי אפשר לפתוח עכשיו את מסך החיבור. נסו שוב בעוד כמה דקות.', 502);
        }
        return { ok: true, message: `עוברים ל${PLATFORM_NAME[m[2]]}`, go: url, goName: PLATFORM_NAME[m[2]] };
      },
    ],
    [
      'POST',
      /^\/accounts\/([\w-]+)\/connections$/,
      async (ctx, _user, m) => {
        const pack = mustPack(ctx, m[1]);
        if (!zernioConfigured()) throw new ActionError('החיבור עוד לא זמין בשרת הזה.');
        try {
          await refreshConnections(ctx.db, pack);
        } catch (e) {
          ctx.log?.(`[connect] ${pack.id}: ${e.message}`);
          throw new ActionError('Zernio לא ענה. נסו שוב בעוד כמה דקות.', 502);
        }
        return { ok: true, message: 'החיבורים עודכנו מ-Zernio.' };
      },
    ],
    [
      'POST',
      /^\/accounts\/([\w-]+)\/tiktok$/,
      (ctx, user, m, f) => {
        const pack = mustPack(ctx, m[1]);
        const mode = String(f.mode || '');
        if (!TIKTOK_MODES.includes(mode)) throw new ActionError('אפשרות לא מוכרת');
        // Straight to the profile is public: a private direct post is one nobody sees.
        const patch = { tiktokMode: mode, ...(mode === 'direct' ? { tiktokPrivacy: 'PUBLIC_TO_EVERYONE' } : {}) };
        if (user.operator && f.via) {
          if (!['zernio', OWN_APP].includes(f.via)) throw new ActionError('אפשרות לא מוכרת');
          patch.tiktokPublisher = f.via;
        }
        setPackPublishing(pack, patch);
        audit(ctx.db, { actor: user.name, action: 'tiktok_mode', accountId: pack.id, detail: patch });
        return { ok: true, message: mode === 'direct' ? 'מעכשיו פוסטים עולים ישר לפרופיל בטיקטוק.' : 'מעכשיו פוסטים מגיעים לטיוטות בטיקטוק.' };
      },
    ],
  ];
}

/* ------------------------------------------------------------------ the two doors without a session */

function resultPage({ title, text, actions = '', v = 1 }) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"><link rel="icon" href="/static/icon.svg?v=${v}" type="image/svg+xml"></head>
<body class="login"><main class="card">
<div class="hero">${tederMark()}<b>תדר</b></div>
<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
${actions ? `<div class="links">${actions}</div>` : ''}</main></body></html>`;
}

/**
 * The page a connect button answers with: on to Zernio's link at once. A page, not a redirect: the site's CSP keeps
 * form submissions on our own origin (form-action 'self'), redirects included, and Zernio is not ours.
 */
export function goPage(url, { name = '', v = 1 } = {}) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${esc(url)}"><title>עוברים ל${esc(name)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"></head>
<body class="login"><main class="card"><div class="hero">${tederMark()}<b>תדר</b></div><h1>עוברים ל${esc(name)}</h1><p>אם הדף לא עובר לבד, אפשר ללחוץ כאן.</p><div class="links"><a class="btn primary" href="${esc(url)}" rel="noreferrer">להמשיך</a></div></main></body></html>`;
}

const EXPIRED = { title: 'הלינק הזה כבר לא בתוקף', text: 'לינק לחיבור עובד 72 שעות. אפשר לבקש לינק חדש בוואטסאפ, או לחבר מדף החשבון באתר.' };

/**
 * GET /connect/<account>/<platform>[/done]: [status, html, location?]. `ctx` is the engine's (no session, so no
 * workspace): the signature names the account. `links` is { base, secret }.
 */
export async function publicConnect(ctx, { account, platform, done, query, links, t = now() }) {
  const { base, secret } = links;
  const pack = ctx.pack(account);
  const sig = { accountId: account, platform, e: query.get('e'), s: query.get('s'), t };
  if (!pack || !(done ? doneLinkOk(secret, sig) : connectLinkOk(secret, sig))) return [404, resultPage(EXPIRED)];
  const name = PLATFORM_NAME[platform];
  if (!zernioConfigured()) return [503, resultPage({ title: 'החיבור לא זמין כרגע', text: 'בשרת הזה עוד לא הוגדר Zernio.' })];
  const again = () => `<a class="btn primary" href="${esc(connectLink(secret, { base, accountId: pack.id, platform, t }))}">לנסות שוב</a>`;

  if (!done) {
    try {
      const url = await startConnect(ctx.db, pack, platform, { doneUrl: doneLink(secret, { base, accountId: pack.id, platform, t }), actor: 'whatsapp link' });
      return [302, '', url];
    } catch (e) {
      if (e.code === 'not_connectable') return [200, resultPage({ title: `${name} כבר מחובר`, text: `${name} של ${pack.meta.displayName} מחובר דרך Meta, ואין פה מה לחבר.` })];
      ctx.log?.(`[connect] ${pack.id} ${platform}: ${e.message}`);
      return [502, resultPage({ title: 'Zernio לא ענה', text: 'אי אפשר לפתוח עכשיו את מסך החיבור. נסו שוב בעוד כמה דקות.', actions: again() })];
    }
  }

  // Back from Zernio. Its error says what went wrong in its own words; what is connected is read from Zernio itself.
  const error = query.get('error');
  if (error) {
    audit(ctx.db, { actor: 'zernio', action: 'zernio_connect_failed', accountId: pack.id, detail: { platform, error, reason: query.get('error_message') || null, request: query.get('request_id') || null } });
    // Zernio's code stays in the audit and the log; the customer reads what it means and what to do.
    ctx.log?.(`[connect] ${pack.id} ${platform}: Zernio returned ${error}${query.get('error_message') ? ` (${query.get('error_message')})` : ''}`);
    const text = connectErrorHe(platform, { error: error === 'oauth_denied' ? 'denied' : error, message: query.get('error_message') || '', fixable: query.get('is_user_fixable') === 'true' });
    return [200, resultPage({ title: 'החיבור לא הצליח', text, actions: again() })];
  }
  try {
    const prefer = query.get('accountId') ? { [platform]: query.get('accountId') } : {};
    await refreshConnections(ctx.db, pack, { t, prefer });
  } catch (e) {
    ctx.log?.(`[connect] ${pack.id} ${platform} done: ${e.message}`);
    return [200, resultPage({ title: 'עוד רגע', text: 'החיבור נשלח, אבל Zernio עוד לא ענה מה חובר. תוך שעה זה יופיע בדף החשבון.' })];
  }
  const s = connectState(ctx.db, pack, platform);
  if (s.state !== 'connected') return [200, resultPage({ title: 'החיבור לא הושלם', text: `Zernio לא רואה ${name} מחובר ל-${pack.meta.displayName}. אפשר לנסות שוב.`, actions: again() })];
  ctx.db.update('accounts', pack.id, { updated_at: nowIso() });
  return [200, resultPage({ title: `${name} מחובר`, text: `${s.username ? `@${s.username}` : `החשבון ב${name}`} מחובר עכשיו ל-${pack.meta.displayName}. אפשר לסגור את הדף.` })];
}

