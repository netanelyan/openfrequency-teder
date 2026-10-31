import { numbersIn } from '../verify/claims.js';
import { normHe } from '../voice/tells.js';

// The shapes a post can take. A pack's format (formats.json) names one of these
// kinds and brings its own name, hook patterns and calls to action; the engine
// owns the shape: which slides, in what order, which of them must state a sourced
// fact, and what the drafting model is told about it.
//
// Every kind fits the rules the research behind the accounts gave:
//   - 5 to 8 slides in all, the cover included (carousels peak at 5 to 6; past
//     10 only about a quarter of viewers finish)
//   - one idea per slide, and the payoff on the last slide: the call to action
//     is drawn on that slide by the design, not given a slide of its own
//   - a do-dont's rules come from guidance documents (a design system, a style
//     guide, a security cheat sheet), quoted like any other fact
//   - every factual claim traces to a quote (HARD RULE 3). A role in `factFree`
//     carries no fact of its own (a myth as people say it, a verdict, a joke's
//     setup, "agree?"), and any number on it must still be in the post's quotes.
//
// `list` is the phase 1 shape (a cover, items, a closer slide), kept for packs
// that use it; its range comes from the format's own `items`.

export const GROUPS = { entertaining: 'בידור', number: 'מספרים' };

/** The mix of entertaining formats an account moves between, by its results. */
export const MIX = { default: 0.6, min: 0.4, max: 0.8, step: 0.05 };

export const SLIDES = { min: 5, max: 8 };

export const KINDS = {
  story: {
    group: 'entertaining',
    name: 'סיפור',
    segments: [['beat', 3, 5], ['payoff', 1, 1]],
    photo: 'cover',
    cta: 'send',
    prompt: `story: a true story in slides. The cover is a hook that teases the twist without giving it away, and never promises what the story does not deliver. 3 to 5 "beat" slides build it up in order, one moment each, with the names, dates and numbers from the facts. The last slide, "payoff", is the twist or the result the hook promised. No earlier slide gives the payoff away. The moment the story turns on is told on a slide in full: who did it, when and how (the goal, its scorer and its minute; the knockout and the blow): the reader swiped for it. A story every fan already knows (a famous final, a famous comeback) leads its cover with the detail from the documents that fans do not know, never with the result they have seen a hundred times.`,
  },
  'what-happened': {
    group: 'entertaining',
    name: 'מה קרה ל...',
    segments: [['then', 1, 2], ['turn', 1, 2], ['now', 1, 1]],
    content: [4, 7],
    photo: 'cover',
    cta: 'comment',
    subject: ['a'],
    prompt: `what-happened: "what happened to X", one person, team or company (subject.a). "then" slides: who they were at their peak, with numbers. "turn" slides: the fall or the turn, documented facts only, named as what happened (the defeat and who inflicted it, the injury, the transfer, the ban, with its date), never a vague "a drop in form" when the documents name the event. The cover's question is answered on a slide with the numbers of the change, before and after (goals a season, wins and losses, the months out): a list of trophies is not an answer, and a reader who swiped to the end for it and found none failed the post. "now": where they are by the latest dated fact in the documents, with its date. Only documented facts about people: never guess at reasons, health, money or private life the documents do not state.`,
  },
  'on-this-day': {
    group: 'entertaining',
    name: 'היום לפני',
    segments: [['context', 1, 2], ['moment', 1, 3], ['after', 1, 1]],
    content: [4, 7],
    photo: 'cover',
    cta: 'send',
    subject: ['date'],
    prompt: `on-this-day: one wild moment from this date in an earlier year. subject.date is the day it happened, as the cover shows it ("6 באוקטובר 2001"); the day and the year must be in a quote. "context" slides: what was at stake before. "moment" slides: what happened, beat by beat, with who did it and the minute or the round. "after": what it led to.`,
  },
  'guess-who': {
    group: 'entertaining',
    name: 'נחשו מי',
    segments: [['clue', 3, 4], ['reveal', 1, 1]],
    photo: 'last',
    cta: 'comment',
    subject: ['answer'],
    prompt: `guess-who: the cover asks them to guess a famous person (or club, or company) from clues. 3 "clue" slides (4 at most), from hard to easy, each one sourced fact that never names the answer, and never names anything that gives it away at once. The "reveal" slide is last: its title is the answer (subject.answer) and its body one sourced line. The answer appears nowhere before the reveal: not on the cover, not in a clue, not in the captions or the keywords. The cover asks the question and gives no clue of its own (no year, title or deed that points to the answer): the clues are the slides'. The answer is someone the account's audience knows by name: a guess nobody can get is no game. The first two clues are ones only a real fan could place: no nationality, no club, no shirt number in them; the giveaway comes last. The captions never repeat the clues, and never hold a detail that points to the answer (a club, a debut, a title count, a year). The reveal's line confirms the answer with what the clues pointed to, never a new claim the clues did not prepare. Never number a clue yourself ("רמז 1"): the design draws the badges.`,
  },
  'head-to-head': {
    group: 'number',
    name: 'ראש בראש',
    segments: [['stat', 3, 6], ['verdict', 1, 1]],
    factFree: ['verdict'],
    photo: 'cover',
    cta: 'comment',
    subject: ['a', 'b'],
    prompt: `head-to-head: two subjects still argued over (two players, two coaches, two teams, two eras, two products), never one past match whose winner everyone knows, never two options whose answer is plain before the first slide (the cheaper tier of the same family is cheaper), and never two that are the same on most of their numbers (three slides of "$2.00 מול $2.00" is no contest); subject.a and subject.b (short names, as the slides call them). 3 to 6 "stat" slides (a coming fight's sources rarely hold more than three numbers both sides share): title is the stat's name, a and b are the two values exactly as the quotes give them (digits, with their unit; at most three words each), body one short line of context; each stat slide cites the facts that hold both values. Compare like with like: the same competition and period for both, said on the slide. Both values of every stat are real values from the quotes, and the same measure on both sides (a record against a record, never an age against a result): never a dash or "אין נתון" (drop a stat one side does not have). When the two meet at a coming event (a fight, a match), the cover or the first stat names the event and its date from the quotes: a matchup without a when reads as old news. Every stat bears on the question the cover asks (for a fight: the record, wins by knockout and by submission, title fights, reach, the last fights); never one that decides nothing (a debut date, the number of rounds scheduled). The cover asks the question and never shows the values (no price table or stat grid on the cover): the slides reveal them one at a time. The last slide, "verdict", answers the cover's question in its first words and takes a side: who the numbers favour and the one stat that decides it, with no new number. Never a hedge.`,
  },
  ranking: {
    group: 'number',
    name: 'דירוג',
    segments: [['ranks', 0, 1], ['rank', 5, 5]],
    photo: 'cover',
    cta: 'comment',
    prompt: `ranking: a top 5, or a top 10. Famous names only. Every place is decided by a number in the quotes (goals, titles, wins, money), and the order follows that number. Five "rank" slides go from 5th place to 1st: number 1 is the last slide, and the cover never names it (nor the whole list): it teases the countdown. For a top 10, one "ranks" slide comes first and holds places 10 to 6 as exactly five short lines in its body, one per line, in order, each with its number. Never write a place number yourself ("מקום 3", "#1"): the design draws them. A rank slide's title is the name; its body the number that ranks it and one short line, and its graphic shows that number big, number 1's included. One measure for every place (a team's score in one match, never beside a player's season): the cover or the first slide says what is counted, and says it honestly (five world-record transfers in turn are not "the five most expensive transfers" when others cost more). Every rank slide's big number is the ranked measure itself (the fee, the goals), never another figure (a span of years).`,
  },
  iceberg: {
    group: 'entertaining',
    name: 'הקרחון',
    segments: [['layer', 4, 6]],
    photo: 'cover',
    cta: 'save',
    prompt: `iceberg: from what everyone knows down to what almost nobody knows. 4 to 6 "layer" slides, top to bottom. A layer is one slide: a short title, and 1 to 3 facts as short lines in its body, one per line. The top layer is the famous facts, the bottom layer the most obscure ones the documents hold. The design draws the depth. The cover's lines tease the strangest fact from the bottom layer, never what everyone knows ("X, this everyone knows" is not a reason to stop).`,
  },
  'hot-take': {
    group: 'entertaining',
    name: 'דעה',
    segments: [['case', 3, 5], ['ask', 1, 1]],
    factFree: ['ask'],
    photo: 'cover',
    cta: 'comment',
    prompt: `hot-take: one bold opinion on the cover, the account's own (the design labels it as opinion): one that a good share of the audience would argue against, never the answer everyone already gives. One case slide names the strongest rival view by name and answers it. 3 to 5 "case" slides make the case with sourced facts: the opinion is ours, the facts inside it are never invented. The last slide, "ask", restates the take in a few words and asks if they agree. Never insult a person, a club, a company or fans.`,
  },
  'myth-fact': {
    group: 'entertaining',
    name: 'מיתוס ועובדה',
    segments: [['myth', 1, 1], ['fact', 1, 1]],
    repeat: [2, 3],
    factFree: ['myth'],
    photo: 'cover',
    cta: 'save',
    prompt: `myth-fact: 2 or 3 pairs. A "myth" slide says a common belief in a few words, the way people say it (the design stamps it as a myth); the "fact" slide right after it says what the sources say instead, with its facts. A myth slide holds no number that its fact slide's quotes do not hold. Pick beliefs the audience really holds and argues about (a myth no one believes is a straw man and loses the reader); one subject for the whole post, never two unrelated ones.`,
  },
  meme: {
    group: 'entertaining',
    name: 'מם',
    segments: [['joke', 3, 5], ['truth', 1, 1]],
    factFree: ['joke'],
    photo: null,
    cta: 'send',
    prompt: `meme: text-led jokes about the audience's insider pain, in the account's own design (never a meme template, a film still or another page's picture). 3 to 5 "joke" slides: title is the setup (a situation every one of them knows), body the punchline, short and spoken. A joke that states a fact (a rate, a deadline, a sum) cites it. The last slide, "truth", is the real fact behind the jokes, sourced. Punch at the situation, never at a group of people. Every joke slide is a joke (a setup and a twist a reader would send to a friend), never a fact read out: a price list is not a meme. The captions never promise a number of jokes.`,
  },
  'do-dont': {
    group: 'entertaining',
    name: 'עושים ולא עושים',
    segments: [['rule', 4, 6]],
    photo: null,
    cta: 'save',
    prompt: `do-dont: 4 to 6 rules on one subject (a sign-up form, a landing page, a prompt, keeping a key secret), one rule a slide, each from the guidance in the documents. A "rule" slide's title is the rule in a few spoken words, said as what to do ("תכתבו בתוך השדה איך התשובה נראית"); its body one short line on why, sourced. Its visual is a "dodont": the same small screen drawn twice, wrong and right, so the reader sees the rule before reading it; the design labels the two sides and numbers the rules. The two sides differ only where the rule is, and everything else on them is the same. The screens are made-up examples of an app the reader might build (never a real product's screen, name or logo). The cover names the subject and how many rules ("5 טעויות בטופס הרשמה שמבריחות משתמשים") and gives no rule away. Never number a rule yourself, and never write "לא" or "כן" as a label: the design draws them.`,
  },
  // The three kinds below are the shapes the slideshows that spread on TikTok take (25 of them read slide by slide,
  // 20 over 500K views): separate surprising facts counted down to the best one (every football and MMA hit), a
  // list worth saving (the AI and money hits, saved more than they were liked), and the owner's own story told with
  // their own numbers on their own photographs (every small-business hit). Each slide is one short line on its own
  // photograph (photo: 'every'), the strongest last, and no slide of its own for a call to action.
  facts: {
    group: 'entertaining',
    name: 'עובדות שלא ידעתם',
    segments: [['fact', 4, 7]],
    photo: 'every',
    cta: 'send',
    prompt: `facts: 4 to 7 separate surprising facts (6 when the documents hold that many good ones: every countdown that spread had 5 or more, and a post of 4 read as thin) about one subject the audience follows now (this season, this year's tournament or events, today's champions and stars), counted down from good to best: the last "fact" slide is the one they will send to a friend, the biggest name with the biggest shock (a World Cup countdown ended on a keeper's run off his line, and nobody would have sent it). A fact is about the subject itself (in a sport, what happened in the cage or on the pitch; in a craft or a trade, what happens in the dough, the oven, the tool or the deal), said as the shock in it, the kind a follower answers with "רגע, מה?": a never, an only, a first, a number that sounds impossible, a comparison that floors them ("חביב נורמגומדוב לא דימם באף קרב בקריירה", "לסנט פייר יש יותר הגנות על התואר מלחביב ולמקגרגור ביחד", "צ'ימאייב ספג 2 מכות ב-4 הקרבות הראשונים שלו ב-UFC"). A record ("the most wins", "the longest streak") is a fact only said as its shock, never as a table's row: not "17 בונוסים ב-16 הופעות, שיא ב-UFC" but "לגייתג' יש יותר בונוסים מקרבות"; not "1,584 מכות משמעותיות, שיא במשקל" but what that number beats. Away from the subject itself (off the pitch) only when it is famous-level strange and about a star of now. Never a person (a player, a fighter, a manager, a maker) whose time was years ago, unless the post is about legends: a countdown of 2010's stars read in 2026 as a post from 2022. Each fact is understood by a fan who sees only that slide, why it is strange said in the line itself: "תיירי אנרי טס לפילדלפיה לגמר ה-NBA" left every reader asking what it was about. Its title IS the fact, the person's or the team's name first, said the way a fan says it in one breath: 5 to 12 words, the whole slide. Its body is "" (the slide is one line on its photograph, as every countdown that spread is). Never a fact every fan knows, never two facts about the same moment, never a list of trophies. Each slide is about a different person, team or moment where the documents allow, the names the whole audience knows first, and its imageQuery is the person or place it is about, by full name, so it stands on its own photograph. The cover says how many and what about ("7 דברים שלא ידעתם על אלופי ה-UFC") and gives none of them away.`,
  },
  tips: {
    group: 'number',
    name: 'רשימה לשמור',
    segments: [['tip', 4, 7]],
    photo: 'every',
    cta: 'save',
    prompt: `tips: 4 to 7 things the reader will save to use later (steps, amounts, times and temperatures, tools, settings, prompts to copy, rights, deadlines), each one from the guidance in the documents. A "tip" slide's title names it in 2 to 6 words ("פרומפט שמסכם פגישה ב-5 שורות", "הכפתור שמכבה את ההיסטוריה"); its body is the exact thing to do or copy, complete enough to use without the source (at most 35 words): the reader saves the post for these lines. Every tip is concrete and specific, never advice everyone gives ("תהיו עקביים"). The order goes from useful to the most useful, the best last. The cover says how many and what they get ("5 פרומפטים שחוסכים שעה ביום") and gives none of them away.`,
  },
  'owner-story': {
    group: 'entertaining',
    name: 'הסיפור שלי',
    segments: [['moment', 4, 6], ['lesson', 0, 1]],
    factFree: ['lesson'],
    photo: 'every',
    owner: true,
    cta: 'comment',
    prompt: `owner-story: the business owner tells their own story in the first person, from what THEY wrote down (the facts marked as the owner's own): the mistakes they made, what happened after a year, what nobody told them before they opened, the numbers they wish they had known. 4 to 6 "moment" slides, one each: the title is the moment in the owner's own words, with its real number when the fact has one ("מכרנו ב-100 אלף ושקל ועדיין הפסדנו", "קניתי מקרר יד שנייה ב-4,000 שקל והוא מת אחרי חודש"): 5 to 14 words. Body empty or one short line. The order builds to the strongest or the most honest one. An optional last "lesson" slide says what they would tell someone opening the same business, in one or two short lines, no moral, no sales pitch: the business is never sold on a slide (the post is the pitch). Only what the owner's facts say: never an experience, a number or a customer the facts do not hold. Each slide's imageQuery describes one of the owner's own photographs (the shop, the product, the owner at work) in the words its description uses.`,
  },
  list: {
    group: 'number',
    name: 'רשימה',
    segments: [['item', 2, 10]],
    closer: true,
    photo: 'cover',
    prompt: `list: the cover, then content slides ("item"), each one point with its facts, then a closing slide the design adds.`,
  },
};

export const isKind = (k) => Object.hasOwn(KINDS, k);

/**
 * Does every slide of this post stand on its own photograph? The kinds made for it (photo: 'every') and any post drawn
 * in the native style (E), which is a photograph a slide with a line of text on it. Such a post ends on its best
 * slide: no call to action is drawn on it and no closing "follow" slide follows it (17 of the 25 slideshows that
 * spread ended on their last item, and one of the 19 outside Israel on a request to follow).
 */
export const everyPhoto = (pack, format, style = null) => kindOf(format).photo === 'every' || (style || pack?.meta?.style?.name) === 'E';

/** A format's kind (formats.json "kind", or the phase 1 list). */
export const kindOf = (format) => KINDS[format?.kind] || KINDS.list;
export const kindName = (format) => (isKind(format?.kind) ? format.kind : 'list');
export const groupOf = (format) => kindOf(format).group;
export const factFree = (format, role) => (kindOf(format).factFree || []).includes(role);

/** The content roles a kind allows, in their order. */
export const rolesOf = (format) => [...new Set(kindOf(format).segments.map(([r]) => r))];

/** [min, max] content slides (cover and closer not counted). */
export function contentRange(format) {
  const k = kindOf(format);
  if (k === KINDS.list) return format.items || [3, 5];
  if (k.content) return k.content;
  const rep = k.repeat || [1, 1];
  const lo = k.segments.reduce((n, [, a]) => n + a, 0) * rep[0];
  const hi = k.segments.reduce((n, [, , b]) => n + b, 0) * rep[1];
  return [lo, hi];
}

/** The format's hook patterns, as { id, pattern, examples } (a plain string is a pattern of its own). */
export function hookPatterns(format) {
  return (format?.hooks || []).map((h, i) => (typeof h === 'string' ? { id: `h${i + 1}`, pattern: h, examples: [] } : { id: String(h.id || `h${i + 1}`), pattern: String(h.pattern || ''), examples: (h.examples || []).map(String) }));
}

const GUESS_CTA = { kind: 'comment', text: 'ניחשתם לפני השקופית האחרונה? כתבו בתגובות' };

/** The calls to action a post of this format can end with: the format's own, the pack's, or the kind's default. */
export function ctasOf(pack, format) {
  const own = format?.ctas || pack?.formats?.ctas || [];
  const list = own.map((c) => (typeof c === 'string' ? { kind: 'save', text: c } : { kind: c.kind || 'save', text: String(c.text || '') })).filter((c) => c.text);
  if (format?.kind === 'guess-who' && !list.length) return [GUESS_CTA];
  return list;
}

/**
 * Do the content slides follow the kind's shape? roles: the content slides'
 * roles in order. Returns problems, worded for the model's redraft.
 */
export function shapeProblems(format, roles) {
  const k = kindOf(format);
  const out = [];
  const [lo, hi] = contentRange(format);
  if (roles.length < lo || roles.length > hi) out.push(`the post needs ${lo} to ${hi} content slides, it has ${roles.length}`);
  const allowed = rolesOf(format);
  const bad = roles.filter((r) => !allowed.includes(r));
  if (bad.length) out.push(`roles ${[...new Set(bad)].join(', ')} are not part of a ${kindName(format)} post (use ${allowed.join(', ')})`);
  if (bad.length) return out;
  // Walk the segments: each role in its run, in order, with its count.
  const want = k.repeat ? Array.from({ length: Math.max(1, Math.round(roles.length / k.segments.length)) }, () => k.segments).flat() : k.segments;
  let i = 0;
  for (const [role, min, max] of want) {
    let n = 0;
    while (i < roles.length && roles[i] === role && n < max) (i++, n++);
    if (roles[i] === role) {
      out.push(`at most ${max} "${role}" slide${max > 1 ? 's' : ''} in a row in a ${kindName(format)} post`);
      return out;
    }
    if (n < min) {
      out.push(k.repeat ? `the slides must alternate ${k.segments.map(([r]) => r).join(', ')}` : `a ${kindName(format)} post needs ${min === max ? min : `${min} to ${max}`} "${role}" slide${max > 1 ? 's' : ''} in its place (it has ${n})`);
      return out;
    }
  }
  if (i < roles.length) out.push(`the slides are out of order: the shape is ${k.segments.map(([r, a, b]) => `${r}${a === b ? (a > 1 ? ` x${a}` : '') : ` x${a}-${b}`}`).join(', ')}${k.repeat ? `, repeated ${k.repeat[0]} to ${k.repeat[1]} times` : ''}`);
  return out;
}

const SLIDE_TOTAL = (format, content) => 1 + content + (kindOf(format).closer ? 1 : 0);

/** Words a reader counts on a slide: a number is one. */
const wordsIn = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const COUNT_WORDS = { שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, שישה: 6, שש: 6, שבעה: 7, שבע: 7, שמונה: 8 };

/** The count a cover promises ("7 דברים", "חמש טעויות"), or null. */
export function countOnCover(text) {
  const m = String(text || '').match(/(?:^|\s)(\d+|שניים|שתיים|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה)\s+(?:דברים|עובדות|טעויות|טיפים|כללים|פרומפטים|כלים|סודות|שיאים|רגעים|שאלות|תובנות|הגדרות|קיצורים|זכויות)/);
  return m ? Number(COUNT_WORDS[m[1]] ?? m[1]) : null;
}

/** The lines of a slide's body, for the kinds that hold several facts on one slide. */
export const linesOfBody = (body) => String(body || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);

/**
 * Everything a kind asks of a written post beyond its shape. post: { hook, sub,
 * subject, slides (content only, with role, title, body, a, b), caption,
 * captionShort, keywords }. Returns problems.
 */
export function kindProblems(format, post) {
  const k = kindOf(format);
  const name = kindName(format);
  const out = [];
  const content = post.slides || [];
  const total = SLIDE_TOTAL(format, content.length);
  if (name !== 'list' && (total < SLIDES.min || total > SLIDES.max)) out.push(`the post has ${total} slides with the cover: it needs ${SLIDES.min} to ${SLIDES.max}`);
  const subj = post.subject || {};
  for (const f of k.subject || []) if (!String(subj[f] || '').trim()) out.push(`subject.${f} is required for a ${name} post`);
  if (name === 'head-to-head') {
    content.forEach((s, i) => {
      if (s.role === 'stat' && !(String(s.a || '').trim() && String(s.b || '').trim())) out.push(`slide ${i + 1}: a stat slide needs both values (a and b)`);
      if (s.role === 'stat' && String(s.a || '').length + String(s.b || '').length > 40) out.push(`slide ${i + 1}: a and b are values, not sentences (at most three words each: "27-4", "13 נוקאאוטים", "פה אחד")`);
      if (s.role === 'stat' && [s.a, s.b].some((v) => !/[\p{L}\p{N}]/u.test(String(v || '')))) out.push(`slide ${i + 1}: a stat needs a real value on both sides, never a dash: drop a stat one side does not have`);
    });
  }
  if (name === 'on-this-day' && subj.date && !/\d{4}/.test(subj.date)) out.push('subject.date must hold the year');
  if (name === 'guess-who' && subj.answer) {
    const ans = normHe(subj.answer).split(' ').filter((w) => w.length >= 3);
    const spoils = (t) => {
      const words = ` ${normHe(t)} `;
      return ans.some((w) => words.includes(` ${w} `) || new RegExp(` [והבלמשכ]${w} `).test(words));
    };
    const early = [['the cover', `${post.hook} ${post.sub}`], ['the captions', `${post.caption} ${post.captionShort}`], ['the keywords', (post.keywords || []).join(' ')], ...content.filter((s) => s.role === 'clue').map((s, i) => [`clue ${i + 1}`, `${s.title} ${s.body}`])];
    content.forEach((s, i) => s.role === 'clue' && /(?:^|\s)רמז\s*(?:\d|מספר|ראשון|שני|שלישי|רביעי)/.test(`${s.title} ${s.body}`) && out.push(`slide ${i + 1}: no clue numbers in the text, the design draws them`));
    for (const [where, text] of early) if (spoils(text)) out.push(`${where} gives the answer away ("${subj.answer}"): it may appear only on the reveal slide`);
  }
  if (name === 'guess-who') {
    // "לפי 3 רמזים" over four clues read as a mistake to every reader who counted.
    const clues = content.filter((s) => s.role === 'clue').length;
    const WORDS = { שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5 };
    const m = `${post.hook} ${post.sub}`.match(/(\d+|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש)\s+רמזים/);
    const said = m ? Number(WORDS[m[1]] ?? m[1]) : null;
    if (said != null && said !== clues) out.push(`the cover promises ${said} clues and the post has ${clues}: make them match`);
  }
  if (name === 'ranking') {
    const ranks = content.find((s) => s.role === 'ranks');
    if (ranks && linesOfBody(ranks.body).length !== 5) out.push('the "ranks" slide holds places 10 to 6: exactly five lines in its body');
    // The order follows the number: a win streak of 14 went out at number 1 above one of 16. The number that ranks a
    // slide (rankAmount, below) must rise (or fall) from 5th to 1st.
    const rankNum = rankAmount;
    // A year is not the number that ranks a place: number 1 of the World Cup's scorers went out with "2022 and 2026"
    // and no goal count, under four places that showed theirs.
    const drawn = content.some((s) => s.role === 'rank' && s.visual?.items?.[0]?.value != null);
    content.forEach((s, i) => {
      if (/(?:^|\s)(?:#\s?\d|מקום\s+(?:ה|ראשון|שני|\d))/.test(`${s.title} ${s.body}`)) out.push(`slide ${i + 1}: no place numbers in the text, the design draws them`);
      if (s.role === 'rank' && rankNum(s) == null) out.push(`slide ${i + 1}: a rank slide states the number that ranks it (a total, a count, not a year), number 1's included`);
      else if (s.role === 'rank' && drawn && s.visual?.items?.[0]?.value == null) out.push(`slide ${i + 1}: the other places show their number as a graphic: this one shows its own the same way`);
    });
    const nums = content.filter((s) => s.role === 'rank').map(rankNum);
    if (nums.length >= 3 && nums.every((n) => n != null)) {
      const up = nums.every((n, k) => k === 0 || n >= nums[k - 1]);
      const down = nums.every((n, k) => k === 0 || n <= nums[k - 1]);
      if (!up && !down) out.push(`the ranking's order does not follow its number (${nums.join(', ')} from 5th to 1st): order the places by the number that ranks them`);
    }
  }
  if (name === 'do-dont') {
    // The rule is seen before it is read: without its two screens a rule slide is the tips list the account does not post.
    content.forEach((s, i) => {
      if (s.role === 'rule' && s.visual?.type !== 'dodont') out.push(`slide ${i + 1}: a rule slide shows its rule as a "dodont" visual (the same screen drawn wrong and right)`);
      if (/(?:^|\s)(?:כלל|טיפ|טעות)\s*(?:\d|מספר|ראשון|ראשונה|שני|שנייה|שלישי|שלישית)|^\s*\d+\s*[.)]/.test(`${s.title}`)) out.push(`slide ${i + 1}: no rule numbers in the text, the design draws them`);
    });
    const rules = content.filter((s) => s.role === 'rule').length;
    const WORDS = { שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5, שישה: 6, שש: 6 };
    const m = `${post.hook} ${post.sub}`.match(/(\d+|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש)\s+(?:טעויות|כללים|טיפים|דברים|חוקים)/);
    const said = m ? Number(WORDS[m[1]] ?? m[1]) : null;
    if (said != null && said !== rules) out.push(`the cover promises ${said} and the post has ${rules} rules: make them match`);
  }
  if (name === 'iceberg') content.forEach((s, i) => linesOfBody(s.body).length > 3 && out.push(`slide ${i + 1}: a layer holds 1 to 3 short lines`));
  // One short line on a photograph: the football and MMA slideshows that spread hold 5 to 15 words a slide.
  const WORDS_CAP = { facts: { fact: [13, 0] }, tips: { tip: [8, 40] }, 'owner-story': { moment: [16, 12], lesson: [16, 20] } }[name];
  if (WORDS_CAP) {
    content.forEach((s, i) => {
      const cap = WORDS_CAP[s.role];
      if (!cap) return;
      if (wordsIn(s.title) > cap[0]) out.push(`slide ${i + 1}: the title has ${wordsIn(s.title)} words: ${cap[0]} at most, one line a reader takes in at a glance`);
      if (wordsIn(s.body) > cap[1]) out.push(cap[1] ? `slide ${i + 1}: the text has ${wordsIn(s.body)} words: ${cap[1]} at most${cap[1] <= 12 ? ', or none' : ''}` : `slide ${i + 1}: a ${name} slide is its title alone, one line of at most 60 characters on its photograph: the name and the one strange thing about them, nothing else (drop the date, the place, the context, or choose a shorter fact); the text is ""`);
    });
    // "7 דברים שלא ידעתם" over six facts read as a mistake to every reader who counted.
    const role = Object.keys(WORDS_CAP)[0];
    const n = content.filter((s) => s.role === role).length;
    const said = countOnCover(`${post.hook} ${post.sub}`);
    if (said != null && said !== n) out.push(`the cover promises ${said} and the post has ${n}: make them match`);
    // A countdown's cover is its count and its subject ("7 עובדות על ה-UFC שלא ידעתם"): a live run put the best fact,
    // the last slide's "17 ברצף", on the cover, and nothing was left to swipe for.
    if (name !== 'owner-story') {
      if (said == null) out.push(`the cover says how many and what about ("${n} דברים שלא ידעתם על ...", "${n} ${name === 'tips' ? 'פרומפטים' : 'עובדות'} ש..."): a ${name} cover is its count and its subject`);
      const best = [...content].reverse().find((s) => s.role === role);
      const bestNums = new Set(best ? [...numbersIn(`${best.title} ${best.body}`, { hebrew: true })] : []);
      bestNums.delete(String(n));
      const spoiled = [...numbersIn(`${post.hook} ${post.sub}`, { hebrew: true })].filter((x) => bestNums.has(x));
      if (spoiled.length) out.push(`the cover states ${spoiled.join(', ')}, the last slide's number: the best item is kept for the end, the cover never gives it away`);
    }
  }
  if (name === 'myth-fact') {
    content.forEach((s, i) => {
      if (s.role !== 'myth') return;
      const next = content[i + 1];
      const nums = new Set([...numbersIn(`${next?.title} ${next?.body}`, { hebrew: true })]);
      for (const x of numbersIn(`${s.title} ${s.body}`, { hebrew: true })) if (!nums.has(x)) out.push(`slide ${i + 1}: the myth states ${x}, which its fact slide does not`);
    });
  }
  return out;
}

/**
 * Numbers that are the post's own structure, not claims: how many slides, a top
 * 5 or a top 10, 3 clues. The cover may say them without a quote.
 */
export function structureNumbers(format, content) {
  const out = new Set([String(content.length)]);
  const name = kindName(format);
  if (name === 'ranking') out.add(String(content.some((s) => s.role === 'ranks') ? 10 : 5));
  if (name === 'guess-who') out.add(String(content.filter((s) => s.role === 'clue').length));
  if (name === 'myth-fact') out.add(String(content.filter((s) => s.role === 'myth').length));
  if (name === 'iceberg') out.add(String(content.length));
  if (name === 'do-dont') out.add(String(content.filter((s) => s.role === 'rule').length));
  if (name === 'facts') out.add(String(content.filter((s) => s.role === 'fact').length));
  if (name === 'tips') out.add(String(content.filter((s) => s.role === 'tip').length));
  if (name === 'owner-story') out.add(String(content.filter((s) => s.role === 'moment').length));
  return out;
}

// The scale words a ranked amount is written with, in the forms a slide uses them: after the number ("25 מיליון",
// "$8.2B") or once for the whole graphic ("במיליוני דולרים", "in millions").
const SCALE = { טריליון: 1e12, טריליוני: 1e12, טריליונים: 1e12, trillion: 1e12, trillions: 1e12, t: 1e12, מיליארד: 1e9, מיליארדי: 1e9, מיליארדים: 1e9, billion: 1e9, billions: 1e9, bn: 1e9, b: 1e9, מיליון: 1e6, מיליוני: 1e6, מיליונים: 1e6, million: 1e6, millions: 1e6, m: 1e6, אלף: 1e3, אלפי: 1e3, אלפים: 1e3, thousand: 1e3, thousands: 1e3, k: 1e3 };
const SCALE_WORD = 'טריליונים|טריליוני|טריליון|מיליארדים|מיליארדי|מיליארד|מיליונים|מיליוני|מיליון|אלפים|אלפי|אלף|trillions?|billions?|millions?|thousands?|bn';
const scaleOf = (w) => SCALE[String(w || '').toLowerCase()] || 1;

/**
 * The number a ranking's place is ranked by, as one amount: its graphic's value, or its first number that is not
 * a year, times the scale it is written in. The scale is read where the slide put it: right after the number, or,
 * for a graphic's value, once in the graphic's line under it, its label or its title. The AI companies ranking
 * compared a graphic of "8,200" (its line under it: "מיליון דולר") against "25 מיליון", as 8,200 against 25,000,000.
 */
export function rankAmount(s) {
  const v = s.visual?.items?.[0]?.value;
  // The body before the title: a title can be a name with a number in it ("UFC 229").
  // A graphic's value can be words around its number ("כ-10 ימים").
  // "פעמיים" (twice) is a claim the gate checks, never the number a place is ranked by.
  const said = (t) => [...numbersIn(String(t).replace(/(?<![\p{L}])[ובלהמש]{0,2}פעמיים(?![\p{L}])/gu, ''), { hebrew: true })];
  const plainNum = (x) => Number(String(x).replace(/,/g, ''));
  const notYear = (x) => Number.isFinite(x) && !(x >= 1900 && x <= 2100);
  const pick = (t) => said(t).map(plainNum).find(notYear);
  const plain = (t) => String(t ?? '').replace(/(\d),(?=\d{3})/g, '$1');
  const after = (n, t) => new RegExp(`(?<![\\d.])${String(n).replace('.', '\\.')}\\s*(${SCALE_WORD}|[TBMK](?![a-z]))`, 'i').exec(plain(t))?.[1];
  const alone = (t) => new RegExp(`(?<![\\p{L}])(?:[ובלהמש]{0,2}|in\\s+)(${SCALE_WORD})(?![\\p{L}])|\\(([TBMK])\\)|[$€£₪]([TBMK])(?![a-z])`, 'iu').exec(String(t ?? ''))?.slice(1).find(Boolean);
  if (v != null) {
    const n = pick(v);
    if (n != null) {
      const it = s.visual.items[0];
      const unit = after(n, v) || alone(it.sub) || alone(it.label) || alone(s.visual.title);
      return Number((n * scaleOf(unit)).toPrecision(12));
    }
  }
  for (const t of [s.body || '', s.title || '']) {
    const n = pick(t);
    if (n != null) return Number((n * scaleOf(after(n, t))).toPrecision(12));
  }
  return null;
}

/** The rank the design draws on each content slide of a ranking: 10..6 on the group slide, then 5..1. */
export function ranksOf(content) {
  const singles = content.filter((s) => s.role === 'rank').length;
  let next = singles;
  return content.map((s) => (s.role === 'rank' ? next-- : s.role === 'ranks' ? [10, 9, 8, 7, 6] : null));
}

/** The shapes, as the drafting model is told them: only the kinds this pack uses. */
export function shapesPrompt(pack) {
  const used = [...new Set((pack.formats.formats || []).map(kindName))];
  // The slides that carry no fact of their own are said so, or a model cites a fact on them anyway.
  return used.map((k) => `- ${KINDS[k].prompt}${KINDS[k].factFree?.length ? ` A "${KINDS[k].factFree.join('" or "')}" item carries no fact of its own: facts [].` : ''}`).join('\n');
}
