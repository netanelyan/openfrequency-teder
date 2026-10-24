# Moving Teder onto openfrequency-accounts

Teder no longer has a login of its own. It reads accounts' session cookie and asks
accounts who it belongs to (`src/web/accounts.js`); every account (pack) belongs to one
workspace, and a session sees only its workspace's (`src/web/workspace.js`). This page
is the one-time switch on the VPS: the workspace **OpenFrequency** (`openfrequency`,
Teder on, Toran off), its owner `natikyan153+of@gmail.com`, and the three accounts
accounts (packs) moved into it, named below as `<PACKS>`.

The superadmin (`natikyan153@gmail.com`) and the owner (`natikyan153+of@gmail.com`)
are two different users in accounts. Accounts keeps the address as written (it only
trims and lowercases it), so `+of` stays, and the two are never merged. Gmail delivers
both to the same inbox. The owner must be a separate user because a superadmin ignores
memberships: signed in as the superadmin, Teder shows the operator's view of every
workspace, not the OpenFrequency workspace as its customer sees it.

Paths are the VPS's: Teder in `/opt/open-frequency` (systemd `openfrequency`, user
`openfrequency`, Node in `/opt/node24`), accounts in `/opt/openfrequency-accounts`
(pm2 `of-accounts`).

```sh
RUN="sudo -u openfrequency env PATH=/opt/node24/bin:$PATH OF_HOME=/opt/open-frequency/private OF_ENV=prod"
```

## Before you start: two checks

**Accounts answers on this machine.**

```sh
curl -s http://127.0.0.1:4741/healthz        # {"ok":true}
```

**Teder is served as `teder.openfrequency.co.il`.** The session cookie is for
`.openfrequency.co.il` only, and accounts sends people back only to addresses on
`*.openfrequency.co.il`. On 2026-10-16 Teder was at `teder.netanelyan.me`. If it still
is, then before step 3:

- add a DNS A record for `teder.openfrequency.co.il` pointing at the VPS;
- copy Teder's Caddy block with the new name, then run `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`. You can keep the old name as a `redir https://teder.openfrequency.co.il{uri}`;
- in step 3, set `PUBLIC_HOST=teder.openfrequency.co.il`.

`MEDIA_PUBLIC_BASE_URL` (the slides) does not change.

## 1. Back up Teder's database

The old Teder is still running, and its database is untouched so far.

```sh
cd /opt/open-frequency
$RUN /opt/node24/bin/node scripts/backup.js
ls -la private/data/backups/ | tail -3     # the newest file, from now, and not 0 bytes
```

Keep the printed file name: rolling back means stopping Teder and copying this file over
`private/data/openfrequency.db`. The new Teder adds the workspace columns and drops the
old `users` table, with its password hashes, when it first opens the database. The backup
is the only copy of the old database.

## 2. The workspace, in accounts

In a browser signed in as the superadmin, open `https://accounts.openfrequency.co.il/admin`
and create a workspace:

| Field | Value |
|---|---|
| Name | `OpenFrequency` |
| Slug | `openfrequency` |
| Owner email | `natikyan153+of@gmail.com` |
| Products | Teder on, Toran off |

That sends the invite (good for 72 hours). Open it from the Gmail inbox **in a private
window**, or after signing out of the superadmin. A browser carries one accounts session
at a time, and the invite should start the owner's session, not change the superadmin's.

Then read the workspace's id, and check the owner, the role and the products. This only
reads, and is safe while accounts runs:

```sh
cd /opt/openfrequency-accounts
sudo /opt/node24/bin/node -e "
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('private/data/accounts.db', { readOnly: true });
console.log(d.prepare(\"SELECT id, slug, name, disabled_at FROM workspaces WHERE slug = 'openfrequency'\").get());
console.log(d.prepare(\"SELECT p.product, p.enabled FROM workspace_products p JOIN workspaces w ON w.id = p.workspace_id WHERE w.slug = 'openfrequency'\").all());
console.log(d.prepare(\"SELECT u.id, u.email, u.is_superadmin, m.role FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN workspaces w ON w.id = m.workspace_id WHERE u.email LIKE 'natikyan153%'\").all());
"
```

Expected:

- one workspace, `disabled_at: null`. Note its `id`; it is called `<ID>` below;
- `teder` with `enabled: 1`, and no `toran` row (or `toran` with `enabled: 0`);
- two users: `natikyan153@gmail.com` with `is_superadmin: 1` and no role, and `natikyan153+of@gmail.com` with `is_superadmin: 0` and role `client_owner`. If the `+of` user is missing, the invite has not been accepted yet.

## 3. The new Teder, stopped while the accounts move

```sh
sudo systemctl stop openfrequency
cd /opt/open-frequency
sudo git pull
sudo env PATH=/opt/node24/bin:$PATH npm ci --omit=dev
sudo -u openfrequency nano private/.env
```

In `private/.env`:

- **add** `OF_INTERNAL_TOKEN=` with exactly the same value as `OF_INTERNAL_TOKEN` in `/opt/openfrequency-accounts/private/.env`. Use `sudo grep OF_INTERNAL_TOKEN /opt/openfrequency-accounts/private/.env` to read it;
- **remove** `OF_ADMIN_USER` and `OF_ADMIN_PASSWORD`;
- **keep** `SESSION_SECRET`. It now signs only the forms' CSRF tokens;
- leave `OF_ACCOUNTS_INTERNAL` and `OF_ACCOUNTS_URL` out (the defaults are `http://127.0.0.1:4741` and `https://accounts.openfrequency.co.il`);
- `PUBLIC_HOST=teder.openfrequency.co.il` (see the check at the top).

## 4. A dry run: what would move

```sh
$RUN /opt/node24/bin/node scripts/workspace-assign.js --workspace <ID> <PACKS> --dry-run
```

This opens the database read-only, so it does not even run the migration. It prints one
line per account and changes nothing. Expect:

```
dry run on /opt/open-frequency/private/data/openfrequency.db (opened read-only; nothing is written)
  the workspace column does not exist yet: the real run adds it first (the migration), then:
  <pack>: no workspace -> workspace <ID>
a real run would change N account(s)
```

If a line says `REFUSED`, stop and read it. It could be an account name that does not
exist, or an account already in another workspace.

## 5. The move

```sh
$RUN /opt/node24/bin/node scripts/workspace-assign.js --workspace <ID> <PACKS>
$RUN /opt/node24/bin/node scripts/workspace-assign.js --list
```

The real run refuses to start without a backup from the last 24 hours (step 1). It
changes all three accounts or none, and writes each change to Teder's audit log
(`workspace_assigned`). `--list` should show all three accounts in `workspace <ID>`. Running
it twice is harmless: the second time each account is "already in workspace <ID>".

## 6. Start Teder and look

```sh
sudo systemctl start openfrequency
sudo journalctl -u openfrequency -n 20 --no-pager
```

If the log says `OF_INTERNAL_TOKEN is not set`, go back to step 3. If it says
`In no workspace yet`, a pack exists that is not in the workspace. It is visible only to the
superadmin until you assign it.

Then, in the private window where `natikyan153+of@gmail.com` is signed in, open
`https://teder.openfrequency.co.il`:

- the three accounts are in the switcher, and nothing else;
- Settings says you are signed in as `natikyan153+of@gmail.com`, in the `OpenFrequency` workspace. It has no kill switch and no "when posts are written": those are the operator's;
- notifications: turn them on again on each phone and browser (Settings, then התראות). A browser that subscribed before the switch is kept as the operator's and still gets a push for every account. Turning notifications on again moves it into the workspace.

In the superadmin's browser, the same address shows the operator's view: every workspace, the
server's settings and developer mode.

Without a session, `https://teder.openfrequency.co.il` goes to
`https://accounts.openfrequency.co.il/login?next=…` and back after signing in.

## Rolling back

```sh
sudo systemctl stop openfrequency
cd /opt/open-frequency
sudo git checkout <the commit before the switch>
sudo env PATH=/opt/node24/bin:$PATH npm ci --omit=dev
sudo cp private/data/backups/<the file from step 1> private/data/openfrequency.db
sudo rm -f private/data/openfrequency.db-wal private/data/openfrequency.db-shm
sudo chown openfrequency:openfrequency private/data/openfrequency.db
sudo systemctl start openfrequency
```

The backup still has the old `users` table, so the old login works again with the old
password. `OF_ADMIN_USER` and `OF_ADMIN_PASSWORD` are not needed for that.

Anything Teder recorded between the switch and the rollback (posts drafted, approvals,
metrics) is in the newer database, not in the backup. Copy the newer file aside before
overwriting it.
