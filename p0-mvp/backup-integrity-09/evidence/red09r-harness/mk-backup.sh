#!/usr/bin/env bash
# 合成假备份目录:通过完整性五项唯一性+校验和(纯文件,零真实数据)。
set -euo pipefail
DIR="$1"; STAMP="20260101T000000Z"
mkdir -p "$DIR"
printf 'backup-complete\nstamp=%s\nschema=p01a_red\ngenerated_at=2026-01-01T00:00:00Z\n' "$STAMP" > "$DIR/backup-$STAMP.done"
printf '\\connect p01a_red\nCREATE TABLE p01a_red.t (id int);\n' > "$DIR/db-$STAMP.sql"
printf '{"targetSchema":"p01a_red","delivered":[],"generatedAt":"2026-01-01T00:00:00Z"}\n' > "$DIR/artifacts-manifest-$STAMP.json"
printf '1|2026-01-01T00:00:00Z|red|RED_LINE\n' > "$DIR/audit-index-$STAMP.txt"
( cd "$DIR" && sha256sum "db-$STAMP.sql" "artifacts-manifest-$STAMP.json" "audit-index-$STAMP.txt" "backup-$STAMP.done" > "checksums-$STAMP.sha256" )
echo "合成备份目录就绪:$DIR"
