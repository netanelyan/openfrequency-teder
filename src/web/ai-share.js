import { monthKey } from '../core/clock.js';
import { ALERT_SHARE, aiShares, liftStop, PAUSED_HE, STOP_SHARE, usdIls } from '../billing/ai-share.js';
import { ActionError } from './actions.js';
import { esc, icon, postButton, stamp, usd } from './ui.js';

// The 30/50 rule on the pages (src/billing/ai-share.js; the owner, 2026-11-11: "if ai costs of an account reach 30% of
// the payment of the customer, we get alerted. them on 50% it stops"):
//
//   - while a workspace's AI is stopped, one calm line over its pages (Today, Posts, /all: wherever the stop banners
//     are), once, with no cost and no share in it: new slideshows are not written now, we are on it, and what is
//     approved goes out. The operator in developer mode reads instead which accounts, why, and where to let them go on
//   - the operator's panel in Settings, in developer mode as every cost is (the owner, 2026-11-10: "they dont have to
//     see how much it cost us"): each customer's AI cost this month against what they pay a month before VAT, and for
//     one that is stopped, the button that lets its AI go on for the rest of the month (POST
//     /settings/ai-share/<workspace>/lift: the operator's alone, audited as ai_stop_lifted)

export const AI_SHARE_TITLE = 'עלות ה-AI מול התשלום';

const whole = (n) => Math.round(n).toLocaleString('en-US');
const share = (s) => `${Math.floor(s * 100 + 1e-9)}%`;

/** The line over the pages while the AI of an account shown is stopped; '' while none is. `groups`: data.today()'s. */
export function aiPausedBanner(ctx, groups = []) {
  const paused = groups.filter((g) => g.aiPaused);
  if (!paused.length) return '';
  if (ctx.costs) {
    const names = paused.map((g) => g.pack.meta.displayName).join(', ');
    return `<div class="banner warn" id="ai-paused">${icon('clock')}<div><b>${esc(names)}: כרגע לא נכתבות מצגות חדשות.</b><p>עלות ה-AI החודש הגיעה לחצי ממה שהלקוח משלם. <a href="/settings#ai-share">לפרטים, ולפתוח עד סוף החודש</a></p></div></div>`;
  }
  return `<div class="banner info" id="ai-paused">${icon('clock')}<div><b>${esc(PAUSED_HE.title)}</b><p>${esc(PAUSED_HE.text)}</p></div></div>`;
}

/** What the operator's panel reads (src/web/data.js settingsData): every customer's workspace that has an account. */
export const aiShareData = (db, { t, env = process.env } = {}) => ({ rows: aiShares(db, { t, env }), rate: usdIls(env), month: monthKey(t) });

/** Where a customer's month stands, in a chip: under the first line, past it, stopped, or let go on by the operator. */
function stateChip(r) {
  if (r.liftedAt) return '<span class="chip warn">נפתח ידנית</span>';
  if (r.stopped) return '<span class="chip bad">עצור</span>';
  if (r.share >= ALERT_SHARE) return `<span class="chip warn">עבר ${Math.round(ALERT_SHARE * 100)}%</span>`;
  return '<span class="chip ok">תקין</span>';
}

/** The operator's panel: each customer's AI cost this month against what they pay, and the lift for one that is stopped. */
export function aiSharePanel(ctx, { rows, rate, month }) {
  const row = (r) => {
    const lift = r.stopped ? ` ${postButton(ctx, `/settings/ai-share/${r.workspace}/lift`, 'לפתוח עד סוף החודש', { cls: 'btn sm', confirm: 'לחצו שוב כדי לפתוח עד סוף החודש' })}` : '';
    const lifted = r.liftedAt ? ` <span class="muted small">${esc(r.liftedBy || '')}, ${esc(stamp(r.liftedAt))}</span>` : '';
    return `<tr><td class="title" data-k="">${esc(r.who)}</td><td class="n" data-k="עלה החודש">${whole(r.ils)} ₪ <span class="muted small">(${usd(r.usd)})</span></td><td class="n" data-k="משלם לחודש">${whole(r.base)} ₪</td><td class="n" data-k="חלק">${share(r.share)}</td><td data-k="מצב">${stateChip(r)}${lift}${lifted}</td></tr>`;
  };
  return `<section class="panel" id="ai-share"><header><h2>${esc(AI_SHARE_TITLE)}</h2><span class="end muted small ltr">${esc(month)}</span></header>
<p class="muted small m0">כמה עלה לנו ה-AI של כל לקוח החודש, מול מה שהוא משלם לחודש לפני מע״מ. ב-${Math.round(ALERT_SHARE * 100)}% מגיעה התראה. ב-${Math.round(STOP_SHARE * 100)}% תדר מפסיק לכתוב לו עד סוף החודש, ומה שכבר אושר עולה כרגיל. דולר אחד: ${esc(rate)} ₪.</p>
${rows.length ? `<div class="scrollx mt12"><table class="table stack"><thead><tr><th>לקוח</th><th>עלה החודש</th><th>משלם לחודש</th><th>חלק</th><th>מצב</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>` : '<p class="muted mt12">עוד אין לקוחות עם חשבון.</p>'}</section>`;
}

/** The lift: the operator's alone. Refused for a workspace that is not stopped now (under the line, lifted, or ours). */
export function aiShareRoutes() {
  return [
    [
      'POST',
      /^\/settings\/ai-share\/(\d+)\/lift$/,
      (ctx, user, m) => {
        if (!user.operator) throw new ActionError('את זה משנה רק מי שמפעיל את תדר', 403);
        const r = liftStop(ctx.db, Number(m[1]), { by: user.email || user.name });
        if (!r.lifted) throw new ActionError('הלקוח הזה לא עצור עכשיו, אז אין מה לפתוח.', 409);
        return { ok: true, message: 'נפתח. עד סוף החודש תדר כותב ללקוח הזה כרגיל.', redirect: '/settings#ai-share' };
      },
    ],
  ];
}
