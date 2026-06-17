#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/dev/docker-compose.yml"
FRONTEND_DIR="$ROOT_DIR/src/frontend"
BACKEND_PROJECT="$ROOT_DIR/src/backend/FsusBlog.Server.csproj"

SEED_DEMO=0
INSTALL_DEPS=1
CLEANUP=0

usage() {
  cat <<'USAGE'
Usage: tools/dev/start.sh [--seed-demo] [--no-install] [--cleanup]

Starts the public-preview development stack:
  - PostgreSQL and Redis through deploy/dev/docker-compose.yml
  - ASP.NET Core backend on http://127.0.0.1:7568
  - Vite frontend on http://127.0.0.1:3000

Options:
  --seed-demo   Seed deterministic fictional demo content after backend startup.
  --no-install  Do not run npm ci when src/frontend/node_modules is missing.
  --cleanup     Stop and remove dev PostgreSQL/Redis containers and volumes.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --seed-demo) SEED_DEMO=1 ;;
    --no-install) INSTALL_DEPS=0 ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[dev-start] unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[dev-start] missing required command: $1" >&2
    echo "[dev-start] install prerequisites from docs/development.md and retry." >&2
    exit 1
  fi
}

need_cmd docker
need_cmd dotnet
need_cmd node
need_cmd npm

if [[ "$CLEANUP" == "1" ]]; then
  docker compose -f "$COMPOSE_FILE" down -v
  echo "[dev-start] removed dev containers and volumes."
  exit 0
fi

echo "[dev-start] starting PostgreSQL and Redis..."
docker compose -f "$COMPOSE_FILE" up -d postgres redis

echo "[dev-start] waiting for PostgreSQL..."
for _ in $(seq 1 60); do
  if docker exec fsusblog-dev-postgres pg_isready -U "${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}" -d "${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker exec fsusblog-dev-postgres pg_isready -U "${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}" -d "${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}" >/dev/null 2>&1; then
  echo "[dev-start] PostgreSQL did not become ready. Check: docker logs fsusblog-dev-postgres" >&2
  exit 1
fi

echo "[dev-start] waiting for Redis..."
for _ in $(seq 1 60); do
  if docker exec fsusblog-dev-redis redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker exec fsusblog-dev-redis redis-cli ping >/dev/null 2>&1; then
  echo "[dev-start] Redis did not become ready. Check: docker logs fsusblog-dev-redis" >&2
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  if [[ "$INSTALL_DEPS" != "1" ]]; then
    echo "[dev-start] src/frontend/node_modules is missing and --no-install was used." >&2
    exit 1
  fi
  if [[ -z "${GITHUB_PACKAGES_TOKEN:-}" ]]; then
    echo "[dev-start] GITHUB_PACKAGES_TOKEN is not set. npm ci may fail for the private FsusUI package." >&2
    echo "[dev-start] Set a read:packages token or install dependencies manually before retrying." >&2
  fi
  npm --prefix "$FRONTEND_DIR" ci
fi

export ASPNETCORE_ENVIRONMENT=Development
export ConnectionStrings__DefaultConnection="Host=127.0.0.1;Port=${FSUSBLOG_DEV_POSTGRES_PORT:-5432};Database=${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog};Username=${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog};Password=${FSUSBLOG_DEV_POSTGRES_PASSWORD:-fsusblog_dev}"
export ConnectionStrings__Redis="127.0.0.1:${FSUSBLOG_DEV_REDIS_PORT:-6379},abortConnect=false,connectTimeout=10000"
export RedisOptions__Configuration="$ConnectionStrings__Redis"
export CORS_ALLOWED_HOSTS="http://localhost:3000,http://127.0.0.1:3000"
export Seo__BaseUrl="http://127.0.0.1:3000"
export Fido2__ServerDomain="localhost"
export Fido2__Origins__0="http://localhost:3000"
export Fido2__Origins__1="http://127.0.0.1:3000"
export AuthCookies__AllowInsecureTransportCookies="true"

backend_pid=""
frontend_pid=""
cleanup_children() {
  if [[ -n "$frontend_pid" ]]; then kill "$frontend_pid" >/dev/null 2>&1 || true; fi
  if [[ -n "$backend_pid" ]]; then kill "$backend_pid" >/dev/null 2>&1 || true; fi
}
trap cleanup_children EXIT INT TERM

echo "[dev-start] starting backend on http://127.0.0.1:7568 ..."
dotnet run --project "$BACKEND_PROJECT" --no-launch-profile --urls "http://127.0.0.1:7568" &
backend_pid=$!

if command -v curl >/dev/null 2>&1; then
  echo "[dev-start] waiting for backend health..."
  backend_ready=0
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:7568/health/live" >/dev/null 2>&1; then
      backend_ready=1
      break
    fi
    if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
      echo "[dev-start] backend process exited before health check passed." >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$backend_ready" != "1" ]]; then
    echo "[dev-start] backend health did not become ready at http://127.0.0.1:7568/health/live" >&2
    exit 1
  fi
else
  echo "[dev-start] curl not found; skipping backend health probe."
  sleep 8
fi

if [[ "$SEED_DEMO" == "1" ]]; then
  "$ROOT_DIR/tools/dev/seed-demo-data.sh"
fi

echo "[dev-start] starting frontend on http://127.0.0.1:3000 ..."
npm --prefix "$FRONTEND_DIR" run dev:debug &
frontend_pid=$!

cat <<'READY'
[dev-start] local stack is starting.
  Frontend: http://127.0.0.1:3000
  Backend:  http://127.0.0.1:7568
  Cleanup:  ./tools/dev/start.sh --cleanup

Press Ctrl+C to stop backend and frontend processes.
READY

wait -n "$backend_pid" "$frontend_pid"
