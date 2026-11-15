#!/usr/bin/env bash
# Relay Artifact 级恢复演练(阶段 E3;09 隔离守卫 + 09R 恢复目标真实身份校验):隔离实例恢复 + 逐项身份核对。
# 用法:RELAY_RESTORE_ISOLATED=1 RELAY_DB_URL=<备份源实例连接串> deploy/restore-verify.sh <备份目录> <隔离实例base连接串>
#   - RELAY_RESTORE_ISOLATED=1 必填(显式声明恢复目标为隔离实例;未声明 ⇒ fail-closed,防恢复误指生产);
#   - RELAY_DB_URL 必填(09R:未提供源实例连接串 ⇒ 无法证明目标≠源实例,零 DDL 拒绝);
#   - 恢复目标真实身份校验(09R 单一入口 restore-target-verify.mjs,任何 DROP/CREATE/导入之前):
#       ① 规范化实例键快速门(回环折叠 localhost/127.*/::1 + 默认端口 + 剥 query)相同 ⇒ 拒绝(同实例别名);
#       ② docker 回退分支:RESTORE_URL 须回环,docker inspect 恢复容器严格绑定(运行中 + 5432/tcp 恰一条
#          映射 + HostIp=127.0.0.1 + HostPort==RESTORE_URL 端口),显式 RELAY_PG_CONTAINER 与恢复容器
#          同名/同容器 ID ⇒ 拒绝(容器名欺骗);docker exec 实际容器内身份探针须与 RESTORE_URL 探针一致
#          (物理执行目标绑定,防 inspect 谎报/漂移);
#       ③ 服务端真值双探针(pg_postmaster_start_time + inet_server_port,零原始数据):源与目标任一不可证
#          ⇒ 拒绝;身份相同 ⇒ 同一物理实例 ⇒ 拒绝(别名/同集群在服务端真值识别,不依赖连接串文本)。
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

# 0) 隔离守卫(任何 DROP/CREATE/导入之前;身份探针本身为只读元数据连接,构成守卫的一部分)
[ "${RELAY_RESTORE_ISOLATED:-}" = "1" ] || refuse "未显式声明 RELAY_RESTORE_ISOLATED=1(恢复目标必须是隔离实例,禁止生产/备份源实例)"
[ -n "${RELAY_DB_URL:-}" ] || refuse "未提供 RELAY_DB_URL(备份源实例连接串):无法证明恢复目标不是备份源实例;拒绝(09R)"
case "$RESTORE_URL" in
  postgresql://* | postgres://*) : ;;
  *) refuse "RESTORE_URL 须为 postgresql:// base 连接串(不带库名)" ;;
esac
# base 形态强校验:允许无路径或仅尾随斜杠,显式拒绝带库名段(Reviewer Round1 M2)
REST_TAIL="${RESTORE_URL#*://*/}"
if [ "$REST_TAIL" != "$RESTORE_URL" ] && [ -n "$REST_TAIL" ]; then
  refuse "RESTORE_URL 须为 base 连接串(不带库名;检测到路径段=${REST_TAIL%%\?*})"
fi
# 0a) 字面同串快速拒绝(保留 09 前缀层;别名/端口缺省等形态由 2c 身份校验承担)
if [[ "$RELAY_DB_URL" == "$RESTORE_URL"* ]]; then
  refuse "恢复目标实例与备份源实例相同(RESTORE_URL 是 RELAY_DB_URL 的实例前缀);拒绝在源/生产实例上恢复"
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

# 2b) 执行分支判定(与后续 DDL 分支同判据:宿主有 psql ⇒ host;否则 docker 回退)+ 临时目录
REST_MODE="host"; command -v psql >/dev/null 2>&1 || REST_MODE="docker"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/relay-restore-verify.XXXXXX")"
cleanup_tmp() { rm -rf "$TMPD" 2>/dev/null || true; }
trap cleanup_tmp EXIT

# 2c) 恢复目标真实身份校验(先于任何 DDL;位于完整性/校验和之后——损坏输入零连接拒绝)(09R 单一入口 restore-target-verify.mjs;零 DDL,任何失败 ⇒ 拒绝)
VERIFY_ARGS=(--source-url "$RELAY_DB_URL" --target-url "$RESTORE_URL")
if [ "$REST_MODE" = "docker" ]; then
  command -v docker >/dev/null 2>&1 || refuse "docker 回退分支要求 docker 可用(宿主无 psql);拒绝"
  docker inspect "$RC" > "$TMPD/rest-inspect.json" 2>/dev/null \
    || refuse "docker inspect 恢复容器失败(${RC}):无法证明 RESTORE_URL 与实际执行容器的绑定;拒绝"
  VERIFY_ARGS+=(--container-inspect-json "$TMPD/rest-inspect.json" --restore-container "$RC")
  if [ -n "${RELAY_PG_CONTAINER:-}" ]; then
    [ "$RELAY_PG_CONTAINER" = "$RC" ] && refuse "RELAY_RESTORE_CONTAINER 与源容器同名(${RC}):容器名欺骗形态;拒绝"
    if docker inspect "$RELAY_PG_CONTAINER" > "$TMPD/src-inspect.json" 2>/dev/null; then
      VERIFY_ARGS+=(--source-container-inspect-json "$TMPD/src-inspect.json")
    fi # 源容器 inspect 失败不阻塞:源实例身份由 2c 真值层探针承担(此为深度防御)
  fi
fi
VERIFY_OUT="$(node "$SCRIPT_DIR/restore-target-verify.mjs" "${VERIFY_ARGS[@]}")" || {
  printf '%s\n' "$VERIFY_OUT" >&2
  refuse "恢复目标身份校验未通过(见上):无法证明目标为隔离实例且非备份源实例;零 DDL 拒绝"
}
printf '%s\n' "$VERIFY_OUT"
TARGET_START_TIME="$(printf '%s\n' "$VERIFY_OUT" | sed -n 's/^RESTORE_TARGET_START_TIME=//p')"
[ -n "$TARGET_START_TIME" ] || refuse "身份校验输出缺少 RESTORE_TARGET_START_TIME(工具输出异常);拒绝"

# 2d) docker 回退分支执行面绑定(防 inspect 谎报/漂移):实际容器内身份 == RESTORE_URL 探针身份
if [ "$REST_MODE" = "docker" ]; then
  EXEC_TS="$(docker exec "$RC" psql -U postgres -tA -c "SELECT pg_postmaster_start_time()::text" 2>/dev/null | tr -d '\r\n')"
  [ -n "$EXEC_TS" ] || refuse "docker exec 身份探针失败(${RC} 内 psql 不可用或容器非运行中):无法证明物理执行目标;拒绝"
  [ "$EXEC_TS" = "$TARGET_START_TIME" ] \
    || refuse "docker exec 实际容器身份与 RESTORE_URL 探针身份不一致(postmaster 启动时刻不同):声明目标≠物理执行目标;拒绝"
fi

# 3) DB 恢复(隔离实例;每次演练新建干净库;失败 trap 清理本库)
T_DB="relay_restore_v$(date +%s)_$RANDOM"
CREATED=0
cleanup_db() {
  rc=$?
  cleanup_tmp # EXIT trap 已被本函数替换:临时目录(inspect JSON)在此一并清理
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
