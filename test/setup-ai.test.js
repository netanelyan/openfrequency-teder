import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_SYSTEM, checkSetup, setupUser, setupWriting } from '../src/onboarding/setup-ai.js';

// The setup's writing (src/onboarding/setup-ai.js): the owner, 2026-11-08, "involve AI in setting up the page and
// creating slideshows, even if it X3 the cost of a slideshow". Each field the model writes is checked and falls back to
// what the setup made without it.

const PROMO = { name: 'מאפיית השכונה', promise: 'לחם מחמצת', target: { kind: 'site', url: 'https://bakery.example/' } };
const FALLBACK = { description: 'לחם, for families. Created from an onboarding.', promise: 'לחם מחמצת', style: 'A', hashtags: ['#לחם', '#מידע'], questions: ['זה נוגע לכם?'] };
const GOOD = {
  description: 'Sourdough bread and home baking for Tel Aviv families who bake on weekends. Run by a neighbourhood bakery that sells loaves and baking classes.',
  promise: 'לחם מחמצת שנאפה כל בוקר, וסדנאות אפייה לכל המשפחה',
  style: 'C',
  styleWhy: 'A light, warm card suits a bakery.',
  hashtags: ['#לחםמחמצת', '#אפייהביתית', '#מחמצת', '#לחםביתי', '#טיפים', '#bread', 'לחם'],
  questions: ['מה אתם אופים בסוף השבוע?', 'כבר ניסיתם להכין מחמצת?', 'איזה לחם הייתם רוצים ללמוד לאפות?'],
};

test('what the model writes is taken field by field when it keeps the rules: a real description, a promise the promo takes, a style it may have', () => {
  const r = checkSetup(GOOD, { fallback: FALLBACK, promo: PROMO, allowed: ['A', 'C', 'D'] });
  assert.deepEqual(r.kept, ['description', 'promise', 'style', 'hashtags', 'questions']);
  assert.equal(r.style, 'C');
  assert.equal(r.promise, GOOD.promise);
  assert.deepEqual(r.hashtags.slice(0, 4), ['#לחםמחמצת', '#אפייהביתית', '#מחמצת', '#לחםביתי'], 'generic, English and malformed tags are left out');
  assert.ok(!r.hashtags.includes('#טיפים') && !r.hashtags.includes('#bread') && !r.hashtags.includes('לחם'));
  assert.ok(r.hashtags.includes('#לחם'), "the setup's own tags follow the model's");
});

test('a field that breaks a rule keeps the setup\'s own: E or a style it may not have, a promise too long or invented for no promo, too few tags', () => {
  const bad = { ...GOOD, description: 'short', promise: 'א'.repeat(120), style: 'E', hashtags: ['#a', '#b'], questions: ['מה דעתכם?', 'bad'] };
  const r = checkSetup(bad, { fallback: FALLBACK, promo: PROMO, allowed: ['A', 'C', 'D'] });
  assert.deepEqual(r.kept, []);
  assert.deepEqual({ ...r, kept: undefined }, { ...FALLBACK, kept: undefined });
  assert.equal(checkSetup(GOOD, { fallback: FALLBACK, promo: null, allowed: ['C'] }).kept.includes('promise'), false, 'no promo, no promise');
});

test('the request and the rules: the business, what the site says, the styles it may have; a recorded run makes no call', async () => {
  const user = setupUser({ seed: { niche: 'לחם', audience: 'משפחות', topics: ['מחמצת'] }, displayName: 'מאפיית השכונה', promo: PROMO, siteText: 'מאפייה שכונתית בתל אביב', allowed: ['A', 'C'] });
  assert.match(user, /BUSINESS: מאפיית השכונה\. Niche: לחם/);
  assert.match(user, /THE SITE SAYS:\nמאפייה שכונתית בתל אביב/);
  assert.match(user, /STYLES OFFERED \(first is the engine's own pick\):\nA: /);
  assert.match(SETUP_SYSTEM, /only from the site's own words/);
  const kept = await setupWriting({ llm: { kind: 'recorded' } }, { seed: {}, displayName: 'x', fallback: FALLBACK, allowed: ['A'] });
  assert.deepEqual(kept.kept, []);
  assert.equal(kept.description, FALLBACK.description);
});
