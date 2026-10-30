import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectPanel, heList, requirements } from '../src/web/connect.js';

// The connect panel names the account's own networks, as Hebrew lists them: a new account has Facebook beside TikTok
// and Instagram (src/onboarding/pack.js), and an account without it is not told about it.

const panel = (platforms) => connectPanel({ operator: false }, { configured: false, hasProfile: false, mode: 'draft-now', pack: { id: 'a1' }, platforms: platforms.map((platform) => ({ platform, state: 'none' })) });

test('a list of networks reads as Hebrew writes it', () => {
  assert.equal(heList(['טיקטוק']), 'טיקטוק');
  assert.equal(heList(['טיקטוק', 'אינסטגרם']), 'טיקטוק ואינסטגרם');
  assert.equal(heList(['טיקטוק', 'אינסטגרם', 'פייסבוק']), 'טיקטוק, אינסטגרם ופייסבוק');
});

test("the connect panel's heading names the account's own networks, Facebook only where the account posts there", () => {
  assert.match(panel(['tiktok', 'instagram', 'facebook']), /<span>טיקטוק, אינסטגרם ופייסבוק<\/span>/);
  assert.match(panel(['tiktok', 'instagram']), /<span>טיקטוק ואינסטגרם<\/span>/);
  assert.doesNotMatch(panel(['tiktok', 'instagram']), /פייסבוק/);
});

test('the consent line before the buttons names Zernio for every network, Facebook included', () => {
  const html = requirements({ mode: 'draft-now', platforms: [{ platform: 'facebook', state: 'none' }, { platform: 'tiktok', state: 'connected' }] });
  assert.match(html, /בחיבור מאשרים את Zernio, השירות שמפרסם בשבילנו\./);
  assert.match(html, /בפייסבוק מחברים עמוד של העסק שאתם מנהלים/);
});
