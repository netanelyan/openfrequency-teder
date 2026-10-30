import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db/index.js';
import { loadAll } from '../src/packs/load.js';
import { validatePack } from '../src/packs/validate.js';
import { makeContext } from '../src/engine.js';
import { buildPost, loadPost } from '../src/pipeline/build.js';
import { listen } from '../src/web/server.js';
import { closeBrowser } from '../src/render/render.js';
import { israelInstant } from '../src/schedule/israel.js';
import { captionOf, publishPost } from '../src/publish/index.js';
import { postBody, publishZernio } from '../src/publish/zernio.js';
import { connectLink, connectState, ensureProfile, offerFacebook, refreshConnections, selectionOf } from '../src/publish/connect.js';
import { connectLine, heldReason, missingConnections, unconnectedPlatforms } from '../src/publish/hold.js';
import { publishErrorHe, connectErrorHe } from '../src/publish/errors.js';
import { recordTakedown } from '../src/publish/takedown.js';
import { collectMetrics } from '../src/metrics/collect.js';
import { mediaOf, mediaSizes } from '../src/core/platforms.js';
import { fakeAccounts, opened, paidWorkspaces, tempHome } from './helpers.js';

// A customer's Facebook Page, through Zernio (src/publish/connect.js, src/publish/zernio.js): connected from the same
// panel as TikTok and Instagram, the Page picked on our own page (Zernio posts to a Page, never to a profile), sent
// Instagram's slides and caption at the slot, its numbers read with the rest, taken down after a notice, and optional:
// a post goes to TikTok and Instagram without a Page, and nothing asks for one while they are connected. Zernio is a
// fake under the engine's own network door, so a path the door refuses fails here as it would live.
//
// alpha posts to all three and is workspace 1's. bravo, workspace 2's, was made in the new-account flow before
// Facebook existed; carol, in no workspace, is the operator's own.

const SECRET = 'f'.repeat(48);
const realFetch = globalThis.fetch;
let home;
let ctx;
let db;
let fake;
let server;
let base;
let Z;
/** The one post built here (a render takes seconds): published without a Page first, then again with one. */
let built = null;

/** A fake Zernio: profiles, headless connect links, Facebook's Page pick, accounts, posts, unpublish, analytics. */
function fakeZernio() {
  const st = { calls: [], profiles: [], accounts: [], pages: [], posts: [], analytics: {}, n: 0 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  st.handle = (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init.headers || {});
    const p = u.pathname.replace(/^\/api\/v1/, '');
    const q = Object.fromEntries(u.searchParams);
    st.calls.push({ method, path: p, q, body, temp: headers.get('x-temp-token'), connect: headers.get('x-connect-token') });
    if (method === 'POST' && p === '/profiles') {
      const prof = { _id: `prof${++st.n}`, name: body.name, externalId: body.externalId };
      st.profiles.push(prof);
      return reply(201, { profile: prof });
    }
    if (method === 'GET' && p === '/profiles') return reply(200, { profiles: st.profiles.filter((x) => !q.externalId || x.externalId === q.externalId) });
    const cm = /^\/connect\/(tiktok|instagram|facebook)$/.exec(p);
    if (method === 'GET' && cm) return reply(200, { authUrl: `https://www.${cm[1]}.com/oauth?state=s${++st.n}` });
    if (p === '/connect/facebook/select-page') {
      if (headers.get('x-temp-token') !== 'tmp-fb') return reply(401, { error: 'bad token' });
      if (method === 'GET') return reply(200, { pages: st.pages.map((x) => ({ ...x, access_token: 'EAA-page-token' })) });
      const page = st.pages.find((x) => x.id === body.pageId);
      if (!page || !body.userProfile?.id) return reply(400, { error: 'pageId and userProfile are required' });
      const a = { _id: `fb-${page.id}`, platform: 'facebook', username: page.username || '', displayName: page.name, profileId: body.profileId, isActive: true };
      st.accounts.push(a);
      return reply(200, { message: 'Facebook page connected successfully', account: { accountId: a._id, platform: 'facebook', username: a.username, displayName: page.name, selectedPageName: page.name } });
    }
    if (method === 'GET' && p === '/accounts') return reply(200, { accounts: st.accounts.filter((a) => !q.profileId || a.profileId === q.profileId) });
    if (method === 'GET' && p === '/accounts/health') return reply(200, { accounts: [] });
    if (method === 'POST' && p === '/posts') {
      const id = `zp${++st.n}`;
      st.posts.push({ id, body });
      const pl = body.platforms[0].platform;
      return reply(201, { post: { _id: id, status: 'published', platforms: [{ platform: pl, status: 'published', platformPostId: `${pl}-${id}`, platformPostUrl: `https://www.${pl}.com/p/${id}` }] } });
    }
    const un = /^\/posts\/([\w-]+)\/unpublish$/.exec(p);
    if (method === 'POST' && un) return st.posts.some((x) => x.id === un[1]) ? reply(200, { success: true, message: 'Post deleted from facebook successfully' }) : reply(404, { error: 'no such post' });
    if (method === 'GET' && p === '/analytics') {
      const a = st.analytics[q.postId];
      return a ? reply(200, a) : reply(404, { error: 'not found' });
    }
    return reply(404, { error: `no such endpoint: ${method} ${p}` });
  };
  return st;
}

const pack = (id) => ctx.pack(id);
/** A Tuesday at noon, Israel time: not Shabbat, inside the posting windows. */
const TUE = israelInstant('2026-10-13', '12:45').getTime();
const connected = (profileId, platform, id, username) => Z.accounts.push({ _id: id, platform, profileId, username, isActive: true, needsReconnection: false });
const LOOKS = {
  bravo: (f) => {
    f.theme.template = 'poster';
    f.theme.fonts.display = 'Secular One';
    Object.assign(f.theme.colors, { bg: '#101820', surface: '#1C2733', ink: '#F4F4F4', muted: '#B8C0C8', accent: '#3FA7D6', onAccent: '#101820' });
  },
  carol: (f) => {
    f.theme.template = 'card';
    f.theme.fonts.display = 'Karantina';
    Object.assign(f.theme.colors, { bg: '#F4F1FA', surface: '#FFFFFF', ink: '#1E1530', muted: '#4E4660', accent: '#7A3FB8', accent2: '#3F7AB8', onAccent: '#FFFFFF' });
  },
};

before(async () => {
  home = tempHome({
    packs: {
      alpha: (f) => {
        delete f.pack.publisher;
        f.pack.platforms = ['tiktok', 'instagram', 'facebook'];
        f.pack.publishers = { tiktok: 'zernio', instagram: 'zernio', facebook: 'zernio' };
      },
      bravo: (f) => {
        LOOKS.bravo(f);
        delete f.pack.publisher;
        f.pack.publishers = { tiktok: 'zernio', instagram: 'zernio' };
      },
      carol: LOOKS.carol,
    },
  });
  db = new Db(path.join(home.home, 'data.db'));
  opened.push(db);
  ctx = makeContext({ db, packs: loadAll({ dir: path.join(home.home, 'packs') }), log: () => {} });
  ctx.mediaDir = path.join(home.home, 'media');
  ctx.mediaRoot = home.home;
  db.run("UPDATE accounts SET workspace_id = 1 WHERE id = 'alpha'");
  db.run("UPDATE accounts SET workspace_id = 2 WHERE id = 'bravo'");
  paidWorkspaces(db, [1, 2]);
  globalThis.fetch = async (url, init) => (new URL(String(url)).hostname === 'zernio.com' ? Z.handle(url, init) : realFetch(url, init));
  fake = await fakeAccounts();
  const s = await listen(ctx, { port: 0, env: { ...process.env, SESSION_SECRET: 'g'.repeat(40), OF_ASSISTANT_SECRET: SECRET, PUBLIC_HOST: 'teder.test', ...fake.env } });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

beforeEach(() => {
  Z = fakeZernio();
  process.env.ZERNIO_API_KEY = 'zk_test_key';
  for (const k of ['PUBLISH_MODE', 'MEDIA_PUBLIC_BASE_URL']) delete process.env[k];
  db.run('DELETE FROM zernio_connections');
  db.run("DELETE FROM settings WHERE key LIKE 'zernio:%'");
  db.run('UPDATE accounts SET zernio_profile_id = NULL');
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.ZERNIO_API_KEY;
  for (const k of ['PUBLISH_MODE', 'MEDIA_PUBLIC_BASE_URL']) delete process.env[k];
  await new Promise((r) => (server ? server.close(r) : r()));
  await fake?.close();
  await closeBrowser();
  home.cleanup();
});

test('Facebook in a pack: a platform of its own, published through Zernio alone, sent the slides rendered for Instagram', () => {
  const p = pack('alpha');
  assert.deepEqual(validatePack(p), []);
  const own = { ...p, meta: { ...p.meta, publishers: { ...p.meta.publishers, facebook: 'instagram' } } };
  assert.match(validatePack(own).join('\n'),/publishers\.facebook must be one of dry, zernio/, 'our own Meta app publishes Instagram, not a Page');
  assert.deepEqual(mediaSizes(['tiktok', 'instagram', 'facebook']), ['tiktok', 'instagram'], 'nothing is rendered twice');
  assert.deepEqual(mediaSizes(['facebook']), ['instagram']);
  assert.equal(mediaOf('facebook'), 'instagram');
});

test("a Page's post: the caption and the slides as images, published at once, a feed post with nothing of TikTok's", async () => {
  const long = 'א'.repeat(3000);
  const body = postBody({ platform: 'facebook', accountId: 'fb1', caption: long, imageUrls: ['https://m/1.png', 'https://m/2.png'], aiLabel: true });
  assert.deepEqual(body.platforms, [{ platform: 'facebook', accountId: 'fb1' }]);
  assert.deepEqual(body.mediaItems, [{ type: 'image', url: 'https://m/1.png' }, { type: 'image', url: 'https://m/2.png' }]);
  assert.equal(body.publishNow, true);
  assert.equal(body.tiktokSettings, undefined);
  assert.ok(body.content.startsWith(long), 'a Page takes a long caption whole (Instagram cuts at 2,200)');
  assert.match(body.content, /נוצרה בעזרת AI/, 'the AI line, as on Instagram');
  await assert.rejects(
    () => publishZernio({ platform: 'facebook', accountId: 'fb1', caption: 'c', imageUrls: Array.from({ length: 11 }, (_, i) => `https://m/${i}.png`) }),
    (e) => e.code === 'card_images'
  );
  assert.equal(Z.calls.length, 0, 'refused before anything is sent');
  assert.match(publishErrorHe({ code: 'card_images' }, 'facebook'), /בפייסבוק אפשר עד 10 תמונות/);
  assert.match(connectErrorHe('facebook', { error: 'no_pages', message: 'This is a personal profile, not a page' }), /עמוד שאתם מנהלים, לא לפרופיל אישי/);
});

test("Facebook's return always asks for a Page: step=select_page, its userProfile decoded and kept for Zernio", () => {
  const profile = { id: '77', name: 'נועה' };
  const wire = `?step=select_page&tempToken=tmp-fb&profileId=prof9&connect_token=ct&userProfile=${encodeURIComponent(encodeURIComponent(JSON.stringify(profile)))}`;
  assert.deepEqual(selectionOf(new URL(`https://teder.test/x${wire}`).searchParams), { step: 'select_page', profileId: 'prof9', tempToken: 'tmp-fb', connectToken: 'ct', userProfile: profile });
  assert.equal(selectionOf(new URLSearchParams('step=select_organization&tempToken=t')), null, 'no other selection is ours');
});

test('connecting a Page: the link opens headless, several Pages are offered on our own page, one is picked by itself, none says why', async () => {
  const p = pack('alpha');
  const link = new URL(connectLink(SECRET, { base, accountId: 'alpha', platform: 'facebook', t: Date.now() }));
  const go = await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.match(go.headers.get('location'), /^https:\/\/www\.facebook\.com\/oauth/);
  const ask = Z.calls.find((c) => c.path === '/connect/facebook');
  assert.equal(ask.q.headless, 'true', 'no Zernio welcome screen or picker');
  assert.equal(ask.q.loginMethod, undefined, 'Instagram alone has a login method');
  const prof = db.get("SELECT zernio_profile_id AS p FROM accounts WHERE id = 'alpha'").p;
  const back = new URL(ask.q.redirect_url);
  const user = { id: '77', name: 'נועה' };
  const ret = ({ step = 'select_page', profileId = prof } = {}) => fetch(`${base}${back.pathname}${back.search}&step=${step}&tempToken=tmp-fb&connect_token=ct&profileId=${profileId}&userProfile=${encodeURIComponent(encodeURIComponent(JSON.stringify(user)))}`, { redirect: 'manual' });

  // Not this platform's pick, not our profile, or no userProfile (Zernio requires it): refused, nothing asked of Zernio.
  const asked = Z.calls.length;
  assert.equal((await ret({ step: 'select_account' })).status, 400);
  assert.equal((await ret({ profileId: 'someone-else' })).status, 400);
  assert.equal((await fetch(`${base}${back.pathname}${back.search}&step=select_page&tempToken=tmp-fb&connect_token=ct&profileId=${prof}`, { redirect: 'manual' })).status, 400);
  assert.equal(Z.calls.length, asked);

  // No Page they can post to (Meta's CREATE_CONTENT task publishes as the Page): said, and how to get one.
  Z.pages = [{ id: 'pg0', name: 'רק קורא', tasks: ['ANALYZE'] }, { id: 'pg00', name: 'רק מנהל מודעות', tasks: ['ADVERTISE', 'MODERATE'] }];
  assert.match(await (await ret()).text(), /לא מצאנו עמוד פייסבוק[\s\S]*לא בפרופיל אישי/);

  // Several: our own picker; the tokens never reach the browser.
  Z.pages = [
    { id: 'pg1', name: 'המשתלה של נועה', username: 'noa.plants', tasks: ['MANAGE', 'CREATE_CONTENT'] },
    { id: 'pg2', name: 'עמוד שני', tasks: ['CREATE_CONTENT'] },
    { id: 'pg3', name: 'עמוד בלי הרשאה', tasks: ['MODERATE'] },
  ];
  const picker = await ret();
  assert.equal(picker.status, 200);
  const html = await picker.text();
  assert.match(html, /איזה עמוד פייסבוק לחבר\?/);
  assert.match(html, /נועה, מצאנו כמה עמודים שאתם מנהלים/);
  assert.doesNotMatch(html, /tmp-fb|EAA-page-token/, 'neither our token nor a Page token goes to the browser');
  assert.doesNotMatch(html, /עמוד בלי הרשאה/, 'a Page they cannot post to is not on offer');
  const links = [...html.matchAll(/href="(\/connect\/pick\/[0-9a-f]{32}\?page=(pg\d))"/g)];
  assert.deepEqual(links.map((m) => m[2]), ['pg1', 'pg2']);
  const picked = await fetch(`${base}${links[0][1]}`);
  assert.equal(picked.status, 200);
  assert.match(await picked.text(), /פייסבוק מחובר[\s\S]*המשתלה של נועה/);
  const select = Z.calls.find((c) => c.method === 'POST' && c.path === '/connect/facebook/select-page');
  assert.deepEqual([select.body.profileId, select.body.pageId, select.body.userProfile], [prof, 'pg1', user], 'Zernio gets the signed-in person it sent');
  assert.deepEqual([select.temp, select.connect], ['tmp-fb', 'ct'], 'the tokens in headers, never in the address');
  const list = Z.calls.find((c) => c.method === 'GET' && c.path === '/connect/facebook/select-page');
  assert.deepEqual([list.q.profileId, list.temp, list.connect], [prof, 'tmp-fb', null], 'the list gets the headers its doc names, no more');
  assert.deepEqual(connectState(db, p, 'facebook'), { platform: 'facebook', state: 'connected', username: 'noa.plants', issue: null, checkedAt: connectState(db, p, 'facebook').checkedAt });

  // One Page: connected by itself, no picker.
  Z.pages = [{ id: 'pg9', name: 'העמוד היחיד', tasks: ['MANAGE', 'CREATE_CONTENT'] }];
  assert.match(await (await ret()).text(), /פייסבוק מחובר/);
  assert.equal(db.get("SELECT zernio_account_id AS z FROM zernio_connections WHERE account_id = 'alpha' AND platform = 'facebook'").z, 'fb-pg9', 'the Page Zernio just connected is the one kept');
});

test('a Page is optional: nothing asks for it while TikTok and Instagram are connected, and a post goes to them without it', async () => {
  const p = pack('alpha');
  process.env.PUBLISH_MODE = 'live';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com';
  const prof = await ensureProfile(db, p);
  assert.deepEqual(missingConnections(db, p), ['tiktok', 'instagram'], 'nothing connected: TikTok and Instagram are asked for, not the Page');
  assert.doesNotMatch(connectLine(missingConnections(db, p)), /פייסבוק/);
  assert.doesNotMatch(heldReason(unconnectedPlatforms(db, p)), /פייסבוק/);
  assert.match(connectLine(['facebook']), /פייסבוק/, 'on an account that posts only there, it is asked for');
  connected(prof, 'tiktok', 'tk1', 'alpha.tt');
  connected(prof, 'instagram', 'ig1', 'alpha.ig');
  await refreshConnections(db, p);
  assert.deepEqual(unconnectedPlatforms(db, p), ['facebook']);
  assert.deepEqual(missingConnections(db, p), [], 'no banner, no email');

  built = await buildPost(ctx, { pack: p, formatKey: 'care-guide' });
  const id = built.postId;
  assert.equal(built.status, 'queued', built.reason);
  db.run("UPDATE posts SET status = 'approved', slot_at = ? WHERE id = ?", new Date(TUE).toISOString(), id);
  const r = await publishPost(ctx, id, { t: TUE });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const post = loadPost(db, id);
  assert.equal(post.status, 'published');
  assert.equal(post.publish.facebook.skipped, 'not_connected');
  assert.deepEqual(Z.posts.map((x) => x.body.platforms[0].platform), ['tiktok', 'instagram'], 'nothing is sent to a Page that is not there');
});

test("at the slot a Page gets Instagram's slides and caption, its numbers are read with the rest, and a takedown removes it through Zernio", async () => {
  const p = pack('alpha');
  process.env.PUBLISH_MODE = 'live';
  process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.example.com';
  const prof = await ensureProfile(db, p);
  connected(prof, 'tiktok', 'tk1', 'alpha.tt');
  connected(prof, 'instagram', 'ig1', 'alpha.ig');
  connected(prof, 'facebook', 'fb1', 'alpha.page');
  await refreshConnections(db, p);
  // The post the test before published without a Page, approved again with nothing of it sent.
  assert.ok(built?.postId, 'the post the test before built');
  const id = built.postId;
  db.run("UPDATE posts SET status = 'approved', slot_at = ?, publish_json = NULL, published_at = NULL WHERE id = ?", new Date(TUE).toISOString(), id);
  const r = await publishPost(ctx, id, { t: TUE });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const post = loadPost(db, id);
  const by = Object.fromEntries(Z.posts.map((x) => [x.body.platforms[0].platform, x]));
  const fb = by.facebook.body;
  assert.deepEqual(fb.platforms, [{ platform: 'facebook', accountId: 'fb1' }]);
  assert.equal(fb.publishNow, true);
  assert.equal(fb.tiktokSettings, undefined, 'a Page is never a draft');
  assert.equal(fb.mediaItems.length, post.media.instagram.length, "Instagram's slides");
  assert.equal(fb.mediaItems.length, by.instagram.body.mediaItems.length);
  assert.ok(fb.mediaItems.every((m, i) => m.type === 'image' && m.url.endsWith(path.basename(post.media.instagram[i]))));
  assert.equal(post.media.facebook, undefined, 'nothing was rendered for Facebook');
  assert.equal(fb.content, captionOf(db, post, 'instagram'), "Instagram's caption, the cover line first");
  if (post.caption_ig) assert.notEqual(fb.content, captionOf(db, post, 'tiktok'));
  assert.equal(post.publish.facebook.zernioId, by.facebook.id);

  // Its numbers, from Zernio's analytics for its own post.
  Z.analytics[by.facebook.id] = { platformAnalytics: [{ platform: 'facebook', analytics: { impressions: 900, reach: 700, likes: 31, comments: 4, shares: 2 } }] };
  await collectMetrics(ctx, { t: TUE + 26 * 3_600_000, only: [id] });
  const m = db.get("SELECT views, likes FROM metrics WHERE post_id = ? AND platform = 'facebook'", id);
  assert.deepEqual([m.views, m.likes], [900, 31]);

  // A takedown notice: the Page's post comes down through Zernio's unpublish; TikTok and Instagram stay for a person.
  const t = await recordTakedown(ctx, { postId: id, notice: 'the photo on slide 2 is ours, remove it' });
  assert.equal(t.deleted.facebook.state, 'deleted');
  const un = Z.calls.find((c) => c.method === 'POST' && /\/unpublish$/.test(c.path));
  assert.deepEqual([un.path, un.body.platform], [`/posts/${by.facebook.id}/unpublish`, 'facebook']);
  assert.equal(t.deleted.instagram.state, 'by_hand');
});

test('Facebook joins the accounts customers made before it, once; the operator\'s own accounts are left as they are', () => {
  const at = new Date().toISOString();
  db.insert('onboarding', { id: 'o-bravo', seed_json: { niche: 'צמחים' }, status: 'live', pack_id: 'bravo', created_at: at, updated_at: at });
  db.insert('onboarding', { id: 'o-carol', seed_json: { niche: 'צמחים' }, status: 'live', pack_id: 'carol', created_at: at, updated_at: at });
  db.run("DELETE FROM settings WHERE key LIKE 'facebook:offered:%'");
  // A workspace of ours (OF_OWN_WORKSPACES, where the company's live accounts are): its accounts are the operator's own,
  // and keep their platforms however they were made.
  process.env.OF_OWN_WORKSPACES = String(db.get("SELECT workspace_id AS ws FROM accounts WHERE id = 'bravo'").ws);
  try {
    assert.deepEqual(offerFacebook(ctx), [], 'bravo is in a workspace of ours');
  } finally {
    delete process.env.OF_OWN_WORKSPACES;
  }
  assert.deepEqual(offerFacebook(ctx), ['bravo'], 'carol is in no workspace: the operator\'s own; alpha has it already');
  const file = JSON.parse(readFileSync(path.join(pack('bravo').dir, 'pack.json'), 'utf8'));
  assert.deepEqual(file.platforms, ['tiktok', 'instagram', 'facebook']);
  assert.equal(file.publishers.facebook, 'zernio');
  assert.equal(file.publishers.tiktok, 'zernio', 'the other platforms keep their publisher');
  assert.deepEqual(pack('bravo').meta.platforms, ['tiktok', 'instagram', 'facebook'], 'the running pack too');
  assert.deepEqual(JSON.parse(readFileSync(path.join(pack('carol').dir, 'pack.json'), 'utf8')).platforms, ['tiktok', 'instagram']);
  // Taken out by hand afterwards: it stays out.
  pack('bravo').meta.platforms = ['tiktok', 'instagram'];
  assert.deepEqual(offerFacebook(ctx), []);
  assert.deepEqual(pack('bravo').meta.platforms, ['tiktok', 'instagram']);
});
