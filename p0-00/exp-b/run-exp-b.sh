#!/usr/bin/env bash
# P0-00 实验 B 编排器:并发 Tick/Lease 竞争、fencing、SIGKILL 崩溃恢复。
# 用法: run-exp-b.sh [b0|b1|b2|b3|all]
set -uo pipefail
RELAY=/home/ubuntu/dev/relay
EVID=$RELAY/p0-00/evidence/exp-b
EXPDIR=$RELAY/p0-00/exp-b
mkdir -p "$EVID"

header() { echo "=== stage:$1 date:$(date -Iseconds) host:$(hostname) node:$(node --version) user:$(id -un)"; }

w() { (cd "$EXPDIR" && node worker.mjs "$@"); }

run_b0() {
  echo "[B0] schema 重建 + 播种"
  { header b0; w reset; echo "=== exit:$? ==="; } 2>&1 | tee "$EVID/b0-reset.log"
}

run_b1() {
  echo "[B1] 并发双 Worker 争抢同一 READY 任务:必须恰好一个 LEASED,且只有持有者能推进"
  { header b1
    w seed t-b1 >/dev/null
    # 两个独立进程同时发起 claim,循环尝试直至有人成功(最多 20 轮)
    ( for i in $(seq 1 20); do w claim t-b1 worker-A 30 && break; sleep 0.05; done ) > "$EVID/b1-workerA.log" 2>&1 &
    PA=$!
    ( for i in $(seq 1 20); do w claim t-b1 worker-B 30 && break; sleep 0.05; done ) > "$EVID/b1-workerB.log" 2>&1 &
    PB=$!
    wait $PA $PB
    echo "--- claim 结果 ---"
    grep -h '"op":"claim"' "$EVID/b1-workerA.log" "$EVID/b1-workerB.log"
    # 只有赢家能推进 LEASED->RUNNING;双方都尝试
    WA=$(grep -h '"ok":true' "$EVID/b1-workerA.log" | head -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.readline() or '{}'); print(d.get('owner',''), d.get('fencingToken',''))" 2>/dev/null)
    WB=$(grep -h '"ok":true' "$EVID/b1-workerB.log" | head -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.readline() or '{}'); print(d.get('owner',''), d.get('fencingToken',''))" 2>/dev/null)
    OWNER=$(echo $WA | cut -d' ' -f1); FEN=$(echo $WA | cut -d' ' -f2)
    if [ -z "$OWNER" ] || [ "$OWNER" = " " ]; then OWNER=$(echo $WB | cut -d' ' -f1); FEN=$(echo $WB | cut -d' ' -f2); fi
    echo "--- 赢家: $OWNER fencing=$FEN; 双方尝试推进 ---"
    w advance t-b1 worker-A 1 LEASED RUNNING
    w advance t-b1 worker-B 1 LEASED RUNNING
    w advance t-b1 "$OWNER" "$FEN" LEASED RUNNING
    w snapshot b1-final
  } 2>&1 | tee "$EVID/b1-concurrent.log"
}

run_b2() {
  echo "[B2] 租约过期 + fencing:过期后旧持有者必须被 FENCED,新持有者以 token+1 推进"
  { header b2
    w seed t-b2 >/dev/null
    w claim t-b2 worker-A 2   # TTL 2 秒
    echo "--- sleep 3s(等待过期) ---"; sleep 3
    w claim t-b2 worker-B 30  # 过期后 B 获得 fencing=2
    echo "--- 旧持有者 A 用 fencing=1 尝试推进(必须 REJECTED) ---"
    w advance t-b2 worker-A 1 LEASED RUNNING
    echo "--- 新持有者 B 用 fencing=2 推进(必须 OK) ---"
    w advance t-b2 worker-B 2 LEASED RUNNING
    echo "--- A 再用 fencing=2 冒充(必须 REJECTED owner mismatch) ---"
    w advance t-b2 worker-A 2 LEASED RUNNING
    w snapshot b2-final
  } 2>&1 | tee "$EVID/b2-expiry-fencing.log"
}

run_b3() {
  echo "[B3] SIGKILL 崩溃恢复:RUNNING 中被杀 -> 过期回收 -> 幽灵写入被 FENCED -> 审计历史完整"
  { header b3
    w seed t-b3 >/dev/null
    # exec 使 $WPID 即 node 进程本身(SIGKILL 真实命中,不杀 subshell 包装)
    (cd "$EXPDIR" && exec node worker.mjs run-hold t-b3 worker-A 5 > "$EVID/b3-workerA.log" 2>&1) &
    WPID=$!
    # 等待进入 RUNNING
    for i in $(seq 1 50); do
      S=$(w snapshot poll | grep '^TASKS' | grep -o '"state":"[A-Z_]*"' | head -1)
      [ "$S" = '"state":"RUNNING"' ] && break
      sleep 0.2
    done
    echo "--- 任务已 RUNNING,对 worker-A(pid=$WPID) 发送 SIGKILL ---"
    kill -9 $WPID 2>/dev/null; wait $WPID 2>/dev/null
    ps -p $WPID >/dev/null 2>&1 && echo "STILL-ALIVE(BAD)" || echo "worker-dead(good)"
    echo "--- 幽灵写入:A 的 fencing=1 在 TTL 窗口内尝试 RUNNING->VERIFYING(记录语义) ---"
    w advance t-b3 worker-A 1 RUNNING VERIFYING
    echo "--- sleep 6s(等待租约过期)后 reconcile ---"
    sleep 6
    w reconcile supervisor
    echo "--- 幽灵写入:A 仍用 fencing=1 尝试 READY 不可行;改为验证 A 无法用旧 token 领取/推进 ---"
    w advance t-b3 worker-A 1 READY READY 2>/dev/null || true
    echo "--- worker-B 重新领取并推进到 ACCEPTED(fencing 动态取自 claim 结果) ---"
    CLAIM_OUT=$(w claim t-b3 worker-B 30)
    echo "$CLAIM_OUT"
    FEN=$(echo "$CLAIM_OUT" | python3 -c "import json,sys; print(json.loads(sys.stdin.readline()).get('fencingToken',''))")
    w advance t-b3 worker-B "$FEN" LEASED RUNNING
    w advance t-b3 worker-B "$FEN" RUNNING ACCEPTED
    echo "--- worker-B 再用 fencing=$FEN 重复推进(必须 REJECTED state_mismatch,禁止双接受) ---"
    w advance t-b3 worker-B "$FEN" RUNNING ACCEPTED
    w snapshot b3-final
  } 2>&1 | tee "$EVID/b3-sigkill-recovery.log"
}

run_b3b() {
  echo "[B3b] TTL 窗口内的幽灵写入语义:持有未过期租约的已死进程 token 仍具权威(记录为已知语义)"
  { header b3b
    w seed t-b3 >/dev/null
    # TTL 30s:保证幽灵尝试落在窗口内(进程启动开销 ~1-2s);exec 使 kill 真实命中
    (cd "$EXPDIR" && exec node worker.mjs run-hold t-b3 worker-A 30 > "$EVID/b3b-workerA.log" 2>&1) &
    WPID=$!
    for i in $(seq 1 50); do
      S=$(w snapshot poll | grep '^TASKS' | grep -o '"state":"[A-Z_]*"' | head -1)
      [ "$S" = '"state":"RUNNING"' ] && break
      sleep 0.2
    done
    kill -9 $WPID 2>/dev/null; wait $WPID 2>/dev/null
    echo "--- 立即(TTL 30s 内)幽灵推进:A token=1 RUNNING->VERIFYING → 预期成功(租约窗口=权威窗口) ---"
    w advance t-b3 worker-A 1 RUNNING VERIFYING
    echo "--- 随后 B 在 A 租约未过期时抢注 → 必须 REJECTED ---"
    w claim t-b3 worker-B 30
    w snapshot b3b-final
  } 2>&1 | tee "$EVID/b3b-within-ttl-ghost.log"
}

case "${1:-all}" in
  all) run_b0; run_b1; run_b2; run_b3; run_b3b ;;
  b0) run_b0 ;; b1) run_b1 ;; b2) run_b2 ;; b3) run_b3 ;; b3b) run_b3b ;;
  *) echo "unknown stage $1"; exit 2 ;;
esac
echo "ALL REQUESTED STAGES DONE"
