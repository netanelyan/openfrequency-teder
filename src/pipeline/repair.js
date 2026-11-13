import { mechanicalFix } from '../voice/tells.js';
import { numbersIn } from '../verify/claims.js';
import { oneLineOf } from './closing.js';

// The repair: a draft the code checks refused, mended where it failed and nowhere else.
//
// A first draft that fails a check on one slide used to cost a redraft of the whole post, and a redraft that
// fixed that slide broke another one about as often: most blocked posts died one line short. Here each refused
// check is traced to the text it is about (the cover, the line under it, the TikTok caption, the Instagram
// caption, the keywords, one slide), and the writer is sent only those texts, with the checks' exact messages,
// in a small call on the account's cached prefix. At most REPAIR_ATTEMPTS calls, each priced and reserved
// against the caps like any other.
//
// What is never repaired: the law, honesty and the account's own rules (a post that broke them is blocked as
// it is), and a problem no single text owns (the slides out of order, too few details): those keep the redraft.
//
// THE CLOSING SLIDE (src/pipeline/closing.js closingProblems) is a text of its own, the target "closing": every problem
// of it, whatever rule its line broke, is its line's to mend, since the line is the writer's only text there (its
// action is the code's). What the repair cannot mend in REPAIR_ATTEMPTS is the promo's own words' to stand in for
// (build.js), or the post is blocked.
//
// FACTS. A number the gate could not find in a cited quote is repaired in two ways only: the number goes, or
// the slide cites one of the post's own verified facts whose quote holds it. The code holds the writer to it:
// a repaired text may state no new number that a quote it cites does not hold, and a slide may cite only the
// post's verified facts. A source is never added here: facts come from the outline and the research, checked against
// their stored documents, and nowhere else.

export const REPAIR_ATTEMPTS = 2;

const TEXTS = ['cover', 'cover tiktok', 'cover line 2', 'caption', 'caption short', 'keywords'];
const NEVER = /^(compliance|honesty|brand|rule)/;

/** The text of one repair target in a draft, as the writer is shown it. */
export function targetText(draft, target) {
  if (target === 'cover') return draft.hook || '';
  if (target === 'cover tiktok') return draft.hookTiktok || '';
  if (target === 'cover line 2') return draft.sub || '';
  if (target === 'caption') return draft.caption || '';
  if (target === 'caption short') return draft.captionShort || '';
  if (target === 'keywords') return (draft.keywords || []).join(', ');
  if (target === 'closing') return draft.closing?.line || '';
  const s = draft.slides[slideIndex(target)];
  return s ? `${s.title} ${s.body} ${s.a || ''} ${s.b || ''}` : '';
}

const slideIndex = (target) => Number(/^slide (\d+)$/.exec(target)?.[1] ?? -1);

/**
 * The targets one refused check is about, or null when no single text owns it (or it is never repaired).
 * A number the gate found on the cover or in the captions belongs to whichever of their texts states it.
 */
export function targetsOf(draft, p) {
  if (p.where === 'closing') return ['closing'];
  if (NEVER.test(p.code || '')) return null;
  // The cover's lines are counted with the line under it, and either can carry the line it is short of.
  if (p.where === 'cover' && / lines? of text: /.test(p.msg)) return ['cover', 'cover line 2'];
  if (TEXTS.includes(p.where)) return [p.where];
  const own = /^slide (\d+)(?: (?:title|text))?$/.exec(p.where);
  if (own) return isItem(draft, own[1]) ? [`slide ${own[1]}`] : null;
  if (p.code === 'verify' || (p.code === 'shape' && p.where === 'shape')) {
    const sl = /^slide (\d+): /.exec(p.msg);
    if (sl) return isItem(draft, sl[1]) ? [`slide ${sl[1]}`] : null;
    const at = p.code === 'verify' && /^the (cover|caption): the number (\S+) /.exec(p.msg);
    if (at) {
      const pool = at[1] === 'cover' ? ['cover', 'cover line 2', 'keywords'] : ['caption', 'caption short'];
      const has = pool.filter((t) => numbersIn(targetText(draft, t), { hebrew: true }).has(at[2]));
      return has.length ? has : null;
    }
  }
  return null;
}

const isItem = (draft, i) => draft.slides[Number(i)]?.kind === 'item';

/**
 * The refused checks, grouped by the text each is about: { targets: Map(target -> [problem]), stuck: [problem] }.
 * A post with anything stuck is not repaired: whatever the repair mends, it is still refused.
 */
export function repairPlan(draft, problems) {
  const targets = new Map();
  const stuck = [];
  for (const p of problems) {
    const ts = targetsOf(draft, p);
    if (!ts) {
      stuck.push(p);
      continue;
    }
    for (const t of ts) targets.set(t, [...(targets.get(t) || []), p]);
  }
  return { targets, stuck };
}

/**
 * One target's repair applied to a copy of the draft. Returns { draft } or { refused: why }.
 * `facts`: the post's facts; a slide may cite only the verified ones. `factLock`: the target failed the fact
 * gate, so its repair may not state a number its text did not already state.
 */
export function applyRepair(draft, target, r, { facts, factLock = false }) {
  const next = structuredClone(draft);
  const good = new Set(facts.filter((f) => f.verified).map((f) => f.key));
  const fix = (s) => mechanicalFix(String(s || '').trim()).text;
  if (target === 'cover') next.hook = fix(r.text);
  else if (target === 'cover tiktok') next.hookTiktok = fix(r.text);
  else if (target === 'cover line 2') next.sub = fix(r.text);
  else if (target === 'caption') next.caption = String(r.text || '').split('\n').map(fix).filter(Boolean).join('\n\n');
  else if (target === 'caption short') next.captionShort = fix(r.text);
  else if (target === 'keywords') next.keywords = String(r.text || '').split(/[,،\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 6);
  else if (target === 'closing') {
    // The line alone: what the slide sends people to, and the action, stay the code's.
    if (!next.closing) return { refused: 'the post has no closing slide to repair' };
    next.closing = { ...next.closing, line: oneLineOf(r.text), by: 'repair' };
  } else {
    const s = next.slides[slideIndex(target)];
    if (!s) return { refused: `${target} is not a slide of this post` };
    const cites = (r.facts || []).map(String);
    const unknown = cites.filter((k) => !good.has(k));
    if (unknown.length) return { refused: `cites ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not one of this post's verified facts: cite only the listed facts` };
    s.title = fix(r.title);
    s.body = String(r.body || '').split('\n').map(fix).filter(Boolean).join('\n');
    if (s.a || s.b || r.a || r.b) {
      s.a = String(r.a || '').trim();
      s.b = String(r.b || '').trim();
    }
    s.factKeys = cites;
  }
  if (target !== 'keywords' && !targetText(next, target).trim()) return { refused: 'the repair is empty' };
  if (factLock) {
    // A number the text did not state before stands only when a quote it cites holds it (a slide: its own facts;
    // the cover and the captions: any of the post's). Anything else is a number made up to pass.
    const s = next.slides[slideIndex(target)];
    const held = new Set(facts.filter((f) => f.verified && (!s || (s.factKeys || []).includes(f.key))).flatMap((f) => [...numbersIn(f.quote, { words: true, hebrew: true })]));
    const had = numbersIn(targetText(draft, target), { hebrew: true });
    const added = [...numbersIn(targetText(next, target), { hebrew: true })].filter((x) => !had.has(x) && !held.has(x));
    if (added.length) return { refused: `states ${added.join(', ')}, which no quote it cites holds: a number the quotes do not hold is removed, or a listed fact whose quote holds it is cited, never replaced by another number` };
  }
  return { draft: next };
}
