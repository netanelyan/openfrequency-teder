import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../core/store.js';
import { DAY, now, nowIso } from '../core/clock.js';
import { isTemplate } from './templates/registry.js';
import { themeOf } from './styles/index.js';
import { setPackStyle } from '../packs/write.js';

// An account's look, locked: the base style every post is drawn in, saved the first time the account renders.
//
// theme.json is the account's look, but it is a file anyone can change, and a change took effect on the next
// render: two posts of one day could come out in two looks, and a post edited after a theme change was drawn again
// in the new one, half its slides already out in the old. Now the look is saved (settings `style:<account>`) and
// every render draws from the saved one. A change to theme.json waits, and the Accounts page says so, until the
// owner applies it. Each post keeps the hash of the look it was drawn in, and drawing it again (an edit) uses that
// one, so a post never mixes two.
//
// The look includes the account's slide style (pack.json "style", src/render/styles) when it has one: a style
// chosen in pack.json waits the same way, and one the owner picks on the Accounts page is applied at once.
//
// HARD RULE 2 comes first: a saved look whose template and variant another account now uses in its theme.json is
// given up for this account's own current theme.json, so two accounts never draw the same look. Under the slide
// styles two accounts may share a style, never a style and its accent.

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

/** A look's hash: the same theme, in any key order, has the same one. */
export const styleHash = (theme) => createHash('sha256').update(JSON.stringify(canon(theme))).digest('hex').slice(0, 12);

const lookOf = (theme) => (theme?.style ? `style/${theme.style.name}/${String(theme.style.colors?.accent || '').toLowerCase()}` : `${theme?.template}/${theme?.variant || 'a'}`);

function keep(db, id, theme) {
  const t = canon(theme);
  const hash = styleHash(t);
  // Every look a post was drawn in stays, by its hash, for drawing that post again.
  setSetting(db, `style:${id}:${hash}`, t);
  return { hash, theme: t };
}

function save(db, id, theme) {
  const { hash, theme: t } = keep(db, id, theme);
  const lock = { hash, theme: t, at: nowIso() };
  setSetting(db, `style:${id}`, lock);
  return lock;
}

/**
 * The look an account draws in now: { theme, hash, at, pending }. `pending` is the hash of a theme.json (with its
 * pack.json style) that differs from the saved look, waiting for the owner; null when they agree. `packs`: every
 * account, for hard rule 2.
 */
export function lockedStyle(db, pack, packs = []) {
  const now = styleHash(themeOf(pack));
  let lock = getSetting(db, `style:${pack.id}`, null);
  // Another account of the same customer (or another of the operator's own), as looks are kept apart
  // (src/packs/validate.js validateAll): another customer's account may look the same.
  const group = (id) => db.get('SELECT workspace_id FROM accounts WHERE id = ?', id)?.workspace_id ?? null;
  const mine = group(pack.id);
  const clash = lock && packs.some((o) => o.id !== pack.id && group(o.id) === mine && lookOf(themeOf(o)) === lookOf(lock.theme));
  // No saved look yet, one the library no longer has, or one another account now uses: theme.json, saved.
  if (!lock || !isTemplate(lock.theme?.template, lock.theme?.variant || 'a') || clash) lock = save(db, pack.id, themeOf(pack));
  return { theme: lock.theme, hash: lock.hash, at: lock.at, pending: lock.hash !== now ? now : null };
}

/** The owner applies theme.json and pack.json's style: they become the saved look. */
export const lockStyle = (db, pack) => save(db, pack.id, themeOf(pack));

/** The look one post was drawn in, by its hash, or null when it was drawn before looks were saved. */
export function styleByHash(db, pack, hash) {
  const theme = hash ? getSetting(db, `style:${pack.id}:${hash}`, null) : null;
  return theme && isTemplate(theme.template, theme.variant || 'a') ? { theme, hash } : null;
}

/* ------------------------------------------------------------------------------------------------- style test */

// A style test (pack.json style.test, off unless the owner turns it on): for its first 14 days an account's posts
// are drawn in turn in the two styles that fit it best (src/onboarding/style.js), and then the feedback loop
// (src/metrics/feedback.js settleStyleTest) picks the one whose posts did better and locks it.

export const STYLE_TEST_DAYS = 14;

/** The account's style test: { styles: [a, b], from, until, n, winner, result } or null. */
export const styleTest = (db, pack) => getSetting(db, `style-test:${pack.id}`, null);

/** Start a style test between two styles (the account's own first). */
export function startStyleTest(db, pack, styles, t = now()) {
  const test = { styles: styles.slice(0, 2), from: new Date(t).toISOString(), until: new Date(t + STYLE_TEST_DAYS * DAY).toISOString(), n: 0, winner: null, result: null };
  setSetting(db, `style-test:${pack.id}`, test);
  return test;
}

export const saveStyleTest = (db, pack, test) => setSetting(db, `style-test:${pack.id}`, test);

/**
 * The slide style the next post of an account is drawn in, by name, or null for the older templates: the locked
 * look's, or, while a style test runs, its two styles in turn.
 */
export function styleForPost(db, pack, packs = [], t = now()) {
  const locked = lockedStyle(db, pack, packs).theme.style?.name || null;
  const test = pack.meta?.style?.test ? styleTest(db, pack) : null;
  if (!test || test.winner || Date.parse(test.until) <= t || test.styles.length < 2) return locked;
  const name = test.styles[test.n % 2];
  saveStyleTest(db, pack, { ...test, n: test.n + 1 });
  return name;
}

/** The look a post drawn in style `name` uses: the locked one when it is that style, else that style saved by its hash. */
export function lookFor(db, pack, name, packs = []) {
  const lock = lockedStyle(db, pack, packs);
  if (lock.theme.style?.name === name) return lock;
  return keep(db, pack.id, themeOf(pack, name));
}

/**
 * The owner (or a settled style test) picks the account's slide style: pack.json "style" names it, and it is the
 * saved look from the next post on. Posts already drawn keep theirs. `patch`: more of the style to set ({ test }).
 */
export function chooseStyle(db, pack, name, patch = {}) {
  setPackStyle(pack, { ...patch, name });
  return lockStyle(db, pack);
}
