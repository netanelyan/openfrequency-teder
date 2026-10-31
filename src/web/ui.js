// The pieces every page is made of. Pages are functions from data to HTML
// strings: no framework, so a page can be tested by reading it. Every value that
// came from outside goes through esc().
//
// HARD RULE 8: the document is lang="he" dir="rtl". A Latin run inside Hebrew
// (a handle, a URL, a product name) sits in <bdi> or .ltr so bidi cannot
// scramble the punctuation around it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assetsDir } from '../core/paths.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const TZ = 'Asia/Jerusalem';
const fmt = (o) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, ...o });
const F = {
  day: fmt({ weekday: 'long', day: 'numeric', month: 'long' }),
  short: fmt({ day: 'numeric', month: 'short' }),
  time: fmt({ hour: '2-digit', minute: '2-digit', hour12: false }),
  stamp: fmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
  wd: fmt({ weekday: 'narrow' }),
};
export const dayHe = (t) => F.day.format(new Date(t));
export const shortDate = (t) => (t ? F.short.format(new Date(t)) : '');
export const timeHe = (t) => (t ? F.time.format(new Date(t)) : '');
export const stamp = (t) => (t ? F.stamp.format(new Date(t)) : '');
export const weekdayNarrow = (t) => F.wd.format(new Date(t));
export const usd = (n, d = 2) => `<span class="num ltr">$${(Number(n) || 0).toFixed(d)}</span>`;
export const k = (n) => (n == null ? '–' : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
export const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

/** A brand mark's glyph, as drawn in assets/brand/svg (viewBox 0 0 100 100, currentColor): never redrawn here. */
const glyph = (name) => readFileSync(path.join(assetsDir, 'brand', 'svg', `${name}.svg`), 'utf8').replace(/^\s*<svg[^>]*>|<\/svg>\s*$/g, '');
// pathLength lets the login draw the wave in without knowing how long it is; it changes nothing on the page.
const TEDER_GLYPH = glyph('teder-glyph').replace('<path ', '<path pathLength="100" ');
const OF_GLYPH = glyph('openfrequency-glyph-small');
const markTile = (cls, inner) => `<span class="mark ${cls}" aria-hidden="true"><svg viewBox="0 0 100 100">${inner}</svg></span>`;
/** Teder's mark: one wave on violet. The header and the login. */
export const tederMark = () => markTile('teder', TEDER_GLYPH);
/** The company's mark: a halftone on blue. Only the footer, next to the name. */
export const ofMark = () => markTile('of', OF_GLYPH);

/** The accessibility statement (openfrequency.co.il/accessibility), linked from every page with no session. The product's own foot stays the mark and the name, as the owner chose. */
export const A11Y_URL = 'https://openfrequency.co.il/accessibility';
export const a11yLink = () => `<a class="a11y" href="${A11Y_URL}">הצהרת הנגישות</a>`;

/**
 * The accessibility panel, the website's own (openfrequency-web src/layout.mjs .a11y), on every page of the layout: a
 * round button at the bottom corner, four switches that are each a class on <html> (style.css reads them; app.js keeps
 * them in this browser under the website's key, of-a11y), a reset, and the website's statement. Hidden until app.js
 * shows it, so without script the page is the same page. The button comes before the panel, so Tab from it goes into
 * the switches. Its box is .a11y-w: .a11y is the statement link above.
 */
const A11Y_SWITCHES = [['big', 'טקסט גדול יותר'], ['contrast', 'ניגודיות גבוהה'], ['links', 'קו מתחת לקישורים'], ['still', 'לעצור תנועה']];
export const a11yWidget = () => `<div class="a11y-w" data-a11y hidden>
<button class="a11y-btn" type="button" aria-expanded="false" aria-controls="a11y-p"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="1.8"/><path d="M5 8.5l7 1.5 7-1.5M12 10v4.5M12 14.5l-3 6M12 14.5l3 6"/></svg><span class="sr">נגישות</span></button>
<div class="a11y-p" id="a11y-p" role="group" aria-labelledby="a11y-h" hidden>
<h2 id="a11y-h">נגישות</h2>
${A11Y_SWITCHES.map(([key, label]) => `<button type="button" data-a="${key}" aria-pressed="false">${label}</button>`).join('\n')}
<div class="a11y-end"><button type="button" class="a11y-reset" data-a11y-reset>לאפס</button><a href="${A11Y_URL}">הצהרת הנגישות</a></div>
</div>
</div>`;

/**
 * Where a customer writes to us: OpenFrequency's WhatsApp, OF_SUPPORT_WA (international digits, 972..., the same value
 * as accounts'), as a wa.me link. null while it is unset or not a phone number.
 */
export function supportUrl(env = process.env) {
  const digits = String(env.OF_SUPPORT_WA || '').replace(/[\s+-]/g, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

const WRITE_US = 'כתבו לנו';

/**
 * A line for the customer, escaped, with "כתבו לנו" in it a link to that WhatsApp; without one the words stay as they
 * were. Only where a page renders it as HTML: a toast, a push and an email get the words alone.
 */
export function withSupport(text, env = process.env) {
  const url = supportUrl(env);
  return url ? esc(text).replaceAll(WRITE_US, `<a href="${url}" target="_blank" rel="noopener noreferrer">${WRITE_US}</a>`) : esc(text);
}

export const icon = (name, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const SPRITE = `<svg class="sr" width="0" height="0" aria-hidden="true"><defs>
<symbol id="i-wave" viewBox="0 0 24 24"><path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 4-6 6 0"/></symbol>
<symbol id="i-today" viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/></symbol>
<symbol id="i-accounts" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.6 3 2.3 3.5 5.2"/></symbol>
<symbol id="i-results" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></symbol>
<symbol id="i-sources" viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/><path d="M9 8h7M9 11.5h5"/></symbol>
<symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="i-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11"/></symbol>
<symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
<symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/></symbol>
<symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></symbol>
<symbol id="i-logout" viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/></symbol>
<symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></symbol>
<symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></symbol>
<symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 3l1.9 5.5L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.5z"/></symbol>
<symbol id="i-text" viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"/></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></symbol>
</defs></svg>`;

// Six sections, the same on a phone (the tab bar) and on a desk (the side bar): no More tab. Home is the overview,
// Posts the cards to approve. A new account starts from Accounts, and signing out lives in Settings.
export const NAV = [
  ['/', 'היום', 'today', 'today'],
  ['/posts', 'פוסטים', 'posts', 'text'],
  ['/accounts', 'חשבון', 'accounts', 'accounts'],
  ['/results', 'תוצאות', 'results', 'results'],
  ['/sources', 'מקורות', 'sources', 'sources'],
  ['/settings', 'הגדרות', 'settings', 'settings'],
];
const SECTION_OF = { new: 'accounts', more: 'settings', topics: 'sources' };

/**
 * The account the site shows, and the menu that switches it: every account with what waits in it, and a new one.
 * One account's pages at a time; the choice is a cookie (server.js), so a switch keeps the page it was made on. The
 * closed switcher counts what waits in the other accounts, so nothing waits unseen.
 */
export function accountSwitch(ctx) {
  const all = ctx.accounts || [];
  const cur = all.find((a) => a.id === ctx.current);
  const badge = (n, label) => (n ? `<b class="badge num" aria-label="${n} ${label}">${n}</b>` : '');
  // A read-only session (the operator viewing as a customer) opens no new account.
  const newRow = ctx.readOnly ? '' : `<a class="new" href="/new"><span class="ic">${icon('plus')}</span><span class="nm">חשבון חדש</span></a>`;
  // On the page of every account (/all) the switcher says so, and each account is a link to its own home.
  if (ctx.active === 'all' && all.length) {
    const link = (a) => `<a class="to" href="/?account=${encodeURIComponent(a.id)}" title="@${esc(a.handle)}"><span class="ic">${accDot(a.id)}</span><span class="nm"><b>${esc(a.name)}</b></span>${badge(a.waiting, 'מחכים')}</a>`;
    return `<details class="acctswitch">
<summary aria-label="כל החשבונות. מעבר לחשבון אחד"><span class="ic">${icon('accounts')}</span><span class="nm"><b>כל החשבונות</b><small>${all.length === 1 ? 'חשבון אחד' : `${all.length} חשבונות`}</small></span>${icon('chev')}</summary>
<div class="menu">${all.map(link).join('')}${newRow}</div>
</details>`;
  }
  if (!cur) return '';
  const others = all.filter((a) => a.id !== cur.id);
  const waitingElsewhere = others.reduce((s, a) => s + a.waiting, 0);
  // The other accounts, as rows like the sections under them: one line, the same height and the same indent. Above
  // them, the page of every account.
  // A read-only session sends no POST at all, so its rows are links (?account= switches as the form does).
  const item = (a) => ctx.readOnly ? `<a class="to" href="/?account=${encodeURIComponent(a.id)}" title="@${esc(a.handle)}"><span class="ic">${accDot(a.id)}</span><span class="nm"><b>${esc(a.name)}</b></span>${badge(a.waiting, 'מחכים')}</a>` : `<form method="post" action="/account/switch">${csrfField(ctx)}<input type="hidden" name="to" value="${esc(a.id)}"><button type="submit" title="@${esc(a.handle)}"><span class="ic">${accDot(a.id)}</span><span class="nm"><b>${esc(a.name)}</b></span>${badge(a.waiting, 'מחכים')}</button></form>`;
  const everyRow = others.length ? `<a class="to" href="/all"><span class="ic">${icon('accounts')}</span><span class="nm"><b>כל החשבונות</b></span>${badge(cur.waiting + waitingElsewhere, 'מחכים בכל החשבונות')}</a>` : '';
  return `<details class="acctswitch">
<summary aria-label="החשבון: ${esc(cur.name)}. החלפת חשבון"><span class="ic">${accDot(cur.id)}</span><span class="nm"><b>${esc(cur.name)}</b><small class="ltr">@${esc(cur.handle)}</small></span>${waitingElsewhere ? `<b class="badge num" title="מחכים לאישור בחשבונות האחרים" aria-label="${waitingElsewhere} מחכים בחשבונות האחרים">${waitingElsewhere}</b>` : ''}${icon('chev')}</summary>
<div class="menu">${everyRow}${others.map(item).join('')}${newRow}</div>
</details>`;
}

/**
 * The operator viewing a workspace as its customer sees it (accounts' view-as): said at the top of every page, with
 * the way back to the operator's console. Nothing can change while it lasts (the server refuses every POST).
 */
export function viewAsBanner(ctx) {
  if (!ctx.readOnly) return '';
  const text = ctx.viewAs ? `אתם צופים ב-${esc(ctx.workspace?.name || '')} כמו שהלקוח רואה אותו. זו צפייה בלבד, ושום שינוי לא נשמר.` : 'זו צפייה בלבד, ושום שינוי לא נשמר.';
  const end = ctx.viewAs && ctx.links ? `<a class="btn sm" href="${esc(ctx.links.admin)}">סיום צפייה</a>` : '';
  return `<div class="banner info viewas" role="status">${icon('shield')}<div><b>${text}</b></div>${end}</div>`;
}

/** The page around a body. ctx: { title, active, csrf, quota: { used, limit }, waiting, user, accounts, current } */
export function layout(ctx, body) {
  const section = SECTION_OF[ctx.active] || ctx.active;
  const badge = (key) => (key === 'posts' && ctx.waiting ? `<b class="badge num" aria-label="${ctx.waiting} מחכים לך">${ctx.waiting}</b>` : '');
  const nav = NAV.map(([href, label, key, ic]) => `<a href="${href}" title="${label}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  const tabs = NAV.map(([href, label, key, ic]) => `<a href="${href}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  // The month's suggestions of the accounts shown (src/budget/quota.js): the ring fills as they are used, orange from
  // 75%, red from 90%, as an account's own meter does.
  const q = ctx.quota || { used: 0, limit: 0 };
  const limit = Number(q.limit) || 0;
  const taken = Number(q.used) || 0;
  const used = limit ? Math.min(100, Math.round((taken / limit) * 100)) : 0;
  const ring = `<svg class="ring${used >= 90 ? ' bad' : used >= 75 ? ' warn' : ''}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><circle class="v" cx="10" cy="10" r="8" pathLength="100" stroke-dasharray="${used} 100"/></svg>`;
  // The appearance follows the system setting: the site has no switch of its own.
  return `<!doctype html>
<html lang="he" dir="rtl"${ctx.side === 'mini' ? ' class="side-mini"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#eeeff2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111113" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-title" content="תדר">
<title>${esc(ctx.title)} · תדר</title>
<link rel="stylesheet" href="/static/style.css?v=${ctx.v || 1}">
<link rel="stylesheet" href="/static/accounts.css?v=${ctx.v || 1}">
<link rel="icon" href="/static/icon.svg?v=${ctx.v || 1}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-180.png?v=${ctx.v || 1}">
<link rel="manifest" href="/static/manifest.webmanifest">
</head>
<body${ctx.readOnly ? ' class="readonly"' : ''}>
${SPRITE}
<header class="top"><div class="wrap">
  <a class="brand" href="/" aria-label="תדר, להיום">${tederMark()}<b>תדר</b></a>
  ${accountSwitch(ctx)}
  <button class="sidetoggle" type="button" data-side aria-label="${ctx.side === 'mini' ? 'להרחיב את סרגל הצד' : 'לכווץ את סרגל הצד'}" aria-expanded="${ctx.side === 'mini' ? 'false' : 'true'}" title="${ctx.side === 'mini' ? 'להרחיב' : 'לכווץ'}">${icon('sidebar')}</button>
  <nav class="nav" aria-label="ראשי">${nav}</nav>
  <div class="tools">
    <a class="spend" href="/settings#plan" title="הצעות החודש: ${taken} מתוך ${limit}">${ring}<span class="lbl">הצעות</span><span class="amt num ltr"><b>${taken}</b><span> / ${limit}</span></span></a>
    ${ctx.links?.logout ? `<a class="logout" href="${esc(ctx.links.logout)}" title="יציאה">${icon('logout')}<span class="lbl">יציאה</span></a>` : ''}
  </div>
</div></header>
<main class="wrap" id="main">
${viewAsBanner(ctx)}
${body}
<footer class="foot">${ofMark()}<span class="ltr">OpenFrequency<sup>™</sup></span></footer>
</main>
<nav class="tabbar" aria-label="ניווט">${tabs}</nav>
<div id="toast" role="status" aria-live="polite"></div>
${a11yWidget()}
<script src="/static/app.js?v=${ctx.v || 1}" defer></script>
</body>
</html>`;
}

export const csrfField = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;

/** A small POST form: one button. opts: { cls, ajax, confirm, fields, label, title } */
export function postButton(ctx, action, label, { cls = 'btn', ajax = null, confirm = null, fields = {}, title = null, iconName = null } = {}) {
  const hidden = Object.entries(fields)
    .map(([k2, v]) => `<input type="hidden" name="${esc(k2)}" value="${esc(v)}">`)
    .join('');
  return `<form method="post" action="${esc(action)}"${ajax ? ` data-ajax="${esc(ajax)}"` : ''}>${csrfField(ctx)}${hidden}<button class="${cls}" type="submit"${confirm ? ` data-confirm="${esc(confirm)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${iconName ? icon(iconName) : ''}${label}</button></form>`;
}

export const MODE_HE = { approve: ['אישור', 'כל פוסט מחכה לך'], digest: ['תקציר', 'יוצא אם לא דחית'], auto: ['אוטומטי', 'יוצא, וסיכום יומי'] };
// A post's state on its chip, in the words of the cards (src/web/pages.js postCard): "בכתיבה" as "מצגת חדשה בכתיבה".
export const STATUS_HE = {
  drafting: ['בכתיבה', ''],
  queued: ['מחכה לאישור', 'sig'],
  approved: ['אושר', 'ok'],
  publishing: ['עולה עכשיו', 'ok'],
  drafted: ['בטיוטות של טיקטוק', 'sig'],
  published: ['פורסם', 'ok'],
  rejected: ['נדחה', 'ghost'],
  blocked: ['נעצר בבדיקות', 'bad'],
  failed: ['לא עלה', 'bad'],
  held: ['מחכה לחיבור', 'warn'],
  expired: ['לא אושר בזמן', 'ghost'],
  sample: ['דוגמה', 'warn'],
  taken_down: ['הוסר אחרי הודעה', 'bad'],
};
/** What a customer reads for a post whose stored reason is the engine's own English (a model's, a renderer's, a gate's). */
const REASON_HE = {
  blocked: 'הבדיקות שלנו עצרו את המצגת הזו בזמן הכתיבה, ולכן היא לא תעלה.',
  failed: 'המצגת לא עלתה. שמרנו את הפרטים, ואפשר לנסות שוב.',
};

/**
 * A post's reason as the page shows it: the operator reads it as it was stored; a customer reads it in Hebrew, and a
 * reason with English in it (raw text from the engine, kept in the post's steps) is said by its post's status instead.
 */
export const reasonHe = (ctx, status, reason) => (!reason || ctx.operator || !/[A-Za-z]{4,}/.test(reason) ? reason : REASON_HE[status] || 'משהו השתבש אצלנו עם המצגת הזו. כתבו לנו ונבדוק.');

export const statusChip = (s) => {
  const [he, cls] = STATUS_HE[s] || [s, ''];
  return `<span class="chip ${cls}">${esc(he)}</span>`;
};
export const accDot = (id) => `<span class="dot acc-${esc(id)}" aria-hidden="true"></span>`;
