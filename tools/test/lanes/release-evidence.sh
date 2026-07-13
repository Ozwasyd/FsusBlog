#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

check_job_summaries() {
  if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
    log "local bundle evidence is projected after physical bundle completion"
  elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs" --require-plan
  else
    run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs"
  fi
}

prepare_evidence_plan_and_check_jobs() {
  local -a failures=()
  local status

  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/run-test-matrix.mjs" evidence-plan --out "$ROOT_DIR/.tmp/release-evidence/test-plan.json"
  status=$?
  if (( status != 0 )); then
    failures+=("evidence-plan (exit $status)")
  fi

  check_job_summaries
  status=$?
  if (( status != 0 )); then
    failures+=("job-summaries (exit $status)")
  fi

  if (( ${#failures[@]} > 0 )); then
    printf '[lane] plan/job chain failed in %d command(s):\n' "${#failures[@]}" >&2
    printf '  - %s\n' "${failures[@]}" >&2
    return 1
  fi
}

check_flaky_evidence() {
  run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-evidence.mjs"
}

check_artifact_slimness() {
  run "$ROOT_DIR/tools/operations/check-publish-artifact-slimness.mjs"
}

check_evidence_metrics() {
  run "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs"
}

check_evidence_manifest() {
  if [[ -n "${FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS:-}" ]]; then
    # shellcheck disable=SC2086
    run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" $FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS
  else
    run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs"
  fi
}

run_collect_parallel release-evidence-precollect \
  plan-and-job-summaries prepare_evidence_plan_and_check_jobs \
  flaky-evidence check_flaky_evidence \
  artifact-slimness check_artifact_slimness
run_collect collect-evidence run "$ROOT_DIR/tools/operations/collect-release-evidence.sh"
run_collect_parallel release-evidence-postcollect \
  evidence-metrics check_evidence_metrics \
  evidence-manifest check_evidence_manifest
finish_collect
