import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/core/paths.js';
import { assertAllowed, isSocial, WRITE_RULES, READ_RULES } from '../src/core/net.js';

// HARD RULE 1: the engine never likes, follows, comments, DMs, or reads other
// accounts by logging in. There is no code path that could, and these tests are
// what keep it that way: they scan the code itself.

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(n)) out.push(p);
  }
  return out;
}
const CODE = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

test('nothing calls fetch except the network door', () => {
  // The browser script is the one exception: it runs in the owner's browser and
  // posts only to our own server, same origin, under the site's CSP.
  const offenders = CODE.filter((f) => rel(f) !== 'src/core/net.js' && !rel(f).startsWith('src/web/static/') && /(?<![\w.])fetch\s*\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map(rel), []);
});

test('no engagement function exists anywhere in the code', () => {
  // A function, method or export whose name is an engagement action.
  const NAME = /\b(?:function\s+|const\s+|let\s+|async\s+|export\s+(?:async\s+)?function\s+|\b)(like|unlike|follow|unfollow|comment|reply|replyTo|sendDm|sendDM|dm|directMessage|sendMessage|message[A-Z]\w*|likePost|followAccount|commentOn|postComment|engage\w*|autoLike|autoFollow|scrape\w*|login(?:To)?(?:Instagram|TikTok)\w*)\s*(?:=\s*(?:async\s*)?\(|\()/;
  const hits = [];
  for (const f of CODE) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/^\s*\/\//.test(l)) return;
      const m = NAME.exec(l);
      if (m) hits.push(`${rel(f)}:${i + 1} ${m[1]}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('no engagement endpoint is named anywhere in the code', () => {
  const ENDPOINT = /graph\.(?:facebook|instagram)\.com\/[^'"\s]*\/(?:comments|likes|replies|conversations|messages)|open\.tiktokapis\.com\/v2\/(?:comment|like|follow|dm)|\/(?:inbox|direct_v2|friendships|follow_user|like_post)\b|private_replies/i;
  // net.js names the Zernio inbox only to refuse it; its rules are tested on their own below.
  const hits = CODE.filter((f) => rel(f) !== 'src/core/net.js' && ENDPOINT.test(readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(hits, []);
});

test("the only writes are Claude, our own post and a customer account's profile on Zernio (the Instagram account a customer picked in it, and their removal once the customer left), publishing our own post on Instagram, deleting it after a takedown, and an empty push to the owner's browser", () => {
  assert.deepEqual(
    WRITE_RULES.map((r) => `${r.method} ${r.host} ${r.path.source}`),
    [
      'POST api.anthropic.com ^\\/v1\\/messages$',
      'POST api.anthropic.com ^\\/v1\\/messages\\/batches$',
      'POST zernio.com ^\\/api\\/v1\\/posts$',
      'POST zernio.com ^\\/api\\/v1\\/profiles$',
      'POST zernio.com ^\\/api\\/v1\\/connect\\/instagram\\/select-account$',
      'POST zernio.com ^\\/api\\/v1\\/connect\\/facebook\\/select-page$',
      'POST zernio.com ^\\/api\\/v1\\/posts\\/[A-Za-z0-9_-]+\\/unpublish$',
      'DELETE zernio.com ^\\/api\\/v1\\/accounts\\/[A-Za-z0-9_-]+$',
      'DELETE zernio.com ^\\/api\\/v1\\/profiles\\/[A-Za-z0-9_-]+$',
      'POST graph.facebook.com ^\\/v\\d+\\.\\d+\\/\\d+\\/(media|media_publish)$',
      'POST graph.instagram.com ^\\/v\\d+\\.\\d+\\/\\d+\\/(media|media_publish)$',
      'DELETE graph.facebook.com ^\\/v\\d+\\.\\d+\\/\\d+$',
      'POST fcm.googleapis.com ^\\/(fcm\\/send|wp)\\/[A-Za-z0-9_:.-]+$',
      'POST updates.push.services.mozilla.com ^\\/wpush\\/v[12]\\/[A-Za-z0-9_=-]+$',
      'POST web.push.apple.com ^\\/[A-Za-z0-9_=-]+$',
      'POST notify.windows.com ^\\/w\\/$',
    ]
  );
  // A write that reaches a social host is publishing on our own account through its official API, or
  // deleting one of our posts by its numeric id; never an edge (a comment, a like) and never a POST to an object.
  for (const r of WRITE_RULES.filter((x) => isSocial(x.host))) {
    if (r.method === 'DELETE') assert.equal(r.path.source, '^\\/v\\d+\\.\\d+\\/\\d+$', `${r.host} deletes only a media object by id`);
    else assert.match(r.path.source, /\(media\|media_publish\)\$$/, `${r.host} writes only create and publish media`);
  }
  assert.throws(() => assertAllowed('DELETE', 'https://graph.facebook.com/v25.0/17895695668004550/comments'), /refused/);
  assert.throws(() => assertAllowed('POST', 'https://graph.facebook.com/v25.0/17895695668004550'), /refused/);
  assert.throws(() => assertAllowed('DELETE', 'https://zernio.com/api/v1/posts/abc'), /refused/);
  // A deleted customer's accounts and profile leave our own Zernio team; nothing under them is reachable that way.
  assert.ok(assertAllowed('DELETE', 'https://zernio.com/api/v1/accounts/acc_123'));
  assert.ok(assertAllowed('DELETE', 'https://zernio.com/api/v1/profiles/prof_123'));
  assert.throws(() => assertAllowed('DELETE', 'https://zernio.com/api/v1/accounts/acc_123/posts'), /refused/);
  assert.throws(() => assertAllowed('DELETE', 'https://zernio.com/api/v1/accounts'), /refused/);
  // The headless connect picks an Instagram account or a Facebook Page into our own profile; no other selection is
  // reachable (a LinkedIn organisation, a Google Business location).
  assert.ok(assertAllowed('POST', 'https://zernio.com/api/v1/connect/instagram/select-account'));
  assert.ok(assertAllowed('POST', 'https://zernio.com/api/v1/connect/facebook/select-page'));
  assert.ok(assertAllowed('GET', 'https://zernio.com/api/v1/connect/facebook/select-page?profileId=p1'));
  assert.ok(assertAllowed('GET', 'https://zernio.com/api/v1/connect/facebook?profileId=p1'));
  assert.throws(() => assertAllowed('POST', 'https://zernio.com/api/v1/connect/linkedin/select-organization'), /refused/);
  assert.throws(() => assertAllowed('GET', 'https://zernio.com/api/v1/connect/linkedin'), /refused/);
  // A takedown unpublishes one post of ours; nothing else under a post is writable.
  assert.ok(assertAllowed('POST', 'https://zernio.com/api/v1/posts/p_123/unpublish'));
  assert.throws(() => assertAllowed('POST', 'https://zernio.com/api/v1/posts/p_123/retry'), /refused/);
  assert.throws(() => assertAllowed('DELETE', 'https://zernio.com/api/v1/posts/p_123'), /refused/);
  for (const r of READ_RULES.filter((x) => isSocial(x.host))) assert.ok(r.path, `${r.host} reads are limited to listed API paths`);
});

test('the Graph API is open for publishing and our own numbers, never for comments, mentions, messages or other accounts', () => {
  for (const [m, u] of [
    ['POST', 'https://graph.facebook.com/v25.0/17841400000000000/media'],
    ['POST', 'https://graph.instagram.com/v25.0/17841400000000000/media_publish'],
    ['GET', 'https://graph.facebook.com/v25.0/17895695668004550?fields=status_code,status'],
    ['GET', 'https://graph.facebook.com/v25.0/17895695668004550/insights?metric=reach,saved,shares,likes,comments,views'],
    ['GET', 'https://graph.facebook.com/v25.0/17841400000000000/content_publishing_limit?fields=quota_usage,config'],
    ['GET', 'https://graph.facebook.com/v25.0/debug_token?input_token=x'],
    ['GET', 'https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token'],
  ]) assert.doesNotThrow(() => assertAllowed(m, u), `${m} ${u}`);
  for (const [m, u] of [
    ['POST', 'https://graph.facebook.com/v25.0/17895695668004550/comments'],
    ['POST', 'https://graph.facebook.com/v25.0/17895695668004550/replies'],
    ['POST', 'https://graph.facebook.com/v25.0/17841400000000000/messages'],
    ['POST', 'https://graph.facebook.com/v25.0/17841400000000000/mentions'],
    ['GET', 'https://graph.facebook.com/v25.0/17895695668004550/comments'],
    ['GET', 'https://graph.facebook.com/v25.0/17841400000000000/tags'],
    ['GET', 'https://graph.facebook.com/v25.0/17841400000000000/conversations'],
    ['GET', 'https://graph.facebook.com/v25.0/ig_hashtag_search?q=x'],
    ['GET', 'https://graph.facebook.com/v25.0/17841400000000000?fields=business_discovery.username(someone){followers_count}'],
    ['GET', 'https://graph.facebook.com/v25.0/17895695668004550?fields=comments{text,username}'],
    ['GET', 'https://graph.facebook.com/v25.0/17841400000000000/mentioned_media?media_id=1'],
    ['GET', 'https://graph.facebook.com/somebody'],
    ['GET', 'https://www.instagram.com/someone/'],
  ]) assert.throws(() => assertAllowed(m, u), /refused/, `${m} ${u}`);
});

test('the door refuses every write to a social platform and every inbox', () => {
  const refused = [
    ['POST', 'https://graph.instagram.com/v21.0/123/comments'],
    ['POST', 'https://www.tiktok.com/api/commit/follow/user/'],
    ['POST', 'https://api.x.com/2/users/1/likes'],
    ['POST', 'https://zernio.com/api/v1/inbox/messages'],
    ['GET', 'https://zernio.com/api/v1/inbox'],
    ['GET', 'https://zernio.com/api/v1/comments'],
    ['POST', 'https://zernio.com/api/v1/posts/abc/comments'],
    ['GET', 'https://www.instagram.com/someone/'],
    ['GET', 'https://www.tiktok.com/@someone'],
    ['GET', 'http://www.example.com/'],
    ['DELETE', 'https://zernio.com/api/v1/posts/abc'],
  ];
  for (const [m, u] of refused) assert.throws(() => assertAllowed(m, u), /refused/, `${m} ${u}`);
});

test('the door allows what the engine needs and nothing else', () => {
  for (const [m, u] of [
    ['POST', 'https://api.anthropic.com/v1/messages'],
    ['POST', 'https://zernio.com/api/v1/posts'],
    ['GET', 'https://zernio.com/api/v1/posts/abc123'],
    ['GET', 'https://zernio.com/api/v1/analytics'],
    ['GET', 'https://zernio.com/api/v1/accounts/abc123/tiktok/commercial-music?countryCode=IL'],
    ['GET', 'https://www.googleapis.com/youtube/v3/search'],
    ['GET', 'https://www.example.org/feed.xml'],
    ['GET', 'https://commons.wikimedia.org/w/api.php'],
  ]) assert.doesNotThrow(() => assertAllowed(m, u), `${m} ${u}`);
});

test('the browser never reaches the network while rendering', () => {
  const src = readFileSync(path.join(ROOT, 'src/render/render.js'), 'utf8');
  assert.match(src, /context\.route\('\*\*\/\*', \(route\) => route\.abort\(\)\)/);
});
