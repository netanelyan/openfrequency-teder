# open-frequency

One engine that runs several Hebrew social accounts, each in its own niche and with
its own brand. Every day it reads approved sources, plans slideshow posts, proves
every fact against a quote it stored, writes the slides in the account's voice,
checks them in code, renders them, and sends them to TikTok (through Zernio) and
Instagram (through Meta's own Graph API) once the owner approves, or on its own when
the account is trusted to.

The owner works in **Teder** (תדר), the engine's website: one screen for the day,
one tap to approve, every slide traceable to its source.

<p align="center">
  <img src="docs/screenshots/today-phone.png" width="250" alt="Today, on a phone">
  <img src="docs/screenshots/post-desktop.png" width="560" alt="A post, on a desk">
</p>

This repository is public. It holds the engine, the website, the tests, the docs
and one fictional demo pack. The real accounts, their database, rendered media and
keys live in a private folder, `$OF_HOME`, that is never committed
([The private folder](#the-private-folder)).

**Contents:** [Try it](#try-it) · [What it does](#what-it-does) · [Teder](#teder-the-website) ·
[How a post is made](#how-a-post-is-made) · [Kinds of post](#kinds-of-post) ·
[The hard rules](#the-hard-rules) · [Accounts](#accounts-packs) ·
[Autonomy and learning](#autonomy-and-learning) · [The plan](#the-plan-not-a-budget) ·
[Publishing](#publishing) · [Commands](#commands) · [The private folder](#the-private-folder) ·
[Deploying](#deploying) · [Layout](#layout)

## Try it

```bash
npm install
npx playwright install chromium
npm run demo        # three fictional brands, then the website on localhost:4700
```

`npm run demo` builds a throwaway home in `./.demo`, makes posts in every state from
the demo pack's recordings (no network, no keys, no model), and serves the website
with a stand-in for openfrequency-accounts that signs the browser in on the first visit.
Nothing in it is real, and the Results page says so.

Requires Node 22.13 or newer (for `node:sqlite`); developed on 24.

## What it does

- **Reads only approved sources.** Feeds, pages, JSON and CSV APIs, Wikipedia,
  data.gov.il, hand-checked facts, and a topic bank the owner curates. Each source
  carries why it is trusted and what its terms allow.
- **Proves every fact.** A fact on a slide is a claim plus a quote copied word for
  word from a stored document of an approved source. Every number on a slide must be
  in its quotes. The renderer refuses text the fact gate has not signed.
- **Writes like a person.** Each account has its own voice guide with good and bad
  lines, and every writing call gets the same Hebrew voice: the concrete detail first,
  everyday words, a long sentence beside a short one, and a read-aloud pass before it
  answers. Code refuses what is always ad copy or machine text ("זה לא X, זה Y",
  "בלי X ובלי Y", fragments in a row, a colon in a heading, teasers, form and translated
  Hebrew, stock phrases, long dashes, lists of four). What is only usually a tell
  ("לא X אלא Y", "כ-80", a passive "על ידי"), and what shows only across a post (every
  sentence the same length, every slide ending on a punch line, one word everywhere),
  goes to the reviewer as a hint beside the line. The reviewer scores each line, and
  only the flagged lines are rewritten, as whole sentences.
- **Draws as much as it writes.** At least half of a post's slides carry a picture:
  a licensed photograph checked against its slide, or a graphic drawn from the
  slide's own numbers.
- **Publishes carefully.** Never on Shabbat or a festival, never with engagement of
  any kind, always with the platforms' AI label, within each account's monthly plan
  of 40 slideshows and 10 redos.
- **Learns.** It reads each post's numbers at 72 hours and moves the mix of formats
  and cover lines toward what works.

## Teder, the website

Five sections, the same on a phone and a desk:

| Section | |
|---|---|
| **Today** | the day at a glance (a row of dots per account: waiting, scheduled, out, stopped), then every post that waits for you, decision first: the cover line, the slides, what the checks found in one line, and approve, edit or reject. Captions and facts fold open below |
| **Accounts** | each account's mode, schedule, kill switch and week; the rivals you watch for it; a new account |
| **Results** | this morning's feedback for each account (its last three days' posts in four boxes, and what each box changes in the next posts), each post's numbers, and what the engine learned from them, in plain words |
| **Sources** | every source with why it is trusted, hand-checked facts, adding and removing |
| **Settings** | the month's plan (a customer), what the month cost and each account's plan (the operator), which keys are set (never their values), your account and signing out |

A post's own page shows the whole trace: every slide, its facts, their quotes, the
stored document and the source. The site follows the system's light or dark setting,
works without JavaScript, and adds to a phone's home screen. Its mark is Teder's
wave on violet; the footer carries the company's, OpenFrequency's halftone on blue
(both from [`assets/brand`](assets/brand/README.md)).

## How a post is made

```
topics first: the owner's bank, then this week's signals (a Wikipedia page read far
  more than in the month before, the most-viewed Shorts for the account's searches),
  each scored 0-10 for stopping a scroll; a signal under 6 is never drafted
format (by the mix and results)
  -> the chosen topic searched in the approved sources (its stored documents, then
     research); a topic nothing approved supports is left, and the day's documents
     are drafted instead
  -> documents from the format's approved sources (the topic bank first)
  -> outline: the angle, the facts with their quotes, the articles to read next
  -> research: those articles read, the details a fan would want, each verified
  -> slides, captions and graphics, in the account's voice
  -> checks in code: voice, honesty, the kind's shape, lengths, the fact gate
  -> one redraft if needed -> review -> rewrite of the flagged lines only
  -> photographs, screened and checked against their slides -> render
  -> approval (by the account's mode) -> publish at the slot -> numbers at 72h -> learn
```

Every step is a row in the database, so any slide traces back to its fact, the
quote, the stored document and the approved source.

A post that a check stops is not patched by hand: it is made again from another
topic, and the attempt is kept with what stopped it.

## Kinds of post

A pack's format is one of eleven kinds (`src/formats/kinds.js`). The engine owns the
shape, checks it in code and draws it; the pack brings the name, the angle (`about`),
the cover patterns and the calls to action.

| Kind | Group | Shape (after the cover) |
|---|---|---|
| `story` | entertaining | 3 to 5 build-up slides, the twist or the ending last |
| `what-happened` | entertaining | then, the turn, now |
| `on-this-day` | entertaining | context, the moment, what came after; only from documents that name the day |
| `guess-who` | entertaining | 3 clues from hard to easy, the answer last and nowhere before it (checked in the cover, clues, captions and keywords) |
| `iceberg` | entertaining | 4 to 6 layers, famous to obscure |
| `hot-take` | entertaining | the opinion, labelled as one, then its sourced case |
| `myth-fact` | entertaining | 2 or 3 pairs: the myth as people say it, the fact that answers it |
| `meme` | entertaining | 3 to 5 jokes in the account's design, the real fact behind them last |
| `do-dont` | entertaining | 4 to 6 rules from a guideline, each drawn as the same screen done wrong and done right |
| `head-to-head` | number | two sides, 3 to 6 stats with both values, the verdict last |
| `ranking` | number | a top 5 (or 10), number one last; the design draws the places |

Every post has 5 to 8 slides, one idea a slide, keywords in Hebrew and English for
TikTok's search, a TikTok caption and a short Instagram one led by the cover line.
The TikTok caption tells the post as a story in four lines: the hook, the problem,
the discovery and the result, with the closing question at its end
(`src/rules/caption.js`). By default it is long (200 characters and up, for search);
an account can ask for short, catchy captions and a short line under the cover
instead (`writing` in `pack.json`), and still gets the four lines. No caption holds a
hashtag: the engine adds the post's own, five at most, and the publisher refuses a
caption with more.

**Pictures.** The engine draws its graphics from data the model writes on a slide: a
timeline, stat bars, a head-to-head card, one big number, a calendar page, a pitch
with players, a fight record, a weight-class ladder, price cards, a mock screen, the
same screen drawn wrong and right, and more; each theme names the ones that fit it. A slide about a person or a place can
ask for a licensed photograph: it is used only if its own description names the
subject, it passes the image screen, and a vision check says it fits the slide, with
the crop aimed at the face. Otherwise the slide keeps its graphic.

## The hard rules

| Rule | Where it is enforced |
|---|---|
| 1. Official APIs only; no likes, follows, comments, DMs or logged-in reading | `src/core/net.js` is the only `fetch`. Its write allowlist is Claude, Zernio's create-post and create-profile (a customer account's folder on our own Zernio team), Meta's two publishing endpoints, deleting our own Instagram post after a takedown notice, and an empty Web Push to the owner's own browser (no words in it; never Telegram, a social host). It refuses Zernio's inbox and every Graph edge for comments, mentions, tags, messages, hashtags and other accounts by name. Tests scan the code for any other `fetch` |
| 2. Each account a distinct brand | `src/packs/validate.js`: no two packs share a template, a display face, a handle, a name or a palette too close to tell apart; under the slide styles, two accounts may share a style but never a style and a close accent; a cross-promotion check on every post |
| 3. Honest by construction | `src/verify/claims.js`: every quote verbatim in a stored document of that account's approved source, every number in its quotes, the render gate's token. `src/voice/honesty.js` refuses invented experience and fake badges or metrics |
| 4. AI disclosure | TikTok's `video_made_with_ai` flag through Zernio; a caption line on Instagram |
| 5. Rights | photographs from Pexels, Unsplash and Wikimedia Commons (licence stored, Commons licences on an allowlist, logos and crests refused); every photo screened for blood, injuries, weapons, watermarks; takedowns on notice; quotes short (4 to 40 words) |
| 6. No investment advice | `src/rules/compliance.js`, required for any money niche |
| 7. A plan per account, not a money cap | `src/budget/quota.js`: 40 slideshows and 10 redos a month per account, weighed before a post is started; what each call cost is recorded (`src/budget/ledger.js`), never capped |
| 8. Hebrew, right to left | every slide and page is `lang="he" dir="rtl"` (tested) |
| 9. Shabbat and the festivals | `src/schedule/`: from candle lighting to nightfall, from the real sunset and the Hebrew calendar; the scheduler never plans such a slot and every publisher refuses one |
| 10. Secrets | `.gitignore`, `check:public` and its pre-commit hook; `.env.example` lists every variable (tested) |

## Accounts (packs)

Adding an account is never code. Either on the website (*Accounts* > new account:
a niche, an audience and a few example sites; the engine finds and scores sources,
suggests formats, writes the pack with a look no other account has, and five sample
posts must pass before it goes live), or by hand: `npm run init-private -- --pack <id>`
and edit its files.

| File | Holds |
|---|---|
| `pack.json` | id, display name, handle, bio, platforms and the publisher of each, Zernio and Instagram ids, schedule (windows, slots, posts per day), autonomy mode, compliance checks, topics, audience; `imagery` (providers, `safety`); `research` (`minDetails`, `maxAgeDays`); `events` and `schedule.fightWeek` for an account that follows fight cards; `endSlide`, a closing slide that asks to follow; `overlay`: the text on the slides (`wordsPerLine` [4, 6], `linesPerSlide` [3, 4], `safeZone` { top 0.1, bottom 0.2 }, `outline` in em, more `labels`); `writing`: shorter limits than the engine's for `cover`, `sub` (the line under the cover), `slideTitle`, `slideBody`, `slideLines`, `captionLong` (TikTok's) and `captionShort` (Instagram's), in `maxChars`, `sentences`, `maxWords` and `minChars` |
| `voice.md` | who is talking, to whom, how it sounds, with `## שורות טובות` and `## שורות רעות` |
| `theme.json` | a template and variant from the engine's library, colours, fonts, the graphics it draws (`visuals`), whether slides sit on a blurred photograph and the scenes searched for it (`backgroundQueries`) |
| `sources.json` | approved sources only: type (`rss`, `web`, `api`), url, why it is trusted, what its terms allow, when it was approved. A source taken out of the file is no longer read |
| `formats.json` | the account's formats, each of one kind, with a name, weight, angle (`about`), the sources it draws from, cover patterns and calls to action; the mix of entertaining formats; caption questions, hashtags, trend queries |
| `topics.json` (optional) | the topic bank: chosen topics, each with its kind (or one `format` of that kind), its angle, and the pages that document it, drafted from exactly those pages |
| `rules.json` | banned phrases, regex checks, words that refuse an image search, the longest quote |
| `photos/`, `facts/` (optional) | photos the owner cleared for the account, and hand-checked facts with the day they expire |

Validation refuses a pack with weak contrast, a source without https or a reason to
trust it, a money niche without the investment-advice check, or anything two packs
share.

### Slide styles

An account can be drawn in one of four slide styles (`pack.json` `"style": { "name", "accent", "bg", "panel", "test" }`,
`src/render/styles/`). A style keeps the post as it is (its slides, their order, which
slide carries a number) and replaces the type, how the text is treated and the chrome:

| Style | | For |
|---|---|---|
| A, editorial card | dark; a photograph above, the number on a card (Heebo, Assistant) | prices, data, comparisons: finance, real estate, travel, tech, B2B |
| B, poster | a condensed face set huge, the key words on a block of colour, a framed photograph (Karantina, Rubik) | sports, combat sports, gaming, fitness, events |
| C, split | light; the photograph on top, the text on a light panel, never on the photograph (Rubik) | fashion, beauty, food, home, wellness, shops, kids |
| D, native dark | a photograph fading into a dark ground, a condensed headline (Karantina, Rubik) | news, history, culture; the default |

No letter has an outline or a shadow, and no slide carries a progress bar, a counter,
dots, a handle or a blurred photograph: TikTok draws its own furniture. Text keeps out
of TikTok's bands on all four sides (top 140, bottom 420, both sides 152 px, since the
Hebrew app mirrors its button rail; Instagram's 4:5 keeps 80, 120 and 96), and the
renderer refuses a line inside one. Each slide may mark one `highlight`, a short phrase
of its own headline, which the writer chooses. A headline is set smaller in steps down to
its style's floor before it takes another line; one still too long is a check failure
the repair loop sends back to the writer, with about how many characters fit
(`src/render/styles/fit.js`, from the bundled faces' widths: `npm run styles:metrics`).

Onboarding suggests a style from what the account is about and its colours, and gives
a second customer in the same niche with a close colour the next best one
(`src/onboarding/style.js`). On Teder, *Accounts* > *להחליף סגנון* shows the account's
last post in all four styles side by side and switches it; a switch applies from the
next post. An optional style test draws the posts in the two best-fit styles in turn for
14 days, and the morning feedback then locks the one whose posts did better on views
and engagement together (shown in *Results*). `npm run styles:review -- <account>=<db>`
draws an account's last post from another database (a launch set) for that page.

## Autonomy and learning

| Mode | |
|---|---|
| **Approve** | every post waits for the owner; unapproved by the end of its day, it expires. The default |
| **Digest** | posts go out at their slot unless rejected before it |
| **Auto** | posts go out; a daily summary is written to the website |

In every mode there is a kill switch per account and a global one, and an automatic
pause on a platform strike, a streak of publish errors or repeated takedowns. A
paused account says why. A failed fact check blocks that one post, and the account
goes on. In Digest and Auto, a post the reviewer
found a little machine-like waits for the owner anyway.

At 72 hours the runner reads each post's numbers (TikTok through Zernio, Instagram
from Meta's insights; never a number an API did not give). It moves the account's mix
of entertaining and number posts by up to 5 points a week (between 40% and 80%),
keeps 70% of posts on proven formats and 30% on trials, drops a format after three
weak results in a row, favours the cover patterns that work, and once a week looks at
formats that do well on YouTube Shorts, copying the format, never the content.

**The morning's feedback.** Each morning before anything is drafted (`feedbackAt`,
06:30), the last three days' posts are read again and each one goes in a box:
views against the account's own median, read at the same age, by what it led
people to do per view (taps on the bio link where Instagram reports them for every
post compared, otherwise likes, comments, shares and saves; never messages).
High and high: three variations of the cover, from the same story. High views, low
action: the same cover pattern, another call to action and caption. Low views, high
action: the same call to action, a radically different cover and first slide. Low
and low: another format or angle. Each answer becomes a plan the day's first free
slots take, and the writer is told why. Results shows the report and what became of
each plan (`src/metrics/feedback.js`).

**The text on a slide.** Short lines broken by hand (4 to 6 words), 3 to 4 lines
on a slide, titles that react rather than label, nothing in the top 10% or the
bottom 20%, and a thick outline on text over a picture. A line left too long is
broken in code; the rest is checked like any other rule, and the renderer measures
every line against the safe zone (`src/rules/overlay.js`, `pack.json` `overlay`).

**Rivals, typed in by hand.** For each account the owner keeps three to five
accounts like it (Accounts → מתחרים): their handle, the cover lines that did best
for them, their formats, when they post and what they leave out. The engine never
reads another account itself (hard rule 1), so this is what the owner saw while
scrolling the niche. The gaps steer the outline's topic and angle, the covers are
what the writer must stand apart from (never copy), and their hours are shown beside
the account's own slots without moving them. A rival not updated in 30 days is
marked; after 60 it no longer reaches the writer (`src/pipeline/rivals.js`).

**Fight week.** An account that follows fight cards reads the calendar daily. Three
days before a card its first slot is a tale of the tape, the day before a pick, the
morning after a recap drafted only once the results are in the sources.

**Takedowns and the image screen.** A takedown notice takes the post down at once
(deleted on Instagram through the Graph API where the login allows it; listed for the
owner to delete on TikTok, which has no delete for a third party). A second notice
within 90 days pauses the account. Every photo is screened before use: words in its
description, deep red, and with a live key a vision model; what none of them clears
waits for a person.

## The plan, not a budget

There is no money cap. Every account (a page) gets **40 slideshows a month and 10
redos**, and that plan is the only limit (`src/budget/quota.js`). A slideshow counts
when it reaches the customer for approval, whatever they do with it; a redo is a
replacement written for a post they rejected with a reason; a post our checks stopped
is ours and is not counted. When an account's 40 are used, nothing more is drafted for
it until the next month. The operator can give one account another number of posts on
Settings, never a sum of money.

- **What bounds the spend.** 40 slideshows and 10 redos a month per account, and
  inside each post a fixed number of calls: at most 6 documents per format offered to
  the outline (`maxDocs`), one slide draft with one redraft, two repair rounds
  (`REPAIR_ATTEMPTS`), two rewrite passes for what the review flags, and a replacement
  our checks stop tried twice at most (`REDO_ATTEMPTS`). The day's slots are drafted
  once a day: a stopped post waits for the next day's generation, never a loop. At the
  measured $0.15 a post made (stopped attempts included) a full month of 50 is about
  $7.50 an account ([docs/costs.md](docs/costs.md)).
- **One door.** Every model call goes through `src/llm/index.js`, and only
  `src/llm/claude.js` imports the SDK. After each call its real cost from the usage
  block is recorded in the ledger (`src/budget/ledger.js`): for the operator's
  Settings (the month's cost, each account's cost by what it went to, the cost per
  post in developer mode), never to refuse a call.
- **Cheap by design.** Drafting on Claude Sonnet through the Message Batches API a day
  ahead, the account's voice and rules as a cached prefix, documents narrowed to
  their content, one redraft at most, a rewrite only for what the review flags.
- **The stops that remain** are not about money: the kill switch per account and the
  global one, a platform strike, a streak of publish errors, repeated takedowns.

Zernio is billed per connected account, and its share per account is in the
operator's ledger beside the API cost ([docs/costs.md](docs/costs.md)).

## Publishing

Each pack names its publisher per platform in `pack.json`
(`"publishers": { "tiktok": "zernio", "instagram": "instagram" }`). A post leaves
only when `PUBLISH_MODE=live` and that publisher has what it needs; anything less
writes the post and the exact request to disk.

**TikTok** goes through Zernio as a photo post, with the AI flag. By default
(`zernio.tiktokMode: "draft-now"`) it goes to the TikTok app's drafts the moment the
post is approved, with a sound from the account's list named for it, and at the
post's hour the owner gets one notification to publish it (Settings turns them on
per device; on an iPhone, from Teder added to the home screen). The engine never
publishes to TikTok itself in this mode. `"direct"` publishes at the slot, and
`"draft-fallback"` sends the draft at the slot and publishes it directly an hour
later if the owner did not. The account page switches between the drafts and
`"direct"`, which is public. `npm run zernio:check` checks the key, each account id
and the bill, and can send one private test post.

**Connecting a customer's accounts.** Each account gets its own Zernio profile the
first time someone presses "connect" on the account page or the onboarding page, or
opens the link the WhatsApp assistant sends (`GET /customers/:ws/accounts/:id/connect`,
[docs/assistant-api.md](docs/assistant-api.md)). The customer logs into their own
TikTok or Instagram on Zernio's screens. Teder reads what got connected, and whether it
still works, from Zernio after a connect and once an hour. An expired token shows as
"צריך לחבר מחדש", and the assistant is told once with a fresh link. Only
`ZERNIO_API_KEY` lives in `$OF_HOME/.env`; the profile and account ids live in the
database. What Zernio bills each profile is read daily into the operator's ledger, next
to the API spend. `"instagram": "auto"` (new packs' default) publishes Instagram
through our own Meta app when the account has it, and otherwise through Zernio.
`"tiktok": "own-app"` is kept for our own TikTok app, which is not built yet
(`src/publish/tiktok-app.js`); until it is, those posts are written to disk.

**Instagram** goes directly through Meta's Graph API as a carousel, free. Two logins
are supported:

- **Instagram Login** (`"auth": "instagram"`, no Facebook Page). In the Meta app's
  *Instagram API with Instagram Login* product, under *Generate access tokens*, add
  the account and generate a token. Put it in `$OF_HOME/.env` as `IG_TOKEN_<PACK>` and
  the account's id in `pack.json` as `instagram.userId`. The token lasts 60 days, and
  the runner renews it by itself once 20 days or fewer are left. This login cannot
  delete a post, so a takedown is listed for the owner.
- **Facebook Login** (`"auth": "facebook"`, the account linked to a Page). Grant a
  short-lived token `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_insights`, `instagram_manage_contents`, `pages_show_list` and
  `pages_read_engagement` in the Graph API Explorer, then
  `npm run instagram:token -- --pack <id> --short <token>` turns it into a Page token
  that does not expire.

`npm run instagram:check` says whether the token reaches the account, when it
expires, the publishing quota left and whether insights can be read. Instagram
fetches each slide from `MEDIA_PUBLIC_BASE_URL`, which must be live first.

## Commands

| Command | What it does |
|---|---|
| `npm test` | every hard rule, offline, then `check:public` |
| `npm run demo` | the fictional demo and the website ([Try it](#try-it)) |
| `npm run web` | the website on `127.0.0.1:4700` |
| `npm start` | the website and the runner: daily drafting, publishing at each slot, metrics, learning, token renewal |
| `npm run dry -- --pack <id> --count 5 [--format <id>]` | builds posts for one pack into its own database and to disk (slides, both captions, every fact with its quote, the trace and cost); publishes nothing |
| `npm run launch -- run\|review\|verdicts\|status\|costs --pack <id>` | an account's launch set ([below](#the-launch-set)) |
| `npm run record -- --pack <id>` | saves a pack's sources as recordings, so it runs offline |
| `npm run visuals -- [--pack <id>]` | every graphic the engine draws, in a pack's theme |
| `npm run screenshots [-- --dark]` | every page at phone and desk width, from the demo |
| `npm run init-private [-- --pack <id>] [-- --git]` | creates the private folder, optionally a blank pack |
| `npm run workspace:assign -- --workspace <id> <account>... [--dry-run]` | puts accounts in an openfrequency-accounts workspace ([docs/workspace-move.md](docs/workspace-move.md)) |
| `npm run backup` | a consistent copy of the database |
| `npm run zernio:check`, `npm run instagram:check`, `npm run instagram:token` | the publishers' checks and Instagram's token ([Publishing](#publishing)) |
| `npm run live-day -- --allow-api --confirm` | one real day of posts on the API, and what each cost |
| `npm run compare -- next\|status\|score` | the cost and quality comparison behind [docs/costs.md](docs/costs.md) |
| `npm run styles:review [-- <account>=<db>...]` | each account's last post in all four slide styles, for Teder's styles page ([Slide styles](#slide-styles)) |
| `npm run styles:metrics` | measures the slide styles' faces again, for the check that a headline fits its style |
| `npm run check:public` | fails if anything committed looks private (also a pre-commit hook) |

**Modes.** `OF_MODE=recorded` runs on each pack's recordings, every check as live;
`OF_MODE=live` (the default when there is a model) reads real sources. **Which model
answers** is the environment's: in development (`OF_ENV=dev`, a laptop) the Claude
Code CLI, headless, one call at a time, never with the project's API key, and every
call to the API itself refused unless the command says `--allow-api`; in production
(`OF_ENV=prod`, the service) the Anthropic API, the day's drafts through the Message
Batches API.

### The launch set

The first posts of a new account, or of an account that changed direction, before the
owner trusts it: `$OF_HOME/launch/<pack>/plan.json` names each post's format.
`launch run` makes each one with the engine's own pipeline end to end (on the Claude
Code CLI in development), and keeps every stopped attempt. Each post lands in
`$OF_HOME/out/launch/<pack>/<n>-<format>/` with its slides, captions, sources,
pictures and their licences, cost and the engine's own review. `review` and
`verdicts` run a blind review: three readers who see only the slides, captions and
source list; a post passes when two of them would read to the end and save, send or
comment. Each round has its own folder and database.

### Topics first

Once a day, before anything is drafted, each account's candidates are gathered: the
names on its watch list (people, teams, companies; edited on the website's Topics
page, or `interest.wikipedia` in pack.json) whose Wikipedia page is read at least 1.5
times as much this week as in the four weeks before, and the Shorts most viewed in
the last two weeks for its `formats.trends.queries` (titles and YouTube's numbers
only, with `YOUTUBE_API_KEY`). The owner adds topics they know went viral (the topic,
why, where) to the bank on the same page. One model call scores the new candidates 0
to 10 overall and on shock, money, rivalry, a hidden story and "I didn't know that";
a signal under 6, or off the account's subject, is never drafted, and a bank topic is
scored to be shown but never skipped. A post takes the best topic in line (the bank's
first), and only then searches the approved sources for what holds it up. A candidate's
link is where it went viral, never a fact's source. The score is on the post's page.

### Research and the topic bank

A format names the sources it draws from, in order, so a curated topic bank comes
before the news. The outline names articles that would tell its subject in more
detail; the engine reads them through the pack's approved sources and pulls out the
details a fan would want, each verified against its stored document. A topic with
fewer than `research.minDetails` (3) is left for the next one. A source is read again
after six hours, or for another day.

## The private folder

`$OF_HOME` holds everything that belongs to the real accounts. It defaults to
`./private/` inside the checkout and is gitignored entirely.

```
private/
  packs/<id>/          one folder per account
  data/                the database, media, public slides, backups
  launch/, out/        launch sets and their exports
  .env                 keys (from .env.example)
  public-denylist.txt  words check:public refuses in the public repo
```

Keep `private/` in its own private git repository for history and backup
(`npm run init-private -- --git`). **`git clean -fdx` in the engine checkout deletes
`./private/`**: commit it first, or keep `OF_HOME` outside the checkout.

`npm run check:public` reads the git index and fails on any file under `private/`, a
key-shaped string, a database, a pack outside `examples/`, media outside
`docs/screenshots/`, any real pack id, handle, display name or Zernio id from
`$OF_HOME/packs`, and every word in `$OF_HOME/public-denylist.txt`.

## Deploying

On a VPS (Ubuntu 24.04 here) behind Caddy, as a small Node service. The steps are
tested end to end in a clean container by `deploy/test/run.sh`.

1. **Node 24 and Caddy**, from their own repositories.
2. **The service user, the code, Chromium:**
   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/openfrequency --shell /usr/sbin/nologin openfrequency
   sudo git clone <this repo> /opt/open-frequency
   cd /opt/open-frequency && sudo npm ci --omit=dev
   sudo PLAYWRIGHT_BROWSERS_PATH=/opt/open-frequency/.browsers npx playwright install --with-deps chromium
   ```
   Then put the private folder at `/opt/open-frequency/private` (a clone of its
   repository, or a copy of `packs/` and `.env`), owned by `openfrequency`.
3. **`private/.env`**, mode 600: at least `SESSION_SECRET` (`openssl rand -hex 32`),
   `OF_INTERNAL_TOKEN` (the same value as openfrequency-accounts'; sign-in is that
   service's, see [docs/workspace-move.md](docs/workspace-move.md)), `PUBLIC_HOST`, `MEDIA_PUBLIC_BASE_URL`, `OF_USER_AGENT` with a contact
   (Wikimedia rate-limits readers without one), and the keys you have.
   For the WhatsApp assistant, `OF_ASSISTANT_SECRET` (the same value as openfrequency-toran's; see
   [docs/assistant-api.md](docs/assistant-api.md)).
4. **The service:** copy `deploy/openfrequency.service` to `/etc/systemd/system/`,
   `systemctl daemon-reload`, `systemctl enable --now openfrequency`. `/healthz` says `ok`.
5. **Caddy:** append `deploy/Caddyfile.example` with your two names (the website, and
   the media host that serves `private/data/public` for the platforms to fetch
   slides from), validate, reload.
6. **The nightly backup:** `deploy/openfrequency-backup.{service,timer}`.

**Updating the engine:** `git pull`, `npm ci --omit=dev`, restart the service.
**Updating an account:** replace its folder under `private/packs/`, restart; the
database follows the pack's files on start.

Every variable is in [`.env.example`](.env.example) with what it is for and where to
get it. The Settings page shows which keys are set, never their values.

## Layout

```
src/core        paths ($OF_HOME), env, clock, the network door, settings, audit
src/db          SQLite (node:sqlite) and the schema
src/packs       loading, validating and syncing packs
src/schedule    Israel's clock, sunset, Shabbat and the festivals, slots, fight week
src/sources     feeds, pages, JSON, CSV, data.gov.il, Wikipedia and Wikidata, the topic bank, hand-checked facts, recordings
src/llm         Claude (official SDK, through the network door), the CLI backend, batches, recordings
src/budget      the plan (40 slideshows, 10 redos), the ledger of what each call cost, prices
src/voice       Hebrew tells, honesty, the reviewer
src/verify      facts against stored documents, the render gate
src/rules       pack rules, cross-promotion, investment-advice compliance, the text on a slide, the caption's story and hashtags
src/images      licensed photographs and the image screen
src/render      fonts, templates and their variants, the graphics, Chromium
src/pipeline    one post from topic to queue, the rivals typed in by hand; export to disk
src/publish     dry, Zernio (TikTok), Instagram, takedowns
src/metrics     reading numbers, crediting formats, the morning's feedback
src/formats     the kinds of post, rotation, the mix, cover patterns
src/trends      formats that work on YouTube Shorts
src/autonomy    the runner and its rails
src/onboarding  source discovery, the API catalogue, writing a new pack
src/web         Teder: server, who is signed in (accounts.js), workspaces, pages, actions, one stylesheet, one script
src/assistant   the WhatsApp assistant's signed internal API and the events Teder sends it (docs/assistant-api.md)
assets/        the bundled fonts and the brand marks (assets/brand)
examples/       the fictional demo pack and the blank pack
scripts/        the commands above
test/           node:test, one file per area
deploy/         systemd units, the Caddyfile example, the clean-container test
docs/           decisions, plan, costs, report, session log, screenshots
```

Why things are the way they are: [`docs/decisions.md`](docs/decisions.md). The
original plan: [`docs/PLAN.md`](docs/PLAN.md). Costs: [`docs/costs.md`](docs/costs.md).

## Licence

Not licensed for reuse yet. The bundled Hebrew fonts are under the SIL Open Font
License (licence files in `assets/fonts`).
