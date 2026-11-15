#!/usr/bin/env bash
# Relay Artifact 级恢复演练(阶段 E3;RELAY-BACKUP-INTEGRITY-09 隔离守卫修复):隔离实例恢复 + 逐项身份核对。
# 用法:RELAY_RESTORE_ISOLATED=1 deploy/restore-verify.sh <备份目录> <隔离实例base连接串>
#   - RELAY_RESTORE_ISOLATED=1 必填(显式声明恢复目标为隔离实例;未声明 ⇒ fail-closed,防恢复误指生产);
#   - 恢复目标实例不得与备份源实例相同(与 RELAY_DB_URL 做实例前缀比较 ⇒ fail-closed);
#   - RESTORE_URL 统一为不带库名的 base 连接串(修复旧版 psql 分支与 RESTORE_TARGET_URL 推导的形态矛盾);
#   - 备份目录须唯一完成标记/唯一 db dump/manifest/审计索引/校验和(失败残留或多义目录 ⇒ fail-closed);
#   - 校验和先于任何恢复动作核验;恢复库带随机后缀,失败 trap 清理本库;成功保留供人工核对(Runbook 可删)。
set -euo pipefail
BK="${1:?用法:restore-verify.sh <备份目录> <隔离实例base连接串>}"
RESTORE_URL="${2:?需隔离实例base连接串(不带库名)}"
RC="${RELAY_RESTORE_CONTAINER:-relay-restore-verify}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T0="$(date +%s)"

refuse() { echo "[restore] fail-closed:$1" >&2; exit 2; }

# 0) 隔离守卫(任何 DROP/CREATE/连接之前)
[ "${RELAY_RESTORE_ISOLATED:-}" = "1" ] || refuse "未显式声明 RELAY_RESTORE_ISOLATED=1(恢复目标必须是隔离实例,禁止生产/备份源实例)"
if [ -n "${RELAY_DB_URL:-}" ] && [[ "$RELAY_DB_URL" == "$RESTORE_URL"* ]]; then
  refuse "恢复目标实例与备份源实例相同(RESTORE_URL 是 RELAY_DB_URL 的实例前缀);拒绝在源/生产实例上恢复"
fi
case "$RESTORE_URL" in
  postgresql://* | postgres://*) : ;;
  *) refuse "RESTORE_URL 须为 postgresql:// base 连接串(不带库名)" ;;
esac
# base 形态强校验:允许无路径或仅尾随斜杠,显式拒绝带库名段(Reviewer Round1 M2)
REST_TAIL="${RESTORE_URL#*://*/}"
if [ "$REST_TAIL" != "$RESTORE_URL" ] && [ -n "$REST_TAIL" ]; then
  refuse "RESTORE_URL 须为 base 连接串(不带库名;检测到路径段=${REST_TAIL%%\?*})"
fi

# 1) 备份目录完整性(唯一性 + 完成标记;先于任何恢复动作)
[ "$(ls "$BK"/backup-*.done 2>/dev/null | wc -l)" -eq 1 ] || refuse "完成标记数量≠1(缺失=备份失败残留或不完整);拒绝恢复"
[ "$(ls "$BK"/db-*.sql 2>/dev/null | wc -l)" -eq 1 ] || refuse "db dump 数量≠1(多义备份目录);拒绝恢复"
[ "$(ls "$BK"/artifacts-manifest-*.json 2>/dev/null | wc -l)" -eq 1 ] || refuse "manifest 数量≠1;拒绝恢复"
[ "$(ls "$BK"/audit-index-*.txt 2>/dev/null | wc -l)" -eq 1 ] || refuse "audit index 数量≠1;拒绝恢复"
[ "$(ls "$BK"/checksums-*.sha256 2>/dev/null | wc -l)" -eq 1 ] || refuse "checksums 数量≠1;拒绝恢复"
MANIFEST="$(ls "$BK"/artifacts-manifest-*.json | head -1)"
SQLFILE="$(ls "$BK"/db-*.sql | head -1)"
AUDITFILE="$(ls "$BK"/audit-index-*.txt | head -1)"
TARGET_SCHEMA="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!m||typeof m.targetSchema!=="string"||!m.targetSchema){console.error("[restore] fail-closed:manifest 缺少 targetSchema(legacy/损坏);拒绝");process.exit(2)}console.log(m.targetSchema)' "$MANIFEST")"
if [ "$TARGET_SCHEMA" != "all" ] && ! [[ "$TARGET_SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  refuse "manifest.targetSchema 非法(${TARGET_SCHEMA});拒绝恢复"
fi
# 注:schema 模式的 -n dump 自带 CREATE SCHEMA(红态实证),无需预建;身份核对由 check.mjs 承担。

# 2) 校验和先核验(损坏/篡改输入在触碰任何实例前拒绝)
( cd "$BK" && sha256sum -c "$(ls checksums-*.sha256 | head -1)" >/dev/null ) || refuse "备份校验和不一致(损坏/篡改);拒绝恢复"

# 3) DB 恢复(隔离实例;每次演练新建干净库;失败 trap 清理本库)
T_DB="relay_restore_v$(date +%s)_$RANDOM"
CREATED=0
cleanup_db() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$CREATED" -eq 1 ]; then
    if command -v psql >/dev/null 2>&1; then
      psql "$RESTORE_URL/postgres" -c "DROP DATABASE IF EXISTS $T_DB" -q 2>/dev/null || true
    else
      docker exec "$RC" psql -U postgres -c "DROP DATABASE IF EXISTS $T_DB" -q 2>/dev/null || true
    fi
    echo "[restore] 失败(exit=$rc):已清理本次恢复库 $T_DB" >&2
  fi
  exit $rc
}
trap cleanup_db EXIT

if command -v psql >/dev/null 2>&1; then
  psql "$RESTORE_URL/postgres" -c "DROP DATABASE IF EXISTS $T_DB" -q
  psql "$RESTORE_URL/postgres" -c "CREATE DATABASE $T_DB" -q
  CREATED=1 # 库已真实建立:此后任一步(导入/核对)失败都必须清理本库(Reviewer Round1 Major-1)
  psql "$RESTORE_URL/$T_DB" -v ON_ERROR_STOP=1 -q -f "$SQLFILE"
else
  docker exec "$RC" psql -U postgres -c "DROP DATABASE IF EXISTS $T_DB" -q
  docker exec "$RC" psql -U postgres -c "CREATE DATABASE $T_DB" -q
  CREATED=1 # 库已真实建立:此后任一步(导入/核对)失败都必须清理本库(Reviewer Round1 Major-1)
  docker exec -i "$RC" psql -U postgres -d "$T_DB" -v ON_ERROR_STOP=1 -q < "$SQLFILE"
fi
export RESTORE_TARGET_URL="${RESTORE_URL%/}/$T_DB"
echo "[restore] 目标库:$T_DB"
T1="$(date +%s)"
echo "[restore] DB 恢复完成:$((T1 - T0))s"

# 4) 身份交叉核对(manifest+审计索引 ↔ 恢复库;目标 schema 唯一来源=manifest.targetSchema)
RESTORE_TARGET_URL="$RESTORE_TARGET_URL" node "$SCRIPT_DIR/restore-verify-check.mjs" "$MANIFEST" "$AUDITFILE"
T2="$(date +%s)"
echo "[restore] 演练总耗时:$((T2 - T0))s(隔离守卫+校验和先行+身份核对全过);外部 Git 状态不在本脚本范围(delivery 记录的 remote HEAD 以 GitHub 实际为准;Reconcile 语义见 V05/V10)"
