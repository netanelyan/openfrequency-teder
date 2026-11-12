import { DAY, monthKey, now, nowIso } from '../core/clock.js';
import { audit } from '../core/store.js';
import { TIKTOK_MODES } from '../packs/validate.js';
import { setPackPublishing } from '../packs/write.js';
import { tiktokMode, wantedPublisher } from '../publish/index.js';
import { isCustomerAccount, resumeAccount } from '../autonomy/rails.js';
import { accountAllowed } from '../billing/entitlement.js';
import { OWN_APP } from '../publish/tiktok-app.js';
import { zernioConfigured } from '../publish/zernio.js';
import { GONE, carryOnboardingZernio, connectLink, connectLinkOk, connectState, doneLink, doneLinkOk, holdPick, onboardingDoneLinkOk, profileIdOf, refreshConnections, refreshOnboardingConnections, selectionOf, startConnect, takePick, zernioCost } from '../publish/connect.js';
import { setupOf } from '../onboarding/setup.js';
import { facebookPages, instagramPages, selectFacebookPage, selectInstagram } from '../publish/zernio.js';
import { j } from '../db/index.js';
import { ActionError } from './actions.js';
import { connectErrorHe } from '../publish/errors.js';
import { a11yLink, a11yWidget, csrfField, esc, htmlOpen, icon, postButton, tederMark, themeButton, themeMeta, themeScript, usd, withSupport } from './ui.js';

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
//   - every return from a connect that worked takes the browser back to the page it started from (the owner,
//     2026-11-09, of "אינסטגרם מחובר ... @<the account> מחובר עכשיו ל-<its name>. אפשר לסגור את הדף": "it should
//     redirect or have a button to the page we got from"). The connect opens in the same tab (goPage), so there is no
//     window to close: the button that starts it sends the page it is on (`back`, a path on this site, backPath), the
//     return address carries it (`b`), and the page that says it worked goes back there after GO_AFTER_S seconds,
//     with a "לחזור לתדר" button for a browser that does not, and a toast there that says what was connected. A
//     return with no `b` (the assistant's link, a connect started before this) goes to the account's setup while it
//     has one, else to the account's page.

export const PLATFORM_NAME = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
// Names in a row, as Hebrew writes them: טיקטוק, אינסטגרם ופייסבוק.
export const heList = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names.at(-1)}`);
/**
 * Said to a customer wherever they would connect while this server has no Zernio key (ZERNIO_API_KEY unset): the
 * connect panel, its buttons' answer, the signed links' pages and accounts' setup checklist. What happened and the one
 * thing to do; "כתבו לנו" is a link to our WhatsApp where a page shows it (ui.js withSupport), the words alone elsewhere.
 */
export const CONNECT_CLOSED_HE = 'החיבור לרשתות עוד לא פתוח אצלנו. כתבו לנו ונגיד לכם מתי הוא נפתח.';
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
 * What Instagram needs, on its own row beside "לחבר את אינסטגרם" while it is not connected (the owner, 2026-11-05: "make
 * sure it is stated that a business instagram account is needed"; in the list above the rows it was easy to miss): a
 * professional account, business or creator. Zernio's words (docs.zernio.com/platforms/instagram, read 2026-11-05):
 * "Instagram requires a Business or Creator account. Personal accounts cannot post through the API." With Instagram
 * Login, the way Teder connects it (src/publish/zernio.js connectUrl), no Facebook Page is involved, so none is asked for.
 */
export const INSTAGRAM_NEEDS_HE = 'אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר. חשבון פרטי מעבירים לחשבון מקצועי בהגדרות של אינסטגרם, בלי תשלום, ואז מחברים כאן.';

/**
 * What each platform needs, said before its button, for the platforms still to connect (Instagram's is on its own row,
 * INSTAGRAM_NEEDS_HE): TikTok any account the customer logs into, and in draft-now its posts land in TikTok's drafts on
 * purpose, for the owner to add a popular sound and post; Facebook a Page they manage, never a personal profile, and it
 * is optional while the account posts elsewhere.
 */
export function requirements(d) {
  const open = d.platforms.filter((s) => s.state !== 'meta' && s.state !== 'connected').map((s) => s.platform);
  const lines = [];
  if (open.length) lines.push('בחיבור מאשרים את Zernio, השירות שמפרסם בשבילנו.');
  if (open.includes('tiktok')) {
    lines.push('בטיקטוק נכנסים עם החשבון שאליו המצגות יעלו, ומאשרים את ההרשאות במסך של טיקטוק.');
    if (d.mode === 'draft-now') lines.push('המצגות מגיעות לטיוטות בטיקטוק בכוונה, כדי שתבחרו סאונד פופולרי ותפרסמו משם. כשמגיעה השעה, הטיוטה מופיעה בדף היום, ובמכשיר שהפעלתם בו התראות מגיעה גם התראה.');
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
 * the account exists. `heading` (a tag, 'h3') makes the platforms' names the panel's heading, as on the account page,
 * where the panel is the networks' own; without it they are a line, under the onboarding section's heading. Each
 * platform is a row: its name, its state and the account connected, and the button at the row's end. `back` is the page
 * the panel is on (a path on this site): each button sends it, and the connect comes back to it.
 */
export function connectPanel(ctx, d, { base = null, heading = null, back = null } = {}) {
  const { pack } = d;
  const at = base || `/accounts/${pack.id}`;
  const fields = backPath(back) ? { back } : {};
  const rows = d.platforms
    .map((s) => {
      const [cls, he] = STATE_CHIP[s.state];
      const name = PLATFORM_NAME[s.platform] || s.platform;
      const action = `${at}/connect/${s.platform}`;
      const button =
        s.state === 'meta' || !d.configured
          ? ''
          : s.state === 'none'
            ? postButton(ctx, action, `${icon('plus')}לחבר את ${name}`, { cls: 'btn sm primary', fields })
            : s.state === 'reconnect'
              ? postButton(ctx, action, `לחבר מחדש את ${name}`, { cls: 'btn sm primary', fields })
              : postButton(ctx, action, 'לחבר חשבון אחר', { cls: 'btn sm ghost', fields });
      return `<li class="net"><span class="who"><b>${esc(name)}</b> <span class="chip ${cls}">${esc(he)}</span>${s.username ? (s.platform === 'facebook' ? ` <bdi class="muted" dir="auto">${esc(s.username)}</bdi>` : ` <span class="ltr muted">@${esc(s.username)}</span>`) : ''}</span>${s.state === 'reconnect' && s.issue ? (s.issue === GONE ? `<div class="muted small">החיבור ל${esc(name)} התנתק, ופוסטים לא מגיעים לשם עד שמחברים שוב.</div>` : ctx.operator ? `<div class="muted small ltr">${esc(s.issue)}</div>` : `<div class="muted small">${esc(name)} ביקש לאשר את החיבור מחדש. עד אז פוסטים לא מגיעים לשם.</div>`) : ''}${s.platform === 'instagram' && s.state === 'none' && d.configured ? `<div class="muted small">${esc(INSTAGRAM_NEEDS_HE)}</div>` : ''}${button ?`<span class="act">${button}</span>` : ''}</li>`;
    })
    .join('');
  const note = d.configured
    ? 'נפתח המסך של הרשת, מאשרים שם וחוזרים לכאן.'
    : ctx.operator
      ? 'אי אפשר לחבר עכשיו: בשרת לא מוגדר ZERNIO_API_KEY.'
      : CONNECT_CLOSED_HE;
  const names = esc(heList(d.platforms.map((s) => PLATFORM_NAME[s.platform] || s.platform)));
  const check = d.configured && d.hasProfile ? `<span class="end">${postButton(ctx, `${at}/connections`, 'לבדוק שוב', { cls: 'btn sm ghost' })}</span>` : '';
  const head = heading ? `<header><${heading}>${names}</${heading}>${check}</header>` : `<div class="row"><span>${names}</span>${check}</div>`;
  return `<div class="connect" id="connect-${esc(pack.id)}">${head}
${d.configured ? requirements(d) : ''}<ul class="factlist nets">${rows}</ul><p class="muted small m0">${withSupport(note)}</p>${ctx.operator && d.zernio != null ? `<p class="muted small m0">Zernio החודש: ${usd(d.zernio.usd)}</p>` : ''}</div>`;
}

/**
 * How the account's TikTok posts go out, and (the operator) through what. A customer's TikTok always lands in the app's
 * drafts (src/publish/index.js tiktokMode): they read that in one line, with no choice to make. The operator chooses
 * for the company's own accounts, and sees a customer's as fixed. A panel of the account page's grid (pages.js).
 */
/**
 * How a customer's slideshows reach TikTok: always as drafts (src/publish/draft.js), and what reminds them at the hour:
 * the draft on Today, and a push to a device that turned notifications on (Settings, and the ask on Today). It said
 * "תדר מזכיר לכם" while a customer who never turned push on got nothing outside the dashboard (the audit, 2026-11-12,
 * P1-19). There is no email for it (accounts' /internal/notify takes five kinds) and Teder is not on WhatsApp.
 */
export const TIKTOK_LINE = 'המצגות מגיעות לטיוטות בטיקטוק. בוחרים שם סאונד פופולרי ומפרסמים מהאפליקציה. כשמגיעה השעה, הטיוטה מופיעה בדף היום, ובמכשיר שהפעלתם בו התראות מגיעה גם התראה.';

export function tiktokModePanel(ctx, d) {
  if (!d.pack.meta.platforms.includes('tiktok')) return '';
  const head = '<header><h3>איך פוסטים עולים לטיקטוק</h3></header>';
  // A customer's is a line, not a choice: on a phone it is under the account page's one row for how it works.
  if (!ctx.operator || d.customer) return `<section class="panel acct-tiktok about">${head}<p class="m0">${esc(TIKTOK_LINE)}${ctx.operator ? ' (חשבון של לקוח: תמיד לטיוטות.)' : ''}</p></section>`;
  const id = esc(d.pack.id);
  const modes = ['draft-now', 'direct', ...(d.mode === 'draft-fallback' ? ['draft-fallback'] : [])];
  const choice = modes.map((m) => `<input type="radio" name="mode" value="${m}" id="tt-${id}-${m}"${d.mode === m ? ' checked' : ''}><label for="tt-${id}-${m}">${esc(MODE_CHOICE[m][0])}<small>${esc(MODE_CHOICE[m][1])}</small></label>`).join('');
  const via = ctx.operator
    ? `<label class="f m6">דרך מה מפרסמים לטיקטוק<select name="via"><option value="zernio"${d.via !== OWN_APP ? ' selected' : ''}>Zernio</option><option value="${OWN_APP}"${d.via === OWN_APP ? ' selected' : ''}>האפליקציה שלנו בטיקטוק (עוד לא קיימת, הפוסטים נכתבים לדיסק)</option></select></label>`
    : '';
  return `<section class="panel acct-tiktok">${head}<form method="post" action="/accounts/${id}/tiktok">${csrfField(ctx)}<div class="seg" role="radiogroup" aria-label="איך פוסטים עולים לטיקטוק">${choice}</div>${via}<div class="actions p0 m6"><button class="btn sm" type="submit">שמירה</button></div></form></section>`;
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
      async (ctx, user, m, f = {}) => {
        const pack = mustPack(ctx, m[1]);
        if (!zernioConfigured()) throw new ActionError(CONNECT_CLOSED_HE);
        const { base, secret } = links();
        let url;
        try {
          // The page the button is on goes with the return address, for the connect to come back to.
          url = await startConnect(ctx.db, pack, m[2], { doneUrl: withBack(doneLink(secret, { base, accountId: pack.id, platform: m[2] }), backPath(f.back)), actor: user.name });
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
        if (!zernioConfigured()) throw new ActionError(CONNECT_CLOSED_HE);
        try {
          await refreshConnections(ctx.db, pack);
        } catch (e) {
          ctx.log?.(`[connect] ${pack.id}: ${e.message}`);
          throw new ActionError('לא הצלחנו לבדוק את החיבורים עכשיו. נסו שוב בעוד כמה דקות.', 502);
        }
        const resumed = resumedHe(ctx, pack);
        return { ok: true, message: resumed ? `החיבורים נבדקו, ${resumed}` : 'החיבורים נבדקו ועודכנו.' };
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

/**
 * A handle in a Hebrew sentence, kept left to right (Unicode's isolates survive the escaping): at the start of a
 * right-to-left line its @ was drawn after the name ("name@").
 */
const handleHe = (username) => `⁦@${username}⁩`;

// The browser's light or dark (ui.js themeOf), which server.js reads from the request and every page here is given.
// `go`: a page of this site (backPath) the page goes on to by itself after GO_AFTER_S seconds; its button is in `actions`.
function resultPage({ title, text, actions = '', v = 1, theme = 'light', go = null }) {
  return `<!doctype html>${htmlOpen(theme)}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${themeMeta(theme)}<meta name="robots" content="noindex">${go ? `<meta http-equiv="refresh" content="${GO_AFTER_S};url=${esc(go)}">` : ''}<title>${esc(title)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"><link rel="icon" href="/static/icon.svg?v=${v}" type="image/svg+xml"></head>
<body class="login"><main class="card">${themeButton(theme)}
<div class="hero">${tederMark()}<b>תדר</b></div>
<h1>${esc(title)}</h1>
<p>${withSupport(text)}</p>
${go ? '<p class="muted small">עוד רגע חוזרים לדף שממנו התחלתם.</p>' : ''}${actions ? `<div class="links">${actions}</div>` : ''}<p class="a11y-foot">${a11yLink()}</p></main>${a11yWidget()}${themeScript(v)}<script src="/static/app.js?v=${v}" defer></script></body></html>`;
}

/**
 * The page a connect button answers with: on to Zernio's link at once. A page, not a redirect: the site's CSP keeps
 * form submissions on our own origin (form-action 'self'), redirects included, and Zernio is not ours.
 */
export function goPage(url, { name = '', v = 1, theme = 'light' } = {}) {
  return `<!doctype html>${htmlOpen(theme)}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${themeMeta(theme)}<meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${esc(url)}"><title>עוברים ל${esc(name)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"></head>
<body class="login"><main class="card">${themeButton(theme)}<div class="hero">${tederMark()}<b>תדר</b></div><h1>עוברים ל${esc(name)}</h1><p>אם הדף לא עובר לבד, אפשר ללחוץ כאן.</p><div class="links"><a class="btn primary" href="${esc(url)}" rel="noreferrer">להמשיך</a></div><p class="a11y-foot">${a11yLink()}</p></main>${themeScript(v)}</body></html>`;
}

/**
 * A connect link past its 72 hours (or a return address past its two). A new one is the account page's: its button
 * asks Zernio for a fresh link at every tap (connectRoutes above). The page sends nobody to WhatsApp for one: the
 * assistant hands links on only where it runs, and it did not on 2026-10-30.
 */
const EXPIRED = { title: 'הקישור הזה כבר לא בתוקף', text: 'קישור לחיבור עובד 72 שעות. מחברים מדף החשבון בתדר, והכפתור שם פותח חיבור חדש בכל לחיצה.' };
// The account the address names, whether or not it exists: the page is the same either way, and the account page shows
// only the workspace's own.
const expired = (account, theme) => resultPage({ theme, ...EXPIRED, actions: `<a class="btn primary" href="/accounts?account=${esc(encodeURIComponent(account))}">לדף החשבון</a>` });

/**
 * Back to the account's setup (/new/<onboarding>), on each page here that a connect started during the setup ends on
 * (the owner, 2026-11-05: "when connecting an instagram and tiktok page, make a button of 'לחזור להגדרת החשבון'"): the
 * page's blue button when it is its one way on, a grey one beside "לנסות שוב", a quiet one under a list to pick from
 * (where a grey one would read as one more choice). An account past its setup (live) gets none: its connect came from
 * the account page or the assistant's link, not from a setup.
 */
export const SETUP_BACK_HE = 'לחזור להגדרת החשבון';
const setupBack = (onboardingId, cls = 'btn primary') => (onboardingId ? `<a class="${cls}" href="/new/${esc(encodeURIComponent(onboardingId))}#connect">${SETUP_BACK_HE}</a>` : '');
/**
 * A page of this site to go back to after a connect (`back` from the button, `b` on the return address), or null.
 * Only a path on this host: "/" and then anything but a second slash or a backslash (so never "//host"), no
 * spaces or control characters, 300 characters at most. Anything else is dropped, never followed: the return address
 * needs no session, so it must not be a way to send someone to another site. `b` is not signed: the worst a changed one
 * can do is open another page of Teder, which asks for a session of its own.
 */
export function backPath(v) {
  const s = String(v ?? '');
  return s.length <= 300 && /^\/(?![\/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(s) ? s : null;
}
/** The return address with the page to go back to on it. */
const withBack = (url, back) => (back ? `${url}&b=${encodeURIComponent(back)}` : url);
/** The account's page, at its networks: where a connect of a live account goes back to when it was not told. */
const accountHome = (accountId) => `/accounts?account=${encodeURIComponent(accountId)}#connect-${encodeURIComponent(accountId)}`;
export const BACK_HE = 'לחזור לתדר';
/** The way back as a button: to a setup it says so (SETUP_BACK_HE), anywhere else "לחזור לתדר". */
const homeButton = (home, cls = 'btn primary') => `<a class="${cls}" href="${esc(home)}">${home.startsWith('/new/') ? SETUP_BACK_HE : BACK_HE}</a>`;
/** Seconds before a page that says a connect worked goes back by itself. */
export const GO_AFTER_S = 2;
/** What the page a connect went back to says, as a toast (server.js flash), once. */
const connectedHe = (name, resumed = '') => (resumed ? `${name} מחובר, ${resumed}` : `${name} מחובר`);

/**
 * A connect that ends connected lifts the pause a broken connection caused. The audit of 2026-11-12, P1-17: after
 * reconnecting, the account still read "מושהה (רצף שגיאות פרסום)", "החיבור לטיקטוק הפסיק לעבוד", and nothing went out
 * until the customer found "הפעלה מחדש" on the account page. An account paused for publish errors (src/autonomy/rails.js,
 * a pause the customer may lift themselves) with no platform still asking to be connected again is active again, as its
 * own button would make it. Returns what the toast and the page add ("והחשבון פעיל שוב", and the posts that did not go
 * out meanwhile, which "לנסות שוב" sends), or ''.
 */
export function resumedHe(ctx, pack, t = now()) {
  const acc = ctx.db.get('SELECT status, paused_reason FROM accounts WHERE id = ?', pack.id);
  if (acc?.status !== 'paused' || acc.paused_reason !== 'publish_errors') return '';
  if (pack.meta.platforms.some((p) => connectState(ctx.db, pack, p).state === 'reconnect')) return '';
  resumeAccount(ctx.db, pack.id, 'connect');
  // The posts Today lists as not out (src/web/data.js FAILED_DAYS, two weeks), each with "לנסות שוב".
  const failed = ctx.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'failed' AND sample = 0 AND updated_at >= ?", pack.id, new Date(t - 14 * DAY).toISOString()).n;
  return `והחשבון פעיל שוב.${failed ? ` ${failed === 1 ? 'מצגת אחת לא עלתה בינתיים, ואפשר לשלוח אותה' : `${failed} מצגות לא עלו בינתיים, ואפשר לשלוח אותן`} שוב מדף היום.` : ''}`;
}

/** The setup an account is still in: its onboarding, not live or given up (null when there is none). */
const setupFor = (db, accountId) => db.get("SELECT id FROM onboarding WHERE pack_id = ? AND status NOT IN ('live', 'abandoned') ORDER BY updated_at DESC LIMIT 1", accountId)?.id || null;
/** The setup a connect's target belongs to: the onboarding itself, or the setup its account is still in. */
const setupOfTarget = (db, target) => (target.kind === 'onboarding' ? target.id : setupFor(db, target.id));

/**
 * The page that lists the Instagram accounts (or Facebook Pages) to pick from, each a link that connects it; under them,
 * a setup's way back (`back`, setupBack's).
 */
function pickerPage(pages, id, { who = '', platform = 'instagram', theme = 'light', back = '' } = {}) {
  const fb = platform === 'facebook';
  // A Page is known by its name (its @username is optional); an Instagram account by its @username.
  const label = (p) => (fb ? `<bdi dir="auto">${esc(p.name || p.username)}</bdi>${p.name && p.username ? ` <small dir="ltr">@${esc(p.username)}</small>` : ''}` : `<bdi dir="ltr">@${esc(p.username || p.name)}</bdi>${p.name && p.username ? ` <small>${esc(p.name)}</small>` : ''}`);
  const links = pages.map((p) => `<a class="btn" href="/connect/pick/${esc(id)}?page=${esc(encodeURIComponent(p.pageId))}">${label(p)}</a>`).join('');
  const text = fb ? 'מצאנו כמה עמודים שאתם מנהלים. בוחרים את העמוד שאליו המצגות יעלו.' : 'מצאנו כמה חשבונות אינסטגרם מקצועיים. בוחרים את החשבון שאליו המצגות יעלו.';
  return resultPage({ theme, title: fb ? 'איזה עמוד פייסבוק לחבר?' : 'איזה חשבון אינסטגרם לחבר?', text: `${who ? `${who}, ` : ''}${text}`, actions: `${links}${back}` });
}

/** A signed link opened, or a return from Zernio, while this server has no Zernio key. */
const CLOSED = { title: 'עוד אי אפשר לחבר', text: CONNECT_CLOSED_HE };

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
async function selection(ctx, { target, platform, query, actions, t, theme, home = null }) {
  const sel = selectionOf(query);
  if (!sel) return null;
  // Instagram through Facebook Login picks an account, a Facebook connect picks a Page: each only on its own return. A
  // Page's pick needs the userProfile the return carried (docs.zernio.com/connect/select-facebook-page): without one,
  // nothing is sent to Zernio.
  const kind = PICKS[platform];
  const fits = (platform === 'instagram' && sel.step === 'select_account') || (platform === 'facebook' && sel.step === 'select_page');
  if (!kind || !fits || !target.profileId || (sel.profileId && sel.profileId !== target.profileId) || (platform === 'facebook' && !sel.userProfile)) {
    ctx.log?.(`[connect] ${target.kind} ${target.id} ${platform}: a selection return that is not ours (step ${sel.step}, profile ${sel.profileId || 'none'})`);
    return { page: [400, resultPage({ theme, title: 'החיבור לא הושלם', text: 'משהו בחזרה מהחיבור לא התאים. אפשר לנסות שוב.', actions })] };
  }
  const pages = await kind.list({ profileId: target.profileId, tempToken: sel.tempToken, connectToken: sel.connectToken });
  if (!pages.length) return { page: [200, resultPage({ theme, ...kind.none, actions })] };
  if (pages.length === 1) {
    const got = await kind.select({ profileId: target.profileId, pageId: pages[0].pageId, tempToken: sel.tempToken, connectToken: sel.connectToken, userProfile: sel.userProfile });
    return { prefer: { [platform]: got.accountId } };
  }
  // The page to go back to is kept with the pick, for the page that says it worked (publicPick).
  const id = holdPick(ctx.db, { target, platform, tempToken: sel.tempToken, connectToken: sel.connectToken, userProfile: sel.userProfile, pages, back: home }, { t });
  return { page: [200, pickerPage(pages, id, { platform, theme, who: String(sel.userProfile?.name || sel.userProfile?.displayName || '').slice(0, 60), back: setupBack(setupOfTarget(ctx.db, target), 'btn ghost') })] };
}

/**
 * GET /connect/pick/<id>?page=<pageId>: the Instagram account (or Facebook Page) picked on our own page. [status, html].
 * The id names a pick kept on the server (taken once); a page that was not on offer is refused without asking Zernio.
 * Connected, the page goes back to where the connect started (the pick keeps it), and says so there: [status, html,
 * flash].
 */
export async function publicPick(ctx, { id, pageId, t = now(), theme = 'light' }) {
  const pick = takePick(ctx.db, id, { t });
  // The pick is gone (taken once, or past 15 minutes): the way back to connect again, as an expired link has.
  if (!pick) return [404, resultPage({ theme, title: 'הבחירה הזו כבר לא בתוקף', text: 'אפשר לחבר שוב מדף החשבון בתדר.', actions: '<a class="btn primary" href="/accounts">לדף החשבון</a>' })];
  const back = setupBack(setupOfTarget(ctx.db, pick.target));
  const setupId = setupOfTarget(ctx.db, pick.target);
  const home = backPath(pick.back) || (setupId ? `/new/${encodeURIComponent(setupId)}#connect` : pick.target.kind === 'account' ? accountHome(pick.target.id) : '/');
  const page = pick.pages.find((p) => p.pageId === String(pageId || ''));
  if (!page) {
    ctx.log?.(`[connect] ${pick.target.kind} ${pick.target.id}: a pick of a page that was not on offer`);
    return [400, resultPage({ theme, title: 'החשבון הזה לא ברשימה', text: 'אפשר לחבר שוב מהדף באתר ולבחור מהרשימה.', actions: back })];
  }
  const platform = PICKS[pick.platform] ? pick.platform : 'instagram';
  const name = PLATFORM_NAME[platform];
  let resumed = '';
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
      resumed = pack ? resumedHe(ctx, pack, t) : '';
    }
    const who = platform === 'facebook' ? page.name || got.username || 'העמוד בפייסבוק' : got.username || page.username ? handleHe(got.username || page.username) : 'החשבון באינסטגרם';
    return [200, resultPage({ theme, title: `${name} מחובר`, text: `${who} מחובר עכשיו.${resumed ? ' החשבון פעיל שוב.' : ''}`, actions: homeButton(home), go: home }), null, connectedHe(name, resumed)];
  } catch (e) {
    ctx.log?.(`[connect] ${pick.target.kind} ${pick.target.id} ${platform} pick: ${e.message}`);
    return [200, resultPage({ theme, title: 'החיבור לא הושלם', text: 'לא הצלחנו לחבר את החשבון שבחרתם. אפשר לחבר שוב מהדף באתר.', actions: back })];
  }
}

/**
 * GET /new/<onboarding>/connect/<platform>/done: back from Zernio after a connect made before the account existed.
 * [status, html]. `ctx` is the engine's; the signature names the onboarding. What is connected is read from Zernio, and
 * an account created in the meantime takes it over at once. Connected, the page goes back to the setup by itself and
 * says so there: [status, html, flash].
 */
export async function publicOnboardingConnect(ctx, { onboardingId, platform, query, links, t = now(), theme = 'light' }) {
  const ob = ctx.db.get('SELECT id, pack_id, seed_json FROM onboarding WHERE id = ?', onboardingId);
  if (!ob || !onboardingDoneLinkOk(links.secret, { onboardingId, platform, e: query.get('e'), s: query.get('s'), t })) return [404, resultPage({ theme, title: 'הקישור הזה כבר לא בתוקף', text: 'אפשר לחבר שוב מהדף של החשבון החדש באתר.' })];
  const name = PLATFORM_NAME[platform];
  if (!zernioConfigured()) return [503, resultPage({ theme, ...CLOSED })];
  const back = setupBack(ob.id);
  const error = query.get('error');
  if (error) {
    audit(ctx.db, { actor: 'zernio', action: 'zernio_connect_failed', detail: { onboarding: ob.id, platform, error, reason: query.get('error_message') || null, request: query.get('request_id') || null } });
    ctx.log?.(`[connect] onboarding ${ob.id} ${platform}: Zernio returned ${error}${query.get('error_message') ? ` (${query.get('error_message')})` : ''}`);
    const text = connectErrorHe(platform, { error: error === 'oauth_denied' ? 'denied' : error, message: query.get('error_message') || '', fixable: query.get('is_user_fixable') === 'true' });
    return [200, resultPage({ theme, title: 'החיבור לא הצליח', text, actions: back })];
  }
  let kept;
  let prefer = query.get('accountId') ? { [platform]: query.get('accountId') } : {};
  try {
    const picked = await selection(ctx, { target: { kind: 'onboarding', id: ob.id, profileId: setupOf(ctx.db, ob.id).zernio?.profileId || null }, platform, query, actions: back, t, theme, home: `/new/${encodeURIComponent(ob.id)}#connect` });
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
    return [200, resultPage({ theme, title: 'עוד רגע', text: 'החיבור נשלח, אבל עוד לא קיבלנו אישור. תוך כמה דקות זה יופיע בדף של החשבון החדש.', actions: back })];
  }
  const c = kept[platform];
  if (c?.status !== 'connected') return [200, resultPage({ theme, title: 'החיבור לא הושלם', text: `לא רואים ${name} מחובר. אפשר לנסות שוב.`, actions: back })];
  const niche = j(ob.seed_json, {})?.niche || '';
  return [200, resultPage({ theme, title: `${name} מחובר`, text: `${c.username ? handleHe(c.username) : `החשבון ב${name}`} מחובר עכשיו${niche ? ` לחשבון החדש על ${niche}` : ''}. כשהחשבון ייווצר, החיבור יעבור אליו לבד.`, actions: back, go: `/new/${encodeURIComponent(ob.id)}#connect` }), connectedHe(name)];
}

/**
 * GET /connect/<account>/<platform>[/done]: [status, html, location?, flash?]. `ctx` is the engine's (no session, so no
 * workspace): the signature names the account. `links` is { base, secret }. Back from Zernio and connected, the page goes
 * back by itself to where the connect started (`b`, backPath), and `flash` is what that page says in its toast.
 */
export async function publicConnect(ctx, { account, platform, done, query, links, t = now(), theme = 'light' }) {
  const { base, secret } = links;
  const pack = ctx.pack(account);
  const sig = { accountId: account, platform, e: query.get('e'), s: query.get('s'), t };
  if (!pack || !(done ? doneLinkOk(secret, sig) : connectLinkOk(secret, sig))) return [404, expired(account, theme)];
  // Connecting is the paywall's (src/web/server.js SETUP_OPEN): a customer's workspace that has not paid connects
  // nothing, from this link either. Coming back from Zernio (done) finishes a connect started while it could.
  if (!done && !accountAllowed(ctx.db, pack.id, t)) return [402, resultPage({ theme, title: 'החיבור נפתח אחרי ההפעלה', text: 'אפשר לחבר את טיקטוק, אינסטגרם ופייסבוק אחרי שתדר מופעל בחשבון שלכם.' })];
  const name = PLATFORM_NAME[platform];
  // An account still in its setup: each page from here on has the way back to it (setupBack), grey beside "לנסות שוב".
  const setup = setupFor(ctx.db, pack.id);
  // Where the connect started, or the setup while there is one, or the account's page.
  const home = backPath(query.get('b')) || (setup ? `/new/${encodeURIComponent(setup)}#connect` : accountHome(pack.id));
  const back = homeButton(home);
  if (!zernioConfigured()) return [503, resultPage({ theme, ...CLOSED, actions: back })];
  const again = () => `<a class="btn primary" href="${esc(connectLink(secret, { base, accountId: pack.id, platform, t }))}">לנסות שוב</a>${homeButton(home, 'btn')}`;

  if (!done) {
    try {
      const url = await startConnect(ctx.db, pack, platform, { doneUrl: doneLink(secret, { base, accountId: pack.id, platform, t }), actor: 'whatsapp link' });
      return [302, '', url];
    } catch (e) {
      if (e.code === 'not_connectable') return [200, resultPage({ theme, title: `${name} כבר מחובר`, text: `${name} של ${pack.meta.displayName} מחובר דרך Meta, ואין פה מה לחבר.`, actions: back })];
      ctx.log?.(`[connect] ${pack.id} ${platform}: ${e.message}`);
      return [502, resultPage({ theme, title: 'אי אפשר לחבר כרגע', text: 'מסך החיבור לא נפתח הפעם. נסו שוב בעוד כמה דקות.', actions: again() })];
    }
  }

  // Back from Zernio. Its error says what went wrong in its own words; what is connected is read from Zernio itself.
  const error = query.get('error');
  if (error) {
    audit(ctx.db, { actor: 'zernio', action: 'zernio_connect_failed', accountId: pack.id, detail: { platform, error, reason: query.get('error_message') || null, request: query.get('request_id') || null } });
    // Zernio's code stays in the audit and the log; the customer reads what it means and what to do.
    ctx.log?.(`[connect] ${pack.id} ${platform}: Zernio returned ${error}${query.get('error_message') ? ` (${query.get('error_message')})` : ''}`);
    const text = connectErrorHe(platform, { error: error === 'oauth_denied' ? 'denied' : error, message: query.get('error_message') || '', fixable: query.get('is_user_fixable') === 'true' });
    return [200, resultPage({ theme, title: 'החיבור לא הצליח', text, actions: again() })];
  }
  try {
    const picked = await selection(ctx, { target: { kind: 'account', id: pack.id, profileId: profileIdOf(ctx.db, pack) }, platform, query, actions: again(), t, theme, home });
    if (picked?.page) return picked.page;
    const prefer = picked?.prefer || (query.get('accountId') ? { [platform]: query.get('accountId') } : {});
    await refreshConnections(ctx.db, pack, { t, prefer });
  } catch (e) {
    ctx.log?.(`[connect] ${pack.id} ${platform} done: ${e.message}`);
    return [200, resultPage({ theme, title: 'עוד רגע', text: 'החיבור נשלח, ועוד לא קיבלנו אישור מה חובר. תוך שעה זה יופיע בדף החשבון.', actions: back })];
  }
  const s = connectState(ctx.db, pack, platform);
  if (s.state !== 'connected') return [200, resultPage({ theme, title: 'החיבור לא הושלם', text: `לא רואים ${name} מחובר ל-${pack.meta.displayName}. אפשר לנסות שוב.`, actions: again() })];
  ctx.db.update('accounts', pack.id, { updated_at: nowIso() });
  const resumed = resumedHe(ctx, pack, t);
  return [200, resultPage({ theme, title: `${name} מחובר`, text: `${s.username ? handleHe(s.username) : `החשבון ב${name}`} מחובר עכשיו ל-${pack.meta.displayName}.${resumed ? ' החשבון פעיל שוב.' : ''}`, actions: back, go: home }), null, connectedHe(name, resumed)];
}

