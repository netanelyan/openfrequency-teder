import { monthKey, now, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { TIKTOK_MODES } from '../packs/validate.js';
import { setPackPublishing } from '../packs/write.js';
import { tiktokMode, wantedPublisher } from '../publish/index.js';
import { isCustomerAccount } from '../autonomy/rails.js';
import { OWN_APP } from '../publish/tiktok-app.js';
import { zernioConfigured } from '../publish/zernio.js';
import { GONE, carryOnboardingZernio, connectLink, connectLinkOk, connectState, doneLink, doneLinkOk, holdPick, onboardingDoneLinkOk, profileIdOf, refreshConnections, refreshOnboardingConnections, selectionOf, startConnect, takePick, zernioCost } from '../publish/connect.js';
import { setupOf } from '../onboarding/setup.js';
import { facebookPages, instagramPages, selectFacebookPage, selectInstagram } from '../publish/zernio.js';
import { j } from '../db/index.js';
import { ActionError } from './actions.js';
import { connectErrorHe } from '../publish/errors.js';
import { a11yLink, csrfField, esc, icon, postButton, tederMark, usd } from './ui.js';

// Connecting a customer's TikTok, Instagram and Facebook Page (src/publish/connect.js), on the website:
//
//   - the account page and the onboarding page show each platform's state with a button. The button is a POST (a
//     session, the CSRF token, a workspace that owns the account): Teder asks Zernio for a fresh link and the browser
//     goes straight there.
//   - /connect/<account>/<platform>?e=&s= is the link the WhatsApp assistant hands on, and needs no session: its
//     signature is the permission, for that account and platform, for 72 hours.
//   - /connect/<account>/<platform>/done?e=&s= is where Zernio sends the browser back. It needs no session either (the
//     customer may have connected on their phone) and believes nothing in its address but the signature: what is
//     connected is read from Zernio there and then.
//   - before the account exists, the onboarding page has the same panel, its buttons under /new/<onboarding>, and
//     Zernio sends the browser back to /new/<onboarding>/connect/<platform>/done?e=&s= (publicOnboardingConnect), on
//     the same terms.
//   - the connect is headless (src/publish/zernio.js connectUrl): no Zernio welcome screen or picker. TikTok and
//     Instagram connect at once. An Instagram that comes back through Facebook Login needs an account picked: with one
//     on offer it is picked by itself, with several our own page lists them, each a link to /connect/pick/<id>?page=,
//     the id a pick kept on the server (src/publish/connect.js holdPick), good once and for 15 minutes. A Facebook
//     Page always comes back that way (Zernio posts to a Page, never to a profile): one Page the customer manages is
//     connected by itself, several are listed on the same page.

export const PLATFORM_NAME = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
// Names in a row, as Hebrew writes them: טיקטוק, אינסטגרם ופייסבוק.
export const heList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names.at(-1)}`);
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
 * draft-now its posts land in TikTok's drafts on purpose, for the owner to add a popular sound and post; Facebook a Page
 * they manage, never a personal profile, and it is optional while the account posts elsewhere.
 */
export function requirements(d) {
  const open = d.platforms.filter((s) => s.state !== 'meta' && s.state !== 'connected').map((s) => s.platform);
  const lines = [];
  if (open.length) lines.push('בחיבור מאשרים את Zernio, השירות שמפרסם בשבילנו.');
  if (open.includes('instagram')) lines.push('אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר. חשבון פרטי מעבירים לחשבון מקצועי בהגדרות של אינסטגרם, בלי תשלום, ואז מחברים כאן.');
  if (open.includes('tiktok')) {
    lines.push('בטיקטוק נכנסים עם החשבון שאליו המצגות יעלו, ומאשרים את ההרשאות במסך של טיקטוק.');
    if (d.mode === 'draft-now') lines.push('המצגות מגיעות לטיוטות בטיקטוק בכוונה, כדי שתבחרו סאונד פופולרי ותפרסמו משם. כשמגיעה השעה, תדר מזכיר לכם.');
  }
  if (open.includes('facebook')) {
    const others = d.platforms.map((s) => s.platform).filter((p) => p !== 'facebook');
    lines.push(`בפייסבוק מחברים עמוד של העסק שאתם מנהלים. פרופיל אישי אי אפשר לחבר.${others.length ? ` אם לא מחברים עמוד, המצגות עולות רק ל${others.map((p) => PLATFORM_NAME[p] || p).join(' ול')}.` : ''}`);
  }
  return lines.length ? `<ul class="needs muted small">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
}

/**
 * Each platform's state and its button, for the account page and the onboarding page. `d` is connectData's (or the
 * onboarding's, src/web/onboarding.js). `base` is where the buttons post: the account's, or the onboarding's before
 * the account exists.
 */
export function connectPanel(ctx, d, { base = null } = {}) {
  const { pack } = d;
  const at = base || `/accounts/${pack.id}`;
  const rows = d.platforms
    .map((s) => {
      const [cls, he] = STATE_CHIP[s.state];
      const name = PLATFORM_NAME[s.platform] || s.platform;
      const action = `${at}/connect/${s.platform}`;
      const button =
        s.state === 'meta' || !d.configured
          ? ''
          : s.state === 'none'
            ? postButton(ctx, action, `${icon('plus')}לחבר את ${name}`, { cls: 'btn sm primary' })
            : s.state === 'reconnect'
              ? postButton(ctx, action, `לחבר מחדש את ${name}`, { cls: 'btn sm primary' })
              : postButton(ctx, action, 'לחבר חשבון אחר', { cls: 'btn sm ghost' });
      return `<li><b>${esc(name)}</b> <span class="chip ${cls}">${esc(he)}</span>${s.username ? ` <span class="ltr muted">@${esc(s.username)}</span>` : ''}${s.state === 'reconnect' && s.issue ? (s.issue === GONE ? `<div class="muted small">החיבור ל${esc(name)} התנתק, ופוסטים לא מגיעים לשם עד שמחברים שוב.</div>` : ctx.operator ? `<div class="muted small ltr">${esc(s.issue)}</div>` : `<div class="muted small">${esc(name)} ביקש לאשר את החיבור מחדש. עד אז פוסטים לא מגיעים לשם.</div>`) : ''}${button ? `<div class="actions p0 m6">${button}</div>` : ''}</li>`;
    })
    .join('');
  const note = d.configured
    ? 'נפתח המסך של הרשת, מאשרים שם וחוזרים לכאן.'
    : ctx.operator
      ? 'אי אפשר לחבר עכשיו: בשרת לא מוגדר ZERNIO_API_KEY.'
      : 'החיבור עוד לא זמין בשרת הזה.';
  return `<div class="connect" id="connect-${esc(pack.id)}"><div class="row"><span>${esc(heList(d.platforms.map((s) => PLATFORM_NAME[s.platform] || s.platform)))}</span>${d.configured && d.hasProfile ? `<span class="end">${postButton(ctx, `${at}/connections`, 'לבדוק שוב', { cls: 'btn sm ghost' })}</span>` : ''}</div>
${d.configured ? requirements(d) : ''}<ul class="factlist">${rows}</ul><p class="muted small m0">${esc(note)}</p>${ctx.operator && d.zernio != null ? `<p class="muted small m0">Zernio החודש: ${usd(d.zernio.usd)}</p>` : ''}</div>`;
}

/**
 * How the account's TikTok posts go out, and (the operator) through what. A customer's TikTok always lands in the app's
 * drafts (src/publish/index.js tiktokMode): they read that in one line, with no choice to make. The operator chooses
 * for the company's own accounts, and sees a customer's as fixed.
 */
export function tiktokModePanel(ctx, d) {
  if (!d.pack.meta.platforms.includes('tiktok')) return '';
  if (!ctx.operator || d.customer) {
    const line = 'המצגות מגיעות לטיוטות בטיקטוק. בוחרים שם סאונד פופולרי ומפרסמים מהאפליקציה, ותדר מזכיר לכם כשמגיעה השעה.';
    return `<div class="row"><span>איך פוסטים עולים לטיקטוק</span></div><p class="muted small m0">${esc(line)}${ctx.operator ? ' (חשבון של לקוח: תמיד לטיוטות.)' : ''}</p>`;
  }
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
    mode: tiktokMode(pack, ctx.db),
    customer: isCustomerAccount(ctx.db, pack.id),
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
      /^\/accounts\/([\w-]+)\/connect\/(tiktok|instagram|facebook)$/,
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
          throw new ActionError('אי אפשר לפתוח עכשיו את מסך החיבור. נסו שוב בעוד כמה דקות.', 502);
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
          throw new ActionError('לא הצלחנו לבדוק את החיבורים עכשיו. נסו שוב בעוד כמה דקות.', 502);
        }
        return { ok: true, message: 'החיבורים נבדקו ועודכנו.' };
      },
    ],
    [
      'POST',
      /^\/accounts\/([\w-]+)\/tiktok$/,
      (ctx, user, m, f) => {
        const pack = mustPack(ctx, m[1]);
        const mode = String(f.mode || '');
        if (!TIKTOK_MODES.includes(mode)) throw new ActionError('אפשרות לא מוכרת');
        // Straight to the profile, and draft-fallback's publish at an hour, are the operator's, on the company's own
        // accounts: a customer's TikTok always goes to the app's drafts (src/publish/index.js tiktokMode).
        if (mode !== 'draft-now' && (!user.operator || isCustomerAccount(ctx.db, pack.id))) {
          throw new ActionError(user.operator ? 'בחשבון של לקוח המצגות תמיד מגיעות לטיוטות בטיקטוק.' : 'המצגות מגיעות לטיוטות בטיקטוק, ומשם מפרסמים אותן. זה לא משתנה.', 403);
        }
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
${actions ? `<div class="links">${actions}</div>` : ''}<p class="a11y-foot">${a11yLink()}</p></main></body></html>`;
}

/**
 * The page a connect button answers with: on to Zernio's link at once. A page, not a redirect: the site's CSP keeps
 * form submissions on our own origin (form-action 'self'), redirects included, and Zernio is not ours.
 */
export function goPage(url, { name = '', v = 1 } = {}) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${esc(url)}"><title>עוברים ל${esc(name)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"></head>
<body class="login"><main class="card"><div class="hero">${tederMark()}<b>תדר</b></div><h1>עוברים ל${esc(name)}</h1><p>אם הדף לא עובר לבד, אפשר ללחוץ כאן.</p><div class="links"><a class="btn primary" href="${esc(url)}" rel="noreferrer">להמשיך</a></div><p class="a11y-foot">${a11yLink()}</p></main></body></html>`;
}

const EXPIRED = { title: 'הלינק הזה כבר לא בתוקף', text: 'לינק לחיבור עובד 72 שעות. אפשר לבקש לינק חדש בוואטסאפ, או לחבר מדף החשבון באתר.' };

/** The page that lists the Instagram accounts (or Facebook Pages) to pick from, each a link that connects it. */
function pickerPage(pages, id, { who = '', platform = 'instagram' } = {}) {
  const fb = platform === 'facebook';
  // A Page is known by its name (its @username is optional); an Instagram account by its @username.
  const label = (p) => (fb ? `<bdi dir="auto">${esc(p.name || p.username)}</bdi>${p.name && p.username ? ` <small dir="ltr">@${esc(p.username)}</small>` : ''}` : `<bdi dir="ltr">@${esc(p.username || p.name)}</bdi>${p.name && p.username ? ` <small>${esc(p.name)}</small>` : ''}`);
  const links = pages.map((p) => `<a class="btn" href="/connect/pick/${esc(id)}?page=${esc(encodeURIComponent(p.pageId))}">${label(p)}</a>`).join('');
  const text = fb ? 'מצאנו כמה עמודים שאתם מנהלים. בוחרים את העמוד שאליו המצגות יעלו.' : 'מצאנו כמה חשבונות אינסטגרם מקצועיים. בוחרים את החשבון שאליו המצגות יעלו.';
  return resultPage({ title: fb ? 'איזה עמוד פייסבוק לחבר?' : 'איזה חשבון אינסטגרם לחבר?', text: `${who ? `${who}, ` : ''}${text}`, actions: links });
}

const NO_IG = { title: 'לא מצאנו חשבון אינסטגרם מקצועי', text: 'לא מצאנו עמוד פייסבוק שמחובר אליו חשבון אינסטגרם מקצועי. אפשר להעביר את החשבון לחשבון מקצועי בהגדרות של אינסטגרם, ולחבר שוב.' };
const NO_FB = { title: 'לא מצאנו עמוד פייסבוק', text: 'לא מצאנו עמוד פייסבוק שאתם מנהלים ויכולים לפרסם בו. אפשר לפרסם רק בעמוד, לא בפרופיל אישי. פותחים עמוד לעסק בפייסבוק, או מבקשים ממי שמנהל את העמוד הרשאה לפרסם בו, ומחברים שוב.' };

/** Each platform's pick: the list of what can be picked, and connecting the one picked. */
const PICKS = {
  instagram: { list: instagramPages, select: selectInstagram, none: NO_IG },
  facebook: { list: facebookPages, select: selectFacebookPage, none: NO_FB },
};

/**
 * A headless return that needs an account picked: { page } (a page to show: the picker, or why there is nothing to
 * pick), { prefer } (one account on offer, connected by itself), or null when there is nothing to pick. `target` is
 * { kind: 'account' | 'onboarding', id, profileId }: the profile is ours, never the one in the address.
 */
async function selection(ctx, { target, platform, query, actions, t }) {
  const sel = selectionOf(query);
  if (!sel) return null;
  // Instagram through Facebook Login picks an account, a Facebook connect picks a Page: each only on its own return. A
  // Page's pick needs the userProfile the return carried (docs.zernio.com/connect/select-facebook-page): without one,
  // nothing is sent to Zernio.
  const kind = PICKS[platform];
  const fits = (platform === 'instagram' && sel.step === 'select_account') || (platform === 'facebook' && sel.step === 'select_page');
  if (!kind || !fits || !target.profileId || (sel.profileId && sel.profileId !== target.profileId) || (platform === 'facebook' && !sel.userProfile)) {
    ctx.log?.(`[connect] ${target.kind} ${target.id} ${platform}: a selection return that is not ours (step ${sel.step}, profile ${sel.profileId || 'none'})`);
    return { page: [400, resultPage({ title: 'החיבור לא הושלם', text: 'משהו בחזרה מהחיבור לא התאים. אפשר לנסות שוב.', actions })] };
  }
  const pages = await kind.list({ profileId: target.profileId, tempToken: sel.tempToken, connectToken: sel.connectToken });
  if (!pages.length) return { page: [200, resultPage({ ...kind.none, actions })] };
  if (pages.length === 1) {
    const got = await kind.select({ profileId: target.profileId, pageId: pages[0].pageId, tempToken: sel.tempToken, connectToken: sel.connectToken, userProfile: sel.userProfile });
    return { prefer: { [platform]: got.accountId } };
  }
  const id = holdPick(ctx.db, { target, platform, tempToken: sel.tempToken, connectToken: sel.connectToken, userProfile: sel.userProfile, pages }, { t });
  return { page: [200, pickerPage(pages, id, { platform, who: String(sel.userProfile?.name || sel.userProfile?.displayName || '').slice(0, 60) })] };
}

/**
 * GET /connect/pick/<id>?page=<pageId>: the Instagram account (or Facebook Page) picked on our own page. [status, html].
 * The id names a pick kept on the server (taken once); a page that was not on offer is refused without asking Zernio.
 */
export async function publicPick(ctx, { id, pageId, t = now() }) {
  const pick = takePick(ctx.db, id, { t });
  if (!pick) return [404, resultPage({ title: 'הבחירה הזו כבר לא בתוקף', text: 'אפשר לחבר שוב מהדף באתר.' })];
  const page = pick.pages.find((p) => p.pageId === String(pageId || ''));
  if (!page) {
    ctx.log?.(`[connect] ${pick.target.kind} ${pick.target.id}: a pick of a page that was not on offer`);
    return [400, resultPage({ title: 'החשבון הזה לא ברשימה', text: 'אפשר לחבר שוב מהדף באתר ולבחור מהרשימה.' })];
  }
  const platform = PICKS[pick.platform] ? pick.platform : 'instagram';
  const name = PLATFORM_NAME[platform];
  try {
    const got = await PICKS[platform].select({ profileId: pick.target.profileId, pageId: page.pageId, tempToken: pick.tempToken, connectToken: pick.connectToken, userProfile: pick.userProfile || null });
    const prefer = { [platform]: got.accountId };
    if (pick.target.kind === 'onboarding') {
      await refreshOnboardingConnections(ctx.db, pick.target.id, { t, prefer });
      const ob = ctx.db.get('SELECT pack_id FROM onboarding WHERE id = ?', pick.target.id);
      const pack = ob?.pack_id ? ctx.pack(ob.pack_id) : null;
      if (pack) {
        carryOnboardingZernio(ctx.db, pick.target.id, pack.id, { actor: 'zernio' });
        await refreshConnections(ctx.db, pack, { t, prefer });
      }
    } else {
      const pack = ctx.pack(pick.target.id);
      if (pack) await refreshConnections(ctx.db, pack, { t, prefer });
    }
    const who = platform === 'facebook' ? page.name || got.username || 'העמוד בפייסבוק' : got.username || page.username ? `@${got.username || page.username}` : 'החשבון באינסטגרם';
    return [200, resultPage({ title: `${name} מחובר`, text: `${who} מחובר עכשיו. אפשר לסגור את הדף.` })];
  } catch (e) {
    ctx.log?.(`[connect] ${pick.target.kind} ${pick.target.id} ${platform} pick: ${e.message}`);
    return [200, resultPage({ title: 'החיבור לא הושלם', text: 'לא הצלחנו לחבר את החשבון שבחרתם. אפשר לחבר שוב מהדף באתר.' })];
  }
}

/**
 * GET /new/<onboarding>/connect/<platform>/done: back from Zernio after a connect made before the account existed.
 * [status, html]. `ctx` is the engine's; the signature names the onboarding. What is connected is read from Zernio, and
 * an account created in the meantime takes it over at once.
 */
export async function publicOnboardingConnect(ctx, { onboardingId, platform, query, links, t = now() }) {
  const ob = ctx.db.get('SELECT id, pack_id, seed_json FROM onboarding WHERE id = ?', onboardingId);
  if (!ob || !onboardingDoneLinkOk(links.secret, { onboardingId, platform, e: query.get('e'), s: query.get('s'), t })) return [404, resultPage({ title: 'הלינק הזה כבר לא בתוקף', text: 'אפשר לחבר שוב מהדף של החשבון החדש באתר.' })];
  const name = PLATFORM_NAME[platform];
  if (!zernioConfigured()) return [503, resultPage({ title: 'החיבור לא זמין כרגע', text: 'החיבור לרשתות עוד לא זמין. אנחנו מטפלים בזה.' })];
  const back = `<a class="btn primary" href="/new/${esc(encodeURIComponent(ob.id))}#connect">חזרה להקמת החשבון</a>`;
  const error = query.get('error');
  if (error) {
    audit(ctx.db, { actor: 'zernio', action: 'zernio_connect_failed', detail: { onboarding: ob.id, platform, error, reason: query.get('error_message') || null, request: query.get('request_id') || null } });
    ctx.log?.(`[connect] onboarding ${ob.id} ${platform}: Zernio returned ${error}${query.get('error_message') ? ` (${query.get('error_message')})` : ''}`);
    const text = connectErrorHe(platform, { error: error === 'oauth_denied' ? 'denied' : error, message: query.get('error_message') || '', fixable: query.get('is_user_fixable') === 'true' });
    return [200, resultPage({ title: 'החיבור לא הצליח', text, actions: back })];
  }
  let kept;
  let prefer = query.get('accountId') ? { [platform]: query.get('accountId') } : {};
  try {
    const picked = await selection(ctx, { target: { kind: 'onboarding', id: ob.id, profileId: setupOf(ctx.db, ob.id).zernio?.profileId || null }, platform, query, actions: back, t });
    if (picked?.page) return picked.page;
    if (picked?.prefer) prefer = picked.prefer;
    kept = await refreshOnboardingConnections(ctx.db, ob.id, { t, prefer });
    // The account was created while the customer was on Zernio's screens: it takes the profile over now.
    const pack = ob.pack_id ? ctx.pack(ob.pack_id) : null;
    if (pack) {
      carryOnboardingZernio(ctx.db, ob.id, pack.id, { actor: 'zernio' });
      await refreshConnections(ctx.db, pack, { t, prefer });
    }
  } catch (e) {
    ctx.log?.(`[connect] onboarding ${ob.id} ${platform} done: ${e.message}`);
    return [200, resultPage({ title: 'עוד רגע', text: 'החיבור נשלח, אבל עוד לא קיבלנו אישור. תוך כמה דקות זה יופיע בדף של החשבון החדש.', actions: back })];
  }
  const c = kept[platform];
  if (c?.status !== 'connected') return [200, resultPage({ title: 'החיבור לא הושלם', text: `לא רואים ${name} מחובר. אפשר לנסות שוב.`, actions: back })];
  const niche = j(ob.seed_json, {})?.niche || '';
  return [200, resultPage({ title: `${name} מחובר`, text: `${c.username ? `@${c.username}` : `החשבון ב${name}`} מחובר עכשיו${niche ? ` לחשבון החדש על ${niche}` : ''}. כשהחשבון ייווצר, החיבור יעבור אליו לבד.`, actions: back })];
}

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
  if (!zernioConfigured()) return [503, resultPage({ title: 'החיבור לא זמין כרגע', text: 'החיבור לרשתות עוד לא זמין. אנחנו מטפלים בזה.' })];
  const again = () => `<a class="btn primary" href="${esc(connectLink(secret, { base, accountId: pack.id, platform, t }))}">לנסות שוב</a>`;

  if (!done) {
    try {
      const url = await startConnect(ctx.db, pack, platform, { doneUrl: doneLink(secret, { base, accountId: pack.id, platform, t }), actor: 'whatsapp link' });
      return [302, '', url];
    } catch (e) {
      if (e.code === 'not_connectable') return [200, resultPage({ title: `${name} כבר מחובר`, text: `${name} של ${pack.meta.displayName} מחובר דרך Meta, ואין פה מה לחבר.` })];
      ctx.log?.(`[connect] ${pack.id} ${platform}: ${e.message}`);
      return [502, resultPage({ title: 'אי אפשר לחבר כרגע', text: 'מסך החיבור לא נפתח הפעם. נסו שוב בעוד כמה דקות.', actions: again() })];
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
    const picked = await selection(ctx, { target: { kind: 'account', id: pack.id, profileId: profileIdOf(ctx.db, pack) }, platform, query, actions: again(), t });
    if (picked?.page) return picked.page;
    const prefer = picked?.prefer || (query.get('accountId') ? { [platform]: query.get('accountId') } : {});
    await refreshConnections(ctx.db, pack, { t, prefer });
  } catch (e) {
    ctx.log?.(`[connect] ${pack.id} ${platform} done: ${e.message}`);
    return [200, resultPage({ title: 'עוד רגע', text: 'החיבור נשלח, ועוד לא קיבלנו אישור מה חובר. תוך שעה זה יופיע בדף החשבון.' })];
  }
  const s = connectState(ctx.db, pack, platform);
  if (s.state !== 'connected') return [200, resultPage({ title: 'החיבור לא הושלם', text: `לא רואים ${name} מחובר ל-${pack.meta.displayName}. אפשר לנסות שוב.`, actions: again() })];
  ctx.db.update('accounts', pack.id, { updated_at: nowIso() });
  return [200, resultPage({ title: `${name} מחובר`, text: `${s.username ? `@${s.username}` : `החשבון ב${name}`} מחובר עכשיו ל-${pack.meta.displayName}. אפשר לסגור את הדף.` })];
}

