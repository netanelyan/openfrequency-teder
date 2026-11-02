import { doorFetch, localFetch } from '../core/net.js';
import { alertOperator } from '../notify/operator.js';
import { signupOpen } from './demos.js';

// One sign-up switch, in three places (the owner, 2026-11-02: "at startup, check that OF_SIGNUP_OPEN agrees with
// accounts (ask it through /internal) and with the site. If they disagree, log it loudly and send an alert to the
// operator"):
//
//   Teder     OF_SIGNUP_OPEN=1: a store's demo page sends people to accounts' sign-up (demos.js joinUrl)
//   accounts  OF_SIGNUP=1, with teder among OF_SIGNUP_PRODUCTS: /signup takes them. Asked on this machine:
//               GET {OF_ACCOUNTS_INTERNAL}/internal/signup, bearer OF_INTERNAL_TOKEN -> { open, products }
//             (openfrequency-accounts docs/contracts/signup.json)
//   the site  "signup": "open" in openfrequency-web's site.config.json: its ways in to Teder go to sign-up. Read where
//             its build publishes it: GET https://openfrequency.co.il/support.json -> signup.teder, "open" or "closed"
//
// Asked once, after the website listens (scripts/web.js), and never waited for: the start goes on, and each question
// has its own timeout. When the three agree, one quiet line says so ("all three agree: open"), so a log without it
// means the check never ran (the owner, 2026-11-02). When they do not, one loud line says which one says what,
// and the operator is alerted (src/notify/operator.js: the server's alert command, or only the log and /all's table
// while there is none). One that cannot be asked is "couldn't check <it>: <why>", and alerted too: a switch nobody
// can read is no better than one that disagrees, now that people pay through it. One alert a start, whatever was
// found, and not again within ALERT_FLOOR_MS, should the service restart over and over. Nothing secret is said: the
// token never, only why a question failed.

export const SITE_EXPORT = 'https://openfrequency.co.il/support.json';
export const ACCOUNTS_TIMEOUT_MS = 3000;
export const SITE_TIMEOUT_MS = 10_000;
export const ALERT_FLOOR_MS = 10 * 60_000;
/** Where docs/operator-notes.md says how to turn all three together. */
export const NOTES = 'docs/operator-notes.md, "One sign-up switch in three places"';
const MIN_TOKEN = 32;

const NAMES = { teder: 'Teder (OF_SIGNUP_OPEN)', accounts: 'accounts (OF_SIGNUP, OF_SIGNUP_PRODUCTS)', site: 'the website (site.config.json "signup")' };
const SHORT = { teder: 'Teder', accounts: 'accounts', site: 'the website' };

const why = (e) => (e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e).slice(0, 200));

/** accounts' half: { open, says }, open meaning /signup takes Teder, or { error } when it could not be asked. */
export async function accountsSignup({ env = process.env, fetchImpl = localFetch, timeoutMs = ACCOUNTS_TIMEOUT_MS } = {}) {
  const base = String(env.OF_ACCOUNTS_INTERNAL || 'http://127.0.0.1:4741').trim().replace(/\/+$/, '');
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  if (token.length < MIN_TOKEN) return { error: 'OF_INTERNAL_TOKEN is not set (32 characters or more)' };
  let r;
  try {
    r = await fetchImpl(`${base}/internal/signup`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { error: why(e) };
  }
  let b = null;
  try {
    b = await r.json();
  } catch (e) {
    if (e?.name === 'TimeoutError') return { error: 'timed out' };
  }
  if (r.status === 200 && b && typeof b.open === 'boolean' && Array.isArray(b.products) && b.products.every((p) => typeof p === 'string')) {
    const teder = b.open && b.products.includes('teder');
    return { open: teder, says: teder ? 'open' : b.open ? `closed for Teder (it takes ${b.products.join(', ') || 'no product'})` : 'closed' };
  }
  // An accounts from before the route: the order of a deploy is accounts first.
  if (r.status === 404 && b?.error === 'not_found') return { error: '404 not_found: this accounts has no /internal/signup yet' };
  return { error: r.status === 200 ? 'a 200 that does not match the contract' : `${r.status} ${typeof b?.error === 'string' ? b.error.slice(0, 40) : ''}`.trim() };
}

/** The website's half, from its support.json: { open, says }, or { error }. */
export async function siteSignup({ url = SITE_EXPORT, fetchImpl = doorFetch, timeoutMs = SITE_TIMEOUT_MS } = {}) {
  let r;
  try {
    r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), timeoutMs });
  } catch (e) {
    return { error: why(e) };
  }
  if (r.status !== 200) return { error: `HTTP ${r.status}` };
  let b;
  try {
    b = await r.json();
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timed out' : 'its support.json is not JSON' };
  }
  const v = b?.signup?.teder;
  if (v === 'open' || v === 'closed') return { open: v === 'open', says: v };
  // A build of the site from before the field (openfrequency-web src/support.mjs): deploy the site again.
  return { error: 'its support.json has no signup.teder' };
}

/**
 * Ask the three and say what was found: one quiet line when they agree; a loud line when they do not, a "couldn't check" line
 * for each that could not be asked, and then one alert. Returns { agree, teder, accounts, site, alerted }, agree null
 * when what could be asked agrees but not all could be. Never throws for a source: each is caught on its own.
 * `fetchLocal`, `fetchSite`, `run` and `t` are for the tests.
 */
export async function checkSignupSwitch(ctx, { env = process.env, fetchLocal, fetchSite, siteUrl, run, t } = {}) {
  const [accounts, site] = await Promise.all([accountsSignup({ env, fetchImpl: fetchLocal }), siteSignup({ url: siteUrl, fetchImpl: fetchSite })]);
  const open = signupOpen(env);
  const found = { teder: { open, says: open ? 'open' : 'closed' }, accounts, site };
  const log = (m) => ctx.log?.(`[signup] ${m}`);

  const known = Object.values(found).filter((s) => s.error == null);
  const disagree = new Set(known.map((s) => s.open)).size > 1;
  const failed = Object.keys(found).filter((k) => found[k].error != null);
  const said = Object.keys(found).map((k) => `${NAMES[k]} ${found[k].error == null ? `says ${found[k].says}` : "couldn't be checked"}`).join('; ');
  if (disagree) log(`!!! THE SIGN-UP SWITCH DISAGREES: ${said}. Make the three the same: ${NOTES}`);
  for (const k of failed) log(`couldn't check ${SHORT[k]}: ${found[k].error}`);
  if (!disagree && !failed.length) {
    log(`all three agree: ${open ? 'open' : 'closed'}`);
    return { agree: true, ...found, alerted: false };
  }

  const title = disagree ? 'Teder: the sign-up switch disagrees' : `Teder: couldn't check the sign-up switch (${failed.map((k) => SHORT[k]).join(', ')})`;
  const body = [said, ...failed.map((k) => `Couldn't check ${SHORT[k]}: ${found[k].error}`), `How to set all three: ${NOTES}`].join('. ');
  const alerted = await alertOperator(ctx, 'signup-switch', { title, body }, { every: ALERT_FLOOR_MS, env, ...(run ? { run } : {}), ...(t != null ? { t } : {}) });
  return { agree: disagree ? false : null, ...found, alerted };
}
