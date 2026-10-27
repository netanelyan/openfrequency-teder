#!/usr/bin/env node
// Why an account's posts come out with or without photographs.
//
//   npm run images:check            every account
//   npm run images:check -- mma     one account, by its pack id
//
// For each account: what its pack asks for (the photo libraries, and whether they are ready; a cover photograph; a
// photograph behind the slides), then its last posts: how many carry a photograph, and for the searches that found
// none, why each candidate was passed over (src/images/index.js records it in the post's image step). Reads only
// the database and the packs: nothing is fetched.
import { loadEnv } from '../src/core/env.js';
import { loadAll } from '../src/packs/load.js';
import { openDb, j } from '../src/db/index.js';
import { PROVIDERS, providerOrder } from '../src/images/index.js';

loadEnv();
const only = process.argv[2] || null;
const db = openDb();
const packs = loadAll().filter((p) => !only || p.id === only);
if (!packs.length) {
  console.log(only ? `no pack "${only}"` : 'no packs');
  process.exit(1);
}
const N = 30;
for (const pack of packs) {
  const opts = pack.theme.options || {};
  // In the order a post searches them: the owner's own photographs first when the pack has any.
  const libs = (pack.meta.imagery?.providers || []).length ? providerOrder(pack) : [];
  console.log(`\n${pack.meta.displayName} (${pack.id})`);
  console.log(`  photo libraries: ${libs.length ? libs.map((id) => `${id}${PROVIDERS[id] ? (PROVIDERS[id].ready() ? '' : ' (key missing)') : ' (unknown)'}`).join(', ') : 'none: imagery.providers is empty, so no post searches for a photograph'}`);
  console.log(`  cover photograph: ${opts.coverPhoto ? 'yes' : 'no (theme.options.coverPhoto is off)'} · behind the slides: ${opts.backgroundPhoto ? `yes (${(pack.theme.backgroundQueries || []).join(' / ')})` : 'no'}`);
  const posts = db.all("SELECT id, kind, status, checks_json FROM posts WHERE account_id = ? AND sample = 0 AND status NOT IN ('drafting') ORDER BY created_at DESC LIMIT ?", pack.id, N);
  const withPhoto = posts.filter((p) => (j(p.checks_json, {}).images || []).length);
  console.log(`  last ${posts.length} posts: ${withPhoto.length} with a photograph, ${posts.length - withPhoto.length} without`);
  const byKind = {};
  for (const p of posts) {
    const k = (byKind[p.kind || '?'] ??= { n: 0, photo: 0 });
    k.n++;
    if (withPhoto.includes(p)) k.photo++;
  }
  console.log(`  by kind: ${Object.entries(byKind).map(([k, v]) => `${k} ${v.photo}/${v.n}`).join(' · ')}`);
  const steps = posts.length ? db.all(`SELECT detail_json, status FROM steps WHERE step = 'image' AND post_id IN (${posts.map(() => '?').join(',')})`, ...posts.map((p) => p.id)) : [];
  const tried = steps.length;
  const missed = steps.filter((s) => s.status === 'skipped').map((s) => j(s.detail_json, {}));
  console.log(`  searches: ${tried}, found nothing: ${missed.length}`);
  const why = {};
  for (const m of missed) for (const [k, n] of Object.entries(m.why || { 'no reason recorded (a post from before reasons were kept, or a recorded run)': 1 })) why[k] = (why[k] || 0) + n;
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(n).padStart(4)}  ${k}`);
  const faceless = db.get("SELECT COUNT(*) AS n FROM steps s JOIN posts p ON p.id = s.post_id WHERE p.account_id = ? AND s.step = 'outline' AND s.status = 'skipped' AND s.detail_json LIKE '%no licensed photograph of both sides%'", pack.id).n;
  if (faceless) console.log(`  head-to-heads passed over for a missing face: ${faceless}`);
  const queries = missed.map((m) => m.query).filter(Boolean).slice(0, 8);
  if (queries.length) console.log(`  queries that found nothing, latest: ${queries.map((q) => `"${q}"`).join(', ')}`);
}
