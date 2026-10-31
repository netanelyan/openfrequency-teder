import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { styleConfigProblems } from '../render/styles/tokens.js';
import { formatsFor, MIN_PICKED } from '../formats/library.js';

// The settings of a pack the website writes: its slide style (pack.json "style"), when the owner picks one on the
// Accounts page or a style test settles, how its TikTok posts go out (zernio.tiktokMode, zernio.tiktokPrivacy,
// publishers.tiktok), and a platform added to it (Facebook, offered to the accounts customers made: src/publish/connect.js
// offerFacebook). Everything else in a pack is the owner's to edit by hand. The file is read fresh, only those
// keys are replaced, and it is written whole (a temporary file renamed over it), so a hand edit made since the engine
// started is kept.

function rewrite(pack, change) {
  const file = path.join(pack.dir, 'pack.json');
  const raw = readFileSync(file, 'utf8');
  const meta = JSON.parse(raw);
  change(meta);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(`${file}.tmp`, `${JSON.stringify(meta, null, 2).replace(/\n/g, eol)}${eol}`);
  renameSync(`${file}.tmp`, file);
  return meta;
}

/**
 * How the pack's TikTok posts go out: { tiktokMode, tiktokPrivacy, tiktokPublisher } (each optional), checked by the
 * caller against TIKTOK_MODES and PLATFORM_PUBLISHERS. Returns the pack's new zernio and publishers blocks.
 */
export function setPackPublishing(pack, { tiktokMode, tiktokPrivacy, tiktokPublisher } = {}) {
  const meta = rewrite(pack, (m) => {
    m.zernio = { ...(m.zernio || {}) };
    if (tiktokMode) m.zernio.tiktokMode = tiktokMode;
    if (tiktokPrivacy) m.zernio.tiktokPrivacy = tiktokPrivacy;
    if (tiktokPublisher) {
      // A pack with only the old single "publisher" keeps it for Instagram: only TikTok's choice changes.
      m.publishers = { ...(m.publishers || (m.publisher ? Object.fromEntries((m.platforms || []).map((p) => [p, m.publisher])) : {})), tiktok: tiktokPublisher };
    }
  });
  pack.meta.zernio = meta.zernio;
  if (meta.publishers) pack.meta.publishers = meta.publishers;
  return { zernio: meta.zernio, publishers: meta.publishers || null };
}

/**
 * Add a platform to the pack's platforms, published through `publisher` (publishers.<platform>). A pack that already
 * posts there is left as it is. Returns the pack's new platforms.
 */
export function addPackPlatform(pack, platform, publisher) {
  const meta = rewrite(pack, (m) => {
    if ((m.platforms || []).includes(platform)) return;
    m.platforms = [...(m.platforms || []), platform];
    // A pack with only the old single "publisher" gets the map, so its other platforms keep what they had.
    m.publishers = { ...(m.publishers || (m.publisher ? Object.fromEntries((m.platforms || []).filter((p) => p !== platform).map((p) => [p, m.publisher])) : {})), [platform]: publisher };
  });
  pack.meta.platforms = meta.platforms;
  if (meta.publishers) pack.meta.publishers = meta.publishers;
  return meta.platforms;
}

/** Set a pack's style (a patch of { name, accent, bg, panel, test }; null for a key removes it). Returns the new style. */
export function setPackStyle(pack, patch) {
  const file = path.join(pack.dir, 'pack.json');
  const raw = readFileSync(file, 'utf8');
  const meta = JSON.parse(raw);
  const next = { ...(meta.style || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else next[k] = v;
  }
  const problems = styleConfigProblems(next);
  if (problems.length) throw Object.assign(new Error(problems.join('; ')), { problems });
  meta.style = next;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(`${file}.tmp`, `${JSON.stringify(meta, null, 2).replace(/\n/g, eol)}${eol}`);
  renameSync(`${file}.tmp`, file);
  pack.meta.style = next;
  return next;
}

/**
 * The formats a customer picked (src/formats/library.js), written into the pack's formats.json: its list becomes the
 * library's entries for these ids, taken in turn ("rotate": "turns", src/formats/rotation.js turnOrder). Captions,
 * hashtags and trends are kept. At least MIN_PICKED, all the library's own; the caller says so to the customer.
 * Returns the new list.
 */
export function setPackFormats(pack, ids) {
  const picked = formatsFor(ids);
  if (picked.length < MIN_PICKED) throw Object.assign(new Error(`at least ${MIN_PICKED} formats`), { code: 'few' });
  const file = path.join(pack.dir, 'formats.json');
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  data.formats = picked;
  data.rotate = 'turns';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2).replace(/\n/g, eol)}${eol}`);
  renameSync(`${file}.tmp`, file);
  pack.formats = { ...pack.formats, formats: data.formats, rotate: 'turns' };
  return data.formats;
}
