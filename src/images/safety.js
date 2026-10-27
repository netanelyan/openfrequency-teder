import { askJson } from '../llm/index.js';
import { getBrowser } from '../render/render.js';

// The image screen: no blood, no injury close-ups, no fighter down and out, no
// watermark, no belt, no promotion's logo or poster. TikTok takes a post with
// any of them out of the For You feed, and the first two are not this engine's
// to publish anyway. Three layers, cheapest first:
//
//   1. words: the picture's own title and description name it ("bloody",
//      "knockout", "Getty Images", "championship belt"): refused, no call made.
//   2. pixels: a large share of deep, saturated red is how blood looks to a
//      counter, and also how red gloves and a red corner look. A counter cannot
//      tell them apart, so a red picture is never refused here: it goes to a
//      person, or to the model.
//   3. the model: Claude Haiku looks at the picture when there is a live client,
//      and its answer refuses or clears it.
//
// What none of them can clear goes to a person. Such a picture's post can be
// approved, but it is not published until someone has looked at the picture on
// the post's page (images.reviewed_at): "review" is the fallback, never "ok".

export const REFUSE_WORDS = [
  'blood', 'bloody', 'bloodied', 'bleeding', 'bleeds', 'injury', 'injured', 'injuries', 'wound', 'wounded', 'laceration', 'gash', 'cut eye', 'swollen', 'swelling',
  'broken nose', 'broken arm', 'broken leg', 'fracture', 'stretcher', 'unconscious', 'knocked out', 'knockout', 'k.o.', 'tko', 'out cold', 'concussion', 'gore', 'corpse', 'dead body',
  'watermark', 'getty images', 'gettyimages', 'shutterstock', 'alamy', 'zuffa', 'ap photo', 'reuters', 'afp', 'usa today sports', 'imagn',
  'belt', 'championship belt', 'title belt', 'poster', 'fight poster', 'promo', 'logo', 'octagon logo',
  'דם', 'מדמם', 'פציעה', 'פצוע', 'נוקאאוט', 'מעולף', 'אלונקה',
];

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9֐-׿.]+/g, ' ')} `;

/** The first refusing word in a picture's title and description, or null. */
export function refusingWord(text, extra = []) {
  const t = norm(text);
  return [...REFUSE_WORDS, ...extra].find((w) => t.includes(` ${String(w).toLowerCase()} `)) || null;
}

/** A see-through PNG drawn onto a solid colour, as a JPEG, through the render browser's canvas (nothing is fetched). */
export async function flatten(buf, ground = '#111111') {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
  await context.route('**/*', (route) => route.abort());
  const tab = await context.newPage();
  try {
    await tab.setContent(`<img id="i" src="data:image/png;base64,${buf.toString('base64')}">`, { waitUntil: 'load' });
    const data = await tab.evaluate((color) => {
      const img = document.getElementById('i');
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92).split(',')[1];
    }, /^#[0-9a-f]{6}$/i.test(ground) ? ground : '#111111');
    return Buffer.from(data, 'base64');
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The share of deep, saturated red pixels in an image, through the render
 * browser's canvas (nothing is fetched: the image is inlined).
 */
export async function redShare(buf, type = 'image/jpeg') {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
  await context.route('**/*', (route) => route.abort());
  const tab = await context.newPage();
  try {
    await tab.setContent(`<img id="i" src="data:${type};base64,${buf.toString('base64')}">`, { waitUntil: 'load' });
    return await tab.evaluate(() => {
      const img = document.getElementById('i');
      const W = 120;
      const H = Math.max(1, Math.round((W * img.naturalHeight) / Math.max(1, img.naturalWidth)));
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      let red = 0;
      for (let i = 0; i < d.length; i += 4) {
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        if (r > 110 && r > gr * 1.9 && r > b * 1.7) red++;
      }
      return red / (W * H);
    });
  } finally {
    await context.close().catch(() => {});
  }
}

export const SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    consistent: { type: 'boolean' },
    mainSubject: { type: 'string' },
    blood: { type: 'boolean' },
    injury: { type: 'boolean' },
    unconscious: { type: 'boolean' },
    watermark: { type: 'boolean' },
    logoOrBelt: { type: 'boolean' },
    weapon: { type: 'boolean' },
    faceX: { type: 'number' },
    faceY: { type: 'number' },
    sure: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['consistent', 'mainSubject', 'blood', 'injury', 'unconscious', 'watermark', 'logoOrBelt', 'weapon', 'faceX', 'faceY', 'sure', 'note'],
  additionalProperties: false,
};

const SCREEN_SYSTEM = `You check one photograph before it goes on a public social post. Answer only about what is visible.
- blood: any visible blood.
- injury: an injury close-up (a cut, swelling, a broken bone, a bruised face up close).
- unconscious: a person lying knocked out, limp or being attended to on the ground.
- watermark: a photo agency's or anyone's watermark or credit stamped on the picture.
- logoOrBelt: a promotion's or brand's logo as the main element (a poster, a logo filling the frame), a championship belt held up or worn, or a broadcast graphic. A logo on a backdrop, a microphone, a banner or clothing behind or on the person is not.
- weapon: a gun, a rifle, a mounted machine gun or a knife anywhere in the picture, real or a training replica. Gloves, pads and sports gear are not.
- faceX, faceY: where the main person's face is, its centre as a percentage of the picture's width (0 the left edge, 100 the right) and of its height (0 the top). With no face, 50 and 30.
- sure: false when the picture is too small or unclear to tell.
- note: a few words on what decided it.
- mainSubject: what the picture mainly shows, in a few words (a person at a football match, a stadium from outside, a rock, a poster).
- consistent: when the request says what the picture is for, true only if what you see fits it: the kind of subject it names (one person as the main subject for a person, the place for a place) in a setting that fits the slide. A different kind of thing (an object, a plant, an animal, a building for a person), a crowd where no one stands out, a poster, a logo or a screen is false. Do not try to recognise anyone by their face: the picture's own title names the person; you judge only that the picture fits. The file's own title and description, when given, say who it shows and where and when it was taken. A portrait, a press photo or a posed picture of the right person fits a slide about them whatever its date, with one exception: for a slide about what an athlete did in their sport (a match, a goal, a fight, a title, a season), a picture of them away from it is false: on a conference or talk stage, in a TV studio, at a fan event or beside a fence with fans, at a ceremony in a suit, playing another sport. A picture in kit, on the pitch or in the cage, at training, on the touchline, with a trophy, posed for their club, or at their own sport's media day, press conference or weigh-in fits. A request for a portrait (the answer of a guess-who, one side of a head-to-head) is about the face, not an event: a picture where they are the main subject, their face clear, fits it whatever the occasion (a stage, a ceremony, a visit), as long as it is plainly the public figure: the same-name rule below still holds. A group picture where they are one of several people of the same size (a line of soldiers, a team photo, two people side by side behind equipment) is false: a half cover cut from it shows strangers. An action picture (a match, a fight, a goal, a kick) fits only if the file places it at the very event the slide is about: an action shot of the same player at another match misleads. A statue, a plaque, a painting or a drawing of the person is not the person: false. A file whose title names someone else (another person with the same name) is false. A name can be shared: for an athlete, a picture with nothing of the sport or of public life in it (a holiday snapshot, a family photo, a man at the seaside) is most likely someone else with the same name: false. The reader must see who it is: a person seen from behind, too small, or cropped so close the picture is a hat and a cheek, is false. When the slide names the club, the team or the year of its story, the person in another club's kit, or plainly years older or younger than the story, is false (a 2008 Manchester United story is not told with a Real Madrid shirt). A place fits only as the main subject, filling the frame: a stadium far off across a lake or a skyline is false. A blurred, out-of-focus or pixelated picture is false. Without a request, true.
- consistent, for a content slide (the request says so): its photograph sits in a frame under the slide's text and only shows what the slide is about. A photograph of the slide's subject matter (the product, the place, the person, the team, the sport, the thing the slide talks about) fits even though no photograph could show the slide's claim itself: a price, a price cap, a rule or a law, a statistic, a record, a date, a decision. Supermarket shelves of milk fit a slide about the regulated price of milk; a stadium fits a slide about its attendance record; a player in kit fits a slide about his transfer fee. Never false because the picture does not show the number, the rule or the event's outcome. For a content slide false only for: the wrong person (a file that names someone else, a statue or a drawing of the person, a person no one can make out), the wrong sport or a different subject altogether, or a picture that misleads (an action shot placed at another event than the one the slide tells, the person in another club's kit when the slide names the club and the year, a picture that shows the opposite of what the slide says). A blurred or pixelated picture is still false. The rules above about where an athlete is pictured and about group pictures are for covers and portraits, not content slides, unless the picture misleads.
- When the account's owner added the photograph themselves, the request gives their description of it: take it as true for who and what it shows and where it was taken, and judge only that it fits the slide. It changes nothing about blood, injury, unconscious, watermark, logoOrBelt or weapon: answer those from what you see.`;

/** The red share above which a person (or the model) must look. Strict packs look sooner. */
export const RED_REVIEW = { strict: 0.04, standard: 0.12 };

/**
 * What the model is told about the picture it screens: the slide it is for (a content slide's photograph only has to
 * show what the slide is about: dairy shelves were refused for a slide about the regulated price of milk, as not
 * showing "the regulated-price subject"), what it was searched for, its own title, and the owner's own words when the
 * owner added it. Pure.
 */
export function screenRequest({ claim = '', query = '', meta = '', role = 'cover', owner = '' } = {}) {
  if (!claim) return 'The photograph:';
  const what = role === 'content' ? 'a content slide (its photograph shows what the slide is about, not the claim itself)' : 'a slide';
  const own = owner ? ` The account's owner added this photograph and describes it as: "${String(owner).slice(0, 300)}".` : '';
  return `The picture is for ${what} that says: "${claim.slice(0, 300)}". It was searched for as: "${query}". The file's own title and description: "${String(meta).slice(0, 400)}".${own} The photograph:`;
}

/**
 * Screen one image before it is used. Returns { safety: 'ok'|'review'|'refused', why, red, model }.
 * meta: its title and description; strict: the pack asked for the strict screen (imagery.safety); role: 'content'
 * for a content slide's framed photograph, which must show the slide's subject, not its abstract claim; owner: the
 * owner's own description of a photograph they added (<pack>/photos), taken as what it shows. Neither eases the
 * safety questions.
 */
export async function screenImage(ctx, { pack, buf, type, meta = '', postId = null, query = '', claim = '', role = 'cover', owner = '' }) {
  const strict = pack.meta.imagery?.safety === 'strict';
  const word = refusingWord(meta, pack.rules?.imageQueryBlock || []);
  if (word) return { safety: 'refused', why: `the picture's description says "${word}"` };
  let red = null;
  try {
    red = await redShare(buf, type);
  } catch (e) {
    ctx.log?.(`image screen: ${e.message}`);
  }
  const reddish = red == null || red >= RED_REVIEW[strict ? 'strict' : 'standard'];
  // A picture for a slide is always looked at: the screen and the check that it shows what the slide says, in one call.
  if (ctx.llm?.kind === 'claude' && (strict || reddish || claim)) {
    try {
      const user = screenRequest({ claim, query, meta, role, owner });
      const { data } = await askJson(ctx, { task: 'image-screen', role: 'judge', system: SCREEN_SYSTEM, user, image: { type, buf }, schema: SCREEN_SCHEMA, effort: 'low', maxTokens: 1500, tag: 'image-screen' });
      const bad = ['blood', 'injury', 'unconscious', 'watermark', 'logoOrBelt', 'weapon'].filter((k) => data[k]);
      if (bad.length) return { safety: 'refused', why: `the model saw: ${bad.join(', ')} (${data.note})`, red, model: data };
      if (claim && data.consistent === false) return { safety: 'refused', why: `it does not show what the slide says: ${data.mainSubject} (${data.note})`, red, model: data, mismatch: true };
      if (data.sure) return { safety: 'ok', why: `the model saw nothing to refuse (${data.note})`, red, model: data };
      return { safety: 'review', why: `the model could not tell (${data.note})`, red, model: data };
    } catch (e) {
      ctx.log?.(`image screen model: ${e.message}`);
    }
  }
  if (strict) return { safety: 'review', why: red == null ? 'the picture could not be measured' : `a strict pack, and no model to look: red ${(red * 100).toFixed(1)}%`, red };
  if (reddish) return { safety: 'review', why: red == null ? 'the picture could not be measured' : `${(red * 100).toFixed(1)}% deep red: a person must look`, red };
  return { safety: 'ok', why: `no refusing word, ${(red * 100).toFixed(1)}% deep red`, red };
}

/**
 * Where a picture's main face is, as a CSS object-position ("72% 18%"), from its screen; null when it was not
 * measured. A narrow crop (one half of a head-to-head cover) aimed at the middle cut a judoka's face out of frame.
 */
export function focusOf(img) {
  let screen = img?.safety_json;
  if (typeof screen === 'string') {
    try {
      screen = JSON.parse(screen);
    } catch {
      return null;
    }
  }
  const m = screen?.model;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n);
  if (!m || !ok(m.faceX) || !ok(m.faceY)) return null;
  const pct = (n) => Math.round(Math.min(100, Math.max(0, n)));
  return `${pct(m.faceX)}% ${pct(m.faceY)}%`;
}
