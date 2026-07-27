#!/usr/bin/env bash
set -euo pipefail

ReleaseReliabilityLifecycleEnabled() {
    [[ -n "${FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT:-}" ]]
}

FinalizeReleaseReliabilityLifecycle() {
    local producerStatus=$?
    trap - EXIT
    set +e
    local lifecycleStatus=0
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/release-reliability-lifecycle.mjs" \
        finish-measurement --producer-status "$producerStatus" || lifecycleStatus=1
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/release-reliability-lifecycle.mjs" \
        phase --phase postcondition --producer-status "$producerStatus" || lifecycleStatus=1
    if [[ "$producerStatus" -eq 0 && "$lifecycleStatus" -ne 0 ]]; then
        producerStatus=1
    fi
    exit "$producerStatus"
}

InitializeReleaseReliabilityLifecycle() {
    if ! ReleaseReliabilityLifecycleEnabled; then
        return 0
    fi
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/release-reliability-lifecycle.mjs" \
        phase --phase precondition
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/release-reliability-lifecycle.mjs" \
        phase --phase reset
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/release-reliability-lifecycle.mjs" \
        start-measurement
    trap FinalizeReleaseReliabilityLifecycle EXIT
}
