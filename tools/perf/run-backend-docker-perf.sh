#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${FSUSBLOG_PERF_OUT_DIR:-$ROOT_DIR/.tmp/perf/$TIMESTAMP}"
DIAG_DIR="$OUT_DIR/diag"
CONTAINER_NAME="${FSUSBLOG_PERF_CONTAINER_NAME:-fsusblog-perf}"
IMAGE_TAG="${FSUSBLOG_PERF_IMAGE_TAG:-fsusblog-perf:$TIMESTAMP}"
HOST_PORT="${FSUSBLOG_PERF_PORT:-18080}"
BASE_URL="${FSUSBLOG_PERF_BASE_URL:-http://127.0.0.1:$HOST_PORT}"
TEST_SESSION_ID="${FSUSBLOG_TEST_SESSION_ID:-perf-$TIMESTAMP}"
ASPNETCORE_ENVIRONMENT_NAME="${FSUSBLOG_PERF_ASPNETCORE_ENVIRONMENT:-Staging}"
CONTAINER_USER="${FSUSBLOG_PERF_CONTAINER_USER:-$(id -u):$(id -g)}"
PERF_USER_AGENT="${FSUSBLOG_PERF_USER_AGENT:-Mozilla/5.0 (FsusBlog Perf Runner)}"
USE_TEST_SESSION_FOR_READS="${FSUSBLOG_PERF_USE_TEST_SESSION_FOR_READS:-0}"
READYTORUN_MODE="${FSUSBLOG_PERF_READYTORUN:-1}"
WRK_DURATION="${FSUSBLOG_PERF_WRK_DURATION:-10s}"
WRK_THREADS="${FSUSBLOG_PERF_WRK_THREADS:-4}"
WRK_CONNECTIONS="${FSUSBLOG_PERF_WRK_CONNECTIONS:-64}"
COUNTERS_SECONDS="${FSUSBLOG_PERF_COUNTERS_SECONDS:-90}"
TRACE_SECONDS="${FSUSBLOG_PERF_TRACE_SECONDS:-60}"
COUNTERS_DURATION=""
TRACE_DURATION=""
RUN_BUILD="${FSUSBLOG_PERF_SKIP_BUILD:-0}"
RUN_CLEANUP="${FSUSBLOG_PERF_KEEP_CONTAINER:-0}"
GH_TOKEN=""
COUNTERS_PID=""
TRACE_PID=""
DIAGNOSTIC_SOCKET=""

log() {
    printf '[perf] %s\n' "$1"
}

fail() {
    printf '[perf] error: %s\n' "$1" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

format_seconds_duration() {
    local seconds="$1"
    if ! [[ "$seconds" =~ ^[0-9]+$ ]] || ((seconds <= 0)); then
        fail "duration must be a positive integer number of seconds: $seconds"
    fi

    local hours=$((seconds / 3600))
    local minutes=$(((seconds % 3600) / 60))
    local remaining_seconds=$((seconds % 60))
    printf '00:%02d:%02d:%02d' "$hours" "$minutes" "$remaining_seconds"
}

COUNTERS_DURATION="$(format_seconds_duration "$COUNTERS_SECONDS")"
TRACE_DURATION="$(format_seconds_duration "$TRACE_SECONDS")"

read_secret_token() {
    if [[ -n "${GITHUB_PACKAGES_TOKEN:-}" ]]; then
        GH_TOKEN="$GITHUB_PACKAGES_TOKEN"
        return
    fi

    GH_TOKEN="$(gh auth token)"
    if [[ -z "$GH_TOKEN" ]]; then
        fail "gh auth token returned an empty token"
    fi
}

cleanup_container() {
    if [[ "$RUN_CLEANUP" == "1" ]]; then
        return
    fi

    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

remove_existing_container() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

cleanup_background_tools() {
    if [[ -n "$COUNTERS_PID" ]]; then
        kill "$COUNTERS_PID" >/dev/null 2>&1 || true
    fi

    if [[ -n "$TRACE_PID" ]]; then
        kill "$TRACE_PID" >/dev/null 2>&1 || true
    fi
}

on_exit() {
    local status=$?
    cleanup_background_tools
    cleanup_container
    if [[ $status -ne 0 ]]; then
        docker logs "$CONTAINER_NAME" >"$OUT_DIR/container-final.log" 2>&1 || true
        log "failed; artifacts preserved in $OUT_DIR"
    fi
}

wait_for_url() {
    local label="$1"
    local url="$2"
    local attempts="${3:-90}"

    for ((i = 0; i < attempts; i += 1)); do
        if curl -fsS --max-time 3 -A "$PERF_USER_AGENT" "$url" >/dev/null 2>&1; then
            log "$label ready: $url"
            return 0
        fi
        sleep 1
    done

    fail "$label did not become ready: $url"
}

wait_for_binary_url() {
    local label="$1"
    local url="$2"
    local attempts="${3:-90}"

    for ((i = 0; i < attempts; i += 1)); do
        if curl -fsS --max-time 3 -A "$PERF_USER_AGENT" -H 'Accept: application/octet-stream' "$url" >/dev/null 2>&1; then
            log "$label ready: $url"
            return 0
        fi
        sleep 1
    done

    fail "$label did not become ready: $url"
}

build_image() {
    if [[ "$RUN_BUILD" == "1" ]]; then
        log "skip Docker image build by FSUSBLOG_PERF_SKIP_BUILD=1"
        return
    fi

    read_secret_token
    log "building Docker final image through repo release path: $IMAGE_TAG"
    GITHUB_PACKAGES_TOKEN="$GH_TOKEN" \
        FSUSBLOG_FINAL_LOCAL_ONLY=1 \
        FSUSBLOG_FINAL_IMAGE_TAG="$IMAGE_TAG" \
        FSUSBLOG_FINAL_IMAGE_TARGET=final \
        "$ROOT_DIR/tools/build-final-image.sh" \
        >"$OUT_DIR/docker-build.log" 2>&1
}

start_diagnostics() {
    if [[ -z "$DIAGNOSTIC_SOCKET" ]]; then
        fail "diagnostic socket was not discovered"
    fi

    local diagnostic_port="$DIAGNOSTIC_SOCKET,connect"

    log "starting dotnet-counters for ${COUNTERS_SECONDS}s"
    dotnet-counters monitor \
        --diagnostic-port "$diagnostic_port" \
        --refresh-interval 1 \
        --duration "$COUNTERS_DURATION" \
        --counters System.Runtime,Microsoft.AspNetCore.Hosting,Microsoft.AspNetCore.Server.Kestrel,FsusBlog.Server,FsusBlog.NotificationStream \
        >"$OUT_DIR/dotnet-counters.log" 2>&1 &
    COUNTERS_PID="$!"

    log "starting dotnet-trace for ${TRACE_SECONDS}s"
    dotnet-trace collect \
        --diagnostic-port "$diagnostic_port" \
        --duration "$TRACE_DURATION" \
        --profile dotnet-sampled-thread-time,dotnet-common \
        --format Speedscope \
        -o "$OUT_DIR/dotnet-trace" \
        >"$OUT_DIR/dotnet-trace.log" 2>&1 &
    TRACE_PID="$!"
}

wait_for_diagnostic_socket() {
    local attempts="${1:-30}"

    for ((i = 0; i < attempts; i += 1)); do
        local socket
        socket="$(find "$DIAG_DIR" -maxdepth 1 -type s -name 'dotnet-diagnostic-*-socket' -print -quit 2>/dev/null || true)"
        if [[ -n "$socket" ]]; then
            DIAGNOSTIC_SOCKET="$socket"
            log "diagnostic socket ready: $DIAGNOSTIC_SOCKET"
            return 0
        fi
        sleep 1
    done

    fail "diagnostic socket did not become ready in $DIAG_DIR"
}

prepare_runtime_writable_overlays() {
    mkdir -p "$DIAG_DIR/aot-cache"
    mkdir -p "$DIAG_DIR/data"
    mkdir -p "$DIAG_DIR/upload-sessions"
    rm -rf "$DIAG_DIR/search"
    mkdir -p "$DIAG_DIR/search"
    local seed_container
    seed_container="$(docker create "$IMAGE_TAG")"
    docker cp "$seed_container:/app/wwwroot/search/." "$DIAG_DIR/search/" >/dev/null 2>&1 || true
    docker rm "$seed_container" >/dev/null 2>&1 || true
    touch "$DIAG_DIR/auto-imports.d.ts" "$DIAG_DIR/components.d.ts"
    chmod 0777 "$DIAG_DIR/aot-cache"
    chmod -R u+rwX,go+rwX "$DIAG_DIR/data"
    chmod -R u+rwX,go+rwX "$DIAG_DIR/upload-sessions"
    chmod -R u+rwX,go+rwX "$DIAG_DIR/search"
    chmod 0666 "$DIAG_DIR/auto-imports.d.ts" "$DIAG_DIR/components.d.ts"
}

start_container() {
    remove_existing_container
    log "starting container $CONTAINER_NAME on $BASE_URL"
    prepare_runtime_writable_overlays
    local test_session_env_args=()
    if [[ "$USE_TEST_SESSION_FOR_READS" == "1" ]]; then
        test_session_env_args=(-e FSUSBLOG_TEST_SESSION_ISOLATION=1)
    fi

    docker run -d \
        --name "$CONTAINER_NAME" \
        --user "$CONTAINER_USER" \
        --add-host=host.docker.internal:host-gateway \
        -p "127.0.0.1:$HOST_PORT:8080" \
        -v "$DIAG_DIR:/diag" \
        -v "$DIAG_DIR/aot-cache:/app/wwwroot/aot-cache" \
        -v "$DIAG_DIR/data:/diag/data" \
        -v "$DIAG_DIR/upload-sessions:/app/.upload-sessions" \
        -v "$DIAG_DIR/search:/app/wwwroot/search" \
        -v "$DIAG_DIR/auto-imports.d.ts:/app/FsusBlog.ClientRuntime/auto-imports.d.ts" \
        -v "$DIAG_DIR/components.d.ts:/app/FsusBlog.ClientRuntime/components.d.ts" \
        --tmpfs /app/FsusBlog.ClientRuntime/node_modules/.vite:rw,nosuid,nodev,mode=1777 \
        --tmpfs /app/FsusBlog.ClientRuntime/node_modules/.vite-temp:rw,nosuid,nodev,mode=1777 \
        -e ASPNETCORE_ENVIRONMENT="$ASPNETCORE_ENVIRONMENT_NAME" \
        -e ASPNETCORE_URLS=http://0.0.0.0:8080 \
        -e COMPlus_ReadyToRun="$READYTORUN_MODE" \
        -e HOME=/diag \
        -e TMPDIR=/diag \
        -e FSUSBLOG_DATA_ROOT=/diag/data \
        "${test_session_env_args[@]}" \
        -e ConnectionStrings__DefaultConnection="${FSUSBLOG_PERF_POSTGRES:-Host=host.docker.internal;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Pooling=true;Minimum Pool Size=5;Maximum Pool Size=100;No Reset On Close=true}" \
        -e ConnectionStrings__Redis="${FSUSBLOG_PERF_REDIS:-host.docker.internal:6379,abortConnect=false,connectTimeout=5000}" \
        -e RedisOptions__Configuration="${FSUSBLOG_PERF_REDIS:-host.docker.internal:6379,abortConnect=false,connectTimeout=5000}" \
        -e RedisOptions__InstanceName=FsusBlog_Perf_ \
        -e Jwt__KeyVersion="${FSUSBLOG_PERF_JWT_KEY_VERSION:-perf-v1}" \
        -e Jwt__SecretKey="${FSUSBLOG_PERF_JWT_SECRET:-Local_Perf_Key_For_FsusBlog_2026_With_Enough_Length_Only}" \
        -e Jwt__RotationWindowDays="${FSUSBLOG_PERF_JWT_ROTATION_WINDOW_DAYS:-30}" \
        -e AuthCookies__AllowInsecureTransportCookies=true \
        -e CORS_ALLOWED_HOSTS="$BASE_URL,http://localhost:$HOST_PORT" \
        -e AllowedHosts="${FSUSBLOG_PERF_ALLOWED_HOSTS:-*}" \
        -e Seo__BaseUrl="$BASE_URL" \
        -e Fido2__ServerDomain=localhost \
        -e Fido2__Origins__0="$BASE_URL" \
        -e Fido2__Origins__1="http://localhost:$HOST_PORT" \
        "$IMAGE_TAG" \
        >"$OUT_DIR/container.id"

    docker logs -f "$CONTAINER_NAME" >"$OUT_DIR/container.log" 2>&1 &
}

run_wrk() {
    local name="$1"
    local url="$2"
    local accept="$3"
    local output="$OUT_DIR/wrk-$name.log"

    log "wrk $name: $url"
    wrk \
        -t"$WRK_THREADS" \
        -c"$WRK_CONNECTIONS" \
        -d"$WRK_DURATION" \
        --latency \
        -H "Accept: $accept" \
        -H "User-Agent: $PERF_USER_AGENT" \
        "$url" \
        >"$output" 2>&1
}

discover_article_id() {
    FSUSBLOG_BASE_URL="$BASE_URL" FSUSBLOG_TEST_SESSION_ID="$TEST_SESSION_ID" node --input-type=module - <<'NODE'
import { readAedsResponse } from './tests/frontend/support/aeds-envelope.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL
const response = await fetch(`${baseUrl}/api/binary/article/list/home/1/1.aeds`, {
  headers: {
    Accept: 'application/octet-stream',
    'User-Agent': process.env.FSUSBLOG_PERF_USER_AGENT ?? 'Mozilla/5.0 (FsusBlog Perf Runner)'
  }
})
if (!response.ok) {
  throw new Error(`article probe failed: ${response.status}`)
}
const payload = await readAedsResponse(response)
const items = Array.isArray(payload?.items) ? payload.items : []
if (items.length === 0 || !items[0]?.id) {
  throw new Error('no article fixture available for perf run')
}
console.log(items[0].id)
NODE
}

run_load_checks() {
    local test_session_env=()
    if [[ "$USE_TEST_SESSION_FOR_READS" == "1" ]]; then
        test_session_env=(FSUSBLOG_TEST_SESSION_ID="$TEST_SESSION_ID")
    fi

    log "running existing public/api load gate"
    (
        cd "$CLIENT_DIR"
        env \
            FSUSBLOG_BASE_URL="$BASE_URL" \
            FSUSBLOG_PUBLIC_BASE_URL="$BASE_URL" \
            FSUSBLOG_HTTP_TIMEOUT_MS="${FSUSBLOG_HTTP_TIMEOUT_MS:-10000}" \
            "${test_session_env[@]}" \
            npm run check:load:public-api
    ) >"$OUT_DIR/check-load-public-api.log" 2>&1

    log "running notification stream pressure gate"
    (
        cd "$CLIENT_DIR"
        env \
            FSUSBLOG_BASE_URL="$BASE_URL" \
            FSUSBLOG_HTTP_TIMEOUT_MS="${FSUSBLOG_HTTP_TIMEOUT_MS:-10000}" \
            "${test_session_env[@]}" \
            npm run check:load:notification-stream-pressure
    ) >"$OUT_DIR/check-notification-stream-pressure.log" 2>&1
}

run_http_baseline() {
    local article_id
    article_id="$(discover_article_id)"
    printf '%s\n' "$article_id" >"$OUT_DIR/article-id.txt"

    run_wrk public-home "$BASE_URL/" "text/html"
    run_wrk search-manifest "$BASE_URL/search/index.manifest.aeds" "application/octet-stream"
    run_wrk binary-system-seo "$BASE_URL/api/binary/system/seo" "application/octet-stream"
    run_wrk binary-pow-challenge "$BASE_URL/api/binary/auth/pow-challenge" "application/octet-stream"
    run_wrk binary-article-list "$BASE_URL/api/binary/article/list/home/1/10.aeds" "application/octet-stream"
    run_wrk binary-article-detail "$BASE_URL/api/binary/article/$article_id.aeds" "application/octet-stream"
    run_wrk binary-article-hot-l0 "$BASE_URL/api/binary/article/hot/10.aeds" "application/octet-stream"
    run_wrk binary-article-featured-l0 "$BASE_URL/api/binary/article/featured/4.aeds" "application/octet-stream"
    run_wrk binary-category-l0 "$BASE_URL/api/binary/category.aeds" "application/octet-stream"
    run_wrk binary-tag-l0 "$BASE_URL/api/binary/tag.aeds" "application/octet-stream"
    run_wrk binary-comment-list "$BASE_URL/api/binary/comment/$article_id?limit=10" "application/octet-stream"
}

write_summary() {
    docker stats "$CONTAINER_NAME" --no-stream >"$OUT_DIR/docker-stats.txt" 2>&1 || true
    docker inspect "$CONTAINER_NAME" >"$OUT_DIR/docker-inspect.json" 2>&1 || true
    docker logs "$CONTAINER_NAME" >"$OUT_DIR/container-final.log" 2>&1 || true

    node --input-type=module - "$OUT_DIR" "$BASE_URL" "$TEST_SESSION_ID" "$IMAGE_TAG" "$WRK_DURATION" "$WRK_THREADS" "$WRK_CONNECTIONS" "$READYTORUN_MODE" <<'NODE'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, baseUrl, testSessionId, imageTag, wrkDuration, wrkThreads, wrkConnections, readyToRunMode] = process.argv.slice(2)
const wrk = {}
for (const file of readdirSync(outDir).filter((name) => name.startsWith('wrk-') && name.endsWith('.log')).sort()) {
  const text = readFileSync(join(outDir, file), 'utf8')
  const endpoint = file.slice(4, -4)
  wrk[endpoint] = {
    requestsPerSecond: Number(text.match(/Requests\/sec:\s+([0-9.]+)/)?.[1] ?? 0),
    transferPerSecond: text.match(/Transfer\/sec:\s+(.+)/)?.[1]?.trim() ?? null,
    p50: text.match(/\s+50%\s+([^\s]+)/)?.[1] ?? null,
    p75: text.match(/\s+75%\s+([^\s]+)/)?.[1] ?? null,
    p90: text.match(/\s+90%\s+([^\s]+)/)?.[1] ?? null,
    p99: text.match(/\s+99%\s+([^\s]+)/)?.[1] ?? null,
    p999: text.match(/\s+99\.9%\s+([^\s]+)/)?.[1] ?? null
  }
}

let notificationStreamPressure = null
try {
  const text = readFileSync(join(outDir, 'check-notification-stream-pressure.log'), 'utf8')
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith('[notification-stream-pressure] ok '))
  if (line) {
    notificationStreamPressure = JSON.parse(line.slice('[notification-stream-pressure] ok '.length))
  }
} catch {
}

let fixtureArticleId = null
try {
  const raw = readFileSync(join(outDir, 'article-id.txt'), 'utf8').trim()
  fixtureArticleId = raw.length > 0 ? Number(raw) : null
} catch {
}

function booleanEnv(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || value === '') continue
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  return null
}

const reverseProxy = process.env.FSUSBLOG_OPTIONAL_REVERSE_PROXY || process.env.FSUSBLOG_PERF_REVERSE_PROXY || 'none'

writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
  generatedAtUtc: new Date().toISOString(),
  baseUrl,
  imageTag,
  testSessionId,
  performance_baseline: {
    date: new Date().toISOString().slice(0, 10),
    mode: 'kestrel-only',
    process_count: 1,
    reverse_proxy: false,
    cdn: false,
    response_compression_proxy: false,
    native_aot: false,
    ready_to_run: readyToRunMode === '0' ? false : true,
    tiered_pgo: booleanEnv('DOTNET_TieredPGO', 'COMPlus_TieredPGO'),
    runtime: 'dotnet-10',
    database: 'postgres docker-local',
    redis: 'redis docker-local',
    machine: `${process.platform} ${process.arch}`
  },
  optional_deployment_layer: {
    reverse_proxy: reverseProxy,
    proxy_cache: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_CACHE', 'FSUSBLOG_PERF_PROXY_CACHE') ?? false,
    proxy_compression: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_COMPRESSION', 'FSUSBLOG_PERF_PROXY_COMPRESSION') ?? false,
    counted_as_project_baseline: false
  },
  readyToRun: {
    comPlusReadyToRun: readyToRunMode,
    conclusion: readyToRunMode === '0'
      ? 'ReadyToRun disabled for this run; compare with FSUSBLOG_PERF_READYTORUN=1 using the same wrk settings.'
      : 'ReadyToRun enabled for this run; compare with FSUSBLOG_PERF_READYTORUN=0 using the same wrk settings.'
  },
  wrkConfig: {
    duration: wrkDuration,
    threads: Number(wrkThreads),
    connections: Number(wrkConnections),
    latencyPercentiles: ['p50', 'p75', 'p90', 'p99', 'p999 when emitted by wrk']
  },
  fixture: {
    articleId: Number.isFinite(fixtureArticleId) ? fixtureArticleId : null,
    discoveryEndpoint: '/api/binary/article/list/home/1/1.aeds',
    emptyDatabaseBehavior: 'The run fails before wrk when the public home fixture has no article id.'
  },
  endpointGroups: {
    publicHotReadL0: [
      'binary-article-list',
      'binary-article-detail',
      'binary-article-hot-l0',
      'binary-article-featured-l0',
      'binary-category-l0',
      'binary-tag-l0'
    ],
    normalPipelineContrast: [
      'binary-system-seo',
      'binary-pow-challenge',
      'binary-comment-list',
      'public-home',
      'search-manifest'
    ],
    fullArticlePageWaterfallScope: {
      included: ['article detail L0 frame', 'hot/featured L0 frames', 'category/tag L0 frames', 'comment cursor normal pipeline'],
      excluded: ['authenticated admin article reads', 'browser asset cache timing'],
      note: 'Use wrk endpoint groups plus public hydration smoke for first-screen waterfall evidence.'
    }
  },
  wrk,
  notificationStreamPressure,
  diagnostics: {
    dotnetCountersLog: 'dotnet-counters.log',
    dotnetTraceLog: 'dotnet-trace.log',
    traceBudgetSeconds: Number(process.env.FSUSBLOG_PERF_TRACE_SECONDS || 60),
    countersBudgetSeconds: Number(process.env.FSUSBLOG_PERF_COUNTERS_SECONDS || 90)
  },
  artifacts: readdirSync(outDir).sort()
}, null, 2) + '\n')
NODE
}

main() {
    COUNTERS_DURATION="$(format_seconds_duration "$COUNTERS_SECONDS")"
    TRACE_DURATION="$(format_seconds_duration "$TRACE_SECONDS")"
    mkdir -p "$DIAG_DIR"
    chmod 0777 "$DIAG_DIR"

    require_command docker
    require_command gh
    require_command wrk
    require_command node
    require_command npm
    require_command curl
    require_command dotnet-counters
    require_command dotnet-trace

    trap on_exit EXIT

    build_image
    start_container
    wait_for_url "health live" "$BASE_URL/health/live" 120
    wait_for_url "health ready" "$BASE_URL/health/ready" 120
    wait_for_binary_url "binary seo" "$BASE_URL/api/binary/system/seo" 120
    wait_for_diagnostic_socket 30
    start_diagnostics
    run_load_checks
    run_http_baseline

    wait "$COUNTERS_PID" || true
    wait "$TRACE_PID" || true
    COUNTERS_PID=""
    TRACE_PID=""

    write_summary
    log "artifacts: $OUT_DIR"
    log "summary: $OUT_DIR/summary.json"
}

main "$@"
