#!/usr/bin/env bash
# Red-R2:Docker 执行目标错位(VM80 宿主无 psql 的回退分支)。当前脚本 docker 分支完全忽略 RESTORE_URL 的
# host/port,直接 docker exec "$RELAY_RESTORE_CONTAINER";令其指向 relay-p000-pg(共享源实例名),
# RESTORE_URL 指向不同无效主机 ⇒ 预期仍向源容器名发出 DROP/CREATE argv。
# 假 docker 拦截一切调用(零真实容器操作);封闭 PATH 无 psql、无真实 docker。
set -uo pipefail
REPO=/home/ubuntu/dev/relay
FAKE_LOG=/tmp/red09r/out/r2-argv.log; : > "$FAKE_LOG"
echo "== Red-R2 运行(restore-verify.sh 原样@8368cb1;假 docker 拦截,零真实容器)=="
env -i PATH=/tmp/red09r/bin HOME="$HOME" FAKE_LOG="$FAKE_LOG" FAKE_EXIT=79 \
  RELAY_RESTORE_ISOLATED=1 \
  RELAY_RESTORE_CONTAINER='relay-p000-pg' \
  RELAY_DB_URL='postgresql://demo@127.0.0.1:55433/relayp000' \
  bash "$REPO/deploy/restore-verify.sh" /tmp/red09r/bk-valid 'postgresql://demo@invalid-target.invalid:55433' \
  > /tmp/red09r/out/r2-run.log 2>&1
RC=$?
echo "== exit=$RC =="
echo "== 脚本输出 =="; cat /tmp/red09r/out/r2-run.log
echo "== 假 docker 捕获的 argv =="; cat "$FAKE_LOG"
if grep -q 'fail-closed' /tmp/red09r/out/r2-run.log; then
  echo "判定:脚本报 fail-closed(非红,与预期不符)"; exit 1
fi
if grep -q 'docker exec relay-p000-pg psql' "$FAKE_LOG" && grep -q 'DROP DATABASE IF EXISTS relay_restore_v' "$FAKE_LOG"; then
  echo "RED 确认:docker 分支无视 RESTORE_URL 无效主机,DROP/CREATE argv 已发往 RELAY_RESTORE_CONTAINER=relay-p000-pg(假 docker 拦截,零真实执行)"
else
  echo "判定:未观测到危险 argv,红态未复现"; exit 1
fi
