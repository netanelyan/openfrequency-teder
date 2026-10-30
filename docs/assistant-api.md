# Teder and the WhatsApp assistant

The OpenFrequency WhatsApp assistant (openfrequency-toran) lets a customer run their posts from WhatsApp: see what
waits, approve, reject, fix a slide's text, ask where they stand, and get told when something happens. Teder owns the
posts; the assistant owns the conversation and the phone numbers. They talk server to server, on the same VPS, and
nothing here is reachable from outside it.

- **Requests** go from the assistant to Teder's internal API, `/internal/assistant/*` (`src/assistant/api.js`).
- **Events** go from Teder to the assistant, `POST $OF_TORAN_URL` (`src/assistant/events.js`), default
  `http://127.0.0.1:4710/internal/teder/events`.

Both directions are signed with one shared secret, `OF_ASSISTANT_SECRET` in `private/.env` on both sides (32
characters or more: `openssl rand -hex 32`). Without it the API answers 503 and no events are found or sent.

## Who the customer is

A customer is a **workspace**, by the id openfrequency-accounts gives it. Every route names one:
`/internal/assistant/customers/:workspaceId/...`. A request works on that workspace's accounts and nothing else: a post
of another workspace is `404 not_found`, the same answer as a post that never existed, and so is a workspace with no
accounts here.

Teder trusts the assistant to say which customer it acts for and which person in it. The assistant holds the secret
and binds a phone number to a person in a workspace on its side. Every change names that person in `by`, and Teder
records it as theirs, via WhatsApp:

- in the post's trace (a `whatsapp` step: the action, the person, the slide), shown on the post's page
- in the audit log (the person as the actor, `via: "whatsapp"` in the detail)
- for an edit, in `edits` with `by.userId`, as an edit on the website is

```json
{ "by": { "name": "דנה", "userId": 101 } }
```

`name` is required (1 to 80 characters), `userId` (openfrequency-accounts' user id) is optional.

## Signing

Every request to Teder, and every event Teder sends, carries:

```
X-OF-Signature: t=<unix seconds>,n=<nonce>,s=<hex HMAC-SHA256>
```

The HMAC, keyed by the secret, is over these six lines joined by `\n`:

```
<direction>   toran->teder for a request, teder->toran for an event
<t>           the same t as in the header
<nonce>       16 to 64 of [A-Za-z0-9_-], new for every message
<METHOD>      GET or POST, upper case
<path>        the path with its query string, exactly as sent
<sha256>      the SHA-256 of the body bytes, hex (of the empty string for a GET)
```

Teder refuses a request:

| error | when |
|---|---|
| `bad_signature` (401) | no header, a malformed one, or an HMAC that does not match: another secret, another direction, another path or customer, another body |
| `stale` (401) | `t` is more than 300 seconds from Teder's clock, either way |
| `replay` (401) | the nonce was seen in the last 10 minutes. Nonces are kept in the database, so a restart does not forget them. A nonce is kept only after its signature checks out |

The direction line means an event Teder signed cannot be sent back to Teder as a request.

### Never public

Teder answers `/internal/assistant/*` only for a request straight from this machine: a loopback socket, a `Host` of
`127.0.0.1:<port>` or `localhost:<port>`, and none of the headers a proxy adds (`X-Forwarded-For`, `Forwarded`,
`X-Real-IP`, `X-Forwarded-Host`, `X-Forwarded-Proto`). Anything else gets `404 not_found`, as if the path did not exist.
Caddy also refuses `/internal/*` (`deploy/Caddyfile.example`). Both of those come before the signature check.

## Slide images

Every image in an answer or an event is a signed link that expires:

```
https://<PUBLIC_HOST>/m/<post>/<tiktok|instagram>/<index>?e=<unix expiry>&s=<hex>
```

It opens one rendered slide, needs no session, and works for 24 hours (answers carry `linksExpireAt`). It goes
through the public name so WhatsApp can download the image. Without `PUBLIC_HOST` (a laptop) the links are
`http://127.0.0.1:<PORT>/m/...`. A link is tied to its post, platform and slide: change any part, or wait past `e`, and
it is a 404. Ask again for fresh links.

## Requests

All answers are JSON. A refusal is `{ "ok": false, "error": "<code>", "message": "..." }`. When a refusal comes from
one of the website's own checks (an edit the fact check stopped), `message` is the Hebrew line the website shows, and
`problems` lists what was found.

### `GET /customers/:ws/posts/pending`

Every post of the customer's accounts that waits for their decision, the soonest slot first.

```json
{
  "ok": true, "customer": 7, "linksExpireAt": "2026-10-28T08:00:00.000Z",
  "posts": [{
    "id": "mh1abc...", "status": "queued",
    "account": { "id": "plants", "name": "...", "handle": "..." },
    "coverLine": "...", "slotAt": "2026-10-27T15:30:00.000Z",
    "caption": "...",
    "slides": [{ "n": 1, "kind": "cover", "title": "", "body": "", "image": "https://.../m/..." }]
  }]
}
```

`n` counts from 1, as a person counts slides. The edit below takes the same number.

### `POST /customers/:ws/posts/:id/approve`

`{ by }`. The post must be waiting (`409 wrong_state` otherwise). The same as Approve on the website, including a
draft-now account's TikTok draft going to the app at once. Answers `{ ok, message, post: { id, status } }`.

### `POST /customers/:ws/posts/:id/reject`

`{ by, reason, freeText }`. `reason` is one of `topic`, `shorter`, `tone`, `photo`, `other`; `freeText` is the
customer's own words (300 characters at most), which the replacement's writer reads.

The website's rules apply (`src/budget/quota.js`). While the month has redos left, a replacement is written with that
reason and counted as a redo once it reaches the customer, never as a suggestion. When the redos are used up, the post
is only discarded. A replacement our checks block is our retry, not their redo.

```json
{ "ok": true, "message": "...", "post": { "id": "...", "status": "rejected" },
  "redo": "writing", "quota": { "month": "2026-10", "suggestions": { ... }, "redos": { "used": 0, "held": 1, "limit": 10, "left": 9 } } }
```

`redo` is `writing` (the replacement is being written: a `post.ready` follows when it is done), `none` (the redos are
used up), `paused` (the account cannot write now, so no redo was used), or `sample`. While it is written the
replacement holds its redo (`held`), so two quick rejections cannot both use the last one.

### `POST /customers/:ws/posts/:id/edit`

`{ by, slide, newText, field }`: a light edit of one slide's text. Slide 1 is the cover: its `field` is `hook` (the
headline, the default) or `sub` (the line under it). A content slide's is `body` (the default) or `title`. The closing
slide is not edited (`422 not_editable`). Lengths: hook 90, sub 120, title 80, body 300 (`422 too_long` with `max`).

It is the website's edit with every other text as it was: checked in code, the changed text fact-checked (the one
model call, billed as an edit check, never a redo), and the slides drawn again. Nothing is saved when a check stops
it (`422 refused`, with `problems`). Answers the post as `pending` shows it, with fresh links to the new slides. An
approved post's old TikTok draft stays in the app and a new one goes, as on the website.

### `GET /customers/:ws/status`

```json
{ "ok": true, "customer": 7, "accounts": [{
  "account": { "id": "plants", "name": "...", "handle": "..." },
  "quota": { "month": "2026-10",
             "suggestions": { "used": 12, "held": 0, "limit": 40, "left": 28 },
             "redos": { "used": 3, "held": 0, "limit": 10, "left": 7 } },
  "next": [{ "id": "...", "coverLine": "...", "slotAt": "...", "status": "approved" }],
  "week": { "from": "...", "to": "...", "published": 9, "views": 48210,
            "best": { "id": "...", "coverLine": "...", "views": 15002, "publishedAt": "..." } },
  "connections": [{ "platform": "tiktok", "state": "connected", "username": "...", "issue": null, "checkedAt": "...", "url": null }]
}] }
```

`week` is the last seven days, by when posts went out. `views` adds each platform's newest reading per post, and is
null while none was read. `next` is up to five posts with a slot still ahead. `connections` is each platform's
connection, as below, without links.

### `GET /customers/:ws/accounts/:id/connect`

The account's TikTok, Instagram and Facebook Page (each platform the account posts to), and for each one that is not
connected or stopped working, the link to send the customer ("tap here to connect"). A Page is optional: posts go to
TikTok and Instagram without one, so a Page not connected is worth offering, never worth a reminder. Another
workspace's account is `404 not_found`.

```json
{ "ok": true, "account": { "id": "plants", "name": "...", "handle": "..." }, "linksExpireAt": "...",
  "platforms": [
    { "platform": "tiktok", "state": "none", "username": "", "issue": null, "checkedAt": null, "url": "https://<teder>/connect/plants/tiktok?e=...&s=..." },
    { "platform": "instagram", "state": "meta", "username": "", "issue": null, "checkedAt": null, "url": null } ] }
```

`state` is `connected`, `reconnect` (Zernio says the token expired or was revoked, or a permission is missing:
`issue` says which, in Zernio's words), `none`, or `meta` (Instagram, published through Teder's own Meta app: nothing
to connect). `url` is set for `none` and `reconnect` while Zernio is configured, else null.

The link opens Teder, not Zernio: Zernio's own connect link works for 30 minutes, so Teder asks for a fresh one at the
tap and sends the browser on. It opens for 72 hours, for that account and platform only, and needs no sign-in. Whoever
holds it can connect an account there until it expires, so send it to the customer alone. Zernio's welcome screen comes
first, then TikTok's, Instagram's or Facebook's consent screen (for Facebook, then Teder's own page to pick the Page,
when the customer manages more than one), then a page of Teder's saying whether it connected. What is
connected is read from Zernio, never from that page's address. A reconnect connects the same account again, and its
history is kept.

### `GET /customers/:ws/posts/:id/bundle`

For a customer who posts by hand: per platform the post goes to, the slides, the caption (with the photo credits, without
hashtags), the hashtags, and `text`, all of it as it would go out. A Facebook Page's are Instagram's slides and caption. Only for an approved, publishing or published post
(`409 not_approved` otherwise).

```json
{ "ok": true, "linksExpireAt": "...", "post": { "id": "...", "account": { ... }, "status": "approved", "coverLine": "...",
  "slotAt": "...", "aiLabel": true,
  "platforms": { "tiktok": { "images": ["..."], "caption": "...", "hashtags": ["#..."], "text": "..." } } } }
```

### `GET` and `POST /customers/:ws/settings`

The customer's choices: which events reach them, and their quiet hours.

```json
{ "ok": true, "customer": 7,
  "events": { "post.ready": true, "post.reminder": true, "post.published": true, "post.unposted": true, "quota.low": true, "weekly.summary": true, "account.reconnect": true },
  "quiet": { "nights": true, "shabbat": true } }
```

The POST takes `{ by, events, quiet }`, each part optional and each value `true` or `false`, and answers the choices
as saved. The customer can set the same on Teder's Settings page.

## Events

One JSON body per event, signed with the direction `teder->toran`, with `X-OF-Event: <type>`:

```json
{ "id": "evt_123", "type": "post.reminder", "at": "<when Teder found it>", "sentAt": "<this attempt>", "customer": 7, "data": { ... } }
```

`id` stays the same across retries: dedupe on it. Answer with any 2xx. Anything else, or no answer within 10 seconds,
is tried again after 1, 5, 15, 60 and 180 minutes, then given up (`failed`). While one send fails, nothing else is
sent that minute. A `400` is a refusal of that event (a type or a shape the assistant does not take): it is given up at
once and the rest go on, so an assistant that does not know `account.reconnect` yet refuses it without holding the
queue. `401`, `403`, `408` and `429` wait like a server error.

| type | when | data |
|---|---|---|
| `post.ready` | a post reached the customer and waits for them (a redo's replacement too) | `post` (as `pending` shows it), `redoOf` |
| `post.reminder` | its slot came, and it is not out | `post`, `delivery`, `platforms`, `sound` |
| `post.published` | it is out: on TikTok when it goes there (the customer's own post found, or the fallback's), else on every platform | `post`, `platforms`, `tiktokUrl` |
| `post.unposted` | 60 minutes after the slot it is still not out | `post`, `delivery`, `platforms`, `minutesLate` |
| `quota.low` | 8 suggested slideshows left this month (once a month per account) | `account`, `quota` |
| `weekly.summary` | Sunday at 09:00 Israel time, one per customer | `from`, `to`, `accounts: [{ account, week, quota }]` |
| `account.reconnect` | Zernio says a TikTok or Instagram the customer connected stopped working (Teder reads it hourly), once per break | `account`, `platform`, `username`, `issue`, `connectUrl`, `linkExpiresAt` |

`delivery` is `drafts` (the post waits in the TikTok app's drafts, with `sound` to add) or `by_hand` (it never reached
TikTok: the customer posts it themselves, from the bundle). `platforms` says where each platform stands: `out`,
`drafts`, `by_hand`, `failed` or `waiting`.

A post published dry (no publisher configured) is not out: it waits for the customer, so it gets `post.unposted` an
hour on unless something says they posted it.

**What is true when it goes.** An event is found from the database at the runner's tick and written once (by its key:
`post.ready:<post>`, `weekly.summary:<ws>:<date>`). Its body is built when it is sent, not when it was found, so the
links are fresh, and an event that is no longer true by then is dropped: a `post.ready` for a post approved on the
website meanwhile, or a reminder for a post that went out or is past its hour (the `post.unposted` covers it). Each
event is also worth sending only for so long (a reminder 3 hours, unposted 14, published 24, ready 48, quota.low 7
days, the summary and a reconnect 3 days). A reconnect fixed before it goes is dropped too. Past that it expires unsent.

**Quiet hours.** With `quiet.nights`, nothing is sent from 22:00 to 08:00 Israel time. With `quiet.shabbat`, nothing
from before candle lighting to after nightfall on Shabbat and on the festivals (the same windows Teder never posts in,
`src/schedule/shabbat.js`). What comes up then is held and sent when they end, if it is still true and not past its
time.

**Off.** A type the customer turned off is recorded as off when it is found and never sent, even if they turn it back
on later. Turning a type on applies to what happens from then.

Only accounts in a workspace have a customer to tell; an account in no workspace sends nothing.

## The network

Teder reaches the assistant through `localFetch` (`src/core/net.js`), which refuses every host but the loopback. Teder
itself never talks to WhatsApp, and the network door's rules for the social platforms are unchanged.
