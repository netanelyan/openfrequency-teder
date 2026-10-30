import { nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { claudeCost, record } from '../budget/ledger.js';
import { ClaudeError, requestParams, readMessage } from './claude.js';
import { alertOperator } from '../notify/operator.js';

// Drafting through the Message Batches API, at half price.
//
// Posts are drafted a day ahead of their slot, so nobody waits on an answer and
// every call can go through a batch. The pipeline is unchanged: it still calls
// askJson() one step at a time. The batcher is a model client whose json()
// does not send anything at once. It waits until every post being built in the
// run is waiting on the model, then sends all their requests as one batch, so a
// day's outlines go together, then the slides, then the reviews.
//
//   const batcher = makeBatcher(ctx, { api });
//   await Promise.all(plans.map((p) => batcher.run(() => buildPost({ ...ctx, llm: batcher }, p))));
//
// THE MONEY. When a batch ends, the batcher records each request's real cost from
// its usage block, at the batch rate, before it hands the answer back. A request
// that errored or expired was not billed, and nothing is recorded for it.
//
// A RESTART IN THE MIDDLE. Every batch is written to the `batches` table with
// what each request was for. recoverBatches() finds the ones not recorded yet,
// reads their results when they end, and records what they cost, even though
// the posts they were for are gone. The ledger never misses a paid call.
//
// A BATCH THAT DOES NOT END. Most end within the hour; the API gives one up to 24. A batch still running after
// BATCH_DEADLINE_MS (or one whose status cannot be read that long) is cancelled, its requests are asked directly at
// the full price, and every request the run makes after it goes directly too, so the day's posts are written while
// their slots are still ahead and the day's generation (which waits on this run) is never held for a day. What the
// cancelled batch had already done is billed: recoverBatches() records it when it ends, as for a restart.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a batch may run before its requests are asked directly. */
export const BATCH_DEADLINE_MS = 2 * 3_600_000;

/** What one batch result cost and what it says, as { ok, data, usage, model, usd, error }. */
function readResult(r, meta) {
  if (r.result?.type !== 'succeeded') {
    const code = r.result?.type || 'unknown';
    const msg = r.result?.error?.error?.message || r.result?.error?.message || code;
    return { ok: false, billed: false, error: new ClaudeError(`batch request ${code}: ${msg}`, `batch_${code}`) };
  }
  const message = r.result.message;
  const usd = claudeCost(message.usage || {}, message.model || meta.model, { batch: true });
  try {
    return { ok: true, billed: true, usd, ...readMessage(message, meta.model) };
  } catch (e) {
    return { ok: false, billed: true, usd, usage: e.usage, model: e.model, error: e };
  }
}

/** Record one result's cost, when it was billed. Once per batch row: a recorded batch is never read again. */
function account(db, meta, res) {
  if (!res.billed) return;
  record(db, {
    accountId: meta.account_id, postId: meta.post_id, api: 'claude', model: res.model || meta.model, usd: res.usd, tag: meta.tag, batch: true,
    usage: res.usage || null,
  });
}

export function makeBatcher(ctx, { api, pollMs = [20_000, 30_000, 60_000], deadlineMs = BATCH_DEADLINE_MS, direct = ctx.llm, log = ctx.log } = {}) {
  const { db } = ctx;
  const pending = [];
  let active = 0;
  let waiting = 0;
  let seq = 0;
  const owned = new Set();
  // Set once a batch ran past its deadline: from then on every request of the run is asked directly.
  let fallen = false;

  /** One request asked directly, at the full price, recorded here as the batcher records its own (askJson does not again). */
  async function askDirect(it) {
    try {
      const res = await direct.json(it.req);
      const usd = res.usage ? claudeCost(res.usage, res.model || it.meta.model) : 0;
      if (res.usage) record(db, { accountId: it.meta.account_id, postId: it.meta.post_id, api: 'claude', model: res.model || it.meta.model, usd, tag: it.meta.tag, batch: false, usage: res.usage });
      return { data: res.data, usage: res.usage, model: res.model, usd, estimated: false, batch: false, settled: true };
    } catch (e) {
      if (e?.usage) record(db, { accountId: it.meta.account_id, postId: it.meta.post_id, api: 'claude', model: e.model || it.meta.model, usd: claudeCost(e.usage, e.model || it.meta.model), tag: it.meta.tag, batch: false, usage: e.usage });
      throw Object.assign(e, { settled: true });
    }
  }

  /** The batch ran past its deadline: cancel it, and ask each of its requests directly. */
  async function giveUp(id, items) {
    fallen = Boolean(direct?.json);
    log?.(`batch ${id}: still not ended after ${Math.round(deadlineMs / 60_000)} minutes; cancelled, its ${items.length} request(s) asked directly`);
    try {
      await api.cancel?.(id);
    } catch (e) {
      log?.(`batch ${id}: cancel: ${e.message}`);
    }
    await alertOperator(ctx, 'batch-deadline', { title: 'Teder: a batch ran past its deadline', body: `batch ${id} (${items.length} request(s)) was cancelled and asked directly at the full price` }, { every: 6 * 3_600_000 }).catch(() => {});
    if (!fallen) {
      for (const it of items) it.reject(Object.assign(new ClaudeError('the batch ran past its deadline, and there is no direct client to ask', 'batch_deadline'), { settled: true }));
      return;
    }
    await Promise.all(items.map((it) => askDirect(it).then(it.resolve, it.reject)));
  }

  async function send(items) {
    const requests = items.map((it) => ({ custom_id: it.customId, params: it.params }));
    let created;
    try {
      created = await api.create(requests);
    } catch (e) {
      for (const it of items) it.reject(e);
      return;
    }
    const meta = Object.fromEntries(items.map((it) => [it.customId, it.meta]));
    db.insert('batches', { id: created.id, status: 'in_progress', requests_json: meta, created_at: nowIso() });
    owned.add(created.id);
    log?.(`batch ${created.id}: ${items.length} request(s) sent`);
    try {
      let i = 0;
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        if (Date.now() >= deadline) return await giveUp(created.id, items);
        await sleep(Math.min(pollMs[Math.min(i++, pollMs.length - 1)], Math.max(0, deadline - Date.now())));
        let b;
        try {
          b = await api.retrieve(created.id);
        } catch (e) {
          log?.(`batch ${created.id}: ${e.message}, asking again`);
          continue;
        }
        if (b.status === 'ended') {
          db.update('batches', created.id, { status: 'ended', ended_at: nowIso(), counts_json: b.counts || null });
          break;
        }
      }
      // Every result is read and recorded before any post is given its answer: a
      // post that resumed early would otherwise send its next request alone, in a
      // batch of one, while the others were still being handed theirs.
      const byId = new Map(items.map((it) => [it.customId, it]));
      const answers = new Map();
      for await (const r of api.results(created.id)) {
        const it = byId.get(r.custom_id);
        if (!it || answers.has(r.custom_id)) continue;
        const res = readResult(r, it.meta);
        account(db, it.meta, res);
        answers.set(r.custom_id, res);
      }
      for (const it of items) {
        const res = answers.get(it.customId);
        if (!res) {
          it.reject(Object.assign(new ClaudeError('the batch ended without this request', 'batch_missing'), { settled: true }));
        } else if (res.ok) it.resolve({ data: res.data, usage: res.usage, model: res.model, usd: res.usd, estimated: false, batch: true, settled: true });
        else it.reject(Object.assign(res.error, { settled: true }));
      }
      const done = answers;
      db.update('batches', created.id, { status: 'recorded', recorded_at: nowIso() });
      log?.(`batch ${created.id}: ${done.size} result(s) recorded`);
    } catch (e) {
      // Left as it is in the table: recoverBatches() records it later.
      for (const it of items) it.reject(e);
    } finally {
      owned.delete(created.id);
    }
  }

  function kick() {
    // Everyone in the run is waiting on the model: send what is queued.
    if (pending.length && waiting >= active) send(pending.splice(0));
  }

  /** A request made after a batch was given up: asked directly at once. */
  function askNow(it) {
    askDirect(it).then(it.resolve, it.reject);
  }

  return {
    kind: 'claude',
    // The paid API, at the batch rate: every request it carries is recorded here when its batch ends.
    backend: 'api',
    batch: true,
    owned,
    /** Build inside the batcher: its requests are held until every builder is waiting. */
    async run(fn) {
      active++;
      try {
        return await fn();
      } finally {
        active--;
        kick();
      }
    },
    json(req) {
      const params = req.params || requestParams(req);
      const customId = `${String(req.meta?.postId || 'x').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}-${req.task || 'call'}-${++seq}`.slice(0, 64);
      const meta = { account_id: req.meta?.accountId ?? null, post_id: req.meta?.postId ?? null, model: params.model, tag: req.tag || req.task || null };
      waiting++;
      return new Promise((resolve, reject) => {
        const it = {
          customId, params, meta, req,
          resolve: (v) => (waiting--, resolve(v)),
          reject: (e) => (waiting--, reject(e)),
        };
        if (fallen && direct) return askNow(it);
        pending.push(it);
        kick();
      });
    },
  };
}

/**
 * Record every batch this process does not own and has not recorded: one left
 * by a restart. Returns the ids recorded. Posts still "drafting" have no builder
 * left after a restart; the caller blocks them.
 */
export async function recoverBatches(ctx, { api, skip = new Set() } = {}) {
  const out = [];
  for (const row of ctx.db.all("SELECT * FROM batches WHERE status != 'recorded'")) {
    if (skip.has(row.id)) continue;
    let b;
    try {
      b = await api.retrieve(row.id);
    } catch (e) {
      ctx.log?.(`batch ${row.id}: ${e.message}`);
      continue;
    }
    if (b.status !== 'ended') continue;
    const meta = j(row.requests_json, {});
    const seen = new Set();
    for await (const r of api.results(row.id)) {
      const m = meta[r.custom_id];
      if (!m || seen.has(r.custom_id)) continue;
      seen.add(r.custom_id);
      const res = readResult(r, m);
      account(ctx.db, m, res);
    }
    ctx.db.update('batches', row.id, { status: 'recorded', ended_at: row.ended_at || nowIso(), recorded_at: nowIso(), counts_json: b.counts || null });
    out.push(row.id);
  }
  return out;
}
