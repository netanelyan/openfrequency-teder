// The schema, as an append-only list of migrations. Never edit a shipped entry:
// add a new one. PRAGMA user_version records how many have run.
//
// Times are ISO strings in UTC. Money is US dollars as REAL. JSON columns are
// TEXT and end in _json.

export const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,              -- the pack id
    display_name  TEXT NOT NULL,
    handle        TEXT NOT NULL,
    mode          TEXT NOT NULL DEFAULT 'approve' CHECK (mode IN ('approve','digest','auto')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','onboarding')),
    paused_reason TEXT,                          -- 'kill' | 'fact_check' | 'strike' | 'publish_errors' | 'budget' | 'manual'
    paused_detail TEXT,
    paused_at     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE sources (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    key           TEXT NOT NULL,                 -- the id in sources.json, or a generated one
    type          TEXT NOT NULL CHECK (type IN ('rss','web','api')),
    url           TEXT NOT NULL,
    name          TEXT NOT NULL,
    why           TEXT,
    lang          TEXT,
    status        TEXT NOT NULL CHECK (status IN ('approved','pending','removed')),
    origin        TEXT NOT NULL CHECK (origin IN ('pack','discovered','manual')),
    approved_at   TEXT,
    score_json    TEXT,                          -- authority, freshness, terms, reason
    config_json   TEXT,                          -- parser hints, api kind
    last_ok_at    TEXT,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    UNIQUE (account_id, key)
  );

  CREATE TABLE documents (
    id            INTEGER PRIMARY KEY,
    source_id     INTEGER NOT NULL REFERENCES sources(id),
    key           TEXT,                          -- the recording's key, when it came from one
    url           TEXT NOT NULL,
    title         TEXT,
    text          TEXT NOT NULL,                 -- the snapshot every quote is checked against
    sha256        TEXT NOT NULL,
    published_at  TEXT,
    fetched_at    TEXT NOT NULL,
    recorded      INTEGER NOT NULL DEFAULT 0,    -- 1 when it came from a recording
    UNIQUE (source_id, sha256)
  );
  CREATE INDEX documents_source ON documents(source_id, fetched_at);

  CREATE TABLE posts (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    format_id     TEXT,
    topic         TEXT,
    hook          TEXT,
    sub           TEXT,
    status        TEXT NOT NULL,                 -- drafting | blocked | queued | approved | rejected | expired | publishing | published | failed | sample
    reason        TEXT,                          -- why blocked / rejected / failed
    slot_at       TEXT,
    caption       TEXT,
    hashtags_json TEXT,
    checks_json   TEXT,                          -- voice, tells, review, verify, rules, render
    review_score  REAL,
    cost_usd      REAL NOT NULL DEFAULT 0,
    cost_estimated INTEGER NOT NULL DEFAULT 0,
    media_json    TEXT,                          -- rendered files per platform
    publish_json  TEXT,                          -- per platform result
    ai_label      INTEGER NOT NULL DEFAULT 0,
    mode_at_queue TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    approved_at   TEXT,
    approved_by   TEXT,
    published_at  TEXT,
    sample        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX posts_account ON posts(account_id, status, slot_at);

  CREATE TABLE slides (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    idx           INTEGER NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('cover','item','closer')),
    title         TEXT,
    body          TEXT,
    fact_ids_json TEXT,
    image_id      INTEGER REFERENCES images(id),
    files_json    TEXT,
    UNIQUE (post_id, idx)
  );

  CREATE TABLE facts (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    key           TEXT NOT NULL,                 -- the draft's own id for it (f1, f2...)
    claim         TEXT NOT NULL,
    quote         TEXT NOT NULL,
    document_id   INTEGER REFERENCES documents(id),
    source_id     INTEGER REFERENCES sources(id),
    verified      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    UNIQUE (post_id, key)
  );

  CREATE TABLE steps (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    step          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('ok','failed','skipped','info')),
    detail_json   TEXT,
    cost_usd      REAL NOT NULL DEFAULT 0,
    at            TEXT NOT NULL
  );
  CREATE INDEX steps_post ON steps(post_id, id);

  CREATE TABLE images (
    id            INTEGER PRIMARY KEY,
    provider      TEXT NOT NULL,                 -- pexels | unsplash | commons | rendered
    provider_id   TEXT,
    license       TEXT NOT NULL,
    license_url   TEXT,
    author        TEXT,
    author_url    TEXT,
    source_url    TEXT,
    alt           TEXT,
    query         TEXT,
    ai_generated  INTEGER NOT NULL DEFAULT 0,
    realistic     INTEGER NOT NULL DEFAULT 0,
    file          TEXT,
    sha256        TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE metrics (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform      TEXT NOT NULL,
    collected_at  TEXT NOT NULL,
    age_hours     REAL,
    views         INTEGER,
    likes         INTEGER,
    comments      INTEGER,
    shares        INTEGER,
    saves         INTEGER,                       -- null when the platform does not report it (TikTok)
    raw_json      TEXT,
    UNIQUE (post_id, platform, collected_at)
  );

  CREATE TABLE formats (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    format_key    TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('proven','trial')),
    status        TEXT NOT NULL CHECK (status IN ('active','dropped')),
    weight        REAL NOT NULL DEFAULT 1,
    own           INTEGER NOT NULL DEFAULT 1,
    results_json  TEXT NOT NULL DEFAULT '[]',
    dropped_why   TEXT,
    dropped_at    TEXT,
    promoted_at   TEXT,
    returned_at   TEXT,
    UNIQUE (account_id, format_key)
  );

  CREATE TABLE spend (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT,                          -- null: engine-wide (onboarding, trends)
    post_id       TEXT,
    api           TEXT NOT NULL,
    model         TEXT,
    units         REAL NOT NULL DEFAULT 1,
    usd           REAL NOT NULL,
    estimated     INTEGER NOT NULL DEFAULT 0,
    tag           TEXT,
    month         TEXT NOT NULL,                 -- Israel month, YYYY-MM
    at            TEXT NOT NULL
  );
  CREATE INDEX spend_month ON spend(month, account_id);

  CREATE TABLE edits (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT NOT NULL,
    account_id    TEXT NOT NULL,
    slide_idx     INTEGER,
    field         TEXT NOT NULL,
    before        TEXT,
    after         TEXT,
    user_id       INTEGER,
    at            TEXT NOT NULL
  );

  CREATE TABLE audit (
    id            INTEGER PRIMARY KEY,
    at            TEXT NOT NULL,
    actor         TEXT NOT NULL,                 -- 'engine' or a user name
    action        TEXT NOT NULL,
    account_id    TEXT,
    post_id       TEXT,
    detail_json   TEXT
  );
  CREATE INDEX audit_at ON audit(at);

  CREATE TABLE settings (
    key           TEXT PRIMARY KEY,
    value_json    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','editor','viewer')),
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE onboarding (
    id            TEXT PRIMARY KEY,
    seed_json     TEXT NOT NULL,
    status        TEXT NOT NULL,                 -- discovering | review | samples | ready | live | abandoned
    pack_id       TEXT,
    candidates_json TEXT NOT NULL DEFAULT '[]',
    notes_json    TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE trend_formats (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL,
    platform      TEXT NOT NULL,
    url           TEXT NOT NULL,
    views         INTEGER,
    likes         INTEGER,
    comments      INTEGER,
    published_at  TEXT,
    card_json     TEXT,                          -- the shape, never the content
    status        TEXT NOT NULL,                 -- kept | rejected
    why           TEXT,
    found_at      TEXT NOT NULL,
    UNIQUE (account_id, url)
  );

  CREATE TABLE summaries (
    id            INTEGER PRIMARY KEY,
    day           TEXT NOT NULL,                 -- Israel date
    account_id    TEXT,
    text          TEXT NOT NULL,
    data_json     TEXT,
    at            TEXT NOT NULL,
    UNIQUE (day, account_id)
  );
  `,
  `
  -- Money held for calls still in flight. guard() counts it with what was spent,
  -- so concurrent and batched calls cannot together cross a cap.
  CREATE TABLE reservations (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT,
    post_id       TEXT,
    usd           REAL NOT NULL,
    tag           TEXT,
    month         TEXT NOT NULL,
    at            TEXT NOT NULL
  );
  CREATE INDEX reservations_month ON reservations(month, account_id);

  -- What each Claude call really used, as the API reported it, and whether it
  -- went through the Message Batches API (half price).
  ALTER TABLE spend ADD COLUMN batch INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE spend ADD COLUMN usage_json TEXT;

  -- Message batches sent to Anthropic, kept until every request in them is
  -- recorded, so a restart in the middle of a batch still records what it cost.
  CREATE TABLE batches (
    id            TEXT PRIMARY KEY,              -- Anthropic's batch id
    status        TEXT NOT NULL,                 -- in_progress | ended | recorded
    requests_json TEXT NOT NULL,                 -- custom_id -> { account_id, post_id, model, tag, reservation }
    counts_json   TEXT,
    created_at    TEXT NOT NULL,
    ended_at      TEXT,
    recorded_at   TEXT
  );

  -- Answers from paid or quota-limited lookups (Brave, YouTube search), reused
  -- until they expire: discovery runs weekly and reads the cache first.
  CREATE TABLE lookups (
    key           TEXT PRIMARY KEY,
    value_json    TEXT NOT NULL,
    at            TEXT NOT NULL,
    expires_at    TEXT NOT NULL
  );

  -- Instagram reports reach as well as views.
  ALTER TABLE metrics ADD COLUMN reach INTEGER;

  -- A document built from hand-checked facts stops being evidence after the
  -- earliest expiry date of the facts in it.
  ALTER TABLE documents ADD COLUMN expires_at TEXT;
  `,
  `
  -- The content model: a post has a kind (story, head-to-head, ...), a group
  -- (entertaining or number), the cover pattern it followed, a shorter caption
  -- for Instagram, and post-level data (the two sides, the answer, the date, the
  -- keywords, the call to action). A slide has a role in its kind, and data (the
  -- two values of a head-to-head stat).
  ALTER TABLE posts ADD COLUMN kind TEXT;
  ALTER TABLE posts ADD COLUMN grp TEXT;
  ALTER TABLE posts ADD COLUMN hook_pattern TEXT;
  ALTER TABLE posts ADD COLUMN caption_ig TEXT;
  ALTER TABLE posts ADD COLUMN data_json TEXT;
  ALTER TABLE slides ADD COLUMN role TEXT;
  ALTER TABLE slides ADD COLUMN data_json TEXT;

  -- Documents that are read together (two articles for a head-to-head).
  ALTER TABLE documents ADD COLUMN group_key TEXT;

  -- What the image screen found: ok, review (a person must look first) or
  -- refused, and who looked.
  ALTER TABLE images ADD COLUMN safety TEXT;
  ALTER TABLE images ADD COLUMN safety_json TEXT;
  ALTER TABLE images ADD COLUMN reviewed_by TEXT;
  ALTER TABLE images ADD COLUMN reviewed_at TEXT;

  -- Takedown notices: each one deletes its post; repeated ones pause the account.
  CREATE TABLE takedowns (
    id            INTEGER PRIMARY KEY,
    post_id       TEXT REFERENCES posts(id),
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    platform      TEXT,                          -- tiktok | instagram | null (both)
    claimant      TEXT,
    notice        TEXT NOT NULL,
    received_at   TEXT NOT NULL,
    recorded_by   TEXT,
    deleted_json  TEXT,                          -- per platform: deleted | by_hand | not_published | failed
    created_at    TEXT NOT NULL
  );
  CREATE INDEX takedowns_account ON takedowns(account_id, received_at);

  -- Events an account follows (a fight card), read from a public listing.
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    key           TEXT NOT NULL,                 -- the listing's own name for it
    name          TEXT NOT NULL,
    day           TEXT NOT NULL,                 -- YYYY-MM-DD, the event's local date
    main_event    TEXT,                          -- "A vs. B"
    venue         TEXT,
    url           TEXT,
    source_id     INTEGER REFERENCES sources(id),
    updated_at    TEXT NOT NULL,
    UNIQUE (account_id, key)
  );
  `,
  `
  -- Development answers from the Claude Code CLI cost nothing; each is recorded
  -- with what the same call would cost through the API as production sends it.
  ALTER TABLE spend ADD COLUMN api_usd REAL;

  -- The vision check of a picture against the slide it is for: what the model
  -- saw, and whether it shows what the slide says.
  ALTER TABLE images ADD COLUMN match_json TEXT;
  ALTER TABLE images ADD COLUMN categories TEXT;

  -- A fact found by the research step: the kind of detail it is (a quote, the
  -- minute, the moment, the backstory, what came after, a number).
  ALTER TABLE facts ADD COLUMN detail TEXT;

  -- The documents a source gave on its last read, and for which day: read again
  -- only after six hours, or for another day.
  ALTER TABLE sources ADD COLUMN last_docs_json TEXT;
  `,
  `
  -- What a post led people to do, where the platform reports it: taps on the
  -- link in the bio after seeing it, follows and profile visits (Instagram's
  -- media insights). Null when the platform did not say.
  ALTER TABLE metrics ADD COLUMN link_clicks INTEGER;
  ALTER TABLE metrics ADD COLUMN follows INTEGER;
  ALTER TABLE metrics ADD COLUMN profile_visits INTEGER;

  -- The morning's feedback: each post of the last three days on views against
  -- the account's own median, and on what it led people to do.
  CREATE TABLE feedback (
    id            INTEGER PRIMARY KEY,
    day           TEXT NOT NULL,                 -- Israel date
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    report_json   TEXT NOT NULL,                 -- the posts, their boxes, the baselines, the measure
    text          TEXT NOT NULL,
    at            TEXT NOT NULL,
    UNIQUE (day, account_id)
  );

  -- What the feedback asks of the next posts: one row per post to make. Open
  -- until a slot takes it; a new morning's report replaces the open ones.
  CREATE TABLE directives (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    day           TEXT NOT NULL,
    post_id       TEXT REFERENCES posts(id),     -- the post the result is about
    platform      TEXT,
    box           TEXT NOT NULL CHECK (box IN ('hh','hl','lh','ll')),
    action        TEXT NOT NULL,
    plan_json     TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('open','used','expired')),
    used_post_id  TEXT,
    created_at    TEXT NOT NULL,
    used_at       TEXT
  );
  CREATE INDEX directives_account ON directives(account_id, status);

  ALTER TABLE posts ADD COLUMN directive_id INTEGER;
  `,
  `
  -- The rivals an account's owner watches, typed in by hand (the engine never
  -- reads another account): their best cover lines, formats, posting times and
  -- the gaps they leave. Planning input for the writer.
  CREATE TABLE rivals (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    handle        TEXT NOT NULL,
    platform      TEXT NOT NULL CHECK (platform IN ('tiktok','instagram')),
    hooks_json    TEXT NOT NULL,
    formats_json  TEXT NOT NULL,
    times_json    TEXT NOT NULL,
    gaps          TEXT,
    updated_at    TEXT NOT NULL,
    updated_by    TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX rivals_account ON rivals(account_id);
  `,
  `
  -- The trending sounds the owner picked for an account's TikTok drafts, typed in
  -- by hand (no API reaches TikTok's viral sounds): one is named with each draft.
  CREATE TABLE sounds (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    name          TEXT NOT NULL,
    artist        TEXT NOT NULL,
    link          TEXT,
    added_at      TEXT NOT NULL,
    added_by      TEXT
  );
  CREATE INDEX sounds_account ON sounds(account_id);

  -- What the engine told the owner (a draft to publish, a reminder, a fallback,
  -- a duplicate), kept whether or not a browser was there to show it.
  CREATE TABLE notifications (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT,
    post_id       TEXT,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    url           TEXT,
    created_at    TEXT NOT NULL,
    pushed        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notifications_at ON notifications(created_at);

  -- The owner's browsers that asked for notifications (Web Push subscriptions).
  CREATE TABLE push_subs (
    id            INTEGER PRIMARY KEY,
    endpoint      TEXT NOT NULL UNIQUE,
    user_id       INTEGER,
    created_at    TEXT NOT NULL,
    failed        INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- An attributed fact: what someone said or reported (src/verify/claims.js),
  -- named as the document names them (who) and as the slide writes it (who_he).
  ALTER TABLE facts ADD COLUMN who TEXT;
  ALTER TABLE facts ADD COLUMN who_he TEXT;
  `,
  `
  -- Topics before documents (src/topics): what people are looking at (a Wikipedia spike, a Short's views) and what
  -- the owner knows went viral (the bank), each scored for how hard it stops a scroll before any post is outlined.
  CREATE TABLE topics (
    id            INTEGER PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES accounts(id),
    origin        TEXT NOT NULL CHECK (origin IN ('bank','wikipedia','youtube')),
    key           TEXT NOT NULL,                 -- one candidate once: wiki:<lang>:<title>:<week>, yt:<video>, bank:<n>
    title         TEXT NOT NULL,                 -- what it is about, as found or as the owner typed it
    why           TEXT,                          -- why it is a candidate: why it went viral, the spike, the views
    url           TEXT,                          -- where it went viral or was seen; never a fact's source
    signal_json   TEXT,                          -- the numbers behind it: views, the spike's ratio
    angle         TEXT,                          -- the post's topic in Hebrew, from the scoring
    terms_json    TEXT,                          -- what to search the approved sources for
    score         REAL,                          -- 0 to 10: how hard it stops a scroll
    score_json    TEXT,                          -- the five parts and the reason
    status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','ready','low','used','unsupported','skipped','removed')),
    note          TEXT,                          -- why it was skipped or found unsupported
    post_id       TEXT,
    created_at    TEXT NOT NULL,
    scored_at     TEXT,
    expires_at    TEXT,
    UNIQUE (account_id, key)
  );
  CREATE INDEX topics_ready ON topics(account_id, status);
  ALTER TABLE posts ADD COLUMN topic_id INTEGER;
  `,
  `
  -- The login moved to openfrequency-accounts (src/web/accounts.js): an account belongs to one workspace there, and
  -- a session sees only its workspace's accounts. NULL is no workspace: only the operator (the superadmin outside
  -- view-as) sees it, until npm run workspace:assign gives it one. A browser's push subscription is its workspace's;
  -- NULL is the operator's. The users table and its passwords go: accounts owns who people are.
  ALTER TABLE accounts ADD COLUMN workspace_id INTEGER;
  CREATE INDEX accounts_workspace ON accounts(workspace_id);
  ALTER TABLE onboarding ADD COLUMN workspace_id INTEGER;
  ALTER TABLE push_subs ADD COLUMN workspace_id INTEGER;
  DROP TABLE users;
  `,
  `
  -- A store's demo (src/demos): a store asked for one on openfrequency.co.il (POST /internal/lead), Teder read its
  -- catalogue, chose a topic from its field, read Wikipedia on it, wrote one slideshow that ends on the store, and
  -- drew it on the store's own photographs. The operator reviews it
  -- on /demos, and an approved one is the store's page at /s/<slug>. A demo is no account and belongs to no workspace:
  -- only the operator sees it, until the store becomes a customer.
  CREATE TABLE demos (
    id            INTEGER PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,          -- /s/<slug>: the store's name in Latin letters and a random tail
    url           TEXT NOT NULL,                 -- the store's homepage, as asked for
    domain        TEXT NOT NULL,
    whatsapp      TEXT,                          -- the number that asked, 9725XXXXXXXX
    origin        TEXT NOT NULL DEFAULT 'website',
    status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','building','ready','failed','approved','removed')),
    error         TEXT,                          -- why it is not ready: the store could not be read, the slides failed
    store_json    TEXT,                          -- { name, currency, accent }
    topic_json    TEXT,                          -- { niche, angle, articles, products }: what the slideshow is about
    docs_json     TEXT,                          -- [{ key, url, title, text }]: the store's catalogue and the articles,
                                                 -- what every fact quotes word for word
    post_json     TEXT,                          -- { hook, sub, caption, slides, facts, token }
    media_json    TEXT,                          -- { tiktok: [file], instagram: [file], bg: file }
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    approved_at   TEXT,
    approved_by   TEXT
  );
  CREATE INDEX demos_domain ON demos(domain);
  `,
  `
  -- A customer's month (src/budget/quota.js): how many slideshows it is suggested, how many rejected ones are written
  -- again, and the most its posts may cost. NULL is the default (40, 10, $12); the operator sets another per account.
  ALTER TABLE accounts ADD COLUMN plan_suggested INTEGER;
  ALTER TABLE accounts ADD COLUMN plan_redos INTEGER;
  ALTER TABLE accounts ADD COLUMN cap_usd REAL;

  -- What a post was to the customer: a suggestion (it passed every check and reached them), a redo (it replaced a post
  -- they rejected, redo_of) or a retry (our checks blocked it: our cost, never theirs). quota_month is the Israel month
  -- it reached them in. reject_json is why they rejected it and what became of it ({ reason, note, redo, replacement }).
  ALTER TABLE posts ADD COLUMN quota_kind TEXT CHECK (quota_kind IN ('suggestion','redo','retry'));
  ALTER TABLE posts ADD COLUMN quota_month TEXT;
  ALTER TABLE posts ADD COLUMN redo_of TEXT;
  ALTER TABLE posts ADD COLUMN reject_json TEXT;
  CREATE INDEX posts_quota ON posts(account_id, quota_month, quota_kind);

  -- The posts made before this: every one that reached the customer was a suggestion, every blocked one ours. The
  -- month is read from created_at three hours ahead of UTC (Israel's summer clock), close enough for a month's count.
  UPDATE posts SET quota_kind = 'suggestion', quota_month = strftime('%Y-%m', created_at, '+3 hours')
    WHERE sample = 0 AND status NOT IN ('drafting','blocked','sample');
  UPDATE posts SET quota_kind = 'retry', quota_month = strftime('%Y-%m', created_at, '+3 hours')
    WHERE sample = 0 AND status = 'blocked';
  `,
  `
  -- The WhatsApp assistant (openfrequency-toran, src/assistant): every signed request's nonce, kept a little longer
  -- than a signature lives, so the same request is refused the second time even across a restart.
  CREATE TABLE assistant_nonces (
    nonce         TEXT PRIMARY KEY,
    at            TEXT NOT NULL
  );
  CREATE INDEX assistant_nonces_at ON assistant_nonces(at);

  -- What Teder tells the assistant: one row per event, found from the posts (src/assistant/events.js) and sent,
  -- signed, when the customer's quiet hours allow. key makes each event once (post.ready:<post>, weekly.summary:<ws>:<day>).
  -- state: pending | sent | off (the customer turned the type off) | stale (no longer true when its turn came) |
  -- expired | failed. data_json is what the payload is built from at sending, never the payload itself.
  CREATE TABLE assistant_events (
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    type          TEXT NOT NULL,
    workspace_id  INTEGER NOT NULL,
    account_id    TEXT,
    post_id       TEXT,
    data_json     TEXT,
    state         TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    not_before    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    sent_at       TEXT
  );
  CREATE INDEX assistant_events_due ON assistant_events(state, not_before);

  -- A customer's choices for the assistant: which events reach them, and their quiet hours. No row is the default:
  -- every event, and quiet at night and on Shabbat.
  CREATE TABLE assistant_prefs (
    workspace_id  INTEGER PRIMARY KEY,
    events_json   TEXT NOT NULL,
    quiet_nights  INTEGER NOT NULL DEFAULT 1,
    quiet_shabbat INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL,
    updated_by    TEXT
  );
  `,
  `
  -- The operator's dashboard on Toran reads every demo (GET /internal/demos, src/web/demos.js): when it was ready,
  -- when it was taken down, and how often its page was opened. ready_at is when it last passed every check (a demo
  -- built before this is ready when it was approved); removed_at is when the operator took it down, from the audit
  -- log where it says, else its last change.
  ALTER TABLE demos ADD COLUMN ready_at TEXT;
  ALTER TABLE demos ADD COLUMN removed_at TEXT;
  UPDATE demos SET ready_at = approved_at WHERE approved_at IS NOT NULL;
  UPDATE demos SET removed_at = COALESCE((SELECT MAX(at) FROM audit WHERE action = 'demo_removed' AND json_extract(detail_json, '$.id') = demos.id), updated_at)
    WHERE status = 'removed';
  -- One row per view of a store's page (/s/<slug>, the page itself, not its pictures) by someone not signed in to
  -- OpenFrequency. visitor is a random id the page's own cookie carries for a year; never the address.
  CREATE TABLE demo_opens (
    id            INTEGER PRIMARY KEY,
    demo_id       INTEGER NOT NULL REFERENCES demos(id),
    visitor       TEXT NOT NULL,
    at            TEXT NOT NULL
  );
  CREATE INDEX demo_opens_demo ON demo_opens(demo_id, at);
  `,
  `
  -- Zernio, per customer account (src/publish/connect.js): the account's own Zernio profile, made on demand, and what
  -- the customer connected into it. pack.json's zernio.profileId and zernio.accounts (typed in by hand before this)
  -- are read when there is no row, and copied in the first time.
  ALTER TABLE accounts ADD COLUMN zernio_profile_id TEXT;

  -- One row per account and platform once anything was connected. status: connected | reconnect (Zernio says the
  -- token expired or was revoked, or a permission is missing: the customer connects again, the same account keeps
  -- its history). Read from Zernio after a connect and once an hour, never from what a browser says.
  CREATE TABLE zernio_connections (
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    platform          TEXT NOT NULL CHECK (platform IN ('tiktok','instagram')),
    zernio_account_id TEXT NOT NULL,
    username          TEXT,
    status            TEXT NOT NULL CHECK (status IN ('connected','reconnect')),
    issue             TEXT,
    broken_at         TEXT,                      -- when it last went from connected to reconnect: one message per break
    connected_at      TEXT NOT NULL,
    checked_at        TEXT NOT NULL,
    PRIMARY KEY (account_id, platform)
  );

  -- What Zernio billed for one account's profile in one month (YYYY-MM, the month the ledger counts): its share of Zernio's
  -- usage-based invoice, as Zernio splits it per profile, read once a day and replaced. Outside the monthly cap on
  -- Claude and the other metered APIs (src/budget/ledger.js): it is a subscription, shown next to them.
  CREATE TABLE zernio_costs (
    account_id    TEXT NOT NULL,
    month         TEXT NOT NULL,
    profile_id    TEXT NOT NULL,
    usd           REAL NOT NULL,
    read_at       TEXT NOT NULL,
    PRIMARY KEY (account_id, month)
  );
  `,
  `
  -- The budget is gone (docs/decisions.md, "The budget is gone, the plan is the limit"): no monthly cap, no share per
  -- account, no cost cap per customer, and so no money held for calls in flight. What every call cost is still recorded
  -- in spend. An account a cap paused writes again: a customer's month is its plan alone (40 suggestions, 10 redos).
  DROP TABLE reservations;
  ALTER TABLE accounts DROP COLUMN cap_usd;
  DELETE FROM settings WHERE key = 'globalBudgetUsd' OR key LIKE 'budget:%';
  UPDATE accounts SET status = 'active', paused_reason = NULL, paused_detail = NULL, paused_at = NULL
    WHERE status = 'paused' AND paused_reason IN ('budget', 'customer_cap');
  `,
  `
  -- What a new account's owner set up while its sources were searched (src/onboarding/setup.js): the name and handle,
  -- the days and times, and the Zernio profile made for the onboarding with what was connected into it. Applied to the
  -- account when it is created: the choice to schedule:<account>, the profile and connections to the account's own.
  ALTER TABLE onboarding ADD COLUMN setup_json TEXT NOT NULL DEFAULT '{}';
  `,
  `
  -- facebook-page: a customer's Facebook Page is connected through Zernio like their TikTok and Instagram
  -- (src/publish/connect.js), so a connection's platform may be facebook. SQLite cannot change a CHECK in place: the
  -- table is made again with every row it had.
  CREATE TABLE zernio_connections_next (
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    platform          TEXT NOT NULL CHECK (platform IN ('tiktok','instagram','facebook')),
    zernio_account_id TEXT NOT NULL,
    username          TEXT,
    status            TEXT NOT NULL CHECK (status IN ('connected','reconnect')),
    issue             TEXT,
    broken_at         TEXT,
    connected_at      TEXT NOT NULL,
    checked_at        TEXT NOT NULL,
    PRIMARY KEY (account_id, platform)
  );
  INSERT INTO zernio_connections_next (account_id, platform, zernio_account_id, username, status, issue, broken_at, connected_at, checked_at)
    SELECT account_id, platform, zernio_account_id, username, status, issue, broken_at, connected_at, checked_at FROM zernio_connections;
  DROP TABLE zernio_connections;
  ALTER TABLE zernio_connections_next RENAME TO zernio_connections;
  `,
];
