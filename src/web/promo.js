import { audit } from '../core/store.js';
import { j } from '../db/index.js';
import { cleanPromo, PROMO_MAX, promoOf, promoProblems, promoText, TARGETS } from '../packs/promo.js';
import { setPackPromo } from '../packs/write.js';
import { ActionError } from './actions.js';
import { csrfField, esc, icon } from './ui.js';

// What the account's slideshows send people to (src/packs/promo.js), as the customer reads and changes it: a step of
// /new (src/web/onboarding.js), filled in from their site, and a panel on Settings. One set of fields on both: the name,
// the promise, and where the last slide sends people (the site, one product, or the link in the bio), the address
// fields shown for the choice made (CSS :has, every field where a browser has no :has).
//
// A form left empty (no promise, no address, no product: the name alone is filled in for them) is no promo, and the
// last slide asks to follow the account. A form half filled in is never kept as half: its own save (the waiting page,
// Settings) refuses it with what is missing and keeps what was typed; the step that makes the account makes it
// anyway, with no promo, keeps the draft on the onboarding and offers it on Settings until it is finished there
// (settlePromo, promoLater, unfinishedPromo).

export const PROMO_TITLE = 'השקף האחרון';
const LEDE = 'כל מצגת נגמרת בשקף ששולח את מי שצפה בה אליכם. כאן בוחרים לאן, ומה מחכה שם.';
const NONE = 'עוד לא מילאתם את זה, אז בינתיים השקף האחרון מבקש לעקוב אחרי החשבון.';
const LATER = 'כאן מה שכתבתם כשפתחתם את החשבון. נשאר להשלים את מה שחסר ולשמור, ועד אז השקף האחרון מבקש לעקוב אחרי החשבון.';
const TARGET_HE = { site: 'לאתר', product: 'למוצר אחד', bio: 'ללינק בביו' };

/** What the customer reads about a promo that will not do, a line a problem (src/packs/promo.js promoProblems). */
export const PROMO_HE = {
  shape: 'משהו השתבש בטופס. נסו שוב.',
  name: 'צריך לכתוב את השם שיופיע בשקף.',
  nameLong: `השם ארוך מדי לשקף. אפשר עד ${PROMO_MAX.name} תווים.`,
  promise: 'צריך לכתוב במשפט אחד מה מקבלים אצלכם.',
  promiseLong: `המשפט ארוך מדי לשקף. אפשר עד ${PROMO_MAX.promise} תווים.`,
  target: 'צריך לבחור לאן השקף שולח: לאתר, למוצר אחד או ללינק בביו.',
  product: 'צריך לכתוב את שם המוצר.',
  productLong: `שם המוצר ארוך מדי. אפשר עד ${PROMO_MAX.product} תווים.`,
  siteUrl: 'צריך לכתוב את הכתובת של האתר.',
  productUrl: 'צריך לכתוב את הכתובת של המוצר.',
  url: 'הכתובת לא נראית כמו כתובת של אתר, למשל shop.co.il',
  domain: 'הכתובת לא באתר שלכם.',
};

// Typed text is kept to twice what a slide takes, so a long paste comes back to be cut, not lost.
const typedText = (v, max) => promoText(v).slice(0, max * 2);
const typedUrl = (v) => String(v ?? '').trim().slice(0, PROMO_MAX.url * 2);

/** The promo as the form sent it, a draft in the pack's own shape (src/packs/promo.js), not yet checked. */
export function draftFromForm(f) {
  const kind = TARGETS.includes(f.promo_target) ? f.promo_target : null;
  const target =
    kind === 'site' ? { kind, url: typedUrl(f.promo_site) } : kind === 'product' ? { kind, name: typedText(f.promo_product, PROMO_MAX.product), url: typedUrl(f.promo_product_url) } : kind ? { kind } : null;
  return { name: typedText(f.promo_name, PROMO_MAX.name), promise: typedText(f.promo_promise, PROMO_MAX.promise), target };
}

/** A draft with nothing of the customer's in it: no promise, no address and no product (the name is filled in for them). */
const emptyDraft = (d) => !d.promise && !d.target?.url && !d.target?.name;

/**
 * The form, checked: { promo, draft } (promo null for a form left empty: no promo), or { problems, draft } in Hebrew.
 * An address may be anywhere the customer typed, kept as https.
 */
export function promoFromForm(f) {
  const draft = draftFromForm(f);
  if (emptyDraft(draft)) return { promo: null, draft };
  const codes = promoProblems(draft);
  return codes.length ? { problems: [...new Set(codes.map((c) => PROMO_HE[c] || PROMO_HE.shape))], draft } : { promo: cleanPromo(draft), draft };
}

/**
 * A draft as a new account takes it, never refused: { promo, unfinished }. Valid, it is the promo; left empty, none;
 * half done or wrong, none as well (a promo is whole or it is not one), and `unfinished` says so.
 */
export function settlePromo(d) {
  if (!d || typeof d !== 'object' || emptyDraft(d)) return { promo: null, unfinished: false };
  return promoProblems(d).length ? { promo: null, unfinished: true } : { promo: cleanPromo(d), unfinished: false };
}

/** The line a new account's next page shows while the closing slide it was made with is unfinished: where to finish it. */
// Before paying Settings is the paywall's (src/web/server.js SETUP_OPEN), so `locked` says when it opens, with no link.
export const promoLater = (pack, { locked = false } = {}) =>
  `<div class="banner info" id="promo-later">${icon('settings')}<div><p class="m0">השקף האחרון עוד לא גמור, ובינתיים הוא מבקש לעקוב אחרי החשבון. ${locked ? 'אפשר להשלים אותו בהגדרות אחרי ההפעלה.' : `אפשר <a href="/settings?account=${esc(encodeURIComponent(pack.id))}#promo-${esc(pack.id)}">להשלים אותו בהגדרות</a>.`}</p></div></div>`;

/**
 * The closing slide a customer left unfinished when their account was made (the onboarding's draft), for Settings to
 * offer while the account has none; null otherwise.
 */
export function unfinishedPromo(db, pack) {
  if (!pack || pack.meta.promo) return null;
  const s = j(db.get('SELECT setup_json FROM onboarding WHERE pack_id = ? ORDER BY updated_at DESC LIMIT 1', pack.id)?.setup_json, {}) || {};
  return s.promoUnfinished && s.promo && typeof s.promo === 'object' ? s.promo : null;
}

const input = (name, value, { max, ltr = false, placeholder = '' } = {}) =>
  `<input type="text" name="${name}" maxlength="${max}" value="${esc(value)}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}${ltr ? ' dir="ltr" inputmode="url" autocapitalize="off" autocomplete="url" spellcheck="false"' : ''}>`;

/**
 * The fields, filled in from a draft or a saved promo: the same on /new and on Settings. `key` keeps the choice's ids
 * apart; `nameDefault` is the name offered while there is none (the business's); `siteDefault` the site's address
 * offered when the choice is not the site (the one typed on /new).
 */
export function promoFields(draft, { key, nameDefault = '', siteDefault = '' } = {}) {
  const t = draft?.target || {};
  const kind = TARGETS.includes(t.kind) ? t.kind : 'site';
  const id = (k) => `promo-${esc(key)}-${k}`;
  const choice = TARGETS.map((k) => `<input type="radio" name="promo_target" value="${k}" id="${id(k)}"${k === kind ? ' checked' : ''}><label for="${id(k)}">${TARGET_HE[k]}</label>`).join('');
  return `<input type="hidden" name="promo_shown" value="1">
<label class="f">השם <small>של החנות או של העסק</small>${input('promo_name', draft?.name || nameDefault, { max: PROMO_MAX.name })}</label>
<label class="f">מה מקבלים אצלכם <small>משפט אחד, במילים שלכם</small><textarea name="promo_promise" rows="2" maxlength="${PROMO_MAX.promise}" placeholder="למשל: תכשיטים מכסף בעבודת יד, עם חריטה בעברית">${esc(draft?.promise || '')}</textarea></label>
<fieldset class="promo-to"><legend>לאן השקף שולח</legend><div class="seg" role="radiogroup" aria-label="לאן השקף שולח">${choice}</div></fieldset>
<label class="f promo-if site">הכתובת של האתר${input('promo_site', kind === 'site' ? t.url || '' : siteDefault, { max: PROMO_MAX.url, ltr: true, placeholder: 'shop.co.il' })}</label>
<label class="f promo-if product">שם המוצר${input('promo_product', kind === 'product' ? t.name || '' : '', { max: PROMO_MAX.product })}</label>
<label class="f promo-if product">הכתובת של המוצר${input('promo_product_url', kind === 'product' ? t.url || '' : '', { max: PROMO_MAX.url, ltr: true, placeholder: 'shop.co.il/products/...' })}</label>
<p class="muted small m0 promo-if bio">השקף יבקש ללחוץ על הלינק שבפרופיל שלכם בטיקטוק ובאינסטגרם.</p>`;
}

/** What /new says beside the fields: still reading the site, filled in from it, or it could not be read; nothing once the customer saved their own. */
export function readNote(setup, { busy = false } = {}) {
  if (setup?.promoBy === 'customer') return '';
  if (busy) return 'עוד קוראים את האתר שלכם כדי למלא את זה. אפשר לכתוב בעצמכם, או לחזור לכאן בעוד דקה.';
  if (setup?.siteRead === 'failed') return 'לא הצלחנו לקרוא את האתר שלכם, אז צריך לכתוב את זה כאן.';
  if (setup?.promoBy === 'site') return setup.promo?.promise ? 'מילאנו את זה ממה שכתוב באתר שלכם. אם משהו לא מדויק, אפשר לשנות.' : 'מילאנו מה שמצאנו באתר שלכם. את המשפט על מה שמקבלים אצלכם צריך לכתוב בעצמכם.';
  return '';
}

/**
 * The step on /new: its own form while the sources are searched (`action`, with a save), or, on the sources step,
 * fields of the create form (no `action`): the account is made with them as they are shown.
 */
// `formId` names the waiting page's form and `save: false` leaves its button out, for the setup step's own (onboarding.js steps).
export function newPromoPanel(pc, r, { action = null, busy = false, nameDefault = '', formId = null, save = true } = {}) {
  const note = readNote(r.setup, { busy });
  const fields = promoFields(r.setup.promo, { key: r.id, nameDefault, siteDefault: r.seed.site || '' });
  const head = `<section class="panel" id="promo"><header><h2>${PROMO_TITLE}</h2></header><p class="muted m0">${LEDE}</p>${note ? `<p class="small m6">${esc(note)}</p>` : ''}`;
  if (!action) return `${head}<div class="formgrid promo mt12">${fields}<p class="muted small m0">אפשר לשנות את זה גם אחר כך, בהגדרות.</p></div></section>`;
  return `${head}<form method="post" action="${esc(action)}" class="formgrid promo mt12"${formId ? ` id="${esc(formId)}"` : ''}>${csrfField(pc)}${fields}
<p class="muted small m0">אפשר לשנות את זה גם בשלב הבא, ואחר כך בהגדרות.</p>
${save ? '<div><button class="btn" type="submit">שמירה</button></div>' : ''}</form></section>`;
}

/**
 * Settings' panel: the account's promo as it is, and the way to change it. `draft` is one left unfinished when the
 * account was made (unfinishedPromo), offered while the account has none, so nothing the customer typed is lost.
 */
export function promoPanel(ctx, pack, { draft = null } = {}) {
  const p = promoOf(pack);
  const note = p ? '' : draft ? LATER : NONE;
  return `<section class="panel" id="promo-${esc(pack.id)}"><header><h2>${PROMO_TITLE}</h2></header>
<p class="muted m0">${LEDE}</p>${note ? `<p class="small m6">${note}</p>` : ''}
<form method="post" action="/accounts/${esc(pack.id)}/promo" class="formgrid promo mt12" data-ajax="reload">${csrfField(ctx)}${promoFields(p || draft, { key: pack.id, nameDefault: pack.meta.displayName })}
<div><button class="btn" type="submit">שמירה</button></div></form></section>`;
}

/** POST /accounts/<id>/promo: the account's promo, or none for a form left empty, written into its pack.json. */
export function setPromo(ctx, user, { id }, form) {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const got = promoFromForm(form);
  if (got.problems) throw new ActionError(got.problems.join(' '), 422, { problems: got.problems });
  const before = pack.meta.promo || null;
  const after = setPackPromo(pack, got.promo);
  // Saved here, the draft left from the account's setup is done with: Settings no longer offers it.
  for (const o of ctx.db.all('SELECT id, setup_json FROM onboarding WHERE pack_id = ?', id)) {
    const s = j(o.setup_json, {}) || {};
    if (s.promoUnfinished) ctx.db.update('onboarding', o.id, { setup_json: { ...s, promoUnfinished: false } });
  }
  audit(ctx.db, { actor: user.name, action: 'promo', accountId: id, detail: { before, after } });
  return { ok: true, message: after ? 'נשמר.' : 'נשמר. בלי משפט, השקף האחרון מבקש לעקוב אחרי החשבון.', redirect: `/settings#promo-${encodeURIComponent(id)}` };
}
