import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { closeBrowser } from '../src/render/render.js';
import { addDays, israelDate } from '../src/schedule/israel.js';
import { customer, fakeAccounts, listenFree, opened, operator, tempHome } from './helpers.js';

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

test("a refused edit says each problem's place and what to do in Hebrew; the operator on their own pages keeps the checks' words", async () => {
  const { problemHe, problemsHe } = await import('../src/web/problems.js');
  assert.equal(problemHe({ where: 'cover', code: 'voice:register', msg: 'an exclamation mark' }), 'שקף הפתיחה: יש סימן קריאה. מורידים אותו.');
  assert.equal(problemHe({ where: 'slide 2 title', code: 'length', msg: 'the title is over 70 characters' }), 'שקף 2, הכותרת: הכותרת ארוכה מ-70 תווים.');
  assert.equal(problemHe({ where: 'facts', code: 'verify', msg: 'slide 3: the number 12 is not in the quotes it cites' }), 'שקף 3: המספר 12 לא מופיע בציטוט מהמקור. מוחקים אותו, או כותבים מספר שמופיע שם.');
  assert.equal(problemHe({ where: 'hashtags', code: 'caption', msg: '6 hashtags: 5 at most' }), 'ההאשטגים: יש 6 האשטגים, ואפשר עד 5.');
  assert.equal(problemHe({ where: 'caption', code: 'caption', msg: 'the TikTok caption is 40 characters: it needs 80 or more' }, { igCaption: true }), 'הכיתוב לטיקטוק: הכיתוב קצר מדי. יש בו 40 תווים, וצריך לפחות 80.');
  assert.equal(problemHe({ where: 'cover', code: 'voice:phrase', msg: 'an ad phrase: "הזדמנות של פעם בחיים"' }), 'שקף הפתיחה: יש ביטוי שנשמע כמו מודעה או כמו מכונה: "הזדמנות של פעם בחיים". כדאי לנסח אחרת.');
  // The reviewer's fact check: its own words when Hebrew, the general line when English.
  const { moreThanFactsHe } = await import('../src/web/problems.js');
  assert.equal(moreThanFactsHe('slide 2 title', { said: 'הטקסט אומר יותר מהעובדה' }), 'שקף 2, הכותרת: הטקסט אומר יותר מהעובדה');
  assert.equal(moreThanFactsHe('slide 2 title', { said: 'the text claims more than its fact' }), 'שקף 2, הכותרת: כתוב כאן יותר ממה שהעובדות של הפוסט אומרות. מנסחים קרוב יותר לעובדה.');
  // Anything without a line of its own: one general line at its place, and the same line once.
  const odd = problemsHe([{ where: 'cover', code: 'overlay', msg: 'one line of text: at least 3 on a slide' }, { where: 'cover', code: 'overlay', msg: 'another thing the overlay check says' }]);
  assert.deepEqual(odd, ['שקף הפתיחה: יש כאן ניסוח שהבדיקות שלנו לא מקבלות. נסו לנסח אחרת, ואם זה חוזר, כתבו לנו.']);

  const cookie = login();
  const _csrf = await csrfOf(cookie);
  const html = await refused(await plain(`/post/${postId}/edit`, cookie, { _csrf, hook: '5 דברים שקובעים אם הבזיליקום במרפסת ישרוד', sub: '', caption: 'בזיליקום הוא צמח של קיץ.', body_0: 'בזיליקום צריך לפחות 12 שעות שמש ישירה ביום.' }), 'the edit');
  const listed = /<div class="problems">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.match(listed, /שקף 1: המספר 12 לא מופיע בציטוט מהמקור/);
  assert.doesNotMatch(listed.replace(/<[^>]+>/g, ''), /[A-Za-z]{4,}/, 'no English in the problems a customer reads');

  // The operator, here on a laptop's address (their own pages), reads what the checks said.
  const op = fake.session(operator()).cookie;
  const opCsrf = await csrfOf(op);
  const res = await fetch(`${base}/post/${postId}/edit`, { method: 'POST', redirect: 'manual', headers: { cookie: op, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams({ _csrf: opCsrf, hook: '5 דברים שקובעים אם הבזיליקום במרפסת ישרוד', sub: '', caption: 'בזיליקום הוא צמח של קיץ.', body_0: 'בזיליקום צריך לפחות 12 שעות שמש ישירה ביום.' }).toString() });
  assert.match((await res.json()).problems.join(' '), /number 12 is not in the quotes/);
});

test('a post that moved on meanwhile is refused in words, never by its status code', async () => {
  const cookie = login();
  const _csrf = await csrfOf(cookie);
  const ajax = (p, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-of-ajax': '1' }, body: new URLSearchParams(body).toString() });
  ctx.db.update('posts', postId, { status: 'published', published_at: new Date().toISOString() });
  try {
    const approve = await (await ajax(`/post/${postId}/approve`, { _csrf })).json();
    assert.equal(approve.message, 'אי אפשר לאשר את הפוסט הזה. המצב שלו עכשיו: פורסם.');
    const reject = await (await ajax(`/post/${postId}/reject`, { _csrf, reason: 'other' })).json();
    assert.equal(reject.message, 'אי אפשר לדחות את הפוסט הזה. המצב שלו עכשיו: פורסם.');
    const edit = await (await ajax(`/post/${postId}/edit`, { _csrf, hook: 'x' })).json();
    assert.equal(edit.message, 'אי אפשר לערוך את הפוסט הזה. המצב שלו עכשיו: פורסם.');
    for (const m of [approve.message, reject.message, edit.message]) assert.doesNotMatch(m, /"published"|[A-Za-z]{4,}/);
  } finally {
    ctx.db.update('posts', postId, { status: 'queued', published_at: null });
  }
});

test('a paid workspace with no account yet: Today is one card that leads to setting it up, and the pages that need an account go there', async () => {
  const cookie = fake.session(customer(5)).cookie;
  const home = await (await get('/', cookie)).text();
  assert.match(home, /<h2>מתחילים כאן<\/h2>/);
  assert.match(home, /<a class="btn primary" href="\/new">[\s\S]*?להקים את החשבון<\/a>/);
  assert.doesNotMatch(home, /אין מה לאשר כרגע|class="kpis"|class="spend"/, 'no counts of zero, no "nothing to approve", no ring of 0 / 0');
  const accounts = await (await get('/accounts', cookie)).text();
  assert.match(accounts, /להקים את החשבון/, 'the account page leads there too, on a phone as well (no m-hide)');
  assert.doesNotMatch(accounts, /m-hide"><a class="btn sm" href="\/new">/);
  const sources = await get('/sources', cookie);
  assert.equal(sources.status, 303);
  assert.equal(sources.headers.get('location'), '/');
  // A workspace with its one account is offered no other: the switcher, the account page and More.
  const own = login();
  for (const p of ['/', '/accounts', '/more']) assert.doesNotMatch(await (await get(p, own)).text(), /href="\/new"/, p);
});
