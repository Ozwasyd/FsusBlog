#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
MODE="${1:-capture}"
[[ "$MODE" == "capture" || "$MODE" == "verify" || "$MODE" == "quality-smoke" || "$MODE" == "manual" ]] || {
    printf '[public-preview-capture] mode must be capture, verify, quality-smoke, or manual\n' >&2
    exit 2
}

NAMESPACE="public-preview-docs-$$"
WORK_DIR="$ROOT_DIR/.tmp/public-preview-screenshots/$NAMESPACE"
STAGING_DIR="$WORK_DIR/staging"
QUALITY_STAGING_FILE="$WORK_DIR/public-preview-quality.json"
LOCK_DIR="$ROOT_DIR/.tmp/locks/public-preview-docs.lock"
LOCK_TOOL="$ROOT_DIR/tools/docs/public-preview-writer-transaction.mjs"
ENV_FILE="$ROOT_DIR/.tmp/env/$NAMESPACE.env"
SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
SOURCE_FINGERPRINT="$(node --input-type=module - "$ROOT_DIR" "$MODE" <<'NODE'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { snapshotGitWorktree } = await import(pathToFileURL(`${root}/tools/test-matrix/scheduler.mjs`).href)
const snapshot = await snapshotGitWorktree(root)
if (process.argv[3] !== 'manual' && Object.keys(snapshot.entries).length > 0) {
    console.error(`[public-preview-capture] checkout must be clean: ${Object.keys(snapshot.entries).join(', ')}`)
    process.exit(1)
}
process.stdout.write(`${snapshot.fingerprint}\n`)
NODE
)"
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
    if ! node "$LOCK_TOOL" release-lock "$LOCK_DIR" "$NAMESPACE" "$$"; then
        cleanupStatus=1
    fi
    rm -rf "$WORK_DIR"
    if ((status == 0 && cleanupStatus != 0)); then
        status="$cleanupStatus"
    fi
    trap - EXIT INT TERM
    exit "$status"
}

mkdir -p "$(dirname "$LOCK_DIR")"
if ! node "$LOCK_TOOL" acquire-lock "$LOCK_DIR" "$NAMESPACE" "$$"; then
    exit 1
fi
trap Cleanup EXIT INT TERM

mkdir -p "$STAGING_DIR"
export FSUSBLOG_TEST_SOURCE_COMMIT="$SOURCE_COMMIT"
export FSUSBLOG_TEST_SOURCE_FINGERPRINT="$SOURCE_FINGERPRINT"
export FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME=1
export FSUSBLOG_BROWSER_CONTRACT_PREPARATION_ID="$NAMESPACE"
if [[ "$MODE" == "manual" ]]; then
    export FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=0
else
    export FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE=1
fi
export FSUSBLOG_PUBLIC_PREVIEW_WRITER_NAMESPACE="$NAMESPACE"
export FSUSBLOG_PUBLIC_PREVIEW_WRITER_PID="$$"
export FSUSBLOG_REPOSITORY_ROOT="$ROOT_DIR"
export FSUSBLOG_PLAYWRIGHT_MANAGED_ONLY=1
export FSUSBLOG_PHYSICAL_BUNDLE_ID=standalone
while IFS= read -r assignment; do
    [[ -n "$assignment" ]] && export "$assignment"
done < <(node --input-type=module - "$ROOT_DIR" <<'NODE'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { loadTestMatrix } = await import(pathToFileURL(`${root}/tools/test-matrix/command-groups.mjs`).href)
const {
    applySealedFixtureProfileEnvironment,
    sealMatrixFixtureProfile
} = await import(pathToFileURL(`${root}/tools/testing/fixture-catalog.mjs`).href)
const bootstrap = loadTestMatrix(root).tiers.find((tier) => tier.id === 'bootstrap')
if (!bootstrap) {
    console.error('[public-preview-capture] canonical bootstrap tier is missing')
    process.exit(1)
}
const environment = applySealedFixtureProfileEnvironment(
    {},
    sealMatrixFixtureProfile(bootstrap)
)
for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    process.stdout.write(`${key}=${value}\n`)
}
NODE
)
# The canonical bootstrap materializes the current schema from the candidate
# assembly inside the production build layout. Screenshot capture runs the
# release runtime (the preview readers target the immutable release preview),
# so import the canonical production layout assignments and build the Release
# server into that layout through the shared build producer before bootstrap,
# matching the qualified release-reliability/homogeneous-two-node flow.
while IFS= read -r -d '' assignment; do
    export "$assignment"
done < <(FSUSBLOG_TEST_RUN_ID="$NAMESPACE" \
    node "$ROOT_DIR/tools/test/export-production-build-environment.mjs" \
    --root "$ROOT_DIR" \
    --run-id "$NAMESPACE")
# The pinned wasm toolchain only builds inside the emsdk container, and the
# release bundle producer needs the receipt-bound envelope inside this run's
# production layout. Stage the container-built envelope through the same
# transport the production-build-artifacts lane uses; ensure:wasm then
# verifies it as receipt-bound instead of rebuilding on the host.
mkdir -p "$(dirname "${FSUSBLOG_FRONTEND_WASM_ROOT:?frontend wasm root is required}")"
# Re-seal the container-built manifest against this run's source identity so
# the receipt fingerprint matches the snapshot env that every later wasm
# check (staging, ensure, verify) validates with.
(
    cd "$ROOT_DIR/src/frontend" || exit 1
    # Re-seal the canonical public/wasm artifact dir, not the run layout root.
    env -u FSUSBLOG_FRONTEND_WASM_ROOT \
        FSUSBLOG_WASM_TOOLCHAIN_EMSCRIPTEN=6.0.0 \
        FSUSBLOG_WASM_TOOLCHAIN_BINARYEN=123 \
        FSUSBLOG_WASM_TOOLCHAIN_CMAKE=4.3.3 \
        FSUSBLOG_WASM_TOOLCHAIN_VCPKG=eae1680538b86f962455c27abca2aad0dc304a4d \
        FSUSBLOG_WASM_TOOLCHAIN_EMSDK_IMAGE="emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8" \
        node ../../tools/frontend/ensure-wasm.mjs write-manifest >/dev/null
)
# macOS background metadata (provenance/Gatekeeper) bumps the ctime of
# freshly renamed files once, a second or two after reseal, which trips the
# staging tamper check on the first attempt; retry after the metadata
# settles. stage-envelope cleans its destination on failure.
wasmStaged=0
for attempt in 1 2 3; do
    if node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope \
        --root "$ROOT_DIR" \
        --client-root "$ROOT_DIR/src/frontend" \
        --artifact-dir "$ROOT_DIR/src/frontend/public/wasm" \
        --destination-artifact-dir "$FSUSBLOG_FRONTEND_WASM_ROOT" >/dev/null
    then
        wasmStaged=1
        break
    fi
    sleep 2
done
if [[ "$wasmStaged" != "1" ]]; then
    echo "[public-preview-capture] wasm envelope staging kept failing (source artifact identity churn)" >&2
    exit 1
fi
FSUSBLOG_RUNTIME_CONFIGURATION=Release
FSUSBLOG_RUNTIME_NO_BUILD=1
export FSUSBLOG_RUNTIME_CONFIGURATION FSUSBLOG_RUNTIME_NO_BUILD
"$ROOT_DIR/tools/build-with-data-env.sh" dotnet build \
    "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
    --configuration Release \
    -p:FsusBlogCommitSha="$SOURCE_COMMIT"
FSUSBLOG_TEST_NAMESPACE="$NAMESPACE" \
FSUSBLOG_TEST_RUN_ID="$NAMESPACE" \
FSUSBLOG_FORCE_BOOTSTRAP=1 \
    "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"

while IFS='=' read -r key value; do
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        export "$key=$value"
    fi
done <"$ENV_FILE"

FSUSBLOG_STEP_ID=release-public-hydration \
    "$ROOT_DIR/tools/test/lanes/release-public-hydration.sh"

# The lane warm settles the default unscoped zh-CN generation. Playwright
# correctness readers (#2645) forbid a retryable cold 503 on the first browser
# navigation, and each context reads the AOT cache through its own key space:
# the temporal context UI locale (Accept-Language) and the worker test-session
# cache scope (X-Fsus-Test-Session). Warm that exact key space from the same
# manifest so the browser's first attempt is a cache hit.
if [[ -n "${FSUSBLOG_TEMPORAL_CONTEXT_FILE:-}" && -f "${FSUSBLOG_TEMPORAL_CONTEXT_FILE:-}" ]]; then
    browserUiLocale="$(node -e 'const context = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(context.uiLocale || "zh-CN"))' "$FSUSBLOG_TEMPORAL_CONTEXT_FILE")"
else
    browserUiLocale="zh-CN"
fi
browserTestSession="$(node --input-type=module -e "const { resolveWorkerTestSession } = await import('file://${ROOT_DIR}/tests/frontend/support/test-session.mjs'); process.stdout.write(resolveWorkerTestSession('0'))")"
FSUSBLOG_BASE_URL="${FSUSBLOG_DEBUG_BACKEND_URL:?debug backend url is required}" \
FSUSBLOG_PUBLIC_AOT_WAIT_MS=120000 \
FSUSBLOG_PUBLIC_AOT_WARM_ACCEPT_LANGUAGE="$browserUiLocale" \
FSUSBLOG_PUBLIC_AOT_WARM_TEST_SESSION="$browserTestSession" \
FSUSBLOG_PUBLIC_AOT_WARM_REPORT="$WORK_DIR/browser-keyspace-warm-evidence.json" \
FSUSBLOG_SYNC_PUBLIC_AOT_SIDECARS_TO_DIST=0 \
    node "$ROOT_DIR/tools/frontend/warm-public-aot-cache.mjs"

export FSUSBLOG_BASE_URL="$FSUSBLOG_RELEASE_PREVIEW_URL"
export FSUSBLOG_PUBLIC_BASE_URL="$FSUSBLOG_RELEASE_PREVIEW_URL"
export PLAYWRIGHT_BASE_URL="$FSUSBLOG_RELEASE_PREVIEW_URL"
export FSUSBLOG_PUBLIC_PREVIEW_STAGING_DIR="$STAGING_DIR"
if [[ "$MODE" != "manual" ]]; then
    export FSUSBLOG_MANUAL_SCREENSHOT_DIR="$WORK_DIR/manual"
fi
if [[ "$MODE" == "quality-smoke" ]]; then
    export FSUSBLOG_PUBLIC_PREVIEW_QUALITY_ONLY=1
    export FSUSBLOG_PUBLIC_PREVIEW_QUALITY_TIER=quick
fi
export FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT=1
export FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT=1
export FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1
export FSUSBLOG_PLAYWRIGHT_TEST_TIMEOUT_MS=1800000
export FSUSBLOG_PLAYWRIGHT_TRACE=off
export FSUSBLOG_TEST_SESSION_ISOLATION=1
export TZ=UTC
export LANG=C.UTF-8

node "$ROOT_DIR/tools/docs/public-preview-runtime-identity.mjs" \
    --root "$ROOT_DIR" \
    --namespace "$NAMESPACE" \
    --source-commit "$SOURCE_COMMIT" \
    --source-fingerprint "$SOURCE_FINGERPRINT"

if [[ "$MODE" != "quality-smoke" ]]; then
    npm --prefix "$ROOT_DIR/src/frontend" run verify:wasm
    env -u NO_COLOR \
        NODE_PATH="$ROOT_DIR/src/frontend/node_modules" \
        FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 \
        FSUSBLOG_PLAYWRIGHT_SERIAL_REASON=shared-screenshot-baseline-writer \
        "$ROOT_DIR/src/frontend/node_modules/.bin/playwright" test \
        --config "$ROOT_DIR/src/frontend/playwright.config.ts" \
        --workers=1 \
        "$ROOT_DIR/tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts"
fi
if [[ "$MODE" == "manual" ]]; then
    printf '[public-preview-capture] manual ok source=%s fingerprint=%s\n' "$SOURCE_COMMIT" "$SOURCE_FINGERPRINT"
    exit 0
fi
env -u NO_COLOR \
    NODE_PATH="$ROOT_DIR/src/frontend/node_modules" \
    FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1 \
    FSUSBLOG_PLAYWRIGHT_SERIAL_REASON=public-preview-quality-single-writer \
    "$ROOT_DIR/src/frontend/node_modules/.bin/playwright" test \
    --config "$ROOT_DIR/src/frontend/playwright.config.ts" \
    --workers=1 \
    "$ROOT_DIR/tests/frontend/e2e/manual/public-preview-quality-capture.spec.ts"
if [[ "$MODE" == "quality-smoke" ]]; then
    printf '[public-preview-capture] quality-smoke ok source=%s\n' "$SOURCE_COMMIT"
    exit 0
fi
node "$ROOT_DIR/tools/docs/public-preview-quality-publication.mjs" generate \
    --capture-dir "$STAGING_DIR" \
    --file "$QUALITY_STAGING_FILE" \
    --source-commit "$SOURCE_COMMIT"
node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" generate \
    --dir "$STAGING_DIR" \
    --source-commit "$SOURCE_COMMIT"
node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" check --dir "$STAGING_DIR"
node "$ROOT_DIR/tools/docs/public-preview-quality-publication.mjs" check --file "$QUALITY_STAGING_FILE"

if [[ "$MODE" == "capture" ]]; then
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" publish --dir "$STAGING_DIR"
    node "$ROOT_DIR/tools/docs/public-preview-quality-publication.mjs" publish --file "$QUALITY_STAGING_FILE"
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" sync
else
    node "$ROOT_DIR/tools/docs/public-preview-screenshots.mjs" compare \
        --dir "$STAGING_DIR" \
        --evidence "$ROOT_DIR/.tmp/release-evidence/public-preview-screenshots.json"
    node "$ROOT_DIR/tools/docs/public-preview-quality-publication.mjs" compare \
        --file "$QUALITY_STAGING_FILE" \
        --committed-file "$ROOT_DIR/docs/assets/visual-evidence/public-preview-quality.json" \
        --evidence "$ROOT_DIR/.tmp/release-evidence/public-preview-screenshots.json"
fi

printf '[public-preview-capture] %s ok source=%s\n' "$MODE" "$SOURCE_COMMIT"
