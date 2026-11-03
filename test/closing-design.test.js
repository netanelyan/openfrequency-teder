import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, readPack } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { closingSlide } from '../src/pipeline/closing.js';
import { closeBrowser, getBrowser, renderHtml, renderPost } from '../src/render/render.js';
import { stylePage, themeOf } from '../src/render/styles/index.js';
import { STYLE_NAMES } from '../src/render/styles/tokens.js';
import { SAFE_ZONES } from '../src/rules/overlay.js';
import { tokenOf } from '../src/verify/claims.js';
import { DEMO, opened, tempHome } from './helpers.js';

// Item 4 of the closing slide, the design (the owner, 2026-11-02): "draw the closing slide in all four styles (A, B, C,
// D) and style E. It stays inside TikTok's safe zones and keeps the rules (no outlines, no shadows, no page numbers).
// The customer's logo appears if there is one. A URL appears only on Instagram/Facebook; on TikTok the slide says
// "link in bio", because a link in a TikTok image isn't clickable." And 2026-11-03: each format's old call to action
// is dropped, so the closing slide is the only action. Every closing slide here is drawn through renderPost, the
// post's own path, not lenient: a line in a band, too long for its style or below its contrast throws.

after(() => closeBrowser());

const out = mkdtempSync(path.join(os.tmpdir(), 'of-closing-design-'));

const STORE = { name: 'שתיל בעיר', promise: 'צמחי בית, עציצים ואדמה, עם משלוח עד הבית בגוש דן' };
const PRODUCT = { ...STORE, target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://shtil-bair.example/zz' } };
// The longest address a slide shows (28 characters, src/pipeline/closing.js displayUrl).
const LONG_URL = { ...PRODUCT, target: { ...PRODUCT.target, url: 'https://atzitz.example/zamio-ceramic' } };
const LINE = 'חדר בלי חלון? אצלנו יש זמיוקולקס בעציץ קרמיקה';
const FOLLOW = 'עוד סיפורים כמו הקאמבק באיסטנבול, מאירופה ומליגת העל';
// 60 characters: the most a closing line may have.
const LONGEST = 'לחדר חשוך בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה לבן וגדול';

const LOOKS = {
  ...Object.fromEntries(STYLE_NAMES.map((name) => [name, (p) => ({ ...p, meta: { ...p.meta, style: { name } } })])),
  // E's box look as well: its default ("shadow") is an edge and a shadow, which no closing slide has.
  Ebox: (p) => ({ ...p, meta: { ...p.meta, style: { name: 'E', text: 'box' } } }),
  // The older templates: what an account with no style is drawn in (our own accounts; no customer can get one).
  editorial: (p) => p,
  photocard: (p) => ({ ...p, theme: { ...p.theme, template: 'photocard', variant: 'a', options: { ...p.theme.options, coverPhoto: true } } }),
};

const H = { tiktok: 1920, instagram: 1350 };

/** A JPEG or PNG drawn in the browser: a photograph stand-in, or a logo on a transparent ground. */
async function picture(file, kind) {
  const tab = await (await getBrowser()).newPage();
  try {
    const b64 = await tab.evaluate((k) => {
      const logo = k.startsWith('logo');
      const c = document.createElement('canvas');
      c.width = logo ? 480 : 1200;
      c.height = logo ? 160 : 1600;
      const g = c.getContext('2d');
      if (logo) {
        g.fillStyle = k === 'logo-light' ? '#FFFFFF' : '#1F5A2E';
        g.beginPath();
        g.arc(80, 80, 64, 0, Math.PI * 2);
        g.fill();
        g.fillRect(170, 40, 280, 32);
        g.fillRect(170, 92, 200, 28);
        return c.toDataURL('image/png').split(',')[1];
      }
      if (k === 'stripes') {
        // White and black in turn: the brightest and the darkest a photograph can be, under every word.
        for (let x = 0; x < c.width; x += 60) {
          g.fillStyle = (x / 60) % 2 ? '#000000' : '#FFFFFF';
          g.fillRect(x, 0, 60, c.height);
        }
      } else {
        g.fillStyle = '#E0362C';
        g.fillRect(0, 0, c.width, c.height);
      }
      return c.toDataURL('image/jpeg', 0.95).split(',')[1];
    }, kind);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  } finally {
    await tab.close();
  }
}

let assets = null;
async function files() {
  assets ??= {
    red: await picture(path.join(out, 'red.jpg'), 'red'),
    stripes: await picture(path.join(out, 'stripes.jpg'), 'stripes'),
    logo: await picture(path.join(out, 'logo.png'), 'logo'),
    light: await picture(path.join(out, 'logo-light.png'), 'logo-light'),
  };
  return assets;
}

const demo = readPack(DEMO);
const beat = (title, role = 'beat') => ({ kind: 'item', role, title, body: 'שורה אחת על השקף.', factKeys: [], sources: ['מקור'], imageQuery: 'zz plant' });
const SLIDES = [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }, beat('זמיוקולקס'), beat('סנסיווריה'), beat('פוטוס', 'payoff')];
const FORMAT = { id: 't', kind: 'story', name: 'x', hooks: ['x'] };

/** One account in one look, with or without a promo and a logo. */
function packOf(look, { promo = PRODUCT, logo = null, handle = 'shtil.bair', displayName = 'שתיל בעיר' } = {}) {
  const meta = { ...demo.meta, handle, displayName };
  if (promo) meta.promo = promo;
  else delete meta.promo;
  const p = LOOKS[look]({ ...demo, meta, brandLogo: logo });
  return { ...p, theme: themeOf(p) };
}

/** A post with its closing slide, signed as the fact gate signs it. */
function postOf(pack, line, { cta = 'תשמרו לפני שקונים שתיל', id = 'p' } = {}) {
  const { closing, refused } = closingSlide(pack, { line });
  assert.equal(closing.by, 'writer', `the line passes: ${refused.join(' | ')}`);
  const extra = { captionIg: '', keywords: [], subject: {}, cta, closing };
  const post = { id, hook: 'חדר בלי חלון?', sub: '', caption: 'c', extra, ctaKind: 'save' };
  post.token = tokenOf({ slides: SLIDES, caption: post.caption, hook: post.hook, sub: post.sub, extra });
  return { post, closing };
}

let n = 0;
/** The closing slide alone (only: its index), on both platforms: { size: what the renderer measured on it }. */
async function drawClosing(look, line, { photo = 'red', ...opts } = {}) {
  const a = await files();
  const pack = packOf(look, { ...opts, logo: opts.logo === undefined ? a.logo : opts.logo });
  const { post, closing } = postOf(pack, line, { id: `c${n++}` });
  const ph = { id: 1, file: a[photo] };
  const photos = new Map([[0, ph], [1, ph], [2, ph], ['bg', { ...ph, id: 2, query: 'house plants' }]]);
  const outDir = path.join(out, `${look}-${n}`);
  const drawn = await renderPost({ pack, format: FORMAT, post, slides: SLIDES, photos, outDir, only: new Set([SLIDES.length]) });
  return { drawn, closing, pack };
}

const words = (s) => String(s || '').replace(/[\s ]+/g, ' ').trim();

test('the closing slide in every style and template, on TikTok and Instagram: inside every band, no outline, shadow or page number, the line over the action', { timeout: 600_000 }, async () => {
  const cases = [
    { name: 'product', line: LINE, promo: PRODUCT },
    { name: 'follow', line: FOLLOW, promo: null, handle: 'hasafsal', displayName: 'הספסל', logo: null },
    { name: 'longest', line: LONGEST, promo: LONG_URL },
  ];
  for (const look of Object.keys(LOOKS)) {
    const ratio = {};
    for (const c of cases) {
      const { drawn, closing } = await drawClosing(look, c.line, c);
      for (const size of ['tiktok', 'instagram']) {
        const at = `${look} ${c.name} ${size}`;
        assert.equal(drawn[size].length, 1, `${at}: the closing slide is drawn`);
        const r = drawn.closing?.[size];
        assert.ok(r?.closing, `${at}: the renderer measured the closing slide`);
        const m = r.closing;
        // Every band of the platform was checked, the sides included, on every template.
        const z = SAFE_ZONES[size];
        assert.ok(r.zone.top >= z.top && r.zone.bottom <= H[size] - z.bottom, `${at}: the top and bottom bands (${JSON.stringify(r.zone)})`);
        assert.ok(r.zone.sides && r.zone.sides[0] >= z.left && r.zone.sides[1] <= 1080 - z.right, `${at}: the side bands, TikTok's button rail (${JSON.stringify(r.zone)})`);
        if (m.logo) for (const [k, v] of Object.entries({ top: m.logo.top >= z.top, bottom: m.logo.bottom <= H[size] - z.bottom, left: m.logo.left >= z.left, right: m.logo.right <= 1080 - z.right })) assert.ok(v, `${at}: the logo inside the ${k} band`);
        // Nothing on it but the line and the action: no counter, page number, handle, source or call to action.
        const action = closing.actions[size === 'tiktok' ? 'tiktok' : 'instagram'];
        assert.equal(words(m.text), words(`${c.line} ${action.text}`), `${at}: only the line and the action`);
        assert.equal(m.shadows, 0, `${at}: no outline and no shadow on anything`);
        assert.equal(r.outlined, 0, `${at}: the renderer outlined nothing`);
        // No address on TikTok, ever; the address on Instagram (and Facebook, which is sent Instagram's image).
        if (size === 'tiktok') {
          assert.doesNotMatch(m.text, /\.example|https?:|\//, `${at}: no address on TikTok`);
          assert.match(m.text, c.promo ? /הלינק בביו/ : /@hasafsal/);
        } else if (c.promo) assert.ok(m.text.includes(action.display), `${at}: the address ${action.display}`);
        // The line is the slide: never smaller than the action, by a clear step.
        assert.ok(m.line.px >= m.action.px * 1.25, `${at}: the line ${m.line.px}px over the action ${m.action.px}px`);
        (ratio[size] ??= []).push(m.line.px / m.action.px);
      }
    }
    // The same post looks the same on both platforms: the line over the action in the same proportion.
    for (const [i, t] of ratio.tiktok.entries()) assert.ok(Math.abs(ratio.instagram[i] / t - 1) < 0.2, `${look} case ${i}: TikTok ${t.toFixed(2)} and Instagram ${ratio.instagram[i].toFixed(2)}`);
  }
});

test("the customer's logo is drawn when the account has one, and its place closes up when it has none", { timeout: 300_000 }, async () => {
  const a = await files();
  for (const look of Object.keys(LOOKS)) {
    const withLogo = await drawClosing(look, LINE, { logo: a.logo });
    const without = await drawClosing(look, LINE, { logo: null });
    for (const size of ['tiktok', 'instagram']) {
      const w = withLogo.drawn.closing[size].closing;
      const o = without.drawn.closing[size].closing;
      assert.ok(w.logo && w.logo.width > 60 && w.logo.height > 30, `${look} ${size}: the logo is drawn`);
      assert.equal(w.tile, 'light', `${look} ${size}: a dark logo on a light tile`);
      assert.equal(o.logo, null, `${look} ${size}: no logo, no place for one`);
      // The group the logo was part of is shorter by the logo's height and its gap: nothing is left empty.
      assert.ok(o.group.height <= w.group.height - w.logo.height * 0.95, `${look} ${size}: ${o.group.height} vs ${w.group.height} with a ${w.logo.height}px logo`);
    }
  }
  // A light logo (white letters on a transparent ground) is set on a dark tile, where it reads.
  const light = await drawClosing('C', LINE, { logo: a.light });
  for (const size of ['tiktok', 'instagram']) assert.equal(light.drawn.closing[size].closing.tile, 'dark', `${size}: a light logo on a dark tile`);
  // Where the logo comes from: the account's brand/ folder, in any of the formats a store's site serves.
  const { home, cleanup } = tempHome();
  try {
    const dir = path.join(home, 'packs', 'demo');
    assert.equal(readPack(dir).brandLogo, null, 'no logo, none drawn');
    mkdirSync(path.join(dir, 'brand'));
    writeFileSync(path.join(dir, 'brand', 'logo.webp'), readFileSync(a.logo));
    assert.equal(path.basename(readPack(dir).brandLogo), 'logo.webp');
  } finally {
    cleanup();
  }
});

/** The share of a drawn slide that shows the photograph (#E0362C) nearly as it is: at most 30% under any veil. */
async function photoShare(file) {
  const tab = await (await getBrowser()).newPage();
  try {
    return await tab.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let hit = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] > 224 * 0.7 && d[i] - d[i + 1] > 170 * 0.7 && d[i] - d[i + 2] > 180 * 0.7) hit++;
      return hit / (d.length / 16);
    }, readFileSync(file).toString('base64'));
  } finally {
    await tab.close();
  }
}

test('the photograph shows, and every letter reads on any photograph: 4.5:1 against what is drawn behind it, measured', { timeout: 600_000 }, async () => {
  for (const look of Object.keys(LOOKS)) {
    // The worst case: the longest line, a logo and the longest address. On a red photograph, how much of it shows.
    const red = await drawClosing(look, LONGEST, { promo: LONG_URL });
    for (const size of ['tiktok', 'instagram']) {
      const share = await photoShare(red.drawn[size][0]);
      assert.ok(share >= 0.18, `${look} ${size}: ${Math.round(share * 100)}% of the slide shows the photograph`);
      assert.equal(red.drawn.grounds[size][SLIDES.length]?.length, 1, `${look} ${size}: the closing slide stands on a photograph of the post`);
    }
    // On white and black stripes, the brightest and darkest a photograph can be under every word.
    const striped = await drawClosing(look, LONGEST, { promo: LONG_URL, photo: 'stripes' });
    for (const size of ['tiktok', 'instagram']) {
      const cx = striped.drawn.closing[size].closing.contrast;
      assert.ok(cx.length >= 2, `${look} ${size}: the line and the action measured`);
      for (const x of cx) assert.ok(x.ratio >= 4.5, `${look} ${size}: "${x.text}" at ${x.ratio.toFixed(2)}:1`);
    }
  }
  // The renderer refuses a closing slide whose words do not read on what is behind them, or that has a shadow.
  const pack = packOf('C');
  const { closing } = closingSlide(pack, { line: LINE });
  const html = stylePage({ theme: pack.theme, size: 'tiktok', slide: { kind: 'end', closing: true, title: closing.line, action: closing.actions.tiktok } });
  await assert.rejects(renderHtml(html.replace('</style>', '.cl-line{color:#DDD8CC!important}</style>'), { size: 'tiktok', file: path.join(out, 'faint.jpg') }), (e) => e.code === 'contrast', 'a faint line is refused');
  await assert.rejects(renderHtml(html.replace('</style>', '.st.k-end .cw .cl-act{box-shadow:0 4px 12px #000!important}</style>'), { size: 'tiktok', file: path.join(out, 'shadow.jpg') }), (e) => e.code === 'outline', 'a shadow is refused');
});

test('a 60-character line of the widest letters is drawn in every style and template, never refused, the line still over the action', { timeout: 300_000 }, async () => {
  const { closingPage } = await import('../src/render/end.js');
  // Every letter one of the widest two (ש, מ): no real line is this wide, and it still fits, at its floor, in six lines.
  const wide = 'שמשם משמש משמשמ שמשם משמש משמשמ שמשם משמש משמשמ שמשם משמש מש';
  assert.equal([...wide].length, 60);
  for (const look of Object.keys(LOOKS)) {
    const pack = packOf(look, { promo: LONG_URL });
    const { closing } = closingSlide(pack, { line: LONGEST });
    for (const size of ['tiktok', 'instagram']) {
      const action = closing.actions[size === 'tiktok' ? 'tiktok' : 'instagram'];
      const html = pack.theme.style
        ? stylePage({ theme: pack.theme, size, slide: { kind: 'end', closing: true, title: wide, action, names: [closing.product, closing.name] } })
        : closingPage({ pack, size, closing: { ...closing, line: wide }, action });
      const r = await renderHtml(html, { size, file: path.join(out, `wide-${look}-${size}.jpg`), floor: 0.45 });
      assert.ok(r.closing.line.px >= r.closing.action.px * 1.25, `${look} ${size}: the line ${r.closing.line.px}px over the action ${r.closing.action.px}px`);
    }
  }
});

test('the side bands are checked on the closing slide of every template: a line pushed into the button rail is refused', { timeout: 120_000 }, async () => {
  const { closingPage } = await import('../src/render/end.js');
  for (const look of ['editorial', 'photocard']) {
    const pack = packOf(look);
    const { closing } = closingSlide(pack, { line: LONGEST });
    const html = closingPage({ pack, size: 'tiktok', closing, action: closing.actions.tiktok }).replace('</style>', '.cl-frame{padding-left:20px!important}.cl-line{white-space:nowrap!important;max-width:none!important}</style>');
    await assert.rejects(renderHtml(html, { size: 'tiktok', file: path.join(out, `rail-${look}.jpg`) }), (e) => e.code === 'safe_zone' && /across/.test(e.message), look);
  }
  for (const name of STYLE_NAMES) {
    const pack = packOf(name);
    const { closing } = closingSlide(pack, { line: LONGEST });
    const html = stylePage({ theme: pack.theme, size: 'tiktok', slide: { kind: 'end', closing: true, title: closing.line, action: closing.actions.tiktok } }).replace('</style>', '.blk{left:20px!important}.cl-line{white-space:nowrap!important}</style>');
    await assert.rejects(renderHtml(html, { size: 'tiktok', file: path.join(out, `rail-${name}.jpg`) }), (e) => ['safe_zone', 'fit'].includes(e.code), name);
  }
});

test("each format's old call to action is no longer drawn: the closing slide is the only action, and the call to action is still stored", { timeout: 300_000 }, async () => {
  const a = await files();
  const ph = { id: 1, file: a.red };
  const photos = new Map([[0, ph], [1, ph], [2, ph], [3, ph], ['bg', { ...ph, id: 2, query: 'house plants' }]]);
  for (const look of ['A', 'editorial']) {
    const pack = packOf(look);
    const lastContent = async (cta, withClosing) => {
      const { post } = postOf(pack, LINE, { cta, id: `cta-${look}-${n++}` });
      if (!withClosing) {
        delete post.extra.closing;
        post.token = tokenOf({ slides: SLIDES, caption: post.caption, hook: post.hook, sub: post.sub, extra: post.extra });
      }
      const drawn = await renderPost({ pack, format: FORMAT, post, slides: SLIDES, photos, outDir: path.join(out, `cta-${look}-${n++}`), platforms: ['tiktok'] });
      return readFileSync(drawn.tiktok[SLIDES.length - 1]);
    };
    // With the closing slide, the last content slide is the same whether or not the post carries a call to action.
    assert.ok((await lastContent('תשמרו לפני שקונים שתיל', true)).equals(await lastContent('', true)), `${look}: no call to action on the last content slide`);
    // A post made before the closing slide still closes as it did, on its call to action.
    assert.ok(!(await lastContent('תשמרו לפני שקונים שתיל', false)).equals(await lastContent('', false)), `${look}: an older post keeps its call to action`);
  }
  // The pipeline still chooses one and keeps it on the post, for the morning feedback that changes it (item 6).
  const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = PRODUCT) } });
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    ctx.mediaDir = path.join(home, 'media');
    const res = await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'plant-story', sample: true });
    assert.equal(res.status, 'sample', res.reason);
    const post = loadPost(ctx.db, res.postId);
    assert.ok(post.data.cta?.text, 'the call to action is stored');
    assert.ok(post.data.closing?.actions, 'and the post ends on its closing slide');
  } finally {
    cleanup();
  }
});
