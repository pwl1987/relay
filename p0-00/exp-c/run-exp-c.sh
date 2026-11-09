#!/usr/bin/env bash
# P0-00 实验 C 编排器:外部写"成功但回执丢失"的 Reconcile(本地 Mock Git 仓库 + 真实 SIGKILL 注入)。
# 用法: run-exp-c.sh [setup|c1|c2|c3|all]
set -uo pipefail
RELAY=/home/ubuntu/dev/relay
LAB=$RELAY/.p0-00-lab
EVID=$RELAY/p0-00/evidence/exp-c
EXPDIR=$RELAY/p0-00/exp-c
SRC=$LAB/ws/c-src
REMOTE=$LAB/ws/c-remote.git
mkdir -p "$EVID"

export RELAY_C_SRC=$SRC
header() { echo "=== stage:$1 date:$(date -Iseconds) host:$(hostname) git:$(git --version) user:$(id -un)"; }
w() { (cd "$EXPDIR" && node worker-c.mjs "$@"); }

run_setup() {
  echo "[SETUP] 本地 mock 仓库(工作仓 + bare 远端)"
  { header setup
    rm -rf "$SRC" "$REMOTE"
    git init -q -b main "$SRC"
    git -C "$SRC" config user.email p0-00@lab.local; git -C "$SRC" config user.name "p0-00-lab"
    echo "base" > "$SRC/base.txt"; git -C "$SRC" add .; git -C "$SRC" commit -qm "base"
    git init -q --bare -b main "$REMOTE"
    git -C "$SRC" remote add origin "$REMOTE"
    git -C "$SRC" push -q origin main
    echo "remote HEAD: $(git ls-remote "$REMOTE" refs/heads/main)"
    w reset "$SRC" "$REMOTE"
  } 2>&1 | tee "$EVID/c0-setup.log"
}

# C1:push 成功但回执丢失 -> 恢复必须先核对远端,不得重复推送
run_c1() {
  echo "[C1] 外部写成功+回执丢失:kill 注入 -> reconcile 先查询远端真实状态"
  { header c1
    EXPECTED=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "c1-change" > "$SRC/c1.txt"; git -C "$SRC" add .; git -C "$SRC" commit -qm "c1 candidate"
    PAYLOAD=$(git -C "$SRC" rev-parse HEAD)
    echo "expected=$EXPECTED payload=$PAYLOAD"
    w reserve i-c1 t-c k-c1 "$REMOTE" main "$EXPECTED" "$PAYLOAD"
    # 子进程执行:push 后挂住(模拟回执未到);父进程观察到远端已变即 SIGKILL(真实故障注入)。
    # 用 exec 使 $! 即 node 进程本身(避免 kill 只杀 subshell 包装)。
    (cd "$EXPDIR" && exec env RELAY_C_SRC="$SRC" node worker-c.mjs execute i-c1 30000 > "$EVID/c1-executor.log" 2>&1) &
    EPID=$!
    for i in $(seq 1 100); do
      H=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
      [ "$H" = "$PAYLOAD" ] && break
      sleep 0.1
    done
    echo "--- 远端 HEAD 已变为 $H,SIGKILL executor(pid=$EPID) → 回执丢失 ---"
    kill -9 $EPID 2>/dev/null; wait $EPID 2>/dev/null
    sleep 0.3
    echo "--- 确认 executor 已死(ps)与意图仍处 EXECUTING(回执未写) ---"
    ps -p $EPID >/dev/null 2>&1 && echo "STILL-ALIVE(BAD)" || echo "executor-dead(good)"
    w intent i-c1
    w intent i-c1
    echo "--- 恢复:reconcile(必须先查询远端,SIDE_EFFECT_CONFIRMED,不重推) ---"
    w reconcile i-c1
    echo "--- 幂等性:再次 reconcile 必须 already_completed,不产生新副作用 ---"
    w reconcile i-c1
    echo "--- 推送次数核验(payload commit 在远端历史中恰好一份) ---"
    git -C "$SRC" ls-remote "$REMOTE" refs/heads/main
    w intent i-c1
  } 2>&1 | tee "$EVID/c1-lost-receipt-reconcile.log"
}

# C2:意图已预留但 push 从未发生 -> 恢复发现远端未变,安全重推恰好一次
run_c2() {
  echo "[C2] 外部写未发生:恢复方必须能安全重推(恰好一次)"
  { header c2
    EXPECTED=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "c2-change" > "$SRC/c2.txt"; git -C "$SRC" add .; git -C "$SRC" commit -qm "c2 candidate"
    PAYLOAD=$(git -C "$SRC" rev-parse HEAD)
    w reserve i-c2 t-c k-c2 "$REMOTE" main "$EXPECTED" "$PAYLOAD"
    # 模拟"执行前被杀":executor 在 push 前停顿 3s(受控注入点),0.5s 时 kill → 必然死于 push 之前
    (cd "$EXPDIR" && RELAY_C_PRE_PUSH_MS=3000 node worker-c.mjs execute i-c2 5000 > "$EVID/c2-executor.log" 2>&1) &
    EPID=$!
    sleep 0.5
    kill -9 $EPID 2>/dev/null; wait $EPID 2>/dev/null
    H=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "--- kill 后远端 HEAD=$H(payload=$PAYLOAD) ---"
    if [ "$H" = "$PAYLOAD" ]; then echo "NOTE: 竞争窗口内 push 已发生,本场景实际落入 C1 语义"; fi
    w intent i-c2
    echo "--- 恢复:reconcile(决策将写入审计) ---"
    w reconcile i-c2
    H2=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    if [ "$H2" != "$PAYLOAD" ]; then
      echo "--- 决策:未发生 → 安全重推一次 ---"
      w execute i-c2 0
      git ls-remote "$REMOTE" refs/heads/main
    fi
    w intent i-c2
  } 2>&1 | tee "$EVID/c2-before-push-recovery.log"
}

# C3:远端漂移(expected SHA 不匹配)→ 必须拒绝,禁止强推
run_c3() {
  echo "[C3] 远端漂移:expected SHA 过期 → 拒绝执行,不覆盖"
  { header c3
    echo "drift" > "$REMOTE-drift.txt" 2>/dev/null || true
    EXPECTED=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "c3-change" > "$SRC/c3.txt"; git -C "$SRC" add .; git -C "$SRC" commit -qm "c3 candidate"
    PAYLOAD=$(git -C "$SRC" rev-parse HEAD)
    # 模拟他人推进远端
    git clone -q "$REMOTE" "$SRC-driftclone" 2>/dev/null
    git -C "$SRC-driftclone" config user.email drift@lab.local; git -C "$SRC-driftclone" config user.name drift
    echo "external" > "$SRC-driftclone/ext.txt"; git -C "$SRC-driftclone" add .; git -C "$SRC-driftclone" commit -qm "external commit"
    git -C "$SRC-driftclone" push -q origin main
    NEWHEAD=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "--- 远端已被外部推进: $EXPECTED -> $NEWHEAD ---"
    w reserve i-c3 t-c k-c3 "$REMOTE" main "$EXPECTED" "$PAYLOAD"
    echo "--- 用过期 expected 执行(必须 CONFLICT,不推送) ---"
    w execute i-c3 0
    H=$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)
    echo "--- 执行后远端 HEAD=$H(必须仍为 $NEWHEAD,候选 $PAYLOAD 未覆盖) ---"
    w intent i-c3
    rm -rf "$SRC-driftclone"
  } 2>&1 | tee "$EVID/c3-remote-drift-reject.log"
}

case "${1:-all}" in
  all) run_setup; run_c1; run_c2; run_c3 ;;
  setup) run_setup ;; c1) run_c1 ;; c2) run_c2 ;; c3) run_c3 ;;
  *) echo "unknown stage $1"; exit 2 ;;
esac
echo "ALL REQUESTED STAGES DONE"
