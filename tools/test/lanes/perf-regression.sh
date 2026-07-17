#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

run_backend_perf_parallel() {
  # Compile/verify every Release reader before opening the native P99 window.
  # Governance remains parallel with that preparation, but the measurement
  # itself must not share CPU with compiler work inside this tier.
  export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release
  run_collect_parallel backend-perf-preparation \
    release-readiness run_backend_perf_release_readiness \
    governance run_backend_perf_governance_only
  finish_collect

  LANE_FAILURES=()
  run_collect native-p99 run_backend_perf_native_p99_only
  finish_collect
  write_backend_split_summary backend-perf native-p99-and-benchmark-project-release-build
}

run_backend_perf_release_readiness() {
  run_backend_perf_readiness_build_only || return $?
  ensure_backend_filtered_build
}

run_tier "backend-perf" run_backend_perf_parallel
