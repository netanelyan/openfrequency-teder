// Each account's last post drawn in every slide style (cover and two content slides), for the owner to choose
// from on Teder's styles page (/styles). Nothing is switched: the page has the buttons.
//
//   node scripts/styles-review.js                         every account's last post in this home's database
//   node scripts/styles-review.js football=path/to.db     an account's last post from another database (a launch set)
//
// The previews go where the styles page keeps them (data/out/styles/<account>/), with review.json naming the post,
// so the page shows them for an account with no post in this database. An account with a post here needs nothing:
// the page draws its own on first open.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db/index.js';
import { dataDir, ensureDir } from '../src/core/paths.js';
import { loadAll } from '../src/packs/load.js';
import { loadPost } from '../src/pipeline/build.js';
import { lastPost, renderStylePreview } from '../src/render/styles/preview.js';
import { STYLE_NAMES } from '../src/render/styles/tokens.js';
import { closeBrowser } from '../src/render/render.js';

const from = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).filter((x) => x.length === 2));
const home = openDb();
const packs = loadAll();
for (const pack of packs) {
  const file = from[pack.id];
  if (file && !existsSync(file)) {
    console.log(`${pack.id}: no database at ${file}`);
    continue;
  }
  const db = file ? openDb(file) : home;
  const post = file ? (() => {
    const row = db.get("SELECT id FROM posts WHERE account_id = ? AND media_json IS NOT NULL AND kind IS NOT NULL AND status IN ('published','approved','queued','sample') ORDER BY created_at DESC LIMIT 1", pack.id);
    return row ? loadPost(db, row.id) : null;
  })() : lastPost(db, pack.id);
  if (!post) {
    console.log(`${pack.id}: no drawn post`);
    continue;
  }
  const key = `${post.id}-${String(pack.theme?.colors?.accent || '').replace('#', '')}`;
  const dir = path.join(dataDir(), 'out', 'styles', pack.id, key);
  const styles = {};
  console.log(`${pack.id}: ${post.hook}`);
  for (const style of STYLE_NAMES) {
    const r = await renderStylePreview(db, { pack, post, style, outDir: dir });
    styles[style] = { files: r.files.map((f) => path.basename(f)), warnings: r.warnings, highlights: r.highlights };
    console.log(`  ${style}: slides ${r.slides.map((i) => i + 1).join(', ')}${r.warnings.length ? ` · ${r.warnings.length} too long for the style` : ''}`);
  }
  ensureDir(dir);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ post: post.id, hook: post.hook, at: post.created_at, styles }));
  if (file) writeFileSync(path.join(dataDir(), 'out', 'styles', pack.id, 'review.json'), JSON.stringify({ post: post.id, hook: post.hook, at: post.created_at, from: path.basename(path.dirname(file)) === 'data' ? file : path.relative(process.cwd(), file) }));
}
await closeBrowser();
