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
DATA_PROTECTION_KEYRING_BACKUP=""

status="ok"
blockers=()
checks=()
backend_pid=""
postgres_container="fsusblog-restore-postgres-${RUN_ID//[^a-zA-Z0-9]/-}"
redis_container="fsusblog-restore-redis-${RUN_ID//[^a-zA-Z0-9]/-}"
restore_started_at=0
restore_finished_at=0

mkdir -p "$OUT_DIR"

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
    rm -f "$WORK_DIR/site-package.plaintext.tar.gz"
    if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" >/dev/null 2>&1; then
        kill "$backend_pid" >/dev/null 2>&1 || true
        wait "$backend_pid" >/dev/null 2>&1 || true
    fi

    if [[ "$KEEP_WORK" != "1" && "$MODE" != "dry-run" ]]; then
        docker rm -f "$postgres_container" "$redis_container" >/dev/null 2>&1 || true
        rm -rf "$WORK_DIR"
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

JsonStringArray() {
    if (("$#" == 0)); then
        printf '[]'
        return
    fi

    printf '%s\n' "$@" | jq -R . | jq -s .
}

WriteReport() {
    local checksJson blockersJson generatedAt rpoSeconds rtoSeconds
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
        --arg mode "$MODE" \
        --arg generatedAt "$generatedAt" \
        --arg runId "$RUN_ID" \
        --arg workDir "$WORK_DIR" \
        --arg baseUrl "$BASE_URL" \
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
      baseUrl: $baseUrl,
      checks: $checks,
      timings: {
        rpoSeconds: $rpoSeconds,
        rtoSeconds: $rtoSeconds
      },
      blockers: $blockers
    }' >"$OUT_FILE"

    Log "wrote $OUT_FILE"
}

WriteRestoreManifest() {
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
        if docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
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
    docker run -d \
        --name "$postgres_container" \
        -e POSTGRES_USER=fsusblog \
        -e POSTGRES_PASSWORD=fsusblog_dev \
        -e POSTGRES_DB=fsusblog \
        postgres:16-alpine >/dev/null

    WaitForPostgres || {
        AddBlocker "postgres-restore-container-not-ready"
        return
    }

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

    AddCheck "postgres-restore" "ok"
}

RestoreRedis() {
    local redisData="$WORK_DIR/redis-data"
    mkdir -p "$redisData"

    if [[ -d "$REDIS_BACKUP" ]]; then
        CopyTree "$REDIS_BACKUP" "$redisData"
    else
        cp "$REDIS_BACKUP" "$redisData/dump.rdb"
    fi

    chmod -R a+rwX "$redisData"
    docker run -d \
        --name "$redis_container" \
        -v "$redisData:/data" \
        redis:7-alpine redis-server --save "" --appendonly no >/dev/null

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
    if ! envelopeInfo="$(node "$BACKUP_ENVELOPE_TOOL" "${decryptArgs[@]}")"; then
        AddBlocker "site-backup-envelope-invalid"
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

    if ! jq -e --arg recipientKeyId "$recipientKeyId" \
        '.kind == "fsusblog-site-backup"
      and .version == 2
      and .envelope.recipientKeyId == $recipientKeyId
      and .dataProtection.encryptedAtRest == true
      and .dataProtection.plaintextMasterKeyPresent == false
      and .dataProtection.encryptedKeyCount >= 2' \
        "$packageDir/manifest.json" >/dev/null; then
        AddBlocker "site-backup-key-generation-manifest-invalid"
        return
    fi

    local label artifact expectedDigest actualDigest
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        artifact="$(jq -r --arg label "$label" '.artifacts[$label] // empty' "$packageDir/manifest.json")"
        expectedDigest="$(jq -r --arg label "$label" '.artifactDigests[$label] // empty' "$packageDir/manifest.json")"
        if [[ -z "$artifact" || "$artifact" == */* || ! "$expectedDigest" =~ ^[0-9a-f]{64}$ || ! -f "$packageDir/$artifact" ]]; then
            AddBlocker "site-backup-artifact-invalid:$label"
            return
        fi
        actualDigest="$(sha256sum "$packageDir/$artifact" | awk '{print $1}')"
        if [[ "$actualDigest" != "$expectedDigest" ]]; then
            AddBlocker "site-backup-artifact-digest-mismatch:$label"
            return
        fi
    done

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

    DATA_PROTECTION_KEYRING_BACKUP="$packageDir/data-protection-keyring.tar.gz"
    POSTGRES_BACKUP="${POSTGRES_BACKUP:-$packageDir/database.dump}"
    if [[ -z "$REDIS_BACKUP" ]]; then
        mkdir -p "$packageDir/redis-empty"
        REDIS_BACKUP="$packageDir/redis-empty"
    fi
    UPLOADS_BACKUP="${UPLOADS_BACKUP:-$packageDir/uploads.tar.gz}"
    AOT_BACKUP="${AOT_BACKUP:-$packageDir/aot-cache.tar.gz}"
    SEARCH_BACKUP="${SEARCH_BACKUP:-$packageDir/search.tar.gz}"
    AddCheck "site-backup-package" "authenticated-unpacked"
    AddCheck "data-protection-current-previous-generations" "$generationCount"
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

StartRestoredBackend() {
    local pgIp redisIp
    pgIp="$(ContainerIp "$postgres_container")"
    redisIp="$(ContainerIp "$redis_container")"
    [[ -n "$pgIp" ]] || AddBlocker "postgres-container-ip-missing"
    [[ -n "$redisIp" ]] || AddBlocker "redis-container-ip-missing"
    ((${#blockers[@]} == 0)) || return

    (
        cd "$ROOT_DIR"
        env \
            ASPNETCORE_ENVIRONMENT=Development \
            ASPNETCORE_URLS="$BASE_URL" \
            ASPNETCORE_WEBROOT="$WORK_DIR/webroot" \
            ConnectionStrings__DefaultConnection="Host=${pgIp};Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Pooling=false" \
            ConnectionStrings__Redis="${redisIp}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__Configuration="${redisIp}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__InstanceName="FsusBlog_Drill_${RUN_ID}_" \
            Seo__BaseUrl="$BASE_URL" \
            CORS_ALLOWED_HOSTS="$BASE_URL" \
            ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile
    ) >"$WORK_DIR/backend.log" 2>&1 &
    backend_pid="$!"

    WaitForUrl "restored-backend-live" "$BASE_URL/health/live" || return
    WaitForUrl "restored-backend-pow" "$BASE_URL/api/binary/auth/pow-challenge" "Accept: application/octet-stream" || return
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
            npm --prefix src/frontend run prepare:binary-smoke:auth-users >/dev/null

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
    PrepareSiteBackupPackage
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

case "$MODE" in
    dry-run)
        RunDryRun
        ;;
    real)
        RunReal
        ;;
    *)
        AddBlocker "unsupported-mode:$MODE"
        ;;
esac

WriteReport
[[ "$status" == "ok" || "$status" == "scheduled" ]]
