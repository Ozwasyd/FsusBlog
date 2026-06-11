#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
FLOW="${1:-}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"

run_client() {
  (
    cd "$CLIENT_DIR"
    PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL" "$@"
  )
}

case "$FLOW" in
  admin-console)
    run_client npm run check:acceptance:console
    ;;
  auth-flow)
    run_client npm run check:acceptance:auth
    ;;
  authoring-flow)
    run_client npm run check:author-ai-assist
    run_client npx vitest run --config vitest.config.ts ../../tests/frontend/unit/view-contracts/markdownEditorWorkflow.test.ts ../../tests/frontend/unit/view-contracts/adminContentWorkflow.test.ts
    ;;
  private-preview)
    run_client npm run check:public-private-data-leakage
    run_client npx vitest run --config vitest.config.ts ../../tests/frontend/unit/view-contracts/adminConsistencyWorkflow.test.ts
    ;;
  error-boundary)
    run_client npm run check:result-boundaries
    run_client npx vitest run --config vitest.config.ts ../../tests/frontend/unit/view-contracts/userFacingWorkflow.test.ts
    ;;
  rbac-negative)
    run_client npm run check:security:permissions
    run_client npm run check:security:attack-matrix
    ;;
  *)
    printf '[release-runtime-flow] unknown flow: %s\n' "$FLOW" >&2
    exit 1
    ;;
esac
