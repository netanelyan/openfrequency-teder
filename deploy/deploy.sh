#!/usr/bin/env bash
# deploy/deploy.sh [<commit or branch>]       on the VPS, as root: deploy main (or the commit named)
# deploy/deploy.sh --first [<commit>]         the first release on a server that has none yet (docs/deploy-releases.md)
#
# Teder is deployed into a release folder of its own, and the service is pointed at it only once it is ready:
#
#   /opt/open-frequency/repo.git        a mirror of the server's own remote: fetched from, never run
#   /opt/open-frequency/releases/<sha>  one folder per commit: its files, its node_modules, REVISION
#   /opt/open-frequency/current         a link to the release the service runs (openfrequency.service)
#   /opt/open-frequency/private         keys, packs, the database, media: every release's, in no release
#   /opt/open-frequency/.browsers       Playwright's Chromium: every release's
#
# In order, and nothing is switched until every step before the switch has passed:
#   1. fetch, and build the release: git archive of the commit, REVISION, npm ci --omit=dev, Chromium for its
#      Playwright (downloaded only when it is not there yet)
#   2. scripts/schema-check.js from the new release: a build the database would refuse is never switched to
#   3. a backup of the database (scripts/backup.js), before the new build migrates anything
#   4. the switch (current -> the new release; the one it replaces is kept as .previous), and a restart
#   5. /readyz (the database and the runner, src/web/health.js) must answer 200 with the new commit within 60 seconds;
#      otherwise deploy/rollback.sh puts the previous release back
#   6. the 5 newest releases are kept, and never the current or the previous one is removed
#
# Deploy only a commit whose CI run (.github/workflows/test.yml) is green. RUN_TESTS=1 also runs the whole suite in the
# release before the switch (scripts/release-check.js): about 20 minutes and a Chromium on the shared server, so it is
# off unless asked.
#
# Everything here was checked on the server on 2026-10-29 (SERVER-FACTS.md at the root of the openfrequency folder):
# the folder, Node at /opt/node24/bin/node, the service user, OF_HOME, .browsers, and /readyz behind Host
# 127.0.0.1:4700. What was not is checked here before it is used, and stops the deploy with what to do.
set -euo pipefail

APP=/opt/open-frequency
REPO=$APP/repo.git
RELEASES=$APP/releases
NODE=/opt/node24/bin/node
UNIT=openfrequency
USER_=openfrequency
HOSTPORT=127.0.0.1:4700
KEEP=5

first=0
if [ "${1:-}" = "--first" ]; then first=1; shift; fi
want=${1:-main}

say() { printf '==== %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

# ---- what this needs, checked before anything is touched
[ "$(id -u)" = 0 ] || die "run as root (the release folders are root's; the service reads them)"
[ -x "$NODE" ] || die "$NODE is not there"
NPM=$(dirname "$NODE")/npm
[ -x "$NPM" ] || die "no npm beside $NODE (UNVERIFIED on the VPS: ls -l $NPM)"
for c in git tar curl runuser systemctl; do command -v "$c" >/dev/null || die "$c is not installed"; done
[ -d "$REPO" ] || die "no $REPO: the server still deploys from a plain checkout. The one-time move is in docs/deploy-releases.md"
id "$USER_" >/dev/null 2>&1 || die "no user $USER_"
if [ -L "$APP/current" ]; then
  [ "$first" = 0 ] || die "--first, but $APP/current already exists: deploy without --first"
else
  [ "$first" = 1 ] || die "$APP/current is not a link to a release: on a server that has none yet, run with --first (docs/deploy-releases.md)"
  [ -e "$APP/current" ] && die "$APP/current exists and is not a link: move it away first"
fi

# ---- 1. the release
say "1. fetch and build $want"
git -C "$REPO" remote update --prune >/dev/null
REV=$(git -C "$REPO" rev-parse --verify "$want^{commit}") || die "no such commit or branch: $want"
DEST=$RELEASES/$REV
mkdir -p "$RELEASES"
if [ ! -d "$DEST" ]; then
  rm -rf "$DEST.part"
  mkdir -p "$DEST.part"
  git -C "$REPO" archive "$REV" | tar -x -C "$DEST.part"
  echo "$REV" > "$DEST.part/REVISION"
  (cd "$DEST.part" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error)
  # The Chromium this release's Playwright wants, into the shared folder (nothing is downloaded when it is there).
  (cd "$DEST.part" && PLAYWRIGHT_BROWSERS_PATH=$APP/.browsers "$NODE" node_modules/playwright/cli.js install chromium >/dev/null)
  mv "$DEST.part" "$DEST"
fi
if [ "${RUN_TESTS:-0}" = 1 ]; then
  say "   the whole suite, in the release (RUN_TESTS=1)"
  (cd "$DEST" && PATH="$(dirname "$NODE"):$PATH" PLAYWRIGHT_BROWSERS_PATH=$APP/.browsers "$NODE" scripts/release-check.js) || die "the tests failed: nothing was switched"
fi

as_service() { runuser -u "$USER_" -- env OF_HOME="$APP/private" PLAYWRIGHT_BROWSERS_PATH="$APP/.browsers" "$NODE" "$@"; }

# ---- 2. would the database take it
say "2. schema check"
(cd "$DEST" && as_service scripts/schema-check.js) || die "the new release would refuse the database: nothing was switched"

# ---- 3. a backup before anything migrates
say "3. backup"
if [ -f "$APP/private/data/openfrequency.db" ]; then
  (cd "$DEST" && as_service scripts/backup.js --keep 14)
  BACKUP=$(ls -1t "$APP/private/data/backups"/openfrequency-*.db | head -1)
  echo "   $BACKUP"
else
  BACKUP=""
  echo "   no database yet"
fi

# ---- 4. the switch
say "4. switch to $REV and restart"
PREV=$(readlink "$APP/current" || true)
[ "$PREV" = "$DEST" ] && echo "   $REV is already the current release; restarting it"
ln -sfn "$DEST" "$APP/current.new"
mv -Tf "$APP/current.new" "$APP/current"
if [ -n "$PREV" ] && [ "$PREV" != "$DEST" ]; then echo "$PREV" > "$RELEASES/.previous"; fi
[ "$first" = 1 ] && systemctl daemon-reload
systemctl restart "$UNIT"

# ---- 5. ready, with the new commit, within 60 seconds
say "5. /readyz"
ready=0
for _ in $(seq 1 60); do
  if curl -fs -H "Host: $HOSTPORT" "http://$HOSTPORT/readyz" | grep -q "\"revision\":\"$REV\""; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "deploy: $REV did not answer /readyz within 60 seconds:" >&2
  curl -s -H "Host: $HOSTPORT" "http://$HOSTPORT/readyz" >&2 || true
  journalctl -u "$UNIT" --no-pager -n 30 >&2 || true
  if [ -n "$PREV" ] && [ "$PREV" != "$DEST" ]; then
    echo "deploy: putting $PREV back" >&2
    "$DEST/deploy/rollback.sh" "$PREV" || die "the rollback failed too. The backup taken before this deploy is ${BACKUP:-none}; docs/deploy-releases.md says how to restore it"
  fi
  die "$REV was not deployed"
fi

# ---- 6. keep the newest releases
say "6. releases kept"
keep_also=$(cat "$RELEASES/.previous" 2>/dev/null || true)
ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$DEST" ] || [ "$old" = "$keep_also" ] || rm -rf "$old"
done
ls -1dt "$RELEASES"/*/ | sed 's:/$::'
say "deployed $REV"
