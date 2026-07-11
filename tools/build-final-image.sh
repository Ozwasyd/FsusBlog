#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${FSUSBLOG_FINAL_IMAGE_TARGET:-final}"
PUSH_IMAGE="${FSUSBLOG_FINAL_PUSH:-0}"
LOCAL_ONLY="${FSUSBLOG_FINAL_LOCAL_ONLY:-0}"
IMAGE_REPOSITORY="${FSUSBLOG_FINAL_IMAGE_REPOSITORY:-fsusblogapp}"
COMMIT_SHA="${FSUSBLOG_COMMIT_SHA:-}"
RELEASE_ID="${FSUSBLOG_RELEASE_ID:-}"

log() {
  printf '[build-final-image] %s\n' "$1"
}

fail() {
  printf '[build-final-image] fatal: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_command docker
require_command git
require_command node
[[ -n "${GITHUB_PACKAGES_TOKEN:-}" ]] || fail "GITHUB_PACKAGES_TOKEN is required"
[[ "$TARGET" == "final" ]] || fail "production release manifest only supports Docker target final"
[[ "$IMAGE_REPOSITORY" =~ ^[a-z0-9]+([._/-][a-z0-9]+)*(:[0-9]+(/[a-z0-9]+([._/-][a-z0-9]+)*)?)?$ ]] \
  || fail "FSUSBLOG_FINAL_IMAGE_REPOSITORY must be an untagged lowercase repository"
if [[ "$PUSH_IMAGE" == "$LOCAL_ONLY" ]]; then
  fail "set exactly one of FSUSBLOG_FINAL_PUSH=1 or FSUSBLOG_FINAL_LOCAL_ONLY=1"
fi

if [[ -z "$COMMIT_SHA" ]]; then
  COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
fi
COMMIT_SHA="${COMMIT_SHA,,}"
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "FSUSBLOG_COMMIT_SHA must be a full lowercase Git SHA"
if [[ -z "$RELEASE_ID" ]]; then
  RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-${COMMIT_SHA:0:12}"
fi
[[ "$RELEASE_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$ ]] || fail "FSUSBLOG_RELEASE_ID is invalid"

if [[ "$LOCAL_ONLY" == "1" && -n "${FSUSBLOG_FINAL_IMAGE_TAG:-}" ]]; then
  IMAGE_TAG="$FSUSBLOG_FINAL_IMAGE_TAG"
else
  IMAGE_TAG="${IMAGE_REPOSITORY}:${RELEASE_ID}"
fi
if [[ "$PUSH_IMAGE" == "1" && "$IMAGE_TAG" != "${IMAGE_REPOSITORY}:${RELEASE_ID}" ]]; then
  fail "production image tag must equal imageRepository:releaseId"
fi
case "$IMAGE_TAG" in
  *:latest|*:final-current|fsusblogapp|*:@*) fail "mutable or malformed image reference is forbidden: $IMAGE_TAG" ;;
esac

if [[ "${FSUSBLOG_FINAL_SKIP_WASM:-0}" == "1" ]]; then
  log "skip wasm artifact package by FSUSBLOG_FINAL_SKIP_WASM=1"
else
  log "building wasm artifact package"
  "$ROOT_DIR/tools/build-wasm-artifact.sh"
fi

log "building immutable image $IMAGE_TAG for release $RELEASE_ID"
DOCKER_BUILDKIT=1 docker build \
  --pull \
  --network host \
  -f "$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile" \
  --target "$TARGET" \
  --build-arg "FSUSBLOG_RELEASE_ID=$RELEASE_ID" \
  --build-arg "FSUSBLOG_COMMIT_SHA=$COMMIT_SHA" \
  --label "org.opencontainers.image.revision=$COMMIT_SHA" \
  --label "org.opencontainers.image.version=$RELEASE_ID" \
  -t "$IMAGE_TAG" \
  --secret id=github_packages_token,env=GITHUB_PACKAGES_TOKEN \
  "$ROOT_DIR"

if [[ "$LOCAL_ONLY" == "1" ]]; then
  image_id="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "local image id is missing"
  log "local-only image ready: $IMAGE_TAG ($image_id); no deployable release manifest was emitted"
  exit 0
fi

require_command awk
require_command dotnet
require_command sha256sum
log "pushing immutable image $IMAGE_TAG"
docker push "$IMAGE_TAG"
repo_digest="$(docker image inspect "$IMAGE_TAG" --format '{{range .RepoDigests}}{{println .}}{{end}}' | awk -v repo="$IMAGE_REPOSITORY" 'index($0, repo "@sha256:") == 1 { print; exit }')"
[[ "$repo_digest" == "${IMAGE_REPOSITORY}@sha256:"* ]] || fail "registry digest missing after push"
image_digest="${repo_digest#*@}"
[[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "registry returned an invalid image digest"

hash_image_file() {
  local file="$1"
  local digest
  digest="$(docker run --rm --entrypoint sh "$IMAGE_TAG" -c "test -f '$file' && sha256sum '$file'" | awk '{print $1}')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "unable to hash image artifact $file"
  printf 'sha256:%s\n' "$digest"
}

frontend_manifest_hash="${FSUSBLOG_FRONTEND_MANIFEST_HASH:-}"
wasm_artifact_hash="${FSUSBLOG_WASM_ARTIFACT_HASH:-}"
if [[ -z "$frontend_manifest_hash" ]]; then
  frontend_manifest_hash="$(hash_image_file /app/wwwroot/.vite/manifest.json)"
fi
if [[ -z "$wasm_artifact_hash" ]]; then
  wasm_artifact_hash="$(hash_image_file /app/wwwroot/wasm/SHA256SUMS)"
fi
[[ "$frontend_manifest_hash" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "frontend manifest hash is invalid"
[[ "$wasm_artifact_hash" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "wasm artifact hash is invalid"

dockerfile_digest="sha256:$(sha256sum "$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile" | awk '{print $1}')"
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
  --schema-min-release "$schema_min_release" \
  --schema-max-release "$schema_max_release" \
  --dotnet-version "$dotnet_version" \
  --node-version "$node_version" \
  --docker-version "$docker_version" \
  --dockerfile-digest "$dockerfile_digest"

log "release manifest ready: $manifest_file"
log "immutable image ready: $repo_digest"
