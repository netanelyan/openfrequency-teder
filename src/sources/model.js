import { createHash } from 'node:crypto';
import { nowIso } from '../core/clock.js';
import { askJson } from '../llm/index.js';

// Facts from the model's general knowledge, when the sources are thin.
//
// The owner, 2026-11-06: "the engine cant write examples for openfrequency tiktok and instagram ... even if you cant
// verify a fact or a source, we should use it. maybe add an AI that tells facts and stuff like this, when a source is
// thin or sources are thin". OpenFrequency's own account (entrepreneurship and business for everyone) found sources
// whose documents were home pages, a news site's tag page and a foreign agency's press releases; the outline refused
// every one of them for every format (no subject the audience knows, nothing to quote), and no sample was written.
//
// So when nothing the account's sources hold carries a post (src/pipeline/build.js buildPost, its second pass), the
// model is asked once for what it knows about one subject of the niche that the audience knows by name: a short page
// of well-known, stable facts, stored as one document of the account's "model" source (MODEL_KEY). From there it is a
// document like any other: the outline plans from it, every quote is checked against it word for word, every number on
// a slide must be in the quotes. What it is not is a source anyone checked, and nothing pretends it is:
//
//   - the post's card says "ידע כללי" in the corner of each slide that stands on such facts, "בלי מקור, כדאי לבדוק"
//     beside each of them where it says where its facts come from (src/web/pages.js factsBlock), and its line of
//     facts, in the warning's colour, how many are general knowledge (trustLine); the slide draws no "מקור:" line for
//     it (build.js sourceLabel). The card used to say "כל אחת עם מקור" of them (the audit, 2026-11-12, P1-5);
//   - a post that stands on one waits for a person's approval in every mode: a customer's always does
//     (src/autonomy/rails.js), and the company's own accounts in digest or auto are held too (src/autonomy/runner.js);
//   - the prompt asks for facts an encyclopedia states the same way and for none of what a model invents best
//     (statistics, percentages, prices, sums, exact dates, quotations, the last two years), and the code drops a fact
//     that still carries one (stableFacts).
//
// The source is approved when it is made, so the fact gate takes its documents; it is the account's to remove on the
// Sources page like any other, and a removed one is never used again (modelFallback). It is never read on its own
// (candidateDocs leaves it out): its documents are made only here.

/** The model source's key in an account's sources. */
export const MODEL_KEY = 'model-knowledge';
/** Its name, as the Sources page and a post's facts show it ("המודל" is a word for us: the audit, 2026-11-12). */
export const MODEL_NAME = 'ידע כללי';
/** What a fact from it is labelled, wherever a post says where its facts come from. */
export const UNSOURCED_HE = 'בלי מקור, כדאי לבדוק';
/**
 * Why it is there, as the Sources page says it. Kept with the source when it is made, and said from here for one made
 * before (its stored words named "המודל").
 */
export const MODEL_WHY = 'עובדות כלליות שתדר מכיר בעצמו, בלי נתונים, מחירים ותאריכים מדויקים. הן משמשות רק כשבמקורות אין מספיק, ואף אחד לא בדק אותן מול מקור, ולכן פוסט שנשען עליהן מסומן "כדאי לבדוק".';
/** Its address: not a page anyone can open, so it never passes for one. */
const MODEL_URL = 'model:general-knowledge';
/** The fewest facts a page from the model must keep, after stableFacts, to be worth an outline. */
export const MODEL_MIN_FACTS = 4;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Is this stored source (a row, or its key) the model's general knowledge? */
export const isModelSource = (src) => (typeof src === 'string' ? src : src?.key) === MODEL_KEY;

/** May this account fall back on the model? A model to ask, and the account has not removed its model source. */
export function modelFallback(ctx, pack) {
  if (ctx.llm?.kind !== 'claude') return false;
  if (pack.meta?.modelFacts === false) return false;
  const row = ctx.db.get('SELECT status FROM sources WHERE account_id = ? AND key = ?', pack.id, MODEL_KEY);
  return !row || row.status === 'approved';
}

/** The account's model source, made (approved) the first time it is needed. */
export function modelSource(db, accountId) {
  const have = db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', accountId, MODEL_KEY);
  if (have) return have;
  const at = nowIso();
  db.insert('sources', {
    account_id: accountId, key: MODEL_KEY, type: 'api', url: MODEL_URL, name: MODEL_NAME, lang: 'he', status: 'approved', origin: 'discovered', approved_at: at, created_at: at,
    why: MODEL_WHY,
    config_json: { api: { kind: 'model' } },
  });
  return db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', accountId, MODEL_KEY);
}

/** Does this stored post stand on a fact from the model? (its facts' source) */
export const hasModelFacts = (db, postId) => Boolean(db.get('SELECT 1 FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.post_id = ? AND s.key = ? LIMIT 1', postId, MODEL_KEY));

// What a model invents best, and the code takes out whatever the prompt let through: a percentage, a currency or a
// sum, a quotation, and any figure but a year (a founding year is the kind of fact an encyclopedia agrees on).
const RISKY = /[%٪‰₪$€£¥]|["“”„«»]|\bפרצנט|\bאחוז|\bשקל|\bדולר|\bמיליון|\bמיליארד|\bmillion\b|\bbillion\b|\bpercent\b/i;
const YEAR = /^(1[5-9]\d\d|20[0-2]\d)$/;
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/** The facts kept from the model's answer: one sentence each, 6 to 35 words, nothing risky, and figures only as years. Pure. */
export function stableFacts(list) {
  const out = [];
  for (const raw of list || []) {
    const t = String(raw?.text ?? raw ?? '').replace(/\s+/g, ' ').trim();
    const n = words(t);
    if (n < 6 || n > 35 || RISKY.test(t)) continue;
    if ((t.match(/\p{N}+/gu) || []).some((x) => !YEAR.test(x))) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}

const SCHEMA = {
  type: 'object',
  properties: {
    usable: { type: 'boolean' },
    subject: { type: 'string' },
    why: { type: 'string' },
    facts: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  },
  required: ['usable', 'subject', 'why', 'facts'],
  additionalProperties: false,
};

/** The prompt: what to write, and what to leave out. Pure, for the tests. */
export function modelFactsPrompt(pack, { avoid = [], seed = {} } = {}) {
  const m = pack.meta || {};
  const niche = seed.niche || (m.topics || [])[0] || m.description || m.displayName;
  const audience = seed.audience || m.audience || 'Hebrew speakers in Israel';
  const system = `A Hebrew social account posts short slideshows about "${niche}" for ${audience}. Its sources are thin today, so it asks what you yourself know. Every slide will be built only from the facts you write here, and the account's owner checks the post before it goes out, but nobody will check your facts against a source.

Choose one subject of this field that most of the audience knows by name at once: a famous company, product, person, place, event or idea of the field (for Israelis, an Israeli name where there is a good one). Not a subject in this list of recent posts: ${avoid.length ? avoid.slice(0, 12).join(' | ') : '(none)'}.

Then write 6 to 10 facts about it that you are sure of: well-known and stable, the way any good encyclopedia states them (who started it, what it is, how it works, what happened in its famous story, what changed because of it, a lesson people in the field draw from it). Each fact is one Hebrew sentence of 8 to 30 words that stands alone: it names who or what it is about, never "he" or "it".

Leave out what a model gets wrong: no statistics, percentages, prices, sums, counts or exact dates (a well-known year is fine), no quotation of what anyone said, nothing from the last two years, nothing about a private person, no advice dressed as a fact. A fact you are not sure of is left out; fewer sure facts are better than more doubtful ones. If you know nothing sure enough about any subject of this field, return usable=false.

Return { usable, subject (its name, in the account's language), why (one short line: why this audience would stop for it), facts: [{ text }] }.`;
  const user = [`Field: ${niche}`, `Audience: ${audience}`, m.topics?.length ? `Topics: ${m.topics.join(', ')}` : '', seed.topics?.length ? `The owner's topics: ${seed.topics.join(', ')}` : ''].filter(Boolean).join('\n');
  return { system, user };
}

/**
 * One page of the model's general knowledge for this account, stored as a document of its model source: { doc, usd,
 * why, subject }. `doc` is the stored row with the fields candidateDocs gives a document (sourceName, sourceKey), or
 * null: no model, the account removed the source, the model knew nothing sure enough, or too little was left after
 * stableFacts (`why` says which).
 */
export async function modelFactsDoc(ctx, pack, { avoid = [], seed = {} } = {}) {
  if (!modelFallback(ctx, pack)) return { doc: null, usd: 0, why: 'no model, or the account removed its model source' };
  const p = modelFactsPrompt(pack, { avoid, seed });
  const { data, usd } = await askJson(ctx, { task: 'model_facts', role: 'draft', system: p.system, user: p.user, schema: SCHEMA, effort: 'low', maxTokens: 3000, expectOut: 900 });
  if (!data?.usable) return { doc: null, usd, why: String(data?.why || 'the model knew nothing sure enough') };
  const facts = stableFacts(data.facts);
  const subject = String(data.subject || '').trim().slice(0, 80);
  if (facts.length < MODEL_MIN_FACTS || !subject) return { doc: null, usd, why: `only ${facts.length} fact(s) left after the checks` };
  const src = modelSource(ctx.db, pack.id);
  const text = facts.join('\n');
  const hash = sha(text);
  let row = ctx.db.get('SELECT * FROM documents WHERE source_id = ? AND sha256 = ?', src.id, hash);
  if (!row) {
    const slug = subject.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'subject';
    const id = ctx.db.insert('documents', { source_id: src.id, key: `model-${slug}-${hash.slice(0, 8)}`, url: `${MODEL_URL}/${encodeURIComponent(slug)}`, title: `${subject} (${MODEL_NAME})`, text, sha256: hash, published_at: null, fetched_at: nowIso(), recorded: 0 });
    row = ctx.db.get('SELECT * FROM documents WHERE id = ?', id);
  }
  return { doc: { ...row, sourceName: src.name, sourceKey: src.key }, usd, why: String(data.why || '').slice(0, 300), subject };
}
