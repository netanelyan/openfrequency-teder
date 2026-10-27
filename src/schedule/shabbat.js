import { israelDate, wallClock, addDays, weekday } from './israel.js';
import { sunset, JERUSALEM } from './sun.js';
import { yomTovOn } from './hebrew.js';

// HARD RULE 9: nothing posts from Friday sunset to Saturday night, Israel time,
// nor on a yom tov (Rosh Hashana, Yom Kippur, the first and last days of Sukkot
// and Pesach, Shavuot), from the evening before. The festival dates come from
// the Hebrew calendar, computed (hebrew.js). A run of rest days (a yom tov next
// to Shabbat, the two days of Rosh Hashana) is one window.
//
// That is the default, and it stays the default. An account's owner may choose to post on Shabbat, on the festivals,
// or on both (src/schedule/choice.js; an operator's pack.json says it as schedule.shabbat / schedule.holidays). The
// choice reaches every function here as two options, { shabbat: true } and { holidays: true }, each meaning "posting
// is allowed then": a day the account posts on is no rest day for it. Without them, nothing changes. A yom tov on a
// Saturday is a rest day unless both are allowed.
//
// The window is computed from the real sunset for that week rather than fixed
// hours, with a margin on both sides:
//
//   from  Friday sunset minus CANDLE_MINUTES (candle lighting; Jerusalem's custom
//         is 40, most of the country lights 20 to 30 minutes before)
//   to    Saturday sunset plus HAVDALAH_MINUTES (nightfall is about 40 minutes
//         after sunset; a few more for anyone who waits longer)
//
// The margins are deliberately on the wide side. An hour of reach at the edges of
// a window the audience is not in costs nothing; posting into Shabbat is the one
// thing this rule exists to prevent. Both are clamped so a configuration cannot
// shrink the window below the halachic minimum.

export const CANDLE_MINUTES = 40;
export const HAVDALAH_MINUTES = 50;
const MIN_CANDLE = 18;
const MIN_HAVDALAH = 40;

/** The Shabbat window that contains or follows the week of `t`, as { from, to } Dates. */
export function shabbatWindow(t, { candle = CANDLE_MINUTES, havdalah = HAVDALAH_MINUTES, place = JERUSALEM } = {}) {
  const c = Math.max(MIN_CANDLE, Number(candle) || CANDLE_MINUTES);
  const h = Math.max(MIN_HAVDALAH, Number(havdalah) || HAVDALAH_MINUTES);
  const date = israelDate(t);
  const day = wallClock(t).day;
  // The Friday of this week (Saturday belongs to the window that began yesterday).
  const friday = addDays(date, day === 6 ? -1 : 5 - day);
  const saturday = addDays(friday, 1);
  return {
    from: new Date(sunset(friday, place).getTime() - c * 60_000),
    to: new Date(sunset(saturday, place).getTime() + h * 60_000),
  };
}

/**
 * Why an Israel date (YYYY-MM-DD) is a rest day: the festival's name, "שבת", or null. `shabbat` / `holidays` true:
 * the account posts then, so that day is no rest day for it.
 */
export function restDay(date, { shabbat = false, holidays = false } = {}) {
  return (!holidays && yomTovOn(date)) || (!shabbat && weekday(date) === 6 ? 'שבת' : null);
}

/** The two options a schedule carries to the functions here: { shabbat, holidays }, true where it posts anyway. */
export const rulesOf = (schedule = {}) => ({ shabbat: schedule?.shabbat === true, holidays: schedule?.holidays === true });

const margins = ({ candle = CANDLE_MINUTES, havdalah = HAVDALAH_MINUTES } = {}) => ({
  c: Math.max(MIN_CANDLE, Number(candle) || CANDLE_MINUTES) * 60_000,
  h: Math.max(MIN_HAVDALAH, Number(havdalah) || HAVDALAH_MINUTES) * 60_000,
});

/**
 * The rest day this instant belongs to, with the margins, or null. A rest day D
 * runs from candle lighting on the evening before to nightfall on D, so an
 * instant on Israel date d is inside one when d is a rest day and it is before
 * d's nightfall, or d+1 is one and it is after d's candle lighting.
 */
export function restAt(t, { place = JERUSALEM, ...opts } = {}) {
  const at = new Date(t).getTime();
  const { c, h } = margins(opts);
  const date = israelDate(at);
  const today = restDay(date, opts);
  if (today && at < sunset(date, place).getTime() + h) return today;
  const tomorrow = restDay(addDays(date, 1), opts);
  if (tomorrow && at >= sunset(date, place).getTime() - c) return tomorrow;
  return null;
}

/** Is this instant inside Shabbat or a yom tov (with the margins)? */
export const inRest = (t, opts) => restAt(t, opts) != null;

/** The whole rest window that contains `t`, as { from, to, days: [names] }, or null. */
export function restWindow(t, { place = JERUSALEM, ...opts } = {}) {
  if (!inRest(t, { place, ...opts })) return null;
  const { c, h } = margins(opts);
  const date = israelDate(t);
  let first = restDay(date, opts) && new Date(t).getTime() < sunset(date, place).getTime() + h ? date : addDays(date, 1);
  while (restDay(addDays(first, -1), opts)) first = addDays(first, -1);
  let last = first;
  while (restDay(addDays(last, 1), opts)) last = addDays(last, 1);
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(restDay(d, opts));
  return { from: new Date(sunset(addDays(first, -1), place).getTime() - c), to: new Date(sunset(last, place).getTime() + h), days: [...new Set(days)] };
}

/** Is this instant inside Shabbat (with the margins)? */
export function inShabbat(t, opts = {}) {
  const at = new Date(t).getTime();
  const { from, to } = shabbatWindow(at, opts);
  return at >= from.getTime() && at < to.getTime();
}

export class ShabbatError extends Error {
  constructor(at, day = 'שבת') {
    super(`refused: ${new Date(at).toISOString()} is inside ${day === 'שבת' ? 'Shabbat' : `a yom tov (${day})`} (Israel time)`);
    this.name = 'ShabbatError';
    this.code = 'shabbat';
  }
}

/** Throw if a post would go out on Shabbat or a yom tov (unless `opts` allows it: rulesOf above). */
export function assertNotShabbat(t, opts) {
  const day = restAt(t, opts);
  if (day) throw new ShabbatError(t, day);
}
