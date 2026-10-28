// A catalog of open, structured data sources, offered during onboarding when a
// niche's words match. A structured source is the best kind there is for this
// engine: a number from an API is quotable exactly, and nobody's prose is
// copied. Each entry says what it is and why it can be trusted; the owner still
// approves it. Adding an entry is a line here; no pack ever needs one.

export const API_CATALOG = [
  {
    match: /.*/,
    type: 'api', url: 'https://query.wikidata.org/sparql', name: 'Wikidata',
    why: 'עובדות מובנות תחת CC0: תאריכים, מקומות, אנשים ושיאים. לכל ערך יש הפניה משלו.',
    api: { kind: 'wikidata-sparql', query: 'SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q5 } LIMIT 1' }, terms: 'ok',
    // Offered for every niche: general facts, not the niche's own (its relevance is scored as such).
    general: true,
  },
  {
    match: /ממשל|זכויות|מדינה|ציבור|government|rights|public|(?<![\p{L}])מס(?![\p{L}])|מיסים|ביטוח|רווחה|תחבורה|בריאות|חינוך|\bdata\b/iu,
    type: 'api', url: 'https://data.gov.il/api/3/action/package_search', name: 'data.gov.il: מאגרי המידע הממשלתיים',
    why: 'פורטל המידע הפתוח של ממשלת ישראל: מאגרים רשמיים של משרדים ורשויות.', terms: 'ok',
  },
  {
    match: /מחיר|מדד|יוקר|אינפלציה|שכר|אוכלוסי|price|inflation|cpi|wage|statistics|כסף|money/i,
    type: 'api', url: 'https://api.cbs.gov.il/index/data/price', name: 'הלשכה המרכזית לסטטיסטיקה: API מדדים',
    why: 'הלשכה המרכזית לסטטיסטיקה: מדד המחירים לצרכן ומדדים רשמיים אחרים, כנתונים.', terms: 'ok',
  },
  {
    match: /ריבית|בנק|מט"ח|שער|משכנתא|interest|bank|exchange|mortgage|כסף|money/i,
    type: 'api', url: 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/BR/1.0', name: 'בנק ישראל: נתונים סטטיסטיים',
    why: 'בנק ישראל מפרסם את הריבית ושערי החליפין כנתונים פתוחים.', terms: 'ok',
  },
  {
    match: /כדורגל|ליגה|מונדיאל|football|soccer|league|world cup/i,
    type: 'api', url: 'https://raw.githubusercontent.com/openfootball/football.json/master/2024-25/en.1.json', name: 'openfootball: תוצאות ליגות (מאגר פתוח)',
    why: 'משחקים ותוצאות בנחלת הכלל, מתוחזקים בגלוי ב-GitHub.', terms: 'ok', api: { kind: 'json', path: 'matches', fields: ['round', 'date', 'team1', 'team2', 'score.ft'] },
  },
  {
    match: /מזג|אקלים|גשם|weather|climate|rain|גינון|garden|חקלאות/i,
    type: 'api', url: 'https://archive-api.open-meteo.com/v1/archive', name: 'Open-Meteo: נתוני אקלים היסטוריים',
    why: 'נתוני מזג אוויר היסטוריים פתוחים משירותים מטאורולוגיים ומ-ERA5, בשימוש עם ייחוס.', terms: 'check',
  },
  {
    match: /\bAI\b|בינה מלאכותית|טכנולוגי|תוכנה|\btech\b|software|developer|github/iu,
    type: 'rss', url: 'https://github.blog/changelog/feed/', name: 'GitHub Changelog',
    why: 'הרישום הרשמי והמתוארך של כל שינוי ב-GitHub.', terms: 'check',
  },
];

/** The catalog entries whose words match the seed. */
export function suggestApis(seed) {
  const text = [seed.niche, seed.nicheEn, seed.audience, ...(seed.topics || [])].filter(Boolean).join(' ');
  return API_CATALOG.filter((a) => a.match.test(text)).map(({ match, ...a }) => a);
}
