import { closingOf } from '../packs/promo.js';
import { checkRules } from '../rules/check.js';
import { numbersIn } from '../verify/claims.js';
import { mechanicalFix, normHe, sentencesOf, tellsIn } from '../voice/tells.js';

// The closing slide, item 2 (the owner, 2026-11-02): "every slideshow ends with a closing slide that sends people to the
// customer's site or product. This applies to every format, every style and every account, with no exceptions", and
// "the last slide is always the hook to the product. It ties to the slideshow's topic (a slideshow about plants that
// survive in the dark ends with the store's plant that fits), and it's never a generic 'visit our site'. One short line
// plus the action. It goes through hebrew-voice, so no 'the best X' claims, no manufactured urgency, no 'don't miss'."
//
// THE LINE IS THE WRITER'S, THE ACTION IS THE CODE'S. The slides call writes one line (SLIDES_SCHEMA "closing.line"),
// told the post's topic and the account's promo (closingRequest). Where it sends people is never the model's to write:
// closingActions builds it from the promo (src/packs/promo.js closingOf) and the platform, so no address is ever the
// model's. TikTok's says the link is in the bio, Instagram's and Facebook's carry the promo's address (one image goes to
// both: a Facebook Page is sent Instagram's slides), and an account with no promo asks every platform to follow it.
//
// THE LINE IS CHECKED IN CODE (closingLineProblems): the voice's own tells (src/voice/tells.js), the honesty, law and
// account rules every slide is held to (src/rules/check.js), and what a closing slide must never say: a claim the store
// did not make ("הכי", "ביותר", "מספר 1"), urgency or scarcity ("רק היום", "נשארו רק", "אל תפספסו"), an offer or a
// number the promo does not hold, the action itself or a generic one ("בקרו באתר", "הלינק בביו", an address), and a
// line about a promo that does not name it. What code can fix, code fixes first (a long dash, an exclamation mark).
//
// A LINE THAT BREAKS A RULE IS A CHECK THE REPAIR LOOP OWNS (item 3, the owner, 2026-11-02: "a slideshow without a
// closing slide, or whose closing slide doesn't mention the promo, goes through the repair loop and doesn't go out like
// that"). closingProblems is part of every check of a draft (src/pipeline/build.js checkPost): a closing slide that is
// missing, has no line, has no action for a platform, sends people somewhere the account no longer does, or whose line
// breaks a rule (closingLineProblems) is a problem, its target "closing". The repair (src/pipeline/repair.js) sends the
// line back to the writer with the rule it broke, the post's topic and the promo, at most REPAIR_ATTEMPTS times. Only
// then, as the last step, the slide takes the first line made of the promo's own words that passes the same rules
// (closingSlide, safeLines); with none, the post is blocked. The same check runs on a stored post before anything is
// sent (storedClosingProblems, src/publish/index.js closingRecheck): one that fails is blocked there, never sent.
//
// THE SLIDE IS DATA the renderer draws (src/render/render.js, after the last content slide) and the post keeps
// (posts.data_json "closing"), inside what the fact gate signs (build.js extraOf): { kind, line, by, handle, name,
// promise, product, url, actions: { tiktok, instagram, facebook } }, each action { where: 'bio'|'url'|'handle', lead,
// chip, text, url?, display?, handle? }: the words, the address or handle beside them, and the two as one text.

/**
 * The line: one sentence, or a short question and its answer. 60 characters is what the engine gives any slide's title
 * (LIMITS.slideTitle, and "a title is at most 60 characters" in the writer's rules), the two seconds a reader gives a
 * slide, and the most the old follow slide's title held (pack.json endSlide); it leaves the slide room for the action
 * under it. Fewer than 3 words is a label, not a line; 12 is the most a facts slide's one line holds.
 */
export const CLOSING_LINE = { maxChars: 60, minWords: 3, maxWords: 12, sentences: 2 };

/** The longest address a slide shows with its path; a longer one shows the site alone. */
const DISPLAY_MAX = 28;

const PLATFORMS = ['tiktok', 'instagram', 'facebook'];

/** An address as a slide shows it: no scheme, no "www.", no query or fragment, the path only when short and plain. */
export function displayUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = u.pathname.replace(/\/+$/, '');
  const full = `${host}${p}`;
  return p && /^[a-z0-9/_.-]+$/i.test(p) && full.length <= DISPLAY_MAX ? full : host;
}

/**
 * What the account's closing slide is about, from its promo (closingOf): { kind: 'site'|'product'|'bio', name,
 * promise, product?, url?, handle }, or { kind: 'follow', handle } for an account with none.
 */
export function closingBase(pack) {
  const c = closingOf(pack);
  const handle = String(pack?.meta?.handle || '');
  if (c.kind === 'follow') return { kind: 'follow', handle };
  const t = c.target;
  return { kind: t.kind, name: c.name, promise: c.promise, ...(t.kind === 'product' ? { product: t.name } : {}), ...(t.url ? { url: t.url } : {}), handle };
}

const BIO = 'הלינק בביו';

/** The action under the line, per platform, built from the promo alone. */
export function closingActions(base) {
  const each = (a) => Object.fromEntries(PLATFORMS.map((p) => [p, { ...a(p) }]));
  if (base.kind === 'follow') {
    const chip = `@${base.handle}`;
    return each(() => ({ where: 'handle', lead: 'תעקבו אחרי', chip, text: `תעקבו אחרי ${chip}`, handle: base.handle }));
  }
  const bio = { where: 'bio', lead: BIO, chip: '', text: BIO };
  if (base.kind === 'bio' || !base.url) return each(() => bio);
  const display = displayUrl(base.url);
  // TikTok never shows an address on a slide (nothing on it is a link, and TikTok's link is the one on the profile).
  return each((p) => (p === 'tiktok' ? bio : { where: 'url', lead: 'באתר', chip: display, text: `באתר ${display}`, url: base.url, display }));
}

// ---------------------------------------------------------------- the check

// A word in normalised Hebrew (normHe), whole, with a one-letter prefix allowed ("בביו", "לאתר", "והכי"). `exact`: no
// prefix, for a short word a prefix would turn into another ("לך" is in "הלך" and "מלך").
const PREFIX = '(?:ו|ה|ב|ל|מ|ש|כ|וה|וב|ול|ומ|וש|שה|שב|של|כש|מה|שמ)?';
const word = (p, exact = false) => new RegExp(`(?:^| )${exact ? '' : PREFIX}${normHe(p)}(?= |$)`, 'u');
const words = (list, exact = false) => list.map((p) => ({ p, re: word(p, exact) }));

// A claim the store did not make: the best, number one, the leading, the only one, guaranteed.
const CLAIMS = words([
  'הכי', 'ביותר', 'מספר 1', 'מספר אחת', 'מספר אחד', 'מס 1', 'נאמבר 1', 'נמבר 1', 'מוביל', 'מובילה', 'מובילים', 'מובילות',
  'ללא תחרות', 'בלי תחרות', 'אין כמוהו', 'אין כמוה', 'אין כמונו', 'אין כמותו', 'אין כמותה', 'אין כמותם', 'יחיד מסוגו', 'יחידה מסוגה',
  'בלעדי', 'בלעדית', 'בלעדיים', 'בלעדיות', 'מובטח', 'מובטחת', 'מבטיחים', 'מושלם', 'מושלמת', 'מושלמים', 'מושלמות',
]);
const CLAIMS_LATIN = /(?<![a-z])(?:best|top|leading|no\.?\s?1|number\s+one)(?![a-z])|#\s?1(?!\d)|100\s?%/i;

// Urgency and scarcity nobody set (the hebrew-voice guide: "אל תפספסו", "רק היום", "מהרו").
const URGENCY = words([
  'רק היום', 'רק עכשיו', 'עכשיו', 'עוד היום', 'היום בלבד', 'השבוע בלבד', 'החודש בלבד', 'עד מחר', 'עד סוף השבוע', 'עד סוף החודש',
  'לזמן מוגבל', 'זמן מוגבל', 'מוגבל', 'מוגבלת', 'מוגבלים', 'מוגבלות', 'מלאי', 'נשארו רק', 'נשאר רק', 'נשארה רק', 'רק עוד',
  'לפני שנגמר', 'לפני שייגמר', 'לפני שיגמר', 'לפני שייגמרו', 'לפני שיגמרו', 'לפני שנגמרים', 'מהרו', 'תמהרו', 'תזדרזו', 'הזדרזו', 'בהקדם', 'דחוף',
  'הזדמנות', 'פספסו', 'תפספסו', 'לפספס', 'תחמיצו', 'החמיצו', 'להחמיץ',
]);

// An offer is the store's own word: allowed only when its promo says it. ("מתנה" alone is a gift idea, not an offer.)
const OFFERS = words(['מבצע', 'מבצעים', 'סייל', 'הנחה', 'הנחות', 'חינם', 'בחינם', 'במתנה', 'קופון', 'זול', 'זולה', 'זולים', 'זולות', 'בזול', 'משתלם', 'משתלמת', 'משתלמים']);

// The action, or a generic one: the code writes where to go, under the line.
const ACTION = words([
  'בקרו', 'תבקרו', 'ביקור', 'לבקר', 'היכנסו', 'תיכנסו', 'כנסו', 'תכנסו', 'להיכנס', 'לחצו', 'תלחצו', 'ללחוץ', 'הקליקו', 'תקליקו',
  'לינק', 'לינקים', 'קישור', 'ביו', 'אתר', 'פרופיל', 'תעקבו', 'עקבו', 'לעקוב',
]);
const ACTION_LATIN = /(?<![a-z])(?:link|bio|follow|click|visit|shop now)(?![a-z])/i;
const ADDRESS = /https?:|www\.|[a-z0-9-]+\.[a-z]{2,}(?![a-z])|@\S/i;

// "You" in the singular, said to a crowd (the hebrew-voice guide: the audience is addressed in the plural). tellsIn has
// "שלך", "אותך" and "אתה"; these are the rest, as whole words ("לך" is in "הלך" and "מלך").
const SINGULAR = words(['לך', 'אצלך', 'בשבילך', 'עליך', 'אליך', 'ממך'], true);

/** Is this name in the text, whole, with a one-letter prefix allowed? */
const names = (text, name) => Boolean(name && normHe(name) && word(name.toLowerCase()).test(normHe(text).toLowerCase()));

/** The words of a product a line may name it by: the whole name, or its first words up to its first word of 4 letters. */
function productHead(name) {
  const ws = normHe(name).split(' ').filter(Boolean);
  const k = ws.findIndex((w) => [...w].filter((c) => /\p{L}/u.test(c)).length >= 4);
  return k >= 0 && k < ws.length - 1 ? ws.slice(0, k + 1).join(' ') : ws.join(' ');
}

/** The text with the promo's own names taken out, for the checks that are about the account's own words. */
function withoutNames(text, base) {
  let t = String(text || '');
  for (const n of [base.product, base.name].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(n).join(' שם ');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Every rule a closing line breaks, as { code, msg } in English (the trace's words): [] for a line that may go on the
 * slide. `base`: closingBase. `facts`: the post's facts (a number the line states must be in a verified quote, or in
 * the promo's own words). `others`: every account on the server (no line names another of ours). `writer`: the
 * writer's line, which also must be a line (3 words or more) and name the promo; false for a line of the promo's own
 * words (safeLines), which is about the promo by construction.
 */
export function closingLineProblems(line, { base, pack = null, others = [], facts = [], writer = true } = {}) {
  const out = [];
  const add = (code, msg) => out.push({ code, msg });
  const raw = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return [{ code: 'empty', msg: 'the closing line is empty' }];
  const L = CLOSING_LINE;
  const chars = [...raw].length;
  if (chars > L.maxChars) add('length', `the closing line is ${chars} characters: ${L.maxChars} at most, one short line`);
  const count = raw.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (count > L.maxWords || (writer && count < L.minWords)) add('length', `the closing line has ${count} words: ${writer ? `${L.minWords} to ` : 'at most '}${L.maxWords}`);
  const said = sentencesOf(raw).length;
  if (said > L.sentences) add('length', `the closing line has ${said} sentences: one, or a short question and its answer`);
  // The voice, as on every slide's title: no colon, no exclamation mark, no long dash, no teaser, no ad copy, no singular.
  const own = withoutNames(raw, base);
  for (const t of tellsIn(own, { kind: 'slideTitle', extra: pack?.rules?.bannedPhrases || [], pack })) if (t.code !== 'length') add(`voice:${t.code}`, t.msg);
  // Honesty, the law and the account's own rules, as every text of the post: no invented experience, no fake proof,
  // no investment advice in a money niche, no other account of ours.
  if (pack?.meta) for (const p of checkRules({ pack, others, texts: [{ where: 'closing', text: raw }] })) add(p.code, p.msg);
  const norm = normHe(own).toLowerCase();
  const promoWords = normHe(`${base.name || ''} ${base.promise || ''} ${base.product || ''}`).toLowerCase();
  const hit = (list) => list.find((t) => t.re.test(norm))?.p;
  const claim = hit(CLAIMS) || CLAIMS_LATIN.exec(own)?.[0];
  if (claim) add('claim', `a claim the store did not make ("${claim}"): no "the best", "number one", "the leading", "the only", "perfect" or "guaranteed"`);
  const hurry = hit(URGENCY);
  if (hurry) add('urgency', `urgency or scarcity ("${hurry}"): no "only today", "limited", "last ones", "hurry", "now" or "don't miss"`);
  const offer = OFFERS.find((t) => t.re.test(norm) && !t.re.test(promoWords))?.p;
  if (offer) add('offer', `an offer the promo does not make ("${offer}"): a sale, a discount, a gift or a price only as the promise says it`);
  const action = hit(ACTION) || ACTION_LATIN.exec(own)?.[0] || ADDRESS.exec(own)?.[0];
  if (action) add('action', `the action is the code's, under the line ("${action}"): no link, site, bio, address, @ or "follow", and never a generic "visit us"`);
  const you = SINGULAR.find((t) => t.re.test(norm))?.p;
  if (you) add('voice:singular', `the singular "you" ("${you}"): the audience is addressed in the plural`);
  // A number is a claim: it is in the promo's own words or in a quote the post stands on.
  const allowed = new Set([...numbersIn(`${base.name || ''} ${base.promise || ''} ${base.product || ''}`, { words: true, hebrew: true }), ...facts.filter((f) => f.verified).flatMap((f) => [...numbersIn(f.quote || '', { words: true, hebrew: true })])]);
  const extra = [...numbersIn(own, { hebrew: true })].filter((n) => !allowed.has(n));
  if (extra.length) add('number', `the number ${extra.join(', ')} is in no quote of the post and not in the promo`);
  if (writer && base.kind === 'product' && !names(raw, productHead(base.product)) && !names(raw, base.product)) add('names', `the line names the product it points at ("${base.product}")`);
  if (writer && (base.kind === 'site' || base.kind === 'bio') && !names(raw, base.name)) add('names', `the line names the store ("${base.name}")`);
  return out;
}

/**
 * Lines made of the promo's own words, best first, for a slide whose writer's line was refused. A product: the
 * product at the store ("X אצל Y"), then the product with the promise, then the product alone. A site or "link in
 * bio": the store's name and its promise, then the promise, then the name. No promo: more of the account's own topic
 * in the posts to come.
 */
export function safeLines(base, pack = null) {
  if (base.kind === 'follow') {
    const topic = String(pack?.meta?.topics?.[0] || '').trim();
    return [...(topic ? [`עוד על ${topic} בפוסטים הבאים`] : []), 'עוד כאלה בפוסטים הבאים'];
  }
  const { name, promise, product } = base;
  if (base.kind === 'product') return [`${product} אצל ${name}`, `${product}. ${promise}`, product, name];
  return [names(promise, name) ? promise : `${name}. ${promise}`, promise, name];
}

/** One line, as the slide sets it: its breaks and spaces made one, what code can fix fixed (a long dash, a "!"). */
export const oneLineOf = (line) => mechanicalFix(String(line ?? '').replace(/\\n|\s+/g, ' ').trim()).text.replace(/\s+/g, ' ').trim();

/**
 * The post's closing slide from the writer's line: { closing, refused }. `closing` is the slide's data (see the head of
 * this file), its line the writer's when it passes closingLineProblems (by 'writer'), else the first of safeLines
 * that passes (by 'safe'), else none (by 'none', the action alone). `refused`: what the writer's line broke.
 */
export function closingSlide(pack, { line = '', facts = [], others = [] } = {}) {
  const base = closingBase(pack);
  const given = oneLineOf(line);
  const refused = closingLineProblems(given, { base, pack, others, facts }).map((p) => p.msg);
  let chosen = !refused.length ? given : '';
  let by = chosen ? 'writer' : 'none';
  if (!chosen) {
    chosen = safeLines(base, pack).map(oneLineOf).find((t) => t && !closingLineProblems(t, { base, pack, others, facts, writer: false }).length) || '';
    if (chosen) by = 'safe';
  }
  return { closing: { kind: base.kind, line: chosen, by, ...base, actions: closingActions(base) }, refused };
}

/** The closing slide as the fact gate and the renderer take it with the post's other texts (build.js extraOf). */
export const closingExtra = (draft) => (draft?.closing ? { closing: draft.closing } : {});

/**
 * The post's closing slide with this line as it is, checked by nobody yet: what the writer wrote (by 'writer') or a
 * repair (by 'repair'), for closingProblems to judge. Its action is the code's, from the account's promo, as always.
 */
export function closingFrom(pack, line, by = 'writer') {
  const base = closingBase(pack);
  return { kind: base.kind, line: oneLineOf(line), by, ...base, actions: closingActions(base) };
}

/** What the closing slide sends people to, as the slide draws it: its kind, the store, the product, the address, the handle. */
const destination = (c) => [c?.kind, c?.name || '', c?.product || '', c?.url || '', c?.kind === 'follow' ? c?.handle || '' : ''].join('|');
const said = (c) => (c?.kind === 'follow' ? `following @${c.handle}` : c?.kind === 'product' ? `"${c.product}" of ${c.name}` : c ? `${c.name}${c.url ? ` (${c.url})` : ''}` : 'nothing');

/**
 * Every way a post's closing slide fails, as check problems ({ where: 'closing', code: 'closing', msg }, English, the
 * writer's and the trace's words), [] for one that may go out: none at all; no action for one of the platforms; a
 * destination that is not the account's promo now (a promo changed, added or taken away after the post was written);
 * no line; a line that breaks a rule (closingLineProblems, held to the promo it names: a line of the promo's own words,
 * by 'safe', need not be a sentence or name it again). `facts`: the post's, for the numbers a line may state.
 */
export function closingProblems(closing, { pack, others = [], facts = [] } = {}) {
  const out = [];
  const add = (msg) => out.push({ where: 'closing', code: 'closing', msg });
  if (!closing) {
    add('the post has no closing slide: every post ends on one, its line tying the topic to what the account sends people to');
    return out;
  }
  for (const p of ['tiktok', 'instagram', 'facebook']) if (!closing.actions?.[p]?.text) add(`the closing slide has no action for ${p}`);
  const now = closingBase(pack);
  if (destination(closing) !== destination(now)) add(`the closing slide sends people to ${said(closing)}, and the account now sends them to ${said(now)}`);
  if (!String(closing.line || '').trim()) {
    add("the closing slide has no line: write one short line that ties this post's topic to what the slide sends people to");
    return out;
  }
  for (const p of closingLineProblems(closing.line, { base: closing, pack, others, facts, writer: closing.by !== 'safe' })) add(p.msg);
  return out;
}

/** A stored post's closing slide checked again before it is sent: the problems' words, [] when it may go out. */
export const storedClosingProblems = (post, pack, { others = [] } = {}) =>
  closingProblems(post?.data?.closing || null, { pack, others, facts: (post?.facts || []).filter((f) => f.verified) }).map((p) => p.msg);

/** Is this check problem the closing slide's? */
export const isClosingProblem = (p) => p?.where === 'closing';

// ---------------------------------------------------------------- the writer's instructions

/**
 * The example the writer is shown for each kind of closing slide, with the promo it was written for: examples of
 * the tone, not lines to copy, each from a business few accounts will be (a run whose topic was its example's wrote
 * the example back word for word). test/closing.test.js checks each one passes closingLineProblems.
 */
export const EXAMPLES = {
  product: { business: 'a bakery', after: 'a sourdough loaf that stays fresh for a week', line: 'לחם שנשאר טרי שבוע? יש אצלנו כיכר מחמצת מקמח מלא', promo: { name: 'מאפיית השכונה', promise: 'לחם מחמצת ומאפים שנאפים כל בוקר', target: { kind: 'product', name: 'כיכר מחמצת מקמח מלא', url: 'https://bakery.example/loaf' } } },
  site: { business: 'a bicycle shop', after: 'riding a city bike in the rain', line: 'רוכבים גם בגשם? בבית האופניים יש אביזרים לאופניים עירוניים', promo: { name: 'בית האופניים', promise: 'אביזרים, חלקים ותיקונים לאופניים עירוניים', target: { kind: 'site', url: 'https://bikes.example/' } } },
  bio: { business: 'a camping store', after: 'what to pack for a first night in a tent', line: 'ללילה הראשון בשטח יש באוהל וכוכבים ציוד למתחילים', promo: { name: 'אוהל וכוכבים', promise: 'ציוד קמפינג למתחילים ולמשפחות', target: { kind: 'bio' } } },
  follow: { business: 'a home cooking account', after: 'why pasta water needs salt', line: 'עוד דברים קטנים שמשנים ארוחת ערב, בפוסטים הבאים', promo: null },
};

const RULES = `THE LINE: one sentence, or a short question and its answer, ${CLOSING_LINE.minWords} to ${CLOSING_LINE.maxWords} words and at most ${CLOSING_LINE.maxChars} characters, on one line (no "\\n"). It follows HEBREW THAT SOUNDS LIKE A PERSON and speaks for the account: "אנחנו", "אצלנו" when the business speaks of itself, the audience in the plural ("לכם"), never "לך" and never a slash. The code checks it, and a line that breaks any of these is not used: the slide takes the promo's own words instead.
- No claim the store did not make: never "הכי", "ביותר", "מספר 1", "המוביל", "מושלם", "בלעדי"; no sale, discount, gift, price or "חינם" the promise does not mention; no number that is not in the promise, the product's name or the facts; no property of a product the facts or the promo do not state.
- No urgency or scarcity: never "רק היום", "לזמן מוגבל", "נשארו רק", "מלאי", "מהרו", "עכשיו", "אל תפספסו".
- No action of its own, and nothing generic: never "בקרו באתר", "היכנסו", "לחצו", "הלינק בביו", "תעקבו", a web address or an @ handle (the action under the line is the code's), and never a line that would close any post.
- No exclamation mark, no long dash, no colon, no emoji.`;

/**
 * The CLOSING SLIDE section of the slides call's request: what this post's closing slide sends people to, the action
 * the code will write under the line on each platform, and the line's rules. `topic`: the post's own (outline.topic).
 */
export function closingRequest(pack, { topic = '' } = {}) {
  const base = closingBase(pack);
  const a = closingActions(base);
  const about = topic ? `this post's topic (${topic})` : "this post's topic";
  const ex = EXAMPLES[base.kind];
  const example = `For example, ${ex.business} after a post about ${ex.after}: "${ex.line}" (an example of the tone and of the tie, never a line to copy).`;
  const action = base.kind === 'follow' || base.kind === 'bio' || a.tiktok.text === a.instagram.text ? `"${a.tiktok.text}" on every platform` : `on TikTok "${a.tiktok.text}", on Instagram and Facebook "${a.instagram.text}"`;
  const head = `CLOSING SLIDE: after the last content slide comes the post's closing slide. Write its one line in closing.line; the code writes the action under it (${action}), so the line never says it.`;
  // The line starts from the post and lands on the promo: the store's promise said again would close any post.
  const start = `The line starts from ${about}: its subject, the problem it solves or the moment it tells, so that someone who sees only this line knows what the post was about.`;
  const never = "Never the promise said again on its own: a line that would close any of the account's posts is not this post's.";
  const what = {
    product: `It sends people to one product of ${base.name}: "${base.product}" (the store says of itself: "${base.promise}"). ${start} It lands on that product as the fit for it, named as it is written ("${base.product}", or its first words).`,
    site: `It sends people to ${base.name}'s site (the store says of itself: "${base.promise}"). ${start} It lands on what the store has for it, as its promise says it, naming "${base.name}" as it is written. ${never}`,
    bio: `It sends people to the link on the account's profile, ${base.name}'s (the store says of itself: "${base.promise}"). ${start} It lands on what the store has for it, as its promise says it, naming "${base.name}" as it is written. ${never}`,
    follow: `It asks them to follow @${base.handle}, an account about ${(pack?.meta?.topics || []).join(', ') || 'its niche'}. ${start} It says what more of it they get by following: more of what the account posts about, said for this post, never a promise of how often.`,
  }[base.kind];
  return [head, what, example, RULES].join('\n');
}
