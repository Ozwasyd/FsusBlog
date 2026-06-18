#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_ROOT="${ROOT_DIR}/wasm"
OUT_DIR="${ROOT_DIR}/public/wasm"
BUILD_SIMD_DIR="${WASM_ROOT}/build-simd"
BUILD_BASIC_DIR="${WASM_ROOT}/build-basic"
BUILD_RELAXED_POW_DIR="${WASM_ROOT}/build-pow-relaxed"
BUILD_THREADS_POW_DIR="${WASM_ROOT}/build-pow-threads"
STAGE_DIR="${WASM_ROOT}/.artifacts"
STAGE_SIMD_DIR="${STAGE_DIR}/wasm-simd"
STAGE_BASIC_DIR="${STAGE_DIR}/wasm-basic"
STAGE_RELAXED_POW_DIR="${STAGE_DIR}/wasm-pow-relaxed"
STAGE_THREADS_POW_DIR="${STAGE_DIR}/wasm-pow-threads"
BUILD_IMAGE_CODEC="${FSUSBLOG_WASM_IMAGE_CODEC_ENABLE:-ON}"
mkdir -p \
  "${OUT_DIR}" \
  "${BUILD_SIMD_DIR}" \
  "${BUILD_BASIC_DIR}" \
  "${BUILD_RELAXED_POW_DIR}" \
  "${BUILD_THREADS_POW_DIR}" \
  "${STAGE_SIMD_DIR}" \
  "${STAGE_BASIC_DIR}" \
  "${STAGE_RELAXED_POW_DIR}" \
  "${STAGE_THREADS_POW_DIR}"
rm -f \
  "${OUT_DIR}/aeds_decoder.js" \
  "${OUT_DIR}/aeds_decoder.wasm" \
  "${OUT_DIR}/fsus_pow_"*.js \
  "${OUT_DIR}/fsus_pow_"*.wasm \
  "${OUT_DIR}/search_"*.js \
  "${OUT_DIR}/search_"*.wasm \
  "${OUT_DIR}/image_codec_"*.js \
  "${OUT_DIR}/image_codec_"*.wasm

if [[ -n "${FSUSBLOG_EM_CACHE:-}" ]]; then
  export EM_CACHE="${FSUSBLOG_EM_CACHE}"
else
  export EM_CACHE="${ROOT_DIR}/../../.tmp/emscripten-cache"
fi
mkdir -p "${EM_CACHE}"

# Some distro Emscripten packages ship with FROZEN_CACHE=True and a read-only
# /usr/share/emscripten/cache. Project builds need Emscripten ports such as
# libjpeg for full wasm image-codec support, so use the writable project cache
# above unless the caller explicitly overrides this knob.
if [[ "${FSUSBLOG_EM_FROZEN_CACHE+x}" == "x" ]]; then
  export EM_FROZEN_CACHE="${FSUSBLOG_EM_FROZEN_CACHE}"
else
  export EM_FROZEN_CACHE=""
fi

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

optimize_pow_wasm() {
  local file="$1"
  if ! command -v wasm-opt >/dev/null 2>&1; then
    return
  fi

  local tmp="${file}.opt"
  if wasm-opt -O4 --enable-simd --enable-relaxed-simd "${file}" -o "${tmp}" >/dev/null 2>&1; then
    mv -f "${tmp}" "${file}"
  else
    rm -f "${tmp}"
    echo "[build:wasm] wasm-opt skipped for ${file}" >&2
  fi
}

pushd "${BUILD_SIMD_DIR}" >/dev/null
emcmake cmake --fresh .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_SIMD=ON \
  -DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE="${BUILD_IMAGE_CODEC}" \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_SIMD_DIR}" \
  "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
cmake --build .
popd >/dev/null

pushd "${BUILD_BASIC_DIR}" >/dev/null
emcmake cmake --fresh .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_SIMD=OFF \
  -DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE="${BUILD_IMAGE_CODEC}" \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_BASIC_DIR}" \
  "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
cmake --build .
popd >/dev/null

pushd "${BUILD_RELAXED_POW_DIR}" >/dev/null
emcmake cmake --fresh ../pow \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_RELAXED_SIMD=ON \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_RELAXED_POW_DIR}" \
  "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
cmake --build .
popd >/dev/null

pushd "${BUILD_THREADS_POW_DIR}" >/dev/null
emcmake cmake --fresh ../pow \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_THREADS=ON \
  -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_THREADS_POW_DIR}" \
  "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
cmake --build .
popd >/dev/null

cp -f "${STAGE_SIMD_DIR}/aeds_decoder.js" "${OUT_DIR}/aeds_decoder.js"
cp -f "${STAGE_SIMD_DIR}/aeds_decoder.wasm" "${OUT_DIR}/aeds_decoder.wasm"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.js" "${OUT_DIR}/fsus_pow_simd.js"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.wasm" "${OUT_DIR}/fsus_pow_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.js" "${OUT_DIR}/fsus_pow_basic.js"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.wasm" "${OUT_DIR}/fsus_pow_basic.wasm"
cp -f "${STAGE_RELAXED_POW_DIR}/fsus_pow_relaxed.js" "${OUT_DIR}/fsus_pow_relaxed.js"
cp -f "${STAGE_RELAXED_POW_DIR}/fsus_pow_relaxed.wasm" "${OUT_DIR}/fsus_pow_relaxed.wasm"
cp -f "${STAGE_THREADS_POW_DIR}/fsus_pow_threads.js" "${OUT_DIR}/fsus_pow_threads.js"
cp -f "${STAGE_THREADS_POW_DIR}/fsus_pow_threads.wasm" "${OUT_DIR}/fsus_pow_threads.wasm"
optimize_pow_wasm "${OUT_DIR}/fsus_pow_basic.wasm"
optimize_pow_wasm "${OUT_DIR}/fsus_pow_simd.wasm"
optimize_pow_wasm "${OUT_DIR}/fsus_pow_relaxed.wasm"
optimize_pow_wasm "${OUT_DIR}/fsus_pow_threads.wasm"
cp -f "${STAGE_SIMD_DIR}/search_simd.js" "${OUT_DIR}/search_simd.js"
cp -f "${STAGE_SIMD_DIR}/search_simd.wasm" "${OUT_DIR}/search_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/search_basic.js" "${OUT_DIR}/search_basic.js"
cp -f "${STAGE_BASIC_DIR}/search_basic.wasm" "${OUT_DIR}/search_basic.wasm"
if [[ "${BUILD_IMAGE_CODEC}" == "ON" || "${BUILD_IMAGE_CODEC}" == "1" || "${BUILD_IMAGE_CODEC}" == "TRUE" ]]; then
  cp -f "${STAGE_SIMD_DIR}/image_codec_simd.js" "${OUT_DIR}/image_codec_simd.js"
  cp -f "${STAGE_SIMD_DIR}/image_codec_simd.wasm" "${OUT_DIR}/image_codec_simd.wasm"
  cp -f "${STAGE_BASIC_DIR}/image_codec_basic.js" "${OUT_DIR}/image_codec_basic.js"
  cp -f "${STAGE_BASIC_DIR}/image_codec_basic.wasm" "${OUT_DIR}/image_codec_basic.wasm"
fi

node "${ROOT_DIR}/../../tools/frontend/ensure-wasm.mjs" write-manifest

echo "Wasm artifacts emitted to ${OUT_DIR}"
