import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, listenFree, opened, tempHome } from './helpers.js';

// One account's pages at a time: the switcher at the top picks it, a cookie keeps it, and a link that names an
// account (a post, ?account=) switches to that one. What waits in the others is counted on the switcher.

let home;
let server;
let base;
let otherPost;
let fake;

before(async () => {
  home = tempHome({
    packs: {
      demo: null,
      second: (f) => {
        f.theme.template = 'poster';
        f.theme.fonts.display = 'Secular One';
        Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
      },
    },
  });
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  otherPost = (await buildPost(ctx, { pack: ctx.pack('second'), formatKey: 'care-guide' })).postId;
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'x'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

// Both accounts are one workspace's, and the session is its owner's.
const login = async () => fake.session(customer(1)).cookie;
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const acct = (res) => /of_acct=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1] || null;

test('the site shows one account; the switcher lists them all and counts what waits in the others', async () => {
  const cookie = await login();
  const html = await (await get('/', cookie)).text();
  assert.match(html, /<details class="acctswitch">\s*<summary aria-label="החשבון: [^"]+\. החלפת חשבון"><span class="ic"><span class="dot acc-demo"/, 'the first account is shown');
  assert.match(html, /<b class="badge num" title="מחכים לאישור בחשבונות האחרים" aria-label="1 מחכים בחשבונות האחרים">1<\/b>/);
  assert.match(html, /name="to" value="second"><button type="submit" title="@second.test">/);
  assert.doesNotMatch(html, new RegExp(otherPost), "the other account's post is not on this account's home");
  assert.doesNotMatch(html, /class="acctab"/, 'no table of every account on home');
});

test('a switch keeps the page it was made on, and a post or ?account= switches to its account', async () => {
  const cookie = await login();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get('/results', cookie)).text())[1];
  const res = await fetch(`${base}/account/switch`, { method: 'POST', redirect: 'manual', headers: { cookie, referer: `${base}/results`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, to: 'second' }).toString() });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/results');
  assert.equal(acct(res), 'second');

  const both = `${cookie}; of_acct=second`;
  const homeHtml = await (await get('/', both)).text();
  assert.match(homeHtml, new RegExp(otherPost), "the shown account's post is on its home");

  assert.equal(acct(await get(`/post/${otherPost}`, cookie)), 'second', "opening a post shows its account's pages");
  const src = await get('/sources?account=second', cookie);
  assert.equal(acct(src), 'second');
  assert.doesNotMatch(await src.text(), /<nav class="tabs" aria-label="חשבונות">/, 'no tabs between accounts');
  // An account that does not exist is not a switch.
  const bad = await fetch(`${base}/account/switch`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, to: 'nope' }).toString() });
  assert.equal(acct(bad), null);
});

test('the page of every account lists them all and approves what it listed, nothing drafted since', async () => {
  const cookie = await login();
  const html = await (await get('/all', cookie)).text();
  assert.match(html, /<summary aria-label="כל החשבונות\. מעבר לחשבון אחד">/, 'the switcher says it is every account');
  for (const id of ['demo', 'second']) assert.ok(html.includes(`<a class="r" role="row" href="/?account=${id}">`), `${id} has its line`);
  assert.match(html, new RegExp(`id="all-${otherPost}" data-post`), "another account's post waits on this page");
  assert.match(await (await get('/', cookie)).text(), /<a class="to" href="\/all">/, 'the switcher opens it');

  const listed = [...html.matchAll(/<div class="qrow" id="all-([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(listed.length >= 1);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
  const send = (ids) => fetch(`${base}/posts/approve-all`, { method: 'POST', redirect: 'manual', headers: { cookie, 'x-of-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ids }).toString() });
  const res = await send([...listed, 'not-a-post', '../x'].join(','));
  const out = await res.json();
  assert.equal(res.status, 200, out.message);
  assert.match(out.message, new RegExp(listed.length === 1 ? 'פוסט אחד אושר' : `${listed.length} פוסטים אושרו`));
  assert.doesNotMatch(await (await get('/all', cookie)).text(), /<div class="qrow"/, 'nothing waits once all are approved');
  // Sent again, nothing waits any more: an answer, not a second approval.
  const again = await send(listed.join(','));
  assert.equal(again.status, 400);
});
