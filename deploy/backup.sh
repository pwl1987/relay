#!/usr/bin/env bash
# Relay Artifact 级备份(阶段 E3;RELAY-BACKUP-INTEGRITY-09 作用域修复):pg_dump + Artifact 打包。
# 用法:RELAY_DB_URL=... RELAY_BACKUP_SCHEMA=<目标Relay schema|all> deploy/backup.sh <输出目录>
#   - RELAY_BACKUP_SCHEMA 必填:<schema> = 仅该 Relay schema(pg_dump -n + schema 限定审计索引 +
#     manifest 只认该 schema);all = 显式旧版整库/跨 schema 兼容模式(绝不静默回退)。
#   - 未声明/目标不存在/缺 Relay 表/库名缺失 ⇒ fail-closed 拒绝且零产物(backup-validate.mjs 单一入口,
#     仅读 information_schema,零原始数据查询)。
#   - docker 回退两分支同源:容器=RELAY_PG_CONTAINER(默认 relay-p000-pg),库名=RELAY_DB_URL 末段,
#     审计索引不再硬编码容器/库/未限定表名(修复 F-1)。
#   - 失败 trap 清理本 STAMP 产物;成功以 backup-<STAMP>.done 原子完成标记收尾(随校验和一并受核)。
# Artifact 面 = 已交付候选工作区产物(stage 仓库/交付远端克隆面由外部 Git 自身保证)+ 证据文件 + 审计关联清单。
set -euo pipefail
OUT="${1:?用法:backup.sh <输出目录>}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 0) 唯一入口声明与目标校验(任何连接/写文件之前;失败即拒绝,零产物)
DB_URL="${RELAY_DB_URL:?需 RELAY_DB_URL}"
BACKUP_SCHEMA="${RELAY_BACKUP_SCHEMA:?需 RELAY_BACKUP_SCHEMA(目标 Relay schema 或 all;拒绝静默整库)}"
[[ "$DB_URL" == *://* ]] || { echo "[backup] fail-closed:RELAY_DB_URL 非 URL 形态;拒绝" >&2; exit 2; }
DB_NAME="${DB_URL##*/}"
DB_NAME="${DB_NAME%%\?*}" # 剥 query/fragment 段,与 backup-validate 的 URL 解析一致(Reviewer Round1 M1)
DB_NAME="${DB_NAME%%#*}"
[ -n "$DB_NAME" ] || { echo "[backup] fail-closed:RELAY_DB_URL 缺少库名;拒绝" >&2; exit 2; }
if [ "$BACKUP_SCHEMA" != "all" ] && ! [[ "$BACKUP_SCHEMA" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "[backup] fail-closed:目标 schema 名非法(须 ^[A-Za-z_][A-Za-z0-9_]*$);拒绝" >&2
  exit 2
fi
node "$SCRIPT_DIR/backup-validate.mjs" "$BACKUP_SCHEMA"
CONT="${RELAY_PG_CONTAINER:-relay-p000-pg}"

# 失败清理:只清理本 STAMP 产物(不动输出目录内其他备份),不掩盖退出码
cleanup_failed() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$OUT/db-$STAMP.sql" "$OUT/artifacts-manifest-$STAMP.json" "$OUT/audit-index-$STAMP.txt" \
      "$OUT/backup-$STAMP.filelist" "$OUT/backup-$STAMP.done" 2>/dev/null || true
    echo "[backup] 失败(exit=$rc):已清理本次 STAMP=$STAMP 残留产物" >&2
  fi
}
trap cleanup_failed EXIT

mkdir -p "$OUT"

# 1) 数据库 dump(作用域显式:all=整库含 CREATE SCHEMA(旧版兼容语义);<schema>=-n 限定)
if command -v pg_dump >/dev/null 2>&1; then
  if [ "$BACKUP_SCHEMA" = "all" ]; then
    pg_dump "$DB_URL" --no-owner --no-privileges --file "$OUT/db-$STAMP.sql"
  else
    pg_dump "$DB_URL" -n "$BACKUP_SCHEMA" --no-owner --no-privileges --file "$OUT/db-$STAMP.sql"
  fi
else
  # 容器回退:容器/库名与审计索引同源派生(指他库/他容器时不再静默备错)
  if [ "$BACKUP_SCHEMA" = "all" ]; then
    docker exec "$CONT" pg_dump -U postgres --no-owner --no-privileges "$DB_NAME" > "$OUT/db-$STAMP.sql"
  else
    docker exec "$CONT" pg_dump -U postgres --no-owner --no-privileges -n "$BACKUP_SCHEMA" "$DB_NAME" > "$OUT/db-$STAMP.sql"
  fi
fi
echo "[backup] db dump: $OUT/db-$STAMP.sql ($(wc -c < "$OUT/db-$STAMP.sql") bytes)"

# 2) Artifact:已交付候选产物(manifest 只认目标 schema;all=显式跨 schema 旧版聚合)
node "$SCRIPT_DIR/backup-manifest.mjs" "$OUT" "$OUT/artifacts-manifest-$STAMP.json"

# 3) 审计关联清单(两条路径同源:run_psql helper;schema 限定;all=逐 schema 聚合)
run_psql() { # $1=SQL(输出 -tA)
  if command -v psql >/dev/null 2>&1; then
    psql "$DB_URL" -tA -c "$1"
  else
    docker exec "$CONT" psql -U postgres -d "$DB_NAME" -tA -c "$1"
  fi
}
if [ "$BACKUP_SCHEMA" = "all" ]; then
  AUDIT_SQL=""
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    if ! [[ "$s" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "[backup] fail-closed:发现非白名单 schema 名($s)持有 audit_events;拒绝聚合" >&2
      exit 2
    fi
    part="(SELECT seq || '|' || ts || '|' || actor || '|' || action FROM \"$s\".audit_events ORDER BY seq)"
    if [ -z "$AUDIT_SQL" ]; then AUDIT_SQL="$part"; else AUDIT_SQL="$AUDIT_SQL UNION ALL $part"; fi
  done < <(run_psql "SELECT table_schema FROM information_schema.tables WHERE table_name='audit_events' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1")
  [ -n "$AUDIT_SQL" ] || { echo "[backup] fail-closed:all 模式下全库无 audit_events 表;拒绝生成空索引" >&2; exit 2; }
else
  AUDIT_SQL="SELECT seq || '|' || ts || '|' || actor || '|' || action FROM \"$BACKUP_SCHEMA\".audit_events ORDER BY seq"
fi
run_psql "$AUDIT_SQL" > "$OUT/audit-index-$STAMP.txt"
echo "[backup] audit index: $(wc -l < "$OUT/audit-index-$STAMP.txt") 行"

# 4) 汇总清单 + 原子完成标记(先于校验和,使其一并受核) + SHA
find "$OUT" -type f -newer "$OUT/db-$STAMP.sql" -o -type f -name "*$STAMP*" | sort > "$OUT/backup-$STAMP.filelist"
printf 'backup-complete\nstamp=%s\nschema=%s\ngenerated_at=%s\n' "$STAMP" "$BACKUP_SCHEMA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/backup-$STAMP.done"
( cd "$OUT" && sha256sum *"$STAMP"* > "checksums-$STAMP.sha256" )
echo "[backup] 完成:$OUT($STAMP;schema=$BACKUP_SCHEMA;恢复演练:deploy/restore-verify.sh)"
