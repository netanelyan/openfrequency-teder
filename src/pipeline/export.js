import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../core/paths.js';
import { j } from '../db/index.js';
import { captionOf } from '../publish/caption.js';
import { loadPost } from './build.js';

// A post written out to a folder a person can open: the slides for each
// platform, the caption as it would be published, every fact with its quote and
// its source, and the trace of how the post was made. Used by the dry run and by
// the dry publisher.

export function exportPost(db, postId, dir) {
  const post = loadPost(db, postId);
  ensureDir(dir);
  for (const [platform, files] of Object.entries(post.media || {})) {
    const sub = ensureDir(path.join(dir, platform));
    for (const f of files) copyFileSync(f, path.join(sub, path.basename(f)));
  }
  // Each caption as it goes out (src/publish/caption.js): the words, the credits, the closing slide's action, the tags.
  writeFileSync(path.join(dir, 'caption.txt'), `${captionOf(db, post, 'tiktok')}\n`);
  // Instagram's own caption: shorter, it repeats the cover line, and its action carries the link.
  if (post.caption_ig) writeFileSync(path.join(dir, 'caption-instagram.txt'), `${captionOf(db, post, 'instagram')}\n`);

  const lines = [`# ${post.hook || post.topic || post.id}`, '', `Status: ${post.status}${post.reason ? ` (${post.reason})` : ''}`, `Format: ${post.format_id}${post.kind ? ` (${post.kind})` : ''}`, ''];
  lines.push('## Sources', '');
  const items = post.slides.filter((s) => s.kind === 'item');
  items.forEach((s, i) => {
    const values = s.data?.a || s.data?.b ? ['', `${post.data?.subject?.a || 'a'}: ${s.data.a} | ${post.data?.subject?.b || 'b'}: ${s.data.b}`] : [];
    lines.push(`### Slide ${i + 1}${s.role && s.role !== 'item' ? ` (${s.role})` : ''}: ${s.title}`, '', s.body, ...values, '');
    for (const k of s.factKeys) {
      const f = post.facts.find((x) => x.key === k);
      if (!f) continue;
      lines.push(`- **${f.claim}**`, `  - quote: "${f.quote}"`, `  - source: ${f.source_name} (${f.source_status})`, `  - document: ${f.doc_url}`, `  - fetched: ${f.doc_fetched_at}`, `  - verified: ${f.verified ? 'yes' : `no, ${f.error}`}`);
    }
    lines.push('');
  });
  writeFileSync(path.join(dir, 'sources.md'), `${lines.join('\n')}\n`);

  const steps = db.all('SELECT step, status, detail_json, cost_usd, at FROM steps WHERE post_id = ? ORDER BY id', postId).map((s) => ({ ...s, detail: j(s.detail_json) }));
  const spend = db.all('SELECT api, model, usd, estimated, tag FROM spend WHERE post_id = ? ORDER BY id', postId);
  writeFileSync(
    path.join(dir, 'post.json'),
    `${JSON.stringify(
      {
        id: post.id,
        account: post.account_id,
        status: post.status,
        reason: post.reason,
        format: post.format_id,
        topic: post.topic,
        hook: post.hook,
        sub: post.sub,
        kind: post.kind,
        hookPattern: post.hook_pattern,
        caption: post.caption,
        captionInstagram: post.caption_ig,
        data: post.data,
        hashtags: post.hashtags,
        reviewScore: post.review_score,
        checks: post.checks,
        cost: { usd: Number(post.cost_usd.toFixed(5)), estimated: Boolean(post.cost_estimated), calls: spend },
        slides: post.slides.map((s) => ({ kind: s.kind, role: s.role, title: s.title, body: s.body, ...(s.data ? { data: s.data } : {}), facts: s.factKeys })),
        facts: post.facts.map((f) => ({ key: f.key, claim: f.claim, quote: f.quote, source: f.source_name, url: f.doc_url, verified: f.verified, error: f.error })),
        steps: steps.map(({ step, status, detail, cost_usd, at }) => ({ step, status, detail, cost: cost_usd, at })),
      },
      null,
      2
    )}\n`
  );
  return dir;
}
