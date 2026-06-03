#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${FSUSBLOG_BACKUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_ROOT="${FSUSBLOG_BACKUP_ROOT:-${ROOT_DIR}/.tmp/backups}"
WORK_DIR="${FSUSBLOG_BACKUP_WORK_DIR:-${BACKUP_ROOT}/site-${RUN_ID}.work}"
PACKAGE_PATH="${FSUSBLOG_BACKUP_PACKAGE:-${BACKUP_ROOT}/fsusblog-site-${RUN_ID}.tar.gz}"
DRY_RUN="${FSUSBLOG_BACKUP_DRY_RUN:-0}"
DATA_ROOT="${FSUSBLOG_DATA_ROOT:-${ROOT_DIR}/src/backend/bin/data}"
WEB_ROOT="${FSUSBLOG_WEB_ROOT:-${ROOT_DIR}/src/backend/wwwroot}"
UPLOADS_DIR="${FSUSBLOG_UPLOADS_DIR:-${WEB_ROOT}/uploads}"
AOT_DIR="${FSUSBLOG_AOT_DIR:-${WEB_ROOT}/aot-cache}"
SEARCH_DIR="${FSUSBLOG_SEARCH_DIR:-${WEB_ROOT}/search}"
KEYRING_DIR="${FSUSBLOG_DATA_PROTECTION_KEY_RING:-${DATA_ROOT}/data-protection-keys}"
REPORT_PATH="${BACKUP_ROOT}/backup-site-${RUN_ID}.json"

status="ok"
blockers=()
checks=()

log() {
  printf '[backup-site] %s\n' "$1"
}

add_check() {
  checks+=("$1:$2")
}

add_blocker() {
  status="blocked"
  blockers+=("$1")
}

json_string_array() {
  if (( "$#" == 0 )); then
    printf '[]'
    return
  fi

  printf '%s\n' "$@" | jq -R . | jq -s .
}

write_report() {
  local checks_json blockers_json
  checks_json="$(json_string_array "${checks[@]}")"
  blockers_json="$(json_string_array "${blockers[@]}")"
  jq -n \
    --arg status "$status" \
    --arg runId "$RUN_ID" \
    --arg packagePath "$PACKAGE_PATH" \
    --arg backupRoot "$BACKUP_ROOT" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson checks "$checks_json" \
    --argjson blockers "$blockers_json" \
    '{
      status: $status,
      runId: $runId,
      generatedAt: $generatedAt,
      packagePath: $packagePath,
      backupRoot: $backupRoot,
      checks: $checks,
      blockers: $blockers
    }' > "$REPORT_PATH"
  log "wrote $REPORT_PATH"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || add_blocker "command-missing:$1"
}

connection_value() {
  local key="$1" conn="$2"
  printf '%s' "$conn" | tr ';' '\n' | awk -F= -v wanted="$key" 'tolower($1)==tolower(wanted) {print $2; exit}'
}

dump_database() {
  local conn="${FSUSBLOG_POSTGRES_URL:-${DATABASE_URL:-${ConnectionStrings__DefaultConnection:-}}}"
  local target="$WORK_DIR/database.dump"
  if [[ -z "$conn" ]]; then
    add_blocker "database-connection-missing"
    return
  fi

  if [[ "$conn" == *"="* && "$conn" == *";"* ]]; then
    local host port db user password
    host="$(connection_value Host "$conn")"
    port="$(connection_value Port "$conn")"
    db="$(connection_value Database "$conn")"
    user="$(connection_value Username "$conn")"
    password="$(connection_value Password "$conn")"
    [[ -n "$host" && -n "$db" && -n "$user" ]] || {
      add_blocker "database-connection-invalid"
      return
    }
    PGPASSWORD="$password" pg_dump -h "$host" -p "${port:-5432}" -U "$user" -d "$db" --format=custom --file="$target"
  else
    pg_dump "$conn" --format=custom --file="$target"
  fi

  add_check "database" "dumped"
}

pack_tree() {
  local source="$1" target="$2" label="$3"
  local empty_dir="$WORK_DIR/empty-${label}"
  if [[ -d "$source" ]]; then
    tar -czf "$target" -C "$source" .
    add_check "$label" "packed"
    return
  fi

  mkdir -p "$empty_dir"
  tar -czf "$target" -C "$empty_dir" .
  add_check "$label" "empty"
}

pack_keyring() {
  if [[ ! -d "$KEYRING_DIR" ]]; then
    add_blocker "data-protection-keyring-missing"
    return
  fi

  tar -czf "$WORK_DIR/data-protection-keyring.tar.gz" -C "$KEYRING_DIR" .
  add_check "data-protection-keyring" "packed"
}

sanitize_config() {
  local config_dir="$WORK_DIR/config.redacted"
  mkdir -p "$config_dir"
  shopt -s nullglob
  local files=("$ROOT_DIR"/src/backend/appsettings*.json "$ROOT_DIR"/appsettings*.json)
  shopt -u nullglob
  if (( "${#files[@]}" == 0 )); then
    add_check "config" "empty"
  fi

  for file in "${files[@]}"; do
    jq 'walk(if type == "object" then with_entries(if (.key | test("(?i)(secret|password|token|connection|string|key)")) then .value = "<redacted>" else . end) else . end)' \
      "$file" > "$config_dir/$(basename "$file")"
  done

  env | sort | awk -F= '
    /^FSUSBLOG_/ {
      key=$1
      value=$2
      if (tolower(key) ~ /(secret|password|token|key|connection|string)/) value="<redacted>"
      print key "=" value
    }' > "$config_dir/environment.redacted.txt"
  tar -czf "$WORK_DIR/config.redacted.tar.gz" -C "$config_dir" .
  add_check "config" "redacted"
}

write_manifest_file() {
  jq -n \
    --arg runId "$RUN_ID" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg database "database.dump" \
    --arg uploads "uploads.tar.gz" \
    --arg keyring "data-protection-keyring.tar.gz" \
    --arg config "config.redacted.tar.gz" \
    --arg aot "aot-cache.tar.gz" \
    --arg search "search.tar.gz" \
    '{
      kind: "fsusblog-site-backup",
      version: 1,
      runId: $runId,
      generatedAt: $generatedAt,
      artifacts: {
        database: $database,
        uploads: $uploads,
        dataProtectionKeyRing: $keyring,
        configRedacted: $config,
        aotCache: $aot,
        searchIndex: $search
      }
    }' > "$WORK_DIR/manifest.json"
}

main() {
  mkdir -p "$BACKUP_ROOT" "$WORK_DIR"
  require_command jq
  require_command tar
  require_command pg_dump

  if [[ "$DRY_RUN" == "1" ]]; then
    add_check "database" "planned"
    add_check "uploads" "planned"
    add_check "data-protection-keyring" "planned"
    add_check "config" "planned"
    add_check "aot-cache" "planned"
    add_check "search" "planned"
    write_report
    return 0
  fi

  if (( "${#blockers[@]}" == 0 )); then
    dump_database
    pack_tree "$UPLOADS_DIR" "$WORK_DIR/uploads.tar.gz" "uploads"
    pack_keyring
    sanitize_config
    pack_tree "$AOT_DIR" "$WORK_DIR/aot-cache.tar.gz" "aot-cache"
    pack_tree "$SEARCH_DIR" "$WORK_DIR/search.tar.gz" "search"
    write_manifest_file
  fi

  if (( "${#blockers[@]}" == 0 )); then
    tar -czf "$PACKAGE_PATH" -C "$WORK_DIR" .
    add_check "site-package" "packed"
    rm -rf "$WORK_DIR"
  fi

  write_report
  [[ "$status" == "ok" ]]
}

main "$@"
