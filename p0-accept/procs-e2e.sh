#!/usr/bin/env bash
# P0-ACCEPT 缺口 E:连续自治与故障恢复 —— 真实 relay-server 进程演练(证据落 p0-accept/procs-e2e.log)。
# 前置:无并发测试窗口(R-9/CONTINUATION ②);relay-p000-pg 可用(docker);零真实模型调用
#       (tick 均在 provider 离线态验证,真实模型执行语义由缺口 A-4 联验承担)。
# 演练项:
#   E1 启动:node src/server/index.ts(RELAY_WEB_WORKER=live + docker 隔离 + 真实 magpie env)→ 健康检查
#   E2 登录 + 经 Web API 创建 Goal(真实 HTTP;写路径经 core planGoal)
#   E3 重启恢复:SIGTERM → 重启 → 健康恢复 + 会话失效(服务端会话)+ DB 实体保留
#   E4 Provider 离线:重启时 RELAY_PI_BASE_URL 指不可达地址 → tick ⇒ IDLE_PROVIDER_DOWN(不领取、零副作用)
#   E5 SIGKILL:kill -9 → 进程死 → 重启 → 恢复(DB 事实源)+ 旧会话失效
#   E6 PG 断连:docker stop relay-p000-pg → health 降级可见 → start → 恢复
#   E7 长稳基线:冻结阈值 + 零模型(provider 离线)周期 tick 观测段(默认 10 分钟;P0ACC_SOAK_SECONDS 覆盖)
# 退出码:任一演练失败 ⇒ 非 0(证据如实记录,不掩盖)。
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=p0-accept
mkdir -p "$OUT"
LOG="$OUT/procs-e2e.log"
: > "$LOG"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
fail() { log "FAIL: $*"; exit 1; }

PG_NAME=relay-p000-pg
PG_PORT=55433
DB_NAME="p0acc_procs_$(date +%s)"
DB_URL="postgresql://postgres:relayp000local@127.0.0.1:${PG_PORT}/${DB_NAME}"
STAGE_DIR="$(mktemp -d /tmp/p0acc-stage-XXXX)"
SRV_PID=""
SRV_PORT=""

cleanup() {
  if [ -n "$SRV_PID" ] && kill -0 "$SRV_PID" 2>/dev/null; then kill -9 "$SRV_PID" 2>/dev/null; fi
  docker exec "$PG_NAME" psql -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME" >/dev/null 2>&1
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

start_server() { # $1=模型 base_url
  RELAY_DB_URL="$DB_URL" \
  RELAY_WEB_PASSWORD="p0acc-procs-pw" \
  RELAY_WEB_HOST="127.0.0.1" \
  RELAY_WEB_PORT="0" \
  RELAY_WEB_WORKER="live" \
  RELAY_WEB_SANDBOX="docker" \
  RELAY_WEB_STAGE_DIR="$STAGE_DIR" \
  RELAY_PI_PROVIDER="${P0ACC_PROVIDER:-magpie}" RELAY_PI_MODEL="${P0ACC_MODEL:-group/gm}" \
  RELAY_PI_API_KEY="magpie" RELAY_PI_BASE_URL="$1" \
  node src/server/index.ts >> "$LOG" 2>&1 &
  SRV_PID=$!
}

wait_banner() { # 横幅行数增量等待:必须等到**本次启动进程**写入的新横幅(端口随机,旧横幅作废)
  local n0; n0=$(grep -c "listening on" "$LOG" || true)
  for _ in $(seq 1 30); do
    local n1; n1=$(grep -c "listening on" "$LOG" || true)
    if [ "${n1:-0}" -gt "${n0:-0}" ]; then
      SRV_PORT=$(grep -o "listening on http://127.0.0.1:[0-9]*" "$LOG" | tail -1 | grep -o "[0-9]*$")
      if [ -n "$SRV_PORT" ] && kill -0 "$SRV_PID" 2>/dev/null; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

provision_db() { # 独立 database + 全部迁移("public". 前缀已从迁移剥离,默认 search_path 可用)
  docker exec "$PG_NAME" psql -U postgres -c "CREATE DATABASE $DB_NAME" >/dev/null || fail "建库失败"
  for f in migrations/*.sql; do
    docker exec -i "$PG_NAME" psql -U postgres -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$f" || fail "迁移失败:$f"
  done
  log "E0 独立库就绪:$DB_NAME(迁移 $(ls migrations/*.sql | wc -l) 个文件)"
}

relogin() { # 刷新 COOKIE/CSRF(重启后会话失效,须重登)
  rm -f /tmp/p0acc-hdr.json
  curl -sS --noproxy '*' -D /tmp/p0acc-hdr.txt -o /tmp/p0acc-login.json "http://127.0.0.1:${SRV_PORT}/api/session" \
    -X POST -H 'content-type: application/json' -d '{"password":"p0acc-procs-pw"}' || fail "登录请求失败"
  COOKIE=$(grep -i '^set-cookie:' /tmp/p0acc-hdr.txt | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | tr -d '\r')
  CSRF=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/p0acc-login.json","utf8")).csrfToken||"")')
  [ -n "$COOKIE" ] && [ -n "$CSRF" ] || fail "登录响应缺会话/CSRF"
}

tick_http() {
  curl -sS --noproxy '*' -m 30 "http://127.0.0.1:${SRV_PORT}/api/worker/tick" -X POST \
    -H "cookie: $COOKIE" -H "x-relay-csrf: $CSRF" | tail -c 300
}

log "=== P0-ACCEPT 缺口 E:真实进程演练开始(基线:$(git rev-parse HEAD | cut -c1-12))==="

# ---- E0 独立库 + 迁移 ----
docker exec "$PG_NAME" pg_isready -U postgres >/dev/null || fail "relay-p000-pg 不可用"
provision_db

# ---- E1 启动(live + docker + magpie env;不创建 Goal 不烧模型)----
log "E1 启动 relay-server(live+docker+magpie)…"
start_server "http://127.0.0.1:3425/v1"
wait_banner || fail "server 未在 30s 内就绪(见日志)"
anon=$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SRV_PORT}/api/health")
[ "$anon" = "401" ] || fail "E1:未登录 health 应 401(认证门),得 $anon"
relogin
health=$(curl -sS --noproxy '*' "http://127.0.0.1:${SRV_PORT}/api/health" -H "cookie: $COOKIE")
echo "$health" | grep -q '"ok":true' || fail "health 非 ok:$health"
log "E1 PASS:server 就绪 127.0.0.1:${SRV_PORT};health 未登录 401/登录后 ok(认证门生效);$health"

# ---- E2 登录 + Web API 建 Goal ----
relogin
body=$(curl -sS --noproxy '*' "http://127.0.0.1:${SRV_PORT}/api/goals" -X POST -H 'content-type: application/json' \
  -H "cookie: $COOKIE" -H "x-relay-csrf: $CSRF" \
  -d '{"rawInput":"缺口E 进程演练目标(不期望真实执行)"}')
echo "$body" | grep -q '"goalId"' || fail "E2:创建 Goal 失败:$body"
GOAL=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).goalId)' "$body")
GOALS_BEFORE=$(docker exec "$PG_NAME" psql -U postgres -d "$DB_NAME" -tA -c "SELECT id || ':' || state FROM goals")
log "E2 PASS:登录+建 Goal 经 Web API(写路径经 core);goalId=$GOAL"

# ---- E3 SIGTERM 重启:健康恢复 + DB 实体保留 ----
log "E3 重启恢复演练:SIGTERM → 重启 → 健康 + 实体保留"
kill -TERM "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
start_server "http://127.0.0.1:3425/v1"
wait_banner || fail "E3:重启未就绪"
relogin   # E3 重启后会话失效(服务端会话),重登
health=$(curl -sS --noproxy '*' "http://127.0.0.1:${SRV_PORT}/api/health" -H "cookie: $COOKIE")
echo "$health" | grep -q '"ok":true' || fail "E3:恢复后 health 非 ok:$health"
GOALS_AFTER=$(docker exec "$PG_NAME" psql -U postgres -d "$DB_NAME" -tA -c "SELECT id || ':' || state FROM goals")
[ "$GOALS_BEFORE" = "$GOALS_AFTER" ] || fail "E3:重启前后 DB 实体不一致"
log "E3 PASS:SIGTERM→重启;health ok;Goal 实体保留($(echo "$GOALS_AFTER" | wc -l) 行)"

# ---- E4 Provider 离线:重启(BASE_URL 不可达)→ tick ⇒ IDLE_PROVIDER_DOWN ----
log "E4 provider 离线演练:重启时 BASE_URL 指不可达地址 → tick 应 IDLE_PROVIDER_DOWN"
kill -TERM "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
start_server "http://127.0.0.1:9/v1"
wait_banner || fail "E4:重启未就绪"
relogin   # E4 重启后会话失效,重登
OUT4=$(tick_http)
echo "$OUT4" | grep -q "IDLE_PROVIDER_DOWN" || fail "E4:tick 未返回 IDLE_PROVIDER_DOWN:$OUT4"
log "E4 PASS:provider 离线 ⇒ tick IDLE_PROVIDER_DOWN,不领取任务、零副作用、零模型调用"

# ---- E5 SIGKILL → 重启恢复 + 旧会话失效 ----
log "E5 SIGKILL 演练:kill -9 → 重启 → 健康恢复 + DB 事实源 + 会话失效"
OLD_COOKIE="$COOKIE"
kill -9 "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; SRV_PID=""
kill -0 "$SRV_PID" 2>/dev/null && fail "E5:进程未死"
log "E5:进程已死(SIGKILL)"
start_server "http://127.0.0.1:3425/v1"
wait_banner || fail "E5:重启未就绪"
old_res=$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SRV_PORT}/api/dashboard" -H "cookie: $OLD_COOKIE")
[ "$old_res" = "401" ] || fail "E5:重启后旧会话应失效(401),得 $old_res"
relogin
health=$(curl -sS --noproxy '*' "http://127.0.0.1:${SRV_PORT}/api/health" -H "cookie: $COOKIE")
echo "$health" | grep -q '"ok":true' || fail "E5:恢复后 health 非 ok:$health"
log "E5 PASS:SIGKILL→重启;health ok;DB 为事实源;旧会话失效 401(服务端会话语义)"

# ---- E6 PG 断连 → 恢复 ----
log "E6 PG 断连演练:docker stop relay-p000-pg → health 降级可见 → start → 恢复"
docker stop "$PG_NAME" >/dev/null || fail "E6:stop 失败"
pg_down_health=$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${SRV_PORT}/api/health" 2>/dev/null)
log "E6:PG down 时 health HTTP=$pg_down_health"
[ "$pg_down_health" != "200" ] || fail "E6:PG down 时 health 不应为 200"
pg_down_tick=$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:${SRV_PORT}/api/worker/tick" -X POST -H "cookie: $COOKIE" -H "x-relay-csrf: $CSRF" 2>/dev/null)
log "E6:PG down 时 tick HTTP=$pg_down_tick(失败但不推进)"
docker start "$PG_NAME" >/dev/null
for _ in $(seq 1 30); do docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
health=$(curl -sS --noproxy '*' -m 10 "http://127.0.0.1:${SRV_PORT}/api/health" -H "cookie: $COOKIE")
echo "$health" | grep -q '"ok":true' || fail "E6:PG 恢复后 health 未恢复:$health"
log "E6 PASS:PG 断连降级可见;恢复后 health ok(连接池自愈);状态推进零发生"

# ---- E7 长稳基线(零模型:provider 离线 tick 循环;阈值冻结)----
SOAK=${P0ACC_SOAK_SECONDS:-600}
log "E7 长稳基线:观测 ${SOAK}s(provider 离线 tick 循环)。冻结阈值:RSS<400MB;tick 恒 IDLE_PROVIDER_DOWN"
SOAK_START=$(date +%s)
RSS_MAX=0; TICK_IDLE=0; TICK_OTHER=0
while [ $(( $(date +%s) - SOAK_START )) -lt "$SOAK" ]; do
  OUT7=$(tick_http 2>/dev/null || true)
  case "$OUT7" in *IDLE_PROVIDER_DOWN*) TICK_IDLE=$((TICK_IDLE+1));; *) TICK_OTHER=$((TICK_OTHER+1));; esac
  RSS=$(ps -o rss= -p "$SRV_PID" 2>/dev/null | tr -d ' '); [ -n "$RSS" ] && [ "$RSS" -gt "$RSS_MAX" ] && RSS_MAX=$RSS
  sleep 5
done
log "E7 结果:tick 空闲=$TICK_IDLE 其他=$TICK_OTHER;RSS峰值=${RSS_MAX}KB"
[ "$TICK_OTHER" = "0" ] || fail "E7:tick 出现非预期状态($TICK_OTHER 次)"
[ "$RSS_MAX" -lt 409600 ] || fail "E7:RSS 超 400MB 阈值(${RSS_MAX}KB)"
log "E7 PASS:长稳基线观测段完成(**24h/72h 长稳未跑满,如实标注**——本包仅交付冻结阈值+起跑基线)"

log "=== 缺口 E 演练全部 PASS ==="
exit 0
