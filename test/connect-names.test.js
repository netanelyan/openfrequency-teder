import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTAGRAM_NEEDS_HE, connectPanel, heList, requirements } from '../src/web/connect.js';

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

// The owner, 2026-11-05: "make sure it is stated that a business instagram account is needed for teder". Said on
// Instagram's own row, beside its button, while it is not connected: a professional account, business or creator
// (Zernio's rule: "Instagram requires a Business or Creator account"); no Facebook Page, since Instagram Login has none.
test("Instagram's row says it needs a professional account, beside its button, until it is connected", () => {
  const open = (state) => connectPanel({ operator: false }, { configured: true, hasProfile: false, mode: 'draft-now', pack: { id: 'a1' }, platforms: [{ platform: 'tiktok', state: 'none' }, { platform: 'instagram', state }] });
  const rows = (html) => [...html.matchAll(/<li class="net">([^]*?)<\/li>/g)].map((m) => m[1]);
  const [tiktok, instagram] = rows(open('none'));
  assert.ok(instagram.includes(`<div class="muted small">${INSTAGRAM_NEEDS_HE}</div>`), "on Instagram's row");
  assert.match(instagram, /לחבר את אינסטגרם/, 'the row of its button');
  assert.match(INSTAGRAM_NEEDS_HE, /^אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר\./);
  assert.doesNotMatch(INSTAGRAM_NEEDS_HE, /עמוד|פייסבוק/, 'no Facebook Page asked for');
  assert.doesNotMatch(tiktok, /מקצועי/, "not on TikTok's");
  assert.equal(open('none').split('חשבון מקצועי, עסקי או יוצר').length - 1, 1, 'said once, not also in the list above');
  assert.doesNotMatch(open('connected'), /חשבון מקצועי/, 'connected: nothing to say');
});
