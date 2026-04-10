#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_ROOT="${ROOT_DIR}/wasm"
OUT_DIR="${ROOT_DIR}/public/wasm"
BUILD_SIMD_DIR="${WASM_ROOT}/build-simd"
BUILD_BASIC_DIR="${WASM_ROOT}/build-basic"
STAGE_DIR="${WASM_ROOT}/.artifacts"
STAGE_SIMD_DIR="${STAGE_DIR}/markdown-simd"
STAGE_BASIC_DIR="${STAGE_DIR}/markdown-basic"
mkdir -p "${OUT_DIR}" "${BUILD_SIMD_DIR}" "${BUILD_BASIC_DIR}" "${STAGE_SIMD_DIR}" "${STAGE_BASIC_DIR}"
rm -f \
  "${OUT_DIR}/markdown_"*.js \
  "${OUT_DIR}/markdown_"*.wasm

export EM_FROZEN_CACHE="${EM_FROZEN_CACHE:-1}"

pushd "${BUILD_SIMD_DIR}" >/dev/null
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DWASM_SIMD=ON -DFSUSBLOG_WASM_MARKDOWN_ENABLE=ON -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_SIMD_DIR}"
cmake --build .
popd >/dev/null

pushd "${BUILD_BASIC_DIR}" >/dev/null
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DWASM_SIMD=OFF -DFSUSBLOG_WASM_MARKDOWN_ENABLE=ON -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_BASIC_DIR}"
cmake --build .
popd >/dev/null

cp -f "${STAGE_SIMD_DIR}/markdown_simd.js" "${OUT_DIR}/markdown_simd.js"
cp -f "${STAGE_SIMD_DIR}/markdown_simd.wasm" "${OUT_DIR}/markdown_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/markdown_basic.js" "${OUT_DIR}/markdown_basic.js"
cp -f "${STAGE_BASIC_DIR}/markdown_basic.wasm" "${OUT_DIR}/markdown_basic.wasm"

echo "Wasm artifacts emitted to ${OUT_DIR}"
