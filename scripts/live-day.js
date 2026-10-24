#!/usr/bin/env node
// npm run live-day -- --confirm [--direct]
//
// The one measurement that needs the Anthropic key: one day of the planned
// volume, for real. Every account gets tomorrow's posts, drafted exactly as the
// runner drafts them (through the Message Batches API, the pack's prefix cached;
// --direct for direct calls at full price), into the live database, in Approve
// mode: nothing is published, and the posts wait on the website for approval.
// It then prints what each post really cost, from the usage blocks the API
// returned, and the cost per post to put in docs/costs.md.
//
// It spends real money (a few tens of cents) on the project's key, which is
// why it asks for --confirm, and on a laptop (OF_ENV=dev) for --allow-api too: in
// development every API call is refused without it.

import { loadEnv, isSet } from '../src/core/env.js';
import { makeContext } from '../src/engine.js';
import { addDays, israelDate } from '../src/schedule/israel.js';
import { slotsFor } from '../src/schedule/slots.js';
import { generate } from '../src/autonomy/runner.js';
import { allowApiFlag, logRefusal, ofEnv } from '../src/llm/index.js';
import { closeBrowser } from '../src/render/render.js';
import { j } from '../src/db/index.js';

loadEnv();
const args = process.argv.slice(2);
if (!isSet('ANTHROPIC_API_KEY')) (console.error('ANTHROPIC_API_KEY is not set in $OF_HOME/.env.'), process.exit(1));
if (!args.includes('--confirm')) {
  console.error('This drafts one day of posts on real calls (a few tens of cents, on the project\'s key). Run it with --confirm.');
  process.exit(1);
}
if (args.includes('--direct')) process.env.OF_BATCH = 'off';
process.env.OF_MODE = 'live';
// This measures the API: the API backend, whatever the environment's default.
process.env.OF_LLM = 'api';
if (ofEnv() === 'dev' && !allowApiFlag()) {
  logRefusal('live-day without --allow-api');
  console.error('In development (OF_ENV=dev) the API is refused unless the command says --allow-api: npm run live-day -- --allow-api --confirm');
  process.exit(1);
}

const ctx = makeContext({ log: (m) => console.log(m) });
const tomorrow = addDays(israelDate(Date.now()), 1);
const plans = [];
for (const pack of ctx.packs) {
  const acc = ctx.db.get('SELECT status, mode FROM accounts WHERE id = ?', pack.id);
  if (acc?.status !== 'active') continue;
  if (acc.mode !== 'approve') ctx.db.run("UPDATE accounts SET mode = 'approve' WHERE id = ?", pack.id);
  const have = new Set(ctx.db.all("SELECT slot_at FROM posts WHERE account_id = ? AND status NOT IN ('blocked')", pack.id).map((r) => r.slot_at));
  for (const s of slotsFor(tomorrow, pack.meta.schedule).slots) if (!have.has(s.toISOString())) plans.push({ pack, slotAt: s.toISOString() });
}
console.log(`drafting ${plans.length} post(s) for ${tomorrow}, ${process.env.OF_BATCH === 'off' ? 'direct calls' : 'through the Message Batches API'}...`);
const t0 = Date.now();
const report = await generate(ctx, plans, { generated: [], errors: [] });
await closeBrowser();

console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} minutes\n`);
const rows = report.generated.map((g) => {
  const calls = ctx.db.all('SELECT tag, model, usd, batch, usage_json FROM spend WHERE post_id = ? ORDER BY id', g.post);
  const usd = calls.reduce((s, c) => s + c.usd, 0);
  const tok = calls.reduce((t, c) => {
    const u = j(c.usage_json, {}) || {};
    return { in: t.in + (u.input_tokens || 0), write: t.write + (u.cache_creation_input_tokens || 0), read: t.read + (u.cache_read_input_tokens || 0), out: t.out + (u.output_tokens || 0) };
  }, { in: 0, write: 0, read: 0, out: 0 });
  console.log(`${g.status.padEnd(7)} ${g.account.padEnd(10)} $${usd.toFixed(4)}  ${calls.map((c) => `${c.tag}:${c.model.replace('claude-', '')}${c.batch ? '(batch)' : ''}`).join(' ')}  tokens in ${tok.in} / cache write ${tok.write} / cache read ${tok.read} / out ${tok.out}  ${g.reason || ''}`);
  return { ...g, usd };
});
for (const e of report.errors) console.log(`error ${e.account}: ${e.error}`);
const all = rows.reduce((s, r) => s + r.usd, 0);
const ok = rows.filter((r) => r.status === 'queued');
console.log(`\n${ok.length} of ${rows.length} queued for approval. Spent $${all.toFixed(4)} in all: $${(ok.length ? all / ok.length : 0).toFixed(4)} per queued post (the blocked ones' calls included).`);
console.log('Every figure above is from the usage the API returned, at the published rates (batch at half price). Approve or reject the posts on the website.');
process.exit(0);
