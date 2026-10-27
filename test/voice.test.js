import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPack } from '../src/packs/load.js';
import { limitsFor, postTells, softTellsIn, tellsIn } from '../src/voice/tells.js';
import { packBlock, rewritePrompt, slidesPrompt, slidesUser } from '../src/pipeline/prompts.js';
import { experienceIn, fakeProofIn, badgeNextTo } from '../src/voice/honesty.js';
import { BLOCK_AT, heuristicReview, hintsFor, REWRITE_AT, reviewUser } from '../src/voice/review.js';
import { blockedQuery, checkRules } from '../src/rules/check.js';
import { commonsLicenseOk, imageCredit, namesIn, needsCredit, once } from '../src/images/index.js';
import { Db } from '../src/db/index.js';
import { DEMO } from './helpers.js';

const pack = readPack(DEMO);

test("the pack's own bad lines are caught and its good lines pass", () => {
  for (const line of pack.examples.bad) assert.ok(tellsIn(line, { kind: 'slideBody', extra: pack.rules.bannedPhrases }).length || experienceIn(line), `bad line passed: ${line}`);
  for (const line of pack.examples.good) assert.deepEqual(tellsIn(line, { kind: 'slideBody' }), [], `good line refused: ${line}`);
});

test('stock connectives, formal words, filler, exclamation marks and long dashes are tells', () => {
  const t = (s) => tellsIn(s, { kind: 'slideBody' }).map((x) => x.code);
  assert.ok(t('חשוב לציין שזה עובד').includes('phrase'));
  assert.ok(t('ניתן להשקות פעמיים').includes('phrase'));
  assert.ok(t('צמח מדהים לבית').includes('phrase'));
  assert.ok(t('תשקו עכשיו!').includes('register'));
  assert.ok(t('השקיה — פעם בשבוע').includes('structure'));
  assert.ok(t('ככה זה עובד...').includes('structure'));
  // One word in two scripts is a translation left half done; a Hebrew prefix before a Latin name is how it is written.
  assert.ok(t('חבib ניצח בסיבוב הרביעי').includes('language'));
  assert.ok(t('הוא בא מהקרב greco-רומית').includes('language'));
  assert.ok(!t('הרצנו את זה ב-Vercel עם ה-API של Claude').includes('language'));
  assert.ok(t('פרטים ב-www.example.com').includes('url'));
  assert.ok(t('הכול ב-example.com/sale עכשיו').includes('url'));
  // A company named for its domain is a name, not a link.
  assert.ok(!t('monday.com שינתה את השם שלה ב-2017').includes('url'));
  // A list of four short things is a tell; one score written the way fans read it is one thing.
  assert.ok(t('פוטוס, זמיה, קקטוס, אלוורה וסנסיווריה.').includes('structure'));
  assert.ok(!t('ב-23 במרץ 1988, בוולינגטון, ישראל 9, טייוואן 0.').includes('structure'));
  assert.ok(t('מכבי 5, הפועל 4, בית"ר 0, בני 1.').includes('structure'), 'four scores in a row are still a list');
  assert.ok(!t('באותה שנה, ב-14 בנובמבר, AI21 הוציאה את Wordtune Read, שמסכם אתרים וסרטונים.').includes('structure'), 'clauses around a long one are a sentence');
});

test('lengths fit the text: a long TikTok caption, a short Instagram one, a body of lines, a name as a title', () => {
  const codes = (s, kind) => tellsIn(s, { kind }).map((x) => x.code);
  const long = 'גוגל קנתה את וייז ב-2013, אחרי שנים שבהן המפה נבנתה מהנהגים עצמם ומהדיווחים שלהם בכביש. '.repeat(5);
  assert.ok(codes(long, 'caption').includes('length'), 'a phase 1 caption stays short');
  assert.ok(!codes(long, 'captionLong').includes('length'), 'the TikTok caption has room');
  assert.ok(!codes('פוטוס\nזמיה\nסנסיווריה\nקקטוס\nאלוורה', 'slideLines').includes('length'), 'five places are five lines, not five sentences');
  assert.ok(!codes('Fiverr', 'slideTitle').includes('language'), 'the answer of a guess-who is a name');
  assert.ok(codes('This is an English sentence on a slide.', 'slideBody').includes('language'));
});

test('the audience is addressed in the plural: a singular "you" is a tell', () => {
  assert.ok(tellsIn('אם אתה רוצה עציץ גדול', { kind: 'slideBody' }).some((x) => x.code === 'phrase'));
  assert.deepEqual(tellsIn('אם אתם רוצים עציץ גדול', { kind: 'slideBody' }), []);
});

test('no fake personal experience: a memory is refused, a planner conditional is not', () => {
  for (const s of ['ניסיתי את זה במרפסת', 'כשהייתי בגינה ראיתי את זה', 'היינו שם בקיץ', 'קניתי שתיל בסופר', 'מהניסיון שלי זה עובד']) assert.ok(experienceIn(s), s);
  for (const s of ['ככה היינו בונים את הרשימה', 'היינו ממליצים לבדוק את האדמה', 'תנסו את זה במרפסת']) assert.equal(experienceIn(s), null, s);
});

test('no fake badges or metrics about the account', () => {
  for (const s of ['כבר 50K עוקבים', 'אלפי צפיות בכל פוסט', 'חשבון רשמי ומאומת', 'החשבון #1 בטיקטוק']) assert.ok(fakeProofIn(s), s);
  assert.equal(fakeProofIn('בזיליקום צריך 6 שעות שמש'), null);
  assert.ok(badgeNextTo('עציץ ושמש ✅', 'עציץ ושמש'));
  assert.ok(checkRules({ pack, texts: [{ where: 'caption', text: 'כבר 10,000 עוקבים סומכים עלינו' }] }).some((p) => p.code === 'honesty:proof'));
});

test('the offline reviewer scores a bot-sounding text at the rewrite threshold or above', () => {
  const [bot, human] = heuristicReview(
    [
      { where: 'a', kind: 'slideBody', text: 'חשוב לציין שבזיליקום הוא צמח מדהים! בנוסף, ניתן לגדל אותו בקלות.' },
      { where: 'b', kind: 'slideBody', text: 'בזיליקום צריך לפחות 6 שעות שמש ביום. פחות מזה, והעלים נהיים קטנים.' },
    ],
    pack
  );
  assert.ok(bot.botScore >= REWRITE_AT, `bot scored ${bot.botScore}`);
  assert.ok(human.botScore < REWRITE_AT, `human scored ${human.botScore}`);
});

test('image licences: only public domain, CC0, CC BY and CC BY-SA from Commons', () => {
  for (const ok of ['CC0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 3.0', 'CC BY-SA 4.0']) assert.ok(commonsLicenseOk(ok), ok);
  for (const no of ['CC BY-NC 4.0', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', 'Fair use', '', 'All rights reserved']) assert.equal(commonsLicenseOk(no), false, no);
});

test('a photo whose licence asks for credit is credited in the caption, and others are not', () => {
  assert.ok(needsCredit('CC BY-SA 4.0') && needsCredit('CC BY 2.0'));
  assert.ok(!needsCredit('CC0') && !needsCredit('Public domain') && !needsCredit('Pexels License'));
  const db = new Db(':memory:');
  try {
    const at = new Date().toISOString();
    const by = db.insert('images', { provider: 'commons', license: 'CC BY-SA 4.0', author: 'A. Photographer', created_at: at });
    const free = db.insert('images', { provider: 'pexels', license: 'Pexels License', author: 'B', created_at: at });
    assert.equal(imageCredit(db, { slides: [{ image_id: by }] }), 'צילום: A. Photographer · CC BY-SA 4.0 · Wikimedia Commons');
    assert.equal(imageCredit(db, { slides: [{ image_id: free }] }), '');
    assert.equal(imageCredit(db, { slides: [{ image_id: null }] }), '');
  } finally {
    db.close();
  }
});

test("a photo found for a person names that person, not just a word of the name", () => {
  assert.ok(!namesIn('File:Rudder_Rock,_Steep_Holm_Island.jpg', ['Holly', 'Holm']), 'a rock on Steep Holm is not Holly Holm');
  assert.ok(!namesIn('File:Senecio_serra_-_tall_ragwort.jpg', ['Matt', 'Serra', 'Georges', 'St-Pierre']), 'a plant is not Matt Serra');
  assert.ok(!namesIn('File:Holly_with_very_unevenly_distributed_berries,_Holm_Hill.jpg', ['Holly', 'Holm']), 'both words, apart, are not the name');
  assert.ok(namesIn('File:Georges_St-Pierre_2014.jpg', ['Matt', 'Serra', 'Georges', 'St-Pierre']), 'either person in the query');
  assert.ok(namesIn('File:Holly_Holm_at_UFC_Fight_Night.jpg', ['Holly', 'Holm']));
  assert.ok(namesIn('File:Khabib_nurmagomedov_interview_2022.jpg', ['Khabib', 'Nurmagomedov', 'Gaethje']));
  assert.ok(namesIn('Pele.jpg', ['Pele']), 'a query with one name needs that one');
});

test('a pack refuses a word in an image query, not the same letters inside a name', () => {
  const pack = { rules: { imageQueryBlock: ['ko', 'cut', 'belt', 'stock chart'] } };
  assert.equal(blockedQuery(pack, 'Valentina Shevchenko'), null);
  assert.equal(blockedQuery(pack, 'Alexandr Cutelaba'), null);
  assert.equal(blockedQuery(pack, 'Ngannou KO'), 'ko');
  assert.equal(blockedQuery(pack, 'title belts UFC'), 'belt');
  assert.equal(blockedQuery(pack, 'a stock chart on a screen'), 'stock chart');
});

test("a photo's author is named once, even when the source's markup names them twice", () => {
  assert.equal(once('Unknown author Unknown author'), 'Unknown author');
  assert.equal(once('Airotcivss'), 'Airotcivss');
  assert.equal(once('Matt Lavin'), 'Matt Lavin');
});

test("an account can ask for shorter slides than the engine allows, never longer", () => {
  const pack = { meta: { writing: { slideBody: { maxChars: 150, sentences: 2 }, slideTitle: { maxChars: 90 } } } };
  assert.deepEqual([limitsFor('slideBody', pack).maxChars, limitsFor('slideBody', pack).sentences], [150, 2]);
  assert.equal(limitsFor('slideTitle', pack).maxChars, 60, 'a pack cannot raise a limit');
  const long = 'משפט ראשון קצר. משפט שני קצר. משפט שלישי קצר.';
  assert.ok(tellsIn(long, { kind: 'slideBody', pack }).some((t) => /3 sentences|sentences/.test(t.msg)), 'three sentences where the account allows two');
  assert.ok(!tellsIn(long, { kind: 'slideBody' }).some((t) => /sentences/.test(t.msg)), 'the engine alone allows three');
});

test('an account can ask for a short line under the cover and short, catchy captions', () => {
  const pack = { meta: { writing: { captionStyle: 'story', sub: { maxChars: 60, sentences: 1 }, captionLong: { minChars: 60, maxChars: 220 }, captionShort: { maxChars: 150 } } }, rules: {}, voice: '', formats: { formats: [{ id: 'x', kind: 'story', name: 'x', about: 'a', weight: 1, hooks: [{ id: 'h', pattern: 'p', examples: [] }], ctas: [] }] } };
  assert.deepEqual([limitsFor('sub', pack).maxChars, limitsFor('captionLong', pack).minChars, limitsFor('captionShort', pack).maxChars], [60, 60, 150]);
  assert.equal(limitsFor('captionLong').minChars, 200, "the engine's own minimum is TikTok's long caption");
  assert.equal(limitsFor('captionLong', { meta: { writing: { captionLong: { minChars: 400 } } } }).minChars, 200, 'a pack cannot raise the minimum');
  const sub = 'מפתח API בתוך הקוד זה הדבר הראשון ש-GitHub מחפשת. הנה מה שעושים עם זה, מההתחלה ועד הסוף.';
  assert.ok(tellsIn(sub, { kind: 'sub', pack }).some((t) => t.code === 'length'), 'a long explanation under the cover is refused');
  assert.ok(!tellsIn(sub, { kind: 'sub' }).some((t) => t.code === 'length'), 'the engine alone allows it');
  const system = packBlock(pack).text;
  assert.match(system, /60 to 220 characters: short and catchy/);
  assert.match(system, /up to 150 characters, one catchy line/);
  assert.match(packBlock({ ...pack, meta: { writing: { captionStyle: 'story' } } }).text, /200 to 600 characters/);
  // The default is the short caption: one line, the hook.
  assert.match(packBlock({ ...pack, meta: {} }).text, /the TikTok caption is short: story\.hook is ONE line/);
  const user = slidesUser({ format: { kind: 'story', name: 's' }, n: 4, outline: { topic: 't', items: [] }, facts: [], pack });
  assert.match(user, /SUB: the line under the cover is at most 60 characters/);
});

// The hebrew-voice guide, in code: what is always ad copy or machine text is refused; what usually is goes to the
// reviewer as a hint.
const codes = (s, kind = 'slideBody') => tellsIn(s, { kind }).map((x) => x.msg);
const refused = (s, kind) => codes(s, kind).length > 0;

test("the ad structures are refused: what it isn't, a chain of reassurances, a slogan's balance, fragments", () => {
  assert.ok(refused('זה לא עוד אתר, זה בית לעסק שלכם'));
  assert.ok(refused('הוא לא היה כוכב, הוא היה עובד'));
  assert.ok(refused('בלי התחייבות, בלי הפתעות ובלי אותיות קטנות'));
  assert.ok(refused('אין סיבה לחכות ואין מה להפסיד'));
  assert.ok(refused('פחות עבודה, יותר כסף'));
  assert.ok(refused('מהיר. קל. זול.'));
  assert.ok(refused('ארבעה סטודנטים מ-MIT. ארבע שנים. חברה ששווה מיליארדים.'));
  assert.ok(refused('הבזיליקום חזר לחיים. פשוט.'), 'one emphatic word as a sentence');
  // The same words, said as a sentence, pass.
  assert.ok(!refused('ארבעה סטודנטים מ-MIT בנו תוך ארבע שנים חברה ששווה מיליארדים.'));
  assert.ok(!refused('היא לא קיימת, ובכל זאת נכנסה למצעד של בילבורד.'));
  assert.ok(!refused('29 ניצחונות בלי הפסד אחד, ואז הוא פשוט פרש.'));
});

test('a heading has no colon and no label, but a score is a score', () => {
  assert.ok(refused('14 באוקטובר 2018: מרפסת אחת שינתה עיר', 'cover'));
  assert.ok(refused('ינואר: 6 שעות שמש', 'slideTitle'));
  assert.ok(refused('דעה לא פופולרית: רוב הצמחים מתים מאהבה', 'cover'));
  assert.ok(refused('עובדה: בזיליקום צריך 6 שעות שמש'), 'a label opener in a body too');
  assert.ok(!refused('0:3 במחצית, וליברפול עוד לקחה את הגביע', 'cover'));
  assert.ok(!refused('ב-14 באוקטובר 2018 מרפסת אחת שינתה עיר', 'cover'));
});

test('teasers, form Hebrew, translated Hebrew, ad words and engagement lines are refused', () => {
  // A cover may keep its number one for the last slide (COVER_GAP); a slide says its point.
  assert.ok(!refused('5 הצמחים שהכי פחות צריכים מים, והראשון מפתיע', 'cover'));
  assert.ok(refused('5 הצמחים שהכי פחות צריכים מים, והראשון מפתיע', 'slideTitle'));
  assert.ok(refused('לא תאמינו מה קרה לפיקוס', 'cover'), 'an empty teaser is refused on the cover too');
  assert.ok(refused('אנחנו הולכים על אבלויב, והנה למה', 'slideTitle'));
  assert.ok(refused('לא תאמינו מה קרה לפיקוס'));
  assert.ok(refused('במידה והעציץ יבש, משקים'));
  assert.ok(refused('יש לציין שהשתיל רגיש לקור'));
  assert.ok(refused('בסופו של יום, הכול תלוי באור'));
  assert.ok(refused('כשזה מגיע לבזיליקום, השמש קובעת'));
  assert.ok(refused('הכלי הזה הוא מהפכה של ממש'));
  assert.ok(refused('תייגו חבר שצריך את זה'));
  assert.ok(refused('את/ה מוזמנ/ת לנסות'));
  assert.ok(refused('מה???'));
  // A headline that holds back its point is fine as plain narration in a slide's body.
  assert.ok(refused('זו הסיבה שהוא פרש', 'cover'));
  assert.ok(!refused('הוא נפצע בברך. זו הסיבה שהוא פרש ב-2019.'));
});

test("quoted words are someone else's: a myth as people say it keeps its own shape", () => {
  assert.ok(!refused('"ב-MMA אין חוקים ואין שעון"', 'slideTitle'));
  assert.ok(refused('ב-MMA אין חוקים ואין שעון', 'slideTitle'));
  // Gershayim inside an abbreviation never open a quotation.
  assert.ok(refused('מכבי ת"א: לא עוד קבוצה רגילה', 'cover'));
});

test('what is usually a tell is a hint for the reviewer, never a refusal', () => {
  for (const [s, hint] of [
    ['השרך כבר לא בסלון, אלא בחדר האמבטיה.', /לא X אלא Y/],
    ['לפי Wix, Base44 נקנתה בכ-80 מיליון דולר.', /בערך/],
    ['וייז נקנתה על ידי גוגל ב-2013.', /passive/],
    ['140 שערים בליגת האלופות. אף אחד לא קרוב.', /punch line/],
    ['הוא עשה משהו שאף אחד לא עשה לפניו. מי זה?', /names nothing/],
  ]) {
    assert.deepEqual(codes(s), [], `refused: ${s}`);
    assert.ok(softTellsIn(s).some((h) => hint.test(h)), `no hint for: ${s}`);
  }
  assert.deepEqual(softTellsIn('בזיליקום צריך לפחות 6 שעות שמש ישירה ביום. פחות מזה, והעלים נהיים קטנים וחיוורים.'), []);
});

test('across a post: the same opening, the same punch line, one rhythm and one favourite word are noticed', () => {
  const body = (text) => ({ kind: 'slideBody', text });
  const notes = (texts, known) => postTells(texts, { known }).map((p) => p.note).join(' | ');
  assert.match(notes([body('הוא ניצח את כולם. שוב.'), body('הוא ניצח בגמר. בלי רחמים.'), body('הוא ניצח בבית. כמו תמיד.')]), /open with the same word.*\| .*short punch line/);
  const even = ['השתיל צריך שש שעות של שמש', 'העציץ צריך חור קטן בתחתית', 'האדמה צריכה להתייבש בין השקיות', 'הגבעול צריך גיזום פעם בחודש', 'העלים צריכים מקום לנשום בחלון', 'הפרחים צריכים להיקטף מוקדם בבוקר'];
  assert.match(notes(even.map((s) => body(`${s}.`))), /every sentence is about \d words long/);
  const fav = ['משקים בדיוק בבוקר, לפני החום.', 'גוזמים בדיוק מעל זוג עלים.', 'שותלים בדיוק בעומק של העציץ הקודם.', 'קוטפים בדיוק לפני הפריחה.'].map(body);
  assert.match(notes(fav), /"בדיוק" in 4 texts/);
  assert.doesNotMatch(notes(fav, 'בדיוק'), /in 4 texts/, "the post's subject may repeat");
});

test('the reviewer gets the hints beside each text, and the offline reviewer scores them without blocking on them', () => {
  const texts = [
    { where: 'slide 1 text', kind: 'slideBody', text: 'השרך כבר לא בסלון, אלא בחדר האמבטיה.' },
    { where: 'slide 2 text', kind: 'slideBody', text: 'בזיליקום צריך לפחות 6 שעות שמש ביום.' },
  ];
  assert.deepEqual(hintsFor(texts)[1], []);
  const user = reviewUser({ meta: { displayName: 'דמו' }, voice: '# קול\n\n## מי מדבר\n\nגנן.' }, texts, []);
  assert.match(user, /\[0\][^\n]*\n {4}HINTS: "לא X אלא Y"/);
  assert.doesNotMatch(user, /\[1\][^\n]*\n {4}HINTS/);
  const [hinted, plain] = heuristicReview(texts, pack);
  assert.ok(hinted.botScore > plain.botScore && hinted.botScore < BLOCK_AT, `hinted ${hinted.botScore}, plain ${plain.botScore}`);
});

test("the writer is told the voice: the never list, the read-aloud pass, and the rewrite rebuilds a sentence", () => {
  const system = packBlock(pack).text;
  assert.match(system, /HEBREW THAT SOUNDS LIKE A PERSON/);
  assert.match(system, /"בלי X ובלי Y"/);
  assert.doesNotMatch(system, /\(אתם, תנסו, שמרו\)/, 'the formal imperative is never given as an example of the plural');
  assert.match(slidesPrompt(pack).system[1].text, /BEFORE YOU RETURN/);
  assert.match(rewritePrompt(pack).system[1].text, /never swap one word/);
});
