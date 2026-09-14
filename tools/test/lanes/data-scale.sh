#!/usr/bin/env bash
# fixture-catalog: consumer data-scale-lane matrix
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIER="${FSUSBLOG_SCALE_TIER:-${1:-scale-xs}}"
DATA_SCALE_ROOT="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}"
OUT_DIR="$DATA_SCALE_ROOT/$TIER"
RELEASE_SUMMARY_DIR="$DATA_SCALE_ROOT/release-summaries"
if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" ]]; then
    if [[ -n "${FSUSBLOG_PG_CONTAINER:-}" ]]; then
        export FSUSBLOG_POSTGRES_CONTAINER_NAME="$FSUSBLOG_PG_CONTAINER"
    fi
fi
if [[ -z "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-}" || "${FSUSBLOG_POSTGRES_CONTAINER_NAME}" == "fsusblog-dev-postgres" || "${FSUSBLOG_POSTGRES_CONTAINER_NAME}" == fsusblog-dev-* || "${FSUSBLOG_POSTGRES_CONTAINER_NAME}" == fsusblog-test-postgres-* || "${FSUSBLOG_POSTGRES_CONTAINER_NAME}" == fsusblog-candidate-* ]]; then
    printf '[data-scale] dedicated-scenario runtime container is required; shared or development container %s is prohibited\n' "${FSUSBLOG_POSTGRES_CONTAINER_NAME:-<empty>}" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
mkdir -p "$RELEASE_SUMMARY_DIR"
# Measurement owns only its current probe and release projection. Dedicated
# runtime/seed setup and teardown are lifecycle-owner receipts, not lane output.
rm -f -- "$OUT_DIR/summary.json" "$RELEASE_SUMMARY_DIR/$TIER.json"

case "$TIER" in
    scale-xs)
        articles=1
        comments=0
        ;;
    scale-s)
        articles=100
        comments=1000
        ;;
    scale-m)
        articles=10000
        comments=100000
        ;;
    scale-l-nightly)
        articles=100000
        comments=1000000
        ;;
    *)
        printf '[data-scale] unknown tier %s\n' "$TIER" >&2
        exit 1
        ;;
esac

set +e
bash "${FSUSBLOG_DATA_SCALE_PROBE_SCRIPT:-$ROOT_DIR/tools/data-scale/probe.sh}" "$TIER"
probe_status=$?
set -e

ReadJsonOrNull() {
    local file="$1"
    if [[ -f "$file" ]] && jq -e . "$file" >/dev/null 2>&1; then
        jq -c . "$file"
        return
    fi

    printf 'null'
}

summary_json="$(ReadJsonOrNull "$OUT_DIR/summary.json")"
summary_status="$(jq -r '.status // "failed"' <<<"$summary_json")"
summary_schema="$(jq -r '.schema // empty' <<<"$summary_json")"
release_status="ok"
if [[ "$summary_schema" != "fsusblog.data-scale-semantic-proof.v2" ]]; then
    printf '[data-scale] summary.json schema must be fsusblog.data-scale-semantic-proof.v2, got %s\n' "${summary_schema:-<empty>}" >&2
    release_status="failed"
fi
if [[ "$probe_status" -ne 0 || "$summary_status" != "ok" ]]; then
    release_status="failed"
fi

jq -n \
    --arg status "$release_status" \
    --arg tier "$TIER" \
    --arg file "$(realpath --relative-to="$ROOT_DIR" "$OUT_DIR/summary.json")" \
    --argjson articles "$articles" \
    --argjson comments "$comments" \
    --argjson observed "$summary_json" \
    '({schema:"fsusblog.data-scale-tier-summary.v1", status:$status, tier:$tier, summary:$file, expectedSeed:{articles:$articles, comments:$comments}, sampling:$observed.sampling, observed:$observed, generatedAt: now | todate} + (if $observed.releaseReliability == null then {} else {releaseReliability:$observed.releaseReliability} end))' \
    >"$RELEASE_SUMMARY_DIR/$TIER.json"

if [[ "$release_status" != "ok" ]]; then
    printf '[data-scale] failed tier=%s probe=%s summary=%s\n' "$TIER" "$probe_status" "$summary_status" >&2
    exit 1
fi

printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"
