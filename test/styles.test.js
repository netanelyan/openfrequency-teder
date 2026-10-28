import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPack } from '../src/packs/load.js';
import { validateAll, validatePack } from '../src/packs/validate.js';
import { closeBrowser, getBrowser, renderHtml } from '../src/render/render.js';
import { fitE, geo, stylePage, themeOf } from '../src/render/styles/index.js';
import { displayText, highlightIn, slideModel, textHtml } from '../src/render/styles/model.js';
import { fitText, highlightProblems, styleFitProblems, boxFor } from '../src/render/styles/fit.js';
import { resolveStyle, STYLE_NAMES, STYLES, styleConfigProblems } from '../src/render/styles/tokens.js';
import { SAFE_ZONES, zonesFor } from '../src/rules/overlay.js';
import { suggestStyle } from '../src/onboarding/style.js';
import { judgeStyles } from '../src/metrics/feedback.js';
import { previewHighlight } from '../src/render/styles/preview.js';
import { DEMO } from './helpers.js';

after(() => closeBrowser());

const out = mkdtempSync(path.join(os.tmpdir(), 'of-styles-'));
const photo = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#e8e4d8"/><rect y="900" width="1200" height="700" fill="#556"/></svg>')}`;
const pack = readPack(DEMO);
const themed = (name) => themeOf({ ...pack, meta: { ...pack.meta, style: { name } } });

const cover = { kind: 'cover', hook: 'הקרב שלא קרה:\nנגאנו מול קורמיה', sub: 'שיא עולמי מול המכה הכי חזקה', highlight: 'נגאנו', category: 'ראש בראש', photo };
const number = {
  kind: 'item', role: 'rank', rank: 5, n: 1, of: 5, pos: 1, postKind: 'ranking', title: 'קאקה עבר לריאל', highlight: 'ריאל',
  body: '67 מיליון יורו, שיא עולם בזמנו. ריאל קנתה אותו ממילאן.', visual: { type: 'stat', title: '', items: [{ label: 'מילאן לריאל', value: '67 מיליון יורו' }] }, photo,
};
const text = { kind: 'item', role: 'beat', postKind: 'story', n: 2, of: 4, pos: 2, title: 'הלילה באיסטנבול', body: 'ליברפול פיגרה 3–0 במחצית.\nשש דקות אחר כך זה היה 3–3.' };
const slides = { cover, number, text };

const draw = (name, slide, size = 'tiktok') => stylePage({ theme: themed(name), size, slide });

test('every style draws a cover, a number slide and a text slide, on TikTok and on Instagram 4:5, inside the safe zones', async () => {
  for (const name of STYLE_NAMES) {
    for (const size of ['tiktok', 'instagram']) {
      for (const [k, slide] of Object.entries(slides)) {
        // Not lenient: a line in a safe zone, or a text over its style's lines at its floor, throws.
        const r = await renderHtml(draw(name, slide, size), { size, file: path.join(out, `${name}-${size}-${k}.jpg`) });
        assert.ok(r.bytes > 0, `${name} ${size} ${k}`);
        assert.deepEqual(r.warnings, []);
      }
    }
  }
});

// E's box look (its text on white boxes) has none either: only its "shadow" look, the default, draws one, on its own
// lines (checked below).
test('no outline and no shadow on any letter, and no progress bar, counter, dots or handle on a slide', async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const name of STYLE_NAMES) {
      for (const slide of Object.values(slides)) {
        const html = name === 'E' ? drawE('box', { ...slide, handle: 'demo.bench', displayName: 'דמו' }) : draw(name, { ...slide, handle: 'demo.bench', displayName: 'דמו' });
        assert.doesNotMatch(html, /class="(track|count|dots|ghost|qmark|handle-tag|bgphoto|bgveil)"/);
        assert.doesNotMatch(html, /@demo\.bench/, 'the handle is not on a slide');
        await tab.setContent(html);
        const bad = await tab.evaluate(() =>
          // The backdrop (.bf) is the one blurred thing: the slide's own photograph behind the design, never a letter.
          [...document.querySelectorAll('body *:not(.bf)')]
            .map((el) => getComputedStyle(el))
            .filter((cs) => cs.textShadow !== 'none' || parseFloat(cs.webkitTextStrokeWidth) > 0 || /blur/.test(cs.filter)).length
        );
        assert.equal(bad, 0, `style ${name}`);
      }
    }
  } finally {
    await tab.close();
  }
});

test('no label at the top of a slide: no eyebrow over a headline, in any style', async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const name of STYLE_NAMES) {
      for (const slide of [cover, number, text, { ...text, photo }]) {
        const html = draw(name, slide);
        assert.doesNotMatch(html, /ראש בראש/, `style ${name}: the cover's category is not drawn`);
        await tab.setContent(html);
        // Nothing sits above the headline but the slide's own number (C sets it first) and C's and D's label chips.
        const above = await tab.evaluate(() => {
          const hl = document.querySelector('.hl');
          if (!hl) return [];
          const top = hl.getBoundingClientRect().top;
          return [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim() && !el.closest('.probe,style,title') && el.getBoundingClientRect().bottom < top - 1 && !el.closest('.chip,.nrow,.sides')).map((el) => el.textContent.trim());
        });
        assert.deepEqual(above, [], `style ${name} ${slide.kind}: text above the headline`);
      }
    }
    // C's label sits on the photograph's lower edge; with no photograph there is none.
    assert.doesNotMatch(draw('C', text), /class="chip/);
    assert.match(draw('C', { ...text, photo }), /class="chip"/);
  } finally {
    await tab.close();
  }
});

test("a highlight block (B, D) is a band behind its letters that stays inside its own line", async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const name of ['B', 'D']) {
      await tab.setContent(draw(name, { ...cover, hook: 'הגמר שברזיל\nהפסידה בבית', highlight: 'בבית' }));
      const bg = await tab.evaluate(() => getComputedStyle(document.querySelector('mark.hi')).backgroundImage);
      assert.match(bg, /linear-gradient/, `style ${name}`);
      assert.match(bg, /14%.*97%/, `style ${name}: from just above the letters to just below them`);
    }
  } finally {
    await tab.close();
  }
});

test('the safe zones are px on all four sides, and a line in a side band is refused', async () => {
  assert.deepEqual(SAFE_ZONES.tiktok, { top: 140, bottom: 420, right: 152, left: 152 });
  assert.deepEqual(SAFE_ZONES.instagram, { top: 80, bottom: 120, right: 96, left: 96 });
  // An account's own wider band (pack.json overlay.safeZone) widens it.
  assert.equal(zonesFor('tiktok', { safeZone: { top: 0.12 } }).top, Math.ceil(0.12 * 1920));
  const html = draw('D', text).replace('</style>', '.blk{left:40px!important;right:40px!important}.bd{white-space:nowrap}</style>');
  await assert.rejects(renderHtml(html.replace('ליברפול פיגרה 3–0 במחצית.', 'ליברפול פיגרה 3–0 במחצית והאוהדים כבר עזבו את היציע'), { size: 'tiktok', file: path.join(out, 'side.jpg') }), (e) => e.code === 'safe_zone');
});

test('a highlight is drawn once a slide, only on words of its own headline', async () => {
  assert.equal((textHtml('גול ועוד גול', { highlight: 'גול' }).match(/<mark/g) || []).length, 1);
  assert.equal(textHtml('גול ועוד גול', { highlight: 'שער' }).includes('<mark'), false, 'words not in the headline are never added');
  const browser = await getBrowser();
  const tab = await browser.newPage();
  try {
    for (const name of STYLE_NAMES) {
      // E's native look marks nothing (below): its box look is the one with a highlight.
      await tab.setContent(name === 'E' ? drawE('box', { ...cover, sub: 'נגאנו נגאנו נגאנו' }) : draw(name, { ...cover, sub: 'נגאנו נגאנו נגאנו' }));
      assert.equal(await tab.evaluate(() => document.querySelectorAll('mark.hi').length), 1, `style ${name}`);
    }
  } finally {
    await tab.close();
  }
  const d = { hook: 'שיא של 17 הגשות', slides: [{ kind: 'cover', highlight: '17 הגשות' }, { kind: 'item', title: 'אוליביירה בשיא', highlight: 'מקגרגור' }, { kind: 'item', title: 'ארבע מילים בלי הדגשה', highlight: 'ארבע מילים בלי הדגשה' }] };
  const ps = highlightProblems(d);
  assert.deepEqual(ps.map((p) => p.where), ['slide 1 title', 'slide 2 title']);
  assert.match(ps[0].msg, /not words of the title/);
});

test('fonts are bundled and inlined: the page names no address, and the renderer (with no network) checks every face', async () => {
  for (const name of STYLE_NAMES) {
    const html = draw(name, cover);
    assert.doesNotMatch(html.replace(/data:[^)"']+/g, ''), /https?:\/\//, 'nothing is fetched');
    const families = [...new Set([...html.matchAll(/font-family:'([^']+)'/g)].map((m) => m[1]))];
    for (const f of families) assert.ok(['Heebo', 'Assistant', 'Rubik', 'Karantina', 'Karantina Headline'].includes(f), f);
  }
  // renderHtml aborts every request and refuses a page whose faces did not load: a render that passes loaded them.
  const r = await renderHtml(draw('B', cover), { size: 'tiktok', file: path.join(out, 'fonts.jpg') });
  assert.ok(r.bytes > 0);
});

test('a headline is set smaller in steps down to its floor before it takes a line; past the floor it is the writer\'s', async () => {
  const S = STYLES.A.text.hook;
  const box = boxFor(S);
  const short = fitText('שיא של 17', S, { box });
  assert.equal(short.ok, true);
  assert.equal(short.px, S.px, 'a short headline keeps its size');
  const two = fitText('17 הגשות בקריירה\nשיא של כל הזמנים', S, { box });
  assert.ok(two.ok && two.px < S.px && two.px >= S.floor, `shrunk to ${two.px}`);
  const long = fitText('מי שווה הכי הרבה בעולם ה-AI? חמש חברות, מדד אחד ושווי אחד שמשנה את כל התמונה של השוק', S, { box });
  assert.equal(long.ok, false);
  assert.equal(long.px, S.floor);
  // The renderer agrees: drawn at its floor and refused.
  const html = draw('A', { ...cover, hook: 'מי שווה הכי הרבה בעולם ה-AI? חמש חברות, מדד אחד ושווי אחד שמשנה את כל התמונה של השוק' });
  await assert.rejects(renderHtml(html, { size: 'tiktok', file: path.join(out, 'long.jpg') }), (e) => e.code === 'fit');
  const lenient = await renderHtml(html, { size: 'tiktok', file: path.join(out, 'long2.jpg'), lenient: true });
  assert.ok(lenient.warnings.some((w) => w.code === 'fit'));
  // And the check sends it back to the writer, on the cover, through the repair loop.
  const draft = { hook: 'מי שווה הכי הרבה בעולם ה-AI? חמש חברות, מדד אחד ושווי אחד שמשנה את כל התמונה של השוק', sub: '', slides: [{ kind: 'cover' }] };
  const ps = styleFitProblems(draft, { style: 'A' });
  assert.equal(ps[0].where, 'cover');
  assert.equal(ps[0].code, 'fit');
  assert.match(ps[0].msg, /Shorten it to about \d+ characters/);
  // A headline the browser fits at a smaller size is drawn no smaller than its floor.
  const r = await renderHtml(draw('D', { ...cover, hook: '17 הגשות בקריירה\nשיא של כל הזמנים' }), { size: 'tiktok', file: path.join(out, 'shrunk.jpg') });
  const hook = r.fitted.find((f) => /הגשות/.test(f.text));
  assert.ok(hook.to >= STYLES.D.text.hook.floor && hook.to <= STYLES.D.text.hook.px);
});

test('no line ends on one word alone, punctuation stays on its word, two Latin words stay one run', () => {
  assert.equal(displayText('הקרב שלא קרה\nנגאנו'), 'הקרב שלא קרה נגאנו', 'a one-word last line joins the line before');
  assert.equal(displayText('מה קרה לרונאלדיניו אחרי בארסה?'), 'מה קרה לרונאלדיניו אחרי בארסה?');
  assert.equal(displayText('הניצחון של Better Place'), 'הניצחון של Better Place', 'never glued inside a Latin run');
  assert.equal(displayText('שתי דקות – ושער'), 'שתי דקות – ושער', 'a dash on its own stays with the word before it');
  assert.ok(highlightIn('בעולם ה-AI?', 'AI'));
});

test('words held together are let go where they would not fit: a poster headline breaks rather than being refused', async () => {
  const title = 'ניו זילנד, ב-23 במרץ 1988';
  const S = STYLES.B.text.title;
  assert.equal(fitText(title, S, { box: boxFor(S) }).ok, true, 'the check does not refuse it');
  const slide = { kind: 'item', role: 'beat', postKind: 'story', n: 1, of: 3, title, body: 'ישראל ניצחה בחוץ ועלתה לשלב הבא.' };
  const r = await renderHtml(draw('B', slide), { size: 'tiktok', file: path.join(out, 'letgo.jpg') });
  assert.deepEqual(r.warnings, []);
  const hook = 'מלמיליאן בגמר הגביע';
  assert.equal(fitText(hook, STYLES.B.text.hook, { box: boxFor(STYLES.B.text.hook) }).ok, true);
});

test("a slide is a number slide when its point is a number, else a title and its text", () => {
  assert.equal(slideModel(number).kind, 'number');
  assert.equal(slideModel(number).value.num, '67');
  assert.equal(slideModel(text).kind, 'text');
  assert.equal(slideModel({ kind: 'item', role: 'beat', postKind: 'story', title: 'x', body: 'y', visual: { type: 'stat', title: 'שערים', items: [{ label: 'בעונה', value: '34' }] } }).kind, 'number');
});

test('pack.json style: the tokens, the brand colour over the accent unless it does not read, and the spread', () => {
  assert.deepEqual(styleConfigProblems({ name: 'B', accent: '#FFD23F' }), []);
  assert.match(styleConfigProblems({ name: 'F' })[0], /style.name/);
  assert.deepEqual(styleConfigProblems({ name: 'E' }), []);
  assert.deepEqual(styleConfigProblems({ name: 'E', text: 'shadow' }), []);
  assert.deepEqual(styleConfigProblems({ name: 'B', text: 'shadow' }), [], "kept beside another style, after a switch away from E");
  assert.match(styleConfigProblems({ name: 'E', text: 'outline' }).join(' '), /style.text is "box" or "shadow"/);
  assert.match(styleConfigProblems({ name: 'C', panel: '#333333' }).join(' '), /needs 7:1/);
  assert.equal(resolveStyle({ name: 'B' }, '#FFD23F').colors.accent, '#FFD23F', 'the brand colour');
  assert.equal(resolveStyle({ name: 'C' }, '#FFD23F').colors.accent, STYLES.C.tokens.accent, 'yellow does not read on the light panel');
  assert.equal(resolveStyle({ name: 'A', accent: '#FF5A5F' }, '#4C8DFF').colors.accent, '#FF5A5F', "the pack's own token first");
  const a = { ...pack, dirName: 'demo', meta: { ...pack.meta, style: { name: 'B', accent: '#FFD23F' } } };
  assert.deepEqual(validatePack(a).filter((p) => /style/.test(p)), []);
  const b = { ...pack, meta: { ...pack.meta, id: 'other', handle: 'other.x', displayName: 'אחר', zernio: {}, style: { name: 'B', accent: '#FFCF40' } }, theme: { ...pack.theme, template: 'poster', fonts: { ...pack.theme.fonts, display: 'Suez One' }, colors: { ...pack.theme.colors, bg: '#FFFFFF', accent: '#A00000' } } };
  assert.ok(validateAll([a, b]).some((p) => /share style B/.test(p)));
});

test('onboarding suggests a style from the niche and the brand, away from a look-alike', () => {
  // E wherever the account entertains, the niche's own style next; A for money and data.
  assert.deepEqual(suggestStyle({ niche: 'כדורגל' }).ranked.slice(0, 2), ['E', 'B']);
  assert.deepEqual(suggestStyle({ niche: 'UFC ואגרוף' }).ranked.slice(0, 2), ['E', 'B']);
  assert.equal(suggestStyle({ niche: 'טיפים לבינה מלאכותית', topics: ['ChatGPT', 'Claude'] }).name, 'E');
  assert.equal(suggestStyle({ niche: 'חנות בגדים' }).name, 'E');
  assert.equal(suggestStyle({ niche: 'סטארטאפים ומחירי מוצרים', topics: ['AI', 'founders'] }).name, 'A');
  assert.equal(suggestStyle({ niche: 'השקעות, מניות ומשכנתא' }).name, 'A');
  const light = suggestStyle({ niche: 'מתכונים לילדים' }, { bg: '#FFF8F0' });
  assert.deepEqual(light.ranked.slice(0, 2), ['E', 'C'], 'a light brand moves C up, to just behind E');
  assert.deepEqual(suggestStyle({ niche: 'היסטוריה' }).ranked.slice(0, 2), ['E', 'D']);
  assert.equal(suggestStyle({ niche: 'תחביבים' }).name, 'E', 'the default');
  assert.equal(suggestStyle({ niche: 'אופנה' }, { bg: '#050505' }).ranked.at(-1), 'C', 'a strongly dark brand never gets C');
  const other = { meta: { topics: ['כדורגל'], style: { name: 'E' } }, theme: { colors: { accent: '#FFC24D' } } };
  const s = suggestStyle({ niche: 'כדורגל' }, { accent: '#FFC850' }, [other]);
  assert.equal(s.name, 'B', 'the second football account in a close colour gets the next best');
  assert.equal(suggestStyle({ niche: 'כדורגל' }, { accent: '#2F6BFF' }, [other]).name, 'E', 'another colour may share the style');
});

test('a style test is judged on views and engagement together, and not at all on too few posts', () => {
  const row = (style, views, engagement) => ({ style, views, engagement });
  const rows = [row('A', 1000, 50), row('A', 1200, 60), row('A', 900, 40), row('B', 3000, 200), row('B', 2500, 150), row('B', 2800, 160)];
  assert.equal(judgeStyles(rows, ['A', 'B']).winner, 'B');
  assert.equal(judgeStyles(rows.slice(0, 4), ['A', 'B']).winner, null);
});

test("a preview's highlight is chosen in code only where a post has none: a number or a name, never the whole headline", () => {
  assert.equal(previewHighlight('ב-2003 הוא חתם בבארסה'), '2003');
  assert.equal(previewHighlight('מי שווה הכי הרבה בעולם ה-AI?'), 'AI');
  assert.equal(previewHighlight('Thinking Machines Lab'), '');
  assert.equal(previewHighlight('הקרב שלא קרה'), '');
});

/* ------------------------------------------------------------------------------------------------ E: native */

const themedE = (look) => themeOf({ ...pack, meta: { ...pack.meta, style: { name: 'E', ...(look ? { text: look } : {}) } } });
const drawE = (look, slide, size = 'tiktok') => stylePage({ theme: themedE(look), size, slide });

test('E, native: every slide in both looks, on TikTok and on Instagram 4:5, right to left Hebrew, inside the safe zones', async () => {
  const all = { ...slides, photoText: { ...text, photo, sources: ['ויקיפדיה'] }, end: { kind: 'end', title: 'עוד סיפורים כאלה?', body: 'עקבו', handle: 'demo.bench' } };
  for (const look of ['box', 'shadow']) {
    for (const size of ['tiktok', 'instagram']) {
      for (const [k, slide] of Object.entries(all)) {
        const html = drawE(look, slide, size);
        assert.match(html, /<html lang="he" dir="rtl">/);
        assert.match(html, new RegExp(`class="st st-E [^"]*tx-${look}`));
        // Not lenient: a line in a safe zone (the source's line at the foot too), or a text over its lines at its floor, throws.
        const r = await renderHtml(html, { size, file: path.join(out, `E-${look}-${size}-${k}.jpg`) });
        assert.ok(r.bytes > 0, `${look} ${size} ${k}`);
        assert.deepEqual(r.warnings, []);
      }
    }
  }
});

test("E's photograph fills the slide, sharp, with only a light shade behind the text; a slide with none stands on the solid ground", async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    for (const look of ['box', 'shadow']) {
      for (const slide of [cover, number, { ...text, photo }]) {
        await tab.setContent(drawE(look, slide));
        const ph = await tab.evaluate(() => {
          const img = document.querySelector('img.ph');
          const r = img.getBoundingClientRect();
          const cs = getComputedStyle(img);
          const ov = document.querySelector('.ov');
          return { box: [r.left, r.top, r.width, r.height], fit: cs.objectFit, filter: cs.filter, opacity: cs.opacity, imgs: document.querySelectorAll('img').length, max: Number(ov?.dataset.max) };
        });
        assert.deepEqual(ph.box, [0, 0, 1080, 1920], `${look} ${slide.kind}: full-bleed`);
        assert.equal(ph.fit, 'cover');
        assert.equal(ph.filter, 'none', 'never blurred');
        assert.equal(ph.opacity, '1');
        assert.equal(ph.imgs, 1, 'one photograph a slide');
        assert.ok(ph.max <= 0.5, `${look}: the shade is light (${ph.max})`);
      }
      // A slide with no photograph: the solid ground, no image, no shade.
      await tab.setContent(drawE(look, text));
      assert.deepEqual(await tab.evaluate(() => [document.querySelectorAll('img, .ov').length, getComputedStyle(document.body).backgroundColor]), [0, 'rgb(18, 18, 18)']);
    }
  } finally {
    await tab.close();
  }
});

test('E: one thing a slide (a photograph wins over a graphic), no counter, label, handle or logo; a ranking keeps its place', () => {
  const graphic = { kind: 'item', role: 'beat', postKind: 'story', n: 2, of: 4, pos: 2, title: 'מי כבש יותר', body: 'שני החלוצים, עונה אחת.', visual: { type: 'compare', title: '', a: 'הולאנד', b: 'קיין', style: '', items: [{ label: 'שערים', value: '36', value2: '30' }] } };
  assert.match(drawE('box', graphic), /class="gfx"/, 'with no photograph the graphic is drawn on the ground');
  assert.doesNotMatch(drawE('box', { ...graphic, photo }), /class="gfx"|class="vis/, 'with a photograph the photograph is the slide');
  const clue = { kind: 'item', role: 'clue', postKind: 'guess-who', n: 2, of: 3, clues: 3, pos: 2, title: 'שיחק בשלוש ליגות', body: 'ובכל אחת זכה באליפות.', photo, handle: 'demo.bench', displayName: 'דמו', brand: photo };
  const html = drawE('box', clue);
  assert.doesNotMatch(html, /מתוך|רמז 2|@demo\.bench|class="(chip|track|count|dots|ghost|handle|handle-tag|brand|cue|key)"/);
  assert.equal((html.match(/<img/g) || []).length, 1, 'no logo');
  const ranked = { kind: 'item', role: 'rank', rank: 4, postKind: 'ranking', n: 2, of: 5, pos: 2, title: 'רונאלדו בריאל מדריד', body: 'שמונה עונות, ארבע אליפויות אירופה.', photo };
  assert.match(drawE('box', ranked), /<span class="ln"><span class="rk">4\.<\/span> /, "the place before the title, in the title's own box");
  assert.equal(slideModel(ranked).rank, '4');
  // The check measures the title with its place before it.
  const S = STYLES.E.text.title;
  const title = 'מקום ארבע ברשימה הארוכה של כל הזמנים';
  const draft = (rank) => ({ hook: 'x', slides: [{ kind: 'cover' }, { kind: 'item', role: 'rank', postKind: 'ranking', title, body: '' }], rank });
  const alone = fitText(title, S, { box: boxFor(S) });
  const withPlace = fitText(`4. ${title}`, S, { box: boxFor(S) });
  assert.ok(withPlace.lines >= alone.lines);
  assert.deepEqual(styleFitProblems(draft(), { style: 'E', places: [{}, { rank: 4 }], postKind: 'ranking' }).length, withPlace.ok ? 0 : 1);
});

test("E's two looks: white boxes behind each line (no shadow), or white text with a thin dark edge on E's own lines only", async () => {
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    await tab.setContent(drawE('box', { ...text, photo, sources: ['ויקיפדיה'] }));
    const box = await tab.evaluate(() => {
      const ln = getComputedStyle(document.querySelector('.hl .ln'));
      const lit = (el) => getComputedStyle(el).textShadow !== 'none' || parseFloat(getComputedStyle(el).webkitTextStrokeWidth) > 0;
      return { bg: ln.backgroundColor, color: ln.color, clone: ln.boxDecorationBreak || ln.webkitBoxDecorationBreak, radius: parseFloat(ln.borderTopLeftRadius), shadows: [...document.querySelectorAll('.blk, .blk *')].filter(lit).length };
    });
    assert.equal(box.bg, 'rgb(255, 255, 255)');
    assert.equal(box.color, 'rgb(17, 17, 17)');
    assert.equal(box.clone, 'clone', 'a box for each line');
    assert.ok(box.radius > 0, 'rounded');
    assert.equal(box.shadows, 0, 'the box look has no shadow');
    await tab.setContent(drawE('shadow', { ...number, sources: ['ויקיפדיה'] }));
    const sh = await tab.evaluate(() => {
      const ln = getComputedStyle(document.querySelector('.hl .ln'));
      const lit = (el) => getComputedStyle(el).textShadow !== 'none' || parseFloat(getComputedStyle(el).webkitTextStrokeWidth) > 0;
      const other = [...document.querySelectorAll('body *')].filter((el) => !el.closest('.ln,.nrow,.src,style,title') && lit(el));
      return { color: ln.color, shadow: ln.textShadow, stroke: parseFloat(ln.webkitTextStrokeWidth), size: parseFloat(ln.fontSize), bg: ln.backgroundColor, other: other.length };
    });
    assert.equal(sh.color, 'rgb(255, 255, 255)');
    assert.notEqual(sh.shadow, 'none');
    assert.ok(sh.stroke > 0 && sh.stroke < sh.size * 0.08, `a thin edge (${sh.stroke}px)`);
    assert.equal(sh.bg, 'rgba(0, 0, 0, 0)');
    assert.equal(sh.other, 0, "no letter outside E's own lines has a shadow");
    // The source: small, faint, under the text, never in the bottom band.
    await tab.setContent(drawE('box', { ...text, photo, sources: ['ויקיפדיה'] }));
    const src = await tab.evaluate(() => {
      const el = document.querySelector('.src');
      const cs = getComputedStyle(el);
      return { px: parseFloat(cs.fontSize), color: cs.color, bottom: el.getBoundingClientRect().bottom, text: document.querySelector('.bd').getBoundingClientRect().bottom };
    });
    assert.ok(src.px <= 24, `small (${src.px}px)`);
    assert.match(src.color, /rgba\(255, 255, 255, 0\.[0-7]\d*\)/, 'faint');
    assert.ok(src.bottom <= 1920 - SAFE_ZONES.tiktok.bottom && src.bottom > src.text, 'below the text, above the band');
  } finally {
    await tab.close();
  }
});

test("E: the cover's hook is set large and centred in the middle band, and the text moves off a face the screen found", async () => {
  // The viral countdowns' size: a line about a nineteenth of the screen tall, the text across four fifths of it.
  assert.ok(STYLES.E.text.hook.px >= 88 && STYLES.E.text.hook.px <= 108 && STYLES.E.text.hook.floor >= 72);
  assert.ok(STYLES.E.text.title.px >= 84 && STYLES.E.text.title.px <= 100);
  assert.equal(STYLES.E.sides.tiktok, 100);
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    await tab.setContent(drawE('box', cover));
    const mid = await tab.evaluate(() => {
      const r = document.querySelector('.hl').getBoundingClientRect();
      return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, align: getComputedStyle(document.querySelector('.hl')).textAlign };
    });
    assert.ok(Math.abs(mid.x - 540) < 2, 'centred across');
    assert.equal(mid.align, 'center');
    const band = (SAFE_ZONES.tiktok.top + 1920 - SAFE_ZONES.tiktok.bottom) / 2;
    assert.ok(Math.abs(mid.y - band) < 120, `in the middle band (${Math.round(mid.y)})`);
    // A face at 35% of the slide: the text goes below it.
    await tab.setContent(drawE('box', { ...cover, photoPos: '50% 35%' }));
    const top = await tab.evaluate(() => document.querySelector('.hl').getBoundingClientRect().top);
    assert.ok(top > 0.35 * 1920 + 150, `below the face (${Math.round(top)})`);
  } finally {
    await tab.close();
  }
  const r = await renderHtml(drawE('box', { ...cover, photoPos: '50% 35%' }), { size: 'tiktok', file: path.join(out, 'E-face.jpg') });
  assert.deepEqual(r.warnings, []);
});

test("E is chosen in pack.json and carries its look; the other styles' looks are hashed as before", () => {
  assert.ok(STYLE_NAMES.includes('E'));
  assert.equal(themedE().style.text, 'shadow', "the app's plain white text is the default, as on the viral countdowns");
  assert.equal(themedE('box').style.text, 'box');
  assert.equal(themedE('shadow').style.text, 'shadow');
  assert.equal('text' in themed('D').style, false, 'no new key on another style, so its saved look is unchanged');
  assert.equal('text' in themeOf({ ...pack, meta: { ...pack.meta, style: { name: 'B', text: 'shadow' } } }).style, false);
  const a = { ...pack, dirName: 'demo', meta: { ...pack.meta, style: { name: 'E', text: 'shadow' } } };
  assert.deepEqual(validatePack(a).filter((p) => /style/.test(p)), []);
  // The writer is told E's room, from E's own faces' widths (metrics.json has them).
  assert.ok(fitText('ה', STYLES.E.text.hook, { box: boxFor(STYLES.E.text.hook) }).chars > 10);
  assert.match(styleFitProblems({ hook: 'מי שווה הכי הרבה בעולם ה-AI? חמש חברות, מדד אחד ושווי אחד שמשנה את כל התמונה של השוק והכל', sub: '', slides: [{ kind: 'cover' }] }, { style: 'E' })[0]?.msg || '', /Shorten it/);
});

test('E fills the slide with every photograph sharp enough to fill it; a small one is shown whole on a blurred copy of itself, its text clear of the face', async () => {
  const g = geo('tiktok');
  assert.equal(fitE({ photo, photoSize: { w: 1080, h: 1920 } }, g).mode, 'cover', 'a 9:16 photograph fills the slide');
  assert.equal(fitE({ photo, photoSize: { w: 1200, h: 1800 } }, g).mode, 'cover', 'a 2:3 one is cut a little and fills it');
  assert.equal(fitE({ photo, photoSize: { w: 1080, h: 1350 } }, g).mode, 'cover', 'a 4:5 one fills the slide, cut around its face');
  assert.equal(fitE({ photo, photoSize: { w: 2560, h: 1440 } }, g).mode, 'cover', 'so does a sharp landscape one: a slide is the whole screen of picture');
  const wide = fitE({ photo, photoSize: { w: 1600, h: 900 } }, g);
  assert.deepEqual(wide, { mode: 'contain', top: 656, ph: 608 }, 'a 16:9 one too small to fill is shown whole, in the middle');
  assert.equal(fitE({ photo, photoSize: { w: 450, h: 600 } }, g).mode, 'contain', 'a small one is not blown up past twice its size');
  assert.equal(fitE({ photo }, g).mode, 'cover', 'no size known: as before');
  const browser = await getBrowser();
  const tab = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  try {
    // A face in the middle of a landscape photograph: the text goes on the black above it, with no shade there.
    await tab.setContent(drawE(null, { ...text, photo, photoSize: { w: 1600, h: 900 }, photoPos: '50% 40%' }));
    const r = await tab.evaluate(() => {
      const img = document.querySelector('img.ph').getBoundingClientRect();
      const blk = [...document.querySelectorAll('.blk .sf')].map((e) => e.getBoundingClientRect());
      return { img: [img.top, img.height], bottom: Math.max(...blk.map((b) => b.bottom)), max: Number(document.querySelector('.ov').dataset.max) };
    });
    assert.deepEqual(r.img, [656, 608]);
    assert.ok(r.bottom <= 656, `the text ends above the photograph (${r.bottom})`);
    assert.equal(r.max, 0, 'no shade of its own: the blurred copy under it has its veil');
    assert.equal(await tab.evaluate(() => document.querySelectorAll('img.bf').length), 1, 'never a black band: a blurred copy of the photograph fills the slide');
  } finally {
    await tab.close();
  }
  const file = path.join(out, 'E-landscape.jpg');
  const done = await renderHtml(drawE(null, { ...text, photo, photoSize: { w: 1600, h: 900 }, photoPos: '50% 40%' }), { size: 'tiktok', file });
  assert.deepEqual(done.warnings, []);
});

test("E's native look marks nothing and draws no source line; a facts post counts down to its best fact as 1.", () => {
  const html = drawE(null, { ...text, highlight: text.title.split(' ')[0], photo, sources: ['ויקיפדיה'] });
  assert.doesNotMatch(html, /<mark class="hi">/, 'no highlighter in the native look');
  assert.doesNotMatch(html, /class="src"/, 'no source line on the slide');
  assert.match(drawE('box', { ...text, photo, sources: ['ויקיפדיה'] }), /class="src"/, 'the box look keeps its source line');
  const fact = (n) => ({ kind: 'item', role: 'fact', postKind: 'facts', n, of: 5, title: 'האחים דיאז טבעונים', body: '', photo });
  assert.equal(slideModel(fact(1)).rank, '5');
  assert.equal(slideModel(fact(5)).rank, '1');
  assert.match(drawE(null, fact(5)), /<span class="rk">1\.<\/span> /);
  assert.equal(slideModel({ kind: 'item', role: 'tip', postKind: 'tips', n: 2, of: 5, title: 'פרומפט שמסכם פגישה', body: 'תכתבו: סכם את הפגישה ב-5 שורות.' }).rank, '2', 'tips count up from one');
  assert.equal(slideModel({ kind: 'item', role: 'fact', postKind: 'myth-fact', n: 1, of: 2, title: 'x', body: '' }).rank, '', "a myth-fact's fact is not counted");
});

test('every slide of a styled post on a photograph, none on more than two while another is free, never the wrong face', async () => {
  const { planPhotos } = await import('../src/render/render.js');
  const ph = (query) => ({ file: 'x.jpg', query });
  const items = (n, q = () => '') => [{ kind: 'cover' }, ...Array.from({ length: n }, (_, k) => ({ kind: 'item', imageQuery: q(k) }))];
  // A story with two photographs of its own and one scene: six slides, each on one, none on more than two.
  const story = planPhotos({ slides: items(5), byIdx: new Map([[0, ph('a')], [2, ph('b')], ['bg', ph('football stadium night')]]), postKind: 'story' });
  assert.equal(story.plan.size, 6, 'every slide has a photograph');
  assert.ok(Math.max(...story.uses.values()) <= 2, 'no photograph on more than two slides');
  // A facts slide never stands on another person's face: a scene, the place's name last.
  const facts = planPhotos({ slides: items(4, (k) => ['Messi', 'Mbappé', 'Kane', 'Yamal'][k]), byIdx: new Map([[0, ph('Messi')], [1, ph('Messi')], ['bg', ph('Anfield')], ['bg2', ph('football stadium night')]]), postKind: 'facts' });
  assert.deepEqual([2, 3, 4].map((i) => facts.plan.get(i)), ['bg2', 'bg2', 'bg'], 'the scene with no name first, twice at most, then the next');
  // A guess-who's clue never shows its answer, and its cover is a scene.
  const gw = planPhotos({ slides: items(3), byIdx: new Map([[3, ph('Zlatan')], ['bg', ph('football pitch grass')]]), postKind: 'guess-who' });
  assert.equal(gw.plan.get(3), 3);
  for (const i of [0, 1, 2]) assert.notEqual(gw.plan.get(i), 3, `slide ${i} does not give the answer away`);
  // A slide the same person's search already found shows that photograph.
  const same = planPhotos({ slides: items(2, (k) => (k === 1 ? 'Messi' : '')), byIdx: new Map([[1, ph('Messi')], ['bg', ph('octagon cage')]]), postKind: 'facts' });
  assert.equal(same.plan.get(2), 1);
});

test('A to D stand a slide on a blurred copy of its own photograph behind the design; a full-bleed cover has none', () => {
  for (const name of ['A', 'B', 'C', 'D']) {
    const html = draw(name, { ...text, photo });
    assert.match(html, /<img class="bf" src="data:image\/svg\+xml/, `style ${name}: the photograph behind the design, blurred`);
    assert.match(html, /class="bfv" style="background:rgba\(var\(--bg-rgb\),\.66\)"/, `style ${name}: under the style's own ground`);
    assert.doesNotMatch(draw(name, text), /class="bf"/, `style ${name}: no photograph, no backdrop`);
  }
  assert.doesNotMatch(draw('B', { ...cover, photo }), /class="bf"/, 'a cover whose photograph fills it needs none');
  assert.doesNotMatch(drawE(null, { ...text, photo }), /class="bf"/, "E's photograph fills its slide");
});
