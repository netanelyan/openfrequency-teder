import { COMPLIANCE } from './compliance.js';
import { badgeNextTo, experienceIn, fakeProofIn } from '../voice/honesty.js';
import { normHe } from '../voice/tells.js';
import { numbersIn } from '../verify/claims.js';

// The checks a post's text runs through besides the voice: the pack's own niche
// rules, the engine's compliance checks, honesty (no invented experience, no fake
// proof) and HARD RULE 2's "no cross-promotion".
//
// texts: [{ where, text, owner }]. Returns [{ where, code, msg }]. A text marked `owner` says what the business
// owner wrote down as their own story (src/sources/facts.js "owner"): the first person is theirs there, and only there.

export function checkRules({ pack, others = [], texts, sourced = null }) {
  const out = [];
  const rules = pack.rules || {};
  const patterns = (rules.patterns || []).map((r) => ({ ...r, re: new RegExp(r.regex, 'iu') }));
  const compliance = (pack.meta.compliance || []).map((id) => ({ id, ...COMPLIANCE[id] }));
  // Other accounts are named by handle (with or without @) and by display name.
  const rivals = others
    .filter((o) => o.id !== pack.id)
    .flatMap((o) => [o.meta.handle, `@${o.meta.handle}`, o.meta.displayName].filter(Boolean).map((n) => ({ id: o.id, n })));

  for (const { where, text, owner = false } of texts) {
    const s = String(text || '');
    if (!s.trim()) continue;
    for (const r of patterns) if (r.re.test(s)) out.push({ where, code: `rule:${r.id}`, msg: r.message });
    for (const c of compliance) for (const why of c.check(s)) out.push({ where, code: `compliance:${c.id}`, msg: `${c.he}: ${why}` });
    const exp = owner ? null : experienceIn(s);
    if (exp) out.push({ where, code: 'honesty:experience', msg: `claims an experience nobody had: "${exp}"` });
    const proof = fakeProofIn(s);
    // A count of views or followers the post's verified facts give is about what the post is about, not the account.
    const fromFacts = proof && sourced?.size && [...numbersIn(proof)].some((n) => sourced.has(n));
    if (proof && !fromFacts) out.push({ where, code: 'honesty:proof', msg: `a badge or a metric about the account: "${proof}"` });
    const badge = badgeNextTo(s, pack.meta.displayName);
    if (badge) out.push({ where, code: 'honesty:badge', msg: `a verification mark next to the account's name: "${badge}"` });
    const norm = normHe(s).toLowerCase();
    for (const r of rivals) {
      const n = r.n.startsWith('@') ? r.n.toLowerCase() : normHe(r.n).toLowerCase();
      if (n.length >= 3 && (r.n.startsWith('@') ? s.toLowerCase().includes(n) : ` ${norm} `.includes(` ${n} `))) {
        out.push({ where, code: 'brand:cross-promotion', msg: `names another of our accounts (${r.id})` });
      }
    }
  }
  return out;
}

/** An image search query the pack forbids (club crests, logos, a person's face...). */
export function blockedQuery(pack, query) {
  // Whole words (and their plural): "ko" refuses "UFC KO", not "Valentina Shevchenko".
  const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const q = ` ${words(query)} `;
  const hit = (pack.rules?.imageQueryBlock || []).find((w) => words(w) && (q.includes(` ${words(w)} `) || q.includes(` ${words(w)}s `)));
  return hit || null;
}
