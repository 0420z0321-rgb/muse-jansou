#!/usr/bin/env bash
# Phase 4 検証一式：wrangler dev を起動し、HTTP越し半荘2試合（エンジン回帰）
# ＋ Phase 4 権限異常系を実行して止める。再起動復元は restart_test.sh で別途。
set -u
cd "$(dirname "$0")/.."
BASE="http://127.0.0.1:8787"
LOG=/tmp/jansou-wrangler-p4.log

cleanup() { pkill -f "wrangler dev" 2>/dev/null; }
trap cleanup EXIT
cleanup; sleep 1

npx wrangler dev --port 8787 --ip 127.0.0.1 >"$LOG" 2>&1 &
for i in $(seq 1 60); do
  curl -sf "$BASE/" >/dev/null 2>&1 && break
  sleep 1
  [ "$i" = 60 ] && { echo "wrangler dev did not start"; tail -30 "$LOG"; exit 1; }
done
echo "== wrangler dev up =="

node verify/play_http.ts "$BASE" 7 || exit 1
node verify/play_http.ts "$BASE" 11 || exit 1
node verify/anomalies_phase4.ts "$BASE" || exit 1
echo "== run_all_phase4: ALL OK =="
