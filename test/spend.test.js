import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { setNow } from '../src/core/clock.js';
import { ROOT } from '../src/core/paths.js';
import { claudeCost, MODEL_RATES, monthSpend, WORST } from '../src/budget/ledger.js';
import { askJson } from '../src/llm/index.js';
import { makeBatcher, recoverBatches } from '../src/llm/batch.js';
import { keepOnly, opened, tempHome } from './helpers.js';

// What every call costs is recorded, and nothing refuses a call for money: there is no cap (docs/decisions.md, "The
// budget is gone, the plan is the limit"). The plan's own tests are in quota.test.js.

after(() => closeBrowser());
afterEach(() => setNow(null));

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

/** Usage that bills a call high: every byte of the request a 1-hour cache write, and every output token max_tokens allows. */
const bigUsage = (params) => {
  const bytes = Buffer.byteLength(JSON.stringify(params));
  return { input_tokens: 0, cache_creation_input_tokens: bytes, cache_creation: { ephemeral_1h_input_tokens: bytes, ephemeral_5m_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: params.max_tokens };
};

test('the cost of a call, per model, cache writes and reads, the long-prompt tier and the batch discount included', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  for (const [model, r] of Object.entries(MODEL_RATES)) {
    // Without the 5-minute/1-hour split a cache write is billed at the dearer 1-hour rate.
    const tier = r.long && 3_000_000 > r.long.over ? r.long : r;
    const expect = tier.in + tier.out + tier.write1h + tier.cacheRead;
    assert.ok(Math.abs(claudeCost(usage, model) - expect) < 1e-9, model);
    assert.ok(Math.abs(claudeCost(usage, model, { batch: true }) - expect / 2) < 1e-9, `${model} in a batch`);
  }
  const split = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } };
  assert.ok(Math.abs(claudeCost(split, 'claude-sonnet-5-5') - (2.5 + 4)) < 1e-9, 'the split is billed at each rate');
  assert.equal(claudeCost({ cache_creation_input_tokens: 1e6 }, 'claude-sonnet-5-5'), MODEL_RATES['claude-sonnet-5-5'].write1h);
  assert.ok(Math.abs(claudeCost({ input_tokens: 50_000, output_tokens: 50_000 }, 'claude-haiku-5-5', { batch: true }) - 0.015) < 1e-12, 'Haiku 5.5, batched');
  assert.ok(Math.abs(claudeCost({ input_tokens: 150_000, output_tokens: 10_000 }, 'claude-haiku-5-5') - 0.1) < 1e-12, 'a prompt over 100,000 tokens is billed at its second tier');
  // A model the table does not have is billed at the dearest rate there is: overstated, never hidden.
  assert.equal(WORST, MODEL_RATES['claude-fable-5-1']);
  assert.equal(claudeCost({ input_tokens: 1e6 }, 'claude-mystery-9'), WORST.in);
});

test('a paid call is recorded after it, whatever the month has spent: no cap, no spend file, nothing refused', async () => {
  const { home, cleanup } = tempHome();
  try {
    const db = new Db(path.join(home, 'data', 'test.db'));
    opened.push(db);
    let calls = 0;
    const usage = { input_tokens: 1000, output_tokens: 500 };
    const llm = { kind: 'claude', backend: 'api', async json(req) { calls++; return { data: { ok: true }, usage, model: req.model, estimated: false }; } };
    db.insert('spend', { account_id: null, api: 'claude', usd: 10_000, month: new Date().toISOString().slice(0, 7), at: new Date().toISOString() });
    const req = { task: 'test', model: 'claude-mystery-9', system: 'system', user: 'user', schema: { type: 'object', properties: {}, additionalProperties: true }, maxTokens: 1000, tag: 'test' };
    const res = await askJson({ db, pack: null, postId: null, llm, log: () => {} }, req);
    assert.equal(calls, 1, 'an unknown model and a $10,000 month are both answered');
    const row = db.get("SELECT * FROM spend WHERE tag = 'test'");
    assert.ok(Math.abs(row.usd - claudeCost(usage, 'claude-mystery-9')) < 1e-12);
    assert.equal(res.usd, row.usd);
    assert.ok(!existsSync(path.join(home, 'data', 'anthropic-spend.json')), 'no spend file is written or wanted');
    // A refusal that was billed is recorded too, and the error goes on to the caller.
    const refusing = { ...llm, async json() { throw Object.assign(new Error('refused'), { usage, model: 'claude-sonnet-5-5' }); } };
    await assert.rejects(askJson({ db, pack: null, postId: null, llm: refusing }, { ...req, tag: 'refused' }), /refused/);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM spend WHERE tag = 'refused'").n, 1);
  } finally {
    cleanup();
  }
});

test('the Anthropic SDK is imported in one file only: every call goes through the one door', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f === 'node_modules' || f.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|cjs|ts)$/.test(f)) files.push(p);
    }
  };
  for (const d of ['src', 'scripts']) if (existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const importing = files.filter((f) => /@anthropic-ai\/sdk/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(importing, ['src/llm/claude.js']);
});

const require_ = (key, pack) => JSON.parse(readFileSync(path.join(pack.recordingsDir, 'drafts', `${key}.json`), 'utf8'));

/** A fake Message Batches API: answers every request from the demo's basil recording, billed high. */
function fakeBatchApi(pack, { onCreate = () => {} } = {}) {
  const batches = new Map();
  const rec = JSON.parse(JSON.stringify(require_('basil-containers', pack)));
  let n = 0;
  return {
    batches,
    async create(requests) {
      const id = `msgbatch_${++n}`;
      batches.set(id, requests);
      onCreate(requests);
      return { id, status: 'in_progress' };
    },
    async retrieve(id) {
      return { id, status: 'ended', counts: { succeeded: batches.get(id).length } };
    },
    async *results(id) {
      for (const r of batches.get(id)) {
        const sys = r.params.system.map((b) => b.text).join('\n');
        const data = /TASK: PLAN ONE POST/.test(sys) ? rec.outline : /TASK: WRITE ONE POST/.test(sys) ? rec.slides : /TASK: FIND THE DETAILS/.test(sys) ? { details: [] } : { reviews: [] };
        yield { custom_id: r.custom_id, result: { type: 'succeeded', message: { model: r.params.model, stop_reason: 'end_turn', usage: bigUsage(r.params), content: [{ type: 'text', text: JSON.stringify(data) }] } } };
      }
    },
  };
}

test('the day is drafted in batches: one batch per round for every post at once, recorded at half price from the usage', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const sizes = [];
    const api = fakeBatchApi(pack, { onCreate: (reqs) => sizes.push(reqs.length) });
    const batcher = makeBatcher(ctx, { api, pollMs: [1] });
    assert.equal(batcher.backend, 'api', 'the paid API');
    const bctx = { ...ctx, llm: batcher };
    const res = await Promise.all([0, 1, 2].map(() => batcher.run(() => buildPost(bctx, { pack, formatKey: 'care-guide' }))));
    assert.deepEqual(res.map((r) => r.status), ['queued', 'queued', 'queued'], JSON.stringify(res.map((r) => r.reason)));
    assert.deepEqual(sizes, [3, 3, 3, 3], 'three posts: their outlines in one batch, then their details, then their slides, then their reviews');
    const rows = ctx.db.all("SELECT * FROM spend WHERE api = 'claude'");
    assert.equal(rows.length, 12, 'each call once: the batcher records it, askJson does not again');
    assert.ok(rows.every((r) => r.batch === 1 && r.usage_json && !r.estimated), 'every call recorded from its usage, as a batch call');
    const outline = rows.find((r) => r.tag === 'outline');
    assert.ok(Math.abs(outline.usd - claudeCost(JSON.parse(outline.usage_json), outline.model) / 2) < 1e-12, 'at half price');
    assert.ok(ctx.db.all('SELECT status FROM batches').every((b) => b.status === 'recorded'));
  } finally {
    cleanup();
  }
});

test('a batch that does not end by its deadline is cancelled, and the run is drafted directly at the full price', async () => {
  const { home, cleanup } = tempHome();
  try {
    keepOnly(path.join(home, 'packs', 'demo'), ['basil-containers']);
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const sizes = [];
    const cancelled = [];
    const fake = fakeBatchApi(pack, { onCreate: (reqs) => sizes.push(reqs.length) });
    // A batch that never ends, and a status that cannot even be read some of the time.
    let polls = 0;
    const stuck = { ...fake, async retrieve(id) {
      if (++polls % 2) throw new Error('overloaded');
      return { id, status: 'in_progress' };
    }, async cancel(id) {
      cancelled.push(id);
      return { id, status: 'canceling' };
    } };
    // Direct answers, from the same recording the batch would have given.
    let direct = 0;
    const llm = { kind: 'claude', backend: 'api', async json(req) {
      direct++;
      const answer = (await fake.results(fake.create && (await fake.create([{ custom_id: 'x', params: req.params }])).id).next()).value;
      return { data: JSON.parse(answer.result.message.content[0].text), usage: answer.result.message.usage, model: req.params.model, estimated: false };
    } };
    const logs = [];
    const batcher = makeBatcher({ ...ctx, llm }, { api: stuck, pollMs: [5], deadlineMs: 40, log: (m) => logs.push(m) });
    const bctx = { ...ctx, llm: batcher };
    const res = await Promise.all([0, 1].map(() => batcher.run(() => buildPost(bctx, { pack, formatKey: 'care-guide' }))));
    assert.deepEqual(res.map((r) => r.status), ['queued', 'queued'], JSON.stringify(res.map((r) => r.reason)));
    assert.equal(sizes[0], 2, 'the outlines went as one batch');
    assert.equal(cancelled.length, 1, 'the batch past its deadline was cancelled, once');
    assert.match(logs.join('\n'), /still not ended after .* cancelled, its 2 request\(s\) asked directly/);
    assert.equal(direct, 8, 'its two requests, and every request after it, asked directly');
    const rows = ctx.db.all("SELECT * FROM spend WHERE api = 'claude'");
    assert.equal(rows.length, 8, 'each direct call recorded once');
    assert.ok(rows.every((r) => r.batch === 0 && !r.estimated), 'at the full price, from its usage');
    assert.equal(batcher.owned.size, 0, 'the given-up batch is left for recoverBatches to record what it did');
    assert.equal(ctx.db.get('SELECT status FROM batches').status, 'in_progress');
  } finally {
    cleanup();
  }
});

test('a batch a restart left behind is still recorded, once', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const api = fakeBatchApi(pack);
    // A batch sent by a process that then died: its row is all that is left (an older one may still name a hold).
    const params = { model: 'claude-sonnet-5-5', max_tokens: 100, system: [{ type: 'text', text: 'TASK: PLAN ONE POST' }], messages: [{ role: 'user', content: 'x' }], output_config: {} };
    const { id } = await api.create([{ custom_id: 'p1-outline-1', params }]);
    ctx.db.insert('batches', { id, status: 'in_progress', requests_json: { 'p1-outline-1': { account_id: 'demo', post_id: 'p1', model: params.model, tag: 'outline', reservation: 7 } }, created_at: new Date().toISOString() });
    assert.deepEqual(await recoverBatches(ctx, { api }), [id]);
    const row = ctx.db.get("SELECT * FROM spend WHERE tag = 'outline'");
    assert.ok(row && row.batch === 1 && row.usd > 0, 'what the batch really cost is recorded');
    assert.deepEqual(await recoverBatches(ctx, { api }), [], 'once');
    assert.equal(monthSpend(ctx.db, 'demo').calls, 1);
  } finally {
    cleanup();
  }
});

test('the migration that removes the budget: the holds and the customer cap go, and an account a cap paused writes again', () => {
  const { home, cleanup } = tempHome();
  try {
    const file = path.join(home, 'old.db');
    const raw = new DatabaseSync(file);
    const before = MIGRATIONS.findIndex((m) => m.includes('DROP TABLE reservations'));
    for (let v = 0; v < before; v++) raw.exec(MIGRATIONS[v]);
    raw.exec(`PRAGMA user_version = ${before}`);
    const at = '2026-10-20T10:00:00.000Z';
    const acc = raw.prepare("INSERT INTO accounts (id, display_name, handle, status, paused_reason, paused_detail, paused_at, cap_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    acc.run('capped', 'Capped', 'capped', 'paused', 'customer_cap', '$12.00 of $12.00 this month', at, 12, at, at);
    acc.run('broke', 'Broke', 'broke', 'paused', 'budget', 'the global monthly budget is used up', at, null, at, at);
    acc.run('killed', 'Killed', 'killed', 'paused', 'kill', 'off', at, null, at, at);
    raw.prepare("INSERT INTO reservations (account_id, usd, month, at) VALUES ('capped', 0.4, '2026-10', ?)").run(at);
    for (const key of ['globalBudgetUsd', 'budget:weights', 'budget:alloc:2026-10', 'globalKill']) raw.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(key, '1', at);
    raw.close();
    const db = new Db(file);
    opened.push(db);
    assert.equal(db.get('PRAGMA user_version').user_version, MIGRATIONS.length);
    assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'reservations'"), null);
    assert.ok(!db.all('PRAGMA table_info(accounts)').some((c) => c.name === 'cap_usd'));
    const status = Object.fromEntries(db.all('SELECT id, status, paused_reason FROM accounts').map((r) => [r.id, `${r.status}:${r.paused_reason}`]));
    assert.deepEqual(status, { capped: 'active:null', broke: 'active:null', killed: 'paused:kill' }, 'a kill switch stays on');
    assert.deepEqual(db.all('SELECT key FROM settings ORDER BY key').map((r) => r.key), ['globalKill']);
  } finally {
    cleanup();
  }
});
