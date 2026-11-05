import { now, nowIso } from '../core/clock.js';
import { localFetch } from '../core/net.js';
import { getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';
import { domainOf, storeOrigin } from '../demos/store.js';
import { TORAN_INTERNAL } from '../notify/operator.js';

// The operator's leads (/leads, src/web/leads.js), copied from Toran once an hour (the runner, leadsTick).
//
// Toran finds stores and scores them for its own outreach; the same stores are Teder's leads. Teder asks Toran on this
// machine for every store changed since the last time:
//
//   GET {OF_TORAN_INTERNAL}/internal/stores?since=<ISO>&limit=500, Authorization: Bearer OF_INTERNAL_TOKEN
//   { stores: [{ id, domain, url, name, platform, about, score, toranStatus, contact: { email, whatsapp, phone },
//                social: { instagram, tiktok, facebook }, optedOut, updatedAt }], next: ISO | null }
//
// and asks again with since=next until next is null (test/fixtures/toran-stores.json is the contract's example).
// since is "changed after", and Toran's moments are to the microsecond: next and the hour's cursor (leads:cursor, the
// latest updatedAt seen) are handed back exactly as Toran wrote them.
// OF_TORAN_INTERNAL is the same setting the operator's alerts use (src/notify/operator.js): empty is
// http://127.0.0.1:4710, off is none. Without OF_INTERNAL_TOKEN, or with off, nothing is asked and /leads says so.
// Only a service on this machine is ever asked (localFetch).
//
// Each store is a lead by its domain (www. left out):
//   - a new one is added, unless one of our customers' workspaces already has that site (workspaceDomains below), or
//     Toran says it asked not to be written to
//   - a known one takes what Toran says now, except that a contact, a profile or the line about the store (about:
//     its home page's description or title, in its own words) Toran no longer sends is kept: a value is replaced by
//     another, never by nothing
//   - optedOut sets opted_out_at, and the lead is hidden from then on, whatever Toran says later
// Everything Toran sends is checked before it is kept: a profile is an https address on its own network, a WhatsApp
// number international digits, a mail address one address. Anything else is left out.
//
// A failure (Toran down, a refusal, an answer that is not the contract's) is a log line and the setting leads:sync
// that /leads reads; nothing throws, and the next hour asks again from the same place.

export const STORES_PATH = '/internal/stores';
export const PAGE = 500;
export const SYNC_EVERY_MS = 3_600_000;
const MAX_PAGES = 40;
const TIMEOUT_MS = 10_000;
const MIN_TOKEN = 32;
const EPOCH = '1970-01-01T00:00:00.000Z';
const CURSOR = 'leads:cursor';
const LAST = 'leads:sync';

/** Where Toran's stores are asked for: { url } , or { why: 'off' | 'token' } when nothing may be asked. */
export function leadsSource(env = process.env) {
  const base = String(env.OF_TORAN_INTERNAL || '').trim();
  if (base.toLowerCase() === 'off') return { why: 'off' };
  if (String(env.OF_INTERNAL_TOKEN || '').trim().length < MIN_TOKEN) return { why: 'token' };
  return { url: `${(base || TORAN_INTERNAL).replace(/\/+$/, '')}${STORES_PATH}` };
}

/** A store's domain as Teder keeps it: lower case, no www., or null. */
export function domainKey(v) {
  const origin = storeOrigin(String(v ?? '').trim());
  return origin ? domainOf(origin) : null;
}

/**
 * The domains our customers' workspaces already have, so a store that is one of them is not offered Teder again: the
 * site a customer typed on /new (onboarding seed_json.site, kept for every onboarding in a workspace) and the address
 * the closing slide of an account in a workspace sends people to (pack.json promo.target.url, a site or one product,
 * always on the store's own domain). A workspace that gave neither has no domain here and is not filtered.
 */
export function workspaceDomains(ctx) {
  const out = new Set();
  const add = (v) => {
    const d = domainKey(v);
    if (d) out.add(d);
  };
  for (const r of ctx.db.all('SELECT seed_json FROM onboarding WHERE workspace_id IS NOT NULL')) add(j(r.seed_json, {})?.site);
  for (const r of ctx.db.all('SELECT id FROM accounts WHERE workspace_id IS NOT NULL')) {
    const pack = (ctx.packs || []).find((p) => p.id === r.id);
    add(pack?.meta?.promo?.target?.url);
  }
  return out;
}

const text = (v, max) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s ? s.slice(0, max) : null;
};
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

// A moment of Toran's as it sent it: Toran's are UTC to the microsecond ("2026-11-05T10:00:00.123456Z"), one more
// than a JavaScript Date holds, and its since is "changed after", so a cursor is handed back exactly as it came.
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const moment = (v) => (typeof v === 'string' && v.length <= 40 && MOMENT.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
/** A moment's place in time to the microsecond, to tell which of two is later. */
const momentKey = (v) => Date.parse(v) * 1000 + Number((MOMENT.exec(v)?.[1] || '').padEnd(6, '0').slice(3, 6));
const whatsappOf = (v) => {
  const d = String(v ?? '').replace(/[\s+()-]/g, '');
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
};
const phoneOf = (v) => {
  const d = String(v ?? '').replace(/[\s()-]/g, '');
  return /^\+?\d{7,15}$/.test(d) ? d : null;
};
const emailOf = (v) => {
  const e = String(v ?? '').trim();
  return e.length <= 254 && /^[^\s@<>"'(),;:\\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(e) ? e : null;
};
const SOCIAL_HOST = { instagram: /^(www\.)?instagram\.com$/, tiktok: /^(www\.|m\.)?tiktok\.com$/, facebook: /^(www\.|m\.|business\.)?facebook\.com$|^fb\.com$/ };
const socialOf = (net, v) => {
  try {
    const u = new URL(String(v ?? ''));
    return u.protocol === 'https:' && !u.username && !u.password && SOCIAL_HOST[net].test(u.hostname.toLowerCase()) && u.href.length <= 300 ? u.href : null;
  } catch {
    return null;
  }
};

/** One store of Toran's answer as a lead's columns, or null when it has no domain to go by. */
export function storeToLead(s) {
  if (!s || typeof s !== 'object') return null;
  const domain = domainKey(s.domain) || domainKey(s.url);
  if (!domain) return null;
  // The store's own address when Toran's is on its domain; else its homepage.
  const url = domainKey(s.url) === domain && /^https?:\/\//i.test(String(s.url)) ? String(s.url).slice(0, 500) : `https://${domain}`;
  const c = s.contact && typeof s.contact === 'object' ? s.contact : {};
  const so = s.social && typeof s.social === 'object' ? s.social : {};
  const score = Number(s.score);
  return {
    toran_id: s.id == null ? null : String(s.id).slice(0, 64),
    domain,
    url,
    name: text(s.name, 200),
    platform: text(s.platform, 40),
    about: text(s.about, 300),
    score: s.score != null && Number.isFinite(score) ? score : null,
    toran_status: text(s.toranStatus, 40),
    email: emailOf(c.email),
    whatsapp: whatsappOf(c.whatsapp),
    phone: phoneOf(c.phone),
    instagram: socialOf('instagram', so.instagram),
    tiktok: socialOf('tiktok', so.tiktok),
    facebook: socialOf('facebook', so.facebook),
    optedOut: s.optedOut === true,
    updatedAt: iso(s.updatedAt),
  };
}

// What a known lead keeps when Toran's answer has nothing for it.
const KEEP = ['name', 'platform', 'about', 'score', 'toran_status', 'email', 'whatsapp', 'phone', 'instagram', 'tiktok', 'facebook', 'toran_id'];

/** Add or change one lead from Toran's store. Returns 'added', 'updated', 'hidden', 'customer' or 'skipped'. */
export function upsertLead(db, s, { customers = new Set(), t = nowIso() } = {}) {
  const lead = storeToLead(s);
  if (!lead) return 'skipped';
  const had = db.get('SELECT * FROM leads WHERE domain = ?', lead.domain);
  if (!had) {
    if (customers.has(lead.domain)) return 'customer';
    if (lead.optedOut) return 'hidden';
    const { optedOut, updatedAt, ...row } = lead;
    db.insert('leads', { ...row, stage: 'new', toran_updated_at: updatedAt, created_at: t, updated_at: t });
    return 'added';
  }
  const patch = { url: lead.url, toran_updated_at: lead.updatedAt || had.toran_updated_at, updated_at: t };
  for (const k of KEEP) patch[k] = lead[k] ?? had[k];
  if (lead.optedOut && !had.opted_out_at) patch.opted_out_at = t;
  db.update('leads', had.id, patch);
  return lead.optedOut ? 'hidden' : 'updated';
}

/**
 * Where each lead is, from what happened since the page last looked: its demo found by domain (one the store asked
 * for on the website, or one built here), "דמו מוכן" once that demo's page is up and "חדש" again when it is gone,
 * "פתחו" once its page was opened after the message was sent (demo_opens: a view by someone not signed in), and
 * "הצטרפו" once one of our customers' workspaces has its site.
 */
export function refreshStages(ctx, { t = nowIso() } = {}) {
  const { db } = ctx;
  db.tx(() => {
    db.run(
      `UPDATE leads SET demo_id = COALESCE((SELECT d.id FROM demos d WHERE d.domain = leads.domain AND d.status <> 'removed' ORDER BY d.id DESC LIMIT 1), demo_id), updated_at = ?
        WHERE (demo_id IS NULL OR demo_id IN (SELECT id FROM demos WHERE status = 'removed'))
          AND EXISTS (SELECT 1 FROM demos d WHERE d.domain = leads.domain AND d.status <> 'removed')`,
      t
    );
    db.run("UPDATE leads SET stage = 'demo_ready', updated_at = ? WHERE stage = 'new' AND demo_id IN (SELECT id FROM demos WHERE status = 'approved')", t);
    db.run("UPDATE leads SET stage = 'new', updated_at = ? WHERE stage = 'demo_ready' AND (demo_id IS NULL OR demo_id NOT IN (SELECT id FROM demos WHERE status = 'approved'))", t);
    db.run(
      "UPDATE leads SET stage = 'opened', updated_at = ? WHERE stage = 'sent' AND sent_at IS NOT NULL AND EXISTS (SELECT 1 FROM demo_opens o WHERE o.demo_id = leads.demo_id AND o.at >= leads.sent_at)",
      t
    );
    const customers = [...workspaceDomains(ctx)];
    if (customers.length) {
      db.run(`UPDATE leads SET stage = 'joined', updated_at = ? WHERE stage NOT IN ('joined', 'irrelevant') AND domain IN (${customers.map(() => '?').join(', ')})`, t, ...customers);
    }
  });
}

/**
 * Copy what changed in Toran since the last time into leads, page by page. Never throws. Returns what it did:
 * { added, updated, hidden, customers, skipped, pages } or { why } (nothing may be asked) or { error }.
 */
export async function syncLeads(ctx, { env = process.env, fetchImpl = localFetch, t = now() } = {}) {
  const { db } = ctx;
  const at = new Date(t).toISOString();
  const src = leadsSource(env);
  if (!src.url) {
    setSetting(db, LAST, { at, ok: false, why: src.why });
    return { why: src.why };
  }
  const token = String(env.OF_INTERNAL_TOKEN).trim();
  const customers = workspaceDomains(ctx);
  const out = { added: 0, updated: 0, hidden: 0, customers: 0, skipped: 0, pages: 0 };
  const COUNT = { added: 'added', updated: 'updated', hidden: 'hidden', customer: 'customers', skipped: 'skipped' };
  let since = getSetting(db, CURSOR, null) || EPOCH;
  let latest = since;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${src.url}?since=${encodeURIComponent(since)}&limit=${PAGE}`;
      const r = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      let body = null;
      try {
        body = await r.json();
      } catch {
        /* the status says enough */
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`Toran answered HTTP ${r.status}${body?.error ? ` ${String(body.error).slice(0, 60)}` : ''}`);
      if (!body || !Array.isArray(body.stores)) throw new Error('Toran answered without a list of stores');
      out.pages++;
      db.tx(() => {
        // Toran fills a page past `limit` rather than split one moment between two pages, so the page is taken whole.
        for (const s of body.stores.slice(0, 10 * PAGE)) {
          out[COUNT[upsertLead(db, s, { customers, t: at })]]++;
          const u = moment(s?.updatedAt);
          if (u && momentKey(u) > momentKey(latest)) latest = u;
        }
      });
      const next = moment(body.next);
      if (!next || momentKey(next) <= momentKey(since)) break;
      since = next;
      setSetting(db, CURSOR, since);
    }
    // The next hour asks from the latest change seen, as Toran wrote it.
    if (momentKey(latest) > momentKey(getSetting(db, CURSOR, null) || EPOCH)) setSetting(db, CURSOR, latest);
    refreshStages(ctx, { t: at });
    setSetting(db, LAST, { at, ok: true, ...out });
    return out;
  } catch (e) {
    // The token is never in the line: only why the question failed.
    const why = e?.message || String(e);
    ctx.log?.(`[leads] Toran's stores were not read: ${why}`);
    setSetting(db, LAST, { at, ok: false, error: why.slice(0, 300), ...out });
    return { error: why, ...out };
  }
}

/** What the last sync said, for /leads: { at, ok, why | error, added, ... } or null before the first one. */
export const lastSync = (db) => getSetting(db, LAST, null);

/** The runner's step: syncLeads once an hour (leads:synced), whatever happened the last time. */
export async function leadsTick(ctx, { t = now(), env = process.env, fetchImpl } = {}) {
  const last = getSetting(ctx.db, 'leads:synced', null);
  if (last && t - Date.parse(last) < SYNC_EVERY_MS) return null;
  setSetting(ctx.db, 'leads:synced', new Date(t).toISOString());
  return syncLeads(ctx, { t, env, ...(fetchImpl ? { fetchImpl } : {}) });
}
