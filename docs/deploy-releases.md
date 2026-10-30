# Deploying Teder in release folders, and rolling back

Teder used to be updated in its live folder: `git pull`, `npm ci`, restart. `npm ci` deletes `node_modules` while the
old process still runs, the update keeps no copy of the build before it, and going back meant finding the last good
commit by hand (PRA-OPS-004 in the readiness audit). Now each commit is built in a folder of its own, checked, backed
up before, switched to with one link, and checked again; a failed check puts the previous release back.

## The layout

```
/opt/open-frequency/repo.git          a mirror of the server's own git remote: fetched from, never run
/opt/open-frequency/releases/<sha>/   one per commit: its files, node_modules, REVISION (the commit)
/opt/open-frequency/releases/.previous  the release before the current one, for rollback.sh
/opt/open-frequency/current           a link to the release the service runs
/opt/open-frequency/private/          keys, packs, the database, media: in no release (unchanged)
/opt/open-frequency/.browsers/        Playwright's Chromium: in no release (unchanged)
```

`deploy/openfrequency.service` runs from `/opt/open-frequency/current`. Its `OF_HOME`, `PLAYWRIGHT_BROWSERS_PATH` and
`ReadWritePaths` are the same paths as before, so nothing under `private/` or `.browsers/` moves.

## Deploying (after the one-time move below)

On the VPS, as root, a commit whose CI run is green (.github/workflows/test.yml):

```bash
/opt/open-frequency/current/deploy/deploy.sh            # main
/opt/open-frequency/current/deploy/deploy.sh <commit>   # or a commit or branch
```

It fetches, builds the release, runs `scripts/schema-check.js` from it (a build the database would refuse is never
switched to), takes a backup (`scripts/backup.js`), switches, restarts, and waits up to 60 seconds for `/readyz` to
answer 200 with the new commit (the database answers and the runner ticks; src/web/health.js). If it does not, it runs
`deploy/rollback.sh` itself. It keeps the 5 newest releases. `RUN_TESTS=1` also runs the whole suite in the release
before the switch (about 20 minutes, and a Chromium, on the shared server).

Each deploy restarts the service, which closes the posts being drafted at that moment: deploy outside the morning's
generation.

## Rolling back

```bash
/opt/open-frequency/current/deploy/rollback.sh             # to the release before
/opt/open-frequency/current/deploy/rollback.sh <sha>       # or a release by its commit
```

A rollback cannot go back past a migration the newer build ran: the schema check refuses, and nothing is switched.
Then either deploy a fix forward, or restore the backup taken before that deploy (below).

## Restoring a backup

The database copies are in `/opt/open-frequency/private/data/backups/` (`openfrequency-<time>.db`, nightly and
before each deploy). To put one back, as root:

```bash
systemctl stop openfrequency
cd /opt/open-frequency/private/data
mv openfrequency.db openfrequency.db.bad-$(date +%Y%m%d-%H%M)
rm -f openfrequency.db-wal openfrequency.db-shm
cp backups/openfrequency-<time>.db openfrequency.db
chown openfrequency:openfrequency openfrequency.db && chmod 600 openfrequency.db
# then run the release that matches that copy (rollback.sh <sha>), or start the service on the current one
systemctl start openfrequency
```

Everything recorded after that copy (posts drafted, approvals, publishes) is lost from the database; what went out is
still on the platforms. UNVERIFIED that a restore has ever been run on this server: `ls -l
/opt/open-frequency/private/data/backups/` shows the copies, not that one restores. Do one restore drill on a copy, as
PRA-DB-003 asks, and write its date here.

## The one-time move of the live server

The live server runs from a plain checkout at `/opt/open-frequency` (SERVER-FACTS.md, 2026-10-29), with `private/` and
`.browsers/` inside it. The move leaves both where they are. **For the owner to approve; not done.** As root, in a quiet
hour:

```bash
cd /opt/open-frequency
# 0. what must already be true (each line should print without an error)
/opt/node24/bin/node --version                       # v24 (checked: v24.22.0)
ls -l /opt/node24/bin/npm                            # UNVERIFIED: npm beside that node
git -C /opt/open-frequency remote get-url origin     # the remote already there (checked 2026-10-29; SERVER-FACTS.md names it)
git -C /opt/open-frequency fetch --dry-run           # UNVERIFIED: that root can fetch from it
command -v tar runuser                               # UNVERIFIED on this server (both are in every Ubuntu install)
systemctl cat of-alert@.service                      # UNVERIFIED: the alert template from openfrequency-ops, installed

# 1. a mirror of the checkout, pointed at the same remote, and the releases folder
git clone --mirror /opt/open-frequency /opt/open-frequency/repo.git
git -C /opt/open-frequency/repo.git remote set-url origin "$(git -C /opt/open-frequency remote get-url origin)"
git -C /opt/open-frequency/repo.git remote update --prune
mkdir -p /opt/open-frequency/releases

# 2. keep the units as they are now, then install the new ones (WorkingDirectory=/opt/open-frequency/current)
mkdir -p /root/openfrequency-units-$(date +%Y%m%d)
cp /etc/systemd/system/openfrequency.service /etc/systemd/system/openfrequency-backup.service /root/openfrequency-units-$(date +%Y%m%d)/
git -C /opt/open-frequency/repo.git show main:deploy/openfrequency.service > /etc/systemd/system/openfrequency.service
git -C /opt/open-frequency/repo.git show main:deploy/openfrequency-backup.service > /etc/systemd/system/openfrequency-backup.service
# The memory limits in openfrequency.service are commented out until the owner settles them (the proposal is
# MemoryHigh=900M, MemoryMax=1100M, against a measured peak of 713 MB).

# 3. the first release, from main; deploy.sh reloads systemd, restarts and checks /readyz
git -C /opt/open-frequency/repo.git show main:deploy/deploy.sh > /root/deploy-first.sh
bash /root/deploy-first.sh --first main

# 4. check
readlink /opt/open-frequency/current
curl -s -H 'Host: 127.0.0.1:4700' http://127.0.0.1:4700/healthz; echo
curl -s -H 'Host: 127.0.0.1:4700' http://127.0.0.1:4700/readyz; echo
systemctl start openfrequency-backup.service && journalctl -u openfrequency-backup.service -n 5 --no-pager
```

If step 3 fails, go back to the checkout as it was:

```bash
cp /root/openfrequency-units-<date>/openfrequency*.service /etc/systemd/system/
systemctl daemon-reload && systemctl restart openfrequency
rm -f /opt/open-frequency/current
```

After the move, the checkout's own files at `/opt/open-frequency` (src/, node_modules/, and the rest that git tracks)
are no longer run. They can stay; removing them is a later choice, and must never touch `private/`, `.browsers/`,
`releases/`, `repo.git` or `current`.
