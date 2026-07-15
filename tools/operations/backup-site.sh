#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${FSUSBLOG_BACKUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_ROOT="${FSUSBLOG_BACKUP_ROOT:-${ROOT_DIR}/.tmp/backups}"
WORK_DIR="${FSUSBLOG_BACKUP_WORK_DIR:-${BACKUP_ROOT}/site-${RUN_ID}.work}"
PACKAGE_PATH="${FSUSBLOG_BACKUP_PACKAGE:-${BACKUP_ROOT}/fsusblog-site-${RUN_ID}.tar.gz.fsbenc}"
DRY_RUN="${FSUSBLOG_BACKUP_DRY_RUN:-0}"
DATA_ROOT="${FSUSBLOG_DATA_ROOT:-${ROOT_DIR}/src/backend/bin/data}"
WEB_ROOT="${FSUSBLOG_WEB_ROOT:-${ROOT_DIR}/src/backend/wwwroot}"
UPLOADS_DIR="${FSUSBLOG_UPLOADS_DIR:-${WEB_ROOT}/uploads}"
AOT_DIR="${FSUSBLOG_AOT_DIR:-${WEB_ROOT}/aot-cache}"
SEARCH_DIR="${FSUSBLOG_SEARCH_DIR:-${WEB_ROOT}/search}"
KEYRING_DIR="${FSUSBLOG_DATA_PROTECTION_KEY_RING:-${DATA_ROOT}/data-protection-keys}"
REPORT_PATH="${BACKUP_ROOT}/backup-site-${RUN_ID}.json"
RECIPIENT_FILE="${FSUSBLOG_BACKUP_RECIPIENT_FILE:-}"
ENVELOPE_TOOL="$ROOT_DIR/tools/operations/backup-envelope.mjs"
CONFIG_SANITIZER="$ROOT_DIR/tools/operations/backup-config-sanitize.mjs"
PLAINTEXT_PACKAGE_PATH="${BACKUP_ROOT}/.fsusblog-site-${RUN_ID}.plaintext.tar.gz"
RECIPIENT_KEY_ID=""
KEYRING_KEY_COUNT=0
WORK_DIR_OWNED=0

status="ok"
blockers=()
checks=()

cleanup() {
  rm -f "$PLAINTEXT_PACKAGE_PATH"
  if [[ "$WORK_DIR_OWNED" == "1" ]]; then
    rm -rf "$WORK_DIR"
  fi
}

trap cleanup EXIT

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
    --arg envelopeFormat "fsusblog-site-backup-envelope-v1" \
    --arg contentEncryption "AES-256-GCM" \
    --arg keyWrap "RSA-OAEP-SHA256" \
    --arg recipientKeyId "$RECIPIENT_KEY_ID" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson checks "$checks_json" \
    --argjson blockers "$blockers_json" \
    '{
      status: $status,
      runId: $runId,
      generatedAt: $generatedAt,
      packagePath: $packagePath,
      backupRoot: $backupRoot,
      packageEncryption: {
        format: $envelopeFormat,
        contentEncryption: $contentEncryption,
        keyWrap: $keyWrap,
        recipientKeyId: (if $recipientKeyId == "" then null else $recipientKeyId end)
      },
      checks: $checks,
      blockers: $blockers
    }' > "$REPORT_PATH"
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

dump_database() {
  local conn="${FSUSBLOG_POSTGRES_URL:-${DATABASE_URL:-${ConnectionStrings__DefaultConnection:-}}}"
  local target="$WORK_DIR/database.dump"
  if [[ -z "$conn" ]]; then
    add_blocker "database-connection-missing"
    return
  fi

  parse_postgres_connection "$conn" || {
    add_blocker "database-connection-invalid"
    return
  }
  PGPASSWORD="$PG_CONN_PASSWORD" pg_dump -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --format=custom --file="$target"

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

  local key_file xml
  local key_files=()
  while IFS= read -r -d '' key_file; do
    key_files+=("$key_file")
  done < <(find "$KEYRING_DIR" -maxdepth 1 -type f -name 'key-*.xml' -print0)
  if (( ${#key_files[@]} == 0 )); then
    add_blocker "data-protection-keyring-empty"
    return
  fi

  for xml in "${key_files[@]}"; do
    if ! grep -q 'encryptedSecret' "$xml" || grep -Eq '<masterKey([[:space:]>])' "$xml"; then
      add_blocker "data-protection-keyring-plaintext-or-invalid"
      return
    fi
  done

  KEYRING_KEY_COUNT="${#key_files[@]}"
  tar -czf "$WORK_DIR/data-protection-keyring.tar.gz" -C "$KEYRING_DIR" .
  add_check "data-protection-keyring" "packed"
  add_check "data-protection-keyring-encrypted-keys" "$KEYRING_KEY_COUNT"
}

sanitize_config() {
  local config_dir="$WORK_DIR/config.redacted"
  mkdir -p "$config_dir"
  shopt -s nullglob
  local files=()
  if [[ -n "${FSUSBLOG_BACKUP_CONFIG_FILES:-}" ]]; then
    IFS=':' read -r -a files <<< "$FSUSBLOG_BACKUP_CONFIG_FILES"
  else
    files=("$ROOT_DIR"/src/backend/appsettings*.json "$ROOT_DIR"/appsettings*.json)
  fi
  shopt -u nullglob
  if (( "${#files[@]}" == 0 )); then
    add_check "config" "empty"
  fi

  for file in "${files[@]}"; do
    if [[ ! -r "$file" ]]; then
      add_blocker "config-file-unreadable"
      continue
    fi
    node "$CONFIG_SANITIZER" "$file" "$config_dir/$(basename "$file")"
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
  local database_sha uploads_sha keyring_sha config_sha aot_sha search_sha
  database_sha="$(sha256sum "$WORK_DIR/database.dump" | awk '{print $1}')"
  uploads_sha="$(sha256sum "$WORK_DIR/uploads.tar.gz" | awk '{print $1}')"
  keyring_sha="$(sha256sum "$WORK_DIR/data-protection-keyring.tar.gz" | awk '{print $1}')"
  config_sha="$(sha256sum "$WORK_DIR/config.redacted.tar.gz" | awk '{print $1}')"
  aot_sha="$(sha256sum "$WORK_DIR/aot-cache.tar.gz" | awk '{print $1}')"
  search_sha="$(sha256sum "$WORK_DIR/search.tar.gz" | awk '{print $1}')"
  jq -n \
    --arg runId "$RUN_ID" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg database "database.dump" \
    --arg uploads "uploads.tar.gz" \
    --arg keyring "data-protection-keyring.tar.gz" \
    --arg config "config.redacted.tar.gz" \
    --arg aot "aot-cache.tar.gz" \
    --arg search "search.tar.gz" \
    --arg recipientKeyId "$RECIPIENT_KEY_ID" \
    --argjson encryptedKeyCount "$KEYRING_KEY_COUNT" \
    --arg databaseSha256 "$database_sha" \
    --arg uploadsSha256 "$uploads_sha" \
    --arg keyringSha256 "$keyring_sha" \
    --arg configSha256 "$config_sha" \
    --arg aotSha256 "$aot_sha" \
    --arg searchSha256 "$search_sha" \
    '{
      kind: "fsusblog-site-backup",
      version: 2,
      runId: $runId,
      generatedAt: $generatedAt,
      artifacts: {
        database: $database,
        uploads: $uploads,
        dataProtectionKeyRing: $keyring,
        configRedacted: $config,
        aotCache: $aot,
        searchIndex: $search
      },
      artifactDigests: {
        database: $databaseSha256,
        uploads: $uploadsSha256,
        dataProtectionKeyRing: $keyringSha256,
        configRedacted: $configSha256,
        aotCache: $aotSha256,
        searchIndex: $searchSha256
      },
      dataProtection: {
        encryptedAtRest: true,
        encryptedKeyCount: $encryptedKeyCount,
        plaintextMasterKeyPresent: false
      },
      envelope: {
        format: "fsusblog-site-backup-envelope-v1",
        contentEncryption: "AES-256-GCM",
        keyWrap: "RSA-OAEP-SHA256",
        recipientKeyId: $recipientKeyId
      }
    }' > "$WORK_DIR/manifest.json"
}

resolve_recipient() {
  if [[ -z "$RECIPIENT_FILE" || ! -r "$RECIPIENT_FILE" ]]; then
    add_blocker "backup-envelope-recipient-missing"
    return
  fi

  local recipient_info
  if ! recipient_info="$(node "$ENVELOPE_TOOL" recipient-info --recipient "$RECIPIENT_FILE")"; then
    add_blocker "backup-envelope-recipient-invalid"
    return
  fi
  RECIPIENT_KEY_ID="$(jq -r '.recipientKeyId // empty' <<< "$recipient_info")"
  if [[ -z "$RECIPIENT_KEY_ID" ]]; then
    add_blocker "backup-envelope-recipient-invalid"
    return
  fi
  add_check "backup-envelope-recipient" "validated"
}

main() {
  mkdir -p "$BACKUP_ROOT"
  if [[ "$WORK_DIR" == "$BACKUP_ROOT" || "$WORK_DIR" == "/" ]]; then
    add_blocker "backup-work-dir-unsafe"
  elif [[ -e "$WORK_DIR" ]]; then
    add_blocker "backup-work-dir-exists"
  else
    mkdir -p "$WORK_DIR"
    WORK_DIR_OWNED=1
  fi
  if [[ -e "$PACKAGE_PATH" ]]; then
    add_blocker "backup-package-already-exists"
  fi
  require_command jq
  require_command tar
  require_command pg_dump
  require_command node
  require_command sha256sum

  if (( "${#blockers[@]}" == 0 )); then
    resolve_recipient
  fi

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
  fi
  if (( "${#blockers[@]}" == 0 )); then
    pack_tree "$UPLOADS_DIR" "$WORK_DIR/uploads.tar.gz" "uploads"
  fi
  if (( "${#blockers[@]}" == 0 )); then
    pack_keyring
  fi
  if (( "${#blockers[@]}" == 0 )); then
    sanitize_config
  fi
  if (( "${#blockers[@]}" == 0 )); then
    pack_tree "$AOT_DIR" "$WORK_DIR/aot-cache.tar.gz" "aot-cache"
  fi
  if (( "${#blockers[@]}" == 0 )); then
    pack_tree "$SEARCH_DIR" "$WORK_DIR/search.tar.gz" "search"
  fi
  if (( "${#blockers[@]}" == 0 )); then
    write_manifest_file
  fi

  if (( "${#blockers[@]}" == 0 )); then
    tar -czf "$PLAINTEXT_PACKAGE_PATH" -C "$WORK_DIR" .
    if node "$ENVELOPE_TOOL" encrypt \
      --input "$PLAINTEXT_PACKAGE_PATH" \
      --output "$PACKAGE_PATH" \
      --recipient "$RECIPIENT_FILE" >/dev/null; then
      add_check "site-package" "authenticated-encrypted"
    else
      add_blocker "site-package-envelope-encryption-failed"
    fi
    rm -f "$PLAINTEXT_PACKAGE_PATH"
  fi

  if (( "${#blockers[@]}" == 0 )); then
    rm -rf "$WORK_DIR"
    WORK_DIR_OWNED=0
  fi

  write_report
  [[ "$status" == "ok" ]]
}

main "$@"
