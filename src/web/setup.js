import { connectState } from '../publish/connect.js';
import { zernioConfigured } from '../publish/zernio.js';
import { fromWebsite } from './demos.js';
import { PLATFORM_NAME } from './connect.js';
import { onboardingBusy } from './onboarding.js';
import { forWorkspace } from './workspace.js';

// GET /internal/setup?workspace=<id>: a workspace's setup steps in Teder, for the checklist on accounts' /setup page
// (openfrequency-accounts). Under the checks /internal/demos has (src/web/demos.js fromWebsite): this machine only,
// the bearer OF_INTERNAL_TOKEN, nothing that came through Caddy. JSON, Cache-Control: no-store.
//
//   { "product": "teder", "ready": bool, "steps": [{ key, title, status, detail, href, required }] }
//
// status is todo | working | done | attention | soon. href is an absolute address on Teder's public name (the page
// where the step is done), or null when there is nothing to open yet. ready is every required step done.
//
// The steps follow the new-account flow (src/web/onboarding.js): account, sources, samples, live, then connect (required:
// at least one of TikTok and Instagram connected, src/publish/connect.js, so the checklist never says ready with nothing
// to publish to), then the tiktok and instagram connections one by one, optional. A workspace with several accounts is reported on one:
// its newest live account (active, else paused), and without one its newest onboarding still under way. Once a
// workspace has an account on air its setup is done; a second account being added does not undo it.

export const STEP_KEYS = ['account', 'sources', 'samples', 'live', 'connect', 'tiktok', 'instagram'];
const STAGE = { none: 0, discovering: 1, failed: 1, review: 2, samples: 3, ready: 4, live: 5 };

/** The account and the onboarding the checklist reports on: { account, ob }, either one null. */
function subjectOf(db, workspaceId) {
  const rows = db.all('SELECT * FROM accounts WHERE workspace_id = ? ORDER BY created_at DESC, id DESC', workspaceId);
  const obOf = (packId) => db.get('SELECT * FROM onboarding WHERE pack_id = ? ORDER BY created_at DESC LIMIT 1', packId) || null;
  const live = rows.find((r) => r.status === 'active') || rows.find((r) => r.status === 'paused');
  if (live) return { account: live, ob: obOf(live.id) };
  const ob = db.get("SELECT * FROM onboarding WHERE workspace_id = ? AND status NOT IN ('live', 'abandoned') ORDER BY created_at DESC, id DESC LIMIT 1", workspaceId);
  if (ob) return { account: ob.pack_id ? rows.find((r) => r.id === ob.pack_id) || null : null, ob };
  // An account in onboarding with no onboarding row (written by hand): it has a pack, and the rest waits.
  return { account: rows[0] || null, ob: null };
}

const step = (key, title, status, { detail = '', href = null, required = true } = {}) => ({ key, title, status, detail, href, required });

/** The steps of one workspace. `base` is Teder's public address, https://<PUBLIC_HOST>. */
export function setupSteps(ctx, workspaceId, { base, env = process.env } = {}) {
  const c = forWorkspace(ctx, workspaceId);
  const { account, ob } = subjectOf(c.db, workspaceId);
  const at = (p) => `${base}${p}`;
  const stage = account && account.status !== 'onboarding' ? 'live' : ob ? ob.status : account ? 'samples' : 'none';
  const n = STAGE[stage] ?? 0;
  const obPage = at(ob ? `/new/${encodeURIComponent(ob.id)}` : '/new');
  const pack = account ? c.pack(account.id) : null;
  const steps = [];

  // The account: the seed, the search for sources, and the pack written once its name is picked.
  if (stage === 'none') steps.push(step('account', 'פותחים חשבון', 'todo', { detail: 'כותבים במה החשבון יעסוק, ותדר מחפש לו מקורות.', href: at('/new') }));
  else if (stage === 'discovering') steps.push(step('account', 'פותחים חשבון', 'working', { detail: 'מחפשים מקורות לחשבון. זה לוקח בדרך כלל כמה דקות.', href: obPage }));
  else if (stage === 'failed') steps.push(step('account', 'פותחים חשבון', 'attention', { detail: 'החיפוש נעצר באמצע. בדף אפשר לנסות שוב עם אותם פרטים.', href: obPage }));
  else if (stage === 'review') steps.push(step('account', 'פותחים חשבון', 'todo', { detail: 'בוחרים שם לחשבון, באותו דף של המקורות.', href: obPage }));
  else steps.push(step('account', 'פותחים חשבון', 'done', { detail: pack?.meta.displayName || account?.display_name || '' }));

  // The sources: approved on the onboarding page, before the pack is written.
  if (n < STAGE.review) steps.push(step('sources', 'בוחרים מקורות', 'todo'));
  else if (stage === 'review') steps.push(step('sources', 'בוחרים מקורות', 'todo', { detail: 'המקורות שנמצאו מחכים לאישור שלכם.', href: obPage }));
  else {
    const k = account ? c.db.get("SELECT COUNT(*) AS n FROM sources WHERE account_id = ? AND status = 'approved'", account.id).n : 0;
    steps.push(step('sources', 'בוחרים מקורות', 'done', { detail: k === 1 ? 'מקור אחד מאושר.' : k > 1 ? `${k} מקורות מאושרים.` : '' }));
  }

  // Five sample posts, written in the background, then looked over.
  if (n < STAGE.samples) steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'todo'));
  else if (stage === 'samples') {
    const good = account ? c.db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", account.id).n : 0;
    if (ob && onboardingBusy(ob.id)) steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'working', { detail: 'כותבים עכשיו חמישה פוסטים לדוגמה.', href: obPage }));
    else if (good >= 5) steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'todo', { detail: 'חמשת הפוסטים מוכנים ומחכים שתעברו עליהם.', href: obPage }));
    else if (good > 0) steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'todo', { detail: `${good} מתוך 5 דוגמאות עברו את הבדיקות. אפשר ליצור עוד.`, href: obPage }));
    else steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'todo', { detail: 'יוצרים חמישה פוסטים לדוגמה ועוברים עליהם.', href: obPage }));
  } else steps.push(step('samples', 'עוברים על פוסטים לדוגמה', 'done'));

  // On air: the account active. A paused one was on air and has stopped.
  if (n < STAGE.ready) steps.push(step('live', 'מעלים לאוויר', 'todo'));
  else if (stage === 'ready') steps.push(step('live', 'מעלים לאוויר', 'todo', { detail: 'החשבון יעלה במצב אישור, וכל פוסט יחכה לאישור שלכם.', href: obPage }));
  else if (account.status === 'paused') steps.push(step('live', 'מעלים לאוויר', 'attention', { detail: 'החשבון מושהה, ופוסטים לא יוצאים עד שמפעילים אותו מחדש.', href: at(`/accounts?account=${encodeURIComponent(account.id)}`) }));
  else steps.push(step('live', 'מעלים לאוויר', 'done'));

  // Connected: required, done once at least one platform the account publishes to is connected (nothing goes out
  // before). The connect panel is on the onboarding page while the account is in onboarding, then on the account page.
  const panel = account && pack ? at(account.status === 'onboarding' && ob ? `/new/${encodeURIComponent(ob.id)}#connect-${pack.id}` : `/accounts?account=${encodeURIComponent(pack.id)}#connect-${pack.id}`) : null;
  const states = pack ? pack.meta.platforms.filter((p) => ['tiktok', 'instagram'].includes(p)).map((p) => connectState(c.db, pack, p, env)) : [];
  const on = states.filter((s) => s.state === 'connected' || s.state === 'meta');
  const CONNECT = 'מחברים את טיקטוק או אינסטגרם';
  if (on.length) steps.push(step('connect', CONNECT, 'done', { detail: on.map((s) => `${PLATFORM_NAME[s.platform]} מחובר${s.username ? ` (@${s.username})` : ''}.`).join(' ') }));
  else if (!zernioConfigured()) steps.push(step('connect', CONNECT, 'soon', { detail: 'החיבור עוד לא זמין בשרת הזה.' }));
  else if (!pack) steps.push(step('connect', CONNECT, 'todo', { detail: 'מחברים אחרי שהחשבון נוצר. בלי חיבור המצגות לא עולות.' }));
  else if (states.some((s) => s.state === 'reconnect')) steps.push(step('connect', CONNECT, 'attention', { detail: 'החיבור הפסיק לעבוד, ומצגות לא עולות עד שמחברים מחדש.', href: panel }));
  else steps.push(step('connect', CONNECT, 'todo', { detail: 'מחברים לפחות אחד מהשניים כדי שהמצגות יעלו. אינסטגרם צריך חשבון מקצועי, עסקי או יוצר.', href: panel }));

  // TikTok and Instagram, each on its own and optional: each platform the account publishes to (both, before there is
  // an account).
  for (const platform of ['tiktok', 'instagram']) {
    if (pack && !pack.meta.platforms.includes(platform)) continue;
    const name = PLATFORM_NAME[platform];
    const title = `מחברים את ${name}`;
    const s = pack ? connectState(c.db, pack, platform, env) : null;
    const opt = { required: false };
    if (s?.state === 'meta') steps.push(step(platform, title, 'done', { ...opt, detail: 'מחובר דרך Meta.' }));
    else if (!zernioConfigured()) steps.push(step(platform, title, 'soon', { ...opt, detail: 'החיבור עוד לא זמין בשרת הזה.' }));
    else if (!s) steps.push(step(platform, title, 'todo', { ...opt, detail: 'מחברים אחרי שהחשבון נוצר.' }));
    else if (s.state === 'connected') steps.push(step(platform, title, 'done', { ...opt, detail: s.username ? `@${s.username}` : '' }));
    else if (s.state === 'reconnect') steps.push(step(platform, title, 'attention', { ...opt, detail: `החיבור הפסיק לעבוד, ופוסטים לא מגיעים ל${name} עד שמחברים מחדש.`, href: panel }));
    else steps.push(step(platform, title, 'todo', { ...opt, detail: `מחברים דרך Zernio ומאשרים במסך של ${name}.`, href: panel }));
  }

  return { product: 'teder', ready: steps.every((x) => !x.required || x.status === 'done'), steps };
}

/** GET /internal/setup. Returns [status, body]. */
export function setupFeed(ctx, req, env, { base, query }) {
  if (!fromWebsite(req, env)) return [403, { ok: false, error: 'forbidden' }];
  const raw = String(query.get('workspace') || '');
  const workspaceId = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
  if (!Number.isSafeInteger(workspaceId)) return [400, { ok: false, error: 'bad_workspace' }];
  return [200, setupSteps(ctx, workspaceId, { base, env })];
}
