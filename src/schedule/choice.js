import { audit, getSetting, setSetting } from '../core/store.js';
import { nowIso } from '../core/clock.js';
import { planOf } from '../budget/quota.js';
import { addDays, israelDate } from './israel.js';
import { datesOf, monthSlots, slotsFor } from './slots.js';

// The days and times an account posts on, as its owner chooses them (Settings, and the new-account flow before it
// goes live). The choice is kept in settings under schedule:<account id>, one list of up to two "HH:MM" a weekday
// (0 Sunday ... 6 Saturday), and it is laid over the pack's schedule (pack.json): it replaces the slots, the posting
// windows and the posts a day, and keeps the rest of the pack's (a fight week, say).
//
// Two rules the choice cannot change:
//   - Shabbat and the festivals never post. A time inside them is kept in the choice (a Saturday at 12:30 is a
//     Saturday after nightfall in no season) and dropped by slotsFor on the day itself, as every pack's is.
//   - The month's plan (src/budget/quota.js, 40 posts) is the most a month gets. A choice with more slots than that is
//     thinned evenly over the month, a day's second time first (monthSlots), so the posts last the whole month.
//
// An account without a choice keeps its pack's schedule, exactly as before.

export const MAX_PER_DAY = 2;
export const EARLIEST = '06:00';
export const LATEST = '23:30';
/** Two times on one day are at least this far apart. */
export const MIN_GAP_MIN = 60;

/**
 * The choice a new account starts with: two posts on Sunday to Thursday, one on Friday before Shabbat and one on
 * Saturday night. About 51 slots in a month, so the plan's 40 are reached even in a month of festivals, and thinned to
 * the plan the rest of the year.
 */
export const DEFAULT_CHOICE = { 0: ['12:30', '19:30'], 1: ['12:30', '19:30'], 2: ['12:30', '19:30'], 3: ['12:30', '19:30'], 4: ['12:30', '19:30'], 5: ['12:30'], 6: ['21:00'] };

export const DAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const key = (accountId) => `schedule:${accountId}`;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** An account's saved choice, { 0: [...], ..., 6: [...] }, or null when it has none. */
export function choiceOf(db, accountId) {
  const v = getSetting(db, key(accountId), null);
  return v?.byDay ? normal(v.byDay) : null;
}

const normal = (byDay) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [...(byDay[d] || byDay[String(d)] || [])].sort()]));

/**
 * The schedule the engine follows for an account: its pack's, or the pack's with the customer's choice laid over it.
 * Every reader of an account's slots goes through this (src/autonomy/runner.js).
 */
export function scheduleOf(db, pack) {
  const base = pack.meta?.schedule || {};
  const choice = choiceOf(db, pack.id);
  if (!choice) return base;
  return { ...base, slots: [], slotsByDay: Object.fromEntries(Object.entries(choice).map(([d, list]) => [d, list])), windows: [], postsPerDay: MAX_PER_DAY, perMonth: planOf(db, pack.id).suggested, chosen: true };
}

/** Every time of day an account's schedule posts at, sorted: the pack's slots, or every time the customer chose. */
export const timesOf = (sched = {}) => (sched.chosen ? [...new Set(Object.values(sched.slotsByDay || {}).flat())].sort() : sched.slots || []);

/**
 * Read a choice from the form: day_<d> on, t1_<d> and t2_<d> the times. Returns { byDay } or { problems } (Hebrew,
 * for the customer).
 */
export function readChoice(form) {
  const problems = [];
  const byDay = {};
  for (let d = 0; d < 7; d++) {
    const on = form[`day_${d}`] === 'on' || form[`day_${d}`] === '1';
    const times = [form[`t1_${d}`], form[`t2_${d}`]].map((x) => String(x ?? '').trim()).filter(Boolean);
    byDay[d] = [];
    if (!on) continue;
    if (!times.length) {
      problems.push(`ביום ${DAY_HE[d]} חסרה שעה`);
      continue;
    }
    if (times.length > MAX_PER_DAY) problems.push(`ביום ${DAY_HE[d]} אפשר עד ${MAX_PER_DAY} שעות`);
    const bad = times.filter((t) => !HHMM.test(t));
    if (bad.length) {
      problems.push(`ביום ${DAY_HE[d]} השעה צריכה להיות כמו 19:30`);
      continue;
    }
    if (times.some((t) => t < EARLIEST || t > LATEST)) {
      problems.push(`ביום ${DAY_HE[d]} אפשר לבחור שעה בין ${EARLIEST} ל-${LATEST}`);
      continue;
    }
    const sorted = [...new Set(times)].sort();
    if (sorted.length === 2 && minutes(sorted[1]) - minutes(sorted[0]) < MIN_GAP_MIN) {
      problems.push(`ביום ${DAY_HE[d]} צריך לפחות שעה בין שני הפוסטים`);
      continue;
    }
    byDay[d] = sorted.slice(0, MAX_PER_DAY);
  }
  if (!problems.length && !Object.values(byDay).some((l) => l.length)) problems.push('צריך לבחור לפחות יום אחד');
  return problems.length ? { problems } : { byDay };
}

/** Save an account's choice. */
export function saveChoice(db, accountId, byDay, { actor = 'engine' } = {}) {
  const clean = normal(byDay);
  setSetting(db, key(accountId), { byDay: clean, at: nowIso() });
  audit(db, { actor, action: 'schedule', accountId, detail: { byDay: clean } });
  return clean;
}

/**
 * What a choice gives in a month, for the page to say: { month, slots (kept), all (before the plan), plan, rest (how
 * many of the chosen times fall on Shabbat or a festival) }.
 */
export function monthOf(db, pack, { t = Date.now(), byDay = null } = {}) {
  const sched = byDay ? { ...scheduleOf(db, pack), slots: [], slotsByDay: normal(byDay), windows: [], postsPerDay: MAX_PER_DAY, perMonth: planOf(db, pack.id).suggested } : scheduleOf(db, pack);
  // Next month, a whole one: this month is partly gone already.
  const today = israelDate(t);
  const month = addDays(`${today.slice(0, 7)}-28`, 7).slice(0, 7);
  const plain = { ...sched, perMonth: null };
  const all = monthSlots(month, plain).all;
  const kept = sched.perMonth != null ? monthSlots(month, sched).slots.length : all;
  let rest = 0;
  for (const d of datesOf(month)) rest += slotsFor(d, plain).dropped.filter((x) => x.why !== 'מחוץ לשעות הפרסום').length;
  return { month, slots: kept, all, plan: planOf(db, pack.id).suggested, rest };
}
