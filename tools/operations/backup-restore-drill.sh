#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_DRILL_OUTPUT_DIR:-$ROOT_DIR/.tmp/operations}"
MODE="${FSUSBLOG_DRILL_MODE:-dry-run}"
RUN_ID="${FSUSBLOG_DRILL_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
WORK_DIR="${FSUSBLOG_DRILL_WORK_DIR:-$OUT_DIR/backup-restore-drill-$RUN_ID}"
OUT_FILE="$OUT_DIR/backup-restore-drill.json"
RESIDUE_REPORT_FILE="$OUT_DIR/backup-restore-anonymous-residue.json"
RESTORE_MANIFEST_FILE="$OUT_DIR/backup-restore-manifest.json"
RESTORE_STACK="${FSUSBLOG_DRILL_RESTORE_STACK:-1}"
KEEP_WORK="${FSUSBLOG_DRILL_KEEP_WORK:-0}"
BACKEND_PORT="${FSUSBLOG_DRILL_BACKEND_PORT:-5180}"
BASE_URL="http://127.0.0.1:${BACKEND_PORT}"

POSTGRES_BACKUP="${FSUSBLOG_POSTGRES_BACKUP:-}"
REDIS_BACKUP="${FSUSBLOG_REDIS_BACKUP:-}"
UPLOADS_BACKUP="${FSUSBLOG_UPLOADS_BACKUP:-}"
AOT_BACKUP="${FSUSBLOG_AOT_BACKUP:-}"
SEARCH_BACKUP="${FSUSBLOG_SEARCH_BACKUP:-}"
SITE_BACKUP_PACKAGE="${FSUSBLOG_SITE_BACKUP_PACKAGE:-}"
BACKUP_IDENTITY_FILE="${FSUSBLOG_BACKUP_IDENTITY_FILE:-}"
BACKUP_IDENTITY_PASSPHRASE_FILE="${FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE:-}"
BACKUP_ENVELOPE_TOOL="$ROOT_DIR/tools/operations/backup-envelope.mjs"
sitePackageSha256=""
siteManifestSha256=""
migrationDll="${FSUSBLOG_MIGRATION_SERVER_DLL:-}"
sourceBinding="null"
sourceTimeoutSeconds="${FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS:-}"
sourceDeadline=0
sourceChildPid=""
sourceCleanupVerified=1
declare -A sourceChildIdentities=()
sourceFailureLog="$OUT_DIR/backup-restore-drill-${RUN_ID}.source-stderr.log"
restoredSource="null"
restoredDatabaseDumpSha256=""

status="ok"
blockers=()
checks=()
backend_pid=""
postgres_container="fsusblog-restore-postgres-${RUN_ID//[^a-zA-Z0-9]/-}"
redis_container="fsusblog-restore-redis-${RUN_ID//[^a-zA-Z0-9]/-}"
restore_started_at=0
restore_finished_at=0
workDirOwned=0
postgresOwned=0
redisOwned=0
evidenceMode=0
evidenceWorker=0
evidenceTimeoutArgument=0
evidenceNonce=""
evidenceCleanupVerified=1
evidenceWorkIdentity=""
postgresAttempted=0
redisAttempted=0

while [[ "${BASH_SOURCE[0]}" == "$0" && $# -gt 0 ]]; do
    case "$1" in
        --migration-evidence) evidenceMode=1; shift ;;
        --timeout-seconds)
            if [[ $# -lt 2 ]]; then
                blockers+=("drill-timeout-argument-missing")
                status="blocked"
                shift
            else
                sourceTimeoutSeconds="$2"
                evidenceTimeoutArgument=1
                shift 2
            fi
            ;;
        *) blockers+=("unknown-arg:$1"); status="blocked"; shift ;;
    esac
done

ReadSourceBudget() {
    if [[ ! -r /proc/uptime || ! "$sourceTimeoutSeconds" =~ ^[1-9][0-9]{0,6}$ ]] || ((sourceTimeoutSeconds > 2147483)); then
        AddBlocker "database-snapshot-timeout-invalid-or-missing"
        return 1
    fi
    if [[ "$sourceDeadline" == "0" ]]; then
        sourceDeadline=$(( $(SourceNow) + sourceTimeoutSeconds ))
    fi
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
        StopSourceChild "$sourceChildPid" || sourceCleanupVerified=0
        return 1
    fi
    sourceChildPid=""
}

Log() {
    printf '[backup-restore-drill] %s\n' "$1"
}

AddCheck() {
    checks+=("$1:$2")
}

AddBlocker() {
    status="blocked"
    blockers+=("$1")
}

Cleanup() {
    StopSourceChild "$sourceChildPid" || sourceCleanupVerified=0
    if [[ "$workDirOwned" == "1" ]]; then
        rm -f "$WORK_DIR/site-package.plaintext.tar.gz"
    fi
    if [[ "$evidenceMode" == "1" ]]; then
        [[ "$evidenceWorker" == "1" ]] || return
        if [[ -n "$backend_pid" ]]; then
            StopSourceChild "$backend_pid" || sourceCleanupVerified=0
            AddBlocker "pre-migration-backup-started-unexpected-backend"
            evidenceCleanupVerified=0
        fi
        local sourcePath destinationName
        for destinationName in backend.log native-restored-source.json package-manifest.json; do
            case "$destinationName" in
                backend.log) sourcePath="$WORK_DIR/backend.log" ;;
                native-restored-source.json) sourcePath="$WORK_DIR/.source-observer.stdout" ;;
                package-manifest.json) sourcePath="$WORK_DIR/site-package/manifest.json" ;;
            esac
            if [[ -f "$sourcePath" && ! -L "$sourcePath" ]]; then
                RunSourceCommand "$OUT_DIR/owned-raw-retention.stdout" cp "$sourcePath" "$OUT_DIR/$destinationName" </dev/null || evidenceCleanupVerified=0
            fi
        done
        CleanupEvidenceContainer postgres "$postgresAttempted" || evidenceCleanupVerified=0
        CleanupEvidenceContainer redis "$redisAttempted" || evidenceCleanupVerified=0
        if [[ "$redisAttempted" == "1" ]]; then
            AddBlocker "pre-migration-backup-started-unexpected-redis"
            evidenceCleanupVerified=0
        fi
        if [[ "$workDirOwned" == "1" && "$sourceCleanupVerified" == "1" && "$evidenceCleanupVerified" == "1" ]]; then
            if [[ -L "$WORK_DIR" || "$(stat -c '%d:%i' -- "$WORK_DIR")" != "$evidenceWorkIdentity" ]]; then
                evidenceCleanupVerified=0
            else
                RunSourceCommand "$OUT_DIR/owned-work-cleanup.stdout" rm -rf -- "$WORK_DIR" </dev/null || evidenceCleanupVerified=0
            fi
            [[ ! -e "$WORK_DIR" && ! -L "$WORK_DIR" ]] || evidenceCleanupVerified=0
        fi
        if [[ "$sourceCleanupVerified" == "1" && "$evidenceCleanupVerified" == "1" ]]; then
            AddCheck "owned-pre-migration-resources-terminal" "verified"
        else
            AddBlocker "owned-drill-cleanup-unverified"
        fi
        return
    fi
    if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" >/dev/null 2>&1; then
        kill "$backend_pid" >/dev/null 2>&1 || true
        wait "$backend_pid" >/dev/null 2>&1 || true
    fi

    if [[ "$KEEP_WORK" != "1" && "$MODE" != "dry-run" ]]; then
        if [[ "$postgresOwned" == "1" ]]; then
            docker rm -f "$postgres_container" >/dev/null 2>&1 || true
        fi
        if [[ "$redisOwned" == "1" ]]; then
            docker rm -f "$redis_container" >/dev/null 2>&1 || true
        fi
        if [[ "$workDirOwned" == "1" && "$sourceCleanupVerified" == "1" ]]; then
            rm -rf "$WORK_DIR"
        fi
    fi
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

trap Cleanup EXIT

CleanupEvidenceContainer() {
    local kind="$1" attempted="$2" cid label remaining
    [[ "$attempted" == "1" ]] || return 0
    if [[ ! -f "$OUT_DIR/owned-$kind.cid" || -L "$OUT_DIR/owned-$kind.cid" ]]; then
        AddBlocker "owned-$kind-container-id-unavailable"
        return 1
    fi
    read -r cid <"$OUT_DIR/owned-$kind.cid" || [[ -n "$cid" ]]
    [[ "$cid" =~ ^[0-9a-f]{64}$ ]] || return 1
    if ! RunSourceCommand "$OUT_DIR/owned-$kind-label.stdout" docker inspect \
        --format '{{index .Config.Labels "fsusblog.backup-drill-owner"}}' "$cid" </dev/null; then
        return 1
    fi
    label="$(<"$OUT_DIR/owned-$kind-label.stdout")"
    [[ "$label" == "$evidenceNonce" ]] || return 1
    RunSourceCommand "$OUT_DIR/owned-$kind-remove.stdout" docker rm -f "$cid" </dev/null || return 1
    RunSourceCommand "$OUT_DIR/owned-$kind-after.stdout" docker ps -aq --no-trunc --filter "id=$cid" </dev/null || return 1
    [[ ! -s "$OUT_DIR/owned-$kind-after.stdout" ]] || return 1
    AddCheck "owned-$kind-container-removed" "verified"
}

JsonStringArray() {
    if (("$#" == 0)); then
        printf '[]'
        return
    fi

    printf '%s\n' "$@" | jq -R . | jq -s .
}

WriteReport() {
    local checksJson blockersJson generatedAt rpoSeconds rtoSeconds reportMode="$MODE"
    if [[ "$evidenceMode" == "1" ]]; then
        reportMode="migration-recoverability"
    fi
    generatedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    checksJson="$(JsonStringArray "${checks[@]}")"
    blockersJson="$(JsonStringArray "${blockers[@]}")"
    rpoSeconds=null
    rtoSeconds=null

    if [[ -n "$POSTGRES_BACKUP" && -e "$POSTGRES_BACKUP" ]]; then
        local backupMtime
        backupMtime="$(stat -c %Y "$POSTGRES_BACKUP" 2>/dev/null || true)"
        if [[ -n "$backupMtime" ]]; then
            rpoSeconds=$(($(date -u +%s) - backupMtime))
        fi
    fi

    if ((restore_started_at > 0 && restore_finished_at >= restore_started_at)); then
        rtoSeconds=$((restore_finished_at - restore_started_at))
    fi

    jq -n \
        --arg status "$status" \
        --arg mode "$reportMode" \
        --arg generatedAt "$generatedAt" \
        --arg runId "$RUN_ID" \
        --arg workDir "$WORK_DIR" \
        --arg baseUrl "$BASE_URL" \
        --arg packageSha256 "$sitePackageSha256" \
        --arg manifestSha256 "$siteManifestSha256" \
        --arg restoredDatabaseDumpSha256 "$restoredDatabaseDumpSha256" \
        --argjson sourceBinding "$sourceBinding" \
        --argjson restoredSource "$restoredSource" \
        --arg sourceFailureLog "$sourceFailureLog" \
        --argjson sourceCleanupVerified "$sourceCleanupVerified" \
        --argjson checks "$checksJson" \
        --argjson blockers "$blockersJson" \
        --argjson rpoSeconds "$rpoSeconds" \
        --argjson rtoSeconds "$rtoSeconds" \
        '{
      status: $status,
      mode: $mode,
      generatedAt: $generatedAt,
      runId: $runId,
      workDir: $workDir,
      baseUrl: (if $mode == "migration-recoverability" then null else $baseUrl end),
      packageSha256: (if $packageSha256 == "" then null else $packageSha256 end),
      manifestSha256: (if $manifestSha256 == "" then null else $manifestSha256 end),
      sourceBinding: $sourceBinding,
      restoredSource: $restoredSource,
      sourceFailureLog: $sourceFailureLog,
      sourceCleanupVerified: ($sourceCleanupVerified == 1),
      restoredDatabaseDumpSha256: (if $restoredDatabaseDumpSha256 == "" then null else $restoredDatabaseDumpSha256 end),
      checks: $checks,
      timings: {
        rpoSeconds: $rpoSeconds,
        rtoSeconds: $rtoSeconds
      },
      blockers: $blockers
    } + (if $mode == "migration-recoverability" then {scope:"pre-migration-backup"} else {} end)' >"$OUT_FILE"

    Log "wrote $OUT_FILE"
}

WriteRestoreManifest() {
    if [[ "$evidenceMode" == "1" ]]; then
        jq -n --arg runId "$RUN_ID" --argjson sourceBinding "$sourceBinding" \
            '{kind:"fsusblog-pre-migration-restore-manifest", version:1, runId:$runId,
              scope:"pre-migration-backup", sourceBinding:$sourceBinding,
              restorePolicy:{allowed:["database", "uploads", "dataProtectionKeyRing", "configRedacted", "aotCache", "searchIndex"],
                preserveCapturedSchemaAndContent:true, migrationApply:false, currentServerStarted:false, productionDrQualified:false}}' \
            >"$RESTORE_MANIFEST_FILE"
        AddCheck "restore-manifest" "written"
        return
    fi
    jq -n \
        --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg runId "$RUN_ID" \
        '{
      generatedAt: $generatedAt,
      runId: $runId,
      restorePolicy: {
        allowed: [
          "postgres-schema-and-anonymous-account-state",
          "uploads-content-addressed-assets",
          "data-protection-keyring",
          "public-aot-shells",
          "search-index-artifacts"
        ],
        rebuildRequired: [
          "redis-session-and-cache-state",
          "public-hot-read-cache",
          "notification-stream-backlog"
        ],
        sanitizeBeforeRestore: [
          "legacy-user-directories",
          "raw-ip-fields",
          "username-email-password-role-fields",
          "user-id-derived-search-or-aot-payloads"
        ]
      }
    }' >"$RESTORE_MANIFEST_FILE"

    AddCheck "restore-manifest" "written"
}

AppendResidueResult() {
    local file="$1"
    local category="$2"
    local severity="$3"
    local statusValue="$4"
    local hits="$5"
    local sample="$6"

    local tmp
    tmp="${file}.tmp"
    jq \
        --arg category "$category" \
        --arg severity "$severity" \
        --arg status "$statusValue" \
        --arg sample "$sample" \
        --argjson hits "$hits" \
        '.checks += [{
      category: $category,
      severity: $severity,
      status: $status,
      hits: $hits,
      sample: (if $sample == "" then null else $sample end)
    }]' "$file" >"$tmp"
    mv "$tmp" "$file"
}

ScanPathForResidue() {
    local report="$1"
    local category="$2"
    local severity="$3"
    local path="$4"
    shift 4
    local pattern="$*"

    if [[ ! -e "$path" ]]; then
        AppendResidueResult "$report" "$category" "$severity" "skipped" 0 "path-missing:$path"
        return 0
    fi

    local matches hitCount sample
    matches="$(grep -RInaE "$pattern" "$path" 2>/dev/null || true)"
    if [[ -z "$matches" ]]; then
        AppendResidueResult "$report" "$category" "$severity" "ok" 0 ""
        return 0
    fi

    hitCount="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
    sample="$(printf '%s\n' "$matches" | head -1)"
    AppendResidueResult "$report" "$category" "$severity" "blocked" "$hitCount" "$sample"
    if [[ "$severity" == "P0" ]]; then
        return 1
    fi
    return 0
}

ScanPostgresForResidue() {
    local report="$1"
    if ! docker ps --format '{{.Names}}' | grep -Fx "$postgres_container" >/dev/null 2>&1; then
        AppendResidueResult "$report" "postgres" "P0" "skipped" 0 "postgres-container-not-running"
        return 0
    fi

    local sql result hits
    sql="
WITH legacy_columns AS (
  SELECT table_name || '.' || column_name AS sample
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (
      (table_name = 'sys_user' AND column_name IN ('username','password','password_hash','email','lastloginip','role'))
      OR (table_name = 'comment' AND column_name IN ('reply_to_user_id','moderated_by_user_id','user_name','reply_to_user_name'))
      OR (table_name = 'sys_user_session' AND column_name IN ('last_ip','user_name'))
      OR (table_name = 'message' AND column_name IN ('from_user_id','to_user_id'))
    )
),
retired_read_event_tables AS (
  SELECT 'sys_visit_log retired read-event table' AS sample
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'sys_visit_log'
)
SELECT sample FROM legacy_columns
UNION ALL
SELECT sample FROM retired_read_event_tables
LIMIT 20;"
    result="$(docker exec "$postgres_container" psql -U fsusblog -d fsusblog -At -c "$sql" 2>/dev/null || true)"
    if [[ -z "$result" ]]; then
        AppendResidueResult "$report" "postgres" "P0" "ok" 0 ""
        return 0
    fi

    hits="$(printf '%s\n' "$result" | wc -l | tr -d ' ')"
    AppendResidueResult "$report" "postgres" "P0" "blocked" "$hits" "$(printf '%s\n' "$result" | head -1)"
    return 1
}

ScanRedisForResidue() {
    local report="$1"
    if ! docker ps --format '{{.Names}}' | grep -Fx "$redis_container" >/dev/null 2>&1; then
        AppendResidueResult "$report" "redis" "P0" "skipped" 0 "redis-container-not-running"
        return 0
    fi

    local keys hits
    keys="$(docker exec "$redis_container" redis-cli --scan 2>/dev/null | grep -E '(^|:)(user|username|email|password|role|session:user|auth:user)(:|$)' || true)"
    if [[ -z "$keys" ]]; then
        AppendResidueResult "$report" "redis" "P0" "ok" 0 ""
        return 0
    fi

    hits="$(printf '%s\n' "$keys" | wc -l | tr -d ' ')"
    AppendResidueResult "$report" "redis" "P0" "blocked" "$hits" "$(printf '%s\n' "$keys" | head -1)"
    return 1
}

FinalizeResidueReport() {
    local report="$1"
    local tmp
    tmp="${report}.tmp"
    jq '(.summary.totalChecks = (.checks | length))
      | (.summary.blockers = ([.checks[] | select(.status == "blocked" and .severity == "P0")] | length))
      | (.summary.warnings = ([.checks[] | select(.status == "blocked" and .severity != "P0")] | length))
      | (.status = if .summary.blockers > 0 then "blocked" else "ok" end)' "$report" >"$tmp"
    mv "$tmp" "$report"
}

RunAnonymousResidueGate() {
    local report="$RESIDUE_REPORT_FILE"
    jq -n \
        --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg runId "$RUN_ID" \
        --arg mode "$MODE" \
        '{status:"ok", generatedAt:$generatedAt, runId:$runId, mode:$mode, checks:[], summary:{totalChecks:0, blockers:0, warnings:0}}' >"$report"

    if [[ "$MODE" == "dry-run" ]]; then
        AppendResidueResult "$report" "postgres" "P0" "planned" 0 "retired sys_visit_log/sys_user.lastloginip/legacy user fields"
        AppendResidueResult "$report" "redis" "P0" "planned" 0 "legacy user/session/cache key prefixes"
        AppendResidueResult "$report" "search" "P0" "planned" 0 "public search documents must not expose userId/username/email/ip"
        AppendResidueResult "$report" "aot-static" "P0" "planned" 0 "AOT/static artifacts must not expose legacy account fields"
        AppendResidueResult "$report" "uploads-manifest" "P1" "planned" 0 "uploads manifests must not use legacy user directories"
        FinalizeResidueReport "$report"
        AddCheck "anonymous-residue-gate" "planned"
        return 0
    fi

    local blocked=0
    ScanPostgresForResidue "$report" || blocked=1
    ScanRedisForResidue "$report" || blocked=1
    ScanPathForResidue "$report" "search" "P0" "$WORK_DIR/webroot/search" '\b(userId|username|userName|email|ip|replyToUserId)\b' || blocked=1
    ScanPathForResidue "$report" "aot-static" "P0" "$WORK_DIR/webroot/aot-cache" '\b(userId|username|userName|email|ip|replyToUserId)\b' || blocked=1
    ScanPathForResidue "$report" "uploads-manifest" "P1" "$WORK_DIR/webroot/uploads" '(^|/)(user|username|email|legacy-user)[-_]?[0-9A-Za-z]*' || true
    (
        cd "$ROOT_DIR"
        FSUSBLOG_HISTORICAL_RESIDUE_ROOT="$ROOT_DIR" bash tools/check-historical-residue.sh >/dev/null
    ) || blocked=1
    AppendResidueResult "$report" "repository-static-residue" "P0" "$([[ "$blocked" == "0" ]] && printf ok || printf blocked)" "$blocked" "tools/check-historical-residue.sh"
    FinalizeResidueReport "$report"

    if [[ "$blocked" != "0" ]]; then
        AddBlocker "anonymous-residue-gate-blocked:$report"
        return 1
    fi

    AddCheck "anonymous-residue-gate" "ok"
}

RequireCommand() {
    command -v "$1" >/dev/null 2>&1 || AddBlocker "command-missing:$1"
}

RequireBackup() {
    local value="$1"
    local label="$2"
    if [[ -z "$value" || ! -r "$value" ]]; then
        AddBlocker "${label}-backup-missing"
        return
    fi

    AddCheck "${label}-backup" "present"
}

CopyTree() {
    local source="$1"
    local target="$2"
    mkdir -p "$target"
    if [[ -d "$source" ]]; then
        (cd "$source" && tar -cf - .) | (cd "$target" && tar -xf -)
        return
    fi

    case "$source" in
        *.tar.gz | *.tgz)
            tar -xzf "$source" -C "$target"
            ;;
        *.tar)
            tar -xf "$source" -C "$target"
            ;;
        *)
            AddBlocker "unsupported-file-backup:${source##*/}"
            ;;
    esac
}

NormalizeRestoredChildDir() {
    local parent="$1"
    local child="$2"
    local target="$parent/$child"
    local nested="$target/$child"

    if [[ -d "$nested" ]]; then
        (cd "$nested" && tar -cf - .) | (cd "$target" && tar -xf -)
        rm -rf "$nested"
    fi
}

WaitForPostgres() {
    for ((i = 0; i < 60; i += 1)); do
        # The official image initializes through a temporary socket-only server.
        # TCP readiness proves that initialization has reached the final server.
        if docker exec "$postgres_container" pg_isready -h 127.0.0.1 -U fsusblog -d fsusblog >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

WaitForRedis() {
    for ((i = 0; i < 60; i += 1)); do
        if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

ContainerIp() {
    docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}

RestorePostgres() {
    local postgresImage
    postgresImage="$(node "$ROOT_DIR/tools/test/execution-envelope-services.mjs" --image-reference postgres)"
    docker image inspect "$postgresImage" >/dev/null 2>&1 || {
        AddBlocker "postgres-pinned-image-missing"
        return
    }
    local -a ownershipOptions=()
    if [[ "$evidenceMode" == "1" ]]; then
        ownershipOptions=(--cidfile "$OUT_DIR/owned-postgres.cid" --label "fsusblog.backup-drill-owner=$evidenceNonce")
        postgresAttempted=1
    fi
    if ! docker run -d "${ownershipOptions[@]}" \
        --name "$postgres_container" \
        -e POSTGRES_USER=fsusblog \
        -e POSTGRES_PASSWORD=fsusblog_dev \
        -e POSTGRES_DB=fsusblog \
        "$postgresImage" >/dev/null; then
        AddBlocker "postgres-restore-container-start-failed"
        return
    fi
    postgresOwned=1

    WaitForPostgres || {
        AddBlocker "postgres-restore-container-not-ready"
        return
    }

    if [[ "$sourceBinding" != "null" ]]; then
        # The isolated drill owns its database role, not the source cluster's
        # role catalogue. Restore objects under that role; native schema/content
        # comparison below still verifies the authenticated source snapshot.
        if ! RunSourceCommand "$WORK_DIR/.database-restore.stdout" \
            docker exec -i "$postgres_container" pg_restore -U fsusblog -d fsusblog --exit-on-error --clean --if-exists --no-owner <"$POSTGRES_BACKUP"; then
            AddBlocker "database-restore-failed"
            return
        fi
    else
    case "$POSTGRES_BACKUP" in
        *.dump | *.backup)
            docker exec -i "$postgres_container" pg_restore -U fsusblog -d fsusblog --clean --if-exists <"$POSTGRES_BACKUP"
            ;;
        *.gz)
            gzip -dc "$POSTGRES_BACKUP" | docker exec -i "$postgres_container" psql -v ON_ERROR_STOP=1 -U fsusblog -d fsusblog >/dev/null
            ;;
        *)
            docker exec -i "$postgres_container" psql -v ON_ERROR_STOP=1 -U fsusblog -d fsusblog >/dev/null <"$POSTGRES_BACKUP"
            ;;
    esac
    fi

    if [[ "$sourceBinding" != "null" ]]; then
        VerifyRestoredSource || return
    fi

    AddCheck "postgres-restore" "ok"
}

VerifyRestoredSource() {
    local environmentFile="$WORK_DIR/.source-observer.env" pgIp actualDigest
    if [[ ! -f "$migrationDll" || -L "$migrationDll" ]]; then
        AddBlocker "database-restored-source-observer-unavailable"
        return 1
    fi
    pgIp="$(ContainerIp "$postgres_container")"
    if [[ -z "$pgIp" ]]; then
        AddBlocker "database-restored-source-instance-missing"
        return 1
    fi
    actualDigest="$(sha256sum "$POSTGRES_BACKUP" | awk '{print $1}')"
    if [[ "$actualDigest" != "$(jq -r '.databaseDumpSha256' <<<"$sourceBinding")" ]]; then
        AddBlocker "database-restored-dump-binding-mismatch"
        return 1
    fi
    printf 'ConnectionStrings__DefaultConnection=Host=%s;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev\n' \
        "$pgIp" >"$environmentFile"
    if ! RunSourceCommand "$WORK_DIR/.source-observer.stdout" "${DOTNET_BIN:-dotnet}" "$migrationDll" observe-source --provider postgresql \
        --env-file "$environmentFile" --timeout-seconds "$(SourceRemaining)"; then
        rm -f "$environmentFile"
        restoredSource="null"
        AddBlocker "database-restored-source-observation-failed"
        return 1
    fi
    restoredSource="$(<"$WORK_DIR/.source-observer.stdout")"
    rm -f "$environmentFile"
    if ! jq -e --argjson binding "$sourceBinding" \
        '. as $restored | .Database.Provider == 0 and .Database != $binding.capture.Source.Database
         and . == ($binding.capture.Source | .Database = $restored.Database)' <<<"$restoredSource" >/dev/null; then
        restoredSource="null"
        AddBlocker "database-restored-source-not-isolated-or-content-mismatch"
        return 1
    fi
    restoredDatabaseDumpSha256="$actualDigest"
    AddCheck "database-restored-source" "verified"
}

RestoreRedis() {
    local redisData="$WORK_DIR/redis-data"
    local redisImage
    redisImage="$(node "$ROOT_DIR/tools/test/execution-envelope-services.mjs" --image-reference redis)"
    docker image inspect "$redisImage" >/dev/null 2>&1 || {
        AddBlocker "redis-pinned-image-missing"
        return
    }
    mkdir -p "$redisData"

    if [[ -d "$REDIS_BACKUP" ]]; then
        CopyTree "$REDIS_BACKUP" "$redisData"
    else
        cp "$REDIS_BACKUP" "$redisData/dump.rdb"
    fi

    chmod -R a+rwX "$redisData"
    local -a ownershipOptions=()
    if [[ "$evidenceMode" == "1" ]]; then
        ownershipOptions=(--cidfile "$OUT_DIR/owned-redis.cid" --label "fsusblog.backup-drill-owner=$evidenceNonce")
        redisAttempted=1
    fi
    if ! docker run -d "${ownershipOptions[@]}" \
        --name "$redis_container" \
        -v "$redisData:/data" \
        "$redisImage" redis-server --save "" --appendonly no >/dev/null; then
        AddBlocker "redis-restore-container-start-failed"
        return
    fi
    redisOwned=1

    WaitForRedis || {
        AddBlocker "redis-restore-container-not-ready"
        return
    }

    AddCheck "redis-restore" "ok"
}

RestoreWebrootArtifacts() {
    local sourceWebroot="${FSUSBLOG_WEB_ROOT:-$ROOT_DIR/src/backend/wwwroot}"
    local restoredWebroot="$WORK_DIR/webroot"

    if [[ ! -d "$sourceWebroot" ]]; then
        AddBlocker "source-webroot-missing"
        return
    fi

    mkdir -p "$restoredWebroot"
    (cd "$sourceWebroot" && tar -cf - .) | (cd "$restoredWebroot" && tar -xf -)
    rm -rf "$restoredWebroot/uploads" "$restoredWebroot/aot-cache" "$restoredWebroot/search"

    CopyTree "$UPLOADS_BACKUP" "$restoredWebroot/uploads"
    CopyTree "$AOT_BACKUP" "$restoredWebroot/aot-cache"
    CopyTree "$SEARCH_BACKUP" "$restoredWebroot/search"

    NormalizeRestoredChildDir "$restoredWebroot" "uploads"
    NormalizeRestoredChildDir "$restoredWebroot" "aot-cache"
    NormalizeRestoredChildDir "$restoredWebroot" "search"

    [[ -d "$restoredWebroot/uploads" ]] || AddBlocker "uploads-restore-missing"
    [[ -d "$restoredWebroot/aot-cache" ]] || AddBlocker "aot-restore-missing"
    [[ -f "$restoredWebroot/search/index.manifest.aeds" ]] || AddBlocker "search-manifest-restore-missing"
    AddCheck "webroot-artifact-restore" "ok"
}

PrepareSiteBackupPackage() {
    if [[ -z "$SITE_BACKUP_PACKAGE" ]]; then
        return
    fi

    if [[ ! -r "$SITE_BACKUP_PACKAGE" ]]; then
        AddBlocker "site-backup-package-missing"
        return
    fi

    if [[ -n "$POSTGRES_BACKUP" || -n "$REDIS_BACKUP" || -n "$UPLOADS_BACKUP" || -n "$AOT_BACKUP" || -n "$SEARCH_BACKUP" ]]; then
        AddBlocker "site-backup-artifact-override-forbidden"
        return
    fi

    local packageDir="$WORK_DIR/site-package"
    local decryptedPackage="$WORK_DIR/site-package.plaintext.tar.gz"
    mkdir -p "$packageDir"
    if [[ -z "$BACKUP_IDENTITY_FILE" || ! -r "$BACKUP_IDENTITY_FILE" ]]; then
        AddBlocker "site-backup-identity-missing"
        return
    fi
    local decryptArgs=(
        decrypt
        --input "$SITE_BACKUP_PACKAGE"
        --output "$decryptedPackage"
        --identity "$BACKUP_IDENTITY_FILE"
    )
    if [[ -n "$BACKUP_IDENTITY_PASSPHRASE_FILE" ]]; then
        decryptArgs+=(--passphrase-file "$BACKUP_IDENTITY_PASSPHRASE_FILE")
    fi
    local envelopeInfo recipientKeyId
    sitePackageSha256="$(sha256sum "$SITE_BACKUP_PACKAGE" | awk '{print $1}')"
    if ! envelopeInfo="$(node "$BACKUP_ENVELOPE_TOOL" "${decryptArgs[@]}")"; then
        AddBlocker "site-backup-envelope-invalid"
        return
    fi
    if [[ "$sitePackageSha256" != "$(sha256sum "$SITE_BACKUP_PACKAGE" | awk '{print $1}')" ]]; then
        AddBlocker "site-backup-package-changed-during-authentication"
        rm -f "$decryptedPackage"
        return
    fi
    recipientKeyId="$(jq -r '.recipientKeyId // empty' <<<"$envelopeInfo")"
    if ! ArchiveIsSafe "$decryptedPackage"; then
        AddBlocker "site-backup-archive-unsafe"
        rm -f "$decryptedPackage"
        return
    fi
    tar --no-same-owner --no-same-permissions -xzf "$decryptedPackage" -C "$packageDir"
    rm -f "$decryptedPackage"

    if ! jq -e --arg recipientKeyId "$recipientKeyId" --argjson migrationEvidence "$evidenceMode" \
        '.kind == "fsusblog-site-backup"
      and (.version == 2 or .version == 3)
      and .envelope.recipientKeyId == $recipientKeyId
      and .dataProtection.encryptedAtRest == true
      and .dataProtection.plaintextMasterKeyPresent == false
      and (if $migrationEvidence == 1 then .dataProtection.encryptedKeyCount > 0 else .dataProtection.encryptedKeyCount >= 2 end)' \
        "$packageDir/manifest.json" >/dev/null; then
        AddBlocker "site-backup-key-generation-manifest-invalid"
        return
    fi

    local label artifact expectedDigest actualDigest expectedArtifact
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        case "$label" in
            database) expectedArtifact="database.dump" ;;
            uploads) expectedArtifact="uploads.tar.gz" ;;
            dataProtectionKeyRing) expectedArtifact="data-protection-keyring.tar.gz" ;;
            configRedacted) expectedArtifact="config.redacted.tar.gz" ;;
            aotCache) expectedArtifact="aot-cache.tar.gz" ;;
            searchIndex) expectedArtifact="search.tar.gz" ;;
        esac
        artifact="$(jq -r --arg label "$label" '.artifacts[$label] // empty' "$packageDir/manifest.json")"
        expectedDigest="$(jq -r --arg label "$label" '.artifactDigests[$label] // empty' "$packageDir/manifest.json")"
        if [[ "$artifact" != "$expectedArtifact" || ! "$expectedDigest" =~ ^[0-9a-f]{64}$ || ! -f "$packageDir/$artifact" ]]; then
            AddBlocker "site-backup-artifact-invalid:$label"
            return
        fi
        actualDigest="$(sha256sum "$packageDir/$artifact" | awk '{print $1}')"
        if [[ "$actualDigest" != "$expectedDigest" ]]; then
            AddBlocker "site-backup-artifact-digest-mismatch:$label"
            return
        fi
        if [[ "$label" != "database" ]] && ! ArchiveIsSafe "$packageDir/$artifact"; then
            AddBlocker "site-backup-inner-artifact-archive-unsafe:$label"
            return
        fi
    done

    siteManifestSha256="$(sha256sum "$packageDir/manifest.json" | awk '{print $1}')"
    if [[ "$(jq -r '.version' "$packageDir/manifest.json")" == "3" ]]; then
        if ! jq -e '.sourceBinding.owner == "tools/operations/backup-site.sh" and .sourceBinding.ownerVersion == "3"
            and .sourceBinding.capture.Source.Database.Provider == 0
            and (.sourceBinding.capture.Source.ContentDigest | test("^[0-9a-f]{64}$"))
            and (.sourceBinding.capture.SnapshotId | type == "string" and length > 0)
            and .sourceBinding.capture.DatabaseDumpSha256 == .artifactDigests.database
            and .sourceBinding.databaseDumpSha256 == .artifactDigests.database' "$packageDir/manifest.json" >/dev/null; then
            AddBlocker "site-backup-source-snapshot-binding-invalid"
            return
        fi
        sourceBinding="$(jq -c '.sourceBinding' "$packageDir/manifest.json")"
        if ! ReadSourceBudget; then
            return
        fi
        RequireCommand timeout
        RequireCommand ps
        RequireCommand sleep
        if [[ ! -f "$migrationDll" || -L "$migrationDll" ]]; then
            AddBlocker "site-backup-source-observer-unavailable"
            return
        fi
    fi

    local keyringDir="$WORK_DIR/data-protection-keyring"
    mkdir -p "$keyringDir"
    if ! ArchiveIsSafe "$packageDir/data-protection-keyring.tar.gz"; then
        AddBlocker "site-backup-keyring-archive-unsafe"
        return
    fi
    tar -xzf "$packageDir/data-protection-keyring.tar.gz" -C "$keyringDir"
    local keyFile generationCount=0
    while IFS= read -r -d '' keyFile; do
        generationCount=$((generationCount + 1))
        if ! grep -q 'encryptedSecret' "$keyFile" || grep -Eq '<masterKey([[:space:]>])' "$keyFile"; then
            AddBlocker "site-backup-key-generation-plaintext-or-invalid"
            return
        fi
    done < <(find "$keyringDir" -maxdepth 1 -type f -name 'key-*.xml' -print0)
    if [[ "$generationCount" != "$(jq -r '.dataProtection.encryptedKeyCount' "$packageDir/manifest.json")" ]]; then
        AddBlocker "site-backup-key-generation-count-mismatch"
        return
    fi

    POSTGRES_BACKUP="$packageDir/database.dump"
    if [[ -z "$REDIS_BACKUP" ]]; then
        mkdir -p "$packageDir/redis-empty"
        REDIS_BACKUP="$packageDir/redis-empty"
    fi
    UPLOADS_BACKUP="$packageDir/uploads.tar.gz"
    AOT_BACKUP="$packageDir/aot-cache.tar.gz"
    SEARCH_BACKUP="$packageDir/search.tar.gz"
    AddCheck "site-backup-package" "authenticated-unpacked"
    if [[ "$evidenceMode" == "1" ]]; then
        AddCheck "data-protection-captured-generations" "$generationCount"
    else
        AddCheck "data-protection-current-previous-generations" "$generationCount"
    fi
}

WaitForUrl() {
    local label="$1"
    local url="$2"
    local header="${3:-}"
    for ((i = 0; i < 120; i += 1)); do
        if [[ -n "$header" ]]; then
            if curl -fsS --max-time 5 -H "$header" "$url" >/dev/null 2>&1; then
                return 0
            fi
        elif curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    AddBlocker "${label}-not-ready"
    return 1
}

VerifyEvidenceBackendListener() {
    local output="$1" identity
    identity="${sourceChildIdentities[$backend_pid]:-}"
    [[ -n "$identity" ]] || return 1
    RunSourceCommand "$output" node --input-type=module - "$backend_pid" "$BACKEND_PORT" "$identity" <<'NODE'
import { readFile, readdir, readlink } from 'node:fs/promises';

const [leader, port, expected] = process.argv.slice(2);
const processGroup = async pid =>
{
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return { group: fields[2], identity: `${pid}:${fields[19]}` };
};
const initial = await processGroup(leader);
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || initial.identity !== expected || initial.group !== leader)
{
    throw new Error('owned backend leader identity invalid');
}
const table = await readFile('/proc/net/tcp', 'utf8');
const inodes = new Set(table.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
    .filter(fields => fields[3] === '0A' && Number.parseInt(fields[1].split(':')[1], 16) === Number(port)
        && ['0100007F', '00000000'].includes(fields[1].split(':')[0])).map(fields => fields[9]));
if (inodes.size === 0)
{
    throw new Error('owned backend listener absent');
}
const owned = new Set();
for (const pid of await readdir('/proc'))
{
    if (!/^[0-9]+$/.test(pid))
    {
        continue;
    }
    try
    {
        if ((await processGroup(pid)).group !== leader)
        {
            continue;
        }
        for (const fd of await readdir(`/proc/${pid}/fd`))
        {
            const target = await readlink(`/proc/${pid}/fd/${fd}`);
            const match = /^socket:\[([0-9]+)\]$/.exec(target);
            if (match && inodes.has(match[1]))
            {
                owned.add(match[1]);
            }
        }
    }
    catch (error)
    {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH')
        {
            throw error;
        }
    }
}
const final = await processGroup(leader);
if (owned.size !== inodes.size || final.identity !== expected || final.group !== leader)
{
    throw new Error('backend listener is not owned by this live process group');
}
console.log(JSON.stringify({ leader, identity: expected, port: Number(port), socketInodes: [...owned].sort() }));
NODE
}

StartRestoredBackend() {
    local pgIp redisIp
    local -a backendDeadlineCommand=()
    pgIp="$(ContainerIp "$postgres_container")"
    redisIp="$(ContainerIp "$redis_container")"
    [[ -n "$pgIp" ]] || AddBlocker "postgres-container-ip-missing"
    [[ -n "$redisIp" ]] || AddBlocker "redis-container-ip-missing"
    ((${#blockers[@]} == 0)) || return

    if [[ "$evidenceMode" == "1" ]]; then
        local remaining
        remaining="$(SourceRemaining)" || { AddBlocker "owned-drill-deadline-expired"; return; }
        backendDeadlineCommand=(timeout --signal=TERM --kill-after=1s "${remaining}s")
    fi

    (
        cd "$ROOT_DIR"
        exec "${backendDeadlineCommand[@]}" env \
            ASPNETCORE_ENVIRONMENT=Development \
            ASPNETCORE_URLS="$BASE_URL" \
            ASPNETCORE_WEBROOT="$WORK_DIR/webroot" \
            FSUSBLOG_DATA_ROOT="$WORK_DIR/data" \
            FSUSBLOG_DATA_PROTECTION_KEY_RING="$WORK_DIR/data-protection-keyring" \
            DataProtection__KeyRingPath="$WORK_DIR/data-protection-keyring" \
            ConnectionStrings__DefaultConnection="Host=${pgIp};Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Pooling=false" \
            ConnectionStrings__Redis="${redisIp}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__Configuration="${redisIp}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__InstanceName="FsusBlog_Drill_${RUN_ID}_" \
            Seo__BaseUrl="$BASE_URL" \
            CORS_ALLOWED_HOSTS="$BASE_URL" \
            ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile
    ) >"$WORK_DIR/backend.log" 2>&1 &
    backend_pid="$!"
    if [[ "$evidenceMode" == "1" ]] && ! RegisterChildIdentity "$backend_pid"; then
        AddBlocker "owned-backend-process-identity-unverified"
        return
    fi

    WaitForUrl "restored-backend-live" "$BASE_URL/health/live" || return
    WaitForUrl "restored-backend-pow" "$BASE_URL/api/binary/auth/pow-challenge" "Accept: application/octet-stream" || return
    if [[ "$evidenceMode" == "1" ]] && ! VerifyEvidenceBackendListener "$OUT_DIR/owned-backend-listener-start.json"; then
        AddBlocker "owned-restored-backend-listener-unverified"
        return
    fi
    AddCheck "restored-backend-start" "ok"
}

RunSmokeChecks() {
    WaitForUrl "public-page" "$BASE_URL/" || return
    AddCheck "public-page" "ok"

    WaitForUrl "binary-api" "$BASE_URL/api/binary/article/list/home/1/5.aeds" "Accept: application/octet-stream" || return
    AddCheck "binary-api" "ok"

    WaitForUrl "search-index" "$BASE_URL/search/index.manifest.aeds" || return
    AddCheck "search-index" "ok"

    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$BASE_URL" npm --prefix src/frontend run check:notification-stream-live >/dev/null
    )
    AddCheck "notification-stream-live" "ok"

    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$BASE_URL" \
            FSUSBLOG_PG_CONTAINER="$postgres_container" \
            node tools/test-fixtures/cli.mjs run --profile auth-basic --source dev-cli --skip-verify \
            --base-url "$BASE_URL" --pg-container "$postgres_container" >/dev/null

        FSUSBLOG_BASE_URL="$BASE_URL" \
            node --input-type=module -e "import { loginWithPow } from './tests/frontend/support/auth-helpers.mjs'; await loginWithPow(process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin', process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!', false, 'backup-restore-drill');"
    )
    AddCheck "admin-login" "ok"
}

RunDryRun() {
    status="scheduled"
    checks=(
        "postgres:planned"
        "redis:planned"
        "uploads:planned"
        "aot-cache:planned"
        "search-index:planned"
        "public-page:planned"
        "admin-login:planned"
        "binary-api:planned"
        "search:planned"
        "notification-stream:planned"
        "restore-manifest:planned"
        "anonymous-residue-gate:planned"
    )
    WriteRestoreManifest
    RunAnonymousResidueGate
}

RunReal() {
    RequireCommand docker
    RequireCommand dotnet
    RequireCommand curl
    RequireCommand jq
    RequireCommand npm
    RequireCommand node
    RequireCommand sha256sum
    if [[ -e "$WORK_DIR" || "$WORK_DIR" == "/" || "$WORK_DIR" == "$ROOT_DIR" || "$WORK_DIR" == "$OUT_DIR" ]]; then
        AddBlocker "restore-work-dir-not-fresh"
        return
    fi
    if ! mkdir -m 0700 "$WORK_DIR"; then
        AddBlocker "restore-work-dir-create-failed"
        return
    fi
    workDirOwned=1
    if [[ "$evidenceMode" == "1" ]]; then
        evidenceWorkIdentity="$(stat -c '%d:%i' -- "$WORK_DIR")"
    fi
    PrepareSiteBackupPackage
    if [[ "$evidenceMode" == "1" && "$sourceBinding" == "null" ]]; then
        AddBlocker "owned-drill-snapshot-bound-version3-required"
    fi
    RequireBackup "$POSTGRES_BACKUP" "postgres"
    RequireBackup "$REDIS_BACKUP" "redis"
    RequireBackup "$UPLOADS_BACKUP" "uploads"
    RequireBackup "$AOT_BACKUP" "aot"
    RequireBackup "$SEARCH_BACKUP" "search"

    if ((${#blockers[@]} > 0)); then
        return
    fi

    mkdir -p "$WORK_DIR"
    WriteRestoreManifest
    restore_started_at="$(date -u +%s)"
    RestorePostgres
    RestoreRedis
    RestoreWebrootArtifacts

    if ((${#blockers[@]} == 0 && RESTORE_STACK == 1)); then
        StartRestoredBackend
        RunSmokeChecks
    elif [[ "$RESTORE_STACK" != "1" ]]; then
        AddBlocker "runtime-smoke-disabled"
    fi

    RunAnonymousResidueGate || true
    restore_finished_at="$(date -u +%s)"
}

RestoreMigrationArtifacts() {
    local label artifact target expected actual
    for label in uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        artifact="$(jq -r --arg label "$label" '.artifacts[$label]' "$WORK_DIR/site-package/manifest.json")"
        expected="$(jq -r --arg label "$label" '.artifactDigests[$label]' "$WORK_DIR/site-package/manifest.json")"
        actual="$(sha256sum "$WORK_DIR/site-package/$artifact" | awk '{print $1}')"
        if [[ "$actual" != "$expected" ]] || ! ArchiveIsSafe "$WORK_DIR/site-package/$artifact"; then
            AddBlocker "pre-migration-artifact-changed-or-unsafe:$label"
            return
        fi
        target="$WORK_DIR/migration-artifacts/$label"
        mkdir -p "$target"
        if ! tar --no-same-owner --no-same-permissions -xzf "$WORK_DIR/site-package/$artifact" -C "$target"; then
            AddBlocker "pre-migration-artifact-restore-failed:$label"
            return
        fi
        AddCheck "$label-recoverable" "verified"
    done
}

RunPreMigrationRestore() {
    for command in docker dotnet jq node sha256sum tar; do
        RequireCommand "$command"
    done
    if (("${#blockers[@]}" != 0)); then return; fi
    if [[ -e "$WORK_DIR" || -L "$WORK_DIR" ]] || ! mkdir -m 0700 -- "$WORK_DIR"; then
        AddBlocker "restore-work-dir-not-fresh"
        return
    fi
    workDirOwned=1
    evidenceWorkIdentity="$(stat -c '%d:%i' -- "$WORK_DIR")"
    PrepareSiteBackupPackage
    if [[ "$sourceBinding" == "null" ]]; then
        AddBlocker "owned-drill-snapshot-bound-version3-required"
    fi
    if (("${#blockers[@]}" != 0)); then return; fi
    WriteRestoreManifest
    restore_started_at="$(date -u +%s)"
    RestorePostgres
    if (("${#blockers[@]}" == 0)); then
        RestoreMigrationArtifacts
    fi
    restore_finished_at="$(date -u +%s)"
}

RunEvidenceWorker() {
    trap 'AddBlocker "owned-drill-cancelled"; exit 143' TERM HUP
    trap 'AddBlocker "owned-drill-cancelled"; exit 130' INT
    RunPreMigrationRestore
    if [[ "$sourceBinding" == "null" || "$restoredSource" == "null" ]]; then
        AddBlocker "owned-drill-native-source-proof-unavailable"
    fi
    Cleanup
    trap - EXIT
    WriteReport
    [[ "$status" == "ok" && "$sourceCleanupVerified" == "1" && "$evidenceCleanupVerified" == "1" ]]
}

RunMigrationEvidence() {
    if [[ "$evidenceTimeoutArgument" != "1" ]] || ! ReadSourceBudget; then
        printf '%s\n' '{"status":"blocked","blocker":"owned-drill-timeout-invalid-or-missing"}' >&2
        return 1
    fi
    trap 'AddBlocker "owned-drill-cancelled"; exit 143' TERM HUP
    trap 'AddBlocker "owned-drill-cancelled"; exit 130' INT
    for command in bash jq node timeout ps sleep stat realpath sha256sum; do
        RequireCommand "$command"
    done
    if [[ "$MODE" != "real" || "$KEEP_WORK" != "0" \
        || ! -f "$SITE_BACKUP_PACKAGE" || -L "$SITE_BACKUP_PACKAGE" \
        || -e "$OUT_DIR" || -L "$OUT_DIR" || ! -d "$(dirname "$OUT_DIR")" ]]; then
        AddBlocker "owned-drill-input-or-private-root-invalid"
    fi
    if (("${#blockers[@]}" != 0)); then
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    OUT_DIR="$(realpath -m -- "$OUT_DIR")"
    WORK_DIR="$(realpath -m -- "$WORK_DIR")"
    case "$WORK_DIR" in "$OUT_DIR"/*) ;; *) AddBlocker "owned-drill-work-root-not-private"; return 1 ;; esac
    if ! mkdir -m 0700 -- "$OUT_DIR"; then
        AddBlocker "owned-drill-output-root-creation-failed"
        return 1
    fi
    evidenceNonce="$RUN_ID-$(stat -c '%d-%i' -- "$OUT_DIR")"
    OUT_FILE="$OUT_DIR/backup-restore-drill.json"
    RESTORE_MANIFEST_FILE="$OUT_DIR/backup-restore-manifest.json"
    RESIDUE_REPORT_FILE="$OUT_DIR/backup-restore-anonymous-residue.json"
    SITE_BACKUP_PACKAGE="$(realpath -e -- "$SITE_BACKUP_PACKAGE")"
    export FSUSBLOG_DRILL_OUTPUT_DIR="$OUT_DIR" FSUSBLOG_DRILL_WORK_DIR="$WORK_DIR" \
        FSUSBLOG_DRILL_RUN_ID="$RUN_ID" FSUSBLOG_SITE_BACKUP_PACKAGE="$SITE_BACKUP_PACKAGE" \
        FSUSBLOG_BACKUP_CAPTURE_TIMEOUT_SECONDS="$sourceTimeoutSeconds"
    sourceFailureLog="$OUT_DIR/owned-drill.stderr"
    if ! RunSourceCommand "$OUT_DIR/owned-drill.stdout" bash -c \
        'source "$1"; evidenceMode=1; evidenceWorker=1; sourceDeadline="$2"; evidenceNonce="$3"; RunEvidenceWorker' \
        owned-drill "$ROOT_DIR/tools/operations/backup-restore-drill.sh" "$sourceDeadline" "$evidenceNonce" </dev/null; then
        AddBlocker "owned-drill-producer-terminal-or-cleanup-failed"
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    # These are this invocation's actual producer artifacts, not caller-selected reports.
    if ! RunSourceCommand "$OUT_DIR/owned-artifact-sha256.stdout" sha256sum \
        "$SITE_BACKUP_PACKAGE" "$OUT_FILE" "$OUT_DIR/package-manifest.json" "$RESTORE_MANIFEST_FILE" \
        "$OUT_DIR/owned-drill.stdout" "$OUT_DIR/owned-drill.stderr" \
        "$OUT_DIR/native-restored-source.json" "$OUT_DIR/backup-restore-drill-${RUN_ID}.source-stderr.log" </dev/null; then
        AddBlocker "owned-drill-artifact-final-read-failed"
        return 1
    fi
    local -a digests
    mapfile -t digests <"$OUT_DIR/owned-artifact-sha256.stdout"
    if [[ "${#digests[@]}" != "8" ]]; then return 1; fi
    local packageDigest="${digests[0]%% *}" reportDigest="${digests[1]%% *}" manifestDigest="${digests[2]%% *}"
    if ! jq -e --arg nonce "$RUN_ID" --arg packageDigest "$packageDigest" --arg manifestDigest "$manifestDigest" \
        '.status == "ok" and .mode == "migration-recoverability" and .scope == "pre-migration-backup"
         and .baseUrl == null and .runId == $nonce and .sourceCleanupVerified == true
         and .packageSha256 == $packageDigest and .manifestSha256 == $manifestDigest
         and .restoredDatabaseDumpSha256 == .sourceBinding.capture.DatabaseDumpSha256
         and (["site-backup-package:authenticated-unpacked", "database-restored-source:verified", "postgres-restore:ok",
               "uploads-recoverable:verified", "dataProtectionKeyRing-recoverable:verified", "configRedacted-recoverable:verified",
               "aotCache-recoverable:verified", "searchIndex-recoverable:verified", "owned-postgres-container-removed:verified",
               "owned-pre-migration-resources-terminal:verified"] - .checks | length) == 0' "$OUT_FILE" >/dev/null; then
        AddBlocker "owned-drill-actual-recoverability-proof-invalid"
        return 1
    fi
    SourceRemaining >/dev/null || return 1
    jq -n --arg invocation "$RUN_ID" --arg privateRoot "$OUT_DIR" --arg packageSha256 "$packageDigest" \
        --arg manifestSha256 "$manifestDigest" --arg reportSha256 "$reportDigest" \
        --arg drillManifestSha256 "${digests[3]%% *}" \
        --arg stdoutSha256 "${digests[4]%% *}" --arg stderrSha256 "${digests[5]%% *}" \
        --arg nativeRestoredSourceSha256 "${digests[6]%% *}" --slurpfile report "$OUT_FILE" \
        --arg nativeStderrSha256 "${digests[7]%% *}" --arg runId "$RUN_ID" \
        --slurpfile manifest "$OUT_DIR/package-manifest.json" \
        '{version:2, owner:"tools/operations/backup-restore-drill.sh", ownerVersion:"2", operation:"migration-evidence",
          invocation:$invocation, privateRoot:$privateRoot, producerExitCode:0,
          packageSha256:$packageSha256, manifestSha256:$manifestSha256,
          reportReference:($privateRoot + "/backup-restore-drill.json"), reportSha256:$reportSha256,
          manifestReference:($privateRoot + "/package-manifest.json"), manifest:$manifest[0],
          drillManifestReference:($privateRoot + "/backup-restore-manifest.json"), drillManifestSha256:$drillManifestSha256,
          residueReference:null, residueSha256:null,
          stdoutReference:($privateRoot + "/owned-drill.stdout"), stdoutSha256:$stdoutSha256,
          stderrReference:($privateRoot + "/owned-drill.stderr"), stderrSha256:$stderrSha256,
          nativeRestoredSourceReference:($privateRoot + "/native-restored-source.json"), nativeRestoredSourceSha256:$nativeRestoredSourceSha256,
          backendLogReference:null, backendLogSha256:null,
          nativeStderrReference:($privateRoot + "/backup-restore-drill-" + $runId + ".source-stderr.log"), nativeStderrSha256:$nativeStderrSha256,
          backendListenerStartReference:null, backendListenerStartSha256:null,
          backendListenerEndReference:null, backendListenerEndSha256:null,
          sourceBinding:$report[0].sourceBinding, restoredSource:$report[0].restoredSource,
          restoredDatabaseDumpSha256:$report[0].restoredDatabaseDumpSha256}'
}

Main() {
    if (("${#blockers[@]}" != 0)); then
        printf '%s\n' "${blockers[@]}" >&2
        return 1
    fi
    if [[ "$evidenceMode" == "1" ]]; then
        RunMigrationEvidence
        return
    fi
    mkdir -p "$OUT_DIR"
    case "$MODE" in
        dry-run) RunDryRun ;;
        real) RunReal ;;
        *) AddBlocker "unsupported-mode:$MODE" ;;
    esac
    WriteReport
    [[ "$status" == "ok" || "$status" == "scheduled" ]]
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    Main "$@"
fi
