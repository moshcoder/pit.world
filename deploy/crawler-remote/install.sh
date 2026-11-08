#!/usr/bin/env bash
# pitbot on a second box, natively (no Docker): N fetch-only page workers and, with
# --index, the publish role (local search index + page archive + the API pit.world reads).
# Idempotent: re-run to change the worker count. System units need sudo; --user writes
# systemd user units instead (no sudo; needs `loginctl enable-linger`, e.g. dev3).
#
#   bash install.sh --workers 8 --index
#
# Reaches dev2's Redis and the site frontier through the tunnel dev2 keeps open
# (deploy/crawler-remote/tunnel.sh on dev2): 127.0.0.1:6396 is dev2's Redis and
# 127.0.0.1:5601 is pit-world-supabase's Postgres, both forwarded, neither public.
#
# Layout: ~/pitbot/{app (checkout of moshcoder/pit.world), crawler.env (0600),
# data/index.db, archive/, poll.log}. crawler.env holds CRAWL_DATABASE_URL (host
# 127.0.0.1:5601) and anything else secret; this script never writes secrets.
set -euo pipefail

WORKERS=4; INDEX=0; MODE=system
while [ $# -gt 0 ]; do
  case "$1" in
    --workers) WORKERS=$2; shift 2 ;;
    --index) INDEX=1; shift ;;
    --user) MODE=user; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

ROOT=$HOME/pitbot
APP=$ROOT/app
# systemd has no mise shims on PATH: use the real binary.
BUN=$(mise which bun 2>/dev/null || command -v bun)
[ -n "$BUN" ] || { echo "bun is not installed" >&2; exit 1; }
mkdir -p "$ROOT/data" "$ROOT/archive"
[ -d "$APP/.git" ] || git clone -q https://github.com/moshcoder/pit.world.git "$APP"
[ -f "$ROOT/crawler.env" ] || { echo "write $ROOT/crawler.env first: CRAWL_DATABASE_URL for role pitcrawl at 127.0.0.1 port 5601, database postgres" >&2; exit 1; }
chmod 600 "$ROOT/crawler.env"
(cd "$APP" && git fetch -q origin main && git reset -q --hard origin/main && "$BUN" install --frozen-lockfile >/dev/null)

USER_NAME=$(id -un)
if [ $MODE = user ]; then
  SCTL="systemctl --user"; UNIT_DIR=$HOME/.config/systemd/user; WRITE="tee"; USER_LINE=""; TARGET=default.target
  mkdir -p "$UNIT_DIR"
else
  SCTL="sudo systemctl"; UNIT_DIR=/etc/systemd/system; WRITE="sudo tee"; USER_LINE="User=$USER_NAME"; TARGET=multi-user.target
fi
COMMON="$USER_LINE
WorkingDirectory=$APP
EnvironmentFile=$ROOT/crawler.env
Environment=CRAWL_REDIS_URL=redis://127.0.0.1:6396
Environment=NODE_ENV=production
ExecStart=$BUN services/crawler/src/cli.ts worker
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
MemoryMax=1500M
Nice=5"

# Fetch-only workers: no index, no health port, 64 pages at once each.
$WRITE "$UNIT_DIR/pitbot-pages@.service" >/dev/null <<EOF
[Unit]
Description=pitbot page worker %i (fetch only; dev2 Redis via tunnel)
After=network-online.target

[Service]
$COMMON
Environment=CRAWL_ROLES=page
Environment=CRAWL_CONCURRENCY=64
Environment=CRAWL_INDEX_PATH=:memory:
Environment=CRAWL_HEALTH_PORT=0

[Install]
WantedBy=$TARGET
EOF

if [ $INDEX = 1 ]; then
  # The publish role: drains the outbox into the index and the archive, serves the API.
  $WRITE "$UNIT_DIR/pitbot-index.service" >/dev/null <<EOF
[Unit]
Description=pitbot index (publish role: search index, page archive, API on 127.0.0.1:8807)
After=network-online.target

[Service]
$COMMON
Environment=CRAWL_ROLES=publish
Environment=CRAWL_INDEX_PATH=$ROOT/data/index.db
Environment=CRAWL_ARCHIVE_DIR=$ROOT/archive
Environment=CRAWL_HEALTH_HOST=127.0.0.1
Environment=CRAWL_HEALTH_PORT=8807
MemoryMax=8G

[Install]
WantedBy=$TARGET
EOF
fi

$SCTL daemon-reload
# Exactly WORKERS page workers: start 1..N, stop any above N.
for i in $(seq 1 "$WORKERS"); do $SCTL enable --now "pitbot-pages@$i" >/dev/null 2>&1; done
for unit in $($SCTL list-units --plain --no-legend 'pitbot-pages@*' | awk '{print $1}'); do
  n=${unit#pitbot-pages@}; n=${n%.service}
  if [ "$n" -gt "$WORKERS" ]; then $SCTL disable --now "$unit" >/dev/null 2>&1; fi
done
if [ $INDEX = 1 ]; then $SCTL enable --now pitbot-index >/dev/null 2>&1; fi

# Deploy on merge and ship sealed archive hours, from the user's crontab.
POLL="*/5 * * * * bash $APP/deploy/crawler-remote/poll.sh >> $ROOT/poll.log 2>&1  # pitbot remote deploy-on-merge"
SHIP="7 * * * * flock -n /tmp/pitbot-ship.lock bash $APP/deploy/crawler-remote/ship-archive.sh >> $ROOT/ship.log 2>&1  # pitbot archive -> seed1"
{ crontab -l 2>/dev/null | grep -v -e 'pitbot remote deploy-on-merge' -e 'pitbot archive -> seed1'; echo "$POLL"; if [ $INDEX = 1 ]; then echo "$SHIP"; fi; } | crontab -
$SCTL list-units --plain --no-legend 'pitbot-*' | awk '{print $1, $3, $4}'
