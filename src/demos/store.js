import { getJson, getText } from '../core/net.js';
import { decodeEntities, titleOf } from '../sources/text.js';

// A store, read for its demo: its name, its currency, its products with their photographs, prices and stock, its
// categories, its colour (the homepage's theme-color) and its logo. Three platforms, each from what it publishes
// for anyone to read, with no key and no sign-in:
//
//   Shopify       the store summary (/meta.json) and the catalogue (/products.json, /collections.json)
//   WooCommerce   the Store API (/wp-json/wc/store/v1/products), which WooCommerce serves to every visitor; when a
//                 store has turned it off, its sitemap and each product page's schema.org Product (JSON-LD)
//   Wix           its sitemap (/sitemap.xml, then the store's products sitemap) and each product page's JSON-LD
//
// The platform is read from the homepage (Shopify's CDN, WooCommerce's classes, Wix's generator line); a homepage that
// names none is tried as each in turn. Product pages are read one after another, MAX_PAGES at most. Every platform's
// products come out in one shape (Shopify's own: title, product_type, images[].src, variants[].price and .available),
// so the demo, its document and its page never ask which platform it was. Any other platform is told so, plainly.
//
// The store's document is its catalogue written out as lines: its categories, its price range, each product with
// its price. The demo's last slide, which sends the reader to the store, may quote it word for word, so a number
// about the store is a number the store published. Its products' pictures move past beside the title on its page.

export class DemoError extends Error {}

export const PLATFORMS = ['shopify', 'woocommerce', 'wix'];
/** The most product pages read from a sitemap: a demo needs a shelf, not the whole shop, and each page is a request. */
export const MAX_PAGES = 24;

/** The store's homepage as https://host, or null for something that is not an address. */
export function storeOrigin(input) {
  const t = String(input || '').trim();
  if (!t || /\s/.test(t)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return `https://${u.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export const domainOf = (origin) => new URL(origin).hostname.replace(/^www\./, '');

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// 289 or 289.9, as a shop writes it: no trailing .00.
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const clean = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const unique = (xs) => [...new Set(xs.filter(Boolean))];

/** The platform a homepage was built on, from what each one writes into every page: 'shopify', 'woocommerce', 'wix' or null. */
export function platformOf(html) {
  const h = String(html || '');
  if (/cdn\.shopify\.com|Shopify\.theme|shopify-section/i.test(h)) return 'shopify';
  if (/woocommerce|wc-block-|\/wp-json\/wc\//i.test(h)) return 'woocommerce';
  if (/static\.wixstatic\.com|static\.parastorage\.com|content=["']Wix\.com Website Builder/i.test(h)) return 'wix';
  return null;
}

/**
 * A homepage's own name for the store: og:site_name, else its title, the first part of either that is not "home". A
 * name that is a list of keywords ("name necklaces | silver rings | bracelets | ...", three parts or more) is no name: null.
 */
export function siteName(html) {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i.exec(html)?.[1];
  for (const text of [og, titleOf(html)]) {
    const parts = clean(text).split(/\s[|–—-]\s|[|–—]/).map((x) => x.trim()).filter((x) => x && !/^(ראשי|דף הבית|עמוד הבית|בית|home|home ?page)$/i.test(x));
    if (parts.length >= 3) return null;
    if (parts[0]) return parts[0];
  }
  return null;
}

const NAMES = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix' };

/**
 * Read a store on Shopify, WooCommerce or Wix. get/getPage are injectable (tests). Throws DemoError with a sentence
 * for the operator. Returns { origin, domain, platform, name, currency, accent, products, collections, logo }.
 */
export async function readStore(url, { get = getJson, getPage = getText } = {}) {
  const origin = storeOrigin(url);
  if (!origin) throw new DemoError('הכתובת של החנות לא תקינה');
  const page = await getPage(origin).catch(() => null);
  const html = String(page?.body || '');
  const named = platformOf(html);
  let read = null;
  for (const platform of named ? [named] : PLATFORMS) {
    read = await READERS[platform](origin, { get, getPage }).catch(() => null);
    if (read?.products?.length) break;
    read = null;
  }
  if (!read) {
    throw new DemoError(
      named
        ? `לא הצלחנו לקרוא את המוצרים מהחנות ב-${NAMES[named]}: הקטלוג שלה לא פתוח לקריאה, או שהאתר לא ענה`
        : 'לא הצלחנו לקרוא את המוצרים: אנחנו קוראים חנויות ב-Shopify, ב-WooCommerce וב-Wix, והחנות הזו לא נראית כמו אחת מהן, או שהאתר לא ענה'
    );
  }
  const accent = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{6})["']/i.exec(html)?.[1] || null;
  const name = String(read.name || siteName(html) || domainOf(origin)).trim();
  return { origin, domain: domainOf(origin), platform: read.platform, name, currency: read.currency || 'ILS', accent, products: read.products, collections: read.collections || [], logo: logoOf(html, origin, name) };
}

const READERS = { shopify: readShopify, woocommerce: readWooCommerce, wix: readWix };

/** Shopify: the public catalogue, the store's summary for its name and currency, and its collections. */
async function readShopify(origin, { get }) {
  const catalogue = await get(`${origin}/products.json?limit=100`);
  const products = Array.isArray(catalogue?.products) ? catalogue.products : null;
  if (!products) return null;
  const meta = await get(`${origin}/meta.json`).catch(() => null);
  const cols = await get(`${origin}/collections.json?limit=50`).catch(() => null);
  const collections = (Array.isArray(cols?.collections) ? cols.collections : [])
    .map((c) => String(c.title || '').trim())
    .filter((t) => t && !/^(all|home ?page|frontpage|הכל|כל המוצרים)$/i.test(t));
  return { platform: 'shopify', name: meta?.name || null, currency: meta?.currency || null, products, collections };
}

/**
 * One product of WooCommerce's Store API, in the shared shape. Its prices are strings in the currency's minor unit
 * ("25400" with currency_minor_unit 2 is 254); a variable product has a price range, kept as its lowest and highest.
 */
export function wooProduct(p) {
  const pr = p?.prices || {};
  const minor = Number.isInteger(Number(pr.currency_minor_unit)) ? Number(pr.currency_minor_unit) : 2;
  const amount = (v) => (v == null || v === '' ? null : Number(v) / 10 ** minor);
  const range = pr.price_range;
  const prices = (range ? [amount(range.min_amount), amount(range.max_amount)] : [amount(pr.price)]).filter((x) => money(x));
  const available = p?.is_in_stock !== false && p?.is_purchasable !== false;
  return {
    id: p?.id,
    title: clean(p?.name),
    product_type: clean(p?.categories?.[0]?.name) || null,
    tags: (p?.tags || []).map((t) => clean(t.name)).filter(Boolean),
    url: p?.permalink || null,
    images: (p?.images || []).map((i) => ({ src: i?.src })).filter((i) => i.src),
    variants: unique(prices.map(String)).map((price) => ({ price, available })),
  };
}

/** WooCommerce: the Store API, open to every visitor; a store that turned it off is read from its sitemap instead. */
async function readWooCommerce(origin, { get, getPage }) {
  const list = await get(`${origin}/wp-json/wc/store/v1/products?per_page=100`).catch(() => null);
  if (Array.isArray(list) && list.length) {
    return {
      platform: 'woocommerce',
      currency: list.find((p) => p?.prices?.currency_code)?.prices.currency_code || null,
      products: list.map(wooProduct).filter((p) => p.title),
      collections: unique(list.flatMap((p) => (p?.categories || []).map((c) => clean(c.name)))).filter((t) => !/^(uncategorized|ללא קטגוריה)$/i.test(t)),
    };
  }
  // WordPress's own sitemap, then Yoast's and Rank Math's index, then a plain one.
  return { platform: 'woocommerce', ...(await fromSitemaps(origin, { getPage, maps: ['/wp-sitemap.xml', '/sitemap_index.xml', '/product-sitemap.xml', '/sitemap.xml'] })) };
}

/** Wix: the store's products sitemap, and each product page as it describes itself. */
async function readWix(origin, { getPage }) {
  return { platform: 'wix', ...(await fromSitemaps(origin, { getPage, maps: ['/sitemap.xml'] })) };
}

const locsOf = (xml) => [...String(xml || '').matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeEntities(m[1].trim()));
// A sitemap of products (Wix's store-products-sitemap.xml, WordPress's wp-sitemap-posts-product-1.xml, Yoast's and
// Rank Math's product-sitemap.xml), never of their categories or tags.
const PRODUCT_MAP = /product/i;
const NOT_PRODUCTS = /product[_-]?(cat|tag|brand)|categor|taxonom/i;
// A product page's address on any of them: /product/<slug>, /products/<slug>, Wix's /product-page/<slug>.
const PRODUCT_PAGE = /\/(products?|product-page)\/[^/?#]+/i;

/**
 * The products a store's sitemaps lead to, read from each product page's JSON-LD. maps: the sitemaps to try, in order,
 * until one leads to product pages. Returns { currency, products, collections }, products empty when none was found.
 */
export async function fromSitemaps(origin, { getPage, maps, limit = MAX_PAGES }) {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const ours = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  };
  const xmlOf = (u) => getPage(u, { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' }).then((r) => String(r?.body || '')).catch(() => '');
  let pages = [];
  for (const m of maps) {
    const xml = await xmlOf(`${origin}${m}`);
    if (!xml) continue;
    if (/<sitemapindex/i.test(xml)) {
      for (const child of locsOf(xml).filter((u) => ours(u) && PRODUCT_MAP.test(u) && !NOT_PRODUCTS.test(u)).slice(0, 3)) {
        pages.push(...locsOf(await xmlOf(child)).filter(ours));
        if (pages.length >= limit) break;
      }
    } else {
      pages.push(...locsOf(xml).filter((u) => ours(u) && (PRODUCT_MAP.test(m) || PRODUCT_PAGE.test(new URL(u).pathname))));
    }
    if (pages.length) break;
  }
  pages = unique(pages).slice(0, limit);
  const products = [];
  for (const u of pages) {
    const page = await getPage(u).catch(() => null);
    const p = productFromLd(String(page?.body || ''), u);
    if (p) products.push(p);
  }
  return {
    currency: products.find((p) => p.currency)?.currency || null,
    products,
    collections: unique(products.map((p) => p.product_type)),
  };
}

/** Every JSON-LD node in a page: arrays and @graph opened up. */
function ldNodes(html) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    out.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  for (const m of String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      // a block that is not JSON: the next one
    }
  }
  return out;
}

const typeIs = (n, t) => [].concat(n?.['@type'] || []).some((x) => String(x).toLowerCase() === t);
const imageSrc = (img) => (typeof img === 'string' ? img : img?.contentUrl || img?.url || null);

/**
 * A product page's schema.org Product, in the shared shape, or null for a page that has none or no price. An offer's
 * price is read from price, from lowPrice and highPrice (an AggregateOffer), or from its priceSpecification.
 */
export function productFromLd(html, url = null) {
  const node = ldNodes(html).find((n) => typeIs(n, 'product') || typeIs(n, 'productgroup'));
  if (!node) return null;
  const offers = [].concat(node.offers || []).flatMap((o) => [o, ...[].concat(o?.offers || [])]);
  const prices = [];
  let currency = null;
  let available = false;
  for (const o of offers) {
    for (const v of [o?.price, o?.lowPrice, o?.highPrice, ...[].concat(o?.priceSpecification || []).map((s) => s?.price)]) if (money(v)) prices.push(Number(v));
    currency ||= o?.priceCurrency || [].concat(o?.priceSpecification || [])[0]?.priceCurrency || null;
    if (!o?.availability || /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(String(o.availability))) available = true;
  }
  const images = unique([].concat(node.image || []).map(imageSrc)).filter((s) => /^https:\/\//i.test(s));
  const title = clean(node.name);
  if (!title || !prices.length) return null;
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return {
    id: String(node.sku || node.productID || node['@id'] || url || title),
    title,
    product_type: clean([].concat(node.category || [])[0]?.name ?? [].concat(node.category || [])[0]) || null,
    url: url || node.url || null,
    images: images.map((src) => ({ src })),
    variants: unique([lo, hi].map(String)).map((price) => ({ price, available })),
    currency,
  };
}

/**
 * The store's logo, from its homepage: the first picture whose class, name or file says logo, or whose text is the
 * store's name (a Shopify theme's header logo is both). Its address on the store's own CDN, or null.
 */
export function logoOf(html, origin, name = '') {
  for (const [tag] of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const attr = (k) => new RegExp(`\\s${k}=["']([^"']*)["']`, 'i').exec(tag)?.[1] || '';
    const src = attr('src').replace(/&amp;/g, '&');
    if (!src || /^data:/i.test(src)) continue;
    const alt = attr('alt').trim();
    if (!/logo/i.test(`${attr('class')} ${src} ${alt}`) && !(name && alt === name)) continue;
    try {
      const u = new URL(src.startsWith('//') ? `https:${src}` : src, origin);
      if (u.protocol !== 'https:' || /\.svg$/i.test(u.pathname)) continue;
      u.searchParams.delete('width');
      return u.href;
    } catch {
      // an address that does not parse: the next picture
    }
  }
  return null;
}

const priceOf = (p) => {
  const prices = (p.variants || []).map((v) => money(v.price)).filter(Boolean);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null;
};

/** The products a demo may show: with a photograph, a price and something in stock, the newest first. */
export function usable(products) {
  return (products || [])
    .filter((p) => p?.images?.[0]?.src && priceOf(p) && (p.variants || []).some((v) => v.available !== false))
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
}

const MAX_PRODUCTS = 60;

/** The store's document: its catalogue as lines. { key: 'store', url, title, text }. */
export function storeDocument(store) {
  const cur = store.currency === 'ILS' ? '₪' : store.currency;
  const list = usable(store.products).slice(0, MAX_PRODUCTS);
  const lines = [`${store.name} היא חנות אונליין בכתובת ${store.domain}.`];
  if (store.collections?.length) lines.push(`הקטגוריות באתר: ${store.collections.slice(0, 30).join(', ')}.`);
  const prices = list.map(priceOf).filter(Boolean);
  if (prices.length) {
    const lo = Math.min(...prices.map((p) => p.min));
    const hi = Math.max(...prices.map((p) => p.max));
    lines.push(lo === hi ? `המחירים באתר: ${num(lo)} ${cur}.` : `המחירים באתר: מ-${num(lo)} ${cur} עד ${num(hi)} ${cur}.`);
  }
  for (const p of list) {
    const pr = priceOf(p);
    const type = p.product_type ? ` (${String(p.product_type).trim()})` : '';
    lines.push(`${String(p.title).trim()}${type}: ${pr.min === pr.max ? `${num(pr.min)} ${cur}` : `מ-${num(pr.min)} ${cur}`}.`);
  }
  return { key: 'store', url: store.origin, title: store.name, text: lines.join('\n') };
}

/** The catalogue as the topic's chooser reads it: one line per product, with its id. */
export const catalogueLines = (store) =>
  usable(store.products)
    .slice(0, MAX_PRODUCTS)
    .map((p) => `${p.id} | ${String(p.title).trim()}${p.product_type ? ` | ${p.product_type}` : ''}${[].concat(p.tags || []).length ? ` | ${[].concat(p.tags).slice(0, 6).join(', ')}` : ''}`)
    .join('\n');

/** What the store's page says was read: { products, images, categories, low, high }. */
export function storeStats(store) {
  const list = usable(store.products);
  const prices = list.map(priceOf);
  return {
    products: list.length,
    images: list.reduce((n, p) => n + (p.images || []).length, 0),
    categories: (store.collections || []).length,
    low: prices.length ? Math.min(...prices.map((p) => p.min)) : null,
    high: prices.length ? Math.max(...prices.map((p) => p.max)) : null,
  };
}

/** The products that move past beside the title on the store's page: [{ title, price, src }], the newest first. */
export const shelfOf = (store, n = 12) =>
  usable(store.products)
    .slice(0, n)
    .map((p) => ({ title: String(p.title).trim(), price: priceOf(p).min, src: String(p.images[0].src) }));
