import { deltaE, isHex, luminance } from '../render/color.js';
import { resolveStyle } from '../render/styles/tokens.js';

// Which slide style a new account is offered (src/render/styles): from what the account is about and from its
// brand's colours, and away from a customer in the same niche who already looks the same.
//
//   E  native           everything people watch for fun: sports, combat sports, culture, AI and life tips,
//                       lifestyle, food, shops, stories; and the default
//   A  editorial card   prices, data, comparisons: finance, real estate, travel, tech and startups, B2B, products
//   B  poster           entertainment and energy: sports, combat sports, gaming, fitness, events, youth brands
//   C  split (light)    light, clean brands: fashion, beauty, food, home, wellness, shops, kids
//   D  native dark      stories and history: news, history, culture, "did you know" pages
//
// E comes first wherever the account entertains, since that is what the viral slideshows in those niches look like
// (src/render/styles/tokens.js): it scores every word that points at B, C or D, and its own (tips, lifestyle, AI). A
// stays first for an account about money and data, where a number on a card is the point. B, C and D are each
// still the next best for their own niche: the one a style test runs against E, and the one a second account in the
// niche gets when the first already looks like E in a close colour.
//
// A brand with a light palette leans to C; a strongly dark one never gets C. When another account in the same
// niche already has the style and an accent close to this one's, this one gets its next-best style, so two
// customers never look alike. The owner can change it at any time (Accounts).

const NICHES = {
  A: ['כסף', 'פיננס', 'השקע', 'מניות', 'בורסה', 'נדל"ן', 'נדלן', 'דירה', 'דירות', 'משכנתא', 'ביטוח', 'מחיר', 'השוואה', 'נתונים', 'טיסות', 'תיירות', 'טיול', 'נסיעות', 'מלונות', 'טכנולוגיה', 'סטארטאפ', 'הייטק', 'מוצר', 'גאדג', 'קריפטו', 'עסקים', 'יזמ',
    'finance', 'money', 'invest', 'stock', 'real estate', 'mortgage', 'insurance', 'price', 'compare', 'data', 'travel', 'flight', 'hotel', 'tech', 'startup', 'founder', 'saas', 'b2b', 'product', 'gadget', 'crypto', 'developer', 'builders'],
  B: ['ספורט', 'כדורגל', 'כדורסל', 'טניס', 'אגרוף', 'קרב', 'לחימה', 'גיימינג', 'משחקי', 'כושר', 'אימון', 'ריצה', 'אירועים', 'מסיב', 'הופעות', 'פסטיבל', 'נוער',
    'sport', 'football', 'soccer', 'basketball', 'nba', 'tennis', 'mma', 'ufc', 'boxing', 'fight', 'gaming', 'esports', 'fitness', 'gym', 'workout', 'running', 'events', 'party', 'festival', 'youth'],
  C: ['אופנה', 'יופי', 'איפור', 'טיפוח', 'אוכל', 'מתכונ', 'בישול', 'אפייה', 'מסעד', 'בית', 'עיצוב', 'בריאות', 'יוגה', 'תזונה', 'חנות', 'קמעונ', 'ילדים', 'הורות', 'תינוק',
    'fashion', 'beauty', 'makeup', 'skincare', 'food', 'recipe', 'cooking', 'baking', 'restaurant', 'home', 'interior', 'decor', 'wellness', 'yoga', 'nutrition', 'shop', 'store', 'retail', 'kids', 'parenting', 'baby'],
  D: ['חדשות', 'היסטוריה', 'תרבות', 'הידעת', 'עובדות', 'סיפור', 'סיפורים', 'מסתורין', 'ארכיאולוג',
    'news', 'history', 'culture', 'did you know', 'facts', 'story', 'stories', 'mystery', 'archaeology'],
  // E's own: what is not B's, C's or D's and still entertains. Every word of B, C and D counts for E as well (styleScores).
  E: ['טיפים', 'טריקים', 'בינה מלאכותית', 'צ\'אט', 'לייפסטייל', 'סגנון חיים', 'סלבס', 'סלבריטאים', 'רכילות', 'מוזיקה', 'קולנוע', 'סרטים', 'סדרות', 'טלוויזיה', 'הומור', 'בידור', 'רכב', 'מכוניות', 'חיות', 'כלבים',
    'ai', 'chatgpt', 'claude', 'tips', 'hacks', 'lifestyle', 'celebrity', 'celebs', 'gossip', 'music', 'movies', 'film', 'series', 'tv', 'humor', 'memes', 'entertainment', 'cars', 'pets'],
};

// Ties go to the style that suits the most accounts: E first, the default.
const ORDER = ['E', 'D', 'A', 'B', 'C'];

// Why, in the words the Accounts page shows.
const FITS = {
  A: 'החשבון עוסק במחירים, נתונים והשוואות',
  B: 'החשבון עוסק בספורט, באנרגיה ובאירועים',
  C: 'החשבון עוסק באופנה, אוכל, בית או ילדים',
  D: 'החשבון מספר סיפורים, היסטוריה ותרבות',
  E: 'החשבון בתחום שגוללים בו להנאה, ושם הכי עובדים שקפים שנראים כאילו נעשו בטיקטוק עצמו',
};

/** How strongly an account's words point at each niche: { A, B, C, D, E }, E by its own words only. */
export function nicheScores(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const out = {};
  for (const [s, words] of Object.entries(NICHES)) out[s] = words.filter((w) => (/^[a-z ]+$/.test(w) ? new RegExp(`\\b${w}`).test(t) : t.includes(w))).length;
  return out;
}

/** How strongly an account's words point at each style: the niches', with E scoring the entertaining ones (B, C, D) too. */
export function styleScores(text) {
  const sc = nicheScores(text);
  return { ...sc, E: sc.E + sc.B + sc.C + sc.D };
}

/** Light, dark or neither, from the brand's ground. */
export function brandTone(colors = {}) {
  if (!isHex(colors.bg)) return 'neutral';
  const l = luminance(colors.bg);
  return l > 0.6 ? 'light' : l < 0.02 ? 'dark' : 'neutral';
}

const aboutOf = (x) => [x.niche, x.audience, ...(x.topics || []), x.description, x.displayName].filter(Boolean).join(' ');

/** The niche an account belongs to, for the spread: the style its words point at most, or none. */
const nicheOf = (text) => {
  const sc = nicheScores(text);
  const best = ORDER.slice().sort((a, b) => sc[b] - sc[a])[0];
  return sc[best] ? best : null;
};

/**
 * The style to offer an account: { name, ranked, why }. `about`: { niche, audience, topics, description,
 * displayName }; `colors`: its brand's (theme.json colors); `existing`: the other packs.
 */
export function suggestStyle(about, colors = {}, existing = []) {
  const text = aboutOf(about);
  const sc = styleScores(text);
  const tone = brandTone(colors);
  const why = [];
  const score = { ...sc };
  // A light brand moves C up, to just behind E: the native look is drawn on the photograph whatever the brand's ground.
  if (tone === 'light') {
    score.C = Math.max(score.C, Math.min(score.C + 2, score.E));
    why.push('המותג בהיר, אז הסגנון הבהיר הוא הבא בתור');
  }
  let ranked = ORDER.slice().sort((a, b) => score[b] - score[a] || ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!Object.values(score).some(Boolean)) ranked = ORDER.slice();
  if (tone === 'dark') {
    ranked = [...ranked.filter((s) => s !== 'C'), 'C'];
    why.push('המותג כהה מאוד, אז הסגנון הבהיר לא מוצע לו');
  }
  const top = ranked[0];
  why.unshift(sc[top] ? FITS[top] : 'אין סימן לכיוון אחר, אז ברירת המחדל');
  // The spread: a customer in the same niche with the same style and an accent this close already looks like this.
  const niche = nicheOf(text);
  const looksLike = (name) =>
    existing.some((p) => p.meta?.style?.name === name && niche && nicheOf(aboutOf({ ...p.meta, niche: (p.meta.topics || []).join(' ') })) === niche && deltaE(resolveStyle({ name }, colors.accent).colors.accent, resolveStyle(p.meta.style, p.theme?.colors?.accent).colors.accent) < 20);
  const free = ranked.filter((s) => !looksLike(s));
  const name = free[0] || ranked[0];
  if (name !== top) why.push(`לחשבון אחר באותו תחום כבר יש את סגנון ${top} בצבע קרוב, אז החשבון הזה מקבל את הבא בתור`);
  return { name, ranked: [name, ...ranked.filter((s) => s !== name)], why };
}
