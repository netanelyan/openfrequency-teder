#!/usr/bin/env node
// npm run demo [-- --no-serve] [-- --port 4700]
//
// The whole engine on the fictional demo pack, in a throwaway home (./.demo,
// gitignored, rebuilt on every run): posts in every state, then the website.
//
// The Results page needs published posts with numbers, and the demo has never
// published anything real. So the demo seeds a few readings and marks every one
// of them `source: demo-seed`; the Results page then says, in a banner, that
// the numbers are invented for the demo. The engine itself never writes a
// number an API did not give.

import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ROOT, examplesDir } from '../src/core/paths.js';

const args = process.argv.slice(2);
const home = path.join(ROOT, '.demo');
process.env.OF_HOME = home;
process.env.OF_MODE = 'recorded';
rmSync(home, { recursive: true, force: true });
cpSync(path.join(examplesDir, 'demo'), path.join(home, 'packs', 'demo'), { recursive: true });
// Two more fictional brands, so the pages can show several accounts side by side (scripts/demo-extras.js).
const { EXTRAS } = await import('./demo-extras.js');
const { mkdirSync, writeFileSync } = await import('node:fs');
for (const x of EXTRAS) {
  const dir = path.join(home, 'packs', x.id);
  for (const sub of ['recordings/documents', 'recordings/drafts']) mkdirSync(path.join(dir, sub), { recursive: true });
  for (const k of ['pack', 'theme', 'sources', 'formats', 'rules']) writeFileSync(path.join(dir, `${k}.json`), JSON.stringify(x[k], null, 2));
  writeFileSync(path.join(dir, 'voice.md'), x.voice);
  for (const [key, d] of Object.entries(x.documents)) writeFileSync(path.join(dir, 'recordings', 'documents', `${key}.json`), JSON.stringify(d, null, 2));
  for (const [key, d] of Object.entries(x.drafts)) writeFileSync(path.join(dir, 'recordings', 'drafts', `${key}.json`), JSON.stringify({ document: key, ...d }, null, 2));
}

const { makeContext } = await import('../src/engine.js');
const { buildPost } = await import('../src/pipeline/build.js');
const { publishPost } = await import('../src/publish/index.js');
const { DEMO_WORKSPACE, startDemoAccounts } = await import('./demo-accounts.js');
const { learn } = await import('../src/metrics/collect.js');
const { morningFeedback } = await import('../src/metrics/feedback.js');
const { saveRival } = await import('../src/pipeline/rivals.js');
const { israelDate, israelInstant, addDays } = await import('../src/schedule/israel.js');
const { slotsFor } = await import('../src/schedule/slots.js');
const { inRest } = await import('../src/schedule/shabbat.js');
// The dry publisher refuses Shabbat and the festivals as the real one does: a post dated on one is published, in the
// demo, at the same hour of the weekday before it, and keeps its own date.
const weekday = (iso, hhmm) => {
  let d = israelDate(Date.parse(iso));
  while (inRest(israelInstant(d, hhmm).getTime())) d = addDays(d, -1);
  return israelInstant(d, hhmm).getTime();
};
const { closeBrowser } = await import('../src/render/render.js');
const { writeSummaries } = await import('../src/autonomy/runner.js');

const ctx = makeContext({ log: () => {} });
const db = ctx.db;
const pack = ctx.pack('demo');
// Every demo account is the fictional workspace's, the one the stand-in for accounts signs the browser in to.
db.run('UPDATE accounts SET workspace_id = ?', DEMO_WORKSPACE.id);
// That workspace has paid, as the stand-in answers (scripts/demo-accounts.js) and as the entitlement client keeps the
// answer (src/billing/entitlement.js): without it the dry publisher refused every post as unpaid, and Results was empty.
const { setSetting } = await import('../src/core/store.js');
setSetting(db, `entitlement:${DEMO_WORKSPACE.id}`, { allowed: true, access: 'paid', paidThrough: null, cancelAt: null, plan: null, stoppedAt: null, checkedAt: new Date().toISOString() });

const now = Date.now();
const today = israelDate(now);
const HOUR = 3_600_000;
const build = async (opts = {}) => {
  const r = await buildPost(ctx, { pack, ...opts });
  if (r.status !== 'queued') console.log(`demo: a post was ${r.status} (${r.reason})`);
  return r;
};

// Five posts published in the past fortnight, two of them in the last three days, each with demo readings once a
// day (at 12, 36, 60 and 84 hours, as far as its age goes), so the morning's feedback has something to put in its boxes.
const past = [];
for (const [daysAgo, views, likes, shares, saves] of [
  [12, 4200, 310, 64, 120],
  [8, 1900, 96, 11, 31],
  [5, 6100, 520, 140, 260],
  [2, 5600, 560, 150, 240],
  [1.6, 1500, 50, 5, 14],
]) {
  const r = await build();
  const at = new Date(now - daysAgo * 24 * HOUR).toISOString();
  db.update('posts', r.postId, { status: 'approved', approved_by: 'demo', approved_at: at, slot_at: at });
  await publishPost(ctx, r.postId, { t: weekday(at, '12:45') }).catch((e) => console.log(`demo publish: ${e.message}`));
  db.update('posts', r.postId, { published_at: at, created_at: at });
  for (const [platform, v, l, s, sv] of [
    ['tiktok', views, likes, shares, null],
    ['instagram', Math.round(views * 0.35), Math.round(likes * 0.4), Math.round(shares * 0.3), saves],
  ]) {
    for (const age of [12, 36, 60, 84].filter((a) => a <= daysAgo * 24)) {
      const f = Math.min(1, (age + 12) / 84);
      const n = (x) => (x == null ? null : Math.round(x * f));
      db.insert('metrics', { post_id: r.postId, platform, collected_at: new Date(Date.parse(at) + age * HOUR).toISOString(), age_hours: age, views: n(v), likes: n(l), comments: n(l / 12), shares: n(s), saves: n(sv), raw_json: { source: 'demo-seed' } });
    }
  }
  past.push(r.postId);
}
learn(ctx);

// Today: one published this morning, one approved for later, two waiting.
const { slots } = slotsFor(today, pack.meta.schedule);
const later = slots.find((s) => s.getTime() > now) || new Date(now + 3 * HOUR);
const r1 = await build();
db.update('posts', r1.postId, { status: 'approved', approved_by: 'demo', approved_at: new Date(now - 2 * HOUR).toISOString(), slot_at: new Date(now - HOUR).toISOString() });
await publishPost(ctx, r1.postId, { t: Date.parse(israelInstant(today, '12:41').toISOString()) }).catch((e) => console.log(`demo publish: ${e.message}`));
const r2 = await build({ slotAt: later.toISOString() });
db.update('posts', r2.postId, { status: 'approved', approved_by: 'demo', approved_at: new Date(now - 30 * 60_000).toISOString() });
await build({ slotAt: new Date(later.getTime() + 2 * HOUR).toISOString() });
// Nothing new is left to draft from, so the last one is refused by the pipeline, and says why.
await build({ slotAt: israelInstant(addDays(today, 1), '12:40').toISOString() });
// The two extra brands: one post published last week with demo readings, one for today.
for (const [id, views] of [['demo-coffee', 2600], ['demo-running', 5300]]) {
  const p = ctx.pack(id);
  const a = await buildPost(ctx, { pack: p });
  const at = new Date(now - 6 * 24 * HOUR).toISOString();
  db.update('posts', a.postId, { status: 'approved', approved_by: 'demo', approved_at: at, slot_at: at });
  await publishPost(ctx, a.postId, { t: weekday(at, '19:00') }).catch((e) => console.log(`demo publish: ${e.message}`));
  db.update('posts', a.postId, { published_at: at, created_at: at });
  for (const [platform, v, sv] of [['tiktok', views, null], ['instagram', Math.round(views * 0.3), Math.round(views * 0.02)]]) {
    db.insert('metrics', { post_id: a.postId, platform, collected_at: new Date(Date.parse(at) + 80 * HOUR).toISOString(), age_hours: 80, views: v, likes: Math.round(v * 0.06), comments: Math.round(v * 0.004), shares: Math.round(v * 0.012), saves: sv, raw_json: { source: 'demo-seed' } });
  }
  const s2 = slotsFor(today, p.meta.schedule).slots.find((x) => x.getTime() > now) || new Date(now + 4 * HOUR);
  const b = await buildPost(ctx, { pack: p, slotAt: s2.toISOString() });
  if (id === 'demo-running' && b.status === 'queued') db.update('posts', b.postId, { status: 'approved', approved_by: 'engine:auto', approved_at: new Date().toISOString() });
}
// The plant account's rivals, as an owner would type them in (fictional handles). One was last looked at five weeks ago.
const RIVALS = [
  { handle: 'demo.mirpeset.yeruka', platform: 'tiktok', hooks: ['הבזיליקום שלכם מת בגלל דבר אחד', '3 צמחים שאי אפשר להרוג', 'השקיתי פעם בשבוע, וזה מה שקרה'], formats: ['דירוג 5 עד 1', 'לפני ואחרי'], times: '18:00, 21:30', gaps: 'אף אחד לא מסביר מה עושים בחורף במרפסת צפונית, ואף אחד לא נותן מחירים של עציצים' },
  { handle: 'demo.ezitz.katan', platform: 'instagram', hooks: ['הטעות שכולם עושים עם נענע', 'העציץ הזה שווה 20 שקל ומחזיק שנים'], formats: ['מדריך בשקפים', 'מיתוס מול אמת'], times: '20:00', gaps: 'הכל צילומים יפים בלי הסבר למה צמח מת' },
  { handle: 'demo.yarok.babait', platform: 'tiktok', hooks: ['צמח שמשגשג בלי שמש בכלל'], formats: ['סיפור בשקפים'], times: '19:00, 22:00', gaps: 'לא מדברים על חיות מחמד וצמחים רעילים' },
];
for (const r of RIVALS) {
  const { id: rid } = saveRival(db, 'demo', { ...r, hooks: r.hooks.join('\n'), formats: r.formats.join('\n') }, { by: 'demo' });
  if (r.handle === 'demo.yarok.babait') db.update('rivals', rid, { updated_at: new Date(Date.now() - 36 * 24 * HOUR).toISOString() });
}
learn(ctx);
// This morning's feedback, from the demo readings above.
for (const p of ctx.packs) await morningFeedback(ctx, p, { pull: false });
writeSummaries(ctx, addDays(today, -1));
await closeBrowser();

console.log(`demo: ${db.get('SELECT COUNT(*) AS n FROM posts').n} posts in ${home}`);
if (!args.includes('--no-serve')) {
  const { listen } = await import('../src/web/server.js');
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : Number(process.env.PORT) || 4700;
  // No accounts service here: a stand-in signs the browser in (scripts/demo-accounts.js).
  const accounts = await startDemoAccounts();
  const s = await listen(ctx, { port, env: { ...process.env, ...accounts.env } });
  console.log(`\nopen http://localhost:${s.port}\n  the first visit signs you in, as the owner of a fictional workspace\n(fictional demo data; nothing here is real)`);
}
