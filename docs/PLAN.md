# open-frequency: the plan

One engine that runs several social accounts, each in its own niche, each its
own brand, mostly on its own. Working product name: **Teder** (תדר, "frequency").

This file describes the engine. It names no real account: the public repository
holds the engine, the website, tests, docs and one fictional demo pack. Real
packs, the database, rendered media, recordings and keys live in a private
folder, `$OF_HOME` (default `./private/`, gitignored entirely).

## Where it comes from

The engine is a generalisation of an earlier single-account pipeline that turned
one site's data into Hebrew slideshows, posted them through Zernio, learned from
their numbers and had an approval website. What carries over, what changes, and
what is dropped:

| Area | Ported | Changed | Dropped |
|---|---|---|---|
| Schedule | Israel wall clock through `Intl`, posting windows, DST-safe `israelInstant`, step-forward search for the next slot | Shabbat is **computed from sunset** (NOAA solar position for Jerusalem) instead of fixed Friday/Saturday hours; candle-lighting and nightfall margins are config | travel-specific slot comments |
| Verification | the verbatim-quote check and its normaliser, the minimum quote length, the "a number on a slide must be backed" idea | quotes are checked against a **stored snapshot** of the document (SQLite), not a live refetch, so any post can be re-verified later; quotes also have a **maximum** length (short facts only); every number on a slide must appear in that slide's cited quotes | flight-price guard, decimal/rounding rules tied to card layouts |
| Voice | the Hebrew AI-tell checks (connectives, formal words, generic praise, invented experience, "we", gendered address, colon/semicolon/long dash, exclamation, emoji count, lists of three, moral endings), the bot-score reviewer with rewrite at 4+ | split by text kind (slide, caption); pack-specific banned phrases come from `rules.json`; the reviewer has an offline heuristic implementation | the comment/DM/agency drafting kinds (the engine never writes to other accounts) |
| Rendering | headless Chromium for real Hebrew bidi, fonts inlined as data URIs, the "did the font actually load" guard, the shrink-to-fit pass, the contrast gate idea | slide layouts are a small **template library** driven by each pack's `theme.json`; network is blocked inside the render context; contrast is checked from theme colours (and a measured scrim on photo covers) | travel layouts (maps, routes, itineraries, collages) |
| Publishing | the Zernio client shape, its error classes, "pending is not failure", privacy defaulting to private | one Zernio profile per account; the AI-content flag; a `dry` publisher that writes to disk and is the default | Telegram, the TikTok inbox-draft path, the Instagram Graph publisher |
| Metrics | "never record a number the API did not give", re-reading until 72h, TikTok has no saves | read through Zernio analytics per profile; scored at 72h: TikTok (shares + likes) / views, Instagram saves / views | the TikTok Display API and Graph insights code |
| Formats | 70% proven / 30% trials, drop after 3 losses below 70% of the platform median, keep at least 2 proven, own formats rest and return | formats come from each pack's `formats.json` | travel post types |
| Trends | YouTube Shorts with real view counts, "copy the format, never the content", the three-word source-leak check | per pack queries from `formats.json`; mapped only to formats the pack can build | the Brave/TikTok weak-signal path |
| Sources | RSS/Atom parser, `htmlToText` and boilerplate stripping, feed discovery from `<link rel="alternate">` | one `Source` interface over RSS, web pages and structured APIs; every fetched document is stored | the travel adapters |
| Budget | the monthly ledger keyed on the Israel month, model price table, "unknown model is billed at the dearest rate", guard before every paid call | ledger in SQLite, **per account and global**, every call measured | in-memory usage counters |
| Website | server-rendered pages, the login (HMAC cookie, rate limiter, constant-time compare), Host/Origin checks, strict CSP | Hebrew RTL, mobile first, light and dark, a real visual identity; users in the database so more can be added | the growth desk's lead flows |

Everything niche-specific becomes pack configuration. Nothing in `src/` mentions
a niche.

## Repository layout

```
open-frequency/                 public
  src/
    core/        env, paths ($OF_HOME), clock, ids, the one network door (allowlist)
    db/          SQLite (node:sqlite), schema and migrations
    packs/       load + validate packs (schema, brand distinctness, compliance)
    schedule/    Israel clock, sunset, Shabbat, windows, per-account slots
    sources/     Source interface: rss, web, api (wikidata, json), recorded; feed discovery
    llm/         Claude over fetch (JSON schema output), recorded client, prices
    budget/      per-account and global monthly ledger and guard
    pipeline/    topic -> facts -> outline -> slides -> checks -> render -> queue
    voice/       tells, invented-experience, the bot-score reviewer
    verify/      claim -> quote -> stored document -> approved source
    rules/       pack niche rules + built-in compliance checks (e.g. Israeli investment advice)
    render/      fonts, theme -> CSS, slide templates, Chromium renderer, legibility
    images/      Pexels, Unsplash, Wikimedia Commons, recorded; license stored per image
    publish/     dry (default), Zernio
    metrics/     collect at 72h, score, recorded
    formats/     rotation, judge
    trends/      YouTube Shorts formats
    autonomy/    modes, safety rails, the runner (scheduler loop)
    onboarding/  source discovery from a seed, sample posts, new pack writer
    web/         server, auth, pages, one stylesheet, one small script
  examples/packs/demo/          the fictional demo pack (with its recordings)
  scripts/      dry run, web, demo, init-private, check-public, screenshots, record
  test/         node:test, every hard rule
  deploy/       systemd unit, Caddyfile example
  docs/         this plan, decisions, session log, screenshots, report

private/ ($OF_HOME)             never tracked
  packs/<id>/                   real packs, each with recordings/
  data/                         openfrequency.db, media/, out/
  .env                          keys
```

## The pack format

A pack is a folder of configuration. Adding an account never needs code.

| File | What it holds |
|---|---|
| `pack.json` | `id`, `displayName`, `handle`, `language`, `platforms`, `zernio` (profile id, account id per platform, privacy), `schedule` (windows, slots per platform, posts per day), `autonomy` (default mode), `budgetUsd` per month, `compliance` (built-in checks to enable), `topics` |
| `voice.md` | who is talking, to whom, register, examples of good and bad Hebrew lines (fed to the drafting model, and the bad lines are also a check) |
| `theme.json` | template (from the engine's library) and variant, colours, fonts, options. Validated to differ visibly from every other pack |
| `sources.json` | approved sources only: `id`, `type` (rss / web / api), `url`, `name`, `why` it is trusted, `approvedAt`, optional parser hints |
| `formats.json` | allowed post formats: id, Hebrew name, hook patterns, slide structure, item counts, approved closing lines, caption shape, hashtags, trend queries |
| `rules.json` | niche checks: banned phrases, regex checks, co-occurrence checks, image-query blocks, max quote length |
| `recordings/` | optional: recorded documents and drafts for offline runs |

## Data model (SQLite, one file)

| Table | Holds |
|---|---|
| `accounts` | one row per pack: runtime state (mode, status, paused reason, kill switch) |
| `sources` | per account: type, url, why, status (approved / pending / removed), origin (pack / discovered / manual), score |
| `documents` | every fetched document: source, url, title, text snapshot, sha256, fetched_at |
| `posts` | account, format, topic, status, slot, caption, hashtags, cost, platform results, review score |
| `slides` | post, index, kind, text, fact ids, image, rendered files |
| `facts` | post, claim (Hebrew), verbatim quote, document, source, verified, error |
| `steps` | post, step name, status, detail: the trace from slide back to source |
| `images` | provider, license, author, source url, AI-generated and realistic flags, local file |
| `metrics` | post, platform, collected_at, views, likes, comments, shares, saves (null when not given) |
| `formats` | account, format id, kind (proven / trial), status, weight, results, dropped why |
| `spend` | account (or none for global), api, model, units, usd, estimated flag, post, at |
| `edits` | the owner's edits to slide text, kept as style examples |
| `audit` | who did what, when |
| `settings` | global kill switch, global budget, and the like |
| `users` | login users (scrypt hashes), role |
| `onboarding` | a seed, its discovered candidates, approvals, sample posts |
| `trend_formats` | formats found on YouTube with their real numbers and link, never their content |

## The pipeline

`topic -> facts from approved sources -> outline -> slides -> voice and tell checks
-> fact verification -> render -> queue -> approval (by mode) -> publish -> metrics
at 72h -> learn`

Every step writes a `steps` row, so any post can be traced from a slide to the
fact, the quote, the stored document and the approved source.

## Hard rules, and where they live

1. **Platform rules**: `src/core/net.js` is the only module that calls `fetch`;
   its allowlist names every method, host and path. No social host has a write
   rule except Zernio's create-post. A test scans the code for any engagement
   function or endpoint.
2. **Distinct brands**: pack validation refuses shared templates, near-identical
   palettes, shared handles, Zernio profiles or display names, and a post that
   names another pack.
3. **Honest by construction**: `src/verify/` refuses an unsourced fact, a quote
   not in the stored document, a source that is not approved, a number not in the
   cited quote, invented experience, fake badges or metrics. The renderer refuses
   a post without a passed verification.
4. **AI disclosure**: images carry `aiGenerated` and `realistic`; the Zernio
   publisher sets `video_made_with_ai` where the API takes it, and otherwise
   posts as a draft for the label to be set in the app, with a caption line on
   platforms that have no flag.
5. **Rights**: images only from Pexels, Unsplash, Wikimedia Commons (or rendered
   in-house), with the license stored; Commons licenses on an allowlist; image
   queries checked against the pack's blocklist; quotes have a maximum length.
6. **Investment advice**: a built-in compliance check, enabled per pack, refuses
   recommending a specific stock, fund or investment; a pack whose topics are
   financial must enable it or it fails validation.
7. **Cost caps**: `src/budget/` guards every paid call against the account's and
   the global monthly cap; generation stops and the website says so.
8. **Hebrew RTL**: slides and every page are `dir="rtl" lang="he"`.
9. **Shabbat**: computed per date from sunset; the scheduler and the publisher
   both refuse a Shabbat slot.
10. **Secrets**: `.env`, `private/`, databases and media are gitignored;
    `npm run check:public` fails on keys, databases, real packs or real names in
    tracked files, and runs in `npm test` and as a pre-commit hook.

## Autonomy

- **Approve**: every post waits for the owner (the default for a new account).
- **Digest**: posts go out at their slot unless rejected before it.
- **Auto**: posts go out; a daily summary is written to the website.

Rails in every mode: a kill switch per account and a global one; auto-pause on a
failed fact check, a platform strike, a streak of publish errors, an exhausted
budget. A paused account shows why.

## The website

Hebrew, right to left, mobile first, light and dark, server-rendered with one
small script.

| Page | What it does |
|---|---|
| Login | single user now, users table ready for more |
| Today | posts waiting, grouped by account; swipeable slide preview; approve, reject or edit in one tap; tap a fact to see its quote and source |
| Post | the full trace: steps, facts, documents, checks, cost |
| Accounts | status, mode, budget used, kill switch, last 7 days |
| Results | per post and per format, winners and losers, what is being dropped and why |
| Sources | approve, remove or add sources per account |
| New account | the onboarding flow: seed, discovered sources to approve, sample posts (3 enough), go live |
| Settings | global kill switch, global budget, which keys are set (never their values), audit log |

## Phases

1. **Core**: engine, pack format, the first real pack (private) and the demo pack, dry run to disk with sources listed.
2. **Website**: login, Today, Accounts, previews, approve and reject, Approve mode end to end with the dry publisher, Zernio behind its interface.
3. **Learning and autonomy**: metrics, rotation, Digest and Auto, rails, budgets.
4. **Onboarding**: source discovery, sample posts, the other real packs (private), dry runs.
5. **Polish**: screenshots at phone and desktop width, performance, deploy files, docs.
