import { getText } from '../core/net.js';
import { domainOf, readStore, siteDescription, siteName, storeOrigin } from '../demos/store.js';
import { PROMISE_MIN, PROMO_MAX, promoProblems, promoText } from '../packs/promo.js';
import { hebrewShare, normHe } from '../voice/tells.js';
import { saveSetup, setupOf } from './setup.js';

// A new account's promo (src/packs/promo.js), filled in from the store's own site while the sources are searched (the
// owner, 2026-11-02: "Fill it in automatically during setup on /new from the store's site, and the customer can edit
// it"). The site is the one optional field of /new's first form. It is read the way a store's demo is (src/demos/store.js
// readStore: Shopify, WooCommerce or Wix), and a site on none of them by its homepage alone:
//
//   name      the store's own name (Shopify's, else og:site_name or the title), not its bare domain
//   promise   the first sentence of the homepage's own description that fits a slide: Hebrew, 6 to 90 characters, and
//             no "the best", "number one" or hurry (a closing slide repeats none of it); '' when none does
//   target    the site itself, the address the customer typed: always on the store's own domain
//
// No model is asked, so nothing is spent from anyone's budget. The draft is kept on the onboarding (setup_json promo,
// promoBy 'site') unless the customer saved their own first (promoBy 'customer'), and siteRead says how it went: 'ok',
// or 'failed' when the site could not be read at all, and the customer types it. The draft is what the page offers;
// the account takes it only as the create form sends it, checked (src/web/onboarding.js).

/** A store's claims about itself a closing slide does not repeat: the best, the leading, number one, and a hurry. */
const HYPE = /(?:^| )(?:ו|ה|וה|ב|ל|מ|ש|כ)?(?:הכי|ביותר|מוביל|מובילה|מובילים|מובילות|מספר 1|נמבר 1|רק היום|לזמן מוגבל|מהרו|תמהרו|אל תפספסו|עד גמר המלאי|מבצע|סייל)(?= |$)/u;
const RANK = /#\s?1\b|\bno\.?\s?1\b|\bnumber one\b|\bbest\b/i;

const len = (s) => [...s].length;
const words = (s) => s.split(' ').filter(Boolean).length;
const trimEnd = (s) => s.replace(/[\s.,;:·•|–—-]+$/u, '').trim();

/**
 * The store's promise in its own words, from its description: '' when no sentence of it will do. Sentences end at a
 * full stop, a question mark or an exclamation mark (dropped: a promise is said plainly), and a title's separators
 * (" | ", " - ", " · ") cut one too, so "<name> - <what it sells>" gives what it sells.
 */
export function promiseFrom(description, { name = '' } = {}) {
  const text = promoText(description);
  if (!text) return '';
  const same = normHe(name);
  const parts = text
    .split(/(?<=[.!?])\s+|\s+[|·•–—-]\s+|\s*\|\s*/u)
    .map((s) => trimEnd(s.replace(/!+/g, '')))
    .filter(Boolean);
  for (let part of parts) {
    if (len(part) > PROMO_MAX.promise) {
      // A long sentence is kept to its first clauses, at a comma, when that still says something.
      const cut = part.slice(0, PROMO_MAX.promise + 1).split(/,\s*/);
      while (cut.length > 1 && len(cut.join(', ')) > PROMO_MAX.promise) cut.pop();
      part = trimEnd(cut.join(', '));
      if (len(part) > PROMO_MAX.promise) continue;
    }
    const norm = normHe(part);
    if (len(part) < PROMISE_MIN || words(part) < 3 || hebrewShare(part) < 0.6 || norm === same) continue;
    // A list of keywords ("טבעות, שרשראות, צמידים, עגילים") is no promise.
    if (part.split(',').length >= 4 && part.split(',').every((x) => words(x.trim()) <= 2)) continue;
    if (HYPE.test(norm) || RANK.test(part)) continue;
    return part;
  }
  return '';
}

/** A name to offer: the store's own, unless it is only its domain or too long for the slide. */
const nameFrom = (name, origin) => {
  const n = promoText(name);
  return n && n.toLowerCase() !== domainOf(origin) && len(n) <= PROMO_MAX.name ? n : '';
};

/**
 * The draft promo a site gives: { name, promise, target: { kind: 'site', url } }, any text it had none for left ''.
 * null for an address that is not one. `read` is readStore, and get/getPage what it reads with (fakes in the tests).
 * Throws nothing: a site that does not answer gives a draft with only its address, and `read: false` beside it.
 */
export async function readSitePromo(url, { read = readStore, get, getPage = getText } = {}) {
  const origin = storeOrigin(url);
  if (!origin) return null;
  let name = '';
  let description = '';
  let ok = true;
  try {
    const s = await read(origin, { get, getPage });
    name = s.name;
    description = s.description || '';
  } catch {
    // Not a store on Shopify, WooCommerce or Wix, or it did not answer: its homepage alone.
    const page = await getPage(origin).catch(() => null);
    const html = String(page?.body || '');
    if (html) {
      name = siteName(html) || '';
      description = siteDescription(html);
    } else ok = false;
  }
  const draft = { name: nameFrom(name, origin), promise: '', target: { kind: 'site', url: `${origin}/` } };
  draft.promise = promiseFrom(description, { name: draft.name || name });
  // What the engine fills in by itself stays on the store's own domain (src/packs/promo.js).
  if (promoProblems(draft, { domain: domainOf(origin) }).includes('domain')) draft.target = { kind: 'site', url: '' };
  return { draft, read: ok };
}

/** The reads running now, by onboarding id: the page says it is still reading. */
export const reading = new Map();

/**
 * Read an onboarding's site in the background and keep what it gave as the draft promo, unless the customer saved one
 * of their own meanwhile. Returns the job (POST /new waits for it a moment, so the page usually opens filled in).
 * `opts` reach readSitePromo (the tests' fakes); `log` gets one line for the operator when the site could not be read.
 */
export function startSiteRead(db, id, site, { opts = {}, log = null } = {}) {
  if (reading.has(id)) return reading.get(id);
  const job = readSitePromo(site, opts)
    .then((got) => {
      if (!got) return saveSetup(db, id, { siteRead: 'failed' });
      if (!got.read) log?.(`[onboarding] ${id}: the store's site ${site} did not answer; the customer writes the closing slide`);
      const mine = setupOf(db, id).promoBy === 'customer';
      return saveSetup(db, id, { siteRead: got.read ? 'ok' : 'failed', ...(mine ? {} : { promo: got.draft, promoBy: 'site' }) });
    })
    .catch((e) => {
      log?.(`[onboarding] ${id}: reading ${site} stopped: ${e.message}`);
      return saveSetup(db, id, { siteRead: 'failed' });
    })
    .finally(() => reading.delete(id));
  reading.set(id, job);
  return job;
}
