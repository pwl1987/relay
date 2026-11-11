#!/usr/bin/env bash
# P0-REWORK-2 · V03 验收演练:无 ChatGPT、无浏览器环境,全部控制操作经真实 CLI 进程完成。
# 全程真实 PG(一次性 schema)+ 真实进程(node bin/relay.mjs)。
# worker tick 用 stub 注入执行一拍(报告如实标注 workerMode=stub;真实模型面已由缺口 A
# live-worker-e2e 联验覆盖,本演练零真实模型调用)。输出落 v03-cli-journey.log。
set -euo pipefail
cd "$(dirname "$0")/.."

LOG="p0-rework2/v03-cli-journey.log"
mkdir -p p0-rework2
: > "$LOG"

run() { echo "" | tee -a "$LOG"; echo "\$ $*" | tee -a "$LOG"; "$@" 2>&1 | tee -a "$LOG"; }

# 0) 独立 schema(一次性;结束删除)
SCHEMA="v03_journey_$(date +%s)_$$"
node --input-type=module -e "
import pg from 'pg';
import { createIsolatedSchema } from './src/core/db.ts';
const pool = new pg.Pool({ connectionString: process.env.RELAY_DB_URL ?? 'postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000' });
await createIsolatedSchema(pool, '$SCHEMA', './migrations');
await pool.end();" | tee -a "$LOG"
export RELAY_DB_SCHEMA="$SCHEMA"
cleanup() { node --input-type=module -e "
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.RELAY_DB_URL ?? 'postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000' });
await pool.query('DROP SCHEMA IF EXISTS $SCHEMA CASCADE');
await pool.end();" || true; }
trap cleanup EXIT

RELAY="node bin/relay.mjs"

echo "=== V03 演练开始:$(date -Is) schema=$SCHEMA ===" | tee -a "$LOG"

# 1) doctor:环境预检(迁移面/守卫/pi/docker/凭据存在性,零明文)
run $RELAY doctor

# 2) goal create(一句自然语言;确定性默认计划)——Goal A,用于暂停/恢复语义
run $RELAY goal create --text "整理示例项目的数字清单(暂停语义演练)" --actor owner
CREATED_JSON="$($RELAY goal create --text "为示例项目计算 12 30 45 之和并写入 result.txt" --actor owner)"
echo "$CREATED_JSON" | tee -a "$LOG"
TASK_ID="$(node -e "console.log(JSON.parse(process.argv[1]).taskIds[0])" "$CREATED_JSON")"
echo "[journey] Goal B task=$TASK_ID(用于单拍执行)" | tee -a "$LOG"

# 3) pause 置入(v0:READY→PAUSED)→ 重复同版本 pause(版本失配,exit 3)→ resume 恢复(v1)
run $RELAY pause "$TASK_ID" --expected-state-version 0 --actor owner
echo "[journey] 重复同一版本 pause(应被拒,exit 3):" | tee -a "$LOG"
set +e
$RELAY pause "$TASK_ID" --expected-state-version 0 --actor owner 2>&1 | tee -a "$LOG"
echo "[journey] 上一步退出码=$?(预期 3)" | tee -a "$LOG"
set -e
run $RELAY task resume "$TASK_ID" --expected-state-version 1 --actor owner

# 4) worker tick(stub 注入;Coder 写 result.txt,Reviewer 缺省 verdict PASS)→ 单拍执行 + Gate
SEED="$(mktemp -d /tmp/v03-seed-XXXX)"
echo "numbers: 12 30 45" > "$SEED/brief.txt"
export STUB_MODE=ok
export STUB_WRITE_FILE="result.txt:sum=87"
run $RELAY worker tick --stub --seed "$SEED" --worker-id v03-journey-worker
rm -rf "$SEED"

# 5) goal show(状态/Gate/证据可见;与 API 同一视图)——取 Goal B(列表第一个为 B)
GOAL_B="$(node -e "console.log(JSON.parse(process.argv[1]).goalId)" "$CREATED_JSON")"
run $RELAY goal show "$GOAL_B"

# 6) decision list / status(Dashboard;与 API 同一视图)
run $RELAY decision list
run $RELAY status

echo "" | tee -a "$LOG"
echo "=== V03 演练结束:$(date -Is)(全部控制操作经 CLI 完成;零浏览器/零 ChatGPT/零真实模型调用)===" | tee -a "$LOG"
