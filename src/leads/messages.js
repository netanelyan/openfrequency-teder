// What the operator sends a lead from /leads (src/web/leads.js), and when. Nothing here sends anything: the page
// prepares each message, the operator sends it by hand from their own phone or mail, and says on the page which way
// it went. It keeps Toran's outreach rules (openfrequency-toran src/outreach.ts, the Communications Law's section
// 30A): one approach that says who is writing and how to stop, at most one reminder FOLLOWUP_DAYS later, never on
// Shabbat, and nothing more unless the store writes back. A store that answers "לא" is marked "לא רלוונטי" by the
// operator, and Toran's own opt-out hides it (src/leads/sync.js).

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const FOLLOWUP_DAYS = 4;

/**
 * "ל" joined to a Hebrew name, "ל־" before any other: "לכלי חרס של נורית", "ל־Nike". Toran's le(), ported as it is
 * (openfrequency-toran src/outreach.ts), so a name reads the same in both products' messages.
 */
export const le = (name) => `${/^[א-ת]/.test(name) ? 'ל' : 'ל־'}${name}`;

/**
 * The first message to a lead Toran found (every lead on /leads: none of them asked for a demo). It follows Toran's
 * firstMessage (openfrequency-toran src/outreach.ts; section 30A: it says who writes, it is the one approach, and it
 * says how to stop). Toran's tederFirst (src/ops/messages.ts) is for a store that asked on the website ("ביקשתם
 * באתר..."), so it is not used here. The owner is reviewing this wording, 2026-11-05.
 */
export const TEDER_COLD_FIRST = (o) =>
  `היי, כאן OpenFrequency. הכנו ${le(o.storeName)} מצגת לדוגמה לטיקטוק ולאינסטגרם, על נושא מהתחום של החנות. ככה תדר מכין לחנות מצגות, ואתם רק מאשרים מה עולה.
${o.url}

אם זה לא רלוונטי, אפשר לענות "לא" ולא נכתוב שוב.`;

/** The one reminder, Toran's tederReminder word for word (openfrequency-toran src/ops/messages.ts). */
export const TEDER_REMINDER = (o) =>
  `היי, יצא לכם להציץ במצגת שהכנו ${le(o.storeName)}?
${o.url}

זו ההודעה האחרונה שלנו בנושא.`;

/** The mail's subject, when the message goes by mail. */
export const mailSubject = (storeName) => `מצגת לדוגמה ${le(storeName)}`;

const TZ = 'Asia/Jerusalem';
const WEEKDAY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });

/** Weekday in Israel, 0 = Sunday ... 6 = Saturday, and the hour (0-23). Toran's israelWeekdayHour (src/core/clock.ts). */
export function israelWeekdayHour(t) {
  const parts = Object.fromEntries(WEEKDAY_HOUR.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday)), hour: Number(parts.hour) };
}

/**
 * Toran's notOnShabbat (openfrequency-toran src/core/clock.ts), ported exactly: from Friday 13:00 to the end of
 * Saturday a time moves on to the next midnight, at most three times, and a time before 09:00 then moves to 09:00.
 * Candle lighting is never before 13:00 in any city at any time of year, so the fixed hours hold the whole of Shabbat.
 */
export function notOnShabbat(t) {
  let x = t;
  for (let i = 0; i < 3; i++) {
    const { weekday, hour } = israelWeekdayHour(x);
    if ((weekday === 5 && hour >= 13) || weekday === 6) x += (24 - hour) * HOUR;
    else break;
  }
  const { hour } = israelWeekdayHour(x);
  return hour < 9 ? x + (9 - hour) * HOUR : x;
}

/** When the one reminder is due: four days after the first message, never on Shabbat (Toran's followupDue). */
export const reminderDue = (sentAt) => notOnShabbat(Date.parse(sentAt) + FOLLOWUP_DAYS * DAY);

/**
 * Whether the reminder may be offered at `t`: it is due, and `t` itself is a time Toran's rule leaves as it is (not
 * from Friday 13:00 to the end of Saturday, not before 09:00). Toran's page offers it from the due time on; this also
 * holds it back on a later Shabbat, so the operator is never handed a message to send then.
 */
export const reminderReady = (sentAt, t) => t >= reminderDue(sentAt) && notOnShabbat(t) === t;

/** When it will be offered next, from `t`: the due time, or the end of the Shabbat or the night it falls in. */
export const reminderFrom = (sentAt, t) => Math.max(reminderDue(sentAt), notOnShabbat(t));

// ---------------------------------------------------------------- the ways to reach a store

/** A wa.me link to a number, with `text` written in the chat (Toran's waLink). */
export const waLink = (digits, text) => `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

/** A mailto: link with the subject and the body written in (line breaks as CRLF, RFC 6068). */
export const mailLink = (email, subject, text) =>
  `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(String(text).replace(/\r?\n/g, '\r\n'))}`;

/** The order the ways are offered in, the first the one the page leads with. */
export const CHANNELS = ['whatsapp', 'email', 'phone', 'instagram', 'tiktok', 'facebook'];
export const CHANNEL_HE = { whatsapp: 'וואטסאפ', email: 'מייל', phone: 'טלפון', instagram: 'אינסטגרם', tiktok: 'טיקטוק', facebook: 'פייסבוק', other: 'דרך אחרת' };

/**
 * Every way the lead can be reached, in CHANNELS order: [{ via, href, label, prefilled }]. WhatsApp and mail carry the
 * message (prefilled); a phone call and a profile cannot, and the page's text box is there to copy it from.
 */
export function reachLinks(lead, text, { subject } = {}) {
  const out = [];
  if (lead.whatsapp) out.push({ via: 'whatsapp', href: waLink(lead.whatsapp, text), label: 'לפתוח בוואטסאפ', prefilled: true });
  if (lead.email) out.push({ via: 'email', href: mailLink(lead.email, subject || mailSubject(lead.name || lead.domain), text), label: 'לפתוח במייל', prefilled: true });
  if (lead.phone) out.push({ via: 'phone', href: `tel:${lead.phone}`, label: 'להתקשר', prefilled: false });
  for (const via of ['instagram', 'tiktok', 'facebook']) if (lead[via]) out.push({ via, href: lead[via], label: CHANNEL_HE[via], prefilled: false });
  return out;
}
