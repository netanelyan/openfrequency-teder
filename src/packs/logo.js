import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getBytes } from '../core/net.js';
import { imageExt, imageSize, webpSize } from '../images/size.js';

// An account's logo: packs/<id>/brand/logo.<ext>, drawn first on its closing slide, on a tile of its own (src/packs/load.js
// finds it; src/render/styles/index.js and src/render/end.js closingPage draw it). A customer's comes two ways, on the
// same terms: from their store's site when the account is made (src/onboarding/promo.js startLogoFetch, from the address
// the site read on /new found), and from Settings, where they replace it or remove it (src/web/logo.js).
//
//   kind    PNG, JPEG or WebP, told by the file's own first bytes, never by its name or the type it came with. Never an
//           SVG, which can carry a script: one a site serves, or one renamed logo.png, is refused
//   bytes   LOGO_MAX_BYTES at most (2 MB): the slide draws a logo at most 380 by 92 pixels
//   sides   LOGO_SIDES, read from the picture's own header (one that cannot be read is refused): 32 pixels at least on
//           its shorter side, below which a logo is an icon drawn blurred, and 5000 at most on its longer one, past
//           which the renderer's browser would open it into hundreds of megabytes
//
// Written whole: a temporary file in brand/ renamed over logo.<ext>, then every other logo.* taken out (logo.png is read
// before logo.webp, so a new WebP must not leave an old PNG in front of it). Removing it takes them all out, and the
// closing slide closes up where it was.

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_SIDES = { min: 32, max: 5000 };
/** The files a pack's logo may be, in the order the loader looks for them. */
export const LOGO_FILES = ['logo.png', 'logo.svg', 'logo.webp', 'logo.jpg', 'logo.jpeg'];
/** The kinds a slide takes, asked for first from a site that can serve several. */
const ACCEPT = 'image/png,image/webp,image/jpeg,image/*;q=0.5';

// A PNG's whole signature and its first chunk, the header its size is read from.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngHeader = (buf) => buf.subarray(0, 8).equals(PNG) && buf.toString('latin1', 12, 16) === 'IHDR';

/** What makes a picture no logo of ours: 'empty', 'type', 'large', 'small' or 'sides'; null when it will do. */
export function logoProblem(buf) {
  if (!buf?.length) return 'empty';
  const ext = imageExt(buf);
  const size = ext === 'webp' ? webpSize(buf) : ext === 'jpg' || (ext === 'png' && pngHeader(buf)) ? imageSize(buf) : null;
  if (!size?.width || !size?.height) return 'type';
  if (buf.length > LOGO_MAX_BYTES) return 'large';
  if (Math.min(size.width, size.height) < LOGO_SIDES.min) return 'small';
  if (Math.max(size.width, size.height) > LOGO_SIDES.max) return 'sides';
  return null;
}

/** Write a picture as the pack's logo, checked (a throw with its logoProblem as `code`). Returns its file. */
export function saveLogo(pack, buf) {
  const problem = logoProblem(buf);
  if (problem) throw Object.assign(new Error(`not a logo (${problem})`), { code: problem });
  const dir = path.join(pack.dir, 'brand');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `logo.${imageExt(buf)}`);
  const tmp = path.join(dir, `.logo-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  for (const f of LOGO_FILES) if (path.join(dir, f) !== file) rmSync(path.join(dir, f), { force: true });
  pack.brandLogo = file;
  return file;
}

/** Take the pack's logo out, every logo.* in brand/. Returns whether it had one. */
export function removeLogo(pack) {
  const dir = path.join(pack.dir, 'brand');
  const had = LOGO_FILES.some((f) => existsSync(path.join(dir, f)));
  for (const f of LOGO_FILES) rmSync(path.join(dir, f), { force: true });
  pack.brandLogo = null;
  return had;
}

/**
 * A store's logo from its own site: { buf, ext }, or a throw. Through the network's one door (src/core/net.js getBytes:
 * https only, the public internet only, every redirect checked, the connection pinned to the address checked), read no
 * further than LOGO_MAX_BYTES, then checked as an upload is. `fetchImage` is getBytes (the tests' fake).
 */
export async function fetchLogo(url, { fetchImage = getBytes, timeoutMs = 15_000 } = {}) {
  // Shopify's CDN draws it at the width asked for, twice the slide's tile; the others leave the address as it is.
  const u = new URL(url);
  u.searchParams.set('width', '640');
  const { buf } = await fetchImage(u.href, { maxBytes: LOGO_MAX_BYTES, timeoutMs, headers: { accept: ACCEPT } });
  const problem = logoProblem(buf);
  if (problem) throw Object.assign(new Error(`not a logo (${problem})`), { code: problem });
  return { buf, ext: imageExt(buf) };
}
