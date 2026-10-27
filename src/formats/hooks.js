import { isKind, kindName, KINDS, structureNumbers } from './kinds.js';
import { normHe } from '../voice/tells.js';
import { numbersIn } from '../verify/claims.js';
import { experienceIn } from '../voice/honesty.js';

// The cover's hook templates: first-slide lines that already stopped a scroll, with slots the writer fills for the
// post in hand. The owner brought them from a Hebrew carousel that took an account to 10k followers ("הוקים שהעלו את
// העוקבים ל-10k"), and they come in four mechanisms:
//
//   secret   what nobody told them yet       "במקרה שהמאמן שלכם לא אמר לכם, ..."
//   wish     what they wish they had known   "הלוואי שהייתם יודעים את זה לפני ..."
//   truth    the real truth about it         "הנה האמת האמיתית על ..."
//   save     the time it saves them          "חוסכת לכם 3 שעות בשבוע רק בזכות ..."
//
// A template is a line with slots ({topic}, {fact}, {who}, {x}...) and gendered forms: {s:m|f|p} is the account
// speaking (חוסך, חוסכת, חוסכים: formats.json "hookTemplates.speaker", plural by default), {w:m|f|p} agrees with
// whoever fills {who} (המאמן לא אמר, המאפרת לא אמרה, ההורים לא אמרו). The writer picks the template and fills the
// slots; the code writes the line from them, so the forms are always right.
//
// The audience is addressed in the plural, as everywhere ("לכם", never "לך"), and nothing in a template claims
// an experience the account never had: "הלוואי וידעתי קודם" says the account once did not know, which is the
// invented experience hard rule 3 refuses (src/voice/honesty.js), so the wish is said to them ("הלוואי שהייתם
// יודעים") or as a wish for everyone ("החלום שלי שכולם ידעו").
//
// These lines hold the point back, and the voice rules refuse a teaser everywhere. A template is the one
// exception, and only on the cover, only when the slides pay it off (hookProblems):
//   - the writer names the facts the cover promises (hookFacts), every one verified and stated on a slide
//   - every number on the cover is in those facts' quotes (the fact gate still holds it to all of them), and an
//     {x} is such a number: "חוסכת לכם 3 שעות" with no quote that says 3 hours is refused
//   - what a slot promises ("האמת על השקיה") is what the slides are about
//   - the kind allows it: a fact on the cover gives a story's twist or a ranking's number one away, so each
//     template names the kinds it fits, and none fits a guess-who
// A template's frame anywhere else (a slide, the line under the cover, a caption), or on a cover that did not
// declare it, is refused like any teaser.
//
// A pack adds its own templates or turns some off in formats.json, without code:
//   "hookTemplates": { "speaker": "f", "who": [{ "name": "המאמן", "gender": "m" }],
//                      "disable": ["told-wrong", "save"], "add": [{ "id", "mechanism", "text", "kinds", "examples" }] }
// and "off": true turns the library off for the account. The results credit the template a post used (its
// hook_pattern is "tpl:<id>"), and the next posts favour the ones that do well (src/formats/rotation.js).

export const MECHANISMS = {
  secret: { he: 'מה שלא סיפרו לכם', about: 'what nobody told them yet' },
  wish: { he: 'הלוואי שידעתם קודם', about: 'what they wish they had known before' },
  truth: { he: 'האמת האמיתית', about: 'the real truth about something they think they know' },
  save: { he: 'חוסכים לכם זמן', about: 'the time or trouble it saves them' },
  // The cover 14 of 25 viral slideshows opened with: a count and the subject, and 8 of them said "you didn't know".
  count: { he: 'כמה דברים שלא ידעתם', about: 'a count of things about the subject they did not know' },
  // The owner's own count: the small-business slideshows that spread are the owner's mistakes and numbers.
  owner: { he: 'מה שלמדתי על בשרי', about: "the owner's own mistakes or lessons, counted" },
};

/** The slots a template can hold, as the writer is told to fill them. */
export const SLOTS = {
  topic: 'what the post is about, a short noun phrase the way the slides name it ("השקיה של פוטוס")',
  fact: "the post's most surprising fact, a short clause said the way the slides say it, from one of hookFacts",
  who: 'the one who should have told them, an authority of the niche with its article ("המאמן", "הסוכן", "השופט")',
  x: 'a real number or time from the quotes of hookFacts, with its unit ("3 שעות בשבוע"): never estimated',
  thing: 'the method or the thing that saves it, as a slide names it',
  moment: 'when, as a clause: for the audience, when they needed to know, in the plural ("שקניתם את העציץ", "ההשקיה הבאה"); in the story of the owner, when it happened to them ("בשנה הראשונה של העסק")',
  skill: 'what they should have been taught, a verb phrase ("להשקות פוטוס")',
  // Filled by the code, never the writer: the post's own count of items, which the cover may say without a quote.
  n: 'leave it "": the code writes how many items the post counts',
};

/** The slots the code fills itself (draftFromAnswer): the writer leaves them empty. */
export const CODE_SLOTS = new Set(['n']);

const SPEAKER = ['m', 'f', 'p'];
export const SPEAKER_EN = { m: 'in the masculine', f: 'in the feminine', p: 'in the plural' };

// Where a template's promise can be kept without giving the post away. A fact on the cover is fine where the
// payoff is not one withheld answer; a topic is fine anywhere but a guess-who, whose topic is its answer.
const ANY = ['story', 'what-happened', 'on-this-day', 'iceberg', 'hot-take', 'myth-fact', 'meme', 'do-dont', 'head-to-head', 'ranking', 'facts', 'tips'];
const FACT = ['myth-fact', 'do-dont', 'iceberg', 'hot-take', 'meme', 'facts', 'tips'];
const HOWTO = ['do-dont', 'myth-fact', 'iceberg', 'head-to-head', 'ranking', 'tips'];
const COUNTED = ['facts', 'iceberg', 'tips'];

export const TEMPLATES = [
  { id: 'nobody-told', mechanism: 'secret', text: 'במקרה שאף אחד עוד לא סיפר לכם, {fact}', kinds: FACT, examples: ['במקרה שאף אחד עוד לא סיפר לכם, פוטוס שורד 81 יום בלי מים'] },
  { id: 'who-told', mechanism: 'secret', text: 'במקרה ש{who} שלכם לא {w:אמר|אמרה|אמרו} לכם, {fact}', kinds: FACT, examples: ['במקרה שהמאפרת שלכם לא אמרה לכם, פריימר בא לפני הקרם'] },
  { id: 'who-taught', mechanism: 'secret', text: 'במקרה ש{who} שלכם לא {w:לימד|לימדה|לימדו} אתכם {skill}', kinds: ANY, examples: ['במקרה שאמא שלכם לא לימדה אתכם להשקות פוטוס'] },
  { id: 'wish-before', mechanism: 'wish', text: 'הלוואי שהייתם יודעים את זה לפני {moment}', kinds: ANY, examples: ['הלוואי שהייתם יודעים את זה לפני שקניתם בזיליקום'] },
  { id: 'everyone-knew', mechanism: 'wish', text: 'החלום שלי שכולם ידעו ש{fact}', kinds: FACT, examples: ['החלום שלי שכולם ידעו שעציץ בלי חור רוקב'] },
  { id: 'real-truth', mechanism: 'truth', text: 'הנה האמת האמיתית על {topic}', kinds: ANY, examples: ['הנה האמת האמיתית על השקיה של פוטוס'] },
  { id: 'told-wrong', mechanism: 'truth', text: 'האמת היא שמה שסיפרו לכם על {topic} לא נכון', kinds: ['myth-fact', 'hot-take'], examples: ['האמת היא שמה שסיפרו לכם על קקטוסים לא נכון'] },
  { id: 'reveal', mechanism: 'truth', text: '{s:אני עומד|אני עומדת|אנחנו עומדים} לחשוף את האמת על {topic}', kinds: ANY, examples: ['אני עומדת לחשוף את האמת על נענע בעציץ'] },
  { id: 'save-time', mechanism: 'save', text: 'תנו {s:לי|לי|לנו} לחסוך לכם זמן עם {topic}', kinds: HOWTO, examples: ['תנו לי לחסוך לכם זמן עם השתילה הראשונה'] },
  { id: 'save-x', mechanism: 'save', text: '{s:חוסך|חוסכת|חוסכים} לכם {x} רק בזכות {thing}', kinds: HOWTO, examples: ['חוסכת לכם 3 שעות בשבוע רק בזכות טפטפת אחת'] },
  { id: 'didnt-know', mechanism: 'count', text: '{n} דברים שלא ידעתם על {topic}', kinds: COUNTED, examples: ['7 דברים שלא ידעתם על ליגת העל'] },
  { id: 'few-know', mechanism: 'count', text: '{n} עובדות על {topic} שמעטים מכירים', kinds: COUNTED, examples: ['6 עובדות על ה-UFC שמעטים מכירים'] },
  { id: 'nobody-tells', mechanism: 'count', text: '{n} דברים על {topic} שאף אחד לא אומר לכם', kinds: ['tips', 'facts'], examples: ['5 דברים על משכנתא שאף אחד לא אומר לכם'] },
  { id: 'mistakes', mechanism: 'owner', text: '{n} טעויות {s:שעשיתי|שעשיתי|שעשינו} {moment}', kinds: ['owner-story'], examples: ['5 טעויות שעשיתי בשנה הראשונה של העסק'] },
  { id: 'after-year', mechanism: 'owner', text: 'מה {s:למדתי|למדתי|למדנו} {moment}', kinds: ['owner-story'], examples: ['מה למדתי בשנה הראשונה עם עגלת קפה'] },
];

const TOKEN = /\{(?:([sw]):([^}]*)|([a-z]+))\}/g;

/** The pack's own settings for templates (formats.json "hookTemplates"). */
const configOf = (pack) => pack?.formats?.hookTemplates || {};

/** Who the account speaks as on its covers: 'm', 'f' or 'p' (plural, the default). */
export const speakerOf = (pack) => (SPEAKER.includes(configOf(pack).speaker) ? configOf(pack).speaker : 'p');

/**
 * Every template this pack may use: the engine's (less what it disables, by id or by mechanism) and its own,
 * an own template replacing the engine's of the same id. None when the pack turned the library off.
 */
export function templatesOf(pack) {
  const c = configOf(pack);
  if (c.off) return [];
  const off = new Set((c.disable || []).map(String));
  const own = (c.add || []).filter((t) => t && t.id && t.text).map((t) => ({ id: String(t.id), mechanism: String(t.mechanism || 'secret'), text: String(t.text), kinds: (t.kinds || ANY).filter(isKind), examples: (t.examples || []).map(String), own: true }));
  const ids = new Set(own.map((t) => t.id));
  return [...TEMPLATES.filter((t) => !ids.has(t.id)), ...own].filter((t) => !off.has(t.id) && !off.has(t.mechanism));
}

/** The templates a post of this format may open with. A phase 1 list post has none. */
export const templatesFor = (pack, format) => (kindName(format) === 'list' ? [] : templatesOf(pack).filter((t) => t.kinds.includes(kindName(format))));

/** A template by its id ("save-x" or "tpl:save-x"), among those this format may use, or null. */
export function templateById(pack, format, id) {
  const want = String(id || '').replace(/^tpl:/, '');
  return want ? templatesFor(pack, format).find((t) => t.id === want) || null : null;
}

/** "tpl:<id>": what a post that opened with a template stores in hook_pattern. */
export const TPL = 'tpl:';
export const isTemplateId = (id) => String(id || '').startsWith(TPL);

/** The gender a {who} takes: the pack's list knows its authorities, else the writer said. */
export function whoGender(pack, who, said = '') {
  const known = (configOf(pack).who || []).find((w) => normHe(w.name) === normHe(who));
  if (known && SPEAKER.includes(known.gender)) return known.gender;
  return SPEAKER.includes(said) ? said : 'm';
}

const pick = (forms, g) => {
  const list = String(forms).split('|');
  return list[Math.min(SPEAKER.indexOf(g), list.length - 1)] ?? list[0];
};

/** The template in the account's voice, its slots left open: how the writer and the Results page see it. */
export const voiced = (tpl, speaker = 'p') => String(tpl.text).replace(/\{s:([^}]*)\}/g, (_, f) => pick(f, speaker));

/** A slot's text as it goes on the cover: one line, no end punctuation, no braces. */
const cleanSlot = (v) => String(v ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').replace(/^[\s,.:;?!"'״׳-]+|[\s,.:;?!"'״׳-]+$/g, '').trim();

/**
 * The cover line from a template and its slots, in the account's voice: { text, missing }. A Latin name or a
 * digit after a glued Hebrew prefix takes a hyphen ("ש-ChatGPT"), the way it is written.
 */
export function fillTemplate(tpl, slots = {}, { speaker = 'p', who = 'm' } = {}) {
  const missing = [];
  let out = '';
  let at = 0;
  for (const m of String(tpl.text).matchAll(TOKEN)) {
    out += tpl.text.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[1] === 's') out += pick(m[2], speaker);
    else if (m[1] === 'w') out += pick(m[2], who);
    else {
      const v = cleanSlot(slots[m[3]]);
      if (!v) missing.push(m[3]);
      out += /[א-ת]$/.test(out) && /^[A-Za-z0-9]/.test(v) ? `-${v}` : v;
    }
  }
  out += tpl.text.slice(at);
  return { text: out.replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim(), missing };
}

// normHe without the trim, so the spaces at the edges of a template's fixed words stay where they are.
const normPart = (s) => String(s).replace(/[֑-ׇ]/g, '').replace(/[׳״'"`]/g, '').replace(/[^\p{L}\p{N}\s%]/gu, ' ').replace(/\s+/g, ' ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The template as a pattern over normalised Hebrew: its fixed words in order, each slot captured, each gendered
 * form any of its forms (so a cover in the wrong form is still known for the template it is).
 */
export function frameOf(tpl) {
  const parts = [];
  const names = [];
  let at = 0;
  const all = [...String(tpl.text).matchAll(TOKEN)];
  all.forEach((m, i) => {
    parts.push(esc(normPart(tpl.text.slice(at, m.index))));
    at = m.index + m[0].length;
    if (m[1]) {
      parts.push(`(${String(m[2]).split('|').map((f) => esc(normPart(f).trim())).join('|')})`);
    } else {
      names.push(m[3]);
      parts.push(i === all.length - 1 && !normPart(tpl.text.slice(at)).trim() ? '(.+)' : '(.+?)');
    }
  });
  parts.push(esc(normPart(tpl.text.slice(at))));
  const src = parts.join('').replace(/ /g, ' ?').trim();
  // What each captured group is, in order: a slot, or the speaker's (s) or {who}'s (w) form.
  return { re: new RegExp(src, 'u'), names, order: all.map((m) => m[1] || 'slot') };
}

/** The template's fixed words, in the forms this cover uses: what a teaser check lets through on that cover. */
export function fixedWords(tpl, { speaker = 'p', who = 'm' } = {}) {
  return String(tpl.text)
    .replace(TOKEN, (_, k, forms) => (k === 's' ? pick(forms, speaker) : k === 'w' ? pick(forms, who) : '\u0000'))
    .split('\u0000')
    .map((x) => normHe(x))
    .filter(Boolean);
}

/** Does a text hold this template's frame? Returns its slots and forms as written, or null. */
export function matchFrame(tpl, text) {
  const f = frameOf(tpl);
  const m = f.re.exec(normHe(text));
  if (!m) return null;
  const slots = {};
  const forms = {};
  let g = 1;
  let n = 0;
  for (const k of f.order) {
    if (k === 'slot') slots[f.names[n++]] = m[g++];
    else forms[k] = m[g++];
  }
  return { slots, forms };
}

/** The template the cover opens with, as the draft declared it and the cover still shows it, or null. */
export function templateOnCover(pack, format, draft) {
  const tpl = templateById(pack, format, draft.hookTemplate?.id);
  if (!tpl) return null;
  const m = matchFrame(tpl, draft.hook);
  return m ? { tpl, ...m } : null;
}

/** What the results credit a post's cover to: its template ("tpl:<id>") while the cover still shows it, else its pattern. */
export function coverCredit(pack, format, draft) {
  const on = templateOnCover(pack, format, draft);
  if (on) return `${TPL}${on.tpl.id}`;
  return draft.hookFallback ?? (isTemplateId(draft.hookPattern) ? null : draft.hookPattern ?? null);
}

// The words of a slot that name something: three letters or more, without a one-letter prefix.
const STOP = new Set(['של', 'את', 'עם', 'על', 'כל', 'זה', 'גם', 'רק', 'לכם', 'אתכם', 'שלכם', 'אחד', 'אחת', 'יותר', 'פחות', 'הכי', 'בלי', 'לפני', 'אחרי']);
const stem = (w) => w.replace(/^(?:וה|וב|ול|ומ|וש|שה|שב|של|כש|ו|ה|ב|ל|מ|ש|כ)(?=[א-ת]{3,})/u, '');
// Final letters as their plain forms, so "עציץ" is the start of "עציצים".
const FINAL = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const contentWords = (s) => normHe(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w)).map((w) => stem(w).replace(/[ךםןףץ]/g, (c) => FINAL[c]));

/** Do these words name what the text is about? One of them is in it (a third of them, for a long slot). */
function about(slot, text) {
  const want = [...new Set(contentWords(slot))];
  if (!want.length) return true;
  const have = new Set(contentWords(text));
  const hit = want.filter((w) => have.has(w) || [...have].some((h) => h.length >= 4 && w.length >= 4 && (h.startsWith(w) || w.startsWith(h)))).length;
  return hit >= Math.max(1, Math.ceil(want.length / 3));
}

/**
 * Everything a cover template asks of the post, as { where, code, msg } for the checks (code "hook"): the frame
 * nowhere but the cover; on the cover only as a template the draft declared, for a kind it fits, in the account's
 * voice; and the promise kept by the slides (above). facts: the post's facts, with `verified`.
 */
export function hookProblems(pack, format, draft, facts = []) {
  const out = [];
  const add = (where, msg) => out.push({ where, code: 'hook', msg });
  const lib = templatesOf(pack);
  if (!lib.length || kindName(format) === 'list') return out;
  const others = [
    ['cover line 2', draft.sub],
    ...draft.slides.flatMap((s, i) => (s.kind === 'item' ? [[`slide ${i} title`, s.title], [`slide ${i} text`, s.body]] : [])),
    ['caption', draft.caption],
    ['caption short', draft.captionShort],
  ];
  for (const [where, text] of others) {
    const t = lib.find((x) => matchFrame(x, text || ''));
    if (t) add(where, `"${voiced(t, speakerOf(pack))}" is a cover template [${t.id}]: it opens the cover and nowhere else. Say what it holds back as a plain sentence here`);
  }
  const on = templateOnCover(pack, format, draft);
  if (!on) {
    // A frame the draft never declared is a teaser like any other: no promise was made to check.
    const t = lib.find((x) => matchFrame(x, draft.hook || ''));
    // A count promises its count alone, which the kind's own check holds to the slides (kindProblems): a format whose
    // cover pattern is the same line ("7 דברים שלא ידעתם על...") was blocked on a live run for not declaring it.
    if (t && t.mechanism === 'count' && t.kinds.includes(kindName(format))) return out;
    if (t && !t.kinds.includes(kindName(format))) add('cover', `the template "${t.id}" does not fit a ${kindName(format)} post: write the cover after the format's pattern`);
    else if (t) add('cover', `the cover opens like the template "${t.id}" without being written from it: write it from the template (hookTemplate, hookSlots, hookFacts) or as a plain line`);
    return out;
  }
  const { tpl, slots, forms } = on;
  // The account's own voice: the code wrote it in its form, and a rewrite may not change it.
  const speaker = speakerOf(pack);
  const sForm = /\{s:([^}]*)\}/.exec(tpl.text);
  if (sForm && forms.s && normHe(pick(sForm[1], speaker)) !== normHe(forms.s)) add('cover', `the cover speaks as "${forms.s}": this account speaks ${SPEAKER_EN[speaker]} ("${pick(sForm[1], speaker)}")`);
  const wForm = /\{w:([^}]*)\}/.exec(tpl.text);
  if (wForm && forms.w && slots.who && (configOf(pack).who || []).some((w) => normHe(w.name) === normHe(slots.who))) {
    const g = whoGender(pack, slots.who);
    if (normHe(pick(wForm[1], g)) !== normHe(forms.w)) add('cover', `"${slots.who}" takes "${pick(wForm[1], g)}", not "${forms.w}"`);
  }
  // The promise, kept by the slides.
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const keys = [...new Set((draft.hookTemplate?.facts || []).map(String))];
  const content = draft.slides.filter((s) => s.kind === 'item');
  const cited = new Set(content.flatMap((s) => s.factKeys || []));
  if (tpl.mechanism === 'count') return out;
  if (!keys.length) add('cover', `a cover written from the template "${tpl.id}" names the facts it promises (hookFacts), and the slides state them: none named`);
  const good = [];
  for (const k of keys) {
    const f = byKey.get(k);
    if (!f) add('cover', `the cover promises fact "${k}", which is not one of the post's facts`);
    else if (!f.verified) add('cover', `the cover promises fact "${k}", which failed verification`);
    else if (!cited.has(k)) add('cover', `the cover promises what "${k}" says ("${String(f.claim).slice(0, 60)}"), and no slide states it: the post must pay the cover off`);
    else good.push(f);
  }
  if (!good.length) return out;
  // Every number on the cover is the promised facts' (or the post's own count): the cover's promise, not the post's.
  const held = new Set([...structureNumbers(format, content), ...good.flatMap((f) => [...numbersIn(f.quote, { words: true, hebrew: true })])]);
  for (const x of numbersIn(`${draft.hook} ${draft.sub || ''}`, { hebrew: true })) if (!held.has(x)) add('cover', `the number ${x} on the cover is not in the quotes of the facts it promises (${keys.join(', ')})`);
  if ('x' in slots && !numbersIn(slots.x, { hebrew: true }).size) add('cover', `"${slots.x}" fills the template's X, which is a real number or time from the facts' quotes ("3 שעות בשבוע"), never a guess`);
  // What a slot promises is what the slides are about.
  const slideText = content.map((s) => `${s.title} ${s.body} ${s.a || ''} ${s.b || ''}`).join(' ');
  const promised = good.map((f) => `${f.claim} ${f.quote}`).join(' ');
  for (const k of ['topic', 'skill', 'thing']) if (slots[k] && !about(slots[k], `${slideText} ${promised}`)) add('cover', `the cover promises "${slots[k]}", and no slide is about it`);
  if (slots.fact && !about(slots.fact, promised)) add('cover', `the cover states "${slots.fact}", which the facts it promises (${keys.join(', ')}) do not say`);
  return out;
}

/** The template's fixed words on this cover, for the voice check's one exception (src/voice/tells.js, frame). */
export function coverFrame(pack, format, draft) {
  const on = templateOnCover(pack, format, draft);
  return on ? fixedWords(on.tpl, { speaker: speakerOf(pack), who: on.slots.who ? whoGender(pack, on.slots.who, draft.hookTemplate?.whoGender) : 'm' }) : [];
}

/** The templates as the pack's block tells them to the writer: every one this account may use, in its voice. */
export function templatesPrompt(pack) {
  const list = templatesOf(pack).filter((t) => t.kinds.some((k) => (pack.formats.formats || []).some((f) => kindName(f) === k)));
  if (!list.length) return '';
  const speaker = speakerOf(pack);
  const voice = (t) => voiced(t, speaker);
  const who = (configOf(pack).who || []).map((w) => `${w.name} (${w.gender})`);
  return `COVER TEMPLATES (first-slide hooks that already stopped a scroll; the request names the ones to try for each post, best first):
${list.map((t) => `- [${t.id}] ${MECHANISMS[t.mechanism]?.about || t.mechanism}: "${voice(t)}"${t.examples.length ? ` (e.g. "${t.examples[0]}")` : ''}; for ${t.kinds.join(', ')}`).join('\n')}
Writing a cover from a template: hookTemplate is its id, hookSlots fills each {slot} it has (the others ""), and the code writes the line from them in the account's voice, so the slots hold only the words that go in them, without a prefix the template already has. ${Object.entries(SLOTS).map(([k, v]) => `{${k}}: ${v}`).join('; ')}. {w:...} agrees with {who}: whoGender is "m", "f" or "p"${who.length ? `, and {who} is one of this account's: ${who.join(', ')}` : ''}. hookFacts: the ids of the facts the cover promises; every one is stated on a slide, and every number on the cover is in their quotes. A template holds the point back, so the slides must deliver it: "the real truth about X" needs a slide that states that truth from its quote, "saves you X" needs X in a quote and the slide that shows how. A template is for the cover only: never its words on a slide, the line under the cover or a caption. When no template offered fits what the facts can deliver, hookTemplate is "" and the cover follows the COVER PATTERN.`;
}

/** What validation says about a pack's "hookTemplates" (formats.json). */
export function templateConfigProblems(cfg) {
  const p = [];
  if (cfg == null) return p;
  const where = 'formats.json: hookTemplates';
  if (typeof cfg !== 'object' || Array.isArray(cfg)) return [`${where} is an object`];
  if (cfg.speaker != null && !SPEAKER.includes(cfg.speaker)) p.push(`${where}.speaker is "m", "f" or "p" (who the account speaks as on its covers)`);
  for (const w of cfg.who || []) if (!String(w?.name || '').trim() || !/[א-ת]/.test(w.name) || !SPEAKER.includes(w.gender)) p.push(`${where}.who: each is { "name": in Hebrew, "gender": "m", "f" or "p" }`);
  const known = new Set([...TEMPLATES.map((t) => t.id), ...Object.keys(MECHANISMS), ...(cfg.add || []).map((t) => String(t?.id))]);
  for (const d of cfg.disable || []) if (!known.has(String(d))) p.push(`${where}.disable: "${d}" is neither a template nor a mechanism (${Object.keys(MECHANISMS).join(', ')})`);
  const ids = new Set();
  for (const t of cfg.add || []) {
    const at = `${where}.add "${t?.id}"`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(t?.id || '')) || ids.has(t.id)) p.push(`${at}: id is lowercase letters, digits and dashes, and unique`);
    ids.add(t?.id);
    if (!MECHANISMS[t?.mechanism]) p.push(`${at}: mechanism is one of ${Object.keys(MECHANISMS).join(', ')}`);
    const text = String(t?.text || '');
    const tokens = [...text.matchAll(TOKEN)];
    const bad = tokens.filter((m) => (m[3] && !SLOTS[m[3]]) || (m[1] && String(m[2]).split('|').length < 2));
    if (bad.length) p.push(`${at}: ${bad.map((m) => m[0]).join(', ')} is not a slot (${Object.keys(SLOTS).join(', ')}) or a form like {s:חוסך|חוסכת|חוסכים}`);
    if (!tokens.some((m) => m[3])) p.push(`${at}: a template has at least one slot, or there is nothing to fill`);
    if (/\{(?![a-z]+\}|[sw]:)/.test(text)) p.push(`${at}: a brace that opens no slot`);
    const fixed = normHe(text.replace(TOKEN, ' ')).split(' ').filter(Boolean);
    if (fixed.length < 2) p.push(`${at}: at least two fixed words, so the template is known wherever it is used`);
    if (/\.\.\.|…|:/.test(text)) p.push(`${at}: no ellipsis and no colon (the cover is one sentence)`);
    if (/(?:^|\s)(?:לך|שלך|אותך|אתה)(?=\s|,|$)/.test(text)) p.push(`${at}: the audience is addressed in the plural ("לכם", "שלכם", "אתכם")`);
    const exp = experienceIn(text.replace(TOKEN, ' '));
    if (exp) p.push(`${at}: "${exp}" claims an experience the account never had`);
    for (const k of t?.kinds || []) if (!isKind(k) || k === 'list') p.push(`${at}: kinds: "${k}" is not one of ${Object.keys(KINDS).filter((x) => x !== 'list').join(', ')}`);
    if ((t?.kinds || []).includes('guess-who')) p.push(`${at}: a guess-who's subject is its answer, and a template names it on the cover`);
  }
  return p;
}
