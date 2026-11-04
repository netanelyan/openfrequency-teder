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
   accounts says the workspace may use Teder (src/billing/entitlement.js, asked every 5 minutes, and at once when accounts
   records a payment and tells Teder, POST /internal/entitlement/changed).
2. There is no card payment yet. The customer pays as agreed (transfer or link), and the operator records it on
   accounts' `/admin`, on the workspace's Teder subscription: the month's payment moves `paid_until` on. Press it once:
   a second press records a second month (ACC-03 in the readiness audit).
3. The invoice is issued outside accounts, and its PDF uploaded to the workspace on `/admin`, where the customer sees
   it.
4. Recording the payment tells Teder at once: the customer's next page is Teder, and their paywall's "בדקו שוב" asks
   accounts too. The health table on /all shows the business as "שולם" once Teder has asked again (the customer's next
   page or the runner's next pass), at worst within 5 minutes. If it
   still says "לא שולם" or "לא ידוע", accounts did not answer Teder: check that accounts is up (`curl -s
   http://127.0.0.1:4741/healthz`) and that both services have the same `OF_INTERNAL_TOKEN`; a payment Teder was not told
   about is a `teder POST /internal/entitlement/changed` line in `pm2 logs of-accounts`.

## 2. Setup, the first day

1. The customer opens `/new` in Teder: a niche, a few example sites, the sources, a name, the days and times, and the
   networks: TikTok, Instagram and a Facebook Page. While the sources are searched they can already connect and choose
   times. Before the workspace has paid, the connect panel says "את החיבור לטיקטוק, לאינסטגרם ולפייסבוק עושים אחרי
   ההפעלה. כל השאר אפשר לסדר כבר עכשיו." instead.
2. Connecting is the panel "חיבור לטיקטוק, לאינסטגרם ולפייסבוק" on `/new` (later the same rows are on the account's
   page, "חשבון" in the menu). Each network has its own row and button: "לחבר את טיקטוק", "לחבר את אינסטגרם", "לחבר את
   פייסבוק". The button opens the network's own screen; they approve there and come back. At least one network has to
   be connected before anything goes out; Facebook is optional, and without a Page the slideshows go to TikTok and
   Instagram only (src/publish/hold.js). What is connected before the account exists moves to it when it is created.
3. **Facebook, choosing a Page.** Zernio posts to a Facebook Page, never to a personal profile, and the panel says so
   above the buttons: "בפייסבוק מחברים עמוד של העסק שאתם מנהלים. פרופיל אישי אי אפשר לחבר. אם לא מחברים עמוד, המצגות
   עולות רק לטיקטוק ולאינסטגרם." After "לחבר את פייסבוק" they sign in on Facebook's screen with the Facebook user that
   manages the business's Page and approve. Back in Teder (src/web/connect.js):
   - **One Page** they manage and may post on: it is connected by itself, and the page says "פייסבוק מחובר".
   - **Several:** Teder's own page "איזה עמוד פייסבוק לחבר?" ("<their Facebook name>, מצאנו כמה עמודים שאתם מנהלים.
     בוחרים את העמוד שאליו המצגות יעלו."), one button per Page with its name. Tapping one connects it: "<the Page's
     name> מחובר עכשיו. אפשר לסגור את הדף." The list works once and for 15 minutes; after that it says "הבחירה הזו
     כבר לא בתוקף" and they press "לחבר את פייסבוק" again.
   - **None:** "לא מצאנו עמוד פייסבוק". A Page Facebook lists without the task CREATE_CONTENT (publishing as the
     Page) is not offered (src/publish/zernio.js facebookPages). The page tells them to open a Page for the business
     in Facebook, or to ask whoever manages the Page for permission to post on it, and then connect again.
   The row then reads "פייסבוק" with "מחובר" and the Page's name. To switch to another Page, "לחבר חשבון אחר" on the
   same row goes through the same choice.
4. Watch the onboarding on `/new` (the operator sees every one, with "הערות למפעיל"). A search that keeps failing, or
   no sample posts, is explained in operator-notes.md.
5. When they go live, the account appears in the health table with its business.

## 3. The first week

Once a day, on /all:

- **"פוסט אחרון"** should say today or yesterday. Two days or more, or "אף פעם", is an account that drafts nothing. The
  operator also gets the alert "drafted nothing in 24 hours" with the reasons its posts were blocked (src/autonomy/
  runner.js nothingDrafted). Open the account's posts: a run of the same block reason (a source that changed, a model
  that refuses the niche) needs a source or a format changed. A slot that was blocked is drafted again the same day,
  once, while it is an hour and a half away or more; the rest wait for the next morning.
- **"נכשלו ב-7 ימים"**: a post that did not go out. Section 4.
- **"לחבר מחדש"**: a TikTok, an Instagram or a Facebook Page that needs connecting again. Section 5.
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

The health table names the account and the platform ("<account>: facebook" for a Page). The customer opens the
account's page in Teder ("חשבון" in the menu). The network's row says "צריך לחבר מחדש", with one line under it:
"החיבור ל<network> התנתק, ופוסטים לא מגיעים לשם עד שמחברים שוב." when Zernio no longer has the connection, otherwise
"<network> ביקש לאשר את החיבור מחדש. עד אז פוסטים לא מגיעים לשם." (the operator sees Zernio's own reason in its
place). They press the row's button, "לחבר מחדש את טיקטוק", "לחבר מחדש את אינסטגרם" or "לחבר מחדש את פייסבוק": the
network's own screen, then back.

- **Facebook** asks for the Page again, as in section 2: one Page is connected by itself, several are listed on
  "איזה עמוד פייסבוק לחבר?", and none is "לא מצאנו עמוד פייסבוק": the Facebook user they signed in with has no Page
  it may publish on, and the page tells them to open one for the business or ask whoever manages the Page for
  permission to post on it, then press the button again. To move the account to another Page, "לחבר חשבון אחר" on a
  connected row does the same.
- A connection Zernio no longer has counts as not connected: posts approved meanwhile go to the networks still
  connected, and with nothing connected they wait and go out at the account's next free slot once something is
  (src/publish/hold.js). One that only asks to be approved again is still sent to, and a post that fails there is
  section 4. A Facebook Page is optional: while none is connected, posts go to TikTok and Instagram with their Facebook
  part skipped, and no banner or email asks for it as long as the account posts anywhere else.

## 6. Every month

1. **Before the paid month ends:** record the next payment on accounts' `/admin` when it arrives. The paid month ends
   at the end of the Israel day `paid_until`, and the customer then has 72 hours to pay for the next one (the owner,
   2026-11-03; openfrequency-accounts src/accounts/subscriptions.js `GRACE_HOURS` and `graceLast`): Teder keeps working
   to the end of the third Israel day after `paid_until` (the fourth when the clocks go forward in those days, so it is
   never less than 72 hours). Meanwhile accounts answers `due`, still allowed, with that last moment as `graceUntil`,
   and the health table shows the business as "מחכה לתשלום".
   - **A workspace on the terms from before 2026-11-03** (accepted at sign-up before that day, or none recorded, as for
     one opened on `/admin`) keeps the old terms' 14 days, counted from the day the payment fell due, for every payment
     that falls due before its change date. The change date is the day after the 30 whole days that follow the day its
     owners were emailed the change (the terms promise 30 days' notice; the emails went on 3.11.2026, so 4.12.2026 for
     those workspaces), and it never moves. With the change date 4.12.2026: paid until 2.12, it works until 17.12; paid
     until 3.12, until 6.12. One on the old terms with no owner to email keeps the 14 days.
   - **The reminders.** By email to each owner, from accounts' daily run (09:00 Israel time, src/web/daily.js): a week
     before the payment falls due, on the paid month's last day, on the first day after it, and on the last day of the
     grace; then one more once it has stopped. The operator (`OF_SIGNUP_NOTIFY`) hears of each "due" and each
     stop. By WhatsApp from Toran, as the template `payment_reminder`, on three of those days (the paid month's last
     day, the first day after it and the grace's last day; never the week before, never the stop): to the owners'
     linked numbers and to the number the workspace last paid from, each number once, never after "הפסק", and only in
     manual payment mode with `OF_PAYMENT_METHOD` set. Until Meta approves the template every send is refused and the
     email goes alone (Toran's docs/whatsapp-templates.md said on 2026-11-04 that it was not created in WhatsApp
     Manager yet). And on Teder's dashboard, a banner at the top of every page of the workspace (src/web/
     ui.js payBanner): in the last 7 days paid for "המנוי לתדר שולם עד <date>." with "אפשר כבר לשלם על החודש הבא, כדי
     שתדר ימשיך לעבוד בלי הפסקה.", and during the 72 hours "החודש ששילמתם עליו נגמר, והתשלום על החודש הבא עוד לא הגיע
     אלינו." with "תדר ממשיך לעבוד עד סוף <day, date>, ואז ייעצר עד שהתשלום יגיע."; its button "איך משלמים" opens
     accounts' `/setup`. There is no banner for a complimentary, cancelled or switched-off workspace, nor for the
     operator or view-as.
   - **Once the grace is over** accounts answers unpaid: the health table shows "לא שולם", and Teder writes and
     publishes nothing for the workspace (nothing is deleted). Teder waits 3 days after the stop (`STOP_GRACE_DAYS`,
     src/billing/retention.js, counted from the first answer that stopped it), and its next daily pass then disconnects
     everything the workspace connected through Zernio (TikTok, Instagram and the Facebook Page) from our team and
     forgets those connections. Its Zernio profiles, posts, sources and settings stay. A payment recorded within the 3
     days keeps the connections; after them, once paid, the customer connects again from the account's page (section
     5).
2. **The plan:** the month's slideshows and redos reset on the 1st (src/budget/quota.js). A customer who ran out sees
   it on Settings.
3. **Zernio:** every connected TikTok or Instagram is a connected account on our Zernio team, billed per account
   (docs/costs.md). `npm run zernio:check` shows the count Zernio bills. Whether our Zernio plan caps the number of
   connected accounts is UNVERIFIED: check the plan on Zernio's dashboard (Billing) before the tenth customer.
4. **The alerts:** read the week's alerts under the table, and make sure the phone still gets them (a test alert:
   `sudo -u openfrequency /usr/local/bin/of-alert "test" "Teder"` on the VPS; the script comes from openfrequency-ops).
