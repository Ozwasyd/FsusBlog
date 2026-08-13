#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE_ID="${FSUSBLOG_RUNTIME_PROFILE_ID:-throughput-musl}"
BASE_RUN_ID="${FSUSBLOG_TEST_RUN_ID:-production-image-smoke-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"

case "$PROFILE_ID" in
    throughput-musl | throughput-glibc) ;;
    *)
        printf '[production-image-smoke] unsupported runtime profile: %s\n' "$PROFILE_ID" >&2
        exit 1
        ;;
esac
[[ "$BASE_RUN_ID" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || {
    printf '%s\n' '[production-image-smoke] FSUSBLOG_TEST_RUN_ID must be a canonical lowercase identifier' >&2
    exit 1
}

RUN_ID="$BASE_RUN_ID"
IMAGE_TAG="fsusblog-production-smoke:${RUN_ID}-${PROFILE_ID}"

node --test "$ROOT_DIR/tests/tools/production-image-smoke.test.mjs"
node "$ROOT_DIR/tools/deployment/check-production-compose-environment.mjs"
bash "$ROOT_DIR/tools/deployment/check-production-gateway-config.sh"

unset FSUSBLOG_RELEASE_ID FSUSBLOG_RELEASE_CREATED_AT_UTC
export FSUSBLOG_COMMIT_SHA
FSUSBLOG_COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
export FSUSBLOG_RELEASE_RUN_ID="$RUN_ID"
export FSUSBLOG_RELEASE_RUNTIME_IMAGE="$IMAGE_TAG"
export FSUSBLOG_RUNTIME_PROFILE_ID="$PROFILE_ID"
export FSUSBLOG_TEST_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-production-image-smoke-${RUN_ID}-${PROFILE_ID}}"

exec "$ROOT_DIR/tools/test/run-release-reliability-qualified-local.sh" \
    --runtime-admission-only
