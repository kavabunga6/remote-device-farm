#!/usr/bin/env bash
# Consistent server-side backup. Run in a maintenance window; web/API and image pushes pause briefly.
# Usage: bash scripts/backup-farm.sh /secure/backups [-f compose.yaml -f compose.override.yaml ...]
set -euo pipefail
umask 077
if [[ $# -lt 1 ]]; then printf 'Usage: %s BACKUP_DIRECTORY [docker compose options...]\n' "$0" >&2; exit 2; fi
backup_root=$1
shift
compose=(docker compose "$@")
for tool in docker tar sha256sum; do command -v "$tool" >/dev/null; done
[[ -d "$backup_root" ]] || mkdir -p -- "$backup_root"
backup_root=$(cd -- "$backup_root" && pwd -P)
backup_dir="$backup_root/farm-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$backup_dir"
# Preserve pre-existing stopped services; never start a service that was stopped before the backup.
running=$("${compose[@]}" ps --status running --services)
resume=()
for service in web server registry; do
  if printf '%s\n' "$running" | grep -Fxq "$service"; then resume+=("$service"); fi
done
restore_running() {
  if (( ${#resume[@]} )); then "${compose[@]}" start "${resume[@]}"; fi
}
trap restore_running EXIT
if (( ${#resume[@]} )); then "${compose[@]}" stop "${resume[@]}"; fi
"${compose[@]}" exec -T postgres sh -ec 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_dir/postgres.dump"
"${compose[@]}" run --rm --no-deps -T --entrypoint tar registry -C /var/lib/registry -czf - . > "$backup_dir/registry-data.tar.gz"
"${compose[@]}" run --rm --no-deps -T --entrypoint sh server -ec 'tar -C "${APP_STORE_DIR:-/data/apps}" -czf - .' > "$backup_dir/app-store.tar.gz"
tar -tzf "$backup_dir/registry-data.tar.gz" > /dev/null
tar -tzf "$backup_dir/app-store.tar.gz" > /dev/null
"${compose[@]}" exec -T postgres pg_restore --list < "$backup_dir/postgres.dump" > /dev/null
(cd -- "$backup_dir" && sha256sum postgres.dump registry-data.tar.gz app-store.tar.gz > SHA256SUMS)
printf 'Backup complete: %s\nKeep SECRETS_KEY and deployment credentials separately; restore all three files together.\n' "$backup_dir"
