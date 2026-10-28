import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isSet } from '../core/env.js';
import { getBytes, getJson } from '../core/net.js';
import { nowIso } from '../core/clock.js';
import { ensureDir, mediaDir } from '../core/paths.js';
import { record } from '../budget/ledger.js';
import { j } from '../db/index.js';
import { blockedQuery } from '../rules/check.js';
import { flatten, screenImage } from './safety.js';
import { imageSize } from './size.js';

// HARD RULE 5: images only from licensed libraries, with the licence stored per
// image. Pexels and Unsplash (commercial use, their own licences), Wikimedia
// Commons (only the licences on the allowlist below: public domain, CC0, CC BY,
// CC BY-SA; never NC, ND or "fair use") and Openverse (WordPress.org's open
// index of CC-licensed pictures, most of them on Flickr: only CC BY, CC BY-SA
// and CC0, each with its author). Before all of them, the photographs the owner
// added to the account by hand. Nothing is ever taken from a search engine's
// copy of a picture, a news site or a business's page.
//
// HARD RULE 4 lives here too: every image row carries ai_generated and realistic.
// No provider below generates images; a future one that does must set both, and
// the publisher reads them to set the platform's AI-content flag.
//
// Candidates whose description names a logo, a crest, a badge, a screenshot or
// anything the pack blocks (rules.json imageQueryBlock) are refused, and so is a
// query that asks for one.

const ALWAYS_BLOCK = ['logo', 'crest', 'emblem', 'badge', 'trademark', 'screenshot', 'jersey', 'kit', 'mascot', 'poster', 'banner', 'sign', 'text'];
const COMMONS_OK = /^(?:cc0|cc[- ]zero|public domain|pd(?:[- ].*)?|cc by(?:-sa)? \d(?:\.\d)?(?: .*)?|cc by(?:-sa)?|attribution(?:-sharealike)?)$/i;
const COMMONS_NO = /\bnc\b|non-?commercial|\bnd\b|no ?deriv|fair use|copyrighted|all rights reserved/i;

export const commonsLicenseOk = (name) => {
  const n = String(name || '').trim();
  return Boolean(n) && COMMONS_OK.test(n) && !COMMONS_NO.test(n);
};

const plain = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** Commons' Artist field can hold the same name twice in its markup: "Unknown author Unknown author" becomes "Unknown author". */
export const once = (s) => {
  const w = String(s || '').split(' ');
  const half = w.length / 2;
  return w.length % 2 === 0 && half > 0 && w.slice(0, half).join(' ') === w.slice(half).join(' ') ? w.slice(0, half).join(' ') : String(s || '');
};
/**
 * A credit's name, as a caption can carry it: Commons' Artist field is free text, and one file's held its whole licence
 * ("Kolforn ( Kolforn ) I'd appreciate if you could mail me (...) ... This file is licensed under ..."), which went into a
 * post's caption word for word. The name is what comes before a licence's or a request's words, an address or a link,
 * cut at a word to 60 characters.
 */
export function creditName(s) {
  let t = once(String(s || '')).replace(/\s+/g, ' ').trim();
  t = t.split(/\s*(?:This file is licensed|is licensed under|I'd appreciate|I would appreciate|Please (?:credit|contact|mail)|You are free|Creative Commons|https?:\/\/|\S+@\S+)/i)[0].trim();
  t = t.replace(/\s*\(\s*([^()]*)\s*\)\s*$/, (m, inner) => (t.startsWith(inner.trim()) ? '' : m)).replace(/[\s,;:(-]+$/, '').trim();
  if (t.length > 60) t = `${t.slice(0, 60).replace(/\s+\S*$/, '')}`;
  return t || null;
}

const describes = (text, words) => {
  const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9֐-׿]+/g, ' ')} `;
  return words.find((w) => t.includes(` ${String(w).toLowerCase()} `)) || null;
};

/**
 * The size a photograph must have on its shorter side, by where it goes: the cover fills the frame, a content
 * slide's photograph sits in a frame, one side of a head-to-head fills half the cover, and the ground behind the
 * slides is blurred. One floor of 800 pixels for all of them threw out nearly every photograph of today's fighters:
 * Commons keeps them at 387 to 862 pixels (Kamaru Usman, Merab Dvalishvili, Islam Makhachev), and the fight
 * account's posts went out with no face on them.
 */
export const MIN_SIDE = { cover: 600, framed: 450, half: 450, ground: 400 };

/**
 * Whether a Commons file can be used: a photograph (a JPEG, or a PNG that is no screenshot) with a licence on the
 * allowlist and a name to credit, at least `minSide` pixels on its shorter side. Pure.
 */
export function commonsUsable(c, minSide = MIN_SIDE.cover) {
  const photo = c.mime === 'image/jpeg' || (c.mime === 'image/png' && !/screen ?shot|screen capture/i.test(`${c.providerId || ''} ${c.alt || ''}`));
  return Boolean(c.url) && photo && Math.min(...c.original) >= minSide && commonsLicenseOk(c.license) && Boolean(c.author || !needsCredit(c.license));
}

const commons = {
  id: 'commons',
  ready: () => true,
  async search(query, { n = 20, minSide = MIN_SIDE.cover } = {}) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(n),
      prop: 'imageinfo|categories', iiprop: 'url|size|extmetadata|mime', iiurlwidth: '2560', iiurlheight: '2560', clshow: '!hidden', cllimit: 'max',
    });
    const body = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    return (body?.query?.pages || [])
      .map((p) => {
        const ii = p.imageinfo?.[0];
        const md = ii?.extmetadata || {};
        return {
          provider: 'commons',
          providerId: p.title,
          title: p.title,
          url: ii?.thumburl || ii?.url,
          width: ii?.thumbwidth || ii?.width,
          original: [ii?.width || 0, ii?.height || 0],
          height: ii?.thumbheight || ii?.height,
          license: plain(md.LicenseShortName?.value),
          licenseUrl: md.LicenseUrl?.value || null,
          author: creditName(plain(md.Artist?.value)),
          authorUrl: null,
          sourceUrl: ii?.descriptionurl || null,
          alt: `${p.title} ${plain(md.ImageDescription?.value)}`.slice(0, 400),
          // A file's categories name what it shows ("Steven Gerrard", "Liverpool F.C. players"), often when its title does not.
          categories: (p.categories || []).map((c) => String(c.title || '').replace(/^Category:/, '')).join(' · ').slice(0, 600),
          mime: ii?.mime,
        };
      })
      // The sharpest first: a blurry candid was picked over a portrait because it came first.
      // A portrait photograph first (a slide is 9:16, and a landscape one is cut to a third of itself), then the
      // sharpest: a portrait counts as half as large again as a landscape of the same shorter side.
      .sort((a, b) => Math.min(...b.original) * (b.original[1] >= b.original[0] * 0.9 ? 1.5 : 1) - Math.min(...a.original) * (a.original[1] >= a.original[0] * 0.9 ? 1.5 : 1))
      // A license that requires attribution is usable only with a name to attribute; a photograph big enough for
      // where it goes (MIN_SIDE).
      .filter((c) => commonsUsable(c, minSide));
  },
};

const pexels = {
  id: 'pexels',
  ready: () => isSet('PEXELS_API_KEY'),
  async search(query, { n = 15 } = {}) {
    const body = await getJson(`https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: String(n), orientation: 'portrait' })}`, {
      headers: { authorization: process.env.PEXELS_API_KEY },
    });
    return (body?.photos || []).map((p) => {
      const u = p.src?.original ? new URL(p.src.original) : null;
      if (u) for (const [k, v] of Object.entries({ auto: 'compress', cs: 'tinysrgb', fit: 'crop', crop: 'entropy', w: '1080', h: '1920' })) u.searchParams.set(k, v);
      return {
        provider: 'pexels', providerId: String(p.id), url: u?.href || p.src?.large2x, width: 1080, height: 1920,
        license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', author: p.photographer || null, authorUrl: p.photographer_url || null,
        sourceUrl: p.url || null, alt: p.alt || '',
      };
    });
  },
};

const unsplash = {
  id: 'unsplash',
  ready: () => isSet('UNSPLASH_ACCESS_KEY'),
  async search(query, { n = 15 } = {}) {
    const auth = { authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` };
    const body = await getJson(`https://api.unsplash.com/search/photos?${new URLSearchParams({ query, per_page: String(n), orientation: 'portrait', content_filter: 'high' })}`, { headers: auth });
    return (body?.results || []).map((p) => ({
      provider: 'unsplash', providerId: p.id, url: p.urls?.raw ? `${p.urls.raw}&w=1080&h=1920&fit=crop&crop=entropy&q=80&fm=jpg` : null, width: 1080, height: 1920,
      license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license', author: p.user?.name || null, authorUrl: p.user?.links?.html || null,
      sourceUrl: p.links?.html || null, alt: p.alt_description || p.description || '',
      // Their terms ask for a ping when a photo is used.
      track: p.links?.download_location || null,
    }));
  },
};

// Openverse's licence codes, as the licence's own name. Only the three a post may use: CC BY and CC BY-SA (the author
// and the licence go in the caption) and CC0. Every NC and ND licence is left out of the search and refused again here.
// So is the Public Domain Mark: it is no licence but anyone's say-so that a work has no owner, and on Flickr it is
// where agency press photographs re-uploaded by fans land ("soccer-lionel-messi-fc-barcelona-...", tagged "fbl" and
// "topix" as AFP files its pictures).
const OPENVERSE_LICENSES = { by: 'CC BY', 'by-sa': 'CC BY-SA', cc0: 'CC0' };

// A picture an agency or a newspaper owns, whatever licence an uploader put on it: its credit, or the codes the agencies
// file pictures under (AFP's "FBL" for football and "TOPIX", "TOPSHOTS" for their best of the day).
const AGENCY = /\b(?:afp|getty(?: ?images)?|reuters|ap photo|associated press|epa|dpa|imago|shutterstock|alamy|usa today|imagn|sipa|action images|pa images|topix|topshots?|fbl)\b/i;

/** The licence of an Openverse result by its own name ("CC BY-SA 2.0"), or null when it is not one a post may use. Pure. */
export function openverseLicense(r) {
  const name = OPENVERSE_LICENSES[String(r?.license || '').toLowerCase()];
  if (!name) return null;
  const v = String(r.license_version || '').trim();
  return /^\d+(?:\.\d+)?$/.test(v) ? `${name} ${v}` : name;
}

/**
 * The file to download for an Openverse result. Openverse points at the original, and a Commons original can be a
 * 5000-pixel, 10-megabyte camera file: one wider than 1280 is taken as Commons' own 1280-pixel copy. Commons makes
 * copies only at its standard widths (1280 and 1920 answer, 1440 is a 400). Pure.
 */
export function openverseFileUrl(url, width) {
  const m = /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+\.(?:jpe?g|png))$/i.exec(String(url || ''));
  return m && Number(width) > 1280 ? `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/1280px-${m[3]}` : url || null;
}

// A slug for a title ("soccer-lionel-messi-fc-barcelona") reads as words, so a name in it is found.
const unslug = (t) => (/\s/.test(t) ? t : t.replace(/[-_]+/g, ' ')).replace(/_/g, ' ');

/** One Openverse result as a candidate, every field the image row needs. Pure. */
export function openverseCandidate(r) {
  const title = unslug(String(r?.title || '').trim());
  // The photographer's own tags name what the picture shows; the machine's guesses (with an accuracy) are left out.
  const tags = (r?.tags || []).filter((t) => t?.name && t.accuracy == null).map((t) => String(t.name));
  return {
    provider: 'openverse',
    providerId: String(r?.id || ''),
    title,
    // Where Openverse found it (flickr, wikimedia, ...), for the credit line.
    upstream: String(r?.source || r?.provider || '').toLowerCase() || null,
    url: openverseFileUrl(r?.url, r?.width),
    width: Number(r?.width) || 0,
    height: Number(r?.height) || 0,
    original: [Number(r?.width) || 0, Number(r?.height) || 0],
    license: openverseLicense(r),
    licenseUrl: r?.license_url || null,
    author: String(r?.creator || '').trim() || null,
    authorUrl: r?.creator_url || null,
    sourceUrl: r?.foreign_landing_url || null,
    alt: `${title} ${tags.join(' ')}`.trim().slice(0, 400),
    categories: tags.join(' · ').slice(0, 600) || null,
    filetype: String(r?.filetype || '').toLowerCase(),
    category: r?.category || null,
    mature: Boolean(r?.mature),
  };
}

/**
 * Whether an Openverse candidate can be used: a JPEG or a PNG with a licence a post may use, an author to credit when
 * the licence asks for one, nothing marked mature, no agency's name or code on it, and at least `minSide` pixels on
 * its shorter side (a result with no size given is passed over). Pure.
 */
export function openverseUsable(c, minSide = MIN_SIDE.cover) {
  if (!c?.url || !c.license || c.mature) return false;
  if (c.category && c.category !== 'photograph') return false;
  if (!['jpg', 'jpeg', 'png', ''].includes(c.filetype || '')) return false;
  if (!/\.(?:jpe?g|png)(?:$|\?)/i.test(c.url) && !c.filetype) return false;
  if (needsCredit(c.license) && !c.author) return false;
  if (AGENCY.test(`${c.title || ''} ${c.alt || ''} ${c.author || ''}`)) return false;
  return Math.min(...c.original) >= minSide;
}

// The anonymous allowance is 20 searches a minute and 200 a day. A search Openverse turned away (429) rests the
// library for an hour, so the posts after it do not each wait out the door's retries for nothing.
let openverseRestUntil = 0;

const openverse = {
  id: 'openverse',
  ready: () => Date.now() >= openverseRestUntil,
  async search(query, { n = 20, minSide = MIN_SIDE.cover } = {}) {
    // Never NC, ND or the Public Domain Mark; nothing marked sensitive (the default), no dead links. Drawings and
    // scanned artworks are left out here (openverseUsable), not in the search: asking for category=photograph also
    // drops every picture Openverse has not classified, most of Flickr's ("UFC octagon": 73 results without it, none with it).
    const params = new URLSearchParams({ q: String(query).slice(0, 200), license: Object.keys(OPENVERSE_LICENSES).join(','), page_size: String(Math.min(20, n)) });
    const url = `https://api.openverse.org/v1/images/?${params}`;
    // OPENVERSE_TOKEN: an access token for a registered application (its allowance is higher). It expires; an expired
    // one is dropped for the anonymous allowance rather than failing the search.
    const token = String(process.env.OPENVERSE_TOKEN || '').trim();
    // A search Openverse has not answered before can take it close to a minute (measured 11 to 55 seconds on
    // 2026-10-27; an answer it has given is cached and comes in half a second): the door's 30 seconds cut most short.
    const timeoutMs = 75_000;
    let body;
    try {
      body = await getJson(url, token ? { headers: { authorization: `Bearer ${token}` }, timeoutMs } : { timeoutMs });
    } catch (e) {
      if (token && (e.status === 401 || e.status === 403)) body = await getJson(url, { timeoutMs }).catch((e2) => rest(e2));
      else rest(e);
    }
    return (body?.results || []).map(openverseCandidate).filter((c) => openverseUsable(c, minSide));
  },
};

function rest(e) {
  if (e?.status === 429) openverseRestUntil = Date.now() + 60 * 60_000;
  throw e;
}

// Words that say nothing about what a photograph shows: matching on them put any photo on any query.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'of', 'at', 'in', 'on', 'photo', 'picture', 'image', 'של', 'עם']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9֐-׿]+/).filter((w) => w.length >= 3 && !STOP.has(w));
// An owner's photograph's tags, a list or one line of words.
const tagsOf = (p) => (Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || ''));

/** The owner's photographs of a pack (<pack>/photos/photos.json), or []. */
export function packPhotoList(pack) {
  const file = pack?.dir ? path.join(pack.dir, 'photos', 'photos.json') : null;
  if (!file || !existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')).photos;
    return Array.isArray(list) ? list.filter((p) => p?.file) : [];
  } catch {
    return [];
  }
}

/**
 * The owner's photographs that fit a query, best first. A photograph matches on its own words: its subject (who or
 * what it shows), its description and its tags, as many of the query's words as the query has, up to two. The
 * subject's words count double, so the photograph of the person a query names comes before one that only mentions
 * the event. Pure but for reading the pack's file.
 */
export function packMatches(pack, query) {
  const want = new Set(words(query));
  if (!want.size) return [];
  return packPhotoList(pack)
    .map((p) => {
      const subject = new Set(words(p.subject).filter((w) => want.has(w)));
      const all = new Set(words(`${p.subject || ''} ${p.description || ''} ${tagsOf(p)}`).filter((w) => want.has(w)));
      return { p, hits: all.size, score: 2 * subject.size + all.size };
    })
    .filter((x) => x.hits >= Math.min(2, want.size))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

/**
 * Photographs the owner added by hand to the pack (<pack>/photos/photos.json):
 * an event photo the owner decided the account may use, with where it came from
 * and whom to credit. Matched to a query by its subject, description and tags
 * (packMatches), and tried before every library whenever the pack has any
 * (providerOrder). Every one still passes the image screen, with the owner's
 * description given to it as what the picture shows, and its origin is stored.
 */
const packPhotos = {
  id: 'pack',
  ready: () => true,
  async search(query, { pack } = {}) {
    const dir = path.join(pack?.dir || '', 'photos');
    return packMatches(pack, query).map((p) => ({
      provider: 'pack', providerId: p.file, file: path.join(dir, p.file), url: null, license: p.license || 'used by the owner\'s decision', licenseUrl: null,
      author: p.credit || null, authorUrl: null, sourceUrl: p.origin || null, alt: `${p.subject || ''} ${p.description || ''} ${tagsOf(p)}`.replace(/\s+/g, ' ').trim(),
      owner: `${p.subject || ''}${p.description ? `: ${p.description}` : ''}`.trim(),
    }));
  },
};

export const PROVIDERS = { pexels, unsplash, commons, openverse, pack: packPhotos };

/** The libraries a pack searches when its pack.json names none. */
export const DEFAULT_PROVIDERS = ['pack', 'pexels', 'unsplash', 'commons', 'openverse'];

/**
 * The order a pack's photographs are searched in: the owner's own first whenever the pack has any, even when
 * imagery.providers leaves 'pack' out, and then the pack's libraries (or DEFAULT_PROVIDERS) in its own order. A pack
 * with no photographs of its own does not search for them.
 */
export function providerOrder(pack) {
  const listed = (pack?.meta?.imagery?.providers || DEFAULT_PROVIDERS).filter((id) => id !== 'pack');
  return [...(packPhotoList(pack).length ? ['pack'] : []), ...new Set(listed)];
}

/**
 * Whether a picture's title names the person a query names: two of the query's name
 * words side by side, as a name is written ("Holly_Holm_at_UFC"). A word of the name
 * was not enough ("Holm" matched "Rudder Rock, Steep Holm Island", "Serra" a plant
 * called Senecio serra), and neither were both words apart ("Holly with berries, Holm
 * Hill"). A query with a single name word needs that word.
 */
export function namesIn(title, names) {
  const words = String(title).toLowerCase().replace(/[_%]/g, ' ').split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  const want = names.map((n) => n.toLowerCase());
  if (want.length < 2) return want.every((n) => words.includes(n));
  return want.slice(1).some((b, i) => words.some((w, j) => w === want[i] && words[j + 1] === b));
}

/** Does a file's title name a person or a place (two capitalised words in a row), rather than a camera's numbering? */
export function titleNamesSomeone(title) {
  const t = String(title || '').replace(/^File:/, '').replace(/\.[a-z]{3,4}$/i, '').replace(/[_()-]/g, ' ');
  return /\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+/u.test(t);
}

/** CC BY and CC BY-SA require the author and the license next to the picture. */
export const needsCredit = (license) => /\bby\b|attribution/i.test(String(license || ''));

/** The names a query asks a picture to show: its capitalised words, less the promotions' and the sport's own. */
export const namesOf = (query) => String(query).split(/\s+/).filter((w) => /^\p{Lu}\p{L}{2,}/u.test(w) && !/^(UFC|PFL|ONE|MMA|BJJ|FC|The|Stadium|Arena|Park)$/i.test(w));

const PROVIDER_NAME = { commons: 'Wikimedia Commons', pexels: 'Pexels', unsplash: 'Unsplash', openverse: 'Openverse' };
// Where Openverse found a picture, by the name its own site goes by: a credit says "Flickr via Openverse".
const UPSTREAM_NAME = { flickr: 'Flickr', wikimedia: 'Wikimedia Commons', nappy: 'Nappy', rawpixel: 'rawpixel', stocksnap: 'StockSnap' };

/** The library a photograph is credited to: an aggregator's with where it found it (match_json.upstream). */
export function creditedTo(img) {
  const name = PROVIDER_NAME[img.provider] || img.provider;
  const up = img.provider === 'openverse' ? j(img.match_json, {})?.upstream : null;
  return up ? `${UPSTREAM_NAME[up] || up} via ${name}` : name;
}

/** Every photograph a post shows: its slides' and its lead one, once each. */
export function postImages(db, post) {
  const ids = [...new Set([...(post.slides || []).map((s) => s.image_id), post.checks?.image, post.checks?.bgImage, ...(post.checks?.coverImages || [])].filter(Boolean))];
  return ids.map((id) => db.get('SELECT * FROM images WHERE id = ?', id)).filter(Boolean);
}

/** The photographs of a post the screen could not clear and no person has looked at yet. */
export const waitingImages = (db, post) => postImages(db, post).filter((img) => img.safety && img.safety !== 'ok' && !img.reviewed_at);

/**
 * The credit line a post's caption carries for the photos whose license asks for
 * one, or ''. It is added when the caption is published, after the checks: a
 * license name ("CC BY-SA 4.0") is not a claim, and its numbers are not facts.
 */
export function imageCredit(db, post) {
  const ids = [...new Set((post.slides || []).map((s) => s.image_id).filter(Boolean))];
  const credits = ids
    .map((id) => db.get('SELECT provider, license, author, match_json FROM images WHERE id = ?', id))
    .filter((img) => img && needsCredit(img.license))
    .map((img) => `${img.author} · ${img.license} · ${creditedTo(img)}`);
  return credits.length ? `${credits.length > 1 ? 'צילומים' : 'צילום'}: ${[...new Set(credits)].join(' | ')}` : '';
}

/**
 * One licensed photograph for a query, stored with its licence, or null.
 * `mode` 'recorded' never touches the network and returns null: offline runs
 * render the theme's own ground instead of a photograph. A run that wants real
 * photographs with recorded drafts (the launch set) sets ctx.imagesLive.
 * `why`, when given, counts what each candidate was passed over for ({ "does not name the person": 7, ... }): the
 * post's image step keeps it, so an account whose posts come out without photographs can be told why
 * (npm run images:check).
 * `role` is what the picture is for: 'content' (a slide's photograph in its frame, which illustrates what the slide
 * is about and is never asked to show an abstract claim, a price cap or a statistic) or 'cover' (everything else: a
 * cover, a portrait, a background, checked against the slide's whole claim). A framed photograph is a content one.
 */
export async function findImage(ctx, { pack, query, postId = null, claim = '', why = null, minSide = MIN_SIDE.cover, role = minSide === MIN_SIDE.framed ? 'content' : 'cover' }) {
  const miss = (k) => why && (why[k] = (why[k] || 0) + 1);
  if (!query || (ctx.mode === 'recorded' && !ctx.imagesLive)) return null;
  // A query with a blocked word in it is searched without that word: "Lamine Yamal World Cup trophy" was refused whole,
  // and a guess-who whose answer has hundreds of free photographs went out with none. What is blocked is still never
  // shown: a photograph whose description names it is refused below, and the screen looks at every one.
  for (let blocked = blockedQuery(pack, query) || describes(query, ALWAYS_BLOCK); blocked; blocked = blockedQuery(pack, query) || describes(query, ALWAYS_BLOCK)) {
    const bad = String(blocked).toLowerCase();
    const rest = String(query).split(/\s+/).filter((w) => {
      const n = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      return n !== bad && n !== `${bad}s`;
    }).join(' ').trim();
    if (!/\p{L}/u.test(rest) || rest === query) {
      ctx.log?.(`image query refused ("${blocked}"): ${query}`);
      miss(`the query has a blocked word ("${blocked}")`);
      return null;
    }
    ctx.log?.(`image query without "${blocked}": ${rest}`);
    query = rest;
  }
  // The owner's own photographs first, whenever the pack has any; then the pack's libraries in its own order.
  const order = providerOrder(pack).map((id) => PROVIDERS[id]).filter((p) => p?.ready());
  if (!order.length) miss('no photo library is ready (its key is missing)');
  const block = [...ALWAYS_BLOCK, ...(pack.rules?.imageQueryBlock || [])];
  for (const prov of order) {
    let found = [];
    try {
      found = await prov.search(query, { pack, minSide });
      if (prov.id !== 'pack') record(ctx.db, { accountId: pack.id, postId, api: prov.id, usd: 0, tag: 'image-search' });
    } catch (e) {
      ctx.log?.(`${prov.id}: ${e.message}`);
      miss(`${prov.id}: the search failed`);
      continue;
    }
    if (!found.length) miss(`${prov.id}: no results`);
    // A query that names someone ("Holly Holm UFC") takes only a picture whose own title
    // names them too: a search can return a photo of somebody else from the same event.
    const names = namesOf(query);
    for (const c of found) {
      // A redo for its photographs: the customer turned these down on the post it replaces.
      if (ctx.avoidImages?.has(`${c.provider}:${c.providerId}`)) {
        miss('the customer turned it down');
        continue;
      }
      if (describes(c.alt, block)) {
        miss('a blocked word in its description');
        continue;
      }
      // The name in the file's own title. A title that names nobody (a camera's "IMG_2041.jpg") may be named by its
      // description or categories; a title that names someone else may not: a photo titled for Mitsuyo Maeda, filed
      // under a category of Hélio Gracie, went on a Hélio Gracie cover.
      // (An Openverse picture's id is a code, not a name: its title is a field of its own.)
      const title = c.title ?? c.providerId;
      if (names.length && !namesIn(String(title || ''), names) && (titleNamesSomeone(title) || !namesIn(`${c.alt || ''} ${c.categories || ''}`, names))) {
        miss('its title does not name the person');
        continue;
      }
      if (!c.license) {
        miss('no licence');
        continue;
      }
      let bytes;
      try {
        bytes = c.file ? { buf: readFileSync(c.file), type: /\.png$/i.test(c.file) ? 'image/png' : 'image/jpeg' } : await getBytes(c.url);
      } catch {
        miss('the download failed');
        continue;
      }
      // A see-through PNG is flattened onto the account's ground first: what is screened is what is stored and drawn.
      if (imageSize(bytes.buf)?.alpha) {
        try {
          bytes = { buf: await flatten(bytes.buf, pack.theme?.colors?.bg), type: 'image/jpeg' };
        } catch {
          miss('a see-through PNG could not be flattened');
          continue;
        }
      }
      // The screen: a picture with blood, an injury, a fighter down, a watermark, a belt or a weapon is never used.
      const screen = await screenImage(ctx, { pack, buf: bytes.buf, type: bytes.type, meta: `${title || ''} ${c.alt || ''} ${c.categories || ''}`, postId, query, claim, role, owner: c.owner || '' });
      if (screen.safety === 'refused') {
        ctx.log?.(`image refused (${screen.why}): ${c.providerId}`);
        miss(`the screen refused it: ${String(screen.why || '').slice(0, 80)}`);
        continue;
      }
      const match = { title: Boolean(names.length), model: screen.model ? { consistent: screen.model.consistent, mainSubject: screen.model.mainSubject } : null, claim: claim ? claim.slice(0, 200) : null, role, ...(c.upstream ? { upstream: c.upstream } : {}) };
      if (c.track) getJson(c.track, { headers: { authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } }).catch(() => {});
      const hash = createHash('sha256').update(bytes.buf).digest('hex');
      const dir = ensureDir(path.join(mediaDir(), 'images'));
      const file = path.join(dir, `${hash.slice(0, 24)}.${bytes.type === 'image/png' ? 'png' : 'jpg'}`);
      writeFileSync(file, bytes.buf);
      const id = ctx.db.insert('images', {
        provider: c.provider, provider_id: c.providerId, license: c.license, license_url: c.licenseUrl, author: c.author, author_url: c.authorUrl,
        source_url: c.sourceUrl, alt: c.alt, query, ai_generated: 0, realistic: 0, file, sha256: hash, created_at: nowIso(),
        safety: screen.safety, safety_json: screen, match_json: match, categories: c.categories || null,
      });
      return ctx.db.get('SELECT * FROM images WHERE id = ?', id);
    }
  }
  return null;
}
