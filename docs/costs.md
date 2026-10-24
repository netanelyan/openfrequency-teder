# Costs: a plan per account, no cap

2026-10-13, updated 2026-10-24. What the engine costs to run, what each service
gives for free, what every phase 2 change did to the cost of a post, and what a
month costs now.

**There is no money cap since 2026-10-24.** The owner: "teder should remove its
budget, each page gets 40 videos a month with 10 redos." Every account (a page) gets
40 slideshows and 10 redos a month (`src/budget/quota.js`), and that plan is what
bounds the spend. What each call costs is still recorded, for the operator to read
(Settings: the month's cost, each account's cost by what it went to, the cost per
post in developer mode), and nothing refuses a call for money
([decisions.md](decisions.md), *The budget is gone, the plan is the limit*).

## The month now

At the measured **$0.15 a post made** (the stopped attempts paid for included, the
section [The full pipeline, measured on real token counts](#the-full-pipeline-measured-on-real-token-counts-2026-10-14)):

| | Posts a month | AI cost a month |
|---|---|---|
| One account, its whole plan (40 slideshows and 10 redos) | 50 | **about $7.50** ($5.75 at the best first round's $0.115, $10 at the worst's $0.20) |
| One account, the slideshows only | 40 | about $6 |
| Three accounts, every plan used | 150 | about $22.50 |

Plus Zernio, per connected account ([below](#zernio-per-connected-account)), and
fractions of a cent for onboarding (Brave) and trends (Haiku). A post our checks stop
is not counted against the plan but is paid for: that is inside the $0.15. The day's
slots are drafted once a day, so a stopped post waits for the next day's generation
rather than being tried again in a loop, and inside a post the calls are bounded (at
most 6 documents per format offered to the outline, one redraft, two repair rounds,
two rewrite passes, a replacement tried twice at most).

The sections below are the measurements as they were made. The ones that speak of a
cap ($15, then $20), of shares and of the planner cutting volume describe the engine
before 2026-10-24.

## The rule until 2026-10-24

**$15 a month, hard, for every metered service except Zernio** (Anthropic, Brave,
image APIs, anything else that bills); $20 from 2026-10-15. The VPS is already paid
for. Zernio is billed per connected account and is shown on its own line below.

The planned volume was 3 accounts at 2 posts a day: about **180 posts a month**,
so about **$0.083 a post** for AI and everything else. Before phase 2 a post was
estimated at $0.08 to $0.13 on Claude Opus 5.5: it did not fit.

## Every service the engine calls

Checked on 2026-10-13 on each provider's own pages.

| Service | Free tier and limits | What the engine uses | Cost a month | Source |
|---|---|---|---|---|
| Anthropic API | none | drafting, review, rewrites, judging | the variable part: see below | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Brave Search API | $5 of credit every month (about 1,000 queries at $5 per 1,000); 50 queries a second. The old free plan ended in Feb 2026; a card is required | only when a new account is onboarded: 5 queries, cached 30 days | $0 (the ledger still records each query at the list price, $0.005, so the credit never hides a cost) | [brave.com/search/api](https://brave.com/search/api/), [credit terms](https://api-dashboard.search.brave.com/terms-of-service/credit-terms) |
| YouTube Data API v3 | free, quota only: since 2026-06-01, 100 `search.list` calls a day in their own bucket, and 10,000 units for everything else (`videos.list` is 1) | weekly trend search: a handful of queries per account a week, cached 7 days | $0 | [quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) |
| Pexels | free; 200 requests an hour, 20,000 a month | cover photos when a theme asks for one | $0 | [docs](https://www.pexels.com/api/documentation/) |
| Unsplash | free; 50 an hour (demo), 1,000 an hour (production) | same | $0 | [docs](https://unsplash.com/documentation) |
| Wikimedia Commons | free; 200 requests a minute with an identifying User-Agent (10 without) | same | $0 | [rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits) |
| Meta Graph API (Instagram) | free; 100 API posts per account per rolling 24 hours (some reference pages still say 50: the engine reads the live quota); "4800 times impressions" calls a day per app and account | 2 posts a day per account, their insights | $0 | [content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing), [rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) |
| data.gov.il (CKAN) | free; no documented limit; licence per dataset | the money pack's datasets, read once a day | $0 | [CKAN API](https://data.gov.il/api/3/action/license_list) |
| Bank of Israel (SDMX) | free; no documented limit; the terms page is behind bot protection and could not be read | the policy rate and exchange rates | $0 | [edge.boi.gov.il](https://edge.boi.gov.il/) |
| CBS (Lamas) | free under a royalty-free licence that asks for a credit line; User-Agent required | the price indices and the average wage | $0 | [API](https://www.cbs.gov.il/en/Pages/API-interface.aspx), [licence](https://www.cbs.gov.il/en/Pages/Enduser-license.aspx) |

**Fixed costs: $0.** Every service but Anthropic is free at this volume. (Until
2026-10-24, 5% of the cap, $0.75, was kept back for onboarding a new account, so the
three accounts shared $14.25 a month for Claude.)

## Zernio, per connected account

Zernio bills per connected social account: **the first 2 are free, then $6 a
month each** for accounts 3 to 10 (then $3, then $1), every feature and
unlimited posts included ([pricing](https://zernio.com/pricing)). Instagram now
goes direct, so only TikTok uses Zernio here.

| Zernio accounts connected in all | Billed | Cost a month |
|---|---|---|
| 3 (the three TikTok accounts here, nothing else) | 1 | **$6** |
| 3 + 1 from another project | 2 | $12 |
| 3 + 2 from other projects | 3 | $18 |
| 3 + k | 1 + k (up to 10 accounts) | $6 × (1 + k) |

Before phase 2 this project would have connected 6 accounts (TikTok and
Instagram for three packs): $24 a month on its own. Run `npm run zernio:check`
to see the count Zernio really bills.

**Customers (2026-10-24).** Each customer account has its own Zernio profile, and
the customer connects their TikTok, and their Instagram where our own Meta app does
not publish it. Profiles are free. A customer adds 1 or 2 connected accounts, at the
band the total has reached: $6 each up to 10 accounts in all, $3 from the 11th, $1
from the 101st. So a customer with TikTok and Instagram on Zernio costs $12 a month
early on and $6 past ten accounts. Zernio's own split of the bill per profile is read
daily into the operator's ledger (Settings, "מכסות ועלות לפי לקוח", the Zernio column),
next to the API spend.

## Per post: before and after each change

### How it was measured

The project's key was not used (the owner's instruction: nothing Claude Code can
do goes on the key). Instead, `npm run compare` builds the exact request the
engine sends at each step, for 15 fixed topics (5 recorded documents per pack,
each with a format), and a Claude Code subagent on the matching model answers it
once. The script plays the engine: it verifies each fact against the stored
document, runs every check, asks for a redraft or a review or a rewrite exactly
when the engine would, and prices every call from its token counts at the
published rates. Every version is in `private/cost-compare/`, one file per topic,
side by side.

Limits of the method, all of which `npm run live-day` removes:

- **Tokens are estimated**, from character counts (Hebrew about 2.2 characters a
  token). The newer tokenizer may count Hebrew higher.
- **Thinking is not visible** in an answer. Each call is priced with thinking
  between half and twice its answer: the ranges below.
- **A subagent is not byte for byte the API model**: the `haiku` alias may be
  Haiku 4.5, not 5.5, and a subagent carries context from one topic to the next
  (one agent applied a lesson from one refusal to a later topic).
- **Batch and cache** are priced from the rules, not observed: cache hits inside
  a batch are best effort.

### The steps

Each row adds one change to the row above. "Per post" is per attempted post,
blocked ones included; "queued" is how many of the 15 passed every check.

| | Change | Config | Per post | Queued | What happened to quality |
|---|---|---|---|---|---|
| 0 | **Before**: Opus 5.5 everywhere, the old prompts | A | **$0.081 to $0.131** | 15 of 15 | every fact verified; but the Opus review found two posts with a wrong sentence (a correct number, a false claim around it) that the engine ignored and queued |
| 1 | **Model routing**: Sonnet 5.5 drafts, Haiku reviews | B | $0.025 to $0.039 | 13 of 15 | Sonnet lost one topic (dates in claims, not in quotes) and one more on facts |
| 2 | **Smaller context and cache order**: documents narrowed to content (37% fewer characters), at most 5 voice examples a side and 3 owner edits, the pack as one stable first block; code fixes for punctuation tells; one redraft | C | $0.027 to $0.040 | 13 of 15 | same as B. Input per call went *up* before caching (the pack block now opens the outline call too) and down after it |
| 3 | **Message Batches API**, a day ahead | C | $0.014 to $0.020 | | none: same model, same prompt |
| 4 | **Prompt caching** (the pack block, 1-hour TTL) | C | $0.011 to $0.018 | | none |
| 5 | **The review on Sonnet**, not Haiku; a fact problem rewritten or blocked; generic closing questions dropped in code; the flagged lines rewritten once | G | **$0.017 to $0.027** | 11 of 15 | the review now works (below); the 4 lost are a dates topic (fixed, below), a document that cannot carry its format (the engine tries the next one), and 2 posts rightly stopped |
| 6 | **"A date is a number too"** in the outline prompt | E | | the dates topic: 0 of 5 facts became 6 of 6 | |

**Per published post** with everything on: $0.017 to $0.027 over 11 to 12 of
every 15 attempts, about **$0.021 to $0.036**.

Per step, with everything on (config G, average per call, batched and cached):
outline $0.007 to $0.011, slides $0.005 to $0.008, review $0.003 to $0.005, a
rewrite $0.005 to $0.007. The full table is in `private/cost-compare/summary.md`.

### Where Opus was needed: nowhere. Where Haiku was not enough: the review.

- **Drafting on Sonnet.** Opus verified every fact it quoted; Sonnet lost one
  topic by putting release dates into claims whose quotes lacked them. One
  sentence in the outline prompt fixed it on re-measure. Every queued post passes
  the same fact gate either way.
- **The review.** On the very same drafts, Haiku scored nearly every text 1 out
  of 10 and found no fact problems; Opus scored the stock captions 8 to 9 and
  found unsupported claims in 9 of 13 posts (a rate "in effect from October" that
  changed on 3 September; "Israel's only World Cup", which no fact said); Sonnet
  found the same ones, at half Opus's price. The review is the only check of the
  sentence around a quoted number, so it runs on **Sonnet**. Haiku stays for
  scoring sources and reading trends (`judge`), which was not measured.
- **A caution:** two Sonnet review runs on nearly the same drafts disagreed a lot
  on slide titles (one flagged almost every title as "template"). The captions
  and the fact problems were consistent. The live run will show which is typical;
  the threshold (rewrite at 4, block at 6) is unchanged.

## The month at 180 posts

Phase 2's forecast, kept for the record. The three accounts' launch set measured
more of each post (the review and its rewrite, the share of posts stopped): the
current forecast is the next section's.

| Case | Per published post | 180 posts | Inside $15? |
|---|---|---|---|
| Expected: batched, cached, thinking low to high | $0.021 to $0.036 | **$3.80 to $6.50** | yes |
| The newer tokenizer counts Hebrew 35% higher | $0.029 to $0.049 | $5.10 to $8.80 | yes |
| No batch and no cache at all (direct calls) | $0.055 to $0.082 | $9.90 to $14.80 | yes, barely |
| Onboarding, trends (Haiku), Brave | | under $0.50 | |

**The forecast is at or under $15 without Zernio** in every case above, and the
expected case leaves room for a fourth account. If the live numbers come in
higher, the planner cuts the weakest account to one post a day before anything
else, and the cap holds regardless.

One cost of a provable cap: each call reserves its worst case while in flight
(a batched outline about $0.11, slides about $0.08, a review about $0.04), so the
last dollar or two of a month can go unused when no call's ceiling fits.

## The three accounts and their ten kinds of post (2026-10-14)

The content model changed what a post sends. Each account's cached block is
bigger (every format with its cover patterns, the shape of each kind it uses):
about 3,900 to 4,300 tokens, against about 2,500 before. A post can read two to
five documents (a head-to-head reads both players' articles), and it writes two
captions and the keywords.

### Measured on the launch set

27 posts (9 per account), every request exactly what the engine sends, answered
by a Claude Code subagent on Sonnet, every call priced from its token counts at
the Message Batches price with the account's block read from the cache, thinking
as half to twice each answer. Unlike the first measurement of this section, the
engine's second look was measured too, not estimated: the review of the finished
post and the rewrite of what it flags. A recorded build cannot take that step, so
the launch harness now does (decisions.md, *The launch set takes the engine's
review too*).

| | Per attempted post | Calls |
|---|---|---|
| Each of the three accounts, batched and cached | $0.022 to $0.041 (the three within half a cent of each other) | outline, slides, review, rewrite |
| All 27 | **$0.023 to $0.039** | |
| The same calls without batching or caching | about $0.085 | |

The review is strict: it flagged 9 to 15 texts of a post's 13 to 16, so nearly
every post pays for a rewrite of most of its lines. That is the main difference
from the first measurement ($0.018 to $0.032).

What a published post costs depends on how many attempts the checks stop. The
second round of the launch set, drafted on the engine's own rules with no help,
is the best measure there is: 5 of 27 outlines failed the checks (the engine
tries the next document), about 85% of first slide drafts used the one redraft,
and about 30% of posts were stopped in the end (by the checks after the redraft,
or by a fact problem the rewrite did not fix). The engine drops those and drafts
another. Counting all of it:

| Case | Per published post | 180 posts | Inside $15? |
|---|---|---|---|
| Expected: batched, cached, thinking low to high | $0.040 to $0.068 | **$7.20 to $12.20** | yes |
| The newer tokenizer counts Hebrew 35% higher | $0.054 to $0.092 | $9.70 to $16.50 | not at the high end |
| No batch and no cache at all | about $0.145 | about $26 | no |
| Image screening with Claude Haiku (one photo a post, every photo on a strict account) | under $0.001 | under $0.20 | |

**The expected month is inside $15 without Zernio; the worst cases are not.** The
cap holds in every case: each call reserves its worst case first, and the planner
cuts the weakest account first before the month runs out, so a dear month
publishes fewer posts, never more money. Zernio stays on
its own line above: $6 a month for the three TikTok accounts on their own. Photos
come from Wikimedia Commons (free); Pexels and Unsplash are not used by these
accounts.

Three things would bring it down, none of them taken without the live numbers:
the review's rewrite threshold (a text at 4 of 10 or more is rewritten; at 5, a
strict reviewer's rewrites would shrink by about a third), the stopped share (a
live model that counts sentences better than the subagents did stops fewer
posts), and batching, which is on by default and halves every call.

## The full pipeline, measured on real token counts (2026-10-14)

The second launch set ran every call through the Claude Code CLI (development
spends nothing on the API: README, *Development and production*), and the CLI
returns each call's real token counts, thinking included, where the sections
above estimated thinking. Each call is priced at what the API would charge in
production, the Message Batches price with the account's block read from the
cache, and stored as `spend.api_usd`; `npm run launch -- costs --pack <id>`
adds them up per call type.

Since the last measurement a post also does more: a research step (a details
call before the slides, on up to 60,000 characters of sources), a second rewrite
pass for what the first refused, and a vision check on every photograph.

| Call | Model | Avg tokens in | Avg out | Share of the cost |
|---|---|---|---|---|
| outline | Sonnet 5.5 | 15,700 to 16,300 | 2,000 to 2,700 | 32% |
| details (research) | Sonnet 5.5 | 12,200 to 13,600 | 1,060 to 1,230 | 14% |
| slides (with its one redraft) | Sonnet 5.5 | 11,900 to 13,000 | 2,680 to 2,830 | 35% |
| review | Sonnet 5.5 | 4,300 to 4,800 | 1,000 to 1,210 | 9% |
| rewrite | Sonnet 5.5 | 10,100 to 10,700 | 960 to 1,060 | 10% |
| image check (vision) | Haiku | 5,100 to 5,300 | 780 to 860 | under 1% |

Over the three accounts' four rounds, 147 attempts made 79 posts (the checks
stopped the rest, and each stopped attempt is paid for):

| | Per attempt | Per post made, stopped attempts included |
|---|---|---|
| The three accounts | $0.075 to $0.086 | $0.134 to $0.152 |
| All of them | $0.079 | **$0.146** |
| A first round (every post new) | | $0.115 to $0.201 |
| The vision checks alone (206 of them; 3 to 9 a photo post) | $0.0005 a check | under $0.004 |

A last round, which made again only the posts that kept failing, cost up to $0.37
a post made: the hardest posts are stopped most. A day's drafting is mostly first
attempts, so the forecast uses the average.

The CLI adds about 1,000 tokens of its own framing to every call, so these run a
few percent high.

| Case | Per post made | 180 posts | Inside $15? |
|---|---|---|---|
| Expected (the average) | $0.15 | **$27** | no |
| The best first round | $0.115 | $20.70 | no |
| The worst first round | $0.20 | **$36** | no |
| Vision checks, included above | under $0.004 | under $0.70 | |

**180 posts a month does not fit in $15.** The rule is to cut volume, not quality,
so the planner now cuts in half-post steps: the weakest account comes down
half a post a day at a time (1.5 is three posts in two days) to one a day, then
the next weakest; if every account is at one a day and the forecast still does
not fit, the weakest goes on to a post every other day, then the next
(`src/budget/plan.js`). `DEFAULT_COST_PER_POST` is now $0.15, the measured
average, until each account has four posts of its own.

What fits, on November 2026's calendar (152 slots at two a day: Shabbat and the
festivals have none) and $14.25 (the cap less the 5% engine reserve):

| Cost per post | The planner's rates | Posts | AI cost |
|---|---|---|---|
| $0.115 (best) | 1, 1.5 and 2 a day | 119 | $13.68 |
| **$0.15 (expected)** | **1 a day each** | **86** | **$12.90** |
| $0.20 (worst) | 1, 1, and a post every other day | 71 | $14.20 |

Zernio stays on its own line, outside the cap ($6 a month for the three TikTok
accounts).

What would bring the volume back up, none of it taken because each one trades
quality: fewer stopped attempts (the main lever: half the cost of a post made is
attempts that did not make it), shorter source text into the outline (most of its
14,000 tokens), and a cheaper model for the details step.

## The cap at $20 (2026-10-15)

The owner raised the monthly cap for the Anthropic API from $15 to $20, with a
warning at $15 (`ANTHROPIC_MONTHLY_BUDGET_USD`, `ANTHROPIC_BUDGET_WARN_USD`). Every
API call is also checked against a spend file of its own
(`$OF_HOME/data/anthropic-spend.json`), which fails closed when it is missing.

What fits on November 2026's calendar (152 slots at two a day) and $19 (the cap less
the 5% engine reserve):

| Cost per post | The planner's rates | Posts | AI cost |
|---|---|---|---|
| $0.115 (the best first round) | 2 a day each | 152 | $17.48 |
| **$0.15 (expected)** | **1, 1.5 and 2 a day** | **119** | **$17.85** |
| $0.20 (the worst first round) | 1 a day each | 86 | $17.20 |

## Measuring the real thing

`npm run live-day -- --confirm` drafts one day of the planned volume (6 posts)
for all three accounts on real calls, through the Message Batches API, into the
live database in Approve mode, and prints what each post really cost, from the
usage blocks the API returned (input, cache writes, cache reads, output). It
spends a few tens of cents on the project's key. It needs
`ANTHROPIC_WORKSPACE_ID` in `private/.env`: the key there is not scoped to a
workspace, and the API refuses it without one. The Default Workspace's ID (the ID
column on the console's Workspaces page) is enough. After it, every call the engine
makes is recorded the same way, and the Settings page shows the measured cost
per post per account (developer mode).
