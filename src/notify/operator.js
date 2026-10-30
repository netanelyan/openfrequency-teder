import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';

// What only the operator hears: an account that drafted nothing for a day, a batch given up. It goes through the
// server's one alert command, the one the systemd units call when a service fails (openfrequency-ops:
// /usr/local/bin/of-alert "<title>" "<body>", which sends it on to the operator's phone), so every alert reaches the
// same place. OF_ALERT_CMD names another command. Without one (a laptop), the alert is logged and kept.
//
// Each kind of alert (its key) is sent once per `every`, a day unless said otherwise, and kept in settings
// (alert:<key>) for the operator's health table on /all to list.

export const alertCommand = (env = process.env) => String(env.OF_ALERT_CMD || '').trim() || '/usr/local/bin/of-alert';

/** Tell the operator. Returns true when the alert was due (sent, or logged where there is no command), false when it was sent lately. */
export async function alertOperator(ctx, key, { title, body = '' }, { t = Date.now(), every = 86_400_000, env = process.env, run = execFile } = {}) {
  const k = `alert:${key}`;
  const last = getSetting(ctx.db, k, null);
  if (last?.at && t - Date.parse(last.at) < every) return false;
  setSetting(ctx.db, k, { at: new Date(t).toISOString(), title: String(title).slice(0, 200), body: String(body).slice(0, 1000) });
  ctx.log?.(`[alert] ${title}${body ? `: ${body}` : ''}`);
  const cmd = alertCommand(env);
  if (!existsSync(cmd)) return true;
  // Arguments, never a shell: nothing in a title or a body is run.
  await new Promise((resolve) =>
    run(cmd, [String(title).slice(0, 200), String(body).slice(0, 1000)], { timeout: 15_000 }, (e) => {
      if (e) ctx.log?.(`[alert] ${cmd}: ${e.message}`);
      resolve();
    })
  );
  return true;
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
