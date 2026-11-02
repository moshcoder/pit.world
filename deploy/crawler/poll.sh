#!/usr/bin/env bash
# Deploy-on-merge for pitbot: when main moves, rebuild and restart the crawler.
# Runs from cron as the box's user (no root needed), e.g. every 5 minutes:
#
#   */5 * * * * ~/www/pit-crawler/app/deploy/crawler/poll.sh >> ~/www/pit-crawler/poll.log 2>&1
#
# Layout: ~/www/pit-crawler/{app (a checkout of moshcoder/pit.world), crawler.env (0600)}.
set -euo pipefail

ROOT=${PIT_CRAWLER_ROOT:-$HOME/www/pit-crawler}
APP=$ROOT/app
cd "$APP"

git fetch -q origin main
want=$(git rev-parse origin/main)
have=$(git rev-parse HEAD)
if [ "$want" = "$have" ] && [ "${1:-}" != "--force" ]; then exit 0; fi

echo "$(date -u +%FT%TZ) deploying ${want:0:12} (was ${have:0:12})"
git reset -q --hard "$want"
docker compose -f deploy/crawler/docker-compose.yml --env-file "$ROOT/crawler.env" -p pit-crawler up -d --build --remove-orphans

# Up and answering, or say so loudly.
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8807/healthz >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) ${want:0:12} healthy"
    exit 0
  fi
  sleep 3
done
echo "$(date -u +%FT%TZ) ${want:0:12} NOT healthy after 60 s" >&2
docker compose -p pit-crawler logs --tail 40 crawler >&2 || true
exit 1
