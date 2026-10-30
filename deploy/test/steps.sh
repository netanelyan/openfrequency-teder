#!/usr/bin/env bash
# The README's "Deploying" steps, verbatim, on a clean Ubuntu 24.04 with systemd, in the release layout
# (docs/deploy-releases.md).
# Run as root inside the test container (deploy/test/run.sh does it). The two
# repositories are cloned from /repos/public.git and /repos/private.git, which
# stand in for GitHub; on the VPS they are the real remotes.
set -euo pipefail
step() { printf '\n==== %s\n' "$*"; }
# On any failure, show what the service said before the container goes away.
trap 'echo "FAILED at line $LINENO"; journalctl -u openfrequency -u caddy --no-pager -n 60 2>/dev/null | tail -60' ERR

step "1. Node 24 and Caddy, from their official repositories"
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq && apt-get install -y -qq caddy >/dev/null
node --version && caddy version | sed -n 1p

step "2. The service user, the two repositories, Chromium's system libraries"
useradd --system --create-home --home-dir /var/lib/openfrequency --shell /usr/sbin/nologin openfrequency
mkdir -p /opt/open-frequency/releases
git clone -q --mirror /repos/public.git /opt/open-frequency/repo.git
git clone -q /repos/private.git /opt/open-frequency/private
cd /opt/open-frequency
npx -y playwright install-deps chromium >/dev/null
# This container has Node from NodeSource at /usr/bin; the units and deploy.sh name the VPS's /opt/node24.
mkdir -p /opt/node24/bin && ln -sf "$(command -v node)" /opt/node24/bin/node && ln -sf "$(command -v npm)" /opt/node24/bin/npm
mkdir -p private/data
chown -R openfrequency:openfrequency private

step "3. private/.env, mode 600"
{
  printf '%s=%s\n' SESSION_SECRET "$(openssl rand -hex 32)"
  printf '%s=%s\n' OF_INTERNAL_TOKEN "$(openssl rand -hex 24)"
  printf '%s=%s\n' PUBLIC_HOST teder.test
  printf '%s=%s\n' MEDIA_PUBLIC_BASE_URL https://media.test
} > private/.env
chown openfrequency:openfrequency private/.env && chmod 600 private/.env

step "4. The systemd unit, the first release, and the site answering on 127.0.0.1"
git -C repo.git show main:deploy/openfrequency.service > /etc/systemd/system/openfrequency.service
systemctl daemon-reload
systemctl enable openfrequency
git -C repo.git show main:deploy/deploy.sh > /root/deploy.sh
bash /root/deploy.sh --first main
curl -fs -H 'Host: 127.0.0.1:4700' http://127.0.0.1:4700/healthz && echo ' <- /healthz'
curl -fs -H 'Host: 127.0.0.1:4700' http://127.0.0.1:4700/readyz && echo ' <- /readyz'
systemctl is-active openfrequency
readlink current

step "5. Caddy in front, with the example Caddyfile (local names and an internal certificate)"
sed -e 's/teder.example.com {/teder.test {\n\ttls internal/' -e 's/media.example.com {/media.test {\n\ttls internal/' current/deploy/Caddyfile.example >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null && echo 'caddy validate: ok'
systemctl reload caddy || systemctl restart caddy
sleep 2
curl -fsk --resolve teder.test:443:127.0.0.1 https://teder.test/healthz && echo ' <- https://teder.test/healthz through Caddy'
curl -sk --resolve teder.test:443:127.0.0.1 -o /dev/null -w '%{http_code} <- a page without a session through Caddy (303 to accounts'"'"' login)\n' https://teder.test/
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: teder.test' http://127.0.0.1:4700/)
echo "$code <- the public name over plain HTTP straight to the app (must be refused: 403)"
[ "$code" = 403 ]
mkdir -p private/data/public/t && echo hello > private/data/public/t/x.txt && chown -R openfrequency:openfrequency private/data/public
curl -fsk --resolve media.test:443:127.0.0.1 https://media.test/t/x.txt | grep -q hello && echo 'media.test serves private/data/public'

step "6. The nightly backup timer, and one backup now"
cp current/deploy/openfrequency-backup.service current/deploy/openfrequency-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now openfrequency-backup.timer
systemctl start openfrequency-backup.service
ls private/data/backups | tail -1
systemctl list-timers openfrequency-backup.timer --no-pager | sed -n 1,2p

step "7. The engine renders on this machine: recorded posts for each pack, as the service user"
# A dry run exits 2 when a post is blocked by the checks, which is the checks
# working: what this step proves is that Chromium renders Hebrew slides here.
for pack in $(ls private/packs); do
  (cd current && sudo -u openfrequency env OF_HOME=/opt/open-frequency/private PLAYWRIGHT_BROWSERS_PATH=/opt/open-frequency/.browsers npm run -s dry -- --pack "$pack" --count 2 | tail -2) || true
done
rendered=$(find private/data/dry-media -name 'tiktok-01.jpg' | wc -l)
echo "$rendered post(s) rendered"
[ "$rendered" -gt 0 ]

step "8. A restart keeps the service and the database"
systemctl restart openfrequency
sleep 3
systemctl is-active openfrequency
journalctl -u openfrequency --no-pager -n 5 | tail -3

step "9. A second deploy of the same commit, and a rollback with nowhere to go is refused"
bash current/deploy/deploy.sh main
if bash current/deploy/rollback.sh 2>/dev/null; then echo 'a rollback with no previous release ran'; exit 1; fi
echo 'rollback with no previous release: refused'
echo ALL STEPS PASSED
