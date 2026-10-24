import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoError, fromSitemaps, MAX_PAGES, platformOf, productFromLd, readStore, shelfOf, siteName, storeDocument, storeStats, wooProduct } from '../src/demos/store.js';

// A store read for its demo on Shopify, WooCommerce or Wix (src/demos/store.js), from recordings of fictional stores
// (test/fixtures/stores, on .example): each response is in the shape recorded from real Israeli stores on 2026-10-24
// and trimmed (a homepage cut to its title, its meta lines, the line that names its platform and its logo; a few
// products; product pages cut to their schema.org Product), with made-up names, products, prices and addresses. The
// real stores stay private. The recorded client answers what was recorded and nothing else: a request it does not
// hold is a 404, as a missing page would be.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stores');
const fixture = (domain) => JSON.parse(readFileSync(path.join(DIR, `${domain}.json`), 'utf8'));

/** A recorded store: get and getPage as readStore takes them, every request kept in `asked`. `refuse` answers 401. */
function recorded(domain, { refuse = null } = {}) {
  const { store, responses } = fixture(domain);
  const asked = [];
  const missing = (u, status = 404) => Object.assign(new Error(`HTTP ${status}: ${u}`), { status });
  return {
    store,
    asked,
    get: async (u) => {
      asked.push(u);
      if (refuse?.test(u)) throw missing(u, 401);
      const r = responses[u];
      if (r?.json === undefined) throw missing(u, r?.status);
      return structuredClone(r.json);
    },
    getPage: async (u) => {
      asked.push(u);
      const r = responses[u];
      if (r?.text === undefined) throw missing(u, r?.status);
      return { body: r.text, finalUrl: u };
    },
  };
}

test('the platform is read from the homepage: Shopify, WooCommerce and Wix by what each writes into every page', () => {
  const home = (d) => fixture(d).responses[fixture(d).store].text;
  assert.equal(platformOf(home('kelim-yafim.example')), 'shopify');
  for (const d of ['shmot-bekesef.example', 'hamitbach-shel-dorit.example', 'shetach-patuach.example']) assert.equal(platformOf(home(d)), 'woocommerce', d);
  for (const d of ['shloshet-haetzim.example', 'mazkarot-mehaaretz.example']) assert.equal(platformOf(home(d)), 'wix', d);
  assert.equal(platformOf('<html><head><title>חנות</title></head><body>שלום</body></html>'), null);
});

test("WooCommerce's Store API: prices in the currency's minor unit, the categories, stock, and a name that is a list of keywords is no name", async () => {
  const c = recorded('shmot-bekesef.example');
  const s = await readStore(c.store, c);
  assert.deepEqual([s.platform, s.currency, s.domain, s.products.length], ['woocommerce', 'ILS', 'shmot-bekesef.example', 4]);
  assert.deepEqual(c.asked, ['https://shmot-bekesef.example', 'https://shmot-bekesef.example/wp-json/wc/store/v1/products?per_page=100'], 'two requests: the homepage and the catalogue');
  // og:site_name is "שרשראות שם | טבעות כסף | צמידים | ...": the domain stands in for it.
  assert.equal(s.name, 'shmot-bekesef.example');
  assert.equal(s.logo, 'https://shmot-bekesef.example/wp-content/uploads/2021/03/logo-main.png');
  // currency_minor_unit 0: "180" is 180 shekels.
  assert.deepEqual(s.products[0].variants, [{ price: '180', available: true }]);
  assert.equal(s.products[0].product_type, 'תליונים');
  assert.deepEqual(s.collections, ['תליונים', 'שרשראות שם', 'מוצרים מיוחדים', 'טבעות כסף', 'צמידים']);
  const doc = storeDocument(s).text.split('\n');
  assert.ok(doc.includes('המחירים באתר: מ-180 ₪ עד 1890 ₪.'), doc.join('\n'));
  assert.ok(doc.includes('תליון לב מכסף 925 (תליונים): 180 ₪.'));
  assert.deepEqual(storeStats(s), { products: 4, images: 5, categories: 5, low: 180, high: 1890 });
});

test('WooCommerce in agorot: currency_minor_unit 2, a price range kept as its lowest and highest, the name from og:site_name', async () => {
  const c = recorded('hamitbach-shel-dorit.example');
  const s = await readStore(c.store, c);
  assert.equal(s.name, 'המטבח של דורית');
  assert.equal(s.logo, null, 'an SVG logo is never taken');
  assert.deepEqual(s.products[0].variants.map((v) => v.price), ['22', '119'], '"2200" to "11900" agorot');
  assert.ok(storeDocument(s).text.includes('סלט חצילים בטחינה (סלטים): מ-22 ₪.'));
  // A price of 0 or nothing is no price; a product out of stock is listed but never shown.
  const p = wooProduct({ id: 1, name: 'בדיקה &#8211; שם', prices: { price: '0', currency_minor_unit: 2 }, is_in_stock: false, images: [] });
  assert.deepEqual([p.title, p.variants], ['בדיקה – שם', []]);
  assert.equal(wooProduct({ id: 2, name: 'x', prices: { price: '4990', currency_minor_unit: 2 }, is_in_stock: false }).variants[0].available, false);
});

test("a WooCommerce store whose Store API is off is read from its sitemap and its product pages' schema.org Product", async () => {
  const c = recorded('shetach-patuach.example', { refuse: /\/wp-json\/wc\/store\// });
  const s = await readStore(c.store, c);
  assert.equal(s.platform, 'woocommerce');
  assert.equal(s.name, 'שטח פתוח');
  assert.ok(c.asked.includes('https://shetach-patuach.example/product-sitemap.xml'), 'the products sitemap, found through the index');
  assert.ok(c.asked.includes('https://shetach-patuach.example/shop-2/'), 'a page in it with no Product is read and left out');
  assert.equal(s.products.length, 3);
  assert.equal(s.products[0].title, 'פנס לד לאוהל');
  assert.equal(s.currency, 'ILS');
  assert.ok(s.products.every((p) => p.images[0]?.src.startsWith('https://shetach-patuach.example/wp-content/uploads/')));
  // The sale price and the list price are the range; the one out of stock is read and never shown.
  assert.deepEqual(s.products[0].variants.map((v) => v.price), ['30', '40']);
  assert.equal(storeStats(s).products, 2);
  assert.ok(storeDocument(s).text.includes('פנס לד לאוהל: מ-30 ₪.'));
});

test('Wix: sitemap.xml, the store products sitemap, and each product page as it describes itself', async () => {
  for (const [domain, name, first] of [
    ['shloshet-haetzim.example', 'מזקקת שלושת העצים', 'ליקר תפוזים: 120 ₪.'],
    ['mazkarot-mehaaretz.example', 'מזכרות מהארץ', 'פסלון אריה: 64 ₪.'],
  ]) {
    const c = recorded(domain);
    const s = await readStore(c.store, c);
    assert.deepEqual([s.platform, s.name, s.currency, s.products.length], ['wix', name, 'ILS', 3], domain);
    assert.equal(c.asked[1], `${c.store}/sitemap.xml`);
    assert.match(c.asked[2], /^https:\/\/www\.[^/]+\/store-products-sitemap\.xml$/, 'the products sitemap, on www as the index names it');
    assert.equal(c.asked.length, 6, 'the homepage, two sitemaps and three product pages: nothing else');
    assert.ok(storeDocument(s).text.split('\n').includes(first), storeDocument(s).text);
    const shelf = shelfOf(s);
    assert.equal(shelf.length, 3);
    assert.ok(shelf.every((p) => p.src.startsWith('https://static.wixstatic.com/media/') && p.price > 0 && p.title));
  }
});

test('Shopify reads as before: the catalogue, the store summary and its collections', async () => {
  const c = recorded('kelim-yafim.example');
  const s = await readStore(c.store, c);
  assert.deepEqual([s.platform, s.name, s.currency, s.accent], ['shopify', 'kelim', 'ILS', null]);
  assert.deepEqual(c.asked, ['https://kelim-yafim.example', 'https://kelim-yafim.example/products.json?limit=100', 'https://kelim-yafim.example/meta.json', 'https://kelim-yafim.example/collections.json?limit=50']);
  assert.equal(s.collections.length, 6);
  assert.equal(storeStats(s).products, 2, 'the two unavailable at 0.00 are not shown');
  assert.ok(storeDocument(s).text.includes('פמוט פליז (Home & Design): 330 ₪.'));
});

test('a store on none of the three is told so; one whose platform shows but whose catalogue is closed is told which', async () => {
  const none = { get: async (u) => Promise.reject(Object.assign(new Error(`HTTP 404: ${u}`), { status: 404 })), getPage: async (u) => (u === 'https://plain.example.test' ? { body: '<html><title>חנות</title></html>' } : Promise.reject(new Error('HTTP 404'))) };
  await assert.rejects(readStore('plain.example.test', none), (e) => e instanceof DemoError && /Shopify, ב-WooCommerce וב-Wix/.test(e.message));
  const c = recorded('hamitbach-shel-dorit.example', { refuse: /\/wp-json\// });
  await assert.rejects(readStore(c.store, c), (e) => e instanceof DemoError && /ב-WooCommerce/.test(e.message));
  await assert.rejects(readStore('not an address', none), /הכתובת של החנות לא תקינה/);
});

test('a sitemap is read politely: at most MAX_PAGES product pages, one after another, on the store itself', async () => {
  const urls = Array.from({ length: 40 }, (_, i) => `https://www.shop.example.test/product-page/p${i}`);
  const asked = [];
  let open = 0;
  let most = 0;
  const page = (i) => `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"מוצר ${i}","image":"https://static.example.test/${i}.jpg","offers":{"@type":"Offer","price":"${10 + i}","priceCurrency":"ILS","availability":"https://schema.org/InStock"}}</script>`;
  const getPage = async (u) => {
    asked.push(u);
    most = Math.max(most, ++open);
    await new Promise((r) => setTimeout(r, 1));
    open--;
    if (u.endsWith('/sitemap.xml')) return { body: '<sitemapindex><sitemap><loc>https://www.shop.example.test/store-products-sitemap.xml</loc></sitemap><sitemap><loc>https://elsewhere.example.test/store-products-sitemap.xml</loc></sitemap></sitemapindex>' };
    if (u.endsWith('/store-products-sitemap.xml')) return { body: `<urlset>${[...urls, 'https://elsewhere.example.test/product-page/x'].map((x) => `<url><loc>${x}</loc></url>`).join('')}</urlset>` };
    return { body: page(Number(u.split('/p').pop())) };
  };
  const r = await fromSitemaps('https://shop.example.test', { getPage, maps: ['/sitemap.xml'] });
  assert.equal(r.products.length, MAX_PAGES);
  assert.equal(asked.filter((u) => u.includes('/product-page/')).length, MAX_PAGES);
  assert.ok(!asked.some((u) => u.includes('elsewhere')), 'never another host');
  assert.equal(most, 1, 'one request at a time');
});

test("a product page's schema.org Product: an AggregateOffer's range, an @graph, a priceSpecification, a page without one", () => {
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const p = productFromLd(ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'Product', name: 'כיסא &amp; שולחן', sku: 'A1', category: 'ריהוט', image: [{ '@type': 'ImageObject', contentUrl: 'https://cdn.example.test/a.jpg' }], offers: { '@type': 'AggregateOffer', lowPrice: '120', highPrice: '180', priceCurrency: 'ILS', availability: 'https://schema.org/InStock' } }] }));
  assert.deepEqual([p.id, p.title, p.product_type, p.currency, p.variants.map((v) => v.price), p.images[0].src], ['A1', 'כיסא & שולחן', 'ריהוט', 'ILS', ['120', '180'], 'https://cdn.example.test/a.jpg']);
  const spec = productFromLd(ld({ '@type': 'Product', name: 'x', image: 'https://cdn.example.test/x.jpg', offers: [{ '@type': 'Offer', priceSpecification: [{ price: '49.90', priceCurrency: 'ILS' }], availability: 'https://schema.org/OutOfStock' }] }));
  assert.deepEqual([spec.variants[0].price, spec.variants[0].available], ['49.9', false]);
  assert.equal(productFromLd(ld({ '@type': 'Product', name: 'no price', offers: { price: '' } })), null);
  assert.equal(productFromLd('<html><body>nothing here</body></html>'), null);
  assert.equal(siteName('<title>דף הבית - חנות הקומקומים</title>'), 'חנות הקומקומים');
});
