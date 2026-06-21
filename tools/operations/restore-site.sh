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

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_connection_key() {
  local key
  key="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
  case "$key" in
    host|server) printf 'host' ;;
    port) printf 'port' ;;
    database|dbname|initialcatalog) printf 'db' ;;
    username|userid|user) printf 'user' ;;
    password|pwd) printf 'password' ;;
    *) printf '%s' "$key" ;;
  esac
}

assign_connection_part() {
  local raw_key="$1" raw_value="$2"
  local key value
  key="$(normalize_connection_key "$(trim "$raw_key")")"
  value="$(trim "$raw_value")"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"

  case "$key" in
    host) PG_CONN_HOST="$value" ;;
    port) PG_CONN_PORT="$value" ;;
    db) PG_CONN_DB="$value" ;;
    user) PG_CONN_USER="$value" ;;
    password) PG_CONN_PASSWORD="$value" ;;
  esac
}

parse_key_value_connection() {
  local conn="$1" separator="$2"
  local normalized part key value
  if [[ "$separator" == ";" ]]; then
    normalized="${conn//;/$'\n'}"
  else
    normalized="${conn//$'\n'/ }"
    normalized="${normalized// /$'\n'}"
  fi

  while IFS= read -r part; do
    [[ -n "$(trim "$part")" && "$part" == *"="* ]] || continue
    key="${part%%=*}"
    value="${part#*=}"
    assign_connection_part "$key" "$value"
  done <<< "$normalized"
}

parse_url_connection() {
  local conn="$1"
  local without_scheme authority path userinfo hostport
  without_scheme="${conn#*://}"
  without_scheme="${without_scheme%%\?*}"
  authority="${without_scheme%%/*}"
  path="${without_scheme#*/}"

  if [[ "$authority" == *"@"* ]]; then
    userinfo="${authority%@*}"
    hostport="${authority#*@}"
    PG_CONN_USER="${userinfo%%:*}"
    if [[ "$userinfo" == *":"* ]]; then
      PG_CONN_PASSWORD="${userinfo#*:}"
    fi
  else
    hostport="$authority"
  fi

  if [[ "$hostport" == *":"* ]]; then
    PG_CONN_HOST="${hostport%%:*}"
    PG_CONN_PORT="${hostport##*:}"
  else
    PG_CONN_HOST="$hostport"
  fi

  if [[ -n "$path" && "$path" != "$without_scheme" ]]; then
    PG_CONN_DB="${path%%/*}"
  fi
}

parse_postgres_connection() {
  local conn="$1"
  PG_CONN_HOST=""
  PG_CONN_PORT="5432"
  PG_CONN_DB=""
  PG_CONN_USER=""
  PG_CONN_PASSWORD=""

  case "$conn" in
    postgres://*|postgresql://*)
      parse_url_connection "$conn"
      ;;
    *";"*)
      parse_key_value_connection "$conn" ";"
      ;;
    *)
      parse_key_value_connection "$conn" " "
      ;;
  esac

  [[ -n "$PG_CONN_HOST" && -n "$PG_CONN_DB" && -n "$PG_CONN_USER" ]]
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

  parse_postgres_connection "$conn" || {
    add_blocker "database-connection-invalid"
    return
  }
  PGPASSWORD="$PG_CONN_PASSWORD" pg_restore -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --clean --if-exists "$dump"

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
