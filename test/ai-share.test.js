import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { setNow } from '../src/core/clock.js';
import { getSetting, setSetting } from '../src/core/store.js';
import { record } from '../src/budget/ledger.js';
import { tick } from '../src/autonomy/runner.js';
import { canGenerate, canRun } from '../src/autonomy/rails.js';
import { AiStoppedError, buildPost, loadPost, MAX_TOKENS, PausedError } from '../src/pipeline/build.js';
import { askJson, ROLES } from '../src/llm/index.js';
import { entitlementClient, lastKnown, monthlyOfAnswer } from '../src/billing/entitlement.js';
import {
  ALERT_SHARE, AiPausedError, aiShare, aiShareTick, accountAiPaused, alertWords, baseIls, DEFAULT_USD_ILS, LIST_ILS, liftStop, monthUsd, nextMonthHe,
  PAUSED_HE, STOP_SHARE, usdIls, workspaceAiPaused,
} from '../src/billing/ai-share.js';
import { edit, reject } from '../src/web/actions.js';
import { ROUNDS_HE, sampleRoom } from '../src/web/onboarding.js';
import { AI_SHARE_TITLE, aiShareData, aiSharePanel, aiShareRoutes } from '../src/web/ai-share.js';
import { scoped, settingsData, today } from '../src/web/data.js';
import { settingsPage, todayPage } from '../src/web/pages.js';
import { forWorkspace } from '../src/web/workspace.js';
import { nicheInEnglish } from '../src/onboarding/discover.js';
import { writeScenes } from '../src/images/scenes.js';
import { SCREEN_EFFORT, SCREEN_MAX_TOKENS } from '../src/images/safety.js';
import { israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { fakeAccounts, opened, tempHome } from './helpers.js';

// The 30/50 rule (src/billing/ai-share.js; the owner, 2026-11-11: "just make sure there is a cap where if ai costs of an
// account reach 30% of the payment of the customer, we get alerted. them on 50% it stops"), and the models that make the
// AI smart within $0.50 a slideshow (src/llm/index.js; "even if a slideshow gets to 0.5$").
//
// alpha is workspace 1's, bravo workspace 2's, loose is in no workspace (the operator's own). accounts (the fake)
// answers each workspace paid, on the full plan, at 790 ₪ a month before VAT.

let home;
let ctx;
let db;
let fake;
const saved = {};
const MODEL_KEYS = ['MODEL_DRAFT', 'MODEL_REWRITE', 'MODEL_REVIEW', 'MODEL_SCOUT', 'MODEL_RANK', 'MODEL_JUDGE', 'OF_OWN_WORKSPACES', 'USD_ILS', 'OF_TORAN_INTERNAL'];
/** Wednesday 11 November 2026, 10:00 in Israel. */
const NOW = israelInstant('2026-11-11', '10:00').getTime();
const customerUser = { id: 2, name: 'customer', email: 'owner1@example.test', operator: false };
const operatorUser = { id: 1, name: 'owner', email: 'operator@example.test', operator: true };

before(async () => {
  for (const k of MODEL_KEYS) saved[k] = process.env[k];
  for (const k of MODEL_KEYS) delete process.env[k];
  // The operator's alerts go to the log and the settings here, never to a Toran.
  process.env.OF_TORAN_INTERNAL = 'off';
  home = tempHome({
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
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  fake = await fakeAccounts();
});

after(async () => {
  for (const k of MODEL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

beforeEach(() => {
  setNow(NOW);
  db.run('DELETE FROM spend');
  db.run("DELETE FROM settings WHERE key LIKE 'ai-share:%' OR key LIKE 'alert:%' OR key LIKE 'entitlement:%'");
  delete process.env.OF_OWN_WORKSPACES;
  delete process.env.USD_ILS;
});

afterEach(() => setNow(null));

/** accounts' answer for a workspace, as the entitlement client keeps it: paid, its plan, what a month costs (none: an older accounts). */
const paid = (ws, { monthlyIls = 790, plan = { name: 'full', slideshows: 40, redos: 10 } } = {}) =>
  setSetting(db, `entitlement:${ws}`, { allowed: true, access: 'paid', paidThrough: null, cancelAt: null, graceUntil: null, plan, monthlyIls, stoppedAt: null, checkedAt: new Date(NOW).toISOString() });

/** Spend recorded for an account until its workspace stands at `share` of what it pays (at the default rate). */
function bring(ws, account, share) {
  const need = (share * baseIls(db, ws)) / usdIls() - monthUsd(db, ws);
  if (need > 0) record(db, { accountId: account, api: 'claude', model: 'claude-opus-5-5', usd: need, tag: 'test' });
}

/** A model client that answers every call, and the calls it was asked. */
function counting(data = { ok: true }) {
  const calls = [];
  return { calls, llm: { kind: 'claude', backend: 'api', async json(req) { calls.push(req); return { data, usage: { input_tokens: 1000, output_tokens: 200 }, model: req.model, estimated: false }; } } };
}

test('the cost: every row the ledger recorded this Israel month for the workspace\'s accounts, at the dearer of usd and api_usd', () => {
  record(db, { accountId: 'alpha', api: 'claude', usd: 1.25, tag: 'outline' });
  // A call the Claude Code CLI answered on a laptop: nothing spent there, counted at its API price, as the server would pay.
  record(db, { accountId: 'alpha', api: 'claude-cli', usd: 0, apiUsd: 0.5, tag: 'slides' });
  record(db, { accountId: 'alpha', api: 'brave', usd: 0.005, tag: 'onboarding' });
  // Another workspace's, our own account's, no account's: not workspace 1's.
  record(db, { accountId: 'bravo', api: 'claude', usd: 2, tag: 'outline' });
  record(db, { accountId: 'loose', api: 'claude', usd: 5, tag: 'outline' });
  record(db, { accountId: null, api: 'claude', usd: 3, tag: 'onboarding' });
  // The last half hour of October in Israel is October's; the first of November, November's.
  record(db, { accountId: 'alpha', api: 'claude', usd: 7, tag: 'outline', t: Date.parse('2026-10-31T21:30:00Z') });
  record(db, { accountId: 'alpha', api: 'claude', usd: 0.25, tag: 'outline', t: Date.parse('2026-10-31T22:30:00Z') });
  assert.ok(Math.abs(monthUsd(db, 1) - 2.005) < 1e-9, `${monthUsd(db, 1)}`);
  assert.ok(Math.abs(monthUsd(db, 1, Date.parse('2026-10-15T10:00:00Z')) - 7) < 1e-9, "October's month is October's");
  assert.equal(monthUsd(db, 2), 2);
  // Every account of the workspace counts: bravo moved into workspace 1 adds its own.
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'bravo'");
  try {
    assert.ok(Math.abs(monthUsd(db, 1) - 4.005) < 1e-9);
  } finally {
    db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  }
  // In shekels at USD_ILS, against what the workspace pays.
  paid(1);
  const a = aiShare(db, 1);
  assert.deepEqual([a.month, a.base, a.rate], ['2026-11', 790, DEFAULT_USD_ILS]);
  assert.ok(Math.abs(a.ils - 2.005 * 3.17) < 1e-9 && Math.abs(a.share - (2.005 * 3.17) / 790) < 1e-12);
  assert.equal(a.stopped, false);
});

test('the base: what accounts says a month costs before VAT; without it the plan list price; the rate from USD_ILS', () => {
  paid(1, { monthlyIls: 500 });
  assert.equal(baseIls(db, 1), 500, 'a price agreed with VAT, as accounts gives it: without the VAT');
  paid(1, { monthlyIls: null, plan: { name: 'small', slideshows: 15, redos: 4 } });
  assert.equal(baseIls(db, 1), LIST_ILS.small, 'an older accounts: the plan list price');
  paid(1, { monthlyIls: null, plan: { name: 'huge', slideshows: 99, redos: 9 } });
  assert.equal(baseIls(db, 1), LIST_ILS.full, 'a plan not known here: the full one');
  db.run("DELETE FROM settings WHERE key = 'entitlement:1'");
  assert.equal(baseIls(db, 1), 790, 'no answer at all: the full plan');
  // What the client keeps of an answer: a price above 0, to the agora; anything else is none.
  for (const [v, want] of [[790, 790], [489.999, 490], [0, null], [-5, null], ['790', null], [Number.NaN, null], [2e6, null], [undefined, null]]) assert.equal(monthlyOfAnswer({ monthlyIls: v }), want, String(v));
  assert.equal(usdIls({}), 3.17, 'the Bank of Israel rate on 2026-11-11');
  assert.equal(usdIls({ USD_ILS: '3.6' }), 3.6);
  for (const junk of ['', 'abc', '0', '-3', '317', ' ']) assert.equal(usdIls({ USD_ILS: junk }), 3.17, `"${junk}"`);
  assert.deepEqual([ALERT_SHARE, STOP_SHARE], [0.3, 0.5], "the owner's two lines");
});

test("the entitlement client keeps accounts' monthlyIls, and an answer without it keeps none", async () => {
  const client = entitlementClient({ db, env: fake.env, clock: () => NOW });
  fake.entitlement(11, { access: 'paid', monthlyIls: 500 });
  await client.check(11, { live: true });
  assert.equal(lastKnown(db, 11).monthlyIls, 500);
  assert.equal(baseIls(db, 11), 500);
  fake.entitlement(12, { access: 'paid', monthlyIls: undefined });
  await client.check(12, { live: true });
  assert.equal(lastKnown(db, 12).monthlyIls, null, 'the older answer: none kept');
  assert.equal(baseIls(db, 12), 790, 'and the plan list price stands');
});

test('30% tells the operator once that month, in Hebrew: who, the cost in ₪ and $, the share, the month; 50% stops, said once', async () => {
  paid(1);
  paid(2);
  const said = [];
  const alert = async (_c, key, words, opts) => said.push({ key, ...words, every: opts.every });
  bring(1, 'alpha', 0.29);
  assert.deepEqual(await aiShareTick(ctx, { t: NOW, alert }), [], 'under 30%: nothing');
  bring(1, 'alpha', 0.31);
  const first = await aiShareTick(ctx, { t: NOW, alert });
  assert.deepEqual(first.map((x) => [x.workspace, x.said]), [[1, 'alert']]);
  assert.equal(said.length, 1);
  assert.equal(said[0].key, 'ai-share-30:1:2026-11');
  assert.equal(said[0].title, 'תדר: עלות ה-AI של לקוח הגיעה ל-31% ממה שהוא משלם');
  assert.match(said[0].body, /^סביבת עבודה 1 \(.+\)\. בנובמבר 2026 עלה לנו עד עכשיו 245 ₪ \(77\.26 דולר\), 31% מ-790 ₪ שהוא משלם לחודש לפני מע״מ\. ב-50% אני עוצר לו את ה-AI עד סוף החודש\.$/);
  assert.ok(said[0].every <= 43_200 * 60_000, "within what Toran's contract takes (43,200 minutes)");
  assert.doesNotMatch(`${said[0].title} ${said[0].body}`, /—|–/, 'no dashes as breaks');
  assert.deepEqual(await aiShareTick(ctx, { t: NOW + 60_000, alert }), [], 'once a month');
  assert.equal(workspaceAiPaused(db, 1), false, 'an alert stops nothing');

  bring(1, 'alpha', 0.5);
  const stop = await aiShareTick(ctx, { t: NOW + 120_000, alert });
  assert.deepEqual(stop.map((x) => [x.workspace, x.said]), [[1, 'stop']]);
  assert.equal(said[1].key, 'ai-share-50:1:2026-11');
  assert.equal(said[1].title, 'תדר: עצרתי את ה-AI של לקוח, העלות הגיעה ל-50% ממה שהוא משלם');
  assert.match(said[1].body, /50% מ-790 ₪ שהוא משלם לחודש לפני מע״מ\. עד 1\.12\.2026 לא נכתב לו שום דבר חדש, ומה שכבר אושר עולה כרגיל\. אפשר לפתוח לו עד סוף החודש בהגדרות של תדר, במצב מפתח\.$/);
  assert.deepEqual(await aiShareTick(ctx, { t: NOW + 180_000, alert }), [], 'the stop is said once too');
  assert.equal(workspaceAiPaused(db, 1), true);
  assert.equal(workspaceAiPaused(db, 2), false, 'another workspace goes on');
  assert.deepEqual(db.all("SELECT action FROM audit WHERE action IN ('ai_alert', 'ai_stopped') ORDER BY id").map((r) => r.action), ['ai_alert', 'ai_stopped']);

  // A workspace that goes past both lines between two passes hears the stop alone.
  bring(2, 'bravo', 0.7);
  const jump = await aiShareTick(ctx, { t: NOW + 240_000, alert });
  assert.deepEqual(jump.map((x) => [x.workspace, x.said]), [[2, 'stop']]);
  assert.deepEqual(await aiShareTick(ctx, { t: NOW + 300_000, alert }), []);

  // The real alert: kept for the operator's table on /all, in the log, under the key with the month.
  db.run("DELETE FROM settings WHERE key LIKE 'ai-share:%'");
  const logged = [];
  await aiShareTick({ ...ctx, log: (m) => logged.push(m) }, { t: NOW + 360_000 });
  assert.ok(getSetting(db, 'alert:ai-share-50:1:2026-11', null)?.title.startsWith('תדר: עצרתי'), 'kept for /all');
  assert.ok(logged.some((m) => m.startsWith('[alert] תדר: עצרתי את ה-AI של לקוח')));
  assert.equal(nextMonthHe('2026-12'), '1.1.2027');
});

test('the words name the customer by its accounts, cut short past three, and never round a share up to a line', () => {
  paid(1);
  bring(1, 'alpha', 0.4996);
  const a = aiShare(db, 1);
  const w = alertWords(db, a, 'alert');
  assert.match(w.title, /ל-49% ממה שהוא משלם$/, '49.96% is 49%');
  const name = db.get("SELECT display_name FROM accounts WHERE id = 'alpha'").display_name;
  assert.ok(w.body.startsWith(`סביבת עבודה 1 (${name}). `));
  assert.ok(w.title.length <= 200, "Toran's title is 200 characters at most");
});

test('at 50% nothing new is drafted for the workspace, quietly, and what is approved still goes out', async () => {
  const tue = (hm) => israelInstant('2026-11-10', hm).getTime();
  setNow(tue('06:00'));
  ctx.entitlements = entitlementClient({ db, env: fake.env, clock: () => Date.now() });
  try {
    await ctx.entitlements.check(1, { live: true });
    await ctx.entitlements.check(2, { live: true });
    assert.equal(lastKnown(db, 1).monthlyIls, 790, "accounts' answer has what a month costs");
    // Before the stop: a post of alpha's approved for 12:40, and one waiting for the customer at 18:00.
    const out = (await buildPost(ctx, { pack: ctx.pack('alpha'), formatKey: 'care-guide' })).postId;
    db.run("UPDATE posts SET status = 'approved', approved_by = 'owner', slot_at = ? WHERE id = ?", new Date(tue('12:40')).toISOString(), out);
    const waiting = 'p-ai-waiting';
    const at = new Date(tue('05:00')).toISOString();
    db.insert('posts', { id: waiting, account_id: 'alpha', status: 'queued', slot_at: new Date(tue('18:00')).toISOString(), hook: 'מחכה', created_at: at, updated_at: at });
    const editing = out;
    bring(1, 'alpha', 0.55);
    assert.equal(accountAiPaused(db, 'alpha'), true);

    // The rails: alpha may publish, and may not write.
    assert.equal(canRun(db, 'alpha').ok, true, 'publishing asks canRun: it runs');
    assert.deepEqual(canGenerate(db, 'alpha'), { ok: false, why: PAUSED_HE.title, code: 'ai_paused' });
    for (const id of ['bravo', 'loose']) assert.equal(canGenerate(db, id).ok, true, id);

    // buildPost refuses before it spends, a sample too: quietly, as a pause.
    const posts = () => db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'alpha'").n;
    const rows = () => db.get('SELECT COUNT(*) AS n FROM spend').n;
    const [p0, s0] = [posts(), rows()];
    for (const sample of [false, true]) {
      await assert.rejects(buildPost(ctx, { pack: ctx.pack('alpha'), sample }), (e) => e instanceof AiStoppedError && e instanceof PausedError && e.code === 'ai_paused' && e.message === PAUSED_HE.title);
    }
    assert.deepEqual([posts(), rows()], [p0, s0], 'no post, nothing spent');

    // The backstop: any call left for the account is refused before the model is asked.
    const { calls, llm } = counting();
    const req = { task: 'outline', role: 'draft', system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 100 };
    await assert.rejects(askJson({ db, pack: ctx.pack('alpha'), postId: null, llm }, req), (e) => e instanceof AiPausedError && e.code === 'ai_paused');
    assert.equal(calls.length, 0);
    assert.equal(rows(), s0, 'nothing recorded');
    await askJson({ db, pack: ctx.pack('bravo'), postId: null, llm }, req);
    await askJson({ db, pack: ctx.pack('loose'), postId: null, llm }, req);
    await askJson({ db, pack: null, postId: null, llm }, req);
    assert.equal(calls.length, 3, 'another workspace, our own account and no account are answered');

    // The day's drafting: nothing for alpha, the others as every day.
    setNow(tue('07:05'));
    const r = await tick(ctx, { t: tue('07:05') });
    const by = (id) => r.generated.filter((g) => g.account === id).length;
    assert.equal(by('alpha'), 0, 'stopped: nothing drafted');
    assert.ok(by('loose') > 0, "the operator's own account goes on");
    assert.ok(by('bravo') > 0, 'another customer goes on');
    assert.equal(r.errors.filter((e) => e.account === 'alpha').length, 0, 'quietly: no error for it');
    assert.ok(!getSetting(db, `topics:alpha:2026-11-10`), 'its topics are not scored either');

    // A rejection while stopped: nothing written instead, the redo not used.
    const res = reject(ctx, customerUser, { id: waiting }, { reason: 'tone', redo: '1' });
    assert.match(res.message, /^נדחה\. הכתיבה בחשבון עצורה כרגע, אז לא נכתב פוסט במקומו וההחלפה לא ירדה מהמכסה\./);
    assert.equal(loadPost(db, waiting).reject?.redo, 'paused');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = 'alpha' AND status = 'drafting'").n, 0);

    // A light edit of a text: refused calmly, before the model is asked, nothing saved.
    const p = loadPost(db, editing);
    const form = { hook: p.hook, sub: p.sub || '', caption: p.caption, caption_short: p.data?.captionShort || '' };
    p.slides.filter((s) => s.kind === 'item').forEach((s, i) => Object.assign(form, { [`title_${i}`]: s.title, [`body_${i}`]: s.body }));
    const changed = { ...form, title_0: `${form.title_0} ממש` };
    const { calls: asked, llm: reviewer } = counting({ reviews: [] });
    await assert.rejects(edit({ ...ctx, llm: reviewer, workspaceId: 1 }, customerUser, { id: editing }, changed), (e) => e.status === 409 && e.message === PAUSED_HE.edit);
    assert.equal(asked.length, 0);
    assert.equal(loadPost(db, editing).slides.find((s) => s.kind === 'item').title, form.title_0, 'the text stays as it was');

    // A new account's samples: refused, with the calm line.
    assert.deepEqual(sampleRoom(db, { status: 'samples', workspace_id: 1, found: {} }), { ok: false, why: 'paused' });
    assert.equal(ROUNDS_HE.paused, PAUSED_HE.setup);

    // What is approved still goes out at its time.
    setNow(tue('12:45'));
    const r2 = await tick(ctx, { t: tue('12:45') });
    assert.deepEqual(r2.published.filter((x) => x.account === 'alpha').map((x) => x.post), [out]);
    assert.equal(loadPost(db, out).status, 'published');
  } finally {
    delete ctx.entitlements;
  }
});

test("the customer reads one calm line on Today while it lasts, with no cost and no share; the operator in developer mode reads why", () => {
  paid(1);
  paid(2);
  bring(1, 'alpha', 0.6);
  const w1 = forWorkspace(ctx, 1);
  const pc = { csrf: 'x', user: { name: 'owner' }, operator: false, workspace: { id: 1, name: 'W' }, links: {} };
  const html = todayPage(pc, today(scoped(w1, w1.pack('alpha'))));
  const line = html.match(/<div class="banner info" id="ai-paused">[\s\S]*?<\/div><\/div>/)?.[0];
  assert.ok(line, 'the line is there');
  assert.ok(line.includes(`<b>${PAUSED_HE.title}</b><p>${PAUSED_HE.text}</p>`));
  assert.doesNotMatch(line, /%|₪|\$|AI|דולר/, 'no cost, no share');
  assert.equal((html.match(/id="ai-paused"/g) || []).length, 1, 'once');
  const w2 = forWorkspace(ctx, 2);
  assert.doesNotMatch(todayPage({ ...pc, workspace: { id: 2, name: 'B' } }, today(scoped(w2, w2.pack('bravo')))), /id="ai-paused"/, 'not on another customer');
  // The operator in developer mode: which account, why, and where to let it go on.
  const dev = todayPage({ ...pc, operator: true, costs: true, workspace: null }, today(scoped(ctx, ctx.pack('alpha'))));
  assert.match(dev, /<div class="banner warn" id="ai-paused">.*: כרגע לא נכתבות מצגות חדשות\.<\/b><p>עלות ה-AI החודש הגיעה לחצי ממה שהלקוח משלם\. <a href="\/settings#ai-share">/);
  // The texts keep to the voice: no dashes as breaks, no exclamation marks.
  for (const s of Object.values(PAUSED_HE)) assert.doesNotMatch(s, /—|–|!/, s);
});

test('the lift: the operator lets it go on for the rest of the month, audited; nobody else can; the next month starts clean', async () => {
  paid(1);
  paid(2);
  bring(1, 'alpha', 0.6);
  bring(2, 'bravo', 0.1);
  const said = [];
  const alert = async (_c, key) => said.push(key);
  await aiShareTick(ctx, { t: NOW, alert });
  assert.deepEqual(said, ['ai-share-50:1:2026-11']);

  // The panel, in developer mode: each customer, what it cost and pays, the share, and the button for the stopped one.
  const d = aiShareData(db);
  const panel = aiSharePanel({ csrf: 'x' }, d);
  assert.match(panel, new RegExp(`<h2>${AI_SHARE_TITLE}</h2>`));
  assert.match(panel, /action="\/settings\/ai-share\/1\/lift"/);
  assert.doesNotMatch(panel, /action="\/settings\/ai-share\/2\/lift"/, 'nothing to lift under the line');
  assert.match(panel, /<span class="chip bad">עצור<\/span>/);
  assert.match(panel, /60%<\/td>/);
  assert.match(panel, /474 ₪ <span class="muted small">\(<span class="num ltr">\$149\.53<\/span>\)<\/span>/);
  assert.match(panel, /דולר אחד: 3\.17 ₪/);
  const sd = settingsData(scoped(ctx, ctx.pack('loose')));
  assert.equal(sd.aiShare.rows.length, 2, "the operator's data has every customer");
  const operatorPc = { csrf: 'x', user: { name: 'owner', email: 'operator@example.test' }, operator: true, links: {} };
  assert.match(settingsPage({ ...operatorPc, costs: true, dev: true }, sd), /id="ai-share"/);
  assert.doesNotMatch(settingsPage(operatorPc, sd), /id="ai-share"/, 'developer mode only, as every cost');
  const w1 = forWorkspace(ctx, 1);
  assert.equal(settingsData(scoped(w1, w1.pack('alpha'))).aiShare, null, "never a customer's");

  // The route: the operator's alone; a workspace that is not stopped has nothing to lift.
  const [[method, re, lift]] = aiShareRoutes();
  assert.equal(method, 'POST');
  const m = re.exec('/settings/ai-share/1/lift');
  assert.throws(() => lift(ctx, customerUser, m), (e) => e.status === 403);
  assert.equal(workspaceAiPaused(db, 1), true, 'a customer lifted nothing');
  assert.throws(() => lift(ctx, operatorUser, re.exec('/settings/ai-share/2/lift')), (e) => e.status === 409);
  const r = lift(ctx, operatorUser, m);
  assert.deepEqual([r.ok, r.redirect], [true, '/settings#ai-share']);
  assert.equal(r.message, 'נפתח. עד סוף החודש תדר כותב ללקוח הזה כרגיל.');
  const a = aiShare(db, 1);
  assert.deepEqual([a.stopped, a.liftedBy, Boolean(a.liftedAt)], [false, 'operator@example.test', true]);
  assert.equal(canGenerate(db, 'alpha').ok, true, 'it writes again');
  const row = db.get("SELECT * FROM audit WHERE action = 'ai_stop_lifted'");
  assert.equal(row.actor, 'operator@example.test');
  assert.deepEqual(JSON.parse(row.detail_json).workspace, 1);
  assert.deepEqual(liftStop(db, 1, { by: 'x' }), { lifted: false, why: 'not_stopped' }, 'lifted once');
  assert.match(aiSharePanel({ csrf: 'x' }, aiShareData(db)), /<span class="chip warn">נפתח ידנית<\/span> <span class="muted small">operator@example\.test/);
  // More spend after the lift: no stop, and nothing said again this month.
  bring(1, 'alpha', 0.9);
  assert.equal(workspaceAiPaused(db, 1), false);
  assert.deepEqual(await aiShareTick(ctx, { t: NOW + 60_000, alert }), []);

  // The month rolls over: none of November's alert, stop or lift is December's.
  const dec = israelInstant('2026-12-01', '00:30').getTime();
  setNow(dec);
  const fresh = aiShare(db, 1);
  assert.deepEqual([fresh.month, fresh.usd, fresh.stopped, fresh.alertedAt, fresh.liftedAt], ['2026-12', 0, false, null, null]);
  bring(1, 'alpha', 0.5);
  assert.equal(workspaceAiPaused(db, 1), true, 'stopped again in December, the lift was November\'s');
  await aiShareTick(ctx, { t: dec, alert });
  assert.deepEqual(said.slice(1), ['ai-share-50:1:2026-12'], 'and said again, under December');
});

test("the company's own workspaces and accounts in no workspace are never weighed", async () => {
  paid(1);
  process.env.OF_OWN_WORKSPACES = '1';
  bring(1, 'alpha', 5);
  record(db, { accountId: 'loose', api: 'claude', usd: 10_000, tag: 'test' });
  assert.equal(aiShare(db, 1).share > 4, true, 'weighed for the panel, as numbers');
  assert.equal(workspaceAiPaused(db, 1), false, 'ours: never stopped');
  assert.equal(accountAiPaused(db, 'alpha'), false);
  assert.equal(accountAiPaused(db, 'loose'), false, 'no workspace: never stopped');
  assert.equal(canGenerate(db, 'alpha').ok, true);
  const said = [];
  assert.deepEqual(await aiShareTick(ctx, { t: NOW, alert: async (_c, key) => said.push(key) }), []);
  assert.deepEqual(said, []);
  assert.ok(!aiShareData(db).rows.some((r) => r.workspace === 1), 'not on the panel of customers');
  const { calls, llm } = counting();
  await askJson({ db, pack: ctx.pack('alpha'), postId: null, llm }, { task: 't', system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 10 });
  assert.equal(calls.length, 1);
});

test('the models: Opus writes, rewrites, reviews and scouts; Sonnet ranks; Haiku judges, the screen at medium effort', async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ROLES).map(([k, f]) => [k, f()])), {
    draft: 'claude-opus-5-5', rewrite: 'claude-opus-5-5', review: 'claude-opus-5-5', scout: 'claude-opus-5-5', rank: 'claude-sonnet-5-5', judge: 'claude-haiku-5-5',
  });
  // Each one is .env's to change; the rewrite follows the writer unless it has its own.
  process.env.MODEL_DRAFT = 'claude-sonnet-5-5';
  try {
    assert.deepEqual([ROLES.draft(), ROLES.rewrite(), ROLES.review()], ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    process.env.MODEL_REWRITE = 'claude-haiku-5-5';
    assert.equal(ROLES.rewrite(), 'claude-haiku-5-5');
  } finally {
    delete process.env.MODEL_DRAFT;
    delete process.env.MODEL_REWRITE;
  }
  // The calls go to their roles' models: a new account's niche in English and its scenes are the scout's.
  const { calls, llm } = counting({ en: 'balcony gardening', scenes: ['potted plants', 'balcony railing', 'garden soil', 'watering can'] });
  const c = { db, llm, pack: null, postId: null, log: () => {} };
  assert.equal(await nicheInEnglish(c, 'גינון במרפסת'), 'balcony gardening');
  await writeScenes(c, { niche: 'גינון במרפסת', displayName: 'מרפסת' });
  assert.deepEqual(calls.map((x) => [x.task, x.model]), [['niche_en', 'claude-opus-5-5'], ['scenes', 'claude-opus-5-5']]);
  assert.deepEqual([SCREEN_EFFORT, SCREEN_MAX_TOKENS], ['medium', 3000], 'room to think through the screen');
  assert.deepEqual([MAX_TOKENS.slides, MAX_TOKENS.repair], [12_000, 6_000], 'room for Opus to think');
});
