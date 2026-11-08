import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { bandProfile, calmRoom, CALM_MAX, cropFor, FRAMES, subjectBand, subjectFits, subjectOf } from '../src/render/crop.js';
import { decor, LAYOUTS, PALETTES, slideTexture, TEXTURES, textureFor, textureTones, textureSvg } from '../src/render/textures.js';
import { luminance } from '../src/render/color.js';
import { mixFor, planPhotos } from '../src/render/render.js';
import { cornerNumber, needE, stylePage, themeOf, geo } from '../src/render/styles/index.js';
import { STYLES } from '../src/render/styles/tokens.js';
import { contrast } from '../src/render/color.js';
import { findImage, fitFor, headWord, PROVIDERS } from '../src/images/index.js';
import { imageSize } from '../src/images/size.js';
import { postMode, postTexture, shorterQuery } from '../src/pipeline/build.js';
import { closeBrowser, getBrowser } from '../src/render/render.js';
import { copyPack, opened, tempHome } from './helpers.js';

// The format itself, after the owner looked at the five samples (2026-11-06): "tiktok format should be 9:16. no
// landscape images with blurred background"; on the pets post, "the text should appear in an empty space in the
// background ... not on top of the nuts"; "not every slide should be this format. i also like more designed formats";
// and "if a slideshow ... fails because of them, we can use generated background, but from a few options: a cutting
// mat, paper texture, fabric texture, liquid glass, artisan texture. each time it should look different".

const realPexels = PROVIDERS.pexels;
afterEach(() => (PROVIDERS.pexels = realPexels));
after(() => closeBrowser());

/* ------------------------------------------------------------------ the cut */

test('a photograph is cut to its slide around its subject, and one whose subject a 9:16 cut would lose does not fit', () => {
  // A 3:2 landscape, its subject on the right: the cut keeps 37.5% of the width, moved to the subject.
  const wide = { w: 3000, h: 2000 };
  const c = cropFor(wide, FRAMES.tiktok, { cx: 0.8, cy: 0.5 });
  assert.ok(Math.abs(c.x1 - c.x0 - 0.375) < 1e-9);
  assert.ok(c.x0 <= 0.8 - 0.1 && c.x1 >= 0.8 + 0.1, 'the subject inside the cut');
  assert.equal(c.pos, '98% 50%', 'moved right, to the subject');
  // Two coins across the picture (the Judaica sample's cover, 2026-11-06): no 9:16 cut keeps them.
  assert.equal(subjectFits(wide, FRAMES.tiktok, { cx: 0.5, cy: 0.5, w: 0.62, h: 0.3 }), false);
  assert.equal(subjectFits(wide, FRAMES.tiktok, { cx: 0.5, cy: 0.5, w: 0.3, h: 0.3 }), true);
  assert.equal(subjectFits(wide, FRAMES.instagram, { cx: 0.5, cy: 0.5, w: 0.5, h: 0.3 }), true, 'a 4:5 cut keeps more');
  // The screen's measure, or none (an old screen): a subject nobody measured is cut at the middle and not avoided.
  assert.deepEqual(subjectOf({ model: { faceX: 30, faceY: 40, subjectW: 20, subjectH: 50 } }), { cx: 0.3, cy: 0.4, w: 0.2, h: 0.5, known: true });
  assert.equal(subjectOf({ model: { faceX: 50, faceY: 30 } }).known, false);
});

test("E's words stand in the photograph's calmest band, clear of its subject, and a busy photograph has none", () => {
  // A wall above, nuts in the lower half (the pets post's macadamia slide).
  const profile = Array.from({ length: 48 }, (_, i) => (i < 20 ? 0.03 : 0.3));
  const room = calmRoom({ profile, H: 1920, top: 230, bottom: 1500, need: 480 });
  assert.ok(room.calm && room.bottom <= 20 * 40, `on the wall (${room.top}-${room.bottom})`);
  // The subject in the calm part: the words go elsewhere, or nowhere calm.
  const off = calmRoom({ profile, H: 1920, top: 230, bottom: 1500, need: 480, avoid: { top: 200, bottom: 760 } });
  assert.ok(off.top >= 760);
  assert.equal(off.calm, false);
  assert.equal(calmRoom({ profile: profile.map(() => 0.25), H: 1920, top: 230, bottom: 1500, need: 480 }).calm, false, 'all busy');
  assert.ok(CALM_MAX > 0.03 && CALM_MAX < 0.3);
  // The band profile reads the cut part of the grid only.
  const grid = { cols: 2, rows: 2, cells: [0, 1, 0, 1] };
  assert.deepEqual(bandProfile(grid, { x0: 0, x1: 0.5, y0: 0, y1: 1 }, 2), [0, 0]);
  assert.deepEqual(subjectBand({ y0: 0, y1: 1 }, { cy: 0.5, h: 0.2 }, 1000), { top: 430, bottom: 570 });
  // The room is as tall as the slide's words.
  const g = geo('tiktok');
  assert.ok(needE({ kind: 'text', title: 'כותרת קצרה', body: '' }, g) < needE({ kind: 'text', title: 'כותרת\nבשתי שורות', body: 'גוף ארוך של שלוש שורות\nשממשיך עוד\nועוד קצת' }, g));
});

/* ------------------------------------------------------------------ the search */

let jpeg = null;
async function picture(home, { w = 1080, h = 1600, busy = false } = {}) {
  const tab = await (await getBrowser()).newPage();
  const b64 = await tab.evaluate(({ w, h, busy }) => {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#5a7d9a';
    g.fillRect(0, 0, w, h);
    // A busy picture: black-and-white blocks everywhere, as a heap of nuts or a page of print.
    if (busy) for (let y = 0; y < h; y += 30) for (let x = 0; x < w; x += 30) if (((x / 30) * 7 + (y / 30) * 13) % 5 < 2) (g.fillStyle = '#000'), g.fillRect(x, y, 30, 30);
    return cv.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, { w, h, busy });
  await tab.close();
  const file = path.join(home, `p-${w}x${h}-${busy ? 'busy' : 'calm'}.jpg`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

function account(home, style) {
  copyPack(home, 'demo', (f) => {
    f.pack.style = { name: style };
    f.pack.imagery = { providers: ['pexels'] };
  });
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  ctx.imagesLive = true;
  return { ctx, pack: ctx.pack('demo') };
}

const one = (file, extra = {}) => ({ provider: 'pexels', providerId: path.basename(file), title: 'garlic bulb', file, url: null, license: 'Pexels License', author: 'A', alt: 'garlic bulb', ...extra });

test('a styled account takes no photograph that cannot fill a 9:16 slide, and E none with no calm place for its words', { timeout: 120_000 }, async () => {
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, pack } = account(home, 'E');
    assert.deepEqual(fitFor(pack), { calm: true });
    const small = await picture(home, { w: 800, h: 450 });
    const busy = await picture(home, { busy: true });
    const good = await picture(home);
    const tried = (files) => {
      PROVIDERS.pexels = { id: 'pexels', ready: () => true, search: async () => files.map((f) => one(f)) };
    };
    const why = {};
    tried([small, busy]);
    assert.equal(await findImage(ctx, { pack, query: 'garlic bulb', why }), null);
    assert.equal(why['too small to fill a 9:16 slide'], 1, 'a band over a blurred copy, never again');
    assert.equal(why['no calm place for the words: a busy picture'], 1, 'words over the nuts, never again');
    tried([busy, good]);
    const img = await findImage(ctx, { pack, query: 'garlic bulb' });
    assert.equal(img.provider_id, path.basename(good), 'the next photograph, the calm one');
    // An account on another style keeps a busy photograph (its words stand on its own ground or card) but not a small one.
    const { home: h2, cleanup: c2 } = tempHome({ packs: {} });
    try {
      const a = account(h2, 'A');
      assert.deepEqual(fitFor(a.pack), { calm: false });
      tried([await picture(h2, { w: 800, h: 450 }), await picture(h2, { busy: true })]);
      const kept = await findImage(a.ctx, { pack: a.pack, query: 'garlic bulb' });
      assert.match(kept.provider_id, /busy/);
    } finally {
      c2();
    }
  } finally {
    cleanup();
  }
});

test('a WebP sent for a .jpg address is measured like any photograph, and a thing is searched by its name, not by what it does', () => {
  // VP8X: the canvas less one, 24 bits each (rawpixel's coin of 2026-11-06 went through the 9:16 checks unmeasured).
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'latin1');
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUIntLE(1023, 24, 3);
  buf.writeUIntLE(1023, 27, 3);
  assert.deepEqual(imageSize(buf), { type: 'webp', width: 1024, height: 1024, alpha: false });
  assert.equal(headWord('cat eating from bowl'), 'cat');
});

/* ------------------------------------------------------------------ the textures */

test('a texture is one of five, varies from post to post, never repeats the last post\'s, and every style\'s text reads on it', () => {
  const kinds = new Set(Array.from({ length: 30 }, (_, i) => textureFor(`p${i}x`).kind));
  assert.deepEqual([...kinds].sort(), [...TEXTURES].sort(), 'all five are used');
  const a = textureFor('pmw4uiz8gd1c4e10b');
  assert.deepEqual(textureFor('pmw4uiz8gd1c4e10b'), a, "one post's texture is its own, the same on every slide");
  assert.notEqual(textureFor('pmw4uiz8gd1c4e10b', { avoid: a.kind }).kind, a.kind);
  const seeds = new Set(Array.from({ length: 10 }, (_, i) => `${textureFor(`q${i}`).seed}:${textureFor(`q${i}`).angle}`));
  assert.ok(seeds.size >= 8, 'each its own seed and angle');
  // The letters of every style on every texture, in its own colours: 7:1 against its lightest tone.
  for (const name of Object.keys(STYLES)) {
    const theme = themeOf({ meta: { style: { name } }, theme: { colors: { accent: '#E8A33D' } } }, name);
    const c = theme.style.colors;
    for (const kind of TEXTURES) {
      const tones = textureTones({ kind, seed: 5, angle: 30, dark: STYLES[name].dark !== false }, { ground: c.bg, text: c.text, accent: c.accent });
      assert.ok(contrast(c.text, tones.light) >= 7, `${name} on ${kind}: ${contrast(c.text, tones.light).toFixed(1)}:1`);
      assert.match(textureSvg({ kind, seed: 5, angle: 30, dark: true }, tones, 1080, 1920), /^<svg /);
    }
  }
});

test('each slide of a post in text mode looks its own: the next colour of its playful palette, its own cut-outs, and the words still read', () => {
  // The owner, 2026-11-07: "each slide should have a different background, or at least look a bit different from the
  // first slide ... the background should always be playful".
  for (const name of Object.keys(STYLES)) {
    const theme = themeOf({ meta: { style: { name } }, theme: { colors: { accent: '#E8A33D' } } }, name);
    const c = theme.style.colors;
    for (const kind of TEXTURES) {
      for (const layout of LAYOUTS) {
        const post = { ...textureFor(`p-${name}-${kind}-${layout}`), kind, layout, dark: STYLES[name].dark !== false };
        const tones = [0, 1, 2, 3].map((i) => textureTones(slideTexture(post, i), { ground: c.bg, text: c.text, accent: c.accent }));
        const need = ['card', 'boxes'].includes(layout) ? 4.5 : 7;
        tones.forEach((t, i) => assert.ok(contrast(c.text, t.light) >= need, `${name} ${kind} ${layout} slide ${i}: ${contrast(c.text, t.light).toFixed(1)}:1`));
        assert.notEqual(tones[0].base, tones[1].base, `${name} ${kind}: the second slide is not the first one's colour`);
        assert.notEqual(decor(slideTexture(post, 0), tones[0], 1080, 1920), decor(slideTexture(post, 1), tones[1], 1080, 1920), 'its own cut-outs');
      }
    }
  }
  // Under light letters a slide's ground is never a pale colour deepened to olive: the pale ones decorate.
  const t = { ...textureFor('pYellow'), dark: true };
  for (let i = 0; i < 8; i++) {
    const own = PALETTES[t.palette].filter((x) => luminance(x) < 0.35)[i % PALETTES[t.palette].filter((x) => luminance(x) < 0.35).length];
    assert.ok(own, 'every palette has a deep colour');
  }
  assert.ok(PALETTES.every((p) => p.filter((x) => luminance(x) < 0.35).length >= 2), 'two deep colours a palette at least, so slides in a row differ');
});

test("a slide with no photograph stands on its post's texture in every style, never on a flat ground, on both platforms", async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const name of ['A', 'C', 'E']) {
      for (const size of ['tiktok', 'instagram']) {
        const theme = themeOf({ meta: { style: { name } }, theme: { colors: { accent: '#E8A33D' } } }, name);
        const html = stylePage({ theme, size, slide: { kind: 'item', role: 'fact', title: 'כותרת', body: 'שורה', factKeys: [], sources: [], texture: { kind: 'fabric', seed: 3, angle: 15, dark: true } } });
        assert.match(html, /class="texg"/, `${name} ${size}`);
        await tab.setViewportSize({ width: 1080, height: size === 'tiktok' ? 1920 : 1350 });
        await tab.setContent(html, { waitUntil: 'load' });
        // Its pixels vary over the whole slide: a flat ground is one colour.
        const spread = await tab.evaluate(async () => {
          const el = document.querySelector('.texg');
          const url = getComputedStyle(el).backgroundImage.slice(5, -2);
          const img = new Image();
          img.src = url;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = 120;
          c.height = 200;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, 120, 200);
          const d = g.getImageData(0, 0, 120, 200).data;
          const lum = [];
          for (let i = 0; i < d.length; i += 4) lum.push(d[i] + d[i + 1] + d[i + 2]);
          return Math.max(...lum) - Math.min(...lum);
        });
        assert.ok(spread > 6, `${name} ${size}: the texture has a pattern (${spread})`);
      }
    }
    // A slide with a photograph has no texture behind it.
    const theme = themeOf({ meta: { style: { name: 'E' } }, theme: { colors: { accent: '#E8A33D' } } }, 'E');
    assert.doesNotMatch(stylePage({ theme, size: 'tiktok', slide: { kind: 'item', title: 'x', body: '', photo: 'data:image/jpeg;base64,AA', factKeys: [], sources: [], texture: { kind: 'mat', seed: 1, angle: 0 } } }), /class="texg"/);
  } finally {
    await tab.close();
  }
});

test('a slide in text mode is designed: never plain centred text in one weight and one colour, in any style or layout', { timeout: 120_000 }, async () => {
  // The owner, 2026-11-06: "when there is no background image, the main visual eye catcher is the text design. you cant
  // just put white text on a background and think that the post will go viral".
  const tab = await (await getBrowser()).newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const name of Object.keys(STYLES)) {
      const theme = themeOf({ meta: { style: { name } }, theme: { colors: { accent: '#E8A33D' } } }, name);
      for (const layout of LAYOUTS) {
        for (const kind of ['cover', 'item']) {
          const texture = { kind: 'paper', seed: 4, angle: 10, dark: true, layout };
          const slide = kind === 'cover'
            ? { kind, hook: '5 טעויות שהורגות\nצמחים בעציץ', sub: 'ואף אחת מהן היא לא לשכוח להשקות', highlight: 'טעויות', factKeys: [], sources: [], texture }
            : { kind, role: 'tip', postKind: 'tips', n: 2, of: 5, title: 'משקים לפי השעון', body: 'רוב הצמחים בעציצים לא מתים מצמא, אלא מהשקיה מוגזמת.', highlight: 'השעון', factKeys: [], sources: [], texture };
          await tab.setContent(stylePage({ theme, size: 'tiktok', slide }), { waitUntil: 'load' });
          const look = await tab.evaluate(() => {
            const blk = document.querySelector('.blk.tl');
            const texts = [...blk.querySelectorAll('*')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
            const st = texts.map((el) => getComputedStyle(el));
            const filled = [...blk.querySelectorAll('*')].filter((el) => {
              const c = getComputedStyle(el).backgroundColor;
              return (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') || getComputedStyle(el).backgroundImage !== 'none';
            });
            return {
              type: new Set(st.map((x) => `${x.fontWeight}/${Math.round(parseFloat(x.fontSize) / 4)}`)).size,
              colours: new Set([...st.map((x) => x.color), ...filled.map((el) => getComputedStyle(el).backgroundColor)]).size,
              centred: st.every((x) => x.textAlign === 'center'),
              shapes: filled.length,
            };
          });
          const where = `${name} ${layout} ${kind}`;
          assert.ok(look.type >= 2, `${where}: two sizes or weights at least`);
          assert.ok(look.colours >= 2, `${where}: more than one colour`);
          assert.ok(!(look.centred && look.shapes === 0), `${where}: not bare centred text`);
          assert.ok(look.shapes >= 1, `${where}: a shape of the design (a box, a bar, a sticker, a card, a stroke)`);
        }
      }
    }
  } finally {
    await tab.close();
  }
});

test('a post in text mode keeps one layout on all its slides, and the layout changes from post to post', async () => {
  const layouts = new Set(Array.from({ length: 40 }, (_, i) => textureFor(`post${i}`).layout));
  assert.deepEqual([...layouts].sort(), [...LAYOUTS].sort(), 'every layout is used');
  const t = textureFor('pOne');
  assert.equal(textureFor('pOne').layout, t.layout, "one post's layout is its own: every slide is drawn from the same texture");
  for (let i = 0; i < 12; i++) assert.notEqual(textureFor(`pTwo${i}`, { avoid: t.kind, avoidLayout: t.layout }).layout, t.layout, 'never the last post\'s layout');
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, pack } = account(home, 'A');
    const first = postTexture(ctx.db, pack, 'pFirst');
    ctx.db.insert('posts', { id: 'pFirst', account_id: 'demo', format_id: 'x', kind: 'facts', grp: 'number', status: 'sample', sample: 1, checks_json: { texture: first }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    for (let i = 0; i < 8; i++) assert.notEqual(postTexture(ctx.db, pack, `pNext${i}`).layout, first.layout);
  } finally {
    cleanup();
  }
});

test('a post is all photographs only when every slide, its cover included, has its own; a scene does not count', () => {
  const p = (keys) => new Map(keys.map((k) => [k, { id: String(k) }]));
  assert.equal(postMode({ photos: p([0, 1, 2, 3]), slides: 4 }), 'photos');
  // A post about something to see looks again a word shorter (build.js findPhotos, needsPhotos).
  assert.equal(shorterQuery('cooked chicken bones'), 'chicken bones');
  assert.equal(shorterQuery('dog in kitchen'), 'dog');
  assert.equal(shorterQuery('grapes and raisins'), null);
  assert.equal(shorterQuery('macadamia nuts'), null);
  assert.equal(postMode({ photos: p([0, 1, 3]), slides: 4 }), 'text', 'one slide without: the whole post is text');
  assert.equal(postMode({ photos: p([1, 2, 3, 'bg']), slides: 4 }), 'text', 'a cover on a scene is not on its own photograph');
  assert.equal(postMode({ photos: p(['bg', 'bg2']), slides: 3 }), 'text');
});

test("a source's name is shown as letters, never as its feed's entities", async () => {
  const { sourcesOf } = await import('../src/render/styles/model.js');
  assert.equal(sourcesOf({ sources: ['My Jewish Learning &raquo; Feed'] }), 'מקור: <bdi dir="auto">My Jewish Learning » Feed</bdi>');
});

test("a post's texture is not the one its account's last post had", async () => {
  const { home, cleanup } = tempHome({ packs: {} });
  try {
    const { ctx, pack } = account(home, 'E');
    const first = postTexture(ctx.db, pack, 'pFirst');
    ctx.db.insert('posts', { id: 'pFirst', account_id: 'demo', format_id: 'x', kind: 'facts', grp: 'number', status: 'sample', sample: 1, checks_json: { texture: first }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    for (let i = 0; i < 8; i++) assert.notEqual(postTexture(ctx.db, pack, `pNext${i}`).kind, first.kind);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ variety, and the plan */

test('an E post draws its number and graphic slides in A, a third of its slides at most; one style when the account keeps to one', () => {
  const pack = { meta: { style: { name: 'E' } }, theme: { style: { name: 'E' } } };
  const item = (title, extra = {}) => ({ kind: 'item', role: 'fact', title, body: '', ...extra });
  const slides = [{ kind: 'cover' }, item('17 כיכרות זהב'), item('שורה רגילה'), item('גרף', { visual: { type: 'bars', items: [] } }), item('עוד שורה'), item('19 שנה'), item('ועוד אחת')];
  const mixed = mixFor(pack, slides);
  assert.ok(mixed.size >= 1 && mixed.size <= 2, `a few slides only (${[...mixed]})`);
  for (const i of mixed) assert.ok(i > 0);
  assert.equal(mixFor({ ...pack, meta: { style: { name: 'E', mix: false } } }, slides).size, 0, 'the account chose one style');
  assert.equal(mixFor({ meta: { style: { name: 'A' } }, theme: { style: { name: 'A' } } }, slides).size, 0, 'only E mixes');
});

test("with a texture, a slide with no photograph of its own does not repeat another slide's photograph", () => {
  const ph = (query) => ({ file: 'x.jpg', query });
  const slides = [{ kind: 'cover' }, { kind: 'item', imageQuery: 'cooked chicken bones' }, { kind: 'item', imageQuery: 'garlic' }];
  const byIdx = new Map([[0, ph('dog in kitchen')], [2, ph('garlic')]]);
  assert.equal(planPhotos({ slides, byIdx, postKind: 'tips' }).plan.get(1), 0, 'without one, the cover again');
  assert.equal(planPhotos({ slides, byIdx, postKind: 'tips', texture: true }).plan.has(1), false, 'with one, its texture');
});

test('the pickers show a drawn example of every kind of slideshow and every style, small, lazy and described', async () => {
  const { formatsPicker } = await import('../src/web/formats.js');
  const { designPanel } = await import('../src/web/styles.js');
  const { LIBRARY } = await import('../src/formats/library.js');
  const { EXAMPLE_FILE, exampleSrc } = await import('../src/web/examples.js');
  const picker = formatsPicker([]);
  for (const f of LIBRARY) {
    assert.ok(exampleSrc(`format-${f.id}`), `an example of ${f.id} is drawn (scripts/render-examples.js)`);
    assert.match(picker, new RegExp(`<img class="fmt-ex" src="/static/examples/format-${f.id}\.jpg" alt="דוגמה לשקף של [^"]+" loading="lazy"`));
  }
  const panel = designPanel({ id: 'x', meta: { style: { name: 'E' } } }, 'E');
  for (const s of ['A', 'B', 'C', 'D', 'E']) assert.match(panel, new RegExp(`src="/static/examples/style-${s}\.jpg" alt="דוגמה לשער בסגנון ${s}`));
  // The route serves these and nothing else under the folder (no path, no other file).
  assert.ok(EXAMPLE_FILE.test('format-story.jpg') && EXAMPLE_FILE.test('style-E.jpg'));
  for (const bad of ['../style.css', 'photos', 'credits.json', 'style-F.jpg', 'format-x.png']) assert.equal(EXAMPLE_FILE.test(bad), false, bad);
});

test("a feed's name on a slide is the site's, without the word the site adds for its feed", async () => {
  const { declaredFeeds, feedName } = await import('../src/sources/rss.js');
  assert.equal(declaredFeeds('<link rel="alternate" type="application/rss+xml" title="My Jewish Learning &raquo; Feed" href="/feed">', 'https://x.test/')[0].title, 'My Jewish Learning');
  assert.equal(feedName('Ynet - RSS'), 'Ynet');
  assert.equal(feedName('My Jewish Learning • Feed'), 'My Jewish Learning');
  assert.equal(feedName('Feed'), 'Feed', 'a title that is only the word stays');
});

test("the corner's sticker: a number slide's number when its line says none, else the slide's place, so a post counts 1 to 5", () => {
  const num = (title) => ({ kind: 'number', title, value: { num: '488' }, rank: '' });
  assert.equal(cornerNumber(num('פירורים לכל בסיס'), { n: 4 }), '488', 'the number is the news: big on the sticker');
  assert.equal(cornerNumber(num('244 גרם פירורים לכל בסיס'), { n: 4 }), '4', 'the line says a number: the sticker keeps the place');
  assert.equal(cornerNumber({ kind: 'text', title: 'כד של פירורים', rank: '' }, { n: 2 }), '2');
});

test("style A's check measures a slide's words in the card they are drawn on, so a line that runs over is sent back, not drawn", async () => {
  // A myth's line passed the check at the slide's 760px and ran a third line on its photograph's card, 652px, which
  // stopped the post at the drawing (2026-11-08).
  const { styleFitProblems } = await import('../src/render/styles/fit.js');
  const draft = { hook: 'מיתוסים על קפה', sub: '', slides: [{ kind: 'cover', title: '' }, { kind: 'item', role: 'myth', title: 'רובוסטה זה קפה שכמעט\nלא שותים', highlight: 'לא שותים', body: '' }] };
  const problems = styleFitProblems(draft, { style: 'A', platforms: ['tiktok', 'instagram'], postKind: 'myth-fact' });
  assert.ok(problems.some((p) => p.where === 'slide 1 title' && /too long/.test(p.msg)), JSON.stringify(problems));
  assert.equal(styleFitProblems({ ...draft, slides: [draft.slides[0], { ...draft.slides[1], title: 'רובוסטה זה קפה\nשכמעט לא שותים' }] }, { style: 'A', platforms: ['tiktok'], postKind: 'myth-fact' }).filter((p) => p.where === 'slide 1 title').length, 0, 'the same words broken to fit pass');
});
