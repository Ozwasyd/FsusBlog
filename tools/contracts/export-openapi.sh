#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FSUSBLOG_OPENAPI_OUT_DIR:-$ROOT_DIR/.tmp/contracts/openapi}"
OUT_FILE="$OUT_DIR/fsusblog.openapi.json"
SNAPSHOT_FILE="$ROOT_DIR/src/shared/Contracts/Validation/fsusblog.openapi.json"
UPDATE_SNAPSHOT="${FSUSBLOG_OPENAPI_UPDATE_SNAPSHOT:-0}"
CHECK_ARGS=()

if [[ "${1:-}" == "--update-snapshot" ]]; then
    UPDATE_SNAPSHOT=1
elif [[ -n "${1:-}" ]]; then
    printf 'Usage: %s [--update-snapshot]\n' "$0" >&2
    exit 2
fi

mkdir -p "$OUT_DIR"

# Authoritative observation from compiled endpoint registration (no public listener).
# OpenApiGenerateDocumentsOnBuild remains false; this independent target is the unique generator.
if ! command -v "${FSUSBLOG_NODE:-node}" >/dev/null 2>&1; then
    printf '[openapi] node is required to run openapi observation cutover\n' >&2
    exit 1
fi

if [[ "$UPDATE_SNAPSHOT" == "1" ]]; then
    CHECK_ARGS+=(--update-snapshot)
fi

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/check-openapi-sync.mjs" "${CHECK_ARGS[@]}"

# Materialize generated path for local consumers from the sealed observed projection.
if [[ -f "$OUT_DIR/fsusblog.openapi.observed.json" ]]; then
    cp "$OUT_DIR/fsusblog.openapi.observed.json" "$OUT_FILE"
fi

if [[ "$UPDATE_SNAPSHOT" == "1" ]]; then
    printf '[openapi] wrote observation and updated %s\n' "$SNAPSHOT_FILE"
elif ! cmp -s "$OUT_FILE" "$SNAPSHOT_FILE"; then
    printf '[openapi] generated contract differs from tracked projection; inspect %s or rerun with --update-snapshot\n' "$OUT_FILE" >&2
    diff -u "$SNAPSHOT_FILE" "$OUT_FILE" >&2 || true
    exit 1
else
    printf '[openapi] generated contract matches tracked projection: %s\n' "$OUT_FILE"
fi
