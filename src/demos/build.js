import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getBytes } from '../core/net.js';
import { mediaDir } from '../core/paths.js';
import { nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { RenderError, renderPost } from '../render/render.js';
import { themeOf } from '../render/styles/index.js';
import { wikipediaDocs } from '../sources/index.js';
import { findImage, MIN_SIDE } from '../images/index.js';
import { DemoError, domainOf, readStore, shelfOf, storeDocument, storeOrigin, storeStats } from './store.js';
import { chooseTopic, writeDemo } from './write.js';

// A store's demo, from the request to the drawn slides (src/db/schema.js, table demos):
//
//   new       asked for (POST /internal/lead), not read yet
//   building  reading the store, choosing the topic, reading about it, writing, drawing
//   ready     drawn, waiting for the operator: only demos built before they approved themselves
//   failed    the store could not be read, or the slides did not pass their checks: the reason is in `error`
//   approved  drawn and checked: the store's page is up at /s/<slug>, with no one approving it by hand
//   removed   taken down; its page is gone
//
// One demo at a time per store: asking again for a store with a demo returns it, with the number that asked.

const ACCENT = '#9B7BFF'; // Teder's violet as it reads on a dark ground, for a store whose own colour does not

// The demo's look: style A (src/render/styles), every slide on a Pexels photograph of its own, filling it
// (theme.options.fullPhoto), the text at the bottom over its fade into the dark ground, in the store's colour where it reads there
// (resolveStyle falls back to Teder's violet). A demo is no account, so the pack is made here, with only what
// drawing needs.
const BASE_THEME = {
  template: 'editorial',
  variant: 'a',
  colors: { bg: '#0E1513', surface: '#17211E', ink: '#FFFFFF', muted: '#B7C4BF', accent: ACCENT, accent2: '#FFFFFF', onAccent: '#0E1513' },
  fonts: { display: 'Heebo', text: 'Assistant' },
  options: { radius: 24, fullPhoto: true },
};

/** The pack a demo is drawn with. */
export function demoPack(demo, store) {
  const handle = (store.domain.split('.')[0].replace(/[^a-z0-9]/g, '') || 'store').slice(0, 24);
  const pack = {
    id: `demo-${demo.id}`,
    dirName: `demo-${demo.id}`,
    meta: { id: `demo-${demo.id}`, displayName: store.name, handle, language: 'he', platforms: ['tiktok', 'instagram'], style: { name: 'A', ...(store.accent ? { accent: store.accent } : {}) }, endSlide: null, topics: [] },
    theme: BASE_THEME,
    rules: { maxQuoteWords: 40, bannedPhrases: [] },
    brandLogo: null,
  };
  return { ...pack, theme: themeOf(pack) };
}

/** A slug for /s/: the store's domain in letters and digits, and a random tail so a link cannot be guessed. */
export const slugFor = (domain) => `${domain.split('.')[0].replace(/[^a-z0-9]/g, '').slice(0, 24) || 'store'}-${randomBytes(3).toString('hex')}`;

/** Ask for a store's demo. Returns { demo, created }. */
export function requestDemo(db, { url, whatsapp = null, origin = 'website' }) {
  const home = storeOrigin(url);
  if (!home) throw new DemoError('הכתובת של החנות לא תקינה');
  const domain = domainOf(home);
  const known = db.get("SELECT * FROM demos WHERE domain = ? AND status <> 'removed' ORDER BY id DESC", domain);
  const t = nowIso();
  if (known) {
    if (whatsapp) db.run('UPDATE demos SET whatsapp = ?, updated_at = ? WHERE id = ?', whatsapp, t, known.id);
    return { demo: db.get('SELECT * FROM demos WHERE id = ?', known.id), created: false };
  }
  const id = db.insert('demos', { slug: slugFor(domain), url: home, domain, whatsapp, origin, status: 'new', created_at: t, updated_at: t });
  return { demo: db.get('SELECT * FROM demos WHERE id = ?', id), created: true };
}

/** A picture's kind from its first bytes: 'png', 'jpg', 'webp', or null. */
export const imageExt = (buf) => {
  const b = Buffer.from(buf || []);
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
};

const set = (db, id, patch) => db.update('demos', id, { ...patch, updated_at: nowIso() });

const MAX_ARTICLE = 9000;

/** The articles a topic names, read from Wikipedia: [{ key: 'w1'.., url, title, text }]. A title not found is left out. */
export async function readArticles(articles, { wiki = wikipediaDocs } = {}) {
  const out = [];
  for (const a of articles) {
    try {
      const [doc] = await wiki({ key: 'demo', lang: a.lang }, { lang: a.lang, title: a.title });
      if (doc?.text?.trim()) out.push({ key: `w${out.length + 1}`, url: doc.url, title: doc.title, text: doc.text.slice(0, MAX_ARTICLE) });
    } catch {
      // no such article: the others may hold the facts
    }
  }
  return out;
}

/**
 * Build one demo: read the store, choose a topic from its field, read Wikipedia on it, write and check the slides,
 * find each slide's photograph on Pexels, draw them. Every failure is a status with a reason, never a throw.
 * io: { read, topic, wiki, write, fetchImage, photo, render } (tests replace them). skip: angles already used.
 */
export async function buildDemo(ctx, id, { read = readStore, topic: choose = chooseTopic, wiki = wikipediaDocs, write = writeDemo, fetchImage = getBytes, photo = findImage, render = renderPost, skip = [] } = {}) {
  const { db } = ctx;
  const demo = db.get('SELECT * FROM demos WHERE id = ?', id);
  if (!demo || demo.status === 'removed') return null;
  set(db, id, { status: 'building', error: null });
  try {
    const store = await read(demo.url);
    const storeDoc = storeDocument(store);
    if (storeDoc.text.split('\n').length < 3) throw new DemoError('לא מצאנו בחנות מוצרים עם תמונה, מחיר ומלאי');
    const storeRow = { name: store.name, platform: store.platform || null, currency: store.currency, accent: store.accent, stats: storeStats(store), shelf: [] };
    set(db, id, { store_json: storeRow });
    const topic = await choose(ctx, { store, skip });
    if (!topic.angle || !topic.articles.length) throw new DemoError('לא הצלחנו לבחור נושא מהתחום של החנות');
    const articles = await readArticles(topic.articles, { wiki });
    if (!articles.length) throw new DemoError(`לא מצאנו בוויקיפדיה את הערכים על הנושא: ${topic.articles.map((a) => a.title).join(', ')}`);
    const docs = [...articles, storeDoc];
    set(db, id, { topic_json: topic, docs_json: docs });

    const dir = path.join(ctx.mediaDir || mediaDir(), 'demos', String(id));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // The products beside the title on the store's page, small: the page shows only pictures served from here.
    for (const p of shelfOf(store)) {
      const file = path.join(dir, `shelf-${storeRow.shelf.length}.jpg`);
      try {
        const bytes = await fetchImage(`${p.src}${p.src.includes('?') ? '&' : '?'}width=300`);
        writeFileSync(file, bytes.buf || bytes);
        storeRow.shelf.push({ title: p.title, price: p.price, file });
      } catch {
        // a product whose picture did not come is left off the shelf
      }
    }
    // The store's logo, beside Teder's on its page: PNG, JPEG or WebP only, never an SVG (it could carry script).
    if (store.logo) {
      try {
        const bytes = await fetchImage(`${store.logo}${store.logo.includes('?') ? '&' : '?'}width=320`);
        const buf = bytes.buf || bytes;
        const ext = imageExt(buf);
        if (ext) {
          const file = path.join(dir, `logo.${ext}`);
          writeFileSync(file, buf);
          storeRow.logo = file;
        }
      } catch {
        // no logo: the page shows the store's initial
      }
    }
    set(db, id, { store_json: storeRow });

    // Written, checked, drawn. A text the style cannot fit goes back to the writer once, with the renderer's reason.
    const pack = demoPack(demo, store);
    const found = new Map(); // a search already made: its photograph, or null
    let before = [];
    for (let round = 0; round < 2; round++) {
      const { post, problems } = await write(ctx, { store, docs, topic, before });
      if (problems.length) {
        set(db, id, { status: 'failed', error: `המצגת לא עברה את הבדיקות: ${problems.slice(0, 4).join(' | ')}`, post_json: post });
        return db.get('SELECT * FROM demos WHERE id = ?', id);
      }
      // Each slide's photograph, from Pexels only, through Teder's own image search (src/images, HARD RULE 5): the
      // licence kept, the screen passed. Never a product of the store's: the slides are about its field.
      const photos = new Map();
      const credits = [];
      const why = {};
      for (const [i, query] of (post.images || []).entries()) {
        if (!query) continue;
        if (!found.has(query)) found.set(query, await photo(ctx, { pack: { ...pack, id: null, meta: { ...pack.meta, imagery: { providers: ['pexels'] } } }, query, minSide: MIN_SIDE.cover, why }).catch(() => null));
        const img = found.get(query);
        if (!img?.file) continue;
        const file = path.join(dir, `photo-${i}.jpg`);
        copyFileSync(img.file, file);
        photos.set(i, { file });
        credits.push({ slide: i, query, author: img.author || null, license: img.license || null, url: img.source_url || null });
      }
      if (!photos.has(0)) throw new DemoError(`לא מצאנו ב־Pexels תמונה לשער ("${post.images?.[0] || ''}")${Object.keys(why).length ? `: ${Object.keys(why).slice(0, 2).join('; ')}` : ''}`);
      // A slide whose search found nothing (refused, or no result) stands on the cover's photograph, never on nothing.
      for (let i = 1; i < (post.images || []).length; i++) if (!photos.has(i)) photos.set(i, photos.get(0));
      post.photos = credits;
      try {
        const files = await render({
          pack,
          post: { id: `demo-${id}`, hook: post.hook, sub: post.sub, caption: post.caption, token: post.token, extra: post.extra },
          slides: post.slides,
          photos,
          // A story: its slides counted among themselves ("1 מתוך 3"), the last one not, and never drawn as a number card.
          format: { id: 'demo', kind: 'story' },
          outDir: dir,
        });
        // Nobody approves a demo by hand: one that passed every check above is the store's page at once. The operator
        // can still take it down, or have it written again, on /demos.
        const at = nowIso();
        set(db, id, { status: 'approved', ready_at: at, approved_at: at, approved_by: 'auto', post_json: post, media_json: { tiktok: files.tiktok, instagram: files.instagram } });
        break;
      } catch (e) {
        if (!(e instanceof RenderError) || round === 1) throw e;
        before = [`the slides could not be drawn: ${e.message}. Shorten that text.`];
      }
    }
  } catch (e) {
    const why = e instanceof DemoError ? e.message : `משהו השתבש: ${e.message}`;
    ctx.log?.(`[demos] ${demo.domain}: ${e.stack || e.message}`);
    set(db, id, { status: 'failed', error: why });
  }
  return db.get('SELECT * FROM demos WHERE id = ?', id);
}

/** A demo row with its JSON read. */
export const readDemo = (row) => (row ? { ...row, store: j(row.store_json, {}), topic: j(row.topic_json, {}), docs: j(row.docs_json, []), post: j(row.post_json, null), media: j(row.media_json, {}) } : null);
