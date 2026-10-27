import { COMPLIANCE } from '../rules/compliance.js';
import { overlayOf } from '../rules/overlay.js';
import { styleRoom } from '../render/styles/fit.js';
import { BEAT, MAX_HASHTAGS, STORY, captionStyleOf } from '../rules/caption.js';
import { AD, BUREAUCRATIC, CALQUES, CONNECTIVES, FILLER, FORMAL, LIMITS, TEASER, limitsFor } from '../voice/tells.js';
import { focusText } from '../sources/text.js';
import { OWNER_TITLE } from '../sources/facts.js';
import { contentRange, everyPhoto, groupOf, hookPatterns, kindName, kindOf, shapesPrompt } from '../formats/kinds.js';
import { VISUAL_SCHEMA, visualsOf, visualsPrompt } from '../render/visuals.js';
import { SLOTS, SPEAKER_EN, speakerOf, templatesPrompt } from '../formats/hooks.js';

// The drafting calls' prompts and schemas, built from the pack.
//
// Prompts are in English (the model follows instructions best there) and ask for
// Hebrew output. Every rule here is also a check in code: the prompt is how the
// model gets it right the first time, the check is how a draft that did not is
// never shown.
//
// THE ORDER IS THE CACHE. A prompt is cached as a prefix, so it is built from
// the most stable part down:
//   1. the pack: who the account is, its voice guide, all its formats with their
//      cover patterns, the shape of every kind of post it uses, the Hebrew rules
//      and the law. The same for every call about this account (outline,
//      slides, rewrite), so they share one cached prefix.
//   2. the task's instructions: the same for every outline, or every slides call.
//   3. the user turn: this post's format, its cover pattern, its documents or facts.
// Nothing that changes per post (a date, a count, a format name) goes above the
// user turn. The schemas are the same for every kind of post for the same reason.

const SUBJECT = {
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, answer: { type: 'string' }, date: { type: 'string' } },
  required: ['a', 'b', 'answer', 'date'],
  additionalProperties: false,
};

export const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    usable: { type: 'boolean' },
    why: { type: 'string' },
    topic: { type: 'string' },
    subject: SUBJECT,
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' }, doc: { type: 'string' }, who: { type: 'string' }, whoHe: { type: 'string' } },
        required: ['id', 'claim', 'quote', 'doc', 'who', 'whoHe'],
        additionalProperties: false,
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { role: { type: 'string' }, point: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } } },
        required: ['role', 'point', 'facts'],
        additionalProperties: false,
      },
    },
    imageQuery: { type: 'string' },
    imageQueryB: { type: 'string' },
    research: { type: 'array', items: { type: 'string' } },
  },
  required: ['usable', 'why', 'topic', 'subject', 'facts', 'items', 'imageQuery', 'research'],
  additionalProperties: false,
};

export const DETAILS_SCHEMA = {
  type: 'object',
  properties: {
    details: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, kind: { type: 'string' }, claim: { type: 'string' }, quote: { type: 'string' }, doc: { type: 'string' }, item: { type: 'integer' }, who: { type: 'string' }, whoHe: { type: 'string' } },
        required: ['id', 'kind', 'claim', 'quote', 'doc', 'item', 'who', 'whoHe'],
        additionalProperties: false,
      },
    },
  },
  required: ['details'],
  additionalProperties: false,
};

export const SLIDES_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string' },
    sub: { type: 'string' },
    hookPattern: { type: 'string' },
    // A cover from a hook template (src/formats/hooks.js): its id, what fills its slots, and the facts it promises.
    hookTemplate: { type: 'string' },
    hookSlots: {
      type: 'object',
      properties: Object.fromEntries([...Object.keys(SLOTS), 'whoGender'].map((k) => [k, { type: 'string' }])),
      required: [...Object.keys(SLOTS), 'whoGender'],
      additionalProperties: false,
    },
    hookFacts: { type: 'array', items: { type: 'string' } },
    hookHighlight: { type: 'string' },
    subject: SUBJECT,
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          a: { type: 'string' },
          b: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          visual: VISUAL_SCHEMA,
          imageQuery: { type: 'string' },
          highlight: { type: 'string' },
        },
        required: ['role', 'title', 'body', 'a', 'b', 'facts', 'visual', 'imageQuery', 'highlight'],
        additionalProperties: false,
      },
    },
    // TikTok's caption, as the story's four beats (src/rules/caption.js): the code joins them, one a line.
    story: {
      type: 'object',
      properties: Object.fromEntries(STORY.map((k) => [k, { type: 'string' }])),
      required: STORY,
      additionalProperties: false,
    },
    captionShort: { type: 'string' },
    question: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    coverVisual: VISUAL_SCHEMA,
  },
  required: ['hook', 'sub', 'hookPattern', 'hookTemplate', 'hookSlots', 'hookFacts', 'hookHighlight', 'subject', 'slides', 'story', 'captionShort', 'question', 'keywords', 'coverVisual'],
  additionalProperties: false,
};

export const REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    rewrites: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'integer' }, text: { type: 'string' } }, required: ['index', 'text'], additionalProperties: false },
    },
  },
  required: ['rewrites'],
  additionalProperties: false,
};

// A repair answers for each text it was given: a slide in its fields, any other text in "text"; "" where unused.
export const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    repairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { target: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } } },
        required: ['target', 'text', 'title', 'body', 'a', 'b', 'facts'],
        additionalProperties: false,
      },
    },
  },
  required: ['repairs'],
  additionalProperties: false,
};

// How the Hebrew sounds, in every call that writes it (the hebrew-voice guide, for a slideshow). Every "never" here
// is also a check: the hard ones in src/voice/tells.js tellsIn, the ones that are only usually wrong as hints to
// the reviewer (softTellsIn, postTells).
export const HEBREW = `HEBREW THAT SOUNDS LIKE A PERSON (the cover, every slide, both captions):
Write it the way someone who knows the subject would say it out loud to a friend: direct, a little informal, specific. A sentence that would not come out of a person's mouth does not go on a slide.
- The concrete thing first: the number, the name, the minute, the place. "16 שערים ב-4 מונדיאלים", never "המון שערים". A claim with nothing behind it is cut, not decorated.
- An uneven rhythm: a longer sentence beside a short one. Never every sentence the same length, and never three fragments in a row for drama ("מהיר. קל. זול."). The slides do not all open with the same word or end on a punch line, and their titles are not one template.
- Everyday words: אפשר (not ניתן), צריך (not נדרש), בערך (not כ-), בשביל (not על מנת), אם (not במידה ו), the spoken imperative (תעקבו, תשמרו, תשלחו, תנסו), never the formal one (עקבו, שמרו, שלחו, נחשו), and the word people use over the formal one (פאונד, not ליברה). English terms the way Israelis say them (אפליקציה, לינק, באג).
- Active sentences: who did what. "גוגל קנתה את וייז", never "וייז נקנתה על ידי גוגל".
- Address the audience in the plural, or with no subject at all ("תוחבים אצבע לאדמה"). Never in the singular, never with a slash ("את/ה").
- An opinion is said as an opinion, next to its numbers.
NEVER, because each one reads as an ad or a bot. When a draft has one, rewrite the whole sentence; never swap one word:
- "זה לא X, זה Y", "לא עוד X", or a "לא X אלא Y" punch: say what it is.
- "בלי X ובלי Y", "אין X ואין Y": the one thing that matters, as a sentence.
- "פחות X, יותר Y", a triad of adjectives, two perfectly balanced sentences.
- A one-word sentence for emphasis ("פשוט.", "זהו.", "נקודה.").
- A colon in a heading, or a label before a sentence ("דעה לא פופולרית:", "עובדה:", "14 באוקטובר 2018: ..."): one sentence, or one question ("ב-14 באוקטובר 2018 מרפסת אחת שינתה עיר"). A score stays a score ("0:3").
- A teaser that hides the point ("זה מה שקרה כש", "הנה למה", "והראשון מפתיע", "לא תאמינו", a hyphen before the payoff). A cover may ask a real question about a named subject; it never hides who or what the post is about. The one exception is a cover written from one of the account's COVER TEMPLATES, whose slides deliver what it holds back; a template's words are for the cover alone.
- Big words with nothing behind them ("מהפכה", "אגדי", "משנה את כללי המשחק"), abstract nouns where a thing can be named ("חוויה", "פתרון", "פלטפורמה").
- English translated word for word ("בסופו של יום", "עושה את ההבדל", "כשזה מגיע ל", "מה שהופך את") and the Hebrew of forms ("הננו", "בגין", "יש לציין").
- Exclamation marks, long dashes (— or –), semicolons, an ellipsis, stacked question marks, more than one emoji on a slide.
- A moral or a summary at the end of a slide or a caption, or a line that asks for comments, tags or shares.
SERIOUS SUBJECTS (money, health, law, an injury, a death, a failure that hurt people): the same person, without jokes or emoji. The fact first, with its exact number and date, then what it means, in plain words.`;

// The rewrite pass of the hebrew-voice guide, as the writer runs it on its own draft before returning it.
const READ_ALOUD = `BEFORE YOU RETURN, read every text as if you were saying it to a friend. Rewrite any sentence you would not say out loud, or that sounds like an ad, a form or a translation. Cut a first sentence that only warms up and a last one that only sums up. Then read the slides one after another: if they open alike, end alike or have the same length, change some of them. Check the NEVER list one last time.`;

const compliance = (pack) =>
  (pack.meta.compliance || [])
    .map((id) => `- ${COMPLIANCE[id].about}. This is law and a code check enforces it: explain how things work, never recommend.`)
    .join('\n');

/** The voice guide with at most `max` example lines under each examples heading. */
export function trimVoice(md, max = 5) {
  let into = false;
  let n = 0;
  return String(md || '')
    .split(/\r?\n/)
    .filter((line) => {
      const h = /^#{2,3}\s*(.+)$/.exec(line);
      if (h) {
        into = /טוב|רע|good|bad/i.test(h[1]);
        n = 0;
        return true;
      }
      if (into && /^\s*[-*]\s+/.test(line)) return ++n <= max;
      return true;
    })
    .join('\n')
    .trim();
}

/** "a story", "an iceberg", "an on-this-day": the kind with its article. */
const aKind = (f) => `${/^[aeio]/.test(kindName(f)) ? 'an' : 'a'} ${kindName(f)}`;

/** One format, as the pack block lists it: its kind, its size and its cover patterns. */
function formatLine(f) {
  const [lo, hi] = contentRange(f);
  const hooks = hookPatterns(f)
    .map((h) => `[${h.id}] ${h.pattern}${h.examples.length ? ` (e.g. ${h.examples.map((x) => `"${x}"`).join(', ')})` : ''}`)
    .join(' / ');
  return `- ${f.id}: "${f.name}", ${aKind(f)} post, ${lo} to ${hi} content slides. ${f.about || ''} Cover patterns (adapt, never copy word for word; where a pattern has a colon or a teaser, say it as one plain sentence or question): ${hooks}`;
}

/**
 * Block 1: the pack. Stable for every call about this account. `ttl` is the
 * cache duration: '1h' for batches (their rounds can be more than five minutes
 * apart), '5m' for direct calls.
 */
export function packBlock(pack, { ttl = '5m' } = {}) {
  const banned = [...CONNECTIVES, ...FORMAL, ...FILLER, ...BUREAUCRATIC, ...AD, ...TEASER, ...CALQUES].map((t) => t.p).concat(pack.rules.bannedPhrases || []);
  const legacy = (pack.formats.formats || []).every((f) => kindName(f) === 'list');
  // An account that asked for short captions gets a tease, not a summary.
  const capLong = limitsFor('captionLong', pack);
  const capShort = limitsFor('captionShort', pack);
  const shortCaps = capLong.maxChars < LIMITS.captionLong.maxChars;
  return {
    cache: ttl,
    text: `You plan and write Hebrew social slideshow posts for one account, from source documents.

THE ACCOUNT: "${pack.meta.displayName}" (@${pack.meta.handle}). It is about: ${(pack.meta.topics || []).join(', ')}. Its audience: ${pack.meta.audience || 'Hebrew speakers in Israel'}.
${pack.meta.description || ''}

THE ACCOUNT'S VOICE (its own guide, follow it):
${trimVoice(pack.voice)}

ITS FORMATS (every post is one of them; the request names which, and which cover pattern to follow):
${(pack.formats.formats || []).map(formatLine).join('\n')}

THE SHAPES (what each kind of post is made of; "role" names a content slide's job):
${shapesPrompt(pack)}

The kind of question its captions end with (examples of the tone, not lines to copy): ${(pack.formats.caption?.questions || []).join(' / ')}
${
  legacy
    ? ''
    : `
EVERY POST:
- 5 to 8 slides with the cover. One idea per slide. The best item, the payoff, is on the last slide: the slideshows that spread end on their strongest slide, never on a request to follow, save or comment. Never write a call to action on a slide.
- WHAT SPREADS ON TIKTOK (25 slideshows over 500K views, read slide by slide): one short line on one real photograph a slide, the way a person types on their phone. A sport or story slide holds 5 to 15 words: the title is the point, the body empty or one short line (a facts slide has no body at all: body ""). A title is at most 60 characters. A slide nobody can read in two seconds is skipped. Covers are about 7 words with a count or a famous name ("7 דברים שלא ידעתם על ליגת העל", "5 טעויות שעשיתי בשנה הראשונה").
- The cover is one bold claim or one question, narrow and specific, with a famous name in it when there is one. It opens a gap the slides close ("שלא ידעתם", a count, a number one kept for the end); it never promises what the post does not deliver, and it never hides what the post is about.
- Facts in every kind of post come from the documents: a story, a quiz or an opinion holds only facts the quotes support.
- keywords: 3 to 6 words people would search for, shown on the slides: names, the topic, the competition. At least one in Hebrew and one in English letters.
- Today's date is in the request. Anything that happened more than a year before it is told with its year on the cover or the first slide, as what it shows or teaches now: never as news, never as if it just happened.
- Every slide adds something the cover and the slides before it did not: no slide and no graphic repeats another's numbers or point.
- Every slide's title is a whole, concrete statement a reader gets alone, with a name, a number or a moment in it: never a bridge line that only points at the next slide ("וגם ניצחון לא הבטיח כלום", "ואז הכל השתנה", "אבל זה לא הסוף") and never a slogan. A story's beats go in the order they happened, each one step further than the last.
- A claim of "the only", "the first", "never" or "every" keeps every condition its fact has: "the only player to win all six" shortened to three of them is false. Keep the whole list, or drop the "only".
- Name what the post is about (the product, the person, the club, the fight) on the cover or the first slide: a post that never says whose story it is reads as a riddle nobody asked for.
${captionStyleOf(pack) === 'short' ? `- story: the TikTok caption is short: story.hook is ONE line of at most ${BEAT.hookMaxChars} characters, the cover's promise said another way with the words people search for (the code uses it alone, and problem, discovery and result are ""). It may be the cover line itself, as the viral posts' captions are. Never a list of the slides' names: a list that leaves some out reads as a wrong summary. A countdown's or a list's caption gives none of its items away (the reader swipes for them). captionShort: the Instagram caption, one line of up to ${Math.min(capShort.maxChars, 120)} characters. Neither has hashtags (the engine adds the post's own, ${MAX_HASHTAGS} at most), links or a question.` : `- story: the TikTok caption, told as a story in four beats that the code puts one a line: hook (one sentence of at most ${BEAT.hookMaxChars} characters that stops the scroll: TikTok shows it before "more"), problem (what was at stake, what went wrong, or the question the post settles), discovery (the turn: what the slides found), result (how it ended, or what it means for them now). Each beat ${BEAT.minWords} words or more, at most ${BEAT.sentences} sentences, and none repeats another. Together ${shortCaps ? `${capLong.minChars} to ${capLong.maxChars} characters: short and catchy, each beat one short line, with the names people search for` : '200 to 600 characters, in the words people search for (the names, the topic)'}. The beats retell the slides: the post's best fact, quote or twist is on a slide, never only in the caption, and the caption promises nothing the slides do not show ("what Cavani said years later" with no slide that says it reads as a broken promise). A guess-who's result never names the answer and a ranking's never names number one: it says what the last slide settles, not how. captionShort: the Instagram caption, ${capShort.maxChars < LIMITS.captionShort.maxChars ? `up to ${capShort.maxChars} characters, one catchy line` : '60 to 200 characters'} (the design puts the cover line before it). Neither has hashtags (the engine adds the post's own, ${MAX_HASHTAGS} at most), links or a question.`}

VISUALS: a post is pictures as much as words, never a deck of text cards. At least half of the slides carry a visual: the cover always has one, and the request says how many content slides need one. A content slide's "visual" is data the design draws as a graphic; its numbers are claims like the slide's own, held to the facts the slide cites. A head-to-head "stat" slide's two values are already its visual (give it type "none"). The graphics this account draws:
${visualsPrompt(pack)}
  Unused fields are "", and type "none" means no graphic. A visual adds what the words do not: the timeline of the moment, the numbers side by side, where the players stood. It never repeats the title as a picture.
- imageQuery on a content slide: 2 to 5 English words naming one real, famous person or place the slide is about ("Steven Gerrard", "Wembley Stadium"), or the thing it shows ("espresso machine", "octagon cage"), for a licensed photograph of exactly them; the engine checks the picture shows them and drops it otherwise. A photograph is the best visual a slide can have: ${pack.meta.imagery?.providers?.length ? 'give one to every slide: the person, the place or the thing it is about, and when it is about none of them, a scene that fits it ("football stadium at night", "boxing gloves", "laptop on a desk"); never ""' : 'this account uses no photographs: always ""'}. Never a logo, a crest, a screenshot or a product.
- coverVisual: the cover's graphic when no photograph is used: the most striking number or match-up of the post, as one visual of the types above (a stat, a compare...), or type "none" to let the design draw the kind's own art. A date is the cover's graphic only on a post about that day (this day in history, a fight's date): a past date as the biggest thing on a cover reads as old news.
`
}
${legacy ? '' : templatesPrompt(pack)}
${HEBREW}
- Never claim to have tried, bought, used, visited or seen anything. The account explains; it does not have experiences. The one exception is an owner-story post: the documents titled "${OWNER_TITLE}..." are the business owner's own words, and a slide that cites one of their facts tells it in the owner's first person, exactly as much as the fact says and no more.
- Never mention another account, a follower count, views, a badge or "official".
- Never these words: ${banned.join(', ')}.
${compliance(pack)}`,
  };
}

const OUTLINE_TASK = {
  cache: '5m',
  text: `TASK: PLAN ONE POST.

The request names the post's format and its kind, how many content slides it has, and gives the source documents. Decide whether the documents can carry this post honestly, and extract the facts it will stand on.

Facts:
- A fact is something a slide will state. Each fact has a quote copied character for character from ONE document (doc: its id, D1, D2...): its exact words, 4 to {maxQuote} words (8 or more where the document allows), no ellipsis, no paraphrase, no translation, no joining two sentences or two lines. A table row is one line, its cells joined with " | ": quote the row as it is written. Pick quotes that contain every number the claim states, written as digits where the document has digits. A labelled table row may be shorter than 4 words, as it is written ("Wins | 17", "Reach | 69 in (175 cm)"), when it is in the document once.
- The claim is the fact in plain spoken Hebrew, as the account would say it. It may translate or simplify the quote; it may never add to it. A term it translates (a weight class, a title, a legal term) takes its own Hebrew name, never a neighbouring one: the slides follow the claim. It keeps what each word in the quote belongs to: "the first manager of an English team" is not "the first English manager" (the man was Scottish), and "the club's first title" is not "the first title".
- Never state anything the documents do not say. Never add a number that is not in the quote. A date is a number too: a claim that says when something happened or changed needs a quote that contains that date, or it leaves the date out.
- Prefer facts that are specific, surprising and new to most people over general statements.
- A vendor's forecast or guidance, and the numbers of a demo, an example or a sample run, are claims, not results: the claim says whose forecast or which demo it is, and a post never stands on them.
- An ATTRIBUTED fact is what someone said or reported, not what is so: a fighter's own account of a fight, a manager's claim, an investor's version, an outlet's report of a rumour. Give it who: the person or outlet as the document names them ("Dana White", "Sherdog"), and whoHe: how a Hebrew slide writes their name ("דנה וייט"). Its quote is their words, or the document's report of them, and the document must say beside the quote that they said or reported it. The slide that states it names them and says so ("לפי דנה וייט", "וייט סיפר"), never as plain fact. Two at most in a post: the rest stands on facts. A plain fact has who and whoHe "".
- The angle. A story every fan of the niche already knows (the most famous final, upset or goal) is no post told the usual way: tell it through a detail from the documents most of them have never heard, and lead with that detail (the cover and the first slide). If the documents hold no such detail, prefer usable=false.

Items: the content slides in order, each { role, point: what the slide says in a few Hebrew words, facts: the fact ids it states }. The roles follow the kind's shape (THE SHAPES). Every item states at least one fact, except the roles the shape says carry none.

RESEARCH COMES NEXT. After this plan, the engine reads the articles you name in "research" and pulls the details out of them (who said what, the minute, the moment, what came before and after), each checked against its source. So when these documents name a famous moment but do not tell it (a career article that mentions the goal, a list that has the result), the post is still usable: plan it, name the article that tells the moment in "research", and leave the facts of the slides that need those details empty: research fills them, and a slide still without a fact after research is dropped. The facts you write here still come only from these documents. Unusable means nothing here is worth a post, not that the details are missing.

subject: what the kind needs, "" for the rest: a and b (the two sides of a head-to-head; a alone for what-happened), answer (guess-who), date (on-this-day, in Hebrew with the year).
topic: the post's subject in a few Hebrew words.
imageQuery: 2 to 5 English words for a licensed photograph that would suit the post (a famous person or place by name is fine where the account's rules allow it; never a logo, a crest, a badge, a screen, an injury); or "" if none would. The person the post is about, by full name (Cristiano Ronaldo, never Ronaldo alone), as they looked in the story's years. Whoever the cover shows, the cover line names (except a facts or tips post's, below): a face the cover does not explain is a stranger (a World Cup iceberg went out with an old man nobody could name, a scorers' ranking with a close-up of its number three). A ranking's cover never shows its number one (it spoils the countdown): name someone else on the list whom the cover line names too, or "". A facts or tips post's cover is the most famous face on its list, by full name (every countdown that spread opened on a star the whole audience knows on sight, unnamed on the cover: Dana White, Bruce Buffer, Messi), never the last slide's subject, and never a crowd, a building, an arena, a cage or a ball. A guess-who names its answer: the design shows it blurred until the reveal. A head-to-head names side a here and side b in imageQueryB (full names in English): the cover shows the two side by side.
imageQueryB: a head-to-head's side b, as above; "" for every other kind.
research: 1 to 4 titles of encyclopedia articles, or short search phrases, that would tell this post's subject in more detail than these documents: the match, the fight, the event, the person, the product or company itself ("2005 UEFA Champions League final", "Natan Levy"). The engine reads them before the slides are written, for the details a fan would want. [] when the documents already hold them.

A story, a what-happened or an on-this-day needs its ending: the post's last slide says how it ended (the result, the outcome, where it stands now). If neither these documents nor the articles you name for research would say it, the post is not usable.

If the documents cannot carry this post with real, specific facts, return usable=false with the reason, and empty facts and items.`,
};

const SLIDES_TASK = {
  cache: '5m',
  text: `TASK: WRITE ONE POST'S TEXT.

The request names the format and its kind, the content slides with their roles, the verified facts, the outline and the cover pattern to follow. Write:
- hookTemplate, hookSlots, hookFacts: when the request offers COVER TEMPLATES, the cover is written from the first of them, in the order given, whose promise this post's facts keep (COVER TEMPLATES above): its id, the words for its slots, the ids of the facts it promises. When none does, hookTemplate is "", every slot "" and hookFacts [], and the hook follows the cover pattern.
- hook: the cover line. 3 to 11 words. From a template, it is the template with its slots filled (the code writes it again from hookSlots, in the account's voice). Otherwise after the cover pattern the request names (adapt it to this post, never copy it word for word). It makes them need the second slide: a real question or a concrete fact that only the slides explain ("איך ברצלונה הפכה 4:0 ל-6:1 בקאמפ נואו?" pulls; "ברצלונה ניצחה 6:1" is already over), built on the post's most surprising concrete detail where the pattern allows (a score, a sum, a quote, a name). It names what the post is about, as one sentence or one question: no colon, no label, no teaser that hides the subject. Never only the famous name of the story, and never the payoff the last slide holds. A count it promises ("3 רמזים", "5 ...") is the count of the slides that follow. A number only if it is the number of content slides, a top 5 or 10, or it appears in a fact's quote. hookPattern: that pattern's id.
- sub: one short line under the cover line, or "" when the cover line alone fills the cover's lines (LINES in the request).
- hookHighlight, and each slide's highlight: the one word or short phrase (up to 3 words) of the cover line, or of that slide's title, that the design marks in the account's colour: the number, the name or the word the line turns on, copied exactly as it is written there; or "" when nothing in it stands out. One a slide at most, never the whole line.
- subject: as in the outline (you may shorten a name).
- slides: exactly the outline's content slides, the same roles in the same order, each { role, title: up to 60 characters, body: up to 230 characters in one to three short sentences, broken into lines as the request's LINES says (or one item a line, where the shape says so), a and b: the two values on a head-to-head stat slide and "" everywhere else, facts: the ids of the facts it states }. Every number on a slide, dates and years included, must appear in the quotes of the facts it lists.
- story, captionShort, keywords: as the account's rules say. For a legacy list post, the story may be in "hook" alone, and captionShort and keywords may be empty.
- question: one short question about this post's own subject that a reader could answer from their own life, or "" when none would sound natural. Never a line that fits any post ("ידעתם את זה?", "מה דעתכם?", "למי זה יכול לעזור?"): those are dropped.

${READ_ALOUD}`,
};

const REWRITE_TASK = {
  cache: '5m',
  text: `TASK: REWRITE FLAGGED TEXTS.

A reader flagged some texts of a post: as sounding like a bot (and said what gave each away), or as saying more than the post's facts support (a FACT PROBLEM). Rewrite each flagged text so a person would have written it, in the account's voice: say it the way you would say it out loud to a friend, then write that down. A tell is in a sentence's shape as often as in a word, so rebuild the sentence around what it says; never swap one word for a synonym and keep the shape. Follow HEBREW THAT SOUNDS LIKE A PERSON, and keep the rhythm uneven: a rewritten slide does not end on a punch line because the others do. Where there is a FACT PROBLEM, say only what the facts support: drop or soften the part that goes beyond them. Keep every fact and every number that is supported; add none; keep about the same length. A TikTok caption ("caption") is a story in four lines, hook, problem, discovery and result: rewrite it as four lines again, one beat a line. A cover written from a cover template keeps the template's own words: change only the words in its slots. Return { index, text } for each flagged text you were given, using its index. A flagged "visual" is a slide's graphic, given as its data (JSON): return it corrected as the same JSON in "text", every name and number from the facts its slide may use, or "" to drop it.`,
};

const REPAIR_TASK = {
  cache: '5m',
  text: `TASK: REPAIR WHAT THE CHECKS REFUSED.

The code checks refused some texts of one post. The request gives each of those texts (its target), what it may use, and the checks' exact messages. Rewrite only those texts so that every message is answered, and keep the rest of each text: its point, its facts, the account's voice, the line breaks the LINES rule asks for. The other texts of the post are not yours to change.
- A slide (target "slide N"): return title, body, a and b (a stat slide's two values, "" otherwise) and facts: the ids of the facts the slide states.
- The cover ("cover"), the line under it ("cover line 2") and the Instagram caption ("caption short"): return the text in "text". A cover written from a cover template keeps the template's own words and changes only what fills its slots, or, when its promise cannot be kept, becomes a plain line with none of the template's words.
- The TikTok caption ("caption"): "text" holds four lines, hook, problem, discovery and result, one a line, the closing question at the end of the last.
- The keywords ("keywords"): "text", separated by commas, at least one in Hebrew and one in English letters.
A NUMBER THE QUOTES DO NOT HOLD is repaired one of two ways, never a third: remove the number, or cite (in facts) a listed fact whose quote holds it. Never a new fact, a new source or a different number: the code refuses a repair that states a number its text did not, or that cites an id that is not listed.
Return one repair for each target, with the target exactly as given, and "" in the fields it does not use.`,
};

const DETAILS_TASK = {
  cache: '5m',
  text: `TASK: FIND THE DETAILS.

The request gives one post's topic, its plan, the facts it already has, and more documents about its subject (R1, R2...). Pull out the specific details a fan would want and the facts do not already say:
- quote: what someone involved said, in the source's words (who said it is part of the claim)
- time: the minute, the round, the date or the hour something happened
- moment: exactly what happened at the turn of the story
- backstory: what came before, that makes the moment matter
- after: what happened or what people said afterwards
- number: one number that tells the story (a score, a crowd, a price, a count)
Each detail: { id: X1, X2..., kind: one of the six above, claim: the detail in plain spoken Hebrew (it may translate the quote, never add to it, and keeps what each word belongs to: "the first manager of an English team" is not "the first English manager"), quote: copied character for character from ONE document, 4 to {maxQuote} words, every number the claim states included, doc: that document's id, item: the number of the plan's slide it belongs on (1, 2...), or 0 }. A slide of the plan that has no fact yet needs its details most: give it at least one, or it is dropped.
A quote detail is usually ATTRIBUTED: give who (the person as the document names them) and whoHe (their name as a Hebrew slide writes it); every other detail has who and whoHe "". The document must say beside the quote that they said it, and the post carries two attributed facts at most.
Only details about this post's own subject, 3 to 8 of them, none that repeats a fact the post already has. A detail a document does not state is never written: when the documents hold fewer than 3 such details, return the ones they hold, and the engine leaves the topic for another.`,
};

export function detailsPrompt(pack, { ttl = '5m' } = {}) {
  const maxQ = pack.rules.maxQuoteWords || 40;
  return { system: [packBlock(pack, { ttl }), { ...DETAILS_TASK, cache: ttl, text: DETAILS_TASK.text.replace('{maxQuote}', maxQ) }], schema: DETAILS_SCHEMA };
}

/** The details call's user turn: the post so far, then the research documents. */
export function detailsUser({ format, outline, facts, docs, maxChars = 12000 }) {
  const per = docs.length ? Math.max(2500, Math.floor(maxChars / docs.length)) : maxChars;
  return [
    formatHead(format),
    `TOPIC: ${outline.topic}`,
    outline.subject ? `SUBJECT: ${Object.entries(outline.subject).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') || '(none)'}` : '',
    'THE PLAN:',
    ...(outline.items || []).map((it, i) => `${i + 1}. ${it.role || 'item'}: ${it.point}${(it.facts || []).length ? '' : ' (no fact yet)'}`),
    'FACTS THE POST ALREADY HAS (do not repeat them):',
    ...facts.map((f) => `- ${f.claim}`),
    ...docs.map((d) => `<document id="${d.ref}" source="${d.sourceName || ''}" url="${d.url}">\n${d.title ? `# ${d.title}\n` : ''}${String(d.text).slice(0, per)}\n</document>`),
  ]
    .filter((x) => x !== '')
    .join('\n\n');
}

export function outlinePrompt(pack, { ttl = '5m' } = {}) {
  const maxQ = pack.rules.maxQuoteWords || 40;
  return { system: [packBlock(pack, { ttl }), { ...OUTLINE_TASK, cache: ttl, text: OUTLINE_TASK.text.replace('{maxQuote}', maxQ) }], schema: OUTLINE_SCHEMA };
}

/** A ranking's rank slides, as the writer is told them before anything else. */
export function rankRules(pack) {
  // An account without the "stat" graphic draws no number big: its places say the number in the body alone.
  const stat = visualsOf(pack).includes('stat');
  return `RANK SLIDES: every "rank" slide, number 1's included, states the number that ranks its place${stat ? ' and shows it as its graphic: a "stat" visual whose value is that number' : ' in its body'}, with its scale written next to it ("25 מיליון", "8.2 מיליארד $"), never a year or another figure. Every place uses the same measure and the same unit, written the same way.${stat ? ' The body says the same number and one short line.' : ''} The places go from 5th to 1st in the order of that number, and no slide writes a place number: the design draws it.`;
}

/** What the request says about the format: its id, name and kind, and the size of the post. */
function formatHead(format, n = null) {
  const [lo, hi] = contentRange(format);
  return `FORMAT: ${format.base || format.id} ("${format.name}"), ${aKind(format)} post, ${n ? `exactly ${n}` : `${lo} to ${hi}`} content slides.`;
}

/**
 * The outline's user turn: this post's format, then the documents, narrowed to
 * their content. `day` (on-this-day): the date the post goes out on; `subject`:
 * a subject the post must be about (a fight week's main event). `niche`: the
 * rivals the owner watches, as nicheForOutline says them.
 */
export function outlineUser(format, docs, { avoid = [], faceless = [], maxChars = 7000, day = null, subject = null, why = null, maxAgeDays = null, niche = '' } = {}) {
  const per = docs.length > 1 ? Math.max(2500, Math.floor(maxChars / docs.length)) : maxChars;
  return [
    `${formatHead(format)}${format.trend ? ` ${format.about}` : ''}`,
    day ? `TODAY: ${day}.` : '',
    day && kindName(format) === 'on-this-day' ? `THE POST GOES OUT ON: ${day}. Pick a moment that happened on this day and month in an earlier year.` : '',
    subject ? `SUBJECT: ${subject}. The post is about this.` : '',
    // A topic chosen first (src/topics): why people stop for it. The documents still decide what is true; what a
    // document only reports is said as theirs, and a topic they do not hold up is "usable": false.
    why ? `WHY IT STOPS A SCROLL: ${why}. Build the post around that, with only what the documents say; what a document only reports or quotes, the post says as theirs. Documents that do not hold this subject up are "usable": false.` : '',
    // A matchup the documents hold one side of was planned anyway (Oliveira against Khabib), and every draft was refused.
    kindName(format) === 'head-to-head' ? `BOTH SIDES: choose two sides only when the documents give a value for each of them on at least ${kindOf(format).segments.find(([r]) => r === 'stat')[1]} of the same stats; each stat cites the facts whose quotes hold both values. Documents that give one side's numbers and not the other's are "usable": false, with that as the reason.` : '',
    // An undated page (an encyclopedia article) passes the date filter; the story inside it may still be years old.
    maxAgeDays && day && kindName(format) !== 'on-this-day'
      ? `FRESHNESS: this account's news ages fast. The post's story happened within ${maxAgeDays} days before TODAY, or it is a lasting how-to or price that is current now; an older launch, raise or failure is background at most, never the story.`
      : '',
    ...docs.map((d) => `<document id="${d.ref}" source="${d.sourceName}" url="${d.url}">\n${d.title ? `# ${d.title}\n` : ''}${focusText(d.text, { maxChars: per, numbersFirst: groupOf(format) === 'number' })}\n</document>`),
    avoid.length ? `Topics this account posted recently (do not repeat them): ${avoid.join(' · ')}` : '',
    faceless.length ? `Matchups with no licensed photograph of one side (choose two others, from the same card or the same documents): ${faceless.join(' · ')}` : '',
    // The rivals the owner typed in (src/pipeline/rivals.js): a subject still wins, and the documents still decide what is true.
    subject ? '' : niche,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function slidesPrompt(pack, { ttl = '5m' } = {}) {
  return { system: [packBlock(pack, { ttl }), { ...SLIDES_TASK, cache: ttl }], schema: SLIDES_SCHEMA };
}

/** How many content slides need a visual, so that with the cover at least half of the slides have one. */
export const visualsNeeded = (n) => Math.max(0, Math.ceil((n + 1) / 2) - 1);

export { everyPhoto } from '../formats/kinds.js';

/**
 * The overlay rules as the writer is told them (src/rules/overlay.js holds them and checks them): the
 * account's own numbers, so a pack that asks for longer lines is written for as it asks.
 */
export function linesRule(pack = null) {
  const o = overlayOf(pack);
  const [lo, hi] = o.wordsPerLine;
  const [a, b] = o.linesPerSlide;
  return `LINES: the words on a slide sit over a picture, read in a second. Break them by hand with "\\n": ${lo} to ${hi} words a line (only the last line of a text may be shorter), ${a} to ${b} lines on a slide, title and body together (on the cover, the cover line and the line under it together). A title is a reaction, what a person says when they see it ("81 יום, ואף אחד לא השקה"), never a label that names the part ("טיפ 3", "עובדה:", "התפנית"). A body that is a list (places 10 to 6, a layer) keeps one item a line.`;
}

/**
 * What the morning's feedback found, said to the writer (src/metrics/feedback.js): why this post is planned the
 * way it is, so the cover, the caption or the angle change where the numbers say they should. "" when it is not.
 */
export function steerLine(steer) {
  if (!steer?.kind) return '';
  const was = steer.hook ? `"${steer.hook}"` : 'a recent post';
  if (steer.kind === 'variation') return `FROM THE RESULTS: ${was} reached more people than this account's usual post, and more of them acted on it. This post is variation ${steer.n || 1} of ${steer.of || 3} of it: the same story and facts, a new cover line in the pattern named here. Never the words of ${was}.`;
  if (steer.kind === 'new-cta') return `FROM THE RESULTS: ${was} reached more people than usual, but few acted on it. Keep a cover as strong, in the pattern named here; the call to action is a different one, and write the captions a new way${steer.cta ? ` (the last call to action was "${steer.cta}")` : ''}.`;
  if (steer.kind === 'new-hooks') return `FROM THE RESULTS: ${was} reached fewer people than usual, but those it reached acted on it. Keep the call to action; the cover must be radically different from ${was}: another angle, another first word, and another kind of first-slide picture${steer.cover ? ` than its "${steer.cover}"` : ''}.`;
  if (steer.kind === 'new-angle') return `FROM THE RESULTS: ${was}${steer.format ? ` (${steer.format})` : ''} did poorly on views and on action. This post takes a new angle${steer.topic ? `, far from "${steer.topic}"` : ''}.`;
  if (steer.kind === 'redo') return redoLine(steer, was);
  return '';
}

/**
 * The customer rejected a post and asked for another (src/pipeline/redo.js): what they said, as the writer is told it.
 * Their own words go in quoted, as what they asked for, never as instructions to the writer about anything else.
 */
function redoLine(steer, was) {
  const note = String(steer.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const said = note ? ` In their words: "${note}".` : '';
  const head = `THE ACCOUNT'S OWNER REJECTED ${was}`;
  if (steer.reason === 'topic') return `${head} for its topic${steer.topic ? ` ("${steer.topic}")` : ''}. This post is about something else entirely.${said}`;
  if (steer.reason === 'shorter') return `${head} as too long. This is the same story with the same facts, told shorter: fewer words on every slide, the fewest lines the rules allow, nothing a fan would not miss.${said}`;
  if (steer.reason === 'tone') return `${head} for its tone. This is the same story with the same facts in a different tone, never its words.${said}`;
  if (steer.reason === 'photo') return `${head} for its photographs. This is the same story; give the slides different image searches (imageQuery) from the ones it had, showing other moments or other angles.${said}`;
  return `${head} and asked for it again with a change.${said} Keep the facts; change what they asked for, and nothing they did not.`;
}

export function slidesUser({ format, n, outline, facts, edits = [], problems = [], lastDraft = null, hook = null, templates = [], cta = null, day = null, pack = null, steer = null, niche = '', style = null }) {
  const legacy = kindName(format) === 'list';
  const body = limitsFor('slideBody', pack);
  const sub = limitsFor('sub', pack);
  const end = pack?.meta?.endSlide?.title;
  return [
    `${formatHead(format, n)}`,
    // Said first, not left to the format's paragraph: rankings were refused for a place without its graphic, and
    // ordered wrong when one place wrote "8,200" over "מיליון דולר" and the next "25 מיליון".
    kindName(format) === 'ranking' ? rankRules(pack) : '',
    day ? `TODAY: ${day}.` : '',
    // The templates first, the format's pattern for a post no template fits (src/formats/hooks.js).
    templates.length ? `COVER TEMPLATES FOR THIS POST, best first: ${templates.map((t) => `[${t.id}]`).join(', ')}. The cover is written from the first whose promise these facts keep, speaking ${SPEAKER_EN[speakerOf(pack)]}; "" when none does.` : '',
    hook ? `COVER PATTERN${templates.length ? ' (when no template fits)' : ''}: [${hook.id}] ${hook.pattern}${hook.examples?.length ? ` (e.g. ${hook.examples.map((x) => `"${x}"`).join(', ')})` : ''}` : '',
    format.trend ? `Cover lines that fit this post: ${format.hooks.join(' / ')}` : '',
    end && !legacy && !everyPhoto(pack, format, style) ? 'The design adds a closing slide that asks them to follow the account: no slide asks to save, send, follow or comment.' : cta && !legacy ? `The design ends the last slide with this call to action, so the slides do not say it: "${cta.text}"` : '',
    body.maxChars < LIMITS.slideBody.maxChars ? `TEXT: this account keeps slides short. A slide's body is at most ${body.maxChars} characters and ${body.sentences} sentences: one point, the words a fan would say, no number the point does not need.` : '',
    sub.maxChars < LIMITS.sub.maxChars ? `SUB: the line under the cover is at most ${sub.maxChars} characters, one punchy line that makes them swipe (the stakes or a tease, never an explanation of the topic), or "".` : '',
    !legacy && everyPhoto(pack, format, style)
      ? `PHOTOGRAPHS: every slide stands on its own real photograph, the way the slideshows that spread do. Every content slide has an imageQuery: the person, the place or the thing it is about, by name ("Khabib Nurmagomedov", "Bloomfield Stadium", "espresso machine"). A graphic (visual) only where a photograph cannot show the point (a table of prices, two numbers side by side), else type "none".`
      : !legacy && (style || pack?.meta?.style?.name) && pack?.meta?.imagery?.providers?.length
        ? `PHOTOGRAPHS: every slide stands on a real photograph, and no photograph stands on all of them. Every content slide has an imageQuery: the person, the place or the thing it is about, by name ("Khabib Nurmagomedov", "Bloomfield Stadium"), or a scene that fits it. VISUALS: at least ${visualsNeeded(n)} of the ${n} content slides also carry a visual (a stat slide's two values count).`
        : !legacy ? `VISUALS: at least ${visualsNeeded(n)} of the ${n} content slides carry a visual (a stat slide's two values count).` : '',
    linesRule(pack),
    styleRoomFor(pack, style),
    steerLine(steer),
    niche,
    `TOPIC: ${outline.topic}`,
    !legacy && outline.subject ? `SUBJECT: ${Object.entries(outline.subject).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') || '(none)'}` : '',
    'FACTS (state only these; cite their ids):',
    ...facts.map((f) => `- ${f.key}${f.detail ? ` (detail: ${f.detail})` : ''}${f.who ? ` (ATTRIBUTED to ${f.whoHe || f.who}: the slide says "לפי ${f.whoHe || f.who}" or "${f.whoHe || f.who} סיפר", never as plain fact)` : ''}: ${f.claim}  [quote: "${f.quote}"]`),
    facts.some((f) => f.detail)
      ? ['facts', 'tips'].includes(kindName(format))
        ? `DETAILS: the facts marked "detail" are more of the same kind. One may be a slide's fact when it is stranger than the outline's, in place of it, never a second line under another.`
        : `DETAILS: the facts marked "detail" are the specific moments, words and numbers a fan keeps. Put at least ${Math.min(3, facts.filter((f) => f.detail).length)} of them on the slides, each on the slide it belongs to, cited by its id: they are what makes this post worth finishing.`
      : '',
    'OUTLINE:',
    ...outline.items.map((it, i) => `${i + 1}. ${legacy ? '' : `${it.role || 'item'}: `}${it.point} (facts: ${(it.facts || []).join(', ') || 'none'})`),
    edits.length ? `\nLines the account's owner rewrote by hand recently (write like the AFTER versions):\n${edits.map((e) => `- before: ${e.before}\n  after: ${e.after}`).join('\n')}` : '',
    problems.length ? `\nTHE LAST DRAFT WAS REFUSED BY THE CHECKS. Fix exactly these and keep everything else:\n${problems.map((p) => `- ${p}`).join('\n')}` : '',
    // The draft itself: without it, "keep everything else" was a new draft from scratch, with new mistakes.
    problems.length && lastDraft ? `\nTHE LAST DRAFT (change only what the checks named, keep the rest word for word):\n${JSON.stringify(lastDraft)}` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export function rewritePrompt(pack, { ttl = '5m' } = {}) {
  return { system: [packBlock(pack, { ttl }), { ...REWRITE_TASK, cache: ttl }], schema: REWRITE_SCHEMA };
}

export function rewriteUser({ flagged, facts }) {
  const limits = (l) => (l ? `; at most ${l.maxChars} characters${l.sentences ? ` and ${l.sentences} sentences` : ''}` : '');
  return [
    'FACTS THE POST STANDS ON (each with its id and what the source says):',
    ...facts.map((f) => `- ${f.key ? `${f.key}: ` : ''}${f.claim}${f.quote ? ` (source: "${f.quote}")` : ''}${f.who ? ` (ATTRIBUTED to ${f.whoHe || f.who}: a text stating it names them and that they said it)` : ''}`),
    '',
    'FLAGGED TEXTS (every number in a text must be in the source words of the facts it may use):',
    ...flagged.map((x) =>
      [
        `[${x.index}] (${x.where}${x.botScore >= 4 ? `, gave away: ${(x.tells || []).join(', ') || 'too polished'}` : ''}${x.factProblem ? `, FACT PROBLEM: ${x.factProblem}` : ''}${limits(x.limits)}${x.uses?.length ? `; it may use facts ${x.uses.join(', ')}` : ''}) ${x.text}`,
        x.last ? `    your last rewrite: ${x.last}\n    REFUSED BY THE CHECKS: ${x.refused.join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
  ].join('\n');
}

export function repairPrompt(pack, { ttl = '5m' } = {}) {
  return { system: [packBlock(pack, { ttl }), { ...REPAIR_TASK, cache: ttl }], schema: REPAIR_SCHEMA };
}

/**
 * The repair's user turn: the facts the post may cite, then each refused text with the checks' messages.
 * targets: [{ target, now: { text } | { title, body, a, b, facts }, problems: [msg], limits, last, refused }].
 */
export function repairUser({ format, topic, facts, targets, pack = null, style = null }) {
  const lim = (l) => (l ? ` (at most ${l.maxChars} characters${l.sentences ? ` and ${l.sentences} sentences` : ''})` : '');
  return [
    formatHead(format),
    `TOPIC: ${topic}`,
    linesRule(pack),
    styleRoomFor(pack, style),
    'FACTS THE POST MAY CITE (each with its id and the words of its source):',
    ...facts.map((f) => `- ${f.key}${f.who ? ` (ATTRIBUTED to ${f.whoHe || f.who}: name them and that they said it)` : ''}: ${f.claim}  [quote: "${f.quote}"]`),
    '',
    'REFUSED TEXTS:',
    ...targets.map((t) =>
      [
        `[${t.target}]${t.role ? ` role: ${t.role}` : ''}${lim(t.limits)}`,
        ...('text' in t.now ? [`  now: ${JSON.stringify(t.now.text)}`] : [`  now: title ${JSON.stringify(t.now.title)}, body ${JSON.stringify(t.now.body)}${t.now.a || t.now.b ? `, a ${JSON.stringify(t.now.a)}, b ${JSON.stringify(t.now.b)}` : ''}, facts ${(t.now.facts || []).join(', ') || 'none'}`]),
        `  REFUSED BY THE CHECKS: ${t.problems.join(' · ')}`,
        t.last ? `  your last repair: ${JSON.stringify(t.last)}\n  REFUSED AGAIN: ${t.refused.join(' · ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** The room the account's slide style gives each text (src/render/styles/fit.js), or "" for the older templates. */
export function styleRoomFor(pack, style = null) {
  const name = style || pack?.meta?.style?.name;
  return name ? styleRoom(name, { platforms: pack?.meta?.platforms || ['tiktok'] }) : '';
}

/** The kind's own instructions, for tests and tools that show one. */
export const kindPrompt = (format) => kindOf(format).prompt;
