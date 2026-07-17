#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONSUMER_ID="${1:-${FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID:-matrix-governance}}"

exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-deterministic-command.mjs" \
  --key matrix-governance \
  --consumer "$CONSUMER_ID" \
  --cwd "$ROOT_DIR" \
  --path tests/matrix.yml \
  --path tools/run-test-matrix.mjs \
  --path tools/check-test-matrix.mjs \
  --path .github/workflows \
  --output .tmp/release-evidence/test-plan.json \
  --output .tmp/docs/fast-backend-matrix.json \
  --output .tmp/docs/fast-frontend-unit-matrix.json \
  --output .tmp/docs/acceptance-playwright-matrix.json \
  --test-id matrix-validate \
  --test-id matrix-preflight \
  --test-id matrix-evidence-plan \
  -- node tools/check-test-matrix.mjs
