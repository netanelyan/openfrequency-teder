import { deleteJson, getJson, postJson } from '../core/net.js';
import { isSet } from '../core/env.js';

// Posting through Zernio: one Zernio profile per account (a customer's), with its TikTok and Instagram connected into
// it by the customer themselves (src/publish/connect.js).
//
// What it can do to an account: create a post on it. Besides that it creates a profile (an empty folder on our own
// Zernio team), disconnects a deleted customer's accounts from our team and removes their profile, and reads: the connect link, the connected accounts and their health, analytics, and the bill. Nothing
// here reads an inbox, comments, likes, follows or messages anyone; the network door refuses those Zernio paths by
// name (src/core/net.js), so this file could not if it tried.
//
// The request shape follows docs.zernio.com: images as mediaItems (Zernio
// fetches them by URL, so slides must be served from a public https address),
// TikTok's settings including its two consent flags, and publishNow. A post
// Zernio accepted and is still processing when the wait runs out is not a
// failure: it is recorded under Zernio's id and checked again later, because
// retrying it is how a post goes out twice.
//
// HARD RULE 4: when a post carries a realistic AI-generated image, TikTok's
// `video_made_with_ai` flag is the platform's disclosure. Zernio documents that
// direct photo posts reject it for some accounts, so a photo post with such an
// image is sent as a draft (`draft: true`) for the label to be set in the app,
// and the website says so. Instagram's API has no such flag: the caption gets a
// plain disclosure line instead.
//
// The sound. Left to `auto_add_music`, TikTok put tracks on our photo posts that
// nobody listens to. A business account can attach a Commercial Music Library
// track instead, and Zernio lists the 100 trending ones for a country, ranked.
// That chart is royalty-free library music, not the viral songs: those can only
// be added by hand in the TikTok app, and no API reaches them. Each post takes
// the best-ranked track the account has not used lately, so consecutive posts do
// not share one sound. When the chart cannot be read, TikTok picks as before. A
// draft ignores the track (TikTok drops post settings in the inbox flow), so a
// draft keeps TikTok's pick and the owner can change it in the app.

const BASE = () => (process.env.ZERNIO_BASE || 'https://zernio.com/api/v1').replace(/\/$/, '');
const auth = () => ({ authorization: `Bearer ${String(process.env.ZERNIO_API_KEY || '').trim()}` });

export const zernioConfigured = () => isSet('ZERNIO_API_KEY');

export class ZernioError extends Error {
  constructor(message, { step, code = null, status = null, category = null } = {}) {
    super(message);
    this.name = 'ZernioError';
    this.step = step;
    this.code = code;
    this.status = status;
    this.category = category;
  }
}

export const AI_CAPTION_LINE = 'התמונה בפוסט נוצרה בעזרת AI.';

/** The request body for one platform. Pure, so the tests can read it. */
export function postBody({ platform, accountId, caption, imageUrls, privacy = 'SELF_ONLY', aiLabel = false, title = '', aiAsDraft = true, sound = null, asDraft = false }) {
  if (platform === 'tiktok') {
    // A draft goes to the TikTok app's inbox for the owner to publish: the AI label's way, and draft-fallback's.
    const draft = asDraft || (aiLabel && aiAsDraft);
    const track = sound?.id && !draft;
    return {
      content: String(title).slice(0, 90),
      mediaItems: imageUrls.map((url) => ({ type: 'image', url })),
      platforms: [{ platform: 'tiktok', accountId }],
      tiktokSettings: {
        privacy_level: privacy,
        allow_comment: true,
        media_type: 'photo',
        photo_cover_index: 0,
        description: String(caption).slice(0, 4000),
        auto_add_music: !track,
        ...(track ? { musicSoundInfo: { musicSoundId: String(sound.id) } } : {}),
        content_preview_confirmed: true,
        express_consent_given: true,
        ...(aiLabel ? { video_made_with_ai: true } : {}),
        ...(draft ? { draft: true } : {}),
      },
      publishNow: true,
    };
  }
  return {
    content: `${String(caption)}${aiLabel ? `\n\n${AI_CAPTION_LINE}` : ''}`.slice(0, 2200),
    mediaItems: imageUrls.map((url) => ({ type: 'image', url })),
    platforms: [{ platform, accountId }],
    publishNow: true,
  };
}

function partOf(post, platform) {
  const p = (post?.platforms || []).find((x) => x.platform === platform) || {};
  return { status: p.status || post?.status || null, url: p.platformPostUrl || null, postId: p.platformPostId ? String(p.platformPostId) : null, error: p.errorMessage || null, category: p.errorCategory || null };
}

/** Create one post on one platform and wait for it, up to timeoutMs. */
export async function publishZernio({ platform, accountId, caption, imageUrls, privacy, aiLabel, title, aiAsDraft = true, sound = null, asDraft = false }, { pollMs = 5000, timeoutMs = 180_000 } = {}) {
  if (!zernioConfigured()) throw new ZernioError('ZERNIO_API_KEY is not set', { step: 'config', code: 'not_configured' });
  if (!accountId) throw new ZernioError(`no Zernio ${platform} account id in pack.json`, { step: 'config', code: 'no_account' });
  if (platform === 'tiktok' && (imageUrls.length < 2 || imageUrls.length > 35)) throw new ZernioError(`a TikTok photo post takes 2 to 35 images, this one has ${imageUrls.length}`, { step: 'config', code: 'card_images' });
  if (platform === 'instagram' && imageUrls.length > 10) throw new ZernioError(`an Instagram carousel takes at most 10 images, this one has ${imageUrls.length}`, { step: 'config', code: 'card_images' });
  let created;
  try {
    created = await postJson(`${BASE()}/posts`, postBody({ platform, accountId, caption, imageUrls, privacy, aiLabel, title, aiAsDraft, sound, asDraft }), { headers: auth(), timeoutMs: 30_000 });
  } catch (e) {
    throw new ZernioError(e.message, { step: 'create', code: e.code, status: e.status, category: e.body?.error?.errorCategory || null });
  }
  const id = created?.post?._id;
  if (!id) throw new ZernioError('Zernio accepted the post but returned no id', { step: 'create', code: 'no_id' });
  let part = partOf(created.post, platform);
  const deadline = Date.now() + timeoutMs;
  while (!['published', 'failed', 'cancelled'].includes(part.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const { post } = await getJson(`${BASE()}/posts/${encodeURIComponent(id)}`, { headers: auth() });
    part = partOf(post, platform);
  }
  if (part.status === 'failed' || part.status === 'cancelled') {
    throw new ZernioError(`${platform} refused the post: ${part.error || part.status}`, { step: 'status', code: part.category || part.status, category: part.category });
  }
  const draft = Boolean((asDraft || (aiLabel && aiAsDraft)) && platform === 'tiktok');
  return { via: 'zernio', zernioId: id, postId: part.postId, url: part.url, status: part.status, pending: part.status !== 'published', draft, ...(platform === 'tiktok' && sound?.id && !draft ? { sound } : {}) };
}

// The chart moves slowly; one read serves an account's posts for a few hours.
const CHART_TTL_MS = 6 * 3600_000;
const charts = new Map();

/** The trending Commercial Music Library chart for a country, as Zernio ranks it: [{ id, name, artist, rank, clipSec }]. */
export async function soundChart(accountId, countryCode = 'IL') {
  const key = `${accountId}:${countryCode}`;
  const hit = charts.get(key);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.tracks;
  const body = await getJson(`${BASE()}/accounts/${encodeURIComponent(accountId)}/tiktok/commercial-music?${new URLSearchParams({ countryCode })}`, { headers: auth() });
  const tracks = (body?.tracks || [])
    .filter((t) => t.clip?.id) // TikTok takes the clip's id at publish time, not the track's
    .map((t) => ({ id: String(t.clip.id), name: String(t.name || ''), artist: String(t.artist || ''), rank: Number(t.rank) || 999, clipSec: Number(t.clip.durationSec) || 0 }))
    .sort((a, b) => a.rank - b.rank);
  charts.set(key, { at: Date.now(), tracks });
  return tracks;
}

/** A clip this short ends before the reader is past the second slide. */
const MIN_CLIP_SEC = 15;
/** How far down the chart a post may go to avoid repeating a recent sound. */
const TOP = 10;

/** The best-ranked usable track not in `recent` (ids the account used lately). Pure, so the tests can read it. */
export function pickSound(tracks, recent = []) {
  const usable = tracks.filter((t) => t.clipSec >= MIN_CLIP_SEC).slice(0, TOP);
  return usable.find((t) => !recent.includes(t.id)) || usable[0] || null;
}

/** A trending track for the next post, or null to let TikTok pick (no chart, or Zernio could not be read). */
export async function trendingSound(accountId, { countryCode = 'IL', recent = [] } = {}) {
  try {
    return pickSound(await soundChart(accountId, countryCode), recent);
  } catch {
    return null;
  }
}

/**
 * The account's TikTok posts that were not sent through Zernio, published since `from`, as Zernio synced them from
 * TikTok: [{ id, publishedAt, content, url }]. A draft the owner publishes in the app comes back this way, the same
 * analytics read the metrics use (src/metrics/collect.js), filtered to source=external.
 */
export async function externalPosts(accountId, { from }) {
  const q = new URLSearchParams({ accountId, platform: 'tiktok', source: 'external', fromDate: new Date(from).toISOString().slice(0, 10), sortBy: 'date', order: 'desc', limit: '50' });
  const body = await getJson(`${BASE()}/analytics?${q}`, { headers: auth() });
  const list = body?.posts || body?.data || (body?.post ? [body.post] : []);
  return list.map((p) => {
    const part = (p.platformAnalytics || []).find((x) => x.platform === 'tiktok') || {};
    return { id: String(p.postId || p._id || part.platformPostId || ''), publishedAt: p.publishedAt || null, content: String(p.content || ''), url: p.platformPostUrl || part.platformPostUrl || null };
  }).filter((p) => p.id && p.publishedAt);
}

const words = (s) => String(s || '').replace(/#\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length > 1);

/**
 * The external post that is this draft published, or null. Pure. It went out after the draft was sent, no one else
 * claimed it, and its caption is ours: at least half the words of our caption's first line are in it (the owner may
 * trim it, add a word, change the tags). With no caption to compare (TikTok returned none), the one post published
 * since the draft was sent is it, when there is exactly one.
 */
export function matchDraft({ caption, sentAt }, posts, claimed = []) {
  const since = Date.parse(sentAt) - 5 * 60_000;
  const fresh = posts.filter((p) => Date.parse(p.publishedAt) >= since && !claimed.includes(p.id));
  const ours = words(String(caption || '').split('\n').find((l) => l.trim()) || '');
  const close = (p) => {
    const theirs = new Set(words(p.content));
    return ours.length && ours.filter((w) => theirs.has(w)).length >= Math.ceil(ours.length / 2);
  };
  return fresh.find(close) || (fresh.length === 1 && !words(fresh[0].content).length ? fresh[0] : null);
}

/** Our connected accounts on Zernio, for the check script: [{ id, platform, username, active }]. */
export async function zernioAccounts() {
  const body = await getJson(`${BASE()}/accounts`, { headers: auth() });
  return (body?.accounts || []).map((a) => ({ id: a._id, platform: a.platform, username: a.username || a.displayName || '', active: a.isActive !== false && !a.needsReconnection }));
}

/** A platform strike or a content-policy refusal: the account pauses, it does not retry. */
export const isStrike = (e) => e instanceof ZernioError && (e.category === 'user_content' || /strike|violation|banned|suspend|restricted|spam/i.test(`${e.code} ${e.message}`));

/** Broken until somebody fixes the connection. */
export const isConfigProblem = (e) => e instanceof ZernioError && (e.status === 401 || e.status === 403 || e.category === 'auth_expired' || ['not_configured', 'no_account'].includes(e.code));

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** One platform's numbers as the metrics table keeps them. Pure, so the tests can read it. */
export function statsOf(platform, a = {}) {
  return {
    views: num(a.views ?? a.impressions),
    reach: num(a.reach),
    likes: num(a.likes),
    comments: num(a.comments),
    shares: num(a.shares),
    saves: platform === 'tiktok' ? null : num(a.saves),
    // Link clicks only where Zernio reports them: TikTok's are the profile's website link (websiteClicks), never a guess.
    linkClicks: platform === 'tiktok' ? num(a.websiteClicks) : num(a.clicks ?? a.linkClicks),
    follows: num(a.follows),
    profileVisits: num(a.profileViews),
  };
}

/**
 * Per-post numbers from Zernio's analytics: { platform: stats }, or null while nothing is synced yet.
 *
 * GET /analytics?postId= answers one post as a flat object, its numbers per platform in platformAnalytics[], with 202
 * while TikTok or Instagram has not been read yet (a platform still pending is left out, never stored as zeros) and
 * 424 when the post failed everywhere. A Zernio post id and a platform's own post id (a draft the owner published) are
 * both taken. On a legacy plan without the Analytics add-on it is 402: a config problem, said once by the collector.
 */
export async function zernioAnalytics(zernioId) {
  let body;
  try {
    body = await getJson(`${BASE()}/analytics?${new URLSearchParams({ postId: zernioId })}`, { headers: auth() });
  } catch (e) {
    if (e.status === 424) return null;
    if (e.status === 402) throw new ZernioError('Zernio answers analytics only with the Analytics add-on on this plan', { step: 'analytics', code: 'analytics_addon_required', status: 402 });
    throw e;
  }
  const out = {};
  const parts = Array.isArray(body?.platformAnalytics) && body.platformAnalytics.length ? body.platformAnalytics : body?.platform && body?.analytics ? [{ platform: body.platform, analytics: body.analytics, syncStatus: body.syncStatus }] : [];
  for (const p of parts) {
    if (!p?.platform || !p.analytics || ['pending', 'unavailable'].includes(p.syncStatus) || p.status === 'failed') continue;
    out[p.platform] = statsOf(p.platform, p.analytics);
  }
  // The list shape (an older answer, or a lookup that came back as one).
  for (const p of body?.posts || (body?.post ? [body.post] : [])) if (p.platform && p.analytics && !out[p.platform]) out[p.platform] = statsOf(p.platform, p.analytics);
  return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ one profile per customer account */

// A profile is Zernio's folder for one customer: their TikTok and their Instagram are connected into it, and Zernio's
// bill is split by it. Profiles cost nothing; each connected account does (zernio.com/pricing).

const profileOf = (p) => (p?._id ? { id: String(p._id), name: String(p.name || ''), externalId: p.externalId || null } : null);

/** The profile whose externalId is ours (the pack id), or null. */
export async function findProfile(externalId) {
  const body = await getJson(`${BASE()}/profiles?${new URLSearchParams({ externalId })}`, { headers: auth() });
  return profileOf((body?.profiles || []).find((p) => p.externalId === externalId));
}

/**
 * Create the profile of one account: named for it, its externalId the pack id. The Idempotency-Key is the pack id too,
 * so a create whose answer was lost and is sent again gets the same profile; a 409 (it exists already, under that
 * name or that externalId) is answered by finding it.
 */
export async function createProfile({ name, externalId }) {
  if (!zernioConfigured()) throw new ZernioError('ZERNIO_API_KEY is not set', { step: 'config', code: 'not_configured' });
  try {
    const body = await postJson(`${BASE()}/profiles`, { name: String(name).slice(0, 80), externalId, description: 'OpenFrequency (Teder)' }, { headers: { ...auth(), 'idempotency-key': `of-profile-${externalId}` }, timeoutMs: 30_000 });
    const p = profileOf(body?.profile);
    if (!p) throw new ZernioError('Zernio created the profile but returned no id', { step: 'profile', code: 'no_id' });
    return p;
  } catch (e) {
    if (e instanceof ZernioError) throw e;
    if (e.status === 409) {
      const found = (await findProfile(externalId)) || (e.body?.details?.existingProfileId ? { id: String(e.body.details.existingProfileId), name, externalId: null } : null);
      if (found) return found;
    }
    throw new ZernioError(e.message, { step: 'profile', code: e.code, status: e.status });
  }
}

/* ------------------------------------------------------------------ connecting TikTok and Instagram */

export const CONNECT_PLATFORMS = ['tiktok', 'instagram'];

/**
 * Zernio's link to connect (or reconnect) one platform into a profile, headless (docs.zernio.com, GET
 * /v1/connect/{platform}, headless=true): straight to the platform's own consent screen, no Zernio welcome screen or
 * picker, then back to `redirectUrl`. TikTok and Instagram (Instagram Login, pinned here) need no selection, so the
 * account is connected at once and the return carries connected=, accountId=, username= (or error=). Zernio still
 * passes the return through its own one-click notice (zernio.com/connect/continue) for an address on another site. An
 * Instagram account that comes back through Facebook Login instead (a reconnect of one connected that way) returns
 * step=select_account with a tempToken, and is finished here (instagramPages, selectInstagram). The link works for 30
 * minutes, so it is asked for at the moment someone taps, never stored or sent on.
 */
export async function connectUrl(platform, { profileId, redirectUrl, reconnectAccountId = null }) {
  if (!CONNECT_PLATFORMS.includes(platform)) throw new ZernioError(`not a platform to connect: ${platform}`, { step: 'connect', code: 'bad_platform' });
  const q = new URLSearchParams({ profileId, redirect_url: redirectUrl, headless: 'true' });
  if (platform === 'instagram') q.set('loginMethod', 'instagram_login');
  if (reconnectAccountId) q.set('reconnectAccountId', reconnectAccountId);
  let body;
  try {
    body = await getJson(`${BASE()}/connect/${platform}?${q}`, { headers: auth() });
  } catch (e) {
    throw new ZernioError(e.message, { step: 'connect', code: e.code, status: e.status });
  }
  if (!/^https:\/\//.test(String(body?.authUrl || ''))) throw new ZernioError('Zernio returned no connect link', { step: 'connect', code: 'no_url' });
  return body.authUrl;
}

/** The headers a headless selection call carries: the token from the return, in a header rather than the address. */
const selectionHeaders = ({ tempToken, connectToken }) => ({ ...auth(), 'x-temp-token': String(tempToken), ...(connectToken ? { 'x-connect-token': String(connectToken) } : {}) });

/**
 * The Instagram professional accounts a Facebook Login return can connect: [{ pageId, name, username, igId }], one per
 * Facebook Page with an Instagram account linked (GET /v1/connect/instagram/select-account).
 */
export async function instagramPages({ profileId, tempToken, connectToken = null }) {
  let body;
  try {
    body = await getJson(`${BASE()}/connect/instagram/select-account?${new URLSearchParams({ profileId })}`, { headers: selectionHeaders({ tempToken, connectToken }) });
  } catch (e) {
    throw new ZernioError(e.message, { step: 'select', code: e.code, status: e.status });
  }
  return (body?.pages || [])
    .filter((p) => p?.id && p.instagram_business_account?.id)
    .map((p) => ({ pageId: String(p.id), name: String(p.name || ''), username: String(p.instagram_business_account.username || ''), igId: String(p.instagram_business_account.id) }));
}

/** Connect the Instagram account of the Page picked (POST /v1/connect/instagram/select-account): { accountId, username }. */
export async function selectInstagram({ profileId, pageId, tempToken, connectToken = null, redirectUrl = null }) {
  let body;
  try {
    body = await postJson(`${BASE()}/connect/instagram/select-account`, { profileId, pageId, ...(redirectUrl ? { redirect_url: redirectUrl } : {}) }, { headers: selectionHeaders({ tempToken, connectToken }), timeoutMs: 30_000 });
  } catch (e) {
    throw new ZernioError(e.message, { step: 'select', code: e.code, status: e.status });
  }
  const a = body?.account;
  if (!a?.accountId) throw new ZernioError('Zernio connected nothing', { step: 'select', code: 'no_account' });
  return { accountId: String(a.accountId), username: String(a.username || '') };
}

/**
 * Each connected TikTok and Instagram account in a profile, with its health: [{ id, platform, username, status, issue }].
 * status is 'connected', or 'reconnect' when Zernio says the token expired or was revoked, a permission is missing,
 * or the account is inactive. The health read is the finer one; when it cannot be read, the listing's flag decides.
 */
export async function profileConnections(profileId) {
  const body = await getJson(`${BASE()}/accounts?${new URLSearchParams({ profileId })}`, { headers: auth() });
  let health = new Map();
  try {
    const h = await getJson(`${BASE()}/accounts/health?${new URLSearchParams({ profileId })}`, { headers: auth() });
    health = new Map((h?.accounts || []).map((a) => [String(a.accountId), a]));
  } catch {
    /* the listing's own flag stands in */
  }
  // A profile can hold more than one account of a platform: the newest active one is the account's.
  return (body?.accounts || [])
    .filter((a) => CONNECT_PLATFORMS.includes(a.platform) && a.enabled !== false)
    .map((a) => {
      const hh = health.get(String(a._id));
      const broken = a.isActive === false || a.needsReconnection === true || hh?.needsReconnect === true || hh?.tokenValid === false || hh?.canPost === false;
      return { id: String(a._id), platform: a.platform, username: String(a.username || a.displayName || ''), status: broken ? 'reconnect' : 'connected', issue: broken ? String(hh?.issues?.[0] || (a.needsReconnection ? 'needs reconnection' : 'inactive')).slice(0, 200) : null };
    });
}

/** The ids of every account on our Zernio team, in any profile, over-limit ones too. */
export async function teamAccountIds() {
  const body = await getJson(`${BASE()}/accounts?${new URLSearchParams({ includeOverLimit: 'true' })}`, { headers: auth() });
  return new Set((body?.accounts || []).map((a) => String(a._id)));
}

/* ------------------------------------------------------------------ what Zernio bills, per profile */

/**
 * Zernio's spend in a window, split per profile, from its usage-based invoice: { supported, byProfile: { id: usd },
 * total }. `from` and `to` are UTC dates (YYYY-MM-DD), inclusive. A legacy Stripe plan has no invoice to split:
 * { supported: false }.
 */
export async function profileSpend({ from, to }) {
  const q = new URLSearchParams({ range: 'custom', from, to, granularity: 'total', groupBy: 'profile' });
  const body = await getJson(`${BASE()}/usage?${q}`, { headers: auth() });
  if (body?.supported === false) return { supported: false, byProfile: {}, total: 0 };
  const groups = body?.attribution?.groups || [];
  return { supported: true, byProfile: Object.fromEntries(groups.filter((g) => g?.key).map((g) => [String(g.key), num(g.totalUsd) ?? 0])), total: num(body?.attribution?.totals?.totalUsd ?? body?.totals?.total) ?? 0 };
}

/* ------------------------------------------------------------------ a customer who left */

/**
 * Disconnect one connected account from our Zernio team, so Zernio stops billing for it: the customer deleted their
 * workspace (src/web/workspace-delete.js). One that is gone already (404) is fine.
 */
export async function disconnectAccount(accountId) {
  try {
    await deleteJson(`${BASE()}/accounts/${encodeURIComponent(accountId)}`, { headers: auth(), timeoutMs: 15_000 });
    return { ok: true, gone: false };
  } catch (e) {
    if (e.status === 404) return { ok: true, gone: true };
    throw new ZernioError(e.message, { step: 'disconnect', code: e.code, status: e.status });
  }
}

/** Remove a deleted customer's profile from our team, after its accounts. One that is gone already (404) is fine. */
export async function deleteProfile(profileId) {
  try {
    await deleteJson(`${BASE()}/profiles/${encodeURIComponent(profileId)}`, { headers: auth(), timeoutMs: 15_000 });
    return { ok: true, gone: false };
  } catch (e) {
    if (e.status === 404) return { ok: true, gone: true };
    throw new ZernioError(e.message, { step: 'profile delete', code: e.code, status: e.status });
  }
}
