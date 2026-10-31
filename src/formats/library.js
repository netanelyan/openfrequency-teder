import { KINDS } from './kinds.js';

// The formats a customer picks from (the owner, 2026-10-31: "i want the customer to pick the formats he likes. it is
// changable, and each slideshow is in a different format."). Each is one of the engine's kinds (src/formats/kinds.js),
// written for no niche in particular: the niche comes from the account's sources, voice and topics, never from here.
// A pack made from these keeps the ids, so a format the customer picks again is the same format, with its history.
//
// Left out: the meme (it stands on no photograph, and no slide may: the owner, 2026-10-31, "no slide can be empty"),
// do-dont (it draws app and form screens, for one kind of account), and the owner's story (it needs the owner's own
// facts, written down first).
//
// `he` is what the customer reads beside the name, when picking. `about` is the model's, in English.

export const LIBRARY = [
  {
    id: 'facts',
    kind: 'facts',
    name: 'עובדות שלא ידעתם',
    he: 'כמה עובדות מפתיעות על נושא אחד, והמפתיעה ביותר בסוף.',
    about: 'Surprising facts about one subject of the niche the audience follows now, counted down to the best one.',
    hooks: ['{n} דברים שלא ידעתם על {x}'],
  },
  {
    id: 'tips',
    kind: 'tips',
    name: 'רשימה לשמור',
    he: 'טיפים מעשיים שאנשים שומרים כדי להשתמש בהם אחר כך.',
    about: 'Concrete things to save and use later (steps, amounts, settings, tools), each from the guidance in the sources.',
    hooks: ['{n} דברים על {x} ששווה לשמור'],
  },
  {
    id: 'story',
    kind: 'story',
    name: 'סיפור',
    he: 'סיפור אמיתי מהתחום, לפי הסדר, והסוף בשקופית האחרונה.',
    about: 'A true story from the niche, told in order, the twist or the result on the last slide.',
    hooks: ['{מי} ש{מה קרה}, ואיך זה נגמר'],
    ctas: [{ kind: 'send', text: 'תשלחו למי שצריך לשמוע את הסיפור הזה' }],
  },
  {
    id: 'what-happened',
    kind: 'what-happened',
    name: 'מה קרה ל...',
    he: 'מישהו או משהו שכולם הכירו פעם, ומה קרה איתו מאז.',
    about: 'What happened to someone or something the audience knew well: the peak, the turn, where they are now.',
    hooks: ['פעם כולם הכירו את {x}. מה קרה?'],
    ctas: [{ kind: 'comment', text: 'זכרתם את זה? תכתבו בתגובות' }],
  },
  {
    id: 'guess-who',
    kind: 'guess-who',
    name: 'נחשו מי',
    he: 'רמזים מהקשה לקל, והתשובה בשקופית האחרונה.',
    about: 'Guess a famous person, place or thing of the niche from clues in the sources, the answer on the last slide.',
    hooks: ['תנחשו מי זה לפי {n} רמזים'],
  },
  {
    id: 'head-to-head',
    kind: 'head-to-head',
    name: 'ראש בראש',
    he: 'שניים זה מול זה במספרים, ומי יוצא מזה טוב יותר.',
    about: 'Two famous subjects of the niche side by side on numbers from the sources, and a verdict.',
    hooks: ['{a} או {b}? התשובה בשקופית האחרונה'],
    ctas: [{ kind: 'comment', text: 'מי מנצח אצלכם? תכתבו בתגובות' }],
  },
  {
    id: 'ranking',
    kind: 'ranking',
    name: 'דירוג',
    he: 'חמישייה לפי מספר אחד, והמקום הראשון בסוף.',
    about: 'A top five of the niche by one number from the sources, number one last.',
    hooks: ['5 ה{x} ש{משהו}. מנחשים מי ראשון?'],
    ctas: [{ kind: 'comment', text: 'מי היה אצלכם במקום הראשון? תכתבו בתגובות' }],
  },
  {
    id: 'myth-fact',
    kind: 'myth-fact',
    name: 'מיתוס ועובדה',
    he: 'משהו שכולם בטוחים בו, ומה המקורות אומרים באמת.',
    about: 'Two or three things people in the niche still believe, and what the sources say instead.',
    hooks: ['{n} דברים שעדיין מאמינים בהם על {x}'],
    ctas: [{ kind: 'send', text: 'תשלחו למי שעדיין מאמין בזה' }],
  },
  {
    id: 'iceberg',
    kind: 'iceberg',
    name: 'הקרחון',
    he: 'ממה שכולם יודעים ועד מה שכמעט אף אחד לא יודע.',
    about: 'What everyone knows about one subject of the niche, down to what almost nobody knows, all from the sources.',
    hooks: ['הקרחון של {x}'],
    ctas: [{ kind: 'save', text: 'תשמרו, יש פה דברים ששוכחים' }],
  },
  {
    id: 'hot-take',
    kind: 'hot-take',
    name: 'דעה',
    he: 'דעה חדה אחת, ועובדות שמחזקות אותה.',
    about: 'One opinion about the niche that many would argue with, the case made with sourced facts.',
    hooks: ['{דעה}'],
    ctas: [{ kind: 'comment', text: 'מסכימים? תכתבו למה' }],
  },
  {
    id: 'on-this-day',
    kind: 'on-this-day',
    name: 'היום לפני',
    he: 'משהו שקרה בתאריך של היום, בשנה אחרת.',
    about: 'One moment of the niche that happened on this date in an earlier year.',
    hooks: ['ב-{תאריך} {מה קרה}'],
    ctas: [{ kind: 'send', text: 'תשלחו למי שזוכר את היום הזה' }],
  },
  {
    id: 'explainer',
    name: 'הסבר בכמה שלבים',
    he: 'דבר אחד מוסבר צעד אחרי צעד.',
    about: 'One thing explained in a few steps, a fact per slide, from an approved source.',
    items: [3, 5],
    hooks: ['ככה {x} עובד באמת', '{n} דברים על {x} שכדאי לדעת'],
    closers: [{ title: 'תשמרו את זה לפעם הבאה', body: 'ותשלחו למי שזה יעזור לו' }],
  },
];

/** The fewest formats an account may run on: with fewer, two slideshows in a row would share one. */
export const MIN_PICKED = 3;
/** Ticked for a new account until the customer changes them. */
export const DEFAULT_PICKED = ['facts', 'tips', 'story', 'myth-fact', 'ranking'];

const byId = new Map(LIBRARY.map((f) => [f.id, f]));
export const libraryFormat = (id) => byId.get(id) || null;

/** The formats.json entries for these ids, in the library's order: what the engine reads (no `he`). */
export function formatsFor(ids) {
  const want = new Set(ids);
  return LIBRARY.filter((f) => want.has(f.id)).map(({ he, ...f }) => ({ ...f, weight: 1 }));
}

/** The ids of the library's formats a pack runs on, in the library's order. */
export const pickedOf = (pack) => {
  const have = new Set((pack?.formats?.formats || []).map((f) => f.id));
  return LIBRARY.filter((f) => have.has(f.id)).map((f) => f.id);
};

/** The ids a form sends (fmt_<id> = on), only the library's own, in its order. */
export const pickedFrom = (form) => LIBRARY.filter((f) => form?.[`fmt_${f.id}`]).map((f) => f.id);

/** Every library format is one of the engine's kinds (the explainer the phase 1 list). For the tests. */
export const libraryKinds = () => LIBRARY.map((f) => f.kind || 'list').filter((k) => KINDS[k]);
