import { existsSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '../core/clock.js';
import { packsDir } from '../core/paths.js';
import { j } from '../db/index.js';

// What a new account's owner sets up on its onboarding while the sources are searched, before the account exists.
// Kept on the onboarding row (setup_json) and applied when the account is created (src/web/onboarding.js):
//
//   { displayName, handle }                    the name and the handle, offered again on the sources step
//   choice: { byDay, shabbat, holidays }       the days and times (src/schedule/choice.js), written to
//                                              schedule:<account> at create
//   zernio: { profileId, connections }         the Zernio profile made for the onboarding (externalId the onboarding
//                                              id) and what was connected into it, { tiktok: { id, username, status,
//                                              issue, checkedAt } }: the account takes the profile over at create
//                                              (src/publish/connect.js carryOnboardingZernio)

/** An onboarding's setup, {} when nothing was set. */
export const setupOf = (db, id) => j(db.get('SELECT setup_json FROM onboarding WHERE id = ?', id)?.setup_json, {}) || {};

/** Merge into an onboarding's setup. Returns the setup as saved. */
export function saveSetup(db, id, patch) {
  const next = { ...setupOf(db, id), ...patch };
  db.update('onboarding', id, { setup_json: next, updated_at: nowIso() });
  return next;
}

/** The pack id a handle makes (src/onboarding/pack.js createPack): lower case, a dash for anything else. */
export const packIdOf = (handle) =>
  String(handle || '')
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/** What the customer reads about a name or a handle that will not do. The same words on every page that asks. */
export const NAME_HE = {
  noName: 'צריך לכתוב את השם שלכם.',
  longName: 'השם ארוך מדי. אפשר עד 40 תווים.',
  badHandle: 'שם המשתמש צריך להיות באותיות באנגלית ובמספרים, לפחות שני תווים, למשל cafe.yafo',
  taken: 'שם המשתמש הזה כבר תפוס. בחרו שם אחר.',
  nameTaken: 'כבר יש חשבון בשם הזה. אפשר להוסיף לשם עוד מילה, למשל את העיר.',
};

/**
 * The name and handle checked as the create step checks them (createPack, then the packs' validation): returns
 * { displayName, handle } or { problems } in Hebrew. `packs` are every account on the server: a handle or a name any
 * of them has is taken, whoever's it is.
 */
export function checkName({ displayName, handle }, { packs = [] } = {}) {
  const name = String(displayName || '').trim();
  const raw = String(handle || '').trim().replace(/^@+/, '');
  const problems = [];
  if (!name) problems.push(NAME_HE.noName);
  else if (name.length > 40) problems.push(NAME_HE.longName);
  // Two accounts may not share a name either (src/packs/validate.js): said here, not as a failure at create.
  else if (packs.some((p) => String(p.meta?.displayName || '').trim() === name)) problems.push(NAME_HE.nameTaken);
  const id = packIdOf(raw);
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(id) || !/^[A-Za-z0-9._-]{2,30}$/.test(raw)) problems.push(NAME_HE.badHandle);
  else if (existsSync(path.join(packsDir(), id)) || packs.some((p) => p.id === id || p.meta?.handle === id.replace(/-/g, '.'))) problems.push(NAME_HE.taken);
  return problems.length ? { problems } : { displayName: name, handle: raw };
}

/** A connected account's username as a handle to offer, or '' when it would not make one. */
export function handleFromUsername(username) {
  const u = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,29}$/.test(u) ? u : '';
}
