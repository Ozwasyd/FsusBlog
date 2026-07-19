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

"$ROOT_DIR/tools/bootstrap-acceptance-env.sh" --services-only

CONFIGURATION="${FSUSBLOG_RUNTIME_CONFIGURATION:-Debug}"
if [[ "${FSUSBLOG_CLUSTER_FIXTURE_NO_BUILD:-0}" != "1" ]]; then
    "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build \
        "$ROOT_DIR/src/backend/FsusBlog.Server.csproj" \
        --configuration "$CONFIGURATION"
fi

BACKEND_ARTIFACT="${FSUSBLOG_BACKEND_SERVER_DLL:-$ROOT_DIR/src/backend/bin/$CONFIGURATION/net10.0/FsusBlog.Server.dll}"
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
