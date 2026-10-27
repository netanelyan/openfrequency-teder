import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dataDir } from '../core/paths.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { nowIso } from '../core/clock.js';
import { buildDemo, readDemo, requestDemo } from '../demos/build.js';
import { DemoError } from '../demos/store.js';
import { ActionError } from './actions.js';
import { contrast } from '../render/color.js';
import { LOGOS } from './logos.js';
import { esc, layout, ofMark, postButton, stamp, tederMark } from './ui.js';

// Stores' demos on the website (src/demos):
//
//   POST /internal/lead      a demo asked for on openfrequency.co.il (openfrequency-web/server/lead.mjs): from this
//                            machine only, with OF_INTERNAL_TOKEN and no X-Forwarded-For, so never through Caddy
//   GET  /internal/demos     every demo, newest first, at most 500, with its page's address while it is public and
//                            its opens, for the operator's dashboard on Toran (openfrequency-toran docs/operator.md,
//                            section 2); under the same checks as /internal/lead, JSON, Cache-Control: no-store
//   GET  /s/<slug>           the store's page, public and never indexed, once its demo passed every check. A view by
//                            anyone not signed in to OpenFrequency is an open (demo_opens), with a random id in its
//                            own cookie (of_v, a year) to count the browsers; never the address
//   GET  /s/<slug>/<file>    its slides, p-N.jpg (its products), logo (the store's), theme.css (the store's colour)
//   GET  /demos              the operator's list: each store, where its demo is, what to do with it; the price the
//                            pages show
//   GET  /demos/<id>         one demo: its slides, its caption, every fact with its quote, its topic and documents
//   GET  /demos/<id>/img/... its slides, for that page
//   POST /demos/<id>/...     approve, write again, write on another topic, take down
//   POST /demos/offer        the price on the stores' pages
//
// A demo is no account and in no workspace: everything here is the operator's alone, and a customer's session
// finds nothing (test/workspaces.test.js).

export const running = new Map();

/** Build a demo in the background; one build per demo at a time. */
export function startBuild(ctx, id, opts = {}) {
  if (running.has(id)) return running.get(id);
  // ctx.demoIo: the tests' stand-ins for the store, the writer and the renderer (src/demos/build.js).
  const p = buildDemo(ctx, id, { ...ctx.demoIo, ...opts })
    .catch((e) => ctx.log?.(`[demos] ${id}: ${e.stack || e.message}`))
    .finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

const OFFER_KEY = 'demo-offer';
export const offerOf = (db) => getSetting(db, OFFER_KEY, { monthly: null, setup: null, vat: null });

const ils = (n) => `${Number(n).toLocaleString('he-IL')} ₪`;
const priceLine = (o) => {
  if (!(o.monthly > 0) || !o.vat) return null;
  const vat = o.vat === 'included' ? 'כולל מע״מ' : 'לא כולל מע״מ';
  return `זה ${ils(o.monthly)} לחודש, ${vat}${o.setup > 0 ? `, ועוד ${ils(o.setup)} דמי הקמה, פעם אחת` : ''}.`;
};

/** "ל" before a Hebrew name, "ל־" before any other. */
const le = (name) => (/^[֐-׿]/.test(name) ? 'ל' : 'ל־');

const STATUS = { new: 'חדש', building: 'בבנייה', ready: 'מוכן לבדיקה', failed: 'לא נבנה', approved: 'באוויר', removed: 'הוסר' };

// ---------------------------------------------------------------- the intake

/** Whether a request is a service on this machine with the token: the website's lead service, Toran's dashboard. */
export function fromWebsite(req, env) {
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < 32 || req.headers['x-forwarded-for']) return false;
  const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${token}`);
  return local && got.length === want.length && timingSafeEqual(got, want);
}

async function readJson(req, limit = 20_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** POST /internal/lead. Returns [status, body]. */
export async function intake(ctx, req, env, opts = {}) {
  if (!fromWebsite(req, env)) return [403, { ok: false, error: 'forbidden' }];
  let body;
  try {
    body = await readJson(req);
  } catch {
    return [400, { ok: false, error: 'bad' }];
  }
  const whatsapp = String(body.whatsapp || '').replace(/\D/g, '');
  if (!/^9725\d{8}$/.test(whatsapp)) return [400, { ok: false, error: 'bad' }];
  try {
    const { demo, created } = requestDemo(ctx.db, { url: body.url, whatsapp });
    audit(ctx.db, { actor: 'website', action: 'demo_asked', detail: { url: demo.url, created } });
    if (created) startBuild(ctx, demo.id, opts);
    return [200, { ok: true, id: demo.id, existing: !created }];
  } catch (e) {
    if (e instanceof DemoError) return [400, { ok: false, error: 'bad' }];
    throw e;
  }
}

// ---------------------------------------------------------------- the dashboard on Toran

/** Each demo with how often its page was opened: newest first, at most `limit`, or the one `id`. */
export function demosWithOpens(db, { limit = 500, id = null } = {}) {
  return db.all(
    `WITH d AS (SELECT * FROM demos ${id == null ? 'ORDER BY created_at DESC, id DESC LIMIT ?' : 'WHERE id = ?'})
     SELECT d.*, COUNT(o.id) AS opens, COUNT(DISTINCT o.visitor) AS visitors, MAX(o.at) AS last_open_at
     FROM d LEFT JOIN demo_opens o ON o.demo_id = d.id GROUP BY d.id ORDER BY d.created_at DESC, d.id DESC`,
    id == null ? limit : Number(id)
  );
}

/** GET /internal/demos. `origin` is where the store's pages are, https://<PUBLIC_HOST> on the VPS. Returns [status, body]. */
export function demosFeed(ctx, req, env, { origin }) {
  if (!fromWebsite(req, env)) return [403, { ok: false, error: 'forbidden' }];
  const demos = demosWithOpens(ctx.db, { limit: 500 }).map((row) => {
    const d = readDemo(row);
    return {
      id: d.id,
      domain: d.domain,
      url: d.url,
      name: d.store?.name || null,
      status: d.status,
      whatsapp: d.whatsapp || null,
      // Public is what /s/<slug> serves (publicDemo): approved, which a demo taken down no longer is.
      pageUrl: d.status === 'approved' ? `${origin}/s/${d.slug}` : null,
      createdAt: d.created_at,
      readyAt: d.ready_at || null,
      approvedAt: d.approved_at || null,
      removedAt: d.removed_at || null,
      error: d.error || null,
      opens: d.opens,
      visitors: d.visitors,
      lastOpenAt: d.last_open_at || null,
    };
  });
  return [200, { demos }];
}

// ---------------------------------------------------------------- the opens

const VISITOR = 'of_v';

/** The browser's visitor id from its cookie, and the Set-Cookie that gives it one when it has none (like Toran's tn_v). */
export function visitorOf(jar, { https }) {
  const have = /^[\w-]{16,40}$/.test(jar[VISITOR] || '') ? jar[VISITOR] : null;
  if (have) return { visitor: have, cookie: null };
  const visitor = randomBytes(12).toString('base64url');
  return { visitor, cookie: `${VISITOR}=${visitor}; Path=/s; Max-Age=31536000; SameSite=Lax; HttpOnly${https ? '; Secure' : ''}` };
}

/** One view of a store's page by someone not signed in. */
export const recordOpen = (db, demoId, visitor) => db.insert('demo_opens', { demo_id: demoId, visitor, at: nowIso() });

const times = (n) => (n === 1 ? 'פעם אחת' : n === 2 ? 'פעמיים' : `${n} פעמים`);
/** How often the page was opened, for the operator: "נפתח 3 פעמים, ב־2 דפדפנים". */
const opensLine = (d) => (d.opens ? `נפתח ${times(d.opens)}, ${d.visitors === 1 ? 'בדפדפן אחד' : `ב־${d.visitors} דפדפנים`}` : 'עוד לא נפתח');

// ---------------------------------------------------------------- the store's page

const fileOf = (ctx, demo, platform, n) => {
  const file = platform === 'logo' ? demo.store?.logo : platform === 'shelf' ? demo.store?.shelf?.[n]?.file : demo.media?.[platform]?.[n];
  const root = path.resolve(ctx.mediaRoot || dataDir());
  return file && path.resolve(file).startsWith(root) && existsSync(file) ? file : null;
};

/** Stream one of a demo's pictures to the response (a slide, a product, the store's logo), or false. */
export function sendSlide(ctx, res, demo, platform, n) {
  const file = demo ? fileOf(ctx, demo, platform, Number(n)) : null;
  if (!file) return false;
  const type = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' });
  createReadStream(file).pipe(res);
  return true;
}

/** The approved demo behind a slug, or null. */
export const publicDemo = (db, slug) => readDemo(db.get("SELECT * FROM demos WHERE slug = ? AND status = 'approved'", slug));

const STORE_GREY = '#4A4A52';
/** The store's colour as its page uses it, behind white letters: its own where white reads on it, else a grey. */
const storeColour = (demo) => {
  const c = demo.store?.accent;
  return /^#[0-9a-f]{6}$/i.test(c || '') && contrast(c, '#FFFFFF') >= 4.5 ? c : STORE_GREY;
};

/** /s/<slug>/theme.css: the store's colour, which the page may not set inline (style-src 'self'). */
export const demoThemeCss = (demo) => `:root{--store:${storeColour(demo)};--store-ink:#fff}\n${(demo.store?.shelf || []).length ? `.shelf-track{animation-duration:${Math.max(24, demo.store.shelf.length * 5)}s}\n` : ''}`;

// The slides of one size, side by side, each as wide as a phone shows it; the row scrolls sideways.
const strip = (demo, platform, base) =>
  `<div class="d-strip" tabindex="0" aria-label="${platform === 'tiktok' ? 'השקפים בגודל של טיקטוק' : 'השקפים בגודל של אינסטגרם'}">${(demo.media?.[platform] || [])
    .map((_, i) => `<img src="${base}/${platform}-${i}.jpg" alt="${esc(i === 0 ? demo.post?.hook || '' : [demo.post?.slides?.[i]?.title, demo.post?.slides?.[i]?.body].filter(Boolean).join('. '))}" width="1080" height="${platform === 'tiktok' ? 1920 : 1350}" loading="${i < 2 ? 'eager' : 'lazy'}">`)
    .join('')}</div>`;

// The store's products, moving past beside the title: two rows, each list twice so the loop has no seam.
const shelf = (demo, base) => {
  const items = (demo.store?.shelf || []).map((p, i) => ({ ...p, i }));
  if (items.length < 4) return '';
  const half = Math.ceil(items.length / 2);
  const row = (list, r) => {
    const ul = `<ul>${list.map((p) => `<li><img src="${base}/p-${p.i}.jpg" alt="" loading="lazy" width="300" height="300"><b>${esc(p.title)}</b><small>${esc(ils(p.price))}</small></li>`).join('')}</ul>`;
    return `<div class="shelf-row r${r}"><div class="shelf-track">${ul}${ul}</div></div>`;
  };
  return `<div class="shelf" aria-hidden="true">${row(items.slice(0, half), 0)}${row(items.slice(half), 1)}</div>`;
};

// What Teder does for a store that turns it on: the four lines of /teder on openfrequency.co.il, the last one saying
// the days and times are the customer's own (src/schedule/choice.js).
const INCLUDES = ['מצגות בעברית שתדר כותב ומעצב בשבילכם', 'כל מצגת בגודל של טיקטוק ובגודל של אינסטגרם', 'כל מצגת מחכה לאישור שלכם לפני שהיא עולה', 'פרסום בימים ובשעות שאתם בוחרים. בשבת ובחג לא מפרסמים, אלא אם תבחרו אחרת'];
const JOIN = 'https://openfrequency.co.il/join?p=teder';
export const SIGNUP_DEFAULT = 'https://accounts.openfrequency.co.il/signup';

/**
 * Where the page's button goes: accounts' sign-up (OF_SIGNUP_URL, by default SIGNUP_DEFAULT) once it is open
 * (OF_SIGNUP_OPEN=1), and until then the website's /join, so nobody is sent to a page that does not take them yet.
 */
export function joinUrl(env = process.env) {
  const open = /^(1|true|yes|on)$/i.test(String(env.OF_SIGNUP_OPEN || '').trim());
  const signup = String(env.OF_SIGNUP_URL || '').trim() || SIGNUP_DEFAULT;
  return open && /^https:\/\/[^\s"'<>]+$/.test(signup) ? signup : JOIN;
}
const articleName = (title) => String(title || '').replace(/\s*\(Wikipedia[^)]*\)\s*$/, '');

// What this page is and what Teder is, said plainly: the slideshow was written from the store's site to show how it
// looks; in Teder the owner picks the account's subject and Teder writes about it from sources they approve, never
// about their products. Where it goes out: TikTok and Instagram, the only two Teder posts to. Then how one starts, on
// their own. Nothing here promises work done by hand. The same on every page, nothing in it about the store.
const PLATFORM_LOGOS = LOGOS.filter((l) => ['TikTok', 'Instagram'].includes(l.name));
const LINKS = `<section class="links" aria-labelledby="links-h"><h2 id="links-h">בתדר אתם בוחרים על מה החשבון כותב</h2>
<p class="links-lede">את המצגת הזו תדר כתב מהאתר שלכם, כדי שתראו איך זה נראה אצלכם. כשפותחים חשבון בתדר, בוחרים לו נושא, ותדר כותב עליו מצגות מתוך מקורות שאתם מאשרים. המצגות עוסקות בתחום עצמו, ואין בהן המלצות על מוצרים.</p>
<ul class="logos" aria-label="איפה המצגות מתפרסמות">${PLATFORM_LOGOS.map((l) => `<li${l.box ? ' class="wide"' : ''} title="${l.name}"><svg viewBox="${l.box || '0 0 24 24'}" role="img" aria-label="${l.name}"><path fill="${l.color}" d="${l.path}"/></svg></li>`).join('')}</ul>
<div class="glass links-note"><h3>ככה מתחילים</h3>
<p>נרשמים, כותבים במה החשבון יעסוק, מאשרים מקורות ועוברים על חמישה פוסטים לדוגמה. אחר כך מחברים את טיקטוק ואת אינסטגרם, בוחרים ימים ושעות, וכל פוסט מחכה לאישור שלכם לפני שהוא עולה.</p></div>
</section>`;

/**
 * The store's page, built like Toran's (openfrequency-toran src/pitch/page.ts): what was read on its site and the
 * way in beside its products, on its own photograph; then the slideshow itself; then what Teder is (LINKS above);
 * then what Teder would do for it and what that costs, and the way in (joinUrl). No script: the two sizes are two
 * radio buttons and CSS.
 */
export function demoPage(demo, { offer, join = joinUrl() }) {
  const name = demo.store?.name || demo.domain;
  const subject = demo.topic?.niche || '';
  const base = `/s/${demo.slug}`;
  const facts = (demo.post?.facts || []).filter((f) => f.verified);
  const st = demo.store?.stats || {};
  const articles = (demo.docs || []).filter((d) => d.key !== 'store');
  // The store's own logo where its homepage has one, on a white tile; else its initial in its colour.
  const initial = esc([...String(name).trim()][0] || '·');
  const mark = (sm = false) =>
    demo.store?.logo ? `<span class="logo${sm ? ' sm' : ''}"><img src="${base}/logo" alt="${sm ? '' : esc(name)}"></span>` : `<span class="initial${sm ? ' sm' : ''}" aria-hidden="true">${initial}</span>`;
  // The price, on one card as on openfrequency.co.il: the figure, VAT and the setup fee, the way in, and what it includes.
  const priced = offer.monthly > 0 && offer.vat;
  const notes = priced ? `${offer.vat === 'included' ? 'כולל מע״מ.' : 'לא כולל מע״מ.'}${offer.setup > 0 ? ` בחודש הראשון יש גם ${esc(ils(offer.setup))} דמי הקמה, פעם אחת.` : ''}` : '';
  const tile = (n, label, wide = false) => `<div${wide ? ' class="wide"' : ''}><dt>${label}</dt><dd>${n}</dd></div>`;
  const stats = [
    st.products ? tile(esc(st.products), 'מוצרים') : '',
    st.images ? tile(esc(st.images), 'תמונות מוצרים') : '',
    st.categories ? tile(esc(st.categories), 'קטגוריות') : '',
    st.low != null ? tile(st.low === st.high ? esc(ils(st.low)) : `${esc(ils(st.low))} <small>עד</small> ${esc(ils(st.high))}`, 'טווח המחירים', true) : '',
  ].join('');
  const shelfHtml = shelf(demo, base);
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="color-scheme" content="light"><meta name="theme-color" content="#f4f4f6">
<title>מצגת לדוגמה ${esc(le(name))}${esc(name)} | תדר</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/static/demo.css"><link rel="stylesheet" href="${base}/theme.css"></head>
<body class="d-page">
<div class="wrap"><header class="top"><span class="for">עמוד שהכנו בשביל <bdi>${esc(name)}</bdi></span><span class="by">${ofMark()}OpenFrequency</span></header></div>
<div class="lead${shelfHtml ? ' with-shelf' : ''}">
<section class="hero">
<div class="marks">${mark()}${tederMark()}</div>
<h1>הכנו ${esc(le(name))}<span class="hl"><bdi>${esc(name)}</bdi></span> מצגת לטיקטוק ולאינסטגרם</h1>
<p class="lede">עברנו על האתר שלכם${st.products ? `, על ${esc(st.products)} המוצרים` : ''}. תדר בחר נושא מהתחום שלכם, כתב עליו מצגת ועיצב אותה.</p>
<section class="read" aria-labelledby="read-h"><h2 id="read-h">מה קראנו באתר שלכם</h2>
${stats ? `<dl class="stats">${stats}</dl>` : ''}
${articles.length ? `<div class="pages"><span>הערכים שתדר קרא על הנושא</span><ul>${articles.map((a) => `<li>${esc(articleName(a.title))}</li>`).join('')}</ul></div>` : ''}
</section>
<div class="read-cta"><a class="go big" href="#show">לראות את המצגת</a><p class="quiet">זו הדגמה. המצגת לא עלתה לשום חשבון.</p></div>
</section>
${shelfHtml}
</div>
<div class="wrap">
<section class="glass show" id="show" aria-label="המצגת">
<header class="ch-head">${mark(true)}<span><b><bdi>${esc(name)}</bdi></b>${subject ? `<small>מצגת על <bdi>${esc(subject)}</bdi></small>` : ''}</span></header>
<input type="radio" name="size" id="d-tt" checked><input type="radio" name="size" id="d-ig">
<div class="tabs" role="presentation"><label for="d-tt">טיקטוק</label><label for="d-ig">אינסטגרם</label></div>
<div class="stage tiktok">${strip(demo, 'tiktok', base)}</div>
<div class="stage instagram">${strip(demo, 'instagram', base)}</div>
<div class="cap"><b>הטקסט שעולה עם המצגת</b><p>${esc(demo.post?.caption || '')}</p></div>
</section>
<p class="caption">את הנושא בחר תדר, ואת המצגת הוא כתב ועיצב. לא שינינו בה מילה.${(demo.post?.photos || []).length ? ' התמונות מ־<a href="https://www.pexels.com" rel="noopener noreferrer">Pexels</a>.' : ''}</p>
${facts.length ? `<details class="glass facts"><summary>מאיפה כל עובדה</summary><ul>${facts.map((f) => `<li><b>${esc(f.claim)}</b><q>${esc(f.quote)}</q>${f.url ? `<a href="${esc(f.url)}" rel="noopener noreferrer">${esc(articleName(f.source) || f.url)}</a>` : ''}</li>`).join('')}</ul></details>` : ''}
${LINKS}
<section class="price" aria-labelledby="price-h"><h2 id="price-h">אם תפעילו את תדר</h2>
<div class="glass price-card">
<div class="price-main">
<p class="price-name">${tederMark()}<b>תדר</b></p>
${priced ? `<p class="figure"><span class="num">${esc(Number(offer.monthly).toLocaleString('he-IL'))}</span><span class="cur">₪</span><span class="per">לחודש</span></p><p class="price-notes">${notes}</p>` : ''}
<a class="go" href="${esc(join)}">להפעיל את תדר</a>
</div>
<div class="price-incl"><h3>${priced ? 'מה כלול במחיר' : 'מה תדר עושה'}</h3><ul class="checks">${INCLUDES.map((x) => `<li>${x}</li>`).join('')}</ul></div>
</div>
</section>
<footer class="foot"><span class="by">${ofMark()}OpenFrequency</span></footer>
</div>
</body></html>`;
}

export const goneHtml = () =>
  `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>העמוד לא כאן | תדר</title><link rel="stylesheet" href="/static/demo.css"></head><body class="d-page"><div class="wrap"><section class="hero"><h1>העמוד הזה לא כאן</h1><p class="lede">אולי הקישור ישן. אם קיבלתם אותו מאיתנו, אפשר לענות להודעה ונשלח קישור חדש.</p></section></div></body></html>`;

// ---------------------------------------------------------------- the operator's pages

const operatorOnly = (user) => {
  if (!user.operator) throw new ActionError('אין דבר כזה', 404);
};

function listPage(ctx, pc) {
  const rows = demosWithOpens(ctx.db, { limit: 200 }).map(readDemo);
  const o = offerOf(ctx.db);
  const sel = (v) => (o.vat === v ? ' selected' : '');
  const offer = `<section class="panel"><header><h2>המחיר בעמודים של החנויות</h2></header>
<form method="post" action="/demos/offer" class="d-offer"><input type="hidden" name="_csrf" value="${esc(pc.csrf)}">
<label>לחודש, ב-₪<input name="monthly" inputmode="numeric" value="${esc(o.monthly ?? '')}"></label>
<label>דמי הקמה, ב-₪<input name="setup" inputmode="numeric" value="${esc(o.setup ?? '')}"></label>
<label>מע״מ<select name="vat"><option value=""${sel(null)}>לא נקבע</option><option value="included"${sel('included')}>כולל</option><option value="excluded"${sel('excluded')}>לא כולל</option></select></label>
<button class="btn">לשמור</button></form>
<p class="muted small">${priceLine(o) ? esc(priceLine(o)) : 'עד שהמחיר נקבע, העמודים לא מזכירים אותו.'}</p></section>`;
  const list = rows.length
    ? `<section class="panel"><ul class="d-list">${rows
        .map(
          (d) => `<li><a href="/demos/${d.id}"><b dir="ltr">${esc(d.domain)}</b></a><span class="chip">${esc(STATUS[d.status] || d.status)}</span>${d.whatsapp ? `<a class="muted small" dir="ltr" href="https://wa.me/${esc(d.whatsapp)}">${esc(d.whatsapp)}</a>` : ''}${d.status === 'approved' ? `<a class="small" href="/s/${esc(d.slug)}">העמוד</a>` : ''}${d.status === 'approved' || d.opens ? `<span class="muted small">${esc(opensLine(d))}</span>` : ''}${d.error ? `<span class="muted small">${esc(d.error)}</span>` : ''}</li>`
        )
        .join('')}</ul></section>`
    : '<div class="empty mt30"><b>עוד אין דמואים</b><span class="muted">חנות שמבקשת דמו באתר מופיעה כאן.</span></div>';
  return layout({ ...pc, title: 'דמואים לחנויות', active: 'accounts' }, `<div class="head"><div><h1>דמואים לחנויות</h1><p class="muted">חנות שביקשה באתר דמו של תדר: מצגת אחת על נושא מהתחום שלה, על תמונות מ־Pexels. דמו שעבר את כל הבדיקות עולה לבד, ואפשר לשלוח לחנות את הקישור. אם משהו בו לא טוב, אפשר להוריד אותו או לכתוב אותו מחדש.</p></div></div>${offer}${list}`);
}

function onePage(ctx, pc, id) {
  const d = readDemo(demosWithOpens(ctx.db, { id })[0]);
  if (!d) throw new ActionError('אין דמו כזה', 404);
  const btn = (act, label, cls = 'btn') => postButton(pc, `/demos/${d.id}/${act}`, label, { cls });
  const actions = [
    d.status === 'ready' ? btn('approve', 'לאשר ולהעלות את העמוד', 'btn primary') : '',
    !['building', 'removed'].includes(d.status) ? btn('redo', 'לכתוב מחדש') : '',
    !['building', 'removed'].includes(d.status) && d.topic?.angle ? btn('other', 'נושא אחר') : '',
    d.status !== 'removed' ? btn('remove', 'להוריד') : '',
  ].join('');
  const shots = (platform) => (d.media?.[platform] || []).map((_, i) => `<img src="/demos/${d.id}/img/${platform}/${i}" alt="" loading="lazy">`).join('');
  const facts = (d.post?.facts || []).map((f) => `<li><b>${esc(f.claim)}</b><q>${esc(f.quote)}</q><span class="muted small">${esc(f.source || f.doc || '')}</span>${f.verified ? '' : ` <span class="chip bad">${esc(f.error)}</span>`}</li>`).join('');
  const body = `<div class="head"><div><a class="muted small back" href="/demos">חזרה לדמואים</a><h1 dir="ltr">${esc(d.domain)}</h1>
<p class="muted"><span class="chip">${esc(STATUS[d.status] || d.status)}</span> ${esc(d.store?.name || '')}${d.topic?.niche ? ` · ${esc(d.topic.niche)}` : ''}${d.whatsapp ? ` · <a dir="ltr" href="https://wa.me/${esc(d.whatsapp)}">${esc(d.whatsapp)}</a>` : ''}</p>
${d.status === 'approved' || d.opens ? `<p>${d.status === 'approved' ? `<a href="/s/${esc(d.slug)}">העמוד של החנות</a> · ` : ''}<span class="muted">${esc(opensLine(d))}${d.last_open_at ? `, לאחרונה ${esc(stamp(d.last_open_at))}` : ''}</span></p>` : ''}${d.error ? `<p class="err">${esc(d.error)}</p>` : ''}</div><div class="d-actions">${actions}</div></div>
${d.media?.tiktok?.length ? `<section class="panel"><header><h2>השקפים</h2></header><div class="d-shots">${shots('tiktok')}</div><div class="d-shots ig">${shots('instagram')}</div><p>${esc(d.post?.caption || '')}</p></section>` : ''}
${facts ? `<section class="panel"><header><h2>העובדות</h2></header><ul class="d-factlist">${facts}</ul></section>` : ''}
${d.topic?.angle ? `<section class="panel"><header><h2>הנושא</h2></header><p>${esc(d.topic.niche)}</p><p class="muted small" dir="ltr">${esc(d.topic.angle)}</p></section>` : ''}
${(d.docs || []).map((doc) => `<details class="panel"><summary><b>${esc(doc.title)}</b> <a class="small" href="${esc(doc.url)}" rel="noopener">המקור</a></summary><pre class="d-doc">${esc(doc.text)}</pre></details>`).join('\n')}`;
  return layout({ ...pc, title: d.domain, active: 'accounts' }, body);
}

/** The operator's preview of a slide: GET /demos/<id>/img/<platform>/<n>. */
export function sendPreview(ctx, user, res, m) {
  if (!user.operator) return false;
  const d = readDemo(ctx.db.get('SELECT * FROM demos WHERE id = ?', Number(m[1])));
  return d ? sendSlide(ctx, res, d, m[2], m[3]) : false;
}

const demoOf = (ctx, id) => {
  const d = ctx.db.get('SELECT * FROM demos WHERE id = ?', Number(id));
  if (!d) throw new ActionError('אין דמו כזה', 404);
  return d;
};

export function demosRoutes() {
  return [
    ['GET', /^\/demos$/, (ctx, user, _m, _q, pc) => (operatorOnly(user), listPage(ctx, pc))],
    ['GET', /^\/demos\/(\d+)$/, (ctx, user, m, _q, pc) => (operatorOnly(user), onePage(ctx, pc, m[1]))],
    [
      'POST',
      /^\/demos\/offer$/,
      (ctx, user, _m, f) => {
        operatorOnly(user);
        const n = (v) => {
          const t = String(v ?? '').trim();
          return t === '' ? null : /^[\d,]+(\.\d+)?$/.test(t) ? Number(t.replace(/,/g, '')) : NaN;
        };
        const offer = { monthly: n(f.monthly), setup: n(f.setup), vat: ['included', 'excluded'].includes(f.vat) ? f.vat : null };
        if ([offer.monthly, offer.setup].some((x) => x != null && !(x >= 0))) throw new ActionError('המחיר צריך להיות מספר');
        setSetting(ctx.db, OFFER_KEY, offer);
        audit(ctx.db, { actor: user.name, action: 'demo_offer', detail: offer });
        return { ok: true, message: 'המחיר נשמר', redirect: '/demos' };
      },
    ],
    [
      'POST',
      /^\/demos\/(\d+)\/(approve|redo|other|remove)$/,
      (ctx, user, m) => {
        operatorOnly(user);
        const d = demoOf(ctx, m[1]);
        const act = m[2];
        if (act === 'approve') {
          if (d.status !== 'ready') throw new ActionError('אפשר לאשר רק דמו שמוכן לבדיקה');
          ctx.db.update('demos', d.id, { status: 'approved', approved_at: nowIso(), approved_by: user.name, updated_at: nowIso() });
          audit(ctx.db, { actor: user.name, action: 'demo_approved', detail: { id: d.id, domain: d.domain } });
          return { ok: true, message: 'העמוד של החנות באוויר', redirect: `/demos/${d.id}` };
        }
        if (act === 'remove') {
          ctx.db.update('demos', d.id, { status: 'removed', removed_at: nowIso(), updated_at: nowIso() });
          audit(ctx.db, { actor: user.name, action: 'demo_removed', detail: { id: d.id, domain: d.domain } });
          return { ok: true, message: 'הדמו הורד, והעמוד שלו כבר לא עולה', redirect: '/demos' };
        }
        if (d.status === 'building') throw new ActionError('הדמו הזה נבנה עכשיו');
        if (d.status === 'removed') throw new ActionError('הדמו הזה הורד');
        const skip = act === 'other' ? [readDemo(d).topic?.angle].filter(Boolean) : [];
        startBuild(ctx, d.id, { skip });
        return { ok: true, message: act === 'other' ? 'בונים את הדמו על נושא אחר' : 'כותבים את הדמו מחדש', redirect: `/demos/${d.id}` };
      },
    ],
  ];
}
