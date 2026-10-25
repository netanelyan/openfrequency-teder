// HARD RULE 3, the half a quote check cannot see: no fake personal experience,
// no fake badges, no fake metrics.
//
// An account run by an engine has not been anywhere, tried anything or bought
// anything, and it has no numbers it may boast about. So:
//
//   EXPERIENCE  first-person past ("ניסיתי", "קניתי", "כשהייתי", the "הלוואי וידעתי קודם"
//               of a cover that says the account once did not know) is refused, while
//               the explainer's present and conditional ("ככה בונים את זה", "היינו
//               ממליצים לבדוק") stays allowed, because it claims nothing happened.
//   PROOF       claims about the account's own popularity or status: follower or
//               view counts, "verified", "official", "#1", badges.
//
// Lookarounds on Unicode letters stand in for \b, which does not work on Hebrew.

const W = '\\p{L}\\p{N}';
const edge = (body) => new RegExp(`(?<![${W}])(?:ו|ש|כש|וש)?(?:${body})(?![${W}])`, 'u');

// What may follow "היינו" or "הייתי" without it being a memory: a planner's verb.
const CONDITIONAL_OK =
  'בונים|בונה|עושים|עושה|ממליצים|ממליץ|ממליצה|מוסיפים|מתחילים|בוחרים|בוחר|בודקים|בודק|שואלים|שואל|לוקחים|הולכים|משאירים|מדלגים|' +
  'צריכים|צריך|אמורים|אמור|חייבים|יכולים|כותבים|מראים|מספרים|שמים|מחלקים|קובעים|מוותרים|מחכים';

const EXPERIENCE = [
  edge('כשהי(?:ינו|יתי)'),
  new RegExp(`(?<![${W}])(?:ו|ש)?הי(?:ינו|יתי)(?![${W}])(?!\\s+(?:${CONDITIONAL_OK})(?![${W}]))`, 'u'),
  edge(
    'ניסיתי|ניסינו|קניתי|קנינו|השתמשתי|השתמשנו|בדקתי|בדקנו|גיליתי|גילינו|טסנו|טסתי|נסעתי|נסענו|ביקרתי|ביקרנו|אכלתי|אכלנו|' +
      'שילמתי|שילמנו|חסכתי|חסכנו|הרווחתי|הרווחנו|השקעתי|השקענו|ראיתי|ראינו|צפיתי|צפינו|שיחקתי|שיחקנו|גידלתי|גידלנו|שתלתי|שתלנו|' +
      'הצלחתי|הצלחנו|עבדתי|למדתי|קיבלתי|קיבלנו|ידעתי|ידענו'
  ),
  edge('מ(?:ה)?ניסיון\\s+(?:שלי|שלנו|אישי)'),
  edge('אצלי\\s+בבית|אצלנו\\s+בבית|במקרה\\s+שלי|במקרה\\s+שלנו'),
];

const PROOF = [
  /(?:אלפי|מאות|מיליוני|רבבות|\d[\d,.]*\s*(?:K|M|אלף|מיליון)?)\s*(?:עוקבים|עוקבות|צפיות|לייקים|שיתופים|מנויים)/u,
  edge('חשבון\\s+רשמי|מאומת|מאומתת|תג\\s+כחול|verified|official'),
  /#1(?!\d)|מספר\s+1\s+ב(?:טיקטוק|אינסטגרם|ישראל)|הכי\s+(?:נצפה|ויראלי|פופולרי)\s+ב(?:טיקטוק|אינסטגרם|ישראל)/u,
];

/** A verification badge drawn next to the account's own name. */
export function badgeNextTo(text, name) {
  if (!name) return null;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc}\\s*[✔☑✅🔵]|[✔☑✅🔵]\\s*${esc}`, 'u').exec(String(text || ''))?.[0] || null;
}

/** The first invented experience in a text, or null. */
export function experienceIn(text) {
  const s = String(text || '');
  for (const re of EXPERIENCE) {
    const m = re.exec(s);
    if (m) return m[0].trim();
  }
  return null;
}

/** The first fake badge or metric in a text, or null. */
export function fakeProofIn(text) {
  const s = String(text || '');
  for (const re of PROOF) {
    const m = re.exec(s);
    if (m) return m[0].trim();
  }
  return null;
}
