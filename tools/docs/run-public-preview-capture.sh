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
mapfile -t SOURCE_STATE < <(node --input-type=module - "$ROOT_DIR" <<'NODE'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { snapshotGitWorktree } = await import(pathToFileURL(`${root}/tools/test-matrix/scheduler.mjs`).href)
const snapshot = await snapshotGitWorktree(root)
if (Object.keys(snapshot.entries).length > 0) {
    console.error(`[public-preview-capture] checkout must be clean: ${Object.keys(snapshot.entries).join(', ')}`)
    process.exit(1)
}
process.stdout.write(`${snapshot.fingerprint}\n`)
NODE
)
SOURCE_FINGERPRINT="${SOURCE_STATE[0]:-}"
[[ "$SOURCE_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] || {
    printf '[public-preview-capture] could not resolve a clean checkout fingerprint\n' >&2
    exit 1
}
for executable in vite vue-tsc playwright; do
    [[ -x "$ROOT_DIR/src/frontend/node_modules/.bin/$executable" ]] || {
        printf '[public-preview-capture] frontend toolchain is incomplete: node_modules/.bin/%s\n' "$executable" >&2
        exit 1
    }
done

Cleanup() {
    local status=$?
    local cleanupStatus=0
    if ! node --input-type=module - "$ROOT_DIR" "$NAMESPACE" <<'NODE'
import { cleanupLocalRuntime } from './tools/test-matrix/local-runtime-cleanup.mjs'
const result = cleanupLocalRuntime({ root: process.argv[2], namespace: process.argv[3] })
if (result.cleanupStatus !== 'complete') {
    console.error(`[public-preview-capture] cleanup incomplete: ${JSON.stringify(result)}`)
    process.exitCode = 1
}
NODE
    then
        cleanupStatus=1
    fi
    rmdir "$LOCK_DIR" 2>/dev/null || true
    rm -rf "$WORK_DIR"
    if ((status == 0 && cleanupStatus != 0)); then
        status="$cleanupStatus"
    fi
    trap - EXIT INT TERM
    exit "$status"
}

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '[public-preview-capture] another docs writer owns %s\n' "$LOCK_DIR" >&2
    exit 1
fi
trap Cleanup EXIT INT TERM

mkdir -p "$STAGING_DIR"
export FSUSBLOG_TEST_SOURCE_COMMIT="$SOURCE_COMMIT"
export FSUSBLOG_TEST_SOURCE_FINGERPRINT="$SOURCE_FINGERPRINT"
export FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1
export FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="$NAMESPACE"
export FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=1
export FSUSBLOG_PHYSICAL_BUNDLE_ID=standalone
export FSUSBLOG_STEP_ID=bootstrap
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
export FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR="$STAGING_DIR"
export FSUSBLOG_MANUAL_SCREENSHOT_DIR="$WORK_DIR/manual"
export FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT=1
export FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT=1
export FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1
export FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS=1800000
export FSUSBLOG_PLAYWRIGHT_TRACE=off
export TZ=UTC
export LANG=C.UTF-8

node "$ROOT_DIR/tools/docs/public-preview-runtime-identity.mjs" \
    --root "$ROOT_DIR" \
    --namespace "$NAMESPACE" \
    --source-commit "$SOURCE_COMMIT" \
    --source-fingerprint "$SOURCE_FINGERPRINT"

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
