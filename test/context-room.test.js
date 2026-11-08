import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadPack } from '../src/packs/load.js';
import { closeBrowser, renderPost } from '../src/render/render.js';
import { tokenOf } from '../src/verify/claims.js';
import { styleFitProblems } from '../src/render/styles/fit.js';
import { themeOf } from '../src/render/styles/index.js';
import { copyPack, tempHome } from './helpers.js';

// A slide's text is one sentence of context under its title (the owner, 2026-11-08: "sentences are too short so
// context is not there"): style A, the business accounts' card, holds three lines of it, and the slide is drawn whole.
// With OF_SAMPLES_DIR set, the drawn slides are copied there for a person to look at.

after(() => closeBrowser());

const TITLE = 'אין כסף לשכר דירה, אז השכירו מזרנים';
const BODY = 'ב-2007 שני שותפים בסן פרנסיסקו פרסו שלושה מזרני אוויר בסלון והשכירו אותם לאורחי כנס עיצוב שלא מצאו מלון.';

test('style A holds a title and a sentence of context under it, three lines, and draws the slide', { timeout: 240_000 }, async () => {
  const draft = { hook: '5 דברים שלא ידעתם על אייר בי אן בי', sub: '', slides: [{ kind: 'cover' }, { kind: 'item', role: 'fact', title: TITLE, body: BODY }] };
  assert.deepEqual(styleFitProblems(draft, { style: 'A', postKind: 'facts' }), [], 'the sentence fits style A');
  const { home, cleanup } = tempHome();
  try {
    const dir = copyPack(home, 'demo', (f) => {
      f.pack.style = { name: 'A' };
    });
    const own = loadPack(dir);
    const pack = { ...own, theme: themeOf(own, 'A') };
    const fact = (title, body) => ({ kind: 'item', role: 'fact', title, body, factKeys: [], sources: [] });
    const slides = [
      { kind: 'cover', role: 'cover', title: '', body: '', factKeys: [] },
      fact(TITLE, BODY),
      fact('מכרו דגני בוקר כדי לגייס כסף', 'ב-2008, בלי משקיעים, הם עיצבו קופסאות דגני בוקר על הבחירות בארה״ב ומכרו כל אחת ב-40 דולר.'),
      fact('היום אין לאייר בי אן בי אף נכס משלה', 'מיליוני המארחים הם בעלי הבתים, והחברה רק מחברת ביניהם לבין האורחים.'),
      fact('מיליוני אורחים בכל לילה', 'בכל לילה ישנים מיליוני אנשים בבתים שהושכרו דרכה.'),
    ];
    const extra = { captionIg: '', keywords: [], subject: {}, cta: '' };
    const post = { id: 'context', hook: draft.hook, sub: '', caption: 'c', extra };
    post.token = tokenOf({ slides, caption: post.caption, hook: post.hook, sub: post.sub, extra });
    const files = await renderPost({ pack, format: { id: 'facts', kind: 'facts', name: 'x', hooks: ['x'] }, post, slides, outDir: path.join(home, 'media', 'context'), platforms: ['tiktok'], lenient: true });
    const drawn = files.tiktok || [];
    assert.ok(drawn.length >= slides.length, `${drawn.length} slides drawn`);
    assert.deepEqual(Object.values(files.warnings || {}).flat().filter(Boolean), [], 'nothing drawn that did not fit');
    const out = process.env.OF_SAMPLES_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      for (const file of drawn) if (existsSync(file)) copyFileSync(file, path.join(out, `context-${path.basename(file)}`));
    }
  } finally {
    cleanup();
  }
});
