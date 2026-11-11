import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { addDays, israelDate } from '../src/schedule/israel.js';
import { customer, fakeAccounts, listenFree, opened, tempHome } from './helpers.js';

// A form its checks refuse, sent as a browser without the page's script sends it (a plain POST, no x-of-ajax): the
// page comes back, 422, with the problems and what the customer typed, never "משהו השתבש אצלנו". The audit of
// 2026-11-12 found every one of them ending on the error page (a ReferenceError in src/web/server.js: the page's
// context read the header and the toast before they were declared), because the tests only ever sent them as ajax.

let home;
let ctx;
let server;
let base;
let fake;
let postId;

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run('UPDATE accounts SET workspace_id = 1');
  fake = await fakeAccounts();
  postId = (await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' })).postId;
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

const login = () => fake.session(customer(1)).cookie;
const get = (p, cookie) => fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie } });
const csrfOf = async (cookie) => /name="_csrf" value="([^"]+)"/.exec(await (await get('/accounts', cookie)).text())[1];
/** A form as the browser sends it without the script: no x-of-ajax, the page's own origin. */
const plain = (p, cookie, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

/** A refused form's answer: 422, the page in Hebrew with the problems, and none of the error page. */
async function refused(res, what) {
  assert.equal(res.status, 422, what);
  assert.match(res.headers.get('content-type'), /^text\/html/, what);
  const html = await res.text();
  assert.match(html, /<html lang="he" dir="rtl"/, what);
  assert.doesNotMatch(html, /משהו השתבש אצלנו/, `${what}: not the error page`);
  assert.match(html, /class="problems"/, `${what}: the problems are listed`);
  return html;
}

test('a refused edit comes back as the post page, with the problems and every field as it was typed', async () => {
  const cookie = login();
  const _csrf = await csrfOf(cookie);
  const before = ctx.db.get('SELECT title, body FROM slides WHERE post_id = ? AND idx = 1', postId);
  const typed = { title_0: 'בזיליקום אוהב שמש, והרבה ממנה: לפחות חצי יום, בכל יום, גם בחורף כשקר בחוץ', body_0: 'בזיליקום צריך לפחות 12 שעות שמש ישירה ביום.' };
  const res = await plain(`/post/${postId}/edit`, cookie, { _csrf, hook: '5 דברים שקובעים אם הבזיליקום במרפסת ישרוד', sub: '', caption: 'בזיליקום הוא צמח של קיץ.', ...typed });
  const html = await refused(res, 'the edit');
  assert.match(html, /<details class="panel edit" id="edit" open>/, 'the edit form is open');
  assert.match(html, /השינוי לא נשמר, הבדיקות עצרו אותו/);
  assert.ok(html.includes(`value="${typed.title_0}"`), 'the title as it was typed');
  assert.ok(html.includes(`>${typed.body_0}</textarea>`), 'the text as it was typed');
  assert.deepEqual({ ...ctx.db.get('SELECT title, body FROM slides WHERE post_id = ? AND idx = 1', postId) }, { ...before }, 'nothing was saved');
});

test("the edit form's fields take no more than the checks accept: a title of 70, a text of 260", async () => {
  const html = await (await get(`/post/${postId}`, login())).text();
  assert.match(html, /name="title_0" value="[^"]*" maxlength="70"/);
  assert.match(html, /<textarea name="body_0" maxlength="260">/);
  assert.doesNotMatch(html, /name="title_\d+"[^>]*maxlength="80"|name="body_\d+" maxlength="300"/);
});

test('a refused source, fact, topic, rival and sound each come back as their page, with the problems and what was typed', async () => {
  const cookie = login();
  const _csrf = await csrfOf(cookie);
  const today = israelDate(Date.now());

  const source = await refused(await plain('/sources/add', cookie, { _csrf, account: 'demo', name: 'אתר הגינון של השכונה', url: 'not a link', type: 'web', why: 'קצר' }), 'a source');
  assert.ok(source.includes('value="אתר הגינון של השכונה"'), "the source's name as it was typed");
  assert.match(source, /הכתובת לא נראית כמו קישור/);

  const fact = await refused(await plain('/facts/add', cookie, { _csrf, account: 'demo', topic: '', quote: 'בזיליקום הוא צמח חד שנתי שגדל בקיץ.', source: 'משרד החקלאות', url: 'https://www.gov.il/he/departments/ministry_of_agriculture', checkedAt: today, expires: addDays(today, 365) }), 'a fact');
  assert.ok(fact.includes('בזיליקום הוא צמח חד שנתי שגדל בקיץ.'), 'the quote as it was typed');
  assert.match(fact, /צריך נושא/);

  const topic = await refused(await plain('/topics/add', cookie, { _csrf, account: 'demo', title: 'א', why: 'כי כולם גידלו בזיליקום בקיץ הזה', url: '' }), 'a topic');
  assert.ok(topic.includes('כי כולם גידלו בזיליקום בקיץ הזה'), 'why it went viral, as it was typed');
  assert.match(topic, /נושא צריך לפחות כמה מילים/);

  const rival = await refused(await plain('/rivals/save', cookie, { _csrf, account: 'demo', handle: 'not a handle!', platform: 'tiktok', hooks: '', formats: '', times: '', gaps: 'אף אחד לא מדבר על עציצים בצל' }), 'a rival');
  assert.ok(rival.includes('אף אחד לא מדבר על עציצים בצל'), 'what they do not give, as it was typed');

  const sound = await refused(await plain('/sounds/save', cookie, { _csrf, account: 'demo', name: '', artist: 'הלהקה של השכונה', link: '' }), 'a sound');
  assert.ok(sound.includes('value="הלהקה של השכונה"'), 'the artist as it was typed');
  assert.match(sound, /שם הסאונד/);
});
