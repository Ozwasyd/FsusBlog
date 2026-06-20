#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/deploy/dev/docker-compose.yml"
SEED_SQL="$ROOT_DIR/tools/dev/demo-seed.sql"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[seed-demo] missing required command: $1" >&2
    exit 1
  fi
}

need_cmd docker

DB_NAME="${FSUSBLOG_DEV_POSTGRES_DB:-fsusblog}"
DB_USER="${FSUSBLOG_DEV_POSTGRES_USER:-fsusblog}"
DB_PASSWORD="${FSUSBLOG_DEV_POSTGRES_PASSWORD:-fsusblog_dev}"

docker compose -f "$COMPOSE_FILE" up -d postgres >/dev/null

for _ in $(seq 1 60); do
  if docker exec fsusblog-dev-postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -Atc "select to_regclass('public.sys_user')" | grep -q sys_user; then
  cat >&2 <<'MESSAGE'
[seed-demo] database schema is not ready.
[seed-demo] Start the backend once so SqlSugar CodeFirst migrations create tables, then rerun:
[seed-demo]   ./tools/dev/seed-demo-data.sh
MESSAGE
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T -e PGPASSWORD="$DB_PASSWORD" postgres \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SEED_SQL"

cat <<'DONE'
[seed-demo] demo data applied.
  Anonymous account public handle: demo-reader
  Admin principal handle: demo-admin
  Admin access: create a local Passkey admin with the bootstrap flow.
DONE
