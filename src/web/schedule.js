import { ActionError } from './actions.js';
import { accDot, csrfField, esc } from './ui.js';
import { DAY_HE, EARLIEST, LATEST, MAX_PER_DAY, choiceOf, monthOf, readChoice, saveChoice } from '../schedule/choice.js';

// When an account posts, chosen by its owner (src/schedule/choice.js): on Settings for the account shown, and in the
// new-account flow before it goes live (src/web/onboarding.js).
//
//   POST /accounts/<id>/schedule   day_<d>, t1_<d>, t2_<d> for each weekday; shabbat, holidays: post on them too
//                                  (boxes, off unless ticked); back: where to return

/** The form's starting values: the saved choice, else what the pack's schedule posts at, two a day at most. */
function byDayOf(db, pack) {
  const saved = choiceOf(db, pack.id);
  if (saved) return { byDay: saved, saved: true };
  const s = pack.meta?.schedule || {};
  const per = Math.min(MAX_PER_DAY, Number.isInteger(Number(s.postsPerDay)) && Number(s.postsPerDay) > 0 ? Number(s.postsPerDay) : MAX_PER_DAY);
  return { byDay: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [...(s.slotsByDay?.[String(d)] || s.slots || [])].sort().slice(0, per)])), saved: false };
}

/**
 * What the panel shows for an account. `choice` ({ byDay, shabbat, holidays }) stands in for the saved one: a new
 * account's, kept on its onboarding before the account exists (src/web/onboarding.js). A flag it leaves out is the
 * account's (its pack's, for one with no choice saved). `rules` is { shabbat, holidays }: whether it posts on them.
 */
export function scheduleData(db, pack, { t = Date.now(), choice = null } = {}) {
  const { byDay, saved } = choice?.byDay ? { byDay: choice.byDay, saved: true } : byDayOf(db, pack);
  const stand = choice?.byDay ? { shabbat: choice.shabbat ?? null, holidays: choice.holidays ?? null } : {};
  const month = monthOf(db, pack, { t, byDay, ...stand });
  return { pack, byDay, saved, rules: month.rules, month };
}

/** Friday's and Saturday's note when the account keeps Shabbat: a time is kept before it begins and after it ends. */
const DAY_NOTE = { 5: 'לפני כניסת השבת', 6: 'אחרי צאת השבת' };

/** What the account does on Shabbat and the festivals, said beside the two boxes. */
function rulesLine({ shabbat, holidays }) {
  if (shabbat && holidays) return 'מפרסמים גם בשבת וגם בחגים, בשעות שבחרתם.';
  if (shabbat) return 'מפרסמים גם בשבת. בחגים לא מפרסמים.';
  if (holidays) return 'מפרסמים גם בחגים. בשבת לא מפרסמים.';
  return 'בשבת ובחג לא מפרסמים, אלא אם תסמנו כאן.';
}

/** The month a choice gives, said plainly. */
function monthLine(m) {
  // An account that shares the plan with the workspace's other accounts is thinned to its part of it.
  const part = m.shared ? `החלק של החשבון הזה בחבילה הוא ${m.plan} פוסטים בחודש, מתוך ${m.whole} לכל החשבונות שלכם` : `החבילה שלכם היא ${m.plan} פוסטים בחודש`;
  // Thinned to the plan (src/schedule/slots.js monthSlots): a day's second time first, so while the plan covers every
  // day chosen, some days get one post instead of two; under that the posts spread over the month and some days get
  // none. The small plan's 15 read "פוסט אחד במקום שניים" over a month of 27 days (the audit, 2026-11-12, P1-14).
  if (m.all > m.plan && m.days > m.plan) {
    const every = m.days / m.plan;
    return `לפי הבחירה הזו יש בחודש הבא מקום ל-${m.all} פוסטים. ${part}, אז הפוסטים יתפזרו על כל החודש, ${every >= 1.75 ? `בערך פוסט אחד כל ${Math.round(every) === 2 ? 'יומיים' : `${Math.round(every)} ימים`}` : 'ובחלק מהימים שבחרתם לא ייצא פוסט'}.`;
  }
  if (m.all > m.plan) return `לפי הבחירה הזו יש בחודש הבא מקום ל-${m.all} פוסטים. ${part}, ולכן בחלק מהימים ייצא פוסט אחד במקום שניים.`;
  if (m.all === m.plan) return m.shared ? `לפי הבחירה הזו יוצאים בחודש הבא ${m.plan} פוסטים, כל החלק של החשבון הזה בחבילה.` : `לפי הבחירה הזו יוצאים בחודש הבא ${m.plan} פוסטים, כל החבילה.`;
  return `לפי הבחירה הזו יוצאים בחודש הבא ${m.all} פוסטים, פחות מ-${m.plan} ${m.shared ? 'שבחלק של החשבון הזה בחבילה' : 'שבחבילה'}. אפשר להוסיף ימים או שעה שנייה.`;
}

/** How many chosen times next month fall on a day the account does not post on, naming only the days that count. */
function restLine(m) {
  const n = m.rest;
  const by = m.restBy || { shabbat: n, holidays: n };
  const when = by.shabbat && by.holidays ? 'בשבת או בחג' : by.shabbat ? 'בשבת' : 'בחג';
  return n === 1 ? `אחת השעות שבחרתם נופלת בחודש הבא ${when}, ובה לא מפרסמים.` : n > 1 ? `${n} מהשעות שבחרתם נופלות בחודש הבא ${when}, ובהן לא מפרסמים.` : '';
}

/**
 * The panel: a row a weekday, a box and up to two times. `back` is the page the form returns to; `action` where it
 * posts (an account's, or a new account's onboarding before the account exists).
 */
// `formId` names the form, and `save: false` leaves its button out: /new's setup step has its own, beside the step's
// others (src/web/onboarding.js steps), with form="<formId>".
/**
 * A time as a list of 24-hour times (07:00, 07:15 ... ), never <input type="time">: a browser draws that one in the
 * device's language, so a phone set to English shows AM and PM, which people here don't read (the owner, 2026-11-06).
 * Every 15 minutes from `from` to `to`; a saved time between them stays on the list. `empty` is the blank choice's label.
 */
export function timeSelect(name, value, { from = '00:00', to = '23:45', step = 15, empty = '', label = '', id = '' } = {}) {
  const mins = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const list = [];
  for (let m = mins(from); m <= mins(to); m += step) list.push(hhmm(m));
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) && !list.includes(value)) list.push(value), list.sort();
  const opt = (v, text) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`;
  return `<select name="${esc(name)}"${id ? ` id="${esc(id)}"` : ''} dir="ltr"${label ? ` aria-label="${esc(label)}"` : ''}>${empty || !value ? opt('', empty) : ''}${list.map((t) => opt(t, t)).join('')}</select>`;
}

export function schedulePanel(ctx, d, { back = '/settings#schedule', title = 'מתי מפרסמים', lede = null, action = null, formId = null, save = true } = {}) {
  if (!d) return '';
  const id = d.pack.id;
  const rules = d.rules || d.month.rules || { shabbat: false, holidays: false };
  const rows = DAY_HE.map((name, day) => {
    const times = d.byDay[day] || [];
    const on = times.length > 0;
    const time = (n) => timeSelect(`t${n}_${day}`, times[n - 1] || '', { from: EARLIEST, to: LATEST, empty: n === 1 ? 'שעה' : 'בלי', label: `${name}, ${n === 1 ? 'שעה ראשונה' : 'שעה שנייה, לא חובה'}` });
    return `<div class="schedrow"><label class="check"><input type="checkbox" name="day_${day}"${on ? ' checked' : ''}> ${esc(name)}${DAY_NOTE[day] && !rules.shabbat ? ` <small class="muted">${DAY_NOTE[day]}</small>` : ''}</label><span class="times">${time(1)}${time(2)}</span></div>`;
  }).join('');
  const rest = restLine(d.month);
  const box = (name, on, label) => `<label class="check"><input type="checkbox" name="${name}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  return `<section class="panel" id="schedule"><header><h2>${esc(title)}</h2><span class="end muted small">${accDot(id)} ${esc(d.pack.meta?.displayName || id)}</span></header>
<p class="muted">${lede || 'בוחרים באילו ימים יוצאים הפוסטים ובאיזו שעה, עד שתי שעות ביום.'}</p>
<form method="post" action="${esc(action || `/accounts/${id}/schedule`)}" class="prefs"${formId ? ` id="${esc(formId)}"` : ''}>${csrfField(ctx)}<input type="hidden" name="back" value="${esc(back)}">
<fieldset><legend>ימים ושעות</legend>${rows}</fieldset>
<fieldset><legend>שבת וחגים</legend>${box('shabbat', rules.shabbat, 'לפרסם גם בשבת')}${box('holidays', rules.holidays, 'לפרסם גם בחגים')}<p class="muted small m0">${esc(rulesLine(rules))}</p></fieldset>
<p class="muted small m0">${esc(monthLine(d.month))}${rest ? ` ${esc(rest)}` : ''} כל פוסט נכתב יום לפני השעה שלו. פוסטים שכבר נכתבו שומרים על השעה שלהם.</p>
${save ? '<button class="btn" type="submit">שמירה</button>' : ''}</form></section>`;
}

/** Where the form may send the browser back to: Settings, or this account's new-account page. */
const backOf = (v) => (/^\/(settings(#schedule)?|new\/[\w-]+)$/.test(String(v || '')) ? String(v) : '/settings#schedule');

export function scheduleRoutes() {
  return [
    [
      'POST',
      /^\/accounts\/([\w-]+)\/schedule$/,
      (ctx, user, m, f) => {
        if (!ctx.pack(m[1])) throw new ActionError('אין חשבון כזה', 404);
        const r = readChoice(f);
        if (r.problems) throw new ActionError(r.problems.join('. '), 422, { problems: r.problems });
        saveChoice(ctx.db, m[1], r.byDay, { actor: user.name, shabbat: r.shabbat, holidays: r.holidays });
        return { ok: true, message: 'נשמר. הפוסטים הבאים ייצאו בימים ובשעות שבחרתם.', redirect: backOf(f.back) };
      },
    ],
  ];
}
