#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-homogeneous-two-node}"
NAMESPACE_SLUG="$(printf '%s' "$NAMESPACE" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_.-' '-' | sed -E 's/^-+|-+$//g')"
[[ -n "$NAMESPACE_SLUG" ]] || NAMESPACE_SLUG="homogeneous-two-node"

export FSUSBLOG_TEST_NAMESPACE="$NAMESPACE_SLUG"
export FSUSBLOG_TEST_RUNTIME_MODE="${FSUSBLOG_TEST_RUNTIME_MODE:-static-role}"
export FSUSBLOG_TEST_NODE_COUNT="${FSUSBLOG_TEST_NODE_COUNT:-2}"
export FSUSBLOG_TEST_ARTIFACT_STORAGE="${FSUSBLOG_TEST_ARTIFACT_STORAGE:-shared-volume}"
export FSUSBLOG_TEST_COORDINATION_STORE="${FSUSBLOG_TEST_COORDINATION_STORE:-redis}"
export FSUSBLOG_TEST_CLUSTER_SCENARIO="${FSUSBLOG_TEST_CLUSTER_SCENARIO:-convergence}"
export FSUSBLOG_TEST_CLUSTER_BOOTSTRAP="${FSUSBLOG_TEST_CLUSTER_BOOTSTRAP:-homogeneous}"
export FSUSBLOG_TEST_CLUSTER_FIXTURES="${FSUSBLOG_TEST_CLUSTER_FIXTURES:-shared-postgres,shared-redis,shared-artifact-storage}"
export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
export ASPNETCORE_WEBROOT="${ASPNETCORE_WEBROOT:-$ROOT_DIR/src/backend/wwwroot}"
export FSUSBLOG_RUNTIME_CONFIGURATION=Release

if [[ -z "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" && -z "${FSUSBLOG_BACKEND_SERVER_DLL:-}" ]]; then
    while IFS= read -r -d '' assignment; do
        export "$assignment"
    done < <(node "$ROOT_DIR/tools/test/export-production-build-environment.mjs" \
        --root "$ROOT_DIR" \
        --run-id "${FSUSBLOG_TEST_RUN_ID:?two-node production build run id is required}")
elif [[ -z "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" || -z "${FSUSBLOG_BACKEND_SERVER_DLL:-}" ]]; then
    printf '%s\n' 'two-node production build environment is incomplete' >&2
    exit 2
fi
: "${FSUSBLOG_PRODUCTION_BUILD_ROOT:?two-node production build root is required}"
: "${FSUSBLOG_BACKEND_SERVER_DLL:?two-node candidate assembly is required}"

"$ROOT_DIR/tools/bootstrap-acceptance-env.sh" --services-only

CONFIGURATION="$FSUSBLOG_RUNTIME_CONFIGURATION"
if [[ "${FSUSBLOG_CLUSTER_FIXTURE_NO_BUILD:-0}" != "1" ]]; then
    "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build \
        "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
        --configuration "$CONFIGURATION" \
        -p:FsusBlogCommitSha="${FSUSBLOG_TEST_SOURCE_COMMIT:?two-node backend build source commit is required}"
fi

(
    export FSUSBLOG_RUNTIME_CONFIGURATION="$CONFIGURATION"
    export FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1
    # shellcheck source=../../bootstrap-acceptance-env.sh
    source "$ROOT_DIR/tools/bootstrap-acceptance-env.sh"
    PORT_LEASE_RELEASE_ON_EXIT=0
    MaterializeCurrentSchemaForTestRuntime
    RequireCurrentSchemaRuntimeReady
)

BACKEND_ARTIFACT="${FSUSBLOG_BACKEND_SERVER_DLL:?two-node candidate assembly is required}"
FRONTEND_ASSET_SOURCE="${FSUSBLOG_FRONTEND_ASSET_IDENTITY_SOURCE:-$ROOT_DIR/src/frontend/package.json}"
OUTPUT_ROOT="$ROOT_DIR/.tmp/fixtures/$NAMESPACE_SLUG/homogeneous-two-node"
SHARED_ARTIFACT_ROOT="${FSUSBLOG_SHARED_ARTIFACT_ROOT:-${BACKEND_ARTIFACT%/*}}"
ENV_FILE="$ROOT_DIR/.tmp/env/$NAMESPACE_SLUG.env"

node "$ROOT_DIR/tools/test/homogeneous-two-node-fixture.mjs" \
    --env-file "$ENV_FILE" \
    --artifact "$BACKEND_ARTIFACT" \
    --artifact-root "$SHARED_ARTIFACT_ROOT" \
    --frontend-asset-source "$FRONTEND_ASSET_SOURCE" \
    --output-root "$OUTPUT_ROOT" \
    --summary "$OUTPUT_ROOT/cluster-summary.json" \
    --cwd "$ROOT_DIR"
