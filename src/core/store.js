import { j } from '../db/index.js';
import { nowIso } from './clock.js';

// Small helpers over the database that every module needs: settings, the audit
// log, and a post's trace.

export function getSetting(db, key, fallback = null) {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', key);
  return row ? j(row.value_json, fallback) : fallback;
}

export function setSetting(db, key, value) {
  db.run(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
    key,
    JSON.stringify(value),
    nowIso()
  );
}

export function audit(db, { actor = 'engine', action, accountId = null, postId = null, detail = null }) {
  db.insert('audit', { at: nowIso(), actor, action, account_id: accountId, post_id: postId, detail_json: detail });
}

/** One step of a post's pipeline, written as it happens: the trace from slide to source. */
export function step(db, postId, name, status, detail = null, costUsd = 0) {
  db.insert('steps', { post_id: postId, step: name, status, detail_json: detail, cost_usd: costUsd, at: nowIso() });
}

/** Global defaults, overridable from the website. */
export const DEFAULT_SETTINGS = {
  globalKill: false,
  publishErrorStreak: 3,
  generateAt: '07:00',
  // The morning's feedback (src/metrics/feedback.js), Israel time; never after generateAt.
  feedbackAt: '06:30',
};

export function settings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(db, k, DEFAULT_SETTINGS[k]);
  return out;
}

/**
 * A paid or quota-limited lookup (a Brave search, a YouTube search), answered
 * from the `lookups` table while it is younger than `days`. Returns { value, cached }.
 */
export async function cachedLookup(db, key, days, fn) {
  const row = db.get('SELECT value_json, expires_at FROM lookups WHERE key = ?', key);
  if (row && row.expires_at > nowIso()) return { value: j(row.value_json, null), cached: true };
  const value = await fn();
  db.run(
    'INSERT INTO lookups (key, value_json, at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, at = excluded.at, expires_at = excluded.expires_at',
    key,
    JSON.stringify(value),
    nowIso(),
    new Date(Date.parse(nowIso()) + days * 86_400_000).toISOString()
  );
  return { value, cached: false };
}
