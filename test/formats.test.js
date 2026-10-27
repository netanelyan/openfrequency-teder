import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { contentRange, everyPhoto, kindOf, kindProblems, KINDS, rankAmount, ranksOf, shapeProblems, structureNumbers } from '../src/formats/kinds.js';
import { bothSides, buildPost, candidatesOf, gateDraft, hashtagsFor, keepItems, loadPost, mentionsDay, needsSides, sourceLabel, textsOf } from '../src/pipeline/build.js';
import { outlineUser, slidesUser } from '../src/pipeline/prompts.js';
import { reviewUser } from '../src/voice/review.js';
import { tokenOf } from '../src/verify/claims.js';
import { closeBrowser, renderPost, slidePlaces } from '../src/render/render.js';
import { headlineFaces, headlineFamily } from '../src/render/fonts.js';
import { he, splitLead } from '../src/render/html.js';
import { loadAll, loadPack } from '../src/packs/load.js';
import { Db } from '../src/db/index.js';
import { makeContext } from '../src/engine.js';
import { copyPack, opened, tempHome } from './helpers.js';

// The eleven kinds of post: their shapes, the checks each kind adds, the gate's
// rules for the slides that carry no fact of their own, and a full render of a
// post of every kind on both platforms.

after(() => closeBrowser());

const fmt = (kind) => ({ id: `t-${kind}`, kind, name: KINDS[kind].name, hooks: ['x'] });
const s = (role, title, body = '', facts = ['f1'], extra = {}) => ({ kind: 'item', role, title, body, factKeys: facts, ...extra });

/** A small, valid post of each kind: the content slides, the subject, and its facts. */
const SAMPLES = {
  story: { slides: [s('beat', 'הכל התחיל בעציץ אחד', 'שתיל אחד של פוטוס על אדן חלון בתל אביב.'), s('beat', 'שנה אחת אחר כך', 'הוא כיסה קיר שלם במטבח.'), s('beat', 'ואז הגיע החורף', 'העלים התחילו להצהיב אחד אחרי השני.'), s('payoff', 'הוא חי מייחור אחד', 'ענף אחד במים הציל את כל הצמח.')] },
  'what-happened': { subject: { a: 'הפיקוס' }, slides: [s('then', 'פעם הוא היה בכל סלון', 'הצמח הכי נמכר במשתלות.'), s('turn', 'ואז הוא התחיל להשיר עלים', 'כל הזזה של העציץ הרגיזה אותו.'), s('turn', 'אנשים עברו לצמחים קלים יותר', 'הוא דורש מקום קבוע ואור יציב.'), s('now', 'היום הוא חוזר', 'בעיקר במשרדים עם חלונות גדולים.')] },
  'on-this-day': { subject: { date: '14 באוקטובר 2019' }, slides: [s('context', 'גג ריק בלב העיר', 'אף אחד לא חשב שיצמח שם משהו.'), s('moment', 'שלושים עציצים ביום אחד', 'השכנים עלו עם שתילים וכלים.'), s('moment', 'הגינה נפתחה לכולם', 'כל אחד קיבל ערוגה משלו.'), s('after', 'היום יש שם גינה קבועה', 'והיא מספקת ירק לכל הבניין.')] },
  'guess-who': { subject: { answer: 'אלוורה' }, slides: [s('clue', 'אני שורד חודש בלי מים', 'העלים שלי שומרים את המים בפנים.'), s('clue', 'יש לי שוליים קוצניים', 'אבל אני לא קקטוס.'), s('clue', 'ג׳ל מהעלים שלי מרגיע כוויות', 'הרבה בתים מחזיקים אותי במטבח.'), s('reveal', 'אלוורה', 'סוקולנט שצריך מעט מאוד מים.')] },
  'head-to-head': { subject: { a: 'נענע', b: 'בזיליקום' }, slides: [s('stat', 'שעות שמש ביום', 'בזיליקום צריך יותר.', ['f1'], { a: '4', b: '6' }), s('stat', 'רוחב העציץ', 'נענע צריכה עציץ משלה.', ['f1'], { a: '25', b: '15' }), s('stat', 'קור בלילה', 'נענע שורדת כפור.', ['f1'], { a: 'כפור', b: '10°' }), s('stat', 'כמה שנים', 'נענע חוזרת כל אביב.', ['f1'], { a: 'שנים', b: 'עונה' }), s('verdict', 'שמש של בוקר? נענע', 'פחות שמש ופחות רגישות לקור.', [])] },
  ranking: { slides: [s('ranks', 'ועוד חמישה שכמעט נכנסו', 'פוטוס\nזמיה\nסנסיווריה\nקקטוס\nאלוורה'), s('rank', 'פילודנדרון', '14 ימים בין השקיות.'), s('rank', 'מונסטרה', '18 ימים.'), s('rank', 'ספטיפיליום', '21 ימים.'), s('rank', 'זמיוקולקס', '30 ימים.'), s('rank', 'קקטוס', '45 ימים.')] },
  iceberg: { slides: [s('layer', 'כולם יודעים', 'בזיליקום אוהב שמש\nצריך להשקות'), s('layer', 'קצת פחות', 'קוטפים מלמעלה'), s('layer', 'מעטים יודעים', 'פרחים מרים את העלים'), s('layer', 'כמעט אף אחד', 'הוא קרוב משפחה של הנענע')] },
  'hot-take': { slides: [s('case', 'רוב הצמחים מתים מהשקיה', 'שורשים ספוגים נרקבים.'), s('case', 'אדמה יבשה זה לא סימן לצמא', 'השכבה העליונה מתייבשת ראשונה.'), s('case', 'עציץ בלי חור זו מלכודת', 'המים לא יוצאים.'), s('ask', 'פחות מים, יותר צמחים', 'מסכימים?', [])] },
  'myth-fact': { slides: [s('myth', 'צריך להשקות כל יום', '', []), s('fact', 'רוב צמחי הבית רוצים אדמה שמתייבשת', 'בודקים עם האצבע לפני.'), s('myth', 'צמחים לא אוהבים לדבר איתם', '', []), s('fact', 'מה שעוזר זה אור, לא שיחה', 'חלון מזרחי עושה את העבודה.')] },
  'do-dont': { slides: [
    s('rule', 'תכתבו את המידה בתוך השדה', 'כשרואים איך התשובה נראית, ממלאים נכון.', ['f1'], { visual: { type: 'dodont', title: 'הזמנת עציץ', a: '', b: '', style: 'app', items: [{ label: 'field', value: 'המידה שלכם...', value2: 'XX ס"מ', sub: 'קוטר העציץ' }, { label: 'button', value: '#2F6BFF הזמנה', value2: '#2F6BFF הזמנה', sub: '' }] } }),
    s('rule', 'כותרת לכל קבוצה של שדות', 'העין מוצאת מהר מה שייך למה.', ['f1'], { visual: { type: 'dodont', title: '', a: '', b: '', style: 'app', items: [{ label: 'heading', value: '', value2: 'פרטי משלוח', sub: '' }, { label: 'field', value: '', value2: '', sub: 'כתובת' }, { label: 'field', value: '', value2: '', sub: 'עיר' }] } }),
    s('rule', 'הלוגו בפינה, לא באמצע', 'שם מחפשים אותו.', ['f1'], { visual: { type: 'dodont', title: 'דף הבית', a: '', b: '', style: 'web', items: [{ label: 'nav', value: 'center', value2: 'start', sub: '' }, { label: 'heading', value: 'צמחים לבית', value2: 'צמחים לבית', sub: '' }] } }),
    s('rule', 'טקסט כהה על רקע בהיר', 'טקסט אפור בהיר קשה לקרוא בשמש.', ['f1'], { visual: { type: 'dodont', title: '', a: '', b: '', style: 'app', items: [{ label: 'text', value: '#B8BEC6 משלוח חינם מעל שני עציצים', value2: '#1B1F24 משלוח חינם מעל שני עציצים', sub: '' }] } }),
  ] },
  meme: { slides: [s('joke', 'כשקונים צמח רביעי', 'כי השלישי לא שרד את החורף', []), s('joke', 'כשהשכן שואל איך הצמחים', 'מצוין, בעיקר המתים', []), s('joke', 'כשהעלה הראשון מצהיב', 'מתחילים לחפש מטפל לצמחים', []), s('truth', 'רוב הצמחים מתים מעודף מים', 'לא מחוסר אהבה.')] },
  facts: { slides: [s('fact', 'פוטוס שורד 81 יום בלי מים במשרד סגור', ''), s('fact', 'בזיליקום במרפסת צריך 6 שעות שמש ביום', ''), s('fact', 'קקטוס אחד בגינה חי כבר 40 שנה בלי השקיה בקיץ', ''), s('fact', 'נענע בעציץ משתלטת על כל הגינה תוך עונה', '')] },
  tips: { slides: [s('tip', 'השקיה לעומק פעם בשבוע', 'משקים עד שהמים יוצאים מהחור למטה, ומחכים שהשכבה העליונה תתייבש לגמרי.'), s('tip', 'עציץ עם חור בתחתית', 'בלי חור המים נשארים בשורשים והם נרקבים תוך שבועיים.'), s('tip', 'דשן אחרי הפריחה', 'מוסיפים דשן נוזלי פעם בחודש מהאביב ועד סוף הקיץ.'), s('tip', 'מסובבים את העציץ פעם בשבוע', 'כך הצמח גדל ישר ולא נוטה לכיוון החלון.')] },
  'owner-story': { slides: [s('moment', 'קניתי 200 עציצים לפני שבדקתי מה נמכר', ''), s('moment', 'מכרנו ב-100 אלף שקל ועדיין הפסדנו', ''), s('moment', 'המשלוח הראשון הגיע שבור לגמרי', 'ושילמתי עליו פעמיים'), s('moment', 'הלקוחה הראשונה חזרה אחרי שבוע עם חברה', ''), s('lesson', 'תבדקו מה נמכר לפני שקונים מלאי', '', [])] },
};

test('every kind has a 5 to 8 slide shape, and the samples pass it', () => {
  assert.equal(Object.keys(KINDS).filter((k) => k !== 'list').length, 14);
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const f = fmt(kind);
    const [lo, hi] = contentRange(f);
    assert.ok(lo + 1 >= 5 && hi + 1 <= 8, `${kind}: ${lo + 1} to ${hi + 1} slides with the cover`);
    assert.deepEqual(shapeProblems(f, sample.slides.map((x) => x.role)), [], kind);
    // A countdown's cover is its count and its subject.
    const counted = { facts: 'fact', tips: 'tip' }[kind];
    const post = { hook: counted ? `${sample.slides.filter((x) => x.role === counted).length} דברים שלא ידעתם על צמחים` : 'שער', sub: '', subject: { a: '', b: '', answer: '', date: '', ...(sample.subject || {}) }, slides: sample.slides, caption: '', captionShort: '', keywords: [] };
    assert.deepEqual(kindProblems(f, post), [], kind);
  }
});

test('the kinds that spread: one short line a slide, the count on the cover kept, and every slide on its own photograph', () => {
  const long = { hook: '4 דברים שלא ידעתם על צמחים', sub: '', subject: {}, slides: [...SAMPLES.facts.slides], caption: '', captionShort: '', keywords: [] };
  assert.deepEqual(kindProblems(fmt('facts'), long), []);
  long.slides = [{ ...long.slides[0], title: 'פוטוס אחד שנשכח במשרד סגור שרד שם 81 יום בלי טיפת מים אחת עד שמישהו נזכר בו' }, ...long.slides.slice(1)];
  assert.match(kindProblems(fmt('facts'), long).join(' '), /slide 1: the title has 1\d words: 13 at most/);
  // A fact slide is its line alone: what a text under it says goes in the title.
  const under = { ...long, slides: [{ ...SAMPLES.facts.slides[0], body: 'במשרד סגור' }, ...SAMPLES.facts.slides.slice(1)] };
  assert.match(kindProblems(fmt('facts'), under).join(' '), /slide 1: a facts slide is its title alone/);
  assert.match(kindProblems(fmt('facts'), { ...long, slides: SAMPLES.facts.slides, hook: '7 דברים שלא ידעתם על צמחים' }).join(' '), /the cover promises 7 and the post has 4/);
  assert.equal(kindOf(fmt('facts')).photo, 'every');
  assert.ok(everyPhoto({ meta: {} }, fmt('owner-story')) && everyPhoto({ meta: { style: { name: 'E' } } }, fmt('story')) && !everyPhoto({ meta: {} }, fmt('story')));
  assert.ok(structureNumbers(fmt('facts'), SAMPLES.facts.slides).has('4'), "the count is the post's own, never a claim");
});

test('a shape out of order, too short or with a foreign role is refused, with a reason the model can use', () => {
  assert.match(shapeProblems(fmt('story'), ['beat', 'payoff', 'beat', 'beat'])[0], /out of order|needs/);
  assert.match(shapeProblems(fmt('guess-who'), ['clue', 'clue', 'reveal']).join(' '), /needs 4 to 5 content slides/);
  assert.match(shapeProblems(fmt('guess-who'), ['clue', 'clue', 'reveal', 'reveal']).join(' '), /"clue"/);
  assert.match(shapeProblems(fmt('head-to-head'), ['stat', 'stat', 'stat', 'stat', 'verdict', 'clue']).join(' '), /not part of/);
  assert.match(shapeProblems(fmt('myth-fact'), ['myth', 'fact', 'fact', 'myth']).join(' '), /alternate|out of order|in a row/);
  assert.match(shapeProblems(fmt('what-happened'), ['then', 'then', 'then', 'turn', 'now']).join(' '), /at most 2 "then"/);
  assert.match(shapeProblems(fmt('ranking'), ['rank', 'rank', 'rank', 'rank']).join(' '), /5 to 6|"rank"/);
});

test('the kind checks: a guess-who that gives the answer away, place numbers in a ranking, a myth with a number of its own', () => {
  const g = SAMPLES['guess-who'];
  const spoiled = kindProblems(fmt('guess-who'), { hook: 'תנחשו את הצמח', sub: '', subject: g.subject, slides: g.slides, caption: 'הפעם: האלוורה של סבתא', captionShort: '', keywords: [] });
  assert.match(spoiled.join(' '), /the captions gives the answer away/);
  const clue = kindProblems(fmt('guess-who'), { hook: 'x', sub: '', subject: g.subject, slides: [{ ...g.slides[0], body: 'כמו כל אלוורה' }, ...g.slides.slice(1)], caption: '', captionShort: '', keywords: [] });
  assert.match(clue.join(' '), /clue 1 gives the answer away/);
  const numbered = g.slides.map((x, i) => (i === 1 ? { ...x, title: `רמז 1: ${x.title}` } : x));
  assert.match(kindProblems(fmt('guess-who'), { hook: 'x', sub: '', subject: g.subject, slides: numbered, caption: '', captionShort: '', keywords: [] }).join(' '), /no clue numbers/);
  const clues = g.slides.filter((x) => x.role === 'clue').length;
  const count = (hook) => kindProblems(fmt('guess-who'), { hook, sub: '', subject: g.subject, slides: g.slides, caption: '', captionShort: '', keywords: [] }).join(' ');
  assert.match(count(`תנחשו לפי ${clues + 1} רמזים`), /promises \d clues/, 'a cover that promises another count of clues');
  assert.doesNotMatch(count(`תנחשו לפי ${clues} רמזים`), /promises/);
  assert.match(count('תנחשו לפי חמישה רמזים'), /promises 5 clues/);
  const r = SAMPLES.ranking.slides.map((x, i) => (i === 5 ? { ...x, body: 'מקום ראשון: חודש וחצי.' } : x));
  assert.match(kindProblems(fmt('ranking'), { slides: r, subject: {} }).join(' '), /no place numbers/);
  const bad = SAMPLES.ranking.slides.map((x, i) => (i === 0 ? { ...x, body: 'פוטוס\nזמיה' } : x));
  assert.match(kindProblems(fmt('ranking'), { slides: bad, subject: {} }).join(' '), /exactly five lines/);
  const myth = SAMPLES['myth-fact'].slides.map((x, i) => (i === 0 ? { ...x, title: 'צריך להשקות 3 פעמים ביום' } : x));
  assert.match(kindProblems(fmt('myth-fact'), { slides: myth, subject: {} }).join(' '), /the myth states 3/);
  assert.match(kindProblems(fmt('head-to-head'), { slides: [s('stat', 'x', '', ['f1'], { a: '4', b: '' })], subject: { a: 'א', b: 'ב' } }).join(' '), /needs both values/);
  assert.match(kindProblems(fmt('on-this-day'), { slides: SAMPLES['on-this-day'].slides, subject: { date: '14 באוקטובר' } }).join(' '), /year/);
});

test("a post's structure is not a claim: a top 10, 3 clues; the design numbers the places", () => {
  assert.ok(structureNumbers(fmt('ranking'), SAMPLES.ranking.slides).has('10'));
  assert.ok(structureNumbers(fmt('guess-who'), SAMPLES['guess-who'].slides).has('3'));
  assert.deepEqual(ranksOf(SAMPLES.ranking.slides), [[10, 9, 8, 7, 6], 5, 4, 3, 2, 1]);
  const places = slidePlaces([{ kind: 'cover' }, ...SAMPLES['guess-who'].slides]);
  assert.deepEqual(places.slice(1).map((p) => [p.n, p.clues, p.isLast]), [[1, 3, false], [2, 3, false], [3, 3, false], [1, 3, true]]);
});

test('the gate: a verdict or a myth needs no fact, but every number on it is still quoted; both values of a stat are checked', () => {
  const facts = [{ key: 'f1', quote: 'basil needs at least 6 hours of direct sun a day, while mint does well with 4 hours', verified: true }];
  const draft = (slides, extra = {}) => ({ hook: 'נענע או בזיליקום', sub: '', caption: '', captionIg: '', keywords: [], subject: { a: 'נענע', b: 'בזיליקום' }, cta: null, slides: [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }, ...slides], ...extra });
  const h2h = fmt('head-to-head');
  const ok = [s('stat', 'שעות שמש', '', ['f1'], { a: '4', b: '6' }), s('verdict', 'נענע', 'פחות שמש', [])];
  assert.deepEqual(gateDraft(h2h, draft(ok), facts).problems, []);
  const wrongValue = [s('stat', 'שעות שמש', '', ['f1'], { a: '4', b: '8' }), s('verdict', 'נענע', '', [])];
  assert.match(gateDraft(h2h, draft(wrongValue), facts).problems.join(' '), /the number 8/);
  const verdictNumber = [s('stat', 'שעות שמש', '', ['f1'], { a: '4', b: '6' }), s('verdict', 'נענע ב-3 מתוך 4', '', [])];
  assert.match(gateDraft(h2h, draft(verdictNumber), facts).problems.join(' '), /the number 3/);
  const noFact = [s('stat', 'שעות שמש', '', [], { a: '4', b: '6' }), s('verdict', 'נענע', '', [])];
  assert.match(gateDraft(h2h, draft(noFact), facts).problems.join(' '), /states no sourced fact/);
  // The keywords and the date are on the cover: their numbers are held to the quotes too.
  assert.match(gateDraft(h2h, draft(ok, { keywords: ['basil 2024'] }), facts).problems.join(' '), /the cover: the number 2024/);
});

test("a phase 1 post's token does not change: the new fields count only when present", () => {
  const slides = [{ kind: 'cover', title: '', body: '', factKeys: [] }, { kind: 'item', role: 'item', title: 'a', body: 'b', factKeys: ['f1'] }];
  const before = tokenOf({ slides: slides.map(({ role, ...x }) => x), caption: 'c', hook: 'h', sub: '' });
  assert.equal(tokenOf({ slides, caption: 'c', hook: 'h', sub: '', extra: { captionIg: '', keywords: [], subject: {}, cta: '' } }), before);
  assert.notEqual(tokenOf({ slides, caption: 'c', hook: 'h', sub: '', extra: { keywords: ['x'] } }), before);
});

test("a group's documents are always numbered the same way, whatever order they were read in", () => {
  const docs = [
    { id: 9, key: 'mint-2', group_key: 'mint' },
    { id: 4, key: 'pothos' },
    { id: 7, key: 'mint-1', group_key: 'mint' },
  ];
  const c = candidatesOf(docs).find((x) => x.key === 'mint');
  assert.deepEqual(c.docs.map((d) => d.key), ['mint-1', 'mint-2']);
  assert.deepEqual(candidatesOf(docs.slice().reverse()).find((x) => x.key === 'mint').docs.map((d) => d.key), ['mint-1', 'mint-2']);
});

test('facts that fail verification take their slides with them, by the rules of the kind', () => {
  const good = new Set(['f1', 'f3']);
  const mf = keepItems(fmt('myth-fact'), [{ role: 'myth', facts: [] }, { role: 'fact', facts: ['f1'] }, { role: 'myth', facts: [] }, { role: 'fact', facts: ['f2'] }, { role: 'myth', facts: [] }, { role: 'fact', facts: ['f3'] }], good);
  assert.deepEqual(mf.map((x) => x.role), ['myth', 'fact', 'myth', 'fact'], 'a myth goes with its fact');
  const h = keepItems(fmt('head-to-head'), [{ role: 'stat', facts: ['f2'] }, { role: 'stat', facts: ['f1'] }, { role: 'verdict', facts: [] }], good);
  assert.deepEqual(h.map((x) => x.role), ['stat', 'verdict'], 'a verdict carries no fact and stays');
  const r = keepItems(fmt('ranking'), [{ role: 'rank', facts: ['f1'] }, { role: 'rank', facts: ['f2'] }], good);
  assert.equal(r.length, 1, 'a ranking that loses a place is short, and its shape check refuses it');
});

test('an on-this-day document is one that names the day, in any of the ways sources write a date', () => {
  const day = '2026-10-27';
  assert.ok(mentionsDay('Israel and Austria drew on 27 October 2001 in Ramat Gan', day));
  assert.ok(mentionsDay('The game was played on October 27, 2001.', day));
  assert.ok(mentionsDay('ב-27 באוקטובר 2001 שיחקה ישראל מול אוסטריה', day));
  assert.ok(mentionsDay('27/10/2001 Austria Home 1-1 World Cup 2002 Qualifying', day));
  assert.ok(mentionsDay('date: 2001-10-27T00:00:00Z', day));
  assert.ok(!mentionsDay('27 November 2001, and 7 October', day), 'another month is another day');
  assert.ok(!mentionsDay('On 127 October nothing happened', day));
  assert.ok(!mentionsDay('anything', 'not a date'));
});

test('the demo pack builds a post of every kind through the real pipeline, offline', { timeout: 300_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    ctx.mediaDir = path.join(home, 'media');
    const pack = ctx.pack('demo');
    const byKind = {};
    for (const f of pack.formats.formats) if (f.kind) byKind[f.kind] = f.id;
    assert.equal(Object.keys(byKind).length, 11, 'the demo has a format of every kind');
    for (const [kind, formatKey] of Object.entries(byKind)) {
      const res = await buildPost(ctx, { pack, formatKey, day: kind === 'on-this-day' ? '2026-10-14' : null });
      assert.equal(res.status, 'queued', `${kind}: ${res.reason}`);
      const post = loadPost(db, res.postId);
      assert.equal(post.kind, kind);
      const n = post.slides.length;
      assert.ok(n >= 5 && n <= 8, `${kind}: ${n} slides`);
      // TikTok's caption is one short line by default (captionStyleOf); Instagram's is led by the cover line.
      assert.ok(post.caption.length >= 15 && post.caption.split('\n').filter(Boolean).length <= 2 && post.caption_ig?.startsWith(post.hook.replace(/\s*\n\s*/g, ' ')), `${kind}: two captions, the Instagram one led by the cover line`);
      assert.ok(post.hook_pattern && post.data.cta?.text, `${kind}: a cover pattern and a call to action`);
      for (const p of ['tiktok', 'instagram']) assert.equal(post.media[p].length, n, `${kind}: every slide on ${p}`);
    }
  } finally {
    cleanup();
  }
});

test('a post of every kind renders on both platforms, nothing cut, in its own template', { timeout: 240_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const dir = copyPack(home, 'demo');
    const pack = loadPack(dir);
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      const format = fmt(kind);
      const slides = [{ kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] }, ...sample.slides.map((x) => ({ ...x, sources: ['ספריית הצמחים לדוגמה'] }))];
      const extra = { captionIg: '', keywords: ['צמחי בית', 'houseplants'], subject: { a: '', b: '', answer: '', date: '', ...(sample.subject || {}) }, cta: 'שמרו לפני ההשקיה הבאה' };
      const post = { id: `t-${kind}`, hook: kind === 'hot-take' ? 'רוב הצמחים מתים מאהבה' : 'שער לבדיקה של הסוג הזה', sub: 'שורה שנייה', caption: 'c', extra, ctaKind: 'save' };
      post.token = tokenOf({ slides, caption: post.caption, hook: post.hook, sub: post.sub, extra });
      const files = await renderPost({ pack, format, post, slides, photoOn: KINDS[kind].photo, outDir: path.join(home, 'media', kind) });
      for (const platform of ['tiktok', 'instagram']) {
        assert.equal(files[platform].length, slides.length, `${kind} ${platform}`);
        for (const f of files[platform]) assert.ok(existsSync(f));
      }
    }
  } finally {
    cleanup();
  }
});

test('the review is told which slides make no claim of their own: a myth is not the post saying it', () => {
  const m = SAMPLES['myth-fact'];
  const texts = textsOf({ hook: 'כן או לא', sub: '', slides: [{ kind: 'cover', title: '', body: '' }, ...m.slides], caption: 'c', captionShort: '' });
  const user = reviewUser({ meta: { displayName: 'דמו' }, voice: '# קול\n\n## מי מדבר\n\nגנן.' }, texts, []);
  assert.match(user, /\(slide 1 title: a myth as people say it, corrected on the next slide\) צריך להשקות כל יום/);
  assert.doesNotMatch(user, /\(slide 2 title: a myth/);
});

test("a slide names the article it was sourced from, except a guess-who's clue, whose article is the answer", () => {
  const db = { get: () => ({ name: 'English Wikipedia: houseplants', config_json: JSON.stringify({ api: { kind: 'wikipedia' } }), title: 'Aloe vera' }) };
  assert.equal(sourceLabel(db, { document_id: 1, source_id: 1 }), 'ויקיפדיה: Aloe vera');
  assert.equal(sourceLabel(db, { document_id: 1, source_id: 1 }, { article: false }), 'ויקיפדיה');
  const other = { get: () => ({ name: 'משרד החקלאות', config_json: '{}', title: 'x' }) };
  assert.equal(sourceLabel(other, { document_id: 1, source_id: 1 }, { article: false }), 'משרד החקלאות');
});

test("a headline in a face with hard-to-read digits takes its digits from another face, at the same weights", () => {
  assert.equal(headlineFamily('Heebo'), "'Heebo'");
  assert.equal(headlineFaces('Heebo'), '');
  assert.equal(headlineFamily('Karantina'), "'Karantina Headline'");
  const css = headlineFaces('Karantina');
  // One letters face and one digits face per weight: the browser picks a weight before a range.
  for (const w of ['400', '700']) {
    assert.ok(css.includes(`font-weight:${w};font-style:normal;font-display:block;unicode-range:U+0000-002F,U+003A-10FFFF;`), `letters at ${w}`);
    assert.ok(css.includes(`font-weight:${w};font-style:normal;font-display:block;unicode-range:U+0030-0039;size-adjust:`), `digits at ${w}`);
  }
});

test('mixed Hebrew lines: a Latin run stops at the end of a sentence, and a title opening with its number draws it once', () => {
  assert.equal(he('ל-Gnrgy. 450,000 דולר'), 'ל-<bdi>Gnrgy</bdi>. 450,000 דולר');
  assert.equal(he('ב-UFC 193 היא ניצחה'), 'ב-<bdi>UFC 193</bdi> היא ניצחה');
  assert.equal(he('monday.com הודיעה'), '<bdi>monday.com</bdi> הודיעה');
  assert.equal(he('הריצו npx frugon --demo ותראו'), 'הריצו <bdi>npx frugon --demo</bdi> ותראו', "a command's flags stay with it");
  assert.equal(he('ב-Pro זה יותר'), 'ב-<bdi>Pro</bdi> זה יותר', 'a Hebrew prefix keeps its dash');
  assert.equal(he('הם כתבו: Define success first, then iterate. Be specific.'), 'הם כתבו: <bdi>Define success first, then iterate. Be specific</bdi>.', 'an English sentence quoted in a Hebrew line is one run');
  assert.equal(he('הקלידו /clear ו-/usage'), 'הקלידו <bdi>/clear</bdi> ו-<bdi>/usage</bdi>', 'a slash command keeps its slash');
  assert.equal(he('לפי Équipe ו-Modrić'), 'לפי <bdi>Équipe</bdi> ו-<bdi>Modrić</bdi>', "accented letters are Latin: L'Équipe came out reversed");
  assert.equal(he("L'Équipe"), '<bdi>L&#39;Équipe</bdi>', 'an apostrophe inside a name stays in it');
  assert.deepEqual(splitLead('7,703 שקל בחודש'), { lead: { value: '7,703', pre: '', post: '' }, rest: 'שקל בחודש' });
  assert.deepEqual(splitLead('עד 7,703 שקל'), { lead: null, rest: 'עד 7,703 שקל' });
});

test('a niche hashtag goes on a post that names it, as whole words, not as letters inside another word', () => {
  const pack = { formats: { hashtags: { broad: ['#גינון'], niche: ['#מנטה', '#גינהבמרפסת'] } } };
  const tags = (text) => hashtagsFor(pack, { hashtags: [] }, 's', text);
  assert.ok(tags('השתלנו מנטה בעציץ').includes('#מנטה'));
  assert.ok(tags('ריח של למנטה טרייה').includes('#מנטה'), 'a one-letter prefix');
  assert.ok(tags('גינה במרפסת קטנה').includes('#גינהבמרפסת'), 'words joined as a hashtag joins them');
  assert.ok(!tags('הדקורמנטה של הבית').includes('#מנטה'), 'letters inside another word');
});

test("the review sees each fact with the source's own words, so a summary that misread its quote is caught", () => {
  const texts = textsOf({ hook: 'h', sub: '', slides: [{ kind: 'cover', title: '', body: '' }], caption: 'c', captionShort: '' });
  const user = reviewUser({ meta: { displayName: 'דמו' }, voice: '# קול\n\n## מי מדבר\n\nגנן.' }, texts, [{ claim: 'הבזיליקום אוהב צל', quote: 'Basil needs full sun' }]);
  assert.match(user, /- הבזיליקום אוהב צל \(source: "Basil needs full sun"\)/);
});

test("a ranking's places follow the number that ranks them", () => {
  const rank = (name, n) => ({ kind: 'item', role: 'rank', title: name, body: `${n} ניצחונות ברצף, 2006 עד 2012.`, factKeys: ['f1'] });
  const post = (ns) => ({ hook: 'x', sub: '', subject: {}, slides: ns.map((n, i) => rank(['אלף', 'בית', 'גימל', 'דלת', 'הא'][i], n)), caption: '', captionShort: '', keywords: [] });
  assert.match(kindProblems(fmt('ranking'), post([13, 14, 15, 16, 14])).join(' '), /does not follow its number/);
  assert.doesNotMatch(kindProblems(fmt('ranking'), post([13, 14, 15, 16, 16])).join(' '), /does not follow/);
  assert.doesNotMatch(kindProblems(fmt('ranking'), post([20, 15, 12, 9, 7])).join(' '), /does not follow/, 'a fastest-first ranking falls');
  // A year is not the number that ranks a place, and a place drawn without the graphic the others have is missing it.
  const p = post([13, 14, 15, 16, 17]);
  p.slides[4].body = 'היחיד שעשה את זה פעמיים, ב-2022 וב-2026.';
  assert.match(kindProblems(fmt('ranking'), p).join(' '), /slide 5: a rank slide states the number/);
  const drawn = post([13, 14, 15, 16, 17]);
  drawn.slides.slice(0, 4).forEach((s, i) => (s.visual = { type: 'stat', items: [{ label: 'שערים', value: `כ-${13 + i} שערים` }] }));
  assert.match(kindProblems(fmt('ranking'), drawn).join(' '), /slide 5: the other places show their number as a graphic/);
  drawn.slides[4].visual = { type: 'stat', items: [{ label: 'שערים', value: '17' }] };
  assert.doesNotMatch(kindProblems(fmt('ranking'), drawn).join(' '), /slide \d: /);
});

test('a head-to-head of two people needs both faces, and a matchup refused for one is not offered again', () => {
  const pack = (coverPhoto, providers = ['commons']) => ({ theme: { options: { coverPhoto } }, meta: { imagery: { providers } } });
  const outline = { imageQuery: 'Erling Haaland', imageQueryB: 'Kylian Mbappé' };
  assert.equal(needsSides(pack(true), fmt('head-to-head'), outline), true);
  assert.equal(needsSides(pack(false), fmt('head-to-head'), outline), false, 'an account without cover photographs draws its own art');
  assert.equal(needsSides(pack(true, []), fmt('head-to-head'), outline), false);
  assert.equal(needsSides(pack(true), fmt('head-to-head'), { imageQuery: 'Ciryl Gane', imageQueryB: '' }), true, 'one side left unnamed is no way around the two faces');
  assert.equal(needsSides(pack(true), fmt('ranking'), outline), false);
  const user = outlineUser(fmt('head-to-head'), [{ ref: 'D1', title: 't', url: 'u', text: 'x' }], { faceless: ['וולקנובסקי / אבלויב'] });
  assert.ok(user.includes('no licensed photograph of one side') && user.includes('וולקנובסקי / אבלויב'));
});

test('a ranking of amounts in millions and billions is ordered by the amount, not by the bare number', () => {
  const rank = (body) => ({ role: 'rank', title: 'x', body, visual: null });
  const post = (bodies) => ({ hook: 'h', sub: '', slides: bodies.map(rank) });
  const ok = post(['450 מיליון דולר.', '650 מיליון דולר.', '6.5 מיליארד דולר.', '14.8 מיליארד דולר.', '32 מיליארד דולר.']);
  assert.ok(!kindProblems({ kind: 'ranking' }, ok).some((m) => /order/.test(m)), 'five deals that rise from 450 million to 32 billion');
  const wrong = post(['6.5 מיליארד', '650 מיליון', '14.8 מיליארד', '1,200 מיליון', '32 מיליארד']);
  assert.ok(kindProblems({ kind: 'ranking' }, wrong).some((m) => /order/.test(m)), '1,200 million is less than 14.8 billion');
});

test("a ranked amount is read with its scale wherever the graphic wrote it, so 8,200 million ranks above 25 million", () => {
  const g = (value, sub = '', title = '', label = 'שווי') => ({ role: 'rank', title: 'x', body: 'שורה.', visual: { type: 'stat', title, items: [{ label, value, value2: '', sub }] } });
  assert.equal(rankAmount(g('8,200', 'מיליון דולר')), 8.2e9, 'the scale in the line under the number');
  assert.equal(rankAmount(g('25 מיליון')), 25e6);
  assert.equal(rankAmount(g('$8.2B')), 8.2e9);
  assert.equal(rankAmount(g('8,200', '', 'שווי במיליוני דולרים')), 8.2e9, 'the scale once, in the graphic\'s title');
  assert.equal(rankAmount(g('40', '', 'Plan B')), 40, 'a letter without its dollar sign or brackets is not read as a scale');
  assert.equal(rankAmount(g('40', '', 'Valuation ($B)')), 40e9);
  assert.equal(rankAmount(g('14', 'ניצחונות')), 14, 'a count with no scale stays a count');
  assert.equal(rankAmount({ role: 'rank', title: 'x', body: '6.5 מיליארד דולר.', visual: null }), 6.5e9);
  // The AI companies: 25 million, 300 million, 1.5 billion, 8,200 million, 80 billion rise from 5th to 1st.
  const post = { hook: 'h', sub: '', subject: {}, slides: [g('25 מיליון'), g('300 מיליון'), g('1.5 מיליארד'), g('8,200', 'מיליון $'), g('80 מיליארד')] };
  assert.ok(!kindProblems({ kind: 'ranking' }, post).some((m) => /order/.test(m)));
  post.slides[3] = g('8,200', 'דולר');
  assert.ok(kindProblems({ kind: 'ranking' }, post).some((m) => /order/.test(m)), 'a bare 8,200 dollars still breaks the order');
});

test('the writer of a ranking is told the rank-slide rules before anything else', () => {
  const outline = { topic: 't', items: [{ role: 'rank', point: 'p', facts: [] }] };
  const user = slidesUser({ format: fmt('ranking'), n: 5, outline, facts: [], pack: null });
  const lines = user.split('\n');
  assert.match(lines[1], /^RANK SLIDES: .*"stat" visual whose value is that number.*same unit/);
  const plain = slidesUser({ format: fmt('ranking'), n: 5, outline, facts: [], pack: { theme: { visuals: ['bars'] } } });
  assert.match(plain, /RANK SLIDES: .*in its body/);
  assert.doesNotMatch(plain, /"stat" visual/, 'an account without the stat graphic is not told to draw one');
  assert.doesNotMatch(slidesUser({ format: fmt('head-to-head'), n: 3, outline, facts: [], pack: null }), /RANK SLIDES/);
});

test('a head-to-head stat needs a value for each side in its quotes, and the outline is told so first', () => {
  const f = (key, quote, verified = true) => ({ key, quote, verified });
  const outline = { subject: { a: 'אוליביירה', b: 'חביב' }, imageQuery: 'Charles Oliveira', imageQueryB: 'Khabib Nurmagomedov' };
  // The Oliveira against Khabib post: its documents held Oliveira's numbers and never Khabib's.
  const oneSide = [f('f1', 'Oliveira holds the record for most submission wins in UFC history, with 16.'), f('f2', 'Charles Oliveira is 34-10 with one no contest.'), f('f3', 'Khabib Nurmagomedov retired unbeaten.', false)];
  assert.equal(bothSides({ facts: ['f1'] }, oneSide, outline), false, 'the documents never name Khabib in a verified quote');
  assert.equal(bothSides({ facts: ['f1', 'f2'] }, oneSide, outline), false);
  const both = [...oneSide, f('f4', 'Khabib Nurmagomedov retired with a record of 29-0.'), f('f5', 'Khabib defended the belt three times.')];
  assert.equal(bothSides({ facts: ['f2', 'f4'] }, both, outline), true, 'two records, one a side');
  assert.equal(bothSides({ facts: ['f1'] }, both, outline), false, "Oliveira's submissions alone");
  assert.equal(bothSides({ facts: ['f1', 'f5'] }, both, outline), true);
  // Names the quotes do not use (Hebrew names over English quotes) cannot tell: the stat stands.
  const herbs = [f('f1', 'mint likes soil that stays moist, and basil wants the top 2 cm of soil to dry before watering')];
  assert.equal(bothSides({ facts: ['f1'] }, herbs, { subject: { a: 'נענע', b: 'בזיליקום' } }), true);
  const user = outlineUser(fmt('head-to-head'), [{ ref: 'D1', title: 't', url: 'u', text: 'x' }]);
  assert.match(user, /BOTH SIDES: .*at least 3 of the same stats.*"usable": false/);
  assert.doesNotMatch(outlineUser(fmt('ranking'), [{ ref: 'D1', title: 't', url: 'u', text: 'x' }]), /BOTH SIDES/);
});
