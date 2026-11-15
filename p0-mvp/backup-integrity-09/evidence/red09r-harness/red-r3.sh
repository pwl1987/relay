#!/usr/bin/env bash
# Red-R3:端口缺省别名(宿主分支)。RELAY_DB_URL 显式 127.0.0.1:5432,RESTORE_URL=localhost 不带端口
# (pg 默认 5432)⇒ 同一实例;前缀比较失败 ⇒ 守卫失效。
set -uo pipefail
REPO=/home/ubuntu/dev/relay
FAKE_LOG=/tmp/red09r/out/r3-argv.log; : > "$FAKE_LOG"
env -i PATH=/tmp/red09r/bin HOME="$HOME" FAKE_LOG="$FAKE_LOG" FAKE_EXIT=79 \
  RELAY_RESTORE_ISOLATED=1 \
  RELAY_DB_URL='postgresql://demo@127.0.0.1:5432/relayp000' \
  bash "$REPO/deploy/restore-verify.sh" /tmp/red09r/bk-valid 'postgresql://demo@localhost' \
  > /tmp/red09r/out/r3-run.log 2>&1
RC=$?
echo "== Red-R3 exit=$RC =="; cat /tmp/red09r/out/r3-run.log; echo "== argv =="; cat "$FAKE_LOG"
grep -q 'fail-closed' /tmp/red09r/out/r3-run.log && { echo "判定:守卫生效(非红)"; exit 1; }
grep -q 'DROP DATABASE IF EXISTS relay_restore_v' "$FAKE_LOG" \
  && echo "RED 确认:端口缺省别名绕过,DROP argv 发往 localhost(默认 5432)" \
  || { echo "判定:红态未复现"; exit 1; }
