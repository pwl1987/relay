#!/usr/bin/env bash
# Red-R4:任意容器名盲信(docker 分支)。RELAY_RESTORE_CONTAINER 指向任意非声明容器名,RESTORE_URL
# 声明另一隔离地址 ⇒ 当前脚本仍向该任意容器发出 DROP/CREATE(argv 捕获,零真实容器操作)。
set -uo pipefail
REPO=/home/ubuntu/dev/relay
FAKE_LOG=/tmp/red09r/out/r4-argv.log; : > "$FAKE_LOG"
env -i PATH=/tmp/red09r/bin HOME="$HOME" FAKE_LOG="$FAKE_LOG" FAKE_EXIT=79 \
  RELAY_RESTORE_ISOLATED=1 \
  RELAY_RESTORE_CONTAINER='some-unrelated-container' \
  RELAY_DB_URL='postgresql://demo@127.0.0.1:55433/relayp000' \
  bash "$REPO/deploy/restore-verify.sh" /tmp/red09r/bk-valid 'postgresql://demo@127.0.0.1:59999' \
  > /tmp/red09r/out/r4-run.log 2>&1
RC=$?
echo "== Red-R4 exit=$RC =="; cat /tmp/red09r/out/r4-run.log; echo "== argv =="; cat "$FAKE_LOG"
grep -q 'fail-closed' /tmp/red09r/out/r4-run.log && { echo "判定:守卫生效(非红)"; exit 1; }
grep -q 'docker exec some-unrelated-container psql' "$FAKE_LOG" \
  && echo "RED 确认:任意 RELAY_RESTORE_CONTAINER 被盲信,RESTORE_URL 与实际执行容器不一致" \
  || { echo "判定:红态未复现"; exit 1; }
