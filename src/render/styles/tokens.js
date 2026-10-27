import { bestInk, contrast, isHex, luminance } from '../color.js';

// The five slide styles an account can be drawn in, and what each one sets: its colours, its faces, and every text
// the writer writes as the style sets it (size, line height, how many lines, the smallest size it may be shrunk to).
//
// A style keeps the post as it is (its slides, their order, which slide carries a card or a graphic) and replaces
// the typography, how the text is treated and the chrome around it. One account, one style: every post of it is
// drawn in the same one (src/render/style.js locks it).
//
//   A  editorial card   dark, data-friendly: a photograph above, the facts on one card with a giant number
//   B  poster           bold, high-energy: a condensed face set huge, a highlight block, a framed photograph
//   C  split            light and clean: the photograph on top, the text on a light panel under it, never on it
//   D  native dark      the account's old layout in a new type: a photograph fading into a dark ground
//   E  native           a slideshow made in TikTok's own app: the slide's own photograph, sharp, over the whole
//                       screen, a line or two in the middle of it, each line on a white box (text "box", the default)
//                       or white with a thin dark edge (text "shadow"), as TikTok's own text tool draws them
//
// E is what 20 of 25 viral TikTok slideshows we benchmarked look like (football, MMA, tips, shops): one real
// photograph a slide, never blurred, TikTok's own text over it, 5 to 15 words a slide, and nothing else: no counter,
// no handle, no logo, no graphic on a slide that has a photograph. Its sizes are the text tool's, not a poster's: the
// line is read over the picture, not instead of it.
//
// Every size is in px at TikTok's 1080x1920. Instagram's 4:5 (1080x1350) is the same design: every height and
// position x0.7, the headlines x0.85, its own safe zones (src/rules/overlay.js).
//
// What a style draws that is not the post's own checked text is a fixed label of the post's structure ("מקום 3",
// "רמז 2 מתוך 3") on C's and D's chips, a ranking's place before E's title ("5."), style C's key line at a cover's
// foot, and style B's swipe cue. No style sets a label at the top of the screen, over the headline: an eyebrow reads
// as a machine-made post.
//
// `mark`: the room a highlight takes beside its words, on each side, at the text's size (its padding and margin,
// 0.16 of the letter size): the check measures a line with a highlight on that much less.
// `inset`: the room a text has less than the slide's width: A's card's padding and border, E's box's padding, which
// is in every line, on both sides (.3em at the text's full size).
// `inline` (E): a text's words are one inline run, so a box is drawn behind each of its lines, as TikTok draws it.
// `rank` (E): a ranking's place is set before its title, in the title's own line; the check measures it there.

const T = (family, weight, px, lh, more = {}) => ({ family, weight, px, lh, ...more });

export const STYLES = {
  A: {
    name: 'A',
    he: 'כרטיס',
    about: 'editorial card: dark and data-friendly; a photograph above, the number on a card',
    dark: true,
    tokens: { bg: '#0E1513', text: '#FFFFFF', muted: '#B7C4BF', card: '#17211E', cardBorder: '#26332F', accent: '#5FE0B5' },
    text: {
      hook: T('Heebo', 900, 108, 1.04, { lines: 3, floor: 88, tracking: -1, breaks: true }),
      sub: T('Assistant', 700, 48, 1.3, { lines: 2 }),
      title: T('Heebo', 900, 80, 1.05, { lines: 2, floor: 64, tracking: -1, breaks: true }),
      ntitle: T('Heebo', 900, 80, 1.05, { lines: 2, floor: 64, tracking: -1, breaks: true }),
      // The card's line: the card is the text's width less its padding (52) and border (2) on both sides.
      body: T('Assistant', 400, 36, 1.45, { lines: 3, inset: 108 }),
      tbody: T('Assistant', 400, 40, 1.45, { lines: 2 }),
      number: T('Heebo', 900, 160, 1),
      label: T('Assistant', 700, 30, 1.2),
    },
  },
  B: {
    name: 'B',
    he: 'פוסטר',
    about: 'poster: bold and high-energy; a condensed face set huge, the key words on a block of colour',
    dark: true,
    tokens: { bg: '#111111', text: '#FFFFFF', muted: '#D8D4C8', accent: '#FFC24D' },
    text: {
      // One phrase a line: the style breaks the line itself, so the writer's breaks are not kept.
      hook: T('Karantina Headline', 700, 264, 0.86, { lines: 3, floor: 200, breaks: false, mark: 42 }),
      sub: T('Rubik', 600, 52, 1.3, { lines: 3 }),
      title: T('Karantina Headline', 700, 180, 0.9, { lines: 2, floor: 140, breaks: false, mark: 29 }),
      // On a number slide the giant number is the headline and the slide's title is the caption under it.
      ntitle: T('Rubik', 800, 60, 1.2, { lines: 2, floor: 52, breaks: false }),
      body: T('Rubik', 400, 40, 1.45, { lines: 4 }),
      tbody: T('Rubik', 400, 40, 1.45, { lines: 4 }),
      number: T('Karantina', 700, 400, 0.8),
      label: T('Rubik', 600, 28, 1.2),
    },
  },
  C: {
    name: 'C',
    he: 'מפוצל',
    about: 'split: light and clean; the photograph on top, the text on a light panel, never on the photograph',
    dark: false,
    tokens: { panel: '#F3EFE6', text: '#141414', muted: '#4A463F', accent: '#2F6BFF' },
    text: {
      hook: T('Rubik', 900, 108, 1.04, { lines: 3, floor: 88, breaks: true }),
      sub: T('Rubik', 500, 44, 1.35, { lines: 3 }),
      title: T('Rubik', 900, 88, 1.08, { lines: 2, floor: 72, breaks: true }),
      ntitle: T('Rubik', 900, 88, 1.08, { lines: 2, floor: 72, breaks: true }),
      body: T('Rubik', 400, 42, 1.5, { lines: 4 }),
      tbody: T('Rubik', 400, 42, 1.5, { lines: 4 }),
      number: T('Rubik', 900, 132, 1),
      label: T('Rubik', 900, 60, 1.2),
    },
  },
  D: {
    name: 'D',
    he: 'כהה',
    about: 'native dark: a photograph fading into a dark ground, a condensed headline, a number in the accent',
    dark: true,
    tokens: { bg: '#0B1416', text: '#FFFFFF', muted: '#C7D3D6', accent: '#5FE0B5' },
    text: {
      hook: T('Karantina Headline', 700, 156, 0.9, { lines: 3, floor: 120, breaks: true, mark: 25 }),
      sub: T('Rubik', 500, 34, 1.4, { lines: 3 }),
      title: T('Karantina Headline', 700, 132, 0.92, { lines: 2, floor: 100, breaks: true, mark: 21 }),
      ntitle: T('Karantina Headline', 700, 132, 0.92, { lines: 2, floor: 100, breaks: true, mark: 21 }),
      body: T('Rubik', 400, 32, 1.5, { lines: 3 }),
      tbody: T('Rubik', 400, 32, 1.5, { lines: 3 }),
      number: T('Karantina', 700, 208, 0.9),
      label: T('Rubik', 800, 26, 1.2),
    },
  },
  E: {
    name: 'E',
    he: 'נייטיב',
    about: "native: like a slideshow made in TikTok's own app; the photograph sharp over the whole slide, a line or two on white boxes or in white with a thin shadow",
    dark: true,
    inline: true,
    rank: true,
    // `bg`: the ground of a slide with no photograph of its own. `accent`: a highlight, a highlighter's yellow behind
    // the words on a white box, or the words themselves in yellow in white text. The box is white and its text
    // near-black whatever the account's colours (`box`, `ink`): that is TikTok's own, and what reads as native.
    tokens: { bg: '#121212', text: '#FFFFFF', muted: '#D6D6D6', accent: '#FFD43B', box: '#FFFFFF', ink: '#111111' },
    text: {
      // Heebo, the face closest to the app's own Hebrew (a plain, bold grotesque), never a display face.
      hook: T('Heebo', 800, 92, 1.24, { lines: 3, floor: 76, breaks: true, inset: 56, mark: 8 }),
      sub: T('Heebo', 700, 40, 1.3, { lines: 2, inset: 24 }),
      title: T('Heebo', 800, 68, 1.24, { lines: 2, floor: 56, breaks: true, inset: 42, mark: 6 }),
      ntitle: T('Heebo', 800, 68, 1.24, { lines: 2, floor: 56, breaks: true, inset: 42, mark: 6 }),
      body: T('Heebo', 700, 40, 1.3, { lines: 2, inset: 24 }),
      tbody: T('Heebo', 700, 40, 1.3, { lines: 2, inset: 24 }),
      number: T('Heebo', 900, 112, 1),
      label: T('Heebo', 400, 22, 1.2),
    },
  },
};

/** E's two ways of drawing its text (pack.json style.text): TikTok's white box, the default, or its white text with a thin dark edge. */
export const TEXT_LOOKS = ['box', 'shadow'];

export const STYLE_NAMES = Object.keys(STYLES);
export const isStyle = (name) => Object.prototype.hasOwnProperty.call(STYLES, name);

/** Every face a style sets text in, by family and weight: what the width tables are measured for (metrics.json). */
export const FACES = [...new Map(Object.values(STYLES).flatMap((s) => Object.values(s.text)).map((t) => [`${t.family} ${t.weight}`, { family: t.family, weight: t.weight }])).values()];

/** The bundled families a style's pages load (fonts.js): Karantina's headline face is its composite with Rubik's digits. */
export const familiesOf = (name) => [...new Set(Object.values(STYLES[name].text).map((t) => t.family.replace(/ Headline$/, '')).concat(['Rubik']))];

// Text set over the ground is large (28 px bold and up), so the accent needs 3:1 against the ground, as WCAG asks of
// large text, and the ink on a highlight block 3:1 against the accent.
const LARGE = 3;

/**
 * One account's style, resolved: { name, colors, notes }. `spec` is pack.json "style" ({ name, accent, bg, panel }),
 * `brand` the account's own colour (theme.json colors.accent). The accent is the pack's own token when it sets one,
 * else the brand's, else the style's; one that would not read on the style's ground is given up for the next, and
 * the notes say so.
 */
export function resolveStyle(spec, brand = null) {
  const s = STYLES[spec?.name] || STYLES.D;
  const t = s.tokens;
  const notes = [];
  if (spec?.text && s.name !== 'E') notes.push(`text is not used by style ${s.name}: only E draws its text two ways`);
  const ground = s.dark ? (isHex(spec?.bg) ? spec.bg : t.bg) : isHex(spec?.panel) ? spec.panel : t.panel;
  if (spec?.bg && !s.dark) notes.push('bg is not used by style C: it sets panel');
  if (spec?.panel && s.dark) notes.push(`panel is not used by style ${s.name}: it sets bg`);
  const reads = (c) => isHex(c) && contrast(c, ground) >= LARGE;
  let accent = t.accent;
  for (const [c, from] of [[spec?.accent, 'the pack\'s accent'], [brand, 'the brand colour']]) {
    if (!isHex(c)) continue;
    if (reads(c)) {
      accent = c;
      break;
    }
    notes.push(`${from} ${c} does not read on style ${s.name}'s ground (${contrast(c, ground).toFixed(1)}:1, needs ${LARGE}:1): ${accent === t.accent ? 'the style\'s own accent is used' : 'the next one is used'}`);
  }
  // The text on a highlight block or a chip: the ground's colour, as the styles ask, unless it does not read there.
  // E's highlight and its number's box sit on a photograph or a white box, not on its ground: their text is whichever
  // of the box's ink and white reads better on the accent.
  const onAccent = s.name === 'E' ? bestInk(accent, t.ink, '#FFFFFF') : contrast(ground, accent) >= LARGE ? ground : bestInk(accent, t.text, ground);
  const colors = {
    bg: ground,
    text: t.text,
    muted: t.muted,
    accent,
    onAccent,
    card: t.card || null,
    cardBorder: t.cardBorder || null,
  };
  // E's text look rides with it, and only with it: another style's look is hashed as it always was (style.js), so no
  // account drawn in A to D finds its saved look changed under it.
  return { name: s.name, colors, notes, ...(s.name === 'E' ? { text: TEXT_LOOKS.includes(spec?.text) ? spec.text : 'box' } : {}) };
}

/** The colours a resolved style hands the shared graphics (src/render/visuals.js), which read the theme's variables. */
export function themeColors(r) {
  const c = r.colors;
  const dark = luminance(c.bg) < 0.2;
  return {
    bg: c.bg,
    surface: c.card || (dark ? '#1A2224' : '#FFFFFF'),
    ink: c.text,
    muted: c.muted,
    accent: c.accent,
    accent2: c.muted,
    onAccent: c.onAccent,
  };
}

/** What is wrong with a pack.json "style", one line each. */
export function styleConfigProblems(spec) {
  if (spec === undefined) return [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['pack.json: style must be an object { name, accent, bg, panel, text }'];
  const p = [];
  if (!isStyle(spec.name)) p.push(`pack.json: style.name must be one of ${STYLE_NAMES.join(', ')}`);
  for (const k of ['accent', 'bg', 'panel']) if (spec[k] !== undefined && !isHex(spec[k])) p.push(`pack.json: style.${k} must be a hex colour`);
  if (spec.test !== undefined && typeof spec.test !== 'boolean') p.push('pack.json: style.test is true or false');
  // Allowed beside any style, since it stays in pack.json when the owner switches away from E and back; only E reads it.
  if (spec.text !== undefined && !TEXT_LOOKS.includes(spec.text)) p.push(`pack.json: style.text is ${TEXT_LOOKS.map((x) => `"${x}"`).join(' or ')} (style E's text on white boxes, or white with a thin shadow)`);
  if (isStyle(spec.name)) {
    const s = STYLES[spec.name];
    const ground = s.dark ? spec.bg || s.tokens.bg : spec.panel || s.tokens.panel;
    if (isHex(ground) && contrast(s.tokens.text, ground) < 7) p.push(`pack.json: style ${s.name}'s text on ${s.dark ? 'bg' : 'panel'} ${ground} is ${contrast(s.tokens.text, ground).toFixed(2)}:1, needs 7:1`);
    if (isHex(ground) && contrast(s.tokens.muted, ground) < 4.5) p.push(`pack.json: style ${s.name}'s muted text on ${ground} is ${contrast(s.tokens.muted, ground).toFixed(2)}:1, needs 4.5:1`);
  }
  for (const k of Object.keys(spec)) if (!['name', 'accent', 'bg', 'panel', 'test', 'text'].includes(k)) p.push(`pack.json: style.${k} is not a style setting (name, accent, bg, panel, test, text)`);
  return p;
}
