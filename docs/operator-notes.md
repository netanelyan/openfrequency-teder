# Operator notes

Teder is sold self-serve, so a customer's pages say only what is happening and what they can do, in plain Hebrew.
Everything technical that used to be on those pages (a missing key, a fallback ranking, a file or folder name, a
command) moved here. The operator (the superadmin outside view-as) still sees each note on the page, in a small line
or folded under "הערות למפעיל"; a customer never does.

Each section: what the note is, where it shows up, what to do, and whether it is needed now. The live server is
Teder at `/opt/open-frequency` on the VPS (systemd; its SSH alias is in private/DEPLOY.md); its `.env` is where a key goes, and a restart of the service
picks it up. Nothing here is set by a customer.

When asked "what should I do about Teder's setup", read this file top to bottom and report, for each section, whether
the server is in the state it asks for. In developer mode (Settings, seven taps on the version line) the "מפתחות" panel
says which keys are set without showing them.

## Needed before sign-up opens to the public

### BRAVE_API_KEY: searching the web for a new account's sources

- **What it is.** The new-account flow (`/new`) searches Brave for authority sites (government, official bodies,
  established publications) about the niche the customer wrote. Without the key it searches nothing and only reads
  the sites the customer typed in as examples, plus the open-data catalog (Wikidata always, data.gov.il, the CBS,
  the Bank of Israel and others when the niche matches).
- **Where it shows.** Operator only: "אין BRAVE_API_KEY: לא חיפשתי אתרים, רק בדקתי את הדוגמאות שנתתם" under
  "הערות למפעיל" on `/new/<id>`. The customer used to read "הגדירו BRAVE_API_KEY" when nothing was found; now they read
  "לא נמצאו מקורות" and a link to start again with sites they trust.
- **What to do.** Get a key at brave.com/search/api and set `BRAVE_API_KEY=` in the server's `.env`. It costs $5 per
  1,000 queries; a new account makes up to five, each cached for 30 days, and every one is in the spend ledger (tag
  `onboarding`).
- **Needed now?** Yes, before self-serve sign-up opens (`OF_SIGNUP_OPEN=1`). A customer who types no example site
  otherwise gets only the catalog's few sources.

### ANTHROPIC_API_KEY: writing the sample posts, scoring sources

- **What it is.** Claude writes the five sample posts of a new account, scores each source found (authority,
  freshness, terms of use, a one-line reason), writes the account's voice guide and turns the Hebrew niche into the
  English words YouTube is searched with. Without a key (the engine in recorded mode) no sample is written, sources are
  scored by a transparent heuristic (the web address: `.gov.il`, `.ac.il`, a known publication), the voice guide is the
  template, and YouTube is searched in Hebrew alone.
- **Where it shows.** Operator only:
  - "המנוע במצב הקלטות: בלי ANTHROPIC_API_KEY אין מי שיכתוב פוסטים..." under "הערות למפעיל" on the samples page.
    The customer reads "לא הצלחנו לכתוב דוגמאות הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו לנו."
  - "דירוג היוריסטי (בלי מפתח API)" after a source's reason on the sources step. The customer sees the reason alone.
  - "הדירוג עם Claude נכשל (...), הדירוג הוא היוריסטי": the key is set and the scoring call failed; the heuristic
    stood in.
  - "בודק הקול: אופליין (בלי מפתח API)" on a post's page. The customer does not see the reviewer's name.
- **What to do.** The live server must run with `ANTHROPIC_API_KEY` set (and `ANTHROPIC_WORKSPACE_ID` for a key not
  scoped to one workspace). If the key is set and the notes still appear, read the service's log for the failed call
  (rate limit, billing, a model id).
- **Needed now?** Yes. Without it no new account can reach its five samples, so none can go live.

## Optional, for better results

### YOUTUBE_API_KEY: formats that work in the niche

- **What it is.** Discovery looks up the YouTube Shorts that work now in the niche, in Hebrew and in English, with
  their real view counts, and the weekly trends step does the same for every account. Without the key nothing is
  looked up and no number is made up in its place.
- **Where it shows.** Operator only: "אין YOUTUBE_API_KEY: לא חיפשתי פורמטים, ושום מספר לא הומצא במקום" under
  "הערות למפעיל", and the panel "פורמטים שעובדים בנישה" with "לא נבדק (בלי YOUTUBE_API_KEY)". The customer used to
  read that line; now the panel is simply not there for them when there is nothing to show. A "YouTube: ..." note is
  a failed call (quota, a bad key).
- **What to do.** A key restricted to YouTube Data API v3 from console.cloud.google.com, as `YOUTUBE_API_KEY=` in the
  server's `.env`. Free, within Google's daily quota.
- **Needed now?** No. Posts are written without it; the formats panel and the weekly trends are what it adds.

### The niche in English

- **What it is.** The `/new` form used to ask for "הנישה באנגלית לחיפוש פורמטים ביוטיוב". A business owner should not
  have to answer that, so the field is gone: discovery asks the model already used in onboarding for the two to five
  English words (src/onboarding/discover.js `nicheInEnglish`), keeps them with the seed, and the new pack's English
  trend query is built from them.
- **Where it shows.** Operator only, and only when it failed: "תרגום הנישה לאנגלית נכשל: ...". Without a model (no
  `ANTHROPIC_API_KEY`) nothing is asked, and the Hebrew niche is used for the English search too.
- **What to do.** Nothing, unless it fails every time: then it is the Claude key (above).
- **Needed now?** No.

## What a customer may run into, and what the operator reads

### A site that could not be read

- **What it is.** Discovery reads each example site's home page and up to two feeds it declares, four sites at a
  time, each fetch with a 12-second timeout.
- **Where it shows.** The customer reads one line naming the sites ("לא הצלחנו לקרוא את example.co.il. אפשר לבחור
  מהמקורות האחרים, או לנסות שוב מאוחר יותר."). The operator also sees each failure as "<address>: <the error>" under
  "הערות למפעיל" (a timeout, a 403 from a site that blocks bots, a feed that does not parse).
- **What to do.** Usually nothing: the site is down or refuses robots. If every site fails, check the server's network
  and `OF_USER_AGENT` (a contact address in the user agent keeps some sites from refusing).
- **Needed now?** No.

### A social account given as an example

- **What it is.** An `@handle` or an Instagram, TikTok or YouTube address among the examples is kept as an example of
  style and never read for facts.
- **Where it shows.** The customer reads "את החשבונות ברשתות החברתיות שנתתם שמרנו כדוגמה לסגנון. עובדות לוקחים רק
  מאתרים." The operator also sees "<handle>: חשבון ברשת חברתית, נשמר כדוגמה לסגנון בלבד ולא נקרא".
- **What to do.** Nothing.

### A search for sources that ran too long

- **What it is.** A discovery has three minutes (`DISCOVERY_TIMEOUT_MS`, src/web/onboarding.js). Past that it is
  stopped, and the row is `failed` with `candidates_json.failure = "timeout"`.
- **Where it shows.** The customer reads "החיפוש לקח יותר מדי זמן ונעצר." with a "לנסות שוב" button that runs it again
  on the same seed. The operator also sees "the discovery ran past 180 seconds and was stopped".
- **What to do.** One is a slow site. If it keeps happening, look at which sites the notes name, or raise the timeout.
- **Needed now?** No.

### A search a restart cut off

- **What it is.** Discovery runs inside the website's process. A restart in the middle of one used to leave the page
  refreshing every few seconds forever. Now, at boot, every row still `discovering` is marked `failed` with
  `failure = "restart"` (the log says "onboarding: N search(es) for sources interrupted by a restart, marked to try
  again"), and a page opened on such a row does the same.
- **Where it shows.** The customer reads "החיפוש נקטע באמצע." and the same "לנסות שוב" button. The operator also sees
  "the server restarted while the discovery ran".
- **What to do.** Nothing: the customer retries. Avoid restarting the service while someone is in `/new` if you can.

### The account could not be created

- **What it is.** Writing the new pack failed for a reason the customer cannot fix: the pack would not validate.
  Templates and display fonts no longer run out: a new account's look is kept apart from the same customer's other
  accounts only (and the operator's own accounts from each other), never from other customers', and when the
  customer's accounts already use every template or face, the least used one on the server is taken
  (src/onboarding/pack.js newTheme, src/packs/validate.js validateAll).
- **Where it shows.** The customer reads "לא הצלחנו ליצור את החשבון הפעם. נסו שוב בעוד כמה דקות, ואם זה חוזר כתבו
  לנו." The details go to the service's log, as "[onboarding] the pack was not written: ...". (What the customer can
  fix is said to them: a taken user name or account name, one with other than Latin letters and digits, no source
  approved. A name another account already has used to fail here; it is now checked before the pack is written.)
- **What to do.** Read the log line: validation problems are listed one by one.
- **Needed now?** Only when it happens. More templates (src/render/templates) or display faces (src/render/fonts.js
  DISPLAY_FACES) only make a customer with many accounts look more varied; nothing waits on them.

### Sources the customer is not offered: relevance, authority, terms

- **What it is.** Discovery scores each source for relevance to the niche (0-10, from the site's own title, its
  description and its latest items; Claude with a key, a strict keyword match without one) next to authority,
  freshness and terms of use. The customer is offered a source only with relevance 6 or more, authority 5 or more, and
  terms that are not "no" (src/onboarding/discover.js `offered`); a site they typed in themselves is always offered.
  Only strong ones (authority 7+, relevance 7+) are ticked. Fewer than three on offer, and the customer reads "מצאנו
  מעט מקורות טובים לנושא הזה" with a box to search again with more of their own sites (POST /new/<id>/more).
- **Why.** A seed "soccer" brought in sites with nothing to do with soccer: the Brave queries return pages that
  only mention the word, discovery then reads each such site's home page and site-wide feed, and nothing scored
  whether a source is about the niche at all.
- **Where it shows.** The customer sees no numbers and no terms: at most "מקור מוביל" (authority 8+) and "מתעדכן כל
  יום" (an item in the last two days). The operator sees every chip as before, a "רלוונטיות N/10" chip and its reason,
  and the sources left out folded under "מקורות שלא הוצגו ללקוח (N)", which the operator may still approve. A source
  whose terms are "no" is approved by nobody.
- **Terms marked "check".** These need our review of their terms of use. We handle it; the customer never sees the
  word (the chip "לבדוק תנאי שימוש" is the operator's alone), and such a source is offered like any other.
- **What to do.** Review the "check" sources of new accounts. If a good source keeps being left out, look at its
  relevance reason.

### Sample posts that could not be written

- **What it is.** After the account is created, its approved sources are read first ("קוראים את המקורות שבחרתם"),
  then the samples are written one at a time, each shown as it is ready. A refused one is followed by another, on
  another document, up to nine tries for five; an error is tried once more after a few seconds. Three or more is done.
- **Where it shows.** Below three, the customer reads what happened and what helps, with "לבחור מקורות" (the Sources
  page) and "לנסות שוב": no facts in the sources ("במקורות שבחרתם לא מצאנו מספיק עובדות לכתוב מהן..."), sources that
  could not be read, an error on our side, or posts our checks stopped. The ones written are kept. The operator sees
  every try's reason under "הערות למפעיל", and the service's log has a line per read, per refused try and per run:
  "[onboarding] <onboarding id> (<account>): ...".
- **What to do.** Read the log lines. "no samples written: nofacts" is sources with nothing to write from (often the
  off-topic ones above, or a home page with no articles); "(error)" lines are the model or the renderer.
- **How many.** A round of samples is up to nine full-price builds outside the month's plan, so a customer gets two
  rounds for each new account (the first five and one more press) and six rounds a calendar month across all their
  new accounts, and none once the account is live (src/web/onboarding.js SAMPLE_ROUNDS). A round counts once it starts
  writing; one that broke on our side and wrote nothing does not. Past the limit the customer reads that it is the
  most, and to write to us. The operator's presses are not limited and not counted: to give a customer another round,
  press "עוד פוסטים לדוגמה" as the operator on their `/new/<id>` page.

### Connecting TikTok and Instagram: headless, and before the account exists

- **What it is.** The connect is Zernio's headless mode: the customer goes straight to TikTok's or Instagram's own
  consent screen (Instagram Login), with no Zernio welcome screen or picker. Zernio still shows its own one-click
  "continue" notice (zernio.com/connect/continue) on the way back to our site; only a custom app scheme skips it. An
  Instagram that comes back through Facebook Login (a reconnect of one connected that way) is finished on our own page:
  one account on offer is picked by itself, several are listed, and the pick is kept on the server for 15 minutes.
  While the sources are searched, the customer may connect already: the profile is then the onboarding's (its
  externalId the onboarding id, kept in onboarding.setup_json), and the new account takes it over at create. On
  Zernio that profile keeps the onboarding's name and externalId; Teder finds it by the id it keeps.
- **What to do.** Nothing. A workspace deleted before its account was created has that profile removed too.

### Something went wrong on our side (500)

- **What it is.** An error no page expected.
- **Where it shows.** The customer reads "משהו השתבש אצלנו. נסו שוב בעוד כמה דקות." (it used to say the details are in
  the log, which is the operator's). The stack is in the service's log as "[web] <method> <address>: ...".
- **What to do.** Read the log.

### Where an account's files are

- **What it is.** Every account is a pack, six files in the private folder (`$OF_HOME/packs/<id>`).
- **Where it shows.** Operator only: "התיקייה הפרטית: <id>" on the samples page; "הסגנון בקובץ theme.json השתנה" on the
  Accounts page and "ב-pack.json כתוב סגנון ..." on the Styles page, when a file was edited by hand. The customer reads
  "יש לחשבון סגנון חדש" and "הוכן לחשבון סגנון ..." with the same button to switch to it.
- **What to do.** Nothing.

### How each platform is published

- **What it is.** The Accounts page's "פרסום" line: Zernio, Meta directly, or dry (to disk), and why it is dry when
  the pack asked for more ("PUBLISH_MODE לא live", "חסר ZERNIO_API_KEY", a missing Instagram token).
- **Where it shows.** Operator only now. The customer has the connect panel, which says whether TikTok and Instagram
  are connected.
- **What to do.** `PUBLISH_MODE=live` and `ZERNIO_API_KEY` on the server once posts should really go out.

### Other technical words taken off customer pages

- The sources page: the catalog no longer explains robots.txt and Claude ("האתר מרשה לנו לקרוא אותו ולכתוב מחדש את
  מה שהוא אומר"); a source's type reads "פיד חדשות", "דף באתר", "מקור נתונים" (it said RSS/Atom and API/JSON); an
  API-type source's chip reads "נתונים".
- The facts page's empty state no longer names the `facts/` folder.
- A post's takedown form and its result no longer say "API" ("נמחק אוטומטית", "באינסטגרם הוא נמחק לבד כשאפשר").
- The sounds page no longer says "API"; the results page no longer names Zernio.
- Left for the parallel branch `paywall-notify`, which owns the connect flow and Zernio's errors: the connect panel's
  "אי אפשר לחבר עכשיו: בשרת לא מוגדר ZERNIO_API_KEY", the connect result page's "בשרת הזה עוד לא הוגדר Zernio", and
  Zernio by name in the connect copy and in accounts' setup checklist ("מחברים דרך Zernio"). Once that branch is in,
  check that none of these reach a customer.

### The month's plan is the customer's, shared by their accounts

- **What it is.** A customer's slideshows and redos a month are their workspace's: the full plan 40 and 10, the small
  plan 15 and 4, as accounts says in its entitlement answer (`plan`). Every account of the workspace draws on the same
  month, so a second account gives more pages, never more posts. Each account's schedule is thinned to its even share
  of the month (src/budget/quota.js monthShare) so they all post through the month. The operator's own accounts, in no
  workspace, keep a month each, and the operator's numbers on Settings ("לשנות מכסה") apply to them only.
- **Where it shows.** The customer's Settings shows the month once, with each account's count under it; the Accounts
  page and the home page say when it is the accounts' month together. The operator's "מכסות ועלות לפי לקוח" shows each
  customer account's own count beside the workspace's, and says the plan comes from accounts.
- **What to do.** To change a customer's plan, change their subscription's plan in accounts (/admin). Teder reads it
  within five minutes. An answer without a plan (an older accounts) is the full plan.

### A light edit's fact check: 30 a day per customer

- **What it is.** Editing a post's text is free in the plan, but each edit is checked by the model (tag `edit-check` in
  the spend ledger). A customer's workspace gets 30 such checks a day across its accounts (src/web/actions.js
  EDIT_CHECKS_PER_DAY); past that the edit is refused for the day with a Hebrew line that says so. The operator is not
  limited.

### What is deleted on its own, and when

- **What it is.** One pass a day in the runner (src/billing/retention.js), from the periods on the privacy page:
  a store's demo six months after its last contact (its last request, or the last time its page was opened), with its
  opens and pictures; the TikTok and Instagram a workspace connected, once its Teder stopped (cancelled or switched off:
  the next day; unpaid: 14 days after it stopped, the time the terms give a payment), disconnected from our Zernio team
  and forgotten here, while its posts, sources and settings stay; the public copies of slides three days after they
  were made; and every Zernio removal that failed before (a deleted workspace's, a stopped one's), tried again every day
  until Zernio does it.
- **Where it shows.** The log, one line a day: "[retention] N demo(s) past 6 months removed, ...". The audit log has
  `retention`, `connections_removed` and `zernio_removals` entries. What is still to remove on Zernio is in `settings`,
  key `zernio:removals`.
- **What to do.** Nothing. A removal that keeps failing (its `lastError` in that row) is worth a look on Zernio. A
  stopped customer who pays again connects their TikTok and Instagram again; their profile is kept for that.

### The nightly backup

- **What it is.** `scripts/backup.js` (openfrequency-backup.timer, 03:30 UTC, as the user openfrequency) copies the database and every pack folder (the customer's
  setup: voice, theme, formats, rules, the facts they checked and their photographs) into `data/backups/`, 14 of each,
  and opens the database copy and checks it. A copy that fails the check is removed and the unit fails. `.env` is not
  copied: keep it off the server (a password manager). How to restore is at the top of src/db/backup.js.
- **What to do.** Copy `data/backups/` off the server: on the same disk it is no backup against losing the disk.

## Settings the operator controls

### OF_SIGNUP_OPEN and OF_SIGNUP_URL: where a demo page sends people

- **What it is.** A store's demo page (`/s/<slug>`) ends with "להפעיל את תדר". With `OF_SIGNUP_OPEN=1` it goes to
  accounts' sign-up, `OF_SIGNUP_URL` (https only; empty is `https://accounts.openfrequency.co.il/signup`). Without it
  the button goes to the website's `https://openfrequency.co.il/join?p=teder`, so nobody is sent to a page that does
  not take them yet.
- **What to do.** Leave `OF_SIGNUP_OPEN` empty until accounts really has a public sign-up page (today accounts signs
  in existing customers and invited people only). When it does, set `OF_SIGNUP_OPEN=1`, and `OF_SIGNUP_URL` if the
  address is not the default (for example with a `?p=teder` the sign-up page reads).
- **Needed now?** No. It is the switch for the day self-serve sign-up opens, together with `BRAVE_API_KEY` and
  `ANTHROPIC_API_KEY` above.

### Posting days and times are the customer's

- **What it is.** Each account's owner chooses on Settings (the account shown in the switcher), and before going live
  on the new-account page, which days to post on and at what time, up to two times a day, and whether to post on
  Shabbat ("לפרסם גם בשבת") and on the festivals ("לפרסם גם בחגים"). Both are off unless the owner ticks them: off,
  nothing posts from candle lighting to nightfall, whatever times are chosen; on, those days post like any other, at
  every rail (slots, the runner, the publish path, TikTok drafts, held posts). An operator's pack can say the same in
  pack.json (`schedule.shabbat`, `schedule.holidays`, true or false); an owner's saved choice wins. The choice is stored
  in `settings` as `schedule:<account id>` (`{ byDay, shabbat, holidays, at }`) and is laid over pack.json's `schedule`
  (its slots, posting windows, posts a day and the two flags; a fight week stays the pack's). A new account
  starts with two posts Sunday to Thursday (12:30, 19:30), Friday 12:30 and Saturday 21:00: about 45 to 54 slots a
  month, at least 45 in every month of 2026 to 2028, festivals included. A month with more slots than the account's
  plan (40, 15 on the small plan, or what the operator set for one of our own accounts; for a customer with several
  running accounts, each one's even share of it) is thinned evenly to it, a day's second slot first, so the posts last
  the whole month; the quota still caps it.
- **Where it shows.** Settings, "מתי מפרסמים", says how many posts next month gets and how many chosen times fall on
  a Shabbat or a festival the account does not post on.
- **What to do.** Nothing. When the day's posts are written (`generateAt`, 07:00) is still the operator's, on
  Settings. An account with no choice saved (the accounts made before this) keeps its pack.json schedule exactly as
  before, until its owner saves one. To undo an owner's choice, delete the `schedule:<account id>` row from `settings`.
