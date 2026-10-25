#!/usr/bin/env bash
# Stop preview processes started by scripts/preview.sh (pidfiles only).
set -u
cd "$(dirname "$0")/.."
for f in logs/web.pid logs/server.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    echo "[stop] $f (pid $pid) stopped"
  fi
  rm -f "$f"
done