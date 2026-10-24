import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packsDir } from '../core/paths.js';
import { contrast, deltaE, bestInk } from '../render/color.js';
import { FONTS } from '../render/fonts.js';
import { ALL_LOOKS } from '../render/templates/registry.js';
import { FINANCIAL } from '../rules/compliance.js';
import { askJson } from '../llm/index.js';
import { HEBREW } from '../pipeline/prompts.js';
import { loadPack, readPack } from '../packs/load.js';
import { validateAll } from '../packs/validate.js';
import { suggestStyle } from './style.js';

// A new pack, written from an onboarding: the owner's seed, the sources they
// approved, and a look no other account has. No code: the result is the same
// six files a hand-written pack has, and it is validated like one before it is
// written.

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

/** A look nobody uses: a free template and variant, a free display face, a hue far from every accent. */
export function newTheme(existing) {
  const used = new Set(existing.map((p) => `${p.theme.template}/${p.theme.variant || 'a'}`));
  const look = ALL_LOOKS.find((l) => !used.has(`${l.template}/${l.variant}`));
  if (!look) throw new Error('every template and variant is in use: one more template file in src/render/templates is needed');
  const usedFonts = new Set(existing.map((p) => p.theme.fonts?.display));
  const display = ['Secular One', 'Rubik', 'Heebo', 'Suez One', 'Frank Ruhl Libre', 'Karantina', 'IBM Plex Sans Hebrew', 'Varela Round'].find((f) => FONTS[f] && !usedFonts.has(f));
  if (!display) throw new Error('every display face is in use: add a font to src/render/fonts.js');
  let best = null;
  for (let hue = 0; hue < 360; hue += 15) {
    for (const dark of [false, true]) {
      const c = paletteFor(hue, { dark });
      if (!c) continue;
      const d = Math.min(Infinity, ...existing.map((p) => Math.max(deltaE(c.bg, p.theme.colors.bg), deltaE(c.accent, p.theme.colors.accent) * 0.9)));
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

/** Write a new pack. Returns { id, dir }. Throws with every problem if it would not validate. */
export async function createPack(ctx, { seed, candidates, displayName, handle, examplesFromOwner = [] }) {
  const id = String(handle || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new Error('the handle must be latin letters and digits, so the pack id can be made from it');
  const dir = path.join(packsDir(), id);
  if (existsSync(dir)) throw new Error(`a pack named ${id} already exists`);
  const approved = candidates.filter((c) => c.approved);
  if (!approved.length) throw new Error('approve at least one source first');
  const about = [seed.niche, seed.audience, ...(seed.topics || [])].join(' ');
  const theme = newTheme(ctx.packs);
  const words = String(seed.niche).split(/\s+/).filter((w) => w.length > 1);
  const pack = {
    id,
    displayName: String(displayName).trim(),
    handle: id.replace(/-/g, '.'),
    language: 'he',
    description: `${seed.niche}, for ${seed.audience || 'a Hebrew audience'}. Created from an onboarding.`,
    topics: [seed.niche, ...(seed.topics || [])].filter(Boolean),
    audience: seed.audience || '',
    platforms: ['tiktok', 'instagram'],
    // Through Zernio, to the accounts the customer connects (src/publish/connect.js): TikTok to its drafts, Instagram
    // through our own Meta app when it is set up for the account, else Zernio. Nothing leaves before PUBLISH_MODE=live
    // and a connected account.
    publishers: { tiktok: 'zernio', instagram: 'auto' },
    zernio: { tiktokMode: 'draft-now', tiktokPrivacy: 'SELF_ONLY' },
    schedule: { postsPerDay: 1, windows: [[12, 14], [19, 22]], slots: ['19:30'], slotsByDay: { 5: ['12:30'], 6: ['21:00'] } },
    autonomy: { mode: 'approve' },
    compliance: FINANCIAL.test(about) ? ['il-investment-advice'] : [],
    imagery: { providers: ['pexels', 'unsplash', 'commons'] },
  };
  // The slide style (src/render/styles), from what the account is about and its colours, away from a look-alike.
  pack.style = { name: suggestStyle({ ...seed, displayName: pack.displayName }, theme.colors, ctx.packs).name };
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
    problems.push(...validateAll([...ctx.packs, p]));
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
