import { readFileSync } from 'node:fs';
import path from 'node:path';
import { now } from '../core/clock.js';
import { ROOT } from '../core/paths.js';
import { lastKnown } from '../billing/entitlement.js';
import { ownWorkspace } from '../billing/own.js';
import { connectState } from '../publish/connect.js';
import { israelDate, israelInstant } from '../schedule/israel.js';
import { recentAlerts } from '../notify/operator.js';
import { esc } from './ui.js';

// Whether Teder is well, two ways:
//
//   - /readyz, for the deploy script and an uptime monitor: the database answers, and the runner's timer fired in the
//     last two minutes and no tick has been running for twenty. 200 or 503, with the build's commit. /healthz stays the
//     cheap "the process answers".
//   - the operator's health table on /all: per workspace, whether it has paid, its failed posts of the week, the
//     connections to make again, what was blocked today and how long since anything was drafted, with the alerts of
//     the week (src/notify/operator.js). What used to reach the operator only through the customer.

/** The commit this build is: deploy/deploy.sh writes it into each release as REVISION. A checkout without one is dev. */
export const REVISION = (() => {
  try {
    return readFileSync(path.join(ROOT, 'REVISION'), 'utf8').trim().slice(0, 40) || 'dev';
  } catch {
    return String(process.env.OF_REVISION || 'dev').slice(0, 40);
  }
})();

/** No tick in this long and the runner is not running. */
export const BEAT_MS = 2 * 60_000;
/** A tick running this long is stuck (a publish waits 3 minutes at most, a day's work far less than this). */
export const STUCK_MS = 20 * 60_000;

/** { ok, revision, checks: { db, runner } }: each check 'ok', 'off' (a website without the runner) or why not. */
export function readiness(ctx, { t = Date.now() } = {}) {
  const checks = {};
  try {
    checks.db = ctx.db.get('SELECT 1 AS ok')?.ok === 1 ? 'ok' : 'no answer';
  } catch (e) {
    ctx.log?.(`[readyz] database: ${e.message}`);
    checks.db = 'failed';
  }
  const r = ctx.runnerState;
  if (!r) checks.runner = 'off';
  else {
    const running = r.startedAt && !(r.endedAt >= r.startedAt) ? t - r.startedAt : 0;
    checks.runner = t - r.beatAt > BEAT_MS ? `no tick for ${Math.round((t - r.beatAt) / 1000)} s` : running > STUCK_MS ? `a tick has run for ${Math.round(running / 60_000)} min` : 'ok';
  }
  return { ok: Object.values(checks).every((v) => v === 'ok' || v === 'off'), revision: REVISION, checks };
}

const DAY = 86_400_000;

/**
 * One row per workspace of the server (the operator's own accounts, in none, first): its accounts, what accounts last
 * said of its payment (ours for one of the company's own workspaces, OF_OWN_WORKSPACES: never asked), failed posts in 7
 * days, connections to make again, posts blocked today, paused accounts, and the days since its last post that reached
 * the customer.
 */
export function workspaceHealth(ctx, { t = now() } = {}) {
  const { db } = ctx;
  const todayFrom = israelInstant(israelDate(t), '00:00').toISOString();
  const weekFrom = new Date(t - 7 * DAY).toISOString();
  const rows = new Map();
  for (const acc of db.all("SELECT id, display_name, workspace_id, status, paused_reason FROM accounts WHERE status != 'onboarding' ORDER BY workspace_id IS NOT NULL, workspace_id, id")) {
    const ws = acc.workspace_id ?? null;
    if (!rows.has(ws)) {
      const ours = ws == null || ownWorkspace(ws);
      const k = ours ? null : lastKnown(db, ws);
      rows.set(ws, { workspace: ws, accounts: [], access: ours ? 'ours' : k?.access || (k ? (k.allowed ? 'paid' : 'unpaid') : 'unknown'), allowed: ours ? true : Boolean(k?.allowed), checkedAt: k?.checkedAt || null, failed: 0, reconnect: [], blocked: 0, paused: [], lastDraft: null });
    }
    const row = rows.get(ws);
    row.accounts.push(acc.display_name);
    if (acc.status === 'paused') row.paused.push(acc.display_name);
    row.failed += db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'failed' AND updated_at >= ?", acc.id, weekFrom).n;
    row.blocked += db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'blocked' AND created_at >= ?", acc.id, todayFrom).n;
    const last = db.get("SELECT MAX(created_at) AS at FROM posts WHERE account_id = ? AND sample = 0 AND status NOT IN ('blocked', 'drafting')", acc.id)?.at;
    if (last && (!row.lastDraft || last > row.lastDraft)) row.lastDraft = last;
    const pack = ctx.pack(acc.id);
    for (const platform of pack?.meta.platforms || []) {
      if (connectState(db, pack, platform).state === 'reconnect') row.reconnect.push(`${acc.display_name}: ${platform}`);
    }
  }
  return [...rows.values()].map((r) => ({ ...r, daysSinceDraft: r.lastDraft ? Math.floor((t - Date.parse(r.lastDraft)) / DAY) : null }));
}

const ACCESS_HE = { ours: ['ok', 'שלנו'], paid: ['ok', 'שולם'], comp: ['ok', 'חינם'], cancelled: ['warn', 'בוטל'], unpaid: ['bad', 'לא שולם'], off: ['bad', 'כבוי'], unknown: ['warn', 'לא ידוע'] };

/** The operator's table on /all: a workspace a line, the trouble first in its own colour. */
export function healthPanel(rows, alerts = []) {
  if (!rows?.length) return '';
  const cnt = (n, cls) => (n ? `<span class="chip ${cls}">${n}</span>` : '<span class="muted">0</span>');
  const line = (r) => {
    const [cls, he] = ACCESS_HE[r.access] || ['warn', r.access];
    const days = r.daysSinceDraft == null ? '<span class="chip warn">אף פעם</span>' : r.daysSinceDraft >= 2 ? `<span class="chip bad">${r.daysSinceDraft} ימים</span>` : r.daysSinceDraft === 1 ? 'אתמול' : 'היום';
    return `<tr><td data-k="עסק">${r.workspace == null ? '<b>שלנו</b>' : `<b>עסק <span class="ltr">#${esc(r.workspace)}</span></b>`}<div class="muted small">${esc(r.accounts.join(' · '))}</div></td>
<td data-k="תשלום"><span class="chip ${cls}">${esc(he)}</span></td>
<td data-k="נכשלו ב-7 ימים" class="n">${cnt(r.failed, 'bad')}</td>
<td data-k="לחבר מחדש">${r.reconnect.length ? `<span class="chip warn">${r.reconnect.length}</span><div class="muted small">${esc(r.reconnect.join(' · '))}</div>` : '<span class="muted">0</span>'}</td>
<td data-k="נחסמו היום" class="n">${cnt(r.blocked, 'warn')}</td>
<td data-k="מושהים">${r.paused.length ? `<span class="chip warn">${esc(r.paused.join(' · '))}</span>` : '<span class="muted">0</span>'}</td>
<td data-k="פוסט אחרון" class="n">${days}</td></tr>`;
  };
  const alertList = alerts.length ? `<details class="mt12"><summary class="muted small">התראות מהשבוע (${alerts.length})</summary><ul class="factlist">${alerts.slice(0, 20).map((a) => `<li><b dir="auto">${esc(a.title)}</b><div class="muted small" dir="auto">${esc(a.body || '')}</div></li>`).join('')}</ul></details>` : '';
  return `<section class="panel home-panel" id="health"><header><h2>מצב הלקוחות</h2><span class="end muted small">רק למפעיל</span></header>
<div class="scrollx"><table class="table stack"><thead><tr><th>עסק</th><th>תשלום</th><th>נכשלו ב-7 ימים</th><th>לחבר מחדש</th><th>נחסמו היום</th><th>מושהים</th><th>פוסט אחרון</th></tr></thead><tbody>
${rows.map(line).join('')}
</tbody></table></div>
<p class="muted small m6">מה עושים בכל מצב: docs/first-customer.md</p>${alertList}</section>`;
}

/** The table's data and the week's alerts, for the operator; null for anyone else. */
export const healthFor = (ctx, user) => (user?.operator ? { rows: workspaceHealth(ctx), alerts: recentAlerts(ctx.db) } : null);
