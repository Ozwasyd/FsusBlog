#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
COVERAGE_ROOT="${FSUSBLOG_COVERAGE_ROOT:-$ROOT_DIR/.tmp/coverage}"
BACKEND_TRX_DIR="${FSUSBLOG_BACKEND_TRX_DIR:-$ROOT_DIR/.tmp/test-results/backend}"
TRX_FILE="$BACKEND_TRX_DIR/coverage-backend.trx"
RESULTS_DIR="$COVERAGE_ROOT/backend"
ORDINARY_RESULTS_DIR="$RESULTS_DIR/ordinary"
SUMMARY_DIR="$COVERAGE_ROOT/backend-merged"
SUMMARY_FILE="$SUMMARY_DIR/Summary.json"
EXPECTED_RESULT_LANES=(ordinary special-api-integration special-auth-state-machine special-concurrency special-property special-golden)

PruneVstestSerializedAttachmentCopies() {
    local laneDir="$1"
    local serializedDir serializedCobertura serializedJson primaryCobertura primaryJson
    local -a serializedCoberturaFiles serializedJsonFiles

    while IFS= read -r -d '' serializedDir; do
        mapfile -d '' serializedCoberturaFiles < <(find "$serializedDir" -type f -name 'coverage.cobertura.xml' -print0)
        mapfile -d '' serializedJsonFiles < <(find "$serializedDir" -type f -name 'coverage.json' -print0)
        if [[ "${#serializedCoberturaFiles[@]}" != "1" || "${#serializedJsonFiles[@]}" != "1" ]]; then
            continue
        fi

        serializedCobertura="${serializedCoberturaFiles[0]}"
        serializedJson="${serializedJsonFiles[0]}"
        while IFS= read -r -d '' primaryCobertura; do
            if [[ "$primaryCobertura" == "$serializedDir"/* ]]; then
                continue
            fi
            primaryJson="$(dirname "$primaryCobertura")/coverage.json"
            if [[ -f "$primaryJson" ]] &&
                cmp -s "$serializedCobertura" "$primaryCobertura" &&
                cmp -s "$serializedJson" "$primaryJson"; then
                rm -rf "$serializedDir"
                break
            fi
        done < <(find "$laneDir" -type f -name 'coverage.cobertura.xml' -print0)
    done < <(find "$laneDir" -mindepth 1 -maxdepth 1 -type d -name '_ser*' -print0)
}

if [[ "${1:-}" == "--dry-run" ]]; then
    jq -n --arg script "collect-backend-coverage" --arg out "$SUMMARY_FILE" '{
    script: $script,
    status: "dry-run",
    output: $out,
    schema: "fsusblog.coverage.summary.v1"
  }'
    exit 0
fi

if [[ "${FSUSBLOG_COVERAGE_SKIP_TESTS:-0}" != "1" ]]; then
    # Dedicated API/state-machine/concurrency/property/golden tiers write their
    # own Cobertura files below backend/special-*. Preserve those runs and add
    # the ordinary unit selection exactly once before producing one summary.
    rm -rf "$ORDINARY_RESULTS_DIR" "$SUMMARY_DIR"
    mkdir -p "$ORDINARY_RESULTS_DIR" "$SUMMARY_DIR" "$BACKEND_TRX_DIR"
    rm -f "$TRX_FILE"
    # Reuse the exact build namespace/fingerprint used by backend-build-governance.
    # Standalone coverage still builds when the shared artifact is absent or stale.
    source "$ROOT_DIR/tools/test/lanes/_legacy.sh"
    EnsureBackendFilteredBuild
    ConfigureDotnetTestProcessors
    dotnet test "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
        -c Debug \
        --no-build \
        -v minimal \
        --filter "$BACKEND_ORDINARY_TEST_FILTER" \
        --logger "trx;LogFileName=$TRX_FILE" \
        "--collect:XPlat Code Coverage" \
        --results-directory "$ORDINARY_RESULTS_DIR" \
        -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json,cobertura
else
    mkdir -p "$SUMMARY_DIR"
fi

# Fresh summaries must never absorb UUID directories or unknown reports left by
# an older collector layout. Dedicated lanes have already completed, so only
# the six named inputs are valid at this point.
while IFS= read -r -d '' candidate; do
    name="$(basename "$candidate")"
    keep=0
    for expected in "${EXPECTED_RESULT_LANES[@]}"; do
        if [[ "$name" == "$expected" ]]; then
            keep=1
            break
        fi
    done
    if [[ "$keep" == "0" ]]; then rm -rf "$candidate"; fi
done < <(find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)

for lane in "${EXPECTED_RESULT_LANES[@]}"; do
    laneDir="$RESULTS_DIR/$lane"
    cobertura_count=0
    json_count=0
    if [[ -d "$laneDir" ]]; then
        # VSTest copies collector attachments into a top-level _ser* transport
        # directory after the run. Remove only byte-identical copies; independent
        # or divergent reports remain visible to the exact-one fail-closed check.
        PruneVstestSerializedAttachmentCopies "$laneDir"
        cobertura_count="$(find "$laneDir" -type f -name 'coverage.cobertura.xml' | wc -l)"
        json_count="$(find "$laneDir" -type f -name 'coverage.json' | wc -l)"
    fi
    if [[ "$cobertura_count" != "1" || "$json_count" != "1" ]]; then
        printf '[coverage:backend] %s must contain exactly one Cobertura and one Coverlet JSON report (got cobertura=%s json=%s)\n' \
            "$lane" "$cobertura_count" "$json_count" >&2
        exit 1
    fi
done

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/coverage/summarize-cobertura.mjs" "$RESULTS_DIR" "$SUMMARY_FILE" backend-cobertura

printf '[coverage:backend] wrote %s\n' "$SUMMARY_FILE"
