import { DAY, HOUR, now, nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { zernioAnalytics, zernioConfigured } from '../publish/zernio.js';
import { insights as instagramInsights } from '../publish/instagram.js';
import { credit, judge, learnMix } from '../formats/rotation.js';
import { audit } from '../core/store.js';
import { PLATFORM_LIST } from '../core/platforms.js';

// What a published post did, read from the platforms, and what that teaches the
// format rotation: through Zernio's analytics for each platform the post went out
// on through Zernio (TikTok, a Facebook Page, and Instagram for an account without
// our own Meta app), and from Meta's own insights when the post went out directly
// (reach, views, saves, shares, likes, comments). A Page's numbers are kept and
// shown with the rest (Zernio: "Facebook Page analytics work for all posts", the
// same impressions, reach, likes, comments, shares, clicks, views as the others,
// docs.zernio.com/analytics/get-analytics); the format rotation scores TikTok and Instagram alone
// (src/formats/rotation.js postScore), so a Page never moves a format.
//
// RECORDS NOTHING IT DID NOT GET. A post whose numbers are not synced yet is
// left alone rather than written as zeros: a stored zero is indistinguishable
// from a post nobody saw, and the score divides by views. TikTok reports no
// saves, so TikTok's saves column stays null, never filled with something
// adjacent.
//
// Read once a day per post until 30 days, so the 72-hour reading exists and
// later ones replace nothing: each reading is its own row with its age. The
// morning's feedback (feedback.js) asks for a fresh reading of the last three
// days' posts: `only` names them, `freshHours` is how old a reading may be.

export async function collectMetrics(ctx, { t = now(), source = null, instagram = null, only = null, freshHours = 20 } = {}) {
  const { db } = ctx;
  const read = source || (zernioConfigured() ? zernioAnalytics : null);
  const readIg = instagram || ((pack, mediaId) => instagramInsights(db, pack, mediaId));
  const out = { asked: 0, got: 0, addon: null, why: read ? null : 'no Zernio key: TikTok numbers are read only through Zernio' };
  const posts = db.all("SELECT id, account_id, published_at, publish_json FROM posts WHERE status = 'published' AND published_at IS NOT NULL AND published_at >= ?", new Date(t - 30 * DAY).toISOString());
  for (const p of posts) {
    if (only && !only.includes(p.id)) continue;
    const pub = j(p.publish_json, {});
    // Each platform that went out through Zernio has its own Zernio post (a draft the owner published has TikTok's own
    // id, which Zernio's analytics take too): { platform: id }.
    const zids = Object.fromEntries(PLATFORM_LIST.filter((pl) => pub[pl]?.zernioId && !(pl === 'instagram' && pub.instagram.via === 'instagram')).map((pl) => [pl, pub[pl].zernioId]));
    const ig = pub.instagram?.via === 'instagram' && pub.instagram.mediaId ? pub.instagram.mediaId : null;
    if (!(Object.keys(zids).length && read) && !ig) continue; // a dry-published post has no numbers to read
    const last = db.get('SELECT MAX(collected_at) AS at, MAX(age_hours) AS age FROM metrics WHERE post_id = ?', p.id);
    const age = (t - Date.parse(p.published_at)) / HOUR;
    // Once a day, and always once the post crosses 72 hours, which is the reading that counts.
    const due72 = age >= 72 && !(last?.age >= 72);
    if (last?.at && t - Date.parse(last.at) < freshHours * HOUR && !due72) continue;
    out.asked++;
    const stats = {};
    // One read per Zernio post, and from it only the platform it was that platform's post on.
    for (const [platform, zid] of read ? Object.entries(zids) : []) {
      if (out.addon) break;
      try {
        const got = await read(zid);
        if (got?.[platform]) stats[platform] = got[platform];
      } catch (e) {
        // A plan without the Analytics add-on answers every post the same: said once, and the rest are not asked.
        if (e.code === 'analytics_addon_required') out.addon = out.why = e.message;
        ctx.log?.(`metrics ${p.id} ${platform}: ${e.message}`);
      }
    }
    if (ig) {
      const pack = ctx.pack?.(p.account_id) || (ctx.packs || []).find((x) => x.id === p.account_id);
      try {
        const s = pack ? await readIg(pack, ig) : null;
        if (s) stats.instagram = s; // Meta's own numbers win over Zernio's for a post Zernio did not publish
      } catch (e) {
        ctx.log?.(`instagram metrics ${p.id}: ${e.message}`);
      }
    }
    if (!Object.keys(stats).length) continue;
    for (const [platform, s] of Object.entries(stats)) {
      if (s.views == null && s.reach == null) continue;
      db.insert('metrics', { post_id: p.id, platform, collected_at: new Date(t).toISOString(), age_hours: age, views: s.views, reach: s.reach ?? null, likes: s.likes, comments: s.comments, shares: s.shares, saves: platform === 'tiktok' ? null : s.saves, link_clicks: s.linkClicks ?? null, follows: s.follows ?? null, profile_visits: s.profileVisits ?? null, raw_json: s });
      out.got++;
    }
  }
  return out;
}

/** Credit 72-hour scores to formats and judge them, per account. Returns the changes. */
export function learn(ctx, { t = now() } = {}) {
  const changes = [];
  for (const pack of ctx.packs) {
    credit(ctx.db, pack.id, { t });
    for (const c of judge(ctx.db, pack.id, { t })) {
      changes.push({ account: pack.id, ...c });
      audit(ctx.db, { action: `format_${c.change}`, accountId: pack.id, detail: c });
    }
    // The mix of entertaining and number posts follows the results, within 40% to 80%.
    const m = learnMix(ctx.db, pack, { t });
    if (m) {
      changes.push({ account: pack.id, format: 'mix', change: 'mix', why: m.why });
      audit(ctx.db, { action: 'mix_changed', accountId: pack.id, detail: m });
    }
  }
  return changes;
}

export const lastCollected = (db) => db.get('SELECT MAX(collected_at) AS at FROM metrics')?.at || null;
export { nowIso };
