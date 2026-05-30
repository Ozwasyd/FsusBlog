#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${CLIENT_DIR}/../../.." && pwd)"
if [[ ! -d "${REPO_DIR}/tools/vcpkg-overlays/libyuv" && -d "${CLIENT_DIR}/../tools/vcpkg-overlays/libyuv" ]]; then
  REPO_DIR="$(cd "${CLIENT_DIR}/.." && pwd)"
fi
OVERLAY_DIR="${REPO_DIR}/tools/vcpkg-overlays"

if ! command -v vcpkg >/dev/null 2>&1; then
  echo "[install-wasm-codec-deps] vcpkg not found in PATH"
  exit 1
fi

if [[ ! -d "${OVERLAY_DIR}/libyuv" ]]; then
  echo "[install-wasm-codec-deps] overlay port missing: ${OVERLAY_DIR}/libyuv"
  exit 1
fi

echo "[install-wasm-codec-deps] installing libwebp (wasm32-emscripten)"
vcpkg install libwebp:wasm32-emscripten --overlay-ports="${OVERLAY_DIR}"

echo "[install-wasm-codec-deps] installing libavif (wasm32-emscripten)"
vcpkg install libavif:wasm32-emscripten --overlay-ports="${OVERLAY_DIR}"

echo "[install-wasm-codec-deps] done"
