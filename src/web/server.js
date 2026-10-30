import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { assetsDir, dataDir } from '../core/paths.js';
import { now } from '../core/clock.js';
import { addDays, israelDate } from '../schedule/israel.js';
import { audit } from '../core/store.js';
import { cookies, csrfFor, csrfOk, isHttps, sessionSecret } from './auth.js';
import { accountsClient, accountsLinks, refusal, sessionIdFrom } from './accounts.js';
import { forWorkspace, owns } from './workspace.js';
import * as data from './data.js';
import * as pages from './pages.js';
import * as act from './actions.js';
import { onboardingRoutes } from './onboarding.js';
import { previewFile, stylesRoutes } from './styles.js';
import { demoPage, demosFeed, demosRoutes, demoThemeCss, goneHtml, intake, offerOf, publicDemo, recordOpen, sendPreview, sendSlide, visitorOf } from './demos.js';
import { loadPost } from '../pipeline/build.js';
import { lockedStyle } from '../render/style.js';
import { latestNotification } from '../notify/index.js';
import { assistantApi, isAssistantPath } from '../assistant/api.js';
import { assistantSecret, linkBase, mediaLinkOk } from '../assistant/sign.js';
import { connectRoutes, goPage, publicConnect, publicOnboardingConnect, publicPick } from './connect.js';
import { setupFeed } from './setup.js';
import { scheduleRoutes } from './schedule.js';
import { workspaceDeleteRoute } from './workspace-delete.js';
import { entitlementClient } from '../billing/entitlement.js';
import { healthFor, healthPanel, readiness, REVISION } from './health.js';

// The website. It listens on 127.0.0.1 only; on the VPS, Caddy holds the
// certificate and passes requests to it.
//
// THE CHECKS, IN ORDER, ON EVERY REQUEST:
//   - the Host header is ours (defeats DNS rebinding)
//   - a request under the public name came over HTTPS, which only the proxy on
//     this machine can say
//   - every page, image and button needs a session that openfrequency-accounts
//     vouches for (src/web/accounts.js), except the static files; without one the
//     browser goes to accounts' login with where it was going. A page may use an
//     answer up to a minute old; every POST asks afresh
//   - the session's workspace decides what exists (src/web/workspace.js): another
//     workspace's accounts, posts and sources are not found
//   - every POST carries the CSRF token derived from its session, and an Origin
//     that is ours; a read-only session (the operator viewing as a customer)
//     changes nothing
//   - a customer's workspace that has not paid for Teder (accounts' /internal/entitlement, src/billing/entitlement.js)
//     gets the paywall page instead of the product, its onboarding included; the operator, and the operator viewing
//     as a customer, never do
// /internal/lead, /internal/demos, /internal/setup and /internal/workspaces/<id>/delete are for services on this machine
// with OF_INTERNAL_TOKEN (src/web/demos.js fromWebsite, src/web/setup.js, src/web/workspace-delete.js). Three more doors need no session. /internal/assistant/* is the WhatsApp assistant's
// API (src/assistant/api.js): this machine only, never through the proxy, every
// request signed. /m/... is one rendered slide behind a signed link that expires,
// handed out by that API for WhatsApp to fetch. /connect/<account>/<platform> is the
// link that API hands on to connect a TikTok or Instagram, and where Zernio sends the
// browser back (src/web/connect.js): its signature is the permission. /new/<onboarding>/connect/<platform>/done is
// where Zernio sends it back after a connect made before the account existed, on the same terms.
// Server-rendered HTML with one small script; everything works without it.

export const HOST = '127.0.0.1';
const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const V = Date.now().toString(36);

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(req, res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'content-security-policy': CSP, ...extra };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  if (buf.length > 1024 && /gzip/.test(String(req.headers['accept-encoding'] || '')) && /text|json|javascript|svg|font/.test(type)) {
    buf = gzipSync(buf);
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
  }
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, obj, extra) => send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
const redirect = (res, to, extra = {}) => {
  res.writeHead(303, { location: to, 'cache-control': 'no-store', ...extra });
  res.end();
};

async function readForm(req, limit = 200_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

/** accounts.css: each account's own colour as --acc, so pages need no inline style. */
function accountsCss(ctx) {
  return ctx.packs.map((p) => `.acc-${p.id.replace(/[^a-z0-9-]/g, '')}{--acc:${/^#[0-9a-f]{3,8}$/i.test(p.theme.colors.accent) ? p.theme.colors.accent : '#888'}}`).join('\n');
}

const flash = (msg) => `of_flash=${encodeURIComponent(String(msg).slice(0, 200))}; Path=/; Max-Age=20; SameSite=Strict`;

/** Today and a year from today, Israel time, for the facts form's defaults. */
const factDates = () => {
  const today = israelDate(now());
  return { today, nextYear: addDays(today, 365) };
};

/** The answer to a POST from a read-only session (accounts' view-as). */
const READ_ONLY = 'זו צפייה בלבד, ושום שינוי לא נשמר.';

/** Where "back" goes on an error page: the page the browser came from, on this site, or home. */
function backOf(req, host) {
  try {
    const ref = req.headers.referer ? new URL(req.headers.referer) : null;
    return ref && ref.host === host ? ref.pathname + ref.search : '/';
  } catch {
    return '/';
  }
}

/**
 * `accounts` (src/web/accounts.js) answers who a session is; the tests give one that talks to a fake accounts.
 * `ctx` is the engine's: every account. Each request works on its workspace's view of it.
 */
export function createHandler(ctx, { port, env = process.env, accounts = null, entitlements = null } = {}) {
  const secret = sessionSecret(env);
  const links = accountsLinks(env);
  const who = accounts || accountsClient({ env, log: (m) => ctx.log?.(m) });
  // Whether a workspace has paid: the answers are kept in the database, which the runner reads too (canRun).
  const paid = entitlements || entitlementClient({ db: ctx.db, env, log: (m) => ctx.log?.(m) });
  ctx.entitlements ||= paid;
  const publicHost = String(env.PUBLIC_HOST || '').trim().toLowerCase() || null;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : [])]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicHost ? [`https://${publicHost}`] : [])]);

  // Whether the browser is signed in to OpenFrequency: a session accounts vouches for, or one it knows and refuses
  // here (another product's customer, a closed workspace). No session cookie never asks accounts; an answer that
  // fails (accounts down) leaves the browser a visitor.
  const signedIn = async (jar, https) => {
    const sid = sessionIdFrom(jar, { https });
    if (!sid) return false;
    const a = await who.whoIs(sid);
    return a.status === 200 || (a.status === 403 && ['no_membership', 'workspace_disabled', 'product_disabled'].includes(a.body?.error));
  };

  const assistant = assistantApi(ctx, { env, port });
  // The connect links: where Zernio sends the browser back, and what they are signed with (the assistant's secret,
  // which hands them on; the session secret where there is no assistant).
  const connectLinks = () => ({ base: linkBase({ env, port }), secret: assistantSecret(env) || secret });
  /** A post's rendered slide, read only from inside the data folder; null when there is none. */
  const slideFile = (post, platform, idx) => {
    const file = post?.media?.[platform]?.[Number(idx)];
    const root = path.resolve(ctx.mediaRoot || dataDir());
    return file && path.resolve(file).startsWith(root) && existsSync(file) ? file : null;
  };
  const sendPostSlide = (res, file, cache) => {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': statSync(file).size, 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
    return createReadStream(file).pipe(res);
  };

  const ROUTES = [
    ['POST', /^\/post\/([\w-]+)\/approve$/, (c, u, m) => act.approve(c, u, { id: m[1] })],
    ['POST', /^\/posts\/approve-all$/, (c, u, m, f) => act.approveAll(c, u, {}, f)],
    ['POST', /^\/post\/([\w-]+)\/unapprove$/, (c, u, m) => act.unapprove(c, u, { id: m[1] })],
    ['POST', /^\/post\/([\w-]+)\/reject$/, (c, u, m, f) => act.reject(c, u, { id: m[1] }, f)],
    ['POST', /^\/post\/([\w-]+)\/edit$/, (c, u, m, f) => act.edit(c, u, { id: m[1] }, f)],
    ['POST', /^\/post\/([\w-]+)\/slide\/(\d+)\/photo$/, (c, u, m, f) => act.swapPhoto(c, u, { id: m[1], idx: m[2] }, f)],
    ['POST', /^\/post\/([\w-]+)\/slide\/(\d+)\/remove$/, (c, u, m) => act.removeSlide(c, u, { id: m[1], idx: m[2] })],
    ['POST', /^\/post\/([\w-]+)\/publish-now$/, (c, u, m) => act.publishNow(c, u, { id: m[1] })],
    ['POST', /^\/post\/([\w-]+)\/publish-again$/, (c, u, m) => act.retryPublish(c, u, { id: m[1] })],
    ['POST', /^\/post\/([\w-]+)\/takedown$/, (c, u, m, f) => act.takedown(c, u, { id: m[1] }, f)],
    ['POST', /^\/post\/([\w-]+)\/image-ok$/, (c, u, m) => act.imageOk(c, u, { id: m[1] })],
    ['POST', /^\/takedowns\/(\d+)\/deleted$/, (c, u, m, f) => act.takedownDeleted(c, u, { id: m[1] }, f)],
    ['POST', /^\/accounts\/([\w-]+)\/mode$/, (c, u, m, f) => act.setMode(c, u, { id: m[1] }, f)],
    ['POST', /^\/accounts\/([\w-]+)\/style$/, (c, u, m) => act.applyStyle(c, u, { id: m[1] })],
    ['POST', /^\/accounts\/([\w-]+)\/kill$/, (c, u, m) => act.killAccount(c, u, { id: m[1] })],
    ['POST', /^\/accounts\/([\w-]+)\/resume$/, (c, u, m) => act.resume(c, u, { id: m[1] })],
    ['POST', /^\/accounts\/([\w-]+)\/quota$/, (c, u, m, f) => act.setQuota(c, u, { id: m[1] }, f)],
    ['POST', /^\/settings\/kill$/, (c, u, m, f) => act.globalKill(c, u, {}, f)],
    ['POST', /^\/settings\/generate-at$/, (c, u, m, f) => act.setGenerateAt(c, u, {}, f)],
    ['POST', /^\/sources\/(\d+)\/approve$/, (c, u, m, f) => act.sourceStatus(c, u, { id: m[1] }, f, 'approved')],
    ['POST', /^\/sources\/(\d+)\/remove$/, (c, u, m, f) => act.sourceStatus(c, u, { id: m[1] }, f, 'removed')],
    ['POST', /^\/sources\/add$/, (c, u, m, f) => act.addSource(c, u, {}, f)],
    ['POST', /^\/sources\/catalog$/, (c, u, m, f) => act.addCatalogSource(c, u, {}, f)],
    ['POST', /^\/facts\/add$/, (c, u, m, f) => act.addFact(c, u, {}, f)],
    ['POST', /^\/facts\/confirm$/, (c, u, m, f) => act.confirmFact(c, u, {}, f)],
    ['POST', /^\/facts\/remove$/, (c, u, m, f) => act.removeFactAction(c, u, {}, f)],
    ['POST', /^\/topics\/add$/, (c, u, m, f) => act.addTopicAction(c, u, {}, f)],
    ['POST', /^\/topics\/remove$/, (c, u, m, f) => act.removeTopicAction(c, u, {}, f)],
    ['POST', /^\/topics\/watch$/, (c, u, m, f) => act.saveWatchAction(c, u, {}, f)],
    ['POST', /^\/rivals\/save$/, (c, u, m, f) => act.saveRivalAction(c, u, {}, f)],
    ['POST', /^\/rivals\/remove$/, (c, u, m, f) => act.removeRivalAction(c, u, {}, f)],
    ['POST', /^\/sounds\/save$/, (c, u, m, f) => act.saveSoundAction(c, u, {}, f)],
    ['POST', /^\/sounds\/remove$/, (c, u, m, f) => act.removeSoundAction(c, u, {}, f)],
    ['POST', /^\/settings\/whatsapp$/, (c, u, m, f) => act.setAssistantPrefs(c, u, {}, f)],
    ['POST', /^\/settings\/email$/, (c, u, m, f) => act.setEmailPrefsAction(c, u, {}, f)],
    ['POST', /^\/push\/subscribe$/, (c, u, m, f) => act.subscribePush(c, u, {}, f)],
    ['POST', /^\/push\/unsubscribe$/, (c, u, m, f) => act.unsubscribePush(c, u, {}, f)],
    ['POST', /^\/post\/([\w-]+)\/old-drafts-deleted$/, (c, u, m) => act.oldDraftsDeleted(c, u, { id: m[1] })],
    ...onboardingRoutes(connectLinks),
    ...scheduleRoutes(),
    ...stylesRoutes(),
    ...demosRoutes(),
    ...connectRoutes(connectLinks),
  ];

  const handler = async function handler(req, res) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      if (!hosts.has(host)) return send(req, res, 421, 'wrong host', 'text/plain; charset=utf-8');
      const secure = isHttps(req);
      if (publicHost && host === publicHost && !secure) return send(req, res, 403, 'HTTPS only', 'text/plain; charset=utf-8');
      const url = new URL(req.url, `http://${host}`);
      const p = decodeURIComponent(url.pathname);
      // ---- the WhatsApp assistant: answers only straight from this machine, signed (src/assistant/api.js)
      if (isAssistantPath(p)) return await assistant(req, res, url);
      const jar = cookies(req);
      const theme = ['dark', 'light'].includes(jar.of_theme) ? jar.of_theme : null;

      // ---- static, no session
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/static/style.css') return send(req, res, 200, readFileSync(path.join(STATIC, 'style.css')), 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
        if (p === '/static/app.js') return send(req, res, 200, readFileSync(path.join(STATIC, 'app.js')), 'text/javascript; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
        // A browser asks for /favicon.ico on its own (Safari always): answer with the icon, not the login page.
        if (p === '/favicon.ico') return send(req, res, 200, readFileSync(path.join(STATIC, 'icon-180.png')), 'image/png', { 'cache-control': 'public, max-age=86400' });
        if (p === '/static/icon.svg') return send(req, res, 200, readFileSync(path.join(STATIC, 'icon.svg')), 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
        if (p === '/static/icon-180.png' || p === '/static/icon-512.png') return send(req, res, 200, readFileSync(path.join(STATIC, path.basename(p))), 'image/png', { 'cache-control': 'public, max-age=86400' });
        if (p === '/static/manifest.webmanifest') return send(req, res, 200, readFileSync(path.join(STATIC, 'manifest.webmanifest')), 'application/manifest+json; charset=utf-8', { 'cache-control': 'public, max-age=86400' });
        if (p === '/static/fonts/Assistant.ttf') return send(req, res, 200, readFileSync(path.join(assetsDir, 'fonts', 'Assistant.ttf')), 'font/ttf', { 'cache-control': 'public, max-age=31536000, immutable' });
        // Liveness, with the commit this build is; readiness (the database, the runner) is /readyz (src/web/health.js).
        if (p === '/healthz') return send(req, res, 200, `ok ${REVISION}`, 'text/plain; charset=utf-8');
        if (p === '/readyz') {
          const r = readiness(ctx);
          return json(req, res, r.ok ? 200 : 503, r);
        }
        // A slide behind a signed link (src/assistant/sign.js mediaLink): that slide, until the link expires, nothing else.
        const ml = /^\/m\/([\w-]+)\/(tiktok|instagram)\/(\d+)$/.exec(p);
        if (ml) {
          const ok = mediaLinkOk(assistantSecret(env), { postId: ml[1], platform: ml[2], idx: ml[3], e: url.searchParams.get('e'), s: url.searchParams.get('s') });
          const file = ok ? slideFile(loadPost(ctx.db, ml[1]), ml[2], ml[3]) : null;
          return file ? sendPostSlide(res, file, 'private, max-age=600') : send(req, res, 404, 'no such slide', 'text/plain; charset=utf-8');
        }
        // Connecting a TikTok, Instagram or Facebook Page from a link the assistant sent, and back from Zernio (src/web/connect.js).
        const cn = /^\/connect\/([\w-]+)\/(tiktok|instagram|facebook)(\/done)?$/.exec(p);
        if (cn) {
          const [status, html, location] = await publicConnect(ctx, { account: cn[1], platform: cn[2], done: Boolean(cn[3]), query: url.searchParams, links: connectLinks() });
          if (location) {
            res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
            return res.end();
          }
          return send(req, res, status, html, 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
        }
        // The Instagram account or Facebook Page picked on our own page, after a headless connect that offered several (src/web/connect.js).
        const pk = /^\/connect\/pick\/([0-9a-f]{32})$/.exec(p);
        if (pk) {
          const [status, html] = await publicPick(ctx, { id: pk[1], pageId: url.searchParams.get('page') });
          return send(req, res, status, html, 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
        }
        // Back from Zernio after a connect made while a new account's sources were searched, before the account existed.
        const oc = /^\/new\/([\w-]+)\/connect\/(tiktok|instagram|facebook)\/done$/.exec(p);
        if (oc) {
          const [status, html] = await publicOnboardingConnect(ctx, { onboardingId: oc[1], platform: oc[2], query: url.searchParams, links: connectLinks() });
          return send(req, res, status, html, 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' });
        }
        // The service worker, from the root so its scope is the whole site.
        if (p === '/sw.js') return send(req, res, 200, readFileSync(path.join(STATIC, 'sw.js')), 'text/javascript; charset=utf-8', { 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
        // A store's demo page (src/web/demos.js): public once the operator approved it, never indexed.
        if (p === '/static/demo.css') return send(req, res, 200, readFileSync(path.join(STATIC, 'demo.css')), 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=3600' });
        const dm = /^\/s\/([a-z0-9-]{3,40})(?:\/(?:(tiktok|instagram|p)-(\d{1,2})\.jpg|(theme)\.css|(logo)))?$/.exec(p);
        if (dm) {
          const demo = publicDemo(ctx.db, dm[1]);
          if (dm[4]) return demo ? send(req, res, 200, demoThemeCss(demo), 'text/css; charset=utf-8', { 'cache-control': 'public, max-age=600' }) : send(req, res, 404, '', 'text/css; charset=utf-8');
          if (dm[2] || dm[5]) return sendSlide(ctx, res, demo, dm[2] === 'p' ? 'shelf' : dm[2] || 'logo', dm[3]) || send(req, res, 404, 'no such slide', 'text/plain; charset=utf-8');
          if (!demo) return send(req, res, 404, goneHtml(), 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex' });
          // The page itself, opened by someone not signed in, is an open; its pictures and its colour are not.
          const { visitor, cookie } = visitorOf(jar, { https: secure });
          if (req.method === 'GET' && !(await signedIn(jar, secure))) recordOpen(ctx.db, demo.id, visitor);
          return send(req, res, 200, demoPage(demo, { offer: offerOf(ctx.db) }), 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', ...(cookie ? { 'set-cookie': cookie } : {}) });
        }
      }
      // A store asked for a demo on openfrequency.co.il: the website's lead service, on this machine, with its token.
      if (req.method === 'POST' && p === '/internal/lead') {
        const [status, body] = await intake(ctx, req, env);
        return json(req, res, status, body);
      }
      // The operator's dashboard on Toran reads every demo and its opens: the same checks, on this machine alone. The
      // pages' address is the public name's; without one (a laptop), the address this request came to.
      if (req.method === 'GET' && p === '/internal/demos') {
        const [status, body] = demosFeed(ctx, req, env, { origin: publicHost ? `https://${publicHost}` : `http://${host}` });
        return json(req, res, status, body);
      }
      // Accounts' setup checklist asks for a workspace's steps here (src/web/setup.js): the same checks, and each step's
      // page under the public name, where the browser goes with the session it already has.
      if (req.method === 'GET' && p === '/internal/setup') {
        const [status, body] = setupFeed(ctx, req, env, { base: publicHost ? `https://${publicHost}` : `http://${host}`, query: url.searchParams });
        return json(req, res, status, body);
      }
      // A customer deleted their workspace in accounts: its accounts and their data go (src/web/workspace-delete.js).
      const wd = req.method === 'POST' && /^\/internal\/workspaces\/([^/]+)\/delete$/.exec(p);
      if (wd) {
        const [status, body] = await workspaceDeleteRoute(ctx, req, env, wd[1]);
        return json(req, res, status, body);
      }

      // ---- everything else needs a session that accounts vouches for (src/web/accounts.js). A page may use an answer
      // up to a minute old; anything else (every POST) asks afresh, so no change acts on a session that has ended.
      const ajax = req.headers['x-of-ajax'] === '1';
      const reading = req.method === 'GET' || req.method === 'HEAD';
      const sid = sessionIdFrom(jar, { https: secure });
      const answer = await who.whoIs(sid, { live: !reading });
      if (answer.status !== 200) {
        const kind = refusal(answer.status, answer.body?.error);
        // Back to this page after the login: its full address, under the public name when it came through the proxy.
        const here = `${publicHost && host === publicHost ? `https://${publicHost}` : `http://${host}`}${reading ? req.url : '/'}`;
        if (kind === 'login') return reading ? redirect(res, links.login(here)) : json(req, res, 401, { ok: false, message: 'צריך להיכנס שוב.', login: links.login(here) });
        const status = kind === 'error' ? 503 : 403;
        if (!reading) return json(req, res, status, { ok: false, message: pages.GATE[kind].text });
        return send(req, res, status, pages.gatePage({ v: V, kind, links }));
      }
      const a = answer.body;
      // The operator is the superadmin outside view-as: every workspace. In view-as the superadmin is in the
      // workspace viewed, read-only, like everyone with a workspace.
      const operator = a.role === 'superadmin' && !a.workspace;
      const user = { id: a.user.id, email: a.user.email, name: a.user.name || a.user.email, role: a.role, operator, readOnly: a.readOnly === true, workspace: a.workspace || null, viewAs: a.viewAs || null };
      // The paywall: a customer whose workspace has not paid sees where to pay, not the product. With no answer to go by
      // (accounts has not answered for a day, or never), the page says the check failed rather than ask them to pay. The
      // operator viewing as the customer (read-only) sees what is there.
      const ent = !operator && !user.viewAs && a.workspace ? await paid.check(a.workspace.id) : null;
      if (ent && !ent.allowed) {
        const kind = ent.known ? 'unpaid' : 'error';
        if (!reading) return json(req, res, ent.known ? 402 : 503, { ok: false, message: pages.GATE[kind].text, ...(ent.known ? { pay: links.setup } : {}) });
        return send(req, res, ent.known ? 402 : 503, pages.gatePage({ v: V, kind, links }));
      }
      const c = operator ? ctx : forWorkspace(ctx, a.workspace.id);
      const csrf = csrfFor(sid, secret);

      // ---- the account shown. Every page is one account's; the switcher at the top changes it, and a link that names
      // one (a post, ?account=) switches to that one. A cookie keeps it. Only the workspace's accounts are there to pick.
      const acctCookie = (id) => `of_acct=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`;
      const setCookies = [];
      const firstLive = () => c.packs.find((x) => c.db.get('SELECT status FROM accounts WHERE id = ?', x.id)?.status !== 'onboarding') || c.packs[0] || null;
      let current = c.pack(jar.of_acct) || firstLive();
      const switchTo = (pack) => {
        if (!pack) return;
        current = pack;
        if (jar.of_acct !== pack.id) setCookies.push(acctCookie(pack.id));
      };

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) return json(req, res, 403, { ok: false, message: 'בקשה מאתר אחר נחסמה.' });
        const form = await readForm(req);
        if (!csrfOk(form._csrf, sid, secret)) return ajax ? json(req, res, 403, { ok: false, message: 'הדף ישן. רעננו אותו.' }) : send(req, res, 403, pages.errorPage({ kind: 'stale', back: backOf(req, host), v: V }));
        // View-as (and any session accounts marks read-only) changes nothing, whatever the button: refused here, on
        // the server, not only by the buttons it does not see.
        if (user.readOnly) return ajax ? json(req, res, 403, { ok: false, message: READ_ONLY }) : send(req, res, 403, pages.errorPage({ kind: 'read_only', back: backOf(req, host), v: V }));
        // Developer mode: the settings a developer reads (the server's keys, engine and log), the operator's alone,
        // opened from the version line and kept on this browser.
        if (p === '/settings/dev') {
          if (!user.operator) return ajax ? json(req, res, 403, { ok: false, message: 'את זה משנה רק מי שמפעיל את תדר' }) : redirect(res, '/settings');
          const on = form.on === '1';
          const cookie = `of_dev=${on ? '1' : ''}; Path=/; Max-Age=${on ? 31536000 : 0}; SameSite=Strict; HttpOnly${secure ? '; Secure' : ''}`;
          if (on) audit(ctx.db, { actor: user.email, action: 'dev_mode' });
          return redirect(res, on ? '/settings#dev' : '/settings', { 'set-cookie': [cookie, flash(on ? 'מצב מפתח פתוח' : 'מצב מפתח כבוי')] });
        }
        if (p === '/account/switch') {
          const to = c.pack(String(form.to || ''));
          if (!to) return ajax ? json(req, res, 404, { ok: false, message: 'אין חשבון כזה' }) : redirect(res, '/');
          // Back to the same page of the other account; a post belongs to the account it was, so its page goes home.
          const ref = req.headers.referer && new URL(req.headers.referer).host === host ? new URL(req.headers.referer).pathname : '/';
          return redirect(res, /^\/post\//.test(ref) ? '/' : ref, { 'set-cookie': acctCookie(to.id) });
        }
        if (p === '/theme') {
          const next = theme === 'dark' ? 'light' : 'dark';
          const cookie = `of_theme=${next}; Path=/; Max-Age=31536000; SameSite=Strict`;
          return ajax ? json(req, res, 200, { ok: true, theme: next }, { 'set-cookie': cookie }) : redirect(res, req.headers.referer && new URL(req.headers.referer).host === host ? new URL(req.headers.referer).pathname : '/', { 'set-cookie': cookie });
        }
        for (const [method, re, fn] of ROUTES) {
          const m = method === 'POST' && re.exec(p);
          if (!m) continue;
          try {
            const r = await fn(c, user, m, form);
            if (ajax) return json(req, res, 200, r);
            if (r.go) return send(req, res, 200, goPage(r.go, { name: r.goName, v: V }), 'text/html; charset=utf-8', { 'referrer-policy': 'no-referrer' });
            const back = r.redirect || (req.headers.referer && new URL(req.headers.referer).host === host ? new URL(req.headers.referer).pathname + new URL(req.headers.referer).search : '/');
            return redirect(res, back, { 'set-cookie': flash(r.message) });
          } catch (e) {
            if (!(e instanceof act.ActionError)) throw e;
            if (ajax) return json(req, res, e.status, { ok: false, message: e.message, problems: e.problems || [] });
            // A form that failed its checks comes back with the problems and what was typed, on an account of this
            // workspace (a form naming another one gets the redirect below).
            const cur = c.pack(String(form.account || '')) || c.packs[0] || null;
            const again = (html) => send(req, res, e.status, html);
            if (/\/edit$/.test(p)) {
              const d = data.postFull(c, m[1]);
              if (d) return again(pages.postPage({ ...pageCtx(), csrf }, d, { problems: e.problems || [e.message], values: e.values }));
            }
            if (cur && p === '/sources/add') return again(pages.sourcesPage({ ...pageCtx(), csrf }, { packs: [cur], current: cur, sources: data.sourcesFor(c, cur.id), form, problems: e.problems || [e.message] }));
            if (cur && p === '/facts/add') return again(pages.factsPage({ ...pageCtx(), csrf }, { packs: [cur], current: cur, topics: data.factsFor(c, cur), ...factDates(), form, problems: e.problems || [e.message] }));
            if (cur && p === '/sounds/save') return again(pages.soundsPage({ ...pageCtx(), csrf }, { ...data.soundsFor(c, cur), packs: [cur], form, problems: e.problems || [e.message] }));
            if (cur && p === '/topics/add') return again(pages.topicsPage({ ...pageCtx(), csrf }, { ...data.topicsFor(c, cur), form, problems: e.problems || [e.message] }));
            if (cur && p === '/rivals/save') return again(pages.rivalsPage({ ...pageCtx(), csrf }, { ...data.rivalsFor(c, cur), packs: [cur], form, problems: e.problems || [e.message] }));
            return redirect(res, req.headers.referer && new URL(req.headers.referer).host === host ? new URL(req.headers.referer).pathname : '/', { 'set-cookie': flash(e.message) });
          }
        }
        return ajax ? json(req, res, 404, { ok: false, message: 'אין פעולה כזו' }) : send(req, res, 404, pages.errorPage({ kind: 'no_action', back: backOf(req, host), v: V }));
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, pages.errorPage({ kind: 'method', v: V }));

      // ---- media: a post's rendered slides, read only from inside the data folder, and only the workspace's own
      const mm = /^\/media\/([\w-]+)\/(tiktok|instagram)\/(\d+)$/.exec(p);
      if (mm) {
        const post = loadPost(c.db, mm[1]);
        const file = post && owns(c, post.account_id) ? slideFile(post, mm[2], mm[3]) : null;
        return file ? sendPostSlide(res, file, 'private, max-age=86400') : send(req, res, 404, 'no such slide', 'text/plain; charset=utf-8');
      }
      // ---- a style preview (src/web/styles.js): a file its account's own manifest names, the workspace's accounts only
      const sm = /^\/styles\/img\/([\w-]+)\/([\w-]+)\/([A-D])\/(\d+)$/.exec(p);
      if (sm) {
        const pk = owns(c, sm[1]) ? c.pack(sm[1]) : null;
        const file = pk ? previewFile(pk, sm[2], sm[3], sm[4]) : null;
        if (!file) return send(req, res, 404, 'no such preview', 'text/plain; charset=utf-8');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': statSync(file).size, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
        return createReadStream(file).pipe(res);
      }
      // ---- a demo's slides on its operator page (src/web/demos.js); for anyone else there is no such thing
      const dp = /^\/demos\/(\d+)\/img\/(tiktok|instagram)\/(\d+)$/.exec(p);
      if (dp) return sendPreview(ctx, user, res, dp) || send(req, res, 404, 'no such slide', 'text/plain; charset=utf-8');
      // Each account's colour; it names the accounts, so a browser keeps it per session (vary: cookie).
      if (p === '/static/accounts.css') return send(req, res, 200, accountsCss(c), 'text/css; charset=utf-8', { 'cache-control': 'private, max-age=600', vary: 'cookie' });

      const named = url.searchParams.get('account');
      if (named) switchTo(c.pack(named));
      const opened = /^\/post\/([\w-]+)$/.exec(p);
      if (opened) switchTo(c.pack(c.db.get('SELECT account_id FROM posts WHERE id = ?', opened[1])?.account_id));
      // What the pages read: the context seen from the account shown.
      const sc = data.scoped(c, current);
      const h = data.header(sc);
      const flashMsg = jar.of_flash ? jar.of_flash : null;
      if (flashMsg) setCookies.push('of_flash=; Path=/; Max-Age=0; SameSite=Strict');
      const clearFlash = setCookies.length ? { 'set-cookie': setCookies } : {};
      function pageCtx() {
        // The desk's sidebar, collapsed to its icons or not: a cookie the toggle sets, so the page arrives already in shape.
        return { csrf, user, theme, side: jar.of_side === 'mini' ? 'mini' : null, v: V, ...h, flash: flashMsg, links, operator: user.operator, readOnly: user.readOnly, viewAs: user.viewAs, workspace: user.workspace, dev: jar.of_dev === '1' && user.operator };
      }
      const pc = pageCtx();
      const page = (html, status = 200) => send(req, res, status, flashMsg ? html.replace('<div id="toast" role="status" aria-live="polite"></div>', `<div id="toast" role="status" aria-live="polite" data-flash="${String(flashMsg).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}"></div>`) : html, 'text/html; charset=utf-8', clearFlash);

      if (p === '/') return page(pages.todayPage(pc, data.today(sc)));
      if (p === '/posts') return page(pages.postsPage(pc, data.today(sc)));
      // The one page that is not one account's: every account of the workspace, and what waits in all of them.
      if (p === '/all') {
        // The operator also sees every workspace's health (src/web/health.js): payment, failures, connections, drafts.
        const health = healthFor(c, user);
        return page(pages.allPage(pc, { ...data.today(c), healthHtml: health ? healthPanel(health.rows, health.alerts) : '' }));
      }
      const pm = /^\/post\/([\w-]+)$/.exec(p);
      if (pm) {
        const d = data.postFull(c, pm[1]);
        return d ? page(pages.postPage(pc, d)) : page(pages.notFoundPage(pc), 404);
      }
      // The look is locked against the same customer's other accounts (no two alike), so the style reads the engine's packs.
      if (p === '/accounts') return page(pages.accountsPage(pc, data.accountRows(sc).map((r) => ({ ...r, week: data.week(c, r.pack.id), style: lockedStyle(ctx.db, r.pack, ctx.packs) }))));
      if (p === '/results') return page(pages.resultsPage(pc, data.results(sc)));
      const cur = current;
      if (p === '/sources') {
        if (!cur) return page(pages.notFoundPage(pc), 404);
        return page(pages.sourcesPage(pc, { packs: sc.packs, current: cur, sources: data.sourcesFor(c, cur.id) }));
      }
      if (p === '/settings') return page(pages.settingsPage(pc, data.settingsData(sc)));
      if (p === '/facts') {
        if (!cur) return page(pages.notFoundPage(pc), 404);
        return page(pages.factsPage(pc, { packs: sc.packs, current: cur, topics: data.factsFor(c, cur), ...factDates() }));
      }
      if (p === '/sounds') {
        if (!cur) return page(pages.notFoundPage(pc), 404);
        return page(pages.soundsPage(pc, { ...data.soundsFor(c, cur), packs: sc.packs }));
      }
      // The service worker asks what to show for a push it was woken by: the workspace's latest, the operator's any.
      if (p === '/notifications/latest.json') return json(req, res, 200, latestNotification(c.db, user.operator ? null : c.packs.map((x) => x.id)) || {});
      if (p === '/topics') {
        if (!cur) return page(pages.notFoundPage(pc), 404);
        return page(pages.topicsPage(pc, data.topicsFor(c, cur)));
      }
      if (p === '/rivals') {
        if (!cur) return page(pages.notFoundPage(pc), 404);
        return page(pages.rivalsPage(pc, { ...data.rivalsFor(c, cur), packs: sc.packs }));
      }
      if (p === '/more') return page(pages.morePage(pc));
      if (/^\/demos(\/|$)/.test(p) && !user.operator) return page(pages.notFoundPage(pc), 404);
      for (const [method, re, fn] of ROUTES) {
        const m = method === 'GET' && re.exec(p);
        if (!m) continue;
        const out = await fn(c, user, m, Object.fromEntries(url.searchParams), pc);
        // A route that answers a page's script: JSON, never cached (src/web/onboarding.js status).
        return out && typeof out === 'object' && 'json' in out ? json(req, res, 200, out.json) : page(out);
      }
      return page(pages.notFoundPage(pc), 404);
    } catch (e) {
      // The stack goes to the log, never to the page. Only an ActionError's message is the customer's to read; anything
      // else is our own, and the page says so in Hebrew, with the way back.
      ctx.log?.(`[web] ${req.method} ${req.url}: ${e.stack || e.message}`);
      const mine = e instanceof act.ActionError;
      const status = mine ? e.status || 400 : 500;
      if (req.headers['x-of-ajax'] === '1') return json(req, res, status, { ok: false, message: mine ? e.message : pages.ERROR_HE.broken.text });
      return send(req, res, status, pages.errorPage({ kind: 'broken', text: mine ? e.message : null, back: backOf(req, String(req.headers.host || '').toLowerCase()), v: V }));
    }
  };
  // Every route the site answers, for the test that each one keeps to its workspace.
  handler.routes = ROUTES.map(([method, re]) => [method, re]);
  handler.assistant = assistant;
  return handler;
}

export function listen(ctx, { port = Number(process.env.PORT) || 4700, env = process.env, accounts = null, entitlements = null } = {}) {
  let inner = null;
  const server = createServer((req, res) => inner(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const actual = server.address().port;
      inner = createHandler(ctx, { port: actual, env, accounts, entitlements });
      resolve({ server, port: actual, handler: inner });
    });
  });
}
