#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONSUMER_ID="${1:-${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID:-matrix-governance}}"

exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
    --key matrix-governance \
    --execution-class correctness \
    --producer-id "$CONSUMER_ID" \
    --consumer "$CONSUMER_ID" \
    --cwd "$ROOT_DIR" \
    --projection-directory .tmp/physical-execution-projections \
    --path tests/matrix.yml \
    --path tests/coverage-registry.json \
    --path config/testing/runtime-state-domain-catalog.json \
    --path config/testing/runtime-state-domain-registry.json \
    --path config/schemas/runtime-state-domain-catalog.schema.json \
    --path config/schemas/runtime-state-domain-registry.schema.json \
    --path tests/tools \
    --path tests/frontend \
    --path src/frontend/package.json \
    --path tools/bootstrap-acceptance-env.sh \
    --path tools/security \
    --path tools/run-test-matrix.mjs \
    --path tools/check-test-matrix.mjs \
    --path tools/check-workflow-matrix-sync.mjs \
    --path tools/docs/generate-testing-docs.mjs \
    --path tools/test-matrix \
    --path tools/test/bundles \
    --path tools/test/lanes \
    --path tools/test/run-matrix-governance-once.sh \
    --path tools/test/run-deterministic-command.mjs \
    --path tools/test/run-once.mjs \
    --path .github/workflows \
    --output .tmp/release-evidence/test-plan.json \
    --output .tmp/docs/fast-backend-matrix.json \
    --output .tmp/docs/fast-frontend-unit-matrix.json \
    --output .tmp/docs/browser-contract-matrix.json \
    --test-id matrix-validate \
    --test-id matrix-preflight \
    --test-id matrix-evidence-plan \
    -- bash -c 'node tools/test-matrix/runtime-state-domain-catalog.mjs && node tools/check-test-matrix.mjs'
