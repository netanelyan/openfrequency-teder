import { askJson } from '../llm/index.js';
import { normHe, postTells, sentencesOf, softTellsIn, tellsIn } from './tells.js';

// The second look: does this sound like a bot?
//
// A separate call with a different job from the drafting call (Claude Sonnet
// 5.5: Haiku was measured and missed what this call is for, see src/llm/index.js).
// It runs only on a post that already passed every code check cleanly, reads its texts as a sharp Israeli in their twenties
// would, and scores each from 0 (a person wrote it) to 10 (obviously a bot),
// naming the tells, and says when a text claims more than its facts. It only
// scores: a text it flags at REWRITE_AT or more, or with a fact problem, is
// rewritten by the drafting model in one more call, once, and a rewrite
// replaces the original only if it passes the same code checks; what it does
// not fix drops the post. A post with nothing flagged costs one call here.
//
// The code's hints go with the texts (hintsFor): what is a tell most of the time
// and not always ("לא X אלא Y", "כ-80", a one-word sentence), and what only shows
// across the post (every sentence the same length, every slide ending on a punch
// line, one word on every slide). The reviewer reads the sentence and decides.
//
// With no API key the reviewer is a heuristic built from the same tells and
// hints. It is labelled as such on the website: it can say a text has tells, it
// cannot say a text without them sounds human.

export const REWRITE_AT = 4;
export const BLOCK_AT = 6;

export const REVIEW_SYSTEM = `You are a sharp Israeli in your twenties. You scroll TikTok and Instagram in Hebrew all day and you can smell a bot, a marketer or a ChatGPT text from the first line. You also know what a person sounds like: someone saying it out loud to a friend, specific, a little informal, the sentences long and short.

You get the texts of one slideshow post: the cover line, each slide, the captions. For each text, answer honestly: would you guess a bot wrote this?

What gives a Hebrew text away (each one raises the score):
- Ad structures: "זה לא X, זה Y", "לא עוד X", "בלי X ובלי Y", "פחות X, יותר Y", a triad of adjectives or a perfectly balanced pair of sentences, three short fragments in a row for drama ("מהיר. קל. זול."), a one-word sentence for emphasis, a label with a colon ("עובדה:", "דעה לא פופולרית:", a date and a colon).
- Teasers that hold back the point: "זה מה שקרה כש...", "הנה למה", "והראשון מפתיע", "לא תאמינו", a hyphen before the payoff. A real question about a named, concrete subject is fine; a hidden subject is not.
- Every slide ending on the same short punch line ("אף אחד לא קרוב.", "ואז הכול השתנה."), every slide opening the same way, every sentence the same length, every title the same template.
- Claims with nothing behind them: a superlative with no number, "מהפכה", "משנה את כללי המשחק", abstract nouns ("חוויה", "פתרון", "פלטפורמה") where a thing could be named.
- Form or brochure Hebrew: "ניתן", "על מנת", "במידה ו", "בגין", "נדרש", "באמצעות", a passive with "על ידי", "כ-80" where a person says "בערך 80". Translated Hebrew: "בסופו של יום", "עושה את ההבדל", "כשזה מגיע ל", English word order or idioms in Hebrew letters.
- A moral or a summary at the end, a stock opener, a polite assistant line, engagement bait ("תייגו", "מה דעתכם?").

What a person writes: the concrete detail first (a number, a name, a minute, a place), plain verbs, everyday words ("אפשר", "צריך", "בערך"), an opinion said as an opinion, and an uneven rhythm. A short, plain, specific sentence is human: never mark it down for being simple.

- botScore: 0 means clearly a person wrote it, 10 means obviously a bot. Be strict: a text that is balanced, complete and polished, that sounds like a brochure, an ad or a school summary, scores high. One clear tell is 4 or more; two are 6 or more.
- tells: only what gives it away, a few English words each, naming the pattern ("not-X-but-Y", "fragments", "teaser", "translated Hebrew", "brochure tone", "same rhythm as the other slides"). Empty when nothing does.
- Some texts come with HINTS: what a code check noticed in them. A hint is not a verdict: it is often right, and sometimes the sentence is fine as it is (a real "לא X אלא Y", three names in a row). Weigh it, and put it in tells only when you agree.
- factIssue: true only if the text states something its facts do not support. factProblem: when factIssue is true, what; else an empty string (never a note that concludes the text is fine). The source's own words decide: a fact whose summary says more than its source supports nothing. A text marked as a myth, a joke, an opinion or a question to the reader is not the post's claim: a myth is wrong on purpose (the next slide corrects it). Flag it only when a fact inside it (a number, a name, a result) is wrong. Every specific detail a text states (a name, a number, a minute or a round, a quote, what someone said, the moment itself) must be in the source words of the facts above: a detail none of them holds is a fact problem, however likely it sounds. A claim of "the only", "the first", "never" or "every" that leaves out conditions its fact has is a fact problem: "the only one to win A, B and C" is false when the fact says the only one to win A, B, C, D, E and F.`;

/**
 * What a slide that carries no fact of its own is doing, so the review does not
 * take a myth for the post's claim (the launch set's review did: it flagged "there
 * are no rules in that sport", the myth its next slide corrects).
 */
const ROLE_NOTE = {
  myth: 'a myth as people say it, corrected on the next slide',
  joke: "a joke's setup",
  verdict: "the account's opinion, labelled as one",
  ask: 'a question to the reader',
  visual: "a graphic's labels and values: check only that its names and numbers are in the facts; botScore 1",
  // A cover from one of the account's hook templates (src/formats/hooks.js): the frame is a proven opener the code
  // checked the slides pay off, so only the words in its slots are the writer's.
  template: "a cover written from one of the account's hook templates: its fixed opening is the account's own, held back on purpose and paid off by the slides; judge the words that fill it, and flag a promise the facts do not keep",
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          botScore: { type: 'integer' },
          tells: { type: 'array', items: { type: 'string' } },
          factIssue: { type: 'boolean' },
          factProblem: { type: 'string' },
        },
        required: ['index', 'botScore', 'tells', 'factIssue', 'factProblem'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
};

const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));

/** Who is talking, in a few lines: the reviewer needs the register, not the whole guide. */
const whoTalks = (pack) => (pack.voice.split(/\n## /)[1] || pack.voice).replace(/^[^\n]*\n/, '').trim().slice(0, 900);

/**
 * What the code noticed in each text and across the post (src/voice/tells.js softTellsIn, postTells): the hints
 * that go beside each text to the reviewer, and that the offline reviewer scores. One list per text.
 */
export function hintsFor(texts, facts = []) {
  const out = texts.map((t) => (t.kind === 'visual' ? [] : softTellsIn(t.text, { kind: t.kind })));
  const known = facts.map((f) => `${f.claim || ''} ${f.whoHe || ''}`).join(' ');
  for (const p of postTells(texts, { known })) for (const i of p.indexes) out[i]?.push(p.note);
  return out;
}

/** The review's user turn: who is talking, the facts, the texts numbered, each with what the code noticed. */
export function reviewUser(pack, texts, facts = []) {
  const hints = hintsFor(texts, facts);
  return [
    `ACCOUNT: ${pack.meta.displayName}. Who is talking, from the account's voice guide:`,
    whoTalks(pack),
    '',
    // Each fact with the source's own words: a claim is the drafting model's paraphrase of its
    // quote, and one that misread it ("middleweight" for a quote that says welterweight) was
    // invisible to a review that saw only the claims.
    'FACTS THE POST STANDS ON (each with what the source says):',
    ...facts.map((f) => `- ${f.claim}${f.quote ? ` (source: "${f.quote}")` : ''}`),
    '',
    'TEXTS:',
    ...texts.map((t, i) => `[${i}] (${t.where}${ROLE_NOTE[t.role] ? `: ${ROLE_NOTE[t.role]}` : ''}) ${t.text}${hints[i].length ? `\n    HINTS: ${hints[i].join(' · ')}` : ''}`),
  ].join('\n');
}

/**
 * texts: [{ where, kind, text }]. facts: the post's facts, for factProblem.
 * Returns { reviewer, reviews: [{ botScore, tells, factProblem }] }.
 */
export async function reviewTexts(ctx, { pack, texts, facts = [], tag = 'review' }) {
  if (ctx.llm.kind !== 'claude') return { reviewer: 'heuristic', reviews: heuristicReview(texts, pack, facts) };
  const { data } = await askJson(ctx, { task: 'review', role: 'review', system: [{ text: REVIEW_SYSTEM, cache: ctx.llm.batch ? '1h' : '5m' }], user: reviewUser(pack, texts, facts), schema: REVIEW_SCHEMA, effort: 'low', maxTokens: 4000, tag });
  return {
    reviewer: 'claude',
    reviews: texts.map((_, i) => {
      const r = (data.reviews || []).find((x) => x.index === i) || {};
      // A reviewer once filled factProblem with "...so this is fine", and it blocked the post: the boolean decides.
      return { botScore: clamp(r.botScore), tells: (r.tells || []).map(String).slice(0, 5), factProblem: r.factIssue === false ? '' : String(r.factProblem || '') };
    }),
  };
}

/** The offline reviewer. Deterministic, and honest about what it can see. */
export function heuristicReview(texts, pack, facts = []) {
  const extra = pack?.rules?.bannedPhrases || [];
  const hints = hintsFor(texts, facts);
  return texts.map((t, i) => {
    const tells = tellsIn(t.text, { kind: t.kind, extra, pack, frame: t.frame || [] }).map((x) => x.msg);
    const hard = tells.length;
    let score = 1 + Math.min(6, hard * 2);
    const sentences = sentencesOf(t.text);
    const avg = sentences.length ? sentences.reduce((n, s) => n + s.split(/\s+/).length, 0) / sentences.length : 0;
    if (avg > 20) {
      score += 1;
      tells.push('long sentences');
    }
    // A template's opener is the account's own ("הנה האמת האמיתית על..."), not a stock one.
    if (t.role !== 'template' && /^(?:הנה|האם ידעתם|ידעתם ש|בואו|היום נדבר)/.test(normHe(t.text))) {
      score += 2;
      tells.push('stock opening');
    }
    // A hint is a tell most of the time, not always: a point each, two at most.
    if (hints[i].length) {
      score += Math.min(2, hints[i].length);
      tells.push(...hints[i]);
    }
    // What the heuristic only suspects never blocks a post: that takes a tell the code is sure of.
    if (!hard) score = Math.min(score, BLOCK_AT - 1);
    return { botScore: clamp(score), tells, factProblem: '' };
  });
}
