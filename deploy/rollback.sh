#!/usr/bin/env bash
# deploy/rollback.sh [<release folder or commit>]     on the VPS, as root
#
# Put a release that ran before back: the one deploy/deploy.sh recorded as .previous, or the one named. It is checked
# first, like a new one: scripts/schema-check.js from that release says whether the database would take it. A
# rollback cannot go back past a migration the newer build ran (the older build does not know the table it added);
# then nothing is switched, and the choices are to deploy a fix forward, or to restore the backup deploy.sh took
# before that deploy (docs/deploy-releases.md, "Restoring a backup"). Then the switch, a restart, and /readyz must
# answer 200 with that release's commit within 60 seconds.
set -euo pipefail

APP=/opt/open-frequency
RELEASES=$APP/releases
NODE=/opt/node24/bin/node
UNIT=openfrequency
USER_=openfrequency
HOSTPORT=127.0.0.1:4700

die() { printf 'rollback: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

target=${1:-$(cat "$RELEASES/.previous" 2>/dev/null || true)}
[ -n "$target" ] || die "no previous release recorded: name one (ls -1dt $RELEASES/*/)"
[ -d "$target" ] || target=$RELEASES/$target
[ -d "$target" ] || die "no release $target"
[ -f "$target/REVISION" ] || die "$target has no REVISION: not a release deploy.sh built"
REV=$(cat "$target/REVISION")
current=$(readlink "$APP/current" || true)
[ "$current" = "$target" ] && die "$target is already the current release"

echo "==== schema check of $REV"
(cd "$target" && runuser -u "$USER_" -- env OF_HOME="$APP/private" "$NODE" scripts/schema-check.js) || die "the database would refuse $REV: nothing was switched"

echo "==== switch to $REV and restart"
ln -sfn "$target" "$APP/current.new"
mv -Tf "$APP/current.new" "$APP/current"
[ -n "$current" ] && echo "$current" > "$RELEASES/.previous"
systemctl restart "$UNIT"

for _ in $(seq 1 60); do
  if curl -fs -H "Host: $HOSTPORT" "http://$HOSTPORT/readyz" | grep -q "\"revision\":\"$REV\""; then
    echo "==== rolled back to $REV"
    exit 0
  fi
  sleep 1
done
journalctl -u "$UNIT" --no-pager -n 30 >&2 || true
die "$REV did not answer /readyz within 60 seconds"
