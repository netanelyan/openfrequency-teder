import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, loadPack } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost, postDraft } from '../src/pipeline/build.js';
import { SLIDES_SCHEMA, slidesPrompt, slidesUser } from '../src/pipeline/prompts.js';
import { recheck } from '../src/publish/index.js';
import { closeBrowser, renderPost } from '../src/render/render.js';
import { themeOf } from '../src/render/styles/index.js';
import { renderStylePreview } from '../src/render/styles/preview.js';
import { STYLE_NAMES } from '../src/render/styles/tokens.js';
import { tokenOf } from '../src/verify/claims.js';
import { copyPack, opened, tempHome } from './helpers.js';

// Item 2 of the closing slide (the owner, 2026-11-02): "every slideshow ends with a closing slide that sends people to
// the customer's site or product", and "the last slide is always the hook to the product. It ties to the slideshow's
// topic (a slideshow about plants that survive in the dark ends with the store's plant that fits), and it's never a
// generic 'visit our site'. One short line plus the action." The writer writes the line; the code writes the action,
// per platform, and refuses a line that breaks the hebrew-voice rules, putting a line made of the promo's own words in
// its place. The model is stubbed: the recorded writer of the demo pack, with its answer's closing line set here.

after(() => closeBrowser());

// The module is loaded in each test, so that before it existed every test here failed on its own.
const closing = () => import('../src/pipeline/closing.js');

const STORE = { name: 'עציץ ושמש', promise: 'צמחי בית ועציצים עם משלוח עד הבית' };
const SITE = { ...STORE, target: { kind: 'site', url: 'https://www.atzitz.example/' } };
const PRODUCT = { ...STORE, target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://atzitz.example/zz-plant' } };
const BIO = { ...STORE, target: { kind: 'bio' } };

const HANDLE = 'demo.atzitz';
const packWith = (promo) => ({ meta: { handle: HANDLE, topics: ['צמחי בית', 'השקיה ואור'], ...(promo ? { promo } : {}) }, rules: {} });

// Lines a writer could return, each tied to a post about plants that survive in the dark.
const GOOD = {
  product: 'לחדר בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה',
  site: 'צמחים לחדר בלי חלון, עם משלוח עד הבית, יש בעציץ ושמש',
  bio: 'צמחים לחדר בלי חלון, עם משלוח עד הבית, יש בעציץ ושמש',
  follow: 'עוד צמחים שמחזיקים מעמד בדירה קטנה, בפוסטים הבאים',
};

test('the action is built in code, per platform and per kind of promo: TikTok says the link is in the bio, Instagram and Facebook carry the address', async () => {
  const { closingActions, closingBase, displayUrl } = await closing();
  const actions = (promo) => closingActions(closingBase(packWith(promo)));
  const bio = { where: 'bio', lead: 'הלינק בביו', chip: '', text: 'הלינק בביו' };

  const site = actions(SITE);
  assert.deepEqual(site.tiktok, bio, 'TikTok: the link is in the bio');
  assert.deepEqual(site.instagram, { where: 'url', lead: 'באתר', chip: 'atzitz.example', text: 'באתר atzitz.example', url: 'https://www.atzitz.example/', display: 'atzitz.example' });
  assert.deepEqual(site.facebook, site.instagram, "Facebook is sent Instagram's slides");

  const product = actions(PRODUCT);
  assert.deepEqual(product.tiktok, bio);
  assert.equal(product.instagram.url, 'https://atzitz.example/zz-plant');
  assert.equal(product.instagram.text, 'באתר atzitz.example/zz-plant');
  for (const a of [site.tiktok, product.tiktok]) assert.doesNotMatch(JSON.stringify(a), /atzitz|https?:/, 'no address on TikTok, ever');

  const inBio = actions(BIO);
  for (const p of ['tiktok', 'instagram', 'facebook']) assert.deepEqual(inBio[p], bio, `link in bio on ${p}`);

  const follow = actions(null);
  for (const p of ['tiktok', 'instagram', 'facebook']) assert.deepEqual(follow[p], { where: 'handle', lead: 'תעקבו אחרי', chip: '@demo.atzitz', text: 'תעקבו אחרי @demo.atzitz', handle: HANDLE });

  // The address as a slide shows it: no scheme, no "www.", no query; a long or encoded path is the site alone.
  assert.equal(displayUrl('https://www.shop.example/a/b?utm=1#top'), 'shop.example/a/b');
  assert.equal(displayUrl('https://shop.example/products/a-very-long-product-name-here'), 'shop.example');
  assert.equal(displayUrl('https://shop.example/products/%D7%96%D7%9E%D7%99%D7%94'), 'shop.example');
  assert.equal(displayUrl('not an address'), '');
});

test('banned phrasings are caught: the best, number one, urgency, scarcity, "don\'t miss", "visit our site", the action, a long dash, the singular', async () => {
  const { closingBase, closingLineProblems, CLOSING_LINE } = await closing();
  const check = (line, promo = PRODUCT) => {
    const pack = packWith(promo);
    return closingLineProblems(line, { base: closingBase(pack), pack });
  };
  const BAD = [
    ['הזמיוקולקס בעציץ קרמיקה הכי טוב לחדר בלי חלון', /claim/],
    ['זמיוקולקס בעציץ קרמיקה, הצמח הטוב ביותר לחושך', /claim/],
    ['עציץ ושמש, החנות מספר 1 לזמיוקולקס בעציץ קרמיקה', /claim/],
    ['זמיוקולקס בעציץ קרמיקה, הבחירה המובילה לחדר חשוך', /claim/],
    ['זמיוקולקס בעציץ קרמיקה לחדר בלי חלון, רק היום', /urgency/],
    ['זמיוקולקס בעציץ קרמיקה לזמן מוגבל אצל עציץ ושמש', /urgency/],
    ['נשארו רק כמה זמיוקולקס בעציץ קרמיקה במלאי', /urgency/],
    ['אל תפספסו את הזמיוקולקס בעציץ קרמיקה שלנו', /urgency|ad copy/],
    ['זמיוקולקס בעציץ קרמיקה לחדר חשוך, תזמינו עכשיו', /urgency/],
    ['בקרו באתר שלנו וגלו את הזמיוקולקס בעציץ קרמיקה', /action/],
    ['הזמיוקולקס בעציץ קרמיקה מחכה לכם בלינק בביו', /action/],
    ['זמיוקולקס בעציץ קרמיקה ב-atzitz.example', /address|action/],
    ['זמיוקולקס בעציץ קרמיקה לחדר בלי חלון — אצלנו', /dash/],
    ['זמיוקולקס בעציץ קרמיקה לחדר בלי חלון אצלנו!', /exclamation/],
    ['זמיוקולקס בעציץ קרמיקה בשבילך, לחדר בלי חלון', /singular/],
    ['זמיוקולקס בעציץ קרמיקה בהנחה של 30 אחוז', /offer|number/],
    ['זמיוקולקס בעציץ קרמיקה שורד 3 חודשים בלי מים', /number/],
    ['ניסינו את הזמיוקולקס בעציץ קרמיקה בחדר בלי חלון', /experience/],
    ['לחדר בלי חלון יש לנו בדיוק את הצמח שמתאים', /names/],
    ['זמיוקולקס', /length/],
    [`${'זמיוקולקס בעציץ קרמיקה לחדר בלי חלון '.repeat(2)}ועוד`, /length/],
  ];
  for (const [line, why] of BAD) {
    const problems = check(line);
    assert.ok(problems.length, `refused: ${line}`);
    assert.match(problems.map((p) => `${p.code} ${p.msg}`).join(' | '), why, line);
  }
  // A site's line names the store; a follow line never asks to follow, the action does.
  assert.match(check('צמחים לחדר בלי חלון, עם משלוח עד הבית', SITE).map((p) => p.msg).join(' '), /names/);
  assert.match(check('תעקבו אחרינו לעוד צמחים כאלה', null).map((p) => p.code).join(' '), /action/);
  // A sale is the store's own word only when its promise says it, and so is a number.
  const sale = { ...SITE, promise: 'מבצע על עציצים, 2 ב-50 שקל' };
  assert.deepEqual(check('עציצים לחדר בלי חלון במבצע של 2 ב-50 שקל, בעציץ ושמש', sale), []);
  assert.ok(check('עציצים לחדר בלי חלון במבצע של 2 ב-50 שקל, בעציץ ושמש', SITE).length);
  // The good lines pass, and so does the store's name with a prefix ("בעציץ ושמש") or a product by its first word.
  for (const [kind, promo] of [['product', PRODUCT], ['site', SITE], ['bio', BIO], ['follow', null]]) assert.deepEqual(check(GOOD[kind], promo), [], `${kind}: ${GOOD[kind]}`);
  assert.deepEqual(check('לחדר בלי חלון יש אצלנו זמיוקולקס'), [], 'a product named by its first word');
  assert.equal(CLOSING_LINE.maxChars, 60);
});

test("the writer's line when it passes, a line of the promo's own words when it does not, and never a line that breaks the rules", async () => {
  const { closingBase, closingLineProblems, closingSlide, safeLines } = await closing();
  const BAD_LINE = 'הזמיוקולקס הכי טוב, רק היום באתר שלנו';
  const cases = [
    [PRODUCT, 'product', 'זמיוקולקס בעציץ קרמיקה אצל עציץ ושמש'],
    [SITE, 'site', 'עציץ ושמש. צמחי בית ועציצים עם משלוח עד הבית'],
    [BIO, 'bio', 'עציץ ושמש. צמחי בית ועציצים עם משלוח עד הבית'],
    [null, 'follow', 'עוד על צמחי בית בפוסטים הבאים'],
  ];
  for (const [promo, kind, safe] of cases) {
    const pack = packWith(promo);
    const good = closingSlide(pack, { line: GOOD[kind] });
    assert.equal(good.closing.kind, kind);
    assert.equal(good.closing.line, GOOD[kind], `${kind}: the writer's line`);
    assert.equal(good.closing.by, 'writer');
    assert.deepEqual(good.refused, []);
    for (const line of [BAD_LINE, '', undefined]) {
      const bad = closingSlide(pack, { line });
      assert.equal(bad.closing.line, safe, `${kind}: the safe line in place of ${JSON.stringify(line)}`);
      assert.equal(bad.closing.by, 'safe');
      assert.ok(bad.refused.length, 'what was refused is kept, for the trace');
      assert.deepEqual(closingLineProblems(bad.closing.line, { base: closingBase(pack), pack, writer: false }), [], 'the safe line passes the same rules');
    }
    assert.deepEqual(good.closing.actions, closingSlide(pack, { line: BAD_LINE }).closing.actions, 'the action does not depend on the line');
  }
  // A promise that breaks the rules itself is passed over for the next line of the promo's own words.
  const loud = packWith({ ...SITE, promise: 'הצמחים הכי טובים בארץ, רק היום' });
  assert.equal(safeLines(closingBase(loud), loud)[0], 'עציץ ושמש. הצמחים הכי טובים בארץ, רק היום');
  assert.equal(closingSlide(loud, { line: BAD_LINE }).closing.line, 'עציץ ושמש');
  // What code can fix, code fixes: a long dash or an exclamation mark is not a reason to lose the writer's line.
  const fixed = closingSlide(packWith(PRODUCT), { line: 'לחדר בלי חלון — יש אצלנו זמיוקולקס בעציץ קרמיקה!' });
  assert.equal(fixed.closing.by, 'writer');
  assert.equal(fixed.closing.line, 'לחדר בלי חלון, יש אצלנו זמיוקולקס בעציץ קרמיקה.');
  // A line broken over two lines is one line on the slide.
  assert.equal(closingSlide(packWith(PRODUCT), { line: 'לחדר בלי חלון\nיש אצלנו זמיוקולקס' }).closing.line, 'לחדר בלי חלון יש אצלנו זמיוקולקס');
});

test("the writer's prompt carries the slideshow's topic, the promo, the action as the code writes it, and the rules", async () => {
  const { home, cleanup } = tempHome();
  try {
    const demo = loadPack(copyPack(home, 'demo'));
    const format = demo.formats.formats.find((f) => f.kind === 'story');
    const topic = 'צמחים ששורדים בחושך';
    const ask = (promo) => slidesUser({ format, n: 4, outline: { topic, items: [] }, facts: [], pack: { ...demo, meta: { ...demo.meta, ...(promo ? { promo } : {}) } } });
    for (const [promo, must] of [
      [PRODUCT, ['זמיוקולקס בעציץ קרמיקה', 'עציץ ושמש', STORE.promise, '"הלינק בביו"', '"באתר atzitz.example/zz-plant"']],
      [SITE, ['עציץ ושמש', STORE.promise, '"הלינק בביו"', '"באתר atzitz.example"']],
      [BIO, ['עציץ ושמש', STORE.promise, '"הלינק בביו"']],
      [null, ['@demo.atzitz', 'צמחי בית', '"תעקבו אחרי @demo.atzitz"']],
    ]) {
      const user = ask(promo);
      assert.match(user, /CLOSING SLIDE/);
      assert.ok(user.includes(`(${topic})`), 'the closing line is tied to this post\'s topic');
      for (const m of must) assert.ok(user.includes(m), `${promo?.target.kind || 'follow'}: ${m}`);
      for (const rule of ['"הכי"', '"מספר 1"', '"רק היום"', '"אל תפספסו"', '"בקרו באתר"', 'long dash', '60 characters']) assert.ok(user.includes(rule), `the rule ${rule}`);
      assert.doesNotMatch(user, /The design adds a closing slide that asks them to follow/);
    }
    // The line is its own field of the answer, and the task says what it is.
    assert.ok(SLIDES_SCHEMA.required.includes('closing'));
    assert.deepEqual(SLIDES_SCHEMA.properties.closing.required, ['line']);
    assert.match(slidesPrompt(demo).system[1].text, /closing\.line/);
    // The examples the prompt gives pass the check they are given for.
    const { closingBase, closingLineProblems, EXAMPLES } = await closing();
    for (const [kind, ex] of Object.entries(EXAMPLES)) {
      const pack = packWith(ex.promo);
      assert.deepEqual(closingLineProblems(ex.line, { base: closingBase(pack), pack }), [], `${kind}: ${ex.line}`);
    }
  } finally {
    cleanup();
  }
});

/** The demo's recorded writer, with the closing line of each slides answer given by `line(n)` (the n-th answer). */
const writerWith = (ctx, line) => {
  let n = 0;
  return {
    ...ctx.llm,
    async json(req) {
      const r = await ctx.llm.json(req);
      if (req.task !== 'slides') return r;
      return { ...r, data: { ...structuredClone(r.data), closing: { line: line(n++) } } };
    },
  };
};

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

test('every format ends on its closing slide: the writer\'s line when it passes, the safe line when it does not, the action per platform', { timeout: 600_000 }, async () => {
  const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = PRODUCT) } });
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    // One format of every kind, and one of the phase 1 lists.
    const formats = [];
    for (const f of pack.formats.formats) if (!formats.some((x) => (x.kind || 'list') === (f.kind || 'list'))) formats.push(f);
    assert.equal(formats.length, 12, 'eleven kinds and a list');
    const BAD_LINE = 'הזמיוקולקס הכי טוב, רק היום באתר שלנו';
    for (const [i, f] of formats.entries()) {
      const good = i % 2 === 0;
      const res = await buildPost({ ...ctx, llm: writerWith(ctx, () => (good ? GOOD.product : BAD_LINE)) }, { pack, formatKey: f.id, day: f.kind === 'on-this-day' ? '2026-10-14' : null });
      assert.equal(res.status, 'queued', `${f.id}: ${res.reason}`);
      const post = loadPost(ctx.db, res.postId);
      const c = post.data.closing;
      assert.equal(c.kind, 'product', f.id);
      assert.equal(c.line, good ? GOOD.product : 'זמיוקולקס בעציץ קרמיקה אצל עציץ ושמש', `${f.id}: ${good ? "the writer's line" : 'the safe line'}`);
      assert.equal(c.by, good ? 'writer' : 'safe');
      assert.equal(c.actions.tiktok.text, 'הלינק בביו');
      assert.equal(c.actions.instagram.text, 'באתר atzitz.example/zz-plant');
      // The closing slide is the post's last: drawn after every slide it stores, on every platform.
      assert.ok(!post.slides.some((s) => s.kind === 'closer'), `${f.id}: the closing slide replaces a list's closer`);
      for (const p of ['tiktok', 'instagram']) {
        assert.equal(post.media[p].length, post.slides.length + 1, `${f.id}: the closing slide last on ${p}`);
        assert.ok(existsSync(post.media[p].at(-1)));
      }
      const step = ctx.db.get("SELECT status, detail_json FROM steps WHERE post_id = ? AND step = 'closing'", res.postId);
      assert.ok(step, `${f.id}: the closing step is in the trace`);
      const detail = JSON.parse(step.detail_json);
      assert.equal(detail.by, c.by);
      if (!good) assert.match(detail.broke.join(' '), /claim|urgency|action/);
      // The closing slide is part of what the fact gate signed, and the gate before publishing still holds.
      assert.deepEqual(postDraft(post).closing, c);
      assert.deepEqual(recheck(ctx.db, post, pack), [], `${f.id}: the stored post passes the gate again`);
      if (i === 0) {
        const changed = { ...post, data: { ...post.data, closing: { ...c, line: 'שורה אחרת לגמרי' } } };
        assert.match(recheck(ctx.db, changed, pack).join(' '), /changed after it was checked/, 'a closing line changed after the gate is refused');
      }
    }
  } finally {
    cleanup();
  }
});

test('an account with no promo ends every slideshow by asking to follow it, its line about the post', { timeout: 120_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    for (const [formatKey, line, want, by] of [['plant-story', GOOD.follow, GOOD.follow, 'writer'], ['plant-iceberg', 'תעקבו אחרינו, רק היום', 'עוד על צמחי בית בפוסטים הבאים', 'safe']]) {
      const res = await buildPost({ ...ctx, llm: writerWith(ctx, () => line) }, { pack, formatKey, sample: true });
      assert.equal(res.status, 'sample', res.reason);
      const post = loadPost(ctx.db, res.postId);
      const c = post.data.closing;
      assert.deepEqual([c.kind, c.line, c.by, c.handle], ['follow', want, by, 'demo.atzitz']);
      for (const p of ['tiktok', 'instagram', 'facebook']) assert.equal(c.actions[p].text, 'תעקבו אחרי @demo.atzitz');
      // The style picker draws a stored post again from the text the gate signed, its closing slide included.
      const preview = await renderStylePreview(ctx.db, { pack, post, style: 'E', outDir: path.join(home, 'preview', res.postId) });
      assert.ok(preview.files.length);
    }
    // A recorded answer from before the line existed still closes, on the safe line.
    const old = await buildPost(ctx, { pack, formatKey: 'myth-fact', sample: true });
    assert.equal(old.status, 'sample', old.reason);
    assert.equal(loadPost(ctx.db, old.postId).data.closing.by, 'safe');
  } finally {
    cleanup();
  }
});

test('the closing slide is drawn in every style and in the older templates, on TikTok and on Instagram, with the longest line and action', { timeout: 300_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const { closingSlide } = await closing();
    const base = loadPack(copyPack(home, 'demo'));
    const pack0 = { ...base, meta: { ...base.meta, promo: { ...PRODUCT, target: { ...PRODUCT.target, url: 'https://atzitz.example/zamio-ceramic' } } } };
    // 60 characters: the most a line may have.
    const line = 'לחדר חשוך בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה לבן וגדול';
    assert.equal([...line].length, 60);
    const { closing: c } = closingSlide(pack0, { line });
    assert.equal(c.by, 'writer');
    assert.equal(c.actions.instagram.display.length, 28, 'the longest address a slide shows');
    const photo = path.resolve('docs/screenshots/today-phone.png');
    const beat = (title) => ({ kind: 'item', role: 'beat', title, body: 'שורה אחת על השקף.', factKeys: [], sources: ['מקור'] });
    const slides = [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }, beat('אחת'), beat('שתיים'), beat('שלוש'), { ...beat('סוף'), role: 'payoff' }];
    const format = { id: 't', kind: 'story', name: 'x', hooks: ['x'] };
    const looks = [...STYLE_NAMES.map((name) => [`style ${name}`, { ...pack0, meta: { ...pack0.meta, style: { name } } }]), ['editorial', pack0], ['photocard', { ...pack0, theme: { ...pack0.theme, template: 'photocard', variant: 'a', options: { ...pack0.theme.options, coverPhoto: true } } }]];
    for (const [name, p] of looks) {
      const pack = { ...p, theme: themeOf(p) };
      const extra = { captionIg: '', keywords: [], subject: {}, cta: '', closing: c };
      const post = { id: `closing-${name}`, hook: 'שער לבדיקה', sub: '', caption: 'c', extra };
      post.token = tokenOf({ slides, caption: post.caption, hook: post.hook, sub: post.sub, extra });
      const photos = existsSync(photo) ? new Map([[0, { id: 1, file: photo }], ['bg', { id: 2, file: photo, query: 'house plants' }]]) : null;
      const files = await renderPost({ pack, format, post, slides, photos, outDir: path.join(home, 'media', name.replace(/\s/g, '-')) });
      for (const size of ['tiktok', 'instagram']) {
        assert.equal(files[size].length, slides.length + 1, `${name} ${size}: the closing slide after the last`);
        assert.ok(existsSync(files[size].at(-1)));
        if (photos) assert.ok(files.grounds[size][slides.length].length, `${name} ${size}: the closing slide stands on a photograph`);
      }
    }
  } finally {
    cleanup();
  }
});
