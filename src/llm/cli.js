import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeError, requestParams } from './claude.js';

// The development backend: every model call answered by the Claude Code CLI,
// headless, on the owner's subscription instead of the API key.
//
// THE SAME CALL. The request is built by requestParams() exactly as the API
// backend builds it: the same system blocks (joined, in order), the same user
// turn, the same image, the same JSON schema, the same model and effort. The CLI
// runs it as one model request with every tool turned off (--tools ""), a fresh
// session that is never saved (--no-session-persistence) and nothing of the
// machine's own setup (--safe-mode: no CLAUDE.md, hooks, skills or MCP servers).
// Its schema check (--json-schema) stands in for the API's structured output, and
// the answer goes through the same validation downstream, so a post that passes
// in development passes in production.
//
// NEVER THE KEY. The child gets the environment without ANTHROPIC_* variables:
// with ANTHROPIC_API_KEY in it, the CLI would bill the API instead of the
// subscription. The variables of a Claude Code session the engine may run inside
// are dropped too, so the child is a session of its own.
//
// ONE AT A TIME. Calls queue on one chain per process, and across processes on a
// lock file (two launch runs, the website's runner): the subscription's limits
// are per user, and a burst of parallel sessions hits them sooner.
//
// WHAT CAN GO WRONG, and what happens:
//   - an answer that is not JSON: asked once more with the error, then a ClaudeError
//   - the usage limit: wait for the reset the CLI names (or half an hour), then the
//     same call again; never the API instead
//   - no CLI: ClaudeError 'cli_missing', with how to install it
//   - no answer in time: the child is killed, ClaudeError 'timeout'
//
// TOKENS. The CLI reports the usage of its request; it is returned like the API's
// usage block, so the forecast can price it at API rates (askJson records it).

const DROP_ENV = /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_(SESSION|CHILD|MESSAGING|BRIDGE|ENTRYPOINT|SSE)|CLAUDE_PID$|CLAUDE_EFFORT$)/;

/** The environment for the child: the parent's, without the API key or the parent session. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !DROP_ENV.test(k)));
}

/** Where the CLI is: OF_CLAUDE_BIN, the native binary next to npm's shim on Windows, or `claude` on PATH. */
export function claudeBin(env = process.env) {
  if (env.OF_CLAUDE_BIN) return env.OF_CLAUDE_BIN;
  if (process.platform !== 'win32') return 'claude';
  for (const dir of String(env.PATH || env.Path || '').split(';').filter(Boolean)) {
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
    const shim = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(path.join(dir, 'claude.cmd')) && existsSync(shim)) return shim;
  }
  return 'claude.exe';
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The system prompt as one text: the API's blocks, in order. */
export const systemText = (params) => (params.system || []).map((b) => b.text).join('\n\n');

/** The CLI's arguments for one call. */
export function cliArgs(params, { systemFile }) {
  const effort = params.output_config?.effort;
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', params.model,
    ...(EFFORTS.has(effort) ? ['--effort', effort] : []),
    '--json-schema', JSON.stringify(params.output_config?.format?.schema || { type: 'object' }),
    '--system-prompt-file', systemFile,
    '--tools', '',
    '--no-session-persistence',
    '--safe-mode',
  ];
}

/** The user turn as the one stream-json line the CLI reads on stdin. */
export function cliInput(params, note = '') {
  const content = params.messages[0].content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content.map((c) => ({ ...c }));
  if (note) {
    const last = blocks.findLastIndex((b) => b.type === 'text');
    if (last >= 0) blocks[last] = { ...blocks[last], text: `${blocks[last].text}\n\n${note}` };
    else blocks.push({ type: 'text', text: note });
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } })}\n`;
}

/** The result line of the CLI's stream-json output, or null. */
export function resultOf(stdout) {
  let found = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type === 'result') found = o;
    } catch {
      /* a partial line */
    }
  }
  return found;
}

const LIMIT = /usage limit|hit your limit|limit reached|rate.?limit|too many requests|overloaded/i;

/** The wall clock in a time zone, as minutes since midnight. */
function minutesIn(tz, t) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  } catch {
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes();
  }
}

/**
 * When a usage limit lifts, from what the CLI said: an epoch after a "|"
 * ("Claude AI usage limit reached|1760000000"), a clock time ("resets 5pm
 * (Asia/Jerusalem)", "resets at 17:30"), or "in N minutes/hours". Null when it
 * names none.
 */
export function resetAt(text, now = Date.now()) {
  const s = String(text || '');
  const epoch = /\|\s*(\d{10,13})\b/.exec(s);
  if (epoch) return Number(epoch[1]) * (epoch[1].length === 10 ? 1000 : 1);
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(s);
  if (clock) {
    let h = Number(clock[1]) % 24;
    const m = Number(clock[2] || 0);
    if (clock[3]) h = (h % 12) + (/pm/i.test(clock[3]) ? 12 : 0);
    const tz = clock[4] || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let diff = h * 60 + m - minutesIn(tz, now);
    if (diff <= 0) diff += 24 * 60;
    return now + diff * 60_000;
  }
  const rel = /in\s+(\d+)\s*(minute|min|hour|hr)/i.exec(s);
  if (rel) return now + Number(rel[1]) * (/^h/i.test(rel[2]) ? 3_600_000 : 60_000);
  return null;
}

/** The default way to run the CLI: spawn it, feed stdin, collect stdout and stderr, kill it after timeoutMs. */
export function spawnRun({ bin, args, input, env, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

/** Is a process still running? (Signal 0 asks without signalling.) */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * The machine-wide lock: one CLI call at a time across every engine process. A
 * lock older than a call can take is a crashed process's, and is taken over.
 */
export async function withLock(file, fn, { staleMs = 15 * 60_000, sleep = sleepMs } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        // A lock whose process is gone, or older than a call can take, is a crashed process's.
        const owner = Number(readFileSync(file, 'utf8'));
        if (Date.now() - statSync(file).mtimeMs > staleMs || (owner && !alive(owner))) rmSync(file, { force: true });
      } catch {
        /* gone already */
      }
      await sleep(500);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The CLI client. Options are for tests: `run` replaces the spawn, `sleep` and
 * `now` the clock, `log` where waits and retries are reported.
 */
export function cliClient({ env = process.env, bin = claudeBin(env), run = spawnRun, sleep = sleepMs, now = () => Date.now(), timeoutMs = Number(env.OF_CLI_TIMEOUT_MS) || 10 * 60_000, log = (m) => console.warn(m), lockFile = path.join(os.tmpdir(), 'of-cli', 'cli.lock') } = {}) {
  const base = path.join(os.tmpdir(), 'of-cli');

  async function once(params, note) {
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(path.join(base, 'call-'));
    const systemFile = path.join(dir, 'system.txt');
    writeFileSync(systemFile, systemText(params));
    try {
      const go = () => run({ bin, args: cliArgs(params, { systemFile }), input: cliInput(params, note), env: childEnv(env), cwd: dir, timeoutMs });
      return await (lockFile ? withLock(lockFile, go, { staleMs: timeoutMs + 60_000 }) : go());
    } catch (e) {
      if (e?.code === 'ENOENT') throw new ClaudeError(`the Claude Code CLI was not found (${bin}): install it (npm i -g @anthropic-ai/claude-code) and log in, or set OF_CLAUDE_BIN`, 'cli_missing');
      throw new ClaudeError(`the Claude Code CLI could not start: ${e.message}`, 'cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function call(params) {
    let note = '';
    for (let attempt = 0; ; ) {
      const r = await once(params, note);
      if (r.timedOut) throw new ClaudeError(`the Claude Code CLI gave no answer in ${Math.round(timeoutMs / 1000)} s`, 'timeout');
      const res = resultOf(r.stdout);
      const said = `${res?.result || ''} ${r.stderr || ''}`;
      if (!res || res.is_error) {
        if (res?.api_error_status === 429 || LIMIT.test(said)) {
          const at = resetAt(said, now());
          const wait = Math.max(60_000, (at ?? now() + 30 * 60_000) - now() + 60_000);
          log(`claude-cli: usage limit (${String(said).trim().slice(0, 120)}); waiting ${Math.round(wait / 60_000)} min, then the same call again`);
          await sleep(wait);
          continue;
        }
        throw new ClaudeError(`the Claude Code CLI failed: ${String(said).trim().slice(0, 300) || `exit ${r.code}`}`, 'cli');
      }
      const model = Object.keys(res.modelUsage || {})[0] || params.model;
      let data = res.structured_output;
      let why = '';
      if (data == null) {
        try {
          data = JSON.parse(String(res.result || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch (e) {
          why = e.message;
        }
      }
      if (data != null && typeof data === 'object') return { data, usage: res.usage || {}, model, turns: res.num_turns };
      if (!why) why = 'the answer is not a JSON object';
      if (attempt++ >= 1) throw Object.assign(new ClaudeError(`the model returned something that is not JSON, twice (${why})`, 'not_json'), { usage: res.usage, model });
      log(`claude-cli: the answer was not JSON (${why}); asking once more`);
      note = `Your previous answer could not be read as the JSON object the schema asks for (${why}). Answer again with that JSON object only.`;
    }
  }

  return {
    kind: 'claude',
    backend: 'claude-cli',
    async json(req) {
      const params = req.params || requestParams(req);
      const mine = chain.then(() => call(params));
      chain = mine.catch(() => {});
      const res = await mine;
      return { ...res, estimated: false, batch: false };
    },
  };
}
