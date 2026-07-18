#!/usr/bin/env bash
set -euo pipefail
umask 077

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
IDENTITY_FILE="${FSUSBLOG_BACKUP_IDENTITY_FILE:-}"
IDENTITY_PASSPHRASE_FILE="${FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE:-}"
ENVELOPE_TOOL="$ROOT_DIR/tools/operations/backup-envelope.mjs"
DECRYPTED_PACKAGE="$RESTORE_ROOT/.site-package.plaintext.tar.gz"
RECIPIENT_KEY_ID=""
checks=()
blockers=()
status="ok"

Cleanup() {
    rm -f "$DECRYPTED_PACKAGE"
}

trap Cleanup EXIT

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

Log() {
    printf '[restore-site] %s\n' "$1"
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
    mkdir -p "$(dirname "$REPORT_PATH")"
    local checksJson blockersJson
    checksJson="$(JsonStringArray "${checks[@]}")"
    blockersJson="$(JsonStringArray "${blockers[@]}")"
    jq -n \
        --arg status "$status" \
        --arg runId "$RUN_ID" \
        --arg packagePath "$BACKUP_PACKAGE" \
        --arg restoreRoot "$RESTORE_ROOT" \
        --arg envelopeFormat "fsusblog-site-backup-envelope-v1" \
        --arg recipientKeyId "$RECIPIENT_KEY_ID" \
        --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson checks "$checksJson" \
        --argjson blockers "$blockersJson" \
        '{
      status:$status,
      runId:$runId,
      generatedAt:$generatedAt,
      packagePath:$packagePath,
      restoreRoot:$restoreRoot,
      packageEncryption:{format:$envelopeFormat, recipientKeyId:(if $recipientKeyId == "" then null else $recipientKeyId end)},
      checks:$checks,
      blockers:$blockers
    }' \
        >"$REPORT_PATH"
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

RestoreDatabase() {
    local dump="$RESTORE_ROOT/package/database.dump"
    local conn="${FSUSBLOG_POSTGRES_URL:-${DATABASE_URL:-${ConnectionStrings__DefaultConnection:-}}}"
    if [[ ! -r "$dump" ]]; then
        AddBlocker "database-dump-missing"
        return
    fi
    if [[ -z "$conn" ]]; then
        AddBlocker "database-connection-missing"
        return
    fi

    ParsePostgresConnection "$conn" || {
        AddBlocker "database-connection-invalid"
        return
    }
    PGPASSWORD="$PG_CONN_PASSWORD" pg_restore -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --clean --if-exists "$dump"

    AddCheck "database" "restored"
}

RestoreTree() {
    local archive="$1" target="$2" label="$3"
    if [[ ! -r "$archive" ]]; then
        AddBlocker "${label}-archive-missing"
        return
    fi

    mkdir -p "$target"
    tar -xzf "$archive" -C "$target"
    AddCheck "$label" "restored"
}

DecryptPackage() {
    if [[ -z "$IDENTITY_FILE" || ! -r "$IDENTITY_FILE" ]]; then
        AddBlocker "backup-envelope-identity-missing"
        return
    fi

    local decryptArgs=(
        decrypt
        --input "$BACKUP_PACKAGE"
        --output "$DECRYPTED_PACKAGE"
        --identity "$IDENTITY_FILE"
    )
    if [[ -n "$IDENTITY_PASSPHRASE_FILE" ]]; then
        if [[ ! -r "$IDENTITY_PASSPHRASE_FILE" ]]; then
            AddBlocker "backup-envelope-identity-passphrase-missing"
            return
        fi
        decryptArgs+=(--passphrase-file "$IDENTITY_PASSPHRASE_FILE")
    fi

    local envelopeInfo
    if ! envelopeInfo="$(node "$ENVELOPE_TOOL" "${decryptArgs[@]}")"; then
        AddBlocker "backup-envelope-authentication-or-decryption-failed"
        rm -f "$DECRYPTED_PACKAGE"
        return
    fi
    RECIPIENT_KEY_ID="$(jq -r '.recipientKeyId // empty' <<<"$envelopeInfo")"
    if [[ -z "$RECIPIENT_KEY_ID" ]]; then
        AddBlocker "backup-envelope-metadata-invalid"
        rm -f "$DECRYPTED_PACKAGE"
        return
    fi
    AddCheck "site-package-envelope" "authenticated"
}

ArchiveIsSafe() {
    local archive="$1"
    local entry
    tar -tzf "$archive" >/dev/null 2>&1 || return 1
    while IFS= read -r entry; do
        case "$entry" in
            /* | ../* | */../* | */..)
                return 1
                ;;
        esac
    done < <(tar -tzf "$archive")

    if tar -tzvf "$archive" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { found=1 } END { exit(found ? 0 : 1) }'; then
        return 1
    fi
    return 0
}

VerifyPackageManifest() {
    local manifest="$RESTORE_ROOT/package/manifest.json"
    if ! jq -e \
        --arg recipientKeyId "$RECIPIENT_KEY_ID" \
        '.kind == "fsusblog-site-backup"
      and .version == 2
      and .envelope.format == "fsusblog-site-backup-envelope-v1"
      and .envelope.contentEncryption == "AES-256-GCM"
      and .envelope.keyWrap == "RSA-OAEP-SHA256"
      and .envelope.recipientKeyId == $recipientKeyId
      and .dataProtection.encryptedAtRest == true
      and .dataProtection.plaintextMasterKeyPresent == false
      and (.dataProtection.encryptedKeyCount | type) == "number"
      and .dataProtection.encryptedKeyCount > 0' "$manifest" >/dev/null; then
        AddBlocker "backup-manifest-invalid"
        return
    fi

    local label artifact digest actual
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        artifact="$(jq -r --arg label "$label" '.artifacts[$label] // empty' "$manifest")"
        digest="$(jq -r --arg label "$label" '.artifactDigests[$label] // empty' "$manifest")"
        if [[ -z "$artifact" || "$artifact" == */* || ! "$digest" =~ ^[0-9a-f]{64}$ || ! -f "$RESTORE_ROOT/package/$artifact" ]]; then
            AddBlocker "backup-manifest-artifact-invalid:$label"
            return
        fi
        actual="$(sha256sum "$RESTORE_ROOT/package/$artifact" | awk '{print $1}')"
        if [[ "$actual" != "$digest" ]]; then
            AddBlocker "backup-manifest-digest-mismatch:$label"
            return
        fi
    done

    local keyringVerify="$RESTORE_ROOT/keyring-verify"
    mkdir -p "$keyringVerify"
    if ! ArchiveIsSafe "$RESTORE_ROOT/package/data-protection-keyring.tar.gz"; then
        AddBlocker "data-protection-keyring-archive-unsafe"
        return
    fi
    tar -xzf "$RESTORE_ROOT/package/data-protection-keyring.tar.gz" -C "$keyringVerify"
    local keyFile keyCount=0
    while IFS= read -r -d '' keyFile; do
        keyCount=$((keyCount + 1))
        if ! grep -q 'encryptedSecret' "$keyFile" || grep -Eq '<masterKey([[:space:]>])' "$keyFile"; then
            AddBlocker "data-protection-keyring-plaintext-or-invalid"
            return
        fi
    done < <(find "$keyringVerify" -maxdepth 1 -type f -name 'key-*.xml' -print0)
    if [[ "$keyCount" != "$(jq -r '.dataProtection.encryptedKeyCount' "$manifest")" ]]; then
        AddBlocker "data-protection-keyring-generation-count-mismatch"
        return
    fi
    rm -rf "$keyringVerify"
    AddCheck "backup-manifest" "verified"
    AddCheck "data-protection-key-generations" "$keyCount"
}

Main() {
    mkdir -p "$RESTORE_ROOT/package"
    RequireCommand jq
    RequireCommand tar
    RequireCommand pg_restore
    RequireCommand node
    RequireCommand sha256sum

    if [[ -z "$BACKUP_PACKAGE" || ! -r "$BACKUP_PACKAGE" ]]; then
        AddBlocker "backup-package-missing"
    elif (("${#blockers[@]}" == 0)); then
        DecryptPackage
    fi

    if (("${#blockers[@]}" == 0)); then
        if ! ArchiveIsSafe "$DECRYPTED_PACKAGE"; then
            AddBlocker "backup-package-archive-unsafe"
        else
            tar --no-same-owner --no-same-permissions -xzf "$DECRYPTED_PACKAGE" -C "$RESTORE_ROOT/package"
            rm -f "$DECRYPTED_PACKAGE"
            AddCheck "site-package" "authenticated-extracted"
            VerifyPackageManifest
        fi
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
        AddCheck "database" "planned"
        AddCheck "uploads" "planned"
        AddCheck "data-protection-keyring" "planned"
        WriteReport
        [[ "$status" == "ok" ]]
        return
    fi

    if [[ "$CONFIRM" != "1" ]]; then
        AddBlocker "restore-confirmation-required"
    fi

    if (("${#blockers[@]}" == 0)); then
        RestoreDatabase
        RestoreTree "$RESTORE_ROOT/package/uploads.tar.gz" "$UPLOADS_DIR" "uploads"
        RestoreTree "$RESTORE_ROOT/package/data-protection-keyring.tar.gz" "$KEYRING_DIR" "data-protection-keyring"
        RestoreTree "$RESTORE_ROOT/package/aot-cache.tar.gz" "$WEB_ROOT/aot-cache" "aot-cache"
        RestoreTree "$RESTORE_ROOT/package/search.tar.gz" "$WEB_ROOT/search" "search"
    fi

    WriteReport
    [[ "$status" == "ok" ]]
}

Main "$@"
