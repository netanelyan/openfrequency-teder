import { a11yLink, accDot, csrfField, dayHe, esc, icon, k, layout, MODE_HE, postButton, reasonHe, shortDate, stamp, statusChip, tederMark, timeHe, usd, weekdayNarrow, withSupport } from './ui.js';
import { PAUSE_REASONS } from '../autonomy/rails.js';
import { STUCK_REASON } from '../publish/errors.js';
import { FLOW_HE, draftNote, flowState } from '../publish/draft.js';
import { CATALOG } from '../sources/catalog.js';
import { KINDS, MIX } from '../formats/kinds.js';
import { BOXES, MEASURES, PRIORITY } from '../metrics/feedback.js';
import { RIVALS } from '../pipeline/rivals.js';
import { readFileSync } from 'node:fs';
import { PARTS as TOPIC_PARTS, PASS as PASS_TOPIC } from '../topics/index.js';
import { DEFAULT_PLAN, MAX_PLAN, PLAN_HE, REDO_REASONS, REJECT_REASON_HE } from '../budget/quota.js';
import { connectPanel, tiktokModePanel } from './connect.js';
import { schedulePanel } from './schedule.js';
import { connectLine } from '../publish/hold.js';
import { PLATFORM_LIST } from '../core/platforms.js';
import { EMAIL_HE } from '../notify/email.js';
import { libraryFormat } from '../formats/library.js';
import { formatsPanel, picksFormats } from './formats.js';

const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const KIND_HE = Object.fromEntries(Object.entries(KINDS).map(([k2, v]) => [k2, v.name]));

// Every page, as a function from data to HTML.
//
// The words on the pages are Hebrew; what came from a source (an English quote,
// a URL) keeps its own direction inside an isolated run.

/**
 * The rejection form: a reason (each one steers the replacement, src/pipeline/redo.js) and the customer's own words.
 * `left` is the month's redos left, when the page knows it.
 */
function rejectForm(ctx, post, { ajax = null, left = null } = {}) {
  const tail = left == null ? '' : left > 0 ? `<p class="muted small m0">פוסט חלופי ייכתב לפי הסיבה. ${left === 1 ? 'נשארה החלפה אחת' : `נשארו ${left} החלפות`} החודש.</p>` : '<p class="muted small m0">ההחלפות של החודש נוצלו, אז דחייה רק מורידה את הפוסט.</p>';
  return `<form class="rejectbox" id="reject-${esc(post.id)}" method="post" action="/post/${esc(post.id)}/reject"${ajax ? ` data-ajax="${ajax}"` : ''}>${csrfField(ctx)}
<label class="f">למה לדחות?<select name="reason">${REDO_REASONS.map((r) => `<option value="${r}">${esc(REJECT_REASON_HE[r])}</option>`).join('')}</select></label>
<input type="text" name="note" placeholder="מה לשנות, במילים שלכם (לא חובה)" maxlength="300">
${tail}<button class="btn danger" type="submit">לדחות את הפוסט</button></form>`;
}

/** What a post counted as in the customer's month (src/budget/quota.js). */
const QUOTA_KIND_HE = { suggestion: 'הצעה', redo: 'החלפה', retry: 'לא נספר, הבדיקות שלנו עצרו אותו' };

const PROVIDER_HE = { pexels: 'Pexels', unsplash: 'Unsplash', commons: 'ויקישיתוף', openverse: 'Openverse', pack: 'מהחשבון', rendered: 'מצויר' };

/** Light edits on a post's page: another of its own photographs on a slide, or a slide removed. Drawn again only. */
function lightPanel(ctx, d) {
  const { post } = d;
  const items = post.slides.filter((s) => s.kind === 'item').length;
  const rows = post.slides
    .map((s, i) => {
      const name = s.kind === 'cover' ? 'שער' : s.kind === 'closer' ? 'שקף סיום' : `שקף ${i}`;
      const photo = d.photos.length
        ? `<form method="post" action="/post/${esc(post.id)}/slide/${i}/photo" class="inline">${csrfField(ctx)}<label class="f">תמונה<select name="image"><option value="none"${s.image_id ? '' : ' selected'}>בלי תמונה</option>${d.photos.map((img) => `<option value="${img.id}"${img.id === s.image_id ? ' selected' : ''}>${esc(String(img.alt || img.query || `תמונה ${img.id}`).slice(0, 60))} · ${esc(PROVIDER_HE[img.provider] || img.provider)}</option>`).join('')}</select></label><button class="btn sm" type="submit">להחליף</button></form>`
        : '';
      const remove = s.kind === 'item' && items > 1 ? postButton(ctx, `/post/${post.id}/slide/${i}/remove`, 'להוריד את השקף', { cls: 'btn sm ghost', confirm: 'לחצו שוב כדי להוריד את השקף' }) : '';
      if (!photo && !remove) return '';
      return `<li><img src="${media(post, 'tiktok', i)}" alt="" width="72" height="128" loading="lazy"><div><b>${esc(name)}</b>${s.title ? ` <span class="muted small">${esc(String(s.title).replace(/\n/g, ' ').slice(0, 60))}</span>` : ''}<div class="actions p0">${photo}${remove}</div></div></li>`;
    })
    .join('');
  if (!rows) return '';
  return `<section class="panel" id="light"><header><h2>שינויים קטנים</h2></header>
<p class="muted small">מחליפים תמונה באחת שכבר נמצאה לפוסט הזה, או מורידים שקף, והשקפים מצוירים מחדש. זה לא נספר כהחלפה. את הטקסט עורכים בטופס שמתחת.</p>
<ol class="lightlist">${rows}</ol></section>`;
}

/** Where a redo stands, on the rejected post and on the one that replaced it. */
function redoBanners(d) {
  const { post } = d;
  const out = [];
  if (d.redoOf) out.push(`<div class="banner info">${icon('edit')}<div><b>פוסט חלופי</b><p>נכתב במקום <a href="/post/${esc(d.redoOf.id)}">${esc(d.redoOf.hook || 'פוסט שנדחה')}</a>.${d.redoOf.reason ? ` סיבת הדחייה: ${esc(d.redoOf.reason)}.` : ''}</p></div></div>`);
  const r = post.status === 'rejected' ? post.reject : null;
  if (r?.redo === 'writing') out.push(`<div class="banner info">${icon('clock')}<div><b>פוסט חלופי נכתב עכשיו</b><p>הוא יגיע לאישור בעוד כמה דקות.</p></div></div>`);
  if (r?.redo === 'queued' && d.replacement) out.push(`<div class="banner info">${icon('check')}<div><b>נכתב פוסט חלופי</b><p><a href="/post/${esc(d.replacement.id)}">${esc(d.replacement.hook || 'לפוסט החלופי')}</a></p></div></div>`);
  if (r?.redo === 'failed') out.push(`<div class="banner warn">${icon('alert')}<div><b>הפוסט החלופי לא נכתב</b><p>הבדיקות שלנו עצרו את מה שנכתב במקומו, ולכן ההחלפה לא ירדה מהמכסה.</p></div></div>`);
  if (r?.redo === 'none') out.push(`<div class="banner info">${icon('alert')}<div><b>לא נכתב פוסט חלופי</b><p>ההחלפות של החודש נוצלו כשהפוסט נדחה.</p></div></div>`);
  return out.join('');
}
const STEP_HE = {
  format: 'פורמט', viral: 'נושא שנבחר קודם', topic: 'מסמכים מהמקורות', outline: 'מתווה ועובדות', facts: 'אימות עובדות', slides: 'כתיבת שקפים', redraft: 'כתיבה מחדש', rewrite: 'שכתוב מה שנשמע כמו בוט', review: 'בדיקת "נשמע כמו בוט"', verify: 'שער העובדות',
  image: 'תמונה', render: 'רינדור', queue: 'לתור', publish: 'פרסום', blocked: 'נחסם', error: 'שגיאה', edit: 'עריכה', subject: 'נושא השבוע', takedown: 'הודעת הסרה',
  whatsapp: 'מוואטסאפ',
};
/** What a customer did through the WhatsApp assistant, in the post's trace. */
const WHATSAPP_HE = { approve: 'אישור', reject: 'דחייה', edit: 'עריכה' };
/** The assistant's messages, as the Settings page lists them (src/assistant/data.js EVENT_TYPES). */
const EVENT_HE = {
  'post.ready': 'פוסט חדש מחכה לאישור',
  'post.reminder': 'הגיעה השעה לפרסם פוסט',
  'post.published': 'פוסט עלה',
  'post.unposted': 'עברה שעה והפוסט עוד לא עלה',
  'quota.low': 'נשארו 8 הצעות החודש',
  'weekly.summary': 'סיכום השבוע, ביום ראשון ב-9:00',
  'account.reconnect': 'טיקטוק או אינסטגרם צריכים חיבור מחדש',
};
// The checks on the Results page's block rates, by the names src/pipeline/build.js checkOf gives them.
const CHECK_HE = {
  facts: 'שער העובדות: מספר שלא בציטוט', shape: 'צורת הפורמט', visuals: 'גרפיקות', details: 'פרטים מהמחקר', caption: 'כיתוב (אורך, חסר)', keywords: 'מילות מפתח', length: 'אורך כותרת או שקף', overlay: 'טקסט על התמונה',
  'voice:banned': 'קול: מילה אסורה', 'voice:phrase': 'קול: ביטוי של בוט', 'voice:register': 'קול: משלב', 'voice:structure': 'קול: מבנה', 'voice:length': 'קול: אורך ומשפטים', 'voice:language': 'קול: שפה', 'voice:url': 'קול: קישור', 'voice:artefact': 'קול: שארית של מודל', 'voice:empty': 'טקסט ריק',
  'kind:no_source': 'אין מסמך שמחזיק פוסט', 'kind:no_photo': 'אין תמונה מורשית לשקף', 'kind:fact_check': 'עובדות שלא אומתו (בתכנון)', 'kind:voice': 'נשמע כמו בוט (ציון הבודק)', 'kind:review': 'הבודק: יותר מהעובדות', 'kind:budget': 'תקציב', 'kind:shape': 'צורת הפורמט', 'kind:rules': 'חוק או כלל של החשבון',
};
const checkHe = (c) => CHECK_HE[c] || (/^compliance:/.test(c) ? `חוק: ${c.slice(11)}` : /^rule:/.test(c) ? `כלל של החשבון: ${c.slice(5)}` : /^honesty:/.test(c) ? `כנות: ${c.slice(8)}` : c);

/** Which checks stop posts: the top ten, blocked and failed first, as shares of the posts drafted. */
export function blocksPanel(b) {
  if (!b?.total) return '';
  const pct = (n) => `${Math.round((n / b.total) * 100)}%`;
  const rows = b.rows.filter((r) => r.blocked || r.firstFail).slice(0, 10);
  return `<section class="panel" id="blocks"><header><h2>מה חוסם פוסטים</h2><span class="end muted small">${b.blocked} מתוך ${b.total} פוסטים נחסמו (${pct(b.blocked)}) ב-30 הימים האחרונים</span></header>
${rows.length ? `<table class="table stack"><thead><tr><th>בדיקה</th><th>חסמה</th><th>מהפוסטים</th><th>נכשלה בטיוטה הראשונה</th></tr></thead><tbody>${rows.map((r) => `<tr><td data-k="">${esc(checkHe(r.check))}</td><td class="n" data-k="חסמה">${r.blocked}</td><td class="n" data-k="מהפוסטים">${pct(r.blocked)}</td><td class="n" data-k="טיוטה ראשונה">${r.firstFail ? `${r.firstFail} (${pct(r.firstFail)})` : '–'}</td></tr>`).join('')}</tbody></table>
<p class="muted small">פוסט שנחסם בכמה בדיקות נספר בכל אחת. "נכשלה בטיוטה הראשונה": לפני התיקון והכתיבה מחדש, שמצילים חלק מהם.</p>` : '<p class="muted">אף פוסט לא נחסם.</p>'}</section>`;
}

const ROLE_NAME = {
  beat: 'בנייה', payoff: 'הסוף', then: 'אז', turn: 'התפנית', now: 'היום', context: 'רקע', moment: 'הרגע', after: 'אחרי', clue: 'רמז', reveal: 'התשובה',
  stat: 'נתון', verdict: 'השורה התחתונה', ranks: 'מקומות 10 עד 6', rank: 'מקום', layer: 'שכבה', case: 'נימוק', ask: 'השאלה', myth: 'מיתוס', fact: 'עובדה', joke: 'בדיחה', truth: 'בלי צחוק',
};
const PLATFORM_DELETE = { deleted: 'נמחק אוטומטית', deleted_by_hand: 'נמחק ידנית', by_hand: 'צריך למחוק ידנית', not_published: 'לא פורסם שם', failed: 'נכשל' };
const PLATFORM_HE = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
const AUDIT_HE = {
  login: 'כניסה', approve: 'אישור פוסט', unapprove: 'ביטול אישור', reject: 'דחיית פוסט', edit: 'עריכה', publish_now: 'פרסום ידני', published: 'פורסם', publish_failed: 'פרסום נכשל',
  auto_approved: 'אושר אוטומטית', dev_mode: 'מצב מפתח נפתח', topic_added: 'נושא נוסף לבנק', topic_removed: 'נושא הוסר', watch_saved: 'רשימת מעקב נשמרה', mode: 'שינוי מצב', pause: 'השהיה', resume: 'חידוש', global_kill_on: 'כיבוי כללי', global_kill_off: 'הפעלה מחדש', global_budget: 'תקציב כללי',
  takedown: 'הודעת הסרה', takedown_deleted: 'נמחק ידנית אחרי הודעה', image_ok: 'תמונה נבדקה בעין', mix_changed: 'יחס בידור ומספרים זז',
  generate_at: 'שעת ייצור', assistant_prefs: 'הגדרות וואטסאפ', source_approved: 'מקור אושר', source_removed: 'מקור הוסר', source_added: 'מקור נוסף', user_added: 'משתמש נוסף',
  publish_retry: 'פרסום יחזור על עצמו', fact_added: 'עובדה נוספה', fact_confirmed: 'עובדה נבדקה שוב', fact_removed: 'עובדה הוסרה', rival_added: 'מתחרה נוסף', rival_updated: 'מתחרה עודכן', rival_removed: 'מתחרה הוסר', format_dropped: 'פורמט נשר', format_promoted: 'פורמט הוכח', format_returned: 'פורמט חזר', onboarding: 'חשבון חדש', went_live: 'חשבון עלה לאוויר',
};

const media = (post, platform, i) => `/media/${encodeURIComponent(post.id)}/${platform}/${i}?v=${encodeURIComponent(String(post.updated_at || '').replace(/D/g, '').slice(-10))}`;
const formatName = (pack, id) => pack?.formats.formats.find((f) => f.id === id)?.name || id;

// What kind of slideshow a post is, in the words a business owner uses. A format's own name is the pack's ("איך זה
// עובד", "המאמן"), which reads like a heading on a card, so customers see this instead: by the format's id first (the
// first accounts' starter formats, and the demo's; the library's go by their kind), then by its kind (src/formats/kinds.js).
// Anything else shows nothing.
const TYPE_BY_FORMAT = {
  explainer: 'הסבר בכמה שלבים',
  'n-facts': 'כמה עובדות קצרות',
  'quick-facts': 'כמה עובדות קצרות',
  'whats-new': 'מה השתנה לאחרונה',
  'care-guide': 'מדריך טיפול',
  mistakes: 'טעויות נפוצות',
};
const TYPE_BY_KIND = {
  story: 'סיפור אמיתי',
  'what-happened': 'מה קרה למישהו מוכר',
  'on-this-day': 'מה קרה בתאריך הזה',
  'guess-who': 'חידה, נחשו מי',
  'head-to-head': 'השוואה בין שניים',
  ranking: 'דירוג',
  iceberg: 'מהמוכר אל הפחות מוכר',
  'hot-take': 'דעה, עם עובדות',
  'myth-fact': 'מיתוס מול עובדה',
  meme: 'הומור מהתחום',
  'do-dont': 'מה עושים ומה לא',
  facts: 'עובדות שלא ידעתם',
  tips: 'טיפים לשמור',
  'owner-story': 'הסיפור של העסק',
  list: 'רשימה',
};
// A format the customer picked is called on its card what it was called when they picked it (src/formats/library.js).
export const typeHe = (post) => TYPE_BY_FORMAT[post.format_id] || libraryFormat(post.format_id)?.name || TYPE_BY_KIND[post.kind] || '';
/** The kind on a card: the pack's format name for the operator, the plain words (or nothing) for a customer. */
const typeLabel = (ctx, pack, post) => (ctx.operator ? formatName(pack, post.format_id) : typeHe(post) ? `סוג: ${typeHe(post)}` : '');

/** A post still being written: no slides yet, nothing to read, edit or approve. One stopped by the checks is not. */
export const building = (post) => post.status === 'drafting' || (!post.slides?.length && !['blocked', 'failed', 'rejected', 'expired', 'taken_down', 'published'].includes(post.status));

/** The statuses whose text can still be changed (the rule src/web/actions.js edit() enforces). */
export const EDITABLE = ['queued', 'approved', 'sample'];

/** A time, with its date when it is not today's. */
const atHe = (t) => (dayHe(t) === dayHe(Date.now()) ? timeHe(t) : `${shortDate(t)}, ${timeHe(t)}`);

/**
 * When the post goes up, in a line that says so: "תעלה ב-12:30" on a slot, the next free hour without one, when it
 * went up once it did. A sample never goes up, and a post that was stopped or turned down has no time: both show nothing.
 */
export function whenHe(post) {
  if (post.status === 'published' && post.published_at) return `עלתה ב-${atHe(post.published_at)}`;
  if (post.sample || !['queued', 'approved', 'held', 'publishing'].includes(post.status)) return '';
  if (post.slot_at) return `תעלה ב-${atHe(post.slot_at)}`;
  return post.status === 'queued' ? 'תעלה בשעה הפנויה הבאה אחרי שתאשרו' : 'תעלה בשעה הפנויה הבאה';
}

/** The card of a post still being written: a blank slide and one line. The page shows the real card once it is ready. */
const buildingCard = (post) => `<article class="card acc acc-${esc(post.account_id)} post building" id="post-${esc(post.id)}" data-post>
<div class="pending"><span class="ph" aria-hidden="true"></span><div><h3 class="hook">מצגת חדשה בכתיבה</h3><p class="subline">תהיה מוכנה בעוד כמה דקות</p></div></div>
</article>`;

/**
 * TikTok's own furniture drawn over a slide (the post page's "TikTok view"): the tabs on top, the button rail (on the
 * left, as TikTok mirrors it in Hebrew), the slide dots, the account and the caption, the bar at the bottom, and the
 * bands the styles keep clear dashed (src/rules/overlay.js SAFE_ZONES), so a line that runs under them shows.
 */
const tiktokMock = (handle, caption) => `<span class="tt" aria-hidden="true"><span class="tt-safe"></span><span class="tt-tabs"><i>עוקבים</i><b>בשבילך</b></span><span class="tt-col"><i class="av"></i><i></i><i></i><i></i><i></i><i class="disc"></i></span><span class="tt-dots"><i class="on"></i><i></i><i></i><i></i></span><span class="tt-cap"><b>${esc(handle ? `@${handle}` : '')}</b><span>${esc(String(caption || '').split('\n')[0].slice(0, 90))}</span></span><span class="tt-bar"></span></span>`;

function strip(post, platform = 'tiktok', { mock = null } = {}) {
  const files = post.media?.[platform] || [];
  if (!files.length) return '';
  const items = post.slides.filter((s) => s.kind === 'item');
  return `<div class="strip${platform === 'instagram' ? ' ig' : ''}" data-strip>${files
    .map((_, i) => {
      const s = post.slides[i];
      const n = s?.kind === 'item' ? items.indexOf(s) + 1 : null;
      const target = n ? `#s-${post.id}-${n}` : '#';
      return `<a href="${target}" aria-label="שקף ${i + 1}${n ? `, העובדות שלו` : ''}">${mock || ''}<img src="${media(post, platform, i)}" alt="${esc(s?.kind === 'cover' ? post.hook : s?.title || '')}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async" width="270" height="${platform === 'tiktok' ? 480 : 338}"><span class="n">${i + 1}/${files.length}</span>${n && s.factKeys.length ? `<span class="has">${s.factKeys.length === 1 ? 'מקור אחד' : `${s.factKeys.length} מקורות`}</span>` : ''}</a>`;
    })
    .join('')}</div><div class="dots" aria-hidden="true">${files.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>`;
}

/** How many facts the post's slides stand on, each with its source. */
const factCount = (post) => {
  const items = post.slides.filter((s) => s.kind === 'item');
  return post.facts.filter((f) => items.some((s) => s.factKeys.includes(f.key))).length;
};

/** Where the facts come from, slide by slide. A customer sees it only when there is a fact to show. */
function factsBlock(ctx, post, { open = false } = {}) {
  const items = post.slides.filter((s) => s.kind === 'item');
  const n = factCount(post);
  if (!n && !ctx.operator) return '';
  return `<details class="facts"${open ? ' open' : ''}><summary>${icon('shield')}מאיפה העובדות (${n})<span class="chev">${icon('chev')}</span></summary>
<ol class="factlist">${items
    .map((s, i) => {
      const facts = s.factKeys.map((key) => post.facts.find((f) => f.key === key)).filter(Boolean);
      return `<li id="s-${post.id}-${i + 1}"><div class="slide-n">שקף ${i + 1}${ROLE_NAME[s.role] ? ` (${ROLE_NAME[s.role]})` : ''}: ${esc(s.title)}${s.data?.a || s.data?.b ? ` <span class="muted num">${esc(s.data.a)} · ${esc(s.data.b)}</span>` : ''}</div>${facts.length ? '' : '<div class="muted small">אין בו עובדה משלו (דעה, מיתוס או בדיחה), וכל מספר בו מצוטט</div>'}${facts
        .map(
          (f) => `<details class="fact"><summary>${f.verified ? `<span class="ok">${icon('check')}</span>` : `<span class="no">${icon('x')}</span>`}<span>${esc(f.claim)}</span></summary>
<div class="src"><blockquote class="q" dir="auto">${esc(f.quote)}</blockquote>
<div class="where"><a href="${esc(f.doc_url)}" target="_blank" rel="noopener noreferrer">${esc(f.source_name)} ${icon('ext')}</a><span class="muted">נשמר ${esc(stamp(f.doc_fetched_at))}</span>${f.source_status === 'approved' ? '<span class="chip ok">מקור מאושר</span>' : `<span class="chip bad">מקור ${esc(f.source_status)}</span>`}</div>
${f.error ? `<div class="muted">${esc(f.error)}</div>` : ''}</div></details>`
        )
        .join('')}</li>`;
    })
    .join('')}</ol></details>`;
}

function captionBlock(post) {
  const tags = `<span class="tags">${esc((post.hashtags || []).join(' '))}</span>`;
  // TikTok's caption is a story, one beat a line (src/rules/caption.js).
  const tiktok = esc(post.caption).replace(/\n+/g, '<br>');
  if (!post.caption_ig) return `<p class="caption">${tiktok} ${tags}</p>`;
  return `<p class="caption"><span class="chip ghost">טיקטוק</span> ${tiktok} ${tags}</p><p class="caption"><span class="chip ghost">אינסטגרם</span> ${esc(post.caption_ig).replace(/\n/g, '<br>')}</p>`;
}

/** What the checks found, in one quiet line: the facts and their sources, the bot score, an AI image. */
function trustLine(post) {
  const items = post.slides.filter((s) => s.kind === 'item');
  const used = post.facts.filter((f) => items.some((s) => s.factKeys.includes(f.key)));
  const unverified = used.filter((f) => !f.verified).length;
  const bits = [];
  if (used.length) bits.push(unverified ? `<span class="badc">${icon('x')}${unverified} עובדות לא אומתו</span>` : `<span class="good">${icon('shield')}${used.length === 1 ? 'עובדה אחת, עם מקור' : `${used.length} עובדות, כל אחת עם מקור`}</span>`);
  if (post.review_score != null) bits.push(`<span class="${post.review_score >= 4 ? 'warnc' : ''}" title="ציון של בודק ${post.checks?.reviewer === 'claude' ? 'Claude' : 'אופליין'}: 0 אדם, 10 בוט">${icon('spark')}נשמע כמו בוט <span class="num ltr">${post.review_score}/10</span></span>`);
  if (post.ai_label) bits.push(`<span class="warnc">${icon('alert')}תמונת AI: באינסטגרם נוסיף שורה שאומרת את זה, ובטיקטוק מסמנים אותה באפליקציה לפני הפרסום</span>`);
  return bits.length ? `<div class="trust">${bits.join('')}</div>` : '';
}

/** The captions, folded: they go out with the post, so they are one tap away, not in the way of the decision. */
function captionDetails(post) {
  if (!post.caption && !post.caption_ig) return '';
  return `<details class="facts"><summary>${icon('text')}הטקסט שעולה עם המצגת<span class="chev">${icon('chev')}</span></summary>${captionBlock(post)}</details>`;
}

/** A customer's card of a post the checks stopped before it had slides: what it was, and that it stopped. */
const stoppedCard = (post) => `<article class="card acc acc-${esc(post.account_id)} post" id="post-${esc(post.id)}" data-post>
<div class="meta"><span class="end">${statusChip(post.status)}</span></div>
<h3 class="hook">${esc(post.hook || post.topic || 'מצגת שלא הושלמה')}</h3>
<p class="subline">הבדיקות שלנו עצרו אותה באמצע הכתיבה, ולכן אין בה שקפים.</p>
</article>`;

/** One post as a card, decision first: when and what, the headline, the slides, what the checks found, the buttons. */
export function postCard(ctx, post, pack) {
  // A customer sees a post still being written as one line, and the real card once the page reloads with it ready.
  if (!ctx.operator && building(post)) return buildingCard(post);
  if (!ctx.operator && !post.slides?.length) return stoppedCard(post);
  const when = whenHe(post);
  const kind = typeLabel(ctx, pack, post);
  const decide = post.status === 'queued';
  return `<article class="card acc acc-${esc(post.account_id)} post" id="post-${esc(post.id)}" data-post>
<div class="meta">${when ? `<span class="when num">${esc(when)}</span>` : ''}${kind ? `<span class="fmt">${esc(kind)}</span>` : ''}<span class="end">${statusChip(post.status)}</span></div>
<h3 class="hook">${esc(post.hook)}</h3>
${post.sub ? `<p class="subline">${esc(post.sub)}</p>` : ''}
${strip(post)}
${trustLine(post)}
<div class="actions">
${decide ? postButton(ctx, `/post/${post.id}/approve`, `${icon('check')}אישור`, { cls: 'btn primary', ajax: 'remove' }) : ''}
${EDITABLE.includes(post.status) ? `<a class="btn" href="/post/${esc(post.id)}#edit">${icon('edit')}לערוך</a>` : ''}
${decide ? `<button class="btn ghost" type="button" data-toggle="#reject-${esc(post.id)}" aria-expanded="false">${icon('x')}דחייה</button>` : ''}
${post.status === 'approved' ? postButton(ctx, `/post/${post.id}/unapprove`, 'ביטול אישור', { cls: 'btn ghost', ajax: 'reload' }) : ''}
</div>
${decide ? rejectForm(ctx, post, { ajax: 'remove' }) : ''}
${captionDetails(post)}
${factsBlock(ctx, post)}
</article>`;
}

/* ------------------------------------------------------------ Today */

// Home is the overview, like a shop's: four numbers, what needs you, one line per account. The posts themselves,
// slides, captions and facts, are on Posts: the owner asked for a home page that is not a whole book.

/** The banners that stop the engine: the kill switch, a paused account, an account whose month's suggestions are used up. */
function stopBanners(ctx, d) {
  const out = [];
  if (ctx.globalKill) out.push(`<div class="banner bad">${icon('power')}<div><b>מתג הכיבוי הכללי מופעל.</b><p>אף חשבון לא כותב פוסטים ולא מפרסם עד שמפעילים מחדש.</p></div>${ctx.operator ? postButton(ctx, '/settings/kill', 'הפעלה מחדש', { cls: 'btn sm', fields: { on: '0' } }) : ''}</div>`);
  for (const g of d.groups) {
    if (g.acc?.status === 'paused') out.push(`<div class="banner warn">${icon('alert')}<div><b>${esc(g.pack.meta.displayName)} מושהה (${esc(PAUSE_REASONS[g.acc.paused_reason] || g.acc.paused_reason)})</b>${g.acc.paused_detail ? `<p>${withSupport(g.acc.paused_detail)}</p>` : ''}</div><a class="btn sm" href="/accounts?account=${esc(g.pack.id)}#acc-${esc(g.pack.id)}">לחשבון</a></div>`);
    else if (g.quota && g.quota.suggested.used >= g.quota.suggested.limit) out.push(g.quota.shared
      ? `<div class="banner info">${icon('alert')}<div><b>נוצלו כל ${g.quota.suggested.limit} ההצעות של החודש, לכל החשבונות שלכם יחד.</b><p>פוסטים חדשים ייכתבו מתחילת החודש הבא.</p></div></div>`
      : `<div class="banner info">${icon('alert')}<div><b>${esc(g.pack.meta.displayName)} ניצל את ${g.quota.suggested.limit} ההצעות של החודש.</b><p>פוסטים חדשים ייכתבו בו מתחילת החודש הבא.</p></div></div>`);
    // Nothing connected where the posts go (src/publish/hold.js): what is held, and the way to connect.
    if (g.unconnected?.length) {
      const held = g.held?.length || 0;
      out.push(`<div class="banner warn">${icon('alert')}<div><b>${esc(connectLine(g.unconnected))}</b><p>${held ? (held === 1 ? 'מצגת מאושרת אחת מחכה לחיבור, ותעלה בשעה הפנויה הבאה אחרי שתחברו.' : `${held} מצגות מאושרות מחכות לחיבור, ויעלו בשעות הפנויות הבאות אחרי שתחברו.`) :'עד שמחברים, מצגות מאושרות מחכות ולא עולות.'}</p></div><a class="btn sm primary" href="/accounts?account=${esc(g.pack.id)}#connect-${esc(g.pack.id)}">לחבר</a></div>`);
    }
  }
  return out.join('');
}

// A count in its state's colour: blue waits for you, green went out. A zero is grey whatever it counts.
const TONE = { waiting: 'sig', scheduled: '', published: 'ok' };
const n = (count, tone) => `<b class="cnt num${count && tone ? ` ${tone}` : ''}${count ? '' : ' zero'}">${count}</b>`;

/** What needs the owner, most urgent first: a takedown to delete by hand, a picture to look at, the posts waiting. */
export function needsYou(d, max = 6, ctx = {}) {
  const rows = [];
  // A post that did not go out comes first: it can be sent again from its page.
  for (const g of d.groups) {
    for (const p of g.failed || []) rows.push({ href: `/post/${p.id}`, ic: 'alert', bad: true, title: p.hook || p.topic || 'מצגת', sub: `${g.pack.meta.displayName} · לא עלתה · אפשר לנסות שוב` });
  }
  // A TikTok post that went out twice, or whose automatic post failed, comes next; then a draft waiting for you.
  for (const g of d.groups) {
    for (const x of g.drafts || []) {
      if (['duplicate', 'failed', 'stopped'].includes(x.flow.state)) rows.push({ href: `/post/${x.id}`, ic: 'alert', bad: true, title: x.hook, sub: `${g.pack.meta.displayName} · טיקטוק: ${FLOW_HE[x.flow.state][0]}${x.flow.state === 'duplicate' ? ': מחקו אחד מהשניים' : ''}` });
    }
  }
  for (const g of d.groups) {
    for (const x of g.drafts || []) {
      if (x.flow.state === 'waiting') rows.push({ href: `/post/${x.id}`, ic: 'clock', title: x.hook, sub: `${g.pack.meta.displayName} · טיוטה בטיקטוק · ${draftNote(x.flow, x.slotAt, timeHe)}` });
    }
  }
  for (const t of d.attention?.waitingDeletes || []) rows.push({ href: `/post/${t.post_id}`, ic: 'alert', bad: true, title: t.hook || t.post_id, sub: `הודעת הסרה: למחוק ידנית ב${t.waiting.map((w) => PLATFORM_HE[w.platform] || w.platform).join(' וב')}` });
  for (const im of d.attention?.images || []) rows.push({ href: `/post/${im.id}`, ic: 'alert', title: im.hook || im.id, sub: `צריך לבדוק את התמונה בעין${im.screen?.why ? `: ${im.screen.why}` : ''}` });
  for (const g of d.groups) for (const p of g.waiting) rows.push({ href: `/posts#post-${p.id}`, acc: g.pack.id, title: p.hook, sub: postSub(ctx, g.pack, p, { name: true }) });
  return { rows: rows.slice(0, max), more: Math.max(0, rows.length - max), total: rows.length };
}

/** A post's line under its title in a list: the account (when asked), the kind, when it goes up. Empty parts are left out. */
function postSub(ctx, pack, p, { name = false, kind = true } = {}) {
  return [name ? pack.meta.displayName : '', kind ? typeLabel(ctx, pack, p) : '', whenHe(p)].filter(Boolean).join(' · ');
}

/** A short list of posts, one line each, every line a link. */
const postLines = (rows) => `<div class="list todo">${rows.map((r) => `<a href="${esc(r.href)}">${r.acc ? accDot(r.acc) : `<span class="ico${r.bad ? ' bad' : ''}">${icon(r.ic)}</span>`}<span class="tx"><b>${esc(r.title)}</b><span class="muted small">${esc(r.sub)}</span></span><span class="go">${icon('chev')}</span></a>`).join('')}</div>`;

/** Yesterday in numbers, one row per account; folded, with one arrow (the panel's own). Its cost is the operator's. */
function summaryPanel(ctx, d) {
  const rows = d.summaryRows || [];
  const name = (id) => d.groups.find((g) => g.pack.id === id)?.pack.meta.displayName || id;
  const table = rows.length
    ? `<table class="table sumtab"><thead><tr><th>חשבון</th><th>פורסמו</th>${ctx.operator ? '<th>עלות</th>' : ''}</tr></thead><tbody>${rows
        .map((r) => `<tr><td>${accDot(r.account_id)} ${esc(name(r.account_id))}</td><td>${n(r.data.published?.length || 0, 'ok')}</td>${ctx.operator ? `<td class="num">${usd(r.data.spend)}</td>` : ''}</tr>`)
        .join('')}</tbody></table>`
    : `<p class="lede">${esc(d.summary.text).replace(/\n/g, '<br>')}</p>`;
  return `<details class="panel home-panel"><summary><h2 class="inline">סיכום ${esc(shortDate(`${d.summary.day}T12:00:00Z`))}</h2></summary>${table}</details>`;
}

/** Today's TikTok drafts, each with where it stands: waiting for you, published by you, by the fallback, twice. */
function tiktokPanel(d) {
  const rows = d.groups.flatMap((g) => (g.drafts || []).map((x) => ({ ...x, g })));
  if (!rows.length) return '';
  const chip = (st) => {
    const [he, cls] = FLOW_HE[st] || [st, 'ghost'];
    return `<span class="chip ${cls}">${esc(he)}</span>`;
  };
  const extra = (x) => {
    const f = x.flow;
    if (f.state === 'waiting') return draftNote(f, x.slotAt, timeHe);
    if (f.state === 'mine') return `פורסם ${f.foundAt ? timeHe(f.foundAt) : ''}`;
    if (f.state === 'fallback') return `עם מוזיקה מהספרייה ב-${timeHe(f.fallback.at)} · מחקו את הטיוטה`;
    if (f.state === 'duplicate') return 'הטיוטה פורסמה אחרי הפרסום האוטומטי: מחקו אחד';
    return f.error || '';
  };
  return `<section class="panel home-panel" id="tiktok"><header><h2>טיוטות בטיקטוק</h2></header>
<div class="list todo">${rows.map((x) => `<a href="/post/${esc(x.id)}">${accDot(x.g.pack.id)}<span class="tx"><b>${esc(x.hook)}</b><span class="muted small">${esc(extra(x))}</span></span>${chip(flowState(x.flow))}</a>`).join('')}</div></section>`;
}

export function todayPage(ctx, d) {
  const count = (k) => d.groups.reduce((s, g) => s + g[k].length, 0);
  const todo = needsYou(d, 6, ctx);
  // One number leads: what went out today, with the latest of it. What waits for the owner and what is scheduled sit
  // beside it. What the checks stopped is not on home: it is on Posts and Results. Under them, when something runs or
  // just ended, the block of work in progress (src/web/progress.js, drawn by server.js as d.progressHtml).
  const out = count('published');
  const last = d.groups.flatMap((g) => g.published).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
  const next = d.groups.flatMap((g) => g.scheduled).map((p) => p.slot_at).filter(Boolean).sort()[0];
  const when = (t) => (dayHe(t) === dayHe(Date.now()) ? timeHe(t) : `${shortDate(t)}, ${timeHe(t)}`);
  const side = (href, k, label) => `<a href="${href}"><span class="l">${label}</span>${n(count(k), TONE[k])}</a>`;
  const body = `<div class="head"><h1>היום</h1><span class="sub">${esc(dayHe(Date.now()))}</span></div>
${stopBanners(ctx, d)}
<section class="kpis" aria-label="היום במספרים">
<a class="kpi lead${out ? ' ok' : ''}" href="/posts#published"><span class="l">פורסמו היום</span><span class="v num">${out}</span><span class="s">${last ? `האחרון ב-${esc(timeHe(last.published_at))}: ${esc(last.hook)}` : next ? `הבא עולה ב-${esc(when(next))}` : 'אין פוסט מתוזמן'}</span></a>
<div class="kpi side">${side('/posts', 'waiting', 'מחכים לאישור')}${side('/posts#scheduled', 'scheduled', 'מתוזמנים')}</div>
</section>
${d.progressHtml || ''}
<section class="panel home-panel"><header><h2>צריך אותך</h2>${todo.total ? '<a class="end small" href="/posts">כל הפוסטים</a>' : ''}</header>
${todo.rows.length ? `${postLines(todo.rows)}${todo.more ? `<p class="small"><a href="/posts">ועוד ${todo.more}</a></p>` : ''}` : '<p class="muted">אין מה לאשר כרגע. הפוסטים הבאים ייכתבו לימים ולשעות שבחרתם <a href="/settings#schedule">בהגדרות</a>.</p>'}
</section>
${tiktokPanel(d)}
${d.summary ? summaryPanel(ctx, d) : ''}`;
  return layout({ ...ctx, title: 'היום', active: 'today' }, body);
}

/* ------------------------------------------------------------ every account */

// The one page that is not one account's: every account on a line, and what waits in all of them, to approve at
// once. The owner opens it from the switcher. The approve-all button carries the posts the page listed, so a post
// drafted after the page was opened is never approved unseen.

export function allPage(ctx, d) {
  const waiting = d.groups.flatMap((g) => g.waiting);
  const ids = (posts) => posts.map((p) => p.id).join(',');
  const others = needsYou(d, 100, ctx).rows.filter((r) => !r.acc);
  const accounts = `<div class="acctab" role="table" aria-label="היום בכל חשבון">
<div class="r h" role="row"><span role="columnheader">חשבון</span><span role="columnheader">מחכים</span><span role="columnheader">מתוזמנים</span><span role="columnheader">פורסמו</span></div>
${d.groups.map((g) => `<a class="r" role="row" href="/?account=${esc(g.pack.id)}"><span class="who" role="cell">${accDot(g.pack.id)}<span><b>${esc(g.pack.meta.displayName)}</b><small>${esc(g.acc?.status === 'paused' ? 'מושהה' : MODE_HE[g.mode || 'approve'][0])} · ${g.quota ? `${g.quota.suggested.used}/${g.quota.suggested.limit} הצעות` : ''}</small></span></span>${['waiting', 'scheduled', 'published'].map((key) => `<span role="cell">${n(g[key].length, TONE[key])}</span>`).join('')}</a>`).join('')}
</div>`;
  const row = (p, g) => {
    const cover = p.media?.tiktok?.length ? `<img class="thumb" src="${media(p, 'tiktok', 0)}" alt="" width="36" height="64" loading="lazy" decoding="async">` : '<span class="thumb"></span>';
    return `<div class="qrow" id="all-${esc(p.id)}" data-post>${cover}<a class="tx" href="/post/${esc(p.id)}"><b>${esc(p.hook)}</b><span class="muted small">${esc(postSub(ctx, g.pack, p))}</span></a>${postButton(ctx, `/post/${p.id}/approve`, `${icon('check')}אישור`, { cls: 'btn sm', ajax: 'remove' })}</div>`;
  };
  const several = d.groups.filter((g) => g.waiting.length).length > 1;
  const queue = d.groups
    .filter((g) => g.waiting.length)
    .map((g) => `<div class="qgroup"><header>${accDot(g.pack.id)}<h3>${esc(g.pack.meta.displayName)}</h3><span class="muted small num">${g.waiting.length}</span>${several && g.waiting.length > 1 ? `<span class="end">${postButton(ctx, '/posts/approve-all', `לאשר את ${g.waiting.length}`, { cls: 'btn sm ghost', fields: { ids: ids(g.waiting) } })}</span>` : ''}</header>${g.waiting.map((p) => row(p, g)).join('')}</div>`)
    .join('');
  const body = `<div class="head"><h1>כל החשבונות</h1><span class="sub">${esc(dayHe(Date.now()))}</span></div>
${stopBanners(ctx, d)}
<section class="panel home-panel">${accounts}</section>
<section class="panel home-panel" id="waiting"><header><h2>מחכים לאישור</h2>${waiting.length > 1 ? `<span class="end">${postButton(ctx, '/posts/approve-all', `${icon('check')}לאשר את כל ה-${waiting.length}`, { cls: 'btn primary', fields: { ids: ids(waiting) }, confirm: `לחצו שוב לאישור ${waiting.length} פוסטים` })}</span>` : ''}</header>
${queue || '<p class="muted">אף חשבון לא מחכה לאישור.</p>'}
</section>
${others.length ? `<section class="panel home-panel"><header><h2>עוד דברים שמחכים לך</h2></header>${postLines(others)}</section>` : ''}
${d.healthHtml || ''}`;
  return layout({ ...ctx, title: 'כל החשבונות', active: 'all' }, body);
}

/* ------------------------------------------------------------ Posts */

/**
 * The button that sends a post that did not go out again. One cut off in the middle of its send may be out already:
 * the button asks the owner to look first.
 */
const retryButton = (ctx, p, { cls = 'btn sm' } = {}) =>
  postButton(ctx, `/post/${p.id}/publish-again`, `לנסות שוב`, { cls, ...(p.reason === STUCK_REASON ? { confirm: 'בדקתם שהמצגת לא עלתה? לחצו שוב כדי לשלוח' } : {}) });

/** An account's posts that did not go out, the last two weeks: each with why, and the button to send it again. */
function failedList(ctx, g) {
  if (!g.failed?.length) return '';
  return `<section class="failed"><h3 class="lbl">${icon('alert')}לא עלו <span class="chip bad">${g.failed.length}</span></h3>${g.failed
    .map((p) => `<div class="qrow" id="failed-${esc(p.id)}"><a class="tx" href="/post/${esc(p.id)}"><b>${esc(p.hook || p.topic || 'מצגת')}</b><span class="muted small">${esc(reasonHe(ctx, 'failed', p.reason) || 'לא עלתה')}</span></a>${retryButton(ctx, p)}</div>`)
    .join('')}</section>`;
}

/** Every post of the day, account by account, in full: the cards to approve and what was blocked, then what is scheduled and out. */
export function postsPage(ctx, d) {
  const sched = d.groups.flatMap((g) => g.scheduled.map((p) => ({ href: `/post/${p.id}`, acc: g.pack.id, title: p.hook, sub: postSub(ctx, g.pack, p, { name: true, kind: false }) })));
  const pub = d.groups.flatMap((g) => g.published.map((p) => ({ href: `/post/${p.id}`, acc: g.pack.id, title: p.hook, sub: `${g.pack.meta.displayName} · ${timeHe(p.published_at)}` })));
  const body = `<div class="head"><h1>פוסטים</h1><span class="sub">${esc(dayHe(Date.now()))}</span></div>
${stopBanners(ctx, d)}
${d.groups
  .map((g) => {
    const mode = MODE_HE[g.mode || 'approve'];
    return `<section class="group" id="g-${esc(g.pack.id)}" aria-labelledby="gh-${esc(g.pack.id)}"><header>${accDot(g.pack.id)}<h2 id="gh-${esc(g.pack.id)}">${esc(g.pack.meta.displayName)}</h2><span class="handle ltr">@${esc(g.pack.meta.handle)}</span><span class="end">${g.waiting.length ? `<span class="chip sig">${g.waiting.length} מחכים</span>` : ''}<span class="chip ghost" title="${esc(mode[1])}">${esc(mode[0])}</span></span></header>
${g.waiting.length ? `<div class="posts">${g.waiting.map((p) => postCard(ctx, p, g.pack)).join('')}</div>` : `<div class="empty">${icon('inbox')}<b>אין כאן מה לאשר</b>${g.acc?.status === 'paused' ? 'החשבון מושהה.' : 'הפוסטים הבאים ייכתבו לימים ולשעות שבחרתם <a href="/settings#schedule">בהגדרות</a>.'}</div>`}
${failedList(ctx, g)}
${g.blocked.length ? `<details class="facts"><summary>${icon('shield')}נחסמו היום בבדיקות <span class="chip bad">${g.blocked.length}</span><span class="chev">${icon('chev')}</span></summary><ul class="factlist">${g.blocked.map((b) => `<li><a href="/post/${esc(b.id)}"><b>${esc(b.hook || b.topic || 'בלי כותרת')}</b></a><div class="muted small">${withSupport(reasonHe(ctx, 'blocked', b.reason))}</div></li>`).join('')}</ul></details>` : ''}
</section>`;
  })
  .join('')}
<section class="panel home-panel" id="scheduled"><header><h2>מתוזמנים</h2></header>${sched.length ? postLines(sched) : '<p class="muted">אין פוסט מאושר שמחכה לשעה שלו.</p>'}</section>
<section class="panel home-panel" id="published"><header><h2>פורסמו היום</h2></header>${pub.length ? postLines(pub) : '<p class="muted">עוד לא פורסם היום.</p>'}</section>`;
  return layout({ ...ctx, title: 'פוסטים', active: 'posts' }, body);
}

/* ------------------------------------------------------------ one post */

/** On a post's page: where its TikTok draft stands, and drafts of it left in the app for the owner to delete. */
function tiktokDraftBanners(ctx, post) {
  const out = [];
  const tk = post.publish?.tiktok;
  if (tk?.flow) {
    const [he] = FLOW_HE[flowState(tk.flow)] || [tk.flow.state];
    const note = tk.flow.state === 'waiting' ? draftNote(tk.flow, post.slot_at || tk.flow.slotAt, timeHe) : tk.flow.error || '';
    out.push(`<div class="banner info">${icon('clock')}<div><b>טיקטוק: ${esc(he)}</b>${note ? `<p>${esc(note)}</p>` : ''}</div></div>`);
  } else if (tk?.uploading) out.push(`<div class="banner info">${icon('clock')}<div><b>הטיוטה בדרך לאפליקציה של טיקטוק</b></div></div>`);
  else if (tk?.error && post.status === 'approved') out.push(`<div class="banner warn">${icon('alert')}<div><b>הטיוטה לא הגיעה לטיקטוק</b><p>${esc(tk.error)}</p><p>${(Number(tk.tries) || 0) < 3 ? 'עוד ניסיון בדקות הקרובות, ולכל המאוחר בשעה של הפוסט.' : 'עוד ניסיון אחד בשעה של הפוסט.'}</p></div></div>`);
  const old = post.publish?.oldDrafts || [];
  if (old.length) out.push(`<div class="banner warn">${icon('alert')}<div><b>${old.length === 1 ? 'טיוטה ישנה של הפוסט הזה נמצאת' : `${old.length} טיוטות ישנות של הפוסט הזה נמצאות`} בתיבת הטיוטות של טיקטוק</b><p>מחקו ${old.length === 1 ? 'אותה' : 'אותן'} באפליקציה, כדי ש${old.length === 1 ? 'היא לא תפורסם' : 'הן לא יפורסמו'} בטעות.</p></div>${postButton(ctx, `/post/${post.id}/old-drafts-deleted`, 'מחקתי', { cls: 'btn sm' })}</div>`);
  return out.join('');
}

export function postPage(ctx, d, { problems = [], values = null } = {}) {
  const { post, pack } = d;
  // Still being written: the customer gets the one line the card shows, and the whole page once it is ready.
  if (!ctx.operator && building(post)) {
    return layout({ ...ctx, title: 'מצגת חדשה בכתיבה', active: 'posts' }, `<div class="head"><div><a class="muted small back" href="/posts">${icon('chev')}חזרה לפוסטים</a><h1 class="title">מצגת חדשה בכתיבה</h1></div></div>
<div class="posts">${buildingCard(post)}</div>`);
  }
  const v = values || post;
  const items = post.slides.filter((s) => s.kind === 'item');
  const kind = typeLabel(ctx, pack, post);
  const when = ctx.operator ? (post.slot_at ? stamp(post.slot_at) : '') : whenHe(post);
  const facts = factsBlock(ctx, post, { open: true });
  const trace = d.steps
    .map((s) => {
      const det = s.detail || {};
      const bits = [];
      if (det.topic) bits.push(det.topic);
      if (det.verified != null) bits.push(`${det.verified} עובדות אומתו`);
      if (det.refused?.length) bits.push(`${det.refused.length} נפסלו`);
      if (det.reviewer) bits.push(`בודק: ${det.reviewer === 'claude' ? 'Claude' : 'אופליין'}, הכי גרוע ${det.worst}/10`);
      if (det.problems?.length) bits.push(det.problems.slice(0, 3).join(' · '));
      if (det.reason) bits.push(det.reason);
      if (det.why) bits.push(det.why);
      if (det.error && ctx.operator) bits.push(det.error);
      if (det.stuck) bits.push('נקטע באמצע השליחה');
      if (s.step === 'whatsapp') bits.push(...[WHATSAPP_HE[det.action] || det.action, det.by, det.slide ? `שקף ${det.slide}` : ''].filter(Boolean));
      else if (det.via) bits.push(det.via === 'dry' ? 'פרסום יבש: נכתב לדיסק' : det.via === 'whatsapp' ? 'מוואטסאפ' : `דרך ${det.via}`);
      if (det.provider) bits.push(`${det.provider}, ${det.license}`);
      return `<li class="${esc(s.status)}"><b>${esc(STEP_HE[s.step] || s.step)}</b> <span class="muted small num">${esc(stamp(s.at))}${s.cost_usd && ctx.dev ? ` · $${s.cost_usd.toFixed(4)}` : ''}</span>${bits.length ? `<div class="d">${withSupport(bits.join(' · '))}</div>` : ''}</li>`;
    })
    .join('');
  const scores = post.checks?.scores || [];
  const edit = `<details class="panel edit" id="edit"${problems.length || values ? ' open' : ''}><summary><h2 class="inline">עריכת הטקסט</h2></summary>
${problems.length ? `<div class="problems"><b>השינוי לא נשמר, הבדיקות עצרו אותו:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
<p class="muted small">כל עריכה עוברת שוב את בדיקות הקול, הכללים ושער העובדות, וטקסט ששונה עובר גם בדיקת עובדות. אחר כך השקפים מרונדרים מחדש. מספר שלא נמצא בציטוט לא יעבור, ועריכה לא נספרת כהחלפה.</p>
<form method="post" action="/post/${esc(post.id)}/edit" class="formgrid">${csrfField(ctx)}
<fieldset><legend>שער</legend><label class="f">כותרת<input type="text" name="hook" value="${esc(v.hook)}" maxlength="90"></label><label class="f">שורה שנייה<input type="text" name="sub" value="${esc(v.sub || '')}" maxlength="120"></label></fieldset>
${items
  .map((s, i) => {
    const val = values ? { title: values[`title_${i}`], body: values[`body_${i}`] } : s;
    return `<fieldset><legend>שקף ${i + 1}</legend><label class="f">כותרת<input type="text" name="title_${i}" value="${esc(val.title)}" maxlength="80"></label><label class="f">טקסט<textarea name="body_${i}" maxlength="300">${esc(val.body)}</textarea></label></fieldset>`;
  })
  .join('')}
<label class="f">${post.caption_ig ? 'כיתוב לטיקטוק' : 'כיתוב'}<textarea name="caption" maxlength="${post.caption_ig ? 900 : 400}">${esc(v.caption)}</textarea></label>
${post.caption_ig ? `<label class="f">כיתוב קצר לאינסטגרם (הכותרת נכנסת לפניו)<textarea name="caption_short" maxlength="260">${esc(values ? values.caption_short : post.data?.captionShort || '')}</textarea></label>` : ''}
<div><button class="btn primary" type="submit">${icon('check')}לשמור ולרנדר מחדש</button></div></form></details>`;
  const screen = d.image ? (() => {
    try {
      return JSON.parse(d.image.safety_json || 'null');
    } catch {
      return null;
    }
  })() : null;
  const imageHold = d.image && d.image.safety && d.image.safety !== 'ok' && !d.image.reviewed_at;
  const tds = d.takedowns || [];
  const takedownPanel = ['published', 'taken_down', 'publishing'].includes(post.status) || tds.length
    ? `<section class="panel"><header><h2>הודעות הסרה</h2></header>
${tds.map((t) => `<div class="banner bad">${icon('alert')}<div><b>${esc(stamp(t.received_at))}${t.claimant ? ` · ${esc(t.claimant)}` : ''}</b><p dir="auto">${esc(t.notice.slice(0, 300))}</p><ul class="factlist">${Object.entries(t.deleted).map(([pl, x]) => `<li>${esc(PLATFORM_HE[pl] || pl)}: <b>${esc(PLATFORM_DELETE[x.state] || x.state)}</b>${x.why ? `<div class="muted small">${esc(x.why)}</div>` : ''}${x.state === 'by_hand' ? postButton(ctx, `/takedowns/${t.id}/deleted`, 'מחקתי ידנית', { cls: 'btn sm', fields: { platform: pl } }) : ''}</li>`).join('')}</ul></div></div>`).join('')}
${post.status !== 'taken_down' ? `<details><summary class="muted">${icon('alert')}התקבלה הודעת הסרה על הפוסט הזה</summary><form method="post" action="/post/${esc(post.id)}/takedown" class="formgrid">${csrfField(ctx)}
<p class="muted small">הפוסט יורד מיד: באינסטגרם ובפייסבוק הוא נמחק לבד כשאפשר, ובטיקטוק צריך למחוק אותו ידנית באפליקציה. הודעה שנייה תוך 90 יום משהה את החשבון.</p>
<label class="f">פלטפורמה<select name="platform"><option value="">בכולן</option><option value="tiktok">טיקטוק</option><option value="instagram">אינסטגרם</option><option value="facebook">פייסבוק</option></select></label>
<label class="f">ממי<input type="text" name="claimant" maxlength="200"></label>
<label class="f">נוסח ההודעה<textarea name="notice" maxlength="4000" required></textarea></label>
<div><button class="btn danger" type="submit">לרשום ולהוריד את הפוסט</button></div></form></details>` : ''}</section>`
    : '';

  const body = `<div class="head"><div><a class="muted small back" href="/posts">${icon('chev')}חזרה לפוסטים</a><h1 class="title">${esc(post.hook || post.topic || 'פוסט')}</h1></div><span class="sub">${statusChip(post.status)}</span></div>
${post.reason ? `<div class="banner ${post.status === 'blocked' || post.status === 'failed' ? 'bad' : 'info'}">${icon('alert')}<div><b>${withSupport(reasonHe(ctx, post.status, post.reason))}</b></div></div>` : ''}
${redoBanners(d)}
${tiktokDraftBanners(ctx, post)}
<div class="cols">
<div>
<section class="card acc acc-${esc(post.account_id)} post"><div class="meta"><span class="chip">${accDot(post.account_id)} ${esc(pack?.meta.displayName || post.account_id)}</span>${kind ? `<span class="chip">${esc(kind)}</span>` : ''}${when ? `<span class="chip">${icon('clock')}${esc(when)}</span>` : ''}</div>
${post.sub ? `<p class="subline">${esc(post.sub)}</p>` : ''}
<h3 class="lbl">טיקטוק <span>9:16</span></h3><input type="checkbox" class="ttv" id="ttv-${esc(post.id)}"><label class="ttv-l" for="ttv-${esc(post.id)}">${icon('eye')}תצוגת טיקטוק</label>${strip(post, 'tiktok', { mock: tiktokMock(pack?.meta.handle, post.caption) })}
${post.media?.instagram ? `<h3 class="lbl">אינסטגרם <span>4:5</span></h3>${strip(post, 'instagram')}` : ''}
${trustLine(post)}
<div class="capwrap">${captionBlock(post)}</div>
</section>
${post.status === 'queued' ? `<div class="actionbar">${postButton(ctx, `/post/${post.id}/approve`, `${icon('check')}אישור`, { cls: 'btn primary' })}<a class="btn" href="#edit">${icon('edit')}לערוך</a><button class="btn ghost" type="button" data-toggle="#reject-${esc(post.id)}" aria-expanded="false">${icon('x')}דחייה</button></div>
${rejectForm(ctx, post, { left: d.quota && !post.sample ? d.quota.redos.left : null })}` : ''}
${post.status === 'approved' ? `<div class="actionbar">${postButton(ctx, `/post/${post.id}/publish-now`, 'לפרסם עכשיו', { cls: 'btn primary', confirm: 'לחצו שוב כדי לפרסם עכשיו' })}${postButton(ctx, `/post/${post.id}/unapprove`, 'ביטול אישור', { cls: 'btn ghost' })}</div>` : ''}
${post.status === 'failed' ? `<div class="actionbar">${retryButton(ctx, post, { cls: 'btn primary' })}</div><p class="muted small">שולחים רק לאן שהמצגת עוד לא עלתה. מה שכבר עלה לא נשלח שוב.</p>` : ''}
${EDITABLE.includes(post.status) && d.photos ? lightPanel(ctx, d) : ''}
${EDITABLE.includes(post.status) ? edit : ''}
</div>
<div>
${topicPanel(d.topic)}
${facts ? `<section class="panel">${facts}</section>` : ''}
<section class="panel"><header><h2>בדיקות</h2></header>
<dl class="kv"><dt>שער העובדות</dt><dd>${post.checks?.token ? '<span class="chip ok">עבר</span>' : '<span class="chip">לא הגיע</span>'}</dd>
${ctx.operator ? `<dt>בודק הקול</dt><dd>${post.checks?.reviewer === 'claude' ? 'Claude' : 'אופליין (בלי מפתח API)'}</dd>` : ''}
${scores.length ? `<dt>ציון הכי גבוה</dt><dd><span class="num ltr">${Math.max(...scores)}/10</span></dd>` : ''}
${(post.checks?.rewrites || []).length ? `<dt>שכתובים</dt><dd>${post.checks.rewrites.length}</dd>` : ''}
${post.quota_kind ? `<dt>במכסה</dt><dd>${esc(QUOTA_KIND_HE[post.quota_kind] || post.quota_kind)}</dd>` : ''}
${ctx.operator ? `<dt>עלות</dt><dd>${usd(post.cost_usd, ctx.dev ? 4 : 2)}${ctx.dev && post.cost_estimated ? ' <span class="muted small">הערכה, בלי מפתח API</span>' : ''}</dd>` : ''}
${post.kind && post.kind !== 'list' ? `<dt>סוג</dt><dd>${esc(KIND_HE[post.kind] || post.kind)} · ${post.grp === 'entertaining' ? 'בידור' : 'מספרים'}</dd>` : ''}
${post.hook_pattern ? `<dt>תבנית השער</dt><dd><span class="ltr">${esc(post.hook_pattern)}</span></dd>` : ''}
${post.data?.cta?.text ? `<dt>קריאה לפעולה</dt><dd>${esc(post.data.cta.text)}</dd>` : ''}
${post.data?.keywords?.length ? `<dt>מילות חיפוש</dt><dd>${post.data.keywords.map((x) => `<bdi>${esc(x)}</bdi>`).join(' · ')}</dd>` : ''}
${d.image ? `<dt>תמונה</dt><dd>${esc(d.image.provider)} · ${esc(d.image.license)}${d.image.author ? ` · ${esc(d.image.author)}` : ''}${d.image.source_url ? ` · <a href="${esc(d.image.source_url)}" target="_blank" rel="noopener noreferrer">מקור ${icon('ext')}</a>` : ''}${d.image.ai_generated ? ' · <span class="chip warn">AI</span>' : ''}</dd>
<dt>בדיקת התמונה</dt><dd>${d.image.safety === 'ok' || d.image.reviewed_at ? `<span class="chip ok">${d.image.reviewed_at ? `נבדקה על ידי ${esc(d.image.reviewed_by)}` : 'עברה'}</span>` : d.image.safety ? `<span class="chip warn">מחכה לבדיקה בעין</span>` : '<span class="chip ghost">לא נבדקה</span>'}${screen?.why ? `<div class="muted small" dir="auto">${esc(screen.why)}</div>` : ''}${imageHold ? postButton(ctx, `/post/${post.id}/image-ok`, 'הסתכלתי: אין דם, פציעה או סימן מים', { cls: 'btn sm' }) : ''}</dd>` : ''}
${d.metrics.length ? d.metrics.slice(0, 2).map((m) => `<dt>${esc(PLATFORM_HE[m.platform] || m.platform)}</dt><dd class="num">${k(m.views)} צפיות · ${k(m.likes)} לייקים · ${k(m.shares)} שיתופים${m.saves != null ? ` · ${k(m.saves)} שמירות` : ''}</dd>`).join('') : ''}
</dl></section>
${takedownPanel}
<section class="panel"><header><h2>איך הפוסט נוצר</h2></header><ol class="trace">${trace}</ol></section>
</div></div>`;
  return layout({ ...ctx, title: post.hook || 'פוסט', active: 'posts' }, body);
}

/* ------------------------------------------------------------ accounts */

// The account page (the owner, 2026-10-31: "design this page better"). It was one narrow card of label and value rows,
// pinned to the right of a wide page. A customer has one account (src/web/onboarding.js ONE_ACCOUNT), so the page is
// that account's, across the width: a header with its name, handle and state and the way to its sources, rivals and
// sounds; under it a grid of panels, each one thing read at a glance: the month's plan, the last 7 days, what waits,
// approval, the networks, how TikTok posts go out, the look. Three columns on a desk, two on a tablet, one on a phone
// (style.css .acct-grid); the networks take two columns and the small panels stack beside them. The power switch is
// last, apart from the rest, as a destructive button is in iOS.
//
// The page shows the account the switcher picked (server.js), the operator's too. Given several (the function takes a
// list), each is a section of its own, the same layout one under the other.

export function accountsPage(ctx, rows) {
  const body = `<div class="head"><h1>החשבון</h1><span class="end"><a class="btn sm" href="/new">${icon('plus')}חשבון חדש</a></span></div>
${rows.map((r) => accountSection(ctx, r)).join('')}`;
  return layout({ ...ctx, title: 'חשבונות', active: 'accounts' }, body);
}

/** One account: its header, a paused account's banner, the grid of panels, and the power switch. */
function accountSection(ctx, { pack, acc, mode, customer, resumable, spend, publishers, week, style, quota, connect }) {
  const id = esc(pack.id);
  const paused = acc.status === 'paused';
  const head = `<header class="panel acct-head">${accDot(pack.id)}<div class="who"><h2 id="acct-name-${id}">${esc(pack.meta.displayName)}</h2><span class="muted ltr">@${esc(pack.meta.handle)}</span></div>${paused ? '<span class="chip warn">מושהה</span>' : '<span class="chip ok">פעיל</span>'}
<div class="links"><a class="btn sm" href="/sources?account=${id}">מקורות</a><a class="btn sm" href="/rivals?account=${id}">מתחרים</a><a class="btn sm" href="/sounds?account=${id}">סאונדים</a></div></header>`;
  const kill = acc.paused_reason === 'kill';
  const pausedBanner = paused
    ? `<div class="banner ${kill ? 'bad' : 'warn'}">${icon(kill ? 'power' : 'alert')}<div><b>${esc(PAUSE_REASONS[acc.paused_reason] || acc.paused_reason)}</b>${acc.paused_detail ? `<p>${withSupport(acc.paused_detail)}</p>` : ''}${resumable ? '' : `<p>${withSupport('את החשבון הזה מפעילים מחדש רק אנחנו. כתבו לנו ונבדוק יחד מה קרה.')}</p>`}</div>${resumable ? postButton(ctx, `/accounts/${pack.id}/resume`, 'הפעלה מחדש', { cls: 'btn sm' }) : ''}</div>`
    : '';
  // The networks, with (the operator's) what each platform really goes out through.
  const networks = connect
    ? `<section class="panel acct-net">${connectPanel(ctx, connect, { heading: 'h3' })}${ctx.operator ? `<dl class="kv mt12"><dt>פרסום</dt><dd>${publishers.map((x) => `${PLATFORM_HE[x.platform] || x.platform}: ${publisherHe(x)}`).join(' · ')}</dd></dl>` : ''}</section>`
    : '';
  const foot = paused
    ? ''
    : `<div class="acct-foot">${postButton(ctx, `/accounts/${pack.id}/kill`, `${icon('power')}לכבות את החשבון`, { cls: 'btn sm danger', confirm: 'לחצו שוב כדי לכבות' })}${ctx.operator ? '' : '<p class="muted small m0">אחרי הכיבוי שום דבר לא ייכתב ולא יפורסם בחשבון עד שתפעילו אותו מחדש.</p>'}</div>`;
  return `<section class="acct acc acc-${id}" id="acc-${id}" aria-labelledby="acct-name-${id}">
${head}
${pausedBanner}
<div class="acct-grid">
${quota ? monthPanel(ctx, quota, pack.id, spend) : ''}
${weekPanel(pack, week)}
${queuePanel(pack, week.counts)}
${networks}
${modePanel(ctx, pack, { mode, customer })}
${connect ? tiktokModePanel(ctx, connect) : ''}
${stylePanel(ctx, pack, style)}
${picksFormats(pack, customer) ? formatsPanel(ctx, pack) : ''}
</div>
${foot}
</section>`;
}

/**
 * The month on the account page: the suggestions and the redos used of the plan, each with its meter (orange from 75%,
 * red from 90%, as the header's ring), and what happens when the suggestions run out. A month the workspace's accounts
 * share is said to be theirs together, with what this account used of it. What it cost is the operator's.
 */
function monthPanel(ctx, q, mine, spend) {
  const s = q.suggested;
  const r = q.redos;
  const meter = (x, label) => `<meter min="0" max="${x.limit || 1}" low="${(x.limit || 1) * 0.75}" high="${(x.limit || 1) * 0.9}" optimum="0" value="${Math.min(x.used, x.limit || 1)}" aria-label="${label}"></meter>`;
  const line = (label, x) => `<div class="mrow"><span>${label}</span><span class="num"><b>${x.used}</b> מתוך ${x.limit}</span></div>${meter(x, label)}`;
  const own = q.shared && q.accounts?.[mine] ? `<p class="muted small m6">לכל החשבונות שלכם יחד. בחשבון הזה ${q.accounts[mine].suggested === 1 ? 'הצעה אחת' : `${q.accounts[mine].suggested} הצעות`} החודש.</p>` : '';
  return `<section class="panel acct-month"><header><h3>החודש</h3></header>
${line('הצעות שנוצלו', s)}${line('החלפות שנוצלו', r)}${own}${s.held + r.held ? `<p class="muted small m6">עוד ${s.held + r.held} בכתיבה עכשיו.</p>` : ''}${s.used >= s.limit ? '<p class="small m6"><span class="chip warn">ההצעות של החודש נוצלו</span> פוסטים חדשים ייכתבו מתחילת החודש הבא.</p>' : ''}
${ctx.operator ? `<div class="mrow cost"><span>עלות החודש</span><b class="num">${usd(spend)}</b></div>` : ''}</section>`;
}

/** The last 7 days: how many went out and their views, then a bar a day, the count over it, today's the last. */
function weekPanel(pack, week) {
  const total = week.days.reduce((s, x) => s + x.n, 0);
  const max = Math.max(1, ...week.days.map((x) => x.n));
  const h = (n) => (n === 0 ? 'h0' : `h${Math.max(1, Math.min(4, Math.ceil((n / max) * 4)))}`);
  const bars = week.days.map((x, i) => `<span${i === week.days.length - 1 ? ' class="today"' : ''} title="${esc(shortDate(x.at))}: ${x.n}"><b class="num">${x.n || ''}</b><i class="${h(x.n)}"></i><small>${esc(weekdayNarrow(x.at))}</small></span>`).join('');
  return `<section class="panel acct-week"><header><h3>7 הימים האחרונים</h3></header>
<p class="stat"><b class="num">${total}</b><span>פורסמו</span>${week.views != null ? `<span class="muted">· ${k(week.views)} צפיות</span>` : ''}</p>
<div class="week" aria-label="פוסטים שפורסמו בכל יום">${bars}</div></section>`;
}

/** What waits, made this week: the posts to approve and the approved ones, each a link to them, and what was stopped. */
function queuePanel(pack, counts) {
  const id = esc(pack.id);
  return `<section class="panel acct-queue"><header><h3>בתור</h3></header><div class="qlist">
<a href="/posts?account=${id}"><span class="l">ממתינים</span>${n(counts.queued || 0, 'sig')}</a>
<a href="/posts?account=${id}#scheduled"><span class="l">מאושרים</span>${n(counts.approved || 0)}</a>
<div><span class="l">נחסמו השבוע</span>${n(counts.blocked || 0)}</div></div></section>`;
}

/**
 * Whether posts wait for approval. A customer reads one line: every post waits for them (src/autonomy/rails.js). The
 * operator chooses for the company's own accounts, and sees a customer's as fixed.
 */
function modePanel(ctx, pack, { mode, customer }) {
  const body =
    !ctx.operator || customer
      ? `<p class="m0">כל פוסט מחכה לאישור שלכם לפני שהוא עולה.</p>${ctx.operator ? '<p class="muted small m6">חשבון של לקוח: תמיד במצב אישור.</p>' : ''}`
      : `<form method="post" action="/accounts/${esc(pack.id)}/mode" data-autosubmit>${csrfField(ctx)}<div class="seg" role="radiogroup" aria-label="מצב אוטונומיה">${['approve', 'digest', 'auto']
          .map((m) => `<input type="radio" name="mode" value="${m}" id="m-${esc(pack.id)}-${m}"${mode === m ? ' checked' : ''}><label for="m-${esc(pack.id)}-${m}">${MODE_HE[m][0]}<small>${MODE_HE[m][1]}</small></label>`)
          .join('')}</div><noscript><button class="btn sm" type="submit">שמירה</button></noscript></form>`;
  return `<section class="panel acct-mode"><header><h3>אישור</h3></header>${body}</section>`;
}

/** The look the posts are drawn in, since when, the way to another, and a new one waiting to be taken. */
function stylePanel(ctx, pack, style) {
  if (!style) return '';
  const name = style.theme.style ? `סגנון ${esc(style.theme.style.name)}` : `<span class="ltr">${esc(style.theme.template)}/${esc(style.theme.variant || 'a')}</span>`;
  const pending = style.pending
    ? `<div class="notice">${icon('alert')}<div><b>${ctx.operator ? 'הסגנון בקובץ theme.json השתנה' : 'יש לחשבון סגנון חדש'}</b><div class="small">הפוסטים ממשיכים לצאת בסגנון הקודם עד שעוברים לחדש. פוסטים שכבר צוירו לא משתנים.</div></div>${postButton(ctx, `/accounts/${pack.id}/style`, 'לעבור לסגנון החדש', { cls: 'btn sm' })}</div>`
    : '';
  return `<section class="panel acct-style"><header><h3>סגנון</h3></header>
<p class="m0"><b>${name}</b> <span class="muted small">נעול מ-${esc(shortDate(style.at))}</span></p>
<div class="actions p0 m6"><a class="btn sm" href="/styles?account=${esc(pack.id)}">להחליף סגנון</a></div>${pending}</section>`;
}

/**
 * An account's month: "X of 40 used, Y of 10 redos", and what happens when the suggestions run out. A month the
 * workspace's accounts share is said to be theirs together, with what this account used of it (`mine`, its id).
 */
function quotaRow(q, mine = null) {
  const s = q.suggested;
  const r = q.redos;
  const full = s.used >= s.limit;
  const own = q.shared && mine && q.accounts?.[mine] ? `<p class="muted small m4">לכל החשבונות שלכם יחד. בחשבון הזה ${q.accounts[mine].suggested === 1 ? 'הצעה אחת' : `${q.accounts[mine].suggested} הצעות`} החודש.</p>` : '';
  return `<div><div class="row"><span>החודש</span><b class="num">נוצלו ${s.used} מתוך ${s.limit} הצעות · ${r.used} מתוך ${r.limit} החלפות</b></div>${own}<meter min="0" max="${s.limit || 1}" low="${(s.limit || 1) * 0.75}" high="${(s.limit || 1) * 0.9}" optimum="0" value="${Math.min(s.used, s.limit || 1)}"></meter>${s.held + r.held ? `<p class="muted small m4">עוד ${s.held + r.held} בכתיבה עכשיו.</p>` : ''}${full ? '<p class="small m4"><span class="chip warn">ההצעות של החודש נוצלו</span> פוסטים חדשים ייכתבו מתחילת החודש הבא.</p>' : ''}</div>`;
}

/**
 * The customer's plan on Settings: what a month gives (the suggestions, the redos, the small changes that are free) and
 * what is used of it. A workspace's accounts share one month (src/budget/quota.js): it is shown once, with what each
 * account used of it. Never money: what the posts cost is the operator's (costsPanel).
 */
function planPanel(plans) {
  if (!plans.length) return '';
  const u = plans[0].usage;
  const one = u.plan.scope === 'workspace' && plans.every(({ usage: x }) => x.plan.workspaceId === u.plan.workspaceId);
  let gives;
  let rows;
  if (one) {
    const { suggested: s, redos: r } = u;
    const name = PLAN_HE[u.plan.name];
    gives = `${name ? `אתם ${name.replace(/^ה/, 'ב')}. ` : ''}כל חודש מגיעות אליכם ${s.limit} הצעות לפוסטים, ו-${r.limit} החלפות לפוסטים שדחיתם.${plans.length > 1 ? ' הן משותפות לכל החשבונות שלכם, וחשבון נוסף מתחלק באותן הצעות.' : ''}`;
    const each = plans.length > 1 ? `<ul class="factlist m6">${plans.map(({ pack }) => `<li>${accDot(pack.id)} ${esc(pack.meta.displayName)} <span class="muted small">${u.accounts?.[pack.id]?.suggested ?? 0} הצעות · ${u.accounts?.[pack.id]?.redos ?? 0} החלפות</span></li>`).join('')}</ul>` : '';
    rows = `${quotaRow(u)}${each}`;
  } else {
    const same = plans.every(({ usage: x }) => x.suggested.limit === u.suggested.limit && x.redos.limit === u.redos.limit);
    gives = same ? `כל חודש מגיעות אליכם ${u.suggested.limit} הצעות לפוסטים, ו-${u.redos.limit} החלפות לפוסטים שדחיתם.` : 'לכל חשבון יש מספר משלו של הצעות לפוסטים ושל החלפות לפוסטים שדחיתם.';
    rows = plans.map(({ pack, usage: x }) => `${plans.length > 1 ? `<h3 class="lbl">${accDot(pack.id)} ${esc(pack.meta.displayName)}</h3>` : ''}${quotaRow(x)}`).join('');
  }
  return `<section class="panel" id="plan"><header><h2>החבילה החודשית</h2><span class="end muted small">מתחדשת בתחילת כל חודש</span></header>
<p class="muted">${gives} הצעה נספרת כשהפוסט מגיע אליכם לאישור, גם אם תדחו אותו. דחייה עם סיבה כותבת פוסט חלופי, וזו החלפה. פוסט שהבדיקות שלנו עצרו לא נספר.</p>
<p class="muted">שינויים קטנים לא נספרים בכלל: עריכת הטקסט, תמונה אחרת מאלה שכבר נמצאו לפוסט, או שקף שמורידים.</p>
${rows}</section>`;
}

/* ------------------------------------------------------------ results */

const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`);
const DIRECTIVE_HE = { open: ['מחכה לפוסט הבא', 'warn'], used: ['נכתב', 'ok'], expired: ['הוחלף בדוח חדש', 'ghost'] };

/** The morning's feedback, one panel per account: the posts of the last three days in their boxes, and what each box asked for. */
export function feedbackPanels(list) {
  return list
    .map(({ pack, day, text, report, directives }) => {
      const head = `<header>${accDot(pack.id)}<h2>${esc(pack.meta.displayName)} · המשוב של הבוקר</h2>${day ? `<span class="end muted small">${esc(dayHe(day))}</span>` : ''}</header>`;
      if (!report) return `<section class="panel">${head}<p class="muted">עוד אין דוח. כל בוקר, לפני שנכתבים הפוסטים, המנוע קורא מחדש את המספרים של הפוסטים משלושת הימים האחרונים, ושם כל אחד מהם באחת מארבע קופסאות.</p></section>`;
      const posts = report.posts || [];
      const measures = [...new Set(posts.flatMap((p) => Object.values(p.platforms || {}).map((x) => x.measure)))];
      const row = (p) => {
        const x = p.platforms?.[p.primary] || {};
        return `<li><a href="/post/${esc(p.post)}">${esc(p.hook || p.post)}</a><div class="muted small num">${esc(PLATFORM_HE[p.primary] || p.primary || '')}: ${k(x.views)} צפיות מול חציון ${k(Math.round(x.medianViews || 0))} · ${pct(x.rate)} מול ${pct(x.medianRate)}</div></li>`;
      };
      const cells = PRIORITY.map((b) => {
        const ins = posts.filter((p) => p.box === b);
        return `<div class="cell ${b}"><b>${esc(BOXES[b].he)}</b><span class="todo">${esc(BOXES[b].todo)}</span>${ins.length ? `<ul>${ins.map(row).join('')}</ul>` : '<p class="muted small">אין</p>'}</div>`;
      }).join('');
      const waiting = posts.filter((p) => !p.box);
      if (!posts.some((p) => p.box)) return `<section class="panel">${head}<p class="muted">${esc(text)}.${waiting.length ? ` ${waiting.map((p) => esc(p.hook || p.post)).join(' · ')}` : ''}</p></section>`;
      // One line per post and answer: the three variations of a winner are one line, with what became of each.
      const groups = new Map();
      for (const d of directives) {
        const key = `${d.post_id}:${d.action}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      }
      const plans = groups.size
        ? `<h3>מה זה משנה בפוסטים הבאים</h3><ul class="factlist">${[...groups.values()]
            .map((ds) => {
              const d = ds[0];
              const states = Object.entries(DIRECTIVE_HE).filter(([st]) => ds.some((x) => x.status === st)).map(([st, [label, tone]]) => `<span class="chip ${tone}">${esc(label)}${ds.length > 1 ? ` ${ds.filter((x) => x.status === st).length}` : ''}</span>`).join(' ');
              const made = ds.filter((x) => x.used_post_id).map((x) => `<a href="/post/${esc(x.used_post_id)}">${esc(x.used_hook || 'הפוסט')}</a>`).join(' · ');
              return `<li>${states} ${esc(BOXES[d.box]?.todo || d.action)}${d.plan?.steer?.hook ? ` <span class="muted small">(בעקבות "${esc(d.plan.steer.hook)}")</span>` : ''}${made ? `<div class="small">${made}</div>` : ''}</li>`;
            })
            .join('')}</ul>`
        : '';
      return `<section class="panel">${head}<p class="muted small">${esc(text)}. צפיות מול החציון של החשבון עצמו, באותו גיל של הפוסט. מה נמדד: ${measures.map((m) => esc(MEASURES[m] || m)).join(', ') || 'אין עוד מספרים'}. תדר לא קורא הודעות פרטיות.</p>
<div class="matrix">${cells}</div>
${waiting.length ? `<p class="muted small">עוד לא בקופסה (אין מספיק פוסטים קודמים להשוואה, או שהפלטפורמה עוד לא מסרה מספרים): ${waiting.map((p) => esc(p.hook || p.post)).join(' · ')}</p>` : ''}
${plans}</section>`;
    })
    .join('');
}

const bars = (last) =>
  `<span class="rel" aria-label="שלוש התוצאות האחרונות ביחס לחציון">${last.map((r) => `<i class="${r.rel >= 1 ? 'win' : r.rel < 0.7 ? 'lose' : ''} h${Math.max(1, Math.min(4, Math.round(r.rel * 2)))}" title="${r.rel.toFixed(2)}"></i>`).join('')}</span>`;

// The charts are SVG drawn here: the policy allows no script from elsewhere and no inline style. Bars stretch with
// the panel (preserveAspectRatio none) and every label is HTML around them, so it stays sharp on a phone.
const DAY_MS = 86_400_000;
const CHART_DAYS = 30;

/** Views of the posts that went out each day of the last 30, TikTok under Instagram under Facebook; oldest on the right. */
function viewsChart(posts, t = Date.now()) {
  const days = Array.from({ length: CHART_DAYS }, (_, i) => ({ key: dayHe(t - (CHART_DAYS - 1 - i) * DAY_MS), at: t - (CHART_DAYS - 1 - i) * DAY_MS, tiktok: 0, instagram: 0, facebook: 0, n: 0 }));
  const byKey = new Map(days.map((x) => [x.key, x]));
  for (const p of posts) {
    const x = byKey.get(dayHe(p.published_at));
    if (!x) continue;
    x.n++;
    for (const pl of PLATFORM_LIST) x[pl] += p.metrics[pl]?.views || 0;
  }
  const max = Math.max(1, ...days.map((x) => x.tiktok + x.instagram + x.facebook));
  const W = 10;
  const h = (v) => (v / max) * 96;
  const bars = days
    .map((x, i) => {
      if (!x.tiktok && !x.instagram && !x.facebook) return '';
      const at = (CHART_DAYS - 1 - i) * W + 1.5;
      const tt = h(x.tiktok);
      const ig = h(x.instagram);
      const fb = h(x.facebook);
      const fbBar = x.facebook ? `<rect class="c-fb" x="${at}" y="${(100 - tt - ig - fb).toFixed(2)}" width="7" height="${fb.toFixed(2)}"/>` : '';
      return `<g><title>${esc(shortDate(x.at))}: ${x.n} ${x.n === 1 ? 'פוסט' : 'פוסטים'}, ${k(x.tiktok + x.instagram + x.facebook)} צפיות (טיקטוק ${k(x.tiktok)}, אינסטגרם ${k(x.instagram)}${x.facebook ? `, פייסבוק ${k(x.facebook)}` : ''})</title><rect class="c-tt" x="${at}" y="${(100 - tt).toFixed(2)}" width="7" height="${tt.toFixed(2)}"/><rect class="c-ig" x="${at}" y="${(100 - tt - ig).toFixed(2)}" width="7" height="${ig.toFixed(2)}"/>${fbBar}</g>`;
    })
    .join('');
  const grid = [25, 50, 75].map((y) => `<line class="c-grid" x1="0" x2="${CHART_DAYS * W}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`).join('');
  const ticks = [0, 10, 20, CHART_DAYS - 1].map((i) => `<span>${esc(shortDate(days[i].at))}</span>`).join('');
  const sum = (pl) => days.reduce((a, x) => a + x[pl], 0);
  return `<div class="chart"><span class="ymax num">${k(max)}</span><svg viewBox="0 0 ${CHART_DAYS * W} 100" preserveAspectRatio="none" role="img" aria-label="צפיות לפי יום הפרסום">${grid}${bars}<line class="c-base" x1="0" x2="${CHART_DAYS * W}" y1="100" y2="100" vector-effect="non-scaling-stroke"/></svg><div class="xt">${ticks}</div></div>
<p class="legend"><span><i class="c-tt"></i>טיקטוק <b class="num">${k(sum('tiktok'))}</b></span><span><i class="c-ig"></i>אינסטגרם <b class="num">${k(sum('instagram'))}</b></span>${sum('facebook') ? `<span><i class="c-fb"></i>פייסבוק <b class="num">${k(sum('facebook'))}</b></span>` : ''}</p>`;
}

/** Each measured post against the median, oldest on the right: green over 1×, grey under; a bar is its post's link. */
function relChart(scored) {
  const posts = scored.slice().sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
  const W = 10;
  const n = posts.length;
  // 0× at the bottom, 2× at the top, the median in the middle; a post over 2× reaches the top (its title says how far).
  const y = (r) => 100 - Math.min(2, r) * 50;
  const bars = posts
    .map((p, i) => {
      const at = (n - 1 - i) * W + 2;
      const top = Math.min(y(p.rel), 50);
      const hgt = Math.abs(y(p.rel) - 50);
      return `<a href="/post/${esc(p.id)}"><title>${esc(p.hook)}: ${p.rel.toFixed(2)}× (${esc(shortDate(p.published_at))})</title><rect class="${p.rel >= 1 ? 'c-up' : 'c-down'}" x="${at}" y="${top.toFixed(2)}" width="6" height="${Math.max(0.8, hgt).toFixed(2)}"/></a>`;
    })
    .join('');
  return `<div class="chart rel2"><span class="ymax num" dir="ltr">2×</span><span class="ymid num" dir="ltr">1×</span><svg viewBox="0 0 ${Math.max(1, n) * W} 100" preserveAspectRatio="none" role="img" aria-label="כל פוסט מול החציון"><line class="c-base" x1="0" x2="${n * W}" y1="50" y2="50" vector-effect="non-scaling-stroke"/>${bars}</svg>${n ? `<div class="xt"><span>${esc(shortDate(posts[0].published_at))}</span><span>${esc(shortDate(posts[n - 1].published_at))}</span></div>` : ''}</div>
<p class="legend"><span><i class="c-up"></i>מעל החציון <b class="num">${posts.filter((p) => p.rel >= 1).length}</b></span><span><i class="c-down"></i>מתחת <b class="num">${posts.filter((p) => p.rel < 1).length}</b></span></p>`;
}

/** Each account's style test: which two styles, until when, and once settled which won, with each one's numbers. */
function styleTestPanels(list) {
  if (!list.length) return '';
  const row = (name, x) => `<li><b>סגנון ${esc(name)}</b>: ${x.posts} פוסטים${x.views != null ? `, חציון ${k(Math.round(x.views))} צפיות` : ''}${x.rate != null ? `, ${(x.rate * 100).toFixed(1)}% תגובה לצפייה` : ''}</li>`;
  return list
    .map(({ pack, test }) => `<section class="panel"><header><h2>מבחן סגנונות · ${esc(pack.meta.displayName)}</h2></header>
${test.result ? `<p>${test.result.winner ? `<b>${esc(test.result.winner)} ניצח וננעל.</b> ` : ''}${esc(test.result.why)}</p>${test.result.styles ? `<ul class="factlist">${Object.entries(test.result.styles).map(([n, x]) => row(n, x)).join('')}</ul>` : ''}` : `<p>רץ עד ${esc(shortDate(test.until))}: הפוסטים יוצאים לסירוגין ב-${esc(test.styles.join(' וב-'))}.</p>`}
<p class="small"><a href="/styles?account=${esc(pack.id)}">לדף הסגנון</a></p></section>`)
    .join('');
}

export function resultsPage(ctx, d) {
  // What the published posts did leads. The formats, and what the checks stopped, wait behind a button each.
  const sum = (p, f) => PLATFORM_LIST.reduce((a, pl) => a + (p.metrics[pl]?.[f] || 0), 0);
  const measured = d.posts.filter((p) => Object.keys(p.metrics).length);
  const total = (f) => measured.reduce((a, p) => a + sum(p, f), 0);
  const top = measured.slice().sort((a, b) => sum(b, 'views') - sum(a, 'views'))[0];
  const most = Math.max(1, ...measured.map((p) => sum(p, 'views')));
  const rels = new Map(d.scored.map((p) => [p.id, p.rel]));
  const side = (label, v) => `<div><span class="l">${label}</span><b class="cnt num">${k(v)}</b></div>`;
  const kpis = `<div class="kpis">
<div class="kpi lead"><span class="l">צפיות</span><span class="v num">${k(total('views'))}</span><span class="s">${measured.length ? `ב-${measured.length} פוסטים שנמדדו${top ? ` · הכי נצפה: ${esc(top.hook)}` : ''}` : 'עוד אין פוסט שנמדד'}</span></div>
<div class="kpi side">${side('לייקים', total('likes'))}${side('שיתופים', total('shares'))}${side('תגובות', total('comments'))}${side('שמירות', total('saves'))}</div>
</div>`;
  const postRow = (p) => {
    const has = Object.keys(p.metrics).length > 0;
    const v = sum(p, 'views');
    const r = rels.get(p.id);
    const per = PLATFORM_LIST.filter((pl) => p.metrics[pl]).map((pl) => `${PLATFORM_HE[pl]} ${k(p.metrics[pl].views)}`).join(' · ');
    const cell = (f) => (has ? k(sum(p, f)) : '–');
    return `<tr><td class="title" data-k="">${accDot(p.account_id)} <a href="/post/${esc(p.id)}">${esc(p.hook)}</a><div class="muted small">${esc(shortDate(p.published_at))}${per ? ` · ${esc(per)}` : ''}</div></td>
<td class="n views" data-k="צפיות">${has ? `<span class="vbar" aria-hidden="true"><i class="w${Math.max(1, Math.round((v / most) * 10))}"></i></span>${k(v)}` : '<span class="muted">עוד לא נמדד</span>'}</td><td class="n" data-k="לייקים">${cell('likes')}</td><td class="n" data-k="שיתופים">${cell('shares')}</td><td class="n" data-k="תגובות">${cell('comments')}</td><td class="n" data-k="מול החציון">${r != null ? `<span class="cnt${r >= 1 ? ' ok' : ''}">${r.toFixed(2)}×</span>` : '–'}</td></tr>`;
  };
  const posts = d.posts.length
    ? `<section class="panel"><header><h2>הפוסטים שפורסמו</h2><span class="end muted small">${d.posts.length}</span></header>
<table class="table stack resposts"><thead><tr><th>פוסט</th><th>צפיות</th><th>לייקים</th><th>שיתופים</th><th>תגובות</th><th>מול החציון</th></tr></thead><tbody>${d.posts.map(postRow).join('')}</tbody></table>
<p class="muted small">כל פוסט נמדד 72 שעות אחרי שעלה, מול החציון של אותה פלטפורמה: בטיקטוק שיתופים ולייקים לצפייה, באינסטגרם שמירות לחשיפה.</p></section>`
    : `<div class="empty">${icon('results')}<b>אין עדיין מספרים</b>מספרים מגיעים רק מפוסטים שפורסמו בפועל, והציון נקבע 72 שעות אחרי הפרסום.</div>`;
  const dropped = d.formats.flatMap((f) => f.rows.filter((r) => r.status === 'dropped' || r.atRisk).map((r) => ({ ...r, pack: f.pack })));
  const formats = `<p class="lede">70% מהפוסטים בפורמטים מוכחים, 30% בניסיונות, ופורמט נושר אחרי 3 תוצאות ברצף מתחת ל-70% מהחציון.</p>
${(d.learning || []).filter((l) => l.share != null).map((l) => `<section class="panel"><header>${accDot(l.pack.id)}<h2>${esc(l.pack.meta.displayName)} · בידור מול מספרים</h2></header>
<p>עכשיו <b class="num">${Math.round(l.share * 100)}%</b> מהפוסטים בפורמטים של בידור (סיפור, נחשו מי, קרחון...) ו-<b class="num">${Math.round((1 - l.share) * 100)}%</b> בפורמטים של מספרים (ראש בראש, דירוג).${l.recent ? ` מתוך ${l.recent} הפוסטים האחרונים, ${l.recentEnt} היו בידור.` : ''}</p>
<p class="muted small">${l.learned?.why ? `השינוי האחרון (${esc(shortDate(l.learned.at))}): ${esc(l.learned.why)}.` : `עוד לא זז: היחס זז ב-5 נקודות בכל פעם, לכל היותר פעם בשבוע, בין ${Math.round(MIX.min * 100)}% ל-${Math.round(MIX.max * 100)}% בידור, לכיוון הקבוצה שהפוסטים שלה עושים יותר טוב, ורק כשיש לפחות 3 תוצאות בכל קבוצה.`}</p>
${l.hooks.some((h) => h.used) ? `<table class="table stack"><thead><tr><th>תבנית שער</th><th>פורמט</th><th>שימושים</th><th>ממוצע מול החציון</th></tr></thead><tbody>${l.hooks
  .filter((h) => h.used)
  .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
  .map((h) => `<tr><td data-k="">${esc(h.pattern)}${h.resting ? ' <span class="chip warn">במנוחה</span>' : ''}</td><td data-k="פורמט">${esc(h.format)}</td><td class="n" data-k="שימושים">${h.used}</td><td class="n" data-k="ממוצע">${h.avg != null ? `${h.avg.toFixed(2)}× (${h.n})` : 'אין עוד מספרים'}</td></tr>`)
  .join('')}</tbody></table>` : '<p class="muted small">אין עדיין פוסטים לפי תבניות השער: כל תבנית מקבלת קודם שני תורות, ואז נבחרת לפי התוצאות.</p>'}
${l.hooks.some((h) => h.template) ? '<p class="muted small">תבניות השער, כמו "הנה האמת האמיתית על" או "במקרה שהמאמן שלכם לא אמר לכם", נלמדות מכל הפורמטים של החשבון יחד. תבנית ששלוש התוצאות האחרונות שלה מתחת ל-70% מהחציון נחה 14 יום.</p>' : ''}</section>`).join('')}
<section class="panel"><header><h2>מה נושר ולמה</h2></header>${dropped.length ? `<ul class="factlist">${dropped.map((r) => `<li>${accDot(r.pack.id)} <b>${esc(r.name)}</b> ${r.status === 'dropped' ? '<span class="chip bad">נשר</span>' : '<span class="chip warn">בסכנה</span>'}<div class="muted small">${esc(r.dropped_why || 'שתי התוצאות האחרונות מתחת ל-70% מהחציון: עוד אחת והוא נושר')}</div></li>`).join('')}</ul>` : '<p class="muted">אף פורמט לא נשר ואף אחד לא בסכנה.</p>'}</section>
${d.formats
  .map(
    (f) => `<section class="panel"><header>${accDot(f.pack.id)}<h2>${esc(f.pack.meta.displayName)} · פורמטים</h2></header>
<table class="table stack"><thead><tr><th>פורמט</th><th>סוג</th><th>מצב</th><th>תוצאות</th><th>ממוצע מול החציון</th><th>שלוש אחרונות</th></tr></thead><tbody>${f.rows
      .map((r) => `<tr><td data-k="">${esc(r.name)}</td><td data-k="סוג">${r.kind === 'proven' ? 'מוכח' : 'ניסיון'}</td><td data-k="מצב">${r.status === 'dropped' ? '<span class="chip bad">נשר</span>' : r.atRisk ? '<span class="chip warn">בסכנה</span>' : '<span class="chip ok">פעיל</span>'}</td><td class="n" data-k="תוצאות">${r.n}</td><td class="n" data-k="ממוצע">${r.avg != null ? `${r.avg.toFixed(2)}×` : '–'}</td><td data-k="אחרונות">${r.last.length ? bars(r.last) : '–'}</td></tr>`)
      .join('')}</tbody></table></section>`
  )
  .join('')}
<section class="panel"><header><h2>פורמטים שעובדים עכשיו</h2><span class="end muted small">שורטס ביוטיוב, עם המספרים של יוטיוב עצמו</span></header>${d.trends.length ? `<ul class="factlist">${d.trends.map((x) => `<li>${accDot(x.account_id)} ${x.status === 'kept' ? '<span class="chip ok">נכנס לניסיון</span>' : '<span class="chip ghost">נדחה</span>'} <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${k(x.views)} צפיות ${icon('ext')}</a>${x.card?.hookShape ? ` <b>${esc(x.card.hookShape)}</b>` : ''}<div class="muted small">${esc(x.why || x.card?.why || '')}</div></li>`).join('')}</ul>` : '<p class="muted">עוד לא נבדק. עם YOUTUBE_API_KEY המנוע מחפש פעם בשבוע שורטס שעובדים בנישה של כל חשבון, לומד מהם את הפורמט בלבד, ומכניס אותו לניסיון.</p>'}</section>`;
  const blocks = blocksPanel(d.blocks);
  const fold = (id, ic, label, inner) => `<details class="more" id="${id}"><summary class="btn sm">${icon(ic)}${label}</summary><div class="more-in">${inner}</div></details>`;
  const body = `<div class="head"><h1>תוצאות</h1><span class="sub">30 הימים האחרונים</span></div>
${d.demo ? `<div class="banner info">${icon('alert')}<div><b>נתוני הדגמה בדויים.</b><p>המספרים בדף הזה נזרעו לחשבון הדמו כדי להראות איך הדף נראה. מספרים אמיתיים מגיעים מהפלטפורמות, 72 שעות אחרי פרסום.</p></div></div>` : ''}
${kpis}
${measured.length ? `<div class="cols even charts"><section class="panel"><header><h2>צפיות לפי יום הפרסום</h2></header>${viewsChart(measured)}</section><section class="panel"><header><h2>מול החציון</h2></header>${d.scored.length ? relChart(d.scored) : '<p class="muted">עוד אין פוסט עם ציון: הציון נקבע 72 שעות אחרי הפרסום.</p>'}</section></div>` : ''}
${posts}
${feedbackPanels(d.feedback || [])}
${styleTestPanels(d.styleTests || [])}
<div class="mores">${fold('formats', 'results', 'פורמטים', formats)}${blocks ? fold('blocks-fold', 'alert', 'מה חוסם פוסטים', blocks) : ''}</div>`;
  return layout({ ...ctx, title: 'תוצאות', active: 'results' }, body);
}

/* ------------------------------------------------------------ topics (src/topics) */

const ORIGIN_HE = { bank: 'מהבנק', wikipedia: 'ויקיפדיה', youtube: 'יוטיוב' };
const TOPIC_STATUS = { new: ['ממתין לציון', 'ghost'], ready: ['בתור', 'sig'], low: ['מתחת ל-6', 'ghost'], used: ['נכתב פוסט', 'ok'], unsupported: ['אין מקור', 'warn'], skipped: ['לא הסתדר', 'warn'] };

/** A topic's score: the number, and its five parts as short bars. */
export function topicScore(t) {
  if (t.score == null) return '<span class="tscore none" title="עוד לא קיבל ציון">–</span>';
  const parts = t.parts || {};
  return `<span class="tscore${t.score >= PASS_TOPIC ? ' ok' : ''}" dir="ltr" title="${esc(parts.why || '')}"><b class="num">${t.score}</b><small>/10</small></span>
<ul class="tparts" aria-label="פירוט הציון">${TOPIC_PARTS.map(([k, he]) => `<li><span>${he}</span><span class="vbar" aria-hidden="true">${parts[k] ? `<i class="w${parts[k]}"></i>` : ''}</span><b class="num">${parts[k] ?? 0}</b></li>`).join('')}</ul>`;
}

function topicRow(ctx, t, { remove = false } = {}) {
  const [st, cls] = TOPIC_STATUS[t.status] || [t.status, ''];
  return `<li class="topic"><div class="tmain"><div class="meta p0"><span class="chip ghost">${esc(ORIGIN_HE[t.origin] || t.origin)}</span><span class="chip ${cls}">${esc(st)}</span>${t.post_id ? `<a class="small" href="/post/${esc(t.post_id)}">לפוסט</a>` : ''}</div>
<b>${esc(t.angle || t.title)}</b>${t.angle && t.angle !== t.title ? `<div class="muted small">${esc(t.title)}</div>` : ''}
${t.why ? `<div class="small">${esc(t.why)}</div>` : ''}${t.parts?.why ? `<div class="muted small">${esc(t.parts.why)}</div>` : ''}${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ''}
${t.url ? `<a class="small" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${t.origin === 'bank' ? 'איפה זה הפך ויראלי' : 'המקור של הסימן'} ${icon('ext')}</a>` : ''}
${remove ? postButton(ctx, '/topics/remove', 'הסרה', { cls: 'btn ghost sm', fields: { account: t.account_id, id: t.id } }) : ''}</div>
<div class="tside">${topicScore(t)}</div></li>`;
}

export function topicsPage(ctx, { current, topics, pass, watch, queries, youtube, live, form = {}, problems = [] }) {
  const next = topics.filter((t) => (t.origin === 'bank' ? ['new', 'ready', 'low'].includes(t.status) : t.status === 'ready') && (!t.expires_at || t.expires_at > new Date().toISOString()));
  const used = topics.filter((t) => t.status === 'used');
  const out = topics.filter((t) => !next.includes(t) && !used.includes(t));
  const q = [...(queries.he || []), ...(queries.en || [])];
  const body = `<div class="head"><h1>נושאים</h1><span class="sub">מה כדאי לספר, לפני שמחפשים במקורות</span><span class="end"><a class="btn sm" href="/sources">${icon('sources')}מקורות</a></span></div>
<p class="lede">כל פוסט מתחיל מנושא: קודם מהבנק שלך, אחר כך ממה שאנשים קוראים ורואים השבוע. כל נושא מקבל ציון של 0 עד 10 על כמה הוא עוצר גלילה, ונושא מתחת ל-${pass} לא נכתב. רק אחרי שנבחר נושא מחפשים לו עובדות במקורות המאושרים, ונושא שאף מקור לא תומך בו נשאר בצד.</p>
<section class="panel" id="bank"><header><h2>להוסיף לבנק</h2><span class="end muted small">נושאים שכבר ראיתם שעובדים. הם הראשונים בתור.</span></header>
${problems.length ? `<div class="problems"><b>לא נשמר:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/topics/add" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">
<label class="f">הנושא<input type="text" name="title" value="${esc(form.title || '')}" maxlength="300" required placeholder="למשל: השחקן שסירב לחוזה של 100 מיליון"></label>
<label class="f">למה זה הפך ויראלי<textarea name="why" maxlength="600" placeholder="מה גרם לאנשים לעצור ולשתף">${esc(form.why || '')}</textarea></label>
<label class="f">קישור <small>איפה זה עבד. הוא לא משמש כמקור לעובדות.</small><input type="url" name="url" value="${esc(form.url || '')}" dir="ltr" placeholder="https://"></label>
<div><button class="btn primary" type="submit">${icon('plus')}להוסיף לבנק</button></div></form></section>
<section class="panel"><header><h2>הבאים בתור</h2><span class="end muted small">${next.length}</span></header>
${next.length ? `<ul class="topics">${next.map((t) => topicRow(ctx, t, { remove: t.origin === 'bank' })).join('')}</ul>` : '<p class="muted">אין נושא בתור. הוסיפו לבנק, או חכו לסימנים של מחר. בינתיים הפוסטים נכתבים מהמסמכים של היום.</p>'}</section>
${used.length ? `<details class="panel"><summary><h2 class="inline">כבר נכתבו <span class="muted small">${used.length}</span></h2></summary><ul class="topics">${used.map((t) => topicRow(ctx, t)).join('')}</ul></details>` : ''}
${out.length ? `<details class="panel"><summary><h2 class="inline">נשארו בצד <span class="muted small">${out.length}</span></h2></summary><ul class="topics">${out.map((t) => topicRow(ctx, t, { remove: t.origin === 'bank' && t.status !== 'removed' })).join('')}</ul></details>` : ''}
<section class="panel" id="watch"><header><h2>מאיפה מגיעים הסימנים</h2></header>
<p class="muted">פעם ביום תדר בודק כמה קוראים את הדפים בוויקיפדיה של השמות כאן, ונושא נוצר כשקוראים אחד מהם השבוע פי 1.5 לפחות מבחודש שלפני. ${youtube ? 'הוא גם בודק אילו שורטס נצפו הכי הרבה בשבועיים האחרונים בחיפושים של החשבון' : 'יוטיוב עוד לא מחובר, אז שורטס לא נבדקים'}${q.length && youtube ? `: ${q.map((x) => `<span class="chip ghost">${esc(x)}</span>`).join(' ')}` : '.'}${live ? '' : ' (בהדגמה הסימנים לא נבדקים: רק הבנק פעיל.)'}</p>
<form method="post" action="/topics/watch" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">
<label class="f">שמות למעקב <small>שחקנים, קבוצות, חברות: שם אחד בשורה, כמו בכותרת של הדף בוויקיפדיה. שם בעברית נבדק בוויקיפדיה העברית.</small><textarea name="names" rows="6" dir="auto">${esc(watch.join('\n'))}</textarea></label>
<div><button class="btn" type="submit">שמירה</button></div></form></section>`;
  return layout({ ...ctx, title: 'נושאים', active: 'topics' }, body);
}

/** The post page's account of where its topic came from, and how it scored. */
export function topicPanel(t) {
  if (!t) return '';
  return `<section class="panel"><header><h2>הנושא</h2><span class="end"><span class="chip ghost">${esc(ORIGIN_HE[t.origin] || t.origin)}</span></span></header>
<ul class="topics"><li class="topic"><div class="tmain"><b>${esc(t.angle || t.title)}</b>${t.angle && t.angle !== t.title ? `<div class="muted small">${esc(t.title)}</div>` : ''}${t.why ? `<div class="small">${esc(t.why)}</div>` : ''}${t.parts?.why ? `<div class="muted small">${esc(t.parts.why)}</div>` : ''}${t.url ? `<a class="small" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${t.origin === 'bank' ? 'איפה זה הפך ויראלי' : 'המקור של הסימן'} ${icon('ext')}</a>` : ''}</div><div class="tside">${topicScore(t)}</div></li></ul></section>`;
}

/* ------------------------------------------------------------ sources */

const SOURCE_STATUS = { approved: ['מאושר', 'ok'], pending: ['ממתין לאישור', 'warn'], removed: ['הוסר', 'ghost'] };
const TYPE_HE = { rss: 'פיד', web: 'דף', api: 'נתונים' };

export function sourcesPage(ctx, { packs, current, sources, form = {}, problems = [] }) {
  // The switcher at the top picks the account; tabs only when a page is given more than one.
  const tabs = packs.length < 2 ? '' : `<nav class="tabs" aria-label="חשבונות">${packs.map((p) => `<a href="/sources?account=${esc(p.id)}"${p.id === current.id ? ' aria-current="true"' : ''}>${accDot(p.id)}${esc(p.meta.displayName)}</a>`).join('')}</nav>`;
  const list = sources
    .map((s) => {
      const [he, cls] = SOURCE_STATUS[s.status] || [s.status, ''];
      return `<article class="card acc acc-${esc(current.id)} srccard"><div class="meta p0"><span class="chip ${cls}">${esc(he)}</span><span class="chip ghost">${esc(TYPE_HE[s.type] || s.type)}</span>${s.score ? `<span class="chip sig" title="${esc(s.score.reason || '')}">סמכות ${esc(s.score.authority)}/10</span>` : ''}<span class="end muted small">${s.docs} מסמכים</span></div>
<h3 class="srcname" dir="auto">${esc(s.name)}</h3><a class="small ltr" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a>
<p class="muted small m6" dir="auto">${esc(s.why || '')}</p>
<p class="muted small m4">${s.approved_at ? `אושר ${esc(shortDate(s.approved_at))}` : ''}${s.last_ok_at ? ` · נקרא ${esc(stamp(s.last_ok_at))}` : ''}${s.last_error ? ` · <span class="chip bad">${ctx.operator ? esc(s.last_error.slice(0, 80)) : 'הקריאה האחרונה לא הצליחה'}</span>` : ''}</p>
<div class="actions pt10 p0x">${s.status !== 'approved' ? postButton(ctx, `/sources/${s.id}/approve`, 'אישור', { cls: 'btn sm primary' }) : ''}${s.status !== 'removed' ? postButton(ctx, `/sources/${s.id}/remove`, 'הסרה', { cls: 'btn sm danger', confirm: 'להסיר את המקור?' }) : ''}</div></article>`;
    })
    .join('');
  const body = `<div class="head"><h1>מקורות</h1><span class="sub">רק מקור מאושר יכול לתמוך בעובדה</span><span class="end"><a class="btn sm" href="/topics">${icon('spark')}נושאים</a><a class="btn sm" href="/facts?account=${esc(current.id)}">${icon('shield')}עובדות שנבדקו ביד</a></span></div>
${tabs}
<p class="lede">עובדה בשקף חייבת ציטוט ממסמך של מקור מאושר של החשבון. מקור שמוסר כאן מפסיק לתמוך בכל פוסט שעוד לא פורסם, והפוסט ייחסם בבדיקה שלפני הפרסום.</p>
<div class="cols"><div class="grid12">${list || `<div class="empty"><b>אין מקורות</b></div>`}</div>
<section class="panel"><header><h2>הוספת מקור</h2></header>
${problems.length ? `<div class="problems"><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/sources/add" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">
<label class="f">שם<input type="text" name="name" required value="${esc(form.name || '')}"></label>
<label class="f">כתובת <small>https בלבד</small><input type="url" name="url" required dir="ltr" value="${esc(form.url || '')}"></label>
<label class="f">סוג<select name="type"><option value="rss">פיד חדשות</option><option value="web">דף באתר</option><option value="api">מקור נתונים</option></select></label>
<label class="f">למה סומכים עליו? <small>יופיע ליד כל עובדה ממנו</small><textarea name="why" required minlength="10">${esc(form.why || '')}</textarea></label>
<button class="btn primary" type="submit">${icon('plus')}להוסיף כמקור מאושר</button></form></section></div>
${catalogPanel(ctx, current, sources)}`;
  return layout({ ...ctx, title: 'מקורות', active: 'sources' }, body);
}

/**
 * Outlets to add in one tap, per niche, and the ones asked for that cannot be read, with why. The operator's alone: the
 * list is our own first niches' (football, MMA, startups), in English and with robots.txt's words, and a customer's
 * sources come from their account's setup and the form above (the owner, 2026-10-31: "mispar9 is about football only").
 */
function catalogPanel(ctx, current, sources) {
  if (!ctx.operator) return '';
  const have = new Set(sources.filter((s) => s.status === 'approved').map((s) => s.url));
  const niche = ([key, n]) => `<details class="facts"><summary>${esc(n.name)} <span class="chip ghost">${n.sources.length}</span><span class="chev">${icon('chev')}</span></summary>
<ul class="factlist">${n.sources
    .map((s) => `<li><b dir="auto">${esc(s.name)}</b> <span class="chip ghost">${s.lang === 'he' ? 'עברית' : 'אנגלית'}</span> ${have.has(s.url) ? '<span class="chip ok">כבר מקור</span>' : postButton(ctx, '/sources/catalog', `${icon('plus')}הוספה`, { cls: 'btn sm', fields: { account: current.id, niche: key, id: s.id } })}<div class="muted small" dir="auto">${esc(s.why)}</div></li>`)
    .join('')}</ul>
${n.refused.length ? `<p class="muted small">אי אפשר לקרוא אותם: ${n.refused.map(([name, why]) => `${esc(name)} (${esc(why)})`).join(' · ')}</p>` : ''}</details>`;
  return `<section class="panel mt16"><header><h2>מקורות מוכנים לפי נישה</h2></header>
<p class="muted">כל פיד כאן נבדק: האתר מרשה לנו לקרוא אותו ולכתוב מחדש את מה שהוא אומר. הבדיקה חוזרת בכל קריאה, וכתבות ארוכות וראיונות נקראים ראשונים.</p>
${Object.entries(CATALOG).map(niche).join('')}</section>`;
}

/* ------------------------------------------------------------ settings */

const VIA_HE = { zernio: 'Zernio', instagram: 'ישירות דרך Meta', dry: 'יבש (לדיסק)', auto: 'Meta, ובלעדיו Zernio', 'own-app': 'האפליקציה שלנו בטיקטוק' };
/** One platform's publisher, and why it is dry when the pack asked for more. */
function publisherHe({ wants, via }) {
  if (via === wants || wants === 'dry') return VIA_HE[via] || via;
  if (wants === 'auto' && via !== 'dry') return `${VIA_HE[via]} (אוטומטי)`;
  const why =
    process.env.PUBLISH_MODE !== 'live'
      ? 'PUBLISH_MODE לא live'
      : wants === 'zernio'
        ? 'חסר ZERNIO_API_KEY'
        : wants === 'own-app'
          ? 'עוד לא נבנתה'
          : wants === 'auto'
            ? 'אין אסימון של Meta ואין אינסטגרם מחובר ב-Zernio'
            : 'חסר אסימון או instagram.userId';
  return `${VIA_HE[via]} (מוגדר ל${VIA_HE[wants] === 'Zernio' ? '-Zernio' : `${VIA_HE[wants]}`}, ${why})`;
}

/**
 * The month's cost, for the operator to read: every account's total, and in developer mode what each account's post
 * costs. Nothing caps it; each account's plan (40 suggestions, 10 redos) is the limit (src/budget/quota.js).
 */
export function costsPanel(ctx, d, { dev = false } = {}) {
  const rows = d.costs
    .map((a) => `<tr><td class="title" data-k="">${accDot(a.id)} ${esc(a.name)}</td><td class="n" data-k="החודש">${usd(a.spent, 3)}</td><td class="n" data-k="לפוסט">${a.perPost == null ? '–' : usd(a.perPost, 3)}</td></tr>`)
    .join('');
  return `<section class="panel" id="costs"><header><h2>עלות החודש</h2><span class="end muted small ltr">${esc(d.month)}</span></header>
<div class="row spread"><span>כל החשבונות</span><b class="num">${usd(d.spend.usd)}</b></div>
<p class="muted small">אין תקרת הוצאה. כל לקוח מקבל את החבילה שלו בחודש (${DEFAULT_PLAN.suggested} הצעות ו-${DEFAULT_PLAN.redos} החלפות בחבילה המלאה), משותפת לכל החשבונות שלו, וזה מה שעוצר את הכתיבה. הסכום כאן רק לידיעה.</p>
${dev ? `<div class="scrollx mt12"><table class="table stack"><thead><tr><th>חשבון</th><th>החודש</th><th>לפוסט, 30 יום</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted small">לפוסט: כל הקריאות של 30 הימים האחרונים, גם של פוסטים שהבדיקות עצרו, חלקי הפוסטים שנכתבו. מופיע מהפוסט הרביעי.</p>` : ''}</section>`;
}

/**
 * Settings. Everyone: notifications and who is signed in; a customer, the month's plan (suggestions and redos). The
 * operator alone (the server's settings): when the day's posts are written, what the month cost, and the stop for
 * everything; and developer mode (keys, the engine, the publishers, the log), seven taps on the version line, kept
 * in a cookie on that browser (server.js). People and sign-in are accounts' (openfrequency-accounts).
 */
export function settingsPage(ctx, d) {
  const s = d.settings;
  const dev = !!ctx.dev;
  const devPanels = dev
    ? `<section class="panel dev" id="dev"><header><h2>מצב מפתח</h2><span class="end">${postButton(ctx, '/settings/dev', 'לכבות', { cls: 'btn sm', fields: { on: '0' } })}</span></header><p class="muted small m0">מפתחות, המנוע, הפרסום והיומן. נשאר פתוח בדפדפן הזה עד שמכבים.</p></section>
<div class="cols even">
<div>
<section class="panel"><header><h2>מפתחות</h2><span class="end muted small">הערכים עצמם לא מוצגים</span></header><ul class="keys">${d.keys.map((x) => `<li>${x.set ? `<span class="chip ok">${icon('check')}מוגדר</span>` : '<span class="chip ghost">חסר</span>'}<div><code>${esc(x.name)}</code><div class="muted small">${esc(x.he || x.what)}</div></div></li>`).join('')}</ul></section>
<section class="panel"><header><h2>מצב המנוע</h2></header><dl class="kv"><dt>מקורות וכתיבה</dt><dd>${d.mode === 'live' ? '<span class="chip ok">חי</span> מקורות אמיתיים ו-Claude' : '<span class="chip warn">הקלטות</span> עובד מהקלטות שמורות, בלי חיבור לרשת'}</dd>
<dt>מתג פרסום חי</dt><dd>${d.liveSwitch ? '<span class="chip ok">PUBLISH_MODE=live</span>' : '<span class="chip ghost">כבוי: הכל יבש</span>'}</dd>
${d.publishers.map((p) => `<dt>${esc(p.name)}</dt><dd>${p.platforms.map((x) => `${PLATFORM_HE[x.platform] || x.platform}: ${publisherHe(x)}`).join(' · ')}</dd>`).join('')}</dl></section>
${d.instagram.length ? `<section class="panel"><header><h2>אינסטגרם ישירות (Meta Graph API)</h2></header><ul class="factlist">${d.instagram.map((x) => `<li>${accDot(x.id)} <b>${esc(x.name)}</b> ${x.configured ? '<span class="chip ok">מחובר</span>' : `<span class="chip ghost">חסר ${!x.userId ? 'instagram.userId ב-pack.json' : `<code class="ltr">${esc(x.tokenEnv)}</code>`}</span>`} <span class="muted small">${x.auth === 'instagram' ? 'Instagram Login' : 'Facebook Login (עמוד פייסבוק)'}${x.daysLeft != null ? ` · האסימון בתוקף עוד ${x.daysLeft} ימים` : ''}</span></li>`).join('')}</ul><p class="muted small">בדיקה מלאה של האסימון, החשבון ונתוני ה-insights: <code class="ltr">npm run instagram:check</code></p></section>` : ''}
</div>
<div>
<section class="panel"><header><h2>יומן פעולות</h2></header><ol class="trace">${d.audit.map((a) => `<li class="ok"><b>${esc(AUDIT_HE[a.action] || a.action)}</b> <span class="muted small">${esc(a.actor)} · ${esc(stamp(a.at))}${a.account_id ? ` · ${esc(a.account_id)}` : ''}</span></li>`).join('')}</ol></section>
</div></div>`
    : '';
  const body = `<div class="head"><h1>הגדרות</h1></div>
<div class="cols even">
<div>
<section class="panel" id="push"><header><h2>התראות</h2><span class="end">${d.push?.browsers ? `<span class="chip ok">${d.push.browsers === 1 ? 'מכשיר אחד' : `${d.push.browsers} מכשירים`}</span>` : '<span class="chip ghost">כבוי</span>'}</span></header>
<p class="muted">פוסט שאישרתם נשלח מיד לטיוטות של טיקטוק, ובשעה שלו מגיעה התראה לפרסם אותו.</p>
<p class="muted small">באייפון: פתחו את תדר בספארי, שתפו ואז "הוסף למסך הבית", ופתחו את תדר מהאייקון. רק משם אפשר להפעיל התראות.</p>
<form method="post" action="/push/subscribe" data-ajax="reload" data-push="${esc(d.push?.key || '')}">${csrfField(ctx)}<input type="hidden" name="endpoint" value=""><button class="btn" type="button" data-push-enable>${icon('spark')}להפעיל התראות במכשיר הזה</button></form>
<form method="post" action="/push/unsubscribe" data-ajax="reload" data-push-off hidden>${csrfField(ctx)}<input type="hidden" name="endpoint" value=""><button class="btn ghost" type="button" data-push-disable>לכבות התראות במכשיר הזה</button></form>
</section>
${d.schedule ? schedulePanel(ctx, d.schedule) : ''}
${d.email ? emailPanel(ctx, d.email) : ''}
${d.assistant ? assistantPanel(ctx, d.assistant) : ''}
${ctx.operator ? `<section class="panel"><header><h2>מתי נכתבים הפוסטים</h2></header><p class="muted">כל יום בשעה הזו תדר כותב את הפוסטים של היום ושולח אותם לאישור.</p><form method="post" action="/settings/generate-at" class="formgrid">${csrfField(ctx)}<label class="f">שעה<input type="time" name="at" value="${esc(s.generateAt)}" dir="ltr"></label><button class="btn" type="submit">שמירה</button></form></section>` : ''}
</div>
<div>
${ctx.operator ? costsPanel(ctx, d, { dev }) : planPanel(d.plans)}
${d.quotas ? quotasPanel(ctx, d.quotas) : ''}
${ctx.operator ? `<section class="panel"><header><h2>דמואים לחנויות</h2><a class="end" href="/demos">לרשימה</a></header><p class="muted m0">חנויות שביקשו באתר דמו של תדר, ומה מחכה לבדיקה שלכם.</p></section>` : ''}
<section class="panel"><header><h2>החשבון שלך</h2></header><p class="muted m0">נכנסתם בתור <b class="ltr">${esc(ctx.user?.email || '')}</b>${ctx.operator ? ', ורואים את החשבונות של כל הלקוחות.' : `, בחשבון <b>${esc(ctx.workspace?.name || '')}</b>.`}</p><div class="actions p0 mt12"><a class="btn" href="${esc(ctx.links?.logout || '#')}">${icon('logout')}יציאה</a></div></section>
${ctx.operator ? `<section class="panel"><header><h2>עצירת חירום</h2><span class="end">${s.globalKill ? '<span class="chip bad">הכל עצור</span>' : ''}</span></header>
<p class="muted">עוצר את כל החשבונות מיד. אף פוסט לא נכתב ולא מתפרסם עד שמפעילים מחדש.</p>
${s.globalKill ? postButton(ctx, '/settings/kill', 'להפעיל הכל מחדש', { cls: 'btn primary', fields: { on: '0' } }) : postButton(ctx, '/settings/kill', `${icon('power')}לעצור הכל`, { cls: 'btn danger', fields: { on: '1' }, confirm: 'לחצו שוב כדי לעצור הכל' })}
</section>` : ''}
</div></div>
${devPanels}
${dev ? '' : `<form method="post" action="/settings/dev" class="ver"${ctx.operator ? ' data-devtap' : ''}>${csrfField(ctx)}<input type="hidden" name="on" value="1"><span>תדר · גרסה ${esc(VERSION)}</span></form>`}`;
  return layout({ ...ctx, title: 'הגדרות', active: 'settings' }, body);
}

/** Which emails the workspace's owners get (src/notify/email.js). Accounts sends them, to the account's owners. */
function emailPanel(ctx, prefs) {
  const box = (k) => `<label class="check"><input type="checkbox" name="em_${esc(k)}" value="1"${prefs[k] ? ' checked' : ''}> ${esc(EMAIL_HE[k])}</label>`;
  return `<section class="panel" id="email"><header><h2>מיילים</h2></header>
<p class="muted">תדר שולח מייל לבעלי החשבון רק על מה שמסומן כאן.</p>
<form method="post" action="/settings/email" class="prefs">${csrfField(ctx)}
<fieldset><legend>מה לשלוח</legend>${Object.keys(EMAIL_HE).map(box).join('')}</fieldset>
<button class="btn" type="submit">שמירה</button></form></section>`;
}

/** The customer's choices for the WhatsApp assistant: which messages reach them, and their quiet hours. */
function assistantPanel(ctx, a) {
  const box = (name, on, label) => `<label class="check"><input type="checkbox" name="${esc(name)}" value="1"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  return `<section class="panel" id="whatsapp"><header><h2>הודעות בוואטסאפ</h2></header>
<p class="muted">העוזר של OpenFrequency בוואטסאפ שולח לכם רק את ההודעות שמסומנות כאן.</p>
<form method="post" action="/settings/whatsapp" class="prefs">${csrfField(ctx)}
<fieldset><legend>מה לשלוח</legend>${Object.entries(EVENT_HE).map(([k, he]) => box(`ev_${k}`, a.events[k], he)).join('')}</fieldset>
<fieldset><legend>שעות שקטות</legend>${box('quiet_nights', a.quiet.nights, 'לא לשלוח בין 22:00 ל-8:00')}${box('quiet_shabbat', a.quiet.shabbat, 'לא לשלוח בשבת ובחג')}
<p class="muted small m0">מה שקורה בשעות האלה מגיע אליכם כשהן נגמרות. תזכורת שהזמן שלה כבר עבר לא נשלחת.</p></fieldset>
<button class="btn" type="submit">שמירה</button></form></section>`;
}

const LEDGER_COLS = [
  ['suggestion', 'הצעות'],
  ['redo', 'החלפות'],
  ['retry', 'נחסמו אצלנו'],
  ['edit', 'בדיקת עריכות'],
];

/** One month of every account: the plan used, what it cost, and what the money went to. */
function ledgerTable(rows, month) {
  const body = rows
    .map(({ pack, usage: u, ledgers, zernio = {} }) => {
      const l = ledgers.find((x) => x.month === month);
      const z = zernio[month];
      const by = Object.fromEntries(l.rows.map((r) => [r.kind, r]));
      const other = ['account', 'drafting', 'sample'].reduce((a, k2) => a + (by[k2]?.usd || 0), 0);
      const now = u.month === month;
      // A month the workspace's accounts share: this account's count, then the workspace's of its plan.
      const mine = (k, part) => (u.shared ? `${u.accounts[pack.id]?.[k] ?? 0} <span class="muted small">(${part.used}/${part.limit} ללקוח)</span>` : `${part.used}/${part.limit}`);
      return `<tr><td class="title" data-k="">${accDot(pack.id)} ${esc(pack.meta.displayName)}</td>${now ? `<td class="n" data-k="הצעות">${mine('suggested', u.suggested)}</td><td class="n" data-k="החלפות">${mine('redos', u.redos)}</td><td class="n" data-k="עלות">${usd(l.total)}</td>` : `<td class="n" data-k="הצעות">${by.suggestion?.posts ?? 0}</td><td class="n" data-k="החלפות">${by.redo?.posts ?? 0}</td><td class="n" data-k="עלות">${usd(l.total)}</td>`}<td class="n" data-k="Zernio">${z ? usd(z.usd) : '–'}</td>${LEDGER_COLS.map(([k2, he]) => `<td class="n" data-k="${esc(he)}">${usd(by[k2]?.usd || 0, 3)}${by[k2]?.posts != null && k2 !== 'edit' ? ` <span class="muted small">(${by[k2].posts})</span>` : ''}</td>`).join('')}<td class="n" data-k="אחר">${usd(other, 3)}</td><td class="n" data-k="לפוסט שהגיע">${l.perDelivered == null ? '–' : usd(l.perDelivered, 3)}</td></tr>`;
    })
    .join('');
  return `<div class="scrollx mt12"><table class="table stack"><thead><tr><th>חשבון</th><th>הצעות</th><th>החלפות</th><th>עלות</th><th>Zernio</th>${LEDGER_COLS.map(([, he]) => `<th>${esc(he)}</th>`).join('')}<th>אחר</th><th>לפוסט שהגיע</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * The operator's view of every customer's month (src/budget/quota.js): the plan used, what it cost, the
 * ledger by what the money went to, and the form that sets each account's plan.
 */
export function quotasPanel(ctx, q) {
  const [month, ...before] = q.months;
  const forms = q.accounts
    .map(({ pack, usage: u }) => {
      // A customer's month is their workspace's plan, from accounts: changed there (the subscription's plan), not here.
      if (u.plan.scope === 'workspace') return `<p class="mt12"><b>${accDot(pack.id)} ${esc(pack.meta.displayName)}</b> <span class="muted small">החבילה של הלקוח (סביבת עבודה ${esc(u.plan.workspaceId)}) מגיעה מ-accounts: ${esc(PLAN_HE[u.plan.name] || u.plan.name)}, ${u.plan.suggested} הצעות ו-${u.plan.redos} החלפות בחודש${u.shared ? ', משותפות לכל החשבונות של הלקוח' : ''}. משנים אותה במנוי שלו ב-accounts.</span></p>`;
      const set = u.plan.set;
      const val = (on, v) => (on ? ` value="${esc(v)}"` : '');
      return `<form method="post" action="/accounts/${esc(pack.id)}/quota" class="formgrid mt12">${csrfField(ctx)}<b>${accDot(pack.id)} ${esc(pack.meta.displayName)}</b>
<label class="f">הצעות בחודש<input type="number" name="suggested" min="0" max="${MAX_PLAN.suggested}" step="1" placeholder="${DEFAULT_PLAN.suggested}"${val(set.suggested, u.plan.suggested)}></label>
<label class="f">החלפות בחודש<input type="number" name="redos" min="0" max="${MAX_PLAN.redos}" step="1" placeholder="${DEFAULT_PLAN.redos}"${val(set.redos, u.plan.redos)}></label>
<button class="btn" type="submit">שמירה</button></form>`;
    })
    .join('');
  return `<section class="panel" id="quotas"><header><h2>מכסות ועלות לפי לקוח</h2><span class="end muted small ltr">${esc(month)}</span></header>
<p class="muted small m0">הצעה היא פוסט שעבר את כל הבדיקות והגיע ללקוח, גם אם דחה אותו או שפג תוקפו. פוסט שנחסם אצלנו, וכל תיקון בתוך פוסט, על חשבוננו. בסוגריים: כמה פוסטים. בעמודת Zernio: כמה Zernio גובה על הפרופיל של החשבון, לפי החשבונית שלו. זה מנוי, והוא מתעדכן פעם ביום.</p>
${ledgerTable(q.accounts, month)}
${before.length ? `<details class="mt12"><summary class="muted">החודשים הקודמים</summary>${before.map((m) => `<h3 class="lbl ltr">${esc(m)}</h3>${ledgerTable(q.accounts, m)}`).join('')}</details>` : ''}
<details class="mt12"><summary class="muted">לשנות מכסה</summary><p class="muted small">מכסה משנים כאן רק לחשבונות שלנו, שאינם בסביבת עבודה של לקוח. שדה ריק חוזר לברירת המחדל: ${DEFAULT_PLAN.suggested} הצעות ו-${DEFAULT_PLAN.redos} החלפות בחודש. חשבון שניצל את ההצעות שלו לא נכתב עד תחילת החודש הבא, או עד שמעלים לו את המכסה.</p>${forms}</details></section>`;
}

export function morePage(ctx) {
  const row = (href, ic, t, sub) => `<a href="${href}"><span class="ico">${icon(ic)}</span><span class="t"><b>${t}</b><small>${sub}</small></span><span class="go">${icon('chev')}</span></a>`;
  const body = `<div class="head"><h1>עוד</h1></div><nav class="list" aria-label="עוד">
${row('/new', 'plus', 'חשבון חדש', 'ממקור ועד חמישה פוסטים לדוגמה')}
${row('/settings', 'settings', 'הגדרות', ctx.operator ? 'כיבוי כללי, מכסות, מפתחות' : 'התראות, החבילה החודשית, החשבון שלך')}
${ctx.operator ? row('/demos', 'accounts', 'דמואים לחנויות', 'חנויות שביקשו דמו באתר') : ''}
<a class="danger" href="${esc(ctx.links?.logout || '#')}"><span class="ico">${icon('logout')}</span><span class="t"><b>יציאה</b></span></a></nav>`;
  return layout({ ...ctx, title: 'עוד', active: 'more' }, body);
}

/**
 * What a session that accounts did not let in sees, when sending it to the login would not help (server.js): the
 * workspace is closed, Teder is not in its plan, or the check itself failed. No redirect, so no loop.
 */
export const GATE = {
  closed: { title: 'החשבון סגור', text: 'החשבון הזה סגור, ואי אפשר להיכנס דרכו לתדר.' },
  not_in_plan: { title: 'תדר לא מופעל בחשבון שלכם', text: 'החשבון שלכם פתוח, אבל תדר לא כלול בו.' },
  error: { title: 'אי אפשר לבדוק כרגע מי נכנס', text: 'שירות הכניסה לא ענה. נסו שוב בעוד דקה.' },
  // The paywall (src/billing/entitlement.js): signed in, but the workspace has not paid for Teder. How to pay is
  // accounts' to say (its /setup page), whichever way it takes payment, so this says only what is true either way.
  unpaid: { title: 'תדר מחכה לתשלום', text: 'תדר נפתח אחרי שהתשלום מגיע אלינו. בחשבון שלכם כתוב איך משלמים. המצגות, המקורות וההגדרות שלכם נשמרים כמו שהם.' },
};

export function gatePage({ kind, links, v = 1 }) {
  const g = GATE[kind] || GATE.error;
  const actions =
    kind === 'error'
      ? '<a class="btn primary" href="">לנסות שוב</a>'
      : kind === 'unpaid'
        ? `<a class="btn primary" href="${esc(links.setup)}">איך משלמים</a><a class="btn" href="${esc(links.logout)}">יציאה</a>`
      : kind === 'not_in_plan'
        ? `<a class="btn primary" href="${esc(links.home)}">לחשבון שלכם</a><a class="btn" href="${esc(links.logout)}">יציאה</a>`
        : `<a class="btn" href="${esc(links.logout)}">יציאה</a>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#eeeff2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#111113" media="(prefers-color-scheme: dark)"><title>${esc(g.title)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"><link rel="icon" href="/static/icon.svg?v=${v}" type="image/svg+xml"><link rel="apple-touch-icon" href="/static/icon-180.png?v=${v}"><link rel="manifest" href="/static/manifest.webmanifest"></head>
<body class="login"><main class="card">
<div class="hero">${tederMark()}<b>תדר</b></div>
<h1 class="err" role="alert">${esc(g.title)}</h1>
<p>${esc(g.text)}</p>
<div class="links">${actions}</div><p class="a11y-foot">${a11yLink()}</p></main></body></html>`;
}

/**
 * A page for a request that could not be answered (a stale form, a view-only session, something broken on our side):
 * Hebrew, in the site's look, with the way back. It stands alone, since it may answer before a session is known; the
 * error's own words go to the log, never here, unless it is an ActionError, whose message is the customer's.
 */
export const ERROR_HE = {
  stale: { title: 'הדף ישן', text: 'הדף היה פתוח הרבה זמן. רעננו אותו ונסו שוב.' },
  read_only: { title: 'זו צפייה בלבד', text: 'אפשר לראות כאן הכל, אבל שום שינוי לא נשמר.' },
  no_action: { title: 'אין פעולה כזו', text: 'הכפתור הזה לא עושה כלום אצלנו. אולי הדף ישן: רעננו אותו ונסו שוב.' },
  method: { title: 'הבקשה לא נתמכת', text: 'את הדף הזה פותחים מהקישורים באתר.' },
  broken: { title: 'משהו השתבש אצלנו', text: 'נסו שוב בעוד כמה דקות. אם זה חוזר, כתבו לנו ונבדוק.' },
};

export function errorPage({ kind = 'broken', text = null, back = '/', v = 1 }) {
  const g = ERROR_HE[kind] || ERROR_HE.broken;
  const links = `${back && back !== '/' ? `<a class="btn primary" href="${esc(back)}">חזרה לדף הקודם</a>` : ''}<a class="btn${back && back !== '/' ? '' : ' primary'}" href="/">לדף הבית</a>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(g.title)} · תדר</title><link rel="stylesheet" href="/static/style.css?v=${v}"><link rel="icon" href="/static/icon.svg?v=${v}" type="image/svg+xml"></head>
<body class="login"><main class="card">
<div class="hero">${tederMark()}<b>תדר</b></div>
<h1 class="err" role="alert">${esc(g.title)}</h1>
<p>${withSupport(text || g.text)}</p>
<div class="links">${links}</div></main></body></html>`;
}

export function notFoundPage(ctx) {
  return layout({ ...ctx, title: 'לא נמצא', active: '' }, `<div class="empty mt30">${icon('alert')}<b>הדף לא נמצא</b><a href="/">חזרה להיום</a></div>`);
}

/* ------------------------------------------------------------ hand-checked facts */

const FACT_STATE = { valid: ['בתוקף', 'ok'], soon: ['פג בקרוב', 'warn'], expired: ['פג: לא בשימוש', 'bad'] };

export function factsPage(ctx, { packs, current, topics, today, nextYear, form = {}, problems = [] }) {
  const tabs = packs.length < 2 ? '' : `<nav class="tabs" aria-label="חשבונות">${packs.map((p) => `<a href="/facts?account=${esc(p.id)}"${p.id === current.id ? ' aria-current="true"' : ''}>${accDot(p.id)}${esc(p.meta.displayName)}</a>`).join('')}</nav>`;
  const list = topics
    .map(
      (t) => `<section class="panel"><header><h2 dir="auto">${esc(t.topic)}</h2><span class="end muted small">${t.facts.length} עובדות</span></header>${t.facts.length ? `<ul class="factlist">${t.facts
        .map((f) => {
          const [he, cls] = FACT_STATE[f.state] || [f.state, ''];
          return `<li><div class="meta p0"><span class="chip ${cls}">${esc(he)}</span>${f.checkedBy === 'claude' ? '<span class="chip warn" title="הועתק מהעמוד, עוד לא נבדק על ידיך">נבדק על ידי Claude</span>' : ''}<span class="end muted small">${t.owner ? `נכתב ${esc(f.checkedAt)}` : `נבדק ${esc(f.checkedAt)} · עד ${esc(f.expires)}`}</span></div>
<blockquote dir="auto">${esc(f.quote)}</blockquote><a class="small" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" dir="auto">${esc(f.source)}</a>${f.note ? `<p class="muted small m4" dir="auto">${esc(f.note)}</p>` : ''}
${f.problems.length ? `<div class="problems"><ul>${f.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<div class="actions pt10 p0x"><form method="post" action="/facts/confirm" class="inline">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}"><input type="hidden" name="topic" value="${esc(t.topic)}"><input type="hidden" name="id" value="${esc(f.id)}"><label class="small">בתוקף עד <input type="date" name="expires" value="${esc(f.expires > today ? f.expires : nextYear)}" dir="ltr"></label><button class="btn sm primary" type="submit">${icon('check')}בדקתי שוב היום</button></form>${postButton(ctx, '/facts/remove', 'הסרה', { cls: 'btn sm danger', confirm: 'להסיר את העובדה?', fields: { account: current.id, topic: t.topic, id: f.id } })}</div></li>`;
        })
        .join('')}</ul>` : '<p class="muted">אין עובדות בנושא הזה.</p>'}</section>`
    )
    .join('');
  const body = `<div class="head"><h1>עובדות שנבדקו ביד</h1><span class="sub">מה שקראתם באתר שהמנוע לא קורא</span></div>
${tabs}
<p class="lede">חלק מהאתרים הרשמיים (כל זכות, gov.il) חוסמים קוראים אוטומטיים, והמנוע לא עוקף את זה. כאן אתם כותבים עובדה שקראתם בעצמכם: המשפט מילה במילה, העמוד, היום שבדקתם, ועד מתי היא בתוקף. אחרי תאריך התפוגה העובדה לא משמשת אף פוסט עד שתבדקו אותה שוב, ופוסט שנכתב ממנה ועוד לא פורסם ייחסם.</p>
<div class="cols"><div>${list || '<div class="empty"><b>עוד אין עובדות לחשבון הזה</b>העובדה הראשונה שתוסיפו תופיע כאן.</div>'}</div>
<section class="panel"><header><h2>עובדה חדשה</h2></header>
${problems.length ? `<div class="problems"><ul>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/facts/add" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">
<label class="f">נושא <small>עובדות באותו נושא נכתבות יחד לפוסט אחד</small><input type="text" name="topic" required maxlength="60" list="topics" value="${esc(form.topic || '')}"><datalist id="topics">${topics.map((t) => `<option value="${esc(t.topic)}">`).join('')}</datalist></label>
<label class="f">המשפט, מילה במילה <small>4 עד 40 מילים, בדיוק כמו בעמוד, בלי שלוש נקודות</small><textarea name="quote" required rows="3">${esc(form.quote || '')}</textarea></label>
<label class="f">שם המקור<input type="text" name="source" required maxlength="80" value="${esc(form.source || '')}" placeholder="כל זכות"></label>
<label class="f">כתובת העמוד<input type="url" name="url" required dir="ltr" value="${esc(form.url || '')}"></label>
<label class="f">נבדק ב<input type="date" name="checkedAt" required dir="ltr" value="${esc(form.checkedAt || today)}"></label>
<label class="f">בתוקף עד <small>אחרי התאריך הזה היא לא בשימוש עד שתבדקו שוב. אפשר עד שנתיים קדימה</small><input type="date" name="expires" required dir="ltr" value="${esc(form.expires || nextYear)}"></label>
<label class="f">הערה <small>לא חובה</small><input type="text" name="note" maxlength="200" value="${esc(form.note || '')}"></label>
<button class="btn primary" type="submit">${icon('plus')}להוסיף עובדה</button></form></section>
<section class="panel"><header><h2>הסיפור שלכם</h2></header>
<p class="muted small">מה שקרה לכם בעסק, במילים שלכם: טעות שעשיתם, מספר מהשנה הראשונה, משהו שאף אחד לא סיפר לכם לפני שפתחתם. הסליידשואו של עסקים קטנים שהכי מתפשטים בטיקטוק הם בדיוק זה, על התמונות שלכם. החשבון כותב בגוף ראשון רק ממה שכתבתם כאן.</p>
<form method="post" action="/facts/add" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}"><input type="hidden" name="owner" value="1">
<label class="f">נושא<input type="text" name="topic" required maxlength="60" placeholder="השנה הראשונה" value=""></label>
<label class="f">מה קרה <small>משפט אחד, 4 עד 40 מילים, עם המספר אם יש</small><textarea name="quote" required rows="3" placeholder="מכרנו ב-100 אלף שקל בשנה הראשונה ועדיין הפסדנו כסף"></textarea></label>
<button class="btn primary" type="submit">${icon('plus')}להוסיף לסיפור</button></form></section></div>`;
  return layout({ ...ctx, title: 'עובדות שנבדקו ביד', active: 'sources' }, body);
}

/* ------------------------------------------------------------ rivals, typed in by hand */

const RIVAL_STATE = { fresh: null, stale: ['כדאי להציץ שוב', 'warn'], dropped: ['ישן: לא בשימוש', 'bad'] };
const agoHe = (d) => (d <= 0 ? 'היום' : d === 1 ? 'אתמול' : `לפני ${d} ימים`);

/** The rival form: a new rival, or the one `r` is (its fields prefilled). */
function rivalForm(ctx, current, r = {}, { id = null, submit = 'להוסיף מתחרה' } = {}) {
  const v = (x) => (Array.isArray(x) ? x.join('\n') : x || '');
  return `<form method="post" action="/rivals/save" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">${id ? `<input type="hidden" name="id" value="${esc(id)}">` : ''}
<label class="f">שם משתמש<input type="text" name="handle" required maxlength="40" dir="ltr" autocapitalize="off" spellcheck="false" placeholder="@" value="${esc(r.handle || '')}"></label>
<label class="f">פלטפורמה<select name="platform">${['tiktok', 'instagram'].map((x) => `<option value="${x}"${(r.platform || 'tiktok') === x ? ' selected' : ''}>${PLATFORM_HE[x]}</option>`).join('')}</select></label>
<label class="f">שורות השער שעבדו להם הכי טוב <small>שורה לכל אחת, עד ${RIVALS.hooks}, כמו שהן כתובות</small><textarea name="hooks" required rows="4" dir="auto">${esc(v(r.hooks))}</textarea></label>
<label class="f">הפורמטים שלהם <small>שורה לכל אחד: "דירוג 5 עד 1", "סיפור בשקפים"</small><textarea name="formats" rows="2" dir="auto">${esc(v(r.formats))}</textarea></label>
<label class="f">שעות פרסום <small><bdi dir="ltr">18:30, 21:00</bdi></small><input type="text" name="times" dir="ltr" value="${esc(Array.isArray(r.times) ? r.times.join(', ') : r.times || '')}"></label>
<label class="f">מה הם לא נותנים <small>הנושאים והזוויות שהקהל שלהם לא מקבל. זה הכי חשוב בטופס</small><textarea name="gaps" rows="3" maxlength="${RIVALS.gapChars}" dir="auto">${esc(r.gaps || '')}</textarea></label>
<button class="btn primary" type="submit">${id ? icon('check') : icon('plus')}${submit}</button></form>`;
}

export function rivalsPage(ctx, { packs, current, rivals, times, form = {}, problems = [] }) {
  const tabs = packs.length < 2 ? '' : `<nav class="tabs" aria-label="חשבונות">${packs.map((p) => `<a href="/rivals?account=${esc(p.id)}"${p.id === current.id ? ' aria-current="true"' : ''}>${accDot(p.id)}${esc(p.meta.displayName)}</a>`).join('')}</nav>`;
  const editing = form.id ? Number(form.id) : null;
  const list = rivals
    .map((r) => {
      const st = RIVAL_STATE[r.state];
      const shown = editing === r.id ? { ...r, ...form } : r;
      return `<section class="panel acc acc-${esc(current.id)}" id="rival-${r.id}"><header><h2 class="ltr">@${esc(r.handle)}</h2><span class="chip ghost">${esc(PLATFORM_HE[r.platform] || r.platform)}</span>${st ? `<span class="chip ${st[1]}">${esc(st[0])}</span>` : ''}<span class="end muted small">עודכן ${esc(agoHe(r.age))}${r.updatedBy ? ` · ${esc(r.updatedBy)}` : ''}</span></header>
<ul class="rival">${r.hooks.map((h) => `<li dir="auto">${esc(h)}</li>`).join('')}</ul>
<dl class="kv">${r.formats.length ? `<dt>פורמטים</dt><dd dir="auto">${esc(r.formats.join(' · '))}</dd>` : ''}${r.times.length ? `<dt>שעות</dt><dd class="ltr">${esc(r.times.join(' · '))}</dd>` : ''}${r.gaps ? `<dt>מה חסר אצלם</dt><dd dir="auto">${esc(r.gaps)}</dd>` : ''}</dl>
<details class="rivaledit"${editing === r.id ? ' open' : ''}><summary>עדכון</summary>${editing === r.id && problems.length ? `<div class="problems"><ul>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}${rivalForm(ctx, current, shown, { id: r.id, submit: 'לשמור, הסתכלתי היום' })}</details>
<div class="actions pt10 p0x">${postButton(ctx, '/rivals/remove', 'הסרה', { cls: 'btn sm danger', confirm: 'להסיר את המתחרה?', fields: { account: current.id, id: r.id } })}</div></section>`;
    })
    .join('');
  const fewer = rivals.length < RIVALS.min ? `<p class="small"><span class="chip warn">${rivals.length ? `עוד ${RIVALS.min - rivals.length}` : `${RIVALS.min} לפחות`}</span> שלושה עד חמישה חשבונות נותנים תמונה של הנישה. חשבון אחד מראה רק את הטעם שלו.</p>` : '';
  const slots = times.own.length
    ? `<section class="panel"><header><h2>שעות</h2></header><dl class="kv">${times.own.map((x) => `<dt class="ltr">${esc(x.at)}</dt><dd>${x.near ? `${x.near === 1 ? 'מתחרה אחד מפרסם' : `${x.near} מתחרים מפרסמים`} בטווח שעה` : 'אף מתחרה לא מפרסם בטווח שעה'}</dd>`).join('')}${times.theirs.length ? `<dt>הם</dt><dd><bdi dir="ltr">${esc(times.theirs.map((x) => x.at).join(' · '))}</bdi></dd>` : ''}</dl>
<p class="muted small m6">את שעות הפרסום של החשבון, וגם אם מפרסמים בשבת ובחגים, בוחרים <a href="/settings#schedule">בהגדרות</a>. השעות של המתחרים מוצגות כאן לידן ולא משנות אותן.</p></section>`
    : '';
  const adding = !editing && problems.length;
  const body = `<div class="head"><h1>מתחרים</h1><span class="sub">מה שראיתם אצלם, בשביל הכתיבה</span></div>
${tabs}
<p class="lede">המנוע לא קורא חשבונות של אחרים: זה דף של מישהו אחר, וכלל הרשת שלנו חוסם אותו. כאן אתם כותבים מה ראיתם כשגללתם בנישה: השערים שעבדו להם, הפורמטים, מתי הם מפרסמים ומה הם לא נותנים. הכותב מקבל את זה בכל תכנון: מה שחסר אצלם מכוון את הנושא והזווית, והשערים שלהם הם מה שהשער שלנו צריך לבלוט מולו, בלי להעתיק. מתחרה שלא עודכן ${RIVALS.staleDays} יום מסומן, ואחרי ${RIVALS.dropDays} יום הוא כבר לא מגיע לכותב.</p>
${fewer}
<div class="cols"><div>${list || '<div class="empty"><b>עוד אין מתחרים לחשבון הזה</b>הכתיבה עובדת גם בלעדיהם, רק בלי לדעת מה הנישה כבר רואה.</div>'}${slots}</div>
${rivals.length < RIVALS.max ? `<section class="panel"><header><h2>מתחרה חדש</h2><span class="end muted small">${rivals.length} מתוך ${RIVALS.max}</span></header>
${adding ? `<div class="problems"><ul>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
${rivalForm(ctx, current, adding ? form : {})}</section>` : `<section class="panel"><header><h2>חמישה מתחרים</h2></header><p class="muted">זה המקסימום. כדי להוסיף אחר, הסירו אחד.</p></section>`}</div>`;
  return layout({ ...ctx, title: 'מתחרים', active: 'accounts' }, body);
}

/* ------------------------------------------------------------ sounds */

/** An account's trending sounds for its TikTok drafts: the list, and the form to add one. */
export function soundsPage(ctx, { packs, current, sounds, mode, recent, limits, form = {}, problems = [] }) {
  const tabs = packs.length < 2 ? '' : `<nav class="tabs" aria-label="חשבונות">${packs.map((p) => `<a href="/sounds?account=${esc(p.id)}"${p.id === current.id ? ' aria-current="true"' : ''}>${accDot(p.id)}${esc(p.meta.displayName)}</a>`).join('')}</nav>`;
  const list = sounds.length
    ? `<div class="panel p0 soundlist">${sounds
        .map((s) => `<div class="row sound"><span class="tx"><b dir="auto">${esc(s.name)}</b><span class="muted small" dir="auto">${esc(s.artist)} · נוסף ${esc(agoHe(s.age))}${recent.includes(s.id) ? ' · היה באחת מ-5 הטיוטות האחרונות' : ''}</span></span>${s.stale ? '<span class="chip warn">ישן</span>' : '<span class="chip ok">טרי</span>'}${s.link ? `<a class="btn sm" href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">${icon('ext')}בטיקטוק</a>` : ''}${postButton(ctx, '/sounds/remove', 'הסרה', { cls: 'btn sm danger', confirm: 'להסיר?', fields: { account: current.id, id: s.id } })}</div>`)
        .join('')}</div>`
    : '<div class="empty"><b>עוד אין סאונדים לחשבון הזה</b>טיוטה בלי סאונד מהרשימה עדיין יוצאת, רק בלי הצעה איזה סאונד להוסיף.</div>';
  const fewer = sounds.length < limits.min ? `<p class="small"><span class="chip warn">${sounds.length ? `עוד ${limits.min - sounds.length}` : `${limits.min} לפחות`}</span> כל טיוטה מקבלת סאונד שלא היה ב-${limits.recent} הטיוטות האחרונות, אז כדאי שיהיו כמה.</p>` : '';
  const body = `<div class="head"><h1>סאונדים</h1><span class="sub">לטיוטות בטיקטוק</span></div>
${tabs}
<p class="lede">את הסאונדים הוויראליים של טיקטוק אי אפשר להוסיף לפוסט מבחוץ, אז ${mode === 'direct' ? 'כשהחשבון במצב טיוטה כל פוסט בטיקטוק יוצא כטיוטה' : 'בחשבון הזה כל פוסט בטיקטוק יוצא כטיוטה'}, ואתם מוסיפים את הסאונד באפליקציה ומפרסמים. כל טיוטה מקבלת סאונד מהרשימה הזו, בלי לחזור על אחד מ-${limits.recent} האחרונות. סאונד שנוסף לפני ${limits.staleDays} ימים מסומן כישן: טרנד זז מהר. ${mode === 'draft-fallback' ? 'אם לא פרסמתם תוך שעה, הפוסט עולה לבד עם מוזיקה מהספרייה המסחרית.' : 'הטיוטה נשלחת ברגע שאתם מאשרים, ובשעה של הפוסט מגיעה תזכורת עם הסאונד.'}</p>
${mode === 'direct' ? '<p class="small"><span class="chip ghost">החשבון במצב ישיר</span> הרשימה נשמרת, ותשמש כשהחשבון יעבור למצב טיוטה.</p>' : ''}
${fewer}
<div class="cols"><div>${list}</div>
${sounds.length < limits.max ? `<section class="panel"><header><h2>סאונד חדש</h2><span class="end muted small">${sounds.length} מתוך ${limits.max}</span></header>
${problems.length ? `<div class="problems"><ul>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/sounds/save" class="formgrid">${csrfField(ctx)}<input type="hidden" name="account" value="${esc(current.id)}">
<label class="f">שם הסאונד<input type="text" name="name" required maxlength="${limits.chars}" dir="auto" value="${esc(form.name || '')}"></label>
<label class="f">אמן<input type="text" name="artist" required maxlength="${limits.chars}" dir="auto" value="${esc(form.artist || '')}"></label>
<label class="f">קישור <small>לא חובה: הסאונד בטיקטוק, כדי למצוא אותו מהר</small><input type="url" name="link" dir="ltr" placeholder="https://www.tiktok.com/music/..." value="${esc(form.link || '')}"></label>
${current.meta?.business === true ? '<label class="f check"><input type="checkbox" name="commercial" value="1" required> הסאונד מהספרייה המסחרית של טיקטוק <small>חשבון עסקי לא יכול להשתמש בשירים טרנדיים רגילים: הסאונד יושתק או שהפוסט יורד</small></label>' : ''}
<button class="btn primary" type="submit">${icon('plus')}הוספה</button></form></section>` : `<section class="panel"><header><h2>${limits.max} סאונדים</h2></header><p class="muted">זה המקסימום. כדי להוסיף אחר, הסירו אחד ישן.</p></section>`}</div>`;
  return layout({ ...ctx, title: 'סאונדים', active: 'accounts' }, body);
}
