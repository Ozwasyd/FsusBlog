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

Cleanup() {
    rm -f "$PLAINTEXT_PACKAGE_PATH"
    if [[ "$WORK_DIR_OWNED" == "1" ]]; then
        rm -rf "$WORK_DIR"
    fi
}

trap Cleanup EXIT

Log() {
    printf '[backup-site] %s\n' "$1"
}

AddCheck() {
    checks+=("$1:$2")
}

AddBlocker() {
    status="blocked"
    blockers+=("$1")
}

JsonStringArray() {
    if (("$#" == 0)); then
        printf '[]'
        return
    fi

    printf '%s\n' "$@" | jq -R . | jq -s .
}

WriteReport() {
    local checksJson blockersJson
    checksJson="$(JsonStringArray "${checks[@]}")"
    blockersJson="$(JsonStringArray "${blockers[@]}")"
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
        --argjson checks "$checksJson" \
        --argjson blockers "$blockersJson" \
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
    }' >"$REPORT_PATH"
    Log "wrote $REPORT_PATH"
}

RequireCommand() {
    command -v "$1" >/dev/null 2>&1 || AddBlocker "command-missing:$1"
}

Trim() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

NormalizeConnectionKey() {
    local key
    key="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
    case "$key" in
        host | server) printf 'host' ;;
        port) printf 'port' ;;
        database | dbname | initialcatalog) printf 'db' ;;
        username | userid | user) printf 'user' ;;
        password | pwd) printf 'password' ;;
        *) printf '%s' "$key" ;;
    esac
}

AssignConnectionPart() {
    local rawKey="$1" rawValue="$2"
    local key value
    key="$(NormalizeConnectionKey "$(Trim "$rawKey")")"
    value="$(Trim "$rawValue")"
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

ParseKeyValueConnection() {
    local conn="$1" separator="$2"
    local normalized part key value
    if [[ "$separator" == ";" ]]; then
        normalized="${conn//;/$'\n'}"
    else
        normalized="${conn//$'\n'/ }"
        normalized="${normalized// /$'\n'}"
    fi

    while IFS= read -r part; do
        [[ -n "$(Trim "$part")" && "$part" == *"="* ]] || continue
        key="${part%%=*}"
        value="${part#*=}"
        AssignConnectionPart "$key" "$value"
    done <<<"$normalized"
}

ParseUrlConnection() {
    local conn="$1"
    local withoutScheme authority path userinfo hostport
    withoutScheme="${conn#*://}"
    withoutScheme="${withoutScheme%%\?*}"
    authority="${withoutScheme%%/*}"
    path="${withoutScheme#*/}"

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

    if [[ -n "$path" && "$path" != "$withoutScheme" ]]; then
        PG_CONN_DB="${path%%/*}"
    fi
}

ParsePostgresConnection() {
    local conn="$1"
    PG_CONN_HOST=""
    PG_CONN_PORT="5432"
    PG_CONN_DB=""
    PG_CONN_USER=""
    PG_CONN_PASSWORD=""

    case "$conn" in
        postgres://* | postgresql://*)
            ParseUrlConnection "$conn"
            ;;
        *";"*)
            ParseKeyValueConnection "$conn" ";"
            ;;
        *)
            ParseKeyValueConnection "$conn" " "
            ;;
    esac

    [[ -n "$PG_CONN_HOST" && -n "$PG_CONN_DB" && -n "$PG_CONN_USER" ]]
}

DumpDatabase() {
    local conn="${FSUSBLOG_POSTGRES_URL:-${DATABASE_URL:-${ConnectionStrings__DefaultConnection:-}}}"
    local target="$WORK_DIR/database.dump"
    if [[ -z "$conn" ]]; then
        AddBlocker "database-connection-missing"
        return
    fi

    ParsePostgresConnection "$conn" || {
        AddBlocker "database-connection-invalid"
        return
    }
    PGPASSWORD="$PG_CONN_PASSWORD" pg_dump -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --format=custom --file="$target"

    AddCheck "database" "dumped"
}

PackTree() {
    local source="$1" target="$2" label="$3"
    local emptyDir="$WORK_DIR/empty-${label}"
    if [[ -d "$source" ]]; then
        tar -czf "$target" -C "$source" .
        AddCheck "$label" "packed"
        return
    fi

    mkdir -p "$emptyDir"
    tar -czf "$target" -C "$emptyDir" .
    AddCheck "$label" "empty"
}

PackKeyring() {
    if [[ ! -d "$KEYRING_DIR" ]]; then
        AddBlocker "data-protection-keyring-missing"
        return
    fi

    local keyFile xml
    local keyFiles=()
    while IFS= read -r -d '' keyFile; do
        keyFiles+=("$keyFile")
    done < <(find "$KEYRING_DIR" -maxdepth 1 -type f -name 'key-*.xml' -print0)
    if ((${#keyFiles[@]} == 0)); then
        AddBlocker "data-protection-keyring-empty"
        return
    fi

    for xml in "${keyFiles[@]}"; do
        if ! grep -q 'encryptedSecret' "$xml" || grep -Eq '<masterKey([[:space:]>])' "$xml"; then
            AddBlocker "data-protection-keyring-plaintext-or-invalid"
            return
        fi
    done

    KEYRING_KEY_COUNT="${#keyFiles[@]}"
    tar -czf "$WORK_DIR/data-protection-keyring.tar.gz" -C "$KEYRING_DIR" .
    AddCheck "data-protection-keyring" "packed"
    AddCheck "data-protection-keyring-encrypted-keys" "$KEYRING_KEY_COUNT"
}

SanitizeConfig() {
    local configDir="$WORK_DIR/config.redacted"
    mkdir -p "$configDir"
    shopt -s nullglob
    local files=()
    if [[ -n "${FSUSBLOG_BACKUP_CONFIG_FILES:-}" ]]; then
        IFS=':' read -r -a files <<<"$FSUSBLOG_BACKUP_CONFIG_FILES"
    else
        files=("$ROOT_DIR"/src/backend/appsettings*.json "$ROOT_DIR"/appsettings*.json)
    fi
    shopt -u nullglob
    if (("${#files[@]}" == 0)); then
        AddCheck "config" "empty"
    fi

    for file in "${files[@]}"; do
        if [[ ! -r "$file" ]]; then
            AddBlocker "config-file-unreadable"
            continue
        fi
        node "$CONFIG_SANITIZER" "$file" "$configDir/$(basename "$file")"
    done

    env | sort | awk -F= '
    /^FSUSBLOG_/ {
      key=$1
      value=$2
      if (tolower(key) ~ /(secret|password|token|key|connection|string)/) value="<redacted>"
      print key "=" value
    }' >"$configDir/environment.redacted.txt"
    tar -czf "$WORK_DIR/config.redacted.tar.gz" -C "$configDir" .
    AddCheck "config" "redacted"
}

WriteManifestFile() {
    local databaseSha uploadsSha keyringSha configSha aotSha searchSha
    databaseSha="$(sha256sum "$WORK_DIR/database.dump" | awk '{print $1}')"
    uploadsSha="$(sha256sum "$WORK_DIR/uploads.tar.gz" | awk '{print $1}')"
    keyringSha="$(sha256sum "$WORK_DIR/data-protection-keyring.tar.gz" | awk '{print $1}')"
    configSha="$(sha256sum "$WORK_DIR/config.redacted.tar.gz" | awk '{print $1}')"
    aotSha="$(sha256sum "$WORK_DIR/aot-cache.tar.gz" | awk '{print $1}')"
    searchSha="$(sha256sum "$WORK_DIR/search.tar.gz" | awk '{print $1}')"
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
        --arg databaseSha256 "$databaseSha" \
        --arg uploadsSha256 "$uploadsSha" \
        --arg keyringSha256 "$keyringSha" \
        --arg configSha256 "$configSha" \
        --arg aotSha256 "$aotSha" \
        --arg searchSha256 "$searchSha" \
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
    }' >"$WORK_DIR/manifest.json"
}

ResolveRecipient() {
    if [[ -z "$RECIPIENT_FILE" || ! -r "$RECIPIENT_FILE" ]]; then
        AddBlocker "backup-envelope-recipient-missing"
        return
    fi

    local recipientInfo
    if ! recipientInfo="$(node "$ENVELOPE_TOOL" recipient-info --recipient "$RECIPIENT_FILE")"; then
        AddBlocker "backup-envelope-recipient-invalid"
        return
    fi
    RECIPIENT_KEY_ID="$(jq -r '.recipientKeyId // empty' <<<"$recipientInfo")"
    if [[ -z "$RECIPIENT_KEY_ID" ]]; then
        AddBlocker "backup-envelope-recipient-invalid"
        return
    fi
    AddCheck "backup-envelope-recipient" "validated"
}

Main() {
    mkdir -p "$BACKUP_ROOT"
    if [[ "$WORK_DIR" == "$BACKUP_ROOT" || "$WORK_DIR" == "/" ]]; then
        AddBlocker "backup-work-dir-unsafe"
    elif [[ -e "$WORK_DIR" ]]; then
        AddBlocker "backup-work-dir-exists"
    else
        mkdir -p "$WORK_DIR"
        WORK_DIR_OWNED=1
    fi
    if [[ -e "$PACKAGE_PATH" ]]; then
        AddBlocker "backup-package-already-exists"
    fi
    RequireCommand jq
    RequireCommand tar
    RequireCommand pg_dump
    RequireCommand node
    RequireCommand sha256sum

    if (("${#blockers[@]}" == 0)); then
        ResolveRecipient
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        AddCheck "database" "planned"
        AddCheck "uploads" "planned"
        AddCheck "data-protection-keyring" "planned"
        AddCheck "config" "planned"
        AddCheck "aot-cache" "planned"
        AddCheck "search" "planned"
        WriteReport
        return 0
    fi

    if (("${#blockers[@]}" == 0)); then
        DumpDatabase
    fi
    if (("${#blockers[@]}" == 0)); then
        PackTree "$UPLOADS_DIR" "$WORK_DIR/uploads.tar.gz" "uploads"
    fi
    if (("${#blockers[@]}" == 0)); then
        PackKeyring
    fi
    if (("${#blockers[@]}" == 0)); then
        SanitizeConfig
    fi
    if (("${#blockers[@]}" == 0)); then
        PackTree "$AOT_DIR" "$WORK_DIR/aot-cache.tar.gz" "aot-cache"
    fi
    if (("${#blockers[@]}" == 0)); then
        PackTree "$SEARCH_DIR" "$WORK_DIR/search.tar.gz" "search"
    fi
    if (("${#blockers[@]}" == 0)); then
        WriteManifestFile
    fi

    if (("${#blockers[@]}" == 0)); then
        tar -czf "$PLAINTEXT_PACKAGE_PATH" -C "$WORK_DIR" .
        if node "$ENVELOPE_TOOL" encrypt \
            --input "$PLAINTEXT_PACKAGE_PATH" \
            --output "$PACKAGE_PATH" \
            --recipient "$RECIPIENT_FILE" >/dev/null; then
            AddCheck "site-package" "authenticated-encrypted"
        else
            AddBlocker "site-package-envelope-encryption-failed"
        fi
        rm -f "$PLAINTEXT_PACKAGE_PATH"
    fi

    if (("${#blockers[@]}" == 0)); then
        rm -rf "$WORK_DIR"
        WORK_DIR_OWNED=0
    fi

    WriteReport
    [[ "$status" == "ok" ]]
}

Main "$@"
