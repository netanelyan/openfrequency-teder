import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir } from '../core/paths.js';
import { audit } from '../core/store.js';
import { loadPost } from '../pipeline/build.js';
import { chooseStyle, lockedStyle, saveStyleTest, startStyleTest, styleTest } from '../render/style.js';
import { lastPost, renderStylePreview } from '../render/styles/preview.js';
import { STYLE_NAMES, STYLES } from '../render/styles/tokens.js';
import { resolveStyle } from '../render/styles/tokens.js';
import { setPackStyle } from '../packs/write.js';
import { suggestStyle } from '../onboarding/style.js';
import { ActionError } from './actions.js';
import { csrfField, esc, icon, layout, postButton, shortDate } from './ui.js';

// The account's slide style, in Teder: its last post drawn in every style side by side, the one it is drawn in
// now, the one suggested for it and why, a button to switch, and the style test.
//
// The previews are drawn the first time the page is opened for a post (about half a minute), kept under
// data/out/styles/<account>/<post>/, and drawn again only for a newer post or a changed account colour. A post too
// long for a style is drawn anyway, and the page says which text the writer would be asked to shorten: the posts
// written for that style are written to fit it.
//
// An account with no post in this database can show a review set instead: its last post from another database,
// drawn by scripts/styles-review.js into the same folder, with review.json naming it.

const HE = Object.fromEntries(STYLE_NAMES.map((s) => [s, STYLES[s].he]));
const ABOUT = {
  A: 'כהה ונוח לנתונים: תמונה למעלה, המספר על כרטיס',
  B: 'פוסטר: כותרת ענקית, המילה החשובה על פס צבע',
  C: 'בהיר ונקי: התמונה למעלה, הטקסט על משטח בהיר',
  D: 'כהה: תמונה שנמסה לרקע, כותרת צפופה',
  E: 'כמו בטיקטוק עצמו: תמונה חדה על כל המסך, שורה או שתיים בקופסה לבנה',
  // E with pack.json style.text "shadow".
  Eshadow: 'כמו בטיקטוק עצמו: תמונה חדה על כל המסך, שורה או שתיים בלבן עם צל דק',
};

// The account's colour in a style, as a dot: an image, since the site's policy allows no inline style.
const swatch = (hex) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="${hex}"/></svg>`)}`;

const root = (accountId) => path.join(dataDir(), 'out', 'styles', accountId);
const running = new Map();

/** The post an account's previews are of: its last drawn post here, else the review set's. { post, db, from } or null. */
function sourceOf(ctx, accountId) {
  const post = lastPost(ctx.db, accountId);
  if (post) return { post, live: true };
  const pointer = path.join(root(accountId), 'review.json');
  if (!existsSync(pointer)) return null;
  const r = JSON.parse(readFileSync(pointer, 'utf8'));
  return { post: { id: r.post, hook: r.hook, created_at: r.at }, live: false, from: r.from };
}

const keyOf = (pack, post) => `${post.id}-${String(pack.theme?.colors?.accent || '').replace('#', '')}`;

/** The previews of one account: { post, live, styles: { X: { files, warnings, highlights } } }, drawn when missing. */
export async function previewsOf(ctx, pack) {
  const src = sourceOf(ctx, pack.id);
  if (!src) return null;
  const dir = path.join(root(pack.id), keyOf(pack, src.post));
  const manifest = path.join(dir, 'manifest.json');
  if (existsSync(manifest)) return { ...JSON.parse(readFileSync(manifest, 'utf8')), ...src };
  if (!src.live) return { ...src, styles: {} };
  if (!running.has(dir)) {
    running.set(
      dir,
      (async () => {
        const post = loadPost(ctx.db, src.post.id);
        const styles = {};
        for (const style of STYLE_NAMES) {
          const r = await renderStylePreview(ctx.db, { pack, post, style, outDir: dir });
          styles[style] = { files: r.files.map((f) => path.basename(f)), warnings: r.warnings, highlights: r.highlights };
        }
        ensureDir(dir);
        writeFileSync(manifest, JSON.stringify({ post: src.post.id, hook: post.hook, at: post.created_at, styles }));
      })().finally(() => running.delete(dir))
    );
  }
  await running.get(dir);
  return { ...JSON.parse(readFileSync(manifest, 'utf8')), ...src };
}

/** One preview image's file, for the image route: only a file named in the account's own manifest. */
export function previewFile(pack, postKey, style, n) {
  const dir = path.join(root(pack.id), postKey);
  const manifest = path.join(dir, 'manifest.json');
  if (!/^[\w-]+$/.test(postKey) || !STYLES[style] || !existsSync(manifest)) return null;
  const name = JSON.parse(readFileSync(manifest, 'utf8')).styles?.[style]?.files?.[Number(n)];
  const file = name ? path.join(dir, style, name) : null;
  return file && existsSync(file) ? file : null;
}

/** What a preview's warnings say, in a line: which text this style would send back to the writer. */
function warnLine(ws = []) {
  if (!ws.length) return '';
  const what = [...new Set(ws.map((w) => (w.slide === 0 ? 'השער' : `שקף ${w.slide + 1}`)))];
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} ו${what.at(-1)}` : what[0];
  return `<p class="small warnline">${icon('alert')}${esc(list)} ${what.length > 1 ? 'ארוכים' : 'ארוך'} מדי לסגנון הזה. בפוסט שייכתב בו, הכותב יקצר.</p>`;
}

function accountPanel(pc, pack, { lock, prev, suggestion, test }) {
  const current = lock.theme.style?.name || null;
  const pending = pack.meta.style?.name && pack.meta.style.name !== current ? pack.meta.style.name : null;
  const key = prev ? keyOf(pack, prev.post) : '';
  const cols = STYLE_NAMES.map((s) => {
    const st = prev?.styles?.[s];
    const accent = resolveStyle({ ...(pack.meta.style || {}), name: s }, pack.theme.colors?.accent).colors.accent;
    const imgs = st?.files?.length
      ? st.files.map((_, n) => { const src = `/styles/img/${esc(pack.id)}/${esc(key)}/${s}/${n}`; return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${esc(`סגנון ${s}, שקף ${n + 1}`)}" loading="lazy" width="180" height="320"></a>`; }).join('')
      : '<p class="muted small">אין עדיין תצוגה</p>';
    return `<article class="stylecol${s === current ? ' on' : ''}"><header><b>${s} · ${HE[s]}</b>${s === current ? '<span class="chip ok">עכשיו</span>' : s === suggestion.name ? '<span class="chip">מומלץ</span>' : ''}</header>
<p class="muted small">${esc(s === 'E' && pack.meta.style?.text === 'shadow' ? ABOUT.Eshadow : ABOUT[s])} <img class="sw" src="${swatch(accent)}" alt="" title="${esc(accent)}" width="12" height="12"></p>
<div class="stylestrip">${imgs}</div>${warnLine(st?.warnings)}
${s === current ? '' : postButton(pc, `/accounts/${pack.id}/style-pick`, `לעבור לסגנון ${s}`, { cls: 'btn sm', fields: { style: s }, confirm: `לחצו שוב כדי לעבור לסגנון ${s}` })}</article>`;
  }).join('');
  const testLine = test
    ? test.result
      ? `<p class="small">מבחן הסגנונות הסתיים ב-${esc(shortDate(test.result.at))}: ${test.result.winner ? `<b>${esc(test.result.winner)}</b> ניצח. ${esc(test.result.why)}` : esc(test.result.why)}</p>`
      : `<p class="small">מבחן סגנונות רץ עד ${esc(shortDate(test.until))}: הפוסטים יוצאים לסירוגין ב-${esc(test.styles.join(' וב-'))}, ואז נשאר הסגנון שהצליח יותר.</p>`
    : '';
  const on = Boolean(pack.meta.style?.test && test && !test.result);
  return `<section class="panel" id="acc-${esc(pack.id)}"><header><h2>${esc(pack.meta.displayName)}</h2><span class="muted small">${current ? `עכשיו בסגנון ${current} · ${HE[current]}` : 'עכשיו בעיצוב הישן'}</span></header>
${pending ? `<div class="banner info">${icon('alert')}<div><b>${pc.operator ? `ב-pack.json כתוב סגנון ${esc(pending)}` : `הוכן לחשבון סגנון ${esc(pending)}`}</b><div class="small">הוא ייכנס רק כשתעברו אליו כאן.</div></div></div>` : ''}
<p class="small">ההמלצה: <b>${esc(suggestion.name)} · ${HE[suggestion.name]}</b>. ${esc(suggestion.why.join('. '))}.</p>
${prev ? `<p class="muted small">התצוגה היא של ${prev.live ? 'הפוסט האחרון' : `הפוסט האחרון מסט ההשקה (<bdi dir="ltr">${esc(prev.from || '')}</bdi>)`}: “${esc(prev.hook || '')}”${prev.styles && Object.values(prev.styles).some((x) => x.highlights?.length) ? '. לפוסט הזה אין הדגשה משלו, אז ההדגשה בתצוגה נבחרה בקוד. בפוסטים חדשים הכותב בוחר אותה.' : ''}</p>` : '<p class="muted small">לחשבון עוד אין פוסט מרונדר להציג.</p>'}
<div class="stylegrid">${cols}</div>
${testLine}
<form method="post" action="/accounts/${esc(pack.id)}/style-test" class="row">${csrfField(pc)}<input type="hidden" name="on" value="${on ? '0' : '1'}"><span class="small">מבחן סגנונות: 14 יום לסירוגין בין שני הסגנונות שהכי מתאימים, ואז נשאר המנצח לפי צפיות ותגובה.</span><button class="btn sm" type="submit">${on ? 'לעצור את המבחן' : 'להפעיל מבחן'}</button></form>
</section>`;
}

/** The page: every account of the workspace, or the one asked for. */
export async function stylesPage(ctx, pc, { only = null } = {}) {
  const packs = ctx.packs.filter((p) => !only || p.id === only);
  const panels = [];
  for (const pack of packs) {
    const lock = lockedStyle(ctx.db, pack, (ctx.global || ctx).packs);
    const prev = await previewsOf(ctx, pack).catch((e) => ({ error: e.message }));
    const suggestion = suggestStyle({ ...pack.meta }, pack.theme.colors, ((ctx.global || ctx).packs).filter((p) => p.id !== pack.id));
    panels.push(prev?.error ? `<section class="panel"><header><h2>${esc(pack.meta.displayName)}</h2></header><p class="muted">התצוגה לא נוצרה: ${esc(prev.error)}</p></section>` : accountPanel(pc, pack, { lock, prev, suggestion, test: styleTest(ctx.db, pack) }));
  }
  const body = `<div class="head"><div><a class="muted small back" href="/accounts">${icon('chev')}חזרה לחשבונות</a><h1>סגנון השקפים</h1></div></div>
<p class="muted">לכל חשבון סגנון אחד, וכל הפוסטים שלו יוצאים בו. החלפה חלה מהפוסט הבא, ופוסטים שכבר צוירו לא משתנים.</p>
${panels.join('')}`;
  return layout({ ...pc, title: 'סגנון השקפים', active: 'accounts' }, body);
}

/** The routes: the page, a pick, the test. */
export function stylesRoutes() {
  return [
    ['GET', /^\/styles$/, (ctx, _u, _m, q, pc) => stylesPage(ctx, pc, { only: q.account || null })],
    [
      'POST',
      /^\/accounts\/([\w-]+)\/style-pick$/,
      (ctx, user, m, f) => {
        const pack = ctx.pack(m[1]);
        if (!pack) throw new ActionError('אין חשבון כזה', 404);
        if (!STYLES[f.style]) throw new ActionError('אין סגנון כזה');
        const lock = chooseStyle(ctx.db, pack, f.style);
        audit(ctx.db, { actor: user.name, action: 'style', accountId: pack.id, detail: { style: f.style, hash: lock.hash } });
        return { ok: true, message: `החשבון עבר לסגנון ${f.style}. הפוסטים הבאים ייצאו בו, ואלה שכבר צוירו לא משתנים.`, redirect: `/styles?account=${pack.id}` };
      },
    ],
    [
      'POST',
      /^\/accounts\/([\w-]+)\/style-test$/,
      (ctx, user, m, f) => {
        const pack = ctx.pack(m[1]);
        if (!pack) throw new ActionError('אין חשבון כזה', 404);
        if (f.on === '1') {
          const current = lockedStyle(ctx.db, pack, (ctx.global || ctx).packs).theme.style?.name;
          const ranked = suggestStyle({ ...pack.meta }, pack.theme.colors, ((ctx.global || ctx).packs).filter((p) => p.id !== pack.id)).ranked;
          const two = [...new Set([current || ranked[0], ...ranked])].slice(0, 2);
          if (!current) chooseStyle(ctx.db, pack, two[0]);
          setPackStyle(pack, { test: true });
          startStyleTest(ctx.db, pack, two);
          audit(ctx.db, { actor: user.name, action: 'style-test', accountId: pack.id, detail: { styles: two } });
          return { ok: true, message: `מבחן הסגנונות התחיל: ${two.join(' מול ')}, לשבועיים.`, redirect: `/styles?account=${pack.id}` };
        }
        setPackStyle(pack, { test: null });
        const t = styleTest(ctx.db, pack);
        if (t && !t.result) saveStyleTest(ctx.db, pack, { ...t, result: { at: new Date().toISOString(), winner: null, why: 'המבחן נעצר ביד', locked: lockedStyle(ctx.db, pack).theme.style?.name || null } });
        audit(ctx.db, { actor: user.name, action: 'style-test', accountId: pack.id, detail: { stopped: true } });
        return { ok: true, message: 'מבחן הסגנונות נעצר. החשבון נשאר בסגנון שלו.', redirect: `/styles?account=${pack.id}` };
      },
    ],
  ];
}
