import { DAY, now } from '../core/clock.js';
import { j } from '../db/index.js';
import { getSetting, setSetting } from '../core/store.js';
import { groupOf, hookPatterns, MIX } from './kinds.js';
import { TPL, templatesFor } from './hooks.js';

// Which format the next post gets, and what the account's own numbers say about
// each one.
//
//   - a post is scored 72 hours after it went out, per platform, against that
//     platform's own median: TikTok by (shares + likes) / views, Instagram by
//     saves / reach. TikTok reports no saves, and none is ever made up.
//   - first the group: entertaining or number formats, by the account's mix (60%
//     entertaining to start). The mix moves 5 points at a time, at most once a
//     week, within 40% to 80%, towards the group whose posts do better.
//   - 70% of posts use proven formats, weighted by configured weight times
//     results; 30% are trials, which take turns.
//   - a format whose last 3 results all sit under 70% of the median drops out,
//     with the reason kept. "Under the median" would retire an average format
//     inside a month: an average format is under it half the time.
//   - a trial with 3 results averaging at or above the median becomes proven.
//   - at least 2 proven formats always stay, so there is always something to build.
//   - a dropped format of the pack's own rests 14 days and returns as a trial.
//   - the cover pattern is chosen the same way inside a format: the less tried
//     patterns get their turns, the rest by their results.
//   - the cover templates (src/formats/hooks.js) are the engine's, not one
//     format's, so their results are pooled over all the account's formats: the
//     less tried get their turns, the rest by their results, and one whose last 3
//     results all sat under 70% of the median rests 14 days, like a format.

export const RULES = { provenShare: 0.7, dropAfter: 3, lossBelow: 0.7, minPosts: 3, keepProven: 2, restDays: 14, windowDays: 30 };

/**
 * One post's score on one platform, or null when there is nothing to divide by.
 * Instagram divides saves by reach (the accounts that saw it), or by views where
 * Meta reports no reach.
 */
export function postScore(platform, m) {
  const views = platform === 'instagram' ? Number(m?.reach) || Number(m?.views) || 0 : Number(m?.views) || 0;
  if (views <= 0) return null;
  if (platform === 'tiktok') return ((Number(m.shares) || 0) + (Number(m.likes) || 0)) / views;
  if (platform === 'instagram') return m.saves == null ? null : (Number(m.saves) || 0) / views;
  return null;
}

/** One row per format in formats.json; a format removed from the file stays in history. */
export function ensureFormats(db, pack) {
  for (const f of pack.formats.formats || []) {
    const have = db.get('SELECT id FROM formats WHERE account_id = ? AND format_key = ?', pack.id, f.id);
    if (!have) {
      db.insert('formats', { account_id: pack.id, format_key: f.id, kind: f.trial ? 'trial' : 'proven', status: 'active', weight: Number(f.weight) || 1, own: 1, results_json: [] });
    } else {
      db.run('UPDATE formats SET weight = ? WHERE id = ?', Number(f.weight) || 1, have.id);
    }
  }
}

const rowsOf = (db, accountId) => db.all('SELECT * FROM formats WHERE account_id = ?', accountId).map((r) => ({ ...r, results: j(r.results_json, []) }));

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Each format's results inside the window, as score over its platform's median (1 = typical). */
export function relative(rows, { t = now(), windowDays = RULES.windowDays } = {}) {
  const since = t - windowDays * DAY;
  const all = rows.flatMap((f) => f.results.filter((r) => Date.parse(r.at) >= since));
  const med = {};
  for (const p of ['tiktok', 'instagram']) med[p] = median(all.filter((r) => r.platform === p).map((r) => r.score));
  const out = {};
  for (const f of rows) out[f.format_key] = f.results.filter((r) => Date.parse(r.at) >= since && med[r.platform]).map((r) => ({ ...r, rel: r.score / med[r.platform] }));
  return out;
}

/**
 * Credit metrics at least 72 hours old to their post's format, once per post and
 * platform. Uses the newest reading taken at or after 72 hours.
 */
export function credit(db, accountId, { t = now(), minAgeHours = 72 } = {}) {
  const rows = rowsOf(db, accountId);
  const byKey = new Map(rows.map((r) => [r.format_key, r]));
  let n = 0;
  const posts = db.all("SELECT id, format_id, published_at FROM posts WHERE account_id = ? AND status = 'published' AND published_at IS NOT NULL", accountId);
  for (const p of posts) {
    if (t - Date.parse(p.published_at) < minAgeHours * 3_600_000) continue;
    const f = byKey.get(p.format_id);
    if (!f) continue;
    for (const platform of ['tiktok', 'instagram']) {
      if (f.results.some((r) => r.post === p.id && r.platform === platform)) continue;
      const m = db.get('SELECT * FROM metrics WHERE post_id = ? AND platform = ? AND age_hours >= ? ORDER BY collected_at DESC LIMIT 1', p.id, platform, minAgeHours);
      const score = postScore(platform, m);
      if (score == null) continue;
      f.results.push({ post: p.id, platform, score, at: new Date(t).toISOString() });
      n++;
    }
  }
  for (const f of rows) db.run('UPDATE formats SET results_json = ? WHERE id = ?', JSON.stringify(f.results), f.id);
  return n;
}

/** Drop, promote and bring back. Returns [{ format, change, why }]. */
export function judge(db, accountId, { t = now(), ...opts } = {}) {
  const R = { ...RULES, ...opts };
  const rows = rowsOf(db, accountId);
  const changes = [];
  const iso = new Date(t).toISOString();
  for (const f of rows) {
    if (f.own && f.status === 'dropped' && t - Date.parse(f.dropped_at || 0) >= R.restDays * DAY) {
      Object.assign(f, { status: 'active', kind: 'trial', results: [], returned_at: iso });
      changes.push({ format: f.format_key, change: 'returned', why: `חזר לניסיון אחרי ${R.restDays} ימי מנוחה` });
    }
  }
  const rel = relative(rows, { t, windowDays: R.windowDays });
  for (const f of rows) {
    if (f.status !== 'active') continue;
    const mine = (rel[f.format_key] || []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const lastN = mine.slice(-R.dropAfter);
    if (lastN.length === R.dropAfter && lastN.every((r) => r.rel < R.lossBelow)) {
      const activeProven = rows.filter((x) => x.status === 'active' && x.kind === 'proven');
      if (f.kind === 'proven' && activeProven.length <= R.keepProven) continue;
      f.status = 'dropped';
      f.dropped_at = iso;
      f.dropped_why = `${R.dropAfter} פעמים ברצף מתחת ל-${Math.round(R.lossBelow * 100)}% מהחציון (${lastN.map((r) => r.rel.toFixed(2)).join(', ')})`;
      changes.push({ format: f.format_key, change: 'dropped', why: f.dropped_why });
      continue;
    }
    if (f.kind === 'trial' && mine.length >= R.minPosts) {
      const avg = mine.reduce((s, r) => s + r.rel, 0) / mine.length;
      if (avg >= 1) {
        f.kind = 'proven';
        f.promoted_at = iso;
        changes.push({ format: f.format_key, change: 'promoted', why: `ממוצע ${avg.toFixed(2)} מהחציון אחרי ${mine.length} פוסטים` });
      }
    }
  }
  for (const f of rows) {
    db.update('formats', f.id, {
      status: f.status,
      kind: f.kind,
      results_json: JSON.stringify(f.results),
      dropped_at: f.dropped_at || null,
      dropped_why: f.dropped_why || null,
      promoted_at: f.promoted_at || null,
      returned_at: f.returned_at || null,
    });
  }
  return changes;
}

/**
 * The next post's format key. `recent` is the account's last picks, newest last,
 * as [{ kind, format }]. Trials when they are under their 30% share; otherwise a
 * proven format weighted by weight x relative score (clamped 0.5 to 2). The
 * format of the previous post is avoided when anything else is available.
 */
export function pickFormat(db, accountId, { recent = null, rand = Math.random, exclude = [], t = now(), groups = null, mix = null } = {}) {
  let rows = rowsOf(db, accountId).filter((f) => f.status === 'active' && !exclude.includes(f.format_key));
  if (!rows.length) return null;
  const picks =
    recent ||
    db
      .all("SELECT p.format_id AS format, p.grp, f.kind FROM posts p LEFT JOIN formats f ON f.account_id = p.account_id AND f.format_key = p.format_id WHERE p.account_id = ? AND p.status NOT IN ('blocked','sample') ORDER BY p.created_at DESC LIMIT 20", accountId)
      .reverse();
  // The group first: whichever is under its share of the recent posts.
  const g = (key) => groups?.[key] || 'number';
  if (groups && mix != null && new Set(rows.map((f) => g(f.format_key))).size > 1) {
    const recentGroups = picks.map((p) => p.grp || groups[p.format]).filter(Boolean);
    const share = recentGroups.length ? recentGroups.filter((x) => x === 'entertaining').length / recentGroups.length : 0;
    const want = share < mix ? 'entertaining' : 'number';
    rows = rows.filter((f) => g(f.format_key) === want);
  }
  const last = picks[picks.length - 1]?.format;
  const avoid = (list) => {
    const kept = list.filter((f) => f.format_key !== last);
    return kept.length ? kept : list;
  };
  const trials = rows.filter((f) => f.kind === 'trial');
  const trialShare = picks.length ? picks.filter((p) => p.kind === 'trial').length / picks.length : 0;
  if (trials.length && trialShare < 1 - RULES.provenShare) {
    const offered = (f) => picks.filter((p) => p.format === f.format_key).length;
    return avoid(trials).sort((a, b) => offered(a) - offered(b) || a.results.length - b.results.length)[0].format_key;
  }
  const rel = relative(rowsOf(db, accountId), { t });
  const proven = avoid(rows.filter((f) => f.kind === 'proven'));
  const pool = proven.length ? proven : avoid(rows);
  const w = (f) => {
    const r = rel[f.format_key] || [];
    const perf = r.length ? Math.min(2, Math.max(0.5, r.reduce((s, x) => s + x.rel, 0) / r.length)) : 1;
    return (f.weight || 1) * perf;
  };
  const total = pool.reduce((s, f) => s + w(f), 0);
  let x = rand() * total;
  for (const f of pool) {
    x -= w(f);
    if (x <= 0) return f.format_key;
  }
  return pool[pool.length - 1].format_key;
}

/** format_key -> 'entertaining' | 'number', from the pack's formats. */
export const groupsOf = (pack) => Object.fromEntries((pack.formats.formats || []).map((f) => [f.id, groupOf(f)]));

const clampMix = (x) => Math.min(MIX.max, Math.max(MIX.min, Math.round(x * 100) / 100));

/**
 * The account's share of entertaining posts now: what its results moved it to,
 * or the pack's own setting (formats.json "mix"), or 60%. Null when the pack has
 * formats of one group only.
 */
export function mixOf(db, pack) {
  if (new Set(Object.values(groupsOf(pack))).size < 2) return null;
  const learned = getSetting(db, `mix:${pack.id}`, null);
  if (learned?.share != null) return clampMix(learned.share);
  return clampMix(Number(pack.formats.mix?.entertaining ?? MIX.default));
}

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * Move the mix towards the group that does better: at least 3 results in each
 * group inside the window, a 10% difference between their median scores, 5
 * points a step, at most once a week, within 40% to 80%. Returns the change with
 * its reason in plain Hebrew, or null.
 */
export function learnMix(db, pack, { t = now(), minResults = 3, margin = 1.1, everyDays = 7 } = {}) {
  const current = mixOf(db, pack);
  if (current == null) return null;
  const last = getSetting(db, `mix:${pack.id}`, null);
  if (last?.at && t - Date.parse(last.at) < everyDays * DAY) return null;
  const groups = groupsOf(pack);
  const rel = relative(rowsOf(db, pack.id), { t });
  const by = { entertaining: [], number: [] };
  for (const [key, list] of Object.entries(rel)) for (const r of list) by[groups[key] || 'number'].push(r.rel);
  if (by.entertaining.length < minResults || by.number.length < minResults) return null;
  const e = median(by.entertaining);
  const n = median(by.number);
  let next = current;
  if (e > n * margin) next = clampMix(current + MIX.step);
  else if (n > e * margin) next = clampMix(current - MIX.step);
  if (next === current) return null;
  const why =
    next > current
      ? `פוסטים של בידור עשו פי ${(e / n).toFixed(1)} מפוסטים של מספרים (חציון של ${by.entertaining.length} מול ${by.number.length} תוצאות), אז יותר בידור: ${pct(current)} ← ${pct(next)}`
      : `פוסטים של מספרים עשו פי ${(n / e).toFixed(1)} מפוסטים של בידור (חציון של ${by.number.length} מול ${by.entertaining.length} תוצאות), אז פחות בידור: ${pct(current)} ← ${pct(next)}`;
  setSetting(db, `mix:${pack.id}`, { share: next, from: current, at: new Date(t).toISOString(), why });
  return { from: current, to: next, why };
}

/**
 * Each cover pattern's results, per format: { [format]: { [hook]: { n, avg } } },
 * where avg is the mean score over its platform's median (1 = typical).
 */
export function hookStats(db, accountId, { t = now() } = {}) {
  const rel = relative(rowsOf(db, accountId), { t });
  const hookOf = new Map(db.all('SELECT id, hook_pattern FROM posts WHERE account_id = ? AND hook_pattern IS NOT NULL', accountId).map((r) => [r.id, r.hook_pattern]));
  const out = {};
  for (const [format, list] of Object.entries(rel)) {
    for (const r of list) {
      const h = hookOf.get(r.post);
      if (!h) continue;
      const cell = ((out[format] ??= {})[h] ??= { n: 0, sum: 0 });
      cell.n++;
      cell.sum += r.rel;
    }
  }
  for (const f of Object.values(out)) for (const c of Object.values(f)) c.avg = c.sum / c.n;
  return out;
}

/**
 * The cover pattern for the next post of a format. A pattern used fewer than
 * `minTries` times gets its turn first (the least used); after that, one post in
 * three tries the least used pattern and the rest are weighted by results
 * (clamped 0.5 to 2), so a pattern that keeps losing fades without vanishing.
 * Returns { id, pattern, examples } or null.
 */
export function pickHook(db, accountId, format, { rand = Math.random, t = now(), minTries = 2 } = {}) {
  const list = hookPatterns(format);
  if (!list.length) return null;
  const used = new Map(
    db
      .all("SELECT hook_pattern AS h, COUNT(*) AS n FROM posts WHERE account_id = ? AND format_id = ? AND hook_pattern IS NOT NULL AND status NOT IN ('blocked') GROUP BY hook_pattern", accountId, format.id)
      .map((r) => [r.h, r.n])
  );
  const n = (h) => used.get(h.id) || 0;
  const least = list.slice().sort((a, b) => n(a) - n(b))[0];
  if (n(least) < minTries || rand() < 0.3) return least;
  const stats = hookStats(db, accountId, { t })[format.id] || {};
  const w = (h) => (stats[h.id] ? Math.min(2, Math.max(0.5, stats[h.id].avg)) : 1);
  const total = list.reduce((s, h) => s + w(h), 0);
  let x = rand() * total;
  for (const h of list) {
    x -= w(h);
    if (x <= 0) return h;
  }
  return list[list.length - 1];
}

/**
 * Each cover template's results over all the account's formats: { [template id]: { n, avg, last: [rel] } }, where
 * avg is the mean score over its platform's median (1 = typical) and last the results in time order. A post that
 * opened with a template stores "tpl:<id>" as its hook_pattern.
 */
export function templateStats(db, accountId, { t = now() } = {}) {
  const rel = relative(rowsOf(db, accountId), { t });
  const tplOf = new Map(db.all("SELECT id, hook_pattern FROM posts WHERE account_id = ? AND hook_pattern LIKE 'tpl:%'", accountId).map((r) => [r.id, r.hook_pattern.slice(TPL.length)]));
  const out = {};
  for (const r of Object.values(rel).flat().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const id = tplOf.get(r.post);
    if (!id) continue;
    const cell = (out[id] ??= { n: 0, sum: 0, last: [], lastAt: null });
    cell.n++;
    cell.sum += r.rel;
    cell.last.push(r.rel);
    cell.lastAt = r.at;
  }
  for (const c of Object.values(out)) c.avg = c.sum / c.n;
  return out;
}

/** A template that keeps losing rests: its last `dropAfter` results all under `lossBelow`, the last within `restDays`. */
export function resting(cell, { t = now(), ...opts } = {}) {
  const R = { ...RULES, ...opts };
  const last = (cell?.last || []).slice(-R.dropAfter);
  return last.length === R.dropAfter && last.every((x) => x < R.lossBelow) && t - Date.parse(cell.lastAt) < R.restDays * DAY;
}

/**
 * The cover templates to offer the writer for the next post of a format, best first: up to `n`, each of another
 * mechanism where there are enough. As pickHook does for patterns: a template used fewer than `minTries` times gets
 * its turn first (the least used), then one pick in three is the least used and the rest are weighted by results
 * (clamped 0.5 to 2). A resting template is left out while anything else is there. `avoid`: a template id
 * ("tpl:<id>" or "<id>") whose cover did not pull, left out with its whole mechanism. Returns templates.
 */
export function pickTemplates(db, pack, format, { rand = Math.random, t = now(), n = 3, minTries = 2, avoid = null } = {}) {
  const avoidId = String(avoid || '').replace(/^tpl:/, '');
  const all = templatesFor(pack, format);
  const away = all.find((x) => x.id === avoidId)?.mechanism;
  let list = all.filter((x) => x.id !== avoidId && x.mechanism !== away);
  if (!list.length) return [];
  const stats = templateStats(db, pack.id, { t });
  const rested = list.filter((x) => !resting(stats[x.id], { t }));
  if (rested.length) list = rested;
  const used = new Map(db.all("SELECT hook_pattern AS h, COUNT(*) AS n FROM posts WHERE account_id = ? AND hook_pattern LIKE 'tpl:%' AND status NOT IN ('blocked') GROUP BY hook_pattern", pack.id).map((r) => [r.h.slice(TPL.length), r.n]));
  const u = (x) => used.get(x.id) || 0;
  const w = (x) => (stats[x.id] ? Math.min(2, Math.max(0.5, stats[x.id].avg)) : 1);
  const out = [];
  while (out.length < n) {
    const left = list.filter((x) => !out.includes(x));
    if (!left.length) break;
    // Another mechanism first: three ways to open, not three wordings of one.
    const fresh = left.filter((x) => !out.some((o) => o.mechanism === x.mechanism));
    const pool = fresh.length ? fresh : left;
    const least = pool.slice().sort((a, b) => u(a) - u(b))[0];
    if (u(least) < minTries || rand() < 0.3) {
      out.push(least);
      continue;
    }
    const total = pool.reduce((s, x) => s + w(x), 0);
    let r = rand() * total;
    out.push(pool.find((x) => (r -= w(x)) <= 0) || pool[pool.length - 1]);
  }
  return out;
}
