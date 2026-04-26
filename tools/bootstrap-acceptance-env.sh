#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="$ROOT_DIR/FsusBlog.Client"
TMP_DIR="$ROOT_DIR/.tmp/acceptance"
mkdir -p "$TMP_DIR"

DEBUG_FRONTEND_URL="${FSUSBLOG_DEBUG_FRONTEND_URL:-http://127.0.0.1:3000}"
DEBUG_BACKEND_URL="${FSUSBLOG_DEBUG_BACKEND_URL:-http://127.0.0.1:5000}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"

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

ensure_postgres() {
  if docker exec fsusblog-postgres pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    log 'postgres already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx 'fsusblog-postgres'; then
    log 'starting existing postgres container'
    docker start fsusblog-postgres >/dev/null
  else
    log 'creating postgres container'
    docker run -d \
      --name fsusblog-postgres \
      -e POSTGRES_USER=fsusblog \
      -e POSTGRES_PASSWORD=fsusblog_dev \
      -e POSTGRES_DB=fsusblog \
      -p 5432:5432 \
      postgres:16-alpine >/dev/null
  fi

  for ((i=0; i<60; i+=1)); do
    if docker exec fsusblog-postgres pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'postgres failed to become ready'
  exit 1
}

ensure_redis() {
  if docker exec fsusblog-redis redis-cli ping >/dev/null 2>&1; then
    log 'redis already ready'
    return
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx 'fsusblog-redis'; then
    log 'starting existing redis container'
    docker start fsusblog-redis >/dev/null
  else
    log 'creating redis container'
    docker run -d --name fsusblog-redis -p 6379:6379 redis:7-alpine >/dev/null
  fi

  for ((i=0; i<60; i+=1)); do
    if docker exec fsusblog-redis redis-cli ping >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  log 'redis failed to become ready'
  exit 1
}

ensure_backend() {
  local pid_file="$TMP_DIR/backend.pid"
  local log_file="$TMP_DIR/backend.log"
  local managed_pid
  managed_pid="$(read_pid_file "$pid_file")"

  if probe_url "$DEBUG_BACKEND_URL/api/System/seo"; then
    if [[ -n "$managed_pid" ]] && kill -0 "$managed_pid" >/dev/null 2>&1; then
      log 'backend already reachable'
      return
    fi

    local existing_pid
    existing_pid="$(find_port_pid 5000)"
    if [[ -n "$existing_pid" ]]; then
      log "restarting unmanaged backend process on 5000 (pid ${existing_pid})"
      kill_pid_if_running "$existing_pid"
    fi
  fi

  kill_pid_if_running "$managed_pid"

  log 'starting managed debug backend'
  nohup setsid bash -lc "cd $(printf '%q' "$ROOT_DIR") && exec ./tools/build-with-data-env.sh dotnet run --project FsusBlog.Server/FsusBlog.Server.csproj --launch-profile FsusBlog.Server" >"$log_file" 2>&1 < /dev/null &
  echo $! >"$pid_file"

  wait_for_url 'debug backend' "$DEBUG_BACKEND_URL/api/System/seo" 120
  wait_for_url 'pow challenge' "$DEBUG_BACKEND_URL/api/Auth/pow-challenge" 120
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
  kill_pid_if_running "$(read_pid_file "$TMP_DIR/dev-server.pid")"
  kill_pid_if_running "$(find_port_pid 3000)"
  start_background_if_needed \
    'debug frontend' \
    "$DEBUG_FRONTEND_URL/" \
    "$TMP_DIR/dev-server.pid" \
    "$TMP_DIR/dev-server.log" \
    npm run dev:debug
}

ensure_release_preview() {
  log 'building release preview bundle'
  (
    cd "$CLIENT_DIR"
    npm run build:release >/dev/null
  )

  kill_pid_if_running "$(read_pid_file "$TMP_DIR/preview.pid")"
  kill_pid_if_running "$(find_port_pid 8080)"

  start_background_if_needed \
    'release preview' \
    "$RELEASE_PREVIEW_URL/" \
    "$TMP_DIR/preview.pid" \
    "$TMP_DIR/preview.log" \
    npm run preview
}

prepare_fixtures() {
  log 'preparing auth users and playwright fixtures'
  (
    cd "$CLIENT_DIR"
    npm run prepare:binary-smoke:auth-users >/dev/null
    npm run prepare:playwright:fixtures >/dev/null
  )
}

main() {
  command -v docker >/dev/null 2>&1 || { log 'docker is required'; exit 1; }
  ensure_postgres
  ensure_redis
  ensure_backend
  ensure_debug_frontend
  ensure_release_preview
  prepare_fixtures
  wait_for_url 'seo probe' "$DEBUG_BACKEND_URL/api/System/seo" 30
  wait_for_url 'pow challenge probe' "$DEBUG_BACKEND_URL/api/Auth/pow-challenge" 30
  log 'acceptance environment ready'
}

main "$@"
