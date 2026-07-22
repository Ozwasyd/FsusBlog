#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
FLOW="${1:-}"
RELEASE_PREVIEW_URL="${FSUSBLOG_RELEASE_PREVIEW_URL:-http://127.0.0.1:8080}"

RunClient() {
    (
        cd "$CLIENT_DIR"
        PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL" "$@"
    )
}

case "$FLOW" in
    admin-console)
        RunClient npm run check:acceptance:console
        ;;
    auth-flow)
        RunClient npm run check:acceptance:auth
        ;;
    authoring-flow)
        RunClient npm run check:author-ai-assist
        RunClient node ../../tests/frontend/checks/static/check-markdown-editor-state-governance.mjs
        RunClient node ../../tests/frontend/checks/static/check-article-editor-workspace-governance.mjs
        RunClient npx vitest run --config vitest.config.ts ../../tests/frontend/unit/api/authoring.test.ts ../../tests/frontend/unit/composables/useAdminArticleWrite.localDraft.test.ts
        ;;
    private-preview)
        RunClient npm run check:public-private-data-leakage
        RunClient node ../../tests/frontend/checks/static/check-admin-task-feedback.mjs
        ;;
    error-boundary)
        RunClient npm run check:result-boundaries
        RunClient npx vitest run --config vitest.config.ts \
            ../../tests/frontend/unit/utils/appError.test.ts \
            ../../tests/frontend/unit/utils/errorKinds.test.ts \
            ../../tests/frontend/unit/utils/errors.test.ts
        ;;
    rbac-negative)
        RunClient npm run check:security:permissions
        RunClient npm run check:security:attack-matrix
        ;;
    *)
        printf '[release-runtime-flow] unknown flow: %s\n' "$FLOW" >&2
        exit 1
        ;;
esac
