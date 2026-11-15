#!/usr/bin/env bash
# Red-R1:同实例别名绕过(宿主分支)。RESTORE_URL=localhost:55433 与 RELAY_DB_URL=127.0.0.1:55433/relayp000
# 指向同一 PostgreSQL 实例;当前脚本仅做字符串前缀比较 ⇒ 预期守卫失效、危险 DDL argv 发往别名地址。
# 子进程封闭 PATH=/tmp/red09r/bin:psql=假执行器,真实 psql/docker 不可达 ⇒ 零真实 DB/容器触碰。
set -uo pipefail
REPO=/home/ubuntu/dev/relay
FAKE_LOG=/tmp/red09r/out/r1-argv.log; : > "$FAKE_LOG"
export FAKE_LOG FAKE_EXIT=79
echo "== Red-R1 运行(restore-verify.sh 原样@8368cb1;假 psql 拦截,零真实 DB)=="
env -i PATH=/tmp/red09r/bin HOME="$HOME" FAKE_LOG="$FAKE_LOG" FAKE_EXIT=79 \
  RELAY_RESTORE_ISOLATED=1 \
  RELAY_DB_URL='postgresql://demo@127.0.0.1:55433/relayp000' \
  bash "$REPO/deploy/restore-verify.sh" /tmp/red09r/bk-valid 'postgresql://demo@localhost:55433' \
  > /tmp/red09r/out/r1-run.log 2>&1
RC=$?
echo "== exit=$RC =="
echo "== 脚本输出 =="; cat /tmp/red09r/out/r1-run.log
echo "== 假 psql 捕获的 argv =="; cat "$FAKE_LOG"
if grep -q 'fail-closed' /tmp/red09r/out/r1-run.log; then
  echo "判定:脚本报 fail-closed(非红,与预期不符)"; exit 1
fi
if grep -q 'DROP DATABASE IF EXISTS relay_restore_v' "$FAKE_LOG" && grep -q 'localhost:55433' "$FAKE_LOG"; then
  echo "RED 确认:守卫未拦截别名同实例目标,DROP DATABASE argv 已发往 localhost:55433(假执行器拦截,零真实执行)"
else
  echo "判定:未观测到危险 argv,红态未复现"; exit 1
fi
