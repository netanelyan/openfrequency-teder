// Art direction: one model call between the slides and the photographs, that reads the whole slideshow and says what
// each photograph shows (the owner, 2026-11-08, on an Airbnb post that opened on its founder's headshot and showed the
// founders again on two slides: "an image of the owner is not it", and "involve AI in setting up the page and creating
// slideshows, even if it X3 the cost of a slideshow"). The writer gives each slide a search as it writes its line; the
// art director sees them all at once and the story's subject, and gives each slide the picture that says its line:
// the thing, the place, the moment, a face only for a slide about that person. Its searches replace the writer's, and
// what each picture must show goes with the check that compares the picture with the slide (findPhotos).
//
// Only a live model directs (a recorded or scripted run keeps the writer's searches), and only a post that stands on
// photographs. A guess-who's answer and a head-to-head's two sides are faces by design, and stay as the outline has them.

import { askJson } from '../llm/index.js';
import { kindName } from '../formats/kinds.js';

/** The subjects a photograph shows by face. Anything else is shown by itself. */
export const FACE_KINDS = new Set(['person', 'team']);
export const SUBJECT_KINDS = ['person', 'team', 'company', 'product', 'place', 'thing', 'idea'];

/** True when the post is about a company, a product, a place, a thing or an idea: its pictures show that, not a face. */
export const notAFace = (outline) => Boolean(outline?.subjectKind) && !FACE_KINDS.has(outline.subjectKind);

/** What a check is told when a photograph must not be a portrait. */
export const NO_FACE = 'The post is about a company, a product, a place, a thing or an idea, not a person: the photograph shows the thing itself or what happened, with no person as its main subject. A portrait, a headshot or a press photograph of a founder, a boss or an owner is not this photograph.';

const SHOT = {
  type: 'object',
  properties: { query: { type: 'string' }, person: { type: 'boolean' }, show: { type: 'string' } },
  required: ['query', 'person', 'show'],
  additionalProperties: false,
};

export const ART_SCHEMA = {
  type: 'object',
  properties: {
    subjectKind: { type: 'string', enum: SUBJECT_KINDS },
    cover: SHOT,
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, query: { type: 'string' }, person: { type: 'boolean' }, show: { type: 'string' } },
        required: ['index', 'query', 'person', 'show'],
        additionalProperties: false,
      },
    },
    closing: {
      type: 'object',
      properties: { query: { type: 'string' }, show: { type: 'string' } },
      required: ['query', 'show'],
      additionalProperties: false,
    },
  },
  required: ['subjectKind', 'cover', 'slides', 'closing'],
  additionalProperties: false,
};

export const ART_SYSTEM = `You are the art director of a Hebrew slideshow account on TikTok and Instagram. Every slide stands on one real, licensed photograph from a free library (Wikimedia Commons, Pexels, Unsplash, Openverse), cut to 9:16 around its subject, with the slide's text over its quiet part. The slideshows that spread are a real photograph a slide that says the slide's line before anyone reads it.

For the cover and each content slide, decide what its photograph shows:
- What the slide says, as a picture a photographer could have taken: the thing, the place, the moment, the people in the act. "They rented air mattresses on their floor to pay the rent" is "air mattress on a living room floor", not a portrait of the men who did it.
- A person's face only when the slide is about that person (their own life, their words, their match, their record) and names them: then their full name in English ("Cristiano Ronaldo"), person true. Never a founder's, a CEO's or an owner's portrait on a slide or a cover about the company, the product or what it did: a post about Airbnb opens on a home its guests rent, never on Brian Chesky.
- A company, a brand or a product is shown by what it makes or does, its place, or its customers using it: never its logo, its sign, a screen or its headquarters (unless the slide is about the building).
- The cover shows the whole post's subject at its most striking: what makes someone stop scrolling. A facts or tips post about people may open on the most famous face on its list.
- Searches that find licensed photographs: 2 to 5 plain English words, concrete nouns ("cereal boxes on a shelf", "san francisco apartment interior"); famous people, places and events by their full English names. A thing by what it is, not by its brand ("electric car charging", unless the slide is about that one car).
- Nothing a free library would not have: no "founders signing a deal in 2008", no "investor meeting", no "company growth chart".
- Every slide a different picture: no two slides the same subject or the same scene.
- show: one English sentence of what the photograph must show, for the check that compares the picture with the slide ("a living room floor with air mattresses laid out for guests"). person: true only when the photograph is one named person's face.
- closing: the closing slide's background, after the last content slide: a calm, warm picture of what the account's business is about (its world, its product in use), with no person as its main subject and room for the closing line.
- subjectKind: what the post is about: person, team, company, product, place, thing or idea.

Return the cover, every content slide by its index (1 is the first after the cover), and the closing.`;

/** The request: the post, its subject and its slides with the writer's searches. Pure. */
export function artUser({ pack, format, draft, outline }) {
  const slides = draft.slides.map((s, i) => (i === 0 || s.kind !== 'item' ? null : `${i}. ${[s.title, s.body].filter(Boolean).join(' / ')}${s.imageQuery ? ` [the writer searched: ${s.imageQuery}]` : ''}`)).filter(Boolean);
  return [
    `ACCOUNT: ${pack.meta.displayName || pack.id}${pack.meta.description ? `, ${pack.meta.description}` : ''}${pack.meta.topics?.length ? `. Topics: ${pack.meta.topics.slice(0, 6).join(', ')}` : ''}`,
    `POST: a ${kindName(format)} post about ${outline.topic || draft.hook}${outline.subjectKind ? ` (the writer says it is about a ${outline.subjectKind})` : ''}.`,
    `COVER: ${draft.hook}${draft.sub ? ` / ${draft.sub}` : ''}${outline.imageQuery ? ` [the writer searched: ${outline.imageQuery}]` : ''}`,
    'CONTENT SLIDES:',
    ...slides,
  ].join('\n');
}

/**
 * Puts the art director's answer on the post: each slide's search and what its picture must show (`shot`), the
 * cover's search, the subject's kind, and the closing's background (`draft.closingScene`). A guess-who's and a
 * head-to-head's cover keep the outline's faces. A slide the answer leaves out keeps the writer's search. Pure, but for
 * the objects it is handed. Returns the slides it changed.
 */
export function applyArt({ format, draft, outline }, art) {
  if (!art) return [];
  const kind = kindName(format);
  const changed = [];
  if (art.subjectKind && SUBJECT_KINDS.includes(art.subjectKind)) outline.subjectKind = art.subjectKind;
  if (art.cover?.query && !['guess-who', 'head-to-head'].includes(kind)) {
    if (art.cover.query !== outline.imageQuery) changed.push(0);
    outline.imageQuery = art.cover.query.trim();
    outline.coverShot = { person: Boolean(art.cover.person), show: String(art.cover.show || '').trim() };
  }
  for (const a of art.slides || []) {
    const s = draft.slides[a.index];
    if (!s || a.index === 0 || s.kind !== 'item' || s.role === 'clue' || !a.query) continue;
    if (a.query !== s.imageQuery) changed.push(a.index);
    s.imageQuery = a.query.trim();
    s.shot = { person: Boolean(a.person), show: String(a.show || '').trim() };
  }
  if (art.closing?.query) draft.closingScene = { query: art.closing.query.trim(), show: String(art.closing.show || '').trim() };
  return changed;
}

/**
 * The art director's pass over one post, when a live model writes it and the post stands on photographs. Returns
 * { changed, usd } (changed: the slides whose search it rewrote), or null when it did not run. A failure leaves the
 * writer's searches as they were: the pictures are still searched.
 */
export async function artDirect(ctx, { pack, format, draft, outline, postId }) {
  if (ctx.llm?.kind !== 'claude' || kindName(format) === 'meme') return null;
  if (!(pack.meta.imagery?.providers || []).length) return null;
  try {
    const res = await askJson(ctx, {
      task: 'art-direction', role: 'draft', system: ART_SYSTEM, user: artUser({ pack, format, draft, outline }), schema: ART_SCHEMA,
      effort: 'low', maxTokens: 3000, meta: { postId }, tag: 'art',
    });
    return { changed: applyArt({ format, draft, outline }, res.data), usd: res.usd || 0 };
  } catch (e) {
    ctx.log?.(`art direction: ${e.message}`);
    return null;
  }
}
