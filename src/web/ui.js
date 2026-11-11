// The pieces every page is made of. Pages are functions from data to HTML
// strings: no framework, so a page can be tested by reading it. Every value that
// came from outside goes through esc().
//
// HARD RULE 8: the document is lang="he" dir="rtl". A Latin run inside Hebrew
// (a handle, a URL, a product name) sits in <bdi> or .ltr so bidi cannot
// scramble the punctuation around it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../core/clock.js';
import { assetsDir } from '../core/paths.js';
import { THEME_COLOR, THEME_COOKIE } from './static/theme.js';
import { CLOSING_HE } from '../publish/errors.js';

// What a link to Teder shows when it is sent on WhatsApp or Facebook: Teder's picture and line from the website,
// openfrequency-web's og/teder.png.
const SHARE_META = `<meta name="description" content="תדר כותב ומעצב מצגות בעברית לטיקטוק, לאינסטגרם ולפייסבוק, וכל מצגת עולה רק אחרי שמישהו אישר אותה.">
<meta property="og:type" content="website"><meta property="og:site_name" content="תדר · OpenFrequency"><meta property="og:locale" content="he_IL">
<meta property="og:title" content="תדר, מצגות בעברית לטיקטוק, לאינסטגרם ולפייסבוק">
<meta property="og:description" content="תדר כותב ומעצב את המצגות, וכל מצגת עולה רק אחרי שמישהו אישר אותה.">
<meta property="og:image" content="https://openfrequency.co.il/og/teder.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`;

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
  date: fmt({ day: 'numeric', month: 'long' }),
  dateY: fmt({ day: 'numeric', month: 'long', year: 'numeric' }),
  dayY: fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  year: fmt({ year: 'numeric' }),
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
 * Light or dark: the browser's of-theme cookie, one for every OpenFrequency site (static/theme.js). Dark only when it
 * says dark; no cookie, or anything else in it, is light, and the device's own setting is never followed. Every page
 * arrives in it, the one built here and the ones that stand alone: data-theme on <html>, which style.css and demo.css
 * read, and the browser's colour-scheme and its one theme-color to match.
 */
export const themeOf = (jar) => (jar?.[THEME_COOKIE] === 'dark' ? 'dark' : 'light');
const themeIs = (theme) => (theme === 'dark' ? 'dark' : 'light');
export const htmlOpen = (theme, cls = '') => `<html lang="he" dir="rtl" data-theme="${themeIs(theme)}"${cls ? ` class="${cls}"` : ''}>`;
export const themeMeta = (theme) => `<meta name="color-scheme" content="${themeIs(theme)}"><meta name="theme-color" content="${THEME_COLOR[themeIs(theme)]}">`;
/**
 * The switch, the website's own button (openfrequency-web src/layout.mjs themeButton): a moon while light, a sun while
 * dark, one name, pressed while dark. Invisible until static/theme.js runs it (it marks it .on), so without script
 * nothing is offered; its place is kept meanwhile, so nothing beside it moves when it appears.
 */
export const themeButton = (theme) =>
  `<button class="theme" type="button" data-theme-toggle aria-pressed="${themeIs(theme) === 'dark'}" aria-label="מצב כהה"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg></button>`;
export const themeScript = (v = 1) => `<script type="module" src="/static/theme.js?v=${v}"></script>`;

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

// The icons, drawn on a 24-unit square and each centred in it, so an icon beside a label sits on the label's middle
// (the owner, 2026-11-09: "some buttons are not centered", on "✦ לעוזר": the spark spanned 3 to 17 and sat 2 units
// high, the label looking low beside it; the book of the sources reached 23 and sat 1 low, the text's lines 1 high).
// All three are moved to the centre.
const SPRITE = `<svg class="sr" width="0" height="0" aria-hidden="true"><defs>
<symbol id="i-wave" viewBox="0 0 24 24"><path d="M2 12c2.5-6 4.5-6 7 0s4.5 6 7 0 4-6 6 0"/></symbol>
<symbol id="i-today" viewBox="0 0 24 24"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/></symbol>
<symbol id="i-accounts" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.6 3 2.3 3.5 5.2"/></symbol>
<symbol id="i-results" viewBox="0 0 24 24"><path d="M6 20V10M12 20V4M18 20v-7M3 20h18"/></symbol>
<symbol id="i-sources" viewBox="0 0 24 24"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 7h7M9 10.5h5"/></symbol>
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
<symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 5l1.9 5.5L19.5 12l-5.6 1.6L12 19l-1.9-5.4L4.5 12l5.6-1.5z"/></symbol>
<symbol id="i-text" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></symbol>
<symbol id="i-inbox" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></symbol>
<symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
<symbol id="i-sidebar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><path d="M8.5 9H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1.5"/><path d="M12 3v11M8.5 6.5L12 3l3.5 3.5"/></symbol>
<symbol id="i-dots" viewBox="0 0 24 24"><path stroke-width="3" d="M5.5 12h.01M12 12h.01M18.5 12h.01"/></symbol>
<symbol id="i-kebab" viewBox="0 0 24 24"><path stroke-width="3" d="M12 5.5v.01M12 12v.01M12 18.5v.01"/></symbol>
<symbol id="i-addsq" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></symbol>
<symbol id="i-get" viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/></symbol>
<symbol id="i-install" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8.5 20.5h7M12 7.5v6M9.5 11l2.5 2.5 2.5-2.5"/></symbol>
<symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
</defs></svg>`;

// Six sections, the same on a phone (the tab bar) and on a desk (the side bar): no More tab. Home is the overview,
// Posts the cards to approve. A new account starts from Accounts, and signing out lives in Settings. The order is
// Toran's (docs/design-pro.md, "The two desks side by side"; the owner, 2026-11-10: "Toran and teder dashboards should
// be consistent"): היום, then the product's work (the posts, where they come from, the account), then the results, then
// the settings. The operator has a seventh, the leads (src/web/leads.js), before Settings, where the stores' demos are;
// they see it only on accounts' /admin/teder (accounts' docs/admin-split.md), never on Teder's own site.
export const NAV = [
  ['/', 'היום', 'today', 'today'],
  ['/posts', 'פוסטים', 'posts', 'text'],
  ['/sources', 'מקורות', 'sources', 'sources'],
  ['/accounts', 'חשבון', 'accounts', 'accounts'],
  ['/results', 'תוצאות', 'results', 'results'],
  ['/leads', 'לידים', 'leads', 'inbox', { operator: true }],
  ['/settings', 'הגדרות', 'settings', 'settings'],
];
/** The sections a page shows: the operator's own only to the operator, never in view-as. */
const navFor = (ctx) => NAV.filter(([, , , , o]) => !o?.operator || ctx.operator);
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

/**
 * The way back to the admin dashboard, on every page of Teder's under accounts' /admin/teder (ctx.admin, accounts'
 * /admin; docs/admin-split.md there): those are every workspace's pages, and the owner reaches them from there. As
 * Toran's (its ui.ts adminBar). The address is accounts' own, absolute, so the prefix never goes in front of it.
 */
export function adminBar(ctx) {
  if (!ctx.admin) return '';
  return `<div class="banner info adminbar" role="note">${icon('shield')}<div><b>כאן רואים את תדר של כל הלקוחות.</b></div><a class="btn sm" href="${esc(ctx.admin)}">חזרה ללוח הניהול</a></div>`;
}

/**
 * The reminder to pay for the next month (src/billing/entitlement.js payReminder), each state's two lines: the last
 * week paid for, calm, and the days of grace after it, in the warning's colour. The day is Israel's, of accounts' own
 * instant; its year only when it is not this year's.
 */
export const PAY_HE = {
  soon: { title: (date) => `המנוי לתדר שולם עד ${date}.`, text: () => 'אפשר כבר לשלם על החודש הבא, כדי שתדר ימשיך לעבוד בלי הפסקה.' },
  due: { title: () => 'החודש ששילמתם עליו נגמר, והתשלום על החודש הבא עוד לא הגיע אלינו.', text: (day) => `תדר ממשיך לעבוד עד סוף ${day}, ואז ייעצר עד שהתשלום יגיע.` },
  button: 'איך משלמים',
};
const sameYear = (a, b) => F.year.format(new Date(a)) === F.year.format(new Date(b));
/** "10 בנובמבר" (the date) or "יום שלישי, 10 בנובמבר" (with its day), in Israel time. */
export const untilHe = (iso, { weekday = false, t = now() } = {}) => (sameYear(iso, t) ? (weekday ? F.day : F.date) : weekday ? F.dayY : F.dateY).format(new Date(iso));

/**
 * The reminder at the top of every page of a customer's workspace (ctx.pay, from server.js: payReminder of the check's
 * answer, or null), with one way to pay: the paywall's own, accounts' /setup page.
 */
export function payBanner(ctx) {
  const r = ctx.pay;
  if (!r || !PAY_HE[r.state] || !ctx.links?.setup) return '';
  const due = r.state === 'due';
  const when = untilHe(r.until, { weekday: due });
  const he = PAY_HE[r.state];
  return `<div class="banner ${due ? 'warn' : 'info'} pay" id="pay">${icon(due ? 'alert' : 'clock')}<div><b>${esc(he.title(when))}</b><p>${esc(he.text(when))}</p></div><a class="btn sm${due ? ' primary' : ''}" href="${esc(ctx.links.setup)}">${esc(PAY_HE.button)}</a></div>`;
}

/**
 * What makes a page the app a phone keeps: on Teder's own site only. Under accounts' /admin/teder (ctx.admin) a saved
 * icon would open accounts (the manifest's start_url is the site's root), so those pages offer none, as Toran's under
 * /admin/toran (accounts' docs/admin-split.md).
 */
const APP_META = `<meta name="apple-mobile-web-app-title" content="תדר">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
`;

/** The page around a body. ctx: { title, active, csrf, quota: { used, out, limit }, waiting, user, accounts, current } */
export function layout(ctx, body) {
  const section = SECTION_OF[ctx.active] || ctx.active;
  const badge = (key) => (key === 'posts' && ctx.waiting ? `<b class="badge num" aria-label="${ctx.waiting} מחכים לך">${ctx.waiting}</b>` : '');
  const nav = navFor(ctx).map(([href, label, key, ic]) => `<a href="${href}" title="${label}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  const tabs = navFor(ctx).map(([href, label, key, ic]) => `<a href="${href}"${key === section ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge(key)}</a>`).join('');
  // The month's posts of the accounts shown, the ones already out of the plan's (src/budget/quota.js): "פורסמו X / 40".
  // The promise is posts the customer got (the owner, 2026-11-09: "because we promise 40 videos a month, there cant be
  // a day without posts"), so the ring fills as they go out and a full one is the month kept, never a warning: no
  // orange or red here any more, as there was while it counted suggestions used up.
  const q = ctx.quota || { used: 0, out: 0, limit: 0 };
  const limit = Number(q.limit) || 0;
  const taken = Number(q.out ?? q.used) || 0;
  const used = limit ? Math.min(100, Math.round((taken / limit) * 100)) : 0;
  const ring = `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><circle class="v" cx="10" cy="10" r="8" pathLength="100" stroke-dasharray="${used} 100"/></svg>`;
  // Light or dark as the browser chose on any of the sites (themeOf); the switch is in the bar on every page, between
  // the month's count and signing out on a phone, on the sign-out row at the foot of the side bar on a desk.
  return `<!doctype html>
${htmlOpen(ctx.theme, ctx.side === 'mini' ? 'side-mini' : '')}
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${themeMeta(ctx.theme)}
${ctx.admin ? '' : APP_META}<title>${esc(ctx.title)} · תדר</title>
${SHARE_META}
<link rel="stylesheet" href="/static/style.css?v=${ctx.v || 1}">
<link rel="stylesheet" href="/static/accounts.css?v=${ctx.v || 1}">
<link rel="icon" href="/static/icon.svg?v=${ctx.v || 1}" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icon-180.png?v=${ctx.v || 1}">
${ctx.admin ? '' : '<link rel="manifest" href="/static/manifest.webmanifest">\n'}</head>
<body${ctx.readOnly ? ' class="readonly"' : ''}>
${SPRITE}
<header class="top"><div class="wrap">
  <a class="brand" href="/" aria-label="תדר, להיום">${tederMark()}<b>תדר</b></a>
  ${accountSwitch(ctx)}
  <button class="sidetoggle" type="button" data-side aria-label="${ctx.side === 'mini' ? 'להרחיב את סרגל הצד' : 'לכווץ את סרגל הצד'}" aria-expanded="${ctx.side === 'mini' ? 'false' : 'true'}" title="${ctx.side === 'mini' ? 'להרחיב' : 'לכווץ'}">${icon('sidebar')}</button>
  <nav class="nav" aria-label="ראשי">${nav}</nav>
  <div class="tools">
    <a class="spend" href="/settings#plan" title="פורסמו ${taken} מתוך ${limit} החודש">${ring}<span class="lbl">פורסמו</span><span class="amt num ltr"><b>${taken}</b><span> / ${limit}</span></span></a>
    ${themeButton(ctx.theme)}
    ${ctx.links?.logout ? `<a class="logout" href="${esc(ctx.links.logout)}" title="יציאה">${icon('logout')}<span class="lbl">יציאה</span></a>` : ''}
  </div>
</div></header>
<main class="wrap" id="main">
${adminBar(ctx)}${viewAsBanner(ctx)}
${payBanner(ctx)}
${body}
<footer class="foot">${ofMark()}<span class="ltr">OpenFrequency<sup>™</sup></span></footer>
</main>
<nav class="tabbar" aria-label="ניווט">${tabs}</nav>
<div id="toast" role="status" aria-live="polite"></div>
${a11yWidget()}
${themeScript(ctx.v || 1)}
<script src="/static/app.js?v=${ctx.v || 1}" defer></script>
</body>
</html>`;
}

export const csrfField = (ctx) => `<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}">`;

/**
 * A part of a page that folds away on a phone (the owner, 2026-11-05, on an iPhone: "too many things jump to the eyes
 * at the same time"): there it is one row with its name, opened with a tap; from 700px it is open and the row is not
 * drawn, so a wider screen shows the page as it was. static/app.js folds it as a phone opens the page, except the one a
 * link points into, one with a problem to fix in it and one that was open before the page came back (a save reloads
 * it); without the script it stays open, its row still a way to fold it. `key` names it on its page. `one`: a single
 * panel, whose own heading the row stands for on a phone; `inCard`: inside a post's card, a row like the card's own
 * folds (the captions, the facts). `cls`, a class of its own. Nothing, for nothing inside.
 */
export const fold = (key, label, inner, { one = true, inCard = false, cls = '' } = {}) =>
  inner ? `<details class="mfold${one ? ' one' : ''}${inCard ? ' in' : ''}${cls ? ` ${cls}` : ''}" data-mfold="${esc(key)}" open><summary>${esc(label)}</summary>${inner}</details>` : '';

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
  // Waiting for its hour, and on its way: blue, as what waits is; green is for what went out (the owner's colours:
  // published green, blocked red, waiting blue).
  approved: ['אושר', 'sig'],
  publishing: ['עולה עכשיו', 'sig'],
  drafted: ['בטיוטות של טיקטוק', 'sig'],
  published: ['פורסם', 'ok'],
  // Published, but only written to disk: nothing of it left the server (src/publish/live.js shownStatus).
  written: ['לא נשלח', 'warn'],
  rejected: ['נדחה', 'ghost'],
  // Rejected, from the schedule: the owner deleted it before it went out (src/publish/live.js shownStatus).
  deleted: ['נמחק', 'ghost'],
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

/** A customer's own words on a post (a decline's reason and note, a takedown notice they recorded): theirs, in any letters. */
const THEIRS = ['rejected', 'taken_down'];
/** What a blocked post says to a customer in its own words: the closing slide's and the fact check's, which say what to do. */
const BLOCKED_SAID = [CLOSING_HE, 'בדיקת העובדות עצרה את המצגת'];

/**
 * A post's reason as the page shows it: the operator reads it as it was stored; a customer reads it in Hebrew, and a
 * reason with English in it (raw text from the engine, kept in the post's steps) is said by its post's status instead.
 * A post our checks stopped while it was written says so in one line: what stopped it ("אין תמונה מורשית של X",
 * "נשמע כמו בוט (7/10) גם אחרי שכתוב") is ours (the audit, 2026-11-12). What the customer wrote is never replaced:
 * a decline in English, or a notice an English firm sent, read "משהו השתבש אצלנו".
 */
export const reasonHe = (ctx, status, reason) => {
  if (!reason || ctx.operator || THEIRS.includes(status)) return reason;
  if (status === 'blocked' && !BLOCKED_SAID.some((k) => String(reason).startsWith(k))) return REASON_HE.blocked;
  return /[A-Za-z]{4,}/.test(reason) ? REASON_HE[status] || 'משהו השתבש אצלנו עם המצגת הזו. כתבו לנו ונבדוק.' : reason;
};

export const statusChip = (s) => {
  const [he, cls] = STATUS_HE[s] || [s, ''];
  return `<span class="chip ${cls}">${esc(he)}</span>`;
};
export const accDot = (id) => `<span class="dot acc-${esc(id)}" aria-hidden="true"></span>`;
