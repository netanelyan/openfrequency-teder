import { now } from '../core/clock.js';
import { audit, step } from '../core/store.js';
import { loadPost } from '../pipeline/build.js';
import { REDO_REASONS } from '../budget/quota.js';
import * as act from '../web/actions.js';
import { forWorkspace, owns } from '../web/workspace.js';
import { assistantSecret, linkBase, LINK_TTL_S, verify } from './sign.js';
import { accountOf, accountStatus, bundleOf, connectionsOf, postView, prefsOf, quotaOf, setPrefs } from './data.js';
import { CONNECT_LINK_TTL_S } from '../publish/connect.js';
import { entitlementsOf } from '../billing/entitlement.js';

// The WhatsApp assistant's door into Teder (openfrequency-toran; the contract is docs/assistant-api.md).
//
// THE CHECKS, IN ORDER, ON EVERY REQUEST:
//   - it came from this machine, straight: a loopback socket, a Host of 127.0.0.1 or localhost on our port, and no
//     header a proxy adds. Caddy is on this machine too, so the socket alone says nothing; a request through it
//     carries X-Forwarded-For and the public name. Anything else is answered as a page that does not exist
//   - OF_ASSISTANT_SECRET is set, or nothing here answers (503)
//   - it is signed with it, now, and never seen before (src/assistant/sign.js)
//   - the customer is a workspace (openfrequency-accounts' id), and the request works on that workspace's context
//     (src/web/workspace.js): another workspace's post is not found, the same answer as a post that never was
//   - the workspace has paid for Teder, asked as the website asks (src/billing/entitlement.js): one that has not is
//     answered 403 not_paid, and one accounts never answered for 503 entitlement_unknown. Nothing is read, approved,
//     rejected or edited for it here either: an edit is a model call.
//
// The assistant is trusted to say which customer and which person it acts for: it is ours, it holds the secret, and
// it binds a phone number to a person in a workspace on its side. Every change names the person (`by`), and is
// recorded as theirs, via WhatsApp, in the post's trace and the audit log. The buttons are the website's own
// (src/web/actions.js), so the quota, the redo and the light edit's rules are the same whichever way a customer
// presses them.

const PREFIX = '/internal/assistant/';
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 64 * 1024;
/** The posts a customer may still reject or edit (a sample is the operator's, never the assistant's). */
const DECIDE = ['queued', 'approved'];
/** The posts a customer may post by hand. */
const READY = ['approved', 'publishing', 'drafted', 'published'];
const ERROR_OF = { 400: 'bad_request', 403: 'forbidden', 404: 'not_found', 409: 'wrong_state', 413: 'too_large', 422: 'refused' };

export const isAssistantPath = (p) => p.startsWith(PREFIX);

class ApiError extends Error {
  constructor(status, error, message = error, extra = {}) {
    super(message);
    Object.assign(this, { status, error, extra });
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new ApiError(413, 'too_large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The person a change is recorded as: { by: { name, userId? } } in the body. */
function actorOf(body) {
  const by = body?.by;
  const name = typeof by?.name === 'string' ? by.name.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > 80) throw new ApiError(400, 'no_actor', 'by.name: who did it, 1 to 80 characters');
  if (by.userId != null && !Number.isInteger(by.userId)) throw new ApiError(400, 'no_actor', 'by.userId: an integer');
  return { id: by.userId ?? null, name, email: null, role: 'client_member', operator: false, readOnly: false, via: 'whatsapp' };
}

/** The post's trace says who did it, from where. */
const traced = (db, postId, user, action, detail = {}) => step(db, postId, 'whatsapp', 'info', { action, by: user.name, userId: user.id, via: 'whatsapp', ...detail });

/**
 * The handler. `port` is the website's own, for the Host check and the slide links; `jobs` keeps what a change left
 * running (a replacement being written, a TikTok draft on its way), for the tests to wait on.
 */
export function assistantApi(ctx, { env = process.env, port }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const jobs = new Set();
  const keep = (r) => {
    if (r?.job) {
      const j = Promise.resolve(r.job).finally(() => jobs.delete(j));
      jobs.add(j);
    }
    return r;
  };

  const ROUTES = [
    ['GET', /^posts\/pending$/, pending],
    ['GET', /^posts\/([\w-]+)\/bundle$/, bundle],
    ['POST', /^posts\/([\w-]+)\/approve$/, approve],
    ['POST', /^posts\/([\w-]+)\/reject$/, reject],
    ['POST', /^posts\/([\w-]+)\/edit$/, edit],
    ['GET', /^status$/, status],
    ['GET', /^accounts\/([\w-]+)\/connect$/, connect],
    ['GET', /^settings$/, settingsGet],
    ['POST', /^settings$/, settingsSet],
  ];

  const handler = async function handler(req, res, url) {
    try {
      const straight = LOOPBACK.has(req.socket?.remoteAddress) && hosts.has(String(req.headers.host || '').toLowerCase()) && !FORWARDED.some((h) => req.headers[h] != null);
      if (!straight) throw new ApiError(404, 'not_found');
      const secret = assistantSecret(env);
      if (!secret) throw new ApiError(503, 'not_configured', 'OF_ASSISTANT_SECRET is not set (32 characters or more)');
      if (!['GET', 'POST'].includes(req.method)) throw new ApiError(405, 'method_not_allowed');
      const raw = await readBody(req);
      const v = verify(ctx.db, secret, { header: req.headers['x-of-signature'], method: req.method, path: url.pathname + url.search, body: raw });
      if (!v.ok) throw new ApiError(401, v.error);
      let body = {};
      if (req.method === 'POST') {
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new ApiError(400, 'bad_json');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'bad_json');
      }
      const m = /^customers\/(\d{1,9})\/(.+)$/.exec(url.pathname.slice(PREFIX.length));
      if (!m) throw new ApiError(404, 'not_found');
      const workspaceId = Number(m[1]);
      if (!workspaceId) throw new ApiError(404, 'not_found');
      let known = false;
      for (const [method, re, fn] of ROUTES) {
        const r = re.exec(m[2]);
        if (!r) continue;
        known = true;
        if (method !== req.method) continue;
        const ent = await entitlementsOf(ctx, env).check(workspaceId);
        if (!ent.allowed) throw ent.known ? new ApiError(403, 'not_paid', "the customer's Teder subscription is not active") : new ApiError(503, 'entitlement_unknown', 'accounts has not said whether the customer has paid');
        const c = forWorkspace(ctx, workspaceId);
        const link = { secret, base: linkBase({ env, port }), t: now() };
        return send(res, 200, await fn({ c, workspaceId, params: r.slice(1), body, link, query: url.searchParams }));
      }
      throw known ? new ApiError(405, 'method_not_allowed') : new ApiError(404, 'not_found');
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { ok: false, error: e.error, message: e.message, ...e.extra });
      if (e instanceof act.ActionError) return send(res, e.status, { ok: false, error: ERROR_OF[e.status] || 'refused', message: e.message, problems: e.problems || [] });
      ctx.log?.(`[assistant] ${req.method} ${url.pathname}: ${e.stack || e.message}`);
      return send(res, 500, { ok: false, error: 'internal', message: 'something went wrong; the details are in the log' });
    }
  };

  /* ---------------------------------------------------------------- reads */

  /** Every post of the customer's accounts that waits for their decision, the soonest slot first. */
  function pending({ c, workspaceId, link }) {
    const ids = c.packs.map((p) => p.id);
    const rows = ids.length ? c.db.all(`SELECT id FROM posts WHERE status = 'queued' AND sample = 0 AND account_id IN (${ids.map(() => '?').join(', ')}) ORDER BY slot_at IS NULL, slot_at, created_at`, ...ids) : [];
    const posts = rows.map((r) => loadPost(c.db, r.id)).map((p) => postView(p, c.pack(p.account_id), link));
    return { ok: true, customer: workspaceId, linksExpireAt: new Date(link.t + LINK_TTL_S * 1000).toISOString(), posts };
  }

  function bundle({ c, params: [id], link }) {
    const post = mustPost(c, id);
    if (!READY.includes(post.status)) throw new ApiError(409, 'not_approved', 'the post is not approved', { status: post.status });
    return { ok: true, linksExpireAt: new Date(link.t + LINK_TTL_S * 1000).toISOString(), post: bundleOf(c.db, post, c.pack(post.account_id), link) };
  }

  function status({ c, workspaceId }) {
    const live = c.packs.filter((p) => c.db.get('SELECT status FROM accounts WHERE id = ?', p.id)?.status !== 'onboarding');
    return { ok: true, customer: workspaceId, accounts: live.map((p) => accountStatus(c.db, p)) };
  }

  /**
   * One account's TikTok and Instagram: what is connected, and for what is not (or stopped working), the link to send
   * the customer. The link opens Teder, which asks Zernio for a fresh connect link at the tap; it works for 72 hours.
   */
  function connect({ c, params: [id], link }) {
    const pack = c.pack(id);
    if (!pack || !owns(c, id)) throw new ApiError(404, 'not_found', 'no such account');
    return { ok: true, account: accountOf(pack), linksExpireAt: new Date(link.t + CONNECT_LINK_TTL_S * 1000).toISOString(), platforms: connectionsOf(c.db, pack, link) };
  }

  function settingsGet({ workspaceId }) {
    return { ok: true, customer: workspaceId, ...prefsOf(ctx.db, workspaceId) };
  }

  /* ---------------------------------------------------------------- changes */

  function approve({ c, params: [id], body }) {
    const user = actorOf(body);
    const post = mustPost(c, id, ['queued']);
    const r = keep(act.approve(c, user, { id: post.id }));
    traced(c.db, post.id, user, 'approve');
    return { ok: true, message: r.message, post: { id: post.id, status: loadPost(c.db, post.id).status } };
  }

  /**
   * Reject, with one of the form's reasons and the customer's own words. A redo is written while the month has one
   * left (the website's rules, src/web/actions.js reject); `redo` says what happened: writing, none (used up),
   * paused, sample.
   */
  function reject({ c, params: [id], body }) {
    const user = actorOf(body);
    const reason = String(body.reason || '');
    if (!REDO_REASONS.includes(reason)) throw new ApiError(400, 'bad_reason', `reason: one of ${REDO_REASONS.join(', ')}`);
    if (body.freeText != null && typeof body.freeText !== 'string') throw new ApiError(400, 'bad_request', 'freeText: a string');
    const post = mustPost(c, id, DECIDE);
    const r = keep(act.reject(c, user, { id: post.id }, { reason, note: String(body.freeText || '').slice(0, 300) }));
    const after = loadPost(c.db, post.id);
    traced(c.db, post.id, user, 'reject', { reason, redo: after.reject?.redo || null });
    return { ok: true, message: r.message, post: { id: post.id, status: after.status }, redo: after.reject?.redo || null, quota: quotaOf(c.db, post.account_id) };
  }

  /**
   * A light edit of one slide's text: { slide (1 is the cover), newText, field? }. The cover's text is its headline
   * (field "hook", or "sub" for the line under it); a content slide's is its body (or "title"). Checked in code, the
   * changed text fact-checked, the slides drawn again: the website's edit, with every other text as it was.
   */
  async function edit({ c, params: [id], body, link }) {
    const user = actorOf(body);
    const post = mustPost(c, id, DECIDE);
    const n = body.slide;
    if (!Number.isInteger(n) || n < 1 || n > post.slides.length) throw new ApiError(400, 'bad_slide', `slide: 1 to ${post.slides.length}`);
    if (typeof body.newText !== 'string' || !body.newText.trim()) throw new ApiError(400, 'bad_text', 'newText: the slide\'s new text');
    const slide = post.slides[n - 1];
    const fields = slide.kind === 'cover' ? { hook: 90, sub: 120 } : slide.kind === 'item' ? { body: 300, title: 80 } : null;
    if (!fields) throw new ApiError(422, 'not_editable', 'the closing slide is not edited');
    const field = body.field == null ? Object.keys(fields)[0] : String(body.field);
    if (!(field in fields)) throw new ApiError(400, 'bad_field', `field: ${Object.keys(fields).join(' or ')} on this slide`);
    const text = body.newText.replace(/\r/g, '').trim();
    if (text.length > fields[field]) throw new ApiError(422, 'too_long', `${fields[field]} characters at most`, { max: fields[field] });

    // The form the website's edit takes, as its page fills it, with the one text changed.
    const form = { hook: post.hook || '', sub: post.sub || '', caption: post.caption || '' };
    if (post.caption_ig) form.caption_short = post.data?.captionShort || '';
    let item = -1;
    post.slides.forEach((s, i) => {
      if (s.kind !== 'item') return;
      item++;
      form[`title_${item}`] = i === n - 1 && field === 'title' ? text : s.title || '';
      form[`body_${item}`] = i === n - 1 && field === 'body' ? text : s.body || '';
    });
    if (slide.kind === 'cover') form[field] = text;
    const r = keep(await act.edit(c, user, { id: post.id }, form));
    traced(c.db, post.id, user, 'edit', { slide: n, field });
    const after = loadPost(c.db, post.id);
    return { ok: true, message: r.message, post: postView(after, c.pack(after.account_id), link) };
  }

  function settingsSet({ workspaceId, body }) {
    const user = actorOf(body);
    const r = setPrefs(ctx.db, workspaceId, { events: body.events, quiet: body.quiet }, { by: user.name });
    if (r.problems) throw new ApiError(400, 'bad_settings', r.problems.join('; '), { problems: r.problems });
    audit(ctx.db, { actor: user.name, action: 'assistant_prefs', detail: { workspace: workspaceId, via: 'whatsapp', ...r } });
    return { ok: true, customer: workspaceId, ...r };
  }

  handler.jobs = jobs;
  return handler;
}

/** A post of this workspace, or not found (another workspace's included); in one of `states` when they are given. */
function mustPost(c, id, states = null) {
  const post = loadPost(c.db, id);
  if (!post || !owns(c, post.account_id) || post.sample) throw new ApiError(404, 'not_found', 'no such post');
  if (states && !states.includes(post.status)) throw new ApiError(409, 'wrong_state', `the post is ${post.status}`, { status: post.status });
  return post;
}
