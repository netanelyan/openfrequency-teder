import { statSync } from 'node:fs';
import path from 'node:path';
import { audit } from '../core/store.js';
import { LOGO_MAX_BYTES, LOGO_SIDES, logoProblem, removeLogo, saveLogo } from '../packs/logo.js';
import { ActionError } from './actions.js';
import { csrfField, esc, icon, postButton } from './ui.js';

// The account's logo on Settings (src/packs/logo.js): the logo as its closing slide shows it, on its tile (white, or dark
// for a light logo: static/app.js tells which, as the renderer does), and the way to replace it or remove it. A file
// picked is sent at once (app.js data-upload, which also says when it is over the cap without sending it); without the
// script a button sends it. The form is multipart/form-data, read only on this path (src/web/server.js UPLOADS), its
// CSRF token and the session's workspace checked as every other form's; the picture is checked here, by its bytes.

export const LOGO_TITLE = 'הלוגו';
const MB = Math.round(LOGO_MAX_BYTES / 1024 / 1024);
const HAS = 'זה הלוגו שמופיע בשקף האחרון של כל מצגת.';
const NONE = 'עוד אין לוגו, אז השקף האחרון יוצא בלעדיו. מעלים אחד, ונשים אותו שם בכל מצגת.';
const HINT = `קובץ PNG, JPG או WebP, עד ${MB}MB.`;

/** What the customer reads: a picture that will not do (src/packs/logo.js logoProblem), and what was done. */
export const LOGO_HE = {
  empty: 'צריך לבחור תמונה של הלוגו.',
  many: 'אפשר להעלות קובץ אחד בכל פעם.',
  type: 'אנחנו מקבלים רק PNG, JPG או WebP.',
  large: `התמונה גדולה מדי. אפשר עד ${MB}MB.`,
  small: 'התמונה קטנה מדי, והלוגו ייצא מטושטש. נסו גרסה גדולה יותר.',
  sides: `התמונה גדולה מדי. אפשר עד ${LOGO_SIDES.max} פיקסלים בכל צד.`,
  saved: 'שמרנו את הלוגו. מהמצגת הבאה הוא יופיע בשקף האחרון.',
  removed: 'הסרנו את הלוגו. מהמצגת הבאה השקף האחרון יוצא בלעדיו.',
};

/** The type a logo is sent as, by the name the loader found it under. */
export const logoType = (file) => ({ '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] || 'image/jpeg';

// The picture's address changes when the picture does, so a browser never shows the one it kept.
const versionOf = (file) => {
  try {
    return Math.round(statSync(file).mtimeMs).toString(36);
  } catch {
    return '0';
  }
};

/** Settings' panel: the logo on its tile, or the empty tile, and one button to put one there; remove beside it. */
export function logoPanel(ctx, pack) {
  const id = esc(pack.id);
  const has = Boolean(pack.brandLogo);
  // The empty tile looks like the place to put one, so it opens the same file picker as the button.
  const tile = has
    ? `<span class="logo-tile" data-logo-tile><img src="/accounts/${id}/logo?v=${versionOf(pack.brandLogo)}" alt="${esc(`הלוגו של ${pack.meta.displayName}`)}"></span>`
    : `<label class="logo-tile none" for="logo-file-${id}" aria-hidden="true">${icon('plus')}</label>`;
  return `<section class="panel" id="logo-${id}"><header><h2>${LOGO_TITLE}</h2></header>
<p class="muted m0">${has ? HAS : NONE}</p>
<div class="logo-stage">${tile}</div>
<div class="logo-acts"><form method="post" action="/accounts/${id}/logo" enctype="multipart/form-data" class="logo-up" data-upload="${LOGO_MAX_BYTES}" data-too-large="${esc(LOGO_HE.large)}">${csrfField(ctx)}<label class="btn pick" for="logo-file-${id}">${icon(has ? 'edit' : 'plus')}${has ? 'להחליף את הלוגו' : 'להעלות לוגו'}</label><input class="logo-file" id="logo-file-${id}" type="file" name="logo" accept="image/png,image/jpeg,image/webp"><noscript><button class="btn" type="submit">שמירה</button></noscript></form>${has ? postButton(ctx, `/accounts/${id}/logo/remove`, 'להסיר', { cls: 'btn ghost', confirm: 'לחצו שוב כדי להסיר' }) : ''}</div>
<p class="muted small m6">${HINT}</p></section>`;
}

/** POST /accounts/<id>/logo: the form's one file, checked by its own bytes, becomes the account's logo. */
export function setLogo(ctx, user, { id }, form) {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  // A file input left empty still sends a part with no bytes in it: that is no file.
  const files = (form.uploads || []).filter((f) => f.buf.length);
  if (files.length > 1) throw new ActionError(LOGO_HE.many, 422);
  const problem = files.length ? logoProblem(files[0].buf) : 'empty';
  if (problem) throw new ActionError(LOGO_HE[problem], problem === 'large' ? 413 : 422);
  const had = Boolean(pack.brandLogo);
  const file = saveLogo(pack, files[0].buf);
  audit(ctx.db, { actor: user.name, action: 'logo', accountId: id, detail: { had, kind: path.extname(file).slice(1), bytes: files[0].buf.length } });
  return { ok: true, message: LOGO_HE.saved, redirect: `/settings#logo-${encodeURIComponent(id)}` };
}

/** POST /accounts/<id>/logo/remove: no logo, and the closing slide closes up where it was. */
export function dropLogo(ctx, user, { id }) {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  if (removeLogo(pack)) audit(ctx.db, { actor: user.name, action: 'logo_removed', accountId: id });
  return { ok: true, message: LOGO_HE.removed, redirect: `/settings#logo-${encodeURIComponent(id)}` };
}
