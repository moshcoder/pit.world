#!/usr/bin/env bash
# Ship sealed archive hours (pages-*.jsonl.gz, never the open .partial) to seed1, and
# delete each local copy only once rsync has verified it there. Cron, hourly.
#
#   PITBOT_ARCHIVE_DEST=seed1:/home/ubuntu/pitbot-archive/   (ssh alias + path)
set -euo pipefail
SRC=$HOME/pitbot/archive
DEST=${PITBOT_ARCHIVE_DEST:-seed1:/home/ubuntu/pitbot-archive/}
shopt -s nullglob
files=("$SRC"/pages-*.jsonl.gz)
[ ${#files[@]} -eq 0 ] && exit 0
# --checksum + --remove-source-files: a local file goes only after its copy matches.
rsync -a --checksum --remove-source-files --partial-dir=.rsync-partial "${files[@]}" "$DEST"
echo "$(date -u +%FT%TZ) shipped ${#files[@]} hour(s) to $DEST"
