#!/usr/bin/env bash
# Deploy-on-merge for pitbot on a remote box: when main moves, update and restart the
# pitbot-* units (install.sh wrote them). Cron, every 5 minutes.
set -euo pipefail
# Cron has no mise shims on PATH (bun lives there).
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
APP=$HOME/pitbot/app
cd "$APP"
git fetch -q origin main
want=$(git rev-parse origin/main); have=$(git rev-parse HEAD)
if [ "$want" = "$have" ] && [ "${1:-}" != "--force" ]; then exit 0; fi
echo "$(date -u +%FT%TZ) deploying ${want:0:12} (was ${have:0:12})"
git reset -q --hard "$want"
bun install --frozen-lockfile >/dev/null
for unit in $(systemctl list-units --plain --no-legend 'pitbot-*' | awk '{print $1}'); do sudo systemctl restart "$unit"; done
sleep 10
failed=$(systemctl list-units --plain --no-legend --state=failed 'pitbot-*' | awk '{print $1}')
if [ -n "$failed" ]; then echo "$(date -u +%FT%TZ) ${want:0:12} FAILED: $failed" >&2; exit 1; fi
echo "$(date -u +%FT%TZ) ${want:0:12} running"
