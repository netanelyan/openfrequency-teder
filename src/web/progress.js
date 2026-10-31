import { DAY, now } from '../core/clock.js';
import { onboardingWork } from './onboarding.js';
import { esc, icon } from './ui.js';

// The home page's block of work in progress (the owner, 2026-10-31: "when something is being done, i want the main
// dashboard page show a block that shows whats loading, and when done, a url to the place").
//
// WHAT IS LISTED, each only where a row says so:
//   - a new account's search for sources, and its sample posts (src/web/onboarding.js onboardingWork), with the
//     progress line their own page shows; done, the way to the setup page (the sources to choose, the samples), and a
//     search or a round of samples that stopped, with the way to try again
//   - a slideshow being written for the account shown (posts.status 'drafting', not a sample): the day's, or the
//     replacement for one turned down (redo_of); done, the way to it while it waits for approval. One the checks
//     stopped leaves the list: what the checks stopped is not on home (pages.js todayPage), it is on Posts and Results.
// Not listed: a TikTok draft on its way (src/publish/index.js sendDraft: one request of a few seconds, and home's TikTok
// panel says where each draft stands), and a check of the connections (the account page's button waits for its answer).
//
// HOW LONG A DONE ITEM STAYS: until its next step is taken (the sources chosen, the samples gone through, the post
// approved or turned down), and a day at most after it ended. A day, because home is a day's page: whoever started
// something comes back within one, and what still waits after that is on its own page (/new lists the setups in
// progress, Posts the posts to approve). Nothing is stored for it: there is no "seen" to keep per person, and a
// read-only session (the operator viewing as the customer) leaves the customer's block as it was.
//
// WHO SEES WHAT: the setups /new lists (the workspace's; every one for the operator) and the posts of the account shown,
// as every other page of one account. Without the page's script the block is the server's, with a link to look again.
// With it, while something runs, GET /progress.json is asked every few seconds (static/app.js data-poll): the lines
// change in place, and when an item is done the block is drawn again in place, never a reload. With nothing running
// and nothing done in the last day, there is no block.

/** How long a done item stays on home. */
export const READY_MS = DAY;
/** The most items the block lists, running ones first. */
const MAX_ITEMS = 6;

/**
 * The block's items for a request: `c` is its context (the workspace's, or the engine's for the operator), `sc` the
 * same seen from the account shown (src/web/data.js scoped). { items, busy, key }: `key` changes whenever the block would
 * be drawn otherwise (an item came, went, or changed its state); a line's progress alone does not change it.
 */
export function progressOf(c, sc, { t = now() } = {}) {
  const order = { running: 0, ready: 1, stopped: 1 };
  const items = [...onboardingWork(c, { t, within: READY_MS }), ...postWork(sc, t)]
    .sort((a, b) => order[a.state] - order[b.state] || String(b.at).localeCompare(String(a.at)))
    .slice(0, MAX_ITEMS);
  return { items, busy: items.some((x) => x.state === 'running'), key: items.map((x) => `${x.id}:${x.state}`).join('|') };
}

/** The account shown's slideshows being written, and those written in the last day that wait for approval. */
function postWork(sc, t) {
  const ids = sc.packs.map((p) => p.id);
  if (!ids.length) return [];
  const inIds = ids.map(() => '?').join(', ');
  const writing = sc.db
    .all(`SELECT id, redo_of, created_at FROM posts WHERE account_id IN (${inIds}) AND status = 'drafting' AND sample = 0 ORDER BY created_at DESC`, ...ids)
    .map((p) => ({ id: `p:${p.id}`, state: 'running', title: p.redo_of ? 'פוסט חלופי נכתב עכשיו' : 'מצגת חדשה בכתיבה', subject: '', line: p.redo_of ? 'הוא יגיע לאישור בעוד כמה דקות.' : 'תהיה מוכנה בעוד כמה דקות.', at: p.created_at }));
  const ready = sc.db
    .all(`SELECT id, hook, redo_of, created_at FROM posts WHERE account_id IN (${inIds}) AND status = 'queued' AND sample = 0 AND created_at >= ? ORDER BY created_at DESC`, ...ids, new Date(t - READY_MS).toISOString())
    .map((p) => ({ id: `p:${p.id}`, state: 'ready', title: p.redo_of ? 'הפוסט החלופי מחכה לאישור' : 'מצגת חדשה מחכה לאישור', subject: p.hook || '', line: '', href: `/post/${p.id}`, go: 'לפוסט', at: p.created_at }));
  return [...writing, ...ready];
}

/** An item's state, drawn: a turning ring while it runs, a check when it is done, a warning when it stopped. */
const MARK = { running: '<span class="spin" aria-hidden="true"></span>', ready: icon('check'), stopped: icon('alert') };

/** One item: its state, what it is, what it is about and how far it got (the line the script changes), and where to go. */
function itemHtml(x) {
  const line = x.state === 'running' ? `<span data-progress="${esc(x.id)}" aria-live="polite">${esc(x.line)}</span>` : x.line ? `<span>${esc(x.line)}</span>` : '';
  const sub = `${x.subject ? `<bdi>${esc(x.subject)}</bdi>` : ''}${line}`;
  return `<li class="${x.state}" data-item="${esc(x.id)}"><span class="ico">${MARK[x.state]}</span><span class="tx"><b>${esc(x.title)}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</span>${x.href ? `<a class="btn sm" href="${esc(x.href)}">${esc(x.go)}</a>` : ''}</li>`;
}

/** What is inside the block: the script draws it again in place from progressStatus's html. */
const inner = (p) => `<header><h2 id="inprog-h">בתהליך</h2></header>
<ul class="inprog-list">${p.items.map(itemHtml).join('')}</ul>${p.busy ? '<p class="small m6 js-hide"><a href="/">לבדוק שוב</a></p>' : ''}`;

/** The block on home, or nothing. It asks for its state only while something runs. */
export function progressPanel(p) {
  if (!p.items.length) return '';
  return `<section class="panel home-panel inprog" id="inprog" aria-labelledby="inprog-h"${p.busy ? ` data-poll="/progress.json" data-key="${esc(p.key)}" data-swap` : ''}>${inner(p)}</section>`;
}

/**
 * GET /progress.json: { busy, key, lines, items, html }. `lines` is each running item's progress line by its id (the
 * script changes those in place); `html` the block drawn again, for when `key` changed ('' when there is nothing to show).
 */
export function progressStatus(p) {
  return {
    busy: p.busy,
    key: p.key,
    lines: Object.fromEntries(p.items.filter((x) => x.state === 'running').map((x) => [x.id, x.line])),
    items: p.items.map((x) => ({ id: x.id, state: x.state, title: x.title, subject: x.subject, line: x.line, href: x.href || null, go: x.go || null })),
    html: p.items.length ? inner(p) : '',
  };
}
