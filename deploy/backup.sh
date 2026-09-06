#!/usr/bin/env bash
# SQLite 联机一致性备份：先校验，再压缩发布；默认保留 14 天。
set -euo pipefail

BACKUP_DB="${OMNI_DB:-/var/lib/omnichat/omnichat.db}"
BACKUP_DIR="${OMNI_BACKUP_DIR:-/var/backups/omnichat}"
BACKUP_KEEP_DAYS="${OMNI_BACKUP_KEEP_DAYS:-14}"

if [[ ! "$BACKUP_KEEP_DAYS" =~ ^[0-9]+$ ]] || (( BACKUP_KEEP_DAYS < 1 || BACKUP_KEEP_DAYS > 365 )); then
  echo "OMNI_BACKUP_KEEP_DAYS 必须是 1-365 的整数" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_DB" ]]; then
  echo "数据库尚未创建，跳过首次备份"
  exit 0
fi
command -v sqlite3 >/dev/null || { echo "缺少 sqlite3" >&2; exit 1; }
command -v gzip >/dev/null || { echo "缺少 gzip" >&2; exit 1; }

install -d -m 0700 "$BACKUP_DIR"
BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_TMP="$BACKUP_DIR/.wzzscrm-$BACKUP_STAMP.tmp"
BACKUP_OUT="$BACKUP_DIR/wzzscrm-$BACKUP_STAMP.db.gz"

cleanup() {
  rm -f -- "$BACKUP_TMP"
}
trap cleanup EXIT

# SQLite .backup 会把 WAL 中已提交事务一并纳入，数据库在线写入时仍保持一致。
sqlite3 "$BACKUP_DB" ".backup '$BACKUP_TMP'"
BACKUP_INTEGRITY="$(sqlite3 "$BACKUP_TMP" 'PRAGMA integrity_check;' | head -1)"
if [[ "$BACKUP_INTEGRITY" != "ok" ]]; then
  echo "备份完整性校验失败：$BACKUP_INTEGRITY" >&2
  exit 1
fi
gzip -c "$BACKUP_TMP" > "$BACKUP_OUT"
chmod 0600 "$BACKUP_OUT"

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'wzzscrm-*.db.gz' -o -name 'omnichat-*.db.gz' \) \
  -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.wzzscrm-*.tmp' -mtime +1 -delete

echo "备份完成：${BACKUP_OUT}；保留 ${BACKUP_KEEP_DAYS} 天"
