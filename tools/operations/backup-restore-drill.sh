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

log() {
    printf '[backup-restore-drill] %s\n' "$1"
}

add_check() {
    checks+=("$1:$2")
}

add_blocker() {
    status="blocked"
    blockers+=("$1")
}

cleanup() {
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

archive_is_safe() {
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

trap cleanup EXIT

json_string_array() {
    if (("$#" == 0)); then
        printf '[]'
        return
    fi

    printf '%s\n' "$@" | jq -R . | jq -s .
}

write_report() {
    local checks_json blockers_json generated_at rpo_seconds rto_seconds
    generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    checks_json="$(json_string_array "${checks[@]}")"
    blockers_json="$(json_string_array "${blockers[@]}")"
    rpo_seconds=null
    rto_seconds=null

    if [[ -n "$POSTGRES_BACKUP" && -e "$POSTGRES_BACKUP" ]]; then
        local backup_mtime
        backup_mtime="$(stat -c %Y "$POSTGRES_BACKUP" 2>/dev/null || true)"
        if [[ -n "$backup_mtime" ]]; then
            rpo_seconds=$(($(date -u +%s) - backup_mtime))
        fi
    fi

    if ((restore_started_at > 0 && restore_finished_at >= restore_started_at)); then
        rto_seconds=$((restore_finished_at - restore_started_at))
    fi

    jq -n \
        --arg status "$status" \
        --arg mode "$MODE" \
        --arg generatedAt "$generated_at" \
        --arg runId "$RUN_ID" \
        --arg workDir "$WORK_DIR" \
        --arg baseUrl "$BASE_URL" \
        --argjson checks "$checks_json" \
        --argjson blockers "$blockers_json" \
        --argjson rpoSeconds "$rpo_seconds" \
        --argjson rtoSeconds "$rto_seconds" \
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

    log "wrote $OUT_FILE"
}

write_restore_manifest() {
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

    add_check "restore-manifest" "written"
}

append_residue_result() {
    local file="$1"
    local category="$2"
    local severity="$3"
    local status_value="$4"
    local hits="$5"
    local sample="$6"

    local tmp
    tmp="${file}.tmp"
    jq \
        --arg category "$category" \
        --arg severity "$severity" \
        --arg status "$status_value" \
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

scan_path_for_residue() {
    local report="$1"
    local category="$2"
    local severity="$3"
    local path="$4"
    shift 4
    local pattern="$*"

    if [[ ! -e "$path" ]]; then
        append_residue_result "$report" "$category" "$severity" "skipped" 0 "path-missing:$path"
        return 0
    fi

    local matches hit_count sample
    matches="$(grep -RInaE "$pattern" "$path" 2>/dev/null || true)"
    if [[ -z "$matches" ]]; then
        append_residue_result "$report" "$category" "$severity" "ok" 0 ""
        return 0
    fi

    hit_count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
    sample="$(printf '%s\n' "$matches" | head -1)"
    append_residue_result "$report" "$category" "$severity" "blocked" "$hit_count" "$sample"
    if [[ "$severity" == "P0" ]]; then
        return 1
    fi
    return 0
}

scan_postgres_for_residue() {
    local report="$1"
    if ! docker ps --format '{{.Names}}' | grep -Fx "$postgres_container" >/dev/null 2>&1; then
        append_residue_result "$report" "postgres" "P0" "skipped" 0 "postgres-container-not-running"
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
        append_residue_result "$report" "postgres" "P0" "ok" 0 ""
        return 0
    fi

    hits="$(printf '%s\n' "$result" | wc -l | tr -d ' ')"
    append_residue_result "$report" "postgres" "P0" "blocked" "$hits" "$(printf '%s\n' "$result" | head -1)"
    return 1
}

scan_redis_for_residue() {
    local report="$1"
    if ! docker ps --format '{{.Names}}' | grep -Fx "$redis_container" >/dev/null 2>&1; then
        append_residue_result "$report" "redis" "P0" "skipped" 0 "redis-container-not-running"
        return 0
    fi

    local keys hits
    keys="$(docker exec "$redis_container" redis-cli --scan 2>/dev/null | grep -E '(^|:)(user|username|email|password|role|session:user|auth:user)(:|$)' || true)"
    if [[ -z "$keys" ]]; then
        append_residue_result "$report" "redis" "P0" "ok" 0 ""
        return 0
    fi

    hits="$(printf '%s\n' "$keys" | wc -l | tr -d ' ')"
    append_residue_result "$report" "redis" "P0" "blocked" "$hits" "$(printf '%s\n' "$keys" | head -1)"
    return 1
}

finalize_residue_report() {
    local report="$1"
    local tmp
    tmp="${report}.tmp"
    jq '(.summary.totalChecks = (.checks | length))
      | (.summary.blockers = ([.checks[] | select(.status == "blocked" and .severity == "P0")] | length))
      | (.summary.warnings = ([.checks[] | select(.status == "blocked" and .severity != "P0")] | length))
      | (.status = if .summary.blockers > 0 then "blocked" else "ok" end)' "$report" >"$tmp"
    mv "$tmp" "$report"
}

run_anonymous_residue_gate() {
    local report="$RESIDUE_REPORT_FILE"
    jq -n \
        --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg runId "$RUN_ID" \
        --arg mode "$MODE" \
        '{status:"ok", generatedAt:$generatedAt, runId:$runId, mode:$mode, checks:[], summary:{totalChecks:0, blockers:0, warnings:0}}' >"$report"

    if [[ "$MODE" == "dry-run" ]]; then
        append_residue_result "$report" "postgres" "P0" "planned" 0 "retired sys_visit_log/sys_user.lastloginip/legacy user fields"
        append_residue_result "$report" "redis" "P0" "planned" 0 "legacy user/session/cache key prefixes"
        append_residue_result "$report" "search" "P0" "planned" 0 "public search documents must not expose userId/username/email/ip"
        append_residue_result "$report" "aot-static" "P0" "planned" 0 "AOT/static artifacts must not expose legacy account fields"
        append_residue_result "$report" "uploads-manifest" "P1" "planned" 0 "uploads manifests must not use legacy user directories"
        finalize_residue_report "$report"
        add_check "anonymous-residue-gate" "planned"
        return 0
    fi

    local blocked=0
    scan_postgres_for_residue "$report" || blocked=1
    scan_redis_for_residue "$report" || blocked=1
    scan_path_for_residue "$report" "search" "P0" "$WORK_DIR/webroot/search" '\b(userId|username|userName|email|ip|replyToUserId)\b' || blocked=1
    scan_path_for_residue "$report" "aot-static" "P0" "$WORK_DIR/webroot/aot-cache" '\b(userId|username|userName|email|ip|replyToUserId)\b' || blocked=1
    scan_path_for_residue "$report" "uploads-manifest" "P1" "$WORK_DIR/webroot/uploads" '(^|/)(user|username|email|legacy-user)[-_]?[0-9A-Za-z]*' || true
    (
        cd "$ROOT_DIR"
        FSUSBLOG_HISTORICAL_RESIDUE_ROOT="$ROOT_DIR" bash tools/check-historical-residue.sh >/dev/null
    ) || blocked=1
    append_residue_result "$report" "repository-static-residue" "P0" "$([[ "$blocked" == "0" ]] && printf ok || printf blocked)" "$blocked" "tools/check-historical-residue.sh"
    finalize_residue_report "$report"

    if [[ "$blocked" != "0" ]]; then
        add_blocker "anonymous-residue-gate-blocked:$report"
        return 1
    fi

    add_check "anonymous-residue-gate" "ok"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || add_blocker "command-missing:$1"
}

require_backup() {
    local value="$1"
    local label="$2"
    if [[ -z "$value" || ! -r "$value" ]]; then
        add_blocker "${label}-backup-missing"
        return
    fi

    add_check "${label}-backup" "present"
}

copy_tree() {
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
            add_blocker "unsupported-file-backup:${source##*/}"
            ;;
    esac
}

normalize_restored_child_dir() {
    local parent="$1"
    local child="$2"
    local target="$parent/$child"
    local nested="$target/$child"

    if [[ -d "$nested" ]]; then
        (cd "$nested" && tar -cf - .) | (cd "$target" && tar -xf -)
        rm -rf "$nested"
    fi
}

wait_for_postgres() {
    for ((i = 0; i < 60; i += 1)); do
        if docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

wait_for_redis() {
    for ((i = 0; i < 60; i += 1)); do
        if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

container_ip() {
    docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}

restore_postgres() {
    docker run -d \
        --name "$postgres_container" \
        -e POSTGRES_USER=fsusblog \
        -e POSTGRES_PASSWORD=fsusblog_dev \
        -e POSTGRES_DB=fsusblog \
        postgres:16-alpine >/dev/null

    wait_for_postgres || {
        add_blocker "postgres-restore-container-not-ready"
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

    add_check "postgres-restore" "ok"
}

restore_redis() {
    local redis_data="$WORK_DIR/redis-data"
    mkdir -p "$redis_data"

    if [[ -d "$REDIS_BACKUP" ]]; then
        copy_tree "$REDIS_BACKUP" "$redis_data"
    else
        cp "$REDIS_BACKUP" "$redis_data/dump.rdb"
    fi

    chmod -R a+rwX "$redis_data"
    docker run -d \
        --name "$redis_container" \
        -v "$redis_data:/data" \
        redis:7-alpine redis-server --save "" --appendonly no >/dev/null

    wait_for_redis || {
        add_blocker "redis-restore-container-not-ready"
        return
    }

    add_check "redis-restore" "ok"
}

restore_webroot_artifacts() {
    local source_webroot="${FSUSBLOG_WEB_ROOT:-$ROOT_DIR/src/backend/wwwroot}"
    local restored_webroot="$WORK_DIR/webroot"

    if [[ ! -d "$source_webroot" ]]; then
        add_blocker "source-webroot-missing"
        return
    fi

    mkdir -p "$restored_webroot"
    (cd "$source_webroot" && tar -cf - .) | (cd "$restored_webroot" && tar -xf -)
    rm -rf "$restored_webroot/uploads" "$restored_webroot/aot-cache" "$restored_webroot/search"

    copy_tree "$UPLOADS_BACKUP" "$restored_webroot/uploads"
    copy_tree "$AOT_BACKUP" "$restored_webroot/aot-cache"
    copy_tree "$SEARCH_BACKUP" "$restored_webroot/search"

    normalize_restored_child_dir "$restored_webroot" "uploads"
    normalize_restored_child_dir "$restored_webroot" "aot-cache"
    normalize_restored_child_dir "$restored_webroot" "search"

    [[ -d "$restored_webroot/uploads" ]] || add_blocker "uploads-restore-missing"
    [[ -d "$restored_webroot/aot-cache" ]] || add_blocker "aot-restore-missing"
    [[ -f "$restored_webroot/search/index.manifest.aeds" ]] || add_blocker "search-manifest-restore-missing"
    add_check "webroot-artifact-restore" "ok"
}

prepare_site_backup_package() {
    if [[ -z "$SITE_BACKUP_PACKAGE" ]]; then
        return
    fi

    if [[ ! -r "$SITE_BACKUP_PACKAGE" ]]; then
        add_blocker "site-backup-package-missing"
        return
    fi

    local package_dir="$WORK_DIR/site-package"
    local decrypted_package="$WORK_DIR/site-package.plaintext.tar.gz"
    mkdir -p "$package_dir"
    if [[ -z "$BACKUP_IDENTITY_FILE" || ! -r "$BACKUP_IDENTITY_FILE" ]]; then
        add_blocker "site-backup-identity-missing"
        return
    fi
    local decrypt_args=(
        decrypt
        --input "$SITE_BACKUP_PACKAGE"
        --output "$decrypted_package"
        --identity "$BACKUP_IDENTITY_FILE"
    )
    if [[ -n "$BACKUP_IDENTITY_PASSPHRASE_FILE" ]]; then
        decrypt_args+=(--passphrase-file "$BACKUP_IDENTITY_PASSPHRASE_FILE")
    fi
    local envelope_info recipient_key_id
    if ! envelope_info="$(node "$BACKUP_ENVELOPE_TOOL" "${decrypt_args[@]}")"; then
        add_blocker "site-backup-envelope-invalid"
        return
    fi
    recipient_key_id="$(jq -r '.recipientKeyId // empty' <<<"$envelope_info")"
    if ! archive_is_safe "$decrypted_package"; then
        add_blocker "site-backup-archive-unsafe"
        rm -f "$decrypted_package"
        return
    fi
    tar --no-same-owner --no-same-permissions -xzf "$decrypted_package" -C "$package_dir"
    rm -f "$decrypted_package"

    if ! jq -e --arg recipientKeyId "$recipient_key_id" \
        '.kind == "fsusblog-site-backup"
      and .version == 2
      and .envelope.recipientKeyId == $recipientKeyId
      and .dataProtection.encryptedAtRest == true
      and .dataProtection.plaintextMasterKeyPresent == false
      and .dataProtection.encryptedKeyCount >= 2' \
        "$package_dir/manifest.json" >/dev/null; then
        add_blocker "site-backup-key-generation-manifest-invalid"
        return
    fi

    local label artifact expected_digest actual_digest
    for label in database uploads dataProtectionKeyRing configRedacted aotCache searchIndex; do
        artifact="$(jq -r --arg label "$label" '.artifacts[$label] // empty' "$package_dir/manifest.json")"
        expected_digest="$(jq -r --arg label "$label" '.artifactDigests[$label] // empty' "$package_dir/manifest.json")"
        if [[ -z "$artifact" || "$artifact" == */* || ! "$expected_digest" =~ ^[0-9a-f]{64}$ || ! -f "$package_dir/$artifact" ]]; then
            add_blocker "site-backup-artifact-invalid:$label"
            return
        fi
        actual_digest="$(sha256sum "$package_dir/$artifact" | awk '{print $1}')"
        if [[ "$actual_digest" != "$expected_digest" ]]; then
            add_blocker "site-backup-artifact-digest-mismatch:$label"
            return
        fi
    done

    local keyring_dir="$WORK_DIR/data-protection-keyring"
    mkdir -p "$keyring_dir"
    if ! archive_is_safe "$package_dir/data-protection-keyring.tar.gz"; then
        add_blocker "site-backup-keyring-archive-unsafe"
        return
    fi
    tar -xzf "$package_dir/data-protection-keyring.tar.gz" -C "$keyring_dir"
    local key_file generation_count=0
    while IFS= read -r -d '' key_file; do
        generation_count=$((generation_count + 1))
        if ! grep -q 'encryptedSecret' "$key_file" || grep -Eq '<masterKey([[:space:]>])' "$key_file"; then
            add_blocker "site-backup-key-generation-plaintext-or-invalid"
            return
        fi
    done < <(find "$keyring_dir" -maxdepth 1 -type f -name 'key-*.xml' -print0)
    if [[ "$generation_count" != "$(jq -r '.dataProtection.encryptedKeyCount' "$package_dir/manifest.json")" ]]; then
        add_blocker "site-backup-key-generation-count-mismatch"
        return
    fi

    DATA_PROTECTION_KEYRING_BACKUP="$package_dir/data-protection-keyring.tar.gz"
    POSTGRES_BACKUP="${POSTGRES_BACKUP:-$package_dir/database.dump}"
    if [[ -z "$REDIS_BACKUP" ]]; then
        mkdir -p "$package_dir/redis-empty"
        REDIS_BACKUP="$package_dir/redis-empty"
    fi
    UPLOADS_BACKUP="${UPLOADS_BACKUP:-$package_dir/uploads.tar.gz}"
    AOT_BACKUP="${AOT_BACKUP:-$package_dir/aot-cache.tar.gz}"
    SEARCH_BACKUP="${SEARCH_BACKUP:-$package_dir/search.tar.gz}"
    add_check "site-backup-package" "authenticated-unpacked"
    add_check "data-protection-current-previous-generations" "$generation_count"
}

wait_for_url() {
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

    add_blocker "${label}-not-ready"
    return 1
}

start_restored_backend() {
    local pg_ip redis_ip
    pg_ip="$(container_ip "$postgres_container")"
    redis_ip="$(container_ip "$redis_container")"
    [[ -n "$pg_ip" ]] || add_blocker "postgres-container-ip-missing"
    [[ -n "$redis_ip" ]] || add_blocker "redis-container-ip-missing"
    ((${#blockers[@]} == 0)) || return

    (
        cd "$ROOT_DIR"
        env \
            ASPNETCORE_ENVIRONMENT=Development \
            ASPNETCORE_URLS="$BASE_URL" \
            ASPNETCORE_WEBROOT="$WORK_DIR/webroot" \
            ConnectionStrings__DefaultConnection="Host=${pg_ip};Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Pooling=false" \
            ConnectionStrings__Redis="${redis_ip}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__Configuration="${redis_ip}:6379,abortConnect=false,connectTimeout=5000" \
            RedisOptions__InstanceName="FsusBlog_Drill_${RUN_ID}_" \
            Seo__BaseUrl="$BASE_URL" \
            CORS_ALLOWED_HOSTS="$BASE_URL" \
            ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile
    ) >"$WORK_DIR/backend.log" 2>&1 &
    backend_pid="$!"

    wait_for_url "restored-backend-live" "$BASE_URL/health/live" || return
    wait_for_url "restored-backend-pow" "$BASE_URL/api/binary/auth/pow-challenge" "Accept: application/octet-stream" || return
    add_check "restored-backend-start" "ok"
}

run_smoke_checks() {
    wait_for_url "public-page" "$BASE_URL/" || return
    add_check "public-page" "ok"

    wait_for_url "binary-api" "$BASE_URL/api/binary/article/list/home/1/5.aeds" "Accept: application/octet-stream" || return
    add_check "binary-api" "ok"

    wait_for_url "search-index" "$BASE_URL/search/index.manifest.aeds" || return
    add_check "search-index" "ok"

    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$BASE_URL" npm --prefix src/frontend run check:notification-stream-live >/dev/null
    )
    add_check "notification-stream-live" "ok"

    (
        cd "$ROOT_DIR"
        FSUSBLOG_BASE_URL="$BASE_URL" \
            FSUSBLOG_PG_CONTAINER="$postgres_container" \
            npm --prefix src/frontend run prepare:binary-smoke:auth-users >/dev/null

        FSUSBLOG_BASE_URL="$BASE_URL" \
            node --input-type=module -e "import { loginWithPow } from './tests/frontend/support/auth-helpers.mjs'; await loginWithPow(process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin', process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!', false, 'backup-restore-drill');"
    )
    add_check "admin-login" "ok"
}

run_dry_run() {
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
    write_restore_manifest
    run_anonymous_residue_gate
}

run_real() {
    require_command docker
    require_command dotnet
    require_command curl
    require_command jq
    require_command npm
    require_command node
    require_command sha256sum
    prepare_site_backup_package
    require_backup "$POSTGRES_BACKUP" "postgres"
    require_backup "$REDIS_BACKUP" "redis"
    require_backup "$UPLOADS_BACKUP" "uploads"
    require_backup "$AOT_BACKUP" "aot"
    require_backup "$SEARCH_BACKUP" "search"

    if ((${#blockers[@]} > 0)); then
        return
    fi

    mkdir -p "$WORK_DIR"
    write_restore_manifest
    restore_started_at="$(date -u +%s)"
    restore_postgres
    restore_redis
    restore_webroot_artifacts

    if ((${#blockers[@]} == 0 && RESTORE_STACK == 1)); then
        start_restored_backend
        run_smoke_checks
    elif [[ "$RESTORE_STACK" != "1" ]]; then
        add_blocker "runtime-smoke-disabled"
    fi

    run_anonymous_residue_gate || true
    restore_finished_at="$(date -u +%s)"
}

case "$MODE" in
    dry-run)
        run_dry_run
        ;;
    real)
        run_real
        ;;
    *)
        add_blocker "unsupported-mode:$MODE"
        ;;
esac

write_report
[[ "$status" == "ok" || "$status" == "scheduled" ]]
