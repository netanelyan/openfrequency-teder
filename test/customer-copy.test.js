import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { buildPost } from '../src/pipeline/build.js';
import { step } from '../src/core/store.js';
import { closeBrowser } from '../src/render/render.js';
import { postFull, results } from '../src/web/data.js';
import { postCard, postPage, resultsPage } from '../src/web/pages.js';
import { reasonHe } from '../src/web/ui.js';
import { opened, tempHome } from './helpers.js';

// What a customer reads on a post, from the audit of 2026-11-12 (P1-1 to P1-8): no step codes, vendors, licences,
// reviewer names or publishers' errors, a takedown form that asks rather than says one came, and every platform's line
// after a notice in Hebrew. The operator, on their own pages, keeps what the engine said.

let home;
let ctx;
let postId;
const customer = { csrf: 'x' };
const operator = { csrf: 'x', operator: true };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');

before(async () => {
  home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  db.run('UPDATE accounts SET workspace_id = 1');
  postId = (await buildPost(ctx, { pack: ctx.pack('demo'), formatKey: 'care-guide' })).postId;
  // Steps the trace printed raw, and the details a customer was shown: a publisher, a licence, a reviewer.
  step(db, postId, 'mode', 'ok', { mode: 'photo' });
  step(db, postId, 'model_facts', 'ok', { subject: 'זמיוקולקס' });
  step(db, postId, 'tiktok', 'ok', { flow: 'draft', via: 'zernio' });
  step(db, postId, 'image', 'ok', { provider: 'pexels', license: 'Pexels License' });
  step(db, postId, 'review', 'ok', { reviewer: 'claude', worst: 3 });
  db.update('posts', postId, { review_score: 2 });
});

after(async () => {
  await closeBrowser();
  home?.cleanup();
});

test('how a post was made: the steps are the operator\'s, a customer reads when it was written and how its facts were checked', () => {
  const d = postFull(ctx, postId);
  const mine = postPage(customer, d);
  assert.doesNotMatch(mine, /<ol class="trace">/, 'no steps');
  assert.match(mine, /<h2>איך הפוסט נוצר<\/h2><\/header><p class="muted m0">נכתב ב-[^<]*\d+ עובדות נבדקו מול המקורות, מילה במילה\./);
  for (const leak of ['>mode<', 'model_facts', 'דרך zernio', 'Pexels License', 'pexels,', 'Claude', 'בודק:', 'רינדור', 'לתור', 'שער העובדות', 'תבנית השער', 'מילות חיפוש', 'במכסה', 'נשמע כמו בוט']) assert.ok(!mine.includes(leak), leak);
  const ops = postPage(operator, d);
  assert.match(ops, /<ol class="trace">/);
  assert.match(ops, /סוג העיצוב/, 'a step the trace knows by name');
  assert.match(ops, /דרך zernio/, 'the operator reads what each step did');
  assert.match(ops, /<dt>שער העובדות<\/dt>/);
});

test('a card and a post say no bot score to a customer; one fact unverified is said in the singular', () => {
  const d = postFull(ctx, postId);
  assert.doesNotMatch(postCard(customer, d.post, d.pack), /נשמע כמו בוט/);
  assert.match(postCard(operator, d.post, d.pack), /נשמע כמו בוט/);
  const one = { ...d.post, facts: d.post.facts.map((f, i) => (i === 0 ? { ...f, verified: false } : f)) };
  const used = one.slides.filter((s) => s.kind === 'item').flatMap((s) => s.factKeys);
  if (used.includes(one.facts[0].key)) assert.match(postCard(customer, one, d.pack), /עובדה אחת לא אומתה/);
});

test('a fact whose source is waiting or removed says so in words, and a failed check in Hebrew', () => {
  const d = postFull(ctx, postId);
  const used = new Set(d.post.slides.flatMap((s) => s.factKeys));
  const facts = d.post.facts.map((f) => (used.has(f.key) ? { ...f, source_status: 'pending', error: 'the quote is not in the source document, word for word' } : f));
  const page = postPage(customer, { ...d, post: { ...d.post, facts } });
  assert.match(page, /מקור שעוד לא אישרתם/);
  assert.match(page, /העובדה הזו לא עברה את הבדיקה מול המקור/);
  assert.doesNotMatch(page, /מקור pending|word for word/);
  assert.match(postPage(operator, { ...d, post: { ...d.post, facts } }), /word for word/);
});

test('a TikTok draft that did not arrive says why in Hebrew; Zernio\'s own words are the operator\'s', () => {
  const d = postFull(ctx, postId);
  const post = { ...d.post, status: 'approved', publish: { tiktok: { via: 'zernio', error: 'Zernio 502: upstream TikTok API timeout (request_id 7f3a)', tries: 1 } } };
  const mine = postPage(customer, { ...d, post });
  assert.match(mine, /הטיוטה לא הגיעה לטיקטוק/);
  assert.doesNotMatch(mine, /Zernio 502|upstream|request_id/);
  assert.match(postPage(operator, { ...d, post }), /Zernio 502/);
  // A draft in the inbox before its hour: a sentence, not "טיקטוק: בטיוטות של טיקטוק".
  const drafted = { ...d.post, status: 'approved', publish: { tiktok: { via: 'zernio', flow: { mode: 'now', state: 'waiting', remindedAt: null } } } };
  const page = postPage(customer, { ...d, post: drafted });
  assert.match(page, /<b>הטיוטה בתיבת הטיוטות בטיקטוק<\/b>/);
  assert.doesNotMatch(page, /טיקטוק: /);
});

test('a published post asks whether a takedown notice came; one recorded says in Hebrew what to do on each platform', () => {
  const d = postFull(ctx, postId);
  const published = { ...d.post, status: 'published', published_at: new Date().toISOString(), publish: { tiktok: { via: 'zernio', zernioId: 'z1', status: 'published' } } };
  const page = postPage(customer, { ...d, post: published, takedowns: [] });
  assert.match(page, /קיבלתם הודעת הסרה על הפוסט הזה\?/);
  assert.doesNotMatch(page, /התקבלה הודעת הסרה|<h2>הודעות הסרה<\/h2>/, 'no heading, and no line saying one came, while none did');
  assert.ok(page.indexOf('id="takedown"') > page.indexOf('איך הפוסט נוצר'), 'the form is at the end of the page, out of the facts');
  const notice = { id: 7, received_at: new Date().toISOString(), claimant: 'Smith & Co Law', notice: 'Please remove the post, it uses our photograph.', deleted: { tiktok: { state: 'by_hand', why: 'TikTok has no delete for a published post through any official API: delete it in the TikTok app' }, instagram: { state: 'by_hand', why: 'delete it in the Instagram app (Instagram Login has no delete through the API)' }, facebook: { state: 'by_hand', why: 'Zernio did not take it down: 500' } }, waiting: [] };
  const down = { ...published, status: 'taken_down', reason: 'הודעת הסרה מאת Smith & Co Law: Please remove the post, it uses our photograph.' };
  const mine = postPage(customer, { ...d, post: down, takedowns: [notice] }).replace(/&quot;/g, '"');
  assert.match(mine, /<h2>הודעות הסרה<\/h2>/);
  assert.match(mine, /בטיקטוק אי אפשר למחוק פוסט מבחוץ\. מוחקים אותו באפליקציה של טיקטוק ולוחצים כאן "מחקתי ידנית"\./);
  assert.match(mine, /מוחקים אותו באפליקציה של אינסטגרם ולוחצים כאן/);
  assert.match(mine, /לא הצלחנו למחוק אותו בעצמנו\. מוחקים אותו בעמוד הפייסבוק/);
  assert.doesNotMatch(mine, /TikTok has no delete|Instagram Login|did not take it down/);
  assert.ok(mine.includes('Please remove the post'), 'the notice the customer recorded is shown as it was, in its own letters');
  assert.equal(reasonHe(customer, 'taken_down', down.reason), down.reason, "a takedown's reason is the customer's own words");
  assert.match(postPage(operator, { ...d, post: down, takedowns: [notice] }), /TikTok has no delete/);
});

test("a post our checks stopped says so in one line to a customer; a decline in the customer's own English is theirs", () => {
  assert.equal(reasonHe(customer, 'blocked', 'אין תמונה מורשית של X: נחשו-מי צריך פנים לטשטש על השער'), 'הבדיקות שלנו עצרו את המצגת הזו בזמן הכתיבה, ולכן היא לא תעלה.');
  assert.equal(reasonHe(customer, 'blocked', 'נשמע כמו בוט (7/10) גם אחרי שכתוב'), 'הבדיקות שלנו עצרו את המצגת הזו בזמן הכתיבה, ולכן היא לא תעלה.');
  assert.match(reasonHe(customer, 'blocked', 'בדיקת העובדות עצרה את המצגת לפני השליחה: עובדה בה כבר לא תואמת למקור שלה, או שהמקור הוסר. המצגת לא תעלה.'), /^בדיקת העובדות עצרה/, 'the fact check says what happened');
  assert.equal(reasonHe(customer, 'rejected', 'משהו אחר: too long, make it shorter'), 'משהו אחר: too long, make it shorter');
  assert.equal(reasonHe(operator, 'blocked', 'נשמע כמו בוט (7/10) גם אחרי שכתוב'), 'נשמע כמו בוט (7/10) גם אחרי שכתוב');
});

test('Results: a customer reads what their posts did; the formats, the blocks and the morning feedback are the operator\'s', () => {
  const d = results(ctx);
  const mine = text(resultsPage({ csrf: 'x', quota: { out: 0, limit: 40 } }, d));
  for (const leak of ['YOUTUBE_API_KEY', 'מה חוסם פוסטים', 'המשוב של הבוקר', 'פורמטים מוכחים']) assert.ok(!mine.includes(leak), leak);
  const ops = resultsPage({ csrf: 'x', operator: true, quota: { out: 0, limit: 40 } }, d);
  assert.match(ops, /id="formats"/);
  assert.doesNotMatch(ops, /YOUTUBE_API_KEY/, 'the variable is named only in developer mode');
});
