import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { nextFreeSlot } from '../src/autonomy/runner.js';
import { writeNowJob } from '../src/web/write-now.js';
import { customer, fakeAccounts, listenFree, operator, opened, tempHome } from './helpers.js';

// "לכתוב פוסט עכשיו" and going live without samples, the operator's (the owner, 2026-11-07: "i want some opening posts
// for openfrequency. any way to generate them? maybe a developer code? i wont allow the demos because they dont have
// images").

let home;
let ctx;
let fake;
let server;
let base;

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'z'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/settings', cookie)).text())[1];
const post = async (p, cookie) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: await csrfOf(cookie) }) });

test("a post written now takes the account's next free slot, half an hour away at the earliest, never a taken one", () => {
  const pack = ctx.packs[0];
  const t = Date.parse('2026-11-08T08:00:00Z');
  const first = nextFreeSlot(ctx.db, pack, { t });
  assert.ok(first && Date.parse(first) >= t + 30 * 60_000, `a slot ahead: ${first}`);
  ctx.db.insert('posts', { id: 'p-wn-taken', account_id: pack.id, status: 'queued', slot_at: first, created_at: new Date(t).toISOString(), updated_at: new Date(t).toISOString() });
  const second = nextFreeSlot(ctx.db, pack, { t });
  assert.ok(second && second !== first && Date.parse(second) > Date.parse(first), 'the next one after it');
  ctx.db.run("DELETE FROM posts WHERE id = 'p-wn-taken'");
});

test('the button is the operator\'s in developer mode; a press writes one post for the next free slot, one at a time', async () => {
  const pack = ctx.packs[0];
  const op = fake.session(operator()).cookie;
  assert.doesNotMatch(await (await get('/accounts', op)).text(), /לכתוב פוסט עכשיו/, 'not without developer mode');
  assert.match(await (await get('/accounts', `${op}; of_dev=1`)).text(), new RegExp(`action="/accounts/${pack.id}/write"[^]*?לכתוב פוסט עכשיו`));
  const cust = fake.session(customer(1)).cookie;
  assert.equal((await post(`/accounts/${pack.id}/write`, cust)).status, 404, 'a customer has no such thing');

  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  ctx.writeNowBuild = async (_c, args) => (calls.push(args), await gate, { status: 'queued', postId: 'p-x' });
  const res = await post(`/accounts/${pack.id}/write`, op);
  assert.equal(res.status, 200);
  assert.match((await res.json()).message, /כותבים פוסט חדש/);
  const again = await post(`/accounts/${pack.id}/write`, op);
  assert.match((await again.json()).message, /כבר כותבים פוסט לחשבון הזה/, 'one at a time');
  release();
  await writeNowJob(pack.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pack.id, pack.id);
  assert.equal(calls[0].slotAt, nextFreeSlot(ctx.db, pack), 'for the next free slot');
  assert.ok(ctx.db.get("SELECT 1 FROM audit WHERE action = 'write_now'"), 'the press is in the audit');
  delete ctx.writeNowBuild;
});
