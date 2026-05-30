#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${FSUSBLOG_FINAL_IMAGE_TAG:-fsusblogapp:final-current}"
TARGET="${FSUSBLOG_FINAL_IMAGE_TARGET:-final}"

log() {
  printf '[build-final-image] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[build-final-image] fatal: missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_non_empty_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '[build-final-image] fatal: %s is required\n' "$name" >&2
    exit 1
  fi
}

require_command docker
require_non_empty_env GITHUB_PACKAGES_TOKEN

if [[ "${FSUSBLOG_FINAL_SKIP_WASM:-0}" == "1" ]]; then
  log "skip wasm artifact package by FSUSBLOG_FINAL_SKIP_WASM=1"
else
  log "building wasm artifact package"
  "${ROOT_DIR}/tools/build-wasm-artifact.sh"
fi

log "building docker image ${IMAGE_TAG}"
DOCKER_BUILDKIT=1 docker build \
  --pull \
  --network host \
  -f "${ROOT_DIR}/ops/docker/FsusBlog.Server.Dockerfile" \
  --target "${TARGET}" \
  -t "${IMAGE_TAG}" \
  --secret id=github_packages_token,env=GITHUB_PACKAGES_TOKEN \
  "${ROOT_DIR}"

log "image ready: ${IMAGE_TAG}"
