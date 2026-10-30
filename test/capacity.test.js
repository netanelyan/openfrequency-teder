import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll, readPack } from '../src/packs/load.js';
import { validateAll } from '../src/packs/validate.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { entitlementClient, lastKnown, planOfAnswer } from '../src/billing/entitlement.js';
import { monthShare, monthsOf, planOf, room, setPlan, usage } from '../src/budget/quota.js';
import { setQuota } from '../src/web/actions.js';
import { accountsPage, settingsPage } from '../src/web/pages.js';
import { accountRows, settingsData, week } from '../src/web/data.js';
import { forWorkspace } from '../src/web/workspace.js';
import { newTheme, createPack } from '../src/onboarding/pack.js';
import { DISPLAY_FACES } from '../src/render/fonts.js';
import { ALL_LOOKS } from '../src/render/templates/registry.js';
import { backup, verifyCopy } from '../src/db/backup.js';
import { REMOVALS, queueRemovals, retentionPass, stoppedWorkspaces } from '../src/billing/retention.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { DEMO, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// What one customer may draw from Teder, and what Teder keeps of them (docs/decisions.md, 2026-10-29): the month is the
// workspace's, shared by its accounts, and its size is accounts' plan; samples and light edits are bounded; a new
// account's look is kept apart from the same customer's accounts only, and the pool never runs out; the nightly backup
// has the packs; and the privacy page's periods are kept by a daily pass.

after(() => closeBrowser());
afterEach(() => setNow(null));

const OCT = israelInstant('2026-10-13', '09:00').getTime();
const owner = { id: 1, name: 'owner', operator: true };

/** Three packs, alpha and bravo in workspace 1, loose in none. */
function three() {
  const home = tempHome({
    packs: {
      alpha: null,
      bravo: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
      loose: (f) => {
        f.theme.variant = 'b';
        f.theme.fonts.display = 'Karantina';
        Object.assign(f.theme.colors, { bg: '#2B1B3D', surface: '#3A2850', ink: '#F7F2FB', muted: '#C9BCD8', accent: '#F59E0B', onAccent: '#2B1B3D' });
      },
    },
  });
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'data', 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id IN ('alpha', 'bravo')");
  return { ...home, db, ctx };
}

let n = 0;
const post = (db, account, patch = {}) => {
  const at = new Date(OCT).toISOString();
  const id = `cap${++n}`;
  db.insert('posts', { id, account_id: account, status: 'queued', quota_kind: 'suggestion', quota_month: '2026-10', created_at: at, updated_at: at, ...patch });
  return id;
};

/* ------------------------------------------------------------------ the plan */

test("the plan accounts gives is kept with its answer, and a malformed one is the full plan's; the day it stopped is kept until it is allowed again", async () => {
  const { db, cleanup } = three();
  const fake = await fakeAccounts();
  try {
    let t = Date.parse('2026-10-20T10:00:00Z');
    const client = entitlementClient({ db, env: fake.env, clock: () => t });
    fake.entitlement(1, { access: 'paid', plan: { name: 'small', slideshows: 15, redos: 4 } });
    await client.check(1, { live: true });
    assert.deepEqual(lastKnown(db, 1).plan, { name: 'small', slideshows: 15, redos: 4 });
    assert.equal(lastKnown(db, 1).stoppedAt, null);
    for (const bad of [{ name: 'small', slideshows: -1, redos: 4 }, { name: 'Small!', slideshows: 15, redos: 4 }, { name: 'small', slideshows: 15.5, redos: 4 }, 'small', { name: 'big', slideshows: 5000, redos: 1 }]) {
      assert.equal(planOfAnswer({ plan: bad }), null, JSON.stringify(bad));
    }
    fake.entitlement(1, { access: 'paid', plan: { name: 'x', slideshows: 'lots' } });
    const a = await client.check(1, { live: true });
    assert.equal(a.allowed, true, 'a plan out of shape does not cast doubt on the rest of the answer');
    assert.equal(lastKnown(db, 1).plan, null);
    assert.deepEqual([planOf(db, 'alpha').suggested, planOf(db, 'alpha').redos], [40, 10], 'no plan: the full one');

    fake.entitlement(1, 'cancelled');
    await client.check(1, { live: true });
    const stopped = lastKnown(db, 1).stoppedAt;
    assert.equal(stopped, new Date(t).toISOString());
    t += 3_600_000;
    await client.check(1, { live: true });
    assert.equal(lastKnown(db, 1).stoppedAt, stopped, 'the first answer that said no is when it stopped');
    fake.entitlement(1, 'paid');
    await client.check(1, { live: true });
    assert.equal(lastKnown(db, 1).stoppedAt, null);
  } finally {
    await fake.close();
    cleanup();
  }
});

test("every answer in accounts' entitlement contract is read as the contract says: a 200 for Teder acted on by `allowed` alone, with its plan and grace kept; a 404 is no; anything else is accounts not answering", async () => {
  // A copy of openfrequency-accounts' docs/contracts/entitlement.json (accounts commit 447bb34): the two must agree.
  const contract = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'contracts', 'entitlement.json'), 'utf8'));
  const answers = contract.routes[0].answers;
  assert.ok(answers.some((a) => a.body.access === 'due'), 'the contract has the grace answer');
  const { db, cleanup } = three();
  const fake = await fakeAccounts();
  try {
    const t = Date.parse('2026-11-25T10:00:00Z');
    let ws = 10;
    for (const a of answers) {
      ws++;
      const client = entitlementClient({ db, env: fake.env, clock: () => t });
      fake.entitlement(ws, { status: a.status, body: a.status === 200 ? { ...a.body, workspace: ws } : a.body });
      const got = await client.check(ws, { live: true });
      if (a.status === 200 && a.body.product === 'teder') {
        assert.deepEqual([got.source, got.allowed, got.access], ['fresh', a.body.allowed, a.body.access], a.case);
        const kept = lastKnown(db, ws);
        assert.deepEqual(kept.plan, { name: a.body.plan.name, slideshows: a.body.plan.slideshows, redos: a.body.plan.redos }, a.case);
        assert.equal(kept.graceUntil, a.body.graceUntil, a.case);
      } else if (a.status === 200) {
        assert.equal(got.source, 'unknown', `${a.case}: another product's answer is not Teder's`);
      } else if (a.status === 404) {
        assert.deepEqual([got.source, got.allowed], ['fresh', false], a.case);
      } else {
        assert.deepEqual([got.source, got.allowed], ['unknown', false], `${a.case}: accounts did not answer, nothing is kept`);
        assert.equal(lastKnown(db, ws), null);
      }
    }
    // An access the contract does not list yet is still an answer: allowed decides.
    fake.entitlement(99, { status: 200, body: { workspace: 99, product: 'teder', enabled: true, access: 'trial', allowed: true, paidThrough: null, cancelAt: null, graceUntil: null } });
    assert.deepEqual([(await entitlementClient({ db, env: fake.env, clock: () => t }).check(99, { live: true })).allowed, lastKnown(db, 99).plan], [true, null]);
  } finally {
    await fake.close();
    cleanup();
  }
});

test("a workspace's accounts share one month of its plan; the operator's own account has its own; adding them up counts the shared one once", () => {
  const { db, ctx, cleanup } = three();
  try {
    setNow(OCT);
    paidWorkspaces(db, [1], { plan: { name: 'small', slideshows: 15, redos: 4 } });
    for (let i = 0; i < 9; i++) post(db, 'alpha');
    for (let i = 0; i < 5; i++) post(db, 'bravo');
    post(db, 'bravo', { quota_kind: 'redo' });
    post(db, 'loose');
    const a = usage(db, 'alpha');
    const b = usage(db, 'bravo');
    assert.deepEqual([a.suggested.used, a.suggested.limit, a.suggested.left, a.redos.used, a.redos.limit], [14, 15, 1, 1, 4], "alpha's and bravo's together, against the small plan");
    assert.deepEqual([b.suggested.used, b.suggested.left], [14, 1], 'the same month seen from bravo');
    assert.deepEqual(a.accounts, { alpha: { suggested: 9, redos: 0 }, bravo: { suggested: 5, redos: 1 } });
    assert.equal(a.shared, true);
    assert.deepEqual([a.plan.scope, a.plan.name, a.plan.workspaceId], ['workspace', 'small', 1]);
    const l = usage(db, 'loose');
    assert.deepEqual([l.suggested.used, l.suggested.limit, l.shared, l.plan.scope], [1, 40, false, 'account']);
    assert.deepEqual(monthsOf(db, ['alpha', 'bravo', 'loose']), { used: 15, limit: 55 }, 'the workspace once, and the loose account');

    // One more suggestion, from either account, uses the month up for both.
    assert.equal(room(db, 'bravo').ok, true);
    post(db, 'bravo');
    assert.equal(room(db, 'alpha').ok, false);
    assert.match(room(db, 'alpha').why, /used up \(15 of 15\)/);

    // Each running account's schedule is thinned to its share of the month; the loose one to its own.
    db.run("UPDATE accounts SET status = 'active' WHERE id IN ('alpha', 'bravo')");
    assert.deepEqual([monthShare(db, 'alpha'), monthShare(db, 'bravo'), monthShare(db, 'loose')], [8, 8, 40]);
    db.run("UPDATE accounts SET status = 'onboarding' WHERE id = 'bravo'");
    assert.equal(monthShare(db, 'alpha'), 15, 'an account still in onboarding does not take a share yet');

    // The operator's numbers are for the operator's own accounts; a customer's plan comes from accounts.
    assert.deepEqual(setPlan(db, 'alpha', { suggested: '99' }).problems, ['workspace']);
    assert.throws(() => setQuota(ctx, owner, { id: 'alpha' }, { suggested: '99' }), (e) => e.status === 409 && /במנוי שלו ב-accounts/.test(e.message));
    assert.equal(setQuota(ctx, owner, { id: 'loose' }, { suggested: '12' }).ok, true);
    assert.equal(planOf(db, 'loose').suggested, 12);
  } finally {
    cleanup();
  }
});

test("the customer's Settings shows the month once, with each account's count; the account page says it is the accounts' together", () => {
  const { db, ctx, cleanup } = three();
  try {
    setNow(OCT);
    paidWorkspaces(db, [1], { plan: { name: 'small', slideshows: 15, redos: 4 } });
    for (let i = 0; i < 3; i++) post(db, 'alpha');
    post(db, 'bravo');
    const w = forWorkspace(ctx, 1);
    const pc = { csrf: 'x', user: { name: 'owner' }, operator: false, workspace: { id: 1, name: 'W' }, links: {} };
    const settings = settingsPage(pc, settingsData(w));
    assert.match(settings, /אתם בחבילה הקטנה\. כל חודש מגיעות אליכם 15 הצעות לפוסטים, ו-4 החלפות לפוסטים שדחיתם\. הן משותפות לכל החשבונות שלכם/);
    assert.equal((settings.match(/נוצלו 4 מתוך 15 הצעות/g) || []).length, 1, 'the month once');
    assert.match(settings, /3 הצעות · 0 החלפות/);
    assert.match(settings, /1 הצעות · 0 החלפות/);
    const accounts = accountsPage(pc, accountRows(w).map((r) => ({ ...r, week: week(w, r.pack.id), style: null })));
    assert.match(accounts, /לכל החשבונות שלכם יחד\. בחשבון הזה 3 הצעות החודש\./);
    assert.match(accounts, /לכל החשבונות שלכם יחד\. בחשבון הזה הצעה אחת החודש\./);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ the look */

test("a new account's look is kept apart from its own workspace's only, and the pool never runs out", () => {
  const look = (template, variant, display, extra = {}) => ({ id: extra.id, meta: { id: extra.id }, theme: { template, variant, fonts: { display }, colors: { bg: '#EEF1E4', accent: '#B4512A' } } });
  // Workspace 7 uses three looks; another workspace uses every face but one.
  const mine = [look('editorial', 'a', 'Suez One', { id: 'm1' }), look('poster', 'a', 'Rubik', { id: 'm2' }), look('bubble', 'a', 'Heebo', { id: 'm3' })];
  const others = DISPLAY_FACES.slice(0, -1).map((f, i) => look(ALL_LOOKS[i].template, ALL_LOOKS[i].variant, f, { id: `o${i}` }));
  const groups = new Map([...mine.map((p) => [p, 'ws:7']), ...others.map((p) => [p, 'ws:8'])]);
  const groupOf = (p) => groups.get(p);
  const t = newTheme([...mine, ...others], { groupOf, group: 'ws:7' });
  assert.ok(!mine.some((p) => p.theme.fonts.display === t.fonts.display), 'a face its own accounts do not use');
  assert.ok(!mine.some((p) => `${p.theme.template}/${p.theme.variant}` === `${t.template}/${t.variant}`));

  // A workspace that already uses every face and every look gets the least used, never an error.
  const full = DISPLAY_FACES.map((f, i) => look(ALL_LOOKS[i].template, ALL_LOOKS[i].variant, f, { id: `f${i}` }));
  const t2 = newTheme(full, { groupOf: () => 'ws:9', group: 'ws:9' });
  assert.ok(DISPLAY_FACES.includes(t2.fonts.display));
  const t3 = newTheme([...ALL_LOOKS.map((l, i) => look(l.template, l.variant, DISPLAY_FACES[i % DISPLAY_FACES.length], { id: `l${i}` }))], { groupOf: () => 'own', group: 'own' });
  assert.ok(ALL_LOOKS.some((l) => l.template === t3.template && l.variant === t3.variant), 'a look, even with every one taken');

  // Validation: the same look in two workspaces is two businesses; in one, it is one brand repeated.
  const a = readPack(DEMO);
  const b = structuredClone(a);
  b.meta.id = 'other';
  b.meta.handle = 'other.handle';
  b.meta.displayName = 'חשבון אחר';
  b.id = 'other';
  const apart = validateAll([a, b], { groupOf: (p) => (p === a ? 'ws:1' : 'ws:2') });
  assert.deepEqual(apart, [], 'two customers may share a template, a face and a palette');
  assert.match(validateAll([a, b], { groupOf: () => 'ws:1' }).join('\n'), /same visual template[\s\S]*same display font/);
  const same = structuredClone(b);
  same.meta.handle = a.meta.handle;
  assert.match(validateAll([a, same], { groupOf: (p) => (p === a ? 'ws:1' : 'ws:2') }).join('\n'), /same handle/, 'a handle names one account everywhere');
});

test("onboarding writes a customer's pack in a look another customer has, and the engine loads them both", async () => {
  const { db, ctx, home, cleanup } = three();
  try {
    // Workspace 2's first account: alpha's look (workspace 1) is free for it.
    const made = await createPack(ctx, {
      seed: { niche: 'גינון בעציצים', audience: 'מי שגר בדירה', topics: [] },
      candidates: [{ id: 'c1', type: 'api', url: 'https://query.wikidata.org/sparql', name: 'Wikidata', why: 'Structured, sourced facts under CC0.', approved: true, api: { kind: 'wikidata-sparql', query: 'SELECT 1' } }],
      displayName: 'עציצים בדירה',
      handle: 'pots.flat',
      workspaceId: 2,
    });
    db.insert('accounts', { id: made.id, display_name: 'עציצים בדירה', handle: made.pack.meta.handle, mode: 'approve', status: 'onboarding', workspace_id: 2, created_at: 'x', updated_at: 'x' });
    const theme = made.pack.theme;
    assert.ok(theme.template && theme.fonts.display);
    const all = ctx.reloadPacks();
    assert.equal(all.length, 4, 'every pack loads: the look is kept apart per workspace');
    assert.ok(existsSync(path.join(home, 'packs', made.id, 'pack.json')));
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ the backup */

test('the nightly backup copies the database and the packs, checks the copy, and keeps the newest of each', () => {
  const { home, cleanup } = tempHome();
  const env = { OF_HOME: home };
  try {
    const db = new Db(path.join(home, 'data', 'openfrequency.db'));
    db.insert('accounts', { id: 'demo', display_name: 'd', handle: 'd', mode: 'approve', status: 'active', created_at: 'x', updated_at: 'x' });
    db.raw.close();
    mkdirSync(path.join(home, 'packs', 'demo', 'facts'), { recursive: true });
    writeFileSync(path.join(home, 'packs', 'demo', 'facts', 'checked.json'), '{"facts":[]}');
    const outs = [];
    for (let i = 0; i < 3; i++) {
      outs.push(backup({ keep: 2, env }));
      // Distinct stamps.
      const until = Date.now() + 5;
      while (Date.now() < until);
    }
    const last = outs.at(-1);
    assert.equal(last.check.ok, true);
    assert.deepEqual([last.check.accounts, last.check.posts], [1, 0]);
    assert.ok(existsSync(path.join(last.packs, 'demo', 'pack.json')));
    assert.ok(existsSync(path.join(last.packs, 'demo', 'facts', 'checked.json')), "the facts the customer checked by hand");
    const dir = path.join(home, 'data', 'backups');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.db')).length, 2);
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('packs-')).length, 2);
    // A copy that is not a whole database fails the check.
    const junk = path.join(dir, 'junk.db');
    writeFileSync(junk, 'not a database at all, only some bytes that are not SQLite');
    assert.equal(verifyCopy(junk).ok, false);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ retention */

test('retention: a demo six months past its last contact goes with its opens and pictures; a recent one, or one still opened, stays', async () => {
  const { db, ctx, home, cleanup } = three();
  try {
    const t = Date.parse('2026-10-29T08:00:00Z');
    const add = (domain, updated, opened = null) => {
      const id = db.insert('demos', { slug: `${domain}-x`, url: `https://${domain}`, domain, whatsapp: '972501234567', status: 'approved', created_at: updated, updated_at: updated });
      if (opened) db.insert('demo_opens', { demo_id: id, visitor: 'v', at: opened });
      mkdirSync(path.join(ctx.mediaDir, 'demos', String(id)), { recursive: true });
      writeFileSync(path.join(ctx.mediaDir, 'demos', String(id), 'logo.png'), 'x');
      return id;
    };
    const old = add('old.example', '2026-04-01T00:00:00Z');
    const fresh = add('fresh.example', '2026-09-01T00:00:00Z');
    const opened = add('opened.example', '2026-03-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const out = await retentionPass(ctx, { t });
    assert.equal(out.demos, 1);
    assert.equal(db.get('SELECT id FROM demos WHERE id = ?', old), null);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM demo_opens WHERE demo_id = ?', old).n, 0);
    assert.equal(existsSync(path.join(ctx.mediaDir, 'demos', String(old))), false);
    assert.ok(db.get('SELECT id FROM demos WHERE id = ?', fresh));
    assert.ok(db.get('SELECT id FROM demos WHERE id = ?', opened), 'opened four months ago: still in contact');
    assert.equal(await retentionPass(ctx, { t: t + 3_600_000 }), null, 'once a day');
    assert.ok(home);
  } finally {
    cleanup();
  }
});

test("retention: a workspace whose Teder stopped has its TikTok and Instagram disconnected a day after the stop; a failed removal is tried again until done", async () => {
  const { db, ctx, cleanup } = three();
  const realFetch = globalThis.fetch;
  const calls = [];
  let down = true;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'zernio.com') return realFetch(url, init);
    calls.push(`${(init.method || 'GET').toUpperCase()} ${u.pathname}`);
    return new Response(JSON.stringify(down ? { error: 'down' } : { message: 'deleted' }), { status: down ? 503 : 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  try {
    const t = Date.parse('2026-10-29T08:00:00Z');
    db.update('accounts', 'alpha', { zernio_profile_id: 'prof-alpha' });
    db.insert('zernio_connections', { account_id: 'alpha', platform: 'tiktok', zernio_account_id: 'tk-alpha', username: 'a', status: 'connected', connected_at: 'x', checked_at: 'x' });
    db.insert('zernio_connections', { account_id: 'loose', platform: 'tiktok', zernio_account_id: 'tk-loose', username: 'l', status: 'connected', connected_at: 'x', checked_at: 'x' });
    // Unpaid (accounts' 14 days of grace, `due`, are over) since an hour ago: not yet, a payment recorded late is not punished.
    setSetting(db, 'entitlement:1', { allowed: false, access: 'unpaid', plan: null, stoppedAt: new Date(t - 3_600_000).toISOString(), checkedAt: new Date(t).toISOString() });
    assert.deepEqual(stoppedWorkspaces(db, t), []);
    // Stopped two days ago: the service stopped.
    setSetting(db, 'entitlement:1', { allowed: false, access: 'unpaid', plan: null, stoppedAt: new Date(t - 2 * 86_400_000).toISOString(), checkedAt: new Date(t).toISOString() });
    const out = await retentionPass(ctx, { t });
    assert.deepEqual(out.stopped, [{ workspace: 1, access: 'unpaid', connections: 1 }]);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id = 'alpha'").n, 0, 'forgotten here');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM zernio_connections WHERE account_id = 'loose'").n, 1, "the operator's own account is never touched");
    assert.deepEqual(calls, ['DELETE /api/v1/accounts/tk-alpha'], 'the profile stays: they connect into it again when they pay');
    assert.equal(getSetting(db, REMOVALS).length, 1, 'Zernio was down: kept');
    assert.ok(db.get("SELECT id FROM audit WHERE action = 'connections_removed'"));

    // The next day Zernio answers: done, and the same stop is not disconnected twice.
    down = false;
    const next = await retentionPass(ctx, { t: t + 86_400_000 });
    assert.deepEqual(next.stopped, []);
    assert.deepEqual([next.removals.removed, next.removals.left], [1, 0]);
    assert.deepEqual(getSetting(db, REMOVALS), []);

    // A cancelled workspace is disconnected at the next pass; one that paid again before its removal went keeps it.
    db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
    db.insert('zernio_connections', { account_id: 'bravo', platform: 'instagram', zernio_account_id: 'ig-bravo', username: 'b', status: 'connected', connected_at: 'x', checked_at: 'x' });
    setSetting(db, 'entitlement:2', { allowed: false, access: 'cancelled', plan: null, stoppedAt: new Date(t + 86_400_000).toISOString(), checkedAt: new Date(t).toISOString() });
    assert.deepEqual(stoppedWorkspaces(db, t + 2 * 86_400_000).map((s) => s.workspace), [2]);
    queueRemovals(db, [{ kind: 'account', id: 'tk-back', account: 'alpha', workspace: 1, reason: 'stopped' }]);
    paidWorkspaces(db, [1]);
    calls.length = 0;
    const third = await retentionPass(ctx, { t: t + 2 * 86_400_000 });
    assert.deepEqual(third.stopped.map((s) => s.workspace), [2]);
    assert.equal(third.removals.dropped, 1, 'workspace 1 paid again: its connection is in use');
    assert.deepEqual(calls, ['DELETE /api/v1/accounts/ig-bravo']);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ZERNIO_API_KEY;
    cleanup();
  }
});

test('retention: the public copies of slides go three days after they were made, unless their post is being published', async () => {
  const { db, ctx, home, cleanup } = three();
  try {
    const t = Date.now();
    const root = path.join(home, 'data', 'public');
    const dir = (name, ageDays) => {
      const d = path.join(root, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, '1.jpg'), 'x');
      const at = (t - ageDays * 86_400_000) / 1000;
      utimesSync(d, at, at);
      return d;
    };
    const out = post(db, 'alpha', { status: 'published' });
    const sending = post(db, 'alpha', { status: 'publishing' });
    const gone = dir(`${out}-0123456789ab`, 4);
    const busy = dir(`${sending}-0123456789ab`, 4);
    const recent = dir(`${out}-ba9876543210`, 1);
    const r = await retentionPass(ctx, { t });
    assert.equal(r.publicCopies, 1);
    assert.deepEqual([existsSync(gone), existsSync(busy), existsSync(recent)], [false, true, true]);
  } finally {
    cleanup();
  }
});
