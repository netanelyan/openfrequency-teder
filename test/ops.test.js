import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { nothingDrafted, redraftBlocked, REDRAFT_LEAD_MS, startRunner, tick } from '../src/autonomy/runner.js';
import { readiness, BEAT_MS, STUCK_MS, workspaceHealth } from '../src/web/health.js';
import { alertOperator, recentAlerts } from '../src/notify/operator.js';
import { closeBrowser, renderSlot, RENDER_SLOTS } from '../src/render/render.js';
import { DEFAULT_CHOICE, defaultChoiceFor, STAGGER_MIN } from '../src/schedule/choice.js';
import { monthSlots } from '../src/schedule/slots.js';
import { israelInstant } from '../src/schedule/israel.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { nowIso } from '../src/core/clock.js';
import { customer, fakeAccounts, operator, opened, paidWorkspaces, tempHome } from './helpers.js';

// Running Teder: is it ready (/readyz), which build is it (/healthz), does a tick publish before it starts the slow
// work, are renders queued, is a blocked slot drafted again the same day, does the operator hear of an account that
// drafted nothing, and do new accounts post on minutes of their own. The operator's health table on /all, and the
// accessibility statement at the foot of the pages with no session.

after(() => closeBrowser());

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  ctx.mediaRoot = home;
  return ctx;
}

const at = (day, hhmm) => israelInstant(day, hhmm).getTime();

/* ------------------------------------------------------------------ the website's two health paths */

let home;
let ctx;
let fake;
let server;
let base;

before(async () => {
  home = tempHome({
    packs: {
      demo: null,
      other: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
    },
  });
  // Not in `opened`: the tests below with homes of their own close everything there when they clean up.
  const db = new Db(path.join(home.home, 'data.db'));
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  ctx.db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  ctx.db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'other'");
  paidWorkspaces(ctx.db, [1]);
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'o'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  await new Promise((r) => (server ? server.close(r) : r()));
  await fake?.close();
  ctx?.db.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

test('/healthz says the process answers, with the commit this build is; /readyz checks the database and the runner', async () => {
  const h = await get('/healthz');
  assert.equal(h.status, 200);
  assert.match(await h.text(), /^ok \S+$/);
  // A website without the runner (a laptop's `npm run web`): the runner is off, which is not a failure.
  let r = await get('/readyz');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).checks, { db: 'ok', runner: 'off' });
  ctx.runnerState = { beatAt: Date.now(), startedAt: Date.now() - 1000, endedAt: Date.now() };
  assert.equal((await get('/readyz')).status, 200);
  ctx.runnerState = { beatAt: Date.now() - BEAT_MS - 5000, startedAt: null, endedAt: null };
  r = await get('/readyz');
  assert.equal(r.status, 503, 'no tick for over two minutes');
  assert.match((await r.json()).checks.runner, /^no tick for \d+ s$/);
  ctx.runnerState = null;
});

test('readiness: a stuck tick and a database that does not answer are not ready', () => {
  const t = Date.now();
  assert.match(readiness({ db: ctx.db, runnerState: { beatAt: t, startedAt: t - STUCK_MS - 60_000, endedAt: t - STUCK_MS - 120_000 } }, { t }).checks.runner, /a tick has run for \d+ min/);
  assert.equal(readiness({ db: ctx.db, runnerState: { beatAt: t, startedAt: t - 60_000, endedAt: null } }, { t }).ok, true, 'a tick a minute long is fine');
  const broken = { get() { throw new Error('disk I/O error'); } };
  const r = readiness({ db: broken, runnerState: null, log: () => {} }, { t });
  assert.deepEqual([r.ok, r.checks.db], [false, 'failed'], 'the error itself goes to the log, not to the page');
});

test('the runner keeps /readyz up to date: a beat when it starts, and each tick started and ended', async () => {
  const { home: h, cleanup } = tempHome();
  try {
    const c = contextFor(h);
    // An account still being set up is left alone by the runner: the tick is quick.
    c.db.run("UPDATE accounts SET status = 'onboarding'");
    const stop = startRunner(c, { everyMs: 60_000 });
    assert.ok(c.runnerState && Date.now() - c.runnerState.beatAt < 5000);
    for (let i = 0; i < 400 && !c.runnerState.endedAt; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(c.runnerState.endedAt >= c.runnerState.startedAt, 'the first tick ran to its end');
    assert.equal(readiness(c).ok, true);
    stop();
    assert.equal(c.runnerState, null);
  } finally {
    cleanup();
  }
});

test("the operator's /all has every workspace's health; a customer's has none of it", async () => {
  const op = fake.session(operator()).cookie;
  const page = await (await get('/all', op)).text();
  assert.match(page, /<h2>מצב הלקוחות<\/h2>/);
  assert.match(page, /עסק <span class="ltr">#1<\/span>/);
  assert.match(page, /עסק <span class="ltr">#2<\/span>/);
  assert.match(page, /<span class="chip ok">שולם<\/span>/, 'workspace 1 has paid');
  const mine = await (await get('/all', fake.session(customer(1)).cookie)).text();
  assert.doesNotMatch(mine, /מצב הלקוחות/);
});

test('the health rows: paid status, failed posts of the week, blocked today, the days since a draft', () => {
  const t = Date.now();
  const old = new Date(t - 3 * 86_400_000).toISOString();
  const now = new Date(t).toISOString();
  const add = (id, status, created, updated = created) => ctx.db.insert('posts', { id, account_id: 'other', status, created_at: created, updated_at: updated, slot_at: null });
  add('h-failed', 'failed', old, now); // drafted three days ago, failed to go out today
  add('h-blocked', 'blocked', now);
  add('h-old', 'queued', old);
  const rows = workspaceHealth(ctx, { t });
  const two = rows.find((r) => r.workspace === 2);
  assert.deepEqual([two.access, two.failed, two.blocked, two.daysSinceDraft], ['unknown', 1, 1, 3]);
  assert.ok(rows.find((r) => r.workspace === 1).allowed);
  ctx.db.run("DELETE FROM posts WHERE id IN ('h-failed', 'h-blocked', 'h-old')");
});

test('the pages with no session link to the accessibility statement', async () => {
  for (const p of ['/s/no-such-store', '/connect/demo/tiktok?e=1&s=00']) {
    const html = await (await get(p)).text();
    assert.match(html, /href="https:\/\/openfrequency\.co\.il\/accessibility">הצהרת הנגישות<\/a>/, p);
  }
  // And every page of the product, at its foot.
  assert.match(await (await get('/', fake.session(customer(1)).cookie)).text(), /<footer class="foot">.*הצהרת הנגישות/s);
});

/* ------------------------------------------------------------------ the tick */

test('a tick publishes what is due before it starts the day\'s drafting', async () => {
  const { home: h, cleanup } = tempHome();
  try {
    const c = contextFor(h);
    await tick(c, { t: at('2026-10-13', '07:05') });
    const wed = c.db.get("SELECT id FROM posts WHERE account_id = 'demo' AND slot_at >= '2026-10-14' ORDER BY slot_at LIMIT 1");
    c.db.run("UPDATE posts SET status = 'approved', approved_by = 'owner' WHERE id = ?", wed.id);
    // Wednesday's drafting is due at 12:50, and the approved post is due too: the post goes first.
    setSetting(c.db, 'generateAt', '12:50');
    setSetting(c.db, 'feedbackAt', '12:45');
    const lastStep = c.db.get('SELECT MAX(id) AS id FROM steps').id;
    const r = await tick(c, { t: at('2026-10-14', '12:55') });
    assert.equal(r.published.length, 1, JSON.stringify(r.errors));
    assert.ok(r.generated.length > 0, 'and the day was drafted in the same tick');
    const publishStep = c.db.get("SELECT MIN(id) AS id FROM steps WHERE post_id = ? AND step = 'publish' AND id > ?", wed.id, lastStep).id;
    const firstNew = c.db.get('SELECT MIN(id) AS id FROM steps WHERE post_id IN (' + r.generated.map(() => '?').join(',') + ')', ...r.generated.map((g) => g.post)).id;
    assert.ok(publishStep < firstNew, `published (step ${publishStep}) before the first draft began (step ${firstNew})`);
  } finally {
    cleanup();
  }
});

test('a blocked slot is drafted again the same day, once, directly, while it is far enough away', async () => {
  const { home: h, cleanup } = tempHome();
  try {
    const c = contextFor(h);
    const t = at('2026-10-13', '09:00');
    const slot = new Date(t + REDRAFT_LEAD_MS + 3_600_000).toISOString();
    const near = new Date(t + REDRAFT_LEAD_MS / 2).toISOString();
    for (const [id, s] of [['b1', slot], ['b2', near]]) c.db.insert('posts', { id, account_id: 'demo', status: 'blocked', reason: 'the model did not answer', slot_at: s, created_at: nowIso(), updated_at: nowIso() });
    // Before the day's generation, nothing: the generation drafts it.
    assert.equal((await redraftBlocked(c, { generated: [], errors: [] }, { t })).redrafted, undefined);
    setSetting(c.db, 'generated:demo:2026-10-13', nowIso());
    const r = await redraftBlocked(c, { generated: [], errors: [] }, { t });
    assert.deepEqual(r.redrafted, [{ account: 'demo', slotAt: slot }], 'the slot an hour and a half away or more; not the one too near');
    assert.equal(r.generated.length, 1, JSON.stringify(r.errors));
    assert.ok(c.db.get("SELECT id FROM posts WHERE account_id = 'demo' AND slot_at = ? AND status NOT IN ('blocked', 'drafting')", slot), 'the slot has a post now');
    c.db.run("UPDATE posts SET status = 'blocked' WHERE slot_at = ?", slot);
    assert.equal((await redraftBlocked(c, { generated: [], errors: [] }, { t })).redrafted, undefined, 'once a slot');
  } finally {
    cleanup();
  }
});

test('an account that drafted nothing in a day is told to the operator, once a day, with why its posts were blocked', async () => {
  const { home: h, cleanup } = tempHome();
  try {
    const c = contextFor(h);
    const logs = [];
    c.log = (m) => logs.push(m);
    const early = at('2026-10-13', '08:00');
    assert.equal((await nothingDrafted(c, {}, { t: early })).alerts, undefined, 'not before four hours after the day is drafted');
    const t = at('2026-10-13', '11:30');
    c.db.insert('posts', { id: 'x1', account_id: 'demo', status: 'blocked', reason: 'the batch was not read', slot_at: new Date(t + 86_400_000).toISOString(), created_at: new Date(t - 3_600_000).toISOString(), updated_at: nowIso() });
    const r = await nothingDrafted(c, {}, { t });
    assert.deepEqual(r.alerts, [{ account: 'demo', kind: 'nothing-drafted' }]);
    assert.match(logs.join('\n'), /\[alert\] Teder: .* drafted nothing in 24 hours: blocked: the batch was not read/);
    assert.equal((await nothingDrafted(c, {}, { t: t + 3_600_000 })).alerts, undefined, 'once a day');
    assert.equal(recentAlerts(c.db, { t }).length, 1, 'kept for the health table');
    // A post that reached the customer is enough.
    c.db.insert('posts', { id: 'x2', account_id: 'demo', status: 'queued', slot_at: new Date(t + 2 * 86_400_000).toISOString(), created_at: new Date(t).toISOString(), updated_at: nowIso() });
    assert.equal((await nothingDrafted(c, {}, { t: t + 86_400_000 })).alerts, undefined);
  } finally {
    cleanup();
  }
});

test("an alert is the server's one alert command, with the title and the body as arguments, never through a shell", async () => {
  const db = ctx.db;
  const runs = [];
  const run = (cmd, args, opts, cb) => (runs.push([cmd, args, opts.timeout]), cb(null));
  const env = { OF_ALERT_CMD: process.execPath };
  assert.equal(await alertOperator({ db, log: () => {} }, 'test-kind', { title: 'Teder: x; rm -rf /', body: '$(whoami)' }, { env, run }), true);
  assert.deepEqual(runs, [[process.execPath, ['Teder: x; rm -rf /', '$(whoami)'], 15_000]]);
  assert.equal(await alertOperator({ db, log: () => {} }, 'test-kind', { title: 'again' }, { env, run }), false, 'once a day per kind');
  assert.equal(runs.length, 1);
  assert.equal(getSetting(db, 'alert:test-kind').title, 'Teder: x; rm -rf /');
});

/* ------------------------------------------------------------------ renders and slots */

test('at most two pages are drawn at once, in the order they asked', async () => {
  assert.equal(RENDER_SLOTS, 2);
  let now = 0;
  let most = 0;
  const order = [];
  const job = (i) => renderSlot(async () => {
    most = Math.max(most, ++now);
    order.push(i);
    await new Promise((r) => setTimeout(r, 15));
    now--;
    return i;
  });
  const done = await Promise.all([0, 1, 2, 3, 4, 5].map(job));
  assert.deepEqual(done, [0, 1, 2, 3, 4, 5]);
  assert.equal(most, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  // A failed render gives its slot back.
  await assert.rejects(renderSlot(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await renderSlot(async () => 'next'), 'next');
});

test("a new account's default times are moved later by its own few minutes, the same for every time, and still reach the plan", () => {
  const shifts = new Set();
  for (const key of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'o10', 'o11', 'o12']) {
    const c = defaultChoiceFor(key);
    assert.deepEqual(defaultChoiceFor(key), c, 'the same account, the same minutes');
    const diff = (a, b) => Number(b.slice(0, 2)) * 60 + Number(b.slice(3)) - (Number(a.slice(0, 2)) * 60 + Number(a.slice(3)));
    const d = new Set(Object.entries(DEFAULT_CHOICE).flatMap(([day, list]) => list.map((x, i) => diff(x, c[day][i]))));
    assert.equal(d.size, 1, `${key}: every time moved alike`);
    const [shift] = d;
    assert.ok(shift >= 0 && shift <= STAGGER_MIN && shift % 5 === 0, `${key}: ${shift} minutes`);
    shifts.add(shift);
    assert.ok(c[6][0] >= '21:00', 'Saturday stays after nightfall');
    assert.equal(monthSlots('2026-11', { slotsByDay: c, postsPerDay: 2, perMonth: 40, chosen: true }).slots.length, 40, `${key}: the plan's 40`);
  }
  assert.ok(shifts.size >= 3, `accounts spread over several minutes (${[...shifts]})`);
});
