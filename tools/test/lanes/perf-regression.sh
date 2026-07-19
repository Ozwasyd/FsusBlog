#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

RunBackendPerfParallel() {
    # Compile/verify every Release reader before opening the native P99 window.
    # Governance remains parallel with that preparation, but the measurement
    # itself must not share CPU with compiler work inside this tier.
    export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release
    RunCollectParallel backend-perf-preparation \
        release-readiness RunBackendPerfReleaseReadiness \
        governance RunBackendPerfGovernanceOnly
    FinishCollect

    LANE_FAILURES=()
    RunCollect native-p99 RunBackendPerfNativeP99Only
    FinishCollect
    WriteBackendSplitSummary backend-perf native-p99-and-benchmark-project-release-build
}

RunBackendPerfReleaseReadiness() {
    RunBackendPerfReadinessBuildOnly || return $?
    EnsureBackendFilteredBuild
}

RunTier "backend-perf" RunBackendPerfParallel
