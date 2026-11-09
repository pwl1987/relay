#!/usr/bin/env bash
# P0-01A 测试数据库拉起(Relay 专用,仅 127.0.0.1;512Mi 上限;非生产)。
# 全新克隆复现:npm ci && npm run db:up && npm test
set -euo pipefail
NAME=relay-p000-pg
PORT=55433
if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "test PG already running: $NAME (127.0.0.1:$PORT)"
else
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "starting existing container $NAME"
    docker start "$NAME"
  else
    echo "creating container $NAME"
    docker run -d --name "$NAME" -m 512m \
      -p "127.0.0.1:$PORT:5432" \
      -e POSTGRES_PASSWORD=relayp000local \
      -e POSTGRES_DB=relayp000 \
      postgres:17-alpine
  fi
fi
for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then
    echo "PG ready on 127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done
echo "PG failed to become ready" >&2
exit 1
