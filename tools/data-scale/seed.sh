#!/usr/bin/env bash
# fixture-catalog: producer scale-data
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
if [[ "$#" -gt 1 ]]; then
    printf '[data-scale] exactly one tier argument is allowed\n' >&2
    exit 1
fi
node "$ROOT_DIR/tools/data-scale/validate-tier.mjs" "$TIER"
if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" ]]; then
    printf '[data-scale:seed] FSUSBLOG_POSTGRES_CONTAINER_NAME is required; falling back to dev or shared postgres is prohibited\n' >&2
    exit 1
fi
postgres_container="$FSUSBLOG_POSTGRES_CONTAINER_NAME"

if [[ "$postgres_container" == "fsusblog-dev-postgres" || "$postgres_container" == fsusblog-dev-* || "$postgres_container" == fsusblog-test-postgres-* || "$postgres_container" == fsusblog-candidate-* ]]; then
    printf '[data-scale:seed] prohibited from using shared or development postgres container: %s\n' "$postgres_container" >&2
    exit 1
fi

if [[ -n "${FSUSBLOG_DEBUG_BACKEND_URL:-}" ]]; then
    if curl -s -f -m 1 "${FSUSBLOG_DEBUG_BACKEND_URL%/}/health/live" >/dev/null 2>&1; then
        printf '[data-scale:seed] backend is already running; raw SQL seed is prohibited while backend is running\n' >&2
        exit 1
    fi
fi
if [[ -n "${FSUSBLOG_BACKEND_PID:-}" ]] && kill -0 "$FSUSBLOG_BACKEND_PID" 2>/dev/null; then
    printf '[data-scale:seed] backend process %s is running; raw SQL seed is prohibited while backend is running\n' "$FSUSBLOG_BACKEND_PID" >&2
    exit 1
fi

require_empty="${FSUSBLOG_DATA_SCALE_REQUIRE_EMPTY:-0}"
if [[ "$require_empty" != "0" && "$require_empty" != "1" ]]; then
    printf '[data-scale:seed] FSUSBLOG_DATA_SCALE_REQUIRE_EMPTY must be 0 or 1\n' >&2
    exit 1
fi
if [[ "$require_empty" == "1" ]]; then
    backend_container="${FSUSBLOG_DATA_SCALE_BACKEND_CONTAINER_NAME:-}"
    redis_container="${FSUSBLOG_REDIS_CONTAINER_NAME:-}"
    if [[ -z "$backend_container" || -z "$redis_container" ]]; then
        printf '[data-scale:seed] dedicated backend and Redis identities are required\n' >&2
        exit 1
    fi
    if ! backend_inventory="$(docker ps -a --format '{{.Names}}')"; then
        printf '[data-scale:seed] dedicated backend inventory is unavailable\n' >&2
        exit 1
    fi
    if grep -Fqx -- "$backend_container" <<<"$backend_inventory"; then
        printf '[data-scale:seed] dedicated backend must be absent during raw seed: %s\n' "$backend_container" >&2
        exit 1
    fi
    if [[ "$(docker exec "$redis_container" redis-cli --raw DBSIZE)" != "0" ]]; then
        printf '[data-scale:seed] dedicated Redis must be pristine during raw seed: %s\n' "$redis_container" >&2
        exit 1
    fi
fi

if ! docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    printf '[data-scale:seed] postgres container is not ready: %s\n' "$postgres_container" >&2
    exit 1
fi

if ! active_connections="$(docker exec -i "$postgres_container" psql -X -q -t -A -U fsusblog -d fsusblog -c "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" 2>/dev/null)"; then
    printf '[data-scale:seed] dedicated database connection inventory is unavailable\n' >&2
    exit 1
fi
if [[ ! "$active_connections" =~ ^[0-9]+$ ]]; then
    printf '[data-scale:seed] dedicated database connection inventory is invalid\n' >&2
    exit 1
fi
if [[ "$active_connections" -gt 0 ]]; then
    printf '[data-scale:seed] dedicated database has %s active foreign connections; offline seed requires isolation\n' "$active_connections" >&2
    exit 1
fi

# Full graph host/recovery are owned by #2542. Retired private SQL must never
# serve as a fallback while that capability is unavailable.
printf '[data-scale:seed] canonical full graph writer capability unavailable (#2542); legacy five-table path retired; no verified receipt emitted\n' >&2
exit 1
