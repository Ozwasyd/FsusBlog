#!/usr/bin/env bash
# fixture-catalog: consumer data-scale-lane matrix
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIER="${FSUSBLOG_SCALE_TIER:-${1:-scale-xs}}"
DATA_SCALE_ROOT="${FSUSBLOG_DATA_SCALE_ROOT:-$ROOT_DIR/.tmp/scale}"
OUT_DIR="$DATA_SCALE_ROOT/$TIER"
RELEASE_SUMMARY_DIR="$DATA_SCALE_ROOT/release-summaries"
export FSUSBLOG_POSTGRES_CONTAINER_NAME="${FSUSBLOG_POSTGRES_CONTAINER_NAME:-${FSUSBLOG_PG_CONTAINER:-fsusblog-dev-postgres}}"

# shellcheck source=_release-reliability-lifecycle.sh
source "$ROOT_DIR/tools/test/lanes/_release-reliability-lifecycle.sh"
InitializeReleaseReliabilityLifecycle

mkdir -p "$OUT_DIR"
mkdir -p "$RELEASE_SUMMARY_DIR"
# Keep each tier self-contained: no failed invocation may consume its prior raw
# observations or authority projection.
rm -f -- "$OUT_DIR/seed.json" "$OUT_DIR/summary.json" "$OUT_DIR/cleanup.json" "$RELEASE_SUMMARY_DIR/$TIER.json"

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

bash "$ROOT_DIR/tools/data-scale/seed.sh" "$TIER"

set +e
bash "$ROOT_DIR/tools/data-scale/probe.sh" "$TIER"
probe_status=$?
bash "$ROOT_DIR/tools/data-scale/cleanup.sh" "$TIER"
cleanup_status=$?
set -e

ReadJsonOrNull() {
    local file="$1"
    if [[ -f "$file" ]] && jq -e . "$file" >/dev/null 2>&1; then
        jq -c . "$file"
        return
    fi

    printf 'null'
}

seed_json="$(ReadJsonOrNull "$OUT_DIR/seed.json")"
summary_json="$(ReadJsonOrNull "$OUT_DIR/summary.json")"
cleanup_json="$(ReadJsonOrNull "$OUT_DIR/cleanup.json")"
summary_status="$(jq -r '.status // "failed"' <<<"$summary_json")"
cleanup_result="$(jq -r '.status // "failed"' <<<"$cleanup_json")"
release_status="ok"
if [[ "$probe_status" -ne 0 || "$cleanup_status" -ne 0 || "$summary_status" != "ok" || "$cleanup_result" != "ok" ]]; then
    release_status="failed"
fi

jq -n \
    --arg status "$release_status" \
    --arg tier "$TIER" \
    --arg file "$(realpath --relative-to="$ROOT_DIR" "$OUT_DIR/summary.json")" \
    --argjson articles "$articles" \
    --argjson comments "$comments" \
    --argjson seed "$seed_json" \
    --argjson observed "$summary_json" \
    --argjson cleanup "$cleanup_json" \
    '({schema:"fsusblog.data-scale-tier-summary.v1", status:$status, tier:$tier, summary:$file, expectedSeed:{articles:$articles, comments:$comments}, sampling:$observed.sampling, seed:$seed, observed:$observed, cleanup:$cleanup, generatedAt: now | todate} + (if $observed.releaseReliability == null then {} else {releaseReliability:$observed.releaseReliability} end))' \
    >"$RELEASE_SUMMARY_DIR/$TIER.json"

if [[ "$release_status" != "ok" ]]; then
    printf '[data-scale] failed tier=%s probe=%s cleanup=%s summary=%s cleanupSummary=%s\n' "$TIER" "$probe_status" "$cleanup_status" "$summary_status" "$cleanup_result" >&2
    exit 1
fi

printf '[data-scale] wrote %s\n' "$OUT_DIR/summary.json"
