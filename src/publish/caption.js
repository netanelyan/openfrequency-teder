import { imageCredit } from '../images/index.js';
import { captionAction } from '../pipeline/closing.js';
import { AI_CAPTION_LINE, CAPTION_MAX } from './zernio.js';

// A post's caption as it goes out, on each platform, made in one place for every path that sends it or shows it: the
// publishers (src/publish/index.js), the TikTok draft, the dry run's files (src/pipeline/export.js), the bundle a
// customer posts by hand (src/assistant/data.js) and the post's page (src/web/pages.js).
//
//   the words      TikTok the long one; Instagram and a Facebook Page the short one, which opens on the cover line and
//                  ends on the question (a Page's post is read the same way: the text above the photos, to its first
//                  lines before "See more")
//   the credits    the photographs whose licence asks for it
//   the action     the closing slide's (item 5, the owner, 2026-11-04: "The caption: it repeats the same action, with
//                  the link on Instagram and Facebook"): src/pipeline/closing.js captionAction, from the slide's own
//                  action data, so the caption says what the slide says. It is the code's, never the writer's: the
//                  writer's captions hold no link (src/voice/tells.js refuses one), and it is added here, after every
//                  check of the words, so no edit can change it or take it out
//   the hashtags   the post's own, five at most, always last
//
// THE ACTION IS NEVER CUT. Every platform cuts a caption past its limit (CAPTION_MAX; the publishers cut at it, the AI
// line included), from the end. The action stands before the hashtags, so a cut takes them first; and before any cut,
// a caption that would not fit with the room for the AI line sheds its hashtags from the last.

/** Room for the AI line the publishers add after the caption ("\n\n" and AI_CAPTION_LINE). */
const AI_ROOM = AI_CAPTION_LINE.length + 2;

/** The longest caption this platform's post may carry before the AI line. */
export const captionRoom = (platform) => (CAPTION_MAX[platform] || CAPTION_MAX.instagram) - AI_ROOM;

/** The words the writer wrote for this platform: TikTok's long caption, or Instagram's (a Page's too). */
const wordsFor = (post, platform) => String(((platform === 'instagram' || platform === 'facebook') && post.caption_ig ? post.caption_ig : post.caption) || '').trim();

/**
 * A platform's caption without its hashtags: the words, the credits, and the closing slide's action as its last line.
 * Words that already end on the action (an owner who typed "הלינק בביו" at the end) are not given it twice.
 */
export function captionBody(db, post, platform) {
  const action = captionAction(post.data?.closing, platform);
  const lines = wordsFor(post, platform).split('\n');
  if (action && lines.at(-1).trim() === action) lines.pop();
  return [lines.join('\n').trim(), imageCredit(db, post), action].filter(Boolean).join('\n\n');
}

/** A platform's caption as it goes out: captionBody, then the hashtags, as many of them as the platform has room for. */
export function captionOf(db, post, platform) {
  const body = captionBody(db, post, platform);
  const tags = [...(post.hashtags || [])];
  while (tags.length && `${body}\n\n${tags.join(' ')}`.length > captionRoom(platform)) tags.pop();
  return [body, tags.join(' ')].filter(Boolean).join('\n\n');
}
