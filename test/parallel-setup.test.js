import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { __onboarding, ONE_ACCOUNT } from '../src/web/onboarding.js';
import { choiceOf } from '../src/schedule/choice.js';
import { setupOf } from '../src/onboarding/setup.js';
import { offered, relevanceOf, heuristicScore, discover, strong } from '../src/onboarding/discover.js';
import { connectState, onboardingDoneLink, selectionOf } from '../src/publish/connect.js';
import { closeBrowser } from '../src/render/render.js';
import { INTERNAL_TOKEN, customer, fakeAccounts, opened, operator, tempHome } from './helpers.js';

// A business sets Teder up alone, and the search for sources takes minutes: the rest of the setup is done meanwhile, on
// the same page (src/web/onboarding.js, src/onboarding/setup.js). The name and handle, the days and times, and TikTok
// and Instagram (headless Zernio, src/publish/connect.js) are kept on the onboarding and applied when the account is
// created. Also here: what the customer is offered on the sources step (relevance, no scores or terms), and the
// sample posts written reliably and explained.

const SECRET = 'p'.repeat(48);
const realFetch = globalThis.fetch;
let home;
let ctx;
let db;
let fake;
let server;
let base;
let Z;

/** A fake Zernio: profiles, headless connect links, accounts, and Instagram's Facebook Login pick. */
function fakeZernio() {
  const st = { calls: [], profiles: [], accounts: [], pages: [], n: 0 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  st.handle = (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init.headers || {});
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const q = Object.fromEntries(u.searchParams);
    st.calls.push({ method, path: p, q, body, temp: headers.get('x-temp-token') });
    if (method === 'POST' && p === '/profiles') {
      const prof = { _id: `prof${++st.n}`, name: body.name, externalId: body.externalId };
      st.profiles.push(prof);
      return reply(201, { profile: prof });
    }
    const cm = /^\/connect\/(tiktok|instagram)$/.exec(p);
    if (method === 'GET' && cm) return reply(200, { authUrl: `https://www.${cm[1]}.com/oauth?state=s${++st.n}` });
    if (p === '/connect/instagram/select-account') {
      if (headers.get('x-temp-token') !== 'tmp-1') return reply(401, { error: 'bad token' });
      if (method === 'GET') return reply(200, { pages: st.pages });
      const page = st.pages.find((x) => x.id === body.pageId);
      if (!page) return reply(400, { error: 'no such page' });
      const a = { _id: `ig-${page.id}`, platform: 'instagram', username: page.instagram_business_account.username, profileId: body.profileId };
      st.accounts.push(a);
      return reply(200, { account: { accountId: a._id, platform: 'instagram', username: a.username } });
    }
    if (method === 'GET' && p === '/accounts') return reply(200, { accounts: st.accounts.filter((a) => !q.profileId || a.profileId === q.profileId) });
    if (method === 'GET' && p === '/accounts/health') return reply(200, { accounts: [] });
    return reply(404, { error: `no such endpoint: ${method} ${p}` });
  };
  return st;
}

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  Z = fakeZernio();
  globalThis.fetch = async (url, init) => (new URL(String(url)).hostname === 'zernio.com' ? Z.handle(url, init) : realFetch(url, init));
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'q'.repeat(40), OF_ASSISTANT_SECRET: SECRET, PUBLIC_HOST: 'teder.test', ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ZERNIO_API_KEY;
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

// Each test's new accounts go after it: a server has only so many looks to give out (src/onboarding/pack.js newTheme).
afterEach(() => {
  __onboarding.running.clear();
  __onboarding.progress.clear();
  delete ctx.samplesOpts;
  const made = ctx.packs.filter((p) => p.id !== 'demo');
  db.raw.exec('PRAGMA foreign_keys = OFF');
  for (const p of made) {
    for (const table of ['posts', 'sources', 'zernio_connections', 'accounts']) db.run(`DELETE FROM ${table} WHERE ${table === 'accounts' ? 'id' : 'account_id'} = ?`, p.id);
    rmSync(p.dir, { recursive: true, force: true });
  }
  db.raw.exec('PRAGMA foreign_keys = ON');
  ctx.reloadPacks();
});

const AT = new Date().toISOString();
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
async function csrfOf(cookie) {
  // /new has a form until the workspace has its one account (ONE_ACCOUNT); then the account's page has forms of its own.
  for (const p of ['/new', '/accounts']) {
    const m = /name="_csrf" value="([^"]+)"/.exec(await (await get(p, cookie)).text());
    if (m) return m[1];
  }
  throw new Error('no form with a token on /new or /accounts');
}
const post = async (p, cookie, body = {}, { ajax = false } = {}) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(ajax ? { 'x-of-ajax': '1' } : {}) }, body: new URLSearchParams({ _csrf: await csrfOf(cookie), ...body }).toString() });
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, '');

/** An onboarding still searching: a job in this process (or its page would call it cut off by a restart). */
function searching(id, ws, seed = { niche: 'כדורגל', examples: [] }) {
  db.insert('onboarding', { id, seed_json: seed, status: 'discovering', workspace_id: ws, created_at: AT, updated_at: AT });
  __onboarding.running.set(id, new Promise(() => {}));
  __onboarding.progress.set(id, { step: 'sites', done: 3, total: 8 });
}
/** An onboarding whose search found these candidates. */
const reviewing = (id, ws, candidates, seed = { niche: 'כדורגל', examples: [] }) => db.insert('onboarding', { id, seed_json: seed, status: 'review', workspace_id: ws, candidates_json: { candidates, formats: [], said: [] }, created_at: AT, updated_at: AT });
const cand = (id, over = {}) => ({ id, type: 'web', url: `https://${id}.example.org/`, name: `Site ${id}`, origin: 'brave', score: { authority: 8, freshness: 7, terms: 'ok', reason: 'גוף תקשורת מבוסס', relevance: 9, relevanceReason: 'x', by: 'heuristic' }, ...over });
const API = { id: 'capi', type: 'api', url: 'https://query.wikidata.org/sparql', name: 'Wikidata', origin: 'api', general: true, why: 'עובדות', api: { kind: 'wikidata-sparql', query: 'SELECT 1' }, terms: 'ok', score: { authority: 8, freshness: 7, terms: 'ok', reason: 'מקור נתונים מובנה', relevance: 6, by: 'heuristic' } };

/* ------------------------------------------------------------------ the waiting page */

test('the waiting page never reloads itself: a script asks a JSON status, and the rest of the setup is on the page', async () => {
  const { cookie } = fake.session(customer(1, { wsName: 'קפה יפו' }));
  searching('o-wait', 1);
  const html = await (await get('/new/o-wait', cookie)).text();
  assert.doesNotMatch(html, /http-equiv="refresh"/, 'no full-page refresh to lose what is typed');
  assert.match(html, /data-poll="\/new\/o-wait\/status"/);
  assert.match(html, /עכשיו בודקים אתרים, 3 מתוך 8\./, 'the progress line');
  assert.match(html, /<a href="\/new\/o-wait">לבדוק שוב<\/a>/, 'without the script, a link to look again');
  assert.match(html, /<script src="\/static\/app\.js/, 'the site\'s own script, under its CSP');
  for (const id of ['name', 'schedule', 'connect']) assert.match(html, new RegExp(`id="${id}"`), `the ${id} section is there while waiting`);
  assert.match(html, /action="\/new\/o-wait\/name"/);
  assert.match(html, /action="\/new\/o-wait\/schedule"/);
  assert.match(html, /action="\/new\/o-wait\/connect\/tiktok"/);
  // The name step, in a business owner's words, prefilled with the business's name.
  assert.match(html, /<h2>השם שלכם על המצגות<\/h2>/);
  assert.match(html, /השם של העסק <small>/);
  assert.match(html, /שם המשתמש שלכם בטיקטוק ובאינסטגרם <small>באותיות באנגלית, למשל cafe\.yafo<\/small><span class="atfield" dir="ltr"><span aria-hidden="true">@<\/span>/);
  assert.match(html, /name="displayName" required maxlength="40" value="קפה יפו"/);
  assert.doesNotMatch(visible(html), /שם לחשבון|לועזיות|העיצוב, הצבעים והגופן נבחרים לבד/, 'the old, puzzling wording is gone');
  // The connect panel keeps what each platform needs.
  assert.match(html, /אינסטגרם מתחבר רק כחשבון מקצועי/);
  assert.match(html, /המצגות מגיעות לטיוטות בטיקטוק בכוונה/);
  assert.match(html, /בחיבור מאשרים את Zernio, השירות שמפרסם בשבילנו\./);

  const res = await get('/new/o-wait/status', cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const s = await res.json();
  assert.deepEqual([s.status, s.busy, s.line], ['discovering', true, 'עכשיו בודקים אתרים, 3 מתוך 8.']);
  // The search ends: the key changes, and the call to move on says so.
  __onboarding.running.delete('o-wait');
  db.run("UPDATE onboarding SET status = 'review', candidates_json = ? WHERE id = 'o-wait'", JSON.stringify({ candidates: [] }));
  const done = await (await get('/new/o-wait/status', cookie)).json();
  assert.notEqual(done.key, s.key);
  assert.equal(done.ready, 'המקורות מוכנים, אפשר לבחור.');
  assert.equal(done.go, 'לבחור מקורות');
});

test('the name and handle, saved while waiting, are checked as at create and offered again on the sources step', async () => {
  const { cookie } = fake.session(customer(1));
  searching('o-name', 1);
  const bad = await post('/new/o-name/name', cookie, { displayName: 'קפה', handle: 'קפה' }, { ajax: true });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).message, /שם המשתמש צריך להיות באותיות באנגלית ובמספרים, לפחות שני תווים, למשל cafe\.yafo/);
  const taken = await post('/new/o-name/name', cookie, { displayName: 'קפה', handle: 'demo' }, { ajax: true });
  assert.match((await taken.json()).message, /שם המשתמש הזה כבר תפוס/, "the demo account's handle");
  const named = await post('/new/o-name/name', cookie, { displayName: ctx.pack('demo').meta.displayName, handle: 'fresh.one' }, { ajax: true });
  assert.match((await named.json()).message, /כבר יש חשבון בשם הזה/, "the demo account's name, said plainly instead of a failure at create");
  const ok = await post('/new/o-name/name', cookie, { displayName: 'קפה הספסל', handle: '@Cafe.Bench' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/new/o-name#name');
  assert.deepEqual([setupOf(db, 'o-name').displayName, setupOf(db, 'o-name').handle], ['קפה הספסל', 'Cafe.Bench']);
  assert.match(await (await get('/new/o-name', cookie)).text(), /value="Cafe\.Bench"/, 'kept on the waiting page');
  // The search ends: the sources step has them, and the customer may still change them.
  __onboarding.running.delete('o-name');
  db.run("UPDATE onboarding SET status = 'review', candidates_json = ? WHERE id = 'o-name'", JSON.stringify({ candidates: [cand('c1'), cand('c2'), cand('c3')] }));
  const review = await (await get('/new/o-name', cookie)).text();
  assert.match(review, /action="\/new\/o-name\/create" id="sources"/);
  assert.match(review, /name="displayName" required maxlength="40" value="קפה הספסל"/);
  assert.match(review, /name="handle"[^>]*value="Cafe\.Bench"/);
  assert.match(review, /את העיצוב של המצגות אפשר להחליף אחר כך בדף החשבון\./);
  const made = await post('/new/o-name/create', cookie, { approve_c1: 'on', displayName: 'קפה הספסל', handle: 'cafe.bench.two' });
  assert.equal(made.status, 303);
  const acc = db.get("SELECT display_name, handle FROM accounts WHERE id = 'cafe-bench-two'");
  assert.deepEqual([acc.display_name, acc.handle], ['קפה הספסל', 'cafe.bench.two'], 'what was typed on the sources step wins');
});

test('the days and times chosen while waiting are written to the account at create, and the samples page shows them chosen', async () => {
  const { cookie } = fake.session(customer(21));
  searching('o-sched', 21);
  const wrong = await post('/new/o-sched/schedule', cookie, { day_0: 'on' }, { ajax: true });
  assert.equal(wrong.status, 422, 'the same checks as the choice everywhere');
  assert.match((await wrong.json()).message, /ביום ראשון חסרה שעה/);
  const r = await post('/new/o-sched/schedule', cookie, { day_1: 'on', t1_1: '10:00', day_3: 'on', t1_3: '09:00', t2_3: '20:00' });
  assert.equal(r.headers.get('location'), '/new/o-sched#schedule');
  assert.deepEqual(setupOf(db, 'o-sched').choice.byDay[3], ['09:00', '20:00']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM settings WHERE key = 'schedule:o-sched'").n, 0, 'no account yet, nothing in its place');
  const page = await (await get('/new/o-sched', cookie)).text();
  assert.match(page, /name="t1_1" value="10:00"/, 'the form comes back with the choice');
  assert.doesNotMatch(page, /name="day_0" checked/);
  __onboarding.running.delete('o-sched');
  db.run("UPDATE onboarding SET status = 'review', candidates_json = ? WHERE id = 'o-sched'", JSON.stringify({ candidates: [cand('c1'), cand('c2'), cand('c3')] }));
  await post('/new/o-sched/create', cookie, { approve_c1: 'on', displayName: 'לוח', handle: 'sched.acct' });
  assert.deepEqual(choiceOf(db, 'sched-acct'), { 0: [], 1: ['10:00'], 2: [], 3: ['09:00', '20:00'], 4: [], 5: [], 6: [] });
  const samples = await (await get('/new/o-sched', cookie)).text();
  assert.match(samples, /action="\/accounts\/sched-acct\/schedule"[\s\S]*name="t1_1" value="10:00"/);
  assert.equal((await post('/new/o-sched/schedule', cookie, { day_1: 'on', t1_1: '11:00' }, { ajax: true })).status, 409, 'after create, the account\'s own form');
});

test('TikTok connected while waiting: a profile for the onboarding, the handle offered from it, and the account takes it over at create', async () => {
  const { cookie } = fake.session(customer(3));
  searching('o-conn', 3);
  const res = await post('/new/o-conn/connect/tiktok', cookie);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /http-equiv="refresh" content="0;url=https:\/\/www\.tiktok\.com\/oauth/, 'straight to TikTok: headless, no Zernio screen');
  const prof = Z.profiles.find((x) => x.externalId === 'o-conn');
  assert.ok(prof, "a profile of the onboarding's own");
  const ask = Z.calls.filter((c) => c.path === '/connect/tiktok').at(-1);
  assert.equal(ask.q.headless, 'true');
  assert.equal(ask.q.profileId, prof._id);
  const back = new URL(ask.q.redirect_url);
  assert.equal(back.pathname, '/new/o-conn/connect/tiktok/done');
  assert.equal(back.host, 'teder.test');

  // Back from TikTok (no session needed: the signature is the permission). What is connected is read from Zernio.
  Z.accounts.push({ _id: 'tk-1', platform: 'tiktok', username: 'cafe.yafo', profileId: prof._id });
  const done = await get(`${back.pathname}${back.search}&connected=tiktok&accountId=tk-1&username=cafe.yafo`);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /טיקטוק מחובר[\s\S]*כשהחשבון ייווצר, החיבור יעבור אליו לבד/);
  assert.equal(setupOf(db, 'o-conn').zernio.connections.tiktok.username, 'cafe.yafo');
  assert.equal((await get(`${back.pathname}?e=${back.searchParams.get('e')}&s=${'0'.repeat(64)}`)).status, 404, 'a forged return');
  const err = await (await get(`${back.pathname}${back.search}&error=oauth_denied&platform=tiktok&is_user_fixable=true`)).text();
  assert.match(err, /החיבור לא הצליח/);
  assert.doesNotMatch(err, /oauth_denied/, 'Zernio\'s code is the operator\'s');

  const waiting = await (await get('/new/o-conn', cookie)).text();
  assert.match(waiting, /<b>טיקטוק<\/b> <span class="chip ok">מחובר<\/span> <span class="ltr muted">@cafe\.yafo<\/span>/);
  assert.match(waiting, /name="handle"[^>]*value="cafe\.yafo"/, 'the handle offered from the connected account');

  // The setup checklist: connecting is doable now, and done.
  const steps = Object.fromEntries((await (await fetch(`${base}/internal/setup?workspace=3`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json()).steps.map((s) => [s.key, s]));
  assert.equal(steps.connect.status, 'done', 'a connection made before the account exists counts');
  assert.equal(steps.tiktok.status, 'done');
  assert.equal(steps.instagram.status, 'todo');
  assert.equal(steps.instagram.href, 'https://teder.test/new/o-conn#connect');

  __onboarding.running.delete('o-conn');
  db.run("UPDATE onboarding SET status = 'review', candidates_json = ? WHERE id = 'o-conn'", JSON.stringify({ candidates: [cand('c1'), cand('c2'), cand('c3')] }));
  await post('/new/o-conn/create', cookie, { approve_c1: 'on', displayName: 'קפה יפו', handle: 'cafe.yafo' });
  assert.equal(db.get("SELECT zernio_profile_id AS p FROM accounts WHERE id = 'cafe-yafo'").p, prof._id, 'the account takes the profile over');
  const pk = ctx.pack('cafe-yafo');
  assert.deepEqual([connectState(db, pk, 'tiktok').state, connectState(db, pk, 'tiktok').username], ['connected', 'cafe.yafo'], 'nothing to connect again');
  assert.equal(Z.profiles.filter((x) => x.externalId === 'cafe-yafo').length, 0, 'no second profile');
  assert.match(await (await get('/new/o-conn', cookie)).text(), /id="connect-cafe-yafo"[\s\S]*@cafe\.yafo/);
});

test('the setup checklist, while the sources are searched: the connect steps link to the onboarding page', async () => {
  searching('o-steps', 5);
  const out = await (await fetch(`${base}/internal/setup?workspace=5`, { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } })).json();
  const s = Object.fromEntries(out.steps.map((x) => [x.key, x]));
  assert.equal(s.account.status, 'working');
  assert.match(s.account.detail, /בינתיים אפשר לבחור שם, ימים ושעות ולחבר את טיקטוק, אינסטגרם ופייסבוק/);
  assert.equal(s.connect.status, 'todo');
  assert.equal(s.connect.href, 'https://teder.test/new/o-steps#connect');
  assert.equal(s.tiktok.href, 'https://teder.test/new/o-steps#connect');
  assert.equal(out.ready, false);
});

/* ------------------------------------------------------------------ headless Instagram through Facebook Login */

test('userProfile comes encoded twice: decoded once more, then parsed', () => {
  const profile = { id: '42', name: 'דנה כהן' };
  const wire = `?step=select_account&tempToken=tmp-1&profileId=prof9&connect_token=ct&userProfile=${encodeURIComponent(encodeURIComponent(JSON.stringify(profile)))}`;
  const sel = selectionOf(new URL(`https://teder.test/x${wire}`).searchParams);
  assert.deepEqual(sel, { step: 'select_account', profileId: 'prof9', tempToken: 'tmp-1', connectToken: 'ct', userProfile: profile });
  assert.equal(selectionOf(new URLSearchParams('connected=tiktok&accountId=1')), null, 'a direct connect needs no pick');
});

test('Instagram back through Facebook Login: one account is picked by itself, several are offered on our own page, and a pick is good once', async () => {
  const { cookie } = fake.session(customer(1));
  searching('o-ig', 1);
  await post('/new/o-ig/connect/instagram', cookie);
  const ask = Z.calls.filter((c) => c.path === '/connect/instagram').at(-1);
  assert.equal(ask.q.loginMethod, 'instagram_login', 'Instagram Login: no Page to pick, as a rule');
  const prof = setupOf(db, 'o-ig').zernio.profileId;
  const back = new URL(ask.q.redirect_url);
  const ret = (extra) => get(`${back.pathname}${back.search}&step=select_account&platform=instagram&tempToken=tmp-1&connect_token=ct&profileId=${extra.profileId || prof}&userProfile=${encodeURIComponent(encodeURIComponent(JSON.stringify({ name: 'דנה' })))}`);

  // A profile that is not the onboarding's: refused, nothing asked of Zernio.
  const before = Z.calls.length;
  assert.equal((await ret({ profileId: 'someone-else' })).status, 400);
  assert.equal(Z.calls.length, before);

  // Several: our own picker, the token kept on the server.
  Z.pages = [
    { id: 'pg1', name: 'הספסל', instagram_business_account: { id: 'ig1', username: 'bench.one' } },
    { id: 'pg2', name: 'הספסל 2', instagram_business_account: { id: 'ig2', username: 'bench.two' } },
    { id: 'pg3', name: 'בלי אינסטגרם' },
  ];
  const picker = await ret({});
  assert.equal(picker.status, 200);
  const html = await picker.text();
  assert.match(html, /איזה חשבון אינסטגרם לחבר\?/);
  assert.match(html, /דנה, מצאנו כמה חשבונות אינסטגרם מקצועיים/);
  assert.doesNotMatch(html, /tmp-1/, 'the token never goes back to the browser');
  assert.doesNotMatch(html, /בלי אינסטגרם/, 'a Page with no Instagram is not on offer');
  const links = [...html.matchAll(/href="(\/connect\/pick\/[0-9a-f]{32}\?page=(pg\d))"/g)];
  assert.deepEqual(links.map((m) => m[2]), ['pg1', 'pg2']);
  const id = /\/connect\/pick\/([0-9a-f]{32})/.exec(links[0][1])[1];
  assert.equal((await get(`/connect/pick/${id}?page=pg3`)).status, 400, 'a Page that was not on offer');
  assert.equal((await get(links[1][1])).status, 404, 'the pick was used up by the refused try');
  assert.equal((await get(`/connect/pick/${'f'.repeat(32)}?page=pg1`)).status, 404, 'an id never given');

  const again = await (await ret({})).text();
  const link = /href="(\/connect\/pick\/[0-9a-f]{32}\?page=pg2)"/.exec(again)[1];
  const picked = await get(link);
  assert.equal(picked.status, 200);
  assert.match(await picked.text(), /אינסטגרם מחובר[\s\S]*@bench\.two/);
  assert.equal(setupOf(db, 'o-ig').zernio.connections.instagram.id, 'ig-pg2');
  assert.equal((await get(link)).status, 404, 'good once');

  // One on offer: connected by itself, no picker.
  Z.pages = [{ id: 'pg9', name: 'יחיד', instagram_business_account: { id: 'ig9', username: 'only.one' } }];
  const one = await ret({});
  assert.match(await one.text(), /אינסטגרם מחובר/);
  assert.equal(setupOf(db, 'o-ig').zernio.connections.instagram.id, 'ig-pg9', 'the account Zernio just connected is the one kept');
});

test('one Teder account a subscription: a customer whose account is open gets no form for another, and neither a new search nor an older setup makes one; the operator may', async () => {
  await atSamples('o-one', 'one.acct', 41);
  const { cookie } = fake.session(customer(41));
  const page = await (await get('/new', cookie)).text();
  assert.match(page, /<h2>עוד חשבון הוא עוד מנוי<\/h2>/);
  assert.ok(page.includes('לכל חשבון בתדר יש מנוי משלו, והחשבון שלכם כבר פתוח. רוצים עוד חשבון?'), 'says why, and how to get one');
  assert.doesNotMatch(page, /name="niche"/, 'no form for another');
  assert.match(page, /href="\/new\/o-one"/, 'the setup in progress is still listed: the way back to its samples');
  const again = await post('/new', cookie, { niche: 'עוד נושא' }, { ajax: true });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).message, ONE_ACCOUNT);
  // A setup started before the account was made cannot make a second one.
  reviewing('o-one-b', 41, [cand('b1'), cand('b2'), cand('b3')]);
  const second = await post('/new/o-one-b/create', cookie, { approve_b1: 'on', displayName: 'שני', handle: 'second.acct' }, { ajax: true });
  assert.equal(second.status, 409);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = 41').n, 1);
  // A customer without an account starts one; the operator's own pages always may.
  assert.match(await (await get('/new', fake.session(customer(42)).cookie)).text(), /name="niche"/);
  assert.match(await (await get('/new', fake.session(operator()).cookie)).text(), /name="niche"/);
});

test('the new routes keep to their workspace, and to the paywall', async () => {
  searching('o-iso', 2);
  const A = fake.session(customer(1)).cookie;
  for (const p of ['/new/o-iso/name', '/new/o-iso/schedule', '/new/o-iso/connect/tiktok', '/new/o-iso/connections', '/new/o-iso/more']) {
    const r = await post(p, A, { displayName: 'A in B', handle: 'a.in.b', day_1: 'on', t1_1: '10:00', examples: 'https://a.example' }, { ajax: true });
    assert.equal(r.status, 404, `${p} from another workspace`);
  }
  assert.equal((await get('/new/o-iso/status', A)).status, 404);
  assert.deepEqual(setupOf(db, 'o-iso'), {}, 'nothing of B changed');
  assert.equal(Z.profiles.filter((x) => x.externalId === 'o-iso').length, 0);
  // Unpaid: the paywall, before anything.
  fake.entitlement(2, 'unpaid');
  const B = fake.session(customer(2)).cookie;
  assert.equal((await get('/new/o-iso/status', B)).status, 402);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get('/new', fake.session(customer(1)).cookie)).text());
  assert.ok(csrf);
  const r = await fetch(`${base}/new/o-iso/name`, { method: 'POST', headers: { cookie: B, 'content-type': 'application/x-www-form-urlencoded', origin: base, 'x-of-ajax': '1' }, body: 'displayName=x&handle=xx' });
  assert.equal(r.status, 402);
  assert.deepEqual(setupOf(db, 'o-iso'), {});
  fake.entitlement(2, null);
  // The return from Zernio is signed for its onboarding alone.
  const link = new URL(onboardingDoneLink(SECRET, { base, onboardingId: 'o-iso', platform: 'tiktok' }));
  assert.equal((await get(`/new/o-wait/connect/tiktok/done${link.search}`)).status, 404, "another onboarding's signature");
});

/* ------------------------------------------------------------------ what the sources step offers */

test('relevance: a site about something else is not about the niche, whatever its authority', () => {
  const seed = { niche: 'כדורגל', nicheEn: 'football', topics: ['ליגת העל'] };
  const cooking = { type: 'rss', url: 'https://www.cooking-daily.example.com/feed', name: 'מתכונים בקלות', about: 'מתכונים לארוחת ערב', sample: ['עוגת שוקולד', 'פסטה ברוטב'], origin: 'feed' };
  assert.ok(relevanceOf(cooking, seed).relevance < 6);
  assert.ok(relevanceOf({ type: 'rss', url: 'https://www.sport.example.co.il/rss', name: 'ספורט', sample: ['הכדורגל הישראלי חוזר'], origin: 'feed' }, seed).relevance >= 7, 'its latest items are about it');
  assert.equal(relevanceOf({ type: 'web', url: 'https://www.football.example.org/', name: 'News', origin: 'brave' }, seed).relevance, 9, 'the English niche in its address');
  assert.equal(relevanceOf({ type: 'web', url: 'https://x.example/', name: 'ליגת העל היום', origin: 'brave' }, seed).relevance, 6, 'a topic of theirs');
  const govCooking = { ...cooking, url: 'https://www.health.gov.il/recipes' };
  const sc = heuristicScore(govCooking, Date.now(), seed);
  assert.ok(sc.authority >= 9 && sc.relevance < 6);
  assert.equal(offered({ ...govCooking, score: sc }), false, 'high authority does not make it relevant');
  // The thresholds: relevant 6+, authority 5+, terms that allow reuse; strong ones ticked.
  const c = (s, origin = 'brave') => ({ origin, score: { authority: 7, relevance: 7, terms: 'ok', ...s } });
  assert.equal(offered(c({ relevance: 6, authority: 5 })), true);
  assert.equal(offered(c({ relevance: 5 })), false);
  assert.equal(offered(c({ authority: 4 })), false);
  assert.equal(offered(c({ terms: 'no' })), false);
  assert.equal(offered(c({ terms: 'check' })), true);
  assert.equal(offered(c({ authority: 3, relevance: 1 }, 'example')), true, 'a site the customer gave is theirs to judge');
  assert.equal(strong(c({})), true);
  assert.equal(strong(c({ relevance: 6 })), false);
  assert.equal(strong(c({ authority: 6 })), false);
});

test('discovery scores relevance: an off-topic site found for "football" is kept in the data, last', async () => {
  const readSite = async (url) => (url.includes('cook') ? [{ type: 'rss', url: `${url}feed`, name: 'Daily Cooking', about: 'Recipes for dinner', sample: ['Chocolate cake'], newest: null }] : [{ type: 'rss', url: `${url}feed`, name: 'Football Today', sample: ['כדורגל: המחזור'], newest: null }]);
  const out = await discover(ctx, { niche: 'כדורגל', nicheEn: 'football', examples: [] }, { yt: null, readSite });
  assert.ok(out.candidates.every((x) => Number.isInteger(x.score.relevance) && x.score.relevanceReason), 'every candidate has a relevance and a reason');
});

test('the sources step: no scores or terms for the customer, off-topic and forbidden sources left out, the operator sees everything', async () => {
  const cooking = cand('cook', { name: 'מתכונים לכל יום', score: { authority: 9, freshness: 9, terms: 'ok', reason: 'אתר ממשלתי', relevance: 1, relevanceReason: 'אין במקור אף מילה מהנושא', by: 'heuristic' } });
  const banned = cand('banned', { name: 'אסור לשימוש בדוגמה', score: { authority: 9, freshness: 7, terms: 'no', reason: 'רשת חברתית', relevance: 9 } });
  const check = cand('check', { name: 'תנאים לא ידועים', score: { authority: 6, freshness: 7, terms: 'check', reason: 'ארגון', relevance: 8 } });
  const fresh = cand('fresh', { name: 'עדכני מאוד', newest: new Date().toISOString() });
  reviewing('o-src', 1, [cooking, banned, check, fresh, cand('lead')]);
  const { cookie } = fake.session(customer(1));
  const html = visible(await (await get('/new/o-src', cookie)).text());
  assert.doesNotMatch(html, /מתכונים לכל יום/, 'the off-topic site is not offered');
  assert.doesNotMatch(html, /אסור לשימוש בדוגמה|approve_banned/, 'nor one whose terms forbid reuse');
  assert.match(html, /תנאים לא ידועים/, "one whose terms are ours to check is offered");
  assert.doesNotMatch(html, /לבדוק תנאי שימוש|תנאים בסדר|אסור לשימוש/, 'no terms chip');
  assert.doesNotMatch(html, /סמכות \d+\/10|עדכניות \d+\/10|רלוונטיות/, 'no numbers');
  assert.match(html, /<span class="chip ok">מקור מוביל<\/span>/);
  assert.match(html, /<span class="chip">מתעדכן כל יום<\/span>/);
  assert.match(html, /name="approve_lead" checked/, 'a strong one is ticked');
  assert.doesNotMatch(html, /name="approve_check" checked/, 'a weaker one is not');
  assert.doesNotMatch(html, /מצאנו מעט מקורות טובים/, 'three good ones are enough');
  // A forbidden or hidden one approved by a forged form is not approved.
  await post('/new/o-src/create', cookie, { approve_cook: 'on', approve_banned: 'on', approve_lead: 'on', displayName: 'מקורות', handle: 'src.acct' });
  const urls = db.all("SELECT url FROM sources WHERE account_id = 'src-acct' AND status = 'approved'").map((r) => r.url);
  assert.deepEqual(urls, ['https://lead.example.org/']);

  reviewing('o-src-op', 1, [cooking, banned, check]);
  const op = await (await get('/new/o-src-op', fake.session(operator()).cookie)).text();
  assert.match(op, /מקורות שלא הוצגו ללקוח \(2\)/);
  assert.match(op, /מתכונים לכל יום[\s\S]*אין במקור אף מילה מהנושא/, 'with why');
  assert.match(op, /לבדוק תנאי שימוש/, 'the operator still sees the terms chip');
  assert.match(op, /סמכות 6\/10/);
  assert.match(op, /רלוונטיות 1\/10/);
});

test('the sources step is compact: a row each, 8 open with the ticked ones first, the rest folded, ticked or not, and sent with the form', async () => {
  const many = Array.from({ length: 12 }, (_, i) => cand(`m${i + 1}`, i === 10 ? { score: { authority: 6, freshness: 7, terms: 'ok', reason: 'x', relevance: 8 } } : {}));
  reviewing('o-fold', 51, many);
  const html = visible(await (await get('/new/o-fold', fake.session(customer(51)).cookie)).text());
  const open = html.slice(0, html.indexOf('<details class="srcrest">'));
  assert.equal((open.match(/<li class="srcrow">/g) || []).length, 8, '8 rows open');
  assert.equal((html.match(/<li class="srcrow">/g) || []).length, 12, 'all 12 on the page');
  assert.match(html, /סימנו 11 מקורות חזקים\. תדר כותב רק ממקורות מסומנים\./);
  assert.match(html, /<summary>עוד 4 מקורות, 3 מהם מסומנים<\/summary>/);
  assert.match(html, /<span class="ltr">m1\.example\.org<\/span>/, 'the site, not the whole address');
  assert.doesNotMatch(html, /name="why_/, 'no reason box for the customer');
  assert.match(html, /name="approve_m12" checked/, 'a folded ticked one is still ticked');
  assert.doesNotMatch(html, /name="approve_m11" checked/);
});

test('too few good sources: said plainly, and a search again with more of the customer\'s own sites', async () => {
  reviewing('o-few', 1, [cand('one'), cand('off', { score: { authority: 9, freshness: 5, terms: 'ok', reason: 'x', relevance: 2 } })]);
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/new/o-few', cookie)).text();
  assert.match(html, /<h2>מצאנו מעט מקורות טובים לנושא הזה<\/h2>/);
  assert.match(html, /יש כאן מקור אחד שאפשר לעבוד איתם/);
  assert.match(html, /action="\/new\/o-few\/more"/);
  ctx.discoverOpts = { readSite: async () => [] };
  const r = await post('/new/o-few/more', cookie, { examples: 'https://club.example.org/\nhttps://league.example.org/' });
  assert.equal(r.status, 303);
  const row = db.get("SELECT status, seed_json FROM onboarding WHERE id = 'o-few'");
  assert.ok(['discovering', 'review'].includes(row.status), 'searching again');
  assert.deepEqual(JSON.parse(row.seed_json).examples, ['https://club.example.org/', 'https://league.example.org/']);
  await Promise.all([...__onboarding.running.values()]);
  delete ctx.discoverOpts;
});

/* ------------------------------------------------------------------ the samples */

/** The workspace each samples test's account is in: one Teder account a subscription, so each its own. */
const wsOf = new Map();
let nextWs = 100;
/** An account in onboarding, its onboarding at the samples step. */
async function atSamples(id, handle, ws = nextWs++) {
  wsOf.set(id, ws);
  reviewing(id, ws, [cand('s1'), cand('s2'), cand('s3')]);
  const r = await post(`/new/${id}/create`, fake.session(customer(ws)).cookie, { approve_s1: 'on', displayName: `דוגמאות ${handle}`, handle }, { ajax: true });
  assert.equal(r.status, 200, await r.text());
  return db.get('SELECT pack_id FROM onboarding WHERE id = ?', id).pack_id;
}
/** A stand-in for buildPost: each call takes the next outcome ('ok' writes a sample). */
const builder = (outcomes, calls = []) => async (c, { pack }) => {
  const o = outcomes.shift() || 'refused';
  calls.push(o);
  if (o === 'throw') throw new Error('model overloaded');
  if (o === 'ok') {
    const pid = `p-${pack.id}-${calls.length}`;
    db.insert('posts', { id: pid, account_id: pack.id, status: 'sample', sample: 1, created_at: new Date(Date.now() + calls.length).toISOString(), updated_at: AT });
    return { status: 'sample', postId: pid };
  }
  return { status: 'blocked', kind: o === 'error' ? 'error' : o === 'empty' ? 'no_source' : 'fact_check', reason: `refused: ${o}` };
};
const runSamples = async (onb) => {
  await post(`/new/${onb}/samples`, fake.session(customer(wsOf.get(onb))).cookie);
  await Promise.all([...__onboarding.running.values()]);
};

test('samples: the sources are read first, then written one by one; the read is said while it runs', async () => {
  const packId = await atSamples('o-s1', 'samples.one');
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  ctx.samplesOpts = { read: async () => (order.push('read'), await gate, { docs: 4, sources: 1, failed: [] }), build: builder(['ok', 'ok', 'ok', 'ok', 'ok'], order), retryMs: 0 };
  const { cookie } = fake.session(customer(wsOf.get('o-s1')));
  await post('/new/o-s1/samples', cookie);
  const during = await (await get('/new/o-s1', cookie)).text();
  assert.match(during, /data-poll="\/new\/o-s1\/status"/);
  assert.doesNotMatch(during, /http-equiv="refresh"/);
  assert.equal((await (await get('/new/o-s1/status', cookie)).json()).line, 'קוראים את המקורות שבחרתם.');
  release();
  await Promise.all([...__onboarding.running.values()]);
  assert.deepEqual(order, ['read', 'ok', 'ok', 'ok', 'ok', 'ok'], 'read, then five written');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", packId).n, 5);
  assert.doesNotMatch(await (await get('/new/o-s1', cookie)).text(), /banner warn/, 'nothing went wrong');
});

test('samples: no facts in the chosen sources is said with what helps, and a way back to the sources', async () => {
  await atSamples('o-s2', 'samples.two');
  const calls = [];
  const logs = [];
  ctx.log = (m) => logs.push(m);
  ctx.samplesOpts = { read: async () => ({ docs: 0, sources: 2, failed: [] }), build: builder([], calls), retryMs: 0 };
  await runSamples('o-s2');
  ctx.log = () => {};
  assert.deepEqual(calls, [], 'nothing written from nothing');
  const html = await (await get('/new/o-s2', fake.session(customer(wsOf.get('o-s2'))).cookie)).text();
  assert.match(html, /במקורות שבחרתם לא מצאנו מספיק עובדות לכתוב מהן\. אפשר להוסיף מקורות או לבחור אחרים, ואז לנסות שוב\./);
  assert.match(html, /href="\/sources\?account=samples-two">לבחור מקורות<\/a>/);
  assert.match(html, /action="\/new\/o-s2\/samples"[^]*?לנסות שוב/);
  assert.doesNotMatch(html, /כתבו לנו/);
  assert.ok(logs.some((m) => /\[onboarding\] o-s2 .*no samples written: nofacts/.test(m)), 'the log says why');

  // Sources that could not be read at all.
  ctx.samplesOpts = { read: async () => ({ docs: 0, sources: 1, failed: [{ name: 'Site s1', error: 'HTTP 403' }] }), build: builder([]), retryMs: 0 };
  await runSamples('o-s2');
  assert.match(await (await get('/new/o-s2', fake.session(customer(wsOf.get('o-s2'))).cookie)).text(), /לא הצלחנו לקרוא את המקורות שבחרתם/);
  assert.match(await (await get('/new/o-s2', fake.session(operator()).cookie)).text(), /Site s1: HTTP 403/, 'the operator reads the raw reason');
});

test('samples: an error is tried once more by itself; refused ones are followed by others; a partial success keeps what was written', async () => {
  const packId = await atSamples('o-s3', 'samples.three');
  const logs = [];
  ctx.log = (m) => logs.push(m);
  const calls = [];
  ctx.samplesOpts = { read: async () => ({ docs: 9, sources: 1, failed: [] }), build: builder(['throw', 'ok', 'refused', 'ok', 'ok', 'ok', 'ok'], calls), retryMs: 0 };
  await runSamples('o-s3');
  assert.deepEqual(calls, ['throw', 'ok', 'refused', 'ok', 'ok', 'ok', 'ok'], 'the error tried again, the refused one followed by another');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", packId).n, 5);
  assert.ok(logs.some((m) => /sample try 1 refused \(error\): model overloaded/.test(m)));
  assert.ok(logs.some((m) => /sample try 3 refused \(fact_check\)/.test(m)));

  // Two errors in a row: stopped, said, two good ones kept.
  const p2 = await atSamples('o-s4', 'samples.four');
  ctx.samplesOpts = { read: async () => ({ docs: 9, sources: 1, failed: [] }), build: builder(['ok', 'ok', 'throw', 'throw']), retryMs: 0 };
  await runSamples('o-s4');
  ctx.log = () => {};
  assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", p2).n, 2, 'the good ones are kept');
  const html = await (await get('/new/o-s4', fake.session(customer(wsOf.get('o-s4'))).cookie)).text();
  assert.match(html, /2 פוסטים לדוגמה מוכנים, והם כאן למטה\. משהו נתקע אצלנו באמצע הכתיבה\. אפשר לנסות שוב\./);

  // Three of five is enough: no warning.
  await atSamples('o-s5', 'samples.five');
  ctx.samplesOpts = { read: async () => ({ docs: 9, sources: 1, failed: [] }), build: builder(['ok', 'ok', 'ok', 'empty', 'empty']), retryMs: 0 };
  await runSamples('o-s5');
  assert.doesNotMatch(await (await get('/new/o-s5', fake.session(customer(wsOf.get('o-s5'))).cookie)).text(), /banner warn/);
  assert.equal(JSON.parse(db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-s5'").candidates_json).samples.made, 3);
});

test('samples: two rounds for each new account, six a month for the customer, none once it is live; the operator is not limited', async () => {
  // The rounds the tests above wrote are this workspace's month too: start it empty.
  db.run("UPDATE onboarding SET candidates_json = '{}' WHERE workspace_id = 31 AND status <> 'review'");
  const packId = await atSamples('o-r1', 'rounds.one', 31);
  const { cookie } = fake.session(customer(31));
  // One list of calls for every round: the stand-in names each sample by its call's number.
  const calls = [];
  const five = () => ({ read: async () => ({ docs: 9, sources: 1, failed: [] }), build: builder(['ok', 'ok', 'ok', 'ok', 'ok'], calls), retryMs: 0 });
  ctx.samplesOpts = five();
  await runSamples('o-r1');
  ctx.samplesOpts = five();
  await runSamples('o-r1');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM posts WHERE account_id = ? AND status = 'sample'", packId).n, 10);
  // A third press by the customer: refused, plainly, and the page offers no button for it.
  const third = await post('/new/o-r1/samples', cookie, {}, { ajax: true });
  assert.equal(third.status, 409);
  assert.match((await third.json()).message, /כבר כתבנו לחשבון הזה פוסטים לדוגמה 2 פעמים, וזה המקסימום לחשבון חדש\. אם צריך עוד דוגמאות, כתבו לנו\./);
  const page = await (await get('/new/o-r1', cookie)).text();
  assert.doesNotMatch(page, /עוד פוסטים לדוגמה/);
  assert.match(page, /וזה המקסימום לחשבון חדש/);
  // The operator may give one more, and it is not counted against the customer.
  ctx.samplesOpts = five();
  await post('/new/o-r1/samples', fake.session(operator()).cookie);
  await Promise.all([...__onboarding.running.values()]);
  const rounds = JSON.parse(db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-r1'").candidates_json).rounds;
  assert.deepEqual(rounds.map((x) => [x.by, x.counted !== false]), [['customer', true], ['customer', true], ['operator', false]]);

  // Live: no more samples, its posts come from the plan.
  db.update('onboarding', 'o-r1', { status: 'live' });
  const live = await post('/new/o-r1/samples', cookie, {}, { ajax: true });
  assert.equal(live.status, 409);
  assert.match((await live.json()).message, /החשבון כבר באוויר/);

  // Six rounds this month across the customer's new accounts: a new one's first press is refused too.
  const month = new Date().toISOString();
  db.insert('onboarding', { id: 'o-r-many', seed_json: {}, status: 'samples', workspace_id: 31, candidates_json: { rounds: Array.from({ length: 6 }, () => ({ at: month, by: 'customer' })) }, created_at: AT, updated_at: AT });
  // One account a subscription: the first is gone (taken out of the workspace), and the customer starts another.
  db.run('UPDATE accounts SET workspace_id = NULL WHERE id = ?', packId);
  await atSamples('o-r2', 'rounds.two', 31);
  const over = await post('/new/o-r2/samples', cookie, {}, { ajax: true });
  assert.equal(over.status, 409);
  assert.match((await over.json()).message, /החודש כבר כתבנו לכם פוסטים לדוגמה 6 פעמים/);
  // A round that broke on our side and wrote nothing is not the customer's.
  db.run("DELETE FROM onboarding WHERE id = 'o-r-many'");
  db.run("UPDATE onboarding SET candidates_json = '{}' WHERE workspace_id = 31 AND id <> 'o-r2'");
  ctx.samplesOpts = { read: async () => ({ docs: 9, sources: 1, failed: [] }), build: builder(['throw', 'throw']), retryMs: 0 };
  await runSamples('o-r2');
  const r2 = JSON.parse(db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-r2'").candidates_json).rounds;
  assert.deepEqual(r2.map((x) => x.counted), [false]);
  delete ctx.samplesOpts;
});
