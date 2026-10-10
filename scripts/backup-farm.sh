#!/usr/bin/env bash
# Consistent server-side backup. Run in a maintenance window; web/API and image pushes pause briefly.
# Usage: bash scripts/backup-farm.sh /secure/backups [-f compose.yaml -f compose.override.yaml ...]
set -euo pipefail
umask 077
if [[ $# -lt 1 ]]; then printf 'Usage: %s BACKUP_DIRECTORY [docker compose options...]\n' "$0" >&2; exit 2; fi
backup_root=$1
shift
compose=(docker compose "$@")
for tool in docker tar gzip sha256sum; do command -v "$tool" >/dev/null; done
[[ -d "$backup_root" ]] || mkdir -p -- "$backup_root"
backup_root=$(cd -- "$backup_root" && pwd -P)
backup_dir="$backup_root/farm-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$backup_dir"

# Archive bytes must bypass Docker logs and use the existing volumes read-only.
registry_id=$("${compose[@]}" ps -a -q registry)
server_id=$("${compose[@]}" ps -a -q server)
[[ -n "$registry_id" && -n "$server_id" ]] || { printf 'Create server and registry containers before backup.\n' >&2; exit 1; }
registry_image=$(docker inspect --format '{{.Image}}' "$registry_id")
server_image=$(docker inspect --format '{{.Image}}' "$server_id")
app_store_dir=/data/apps
while IFS= read -r setting; do
  case "$setting" in APP_STORE_DIR=*) app_store_dir=${setting#APP_STORE_DIR=} ;; esac
done < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$server_id")
archive=(docker run --rm --pull never --log-driver none --network none --read-only
  --cpus 1 --memory 256m --pids-limit 64 --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH
  --security-opt no-new-privileges)
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
"${archive[@]}" --volumes-from "$registry_id:ro" --entrypoint tar "$registry_image" -C /var/lib/registry -cf - . | gzip -1 > "$backup_dir/registry-data.tar.gz"
"${archive[@]}" --volumes-from "$server_id:ro" --entrypoint tar "$server_image" -C "$app_store_dir" -cf - . | gzip -1 > "$backup_dir/app-store.tar.gz"
tar -tzf "$backup_dir/registry-data.tar.gz" > /dev/null
tar -tzf "$backup_dir/app-store.tar.gz" > /dev/null
"${compose[@]}" exec -T postgres pg_restore --list < "$backup_dir/postgres.dump" > /dev/null
(cd -- "$backup_dir" && sha256sum postgres.dump registry-data.tar.gz app-store.tar.gz > SHA256SUMS)
printf 'Backup complete: %s\nKeep SECRETS_KEY and deployment credentials separately; restore all three files together.\n' "$backup_dir"
