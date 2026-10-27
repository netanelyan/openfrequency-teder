import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, checkPost, draftFromAnswer, loadPost, postDraft } from '../src/pipeline/build.js';
import { coverFrame, fillTemplate, hookProblems, matchFrame, templateConfigProblems, templatesFor, templatesOf, TEMPLATES } from '../src/formats/hooks.js';
import { credit, ensureFormats, pickTemplates, templateStats } from '../src/formats/rotation.js';
import { coverOptions } from '../src/metrics/feedback.js';
import { packBlock, slidesUser } from '../src/pipeline/prompts.js';
import { tellsIn } from '../src/voice/tells.js';
import { closeBrowser } from '../src/render/render.js';
import { opened, setDraft, tempHome } from './helpers.js';

// The cover's hook templates (src/formats/hooks.js): filled in the account's voice, allowed on the cover only and
// only when the slides keep the promise, and credited in the results so the ones that work come back.

after(() => closeBrowser());

const tpl = (id) => TEMPLATES.find((t) => t.id === id);

test('a template is filled in the account\'s voice: the speaker\'s forms, the authority\'s gender, a Latin name after a prefix', () => {
  const x = { x: '3 שעות בשבוע', thing: 'טפטפת אחת' };
  assert.equal(fillTemplate(tpl('save-x'), x, { speaker: 'm' }).text, 'חוסך לכם 3 שעות בשבוע רק בזכות טפטפת אחת');
  assert.equal(fillTemplate(tpl('save-x'), x, { speaker: 'f' }).text, 'חוסכת לכם 3 שעות בשבוע רק בזכות טפטפת אחת');
  assert.equal(fillTemplate(tpl('save-x'), x, { speaker: 'p' }).text, 'חוסכים לכם 3 שעות בשבוע רק בזכות טפטפת אחת');
  assert.equal(fillTemplate(tpl('reveal'), { topic: 'נענע בעציץ' }, { speaker: 'f' }).text, 'אני עומדת לחשוף את האמת על נענע בעציץ');
  assert.equal(fillTemplate(tpl('reveal'), { topic: 'נענע בעציץ' }, { speaker: 'p' }).text, 'אנחנו עומדים לחשוף את האמת על נענע בעציץ');
  assert.equal(fillTemplate(tpl('save-time'), { topic: 'השתילה הראשונה' }, { speaker: 'p' }).text, 'תנו לנו לחסוך לכם זמן עם השתילה הראשונה');
  // {w:...} agrees with whoever fills {who}, and a slot comes without the template's own prefix.
  assert.equal(fillTemplate(tpl('who-told'), { who: 'המאפרת', fact: 'פריימר בא לפני הקרם.' }, { who: 'f' }).text, 'במקרה שהמאפרת שלכם לא אמרה לכם, פריימר בא לפני הקרם');
  assert.equal(fillTemplate(tpl('who-told'), { who: 'המאמן', fact: 'ריצה איטית שורפת יותר' }, { who: 'm' }).text, 'במקרה שהמאמן שלכם לא אמר לכם, ריצה איטית שורפת יותר');
  assert.equal(fillTemplate(tpl('who-taught'), { who: 'ההורים', skill: 'לחסוך' }, { who: 'p' }).text, 'במקרה שההורים שלכם לא לימדו אתכם לחסוך');
  assert.equal(fillTemplate(tpl('real-truth'), { topic: 'ChatGPT' }).text, 'הנה האמת האמיתית על ChatGPT');
  assert.equal(fillTemplate(tpl('everyone-knew'), { fact: 'ChatGPT זוכר שיחות' }).text, 'החלום שלי שכולם ידעו ש-ChatGPT זוכר שיחות');
  assert.deepEqual(fillTemplate(tpl('save-x'), { thing: 'טפטפת' }).missing, ['x'], 'a slot left empty is said, never filled with nothing');
  // The frame is known again on a cover as written, with its slots.
  assert.deepEqual(matchFrame(tpl('save-x'), 'חוסכת לכם 3 שעות בשבוע\nרק בזכות טפטפת אחת').slots, { x: '3 שעות בשבוע', thing: 'טפטפת אחת' });
});

test('a pack adds its own templates and turns others off, and the kind decides which a post may use', () => {
  const pack = { formats: { formats: [], hookTemplates: { disable: ['save', 'told-wrong'], add: [{ id: 'secret-of', mechanism: 'secret', text: 'הסוד של {who} על {topic}', kinds: ['story'] }] } } };
  const ids = templatesOf(pack).map((t) => t.id);
  assert.ok(ids.includes('secret-of') && ids.includes('real-truth'));
  assert.ok(!ids.includes('save-x') && !ids.includes('save-time') && !ids.includes('told-wrong'), 'a mechanism turned off takes its templates with it');
  assert.ok(templatesFor(pack, { kind: 'story' }).some((t) => t.id === 'secret-of'));
  assert.ok(!templatesFor(pack, { kind: 'guess-who' }).length, "a guess-who's subject is its answer: no template names it");
  assert.ok(!templatesFor(pack, { kind: 'story' }).some((t) => t.id === 'nobody-told'), "a fact on a story's cover gives its twist away");
  assert.deepEqual(templatesFor(pack, { id: 'x' }), [], 'a phase 1 list post has no templates');
  assert.deepEqual(templatesOf({ formats: { hookTemplates: { off: true } } }), []);
  // What a pack may write is checked: no invented experience, the audience in the plural, slots that exist.
  const bad = (t) => templateConfigProblems({ add: [{ id: 'x', mechanism: 'wish', kinds: ['story'], ...t }] }).join(' | ');
  assert.match(bad({ text: 'הלוואי וידעתי קודם ש{fact}' }), /experience/);
  assert.match(bad({ text: 'במקרה שאמא שלך לא סיפרה לך, {fact}' }), /plural/);
  assert.match(bad({ text: 'הנה האמת על {subject}' }), /not a slot/);
  assert.match(bad({ text: 'הנה {topic}' }), /two fixed words/);
  assert.equal(bad({ text: 'הלוואי שהייתם יודעים את זה על {topic}' }), '');
  assert.match(templateConfigProblems({ speaker: 'female' }).join(), /speaker/);
});

/** A myth-fact draft as the pipeline holds it, with the cover the test gives it. */
function mythDraft({ hook, hookTemplate = null, factsOn6 = ['f5', 'f6'] }) {
  return {
    hook, sub: 'ומה עושים במקום', caption: '', captionShort: '', keywords: [], subject: {}, hookPattern: hookTemplate ? `tpl:${hookTemplate.id}` : 'still-believe', hookFallback: 'still-believe',
    ...(hookTemplate ? { hookTemplate } : {}),
    slides: [
      { kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] },
      { kind: 'item', role: 'myth', title: 'עדיף לתת קצת מים כל יום', body: 'נשמע כמו טיפ טוב.', factKeys: [] },
      { kind: 'item', role: 'fact', title: 'משקים לעומק, ואז מחכים', body: 'טיפה כל יום מרטיבה רק למעלה. משקים עד שהמים יוצאים מהחור, ומחכים ש-3 הסנטימטרים העליונים יתייבשו.', factKeys: factsOn6 },
    ],
  };
}

const FACTS = [
  { key: 'f5', claim: 'קצת מים כל יום מרטיבים את פני האדמה, והשורשים למטה נשארים יבשים', quote: 'A small splash of water every day keeps the top of the soil wet while the roots below stay dry.', verified: true },
  { key: 'f6', claim: 'משקים לעומק עד שהמים יוצאים מחור הניקוז, ומחכים ש-3 הסנטימטרים העליונים יתייבשו', quote: 'Water deeply instead, until water runs out of the drainage hole, and then wait until the top 3 cm of soil are dry.', verified: true },
  { key: 'f7', claim: 'ברוב הדירות זה אומר להשקות עציץ פעם בשבוע או פחות', quote: 'In most apartments that means watering a pot once a week or less, not every day.', verified: true },
];
const PACK = { formats: { formats: [{ id: 'myth-fact', kind: 'myth-fact' }], hookTemplates: { speaker: 'f', who: [{ name: 'סבתא', gender: 'f' }] } } };
const MYTH = { id: 'myth-fact', kind: 'myth-fact' };
const msgs = (draft, facts = FACTS) => hookProblems(PACK, MYTH, draft, facts).map((p) => `${p.where}: ${p.msg}`);

test('the cover-only exception: a template opens the cover, never a slide or a caption, and never undeclared', () => {
  const ok = mythDraft({ hook: 'הנה האמת האמיתית על השקיה לעומק', hookTemplate: { id: 'real-truth', facts: ['f5', 'f6'] } });
  assert.deepEqual(msgs(ok), [], 'declared, and the slides state what it promises');
  // The same words with no template declared promise nothing anyone checked: a teaser like any other.
  assert.match(msgs({ ...ok, hookTemplate: null }).join(), /cover: the cover opens like the template "real-truth" without being written from it/);
  // Anywhere but the cover, the frame is refused.
  const onSlide = structuredClone(ok);
  onSlide.slides[2].title = 'הנה האמת האמיתית על השקיה';
  assert.match(msgs(onSlide).join(), /slide 2 title: .*is a cover template \[real-truth\]: it opens the cover and nowhere else/);
  assert.match(msgs({ ...ok, caption: 'במקרה שאף אחד עוד לא סיפר לכם, משקים לעומק.' }).join(), /caption: .*cover template/);
  assert.match(msgs({ ...ok, sub: 'אני עומדת לחשוף את האמת על השקיה' }).join(), /cover line 2: .*cover template/);
  // A template that does not fit the kind is not one this post may open with.
  assert.match(hookProblems(PACK, { id: 's', kind: 'story' }, { ...mythDraft({ hook: 'במקרה שאף אחד עוד לא סיפר לכם, משקים לעומק' }), hookTemplate: { id: 'nobody-told', facts: ['f6'] } }, FACTS).map((p) => p.msg).join(), /does not fit a story post/);
  // The account speaks as it speaks: a rewrite into another gender is refused.
  assert.match(msgs(mythDraft({ hook: 'אני עומד לחשוף את האמת על השקיה של עציצים', hookTemplate: { id: 'reveal', facts: ['f6'] } })).join(), /this account speaks in the feminine \("אני עומדת"\)/);
  assert.match(msgs(mythDraft({ hook: 'במקרה שסבתא שלכם לא לימד אתכם להשקות עציצים', hookTemplate: { id: 'who-taught', facts: ['f6'] } })).join(), /"סבתא" takes "לימדה"/);
  // The voice check lets a template's own words through on the cover, and nowhere else. "הסוד ש" is a gap a cover
  // may open (COVER_GAP), and a teaser anywhere else.
  const secret = { formats: { formats: [MYTH], hookTemplates: { add: [{ id: 'the-secret', mechanism: 'secret', text: 'הסוד שעוזר ל{topic}', kinds: ['myth-fact'] }] } } };
  const cover = 'הסוד שעוזר לעציצים בדירה';
  assert.deepEqual(tellsIn(cover, { kind: 'cover' }), []);
  const frame = coverFrame(secret, MYTH, { hook: cover, hookTemplate: { id: 'the-secret' } });
  assert.deepEqual(tellsIn(cover, { kind: 'cover', frame }), []);
  assert.match(tellsIn(cover, { kind: 'slideTitle', frame }).map((x) => x.msg).join(), /teaser/, 'the frame is let through on the cover only');
  assert.match(tellsIn('הסוד שעוזר לעציצים, לא תאמינו', { kind: 'cover', frame }).map((x) => x.msg).join(), /לא תאמינו/, 'the words in its slots are still checked');
});

test('a promise the slides do not keep is refused: the facts named, on a slide, every number in their quotes', () => {
  const draft = (hook, id, facts, on6) => mythDraft({ hook, hookTemplate: { id, facts }, factsOn6: on6 });
  assert.match(msgs(draft('הנה האמת האמיתית על השקיה של עציצים', 'real-truth', [], ['f5', 'f6'])).join(), /names the facts it promises \(hookFacts\)/);
  assert.match(msgs(draft('הנה האמת האמיתית על השקיה של עציצים', 'real-truth', ['f7'], ['f5', 'f6'])).join(), /promises what "f7" says .* and no slide states it/);
  assert.match(msgs(draft('הנה האמת האמיתית על השקיה של עציצים', 'real-truth', ['f9'], ['f5', 'f6'])).join(), /not one of the post's facts/);
  assert.match(msgs(draft('הנה האמת האמיתית על השקיה של עציצים', 'real-truth', ['f6'], ['f6']), [{ ...FACTS[1], verified: false }]).join(), /failed verification/);
  // The truth about something no slide is about.
  assert.match(msgs(draft('הנה האמת האמיתית על דשן לעגבניות', 'real-truth', ['f6'], ['f6'])).join(), /promises "דשן לעגבניות", and no slide is about it/);
  // X is a real number from the promised facts' quotes, never a guess and never another fact's.
  const x = (hook) => msgs(draft(hook, 'save-x', ['f6'], ['f6'])).join(' | ');
  assert.equal(x('חוסכת לכם 3 סנטימטרים של השקיה רק בזכות השקיה לעומק'), '');
  assert.match(x('חוסכת לכם 5 שעות בשבוע רק בזכות השקיה לעומק'), /the number 5 on the cover is not in the quotes of the facts it promises/);
  assert.match(x('חוסכת לכם הרבה זמן רק בזכות השקיה לעומק'), /fills the template's X, which is a real number/);
  // A fact on the cover is one of the promised facts, said the way they say it.
  const fact = (f) => msgs(mythDraft({ hook: `במקרה שאף אחד עוד לא סיפר לכם, ${f}`, hookTemplate: { id: 'nobody-told', facts: ['f6'] }, factsOn6: ['f6'] })).join(' | ');
  assert.equal(fact('משקים לעומק עד שהמים יוצאים'), '');
  assert.match(fact('קקטוס צריך דשן כל חודש'), /states "קקטוס צריך דשן כל חודש", which the facts it promises \(f6\) do not say/);
});

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

test('the writer is offered templates, the code writes the cover from them, and the post is credited to its template', async () => {
  const { home, cleanup } = tempHome();
  try {
    setDraft(path.join(home, 'packs', 'demo'), 'plant-myths', (d) => {
      Object.assign(d.slides, { hook: 'הנה האמת על השקיה', hookTemplate: 'real-truth', hookSlots: { topic: 'השקיה של עציצים בדירה' }, hookFacts: ['f5', 'f6'], hookHighlight: 'האמת האמיתית' });
    });
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    // The prompts: the account's templates in its own voice (the demo speaks in the masculine), the post's offered best first.
    assert.match(packBlock(pack).text, /COVER TEMPLATES[\s\S]*\[save-x\][^\n]*"חוסך לכם \{x\} רק בזכות \{thing\}"/);
    assert.doesNotMatch(packBlock(pack).text, /\[told-wrong\]/, 'the demo turns it off');
    const format = pack.formats.formats.find((f) => f.id === 'myth-fact');
    const offered = pickTemplates(ctx.db, pack, format, { rand: () => 0.5 });
    assert.equal(offered.length, 3);
    assert.equal(new Set(offered.map((t) => t.mechanism)).size, 3, 'three ways to open, not three wordings of one');
    assert.match(slidesUser({ format, n: 6, outline: { topic: 't', items: [] }, facts: [], templates: offered, hook: { id: 'still-believe', pattern: 'p' }, pack }), /COVER TEMPLATES FOR THIS POST, best first: \[[a-z-]+\], \[[a-z-]+\], \[[a-z-]+\]\..*masculine[\s\S]*COVER PATTERN \(when no template fits\)/);

    const r = await buildPost(ctx, { pack, formatKey: 'myth-fact', docKey: 'plant-myths' });
    assert.equal(r.status, 'queued', r.reason);
    const post = loadPost(ctx.db, r.postId);
    assert.equal(post.hook.replace(/\s+/g, ' '), 'הנה האמת האמיתית על השקיה של עציצים בדירה', 'the code wrote the cover from the slots, not the writer\'s own line');
    assert.equal(post.hook_pattern, 'tpl:real-truth');
    assert.deepEqual(post.data.hookTemplate.facts, ['f5', 'f6']);
    // An edit that keeps the frame and breaks the promise is refused like a draft would be.
    const d = postDraft(post);
    d.hook = 'הנה האמת האמיתית על דשן לעגבניות';
    const { problems } = checkPost(ctx, pack, d, post.facts, format);
    assert.match(problems.map((p) => p.msg).join(), /promises "דשן לעגבניות", and no slide is about it/);

    // The results: published, read at 80 hours, credited to the template over the account's formats.
    const at = new Date(Date.now() - 100 * 3_600_000).toISOString();
    ctx.db.update('posts', r.postId, { status: 'published', published_at: at });
    ctx.db.insert('metrics', { post_id: r.postId, platform: 'tiktok', collected_at: new Date().toISOString(), age_hours: 80, views: 1000, likes: 90, shares: 10 });
    credit(ctx.db, 'demo');
    const stats = templateStats(ctx.db, 'demo');
    assert.equal(stats['real-truth'].n, 1);
    // A variation of a template's winner tries its mechanism's other templates first, never the winner itself.
    const options = coverOptions(pack, format, 'tpl:real-truth').map((o) => o.id);
    assert.equal(options[0], 'tpl:reveal');
    assert.ok(!options.includes('tpl:real-truth') && options.includes('still-believe'));
  } finally {
    cleanup();
  }
});

test('the templates that work are offered first, untried ones get their turns, and one that keeps losing rests', () => {
  const db = new Db(':memory:');
  const AT = '2026-10-01T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: AT, updated_at: AT });
  const f = { id: 'm', kind: 'myth-fact', hooks: [{ id: 'p', pattern: 'x' }] };
  const g = { id: 'd', kind: 'do-dont', hooks: [{ id: 'q', pattern: 'y' }] };
  const pack = { id: 'a', formats: { formats: [f, g], hookTemplates: { disable: ['save', 'wish'] } } };
  ensureFormats(db, pack);
  // Results on two formats, pooled per template: real-truth wins, nobody-told loses three times in a row.
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  let i = 0;
  const post = (format, tplId, rate) => {
    const id = `p${i++}`;
    const when = new Date(t0 + i * 3_600_000).toISOString();
    db.insert('posts', { id, account_id: 'a', format_id: format, status: 'published', published_at: when, created_at: when, updated_at: when, hook_pattern: `tpl:${tplId}` });
    db.insert('metrics', { post_id: id, platform: 'tiktok', collected_at: when, age_hours: 80, views: 1000, likes: rate * 1000, shares: 0 });
  };
  for (const rate of [0.12, 0.14, 0.13]) post('m', 'real-truth', rate);
  for (const rate of [0.1, 0.1]) post('d', 'reveal', rate);
  for (const rate of [0.02, 0.02, 0.03]) post('d', 'nobody-told', rate);
  const t = Date.parse('2026-10-06T00:00:00Z');
  credit(db, 'a', { t });
  const stats = templateStats(db, 'a', { t });
  assert.equal(stats['real-truth'].n, 3, 'credited over both formats');
  assert.ok(stats['real-truth'].avg > 1 && stats['nobody-told'].avg < 0.7, JSON.stringify(stats));
  // Untried first: who-told and who-taught have had no turn yet.
  const first = pickTemplates(db, pack, f, { rand: () => 0.9, t }).map((x) => x.id);
  assert.ok(first.includes('who-told') || first.includes('who-taught'), first.join());
  assert.ok(!first.includes('nobody-told'), 'three losses in a row: it rests');
  // Once everything had its turns, the winner leads its mechanism.
  for (const id of ['who-told', 'who-told', 'who-taught', 'who-taught', 'told-wrong', 'told-wrong']) post('m', id, 0.08);
  post('m', 'reveal', 0.1);
  credit(db, 'a', { t });
  const truth = pickTemplates(db, pack, f, { rand: () => 0.5, t, n: 1 })[0];
  assert.equal(truth.mechanism, 'truth');
  assert.equal(truth.id, 'real-truth', 'weighted by results, the middle of the range is the winner\'s');
  // A cover that did not pull is not tried again, nor its mechanism.
  assert.ok(pickTemplates(db, pack, f, { rand: () => 0.5, t, avoid: 'tpl:real-truth' }).every((x) => x.mechanism !== 'truth'));
});

test('a writer\'s answer becomes a cover from its template only when every slot is filled', () => {
  const { home, cleanup } = tempHome();
  try {
    const pack = loadAll({ dir: path.join(home, 'packs') })[0];
    const format = pack.formats.formats.find((f) => f.id === 'myth-fact');
    const one = (extra) => draftFromAnswer({ packs: [] }, pack, { format, answer: { hook: 'השורה של הכותב', sub: '', slides: [], keywords: [], ...extra }, outline: {}, items: [], facts: [], hook: { id: 'still-believe' } }).draft;
    const made = one({ hookTemplate: 'save-x', hookSlots: { x: '3 סנטימטרים', thing: 'השקיה לעומק', topic: '', fact: '' }, hookFacts: ['f6'] });
    assert.equal(made.hook.replace(/\s+/g, ' '), 'חוסך לכם 3 סנטימטרים רק בזכות השקיה לעומק', 'the demo speaks in the masculine');
    assert.equal(made.hookPattern, 'tpl:save-x');
    assert.equal(made.hookTemplate.mechanism, 'save');
    assert.deepEqual(made.hookTemplate.slots, { x: '3 סנטימטרים', thing: 'השקיה לעומק' });
    const short = one({ hookTemplate: 'save-x', hookSlots: { thing: 'השקיה לעומק' }, hookFacts: ['f6'] });
    assert.equal(short.hook, 'השורה של הכותב');
    assert.equal(short.hookPattern, 'still-believe');
    assert.equal(one({ hookTemplate: 'told-wrong', hookSlots: { topic: 'קקטוסים' } }).hookPattern, 'still-believe', 'a template the pack turned off is no template');
  } finally {
    cleanup();
  }
});
