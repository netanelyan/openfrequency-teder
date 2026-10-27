import { israelInstant, israelHour, weekday } from './israel.js';
import { restAt } from './shabbat.js';

// The day's posting slots for one account.
//
// Slots are Israel wall-clock times from the pack (`schedule.slots`, with
// `schedule.slotsByDay` overriding a weekday, 0 Sunday ... 6 Saturday, so Friday
// can post early and Saturday after nightfall). A slot inside Shabbat, a yom tov or outside
// the pack's posting windows is dropped AND named, because a configured slot that
// can never post is a mistake in the file and the website should say so rather
// than quietly posting less.

export function inWindows(t, windows = []) {
  if (!windows.length) return true;
  const h = israelHour(t);
  return windows.some(([a, b]) => h >= a && h < b);
}

/**
 * How many posts a day's rate allows on one Israel date, or null for no limit. A whole rate is that many every day;
 * a pack can set a fraction (1.5 is two posts one day and one the next, 0.5 a post every other day), spread
 * evenly over the calendar.
 */
export function postsOn(date, perDay) {
  const p = Number(perDay);
  if (!(p > 0)) return null;
  if (Number.isInteger(p)) return p;
  const n = Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return Math.floor((n + 1) * p) - Math.floor(n * p);
}

/**
 * { slots: Date[], dropped: [{ at, why }] } for one account on one Israel date. A schedule with `perMonth` (the
 * customer's own, src/schedule/choice.js) keeps only the slots its month's plan has room for (monthSlots below).
 */
export function slotsFor(date, schedule = {}, { notBefore = null } = {}) {
  const day = schedule.slotsByDay?.[String(weekday(date))] || schedule.slots || [];
  const kept = schedule.perMonth != null ? new Set(monthSlots(date.slice(0, 7), schedule).slots.map((s) => s.getTime())) : null;
  const dropped = [];
  const slots = [];
  for (const hhmm of day) {
    const at = israelInstant(date, hhmm);
    const rest = restAt(at);
    if (rest) dropped.push({ at: hhmm, why: rest });
    else if (!inWindows(at, schedule.windows)) dropped.push({ at: hhmm, why: 'מחוץ לשעות הפרסום' });
    else if (kept && !kept.has(at.getTime())) dropped.push({ at: hhmm, why: 'מעבר לחבילה החודשית' });
    else if (notBefore != null && at.getTime() < notBefore) dropped.push({ at: hhmm, why: 'השעה עברה' });
    else slots.push(at);
  }
  const cap = postsOn(date, schedule.postsPerDay) ?? slots.length;
  return { slots: slots.slice(0, cap), dropped };
}

/** Every Israel date of a month, 'YYYY-MM' -> ['YYYY-MM-01', ...]. */
export function datesOf(month) {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

const thinned = new Map();

/**
 * A month's slots, thinned to a plan: { slots: Date[] (the ones kept), all: how many before thinning }. A schedule with
 * more slots in a month than `perMonth` drops the extra ones evenly over the month, a day's second slot first, so a
 * plan of 40 posts lasts the whole month instead of running out in its third week. Shabbat and the festivals are
 * dropped before any of this, and a month with fewer slots than the plan keeps them all.
 */
export function monthSlots(month, schedule = {}, perMonth = schedule.perMonth) {
  const plain = { ...schedule, perMonth: null };
  const key = `${month}|${perMonth}|${JSON.stringify(plain)}`;
  if (thinned.has(key)) return thinned.get(key);
  const days = datesOf(month).map((d) => slotsFor(d, plain).slots);
  const all = days.flat();
  let keep = all;
  const cap = Number(perMonth);
  if (perMonth != null && Number.isInteger(cap) && cap >= 0 && all.length > cap) {
    const drop = new Set();
    const spread = (list, n) => {
      for (let i = 0; i < n; i++) drop.add(list[Math.floor(((i + 0.5) * list.length) / n)]);
    };
    const seconds = days.flatMap((d) => d.slice(1));
    const extra = all.length - cap;
    spread(seconds, Math.min(extra, seconds.length));
    if (extra > seconds.length) spread(all.filter((s) => !drop.has(s)), extra - seconds.length);
    keep = all.filter((s) => !drop.has(s));
  }
  const out = { slots: keep, all: all.length };
  if (thinned.size > 500) thinned.clear();
  thinned.set(key, out);
  return out;
}
