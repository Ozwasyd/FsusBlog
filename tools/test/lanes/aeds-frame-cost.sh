#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}/aeds-frame-cost"
RAW_SUMMARY_FILE="$OUT_DIR/raw-summary.json"
SUMMARY_FILE="$OUT_DIR/summary.json"
RELEASE_EVIDENCE_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"
RELEASE_SUMMARY="$RELEASE_EVIDENCE_DIR/aeds-frame-cost-summary.json"
POLICY_FILE="$ROOT_DIR/tests/performance/perf-policy.yml"

mkdir -p "$OUT_DIR" "$(dirname "$RELEASE_SUMMARY")"
rm -f "$RAW_SUMMARY_FILE" "$SUMMARY_FILE" "$RELEASE_SUMMARY"

CURRENT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
SOURCE_COMMIT="${FSUSBLOG_TEST_SOURCE_COMMIT:-${FSUSBLOG_EVIDENCE_COMMIT_SHA:-${GITHUB_SHA:-$CURRENT_COMMIT}}}"
if [[ "$SOURCE_COMMIT" != "$CURRENT_COMMIT" ]]; then
    printf '[aeds-frame-cost] source commit %s does not match HEAD %s\n' "$SOURCE_COMMIT" "$CURRENT_COMMIT" >&2
    exit 1
fi

authority_args=()
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)" ]]; then
    authority_args+=(--authority-blocked-reason tracked-worktree-dirty)
fi

"$ROOT_DIR/tools/test/ensure-benchmark-release-build.sh"

dotnet run \
    --project "$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj" \
    -c Release \
    --no-build \
    --no-restore \
    -- \
    --aeds-frame-cost \
    --out "$RAW_SUMMARY_FILE" \
    --commit-sha "$SOURCE_COMMIT" \
    --repo-root "$ROOT_DIR" \
    "${authority_args[@]}" \
    "$@"

node "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs" \
    --finalize-aeds-frame-cost "$RAW_SUMMARY_FILE" "$SUMMARY_FILE" \
    --policy "$POLICY_FILE" \
    --expected-commit "$SOURCE_COMMIT"

node "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs" \
    --validate-aeds-frame-cost "$SUMMARY_FILE" \
    --policy "$POLICY_FILE" \
    --expected-commit "$SOURCE_COMMIT"

cp "$SUMMARY_FILE" "$RELEASE_SUMMARY"

# Keep correctness/performance evidence in this ordinary lane browserless.
# Real engine selection, fallback, long-task and copy evidence belongs to the
# independently scheduled browser diagnostics catalog.
node "$ROOT_DIR/tests/frontend/checks/perf/check-aeds-decode-budget.mjs"

echo "[aeds-frame-cost] wrote $SUMMARY_FILE and $RELEASE_SUMMARY"
