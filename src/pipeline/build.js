import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { newId, nowIso, now, DAY } from '../core/clock.js';
import { mediaDir, packsDir } from '../core/paths.js';
import { step, settings } from '../core/store.js';
import { j } from '../db/index.js';
import { postSpend } from '../budget/ledger.js';
import { quotaMonth, room } from '../budget/quota.js';
import { askJson } from '../llm/index.js';
import { NoRecording } from '../llm/recorded.js';
import { refreshSource } from '../sources/index.js';
import { ensureFormats, groupsOf, mixOf, pickFormat, pickHook } from '../formats/rotation.js';
import { contentRange, ctasOf, factFree, groupOf, hookPatterns, kindName, kindOf, kindProblems, linesOfBody, ranksOf, shapeProblems, structureNumbers } from '../formats/kinds.js';
import { resolveFormat } from '../trends/index.js';
import { isGenericQuestion, limitsFor, mechanicalFix, normHe, tellsIn } from '../voice/tells.js';
import { BLOCK_AT, REWRITE_AT, reviewTexts } from '../voice/review.js';
import { lockedStyle, lookFor, styleForPost } from '../render/style.js';
import { highlightProblems, styleFitProblems } from '../render/styles/fit.js';
import { checkRules } from '../rules/check.js';
import { lineDraft, oneLine, overlayOf, overlayProblems } from '../rules/overlay.js';
import { MAX_HASHTAGS, captionProblems, hashtagProblems, storyCaption } from '../rules/caption.js';
import { ATTRIBUTED_MAX, gate, numbersIn, verifyFact } from '../verify/claims.js';
import { findImage, MIN_SIDE } from '../images/index.js';
import { normVisual, slideHasVisual, visualProblems, visualsOf, visualText } from '../render/visuals.js';
import { renderPost, slidePlaces } from '../render/render.js';
import { israelDate } from '../schedule/israel.js';
import { upcoming } from '../schedule/events.js';
import { detailsPrompt, detailsUser, outlinePrompt, outlineUser, repairPrompt, repairUser, rewritePrompt, rewriteUser, slidesPrompt, slidesUser, visualsNeeded } from './prompts.js';
import { REPAIR_ATTEMPTS, applyRepair, repairPlan } from './repair.js';
import { nicheForOutline, nicheForSlides, rivalsOf } from './rivals.js';
import { aboutSubject, research } from '../sources/research.js';
import { markTopic, readyTopics, topicDocs } from '../topics/index.js';

// One post, from topic to a rendered, queued slideshow:
//
//   format and its kind -> documents from approved sources -> outline -> facts
//   verified -> the shape checked -> slides -> voice, tell, shape and fact checks
//   -> review -> render -> queue
//
// What it costs is kept down by doing in code whatever code can do: documents
// are narrowed to their content before the model sees them, facts are verified
// before any slide is written, the shape of the post is checked in code,
// punctuation tells are fixed in code instead of by a redraft, a generic closing
// question is dropped, the slides get one redraft at most, and the review runs
// only after every code check passed. The lines it flags get one rewrite, only
// then; whatever is still wrong drops the post. Nothing is ever retried a
// second time.
//
// The format's kind (src/formats/kinds.js) is the post's shape: a story, a
// head-to-head, a guess-who. The code picks the format (by the account's mix of
// entertaining and number posts and by results), the cover pattern and the call
// to action; the model writes inside that shape.
//
// Every step writes a row to `steps` as it happens, so any post can be traced
// from a slide back to the fact, the quote, the stored document and the approved
// source, and a blocked post says exactly where and why it stopped.
//
// Returns { postId, status: 'queued'|'sample'|'blocked', reason, kind }. `kind`
// names a blocked post's failure: 'fact_check', 'review', 'render' and the rest
// block that post alone. No money cap stops a post (src/budget/ledger.js).
//
// THE CUSTOMER'S MONTH (src/budget/quota.js). A post that is not a sample is
// weighed against the account's quota before anything is spent: a QuotaError, and
// no post, when the month's suggestions (or for a redo, its redos) are used up. A
// queued post is marked a suggestion or a redo, a blocked one a retry: ours.

export class PausedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PausedError';
    this.code = 'paused';
  }
}

/** The account's quota for the month is used up: nothing is drafted, nothing spent, until the next month. */
export class QuotaError extends PausedError {
  constructor(message) {
    super(message);
    this.name = 'QuotaError';
    this.code = 'quota';
  }
}

const pickBy = (list, seed) => list[[...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % list.length];

/**
 * The hashtags for one post: the format's own, two broad, and the niche tags this
 * post is about (its words appear in the post's text), never more than five
 * (MAX_HASHTAGS, src/rules/caption.js). A
 * niche tag the post does not touch ("#צמחיתבלין" under a post about a fern) is
 * left off: a reader sees an unrelated tag as pasted. Without the text (an older
 * caller), the niche tags rotate.
 */
export function hashtagsFor(pack, format, seed, text = null) {
  const h = pack.formats.hashtags || {};
  const rot = (list, k) => {
    if (!list?.length) return [];
    const start = [...String(seed + k)].reduce((a, c) => (a + c.charCodeAt(0)) % list.length, 0);
    return [...list.slice(start), ...list.slice(0, start)];
  };
  const flat = (s) => String(s || '').toLowerCase().replace(/[\s#_'"׳״-]+/g, '');
  // A tag is about the post when its letters are whole words of it, joined as a hashtag
  // joins them ("#ליגתהעל" is "ליגת העל"), with a one-letter prefix allowed ("למסי"). As
  // a substring of the whole text, "#מסי" matched "המסירות" and landed on a Zahavi post.
  const words = text == null ? null : String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const mentions = (tag) => {
    const want = flat(tag);
    for (let i = 0; i < words.length; i++) {
      let s = '';
      for (let k = i; k < Math.min(words.length, i + 4) && s.length <= want.length; k++) {
        s += words[k];
        if (s === want || (s.length === want.length + 1 && /^[ובכלמשה]/.test(s) && s.slice(1) === want)) return true;
      }
    }
    return false;
  };
  const niche = words == null ? rot(h.niche, 'n') : (h.niche || []).filter(mentions);
  const tags = [...(format.hashtags || []), ...rot(h.broad, 'b').slice(0, 2), ...niche];
  return [...new Set(tags)].slice(0, MAX_HASHTAGS);
}

/**
 * The documents this account could post from now: fresh from its approved
 * sources, not used lately. A document a blocked or rejected post was drafted
 * from counts as used too, or the next post would draft the same failure again.
 */
/** How long a source's last read stands before it is read again. */
export const SOURCE_TTL_MS = 6 * 3600_000;

export async function candidateDocs(ctx, pack, { usedWithinDays = 45, day = null, keepBlocked = false } = {}) {
  const sources = ctx.db.all("SELECT * FROM sources WHERE account_id = ? AND status = 'approved' ORDER BY id", pack.id);
  // The pages of the events around this day, for a source that reads them (a fight week).
  const events = pack.meta.events ? upcoming(ctx.db, pack.id, day || israelDate(now()), 8).map((e) => decodeURIComponent(String(e.url || '').split('/wiki/')[1] || '').replace(/_/g, ' ')).filter(Boolean) : [];
  const docs = [];
  // A source read in the last six hours, for the same day, is not read again: its documents are in the database.
  // Every post reading every source was some forty requests a post, and Wikipedia throttles a reader that asks that often.
  const forDay = day || israelDate(now());
  for (const src of sources) {
    const last = j(src.last_docs_json, null);
    // A topic bank its owner has just edited is read again, whatever the clock says: a rewritten bank went unread for
    // six hours while the posts it was written for were being made.
    const bank = j(src.config_json, {})?.api;
    const bankFile = bank?.kind === 'bank' ? path.join(packsDir(), pack.id, bank.file || 'topics.json') : null;
    const edited = Boolean(bankFile && src.last_ok_at && existsSync(bankFile) && statSync(bankFile).mtimeMs > Date.parse(src.last_ok_at));
    const fresh = !edited && ctx.sources?.kind === 'live' && last?.day === forDay && src.last_ok_at && now() - Date.parse(src.last_ok_at) < SOURCE_TTL_MS;
    const rows = fresh ? (last.ids.length ? ctx.db.all(`SELECT * FROM documents WHERE id IN (${last.ids.map(() => '?').join(',')})`, ...last.ids) : []) : await refreshSource(ctx.db, ctx.sources, src, { day, events });
    if (!fresh && ctx.sources?.kind === 'live') ctx.db.update('sources', src.id, { last_docs_json: { day: forDay, ids: rows.map((r) => r.id) } });
    for (const d of rows) docs.push({ ...d, sourceName: src.name, sourceKey: src.key });
  }
  const since = new Date(now() - usedWithinDays * DAY).toISOString();
  const used = new Set(
    ctx.db
      // A post with a fixed subject (a fight week's main event) has only that subject's pages: its own stopped attempt
      // must not use them up, or the retry finds nothing ("no new document" twice for the same card).
      .all(`SELECT DISTINCT f.document_id FROM facts f JOIN posts p ON p.id = f.post_id WHERE p.account_id = ? AND p.created_at >= ?${keepBlocked ? " AND p.status != 'blocked'" : ''}`, pack.id, since)
      .map((r) => r.document_id)
  );
  const fresh = docs.filter((d) => !used.has(d.id));
  fresh.sort((a, b) => String(b.published_at || b.fetched_at).localeCompare(String(a.published_at || a.fetched_at)));
  return fresh;
}

/** The candidates a stored document key names, read from the database (a variation of a post whose feed moved on). */
export function storedCandidates(db, pack, key) {
  const rows = db.all(
    "SELECT d.*, s.name AS sourceName, s.key AS sourceKey FROM documents d JOIN sources s ON s.id = d.source_id WHERE s.account_id = ? AND s.status = 'approved' AND (d.group_key = ? OR d.key = ? OR CAST(d.id AS TEXT) = ?) AND (d.expires_at IS NULL OR d.expires_at > ?) ORDER BY d.fetched_at DESC",
    pack.id, key, key, key, nowIso()
  );
  // One snapshot of each document: the newest.
  const seen = new Set();
  return candidatesOf(rows.filter((d) => !seen.has(d.url) && seen.add(d.url)));
}

/**
 * Documents read together: those that share a group (two articles for a
 * head-to-head) are one candidate. Each candidate has the key its recorded
 * drafts are filed under.
 */
export function candidatesOf(docs) {
  const out = new Map();
  for (const d of docs) {
    const k = d.group_key ? `g:${d.group_key}` : `d:${d.id}`;
    if (!out.has(k)) out.set(k, { key: d.group_key || d.key || String(d.id), docs: [] });
    out.get(k).docs.push(d);
  }
  // The documents of a group always in the same order (D1, D2...), whatever order they were read in:
  // a fact names its document by that number.
  for (const c of out.values()) c.docs.sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')) || a.id - b.id);
  return [...out.values()];
}

/**
 * The candidates a format may be drafted from. A format that names its sources
 * (formats.json "sources": source ids) takes documents from those only, in the
 * order it names them: a match story drafted from a results table wasted six
 * outline calls before it found an article. An on-this-day post takes only the
 * documents that mention its day.
 */
export function poolFor(format, candidates, day, { maxAgeDays = null } = {}) {
  let pool = kindName(format) === 'on-this-day' ? candidates.filter((c) => c.docs.some((d) => mentionsDay(d.text, day))) : candidates;
  // A pack whose news ages fast (research.maxAgeDays) takes no topic whose dated documents are older: a 2023 launch
  // thread read as stale to every reader, however it was framed. An undated page (docs, a price list) stays.
  if (maxAgeDays && kindName(format) !== 'on-this-day') {
    const since = new Date(Date.parse(`${day}T00:00:00Z`) - maxAgeDays * DAY).toISOString();
    pool = pool.filter((c) => !c.docs.some((d) => d.published_at && String(d.published_at) < since));
  }
  // A topic from the bank was chosen for one kind of post, or for one format.
  pool = pool.filter((c) => !String(c.key).startsWith('bank:') || [kindName(format), format.id].includes(String(c.key).split(':')[1]));
  const want = format.sources || [];
  if (want.length) {
    const rank = (c) => Math.max(...c.docs.map((d) => want.indexOf(d.sourceKey)));
    // In the order the format names its sources, and within a source in the order it lists its pages.
    pool = pool.filter((c) => c.docs.every((d) => want.includes(d.sourceKey))).map((c) => ({ c, r: rank(c), id: Math.min(...c.docs.map((d) => d.id)) })).sort((a, b) => a.r - b.r || a.id - b.id).map((x) => x.c);
  }
  return pool;
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_HE = ['בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני', 'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר'];

/** Does a text mention this day of the year (any year)? For on-this-day posts. */
export function mentionsDay(text, day) {
  const [, , m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '') || [];
  if (!m) return false;
  const mm = Number(m);
  const dd = Number(d);
  const s = String(text || '');
  const res = [
    new RegExp(`\\b${MONTHS_EN[mm - 1]} ${dd}\\b(?!\\d)`),
    new RegExp(`(?<!\\d)${dd} ${MONTHS_EN[mm - 1]}\\b`),
    new RegExp(`(?<!\\d)${dd} ${MONTHS_HE[mm - 1]}`),
    new RegExp(`\\d{4}-${m}-${d}(?!\\d)`),
    // A dated list (RSSSF): "27/10/2001 Austria Home 1-1".
    new RegExp(`(?<!\\d)${d}/${m}/\\d{4}`),
  ];
  return res.some((re) => re.test(s));
}

/** Every text of a post, labelled, for the checks. */
export function textsOf({ hook, sub, slides, caption, captionShort }) {
  const out = [
    { where: 'cover', kind: 'cover', text: hook },
    { where: 'cover line 2', kind: 'sub', text: sub },
  ];
  slides.forEach((s, i) => {
    if (s.kind !== 'item') return;
    out.push({ where: `slide ${i} title`, kind: 'slideTitle', text: s.title, idx: i, field: 'title', role: s.role });
    out.push({ where: `slide ${i} text`, kind: s.role === 'ranks' || s.role === 'layer' ? 'slideLines' : 'slideBody', text: s.body, idx: i, field: 'body', role: s.role });
  });
  // A post with an Instagram caption has TikTok's long one too; a phase 1 post has the one caption.
  out.push({ where: 'caption', kind: captionShort ? 'captionLong' : 'caption', text: caption });
  out.push({ where: 'caption short', kind: 'captionShort', text: captionShort });
  return out.filter((t) => t.text || t.kind === 'cover');
}

/**
 * The Instagram caption: the cover line again, then the short caption and the
 * question. Instagram shows a caption's first line under the picture, and the
 * hook is the line that stops a scroll. Null for a post with no short caption.
 */
export function igCaption({ hook, captionShort, question }) {
  if (!String(captionShort || '').trim()) return null;
  // The cover line as one line: its breaks are the slide's, not the caption's.
  return [oneLine(hook), joinCaption(captionShort, question)].filter(Boolean).join('\n\n');
}

/** What the gate and the token hold beyond the slides, in one fixed order. */
const extraOf = (d) => ({ captionIg: d.captionIg || '', keywords: d.keywords || [], subject: d.subject || {}, cta: d.cta?.text || '', ...(d.coverVisual ? { coverVisual: d.coverVisual } : {}) });

/** The fact gate, with what this kind of post allows: its structure numbers, its fact-free roles. */
export function gateDraft(format, draft, facts, { allow = [] } = {}) {
  const content = draft.slides.filter((s) => s.kind === 'item');
  return gate({
    slides: draft.slides, facts, caption: draft.caption, hook: draft.hook, sub: draft.sub || '', extra: extraOf(draft),
    structure: new Set([...structureNumbers(format, content), ...allow]), factFree: (role) => factFree(format, role),
  });
}

const HEBREW = /[א-ת]/;
const LATIN = /[A-Za-z]/;

/** Voice, rules, the kind's shape and the fact gate over a whole post. Returns { problems, gate }. */
export function checkPost(ctx, pack, draft, facts, format = null) {
  const problems = [];
  const f = format || { kind: 'list' };
  for (const t of textsOf(draft)) for (const x of tellsIn(t.text, { kind: t.kind, extra: pack.rules.bannedPhrases || [], pack })) problems.push({ where: t.where, code: `voice:${x.code}`, msg: x.msg });
  for (const x of checkRules({ pack, others: ctx.packs || [], texts: textsOf(draft) })) problems.push(x);
  // The text over the picture: short lines broken by hand, a few a slide, reactions not labels (pack.json "overlay").
  for (const x of overlayProblems(draft, pack)) problems.push(x);
  // The account's slide style (src/render/styles): every text fits it at the style's smallest size, and every
  // highlight is a short phrase of its own headline.
  const style = draft.style || null;
  for (const x of style ? styleFitProblems(draft, { style, platforms: pack.meta.platforms, overlay: overlayOf(pack), places: slidePlaces(draft.slides), postKind: kindName(f) }) : highlightProblems(draft)) problems.push(x);
  // A phase 1 post's one caption is not a story, but its hashtags are still the engine's.
  if (kindName(f) === 'list') for (const x of hashtagProblems(draft)) problems.push(x);
  else {
    const content = draft.slides.filter((s) => s.kind === 'item');
    for (const msg of shapeProblems(f, content.map((s) => s.role))) problems.push({ where: 'shape', code: 'shape', msg });
    for (const msg of kindProblems(f, { ...draft, slides: content })) problems.push({ where: 'shape', code: 'shape', msg });
    // TikTok's search reads the slides and a long caption; Instagram shows the start of a short one.
    const cap = limitsFor('captionLong', pack);
    const capLen = String(draft.caption || '').length;
    if (capLen < cap.minChars) problems.push({ where: 'caption', code: 'caption', msg: `the TikTok caption is ${capLen} characters: it needs ${cap.minChars} or more` });
    if (capLen > cap.maxChars) problems.push({ where: 'caption', code: 'caption', msg: `the TikTok caption is over ${cap.maxChars} characters` });
    const capShort = limitsFor('captionShort', pack).maxChars;
    if (!String(draft.captionShort || '').trim()) problems.push({ where: 'caption short', code: 'caption', msg: 'the Instagram caption (captionShort) is missing' });
    else if (String(draft.captionShort).length > capShort) problems.push({ where: 'caption short', code: 'caption', msg: `the Instagram caption is over ${capShort} characters: it is the short one` });
    // TikTok's caption is a story in four lines (hook, problem, discovery, result), and no caption holds a hashtag.
    for (const x of captionProblems(draft, { limits: cap })) problems.push(x);
    const kw = draft.keywords || [];
    if (kw.length < 2 || !kw.some((k) => HEBREW.test(k)) || !kw.some((k) => LATIN.test(k))) problems.push({ where: 'keywords', code: 'keywords', msg: 'keywords need at least one in Hebrew and one in English letters' });
    for (const s of content) {
      if (String(s.title || '').length > 70) problems.push({ where: `slide ${draft.slides.indexOf(s)} title`, code: 'length', msg: 'the title is over 70 characters' });
      if (String(s.body || '').length > 260) problems.push({ where: `slide ${draft.slides.indexOf(s)} text`, code: 'length', msg: 'the text is over 260 characters' });
    }
    // Pictures as much as words: with the cover (which always has one), at least half the slides carry a visual.
    const allowed = visualsOf(pack);
    for (const s of content) for (const msg of visualProblems(s.visual, allowed, `slide ${draft.slides.indexOf(s)}`)) problems.push({ where: 'visual', code: 'shape', msg });
    for (const msg of visualProblems(draft.coverVisual, allowed, 'the cover')) problems.push({ where: 'visual', code: 'shape', msg });
    const have = content.filter(slideHasVisual).length;
    const need = visualsNeeded(content.length);
    if (have < need) problems.push({ where: 'visual', code: 'shape', msg: `only ${have} of the ${content.length} content slides carry a visual: at least ${need} need one (with the cover, half the post)` });
  }
  // A fixed subject's own numbers (the card's name and date, from the approved event calendar) may be on the cover.
  const g = gateDraft(f, draft, facts, { allow: ctx.subjectText ? numbersIn(ctx.subjectText) : [] });
  for (const msg of g.problems) problems.push({ where: 'facts', code: 'verify', msg });
  return { problems, gate: g };
}

const say = (p) => `${p.where}: ${p.msg}`;

/**
 * The check a problem failed, by a name that stays put across wordings, for the block rates on the Results page:
 * the fact gate, the format's shape and its parts (the graphics, the details), each caption and length limit, and
 * each voice tell, law, honesty and account rule by its own id.
 */
export function checkOf(p) {
  if (p.code === 'verify') return 'facts';
  if (p.code === 'shape') return p.where === 'visual' ? 'visuals' : p.where === 'details' ? 'details' : 'shape';
  return p.code || 'other';
}
const checksOf = (problems) => [...new Set(problems.map(checkOf))];

/**
 * The caption and its closing question, once, and never a generic one. A model
 * that already ended the caption with the question would otherwise ask it twice
 * ("ידעתם? ידעתם?"), and a generic engagement line ("ידעתם את זה?") is the most
 * bot-like line a post can have: the cost comparison caught both. Dropping it in
 * code costs nothing; a rewrite costs a call.
 */
export function joinCaption(caption, question) {
  const c = String(caption || '').trim();
  const q = isGenericQuestion(question) ? '' : String(question || '').trim();
  const flat = (s) => normHe(s).replace(/\s+/g, ' ');
  // A caption that already ends on a question takes no second one: two in a row read as a
  // bot (a blind review caught "the same question twice"), even when the words differ.
  if (!q || (c && flat(c).endsWith(flat(q))) || /\?\s*$/.test(c)) return c;
  // A short caption may end without a full stop; the question still starts a sentence of its own.
  return [c && !/[.!?:"')]$/.test(c) ? `${c}.` : c, q].filter(Boolean).join(' ');
}

/**
 * A slide that states a number one of the post's verified facts holds, without
 * citing that fact, cites it: when exactly one verified fact's quote holds the
 * number, the citation is bookkeeping, not a claim ("2022" on a slide, the year in
 * a fact the slide forgot to list, blocked a post after its redraft). A number two
 * facts hold, or none, is left for the gate. Returns what was added, per slide.
 */
export function citeNumbers(draft, facts) {
  const out = [];
  const good = facts.filter((f) => f.verified);
  const holds = good.map((f) => ({ key: f.key, nums: numbersIn(f.quote, { words: true, hebrew: true }) }));
  draft.slides.forEach((sl, i) => {
    if (sl.kind !== 'item') return;
    const cited = new Set(sl.factKeys || []);
    const have = new Set(holds.filter((h) => cited.has(h.key)).flatMap((h) => [...h.nums]));
    const text = `${sl.title} ${sl.body} ${sl.a || ''} ${sl.b || ''} ${visualText(sl.visual)}`;
    for (const x of numbersIn(text, { hebrew: true })) {
      if (have.has(x)) continue;
      const by = holds.filter((h) => h.nums.has(x));
      if (by.length !== 1) continue;
      sl.factKeys = [...(sl.factKeys || []), by[0].key];
      for (const n of by[0].nums) have.add(n);
      out.push(`slide ${i}: cites ${by[0].key} for ${x}`);
    }
  });
  return out;
}

/** Fix the mechanical tells in every text of a draft, in place. Returns what changed, per text. */
export function fixDraft(draft) {
  const out = [];
  const fix = (where, get, set, sep = '\n') => {
    // A body of short lines (a layer, places 10 to 6) is fixed line by line, so its lines stay lines.
    const parts = String(get() || '').split('\n').map(mechanicalFix);
    const fixed = [...new Set(parts.flatMap((r) => r.fixed))];
    if (fixed.length) {
      set(parts.map((r) => r.text).filter(Boolean).join(sep));
      out.push(`${where}: ${fixed.join(', ')}`);
    }
  };
  fix('cover', () => draft.hook, (v) => (draft.hook = v));
  fix('cover line 2', () => draft.sub, (v) => (draft.sub = v));
  // The story's beats keep the blank line between them.
  fix('caption', () => draft.caption, (v) => (draft.caption = v), /\n\s*\n/.test(draft.caption || '') ? '\n\n' : '\n');
  if (draft.captionShort) fix('caption short', () => draft.captionShort, (v) => (draft.captionShort = v));
  draft.slides.forEach((sl, i) => {
    if (sl.kind !== 'item') return;
    fix(`slide ${i} title`, () => sl.title, (v) => (sl.title = v));
    fix(`slide ${i} text`, () => sl.body, (v) => (sl.body = v));
  });
  if (draft.captionShort != null) draft.captionIg = igCaption(draft);
  return out;
}

/** Output room per call. The ceiling reserved for a call is priced on this, so it is no bigger than the answer needs. */
export const MAX_TOKENS = { outline: 10_000, slides: 8_000, rewrite: 6_000, repair: 4_000 };
export const EFFORT = { outline: 'medium', slides: 'medium', rewrite: 'medium', repair: 'medium' };

/**
 * The content items the outline planned, kept to those that still stand after
 * the facts were verified: an item with no verified fact goes, unless its role
 * carries none; a myth goes with its fact; a ranking cannot lose a place.
 */
export function keepItems(format, items, good) {
  const kind = kindName(format);
  const role = (it) => (kind === 'list' ? 'item' : String(it.role || ''));
  let kept = items.map((it) => ({ ...it, role: role(it), facts: (it.facts || []).filter((k) => good.has(k)) }));
  if (kind === 'myth-fact') {
    const pairs = [];
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].role === 'myth' && kept[i + 1]?.role === 'fact') {
        if (kept[i + 1].facts.length) pairs.push(kept[i], kept[i + 1]);
        i++;
      }
    }
    return pairs;
  }
  if (kind === 'ranking') return kept.some((it) => !it.facts.length) ? kept.filter((it) => it.facts.length) : kept;
  kept = kept.filter((it) => it.facts.length || factFree(format, it.role));
  if (kind === 'list') kept = kept.slice(0, contentRange(format)[1]);
  return kept;
}

/**
 * The slides call's answer as a draft, fixed in code and checked: what buildPost
 * does with each answer, and what the launch set's tools check an answer with.
 * Returns { draft, checked, fixes }.
 */
export function draftFromAnswer(ctx, pack, { format, answer: d, outline, items, facts, closer = null, hook = null, cta = null, attempt = 0, style = null }) {
  const legacy = kindName(format) === 'list';
  const draft = {
    // The slide style the post is drawn in, when it is not the account's own (a style test): its texts must fit it.
    ...(style ? { style } : {}),
    hook: String(d.hook || '').trim(),
    sub: String(d.sub || '').trim(),
    // The code chose the pattern, so the results are credited to it whatever the answer says.
    hookPattern: hook?.id || null,
    subject: { a: '', b: '', answer: '', date: '', ...(outline.subject || {}), ...Object.fromEntries(Object.entries(d.subject || {}).filter(([, v]) => String(v || '').trim())) },
    keywords: (d.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 6),
    question: String(d.question || '').trim(),
    // TikTok's caption comes as the story's four beats (src/rules/caption.js); an older answer as one text.
    caption: joinCaption(d.story ? storyCaption(d.story) : d.caption, d.question),
    captionShort: String(d.captionShort || '').trim(),
    cta,
    slides: [
      { kind: 'cover', role: 'cover', title: '', body: '', factKeys: [], highlight: String(d.hookHighlight || '').trim() },
      ...(d.slides || []).map((s, i) => ({
        kind: 'item', role: legacy ? 'item' : String(s.role || items[i]?.role || '').trim(),
        title: String(s.title || '').trim(), body: String(s.body || '').trim(), a: String(s.a || '').trim(), b: String(s.b || '').trim(), factKeys: (s.facts || []).map(String),
        highlight: String(s.highlight || '').trim(),
        ...(legacy ? {} : { visual: normVisual(s.visual), imageQuery: String(s.imageQuery || '').trim() }),
      })),
      ...(closer ? [{ kind: 'closer', role: 'closer', title: closer.title, body: closer.body || '', factKeys: [] }] : []),
    ],
  };
  if (!legacy) draft.coverVisual = normVisual(d.coverVisual);
  draft.captionIg = igCaption(draft);
  // What code can fix, code fixes: no model call for a stray exclamation mark.
  const fixes = [...fixDraft(draft), ...lineDraft(draft, pack), ...citeNumbers(draft, facts)];
  const checked = checkDraft(ctx, pack, { draft, format, facts, items, attempt });
  return { draft, checked, fixes };
}

/**
 * Every check on a written draft: checkPost, and what the slides owe the plan (its details, its roles in order).
 * Returns { problems, gate }.
 */
export function checkDraft(ctx, pack, { draft, format, facts, items, attempt = 0 }) {
  const checked = checkPost(ctx, pack, draft, facts, format);
  // The details the research found are what makes a post worth finishing: at least three of them on the slides.
  const details = facts.filter((f) => f.verified && f.detail).map((f) => f.key);
  if (details.length) {
    const cited = new Set(draft.slides.flatMap((s) => s.factKeys || []));
    const used = details.filter((k) => cited.has(k)).length;
    // A first draft is asked for three; a redraft that kept two still tells the post's moments, and passes.
    const need = Math.min(attempt > 0 ? 2 : 3, details.length);
    if (used < need) checked.problems.push({ where: 'details', code: 'shape', msg: `the slides use ${used} of the details (${details.join(', ')}): at least ${need} of them belong on the slides, each cited by its id` });
  }
  // The slides follow the outline's plan: the same roles, in order.
  const roles = draft.slides.filter((s) => s.kind === 'item').map((s) => s.role).join(',');
  if (kindName(format) !== 'list' && roles !== items.map((it) => it.role).join(',')) checked.problems.unshift({ where: 'shape', code: 'shape', msg: `the slides must follow the outline's roles in order (${items.map((it) => it.role).join(', ')})` });
  return checked;
}

// Which limits a repaired text is told, by target.
const TARGET_KIND = { cover: 'cover', 'cover line 2': 'sub', caption: 'captionLong', 'caption short': 'captionShort' };

/** One target as the repair call is shown it: its text now, its role, its limits and the checks it failed. */
function repairTarget(draft, pack, target, problems) {
  const s = /^slide \d+$/.test(target) ? draft.slides[Number(target.slice(6))] : null;
  const text = target === 'keywords' ? (draft.keywords || []).join(', ') : { cover: draft.hook, 'cover line 2': draft.sub, caption: draft.caption, 'caption short': draft.captionShort }[target];
  return {
    target, role: s?.role, problems: problems.map((p) => p.msg),
    limits: TARGET_KIND[target] ? limitsFor(TARGET_KIND[target], pack) : s ? limitsFor('slideBody', pack) : null,
    now: s ? { title: s.title, body: s.body, a: s.a || '', b: s.b || '', facts: s.factKeys || [] } : { text: text || '' },
  };
}

/**
 * The refused texts of a draft, mended in at most REPAIR_ATTEMPTS small calls (src/pipeline/repair.js). A repair
 * is kept only when it clears at least one check and adds none. Returns { draft, checked, rounds }: the draft as
 * far as it was mended, its checks, and what each round did. A draft with a problem no repair can reach is
 * returned as it is, without a call.
 */
export async function repairDraft(ctx, pack, { draft, checked, format, facts, items, outline, attempt = 0, ttl = '5m', meta = {} }) {
  const rounds = [];
  const verified = facts.filter((f) => f.verified);
  const sp = repairPrompt(pack, { ttl });
  const lastTry = new Map();
  for (let round = 1; round <= REPAIR_ATTEMPTS && checked.problems.length; round++) {
    const plan = repairPlan(draft, checked.problems);
    if (!plan.targets.size || plan.stuck.length) break;
    const targets = [...plan.targets].map(([t, ps]) => ({ ...repairTarget(draft, pack, t, ps), ...(lastTry.get(t) || {}) }));
    let res;
    try {
      res = await askJson(ctx, {
        task: 'repair', role: 'rewrite', system: sp.system, user: repairUser({ format, topic: outline.topic, facts: verified, targets, pack, style: draft.style }), schema: sp.schema,
        effort: EFFORT.repair, maxTokens: MAX_TOKENS.repair, meta: { ...meta, attempt: attempt + round + 1 },
      });
    } catch (e) {
      if (e instanceof NoRecording) break;
      throw e;
    }
    const kept = [];
    const refused = [];
    lastTry.clear();
    for (const r of res.data.repairs || []) {
      const ps = plan.targets.get(r.target);
      if (!ps || kept.some((k) => k.target === r.target)) continue;
      const answer = /^slide /.test(r.target) ? { title: r.title, body: r.body, a: r.a, b: r.b, facts: r.facts } : r.text;
      const refuse = (why) => {
        refused.push({ target: r.target, why });
        lastTry.set(r.target, { last: answer, refused: why });
      };
      // A number the gate refused is removed or cited, never another number: the code holds the repair to it.
      const made = applyRepair(draft, r.target, r, { facts, factLock: ps.some((p) => p.code === 'verify') });
      if (made.refused) {
        refuse([made.refused]);
        continue;
      }
      lineDraft(made.draft, pack);
      citeNumbers(made.draft, facts);
      made.draft.captionIg = igCaption(made.draft);
      const next = checkDraft(ctx, pack, { draft: made.draft, format, facts, items, attempt });
      const before = new Set(checked.problems.map(say));
      const after = new Set(next.problems.map(say));
      const added = [...after].filter((p) => !before.has(p));
      const cleared = [...before].filter((p) => !after.has(p));
      if (added.length || !cleared.length) {
        refuse(added.length ? added : ['it cleared none of the checks']);
        continue;
      }
      draft = made.draft;
      checked = next;
      kept.push({ target: r.target, cleared });
    }
    // The writer is not given a slide's graphic. One that still draws a number no quote its slide cites holds is
    // dropped, as a malformed one is, when the post keeps enough graphics without it.
    const unheld = new Set(checked.problems.map((p) => /^slide (\d+): the visual's number /.exec(p.msg)?.[1]).filter(Boolean));
    let dropped;
    if (unheld.size) {
      const next = structuredClone(draft);
      for (const i of unheld) next.slides[Number(i)].visual = null;
      const after = checkDraft(ctx, pack, { draft: next, format, facts, items, attempt });
      const before = new Set(checked.problems.map(say));
      if (after.problems.every((p) => before.has(say(p)))) {
        draft = next;
        checked = after;
        dropped = [...unheld].map((i) => `slide ${i}`);
      }
    }
    rounds.push({ round, targets: targets.map((t) => t.target), kept, refused, ...(dropped ? { dropped } : {}), left: checked.problems.map(say), usd: res.usd });
  }
  return { draft, checked, rounds };
}

/**
 * What a slide's source line says for one fact: the source's name, and for an
 * encyclopedia the article itself ("ויקיפדיה: Ocimum basilicum"), since "English Wikipedia:
 * Lamiaceae" tells a reader nothing about where to look.
 */
export function sourceLabel(db, fact, { article = true } = {}) {
  const row = db.get('SELECT s.name, s.config_json, d.title, d.url FROM sources s LEFT JOIN documents d ON d.id = ? WHERE s.id = ?', fact.document_id, fact.source_id);
  if (!row) return null;
  const kind = j(row.config_json, {})?.api?.kind;
  const wiki = () => (article && row.title ? `ויקיפדיה: ${String(row.title).replace(/\s*\(Wikipedia[^)]*\)\s*$/, '')}` : 'ויקיפדיה');
  if (kind === 'wikipedia') return wiki();
  // A topic bank's page is named by where it is from, never by the bank: "מקור: מאגר הנושאים" told a reader nothing.
  if (kind === 'bank') return bankLabel(row.url, row.title, wiki);
  return row.name;
}

const HOSTS = {
  'news.ycombinator.com': 'Hacker News', 'platform.claude.com': 'Anthropic', 'code.claude.com': 'Anthropic', 'docs.anthropic.com': 'Anthropic', 'developers.openai.com': 'OpenAI', 'openai.com': 'OpenAI',
  'ai.google.dev': 'Google', 'vercel.com': 'Vercel', 'www.netlify.com': 'Netlify', 'supabase.com': 'Supabase', 'stripe.com': 'Stripe', 'docs.github.com': 'GitHub', 'github.blog': 'GitHub', 'cursor.com': 'Cursor', 'www.wix.com': 'Wix', 'trustmrr.com': 'TrustMRR',
  'design-system.service.gov.uk': 'GOV.UK Design System', 'www.gov.uk': 'GOV.UK', 'guidance.publishing.service.gov.uk': 'GOV.UK', 'designsystem.digital.gov': 'U.S. Web Design System', 'developer.mozilla.org': 'MDN',
  'docs.cloud.google.com': 'Google Cloud', 'firebase.google.com': 'Firebase', 'cheatsheetseries.owasp.org': 'OWASP', 'www.postgresql.org': 'PostgreSQL',
};

/** The label of a page from a topic bank: its site's own name (a Wikipedia article as any other). */
export function bankLabel(url, title, wiki = () => 'ויקיפדיה') {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return title || null;
  }
  if (/(^|\.)wikipedia\.org$/.test(host)) return wiki();
  return HOSTS[host] || host.replace(/^www\./, '');
}

/**
 * A kind's runs kept to their size: a plan with three "turn" slides where the kind
 * takes two keeps the two with the most facts (in their order). Only runs that are
 * too long are touched; a missing segment is the shape check's to report.
 */
export function fitShape(format, items) {
  const k = kindOf(format);
  if (kindName(format) === 'list' || k.repeat) return { items, trimmed: [] };
  const out = [];
  const trimmed = [];
  let i = 0;
  for (const [role, , max] of k.segments) {
    const run = [];
    while (i < items.length && items[i].role === role) run.push(items[i++]);
    const keep = new Set([...run].sort((a, b) => (b.facts || []).length - (a.facts || []).length).slice(0, max));
    for (const it of run) (keep.has(it) ? out : trimmed).push(it);
  }
  return { items: [...out, ...items.slice(i)], trimmed: trimmed.map((it) => `${it.role}: ${it.point}`) };
}

/**
 * One topic's plan: its facts verified against their stored documents, the
 * details research found put on the slides they belong to (a slide left without a
 * fact takes a spare one), the items kept to the kind's shape. Returns { facts,
 * good, items, trimmed } or, when the plan cannot carry the post, { why }: the
 * topic is then left for the next, not the post blocked.
 */
export function planFrom(ctx, { pack, format, outline, cand, details = [] }) {
  const docOf = new Map(cand.refs.map((d) => [d.ref, d]));
  const facts = [];
  for (const f of outline.facts || []) {
    const d = docOf.get(String(f.doc || '').trim()) || (cand.refs.length === 1 ? cand.refs[0] : null);
    const row = { key: f.id, claim: f.claim, quote: f.quote, document_id: d?.id ?? null, source_id: d?.source_id ?? null, ...whoOf(f) };
    const v = verifyFact(ctx.db, row, { accountId: pack.id, maxQuoteWords: pack.rules.maxQuoteWords || 40 });
    facts.push({ ...row, verified: v.ok, error: v.error });
  }
  facts.push(...details);
  // Two voices at most: a third attributed fact is not one the post may stand on.
  facts.filter((f) => f.verified && f.who).slice(ATTRIBUTED_MAX).forEach((f) => Object.assign(f, { verified: false, error: `a post carries ${ATTRIBUTED_MAX} attributed facts at most` }));
  const good = new Set(facts.filter((f) => f.verified).map((f) => f.key));
  const planned = (outline.items || []).map((it) => ({ ...it, facts: [...(it.facts || [])] }));
  for (const d of details) if (d.verified && d.item > 0 && planned[d.item - 1]) planned[d.item - 1].facts.push(d.key);
  // A slide of the plan research left without a fact takes the next detail no slide claimed, in the order found:
  // the slides call writes it around that detail, where dropping it broke the post's shape.
  const spare = details.filter((d) => d.verified && !planned.some((it) => it.facts.includes(d.key)));
  for (const it of planned) if (!it.facts.some((k) => good.has(k)) && !factFree(format, it.role) && spare.length) it.facts.push(spare.shift().key);
  // A head-to-head stat is two values, one a side, from the quotes: the Oliveira against Khabib post was planned on
  // documents that held Oliveira's numbers alone, and every draft of it was refused. A stat whose quotes hold one
  // side (bothSides) is no stat, and a matchup left with fewer than the kind's stats is not this format's post.
  const oneSided = kindName(format) === 'head-to-head' ? planned.filter((it) => it.role === 'stat' && !bothSides(it, facts, outline)) : [];
  const fitted = fitShape(format, keepItems(format, planned.filter((it) => !oneSided.includes(it)), good));
  const items = fitted.items;
  outline.items = planned;
  const shape = kindName(format) === 'list' ? (items.length < format.items[0] ? [`only ${items.length}`] : []) : shapeProblems(format, items.map((it) => it.role));
  if (shape.length || !good.size) {
    const why =
      kindName(format) === 'list'
        ? `רק ${items.length} פריטים עם עובדה מאומתת, הפורמט צריך ${format.items[0]}`
        : `אחרי בדיקת העובדות הפוסט לא שומר על הצורה של ${kindOf(format).name}: ${shape.join('; ') || 'אין עובדות מאומתות'}${oneSided.length ? ` (${oneSided.length === 1 ? 'השוואה אחת' : `${oneSided.length} השוואות`} בלי ערך לשני הצדדים במסמכים)` : ''}`;
    return { why, facts };
  }
  return { facts, good, items, trimmed: [...oneSided.map((it) => `${it.role}: ${it.point} (one side only)`), ...fitted.trimmed] };
}

/**
 * Whether a head-to-head stat's quotes give it a value for each side. A side is known by its names (subject.a and
 * imageQuery, subject.b and imageQueryB). When the post's verified quotes name one side and never the other, the
 * documents hold one side only and no stat stands; when they name both, each stat's own quotes name both. When
 * they name neither (Hebrew names over English quotes), the names cannot tell, and the stat stands.
 */
export function bothSides(item, facts, outline = {}) {
  const namesOf = (...xs) => [...new Set(xs.join(' ').toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length >= 3))];
  const a = namesOf(outline.subject?.a || '', outline.imageQuery || '');
  const b = namesOf(outline.subject?.b || '', outline.imageQueryB || '');
  const verified = facts.filter((f) => f.verified);
  const names = (side, quotes) => side.some((w) => quotes.some((q) => q.includes(w)));
  const all = verified.map((f) => String(f.quote || '').toLowerCase());
  const seenA = names(a, all);
  const seenB = names(b, all);
  if (!seenA && !seenB) return true;
  if (!seenA || !seenB) return false;
  const own = verified.filter((f) => (item.facts || []).includes(f.key)).map((f) => String(f.quote || '').toLowerCase());
  return names(a, own) && names(b, own);
}

/** Who said or reported a fact, when it is attributed: { who, whoHe }, or nothing for a plain fact. */
const whoOf = (f) => (String(f.who || '').trim() ? { who: String(f.who).trim(), whoHe: String(f.whoHe || '').trim() || String(f.who).trim() } : {});

/** The words research looks for in a long article: the subject's names and the topic's own words. */
export function subjectNames(outline) {
  const s = outline.subject || {};
  const text = [s.a, s.b, s.answer, outline.topic, outline.imageQuery, ...(outline.research || [])].filter(Boolean).join(' ');
  return [...new Set(text.split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length >= 3 && !/^(the|and|של|את|עם|על|מול|final|season|cup)$/i.test(w)))];
}

/**
 * Research, then the details: the documents the outline named are read and
 * stored (sources/research.js), and one call pulls out of them, and out of the
 * post's own documents, the specific details a fan would want: what someone said,
 * the minute, the moment, the backstory, what came after, a telling number. Each
 * is verified against its stored document like any fact. A topic with fewer than
 * the pack's minimum (3 by default) verified details is not drafted: `short`
 * says so, and the post moves on to the next topic. Offline, with no recorded
 * answer, the step does not run.
 */
export async function gatherDetails(ctx, { pack, format, outline, cand, ttl = '5m' }) {
  const need = pack.meta.research?.minDetails ?? 3;
  const names = subjectNames(outline);
  const found = await research(ctx, { pack, terms: outline.research || [], names, have: cand.docs.map((d) => d.url), docKey: cand.key });
  const docs = [
    ...cand.refs.map((d) => ({ ...d, text: aboutSubject(d.text, names, 3500) })),
    ...found.map((d, i) => ({ ...d, ref: `R${i + 1}`, sourceName: ctx.db.get('SELECT name FROM sources WHERE id = ?', d.source_id)?.name || '' })),
  ];
  const p = detailsPrompt(pack, { ttl });
  let res;
  try {
    res = await askJson(ctx, {
      task: 'details', role: 'draft', system: p.system, user: detailsUser({ format, outline, facts: outline.facts || [], docs }), schema: p.schema, effort: 'low', maxTokens: 6000,
      meta: { recordingsDir: pack.recordingsDir, docKey: cand.key, format: format.base || format.id, attempt: 0 },
    });
  } catch (e) {
    if (e instanceof NoRecording && ctx.mode === 'recorded') return { ran: false, facts: [], docs: found, need, short: false, usd: 0 };
    throw e;
  }
  const byRef = new Map(docs.map((d) => [d.ref, d]));
  const taken = new Set((outline.facts || []).map((f) => String(f.id)));
  const facts = [];
  for (const x of res.data.details || []) {
    let key = String(x.id || '').trim() || `X${facts.length + 1}`;
    while (taken.has(key)) key = `X${key}`;
    taken.add(key);
    const d = byRef.get(String(x.doc || '').trim());
    const row = { key, claim: String(x.claim || ''), quote: String(x.quote || ''), document_id: d?.id ?? null, source_id: d?.source_id ?? null, detail: String(x.kind || 'detail').trim() || 'detail', item: Number.isInteger(x.item) ? x.item : 0, ...whoOf(x) };
    const v = verifyFact(ctx.db, row, { accountId: pack.id, maxQuoteWords: pack.rules.maxQuoteWords || 40 });
    facts.push({ ...row, verified: v.ok, error: v.error });
  }
  const verified = facts.filter((f) => f.verified).length;
  return { ran: true, facts, docs: found, need, found: facts.length, verified, short: verified < need, usd: res.usd };
}

/** The post as a draft again, from what the database holds: for an edit, and for the gate before publishing. */
export function postDraft(post) {
  const data = post.data || {};
  const d = {
    hook: post.hook || '', sub: post.sub || '', caption: post.caption || '', captionShort: data.captionShort || '', question: data.question || '',
    subject: data.subject || {}, keywords: data.keywords || [], cta: data.cta || null, hookPattern: post.hook_pattern || '',
    slides: post.slides.map((s) => ({
      kind: s.kind, role: s.role || (s.kind === 'item' ? 'item' : s.kind), title: s.title || '', body: s.body || '', a: s.data?.a || '', b: s.data?.b || '', factKeys: s.factKeys,
      ...(s.data?.visual !== undefined || s.data?.imageQuery !== undefined ? { visual: s.data?.visual || null, imageQuery: s.data?.imageQuery || '' } : {}),
      ...(s.data?.highlight ? { highlight: s.data.highlight } : {}),
    })),
    ...(post.checks?.styleName ? { style: post.checks.styleName } : {}),
  };
  if (data.coverVisual !== undefined) d.coverVisual = data.coverVisual || null;
  d.captionIg = post.caption_ig || null;
  return d;
}

/** The format a stored post was made in, or the phase 1 list. */
export const formatOfPost = (db, pack, post) => resolveFormat(db, pack, post.format_id) || { id: post.format_id, kind: post.kind || 'list' };

export async function buildPost(ctx, { pack, formatKey = null, sample = false, slotAt = null, maxDocs = 6, subject = null, day = null, hookId = null, ctaText = null, docKey = null, directive = null, redoOf = null }) {
  const { db } = ctx;
  // The morning's feedback may have planned this post (src/metrics/feedback.js): a format, a cover pattern, a call to
  // action, the document of a post that worked, and why. What the caller fixed itself wins.
  const dv = directive || {};
  // The rivals the owner typed in: what the niche already does, said to the outline and the slides.
  const rivals = rivalsOf(db, pack.id);
  formatKey ||= dv.formatKey || null;
  hookId ||= dv.hookId || null;
  ctaText ||= dv.ctaText || null;
  docKey ||= dv.docKey || null;
  const account = db.get('SELECT * FROM accounts WHERE id = ?', pack.id);
  if (!account) throw new Error(`no account row for ${pack.id}: sync the packs first`);
  if (!sample) {
    if (settings(db).globalKill) throw new PausedError('the global kill switch is on');
    if (account.status === 'paused') throw new PausedError(`${pack.id} is paused (${account.paused_reason})`);
  }

  ensureFormats(db, pack);
  const fkey = formatKey || pickFormat(db, pack.id, { groups: groupsOf(pack), mix: mixOf(db, pack), exclude: dv.avoidFormats || [] }) || pickFormat(db, pack.id, { groups: groupsOf(pack), mix: mixOf(db, pack) }) || pack.formats.formats[0].id;
  const resolve = (k) => resolveFormat(db, pack, k);
  let format = resolve(fkey) || pack.formats.formats[0];
  // When no fresh document fits the format the rotation picked, the others in the
  // same group are tried in turn rather than skipping the slot (then the rest);
  // a format asked for by name is not.
  const active = db.all("SELECT format_key FROM formats WHERE account_id = ? AND status = 'active'", pack.id).map((r) => r.format_key);
  const others = active.filter((k) => k !== format.id).map(resolve).filter(Boolean);
  const formatsToTry = formatKey ? [format] : [format, ...others.filter((f) => groupOf(f) === groupOf(format)), ...others.filter((f) => groupOf(f) !== groupOf(format))];
  // The day the post goes out: what an on-this-day post is about.
  const postDay = day || (slotAt ? israelDate(Date.parse(slotAt)) : israelDate(now()));
  // The quota, weighed and held in one step: no await comes between the count and the drafting row that holds the
  // place, so posts started together (a batch) each see the ones before them.
  if (!sample) {
    const q = room(db, pack.id, { redo: Boolean(redoOf) });
    if (!q.ok) throw new QuotaError(q.why);
  }
  const postId = newId('p');
  const at = nowIso();
  db.insert('posts', { id: postId, account_id: pack.id, format_id: format.id, kind: kindName(format), grp: groupOf(format), status: 'drafting', sample: sample ? 1 : 0, slot_at: slotAt, directive_id: dv.id || null, redo_of: redoOf, created_at: at, updated_at: at });
  // A redo for the photographs: the ones the customer turned down are not chosen again (findImage skips them).
  const pctx = { ...ctx, pack, postId, sources: ctx.sourcesFor ? ctx.sourcesFor(pack) : ctx.sources, subjectText: subject?.text || null, ...(dv.avoidImages?.length ? { avoidImages: new Set(dv.avoidImages) } : {}) };
  // The slide style this post is drawn in (src/render/styles): the account's locked one, or in a style test the two
  // it is trying, in turn. null for an account still on the older templates. Its texts are written and checked for it.
  const postStyle = styleForPost(db, pack, ctx.packs || []);
  const finish = (status, patch = {}) => {
    const spend = postSpend(db, postId);
    // What the post was to the customer: one that reached them counts against their month, a blocked one is ours.
    const quota = sample ? {} : { quota_kind: status === 'queued' ? (redoOf ? 'redo' : 'suggestion') : 'retry', quota_month: quotaMonth() };
    db.update('posts', postId, { status, updated_at: nowIso(), cost_usd: spend.usd, cost_estimated: spend.estimated ? 1 : 0, ...quota, ...patch });
    return { postId, status, reason: patch.reason || null, kind: patch.kind || null, cost: spend.usd };
  };
  const block = (kind, reason, detail = null) => {
    step(db, postId, 'blocked', 'failed', { kind, reason, ...(detail || {}) });
    return { ...finish('blocked', { reason }), kind };
  };

  try {
    // The pack's prefix is cached for an hour in a batch, whose rounds can be more than five minutes apart.
    const ttl = ctx.llm.batch ? '1h' : '5m';
    step(db, postId, 'format', 'info', { format: format.id, name: format.name, kind: kindName(format), group: groupOf(format) });
    if (directive) step(db, postId, 'feedback', 'info', { directive: dv.id || null, box: dv.box || null, steer: dv.steer || null });

    const topicNotes = new Map();
    const noteTopic = (c, why) => c.topicId && topicNotes.set(c.topicId, String(why || '').slice(0, 300));

    // ---- topic: documents from approved sources
    // A variation of a post that worked is drafted from that post's own document again.
    const docs = await candidateDocs(pctx, pack, { day: postDay, keepBlocked: Boolean(subject?.terms?.length), ...(dv.reuseDocs ? { usedWithinDays: 0 } : {}) });
    // ---- topic first (src/topics): the bank's, then what people are looking at, scored before this post; then the
    // approved sources searched for what holds it up, after the day's read so that what it stored is searched too.
    // A post with its subject or its document fixed keeps them.
    let viral = null;
    if (!subject && !docKey && !dv.docKey) {
      for (const t of readyTopics(db, pack.id, { limit: 2 })) {
        const found = await topicDocs(pctx, pack, t);
        if (!found.length) {
          markTopic(db, t.id, 'unsupported', { note: 'אף מקור מאושר לא אומר עליו דבר' });
          step(db, postId, 'viral', 'skipped', { topic: t.id, origin: t.origin, title: t.title, score: t.score, why: 'unsupported by the approved sources' });
          continue;
        }
        viral = { topic: t, cand: { key: `topic:${t.id}`, docs: found, subject: t.angle || t.title, why: t.why, topicId: t.id } };
        step(db, postId, 'viral', 'info', { topic: t.id, origin: t.origin, title: t.title, angle: t.angle, score: t.score, parts: t.parts, url: t.url, documents: found.map((d) => d.url) });
        break;
      }
    }
    step(db, postId, 'topic', docs.length || viral ? 'ok' : 'failed', { candidates: docs.length, mode: pctx.sources.kind, viral: viral?.topic.id || null });
    if (!docs.length && !viral) return block('no_source', 'אין מסמכים חדשים מהמקורות המאושרים');
    // The chosen topic is tried first, in every format; the day's documents stay behind it, for a topic no format takes.
    let candidates = [...(viral ? [viral.cand] : []), ...candidatesOf(docs)];
    // One named document (or group): the launch set, and a test, ask for a post from exactly that.
    if (docKey) candidates = candidates.filter((c) => c.key === docKey);
    // A feed moves on: the document a winning post came from is read from the database when today's read no longer has it,
    // and when it is gone (expired, its source removed) the variation is drafted from what there is.
    if (dv.docKey && dv.docKey === docKey && !candidates.length) {
      candidates = storedCandidates(db, pack, docKey);
      if (!candidates.length) candidates = candidatesOf(docs);
    }
    // A fight week's post is about its event; anything else about something else waits.
    if (subject?.terms?.length) {
      const about = (c) => c.docs.some((d) => subject.terms.every((t) => String(d.text).toLowerCase().includes(String(t).toLowerCase())));
      candidates = candidates.filter(about);
      step(db, postId, 'subject', candidates.length ? 'ok' : 'failed', { subject: subject.text, candidates: candidates.length });
      if (!candidates.length) return block('no_source', `אין מסמך על ${subject.text}`);
    }

    let outline = null;
    let cand = null;
    let details = [];
    let plan = null;
    let lastWhy = '';
    let lastKind = 'no_source';
    // A post with a fixed subject (a fight week's card) is about it by design, preview, pick and recap alike: the
    // "posted recently" list is for choosing a topic, and naming its own card there made the outline refuse it.
    const recent = db
      .all("SELECT topic FROM posts WHERE account_id = ? AND topic IS NOT NULL AND status NOT IN ('blocked') ORDER BY created_at DESC LIMIT 12", pack.id)
      .map((r) => r.topic);
    // A head-to-head refused for a missing face, this week or a moment ago, is not offered again: a card's main event
    // with one unphotographed fighter took all three attempts of a launch post, while the card's other fights had both.
    const faceless = db
      .all("SELECT s.detail_json FROM steps s JOIN posts p ON p.id = s.post_id WHERE p.account_id = ? AND s.step = 'outline' AND s.status = 'skipped' AND s.detail_json LIKE '%no licensed photograph of both sides%' AND s.at > ?", pack.id, new Date(now() - 7 * DAY).toISOString())
      .map((r) => j(r.detail_json, {}))
      .map((d) => d.who || (/(([^)]+))$/.exec(d.why || '') || [])[1])
      .filter(Boolean);
    tries: for (const f of formatsToTry) {
      // On this day: only documents that mention this day of the year.
      const pool = poolFor(f, candidates, postDay, { maxAgeDays: pack.meta.research?.maxAgeDays || null });
      // At most maxDocs documents per format reach the model. A document with no
      // recording for this format (offline) never did, so it does not use up a turn.
      let tried = 0;
      for (const c of pool) {
        if (tried >= maxDocs) break;
        const refs = c.docs.map((d, i) => ({ ...d, ref: `D${i + 1}` }));
        const p = outlinePrompt(pack, { ttl });
        try {
          const res = await askJson(pctx, {
            // A variation, and a redo of the same topic, are about the post they come from: its topic is not "recent".
            task: 'outline', role: 'draft', system: p.system, user: outlineUser(f, refs, { avoid: subject || dv.steer?.kind === 'variation' || (dv.steer?.kind === 'redo' && dv.docKey) ? [] : recent, faceless: [...new Set(faceless)], day: postDay, subject: c.subject || subject?.text, why: c.why || null, maxAgeDays: String(c.key).startsWith('bank:') ? null : pack.meta.research?.maxAgeDays || null, niche: nicheForOutline(rivals) }), schema: p.schema, effort: EFFORT.outline, maxTokens: MAX_TOKENS.outline,
            meta: { recordingsDir: pack.recordingsDir, docKey: c.key, format: f.base || f.id, attempt: 0 },
          });
          tried++;
          if (!res.data.usable) {
            step(db, postId, 'outline', 'skipped', { format: f.id, documents: c.docs.map((d) => d.id), url: c.docs[0].url, why: res.data.why }, res.usd);
            noteTopic(c, res.data.why);
            continue;
          }
          step(db, postId, 'outline', 'ok', { format: f.id, documents: c.docs.map((d) => d.id), url: c.docs[0].url, topic: res.data.topic, items: res.data.items.length, facts: res.data.facts.length, research: res.data.research || [] }, res.usd);
          // A head-to-head of two people is two faces side by side, or it is another matchup: a cover of drawn boxes, or
          // of one fighter alone, was passed over by every reader, and the owner asked for person against person on
          // every account. Checked here, before a word of the post is written.
          if (needsSides(pack, f, res.data) && !(pctx.mode === 'recorded' && !pctx.imagesLive)) {
            const sides = await sidePhotos(pctx, { pack, outline: res.data, postId });
            if (!sides) {
              const who = [res.data.subject?.a || res.data.imageQuery, res.data.subject?.b || res.data.imageQueryB].join(' / ');
              step(db, postId, 'outline', 'skipped', { format: f.id, topic: res.data.topic, who, why: `no licensed photograph of both sides (${who})` });
              faceless.push(who);
              noteTopic(c, `no licensed photograph of both sides (${who})`);
              lastWhy = `אין תמונה מורשית של שני הצדדים (${who})`;
              lastKind = 'no_photo';
              continue;
            }
            res.data.sides = sides;
          }
          // ---- research: more about this topic, and the details a fan would want, before any slide
          const det = await gatherDetails(pctx, { pack, format: f, outline: res.data, cand: { ...c, refs }, ttl });
          if (det.ran) step(db, postId, 'details', det.short ? 'failed' : 'ok', { topic: res.data.topic, documents: det.docs.map((d) => d.url), found: det.found, verified: det.verified, need: det.need, refused: det.facts.filter((x) => !x.verified).map((x) => ({ key: x.key, error: x.error })) }, det.usd);
          // Fewer details than the minimum: not this topic. General wording never fills the gap.
          if (det.short) {
            noteTopic(c, `the sources hold ${det.found} of the ${det.need} details a post needs`);
            continue;
          }
          // The facts verified and the plan kept to the kind's shape; a plan that cannot keep it leaves the topic for the next.
          const made = planFrom(pctx, { pack, format: f, outline: res.data, cand: { ...c, refs }, details: det.facts });
          if (made.why) {
            step(db, postId, 'plan', 'failed', { topic: res.data.topic, why: made.why, refused: made.facts.filter((x) => !x.verified).map((x) => ({ key: x.key, error: x.error })) });
            noteTopic(c, made.why);
            lastWhy = made.why;
            // A plan lost to facts its quotes do not hold is a fact-check failure (the rails pause an account on those), not a missing source.
            if (made.facts.some((x) => !x.verified)) lastKind = 'fact_check';
            continue;
          }
          outline = res.data;
          cand = { ...c, refs };
          format = f;
          details = det.facts;
          plan = made;
          break tries;
        } catch (e) {
          if (e instanceof NoRecording) continue;
          throw e;
        }
      }
    }
    // The topic tried: used by this post, or left with the reason no format could hold it.
    if (viral) {
      if (cand?.topicId === viral.topic.id) markTopic(db, viral.topic.id, 'used', { postId });
      else markTopic(db, viral.topic.id, 'skipped', { note: topicNotes.get(viral.topic.id) || 'no format could hold it' });
    }
    if (!outline) return block(lastWhy ? lastKind : 'no_source', lastWhy ? `אף נושא לא החזיק פוסט שלם: ${lastWhy}` : 'אף מסמך חדש לא הספיק לפוסט באחד הפורמטים');
    db.update('posts', postId, { topic: outline.topic, format_id: format.id, kind: kindName(format), grp: groupOf(format), topic_id: cand?.topicId || null });

    // ---- facts: verified against their stored documents before any slide is written (planFrom), stored here
    const { facts, good, items } = plan;
    for (const f of facts) db.insert('facts', { post_id: postId, key: f.key, claim: f.claim, quote: f.quote, document_id: f.document_id, source_id: f.source_id, verified: f.verified ? 1 : 0, error: f.error, detail: f.detail || null, who: f.who || null, who_he: f.whoHe || null });
    step(db, postId, 'facts', 'ok', { verified: good.size, refused: facts.filter((f) => !f.verified).map((f) => ({ key: f.key, error: f.error })), trimmed: plan.trimmed });
    const verifiedFacts = facts.filter((f) => f.verified);

    // ---- slides, then every check; one redraft with the reasons
    const sp = slidesPrompt(pack, { ttl });
    // The owner's own rewrites teach the voice; the three latest short ones are enough.
    const edits = db.all('SELECT before, after FROM edits WHERE account_id = ? AND length(after) <= 240 ORDER BY id DESC LIMIT 3', pack.id);
    const legacy = kindName(format) === 'list';
    const closer = legacy ? pickBy(format.closers, postId) : null;
    // A pattern and a call to action can be fixed in advance (the launch set does, so the text drafted for them and the post agree).
    const fixedHook = hookId ? hookPatterns(format).find((h) => h.id === hookId) : null;
    // Feedback that says the cover did not pull asks for another pattern than that post's.
    const otherHooks = dv.avoidHook ? hookPatterns(format).filter((h) => h.id !== dv.avoidHook) : [];
    const hook = legacy ? null : fixedHook || (otherHooks.length ? pickBy(otherHooks, postId) : null) || pickHook(db, pack.id, format);
    const ctas = ctasOf(pack, format);
    const lastCta = db.get("SELECT json_extract(data_json, '$.cta.text') AS t FROM posts WHERE account_id = ? AND data_json IS NOT NULL AND status NOT IN ('blocked') ORDER BY created_at DESC LIMIT 1", pack.id)?.t;
    const fixedCta = ctaText ? ctas.find((c) => c.text === ctaText) : null;
    // A call to action the feedback found did not convert is not used again on this post.
    const fresh = ctas.filter((c) => c.text !== lastCta && c.text !== dv.avoidCta);
    const cta = legacy || !ctas.length ? null : fixedCta || pickBy(fresh.length ? fresh : ctas.length > 1 ? ctas.filter((c) => c.text !== lastCta) : ctas, postId);
    let draft = null;
    let checked = null;
    let lastProblems = [];
    let lastAnswer = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await askJson(pctx, {
          task: 'slides', role: 'draft', system: sp.system, user: slidesUser({ format, n: items.length, outline: { ...outline, items }, facts: verifiedFacts, edits, problems: lastProblems.map(say), lastDraft: lastAnswer, hook, cta, day: postDay, pack, steer: dv.steer || null, niche: nicheForSlides(rivals), style: postStyle }), schema: sp.schema,
          effort: EFFORT.slides, maxTokens: MAX_TOKENS.slides, meta: { recordingsDir: pack.recordingsDir, docKey: cand.key, format: format.base || format.id, attempt },
        });
      } catch (e) {
        if (e instanceof NoRecording && attempt > 0) break;
        throw e;
      }
      const made = draftFromAnswer(pctx, pack, { format, answer: res.data, outline, items, facts, closer, hook, cta, attempt, style: postStyle });
      draft = made.draft;
      checked = made.checked;
      step(db, postId, attempt ? 'redraft' : 'slides', checked.problems.length ? 'failed' : 'ok', { problems: checked.problems.map(say), checks: checksOf(checked.problems), fixed: made.fixes }, res.usd);
      if (!checked.problems.length) break;
      // Problems that each belong to one text are mended there (the repair, below), not by drafting the post again.
      const rp = repairPlan(draft, checked.problems);
      if (rp.targets.size && !rp.stuck.length) break;
      lastProblems = checked.problems;
      lastAnswer = res.data;
    }
    if (!draft) return block('voice', 'הטיוטה לא נכתבה');
    // A graphic is decoration: one the redraft left malformed (a compare of one item) is dropped and the post checked
    // again without it, not lost with every fact in it verified. The count of slides with a visual is still checked.
    if (checked.problems.length && checked.problems.every((p) => p.where === 'visual' && /^(slide \d+|the cover): /.test(p.msg))) {
      const bad = new Set(checked.problems.map((p) => p.msg.split(':')[0]));
      draft.slides.forEach((s, i) => bad.has(`slide ${i}`) && (s.visual = null));
      if (bad.has('the cover')) draft.coverVisual = null;
      checked = checkPost(pctx, pack, draft, facts, format);
      step(db, postId, 'visual', checked.problems.length ? 'failed' : 'ok', { dropped: [...bad], problems: checked.problems.map(say) });
    }
    // ---- the repair: each refused text mended where it failed, with the checks' own words, before the post is blocked
    let repairs = 0;
    if (checked.problems.length) {
      const fixed = await repairDraft(pctx, pack, { draft, checked, format, facts, items, outline, attempt: 1, ttl, meta: { recordingsDir: pack.recordingsDir, docKey: cand.key, format: format.base || format.id } });
      for (const r of fixed.rounds) step(db, postId, 'repair', r.left.length ? 'failed' : 'ok', { round: r.round, targets: r.targets, kept: r.kept, refused: r.refused, ...(r.dropped ? { visualsDropped: r.dropped } : {}), problems: r.left }, r.usd);
      repairs = fixed.rounds.length;
      draft = fixed.draft;
      checked = fixed.checked;
    }
    if (checked.problems.length) {
      // The law and honesty come first in the reason, then the facts, then the shape, then the voice.
      const rank = (p) => (/^(compliance|honesty|brand|rule)/.test(p.code) ? 0 : p.code === 'verify' ? 1 : /^(shape|caption|keywords|length|overlay|fit)$/.test(p.code) ? 2 : 3);
      const sorted = checked.problems.slice().sort((a, b) => rank(a) - rank(b));
      const kind = rank(sorted[0]) === 0 ? 'rules' : rank(sorted[0]) === 1 ? 'fact_check' : rank(sorted[0]) === 2 ? 'shape' : 'voice';
      return block(kind, `${sorted.slice(0, 3).map(say).join(' · ')}${repairs ? ` (${repairs === 1 ? 'אחרי תיקון אחד' : `אחרי ${repairs} תיקונים`})` : ''}`, { problems: sorted.map(say), checks: checksOf(sorted), repairs });
    }

    // ---- the second look: does it sound like a bot, and does any text say more
    // than its facts? The reviewer only scores. A text at 4+, or with a fact
    // problem, is rewritten by the drafting model in one call, and kept only if
    // it passes every check. A fact problem that is not fixed blocks the post:
    // the code gate proves every number is quoted, not that the sentence around
    // it is true to the quote.
    const texts = textsOf(draft);
    // A slide's graphic is read too: its names and numbers must be in the facts. A graphic
    // the reviewer doubts is dropped, not rewritten: it is data, not a sentence.
    const shown = draft.slides.map((s, i) => (s.visual ? { where: `slide ${i} visual`, kind: 'visual', role: 'visual', text: visualText(s.visual), idx: i } : null)).filter(Boolean);
    const review = await reviewTexts(pctx, { pack, texts: [...texts, ...shown], facts: verifiedFacts });
    // A graphic the reviewer doubts goes to the rewrite like a sentence, as its data: corrected, or dropped when it
    // cannot be. Dropping it outright left posts short of their visuals, and the final gate refused them.
    const visReviews = review.reviews.slice(texts.length).map((r, k) => ({ ...r, ...shown[k], index: texts.length + k, kind: 'visual' }));
    const dropped = [];
    review.reviews = review.reviews.slice(0, texts.length);
    const applied = [];
    // The rewrite is one bounded call on the flagged lines only, never a second
    // redraft of the post: it runs once even after the slides used their redraft
    // (measured: without it, half the posts a strong reviewer flagged were lost),
    // and whatever it does not fix drops the post.
    // Each flagged text goes with what it must keep: its limits, and for a slide the facts it cites.
    const factsFor = (t) => (t.idx != null ? verifiedFacts.filter((f) => (draft.slides[t.idx]?.factKeys || []).includes(f.key)) : verifiedFacts);
    const flagged = [
      ...review.reviews
        .map((r, i) => ({ ...r, index: i, where: texts[i].where, text: texts[i].text, limits: limitsFor(texts[i].kind, pack), uses: factsFor(texts[i]).map((f) => f.key) }))
        .filter((r) => r.botScore >= REWRITE_AT || r.factProblem),
      ...visReviews.filter((v) => v.factProblem).map((v) => ({ ...v, botScore: 1, text: JSON.stringify(draft.slides[v.idx].visual), uses: factsFor(v).map((f) => f.key) })),
    ];
    const rejected = [];
    // A rewrite is kept when it adds no problem the post did not already have: a check it fails is its own,
    // a check the post already failed (a graphic the review dropped) is the final gate's to report.
    const applyRewrites = (rewrites, round) => {
      const out = [];
      for (const rw of rewrites || []) {
        const vis = visReviews.find((v) => v.index === rw.index);
        const t = vis || texts[rw.index];
        const r = vis || review.reviews[rw.index];
        if (!t || !r || r.rewritten || (r.botScore < REWRITE_AT && !r.factProblem)) continue;
        const text = vis ? String(rw.text || '').trim() : mechanicalFix(String(rw.text || '').trim()).text;
        if (!text) continue;
        const next = structuredClone(draft);
        if (vis) {
          let v = null;
          try {
            v = normVisual(JSON.parse(text));
          } catch {
            out.push({ index: rw.index, text, problems: ['the corrected graphic is not JSON'] });
            continue;
          }
          if (!v) continue;
          next.slides[t.idx].visual = v;
        } else if (t.where === 'cover') next.hook = text;
        else if (t.where === 'cover line 2') next.sub = text;
        else if (t.where === 'caption') next.caption = text;
        else if (t.where === 'caption short') next.captionShort = text;
        else next.slides[t.idx][t.field] = text;
        lineDraft(next, pack);
        next.captionIg = igCaption(next);
        const before = new Set(checkPost(pctx, pack, draft, facts, format).problems.map(say));
        const added = checkPost(pctx, pack, next, facts, format).problems.map(say).filter((p) => !before.has(p));
        if (!added.length) {
          draft = next;
          applied.push({ where: t.where, from: t.text, to: text, score: r.botScore, round });
          r.rewritten = true;
        } else out.push({ index: rw.index, text, problems: added });
      }
      return out;
    };
    if (flagged.length && pctx.llm.kind === 'claude') {
      const rp = rewritePrompt(pack, { ttl });
      try {
        const res = await askJson(pctx, {
          task: 'rewrite', role: 'rewrite', system: rp.system, user: rewriteUser({ flagged, facts: verifiedFacts }), schema: rp.schema, effort: EFFORT.rewrite, maxTokens: MAX_TOKENS.rewrite,
          meta: { recordingsDir: pack.recordingsDir, docKey: cand.key, format: format.base || format.id, attempt: 1 },
        });
        rejected.push(...applyRewrites(res.data.rewrites, 1));
        // A rewrite the checks refused gets one more bounded call, told why, on those texts only: one in three
        // was refused (a limit, a number its slide does not cite), and each one left drops the whole post.
        let usd = res.usd;
        if (rejected.length) {
          const again = rejected.map((x) => ({ ...flagged.find((f) => f.index === x.index), last: x.text, refused: x.problems }));
          const res2 = await askJson(pctx, {
            task: 'rewrite', role: 'rewrite', system: rp.system, user: rewriteUser({ flagged: again, facts: verifiedFacts }), schema: rp.schema, effort: EFFORT.rewrite, maxTokens: MAX_TOKENS.rewrite,
            meta: { recordingsDir: pack.recordingsDir, docKey: cand.key, format: format.base || format.id, attempt: 2 },
          });
          usd += res2.usd;
          const still = applyRewrites(res2.data.rewrites, 2);
          rejected.length = 0;
          rejected.push(...still);
        }
        step(db, postId, 'rewrite', 'ok', { flagged: flagged.length, kept: applied.length, refused: rejected.map((x) => ({ where: (texts[x.index] || visReviews.find((v) => v.index === x.index))?.where, text: x.text, problems: x.problems })) }, usd);
      } catch (e) {
        step(db, postId, 'rewrite', 'failed', { error: String(e.message).slice(0, 200), kept: applied.length });
      }
    }
    // A doubted graphic the rewrite did not fix is dropped: a wrong number drawn is worse than none.
    for (const v of visReviews) {
      if (!v.factProblem || v.rewritten) continue;
      draft.slides[v.idx].visual = null;
      dropped.push({ where: v.where, why: v.factProblem });
    }
    // A rewritten text is scored again, as it now reads. It used to be put down as REWRITE_AT - 1 unread, so every
    // approved post with one rewrite showed 3/10: a number nobody measured. A rescore that fails keeps that floor,
    // and the step says so.
    const redone = review.reviews.map((r, i) => (r.rewritten ? i : -1)).filter((i) => i >= 0);
    let rescored = null;
    if (redone.length) {
      const now = textsOf(draft);
      try {
        const again = await reviewTexts(pctx, { pack, texts: redone.map((i) => now[i]), facts: verifiedFacts });
        redone.forEach((i, k) => (review.reviews[i].after = again.reviews[k]));
        rescored = redone.map((i) => ({ where: now[i].where, before: review.reviews[i].botScore, after: review.reviews[i].after.botScore, tells: review.reviews[i].after.tells }));
      } catch (e) {
        rescored = { error: String(e.message).slice(0, 200) };
      }
    }
    const scores = review.reviews.map((r) => (r.after ? r.after.botScore : r.rewritten ? Math.min(r.botScore, REWRITE_AT - 1) : r.botScore));
    const worst = Math.max(0, ...scores);
    const unfixed = review.reviews.map((r, i) => ({ ...r, where: texts[i].where })).filter((r) => r.factProblem && !r.rewritten);
    step(db, postId, 'review', worst >= BLOCK_AT || unfixed.length ? 'failed' : 'ok', { reviewer: review.reviewer, worst, scores: texts.map((t, i) => ({ where: t.where, score: review.reviews[i].botScore, tells: review.reviews[i].tells, factProblem: review.reviews[i].factProblem || undefined })), rewrites: applied, ...(rescored ? { rescored } : {}), visualsDropped: dropped });
    if (unfixed.length) return block('review', `הבודק מצא משפט שאומר יותר מהעובדות: ${unfixed.slice(0, 2).map((r) => `${r.where}: ${r.factProblem}`).join(' · ')}`);
    if (worst >= BLOCK_AT) return block('voice', `נשמע כמו בוט (${worst}/10)${applied.length ? ' גם אחרי שכתוב' : ''}`);

    // ---- the gate, final: this exact text, these facts
    const final = checkPost(pctx, pack, draft, facts, format);
    if (final.problems.length) return block('fact_check', final.problems.slice(0, 3).map(say).join(' · '));
    step(db, postId, 'verify', 'ok', { token: final.gate.token, facts: verifiedFacts.length, slides: draft.slides.length });

    // ---- photographs: licensed, recorded, screened, and checked against what each slide says
    const photoOn = kindOf(format).photo;
    const photos = await findPhotos({ ...pctx, mode: ctx.mode }, { pack, format, draft, outline, postId });
    const image = photos.get(0) || photos.get(draft.slides.length - 1) || null;
    // A guess-who whose answer has no licensed photograph shows a bare question mark for a cover, and an answer no
    // photograph shows is one most of the audience does not know either: every reader failed both. Another topic.
    if (kindName(format) === 'guess-who' && pack.theme.options?.coverPhoto && !photos.get(draft.slides.length - 1)) {
      return block('no_photo', `אין תמונה מורשית של ${draft.subject?.answer || 'התשובה'}: נחשו-מי צריך פנים לטשטש על השער`);
    }

    // ---- render
    const factSource = new Map(facts.map((f) => [f.key, sourceLabel(db, f)]));
    // A guess-who's clue is sourced like any slide, but the article it came from is
    // usually the answer ("ויקיפדיה: Yossi Benayoun", which a review caught on every
    // clue): before the reveal, a slide names the source alone.
    const plainSource = new Map(facts.map((f) => [f.key, sourceLabel(db, f, { article: false })]));
    const slides = draft.slides.map((s) => ({ ...s, sources: s.factKeys.map((k) => (s.role === 'clue' ? plainSource : factSource).get(k)) }));
    const outDir = path.join(ctx.mediaDir || mediaDir(), 'posts', postId);
    // Drawn in the account's saved look (src/render/style.js), whose hash the post keeps for drawing it again.
    const look = postStyle ? lookFor(db, pack, postStyle, ctx.packs || []) : lockedStyle(db, pack, ctx.packs || []);
    const files = await renderPost({ pack: { ...pack, theme: look.theme }, format, post: { id: postId, hook: draft.hook, sub: draft.sub, caption: draft.caption, token: final.gate.token, extra: extraOf(draft), ctaKind: draft.cta?.kind }, slides, photos, outDir });
    step(db, postId, 'render', 'ok', { platforms: Object.keys(files), slides: slides.length });

    // ---- store and queue
    const tags = hashtagsFor(pack, format, postId, [draft.hook, draft.sub, draft.caption, ...(draft.keywords || []), ...draft.slides.map((s) => `${s.title} ${s.body}`)].join(' '));
    db.tx(() => {
      slides.forEach((s, i) =>
        db.insert('slides', {
          post_id: postId, idx: i, kind: s.kind, role: s.role || null, title: s.title, body: s.body, fact_ids_json: s.factKeys,
          data_json: s.a || s.b || s.visual || s.imageQuery || s.highlight ? { a: s.a, b: s.b, ...(s.visual !== undefined ? { visual: s.visual, imageQuery: s.imageQuery || '' } : {}), ...(s.highlight ? { highlight: s.highlight } : {}) } : null,
          // A photograph the renderer had to leave off on every platform is not this post's: not shown, not credited.
          image_id: Object.keys(files).every((size) => files.dropped?.[size]?.has(i)) ? null : photos.get(i)?.id ?? null,
          files_json: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v[i]])),
        })
      );
    });
    const status = sample ? 'sample' : 'queued';
    step(db, postId, 'queue', 'ok', { status, slot: slotAt });
    return finish(status, {
      hook: draft.hook, sub: draft.sub, caption: draft.caption, caption_ig: draft.captionIg, hashtags_json: tags, review_score: worst, hook_pattern: draft.hookPattern,
      data_json: { subject: draft.subject, keywords: draft.keywords, cta: draft.cta, captionShort: draft.captionShort, question: draft.question, day: kindName(format) === 'on-this-day' ? postDay : undefined, coverVisual: draft.coverVisual },
      checks_json: { token: final.gate.token, reviewer: review.reviewer, scores, rewrites: applied, image: image ? image.id : null, bgImage: photos.get('bg')?.id ?? null, coverImages: ['ca', 'cb'].map((k) => photos.get(k)?.id).filter(Boolean), imageSafety: image?.safety || null, images: [...photos.values()].map((p) => p.id), photoOn, style: look.hash, ...(postStyle ? { styleName: postStyle } : {}) },
      media_json: files, ai_label: [...photos.values()].some((p) => p.ai_generated && p.realistic) ? 1 : 0,
    });
  } catch (e) {
    step(db, postId, 'error', 'failed', { error: String(e.message).slice(0, 500) });
    return { ...finish('blocked', { reason: String(e.message).slice(0, 300) }), kind: e.code === 'overflow' || e.code === 'fonts' ? 'render' : 'error' };
  }
}

/**
 * A head-to-head on an account whose covers carry photographs: its two sides are two faces, both found, or it is
 * another matchup. An outline that left one side's photograph unnamed once slipped past the check and went out with
 * the drawn cover the owner had ruled out.
 */
export function needsSides(pack, format, outline) {
  return Boolean(outline && pack.theme.options?.coverPhoto && (pack.meta.imagery?.providers || []).length && kindName(format) === 'head-to-head');
}

/**
 * A head-to-head's two faces, each searched and checked as its own side: { ca, cb }, or null when either has no
 * licensed photograph that passes. A photograph of a third player once went out labelled as one of the two.
 */
export async function sidePhotos(ctx, { pack, outline, postId }) {
  const about = outline.topic ? ` (the post is about: ${outline.topic})` : '';
  const out = {};
  for (const [key, query, side] of [['ca', outline.imageQuery, outline.subject?.a], ['cb', outline.imageQueryB, outline.subject?.b]]) {
    const why = {};
    const img = await findImage(ctx, { pack, query, postId, claim: `a portrait of ${side || query} for one half of the cover of a head-to-head${about}`, why, minSide: MIN_SIDE.half }).catch((e) => (ctx.log?.(`image: ${e.message}`), null));
    step(ctx.db, postId, 'image', img ? 'ok' : 'skipped', img ? { slide: key, query, provider: img.provider, license: img.license, author: img.author, source: img.source_url, safety: img.safety } : { slide: key, query, why });
    if (!img) return null;
    out[key] = img;
  }
  return out;
}

/**
 * The photographs of one post: the cover's (or a guess-who's reveal) from the
 * outline's query where the kind and the theme put one, and a content slide's
 * from its own imageQuery. Each must name its subject in its own title,
 * description or categories, pass the image screen, and show what its slide says
 * to the model's eye (images/index.js). A slide whose photograph does not pass
 * keeps its graphic: a wrong picture is worse than none. At most four searches a
 * post; the same query twice is searched once. Returns Map(slide index -> image row).
 */
export async function findPhotos(ctx, { pack, format, draft, outline, postId }) {
  const out = new Map();
  const providers = pack.meta.imagery?.providers || [];
  if (!providers.length) return out;
  const kind = kindName(format);
  const photoOn = kindOf(format).photo;
  const last = draft.slides.length - 1;
  const wants = [];
  // The post's topic goes with every photograph's check: the cover line alone did not tell the check that a post about
  // Manchester City's 2017-18 season should not show Guardiola in a Bayern Munich tracksuit.
  const about = outline.topic ? ` (the post is about: ${outline.topic})` : '';
  // A head-to-head's cover never shows a face it has not checked as one of the two sides: a photograph of a third
  // player went out labelled as one of them. Each half is searched and checked as its own side.
  if (needsSides(pack, format, outline)) {
    // The two sides' photographs, each on its own half of the cover under its name: both or neither.
    const sides = outline.sides || (await sidePhotos(ctx, { pack, outline, postId }));
    if (sides) {
      out.set('ca', sides.ca);
      out.set('cb', sides.cb);
    }
  }
  if (pack.theme.options?.coverPhoto && photoOn && outline.imageQuery && kind !== 'head-to-head') {
    const idx = photoOn === 'last' ? last : 0;
    const s = draft.slides[idx];
    // A guess-who's answer is a face, blurred on the cover and shown at the reveal: checked against the reveal's fight,
    // every free portrait of McGregor (a press conference, a suit) was refused and the post had no cover.
    const claim = kind === 'guess-who' && draft.subject?.answer
      ? `a portrait of ${draft.subject.answer}, the answer of a guess-who: the reveal shows their face${about}`
      : idx === 0 ? `${draft.hook} ${draft.sub || ''}${about}` : `${s.title} ${s.body}${about}`;
    wants.push({ idx, query: outline.imageQuery, claim });
  }
  // A clue's photograph would give the answer away; a meme is the account's own design.
  if (photoOn && kind !== 'meme') {
    draft.slides.forEach((s, i) => {
      if (s.kind !== 'item' || !s.imageQuery || s.role === 'clue' || (photoOn === 'last' && i === last && wants.length)) return;
      wants.push({ idx: i, query: s.imageQuery, claim: `${s.title} ${s.body}` });
    });
  }
  const seen = new Set();
  for (const w of wants) {
    const key = w.query.toLowerCase().trim();
    if (seen.has(key) || seen.size >= 4) continue;
    seen.add(key);
    const why = {};
    // A cover fills the frame; a content slide's photograph sits in one (the last slide of a guess-who fills it too).
    const minSide = w.idx === 0 || (photoOn === 'last' && w.idx === last) ? MIN_SIDE.cover : MIN_SIDE.framed;
    let img = await findImage(ctx, { pack, query: w.query, postId, claim: w.claim, why, minSide }).catch((e) => (ctx.log?.(`image: ${e.message}`), null));
    // A cover whose query found nothing tries the post's own subject by name ("Haim Revivo" rather than "Revivo goal Spain 1998").
    const who = String(draft.subject?.answer || draft.subject?.a || '').trim();
    if (!img && w.idx === 0 && /[A-Za-z]/.test(who) && who.toLowerCase() !== key && !seen.has(who.toLowerCase())) {
      seen.add(who.toLowerCase());
      img = await findImage(ctx, { pack, query: who, postId, claim: w.claim, why, minSide }).catch(() => null);
    }
    step(ctx.db, postId, 'image', img ? (img.safety === 'review' ? 'info' : 'ok') : 'skipped', img ? { slide: w.idx, query: w.query, provider: img.provider, license: img.license, author: img.author, source: img.source_url, safety: img.safety, match: j(img.match_json, null) } : { slide: w.idx, query: w.query, mode: ctx.mode, why });
    if (img) out.set(w.idx, img);
  }
  // A cover still without its own photograph takes a portrait one of its slides found (the post's person, checked
  // against that slide): every reader asked for a face on the cover over the kind's drawn art.
  // Only a portrait of the post's own subject moves (a cover about Natan Levy once took a slide's photograph of Dana
  // White), and never in a ranking (it would show number one) or a guess-who (the answer).
  const subjectWords = String(`${draft.subject?.a || ''} ${draft.subject?.answer || ''} ${outline.imageQuery || ''}`).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!out.has(0) && wants.some((w) => w.idx === 0) && photoOn === 'cover' && !['ranking', 'guess-who'].includes(kind)) {
    const portrait = [...out.entries()].find(([i, img]) => i > 0 && String(img.query).toLowerCase().split(/\s+/).some((w) => subjectWords.includes(w)));
    if (portrait) {
      out.set(0, portrait[1]);
      out.delete(portrait[0]);
      step(ctx.db, postId, 'image', 'ok', { slide: 0, moved: portrait[0], query: portrait[1].query });
    }
  }
  // One photograph is shown once: the cover's picture of Torres came back for slide 1's query and every reader saw the
  // same shot twice in a row, the second time small.
  const shown = new Set();
  for (const [i, img] of [...out.entries()].sort(([a], [b]) => (typeof a === 'number' ? a : -1) - (typeof b === 'number' ? b : -1))) {
    if (shown.has(img.id) && typeof i === 'number' && i > 0) out.delete(i);
    else shown.add(img.id);
  }
  // An account that puts every slide on a photograph (theme.options.backgroundPhoto) and found none it can blur
  // behind the text (a guess-who's answer never can) takes one of its scene's (theme.backgroundQueries), the post's
  // own subject first: a stable pick per post, so two posts in a row rarely share one.
  // Behind the slides: the post's own subject (its cover photograph) and its scene, in turn. Every account that asks
  // for backgrounds gets a scene, so a post never repeats one face on every slide or shows a slide's other person (Messi
  // behind a post about Ronaldinho).
  if (pack.theme.options?.backgroundPhoto) {
    const scenes = pack.theme.backgroundQueries || [];
    const start = [...String(postId)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % Math.max(1, scenes.length);
    // The subject first only when no cover shows it already (and never a guess-who's answer or one of a head-to-head's two).
    const subjectFirst = !out.has(0) && !['guess-who', 'head-to-head'].includes(kind) ? [outline.imageQuery] : [];
    const queries = [...subjectFirst, ...scenes.slice(start), ...scenes.slice(0, start)].filter(Boolean);
    for (const query of [...new Set(queries)].slice(0, 4)) {
      // Checked like a slide's photograph, against the scene it stands for: a basketball arena came back for "football
      // stadium night" and sat behind a football post.
      // A person in it reads as a stranger behind someone else's story: the scene is a place or a thing.
      const claim = `the blurred background of a post about ${outline.topic || pack.meta.displayName}: it must show ${query}, the sport or the setting of the post, never another sport, with no person as the main subject or standing out (an empty arena, a pitch, a cage, gloves, a desk)`;
      const img = await findImage(ctx, { pack, query, postId, claim, minSide: MIN_SIDE.ground }).catch((e) => (ctx.log?.(`background: ${e.message}`), null));
      if (img) {
        out.set('bg', img);
        step(ctx.db, postId, 'image', 'ok', { slide: 'background', query });
        break;
      }
    }
  }
  return out;
}

/** A stored post with its slides and facts, as the website and the publisher see it. */
export function loadPost(db, postId) {
  const post = db.get('SELECT * FROM posts WHERE id = ?', postId);
  if (!post) return null;
  const slides = db.all('SELECT * FROM slides WHERE post_id = ? ORDER BY idx', postId).map((s) => ({ ...s, factKeys: j(s.fact_ids_json, []), files: j(s.files_json, {}), data: j(s.data_json, null) }));
  const facts = db
    .all('SELECT f.*, d.url AS doc_url, d.title AS doc_title, d.fetched_at AS doc_fetched_at, s.name AS source_name, s.url AS source_url, s.status AS source_status FROM facts f LEFT JOIN documents d ON d.id = f.document_id LEFT JOIN sources s ON s.id = f.source_id WHERE f.post_id = ? ORDER BY f.id', postId)
    .map((f) => ({ ...f, verified: Boolean(f.verified), whoHe: f.who_he || null }));
  return { ...post, hashtags: j(post.hashtags_json, []), checks: j(post.checks_json, {}), media: j(post.media_json, {}), publish: j(post.publish_json, {}), data: j(post.data_json, {}), reject: j(post.reject_json, null), slides, facts };
}

export { linesOfBody, ranksOf };
