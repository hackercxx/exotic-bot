#!/usr/bin/env bash
# Start EXOTIC BOT API (:4000) and web preview (:3001) with pidfiles.
# Idempotent: skips components already listening.
set -u
cd "$(dirname "$0")/.."
mkdir -p logs
HOST="${__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS:-}"

alive() { # pidfile port
  local pid=""
  [ -f "$1" ] && pid=$(cat "$1" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
  # fall back: something already on the port?
  local port="$2"
  ss -ltn 2>/dev/null | grep -q ":${port} " && return 0
  return 1
}

if ! alive logs/server.pid 4000; then
  echo "[preview] starting API on :4000"
  setsid env $(grep -Ev '^(#|$)' .env | xargs) node server/dist/index.js \
    > logs/server.log 2>&1 &
  echo $! > logs/server.pid
fi

if ! alive logs/web.pid 3001; then
  echo "[preview] starting Vite on :3001 (host allowlist: ${HOST:-none})"
  ( cd web && ( setsid env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="$HOST" npx vite --host 0.0.0.0 --port 3001 --strictPort \
    > ../logs/web.log 2>&1 & echo $! > ../logs/web.pid ) )
fi

sleep 2
echo "[preview] pids: server=$(cat logs/server.pid 2>/dev/null || echo '-') web=$(cat logs/web.pid 2>/dev/null || echo '-')"
ss -ltn 2>/dev/null | grep -E ':(4000|3001) ' || true