import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { ATTRIBUTED_MAX, attributes, gate, verifyFact } from '../src/verify/claims.js';
import { planFrom } from '../src/pipeline/build.js';
import { allowedFor, clearRobots, parseRobots, robotsAllows } from '../src/sources/robots.js';
import { liveSources, preferred } from '../src/sources/index.js';
import { CATALOG } from '../src/sources/catalog.js';
import { addCatalogSource } from '../src/web/actions.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { opened, tempHome } from './helpers.js';

// Wider sources, one careful tier: what someone said is a fact of its own kind. It is verified like any fact, and
// then the document must show it is theirs; a slide says it as theirs; a post has two at most. And a site that tells
// Claude to stay out is not read.

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function withDoc(text, { sourceName = 'Bloody Elbow', url = 'https://bloodyelbow.com/2026/10/19/x/' } = {}) {
  const db = new Db(':memory:');
  const at = '2026-10-19T10:00:00Z';
  db.insert('accounts', { id: 'a', display_name: 'a', handle: 'a', created_at: at, updated_at: at });
  const source_id = db.insert('sources', { account_id: 'a', key: 's', type: 'rss', url: 'https://bloodyelbow.com/feed/', name: sourceName, status: 'approved', origin: 'manual', created_at: at });
  const document_id = db.insert('documents', { source_id, url, text, sha256: 'x', fetched_at: at });
  return { db, document_id, source_id };
}

test('an attributed fact is verified only where the document shows they said or reported it', () => {
  const { db, document_id } = withDoc('After the press conference, UFC president Dana White told reporters that the rematch will happen in March at the Garden, and left.');
  const f = (who, quote = 'the rematch will happen in March at the Garden') => ({ key: 'f1', claim: 'הקרב החוזר יתקיים במרץ', quote, document_id, who });
  assert.equal(verifyFact(db, f('Dana White'), { accountId: 'a' }).ok, true);
  assert.match(verifyFact(db, f('Conor McGregor'), { accountId: 'a' }).error, /does not name them beside the quote/);
  const silent = withDoc('Dana White. The rematch will happen in March at the Garden, the schedule shows.');
  assert.match(verifyFact(silent.db, { ...f('Dana White'), document_id: silent.document_id }, { accountId: 'a' }).error, /nothing beside the quote says they said or reported it/);
  // The outlet reporting it is its own attribution.
  const report = withDoc('The rematch will happen in March at the Garden, sources close to the matchmakers say.', { sourceName: 'Sherdog' });
  assert.equal(verifyFact(report.db, { ...f('Sherdog'), document_id: report.document_id }, { accountId: 'a' }).ok, true);
  // "כלפי" is not "לפי": a word of saying stands on its own.
  const he = withDoc('דנה וייט פנה כלפי הקהל והקרב החוזר יתקיים במרץ בגארדן כמו שתוכנן מראש');
  assert.match(verifyFact(he.db, { key: 'f1', claim: 'הקרב החוזר יתקיים במרץ', quote: 'הקרב החוזר יתקיים במרץ בגארדן', document_id: he.document_id, who: 'דנה וייט' }, { accountId: 'a' }).error, /nothing beside the quote/);
  // A plain fact is checked as before.
  assert.equal(verifyFact(db, { ...f(''), who: '' }, { accountId: 'a' }).ok, true);
});

test('a slide says an attributed fact as theirs, never as plain fact, and a post carries two at most', () => {
  assert.equal(attributes('לפי דנה וייט, הקרב החוזר במרץ', { who: 'Dana White', whoHe: 'דנה וייט' }), true);
  assert.equal(attributes('וייט סיפר שהקרב במרץ', { who: 'Dana White', whoHe: 'דנה וייט' }), true);
  assert.equal(attributes('הקרב החוזר יתקיים במרץ', { who: 'Dana White', whoHe: 'דנה וייט' }), false, 'stated as plain fact');
  assert.equal(attributes('לפי הלוח, הקרב במרץ', { who: 'Dana White', whoHe: 'דנה וייט' }), false, 'said, but not by them');
  const fact = (key, who) => ({ key, quote: 'the rematch will happen in March at the Garden', verified: true, who, whoHe: who === 'Dana White' ? 'דנה וייט' : who });
  const slide = (body, keys) => ({ kind: 'item', role: 'beat', title: 't', body, factKeys: keys });
  const plain = gate({ slides: [slide('הקרב החוזר יתקיים במרץ.', ['f1'])], facts: [fact('f1', 'Dana White')] });
  assert.match(plain.problems.join(' '), /slide 1: "f1" is what דנה וייט said or reported: the slide names them and says so/);
  assert.deepEqual(gate({ slides: [slide('לפי דנה וייט, הקרב החוזר במרץ.', ['f1'])], facts: [fact('f1', 'Dana White')] }).problems, []);
  const three = gate({ slides: [slide('לפי Sherdog, במרץ.', ['f1']), slide('לפי Sherdog, במרץ.', ['f2']), slide('לפי Sherdog, במרץ.', ['f3'])], facts: ['f1', 'f2', 'f3'].map((k) => fact(k, 'Sherdog')) });
  assert.match(three.problems.join(' '), new RegExp(`3 attributed facts .*: ${ATTRIBUTED_MAX} at most`));
});

test('the plan keeps two attributed facts and refuses a third', () => {
  const { db, document_id, source_id } = withDoc('Dana White told reporters the rematch will happen in March at the Garden. White said tickets go on sale on Friday at noon. White added the co-main will be announced next week.');
  const ctx = { db };
  const pack = { id: 'a', rules: {} };
  const outline = {
    facts: [
      { id: 'f1', claim: 'במרץ', quote: 'the rematch will happen in March at the Garden', doc: 'D1', who: 'Dana White', whoHe: 'דנה וייט' },
      { id: 'f2', claim: 'בשישי', quote: 'tickets go on sale on Friday at noon', doc: 'D1', who: 'Dana White', whoHe: 'דנה וייט' },
      { id: 'f3', claim: 'בשבוע הבא', quote: 'the co-main will be announced next week', doc: 'D1', who: 'Dana White', whoHe: 'דנה וייט' },
    ],
    items: [{ role: 'beat', point: 'p', facts: ['f1'] }],
  };
  const made = planFrom(ctx, { pack, format: { id: 't', kind: 'story', name: 'x', hooks: ['x'] }, outline, cand: { refs: [{ ref: 'D1', id: document_id, source_id }] } });
  const by = Object.fromEntries(made.facts.map((f) => [f.key, f]));
  assert.equal(by.f1.verified && by.f2.verified, true);
  assert.equal(by.f3.verified, false);
  assert.match(by.f3.error, /2 attributed facts at most/);
  assert.equal(by.f1.whoHe, 'דנה וייט');
});

test("robots.txt is obeyed for this engine and for Claude's agents, by the longest rule", async () => {
  const groups = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: anthropic-ai\nUser-agent: ClaudeBot\nDisallow: /\n');
  assert.deepEqual(allowedFor(groups, 'open-frequency', '/news/x'), { ok: true });
  assert.equal(allowedFor(groups, 'open-frequency', '/private/x').ok, false);
  assert.equal(allowedFor(groups, 'open-frequency', '/private/open/x').ok, true, 'the longer Allow wins');
  assert.equal(allowedFor(groups, 'claudebot', '/news/x').ok, false);
  clearRobots();
  const site = (status, body) => async () => ({ status, body });
  assert.equal((await robotsAllows('https://a.example/x', { read: site(200, 'User-agent: *\nDisallow:\n') })).ok, true);
  clearRobots();
  assert.match((await robotsAllows('https://a.example/x', { read: site(200, 'User-agent: anthropic-ai\nDisallow: /\n') })).why, /Claude's agents \(anthropic-ai\)/);
  clearRobots();
  assert.equal((await robotsAllows('https://a.example/x', { read: site(404, '') })).ok, true, 'no robots.txt: nothing is disallowed');
  clearRobots();
  assert.equal((await robotsAllows('https://a.example/x', { read: site(503, '') })).ok, false, 'an unreadable robots.txt allows nothing this time');
  clearRobots();
});

test('a feed is read only where robots.txt lets Claude in, item by item, long reads first', async () => {
  clearRobots();
  const feed = `<?xml version="1.0"?><rss><channel>
<item><title>Match report: 2-1</title><link>https://open.example/a</link><description>${'x '.repeat(500)}</description></item>
<item><title>Interview: the comeback</title><link>https://open.example/b</link><description>${'y '.repeat(500)}</description></item>
<item><title>Exclusive</title><link>https://closed.example/c</link><description>${'z '.repeat(500)}</description></item>
</channel></rss>`;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return new Response(u.hostname === 'closed.example' ? 'User-agent: ClaudeBot\nDisallow: /\n' : 'User-agent: *\nDisallow:\n', { status: 200 });
    if (u.hostname === 'open.example' && u.pathname === '/feed') return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    return new Response('no', { status: 404 });
  };
  const src = { type: 'rss', url: 'https://open.example/feed', name: 'x', config_json: JSON.stringify({ hints: { prefer: '\\binterview\\b' } }) };
  const docs = await liveSources().read(src);
  assert.deepEqual(docs.map((d) => d.title), ['Interview: the comeback', 'Match report: 2-1'], 'the long read first; the closed site\'s item dropped');
  await assert.rejects(liveSources().read({ ...src, url: 'https://closed.example/feed' }), /Claude's agents/);
  assert.deepEqual(preferred([{ title: 'a' }, { title: 'ראיון' }], '(ראיון)').map((x) => x.title), ['ראיון', 'a']);
  globalThis.fetch = realFetch;
  clearRobots();
});

test("the catalog: feeds per niche, the refused ones named with why, adding one is the operator's and asks robots.txt again", async () => {
  for (const [niche, n] of Object.entries(CATALOG)) {
    assert.ok(n.sources.length >= 3, niche);
    for (const s of n.sources) {
      assert.match(s.url, /^https:\/\//);
      assert.ok(s.hints.prefer && s.why.length >= 10, s.id);
    }
    assert.ok(n.refused.every(([name, why]) => name && why), niche);
  }
  const { home, cleanup } = tempHome();
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    const user = { name: 'owner', operator: true };
    // The list is the operator's: a customer adding from it is refused before anything is asked or written.
    await assert.rejects(addCatalogSource(ctx, { name: 'customer' }, {}, { account: 'demo', niche: 'mma', id: 'sherdog-articles' }), /רק מי שמפעיל/);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM sources WHERE account_id = 'demo' AND key = 'catalog-sherdog-articles'").n, 0);
    ctx.robotsAllows = async () => ({ ok: false, why: 'robots.txt tells Claude\'s agents to stay out' });
    await assert.rejects(addCatalogSource(ctx, user, {}, { account: 'demo', niche: 'mma', id: 'sherdog-articles' }), /לא נוסף: robots.txt/);
    ctx.robotsAllows = async () => ({ ok: true });
    const r = await addCatalogSource(ctx, user, {}, { account: 'demo', niche: 'mma', id: 'sherdog-articles' });
    assert.equal(r.ok, true);
    const row = db.get("SELECT * FROM sources WHERE account_id = 'demo' AND key = 'catalog-sherdog-articles'");
    assert.equal(row.status, 'approved');
    assert.match(JSON.parse(row.config_json).hints.prefer, /interview/);
    assert.match((await addCatalogSource(ctx, user, {}, { account: 'demo', niche: 'mma', id: 'sherdog-articles' })).message, /כבר מקור/);
  } finally {
    cleanup();
  }
});
