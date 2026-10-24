import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { opened, tempHome } from './helpers.js';
import { childEnv, cliArgs, cliClient, cliInput, resetAt, resultOf, spawnRun, withLock } from '../src/llm/cli.js';
import os from 'node:os';
import { ApiRefused, apiGate, askJson, llmBackend, makeLlm, ofEnv } from '../src/llm/index.js';
import { claudeClient, requestParams } from '../src/llm/claude.js';
import { engineMode } from '../src/engine.js';
import { openDb } from '../src/db/index.js';

// The development backend: the Claude Code CLI, mocked. Each test hands the
// client a `run` that plays the CLI's part and returns what the real one prints.

const SCHEMA = { type: 'object', properties: { fruit: { type: 'string' } }, required: ['fruit'], additionalProperties: false };
const REQ = { task: 'outline', system: [{ text: 'THE PACK', cache: '5m' }, { text: 'THE TASK', cache: '5m' }], user: 'הבקשה', schema: SCHEMA, model: 'claude-sonnet-5-5', effort: 'medium' };
const USAGE = { input_tokens: 10, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 120 };
const out = (o) => `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'result', is_error: false, num_turns: 2, usage: USAGE, modelUsage: { 'claude-sonnet-5-5': {} }, ...o })}\n`;
const quiet = () => {};

test('a call goes to the CLI with the request as production builds it, and without the API key', async () => {
  const seen = [];
  const run = async (r) => {
    seen.push({ ...r, system: readFileSync(r.args[r.args.indexOf('--system-prompt-file') + 1], 'utf8') });
    return { code: 0, stdout: out({ structured_output: { fruit: 'תפוח' } }), stderr: '' };
  };
  const llm = cliClient({ lockFile: null, env: { PATH: '', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_WORKSPACE_ID: 'w', CLAUDECODE: '1', HOME: 'x' }, bin: 'claude', run, log: quiet });
  const res = await llm.json(REQ);
  assert.deepEqual(res.data, { fruit: 'תפוח' });
  assert.equal(res.usage.output_tokens, 120);
  assert.equal(llm.backend, 'claude-cli');
  const [call] = seen;
  // The system prompt is the API's blocks in order; the schema, model and effort are the API's.
  assert.equal(call.system, 'THE PACK\n\nTHE TASK');
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]), SCHEMA);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(call.args[call.args.indexOf('--effort') + 1], 'medium');
  // No tools, a fresh session that is not saved, none of the machine's own setup.
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  for (const flag of ['-p', '--no-session-persistence', '--safe-mode']) assert.ok(call.args.includes(flag), flag);
  for (const flag of ['--continue', '--resume', '-c', '-r']) assert.ok(!call.args.includes(flag), flag);
  // The key never reaches the child: with it, the CLI would bill the API.
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.env.ANTHROPIC_WORKSPACE_ID, undefined);
  assert.equal(call.env.CLAUDECODE, undefined);
  assert.equal(call.env.HOME, 'x');
  // The user turn is one stream-json line.
  const line = JSON.parse(call.input);
  assert.equal(line.type, 'user');
  assert.deepEqual(line.message.content, [{ type: 'text', text: 'הבקשה' }]);
});

test('an image goes in the same user turn, as the API sends it', () => {
  const params = requestParams({ ...REQ, image: { type: 'image/jpeg', buf: Buffer.from('jpg') } });
  const line = JSON.parse(cliInput(params));
  assert.equal(line.message.content[0].type, 'image');
  assert.equal(line.message.content[0].source.data, Buffer.from('jpg').toString('base64'));
  assert.equal(line.message.content[1].text, 'הבקשה');
  assert.ok(cliArgs(params, { systemFile: 's' }).includes('--json-schema'));
});

test('an answer that is not JSON is asked for once more with the error, then fails', async () => {
  const inputs = [];
  let n = 0;
  const run = async (r) => {
    inputs.push(r.input);
    return { code: 0, stdout: out(n++ === 0 ? { result: 'סליחה, הנה התשובה' } : { structured_output: { fruit: 'banana' } }), stderr: '' };
  };
  const llm = cliClient({ lockFile: null, env: {}, bin: 'claude', run, log: quiet });
  assert.deepEqual((await llm.json(REQ)).data, { fruit: 'banana' });
  assert.equal(inputs.length, 2);
  assert.match(JSON.parse(inputs[1]).message.content.at(-1).text, /could not be read as the JSON object/);

  let m = 0;
  const bad = cliClient({ lockFile: null, env: {}, bin: 'claude', run: async () => (m++, { code: 0, stdout: out({ result: 'not json' }), stderr: '' }), log: quiet });
  await assert.rejects(bad.json(REQ), (e) => e.code === 'not_json');
  assert.equal(m, 2);
});

test('a usage limit waits for the reset it names, then makes the same call again', async () => {
  const t0 = Date.parse('2026-10-14T10:00:00Z');
  const waits = [];
  let n = 0;
  const run = async () =>
    n++ === 0
      ? { code: 1, stdout: out({ is_error: true, result: `Claude AI usage limit reached|${Math.floor(t0 / 1000) + 3600}` }), stderr: '' }
      : { code: 0, stdout: out({ structured_output: { fruit: 'kiwi' } }), stderr: '' };
  const llm = cliClient({ lockFile: null, env: {}, bin: 'claude', run, sleep: async (ms) => waits.push(ms), now: () => t0, log: quiet });
  assert.deepEqual((await llm.json(REQ)).data, { fruit: 'kiwi' });
  assert.equal(n, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 3600_000 && waits[0] <= 3600_000 + 120_000, String(waits[0]));
});

test('the reset time is read from every way the CLI says it', () => {
  const t0 = Date.parse('2026-10-14T10:00:00Z'); // 13:00 in Jerusalem
  assert.equal(resetAt('limit reached|1760436000', t0), 1760436000 * 1000);
  assert.equal(resetAt("You've hit your limit · resets 5pm (Asia/Jerusalem)", t0), t0 + 4 * 3600_000);
  assert.equal(resetAt('resets at 12:30 (Asia/Jerusalem)', t0), t0 + 23.5 * 3600_000);
  assert.equal(resetAt('try again in 20 minutes', t0), t0 + 20 * 60_000);
  assert.equal(resetAt('something else', t0), null);
});

test('a usage limit with no reset waits half an hour; never the API instead', async () => {
  const waits = [];
  let n = 0;
  const run = async () => (n++ === 0 ? { code: 1, stdout: '', stderr: 'API Error: 429 rate_limit_error' } : { code: 0, stdout: out({ structured_output: { fruit: 'fig' } }), stderr: '' });
  const llm = cliClient({ lockFile: null, env: {}, bin: 'claude', run, sleep: async (ms) => waits.push(ms), now: () => 0, log: quiet });
  assert.deepEqual((await llm.json(REQ)).data, { fruit: 'fig' });
  assert.equal(waits[0], 31 * 60_000);
});

test('a missing CLI, a failure and a timeout are errors with their own codes', async () => {
  const missing = cliClient({ lockFile: null, env: {}, bin: 'no-such-claude', run: async () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), log: quiet });
  await assert.rejects(missing.json(REQ), (e) => e.code === 'cli_missing' && /not found/.test(e.message));
  const failed = cliClient({ lockFile: null, env: {}, bin: 'claude', run: async () => ({ code: 1, stdout: out({ is_error: true, result: 'Invalid model' }), stderr: '' }), log: quiet });
  await assert.rejects(failed.json(REQ), (e) => e.code === 'cli');
  const slow = cliClient({ lockFile: null, env: {}, bin: 'claude', run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }), timeoutMs: 1000, log: quiet });
  await assert.rejects(slow.json(REQ), (e) => e.code === 'timeout');
});

test('the real spawn kills a child that runs past its time, and reports a missing binary', async () => {
  const r = await spawnRun({ bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], input: '', env: process.env, cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  await assert.rejects(spawnRun({ bin: path.join(process.cwd(), 'no-such-binary-here'), args: [], input: '', env: process.env, cwd: process.cwd(), timeoutMs: 1000 }), (e) => e.code === 'ENOENT');
});

test('calls run one at a time', async () => {
  let live = 0;
  let most = 0;
  const run = async () => {
    most = Math.max(most, ++live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    return { code: 0, stdout: out({ structured_output: { fruit: 'x' } }), stderr: '' };
  };
  const llm = cliClient({ lockFile: null, env: {}, bin: 'claude', run, log: quiet });
  await Promise.all([llm.json(REQ), llm.json(REQ), llm.json(REQ)]);
  assert.equal(most, 1);
});

test('the stream-json result line is found among the others', () => {
  assert.equal(resultOf('{"type":"system"}\n{"type":"result","is_error":false,"result":"ok"}\n').result, 'ok');
  assert.equal(resultOf('garbage'), null);
  assert.equal(childEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_SESSION_ID: 's', PATH: 'p' }).PATH, 'p');
  assert.deepEqual(Object.keys(childEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_SESSION_ID: 's' })), []);
});

test('a CLI call spends nothing and records its tokens with what the API would charge', async () => {
  const { cleanup } = tempHome();
  try {
    const db = openDb();
    opened.push(db);
    const llm = cliClient({ lockFile: null, env: {}, bin: 'claude', run: async () => ({ code: 0, stdout: out({ structured_output: { fruit: 'x' } }), stderr: '' }), log: quiet });
    const res = await askJson({ db, pack: null, postId: 'p1', llm }, { ...REQ, role: 'draft' });
    assert.equal(res.usd, 0);
    assert.ok(res.apiUsd > 0);
    const row = db.get('SELECT * FROM spend WHERE post_id = ?', 'p1');
    assert.equal(row.api, 'claude-cli');
    assert.equal(row.usd, 0);
    assert.ok(row.api_usd > 0);
    const u = JSON.parse(row.usage_json);
    assert.equal(u.output_tokens, 120);
    assert.ok(u.listUsd >= row.api_usd);
  } finally {
    cleanup();
  }
});

test('OF_ENV picks the backend: the CLI in dev, the API in prod', () => {
  assert.equal(ofEnv({}), 'dev');
  assert.equal(ofEnv({ OF_ENV: 'prod' }), 'prod');
  assert.equal(llmBackend({}), 'claude-cli');
  assert.equal(llmBackend({ ANTHROPIC_API_KEY: 'k' }), 'claude-cli');
  assert.equal(llmBackend({ OF_ENV: 'prod', ANTHROPIC_API_KEY: 'k' }), 'api');
  assert.equal(llmBackend({ OF_ENV: 'prod' }), 'recorded');
  assert.equal(llmBackend({ OF_LLM: 'recorded' }), 'recorded');
  assert.equal(makeLlm({ OF_LLM: 'claude-cli' }).backend, 'claude-cli');
  assert.equal(engineMode({}), 'live');
  assert.equal(engineMode({ OF_ENV: 'prod' }), 'recorded');
  assert.equal(engineMode({ OF_MODE: 'recorded' }), 'recorded');
});

test('in dev, an API call is refused without --allow-api, and the refusal is logged', async () => {
  const { home, cleanup } = tempHome();
  try {
    const env = { OF_HOME: home, OF_LLM: 'api', ANTHROPIC_API_KEY: 'sk-test' };
    const llm = makeLlm(env, { allowApi: false });
    assert.equal(llm.backend, 'api');
    await assert.rejects(llm.json(REQ), (e) => e instanceof ApiRefused && e.code === 'api_refused');
    const log = path.join(home, 'logs', 'api-refusals.log');
    assert.ok(existsSync(log));
    assert.match(readFileSync(log, 'utf8'), /outline on claude-sonnet-5-5/);
    // Allowed by the flag, or in prod, the gate lets it through.
    assert.doesNotThrow(() => apiGate({ env, allowApi: true })('x'));
    assert.doesNotThrow(() => apiGate({ env: { ...env, OF_ENV: 'prod' }, allowApi: false })('x'));
    // A client handed a refusing gate never reaches the SDK.
    const gated = claudeClient({ apiKey: 'sk-test', gate: () => { throw new ApiRefused('a test'); } });
    await assert.rejects(gated.json(REQ), (e) => e.code === 'api_refused');
  } finally {
    cleanup();
  }
});

test('one CLI call at a time across processes: a lock file, taken over when stale', async () => {
  const file = path.join(os.tmpdir(), `of-lock-test-${process.pid}`, 'cli.lock');
  let live = 0;
  let most = 0;
  const work = () => withLock(file, async () => {
    most = Math.max(most, ++live);
    await new Promise((r) => setTimeout(r, 30));
    live--;
  }, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  await Promise.all([work(), work(), work()]);
  assert.equal(most, 1);
  assert.ok(!existsSync(file), 'released');
  // A lock a crashed process left behind is taken over once it is older than a call can take.
  const { writeFileSync, utimesSync } = await import('node:fs');
  writeFileSync(file, '999999');
  utimesSync(file, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  assert.equal(await withLock(file, async () => 'ran', { staleMs: 1000, sleep: async () => {} }), 'ran');
});

test("a lock left by a process that is gone is taken over at once", async () => {
  const { writeFileSync } = await import('node:fs');
  const file = path.join(os.tmpdir(), `of-lock-dead-${process.pid}`, 'cli.lock');
  await withLock(file, async () => {}, { sleep: async () => {} });
  writeFileSync(file, '999999999');
  assert.equal(await withLock(file, async () => 'ran', { staleMs: 3_600_000, sleep: async () => {} }), 'ran');
});
