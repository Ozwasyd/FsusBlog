#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/run-test-matrix.mjs" evidence-plan --out .tmp/release-evidence/test-plan.json
run "$ROOT_DIR/tools/check-aeds-only-policy.sh"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-community-workflow.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-github-label-governance.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/docs/check-integrity-proof-docs.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/governance/check-dead-code-audit-index.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-background-service-classification.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-suite-convergence.mjs"
run_tier "static-governance" run_backend_test_governance_only
run "$ROOT_DIR/tools/check-gate-integrity.sh" --self-test
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-flaky-registry.mjs"
run "$ROOT_DIR/tools/check-test-matrix.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/run-test-matrix.mjs" validate
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-test-retention.mjs"
run "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/check-doc-implementation-drift.mjs"
run "${FSUSBLOG_NODE:-node}" --test \
  "$ROOT_DIR/tests/tools/release-manifest.test.mjs" \
  "$ROOT_DIR/tests/tools/deployment-slots.test.mjs" \
  "$ROOT_DIR/tests/tools/gateway-switch.test.mjs" \
  "$ROOT_DIR/tests/tools/dead-code-audit-index.test.mjs" \
  "$ROOT_DIR/tests/tools/online-schema-migration-wrapper.test.mjs" \
  "$ROOT_DIR/tests/tools/release-storage-lifecycle.test.mjs" \
  "$ROOT_DIR/tests/tools/security-source-analyzer.test.mjs" \
  "$ROOT_DIR/tests/tools/test-suite-convergence.test.mjs" \
  "$ROOT_DIR/tests/tools/release-rollout-state.test.mjs" \
  "$ROOT_DIR/tests/tools/release-worker-drill.test.mjs" \
  "$ROOT_DIR/tests/tools/release-worker-reconciliation.test.mjs" \
  "$ROOT_DIR/tests/tools/release-rollout-evidence.test.mjs" \
  "$ROOT_DIR/tests/tools/release-rollout-bundle.test.mjs" \
  "$ROOT_DIR/tests/tools/release-rollout-probes.test.mjs" \
  "$ROOT_DIR/tests/tools/release-traffic-probe-session.test.mjs" \
  "$ROOT_DIR/tests/tools/release-notification-probe.test.mjs" \
  "$ROOT_DIR/tests/tools/release-worker-observer-service.test.mjs" \
  "$ROOT_DIR/tests/tools/release-worker-normal-observer.test.mjs" \
  "$ROOT_DIR/tests/tools/release-migration-qualification.test.mjs" \
  "$ROOT_DIR/tests/tools/rehearsal-schema-qualification-probe.test.mjs" \
  "$ROOT_DIR/tests/tools/release-asset-compatibility-probe.test.mjs" \
  "$ROOT_DIR/tests/tools/zero-downtime-rehearsal.test.mjs"
