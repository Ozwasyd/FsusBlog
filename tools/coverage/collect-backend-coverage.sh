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

prune_vstest_serialized_attachment_copies() {
  local lane_dir="$1"
  local serialized_dir serialized_cobertura serialized_json primary_cobertura primary_json
  local -a serialized_cobertura_files serialized_json_files

  while IFS= read -r -d '' serialized_dir; do
    mapfile -d '' serialized_cobertura_files < <(find "$serialized_dir" -type f -name 'coverage.cobertura.xml' -print0)
    mapfile -d '' serialized_json_files < <(find "$serialized_dir" -type f -name 'coverage.json' -print0)
    if [[ "${#serialized_cobertura_files[@]}" != "1" || "${#serialized_json_files[@]}" != "1" ]]; then
      continue
    fi

    serialized_cobertura="${serialized_cobertura_files[0]}"
    serialized_json="${serialized_json_files[0]}"
    while IFS= read -r -d '' primary_cobertura; do
      if [[ "$primary_cobertura" == "$serialized_dir"/* ]]; then
        continue
      fi
      primary_json="$(dirname "$primary_cobertura")/coverage.json"
      if [[ -f "$primary_json" ]] &&
        cmp -s "$serialized_cobertura" "$primary_cobertura" &&
        cmp -s "$serialized_json" "$primary_json"; then
        rm -rf "$serialized_dir"
        break
      fi
    done < <(find "$lane_dir" -type f -name 'coverage.cobertura.xml' -print0)
  done < <(find "$lane_dir" -mindepth 1 -maxdepth 1 -type d -name '_ser*' -print0)
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
  ensure_backend_filtered_build
  configure_dotnet_test_processors
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
    if [[ "$name" == "$expected" ]]; then keep=1; break; fi
  done
  if [[ "$keep" == "0" ]]; then rm -rf "$candidate"; fi
done < <(find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)

for lane in "${EXPECTED_RESULT_LANES[@]}"; do
  lane_dir="$RESULTS_DIR/$lane"
  cobertura_count=0
  json_count=0
  if [[ -d "$lane_dir" ]]; then
    # VSTest copies collector attachments into a top-level _ser* transport
    # directory after the run. Remove only byte-identical copies; independent
    # or divergent reports remain visible to the exact-one fail-closed check.
    prune_vstest_serialized_attachment_copies "$lane_dir"
    cobertura_count="$(find "$lane_dir" -type f -name 'coverage.cobertura.xml' | wc -l)"
    json_count="$(find "$lane_dir" -type f -name 'coverage.json' | wc -l)"
  fi
  if [[ "$cobertura_count" != "1" || "$json_count" != "1" ]]; then
    printf '[coverage:backend] %s must contain exactly one Cobertura and one Coverlet JSON report (got cobertura=%s json=%s)\n' \
      "$lane" "$cobertura_count" "$json_count" >&2
    exit 1
  fi
done

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/coverage/summarize-cobertura.mjs" "$RESULTS_DIR" "$SUMMARY_FILE" backend-cobertura

printf '[coverage:backend] wrote %s\n' "$SUMMARY_FILE"
