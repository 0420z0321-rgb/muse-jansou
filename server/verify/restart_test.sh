#!/usr/bin/env bash
# 異常系2：wrangler dev を再起動（＝DO 再生成）しても SQLite から復元され、
# 対局が続行できることを検証する。ローカル永続化は .wrangler/state（wrangler 既定）。
set -u
cd "$(dirname "$0")/.."
BASE="http://127.0.0.1:8787"
LOG=/tmp/jansou-wrangler-restart.log
STATE_FILE=/tmp/jansou-restart.json

start_server() {
  npx wrangler dev --port 8787 --ip 127.0.0.1 >"$LOG" 2>&1 &
  for i in $(seq 1 60); do
    curl -sf "$BASE/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "wrangler dev did not start"; tail -30 "$LOG"; exit 1
}
stop_server() { pkill -f "wrangler dev" 2>/dev/null; sleep 2; }
trap stop_server EXIT

stop_server
echo "== first boot =="
start_server
node verify/restart_check.ts begin "$BASE" "$STATE_FILE" || exit 1

echo "== restart (DO regeneration) =="
stop_server
start_server
node verify/restart_check.ts resume "$BASE" "$STATE_FILE" || exit 1
echo "== restart_test: ALL OK =="
