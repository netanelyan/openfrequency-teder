import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { tick } from '../src/autonomy/runner.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { israelInstant } from '../src/schedule/israel.js';
import { customer, fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// Teder is managed on its dashboard only (the owner, 2026-11-02: "managing teder through whatsapp, only through the
// dashboard. the demo stays"): the runner tells the WhatsApp assistant (openfrequency-toran) nothing, even with
// OF_ASSISTANT_SECRET set and a post waiting for the customer, and Settings asks nobody to choose WhatsApp messages.

const SECRET = 'w'.repeat(48);
let home;
let ctx;
let db;
let fake;
let server;
let base;
let toran;
const heard = [];
const saved = {};

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'demo'");
  paidWorkspaces(db, [1]);
  // Where the assistant listened: anything reaching it is a message Teder would have had sent to WhatsApp.
  toran = http.createServer((req, res) => {
    heard.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => toran.listen(0, '127.0.0.1', r));
  for (const k of ['OF_ASSISTANT_SECRET', 'OF_TORAN_URL']) saved[k] = process.env[k];
  process.env.OF_ASSISTANT_SECRET = SECRET;
  process.env.OF_TORAN_URL = `http://127.0.0.1:${toran.address().port}/internal/teder/events`;
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'o'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise((r) => (server ? server.close(r) : r()));
  await new Promise((r) => (toran ? toran.close(r) : r()));
  await fake?.close();
  await closeBrowser();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });

test("the runner tells the WhatsApp assistant nothing: a post waiting for the customer is found by nobody and sent nowhere", async () => {
  const post = (await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' })).postId;
  assert.equal(loadPost(db, post).status, 'queued', 'a post waiting for the customer, the one post.ready used to tell');
  const r = await tick(ctx, { t: israelInstant('2026-10-13', '12:00').getTime() });
  assert.equal(r.assistant, undefined, 'no assistant pass in the report');
  assert.ok(!(r.errors || []).some((e) => e.step === 'assistant'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM assistant_events').n, 0, 'no event found');
  assert.deepEqual(heard, [], 'nothing reached the assistant');
});

test('Settings has no WhatsApp messages to choose, and the form it had is gone', async () => {
  const { cookie } = fake.session(customer(1));
  const html = await (await get('/settings', cookie)).text();
  assert.match(html, /<h2>מיילים<\/h2>/, 'the page itself, with its email choices');
  assert.doesNotMatch(html, /id="whatsapp"|הודעות בוואטסאפ|\/settings\/whatsapp|שעות שקטות/);
  assert.doesNotMatch(html, /העוזר של OpenFrequency בוואטסאפ/);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)[1];
  const r = await fetch(`${base}/settings/whatsapp`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, 'ev_post.ready': '1' }).toString() });
  assert.equal(r.status, 404, 'no such button any more');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM assistant_prefs").n, 0, 'nothing saved');
});
