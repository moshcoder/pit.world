#!/usr/bin/env bash
# On dev2: keep one ssh connection to a remote pitbot box carrying
#   -R 6396 -> dev2's pitbot Redis   (remote workers' queues)
#   -R 5601 -> pit-world-supabase    (the site frontier)
#   -L 8817 <- the remote index API  (pit.world's CRAWLER_STATUS_URL / PIT_INDEX_URL)
# All three ends bind 127.0.0.1 only. Blocks while the link is up; cron restarts it:
#
#   * * * * * flock -n /tmp/pitbot-tunnel.lock bash .../deploy/crawler-remote/tunnel.sh devchovy >> ~/www/pit-crawler/tunnel.log 2>&1
set -u
HOST=${1:?usage: tunnel.sh <ssh-host>}
echo "$(date -u +%FT%TZ) tunnel to $HOST up"
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:6396:127.0.0.1:6396 \
  -R 127.0.0.1:5601:127.0.0.1:5601 \
  -L 127.0.0.1:8817:127.0.0.1:8807 \
  "$HOST"
echo "$(date -u +%FT%TZ) tunnel to $HOST down (exit $?)"
