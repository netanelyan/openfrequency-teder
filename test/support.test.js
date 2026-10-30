import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { pauseAccount } from '../src/autonomy/rails.js';
import { publishErrorHe } from '../src/publish/errors.js';
import { errorPage } from '../src/web/pages.js';
import { supportUrl, withSupport } from '../src/web/ui.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, opened, tempHome } from './helpers.js';

// "כתבו לנו" with a way to write: OpenFrequency's WhatsApp (OF_SUPPORT_WA, the same value as accounts'), a wa.me link
// where a page shows the words. Unset, the words stay as they were. A toast, a push and an email never get a link.
//
// demo is workspace 1's.

const NUMBER = '972500000001';
const LINK = `<a href="https://wa.me/${NUMBER}" target="_blank" rel="noopener noreferrer">כתבו לנו</a>`;
const UNCONFIRMED = publishErrorHe({ code: 'unconfirmed' });

let home;
let ctx;
let db;
let fake;
let server;
let base;
let postId;

before(async () => {
  delete process.env.OF_SUPPORT_WA;
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run('UPDATE accounts SET workspace_id = 1');
  postId = (await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' })).postId;
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 's'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

afterEach(() => {
  delete process.env.OF_SUPPORT_WA;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

test('our WhatsApp is a wa.me link from international digits, and nothing from anything else', () => {
  assert.equal(supportUrl({}), null);
  assert.equal(supportUrl({ OF_SUPPORT_WA: '' }), null);
  assert.equal(supportUrl({ OF_SUPPORT_WA: NUMBER }), `https://wa.me/${NUMBER}`);
  assert.equal(supportUrl({ OF_SUPPORT_WA: '+972 50-000-0001' }), `https://wa.me/${NUMBER}`, 'as people write it');
  for (const bad of ['050-0000001', '12345', 'wa.me/972500000001', '9725000000011234567']) assert.equal(supportUrl({ OF_SUPPORT_WA: bad }), null, bad);

  // The line is escaped either way; only the words become the link.
  const line = 'a <b> & "x". כתבו לנו ונבדוק.';
  assert.equal(withSupport(line, {}), 'a &lt;b&gt; &amp; &quot;x&quot;. כתבו לנו ונבדוק.');
  assert.equal(withSupport(line, { OF_SUPPORT_WA: NUMBER }), `a &lt;b&gt; &amp; &quot;x&quot;. ${LINK} ונבדוק.`);
  assert.equal(withSupport('אין כאן מה לכתוב.', { OF_SUPPORT_WA: NUMBER }), 'אין כאן מה לכתוב.');
});

test('the error page: the words as before without the number, a link to our WhatsApp with it', () => {
  const plain = errorPage({ kind: 'broken' });
  assert.match(plain, /אם זה חוזר, כתבו לנו ונבדוק\./);
  assert.doesNotMatch(plain, /wa\.me/);
  process.env.OF_SUPPORT_WA = NUMBER;
  assert.ok(errorPage({ kind: 'broken' }).includes(`אם זה חוזר, ${LINK} ונבדוק.`));
  // An ActionError's own words on the page get it too.
  assert.ok(errorPage({ kind: 'broken', text: 'לא הצלחנו ליצור את החשבון הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו לנו.' }).includes(`ואם זה חוזר ${LINK}.`));
});

test('an account only we turn back on, a post that did not go out, a search that stopped: the link where the page shows the words', async () => {
  const { cookie } = fake.session(customer(1));
  // A strike, with what the customer reads about the post that caused it.
  pauseAccount(db, 'demo', 'strike', UNCONFIRMED);
  db.run("UPDATE posts SET status = 'failed', reason = ? WHERE id = ?", UNCONFIRMED, postId);
  const at = new Date().toISOString();
  db.insert('onboarding', { id: 'o-stopped', seed_json: { niche: 'צילום' }, status: 'failed', candidates_json: { failure: 'restart' }, workspace_id: 1, created_at: at, updated_at: at });
  const pages = { accounts: '/accounts', home: '/', post: `/post/${postId}`, search: '/new/o-stopped' };

  for (const [what, p] of Object.entries(pages)) {
    const html = await (await get(p, cookie)).text();
    assert.match(html, /כתבו לנו/, what);
    assert.doesNotMatch(html, /wa\.me/, `${what}: no number, no link`);
  }
  process.env.OF_SUPPORT_WA = NUMBER;
  const read = async (p) => (await get(p, cookie)).text();
  const accounts = await read(pages.accounts);
  assert.ok(accounts.includes(`את החשבון הזה מפעילים מחדש רק אנחנו. ${LINK} ונבדוק יחד מה קרה.`), 'the account only we turn back on');
  assert.ok(accounts.includes(`ואם היא לא שם, ${LINK}.`), "the pause's detail");
  assert.ok((await read(pages.home)).includes(`ואם היא לא שם, ${LINK}.`), "the home page's banner");
  assert.ok((await read(pages.post)).includes(`ואם היא לא שם, ${LINK}.`), "the post's reason");
  assert.ok((await read(pages.search)).includes(`אם זה חוזר, ${LINK} ונבדוק.`), 'the search that stopped');

  // The button's answer is a toast, which shows text: the words alone.
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await read('/settings'))[1];
  const res = await fetch(`${base}/accounts/demo/resume`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: csrf }).toString() });
  assert.equal(res.status, 403);
  const { message } = await res.json();
  assert.match(message, /כתבו לנו ונבדוק יחד/);
  assert.doesNotMatch(message, /<a|wa\.me/);
});
