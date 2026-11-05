import { nowIso, now } from '../core/clock.js';
import { audit } from '../core/store.js';
import { requestDemo } from '../demos/build.js';
import { DemoError } from '../demos/store.js';
import { CHANNELS, CHANNEL_HE, reachLinks, reminderFrom, reminderReady, TEDER_COLD_FIRST, TEDER_REMINDER } from '../leads/messages.js';
import { lastSync, leadsSource, refreshStages, syncLeads } from '../leads/sync.js';
import { ActionError } from './actions.js';
import { running, startBuild } from './demos.js';
import { LOGOS } from './logos.js';
import { csrfField, esc, icon, layout, postButton, stamp } from './ui.js';

// The operator's leads: stores Toran found (src/leads/sync.js), each offered Teder by hand, one step at a time.
//
//   GET  /leads                    the stores of one stage (?tab=), each a card with its one next step
//   GET  /leads/status.json        while a demo is being built: whether it still is, for the page's script
//   POST /leads/sync               ask Toran now, without waiting for the hour
//   POST /leads/<id>/demo          build the store's demo: on this click only, since each one costs the writer's
//                                  calls. The demo is the website's kind (src/demos), with no WhatsApp number and its
//                                  origin 'outreach'; a store that already has one is linked to it instead
//   POST /leads/<id>/sent          the first message went, and which way (via)
//   POST /leads/<id>/reminded      the one reminder went
//   POST /leads/<id>/replied|joined|irrelevant|back   where the store is now; back undoes "לא רלוונטי"
//   POST /leads/<id>/notes         the operator's note
//
// The operator's alone, like /demos: anyone else is told there is no such page (server.js), and a button is refused
// with the same 404; the operator viewing as a customer is read-only and changes nothing (server.js refuses the POST).

export const STAGE_HE = { new: 'חדש', demo_ready: 'דמו מוכן', sent: 'נשלח', opened: 'פתחו', replied: 'ענו', joined: 'הצטרפו', irrelevant: 'לא רלוונטי' };

/** The tabs, in order: [key, label, the stages in it]. */
export const TABS = [
  ['new', 'חדש', ['new']],
  ['ready', 'דמו מוכן', ['demo_ready']],
  ['sent', 'נשלח', ['sent']],
  ['opened', 'פתחו', ['opened']],
  ['replied', 'ענו והצטרפו', ['replied', 'joined']],
  ['irrelevant', 'לא רלוונטי', ['irrelevant']],
];
const SHOWN = 200;

const operatorOnly = (user) => {
  if (!user.operator) throw new ActionError('אין דבר כזה', 404);
};

// The lead's own words for what Toran is doing with the same store (openfrequency-toran src/web/ui.ts STATUS_HE).
const TORAN_HE = { sent: 'תורן כבר כתב להם', opened: 'פתחו את הדמו של תורן', demo_started: 'ניסו את הדמו של תורן', pilot: 'בהקמה של תורן', paid: 'לקוחות של תורן', skipped: 'תורן דילג עליהם' };

const SOCIAL = Object.fromEntries(LOGOS.filter((l) => ['instagram', 'tiktok', 'facebook'].includes(l.key)).map((l) => [l.key, l]));
const socialIcon = (key) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SOCIAL[key].path}"/></svg>`;

/** The leads that are shown (not opted out), with their demo's state and its opens since the message went. */
function leadRows(db, stages) {
  return db.all(
    `SELECT l.*, d.status AS demo_status, d.slug AS demo_slug, d.error AS demo_error,
            (SELECT COUNT(*) FROM demo_opens o WHERE o.demo_id = l.demo_id AND l.sent_at IS NOT NULL AND o.at >= l.sent_at) AS opens,
            (SELECT MAX(o.at) FROM demo_opens o WHERE o.demo_id = l.demo_id AND l.sent_at IS NOT NULL AND o.at >= l.sent_at) AS last_open_at
       FROM leads l LEFT JOIN demos d ON d.id = l.demo_id
      WHERE l.opted_out_at IS NULL AND l.stage IN (${stages.map(() => '?').join(', ')})
      ORDER BY (l.tiktok IS NOT NULL OR l.instagram IS NOT NULL) DESC, l.score DESC NULLS LAST, l.updated_at DESC, l.id DESC
      LIMIT ${SHOWN}`,
    ...stages
  );
}

const counts = (db) => Object.fromEntries(db.all('SELECT stage, COUNT(*) AS n FROM leads WHERE opted_out_at IS NULL GROUP BY stage').map((r) => [r.stage, r.n]));

/** The demo page's address, as the store opens it. */
const pageUrl = (origin, lead) => (lead.demo_status === 'approved' && lead.demo_slug ? `${origin}/s/${lead.demo_slug}` : null);

const times = (n) => (n === 1 ? 'פעם אחת' : n === 2 ? 'פעמיים' : `${n} פעמים`);

/** Where the store is on social: a link a network, TikTok and Instagram first, the ones a Teder lead is better for. */
function socialLinks(lead) {
  const nets = ['tiktok', 'instagram', 'facebook'].filter((k) => lead[k]);
  if (!nets.length) return '';
  return `<ul class="lead-social" aria-label="ברשתות">${nets.map((k) => `<li><a href="${esc(lead[k])}" target="_blank" rel="noopener noreferrer" title="${esc(CHANNEL_HE[k])}" aria-label="${esc(CHANNEL_HE[k])}">${socialIcon(k)}</a></li>`).join('')}</ul>`;
}

/** "בטיקטוק ובאינסטגרם": the networks the store already posts on that Teder writes for. */
function onNets(lead) {
  const he = [lead.tiktok ? 'טיקטוק' : null, lead.instagram ? 'אינסטגרם' : null].filter(Boolean);
  return he.length ? `<span class="chip sig">כבר ב${he.join(' וב')}</span>` : '';
}

/** The message, to copy, and a button for every way to reach the store: the first one the card's one blue button. */
function reachBox(lead, text, id, { lead: leadWith = null } = {}) {
  const links = reachLinks(lead, text);
  // The way the first message went comes first for the reminder.
  if (leadWith) links.sort((a, b) => (b.via === leadWith) - (a.via === leadWith));
  const buttons = links
    .map((l, i) => `<a class="btn${i === 0 ? ' primary' : ''}" href="${esc(l.href)}" data-copy="#${id}"${/^https:/.test(l.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.label)}</a>`)
    .join('');
  return `<label class="f">${leadWith ? 'התזכורת' : 'ההודעה'}<textarea id="${id}" rows="9" readonly dir="rtl">${esc(text)}</textarea></label>
${buttons ? `<div class="lead-reach">${buttons}</div>${links.some((l) => !l.prefilled) ? '<p class="muted small">בטלפון וברשתות ההודעה לא נכתבת לבד. הכפתור מעתיק אותה, ואפשר גם להעתיק מכאן.</p>' : ''}` : '<p class="muted small">לא מצאנו לחנות וואטסאפ, מייל, טלפון או פרופיל ברשתות. אפשר לחפש באתר שלה ולהעתיק את ההודעה מכאן.</p>'}`;
}

/** The form that says which way it went: the card's blue button when the store has no way to reach it to press first. */
function sentForm(ctx, lead, action, label) {
  const ways = [...CHANNELS.filter((c) => lead[c]), 'other'];
  return `<form method="post" action="/leads/${lead.id}/${action}" class="lead-sent">${csrfField(ctx)}<label class="sr" for="via-${lead.id}">איך שלחתם</label><select id="via-${lead.id}" name="via">${ways.map((w) => `<option value="${w}"${w === lead.sent_via ? ' selected' : ''}>${esc(CHANNEL_HE[w])}</option>`).join('')}</select><button class="btn${ways.length === 1 ? ' primary' : ''}" type="submit">${label}</button></form>`;
}

/** The card's own part for its stage: what is known, and its one next step (main, the blue button). Returns { body, main }. */
function stagePart(ctx, lead, { origin, t }) {
  const id = lead.id;
  const name = lead.name || lead.domain;
  const btn = (act, label, cls = 'btn') => postButton(ctx, `/leads/${id}/${act}`, label, { cls });
  if (lead.stage === 'new') {
    const st = lead.demo_status;
    if (st === 'new' || st === 'building') return { body: '<p class="lead-state"><span class="spin" aria-hidden="true"></span>בונים את הדמו. זה לוקח כמה דקות, והכרטיס יתעדכן לבד.</p>', main: '' };
    if (st === 'failed') return { body: `<p class="err">הדמו לא נבנה: ${esc(lead.demo_error || 'לא ידוע למה')}</p>`, main: btn('demo', 'לנסות שוב', 'btn primary') };
    if (st === 'ready') return { body: '<p>הדמו מוכן ומחכה לבדיקה שלכם לפני שהעמוד שלו עולה.</p>', main: `<a class="btn primary" href="/demos/${esc(lead.demo_id)}">לבדוק את הדמו</a>` };
    return { body: '<p class="muted">הדמו נבנה רק כשלוחצים: מצגת אחת על נושא מהתחום של החנות, ועמוד שאפשר לשלוח לה.</p>', main: btn('demo', 'לבנות דמו', 'btn primary') };
  }
  const url = pageUrl(origin, lead);
  if (lead.stage === 'demo_ready') {
    if (!url) return { body: '<p class="muted">העמוד של הדמו לא באוויר.</p>', main: '' };
    return { body: `${reachBox(lead, TEDER_COLD_FIRST({ storeName: name, url }), `msg-${id}`)}<p class="small"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">לראות את העמוד של החנות</a></p>`, main: sentForm(ctx, lead, 'sent', 'שלחתי') };
  }
  if (lead.stage === 'sent' || lead.stage === 'opened') {
    const opened = lead.opens ? `<p>העמוד נפתח ${esc(times(lead.opens))} מאז, לאחרונה ${esc(stamp(lead.last_open_at))}.</p>` : '';
    const sent = `<p>נשלח${lead.sent_via ? ` ב${esc(CHANNEL_HE[lead.sent_via])}` : ''} ב־${esc(stamp(lead.sent_at))}.</p>${opened}`;
    if (lead.reminder_sent_at) return { body: `${sent}<p class="muted">התזכורת נשלחה ב־${esc(stamp(lead.reminder_sent_at))}. מכאן לא כותבים להם יותר, אלא אם הם עונים.</p>`, main: btn('replied', 'ענו', 'btn primary') };
    if (url && reminderReady(lead.sent_at, t)) {
      return { body: `${sent}${reachBox(lead, TEDER_REMINDER({ storeName: name, url }), `rem-${id}`, { lead: lead.sent_via })}`, main: sentForm(ctx, lead, 'reminded', 'שלחתי את התזכורת') };
    }
    const later = url ? `<p class="muted">התזכורת האחת תהיה מוכנה ב־${esc(stamp(reminderFrom(lead.sent_at, t)))}.</p>` : '<p class="muted">העמוד של הדמו כבר לא באוויר, אז אין למה לשלוח תזכורת.</p>';
    return { body: `${sent}${later}`, main: btn('replied', 'ענו', 'btn primary') };
  }
  if (lead.stage === 'replied') return { body: `<p>ענו לכם.${lead.sent_at ? ` ההודעה נשלחה ב־${esc(stamp(lead.sent_at))}.` : ''}</p>`, main: btn('joined', 'הצטרפו', 'btn primary') };
  if (lead.stage === 'joined') return { body: '<p>הצטרפו לתדר.</p>', main: '' };
  return { body: `<p class="muted">סימנתם${lead.skipped_at ? ` ב־${esc(stamp(lead.skipped_at))}` : ''} שזה לא רלוונטי.</p>`, main: btn('back', 'להחזיר לרשימה') };
}

/** One store: who it is and where, its step, and the moves every card has. */
function leadCard(ctx, lead, opts) {
  const { body, main } = stagePart(ctx, lead, opts);
  const name = lead.name || lead.domain;
  const meta = [
    lead.platform ? `<span class="chip">${esc(lead.platform)}</span>` : '',
    lead.score != null ? `<span class="chip">ציון <span class="num">${esc(Math.round(lead.score))}</span></span>` : '',
    onNets(lead),
    TORAN_HE[lead.toran_status] ? `<span class="chip warn">${esc(TORAN_HE[lead.toran_status])}</span>` : '',
  ].join('');
  // The moves every card has, apart from the one that is the card's main step.
  const mainAct = /\/leads\/\d+\/(\w+)"/.exec(main)?.[1];
  const moves = [
    ['replied', 'ענו'],
    ['joined', 'הצטרפו'],
    ['irrelevant', 'לא רלוונטי'],
  ]
    .filter(([act]) => act !== lead.stage && act !== mainAct && !(act === 'replied' && lead.stage === 'joined'))
    .map(([act, label]) => postButton(ctx, `/leads/${lead.id}/${act}`, label, { cls: 'btn sm' }))
    .join('');
  const notes = `<details class="lead-notes"><summary>${lead.notes ? 'לערוך את ההערה' : 'להוסיף הערה'}</summary><form method="post" action="/leads/${lead.id}/notes">${csrfField(ctx)}<label class="sr" for="notes-${lead.id}">הערה</label><textarea id="notes-${lead.id}" name="notes" rows="3" maxlength="2000">${esc(lead.notes || '')}</textarea><button class="btn sm" type="submit">לשמור</button></form></details>`;
  return `<article class="card lead" id="lead-${lead.id}">
<header><div><h2><a href="${esc(lead.url)}" target="_blank" rel="noopener noreferrer"><bdi>${esc(name)}</bdi></a></h2>${lead.name ? `<span class="muted small ltr">${esc(lead.domain)}</span>` : ''}</div>${socialLinks(lead)}</header>
${meta ? `<p class="meta">${meta}</p>` : ''}
${lead.notes ? `<p class="lead-note">${esc(lead.notes)}</p>` : ''}
<div class="lead-body">${body}</div>
${main ? `<div class="lead-do">${main}</div>` : ''}
<div class="lead-more">${moves}${notes}</div>
</article>`;
}

/** What the page says about Toran's list: why it is not coming, or that the last try failed, or when it came. */
function syncLine(ctx, db, env) {
  const src = leadsSource(env);
  if (!src.url) {
    const why = src.why === 'off'
      ? 'OF_TORAN_INTERNAL מוגדר off, אז תדר לא שואל את תורן על החנויות.'
      : 'חסר OF_INTERNAL_TOKEN בשרת הזה, אז תדר לא יכול לשאול את תורן על החנויות.';
    return `<div class="banner warn" role="status">${icon('alert')}<div><b>הלידים לא מגיעים מתורן</b><p>${why} אחרי שמגדירים אותו ומפעילים מחדש את תדר, הרשימה מתעדכנת כל שעה.</p></div></div>`;
  }
  const last = lastSync(db);
  if (last && !last.ok && last.error) {
    return `<div class="banner bad" role="status">${icon('alert')}<div><b>העדכון האחרון מתורן לא הצליח</b><p>${esc(stamp(last.at))}: <bdi>${esc(last.error)}</bdi>. ננסה שוב בעוד שעה, ואפשר גם עכשיו.</p></div>${postButton(ctx, '/leads/sync', 'לנסות עכשיו', { cls: 'btn sm' })}</div>`;
  }
  return '';
}

function leadsPage(ctx, pc, q, env) {
  const { db } = ctx;
  const t = now();
  refreshStages(ctx);
  const tab = TABS.find(([k]) => k === q.tab) || TABS[0];
  const n = counts(db);
  const tabCount = (stages) => stages.reduce((s, x) => s + (n[x] || 0), 0);
  const tabs = `<nav class="tabs" aria-label="שלבים">${TABS.map(([k, label, stages]) => `<a href="/leads?tab=${k}"${k === tab[0] ? ' aria-current="true"' : ''}>${esc(label)}<span class="num">${tabCount(stages)}</span></a>`).join('')}</nav>`;
  const rows = leadRows(db, tab[2]);
  const opts = { origin: pc.origin || '', t };
  const cards = rows.map((l) => leadCard(pc, l, opts));
  const building = rows.some((l) => l.stage === 'new' && ['new', 'building'].includes(l.demo_status));
  const last = lastSync(db);
  const total = tabCount(tab[2]);
  const empty = {
    new: ['אין חנויות חדשות', leadsSource(env).url ? 'חנות שתורן מוצא מופיעה כאן, עד שעה אחרי שהוא מוצא אותה.' : 'החנויות יגיעו מתורן כשהחיבור אליו יוגדר.'],
    ready: ['אין דמו שמחכה לשליחה', 'חנות שהדמו שלה מוכן עוברת לכאן לבד.'],
    sent: ['עוד לא שלחתם לאף חנות', 'אחרי "שלחתי" החנות מחכה כאן לתשובה, ואחרי ארבעה ימים יש לה תזכורת אחת.'],
    opened: ['אף חנות עוד לא פתחה את העמוד', 'חנות שפותחת את העמוד שקיבלה עוברת לכאן לבד.'],
    replied: ['עוד אין תשובות', 'חנות שענתה או הצטרפה מסומנת מהכרטיס שלה.'],
    irrelevant: ['אין כאן כלום', 'חנות שסימנתם שהיא לא רלוונטית עוברת לכאן, ואפשר להחזיר אותה.'],
  }[tab[0]];
  const list = cards.length
    ? `<div class="posts leads">${cards.join('\n')}</div>${total > SHOWN ? `<p class="muted small mt12">מוצגות ${SHOWN} הראשונות מתוך ${total}.</p>` : ''}`
    : `<div class="empty">${icon('inbox')}<b>${esc(empty[0])}</b><span>${esc(empty[1])}</span></div>`;
  const poll = building ? `<div data-poll="/leads/status.json" data-key="${esc(buildKey(db))}" data-href="/leads?tab=${tab[0]}" hidden></div>` : '';
  const body = `<div class="head"><div><h1>לידים</h1></div><div class="end">${leadsSource(env).url ? postButton(pc, '/leads/sync', 'לעדכן מתורן', { cls: 'btn sm' }) : ''}</div>
<p class="sub">חנויות שתורן מצא ודירג. בונים לחנות דמו של תדר, שולחים לה את העמוד שלו מהטלפון, ומסמנים כאן מה קרה.${last?.ok ? ` עודכן מתורן ${esc(stamp(last.at))}.` : ''}</p></div>
${syncLine(pc, db, env)}
${tabs}
${poll}
${list}`;
  return layout({ ...pc, title: 'לידים', active: 'leads' }, body);
}

/** What changes while demos are being built: their ids and states. */
const buildKey = (db) =>
  db
    .all("SELECT d.id, d.status FROM leads l JOIN demos d ON d.id = l.demo_id WHERE l.stage = 'new' AND d.status IN ('new', 'building') ORDER BY d.id")
    .map((r) => `${r.id}:${r.status}`)
    .join(',') || 'none';

const leadOf = (ctx, id) => {
  const l = ctx.db.get('SELECT * FROM leads WHERE id = ? AND opted_out_at IS NULL', Number(id));
  if (!l) throw new ActionError('אין ליד כזה', 404);
  return l;
};
const setLead = (ctx, id, patch) => ctx.db.update('leads', id, { ...patch, updated_at: nowIso() });
const back = (lead, tab) => `/leads?tab=${tab}#lead-${lead.id}`;

/** Build (or link) the store's demo, on the operator's click. */
function buildFor(ctx, user, lead) {
  const { db } = ctx;
  const linked = lead.demo_id ? db.get('SELECT * FROM demos WHERE id = ?', lead.demo_id) : null;
  if (linked && ['new', 'building'].includes(linked.status) && running.has(linked.id)) throw new ActionError('הדמו של החנות הזו נבנה עכשיו');
  if (linked && ['approved', 'ready'].includes(linked.status)) throw new ActionError('לחנות הזו כבר יש דמו');
  let demo = linked && linked.status !== 'removed' ? linked : null;
  if (!demo) {
    try {
      // No WhatsApp number: nobody asked. The website's demos ask with one (intake), and theirs is kept as it is.
      demo = requestDemo(db, { url: lead.url, origin: 'outreach' }).demo;
    } catch (e) {
      if (e instanceof DemoError) throw new ActionError(e.message);
      throw e;
    }
  }
  setLead(ctx, lead.id, { demo_id: demo.id });
  if (demo.status === 'approved' || demo.status === 'ready') return { ok: true, message: 'לחנות הזו כבר היה דמו, והוא מחובר אליה עכשיו', redirect: back(lead, demo.status === 'approved' ? 'ready' : 'new') };
  // A build that a restart cut off (still marked building, with nothing running) starts again, like a failed one.
  if (!running.has(demo.id)) startBuild(ctx, demo.id);
  audit(db, { actor: user.name, action: 'lead_demo', detail: { lead: lead.id, domain: lead.domain, demo: demo.id } });
  return { ok: true, message: 'בונים את הדמו. זה לוקח כמה דקות.', redirect: back(lead, 'new') };
}

const MOVES = {
  replied: { stage: 'replied', tab: 'replied', message: 'סומן שענו' },
  joined: { stage: 'joined', tab: 'replied', message: 'סומן שהצטרפו' },
  irrelevant: { stage: 'irrelevant', tab: 'irrelevant', message: 'סומן שזה לא רלוונטי', at: 'skipped_at' },
};

/** Where a lead goes back to from "לא רלוונטי": where it was by what happened to it. */
const naturalStage = (db, lead) => {
  if (lead.sent_at) return db.get('SELECT 1 FROM demo_opens WHERE demo_id = ? AND at >= ?', lead.demo_id, lead.sent_at) ? 'opened' : 'sent';
  return lead.demo_id && db.get("SELECT 1 FROM demos WHERE id = ? AND status = 'approved'", lead.demo_id) ? 'demo_ready' : 'new';
};
const TAB_OF = Object.fromEntries(TABS.flatMap(([k, , stages]) => stages.map((s) => [s, k])));

export function leadsRoutes({ env = process.env } = {}) {
  return [
    ['GET', /^\/leads$/, (ctx, user, _m, q, pc) => (operatorOnly(user), leadsPage(ctx, pc, q, env))],
    [
      'GET',
      /^\/leads\/status\.json$/,
      (ctx, user) => {
        operatorOnly(user);
        refreshStages(ctx);
        const key = buildKey(ctx.db);
        return { json: { key, busy: key !== 'none', line: key === 'none' ? 'הדמו מוכן.' : 'בונים דמו. הדף יתעדכן כשהוא מוכן.' } };
      },
    ],
    [
      'POST',
      /^\/leads\/sync$/,
      async (ctx, user) => {
        operatorOnly(user);
        const r = await syncLeads(ctx, { env });
        if (r.why) throw new ActionError('החיבור לתורן לא מוגדר בשרת הזה');
        if (r.error) throw new ActionError('תורן לא ענה. ננסה שוב בעוד שעה.', 502);
        return { ok: true, message: r.added === 1 ? 'נוספה חנות אחת' : r.added ? `נוספו ${r.added} חנויות` : 'הרשימה מעודכנת', redirect: '/leads' };
      },
    ],
    [
      'POST',
      /^\/leads\/(\d+)\/(demo|sent|reminded|replied|joined|irrelevant|back|notes)$/,
      (ctx, user, m, f) => {
        operatorOnly(user);
        const lead = leadOf(ctx, m[1]);
        const act = m[2];
        if (act === 'demo') {
          if (lead.stage !== 'new') throw new ActionError('לחנות הזו כבר יש דמו');
          return buildFor(ctx, user, lead);
        }
        if (act === 'notes') {
          setLead(ctx, lead.id, { notes: String(f.notes ?? '').trim().slice(0, 2000) || null });
          return { ok: true, message: 'ההערה נשמרה', redirect: back(lead, TAB_OF[lead.stage]) };
        }
        if (act === 'sent' || act === 'reminded') {
          const via = [...CHANNELS, 'other'].includes(f.via) ? f.via : null;
          if (!via) throw new ActionError('צריך לבחור איך שלחתם');
          if (act === 'sent') {
            if (lead.stage !== 'demo_ready') throw new ActionError('אפשר לסמן "שלחתי" רק כשהדמו מוכן');
            setLead(ctx, lead.id, { stage: 'sent', sent_at: nowIso(), sent_via: via });
            audit(ctx.db, { actor: user.name, action: 'lead_sent', detail: { lead: lead.id, domain: lead.domain, via } });
            return { ok: true, message: 'סומן שנשלח', redirect: back(lead, 'sent') };
          }
          if (!['sent', 'opened'].includes(lead.stage) || !lead.sent_at) throw new ActionError('אין לחנות הזו תזכורת לשלוח');
          if (lead.reminder_sent_at) throw new ActionError('התזכורת לחנות הזו כבר נשלחה');
          if (!reminderReady(lead.sent_at, now())) throw new ActionError('עוד לא הזמן לתזכורת');
          setLead(ctx, lead.id, { reminder_sent_at: nowIso() });
          audit(ctx.db, { actor: user.name, action: 'lead_reminded', detail: { lead: lead.id, domain: lead.domain, via } });
          return { ok: true, message: 'סומן שהתזכורת נשלחה', redirect: back(lead, TAB_OF[lead.stage]) };
        }
        if (act === 'back') {
          if (lead.stage !== 'irrelevant') throw new ActionError('החנות הזו כבר ברשימה');
          const stage = naturalStage(ctx.db, lead);
          setLead(ctx, lead.id, { stage, skipped_at: null });
          return { ok: true, message: 'החנות חזרה לרשימה', redirect: back(lead, TAB_OF[stage]) };
        }
        const move = MOVES[act];
        if (lead.stage === move.stage) throw new ActionError('החנות כבר מסומנת כך');
        setLead(ctx, lead.id, { stage: move.stage, ...(move.at ? { [move.at]: nowIso() } : {}) });
        audit(ctx.db, { actor: user.name, action: `lead_${act}`, detail: { lead: lead.id, domain: lead.domain } });
        return { ok: true, message: move.message, redirect: back(lead, move.tab) };
      },
    ],
  ];
}
