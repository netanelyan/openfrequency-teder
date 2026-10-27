import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, loadPack, readPack } from '../src/packs/load.js';
import { packWarnings, validatePack } from '../src/packs/validate.js';
import { makeContext } from '../src/engine.js';
import { buildPost, fixDraft, hashtagsFor } from '../src/pipeline/build.js';
import { SLIDES_SCHEMA } from '../src/pipeline/prompts.js';
import { publishPost, PublishRefused } from '../src/publish/index.js';
import { MAX_HASHTAGS, STORY, beatsOf, captionProblems, hashtagProblems, hashtagsIn, storyCaption, storyProblems } from '../src/rules/caption.js';
import { limitsFor } from '../src/voice/tells.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { DEMO, opened, tempHome } from './helpers.js';

after(() => closeBrowser());

// TikTok's caption is a story in four beats (hook, problem, discovery, result), and a post carries five hashtags at
// most: src/rules/caption.js.

const BEATS = {
  hook: 'פוטוס אחד נשאר לבד במשרד סגור 81 יום.',
  problem: 'אף אחד לא השקה אותו, וכשהעובדים חזרו רוב העלים כבר היו צהובים.',
  discovery: 'אבל שלושה גבעולים החזיקו מעמד, ומהם יצאו ייחורים.',
  result: 'הייחורים מילאו חמישה עציצים, והצמח המקורי צומח מחדש על אותו מדף.',
};
const STORY_TEXT = storyCaption(BEATS);
const msgs = (problems) => problems.map((p) => p.msg).join(' · ');

test('the four beats become the caption, one a line, in the order of the story', () => {
  assert.deepEqual(STORY, ['hook', 'problem', 'discovery', 'result']);
  assert.equal(STORY_TEXT, Object.values(BEATS).join('\n\n'));
  assert.deepEqual(beatsOf(STORY_TEXT), Object.values(BEATS));
  // A beat the writer broke over two lines is still one beat; the order is the story's, not the answer's.
  assert.equal(storyCaption({ result: 'ד ה ו', discovery: 'ג\nג ג', problem: 'ב ב ב', hook: 'א א א' }), 'א א א\n\nב ב ב\n\nג ג ג\n\nד ה ו');
  assert.deepEqual(storyProblems(STORY_TEXT), []);
  // A caption edited by hand with single line breaks reads the same.
  assert.deepEqual(storyProblems(Object.values(BEATS).join('\n')), []);
});

test('a caption that is not four beats is refused, and the writer is told the count', () => {
  const one = storyProblems(Object.values(BEATS).join(' '));
  assert.equal(one.length, 1);
  assert.equal(one[0].code, 'caption');
  assert.match(one[0].msg, /story in 4 lines.*hook, problem, discovery, result.*one line/);
  assert.match(msgs(storyProblems([BEATS.hook, BEATS.problem, BEATS.result].join('\n\n'))), /it has 3 lines/);
  assert.match(msgs(storyProblems(`${STORY_TEXT}\n\nועוד שורה אחת בסוף.`)), /it has 5 lines/);
  assert.match(msgs(storyProblems('')), /it has 0 lines/);
});

test('each beat has its own size: a short hook of one sentence, the others at most two', () => {
  const at = (k, text) => storyCaption({ ...BEATS, [k]: text });
  assert.match(msgs(storyProblems(at('hook', 'פוטוס נשאר לבד 81 יום. אף אחד לא השקה אותו.'))), /hook line has 2 sentences: one/);
  assert.match(msgs(storyProblems(at('hook', `פוטוס אחד נשאר לבד במשרד סגור 81 יום ${'וחיכה שמישהו יחזור '.repeat(4)}`))), /hook line is \d+ characters: at most 100/);
  assert.match(msgs(storyProblems(at('problem', 'אף אחד לא השקה. העלים הצהיבו. האדמה התייבשה.'))), /problem line has 3 sentences: at most 2/);
  assert.match(msgs(storyProblems(at('discovery', 'שלושה גבעולים'))), /discovery line has 2 words/);
  // The closing question rides at the end of the result: one sentence more, when it is a question.
  assert.deepEqual(storyProblems(at('result', `${BEATS.result} הם כבר על כל שולחן. יש לכם צמח שכמעט ויתרתם עליו?`)), []);
  assert.match(msgs(storyProblems(at('result', `${BEATS.result} הם כבר על כל שולחן. והמקורי גזום.`))), /result line has 3 sentences/);
});

test('a beat that repeats another is refused: each one moves the story on', () => {
  assert.match(msgs(storyProblems(storyCaption({ ...BEATS, discovery: BEATS.problem }))), /discovery line repeats its problem line/);
  // Punctuation and spacing are not a new beat.
  assert.match(msgs(storyProblems(storyCaption({ ...BEATS, result: `${BEATS.hook.replace('.', '')},` }))), /result line repeats its hook line/);
});

test('a short-caption account still gets four beats, each within its share', () => {
  const pack = { meta: { writing: { captionLong: { maxChars: 100, sentences: 2, minChars: 60 } } } };
  // The pack may tighten the caption, never below four lines and the question.
  const lim = limitsFor('captionLong', pack);
  assert.equal(lim.maxChars, 160);
  assert.equal(lim.sentences, 5);
  assert.equal(lim.minChars, 60);
  // Above the floor the pack's own limit stands, and other texts are untouched.
  assert.equal(limitsFor('captionLong', { meta: { writing: { captionLong: { maxChars: 300 } } } }).maxChars, 300);
  assert.equal(limitsFor('slideBody', { meta: { writing: { slideBody: { sentences: 1 } } } }).sentences, 1);
  assert.match(msgs(storyProblems(STORY_TEXT, lim)), /problem line is \d+ characters: this account keeps captions short, about 38 a line/);
  assert.deepEqual(storyProblems('81 יום בלי מים במשרד.\n\nאף אחד לא השקה אותו.\n\nשלושה גבעולים שרדו.\n\nהיום הם בחמישה עציצים.', lim), []);
  // The engine's own limits ask for no share.
  assert.deepEqual(storyProblems(STORY_TEXT, limitsFor('captionLong')), []);
});

test('hashtags are found as tags, never inside a word or a link', () => {
  assert.deepEqual(hashtagsIn('#גינון בבית, #צמחי_בית ו-#Plants2026'), ['#גינון', '#צמחי_בית', '#Plants2026']);
  assert.deepEqual(hashtagsIn('https://example.org/page#section C# &#39; 3#'), []);
  assert.deepEqual(hashtagsIn(''), []);
});

test('no caption holds a hashtag, and a post carries five at most', () => {
  assert.equal(MAX_HASHTAGS, 5);
  const inCaption = hashtagProblems({ caption: `${STORY_TEXT} #פוטוס`, captionShort: 'שורה קצרה #צמחים' });
  assert.deepEqual(inCaption.map((p) => p.where), ['caption', 'caption short']);
  assert.match(inCaption[0].msg, /#פוטוס.*5 at most/);
  assert.deepEqual(hashtagProblems({ caption: STORY_TEXT }, ['#א', '#ב', '#ג', '#ד', '#ה']), []);
  assert.match(msgs(hashtagProblems({ caption: STORY_TEXT }, ['#א', '#ב', '#ג', '#ד', '#ה', '#ו'])), /6 hashtags: 5 at most/);
  assert.match(msgs(hashtagProblems({}, ['#טוב', 'בלי סולמית', '#עם רווח'])), /not a hashtag: בלי סולמית #עם רווח/);
  // Both rules at once, as checkPost asks them.
  assert.deepEqual(captionProblems({ caption: STORY_TEXT, captionShort: 'שורה' }), []);
  assert.equal(captionProblems({ caption: `${STORY_TEXT} #x`, captionShort: '' }).length, 1);
});

test("the engine's hashtags never pass five, however many a format names", () => {
  const pack = { formats: { hashtags: { broad: ['#גינון', '#צמחים', '#בית'], niche: ['#פוטוס', '#משרד'] } } };
  const format = { hashtags: ['#א', '#ב', '#ג', '#ד', '#ה', '#ו'] };
  assert.equal(hashtagsFor(pack, format, 'seed', 'פוטוס במשרד').length, MAX_HASHTAGS);
  assert.equal(hashtagsFor(pack, { hashtags: [] }, 'seed', 'פוטוס במשרד').length, 4);
});

test('a pack whose format names more than five hashtags fails validation', () => {
  const p = readPack(DEMO);
  assert.equal(validatePack(p).filter((x) => /hashtags is a list/.test(x)).length, 0);
  p.formats.formats[0].hashtags = ['#א', '#ב', '#ג', '#ד', '#ה', '#ו'];
  assert.match(validatePack(p).join('\n'), new RegExp(`"${p.formats.formats[0].id}": hashtags is a list of at most 5 tags`));
  p.formats.formats[0].hashtags = ['בלי סולמית'];
  assert.match(validatePack(p).join('\n'), /hashtags is a list of at most 5 tags/);
});

test('a pack whose caption limits are raised to fit the story is named in a visible warning', () => {
  const p = readPack(DEMO);
  assert.deepEqual(packWarnings(p), []);
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'of-cap-')), 'demo');
  cpSync(DEMO, dir, { recursive: true });
  const file = path.join(dir, 'pack.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  meta.writing = { ...meta.writing, captionStyle: 'story', captionLong: { maxChars: 120, sentences: 3 } };
  writeFileSync(file, JSON.stringify(meta, null, 2));
  const seen = [];
  const pack = loadPack(dir, { warn: (m) => seen.push(m) });
  assert.equal(seen.length, 2);
  assert.match(seen[0], new RegExp(`^warning: pack "${meta.id}": writing\.captionLong\.(sentences 3 is raised to 5|maxChars 120 is raised to 160)`));
  assert.ok(seen.some((m) => /maxChars 120 is raised to 160/.test(m)) && seen.some((m) => /sentences 3 is raised to 5/.test(m)));
  assert.deepEqual(pack.warnings, seen.map((m) => m.replace(/^warning: /, '')));
  assert.equal(limitsFor('captionLong', pack).maxChars, 160);
  loadPack(dir, { warn: (m) => seen.push(m) });
  assert.equal(seen.length, 2, 'printed once per process');
});

test('the writer is asked for the four beats as fields', () => {
  const story = SLIDES_SCHEMA.properties.story;
  assert.deepEqual(story.required, STORY);
  assert.deepEqual(Object.keys(story.properties), STORY);
  assert.ok(SLIDES_SCHEMA.required.includes('story'));
  assert.ok(!('caption' in SLIDES_SCHEMA.properties), 'one source for the caption: the story');
});

test('fixing a tell in code keeps the blank line between beats', () => {
  const draft = { hook: 'שער', sub: '', caption: storyCaption({ ...BEATS, discovery: 'אבל שלושה גבעולים החזיקו מעמד!' }), slides: [] };
  assert.deepEqual(fixDraft(draft), ['caption: an exclamation mark']);
  assert.equal(beatsOf(draft.caption).length, 4);
  assert.match(draft.caption, /מעמד\.\n\nהייחורים/);
});

// ---- through the pipeline

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

/** The recorded writer, with each slides answer changed by `edit`. */
const writerWith = (ctx, edit) => ({ ...ctx.llm, async json(req) {
  const r = await ctx.llm.json(req);
  if (req.task !== 'slides') return r;
  const data = structuredClone(r.data);
  edit(data);
  return { ...r, data };
} });

/** The demo account told to caption its posts as the four-beat story (pack.json writing.captionStyle). */
function storyCaptions(home) {
  const file = path.join(home, 'packs', 'demo', 'pack.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  meta.writing = { ...meta.writing, captionStyle: 'story' };
  writeFileSync(file, JSON.stringify(meta, null, 2));
}

const build = (ctx, llm = ctx.llm) => buildPost({ ...ctx, llm }, { pack: ctx.pack('demo'), formatKey: 'plant-story', sample: true, docKey: 'pothos-story' });

test('by default a TikTok caption is one short line, the hook, and the story beats the writer gave are not used', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const res = await build(ctx);
    assert.equal(res.status, 'sample', res.reason);
    const post = ctx.db.get('SELECT caption FROM posts WHERE id = ?', res.postId);
    const lines = beatsOf(post.caption);
    assert.ok(lines.length <= 2, post.caption);
    assert.ok(post.caption.startsWith('פוטוס אחד נשאר לבד במשרד סגור 81 יום.'), post.caption);
  } finally {
    cleanup();
  }
});

test("a post's TikTok caption is its story, with the closing question at the end of the result", async () => {
  const { home, cleanup } = tempHome();
  try {
    storyCaptions(home);
    const ctx = contextFor(home);
    const res = await build(ctx);
    assert.equal(res.status, 'sample', res.reason);
    const post = ctx.db.get('SELECT caption, caption_ig, hashtags_json FROM posts WHERE id = ?', res.postId);
    const beats = beatsOf(post.caption);
    assert.equal(beats.length, 4, post.caption);
    assert.equal(beats[0], 'פוטוס אחד נשאר לבד במשרד סגור 81 יום.');
    assert.match(beats[3], /על אותו מדף\. יש לכם צמח שכמעט ויתרתם עליו\?$/);
    // Instagram's short caption is not a story: the cover line, then the short caption.
    assert.ok(post.caption_ig.startsWith('הפוטוס שנשכח במשרד סגור'));
    assert.ok(JSON.parse(post.hashtags_json).length <= MAX_HASHTAGS);
  } finally {
    cleanup();
  }
});

test('a writer that returns one paragraph, or a hashtag in a beat, is refused before the post is drafted', async () => {
  const { home, cleanup } = tempHome();
  try {
    storyCaptions(home);
    const ctx = contextFor(home);
    // An older answer, one caption of one paragraph: the redraft is told, and without a second recording the post stops.
    const flat = await build(ctx, writerWith(ctx, (d) => {
      d.caption = Object.values(d.story).join(' ');
      delete d.story;
    }));
    assert.equal(flat.status, 'blocked');
    assert.match(ctx.db.get("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'slides'", flat.postId).detail_json, /story in 4 lines/);

    ctx.db.run('DELETE FROM posts');
    const tagged = await build(ctx, writerWith(ctx, (d) => (d.story.result += ' #פוטוס')));
    assert.equal(tagged.status, 'blocked');
    assert.match(ctx.db.get("SELECT detail_json FROM steps WHERE post_id = ? AND step = 'slides'", tagged.postId).detail_json, /a hashtag in the caption/);
  } finally {
    cleanup();
  }
});

test('nothing is published with more than five hashtags, counted on the caption as it goes out', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const res = await build(ctx);
    ctx.db.run("UPDATE posts SET status = 'approved' WHERE id = ?", res.postId);
    const t = israelInstant('2026-10-13', '12:45').getTime();
    ctx.db.run('UPDATE posts SET hashtags_json = ? WHERE id = ?', JSON.stringify(['#א', '#ב', '#ג', '#ד', '#ה', '#ו']), res.postId);
    await assert.rejects(publishPost(ctx, res.postId, { t }), (e) => e instanceof PublishRefused && e.code === 'hashtags' && /6 hashtags in the tiktok caption/.test(e.message));
    // Refused before anything left: the post still waits, approved, and goes out once it is back to five.
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', res.postId).status, 'approved');
    ctx.db.run('UPDATE posts SET hashtags_json = ? WHERE id = ?', JSON.stringify(['#א', '#ב', '#ג', '#ד', '#ה']), res.postId);
    const ok = await publishPost(ctx, res.postId, { t });
    assert.equal(ok.ok, true);
  } finally {
    cleanup();
  }
});
