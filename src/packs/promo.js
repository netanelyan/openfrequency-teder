// What an account's slideshows send people to (the owner, 2026-11-02: "every slideshow ends with a closing slide that
// sends people to the customer's site or product"). It is the account's own, kept in pack.json "promo" beside its
// style and its closing line (endSlide), written by the website the way the style is (src/packs/write.js):
//
//   promo: {
//     name      the store or the business, as the closing slide names it (1 to 40 characters)
//     promise   what the viewer gets there, one sentence in the customer's own words (6 to 90 characters)
//     target    where the slide sends them, one of
//                 { kind: 'site', url }            the store's site, an https address
//                 { kind: 'product', name, url }   one product: its name (1 to 60 characters) and its page (https)
//                 { kind: 'bio' }                  "link in bio": the link on the account's own profile
//   }
//
// NO PROMO is a state of its own, not a gap: a pack without the key (every pack written before it), or with null,
// sends people to follow the account (closingOf: { kind: 'follow', handle }). Our own accounts have none.
//
// A customer's is filled in on /new from their store's site (src/onboarding/promo.js) and changed on Settings
// (src/web/promo.js). An address the engine fills in by itself is on the store's own domain (promoProblems' `domain`);
// one the customer typed may be anywhere, kept as https (an http:// one is upgraded). Text is kept as it goes on a slide: no control or direction
// marks, one space between words, trimmed.

export const PROMO_MAX = { name: 40, promise: 90, product: 60, url: 300 };
export const PROMISE_MIN = 6;
export const TARGETS = ['site', 'product', 'bio'];
/** The closing slide's two meanings: an account with a promo sends people to it, one without asks them to follow. */
export const CLOSING = { promo: 'promo', follow: 'follow' };

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const len = (s) => [...s].length;
// A host as the address bar shows one: letters, digits and dashes, a dot, and a top-level name (punycode too).
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/i;

/** Text as it goes on a slide: control and direction marks out, one space between words, trimmed. */
export const promoText = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * An https address as typed: "shop.co.il" is https://shop.co.il/, and "http://shop.co.il" is too, silently (the follow-up
 * on item 1, 2026-11-02: "An http:// address the customer types is upgraded to https:// silently instead of refused"). { url }
 * (normalised), or { problem } with 'missing' or 'url' (no address at all: another scheme, a sign-in, a port, no real
 * host).
 */
export function httpsUrl(input) {
  const t = String(input ?? '').trim();
  if (!t) return { problem: 'missing' };
  if (/\s/.test(t) || len(t) > PROMO_MAX.url) return { problem: 'url' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return { problem: 'url' };
  }
  // A port on http:// is refused like any port; port 80 is http's own and the URL already dropped it.
  if (u.protocol === 'http:' && !u.port) u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOST.test(u.hostname)) return { problem: 'url' };
  return { url: u.href };
}

/** An address's host without "www.", lower case; null for no address. */
export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** Is this address on the store's domain (the domain itself or one of its subdomains)? */
export const onDomain = (url, domain) => {
  const h = hostOf(url);
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  return Boolean(h && d && (h === d || h.endsWith(`.${d}`)));
};

/**
 * What is wrong with a promo, as codes (an empty list: nothing; null and undefined are no promo, which is fine):
 *   shape        not an object
 *   name         no name                     nameLong      over PROMO_MAX.name
 *   promise      under PROMISE_MIN           promiseLong   over PROMO_MAX.promise
 *   target       no target, or not site, product or bio
 *   product      a product with no name      productLong   its name over PROMO_MAX.product
 *   siteUrl      a site with no address      productUrl    a product with no address
 *   url          not an address (an http:// one is upgraded to https, never refused)
 *   domain       an address off `domain`, the store's (checked only when it is given: what the engine fills in itself)
 */
export function promoProblems(p, { domain = null } = {}) {
  if (p == null) return [];
  if (!isObj(p)) return ['shape'];
  const out = [];
  const name = promoText(p.name);
  if (!name) out.push('name');
  else if (len(name) > PROMO_MAX.name) out.push('nameLong');
  const promise = promoText(p.promise);
  if (len(promise) < PROMISE_MIN) out.push('promise');
  else if (len(promise) > PROMO_MAX.promise) out.push('promiseLong');
  const t = p.target;
  if (!isObj(t) || !TARGETS.includes(t.kind)) return [...out, 'target'];
  if (t.kind === 'product') {
    const pn = promoText(t.name);
    if (!pn) out.push('product');
    else if (len(pn) > PROMO_MAX.product) out.push('productLong');
  }
  if (t.kind !== 'bio') {
    const u = httpsUrl(t.url);
    if (u.problem === 'missing') out.push(t.kind === 'site' ? 'siteUrl' : 'productUrl');
    else if (u.problem) out.push(u.problem);
    else if (domain && !onDomain(u.url, domain)) out.push('domain');
  }
  return out;
}

const EN = {
  shape: 'promo is { name, promise, target }, or left out (the closing slide then asks to follow the account)',
  name: 'promo.name is required',
  nameLong: `promo.name is over ${PROMO_MAX.name} characters`,
  promise: `promo.promise says what the viewer gets, at least ${PROMISE_MIN} characters`,
  promiseLong: `promo.promise is over ${PROMO_MAX.promise} characters`,
  target: `promo.target is { kind: ${TARGETS.join(' | ')} }`,
  product: 'promo.target is a product: it needs a name',
  productLong: `promo.target.name is over ${PROMO_MAX.product} characters`,
  siteUrl: 'promo.target is a site: it needs its https url',
  productUrl: "promo.target is a product: it needs its page's https url",
  url: 'promo.target.url is not an https address (no other scheme, sign-in or port)',
  domain: "promo.target.url is not on the store's domain",
};

/** A pack's promo checked as every pack is (src/packs/validate.js): one English line a problem. */
export const promoConfigProblems = (p) => promoProblems(p).map((code) => `pack.json: ${EN[code]}`);

/** A valid promo as it is kept: its text cleaned, its address normalised, only its target's own fields. */
export function cleanPromo(p) {
  const kind = p.target.kind;
  const target = kind === 'bio' ? { kind } : kind === 'site' ? { kind, url: httpsUrl(p.target.url).url } : { kind, name: promoText(p.target.name), url: httpsUrl(p.target.url).url };
  return { name: promoText(p.name), promise: promoText(p.promise), target };
}

/** The account's promo, cleaned, or null for none (no key, null, or a hand edit that would not pass). */
export function promoOf(pack) {
  const p = pack?.meta?.promo;
  return p != null && !promoProblems(p).length ? cleanPromo(p) : null;
}

/**
 * What the account's last slide sends people to: { kind: 'promo', name, promise, target } with a promo, or
 * { kind: 'follow', handle } without one, every account's own handle.
 */
export function closingOf(pack) {
  const p = promoOf(pack);
  return p ? { kind: CLOSING.promo, ...p } : { kind: CLOSING.follow, handle: pack?.meta?.handle || null };
}
