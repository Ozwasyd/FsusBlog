#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_ROOT="${ROOT_DIR}/wasm"
WASM_SOURCE_DIR="${WASM_ROOT}"
WASM_POW_SOURCE_DIR="${WASM_ROOT}/pow"
RUN_WASM_ROOT="${FSUSBLOG_WASM_ARTIFACT_ROOT:-${WASM_ROOT}}"
OUT_DIR="${FSUSBLOG_FRONTEND_WASM_ROOT:-${ROOT_DIR}/public/wasm}"
BUILD_SIMD_DIR="${RUN_WASM_ROOT}/build-simd"
BUILD_BASIC_DIR="${RUN_WASM_ROOT}/build-basic"
BUILD_RELAXED_POW_DIR="${RUN_WASM_ROOT}/build-pow-relaxed"
BUILD_THREADS_POW_DIR="${RUN_WASM_ROOT}/build-pow-threads"
STAGE_DIR="${RUN_WASM_ROOT}/stage"
STAGE_SIMD_DIR="${STAGE_DIR}/wasm-simd"
STAGE_BASIC_DIR="${STAGE_DIR}/wasm-basic"
STAGE_RELAXED_POW_DIR="${STAGE_DIR}/wasm-pow-relaxed"
STAGE_THREADS_POW_DIR="${STAGE_DIR}/wasm-pow-threads"
BUILD_IMAGE_CODEC="${FSUSBLOG_WASM_IMAGE_CODEC_ENABLE:-ON}"
COMMENT_PRIVACY_PROVER_KEY="${FSUSBLOG_COMMENT_PROVER_KEY:-${ROOT_DIR}/../../artifacts/zk/comment-v2/comment_v2_final.fsg16pk}"

detect_cpu_count() {
  local detected=""
  if command -v nproc >/dev/null 2>&1; then
    detected="$(nproc)"
  elif command -v getconf >/dev/null 2>&1; then
    detected="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
  fi
  if [[ "${detected}" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "${detected}"
  else
    printf '1\n'
  fi
}

resolve_cpu_budget() {
  local detected_cpu
  detected_cpu="$(detect_cpu_count)"
  IFS=$'\t' read -r \
    WASM_CPU_BUDGET \
    WASM_CPU_BUDGET_SOURCE \
    WASM_MEMORY_BUDGET_GIB \
    WASM_MEMORY_BUDGET_SOURCE \
    WASM_MEMORY_WORKER_LIMIT \
    WASM_VARIANT_WORKERS \
    < <(FSUSBLOG_WASM_DETECTED_CPU="${detected_cpu}" "${FSUSBLOG_NODE:-node}" --input-type=module <<'NODE'
import os from 'node:os'

const positive = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
const hostCpu = Math.max(1, Math.floor(positive(process.env.FSUSBLOG_WASM_DETECTED_CPU)
  ?? os.availableParallelism?.()
  ?? os.cpus().length))
const cpuVariables = [
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_WASM_CPU_BUDGET',
  'FSUSBLOG_BUILD_CPU_BUDGET',
  'FSUSBLOG_BUILD_MAX_WORKERS',
  'FSUSBLOG_BUNDLE_CPU_UNITS',
  'FSUSBLOG_BUNDLE_CPU_BUDGET',
  'FSUSBLOG_BUNDLE_MAX_WORKERS',
  'FSUSBLOG_VITEST_MAX_WORKERS'
]
const selectedCpu = cpuVariables
  .map((name) => ({ name, value: positive(process.env[name]) }))
  .find((entry) => entry.value !== null)
const cpuBudget = Math.max(1, Math.min(hostCpu, Math.floor(selectedCpu?.value ?? hostCpu)))
const freeMemoryGiB = os.freemem() / (1024 ** 3)
const totalMemoryGiB = os.totalmem() / (1024 ** 3)
const memoryVariables = ['FSUSBLOG_STEP_MEMORY_GIB', 'FSUSBLOG_BUNDLE_MEMORY_GIB']
const selectedMemory = memoryVariables
  .map((name) => ({ name, value: positive(process.env[name]) }))
  .find((entry) => entry.value !== null)
const memoryBudgetGiB = Math.min(freeMemoryGiB, selectedMemory?.value ?? freeMemoryGiB)
const memoryGiBPerCpu = totalMemoryGiB / hostCpu
const schedulerManaged = selectedCpu !== undefined && selectedMemory !== undefined
  && ['FSUSBLOG_STEP_CPU_BUDGET', 'FSUSBLOG_BUNDLE_CPU_UNITS', 'FSUSBLOG_BUNDLE_CPU_BUDGET'].includes(selectedCpu.name)
  && ['FSUSBLOG_STEP_MEMORY_GIB', 'FSUSBLOG_BUNDLE_MEMORY_GIB'].includes(selectedMemory.name)
// A complete scheduler grant has already been admitted against live CPU and
// memory. Applying the host-average memory-per-CPU ratio again would reject
// the scheduler's deliberately packed 2-CPU build grant and serialize all
// variants. Direct invocation still needs the host-derived memory guard.
const memoryWorkerLimit = schedulerManaged
  ? cpuBudget
  : Math.max(1, Math.floor(memoryBudgetGiB / memoryGiBPerCpu))
const variantWorkers = Math.max(1, Math.min(4, cpuBudget, memoryWorkerLimit))
process.stdout.write(`${[
  cpuBudget,
  selectedCpu?.name ?? 'detected-cpu',
  memoryBudgetGiB.toFixed(6),
  selectedMemory?.name ?? 'detected-free-memory',
  memoryWorkerLimit,
  variantWorkers
].join('\t')}\n`)
NODE
  )
}

print_resource_plan() {
  local remaining=4 wave=1 active base extra index jobs total child_memory
  printf '[build:wasm] cpu_budget=%s source=%s memory_budget_gib=%s memory_source=%s memory_worker_limit=%s variant_workers=%s variants=4\n' \
    "${WASM_CPU_BUDGET}" "${WASM_CPU_BUDGET_SOURCE}" \
    "${WASM_MEMORY_BUDGET_GIB}" "${WASM_MEMORY_BUDGET_SOURCE}" \
    "${WASM_MEMORY_WORKER_LIMIT}" "${WASM_VARIANT_WORKERS}"
  while (( remaining > 0 )); do
    active="${WASM_VARIANT_WORKERS}"
    if (( active > remaining )); then
      active="${remaining}"
    fi
    child_memory="$("${FSUSBLOG_NODE:-node}" -e 'process.stdout.write((Number(process.argv[1])/Number(process.argv[2])).toFixed(6))' "${WASM_MEMORY_BUDGET_GIB}" "${active}")"
    base=$((WASM_CPU_BUDGET / active))
    extra=$((WASM_CPU_BUDGET % active))
    total=0
    printf '[build:wasm] wave=%s jobs=' "${wave}"
    for ((index = 0; index < active; index += 1)); do
      jobs="${base}"
      if (( index < extra )); then
        jobs=$((jobs + 1))
      fi
      (( index > 0 )) && printf ','
      printf '%s' "${jobs}"
      total=$((total + jobs))
    done
    printf ' total=%s memory_gib_per_child=%s\n' "${total}" "${child_memory}"
    remaining=$((remaining - active))
    wave=$((wave + 1))
  done
}

resolve_cpu_budget
if [[ "${1:-}" == "--check-source-paths" ]]; then
  [[ -f "${WASM_SOURCE_DIR}/CMakeLists.txt" ]] || {
    echo "[build:wasm] missing wasm source: ${WASM_SOURCE_DIR}/CMakeLists.txt" >&2
    exit 1
  }
  [[ -f "${WASM_POW_SOURCE_DIR}/CMakeLists.txt" ]] || {
    echo "[build:wasm] missing pow wasm source: ${WASM_POW_SOURCE_DIR}/CMakeLists.txt" >&2
    exit 1
  }
  printf '[build:wasm] source-paths ok wasm=%s pow=%s artifact-root=%s\n' \
    "${WASM_SOURCE_DIR}" "${WASM_POW_SOURCE_DIR}" "${RUN_WASM_ROOT}"
  exit 0
fi
if [[ "${1:-}" == "--print-resource-plan" ]]; then
  print_resource_plan
  exit 0
fi

if [[ ! -f "${COMMENT_PRIVACY_PROVER_KEY}" ]]; then
  echo "[build:wasm] comment privacy proving key is missing: ${COMMENT_PRIVACY_PROVER_KEY}" >&2
  exit 1
fi

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
  "${OUT_DIR}/aeds_decoder"_*.js \
  "${OUT_DIR}/aeds_decoder"_*.wasm \
  "${OUT_DIR}/aeds-runtime-manifest.json" \
  "${OUT_DIR}/fsus_pow_"*.js \
  "${OUT_DIR}/fsus_pow_"*.wasm \
  "${OUT_DIR}/search_"*.js \
  "${OUT_DIR}/search_"*.wasm \
  "${OUT_DIR}/image_codec_"*.js \
  "${OUT_DIR}/image_codec_"*.wasm \
  "${OUT_DIR}/comment-privacy-prover.js" \
  "${OUT_DIR}/comment-privacy-prover.zkey" \
  "${OUT_DIR}/comment-privacy-prover.manifest.json" \
  "${OUT_DIR}/comment_privacy_runtime.js" \
  "${OUT_DIR}/comment_privacy_runtime.wasm"

if [[ -n "${FSUSBLOG_EM_CACHE:-}" ]]; then
  export EM_CACHE="${FSUSBLOG_EM_CACHE}"
else
  # Keep Emscripten's compiler cache on a physical repository path. The test
  # artifact root may be a tmpfs symlink on disk-constrained hosts; Emscripten
  # otherwise emits SDK source paths relative to the symlink spelling and
  # resolves them from the CMake build directory, breaking fresh system-library
  # generation. This ignored dependency cache intentionally survives fresh
  # output cleanup, matching the already-installed toolchain contract.
  export EM_CACHE="${ROOT_DIR}/../../.cache/emscripten"
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

version_less_than() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" == "$1" && "$1" != "$2" ]]
}

cmake_is_supported() {
  local candidate="$1" version
  [[ -x "${candidate}" ]] || return 1
  version="$(${candidate} --version 2>/dev/null | head -n 1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
  [[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  # Every configure path below uses `cmake --fresh`, which was introduced in
  # CMake 3.24. Reusing an older distro CMake makes the container build fail
  # only after the expensive codec dependency bootstrap has completed.
  if version_less_than "${version}" "3.24.0"; then
    return 1
  fi
  if ! version_less_than "${version}" "4.2.0" && version_less_than "${version}" "4.3.3"; then
    return 1
  fi
  CMAKE_VERSION="${version}"
  return 0
}

select_cmake() {
  local candidate resolved
  if [[ -n "${FSUSBLOG_WASM_CMAKE:-}" ]]; then
    candidate="${FSUSBLOG_WASM_CMAKE}"
    resolved="$(readlink -f "${candidate}" 2>/dev/null || printf '%s' "${candidate}")"
    if cmake_is_supported "${resolved}"; then
      CMAKE_BIN="${resolved}"
      return
    fi
    echo "[build:wasm] FSUSBLOG_WASM_CMAKE is missing or unsupported: ${candidate}" >&2
    exit 1
  fi

  candidate="$(command -v cmake 2>/dev/null || true)"
  if [[ -n "${candidate}" ]]; then
    resolved="$(readlink -f "${candidate}" 2>/dev/null || printf '%s' "${candidate}")"
    if cmake_is_supported "${resolved}"; then
      CMAKE_BIN="${resolved}"
      return
    fi
  fi

  candidate="$("${ROOT_DIR}/../../tools/frontend/ensure-cmake.sh")"
  resolved="$(readlink -f "${candidate}" 2>/dev/null || printf '%s' "${candidate}")"
  if cmake_is_supported "${resolved}"; then
    CMAKE_BIN="${resolved}"
    return
  fi

  echo "[build:wasm] dependency bootstrap returned an unsupported CMake: ${resolved}" >&2
  exit 1
}

select_cmake
echo "[build:wasm] cmake=${CMAKE_BIN} version=${CMAKE_VERSION}"
print_resource_plan

WASM_OPT_BIN="${FSUSBLOG_WASM_OPT:-}"
if [[ -z "${WASM_OPT_BIN}" ]]; then
  WASM_OPT_BIN="$("${ROOT_DIR}/../../tools/frontend/ensure-binaryen.sh")"
fi
[[ -x "${WASM_OPT_BIN}" ]] || {
  echo "[build:wasm] pinned wasm-opt is missing: ${WASM_OPT_BIN}" >&2
  exit 1
}
WASM_OPT_VERSION="$(${WASM_OPT_BIN} --version)"
[[ "${WASM_OPT_VERSION}" == *"123"* ]] || {
  echo "[build:wasm] wasm-opt must be pinned to Binaryen version 123, got: ${WASM_OPT_VERSION}" >&2
  exit 1
}
EMSCRIPTEN_VERSION="$(emcc --version | sed -nE '1s/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/p')"
[[ -n "${EMSCRIPTEN_VERSION}" ]] || {
  echo "[build:wasm] unable to resolve Emscripten version" >&2
  exit 1
}
export FSUSBLOG_WASM_TOOLCHAIN_EMSCRIPTEN="${EMSCRIPTEN_VERSION}"
export FSUSBLOG_WASM_TOOLCHAIN_BINARYEN="123"
export FSUSBLOG_WASM_TOOLCHAIN_CMAKE="${CMAKE_VERSION}"
export FSUSBLOG_WASM_TOOLCHAIN_VCPKG="${FSUSBLOG_VCPKG_COMMIT:-eae1680538b86f962455c27abca2aad0dc304a4d}"
export FSUSBLOG_WASM_TOOLCHAIN_EMSDK_IMAGE="emscripten/emsdk:4.0.13@sha256:520088b81877b610389dfd4cf7fb8c69f3ae41a611b0f80e222f57dafd930973"
echo "[build:wasm] emscripten=${EMSCRIPTEN_VERSION} binaryen=${WASM_OPT_VERSION}"

if [[ "${FSUSBLOG_WASM_DISABLE_VCPKG_AUTODETECT:-0}" != "1" ]]; then
  VCPKG_ROOT_CANDIDATE="${VCPKG_ROOT:-/home/dev/vcpkg}"
  if [[ -d "${VCPKG_ROOT_CANDIDATE}/installed/wasm32-emscripten" ]]; then
    USER_CMAKE_ARGS+=("-DCMAKE_PREFIX_PATH=${VCPKG_ROOT_CANDIDATE}/installed/wasm32-emscripten")
  fi
fi

optimize_pow_wasm() {
  local file="$1"
  local tmp="${file}.opt"
  local name
  name="$(basename "${file}")"
  local feature_args=(--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext)
  case "${name}" in
    fsus_pow_simd.wasm)
      feature_args+=(--enable-simd)
      ;;
    fsus_pow_relaxed.wasm)
      feature_args+=(--enable-simd --enable-relaxed-simd)
      ;;
    fsus_pow_threads.wasm)
      feature_args+=(--enable-simd --enable-threads)
      ;;
  esac
  if "${WASM_OPT_BIN}" -O4 "${feature_args[@]}" "${file}" -o "${tmp}" >/dev/null 2>&1; then
    mv -f "${tmp}" "${file}"
  else
    rm -f "${tmp}"
    echo "[build:wasm] wasm-opt skipped for ${file}" >&2
  fi
}

optimize_aeds_speed_wasm() {
  local file="$1"
  local tmp="${file}.opt"
  rm -f "${tmp}"
  if ! "${WASM_OPT_BIN}" -O4 \
    --enable-simd \
    --enable-bulk-memory \
    --enable-nontrapping-float-to-int \
    "${file}" -o "${tmp}"; then
    rm -f "${tmp}"
    echo "[build:wasm] mandatory AEDS speed wasm-opt failed: ${file}" >&2
    return 1
  fi
  mv -f "${tmp}" "${file}"
}

optimize_pow_wasm_parallel() {
  local files=("$@")
  local file_index=0 remaining active child_memory_gib slot
  local optimize_pids=() optimize_files=() failed_optimizations=()
  while (( file_index < ${#files[@]} )); do
    remaining=$((${#files[@]} - file_index))
    active="${WASM_VARIANT_WORKERS}"
    (( active > remaining )) && active="${remaining}"
    child_memory_gib="$("${FSUSBLOG_NODE:-node}" -e 'process.stdout.write((Number(process.argv[1])/Number(process.argv[2])).toFixed(6))' "${WASM_MEMORY_BUDGET_GIB}" "${active}")"
    optimize_pids=()
    optimize_files=()
    for ((slot = 0; slot < active; slot += 1)); do
      FSUSBLOG_STEP_CPU_BUDGET=1 \
        FSUSBLOG_STEP_MEMORY_GIB="${child_memory_gib}" \
        FSUSBLOG_COMMAND_MANIFEST_WORKERS=1 \
        FSUSBLOG_NODE_TEST_CONCURRENCY=1 \
        optimize_pow_wasm "${files[file_index]}" &
      optimize_pids+=("$!")
      optimize_files+=("${files[file_index]}")
      file_index=$((file_index + 1))
    done
    for ((slot = 0; slot < ${#optimize_pids[@]}; slot += 1)); do
      if ! wait "${optimize_pids[slot]}"; then
        failed_optimizations+=("${optimize_files[slot]}")
      fi
    done
  done
  if (( ${#failed_optimizations[@]} > 0 )); then
    printf '[build:wasm] %s wasm optimizations failed: %s\n' \
      "${#failed_optimizations[@]}" "${failed_optimizations[*]}" >&2
    return 1
  fi
}

build_simd() {
  local jobs="$1"
  local targets=(
    FsusPowEngine
    aeds_decoder_speed
    FsusSearchRuntime
    FsusCommentPrivacyRuntime
  )
  if [[ "${BUILD_IMAGE_CODEC}" == "ON" || "${BUILD_IMAGE_CODEC}" == "1" || "${BUILD_IMAGE_CODEC}" == "TRUE" ]]; then
    targets+=(FsusImageCodec)
  fi
  cd "${BUILD_SIMD_DIR}"
  emcmake "${CMAKE_BIN}" --fresh "${WASM_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWASM_SIMD=ON \
    -DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE="${BUILD_IMAGE_CODEC}" \
    -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_SIMD_DIR}" \
    "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
  "${CMAKE_BIN}" --build . --target "${targets[@]}" --parallel "${jobs}"
}

build_basic() {
  local jobs="$1"
  # The scalar publication contract carries the compatibility-first AEDS tier.
  local targets=(
    FsusPowEngine
    aeds_decoder_basic
    FsusSearchRuntime
  )
  if [[ "${BUILD_IMAGE_CODEC}" == "ON" || "${BUILD_IMAGE_CODEC}" == "1" || "${BUILD_IMAGE_CODEC}" == "TRUE" ]]; then
    targets+=(FsusImageCodec)
  fi
  cd "${BUILD_BASIC_DIR}"
  emcmake "${CMAKE_BIN}" --fresh "${WASM_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWASM_SIMD=OFF \
    -DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE="${BUILD_IMAGE_CODEC}" \
    -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_BASIC_DIR}" \
    "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
  "${CMAKE_BIN}" --build . --target "${targets[@]}" --parallel "${jobs}"
}

build_relaxed_pow() {
  local jobs="$1"
  cd "${BUILD_RELAXED_POW_DIR}"
  emcmake "${CMAKE_BIN}" --fresh "${WASM_POW_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWASM_RELAXED_SIMD=ON \
    -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_RELAXED_POW_DIR}" \
    "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
  "${CMAKE_BIN}" --build . --parallel "${jobs}"
}

build_threads_pow() {
  local jobs="$1"
  cd "${BUILD_THREADS_POW_DIR}"
  emcmake "${CMAKE_BIN}" --fresh "${WASM_POW_SOURCE_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWASM_THREADS=ON \
    -DFSUSBLOG_WASM_OUTPUT_DIR="${STAGE_THREADS_POW_DIR}" \
    "${USER_CMAKE_ARGS[@]+"${USER_CMAKE_ARGS[@]}"}"
  "${CMAKE_BIN}" --build . --parallel "${jobs}"
}

build_modes=(build_simd build_basic build_relaxed_pow build_threads_pow)
mode_index=0
failed_modes=()
while (( mode_index < ${#build_modes[@]} )); do
  remaining=$((${#build_modes[@]} - mode_index))
  active="${WASM_VARIANT_WORKERS}"
  (( active > remaining )) && active="${remaining}"
  base_jobs=$((WASM_CPU_BUDGET / active))
  extra_jobs=$((WASM_CPU_BUDGET % active))
  build_pids=()
  build_names=()
  child_memory_gib="$("${FSUSBLOG_NODE:-node}" -e 'process.stdout.write((Number(process.argv[1])/Number(process.argv[2])).toFixed(6))' "${WASM_MEMORY_BUDGET_GIB}" "${active}")"
  for ((slot = 0; slot < active; slot += 1)); do
    jobs="${base_jobs}"
    (( slot < extra_jobs )) && jobs=$((jobs + 1))
    build_name="${build_modes[mode_index]}"
    FSUSBLOG_STEP_CPU_BUDGET="${jobs}" \
      FSUSBLOG_STEP_MEMORY_GIB="${child_memory_gib}" \
      FSUSBLOG_COMMAND_MANIFEST_WORKERS="${jobs}" \
      FSUSBLOG_NODE_TEST_CONCURRENCY="${jobs}" \
      "${build_name}" "${jobs}" &
    build_pids+=("$!")
    build_names+=("${build_name}")
    mode_index=$((mode_index + 1))
  done

  for ((slot = 0; slot < ${#build_pids[@]}; slot += 1)); do
    if ! wait "${build_pids[slot]}"; then
      failed_modes+=("${build_names[slot]}")
    fi
  done
done
if (( ${#failed_modes[@]} > 0 )); then
  printf '[build:wasm] %s build variants failed: %s\n' "${#failed_modes[@]}" "${failed_modes[*]}" >&2
  exit 1
fi

cp -f "${STAGE_SIMD_DIR}/aeds_decoder_speed.js" "${OUT_DIR}/aeds_decoder_speed.js"
cp -f "${STAGE_SIMD_DIR}/aeds_decoder_speed.wasm" "${OUT_DIR}/aeds_decoder_speed.wasm"
cp -f "${STAGE_BASIC_DIR}/aeds_decoder_basic.js" "${OUT_DIR}/aeds_decoder_basic.js"
cp -f "${STAGE_BASIC_DIR}/aeds_decoder_basic.wasm" "${OUT_DIR}/aeds_decoder_basic.wasm"
optimize_aeds_speed_wasm "${OUT_DIR}/aeds_decoder_speed.wasm"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.js" "${OUT_DIR}/fsus_pow_simd.js"
cp -f "${STAGE_SIMD_DIR}/fsus_pow_simd.wasm" "${OUT_DIR}/fsus_pow_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.js" "${OUT_DIR}/fsus_pow_basic.js"
cp -f "${STAGE_BASIC_DIR}/fsus_pow_basic.wasm" "${OUT_DIR}/fsus_pow_basic.wasm"
cp -f "${STAGE_RELAXED_POW_DIR}/fsus_pow_relaxed.js" "${OUT_DIR}/fsus_pow_relaxed.js"
cp -f "${STAGE_RELAXED_POW_DIR}/fsus_pow_relaxed.wasm" "${OUT_DIR}/fsus_pow_relaxed.wasm"
cp -f "${STAGE_THREADS_POW_DIR}/fsus_pow_threads.js" "${OUT_DIR}/fsus_pow_threads.js"
cp -f "${STAGE_THREADS_POW_DIR}/fsus_pow_threads.wasm" "${OUT_DIR}/fsus_pow_threads.wasm"
optimize_pow_wasm_parallel \
  "${OUT_DIR}/fsus_pow_basic.wasm" \
  "${OUT_DIR}/fsus_pow_simd.wasm" \
  "${OUT_DIR}/fsus_pow_relaxed.wasm" \
  "${OUT_DIR}/fsus_pow_threads.wasm"
cp -f "${STAGE_SIMD_DIR}/search_simd.js" "${OUT_DIR}/search_simd.js"
cp -f "${STAGE_SIMD_DIR}/search_simd.wasm" "${OUT_DIR}/search_simd.wasm"
cp -f "${STAGE_BASIC_DIR}/search_basic.js" "${OUT_DIR}/search_basic.js"
cp -f "${STAGE_BASIC_DIR}/search_basic.wasm" "${OUT_DIR}/search_basic.wasm"
cp -f "${STAGE_SIMD_DIR}/comment_privacy_runtime.js" "${OUT_DIR}/comment_privacy_runtime.js"
cp -f "${STAGE_SIMD_DIR}/comment_privacy_runtime.wasm" "${OUT_DIR}/comment_privacy_runtime.wasm"
cp -f "${WASM_ROOT}/comment_privacy/comment-privacy-prover.js" "${OUT_DIR}/comment-privacy-prover.js"
cp -f "${COMMENT_PRIVACY_PROVER_KEY}" "${OUT_DIR}/comment-privacy-prover.zkey"
if [[ "${BUILD_IMAGE_CODEC}" == "ON" || "${BUILD_IMAGE_CODEC}" == "1" || "${BUILD_IMAGE_CODEC}" == "TRUE" ]]; then
  cp -f "${STAGE_SIMD_DIR}/image_codec_simd.js" "${OUT_DIR}/image_codec_simd.js"
  cp -f "${STAGE_SIMD_DIR}/image_codec_simd.wasm" "${OUT_DIR}/image_codec_simd.wasm"
  cp -f "${STAGE_BASIC_DIR}/image_codec_basic.js" "${OUT_DIR}/image_codec_basic.js"
  cp -f "${STAGE_BASIC_DIR}/image_codec_basic.wasm" "${OUT_DIR}/image_codec_basic.wasm"
fi

node "${ROOT_DIR}/../../tools/frontend/write-comment-privacy-prover-manifest.mjs"
PROVER_BUNDLE="${FSUSBLOG_COMMENT_PROVER_BUNDLE:-${ROOT_DIR}/../../artifacts/zk/comment-v2/comment_v2_prover_wasm.tar.gz}"
mkdir -p "$(dirname "${PROVER_BUNDLE}")"
PROVER_BUNDLE_TAR="${PROVER_BUNDLE}.tmp-$$.tar"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode=0644 \
  -C "${OUT_DIR}" -cf "${PROVER_BUNDLE_TAR}" \
  comment-privacy-prover.js \
  comment_privacy_runtime.js \
  comment_privacy_runtime.wasm \
  comment-privacy-prover.zkey \
  comment-privacy-prover.manifest.json
gzip -n -9 -f "${PROVER_BUNDLE_TAR}"
mv -f "${PROVER_BUNDLE_TAR}.gz" "${PROVER_BUNDLE}"
node "${ROOT_DIR}/../../tools/frontend/ensure-wasm.mjs" write-manifest

echo "Wasm artifacts emitted to ${OUT_DIR}"
