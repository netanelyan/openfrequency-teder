// Light or dark, one choice for every OpenFrequency site (the owner, 2026-11-02: "make sure that every repo starts on
// light mode. changing it on one subdomain changes it on all of the subdomains"). The choice is the cookie of-theme,
// "light" or "dark", kept for openfrequency.co.il and every subdomain under it (accounts, Teder, Toran), and each
// site's server renders the page in it before it paints (here, ui.js themeOf). No cookie, or anything else in it, is
// light; the device's own setting is never read. The button (ui.js themeButton, the website's own) flips the page at
// once, writes the cookie and gives the browser's own bar the page's colour. A module, so the tests and ui.js import
// the cookie and the colours from the one place the browser does.

export const THEME_COOKIE = 'of-theme';
// The colour the browser paints its own bar in (theme-color), the page's background in each.
export const THEME_COLOR = { light: '#eeeff2', dark: '#111113' };
const SHARED = 'openfrequency.co.il';

/**
 * The cookie that keeps the choice, as document.cookie takes it: under the company's name it is the name's and every
 * subdomain's; anywhere else (a laptop, 127.0.0.1) this host's alone. Secure when the page came over HTTPS.
 */
export function themeCookie(theme, { hostname = '', protocol = '' } = {}) {
  const host = String(hostname).toLowerCase();
  const shared = host === SHARED || host.endsWith(`.${SHARED}`);
  return `${THEME_COOKIE}=${theme === 'dark' ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Lax${shared ? `; Domain=.${SHARED}` : ''}${protocol === 'https:' ? '; Secure' : ''}`;
}

/** The choice in a Cookie header or in document.cookie: dark only when it says dark. */
export const themeFrom = (cookies) => (String(cookies || '').split(';').some((c) => c.trim() === `${THEME_COOKIE}=dark`) ? 'dark' : 'light');

if (typeof document !== 'undefined') {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
  const apply = (theme) => {
    root.setAttribute('data-theme', theme);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
    for (const b of buttons) b.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  for (const b of buttons) {
    b.classList.add('on');
    b.addEventListener('click', () => {
      const theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(theme);
      try {
        document.cookie = themeCookie(theme, location);
      } catch {
        /* a browser that keeps no cookie here: the choice holds for this page */
      }
    });
  }
  // A page kept in memory (Back), or a tab come back to, after the choice changed on another page or on another of the
  // sites: as it is now chosen. With no cookie to read (none kept, or none allowed) the page stays as it is.
  const catchUp = () => {
    let cookies = '';
    try {
      cookies = document.cookie;
    } catch {
      return;
    }
    if (!cookies.split(';').some((c) => c.trim().startsWith(`${THEME_COOKIE}=`))) return;
    const theme = themeFrom(cookies);
    if (theme !== root.getAttribute('data-theme')) apply(theme);
  };
  window.addEventListener('pageshow', (e) => e.persisted && catchUp());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && catchUp());
}
