#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SERVER_WWWROOT_DIR="$ROOT_DIR/src/backend/wwwroot"
FSUSBLOG_TEST_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}"
NS_SLUG="$(printf '%s' "$FSUSBLOG_TEST_NAMESPACE" | tr -c 'A-Za-z0-9_.-' '-')"
TMP_DIR="$ROOT_DIR/.tmp/acceptance/$NS_SLUG"
ENV_DIR="$ROOT_DIR/.tmp/env"
FIXTURE_DIR="$ROOT_DIR/.tmp/fixtures/$NS_SLUG"
mkdir -p "$TMP_DIR"
mkdir -p "$ENV_DIR" "$FIXTURE_DIR"

find_free_port() {
  local start="${1:-20000}"
  local end="${2:-55000}"
  local port
  for port in $(shuf -i "${start}-${end}" -n 200); do
    if ! ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q ":${port}"; then
      printf '%s\n' "$port"
      return 0
    fi
  done
  return 1
}

ENV_FILE="$ENV_DIR/$NS_SLUG.env"
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    case "$key" in
      FSUSBLOG_POSTGRES_PORT) FSUSBLOG_POSTGRES_PORT="$value" ;;
      FSUSBLOG_REDIS_PORT) FSUSBLOG_REDIS_PORT="$value" ;;
      FSUSBLOG_DEBUG_BACKEND_PORT) FSUSBLOG_DEBUG_BACKEND_PORT="$value" ;;
      FSUSBLOG_DEBUG_FRONTEND_PORT) FSUSBLOG_DEBUG_FRONTEND_PORT="$value" ;;
      FSUSBLOG_RELEASE_PREVIEW_PORT) FSUSBLOG_RELEASE_PREVIEW_PORT="$value" ;;
      FSUSBLOG_DEBUG_FRONTEND_URL) FSUSBLOG_DEBUG_FRONTEND_URL="$value" ;;
      FSUSBLOG_DEBUG_BACKEND_URL) FSUSBLOG_DEBUG_BACKEND_URL="$value" ;;
      FSUSBLOG_RELEASE_PREVIEW_URL) FSUSBLOG_RELEASE_PREVIEW_URL="$value" ;;
      FSUSBLOG_POSTGRES_CONTAINER_NAME) FSUSBLOG_POSTGRES_CONTAINER_NAME="$value" ;;
      FSUSBLOG_REDIS_CONTAINER_NAME) FSUSBLOG_REDIS_CONTAINER_NAME="$value" ;;
      FSUSBLOG_NOTIFICATION_DRILL_SECRET) FSUSBLOG_NOTIFICATION_DRILL_SECRET="$value" ;;
      FSUSBLOG_DATA_ROOT) FSUSBLOG_DATA_ROOT="$value" ;;
    esac
  done < "$ENV_FILE"
fi

POSTGRES_PORT="${FSUSBLOG_POSTGRES_PORT:-$(find_free_port 20000 30000)}"
REDIS_PORT="${FSUSBLOG_REDIS_PORT:-$(find_free_port 30001 40000)}"
DEBUG_BACKEND_PORT="${FSUSBLOG_DEBUG_BACKEND_PORT:-$(find_free_port 40001 46000)}"
DEBUG_FRONTEND_PORT="${FSUSBLOG_DEBUG_FRONTEND_PORT:-$(find_free_port 46001 51000)}"
RELEASE_PREVIEW_PORT="${FSUSBLOG_RELEASE_PREVIEW_PORT:-$(find_free_port 51001 56000)}"

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:${DEBUG_FRONTEND_PORT}}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:${DEBUG_BACKEND_PORT}}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:${RELEASE_PREVIEW_PORT}}"
CORS_ALLOWED_HOSTS_VALUE="${CORS_ALLOWED_HOSTS:-${DEBUG_FRONTEND_URL},${RELEASE_PREVIEW_URL},http://localhost:${DEBUG_FRONTEND_PORT},http://localhost:${RELEASE_PREVIEW_PORT}}"
POSTGRES_CONTAINER="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-fsusblog-postgres-$NS_SLUG}"
REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER_NAME:-fsusblog-redis-$NS_SLUG}"
TEST_DATA_ROOT="${FSUSBLOG_DATA_ROOT:-$ROOT_DIR/.tmp/data/$NS_SLUG}"
POSTGRES_CONNECTION="Host=127.0.0.1;Port=${POSTGRES_PORT};Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true"
REDIS_CONNECTION="127.0.0.1:${REDIS_PORT}"
NOTIFICATION_DRILL_SECRET="${FSUSBLOG_NOTIFICATION_DRILL_SECRET:-fsus-notification-drill-$NS_SLUG}"
FORCE_BOOTSTRAP="${FSUSBLOG_FORCE_BOOTSTRAP:-${CI:+1}}"
RESET_SECURITY_TEST_STATE="${FSUSBLOG_RESET_SECURITY_TEST_STATE:-1}"
POW_READY_MAX_DIFFICULTY="${FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY:-20}"

write_env_file() {
  cat > "$ENV_FILE" <<EOF
FSUSBLOG_TEST_NAMESPACE=$FSUSBLOG_TEST_NAMESPACE
FSUSBLOG_POSTGRES_PORT=$POSTGRES_PORT
FSUSBLOG_REDIS_PORT=$REDIS_PORT
FSUSBLOG_DEBUG_BACKEND_PORT=$DEBUG_BACKEND_PORT
FSUSBLOG_DEBUG_FRONTEND_PORT=$DEBUG_FRONTEND_PORT
FSUSBLOG_RELEASE_PREVIEW_PORT=$RELEASE_PREVIEW_PORT
FSUSBLOG_DEBUG_FRONTEND_URL=$DEBUG_FRONTEND_URL
FSUSBLOG_DEBUG_BACKEND_URL=$DEBUG_BACKEND_URL
FSUSBLOG_RELEASE_PREVIEW_URL=$RELEASE_PREVIEW_URL
FSUSBLOG_POSTGRES_CONTAINER_NAME=$POSTGRES_CONTAINER
FSUSBLOG_REDIS_CONTAINER_NAME=$REDIS_CONTAINER
FSUSBLOG_NOTIFICATION_DRILL_SECRET=$NOTIFICATION_DRILL_SECRET
FSUSBLOG_DATA_ROOT=$TEST_DATA_ROOT
ConnectionStrings__DefaultConnection=$POSTGRES_CONNECTION
ConnectionStrings__Redis=$REDIS_CONNECTION
RedisOptions__Configuration=$REDIS_CONNECTION
RedisOptions__InstanceName=FsusBlog_${NS_SLUG}_
NotificationStream__DrillSecret=$NOTIFICATION_DRILL_SECRET
ASPNETCORE_URLS=http://127.0.0.1:$DEBUG_BACKEND_PORT
ASPNETCORE_ENVIRONMENT=Development
CORS_ALLOWED_HOSTS=$CORS_ALLOWED_HOSTS_VALUE
EOF
}

write_env_file

log() {
  printf '[acceptance:bootstrap] %s\n' "$1"
}

read_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    cat "$pid_file" 2>/dev/null || true
  fi
}

kill_pid_if_running() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for ((i=0; i<20; i+=1)); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.5
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

find_port_pid() {
  local port="$1"
  ss -ltnp "( sport = :${port} )" 2>/dev/null | awk -F'pid=' 'NR>1 {split($2, a, /[,)]/); if (a[1] != "") {print a[1]; exit}}'
}

probe_url() {
  local url="$1"
  curl -fsS --max-time 5 "$url" >/dev/null 2>&1
}

probe_binary_url() {
  local url="$1"
  curl -fsS --max-time 5 -H 'Accept: application/octet-stream' "$url" >/dev/null 2>&1
}

probe_notification_drill_url() {
  curl -fsS --max-time 5 \
    -X POST \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H "X-Fsus-Notification-Drill-Secret: ${NOTIFICATION_DRILL_SECRET}" \
    --data '{"drillId":"bootstrap-probe","count":1,"payloadBytes":0,"routeKey":"content-feed"}' \
    "$DEBUG_BACKEND_URL/_fsus/testing/notification-stream/publish" >/dev/null 2>&1
}

can_reuse_processes() {
  [[ "${FORCE_BOOTSTRAP:-0}" != "1" ]]
}

hash_release_inputs() {
  (
    cd "$CLIENT_DIR"
    {
      printf '%s\0' package.json package-lock.json vite.config.ts tsconfig.json index.html
      find src public scripts -type f -print0 2>/dev/null || true
    } | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
  )
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"

  for ((i=0; i<attempts; i+=1)); do
    if probe_url "$url"; then
      return 0
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

wait_for_binary_url() {
  local label="$1"
  local url="$2"
  local attempts="${3:-60}"

  for ((i=0; i<attempts; i+=1)); do
    if probe_binary_url "$url"; then
      return 0
    fi
    sleep 1
  done

  log "$label did not become ready at $url"
  return 1
}

ensure_postgres() {
  if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    log 'postgres already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$POSTGRES_CONTAINER"; then
    log 'starting existing postgres container'
    docker start "$POSTGRES_CONTAINER" >/dev/null
  else
    log 'creating postgres container'
    docker run -d \
      --name "$POSTGRES_CONTAINER" \
      -e POSTGRES_USER=fsusblog \
      -e POSTGRES_PASSWORD=fsusblog_dev \
      -e POSTGRES_DB=fsusblog \
      -p "${POSTGRES_PORT}:5432" \
      postgres:16-alpine >/dev/null
  fi

  for ((i=0; i<60; i+=1)); do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'postgres failed to become ready'
  exit 1
}

ensure_redis() {
  if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
    log 'redis already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    log 'starting existing redis container'
    docker start "$REDIS_CONTAINER" >/dev/null
  else
    log 'creating redis container'
    docker run -d --name "$REDIS_CONTAINER" -p "${REDIS_PORT}:6379" redis:7-alpine >/dev/null
  fi

  for ((i=0; i<60; i+=1)); do
    if docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'redis failed to become ready'
  exit 1
}

reset_security_test_state() {
  if [[ "$RESET_SECURITY_TEST_STATE" == "0" ]]; then
    return
  fi

  local deleted
  deleted="$(docker exec "$REDIS_CONTAINER" sh -c "{ redis-cli --scan --pattern '*${NS_SLUG}*fsus:sec:pow-risk:*'; redis-cli --scan --pattern 'fsus:sec:pow-risk:*'; } | sort -u | xargs -r redis-cli DEL" 2>/dev/null || true)"
  deleted="${deleted:-0}"
  if [[ "$deleted" =~ ^[0-9]+$ ]] && (( deleted > 0 )); then
    log "reset local security PoW risk keys: ${deleted}"
    FORCE_BOOTSTRAP=1
  fi
}

ensure_backend() {
  local pid_file="$TMP_DIR/backend.pid"
  local log_file="$TMP_DIR/backend.log"
  local managed_pid
  local existing_pid
  managed_pid="$(read_pid_file "$pid_file")"
  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"

  if can_reuse_processes && probe_binary_url "$DEBUG_BACKEND_URL/api/binary/system/seo" && probe_binary_url "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" && probe_notification_drill_url; then
    log 'debug backend already healthy; reusing existing process'
    return
  fi

  if [[ -n "$managed_pid" ]] && kill -0 "$managed_pid" >/dev/null 2>&1; then
    log "restarting managed backend process on ${DEBUG_BACKEND_PORT} (pid ${managed_pid})"
    kill_pid_if_running "$managed_pid"
  elif [[ -n "$existing_pid" ]]; then
    log "restarting unmanaged backend process on ${DEBUG_BACKEND_PORT} (pid ${existing_pid})"
  fi

  existing_pid="$(find_port_pid "$DEBUG_BACKEND_PORT")"
  kill_pid_if_running "$existing_pid"
  kill_pid_if_running "$managed_pid"

  log 'starting managed debug backend'
  nohup setsid bash -lc "cd $(printf '%q' "$ROOT_DIR") && export FSUSBLOG_DATA_ROOT=$(printf '%q' "$TEST_DATA_ROOT") ConnectionStrings__DefaultConnection=$(printf '%q' "$POSTGRES_CONNECTION") ConnectionStrings__Redis=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__Configuration=$(printf '%q' "$REDIS_CONNECTION") RedisOptions__InstanceName=$(printf '%q' "FsusBlog_${NS_SLUG}_") FSUSBLOG_NOTIFICATION_DRILL_SECRET=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") NotificationStream__DrillSecret=$(printf '%q' "$NOTIFICATION_DRILL_SECRET") ASPNETCORE_URLS=http://127.0.0.1:${DEBUG_BACKEND_PORT} ASPNETCORE_ENVIRONMENT=Development CORS_ALLOWED_HOSTS=$(printf '%q' "$CORS_ALLOWED_HOSTS_VALUE") && exec ./tools/build-with-data-env.sh dotnet run --project src/backend/FsusBlog.Server.csproj --no-launch-profile" >"$log_file" 2>&1 < /dev/null &
  echo $! >"$pid_file"

  wait_for_binary_url 'debug backend' "$DEBUG_BACKEND_URL/api/binary/system/seo" 120
  wait_for_binary_url 'pow challenge' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" 120
}

start_background_if_needed() {
  local label="$1"
  local url="$2"
  local pid_file="$3"
  local log_file="$4"
  shift 4
  local -a cmd=("$@")
  local escaped_cmd=""
  local escaped_client_dir=""

  printf -v escaped_cmd '%q ' "${cmd[@]}"
  printf -v escaped_client_dir '%q' "$CLIENT_DIR"

  if probe_url "$url"; then
    log "$label already reachable"
    return
  fi

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "$label process already running with pid $pid"
      wait_for_url "$label" "$url" 120
      return
    fi
  fi

  log "starting $label"
  nohup setsid bash -lc "cd ${escaped_client_dir} && exec ${escaped_cmd}" >"$log_file" 2>&1 < /dev/null &
  echo $! >"$pid_file"

  wait_for_url "$label" "$url" 180
}

ensure_debug_frontend() {
  if can_reuse_processes && probe_url "$DEBUG_FRONTEND_URL/"; then
    log 'debug frontend already healthy; reusing existing process'
    return
  fi

  kill_pid_if_running "$(read_pid_file "$TMP_DIR/dev-server.pid")"
  kill_pid_if_running "$(find_port_pid "$DEBUG_FRONTEND_PORT")"
  start_background_if_needed \
    'debug frontend' \
    "$DEBUG_FRONTEND_URL/" \
    "$TMP_DIR/dev-server.pid" \
    "$TMP_DIR/dev-server.log" \
    env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite --host 0.0.0.0 --port "$DEBUG_FRONTEND_PORT"
}

ensure_release_preview() {
  local fingerprint_file="$TMP_DIR/release-inputs.sha"
  local next_fingerprint
  local current_fingerprint=""
  next_fingerprint="$(hash_release_inputs)"
  if [[ -f "$fingerprint_file" ]]; then
    current_fingerprint="$(cat "$fingerprint_file" 2>/dev/null || true)"
  fi

  if can_reuse_processes \
    && [[ "$current_fingerprint" == "$next_fingerprint" ]] \
    && [[ -f "$CLIENT_DIR/dist/index.html" ]] \
    && [[ -f "$SERVER_WWWROOT_DIR/index.html" ]] \
    && probe_url "$RELEASE_PREVIEW_URL/"; then
    log 'release preview already healthy with matching fingerprint; reusing existing process'
    return
  fi

  log 'building release preview bundle'
  (
    cd "$CLIENT_DIR"
    VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm run build:release >/dev/null
  )
  printf '%s\n' "$next_fingerprint" >"$fingerprint_file"

  sync_backend_wwwroot_from_client_dist

  kill_pid_if_running "$(read_pid_file "$TMP_DIR/preview.pid")"
  kill_pid_if_running "$(find_port_pid "$RELEASE_PREVIEW_PORT")"

  start_background_if_needed \
    'release preview' \
    "$RELEASE_PREVIEW_URL/" \
    "$TMP_DIR/preview.pid" \
    "$TMP_DIR/preview.log" \
    env VITE_API_BASE_URL="$DEBUG_BACKEND_URL" npm exec -- vite preview --host 0.0.0.0 --port "$RELEASE_PREVIEW_PORT"
}

sync_backend_wwwroot_from_client_dist() {
  log 'syncing backend wwwroot with release preview bundle'
  local search_source=""
  rm -rf \
    "$SERVER_WWWROOT_DIR/.vite" \
    "$SERVER_WWWROOT_DIR/aot-cache" \
    "$SERVER_WWWROOT_DIR/assets" \
    "$SERVER_WWWROOT_DIR/dist" \
    "$SERVER_WWWROOT_DIR/wasm" \
    "$SERVER_WWWROOT_DIR/favicon.svg" \
    "$SERVER_WWWROOT_DIR/index.html" \
    "$SERVER_WWWROOT_DIR/sw.js" \
    "$SERVER_WWWROOT_DIR/vite.svg"
  mkdir -p "$SERVER_WWWROOT_DIR"
  cp -a "$CLIENT_DIR/dist/." "$SERVER_WWWROOT_DIR/"

  search_source="$(find "$ROOT_DIR/src/backend/bin" -path '*/wwwroot/search' -type d 2>/dev/null | sort | tail -1 || true)"
  if [[ -n "$search_source" && -d "$search_source" ]]; then
    rm -rf "$SERVER_WWWROOT_DIR/search"
    cp -a "$search_source" "$SERVER_WWWROOT_DIR/search"
  fi
}

prepare_fixtures() {
  log 'preparing auth users and playwright fixtures'
  (
    cd "$CLIENT_DIR"
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL" FSUSBLOG_PG_CONTAINER="$POSTGRES_CONTAINER" FSUSBLOG_REDIS_CONTAINER="$REDIS_CONTAINER" npm run prepare:binary-smoke:auth-users >/dev/null
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL" FSUSBLOG_PG_CONTAINER="$POSTGRES_CONTAINER" FSUSBLOG_REDIS_CONTAINER="$REDIS_CONTAINER" npm run prepare:playwright:fixtures >/dev/null
    if [[ "${FSUSBLOG_TEST_SESSION_ISOLATION:-0}" == "1" ]]; then
      FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL" FSUSBLOG_PG_CONTAINER="$POSTGRES_CONTAINER" FSUSBLOG_REDIS_CONTAINER="$REDIS_CONTAINER" npm run prepare:playwright:sessions >/dev/null
    fi
  )
}

current_pow_difficulty() {
  (
    cd "$ROOT_DIR"
    FSUSBLOG_BASE_URL="$DEBUG_BACKEND_URL" "${FSUSBLOG_NODE:-node}" --input-type=module -e "import { fetchChallenge } from './tests/frontend/support/auth-helpers.mjs'; const challenge = await fetchChallenge(5000); console.log(challenge.difficulty ?? challenge.Difficulty ?? 999);"
  )
}

wait_for_pow_ready() {
  local max_difficulty="$POW_READY_MAX_DIFFICULTY"
  local difficulty=""

  for ((i=0; i<30; i+=1)); do
    difficulty="$(current_pow_difficulty 2>/dev/null || true)"
    if [[ "$difficulty" =~ ^[0-9]+$ ]] && (( difficulty <= max_difficulty )); then
      log "pow difficulty ready: ${difficulty}"
      return 0
    fi

    sleep 1
  done

  log "pow difficulty did not settle below ${max_difficulty}; last=${difficulty:-unknown}"
  return 1
}

main() {
  command -v docker >/dev/null 2>&1 || { log 'docker is required'; exit 1; }
  mkdir -p "$SERVER_WWWROOT_DIR"
  ensure_postgres
  ensure_redis
  reset_security_test_state
  ensure_backend
  ensure_release_preview
  ensure_debug_frontend
  wait_for_pow_ready
  prepare_fixtures
  jq -n \
    --arg namespace "$FSUSBLOG_TEST_NAMESPACE" \
    --arg backend "$DEBUG_BACKEND_URL" \
    --arg frontend "$DEBUG_FRONTEND_URL" \
    --arg preview "$RELEASE_PREVIEW_URL" \
    --arg postgres "$POSTGRES_CONTAINER" \
    --arg redis "$REDIS_CONTAINER" \
    '{namespace: $namespace, backendUrl: $backend, frontendUrl: $frontend, previewUrl: $preview, containers: {postgres: $postgres, redis: $redis}, generatedAt: now | todate}' \
    > "$FIXTURE_DIR/manifest.json"
  wait_for_binary_url 'seo probe' "$DEBUG_BACKEND_URL/api/binary/system/seo" 30
  wait_for_binary_url 'pow challenge probe' "$DEBUG_BACKEND_URL/api/binary/auth/pow-challenge" 30
  log 'acceptance environment ready'
}

main "$@"
