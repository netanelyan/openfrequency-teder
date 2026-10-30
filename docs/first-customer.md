# The first customer, and every month after

What the operator does, in order, from a business signing up to its second month, and what to do when a post fails or
a connection breaks. Where to look first, always: **/all**, signed in as the operator (the superadmin outside
view-as). Under the accounts it has the table "מצב הלקוחות": one line per business (workspace) with whether it has
paid, its failed posts of the last 7 days, the connections to make again, what was blocked today, its paused accounts,
and how long since anything reached the customer. Under it, the alerts of the week (src/notify/operator.js), the same
ones that went to the operator's phone through `/usr/local/bin/of-alert`.

Technical notes about keys and errors are in [operator-notes.md](operator-notes.md); this page is the routine.

## 1. Sign-up and payment

1. The business signs up on accounts (`/signup?p=teder`) and confirms its email. Teder shows them the paywall until
   accounts says the workspace may use Teder (src/billing/entitlement.js, asked every 5 minutes).
2. There is no card payment yet. The customer pays as agreed (transfer or link), and the operator records it on
   accounts' `/admin`, on the workspace's Teder subscription: the month's payment moves `paid_until` on. Press it once:
   a second press records a second month (ACC-03 in the readiness audit).
3. The invoice is issued outside accounts, and its PDF uploaded to the workspace on `/admin`, where the customer sees
   it.
4. Within 5 minutes the health table on /all shows the business as "שולם". If it still says "לא שולם" or "לא ידוע",
   accounts did not answer Teder: check that accounts is up (`curl -s http://127.0.0.1:4741/healthz`) and that both
   services have the same `OF_INTERNAL_TOKEN`.

## 2. Setup, the first day

1. The customer opens `/new` in Teder: a niche, a few example sites, the sources, a name, the days and times, TikTok and
   Instagram. While the sources are searched they can already connect and choose times.
2. Watch the onboarding on `/new` (the operator sees every one, with "הערות למפעיל"). A search that keeps failing, or
   no sample posts, is explained in operator-notes.md.
3. When they go live, the account appears in the health table with its business.

## 3. The first week

Once a day, on /all:

- **"פוסט אחרון"** should say today or yesterday. Two days or more, or "אף פעם", is an account that drafts nothing. The
  operator also gets the alert "drafted nothing in 24 hours" with the reasons its posts were blocked (src/autonomy/
  runner.js nothingDrafted). Open the account's posts: a run of the same block reason (a source that changed, a model
  that refuses the niche) needs a source or a format changed. A slot that was blocked is drafted again the same day,
  once, while it is an hour and a half away or more; the rest wait for the next morning.
- **"נכשלו ב-7 ימים"**: a post that did not go out. Section 4.
- **"לחבר מחדש"**: a TikTok or Instagram that needs connecting again. Section 5.
- **"נחסמו היום"**: posts the checks stopped. A few are normal (that is the fact gate working); most of a day is not.
- **"מושהים"**: an account paused by a kill switch, a platform strike, a run of publish errors or takedowns. The
  reason is on its Accounts page.

The first TikTok posts land in the customer's TikTok drafts on purpose (they add a popular sound and post). Make sure
they know where to find them, and that a reminder comes at the slot.

## 4. A post that failed

The customer sees it on the post's page with the reason in Hebrew, and gets an email ("didn't go out"). The operator
sees the publisher's own message in the post's trace ("איך הפוסט נוצר").

- A refusal from the platform (a policy strike) pauses the account. Read the platform's reason before resuming it.
- An expired or revoked token pauses it too: the customer connects again (section 5), then resumes.
- Anything else (a network failure, Zernio busy): try it again from the post's page once the cause is gone. A platform
  that already went out is never sent twice.

## 5. A connection to make again

The health table names the account and the platform. The customer opens the account's page in Teder and presses
"לחבר מחדש" (TikTok or Instagram's own screen, then back). Posts approved meanwhile wait, and go out at the account's
next free slot once something is connected (src/publish/hold.js).

## 6. Every month

1. **Before the paid month ends:** record the next payment on accounts' `/admin` when it arrives. Access ends the day
   after `paid_until`; there is no grace period yet (ACC-01 in the readiness audit). The health table shows the
   business as "לא שולם" from then, and Teder writes and publishes nothing for it (nothing is deleted).
2. **The plan:** the month's slideshows and redos reset on the 1st (src/budget/quota.js). A customer who ran out sees
   it on Settings.
3. **Zernio:** every connected TikTok or Instagram is a connected account on our Zernio team, billed per account
   (docs/costs.md). `npm run zernio:check` shows the count Zernio bills. Whether our Zernio plan caps the number of
   connected accounts is UNVERIFIED: check the plan on Zernio's dashboard (Billing) before the tenth customer.
4. **The alerts:** read the week's alerts under the table, and make sure the phone still gets them (a test alert:
   `sudo -u openfrequency /usr/local/bin/of-alert "test" "Teder"` on the VPS; the script comes from openfrequency-ops).
