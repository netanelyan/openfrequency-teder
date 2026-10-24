// Two more fictional brands, for the demo and the screenshots only.
//
// The Today and Accounts pages exist to show several accounts side by side, each
// its own brand, and one demo pack cannot show that. These two are written into
// the throwaway ./.demo home by `npm run demo`, never into examples/ or $OF_HOME.
// Every name, handle, source and fact here is invented; the sources are on the
// reserved example.* domains.

const F = (id, claim, quote) => ({ id, claim, quote, doc: 'D1' });
const voice = (who, good, bad) => `# הקול (חשבון בדיוני לדוגמה)

## מי מדבר

${who} הוא לא מספר על עצמו, לא ממליץ על מותגים ולא כותב "ניסיתי". כל עובדה באה ממקור, והמקור כתוב בתחתית השקף.

## למי

אנשים שרוצים להתחיל בלי להבין בזה כלום, ובלי לקנות ציוד יקר.

## איך זה נשמע

- עברית מדוברת, משפטים קצרים, פונים ברבים.
- מספרים מדויקים כשיש, בלי סימני קריאה ובלי הייפ.

## שורות טובות

${good.map((g) => `- ${g}`).join('\n')}

## שורות רעות

${bad.map((b) => `- ${b}`).join('\n')}
`;

export const EXTRAS = [
  {
    id: 'demo-coffee',
    pack: {
      id: 'demo-coffee', fictional: true, displayName: 'חצי כוס', handle: 'demo.chatzi.kos', language: 'he',
      description: 'A fictional demo account: making better coffee at home with what is already in the kitchen.',
      topics: ['קפה בבית', 'חליטה', 'שמירת פולים'], audience: 'people who make coffee at home and want it to taste better',
      platforms: ['tiktok', 'instagram'], publisher: 'dry', zernio: { profileId: '', accounts: { tiktok: '', instagram: '' }, tiktokPrivacy: 'SELF_ONLY' },
      schedule: { postsPerDay: 1, windows: [[7, 9], [19, 22]], slots: ['08:15'], slotsByDay: { 5: ['08:15'], 6: ['21:00'] } },
      autonomy: { mode: 'digest' }, compliance: [], imagery: { providers: ['commons'] },
    },
    theme: { template: 'poster', variant: 'a', colors: { bg: '#FBF4E9', surface: '#FFFFFF', ink: '#241812', muted: '#6A5547', accent: '#5B3A29', accent2: '#E2A23B', onAccent: '#FFFFFF' }, fonts: { display: 'Secular One', text: 'Rubik' }, options: { radius: 22, coverPhoto: false } },
    sources: { sources: [{ id: 'home-coffee-lab', type: 'rss', url: 'https://www.example.org/coffee/feed.xml', name: 'מעבדת הקפה הביתית (בדיונית)', lang: 'he', why: 'מקור בדיוני לדמו, על הדומיין השמור example.org.', approvedAt: '2026-10-13' }] },
    formats: {
      formats: [
        { id: 'brew-guide', name: 'מדריך חליטה', about: 'The numbers behind one brewing method.', weight: 2, items: [3, 5], hooks: ['{method} בבית: {n} מספרים שמשנים את הכוס'], closers: [{ title: 'שמרו לבוקר הבא', body: 'ותשלחו למי שמכין לכם קפה' }] },
        { id: 'myths', name: 'מה לא לעשות', about: 'Common habits that spoil coffee, and what to do instead.', weight: 1, items: [3, 4], hooks: ['{n} דברים שאתם עושים ל{x} ולא כדאי'], closers: [{ title: 'איזה מהם עשיתם?', body: 'שמרו את הרשימה ליד הקופסה' }] },
      ],
      caption: { questions: ['באיזו שיטה אתם מכינים קפה בבית?', 'איפה אתם שומרים את הקפה?'] },
      hashtags: { broad: ['#קפה', '#בוקרטוב'], niche: ['#קפהבבית', '#פילטר', '#ברייסטה_ביתי'] },
    },
    rules: { maxQuoteWords: 40, bannedPhrases: ['הקפה הכי טוב בעולם'], patterns: [], imageQueryBlock: ['logo', 'brand', 'cafe sign'] },
    voice: voice('חשבון שמסביר איך מכינים קפה טוב יותר בבית.', ['יחס של גרם קפה ל-15 עד 17 גרם מים, ומכוונים לפי הטעם.', 'טוחנים ממש לפני החליטה.', 'שוקלים, לא סופרים כפות.'], ['הקפה המושלם מחכה לכם!', 'ניסיתי את כל המכונות ורק אחת שווה', 'חשוב לציין שקפה הוא אמנות מדהימה.']),
    documents: {
      'brew-basics': { source: 'home-coffee-lab', url: 'https://www.example.org/coffee/brew-basics', title: 'חליטה בפילטר: המספרים', fetchedAt: '2026-10-12T09:00:00Z', text: ['יחס מקובל לחליטה בפילטר הוא גרם קפה אחד לכל 15 עד 17 גרם מים.', 'טמפרטורת מים של 92 עד 96 מעלות מוציאה את רוב הטעמים בלי להגיע למרירות.', 'מים רותחים, 100 מעלות, נוטים לחלץ יותר מדי ולהשאיר טעם מר.', 'קפה טחון מאבד חלק גדול מהארומה כבר בתוך 15 דקות מהטחינה.', 'שקילה במשקל מטבח מדויקת יותר ממדידה בכפות, כי צפיפות הפולים משתנה מקלייה לקלייה.'].join('\n') },
      'beans-storage': { source: 'home-coffee-lab', url: 'https://www.example.org/coffee/storage', title: 'איך שומרים פולי קפה', fetchedAt: '2026-10-12T09:00:00Z', text: ['פולי קפה נשמרים הכי טוב בקופסה אטומה, בטמפרטורת החדר ובמקום חשוך.', 'במקרר הפולים סופגים לחות וריחות של מזון אחר.', 'אצל רוב הקולים הטעם בשיאו בין 7 ל-21 ימים אחרי הקלייה.', 'שקית עם שסתום חד-כיווני משחררת פחמן דו-חמצני בלי להכניס אוויר.', 'עדיף לקנות כמות שתיגמר בתוך שבועיים עד שלושה.'].join('\n') },
    },
    drafts: {
      'brew-basics': {
        format: 'brew-guide',
        outline: { usable: true, why: 'four numbers with their reasons', topic: 'קפה פילטר בבית', imageQuery: '', facts: [
          F('f1', 'יחס מקובל הוא גרם קפה ל-15 עד 17 גרם מים', 'יחס מקובל לחליטה בפילטר הוא גרם קפה אחד לכל 15 עד 17 גרם מים.'),
          F('f2', '92 עד 96 מעלות מוציאות את הטעמים בלי מרירות, ו-100 מעלות מחלצות יותר מדי', 'טמפרטורת מים של 92 עד 96 מעלות מוציאה את רוב הטעמים בלי להגיע למרירות. מים רותחים, 100 מעלות, נוטים לחלץ יותר מדי ולהשאיר טעם מר.'),
          F('f3', 'קפה טחון מאבד חלק גדול מהארומה בתוך 15 דקות', 'קפה טחון מאבד חלק גדול מהארומה כבר בתוך 15 דקות מהטחינה.'),
          F('f4', 'משקל מטבח מדויק יותר מכפות', 'שקילה במשקל מטבח מדויקת יותר ממדידה בכפות, כי צפיפות הפולים משתנה מקלייה לקלייה.'),
        ], items: [{ point: 'יחס', facts: ['f1'] }, { point: 'טמפרטורה', facts: ['f2'] }, { point: 'טחינה', facts: ['f3'] }, { point: 'שקילה', facts: ['f4'] }] },
        slides: { hook: 'קפה פילטר בבית: 4 מספרים שמשנים את הכוס', sub: 'בלי מכונה יקרה, רק משקל ומדחום', slides: [
          { title: 'גרם קפה, 15 עד 17 גרם מים', body: 'זה היחס המקובל לחליטה בפילטר. מתחילים באמצע הטווח ומכוונים לפי הטעם.', facts: ['f1'] },
          { title: '92 עד 96 מעלות, לא רתיחה', body: 'בטווח הזה יוצאים רוב הטעמים בלי מרירות. מים רותחים, 100 מעלות, נוטים לחלץ יותר מדי.', facts: ['f2'] },
          { title: 'טוחנים ממש לפני', body: 'קפה טחון מאבד חלק גדול מהארומה כבר בתוך 15 דקות מהטחינה.', facts: ['f3'] },
          { title: 'שוקלים, לא סופרים כפות', body: 'משקל מטבח מדויק יותר מכפות, כי הצפיפות של הפולים משתנה מקלייה לקלייה.', facts: ['f4'] },
        ], caption: 'ארבעה מספרים, ואותו קפה טועם אחרת.', question: 'באיזו שיטה אתם מכינים קפה בבית?' },
      },
      'beans-storage': {
        format: 'myths',
        outline: { usable: true, why: 'habits that spoil beans, with the alternative', topic: 'שמירת פולי קפה', imageQuery: '', facts: [
          F('f1', 'פולים נשמרים הכי טוב בקופסה אטומה, בטמפרטורת החדר ובחושך', 'פולי קפה נשמרים הכי טוב בקופסה אטומה, בטמפרטורת החדר ובמקום חשוך.'),
          F('f2', 'במקרר הפולים סופגים לחות וריחות', 'במקרר הפולים סופגים לחות וריחות של מזון אחר.'),
          F('f3', 'הטעם בשיאו בין 7 ל-21 ימים אחרי הקלייה', 'אצל רוב הקולים הטעם בשיאו בין 7 ל-21 ימים אחרי הקלייה.'),
          F('f4', 'השסתום משחרר פחמן דו-חמצני בלי להכניס אוויר', 'שקית עם שסתום חד-כיווני משחררת פחמן דו-חמצני בלי להכניס אוויר.'),
          F('f5', 'עדיף לקנות כמות שתיגמר בתוך שבועיים עד שלושה', 'עדיף לקנות כמות שתיגמר בתוך שבועיים עד שלושה.'),
        ], items: [{ point: 'מקרר', facts: ['f2', 'f1'] }, { point: 'טרי מדי', facts: ['f3'] }, { point: 'שסתום', facts: ['f4'] }, { point: 'כמות', facts: ['f5'] }] },
        slides: { hook: '4 דברים שאתם עושים לפולי הקפה ולא כדאי', sub: 'המקרר הוא לא חבר שלהם', slides: [
          { title: 'המקרר', body: 'במקרר הפולים סופגים לחות וריחות של מזון אחר. עדיף קופסה אטומה, בטמפרטורת החדר ובחושך.', facts: ['f2', 'f1'] },
          { title: 'טרי מדי זה גם לא טוב', body: 'אצל רוב הקולים הטעם בשיאו בין 7 ל-21 ימים אחרי הקלייה. תסתכלו על תאריך הקלייה בשקית.', facts: ['f3'] },
          { title: 'השסתום בשקית', body: 'השסתום החד-כיווני משחרר פחמן דו-חמצני בלי להכניס אוויר, אז אין סיבה להעביר לשקית אחרת.', facts: ['f4'] },
          { title: 'קונים פחות, יותר פעמים', body: 'עדיף לקנות כמות שתיגמר בתוך שבועיים עד שלושה.', facts: ['f5'] },
        ], caption: 'השמירה משנה את הטעם לא פחות מהחליטה.', question: 'איפה אתם שומרים את הקפה?' },
      },
    },
  },
  {
    id: 'demo-running',
    pack: {
      id: 'demo-running', fictional: true, displayName: 'קילומטר ראשון', handle: 'demo.km.rishon', language: 'he',
      description: 'A fictional demo account: running for people who have never run.',
      topics: ['ריצה למתחילים', 'אימונים', 'ציוד'], audience: 'adults starting to run from zero',
      platforms: ['tiktok', 'instagram'], publisher: 'dry', zernio: { profileId: '', accounts: { tiktok: '', instagram: '' }, tiktokPrivacy: 'SELF_ONLY' },
      schedule: { postsPerDay: 1, windows: [[6, 9], [18, 22]], slots: ['18:30'], slotsByDay: { 5: ['07:30'], 6: ['21:00'] } },
      autonomy: { mode: 'auto' }, compliance: [], imagery: { providers: ['commons'] },
    },
    theme: { template: 'scoreboard', variant: 'b', colors: { bg: '#0E1A2B', surface: '#172741', ink: '#F2F5FA', muted: '#A9B7C9', accent: '#FF6B5E', accent2: '#49D99B', onAccent: '#0E1A2B' }, fonts: { display: 'Heebo', text: 'Assistant' }, options: { radius: 18, coverPhoto: false } },
    sources: { sources: [{ id: 'sports-med-example', type: 'web', url: 'https://www.example.net/running/', name: 'מכון הדוגמה לרפואת ספורט (בדיוני)', lang: 'he', why: 'מקור בדיוני לדמו, על הדומיין השמור example.net.', approvedAt: '2026-10-13' }] },
    formats: {
      formats: [
        { id: 'beginner-plan', name: 'תוכנית למתחילים', about: 'Rules for the first weeks.', weight: 2, items: [3, 4], hooks: ['ריצה ראשונה? {n} כללים לחודש הראשון'], closers: [{ title: 'שמרו לפני האימון הבא', body: 'ותשלחו למי שאמר שיתחיל ביום ראשון' }] },
        { id: 'gear', name: 'ציוד', about: 'What to check before buying, and when to replace.', weight: 1, items: [3, 4], hooks: ['לפני שקונים {x}: {n} דברים לבדוק'], closers: [{ title: 'שמרו לחנות', body: 'זה ייקח לכם דקה לבדוק' }] },
      ],
      caption: { questions: ['כמה זמן אתם כבר רצים?', 'כמה קילומטרים יש לנעליים שלכם?'] },
      hashtags: { broad: ['#ריצה', '#כושר'], niche: ['#ריצהלמתחילים', '#קילומטרראשון', '#אימון'] },
    },
    rules: { maxQuoteWords: 40, bannedPhrases: ['בלי כאב אין הישג'], patterns: [], imageQueryBlock: ['logo', 'brand'] },
    voice: voice('חשבון שמלווה אנשים בחודשים הראשונים של ריצה.', ['דקה ריצה ושתי דקות הליכה, 20 דקות בסך הכל.', 'אם אי אפשר לדבר במשפטים מלאים, זה מהר מדי.', 'לא מגדילים את המרחק השבועי ביותר מ-10%.'], ['בלי כאב אין הישג!', 'רצתי מרתון אחרי חודש וגם אתם תוכלו', 'בנוסף, ניתן לרוץ מהר יותר על מנת להתקדם.']),
    documents: {
      'first-weeks': { source: 'sports-med-example', url: 'https://www.example.net/running/first-weeks', title: 'השבועות הראשונים', fetchedAt: '2026-10-12T09:00:00Z', text: ['מתחילים יכולים לפתוח בשילוב של דקה ריצה ושתי דקות הליכה, 20 דקות בסך הכל.', 'כלל מקובל הוא לא להגדיל את המרחק השבועי ביותר מ-10% משבוע לשבוע.', 'קצב שבו אפשר לדבר במשפטים מלאים הוא קצב קל, וזה הקצב שמתאים לרוב האימונים.', '3 אימונים בשבוע עם יום מנוחה ביניהם מספיקים כדי להתקדם בחודשים הראשונים.', 'כאב חד שלא עובר אחרי יום מנוחה הוא סיבה לעצור ולהתייעץ.'].join('\n') },
      shoes: { source: 'sports-med-example', url: 'https://www.example.net/running/shoes', title: 'נעלי ריצה', fetchedAt: '2026-10-12T09:00:00Z', text: ['נעלי ריצה מאבדות חלק מהבלימה שלהן אחרי 500 עד 800 קילומטר.', 'מודדים נעל אחר הצהריים, כשכף הרגל מעט נפוחה.', 'בין הבוהן הארוכה לקצה הנעל צריך להישאר בערך רוחב של אגודל.', 'גרביים מבד סינתטי מנדפות זיעה טוב יותר מכותנה ומפחיתות שלפוחיות.'].join('\n') },
    },
    drafts: {
      'first-weeks': {
        format: 'beginner-plan',
        outline: { usable: true, why: 'four rules for the first month', topic: 'החודש הראשון', imageQuery: '', facts: [
          F('f1', 'פותחים בדקה ריצה ושתי דקות הליכה, 20 דקות בסך הכל', 'מתחילים יכולים לפתוח בשילוב של דקה ריצה ושתי דקות הליכה, 20 דקות בסך הכל.'),
          F('f2', 'לא מגדילים את המרחק השבועי ביותר מ-10%', 'כלל מקובל הוא לא להגדיל את המרחק השבועי ביותר מ-10% משבוע לשבוע.'),
          F('f3', 'קצב שבו אפשר לדבר במשפטים מלאים הוא קצב קל', 'קצב שבו אפשר לדבר במשפטים מלאים הוא קצב קל, וזה הקצב שמתאים לרוב האימונים.'),
          F('f4', '3 אימונים בשבוע עם יום מנוחה ביניהם מספיקים', '3 אימונים בשבוע עם יום מנוחה ביניהם מספיקים כדי להתקדם בחודשים הראשונים.'),
        ], items: [{ point: 'פתיחה', facts: ['f1'] }, { point: 'תדירות', facts: ['f4'] }, { point: 'קצב', facts: ['f3'] }, { point: 'עלייה', facts: ['f2'] }] },
        slides: { hook: 'ריצה ראשונה? 4 כללים לחודש הראשון', sub: 'בלי לשבור שיאים, בלי להיפצע,\nובלי לוותר', slides: [
          { title: 'דקה ריצה, שתי דקות הליכה', body: 'ככה אפשר לפתוח: דקה ריצה ושתי דקות הליכה, 20 דקות בסך הכל.', facts: ['f1'] },
          { title: '3 פעמים בשבוע מספיק', body: '3 אימונים בשבוע עם יום מנוחה ביניהם מספיקים כדי להתקדם בחודשים הראשונים.', facts: ['f4'] },
          { title: 'אי אפשר לדבר? מהר מדי', body: 'קצב שבו מדברים במשפטים מלאים\nהוא קצב קל, וזה הקצב\nשמתאים לרוב האימונים.', facts: ['f3'] },
          { title: 'לא יותר מ-10% בשבוע', body: 'כלל מקובל: לא מגדילים את המרחק השבועי ביותר מ-10% משבוע לשבוע.', facts: ['f2'] },
        ], caption: 'החודש הראשון הוא על להגיע לאימון הבא, לא על המהירות.', question: 'כמה זמן אתם כבר רצים?' },
      },
      shoes: {
        format: 'gear',
        outline: { usable: true, why: 'what to check in a shoe and when to replace it', topic: 'נעלי ריצה', imageQuery: '', facts: [
          F('f1', 'נעליים מאבדות חלק מהבלימה אחרי 500 עד 800 קילומטר', 'נעלי ריצה מאבדות חלק מהבלימה שלהן אחרי 500 עד 800 קילומטר.'),
          F('f2', 'מודדים אחר הצהריים, כשכף הרגל מעט נפוחה', 'מודדים נעל אחר הצהריים, כשכף הרגל מעט נפוחה.'),
          F('f3', 'בין הבוהן לקצה הנעל נשאר רוחב של אגודל', 'בין הבוהן הארוכה לקצה הנעל צריך להישאר בערך רוחב של אגודל.'),
          F('f4', 'גרביים סינתטיות מנדפות זיעה ומפחיתות שלפוחיות', 'גרביים מבד סינתטי מנדפות זיעה טוב יותר מכותנה ומפחיתות שלפוחיות.'),
        ], items: [{ point: 'מתי מודדים', facts: ['f2'] }, { point: 'מקום', facts: ['f3'] }, { point: 'גרביים', facts: ['f4'] }, { point: 'מתי מחליפים', facts: ['f1'] }] },
        slides: { hook: 'לפני שקונים נעלי ריצה: 4 דברים לבדוק', sub: 'ומתי להחליף את מה שכבר יש לכם', slides: [
          { title: 'מודדים אחר הצהריים', body: 'אחר הצהריים כף הרגל מעט נפוחה, וזה בדיוק המצב שבו מודדים.', facts: ['f2'] },
          { title: 'רוחב אגודל מקדימה', body: 'בין הבוהן הארוכה לקצה הנעל צריך להישאר בערך רוחב של אגודל.', facts: ['f3'] },
          { title: 'גרביים בלי כותנה', body: 'גרביים מבד סינתטי מנדפות זיעה טוב יותר מכותנה ומפחיתות שלפוחיות.', facts: ['f4'] },
          { title: 'מתי מחליפים', body: 'נעלי ריצה מאבדות חלק מהבלימה שלהן אחרי 500 עד 800 קילומטר.', facts: ['f1'] },
        ], caption: 'נעל טובה היא זו שמתאימה לרגל שלכם, לא זו שעל המדף.', question: 'כמה קילומטרים יש לנעליים שלכם?' },
      },
    },
  },
];
