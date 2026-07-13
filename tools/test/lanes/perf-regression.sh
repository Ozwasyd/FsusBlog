#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

run_backend_perf_parallel() {
  # The production bundle only verifies the already-published Release build, so
  # its read-only readiness and governance checks may share the native window.
  # A standalone lane that still compiles keeps that compiler work after P99.
  if [[ "${FSUSBLOG_BACKEND_PERF_READINESS_MODE:-build}" == "verify-fresh" ]]; then
    # The backend physical bundle publishes the run-bound Release test and
    # benchmark assemblies. Keep the P99 test on that exact configuration so a
    # clean production run cannot trigger an unplanned duplicate Debug build.
    export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Release
    run_collect_parallel backend-perf-native-readiness \
      native-p99 run_backend_perf_native_p99_only \
      readiness-verify run_backend_perf_readiness_build_only \
      governance run_backend_perf_governance_only
  else
    run_collect_parallel backend-perf-native-governance \
      native-p99 run_backend_perf_native_p99_only \
      governance run_backend_perf_governance_only
    run_collect readiness-build run_backend_perf_readiness_build_only
  fi
  finish_collect
  write_backend_split_summary backend-perf native-p99-and-benchmark-project-release-build
}

run_tier "backend-perf" run_backend_perf_parallel
