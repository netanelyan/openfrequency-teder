import { getSetting, setSetting } from '../core/store.js';
import { nowIso } from '../core/clock.js';
import { askJson } from '../llm/index.js';
import { ALWAYS_BLOCK } from './index.js';

// An account's scenes (theme.json backgroundQueries): what a slide with no photograph of its own stands on. A scene
// is a place or a thing of the niche with no one in it (an empty arena, a pitch, a desk), searched like any photograph
// and checked for what it must show (src/pipeline/build.js findPhotos).
//
// The owner, 2026-10-31, on a customer's sample slideshows that were plain dark slides with white text: "the slides
// dont have images. no slide can be empty." The accounts the setup made had no scenes, so a slide whose own photograph
// was refused had nothing to stand on. Now the setup writes them into the new theme (src/onboarding/pack.js), and an
// account made before that gets them the first time a post needs one (scenesFor).

export const SCENES = { min: 4, max: 6 };

// A scene has no one in it: a person in it reads as a stranger behind someone else's story.
const PEOPLE = /\b(?:people|persons?|man|men|woman|women|boys?|girls?|kids?|child(?:ren)?|players?|fans?|crowds?|coach(?:es)?|referees?|chefs?|athletes?|fighters?|teams?|portraits?|faces?|selfies?|couples?|family|families|workers?|audiences?|celebrit(?:y|ies)|models?|hands?|staff|students?|teachers?|doctors?|nurses?)\b/;

/**
 * One scene as the search takes it, or null: one to five English words, lowercase, nobody's name (a capital after the
 * first word is one: "Camp Nou", "Real Madrid"), no person, nothing the photograph screen refuses (ALWAYS_BLOCK, the
 * pack's imageQueryBlock) and no brand.
 */
export function cleanScene(query, block = []) {
  const s = String(query || '').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z][A-Za-z0-9' -]*$/.test(s)) return null;
  const words = s.split(' ');
  if (words.length > 5 || words.slice(1).some((w) => /^[A-Z]/.test(w))) return null;
  const low = s.toLowerCase();
  if (PEOPLE.test(low)) return null;
  const bad = new Set([...ALWAYS_BLOCK, 'brand', 'brands', ...block].map((w) => String(w).toLowerCase()));
  if (low.split(/[^a-z0-9]+/).some((w) => bad.has(w) || bad.has(w.replace(/s$/, '')))) return null;
  return low;
}

// The niches a fallback knows, in Hebrew and in English: a model writes better ones, and this is for a setup with no
// model to ask (offline, or a call that failed).
const KNOWN = [
  [/כדורגל|football|soccer/i, ['football stadium at night', 'football pitch grass', 'football on the grass', 'empty stadium seats', 'football goal net']],
  [/כדורסל|basketball/i, ['basketball court', 'basketball hoop', 'empty basketball arena', 'basketball on the court']],
  [/MMA|UFC|אגרוף|לחימה|boxing|fight|martial/i, ['octagon cage', 'boxing ring', 'boxing gloves', 'empty fight arena lights']],
  [/בישול|אוכל|מתכונ|מטבח|cooking|food|recipe|kitchen/i, ['kitchen counter', 'fresh vegetables', 'pot on a stove', 'spices on a table']],
  [/כסף|כלכל|חיסכון|השקע|פיננס|מניות|משכנת|money|financ|invest|saving|mortgage/i, ['coins on a table', 'calculator and notebook', 'city skyline at night', 'laptop on a desk']],
  [/טכנולוג|בינה מלאכותית|תכנות|מחשב|אפליקצי|\bAI\b|tech|software|coding|computer/i, ['laptop on a desk', 'circuit board', 'server room', 'keyboard close up']],
  [/צמח|גינ|עציץ|plant|garden/i, ['house plants', 'green leaves', 'potted plant by a window', 'garden soil']],
  [/כושר|אימון|fitness|gym|workout/i, ['empty gym', 'dumbbells on the floor', 'running track', 'yoga mat']],
  [/טיול|טיולים|נסיעה|חופשה|travel|trip|vacation/i, ['mountain landscape', 'beach at sunset', 'old city street', 'airport terminal']],
  [/נדל"?ן|דירה|דירות|real estate|apartment|housing/i, ['apartment building', 'living room', 'house keys', 'city skyline']],
  [/רכב|מכונית|\bcars?\b|driving/i, ['car on a road', 'highway at night', 'car engine', 'parking lot']],
  [/מוזיקה|שירים|music|songs?\b/i, ['concert stage lights', 'guitar', 'vinyl records', 'microphone on a stage']],
  [/זכויות|עבודה|שכר|משפט|rights|salary|legal|\blaw\b/i, ['office desk with papers', 'pen and documents', 'office building', 'notebook on a desk']],
];
// Anything else: the niche's own English words with a setting, then a quiet desk and a city.
const ANY = ['notebook on a desk', 'city skyline at night', 'sunlight through a window', 'empty street at dawn'];

/**
 * Scenes for a niche with no model: the first known niche's (the niche itself before its topics), then its own English
 * words (nicheEn) with a setting, then anything quiet. Always SCENES.min to SCENES.max, cleaned.
 */
export function fallbackScenes(seed = {}, block = []) {
  const texts = [`${seed.niche || ''} ${seed.nicheEn || ''}`, (seed.topics || []).join(' ')];
  const known = texts.map((t) => KNOWN.find(([re]) => re.test(t))).find(Boolean)?.[1] || [];
  const en = String(seed.nicheEn || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  const own = en ? [en, `${en} close up`] : [];
  return [...new Set([...known, ...own, ...ANY].map((q) => cleanScene(q, block)).filter(Boolean))].slice(0, SCENES.max);
}

const SCENES_SCHEMA = { type: 'object', properties: { scenes: { type: 'array', items: { type: 'string' } } }, required: ['scenes'], additionalProperties: false };

/**
 * The scenes of a new account: 4 to 6 short English photo searches for its niche's places and things, written by the
 * model in one small call, else fallbackScenes. A short list from the model is filled from the fallback. `seed`:
 * { niche, nicheEn, audience, topics, displayName }; `block`: the pack's imageQueryBlock. Returns { scenes, by }.
 */
export async function writeScenes(ctx, seed = {}, { block = [] } = {}) {
  const fallback = fallbackScenes(seed, block);
  if (ctx.llm?.kind !== 'claude' || !seed.niche) return { scenes: fallback.slice(0, SCENES.max), by: 'fallback' };
  try {
    const { data } = await askJson(ctx, {
      task: 'scenes', role: 'judge', effort: 'low', maxTokens: 1000, expectOut: 120, tag: 'onboarding', schema: SCENES_SCHEMA,
      system: `You name the scenes a Hebrew social account's slides stand on when a slide has no photograph of its own: ${SCENES.min} to ${SCENES.max} short English photo searches (two to five words, lowercase) for the places and things of the account's niche, as a free stock library would answer them ("football stadium at night", "boxing gloves", "kitchen counter", "laptop on a desk"). No one in them: never a person, a player, a fan, a crowd, hands or a face. Never a name (no person, club, brand, product or named place), never a logo, a sign, text, a screen, a jersey or a kit. Each one different, each one a real photograph a library has many of. Return { scenes }.`,
      user: `Account: ${seed.displayName || ''}. Niche: ${seed.niche}${seed.nicheEn ? ` (${seed.nicheEn})` : ''}. Audience: ${seed.audience || ''}. Topics: ${(seed.topics || []).join(', ') || 'none'}.`,
    });
    const got = [...new Set((data?.scenes || []).map((q) => cleanScene(q, block)).filter(Boolean))];
    if (!got.length) return { scenes: fallback, by: 'fallback' };
    return { scenes: [...new Set([...got, ...fallback])].slice(0, Math.max(SCENES.min, Math.min(SCENES.max, got.length))), by: got.length >= SCENES.min ? 'model' : 'model+fallback' };
  } catch (e) {
    ctx.log?.(`scenes: ${e.message}`);
    return { scenes: fallback, by: 'fallback' };
  }
}

/** What a pack says it is about, as the setup's seed: its niche (the first topic), audience, topics and English niche. */
export function seedOfPack(pack) {
  const [niche = '', ...topics] = pack.meta?.topics || [];
  // The setup kept the niche in English only in the trends query it wrote ("<niche in English> tips").
  const en = String(pack.formats?.trends?.queries?.en?.[0] || '').replace(/\s+tips$/i, '').trim();
  return { niche: niche || pack.meta?.displayName || '', nicheEn: /[A-Za-z]/.test(en) && !/[֐-׿]/.test(en) ? en : '', audience: pack.meta?.audience || '', topics, displayName: pack.meta?.displayName || '' };
}

/**
 * The scenes a post of this pack searches: theme.json's own (the owner's, or the setup's), else the ones written for
 * the pack the first time a post needed them, kept in settings `scenes:<pack>`. An account the setup made before
 * scenes existed gets them here, with no step by hand. They are kept in the database, not written into theme.json:
 * a change to theme.json is a new look the account page asks the customer to take (src/render/style.js), and these
 * change nothing in the look. Only the model's are kept; a fallback is made again each time (it costs nothing), so a
 * model that answers later still writes the account's own.
 */
export async function scenesFor(ctx, pack) {
  const own = (pack.theme?.backgroundQueries || []).filter((q) => String(q || '').trim());
  if (own.length) return own;
  const key = `scenes:${pack.id}`;
  const kept = ctx.db ? getSetting(ctx.db, key, null) : null;
  if (kept?.scenes?.length) return kept.scenes;
  const made = await writeScenes(ctx, seedOfPack(pack), { block: pack.rules?.imageQueryBlock || [] });
  if (ctx.db && made.by !== 'fallback') setSetting(ctx.db, key, { ...made, at: nowIso() });
  ctx.log?.(`scenes for ${pack.id} (${made.by}): ${made.scenes.join(', ')}`);
  return made.scenes;
}
