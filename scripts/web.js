#!/usr/bin/env node
// npm run web            the approval website, on 127.0.0.1:${PORT:-4700}
// npm start              the website and the runner (generation, publishing, metrics)
//
// Reads packs and data from $OF_HOME. With no private folder, says how to make
// one, or to try `npm run demo`.

import { requireHome } from '../src/core/paths.js';
import { loadEnv } from '../src/core/env.js';

try {
  requireHome();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
loadEnv();
const { makeContext } = await import('../src/engine.js');
const { listen } = await import('../src/web/server.js');
const { startRunner } = await import('../src/autonomy/runner.js');

const { recoverOnboarding } = await import('../src/web/onboarding.js');
const { offerFacebook } = await import('../src/publish/connect.js');

const ctx = makeContext({ log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
// A new account's search for sources that a restart cut off is failed, and its page offers to search again.
const cut = recoverOnboarding(ctx.db);
if (cut) console.log(`onboarding: ${cut} search(es) for sources interrupted by a restart, marked to try again`);
// The accounts customers made before Facebook existed get it as a platform, once, so they can connect a Page.
const fb = offerFacebook(ctx);
if (fb.length) console.log(`facebook: added as a platform to ${fb.length} customer account(s), to connect a Page from the account page`);
const { port } = await listen(ctx);
console.log(`open-frequency: http://127.0.0.1:${port}  (${ctx.packs.length} accounts, mode ${ctx.mode})`);
// Sign-in is openfrequency-accounts' (src/web/accounts.js): without the shared token nobody gets in.
if (String(process.env.OF_INTERNAL_TOKEN || '').trim().length < 32) {
  console.log('OF_INTERNAL_TOKEN is not set (32+ characters, the same value as in openfrequency-accounts): nobody can sign in.');
}
const loose = ctx.db.all('SELECT id FROM accounts WHERE workspace_id IS NULL').map((r) => r.id);
if (loose.length) console.log(`In no workspace yet, seen only by the operator: ${loose.join(', ')}. npm run workspace:assign gives them one.`);
if (process.argv.includes('--runner')) {
  startRunner(ctx);
  console.log('runner: on (one tick a minute)');
}
