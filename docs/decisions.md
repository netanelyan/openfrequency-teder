# Decisions

Each entry: what was decided, the alternatives, and why. Newest at the bottom.

## Dependencies

Three runtime dependencies, each doing a job nothing built in can do:

| Dependency | Why |
|---|---|
| `playwright` | Hebrew needs real bidirectional layout and shaping. A headless Chromium renders the slides and takes the website screenshots. A canvas library would reverse strings and mis-shape final letters. |
| `@anthropic-ai/sdk` | The official Claude client. It takes a custom `fetch`, so it is handed the engine's own network door and its requests pass the same allowlist as everything else. |
| `fast-xml-parser` | RSS, Atom and RDF feeds. A regex feed parser is a bug farm; this one is pure JavaScript and small. |

Everything else is Node's own: `node:sqlite` for the database, `node:test` for tests, `node:http` and `node:crypto` for the website and its login. No web framework, no template engine, no CSS build.

## SQLite through `node:sqlite`, Node 22.13 or newer

`better-sqlite3` is the usual choice and needs a native build on the VPS. `node:sqlite` is built into Node (unflagged since 22.13), synchronous like better-sqlite3, and one file. The cost is a newer Node; the VPS already runs 24.

## One network door, and the Anthropic SDK goes through it

Hard rule 1 says there is no code path that could like, follow, comment or DM. It is enforced by structure rather than by care: `src/core/net.js` is the only module that calls `fetch`, its allowlist has exactly two write rules (Claude's messages endpoint, Zernio's create-post endpoint), social platforms are readable only through listed official API paths, and Zernio's inbox, comments and messages are refused by name. A test scans the code for any other `fetch(`, for engagement-shaped function names, and for engagement endpoints.

## Shabbat from the real sunset, not fixed hours

The earlier pipeline blocked Friday 15:00 to Saturday 20:00, approximate on purpose. The brief here says "Friday sunset to Saturday night", so the window is computed per week from Jerusalem's sunset (the USNO almanac algorithm, accurate to about a minute), from 40 minutes before Friday's sunset (Jerusalem candle lighting) to 50 minutes after Saturday's. The margins can be widened, never narrowed below 18 and 40 minutes. Holidays (Yom Tov) are not blocked yet; that needs a Hebrew calendar and is listed as a next step.

## Recorded clients instead of mocks

Every external client has a real implementation and a recorded one. A pack can carry `recordings/documents` (real fetched documents) and `recordings/drafts` (the answers to the two drafting calls for each document). The pipeline sends the same prompts and schemas either way; every check, the fact gate, the reviewer heuristic and the renderer run on recorded answers exactly as on live ones. That makes the whole system runnable and testable offline, and `OF_MODE=live` switches it to the real thing. A recorded draft is never redrafted: if it fails a check, the post is blocked, which is what the check is for.

## Cost of a recorded post is an estimate, and says so

With no API key there is no usage block to bill from. The ledger records what the exact prompt and the recorded answer would have cost at the model's published rate (Hebrew counted at about 2.2 characters a token, English at 3.6, output tripled for thinking), with `estimated = 1`. The website and the dry run label it as an estimate.

## Templates are code, a pack chooses one

"Account packs are config only" and "no shared visual template" pull in opposite directions: either every pack ships its own CSS (code in a pack), or packs share templates. Packs choose a template and variant from the engine's library and bring their own colours and fonts; validation refuses two packs on the same template and variant, the same display face, or palettes within a ΔE threshold. Five templates with two variants each make ten accounts possible without code; the eleventh needs one new template file.

## The fact gate signs the text it checked

The renderer refuses any post whose text does not hash to the token the gate issued. An edit on the website runs the checks again and issues a new token; there is no way to get unchecked text onto a slide.

## Facts are checked per slide, numbers included

The quote check proves a claim is traceable. It cannot prove the Hebrew claim says what the English quote says, so two more rules carry part of that: every number a slide states must appear in the quotes that slide cites, and a quote must be 4 to 40 words (long enough to be evidence, short enough to be a short fact under copyright). The reviewer call is asked for a `factProblem` on top.

## Investment advice is an engine check, not a pack rule

A pack's `rules.json` holds taste. The Israeli investment-advice rule is law, so it lives in the engine (`src/rules/compliance.js`), a pack enables it by name, and a pack whose own description is about money fails validation without it. It refuses a recommending verb near a specific product, provider, ticker, index or track; a superlative pick; a return promise; an imperative to buy or sell. Explaining how something works passes.

## The repository is public; real data lives in `$OF_HOME`

The owner's instruction mid-session (2026-10-13): the repo becomes public and holds only the engine, the website, tests, docs and one fictional demo pack. Real packs, the database, media, recordings and keys live in `$OF_HOME`, which defaults to `./private/` inside the checkout and is gitignored entirely (an earlier version of the instruction put it at `../open-frequency-private`; it was moved inside the checkout the same day). `npm run check:public` reads the git index and fails on anything under `private/`, a key, a database, a pack outside `examples/`, media outside `docs/screenshots/`, or any real pack id, handle, display name or Zernio id (read from `$OF_HOME/packs`) and any word in `$OF_HOME/public-denylist.txt`. It runs in `npm test` and as a pre-commit hook. Every test runs on a throwaway copy of the demo pack. No commit existed before the change, so no history needed rewriting.

`git clean -fdx` deletes `./private/`. The README says so and recommends making `private/` its own private git repository (`npm run init-private -- --git`), so it is backed up and the VPS can pull it.

## Recordings of real sources live with the real pack

The real packs' recordings are documents fetched from real, approved sources, and the drafts written from them. They are private (they name real sources and real content), so they live in `$OF_HOME/packs/<id>/recordings`, never in the repository. The demo pack's recordings are invented text on reserved `example.*` domains.

## Publishing needs three switches, not one

A post leaves through Zernio only when `PUBLISH_MODE=live`, `ZERNIO_API_KEY` is set
and the pack's own `pack.json` says `"publisher": "zernio"`. A key alone is not
consent to post publicly to a real account; the owner turns that on deliberately,
per account. Everything else uses the dry publisher, which writes the exact request
Zernio would have received.

## One process: the website and the runner

`npm start` runs both. The runner ticks once a minute and never overlaps itself; a
second process would need a lock on the database for no benefit at this volume. The
website alone (`npm run web`) is for looking without anything moving.

## Digest and Auto hold back a post that sounds a little like a bot

The reviewer's score blocks a post at 6 or more. A post that scored 4 or 5 and could
not be rewritten cleanly is allowed in Approve mode (the owner reads it anyway) but
waits for the owner in Digest and Auto, where nobody would.

## The demo shows three fictional accounts

`examples/packs/demo` is the one tracked pack, as asked. The Today and Accounts pages
exist to show several brands side by side, so `npm run demo` adds two more fictional
brands, generated at run time into `./.demo` from `scripts/demo-extras.js`. They are
never a pack folder in the repository. The demo seeds a few readings so the Results
page has something to show; each is marked `demo-seed`, and the page says, in a
banner, that the numbers are invented. The engine itself never writes a number an
API did not give.

## The API catalog lives in the engine

Onboarding suggests open, structured sources (Wikidata, data.gov.il, the CBS and
Bank of Israel APIs, openfootball, Open-Meteo, GitHub's changelog) when the seed's
words match. It is a list of public data sources with keywords, not code about any
one account, and a structured source is the best kind there is for this engine: a
number from an API is quotable exactly and nobody's prose is copied. Adding one is a
line in `src/onboarding/apis.js`.

## Hebrew is counted by words, and some checks were loosened by evidence

Running real content through the checks changed three of them. The "mostly Hebrew"
check counts words that carry Hebrew, not letters, so a button name in Latin letters
inside a Hebrew sentence passes and a Latin sentence does not. The cover's word count
splits on whitespace, so `ש-Gemini` is one word. The singular-"you" list keeps only
unambiguous forms, because the masculine future (`תוכל`) is spelled exactly like the
third person feminine (`Google תוכל`). And the render's fit check tolerates a tall
face's descenders spilling out of a tight line box: only a whole extra line is an
overflow.

## Owner-written text keeps its own direction

Source names, reasons and URLs are whatever the owner or the source wrote, often
English. They render with `dir="auto"` inside the Hebrew page, so an English sentence
keeps its period on the right side. The engine's own words, the catalog's reasons and
the demo's are Hebrew.

## Dry runs have their own database per pack

`npm run dry` recreates `$OF_HOME/data/dry-<pack>.db` and its media folder every
run, never touching the live database, and two dry runs for two packs can go at once.
A pack that is not valid yet is skipped (with a warning) when another pack's dry run
loads the set for the brand checks.

## Sources behind bot protection are not read

Several of the best Israeli sources for a money account answer an automated
reader with a Cloudflare challenge or a 403 from Imperva or Radware. The engine
does not drive a browser through those, rotate addresses, or pretend to be a
person: a site that has put up a gate has said no to automated reading, and
getting past it is the kind of evasion the hard rules exist to rule out. Those
sources come in when they offer a feed or an API.

## A count in Hebrew words is a number

The fact gate compared only digits, so a slide could say "חמש" against a quote
that said four. Hebrew counting words from three up (with their construct forms,
tens, and up to two prefix letters: "ובשלושת") are now numbers on item slides and
in quotes. One and two are left out: "אחד הצמחים" and "יום שני" are not counts, and
a guard that refuses correct Hebrew gets switched off. The cover and the caption
are left out too, where "שלושת הטיפים" is the post's own count.

## Provider names that are ordinary words need context

The investment-advice check refused correct Hebrew: "כלל" (a rule, "בדרך כלל"),
"מגדל" (a tower), "מנורה" (a lamp) and "מור" (inside "המורים") are also the names of
financial companies. Those names now count only next to a company word ("מגדל
מקפת", "כלל ביטוח"), after "חברת" or "בית ההשקעות", or where money is moved to them
("תעבירו את הקרן למגדל"). A bare name next to "כדאי" is no longer caught by this
part; the superlative, the return promise and the buy-or-sell checks still are.
That trade is why a financial pack starts in Approve mode.

## A photo credit is added after the checks

CC BY and CC BY-SA require the author and the licence. The credit line goes into
the caption when it is published or exported, after the fact gate: "CC BY-SA 4.0"
is not a claim, and its 4 is not a number to trace. A Commons photo whose licence
asks for credit and that names no author is not used.

## Phase 2 (2026-10-13): live on $15 a month

### The cap is enforced by reserving the worst case

`OF_BUDGET_MONTHLY_USD` ($15 by default) covers every metered service but Zernio.
A guard that compares an *estimate* with the cap can be crossed by a call that
costs more than its estimate, and a day's drafts in one batch are many calls in
flight at once. So every paid call reserves its ceiling first: its prompt's bytes
(no token is shorter than a byte) plus framing, every token billed at the dearest
input rate it can be (a 1-hour cache write), and all of `max_tokens` at the output
rate; with a server-side fallback, at the dearest model there is. The reservation
and the check are one transaction. The real cost from the usage block replaces it.
A call can cost less than its ceiling and never more, so the sum of real costs
cannot cross the cap. The price is that the last few dollars of a month can sit
unused when no call's ceiling fits in them. The website can lower the cap for a
month, never raise it: the cap belongs to the private `.env`.

Alternatives: counting tokens exactly with the API's `count_tokens` (one more
call per call, and the owner asked for the key not to be spent on anything that
does not need it); keeping a margin (a guess, not a proof).

### Shares, and cutting volume rather than quality

Each account's share is the cap by `budget.share` weights, after 5% kept for
onboarding. Every day, before drafting, the month is forecast: what was spent
and held, plus the slots still to draft this month (Shabbat and festivals
excluded) times the measured cost per produced post (blocked attempts included).
If it does not fit, the weakest account comes down half a post a day at a time to one a day, then the next; past that, to a post every other day (see *The cut comes in half posts*, below).
"Weakest": by its own 72-hour results against the median of its platform; with
none yet, by how often the owner approved its posts; with neither, the one whose
posts cost most. The money a cut frees goes to the accounts that keep their
volume, and the allocations become each account's cap for the month. A budget
pause now lifts as soon as the plan gives the account room again, not only at the
month's turn. 80% spent warns on every page; 100% stops all drafting.

### Drafting through the Message Batches API, a day ahead

The pipeline stays a plain sequence of `askJson` calls. The batcher is a model
client whose answers are held until every post being built in the run is
waiting on the model; then all their requests go as one batch. A day's posts
cost one batch per step (outlines, slides, reviews) rather than one call each,
at half price. Results are read and recorded in full before any post resumes,
or the first to resume would send its next request alone (the test caught this).
Every batch is written to the `batches` table with what each request was for;
after a restart the runner reads the results of any batch not yet recorded and
records their cost, and closes the posts that lost their builder. Generation
moved to the day before: tomorrow's slots, plus today's empty ones that are at
least three hours away. `OF_BATCH=off` goes back to direct calls. Server-side
fallbacks stay on direct calls (the Batches API does not take them).

### Prompts built for the cache

Each request is the pack (voice guide with at most five examples a side, every
format, the Hebrew rules, the law) as the first system block, then the task's
fixed instructions, then a user turn with only what changes per post. The pack
block is the same for the outline, slides and rewrite calls of an account, so
they share one cached prefix: a 1-hour cache in batches (rounds can be more than
five minutes apart), 5 minutes for direct calls. Before, the format and the
slide count sat inside the system prompt and broke the cache on every post.

### Documents narrowed in code before the model sees them

`focusText` drops runs of three or more short lines with no number and no
punctuation (menus), a page's own buttons and repeated lines, and stops at 7,000
characters. On the 25 recorded documents it sends 37% fewer characters and loses
2 of the 115 quotes the recorded drafts used. The stored text is untouched, so
quotes are still checked against all of it. Bituach Leumi pages also get
`hints.selector: mainContent`.

### Measured by Claude Code, not by the project's key

The owner's instruction mid-session: never spend the project's Anthropic key on
what Claude Code can do. The before-and-after comparison (`npm run compare`) is
answered by Claude Code subagents on the matching models, each answering the
exact request the engine would send, once; the harness plays the engine (fact
verification, checks, redraft and review decisions) and prices every call from
token counts at the published rates. Its limits, in docs/costs.md: token counts
are estimated, thinking is unseen (priced as a range), a subagent is not
byte-for-byte the API model (the `haiku` alias may not be Haiku 5.5), and a
subagent carries context from one topic to the next where an API call cannot.
The one thing only the key can measure, the billed cost, is `npm run live-day`,
for the owner to run.

### Claude Haiku 5.5 exists

Released 2026-10-07, after the API reference this session started from: $0.10 in
and $0.50 out per million tokens, adaptive thinking with effort, a 512-token
cache minimum. It is the `judge` model (scoring sources, reading a trend's
format). Its long-prompt tier (over 100,000 tokens, five times the price) is in
the ledger.

### Instagram directly, TikTok through Zernio, per pack

Zernio bills per connected account; Meta's Graph API is free. Each pack names a
publisher per platform (`publishers`), so this can change without code.
Instagram uses the Facebook Login path by default (a business or creator
account linked to a Page; the Page token does not expire) and also supports
Instagram Login (60-day tokens, refreshed daily by the runner when 20 days or
fewer are left). A token comes from `.env`; a refreshed one is kept in the
database and wins until `.env` holds a different one. The network door gains
exactly two Graph writes (create a media container, publish it) and reads of
numeric objects, their insights, the quota and our own token; it refuses every
edge and field expansion for comments, replies, mentions, tags, messages,
hashtags and `business_discovery`, in the path or in `fields`. A post publishes
platform by platform and never re-sends a platform that is already out. An
Instagram throttle, or a container still processing, waits for the next tick
(three attempts), because Instagram publishes only at `media_publish` and the
retry first asks whether the last container went out; a Zernio error is never
retried blind, since a lost answer to a create can be a post that exists.

### The festivals, from the Hebrew calendar

Ported from the Hebrew calendar of an earlier project of the owner (read only): the molad and
the four dechiyot, Israel's yom tov days only (Rosh Hashana two days, the rest
one). A rest day runs from candle lighting on the evening before to nightfall on
the day, so a festival next to Shabbat is one window. Tested against Hebcal's
Israel dates for October 2026 to October 2028 and against ICU's Hebrew calendar
for every day in between.

### The money pack's official sources

data.gov.il's CKAN API, the Bank of Israel's SDMX series API (CSV) and the CBS
APIs answer a plain client; the HTML sites in front of them do not, and the
engine still does not get past bot protection. New: the Bank of Israel rate as
the dates it changed (`changesOnly`), exchange rates, the dwelling price index,
the average wage per employee job, the maximum prices of controlled products,
the Accountant General's rates, the excise on fuel. Coded columns carry Hebrew
labels so a line reads, and quotes, as written. Pension and provident fund
yields (also on data.gov.il) are left out: a post comparing funds is a step from
recommending one. The Bank of Israel's terms page is behind its bot protection;
a search snippet suggests republishing site content needs consent. Facts (a rate,
a date) are not content, but the owner should know.

CBS `percentYear` is the change from the same month a year earlier: CBS's own
pages do not define it, and computed from the index values it matches 33 of 33
months, where a since-January reading matches 4. The recorded price-index slide
already read it that way; the field now carries a Hebrew label saying so.

### Hand-checked facts

A pack's `facts/` folder holds what the owner read on sites the engine may not
read: each sentence word for word, its page, the day it was checked and the day
it expires (at most two years later). Each topic is one document of a `facts`
source, holding only valid facts, and the document stops being evidence on its
earliest expiry: `verifyFact` refuses it, so a post drafted before a fact expired
is blocked before it is published after. Facts are added, rechecked with a new
expiry and removed on the website. Two topics are seeded from Bituach Leumi pages,
copied word for word by Claude and marked "checked by Claude": the owner should
confirm or delete them.

### Discovery from cache

Brave searches are kept 30 days and YouTube searches 7 (`lookups`), so a weekly
trend run or a second onboarding of a similar niche does not pay again or use the
100-a-day search quota.

### The deploy steps, tested in a clean container

`deploy/test/run.sh` builds a plain Ubuntu 24.04 with systemd and runs the
README's steps in it with podman. The container runs privileged because the
unit's hardening needs mount namespaces, which a VM has and an unprivileged
container does not ("Failed to keep CAP_SYS_ADMIN"); under WSL it also needs the
host's network (`NET=host`), since WSL has no nftables.

## The three accounts (2026-10-14): the content model

### The kind owns the shape, the pack owns the voice

The accounts are entertaining first: the research behind them found that stories,
not stats, carry the biggest accounts. A post is now one of ten kinds (story,
what-happened, on-this-day, guess-who, head-to-head, ranking, iceberg, hot-take,
myth-fact, meme), each a shape in `src/formats/kinds.js`: which slides, in what
order, which of them carry a fact, what the drafting model is told, and what is
checked in code (a guess-who that names its answer before the reveal, a ranking
that writes its own place numbers, a myth that holds a number its fact does not).
A pack's format names a kind and brings its own name, cover patterns and calls to
action, so a new account is still configuration only. Alternative: a free-form
"post type" the model fills as it likes, which would leave nothing for the code to
check.

### The payoff is the last slide; the call to action is drawn on it

The research said 5 to 8 slides, the payoff on the last one. Phase 1's closing
slide (a call to action of its own) would push the payoff off the end, so a new
kind has no closing slide: the design draws the call to action on the last slide,
and the model is told not to write one. The phase 1 shape stays as the `list`
kind, with its closer, for the packs and tests that use it.

### Slides without a fact of their own

A myth as people say it, a verdict, a joke's setup and "agree?" state no sourced
fact, and a post of these kinds needs them. The gate lets those roles stand
without a fact, and still holds every number on them to the post's quotes. Every
other content slide must cite a fact, as before.

### One schema for every kind, for the cache

The outline and slides schemas are the same for every kind (roles, the two values
of a head-to-head stat, the subject, both captions, the keywords), and each kind's
instructions live in the pack's cached block. A schema per kind would break the
cached prefix every time the account changed kinds.

### The code picks the cover pattern and the call to action

So the results can be credited to them: the model is told which pattern to follow,
and the pattern's id is stored with the post whatever the answer says. Each pattern
gets two turns, then one post in three tries the least used and the rest follow the
results (clamped 0.5 to 2). The calls to action rotate so two posts in a row do not
end the same way.

### The mix moves with the results, slowly

Each account starts at 60% entertaining posts (formats.json `mix`), chooses the
group under its share first, and moves 5 points at most once a week, within 40% to
80%, when one group's median result beats the other's by 10% with at least 3
results each. Faster would chase noise at two posts a day.

### Instagram is scored by saves per reach

As the brief asks: saves over the accounts that saw it (reach), views only where
Meta reports no reach. TikTok stays shares and likes per view.

### Two captions, and their limits

TikTok's search reads a long caption, Instagram shows the start of a short one: a
post has a 200 to 600 character TikTok caption and a short Instagram one that the
code leads with the cover line. The tell checks had capped every caption at 320
characters and 4 sentences, which made a valid TikTok caption impossible (the demo
content found it): the long caption has its own limit (900, 8 sentences), and a
slide body of lines (places 10 to 6, an iceberg's layer) is counted line by line.

### Hebrew number words on the cover are numbers too

Phase 1 left Hebrew number words on the cover and in captions unchecked, because
"שלושת הטיפים" is the post's own count. The post's own counts are now known in code
(the number of slides, a top 5 or 10, 3 clues), so the cover and the captions are
held to the quotes like the slides: "היום לפני שמונה שנים" is arithmetic no quote
holds, and is refused.

### Takedowns: delete what the APIs can, the rest by hand

Meta added a delete for Instagram media in December 2025 (Facebook Login only, the
`instagram_manage_contents` permission); TikTok has none for a third party, not
through Zernio (whose delete only removes its own record of a published post) and
not through TikTok's APIs. A notice takes the post down where an API can, lists
the rest for the owner with a confirm button, and a second notice for the same
account within 90 days pauses it. The network door gains exactly one write: DELETE
of a numeric Graph object, never an edge.

### The image screen, and a person when it cannot tell

Words in a photo's description refuse it (blood, knockout, a watermark, a belt); a
share of deep red sends it to a person, since red gloves and a red corner look like
blood to a counter; with a live key Claude Haiku looks. What nothing clears waits:
the post can be approved but not published until someone confirms the photo on
its page. A pack set to `safety: strict` screens every photo it uses.

### Event photos are the owner's decision, and they stay traceable

An owner can allow event photos for an account. They come in by hand
(`<pack>/photos/photos.json`, with what is in each, where it came from and whom to
credit), still pass the screen, and a takedown notice deletes the post. Commons
first when it has a good one: a JPEG at least 1000 px a side whose file title
names the person the query names (video stills, the wrong person and a sponsor's
logo came through before that filter). The engine fetches no photo from a news or
agency site.

### A pack can draw its own covers

Licensed photos of athletes nearly all show a kit: a crest, a sponsor, a brand on
the boots. One of the launch builds put exactly that on a cover, for an account
whose look is "no crests or logos". A theme can turn the cover photo off
(`coverPhoto: false`) and draw its covers from type and numbers; turning photos on
is one line, and with a strict screen every photo waits for a person before it is
published.

### The fight week, and a recap only once the results exist

The calendar is a list of events on Wikipedia, read through its API; the next
week's event pages are read the same way. The tale of the tape takes the first
slot three days before a card, the prediction the day before, and the recap's slot
is held back from the day-ahead drafts and drafted the morning after, every 45
minutes until a document names both fighters with the results. Drafting it the day
before would mean writing results that do not exist yet.

### Wikipedia and Wikidata through their APIs

Wikipedia's robots.txt disallows `/w/` and `/api/`, and Wikidata's `/sparql`, for
all agents, while the Wikimedia Robot policy sets out how bots should use exactly
those APIs (a few requests at a time, back off on 429, an identifying User-Agent)
and recommends the REST page HTML for a page's content. The reading here:
robots.txt is aimed at crawlers of pages, the APIs are the sanctioned door. The
engine reads sections through the REST HTML (tables kept, one row a line), waits
on a 429 (recording the launch documents hit one), and names itself with a contact
the owner sets (`OF_USER_AGENT`): the old default pointed at a GitHub organisation
that is not this project. Strictest alternative: only `/wiki/` pages, which would
lose Wikidata.

### News sites are out, on their own terms

The international and Israeli news and sports sites checked for the accounts all
answer a plain client, and all forbid automated reading, business use or use with
AI in their terms, or block AI agents in robots.txt. None is a source. What the
accounts read: Wikipedia, Wikidata, data sets that are free to copy or in the
public domain, official data, companies' own releases, and outlets whose terms
allow it. The list, with each site's terms, is in the private folder.

### An opinion is labelled as one

A head-to-head's verdict and a hot take are the account's own opinion: labelled so,
with the numbers of both sides next to them. "The facts prove that" is still
refused, since numbers do not prove an opinion. A pack's voice can also refuse
invented experience ("פתחתי עסק", "ניסיתי"): an account can sound like someone who has
been there and still say only what its sources say.

### The old accounts are archived, and still private

The two retired accounts moved to `$OF_HOME/packs/_archive/`, with a copy of a
rewritten pack's previous version; the engine never loads them, and
`check:public` still reads their names. The public denylist takes `id:<word>` for a
pack id that is also an ordinary word (the engine's API catalog uses one such word
legitimately): refused in code where it is used as an id, and as a word in the
docs, which have no reason to say it but to describe the account. The decisions
that describe the accounts themselves are in the private folder.

### The launch set is drafted by Claude Code and reviewed blind

As in phase 2, the project's key is not spent on drafts: `npm run launch` writes
the exact requests the engine would send, a Claude Code subagent on Sonnet answers
them, the script checks every answer with the engine's code, and the real pipeline
builds the posts from them. A second subagent that never saw the drafting reviews
each rendered post as a skeptical viewer. The one addition to the engine's prompt
is a failed post's redo, which carries the reviewer's notes, the way the owner's
notes would.

### What the first blind review changed in the engine

The first review passed 2 of 27 posts. Most failures were the drafts (fixed by a
second round with the reviewer's notes), but several were the engine's, and those
were fixed for every account:

- **The keywords moved from the cover to the last slide.** A row of keywords
  under the hook read as clutter on the one slide that has to stop the scroll.
  They sit above the call to action now, where TikTok's search still reads them.
- **Hashtags only where the post names them.** A post about one match carried
  the account's whole niche list (the Champions League, the Premier League); a
  niche tag is now kept only when its words appear in the post.
- **A source is named by its article.** "ויקיפדיה" alone told a viewer nothing; the
  source line now gives the article's title.
- **The fit check reads the baseline.** A half-cut last line passed as a tall
  face's descender: the overflow measure saw both the same. A line now overflows
  when its baseline (the line's box less 0.28 em) falls below its block.
- **Type and colour.** Bigger type on TikTok's taller slides, softer stripes on
  the `corner` template, no card inside a meme's card, no ghost number on the last
  slide of a `scoreboard`.

Photos, layout and links in a reviewer's notes went to the design, not to the
redraft: the drafting model cannot move a photo.

### The launch set takes the engine's review too

A build from recordings cannot take the engine's second look: without a live client
the review is the offline heuristic, which can find tells but cannot tell a sentence
that says more than its facts, and the rewrite never runs. The first launch round
went out without it, and a slide said the cars were "sold" where the source says
"deployed". `npm run launch` now writes the engine's exact review request for every
drafted post, then the exact rewrite request for what it flags, keeps a rewrite only
if the post still passes every check, and blocks a post whose fact problem is not
fixed, the way the engine does. Each post's folder has the review (`engine-review.md`)
next to the blind one. A request is tied to the text it was written for, so an
answer to an older draft is set aside.

### The review knows a myth from a claim

The review sees each text and the facts, and flags a text that says more than its
facts. On a myth-fact post it flagged the myths themselves ("in that sport there are no
rules"), which the next slide corrects: a live run would have rewritten the myth
away or blocked the post. Each text now tells the review what it is doing: a myth, a
joke's setup, the account's opinion, a question to the reader. Such a text is
flagged only when a fact inside it is wrong.

### A guess-who does not number its clues

The design draws a badge on each clue. A draft that wrote "רמז 1" said it twice, and
the fact gate refused it with a message about the number 1 not being in the quotes,
which told the model nothing. The kind's prompt says so now, and the check names it.

### A score is one thing

The "list of four or more things in one sentence" tell splits a sentence on its
commas. A score written the way fans read it ("ישראל 9, טייוואן 0") has a comma
inside it, so a date, a place and one score made a "list" and a correct slide was
refused. One score pair now counts as one item; four scores in a row are still a
list.

### What the second blind review changed in the engine

- **A guess-who's clues name the source, not the article.** Round 1's fix gave every
  source line its article, and an article is usually the answer: every clue of a
  guess-who said "ויקיפדיה: <the player's name>". A clue now says "ויקיפדיה"; the
  reveal names the article.
- **An English article title is its own run of text.** Inside the Hebrew source line,
  "2002–03 UEFA Champions League" came out as "03–2002".
- **Headline digits that read as digits.** The display face of one theme draws a 7
  with a crossbar and a 1 with a flag; as a big counter that is the look, in a headline
  "177" read as letters. A headline in that face now takes its digits from the text
  face, scaled to the letters (a composite font; each digits face carries its display
  face's exact weight, or the browser never picks it). Big numbers keep the face.
- **The keywords are a footnote.** Both rounds read the keyword row as SEO. It is
  required (TikTok's search reads the text on a slide), so it stays, smaller and
  fainter, under the call to action.
- **The source line keeps clear of the big slide number** on the template that draws
  one.
- **A photo of a person names the person.** The check that a picture's title names
  the person a query names took one word of the name: a query for a fighter called
  Holm brought a rock on Steep Holm, one for Serra a plant called Senecio serra, and,
  once both words were required, "Holly with berries, Holm Hill". The title must now
  hold two of the query's name words side by side, as a name is written. A post with
  no photo is better than a post with the wrong one, and the screen would have held
  all three for a person anyway.
- **A sentence's end stops a Latin run.** The renderer isolates each Latin run in a
  Hebrew line so bidi cannot move punctuation around it, but a run could continue
  across a period and a space: "ל-Gnrgy. 450,000 דולר" isolated "Gnrgy. 450" as one
  left-to-right unit and printed "000,Gnrgy. 450". A run now joins words with a space
  ("UFC 193") and a name's parts with a point or a dash ("monday.com"), never across
  a sentence's end, and a number range in a Hebrew line ("2002–03") is isolated too.
- **One question at the end of a caption.** A caption that already ends on a question
  takes no second one from the question field.
- **A number drawn big is not printed twice.** A list item whose title holds a number
  had it drawn large above the title and again in it; it is drawn large only when the
  title opens with it, and the title then goes on without it.
- **The `corner` template's diagonal cut is the cover's.** On content slides it ran
  through the text, and every reviewer read it as a bug. Content slides there also
  start at a fixed height, so the label and progress bar stop jumping, and a ranking
  drops the page counter for its own place number.
- **The fit check measures the baseline.** It estimated a line's baseline from its box
  less 0.28 em; in a face whose descent is 0.16 em, a cover's last line ("2002") was
  cut through the middle and passed. A zero-size marker after the last letter now sits
  on the real baseline.
- **Small slide counters use the headline digits too.** At 64 px the display face's 7
  read as a Hebrew letter ("01 / 07").
- **A niche hashtag is a word of the post.** The match ran on the text with its spaces
  removed, so "#מסי" matched "המסירות". A tag now matches whole words, joined as a
  hashtag joins them, with a one-letter prefix allowed.

### The review reads the source's words, not only the summary

A fact is a quote and a claim, the drafting model's Hebrew summary of it; the slides
follow the claim, and the review saw only the claims. In the launch set an outline
summarised three quotes about a welterweight title as "משקל בינוני" (middleweight):
the fact gate passed it (no number was wrong), the review could not see it, and a
blind reviewer caught it. The review and the rewrite now see each claim with its
quote, and the outline prompt says a translated term takes its own Hebrew name. The
launch set was reviewed before this change; `npm run launch` would now ask for its
reviews again.

## Session of 2026-10-14 (later): development on Claude Code, visuals, research

### Development runs on Claude Code, production on the API

Every model call goes through one entry point (`askJson`) to one of two backends.
`claude-cli` runs the Claude Code CLI headless (`claude -p`): the request
production would send, with its system blocks joined in order, its user turn and
image as one stream-json line, its schema through `--json-schema`, its model and
effort, all tools off, a fresh session that is never saved, and `--safe-mode` so
nothing of the machine's own setup (CLAUDE.md, hooks, skills, MCP) reaches it. `api`
is the official SDK with batches and caching. `OF_ENV` picks: `dev`, the default, is
the CLI; `prod`, set by the service unit, is the API.

Decided:
- **The key never reaches the CLI.** The child process gets the environment without
  any `ANTHROPIC_*` variable: with `ANTHROPIC_API_KEY` set, the CLI would bill the API
  instead of the subscription.
- **In dev the API is refused** unless the command says `--allow-api`, in the client
  itself, so no path reaches it by accident. Every refusal is logged to
  `$OF_HOME/logs/api-refusals.log`.
- **One call at a time,** within a process (a promise chain) and across processes (a
  lock file, taken over when a crashed process left it).
- **A usage limit waits** for the reset the CLI names, or half an hour, and makes the
  same call again; it never falls back to the API. An answer that is not JSON is asked
  for once more with the error, then fails.
- **Tokens are recorded, money is not.** A CLI call is a spend row of $0 with its usage
  and what the same call would cost through the API as production sends it (batched,
  the pack prefix read from the cache), so the forecast stays measurable. When the
  CLI's own schema check sent an answer back, its usage adds both rounds; production
  answers in one constrained request, so the price is the last round's. The CLI adds
  about 1,000 tokens of its own framing to every call; the forecast says so.
- **The same validation.** The answer goes through the same checks downstream, and
  nothing else touches it: a pass in dev is a pass in prod.

### Every post has visuals

A blind review's most common complaint was a deck of text cards. Now at least half of
a post's slides carry a visual, and the cover always does.

- **The engine draws its own graphics** from data the drafting model writes on a slide
  (`visual`): a timeline, stat bars drawn to scale, a head-to-head card, one big number
  (a ring for a percentage), a calendar page, a pitch with the players in their
  positions, kit-colour blocks (colours only), a fight record, the weight-class ladder,
  a product's stack, a funnel, price cards and mock screens (chat, terminal, browser).
  Each theme names the types that fit its account (`theme.json` `visuals`). Nothing is
  a logo, a crest, a screenshot or another page's picture.
- **A graphic's numbers are claims.** The fact gate reads every number a graphic draws
  against the quotes its slide cites, like the slide's own text; the token covers the
  graphic, so it cannot change after the gate; the review reads its names and numbers,
  and a graphic it doubts is dropped, not rewritten.
- **The cover always shows a picture**: a photograph that passed every check, else the
  graphic the model chose for it (`coverVisual`), else the art of its kind (an iceberg,
  a podium, a versus split, a silhouette, a calendar page...).
- **The rule is counted in code** (with the cover, half the slides; a head-to-head's
  stat slide counts) and refused like any other check, so the redraft fixes it.
- **Every graphic is tested** to fit a TikTok and an Instagram slide in four templates,
  right to left, with Hebrew and Latin mixed, numbers, units and ranges. A text node
  with no Hebrew in it is isolated too ("2003–04" came out "04–2003"), and a run with no
  space never breaks across lines ("3–0" broke as "3–" and "0").
- **An account's mark** (`brand/logo.png` or `.svg` in the pack) is drawn small on the
  first and the last slide when it is there.

### A photograph must show what its slide says

A content slide may ask for a photograph of the person or place it is about
(`imageQuery`). The picture must name its subject in its own title, description or
categories (Commons categories added; a name split across the title, as "Holly with
berries, Holm Hill", is still refused), pass the image screen, and pass a vision check
in the same Haiku call: the model says what the picture mainly shows and whether that
fits the slide. It is told not to recognise anyone by their face: the file's own
metadata names the person, the model checks the picture fits (one person in the right
setting, not a rock, a plant, a crowd or a poster). A picture that fails is not used
and the slide keeps its graphic: a wrong picture is worse than none. A guess-who's clue
never gets one (it would give the answer away). Every picture's license and author is
written per post, and the caption credits every one whose license asks for it.

### Research before drafting, and three details or no post

A post drafted from the one document it came from told what everyone knows. Now the
outline names the articles that would tell its subject in more detail (`research`);
the engine reads them through the pack's own approved sources (a Wikipedia of an
approved Wikipedia source, Hacker News where the pack has it), stores them, and one
call pulls out the details a fan would want: what someone said, the minute or the
round, the moment, what came before, what came after, a telling number. Each is
verified against its stored text like any fact, and says which slide it belongs on.

- **A topic needs three verified details** (`research.minDetails`, 3 by default) or it is
  left for the next one; general wording never fills the gap.
- **The slides must use them**: at least three, each on its slide, cited by id.
- **The outline may plan a moment its document only names**, leaving the facts of the
  slides that need the details to research; a slide still without a fact after it is
  dropped.
- **The review checks every detail**: a name, a number, a minute, a quote or a moment
  that no fact's source holds is a fact problem.

### A format names its sources; a topic bank; a source read once in six hours

- **A format can name the sources it draws from** (`formats.json` `sources`), in order.
  A match story drafted from a results table cost six refused outlines before it found
  an article.
- **A topic bank** (`api.kind: "bank"`, the pack's `topics.json`) holds chosen topics,
  each with the kind of post it suits and the pages that document it. A topic's pages
  are one group, drafted together and only by a format of its kind. Hacker News pages
  are read through its API, never fetched as pages.
- **A JSON source can be one document per record** (`api.each`, one Hacker News post
  each, with its own address), and HTML inside a JSON field is read as the words it
  shows, so a quote with an apostrophe in it matches.
- **A source read in the last six hours, for the same day, is not read again.** Every
  post read every source, some forty requests a post, and Wikipedia throttles a reader
  that asks that often.

### A redraft is told which sentences were counted

"4 sentences, 3 at most" was redrafted into the same four sentences: the model
miscounts its own text. The message now quotes the sentences as the code split them,
so the redraft joins or cuts the right ones.

### What round 1 of the launch set changed before it was done

The first posts of the round were stopped seven times in ten, most by the engine's
own review. Each cause was fixed in the engine, and the round went on from where it
was (the posts already made stayed):

- **The redraft sees the draft it fixes.** It was told "fix these, keep everything
  else" without the draft, so it wrote a new one from scratch, with new mistakes.
- **A slide's uncited number is cited by code** when exactly one verified fact holds
  it ("2022" on a slide that forgot the fact with the year). Two facts holding it, or
  none, is left for the gate.
- **A slide research left without a fact takes a spare detail** rather than being
  dropped, which broke a post's shape (three slides where the kind needs four).
- **A list is four short things in a row.** Clauses around one long one ("that year,
  on 14 November, the company released X, which summarises sites") were refused, and
  no redraft could fix what was not there. The message quotes the sentence, and the
  sentence count quotes the sentences as counted.
- **A product name's digits are not a number** ("Base44", "GPT-4o", "H100"); a token
  that starts with its digits ("20M") still is.
- **The review says yes or no to a fact problem** (`factIssue`): one reviewer filled
  the field with "...so this is fine", and it blocked a post.
- **A rewrite is kept when it adds no problem of its own**, and one the checks refuse
  gets one more bounded call with the reasons. A flagged text now goes to the rewrite
  with its limits and the facts its slide cites; a third of the rewrites were refused
  for a limit or a number they could not know about.
- **A photograph is checked against its file's own title, description and
  categories**: a photo of the right player at another match (2018, on a slide about
  2022) passed a check that looked only at the picture.
- **A topic whose plan cannot keep the kind's shape is left for the next topic**, in the
  same post, as a topic short of details already was; the post was blocked before.
  A plan lost to facts its quotes do not hold still blocks as a fact-check failure
  when no topic is left (the rails pause an account on those). A run of one role longer
  than the kind takes ("turn" three times where it takes two) keeps the slides with
  the most facts.
- **A graphic the review doubts goes to the rewrite as its data** and comes back
  corrected, or is dropped when it cannot be: dropping it outright left posts short of
  their visuals, and the final gate refused them.
- **A slide that does not fit is drawn again** without its framed photograph, then with
  its type allowed down to 45%; a photograph left off on every platform is not credited.
- **Three details are asked for, two pass after the redraft.** Two of a post's moments
  on the slides still tell it; blocking a finished post for the third did not.

### What the first blind review of round 1 changed

Three readers a post, each blind to how it was made. Their reasons, the ones the
engine can act on, and what changed:

- **A table row is quoted with its header.** "| Claude Opus | $2 | $10 |" did not say
  which number was input and which output, and a post titled its stats "the first
  price in the table". Rows of a Markdown or an HTML table are now written "Model: X |
  Batch input: $2 / MTok | ...", so a row quoted alone says what it holds.
- **The model knows today's date**, and a story more than a year old says its year
  and is told as what it shows now. A 2023 launch and a 2024 ruling were told as news,
  and every reader caught it.
- **A story ends on how it ended.** "What happened to X" ended without saying; a
  story, a what-happened or an on-this-day is usable only when its documents, or the
  articles research reads, say how it ended.
- **No slide repeats another**, graphics included: a cover's price table drawn again
  on slide 2 read as filler.
- **A line wider than its box is cut, and the fit pass now sees it.** It measured only
  how far a box ran down; "$120 מיליון" lost its last letters sideways on a cover. A
  grid card shrinks and wraps rather than overflowing its column.
- **A topic bank's page is credited by its site** ("Hacker News", "Anthropic",
  "ויקיפדיה"), never as "the account's topic bank".
- **A code name stays one run**: an underscore and a call's brackets are part of it
  ("budget_tokens" came out "tokens_budget" in a Hebrew line).
- **A photograph's date matters only for an action shot.** The rule added during round
  1 (a picture from another event does not fit) refused every portrait of a fighter
  taken at a later ceremony, and the fight account's posts went out with almost no photographs,
  the reviewers' first complaint. Now a portrait or a press photo of the right person
  fits whatever its date; an action shot fits only at the very event the slide is
  about; a statue, a plaque or a painting of the person never does. A logo blocks a
  picture only as its main element, not on a backdrop or a microphone behind the
  person. Commons pictures from 800 pixels a side are taken (1000 cut most portraits).
- **A guess-who's cover shows its answer's photograph blurred** past recognition, when
  the reveal has one; otherwise a large question mark. The grey silhouette read as a
  missing image. The cover gives no clue of its own.
- **A head-to-head never shows a dash**, and its verdict takes a side; a ranking's cover
  never names its number one.
- **A cover without its own photograph tries the post's subject by name**, then takes
  a portrait one of its slides found: readers asked for a face on the cover over the
  kind's drawn art (an arrow, a flame read as clip art). Photographs are framed
  toward the top, where faces are.
- **A cover may hold three short sentences** ("X או Y? מי היה טוב יותר? התשובה בסוף"):
  eleven words still bound it, and a pack's own cover pattern asked for three.
- **Sideways overflow is measured on the text**, not on the box's scroll width, which
  counted what was never drawn and refused finished posts.
- **The cut comes in half posts, and the default cost is the measured one.** Real token
  counts from the CLI put a post made at about $0.15 (stopped attempts included), not the
  $0.035 the planner assumed: 180 posts would be about $27. A cut to whole posts a day
  wasted money (one a day each left $1.35 unused at $0.15) or could not fit at all (at
  $0.20, one a day each is over the cap). A rate can now be a half (1.5 is two posts one
  day and one the next, 0.5 a post every other day), spread evenly over the calendar,
  and nothing goes under a post every other day. `DEFAULT_COST_PER_POST` is $0.15 until
  an account has four posts of its own.
- **A photograph's title decides whom it shows.** A file titled for one person and filed
  under another's category went on the other's cover (a Maeda photograph on a Hélio
  Gracie post). The person's name must be in the title; a title that names nobody (a
  camera's numbering) may be named by its description or categories. The sharpest
  candidate is tried first.
- **A cover takes only its own subject's photograph.** A slide's portrait moves to an
  empty cover only when it is of the post's subject (a Dana White photograph once led a
  post about another fighter), and never in a ranking, where it would show number one,
  or a guess-who, where it would show the answer.
- **A head-to-head's value shrinks rather than break.** "נוקאאוט" broke over two lines on
  the narrow size; a value now never wraps inside a word, and the fit pass shrinks it.
  Its two values are the same measure (never an age against a result), and a coming
  fight names its event and date.
- **A guess-who's answer is someone the audience knows**, and the blurred photograph is
  lighter, with a question mark over it: the heavy blur read as a grey blob.
- **Nothing inside a graphic may be cut.** The fit pass measured only where a box's last
  line of text ended, so a price card's second row ran out of its graphic unseen and a
  word broke inside a narrow card ("CodeF / ast"). Now every box in a graphic must sit
  inside it and every line inside the box that holds it; words never break, they are set
  smaller. A part clipped on purpose (a bar's segments in their track) is not counted.
  The stress test now takes the same 45% fallback the renderer gives a slide at its
  fullest.
- **A run of Latin text with no space never wraps, as intended.** The test read `/s/`
  (the letter s) where `/\s/` (a space) was meant, so runs with an "s" in them could
  break. And a command's flags stay with it: "npx frugon --demo" came out "demo--".
- **A guess-who needs its answer's photograph.** A bare question mark failed every
  reader's first second, and an answer no licensed photograph shows was one most of the
  audience did not know either. Without the photograph the post stops and the engine
  tries another topic.
- **A fast-moving account's story must be recent.** An encyclopedia page has no date, so
  the date filter let a 2024 launch through as news. The outline is told the account's
  window (`research.maxAgeDays`) against today.
- **A forecast or a demo's numbers are claims, not results**, and say whose they are.
- **A head-to-head may stand on three stats** (a coming fight's sources rarely hold more
  that both sides share), its cover never shows the values, and its verdict answers the
  cover's question first.
- **A famous story needs an angle**: told through a detail most fans have not heard, led
  by it. The cover leads with a concrete detail, never with the payoff, and a count it
  promises ("3 רמזים") is checked against the slides.
- **A photograph must show its person as the story knew them**: the face visible, the
  club of the story (a Real Madrid shirt on a 2008 Manchester United slide misled), a
  place filling the frame, in focus. A full name is searched, never a surname alone.
- **A launch round knows what the rounds before it passed.** Each round runs on its own
  database, so the outline's "posted recently" list was empty and round 3 told again a
  story a round 2 post had already passed with. The harness now writes the earlier
  rounds' passed posts into each new round's database (ids `seed-...`, left out of the
  counts), as an account's own history would hold them.
- **A graphic's parts never shrink to fit it.** A comparison table, squeezed by its
  graphic's flex box, clipped its own last rows, and the check took the clipping for a
  deliberate one. The parts of a graphic keep their size, so anything too tall runs out
  of the graphic, where the fit pass sees it and sets it smaller.
- **The owner's review of the launch set (2026-10-15) became account settings, not engine
  defaults.** No handle on the slides (the platform already shows whose post it is), no
  source line on them (the post's record and its caption keep every source and every
  photograph's credit), a photograph behind every slide, a closing "follow" slide instead
  of a call to action on the last one, and shorter slides. Each is a switch in
  `theme.json` or `pack.json`, so another account can choose otherwise. The background
  is blurred and veiled in the theme's own ground colour, so the text keeps the contrast
  its template was designed for; a guess-who's answer is never used as one, since a face
  can show through a blur. A post with no photograph of its own searches its account's
  scenes (`backgroundQueries`).
- **The closing slide is the account's approved text, drawn after the fact gate.** It
  makes no claim, so it is not part of the post's token; a pack validator bounds its
  length.
- **A pack can only tighten the text limits.** `writing` lowers a limit (the owner asked
  for less text per slide); a value above the engine's is ignored, since the engine's
  limits come from what fits a slide.
- **Backgrounds come from the post's own subject and its scene, checked like any photo.**
  Cycling every photograph of a post put Messi's face behind a post about Ronaldinho, and
  an unchecked scene search put a basketball arena behind a post about a match. Now the pool
  is the cover's photograph and one scene photograph, and the scene is checked by the
  vision model against what it must show.
- **Accented letters, apostrophes and slash commands are part of a Latin run.** "L'Équipe"
  came out reversed, and "/clear" as "clear/"; Mbappé, Agüero and Modrić were at risk.
- **"The only one" keeps every condition.** A slide shortened "the only player to win all
  six" to three of them, which is false; the drafting and the review now both say so.
- **A ranking states every place's number and follows it.** Messi's and Ronaldo's totals
  were missing from a top scorers list, and a win streak of 14 stood at number 1 above
  one of 16. Both are checked in code.
- **A head-to-head's cover shows no single face** (a third player's photograph went out
  labelled as one of the two), and every photograph's check is told the post's topic
  (Guardiola in a Bayern tracksuit stood on a Manchester City post).
- **A post with a fixed subject keeps its own pages and its event's numbers.** A fight
  week's card has only its fighters' pages: a stopped attempt no longer uses them up, and
  the card's name and date, from the approved event calendar, may be on the cover.
- **A launch round also remembers the topics that failed**, so the next attempt finds a
  new one instead of telling a rejected story again.
- **A name can be shared.** For an athlete, a photograph with nothing of the sport in it
  is most likely someone else with the same name (an "Alex Pereira" at the seaside).
- **A head-to-head's cover shows both sides, each on its own half.** With no face at all
  the fight-week previews failed every reader's first second; with one face, a third
  player went out under two names. The outline now names a photograph for side b too
  (`imageQueryB`), and the cover is split only when both are found and checked.
- **A head-to-head's stats bear on the question.** Debut dates and the number of rounds
  scheduled filled a preview's slides and decided nothing.
- **An English sentence quoted in a Hebrew line is one run.** Its commas and periods split
  it into pieces that the line then reversed.
- **Instagram Login's account id is `user_id`.** The node's `id` is app-scoped; the
  professional account's id (the one Meta's dashboard shows, 17841...) is its `user_id`.
  `instagram:check` compared the wrong one and reported a correct pack as wrong.
- **The cap is $20 a month, and the Anthropic API has a spend file of its own.** The owner
  raised the cap from $15 to $20 on 2026-10-15, with a warning at $15, and asked for a
  safety net that a lost database cannot reset. Every API call now also answers to
  `$OF_HOME/data/anthropic-spend.json` (by UTC month, written whole and renamed into
  place, one log line a call): a model missing from the pricing table is refused rather
  than priced at a guess, and a missing or unreadable file blocks every API call until
  `npm run budget -- init` creates it. The ledger in the database still reserves each
  call's worst case and splits the cap between the accounts.
- **The owner's second review (2026-10-15), applied to the engine as a whole:**
  - *TikTok's own buttons, caption and tabs never cover a slide's text.* The TikTok safe
    area is now 250px from the top, 560px from the bottom, 190px from the right (where a
    Hebrew line starts) and 100px from the left; the account's mark moved to the top.
  - *A shadow under every line on a photograph or a background*, in the theme's own
    ground colour on a background and in black on a photograph, so a picture never eats
    the text.
  - *A guess-who's cover is a mosaic, nine blocks across*: blurred, half the readers
    still knew Zlatan from the photograph alone.
  - *The head-to-head's stat is a duel panel*: the two names small, the two values large
    in their colours, a "מול" chip between them, and a proportional bar under two plain
    amounts of the same thing.
  - *A cover makes them need the second slide*: a question or a promise the slides
    answer ("איך ברצלונה עשו את הבלתי אפשרי בקאמפ נואו?"), never a headline that is
    already over.
  - *Spoken Hebrew*: the spoken imperative (תעקבו, תשמרו, תשלחו, תכתבו), never the
    formal one, checked in code before the words a request goes on with, so a past tense
    is not taken for one; "פאונד", never "ליברה".
  - *A head-to-head's two values may run to three words each* (the check was refusing
    previews that had them).
- **The public slide folder is readable by the web server on purpose.** The service runs
  with umask 0077, so the slides it copied for Instagram and Zernio to fetch were
  readable by it alone: Caddy would have answered 403 and every publish failed. The
  deploy test wrote its sample file as root and never saw it. Now that one folder and
  its slides are 755 and 644; the rest of the private folder stays the service's own.
- **The engine keeps the Anthropic cap itself (2026-10-16).** The owner chose not to
  create a workspace: the key lives in the Default Workspace, which the console cannot
  put a spend limit on, so the engine's own ledger is the only cap. A personal key that
  is not scoped to one workspace still names one on every request
  (`ANTHROPIC_WORKSPACE_ID`); the Default Workspace's ID is enough.
- **What the fourth launch set's blind review found, fixed in the engine (2026-10-16):**
  - *A photograph of an athlete away from their sport does not illustrate their sport.*
    A 2021 conference-stage photograph of a goalkeeper stood for a 1999 final, and a
    corridor press scrum for a title fight: the image check now refuses a picture of an
    athlete on a stage, in a studio, in a press scrum, at a fan event or at a ceremony
    for a slide about what they did in their sport. A picture in kit, at training, on
    the touchline or with a trophy still fits.
  - *A head-to-head with only one side's photograph shows that face.* When one side's
    free photographs are all refused (a retired striker's are from his television
    years), the cover used to fall back to the drawn two-colour art, and every reader
    passed over it. The side that passed its own check now fills the cover.
  - *Only a post about one subject repeats its cover's face behind the other slides.*
    A ranking's number one stood behind the slide about number two. A ranking, a
    head-to-head and a guess-who take the scene instead.
  - *The scene behind the slides has no one in it.* A fight's crowd and two strangers
    sparring read as people the post was about: the background is checked for a place
    or a thing, and the scenes are an empty cage, a pitch, a stadium, a desk.
  - *The payoff is on a slide.* A story tells the moment it turns on with who, when and
    how; a "what happened" names the defeat, the injury or the transfer; a famous story
    leads with what fans do not know. A comeback without its two goals and a fall
    without its knockout both failed every reader.
  - *A ranking says honestly what it counts*, and every place's big number is that
    measure; *an iceberg's cover teases its strangest fact*, never "X, this everyone
    knows"; *a guess-who's captions hold no detail that points to the answer.*
  - *A translated claim keeps what each word belongs to.* "The first manager of an
    English team" came out as "the first English manager" of a Scotsman, and the check
    in code (numbers and names) could not see it: the rule is now in both prompts that
    write claims.
  - *A guess-who's answer is under the face, not on it*, and its label is readable on
    the photograph.

- **What the fourth set's second round showed (2026-10-16).** Three more faults, fixed
  in the engine before the second blind review:
  - *A guess-who's answer and a head-to-head's two sides are checked as portraits.* The
    rule that refuses an athlete away from the sport was checking the answer's
    photograph against the reveal's fight, and refused every free portrait of two
    champions (a press conference, a suit): both posts were blocked with no face for
    the cover. It also refused a featherweight champion's UFC media-day photograph for
    his half of a head-to-head cover, and three fight previews went out faceless. A
    portrait is about the face, and a media day, a press conference, a weigh-in or a
    suit fits it; a slide about a fight still needs the sport.
  - *One word in two scripts is a tell.* "חבib" and "greco-רומית" are a translation
    left half done; the check refuses a word that runs Hebrew and Latin letters
    together, or glues a Hebrew word after a Latin one ("ב-Vercel" stays as written).
  - *Every place in a ranking states its number, and a year is not one.* Number one of
    the World Cup's scorers went out with "2022 and 2026" and no goal count, under four
    places that showed theirs as a graphic; a place now needs a number that is not a
    year, and drawn the same way as the others.

- **What the fourth set's second blind review found, fixed in the engine
  (2026-10-16).** 3 of 20 posts passed (2 of 6, 1 of 7 and 0 of 7 on the three accounts).
  The faults that repeated:
  - *The best material went to the caption.* The prompt asked the caption for
    "something the slides do not say", and the model put the post's twist there:
    Cavani's later words, David Luiz signing the same day, Fontaine's 13 goals.
    Every reader called it a broken promise. The best fact is now on a slide, and the
    caption promises nothing the slides do not show.
  - *A slide's photograph pushed its text over the page counter.* The card had a fixed
    height and the column was centred, so a long slide spilled upward. The card now
    gives way first, and a column never spills above its top.
  - *A terminal shows a real command.* "$ CNAME" and "$ preview URL" read as broken
    commands, and Hebrew notes came out scrambled in a left-to-right screen: the check
    refuses Hebrew in a terminal and a line that is not a command.
  - *A cover's face is someone the cover names.* A scorers' ranking showed its number
    three as a coach, an iceberg an old man nobody could name: the outline is told the
    cover line names whoever the cover shows.
  - *A past date is not a cover's headline* except on a post about that day: "7 May
    2026" above a myth post read as old news in October.
  - *One photograph is shown once.* The cover's picture of Torres came back for the
    first slide.
  - *A "what happened" answers with numbers*: the change, before and after, not a list
    of trophies.
  - *A fight's media day, press conference and weigh-in belong to the sport*, and a
    portrait asked for its face takes any clear picture: three fight previews had gone
    out with no fighter on the cover.

- **No mark on the cover; person against person, both faces or another matchup
  (2026-10-16, the owner's call).** The account's logo is drawn on the last slide
  only: on the cover, TikTok's and Instagram's own page already shows whose post it
  is, and a logo there reads as an advert. A head-to-head whose outline names two
  people is drawn as two players are on the sports account, side by side: the
  engine looks for both photographs right after the outline, before a word of the
  post is written, and a matchup whose two sides cannot both be shown gives way to
  the next topic. The fallbacks it replaces (one face filling the cover, or the
  drawn two-colour art) were passed over by every reader. An account that draws
  head-to-heads of people needs `coverPhoto` on in its theme.

- **A topic from the bank is not held to the freshness rule, and an edited bank is
  read again (2026-10-16).** An account whose news ages fast refuses a story older
  than its `research.maxAgeDays`. A topic its owner chose for the bank is told as a
  lesson with its year (an AI agent that deleted a company's database in July
  2025), so the rule no longer applies to it: the outline refused every one of
  them. A source read in the last six hours is not read again, but a bank its owner
  has just edited is: the rewritten bank went unread while the posts it was
  written for were being made.

- **The batch path answers to the $20 cap (2026-10-16, a fault found on the server).**
  The runner drafts each day's posts through the Message Batches API, and the
  batcher's client never said it was the paid API: `askJson` neither checked its
  calls against the monthly cap nor recorded them in the spend file. The first
  post drafted on the server cost $0.15 that the database's ledger held and the
  spend file did not. The batcher now is the paid API (at the batch rate), a batch
  a restart left behind is recorded in the spend file too, and the runner raises
  the month in the spend file to the ledger's total on every tick, never lowering
  it (`npm run budget -- reconcile` does it by hand).

- **A long article's numbers, a blocked word as a word, and a portrait that shows
  the person (2026-10-16).** A person-against-person post compares records, and a
  long Wikipedia biography keeps them past the 16,000 characters a document is
  cut at: two careers stopped in 2010, and the outline found no number both sides
  had. A topic's link can now name its sections (`Name#intro;Championships_and_accomplishments`):
  it is read from the page's HTML, the lead with its infobox (wins, losses,
  finishes) and the section with its table, which the plain extract drops. Research
  reads each Wikipedia page with its infobox too, kept whole at the top of what the
  details call sees: a tale of the tape with both photographs found no record for
  either fighter. A pack's refused words in an image query are matched as words: "ko" refused a
  fighter whose name ends in "-ko". And a portrait (one side of a head-to-head, the
  answer of a guess-who) must show the person as the picture's main subject, not
  one face among seven soldiers; a picture with a weapon in it, a training replica
  too, is never used.

- **A broken graphic is dropped, not the post; a cover half is cropped around the
  face (2026-10-16).** A preview with both photographs and every fact verified was
  blocked because its rewrite left a comparison graphic with one row: a graphic is
  decoration, so one still malformed after the redraft is now dropped and the post
  checked again without it (the count of slides with a visual is still checked).
  And each half of a head-to-head cover was cropped around the middle of its photo,
  which cut a judoka's face out of a wide picture where she stood to one side: the
  screen now reports where the main face is, and the cover's halves, like a cover
  photograph, are aimed at it.

- **The desk redesigned: a level meter in dots, cobalt for approving, red only for
  what cannot be undone (2026-10-16, the owner's call on the mark).** The mark is a
  level meter in dots (one peak: the moment a post goes out), chosen by the owner
  from eight directions; the lighter five-column version stands in where it is
  small (the tab, the bar). The same dots tell each account's day on Today: a ring
  waits for you, a ring with a centre is scheduled, a disc went out, a square was
  stopped, so colour is never the only difference. The approve button was the
  orange of the brand, a shade from the red of reject and of the kill switch: it is
  now cobalt, and red means only what cannot be undone. Surfaces are neutral, so
  each account's slides carry the colour. A post card leads with its decision
  (headline, slides, what the checks found in one line, the buttons), with the
  captions and facts folded below; a post's own page keeps its buttons in a bar in
  thumb reach. The site follows the system's light or dark setting and has no
  switch of its own; signing out moved to Settings; the five sections are the same
  on a phone and a desk, with no More tab. Measured: every text colour 4.75:1 or
  more on its surface, light and dark; nothing scrolls sideways at 320 pixels.

- **An account can ask for short, catchy text; a topic can name its format; a
  source taken out of a pack is no longer read (2026-10-17).** An owner read a post
  whose line under the cover explained the whole topic in two long sentences, and
  asked for descriptions that are "short and catchy, not long and informative".
  The line under the cover is now its own kind of text with its own limits, and an
  account can lower the minimum of TikTok's caption (200 characters, for its
  search) and the maximum of both captions in `writing`, as it could already
  shorten a slide; the prompt then asks for a tease, not a summary. The engine's
  own defaults are unchanged. A topic in the bank can name one format of its kind
  (`format`), so a story about a new tool is not drafted as a disaster story. And
  a source the pack's file no longer lists was still read every day from the
  database, because syncing only added and updated: it is now marked removed
  (a source the owner added on the website stays).

- **A TikTok post's sound comes from the trending library chart, not TikTok's
  pick (2026-10-17, the owner's call).** With `auto_add_music`, TikTok put sounds
  on one account's photo posts that nobody listens to. Through the API a business
  account can attach only a Commercial Music Library track; Zernio lists the 100
  trending ones for a country, ranked. That is royalty-free library music, not
  the viral songs: those can be added only by hand in the TikTok app, and the
  owner chose automatic over sending every post there as a draft. Each post takes
  the best-ranked track on the chart with a clip of 15 seconds or more that the
  account has not used on its last five posts, from the top ten. The chart is
  read through one new door rule (a GET of Zernio's `tiktok/commercial-music`)
  and kept for six hours. When it cannot be read, TikTok picks as before; a draft
  (an AI image) keeps TikTok's pick too, since TikTok ignores a track on a draft.
  In `pack.json`, `zernio.soundCountry` names the chart (`IL` by default) and
  `zernio.sound: "auto"` goes back to TikTok's pick. `zernio:check` shows each
  pack's next sound and sends its private test post with it.

- **The text on a slide follows the slideshow playbook, in code (2026-10-18, the
  owner's call).** Lines of 4 to 6 words, broken by hand; 3 to 4 lines on a slide,
  title and body together; a title that reacts ("81 יום, ואף אחד לא השקה") rather
  than labels ("טיפ 3", "עובדה:", "התפנית"); no text in the top 10% or the bottom
  20% of the slide; a thick outline on any text that sits on a picture. Each pack
  may change any of them (`pack.json` `overlay`); these are the defaults
  (`src/rules/overlay.js`). The writer is asked for the breaks, and a line it left
  too long is broken in code at the best place (after a comma, never between a
  number and what it counts), the way punctuation tells are fixed in code: a
  missing newline is not worth a redraft. What code cannot fix (too many words, a
  line too short, a label) goes to the one redraft like any other check. Two
  judgement calls: the last line of a text may be shorter than 4 words (the punch:
  "ואיך הוא חזר"), and a body that is a list by its kind's design (places 10 to 6,
  an iceberg's layer) is neither broken nor counted. The safe zone widens the
  frame's padding where the platform's own does not reach it (Instagram: 135 px at
  the top, 270 at the bottom; TikTok's already clears it) and every line of text is
  measured after the fit pass: one inside the zone refuses the slide. The breaks
  are kept on the slide, and a line still too wide for very large display type
  wraps, balanced, rather than being set smaller: setting every cover line at 4 to
  6 words on one line would have shrunk the covers of every template. The outline
  goes on text that touches the picture only (text on a card keeps its own look),
  in the dark of the scrim on a photograph and in the theme's ground on a blurred
  backdrop.

- **Every morning, the last three days' posts are put in a two-by-two, and the
  answer becomes the next posts' plan (2026-10-18, the owner's call).** At
  `feedbackAt` (06:30, never after `generateAt`) the runner reads the numbers of
  the last three days' posts again and puts each one in a box: views against the
  median of the account's earlier posts on the same platform, each read at the
  same age (a post 30 hours old against the others near 30 hours, not at 72), and
  what it led people to do per view against the same median. Taps on the bio link
  (Instagram's `profile_activity` by `action_type`) are the measure when every post
  compared has them; otherwise likes, comments, shares and saves. DM keyword
  replies are not counted and cannot be: hard rule 1 never reads messages.
  TikTok's numbers through Zernio have no clicks, so on TikTok it is engagement
  until leads are attributed (planned). Fewer than three earlier posts at that age,
  and a post is reported but not boxed. Each box has a fixed answer, stored as
  directives and handed to the day's first free slots, winners first: high and
  high, three variations (the same document and format, three other cover
  patterns, drafted again although the document was used); high views and low
  action, the same cover pattern with another call to action and a caption the
  writer is told to write anew; low views and high action, the same call to action
  with another cover pattern and another kind of first slide; low and low, another
  format. The writer is told why in one line of the slides prompt. A new morning
  replaces the plans no slot took, and a post that got its answer is not answered
  again. Results shows each account's report and what became of each plan.

- **Rivals are typed in by hand, never read by the engine (2026-10-19, the owner's
  call).** Researching an account's competitors means reading their posts, and
  hard rule 1 keeps one network door that refuses Instagram's business_discovery
  and every social web page. Rather than open that door, each account has a form
  for three to five rivals: handle, platform, their best cover lines (up to five,
  as written), their formats, their posting hours and the gaps they leave, with the
  date it was last saved. It is planning input only: the outline is told the gaps
  ("pick the topic and angle in one of them where the documents allow"), the slides
  are told the covers the niche has seen (stand apart, never their words or their
  opening). A set subject (a fight week's card) wins over the gaps. The rivals'
  hours are shown beside the slots and do not move them: the slots also carry
  Shabbat, the festivals and the posting windows, which are not a rival's call. A
  rival not looked at in 30 days is marked; after 60 it is no longer said to the
  writer, because last season's covers steer wrong. The rivals live in the database,
  not the pack: they are the owner's notes, they change weekly, and a pack is
  configuration.

- **TikTok's caption is a story in four lines, and a post carries five hashtags at
  most (2026-10-19, the owner's call).** The caption was one paragraph that said what
  the post is about; it now tells it: a hook (one sentence, at most 100 characters,
  the part TikTok shows before "more"), the problem (what was at stake, what went
  wrong, the question the post settles), the discovery (the turn the slides show) and
  the result (how it ended, or what it means for them now), with the closing question
  at the end of the result. The writer returns the four beats as fields of the slides
  answer (`story`), not one text, and the code joins them a blank line apart, so the
  stored caption is the story and every later check reads the beats back from its
  lines: the owner's edit, a rewrite, a redraft (`src/rules/caption.js`). The check is
  of the shape, which code can see: four lines, a hook of one sentence, the others of
  two at most, three words or more each, none repeating another. Whether a line truly
  hooks is the reviewer's to judge. The beats retell the slides, so the old rule
  stands: the post's best fact is on a slide, never only in the caption, and a
  guess-who's or a ranking's result does not give the answer away. An account that
  asked for short, catchy captions (2026-10-17) keeps them, as four short lines: its
  limits cannot go below 160 characters and five sentences, room for four beats and
  the question, and no beat but the last may take more than its share. A pack that
  sets them lower is raised, and loading it prints a warning naming the pack and the
  limit (`packWarnings`), so the change is never silent. Instagram's
  short caption is not a story: it already leads with the cover line, and it stays
  one line under it. Hashtags were already capped at five where they are chosen
  (`hashtagsFor`); now no caption may hold one (a tag the writer added would go out
  twice or push the post past five), a format may name five at most, and the
  publisher counts the tags on each caption as it would go out and refuses more than
  five before anything leaves. An older recorded answer with one `caption` text is
  still read, and refused by the check unless it is four lines.

- **A refused draft is repaired where it failed before it is blocked, and numbers
  written in words are compared as digits (2026-10-19, the owner's call).** Six
  of about ten daily drafts on the live accounts were blocked, most of them one
  text short: a slide over its length, a caption in one paragraph, a number its
  slide forgot to cite. The old answer was a redraft of the whole post, which
  fixed that text and broke another about as often. Now each refused check is
  traced to the text it is about (`src/pipeline/repair.js`), and the writer is
  sent only those texts with the checks' exact messages, in a small call on the
  account's cached prefix: at most two calls, each reserved against the caps like
  any other. A repair is kept only when it clears a check and adds none. The law,
  honesty and the account's rules are never repaired, and a problem no single text
  owns (slides out of order, too few details) still gets the redraft. A number
  the fact gate refused is repaired by removing it or citing one of the post's
  verified facts whose quote holds it; the code refuses a repair that states any
  other new number or cites an id that is not a verified fact, so a repair can
  never bring in a source. The gate itself now reads "עשרים ושלושה",
  "מאה שבעים וחמישה" and "twenty-three" as 23 and 175 on both sides of the
  comparison: before, a compound number was a 20 and a 3 that no quote held, and
  a correct slide was blocked. The task blocks and the review now take the 1-hour
  cache in a batch, like the account's block.

- **A ranking is ordered by its amounts, a head-to-head needs both sides in its
  quotes, the bot score is measured after a rewrite, and Results shows what blocks
  (2026-10-19, the owner's call).** The AI companies ranking compared 8,200 against
  25,000,000: one place wrote "8,200" as its graphic and "מיליון דולר" in the line
  under it. A place's number is now read with its scale wherever the graphic
  writes it (after the number, the line under it, its label, its title,
  `rankAmount`), and the writer of a ranking is told the rank-slide rules first:
  the ranked number as the graphic, one measure, one unit. The Oliveira against
  Khabib post was planned on documents that never named Khabib in a verified
  quote; the outline is now told a matchup needs values for both sides, and the
  plan drops a stat whose quotes do not name both (`bothSides`). A matchup left
  with fewer than three stats goes to the next topic before a slide is written.
  When the side names cannot be matched to the quotes at all (Hebrew names over
  English quotes), the check passes, since it cannot tell. The "נשמע כמו בוט"
  score was 3/10 on every approved post because a rewritten text was never read
  again: it was set to one under the rewrite line. A rewritten text is now scored
  again in one small review call, the post keeps the measured number, and one that
  still scores 6 or more is blocked as before. Every failed check is recorded by
  a stable name (`checkOf`), and Results shows, for the last 30 days, how many
  posts each check blocked and how many first drafts failed it.

- **Home is an overview, and an account's look is locked (2026-10-19, the owner's
  call).** The owner asked for a home page like a shop's dashboard, "not a whole
  book". Home now shows four numbers (waiting, scheduled, out today, blocked
  today), a short "צריך אותך" list of one line per item, and one line per
  account. The post cards, with their slides, captions and facts, moved to a new
  Posts page in the menu. An account's look is saved the first time it renders
  (`src/render/style.js`), and every post is drawn in the saved look: a change to
  theme.json waits, and the Accounts page offers to apply it. Each post keeps the
  hash of its look, so an edit draws it again in the look it went out in. Hard
  rule 2 still wins: a saved look that another account's theme.json now uses is
  given up for the account's own file. Inside one post, the slides now share one
  ground photograph (they took the post's photographs in turn), and the content
  slides share one type size: those set larger are drawn again at the size the
  others came out at, never below 80%. An edit also used to draw a post again with
  only its cover photograph; it now keeps each slide's photograph, the ground and
  a head-to-head's two faces.

- **TikTok can go out as a draft with the owner's sound, and directly an hour late
  if it does not (2026-10-19, the owner's call).** TikTok's viral sounds reach no
  API: Zernio lists only the Commercial Music Library. With `zernio.tiktokMode:
  "draft-fallback"` in pack.json, a TikTok post goes to the app's inbox as a draft
  at its slot, and the owner is told which sound to add: one from the account's
  list (the Sounds page, three to five typed in by hand, stale after seven days,
  none repeated within the last five drafts). At 30 minutes the owner is reminded
  once; at 60 a draft still not out is published directly with a library track,
  through every rail a post at its slot meets (Shabbat and a paused account wait,
  the facts are checked again). The owner's post is found among the account's
  posts that Zernio synced from TikTok (its analytics, source=external), matched
  by caption. Never twice: the state is written before the direct publish, a send
  whose answer was lost is not sent again, and a draft published after the
  fallback is flagged as a duplicate on the home page, never deleted. Instagram is
  unchanged. Notifications are Web Push to the owner's browser, empty (the
  service worker reads the words from Teder behind the session); Telegram was
  the other way, and its API is a social host the network door refuses writes
  to. The push services join the write allowlist, each at its push path only.
  Every image search that finds nothing now records why its candidates were
  passed over, and `npm run images:check` reports it per account.

- **Wider sources, read only where the site lets Claude in; what someone said is a
  fact of its own kind (2026-10-19, the owner's call).** The posts were dry, so each
  niche now has outlets to add in one tap (the Sources page, `src/sources/catalog.js`),
  long reads first (`hints.prefer` puts interviews and features before match reports).
  Every feed and page is read only where its site's robots.txt lets this engine in
  and lets Claude's agents in too (`src/sources/robots.js`), since everything a
  source says is drafted by Claude: checked on 2026-10-19, The Athletic, the BBC, the
  Guardian, ESPN, ONE, TechCrunch and the two largest fight-news sites all tell
  Anthropic's agents to stay out, and are not read (src/sources/catalog.js names them); Sport5, Calcalist and CTech publish no feed.
  The check runs at every read, for every account's feeds and pages. A new fact
  kind, ATTRIBUTED (`fact.who`), is what someone said or reported: its quote is
  verified word for word as always, then the document must name them and a word of
  saying or reporting within 300 characters of it (or be the outlet reporting it);
  the slide that states it names them and says they said it ("לפי X", "X סיפר"),
  never as plain fact; and a post carries two at most, refused at the plan and at
  the gate.

- **A photograph's size floor depends on where it goes (2026-10-19).** The fight
  account's posts went out with almost no faces: of its last 10 posts, 1 had a
  photograph. Run live on the server, its searches for Kamaru Usman, Merab
  Dvalishvili and Islam Makhachev found Commons files of 387 to 862 pixels a side,
  many of them PNG crops, and the one floor for every photograph (a JPEG of 800
  pixels) threw them all out before anything looked at them. Now a cover takes 600
  pixels, a framed slide or half a head-to-head 450, the blurred ground behind the
  slides 400, and a PNG photograph counts (never one described as a screenshot).
  The name in the title, the licence and the screen decide as before.

- **Every approved post goes to TikTok's drafts at once, and the owner is reminded at
  its hour (2026-10-20, the owner's call).** "Each approved post should go to the
  TikTok draft immediately, then only a reminder at the correct hour." This is now the
  default TikTok mode, `draft-now` (`direct` and `draft-fallback` stay for a pack that
  names them). The moment the owner approves (or the engine does, in Digest and Auto),
  TikTok's part goes to the app's inbox as a draft, with a sound from the account's
  list named for it; nobody is notified then, since TikTok tells the owner of a new
  draft itself. The post stays approved, and at its slot Instagram goes out as always
  and the owner gets one Web Push: the account, the cover line, the sound. A server
  that was down at the hour sends it late, but not 12 hours late. The engine never
  publishes to TikTok in this mode, and nothing falls back. The draft meets every rail
  a post at its slot meets: a draft is a write to TikTok, so none goes on Shabbat or a
  yom tov (hard rule 9), nor for a paused account, a picture waiting for a person, or a
  fact that no longer holds (the post is blocked, as at the
  slot). A held draft is sent at the runner's first tick the rails allow, and at the
  slot at the latest. The state is saved before the send, so a tick or a second click
  sends no other; a send cut off mid-way is tried again after 15 minutes, three times
  in all. A draft is only ever the owner's to publish or delete, so a draft of a post
  whose approval is taken back, rejected or edited stays in the app: the post page
  tells the owner to delete it there until they press "מחקתי", and an edited post that
  stays approved gets a fresh draft. Settings turns notifications on and off per
  device; an iPhone (iOS 16.4 and later) needs Teder added to the home screen first.

- **Topics before documents (2026-10-20, the owner's call: "viral first").** A post
  used to start from whatever document a source had that day. Now it starts from a
  topic people already stop for: the owner's bank (typed in on the website, with why
  it went viral and where; first in line), then this week's signals per account (a
  watched name's Wikipedia page read at least 1.5 times its last month's daily mean,
  with a minimum of daily readers; the most-viewed Shorts of the last 14 days for the
  account's searches, titles and numbers only). Each candidate is scored once, before
  any outline, 0 to 10 overall and on five parts (shock, money, rivalry, hidden story,
  "didn't know that"); a signal under 6 or off the niche is never drafted. A bank topic
  is scored for the page but never skipped: the owner already knows it worked. Only
  then are the approved sources searched for the topic (stored documents that name it,
  then research through the approved Wikipedia and Hacker News sources). Nothing new
  about where facts come from: every fact is still quoted from a stored document of an
  approved source, and what a document only reports is said as theirs. A topic nothing
  approved supports is marked so and left; when no topic in line holds a post, the
  post is drafted from the day's documents as before, so a day is never empty. The
  signals are read only live, never invented offline; in the demo only the bank works.

- **Teder gets its own mark; the dots become the company's (2026-10-21, the owner's
  call).** The level meter in dots is no longer Teder's mark: redrawn as a halftone,
  dots growing toward the centre, it is now OpenFrequency's, on blue (#2747D6). Teder's
  is one wave, like a tilde, white on violet (#6A3FD6), in the header, on the login and
  as the app icon; a third product, Toran, has three dots on green (#0F7A54). The files
  are in `assets/brand` and the site reads its glyphs from there, so a mark is never
  redrawn by hand; the 5x5 halftone stands in for the company's where it is small (the
  footer is its only place here). Only the logo turned violet: the accent of buttons,
  links and the selected tab stays blue. On the login the wave draws itself in once,
  instead of the meter rising. The dots that tell each account's day on Today were never
  the mark and keep their look.

- **Sign-in moves to openfrequency-accounts; everything belongs to a workspace
  (2026-10-22, the owner's call).** Teder's own login, its users table and its password
  hashes are gone. A browser without a session goes to
  `accounts.openfrequency.co.il/login?next=<the page>`; Teder sends the
  `__Secure-of_session` cookie (only that one over HTTPS, so a sibling subdomain cannot
  plant a plain one) to accounts' `GET /internal/session` on this machine. Accounts' own
  document says to ask on every request; the owner chose a middle way: a page may use an
  answer up to 60 seconds old, and every POST (approve, publish, delete, any setting) asks
  afresh, so no change ever acts on a session that has signed out, lost its membership or
  turned read-only, and a refusal there ends the reuse at once. A check that fails
  (accounts down, a wrong token) shows a page instead of sending the browser round to the
  login and back. The CSRF token stays Teder's own, derived from the accounts session id.
  Every account has a `workspace_id`, and everything else hangs off an account. A session
  sees its workspace's accounts and nothing else; a post, source or takedown of another
  workspace is "not found", as one that never was. Push notifications wake only the
  account's workspace's browsers. The operator (the superadmin outside view-as) sees
  every workspace and is the only one who changes what is the whole server's: the API
  budget's cap, the kill switch, when posts are written, developer mode. A customer may
  later get settings of their own workspace (its posting times, a budget inside the
  operator's cap), never a global one. View-as is read-only on the server, with the
  banner accounts asks for. The switch itself is `docs/workspace-move.md`.

- **The Hebrew is held to the hebrew-voice guide, in code where it can be (2026-10-23).**
  The writer used to be told a few rules (spoken Hebrew, plural, no exclamation marks)
  and code refused stock phrases. The packs' own cover patterns and good lines taught the
  rest the other way: "{תאריך}: {מה קרה}", "בלי רגשות. רק קבלות", "והראשון מפתיע", "13
  שניות. זה כל מה שזה לקח". Now every writing call gets one voice block
  (`src/pipeline/prompts.js` `HEBREW`) and a read-aloud pass before it answers, and the
  rewrite rebuilds a flagged sentence instead of swapping a word. The checks split in two.
  What is ad copy or machine text every time is refused (`tellsIn`): "זה לא X, זה Y",
  "לא עוד X", "בלי X ובלי Y", "פחות X, יותר Y", three fragments in a row, one emphatic word
  as a sentence, a colon in a cover or a title (a score like 0:3 is a score), a label and
  a colon, teasers, form Hebrew, translated Hebrew, ad words, engagement lines, a gendered
  slash. Words in quotation marks are someone else's and are not held to it (a myth a slide quotes, "בספורט
  הזה אין חוקים ואין שעון"). What is a tell only most of the time is a hint (`softTellsIn`,
  `postTells`): "לא X אלא Y", "כ-80", "על ידי", a superlative with no number, a punch-line
  ending, a triad, brochure words, and across the post, the same opening, the same
  punch line, one sentence length, one favourite word. Hints go beside each line to the
  reviewer, who reads the sentence and decides; offline they add a point each, two at
  most, so they never block a post on their own. Refusing all of it was the
  alternative: on the recordings the hints fire on about one text in twenty, and each
  refusal there would have cost a redraft for a sentence that is often fine. The packs' cover patterns were rewritten with the same ids, so
  their results stay linked, and the calls to action say the spoken imperative.

- **Toran's dashboard reads the store demos and how often their pages were opened
  (2026-10-24).** The operator's dashboard is Toran's home page now, and it lists Teder's
  demos beside Toran's own leads (openfrequency-toran `docs/operator.md`, section 2).
  Teder answers `GET /internal/demos` with every demo, newest first, at most 500: its
  store, its status, the number that asked, when it was made, ready, approved and taken
  down, why it failed, and its page's address while the page is public (approved), else
  null. The address is `https://<PUBLIC_HOST>/s/<slug>`; on a laptop with no public name,
  the address the request came to. The route sits beside `POST /internal/lead` under the
  same checks: the token, a loopback socket, no `X-Forwarded-For`, so Caddy never passes
  it on; the answer is never cached. An open is a view of the store's page itself, not of
  its slides, its logo or its colour, by a browser that is not signed in to OpenFrequency:
  a session accounts vouches for, or one it knows and refuses here (another product's
  customer, a closed workspace), is not counted. A browser without a session cookie never
  makes Teder ask accounts, and an answer that fails leaves it a visitor. The browsers are
  counted the way Toran counts its pitch pages, by a random id in a cookie of the page's
  own (`of_v`, a year, HttpOnly, SameSite=Lax, Secure over HTTPS); the address is never
  kept. The demos list and a demo's page say how often it was opened and in how many
  browsers. Demos built before this are ready when they were approved, and taken down
  when the audit log says so.
- **A failed fact check blocks its post, not the account** (2026-10-24). It used to
  pause the account in every mode, until the owner resumed it by hand: one cover that
  cited the wrong quote for a score (6:1, which another quote of the same post held)
  stopped an account's whole day. The gate is unchanged, so a number no quote holds still never
  goes out; only the pause is gone, when drafting, redoing, publishing and at the
  TikTok fallback. A redo blocked by it is tried again like any other blocked one.
  An account paused for it before this still says so until it is resumed.
- **Zernio publishes for every customer account, connected by the customer
  (2026-10-24).** Before this, a pack's Zernio profile and account ids were typed into
  `pack.json` by hand. Now each account gets its own Zernio profile the first time
  someone asks to connect (`accounts.zernio_profile_id`, its `externalId` the pack id,
  created with an `Idempotency-Key`, so a retry or a lost answer never makes a second
  one). The customer connects their own TikTok and Instagram into it from the account
  page, the onboarding page, or a link the WhatsApp assistant sends. Read from Zernio's
  docs and OpenAPI spec (v1.350.1) the same day:
  - **What is connected is read from Zernio, never from the browser.** The return from a
    connect, and an hourly pass, read the profile's accounts and `accounts/health` into
    `zernio_connections`. An expired or revoked token is `reconnect`; the same button then
    passes `reconnectAccountId`, so the same account keeps its history. A break is
    recorded once (`broken_at`), and the assistant gets `account.reconnect` once per
    break, with a fresh link. An account that is on Zernio no more (disconnected there:
    the first live read found all three TikTok accounts gone from their profiles, and the
    next TikTok draft that afternoon refused with "accounts do not belong to this user") is
    `reconnect` too, as a new connect, and posts stop going to the id Zernio refuses. A
    hand-typed account in another profile of the team is not gone.
  - **Zernio's connect link lasts 30 minutes**, so it is never stored or sent. The
    assistant hands on a link to Teder (`/connect/<account>/<platform>`, signed with
    `OF_ASSISTANT_SECRET`, open for 72 hours, that account and platform only), and Teder
    asks Zernio for a fresh link at the tap. Whoever holds that link can connect an
    account there until it expires (the owner's choice over a sign-in on the phone). The
    account page shows which @user is connected.
  - **The connect button answers with a page, not a redirect.** The site's CSP keeps form
    submissions on our own origin (`form-action 'self'`), redirects included.
  - **Instagram goes through our own Meta app when it is set up for the account, else
    Zernio** (`publishers.instagram: "auto"`, the default for new packs). Instagram is
    offered for connecting through Zernio only where Meta is not set up: an account
    connected twice would be billed for nothing.
  - **TikTok goes to the drafts by default** (`draft-now`): the owner adds a trending
    sound in the app. "Straight to the profile" (`direct`) can be picked on the account
    page, and it sets `tiktokPrivacy` to public, since a private direct post is one nobody
    sees. Zernio confirms that photo drafts go to the inbox (`post_mode: MEDIA_UPLOAD`),
    that a direct photo post cannot carry the AI label (so a post with an AI image stays a
    draft, as before), and that TikTok drops the music track on drafts.
  - **Zernio has no per-profile price.** Profiles are free, and each connected account is
    billed in bands: the first 2 free, the 3rd to 10th $6 a month, the 11th to 100th $3,
    past that $1. So a customer's cost depends on where their accounts fall in the bands.
    The ledger keeps what Zernio itself splits per profile: `GET /v1/usage?groupBy=profile`
    for the month, read daily into `zernio_costs`, pro-rated against the invoice, and shown
    in the operator's ledger next to the API spend, outside the cap. A legacy Stripe plan
    has no usage-based invoice to split, and nothing is written for it.
  - **Per-post numbers.** Zernio answers one post as a flat object with
    `platformAnalytics[]`. The old reader looked for `posts[]` or `post`, so it probably
    never stored a TikTok number (unchecked: no published post in a local database). A
    platform still syncing (202) is left out rather than written as zeros, a failed post
    (424) has none, and a plan without the Analytics add-on (402) is said once per pass.
    Each platform that went out through Zernio is its own Zernio post and is read on its
    own id.
  - **The network door gains one write** (`POST /v1/profiles`: an empty folder on our own
    Zernio team) and the reads the connect needs (`connect/tiktok`, `connect/instagram`,
    `accounts/health`, `profiles`, `usage`). Disconnecting an account or deleting a profile
    stays closed. Teder takes no Zernio webhooks: the hourly read stands in, and so no new
    door opens from the internet.
  - **Our own TikTok app is a setting, not code yet** (`publishers.tiktok: "own-app"`, the
    operator's choice on the account page). Nothing in this repository or its history ever
    called TikTok directly. `src/publish/tiktok-app.js` names the interface and what
    building it takes. Until then such an account's TikTok posts are written to disk, as
    for any publisher without credentials.

- **The budget is gone, the plan is the limit (2026-10-24, the owner's call).** "Teder
  should remove its budget, each page gets 40 videos a month with 10 redos." Every
  account gets 40 slideshows and 10 redos a month (`src/budget/quota.js`, counted from
  the posts as before), and no sum of money blocks or slows anything any more. Gone:
  the $20 server-wide cap on the Anthropic API with its $15 warning, its spend file
  that failed closed (`$OF_HOME/data/anthropic-spend.json`, `npm run budget`), the 5%
  held for onboarding, each account's share and the planner that cut the weakest
  account's posts to fit the money (`src/budget/anthropic.js`, `src/budget/plan.js`),
  the $12 cost cap per customer and its pause, the reservation of each call's worst
  case, the lower cap the website could set, `budget` in `pack.json`, and the
  variables `ANTHROPIC_MONTHLY_BUDGET_USD`, `ANTHROPIC_BUDGET_WARN_USD` and
  `OF_BUDGET_MONTHLY_USD`. A migration drops the `reservations` table and
  `accounts.cap_usd`, deletes the budget's settings, and lets an account a cap paused
  write again (a kill switch stays on).
  - *Why.* A customer buys posts, not tokens: the plan is what they were promised, and
    a money cap could stop their month short of it for reasons that are ours. With the
    plan fixed, the money follows from it.
  - *What still bounds the spend.* The plan, per account; the day's slots drafted once
    a day (a stopped post waits for the next day, never a loop); and inside a post a
    fixed number of calls: at most 6 documents per format offered to the outline, one
    redraft, two repair rounds (`REPAIR_ATTEMPTS`), two rewrite passes, and a
    replacement our checks stop tried twice (`REDO_ATTEMPTS`). At the measured $0.15 a
    post made, stopped attempts included, a full plan of 50 is about $7.50 an account
    a month (docs/costs.md). A post our checks stop is still ours and is not counted.
  - *What stays.* Every call's real cost is recorded after it, from the usage block
    (`src/budget/ledger.js`), and shown to the operator: the month's cost on Settings,
    each customer's ledger by what the money went to, the cost per post in developer
    mode. A model missing from the pricing table is recorded at the dearest rate rather
    than refused. The operator can still give one account another number of posts,
    never dollars. The kill switches, the strike and publish-error pauses, the takedown
    pause and development's refusal of the API without `--allow-api` are unchanged.

- **A store's demo reads WooCommerce and Wix too (2026-10-24).** The demo was built
  from Shopify's public catalogue alone, and any other store was turned away. Now
  `src/demos/store.js` reads the homepage first and names the platform from what each
  writes into every page (Shopify's CDN, WooCommerce's classes, Wix's generator line);
  a homepage that names none is tried as each in turn. Each is read from what it serves
  any visitor, with no key and no sign-in:
  - *WooCommerce* through its Store API (`/wp-json/wc/store/v1/products?per_page=100`).
    Its prices are strings in the currency's minor unit (`currency_minor_unit`: "254"
    is 254 shekels in a store that sets 0, "1900" is 19 in one that sets 2), and a
    variable product's range is kept as its lowest and highest price. A security
    plugin can turn the Store API off; the store is then read from its sitemap
    (WordPress's own, Yoast's or Rank Math's index, the products sitemap in it) and
    each product page's schema.org Product. Some themes print no Product at all (one
    caterer's product pages had none), and some print it with an empty price: such a
    store with its Store API off cannot be read, and the operator is told so.
  - *Wix* from `/sitemap.xml`, the store's products sitemap in it, and each product
    page's schema.org Product (name, images, `offers.price`, `priceCurrency`,
    `availability`). A Wix product page weighs about 2.4 MB, so at most 24 pages are
    read (`MAX_PAGES`), one after another, never on another host.
  - Every platform's products come out in Shopify's shape (title, product_type,
    images, variants with price and stock), so the demo, its document and its page
    never ask which platform it was; the demo row keeps it (`store_json.platform`).
  - A store's own name is og:site_name, else its title, the first part that is not
    "home"; one that is a list of keywords (a jeweller's "name necklaces | silver rings |
    bracelets | ...") is no name, and the domain stands in.
  - Developed against real Israeli stores the same day: two WooCommerce stores with the
    Store API open (a jeweller in whole shekels, a caterer in agorot with price ranges),
    one WooCommerce store read from its sitemap, two Wix stores (a distillery, a
    souvenir shop) and one Shopify store. Their names stay private (they are on the
    private denylist that `check:public` reads). The fixtures in `test/fixtures/stores`
    are fictional stores on `.example`, each in the shape recorded from one of the real
    ones and trimmed (the fields, the minor units and price ranges, the JSON-LD, the
    sitemap layout), with made-up names, products, prices and addresses, as Toran's
    `examples/` are.
  - The store's page said the team connects Teder to WooCommerce and Wix among the
    things built in the service. For the catalogue that is now simply true of the demo
    itself, and the page says so: the demo was made from the products on the store's
    own site, and a store on Shopify, WooCommerce or Wix is read by Teder on its own.

- **The cover is written from hook templates (2026-10-25, the owner's call: "first slide
  hooks templates").** The owner brought a Hebrew carousel, "הוקים שהעלו את העוקבים
  ל-10k שאני עדיין חורשת עליהם", whose slides are first-slide lines that work: "במקרה
  שאף אחד עדיין לא סיפר לך", "הלוואי וידעתי קודם ש", "הנה האמת האמיתית על", "תנו לי
  לחסוך לכם זמן". They are now an engine-level library (`src/formats/hooks.js`), ten
  templates in four mechanisms (the secret nobody told you, I wish you had known, the
  real truth, I'll save you time), each a line with slots ({topic}, {fact}, {who}, {x},
  {thing}, {moment}, {skill}) and the account's gendered forms.
  - *Templates first, the pattern behind them.* A format's own cover patterns were the
    only source, one picked by the code. Templates could have replaced them, or been one
    more pattern in each format. They are offered first instead, up to three a post, each
    of another mechanism, and the writer takes the first whose promise the post's facts
    can keep; the format's pattern stays for the post no template fits (a guess-who
    always, a story whose twist a fact on the cover would give away). A template is a
    way to open any post, so it is not copied into every format, and a pack that has
    written good patterns keeps them.
  - *The code writes the line.* The writer returns the template's id, the words for its
    slots and the facts it promises (`hookTemplate`, `hookSlots`, `hookFacts`); the code
    fills the template in the account's voice (formats.json `hookTemplates.speaker`:
    חוסך, חוסכת or חוסכים, אני עומדת or אנחנו עומדים, plural by default) and makes the
    verb agree with {who} (המאמן לא אמר, המאפרת לא אמרה), from the pack's list of the
    niche's authorities or the writer's word for one it names itself. A model gets a
    gender wrong now and then; a lookup does not.
  - *Plural, and no invented experience.* The owner's lines speak to "you" in the
    singular ("לך", "אותך"), and every post addresses its audience in the plural, so the
    library says "לכם". "הלוואי וידעתי קודם" and "הלוואי והייתם מגלים את זה לפניי" say the
    account once did not know, or found it first: an experience an engine never had (hard
    rule 3). The wish is said to the reader instead ("הלוואי שהייתם יודעים את זה לפני
    שקניתם"), or as a wish ("החלום שלי שכולם ידעו ש"), and `src/voice/honesty.js` now
    refuses "ידעתי" and "ידענו" like "גיליתי"; a pack's own template that claims one is
    refused by validation.
  - *A teaser, on the cover only, and only when it is paid off.* The voice rules refuse
    a line that holds the point back, and these lines do exactly that. The exception is
    narrow and checked in code (`hookProblems`): the cover must have been written from
    the template (declared, for a kind the template lists); every fact it promises is
    verified and stated on a slide; every number on the cover is in those facts' quotes
    (stricter than the fact gate, which still holds it to every quote of the post), and
    an {x} is such a number, never "הרבה זמן"; the words in {topic}, {skill} and {thing}
    are what the slides are about, and a {fact} is what the promised facts say. The
    teaser checks read the template's fixed words as the account's own on that cover
    alone (`tellsIn`'s `frame`), and the words in its slots are checked as always. The
    same frame on a slide, under the cover, in a caption, or on a cover that did not
    declare it is refused. A rewrite or a repair keeps the template's words and changes
    only its slots; one that drops them makes a plain cover, credited to the format's
    pattern. The owner's edit is checked the same way.
  - *Learning.* A post stores `tpl:<id>` as its `hook_pattern`, so the 72-hour results,
    the Results page and the morning's feedback credit the template. Its results are
    pooled over the account's formats (a template is not one format's), each template
    gets two turns, then one offer in three goes to the least used and the rest follow
    the results, clamped 0.5 to 2, as the patterns do; one whose last three results all
    sat under 70% of the median rests 14 days, as a format does. The feedback's three
    variations of a winner try its mechanism's other templates first; a cover kept for a
    new call to action keeps its template; a cover that did not pull is not tried again,
    and neither is its mechanism.
  - *What a pack configures, without code.* `hookTemplates` in formats.json: `speaker`,
    `who` (the niche's authorities and their gender), `disable` (template ids or whole
    mechanisms), `add` (its own templates, in the same syntax, validated for their slots,
    the plural, and no invented experience) and `off`. The demo speaks in the masculine,
    names "המוכר במשתלה" and "סבתא", and turns off "told-wrong".

- **Accounts' setup checklist reads Teder's steps (2026-10-27).** openfrequency-accounts
  gets a public sign-up and one checklist page, `/setup`, that asks each product for a
  workspace's steps and links each one to the product's own page (the session cookie is
  shared across `*.openfrequency.co.il`). Teder answers `GET /internal/setup?workspace=<id>`
  under the checks `/internal/demos` has (the `OF_INTERNAL_TOKEN` bearer, a loopback socket,
  no `X-Forwarded-For`), in the contract accounts and Toran share (README, "For the services
  on this machine"). The steps are read from what is already kept (the onboarding row, the
  account's status, the samples, `zernio_connections`); nothing new is stored. A workspace
  with several accounts is reported on one, its newest account on air and else its newest
  onboarding, so a setup once done stays done when a second account is added: the
  checklist is about getting started, and each account's own state stays on its pages.

- **More licensed photographs: the owner's first, Openverse last (2026-10-27).** Posts went
  out bare: Commons has few usable photographs of today's athletes, and the fit check
  refused many it had. Three changes. *The owner's photographs* (`<pack>/photos/photos.json`)
  are searched first for every query whenever the pack has any, even when
  `imagery.providers` leaves `pack` out, matched on their subject, description and tags
  (the subject counts double); the screen still looks at each, and is given the owner's
  description as what the picture shows. *Openverse* (api.openverse.org, WordPress.org's
  index of CC-licensed pictures, mostly Flickr and Commons) is a fifth library, last in
  the default order: CC BY, CC BY-SA and CC0 only, an author for every BY licence, never
  NC, ND or the Public Domain Mark (on Flickr, where fans re-upload agency press photos
  tagged with AFP's own codes), and nothing carrying an agency's name or code. The credit
  says where Openverse found it ("Flickr via Openverse"). It works with no key at 20
  searches a minute and 200 a day; an optional `OPENVERSE_TOKEN` raises that, and a
  search it turns away rests it an hour. *A content slide's photograph* is checked for the
  slide's subject, not its claim: dairy shelves were refused for a slide about the
  regulated price of milk. It is refused only for the wrong person, the wrong sport or
  subject, or a picture that misleads; the safety questions are unchanged, and a cover is
  still held to its whole line.

### What spreads on TikTok, and the engine moved to it (2026-10-27)

The owner asked whether the engine is good enough, so its slideshows were laid beside 25 real TikTok photo posts
read slide by slide (20 over 500K views; 6 Hebrew, the best at 889K), and beside what the studies say. On the same
day the engine, run live five times on the three accounts, rendered none: every draft was blocked by its
own checks. What it made before looked like a sports site's infographics: a blurred, darkened photograph behind dense
cards (17 to 28 words a slide, 30 to 60 with the graphics), counters and progress bars, a news headline for a cover,
and a closing "follow" slide. The posts that spread are one sharp photograph a slide with one short line on it in
TikTok's own text, a cover of about seven words with a count, the best item last, a one-line caption, and a sound.
Seven changes, each where the engine was wrong, not where the posts were:

1. *What blocked every post.* A line broken by hand came back from the model as the two characters "\n", and the
   mixed-script check read "האוטובוס\nשל" as a Hebrew word with a Latin letter (two blocks in five): `mechanicalFix`
   makes it a line break. A year on the cover or in a caption ("2005") was refused when the quote the outline kept
   was another sentence of the same article: a year the post's own stored documents give is allowed there
   (`documentYears`, and again when the post is published); every other number is still held to its quotes. The
   review blocked at 6: it blocks only an obvious bot (9), and a post scored 4 to 8 after its rewrite waits for the
   owner in every mode (the runner already holds anything at `REWRITE_AT`).
2. *Covers may open a gap.* 8 of the 25 covers said "you didn't know" or "few people know", and the fight-sport countdowns
   kept number one for last. On the cover alone, "שאף אחד לא אומר לכם", "הסוד ש", "הראשון מפתיע" and "זה סיפור
   אמיתי" are no longer tells (`COVER_GAP`), and the reviewer is told a cover's job is to stop a thumb; the empty
   teasers ("לא תאמינו", "תתפלאו") and a cover that hides its subject ("זו הסיבה ש...") stay refused. The template
   library gains the count mechanism ("{n} דברים שלא ידעתם על {topic}", "{n} עובדות על {topic} שמעטים מכירים", "{n}
   דברים על {topic} שאף אחד לא אומר לכם"), its {n} written by the code from the post's own count.
3. *A photograph a slide.* The kinds below and any post in the native style (E) search a photograph for every slide,
   the cover included, up to one search a slide (`everyPhoto`); its photograph search is the slide's visual, and a
   graphic is drawn only where a photograph cannot show the point. The writer gives a thing as well as a person or a
   place ("espresso machine"). The native style itself, Openverse as a source and the owner's photographs first are
   their own entries.
4. *Short.* A facts slide's title is the fact in 6 to 12 words (14 at most) with no more than 10 under it; a tip has
   room for what to copy (40); a moment of the owner's story 16. A cover's count must match the slides.
5. *The shapes that spread.* `facts`: 4 to 7 separate surprising facts counted down to the one they will send, each
   on a photograph of who it is about (every sports hit). `tips`: 4 to 7 things worth saving (the AI and
   money hits, saved more than liked). `owner-story`: the business owner's own mistakes and numbers.
6. *The business's own story.* Every small-business hit was the owner on their own photographs, in the first person,
   with real numbers. A topic in facts/ marked `"owner": true` is the owner's own words (no page, no expiry, its
   document keyed "story-"), written on the Sources page under "הסיפור שלכם"; a slide that cites one, and the cover
   and captions of an owner-story post that has them, may say "I" (`ownerTexts`). Everywhere else an account still
   never claims an experience.
7. *The ending, the caption, the sound.* A post on a photograph a slide ends on its best slide: no call to action is
   drawn and no closing "follow" slide is added (17 of 25 ended on their last item; 1 of the 19 outside Israel asked
   to follow). TikTok's caption is one line by default, the hook beat (21 of 25 were one line or hashtags); the
   four-beat story stays for an account that asks (`writing.captionStyle: "story"`). A business account
   (`"business": true`) adds only sounds from TikTok's Commercial Music Library, which is all a business may use.

What did not change: every fact is still quoted from an approved source, every photograph licensed. The fact accounts
that spread use press photographs they have no licence for; the engine finds more licensed ones instead.

### The native style made native, and facts that make a fan say "wait, what?" (2026-10-27)

The owner looked at the first posts of the new engine and said they did not look viral. Laid beside the UFC
countdowns again, slide by slide in the app (6.1M, 3.9M and 1.6M views) and a Hebrew facts post (889K), they were not:
the native style set its lines on white boxes with a red highlighter, small (68px over a 72%-wide band), with a line
under each title and a source under that; a landscape press photograph was cut to 9:16, a third of it blown up three
times; slides the search found nothing for stood black; and the facts were rows of a records table ("28 ניצחונות,
ואף אחד לא ניצח יותר"), on a photograph of a lit-up arena for a cover. What the countdowns do: one line in the app's
plain white text with a thin shadow, about a nineteenth of the screen tall and four fifths of its width, the place
before it ("4. Both Diaz's brother are vegan"), over a sharp photograph of the one it is about, a landscape one shown
whole on black as the app shows it; a famous face on the cover with its count; strange facts about famous names.
The owner also said that A to D stay: they are their designs, and the content is everyone's.

- *Style E* (tokens.js, index.js): the white text with a shadow is its default (the box stays a choice), Heebo 700 at
  100px for the cover and 92px for a title (four lines at most, down to 64px), its side bands 100px instead of 152, no
  highlighter, no source line (the caption credits the photographs), and a facts post counts down to "1." as a
  ranking does. A photograph close to 9:16 fills the slide; a wider one, or one that would be blown up past twice its
  size, is shown whole in the middle of a black slide (`fitE`), its text on the black right above it when the face is
  in the middle of the picture. A slide with no photograph of its own takes one the post already has of the same
  person, then the cover's when the post is about one subject, then its scene's: never a black slide, never another
  fighter's face on a facts slide.
- *Facts* (kinds.js, prompts.js): a fact is about the sport as the audience follows it now (this season, this year's
  tournament, today's champions and stars), what happened in the cage or on the pitch, said as its shock: a never, an
  only, a first, a number that sounds impossible, a comparison that floors them ("GSP has more title defences than
  Khabib and McGregor combined"). A record is a fact only said as its shock. The name first, at most 60 characters,
  why it is strange in the line itself, and nothing under it. A first try went to life trivia from the "Early life"
  and "Personal life" sections of famous names (Lesnar's typing test, Henry flying to the NBA Finals, Rooney and the
  priesthood): the owner read it as old (a post from 2022) and beside the point, and so it was replaced the same day.
  The cover is the most famous face on the list, by name, never named on the cover and never a building, a plaque or
  a crowd (a plaque of Ronaldo's footprints passed as "Ronaldo"); the cover photograph is checked for the face. A
  facts or tips cover is written from a count template only. The research details are no longer three-at-least for
  these two kinds: the writer put them under the titles, and two rounds of repair could not take them off.
- *Sources* (the packs' topic banks), current pages only: for the fight account, the biggest stars of now (the
  current champions table, and Topuria, Pereira, Chimaev, Makhachev, Volkanovski and Gaethje, each one's lead and
  accomplishments: the firsts and onlys a shock is made of; the champions of the lesser-known divisions gave averages
  of fight time), the UFC's 2026 (the Paramount deal and the end of
  pay-per-view, the White House card, the bonuses, the new rankings) and the records that sound impossible; for the
  soccer one, the 2026 World Cup's records (the records page's players' section, already holding Mbappé's 22 goals,
  Ronaldo scoring at 41, Messi's 34 matches) and its final, the stars of now (Lamine Yamal, Haaland, Mbappé, Kane, each from this
  season's section) and this Premier League season. For the AI account, three tips topics from the guidance its bank
  already approved (Gemini's prompting guides, Google Cloud, Firebase and OWASP on security, GOV.UK on interface
  writing). A bank of current pages goes stale: the champions table follows the titles, but a topic that names the
  stars has to be read again each season.
- *Photographs*: a facts slide's photograph must show its subject large, the face visible (a stadium seen from the
  stands passed as Emiliano Martínez); a slide with none of its own stands on the post's scene only when the scene names
  no place (Anfield's crest stood behind two World Cup slides); a Commons author is cut to the name (one file's Artist
  field was its licence, and it went into a caption).
- *The caption* of a facts or tips post with short captions is its cover line, with its question: told to give nothing
  away, the writer still put the best fact in it, run after run. The reviewer is told that a countdown's caption saying
  its cover again is no tell, and the rewrite leaves it: scored 6 for it, it was rewritten with two of the facts.
- *Everywhere*: every slide's title is a whole statement with a name, a number or a moment, never a bridge line
  ("ואז הכל השתנה"); a story's beats in the order they happened; a short caption may be the cover line itself, never
  a list of names (a list that left three out was caught as a wrong summary).
- `npm run redraw -- --pack <id> [--style X]` draws a dry run's posts again from what it stored, in the style as it is
  now, with no model call: for looking at a change to a style.
- *Every slide on a photograph, in every style, and no photograph on every slide* (the owner, after seeing one post of
  each format: "the same background image can't be in all of the slides. even on A-D formats, an image has to be
  present. not a dark background"). A styled account searches a photograph for every slide and up to three scenes
  ('bg', 'bg2', 'bg3', a scene with no place's name first); the writer gives every content slide an imageQuery, a
  scene when the slide is about no one. `planPhotos` (render.js) gives each slide its own, else the least-used of what
  it may show, two slides a photograph at most while another is left: the same person's photograph, on a post about
  one subject its other photographs, then the scenes; never a guess-who's answer before its reveal, never another
  subject's face on a facts, ranking, head-to-head or list slide. A small photograph is shown anyway (E whole on black,
  A to D blown up), a slide keeps its photograph down to smaller type before giving it up, and the closing slide stands
  on a scene under a veil of the style's ground. The ranking that went out with two black slides now has a photograph
  on each.
- *Covers*: a hot take opens on its opinion (the format's own pattern, no template), and a list (do-and-don't, ranking,
  iceberg, facts, tips) on its count or its own pattern: "במקרה שאף אחד עוד לא סיפר לכם" opened both a hot take and a
  do-and-don't, read as forced, and hid the take until the last slide.
- *Every format of our time*: the soccer bank gains the 2026 World Cup final and knockouts, the 2026 Champions League
  final, last season's scorers, the all-time World Cup scorers after 2026, Yamal against Mbappé, Bellingham against
  Pedri, Neymar back at Santos, two hot takes (Spain the best team now; Yamal ahead of Messi at his age), guess-whos of
  today's stars and an iceberg of 2026; the fight bank, Gaethje stopping Topuria and Gane stopping Pereira at the White
  House card, the card itself, Topuria, Jon Jones and Pereira now, Harrison against Nunes at UFC 334, Gaethje against
  Topuria again, today's champions by defences and guess-whos of the 2026 champions. They come before the classics,
  which stay.
- *Three blocks that were the engine's*: a fighter's infobox row ("Wins | 17") is evidence however short, once in its
  document and as whole words (every stat of every head-to-head was refused as "too short"); a reviewer's fact note
  that clears itself ("No real unsupported claim") blocks nothing; and a doubted line under a title that no rewrite
  could fix is taken off when the post holds without it. A count of views a verified fact gives (UFC 1's pay-per-view)
  is a fact, not the account's proof.
- *The whole screen is picture* (the owner: "tiktok is a visual social media... the slides with no pictures or with a
  small one are not good. at least add a blurred background (same picture)... i am not even a fan of landscape
  pictures"). Every guide to photo posts says the same: 9:16, full screen, landscape photographs cropped to vertical
  before upload, never letterboxed. So style E fills the slide with every photograph sharp enough to fill it (cut
  around its face, blown up at most twice), landscape ones included, and shows whole only one too small for that, over
  a blurred, darkened copy of itself (`backdrop`), never on black; Commons photographs come at up to 2560 pixels so a
  landscape one has the pixels to be cut to a portrait, and a portrait one is preferred in the search (its shorter side
  counts half again). A to D keep their designs over a blurred copy of the slide's own photograph, the style's ground
  laid over it, where they had a flat ground around a frame, a top half or a fade.
- *TikTok's own furniture* (the owner: "tiktok has UI. format A cant be that high because of the ui, it has to be more
  in the middle. check more like this"). Every style was drawn under a mock of the app (the status bar and the tabs on
  top, the account, caption and sound at the bottom, the column of buttons on one side from 840 px down, on the left
  in Hebrew and the right in English): faces under the tabs in A, C and D, Hebrew lines run in under the buttons in all
  five, B's cover into the caption. The TikTok bands are now 220 on top, 470 at the bottom and 160 on each side (E
  gave up its wider 100); A, C and D start a slide's photograph 150 px down, under the tabs, with its words lower; A's
  cover ends above the caption; and E's photograph too small to fill the slide stands at the top under the tabs, its
  words under it in the middle of the screen.
- *Three formats that failed by design* (one post of each format, 2026-10-28). Every soccer head-to-head was refused:
  a player's stats are an infobox row ("2023– | Barcelona | 111 | (38)") dated by a note under the table ("as of 25
  October 2026"), and the claim's "עד 2026" was in no row; a year an "as of" note of the same document gives may now be
  said with it, and no other number. A guess-who of Lamine Yamal had no photograph, of the hundreds there are: its search
  had a word the account blocks ("trophy"), and a blocked word refused the whole search; now the word is left out and
  the rest searched (a photograph that shows the blocked thing is still refused), and the answer's photograph is looked
  for by name when its own search finds none, as a cover's is. A story of a last-second knockout went out as a list of
  the loser's bonuses: the outline now names the moment a story turns on with the facts that tell it, a story whose
  moment no verified fact tells is not that topic's post, the payoff slide is given those facts, and a draft that cites
  none of them is sent back.

### Sold self-serve: a paywall, posts that wait for a connection, emails through accounts, and a workspace that can leave (2026-10-27)

An audit of Teder as a self-serve product found five holes. Teder checked only that the product was enabled for the
workspace, never that it was paid for, and the runner had no notion of a workspace: an unpaid or cancelled customer
kept getting posts drafted and published. A customer who had not connected TikTok or Instagram had every approved post
fail in English ("no Zernio tiktok account id in pack.json"), and the third failure paused the account. Nobody was told
that posts were waiting: the daily posts and the weekly summary reached only the WhatsApp assistant, which is not
running, while unapproved posts expire at the end of their day and still count toward the month. The website promises
"דוח תוצאות בכל חודש", and there was none. And /setup could say done with nothing connected. Five changes:

1. *A paywall that fails closed, slowly.* Accounts owns subscriptions; Teder asks `GET /internal/entitlement` and acts on
   `allowed` alone (`src/billing/entitlement.js`). The answer is kept in the database, so the website and the runner
   read the same one and a restart keeps it: fresh for 5 minutes, and the last answer standing 24 hours while accounts
   cannot answer, so a paying customer is never stopped by a hiccup; never answered for, or older than a day, is not
   allowed. A workspace not allowed sees a paywall page (402, a link to accounts' /setup) instead of every page, its
   onboarding included; the operator and view-as never do. In the engine the check is in `canRun`, the one rail every
   generation, TikTok draft, publish and fallback already passes, so nothing that writes or publishes can miss it; the
   morning feedback and topic scoring, which spend on Claude, skip it too. The account is not paused and nothing is
   deleted: paying again needs no resume. An account in no workspace is the operator's and never asks.
2. *Held, not failed.* A post approved where nothing is connected is `held` (`src/publish/hold.js`): nothing is sent,
   it is not a failure and not in the streak, and the home page says "כדי שהמצגות יעלו, מחברים את ..." with the
   connect link. When a platform is connected the runner gives each held post the account's next free slot, rather
   than sending a backlog in one burst. One of two platforms connected is enough: the post goes there and the other is
   marked skipped, since a customer may want TikTok alone, and the setup step asks for at least one. TikTok stays on
   drafts (the owner's choice: they add a popular sound), and the connect panel now says so before the button, with
   what Instagram needs (a professional account, business or creator). Every failure and every connect error the
   customer reads is Hebrew (`src/publish/errors.js`); Zernio's codes are matched by what they say, since they are not
   one fixed list, and kept in the audit and the post's steps.
3. *Emails, written here and sent by accounts.* Accounts owns the owners' addresses and their opt-out; Teder writes the
   words and posts them to `/internal/notify` (`src/notify/email.js`): posts waiting (once a day, after the day's posts
   are written), the week (Sunday 09:00), the month's results (the 1st, 09:00: what the Results page counts, which makes
   the website's promise true), a connection missing (at most daily) and a post that did not go out (once). Like the
   assistant's events, each is found from the database at a tick, so nothing in the pipeline has to remember it and an
   email missed while the server was down is found when it is back. Sent once, retried three times when accounts is
   down, given up at once when accounts will refuse it again (its limit of three of a kind a day, Teder off for the
   workspace, a bad field), never thrown into the runner. Accounts builds the email from the text alone, so the text
   carries the link. Each kind is the customer's to turn off in Settings. They live in the settings table rather than a new
   table, so no migration was needed beside the other work on the repository.
4. *A setup that cannot say done with nothing to publish to.* `/internal/setup` gains a required `connect` step, done
   once one platform works; the per-platform steps stay after it, optional, so the checklist keeps its detail.
5. *A customer can leave.* `POST /internal/workspaces/<id>/delete` (accounts calls it when a workspace is deleted, waits
   10 seconds, and aborts the whole deletion on any failure) pauses the accounts and deletes their rows and pack folders
   before it answers, and only then removes the rendered files and, on Zernio, disconnects their TikTok and Instagram
   from our team and removes their profiles: Zernio's own pace must not fail the customer's deletion. The audit log and
   what was spent stay, by account id. Asked again, or for a workspace never seen, it answers 200 with zeros.
   This opens the network door to two more writes, `DELETE /api/v1/accounts/<id>` and `DELETE /api/v1/profiles/<id>` on
   zernio.com, where before the door asserted "never a disconnect": Zernio bills every connected account, and an account
   left connected after its customer is gone is a bill for nothing and a customer's account still reachable from our
   team. They reach our own Zernio team only, never a social platform, and only for a workspace accounts says is
   deleted. An account id typed into a pack by hand is not disconnected: it may be the operator's own.
