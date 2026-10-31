// Outlets the operator can add to an account's approved sources in one click (the Sources page; a customer never sees
// the list, src/web/pages.js catalogPanel), per niche: feeds that were
// read through the network door and whose sites' robots.txt lets this engine and Claude in (robots.js), checked on
// 2026-10-19. The check runs again every time a source is read, so a site that later says no is not read.
//
// Long reads first: hints.prefer puts a feed's interviews, features and inside stories before its match reports
// and rumours (src/sources/index.js preferred()).
//
// Each outlet the owner asked for that cannot be read is listed under `refused` with the reason: its own
// robots.txt tells Claude's agents to stay out, or it publishes no feed. Adding one by hand is refused the same way
// when it is read.

const EN = '\\b(interview|exclusive|feature|long ?read|in[- ]depth|inside|the story|profile|opens up|reveals|explains|told|recalls|untold)\\b';
const HE = '(ראיון|בלעדי|מאחורי הקלעים|הסיפור|תחקיר|חושף|חושפת|מספר|מספרת|סיפר|סיפרה|מגלה|פרויקט|מיוחד)';

const rss = (id, name, url, lang, why, extra = {}) => ({ id, type: 'rss', name, url, lang, why, hints: { prefer: lang === 'he' ? HE : EN, max: 8, ...extra } });

export const CATALOG = {
  football: {
    name: 'כדורגל',
    sources: [
      rss('walla-sport', 'וואלה ספורט', 'https://rss.walla.co.il/feed/156', 'he', 'מערכת ספורט ותיקה, כתבות וראיונות עם שחקנים ומאמנים בליגה הישראלית ובעולם.'),
      rss('ynet-sport', 'ynet ספורט', 'https://www.ynet.co.il/Integration/StoryRss3.xml', 'he', 'מדור הספורט של ynet: דיווחים, ראיונות וכתבות עומק.'),
      rss('sky-sports-football', 'Sky Sports Football', 'https://www.skysports.com/rss/11095', 'en', 'Sky Sports: Premier League and European football, with features and interviews.'),
      rss('90min', '90min', 'https://www.90min.com/posts.rss', 'en', 'Football news and features from a large international newsroom.'),
    ],
    refused: [
      ['The Athletic', 'robots.txt tells Claude\'s agents to stay out'],
      ['BBC Sport', 'robots.txt tells Claude\'s agents to stay out of its articles'],
      ['The Guardian', 'robots.txt tells Claude\'s agents to stay out'],
      ['ESPN FC', 'robots.txt tells Claude\'s agents to stay out'],
      ['ONE', 'robots.txt tells Claude\'s agents to stay out'],
      ['Sport5', 'no public feed was found (its article pages are open)'],
    ],
  },
  mma: {
    name: 'MMA',
    sources: [
      rss('sherdog-articles', 'Sherdog: features', 'https://www.sherdog.com/rss/articles.xml', 'en', 'Sherdog\'s features and columns: fight analysis, history, opinion.'),
      rss('sherdog-news', 'Sherdog: news', 'https://www.sherdog.com/rss/news.xml', 'en', 'Sherdog, the long-running MMA record keeper: news and fight results.'),
      rss('bloody-elbow', 'Bloody Elbow', 'https://bloodyelbow.com/feed/', 'en', 'Independent MMA site with long analysis, interviews and business reporting.'),
      rss('mmaweekly', 'MMAWeekly', 'https://www.mmaweekly.com/.rss/feed/e730bac4-af18-40d3-ab6a-08fd2c1f4bff.xml', 'en', 'MMA news and fighter interviews since 1998.'),
    ],
    refused: [
      ['MMA Junkie', 'robots.txt tells Claude\'s agents to stay out'],
      ['MMA Fighting', 'robots.txt tells Claude\'s agents to stay out'],
      ['ESPN MMA', 'robots.txt tells Claude\'s agents to stay out'],
      ['Sport5 MMA', 'no public feed was found'],
    ],
  },
  startups: {
    name: 'סטארטאפים',
    sources: [
      rss('crunchbase-news', 'Crunchbase News', 'https://news.crunchbase.com/feed/', 'en', 'Funding rounds, valuations and the data behind them, with long analysis pieces.'),
      rss('globes-tech', 'גלובס: היי-טק', 'https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=594', 'he', 'מדור ההייטק של גלובס: גיוסים, אקזיטים וראיונות עם יזמים.'),
      rss('geektime', 'Geektime', 'https://www.geektime.co.il/feed/', 'he', 'אתר הסטארטאפים הישראלי: גיוסים, ראיונות ומדריכים, בכתבות ארוכות.'),
      rss('ynet-digital', 'ynet דיגיטל', 'https://www.ynet.co.il/Integration/StoryRss544.xml', 'he', 'מדור הטכנולוגיה של ynet: חברות, מוצרים ואנשים מאחוריהם.'),
    ],
    refused: [
      ['TechCrunch', 'robots.txt tells Claude\'s agents to stay out'],
      ['Calcalist', 'no public feed was found (its article pages are open)'],
      ['CTech', 'no public feed was found (its article pages are open)'],
    ],
  },
};

/** One catalog source by niche and id, or null. */
export const catalogSource = (niche, id) => CATALOG[niche]?.sources.find((s) => s.id === id) || null;
