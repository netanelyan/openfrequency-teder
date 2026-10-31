import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { SAMPLE_ENOUGH, SAMPLE_TARGET, samplesLine } from '../src/web/onboarding.js';
import { customer, fakeAccounts, opened, tempHome } from './helpers.js';

// A new account goes on with three samples that passed (the owner, 2026-10-31, asked whether setup could finish at 3
// instead of 5: "ok"). A press still asks for five; three are enough for "עברתי על הדוגמאות" and then going live.

let home;
let db;
let fake;
let server;
let base;

before(async () => {
  home = tempHome();
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run("UPDATE accounts SET workspace_id = 1, status = 'onboarding' WHERE id = 'demo'");
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 't'.repeat(40), ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  server?.close();
  await fake?.close();
  home?.cleanup();
});

const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (p, cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get(p, cookie)).text())[1];
const post = async (p, cookie) =>
  fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: await csrfOf('/new/o-3', cookie) }).toString() });
const sample = (i) => {
  const at = new Date().toISOString();
  db.insert('posts', { id: `p-3-${i}`, account_id: 'demo', status: 'sample', sample: 1, hook: `דוגמה ${i}`, created_at: at, updated_at: at });
};
const stage = () => db.get("SELECT status FROM onboarding WHERE id = 'o-3'").status;

test('the line over the samples: how many passed, and under three that it takes three', () => {
  assert.deepEqual([SAMPLE_TARGET, SAMPLE_ENOUGH], [5, 3], 'a press asks for five, three are enough');
  assert.equal(samplesLine(0), 'צריך לפחות 3 דוגמאות שעוברות את כל הבדיקות כדי להמשיך.');
  assert.equal(samplesLine(1), 'דוגמה אחת עברה את כל הבדיקות. צריך לפחות 3 כדי להמשיך.');
  assert.equal(samplesLine(2), '2 דוגמאות עברו את כל הבדיקות. צריך לפחות 3 כדי להמשיך.');
  assert.equal(samplesLine(3), '3 דוגמאות עברו את כל הבדיקות.');
  assert.equal(samplesLine(6), '6 דוגמאות עברו את כל הבדיקות.');
});

test('two samples are not enough to go on; the third opens "עברתי על הדוגמאות", and then the account goes live', async () => {
  const at = new Date().toISOString();
  db.insert('onboarding', { id: 'o-3', seed_json: { niche: 'אפייה', examples: [] }, status: 'samples', workspace_id: 1, pack_id: 'demo', candidates_json: { candidates: [], formats: [], said: [] }, created_at: at, updated_at: at });
  const { cookie } = fake.session(customer(1));
  sample(1);
  sample(2);
  let html = await (await get('/new/o-3', cookie)).text();
  assert.match(html, /2 דוגמאות עברו את כל הבדיקות\. צריך לפחות 3 כדי להמשיך\./);
  assert.doesNotMatch(html, /action="\/new\/o-3\/reviewed"/, 'no button with two');
  assert.match(html, /לפני שיש לפחות שלושה פוסטים לדוגמה ועברתם עליהם/);
  const refused = await post('/new/o-3/reviewed', cookie);
  assert.equal(refused.status, 303);
  assert.match(decodeURIComponent(refused.headers.get('set-cookie') || ''), /צריך לפחות 3 דוגמאות שעברו את הבדיקות, יש 2/);
  assert.equal(stage(), 'samples', 'not marked with two');
  const early = await post('/new/o-3/live', cookie);
  assert.match(decodeURIComponent(early.headers.get('set-cookie') || ''), /קודם עוברים על הדוגמאות/);
  assert.equal(db.get("SELECT status FROM accounts WHERE id = 'demo'").status, 'onboarding');

  sample(3);
  html = await (await get('/new/o-3', cookie)).text();
  assert.match(html, /<p class="muted small m0">3 דוגמאות עברו את כל הבדיקות\.<\/p>/);
  assert.match(html, /action="\/new\/o-3\/reviewed"/, 'the button with three');
  assert.doesNotMatch(html, /חמישה פוסטים|חמש הדוגמאות|מתוך 5/, 'nothing promises five');
  assert.equal((await post('/new/o-3/reviewed', cookie)).status, 303);
  assert.equal(stage(), 'ready');
  assert.equal((await post('/new/o-3/live', cookie)).status, 303);
  assert.equal(stage(), 'live');
  assert.deepEqual({ ...db.get("SELECT status, mode FROM accounts WHERE id = 'demo'") }, { status: 'active', mode: 'approve' });
});
