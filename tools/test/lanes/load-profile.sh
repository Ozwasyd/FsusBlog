#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${1:-baseline}"
PERFORMANCE_ROOT="${FSUSBLOG_PERFORMANCE_OUTPUT_ROOT:-$ROOT_DIR/.tmp/perf}"
OUT_DIR="$PERFORMANCE_ROOT/load-$PROFILE"
mkdir -p "$OUT_DIR"

set +e
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" load-profile "$PROFILE" "$OUT_DIR/summary.json"
probe_status=$?
set -e

if [[ ! -f "$OUT_DIR/summary.json" ]]; then
    exit "$probe_status"
fi

RELEASE_SUMMARY_DIR="$PERFORMANCE_ROOT/release-summaries"
mkdir -p "$RELEASE_SUMMARY_DIR"
jq -n \
    --arg profile "$PROFILE" \
    --arg file "$(realpath --relative-to="$ROOT_DIR" "$OUT_DIR/summary.json")" \
    --slurpfile summary "$OUT_DIR/summary.json" \
    '{status:$summary[0].status, profile:$profile, summary:$file, policy:$summary[0].policy, declared:$summary[0].declared, effective:$summary[0].effective, thresholds:$summary[0].thresholds, thresholdEvaluation:$summary[0].thresholdEvaluation, overrideSource:$summary[0].overrideSource, overrideSources:$summary[0].overrideSources, metrics:$summary[0].metrics, generatedAt: now | todate}' \
    >"$RELEASE_SUMMARY_DIR/load-$PROFILE.json"
printf '[load-profile] wrote %s\n' "$OUT_DIR/summary.json"
exit "$probe_status"
