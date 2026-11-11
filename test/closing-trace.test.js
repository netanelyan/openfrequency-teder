import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { CLOSING_HE } from '../src/publish/errors.js';
import { approve } from '../src/web/actions.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { postFull } from '../src/web/data.js';
import { postPage } from '../src/web/pages.js';
import { opened, tempHome } from './helpers.js';

// A post page never shows the closing slide's checks in the English they are written in for the writer and the operator
// ("closing: the closing slide has no line: write one short line that ..."), except to the operator on their own pages.
// Since the audit of 2026-11-12 the steps themselves are developer mode's (the superadmin on Teder's own name): there one
// plain Hebrew line says what happened. A customer reads no steps, only when the post was written and how its facts
// were checked. The writer is stubbed: the demo's recorded answers, with the closing line and the repairs set here.

after(() => closeBrowser());
afterEach(() => setNow(null));

const PRODUCT = { name: 'עציץ ושמש', promise: 'צמחי בית ועציצים עם משלוח עד הבית', target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://atzitz.example/zz-plant' } };
const GOOD = 'לחדר בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה';
const BANNED = 'הזמיוקולקס בעציץ קרמיקה הכי טוב, רק היום';
const customer = { csrf: 'x' };
const developer = { csrf: 'x', dev: true };
const operator = { csrf: 'x', operator: true };

/** A customer's page: no steps, one line on how the post was made, in Hebrew. */
function noSteps(page) {
  assert.equal(traceOf(page).steps.length, 0, 'a customer reads no steps');
  assert.match(page, /<h2>איך הפוסט נוצר<\/h2><\/header><p class="muted m0">נכתב ב-/);
}

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

const writer = (ctx, { line, repairs = [] }) => {
  let k = 0;
  return {
    ...ctx.llm,
    async json(req) {
      if (req.task === 'repair') {
        const text = repairs[k++];
        return { data: { repairs: text ? [{ target: 'closing', text, title: '', body: '', a: '', b: '', facts: [] }] : [] }, usage: null, model: req.model, estimated: true };
      }
      const r = await ctx.llm.json(req);
      if (req.task !== 'slides') return r;
      const data = structuredClone(r.data);
      if (line === undefined) delete data.closing;
      else data.closing = { line };
      return { ...r, data };
    },
  };
};

/** A detail line as it reads: its tags out, its entities back. */
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The page's trace, "איך הפוסט נוצר", and each step's detail line. */
const traceOf = (page) => {
  const ol = /<section class="panel"><header><h2>איך הפוסט נוצר<\/h2><\/header><ol class="trace">([\s\S]*?)<\/ol>/.exec(page)?.[1] || '';
  return { html: ol, steps: [...ol.matchAll(/<li class="([^"]+)"><b>([^<]+)<\/b>((?:(?!<\/li>)[\s\S])*)<\/li>/g)].map((m) => ({ status: m[1], name: m[2], d: text(/<div class="d">([\s\S]*?)<\/div>/.exec(m[3])?.[1] || '') })) };
};
const ENGLISH = /[A-Za-z]{4,}/;
const CLOSING_EN = /closing: |the closing (?:slide|line)|write one short line|names the product|claim the store did not make/;

test('a draft whose closing line the check stopped: the customer reads it in Hebrew, the operator in the checks\' own words', { timeout: 300_000 }, async () => {
  for (const [what, line, he] of [
    ['no line at all', undefined, 'הבדיקה עצרה את השורה שנכתבה לשקף האחרון.'],
    ['a banned line', BANNED, 'הבדיקה עצרה את השורה שנכתבה לשקף האחרון.'],
  ]) {
    const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = PRODUCT) } });
    try {
      const ctx = contextFor(home);
      const res = await buildPost({ ...ctx, llm: writer(ctx, { line, repairs: [GOOD] }) }, { pack: ctx.pack('demo'), formatKey: 'plant-story', docKey: 'pothos-story', sample: true });
      assert.equal(res.status, 'sample', `${what}: ${res.reason}`);
      const d = postFull(ctx, res.postId);
      noSteps(postPage(customer, d));
      const mine = traceOf(postPage(developer, d));
      const slides = mine.steps.find((s) => s.name === 'כתיבת שקפים');
      assert.equal(slides.status, 'failed', what);
      assert.doesNotMatch(mine.html, CLOSING_EN, `${what}: no English of the closing check on the customer's page`);
      for (const s of mine.steps) assert.doesNotMatch(s.d, ENGLISH, `${what}: the step "${s.name}" says it in Hebrew: ${s.d}`);
      assert.equal(slides.d, he, `${what}: one plain line`);
      assert.match(mine.html, /הבדיקה עצרה את השורה הראשונה, וזו נכתבה בתיקון/);
      // The operator keeps the detail, as it was stored.
      const ops = traceOf(postPage(operator, d));
      assert.match(ops.steps.find((s) => s.name === 'כתיבת שקפים').d, CLOSING_EN, `${what}: the operator reads the check`);
    } finally {
      cleanup();
    }
  }
});

test('a post the closing check blocked, while written or before a send: Hebrew for the customer on every step, the reason and the answer', { timeout: 300_000 }, async () => {
  // A promo whose own words break honesty: no line can pass, and the post is blocked while it is written.
  const loud = { name: 'מספר 1 בישראל', promise: 'הצמחים הכי טובים בארץ, רק היום', target: { kind: 'product', name: 'צמח מספר 1 בישראל', url: 'https://atzitz.example/sale' } };
  let s = tempHome({ packs: { demo: (f) => (f.pack.promo = loud) } });
  try {
    const ctx = contextFor(s.home);
    const res = await buildPost({ ...ctx, llm: writer(ctx, { line: BANNED, repairs: [BANNED, BANNED] }) }, { pack: ctx.pack('demo'), formatKey: 'plant-story', docKey: 'pothos-story', sample: true });
    assert.equal(res.status, 'blocked');
    const d = postFull(ctx, res.postId);
    const page = postPage(customer, d);
    noSteps(page);
    const mine = traceOf(postPage(developer, d));
    assert.doesNotMatch(mine.html, CLOSING_EN);
    // No count without its noun, and no row for the format's call to action, which a post with a closing slide never shows.
    assert.doesNotMatch(page, /נפסלו/);
    assert.doesNotMatch(page, /<dt>קריאה לפעולה<\/dt>/);
    assert.match(mine.steps.find((x) => x.name === 'תיקון אחרי הבדיקות').d, /^תיקון אחד לא נשמר · /, 'a repair not kept, said in words');
    for (const st of mine.steps) assert.doesNotMatch(st.d, ENGLISH, `the step "${st.name}": ${st.d}`);
    assert.equal(mine.steps.find((x) => x.name === 'נחסם').d, 'השקף האחרון לא עבר את הבדיקה, ולכן המצגת לא תעלה', 'the block, in the closing slide\'s words');
    assert.match(mine.steps.find((x) => x.name === 'תיקון אחרי הבדיקות').d, /(?:^|· )השורה בשקף האחרון עוד לא עברה את הבדיקה\.$/, 'the repair that could not mend it');
    assert.match(page, /<div class="banner bad">[\s\S]*?הבדיקות שלנו עצרו את המצגת הזו בזמן הכתיבה, ולכן היא לא תעלה\./, 'the reason in Hebrew');
    assert.match(traceOf(postPage(operator, d)).html, CLOSING_EN, 'the operator reads the checks');
  } finally {
    s.cleanup();
  }
  // A queued post whose closing slide no longer sends people where Settings does, stopped at its approval.
  s = tempHome({ packs: { demo: (f) => (f.pack.promo = PRODUCT) } });
  try {
    const ctx = contextFor(s.home);
    const pack = ctx.pack('demo');
    delete pack.meta.zernio.tiktokMode;
    const res = await buildPost({ ...ctx, llm: writer(ctx, { line: GOOD }) }, { pack, formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    ctx.db.update('posts', res.postId, { slot_at: new Date(israelInstant('2026-10-13', '12:45')).toISOString() });
    pack.meta.promo = { ...PRODUCT, target: { kind: 'product', name: 'סנסיווריה גבוהה', url: 'https://atzitz.example/snake' } };
    setNow(israelInstant('2026-10-13', '09:00').getTime());
    assert.throws(() => approve(ctx, { id: 1, name: 'owner' }, { id: res.postId }), (e) => e.message === CLOSING_HE, 'the answer, in Hebrew');
    assert.equal(loadPost(ctx.db, res.postId).status, 'blocked');
    const d = postFull(ctx, res.postId);
    const page = postPage(customer, d);
    noSteps(page);
    const mine = traceOf(postPage(developer, d));
    assert.doesNotMatch(mine.html, CLOSING_EN);
    const stopped = mine.steps.filter((x) => x.name === 'השקף האחרון').at(-1);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.d, 'השקף האחרון לא עבר את הבדיקה, ולכן המצגת לא תעלה');
    assert.ok(page.includes(CLOSING_HE), 'the reason on the page');
    assert.match(traceOf(postPage(operator, d)).steps.filter((x) => x.name === 'השקף האחרון').at(-1).d, /the closing slide sends people to/, 'the operator reads what failed');
  } finally {
    s.cleanup();
  }
});
