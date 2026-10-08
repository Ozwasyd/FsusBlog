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
    printf '[data-scale:cleanup] FSUSBLOG_POSTGRES_CONTAINER_NAME is required; falling back to dev or shared postgres is prohibited\n' >&2
    exit 1
fi
postgres_container="$FSUSBLOG_POSTGRES_CONTAINER_NAME"

if [[ "$postgres_container" == "fsusblog-dev-postgres" || "$postgres_container" == fsusblog-dev-* || "$postgres_container" == fsusblog-test-postgres-* || "$postgres_container" == fsusblog-candidate-* ]]; then
    printf '[data-scale:cleanup] prohibited from using shared or development postgres container: %s\n' "$postgres_container" >&2
    exit 1
fi

if ! docker exec "$postgres_container" pg_isready -U fsusblog -d fsusblog >/dev/null 2>&1; then
    printf '[data-scale:cleanup] postgres container is not ready: %s\n' "$postgres_container" >&2
    exit 1
fi

# Full graph host/recovery are owned by #2542. Retired private SQL must never
# serve as a fallback while that capability is unavailable.
printf '[data-scale:cleanup] canonical full graph receipt-owned recovery/cleanup capability unavailable (#2542); legacy five-table path retired; no verified receipt emitted\n' >&2
exit 1
