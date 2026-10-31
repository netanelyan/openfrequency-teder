import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { discover, feedGuesses, nicheSites, offered, searchesFor, SEARCHES } from '../src/onboarding/discover.js';
import { clearRobots } from '../src/sources/robots.js';
import { opened, tempHome } from './helpers.js';

// Sources for any niche (the owner, 2026-10-31: "i want the engine to find sources for every nieche. i cant find
// sources for every account, so when a customer writes his nieche the engine will find the sources"). A niche none of
// our accounts ever had, baking: the model names its sites and searches, every site is read before it is offered, a
// feed the page does not declare is found where sites keep one, and a site that keeps Claude out is never offered.

const realFetch = globalThis.fetch;
const braveKey = process.env.BRAVE_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (braveKey === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = braveKey;
  clearRobots();
});
after(() => (globalThis.fetch = realFetch));

const rss = (title, items) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items.map(([t, link, day]) => `<item><title>${t}</title><link>${link}</link><pubDate>${day}</pubDate></item>`).join('')}</channel></rss>`;
const BREAD = rss('Bread Lab', [
  ['Sourdough starter, day by day', 'https://bake.example.org/bread/starter', 'Fri, 30 Oct 2026 08:00:00 GMT'],
  ['Why rye bread is dense', 'https://bake.example.org/bread/rye', 'Thu, 29 Oct 2026 08:00:00 GMT'],
]);
const CRUMBS = rss('Crumbs', [['Laminated dough at home', 'https://crumbs.example.net/laminated', 'Wed, 28 Oct 2026 08:00:00 GMT']]);

/** The model, by task: the niche in English, the niche's sites and searches, and a score for every candidate. */
function fakeModel(asked) {
  return {
    kind: 'claude',
    async json(req) {
      asked.push(req);
      if (req.task === 'niche_en') return { data: { en: 'home baking' } };
      if (req.task === 'niche_sites')
        return {
          data: {
            sites: [
              { url: 'https://bake.example.org/bread/', name: 'Bread Lab', why: 'A baking school writing about bread' },
              { url: 'https://ghost.example.org/', name: 'Ghost Bakes', why: 'A site that is not there' },
              { url: 'https://www.instagram.com/some.baker', name: 'A baker', why: 'A social account' },
              { url: 'https://bake.example.org/pastry/', name: 'Bread Lab again', why: 'The same site twice' },
              { url: 'not a url', name: 'Nothing', why: 'x' },
            ],
            queries: ['אפייה ביתית מגזין', 'home baking blog'],
          },
        };
      if (req.task === 'score_sources') {
        const n = req.user.split('\n').length;
        return { data: { scores: Array.from({ length: n }, (_, i) => ({ i, authority: 7, freshness: 7, terms: 'ok', reason: 'אתר אפייה מוכר', relevance: 8, relevance_reason: 'כולו על אפייה' })) } };
      }
      throw new Error(`unexpected task ${req.task}`);
    },
  };
}

/** The open web for this niche: what each address answers. Brave's searches are written down. */
function fakeWeb(searched, fetched) {
  return async (url) => {
    const u = String(url);
    fetched.push(u);
    const page = (status, body, type = 'text/html') => new Response(body, { status, headers: { 'content-type': type } });
    if (u.startsWith('https://api.search.brave.com/')) {
      const q = new URL(u).searchParams.get('q');
      searched.push(q);
      const results = q === 'home baking blog' ? [{ url: 'https://crumbs.example.net/a-loaf', title: 'A loaf', description: 'A home baking blog' }, { url: 'https://nobots.example.com/rye', title: 'Rye at home', description: 'Baking rye bread' }] : [];
      return page(200, JSON.stringify({ web: { results } }), 'application/json');
    }
    if (u.endsWith('/robots.txt')) return u.includes('nobots') ? page(200, 'User-agent: ClaudeBot\nDisallow: /\n', 'text/plain') : page(404, '');
    if (u.startsWith('https://ghost.example.org')) throw new TypeError('fetch failed');
    // A section page that declares no feed; its feed is where WordPress keeps a category's.
    if (u === 'https://bake.example.org/bread/') return page(200, '<html><head><title>Bread Lab</title><meta name="description" content="Home baking: bread, sourdough and pastry"></head><body>Bread</body></html>');
    if (u === 'https://bake.example.org/bread/feed') return page(200, BREAD, 'application/rss+xml');
    // A WordPress site declares its readers' comments first, then its posts, then the same posts again as Atom.
    if (u === 'https://crumbs.example.net/')
      return page(200, '<html><head><title>Crumbs</title><link rel="alternate" type="application/rss+xml" title="Crumbs &raquo; Comments Feed" href="/comments/feed/"><link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head><body></body></html>');
    if (u === 'https://crumbs.example.net/rss.xml' || u === 'https://crumbs.example.net/atom.xml') return page(200, CRUMBS, 'application/rss+xml');
    if (u === 'https://crumbs.example.net/comments/feed/') return page(200, rss('Comments', [['Comment on Laminated dough by Dana', 'https://crumbs.example.net/c/1', 'Wed, 28 Oct 2026 09:00:00 GMT']]), 'application/rss+xml');
    return page(404, 'not here');
  };
}

function contextFor(home, llm) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  if (llm) ctx.llm = llm;
  return ctx;
}

test('a niche none of our accounts had (baking): the model names its sites, each is read, a hidden feed is found, and a site that keeps Claude out is not offered', async () => {
  const { home, cleanup } = tempHome();
  try {
    const asked = [];
    const searched = [];
    const fetched = [];
    const ctx = contextFor(home, fakeModel(asked));
    process.env.BRAVE_API_KEY = 'test-key';
    globalThis.fetch = fakeWeb(searched, fetched);
    const out = await discover(ctx, { niche: 'אפייה ביתית', audience: 'אופים בבית', topics: ['שאור'], examples: [] }, { yt: null });

    const sitesAsk = asked.find((r) => r.task === 'niche_sites');
    assert.match(sitesAsk.user, /Subject: אפייה ביתית/);
    assert.match(sitesAsk.user, /Topics they care about: שאור/);
    assert.match(asked.find((r) => r.task === 'score_sources').system, /recognized specialist publication/, 'a specialist site counts as an established publication');
    assert.equal(out.nicheEn, 'home baking');

    // Brave runs the model's searches and the customer's topic, never the official-only ones.
    assert.deepEqual(searched, ['אפייה ביתית מגזין', 'home baking blog', 'שאור']);
    assert.ok(searched.every((q) => !/site:gov\.il|רשמי|official/.test(q)));

    // Every named site is read (once a host), a social one never; the sites Brave found are read too.
    assert.ok(fetched.includes('https://bake.example.org/bread/'));
    assert.ok(fetched.some((u) => u.startsWith('https://ghost.example.org/')));
    assert.ok(!fetched.some((u) => u.includes('instagram.com')), 'a social account is not read');
    assert.ok(!fetched.includes('https://bake.example.org/pastry/'), 'one site is read once');
    assert.ok(fetched.includes('https://crumbs.example.net/'));
    assert.ok(out.notes.some((n) => /Claude הציע 2 אתרים לנישה: bake\.example\.org, ghost\.example\.org/.test(n)), "the operator is told what the model named");

    // The section's feed, found though its page declares none, is offered with what it says lately.
    const bread = out.candidates.find((c) => c.url === 'https://bake.example.org/bread/feed');
    assert.ok(bread, 'the feed the page did not declare is found');
    assert.equal(bread.type, 'rss');
    assert.equal(bread.origin, 'feed');
    assert.deepEqual(bread.sample, ['Sourdough starter, day by day', 'Why rye bread is dense']);
    assert.equal(offered(bread), true);
    assert.ok(offered(out.candidates.find((c) => c.url === 'https://crumbs.example.net/rss.xml')), "a feed Brave's site declares");
    assert.deepEqual(out.candidates.filter((c) => c.url.startsWith('https://crumbs.example.net/') && c.type === 'rss').map((c) => c.url), ['https://crumbs.example.net/rss.xml'], 'never its comments, and its posts once though declared twice');
    assert.ok(!fetched.includes('https://crumbs.example.net/comments/feed/'), 'the comments feed is not even read');

    // A named site that is not there gives nothing, and the reason is the operator's.
    assert.ok(!out.candidates.some((c) => c.url.includes('ghost.example.org')));
    assert.ok(out.notes.some((n) => /ghost\.example\.org.*fetch failed/.test(n)));

    // A page Brave found on a site that keeps Claude out is kept for the operator, never offered.
    const nobots = out.candidates.find((c) => c.url === 'https://nobots.example.com/rye');
    assert.ok(nobots && nobots.blocked, 'kept, and marked');
    assert.equal(offered(nobots), false);
    assert.ok(out.notes.some((n) => /nobots\.example\.com.*Claude's agents/.test(n)));
    assert.ok(!out.candidates.some((c) => c.url.startsWith('https://nobots.example.com/') && c.type === 'rss'), 'its site is not read for feeds');
    assert.equal(offered(out.candidates[0]), true, 'the offered ones come first');
  } finally {
    cleanup();
  }
});

test('the searches: the model\'s, else the niche\'s own words, then two topics; never more than SEARCHES', () => {
  assert.deepEqual(searchesFor({ niche: 'אפייה', topics: ['שאור', 'בצק עלים', 'עוגות'] }, { nicheEn: 'baking' }), ['אפייה', 'אפייה מגזין', 'baking blog', 'baking news', 'שאור', 'בצק עלים']);
  assert.deepEqual(searchesFor({ niche: 'אפייה' }, { named: ['a', 'b', 'a'] }), ['a', 'b'], 'the same search once');
  assert.deepEqual(searchesFor({ niche: 'אפייה' }), ['אפייה', 'אפייה מגזין', 'אפייה blog', 'אפייה news'], 'no English niche: the Hebrew one');
  assert.equal(searchesFor({ niche: 'x', topics: ['1', '2'] }, { named: ['a', 'b', 'c', 'd', 'e', 'f'] }).length, SEARCHES);
});

test('where a feed hides: the section\'s own first, then the addresses sites use', () => {
  assert.deepEqual(feedGuesses('https://bake.example.org/bread/'), [
    'https://bake.example.org/bread/feed',
    'https://bake.example.org/feed',
    'https://bake.example.org/rss',
    'https://bake.example.org/feed.xml',
    'https://bake.example.org/rss.xml',
    'https://bake.example.org/atom.xml',
    'https://bake.example.org/index.xml',
  ]);
  assert.equal(feedGuesses('https://bake.example.org/')[0], 'https://bake.example.org/feed', 'a home page has no section');
});

test('without a model nothing is named and nothing is asked; the niche\'s own words are searched', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home, null);
    assert.deepEqual(await nicheSites(ctx, { niche: 'אפייה' }), { sites: [], queries: [] });
    const searched = [];
    process.env.BRAVE_API_KEY = 'test-key';
    globalThis.fetch = fakeWeb(searched, []);
    const out = await discover(ctx, { niche: 'אפייה', examples: [] }, { yt: null });
    assert.deepEqual(searched, ['אפייה', 'אפייה מגזין', 'אפייה blog', 'אפייה news']);
    assert.ok(!out.notes.some((n) => /Claude הציע/.test(n)));
  } finally {
    cleanup();
  }
});
