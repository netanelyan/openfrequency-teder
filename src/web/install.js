import { esc, icon, tederMark } from './ui.js';

// Adding Teder to the phone as an app (the owner, 2026-11-09: "both toran and teder, add a little tutorial on how to add
// the website as an app to the phone"). On a phone, home shows it once, as a card that closes with its x and stays
// closed in that browser (the cookie of_install); Settings always has it, as "להוסיף לטלפון". Nothing of it is drawn
// inside the app once it is installed: style.css hides [data-install] in display-mode standalone, and static/app.js
// takes it away where only navigator.standalone says so (an iPhone's home-screen app), and remembers it. Toran has the
// same (openfrequency-toran src/web/install.ts), in its own words.
//
// The steps are each browser's own, in the words its menu shows in Hebrew, checked on 2026-11-09:
// - iPhone, Safari (support.apple.com/he-il/guide/iphone/iphea86e5236/26/ios/26, and the iOS 18 page iph42ab2f3a7):
//   "שיתוף" (on iOS 26 behind "עוד", the ⋯, unless the tabs sit at the top or the bottom), then "הוספה למסך הבית",
//   "פתיחה ביישום רשת" on (iOS 26), and "הוסף".
// - iPhone, Chrome: since iOS 16.4 another browser may offer "Add to Home Screen" in its share menu (webkit.org, Safari
//   16.4), and Chrome does, from the share button by the address. Other iPhone browsers and apps' own browsers are
//   sent to Safari, with the link to copy: whether each one offers it is not something we checked.
// - Android, Chrome (support.google.com/chrome/answer/9658361): ⋮, "התקנה ויצירת קיצור דרך", "התקנה"; an older
//   Chrome says "הוספה למסך הבית" or "התקנת האפליקציה". Where Chrome offers its own prompt (beforeinstallprompt),
//   static/app.js swaps the steps for one button, "להתקין".
// - A desk (Settings only): Chrome's install icon in the address bar, or ⋮, "הפעלת Cast, שמירה ושיתוף", "התקנת
//   הדף כאפליקציה" (the same Google page); Edge has an install icon in the address bar too.
//
// One action at most, and the main one the most prominent (the owner's rule "easy for users"): the steps say where to
// tap in the browser's own menu, so there is no button of ours to press, except "להתקין" where Chrome lets a page
// start the install, and "להעתיק את הקישור" where the steps start in another browser.

// What the phone installs is static/manifest.webmanifest, the dashboard from its home. Chrome's install criteria
// (web.dev install-criteria): a name, icons of 192 and 512, start_url and a display of standalone; no service worker
// since Chrome 108 on a phone. Its maskable icons are the mark on a full square, so a launcher's own shape cuts a colour,
// never a transparent corner, and the iPhone's icon (icon-180) is a full square too, which iOS rounds itself.

export const INSTALL_COOKIE = 'of_install';

/**
 * The browser by its user agent: 'ios-safari', 'ios-chrome', 'ios-other', 'android-chrome', 'android-other' or
 * 'desktop'. An iPad on iPadOS 13 and later says it is a Mac; that one is a desk here, and static/app.js turns it into
 * Safari's steps by its touch screen. Apps' own browsers (Instagram, Facebook, Google's app, a webview on Android)
 * cannot add a page, so they get "open it in Safari / Chrome".
 */
export function installPlatform(ua) {
  const u = String(ua || '');
  if (/iPhone|iPad|iPod/.test(u)) {
    if (/CriOS\//.test(u)) return 'ios-chrome';
    if (/FxiOS|EdgiOS|OPiOS|YaBrowser|GSA\/|FBAN|FBAV|Instagram|Line\/|WhatsApp/.test(u) || !/Version\/[\d.]+.*Safari\//.test(u)) return 'ios-other';
    return 'ios-safari';
  }
  if (/Android/.test(u)) return /Chrome\/\d/.test(u) && !/; wv\)|SamsungBrowser|EdgA|OPR\/|Firefox|YaBrowser|Instagram|FBAN|FBAV|GSA\//.test(u) ? 'android-chrome' : 'android-other';
  return 'desktop';
}

/** The request's: { platform, closed }, closed when home's card was closed or the installed app was opened in this browser. */
export const installOf = (ua, jar = {}) => ({ platform: installPlatform(ua), closed: jar[INSTALL_COOKIE] === 'hide' || jar[INSTALL_COOKIE] === 'app' });

const isPhone = (p) => p !== 'desktop';

/** A step: the button to look for, small, as the browser draws it, and what to do with it. */
const step = (ic, html, more = '') => `<li><span class="key">${icon(ic)}</span><span>${html}${more ? `<small>${more}</small>` : ''}</span></li>`;
/** An icon inside a line of text, at the text's size. */
const inl = (ic) => icon(ic, 'i inl');

/** The link to open in the other browser: static/app.js copies the page's own address and says where to open it. */
const copy = (browser) => `<button class="btn primary" type="button" data-install-copy data-done="${esc(`הקישור הועתק. עכשיו פתחו אותו ב${browser}.`)}">${icon('copy')}להעתיק את הקישור</button>`;

/** Each browser's steps; the one the server guessed shows, the rest wait hidden for static/app.js to pick another. */
function variants(shown) {
  const v = (key, inner) => `<div data-for="${key}"${key === shown ? '' : ' hidden'}>${inner}</div>`;
  return [
    v('ios-safari', `<ol class="isteps">
${step('share', 'הקישו על <b>שיתוף</b>', `לא רואים אותו? הקישו קודם על ${inl('dots')} ליד הכתובת.`)}
${step('addsq', 'גללו למטה ובחרו <b>הוספה למסך הבית</b>')}
${step('check', 'הקישו על <b>הוסף</b>', 'אם יש מתג של "פתיחה ביישום רשת", השאירו אותו דלוק.')}
</ol>`),
    v('ios-chrome', `<ol class="isteps">
${step('share', `הקישו על <b>שיתוף</b> ${inl('share')} ליד הכתובת`)}
${step('addsq', 'בחרו <b>הוספה למסך הבית</b>')}
${step('check', 'הקישו על <b>הוסף</b>')}
</ol>`),
    v('ios-other', `<p class="m0">הכי פשוט להוסיף מספארי. העתיקו את הקישור, פתחו אותו בספארי, ושם הקישו על ${inl('share')} <b>שיתוף</b> ואז <b>הוספה למסך הבית</b>.</p><div class="row mt12">${copy('ספארי')}</div>`),
    v('android-chrome', `<ol class="isteps">
${step('kebab', 'הקישו על שלוש הנקודות למעלה')}
${step('get', 'בחרו <b>התקנה ויצירת קיצור דרך</b>', 'בגרסה ישנה של כרום זה נקרא "הוספה למסך הבית".')}
${step('check', 'הקישו על <b>התקנה</b>')}
</ol>`),
    v('android-other', `<p class="m0">הכי פשוט להתקין מכרום. העתיקו את הקישור, פתחו אותו בכרום, ושם הקישו על ${inl('kebab')} ואז <b>התקנה</b>.</p><div class="row mt12">${copy('כרום')}</div>`),
    v('desktop', `<ol class="isteps">
${step('install', 'בכרום או באדג׳ לחצו על סמל ההתקנה בשורת הכתובת', 'לא רואים אותו? בתפריט ⋮ של כרום בחרו "הפעלת Cast, שמירה ושיתוף" ואז "התקנת הדף כאפליקציה".')}
</ol><p class="small muted mt12 m0">בטלפון פתחו את ההגדרות בתדר, ושם כתוב איך מוסיפים.</p>`),
    v('prompt', `<button class="btn primary" type="button" data-install-go>${icon('get')}להתקין</button>`),
  ].join('\n');
}

const WHY = 'תדר ייפתח מהאייקון כמו אפליקציה, ויוכל לשלוח לכם התראות.';

/** Home's card: on a phone, until it is closed in this browser. Nothing on a desk, or for a page that does not know the browser. */
export function installCard(install) {
  if (!install || install.closed || !isPhone(install.platform)) return '';
  return `<section class="panel install" id="install-card" data-install="card" aria-labelledby="install-h">
<header><span class="install-mark">${tederMark()}</span><div><h2 id="install-h">להוסיף את תדר למסך הבית</h2><p class="small muted m0">${esc(WHY)}</p></div><button class="x" type="button" data-install-close aria-label="לסגור">${icon('x')}</button></header>
${variants(install.platform)}
</section>`;
}

/** Settings' panel, "להוסיף לטלפון": always there (but in the installed app), with this browser's steps first. */
export function installPanel(install) {
  if (!install) return '';
  return `<section class="panel install" id="install" data-install="panel" aria-labelledby="install-p">
<header><span class="install-mark">${tederMark()}</span><div><h2 id="install-p">להוסיף לטלפון</h2><p class="small muted m0">${esc(WHY)}</p></div></header>
${variants(install.platform)}
</section>`;
}
