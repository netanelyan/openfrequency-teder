// What gives a Hebrew text away as written by a bot, checked in code.
//
// A prompt can ask a model not to write these things; only a check can promise
// it did not. Every phrase here is refused on every slide, cover and caption,
// and the reasons go back to the model once for a redraft.
//
// Matching is on normalised Hebrew (no niqqud, no geresh, no punctuation), on
// whole words with a one-letter prefix allowed, so "ובנוסף" is caught and a
// longer word that merely contains a banned one is not. JavaScript's \b does not
// work on Hebrew letters, which is why none of these use it.

/** Hebrew without niqqud, quote marks and punctuation, single-spaced. */
export const normHe = (s) =>
  String(s || '')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[׳״'"`]/g, '')
    .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const PREFIX = '(?:ו|ה|ב|ל|מ|ש|כ|וה|וב|ול|ומ|וש|שה|שב|של|כש)?';
const phrase = (p) => new RegExp(`(?:^| )${PREFIX}${normHe(p)}(?= |$)`, 'u');
const group = (label, list) => list.map((p) => ({ label, p, re: phrase(p) }));

export const CONNECTIVES = group('stock opener or connective', [
  'חשוב לציין', 'כדאי לדעת', 'כדאי לזכור', 'שווה לדעת', 'שווה לציין', 'בנוסף', 'יחד עם זאת', 'ללא ספק', 'מעניין לציין',
  'ראוי לציין', 'לסיכום', 'כמו כן', 'נקודה שמתחברת', 'בעולם של היום', 'בעידן הנוכחי', 'בואו נצלול', 'בואו נדבר על', 'צללו פנימה',
  'במאמר זה', 'בפוסט הזה נדבר', 'בפוסט הזה',
]);

export const FORMAL = group('formal word', ['ניתן', 'הינו', 'הינה', 'הינם', 'אנו', 'על מנת', 'באפשרותכם', 'באפשרותך', 'לפיכך', 'אי לכך', 'יתרה מזאת']);

export const PRAISE = group('generic praise', ['פשוט מדהים', 'תוכן מדהים', 'איזה כיף', 'איזה יופי', 'משנה חיים', 'משנה את כללי המשחק', 'גיים צ׳יינג׳ר', 'מהפכני']);

// Adjectives that carry no information; a slide's filler IS the whole line.
export const FILLER = group('filler adjective', [
  'מדהים', 'מדהימה', 'מדהימים', 'מרהיב', 'מרהיבה', 'קסום', 'קסומה', 'חלומי', 'חלומית', 'מושלם', 'מושלמת', 'עוצר נשימה', 'עוצרת נשימה',
  'בלתי נשכח', 'פנטסטי', 'פנטסטית', 'אדיר', 'אדירה',
]);

// Hebrew a form writes and a person never says, in any register (the hebrew-voice guide, section 5).
export const BUREAUCRATIC = group('form Hebrew, not spoken', [
  'הננו', 'הנני', 'הרינו', 'בגין', 'יש לציין', 'יש להדגיש', 'יש לזכור', 'יש להקפיד', 'יש לוודא', 'יש לשים לב', 'יש לבצע', 'בהתאם לאמור', 'לשירותכם', 'לשירותך', 'תבוצע', 'יבוצע', 'אי לזאת',
]);

// Ad copy: claims with nothing behind them, nouns that name no thing, urgency nobody set.
export const AD = group('ad copy', [
  'מהפכה', 'מגדירים מחדש', 'מגדיר מחדש', 'ממציא מחדש', 'ממציאים מחדש', 'לשלב הבא', 'ערך מוסף', 'מעצימים', 'מגוון פתרונות', 'פתרון מושלם',
  'פלטפורמה מתקדמת', 'המערכת המובילה', 'אל תפספסו', 'מהרו', 'בלי אותיות קטנות', 'בלי התחייבות', 'השליטה אצלכם',
  'הצוות שלנו', 'אנחנו כאן בשבילכם', 'אנחנו כאן כדי',
]);

// A twist kept back to make them read on: the slides answer a question, they do not hide the subject. The one
// exception is a cover written from a hook template (src/formats/hooks.js), whose promise the slides were checked
// to keep: its fixed words are passed in as `frame` and are not read as a teaser; the words in its slots still are.
export const TEASER = group('a teaser that withholds the point', [
  'לא תאמינו', 'והנה הקטע', 'הנה הקטע', 'הנה הסיבה', 'הנה למה', 'לא מה שאתם חושבים', 'משהו גדול בדרך', 'תתפלאו', 'התשובה תפתיע',
  'הראשון מפתיע', 'המקום הראשון מפתיע', 'זה סיפור אמיתי', 'שאף אחד לא אומר לכם', 'שאף אחד לא מספר לכם', 'תראו מה קרה', 'ואז קרה משהו',
]);

// What a cover may hold back. Its one job is to stop a thumb, and of 25 slideshows that spread on TikTok, 8 said
// "you didn't know" or "few people know" on the cover and 3 counted down to a number one they kept for the last
// slide: a gap the slides close is the cover's work, not a tell. The empty ones that promise nothing ("לא תאמינו",
// "תתפלאו", "תראו מה קרה") stay refused everywhere, and a slide or a caption still says its point.
// "זו הסיבה ש..." and "הנה מה שקרה" hide the subject itself, and stay refused on a cover too.
export const COVER_GAP = new Set(['שאף אחד לא אומר לכם', 'שאף אחד לא מספר לכם', 'הסוד ש', 'הראשון מפתיע', 'המקום הראשון מפתיע', 'זה סיפור אמיתי']);

// Plain narration in a slide's body ("זו הסיבה שהוא פרש"), a withheld payoff as a headline.
export const HEADLINE_TEASER = group('a headline that withholds the point', ['זה מה שקרה', 'הנה מה שקרה', 'זאת הסיבה', 'זו הסיבה']);

// What a chatbot says and a person in a post does not, and the lines that beg for comments.
export const BOT = group('chatbot or engagement line', [
  'שאלה מצוינת', 'שאלה מעולה', 'מקווה שזה עוזר', 'מקווים שזה עוזר', 'אל תהססו', 'אל תהסס', 'אשמח לעמוד', 'נשמח לעמוד',
  'תייגו', 'תתייגו', 'תגיבו', 'תכתבו בתגובות', 'שתפו אם',
]);

// English said in Hebrew words: a sentence translated, not written.
export const CALQUES = group('translated Hebrew', [
  'בסופו של יום', 'עושה את ההבדל', 'עושים את ההבדל', 'לעשות את ההבדל', 'לקחת צעד אחורה', 'על בסיס יומי', 'באופן משמעותי',
  'בצורה משמעותית', 'יותר מאי פעם', 'מעולם לא היה קל יותר', 'כל מה שצריך לדעת', 'המדריך המלא', 'מדריך מלא', 'בואו נודה', 'במילים אחרות', 'ברמה אחרת',
]);

// Phrases whose second word takes a prefix, so they cannot be matched as whole words.
const GLUED = [
  { label: 'form Hebrew, not spoken', p: 'במידה ו', re: /(?:^| )במידה ו/u },
  { label: 'form Hebrew, not spoken', p: 'לא יאוחר מ', re: /(?:^| )לא יאוחר מ/u },
  { label: 'a teaser that withholds the point', p: 'הסוד ש', re: /(?:^| )ו?הסוד ש/u },
  { label: 'translated Hebrew', p: 'כשזה מגיע ל', re: /(?:^| )כשזה מגיע ל/u },
  { label: 'translated Hebrew', p: 'בכל הנוגע ל', re: /(?:^| )בכל הנוגע ל/u },
  { label: 'translated Hebrew', p: 'זה לא סוד ש', re: /(?:^| )(?:זה )?לא סוד ש/u },
  { label: 'translated Hebrew', p: 'מה שהופך את', re: /(?:^| )מה שהופך את/u },
];

// Second-person singular forms. Posts address the audience in the plural.
// Only unambiguous ones: the masculine future (תוכל, תרצה, תבדוק) is spelled
// exactly like the third person feminine ("Google תוכל"), so it cannot be told
// apart without parsing the sentence, and a guard that refuses correct Hebrew is
// a broken guard. The live reviewer reads for register on top of this.
export const GENDERED = group('singular "you" (the audience is addressed in the plural)', [
  'אתה', 'תרצי', 'תגידי', 'תשלחי', 'תבדקי', 'תשמרי', 'תוכלי', 'תדעי', 'בא לך', 'שלך', 'אותך', 'עשית', 'כתבת', 'צילמת',
]);

// The structures of ad copy and of machine text (the hebrew-voice guide, section 5), on the text as written.
// "זה לא X, זה Y": what it is not, then the punch. Said plainly, it is what it is.
const NOT_THIS = /(?:^|[\s.?,"(])(?:זה|זו|זאת|הוא|היא|הם)\s+לא\s+(?:עוד\s+|סתם\s+|רק\s+)?[^,.?\n]{1,30},\s*(?:זה|זו|זאת|הוא|היא|הם|אלא)\s/u;
// "לא עוד X": the slogan's opener.
const NO_MORE = /(?:^|[\s.?,"(])לא\s+עוד\s+(?![\d])/u;
// "בלי X ובלי Y", "אין X ואין Y": reassurance in a chain.
const WITHOUT_CHAIN = /(?:^| )ו?(בלי|אין) (?:\S+ ){1,3}ו?\1(?= )/u;
// "פחות X, יותר Y", "יותר X, יותר Y": a sentence balanced like a slogan.
const BALANCED = /(?:^|[\s.?"(])(?:יותר|פחות)\s+[^,.?\n]{1,25},\s*(?:יותר|פחות)\s/u;
// "בשורה משמחת:", "דעה לא פופולרית:": a label and a colon instead of a sentence.
const LABEL_OPENER = /(?:^|[.?!]\s+)(?:בשורה משמחת|סוף סוף|חדש|מבריק|אזהרה|עדכון|דעה(?: לא פופולרית)?|טיפ|עובדה|פאן פקט|ספוילר|רגע|חשוב|הטוויסט|התשובה|השורה התחתונה)\s*:/u;
// "את/ה", "מוזמנ/ת": a form's slash. Rephrase to the plural, or to no subject at all.
const GENDER_SLASH = /[א-ת]\/[א-ת]{1,2}(?![א-ת])/u;
// "מ-ט-ר-י-ף": letters spaced out for emphasis.
const SPACED = /(?:^|\s)(?:[א-ת]-){3,}[א-ת](?=[\s.,?]|$)/u;
// A sentence that is only an emphatic word: "פשוט.", "זהו.", "נקודה."
const EMPHATIC = /^(?:ו?פשוט|ו?זהו|נקודה|וזה הכל|וזה הכול|בום|וואו|תכלס|סגור)$/u;
// Fragments for emphasis: this many very short sentences in a row ("מהיר. קל. זול.").
const FRAGMENT_WORDS = 3;
const FRAGMENT_RUN = 3;

const MORAL = /^(?:בקיצור|בסופו של דבר|בשורה התחתונה|השורה התחתונה|וזה מה ש|כי בסוף|אז כן|ובקיצור|המסקנה)/;
const EMOJI = /\p{Extended_Pictographic}/gu;
const LONG_DASH = /[—–]/;
const ARTEFACTS = /\*\*|^\s*[#*]\s|\{[a-z_]+\}|\[[^\]]*\]\(|<\/?[a-z]+>/im;
// A link: a scheme, "www.", or a domain with a path. A company named for its domain
// ("monday.com", "Wix.com") is a name, not a link, and neither platform makes it one.
// One word in two scripts: "חבib", "greco-רומית". A Hebrew prefix before a Latin name is the way it is written
// ("ב-Vercel", "ה-API"); a Latin word with a Hebrew one glued on after it is a translation left half done.
const MIXED_SCRIPT = /[א-ת][A-Za-z]|[A-Za-z][א-ת]|[A-Za-z]{2,}-[א-ת]{3,}/;
const URL_LIKE = /https?:\/\/|www\.|[\p{L}\p{N}-]+\.(?:com|co\.il|org|net|io|ai|gov\.il)\/\S/iu;

// The comma inside one score written the way fans read it ("ישראל 9, טייוואן 0"):
// a number, a comma, a name and a number, not chained to another score on either side.
const SCORE_COMMA = /(\d+)(?<!\d\s*,\s*[^,\d]{1,30}\s\d+)\s*,\s+(?=[^,\d]{1,30}\s\d+(?!\d)(?!\s*,\s*[^,\d]{1,30}\s\d))/gu;

/** Sentences, the way a reader counts them. */
export function sentencesOf(text) {
  return String(text || '')
    .replace(EMOJI, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * Share of words that carry Hebrew. Counted by word, not by letter: a product or
 * button name in Latin letters inside a Hebrew sentence ("Projects \u05D1-Claude") is
 * how people actually write, while a Latin sentence is not Hebrew however short.
 */
export function hebrewShare(text) {
  const words = String(text || '')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  if (!words.length) return 1;
  return words.filter((w) => /[\u05D0-\u05EA]/.test(w)).length / words.length;
}

/**
 * A formal imperative at the head of a request ("עקבו אחרי", "שמרו את", "כתבו בתגובות"). Said to a friend it is the
 * spoken one: "תעקבו", "תשמרו", "תכתבו". Only before the words a request goes on with, so a past tense ("הם שמרו
 * על הכדור") is not taken for one.
 */
const FORMAL_IMPERATIVE = /(?:^|[\s.?:,"(])(עקבו|שמרו|שלחו|כתבו|תייגו|נחשו|ספרו|הגיבו|לחצו)\s+(?:את|לנו|לחבר|לחברים|אחרי|בתגובות|מי|עכשיו|כאן|פה|ל(?=\S))/;

export const LIMITS = {
  // A cover can ask, answer and tease in three short sentences ("X או Y? מי היה טוב יותר? התשובה בסוף"): eleven words bound it.
  cover: { maxChars: 70, minWords: 3, maxWords: 11, emoji: 1, sentences: 3 },
  slideTitle: { maxChars: 60, emoji: 1, sentences: 2 },
  slideBody: { maxChars: 230, emoji: 1, sentences: 3 },
  // The line under the cover line: a slide body's limits, unless the account keeps it shorter.
  sub: { maxChars: 230, emoji: 1, sentences: 3 },
  caption: { maxChars: 320, emoji: 2, sentences: 4 },
  // A post with two captions: TikTok's long one (its search reads it) and Instagram's short one.
  // An account that wants short, catchy captions asks for a lower minimum.
  captionLong: { minChars: 200, maxChars: 900, emoji: 2, sentences: 8 },
  captionShort: { maxChars: 260, emoji: 2, sentences: 3 },
  // A body of short lines (places 10 to 6, an iceberg's layer): each line is one item, not a run-on.
  slideLines: { maxChars: 260, emoji: 1, sentences: 6 },
};

/**
 * The limits for one kind of text in one pack: the engine's, tightened by the pack's own (pack.json
 * "writing": { "slideBody": { "maxChars": 150, "sentences": 2 } }). A pack can ask for less, never more:
 * a shorter text, fewer sentences, a lower minimum for TikTok's caption.
 */
export function limitsFor(kind, pack = null) {
  const base = LIMITS[kind] || LIMITS.slideBody;
  const own = pack?.meta?.writing?.[kind] || {};
  const out = { ...base };
  for (const [k, v] of Object.entries(own)) if (Number.isFinite(v) && (k === 'minWords' ? v >= (base[k] ?? 0) : v <= (base[k] ?? Infinity))) out[k] = Math.max(v, FLOOR[kind]?.[k] ?? 0);
  return out;
}

// TikTok's caption is a story in four beats (src/rules/caption.js): a short-caption account still gets room for
// four lines and the closing question, however far it lowers the limits.
export const FLOOR = { captionLong: { sentences: 5, maxChars: 160 } };

/**
 * Every tell in one text, as { code, msg }. Empty means it reads like a person.
 * kind: 'cover' | 'sub' | 'slideTitle' | 'slideBody' | 'slideLines' | 'caption' | 'captionLong' | 'captionShort'
 * extra: the pack's own banned phrases (rules.json bannedPhrases)
 * frame: on a cover written from a hook template, the template's fixed words (src/formats/hooks.js coverFrame),
 *   which the teaser checks let through. Ignored on any other kind of text.
 */
const ON_SLIDE = new Set(['cover', 'sub', 'slideTitle', 'slideBody']);
// The texts a reader takes as a heading: no colon in them, and no payoff held back.
const HEADLINE = new Set(['cover', 'sub', 'slideTitle']);

// A quotation: a quote mark after a space or the start, words, and a quote mark before a space, punctuation or
// the end. The gershayim inside an abbreviation (ת"א, ארה"ב) sit between letters, so they never open one.
const QUOTED = /(?<=^|[\s(])["“״]([^"“”״\n]{2,}?)["”״](?=$|[\s.,?:)])/gu;

/** A text without what it quotes: the words the account says in its own voice. */
export const ownWords = (text) => String(text || '').replace(QUOTED, ' ').replace(/\s+/g, ' ').trim();

/** Words a reader counts in a sentence: a number is one, a dash on its own is none. */
const wordCount = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// The checks a cover template's frame is let through (tellsIn, frame).
const TEASERS = new Set([...TEASER, ...HEADLINE_TEASER, ...GLUED.filter((t) => /teaser/.test(t.label))]);

export function tellsIn(text, { kind = 'slideBody', extra = [], pack = null, frame = [] } = {}) {
  const out = [];
  const add = (code, msg) => out.push({ code, msg });
  const raw = String(text || '').trim();
  if (!raw) return kind === 'slideBody' || kind === 'slideLines' || kind === 'sub' ? [] : [{ code: 'empty', msg: 'empty' }];
  const norm = normHe(raw);
  const lim = limitsFor(kind, pack);

  const headline = HEADLINE.has(kind);
  for (const t of [...CONNECTIVES, ...FORMAL, ...PRAISE, ...FILLER, ...GENDERED]) if (t.re.test(norm)) add('phrase', `${t.label}: "${t.p}"`);
  // What someone else said, in quotation marks (a myth as people say it, a fighter's words), is theirs: the
  // voice's own structures are checked on the rest.
  const own = ownWords(raw);
  const ownNorm = normHe(own);
  // A template's frame is held back on purpose, and only on the cover: its own words are not a teaser there.
  const teaserNorm = kind === 'cover' && frame.length ? frame.reduce((t, f) => t.replace(normHe(f), ' '), ownNorm).replace(/\s+/g, ' ').trim() : ownNorm;
  for (const t of [...BUREAUCRATIC, ...AD, ...TEASER, ...BOT, ...CALQUES, ...GLUED, ...(headline ? HEADLINE_TEASER : [])]) {
    if (kind === 'cover' && COVER_GAP.has(t.p)) continue;
    if (t.re.test(TEASERS.has(t) ? teaserNorm : ownNorm)) add('phrase', `${t.label}: "${t.p}"`);
  }
  for (const p of extra) if (phrase(p).test(norm)) add('banned', `banned by the pack: "${p}"`);

  // The structures are rewritten as a sentence, never patched by swapping a word.
  const flatOwn = own.replace(/\s*\n+\s*/g, ' ');
  if (NOT_THIS.test(flatOwn)) add('structure', '"זה לא X, זה Y": say what it is, not first what it is not');
  if (NO_MORE.test(flatOwn)) add('structure', '"לא עוד X" is a slogan: say what it is');
  if (WITHOUT_CHAIN.test(ownNorm)) add('structure', '"בלי X ובלי Y" (or "אין X ואין Y") is a chain of reassurances: say the one thing that matters, as a sentence');
  if (BALANCED.test(flatOwn)) add('structure', '"פחות X, יותר Y" is balanced like a slogan: say what happened, with its number');
  if (LABEL_OPENER.test(flatOwn)) add('structure', 'a label and a colon ("עובדה:", "דעה לא פופולרית:"): say it as a sentence');
  if (headline && /:/.test(own.replace(/\d:\d/g, ''))) add('structure', 'a colon in a heading ("X: Y"): say it as one sentence, or as a question');
  if (GENDER_SLASH.test(raw)) add('register', 'a gendered slash ("את/ה"): talk to them in the plural');
  if (SPACED.test(raw)) add('register', 'letters spaced out for emphasis');
  if (/\?{2,}|\?\s+\?/.test(raw)) add('register', 'stacked question marks');

  if (LONG_DASH.test(raw)) add('structure', 'a long dash (use a comma or a hyphen)');
  if (/;/.test(raw)) add('structure', 'a semicolon');
  if (/!/.test(raw)) add('register', 'an exclamation mark');
  const formal = FORMAL_IMPERATIVE.exec(norm);
  if (formal) add('register', `the formal imperative "${formal[1]}": say it the spoken way, "ת${formal[1]}"`);
  if (/\.\.\.|…/.test(raw)) add('structure', 'trails off with an ellipsis');
  if (ARTEFACTS.test(raw)) add('artefact', 'markdown or a template placeholder left in the text');
  const mixed = raw.split(/\s+/).find((w) => MIXED_SCRIPT.test(w));
  if (mixed) add('language', `"${mixed}" mixes Hebrew and Latin letters in one word: write it in Hebrew`);
  if (URL_LIKE.test(raw)) add('url', 'a web address (a link in a post is a demotion and is never tappable)');
  const emoji = (raw.match(EMOJI) || []).length;
  if (emoji > lim.emoji) add('register', `${emoji} emoji, ${lim.emoji} at most`);
  if (/^caption/.test(kind)) {
    // In a caption the colon of a brochure ("שלושה דברים: א, ב, ג") is a tell.
    const colon = sentencesOf(raw).some((s) => {
      const at = s.replace(/\d:\d/g, '').indexOf(':');
      return at >= 0 && s.slice(0, at).trim().split(/\s+/).length > 4;
    });
    if (colon) add('structure', 'a colon after a whole clause: say it as a sentence');
  }

  // Lines are items: each is counted on its own, so five places are five lines, not one long sentence.
  // On a slide a line break is where the eye rests (src/rules/overlay.js), not the end of a sentence.
  const sentences = kind === 'slideLines' ? raw.split(/\n+/).flatMap((l) => sentencesOf(l)) : ON_SLIDE.has(kind) ? sentencesOf(raw.replace(/\s*\n+\s*/g, ' ')) : sentencesOf(raw);
  for (const raw1 of sentences) {
    // A score as fans write it ("ישראל 9, טייוואן 0") is one thing, not two; four scores in a row are still a list.
    const s = raw1.replace(SCORE_COMMA, '$1 ');
    const parts = s.split(/,|\s+ו(?=\S)/).map((p) => p.trim()).filter(Boolean);
    // Four short things in a row: "פוטוס, זמיה, קקטוס ואלוורה". Clauses around one long one are a sentence, not a list
    // ("באותה שנה, ב-14 בנובמבר, החברה הוציאה את X, שמסכם אתרים" was refused, and no redraft could fix what was not there).
    let run = 0;
    let longest = 0;
    for (const p of parts) {
      run = p.split(/\s+/).length <= 3 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    if (s.split(',').length >= 4 && longest >= 4) {
      add('structure', `a list of four or more things in one sentence ("${raw1.length > 70 ? `${raw1.slice(0, 70)}...` : raw1}"): keep two or three, or give them a line each`);
      break;
    }
  }
  const last = normHe(sentences[sentences.length - 1] || '');
  if (sentences.length > 1 && MORAL.test(last)) add('structure', 'ends by summing up or drawing a moral');
  // A list's lines are items, short by design; everywhere else a run of fragments is a drumroll.
  if (kind !== 'slideLines') {
    const emphatic = sentences.find((s) => EMPHATIC.test(normHe(s)));
    if (emphatic) add('structure', `"${emphatic}" as a sentence of its own, for emphasis: join it to the sentence it stresses`);
    let run = 0;
    for (const s of sentences) {
      run = wordCount(s) <= FRAGMENT_WORDS ? run + 1 : 0;
      if (run >= FRAGMENT_RUN) {
        add('structure', `${FRAGMENT_RUN} fragments in a row ("${sentences.slice(sentences.indexOf(s) - FRAGMENT_RUN + 1, sentences.indexOf(s) + 1).join(' ')}"): say it as one sentence`);
        break;
      }
    }
  }

  const len = raw.replace(/\s+/g, ' ').length;
  if (len > lim.maxChars) add('length', `${len} characters, ${lim.maxChars} at most`);
  // The sentences as the code counted them: a model told only "4 sentences" miscounts its own text and redrafts the same four.
  if (sentences.length > lim.sentences) add('length', `${sentences.length} sentences, ${lim.sentences} at most (counted: ${sentences.map((x, i) => `[${i + 1}] "${x.length > 50 ? `${x.slice(0, 50)}...` : x}"`).join(' ')}): join two of them or cut one`);
  if (kind === 'cover') {
    // Words as a reader counts them: ש-Gemini is one word, not a prefix and a name.
    const words = raw.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (words < lim.minWords || words > lim.maxWords) add('length', `${words} words on the cover, ${lim.minWords} to ${lim.maxWords}`);
  }
  // A short title that is a name ("Fiverr", "Real Madrid", the answer of a guess-who) is not a sentence in English.
  const aName = (kind === 'slideTitle' || kind === 'cover') && raw.split(/\s+/).length <= 3 && !/[.?]$/.test(raw);
  if (hebrewShare(raw) < 0.5 && !aName) add('language', 'mostly not Hebrew');
  return out;
}

/**
 * The tells a redraft would only fix mechanically, fixed in code instead: an
 * exclamation mark becomes a full stop, a long dash a comma (a hyphen between
 * two numbers, so a range stays a range), a semicolon a full stop, an ellipsis
 * a full stop, and markdown bold is dropped. No word changes, so no fact and no
 * number can. Returns { text, fixed: [what changed] }.
 */
export function mechanicalFix(text) {
  const before = String(text || '');
  const fixed = [];
  let t = before;
  const sub = (re, to, what) => {
    const next = t.replace(re, to);
    if (next !== t) fixed.push(what);
    t = next;
  };
  // A line broken by hand can come back from the model as the two characters "\n": the mixed-script check then read
  // "האוטובוס\nשל" as a Hebrew word with a Latin letter in it, and refused two covers in five on a live run.
  sub(/\s*\\n\s*/g, '\n', 'an escaped line break');
  sub(/(\d)\s*[—–]\s*(\d)/g, '$1-$2', 'a dash between numbers');
  sub(/\s*[—–]\s*/g, ', ', 'a long dash');
  sub(/\?!+|!+\?/g, '?', 'an exclamation mark');
  sub(/\?(?:\s*\?)+/g, '?', 'stacked question marks');
  sub(/!+/g, '.', 'an exclamation mark');
  sub(/\s*;\s*/g, '. ', 'a semicolon');
  sub(/\s*(?:\.\.\.|…)/g, '.', 'an ellipsis');
  sub(/\*\*/g, '', 'markdown');
  t = t.replace(/\s+([,.?])/g, '$1').replace(/,\s*([.?])/g, '$1').replace(/\.{2,}/g, '.').replace(/^[,\s]+/, '').replace(/ {2,}/g, ' ').trim();
  return { text: t, fixed: [...new Set(fixed)] };
}

// The closing questions every engagement-bait post ends with. A strong reviewer
// scores a caption that ends with one at 8 out of 10 (the cost comparison,
// docs/costs.md), and the post then needs a rewrite it may not have left.
const GENERIC_QUESTIONS = ['ידעתם את זה', 'ידעתם', 'הידעתם', 'מה דעתכם', 'מה אתם חושבים', 'למי זה יכול לעזור', 'כבר ניסיתם את זה', 'ניסיתם את זה', 'זוכרים את זה', 'מי לדעתכם', 'איזה מספר הכי הפתיע אתכם', 'מה הפתיע אתכם', 'שמרו את הפוסט', 'תייגו חבר', 'מסכימים'];

/** Is this closing question a generic engagement line, the same under any post? */
export function isGenericQuestion(q) {
  const n = normHe(q);
  return GENERIC_QUESTIONS.some((g) => n === normHe(g));
}

// ---- hints: what often gives a text away, and sometimes does not
//
// A refused text costs a redraft, and a guard that refuses correct Hebrew is a broken guard. So what is a tell
// only most of the time ("לא X אלא Y", a one-word sentence, "כ-80", "על ידי") is never refused here: it goes to the
// reviewer as a hint beside the text, and the reviewer, who reads the sentence, decides. The offline reviewer adds
// a little to its score for each.

const NOT_BUT = /(?:^|[\s.?,"(])לא\s+[^,.?\n]{1,30},?\s+אלא\s/u;
// "אף אחד לא קרוב.", "אף פעם.": the short closing line that tells them how to feel.
const PUNCH_CLOSE = /^(?:ו?אף אחד|ו?אף פעם|ו?אף אחת|ו?אין|ו?לא|ו?רק|ו?עדיין|ואז)(?= |$)/u;
const TRIAD = /(?:^|[\s,])([א-ת]{2,}),\s+([א-ת]{2,})\s+ו-?([א-ת]{2,})(?=[\s.?]|$)/u;
const DASH_TWIST = /\s-\s[^-\n]{1,40}[.?]?$/u;
const ABOUT = /(?:^|\s)[בול]?כ-?\s?\d/u;
const PASSIVE_BY = /(?:^|\s)על\s+ידי\s/u;
const SUPERLATIVE = /(?:^|\s)ה?הכי\s+\S+\s+(?:בעולם|בארץ|בישראל|בהיסטוריה|אי\s+פעם|שיש|שהיה|שהייתה)/u;
const BROCHURE = ['חוויה', 'חוויית', 'פתרון', 'פתרונות', 'פלטפורמה', 'אקוסיסטם', 'סינרגיה', 'אופטימלי', 'אופטימלית', 'משמעותי', 'משמעותית', 'מגוון', 'איכותי', 'איכותית', 'נדרש', 'נדרשת', 'נדרשים', 'לצורך', 'אודות', 'באמצעות', 'בהתאם', 'ביצע', 'ביצעה', 'בוצע', 'בוצעה'];
const BROCHURE_RE = BROCHURE.map((w) => ({ w, re: phrase(w) }));

/** The hints in one text, as plain English notes for the reviewer. */
export function softTellsIn(text, { kind = 'slideBody' } = {}) {
  // A slide's line breaks are kept: a list's lines are items.
  const raw = String(text || '').replace(QUOTED, ' ').trim();
  if (!raw || kind === 'visual') return [];
  const out = [];
  const flat = raw.replace(/\s*\n+\s*/g, ' ');
  const norm = normHe(raw);
  const sentences = kind === 'slideLines' ? [] : sentencesOf(ON_SLIDE.has(kind) ? flat : raw);
  if (NOT_BUT.test(flat)) out.push('"לא X אלא Y": says what it is not before what it is');
  const last = sentences[sentences.length - 1] || '';
  if (sentences.length > 1 && wordCount(last) <= 4 && PUNCH_CLOSE.test(normHe(last))) out.push(`ends on a punch line ("${last}")`);
  const lone = sentences.find((s) => wordCount(s) === 1 && !/\d/.test(s));
  if (lone && sentences.length > 1) out.push(`a one-word sentence ("${lone}")`);
  const triad = TRIAD.exec(flat);
  if (triad && kind !== 'slideLines') out.push(`three words in a row ("${triad[1]}, ${triad[2]} ו${triad[3]}"): a triad reads like an ad`);
  if (HEADLINE.has(kind) && DASH_TWIST.test(flat)) out.push('a hyphen before the payoff');
  if (ABOUT.test(raw)) out.push('"כ-" before a number: people say "בערך"');
  // A guess-who hides its answer by design; anywhere else "something nobody did" names nothing.
  if (/(?:^| )משהו ש?אף אחד לא/u.test(norm)) out.push('"משהו שאף אחד לא...": names nothing, say what it was');
  if (PASSIVE_BY.test(raw)) out.push('"על ידי": a passive sentence, say who did it first');
  if (SUPERLATIVE.test(flat) && !/\d/.test(flat)) out.push('a superlative with no number beside it');
  const brochure = BROCHURE_RE.filter((b) => b.re.test(norm)).map((b) => b.w);
  if (brochure.length) out.push(`brochure words: ${brochure.slice(0, 3).map((w) => `"${w}"`).join(', ')}`);
  return out;
}

const STOP = new Set(['אבל', 'אחרי', 'אותו', 'אותה', 'אותם', 'איתו', 'איזה', 'אפשר', 'היום', 'הייתה', 'היתה', 'הוא', 'היא', 'הם', 'זה', 'זאת', 'כבר', 'כמו', 'לפני', 'לפי', 'מול', 'עוד', 'עכשיו', 'רק', 'שלו', 'שלה', 'שלהם', 'שנים', 'שנה', 'שני', 'שתי', 'אחד', 'אחת', 'כל', 'כמה', 'מאוד', 'פעם', 'יותר', 'פחות', 'הכי', 'אין', 'היה', 'היו', 'יש', 'גם', 'בין', 'תוך', 'בלי', 'עם', 'אצל', 'כדי', 'כך', 'ככה', 'למה', 'איך', 'מתי', 'איפה', 'אתם', 'אתכם', 'שלכם', 'לכם']);
const stem = (w) => w.replace(/^(?:וה|וב|ול|ומ|וש|שה|שב|של|כש|ו|ה|ב|ל|מ|ש|כ)(?=[א-ת]{3,})/u, '');

/**
 * What only shows across a whole post: every sentence the same length, every slide opening or closing the same
 * way, every title a question, one word everywhere. texts: [{ kind, text }] in the post's order; `known`: words that
 * are the post's subject (its facts' claims), which may repeat. Returns [{ indexes, note }].
 */
export function postTells(texts, { known = '' } = {}) {
  const out = [];
  const at = (pred) => texts.map((t, i) => (pred(t) ? i : -1)).filter((i) => i >= 0);
  const bodies = at((t) => t.kind === 'slideBody' && String(t.text || '').trim());
  const titles = at((t) => t.kind === 'slideTitle' && String(t.text || '').trim());
  const first = (i) => stem(normHe(texts[i].text).split(' ')[0] || '');
  for (const [group, name] of [[bodies, 'slide'], [titles, 'title']]) {
    const by = new Map();
    for (const i of group) by.set(first(i), [...(by.get(first(i)) || []), i]);
    for (const [w, idx] of by) if (w && idx.length >= 3) out.push({ indexes: idx, note: `${idx.length} ${name}s open with the same word ("${w}")` });
  }
  if (titles.length >= 3 && titles.every((i) => /\?\s*$/.test(texts[i].text))) out.push({ indexes: titles, note: 'every title is a question' });
  // Every slide ending on a short line: a drumroll, slide after slide.
  const punchy = bodies.filter((i) => {
    const s = sentencesOf(String(texts[i].text).replace(/\s*\n+\s*/g, ' '));
    return s.length >= 2 && wordCount(s[s.length - 1]) <= 3;
  });
  if (punchy.length >= 3) out.push({ indexes: punchy, note: `${punchy.length} slides end on a short punch line` });
  // A person's sentences are long and short; a model's come out the same length.
  const lens = [];
  const where = [];
  texts.forEach((t, i) => {
    if (!['slideBody', 'captionLong', 'caption', 'sub'].includes(t.kind)) return;
    for (const s of sentencesOf(String(t.text || '').replace(/\s*\n+\s*/g, ' '))) {
      lens.push(wordCount(s));
      where.push(i);
    }
  });
  if (lens.length >= 6) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    if (mean >= 4 && sd / mean < 0.25) out.push({ indexes: [...new Set(where)], note: `every sentence is about ${Math.round(mean)} words long: vary the rhythm` });
  }
  // One word on many texts that is not the subject: the model's favourite, not the post's.
  const knownWords = new Set(normHe(known).split(' ').map(stem));
  const seen = new Map();
  texts.forEach((t, i) => {
    if (!/^(?:slide|cover|sub|caption)/.test(t.kind)) return;
    const mine = new Set();
    for (const word of normHe(t.text).split(' ')) {
      const w = stem(word);
      if (mine.has(w) || w.length < 4 || !/^[א-ת]+$/u.test(w) || STOP.has(w) || knownWords.has(w)) continue;
      mine.add(w);
      const s = seen.get(w) || { word, idx: [] };
      s.idx.push(i);
      seen.set(w, s);
    }
  });
  for (const { word, idx } of seen.values()) if (idx.length >= 4) out.push({ indexes: idx, note: `"${word}" in ${idx.length} texts` });
  return out;
}
