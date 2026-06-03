#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_PACKAGE=""
CONFIRM="0"
DRY_RUN="0"
RUN_ID="${FSUSBLOG_RESTORE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RESTORE_ROOT="${FSUSBLOG_RESTORE_ROOT:-${ROOT_DIR}/.tmp/restore-site-${RUN_ID}}"
DATA_ROOT="${FSUSBLOG_DATA_ROOT:-${ROOT_DIR}/src/backend/bin/data}"
WEB_ROOT="${FSUSBLOG_WEB_ROOT:-${ROOT_DIR}/src/backend/wwwroot}"
UPLOADS_DIR="${FSUSBLOG_UPLOADS_DIR:-${WEB_ROOT}/uploads}"
KEYRING_DIR="${FSUSBLOG_DATA_PROTECTION_KEY_RING:-${DATA_ROOT}/data-protection-keys}"
REPORT_PATH="${FSUSBLOG_RESTORE_REPORT:-${RESTORE_ROOT}/restore-site.json}"
checks=()
blockers=()
status="ok"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      BACKUP_PACKAGE="${2:-}"
      shift 2
      ;;
    --confirm)
      CONFIRM="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    *)
      blockers+=("unknown-arg:$1")
      status="blocked"
      shift
      ;;
  esac
done

log() {
  printf '[restore-site] %s\n' "$1"
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
  mkdir -p "$(dirname "$REPORT_PATH")"
  local checks_json blockers_json
  checks_json="$(json_string_array "${checks[@]}")"
  blockers_json="$(json_string_array "${blockers[@]}")"
  jq -n \
    --arg status "$status" \
    --arg runId "$RUN_ID" \
    --arg packagePath "$BACKUP_PACKAGE" \
    --arg restoreRoot "$RESTORE_ROOT" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson checks "$checks_json" \
    --argjson blockers "$blockers_json" \
    '{status:$status, runId:$runId, generatedAt:$generatedAt, packagePath:$packagePath, restoreRoot:$restoreRoot, checks:$checks, blockers:$blockers}' \
    > "$REPORT_PATH"
  log "wrote $REPORT_PATH"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || add_blocker "command-missing:$1"
}

connection_value() {
  local key="$1" conn="$2"
  printf '%s' "$conn" | tr ';' '\n' | awk -F= -v wanted="$key" 'tolower($1)==tolower(wanted) {print $2; exit}'
}

restore_database() {
  local dump="$RESTORE_ROOT/package/database.dump"
  local conn="${FSUSBLOG_POSTGRES_URL:-${DATABASE_URL:-${ConnectionStrings__DefaultConnection:-}}}"
  if [[ ! -r "$dump" ]]; then
    add_blocker "database-dump-missing"
    return
  fi
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
    PGPASSWORD="$password" pg_restore -h "$host" -p "${port:-5432}" -U "$user" -d "$db" --clean --if-exists "$dump"
  else
    pg_restore --clean --if-exists --dbname="$conn" "$dump"
  fi

  add_check "database" "restored"
}

restore_tree() {
  local archive="$1" target="$2" label="$3"
  if [[ ! -r "$archive" ]]; then
    add_blocker "${label}-archive-missing"
    return
  fi

  mkdir -p "$target"
  tar -xzf "$archive" -C "$target"
  add_check "$label" "restored"
}

main() {
  mkdir -p "$RESTORE_ROOT/package"
  require_command jq
  require_command tar
  require_command pg_restore

  if [[ -z "$BACKUP_PACKAGE" || ! -r "$BACKUP_PACKAGE" ]]; then
    add_blocker "backup-package-missing"
  else
    tar -xzf "$BACKUP_PACKAGE" -C "$RESTORE_ROOT/package"
    add_check "site-package" "extracted"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    add_check "database" "planned"
    add_check "uploads" "planned"
    add_check "data-protection-keyring" "planned"
    write_report
    return 0
  fi

  if [[ "$CONFIRM" != "1" ]]; then
    add_blocker "restore-confirmation-required"
  fi

  if (( "${#blockers[@]}" == 0 )); then
    restore_database
    restore_tree "$RESTORE_ROOT/package/uploads.tar.gz" "$UPLOADS_DIR" "uploads"
    restore_tree "$RESTORE_ROOT/package/data-protection-keyring.tar.gz" "$KEYRING_DIR" "data-protection-keyring"
    restore_tree "$RESTORE_ROOT/package/aot-cache.tar.gz" "$WEB_ROOT/aot-cache" "aot-cache"
    restore_tree "$RESTORE_ROOT/package/search.tar.gz" "$WEB_ROOT/search" "search"
  fi

  write_report
  [[ "$status" == "ok" ]]
}

main "$@"
