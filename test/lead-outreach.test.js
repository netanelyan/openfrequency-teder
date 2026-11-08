import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { ROOT } from '../src/core/paths.js';
import { setNow } from '../src/core/clock.js';
import { outreachOn, outreachUrl, sendPitch, UNREACHABLE } from '../src/leads/outreach.js';
import { leadsRoutes } from '../src/web/leads.js';
import { INTERNAL_TOKEN, tempHome } from './helpers.js';

// /leads' "לשלוח בוואטסאפ מהמספר שלנו" (the owner, 2026-11-08: "if i press the send button to a demo suggestion, i want it
// to go to whatsapp, so toran should send it"): Teder hands the pitch to Toran (POST /internal/outreach/send,
// test/fixtures/outreach-send.json, the same file in Toran), which sends it from our number under its limits, and the
// lead is marked sent only when Toran says it went. Toran is a stand-in on this machine. Numbers are fictional.

const CONTRACT = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'outreach-send.json'), 'utf8'));
const ROUTE = CONTRACT.routes[0];
const caseOf = (re) => ROUTE.answers.find((a) => re.test(a.case));

/** A stand-in for Toran's route: answers each request with `next` (a contract case), and keeps what it was asked. */
async function stubToran() {
  const state = { asked: [], next: caseOf(/^Meta took it/) };
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    state.asked.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const a = req.headers.authorization === `Bearer ${INTERNAL_TOKEN}` ? state.next : caseOf(/no token/);
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('the client hands the pitch to Toran as the contract says, and reads every answer', async () => {
  const toran = await stubToran();
  const env = { OF_TORAN_INTERNAL: toran.base, OF_INTERNAL_TOKEN: INTERNAL_TOKEN };
  const logs = [];
  const ctx = { log: (m) => logs.push(m) };
  try {
    assert.equal(outreachUrl(env), `${toran.base}${ROUTE.path}`);
    assert.equal(outreachUrl({ OF_TORAN_INTERNAL: 'off' }), null);
    assert.equal(outreachOn({ OF_TORAN_INTERNAL: toran.base }), false, 'no token: no button');
    assert.equal(outreachOn(env), true);
    const { product, ...pitch } = ROUTE.request.body;
    assert.equal(product, 'teder');
    assert.deepEqual(await sendPitch(ctx, pitch, { env }), { sent: true, why: null, said: caseOf(/^Meta took it/).body.said });
    assert.deepEqual(toran.state.asked[0], { path: ROUTE.path, auth: `Bearer ${INTERNAL_TOKEN}`, body: ROUTE.request.body }, "the contract's example, as it is");
    toran.state.next = caseOf(/^held/);
    assert.deepEqual(await sendPitch(ctx, pitch, { env }), { sent: false, why: 'cap', said: caseOf(/^held/).body.said }, "held: Toran's own words for the operator");
    for (const re of [/^OF_INTERNAL_TOKEN is not set/, /^a body that is not a pitch/]) {
      toran.state.next = caseOf(re);
      assert.deepEqual(await sendPitch(ctx, pitch, { env }), { sent: false, why: 'unreachable', said: UNREACHABLE });
    }
    assert.deepEqual(await sendPitch(ctx, pitch, { env: { ...env, OF_INTERNAL_TOKEN: 'wrong-token-wrong-token-wrong-token-00' } }), { sent: false, why: 'unreachable', said: UNREACHABLE });
    assert.ok(logs.every((l) => !l.includes(INTERNAL_TOKEN)), 'the token is never in a log line');
  } finally {
    await toran.close();
  }
});

test('/leads/<id>/wa: the first message, then the reminder when it is due, each marked only when Toran sent it', async () => {
  const home = tempHome();
  const db = new Db(path.join(home.home, 'data.db'));
  const toran = await stubToran();
  const env = { OF_TORAN_INTERNAL: toran.base, OF_INTERNAL_TOKEN: INTERNAL_TOKEN, PUBLIC_HOST: 'teder.openfrequency.co.il' };
  const ctx = { db, log: () => {} };
  const user = { name: 'Demo', operator: true };
  const route = leadsRoutes({ env }).find(([method, re]) => method === 'POST' && re.test('/leads/1/wa'));
  const press = (id) => route[2](ctx, user, ['', String(id)], {});
  const at = '2026-11-10T10:00:00.000Z';
  setNow(Date.parse(at));
  try {
    const demo = db.insert('demos', { slug: 'nurit-a1b2c3', url: 'https://nurit.example/', domain: 'nurit.example', origin: 'outreach', status: 'approved', created_at: at, updated_at: at });
    const lead = db.insert('leads', { domain: 'nurit.example', url: 'https://nurit.example/', name: 'כלי חרס של נורית', whatsapp: '972500000123', stage: 'demo_ready', demo_id: demo, created_at: at, updated_at: at });
    const none = db.insert('leads', { domain: 'none.example', url: 'https://none.example/', name: 'בלי וואטסאפ', stage: 'demo_ready', demo_id: demo, created_at: at, updated_at: at });
    // Held at Toran: said, and nothing marked.
    toran.state.next = caseOf(/^held/);
    await assert.rejects(press(lead), (e) => e.message === caseOf(/^held/).body.said);
    assert.equal(db.get('SELECT stage FROM leads WHERE id = ?', lead).stage, 'demo_ready');
    // Sent: marked as "שלחתי" marks it, by WhatsApp.
    toran.state.next = caseOf(/^Meta took it/);
    const r = await press(lead);
    assert.equal(r.ok, true);
    assert.deepEqual(toran.state.asked.at(-1).body, { product: 'teder', stage: 'first', phone: '972500000123', name: 'כלי חרס של נורית', url: 'https://teder.openfrequency.co.il/s/nurit-a1b2c3', ref: `lead:${lead}`, by: 'Demo' });
    assert.deepEqual({ ...db.get('SELECT stage, sent_via FROM leads WHERE id = ?', lead) }, { stage: 'sent', sent_via: 'whatsapp' });
    // The reminder before it is due: refused here, Toran not asked.
    const asked = toran.state.asked.length;
    await assert.rejects(press(lead), /עוד לא הזמן לתזכורת/);
    assert.equal(toran.state.asked.length, asked);
    // Four days on (not Shabbat): the reminder, once.
    setNow(Date.parse('2026-11-16T10:00:00.000Z'));
    await press(lead);
    assert.equal(toran.state.asked.at(-1).body.stage, 'reminder');
    assert.ok(db.get('SELECT reminder_sent_at FROM leads WHERE id = ?', lead).reminder_sent_at);
    await assert.rejects(press(lead), /אין לחנות הזו הודעה לשלוח עכשיו/);
    // No WhatsApp from its site: nothing to send from our number.
    await assert.rejects(press(none), /אין לחנות הזו מספר וואטסאפ/);
  } finally {
    setNow(null);
    await toran.close();
    db.close?.();
    home.cleanup();
  }
});
