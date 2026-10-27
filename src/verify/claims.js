import { createHash } from 'node:crypto';
import { visualText } from '../render/visuals.js';
import { now } from '../core/clock.js';
import { israelDate } from '../schedule/israel.js';

// HARD RULE 3: every fact on a slide traces to an approved source, stored with
// the post and checked in code before rendering.
//
// A fact is { claim, quote, document }. It is verified when:
//   1. its document exists, was stored from a source of THIS account, and that
//      source is approved right now (a source removed on the website stops
//      vouching for anything not yet published)
//   2. the quote appears in the stored text of that document, verbatim after
//      normalising whitespace, punctuation and case: a paraphrased quote is the
//      case where the claim came from the model's memory instead of the source
//   3. the quote is long enough to be evidence and short enough to be a short
//      fact rather than a copied paragraph (HARD RULE 5, copyright)
//   4. every number in the claim appears in the quote
//
// An ATTRIBUTED fact (fact.who) is what someone said or reported, not what is so: a fighter's own account, a
// manager's claim, an outlet's report. It is verified like any fact, and then the document must show that it is
// theirs: their name and a word of saying or reporting ("said", "told", "according to", "סיפר", "לפי") stand within
// ATTRIBUTION_REACH characters of the quote, or the source itself is the one reporting it ("לפי Sherdog" from
// Sherdog). On a slide it is never stated as plain fact: the slide names them and says they said it. A post
// carries ATTRIBUTED_MAX of them at most: it stands on facts, and lets a few voices speak.
//
// Then the gate, before rendering: every content slide states at least one
// verified fact, and every number on any slide, the cover or the caption appears
// in a quote the post cites. "Verified" means traceable: if the source is wrong
// this repeats it faithfully. It never means invented.

/** Normalise for comparison: letters and digits of any script, single-spaced, lowercase. */
export function normalise(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[‘’ʼ׳`]/g, "'")
    .replace(/[“”״]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/[^\p{L}\p{N}%.]+/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Numbers written in words, read as the digits they mean before anything is compared: "עשרים ושלושה" is 23
// and "twenty-three" is 23, not a 20 and a 3 that no quote holds. A run of number words is one number: tens
// and units joined by "ו" or "and", a teen ("שלוש עשרה", "אחד עשר"), hundreds and thousands ("מאה ושבעים
// וחמישה", "שלושת אלפים", "one hundred and seventy-five").
//
// Each word is [value, type]: 'n' adds itself, 'x' multiplies what came before it (hundred, אלף, million),
// 'p' is a plural multiplier that means nothing without a number before it ("מאות אוהדים" is hundreds of
// fans, not 100), 'a' is a whole number only on its own ("פעמיים", "twice").
const EN_WORDS = {
  zero: [0, 'n'], one: [1, 'n'], two: [2, 'n'], three: [3, 'n'], four: [4, 'n'], five: [5, 'n'], six: [6, 'n'], seven: [7, 'n'], eight: [8, 'n'], nine: [9, 'n'],
  ten: [10, 'n'], eleven: [11, 'n'], twelve: [12, 'n'], thirteen: [13, 'n'], fourteen: [14, 'n'], fifteen: [15, 'n'], sixteen: [16, 'n'], seventeen: [17, 'n'], eighteen: [18, 'n'], nineteen: [19, 'n'],
  twenty: [20, 'n'], thirty: [30, 'n'], forty: [40, 'n'], fifty: [50, 'n'], sixty: [60, 'n'], seventy: [70, 'n'], eighty: [80, 'n'], ninety: [90, 'n'],
  hundred: [100, 'x'], thousand: [1000, 'x'], million: [1e6, 'x'], billion: [1e9, 'x'], twice: [2, 'a'],
};
const ORDINALS = { third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 };

// One and two (אחד, שני, שתי) count only inside a longer number: on their own, "אחד הצמחים" and "יום שני"
// are not numbers, and a guard that refuses correct Hebrew is a broken guard.
const HE_WORDS = {
  אחד: [1, 'n'], אחת: [1, 'n'], שניים: [2, 'n'], שנים: [2, 'n'], שני: [2, 'n'], שתיים: [2, 'n'], שתים: [2, 'n'], שתי: [2, 'n'],
  שלוש: [3, 'n'], שלושה: [3, 'n'], שלושת: [3, 'n'], ארבע: [4, 'n'], ארבעה: [4, 'n'], ארבעת: [4, 'n'], חמש: [5, 'n'], חמישה: [5, 'n'], חמשת: [5, 'n'],
  שש: [6, 'n'], שישה: [6, 'n'], ששת: [6, 'n'], שבע: [7, 'n'], שבעה: [7, 'n'], שבעת: [7, 'n'], שמונה: [8, 'n'], שמונת: [8, 'n'], תשע: [9, 'n'], תשעה: [9, 'n'], תשעת: [9, 'n'],
  עשר: [10, 'n'], עשרה: [10, 'n'], עשרת: [10, 'n'],
  עשרים: [20, 'n'], שלושים: [30, 'n'], ארבעים: [40, 'n'], חמישים: [50, 'n'], שישים: [60, 'n'], שבעים: [70, 'n'], שמונים: [80, 'n'], תשעים: [90, 'n'],
  מאה: [100, 'n'], מאת: [100, 'n'], מאתיים: [200, 'n'], מאות: [100, 'p'],
  אלף: [1000, 'x'], אלפים: [1000, 'p'], אלפיים: [2000, 'n'], מיליון: [1e6, 'x'], מליון: [1e6, 'x'], מיליונים: [1e6, 'p'], מיליארד: [1e9, 'x'], מיליארדים: [1e9, 'p'],
  פעמיים: [2, 'a'],
};
const HE_ALT = Object.keys(HE_WORDS).sort((a, b) => b.length - a.length).join('|');
// The first word of a run may carry up to two prefix letters ("ובשלושת"); a later one only "ו".
const HE_RUN = new RegExp(`(?<![\\p{L}])[ובלהמש]{0,2}(?:${HE_ALT})(?![\\p{L}])(?:\\s+ו?(?:${HE_ALT})(?![\\p{L}]))*`, 'gu');
const HE_TOKEN = new RegExp(`(?:^|\\s+)[ובלהמש]{0,2}(${HE_ALT})(?![\\p{L}])`, 'gu');
const EN_ALT = Object.keys(EN_WORDS).join('|');
const EN_RUN = new RegExp(`\\b(?:${EN_ALT})\\b(?:(?:\\s+and\\s+|[\\s-]+)(?:${EN_ALT})\\b)*`, 'gi');
const ORD_RE = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\b`, 'gi');

/**
 * The numbers one run of number words states. A word that cannot continue the number before it starts the next one:
 * "עשרים ושלושים" is twenty and thirty, not fifty. `small`: a one or a two on its own counts (English); in Hebrew it
 * counts only inside a longer number, so "ארבע שנים" (four years) is 4, not a 4 and a 2.
 */
function runValues(words, { small = true } = {}) {
  const out = [];
  let total = 0;
  let current = 0;
  let open = 0;
  const close = () => {
    if (open && (small || open > 1 || total + current > 2)) out.push(total + current);
    total = 0;
    current = 0;
    open = 0;
  };
  for (const [v, type] of words) {
    if (type === 'a') {
      close();
      if (words.length === 1) out.push(v);
      continue;
    }
    if (type === 'n') {
      const fits = v < 10 ? current % 10 === 0 : v === 10 ? current < 10 || current % 100 === 0 : v < 100 ? current % 100 === 0 : current % 1000 === 0;
      if (open && !fits) close();
      current += v;
      open++;
      continue;
    } else if (type === 'p' && !current) {
      // "מאות אוהדים": hundreds of fans, no number.
      close();
      continue;
    } else if (v === 100) current = (current || 1) * 100;
    else {
      // A thousand and up close a group: "שלושת אלפים ומאתיים".
      total += (current || 1) * v;
      current = 0;
    }
    open++;
  }
  close();
  return out;
}

/** The numbers a text writes in words, as values in the order they appear: Hebrew (`hebrew`) and English (`english`). */
export function numberWords(text, { hebrew = false, english = false } = {}) {
  const s = String(text || '');
  const out = [];
  if (hebrew) {
    for (const m of s.matchAll(HE_RUN)) {
      const words = [...m[0].matchAll(HE_TOKEN)].map((t) => HE_WORDS[t[1]]);
      // "באר שבע" is a city, not the number seven; "המאה ה-20" is a century, not 100.
      if (words.length === 1 && /שבע$/.test(m[0]) && /באר\s*$/.test(s.slice(0, m.index))) continue;
      if (words.length === 1 && /מאה$/.test(m[0]) && /^\s*ה[-־]?(?:\d|[א-ת])/.test(s.slice(m.index + m[0].length))) continue;
      // "מליון ועד ריאל" is from Lyon: the short spelling of a million alone is the city, a million is spelled "מיליון".
      if (words.length === 1 && /^ו?מליון$/.test(m[0])) continue;
      // One or two alone states no number ("אחד הצמחים", "יום שני", "ארבע שנים").
      for (const v of runValues(words, { small: false })) out.push([m.index, v]);
    }
  }
  if (english) {
    for (const m of s.matchAll(EN_RUN)) for (const v of runValues(m[0].toLowerCase().split(/\s+and\s+|[\s-]+/).filter(Boolean).map((w) => EN_WORDS[w]))) out.push([m.index, v]);
    for (const m of s.matchAll(ORD_RE)) out.push([m.index, ORDINALS[m[1].toLowerCase()]]);
  }
  return out.sort((x, y) => x[0] - y[0]).map(([, v]) => v);
}

/**
 * The numbers a text states, normalised: "1,000" and "1000" are the same number, and so are "עשרים ושלושה",
 * "twenty-three" and "23".
 * words: also English number words and ordinals ("five", "twenty-three", "fourteenth"), for quotes.
 * hebrew: also Hebrew number words ("חמש", "עשרים ושלושה", "שלושת אלפים"), for slide text and quotes.
 */
export function numbersIn(text, { words = false, hebrew = false } = {}) {
  // Digits inside a name that starts with a Latin letter are part of the name, not a number:
  // "Base44", "GPT-4o", "H100", "Web3". A token that starts with its digits ("20M", "4K") is a number.
  const s = String(text || '').replace(/(?<![\p{L}\p{N}])[A-Za-z][A-Za-z.]*(?:-?\d+[A-Za-z0-9.]*)+/gu, (t) => t.replace(/\d/g, 'x'));
  const out = new Set();
  for (const m of s.matchAll(/\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(String(n));
  }
  // A multiplier word right after digits ("25 מיליון", "3 thousand") is those digits' unit, not a number of its own.
  const rest = s.replace(/(\d)\s*[-־]?\s*(?:מיליון|מליון|מיליארד|אלף|million|billion|thousand|hundred)(?![\p{L}])/giu, '$1');
  for (const v of numberWords(rest, { hebrew, english: words })) out.add(String(v));
  return out;
}

const wordCount = (s) => normalise(s).split(' ').filter(Boolean).length;

export const MIN_QUOTE_WORDS = 4;
export const ATTRIBUTED_MAX = 2;
export const ATTRIBUTION_REACH = 300;

// Words of saying and reporting, in a document (any language it is in, normalised) and on a slide (Hebrew).
const SAID_DOC = /\b(said|says|saying|told|tells|according|reported|reports|reporting|claimed|claims|revealed|reveals|admitted|admits|insisted|insists|wrote|writes|added|explained|explains|stated|tweeted|posted|announced|confirmed|recalled|recalls|believes|argued|argues)\b|(?<![\p{L}])[ושה]?(אמר|אמרה|סיפר|סיפרה|לדברי|לפי|טען|טענה|דיווח|דיווחה|דווח|כתב|כתבה|הודה|הודתה|חשף|חשפה|הוסיף|הוסיפה|ציין|ציינה|הסביר|הסבירה|מסר|מסרה|הודיע|הודיעה)(?![\p{L}])/u;
const SAID_SLIDE = /(?<![\p{L}])[ו]?(לפי|לדברי|לדבריו|לדבריה|לטענת|לטענתו|לטענתה|אמר|אמרה|אומר|אומרת|סיפר|סיפרה|מספר|מספרת|טען|טענה|טוען|טוענת|דיווח|דיווחה|דווח|מדווח|כתב|כתבה|הודה|הודתה|חשף|חשפה|ציין|ציינה|הוסיף|הוסיפה|הסביר|הסבירה|מסר|מסרה|הודיע|הודיעה|העיד|העידה|התלונן|התלוננה|נזכר|נזכרה)(?![\p{L}])/u;

const nameParts = (s) => normalise(s).split(' ').filter((w) => w.length >= 3 || /^\p{Lu}{2}$/u.test(w));

/** Whether a slide names who said an attributed fact and says that they said it. Pure. */
export function attributes(text, { who = '', whoHe = '' } = {}) {
  const t = normalise(text);
  const names = [...nameParts(whoHe), ...nameParts(who)];
  return names.some((n) => t.includes(n)) && SAID_SLIDE.test(String(text || ''));
}

/**
 * Verify one fact against the database. Returns { ok, error }.
 * fact: { claim, quote, document_id }; account: the account id; opts.maxQuoteWords from rules.json.
 */
export function verifyFact(db, fact, { accountId, maxQuoteWords = 40 } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!fact?.document_id) return fail('no source document');
  const doc = db.get(
    `SELECT d.text, d.url, d.expires_at, s.account_id, s.status, s.name, s.url AS source_url FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ?`,
    fact.document_id
  );
  if (!doc) return fail('the source document is not stored');
  if (doc.account_id !== accountId) return fail(`the source belongs to another account (${doc.account_id})`);
  if (doc.status !== 'approved') return fail(`the source "${doc.name}" is not approved (${doc.status})`);
  // Hand-checked facts stop being evidence on their expiry date, until checked again.
  if (doc.expires_at && israelDate(now()) > doc.expires_at) return fail(`a hand-checked fact here expired on ${doc.expires_at}: check it again on the website`);
  const quote = String(fact.quote || '').trim();
  if (!quote) return fail('no quote');
  if (/\.\.\.|…/.test(quote)) return fail('the quote is cut with an ellipsis');
  const n = wordCount(quote);
  // A table's labelled row is evidence however short: a fighter's record is an infobox of two- and three-word rows
  // ("Wins | 17", "By knockout | 7"), and every stat of every head-to-head was refused as "too short". Such a row must
  // be in the document once, as whole words ("Wins | 17" is not in "Wins | 170").
  const row = /\|/.test(quote) && /\p{N}/u.test(quote) && n >= 2;
  if (n < MIN_QUOTE_WORDS && !row) return fail(`the quote is ${n} words, too short to be evidence of anything`);
  if (n > maxQuoteWords) return fail(`the quote is ${n} words, more than ${maxQuoteWords}: a short fact, not a copied passage`);
  if (!normalise(doc.text).includes(normalise(quote))) return fail('the quote is not in the source document, word for word');
  if (n < MIN_QUOTE_WORDS) {
    const hits = ` ${normalise(doc.text)} `.split(` ${normalise(quote)} `).length - 1;
    if (hits !== 1) return fail(`the row "${quote}" is in the document ${hits ? `${hits} times` : 'only inside a longer one'}: quote it with the words around it`);
  }
  const inQuote = numbersIn(quote, { words: true, hebrew: true });
  const missing = [...numbersIn(fact.claim, { hebrew: true })].filter((x) => !inQuote.has(x));
  if (missing.length) return fail(`the claim states ${missing.join(', ')}, which the quote does not`);
  if (!String(fact.claim || '').trim()) return fail('no claim');
  // An attributed fact is theirs only where the document says so.
  const who = String(fact.who || '').trim();
  if (who) {
    const names = nameParts(who);
    if (!names.length) return fail('attributed, but to no one by name');
    const host = (u) => {
      try {
        return normalise(new URL(u).hostname.replace(/^www\./, ''));
      } catch {
        return '';
      }
    };
    const outlet = `${normalise(doc.name)} ${host(doc.url)} ${host(doc.source_url)}`;
    if (!names.some((n) => outlet.includes(n))) {
      const text = normalise(doc.text);
      const q = normalise(quote);
      const at = text.indexOf(q);
      const near = text.slice(Math.max(0, at - ATTRIBUTION_REACH), at + q.length + ATTRIBUTION_REACH);
      if (!names.some((n) => near.split(' ').includes(n))) return fail(`attributed to ${who}, but the document does not name them beside the quote`);
      if (!SAID_DOC.test(near)) return fail(`attributed to ${who}, but nothing beside the quote says they said or reported it`);
    }
  }
  return { ok: true, error: null };
}

/**
 * The gate before rendering. slides: [{ kind, title, body, factKeys }]; facts:
 * [{ key, quote, verified }]; caption: string. Returns { ok, problems, token }.
 *
 * `token` is a hash of exactly what was checked. The renderer refuses a post
 * whose text no longer hashes to its token, so an edit after the check cannot
 * reach a rendered slide without passing the gate again.
 */
export function gate({ slides, facts, caption = '', hook = '', sub = '', extra = {}, structure = null, factFree = () => false }) {
  const problems = [];
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const items = slides.filter((s) => s.kind === 'item');
  const allQuoteNums = new Set(facts.filter((f) => f.verified).flatMap((f) => [...numbersIn(f.quote, { words: true, hebrew: true })]));
  // The post's own structure (how many slides, a top 10) is not a claim.
  const own = structure || new Set([String(items.length)]);

  const attributed = new Set();
  items.forEach((s, i) => {
    const where = `slide ${i + 1}`;
    const keys = s.factKeys || [];
    // A myth as people say it, a verdict, a joke's setup: no fact of its own, and
    // still no number the post's quotes do not hold.
    const free = factFree(s.role);
    if (!keys.length && !free) problems.push(`${where}: states no sourced fact`);
    const cited = keys.map((k) => byKey.get(k));
    keys.forEach((k, x) => {
      if (!cited[x]) problems.push(`${where}: cites "${k}", which is not one of the post's facts`);
      else if (!cited[x].verified) problems.push(`${where}: cites "${k}", which failed verification (${cited[x].error || 'unverified'})`);
    });
    const nums = !keys.length && free ? allQuoteNums : new Set(cited.filter((f) => f?.verified).flatMap((f) => [...numbersIn(f.quote, { words: true, hebrew: true })]));
    // A count written in Hebrew words ("חמש") is held to its quotes like one written in digits,
    // and so are a head-to-head's two values.
    for (const x of numbersIn(`${s.title} ${s.body} ${s.a || ''} ${s.b || ''}`, { hebrew: true })) if (!nums.has(x)) problems.push(`${where}: the number ${x} is not in the quotes it cites`);
    // A slide's graphic says its numbers too: a bar drawn at 120 is a claim of 120.
    for (const x of numbersIn(visualText(s.visual), { hebrew: true })) if (!nums.has(x)) problems.push(`${where}: the visual's number ${x} is not in the quotes the slide cites`);
    // What someone said is said as theirs: the slide names them and that they said it, never as plain fact.
    for (const f of cited) {
      if (!f?.verified || !String(f.who || '').trim()) continue;
      attributed.add(f.key);
      const name = f.whoHe || f.who;
      if (!attributes(`${s.title} ${s.body} ${s.a || ''} ${s.b || ''}`, f)) problems.push(`${where}: "${f.key}" is what ${name} said or reported: the slide names them and says so ("לפי ${name}", "${name} סיפר"), never as plain fact`);
    }
  });
  if (attributed.size > ATTRIBUTED_MAX) problems.push(`the slides state ${attributed.size} attributed facts (${[...attributed].join(', ')}): ${ATTRIBUTED_MAX} at most, the rest of the post stands on facts`);
  for (const [where, text] of [
    ['the cover', `${hook} ${sub} ${(extra.keywords || []).join(' ')} ${extra.subject?.date || ''} ${visualText(extra.coverVisual)}`],
    ['the caption', `${caption} ${extra.captionIg || ''}`],
  ]) {
    // "שמונה שנים" on a cover is a number like "8": held to the quotes, unless it is the post's own count.
    for (const x of numbersIn(text, { hebrew: true })) if (!own.has(x) && !allQuoteNums.has(x)) problems.push(`${where}: the number ${x} is not in any cited quote`);
  }
  const token = tokenOf({ slides, caption, hook, sub, extra });
  return { ok: problems.length === 0, problems, token };
}

/**
 * A hash of exactly the text that was checked. The fields a phase 1 post never
 * had (a slide's role and values, the Instagram caption, the keywords, the
 * subject, the call to action) are hashed only when present, so a stored post's
 * token still matches its text.
 */
export function tokenOf({ slides, caption = '', hook = '', sub = '', extra = {} }) {
  const slide = (s) => {
    const base = [s.kind, s.title || '', s.body || '', s.factKeys || []];
    const role = s.role && !['item', 'cover', 'closer'].includes(s.role) ? s.role : '';
    const withRole = role || s.a || s.b ? [...base, role, s.a || '', s.b || ''] : base;
    // A slide's graphic is part of what was checked, when it has one.
    return s.visual ? [...withRole, s.visual] : withRole;
  };
  const x = Object.fromEntries(Object.entries(extra || {}).filter(([, v]) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.values(v).some(Boolean) : Boolean(v))));
  const body = JSON.stringify({ hook, sub, caption, slides: slides.map(slide), ...(Object.keys(x).length ? { extra: x } : {}) });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}
