#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ARTIFACT_ROOT="${FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT:-$ROOT_DIR/.tmp/ci-production-build}"
PAYLOAD_ROOT="$ARTIFACT_ROOT/payload"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_AT_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
REQUESTED_DOMAINS="${FSUSBLOG_CI_PRODUCTION_BUILD_DOMAINS:-backend-runtime,test-runtime,frontend-dist,wasm,generated-contracts}"
REUSE_BUILD_OUTPUTS="${FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS:-0}"
IFS=',' read -r -a DOMAIN_LIST <<< "$REQUESTED_DOMAINS"

case "$REUSE_BUILD_OUTPUTS" in
  0|1) ;;
  *)
    printf '[production-build-artifacts] FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS must be 0 or 1\n' >&2
    exit 1
    ;;
esac

has_domain() {
  local expected="$1"
  local domain
  for domain in "${DOMAIN_LIST[@]}"; do
    if [[ "$domain" == "$expected" ]]; then
      return 0
    fi
  done
  return 1
}

if (( ${#DOMAIN_LIST[@]} == 0 )); then
  printf '[production-build-artifacts] at least one smart-gate artifact domain is required\n' >&2
  exit 1
fi
for domain in "${DOMAIN_LIST[@]}"; do
  case "$domain" in
    backend-runtime|test-runtime|frontend-dist|wasm|generated-contracts) ;;
    *)
      printf '[production-build-artifacts] unknown smart-gate artifact domain: %s\n' "$domain" >&2
      exit 1
      ;;
  esac
done

require_file() {
  if [[ ! -f "$1" ]]; then
    printf '[production-build-artifacts] required build output is missing: %s\n' "$1" >&2
    exit 1
  fi
}

copy_directory() {
  local source="$1"
  local destination="$2"
  if [[ ! -d "$source" ]]; then
    printf '[production-build-artifacts] required build directory is missing: %s\n' "$source" >&2
    exit 1
  fi
  mkdir -p "$destination"
  cp -a "$source/." "$destination/"
}

rm -rf "$ARTIFACT_ROOT"
mkdir -p "$PAYLOAD_ROOT"

if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && { has_domain backend-runtime || has_domain test-runtime; }; then
  "$ROOT_DIR/tools/build-with-data-env.sh" dotnet restore "$ROOT_DIR/FsusBlog.slnx" -v minimal /p:NuGetAudit=false
  "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
    -c Release --no-restore --no-incremental -warnaserror -v minimal /p:NuGetAudit=false
fi
if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && has_domain test-runtime; then
  "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj" \
    -c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal /p:NuGetAudit=false
fi
if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && { has_domain frontend-dist || has_domain wasm; }; then
  npm --prefix "$ROOT_DIR/src/frontend" run ensure:wasm
fi
if [[ "$REUSE_BUILD_OUTPUTS" != "1" ]] && has_domain frontend-dist; then
  FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm --prefix "$ROOT_DIR/src/frontend" run build:release
fi

if has_domain backend-runtime; then
  require_file "${FSUSBLOG_BACKEND_SERVER_DLL:?FSUSBLOG_BACKEND_SERVER_DLL is required}"
  copy_directory "$(dirname "$FSUSBLOG_BACKEND_SERVER_DLL")" "$PAYLOAD_ROOT/backend-runtime"
fi
if has_domain test-runtime; then
  require_file "${FSUSBLOG_BACKEND_TEST_DLL:?FSUSBLOG_BACKEND_TEST_DLL is required}"
  copy_directory "$(dirname "$FSUSBLOG_BACKEND_TEST_DLL")" "$PAYLOAD_ROOT/test-runtime"
fi
if has_domain frontend-dist; then
  copy_directory "${FSUSBLOG_FRONTEND_DIST_ROOT:?FSUSBLOG_FRONTEND_DIST_ROOT is required}" "$PAYLOAD_ROOT/frontend-dist"
fi
if has_domain wasm; then
  WASM_SOURCE="${FSUSBLOG_FRONTEND_WASM_ROOT:-$ROOT_DIR/src/frontend/public/wasm}"
  copy_directory "$WASM_SOURCE" "$PAYLOAD_ROOT/wasm"
fi
if has_domain generated-contracts; then
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
  --run-id "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
  --run-attempt "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
  --workflow "${GITHUB_WORKFLOW:-Quality Gate}"
  --job "${GITHUB_JOB:-production-build-artifacts}"
  --profile production-release-fresh
  --command "tools/test/lanes/production-build-artifacts.sh"
  --started-at "$STARTED_AT"
  --finished-at "$FINISHED_AT"
  --duration-ms "$DURATION_MS"
  --input Directory.Build.props
  --input FsusBlog.slnx
  --input tools/test/lanes/production-build-artifacts.sh
)
if has_domain backend-runtime || has_domain test-runtime; then
  CREATE_ARGS+=(
    --input src/backend/FsusBlog.Server.csproj
    --input src/backend/packages.lock.json
    --input src/core/FsusBlog.Core.csproj
    --input src/core/packages.lock.json
    --input src/shared/FsusBlog.Shared.csproj
    --input src/shared/packages.lock.json
  )
fi
if has_domain test-runtime; then
  CREATE_ARGS+=(--input tests/backend/FsusBlog.Server.Tests.csproj --input tests/backend/packages.lock.json)
fi
if has_domain frontend-dist || has_domain wasm; then
  CREATE_ARGS+=(
    --input src/frontend/package.json
    --input src/frontend/package-lock.json
    --input tools/frontend/ensure-wasm.mjs
  )
fi
if has_domain frontend-dist; then
  CREATE_ARGS+=(
    --input tools/frontend/build.mjs
    --input src/frontend/vite.config.ts
    --input src/frontend/tsconfig.json
    --input src/frontend/tsconfig.app.json
    --input src/frontend/tsconfig.node.json
  )
fi
if has_domain wasm; then
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

printf '[production-build-artifacts] receipt=%s files are immutable consumer inputs\n' "$ARTIFACT_ROOT/receipt.json"
