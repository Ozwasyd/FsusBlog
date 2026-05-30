#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${ROOT_DIR}/src/frontend"
SERVER_PROJ="${ROOT_DIR}/src/backend/FsusBlog.Server.csproj"
TARGET_RUNTIME="${FSUSBLOG_NATIVE_RUNTIME:-linux-musl-x64}"
BUILD_CONFIGURATION="${FSUSBLOG_NATIVE_CONFIGURATION:-Release}"
BUILD_CONFIGURATION_LOWER="$(printf '%s' "${BUILD_CONFIGURATION}" | tr '[:upper:]' '[:lower:]')"
OUTPUT_DIR="${ROOT_DIR}/build/native/${TARGET_RUNTIME}/${BUILD_CONFIGURATION_LOWER}"

log() {
  printf '[build-native] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[build-native] fatal: missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_non_empty_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '[build-native] fatal: %s is required for GitHub Packages restore\n' "$name" >&2
    exit 1
  fi
}

require_command npm
require_command dotnet
require_non_empty_env GITHUB_PACKAGES_TOKEN

log "cleaning ${OUTPUT_DIR}"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

log "installing client dependencies"
(
  cd "${CLIENT_DIR}"
  npm ci --no-audit --progress=false
)

log "building client release assets"
(
  cd "${CLIENT_DIR}"
  npm run build:release
)

log "publishing self-contained single-file server (${TARGET_RUNTIME})"
dotnet publish "${SERVER_PROJ}" \
  -c "${BUILD_CONFIGURATION}" \
  -r "${TARGET_RUNTIME}" \
  -o "${OUTPUT_DIR}" \
  --self-contained true \
  /p:PublishSingleFile=true \
  /p:UseAppHost=true \
  /p:PublishTrimmed=false \
  /p:PublishReadyToRun=true \
  /p:ReadyToRunUseCrossgen2=true

log "syncing frontend dist into wwwroot"
rm -rf "${OUTPUT_DIR}/wwwroot"
mkdir -p "${OUTPUT_DIR}/wwwroot"
cp -a "${CLIENT_DIR}/dist/." "${OUTPUT_DIR}/wwwroot/"

log "packaging client runtime for Node SSR worker"
rm -rf "${OUTPUT_DIR}/FsusBlog.ClientRuntime"
mkdir -p "${OUTPUT_DIR}/FsusBlog.ClientRuntime"
cp -a "${CLIENT_DIR}/." "${OUTPUT_DIR}/FsusBlog.ClientRuntime/"

log "native release ready at ${OUTPUT_DIR}"
