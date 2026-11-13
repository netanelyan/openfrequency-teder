// What a customer reads when the checks refuse an edit of a post (src/web/actions.js edit, removeSlide): where in the
// post, in the edit form's own words, and what to do, in plain Hebrew. The checks speak English to the writer and to us
// (src/pipeline/build.js checkPost, src/voice/tells.js, src/verify/claims.js gate, src/rules/caption.js): a customer
// read "cover: an exclamation mark" and "slide 2 title: the title is over 70 characters" (the audit, 2026-11-12, P1-2).
// The operator on their own pages keeps the English.
//
// A problem is { where, code, msg } as checkPost gives it; the fact gate's carry their own place at the start of msg
// ("slide 2: the number 12 is not in the quotes it cites"). What has no line of its own here gets one general line,
// with its place: something in the wording the checks do not take, try it another way, and write to us if it comes back.

/** The places, as the edit form names them: the cover is "שקף הפתיחה", the content slides "שקף 1", "שקף 2"... */
function placeHe(where, { igCaption = false } = {}) {
  const w = String(where || '').trim();
  let m;
  if (/^cover line 2$/.test(w)) return 'השורה השנייה בשקף הפתיחה';
  if (/^cover tiktok$/.test(w)) return 'הכותרת לטיקטוק';
  if (/^(the )?cover$/.test(w)) return 'שקף הפתיחה';
  if ((m = /^slide (\d+) title$/.exec(w))) return `שקף ${m[1]}, הכותרת`;
  if ((m = /^slide (\d+) text$/.exec(w))) return `שקף ${m[1]}, הטקסט`;
  if ((m = /^slide (\d+)$/.exec(w))) return `שקף ${m[1]}`;
  if (/^(the )?caption$/.test(w)) return igCaption ? 'הכיתוב לטיקטוק' : 'הכיתוב';
  if (/^caption short$/.test(w)) return 'הכיתוב לאינסטגרם';
  if (/^hashtags$/.test(w)) return 'ההאשטגים';
  return '';
}

/** Said when a problem has no line of its own: what to do, and that we want to hear when it comes back. */
export const OTHER_HE = 'יש כאן ניסוח שהבדיקות שלנו לא מקבלות. נסו לנסח אחרת, ואם זה חוזר, כתבו לנו.';
/** The fact check of a changed text (src/voice/review.js factProblem): it says more than the slide's facts. */
export const MORE_THAN_FACTS_HE = 'כתוב כאן יותר ממה שהעובדות של הפוסט אומרות. מנסחים קרוב יותר לעובדה.';

const LATIN = /[A-Za-z]{4,}/;

// Each line by what the check said, in order: the first that matches is the one shown.
const LINES = [
  [/the (?:visual's )?number (\S+) is not in/, (m) => `המספר ${m[1]} לא מופיע בציטוט מהמקור. מוחקים אותו, או כותבים מספר שמופיע שם.`],
  [/states no sourced fact/, () => 'אין בו עובדה מהמקורות. כותבים בו משהו שמופיע בעובדות של הפוסט.'],
  [/is what .+ said or reported/, () => 'זה משהו שמישהו אמר. כותבים בשם מי זה נאמר, למשל "לפי..." או "...סיפר".'],
  [/the title is over (\d+) characters/, (m) => `הכותרת ארוכה מ-${m[1]} תווים.`],
  [/the text is over (\d+) characters/, (m) => `הטקסט ארוך מ-${m[1]} תווים.`],
  [/caption is (\d+) characters: it needs (\d+) or more/, (m) => `הכיתוב קצר מדי. יש בו ${m[1]} תווים, וצריך לפחות ${m[2]}.`],
  [/caption is over (\d+) characters/, (m) => `הכיתוב ארוך מ-${m[1]} תווים.`],
  [/\(captionShort\) is missing/, () => 'חסר הכיתוב לאינסטגרם.'],
  [/^(\d+) hashtags: (\d+) at most/, (m) => `יש ${m[1]} האשטגים, ואפשר עד ${m[2]}.`],
  [/a hashtag in the caption/, () => 'יש האשטג בתוך הכיתוב. מורידים אותו: תדר מוסיף את ההאשטגים של הפוסט בסוף.'],
  [/^not a hashtag/, () => 'אחד ההאשטגים לא כתוב כמו האשטג.'],
  [/an exclamation mark/, () => 'יש סימן קריאה. מורידים אותו.'],
  [/a long dash/, () => 'יש קו ארוך. מחליפים אותו בפסיק או במקף.'],
  [/a semicolon/, () => 'יש נקודה ופסיק. מחליפים אותם בנקודה או בפסיק.'],
  [/trails off with an ellipsis/, () => 'יש שלוש נקודות. מסיימים את המשפט בנקודה.'],
  [/stacked question marks/, () => 'יש כמה סימני שאלה ברצף. משאירים אחד.'],
  [/a colon in a heading/, () => 'יש נקודתיים בכותרת. כותבים אותה כמשפט אחד, או כשאלה.'],
  [/a colon after a whole clause/, () => 'יש נקודתיים אחרי משפט שלם. כותבים את זה כמשפט רגיל.'],
  [/a label and a colon/, () => 'יש מילה עם נקודתיים בפתיחה. כותבים את זה כמשפט.'],
  [/a gendered slash/, () => 'יש לוכסן של זכר ונקבה. פונים ברבים.'],
  [/letters spaced out/, () => 'יש מילה באותיות מרווחות. כותבים אותה רגיל.'],
  [/the formal imperative/, () => 'יש פנייה בלשון רשמית. כותבים כמו שמדברים.'],
  [/mixes Hebrew and Latin letters/, () => 'יש מילה שמערבבת אותיות בעברית ובאנגלית. כותבים אותה בעברית.'],
  [/a web address/, () => 'יש כתובת של אתר. בפוסט אי אפשר ללחוץ עליה, אז מורידים אותה.'],
  [/markdown or a template placeholder/, () => 'נשארו בטקסט סימנים שלא שייכים אליו, כמו כוכביות או סוגריים מסולסלים. מורידים אותם.'],
  [/mostly not Hebrew/, () => 'רוב הטקסט לא בעברית.'],
  [/^(\d+) words on the cover, (\d+) to (\d+)/, (m) => `יש בו ${m[1]} מילים, וצריך בין ${m[2]} ל-${m[3]}.`],
  [/^(\d+) characters, (\d+) at most/, (m) => `יש בו ${m[1]} תווים, ואפשר עד ${m[2]}.`],
  [/^(\d+) sentences, (\d+) at most/, (m) => `יש בו ${m[1]} משפטים, ואפשר עד ${m[2]}. מחברים שניים או מורידים אחד.`],
  [/a list of four or more things/, () => 'יש רשימה של ארבעה דברים או יותר במשפט אחד. משאירים שניים או שלושה.'],
  [/fragments in a row/, () => 'יש כמה משפטים קצרים מאוד ברצף. מחברים אותם למשפט אחד.'],
  [/as a sentence of its own, for emphasis/, () => 'יש מילה שעומדת לבד כמשפט, להדגשה. מחברים אותה למשפט שלידה.'],
  [/ends by summing up or drawing a moral/, () => 'הטקסט נגמר בסיכום או במוסר השכל. מורידים את המשפט האחרון.'],
  [/"זה לא X, זה Y"/, () => 'יש משפט שמתחיל במה שזה לא. אומרים ישר מה זה.'],
  [/"לא עוד X"/, () => 'יש סיסמה בנוסח "לא עוד...". אומרים מה זה.'],
  [/"בלי X ובלי Y"/, () => 'יש שרשרת של "בלי... ובלי...". אומרים את הדבר האחד שחשוב.'],
  [/"פחות X, יותר Y"/, () => 'יש משפט מאוזן כמו סיסמה. אומרים מה קרה, עם המספר.'],
  [/^banned by the pack: "(.+)"$/, (m) => `יש כאן "${m[1]}", והחשבון לא משתמש בזה.`],
  [/^empty$/, () => 'השדה ריק.'],
];

/** A phrase the voice check refuses ("<label>: "<the phrase>""): the phrase itself is Hebrew, so it is shown. */
const PHRASE = /^[^"]+: "([^"]+)"$/;

/** One problem as a line for the customer: its place, then what to do. `igCaption`: the post has a caption for Instagram too. */
export function problemHe(p, { igCaption = false } = {}) {
  let where = p?.where || '';
  let msg = String(p?.msg ?? p ?? '');
  // The fact gate says its own place first: "slide 2: …", "the cover: …".
  const own = /^((?:slide \d+)|(?:the cover)|(?:the caption)): (.*)$/.exec(msg);
  if (own) [, where, msg] = own;
  const place = placeHe(where, { igCaption });
  const said = (line) => (place ? `${place}: ${line}` : line);
  for (const [re, line] of LINES) {
    const m = re.exec(msg);
    if (m) return said(line(m));
  }
  if (String(p?.code || '') === 'voice:phrase') {
    const m = PHRASE.exec(msg);
    if (m) return said(`יש ביטוי שנשמע כמו מודעה או כמו מכונה: "${m[1]}". כדאי לנסח אחרת.`);
  }
  // A line already in Hebrew (a pack's own rule, a law's check in its Hebrew name) is the customer's to read.
  if (msg && !LATIN.test(msg)) return said(msg);
  return said(OTHER_HE);
}

/** Every problem as the customer reads it, each line once. */
export const problemsHe = (list, opts = {}) => [...new Set((list || []).map((p) => problemHe(p, opts)))];

/**
 * The reviewer's fact check of a changed text, at its place: its own words when it wrote them in Hebrew (they say
 * what is wrong), else the general line (it is asked in English, and usually answers so).
 */
export const moreThanFactsHe = (where, { said = '', ...opts } = {}) => {
  const place = placeHe(where, opts);
  const line = String(said || '').trim() && !LATIN.test(said) ? String(said).trim() : MORE_THAN_FACTS_HE;
  return place ? `${place}: ${line}` : line;
};
