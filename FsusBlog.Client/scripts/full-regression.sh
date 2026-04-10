#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/FsusBlog.Client"
SERVER_PROJ="$ROOT_DIR/FsusBlog.Server/FsusBlog.Server.csproj"

PG_CONTAINER="${FSUSBLOG_PG_CONTAINER:-fsusblog-postgres}"
REDIS_CONTAINER="${FSUSBLOG_REDIS_CONTAINER:-fsusblog-redis}"
PG_VOLUME="${FSUSBLOG_PG_VOLUME:-fsusblog-pgdata}"
BUILD_TIMEOUT="${FSUSBLOG_BUILD_TIMEOUT:-20m}"
SMOKE_TIMEOUT="${FSUSBLOG_SMOKE_TIMEOUT:-5m}"

FSUSBLOG_BASE_URL="${FSUSBLOG_BASE_URL:-http://127.0.0.1:5000}"
export FSUSBLOG_BASE_URL

FSUSBLOG_USER_USERNAME="${FSUSBLOG_USER_USERNAME:-binaryuser}"
FSUSBLOG_USER_PASSWORD="${FSUSBLOG_USER_PASSWORD:-BinaryUserPass123!}"
FSUSBLOG_ADMIN_USERNAME="${FSUSBLOG_ADMIN_USERNAME:-binaryadmin}"
FSUSBLOG_ADMIN_PASSWORD="${FSUSBLOG_ADMIN_PASSWORD:-BinaryAdminPass123!}"
export FSUSBLOG_USER_USERNAME FSUSBLOG_USER_PASSWORD FSUSBLOG_ADMIN_USERNAME FSUSBLOG_ADMIN_PASSWORD

SERVER_PID=""

log() {
  printf '[full-regression] %s\n' "$1"
}

ensure_docker_access() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  log "docker unavailable; ensure the current user can access /var/run/docker.sock"
  return 1
}

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ensure_postgres() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
      log "starting existing postgres container: $PG_CONTAINER"
      docker start "$PG_CONTAINER" >/dev/null
    fi
    return
  fi

  log "creating postgres container: $PG_CONTAINER"
  docker volume create "$PG_VOLUME" >/dev/null
  docker run -d \
    --name "$PG_CONTAINER" \
    -e POSTGRES_DB=fsusblog \
    -e POSTGRES_USER=fsusblog \
    -e POSTGRES_PASSWORD=fsusblog_dev \
    -p 5432:5432 \
    -v "$PG_VOLUME:/var/lib/postgresql/data" \
    postgres:16-alpine >/dev/null
}

ensure_redis() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    if ! docker ps --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
      log "starting existing redis container: $REDIS_CONTAINER"
      docker start "$REDIS_CONTAINER" >/dev/null
    fi
    return
  fi

  log "creating redis container: $REDIS_CONTAINER"
  docker run -d \
    --name "$REDIS_CONTAINER" \
    -p 6379:6379 \
    redis:7-alpine >/dev/null
}

wait_server_ready() {
  local max_retry=90
  local i=1

  while (( i <= max_retry )); do
    if grep -q "System Ready (API Engine Mode)" "$ROOT_DIR/.full-regression-server.log" 2>/dev/null; then
      return 0
    fi

    sleep 1
    ((i++))
  done

  log "server readiness timeout; latest server log:"
  tail -n 80 "$ROOT_DIR/.full-regression-server.log" || true
  return 1
}

start_server() {
  log "starting server (Development)"
  ASPNETCORE_ENVIRONMENT=Development \
    dotnet run --project "$SERVER_PROJ" -c Release -- --urls "$FSUSBLOG_BASE_URL" \
    > "$ROOT_DIR/.full-regression-server.log" 2>&1 &
  SERVER_PID=$!
  wait_server_ready
}

main() {
  ensure_docker_access

  log "ensuring infrastructure containers"
  ensure_postgres
  ensure_redis

  log "building backend (Release + warnaserror)"
  timeout "$BUILD_TIMEOUT" dotnet build "$ROOT_DIR/FsusBlog.slnx" -c Release -warnaserror -v minimal

  log "checking aot artifacts"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run check:aot"

  log "checking views constraints"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run check:views-constraints"

  start_server

  log "running public seo smoke"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run check:public-seo-smoke"

  log "preparing auth smoke users"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run prepare:binary-smoke:auth-users"

  log "running binary smoke (unauthorized + public)"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run check:binary-smoke"

  log "running binary smoke (authorized)"
  timeout "$SMOKE_TIMEOUT" bash -lc "cd '$CLIENT_DIR' && npm run check:binary-smoke:auth"

  log "all checks passed"
}

main "$@"
