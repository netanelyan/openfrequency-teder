import { domainKey, refreshStages, upsertLead, workspaceDomains } from '../leads/sync.js';
import { reminderReady } from '../leads/messages.js';
import { now } from '../core/clock.js';
import { ActionError } from './actions.js';
import { internalRefusal, running } from './demos.js';
import { buildLeadDemo, markLeadSent } from './leads.js';
import { accountsLinks } from './accounts.js';

// One store, both products: Toran's lead page asks Teder about the same store (the owner, 2026-11-08: "i want the admin
// lead page to be connected. i want to be able to build only toran or only teder for a page, or both. i want to be able
// to send them 2 demos or 1"). Under the checks of src/web/demos.js internalRefusal (this machine only, OF_INTERNAL_TOKEN),
// test/fixtures/teder-leads.json, the same file in Toran:
//
//   GET  /internal/leads/state?toran=<Toran's store id>&domain=<the store's domain>
//        the lead and its demo, or lead null when Teder has no such store
//   GET  /internal/leads/list
//        every lead with its demo, Toran's id and the domain, for the shared lead dashboard on accounts' /admin
//   POST /internal/leads/demo   { store: <one store as Toran's GET /internal/stores gives it>, by }
//        the store as a lead (added, or brought up to date, as the hourly sync does: never a customer's site, never one
//        that asked not to be written to), then its demo built or linked, as /leads' "לבנות דמו" does
//   POST /internal/leads/mark   { toran, domain, stage: "first" | "reminder", by }
//        the first message or the one reminder went (from Toran: the message that carried both demos), marked as
//        "שלחתי" marks it, via whatsapp
//
// The lead is found by Toran's id, else by its domain (www. left out).

const BODY_LIMIT = 20_000;

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(c);
  }
  try {
    const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const byOf = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : 'toran');
const idOf = (v) => (v == null || v === '' ? null : /^[\w.:-]{1,64}$/.test(String(v)) ? String(v) : undefined);

/** The lead of Toran's store id, else of the domain; opted-out leads are not there. */
function findLead(db, toranId, domain) {
  const d = domainKey(domain);
  return (toranId && db.get('SELECT * FROM leads WHERE toran_id = ? AND opted_out_at IS NULL', toranId)) || (d && db.get('SELECT * FROM leads WHERE domain = ? AND opted_out_at IS NULL', d)) || null;
}

/**
 * The lead as Toran's page shows it. `origin` is Teder's public address, for the demo's public page; `admin` is where the
 * operator opens the demo and the lead in Teder, accounts' /admin/teder (accounts' docs/admin-split.md: Teder's own site
 * shows the product only), Teder's own address when not given.
 */
export function leadState(ctx, lead, { origin, admin = origin }) {
  if (!lead) return null;
  const demo = lead.demo_id ? ctx.db.get('SELECT id, status, slug, error FROM demos WHERE id = ?', lead.demo_id) : null;
  const pageUrl = demo && demo.status === 'approved' && demo.slug ? `${origin}/s/${demo.slug}` : null;
  return {
    id: lead.id,
    stage: lead.stage,
    sentAt: lead.sent_at || null,
    reminderSentAt: lead.reminder_sent_at || null,
    reminderDue: Boolean(lead.sent_at && !lead.reminder_sent_at && ['sent', 'opened'].includes(lead.stage) && reminderReady(lead.sent_at, now())),
    whatsapp: lead.whatsapp || null,
    demo: demo
      ? { id: demo.id, status: demo.status, building: ['new', 'building'].includes(demo.status) && running.has(demo.id), pageUrl, error: demo.status === 'failed' ? String(demo.error || '').slice(0, 300) || null : null, reviewUrl: `${admin}/demos/${demo.id}` }
      : null,
    leadUrl: `${admin}/leads?tab=${lead.stage === 'demo_ready' ? 'ready' : lead.stage === 'new' ? 'new' : lead.stage}#lead-${lead.id}`,
  };
}

/** The three routes. Returns [status, body]; `origin` is Teder's public address, for the pages' links. */
export async function leadsInternal(ctx, req, env, action, query, { origin }) {
  const refused = internalRefusal(req, env);
  if (refused) return refused;
  const admin = `${accountsLinks(env).admin}/teder`;
  if (action === 'state') {
    if (req.method !== 'GET') return [405, { error: 'method_not_allowed' }];
    const toran = idOf(query.get('toran'));
    const domain = query.get('domain') || '';
    if (toran === undefined || (!toran && !domainKey(domain))) return [400, { error: 'bad_request' }];
    refreshStages(ctx);
    return [200, { ok: true, lead: leadState(ctx, findLead(ctx.db, toran, domain), { origin, admin }) }];
  }
  if (action === 'list') {
    // Every lead at once, for the shared lead dashboard on accounts' /admin (the owner, 2026-11-08: "make the shared
    // lead dashboard be in the admin dashboard, not in one of the products"): Toran merges them with its stores by its
    // id, else by the domain. Opted-out leads are left out, as everywhere else here.
    if (req.method !== 'GET') return [405, { error: 'method_not_allowed' }];
    refreshStages(ctx);
    const rows = ctx.db.all('SELECT * FROM leads WHERE opted_out_at IS NULL ORDER BY id DESC LIMIT 2000');
    return [200, { ok: true, leads: rows.map((l) => ({ ...leadState(ctx, l, { origin, admin }), toranId: l.toran_id || null, domain: l.domain, name: l.name || null })) }];
  }
  if (req.method !== 'POST') return [405, { error: 'method_not_allowed' }];
  const b = await readBody(req);
  if (!b) return [400, { error: 'bad_request' }];
  if (action === 'demo') {
    const s = b.store;
    if (!s || typeof s !== 'object' || idOf(s.id) === undefined || !(domainKey(s.domain) || domainKey(s.url))) return [400, { error: 'bad_request' }];
    const how = upsertLead(ctx.db, s, { customers: workspaceDomains(ctx) });
    if (how === 'customer') return [200, { ok: false, error: 'זה האתר של לקוח שלנו, אז תדר לא בונה לו דמו.' }];
    if (how === 'hidden') return [200, { ok: false, error: 'החנות הזו ביקשה שלא נכתוב לה, אז לא בונים לה דמו.' }];
    const lead = findLead(ctx.db, idOf(s.id), s.domain || s.url);
    if (!lead) return [200, { ok: false, error: 'החנות לא נוספה ללידים של תדר.' }];
    try {
      const out = buildLeadDemo(ctx, byOf(b.by), lead);
      refreshStages(ctx);
      return [200, { ok: true, message: out.message, lead: leadState(ctx, ctx.db.get('SELECT * FROM leads WHERE id = ?', lead.id), { origin, admin }) }];
    } catch (e) {
      if (e instanceof ActionError) return [200, { ok: false, error: e.message, lead: leadState(ctx, lead, { origin, admin }) }];
      throw e;
    }
  }
  if (action === 'mark') {
    const toran = idOf(b.toran);
    if (toran === undefined || (b.stage !== 'first' && b.stage !== 'reminder')) return [400, { error: 'bad_request' }];
    refreshStages(ctx);
    const lead = findLead(ctx.db, toran, b.domain || '');
    if (!lead) return [200, { ok: false, error: 'אין לתדר ליד כזה.' }];
    try {
      const out = markLeadSent(ctx, byOf(b.by), lead, b.stage, 'whatsapp', { from: 'toran' });
      return [200, { ok: true, message: out.message, lead: leadState(ctx, ctx.db.get('SELECT * FROM leads WHERE id = ?', lead.id), { origin, admin }) }];
    } catch (e) {
      if (e instanceof ActionError) return [200, { ok: false, error: e.message }];
      throw e;
    }
  }
  return [404, { error: 'not_found' }];
}
