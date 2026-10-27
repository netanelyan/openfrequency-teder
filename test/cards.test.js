import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPage, needsYou, postCard, postPage, postsPage, typeHe } from '../src/web/pages.js';
import { timeHe } from '../src/web/ui.js';

// The post cards a customer reads: a slideshow still being written is one plain line, and a ready one says in plain
// words when it goes up, what kind it is, the text that goes with it and where its facts come from. The operator
// keeps the details (the pack's format name, the facts block at 0, the full card while it is written).

const pack = { id: 'demo', meta: { displayName: 'עציצים', handle: 'demo' }, formats: { formats: [{ id: 'explainer', name: 'איך זה עובד' }, { id: 'odd-one', name: 'משהו של החבילה' }] } };
const customerCtx = { csrf: 'x', operator: false };
const operatorCtx = { csrf: 'x', operator: true };
const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const fact = { key: 'f1', claim: 'מונסטרה צריכה אור עקיף', quote: 'Monstera prefers bright, indirect light', doc_url: 'https://example.test/monstera', source_name: 'Example', doc_fetched_at: '2026-10-01T10:00:00Z', source_status: 'approved', verified: true };

function readyPost(over = {}) {
  return {
    id: 'p1',
    account_id: 'demo',
    status: 'queued',
    sample: 0,
    slot_at: soon,
    format_id: 'explainer',
    kind: 'list',
    hook: 'ככה מונסטרה גדלה באמת',
    sub: '',
    caption: 'שלושה דברים על מונסטרה',
    hashtags: ['#מונסטרה'],
    checks: {},
    data: {},
    publish: {},
    updated_at: '2026-10-27T08:00:00Z',
    review_score: null,
    media: { tiktok: ['0.png', '1.png', '2.png'] },
    slides: [
      { kind: 'cover', title: '', body: '', factKeys: [] },
      { kind: 'item', title: 'אור', body: 'אור עקיף', factKeys: ['f1'] },
      { kind: 'closer', title: '', body: '', factKeys: [] },
    ],
    facts: [fact],
    ...over,
  };
}

const drafting = (over = {}) => readyPost({ status: 'drafting', slot_at: null, hook: null, caption: null, hashtags: [], media: {}, slides: [], facts: [], ...over });

test('a slideshow still being written is one plain card for the customer: no edit, text, facts or time', () => {
  for (const post of [drafting(), readyPost({ media: {}, slides: [], facts: [] }), drafting({ sample: 1 })]) {
    const html = postCard(customerCtx, post, pack);
    assert.match(html, /מצגת חדשה בכתיבה/);
    assert.match(html, /תהיה מוכנה בעוד כמה דקות/);
    assert.match(html, /class="ph"/, 'a placeholder slide');
    for (const gone of ['#edit', 'לערוך', 'עריכה', 'הטקסט שעולה עם המצגת', 'הכיתוב', 'מאיפה העובדות', 'עובדות ומקורות', 'class="when', 'בלי שעה', 'איך זה עובד', 'אישור', 'דחייה']) {
      assert.ok(!html.includes(gone), `${gone} is not on a card still being written`);
    }
  }
});

test('the operator still sees the whole card while it is written', () => {
  const html = postCard(operatorCtx, drafting(), pack);
  assert.ok(!html.includes('מצגת חדשה בכתיבה'));
  assert.match(html, /איך זה עובד/, 'the pack format name');
  assert.match(html, /מאיפה העובדות \(0\)/, 'the facts block, even at 0');
  assert.match(html, /בכתיבה/, 'the status chip');
  assert.ok(!html.includes('#edit'), 'a post being written cannot be edited, not even by the operator');
});

test('a ready card says when it goes up, what kind it is, its text and where its facts come from', () => {
  const html = postCard(customerCtx, readyPost(), pack);
  assert.match(html, new RegExp(`<span class="when num">תעלה ב-${timeHe(soon)}</span>`));
  assert.match(html, /<span class="fmt">סוג: הסבר בכמה שלבים<\/span>/);
  assert.ok(!html.includes('איך זה עובד'), 'the pack format name is the operator\'s');
  assert.match(html, /הטקסט שעולה עם המצגת/);
  assert.match(html, /מאיפה העובדות \(1\)/);
  assert.match(html, /href="\/post\/p1#edit">[\s\S]*?לערוך<\/a>/);
  assert.match(html, /מחכה לאישור/, 'the status chip');
  for (const gone of ['בלי שעה', 'הכיתוב', 'עובדות ומקורות', 'עריכה<']) assert.ok(!html.includes(gone), gone);
});

test('the time says what is true for the status, and a sample says nothing about a time', () => {
  assert.match(postCard(customerCtx, readyPost({ slot_at: null }), pack), /תעלה בשעה הפנויה הבאה אחרי שתאשרו/);
  assert.match(postCard(customerCtx, readyPost({ slot_at: null, status: 'approved' }), pack), /<span class="when num">תעלה בשעה הפנויה הבאה<\/span>/);
  const sample = postCard(customerCtx, readyPost({ status: 'sample', sample: 1, slot_at: null }), pack);
  assert.ok(!sample.includes('class="when'), 'a sample never goes up');
  assert.ok(!sample.includes('תעלה'));
  assert.match(sample, /לערוך/, 'a sample can be edited');
  const sampleWithSlot = postCard(customerCtx, readyPost({ status: 'sample', sample: 1 }), pack);
  assert.ok(!sampleWithSlot.includes('class="when'), 'not even with a slot');
});

test('the kind is shown in plain words when it is known, and not at all when it is not', () => {
  assert.equal(typeHe({ format_id: 'n-facts' }), 'כמה עובדות קצרות');
  assert.equal(typeHe({ format_id: 'whats-new' }), 'מה השתנה לאחרונה');
  assert.equal(typeHe({ format_id: 'plant-vs', kind: 'head-to-head' }), 'השוואה בין שניים');
  assert.equal(typeHe({ format_id: 'odd-one', kind: 'odd' }), '');
  const html = postCard(customerCtx, readyPost({ format_id: 'odd-one', kind: 'odd' }), pack);
  assert.ok(!html.includes('class="fmt"'));
  assert.ok(!html.includes('משהו של החבילה'));
  assert.match(postCard(operatorCtx, readyPost({ format_id: 'odd-one', kind: 'odd' }), pack), /משהו של החבילה/);
});

test('the facts block is hidden from the customer at 0, and kept for the operator', () => {
  const none = readyPost({ facts: [], slides: [{ kind: 'cover', factKeys: [] }, { kind: 'item', title: 'בדיחה', body: '', factKeys: [] }] });
  assert.ok(!postCard(customerCtx, none, pack).includes('מאיפה העובדות'));
  assert.match(postCard(operatorCtx, none, pack), /מאיפה העובדות \(0\)/);
});

test('the edit button is there only when the post can be edited', () => {
  for (const status of ['published', 'rejected', 'expired', 'publishing']) {
    const html = postCard(customerCtx, readyPost({ status }), pack);
    assert.ok(!html.includes('#edit'), status);
  }
  assert.match(postCard(customerCtx, readyPost({ status: 'approved' }), pack), /לערוך/);
});

test('a customer\'s card of a post stopped before it had slides says so, and nothing more', () => {
  const html = postCard(customerCtx, readyPost({ status: 'blocked', sample: 1, media: {}, slides: [], facts: [], hook: null, topic: 'מונסטרה' }), pack);
  assert.match(html, /נעצר בבדיקות/);
  assert.match(html, /מונסטרה/);
  for (const gone of ['#edit', 'הטקסט שעולה עם המצגת', 'מאיפה העובדות', 'class="when', 'מצגת חדשה בכתיבה']) assert.ok(!html.includes(gone), gone);
});

test('the lists use the same words: Today, /all and the scheduled list', () => {
  const d = {
    groups: [{ pack, acc: { status: 'active', mode: 'approve' }, waiting: [readyPost({ slot_at: null })], scheduled: [readyPost({ id: 'p2', status: 'approved', slot_at: null })], published: [], blocked: [], drafts: [] }],
    attention: {},
  };
  const rows = needsYou(d, 6, customerCtx).rows;
  assert.equal(rows[0].sub, 'עציצים · סוג: הסבר בכמה שלבים · תעלה בשעה הפנויה הבאה אחרי שתאשרו');
  assert.equal(needsYou(d, 6, operatorCtx).rows[0].sub, 'עציצים · איך זה עובד · תעלה בשעה הפנויה הבאה אחרי שתאשרו');
  const all = allPage({ ...customerCtx, user: { name: 'x' } }, d);
  assert.match(all, /סוג: הסבר בכמה שלבים · תעלה בשעה הפנויה הבאה אחרי שתאשרו/);
  const posts = postsPage({ ...customerCtx, user: { name: 'x' } }, d);
  assert.match(posts, /עציצים · תעלה בשעה הפנויה הבאה/);
  for (const html of [all, posts]) {
    assert.ok(!html.includes('בלי שעה'));
    assert.ok(!html.includes('איך זה עובד'));
  }
});

test('the page of a post still being written is the same one line for the customer', () => {
  const html = postPage({ ...customerCtx, user: { name: 'x' } }, { post: drafting(), pack });
  assert.match(html, /מצגת חדשה בכתיבה/);
  assert.match(html, /תהיה מוכנה בעוד כמה דקות/);
  for (const gone of ['עריכת הטקסט', 'מאיפה העובדות', 'איך הפוסט נוצר']) assert.ok(!html.includes(gone), gone);
});
