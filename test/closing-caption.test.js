import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { exportPost } from '../src/pipeline/export.js';
import { closeBrowser } from '../src/render/render.js';
import { postFull } from '../src/web/data.js';
import { postPage } from '../src/web/pages.js';
import { opened, tempHome } from './helpers.js';

// Item 5 of the closing slide (the owner, 2026-11-04): "The caption: it repeats the same action, with the link on
// Instagram and Facebook." The writer is stubbed: the demo's recorded answers, with the closing line set here. New code
// is loaded inside the tests, so that before it existed each test failed on its own.

after(() => closeBrowser());

const STORE = { name: 'עציץ ושמש', promise: 'צמחי בית ועציצים עם משלוח עד הבית' };
const PROMOS = {
  product: { ...STORE, target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה', url: 'https://atzitz.example/zz-plant' } },
  site: { ...STORE, target: { kind: 'site', url: 'https://atzitz.example/' } },
  bio: { ...STORE, target: { kind: 'bio' } },
  none: null,
};
const LINES = {
  product: 'לחדר בלי חלון יש אצלנו זמיוקולקס בעציץ קרמיקה',
  site: 'לחדר בלי חלון יש בעציץ ושמש צמחים שמחזיקים מעמד',
  bio: 'לחדר בלי חלון יש בעציץ ושמש צמחים שמחזיקים מעמד',
  none: 'עוד צמחים שמחזיקים מעמד בדירה קטנה, בפוסטים הבאים',
};
const PLATFORMS = ['tiktok', 'instagram', 'facebook'];
const ADDRESS = /https?:\/\/|www\.|atzitz\.example/i;

const contextFor = (home) => {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
};

/** The demo's recorded writer, its slides answer given this closing line, and every repair answered with it too. */
const writer = (ctx, line) => ({
  ...ctx.llm,
  async json(req) {
    if (req.task === 'repair') return { data: { repairs: [{ target: 'closing', text: line, title: '', body: '', a: '', b: '', facts: [] }] }, usage: null, model: req.model, estimated: true };
    const r = await ctx.llm.json(req);
    if (req.task !== 'slides') return r;
    return { ...r, data: { ...structuredClone(r.data), closing: { line } } };
  },
});

/** The caption without its hashtags (the last paragraph, the post's own tags), and the tags. */
const split = (caption, tags) => {
  const t = tags.join(' ');
  if (!t) return { body: caption, tags: '' };
  assert.ok(caption.endsWith(`\n\n${t}`), 'the hashtags come last');
  return { body: caption.slice(0, -(t.length + 2)), tags: t };
};

const count = (text, part) => text.split(part).length - 1;

test('every format, on every platform, ends its caption on the closing slide\'s action: the same words, the link on Instagram and Facebook, none on TikTok', { timeout: 900_000 }, async () => {
  const { captionAction } = await import('../src/pipeline/closing.js');
  const { captionOf } = await import('../src/publish/index.js');
  assert.equal(typeof captionAction, 'function', 'the caption knows the closing slide\'s action');
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const ids = pack.formats.formats.map((f) => f.id);
    assert.ok(ids.length >= 14, 'every format id the pack has, so a format added later is checked here too');
    const kinds = Object.keys(PROMOS);
    for (const [i, formatKey] of ids.entries()) {
      // Each kind of promo in turn: a product, the store's site, "link in bio", and an account with none.
      const kind = kinds[i % kinds.length];
      pack.meta.promo = PROMOS[kind];
      const fkind = pack.formats.formats[i].kind;
      const res = await buildPost({ ...ctx, llm: writer(ctx, LINES[kind]) }, { pack, formatKey, day: fkind === 'on-this-day' ? '2026-10-14' : null });
      assert.equal(res.status, 'queued', `${formatKey}: ${res.reason}`);
      const post = loadPost(ctx.db, res.postId);
      const c = post.data.closing;
      assert.equal(c.line, LINES[kind], `${formatKey}: the writer's line`);
      for (const p of PLATFORMS) {
        const at = `${formatKey} (${kind}) on ${p}`;
        const caption = captionOf(ctx.db, post, p);
        const { body } = split(caption, post.hashtags || []);
        const action = captionAction(c, p);
        assert.ok(action, `${at}: an action`);
        assert.ok(body.endsWith(`\n\n${action}`), `${at}: the action is the caption's last line before the hashtags:\n${caption}`);
        assert.equal(count(caption, action), 1, `${at}: said once`);
        // The writer's words come first, as before: TikTok's long caption, Instagram's (and a Page's) short one, or a
        // list's one caption everywhere.
        const words = (p !== 'tiktok' && post.caption_ig) || post.caption;
        assert.ok(body.startsWith(words.trim()), `${at}: the words first`);
        if (p === 'tiktok' || kind === 'bio' || kind === 'none') {
          // The slide's own words: "הלינק בביו", or the follow line.
          assert.equal(action, c.actions[p].text, `${at}: the slide's words`);
          assert.doesNotMatch(caption, ADDRESS, `${at}: no address`);
          if (kind === 'none') assert.equal(action, 'תעקבו אחרי @demo.atzitz');
          else assert.equal(action, 'הלינק בביו');
        } else {
          // The slide says "באתר atzitz.example/zz-plant"; the caption says the same with the full link.
          const link = action.split(' ').at(-1);
          assert.equal(action, `${c.actions[p].lead} ${link}`, `${at}: the slide's words with the link`);
          assert.equal(c.actions[p].lead, 'באתר');
          assert.equal(new URL(link).href, PROMOS[kind].target.url, `${at}: the promo's own address, whole`);
          assert.match(link, /^https:\/\//);
          assert.equal(count(caption, 'https://'), 1, `${at}: one link`);
        }
      }
      // TikTok and Instagram say the same action on the slide and in the caption, Facebook Instagram's.
      assert.equal(captionAction(c, 'facebook'), captionAction(c, 'instagram'));
    }
  } finally {
    cleanup();
  }
});

test('the longest address fits every platform\'s caption whole; a caption past its limit sheds hashtags, never the action', { timeout: 300_000 }, async () => {
  const { captionAction } = await import('../src/pipeline/closing.js');
  const { captionOf, captionRoom } = await import('../src/publish/caption.js');
  const { CAPTION_MAX, postBody } = await import('../src/publish/zernio.js');
  const { PROMO_MAX } = await import('../src/packs/promo.js');
  const { hashtagsIn } = await import('../src/rules/caption.js');
  // The longest address a promo may have (PROMO_MAX.url), with a #fragment that is no hashtag.
  const base = 'https://atzitz.example/collections/zz-plant/';
  const url = `${base}${'a'.repeat(PROMO_MAX.url - base.length - 8)}#reviews`;
  assert.equal(url.length, PROMO_MAX.url);
  const promo = { ...STORE, target: { kind: 'product', name: 'זמיוקולקס בעציץ קרמיקה בגובה ארבעים סנטימטר עם צלחת ניקוז', url } };
  const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = promo) } });
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const res = await buildPost({ ...ctx, llm: writer(ctx, LINES.product) }, { pack, formatKey: 'care-guide' });
    assert.equal(res.status, 'queued', res.reason);
    const post = loadPost(ctx.db, res.postId);
    const c = post.data.closing;
    assert.equal(c.line, LINES.product);
    assert.notEqual(c.actions.instagram.display, url, 'the slide shows the short address');
    for (const p of PLATFORMS) {
      const caption = captionOf(ctx.db, post, p);
      assert.ok(caption.length <= captionRoom(p) && captionRoom(p) < CAPTION_MAX[p], `${p}: within its limit, with room for the AI line`);
      assert.ok(split(caption, post.hashtags || []).body.endsWith(captionAction(c, p)), `${p}: ends on the action`);
      if (p !== 'tiktok') assert.ok(caption.includes(` ${url}`), `${p}: the whole address`);
      else assert.doesNotMatch(caption, ADDRESS);
      assert.deepEqual(hashtagsIn(caption), post.hashtags || [], `${p}: the link's #fragment is no hashtag`);
      // The publishers cut at the platform's limit, the AI line added: nothing of the action is cut.
      const sent = postBody({ platform: p, accountId: 'x', caption, imageUrls: [], aiLabel: true });
      assert.ok((p === 'tiktok' ? sent.tiktokSettings.description : sent.content).includes(captionAction(c, p)), `${p}: the action goes out whole`);
    }
    // A caption that would pass Instagram's 2,200 with its hashtags (an owner's long one, the longest tags): the tags go
    // first, from the last, and the action stays whole at the end.
    const long = { ...post, caption_ig: `${'מילים '.repeat(290).trim()}.`, hashtags: Array.from({ length: 5 }, (_, i) => `#${'צמחים'.repeat(8)}${i}`) };
    const fitted = captionOf(ctx.db, long, 'instagram');
    assert.ok(fitted.length <= captionRoom('instagram'), `${fitted.length} characters`);
    const kept = hashtagsIn(fitted);
    assert.ok(kept.length < 5, 'hashtags shed');
    assert.deepEqual(kept, long.hashtags.slice(0, kept.length), 'from the last');
    assert.ok(fitted.includes(`${captionAction(c, 'instagram')}\n\n`) || fitted.endsWith(captionAction(c, 'instagram')), 'the action whole');
    const sent = postBody({ platform: 'instagram', accountId: 'x', caption: fitted, imageUrls: [], aiLabel: true });
    assert.ok(sent.content.length <= CAPTION_MAX.instagram && sent.content.includes(captionAction(c, 'instagram')), 'and it goes out whole with the AI line');
  } finally {
    cleanup();
  }
});

test('the caption cannot drift from the slide: one action data, an owner\'s caption, the files, the page', { timeout: 300_000 }, async () => {
  const { captionAction } = await import('../src/pipeline/closing.js');
  const { captionBody, captionOf, closingRecheck } = await import('../src/publish/index.js');
  const { home, cleanup } = tempHome({ packs: { demo: (f) => (f.pack.promo = PROMOS.product) } });
  const out = mkdtempSync(path.join(os.tmpdir(), 'of-caption-'));
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const res = await buildPost({ ...ctx, llm: writer(ctx, LINES.product) }, { pack, formatKey: 'plant-story', docKey: 'pothos-story' });
    assert.equal(res.status, 'queued', res.reason);
    const post = loadPost(ctx.db, res.postId);
    const ig = captionAction(post.data.closing, 'instagram');
    assert.equal(ig, 'באתר https://atzitz.example/zz-plant');
    // The action is read from the stored slide every time, never kept in the words: the words carry none.
    assert.doesNotMatch(post.caption, /הלינק בביו|באתר/);
    assert.doesNotMatch(post.caption_ig, ADDRESS);
    // A site's bare root is the same link without its last "/".
    assert.equal(captionAction({ actions: { instagram: { where: 'url', lead: 'באתר', text: 'באתר atzitz.example', url: 'https://atzitz.example/' } } }, 'instagram'), 'באתר https://atzitz.example');
    // An owner who typed the action at the end of the words is not given it twice.
    const typed = { ...post, caption: `${post.caption}\nהלינק בביו` };
    assert.equal(count(captionOf(ctx.db, typed, 'tiktok'), 'הלינק בביו'), 1);
    // A promo changed after the post was written: the slide and the caption still say the same, and the check before
    // any send stops the post (test/closing-checks.test.js has every path).
    pack.meta.promo = { ...PROMOS.product, target: { kind: 'product', name: 'סנסיווריה גבוהה', url: 'https://atzitz.example/snake' } };
    assert.equal(captionAction(loadPost(ctx.db, res.postId).data.closing, 'instagram'), ig, 'the caption says what the slide was drawn with');
    assert.ok(closingRecheck(loadPost(ctx.db, res.postId), pack).length, 'and the post does not go out');
    pack.meta.promo = PROMOS.product;
    // The dry run's files and the bundle carry it as it goes out.
    exportPost(ctx.db, res.postId, out);
    assert.equal(readFileSync(path.join(out, 'caption.txt'), 'utf8'), `${captionOf(ctx.db, post, 'tiktok')}\n`);
    assert.equal(readFileSync(path.join(out, 'caption-instagram.txt'), 'utf8'), `${captionOf(ctx.db, post, 'instagram')}\n`);
    assert.ok(captionBody(ctx.db, post, 'instagram').endsWith(ig));
    // The post's page shows each caption with its action, the link kept left to right.
    const page = postPage({ csrf: 'x' }, postFull(ctx, res.postId));
    assert.match(page, /<span class="act">הלינק בביו<\/span>/);
    assert.match(page, /<span class="act">באתר <bdi dir="ltr">https:\/\/atzitz\.example\/zz-plant<\/bdi><\/span>/);
    assert.match(page, /בסוף הכיתוב אנחנו מוסיפים לבד לאן השקף האחרון שולח, ובאינסטגרם ובפייסבוק גם את הקישור/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    cleanup();
  }
});
