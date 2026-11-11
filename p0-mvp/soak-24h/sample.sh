#!/usr/bin/env bash
# 24h 长稳采样器(真实计时;每 60s 一行;满 86400s 后写 soak-final.json)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
START="$(head -1 "$DIR/start-epoch")"
WPID="$(cat "$DIR/worker.pid" | cut -d= -f2)"
CSV="$DIR/samples.csv"
echo "epoch,elapsed_s,rss_kb,cpu_pct,alive,pg_conns,last_tick_status" >> "$CSV"
while :; do
  NOW="$(date +%s)"
  ELAPSED=$((NOW - START))
  ALIVE="no"; RSS=""; CPU=""
  if [ -d "/proc/$WPID" ]; then
    ALIVE="yes"
    RSS=$(awk '/VmRSS/{print $2}' "/proc/$WPID/status" 2>/dev/null)
    CPU=$(ps -p "$WPID" -o %cpu= --no-headers 2>/dev/null | tr -d ' ')
  fi
  PG=$(docker exec relay-p000-pg psql -U postgres -d relayp000 -tA -c "SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL" 2>/dev/null || echo "-")
  TICK=$(grep -o "status=[A-Z_]*" "$DIR/worker.log" | tail -1 | cut -d= -f2)
  echo "$NOW,$ELAPSED,${RSS:-0},${CPU:-0},$ALIVE,$PG,${TICK:-none}" >> "$CSV"
  if [ "$ELAPSED" -ge 86400 ] || [ "$ALIVE" = "no" ]; then
    node --input-type=module -e "
const fs = await import('node:fs');
const lines = fs.readFileSync('$CSV','utf8').trim().split('\n').slice(1);
const rss = lines.map(l=>Number(l.split(',')[2])).filter(Boolean);
const alive = lines.filter(l=>l.split(',')[4]==='yes').length;
const end = (l=>({epoch:l[0],elapsed_s:Number(l[1]),rss_kb:Number(l[2])}))(lines[lines.length-1].split(','));
fs.writeFileSync('$DIR/soak-final.json', JSON.stringify({
  startEpoch: Number('$START'), endEpoch: end.epoch, elapsedSeconds: end.elapsed_s,
  targetSeconds: 86400, completed: end.elapsed_s >= 86400,
  workerAliveAtEnd: alive > 0 && lines[lines.length-1].split(',')[4]==='yes',
  samples: lines.length, rssPeakKb: Math.max(...rss, 0),
  thresholdRssKb: 400000,
  verdict: end.elapsed_s >= 86400 && Math.max(...rss, 0) < 400000 ? '观察期已满——判定交由 REVIEW' : '观察期未满或超阈值——不得宣称 PASS'
}, null, 2));
" 2>/dev/null || true
    break
  fi
  sleep 60
done
