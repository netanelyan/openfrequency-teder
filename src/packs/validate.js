import { contrast, deltaE, isHex, bestInk } from '../render/color.js';
import { VISUAL_TYPES } from '../render/visuals.js';
import { DISPLAY_FACES, isFont } from '../render/fonts.js';
import { ALL_LOOKS, isTemplate, TEMPLATES } from '../render/templates/registry.js';
import { COMPLIANCE, FINANCIAL, isCompliance } from '../rules/compliance.js';
import { ctasOf, hookPatterns, isKind, kindOf, KINDS, MIX } from '../formats/kinds.js';
import { overlayConfigProblems } from '../rules/overlay.js';
import { resolveStyle, styleConfigProblems } from '../render/styles/tokens.js';
import { MAX_HASHTAGS, captionStyleOf } from '../rules/caption.js';
import { templateConfigProblems } from '../formats/hooks.js';
import { FLOOR } from '../voice/tells.js';

// What a pack must be, checked in code. Every problem is one line of English the
// website and the CLI can print. An empty list means the pack is valid.
//
// Two levels:
//   validatePack(pack)   one pack on its own: shape, colours, contrast, compliance
//   validateAll(packs)   the set: HARD RULE 2, each account a distinct brand
//
// packWarnings(pack) is a third list: what the engine changed on its own and the owner should know.

export const MODES = ['approve', 'digest', 'auto'];
export const PLATFORMS = ['tiktok', 'instagram', 'facebook'];
export const PUBLISHERS = ['dry', 'zernio'];
// TikTok as a draft the moment a post is approved and a reminder at its hour (the default), straight out, or as a draft
// at the hour posted directly an hour late if the owner does not.
export const TIKTOK_MODES = ['draft-now', 'direct', 'draft-fallback'];
/**
 * Who can publish to each platform. Instagram also directly, through Meta's own Graph API, or "auto": that one when it is
 * set up for the account, else Zernio. TikTok also through our own TikTok app ("own-app"), not built yet. A Facebook
 * Page through Zernio alone, with Instagram's slides (src/core/platforms.js).
 */
export const PLATFORM_PUBLISHERS = { tiktok: ['dry', 'zernio', 'own-app'], instagram: ['dry', 'zernio', 'instagram', 'auto'], facebook: ['dry', 'zernio'] };
export const SOURCE_TYPES = ['rss', 'web', 'api'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HANDLE = /^[a-z0-9][a-z0-9._]{1,29}$/;

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function validatePack(pack) {
  const p = [];
  const { meta = {}, theme = {}, sources = {}, formats = {}, rules = {}, voice = '' } = pack || {};

  // ---- pack.json
  if (!ID.test(meta.id || '')) p.push(`pack.json: id "${meta.id}" must be lowercase letters, digits and dashes`);
  if (pack?.dirName && meta.id !== pack.dirName) p.push(`pack.json: id "${meta.id}" must match its folder "${pack.dirName}"`);
  if (!String(meta.displayName || '').trim()) p.push('pack.json: displayName is required');
  if (!HANDLE.test(meta.handle || '')) p.push(`pack.json: handle "${meta.handle}" must be 2-30 of a-z 0-9 . _ (no @)`);
  if (meta.language !== 'he') p.push('pack.json: language must be "he" (the engine writes Hebrew, right to left)');
  if (!Array.isArray(meta.platforms) || !meta.platforms.length || meta.platforms.some((x) => !PLATFORMS.includes(x))) {
    p.push(`pack.json: platforms must be a non-empty list of ${PLATFORMS.join(', ')}`);
  }
  if (!PUBLISHERS.includes(meta.publisher || 'dry')) p.push(`pack.json: publisher must be one of ${PUBLISHERS.join(', ')}`);
  for (const [plat, via] of Object.entries(meta.publishers || {})) {
    if (!PLATFORM_PUBLISHERS[plat]) p.push(`pack.json: publishers.${plat}: not a platform (${PLATFORMS.join(', ')})`);
    else if (!PLATFORM_PUBLISHERS[plat].includes(via)) p.push(`pack.json: publishers.${plat} must be one of ${PLATFORM_PUBLISHERS[plat].join(', ')}`);
  }
  if (meta.zernio?.tiktokMode != null && !TIKTOK_MODES.includes(meta.zernio.tiktokMode)) p.push(`pack.json: zernio.tiktokMode must be one of ${TIKTOK_MODES.join(', ')}`);
  // Account ids are filled in once the accounts exist; until then the platform publishes dry,
  // and npm run zernio:check / instagram:check say what is missing.
  if (meta.instagram && !isObj(meta.instagram)) p.push('pack.json: instagram must be an object { userId, auth, tokenEnv }');
  if (meta.instagram?.auth && !['facebook', 'instagram'].includes(meta.instagram.auth)) p.push('pack.json: instagram.auth must be "facebook" (an account linked to a Facebook Page) or "instagram" (Instagram Login)');
  if (meta.instagram?.userId && !/^\d{5,25}$/.test(String(meta.instagram.userId))) p.push('pack.json: instagram.userId is the numeric Instagram account id');
  if (meta.instagram?.tokenEnv && !/^[A-Z][A-Z0-9_]{2,60}$/.test(meta.instagram.tokenEnv)) p.push('pack.json: instagram.tokenEnv is the name of a variable in .env, like IG_TOKEN_MYPACK');
  const s = meta.schedule || {};
  if (!Array.isArray(s.slots) || !s.slots.length || s.slots.some((x) => !HHMM.test(x))) p.push('pack.json: schedule.slots must be a list of "HH:MM"');
  if (s.windows && (!Array.isArray(s.windows) || s.windows.some((w) => !Array.isArray(w) || w.length !== 2 || !(w[0] < w[1])))) p.push('pack.json: schedule.windows must be [[from, to], ...] hours');
  for (const [d, list] of Object.entries(s.slotsByDay || {})) {
    if (!/^[0-6]$/.test(d) || !Array.isArray(list) || list.some((x) => !HHMM.test(x))) p.push(`pack.json: schedule.slotsByDay.${d} must be a list of "HH:MM"`);
  }
  // Post on Shabbat / the festivals too (off unless true; an account's saved choice wins: src/schedule/choice.js).
  for (const k of ['shabbat', 'holidays']) if (s[k] != null && typeof s[k] !== 'boolean') p.push(`pack.json: schedule.${k} must be true or false`);
  if (!MODES.includes(meta.autonomy?.mode || 'approve')) p.push(`pack.json: autonomy.mode must be one of ${MODES.join(', ')}`);
  for (const c of meta.compliance || []) if (!isCompliance(c)) p.push(`pack.json: unknown compliance check "${c}" (have: ${Object.keys(COMPLIANCE).join(', ')})`);
  const about = [meta.displayName, meta.audience, meta.description, ...(meta.topics || [])].join(' ');
  if (FINANCIAL.test(about) && !(meta.compliance || []).includes('il-investment-advice')) {
    p.push('pack.json: this pack is about money, so compliance must include "il-investment-advice" (hard rule 6)');
  }
  if (!Array.isArray(meta.topics) || !meta.topics.length) p.push('pack.json: topics must list what the account is about');

  // ---- theme.json
  if (!isTemplate(theme.template, theme.variant || 'a')) {
    p.push(`theme.json: template "${theme.template}" variant "${theme.variant || 'a'}" is not in the library (have: ${Object.entries(TEMPLATES).map(([k, v]) => `${k}/${v.variants.join('|')}`).join(', ')})`);
  }
  const c = theme.colors || {};
  for (const k of ['bg', 'surface', 'ink', 'muted', 'accent', 'accent2']) if (!isHex(c[k])) p.push(`theme.json: colors.${k} must be a hex colour`);
  if (['bg', 'surface', 'ink', 'muted', 'accent'].every((k) => isHex(c[k]))) {
    // Legibility is a property of the palette before it is a property of a slide.
    const pairs = [
      ['ink', 'bg', 7],
      ['ink', 'surface', 7],
      ['muted', 'bg', 4.5],
    ];
    for (const [a, b, min] of pairs) {
      const r = contrast(c[a], c[b]);
      if (r < min) p.push(`theme.json: ${a} on ${b} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
    const onAccent = c.onAccent && isHex(c.onAccent) ? c.onAccent : bestInk(c.accent, c.ink, c.bg);
    if (contrast(onAccent, c.accent) < 4.5) p.push(`theme.json: text on accent is ${contrast(onAccent, c.accent).toFixed(2)}:1, needs 4.5:1 (set colors.onAccent)`);
  }
  for (const k of ['display', 'text']) if (!isFont(theme.fonts?.[k])) p.push(`theme.json: fonts.${k} "${theme.fonts?.[k]}" is not a bundled font`);
  for (const v of theme.visuals || []) if (!VISUAL_TYPES.includes(v)) p.push(`theme.json: visuals: "${v}" is not a graphic the engine draws (${VISUAL_TYPES.join(', ')})`);
  const o = theme.options || {};
  for (const k of ['handleTag', 'sourceLine', 'slideKeywords', 'backgroundPhoto', 'coverPhoto']) if (o[k] !== undefined && typeof o[k] !== 'boolean') p.push(`theme.json: options.${k} is true or false`);
  if (o.backgroundVeil !== undefined && !(Number(o.backgroundVeil) >= 0.5 && Number(o.backgroundVeil) <= 0.95)) p.push('theme.json: options.backgroundVeil is from 0.5 to 0.95 (below 0.5 the text loses its contrast)');
  if (theme.backgroundQueries !== undefined && !(Array.isArray(theme.backgroundQueries) && theme.backgroundQueries.every((q) => typeof q === 'string' && q.trim()))) p.push('theme.json: backgroundQueries is a list of search phrases');
  if (o.backgroundPhoto && !(theme.backgroundQueries || []).length) p.push('theme.json: options.backgroundPhoto needs backgroundQueries, for the posts with no photograph of their own');

  // ---- sources.json
  const list = sources.sources || [];
  if (!list.length) p.push('sources.json: at least one approved source');
  const keys = new Set();
  for (const src of list) {
    const where = `sources.json: "${src.id}"`;
    if (!src.id || keys.has(src.id)) p.push(`${where}: id missing or repeated`);
    keys.add(src.id);
    if (!SOURCE_TYPES.includes(src.type)) p.push(`${where}: type must be ${SOURCE_TYPES.join(', ')}`);
    if (!/^https:\/\//.test(src.url || '')) p.push(`${where}: url must be https`);
    if (!String(src.name || '').trim()) p.push(`${where}: name is required`);
    if (String(src.why || '').trim().length < 10) p.push(`${where}: "why" must say why it is trusted`);
    if (!/^\d{4}-\d{2}-\d{2}/.test(src.approvedAt || '')) p.push(`${where}: approvedAt must be a date`);
  }

  // ---- formats.json
  const fl = formats.formats || [];
  if (!fl.length) p.push('formats.json: at least one format');
  const fids = new Set();
  for (const f of fl) {
    const where = `formats.json: "${f.id}"`;
    if (!f.id || fids.has(f.id)) p.push(`${where}: id missing or repeated`);
    fids.add(f.id);
    if (!String(f.name || '').trim()) p.push(`${where}: name is required`);
    if (f.kind != null && !isKind(f.kind)) p.push(`${where}: kind "${f.kind}" is not one of ${Object.keys(KINDS).join(', ')}`);
    const srcIds = new Set((pack.sources?.sources || []).map((s) => s.id));
    for (const sid of f.sources || []) if (!srcIds.has(sid)) p.push(`${where}: sources: "${sid}" is not one of this pack's sources`);
    if (!Array.isArray(f.hooks) || !f.hooks.length) p.push(`${where}: hooks must list at least one pattern`);
    else {
      const ids = hookPatterns(f).map((h) => h.id);
      if (new Set(ids).size !== ids.length) p.push(`${where}: hook ids must be unique`);
      if (hookPatterns(f).some((h) => !h.pattern.trim())) p.push(`${where}: every hook needs a pattern`);
    }
    if ((f.kind || 'list') === 'list') {
      const [lo, hi] = f.items || [];
      if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 2 && hi <= 10 && lo <= hi)) p.push(`${where}: items must be [min, max] between 2 and 10`);
      if (!Array.isArray(f.closers) || !f.closers.length || f.closers.some((x) => !String(x?.title || '').trim())) p.push(`${where}: closers must list at least one { title, body }`);
    } else if (!ctasOf(pack, f).length && kindOf(f).photo !== 'every') {
      // A post on a photograph a slide ends on its best slide, with no call to action drawn (src/formats/kinds.js everyPhoto).
      p.push(`${where}: a ${f.kind} post ends with a call to action: list ctas [{ kind: save|comment|send, text }] on the format or the file`);
    }
    for (const c of f.ctas || []) if (typeof c === 'object' && c && !['save', 'comment', 'send'].includes(c.kind)) p.push(`${where}: cta kind "${c.kind}" must be save, comment or send`);
    // A post carries five hashtags at most (src/rules/caption.js), and the format's own come first.
    if (f.hashtags != null && !(Array.isArray(f.hashtags) && f.hashtags.length <= MAX_HASHTAGS && f.hashtags.every((t) => /^#[\p{L}\p{N}_]+$/u.test(t)))) p.push(`${where}: hashtags is a list of at most ${MAX_HASHTAGS} tags like #מילה`);
  }
  // The cover's hook templates: the pack's own, the ones it turns off, its voice and its authorities (src/formats/hooks.js).
  p.push(...templateConfigProblems(formats.hookTemplates));
  if (formats.mix != null) {
    const e = Number(formats.mix?.entertaining);
    if (!(e >= MIX.min && e <= MIX.max)) p.push(`formats.json: mix.entertaining must be between ${MIX.min} and ${MIX.max}`);
  }

  // A customer's picks go in turn (src/formats/rotation.js turnOrder); nothing else is a way to rotate.
  if (formats.rotate != null && formats.rotate !== 'turns') p.push('formats.json: rotate is "turns" (the formats a customer picked, one after the other) or left out');

  // ---- events and the fight week (pack.json)
  const fw = s.fightWeek;
  if (fw) {
    for (const k of ['tale', 'predict', 'recap']) if (fw[k] && !fids.has(fw[k])) p.push(`pack.json: schedule.fightWeek.${k} "${fw[k]}" is not a format in formats.json`);
    if (fw.recapAfter && !HHMM.test(fw.recapAfter)) p.push('pack.json: schedule.fightWeek.recapAfter must be "HH:MM"');
    if (!meta.events?.source) p.push('pack.json: a fight week needs events.source, the source its calendar is read from');
  }
  if (meta.events?.source && !list.some((x) => x.id === meta.events.source)) p.push(`pack.json: events.source "${meta.events.source}" is not a source in sources.json`);
  if (meta.business != null && typeof meta.business !== 'boolean') p.push('pack.json: business is true for a shop or a brand (its TikTok sounds come from the Commercial Music Library), or false');
  if (meta.imagery?.safety && !['standard', 'strict'].includes(meta.imagery.safety)) p.push('pack.json: imagery.safety must be "standard" or "strict"');
  for (const prov of meta.imagery?.providers || []) if (!['commons', 'pexels', 'unsplash', 'openverse', 'pack'].includes(prov)) p.push(`pack.json: imagery.providers: "${prov}" is not one of commons, pexels, unsplash, openverse, pack`);
  const minDetails = meta.research?.minDetails;
  if (minDetails !== undefined && !(Number.isInteger(minDetails) && minDetails >= 0 && minDetails <= 8)) p.push('pack.json: research.minDetails is a whole number from 0 to 8');
  const maxAge = meta.research?.maxAgeDays;
  if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge >= 7)) p.push('pack.json: research.maxAgeDays is a whole number of days, 7 or more');
  // The names whose Wikipedia pages are watched for a week that reads far more than the month before (src/topics).
  const watch = meta.interest?.wikipedia;
  if (watch !== undefined && !(Array.isArray(watch) && watch.every((x) => typeof x === 'string' && x.trim()))) p.push('pack.json: interest.wikipedia is a list of Wikipedia page titles');
  if (meta.bio !== undefined && [...String(meta.bio)].length > 80) p.push('pack.json: bio is over 80 characters, the limit on TikTok');
  if (meta.endSlide !== undefined && !(isObj(meta.endSlide) && String(meta.endSlide.title || '').trim() && [...String(meta.endSlide.title)].length <= 60 && [...String(meta.endSlide.body || '')].length <= 120)) p.push('pack.json: endSlide needs a title (up to 60 characters) and may have a body (up to 120)');
  for (const [k, v] of Object.entries(meta.writing || {})) {
    // How TikTok's caption is told: one short line (the default) or the four-beat story (src/rules/caption.js).
    if (k === 'captionStyle') {
      if (!['short', 'story'].includes(v)) p.push('pack.json: writing.captionStyle is "short" (one line, the default) or "story" (four beats)');
      continue;
    }
    if (!['cover', 'sub', 'slideTitle', 'slideBody', 'slideLines', 'captionLong', 'captionShort'].includes(k) || !isObj(v)) p.push(`pack.json: writing.${k} is not a text the pack can limit (cover, sub, slideTitle, slideBody, slideLines, captionLong, captionShort)`);
    else for (const [m, n] of Object.entries(v)) if (!['maxChars', 'sentences', 'maxWords', 'minChars'].includes(m) || !(Number.isInteger(n) && n > 0)) p.push(`pack.json: writing.${k}.${m} must be maxChars, sentences, maxWords or minChars, a whole number`);
  }
  p.push(...overlayConfigProblems(meta.overlay));
  p.push(...styleConfigProblems(meta.style));
  if ([...String(meta.displayName || '')].length > 30) p.push('pack.json: displayName is over 30 characters, the limit on Instagram and TikTok');
  if (!Array.isArray(formats.caption?.questions) || !formats.caption.questions.length) p.push('formats.json: caption.questions must list at least one question');
  const tags = [...(formats.hashtags?.broad || []), ...(formats.hashtags?.niche || [])];
  if (tags.length < 3 || tags.some((t) => !/^#[\p{L}\p{N}_]+$/u.test(t))) p.push('formats.json: hashtags.broad + hashtags.niche need at least 3 tags like #מילה');

  // ---- rules.json
  if (!isObj(rules)) p.push('rules.json: must be an object');
  const mq = Number(rules.maxQuoteWords ?? 40);
  if (!(mq >= 8 && mq <= 60)) p.push('rules.json: maxQuoteWords must be between 8 and 60 (short facts only)');
  for (const r of rules.patterns || []) {
    try {
      new RegExp(r.regex, 'u');
    } catch {
      p.push(`rules.json: pattern "${r.id}" is not a valid regular expression`);
    }
    if (!String(r.message || '').trim()) p.push(`rules.json: pattern "${r.id}" needs a message`);
  }

  // ---- voice.md
  const v = String(voice || '');
  if (v.trim().length < 200) p.push('voice.md: describe who is talking, to whom, and how (at least a few paragraphs)');
  const { good, bad } = voiceExamples(v);
  if (good.length < 3) p.push('voice.md: at least 3 good example lines under a "## שורות טובות" heading');
  if (bad.length < 3) p.push('voice.md: at least 3 bad example lines under a "## שורות רעות" heading');

  return p;
}

/**
 * What the pack asks for that the engine overrides, one line each. Not a reason to refuse the pack:
 * a caption limit below the floor (src/voice/tells.js) is raised so the four-line story still fits.
 */
export function packWarnings(pack) {
  const w = [];
  const id = pack?.meta?.id || pack?.dirName || '?';
  // The floor is the four-line story's room: an account on short captions (the default) never needs it.
  for (const [kind, floor] of Object.entries(captionStyleOf(pack) === 'story' ? FLOOR : {})) {
    for (const [k, min] of Object.entries(floor)) {
      const v = pack?.meta?.writing?.[kind]?.[k];
      if (Number.isFinite(v) && v < min) w.push(`pack "${id}": writing.${kind}.${k} ${v} is raised to ${min}, the room TikTok's four-line story needs`);
    }
  }
  return w;
}

/** The example lines in voice.md, by heading. */
export function voiceExamples(md) {
  const out = { good: [], bad: [] };
  let into = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const h = /^#{2,3}\s*(.+)$/.exec(line);
    if (h) {
      into = /טוב|good/i.test(h[1]) ? 'good' : /רע|bad/i.test(h[1]) ? 'bad' : null;
      continue;
    }
    const b = /^\s*[-*]\s+(.+)$/.exec(line);
    if (into && b) out[into].push(b[1].replace(/^["“]|["”]$/g, '').trim());
  }
  return out;
}

/**
 * HARD RULE 2 across the set: each account is a distinct brand. Refuses, everywhere, shared ids, handles, display names
 * and Zernio profiles and accounts: those name one account and only one. The look (a shared visual template, a display
 * face used by two packs, palettes too close to tell apart, one style with accents too close) is refused within a
 * group: `groupOf(pack)` names it, one customer's workspace or the operator's own accounts (src/packs/load.js
 * lookGroups). Two customers' accounts are two businesses and may look alike; one customer's own accounts may not, while
 * the pool allows it: a group with more accounts than there are templates (or display faces) has to share one, and
 * creating an account never fails for that (src/onboarding/pack.js newTheme takes the least used). Without `groupOf`
 * every pack is in one group, as before.
 */
export function validateAll(packs, { groupOf = () => 'all' } = {}) {
  const p = [];
  const seen = (field, get, list = packs) => {
    const map = new Map();
    for (const pk of list) {
      const v = String(get(pk) || '').trim().toLowerCase();
      if (!v) continue;
      if (map.has(v)) p.push(`${pk.meta.id} and ${map.get(v)} share the same ${field}`);
      else map.set(v, pk.meta.id);
    }
  };
  seen('id', (x) => x.meta.id);
  seen('handle', (x) => x.meta.handle);
  seen('display name', (x) => x.meta.displayName);
  seen('Zernio profile', (x) => x.meta.zernio?.profileId);
  for (const plat of PLATFORMS) seen(`Zernio ${plat} account`, (x) => x.meta.zernio?.accounts?.[plat]);
  const groups = new Map();
  for (const pk of packs) {
    const g = String(groupOf(pk) ?? 'all');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(pk);
  }
  for (const list of groups.values()) p.push(...looksApart(list));
  return p;
}

/** The look rules for one group of packs: what validateAll checks within a workspace (or the operator's accounts). */
function looksApart(packs) {
  const p = [];
  const seen = (field, get) => {
    const map = new Map();
    for (const pk of packs) {
      const v = String(get(pk) || '').trim().toLowerCase();
      if (!v) continue;
      if (map.has(v)) p.push(`${pk.meta.id} and ${map.get(v)} share the same ${field}`);
      else map.set(v, pk.meta.id);
    }
  };
  // Past the pool, sharing is unavoidable: the rule holds while the group is no bigger than what there is to give.
  if (packs.length <= ALL_LOOKS.length) seen('visual template', (x) => `${x.theme.template}/${x.theme.variant || 'a'}`);
  if (packs.length > DISPLAY_FACES.length) return p;
  seen('display font', (x) => x.theme.fonts?.display);
  // Under the slide styles (pack.json "style") two accounts may share a style, never a style and an accent close
  // enough to tell apart only side by side: the second customer in a niche is given another style or accent.
  const styled = packs.filter((x) => x.meta?.style?.name && !styleConfigProblems(x.meta.style).length);
  for (let i = 0; i < styled.length; i++) {
    for (let k = i + 1; k < styled.length; k++) {
      const [a, b] = [styled[i], styled[k]];
      if (a.meta.style.name !== b.meta.style.name) continue;
      const d = deltaE(resolveStyle(a.meta.style, a.theme.colors?.accent).colors.accent, resolveStyle(b.meta.style, b.theme.colors?.accent).colors.accent);
      if (d < 20) p.push(`${a.meta.id} and ${b.meta.id} share style ${a.meta.style.name} with accents too close to tell apart (ΔE ${d.toFixed(1)}): give one another style or accent`);
    }
  }

  for (let i = 0; i < packs.length; i++) {
    for (let k = i + 1; k < packs.length; k++) {
      const a = packs[i].theme.colors || {};
      const b = packs[k].theme.colors || {};
      if (![a.bg, b.bg, a.accent, b.accent].every(isHex)) continue;
      const dBg = deltaE(a.bg, b.bg);
      const dAccent = deltaE(a.accent, b.accent);
      if (dBg < 12 && dAccent < 20) {
        p.push(`${packs[i].meta.id} and ${packs[k].meta.id} have palettes too close to tell apart (background ΔE ${dBg.toFixed(1)}, accent ΔE ${dAccent.toFixed(1)})`);
      }
    }
  }
  return p;
}
