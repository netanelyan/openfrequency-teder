import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, extraOf, loadPost, postDraft, textsOf, tiktokHookOf, TIKTOK_HOOK_WORDS } from '../src/pipeline/build.js';
import { gate, tokenOf } from '../src/verify/claims.js';
import { overlayProblems } from '../src/rules/overlay.js';
import { closeBrowser, coverLineFor } from '../src/render/render.js';
import { deletePost, edit } from '../src/web/actions.js';
import { postFull } from '../src/web/data.js';
import { postPage } from '../src/web/pages.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// The owner, 2026-11-13: "hooks on tiktok should be catchier. instagram is a slower paced social media, so our hooks are
// good for instagram, less for tiktok" (build.js onTiktok); on the post's page, "again, 2 rows into 1 row. also, where is
// the delete button? i dont want this post anymore" (pages.js slidesRow, deletable).

after(() => closeBrowser());

const owner = { id: 1, name: 'owner' };
const ON_TIKTOK = { meta: { platforms: ['tiktok', 'instagram'] } };
const OFF_TIKTOK = { meta: { platforms: ['instagram', 'facebook'] } };
// Made up, as the writer's examples are.
const HOOK = 'איך שומרים על פולי קפה טריים יותר זמן';
const TK = 'המקרר הורס לכם את הקפה';

test("TikTok's cover line is kept only where TikTok would otherwise draw the same cover", () => {
  assert.equal(tiktokHookOf(ON_TIKTOK, { hook: HOOK, hookTiktok: TK }), TK);
  assert.equal(tiktokHookOf(ON_TIKTOK, { hook: HOOK, hookTiktok: TK }, true), '', "a template's cover is TikTok's too");
  assert.equal(tiktokHookOf(OFF_TIKTOK, { hook: HOOK, hookTiktok: TK }), '', 'an account not on TikTok has none');
  assert.equal(tiktokHookOf(ON_TIKTOK, { hook: 'המקרר הורס\nלכם את הקפה', hookTiktok: TK }), '', 'the same words are no line of its own');
  assert.equal(tiktokHookOf(ON_TIKTOK, { hook: HOOK }), '', 'an answer from before it has none');
  // The renderer: TikTok's slides draw it, Instagram's (a Page's too) the cover line; a post with none draws the cover line.
  assert.equal(coverLineFor({ hook: HOOK, extra: { hookTiktok: TK } }, 'tiktok'), TK);
  assert.equal(coverLineFor({ hook: HOOK, extra: { hookTiktok: TK } }, 'instagram'), HOOK);
  assert.equal(coverLineFor({ hook: HOOK, extra: {} }, 'tiktok'), HOOK, 'an older post keeps its cover on TikTok');
});

test('it is read and signed as a cover: the voice and the lines, the fact gate, the token', () => {
  const slides = [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }];
  const draft = { hook: HOOK, hookTiktok: TK, sub: '', slides, caption: '', captionShort: '' };
  assert.deepEqual(textsOf(draft).filter((t) => t.where === 'cover tiktok').map((t) => [t.kind, t.text]), [['cover', TK]]);
  assert.equal(textsOf({ ...draft, hookTiktok: '' }).some((t) => t.where === 'cover tiktok'), false, 'none, nothing to read');
  // Signed with the post: the renderer draws only what the gate signed.
  const extra = extraOf(draft);
  assert.equal(extra.hookTiktok, TK);
  const signed = gate({ slides, facts: [], hook: HOOK, sub: '', caption: '', extra });
  assert.equal(signed.token, tokenOf({ slides, hook: HOOK, sub: '', caption: '', extra }));
  assert.notEqual(signed.token, tokenOf({ slides, hook: HOOK, sub: '', caption: '', extra: extraOf({ ...draft, hookTiktok: '' }) }));
  // A number on TikTok's cover is held to the quotes like one on the cover.
  const numbered = gate({ slides, facts: [], hook: HOOK, sub: '', caption: '', extra: extraOf({ ...draft, hookTiktok: 'אחרי 14 יום הפולים כבר לא אותו דבר' }) });
  assert.ok(numbered.problems.some((p) => /the cover: the number 14 is not in any cited quote/.test(p)), numbered.problems.join(' | '));
  // Its lines: a line too long is TikTok's cover's problem, and the line under both covers is read once.
  const lines = overlayProblems({ ...draft, hookTiktok: 'המקרר הורס לכם את הקפה כל בוקר מחדש', sub: 'שורה אחת\nושורה שנייה' });
  assert.ok(lines.some((p) => p.where === 'cover tiktok' && /words/.test(p.msg)), JSON.stringify(lines));
  assert.equal(lines.filter((p) => p.where === 'cover line 2').length, lines.filter((p) => p.where === 'cover line 2' && p.msg).length);
  assert.ok(TIKTOK_HOOK_WORDS >= 8, 'the writer is asked for 3 to 8 words');
});

/** A queued demo post (TikTok and Instagram), and a writer's check that answers "fine" for every text it is shown. */
async function queued(home) {
  keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  const pack = ctx.pack('demo');
  const res = await buildPost(ctx, { pack, formatKey: 'care-guide' });
  assert.equal(res.status, 'queued', res.reason);
  const llm = { kind: 'claude', async json(req) { return { data: { reviews: [{ index: 0, botScore: 1, tells: [], factIssue: false, factProblem: '' }] }, usage: { input_tokens: 10, output_tokens: 5 }, model: req.model }; } };
  return { ctx: { ...ctx, llm }, db, id: res.postId, pack };
}

const formOf = (db, id) => {
  const p = loadPost(db, id);
  const f = { hook: p.hook, sub: p.sub || '', caption: p.caption, caption_short: p.data?.captionShort || '', hook_tiktok: p.data?.hookTiktok || '' };
  p.slides.filter((s) => s.kind === 'item').forEach((s, i) => Object.assign(f, { [`title_${i}`]: s.title, [`body_${i}`]: s.body }));
  return f;
};

test("an edited TikTok cover line: TikTok's cover is drawn with it, Instagram's is not touched, and the page shows one row", { timeout: 600_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id, pack } = await queued(home);
    assert.ok(pack.meta.platforms.includes('tiktok') && pack.meta.platforms.includes('instagram'));
    const before = loadPost(db, id);
    const cover = (p, size) => readFileSync(p.media[size][0]);
    const [tk0, ig0] = [cover(before, 'tiktok'), cover(before, 'instagram')];
    // The recorded answer is from before: it has no line of its own, and TikTok draws the cover line.
    assert.equal(before.data.hookTiktok, undefined);
    assert.equal(postDraft(before).hookTiktok, undefined);

    // Typed on two lines, it is broken again in code by the account's rule, as any cover is (lineDraft).
    await edit(ctx, owner, { id }, { ...formOf(db, id), hook_tiktok: 'בזיליקום שונא\nאדנית צפופה' });
    const after1 = loadPost(db, id);
    assert.equal(after1.data.hookTiktok, 'בזיליקום שונא אדנית צפופה');
    assert.equal(after1.hook, before.hook, 'the cover line is as it was');
    assert.equal(postDraft(after1).hookTiktok, 'בזיליקום שונא אדנית צפופה');
    assert.ok(!cover(after1, 'tiktok').equals(tk0), "TikTok's cover is drawn with its own line");
    assert.ok(cover(after1, 'instagram').equals(ig0), "Instagram's cover is the same as before");

    // One row: a switch over TikTok's slides, Instagram's in their place when it is pressed; the form has the line.
    const html = postPage({ csrf: 'x' }, postFull(ctx, id));
    assert.equal((html.match(/class="pf"/g) || []).length, 1);
    assert.match(html, /<label for="pf-tk-[^"]+" class="pf-l-tk">טיקטוק <small>9:16<\/small><\/label><label for="pf-ig-[^"]+" class="pf-l-ig">אינסטגרם/);
    assert.equal((html.match(/data-strip/g) || []).length, 2, "both platforms' slides, one shown at a time");
    assert.doesNotMatch(html, /איך זה נראה באינסטגרם/, 'no second row under the first');
    assert.match(html, /name="hook_tiktok" value="בזיליקום שונא אדנית צפופה"/);

    // Emptied, TikTok draws the cover line again.
    await edit(ctx, owner, { id }, { ...formOf(db, id), hook_tiktok: '' });
    const after2 = loadPost(db, id);
    assert.equal(after2.data.hookTiktok, undefined);
    assert.ok(cover(after2, 'tiktok').equals(tk0), "TikTok's cover is the cover line again");
  } finally {
    cleanup();
  }
});

test('every post page has one delete: a scheduled or never-sent one by the reason form, one that could never go out at once, one already out says where', { timeout: 600_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const { ctx, db, id } = await queued(home);
    const page = () => postPage({ csrf: 'x' }, postFull(ctx, id));
    const set = (row) => db.update('posts', id, row);

    // Waiting for approval: its bar's "דחייה", no second way.
    assert.doesNotMatch(page(), /למחוק את הפוסט/);

    // Failed before any platform took it: the reason form, to /delete.
    set({ status: 'failed', published_at: null, publish_json: { tiktok: { via: 'zernio', error: 'Zernio said no' } } });
    assert.match(page(), /למחוק את הפוסט/);
    assert.match(page(), new RegExp(`action="/post/${id}/delete"`));

    // Out on TikTok and Instagram: the row says where to delete it, with each post's link, and the action refuses.
    set({ status: 'published', published_at: new Date().toISOString(), publish_json: { tiktok: { via: 'zernio', status: 'published', url: 'https://www.tiktok.com/@demo/video/1' }, instagram: { via: 'zernio', status: 'published', permalink: 'https://www.instagram.com/p/x/' } } });
    const out = page();
    assert.match(out, /למחוק את הפוסט/);
    assert.match(out, /הפוסט כבר עלה, ומכאן אי אפשר למחוק אותו מהרשתות/);
    assert.match(out, /טיקטוק: מוחקים באפליקציה של טיקטוק · <a href="https:\/\/www\.tiktok\.com\/@demo\/video\/1"/);
    assert.match(out, /אינסטגרם: מוחקים באפליקציה של אינסטגרם · <a href="https:\/\/www\.instagram\.com\/p\/x\/"/);
    assert.doesNotMatch(out, new RegExp(`action="/post/${id}/delete"`));
    assert.throws(() => deletePost(ctx, owner, { id }, {}), /הפוסט כבר עלה/);

    // Stopped by the checks: one press and a second, short enough to stay a button, and it is off the lists.
    set({ status: 'blocked', published_at: null, publish_json: {} });
    assert.match(page(), /data-confirm="לחצו שוב כדי למחוק"/);
    const r = deletePost(ctx, owner, { id }, {});
    assert.equal(r.message, 'הפוסט נמחק.');
    const gone = loadPost(db, id);
    assert.deepEqual([gone.status, gone.reject.deleted, gone.reject.redo], ['rejected', true, 'declined']);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM audit WHERE action = 'delete_post' AND post_id = ?", id).n, 1);
    const done = page();
    assert.match(done, /<span class="chip ghost">נמחק<\/span>/);
    assert.doesNotMatch(done, /למחוק את הפוסט/, 'nothing left to delete');
  } finally {
    cleanup();
  }
});
