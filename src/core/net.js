import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

// The only door to the network.
//
// HARD RULE 1: the engine never likes, follows, comments, DMs, or reads other
// accounts by logging in, on any platform. The cheapest way to make that true and
// keep it true is to give every request one door and write down, here, every
// place the door opens onto:
//
//   - WRITES (anything but GET) are allowed to exactly these endpoints: Claude's
//     messages and batches endpoints (and cancelling a batch of ours), Zernio's create-post endpoint and its
//     create-profile endpoint (an empty folder on our own Zernio team, one per
//     customer account, that the customer connects their own accounts into),
//     the Instagram account or Facebook Page the customer picked on our own page,
//     Meta's two publishing endpoints for an Instagram account (create a media container,
//     publish it), deleting a post of ours after a takedown notice (Meta's delete,
//     or Zernio's unpublish for a Facebook Page's post), disconnecting a
//     deleted customer's accounts and profile from our own Zernio team, and an empty
//     Web Push to the owner's own browser through the browsers' push services
//     (src/notify: it carries no words). Nothing else.
//   - READS from a social platform are allowed only through the official read
//     APIs listed below (YouTube Data API search/videos; Meta's Graph API for a
//     container's status, our own account and media, their insights, the
//     publishing quota and our own token). A social host is never fetched as a
//     web page, so nothing here can scrape a profile or a feed.
//   - READS from the open web (approved sources, feed discovery, image libraries)
//     are allowed for any https host that is not a social platform and is on the
//     public internet: the name is resolved first, refused when any of its
//     addresses is this machine, a private network, link-local (a cloud's
//     metadata service), CGNAT, unique-local or unspecified, in any spelling
//     (2130706433, 0x7f000001, [::ffff:127.0.0.1]), and the request is then made
//     to the address that was checked and no other, so a second DNS answer cannot
//     turn it to one (src/core/net.js publicAddresses, pinned). On every hop.
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
  { method: 'POST', host: 'api.anthropic.com', path: /^\/v1\/messages\/batches\/[A-Za-z0-9_-]+\/cancel$/, why: 'Claude: cancelling a batch of ours that ran past its deadline, to ask its requests directly' },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/posts$/, why: 'Zernio: create a post on our own account' },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/profiles$/, why: "Zernio: a customer account's profile, the folder its TikTok and Instagram are connected into" },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/connect\/instagram\/select-account$/, why: 'Zernio (headless connect): the Instagram account the customer picked, when Instagram came back through Facebook Login' },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/connect\/facebook\/select-page$/, why: 'Zernio (headless connect): the Facebook Page the customer picked to post to' },
  { method: 'POST', host: 'zernio.com', path: /^\/api\/v1\/posts\/[A-Za-z0-9_-]+\/unpublish$/, why: "Zernio: taking our own Facebook post down from the customer's Page after a takedown notice" },
  { method: 'DELETE', host: 'zernio.com', path: /^\/api\/v1\/accounts\/[A-Za-z0-9_-]+$/, why: 'Zernio: disconnecting a TikTok, Instagram or Facebook Page from our own team, once its customer deleted their workspace' },
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
  { host: 'zernio.com', path: /^\/api\/v1\/connect\/(tiktok|instagram|facebook)$/, why: 'Zernio: the link a customer opens to connect their own TikTok, Instagram or Facebook Page' },
  { host: 'zernio.com', path: /^\/api\/v1\/connect\/instagram\/select-account$/, why: 'Zernio (headless connect): the Instagram accounts to pick from, when Instagram came back through Facebook Login' },
  { host: 'zernio.com', path: /^\/api\/v1\/connect\/facebook\/select-page$/, why: 'Zernio (headless connect): the Facebook Pages the customer manages, to pick the one to post to' },
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
  return { host, why: 'the open web: a source, a feed, an image library', open: true };
}

// ---- the open web is the public internet: no address of this machine or of a private network

const BLOCKED = new BlockList();
// IPv4: this network, private (10/8, 172.16/12, 192.168/16), CGNAT, loopback, link-local (169.254.169.254 is a
// cloud's metadata service), the IETF and documentation blocks, benchmarking, multicast and reserved. Node checks an
// IPv4-mapped IPv6 address ([::ffff:127.0.0.1]) against these too.
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
// IPv6: loopback and unspecified, NAT64 (an IPv4 address inside), discard, the IETF block (Teredo among it), 6to4,
// documentation, unique-local, link-local, site-local and multicast.
for (const [a, p] of [['::1', 128], ['::', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, p, 'ipv6');

/** The eight 16-bit groups of an IPv6 address, or null. */
function groups6(ip) {
  let s = ip.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) s = `${s.slice(0, v4.index)}${((+v4[1] << 8) | +v4[2]).toString(16)}:${((+v4[3] << 8) | +v4[4]).toString(16)}`;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail != null && tail !== '' ? tail.split(':') : [];
  const g = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return g.length === 8 ? g.map((x) => parseInt(x, 16)) : null;
}

/** Why this address is not on the public internet, or null when it is. */
export function blockedAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (!family) return 'not an IP address';
  if (BLOCKED.check(bare, family === 4 ? 'ipv4' : 'ipv6')) return 'not a public address';
  // An IPv4-compatible IPv6 address (::a.b.c.d, ::7f00:1) carries an IPv4 one: the first 96 bits are zero.
  if (family === 6 && groups6(bare)?.slice(0, 6).every((x) => x === 0)) return 'not a public address';
  return null;
}

// What resolves a name, and (for the tests alone) names that are let through to this machine and how a test
// server's certificate is taken: src/core/net.js __testNet. Production never changes them.
const policy = { lookup: (host) => dnsLookup(host, { all: true, verbatim: true }), exempt: () => false, tls: null };
const NATIVE_FETCH = globalThis.fetch;

/**
 * The addresses a host may be reached at, every one of them public, or a throw (code 'private_address'). A name with
 * one address that is not public is refused whole: a DNS answer that mixes them is how rebinding is tried.
 */
export async function publicAddresses(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  let addrs;
  if (literal) addrs = [{ address: host, family: literal }];
  else {
    try {
      addrs = await policy.lookup(host);
    } catch (e) {
      throw new NetError(`${host} did not resolve: ${e.code || e.message}`, { code: 'network' });
    }
  }
  if (!addrs?.length) throw new NetError(`${host} has no address`, { code: 'network' });
  if (policy.exempt(host)) return addrs;
  for (const a of addrs) {
    const why = blockedAddress(a.address);
    if (why) throw new NetError(`refused ${host} (${a.address}): ${why}; the engine reads the public internet only`, { code: 'private_address' });
  }
  return addrs;
}

// The connection goes to the address that was checked, never to a second lookup's: one undici Agent (Node's own fetch
// runs on undici) whose lookup answers from the pins set right before each request. A name with no pin fails.
let pinning = null;
const MAX_PINS = 1000;

async function pinned() {
  if (pinning) return pinning;
  // Node creates undici's global Agent on the first fetch; a data: URL makes it without the network.
  await NATIVE_FETCH('data:,');
  const Agent = globalThis[Symbol.for('undici.globalDispatcher.1')]?.constructor;
  if (typeof Agent !== 'function') throw new NetError('cannot pin the address a request goes to: this Node has no undici Agent', { code: 'refused' });
  const pins = new Map();
  const lookup = (hostname, opts, cb) => {
    const p = pins.get(String(hostname).toLowerCase());
    if (!p) return cb(Object.assign(new Error(`no checked address for ${hostname}`), { code: 'ENOTFOUND' }));
    if (opts?.all) return cb(null, p.map((a) => ({ address: a.address, family: a.family })));
    return cb(null, p[0].address, p[0].family);
  };
  pinning = { agent: new Agent({ connect: { lookup, ...(policy.tls || {}) } }), pins };
  return pinning;
}

/** The dispatcher for one open-web hop: the host resolved, every address public, and the connection pinned to them. */
async function openWebDispatcher(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const addrs = await publicAddresses(host);
  const p = await pinned();
  if (p.pins.size >= MAX_PINS && !p.pins.has(host)) p.pins.delete(p.pins.keys().next().value);
  p.pins.set(host, addrs);
  return p.agent;
}

/**
 * The tests' door to the resolver: `lookup(host)` returns [{ address, family }], `exempt(host)` lets a test server on
 * this machine through, `tls` is how its certificate is taken. Returns a function that puts everything back.
 */
export function __testNet({ lookup, exempt, tls } = {}) {
  const was = { ...policy };
  Object.assign(policy, { ...(lookup ? { lookup } : {}), ...(exempt ? { exempt } : {}), ...(tls ? { tls } : {}) });
  pinning?.agent.close().catch(() => {});
  pinning = null;
  return () => {
    Object.assign(policy, was);
    pinning?.agent.close().catch(() => {});
    pinning = null;
  };
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
    const rule = assertAllowed(method, url);
    // The open web, every hop: resolved, every address public, and the connection made to those addresses alone. (A
    // test that put its own fetch in place reaches no network, and is left to it.)
    const dispatcher = rule.open && globalThis.fetch === NATIVE_FETCH ? await openWebDispatcher(url) : undefined;
    let res;
    try {
      res = await fetch(url, {
        ...init,
        method,
        headers,
        redirect: 'manual',
        signal: init.signal || AbortSignal.timeout(timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
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
