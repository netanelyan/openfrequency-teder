import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { recordedClient } from '../src/llm/recorded.js';
import { buildPost, candidateDocs, indexPage, loadPost, refusedOutlines } from '../src/pipeline/build.js';
import { MODEL_KEY, UNSOURCED_HE, hasModelFacts, modelFactsPrompt, stableFacts } from '../src/sources/model.js';
import { DEEPER_ROUNDS, deeperJob, nextRound, rememberRound, roundPlan, searchDeeper, searchMemory, startDeeper } from '../src/onboarding/deeper.js';
import { sourceHints } from '../src/onboarding/discover.js';
import { postCard } from '../src/web/pages.js';
import { tick } from '../src/autonomy/runner.js';
import { israelDate, israelInstant } from '../src/schedule/israel.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, listenFree, operator, opened, tempHome } from './helpers.js';

// Thin sources (the owner, 2026-11-06: "the engine cant write examples for openfrequency tiktok and instagram ... there
// should be a button that searches for new sources, and every search should be better ... even if you cant verify a
// fact or a source, we should use it. maybe add an AI that tells facts"). The live account's two sample tries sent the
// same 42 outlines twice, every one refused, on three home pages, a tag page and press releases, and stopped with
// nothing. Offline: the demo pack's documents, a model that refuses them all, and a model that knows a few facts.

after(() => closeBrowser());
const realFetch = globalThis.fetch;
const braveKey = process.env.BRAVE_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (braveKey === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = braveKey;
});

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, mode: 'recorded', packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

// The demo's myth-fact page, as lines the model "knows": its recorded outline and slides quote them.
const MYTHS = [
  'A layer of gravel at the bottom of a pot does not improve drainage: water stops where the soil meets the gravel, so the wet layer sits higher, closer to the roots.',
  'The better fix is a pot with a drainage hole and a soil mix that drains well.',
  'Yellow lower leaves while the soil is still wet usually mean too much water, not too little.',
  'A thirsty plant shows it differently: its leaves droop and the soil pulls away from the edge of the pot.',
  'A small splash of water every day keeps the top of the soil wet while the roots below stay dry.',
  'Water deeply instead, until water runs out of the drainage hole, and then wait until the top 3 cm of soil are dry.',
  'In most apartments that means watering a pot once a week or less, not every day.',
];

/**
 * The model when the sources are thin: every outline on a real document is refused (as the live account's were), the
 * model's own page is planned as the demo's myth-fact recording, and everything else is the recording.
 */
function thinModel(asked, { knows = MYTHS } = {}) {
  const rec = recordedClient();
  return {
    kind: 'claude',
    async json(req) {
      asked.push({ task: req.task, docKey: req.meta?.docKey, user: req.user, system: req.system });
      if (req.task === 'model_facts') return { data: { usable: true, subject: 'השקיית עציצים', why: 'כל מי שיש לו עציץ טעה בזה', facts: knows.map((text) => ({ text })) }, usage: null, model: req.model, estimated: true };
      if (req.task === 'review') return { data: { reviews: [] }, usage: null, model: req.model, estimated: true };
      const model = String(req.meta?.docKey || '').startsWith('model-');
      if (req.task === 'outline' && !model) return { data: { usable: false, why: 'a home page with headlines, nothing to quote', topic: '', subject: { a: '', b: '', answer: '', date: '' }, facts: [], items: [], imageQuery: '', research: [] }, usage: null, model: req.model, estimated: true };
      const r = await rec.json(model ? { ...req, meta: { ...req.meta, docKey: 'plant-myths' } } : req);
      // The recording's sixth fact holds a figure ("the top 3 cm"), which the model's page leaves out (stableFacts):
      // the model, writing from its own page, cites the fact after it instead.
      if (model && req.task === 'outline') {
        r.data.facts = r.data.facts.filter((f) => f.id !== 'f6');
        for (const it of r.data.items) it.facts = it.facts.map((k) => (k === 'f6' ? 'f7' : k));
      }
      if (model && req.task === 'slides') {
        const s = r.data.slides.find((x) => x.facts.includes('f6'));
        if (s) {
          s.facts = s.facts.map((k) => (k === 'f6' ? 'f7' : k));
          s.body = s.body.split(/\n/).slice(0, 2).join('\n');
          for (const it of s.visual?.items || []) if (/\d/.test(it.value2)) it.value2 = 'כשהאדמה למעלה יבשה';
        }
      }
      return r;
    },
  };
}

/* ------------------------------------------------------------------ the diagnosis */

test('a home page or a tag page is an index, an article is not', () => {
  for (const u of ['https://asakimgroup.org.il/', 'https://www.yazamut.org.il', 'https://www.globes.co.il/news/%D7%99%D7%96%D7%9E%D7%95%D7%AA.tag', 'https://site.example/tag/business/', 'https://site.example/category/news']) assert.equal(indexPage(u), true, u);
  for (const u of ['https://asakimgroup.org.il/general/managing-shift-workers-challenges-and-practical-solutions/', 'https://www.kolzchut.org.il/he/יזמות_עסקית', 'model:general-knowledge/x']) assert.equal(indexPage(u), false, u);
});

test('the outline is offered articles before home pages, never a page of a headline, and never the same refusal twice', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    // The live account's documents, read today: a home page that is one headline, an undated tag page (it sorted as the
    // newest), and an article of last month.
    const at = new Date().toISOString();
    const src = ctx.db.insert('sources', { account_id: 'demo', key: 'web-home', type: 'web', url: 'https://mag.example.org/', name: 'Mag', why: 'a magazine of the niche', status: 'approved', origin: 'pack', approved_at: at, created_at: at });
    const doc = (url, text, published_at) => ctx.db.insert('documents', { source_id: src, url, title: 'Mag', text, sha256: url, published_at, fetched_at: at, recorded: 0 });
    const ids = [
      doc('https://mag.example.org/', 'Mag | business magazine, one headline only, nothing more here', null),
      doc('https://mag.example.org/tag/business/', 'Headline one. '.repeat(60), null),
      doc('https://mag.example.org/2026/10/how-a-small-shop-grew/', 'The story of a small shop. '.repeat(40), '2026-10-01T08:00:00Z'),
    ];
    ctx.db.update('sources', src, { last_ok_at: at, last_docs_json: { day: israelDate(Date.now()), ids } });
    // Read as live, from what was read today (the demo's other sources give nothing).
    const docs = (await candidateDocs({ ...ctx, sources: { kind: 'live', read: async () => [] } }, pack)).filter((d) => d.source_id === src);
    assert.deepEqual(docs.map((d) => d.url), ['https://mag.example.org/2026/10/how-a-small-shop-grew/', 'https://mag.example.org/tag/business/'], 'the article first, the tag page after it, the headline page never');

    // Two builds with every outline refused: the second asks about other documents, not the first one's again.
    const asked = [];
    const llm = thinModel(asked);
    const noModel = { ...ctx, llm: { ...llm, kind: 'recorded-thin' } };
    noModel.llm.json = llm.json;
    const r1 = await buildPost(noModel, { pack, sample: true, formatKey: 'myth-fact' });
    assert.equal(r1.status, 'blocked', 'no model facts without a model to ask');
    const first = asked.filter((a) => a.task === 'outline').map((a) => a.docKey);
    assert.ok(first.length > 0);
    assert.equal(refusedOutlines(ctx.db, 'demo').size, first.length, 'each refusal is remembered');
    asked.length = 0;
    await buildPost(noModel, { pack, sample: true, formatKey: 'myth-fact' });
    const second = asked.filter((a) => a.task === 'outline').map((a) => a.docKey);
    assert.ok(second.every((k) => !first.includes(k)), `asked again: ${second.filter((k) => first.includes(k))}`);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ facts from the model */

test("the model's facts keep what an encyclopedia agrees on: no figures but years, no sums, no percentages, no quotations", () => {
  const kept = stableFacts([
    { text: 'Wix was founded in Tel Aviv in 2006 by three Israeli entrepreneurs who wanted easy websites.' },
    { text: 'Shopify grew 47% last year and now serves 4 million online stores worldwide.' },
    { text: 'The founder once said "we never sell" to a room full of investors in the valley.' },
    { text: 'A store on the platform pays ₪99 a month for the basic plan and more.' },
    { text: 'Too short.' },
    { text: 'Waze started as a community project mapping Israeli roads with drivers sharing traffic reports.' },
    { text: 'Waze started as a community project mapping Israeli roads with drivers sharing traffic reports.' },
  ]);
  assert.deepEqual(kept, ['Wix was founded in Tel Aviv in 2006 by three Israeli entrepreneurs who wanted easy websites.', 'Waze started as a community project mapping Israeli roads with drivers sharing traffic reports.']);
  const p = modelFactsPrompt({ meta: { topics: ['יזמות ועסקים לכולם'], audience: 'מי שרוצה להיות יזם' } }, { avoid: ['הסיפור של וויקס'] });
  assert.match(p.system, /no statistics, percentages, prices, sums, counts or exact dates/);
  assert.match(p.system, /no quotation/);
  assert.match(p.system, /knows by name at once/);
  assert.match(p.system, /הסיפור של וויקס/, 'not a subject posted lately');
});

test('sources too thin to write from: the post is written from the model\'s own facts, labelled "לא ממקור, כדאי לבדוק", and never named as a source', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const pack = ctx.pack('demo');
    const asked = [];
    ctx.llm = thinModel(asked);
    const res = await buildPost(ctx, { pack, sample: true, formatKey: 'myth-fact' });
    assert.equal(res.status, 'sample', `${res.kind}: ${res.reason}`);
    const tasks = asked.map((a) => a.task);
    assert.ok(tasks.indexOf('model_facts') > tasks.indexOf('outline'), 'the sources are tried first');
    assert.equal(tasks.filter((t) => t === 'model_facts').length, 1, 'one page from the model, once');
    const src = ctx.db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', 'demo', MODEL_KEY);
    assert.equal(src.status, 'approved');
    const doc = ctx.db.get('SELECT * FROM documents WHERE source_id = ?', src.id);
    assert.ok(!doc.text.includes('3 cm'), 'a fact with a figure is left out');
    assert.ok(hasModelFacts(ctx.db, res.postId));
    const post = loadPost(ctx.db, res.postId);
    assert.ok(post.facts.some((f) => f.unsourced && f.verified), 'checked against the page the model wrote, word for word');
    // Never said to come from a source: no "מקור:" line for it on the slides, and the card says so.
    const drawn = ctx.db.all('SELECT data_json FROM slides WHERE post_id = ?', res.postId).map((s) => s.data_json || '').join(' ');
    assert.doesNotMatch(drawn, /ידע כללי/);
    const card = postCard({ csrf: 'x', operator: false }, post, pack);
    assert.match(card, new RegExp(UNSOURCED_HE));
    assert.doesNotMatch(card, /<a [^>]*>ידע כללי/, 'not shown as a source to open');
    assert.ok(!card.includes('href="model:'), 'no link to a page that does not exist');
    // The source is the account's to remove, and then it is never used.
    ctx.db.update('sources', src.id, { status: 'removed' });
    asked.length = 0;
    const again = await buildPost(ctx, { pack, sample: true, formatKey: 'myth-fact' });
    assert.equal(again.status, 'blocked');
    assert.ok(!asked.some((a) => a.task === 'model_facts'));
  } finally {
    cleanup();
  }
});

test('in digest and auto, a post on the model\'s facts waits for a person instead of being approved by the engine', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    ctx.db.run("UPDATE accounts SET mode = 'digest' WHERE id = 'demo'");
    const tuesday = (hhmm) => israelInstant('2026-10-13', hhmm).getTime();
    await tick(ctx, { t: tuesday('07:05') });
    const [a, b] = ctx.db.all("SELECT id FROM posts WHERE account_id = 'demo' AND status = 'queued' AND slot_at < '2026-10-14' ORDER BY slot_at");
    // Post a stands on a fact from the model; post b on its sources.
    const at = new Date().toISOString();
    const model = ctx.db.insert('sources', { account_id: 'demo', key: MODEL_KEY, type: 'api', url: 'model:general-knowledge', name: 'ידע כללי של המודל', why: 'facts the model knows', status: 'approved', origin: 'discovered', approved_at: at, created_at: at });
    ctx.db.run('UPDATE facts SET source_id = ? WHERE post_id = ? AND id = (SELECT MIN(id) FROM facts WHERE post_id = ?)', model, a.id, a.id);
    const r = await tick(ctx, { t: tuesday('20:30') });
    assert.ok(!r.approved.includes(a.id), 'held for a person');
    assert.equal(ctx.db.get('SELECT status FROM posts WHERE id = ?', a.id).status, 'queued');
    assert.ok(r.approved.includes(b.id) || ctx.db.get('SELECT status FROM posts WHERE id = ?', b.id).status !== 'queued', 'the sourced one goes on as before');
    await tick(ctx, { t: israelInstant('2026-10-14', '06:00').getTime() });
    const gone = ctx.db.get('SELECT status, reason FROM posts WHERE id = ?', a.id);
    assert.equal(gone.status, 'expired');
    assert.match(gone.reason, /לא ממקור/);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ the deeper search */

test('each round is deeper than the last, up to the cap', () => {
  const plans = Array.from({ length: DEEPER_ROUNDS + 2 }, (_, i) => roundPlan(i + 1));
  for (let i = 1; i < DEEPER_ROUNDS; i++) {
    for (const k of ['searches', 'sites', 'probed', 'depth', 'timeoutMs']) assert.ok(plans[i][k] > plans[i - 1][k], `${k} grows in round ${i + 1}`);
    assert.notEqual(plans[i].widen, plans[i - 1].widen, 'and widens to something else');
  }
  assert.deepEqual(plans[DEEPER_ROUNDS + 1], plans[DEEPER_ROUNDS - 1], 'no round past the last is bigger');
  assert.ok(plans[DEEPER_ROUNDS - 1].searches <= 12 && plans[DEEPER_ROUNDS - 1].timeoutMs <= 12 * 60_000, 'the cap a round costs and takes');
  assert.deepEqual(sourceHints({ type: 'rss', url: 'https://x.example/feed' }, 8), { max: 8 });
  const follow = new RegExp(sourceHints({ type: 'web', url: 'https://www.yazamut.org.il/' }, 8).follow.pattern, 'i');
  assert.ok(follow.test('https://www.yazamut.org.il/how-to-open-a-small-business/'), "a home page's articles are read");
  assert.ok(!follow.test('https://www.yazamut.org.il/blog/') && !follow.test('https://other.example/how-to-open-a-small-business/'), 'not its sections, not another site');
});

/** A model that plans rounds (repeating round 1's site and search on purpose) and scores what it reads. */
function plannerModel(asked) {
  let round = 0;
  return {
    kind: 'claude',
    async json(req) {
      asked.push(req);
      if (req.task === 'deeper_sites') {
        round += 1;
        return { data: { sites: [{ url: 'https://round1.example.org/', name: 'Round 1', why: 'x' }, { url: `https://round${round}-new.example.org/`, name: `New ${round}`, why: 'x' }], queries: ['יזמות בלוג', `round ${round} query`] } };
      }
      if (req.task === 'score_sources') return { data: { scores: req.user.split('\n').map((_, i) => ({ i, authority: 7, freshness: 7, terms: 'ok', reason: 'מגזין מוכר בתחום', relevance: 8, relevance_reason: 'על הנושא' })) } };
      throw new Error(`unexpected task ${req.task}`);
    },
  };
}

test('every round remembers the last: no search, site or source again, more of each source read, and none past the cap', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const asked = [];
    ctx.llm = plannerModel(asked);
    process.env.BRAVE_API_KEY = 'test';
    const searched = [];
    globalThis.fetch = async (url) => {
      const q = new URL(String(url)).searchParams.get('q');
      searched.push(q);
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const reads = [];
    const readSite = async (url, _notes, { depth }) => (reads.push({ url, depth }), [{ type: 'rss', url: `${url}feed`, name: `Feed of ${new URL(url).hostname}`, newest: null, sample: ['A story'], hints: sourceHints({ type: 'rss' }, depth) }]);
    const seed = { niche: 'יזמות ועסקים לכולם', nicheEn: 'entrepreneurship', audience: 'מי שרוצה להיות יזם', topics: [] };
    const scope = 'o:test';
    const rounds = [];
    for (let i = 0; i < DEEPER_ROUNDS; i++) {
      const res = await searchDeeper(ctx, seed, { scope, known: ['https://www.globes.co.il/news/x.tag'], dropped: ['dropped.example.org'], discoverOpts: { readSite } });
      rememberRound(ctx.db, scope, res.round);
      rounds.push(res);
    }
    assert.deepEqual(rounds.map((r) => r.round.n), [1, 2, 3, 4]);
    // Round 1 found round1.example.org; every later round was offered it again by the model, and read it never.
    assert.ok(rounds[0].candidates.some((c) => c.url.includes('round1.example.org')));
    for (const r of rounds.slice(1)) assert.ok(!r.candidates.some((c) => c.url.includes('round1.example.org')), `round ${r.round.n} offered round 1's site again`);
    assert.equal(reads.filter((x) => x.url.includes('round1.example.org')).length, 1, 'read once in all');
    // The search the model repeated ran once; each round's own ran.
    assert.equal(searched.filter((q) => q === 'יזמות בלוג').length, 1);
    for (let n = 1; n <= DEEPER_ROUNDS; n++) assert.ok(searched.includes(`round ${n} query`));
    // Deeper: each round read its sources' pages further, and the model was told what came before.
    const depths = rounds.map((r) => r.candidates[0]?.hints?.max);
    assert.deepEqual(depths, [6, 8, 10, 12]);
    const plans = asked.filter((x) => x.task === 'deeper_sites');
    assert.match(plans[1].user, /round1\.example\.org/, 'round 2 is told round 1\'s sites');
    assert.match(plans[1].user, /round 1 query/, "and its searches");
    assert.match(plans[0].user, /dropped\.example\.org/, 'and what the owner dropped');
    assert.match(plans[2].system, /beyond the product itself/, 'round 3 looks at what the audience cares about');
    // Past the cap: no round, and the press is refused.
    assert.equal(searchMemory(ctx.db, scope).rounds.length, DEEPER_ROUNDS);
    assert.equal(nextRound(ctx.db, scope), null);
    assert.equal(startDeeper(ctx, scope, { seed, known: [], dropped: [], keep: () => {} }), false);
  } finally {
    cleanup();
  }
});

test('"לחפש מקורות חדשים" on the setup\'s sources step and on the Sources page: in the background, then kept or dropped', async () => {
  const { home, cleanup } = tempHome();
  let server;
  let fake;
  try {
    const ctx = contextFor(home);
    ctx.llm = plannerModel([]);
    ctx.discoverOpts = { readSite: async (url) => [{ type: 'rss', url: `${url}feed`, name: `Feed of ${new URL(url).hostname}`, newest: null, sample: ['A story'] }] };
    const at = new Date().toISOString();
    const old = { id: 'c1', type: 'web', url: 'https://www.yazamut.org.il/', name: 'יזמות בישראל', origin: 'feed', score: { authority: 7, freshness: 5, terms: 'ok', reason: 'אתר יזמות', relevance: 8 }, approved: false };
    ctx.db.insert('onboarding', { id: 'o-deep', seed_json: { niche: 'יזמות ועסקים לכולם', nicheEn: 'entrepreneurship', audience: 'מי שרוצה להיות יזם', topics: [] }, status: 'review', candidates_json: { candidates: [old] }, workspace_id: 3, created_at: at, updated_at: at });
    fake = await fakeAccounts();
    const s = await listenFree(ctx, { env: { ...process.env, SESSION_SECRET: 'd'.repeat(40), ...fake.env } });
    server = s.server;
    const base = `http://127.0.0.1:${s.port}`;
    const as = (session) => {
      const { cookie } = fake.session(session);
      return {
        get: async (p) => (await fetch(`${base}${p}`, { headers: { cookie } })).text(),
        post: async (p, body = {}) => {
          const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/new`, { headers: { cookie } })).text())[1];
          return fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });
        },
      };
    };
    const owner = as(customer(3));
    const step = await owner.get('/new/o-deep');
    assert.match(step, /לחפש מקורות חדשים/);
    assert.match(step, /<form method="post" action="\/new\/o-deep\/deeper" id="deeper-form">/, 'a form of its own, outside the create form');
    assert.match(step, /form="deeper-form"/);
    assert.match(step, /data-wait-box[^]*?data-wait="מתחילים לחפש\|מחפשים אתרים חדשים\|קוראים מקורות"/, "the button's line, in turn, while it is sent");
    // The sites answer only when the test says so: the round is seen running first.
    let open;
    const gate = new Promise((r) => (open = r));
    const read = ctx.discoverOpts.readSite;
    ctx.discoverOpts = { readSite: async (...a) => (await gate, read(...a)) };
    assert.equal((await owner.post('/new/o-deep/deeper')).status, 303);
    const busy = await owner.get('/new/o-deep');
    assert.match(busy, /data-poll="\/new\/o-deep\/status"/, 'while it runs the panel says how it goes');
    assert.match(busy, /data-progress aria-live="polite">[^<]*(מחפשים|קוראים)/);
    assert.equal(JSON.parse(await owner.get('/new/o-deep/status')).busy, true);
    open();
    await deeperJob('o:o-deep');
    ctx.discoverOpts = { readSite: read };
    const st = JSON.parse(await owner.get('/new/o-deep/status'));
    assert.equal(st.busy, false);
    const row = JSON.parse(ctx.db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-deep'").candidates_json);
    assert.equal(row.candidates[0].url, old.url, 'what was there stays, with its id');
    const added = row.candidates.filter((c) => c.round === 1);
    assert.ok(added.length >= 1 && added.every((c) => c.id !== 'c1'));
    const after1 = await owner.get('/new/o-deep');
    assert.match(after1, /<span class="chip sig">חדש<\/span>/, 'the new ones are marked, for the owner to tick or leave');
    assert.match(after1, /בחיפוש האחרון מצאנו/);

    // The account's Sources page: the same press, its finds pending, approved or removed one by one.
    const op = as(operator());
    const page = await op.get('/sources?account=demo');
    assert.match(page, /<form method="post" action="\/sources\/search">[^]*?name="account" value="demo"/);
    assert.equal((await op.post('/sources/search', { account: 'demo' })).status, 303);
    await deeperJob('demo');
    const pending = ctx.db.all("SELECT name, status, origin FROM sources WHERE account_id = 'demo' AND status = 'pending'");
    assert.ok(pending.length >= 1 && pending.every((p) => p.origin === 'discovered'));
    const listed = await op.get('/sources?account=demo');
    assert.match(listed, /ממתין לאישור/);
    assert.match(listed, /הם למעלה, ומחכים שתאשרו או תסירו/);
    const status = JSON.parse(await op.get('/sources/search/status?account=demo'));
    assert.equal(status.busy, false);
    assert.match(status.key, /^idle:1$/);
  } finally {
    server?.close();
    await fake?.close();
    cleanup();
  }
});
