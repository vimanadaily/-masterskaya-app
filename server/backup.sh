#!/bin/sh
set -eu
umask 077
mkdir -p /backups
while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="/backups/masterskaya-${stamp}.dump"
  echo "backup_start ${stamp}"
  if pg_dump -h "$DB_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner -f "$target"; then
    echo "backup_success ${stamp}"
  else
    rm -f "$target"
    echo "backup_failed ${stamp}" >&2
  fi
  find /backups -maxdepth 1 -type f -name "masterskaya-*.dump" -mtime +29 -delete
  sleep 86400
done
