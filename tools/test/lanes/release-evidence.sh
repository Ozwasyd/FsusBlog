#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/run-test-matrix.mjs" evidence-plan --out "$ROOT_DIR/.tmp/release-evidence/test-plan.json"
if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
  log "local bundle evidence is projected after physical bundle completion"
elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs" --require-plan
else
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs"
fi
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-evidence.mjs"
run "$ROOT_DIR/tools/operations/check-publish-artifact-slimness.mjs"
run "$ROOT_DIR/tools/operations/collect-release-evidence.sh"
run "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs"
if [[ -n "${FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS:-}" ]]; then
  # shellcheck disable=SC2086
  run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" $FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS
else
  run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs"
fi
