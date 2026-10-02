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
packageSha256=""
manifestSha256=""
migrationDll="${FSUSBLOG_MIGRATION_SERVER_DLL:-}"
databaseProvider="${FSUSBLOG_BACKUP_DATABASE_PROVIDER:-postgresql}"
sourceCapture="null"
capturePid=""
captureReadFd=""
captureWriteFd=""
captureTimeoutSeconds="${FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS:-}"
captureDeadline=0
dumpPid=""
captureCleanupVerified=1
declare -A captureChildIdentities=()
captureFailureLog=""
KEYRING_KEY_COUNT=0
WORK_DIR_OWNED=0

status="ok"
blockers=()
checks=()

Cleanup() {
    if [[ -n "$captureWriteFd" ]]; then
        exec {captureWriteFd}>&-
    fi
    if [[ -n "$captureReadFd" ]]; then
        exec {captureReadFd}<&-
    fi
    StopCaptureChild "$dumpPid" || captureCleanupVerified=0
    StopCaptureChild "$capturePid" || captureCleanupVerified=0
    rm -f "$PLAINTEXT_PACKAGE_PATH"
    if [[ "$WORK_DIR_OWNED" == "1" && "$captureCleanupVerified" == "1" ]]; then
        rm -rf "$WORK_DIR"
    fi
}

ReadCaptureBudget() {
    if [[ ! -r /proc/uptime || ! "$captureTimeoutSeconds" =~ ^[1-9][0-9]{0,6}$ ]] || ((captureTimeoutSeconds > 2147483)); then
        AddBlocker "database-snapshot-timeout-invalid-or-missing"
        return 1
    fi
    captureDeadline=$(( $(CaptureNow) + captureTimeoutSeconds ))
}

CaptureNow() {
    local uptimeValue ignored
    read -r uptimeValue ignored </proc/uptime
    printf '%s\n' "${uptimeValue%%.*}"
}

CaptureRemaining() {
    local remaining=$((captureDeadline - $(CaptureNow)))
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
            captureChildIdentities["$pid"]="$identity"
            return 0
        fi
        CaptureRemaining >/dev/null || return 1
        sleep 0.01
    done
    ChildGroupEmpty "$pid"
}

SignalOwnedChildGroup() {
    local signal="$1" pid="$2" actual
    if [[ -z "${captureChildIdentities[$pid]:-}" ]] || ! actual="$(ReadChildIdentity "$pid")" \
        || [[ "$actual" != "${captureChildIdentities[$pid]}" ]]; then
        AddBlocker "database-snapshot-child-ownership-unverified"
        return 1
    fi
    kill "-$signal" -- "-$pid" >/dev/null 2>&1 || true
}

StopCaptureChild() {
    local pid="$1" deadline
    [[ -n "$pid" ]] || return 0
    if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
        SignalOwnedChildGroup TERM "$pid" || return 1
        deadline=$(( $(CaptureNow) + 1 ))
        while ChildRunning "$pid" && (( $(CaptureNow) < deadline )); do
            sleep 0.05
        done
        if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
            SignalOwnedChildGroup KILL "$pid" || return 1
        fi
        deadline=$(( $(CaptureNow) + 1 ))
        while ChildRunning "$pid" && (( $(CaptureNow) < deadline )); do
            sleep 0.05
        done
    fi
    if ChildRunning "$pid" || ! ChildGroupEmpty "$pid"; then
        AddBlocker "database-snapshot-child-cleanup-unverified"
        return 1
    fi
    wait "$pid" >/dev/null 2>&1 || true
    unset 'captureChildIdentities[$pid]'
}

WaitCaptureChild() {
    local pid="$1"
    while ChildRunning "$pid"; do
        CaptureRemaining >/dev/null || return 1
        sleep 0.05
    done
    ChildGroupEmpty "$pid" || return 1
    wait "$pid"
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
        --arg packageSha256 "$packageSha256" \
        --arg manifestSha256 "$manifestSha256" \
        --argjson sourceCapture "$sourceCapture" \
        --arg captureFailureLog "$captureFailureLog" \
        --argjson captureCleanupVerified "$captureCleanupVerified" \
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
      packageSha256: (if $packageSha256 == "" then null else $packageSha256 end),
      manifestSha256: (if $manifestSha256 == "" then null else $manifestSha256 end),
      sourceCapture: $sourceCapture,
      captureFailureLog: (if $captureFailureLog == "" then null else $captureFailureLog end),
      captureCleanupVerified: ($captureCleanupVerified == 1),
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
    if [[ -n "$migrationDll" ]]; then
        if ! CaptureDatabase "$target"; then
            StopCaptureChild "$dumpPid" || captureCleanupVerified=0
            StopCaptureChild "$capturePid" || captureCleanupVerified=0
            if [[ "$captureCleanupVerified" == "1" ]]; then
                dumpPid=""
                capturePid=""
            fi
            return
        fi
    elif ! PGPASSWORD="$PG_CONN_PASSWORD" pg_dump -h "$PG_CONN_HOST" -p "${PG_CONN_PORT:-5432}" -U "$PG_CONN_USER" -d "$PG_CONN_DB" --format=custom --file="$target"; then
        AddBlocker "database-dump-failed"
        return
    fi

    AddCheck "database" "dumped"
}

CaptureDatabase() {
    local target="$1" environmentFile="$WORK_DIR/source-capture.env"
    local hostValue databaseValue userValue passwordValue start final snapshotId readOriginal writeOriginal remaining nativeTimeout
    hostValue="${PG_CONN_HOST//\"/\"\"}"
    databaseValue="${PG_CONN_DB//\"/\"\"}"
    userValue="${PG_CONN_USER//\"/\"\"}"
    passwordValue="${PG_CONN_PASSWORD//\"/\"\"}"
    if [[ "$databaseProvider" != "postgresql" || ! -f "$migrationDll" || -L "$migrationDll" ]]; then
        AddBlocker "database-snapshot-capture-capability-unavailable"
        return 1
    fi
    if [[ ! "$PG_CONN_PORT" =~ ^[0-9]+$ || "$PG_CONN_HOST$PG_CONN_DB$PG_CONN_USER$PG_CONN_PASSWORD" == *$'\n'* || "$PG_CONN_HOST$PG_CONN_DB$PG_CONN_USER$PG_CONN_PASSWORD" == *$'\r'* ]]; then
        AddBlocker "database-capture-environment-invalid"
        return 1
    fi
    captureFailureLog="$BACKUP_ROOT/backup-site-${RUN_ID}.capture-stderr.log"
    if [[ -e "$captureFailureLog" ]]; then
        AddBlocker "database-snapshot-failure-log-already-exists"
        return 1
    fi
    printf 'ConnectionStrings__DefaultConnection=Host="%s";Port=%s;Database="%s";Username="%s";Password="%s"\n' \
        "$hostValue" "$PG_CONN_PORT" "$databaseValue" "$userValue" "$passwordValue" >"$environmentFile"
    if ! nativeTimeout="$(CaptureRemaining)"; then
        AddBlocker "database-snapshot-deadline-expired"
        return 1
    fi
    coproc SourceCapture {
        exec timeout --signal=TERM --kill-after=1s "${nativeTimeout}s" \
            "${DOTNET_BIN:-dotnet}" "$migrationDll" observe-source --provider postgresql \
            --env-file "$environmentFile" --capture-session --dump-output "$target" --timeout-seconds "$nativeTimeout"
    } 2>"$captureFailureLog"
    capturePid="${SourceCapture_PID:-}"
    readOriginal="${SourceCapture[0]:-}"
    writeOriginal="${SourceCapture[1]:-}"
    if [[ -z "$capturePid" || -z "$readOriginal" || -z "$writeOriginal" ]]; then
        AddBlocker "database-snapshot-capture-process-unavailable"
        return 1
    fi
    if ! RegisterChildIdentity "$capturePid"; then
        AddBlocker "database-snapshot-capture-ownership-unverified"
        return 1
    fi
    exec {captureReadFd}<&"$readOriginal"
    exec {captureWriteFd}>&"$writeOriginal"
    exec {readOriginal}<&-
    exec {writeOriginal}>&-
    if ! remaining="$(CaptureRemaining)" || ! IFS= read -r -t "$remaining" -u "$captureReadFd" start || ! jq -e --argjson timeout "$nativeTimeout" \
        '.Source.Database.Provider == 0 and (.Source.ContentDigest | test("^[0-9a-f]{64}$"))
         and (.SnapshotId | type == "string" and length > 0)
         and (.CapturedAt | type == "string" and length > 0)
         and (.ObserverId | type == "string" and length > 0)
         and (.ObserverVersion | type == "string" and length > 0)
         and .TimeoutSeconds == $timeout' <<<"$start" >/dev/null; then
        AddBlocker "database-snapshot-capture-start-invalid"
        return 1
    fi
    snapshotId="$(jq -r '.SnapshotId' <<<"$start")"
    if ! remaining="$(CaptureRemaining)"; then
        AddBlocker "database-snapshot-deadline-expired"
        return 1
    fi
    PGPASSWORD="$PG_CONN_PASSWORD" timeout --signal=TERM --kill-after=1s "${remaining}s" \
        pg_dump -h "$PG_CONN_HOST" -p "$PG_CONN_PORT" -U "$PG_CONN_USER" -d "$PG_CONN_DB" \
        --format=custom --snapshot="$snapshotId" --file="$target" 2>>"$captureFailureLog" &
    dumpPid="$!"
    if ! RegisterChildIdentity "$dumpPid"; then
        AddBlocker "database-snapshot-dump-ownership-unverified"
        return 1
    fi
    if ! WaitCaptureChild "$dumpPid"; then
        AddBlocker "database-snapshot-dump-failed"
        return 1
    fi
    dumpPid=""
    if ! remaining="$(CaptureRemaining)"; then
        AddBlocker "database-snapshot-deadline-expired"
        return 1
    fi
    timeout --signal=TERM --kill-after=1s "${remaining}s" node --input-type=module - "$target" 2>>"$captureFailureLog" <<'NODE' &
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const path = process.argv[2];
const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try
{
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
    {
        throw new Error('dump is not an exclusive regular file');
    }
    await handle.sync();
    const after = await lstat(path);
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size)
    {
        throw new Error('dump path changed during synchronization');
    }
}
finally
{
    await handle.close();
}
NODE
    dumpPid="$!"
    if ! RegisterChildIdentity "$dumpPid"; then
        AddBlocker "database-snapshot-dump-synchronization-ownership-unverified"
        return 1
    fi
    if ! WaitCaptureChild "$dumpPid"; then
        AddBlocker "database-snapshot-dump-synchronization-failed"
        return 1
    fi
    dumpPid=""
    if ! remaining="$(CaptureRemaining)" || ! printf 'DUMP_COMPLETED\n' >&"$captureWriteFd" \
        || ! IFS= read -r -t "$remaining" -u "$captureReadFd" final; then
        AddBlocker "database-snapshot-capture-terminal-missing"
        return 1
    fi
    exec {captureWriteFd}>&-
    captureWriteFd=""
    exec {captureReadFd}<&-
    captureReadFd=""
    if ! WaitCaptureChild "$capturePid"; then
        AddBlocker "database-snapshot-capture-failed"
        return 1
    fi
    capturePid=""
    rm -f "$environmentFile"
    if ! jq -e --argjson start "$start" --arg digest "$(sha256sum "$target" | awk '{print $1}')" \
        '.status == "ok" and .capture.Source == $start.Source and .capture.SnapshotId == $start.SnapshotId
         and .capture.CapturedAt == $start.CapturedAt and .capture.ObserverId == $start.ObserverId
         and .capture.ObserverVersion == $start.ObserverVersion and .capture.TimeoutSeconds == $start.TimeoutSeconds
         and .capture.DatabaseDumpSha256 == $digest' <<<"$final" >/dev/null; then
        AddBlocker "database-snapshot-capture-binding-invalid"
        return 1
    fi
    sourceCapture="$(jq -c '.capture' <<<"$final")"
    AddCheck "database-source-snapshot" "captured"
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
      if (tolower(key) ~ /(secret|password|token|key|connection|string|identity|recipient|passphrase)/) value="<redacted>"
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
        --argjson sourceCapture "$sourceCapture" \
        '{
      kind: "fsusblog-site-backup",
      version: (if $sourceCapture == null then 2 else 3 end),
      runId: $runId,
      generatedAt: $generatedAt,
      sourceBinding: (if $sourceCapture == null then null else {
        owner: "tools/operations/backup-site.sh", ownerVersion: "3", capture: $sourceCapture,
        databaseDumpSha256: $databaseSha256
      } end),
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
    manifestSha256="$(sha256sum "$WORK_DIR/manifest.json" | awk '{print $1}')"
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
    if [[ -n "$migrationDll" ]] && ! ReadCaptureBudget; then
        printf '%s\n' '{"status":"blocked","code":"database-snapshot-timeout-invalid-or-missing"}' >&2
        return 1
    fi
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
    if [[ -n "$migrationDll" ]]; then
        RequireCommand "${DOTNET_BIN:-dotnet}"
        RequireCommand timeout
        RequireCommand ps
        RequireCommand sleep
    fi
    if [[ "$databaseProvider" != "postgresql" ]]; then
        AddBlocker "database-backup-provider-unsupported:$databaseProvider"
    fi

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
            packageSha256="$(sha256sum "$PACKAGE_PATH" | awk '{print $1}')"
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
