import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HOUR, monthKey, now, nowIso } from '../core/clock.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { saveSetup, setupOf } from '../onboarding/setup.js';
import { CONNECT_PLATFORMS, connectUrl, createProfile, profileConnections, profileSpend, teamAccountIds, zernioConfigured } from './zernio.js';
import { instagramConfigured } from './instagram.js';
import { addPackPlatform } from '../packs/write.js';

// A customer connects their own TikTok, Instagram and Facebook Page to Teder through Zernio:
//
//   - each account has its own Zernio profile (accounts.zernio_profile_id), made the first time someone asks to
//     connect, its externalId the pack id. Profiles cost nothing; each connected account does.
//   - "connect" asks Zernio for a fresh link at that moment (it works for 30 minutes), and the browser goes there:
//     Zernio's welcome screen, the platform's consent screen, then back to /connect/<account>/<platform>/done.
//   - what is connected is read from Zernio, never from the address the browser came back on: after a connect, and
//     once an hour, the profile's accounts and their health (zernio_connections). An expired or revoked token is
//     status "reconnect"; the same button connects the same account again and it keeps its history.
//   - a Facebook Page comes back for a pick, always: Zernio posts to a Page the customer manages, never to a person's
//     profile, and the Page is chosen on our own page (src/web/connect.js), as an Instagram that came back through
//     Facebook Login is. Facebook is the one platform an account may leave unconnected without anything waiting on it
//     (src/core/platforms.js OPTIONAL_PLATFORMS).
//   - Instagram is connected through Zernio only when it is not already through our own Meta app
//     (src/publish/instagram.js): that one is free, and an account connected twice would be billed for nothing.
//   - the WhatsApp assistant hands the customer a link to Teder, not to Zernio (a Zernio link would be dead within the
//     half hour): /connect/<account>/<platform>?e=&s=, signed with OF_ASSISTANT_SECRET, open for 72 hours, for that
//     account and platform only. Whoever holds it can connect an account there until it expires; the account page
//     shows which @user is connected, so a wrong one is plain to see.
//
// pack.json's zernio.profileId and zernio.accounts, typed in by hand before this, are read when there is no row and
// copied in the first time the account is checked.
//
// BEFORE THE ACCOUNT EXISTS. A new account's owner may connect while its sources are still searched (src/web/onboarding.js):
// the profile is then the onboarding's (externalId the onboarding id, kept in its setup_json, src/onboarding/setup.js),
// what is connected into it is read from Zernio the same way and kept there too, and when the account is created it
// takes the profile over with its connections (carryOnboardingZernio): nothing is connected twice. Zernio's profile
// keeps the onboarding's name and externalId; Teder finds it by the id it keeps, never by the externalId.

export const CONNECT_LINK_TTL_S = 72 * 3600;
/** How long the return address handed to Zernio is good for: the connect itself, with room for a slow consent screen. */
export const DONE_TTL_S = 2 * 3600;
/** How often the runner reads each profile's connections. */
export const CHECK_EVERY_MS = HOUR;
/** And what Zernio billed. */
export const COSTS_EVERY_MS = 24 * HOUR;

/* ------------------------------------------------------------------ the profile */

/** The account's Zernio profile id, or null. */
export function profileIdOf(db, pack) {
  return db.get('SELECT zernio_profile_id AS id FROM accounts WHERE id = ?', pack.id)?.id || String(pack.meta.zernio?.profileId || '').trim() || null;
}

/** The account's profile, made if it has none. Throws a ZernioError when Zernio cannot be reached or refuses. */
export async function ensureProfile(db, pack, { actor = 'engine' } = {}) {
  const have = profileIdOf(db, pack);
  if (!db.get('SELECT id FROM accounts WHERE id = ?', pack.id)) throw new Error(`no account row for ${pack.id}`);
  if (have) {
    if (!db.get('SELECT zernio_profile_id AS id FROM accounts WHERE id = ?', pack.id)?.id) db.update('accounts', pack.id, { zernio_profile_id: have, updated_at: nowIso() });
    return have;
  }
  // Profile names are unique on the team: the pack id after the name keeps two "Cafe" accounts apart.
  const p = await createProfile({ name: `${pack.meta.displayName} · ${pack.id}`, externalId: pack.id });
  db.update('accounts', pack.id, { zernio_profile_id: p.id, updated_at: nowIso() });
  audit(db, { actor, action: 'zernio_profile', accountId: pack.id, detail: { profile: p.id } });
  return p.id;
}

/* ------------------------------------------------------------------ what is connected */

/**
 * The account's Zernio account on a platform: { id, username, status, issue, checkedAt, from } or null. `from` says
 * where it was read: 'zernio' (checked) or 'pack' (pack.json, not checked yet).
 */
export function connectionOf(db, pack, platform) {
  const r = db.get('SELECT * FROM zernio_connections WHERE account_id = ? AND platform = ?', pack.id, platform);
  if (r) return { id: r.zernio_account_id, username: r.username || '', status: r.status, issue: r.issue, checkedAt: r.checked_at, brokenAt: r.broken_at, from: 'zernio' };
  const id = String(pack.meta.zernio?.accounts?.[platform] || '').trim();
  return id ? { id, username: '', status: 'connected', issue: null, checkedAt: null, brokenAt: null, from: 'pack' } : null;
}

/**
 * The issue of an account that is no longer on Zernio at all (disconnected there, or removed): it needs connecting
 * again, as a new account, since there is nothing left to reconnect.
 */
export const GONE = 'not connected on Zernio any more';

/**
 * The Zernio account id a post on this platform goes to, or null. One that needs reconnecting is still tried (Zernio's
 * health can be wrong, and a refusal is handled like any other); one that is gone from Zernio is not.
 */
export function zernioAccountId(db, pack, platform) {
  const c = connectionOf(db, pack, platform);
  return c && c.issue !== GONE ? c.id : null;
}

/** Instagram through Zernio is offered only where our own Meta app does not already publish it. */
export const instagramViaMeta = (db, pack, env = process.env) => instagramConfigured(db, pack, env);

/** The platforms a customer can connect through Zernio on this account. */
export const connectablePlatforms = (db, pack, env = process.env) => CONNECT_PLATFORMS.filter((p) => pack.meta.platforms.includes(p) && !(p === 'instagram' && instagramViaMeta(db, pack, env)));

/**
 * One platform as the account page and the assistant show it: { platform, state, username, issue, checkedAt }.
 * state: connected | reconnect | none | meta (Instagram, through our own Meta app: nothing to connect here).
 */
export function connectState(db, pack, platform, env = process.env) {
  if (platform === 'instagram' && instagramViaMeta(db, pack, env)) return { platform, state: 'meta', username: pack.meta.instagram?.username || '', issue: null, checkedAt: null };
  const c = connectionOf(db, pack, platform);
  return { platform, state: c ? c.status : 'none', username: c?.username || '', issue: c?.issue || null, checkedAt: c?.checkedAt || null };
}

/**
 * Read the profile's accounts from Zernio and keep them. `prefer` ({ platform: zernioAccountId }) is the account Zernio
 * named on the return from a connect: it wins if, and only if, it is in the profile. Otherwise the account already
 * kept stays, else the first connected one (Zernio lists the newest first). Returns what changed:
 * [{ platform, from, to, username }].
 *
 * An account that was connected (or typed into pack.json) and is on Zernio no more is "reconnect" with issue GONE: the
 * break is recorded once, the customer is told, and posts stop going to an id Zernio refuses. A hand-typed account
 * that lives in another profile of the team (Default, say) is not gone, and is kept.
 */
export async function refreshConnections(db, pack, { t = now(), prefer = {} } = {}) {
  const profileId = profileIdOf(db, pack);
  if (!profileId) return [];
  const list = await profileConnections(profileId);
  const at = new Date(t).toISOString();
  const changes = [];
  let team = null;
  for (const platform of CONNECT_PLATFORMS) {
    const mine = list.filter((a) => a.platform === platform);
    const had = connectionOf(db, pack, platform);
    const pick = mine.find((a) => a.id === prefer[platform]) || mine.find((a) => a.id === had?.id) || mine.find((a) => a.status === 'connected') || mine[0] || null;
    const row = db.get('SELECT * FROM zernio_connections WHERE account_id = ? AND platform = ?', pack.id, platform);
    if (!pick) {
      if (!had) continue;
      if (row?.issue === GONE) {
        db.run('UPDATE zernio_connections SET checked_at = ? WHERE account_id = ? AND platform = ?', at, pack.id, platform);
        continue;
      }
      if (had.from === 'pack') {
        team ??= await teamAccountIds();
        if (team.has(had.id)) continue; // in another profile of ours: still there
      }
      if (row) db.run('UPDATE zernio_connections SET status = ?, issue = ?, checked_at = ?, broken_at = ? WHERE account_id = ? AND platform = ?', 'reconnect', GONE, at, at, pack.id, platform);
      else db.insert('zernio_connections', { account_id: pack.id, platform, zernio_account_id: had.id, username: '', status: 'reconnect', issue: GONE, checked_at: at, broken_at: at, connected_at: at });
      changes.push({ platform, from: had.status, to: 'reconnect', username: had.username || '' });
      continue;
    }
    const broke = pick.status === 'reconnect' && row?.status !== 'reconnect';
    const next = { zernio_account_id: pick.id, username: pick.username, status: pick.status, issue: pick.issue, checked_at: at, broken_at: broke ? at : pick.status === 'reconnect' ? row?.broken_at || at : null };
    if (row) db.run('UPDATE zernio_connections SET zernio_account_id = ?, username = ?, status = ?, issue = ?, checked_at = ?, broken_at = ?, connected_at = ? WHERE account_id = ? AND platform = ?', next.zernio_account_id, next.username, next.status, next.issue, next.checked_at, next.broken_at, row.zernio_account_id === pick.id ? row.connected_at : at, pack.id, platform);
    else db.insert('zernio_connections', { account_id: pack.id, platform, ...next, connected_at: at });
    const from = row ? row.status : had?.from === 'pack' && had.id === pick.id ? 'connected' : 'none';
    if (from !== pick.status || (row && row.zernio_account_id !== pick.id)) changes.push({ platform, from, to: pick.status, username: pick.username });
    // A second account of the platform in the profile is billed by Zernio and used by nobody: the operator is told.
    const extra = mine.filter((a) => a.id !== pick.id).map((a) => a.id);
    if (extra.length) audit(db, { action: 'zernio_extra_account', accountId: pack.id, detail: { platform, kept: pick.id, extra } });
  }
  if (changes.length) audit(db, { action: 'zernio_connections', accountId: pack.id, detail: { changes } });
  return changes;
}

/**
 * Zernio's link for one platform, fresh: the profile made first if there is none. A platform that needs reconnecting
 * reconnects the same account (its history kept); otherwise whatever account the customer logs into is connected.
 * `doneUrl` is where Zernio sends the browser back.
 */
export async function startConnect(db, pack, platform, { doneUrl, actor = 'engine', env = process.env }) {
  if (!connectablePlatforms(db, pack, env).includes(platform)) throw Object.assign(new Error(platform === 'instagram' && instagramViaMeta(db, pack, env) ? 'Instagram is connected through our own Meta app' : `${platform} is not one of this account's platforms`), { code: 'not_connectable' });
  const profileId = await ensureProfile(db, pack, { actor });
  const c = connectionOf(db, pack, platform);
  // An account gone from Zernio has nothing left to reconnect: whatever the customer logs into is connected as new.
  const url = await connectUrl(platform, { profileId, redirectUrl: doneUrl, reconnectAccountId: c?.status === 'reconnect' && c.from === 'zernio' && c.issue !== GONE ? c.id : null });
  audit(db, { actor, action: 'zernio_connect', accountId: pack.id, detail: { platform, reconnect: c?.status === 'reconnect' } });
  return url;
}

/* ------------------------------------------------------------------ before the account exists: the onboarding's profile */

/** The pick refreshConnections makes, from a profile's list: the one Zernio named, else the one kept, else the first connected. */
const pickOf = (mine, prefer, had) => mine.find((a) => a.id === prefer) || mine.find((a) => a.id === had?.id) || mine.find((a) => a.status === 'connected') || mine[0] || null;

/** An onboarding's connections as connectState gives them: [{ platform, state, username, issue, checkedAt }]. */
export function onboardingStates(db, onboardingId) {
  const z = setupOf(db, onboardingId).zernio || {};
  return CONNECT_PLATFORMS.map((platform) => {
    const c = z.connections?.[platform];
    return { platform, state: c ? c.status : 'none', username: c?.username || '', issue: c?.issue || null, checkedAt: c?.checkedAt || null };
  });
}

/**
 * Zernio's link to connect one platform for an onboarding: its profile made first if there is none. `name` names the
 * profile on Zernio (the account's name, else its niche).
 */
export async function startOnboardingConnect(db, onboardingId, platform, { doneUrl, name, actor = 'engine' }) {
  if (!CONNECT_PLATFORMS.includes(platform)) throw Object.assign(new Error(`${platform} is not a platform to connect`), { code: 'not_connectable' });
  let z = setupOf(db, onboardingId).zernio || {};
  if (!z.profileId) {
    const p = await createProfile({ name: `${name || onboardingId} · ${onboardingId}`, externalId: onboardingId });
    z = saveSetup(db, onboardingId, { zernio: { ...z, profileId: p.id, connections: z.connections || {} } }).zernio;
    audit(db, { actor, action: 'zernio_profile', detail: { onboarding: onboardingId, profile: p.id } });
  }
  const c = z.connections?.[platform];
  const url = await connectUrl(platform, { profileId: z.profileId, redirectUrl: doneUrl, reconnectAccountId: c?.status === 'reconnect' && c.issue !== GONE ? c.id : null });
  audit(db, { actor, action: 'zernio_connect', detail: { onboarding: onboardingId, platform, reconnect: c?.status === 'reconnect' } });
  return url;
}

/**
 * Read the onboarding's profile from Zernio and keep what is connected, as refreshConnections does for an account.
 * Returns the connections kept.
 */
export async function refreshOnboardingConnections(db, onboardingId, { t = now(), prefer = {} } = {}) {
  const z = setupOf(db, onboardingId).zernio || {};
  if (!z.profileId) return {};
  const list = await profileConnections(z.profileId);
  const at = new Date(t).toISOString();
  const next = {};
  for (const platform of CONNECT_PLATFORMS) {
    const had = z.connections?.[platform] || null;
    const pick = pickOf(list.filter((a) => a.platform === platform), prefer[platform], had);
    if (pick) next[platform] = { id: pick.id, username: pick.username, status: pick.status, issue: pick.issue, checkedAt: at, connectedAt: had?.id === pick.id ? had.connectedAt || at : at };
    else if (had) next[platform] = { ...had, status: 'reconnect', issue: GONE, checkedAt: at };
  }
  // The newest setup: the customer may have saved something else while Zernio answered.
  saveSetup(db, onboardingId, { zernio: { ...(setupOf(db, onboardingId).zernio || {}), connections: next } });
  return next;
}

/**
 * The new account takes the onboarding's profile over, with what was connected into it: accounts.zernio_profile_id and a
 * zernio_connections row per platform, as if it had been connected from the account page. An account with a profile
 * of its own keeps it. Returns the platforms carried.
 */
export function carryOnboardingZernio(db, onboardingId, accountId, { actor = 'engine' } = {}) {
  const z = setupOf(db, onboardingId).zernio || {};
  if (!z.profileId) return [];
  const acc = db.get('SELECT zernio_profile_id AS id FROM accounts WHERE id = ?', accountId);
  if (!acc || (acc.id && acc.id !== z.profileId)) return [];
  const carried = [];
  db.tx(() => {
    db.update('accounts', accountId, { zernio_profile_id: z.profileId, updated_at: nowIso() });
    for (const [platform, c] of Object.entries(z.connections || {})) {
      if (!CONNECT_PLATFORMS.includes(platform) || !c?.id) continue;
      if (db.get('SELECT 1 AS x FROM zernio_connections WHERE account_id = ? AND platform = ?', accountId, platform)) continue;
      const at = c.checkedAt || nowIso();
      db.insert('zernio_connections', { account_id: accountId, platform, zernio_account_id: c.id, username: c.username || '', status: c.status === 'reconnect' ? 'reconnect' : 'connected', issue: c.issue || null, checked_at: at, broken_at: c.status === 'reconnect' ? at : null, connected_at: c.connectedAt || at });
      carried.push(platform);
    }
  });
  audit(db, { actor, action: 'zernio_profile', accountId, detail: { profile: z.profileId, from: onboardingId, connections: carried } });
  return carried;
}

/* ------------------------------------------------------------------ headless: a pick on our own page */

/** How long a pick waits for the customer's tap. */
export const PICK_TTL_MS = 15 * 60_000;

/**
 * A headless return that still needs an account picked (Instagram through Facebook Login: step=select_account; a
 * Facebook Page: step=select_page), as { step, profileId, tempToken, connectToken, userProfile }, else null. userProfile
 * is JSON encoded twice on the wire: the query string is decoded once already, so it is decoded once more and parsed.
 * A Page's pick sends it back to Zernio; an Instagram pick only shows whose sign-in it was.
 */
export function selectionOf(query) {
  const at = query.get('step');
  if (!['select_account', 'select_page'].includes(at) || !query.get('tempToken')) return null;
  let userProfile = null;
  try {
    userProfile = JSON.parse(decodeURIComponent(query.get('userProfile') || ''));
  } catch {
    /* Zernio is sent what it gave, or nothing */
  }
  return { step: at, profileId: query.get('profileId') || null, tempToken: query.get('tempToken'), connectToken: query.get('connect_token') || null, userProfile };
}

/**
 * Keep a pick on the server while the customer chooses: the token Zernio returned never goes back to the browser. The
 * page's links carry only a random id, good once and for PICK_TTL_MS. Returns the id.
 */
export function holdPick(db, pick, { t = now() } = {}) {
  const id = randomBytes(16).toString('hex');
  setSetting(db, `zernio:pick:${id}`, { ...pick, exp: t + PICK_TTL_MS });
  return id;
}

/** The pick an id names, taken (once: it is removed), or null when there is none or it expired. */
export function takePick(db, id, { t = now() } = {}) {
  if (!/^[0-9a-f]{32}$/.test(String(id || ''))) return null;
  const key = `zernio:pick:${id}`;
  const pick = getSetting(db, key, null);
  if (!pick) return null;
  db.run('DELETE FROM settings WHERE key = ?', key);
  return pick.exp >= t ? pick : null;
}

/* ------------------------------------------------------------------ signed links */

const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');
const sigOf = (secret, kind, { accountId, platform, exp }) => hmac(secret, [kind, accountId, platform, exp].join('\n'));
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const signed = (secret, kind, { base, accountId, platform, t, ttlS, suffix = '' }) => {
  const exp = Math.floor(t / 1000) + ttlS;
  return `${base}/connect/${encodeURIComponent(accountId)}/${platform}${suffix}?e=${exp}&s=${sigOf(secret, kind, { accountId, platform, exp })}`;
};
const signedOk = (secret, kind, { accountId, platform, e, s, t }) => {
  if (!secret || !/^\d{1,12}$/.test(String(e || '')) || !/^[0-9a-f]{64}$/.test(String(s || ''))) return false;
  if (Number(e) < Math.floor(t / 1000)) return false;
  return same(sigOf(secret, kind, { accountId, platform, exp: Number(e) }), s);
};

/** The link the assistant sends: open it, and Teder asks Zernio for a fresh connect link. */
export const connectLink = (secret, { base, accountId, platform, t = now(), ttlS = CONNECT_LINK_TTL_S }) => signed(secret, 'zernio-connect', { base, accountId, platform, t, ttlS });
export const connectLinkOk = (secret, { accountId, platform, e, s, t = now() }) => signedOk(secret, 'zernio-connect', { accountId, platform, e, s, t });

/** Where Zernio sends the browser back after a connect made for an onboarding, before its account exists. */
export const onboardingDoneLink = (secret, { base, onboardingId, platform, t = now(), ttlS = DONE_TTL_S }) => {
  const exp = Math.floor(t / 1000) + ttlS;
  return `${base}/new/${encodeURIComponent(onboardingId)}/connect/${platform}/done?e=${exp}&s=${sigOf(secret, 'onboarding-connect-done', { accountId: onboardingId, platform, exp })}`;
};
export const onboardingDoneLinkOk = (secret, { onboardingId, platform, e, s, t = now() }) => signedOk(secret, 'onboarding-connect-done', { accountId: onboardingId, platform, e, s, t });

/** Where Zernio sends the browser back after a connect. */
export const doneLink = (secret, { base, accountId, platform, t = now(), ttlS = DONE_TTL_S }) => signed(secret, 'zernio-connect-done', { base, accountId, platform, t, ttlS, suffix: '/done' });
export const doneLinkOk = (secret, { accountId, platform, e, s, t = now() }) => signedOk(secret, 'zernio-connect-done', { accountId, platform, e, s, t });

/* ------------------------------------------------------------------ what Zernio billed */

/** What Zernio billed for an account's profile in a month, as last read, or null when it was never read. */
export function zernioCost(db, accountId, month) {
  const r = db.get('SELECT usd, read_at FROM zernio_costs WHERE account_id = ? AND month = ?', accountId, month);
  return r ? { usd: r.usd, readAt: r.read_at } : null;
}

/**
 * Read Zernio's split of this month's bill and keep each account's share. Zernio splits it per profile, pro-rated
 * against the invoice, so the shares add up to what is billed (less what no profile can claim). A plan without a
 * usage-based invoice (legacy Stripe) has nothing to split: { supported: false }, and nothing is written.
 */
export async function recordCosts(ctx, { t = now() } = {}) {
  const { db } = ctx;
  const month = monthKey(t);
  const spend = await profileSpend({ from: `${month}-01`, to: new Date(t).toISOString().slice(0, 10) });
  if (!spend.supported) return { supported: false, month, accounts: 0 };
  let n = 0;
  for (const pack of ctx.packs) {
    const profileId = profileIdOf(db, pack);
    if (!profileId) continue;
    const usd = spend.byProfile[profileId] ?? 0;
    db.run('INSERT INTO zernio_costs (account_id, month, profile_id, usd, read_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, month) DO UPDATE SET profile_id = excluded.profile_id, usd = excluded.usd, read_at = excluded.read_at', pack.id, month, profileId, usd, new Date(t).toISOString());
    n++;
  }
  return { supported: true, month, accounts: n, total: spend.total };
}

/* ------------------------------------------------------------------ Facebook, for the accounts made before it */

/**
 * Facebook joins the platforms of every account a customer made in the new-account flow before Facebook existed (an
 * account in a workspace, made from an onboarding), so its owner can connect a Page from the account page. Once per
 * account (a setting remembers it), so a platform taken out of pack.json by hand stays out. The operator's own
 * accounts, written by hand and in no workspace, are left as they are. New accounts have it from the start
 * (src/onboarding/pack.js). Returns the ids of the accounts it was added to.
 */
export function offerFacebook(ctx, { actor = 'engine' } = {}) {
  const { db } = ctx;
  const added = [];
  for (const pack of ctx.packs) {
    const key = `facebook:offered:${pack.id}`;
    if (getSetting(db, key, null)) continue;
    const customer = db.get('SELECT workspace_id AS ws FROM accounts WHERE id = ?', pack.id)?.ws != null && db.get('SELECT 1 AS x FROM onboarding WHERE pack_id = ? LIMIT 1', pack.id);
    if (!customer) continue;
    if (!pack.meta.platforms.includes('facebook')) {
      addPackPlatform(pack, 'facebook', 'zernio');
      audit(db, { actor, action: 'platform_added', accountId: pack.id, detail: { platform: 'facebook' } });
      added.push(pack.id);
    }
    setSetting(db, key, nowIso());
  }
  return added;
}

/* ------------------------------------------------------------------ the runner's pass */

/**
 * Once an hour per account with a profile: what is connected. Once a day: what Zernio billed. Returns what changed,
 * or null without a Zernio key.
 */
export async function zernioTick(ctx, { t = now() } = {}) {
  if (!zernioConfigured()) return null;
  const { db } = ctx;
  const out = { checked: 0, changes: [], errors: [] };
  for (const pack of ctx.packs) {
    if (!profileIdOf(db, pack)) continue;
    const key = `zernio:checked:${pack.id}`;
    const last = getSetting(db, key);
    if (last && t - Date.parse(last) < CHECK_EVERY_MS) continue;
    setSetting(db, key, new Date(t).toISOString());
    try {
      const changes = await refreshConnections(db, pack, { t });
      out.checked++;
      for (const c of changes) out.changes.push({ account: pack.id, ...c });
    } catch (e) {
      out.errors.push({ account: pack.id, step: 'zernio connections', error: e.message });
    }
  }
  const last = getSetting(db, 'zernio:costs:last');
  if (!last || t - Date.parse(last) >= COSTS_EVERY_MS) {
    setSetting(db, 'zernio:costs:last', new Date(t).toISOString());
    try {
      out.costs = await recordCosts(ctx, { t });
    } catch (e) {
      out.errors.push({ step: 'zernio costs', error: e.message });
    }
  }
  return out;
}
