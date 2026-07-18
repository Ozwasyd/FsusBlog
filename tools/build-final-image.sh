#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${FSUSBLOG_FINAL_IMAGE_TARGET:-final}"
PUSH_IMAGE="${FSUSBLOG_FINAL_PUSH:-0}"
LOCAL_ONLY="${FSUSBLOG_FINAL_LOCAL_ONLY:-0}"
IMAGE_REPOSITORY="${FSUSBLOG_FINAL_IMAGE_REPOSITORY:-fsusblogapp}"
COMMIT_SHA="${FSUSBLOG_COMMIT_SHA:-}"
RELEASE_ID="${FSUSBLOG_RELEASE_ID:-}"
RUNTIME_PROFILE_ID="${FSUSBLOG_RUNTIME_PROFILE_ID:-}"
RUNTIME_PROFILE_MANIFEST="${FSUSBLOG_RUNTIME_PROFILE_MANIFEST:-$ROOT_DIR/tools/runtime-profiles/runtime-publish-profiles.json}"
USE_LOCAL_FSUSUI_RAW="${FSUSBLOG_USE_LOCAL_FSUSUI:-0}"
LOCAL_FSUSUI_ROOT="${FSUSBLOG_LOCAL_FSUSUI_ROOT:-}"
FSUSUI_CONTEXT_DIR=""
FSUSUI_EMPTY_CONTEXT=""
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
DOTNET_RUNTIME_VERSION="${FSUSBLOG_DOTNET_RUNTIME_VERSION:-10.0.10}"
DOTNET_SDK_VERSION="${FSUSBLOG_DOTNET_SDK_VERSION:-10.0.302}"
DOTNET_ASPNET_MUSL_DIGEST="${FSUSBLOG_DOTNET_ASPNET_MUSL_DIGEST:-sha256:27b6b84beeede74fd16886177d360799c8e4299ceadfbd64eef57bafead7878a}"
DOTNET_ASPNET_GLIBC_DIGEST="${FSUSBLOG_DOTNET_ASPNET_GLIBC_DIGEST:-sha256:1fa23fc4872d95fd71c2833ebe65d7e84a43b2d51a31d119516852f13d9505a7}"
DOTNET_SDK_MUSL_DIGEST="${FSUSBLOG_DOTNET_SDK_MUSL_DIGEST:-sha256:d8ee39817ca03a3757288e83c37ed73cc969a286c603b827c7cbe33add1c2d1c}"
DOTNET_SDK_GLIBC_DIGEST="${FSUSBLOG_DOTNET_SDK_GLIBC_DIGEST:-sha256:ed034a8bf0b24ded0cbbac07e17825d8e9ebfe21e308191d0f7421eaf5ad4664}"
NODE_VERSION="${FSUSBLOG_NODE_VERSION:-24.17.0}"
NODE_MUSL_DIGEST="${FSUSBLOG_NODE_MUSL_DIGEST:-sha256:7c70d1235c0b4c2bc9eeed5393d19f1bbdde6885ba0d58ba62bb385d7b0f3ff1}"
NODE_GLIBC_DIGEST="${FSUSBLOG_NODE_GLIBC_DIGEST:-sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532}"

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
RequireCommand git
RequireCommand node
[[ -n "${GITHUB_PACKAGES_TOKEN:-}" ]] || Fail "GITHUB_PACKAGES_TOKEN is required"
[[ "$TARGET" == "final" ]] || Fail "production release manifest only supports Docker target final"
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
COMMIT_SHA="${COMMIT_SHA,,}"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || Fail "FSUSBLOG_COMMIT_SHA must be a full lowercase Git SHA"
if [[ -z "$RELEASE_ID" ]]; then
    RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT_SHA:0:12}"
fi
[[ "$RELEASE_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$ ]] || Fail "FSUSBLOG_RELEASE_ID is invalid"

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
        FSUSUI_EMPTY_CONTEXT="$(mktemp -d)"
        FSUSUI_CONTEXT_DIR="$FSUSUI_EMPTY_CONTEXT"
        ;;
    *) Fail "FSUSBLOG_USE_LOCAL_FSUSUI must be a boolean" ;;
esac

CleanupLocalContext() {
    if [[ -n "$FSUSUI_EMPTY_CONTEXT" ]]; then
        rm -rf "$FSUSUI_EMPTY_CONTEXT"
    fi
}
trap CleanupLocalContext EXIT

if [[ "${FSUSBLOG_FINAL_SKIP_WASM:-0}" == "1" ]]; then
    Log "resume with an existing generated wasm artifact package by FSUSBLOG_FINAL_SKIP_WASM=1"
    node "$ROOT_DIR/tools/check-wasm-artifact-ownership.mjs" \
        --require-generated \
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
    --build-context "fsusui=$FSUSUI_CONTEXT_DIR" \
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
        node -e '
    const fs = require("node:fs");
    const inspected = JSON.parse(fs.readFileSync(0, "utf8"));
    const image = inspected[0];
    if (!image || typeof image !== "object") process.exit(20);
    const labels = image.Config?.Labels ?? {};
    const expected = {
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
zk_local_review_hash="sha256:$(sha256sum "$ROOT_DIR/security/zk/provenance/comment-v2-local-review.manifest.json" | awk '{print $1}')"
dotnet_version="$(dotnet --version)"
node_version="$(node --version)"
docker_version="$(docker version --format '{{.Client.Version}}')"
schema_min_release="${FSUSBLOG_SCHEMA_MIN_RELEASE:-$RELEASE_ID}"
schema_max_release="${FSUSBLOG_SCHEMA_MAX_RELEASE:-$RELEASE_ID}"
manifest_dir="${FSUSBLOG_RELEASE_MANIFEST_DIR:-$ROOT_DIR/build/releases/$RELEASE_ID}"
manifest_file="$manifest_dir/release-manifest.json"

node "$ROOT_DIR/tools/release/create-release-manifest.mjs" \
    --output "$manifest_file" \
    --release-id "$RELEASE_ID" \
    --commit-sha "$COMMIT_SHA" \
    --image-repository "$IMAGE_REPOSITORY" \
    --image-tag "$IMAGE_TAG" \
    --image-digest "$image_digest" \
    --frontend-manifest-hash "$frontend_manifest_hash" \
    --wasm-artifact-hash "$wasm_artifact_hash" \
    --zk-local-review-hash "$zk_local_review_hash" \
    --schema-min-release "$schema_min_release" \
    --schema-max-release "$schema_max_release" \
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
