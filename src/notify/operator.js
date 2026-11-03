import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { localFetch } from '../core/net.js';
import { getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';

// What only the operator hears: an account that drafted nothing for a day, a batch given up, a sign-up switch that
// disagrees. Each one that is due goes three ways, side by side:
//
//   the log      always: "[alert] <title>: <body>", and the health table on /all (below)
//   the command  the server's one alert command, the one the systemd units call when a service fails (openfrequency-ops:
//                /usr/local/bin/of-alert "<title>" "<body>"); OF_ALERT_CMD names another. Not on the VPS as of
//                2026-11-03, so nothing until it is installed
//   Toran        openfrequency-toran on this machine, which sends it on to the operator's own WhatsApp (the owner,
//                2026-11-03: "alerts can be sent to my own whatsapp"; Toran's TORAN_ALERT_WA and its approved template
//                operator_alert): POST {OF_TORAN_INTERNAL}/internal/ops/alert, bearer OF_INTERNAL_TOKEN,
//                { key, title, body, everyMinutes } (test/fixtures/ops-alert.json, the same file in Toran). Toran says
//                the same key once in its window too, and holds the phone to one message a key an hour, none for an
//                hour after Meta refuses one, ten an hour at most. OF_TORAN_INTERNAL defaults to http://127.0.0.1:4710;
//                off turns this off. Only a service on this machine is ever asked (localFetch). Toran down, refusing or
//                slow (5 seconds) is a log line, and the alert has been logged and kept already: nothing is tried again
//                and nothing throws
//
// Each kind of alert (its key) is sent once per `every`, a day unless said otherwise, and kept in settings
// (alert:<key>) for the operator's health table on /all to list.

export const alertCommand = (env = process.env) => String(env.OF_ALERT_CMD || '').trim() || '/usr/local/bin/of-alert';

/** Toran on this machine, unless OF_TORAN_INTERNAL says otherwise, and the route that takes an alert. */
export const TORAN_INTERNAL = 'http://127.0.0.1:4710';
export const TORAN_ALERT_PATH = '/internal/ops/alert';
const TORAN_TIMEOUT_MS = 5_000;
const MIN_TOKEN = 32;

/** Where an alert is handed to Toran, or null when OF_TORAN_INTERNAL is off. */
export function toranAlertUrl(env = process.env) {
  const v = String(env.OF_TORAN_INTERNAL || '').trim();
  if (v.toLowerCase() === 'off') return null;
  return `${(v || TORAN_INTERNAL).replace(/\/+$/, '')}${TORAN_ALERT_PATH}`;
}

/** Tell the operator. Returns true when the alert was due (sent, or logged where there is no command), false when it was sent lately. */
export async function alertOperator(ctx, key, { title, body = '' }, { t = Date.now(), every = 86_400_000, env = process.env, run = execFile, fetchImpl = localFetch } = {}) {
  const k = `alert:${key}`;
  const last = getSetting(ctx.db, k, null);
  if (last?.at && t - Date.parse(last.at) < every) return false;
  const said = { title: String(title).slice(0, 200), body: String(body).slice(0, 1000) };
  setSetting(ctx.db, k, { at: new Date(t).toISOString(), ...said });
  ctx.log?.(`[alert] ${title}${body ? `: ${body}` : ''}`);
  await Promise.all([command(ctx, said, env, run), toToran(ctx, { key, ...said, everyMinutes: Math.max(1, Math.ceil(every / 60_000)) }, env, fetchImpl)]);
  return true;
}

async function command(ctx, { title, body }, env, run) {
  const cmd = alertCommand(env);
  if (!existsSync(cmd)) return;
  // Arguments, never a shell: nothing in a title or a body is run.
  await new Promise((resolve) =>
    run(cmd, [title, body], { timeout: 15_000 }, (e) => {
      if (e) ctx.log?.(`[alert] ${cmd}: ${e.message}`);
      resolve();
    })
  );
}

/** Hand the alert to Toran. Never throws; a refusal or no answer is one log line (the token is never in it). */
async function toToran(ctx, alert, env, fetchImpl) {
  const url = toranAlertUrl(env);
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  if (!url || token.length < MIN_TOKEN) return;
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(alert),
      redirect: 'error',
      signal: AbortSignal.timeout(TORAN_TIMEOUT_MS),
    });
    let answer = null;
    try {
      answer = await r.json();
    } catch {
      /* the status says enough */
    }
    if (r.status < 200 || r.status >= 300) ctx.log?.(`[alert] Toran did not take ${alert.key}: HTTP ${r.status}${answer?.error ? ` ${answer.error}` : ''}`);
  } catch (e) {
    ctx.log?.(`[alert] Toran did not take ${alert.key}: ${e.message}`);
  }
}

/** The alerts of the last `days`, newest first: [{ key, at, title, body }]. */
export function recentAlerts(db, { t = Date.now(), days = 7 } = {}) {
  const from = t - days * 86_400_000;
  return db
    .all("SELECT key, value_json FROM settings WHERE key LIKE 'alert:%'")
    .map((r) => ({ key: r.key.slice('alert:'.length), ...j(r.value_json, {}) }))
    .filter((a) => a.at && Date.parse(a.at) >= from)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}
