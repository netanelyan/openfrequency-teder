import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packsDir } from '../core/paths.js';
import { contrast, deltaE, bestInk } from '../render/color.js';
import { DISPLAY_FACES, FONTS } from '../render/fonts.js';
import { ALL_LOOKS } from '../render/templates/registry.js';
import { FINANCIAL } from '../rules/compliance.js';
import { askJson } from '../llm/index.js';
import { HEBREW } from '../pipeline/prompts.js';
import { lookGroups, loadPack, readPack } from '../packs/load.js';
import { validateAll } from '../packs/validate.js';
import { packIdOf } from './setup.js';
import { suggestStyle } from './style.js';
import { resolveStyle } from '../render/styles/tokens.js';

// A new pack, written from an onboarding: the owner's seed, the sources they
// approved, and a look none of the customer's other accounts has. No code: the
// result is the same six files a hand-written pack has, and it is validated like
// one before it is written.
//
// Looks are kept apart within one customer's workspace (and among the operator's
// own accounts), never across customers (src/packs/validate.js validateAll): two
// businesses may share a template or a display face. And the pool never runs out:
// a template or face the workspace does not use comes first, then the least used
// on the whole server, so a workspace with more accounts than looks shares one.

const hsl = (h, s, l) => {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};

/** A palette for a hue, adjusted until it passes the same contrast rules every pack must. */
export function paletteFor(hue, { dark = false } = {}) {
  for (let step = 0; step < 12; step++) {
    const c = dark
      ? { bg: hsl(hue, 30, 9), surface: hsl(hue, 26, 14), ink: hsl(hue, 20, 96), muted: hsl(hue, 14, 72), accent: hsl(hue, 80, 64 - step * 2), accent2: hsl((hue + 150) % 360, 70, 62) }
      : { bg: hsl(hue, 40, 96), surface: '#FFFFFF', ink: hsl(hue, 35, 10), muted: hsl(hue, 14, 34), accent: hsl(hue, 70, 40 - step * 2), accent2: hsl((hue + 150) % 360, 65, 42) };
    c.onAccent = bestInk(c.accent, c.ink, c.bg);
    if (contrast(c.ink, c.bg) >= 7 && contrast(c.ink, c.surface) >= 7 && contrast(c.muted, c.bg) >= 4.5 && contrast(c.onAccent, c.accent) >= 4.5) return c;
  }
  return null;
}

/** The option used least: first by the group's packs, then by every pack, then in the list's own order. Never none. */
function leastUsed(options, keyOf, mine, all) {
  const count = (list, k) => list.filter((p) => keyOf(p) === k).length;
  return options
    .map((o, i) => ({ o, i, k: typeof o === 'string' ? o : `${o.template}/${o.variant}` }))
    .sort((a, b) => count(mine, a.k) - count(mine, b.k) || count(all, a.k) - count(all, b.k) || a.i - b.i)[0].o;
}

/**
 * A look for a new account: a template and variant and a display face the group (the customer's workspace, or the
 * operator's own accounts: `groupOf`, `group`) does not use, else the least used, and a hue far from the group's
 * accents (from every account's when the group has none yet). Never throws for a pool used up.
 */
export function newTheme(existing, { groupOf = () => 'all', group = 'all' } = {}) {
  const mine = existing.filter((p) => groupOf(p) === group);
  const look = leastUsed(ALL_LOOKS, (p) => `${p.theme.template}/${p.theme.variant || 'a'}`, mine, existing);
  const display = leastUsed(DISPLAY_FACES.filter((f) => FONTS[f]), (p) => p.theme.fonts?.display, mine, existing);
  const near = mine.length ? mine : existing;
  let best = null;
  for (let hue = 0; hue < 360; hue += 15) {
    for (const dark of [false, true]) {
      const c = paletteFor(hue, { dark });
      if (!c) continue;
      const d = Math.min(Infinity, ...near.map((p) => Math.max(deltaE(c.bg, p.theme.colors.bg), deltaE(c.accent, p.theme.colors.accent) * 0.9)));
      if (!best || d > best.d) best = { d, c };
    }
  }
  return { template: look.template, variant: look.variant, colors: best.c, fonts: { display, text: display === 'Assistant' ? 'Heebo' : 'Assistant' }, options: { radius: 24, coverPhoto: false } };
}

const STARTER_FORMATS = [
  { id: 'explainer', name: 'איך זה עובד', about: 'One thing explained in a few steps, a fact per slide, from an approved source.', weight: 3, items: [3, 5], hooks: ['ככה {x} עובד באמת', '{n} דברים על {x} שרוב האנשים מפספסים'], closers: [{ title: 'תשמרו את זה לפעם הבאה', body: 'ותשלחו למי שזה נוגע לו' }] },
  { id: 'n-facts', name: 'עובדות קצרות', about: 'A few short, specific facts about one subject, one per slide.', weight: 2, items: [3, 5], hooks: ['{n} דברים שלא ידעתם על {x}'], closers: [{ title: 'איזה מהם הפתיע אתכם?', body: 'תשמרו את הרשימה' }] },
  { id: 'whats-new', name: 'מה חדש', about: 'What changed recently, dated, a change per slide, from the source that announced it.', weight: 1, trial: true, items: [3, 4], hooks: ['מה השתנה ב{x} לאחרונה'], closers: [{ title: 'תשמרו ותבדקו אם זה נוגע לכם', body: 'העדכונים מגיעים לאט, לא לכולם באותו יום' }] },
];

function voiceTemplate(seed, displayName) {
  return `# הקול של "${displayName}"

## מי מדבר

חשבון שמסביר ${seed.niche} בעברית פשוטה, ל${seed.audience || 'מי שרוצה להבין בלי להיות מומחה'}. הוא קורא את המקורות הרשמיים ומתרגם אותם לשפה של אדם עסוק. הוא לא מספר על עצמו, לא כותב "ניסיתי" ולא "אצלי", ולא ממליץ על מוצרים. כל עובדה באה ממקור מאושר, והמקור כתוב בתחתית השקף.

## למי

${seed.audience || 'קהל ישראלי רחב'}.

## איך זה נשמע

- עברית מדוברת ונכונה, כמו שמסבירים לחבר. פונים ברבים ("תבדקו", "תשמרו"), או בלי נושא בכלל ("נכנסים, בוחרים, שומרים").
- מספר מדויק כשיש מספר במקור, ובלי מספרים כשאין.
- משפט ארוך ליד משפט קצר. לא שלושה משפטים קטועים ברצף, לא כותרת עם נקודתיים, לא "זה לא X, זה Y" ולא "בלי X ובלי Y".
- לא שמים סימני קריאה, לא כותבים הייפ, ולא פותחים ב"חשוב לציין" או ב"בנוסף".

## שורות טובות

- דבר אחד בכל שקף, עם המספר מהמקור.
- משפט קצר שאומר מה עושים, ואז למה.
- שאלה בסוף הכיתוב שמישהו באמת יכול לענות עליה.

## שורות רעות

- חשוב לציין שזה פשוט מדהים!
- ניסיתי את זה בעצמי וזה שינה לי את החיים
- בנוסף, ניתן לבצע זאת על מנת לשפר את התוצאות.
- מהיר. פשוט. משתלם.
- זה לא עוד טיפ, זה שינוי של כל הגישה.
`;
}

const VOICE_SCHEMA = { type: 'object', properties: { voice: { type: 'string' } }, required: ['voice'], additionalProperties: false };

/**
 * Write a new pack. Returns { id, dir }. Throws with every problem if it would not validate. `workspaceId` is the
 * customer's (null for the operator's own account): its look is kept apart from that workspace's other accounts.
 */
export async function createPack(ctx, { seed, candidates, displayName, handle, examplesFromOwner = [], workspaceId = null }) {
  const id = packIdOf(handle);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error('the handle must be latin letters and digits, so the pack id can be made from it');
  const dir = path.join(packsDir(), id);
  if (existsSync(dir)) throw new Error(`a pack named ${id} already exists`);
  const approved = candidates.filter((c) => c.approved);
  if (!approved.length) throw new Error('approve at least one source first');
  const about = [seed.niche, seed.audience, ...(seed.topics || [])].join(' ');
  const groups = ctx.db ? lookGroups(ctx.db) : () => 'all';
  const group = ctx.db ? (workspaceId != null ? `ws:${workspaceId}` : 'own') : 'all';
  const theme = newTheme(ctx.packs, { groupOf: groups, group });
  const words = String(seed.niche).split(/\s+/).filter((w) => w.length > 1);
  const pack = {
    id,
    displayName: String(displayName).trim(),
    handle: id.replace(/-/g, '.'),
    language: 'he',
    description: `${seed.niche}, for ${seed.audience || 'a Hebrew audience'}. Created from an onboarding.`,
    topics: [seed.niche, ...(seed.topics || [])].filter(Boolean),
    audience: seed.audience || '',
    platforms: ['tiktok', 'instagram', 'facebook'],
    // Through Zernio, to the accounts the customer connects (src/publish/connect.js): TikTok to its drafts, Instagram
    // as a carousel, a Facebook Page as a post of Instagram's slides (optional: posts go without a Page connected).
    // Nothing leaves before PUBLISH_MODE=live and a connected account.
    publishers: { tiktok: 'zernio', instagram: 'zernio', facebook: 'zernio' },
    zernio: { tiktokMode: 'draft-now', tiktokPrivacy: 'SELF_ONLY' },
    // The new account's days and times (src/schedule/choice.js DEFAULT_CHOICE, about 51 slots a month, so the plan's 40
    // are reached even in a month of festivals). The owner changes them on Settings, and the choice is laid over this.
    schedule: { postsPerDay: 2, windows: [[12, 14], [19, 22]], slots: ['12:30', '19:30'], slotsByDay: { 5: ['12:30'], 6: ['21:00'] } },
    autonomy: { mode: 'approve' },
    compliance: FINANCIAL.test(about) ? ['il-investment-advice'] : [],
    // The owner's own photographs (<pack>/photos) first, then the libraries; Openverse last, for the people and places
    // the stock libraries do not have.
    imagery: { providers: ['pack', 'pexels', 'unsplash', 'commons', 'openverse'] },
  };
  // The slide style (src/render/styles), from what the account is about and its colours, away from a look-alike; and
  // never one the workspace's other accounts already have in an accent this close (validateAll would refuse it).
  const ranked = suggestStyle({ ...seed, displayName: pack.displayName }, theme.colors, ctx.packs).ranked;
  const kin = ctx.packs.filter((p) => groups(p) === group && p.meta?.style?.name);
  const clashes = (name) => kin.some((p) => p.meta.style.name === name && deltaE(resolveStyle({ name }, theme.colors.accent).colors.accent, resolveStyle(p.meta.style, p.theme?.colors?.accent).colors.accent) < 20);
  pack.style = { name: ranked.find((n) => !clashes(n)) || ranked[0] };
  const sources = {
    sources: approved.map((c, i) => ({
      id: `${c.type}-${i + 1}-${(() => {
        try {
          return new URL(c.url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
        } catch {
          return 'source';
        }
      })()}`.slice(0, 60),
      type: c.type,
      url: c.url,
      name: c.name,
      lang: /[֐-׿]/.test(c.name) ? 'he' : 'en',
      why: c.why || c.score?.reason || 'approved by the owner in onboarding',
      approvedAt: new Date().toISOString().slice(0, 10),
      ...(c.api ? { api: c.api } : {}),
    })),
  };
  const formats = {
    formats: STARTER_FORMATS,
    caption: { questions: ['מה עוד הייתם רוצים לדעת על זה?', 'זה נוגע לכם?', 'על מה תרצו פירוק כזה?'] },
    hashtags: { broad: ['#טיפים', '#ישראל'], niche: [...words.map((w) => `#${w.replace(/[^\p{L}\p{N}_]/gu, '')}`).filter((t) => t.length > 2).slice(0, 3), '#מידע'] },
    trends: { queries: { he: [`טיפים ${seed.niche}`], en: [`${seed.nicheEn || seed.niche} tips`] }, minViews: { he: 1000, en: 20000 } },
  };
  const rules = { maxQuoteWords: 40, bannedPhrases: [], patterns: [], imageQueryBlock: ['logo', 'brand'] };

  let voice = voiceTemplate(seed, pack.displayName);
  if (ctx.llm?.kind === 'claude') {
    try {
      const { data } = await askJson(ctx, {
        task: 'voice', role: 'draft', effort: 'medium', maxTokens: 8000, expectOut: 2000, tag: 'onboarding', schema: VOICE_SCHEMA,
        system: `You write the voice guide for a Hebrew social account, in Hebrew, in Markdown, with exactly these sections: "## מי מדבר", "## למי", "## איך זה נשמע", "## שורות טובות" (at least 4 example lines as "- ..."), "## שורות רעות" (at least 4). The account never claims personal experience, never recommends products, addresses the audience in the plural, uses no exclamation marks. The guide is written the way a person talks, and its good lines are what a person who knows the niche would say out loud to a friend: specific (a number, a name, a place), with an uneven rhythm, in everyday words. The engine writes every post by these rules, so the good lines must keep them too:
${HEBREW}
The bad lines show what the account never sounds like: a few of the NEVER list above, and the niche's own clichés. Return { voice }.`,
        user: `Account: ${pack.displayName}. Niche: ${seed.niche}. Audience: ${seed.audience}. Example accounts the owner likes (for register only): ${examplesFromOwner.join(', ') || 'none'}.`,
      });
      if (data.voice?.length > 300) voice = data.voice;
    } catch {
      /* the template stands */
    }
  }

  // Validate before writing anything: the same checks every pack passes.
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries({ pack, theme, sources, formats, rules })) writeFileSync(path.join(dir, `${k}.json`), `${JSON.stringify(v, null, 2)}\n`);
  writeFileSync(path.join(dir, 'voice.md'), voice);
  const problems = [];
  try {
    const p = loadPack(dir);
    problems.push(...validateAll([...ctx.packs, p], { groupOf: (x) => (x === p ? group : groups(x)) }));
  } catch (e) {
    problems.push(...(e.problems?.length ? e.problems : [e.message]));
  }
  if (problems.length) {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    throw Object.assign(new Error('the new pack would not be valid'), { problems });
  }
  return { id, dir, pack: readPack(dir) };
}
