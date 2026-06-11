#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
run "$ROOT_DIR/tools/check-aeds-only-policy.sh"
run_tier "static-governance" run_backend_test_governance_only
run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"
run "$ROOT_DIR/tools/check-test-matrix.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/run-test-matrix.mjs" validate
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-doc-implementation-drift.mjs"
