#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${FSUSBLOG_FINAL_IMAGE_TARGET:-final}"
PUSH_IMAGE="${FSUSBLOG_FINAL_PUSH:-0}"
LOCAL_ONLY="${FSUSBLOG_FINAL_LOCAL_ONLY:-0}"
IMAGE_REPOSITORY="${FSUSBLOG_FINAL_IMAGE_REPOSITORY:-fsusblogapp}"
COMMIT_SHA="${FSUSBLOG_COMMIT_SHA:-}"
REQUESTED_RELEASE_ID="${FSUSBLOG_RELEASE_ID:-}"
REQUESTED_RELEASE_CREATED_AT_UTC="${FSUSBLOG_RELEASE_CREATED_AT_UTC:-}"
RUNTIME_PROFILE_ID="${FSUSBLOG_RUNTIME_PROFILE_ID:-}"
RUNTIME_PROFILE_MANIFEST="${FSUSBLOG_RUNTIME_PROFILE_MANIFEST:-$ROOT_DIR/tools/runtime-profiles/runtime-publish-profiles.json}"
USE_LOCAL_FSUSUI_RAW="${FSUSBLOG_USE_LOCAL_FSUSUI:-0}"
LOCAL_FSUSUI_ROOT="${FSUSBLOG_LOCAL_FSUSUI_ROOT:-}"
FSUSUI_CONTEXT_DIR=""
FSUSUI_EMPTY_CONTEXT=""
BACKEND_INPUT_CONTEXT=""
FSUSUI_SOURCE="published-package"
FSUSUI_COMMIT_SHA="0000000000000000000000000000000000000000"
DOTNET_PIN_ENV_NAMES=(
    FSUSBLOG_DOTNET_RUNTIME_VERSION
    FSUSBLOG_DOTNET_SDK_VERSION
    FSUSBLOG_DOTNET_ASPNET_MUSL_DIGEST
    FSUSBLOG_DOTNET_ASPNET_GLIBC_DIGEST
    FSUSBLOG_DOTNET_SDK_MUSL_DIGEST
    FSUSBLOG_DOTNET_SDK_GLIBC_DIGEST
)
NODE_PIN_ENV_NAMES=(
    FSUSBLOG_NODE_VERSION
    FSUSBLOG_NODE_MUSL_DIGEST
    FSUSBLOG_NODE_GLIBC_DIGEST
)
DOCKERFILE="$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile"

ReadDockerArg() {
    sed -n "s/^ARG $1=//p" "$DOCKERFILE" | head -n 1
}

DOTNET_RUNTIME_VERSION="${FSUSBLOG_DOTNET_RUNTIME_VERSION:-$(ReadDockerArg DOTNET_RUNTIME_VERSION)}"
DOTNET_SDK_VERSION="${FSUSBLOG_DOTNET_SDK_VERSION:-$(ReadDockerArg DOTNET_SDK_VERSION)}"
DOTNET_ASPNET_MUSL_DIGEST="${FSUSBLOG_DOTNET_ASPNET_MUSL_DIGEST:-$(ReadDockerArg DOTNET_ASPNET_MUSL_DIGEST)}"
DOTNET_ASPNET_GLIBC_DIGEST="${FSUSBLOG_DOTNET_ASPNET_GLIBC_DIGEST:-$(ReadDockerArg DOTNET_ASPNET_GLIBC_DIGEST)}"
DOTNET_SDK_MUSL_DIGEST="${FSUSBLOG_DOTNET_SDK_MUSL_DIGEST:-$(ReadDockerArg DOTNET_SDK_MUSL_DIGEST)}"
DOTNET_SDK_GLIBC_DIGEST="${FSUSBLOG_DOTNET_SDK_GLIBC_DIGEST:-$(ReadDockerArg DOTNET_SDK_GLIBC_DIGEST)}"
NODE_VERSION="${FSUSBLOG_NODE_VERSION:-$(ReadDockerArg NODE_VERSION)}"
NODE_MUSL_DIGEST="${FSUSBLOG_NODE_MUSL_DIGEST:-$(ReadDockerArg NODE_MUSL_DIGEST)}"
NODE_GLIBC_DIGEST="${FSUSBLOG_NODE_GLIBC_DIGEST:-$(ReadDockerArg NODE_GLIBC_DIGEST)}"

Log() {
    printf '[build-final-image] %s\n' "$1"
}

Fail() {
    printf '[build-final-image] fatal: %s\n' "$1" >&2
    exit 1
}

RequireCommand() {
    command -v "$1" >/dev/null 2>&1 || Fail "missing required command: $1"
}

RequireCommand docker
RequireCommand dotnet
RequireCommand bwrap
RequireCommand git
RequireCommand node
[[ -n "${GITHUB_PACKAGES_TOKEN:-}" ]] || Fail "GITHUB_PACKAGES_TOKEN is required"
TASK_TOOL_ARGS=()
case "$TARGET" in
    final) ;;
    current-native-task)
        [[ "$LOCAL_ONLY" == "1" && "$PUSH_IMAGE" == "0" ]] || Fail "current-native-task is local task-only, never a production release"
        TASK_TOOL_ARGS=(--tool migration)
        ;;
    *) Fail "production release manifest only supports Docker target final" ;;
esac
[[ "$IMAGE_REPOSITORY" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*(:[0-9]+(/[a-z0-9]+([._/-][a-z0-9]+)*)?)?$ ]] ||
    Fail "FSUSBLOG_FINAL_IMAGE_REPOSITORY must be an untagged lowercase repository"
if [[ "$PUSH_IMAGE" == "$LOCAL_ONLY" ]]; then
    Fail "set exactly one of FSUSBLOG_FINAL_PUSH=1 or FSUSBLOG_FINAL_LOCAL_ONLY=1"
fi
dotnet_override_count=0
for override_name in "${DOTNET_PIN_ENV_NAMES[@]}"; do
    [[ -v "$override_name" ]] && dotnet_override_count=$((dotnet_override_count + 1))
done
((dotnet_override_count == 0 || dotnet_override_count == ${#DOTNET_PIN_ENV_NAMES[@]})) ||
    Fail "FSUSBLOG_DOTNET_* servicing overrides must replace the complete version and digest set together"
node_override_count=0
for override_name in "${NODE_PIN_ENV_NAMES[@]}"; do
    [[ -v "$override_name" ]] && node_override_count=$((node_override_count + 1))
done
((node_override_count == 0 || node_override_count == ${#NODE_PIN_ENV_NAMES[@]})) ||
    Fail "FSUSBLOG_NODE_* servicing overrides must replace the version and digest set together"
[[ "$DOTNET_RUNTIME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || Fail "FSUSBLOG_DOTNET_RUNTIME_VERSION must be a stable three-part version"
[[ "$DOTNET_SDK_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || Fail "FSUSBLOG_DOTNET_SDK_VERSION must be a stable three-part version"
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || Fail "FSUSBLOG_NODE_VERSION must be a stable three-part version"
runtime_band="${DOTNET_RUNTIME_VERSION%.*}"
[[ "$DOTNET_SDK_VERSION" == "$runtime_band."* ]] || Fail "the .NET runtime and SDK pins must use the same major.minor band"
for digest_name in \
    DOTNET_ASPNET_MUSL_DIGEST \
    DOTNET_ASPNET_GLIBC_DIGEST \
    DOTNET_SDK_MUSL_DIGEST \
    DOTNET_SDK_GLIBC_DIGEST \
    NODE_MUSL_DIGEST \
    NODE_GLIBC_DIGEST; do
    digest_value="${!digest_name}"
    [[ "$digest_value" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "$digest_name must be a lowercase sha256 manifest digest"
done

if [[ -z "$COMMIT_SHA" ]]; then
    COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
fi
if [[ "$TARGET" == "current-native-task" ]]; then
    [[ "$COMMIT_SHA" == "$(git -C "$ROOT_DIR" rev-parse HEAD)" && -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]] ||
        Fail "task tool package requires exact tracked-clean current source"
fi
COMMIT_SHA="${COMMIT_SHA,,}"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || Fail "FSUSBLOG_COMMIT_SHA must be a full lowercase Git SHA"
identity_args=(snapshot --commit-sha "$COMMIT_SHA" --format lines)
if [[ -n "$REQUESTED_RELEASE_CREATED_AT_UTC" ]]; then
    identity_args+=(--created-at-utc "$REQUESTED_RELEASE_CREATED_AT_UTC")
fi
mapfile -t release_identity < <(node "$ROOT_DIR/tools/release/release-id.mjs" "${identity_args[@]}") ||
    Fail "unable to create canonical release identity snapshot"
[[ "${#release_identity[@]}" -eq 3 ]] || Fail "release identity snapshot returned incomplete fields"
RELEASE_ID="${release_identity[0]}"
RELEASE_CREATED_AT_UTC="${release_identity[1]}"
[[ "${release_identity[2]}" == "$COMMIT_SHA" ]] || Fail "release identity snapshot changed commitSha"
if [[ -n "$REQUESTED_RELEASE_ID" && "$REQUESTED_RELEASE_ID" != "$RELEASE_ID" ]]; then
    Fail "FSUSBLOG_RELEASE_ID does not match the canonical release identity snapshot"
fi

# Release byte binding is separate from canonical offline verification and live
# startup admission; the build cannot manufacture a current-schema receipt.
if [[ "$PUSH_IMAGE" == "1" ]]; then
    [[ -n "${FSUSBLOG_RELEASE_SIGNING_KEY:-}" && -n "${FSUSBLOG_RELEASE_SIGNING_KEY_SHA256:-}" &&
       -n "${FSUSBLOG_RELEASE_TRUST_POLICY:-}" && -n "${FSUSBLOG_RELEASE_TRUST_POLICY_SHA256:-}" ]] ||
        Fail "PUSH=1 requires a process-owned signing key, pinned bytes and independent trust policy"
    [[ -n "${FSUSBLOG_RELEASE_IDENTITY_ROSTER:-}" && -n "${FSUSBLOG_RELEASE_IDENTITY_ROSTER_SHA256:-}" ]] ||
        Fail "PUSH=1 requires an explicit closed release identity roster and artifact SHA-256"
    node "$ROOT_DIR/tools/release/check-release-manifest.mjs" --identity-roster-byte-binding true \
        --identity-roster "$FSUSBLOG_RELEASE_IDENTITY_ROSTER" \
        --identity-roster-sha256 "$FSUSBLOG_RELEASE_IDENTITY_ROSTER_SHA256" >/dev/null ||
        Fail "release identity roster byte binding failed"
    [[ ! -v FSUSBLOG_SCHEMA_MINIMUM_COORDINATE && ! -v FSUSBLOG_SCHEMA_MAXIMUM_COORDINATE ]] ||
        Fail "schema compatibility inputs are unsupported"
    [[ -n "${FSUSBLOG_CURRENT_SCHEMA_RECEIPT:-}" && -n "${FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256:-}" ]] ||
        Fail "production release requires an explicit current-schema receipt and artifact SHA-256"
    node "$ROOT_DIR/tools/release/check-release-manifest.mjs" \
        --receipt-byte-binding true \
        --current-schema-receipt "$FSUSBLOG_CURRENT_SCHEMA_RECEIPT" \
        --current-schema-receipt-sha256 "$FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256" >/dev/null ||
        Fail "current-schema receipt byte binding failed"
fi

mapfile -t runtime_profile_fields < <(node "$ROOT_DIR/tools/runtime-profiles/resolve-runtime-publish-profile.mjs" \
    --manifest "$RUNTIME_PROFILE_MANIFEST" \
    --profile "$RUNTIME_PROFILE_ID" \
    --format lines) || Fail "unable to resolve runtime publish profile"
[[ "${#runtime_profile_fields[@]}" -eq 17 ]] || Fail "runtime profile resolver returned incomplete fields"
RUNTIME_PROFILE_ID="${runtime_profile_fields[0]}"
RUNTIME_PROFILE_MANIFEST_DIGEST="${runtime_profile_fields[1]}"
RUNTIME_PROFILE_DIGEST="${runtime_profile_fields[2]}"
RUNTIME_BASE_FLAVOR="${runtime_profile_fields[3]}"
TARGET_RUNTIME="${runtime_profile_fields[4]}"
PUBLISH_SINGLE_FILE="${runtime_profile_fields[5]}"
PUBLISH_READY_TO_RUN="${runtime_profile_fields[6]}"
TIERED_PGO="${runtime_profile_fields[7]}"
QUICK_JIT_FOR_LOOPS="${runtime_profile_fields[8]}"
SERVER_GC="${runtime_profile_fields[9]}"
NATIVE_AOT="${runtime_profile_fields[10]}"
GC_HEAP_COUNT_MODE="${runtime_profile_fields[11]}"
GC_HEAP_HARD_LIMIT_MODE="${runtime_profile_fields[12]}"
GC_HEAP_HARD_LIMIT_PERCENT="${runtime_profile_fields[13]}"
THREAD_POOL_MODE="${runtime_profile_fields[14]}"
THREAD_POOL_MIN_THREADS_PER_CPU="${runtime_profile_fields[15]}"
TOPOLOGY_MODE="${runtime_profile_fields[16]}"
[[ "$NATIVE_AOT" == "false" ]] || Fail "NativeAOT is a conditional narrow prototype; the full final-image path rejects it until feature and security parity evidence passes"
Log "selected runtime profile $RUNTIME_PROFILE_ID ($RUNTIME_PROFILE_DIGEST)"

case "$RUNTIME_BASE_FLAVOR" in
    musl)
        [[ "$TARGET_RUNTIME" == "linux-musl-x64" ]] || Fail "musl runtime profile must target linux-musl-x64"
        EXPECTED_RUNTIME_BASE_IMAGE="mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-alpine3.23@${DOTNET_ASPNET_MUSL_DIGEST}"
        EXPECTED_RUNTIME_BASE_DIGEST="$DOTNET_ASPNET_MUSL_DIGEST"
        EXPECTED_SDK_IMAGE="mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-alpine3.23@${DOTNET_SDK_MUSL_DIGEST}"
        EXPECTED_SDK_IMAGE_DIGEST="$DOTNET_SDK_MUSL_DIGEST"
        EXPECTED_NODE_IMAGE="node:${NODE_VERSION}-alpine3.23@${NODE_MUSL_DIGEST}"
        EXPECTED_NODE_IMAGE_DIGEST="$NODE_MUSL_DIGEST"
        ;;
    glibc)
        [[ "$TARGET_RUNTIME" == "linux-x64" ]] || Fail "glibc runtime profile must target linux-x64"
        EXPECTED_RUNTIME_BASE_IMAGE="mcr.microsoft.com/dotnet/aspnet:${DOTNET_RUNTIME_VERSION}-noble@${DOTNET_ASPNET_GLIBC_DIGEST}"
        EXPECTED_RUNTIME_BASE_DIGEST="$DOTNET_ASPNET_GLIBC_DIGEST"
        EXPECTED_SDK_IMAGE="mcr.microsoft.com/dotnet/sdk:${DOTNET_SDK_VERSION}-noble@${DOTNET_SDK_GLIBC_DIGEST}"
        EXPECTED_SDK_IMAGE_DIGEST="$DOTNET_SDK_GLIBC_DIGEST"
        EXPECTED_NODE_IMAGE="node:${NODE_VERSION}-bookworm-slim@${NODE_GLIBC_DIGEST}"
        EXPECTED_NODE_IMAGE_DIGEST="$NODE_GLIBC_DIGEST"
        ;;
    *) Fail "unsupported runtime base flavor: $RUNTIME_BASE_FLAVOR" ;;
esac
Log "pinned .NET runtime $DOTNET_RUNTIME_VERSION, SDK $DOTNET_SDK_VERSION and Node $NODE_VERSION for $RUNTIME_BASE_FLAVOR"

if [[ "$LOCAL_ONLY" == "1" && -n "${FSUSBLOG_FINAL_IMAGE_TAG:-}" ]]; then
    IMAGE_TAG="$FSUSBLOG_FINAL_IMAGE_TAG"
else
    IMAGE_TAG="${IMAGE_REPOSITORY}:${RELEASE_ID}"
fi
if [[ "$PUSH_IMAGE" == "1" && "$IMAGE_TAG" != "${IMAGE_REPOSITORY}:${RELEASE_ID}" ]]; then
    Fail "production image tag must equal imageRepository:releaseId"
fi
case "$IMAGE_TAG" in
    *:latest | *:final-current | fsusblogapp | *:@*) Fail "mutable or malformed image reference is forbidden: $IMAGE_TAG" ;;
esac

CleanupLocalContext() {
    if [[ -n "$FSUSUI_EMPTY_CONTEXT" ]]; then
        rm -rf -- "$FSUSUI_EMPTY_CONTEXT"
    fi
    if [[ -n "$BACKEND_INPUT_CONTEXT" ]]; then
        rm -rf -- "$BACKEND_INPUT_CONTEXT"
    fi
}
trap CleanupLocalContext EXIT

case "${USE_LOCAL_FSUSUI_RAW,,}" in
    1 | true | yes | on)
        USE_LOCAL_FSUSUI=1
        [[ -n "$LOCAL_FSUSUI_ROOT" ]] || Fail "FSUSBLOG_LOCAL_FSUSUI_ROOT is required when local FsusUI consumption is enabled"
        [[ -f "$LOCAL_FSUSUI_ROOT/vue/packages/element-plus/index.ts" ]] || Fail "local FsusUI source is missing vue/packages/element-plus/index.ts"
        FSUSUI_CONTEXT_DIR="$(cd "$LOCAL_FSUSUI_ROOT" && pwd -P)"
        [[ -z "$(git -C "$FSUSUI_CONTEXT_DIR" status --porcelain)" ]] || Fail "local FsusUI source must be a clean Git worktree"
        FSUSUI_COMMIT_SHA="$(git -C "$FSUSUI_CONTEXT_DIR" rev-parse HEAD)"
        [[ "$FSUSUI_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || Fail "local FsusUI source must resolve to a full lowercase Git SHA"
        FSUSUI_SOURCE="local-git-alias"
        ;;
    0 | false | no | off | '')
        USE_LOCAL_FSUSUI=0
        FSUSUI_EMPTY_CONTEXT="$(mktemp -d)" || Fail "unable to create published-package FsusUI context"
        FSUSUI_CONTEXT_DIR="$FSUSUI_EMPTY_CONTEXT"
        mkdir -p "$FSUSUI_CONTEXT_DIR/vue/packages" ||
            Fail "unable to create published-package FsusUI context tree"
        printf '%s\n' 'published-package' >"$FSUSUI_CONTEXT_DIR/vue/packages/.fsusblog-published-package-context" ||
            Fail "unable to create published-package FsusUI context sentinel"
        ;;
    *) Fail "FSUSBLOG_USE_LOCAL_FSUSUI must be a boolean" ;;
esac

BACKEND_INPUT_CONTEXT="$(mktemp -d)" || Fail "unable to create backend input context"
node "$ROOT_DIR/tools/docker/backend-input-closure.mjs" materialize \
    --root "$ROOT_DIR" \
    --configuration Release --runtime "$TARGET_RUNTIME" --ready-to-run "$PUBLISH_READY_TO_RUN" \
    --target publish --single-file "$PUBLISH_SINGLE_FILE" --tiered-pgo "$TIERED_PGO" \
    --quick-jit-for-loops "$QUICK_JIT_FOR_LOOPS" --server-gc "$SERVER_GC" \
    --release-id "$RELEASE_ID" --commit-sha "$COMMIT_SHA" \
    "${TASK_TOOL_ARGS[@]}" \
    --output "$BACKEND_INPUT_CONTEXT"

if [[ "${FSUSBLOG_FINAL_SKIP_WASM:-0}" == "1" ]]; then
    Log "resume with an existing generated wasm artifact package by FSUSBLOG_FINAL_SKIP_WASM=1"
    node "$ROOT_DIR/tools/check-wasm-artifact-ownership.mjs"
    node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" verify \
        --root "$ROOT_DIR" \
        --client-root "$ROOT_DIR/src/frontend" \
        --artifact-dir "$ROOT_DIR/build/artifacts/wasm-release"
else
    Log "building wasm artifact package"
    "$ROOT_DIR/tools/build-wasm-artifact.sh"
fi

Log "building immutable image $IMAGE_TAG for release $RELEASE_ID"
DOCKER_BUILDKIT=1 docker build \
    --pull \
    --network host \
    -f "$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile" \
    --target "$TARGET" \
    --build-arg "FSUSBLOG_RELEASE_ID=$RELEASE_ID" \
    --build-arg "FSUSBLOG_RELEASE_CREATED_AT_UTC=$RELEASE_CREATED_AT_UTC" \
    --build-arg "FSUSBLOG_COMMIT_SHA=$COMMIT_SHA" \
    --build-arg "FSUSBLOG_USE_LOCAL_FSUSUI=$USE_LOCAL_FSUSUI" \
    --build-arg "FSUSBLOG_FSUSUI_SOURCE=$FSUSUI_SOURCE" \
    --build-arg "FSUSBLOG_FSUSUI_COMMIT_SHA=$FSUSUI_COMMIT_SHA" \
    --build-arg "DOTNET_RUNTIME_VERSION=$DOTNET_RUNTIME_VERSION" \
    --build-arg "DOTNET_SDK_VERSION=$DOTNET_SDK_VERSION" \
    --build-arg "DOTNET_ASPNET_MUSL_DIGEST=$DOTNET_ASPNET_MUSL_DIGEST" \
    --build-arg "DOTNET_ASPNET_GLIBC_DIGEST=$DOTNET_ASPNET_GLIBC_DIGEST" \
    --build-arg "DOTNET_SDK_MUSL_DIGEST=$DOTNET_SDK_MUSL_DIGEST" \
    --build-arg "DOTNET_SDK_GLIBC_DIGEST=$DOTNET_SDK_GLIBC_DIGEST" \
    --build-arg "NODE_VERSION=$NODE_VERSION" \
    --build-arg "NODE_MUSL_DIGEST=$NODE_MUSL_DIGEST" \
    --build-arg "NODE_GLIBC_DIGEST=$NODE_GLIBC_DIGEST" \
    --build-arg "RUNTIME_PROFILE_ID=$RUNTIME_PROFILE_ID" \
    --build-arg "RUNTIME_PROFILE_MANIFEST_DIGEST=$RUNTIME_PROFILE_MANIFEST_DIGEST" \
    --build-arg "RUNTIME_PROFILE_DIGEST=$RUNTIME_PROFILE_DIGEST" \
    --build-arg "RUNTIME_BASE_FLAVOR=$RUNTIME_BASE_FLAVOR" \
    --build-arg "TARGET_RUNTIME=$TARGET_RUNTIME" \
    --build-arg "PUBLISH_SINGLE_FILE=$PUBLISH_SINGLE_FILE" \
    --build-arg "PUBLISH_READY_TO_RUN=$PUBLISH_READY_TO_RUN" \
    --build-arg "TIERED_PGO=$TIERED_PGO" \
    --build-arg "QUICK_JIT_FOR_LOOPS=$QUICK_JIT_FOR_LOOPS" \
    --build-arg "SERVER_GC=$SERVER_GC" \
    --build-arg "NATIVE_AOT=$NATIVE_AOT" \
    --build-arg "GC_HEAP_COUNT_MODE=$GC_HEAP_COUNT_MODE" \
    --build-arg "GC_HEAP_HARD_LIMIT_MODE=$GC_HEAP_HARD_LIMIT_MODE" \
    --build-arg "GC_HEAP_HARD_LIMIT_PERCENT=$GC_HEAP_HARD_LIMIT_PERCENT" \
    --build-arg "THREAD_POOL_MODE=$THREAD_POOL_MODE" \
    --build-arg "THREAD_POOL_MIN_THREADS_PER_CPU=$THREAD_POOL_MIN_THREADS_PER_CPU" \
    --build-arg "TOPOLOGY_MODE=$TOPOLOGY_MODE" \
    --label "org.opencontainers.image.revision=$COMMIT_SHA" \
    --label "org.opencontainers.image.version=$RELEASE_ID" \
    --label "org.opencontainers.image.created=$RELEASE_CREATED_AT_UTC" \
    --build-context "fsusui=$FSUSUI_CONTEXT_DIR" \
    --build-context "backend-inputs=$BACKEND_INPUT_CONTEXT" \
    -t "$IMAGE_TAG" \
    --secret id=github_packages_token,env=GITHUB_PACKAGES_TOKEN \
    "$ROOT_DIR"

image_inspect_json="$(docker image inspect "$IMAGE_TAG")" || Fail "unable to inspect built image $IMAGE_TAG"
image_id="$({
    FSUSBLOG_EXPECTED_DOTNET_RUNTIME_VERSION="$DOTNET_RUNTIME_VERSION" \
        FSUSBLOG_EXPECTED_DOTNET_SDK_VERSION="$DOTNET_SDK_VERSION" \
        FSUSBLOG_EXPECTED_RUNTIME_BASE_IMAGE="$EXPECTED_RUNTIME_BASE_IMAGE" \
        FSUSBLOG_EXPECTED_RUNTIME_BASE_DIGEST="$EXPECTED_RUNTIME_BASE_DIGEST" \
        FSUSBLOG_EXPECTED_SDK_IMAGE="$EXPECTED_SDK_IMAGE" \
        FSUSBLOG_EXPECTED_SDK_IMAGE_DIGEST="$EXPECTED_SDK_IMAGE_DIGEST" \
        FSUSBLOG_EXPECTED_NODE_VERSION="$NODE_VERSION" \
        FSUSBLOG_EXPECTED_NODE_IMAGE="$EXPECTED_NODE_IMAGE" \
        FSUSBLOG_EXPECTED_NODE_IMAGE_DIGEST="$EXPECTED_NODE_IMAGE_DIGEST" \
        FSUSBLOG_EXPECTED_RUNTIME_BASE_FLAVOR="$RUNTIME_BASE_FLAVOR" \
        FSUSBLOG_EXPECTED_TARGET_RUNTIME="$TARGET_RUNTIME" \
        FSUSBLOG_EXPECTED_RUNTIME_PROFILE_ID="$RUNTIME_PROFILE_ID" \
        FSUSBLOG_EXPECTED_RELEASE_ID="$RELEASE_ID" \
        FSUSBLOG_EXPECTED_RELEASE_CREATED_AT_UTC="$RELEASE_CREATED_AT_UTC" \
        FSUSBLOG_EXPECTED_COMMIT_SHA="$COMMIT_SHA" \
        FSUSBLOG_EXPECTED_RUNTIME_PROFILE_MANIFEST_DIGEST="$RUNTIME_PROFILE_MANIFEST_DIGEST" \
        FSUSBLOG_EXPECTED_RUNTIME_PROFILE_DIGEST="$RUNTIME_PROFILE_DIGEST" \
        FSUSBLOG_EXPECTED_PUBLISH_SINGLE_FILE="$PUBLISH_SINGLE_FILE" \
        FSUSBLOG_EXPECTED_PUBLISH_READY_TO_RUN="$PUBLISH_READY_TO_RUN" \
        FSUSBLOG_EXPECTED_TIERED_PGO="$TIERED_PGO" \
        FSUSBLOG_EXPECTED_QUICK_JIT_FOR_LOOPS="$QUICK_JIT_FOR_LOOPS" \
        FSUSBLOG_EXPECTED_SERVER_GC="$SERVER_GC" \
        FSUSBLOG_EXPECTED_NATIVE_AOT="$NATIVE_AOT" \
        FSUSBLOG_EXPECTED_GC_HEAP_COUNT_MODE="$GC_HEAP_COUNT_MODE" \
        FSUSBLOG_EXPECTED_GC_HEAP_HARD_LIMIT_MODE="$GC_HEAP_HARD_LIMIT_MODE" \
        FSUSBLOG_EXPECTED_GC_HEAP_HARD_LIMIT_PERCENT="$GC_HEAP_HARD_LIMIT_PERCENT" \
        FSUSBLOG_EXPECTED_THREAD_POOL_MODE="$THREAD_POOL_MODE" \
        FSUSBLOG_EXPECTED_THREAD_POOL_MIN_THREADS_PER_CPU="$THREAD_POOL_MIN_THREADS_PER_CPU" \
        FSUSBLOG_EXPECTED_TOPOLOGY_MODE="$TOPOLOGY_MODE" \
        node -e $'
    const fs = require("node:fs");
    const inspected = JSON.parse(fs.readFileSync(0, "utf8"));
    const image = inspected[0];
    if (!image || typeof image !== "object") process.exit(20);
    const labels = image.Config?.Labels ?? {};
    const expected = {
      "org.opencontainers.image.version": process.env.FSUSBLOG_EXPECTED_RELEASE_ID,
      "org.opencontainers.image.created": process.env.FSUSBLOG_EXPECTED_RELEASE_CREATED_AT_UTC,
      "org.opencontainers.image.revision": process.env.FSUSBLOG_EXPECTED_COMMIT_SHA,
      "io.fsusblog.runtime.dotnet-version": process.env.FSUSBLOG_EXPECTED_DOTNET_RUNTIME_VERSION,
      "io.fsusblog.build.dotnet-sdk-version": process.env.FSUSBLOG_EXPECTED_DOTNET_SDK_VERSION,
      "io.fsusblog.runtime.base-image": process.env.FSUSBLOG_EXPECTED_RUNTIME_BASE_IMAGE,
      "io.fsusblog.runtime.base-image-digest": process.env.FSUSBLOG_EXPECTED_RUNTIME_BASE_DIGEST,
      "io.fsusblog.build.sdk-image": process.env.FSUSBLOG_EXPECTED_SDK_IMAGE,
      "io.fsusblog.build.sdk-image-digest": process.env.FSUSBLOG_EXPECTED_SDK_IMAGE_DIGEST,
      "io.fsusblog.runtime.node-version": process.env.FSUSBLOG_EXPECTED_NODE_VERSION,
      "io.fsusblog.runtime.node-image": process.env.FSUSBLOG_EXPECTED_NODE_IMAGE,
      "io.fsusblog.runtime.node-image-digest": process.env.FSUSBLOG_EXPECTED_NODE_IMAGE_DIGEST,
      "io.fsusblog.runtime.base-family": process.env.FSUSBLOG_EXPECTED_RUNTIME_BASE_FLAVOR,
      "io.fsusblog.runtime.target-runtime": process.env.FSUSBLOG_EXPECTED_TARGET_RUNTIME,
      "io.fsusblog.runtime.profile-id": process.env.FSUSBLOG_EXPECTED_RUNTIME_PROFILE_ID,
      "io.fsusblog.runtime.profile-manifest-digest": process.env.FSUSBLOG_EXPECTED_RUNTIME_PROFILE_MANIFEST_DIGEST,
      "io.fsusblog.runtime.profile-digest": process.env.FSUSBLOG_EXPECTED_RUNTIME_PROFILE_DIGEST,
      "io.fsusblog.runtime.publish-single-file": process.env.FSUSBLOG_EXPECTED_PUBLISH_SINGLE_FILE,
      "io.fsusblog.runtime.publish-ready-to-run": process.env.FSUSBLOG_EXPECTED_PUBLISH_READY_TO_RUN,
      "io.fsusblog.runtime.tiered-pgo": process.env.FSUSBLOG_EXPECTED_TIERED_PGO,
      "io.fsusblog.runtime.quick-jit-for-loops": process.env.FSUSBLOG_EXPECTED_QUICK_JIT_FOR_LOOPS,
      "io.fsusblog.runtime.server-gc": process.env.FSUSBLOG_EXPECTED_SERVER_GC,
      "io.fsusblog.runtime.native-aot": process.env.FSUSBLOG_EXPECTED_NATIVE_AOT,
      "io.fsusblog.runtime.gc-heap-count-mode": process.env.FSUSBLOG_EXPECTED_GC_HEAP_COUNT_MODE,
      "io.fsusblog.runtime.gc-heap-hard-limit-mode": process.env.FSUSBLOG_EXPECTED_GC_HEAP_HARD_LIMIT_MODE,
      "io.fsusblog.runtime.gc-heap-hard-limit-percent": process.env.FSUSBLOG_EXPECTED_GC_HEAP_HARD_LIMIT_PERCENT,
      "io.fsusblog.runtime.thread-pool-mode": process.env.FSUSBLOG_EXPECTED_THREAD_POOL_MODE,
      "io.fsusblog.runtime.thread-pool-min-threads-per-cpu": process.env.FSUSBLOG_EXPECTED_THREAD_POOL_MIN_THREADS_PER_CPU,
      "io.fsusblog.runtime.topology-mode": process.env.FSUSBLOG_EXPECTED_TOPOLOGY_MODE
    };
    const mismatches = Object.entries(expected).filter(([name, value]) => labels[name] !== value);
    if (mismatches.length > 0) {
      for (const [name, value] of mismatches) {
        console.error(`[build-final-image] image identity mismatch ${name}: expected=${value} actual=${labels[name] ?? "<missing>"}`);
      }
      process.exit(21);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(image.Id ?? "")) process.exit(22);
    process.stdout.write(image.Id);
  ' <<<"$image_inspect_json"
} 2> >(cat >&2))" || Fail "built image toolchain identity is invalid"
node_contract="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c 'set -eu; node --version; if command -v npm >/dev/null 2>&1; then exit 64; fi')" ||
    Fail "built image must provide pinned Node and exclude npm"
[[ "$node_contract" == "v$NODE_VERSION" ]] ||
    Fail "built image Node version mismatch: expected=v$NODE_VERSION actual=$node_contract"
Log "verified image toolchain identity: runtime=$DOTNET_RUNTIME_VERSION sdk=$DOTNET_SDK_VERSION node=$NODE_VERSION base=$EXPECTED_RUNTIME_BASE_DIGEST"

if [[ "$LOCAL_ONLY" == "1" ]]; then
    if [[ "$TARGET" == "current-native-task" ]]; then
        task_tool_contract="$(docker image inspect "$image_id" --format '{{index .Config.Labels "io.fsusblog.task.tool-contract"}}')" || Fail "task tool image contract could not be observed"
        [[ "$task_tool_contract" == "fsusblog.current-native-task-tool-image.v1" ]] || Fail "task tool image contract version mismatch"
        task_tool_files="$(docker run --rm --network none --read-only --cap-drop ALL --entrypoint sh "$image_id" -c '
            set -eu
            cd /app/tools/migration
            test -f FsusBlog.Migration.dll
            test -f FsusBlog.Migration.deps.json
            test -f FsusBlog.Migration.runtimeconfig.json
            test -z "$(find . -type l -print)"
            test -z "$(find . ! -type d ! -type f -print)"
            find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
                hash=$(sha256sum "$file"); hash=${hash%% *}
                bytes=$(wc -c < "$file")
                printf "%s\t%s\t%s\n" "$hash" "$bytes" "${file#./}"
            done')" || Fail "task tool artifact closure could not be measured"
        printf '%s\n' "$task_tool_files" | node --input-type=module -e '
            import fs from "node:fs";
            import path from "node:path";
            import { pathToFileURL } from "node:url";
            const [root, sourceCommit, imageId, targetRuntime, releaseId] = process.argv.slice(1);
            const { createCurrentNativeTaskToolImageBinding } = await import(pathToFileURL(path.join(root, "tools/ci/production-build-artifacts.mjs")));
            const binding = createCurrentNativeTaskToolImageBinding({ sourceCommit, imageId, targetRuntime,
                measurement: fs.readFileSync(0, "utf8") });
            const file = path.join(root, "build/releases", releaseId, "current-native-task-tool-image.json");
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(binding, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            console.log("[build-final-image] task tool binding=" + file);
        ' "$ROOT_DIR" "$COMMIT_SHA" "$image_id" "$TARGET_RUNTIME" "$RELEASE_ID" || Fail "task tool binding creation failed"
    fi
    Log "local-only image ready: $IMAGE_TAG ($image_id); no deployable release manifest was emitted"
    exit 0
fi

RequireCommand awk
RequireCommand dotnet
RequireCommand sha256sum
Log "pushing immutable image $IMAGE_TAG"
docker push "$IMAGE_TAG"
repo_digest="$(docker image inspect "$IMAGE_TAG" --format '{{range .RepoDigests}}{{println .}}{{end}}' | awk -v repo="$IMAGE_REPOSITORY" 'index($0, repo "@sha256:") == 1 { print; exit }')"
[[ "$repo_digest" == "${IMAGE_REPOSITORY}@sha256:"* ]] || Fail "registry digest missing after push"
image_digest="${repo_digest#*@}"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "registry returned an invalid image digest"

HashImageFile() {
    local file="$1"
    local digest
    digest="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c "test -f '$file' && sha256sum '$file'" | awk '{print $1}')"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || Fail "unable to hash image artifact $file"
    printf 'sha256:%s\n' "$digest"
}

frontend_manifest_hash="${FSUSBLOG_FRONTEND_MANIFEST_HASH:-}"
wasm_artifact_hash="${FSUSBLOG_WASM_ARTIFACT_HASH:-}"
if [[ -z "$frontend_manifest_hash" ]]; then
    frontend_manifest_hash="$(HashImageFile /app/wwwroot/.vite/manifest.json)"
fi
if [[ -z "$wasm_artifact_hash" ]]; then
    wasm_artifact_hash="$(HashImageFile /app/wwwroot/wasm/SHA256SUMS)"
fi
[[ "$frontend_manifest_hash" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "frontend manifest hash is invalid"
[[ "$wasm_artifact_hash" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "wasm artifact hash is invalid"

dockerfile_digest="sha256:$(sha256sum "$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile" | awk '{print $1}')"
dotnet_version="$(dotnet --version)"
node_version="$(node --version)"
docker_version="$(docker version --format '{{.Client.Version}}')"
manifest_dir="${FSUSBLOG_RELEASE_MANIFEST_DIR:-$ROOT_DIR/build/releases/$RELEASE_ID}"
manifest_file="$manifest_dir/release-manifest.json"

node "$ROOT_DIR/tools/release/create-release-manifest.mjs" \
    --output "$manifest_file" \
    --signing-key "$FSUSBLOG_RELEASE_SIGNING_KEY" \
    --signing-key-sha256 "$FSUSBLOG_RELEASE_SIGNING_KEY_SHA256" \
    --trust-policy "$FSUSBLOG_RELEASE_TRUST_POLICY" \
    --trust-policy-sha256 "$FSUSBLOG_RELEASE_TRUST_POLICY_SHA256" \
    --release-id "$RELEASE_ID" \
    --created-at-utc "$RELEASE_CREATED_AT_UTC" \
    --commit-sha "$COMMIT_SHA" \
    --image-repository "$IMAGE_REPOSITORY" \
    --image-tag "$IMAGE_TAG" \
    --image-digest "$image_digest" \
    --frontend-manifest-hash "$frontend_manifest_hash" \
    --wasm-artifact-hash "$wasm_artifact_hash" \
    --identity-roster "$FSUSBLOG_RELEASE_IDENTITY_ROSTER" \
    --identity-roster-sha256 "$FSUSBLOG_RELEASE_IDENTITY_ROSTER_SHA256" \
    --current-schema-receipt "$FSUSBLOG_CURRENT_SCHEMA_RECEIPT" \
    --current-schema-receipt-sha256 "$FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256" \
    --dotnet-version "$dotnet_version" \
    --node-version "$node_version" \
    --docker-version "$docker_version" \
    --dockerfile-digest "$dockerfile_digest" \
    --runtime-profile-id "$RUNTIME_PROFILE_ID" \
    --runtime-profile-manifest-digest "$RUNTIME_PROFILE_MANIFEST_DIGEST" \
    --runtime-profile-digest "$RUNTIME_PROFILE_DIGEST" \
    --runtime-base-family "$RUNTIME_BASE_FLAVOR" \
    --target-runtime "$TARGET_RUNTIME" \
    --publish-single-file "$PUBLISH_SINGLE_FILE" \
    --publish-ready-to-run "$PUBLISH_READY_TO_RUN" \
    --tiered-pgo "$TIERED_PGO" \
    --quick-jit-for-loops "$QUICK_JIT_FOR_LOOPS" \
    --server-gc "$SERVER_GC" \
    --native-aot "$NATIVE_AOT" \
    --thread-pool-mode "$THREAD_POOL_MODE" \
    --topology-mode "$TOPOLOGY_MODE"

Log "release manifest ready: $manifest_file"
Log "immutable image ready: $repo_digest"
