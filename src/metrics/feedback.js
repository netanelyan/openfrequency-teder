import { DAY, HOUR, now, nowIso } from '../core/clock.js';
import { audit, getSetting, setSetting } from '../core/store.js';
import { j } from '../db/index.js';
import { hookPatterns } from '../formats/kinds.js';
import { TPL, isTemplateId, templatesFor } from '../formats/hooks.js';
import { israelDate } from '../schedule/israel.js';
import { resolveFormat } from '../trends/index.js';
import { collectMetrics } from './collect.js';
import { chooseStyle } from '../render/style.js';

// The morning's feedback, once a day per account, before anything is drafted.
//
// The numbers of the last three days' posts are read fresh, and each post is
// put in one box of two by two, against the account's own earlier posts:
//
//   views         its views against the median of the account's earlier posts
//                 on the same platform, each read at the same age (a post 30
//                 hours old against the others at about 30 hours, not at 72)
//   conversions   what it led people to do, per view, against the same median:
//                 taps on the link in the bio where the platform reports them
//                 for every post compared (Instagram's media insights), and
//                 otherwise likes, comments, shares and saves. Messages are never
//                 read (hard rule 1), so a reply by DM is not counted
//
// and each box has one fixed answer, which becomes the next posts' plan:
//
//   hh  high views, high conversions    three variations of the hook: the same
//                                       story and format, three other covers
//   hl  high views, low conversions     keep the hook, change the call to
//                                       action and the caption
//   lh  low views, high conversions     keep the call to action, try a
//                                       radically different hook and first slide
//   ll  low views, low conversions      a new format or angle
//
// A cover is a format's pattern or one of the hook templates (src/formats/hooks.js,
// "tpl:<id>"): a variation of a template's winner tries its mechanism's other
// templates first, then the rest; keeping a cover keeps its template; a cover
// that did not pull is not tried again, and neither is its template's mechanism.
//
// A plan is a directive: a row the runner hands to the next free slot of the
// account (src/autonomy/runner.js), and buildPost follows (its format, hook,
// call to action, document, and a line that tells the writer why). A new
// morning's report replaces the directives no slot took yet, and a post that
// already got its answer is not answered twice. A post with too few earlier
// posts to compare with is reported, unclassified: a median of two is not one.
//
// Nothing here estimates a number: a post the platforms have not reported on
// is left out, and the report says which measure it used.

export const FEEDBACK = {
  days: 3, // the posts of the last three days
  minAgeHours: 12, // younger than this, a post has no numbers worth judging
  baselineDays: 30, // the earlier posts it is measured against
  minBaseline: 3, // fewer earlier posts than this, and it is not classified
  slackHours: 12, // an earlier post's reading counts if it was taken this close to the same age
  variations: 3,
};

export const BOXES = {
  hh: { action: 'variations', he: 'הרבה צפיות, הרבה פעולה', todo: '3 וריאציות על השער' },
  hl: { action: 'new-cta', he: 'הרבה צפיות, מעט פעולה', todo: 'אותו שער, קריאה לפעולה וכיתוב חדשים' },
  lh: { action: 'new-hooks', he: 'מעט צפיות, הרבה פעולה', todo: 'אותה קריאה לפעולה, שער ושקופית פתיחה אחרים לגמרי' },
  ll: { action: 'new-angle', he: 'מעט צפיות, מעט פעולה', todo: 'פורמט או זווית חדשים' },
};

/** The order the slots are given out in: double down on what works first. */
export const PRIORITY = ['hh', 'lh', 'hl', 'll'];

export const MEASURES = {
  link_clicks: 'לחיצות על הקישור בביו, לכל צפייה',
  engagement: 'לייקים, תגובות, שיתופים ושמירות, לכל צפייה',
};

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** What one reading says: views (or reach, where views are not reported), link clicks, and engagement. */
export function readingOf(row) {
  const eng = [row.likes, row.comments, row.shares, row.saves].filter((x) => x != null);
  return { views: row.views ?? row.reach ?? null, linkClicks: row.link_clicks ?? null, engagement: eng.length ? eng.reduce((a, b) => a + b, 0) : null, age: row.age_hours };
}

/** The reading taken nearest to an age, if one was taken within `slack` hours of it. */
export function nearest(rows, age, slack = FEEDBACK.slackHours) {
  let best = null;
  for (const r of rows) if (r.age_hours != null && Math.abs(r.age_hours - age) <= slack && (!best || Math.abs(r.age_hours - age) < Math.abs(best.age_hours - age))) best = r;
  return best;
}

const readings = (db, postId, platform) => db.all('SELECT * FROM metrics WHERE post_id = ? AND platform = ? ORDER BY age_hours, id', postId, platform);

/** One post on one platform against its baseline. Pure. Returns its box, or why it has none. */
export function classify(cur, baseline, { minBaseline = FEEDBACK.minBaseline } = {}) {
  if (!(cur.views > 0)) return null;
  const others = baseline.filter((b) => b.views > 0);
  const measure = cur.linkClicks != null && others.length && others.every((b) => b.linkClicks != null) ? 'link_clicks' : 'engagement';
  const convOf = (r) => (measure === 'link_clicks' ? r.linkClicks : r.engagement);
  const conv = convOf(cur);
  if (conv == null) return null;
  const out = { views: cur.views, age: Math.round(cur.age), conv, rate: conv / cur.views, measure, baseline: others.length };
  const rated = others.filter((b) => convOf(b) != null);
  if (rated.length < minBaseline) return { ...out, box: null, why: `${rated.length} earlier posts with numbers at this age, ${minBaseline} needed` };
  const medianViews = median(rated.map((b) => b.views));
  const medianRate = median(rated.map((b) => convOf(b) / b.views));
  const box = `${cur.views >= medianViews ? 'h' : 'l'}${out.rate >= medianRate ? 'h' : 'l'}`;
  return { ...out, medianViews, medianRate, box };
}

/** Every post of the last days of one account, in its box. */
export function classifyAccount(db, pack, { t = now(), ...opts } = {}) {
  const o = { ...FEEDBACK, ...opts };
  const until = new Date(t - o.minAgeHours * HOUR).toISOString();
  const posts = db.all("SELECT id, hook, topic, format_id, hook_pattern, published_at FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? AND published_at <= ? ORDER BY published_at", pack.id, new Date(t - o.days * DAY).toISOString(), until);
  const pool = db.all("SELECT id FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? AND published_at <= ?", pack.id, new Date(t - o.baselineDays * DAY).toISOString(), until);
  const platforms = pack.meta.platforms || ['tiktok', 'instagram'];
  return posts.map((p) => {
    const per = {};
    for (const plat of platforms) {
      const rows = readings(db, p.id, plat);
      if (!rows.length) continue;
      const cur = readingOf(rows[rows.length - 1]);
      const baseline = pool
        .filter((x) => x.id !== p.id)
        .map((x) => nearest(readings(db, x.id, plat), cur.age, o.slackHours))
        .filter(Boolean)
        .map(readingOf);
      const c = classify(cur, baseline, o);
      if (c) per[plat] = c;
    }
    // One answer a post: the first of the account's platforms that could be judged.
    const primary = platforms.find((plat) => per[plat]?.box) || null;
    return { post: p.id, hook: p.hook, topic: p.topic, format: p.format_id, publishedAt: p.published_at, platforms: per, primary, box: primary ? per[primary].box : null };
  });
}

/** The key a post's documents are filed under (as candidatesOf in the pipeline makes it), or null. */
export function docKeyOf(db, postId) {
  const d = db.get('SELECT d.id, d.key, d.group_key FROM facts f JOIN documents d ON d.id = f.document_id WHERE f.post_id = ? ORDER BY f.id LIMIT 1', postId);
  return d ? d.group_key || d.key || String(d.id) : null;
}

/** The plans one classified post asks for: one per post to make. */
export function plansFor(db, pack, entry) {
  const post = db.get('SELECT * FROM posts WHERE id = ?', entry.post);
  if (!post || !entry.box) return [];
  const data = j(post.data_json, {});
  const cta = data.cta?.text || null;
  const format = resolveFormat(db, pack, post.format_id);
  const steer = { hook: post.hook, topic: post.topic };
  switch (entry.box) {
    case 'hh': {
      const others = coverOptions(pack, format, post.hook_pattern);
      const docKey = docKeyOf(db, post.id);
      return Array.from({ length: FEEDBACK.variations }, (_, k) => ({
        formatKey: post.format_id, docKey, reuseDocs: true, hookId: others.length ? others[k % others.length].id : null,
        steer: { kind: 'variation', ...steer, n: k + 1, of: FEEDBACK.variations },
      }));
    }
    case 'hl':
      return [{ formatKey: post.format_id, hookId: post.hook_pattern || null, avoidCta: cta, steer: { kind: 'new-cta', ...steer, cta } }];
    case 'lh':
      return [{ formatKey: post.format_id, ctaText: cta, avoidHook: post.hook_pattern || null, steer: { kind: 'new-hooks', ...steer, cover: data.coverVisual?.type || null } }];
    default:
      return [{ avoidFormats: [post.format_id], steer: { kind: 'new-angle', ...steer, format: format?.name || post.format_id } }];
  }
}

/**
 * The covers a variation of a winner can take, in the order it tries them, never the winner's own: after a template,
 * the other templates of its mechanism, then the format's patterns, then the other templates; after a pattern, the
 * format's other patterns, then the templates.
 */
export function coverOptions(pack, format, won) {
  const tpls = templatesFor(pack, format);
  const mech = isTemplateId(won) ? tpls.find((t) => `${TPL}${t.id}` === won)?.mechanism : null;
  const ids = (list) => list.map((t) => `${TPL}${t.id}`);
  const patterns = hookPatterns(format).map((h) => h.id);
  const order = mech ? [...ids(tpls.filter((t) => t.mechanism === mech)), ...patterns, ...ids(tpls.filter((t) => t.mechanism !== mech))] : [...patterns, ...ids(tpls)];
  return order.filter((id) => id !== won).map((id) => ({ id }));
}

/** The report in a sentence, in Hebrew, for the summary and the audit log. */
export function reportText(posts) {
  const judged = posts.filter((p) => p.box);
  if (!posts.length) return 'אין פוסטים מהימים האחרונים עם מספרים';
  if (!judged.length) return `${posts.length} פוסטים מהימים האחרונים, ואין עוד מספיק פוסטים קודמים להשוואה`;
  const n = Object.fromEntries(PRIORITY.map((b) => [b, judged.filter((p) => p.box === b).length]));
  return PRIORITY.filter((b) => n[b]).map((b) => `${n[b]} ב"${BOXES[b].he}"`).join(', ');
}

/**
 * The morning's feedback for one account: read the last days' posts fresh,
 * classify them, store the report and the directives. `pull: false` uses the
 * numbers already stored (the demo, a test). Returns the report.
 */
export async function morningFeedback(ctx, pack, { t = now(), pull = true, read = {} } = {}) {
  const { db } = ctx;
  if (pull) {
    const ids = db.all("SELECT id FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ?", pack.id, new Date(t - FEEDBACK.days * DAY).toISOString()).map((r) => r.id);
    // Read again unless read in the last two hours: the morning's numbers, not yesterday's.
    if (ids.length) await collectMetrics(ctx, { t, only: ids, freshHours: 2, ...read }).catch((e) => ctx.log?.(`feedback metrics ${pack.id}: ${e.message}`));
  }
  // A style test whose two weeks are over is settled first: the posts from now on are drawn in its winner.
  settleStyleTest(db, pack, { t, apply: (name) => chooseStyle(db, pack, name, { test: false }) });
  const posts = classifyAccount(db, pack, { t });
  const day = israelDate(t);
  const made = [];
  db.tx(() => {
    // A new report replaces the plans no slot took yet: they were made from older numbers.
    db.run("UPDATE directives SET status = 'expired' WHERE account_id = ? AND status = 'open'", pack.id);
    for (const entry of posts.filter((p) => p.box).sort((a, b) => PRIORITY.indexOf(a.box) - PRIORITY.indexOf(b.box))) {
      const action = BOXES[entry.box].action;
      // A post is answered once: a winner found again tomorrow does not get three more variations.
      if (db.get("SELECT id FROM directives WHERE post_id = ? AND action = ? AND status = 'used'", entry.post, action)) continue;
      for (const plan of plansFor(db, pack, entry)) {
        made.push(db.insert('directives', { account_id: pack.id, day, post_id: entry.post, platform: entry.primary, box: entry.box, action, plan_json: plan, status: 'open', created_at: nowIso() }));
      }
    }
    const report = { day, at: new Date(t).toISOString(), posts, directives: made };
    db.run('INSERT OR REPLACE INTO feedback (day, account_id, report_json, text, at) VALUES (?, ?, ?, ?, ?)', day, pack.id, JSON.stringify(report), reportText(posts), nowIso());
  });
  audit(db, { action: 'feedback', accountId: pack.id, detail: { day, posts: posts.length, directives: made.length } });
  return { day, posts, directives: made };
}

/**
 * Today's slots, with the open directives of the account laid over them in
 * order: a slot a fight week already fixed keeps its own plan. A directive
 * given to a slot is used, so no other slot takes it.
 */
export function withDirectives(db, pack, plans) {
  const open = db
    .all("SELECT * FROM directives WHERE account_id = ? AND status = 'open'", pack.id)
    .sort((a, b) => PRIORITY.indexOf(a.box) - PRIORITY.indexOf(b.box) || a.id - b.id);
  let i = 0;
  return plans.map((p) => {
    if (p.formatKey || p.subject || i >= open.length) return p;
    const d = open[i++];
    db.update('directives', d.id, { status: 'used', used_at: nowIso() });
    return { ...p, directive: { id: d.id, box: d.box, ...j(d.plan_json, {}) } };
  });
}

/** The latest report of each account, with what became of its directives. For the Results page. */
export function latestFeedback(db, packs) {
  return packs.map((pack) => {
    const row = db.get('SELECT * FROM feedback WHERE account_id = ? ORDER BY day DESC LIMIT 1', pack.id);
    if (!row) return { pack, report: null, directives: [] };
    const report = j(row.report_json, { posts: [] });
    const directives = (report.directives || []).length
      ? db.all(`SELECT d.*, p.hook AS used_hook, p.status AS used_status FROM directives d LEFT JOIN posts p ON p.id = d.used_post_id WHERE d.id IN (${report.directives.map(() => '?').join(',')}) ORDER BY d.id`, ...report.directives).map((d) => ({ ...d, plan: j(d.plan_json, {}) }))
      : [];
    return { pack, day: row.day, text: row.text, report, directives };
  });
}

/* ------------------------------------------------------------------------------------------------- style test */

// A style test (src/render/style.js) drew an account's posts in two styles in turn for 14 days. The morning after it
// ends, each style's posts are read the way the boxes read a post (views, and likes, comments, shares and saves per
// view, at the reading nearest 72 hours), and the style whose posts did better on both together is locked: pack.json
// "style" names it and the test is off. With fewer than STYLE_TEST_MIN posts in either style nothing is concluded,
// the account keeps the style it had, and the result says so.

export const STYLE_TEST_MIN = 3;

/** Which of two styles did better: { winner, styles: { X: { posts, views, rate } }, why }. Pure. */
export function judgeStyles(rows, styles) {
  const by = Object.fromEntries(styles.map((s) => [s, rows.filter((r) => r.style === s)]));
  const stat = Object.fromEntries(styles.map((s) => [s, { posts: by[s].length, views: median(by[s].map((r) => r.views)), rate: median(by[s].filter((r) => r.views > 0 && r.engagement != null).map((r) => r.engagement / r.views)) }]));
  if (styles.some((s) => stat[s].posts < STYLE_TEST_MIN)) return { winner: null, styles: stat, why: `פחות מ-${STYLE_TEST_MIN} פוסטים עם מספרים באחד הסגנונות, אז אין הכרעה` };
  const top = (k) => Math.max(...styles.map((s) => stat[s][k] || 0)) || 1;
  const score = (s) => (stat[s].views || 0) / top('views') + (stat[s].rate || 0) / top('rate');
  const [a, b] = styles;
  const winner = score(a) >= score(b) ? a : b;
  return { winner, styles: stat, why: `לפוסטים בסגנון ${winner} היו יותר צפיות ויותר תגובה לכל צפייה, יחד` };
}

/**
 * Settle an account's style test once its 14 days are over: judge it, lock the winner and turn the test off.
 * Returns the result, or null when there is no test to settle. `apply(name)`: what locks a style (the caller's, so
 * this module writes no pack file itself).
 */
export function settleStyleTest(db, pack, { t = now(), apply = null } = {}) {
  const test = getSetting(db, `style-test:${pack.id}`, null);
  if (!test || test.result || Date.parse(test.until) > t) return null;
  const platforms = pack.meta.platforms || ['tiktok', 'instagram'];
  const rows = db
    .all("SELECT id, checks_json FROM posts WHERE account_id = ? AND status = 'published' AND published_at >= ? AND published_at <= ?", pack.id, test.from, test.until)
    .map((p) => {
      const style = j(p.checks_json, {})?.styleName;
      for (const plat of platforms) {
        const rs = readings(db, p.id, plat);
        if (!rs.length) continue;
        const r = readingOf(nearest(rs, 72, 48) || rs[rs.length - 1]);
        return { post: p.id, style, platform: plat, views: r.views, engagement: r.engagement };
      }
      return null;
    })
    .filter((r) => r && test.styles.includes(r.style));
  const verdict = judgeStyles(rows, test.styles);
  const result = { ...verdict, at: new Date(t).toISOString(), locked: verdict.winner || pack.meta.style?.name || null };
  if (result.locked && apply) apply(result.locked);
  setSetting(db, `style-test:${pack.id}`, { ...test, winner: verdict.winner, result });
  audit(db, { action: 'style-test', accountId: pack.id, detail: { winner: verdict.winner, locked: result.locked } });
  return result;
}
