// The setup's writing, by a model that reads the business (the owner, 2026-11-08: "involve AI in setting up the page and
// creating slideshows, even if it X3 the cost of a slideshow"). Until then a new account's description was a template
// ("<niche>, for <audience>. Created from an onboarding."), its promise the site's words as the scraper found them, its
// slide style a keyword count, its hashtags the niche's words with "#" before them and its caption questions three
// fixed lines. One call writes them for this business: what the account posts and for whom (which the art director and
// the closing slide read), the promise its closing slides land on said plainly from the site's own words, the style
// among the ones it may have and why, the hashtags its audience searches, and three questions in its own world.
//
// Every field is checked and falls back to what the setup made before, one by one: a promise the promo's rules refuse,
// a style it may not have, a hashtag that is not one. Only a live model writes it; a failure keeps every fallback.

import { askJson } from '../llm/index.js';
import { STYLES } from '../render/styles/tokens.js';
import { PROMISE_MIN, PROMO_MAX, promoProblems } from '../packs/promo.js';

export const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    promise: { type: 'string' },
    style: { type: 'string' },
    styleWhy: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['description', 'promise', 'style', 'styleWhy', 'hashtags', 'questions'],
  additionalProperties: false,
};

export const SETUP_SYSTEM = `You set up a new Hebrew slideshow account for a small Israeli business, on TikTok, Instagram and Facebook. Its slideshows teach and surprise its audience about the business's world, and each ends on a closing slide that sends people to the business. From what the owner told us and what their site says, write:
- description: two English sentences: what the account posts about and for whom, and what the business sells or does. The engine's writers and art director read it before every post: concrete, never marketing ("Bread, sourdough and home baking for Tel Aviv families who bake on weekends. Run by a neighbourhood sourdough bakery that sells loaves and baking classes.").
- promise: what the business gives the people who reach it, in Hebrew, ${PROMISE_MIN} to ${PROMO_MAX.promise} characters, said plainly as the business would say it to a customer, only from the site's own words below (never a claim, a price, a discount or a "הכי" the site does not make). "" when the site says too little to say it truly.
- style: the slide design for this business, one of the styles offered below by its letter, and styleWhy: one English sentence on why it fits this business (a business wants a serious, designed look).
- hashtags: 8 to 12 Hebrew hashtags its audience really searches for, each "#" and one word or words joined without spaces (#מתכוניםקלים), from the niche's own words and its topics: never generic (#טיפים, #ישראל), never English.
- questions: 3 short Hebrew questions a slideshow's caption could end on, each about this niche's own life (what the reader bakes, tried, would choose), plural ("אתם"), never "מה דעתכם?" or "ידעתם את זה?".`;

/** The request: the business as the setup knows it, its site's words, and the styles it may have. Pure. */
export function setupUser({ seed = {}, displayName = '', promo = null, siteText = '', allowed = [] }) {
  const styles = allowed.filter((n) => STYLES[n]).map((n) => `${n}: ${STYLES[n].about}`);
  return [
    `BUSINESS: ${displayName}. Niche: ${seed.niche || ''}${seed.nicheEn ? ` (${seed.nicheEn})` : ''}. Audience: ${seed.audience || 'Hebrew speakers'}. Topics: ${(seed.topics || []).join(', ') || 'none given'}.`,
    promo ? `IT SENDS PEOPLE TO: ${promo.name}${promo.target?.kind === 'product' ? `, the product "${promo.target.name}"` : promo.target?.kind === 'site' ? `, its site ${promo.target.url}` : ', the link on its profile'}. Its promise as the site was read: "${promo.promise || ''}".` : 'IT SENDS PEOPLE TO: nothing yet (its closing slides ask to follow the account): promise "".',
    siteText ? `THE SITE SAYS:\n${String(siteText).slice(0, 3000)}` : 'THE SITE SAYS: nothing we could read.',
    `STYLES OFFERED (first is the engine's own pick):\n${styles.join('\n')}`,
  ].join('\n\n');
}

const TAG = /^#[\p{L}\p{N}_]{2,28}$/u;
const GENERIC = new Set(['#טיפים', '#ישראל', '#מידע', '#fyp', '#foryou', '#viral']);

/**
 * What the model wrote, checked field by field against what the setup made without it (`fallback`: { description,
 * promise, style, hashtags, questions }). Returns the fields to use and, in `kept`, which came from the model. Pure.
 */
export function checkSetup(answer, { fallback, promo = null, allowed = [] }) {
  const out = { ...fallback };
  const kept = [];
  const d = String(answer?.description || '').replace(/\s+/g, ' ').trim();
  if (d.length >= 40 && d.length <= 400 && /[A-Za-z]/.test(d)) {
    out.description = d;
    kept.push('description');
  }
  const p = String(answer?.promise || '').replace(/\s+/g, ' ').trim();
  if (promo && p && /[֐-׿]/.test(p) && !promoProblems({ ...promo, promise: p }).length) {
    out.promise = p;
    kept.push('promise');
  }
  const s = String(answer?.style || '').trim().toUpperCase();
  if (allowed.includes(s)) {
    out.style = s;
    kept.push('style');
  }
  const tags = [...new Set((answer?.hashtags || []).map((t) => String(t).trim()).filter((t) => TAG.test(t) && /[֐-׿]/.test(t) && !GENERIC.has(t)))];
  if (tags.length >= 4) {
    out.hashtags = [...tags.slice(0, 12), ...fallback.hashtags.filter((t) => !tags.includes(t))].slice(0, 16);
    kept.push('hashtags');
  }
  const qs = (answer?.questions || []).map((q) => String(q).replace(/\s+/g, ' ').trim()).filter((q) => /[֐-׿]/.test(q) && q.length <= 80 && /\?$/.test(q) && !/מה דעתכם|ידעתם את זה/.test(q));
  if (qs.length >= 2) {
    out.questions = qs.slice(0, 3);
    kept.push('questions');
  }
  return { ...out, kept };
}

/**
 * The setup's writing for one new account, when a live model sets it up; else the fallback as it is. Returns the
 * fields (checkSetup) and `usd`.
 */
export async function setupWriting(ctx, { seed, displayName, promo = null, siteText = '', allowed = [], fallback }) {
  if (ctx.llm?.kind !== 'claude') return { ...fallback, kept: [], usd: 0 };
  try {
    const res = await askJson(ctx, {
      task: 'setup', role: 'draft', effort: 'medium', maxTokens: 4000, tag: 'onboarding', schema: SETUP_SCHEMA,
      system: SETUP_SYSTEM, user: setupUser({ seed, displayName, promo, siteText, allowed }),
    });
    return { ...checkSetup(res.data, { fallback, promo, allowed }), styleWhy: String(res.data.styleWhy || ''), usd: res.usd || 0 };
  } catch (e) {
    ctx.log?.(`setup writing: ${e.message}`);
    return { ...fallback, kept: [], usd: 0 };
  }
}
