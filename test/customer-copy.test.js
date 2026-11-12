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
import { opened, paidWorkspaces, tempHome } from './helpers.js';

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

test('the Sources page says who adds a source, and Teder\'s own are marked as Teder\'s, the old general-knowledge name included', async () => {
  const { sourcesPage } = await import('../src/web/pages.js');
  const { MODEL_KEY, MODEL_WHY } = await import('../src/sources/model.js');
  const { WIKI_KEY } = await import('../src/sources/research.js');
  const at = '2026-11-01T10:00:00.000Z';
  const src = (key, extra = {}) => ({ id: key.length, key, type: 'web', url: 'https://example.test/', name: key, why: 'למה סומכים עליו', status: 'approved', approved_at: at, docs: 1, config: {}, ...extra });
  const sources = [src(MODEL_KEY, { name: 'ידע כללי של המודל', why: 'עובדות שהמודל מכיר בעצמו' }), src(WIKI_KEY), src('found-by-a-round', { config: { byTeder: true } }), src('chosen-by-them')];
  const html = sourcesPage({ csrf: 'x' }, { packs: [ctx.pack('demo')], current: ctx.pack('demo'), sources });
  assert.match(html, /<span class="sub">מכאן תדר לוקח את העובדות<\/span>/);
  assert.match(html, /חלק מהמקורות תדר מוסיף בעצמו, כמו ויקיפדיה/);
  assert.doesNotMatch(html, /רק מקור מאושר יכול לתמוך בעובדה|ידע כללי של המודל|שהמודל מכיר|יופיע ליד כל עובדה/);
  assert.ok(html.includes(MODEL_WHY.replace(/"/g, '&quot;')), 'the general knowledge says what it is, in words a customer reads');
  assert.equal((html.match(/נוסף על ידי תדר/g) || []).length, 3, "general knowledge, Wikipedia and the round's find");
  assert.equal((html.match(/אושר 1 בנוב׳/g) || []).length, 1, 'the one the customer chose');
});

test('money and plan wording: the paywall and the grace say the connections go 3 days after a stop; a thinned month says how the posts spread', async () => {
  const { GATE } = await import('../src/web/pages.js');
  const { PAY_HE } = await import('../src/web/ui.js');
  const { STOP_GRACE_DAYS } = await import('../src/billing/retention.js');
  const { schedulePanel } = await import('../src/web/schedule.js');
  assert.equal(STOP_GRACE_DAYS, 3, 'the copy below says 3');
  assert.match(GATE.unpaid.text, /החיבורים לטיקטוק, לאינסטגרם ולפייסבוק מתנתקים 3 ימים אחרי שתדר נעצר/);
  assert.doesNotMatch(GATE.unpaid.text, /כמו שהם/);
  assert.match(PAY_HE.due.text('יום שבת, 14 בנובמבר'), /3 ימים אחרי העצירה החיבורים לרשתות מתנתקים\.$/);
  const panel = (month) => schedulePanel({ csrf: 'x' }, { pack: { id: 'demo', meta: { displayName: 'עציץ ושמש' } }, byDay: {}, month: { rest: 0, rules: { shabbat: false, holidays: false }, shared: false, ...month } });
  // The small plan's 15 over a month of 27 posting days: one about every other day, never "one instead of two".
  const small = panel({ all: 51, days: 27, plan: 15, whole: 15 });
  assert.match(small, /החבילה שלכם היא 15 פוסטים בחודש, אז הפוסטים יתפזרו על כל החודש, בערך פוסט אחד כל יומיים\./);
  assert.doesNotMatch(small, /פוסט אחד במקום שניים/);
  // The full plan's 40 over the same days: every day still gets one.
  assert.match(panel({ all: 51, days: 27, plan: 40, whole: 40 }), /ולכן בחלק מהימים ייצא פוסט אחד במקום שניים\./);
});

test('Today asks for notifications while no device of a TikTok account gets them; an approval promises a notification only where one comes', async () => {
  const { todayPage } = await import('../src/web/pages.js');
  const { today } = await import('../src/web/data.js');
  const { approve } = await import('../src/web/actions.js');
  const { setSetting } = await import('../src/core/store.js');
  // Any day of the week, Shabbat too: the toast below is not about the day of rest. Paid, as a workspace that approves is.
  setSetting(ctx.db, 'schedule:demo', { shabbat: true, holidays: true });
  paidWorkspaces(ctx.db, [1]);
  const page = (c = {}) => todayPage({ csrf: 'x', quota: { out: 0, limit: 40 }, ...c }, { ...today(ctx), progressHtml: '' });
  assert.match(page(), /id="push-ask"[\s\S]*data-push-enable/);
  assert.doesNotMatch(page({ pushLater: true }), /id="push-ask"/, 'put away for 30 days');
  assert.doesNotMatch(page({ readOnly: true }), /id="push-ask"/);
  // With no device that gets notifications, an approval says when to publish, and promises no reminder.
  const again = () => ctx.db.update('posts', postId, { status: 'queued', publish_json: null, approved_at: null, approved_by: null, slot_at: new Date(Date.now() + 3 * 3_600_000).toISOString() });
  again();
  let r = approve(ctx, { id: 1, name: 'owner' }, { id: postId });
  await r.job;
  assert.match(r.message, /^אושר\. הטיוטה נשלחת לטיקטוק, ומפרסמים אותה מהאפליקציה ב-/);
  assert.doesNotMatch(r.message, /תזכורת|התראה|כששבת/);
  ctx.db.run("INSERT INTO push_subs (endpoint, user_id, workspace_id, created_at) VALUES ('https://push.example.test/one', 1, 1, ?)", new Date().toISOString());
  assert.doesNotMatch(page(), /id="push-ask"/, 'a device gets them: nothing to ask');
  again();
  r = approve(ctx, { id: 1, name: 'owner' }, { id: postId });
  await r.job;
  assert.match(r.message, /תגיע התראה לפרסם אותה\.$/);
  ctx.db.run('DELETE FROM push_subs');
  ctx.db.run("DELETE FROM settings WHERE key = 'schedule:demo'");
});
