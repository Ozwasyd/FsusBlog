#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONSUMER_ID="${1:-${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID:-matrix-governance}}"
PROJECTION_DIR="${FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR:-.tmp/physical-execution-projections}"
DOCS_EVIDENCE_DIR="${FSUSBLOG_DOCS_EVIDENCE_DIR:-.tmp/docs}"
DOTNET_HOST_ENV_ARGS=()
if [[ "$CONSUMER_ID" == matrix-governance || "$CONSUMER_ID" == validate-matrix ]]; then
    DOTNET_HOST_ENV_ARGS=(--env FSUSBLOG_CONTENT_FIELD_DOTNET)
fi
if [[ "$CONSUMER_ID" == validate-matrix ]]; then
    DOTNET_HOST_ENV_ARGS+=(--env DOTNET_ROOT)
fi

exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
    --key matrix-governance \
    --execution-class correctness \
    --producer-id "$CONSUMER_ID" \
    --consumer "$CONSUMER_ID" \
    "${DOTNET_HOST_ENV_ARGS[@]}" \
    --cwd "$ROOT_DIR" \
    --projection-directory "$PROJECTION_DIR" \
    --path tests/matrix.yml \
    --path tests/coverage-registry.json \
    --path config/testing/runtime-state-domain-catalog.json \
    --path config/testing/runtime-state-domain-registry.json \
    --path config/testing/retry-policy-registry.json \
    --path config/testing/retry-disposition-registry.json \
    --path config/testing/correctness-attempt-producers.json \
    --path config/testing/clean-attempt-consumers.json \
    --path config/testing/semantic-outcome-clean-attempt-consumers.json \
    --path config/testing/outcome-failure-taxonomy.json \
    --path config/testing/outcome-field-dispositions.json \
    --path config/schemas/producer-semantic-outcome-candidate.schema.json \
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
    --path tools/test/run-matrix-governance-producer.mjs \
    --path tools/test/run-matrix-governance-once.sh \
    --path tools/test/run-deterministic-command.mjs \
    --path tools/test/attempt-provenance.mjs \
    --path tools/test/hidden-retry-scanner.mjs \
    --path tools/test/check-hidden-retries.mjs \
    --path tools/test/check-clean-attempt-consumers.mjs \
    --path tools/test/correctness-attempt-producers.mjs \
    --path tools/test/correctness-attempt-migration.mjs \
    --path tools/test/attempt-governance-acceptance.mjs \
    --path tools/test/generate-attempt-governance-acceptance.mjs \
    --path tools/test/verify-attempt-governance-acceptance.mjs \
    --path tools/test/generate-correctness-attempt-producers.mjs \
    --path tools/test/run-once.mjs \
    --path .github/workflows \
    --output "${FSUSBLOG_RELEASE_EVIDENCE_DIR:-.tmp/release-evidence}/test-plan.json" \
    --output .tmp/ci-plan.json \
    --output .tmp/gate-logs/preflight.json \
    --output "$DOCS_EVIDENCE_DIR/fast-backend-matrix.json" \
    --output "$DOCS_EVIDENCE_DIR/fast-frontend-unit-matrix.json" \
    --output "$DOCS_EVIDENCE_DIR/browser-contract-matrix.json" \
    --test-id matrix-validate \
    --test-id matrix-preflight \
    --test-id matrix-evidence-plan \
    -- bash -c 'node tools/test/check-hidden-retries.mjs && node tools/test/check-clean-attempt-consumers.mjs && node tools/test/generate-correctness-attempt-producers.mjs --check && node tools/test-matrix/runtime-state-domain-catalog.mjs && node tools/check-test-matrix.mjs && node tools/run-test-matrix.mjs ci-plan --format github-actions --out .tmp/ci-plan.json'
