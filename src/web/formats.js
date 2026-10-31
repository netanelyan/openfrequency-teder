import { audit } from '../core/store.js';
import { DEFAULT_PICKED, LIBRARY, MIN_PICKED, pickedFrom, pickedOf } from '../formats/library.js';
import { inTurns } from '../formats/rotation.js';
import { setPackFormats } from '../packs/write.js';
import { ActionError } from './actions.js';
import { csrfField, esc } from './ui.js';

// The kinds of slideshow a customer picks (the owner, 2026-10-31: "i want the customer to pick the formats he likes. it
// is changable, and each slideshow is in a different format."): on the sources step of a new account, before its
// samples are written, and on the account page whenever they like. The library is src/formats/library.js; the engine
// takes the picks one after the other (src/formats/rotation.js turnOrder).

export const FORMATS_TITLE = 'סוגי המצגות';
export const FORMATS_FEW = `צריך לבחור לפחות ${MIN_PICKED} סוגים, כדי ששתי מצגות ברצף לא ייצאו באותו סוג.`;
const LEDE_NEW = `בוחרים לפחות ${MIN_PICKED}. כל מצגת תצא בסוג אחר מזו שלפניה, ואפשר לשנות את הבחירה בכל זמן בדף החשבון.`;
const LEDE_ACCOUNT = `כל מצגת יוצאת בסוג הבא ברשימה, כך ששתי מצגות ברצף לא יוצאות באותו סוג. בוחרים לפחות ${MIN_PICKED}.`;

/** The library as ticks, these ones ticked: a card each with its name and one line on what it is. */
export function formatsPicker(picked) {
  const on = new Set(picked);
  return `<div class="fmt-picks">${LIBRARY.map((f) => `<label class="fmt-pick"><input type="checkbox" name="fmt_${esc(f.id)}"${on.has(f.id) ? ' checked' : ''}><span><b>${esc(f.name)}</b><small>${esc(f.he)}</small></span></label>`).join('')}</div>`;
}

/** The sources step's part of the create form: the defaults ticked, or what the customer ticked before an error. */
export function formatsSection(form = null) {
  const picked = form ? pickedFrom(form) : DEFAULT_PICKED;
  return `<section class="panel" id="formats"><header><h2>${FORMATS_TITLE}</h2></header><p class="muted">${LEDE_NEW}</p><input type="hidden" name="formats_shown" value="1">${formatsPicker(picked)}</section>`;
}

/**
 * Whether an account's formats are the customer's to pick: a customer's account, or one already in turn. The
 * company's own hand-written packs keep their formats.json (their formats are the operator's, and richer than these).
 */
export const picksFormats = (pack, customer) => Boolean(customer) || inTurns(pack);

/** Settings' panel (the owner, 2026-10-31: "סוגי המצגות should be in settings"): what is picked, and the way to change it. */
export function formatsPanel(ctx, pack, { heading = 'h3' } = {}) {
  return `<section class="panel acct-formats" id="formats-${esc(pack.id)}"><header><${heading}>${FORMATS_TITLE}</${heading}><span class="end muted small">${pickedOf(pack).length} נבחרו</span></header>
<p class="m0 muted small">${LEDE_ACCOUNT}</p>
<form method="post" action="/accounts/${esc(pack.id)}/formats">${csrfField(ctx)}${formatsPicker(pickedOf(pack))}<div class="actions p0 m6"><button class="btn sm" type="submit">שמירה</button></div></form></section>`;
}

/** POST /accounts/<id>/formats: the ticked formats become the account's, in turn, from its next slideshow. */
export function setFormats(ctx, user, { id }, form) {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const ids = pickedFrom(form);
  if (ids.length < MIN_PICKED) throw new ActionError(FORMATS_FEW);
  const before = pickedOf(pack);
  setPackFormats(pack, ids);
  audit(ctx.db, { actor: user.name, action: 'formats', accountId: id, detail: { before, after: ids } });
  return { ok: true, message: 'נשמר. המצגת הבאה כבר תצא באחד מהסוגים שבחרתם.', redirect: `/settings#formats-${encodeURIComponent(id)}` };
}
