import { linesOf, oneLine } from './overlay.js';
import { LIMITS, normHe, sentencesOf } from '../voice/tells.js';

// TikTok's caption tells the post as a story, in four beats, one a line:
//
//   hook       the line that stops the scroll. TikTok shows a caption's first
//              line or so before "more", so it is one sentence, and short
//   problem    what was at stake, what goes wrong, the question the post settles
//   discovery  the turn: what the slides found (never more than they show)
//   result     how it ended, or what it means for them now. The closing
//              question, when there is one, rides at its end
//
// The writer returns the four beats as fields (SLIDES_SCHEMA "story") and the
// code joins them, a blank line between two, so the stored caption is the story
// and every later check (the owner's edit, a rewrite) reads the beats back from
// its lines. What is checked here is the shape: four lines, each a beat of its
// own size, none repeating another. Whether a line is really a hook is the
// reviewer's call, and the prompt's.
//
// Hashtags are the engine's (hashtagsFor), at most five, added after the
// caption when it is published: a tag the writer put in a caption would go out
// twice or push the post past five, so a caption holds none.
//
// Instagram's short caption is not a story: it is the cover line, one line under
// it and the question (igCaption).

export const STORY = ['hook', 'problem', 'discovery', 'result'];
export const MAX_HASHTAGS = 5;

// Short, the default. Of 25 slideshows that spread on TikTok, 21 had a caption of one line or hashtags alone: the
// slides carry the post, and the line under it is the hook again in other words. A short caption is the story's hook
// beat alone (with the closing question when there is one), and the four-beat story stays for an account that asks
// for it (pack.json "writing": { "captionStyle": "story" }).
export const SHORT_CAPTION = { minChars: 15, maxChars: 220, lines: 2 };

/** How an account's TikTok captions are told: 'short' (the default) or 'story'. */
export const captionStyleOf = (pack) => (pack?.meta?.writing?.captionStyle === 'story' ? 'story' : 'short');

/** A beat's size: the hook is one sentence a reader takes in before "more"; the others say one thing. */
export const BEAT = { hookMaxChars: 100, sentences: 2, minWords: 3 };

/** The beats as the caption holds them: each one line, a blank line between two. */
export function storyCaption(story, style = 'story') {
  // A short caption is the hook beat alone.
  return (style === 'short' ? ['hook'] : STORY).map((k) => oneLine(story?.[k])).filter(Boolean).join('\n\n');
}

/** A caption's beats: every line of it. */
export const beatsOf = (caption) => linesOf(caption);

// A tag starts after a space or the start (never inside a word or a link's #fragment) and is letters, digits or "_".
const HASHTAG = /(?<![\p{L}\p{N}_&/#])#[\p{L}\p{N}_]+/gu;

/** The hashtags in a text, as written. */
export const hashtagsIn = (text) => String(text || '').match(HASHTAG) || [];

const flat = (s) => normHe(String(s || '')).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * What is wrong with a TikTok caption as a story, one { where, code, msg } each. `limits`: the account's captionLong
 * limits, so a short-caption account's four beats are short too.
 */
export function storyProblems(caption, limits = null, style = 'story') {
  const out = [];
  const add = (msg) => out.push({ where: 'caption', code: 'caption', msg });
  const beats = beatsOf(caption);
  if (style === 'short') {
    if (beats.length > SHORT_CAPTION.lines) add(`the TikTok caption is short: one line, two at most (it has ${beats.length})`);
    if (beats[0] && beats[0].length > BEAT.hookMaxChars) add(`the caption's first line is ${beats[0].length} characters: at most ${BEAT.hookMaxChars}, the part TikTok shows before "more"`);
    return out;
  }
  if (beats.length !== STORY.length) {
    add(`the TikTok caption tells the post as a story in ${STORY.length} lines, one beat a line (${STORY.join(', ')}): it has ${beats.length === 1 ? 'one line' : `${beats.length} lines`}`);
    return out;
  }
  // A short-caption account (writing.captionLong): no beat but the last may take more than its share, or the four do not fit.
  const share = limits?.maxChars < LIMITS.captionLong.maxChars ? Math.floor((limits.maxChars - 6) / STORY.length) : null;
  beats.forEach((b, i) => {
    const name = STORY[i];
    const n = words(b);
    const s = sentencesOf(b);
    // The closing question rides at the end of the result: one sentence more, if it is a question.
    const most = name === 'hook' ? 1 : name === 'result' && /\?\s*$/.test(b) ? BEAT.sentences + 1 : BEAT.sentences;
    if (n < BEAT.minWords) add(`the story's ${name} line has ${n === 1 ? 'one word' : `${n} words`}: a beat says something, ${BEAT.minWords} words or more`);
    if (s.length > most) add(`the story's ${name} line has ${s.length} sentences: ${most === 1 ? 'one' : `at most ${most}`}`);
    if (name === 'hook' && b.length > BEAT.hookMaxChars) add(`the story's hook line is ${b.length} characters: at most ${BEAT.hookMaxChars}, the part TikTok shows before "more"`);
    if (share && name !== 'result' && b.length > share) add(`the story's ${name} line is ${b.length} characters: this account keeps captions short, about ${share} a line`);
  });
  for (let i = 0; i < beats.length; i++) {
    for (let k = i + 1; k < beats.length; k++) {
      const a = flat(beats[i]);
      const b = flat(beats[k]);
      if (a && b && (a === b || a.includes(b) || b.includes(a))) add(`the story's ${STORY[k]} line repeats its ${STORY[i]} line: each beat moves the story on`);
    }
  }
  return out;
}

/**
 * Hashtags: none written into a caption (the engine adds the post's own), and the post's own at most five, each
 * a well-formed tag. `tags`: the post's hashtags, when they are known.
 */
export function hashtagProblems({ caption = '', captionShort = '' } = {}, tags = null) {
  const out = [];
  for (const [where, text] of [['caption', caption], ['caption short', captionShort]]) {
    const found = hashtagsIn(text);
    if (found.length) out.push({ where, code: 'caption', msg: `a hashtag in the caption (${found.slice(0, 3).join(' ')}): the engine adds the post's hashtags after it, ${MAX_HASHTAGS} at most` });
  }
  if (tags) {
    if (tags.length > MAX_HASHTAGS) out.push({ where: 'hashtags', code: 'caption', msg: `${tags.length} hashtags: ${MAX_HASHTAGS} at most` });
    const bad = tags.filter((t) => !/^#[\p{L}\p{N}_]+$/u.test(String(t)));
    if (bad.length) out.push({ where: 'hashtags', code: 'caption', msg: `not a hashtag: ${bad.slice(0, 3).join(' ')}` });
  }
  return out;
}

/** Every way a post's captions break the story and hashtag rules. `limits`: the account's captionLong limits. */
export function captionProblems(draft, { limits = null, tags = null, style = 'story' } = {}) {
  return [...storyProblems(draft.caption, limits, style), ...hashtagProblems(draft, tags)];
}
