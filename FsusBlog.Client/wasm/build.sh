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
  "${OUT_DIR}/aeds_decoder.js" \
  "${OUT_DIR}/aeds_decoder.wasm" \
  "${OUT_DIR}/fsus_pow_"*.js \
  "${OUT_DIR}/fsus_pow_"*.wasm \
  "${OUT_DIR}/markdown_"*.js \
  "${OUT_DIR}/markdown_"*.wasm \
  "${OUT_DIR}/search_"*.js \
  "${OUT_DIR}/search_"*.wasm \
  "${OUT_DIR}/image_codec_"*.js \
  "${OUT_DIR}/image_codec_"*.wasm

export EM_FROZEN_CACHE="${EM_FROZEN_CACHE:-0}"
USER_CMAKE_ARGS=()
if [[ -n "${FSUSBLOG_WASM_CMAKE_ARGS:-}" ]]; then
  # Example (vcpkg + emscripten):
  # FSUSBLOG_WASM_CMAKE_ARGS='-DCMAKE_TOOLCHAIN_FILE=/path/to/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=wasm32-emscripten -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=/home/dev/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake'
  # shellcheck disable=SC2206
  USER_CMAKE_ARGS=(${FSUSBLOG_WASM_CMAKE_ARGS})
fi

if [[ "${FSUSBLOG_WASM_DISABLE_VCPKG_AUTODETECT:-0}" != "1" ]]; then
  VCPKG_ROOT_CANDIDATE="${VCPKG_ROOT:-/home/dev/vcpkg}"
  if [[ -d "${VCPKG_ROOT_CANDIDATE}/installed/wasm32-emscripten" ]]; then
    USER_CMAKE_ARGS+=("-DCMAKE_PREFIX_PATH=${VCPKG_ROOT_CANDIDATE}/installed/wasm32-emscripten")
  fi
fi

pushd "${BUILD_SIMD_DIR}" >/dev/null
emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_SIMD=ON \
  -DFSUSBLOG_WASM_MARKDOWN_ENABLE=ON \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_SIMD_DIR}" \
  "${USER_CMAKE_ARGS[@]}"
cmake --build .
popd >/dev/null

pushd "${BUILD_BASIC_DIR}" >/dev/null
emcmake cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_SIMD=OFF \
  -DFSUSBLOG_WASM_MARKDOWN_ENABLE=ON \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_BASIC_DIR}" \
  "${USER_CMAKE_ARGS[@]}"
cmake --build .
popd >/dev/null

cp -f "${STAGE_SIMD_DIR}/aeds_decoder.js" "${OUT_DIR}/aeds_decoder.js"
cp -f "${STAGE_SIMD_DIR}/aeds_decoder.wasm" "${OUT_DIR}/aeds_decoder.wasm"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.js" "${OUT_DIR}/fsus_pow_simd.js"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.wasm" "${OUT_DIR}/fsus_pow_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.js" "${OUT_DIR}/fsus_pow_basic.js"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.wasm" "${OUT_DIR}/fsus_pow_basic.wasm"
cp -f "${STAGE_SIMD_DIR}/markdown_simd.js" "${OUT_DIR}/markdown_simd.js"
cp -f "${STAGE_SIMD_DIR}/markdown_simd.wasm" "${OUT_DIR}/markdown_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/markdown_basic.js" "${OUT_DIR}/markdown_basic.js"
cp -f "${STAGE_BASIC_DIR}/markdown_basic.wasm" "${OUT_DIR}/markdown_basic.wasm"
cp -f "${STAGE_SIMD_DIR}/search_simd.js" "${OUT_DIR}/search_simd.js"
cp -f "${STAGE_SIMD_DIR}/search_simd.wasm" "${OUT_DIR}/search_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/search_basic.js" "${OUT_DIR}/search_basic.js"
cp -f "${STAGE_BASIC_DIR}/search_basic.wasm" "${OUT_DIR}/search_basic.wasm"
cp -f "${STAGE_SIMD_DIR}/image_codec_simd.js" "${OUT_DIR}/image_codec_simd.js"
cp -f "${STAGE_SIMD_DIR}/image_codec_simd.wasm" "${OUT_DIR}/image_codec_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/image_codec_basic.js" "${OUT_DIR}/image_codec_basic.js"
cp -f "${STAGE_BASIC_DIR}/image_codec_basic.wasm" "${OUT_DIR}/image_codec_basic.wasm"

node "${ROOT_DIR}/scripts/ensure-wasm.mjs" write-manifest

echo "Wasm artifacts emitted to ${OUT_DIR}"
