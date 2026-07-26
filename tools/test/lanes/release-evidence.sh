#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

CheckJobSummaries() {
    if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
        Log "local bundle evidence is projected after physical bundle completion"
    elif [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs" --require-plan
    else
        Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-job-summaries.mjs"
    fi
}

PrepareEvidencePlanAndCheckJobs() {
    local -a failures=()
    local status

    Run "$ROOT_DIR/tools/test/run-matrix-governance-once.sh" release-evidence-plan
    status=$?
    if ((status != 0)); then
        failures+=("evidence-plan (exit $status)")
    fi

    CheckJobSummaries
    status=$?
    if ((status != 0)); then
        failures+=("job-summaries (exit $status)")
    fi

    if ((${#failures[@]} > 0)); then
        printf '[lane] plan/job chain failed in %d command(s):\n' "${#failures[@]}" >&2
        printf '  - %s\n' "${failures[@]}" >&2
        return 1
    fi
}

CheckFlakyEvidence() {
    Run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-evidence.mjs"
}

CheckArtifactSlimness() {
    Run "$ROOT_DIR/tools/operations/check-publish-artifact-slimness.mjs"
}

CheckEvidenceMetrics() {
    Run "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs"
}

CheckEvidenceManifest() {
    if [[ -n "${FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS:-}" ]]; then
        # shellcheck disable=SC2086
        Run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" $FSUSBLOG_RELEASE_EVIDENCE_CHECK_ARGS
    else
        Run "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs"
    fi
}

RunCollectParallel release-evidence-precollect \
    plan-and-job-summaries PrepareEvidencePlanAndCheckJobs \
    flaky-evidence CheckFlakyEvidence \
    artifact-slimness CheckArtifactSlimness
RunCollect collect-evidence Run "$ROOT_DIR/tools/operations/collect-release-evidence.sh"
RunCollectParallel release-evidence-postcollect \
    evidence-metrics CheckEvidenceMetrics \
    evidence-manifest CheckEvidenceManifest
FinishCollect
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-release-domain-assertion-report.mjs" --producer release-evidence
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-release-domain-receipt.mjs" --producer release-evidence
