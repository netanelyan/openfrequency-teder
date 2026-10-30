import path from 'node:path';
import { waitingImages } from '../images/index.js';
import { now, nowIso } from '../core/clock.js';
import { audit, setSetting, step } from '../core/store.js';
import { loadPost, checkPost, formatOfPost, igCaption, postDraft, textsOf } from '../pipeline/build.js';
import { drawAgain, photoChoices, withImages } from '../pipeline/light.js';
import { redoPost } from '../pipeline/redo.js';
import { reviewTexts } from '../voice/review.js';
import { lineDraft } from '../rules/overlay.js';
import { kindName } from '../formats/kinds.js';
import { confirmDeleted, recordTakedown } from '../publish/takedown.js';
import { lockStyle } from '../render/style.js';
import { canRun, pauseAccount, resumeAccount } from '../autonomy/rails.js';
import { publishPost, retireDraft, sendDraft, tiktokMode } from '../publish/index.js';
import { publishErrorHe } from '../publish/errors.js';
import { restAt } from '../schedule/shabbat.js';
import { rulesFor } from '../schedule/choice.js';
import { timeHe } from './ui.js';
import { MODES } from '../packs/validate.js';
import { factProblems, readTopics, removeFact, saveFact } from '../sources/facts.js';
import { removeRival, saveRival } from '../pipeline/rivals.js';
import { isBusiness, removeSound, saveSound } from '../pipeline/sounds.js';
import { subscribe, unsubscribe } from '../notify/index.js';
import { catalogSource } from '../sources/catalog.js';
import { robotsAllows } from '../sources/robots.js';
import { israelDate, israelInstant } from '../schedule/israel.js';
import { postSpend } from '../budget/ledger.js';
import { MAX_PLAN, REDO_REASONS, REJECT_REASON_HE, room, setPlan } from '../budget/quota.js';
import { addBankTopic, removeTopic, setWatchList } from '../topics/index.js';
import { owns } from './workspace.js';
import { EVENT_TYPES, setPrefs } from '../assistant/data.js';
import { EMAIL_KINDS, setEmailPrefs } from '../notify/email.js';

// What each button does. Every action is a function (ctx, user, params, form)
// that returns { ok, message, redirect } or throws an ActionError with a message
// for the owner. The server handles the request, the session, the CSRF token and
// the response; this file only changes state, and audits it.

export class ActionError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// A post of another workspace is "not found", the same answer as one that never was (src/web/workspace.js).
const mustPost = (ctx, id) => {
  const post = loadPost(ctx.db, id);
  if (!post || !owns(ctx, post.account_id)) throw new ActionError('הפוסט לא נמצא', 404);
  return post;
};

/** Where a change came from, beside the person: the WhatsApp assistant's are marked (src/assistant/api.js). */
const via = (user, detail = null) => (user.via ? { ...(detail || {}), via: user.via } : detail);

/** The engine's own context (every account), for its work once the row is known to be the session's. */
const engineOf = (ctx) => ctx.global || ctx;

/** The settings that are the whole server's (the kill switch, when posts are written, each account's plan): the operator's alone. */
const operatorOnly = (user) => {
  if (!user.operator) throw new ActionError('את זה משנה רק מי שמפעיל את תדר', 403);
};

/**
 * Draft-now: the approved post's TikTok draft is sent at once, beside the answer (an upload to Zernio can take a
 * minute). `job` (not sent to the browser) is the send, for the tests.
 */
function draftBeside(ctx, id, result) {
  const job = sendDraft(engineOf(ctx), id).catch((e) => {
    ctx.log?.(`draft ${id}: ${e.message}`);
    return { state: 'failed', why: e.message };
  });
  Object.defineProperty(result, 'job', { value: job });
  return result;
}

const DRAFT_LEFT = 'הטיוטה הקודמת כבר בתיבת הטיוטות של טיקטוק: מחקו אותה באפליקציה.';

export function approve(ctx, user, { id }) {
  const post = mustPost(ctx, id);
  if (post.status !== 'queued') throw new ActionError(`אי אפשר לאשר פוסט במצב "${post.status}"`);
  ctx.db.update('posts', id, { status: 'approved', approved_at: nowIso(), approved_by: user.name, updated_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'approve', accountId: post.account_id, postId: id, detail: via(user) });
  const pack = ctx.pack(post.account_id);
  if (pack && tiktokMode(pack) === 'draft-now' && pack.meta.platforms.includes('tiktok')) {
    const rest = restAt(now(), rulesFor(ctx.db, pack));
    const at = post.slot_at ? ` תזכורת תגיע ב-${timeHe(post.slot_at)}.` : '';
    return draftBeside(ctx, id, { ok: true, message: rest ? `אושר. הטיוטה תישלח לטיקטוק כש${rest} ייגמר.${at}` : `אושר. הטיוטה נשלחת לטיקטוק.${at}` });
  }
  return { ok: true, message: post.slot_at ? 'אושר. ייצא בשעה שלו.' : 'אושר.' };
}

/**
 * Approve many at once (the page of every account): the posts the page listed, in `ids`, that still wait. A post
 * drafted after the page was opened is not in the list, so it is never approved unseen. `job` is every draft sent.
 */
export function approveAll(ctx, user, params, form) {
  const ids = [...new Set(String(form.ids || '').split(',').map((s) => s.trim()).filter((s) => /^[\w-]+$/.test(s)))].slice(0, 500);
  if (!ids.length) throw new ActionError('אין פוסטים לאשר');
  const jobs = [];
  const drafting = new Set();
  let done = 0;
  for (const id of ids) {
    const row = ctx.db.get('SELECT status, account_id FROM posts WHERE id = ?', id);
    if (row?.status !== 'queued' || !owns(ctx, row.account_id)) continue;
    const r = approve(ctx, user, { id });
    done++;
    if (r.job) {
      jobs.push(r.job);
      drafting.add(row.account_id);
    }
  }
  if (!done) throw new ActionError('אף אחד מהפוסטים האלה כבר לא מחכה לאישור');
  const skipped = ids.length - done;
  // Each account keeps Shabbat or not by its own choice: the drafts wait if any of theirs does.
  const rest = [...drafting].map((a) => ctx.pack(a)).filter(Boolean).map((p) => restAt(now(), rulesFor(ctx.db, p))).find(Boolean) || null;
  const next = jobs.length ? (rest ? ` הטיוטות יישלחו לטיקטוק כש${rest} ייגמר.` : ' הטיוטות נשלחות לטיקטוק.') : ' כל פוסט ייצא בשעה שלו.';
  const result = { ok: true, message: `${done === 1 ? 'פוסט אחד אושר' : `${done} פוסטים אושרו`}${skipped ? ` (${skipped} כבר לא חיכו)` : ''}.${next}` };
  Object.defineProperty(result, 'job', { value: Promise.all(jobs) });
  return result;
}

export function unapprove(ctx, user, { id }) {
  const post = mustPost(ctx, id);
  if (post.status !== 'approved') throw new ActionError('הפוסט לא מאושר');
  const left = retireDraft(ctx.db, post);
  ctx.db.update('posts', id, { status: 'queued', approved_at: null, approved_by: null, updated_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'unapprove', accountId: post.account_id, postId: id, detail: left ? { draftLeft: true } : null });
  return { ok: true, message: `האישור בוטל. הפוסט חזר להמתנה.${left ? ` ${DRAFT_LEFT}` : ''}` };
}

/**
 * Reject a post, with a reason (src/budget/quota.js REDO_REASONS) and the customer's own words. While the month has
 * redos left, a replacement is written beside the answer with that reason (src/pipeline/redo.js) and counted as a
 * redo once it reaches them; when they are used up, the post is only discarded. A sample, or an account that cannot
 * generate now (paused, the kill switch), gets no replacement and uses no redo. `job` (not sent to the browser) is
 * the replacement being written, for the tests.
 */
export function reject(ctx, user, { id }, form) {
  const post = mustPost(ctx, id);
  if (!['queued', 'approved', 'sample'].includes(post.status)) throw new ActionError(`אי אפשר לדחות פוסט במצב "${post.status}"`);
  // A reason that is not one of the form's (an older page) is kept as the customer's words, under "something else".
  const given = String(form.reason || '').trim();
  const code = REDO_REASONS.includes(given) ? given : 'other';
  const said = [REDO_REASONS.includes(given) ? '' : given, String(form.note || '').trim()].filter(Boolean).join(': ').slice(0, 300);
  const reason = `${REJECT_REASON_HE[code]}${said ? `: ${said}` : ''}`.slice(0, 300);
  const left = retireDraft(ctx.db, post);
  const engine = engineOf(ctx);
  const q = room(ctx.db, post.account_id, { redo: true });
  const redo = !post.sample && q.ok && canRun(ctx.db, post.account_id).ok && Boolean(engine.pack(post.account_id));
  const rejected = { reason: code, note: said, by: user.name, at: nowIso(), redo: redo ? 'writing' : post.sample ? 'sample' : q.ok ? 'paused' : 'none' };
  ctx.db.update('posts', id, { status: 'rejected', reason, reject_json: rejected, updated_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'reject', accountId: post.account_id, postId: id, detail: via(user, { reason, redo: rejected.redo }) });
  const draftLeft = left ? ` ${DRAFT_LEFT}` : '';
  if (!redo) {
    const why = post.sample ? 'נדחה. הסיבה נשמרה.' : !q.ok ? `נדחה, והפוסט ירד. כל ${q.usage.redos.limit} ההחלפות של החודש נוצלו, אז לא נכתב פוסט במקומו.` : 'נדחה. הכתיבה בחשבון עצורה כרגע, אז לא נכתב פוסט במקומו וההחלפה לא ירדה מהמכסה.';
    return { ok: true, message: `${why}${draftLeft}` };
  }
  // Started here, not awaited: redoPost holds the redo (its first drafting row) before it first waits.
  const job = redoPost(engine, loadPost(ctx.db, id), { reason: code, note: said }).catch((e) => {
    ctx.log?.(`redo ${id}: ${e.stack || e.message}`);
    return { ok: false, why: e.message };
  });
  const after = q.usage.redos.left - 1;
  const result = { ok: true, message: `נדחה. פוסט חלופי נכתב עכשיו ויגיע לאישור בעוד כמה דקות. ${after === 0 ? 'זו ההחלפה האחרונה של החודש.' : after === 1 ? 'נשארה עוד החלפה אחת החודש.' : `נשארו עוד ${after} החלפות החודש.`}${draftLeft}` };
  Object.defineProperty(result, 'job', { value: job });
  return result;
}

/** The owner deleted a post's old TikTok drafts in the app: the reminder on the post goes away. */
export function oldDraftsDeleted(ctx, user, { id }) {
  const post = mustPost(ctx, id);
  if (!post.publish?.oldDrafts?.length) return { ok: true, message: 'אין טיוטות ישנות.' };
  const { oldDrafts, ...rest } = post.publish;
  ctx.db.update('posts', id, { publish_json: rest, updated_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'tiktok_old_drafts_deleted', accountId: post.account_id, postId: id, detail: { n: oldDrafts.length } });
  return { ok: true, message: 'סומן. הטיוטות הישנות נמחקו.' };
}

export async function publishNow(ctx, user, { id }) {
  const post = mustPost(ctx, id);
  // Held for a connection (src/publish/hold.js): it goes out by itself once TikTok or Instagram is connected.
  if (post.status === 'held') throw new ActionError(post.reason || 'הפוסט מחכה לחיבור של טיקטוק או אינסטגרם.');
  try {
    const r = await publishPost(engineOf(ctx), id);
    audit(ctx.db, { actor: user.name, action: 'publish_now', accountId: post.account_id, postId: id, detail: { via: r.via, ok: r.ok } });
    if (r.held) return { ok: false, message: loadPost(ctx.db, id)?.reason || 'הפוסט מחכה לחיבור של טיקטוק או אינסטגרם.' };
    return { ok: r.ok, message: r.ok ? (r.via === 'dry' ? 'פורסם בפרסום יבש: נכתב לדיסק.' : 'פורסם.') : 'הפרסום נכשל. הסיבה בדף הפוסט.' };
  } catch (e) {
    // The publisher's own words go to the log; the customer reads them in Hebrew (src/publish/errors.js).
    console.error(`[publish-now] ${id}: ${e?.message || e}`);
    throw new ActionError(user.operator ? `לא פורסם: ${e.message}` : publishErrorHe(e));
  }
}

/**
 * Save edited text. Runs the voice, rules and fact checks again; on any problem
 * nothing is saved and the problems come back. On success the slides are
 * rendered again with a new token from the gate, and every change is kept in
 * `edits`, which the next drafts read as examples of the owner's voice.
 */
export async function edit(ctx, user, { id }, form) {
  const post = mustPost(ctx, id);
  if (!['queued', 'approved', 'sample'].includes(post.status)) throw new ActionError(`אי אפשר לערוך פוסט במצב "${post.status}"`);
  const pack = ctx.pack(post.account_id);
  const clean = (s, max) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);
  const format = formatOfPost(ctx.db, pack, post);
  const legacy = kindName(format) === 'list';
  let item = -1;
  const draft = postDraft(post);
  draft.hook = clean(form.hook, 90);
  draft.sub = clean(form.sub, 120);
  draft.caption = clean(form.caption, legacy ? 400 : 900);
  if (form.caption_short != null) draft.captionShort = clean(form.caption_short, 260);
  draft.slides = draft.slides.map((s) => {
    if (s.kind !== 'item') return s;
    item++;
    return { ...s, title: clean(form[`title_${item}`] ?? s.title, 80), body: clean(form[`body_${item}`] ?? s.body, 300) };
  });
  // A line the owner left longer than the account's rule is broken in code, as a draft's would be.
  lineDraft(draft, pack);
  draft.captionIg = igCaption(draft);
  // Checked as the engine checks a draft: against every account on the server, not only this workspace's.
  const engine = engineOf(ctx);
  const { problems, gate } = checkPost({ ...engine, packs: engine.packs }, pack, draft, post.facts, format);
  if (problems.length) throw new ActionError('הבדיקות עצרו את השינוי', 422, { problems: problems.map((p) => `${p.where}: ${p.msg}`), values: { ...form } });
  await factCheckChanged(ctx, { post, pack, draft, form });

  const { files, look } = await drawAgain(engine, { post, pack, format, draft: withImages(draft, post), token: gate.token });

  ctx.db.tx(() => {
    const changes = [];
    const note = (slideIdx, field, before, after) => {
      if (String(before || '') !== String(after || '')) changes.push({ slide_idx: slideIdx, field, before, after });
    };
    note(null, 'hook', post.hook, draft.hook);
    note(null, 'sub', post.sub, draft.sub);
    note(null, 'caption', post.caption, draft.caption);
    note(null, 'caption_short', post.data?.captionShort, draft.captionShort);
    post.slides.forEach((s, i) => {
      if (s.kind !== 'item') return;
      note(i, 'title', s.title, draft.slides[i].title);
      note(i, 'body', s.body, draft.slides[i].body);
      ctx.db.run('UPDATE slides SET title = ?, body = ? WHERE post_id = ? AND idx = ?', draft.slides[i].title, draft.slides[i].body, id, i);
    });
    for (const c of changes) ctx.db.insert('edits', { post_id: id, account_id: post.account_id, ...c, user_id: user.id, at: nowIso() });
    ctx.db.update('posts', id, { hook: draft.hook, sub: draft.sub, caption: draft.caption, caption_ig: draft.captionIg, data_json: { ...post.data, captionShort: draft.captionShort }, media_json: files, checks_json: { ...post.checks, token: gate.token, edited: true, style: look.hash }, updated_at: nowIso() });
    saveFiles(ctx.db, id, files);
    step(ctx.db, id, 'edit', 'ok', via(user, { by: user.name, changes: changes.length }));
    audit(ctx.db, { actor: user.name, action: 'edit', accountId: post.account_id, postId: id, detail: via(user, { changes: changes.length }) });
  });
  // A draft sent before the edit is the old text: it stays in the app for the owner to delete, and the new one goes.
  if (post.status === 'approved' && retireDraft(ctx.db, loadPost(ctx.db, id))) {
    return draftBeside(ctx, id, { ok: true, message: `נשמר ועבר את הבדיקות. השקפים רונדרו מחדש, וטיוטה חדשה נשלחת לטיקטוק. ${DRAFT_LEFT}`, redirect: `/post/${id}` });
  }
  return { ok: true, message: 'נשמר ועבר את הבדיקות. השקפים רונדרו מחדש.', redirect: `/post/${id}` };
}

/**
 * A light edit's fact check is a model call the month's plan does not count (src/budget/quota.js: small changes are
 * free), so a customer's are bounded by day instead: this many calls a day across the workspace's accounts. Plenty for
 * a person editing their posts; a loop of edits stops here. The operator is not limited.
 */
export const EDIT_CHECKS_PER_DAY = 30;

/** The edit checks a workspace's accounts made today (Israel day), from what was billed for them (spend, tag edit-check). */
export function editChecksToday(db, workspaceId, t = now()) {
  const from = israelInstant(israelDate(t), '00:00').toISOString();
  return db.get("SELECT COUNT(*) AS n FROM spend WHERE tag = 'edit-check' AND at >= ? AND account_id IN (SELECT id FROM accounts WHERE workspace_id = ?)", from, workspaceId).n;
}

/**
 * The one model call a light edit makes: the reviewer's fact check, on the texts the customer changed and nothing
 * else, billed to the post (tag edit-check, src/budget/quota.js ledger). A text that says more than its facts is
 * refused, as the engine's own would be; how much it sounds like a bot is the customer's call. Offline the reviewer
 * is the code's and costs nothing. A check that fails stops the edit: nothing is saved unchecked.
 */
async function factCheckChanged(ctx, { post, pack, draft, form }) {
  const before = new Map(textsOf(postDraft(post)).map((t) => [t.where, String(t.text || '')]));
  const changed = textsOf(draft).filter((t) => before.get(t.where) !== String(t.text || ''));
  if (!changed.length) return;
  // A customer's checks of the day (src/web/actions.js EDIT_CHECKS_PER_DAY): the plan does not count them, this does.
  if (ctx.workspaceId != null && editChecksToday(ctx.db, ctx.workspaceId) >= EDIT_CHECKS_PER_DAY) {
    throw new ActionError(`היום כבר בדקנו ${EDIT_CHECKS_PER_DAY} עריכות טקסט בחשבונות שלכם, וזה המקסימום ליום. אפשר לערוך שוב מחר, או לדחות את הפוסט עם סיבה ולקבל פוסט חלופי.`, 429, { values: { ...form } });
  }
  const engine = engineOf(ctx);
  let review;
  try {
    review = await reviewTexts({ ...engine, pack, postId: post.id }, { pack, texts: changed, facts: post.facts.filter((f) => f.verified), tag: 'edit-check' });
  } finally {
    ctx.db.update('posts', post.id, { cost_usd: postSpend(ctx.db, post.id).usd });
  }
  const bad = review.reviews.map((r, i) => ({ ...r, where: changed[i].where })).filter((r) => r.factProblem);
  if (bad.length) throw new ActionError('בדיקת העובדות עצרה את השינוי', 422, { problems: bad.map((r) => `${r.where}: ${r.factProblem}`), values: { ...form } });
}

/** Each slide's rendered files, as the post's media now has them. */
function saveFiles(db, id, files) {
  const n = db.get('SELECT COUNT(*) AS n FROM slides WHERE post_id = ?', id).n;
  for (let i = 0; i < n; i++) db.run('UPDATE slides SET files_json = ? WHERE post_id = ? AND idx = ?', JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v[i]]))), id, i);
}

/** After a light edit of an approved post: its TikTok draft is the old one, so a new one goes. */
function redrawn(ctx, id, post, message) {
  if (post.status === 'approved' && retireDraft(ctx.db, loadPost(ctx.db, id))) return draftBeside(ctx, id, { ok: true, message: `${message} טיוטה חדשה נשלחת לטיקטוק. ${DRAFT_LEFT}`, redirect: `/post/${id}` });
  return { ok: true, message, redirect: `/post/${id}` };
}

const lightPost = (ctx, id) => {
  const post = mustPost(ctx, id);
  if (!['queued', 'approved', 'sample'].includes(post.status)) throw new ActionError(`אי אפשר לערוך פוסט במצב "${post.status}"`);
  const pack = ctx.pack(post.account_id);
  return { post, pack, format: formatOfPost(ctx.db, pack, post) };
};

/**
 * Another photograph on one slide: one this post already fetched and screened (photoChoices), or none. Only drawn
 * again: the text, and so the gate's token, do not change, and no model is asked.
 */
export async function swapPhoto(ctx, user, { id, idx }, form) {
  const { post, pack, format } = lightPost(ctx, id);
  const i = Number(idx);
  const slide = post.slides[i];
  if (!slide) throw new ActionError('אין שקף כזה', 404);
  const want = String(form.image || '') === 'none' ? null : Number(form.image);
  if (want != null && !photoChoices(ctx.db, post).some((img) => img.id === want)) throw new ActionError('התמונה הזו לא מהפוסט הזה', 404);
  if ((slide.image_id ?? null) === want) return { ok: true, message: 'זו כבר התמונה של השקף.', redirect: `/post/${id}` };
  const draft = withImages(postDraft(post), post);
  draft.slides[i].imageId = want;
  // The cover's photograph is the post's lead one too: credited, and drawn where the kind puts it.
  const checks = i === 0 ? { ...post.checks, image: want } : post.checks;
  const { files, look } = await drawAgain(engineOf(ctx), { post: { ...post, checks }, pack, format, draft, token: post.checks?.token });
  ctx.db.tx(() => {
    ctx.db.run('UPDATE slides SET image_id = ? WHERE post_id = ? AND idx = ?', want, id, i);
    saveFiles(ctx.db, id, files);
    ctx.db.update('posts', id, { media_json: files, checks_json: { ...checks, edited: true, style: look.hash }, updated_at: nowIso() });
    step(ctx.db, id, 'edit', 'ok', { by: user.name, photo: { slide: i, from: slide.image_id ?? null, to: want } });
    audit(ctx.db, { actor: user.name, action: 'photo_swapped', accountId: post.account_id, postId: id, detail: { slide: i, from: slide.image_id ?? null, to: want } });
  });
  return redrawn(ctx, id, post, want ? 'התמונה הוחלפה והשקפים צוירו מחדש.' : 'התמונה הוסרה מהשקף והשקפים צוירו מחדש.');
}

/**
 * One content slide removed. The facts, the law and the voice are checked again as for any edit (a caption that
 * leans on the removed slide's fact is refused); the format's shape, how many slides and how many carry a graphic, is
 * the customer's call. Drawn again with a new token, no model asked.
 */
export async function removeSlide(ctx, user, { id, idx }) {
  const { post, pack, format } = lightPost(ctx, id);
  const i = Number(idx);
  if (post.slides[i]?.kind !== 'item') throw new ActionError('אין שקף תוכן כזה', 404);
  if (post.slides.filter((s) => s.kind === 'item').length <= 1) throw new ActionError('זה השקף היחיד עם תוכן, ולכן אי אפשר להסיר אותו.');
  const draft = withImages(postDraft(post), post);
  draft.slides.splice(i, 1);
  const engine = engineOf(ctx);
  const { problems, gate } = checkPost({ ...engine, packs: engine.packs }, pack, draft, post.facts, format);
  const hard = problems.filter((p) => p.code !== 'shape');
  if (hard.length) throw new ActionError(`השקף לא הוסר: ${hard.slice(0, 2).map((p) => `${p.where}: ${p.msg}`).join(' · ')}`, 422);
  const { files, look } = await drawAgain(engine, { post, pack, format, draft, token: gate.token });
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM slides WHERE post_id = ? AND idx = ?', id, i);
    // One at a time, upwards, so no two rows share an index on the way.
    for (const s of ctx.db.all('SELECT idx FROM slides WHERE post_id = ? AND idx > ? ORDER BY idx', id, i)) ctx.db.run('UPDATE slides SET idx = ? WHERE post_id = ? AND idx = ?', s.idx - 1, id, s.idx);
    saveFiles(ctx.db, id, files);
    ctx.db.update('posts', id, { media_json: files, checks_json: { ...post.checks, token: gate.token, edited: true, style: look.hash }, updated_at: nowIso() });
    step(ctx.db, id, 'edit', 'ok', { by: user.name, removed: { slide: i, title: post.slides[i].title } });
    audit(ctx.db, { actor: user.name, action: 'slide_removed', accountId: post.account_id, postId: id, detail: { slide: i } });
  });
  return redrawn(ctx, id, post, 'השקף הוסר והשקפים צוירו מחדש.');
}

/** The operator sets an account's month: suggested slideshows and redos. An empty field is the default (40, 10). */
export function setQuota(ctx, user, { id }, form) {
  operatorOnly(user);
  if (!ctx.pack(id)) throw new ActionError('אין חשבון כזה', 404);
  const r = setPlan(ctx.db, id, { suggested: form.suggested, redos: form.redos });
  if (r.problems?.includes('workspace')) throw new ActionError('החבילה של חשבון של לקוח נקבעת במנוי שלו ב-accounts, ומשותפת לכל החשבונות שלו. כאן משנים רק את החשבונות שלנו.', 409);
  if (r.problems) throw new ActionError(`לא נשמר. הצעות והחלפות הן מספר שלם עד ${MAX_PLAN.suggested}.`, 422);
  audit(ctx.db, { actor: user.name, action: 'quota', accountId: id, detail: { suggested: r.suggested, redos: r.redos } });
  return { ok: true, message: `נשמר: ${r.suggested} הצעות ו-${r.redos} החלפות בחודש.` };
}

export function setMode(ctx, user, { id }, form) {
  if (!ctx.pack(id)) throw new ActionError('אין חשבון כזה', 404);
  if (!MODES.includes(form.mode)) throw new ActionError('מצב לא מוכר');
  ctx.db.update('accounts', id, { mode: form.mode, updated_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'mode', accountId: id, detail: { mode: form.mode } });
  return { ok: true, message: 'המצב עודכן.' };
}

/** The owner applies the account's theme.json: the next posts are drawn in it, and the posts already drawn keep theirs. */
export function applyStyle(ctx, user, { id }) {
  const pack = ctx.pack(id);
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const lock = lockStyle(ctx.db, pack);
  audit(ctx.db, { actor: user.name, action: 'style', accountId: id, detail: { hash: lock.hash, look: `${pack.theme.template}/${pack.theme.variant || 'a'}` } });
  return { ok: true, message: 'עברתם לסגנון החדש. הפוסטים הבאים ייצאו בו, ואלה שכבר צוירו לא משתנים.' };
}

export function killAccount(ctx, user, { id }) {
  if (!ctx.pack(id)) throw new ActionError('אין חשבון כזה', 404);
  pauseAccount(ctx.db, id, 'kill', `${user.name} כיבה את החשבון`, user.name);
  return { ok: true, message: 'החשבון כובה. שום דבר לא ייכתב ולא יפורסם בו.' };
}

export function resume(ctx, user, { id }) {
  if (!ctx.pack(id)) throw new ActionError('אין חשבון כזה', 404);
  resumeAccount(ctx.db, id, user.name);
  return { ok: true, message: 'החשבון פעיל שוב.' };
}

export function globalKill(ctx, user, _p, form) {
  operatorOnly(user);
  const on = form.on === '1';
  setSetting(ctx.db, 'globalKill', on);
  audit(ctx.db, { actor: user.name, action: on ? 'global_kill_on' : 'global_kill_off' });
  return { ok: true, message: on ? 'הכל נעצר.' : 'הכל פועל שוב.' };
}

export function setGenerateAt(ctx, user, _p, form) {
  operatorOnly(user);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(form.at || ''))) throw new ActionError('צריך שעה כמו 07:30');
  setSetting(ctx.db, 'generateAt', form.at);
  audit(ctx.db, { actor: user.name, action: 'generate_at', detail: { at: form.at } });
  return { ok: true, message: 'נשמר.' };
}

export function sourceStatus(ctx, user, { id }, _form, status) {
  const s = ctx.db.get('SELECT * FROM sources WHERE id = ?', Number(id));
  if (!s || !owns(ctx, s.account_id)) throw new ActionError('אין מקור כזה', 404);
  ctx.db.update('sources', s.id, { status, approved_at: status === 'approved' ? nowIso() : s.approved_at });
  audit(ctx.db, { actor: user.name, action: `source_${status}`, accountId: s.account_id, detail: { source: s.key, url: s.url } });
  return { ok: true, message: status === 'approved' ? 'המקור אושר.' : 'המקור הוסר. פוסטים שנשענים עליו ייחסמו לפני פרסום.', redirect: `/sources?account=${encodeURIComponent(s.account_id)}` };
}

export function addSource(ctx, user, _p, form) {
  const problems = [];
  const account = String(form.account || '');
  if (!ctx.pack(account)) problems.push('אין חשבון כזה');
  let url = '';
  try {
    url = new URL(String(form.url || '').trim()).href;
    if (!url.startsWith('https://')) problems.push('צריך כתובת שמתחילה ב-https');
  } catch {
    problems.push('הכתובת לא נראית כמו קישור');
  }
  if (!['rss', 'web', 'api'].includes(form.type)) problems.push('סוג לא מוכר');
  if (String(form.why || '').trim().length < 10) problems.push('צריך לכתוב למה סומכים על המקור');
  if (!String(form.name || '').trim()) problems.push('צריך שם');
  if (problems.length) throw new ActionError('המקור לא נוסף', 422, { problems, values: { ...form } });
  const key = `manual-${new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}`;
  ctx.db.insert('sources', { account_id: account, key, type: form.type, url, name: String(form.name).trim().slice(0, 120), why: String(form.why).trim().slice(0, 400), status: 'approved', origin: 'manual', approved_at: nowIso(), config_json: {}, created_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'source_added', accountId: account, detail: { url } });
  return { ok: true, message: 'המקור נוסף ואושר.', redirect: `/sources?account=${encodeURIComponent(account)}` };
}

/**
 * An outlet from the catalog (src/sources/catalog.js), added to an account's approved sources: its site's robots.txt
 * is asked again first, so one that has since told Claude to stay out is refused here. `ctx.robotsAllows` replaces
 * the network for the tests.
 */
export async function addCatalogSource(ctx, user, _p, form) {
  const account = String(form.account || '');
  if (!ctx.pack(account)) throw new ActionError('אין חשבון כזה', 404);
  const src = catalogSource(String(form.niche || ''), String(form.id || ''));
  if (!src) throw new ActionError('אין מקור כזה ברשימה', 404);
  const robots = await (ctx.robotsAllows || robotsAllows)(src.url);
  if (!robots.ok) throw new ActionError(`${src.name} לא נוסף: ${robots.why}`, 422);
  const have = ctx.db.get('SELECT id, status FROM sources WHERE account_id = ? AND url = ?', account, src.url);
  if (have?.status === 'approved') return { ok: true, message: `${src.name} כבר מקור מאושר.`, redirect: `/sources?account=${encodeURIComponent(account)}` };
  if (have) ctx.db.update('sources', have.id, { status: 'approved', approved_at: nowIso(), last_error: null });
  else ctx.db.insert('sources', { account_id: account, key: `catalog-${src.id}`, type: src.type, url: src.url, name: src.name, why: src.why, lang: src.lang, status: 'approved', origin: 'manual', approved_at: nowIso(), config_json: { hints: src.hints }, created_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'source_added', accountId: account, detail: { url: src.url, catalog: `${form.niche}/${src.id}` } });
  return { ok: true, message: `${src.name} נוסף ואושר.`, redirect: `/sources?account=${encodeURIComponent(account)}` };
}


// ---- hand-checked facts (src/sources/facts.js), written into the pack's facts/ folder

const factPack = (ctx, form) => {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  return { pack, dir: path.join(pack.dir, 'facts') };
};

export function addFact(ctx, user, _p, form) {
  const { pack, dir } = factPack(ctx, form);
  const topic = String(form.topic || '').trim().slice(0, 60);
  // The owner's own story: their words, no page and no expiry (src/sources/facts.js "owner").
  if (form.owner === '1') {
    const story = { quote: String(form.quote || '').replace(/\s+/g, ' ').trim(), checkedAt: israelDate(Date.now()), checkedBy: user.name, note: String(form.note || '').trim().slice(0, 200) };
    const problems = [...(topic ? [] : ['צריך נושא']), ...factProblems(story, { maxQuoteWords: pack.rules.maxQuoteWords || 40, owner: true })];
    if (problems.length) throw new ActionError('הסיפור לא נשמר', 422, { problems, values: { ...form } });
    const first = !pack.facts;
    saveFact(dir, topic, story, { owner: true });
    if (first) ctx.reloadPacks();
    audit(ctx.db, { actor: user.name, action: 'story_added', accountId: pack.id, detail: { topic } });
    return { ok: true, message: 'נשמר. הפוסטים של "הסיפור שלי" ייכתבו ממה שכתבתם, במילים שלכם.', redirect: `/facts?account=${encodeURIComponent(pack.id)}` };
  }
  const fact = {
    quote: String(form.quote || '').replace(/\s+/g, ' ').trim(),
    source: String(form.source || '').trim().slice(0, 80),
    url: String(form.url || '').trim(),
    checkedAt: String(form.checkedAt || ''),
    checkedBy: user.name,
    expires: String(form.expires || ''),
    note: String(form.note || '').trim().slice(0, 200),
  };
  const problems = [...(topic ? [] : ['צריך נושא']), ...factProblems(fact, { maxQuoteWords: pack.rules.maxQuoteWords || 40 })];
  if (problems.length) throw new ActionError('העובדה לא נשמרה', 422, { problems, values: { ...form } });
  const first = !pack.facts;
  saveFact(dir, topic, fact);
  // The first fact makes the folder, and the folder makes the pack's "facts" source.
  if (first) ctx.reloadPacks();
  audit(ctx.db, { actor: user.name, action: 'fact_added', accountId: pack.id, detail: { topic, url: fact.url, expires: fact.expires } });
  return { ok: true, message: 'העובדה נשמרה. היא תשמש פוסטים עד תאריך התפוגה.', redirect: `/facts?account=${encodeURIComponent(pack.id)}` };
}

export function confirmFact(ctx, user, _p, form) {
  const { pack, dir } = factPack(ctx, form);
  const topic = readTopics(dir).find((t) => t.topic === form.topic);
  const fact = topic?.facts.find((f) => f.id === form.id);
  if (!fact) throw new ActionError('העובדה לא נמצאה', 404);
  const next = { ...fact, checkedAt: israelDate(Date.now()), checkedBy: user.name, expires: String(form.expires || fact.expires) };
  const problems = factProblems(next, { maxQuoteWords: pack.rules.maxQuoteWords || 40 });
  if (problems.length) throw new ActionError(problems[0]);
  saveFact(dir, topic.topic, next);
  audit(ctx.db, { actor: user.name, action: 'fact_confirmed', accountId: pack.id, detail: { topic: topic.topic, id: fact.id, expires: next.expires } });
  return { ok: true, message: `נבדקה שוב, בתוקף עד ${next.expires}.`, redirect: `/facts?account=${encodeURIComponent(pack.id)}` };
}

export function removeFactAction(ctx, user, _p, form) {
  const { pack, dir } = factPack(ctx, form);
  const gone = removeFact(dir, String(form.topic || ''), String(form.id || ''));
  if (!gone) throw new ActionError('העובדה לא נמצאה', 404);
  audit(ctx.db, { actor: user.name, action: 'fact_removed', accountId: pack.id, detail: { topic: form.topic, quote: gone.quote.slice(0, 80) } });
  return { ok: true, message: 'הוסרה. פוסט שעוד לא פורסם ונשען עליה ייחסם בבדיקה שלפני הפרסום.', redirect: `/facts?account=${encodeURIComponent(pack.id)}` };
}

// ---- rivals the owner watches (src/pipeline/rivals.js), typed in by hand

export function saveRivalAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const r = saveRival(ctx.db, pack.id, form, { by: user.name });
  if (r.problems) throw new ActionError('המתחרה לא נשמר', 422, { problems: r.problems, values: { ...form } });
  audit(ctx.db, { actor: user.name, action: form.id ? 'rival_updated' : 'rival_added', accountId: pack.id, detail: { handle: String(form.handle || '').replace(/^@+/, '').trim(), platform: form.platform } });
  return { ok: true, message: form.id ? 'עודכן. הכתיבה הבאה תשתמש בזה.' : 'נוסף. הכתיבה הבאה תשתמש בזה.', redirect: `/rivals?account=${encodeURIComponent(pack.id)}` };
}

export function removeRivalAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const gone = removeRival(ctx.db, pack.id, form.id);
  if (!gone) throw new ActionError('אין מתחרה כזה', 404);
  audit(ctx.db, { actor: user.name, action: 'rival_removed', accountId: pack.id, detail: { handle: gone.handle, platform: gone.platform } });
  return { ok: true, message: `@${gone.handle} הוסר.`, redirect: `/rivals?account=${encodeURIComponent(pack.id)}` };
}

export function saveSoundAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const r = saveSound(ctx.db, pack.id, form, { by: user.name, business: isBusiness(pack) });
  if (r.problems) throw new ActionError('הסאונד לא נשמר', 422, { problems: r.problems, values: { ...form } });
  audit(ctx.db, { actor: user.name, action: 'sound_added', accountId: pack.id, detail: { name: String(form.name || '').trim() } });
  return { ok: true, message: 'נוסף. הטיוטה הבאה בטיקטוק תקבל סאונד מהרשימה.', redirect: `/sounds?account=${encodeURIComponent(pack.id)}` };
}

export function removeSoundAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const gone = removeSound(ctx.db, pack.id, form.id);
  if (!gone) throw new ActionError('אין סאונד כזה', 404);
  audit(ctx.db, { actor: user.name, action: 'sound_removed', accountId: pack.id, detail: { name: gone.name } });
  return { ok: true, message: `"${gone.name}" הוסר.`, redirect: `/sounds?account=${encodeURIComponent(pack.id)}` };
}

/**
 * The customer's choices for the WhatsApp assistant (src/assistant/data.js): which messages reach them, and their
 * quiet hours. Every box on the form is sent; one left unticked is off.
 */
export function setAssistantPrefs(ctx, user, _p, form) {
  if (ctx.workspaceId == null) throw new ActionError('את זה בוחר כל לקוח בחשבון שלו', 403);
  const events = Object.fromEntries(EVENT_TYPES.map((k) => [k, form[`ev_${k}`] === '1']));
  const r = setPrefs(ctx.db, ctx.workspaceId, { events, quiet: { nights: form.quiet_nights === '1', shabbat: form.quiet_shabbat === '1' } }, { by: user.name });
  audit(ctx.db, { actor: user.name, action: 'assistant_prefs', detail: { workspace: ctx.workspaceId, ...r } });
  return { ok: true, message: 'נשמר.' };
}

/** Which emails the workspace's owners get (src/notify/email.js): a box per kind, unticked is off. */
export function setEmailPrefsAction(ctx, user, _p, form) {
  if (ctx.workspaceId == null) throw new ActionError('את זה בוחר כל לקוח בחשבון שלו', 403);
  const prefs = setEmailPrefs(ctx.db, ctx.workspaceId, Object.fromEntries(EMAIL_KINDS.map((k) => [k, form[`em_${k}`] === '1'])), { by: user.name });
  audit(ctx.db, { actor: user.name, action: 'email_prefs', detail: { workspace: ctx.workspaceId, ...prefs } });
  return { ok: true, message: 'נשמר.' };
}

/** A browser asks for notifications: its push endpoint is kept. */
export function subscribePush(ctx, user, _p, form) {
  const r = subscribe(ctx.db, { endpoint: form.endpoint }, { userId: user.id ?? null, workspaceId: ctx.workspaceId ?? null });
  if (!r.ok) throw new ActionError('הדפדפן לא החזיר כתובת התראות תקינה');
  audit(ctx.db, { actor: user.name, action: 'push_subscribed', detail: { host: new URL(String(form.endpoint)).hostname } });
  return { ok: true, message: 'ההתראות מופעלות בדפדפן הזה.' };
}

/** A browser turns its notifications off: its endpoint is forgotten. */
export function unsubscribePush(ctx, user, _p, form) {
  const n = unsubscribe(ctx.db, { endpoint: form.endpoint }, { workspaceId: ctx.workspaceId ?? null });
  audit(ctx.db, { actor: user.name, action: 'push_unsubscribed', detail: { n } });
  return { ok: true, message: 'ההתראות כבויות בדפדפן הזה.' };
}

/** A takedown notice for a post: recorded, the post taken down, the account paused on the second in 90 days. */
export async function takedown(ctx, user, { id }, form) {
  const post = mustPost(ctx, id);
  const notice = String(form.notice || '').trim();
  if (notice.length < 10) throw new ActionError('הדביקו את נוסח ההודעה (לפחות כמה מילים)');
  const platform = ['tiktok', 'instagram'].includes(form.platform) ? form.platform : null;
  const r = await recordTakedown(engineOf(ctx), { postId: id, platform, claimant: String(form.claimant || '').trim(), notice, by: user.name });
  const hand = Object.entries(r.deleted).filter(([, v]) => v.state === 'by_hand').map(([p]) => (p === 'tiktok' ? 'טיקטוק' : 'אינסטגרם'));
  return {
    ok: true,
    message: `ההודעה נרשמה והפוסט ירד.${hand.length ? ` צריך למחוק ידנית ב${hand.join(' וב')}: הפרטים בדף הפוסט.` : ''}${r.paused ? ` החשבון הושהה: ${r.count} הודעות ב-90 יום.` : ''}`,
    redirect: `/post/${id}`,
  };
}

/** The owner deleted the post by hand on one platform. */
export function takedownDeleted(ctx, user, { id }, form) {
  const platform = ['tiktok', 'instagram'].includes(form.platform) ? form.platform : null;
  if (!platform) throw new ActionError('איזו פלטפורמה?');
  const row = ctx.db.get('SELECT account_id FROM takedowns WHERE id = ?', Number(id));
  if (!row || !owns(ctx, row.account_id)) throw new ActionError('אין הודעה כזו', 404);
  try {
    confirmDeleted(ctx.db, { id: Number(id), platform, by: user.name });
  } catch (e) {
    throw new ActionError(e.message);
  }
  return { ok: true, message: 'סומן כנמחק.' };
}

/** A person looked at a photograph the screen could not clear, and it is fine. */
export function imageOk(ctx, user, { id }) {
  const post = mustPost(ctx, id);
  // The person looked at the post's page, every slide on it: every photograph waiting there is marked.
  const waiting = waitingImages(ctx.db, post);
  if (!waiting.length) throw new ActionError('לפוסט הזה אין תמונה שמחכה לבדיקה');
  for (const img of waiting) ctx.db.update('images', img.id, { reviewed_by: user.name, reviewed_at: nowIso() });
  audit(ctx.db, { actor: user.name, action: 'image_ok', accountId: post.account_id, postId: id, detail: { images: waiting.map((i) => i.id) } });
  return { ok: true, message: waiting.length > 1 ? `${waiting.length} התמונות סומנו כבדוקות. אפשר לפרסם.` : 'התמונה סומנה כבדוקה. אפשר לפרסם.' };
}

/* ------------------------------------------------------------ topics: the bank and the watch list (src/topics) */

export function addTopicAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  try {
    addBankTopic(ctx.db, pack.id, { title: form.title, why: form.why, url: form.url }, user.name);
  } catch (e) {
    throw new ActionError('הנושא לא נשמר', 422, { problems: [e.message], values: { ...form } });
  }
  return { ok: true, message: 'נוסף לבנק. הוא יקבל ציון, והפוסט הבא יתחיל ממנו.', redirect: '/topics' };
}

export function removeTopicAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  if (!removeTopic(ctx.db, pack.id, Number(form.id), user.name)) throw new ActionError('אין נושא כזה', 404);
  return { ok: true, message: 'הוסר.', redirect: '/topics' };
}

export function saveWatchAction(ctx, user, _p, form) {
  const pack = ctx.pack(String(form.account || ''));
  if (!pack) throw new ActionError('אין חשבון כזה', 404);
  const names = setWatchList(ctx.db, pack, form.names);
  audit(ctx.db, { actor: user.name, action: 'watch_saved', accountId: pack.id, detail: { n: names.length } });
  return { ok: true, message: names.length ? `נשמרו ${names.length} שמות. הם נבדקים פעם ביום.` : 'הרשימה ריקה: ויקיפדיה לא תיבדק.', redirect: '/topics' };
}
