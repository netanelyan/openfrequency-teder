import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { discover, heuristicScore } from '../src/onboarding/discover.js';
import { suggestApis } from '../src/onboarding/apis.js';
import { createPack, newTheme, paletteFor } from '../src/onboarding/pack.js';
import { contrast } from '../src/render/color.js';
import { listen } from '../src/web/server.js';
import { __onboarding, recoverOnboarding } from '../src/web/onboarding.js';
import { choiceOf, scheduleOf } from '../src/schedule/choice.js';
import { closeBrowser } from '../src/render/render.js';
import { customer, fakeAccounts, operator, opened, tempHome } from './helpers.js';

after(() => closeBrowser());

function contextFor(home) {
  const db = new Db(path.join(home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home, 'media');
  return ctx;
}

test('a government source scores higher than an unknown one, and the reason says why', () => {
  const gov = heuristicScore({ type: 'web', url: 'https://www.btl.gov.il/benefits', origin: 'brave' });
  const blog = heuristicScore({ type: 'web', url: 'https://some-blog.example.com/', origin: 'brave' });
  assert.ok(gov.authority > blog.authority);
  assert.match(gov.reason, /ממשלתי/);
  assert.equal(gov.by, 'heuristic');
});

test('structured APIs are suggested when the niche matches, and Wikidata always', () => {
  const ids = (seed) => suggestApis(seed).map((a) => a.name);
  assert.ok(ids({ niche: 'בישול' }).includes('Wikidata'));
  assert.ok(ids({ niche: 'מחירים ויוקר המחיה' }).some((n) => /סטטיסטיקה/.test(n)));
});

test('discovery without keys says what it skipped and invents nothing', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const out = await discover(ctx, { niche: 'בישול לסטודנטים', audience: 'סטודנטים', examples: ['@someone'] }, { yt: null });
    assert.ok(out.notes.some((n) => /BRAVE_API_KEY/.test(n)));
    assert.ok(out.notes.some((n) => /YOUTUBE_API_KEY/.test(n)));
    assert.ok(out.notes.some((n) => /רשת חברתית/.test(n)), 'a social account is a style example, never read');
    assert.deepEqual(out.formats, []);
    assert.ok(out.candidates.every((c) => c.score && !c.approved));
    // The customer is told only what they can act on, in plain Hebrew.
    assert.deepEqual(out.said, ['את החשבונות ברשתות החברתיות שנתתם שמרנו כדוגמה לסגנון. עובדות לוקחים רק מאתרים.']);
    assert.equal(out.nicheEn, null, 'no model, no English niche, and nothing asked of the owner');
  } finally {
    cleanup();
  }
});

test('discovery reads the sites four at a time, keeps their order, says how far it got, and names a site it could not read', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const sites = Array.from({ length: 9 }, (_, i) => `https://site${i}.example.org/`);
    let now = 0;
    let most = 0;
    const seen = [];
    const readSite = async (url, notes) => {
      now += 1;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 30 - sites.indexOf(url) * 3));
      now -= 1;
      if (url.includes('site3')) return notes.push(`${url}: fetch failed`), [];
      return [{ type: 'web', url, name: `Site ${url.slice(12, 13)}`, newest: null }];
    };
    const out = await discover(ctx, { niche: 'גינון', examples: sites }, { yt: null, readSite, onProgress: (p) => seen.push(p) });
    assert.equal(most, 4, 'never more than four at once, and four when there are more');
    const webs = out.candidates.filter((c) => c.origin === 'example').map((c) => c.url);
    assert.equal(webs.length, 8);
    assert.deepEqual([...webs].sort(), sites.filter((u) => !u.includes('site3')).sort());
    const sitesSeen = seen.filter((p) => p.step === 'sites');
    assert.deepEqual(sitesSeen.at(-1), { step: 'sites', done: 9, total: 9 }, 'the progress reaches the end');
    assert.ok(seen.some((p) => p.step === 'score'));
    assert.ok(out.said.some((l) => l === 'לא הצלחנו לקרוא את site3.example.org. אפשר לבחור מהמקורות האחרים, או לנסות שוב מאוחר יותר.'));
    assert.ok(out.notes.some((n) => /site3.*fetch failed/.test(n)), "the failure's detail is the operator's");
  } finally {
    cleanup();
  }
});

test('a discovery that runs too long is stopped and failed; the page says so in Hebrew and searches again with the same seed', async () => {
  const { home, cleanup } = tempHome();
  let server;
  let fake;
  try {
    const ctx = contextFor(home);
    ctx.discoveryTimeoutMs = 60;
    ctx.discoverOpts = { readSite: () => new Promise((r) => setTimeout(() => r([]), 400)) };
    fake = await fakeAccounts();
    const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'z'.repeat(40), ...fake.env } });
    server = s.server;
    const base = `http://127.0.0.1:${s.port}`;
    const { cookie } = fake.session(customer(3));
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/new`, { headers: { cookie } })).text())[1];
    const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });
    const r1 = await post('/new', { niche: 'גינון במרפסת', examples: 'https://garden.example.org/' });
    const id = r1.headers.get('location').split('/').pop();
    const waiting = await (await fetch(`${base}/new/${id}`, { headers: { cookie } })).text();
    assert.match(waiting, /זה לוקח בדרך כלל כמה דקות/, 'honest about the wait');
    assert.doesNotMatch(waiting, /http-equiv="refresh"/, 'the page never reloads itself under someone typing');
    assert.match(waiting, new RegExp(`data-poll="/new/${id}/status"`), 'a script asks how it goes instead');
    assert.match(waiting, new RegExp(`href="/new/${id}">לבדוק שוב</a>`), 'and without the script, a link to look again');
    const st = await fetch(`${base}/new/${id}/status`, { headers: { cookie } });
    assert.match(st.headers.get('content-type'), /application\/json/);
    assert.ok(['discovering', 'failed'].includes((await st.json()).status));
    await Promise.all([...__onboarding.running.values()]);
    const failed = ctx.db.get('SELECT status, candidates_json, notes_json FROM onboarding WHERE id = ?', id);
    assert.equal(failed.status, 'failed');
    assert.equal(JSON.parse(failed.candidates_json).failure, 'timeout');
    assert.match(failed.notes_json, /seconds and was stopped/, "the operator's note");
    const page = await (await fetch(`${base}/new/${id}`, { headers: { cookie } })).text();
    assert.match(page, /החיפוש לקח יותר מדי זמן ונעצר/);
    assert.match(page, new RegExp(`action="/new/${id}/retry"`), 'a button to search again');
    assert.match(page, /לנסות שוב/);
    assert.doesNotMatch(page, /http-equiv="refresh"/, 'a failed search stops refreshing');
    assert.doesNotMatch(page, /seconds|stopped|הערות למפעיל/, 'nothing technical for the customer');
    // Again, now that the sites answer in time: the same seed, found.
    ctx.discoverOpts = { readSite: async (url) => [{ type: 'web', url, name: 'Garden', newest: null }] };
    const r2 = await post(`/new/${id}/retry`, {});
    assert.equal(r2.status, 303);
    await Promise.all([...__onboarding.running.values()]);
    const again = ctx.db.get('SELECT status, seed_json, candidates_json FROM onboarding WHERE id = ?', id);
    assert.equal(again.status, 'review');
    assert.equal(JSON.parse(again.seed_json).niche, 'גינון במרפסת');
    assert.ok(JSON.parse(again.candidates_json).candidates.some((c) => c.url === 'https://garden.example.org/'));
    assert.equal((await post(`/new/${id}/retry`, {})).status, 303, 'refused (a flash) once it is not failed');
    assert.equal(ctx.db.get('SELECT status FROM onboarding WHERE id = ?', id).status, 'review');
  } finally {
    server?.close();
    await fake?.close();
    cleanup();
  }
});

test('a search a restart cut off is failed at boot, or when its page opens, and offers to search again', async () => {
  const { home, cleanup } = tempHome();
  let server;
  let fake;
  try {
    const ctx = contextFor(home);
    const at = new Date().toISOString();
    ctx.db.insert('onboarding', { id: 'o-boot', seed_json: { niche: 'צילום' }, status: 'discovering', workspace_id: 4, created_at: at, updated_at: at });
    ctx.db.insert('onboarding', { id: 'o-late', seed_json: { niche: 'ריצה' }, status: 'discovering', workspace_id: 4, created_at: at, updated_at: at });
    ctx.db.insert('onboarding', { id: 'o-done', seed_json: { niche: 'שחייה' }, status: 'review', workspace_id: 4, created_at: at, updated_at: at });
    assert.equal(recoverOnboarding(ctx.db), 2);
    assert.equal(ctx.db.get("SELECT status FROM onboarding WHERE id = 'o-boot'").status, 'failed');
    assert.equal(ctx.db.get("SELECT status FROM onboarding WHERE id = 'o-done'").status, 'review', 'the rest untouched');
    // A row left searching after boot (no job in this process): its page fails it.
    ctx.db.run("UPDATE onboarding SET status = 'discovering' WHERE id = 'o-late'");
    fake = await fakeAccounts();
    const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'w'.repeat(40), ...fake.env } });
    server = s.server;
    const { cookie } = fake.session(customer(4));
    const page = await (await fetch(`http://127.0.0.1:${s.port}/new/o-late`, { headers: { cookie } })).text();
    assert.match(page, /החיפוש נקטע באמצע/);
    assert.match(page, /action="\/new\/o-late\/retry"/);
    assert.doesNotMatch(page, /http-equiv="refresh"/, 'no page refreshing forever');
    assert.equal(JSON.parse(ctx.db.get("SELECT candidates_json FROM onboarding WHERE id = 'o-late'").candidates_json).failure, 'restart');
  } finally {
    server?.close();
    await fake?.close();
    cleanup();
  }
});

test('a generated palette passes the contrast rules, and a new theme takes a look nobody uses', () => {
  for (const hue of [0, 90, 200, 300]) for (const dark of [false, true]) {
    const c = paletteFor(hue, { dark });
    assert.ok(c && contrast(c.ink, c.bg) >= 7 && contrast(c.onAccent, c.accent) >= 4.5, `hue ${hue} dark ${dark}`);
  }
  const existing = [{ theme: { template: 'editorial', variant: 'a', fonts: { display: 'Suez One' }, colors: { bg: '#EEF1E4', accent: '#B4512A' } } }];
  const t = newTheme(existing);
  assert.notEqual(`${t.template}/${t.variant}`, 'editorial/a');
  assert.notEqual(t.fonts.display, 'Suez One');
});

test('adding an account needs no code: the onboarding writes a valid, distinct pack next to the demo', async () => {
  const { home, cleanup } = tempHome();
  try {
    const ctx = contextFor(home);
    const made = await createPack(ctx, {
      seed: { niche: 'זכויות עובדים וחיסכון', audience: 'עובדים שכירים', topics: ['תלוש שכר'] },
      candidates: [{ id: 'c1', type: 'api', url: 'https://query.wikidata.org/sparql', name: 'Wikidata', why: 'Structured, sourced facts under CC0.', approved: true, api: { kind: 'wikidata-sparql', query: 'SELECT 1' } }],
      displayName: 'חשבון רביעי',
      handle: 'fourth.account',
    });
    assert.deepEqual(readdirSync(made.dir).sort(), ['formats.json', 'pack.json', 'rules.json', 'sources.json', 'theme.json', 'voice.md']);
    const all = loadAll({ dir: path.join(home, 'packs') });
    assert.equal(all.length, 2, 'both packs load, and together they are distinct brands');
    const p = all.find((x) => x.id === made.id);
    assert.deepEqual(p.meta.compliance, ['il-investment-advice'], 'a money niche gets the investment-advice check by itself');
    assert.equal(p.meta.autonomy.mode, 'approve', 'a new account starts in Approve mode');
  } finally {
    cleanup();
  }
});

test('the website flow: seed, discovery, approve sources, the pack is created, and it cannot go live without three samples', async () => {
  const { home, cleanup } = tempHome();
  let server;
  let fake;
  try {
    const ctx = contextFor(home);
    fake = await fakeAccounts();
    const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'y'.repeat(40), ...fake.env } });
    server = s.server;
    const base = `http://127.0.0.1:${s.port}`;
    // The owner of workspace 7 starts the account: it is that workspace's.
    const { cookie } = fake.session(customer(7));
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/new`, { headers: { cookie } })).text())[1];
    const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });

    const r1 = await post('/new', { niche: 'בישול טבעוני', audience: 'סטודנטים', topics: 'מתכונים, תקציב' });
    assert.equal(r1.status, 303);
    const id = r1.headers.get('location').split('/').pop();
    await Promise.all([...__onboarding.running.values()]);
    const review = await (await fetch(`${base}/new/${id}`, { headers: { cookie } })).text();
    assert.match(review, /Wikidata/);
    assert.match(review, /<html lang="he" dir="rtl"/);
    assert.doesNotMatch(review, /BRAVE_API_KEY|YOUTUBE_API_KEY|היוריסט|מפתח API|ליצור את החבילה|מזהה החבילה|התיקייה|הערות למפעיל/, 'the review page keeps the technical notes from the customer');
    assert.doesNotMatch(await (await fetch(`${base}/new`, { headers: { cookie } })).text(), /name="nicheEn"|באנגלית/, 'no English niche to fill in');
    const cand = ctx.db.get('SELECT candidates_json FROM onboarding WHERE id = ?', id);
    const first = JSON.parse(cand.candidates_json).candidates[0].id;
    const r2 = await post(`/new/${id}/create`, { [`approve_${first}`]: 'on', displayName: 'מטבח ירוק בדוגמה', handle: 'demo.green.kitchen' });
    assert.equal(r2.status, 303);
    const row = ctx.db.get('SELECT status, pack_id FROM onboarding WHERE id = ?', id);
    assert.equal(row.status, 'samples');
    assert.equal(ctx.db.get('SELECT status FROM accounts WHERE id = ?', row.pack_id).status, 'onboarding');
    assert.equal(ctx.db.get('SELECT workspace_id FROM accounts WHERE id = ?', row.pack_id).workspace_id, 7, 'the new account is the workspace\'s that started it');
    assert.equal(ctx.db.get('SELECT workspace_id FROM onboarding WHERE id = ?', id).workspace_id, 7);
    assert.ok(ctx.pack(row.pack_id), 'the engine picked up the new pack without a restart');
    await post(`/new/${id}/samples`, {});
    await Promise.all([...__onboarding.running.values()]);
    const notes = JSON.parse(ctx.db.get('SELECT notes_json FROM onboarding WHERE id = ?', id).notes_json).join(' ');
    assert.match(notes, /ANTHROPIC_API_KEY/, "offline, the operator's notes say what it needs to write the samples");
    // The customer reads none of it: no key, no command, no file or package; the operator does, folded away.
    // "החבילה" alone is the customer's monthly plan; the pack (files in a folder) is never named.
    const DEV = /[A-Z]{3,}_[A-Z_]{3,}|npm run|היוריסט|ליצור את החבילה|החבילה נכתבה|מזהה החבילה|התיקייה|באנגלית|YouTube|Brave/;
    // A hidden field is not read either: its random CSRF token once held "HVE_AQCNGG", and the test failed one run in many.
    const visible = (html) => html.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>|<input[^>]*type="hidden"[^>]*>/g, '');
    const samplesPage = await (await fetch(`${base}/new/${id}`, { headers: { cookie } })).text();
    const around = (html) => {
      const m = DEV.exec(visible(html));
      return m ? visible(html).slice(Math.max(0, m.index - 80), m.index + 40) : null;
    };
    assert.equal(around(samplesPage), null, 'the samples page has no developer text');
    assert.match(samplesPage, /במקורות שבחרתם לא מצאנו מספיק עובדות לכתוב מהן/, 'samples that could not be written are said plainly, with what helps');
    assert.match(samplesPage, /href="\/sources\?account=demo-green-kitchen">לבחור מקורות/, 'and a way to the sources');
    assert.doesNotMatch(samplesPage, /כתבו לנו/);
    assert.match(samplesPage, /id="schedule"/, 'the days and times are offered before going live');
    assert.match(samplesPage, /name="back" value="\/new\//, 'and the form comes back here');
    assert.ok(choiceOf(ctx.db, row.pack_id), 'the new account starts with the default days and times');
    assert.equal(scheduleOf(ctx.db, ctx.pack(row.pack_id)).perMonth, 40);
    assert.equal(around(await (await fetch(`${base}/new`, { headers: { cookie } })).text()), null, '/new: no developer text');
    const op = fake.session(operator()).cookie;
    assert.match(await (await fetch(`${base}/new/${id}`, { headers: { cookie: op } })).text(), /הערות למפעיל[\s\S]*ANTHROPIC_API_KEY/, 'the operator sees the notes');
    await post(`/new/${id}/live`, {});
    assert.equal(ctx.db.get('SELECT status FROM accounts WHERE id = ?', row.pack_id).status, 'onboarding', 'no going live without three reviewed samples');
  } finally {
    server?.close();
    await fake?.close();
    cleanup();
  }
});
