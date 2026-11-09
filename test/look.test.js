import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookOf, lookSheet } from '../src/web/look.js';
import { layout } from '../src/web/ui.js';
import { listenFree } from './helpers.js';

// The website's two looks (src/web/look.js, docs/design-pro.md; the owner, 2026-11-09: "make both dashboard look more
// professional ... save the current style so i will be able to revert if i dont like the new"): pro unless
// TEDER_STYLE=glass; glass is style.css as it is, pro is style.css with style-pro.css after it, at the same address.

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'static');
const glass = readFileSync(path.join(STATIC, 'style.css'), 'utf8');
const pro = readFileSync(path.join(STATIC, 'style-pro.css'), 'utf8');

test('the look is pro unless TEDER_STYLE says glass', () => {
  assert.equal(lookOf({}), 'pro');
  assert.equal(lookOf({ TEDER_STYLE: '' }), 'pro');
  assert.equal(lookOf({ TEDER_STYLE: 'pro' }), 'pro');
  assert.equal(lookOf({ TEDER_STYLE: ' Glass ' }), 'glass');
  assert.equal(lookOf({ TEDER_STYLE: 'something else' }), 'pro', 'a typo keeps the default');
});

test('glass is style.css exactly as it is; pro is style.css with the pro layer after it, so the layer wins', () => {
  assert.equal(lookSheet('glass').toString('utf8'), glass);
  const both = lookSheet('pro').toString('utf8');
  assert.ok(both.startsWith(glass), 'the glass file first, untouched');
  assert.ok(both.endsWith(pro), 'the pro layer last');
});

test('the server sends the look TEDER_STYLE picks at /static/style.css', async () => {
  for (const [env, want] of [[{}, lookSheet('pro')], [{ TEDER_STYLE: 'glass' }, lookSheet('glass')]]) {
    const s = await listenFree({ log: () => {} }, { env: { SESSION_SECRET: 's'.repeat(40), ...env } });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/static/style.css`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/css/);
      assert.equal(await r.text(), want.toString('utf8'), JSON.stringify(env));
    } finally {
      await s.close();
    }
  }
});

test('the pro layer: solid, the brief\'s tokens, dark on the attribute only, page margins kept', () => {
  for (const m of pro.matchAll(/backdrop-filter:\s*([^;]+);/g)) assert.equal(m[1].trim(), 'none', m[0]);
  assert.doesNotMatch(pro, /prefers-color-scheme/, 'dark is the reader\'s choice, never the device\'s');
  assert.match(pro, /:root \{\n  color-scheme: light;[^}]*\n  --bg: #eeeff2;/, 'the page the colour of the browser bar (THEME_COLOR)');
  assert.match(pro, /:root\[data-theme="dark"\] \{\n  color-scheme: dark;\n  --bg: #111113;/);
  assert.match(pro, /--accent-fill: #6a3fd6;/, 'one accent, Teder\'s violet');
  assert.match(pro, /--r: 12px;\n  --r-m: 8px;/, 'a card 12px, a control 8px');
  assert.doesNotMatch(pro.replace(/\/\*[^]*?\*\//g, ''), /html\.a-contrast/, 'the accessibility panel\'s high contrast still outranks the layer');
  assert.ok(pro.lastIndexOf('.mt16 { margin-top: 16px; }') > pro.lastIndexOf('.group {'), 'the utilities come last');
});

test('the spark is drawn in the middle of its square, so a label beside it sits on its centre', () => {
  const page = layout({ title: 't', csrf: 'c', theme: 'light' }, '');
  assert.ok(page.includes('<symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 5l1.9 5.5L19.5 12l-5.6 1.6L12 19l-1.9-5.4L4.5 12l5.6-1.5z"/>'));
});
