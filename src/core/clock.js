import { randomBytes } from 'node:crypto';

// Time and ids. Time is injectable so the runner, the schedule and the 72-hour
// metrics rule can be tested without waiting.

let fixed = null;

export const now = () => (fixed != null ? fixed : Date.now());
export const nowIso = () => new Date(now()).toISOString();

/** For tests: pin the clock (a Date, an ISO string or ms), or null to release it. */
export function setNow(t) {
  fixed = t == null ? null : typeof t === 'number' ? t : Date.parse(t instanceof Date ? t.toISOString() : t);
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** A short sortable id: time in base 36, then randomness. */
export function newId(prefix = '') {
  return `${prefix}${now().toString(36)}${randomBytes(4).toString('hex')}`;
}

const MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' });

/** The Israel month, YYYY-MM: the spend ledger's and the plan's key. */
export const monthKey = (t = now()) => MONTH.format(new Date(t)).slice(0, 7);
