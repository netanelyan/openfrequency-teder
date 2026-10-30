import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, lookGroups } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { customerWorkspace, ownWorkspace, ownWorkspaces } from '../src/billing/own.js';
import { autonomyMode, canRun, isCustomerAccount, UNPAID } from '../src/autonomy/rails.js';
import { tiktokMode, tiktokModeFor } from '../src/publish/index.js';
import { accountAllowed, lastKnown, refreshEntitlements } from '../src/billing/entitlement.js';
import { monthShare, monthsOf, planOf, room, setPlan, sharing, usage } from '../src/budget/quota.js';
import { REMOVALS, queueRemovals, retentionPass, stoppedWorkspaces } from '../src/billing/retention.js';
import { EDIT_CHECKS_PER_DAY, edit, setMode, setQuota } from '../src/web/actions.js';
import { sampleRoom } from '../src/web/onboarding.js';
import { connectData, connectRoutes, tiktokModePanel } from '../src/web/connect.js';
import { accountRows, quotasData, settingsData } from '../src/web/data.js';
import { quotasPanel, settingsPage } from '../src/web/pages.js';
import { workspaceHealth } from '../src/web/health.js';
import { forWorkspace, owns } from '../src/web/workspace.js';
import { emailTick } from '../src/notify/email.js';
import { listen } from '../src/web/server.js';
import { DIR, signature } from '../src/assistant/sign.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, opened, operator, paidWorkspaces, tempHome } from './helpers.js';

// The company's own accounts sit in a workspace of accounts so that its people see them in Teder, and they stay the
// operator's (OF_OWN_WORKSPACES, src/billing/own.js). With workspace 1 named, an account in it behaves as an account in
// no workspace does for every customer rule: the operator's mode and TikTok choice, a plan of its own that the operator
// sets, no caps on samples and light edits, no paywall, no disconnect by retention. Who sees it does not change. With
// the setting empty, the same account is a customer's, as the merged rules have it.
//
// alpha and bravo are workspace 1's, zulu is workspace 2's.

after(() => closeBrowser());
afterEach(() => {
  setNow(null);
  delete process.env.OF_OWN_WORKSPACES;
});

/** Name the company's own workspaces ('' for none), as the server's .env would. */
const own = (v) => {
  process.env.OF_OWN_WORKSPACES = v;
};

const OCT = israelInstant('2026-10-13', '09:00').getTime();
const OPERATOR = { id: 1, name: 'operator', operator: true };
const PERSON = { id: 101, name: 'owner', operator: false };

/** alpha and bravo in workspace 1, zulu in workspace 2; or only the packs named. */
function home({ only = null } = {}) {
  const looks = {
    alpha: null,
    bravo: (f) => {
      f.theme.template = 'poster';
      f.theme.fonts.display = 'Secular One';
      Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
    },
    zulu: (f) => {
      f.theme.variant = 'b';
      f.theme.fonts.display = 'Karantina';
      Object.assign(f.theme.colors, { bg: '#2B1B3D', surface: '#3A2850', ink: '#F7F2FB', muted: '#C9BCD8', accent: '#F59E0B', onAccent: '#2B1B3D' });
    },
  };
  const h = tempHome({ packs: Object.fromEntries(Object.entries(looks).filter(([id]) => !only || only.includes(id))) });
  const db = new Db(path.join(h.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(h.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(h.home, 'data', 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id IN ('alpha', 'bravo')");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'zulu'");
  return { ...h, db, ctx };
}

let n = 0;
const post = (db, account, patch = {}) => {
  const at = new Date(OCT).toISOString();
  const id = `own${++n}`;
  db.insert('posts', { id, account_id: account, status: 'queued', quota_kind: 'suggestion', quota_month: '2026-10', created_at: at, updated_at: at, ...patch });
  return id;
};

test('the setting: whole workspace ids, read at every call; empty is none', () => {
  own('');
  assert.deepEqual([...ownWorkspaces()], []);
  assert.deepEqual([ownWorkspace(1), customerWorkspace(1), customerWorkspace(null), ownWorkspace(null)], [false, true, false, false]);
  own(' 1, 7 ,x, 0,-3, 2.5');
  assert.deepEqual([...ownWorkspaces()].sort(), [1, 7]);
  assert.deepEqual([ownWorkspace(1), ownWorkspace('7'), customerWorkspace(1), customerWorkspace(2)], [true, true, false, true]);
  assert.equal(customerWorkspace(null), false, 'no workspace is not a customer either');
});

test("approval and TikTok: the operator's choices stand for an account of an own workspace, and only the operator makes them", async () => {
  const { db, ctx, cleanup } = home();
  try {
    const route = connectRoutes(() => ({ base: 'http://127.0.0.1', secret: 's'.repeat(40) })).find(([method, re]) => method === 'POST' && re.test('/accounts/alpha/tiktok'));
    const tiktok = (user, id, mode) => route[2](ctx, user, route[1].exec(`/accounts/${id}/tiktok`), { mode });
    const pc = { csrf: 'x', operator: true, db };
    const personApproved = { approved_by: 'owner' };

    own('1');
    db.update('accounts', 'alpha', { mode: 'auto' });
    assert.equal(isCustomerAccount(db, 'alpha'), false);
    assert.equal(autonomyMode(db, 'alpha'), 'auto', 'the stored mode stands');
    assert.equal(setMode(ctx, OPERATOR, { id: 'alpha' }, { mode: 'digest' }).ok, true);
    assert.equal(autonomyMode(db, 'alpha'), 'digest');
    // Only the operator, as for an account in no workspace: the workspace's people read the one line.
    assert.throws(() => setMode(ctx, PERSON, { id: 'alpha' }, { mode: 'auto' }), (e) => e.status === 403);
    assert.equal(tiktok(OPERATOR, 'alpha', 'direct').ok, true);
    assert.equal(tiktokMode(ctx.pack('alpha'), db), 'direct');
    assert.equal(tiktokModeFor(db, ctx.pack('alpha'), personApproved), 'direct');
    assert.throws(() => tiktok(PERSON, 'alpha', 'direct'), (e) => e.status === 403);
    assert.equal(accountRows(ctx).find((r) => r.pack.id === 'alpha').customer, false);
    assert.match(tiktokModePanel(pc, connectData(ctx, ctx.pack('alpha'))), /action="\/accounts\/alpha\/tiktok"/, 'the operator gets the selector');

    // The setting empty: the same account is a customer's, locked to approval and to TikTok drafts.
    own('');
    assert.equal(isCustomerAccount(db, 'alpha'), true);
    assert.equal(autonomyMode(db, 'alpha'), 'approve', 'the stored digest is ignored');
    assert.equal(tiktokMode(ctx.pack('alpha'), db), 'draft-now');
    assert.throws(() => setMode(ctx, OPERATOR, { id: 'alpha' }, { mode: 'auto' }), (e) => e.status === 403 && /בחשבון של לקוח/.test(e.message));
    assert.throws(() => tiktok(OPERATOR, 'alpha', 'direct'), (e) => e.status === 403 && /בחשבון של לקוח/.test(e.message));
    assert.match(tiktokModePanel(pc, connectData(ctx, ctx.pack('alpha'))), /חשבון של לקוח: תמיד לטיוטות/);
  } finally {
    cleanup();
  }
});

test("the plan: an own workspace's account has its own 40 and 10, set by the operator, shared with nobody and not thinned", () => {
  const { db, ctx, cleanup } = home();
  try {
    setNow(OCT);
    // accounts' plan for workspace 1 (the small one) is a customer's: not read for ours.
    paidWorkspaces(db, [1], { plan: { name: 'small', slideshows: 15, redos: 4 } });
    for (let i = 0; i < 9; i++) post(db, 'alpha');
    for (let i = 0; i < 5; i++) post(db, 'bravo');
    const pc = { csrf: 'x', operator: true, links: {}, db };

    own('1');
    const p = planOf(db, 'alpha');
    assert.deepEqual([p.scope, p.suggested, p.redos, p.workspaceId], ['account', 40, 10, null]);
    assert.deepEqual(sharing(db, 'alpha'), ['alpha'], 'not shared with bravo, though both are in workspace 1');
    const a = usage(db, 'alpha');
    assert.deepEqual([a.suggested.used, a.suggested.limit, a.shared], [9, 40, false]);
    assert.equal(usage(db, 'bravo').suggested.used, 5);
    assert.deepEqual([monthShare(db, 'alpha'), monthShare(db, 'bravo')], [40, 40], 'each schedule the whole month, not a share');
    assert.deepEqual(monthsOf(db, ['alpha', 'bravo']), { used: 14, limit: 80 }, 'two months, one each');
    // The operator's numbers, as for an account in no workspace.
    assert.equal(setPlan(db, 'alpha', { suggested: '12', redos: '3' }).suggested, 12);
    assert.equal(setQuota(ctx, OPERATOR, { id: 'bravo' }, { suggested: '20' }).ok, true);
    assert.deepEqual([planOf(db, 'alpha').suggested, planOf(db, 'alpha').redos, planOf(db, 'bravo').suggested, monthShare(db, 'alpha')], [12, 3, 20, 12]);
    for (let i = 0; i < 3; i++) post(db, 'alpha');
    assert.equal(room(db, 'alpha').ok, false, "alpha's own 12 used");
    assert.equal(room(db, 'bravo').ok, true, "bravo's month is its own");
    const panel = quotasPanel(pc, quotasData(ctx));
    assert.match(panel, /action="\/accounts\/alpha\/quota"/, "the operator's form, as for our own");
    assert.match(panel, /action="\/accounts\/bravo\/quota"/);
    assert.doesNotMatch(panel, /סביבת עבודה 1/);
    const settings = settingsPage({ csrf: 'x', user: { name: 'owner' }, operator: false, workspace: { id: 1, name: 'W' }, links: {} }, settingsData(forWorkspace(ctx, 1)));
    assert.doesNotMatch(settings, /משותפות לכל החשבונות שלכם/);

    // The setting empty: workspace 1's plan, shared, thinned, and the operator's numbers refused.
    own('');
    const c = planOf(db, 'alpha');
    assert.deepEqual([c.scope, c.suggested, c.redos, c.workspaceId], ['workspace', 15, 4, 1]);
    assert.deepEqual(sharing(db, 'alpha'), ['alpha', 'bravo']);
    assert.deepEqual([usage(db, 'alpha').suggested.used, usage(db, 'alpha').shared], [17, true]);
    assert.equal(monthShare(db, 'alpha'), 8);
    assert.deepEqual(setPlan(db, 'alpha', { suggested: '99' }).problems, ['workspace']);
    assert.throws(() => setQuota(ctx, OPERATOR, { id: 'alpha' }, { suggested: '99' }), (e) => e.status === 409);
    assert.match(quotasPanel(pc, quotasData(ctx)), /סביבת עבודה 1/);
    assert.doesNotMatch(quotasPanel(pc, quotasData(ctx)), /action="\/accounts\/alpha\/quota"/);
  } finally {
    cleanup();
  }
});

test('the caps: the month of sample rounds and the light edits of the day are not counted in an own workspace', async () => {
  const { db, ctx, cleanup } = home({ only: ['alpha'] });
  try {
    setNow(OCT);
    // Six rounds of samples this month in workspace 1, and a new onboarding of it.
    const month = new Date(OCT).toISOString();
    db.insert('onboarding', { id: 'o-many', seed_json: {}, status: 'samples', workspace_id: 1, candidates_json: { rounds: Array.from({ length: 6 }, () => ({ at: month, by: 'customer' })) }, created_at: month, updated_at: month });
    const fresh = { status: 'samples', found: {}, workspace_id: 1 };
    // Thirty light-edit checks billed today for workspace 1, and one more edit.
    const id = (await buildPost(ctx, { pack: ctx.pack('alpha'), formatKey: 'care-guide' })).postId;
    for (let i = 0; i < EDIT_CHECKS_PER_DAY; i++) db.insert('spend', { account_id: 'alpha', post_id: id, api: 'anthropic', usd: 0.001, tag: 'edit-check', month: '2026-10', at: month });
    const asked = [];
    const llm = { kind: 'claude', async json(req) { asked.push(req.user); return { data: { reviews: [{ index: 0, botScore: 2, tells: [], factIssue: false, factProblem: '' }] }, usage: { input_tokens: 400, output_tokens: 60 }, model: req.model }; } };
    const form = () => {
      const p = loadPost(db, id);
      const f = { hook: p.hook, sub: p.sub || '', caption: p.caption, caption_short: p.data?.captionShort || '' };
      p.slides.filter((s) => s.kind === 'item').forEach((s, i) => Object.assign(f, { [`title_${i}`]: s.title, [`body_${i}`]: s.body }));
      return f;
    };
    const people = { ...ctx, llm, workspaceId: 1 };

    // The setting empty first: workspace 1 is a customer, both caps hold.
    own('');
    assert.deepEqual(sampleRoom(db, fresh), { ok: false, why: 'month' });
    const changed = { ...form(), title_1: form().title_1.replace('השעון', 'הלוח') };
    assert.notEqual(changed.title_1, form().title_1, 'the edit changes a text');
    await assert.rejects(edit(people, PERSON, { id }, changed), (e) => e.status === 429);
    assert.equal(asked.length, 0);

    own('1');
    assert.deepEqual(sampleRoom(db, fresh), { ok: true, why: null }, 'the month of rounds is not counted');
    assert.deepEqual(sampleRoom(db, { ...fresh, found: { rounds: [{ at: month }, { at: month }] } }).why, 'onboarding', 'the two rounds per new account stand, as in no workspace');
    await edit(people, PERSON, { id }, changed);
    assert.equal(asked.length, 1, 'checked by the model, not stopped by the cap');
    assert.equal(loadPost(db, id).slides.filter((x) => x.kind === 'item')[1].title, changed.title_1);
  } finally {
    cleanup();
  }
});

test("the paywall: an own workspace is never asked about nor refused, on the website, in the engine, through the assistant or in the emails", async () => {
  const { db, ctx, cleanup } = home();
  const fake = await fakeAccounts();
  const secret = 'o'.repeat(48);
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'q'.repeat(40), OF_ASSISTANT_SECRET: secret, ...fake.env } });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    // accounts says workspace 1 has not paid, and counts each question about it.
    let asked1 = 0;
    fake.entitlement(1, (req, res) => {
      asked1++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workspace: 1, product: 'teder', enabled: true, access: 'unpaid', allowed: false, paidThrough: null, cancelAt: null, graceUntil: null }));
    });
    const people1 = fake.session(customer(1)).cookie;
    const page = (cookie, p = '/') => fetch(`${base}${p}`, { headers: { cookie }, redirect: 'manual' });
    const assistant = async (p) => {
      const sig = signature(secret, { dir: DIR.in, method: 'GET', path: p, body: '' });
      const r = await fetch(`${base}${p}`, { headers: { 'x-of-signature': sig } });
      return { status: r.status, body: await r.json() };
    };
    const failed = (id) => db.insert('posts', { id, account_id: 'alpha', status: 'failed', sample: 0, hook: 'פוסט שלא עלה', reason: 'x', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const sent = [];
    const client = { configured: true, link: (p) => `https://teder.openfrequency.co.il${p}`, send: async (b) => (sent.push(b), { ok: true }) };

    own('1');
    assert.deepEqual(canRun(db, 'alpha'), { ok: true, why: null });
    assert.equal(accountAllowed(db, 'alpha'), true);
    const r = await refreshEntitlements(ctx, { env: fake.env });
    assert.deepEqual(Object.keys(r), ['2'], 'the runner asks about the customer, not about us');
    assert.equal((await page(people1)).status, 200, 'the product, not the paywall');
    assert.equal((await page(people1, '/accounts')).status, 200);
    assert.equal((await assistant('/internal/assistant/customers/1/status')).status, 200);
    assert.equal(asked1, 0, 'accounts was never asked about workspace 1');
    assert.equal(lastKnown(db, 1), null);
    assert.equal(workspaceHealth(ctx).find((w) => w.workspace === 1).access, 'ours');
    failed('own-failed-1');
    await emailTick(ctx, { client });
    assert.ok(sent.some((x) => x.workspace === 1 && x.kind === 'publish_failed'), "workspace 1's people still hear of a failed post");

    // The setting empty: today's merged behaviour, workspace 1 is a customer that has not paid.
    own('');
    assert.equal((await page(people1)).status, 402);
    assert.ok(asked1 > 0);
    assert.deepEqual([canRun(db, 'alpha').ok, canRun(db, 'alpha').why, canRun(db, 'alpha').code], [false, UNPAID, 'unpaid']);
    assert.equal(accountAllowed(db, 'alpha'), false);
    assert.deepEqual(Object.keys(await refreshEntitlements(ctx, { env: fake.env })).sort(), ['1', '2']);
    const refused = await assistant('/internal/assistant/customers/1/status');
    assert.deepEqual([refused.status, refused.body.error], [403, 'not_paid']);
    assert.equal(workspaceHealth(ctx).find((w) => w.workspace === 1).access, 'unpaid');
    sent.length = 0;
    failed('own-failed-2');
    await emailTick(ctx, { client });
    assert.deepEqual(sent.filter((x) => x.workspace === 1), [], 'an unpaid customer gets no email');
  } finally {
    await new Promise((resolve) => s.server.close(resolve));
    await fake.close();
    cleanup();
  }
});

test('retention: an own workspace is never disconnected, whatever answer is kept for it; a customer is, a day after the stop', async () => {
  const { db, ctx, cleanup } = home();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'zernio.com') return realFetch(url, init);
    calls.push(`${(init.method || 'GET').toUpperCase()} ${u.pathname}`);
    return new Response(JSON.stringify({ message: 'deleted' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  try {
    const t = Date.parse('2026-10-29T08:00:00Z');
    db.update('accounts', 'alpha', { zernio_profile_id: 'prof-alpha' });
    db.insert('zernio_connections', { account_id: 'alpha', platform: 'tiktok', zernio_account_id: 'tk-alpha', username: 'a', status: 'connected', connected_at: 'x', checked_at: 'x' });
    // An answer kept from before (accounts said not allowed two days ago), and a removal queued for that stop.
    setSetting(db, 'entitlement:1', { allowed: false, access: 'unpaid', plan: null, stoppedAt: new Date(t - 2 * 86_400_000).toISOString(), checkedAt: new Date(t).toISOString() });
    queueRemovals(db, [{ kind: 'account', id: 'tk-old', account: 'alpha', workspace: 1, reason: 'stopped' }]);

    own('1');
    assert.deepEqual(stoppedWorkspaces(db, t), []);
    const out = await retentionPass(ctx, { t, force: true });
    assert.deepEqual(out.stopped, []);
    assert.equal(out.removals.dropped, 1, "the queued removal is dropped: it is ours, in use");
    assert.deepEqual(calls, [], 'nothing was disconnected on Zernio');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id = 'alpha'").n, 1);
    assert.deepEqual(getSetting(db, REMOVALS), []);

    // The setting empty: workspace 1 is a customer whose Teder stopped.
    own('');
    assert.deepEqual(stoppedWorkspaces(db, t).map((x) => x.workspace), [1]);
    const next = await retentionPass(ctx, { t, force: true });
    assert.deepEqual(next.stopped.map((x) => x.workspace), [1]);
    assert.deepEqual(calls, ['DELETE /api/v1/accounts/tk-alpha']);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id = 'alpha'").n, 0);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ZERNIO_API_KEY;
    cleanup();
  }
});

test("who sees what does not change: workspace 1's people see its accounts, workspace 2's do not, and the looks are kept apart within it", async () => {
  const { db, ctx, cleanup } = home();
  const fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'v'.repeat(40), ...fake.env } });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    paidWorkspaces(db, [2]);
    const people1 = fake.session(customer(1)).cookie;
    const people2 = fake.session(customer(2)).cookie;
    const body = async (cookie, p) => {
      const res = await fetch(`${base}${p}`, { headers: { cookie }, redirect: 'manual' });
      assert.equal(res.status, 200, p);
      return res.text();
    };
    for (const v of ['1', '']) {
      own(v);
      const w1 = forWorkspace(ctx, 1);
      const w2 = forWorkspace(ctx, 2);
      assert.deepEqual(w1.packs.map((p) => p.id).sort(), ['alpha', 'bravo'], `setting "${v}"`);
      assert.deepEqual(w2.packs.map((p) => p.id), ['zulu']);
      assert.deepEqual([owns(w1, 'alpha'), owns(w2, 'alpha'), owns(w1, 'zulu'), owns(ctx, 'alpha')], [true, false, false, true]);
      assert.equal(lookGroups(db)(ctx.pack('alpha')), 'ws:1', 'kept apart among workspace 1, as before');
      if (v === '') paidWorkspaces(db, [1]);
      for (const p of ['/all', '/accounts']) {
        const one = await body(people1, p);
        assert.match(one, /חשבון alpha/, p);
        assert.doesNotMatch(one, /חשבון zulu/, p);
        const two = await body(people2, p);
        assert.match(two, /חשבון zulu/, p);
        assert.doesNotMatch(two, /חשבון (alpha|bravo)/, `${p}: workspace 2 sees nothing of workspace 1`);
      }
      const op = await body(fake.session(operator()).cookie, '/all');
      assert.match(op, /חשבון alpha/);
      assert.match(op, /חשבון zulu/);
    }
  } finally {
    await new Promise((resolve) => s.server.close(resolve));
    await fake.close();
    cleanup();
  }
});
