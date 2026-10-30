import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { ROOT } from '../src/core/paths.js';
import { listen } from '../src/web/server.js';
import { workspaceCleanups } from '../src/web/workspace-delete.js';
import { INTERNAL_TOKEN, fakeAccounts, opened, tempHome } from './helpers.js';

// The contracts between the services (PRA-QA-003). openfrequency-accounts keeps one file for each internal API in its
// docs/contracts, and its README there says how they are written and kept; test/fixtures/contracts is a copy of that
// folder, byte for byte, held to the original whenever an accounts checkout is next to this one. Every case of an API
// Teder serves (setup.json: GET /internal/setup; workspaces-delete.json: POST /internal/workspaces/<id>/delete) is asked
// of Teder's real route, in a state made for it, and the answer must have the case's status and the shape of its body:
// the same keys and JSON types, where a field the case calls nullable may be null; an error's body exactly. A case
// Teder's route cannot be made to answer is in NOT_HERE with the reason, and where Teder answers otherwise than its
// contract the difference is in DIFFERS as found, so neither side can move unseen. The APIs Teder calls are held by
// their clients' tests: entitlement in test/capacity.test.js.

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'contracts');
const contracts = Object.fromEntries(
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(FIXTURES, f), 'utf8'))])
);

// ---- the copy

/**
 * openfrequency-accounts' docs/contracts beside this checkout, looked for next to each of the 6 folders above it: the
 * main checkout's, else one in its .claude/worktrees (the one changed last, when several have it). null when there is
 * none, as in CI.
 */
export function accountsContracts(from = ROOT) {
  let dir = path.resolve(from);
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
    const repo = path.join(dir, 'openfrequency-accounts');
    const main = path.join(repo, 'docs', 'contracts');
    if (existsSync(main)) return main;
    const trees = path.join(repo, '.claude', 'worktrees');
    const found = existsSync(trees) ? readdirSync(trees).map((t) => path.join(trees, t, 'docs', 'contracts')).filter((d) => existsSync(d)) : [];
    const changed = (d) => Math.max(0, ...readdirSync(d).map((f) => statSync(path.join(d, f)).mtimeMs));
    if (found.length) return found.sort((a, b) => changed(b) - changed(a))[0];
  }
  return null;
}

test("the contracts here are accounts' own, byte for byte, whenever an openfrequency-accounts checkout is next to this one", (t) => {
  const theirs = accountsContracts();
  if (!theirs) {
    t.diagnostic('contracts: no openfrequency-accounts checkout next to this one (as in CI), so test/fixtures/contracts was not compared with it');
    return;
  }
  const ours = readdirSync(FIXTURES).sort();
  assert.deepEqual(ours, readdirSync(theirs).sort(), `test/fixtures/contracts has the files of ${theirs}`);
  for (const f of ours) assert.ok(readFileSync(path.join(FIXTURES, f)).equals(readFileSync(path.join(theirs, f))), `${f} differs from ${theirs}: accounts keeps the contracts, copy it from there`);
});

// ---- the shape

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Where `actual` does not have the shape of `example`, as a list of paths; [] when it does. */
export function shapeProblems(actual, example, nullable = [], at = '$') {
  const key = at.replace(/\[\d+\]$/, '').split('.').at(-1);
  if (actual === null) return example === null || nullable.includes(key) ? [] : [`${at}: null where the contract has ${kind(example)}`];
  if (example === null) return nullable.includes(key) ? [] : [`${at}: ${kind(actual)} where the contract has null`];
  if (kind(actual) !== kind(example)) return [`${at}: ${kind(actual)} where the contract has ${kind(example)}`];
  if (Array.isArray(example)) return example.length ? actual.flatMap((a, i) => shapeProblems(a, example[0], nullable, `${at}[${i}]`)) : [];
  if (kind(example) !== 'object') return [];
  const extra = Object.keys(actual).filter((k) => !(k in example));
  const missing = Object.keys(example).filter((k) => !(k in actual));
  return [
    ...(extra.length ? [`${at}: ${extra.join(', ')} not in the contract`] : []),
    ...(missing.length ? [`${at}: no ${missing.join(', ')}`] : []),
    ...Object.keys(example)
      .filter((k) => k in actual)
      .flatMap((k) => shapeProblems(actual[k], example[k], nullable, `${at}.${k}`)),
  ];
}

/** Every way an answer differs from a case: its status, then its body's shape (an error's body, exactly). */
function differences(res, a) {
  const out = res.status === a.status ? [] : [`status ${res.status} where the contract has ${a.status}`];
  if (a.status >= 400) return isDeepStrictEqual(res.json, a.body) ? out : [...out, `body ${JSON.stringify(res.json)} where the contract has ${JSON.stringify(a.body)}`];
  return [...out, ...shapeProblems(res.json, a.body, a.nullable || [])];
}

test('the shape check itself: keys missing or added, types, nulls where allowed, and the elements of a list', () => {
  assert.deepEqual(shapeProblems({ a: 1, b: null, c: [{ d: 'x' }, { d: 'y' }] }, { a: 2, b: 'z', c: [{ d: 'z' }] }, ['b']), []);
  assert.deepEqual(shapeProblems({ a: 1 }, { a: 1, b: 2 }), ['$: no b']);
  assert.deepEqual(shapeProblems({ a: 1, x: { y: 1, z: 2 } }, { a: 1, x: { y: 1 } }), ['$.x: z not in the contract']);
  assert.deepEqual(shapeProblems({ a: '1' }, { a: 1 }), ['$.a: string where the contract has number']);
  assert.deepEqual(shapeProblems({ a: null }, { a: 1 }), ['$.a: null where the contract has number']);
  assert.deepEqual(shapeProblems({ c: [{ d: 'z' }, { d: 1 }] }, { c: [{ d: 'z' }] }), ['$.c[1].d: number where the contract has string']);
  assert.deepEqual(shapeProblems({ c: {} }, { c: [] }), ['$.c: object where the contract has array']);
});

// ---- the APIs Teder serves: each case asked of the real route

let home;
let db;
let fake;
let main;
let bare;
const AT = '2026-10-30T10:00:00.000Z';

before(async () => {
  home = tempHome({ packs: { alpha: null } });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  db.run('UPDATE accounts SET workspace_id = NULL');
  fake = await fakeAccounts();
  // Teder as it runs: its public name on openfrequency.co.il, where accounts keeps a step's link.
  const env = { ...process.env, SESSION_SECRET: 'c'.repeat(40), ...fake.env, PUBLIC_HOST: 'teder.openfrequency.co.il' };
  main = await listen(ctx, { port: 0, env });
  // The same Teder with no OF_INTERNAL_TOKEN of its own: the 503 cases.
  bare = await listen(ctx, { port: 0, env: { ...env, OF_INTERNAL_TOKEN: '' } });
});

after(async () => {
  await workspaceCleanups();
  main?.server.close();
  bare?.server.close();
  await fake?.close();
  home?.cleanup();
});

/** As accounts asks: from this machine, the bearer (none with token null), and a POST's body {}. */
async function ask(teder, method, p, { token = INTERNAL_TOKEN } = {}) {
  const headers = { ...(token == null ? {} : { authorization: `Bearer ${token}` }), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(`http://127.0.0.1:${teder.port}${p}`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
  const text = await res.text();
  let json = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: compared as it is */
  }
  return { status: res.status, json };
}

/** No token, and a wrong one of the right length. */
const refused = async (method, p) => [await ask(main, method, p, { token: null }), await ask(main, method, p, { token: 'x'.repeat(INTERNAL_TOKEN.length) })];

const SETUP = 'setup /internal/setup :: ';
const DELETE = 'workspaces-delete /internal/workspaces/<workspace id>/delete :: ';

// Each case, by "<contract> <path> :: <case>": made, then asked. A run may ask more than once (each answer is checked).
const RUN = {
  // A workspace with nothing yet: one step links to /new, the others have no link (href null).
  [`${SETUP}the checklist (Teder)`]: () => ask(main, 'GET', '/internal/setup?workspace=5'),
  [`${SETUP}no token, or the wrong one`]: () => refused('GET', '/internal/setup?workspace=5'),
  [`${SETUP}OF_INTERNAL_TOKEN unset or short here`]: () => ask(bare, 'GET', '/internal/setup?workspace=5'),

  [`${DELETE}deleted`]: async () => {
    db.run("UPDATE accounts SET workspace_id = 3 WHERE id = 'alpha'");
    for (const id of ['p1', 'p2']) db.insert('posts', { id, account_id: 'alpha', status: 'approved', created_at: AT, updated_at: AT });
    const res = await ask(main, 'POST', '/internal/workspaces/3/delete');
    await workspaceCleanups();
    assert.deepEqual([res.json.deleted?.accounts, res.json.deleted?.posts], [1, 2], 'the workspace had an account and its posts');
    return res;
  },
  // Never seen, and asked again (workspace 3 is the one deleted above, or has nothing if this runs first).
  [`${DELETE}nothing of that workspace here (never seen, or deleted already)`]: async () => {
    const answers = [await ask(main, 'POST', '/internal/workspaces/77/delete'), await ask(main, 'POST', '/internal/workspaces/3/delete')];
    for (const res of answers) assert.equal(res.json.deleted?.accounts, 0, 'nothing was there');
    return answers;
  },
  [`${DELETE}no token, or the wrong one`]: () => refused('POST', '/internal/workspaces/3/delete'),
  [`${DELETE}OF_INTERNAL_TOKEN unset or short here`]: () => ask(bare, 'POST', '/internal/workspaces/3/delete'),
};

// A case Teder's real route cannot be made to answer, and why. Each is still a case of the contract: its other side is
// held by accounts' test/contracts.test.js (or Toran's).
const NOT_HERE = {
  [`${SETUP}the checklist (Toran)`]: "Toran's answer. Teder's route answers for Teder alone, product \"teder\" (the case before it); Toran's contracts test asks this one of Toran",
  [`${DELETE}no such route: a failure, accounts deletes nothing`]: "What a product without the route answers. Teder has the route, so no request to it can answer this without taking the route out of Teder's own code; accounts' test holds its client to reading it as a failure (ACC-06)",
};

// Where Teder's real route answers beyond its contract's example, exactly as found. A difference that goes away, or a new
// one, fails its case: the contract or the route changed, and this list follows it.
//
// - The delete's 200. Teder counts more than the contract's example and says what is left after the answer
//   (src/web/workspace-delete.js). The contract allows it: its note says "The body of a 200 is the product's own count
//   of what it deleted; accounts reads only the status". Its example, { ok, deleted: { accounts, posts } }, is one
//   product's.
//
// The refusals answer as the contracts say since 2026-10-30 (src/web/demos.js internalRefusal: 401 bad_token, 503
// not_configured), the same as Toran's; until then Teder answered 403 forbidden to all of them.
const COUNTED = ['$: after not in the contract', '$.deleted: sources, documents, onboarding, connections not in the contract'];
const DIFFERS = {
  [`${DELETE}deleted`]: COUNTED,
  [`${DELETE}nothing of that workspace here (never seen, or deleted already)`]: COUNTED,
};

test("the contracts Teder serves are setup and workspaces-delete, and every case of theirs is asked here or says why it cannot be", (t) => {
  const served = Object.values(contracts).filter((c) => c.servedBy.includes('teder'));
  assert.deepEqual(served.map((c) => c.name).sort(), ['setup', 'workspaces-delete']);
  const cases = served.flatMap((c) => c.routes.flatMap((r) => r.answers.map((a) => `${c.name} ${r.path} :: ${a.case}`)));
  for (const key of cases) assert.ok(Boolean(RUN[key]) !== Boolean(NOT_HERE[key]), `${key}: a run, or the reason there is none (one, not both)`);
  for (const key of [...Object.keys(RUN), ...Object.keys(NOT_HERE), ...Object.keys(DIFFERS)]) assert.ok(cases.includes(key), `${key}: no such case in the contracts`);
  for (const [key, why] of Object.entries(NOT_HERE)) t.diagnostic(`not asked of Teder: ${key}: ${why}`);
});

for (const c of Object.values(contracts).filter((x) => x.servedBy.includes('teder'))) {
  for (const r of c.routes) {
    for (const a of r.answers) {
      const key = `${c.name} ${r.path} :: ${a.case}`;
      if (NOT_HERE[key]) continue; // listed with its reason, and checked by the test above
      test(`contract ${key}${DIFFERS[key] ? ' (Teder differs, as recorded in DIFFERS)' : ''}`, async () => {
        assert.ok(RUN[key], `no run for ${key}: every case of a route Teder serves is asked of the real route, or says why not`);
        const answers = [await RUN[key]()].flat();
        for (const res of answers) {
          assert.deepEqual(differences(res, a), DIFFERS[key] || [], `${key}: ${res.status} ${JSON.stringify(res.json)}`);
          if (c.name === 'setup' && res.status === 200) assert.deepEqual(setupRules(res.json, a), [], key);
        }
      });
    }
  }
}

/** The rules setup.json's notes add to the shape: an answer that breaks one is not used at all by accounts. */
function setupRules(body, a) {
  const out = [];
  if (body.product !== a.body.product) out.push(`product ${body.product}`);
  if (body.steps.length > 30) out.push(`${body.steps.length} steps`);
  if (new Set(body.steps.map((s) => s.key)).size !== body.steps.length) out.push('two steps with one key');
  for (const s of body.steps) {
    if (!/^[A-Za-z0-9_.:-]{1,60}$/.test(s.key)) out.push(`key ${s.key}`);
    if (!['todo', 'working', 'done', 'attention', 'soon'].includes(s.status)) out.push(`${s.key}: status ${s.status}`);
    if (s.href !== null && !s.href.startsWith('/') && !/^https:\/\/([a-z0-9-]+\.)*openfrequency\.co\.il(\/|$)/.test(s.href)) out.push(`${s.key}: href ${s.href}`);
  }
  return out;
}
