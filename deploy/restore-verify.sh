#!/usr/bin/env bash
# Relay Artifact 级恢复演练(阶段 E3):隔离实例恢复 + Artifact 逐项核对。
# 用法:deploy/restore-verify.sh <备份目录> <隔离实例连接串>
# 核对:①DB 恢复(行数+关键面);②Artifact manifest 中的交付记录与恢复后 DB 一致;③恢复时间/窗口记录。
set -euo pipefail
BK="${1:?用法:restore-verify.sh <备份目录> <隔离连接串>}"
RESTORE_URL="${2:?需隔离实例连接串}"
# 演练容器名(默认 relay-restore-verify;容器内需有 psql;可用 RELAY_RESTORE_CONTAINER 覆盖)
RC="${RELAY_RESTORE_CONTAINER:-relay-restore-verify}"
T0="$(date +%s)"

# 1) DB 恢复(隔离实例;每次演练新建干净库——整库 dump 含 CREATE SCHEMA,重复恢复会撞)
SQLFILE="$(ls "$BK"/db-*.sql | head -1)"
TARGET_DB="relay_restore_v$(date +%s)"
if command -v psql >/dev/null 2>&1; then
  psql "$RESTORE_URL/postgres" -c "DROP DATABASE IF EXISTS $TARGET_DB" -q
  psql "$RESTORE_URL/postgres" -c "CREATE DATABASE $TARGET_DB" -q
  psql "$RESTORE_URL/$TARGET_DB" -v ON_ERROR_STOP=1 -q -f "$SQLFILE"
else
  docker exec "$RC" psql -U postgres -c "DROP DATABASE IF EXISTS $TARGET_DB" -q
  docker exec "$RC" psql -U postgres -c "CREATE DATABASE $TARGET_DB" -q
  docker exec -i "$RC" psql -U postgres -d "$TARGET_DB" -v ON_ERROR_STOP=1 -q < "$SQLFILE"
fi
export RESTORE_TARGET_URL="${RESTORE_URL%/*}/$TARGET_DB"
echo "[restore] 目标库:$TARGET_DB"
T1="$(date +%s)"
echo "[restore] DB 恢复完成:$((T1 - T0))s"

# 2) Artifact manifest 与恢复后 DB 交叉核对
MANIFEST="$(ls "$BK"/artifacts-manifest-*.json | head -1)"
RESTORE_TARGET_URL="$RESTORE_TARGET_URL" node "/home/ubuntu/dev/relay/deploy/restore-verify-check.mjs" "$MANIFEST" "$MANIFEST" "$RESTORE_URL"

# 3) 校验和核对(备份完整性)
( cd "$BK" && sha256sum -c "$(ls checksums-*.sha256 | head -1)" >/dev/null && echo "[restore] 备份校验和全部一致 ✓" )
T2="$(date +%s)"
echo "[restore] 演练总耗时:$((T2 - T0))s;外部 Git 状态不在本脚本范围(delivery 记录的 remote HEAD 以 GitHub 实际为准;Reconcile 语义见 V05/V10)"
