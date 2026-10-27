// The only door to the network.
//
// HARD RULE 1: the engine never likes, follows, comments, DMs, or reads other
// accounts by logging in, on any platform. The cheapest way to make that true and
// keep it true is to give every request one door and write down, here, every
// place the door opens onto:
//
//   - WRITES (anything but GET) are allowed to exactly these endpoints: Claude's
//     messages and batches endpoints, Zernio's create-post endpoint and its
//     create-profile endpoint (an empty folder on our own Zernio team, one per
//     customer account, that the customer connects their own accounts into),
//     Meta's two publishing endpoints for an Instagram account (create a media container,
//     publish it), deleting a post of ours after a takedown notice, disconnecting a
//     deleted customer's accounts and profile from our own Zernio team, and an empty
//     Web Push to the owner's own browser through the browsers' push services
//     (src/notify: it carries no words). Nothing else.
//   - READS from a social platform are allowed only through the official read
//     APIs listed below (YouTube Data API search/videos; Meta's Graph API for a
//     container's status, our own account and media, their insights, the
//     publishing quota and our own token). A social host is never fetched as a
//     web page, so nothing here can scrape a profile or a feed.
//   - READS from the open web (approved sources, feed discovery, image libraries)
//     are allowed for any https host that is not a social platform.
//   - A service on this machine (openfrequency-toran, the WhatsApp assistant) is
//     reached through localFetch, which refuses every host but the loopback. The
//     assistant talks to the customer; Teder never reaches WhatsApp itself.
//   - Zernio paths that touch an inbox, messages, comments, likes or follows are
//     refused by name, even as reads. So is any Graph request that asks for
//     comments, mentions, tags, hashtags, messages or another account
//     (business_discovery), in its path or in its fields.
//
// The test suite refuses any `fetch(` outside this file, and any rule that
// would let a write reach a social host. The Anthropic SDK is handed doorFetch
// as its fetch, so its requests pass through the same rules.

export const SOCIAL = [
  'tiktok.com', 'tiktokv.com', 'instagram.com', 'facebook.com', 'fb.com', 'threads.net', 'youtube.com',
  'x.com', 'twitter.com', 'whatsapp.com', 'wa.me', 'linkedin.com', 'telegram.org', 't.me', 'reddit.com',
  'snapchat.com', 'pinterest.com', 'discord.com',
];

const onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
export const isSocial = (host) => SOCIAL.some((d) => onHost(String(host).toLowerCase(), d));

// Zernio is a publishing gateway, and it also has an inbox. Only these paths.
const ZERNIO_FORBIDDEN = /inbox|message|comment|conversation|reply|repl(y|ies)|like|follow|dm\b|direct/i;

// Meta's Graph API also reaches comments, DMs, mentions, hashtags and other
// accounts. None of it, by name: not as an edge in the path, not as a field
// expansion. Counts on our own posts (like_count, the "comments" insight metric)
// are numbers, not the comments, and stay readable.
const GRAPH = new Set(['graph.facebook.com', 'graph.instagram.com']);
const GRAPH_EDGE = /^(comments|replies|mentions|mentioned_media|mentioned_comment|tags|conversations|messages|likes|subscribed_apps|live_media|stories|ig_hashtag_search|recently_searched_hashtags|top_media|recent_media|business_discovery|private_replies)$/i;
const V = String.raw`\/v\d+\.\d+`;

/** What a Graph request asks for that the engine never reads, or null. */
export function graphRefusal(u) {
  for (const seg of u.pathname.split('/')) if (GRAPH_EDGE.test(seg)) return seg;
  for (const f of (u.searchParams.get('fields') || '').split(/[,{}().\s]/)) if (GRAPH_EDGE.test(f.trim())) return f.trim();
  if (/business_discovery|mentioned_/i.test(decodeURIComponent(u.search))) return 'another account';
  return null;
}

/** Every non-GET request the engine can make. Read top to bottom: that is all of it. */
export const WRITE_RULES = [
  { method: 'POST', host: 'api.anthropic.com', path: /^\/v1\/messages$/, why: 'Claude: drafting, review, scoring' },
  { method: 'POST', host: 'api.anthropic.com', path: /^\/v1\/messages\/batches$/, why: "Claude: the day's drafts as one batch, at half price" },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/posts$/, why: 'Zernio: create a post on our own account' },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/profiles$/, why: "Zernio: a customer account's profile, the folder its TikTok and Instagram are connected into" },
  { method: 'DELETE', host: 'zernio.com', path: /^\/api\/v1\/accounts\/[A-Za-z0-9_-]+$/, why: 'Zernio: disconnecting a TikTok or Instagram from our own team, once its customer deleted their workspace' },
  { method: 'DELETE', host: 'zernio.com', path: /^\/api\/v1\/profiles\/[A-Za-z0-9_-]+$/, why: "Zernio: removing a deleted customer's emptied profile from our own team" },
  { method: 'POST', host: 'graph.facebook.com', path: new RegExp(`^${V}\\/\\d+\\/(media|media_publish)$`), why: 'Instagram (Facebook Login): a media container on our own account, and publishing it' },
  { method: 'POST', host: 'graph.instagram.com', path: new RegExp(`^${V}\\/\\d+\\/(media|media_publish)$`), why: 'Instagram (Instagram Login): a media container on our own account, and publishing it' },
  { method: 'DELETE', host: 'graph.facebook.com', path: new RegExp(`^${V}\\/\\d+$`), why: 'Instagram (Facebook Login): deleting our own post after a takedown notice' },
  // An empty Web Push to the owner's browser: the push service the browser itself named, at its push path.
  { method: 'POST', host: 'fcm.googleapis.com', path: /^\/(fcm\/send|wp)\/[A-Za-z0-9_:.-]+$/, why: "Web Push (Chrome): wake the owner's browser" },
  { method: 'POST', host: 'updates.push.services.mozilla.com', path: /^\/wpush\/v[12]\/[A-Za-z0-9_=-]+$/, why: "Web Push (Firefox): wake the owner's browser" },
  { method: 'POST', host: 'web.push.apple.com', path: /^\/[A-Za-z0-9_=-]+$/, why: "Web Push (Safari): wake the owner's browser" },
  { method: 'POST', host: 'notify.windows.com', sub: true, path: /^\/w\/$/, why: "Web Push (Edge): wake the owner's browser" },
];

/** Reads that are allowed even though the host is special. */
export const READ_RULES = [
  { host: 'www.googleapis.com', path: /^\/youtube\/v3\/(search|videos)$/, why: 'YouTube Data API: Shorts and their public counts, read only' },
  { host: 'zernio.com', path: /^\/api\/v1\/(posts\/[A-Za-z0-9_-]+|accounts|accounts\/health|analytics|profiles)$/, why: 'Zernio: our own posts, profiles, connected accounts and their health, and analytics' },
  { host: 'zernio.com', path: /^\/api\/v1\/connect\/(tiktok|instagram)$/, why: 'Zernio: the link a customer opens to connect their own TikTok or Instagram' },
  { host: 'zernio.com', path: /^\/api\/v1\/usage$/, why: "Zernio: what it bills, split per customer's profile" },
  { host: 'zernio.com', path: /^\/api\/v1\/accounts\/[A-Za-z0-9_-]+\/tiktok\/commercial-music$/, why: "Zernio: TikTok's trending Commercial Music Library chart, for a post's sound" },
  { host: 'i.ytimg.com', why: 'YouTube thumbnails' },
  // A token reads only what it was granted: our own account, our own media.
  { host: 'graph.facebook.com', path: new RegExp(`^${V}\\/(\\d+|\\d+\\/(insights|content_publishing_limit|media)|me|me\\/accounts|debug_token|oauth\\/access_token)$`), why: 'Instagram (Facebook Login): our account, our media and their insights, the quota, our token' },
  { host: 'graph.instagram.com', path: new RegExp(`^(${V})?\\/(\\d+|\\d+\\/(insights|content_publishing_limit|media)|me|refresh_access_token|access_token)$`), why: 'Instagram (Instagram Login): our account, our media and their insights, the quota, refreshing our token' },
];

export class NetError extends Error {
  constructor(message, { status = null, code = 'network' } = {}) {
    super(message);
    this.name = 'NetError';
    this.status = status;
    this.code = code;
  }
}

/** The rule that allows this request, or a throw. Pure, so the tests can read it. */
export function assertAllowed(method, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NetError(`not a URL: ${url}`, { code: 'refused' });
  }
  const m = String(method || 'GET').toUpperCase();
  if (u.protocol !== 'https:') throw new NetError(`refused ${m} ${u.protocol}//${u.hostname}: https only`, { code: 'refused' });
  const host = u.hostname.toLowerCase();

  if (onHost(host, 'zernio.com') && ZERNIO_FORBIDDEN.test(u.pathname)) {
    throw new NetError(`refused ${m} ${host}${u.pathname}: the engine never touches an inbox, comments or messages`, { code: 'refused' });
  }
  const asked = GRAPH.has(host) ? graphRefusal(u) : null;
  if (asked) throw new NetError(`refused ${m} ${host}${u.pathname} (${asked}): the engine never reads comments, mentions, messages, hashtags or other accounts`, { code: 'refused' });

  if (m !== 'GET' && m !== 'HEAD') {
    const rule = WRITE_RULES.find((r) => r.method === m && (r.host === host || (r.sub && host.endsWith(`.${r.host}`))) && r.path.test(u.pathname));
    if (!rule) throw new NetError(`refused ${m} ${host}${u.pathname}: not on the write allowlist`, { code: 'refused' });
    return rule;
  }

  const special = READ_RULES.find((r) => r.host === host && (!r.path || r.path.test(u.pathname)));
  if (special) return special;
  if (isSocial(host) || onHost(host, 'zernio.com')) {
    throw new NetError(`refused GET ${host}${u.pathname}: a social platform is read only through its official API`, { code: 'refused' });
  }
  return { host, why: 'the open web: a source, a feed, an image library' };
}

// Who is reading, for the sites that ask (Wikimedia, SEC): OF_USER_AGENT in .env,
// with a contact ("open-frequency/0.1 (+https://your.site; you@your.site)").
// The default names the engine and no one, so it never points at someone else's page.
export const userAgent = () => String(process.env.OF_USER_AGENT || '').trim() || 'open-frequency/0.1 (self-hosted social publishing engine)';

/**
 * fetch, through the rules. Redirects are followed by hand so every hop is
 * checked: a source that redirects onto a social host is refused at the hop.
 */
export async function doorFetch(input, init = {}) {
  const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
  const headers = new Headers(init.headers || (typeof input === 'object' ? input?.headers : undefined) || {});
  if (!headers.has('user-agent')) headers.set('user-agent', userAgent());
  const timeoutMs = init.timeoutMs ?? 30_000;

  let waited = 0;
  for (let hop = 0; hop < 6; hop++) {
    assertAllowed(method, url);
    let res;
    try {
      res = await fetch(url, {
        ...init,
        method,
        headers,
        redirect: 'manual',
        signal: init.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new NetError(e.name === 'TimeoutError' ? `timed out: ${url}` : `${e.message}: ${url}`, { code: 'network' });
    }
    // Too many requests: a site that says so is waited for (its Retry-After, at most a
    // minute), twice at most, and a read only: a write is never sent again blind.
    if (res.status === 429 && method === 'GET' && waited < 2) {
      const after = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Math.min(60, Number.isFinite(after) && after > 0 ? after : 5 * (waited + 1)) * 1000));
      waited++;
      hop--;
      continue;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && method === 'GET') {
      url = new URL(res.headers.get('location'), url).href;
      continue;
    }
    Object.defineProperty(res, 'finalUrl', { value: url });
    return res;
  }
  throw new NetError(`too many redirects: ${url}`, { code: 'redirects' });
}

/** The names of this machine: the only hosts localFetch reaches. */
export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * fetch, to a service on this machine only (openfrequency-toran, the WhatsApp assistant: src/assistant/events.js).
 * Plain http is fine on the loopback; anything that is not the loopback is refused, so this can never reach a social
 * host or the open web. No redirects are followed.
 */
export async function localFetch(url, init = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NetError(`not a URL: ${url}`, { code: 'refused' });
  }
  if (!['http:', 'https:'].includes(u.protocol) || !LOOPBACK.has(u.hostname.toLowerCase())) throw new NetError(`refused ${u.protocol}//${u.hostname}: only a service on this machine`, { code: 'refused' });
  try {
    return await fetch(u.href, { ...init, redirect: 'error', signal: init.signal || AbortSignal.timeout(init.timeoutMs ?? 10_000) });
  } catch (e) {
    throw new NetError(e.name === 'TimeoutError' ? `timed out: ${u.href}` : `${e.message}: ${u.href}`, { code: 'network' });
  }
}

/** A text body. `encoding` reads a file that is not UTF-8 (some government CSVs are windows-1255). */
export async function getText(url, { accept, timeoutMs, headers = {}, maxBytes = 5_000_000, encoding = null } = {}) {
  const res = await doorFetch(url, { headers: { accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...headers }, timeoutMs });
  if (!res.ok) throw new NetError(`HTTP ${res.status}: ${url}`, { status: res.status, code: 'http' });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new NetError(`too large (${len} bytes): ${url}`, { code: 'too_large' });
  const body = encoding ? new TextDecoder(encoding).decode(await res.arrayBuffer()) : await res.text();
  return { body, finalUrl: res.finalUrl || url, contentType: res.headers.get('content-type') || '' };
}

export async function getJson(url, { headers = {}, timeoutMs } = {}) {
  const res = await doorFetch(url, { headers: { accept: 'application/json', ...headers }, timeoutMs });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* the status says enough */
  }
  if (!res.ok) {
    const reason = body?.error?.message || (typeof body?.error === 'string' ? body.error : null) || body?.message || `HTTP ${res.status}`;
    throw Object.assign(new NetError(String(reason).slice(0, 300), { status: res.status, code: 'http' }), { body });
  }
  return body;
}

export async function postJson(url, payload, { headers = {}, timeoutMs } = {}) {
  const res = await doorFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(payload),
    timeoutMs,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* the status says enough */
  }
  if (!res.ok) {
    const err = body?.error && typeof body.error === 'object' ? body.error : body;
    throw Object.assign(new NetError(String(err?.message || (typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)).slice(0, 300), { status: res.status, code: err?.code || 'http' }), { body });
  }
  return body;
}

export async function getBytes(url, { maxBytes = 12_000_000, timeoutMs, headers = {} } = {}) {
  const res = await doorFetch(url, { headers, timeoutMs });
  if (!res.ok) throw new NetError(`HTTP ${res.status}: ${url}`, { status: res.status, code: 'http' });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(type)) throw new NetError(`not an image (${type}): ${url}`, { code: 'type' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new NetError(`too large (${buf.length} bytes): ${url}`, { code: 'too_large' });
  return { buf, type };
}

/** DELETE (an Instagram post a takedown notice named). Throws like postJson, with the body attached. */
export async function deleteJson(url, { headers = {}, timeoutMs } = {}) {
  const res = await doorFetch(url, { method: 'DELETE', headers: { accept: 'application/json', ...headers }, timeoutMs });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* the status says enough */
  }
  if (!res.ok || body?.error) {
    const err = body?.error && typeof body.error === 'object' ? body.error : body;
    throw Object.assign(new NetError(String(err?.message || `HTTP ${res.status}`).slice(0, 300), { status: res.status, code: err?.code ?? 'http' }), { body });
  }
  return body;
}

/** POST form-encoded parameters (Meta's Graph API takes them this way). Throws like postJson, with the body attached. */
export async function postForm(url, params, { headers = {}, timeoutMs } = {}) {
  const res = await doorFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: new URLSearchParams(params).toString(),
    timeoutMs,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* the status says enough */
  }
  if (!res.ok || body?.error) {
    const err = body?.error && typeof body.error === 'object' ? body.error : body;
    throw Object.assign(new NetError(String(err?.message || `HTTP ${res.status}`).slice(0, 300), { status: res.status, code: err?.code ?? 'http' }), { body });
  }
  return body;
}
