#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_PACKAGE=""
CONFIRM="0"
DRY_RUN="0"
inspectOnly=0
inspectRootOwned=0
inspectRootIdentity=""
inspectTimeoutArgument=0
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
packageSha256=""
manifestSha256=""
migrationDll="${FSUSBLOG_MIGRATION_SERVER_DLL:-}"
sourceBinding="null"
sourceTimeoutSeconds="${FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS:-}"
sourceDeadline=0
sourceChildPid=""
sourceCleanupVerified=1
declare -A sourceChildIdentities=()
sourceFailureLog="$REPORT_PATH.source-stderr.log"
restoredSource="null"
observedDatabase="null"
restoreRootExisted=0
[[ ! -e "$RESTORE_ROOT" ]] || restoreRootExisted=1
checks=()
blockers=()
status="ok"

Cleanup() {
    StopSourceChild "$sourceChildPid" || sourceCleanupVerified=0
    if [[ "$inspectOnly" == "1" ]]; then
        CleanupInspection
    else
        rm -f "$DECRYPTED_PACKAGE"
    fi
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
        --inspect-only)
            inspectOnly=1
            shift
            ;;
        --timeout-seconds)
            if [[ $# -lt 2 ]]; then
                blockers+=("inspection-timeout-argument-missing")
                status="blocked"
                shift
            else
                sourceTimeoutSeconds="$2"
                inspectTimeoutArgument=1
                shift 2
            fi
            ;;
        *)
            blockers+=("unknown-arg:$1")
            status="blocked"
            shift
            ;;
    esac
done

ReadSourceBudget() {
    if [[ ! -r /proc/uptime || ! "$sourceTimeoutSeconds" =~ ^[1-9][0-9]{0,6}$ ]] || ((sourceTimeoutSeconds > 2147483)); then
        AddBlocker "database-snapshot-timeout-invalid-or-missing"
        return 1
    fi
    sourceDeadline=$(( $(SourceNow) + sourceTimeoutSeconds ))
}

SourceNow() {
    local uptimeValue ignored
    read -r uptimeValue ignored </proc/uptime
    printf '%s\n' "${uptimeValue%%.*}"
}

SourceRemaining() {
    local remaining=$((sourceDeadline - $(SourceNow)))
    ((remaining > 0)) || return 1
    printf '%s\n' "$remaining"
}

ChildRunning() {
    local pid="$1" running
    while IFS= read -r running; do
        [[ "$running" != "$pid" ]] || return 0
    done < <(jobs -pr)
    return 1
}

ChildGroupEmpty() {
    local pid="$1" groups
    groups="$(ps -eo pgid=)" || return 1
    ! awk -v group="$pid" '$1 == group { found = 1 } END { exit(found ? 0 : 1) }' <<<"$groups"
}

ReadChildIdentity() {
    local pid="$1" statLine fields
    local -a statFields
    [[ -r "/proc/$pid/stat" ]] || return 1
    IFS= read -r statLine <"/proc/$pid/stat" || return 1
    fields="${statLine##*) }"
    read -r -a statFields <<<"$fields"
    [[ "${statFields[2]:-}" == "$pid" && "${statFields[19]:-}" =~ ^[0-9]+$ ]] || return 1
    printf '%s:%s\n' "$pid" "${statFields[19]}"
}

RegisterChildIdentity() {
    local pid="$1" identity
    while ChildRunning "$pid"; do
        if identity="$(ReadChildIdentity "$pid")"; then
            sourceChildIdentities["$pid"]="$identity"
            return 0
        fi
        SourceRemaining >/dev/null || return 1
        sleep 0.01
    done
    ChildGroupEmpty "$pid"
}

SignalOwnedChildGroup() {
    local signal="$1" pid="$2" actual
    if [[ -z "${sourceChildIdentities[$pid]:-}" ]] || ! actual="$(ReadChildIdentity "$pid")" \
        || [[ "$actual" != "${sourceChildIdentities[$pid]}" ]]; then
        AddBlocker "database-snapshot-child-ownership-unverified"
        return 1
    fi
    kill "-$signal" -- "-$pid" >/dev/null 2>&1 || true
}

StopSourceChild() {
    local pid="$1" deadline
    [[ -n "$pid" ]] || return 0
    if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
        SignalOwnedChildGroup TERM "$pid" || return 1
        deadline=$(( $(SourceNow) + 1 ))
        while ChildRunning "$pid" && (( $(SourceNow) < deadline )); do
            sleep 0.05
        done
        if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
            SignalOwnedChildGroup KILL "$pid" || return 1
        fi
        deadline=$(( $(SourceNow) + 1 ))
        while ChildRunning "$pid" && (( $(SourceNow) < deadline )); do
            sleep 0.05
        done
    fi
    if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
        AddBlocker "database-snapshot-child-cleanup-unverified"
        return 1
    fi
    wait "$pid" >/dev/null 2>&1 || true
    unset 'sourceChildIdentities[$pid]'
}

WaitSourceChild() {
    local pid="$1"
    while ChildRunning "$pid"; do
        SourceRemaining >/dev/null || return 1
        sleep 0.05
    done
    ChildGroupEmpty "$pid" || return 1
    wait "$pid"
}

RunSourceCommand() {
    local outputPath="$1" remaining
    shift
    remaining="$(SourceRemaining)" || return 1
    timeout --signal=TERM --kill-after=1s "${remaining}s" "$@" <&0 >"$outputPath" 2>>"$sourceFailureLog" &
    sourceChildPid="$!"
    if ! RegisterChildIdentity "$sourceChildPid"; then
        StopSourceChild "$sourceChildPid" || sourceCleanupVerified=0
        return 1
    fi
    if ! WaitSourceChild "$sourceChildPid"; then
        if StopSourceChild "$sourceChildPid"; then
            sourceChildPid=""
        else
            sourceCleanupVerified=0
        fi
        return 1
    fi
    sourceChildPid=""
}

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
        --arg packageSha256 "$packageSha256" \
        --arg manifestSha256 "$manifestSha256" \
        --argjson sourceBinding "$sourceBinding" \
        --argjson restoredSource "$restoredSource" \
        --arg sourceFailureLog "$sourceFailureLog" \
        --argjson sourceCleanupVerified "$sourceCleanupVerified" \
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
      packageSha256:(if $packageSha256 == "" then null else $packageSha256 end),
      manifestSha256:(if $manifestSha256 == "" then null else $manifestSha256 end),
      sourceBinding:$sourceBinding,
      restoredSource:$restoredSource,
      sourceFailureLog:$sourceFailureLog,
      sourceCleanupVerified:($sourceCleanupVerified == 1),
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
    local targetSource
    if [[ "$sourceBinding" != "null" ]]; then
        if ! ObserveDatabase || ! jq -e --argjson binding "$sourceBinding" \
            '.Database.Provider == 0 and .Database != $binding.capture.Source.Database' <<<"$observedDatabase" >/dev/null; then
            AddBlocker "database-restore-target-not-isolated-or-unobserved"
            return
        fi
        targetSource="$observedDatabase"
    fi
    if [[ "$sourceBinding" != "null" ]]; then
        if ! PGPASSWORD="$PG_CONN_PASSWORD" RunSourceCommand "$RESTORE_ROOT/.database-restore.stdout" \
            pg_restore -h "$PG_CONN_HOST" -p "$PG_CONN_PORT" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --exit-on-error --clean --if-exists "$dump"; then
            AddBlocker "database-restore-failed"
            return
        fi
    elif ! PGPASSWORD="$PG_CONN_PASSWORD" pg_restore -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --exit-on-error --clean --if-exists "$dump"; then
        AddBlocker "database-restore-failed"
        return
    fi
    if [[ "$sourceBinding" != "null" ]]; then
        if ! ObserveDatabase || ! jq -e --argjson binding "$sourceBinding" --argjson target "$targetSource" \
            '.Database == $target.Database and . == ($binding.capture.Source | .Database = $target.Database)' <<<"$observedDatabase" >/dev/null; then
            restoredSource="null"
            AddBlocker "database-restored-source-content-mismatch"
            return
        fi
        restoredSource="$observedDatabase"
        AddCheck "database-restored-source" "verified"
    fi

    AddCheck "database" "restored"
}

ObserveDatabase() {
    local environmentFile="$RESTORE_ROOT/.source-observer.env"
    observedDatabase="null"
    local hostValue databaseValue userValue passwordValue
    if [[ ! -f "$migrationDll" || -L "$migrationDll" ]]; then
        return 1
    fi
    if [[ ! "$PG_CONN_PORT" =~ ^[0-9]+$ || "$PG_CONN_HOST$PG_CONN_DB$PG_CONN_USER$PG_CONN_PASSWORD" == *$'\n'* || "$PG_CONN_HOST$PG_CONN_DB$PG_CONN_USER$PG_CONN_PASSWORD" == *$'\r'* ]]; then
        return 1
    fi
    hostValue="${PG_CONN_HOST//\"/\"\"}"
    databaseValue="${PG_CONN_DB//\"/\"\"}"
    userValue="${PG_CONN_USER//\"/\"\"}"
    passwordValue="${PG_CONN_PASSWORD//\"/\"\"}"
    printf 'ConnectionStrings__DefaultConnection=Host="%s";Port=%s;Database="%s";Username="%s";Password="%s"\n' \
        "$hostValue" "$PG_CONN_PORT" "$databaseValue" "$userValue" "$passwordValue" >"$environmentFile"
    if ! RunSourceCommand "$RESTORE_ROOT/.source-observer.stdout" "${DOTNET_BIN:-dotnet}" "$migrationDll" observe-source --provider postgresql \
        --env-file "$environmentFile" --timeout-seconds "$(SourceRemaining)"; then
        rm -f "$environmentFile"
        return 1
    fi
    observedDatabase="$(<"$RESTORE_ROOT/.source-observer.stdout")"
    rm -f "$environmentFile"
}

VerifyIsolatedRestorePaths() {
    local rootPath targetPath
    if [[ "$restoreRootExisted" == "1" ]] || ! command -v realpath >/dev/null 2>&1; then
        AddBlocker "database-bound-restore-root-not-fresh"
        return
    fi
    rootPath="$(realpath -m -- "$RESTORE_ROOT")"
    WEB_ROOT="${FSUSBLOG_WEB_ROOT:-$RESTORE_ROOT/restored/webroot}"
    UPLOADS_DIR="${FSUSBLOG_UPLOADS_DIR:-$WEB_ROOT/uploads}"
    KEYRING_DIR="${FSUSBLOG_DATA_PROTECTION_KEY_RING:-$RESTORE_ROOT/restored/data-protection-keys}"
    for targetPath in "$WEB_ROOT" "$UPLOADS_DIR" "$KEYRING_DIR"; do
        targetPath="$(realpath -m -- "$targetPath")"
        if [[ "$targetPath" != "$rootPath/"* || -e "$targetPath" ]]; then
            AddBlocker "database-bound-restore-path-not-isolated"
            return
        fi
    done
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
    packageSha256="$(sha256sum "$BACKUP_PACKAGE" | awk '{print $1}')"
    if ! envelopeInfo="$(node "$ENVELOPE_TOOL" "${decryptArgs[@]}")"; then
        AddBlocker "backup-envelope-authentication-or-decryption-failed"
        rm -f "$DECRYPTED_PACKAGE"
        return
    fi
    if [[ "$packageSha256" != "$(sha256sum "$BACKUP_PACKAGE" | awk '{print $1}')" ]]; then
        AddBlocker "backup-package-changed-during-authentication"
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
      and (.version == 2 or .version == 3)
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
    manifestSha256="$(sha256sum "$manifest" | awk '{print $1}')"

    local label artifact digest actual expectedArtifact
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        case "$label" in
            database) expectedArtifact="database.dump" ;;
            uploads) expectedArtifact="uploads.tar.gz" ;;
            dataProtectionKeyRing) expectedArtifact="data-protection-keyring.tar.gz" ;;
            configRedacted) expectedArtifact="config.redacted.tar.gz" ;;
            aotCache) expectedArtifact="aot-cache.tar.gz" ;;
            searchIndex) expectedArtifact="search.tar.gz" ;;
        esac
        artifact="$(jq -r --arg label "$label" '.artifacts[$label] // empty' "$manifest")"
        digest="$(jq -r --arg label "$label" '.artifactDigests[$label] // empty' "$manifest")"
        if [[ "$artifact" != "$expectedArtifact" || ! "$digest" =~ ^[0-9a-f]{64}$ || ! -f "$RESTORE_ROOT/package/$artifact" ]]; then
            AddBlocker "backup-manifest-artifact-invalid:$label"
            return
        fi
        actual="$(sha256sum "$RESTORE_ROOT/package/$artifact" | awk '{print $1}')"
        if [[ "$actual" != "$digest" ]]; then
            AddBlocker "backup-manifest-digest-mismatch:$label"
            return
        fi
    done

    if [[ "$(jq -r '.version' "$manifest")" == "3" ]]; then
        if ! jq -e '.sourceBinding.owner == "tools/operations/backup-site.sh" and .sourceBinding.ownerVersion == "3"
            and .sourceBinding.capture.Source.Database.Provider == 0
            and (.sourceBinding.capture.Source.ContentDigest | test("^[0-9a-f]{64}$"))
            and (.sourceBinding.capture.SnapshotId | type == "string" and length > 0)
            and .sourceBinding.capture.DatabaseDumpSha256 == .artifactDigests.database
            and .sourceBinding.databaseDumpSha256 == .artifactDigests.database' "$manifest" >/dev/null; then
            AddBlocker "backup-source-snapshot-binding-invalid"
            return
        fi
        sourceBinding="$(jq -c '.sourceBinding' "$manifest")"
        if [[ "$inspectOnly" != "1" ]]; then
            if ! ReadSourceBudget; then
                return
            fi
            RequireCommand timeout
            RequireCommand ps
            RequireCommand sleep
            mkdir -p "$(dirname "$sourceFailureLog")"
            VerifyIsolatedRestorePaths
        fi
    fi

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

VerifyConsumedArtifacts() {
    local manifest="$RESTORE_ROOT/package/manifest.json" label artifact expected actual
    if [[ "$(sha256sum "$manifest" | awk '{print $1}')" != "$manifestSha256" ]]; then
        AddBlocker "backup-manifest-changed-before-restore"
        return
    fi
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        artifact="$(jq -r --arg label "$label" '.artifacts[$label]' "$manifest")"
        expected="$(jq -r --arg label "$label" '.artifactDigests[$label]' "$manifest")"
        actual="$(sha256sum "$RESTORE_ROOT/package/$artifact" | awk '{print $1}')"
        if [[ "$actual" != "$expected" ]]; then
            AddBlocker "backup-artifact-changed-before-restore:$label"
            return
        fi
        if [[ "$label" != "database" ]] && ! ArchiveIsSafe "$RESTORE_ROOT/package/$artifact"; then
            AddBlocker "backup-inner-artifact-archive-unsafe:$label"
            return
        fi
    done
}

CleanupInspection() {
    [[ "$inspectRootOwned" == "1" ]] || return 0
    if [[ "$sourceCleanupVerified" != "1" || -L "$RESTORE_ROOT" || ! -d "$RESTORE_ROOT" \
        || "$(stat -c '%d:%i' -- "$RESTORE_ROOT")" != "$inspectRootIdentity" ]]; then
        AddBlocker "inspection-stage-cleanup-unverified"
        return 1
    fi
    if ! RunSourceCommand "$RESTORE_ROOT/.inspection-cleanup.stdout" rm -rf -- "$RESTORE_ROOT" </dev/null \
        || [[ -e "$RESTORE_ROOT" || -L "$RESTORE_ROOT" ]]; then
        AddBlocker "inspection-stage-cleanup-failed"
        return 1
    fi
    inspectRootOwned=0
}

InspectAuthenticatedPackage() {
    # This function runs only in the parent's bounded child group. It reuses the
    # restore owner's sole authentication and manifest validators, without Main.
    DecryptPackage
    if (("${#blockers[@]}" == 0)); then
        if ! ArchiveIsSafe "$DECRYPTED_PACKAGE"; then
            AddBlocker "backup-package-archive-unsafe"
        else
            tar --no-same-owner --no-same-permissions -xzf "$DECRYPTED_PACKAGE" -C "$RESTORE_ROOT/package"
            rm -f "$DECRYPTED_PACKAGE"
            VerifyPackageManifest
        fi
    fi
    if (("${#blockers[@]}" == 0)); then
        VerifyConsumedArtifacts
    fi
    if (("${#blockers[@]}" != 0)); then
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    if [[ "$(sha256sum "$BACKUP_PACKAGE" | awk '{print $1}')" != "$packageSha256" ]]; then
        AddBlocker "backup-package-changed-during-inspection"
        return 1
    fi
    jq -n --arg packageSha256 "$packageSha256" --arg manifestSha256 "$manifestSha256" \
        --arg manifestBase64 "$(base64 -w 0 "$RESTORE_ROOT/package/manifest.json")" \
        --slurpfile manifest "$RESTORE_ROOT/package/manifest.json" \
        '{version: 1, owner: "tools/operations/restore-site.sh", ownerVersion: "1", operation: "inspect-only",
          status: "ok", packageSha256: $packageSha256, manifestSha256: $manifestSha256,
          manifestBase64: $manifestBase64, manifest: $manifest[0],
          sourceBinding: ($manifest[0].sourceBinding // null), artifactDigests: $manifest[0].artifactDigests}'
}

InspectPackage() {
    if [[ "$inspectTimeoutArgument" != "1" ]] || ! ReadSourceBudget; then
        printf '%s\n' '{"status":"blocked","blocker":"inspection-timeout-invalid-or-missing"}' >&2
        return 1
    fi
    for command in jq tar node sha256sum timeout ps sleep stat base64 bash realpath; do
        RequireCommand "$command"
    done
    if [[ "$CONFIRM" == "1" || "$DRY_RUN" == "1" || ! -f "$BACKUP_PACKAGE" || -L "$BACKUP_PACKAGE" \
        || -e "$RESTORE_ROOT" || -L "$RESTORE_ROOT" || ! -d "$(dirname "$RESTORE_ROOT")" ]]; then
        AddBlocker "inspection-input-or-fresh-stage-invalid"
    fi
    sourceFailureLog="${RESTORE_ROOT}.inspect-stderr.log"
    if [[ -e "$sourceFailureLog" || -L "$sourceFailureLog" ]]; then
        AddBlocker "inspection-failure-log-already-exists"
    fi
    if (("${#blockers[@]}" != 0)); then
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    RESTORE_ROOT="$(realpath -m -- "$RESTORE_ROOT")"
    BACKUP_PACKAGE="$(realpath -e -- "$BACKUP_PACKAGE")"
    DECRYPTED_PACKAGE="$RESTORE_ROOT/.site-package.plaintext.tar.gz"
    export FSUSBLOG_RESTORE_ROOT="$RESTORE_ROOT"
    if ! mkdir -- "$RESTORE_ROOT"; then
        AddBlocker "inspection-stage-creation-failed"
        return 1
    fi
    inspectRootOwned=1
    inspectRootIdentity="$(stat -c '%d:%i' -- "$RESTORE_ROOT")"
    mkdir "$RESTORE_ROOT/package"
    local inspectionResult packageAtCompletion
    if ! RunSourceCommand "$RESTORE_ROOT/.inspection.json" bash -c \
        'source "$1" --inspect-only --backup "$2"; InspectAuthenticatedPackage' \
        inspection "$ROOT_DIR/tools/operations/restore-site.sh" "$BACKUP_PACKAGE" </dev/null; then
        AddBlocker "inspection-authentication-or-terminal-failed"
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    inspectionResult="$(<"$RESTORE_ROOT/.inspection.json")"
    if ! RunSourceCommand "$RESTORE_ROOT/.inspection-final-sha256" sha256sum "$BACKUP_PACKAGE" </dev/null; then
        AddBlocker "inspection-package-final-read-failed"
        return 1
    fi
    read -r packageAtCompletion _ <"$RESTORE_ROOT/.inspection-final-sha256"
    if ! jq -e --arg packageSha256 "$packageAtCompletion" \
        '.version == 1 and .owner == "tools/operations/restore-site.sh" and .ownerVersion == "1"
         and .operation == "inspect-only" and .status == "ok" and .packageSha256 == $packageSha256' <<<"$inspectionResult" >/dev/null \
        || ! CleanupInspection; then
        AddBlocker "inspection-result-or-cleanup-invalid"
        return 1
    fi
    printf '%s\n' "$inspectionResult"
}

Main() {
    if [[ "$inspectOnly" == "1" ]]; then
        InspectPackage
        return
    fi
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
        VerifyConsumedArtifacts
    fi
    if (("${#blockers[@]}" == 0)); then
        RestoreDatabase
    fi
    if (("${#blockers[@]}" == 0)); then
        RestoreTree "$RESTORE_ROOT/package/uploads.tar.gz" "$UPLOADS_DIR" "uploads"
        RestoreTree "$RESTORE_ROOT/package/data-protection-keyring.tar.gz" "$KEYRING_DIR" "data-protection-keyring"
        RestoreTree "$RESTORE_ROOT/package/aot-cache.tar.gz" "$WEB_ROOT/aot-cache" "aot-cache"
        RestoreTree "$RESTORE_ROOT/package/search.tar.gz" "$WEB_ROOT/search" "search"
    fi

    WriteReport
    [[ "$status" == "ok" ]]
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    Main "$@"
fi
