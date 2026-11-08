// The closing slide's own call: its line written once the whole slideshow is read, as the turn from this post's story
// to what the business offers (the owner, 2026-11-08, on "רוצים לספר סיפור עסקי כזה? ב-OpenFrequency כותבים מצגות"
// over a random photograph: "CTA is not the best", and "involve AI in setting up the page and creating slideshows, even
// if it X3 the cost of a slideshow"). The slides call writes a line beside everything else; this call reads the story
// it closes, the store's real promise and the writer's line, and writes the line a person would end that story with.
// It goes on the post only when it keeps every rule of the closing slide (closing.js closingProblems): otherwise the
// writer's line stays, and the checks and the repair go on as before. The action under it (the link, the address,
// the handle) stays the code's. Only a live model writes it.

import { askJson } from '../llm/index.js';
import { closingFrom, closingProblems, closingRequest } from './closing.js';

export const CLOSER_SCHEMA = {
  type: 'object',
  properties: { line: { type: 'string' }, why: { type: 'string' } },
  required: ['line', 'why'],
  additionalProperties: false,
};

export const CLOSER_SYSTEM = `You write the closing slide of a Hebrew slideshow on TikTok and Instagram: the one line after the last content slide, over a calm photograph, with the business's action under it (the code writes the action). People who swiped to the end liked the story: the line turns that story into a reason to act, the way a friend who owns the shop would end it.

What makes a closing line work:
- It continues THIS story: it picks up the post's own moment, problem or lesson in a few words, and lands on what the business has for exactly that. Someone who reads only this line knows what the post was about and why the business is the next step.
- It speaks to the reader's own life or business, concretely (what they get, what they stop worrying about), never about the business's greatness.
- It sounds like a person: plain spoken Hebrew, uneven rhythm, a concrete noun where an ad would put an adjective.
- Never an ad's frame: no "רוצים...?" or "מחפשים...?" opener that any post could have, no "בדיוק בשביל זה", no "אנחנו כאן בשבילכם", no slogan, no pun on the business's name.
- Never the business's promise said again on its own: that line closes any post, and the reader has seen it.
- When the post is about a famous company or person, the line moves from them to the reader ("ככה מתחילים", "גם לכם") only if the business really offers that.
Return the line, and in "why" one English sentence on what in the story it picks up.`;

/** The request: the story as the slides tell it, what the business offers and the rules, and the writer's line. Pure. */
export function closerUser({ pack, draft, outline, lesson = null }) {
  const slides = draft.slides
    .map((s, i) => (i === 0 || s.kind !== 'item' ? null : `${i}. ${[s.title, s.body].filter(Boolean).join(' / ')}`))
    .filter(Boolean);
  return [
    `ACCOUNT: ${pack.meta.displayName || pack.id}${pack.meta.description ? `, ${pack.meta.description}` : ''}`,
    `THE POST: ${draft.hook}${draft.sub ? ` / ${draft.sub}` : ''}`,
    ...slides,
    '',
    closingRequest(pack, { topic: outline?.topic || '', lesson }).replace('Write its one line in closing.line', 'Write its one line in "line"'),
    '',
    draft.closing?.line ? `The line written with the slides (improve on it, or keep it if it is already the best): ${draft.closing.line}` : '',
  ].filter((x) => x !== null).join('\n');
}

/**
 * Writes the post's closing line from the whole slideshow, when a live model writes the post and it has a closing
 * slide. Returns { closing, line, problems, usd }, or null when it did not run: `closing` is the slide with the new
 * line, for the caller to put on the post when the post's own checks take it (build.js); `problems` what the closing's
 * rules refuse in it. `facts`: the post's verified facts, for the numbers a line may state.
 */
export async function writeClosing(ctx, { pack, draft, outline, facts = [], postId = null }) {
  if (ctx.llm?.kind !== 'claude' || !draft.closing) return null;
  const lesson = ctx.closingLesson || null;
  let res;
  try {
    res = await askJson(ctx, {
      task: 'closing', role: 'draft', system: CLOSER_SYSTEM, user: closerUser({ pack, draft, outline, lesson }), schema: CLOSER_SCHEMA,
      effort: 'medium', maxTokens: 2000, meta: { postId }, tag: 'closing',
    });
  } catch (e) {
    ctx.log?.(`closing: ${e.message}`);
    return null;
  }
  const next = closingFrom(pack, res.data.line, 'closer');
  const problems = closingProblems(next, { pack, others: ctx.packs || [], facts, lesson });
  return { closing: next, line: next.line, why: String(res.data.why || ''), problems: problems.map((p) => p.msg), usd: res.usd || 0 };
}
