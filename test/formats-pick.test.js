import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, loadPack } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { DEFAULT_PICKED, formatsFor, LIBRARY, MIN_PICKED, pickedFrom, pickedOf } from '../src/formats/library.js';
import { KINDS } from '../src/formats/kinds.js';
import { inTurns, turnOrder } from '../src/formats/rotation.js';
import { setPackFormats } from '../src/packs/write.js';
import { validatePack } from '../src/packs/validate.js';
import { opened, tempHome } from './helpers.js';

// The formats a customer picks, one after the other (the owner, 2026-10-31: "i want the customer to pick the formats
// he likes. it is changable, and each slideshow is in a different format.").

after(() => closeBrowser());

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

test('the library: every format is one of the engine\'s kinds, valid in a pack, with words for the customer; no meme, nothing for one niche', () => {
  assert.ok(LIBRARY.length >= 10);
  assert.equal(new Set(LIBRARY.map((f) => f.id)).size, LIBRARY.length, 'ids are unique');
  for (const f of LIBRARY) {
    assert.ok(KINDS[f.kind || 'list'], f.id);
    assert.ok(f.name && f.he && f.about, `${f.id}: a name, a line for the customer and one for the model`);
    assert.doesNotMatch(`${f.about} ${f.he} ${f.hooks.join(' ')}`, /football|כדורגל|UFC|plant|צמח|garden/i, `${f.id}: written for no niche`);
  }
  assert.ok(!LIBRARY.some((f) => ['meme', 'do-dont', 'owner-story'].includes(f.kind)), 'no slide may stand without a photograph, and no format for one kind of account');
  assert.ok(DEFAULT_PICKED.length >= MIN_PICKED && DEFAULT_PICKED.every((id) => LIBRARY.some((f) => f.id === id)));
  // Every one of them, all at once, is a valid formats.json (the demo pack stands for the rest of the pack).
  const { home, cleanup } = tempHome();
  try {
    const demo = loadPack(path.join(home, 'packs', 'demo'));
    const all = formatsFor(LIBRARY.map((f) => f.id));
    assert.ok(all.every((f) => !('he' in f)), "the customer's words stay in the library");
    assert.deepEqual(validatePack({ ...demo, formats: { ...demo.formats, formats: all, rotate: 'turns' } }), []);
  } finally {
    cleanup();
  }
});

test('a form\'s picks: only the library\'s own, in its order', () => {
  assert.deepEqual(pickedFrom({ fmt_story: 'on', fmt_facts: 'on', fmt_meme: 'on', fmt_nope: 'on', other: 'x' }), ['facts', 'story']);
  assert.deepEqual(pickedFrom({}), []);
});

test('in turn: a format never used first, in the file\'s order, then the one used longest ago; samples count, a stopped post does not', () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = { id: 'demo', formats: { rotate: 'turns', formats: formatsFor(['facts', 'tips', 'story']) } };
    assert.equal(inTurns(pack), true);
    assert.deepEqual(turnOrder(ctx.db, pack), ['facts', 'tips', 'story'], 'none used: the file\'s order');
    const post = (format_id, status, at) => ctx.db.insert('posts', { id: `p-${format_id}-${at}`, account_id: 'demo', format_id, status, sample: status === 'sample' ? 1 : 0, created_at: at, updated_at: at });
    post('facts', 'sample', '2026-10-30T08:00:00.000Z');
    assert.deepEqual(turnOrder(ctx.db, pack), ['tips', 'story', 'facts'], 'a sample counts');
    post('tips', 'queued', '2026-10-30T09:00:00.000Z');
    post('story', 'blocked', '2026-10-30T10:00:00.000Z');
    assert.deepEqual(turnOrder(ctx.db, pack), ['story', 'facts', 'tips'], 'a stopped post never showed, so its format is still due');
    post('story', 'published', '2026-10-30T11:00:00.000Z');
    assert.deepEqual(turnOrder(ctx.db, pack), ['facts', 'tips', 'story']);
    assert.deepEqual(turnOrder(ctx.db, pack, { exclude: ['facts'] }), ['tips', 'story']);
    // A format taken off the list is never in turn again, though its posts stay.
    assert.deepEqual(turnOrder(ctx.db, { ...pack, formats: { ...pack.formats, formats: formatsFor(['tips', 'story', 'ranking']) } }), ['ranking', 'tips', 'story']);
  } finally {
    cleanup();
  }
});

test('the picks are written to the account\'s formats.json, in turn, the rest of the file kept; fewer than three are refused', () => {
  const { home, cleanup } = tempHome();
  try {
    const dir = path.join(home, 'packs', 'demo');
    const pack = loadPack(dir);
    const before = JSON.parse(readFileSync(path.join(dir, 'formats.json'), 'utf8'));
    assert.throws(() => setPackFormats(pack, ['facts', 'story']), /at least 3/);
    assert.throws(() => setPackFormats(pack, ['facts', 'story', 'meme']), /at least 3/, 'a format not in the library does not count');
    const list = setPackFormats(pack, ['story', 'facts', 'ranking']);
    assert.deepEqual(list.map((f) => f.id), ['facts', 'story', 'ranking']);
    const after = JSON.parse(readFileSync(path.join(dir, 'formats.json'), 'utf8'));
    assert.equal(after.rotate, 'turns');
    assert.deepEqual(after.formats.map((f) => f.id), ['facts', 'story', 'ranking']);
    assert.deepEqual(after.caption, before.caption, 'captions kept');
    assert.deepEqual(after.hashtags, before.hashtags, 'hashtags kept');
    assert.equal(inTurns(pack), true, 'the running pack knows at once');
    assert.deepEqual(pickedOf(pack), ['facts', 'story', 'ranking']);
    assert.deepEqual(validatePack(loadPack(dir)), [], 'still a valid pack');
  } finally {
    cleanup();
  }
});

test('each slideshow in a different format: three posts in turn through the real pipeline, offline', { timeout: 300_000 }, async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    // Three of the demo's formats the recordings cover, picked as a customer would, in turn.
    const keep = ['plant-story', 'plant-vs', 'myth-fact'];
    pack.formats = { ...pack.formats, rotate: 'turns', formats: pack.formats.formats.filter((f) => keep.includes(f.id)) };
    const made = [];
    for (let i = 0; i < 3; i++) {
      const res = await buildPost(ctx, { pack });
      assert.equal(res.status, 'queued', res.reason);
      made.push(ctx.db.get('SELECT format_id FROM posts WHERE id = ?', res.postId).format_id);
    }
    assert.deepEqual(made, keep, 'one after the other, none twice');
  } finally {
    cleanup();
  }
});
