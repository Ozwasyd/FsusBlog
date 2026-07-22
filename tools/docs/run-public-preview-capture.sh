#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
MODE="${1:-capture}"
[[ "$MODE" == "capture" || "$MODE" == "verify" ]] || {
    printf '[public-preview-capture] mode must be capture or verify\n' >&2
    exit 2
}

NAMESPACE="public-preview-docs-$$"
WORK_DIR="$ROOT_DIR/.tmp/public-preview-screenshots/$NAMESPACE"
STAGING_DIR="$WORK_DIR/staging"
LOCK_DIR="$ROOT_DIR/.tmp/locks/public-preview-docs.lock"
ENV_FILE="$ROOT_DIR/.tmp/env/$NAMESPACE.env"
SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"

Cleanup() {
    local status=$?
    node --input-type=module - "$ROOT_DIR" "$NAMESPACE" <<'NODE' || true
import { cleanupLocalRuntime } from './tools/test-matrix/local-runtime-cleanup.mjs'
const result = cleanupLocalRuntime({ root: process.argv[2], namespace: process.argv[3] })
if (result.cleanupStatus !== 'complete') {
    console.error(`[public-preview-capture] cleanup incomplete: ${JSON.stringify(result)}`)
    process.exitCode = 1
}
NODE
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if [[ "$MODE" == "verify" ]]; then
        rm -rf "$WORK_DIR"
    fi
    exit "$status"
}
trap Cleanup EXIT INT TERM

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '[public-preview-capture] another docs writer owns %s\n' "$LOCK_DIR" >&2
    exit 1
fi

mkdir -p "$STAGING_DIR"
FSUSBLOG_TEST_NAMESPACE="$NAMESPACE" \
FSUSBLOG_TEST_RUN_ID="$NAMESPACE" \
FSUSBLOG_FORCE_BOOTSTRAP=1 \
    "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"

while IFS='=' read -r key value; do
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        export "$key=$value"
    fi
done <"$ENV_FILE"

export FSUSBLOG_BASE_URL="$FSUSBLOG_DEBUG_BACKEND_URL"
export PLAYWRIGHT_BASE_URL="$FSUSBLOG_DEBUG_FRONTEND_URL"
export FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=1
export FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR="$STAGING_DIR"
export FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT=1
export FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT=1
export FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1
export FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS=1800000
export FSUSBLOG_PLAYWRIGHT_TRACE=off
export TZ=UTC
export LANG=C.UTF-8

npm --prefix "$ROOT_DIR/src/frontend" run capture:manual-layout-screenshots
node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" generate \
    --dir "$STAGING_DIR" \
    --source-commit "$SOURCE_COMMIT"
node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" check --dir "$STAGING_DIR"

if [[ "$MODE" == "capture" ]]; then
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" publish --dir "$STAGING_DIR"
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" sync
else
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" compare \
        --dir "$STAGING_DIR" \
        --evidence "$ROOT_DIR/.tmp/release-evidence/public-preview-screenshots.json"
fi

printf '[public-preview-capture] %s ok source=%s\n' "$MODE" "$SOURCE_COMMIT"
