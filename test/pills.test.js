import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { makeContext } from '../src/engine.js';
import { listen } from '../src/web/server.js';
import { listField } from '../src/web/onboarding.js';
import { customer, fakeAccounts, opened, tempHome } from './helpers.js';

// A new account's topics and sites are typed as pills: Enter makes a pill, the pills sit in a row, and the form sends
// them one a line. The owner asked for it on 2026-10-31, in place of "separated by commas".

test('the server reads a typed list one item a line; topics by commas too (the field without the page script)', () => {
  assert.deepEqual(listField('espn.com\r\n@goal\n\n espn.com '), ['espn.com', '@goal']);
  assert.deepEqual(listField('ליגת האלופות\nמונדיאל', { commas: true }), ['ליגת האלופות', 'מונדיאל']);
  assert.deepEqual(listField('ליגת האלופות, מונדיאל، כדורגל', { commas: true }), ['ליגת האלופות', 'מונדיאל', 'כדורגל']);
  assert.deepEqual(listField('a, b', {}), ['a, b'], 'a site keeps its commas');
  assert.equal(listField(Array.from({ length: 30 }, (_, i) => `t${i}`).join('\n'), { max: 12 }).length, 12);
  assert.equal(listField('x'.repeat(100), { len: 60 })[0].length, 60);
  assert.deepEqual(listField(undefined), []);
});

test('in a real browser: Enter makes a pill, in a row; × and Backspace take one out; the form sends them a line each', async () => {
  const { home, cleanup } = tempHome();
  let server;
  let browser;
  let fake;
  try {
    const db = new Db(path.join(home, 'data.db'));
    opened.push(db);
    const ctx = makeContext({ db, packs: loadAll({ dir: path.join(home, 'packs') }), log: () => {} });
    ctx.mediaDir = path.join(home, 'media');
    fake = await fakeAccounts();
    const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'y'.repeat(40), ...fake.env } });
    server = s.server;
    const base = `http://127.0.0.1:${s.port}`;
    const { sid } = fake.session(customer(7));

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.addCookies([{ name: 'of_session', value: sid, url: base }]);
    const page = await context.newPage();
    // The form's post is answered here, so what it sends can be read and nothing starts.
    let posted = null;
    await page.route(`${base}/new`, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posted = new URLSearchParams(route.request().postData());
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>ok</p>' });
    });
    await page.goto(`${base}/new`);

    const topics = page.locator('.pills').nth(0);
    const sites = page.locator('.pills').nth(1);
    const pills = (box) => box.locator('.pill span').allTextContents();
    // The hint says Enter, not commas; the old fields are hidden and send nothing.
    assert.equal(await page.getByText('כותבים נושא ולוחצים Enter, לא חובה').isVisible(), true);
    assert.equal(await page.getByText('מופרדים בפסיקים, לא חובה').isVisible(), false);

    const typed = topics.locator('input.pill-typed');
    await typed.fill('ליגת האלופות');
    await typed.press('Enter');
    await typed.fill('מונדיאל');
    await typed.press('Enter');
    assert.equal(page.url(), `${base}/new`, 'Enter makes a pill and never sends the form');
    assert.equal(posted, null);
    assert.deepEqual(await pills(topics), ['ליגת האלופות', 'מונדיאל']);
    // In a row, not a line each.
    const [a, b] = await Promise.all([0, 1].map((i) => topics.locator('.pill').nth(i).boundingBox()));
    assert.equal(Math.round(a.y), Math.round(b.y));
    assert.notEqual(Math.round(a.x), Math.round(b.x));

    // Backspace in the empty box takes the last; × takes the one it is on; the same one twice is one pill.
    await typed.press('Backspace');
    assert.deepEqual(await pills(topics), ['ליגת האלופות']);
    for (const t of ['מונדיאל', 'כדורגל', 'כדורגל']) {
      await typed.fill(t);
      await typed.press('Enter');
    }
    assert.deepEqual(await pills(topics), ['ליגת האלופות', 'מונדיאל', 'כדורגל']);
    await topics.getByRole('button', { name: 'להסיר את מונדיאל' }).click();
    assert.deepEqual(await pills(topics), ['ליגת האלופות', 'כדורגל']);
    // Typed and not yet a pill: it goes with the form.
    await typed.fill('ספורט');

    const site = sites.locator('input.pill-typed');
    await site.fill('espn.com');
    await site.press('Enter');
    await site.fill('@goal');
    await site.press('Enter');
    assert.deepEqual(await pills(sites), ['espn.com', '@goal']);

    await page.fill('input[name="niche"]', 'כדורגל אירופי');
    await page.click('form[action="/new"] button[type="submit"]');
    await page.waitForFunction(() => document.body.textContent.includes('ok'));
    // A form sends its line breaks as CRLF; the server reads either.
    assert.equal(posted.get('topics'), 'ליגת האלופות\r\nכדורגל\r\nספורט');
    assert.equal(posted.get('examples'), 'espn.com\r\n@goal');
    assert.deepEqual(posted.getAll('topics').length, 1, 'one field each');
    assert.deepEqual(listField(posted.get('topics'), { commas: true }), ['ליגת האלופות', 'כדורגל', 'ספורט']);
  } finally {
    await browser?.close();
    server?.close();
    await fake?.close();
    cleanup();
  }
});
