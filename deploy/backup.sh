#!/usr/bin/env bash
# Nightly backup of the SQLite database and uploaded card photos.
#
#   sudo cp backup.sh /usr/local/bin/crazed-tcg-backup
#   sudo chmod +x /usr/local/bin/crazed-tcg-backup
#   sudo crontab -e
#     15 3 * * * /usr/local/bin/crazed-tcg-backup
#
# Copy the resulting archives off the VPS — a backup on the same disk is not a backup.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/crazed-tcg}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/crazed-tcg}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

# .backup is the safe way to copy a live SQLite database — never cp the file
# while the server is writing to it.
sqlite3 "$APP_DIR/data/store.db" ".backup '$BACKUP_DIR/store-$STAMP.db'"
gzip -f "$BACKUP_DIR/store-$STAMP.db"

tar -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" -C "$APP_DIR" uploads

find "$BACKUP_DIR" -type f -mtime "+$KEEP_DAYS" -delete

echo "Backed up to $BACKUP_DIR (store-$STAMP.db.gz, uploads-$STAMP.tar.gz)"
