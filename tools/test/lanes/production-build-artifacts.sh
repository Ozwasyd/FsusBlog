#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_ROOT="${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-$ROOT_DIR/.tmp/ci-production-build}"
PAYLOAD_ROOT="$ARTIFACT_ROOT/payload"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
REQUESTED_DOMAINS="${FSUSBLOG_CI_PRODUCTION_BUILD_DOMAINS:-backend-runtime,test-runtime,frontend-dist,ssr-runtime,wasm,generated-contracts}"
REUSE_BUILD_OUTPUTS="${FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS:-0}"
PRODUCER_RUN_ID="${GITHUB_RUN_ID:-${FSUSBLOG_TEST_RUN_ID:?FSUSBLOG_TEST_RUN_ID is required outside GitHub Actions}}"
PRODUCER_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
PRODUCER_WORKFLOW="${GITHUB_WORKFLOW:-Local production}"
PRODUCER_JOB="${GITHUB_JOB:-production-build-artifacts}"
export FSUSBLOG_ZK_PRODUCTION_ENABLED="${FSUSBLOG_ZK_PRODUCTION_ENABLED:-0}"
IFS=',' read -r -a DOMAIN_LIST <<<"$REQUESTED_DOMAINS"
_ssr_declared=0
for domain in "${DOMAIN_LIST[@]}"; do
    if [[ "$domain" == "ssr-runtime" ]]; then _ssr_declared=1; fi
done
for domain in "${DOMAIN_LIST[@]}"; do
    if [[ "$domain" == "frontend-dist" && "$_ssr_declared" == "0" ]]; then DOMAIN_LIST+=(ssr-runtime); fi
done

node --test \
    "$ROOT_DIR/tests/tools/wasm-artifact-ownership.test.mjs" \
    "$ROOT_DIR/tests/tools/wasm-build-receipt.test.mjs"
node --test \
    "$ROOT_DIR/tests/tools/production-build-artifacts.test.mjs" \
    "$ROOT_DIR/tests/tools/production-build-materialization-benchmark.test.mjs"
node "$ROOT_DIR/tools/check-wasm-artifact-ownership.mjs"
node "$ROOT_DIR/tools/security/comment-privacy-build-contract.mjs" --check

case "$REUSE_BUILD_OUTPUTS" in
    0 | 1) ;;
    *)
        printf '[production-build-artifacts] FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS must be 0 or 1\n' >&2
        exit 1
        ;;
esac

if [[ "$REUSE_BUILD_OUTPUTS" == "1" &&
    -n "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" &&
    "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" == "build-static" &&
    "${FSUSBLOG_STEP_ID:-}" == "production-build-artifacts" ]]; then
    node "$ROOT_DIR/tools/test-matrix/content-addressed-build-cache.mjs" wait-summary
fi

PublishBuildCacheEvidenceIfFresh() {
    if [[ -n "${FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT:-}" ]]; then
        node "$ROOT_DIR/tools/test-matrix/content-addressed-build-cache.mjs" publish-summary
    fi
}

HasDomain() {
    local expected="$1"
    local domain
    for domain in "${DOMAIN_LIST[@]}"; do
        if [[ "$domain" == "$expected" ]]; then
            return 0
        fi
    done
    return 1
}

if ((${#DOMAIN_LIST[@]} == 0)); then
    printf '[production-build-artifacts] at least one smart-gate artifact domain is required\n' >&2
    exit 1
fi
for domain in "${DOMAIN_LIST[@]}"; do
    case "$domain" in
        backend-runtime | test-runtime | frontend-dist | ssr-runtime | wasm | generated-contracts) ;;
        *)
            printf '[production-build-artifacts] unknown smart-gate artifact domain: %s\n' "$domain" >&2
            exit 1
            ;;
    esac
done

if [[ -f "$ARTIFACT_ROOT/receipt.json" ]]; then
    node "$ROOT_DIR/tools/ci/production-build-artifacts-cli.mjs" verify \
        --root "$ROOT_DIR" \
        --artifact-root "$ARTIFACT_ROOT" \
        --expected-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required}" \
        --expected-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required}" \
        --expected-workflow "$PRODUCER_WORKFLOW" \
        --expected-run-id "$PRODUCER_RUN_ID" \
        --expected-run-attempt "$PRODUCER_RUN_ATTEMPT" \
        --expected-job "$PRODUCER_JOB" \
        --expected-current-toolchain true \
        --expected-input-root "$ROOT_DIR" >/dev/null
    node - "$ARTIFACT_ROOT/receipt.json" "$REQUESTED_DOMAINS" <<'NODE'
const fs = require('node:fs')
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const expected = process.argv[3].split(',').filter(Boolean).sort()
const actual = receipt.domains.map(domain => domain.name).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`sealed artifact domains do not match resume request: actual=${actual.join(',')} expected=${expected.join(',')}`)
}
NODE
    PublishBuildCacheEvidenceIfFresh
    printf '[production-build-artifacts] resumed sealed immutable artifact receipt=%s\n' "$ARTIFACT_ROOT/receipt.json"
    exit 0
fi
if [[ -e "$ARTIFACT_ROOT" || -L "$ARTIFACT_ROOT" ]]; then
    printf '[production-build-artifacts] refusing incomplete or unreceipted artifact root: %s\n' "$ARTIFACT_ROOT" >&2
    exit 1
fi

RequireFile() {
    if [[ ! -f "$1" ]]; then
        printf '[production-build-artifacts] required build output is missing: %s\n' "$1" >&2
        exit 1
    fi
}

AdoptDirectory() {
    local source="$1"
    local destination="$2"
    if [[ ! -d "$source" ]]; then
        printf '[production-build-artifacts] required build directory is missing: %s\n' "$source" >&2
        exit 1
    fi
    if [[ -e "$destination" || -L "$destination" ]]; then
        printf '[production-build-artifacts] immutable domain destination already exists: %s\n' "$destination" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$destination")"
    if [[ "$(stat -c %d "$source")" != "$(stat -c %d "$(dirname "$destination")")" ]]; then
        printf '[production-build-artifacts] seal-in-place requires source and immutable domain on one filesystem: %s -> %s\n' "$source" "$destination" >&2
        exit 1
    fi
    mv -- "$source" "$destination"
    mkdir -p "$(dirname "$source")"
    if ! ln -s -- "$destination" "$source"; then
        mv -- "$destination" "$source"
        return 1
    fi
}

mkdir -p "$PAYLOAD_ROOT"

if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && { HasDomain backend-runtime || HasDomain test-runtime; }; then
    "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$ROOT_DIR/tools/build-with-data-env.sh" dotnet restore "$ROOT_DIR/FsusBlog.slnx" -v minimal /p:NuGetAudit=false
    "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
        -c Release --no-restore --no-incremental -warnaserror -v minimal /p:NuGetAudit=false \
        -p:FsusBlogCommitSha="${FSUSBLOG_TEST_SOURCE_COMMIT:?production build source commit is required}"
fi
if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && HasDomain test-runtime; then
    "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/src/migration/FsusBlog.Migration.csproj" \
        -c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal /p:NuGetAudit=false \
        -p:FsusBlogCommitSha="${FSUSBLOG_TEST_SOURCE_COMMIT:?production build source commit is required}"
    "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
        -c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal /p:NuGetAudit=false
fi
if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && HasDomain frontend-dist; then
    FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm --prefix "$ROOT_DIR/src/frontend" run build:release
elif [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && HasDomain wasm; then
    npm --prefix "$ROOT_DIR/src/frontend" run ensure:wasm
fi

if HasDomain backend-runtime; then
    RequireFile "${FSUSBLOG_BACKEND_SERVER_DLL:?FSUSBLOG_BACKEND_SERVER_DLL is required}"
    AdoptDirectory "$(dirname "$FSUSBLOG_BACKEND_SERVER_DLL")" "$PAYLOAD_ROOT/backend-runtime"
fi
if HasDomain test-runtime; then
    RequireFile "${FSUSBLOG_BACKEND_TEST_DLL:?FSUSBLOG_BACKEND_TEST_DLL is required}"
    AdoptDirectory "$(dirname "$FSUSBLOG_BACKEND_TEST_DLL")" "$PAYLOAD_ROOT/test-runtime"
fi
if HasDomain frontend-dist; then
    AdoptDirectory "${FSUSBLOG_FRONTEND_DIST_ROOT:?FSUSBLOG_FRONTEND_DIST_ROOT is required}" "$PAYLOAD_ROOT/frontend-dist"
    node "$ROOT_DIR/tools/docker/ssr-runtime-closure.mjs" materialize \
        --client-root "$ROOT_DIR/src/frontend" \
        --dist "$PAYLOAD_ROOT/frontend-dist" \
        --inventory "$ROOT_DIR/config/build/ssr-runtime-inputs.json" \
        --output "$PAYLOAD_ROOT/ssr-runtime"
fi
if HasDomain wasm; then
    WASM_SOURCE="${FSUSBLOG_FRONTEND_WASM_ROOT:-$ROOT_DIR/src/frontend/public/wasm}"
    node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope \
        --root "$ROOT_DIR" \
        --client-root "$ROOT_DIR/src/frontend" \
        --artifact-dir "$WASM_SOURCE" \
        --destination-artifact-dir "$PAYLOAD_ROOT/wasm"
    node "$ROOT_DIR/tools/check-wasm-artifact-ownership.mjs"
fi
if HasDomain generated-contracts; then
    mkdir -p "$PAYLOAD_ROOT/generated-contracts"
    cp "$ROOT_DIR/src/shared/Contracts/Validation/fsusblog.openapi.json" "$PAYLOAD_ROOT/generated-contracts/"
    cp "$ROOT_DIR/src/frontend/src/generated/fsusBinaryRoutes.ts" "$PAYLOAD_ROOT/generated-contracts/"
    cp "$ROOT_DIR/tests/frontend/fixtures/cross-stack-contract-matrix.json" "$PAYLOAD_ROOT/generated-contracts/"
fi

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FINISHED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
DURATION_MS="$((FINISHED_AT_MS - STARTED_AT_MS))"

CREATE_ARGS=(
    create
    --root "$ROOT_DIR"
    --artifact-root "$ARTIFACT_ROOT"
    --source-commit "${FSUSBLOG_TEST_SOURCE_COMMIT:?FSUSBLOG_TEST_SOURCE_COMMIT is required}"
    --source-fingerprint "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:?FSUSBLOG_TEST_SOURCE_FINGERPRINT is required}"
    --run-id "$PRODUCER_RUN_ID"
    --run-attempt "$PRODUCER_RUN_ATTEMPT"
    --workflow "$PRODUCER_WORKFLOW"
    --job "$PRODUCER_JOB"
    --profile production-release-fresh
    --command "tools/test/lanes/production-build-artifacts.sh"
    --started-at "$STARTED_AT"
    --finished-at "$FINISHED_AT"
    --duration-ms "$DURATION_MS"
    --input Directory.Build.props
    --input Directory.Packages.props
    --input FsusBlog.slnx
    --input .gitignore
    --input .dockerignore
    --input config/build/backend-docker-inputs.json
    --input config/build/backend-restore.xml
    --input ops/docker/FsusBlog.Server.Dockerfile
    --input tools/build-final-image.sh
    --input tools/docker/backend-input-closure.mjs
    --input tools/docker/backend-input-environment.mjs
    --input tools/docker/ssr-runtime-closure.mjs
    --input config/build/ssr-runtime-inputs.json
    --input tools/build-wasm-artifact.sh
    --input tools/check-wasm-artifact-ownership.mjs
    --input tools/frontend/ensure-wasm.mjs
    --input tools/frontend/write-comment-privacy-prover-manifest.mjs
    --input tools/security/comment-privacy-build-contract.mjs
    --input security/zk/contracts/comment-v5-circuit.manifest.json
    --input security/zk/provenance/comment-v5-trusted-setup.manifest.json
    --input config/zk/anonymous-comment-v5-verifying-key.manifest.json
    --input tests/tools/wasm-artifact-ownership.test.mjs
    --input tests/tools/wasm-build-receipt.test.mjs
    --input tests/tools/production-build-artifacts.test.mjs
    --input tests/tools/production-build-materialization-benchmark.test.mjs
    --input config/testing/content-addressed-build-cache.json
    --input tools/ci/production-build-artifacts.mjs
    --input tools/ci/production-build-artifacts-cli.mjs
    --input tools/ci/benchmark-production-build-materialization.mjs
    --input tools/test-matrix/content-addressed-build-cache.mjs
    --input tools/test-matrix/content-addressed-build-cache-contract.mjs
    --input tools/test-matrix/content-addressed-build-cache-storage.mjs
    --input tools/test/run-with-dotnet-release-build-lock.sh
    --input tools/test/lanes/production-build-artifacts.sh
)
if HasDomain backend-runtime || HasDomain test-runtime; then
    CREATE_ARGS+=(
        --input src/backend/FsusBlog.Server.csproj
        --input src/backend/packages.lock.json
        --input src/core/FsusBlog.Core.csproj
        --input src/core/packages.lock.json
        --input src/shared/FsusBlog.Shared.csproj
        --input src/shared/packages.lock.json
    )
fi
if HasDomain test-runtime; then
    CREATE_ARGS+=(
        --input src/migration/FsusBlog.Migration.csproj
        --input src/migration/packages.lock.json
        --input tests/backend/FsusBlog.Server.Tests.csproj
        --input tests/backend/packages.lock.json
    )
fi
if HasDomain frontend-dist || HasDomain wasm; then
    CREATE_ARGS+=(
        --input src/frontend/package.json
        --input src/frontend/package-lock.json
    )
fi
if HasDomain frontend-dist; then
    CREATE_ARGS+=(
        --input tools/frontend/build.mjs
        --input src/frontend/vite.config.ts
        --input src/frontend/tsconfig.json
        --input src/frontend/tsconfig.app.json
        --input src/frontend/tsconfig.node.json
    )
fi
if HasDomain wasm; then
    CREATE_ARGS+=(
        --input src/frontend/wasm/build.sh
        --input src/frontend/wasm/CMakeLists.txt
        --input src/frontend/wasm/aeds/CMakeLists.txt
        --input src/frontend/wasm/comment_privacy/CMakeLists.txt
        --input src/frontend/wasm/image_codec/CMakeLists.txt
        --input src/frontend/wasm/pow/CMakeLists.txt
        --input src/frontend/wasm/search/CMakeLists.txt
    )
fi
for domain in "${DOMAIN_LIST[@]}"; do
    if [[ "$domain" == "test-runtime" ]]; then
        CREATE_ARGS+=(--artifact "test-runtime:copy-before-write=payload/test-runtime")
    else
        CREATE_ARGS+=(--artifact "$domain=payload/$domain")
    fi
done
node "$ROOT_DIR/tools/ci/production-build-artifacts-cli.mjs" "${CREATE_ARGS[@]}"
PublishBuildCacheEvidenceIfFresh

printf '[production-build-artifacts] receipt=%s files are immutable consumer inputs\n' "$ARTIFACT_ROOT/receipt.json"
