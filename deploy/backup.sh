#!/usr/bin/env bash
# Relay Artifact 级备份(阶段 E3):pg_dump + Artifact 打包(不只 13 表)。
# 用法:RELAY_DB_URL=... deploy/backup.sh <输出目录>
# Artifact 面 = 已交付候选工作区产物(stage 仓库/交付远端克隆面由外部 Git 自身保证)+ 证据文件 + 审计关联清单。
set -euo pipefail
OUT="${1:?用法:backup.sh <输出目录>}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# 1) 数据库整库 dump(宿主 pg_dump;无则退回 docker exec relay-p000-pg——与测试同源)
DB_URL="${RELAY_DB_URL:?需 RELAY_DB_URL}"
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DB_URL" --no-owner --no-privileges --file "$OUT/db-$STAMP.sql"
else
  docker exec relay-p000-pg pg_dump -U postgres --no-owner --no-privileges relayp000 > "$OUT/db-$STAMP.sql"
fi
echo "[backup] db dump: $OUT/db-$STAMP.sql ($(wc -c < "$OUT/db-$STAMP.sql") bytes)"

# 2) Artifact:已交付候选产物(从 DB 定位 stage 仓库与交付面,打包其文件内容)
node "/home/ubuntu/dev/relay/deploy/backup-manifest.mjs" "$OUT" "$OUT/artifacts-manifest-$STAMP.json"

# 3) 审计关联清单(审计行随 DB dump 已含;此处另导出纯文本索引便于人工核对)
if command -v psql >/dev/null 2>&1; then
  psql "$DB_URL" -tA -c "SELECT seq || '|' || ts || '|' || actor || '|' || action FROM audit_events ORDER BY seq" > "$OUT/audit-index-$STAMP.txt"
else
  docker exec relay-p000-pg psql -U postgres -d relayp000 -tA -c "SELECT seq || '|' || ts || '|' || actor || '|' || action FROM audit_events ORDER BY seq" > "$OUT/audit-index-$STAMP.txt"
fi
echo "[backup] audit index: $(wc -l < "$OUT/audit-index-$STAMP.txt") 行"

# 4) 汇总清单 + SHA
find "$OUT" -type f -newer "$OUT/db-$STAMP.sql" -o -type f -name "*$STAMP*" | sort > "$OUT/backup-$STAMP.filelist"
( cd "$OUT" && sha256sum *"$STAMP"* > "checksums-$STAMP.sha256" )
echo "[backup] 完成:$OUT($STAMP;恢复演练:deploy/restore-verify.sh)"
