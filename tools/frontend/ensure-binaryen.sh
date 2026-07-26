#!/usr/bin/env bash
set -euo pipefail

BINARYEN_VERSION="version_123"
CACHE_ROOT="${FSUSBLOG_DEPENDENCY_CACHE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.tmp/dependency-cache}"
BINARYEN_ROOT="${CACHE_ROOT}/binaryen/${BINARYEN_VERSION}"
LOCK_FILE="${CACHE_ROOT}/binaryen/${BINARYEN_VERSION}.lock"

WASM_OPT_NAME="wasm-opt"
case "$(uname -s):$(uname -m)" in
    Linux:x86_64)
        ARCHIVE="binaryen-${BINARYEN_VERSION}-x86_64-linux.tar.gz"
        ARCHIVE_SHA256="e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe"
        ;;
    Linux:aarch64 | Linux:arm64)
        ARCHIVE="binaryen-${BINARYEN_VERSION}-aarch64-linux.tar.gz"
        ARCHIVE_SHA256="4b6bd61ba6cd3b18c993b4657d93426c782f9b91b74be0d38018cd8be1319376"
        ;;
    MSYS_NT-*:x86_64)
        ARCHIVE="binaryen-${BINARYEN_VERSION}-x86_64-windows.tar.gz"
        ARCHIVE_SHA256="7b3568424a0f871a52865d5c78177db646b1832a8c487321e27703103f936880"
        WASM_OPT_NAME="wasm-opt.exe"
        ;;
    *)
        echo "[ensure-binaryen] unsupported host: $(uname -s) $(uname -m)" >&2
        exit 1
        ;;
esac

WASM_OPT="${BINARYEN_ROOT}/bin/${WASM_OPT_NAME}"
if [[ -x "${WASM_OPT}" ]] && [[ "$("${WASM_OPT}" --version)" == *"123"* ]]; then
    printf '%s\n' "${WASM_OPT}"
    exit 0
fi

mkdir -p "$(dirname "${LOCK_FILE}")"
exec 9>"${LOCK_FILE}"
flock 9

if [[ -x "${WASM_OPT}" ]] && [[ "$("${WASM_OPT}" --version)" == *"123"* ]]; then
    printf '%s\n' "${WASM_OPT}"
    exit 0
fi

WORK_DIR="$(mktemp -d "${CACHE_ROOT}/binaryen/.${BINARYEN_VERSION}.install.XXXXXX")"
trap 'rm -rf "${WORK_DIR}"' EXIT
URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/${ARCHIVE}"
echo "[ensure-binaryen] installing pinned Binaryen ${BINARYEN_VERSION}" >&2
curl --fail --location --silent --show-error "${URL}" --output "${WORK_DIR}/${ARCHIVE}"
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${WORK_DIR}/${ARCHIVE}" | sha256sum -c - >/dev/null
tar -xzf "${WORK_DIR}/${ARCHIVE}" -C "${WORK_DIR}"
EXTRACTED_ROOT="${WORK_DIR}/binaryen-${BINARYEN_VERSION}"
[[ -x "${EXTRACTED_ROOT}/bin/${WASM_OPT_NAME}" ]] || {
    echo "[ensure-binaryen] archive does not contain bin/wasm-opt" >&2
    exit 1
}
rm -rf "${BINARYEN_ROOT}"
mv "${EXTRACTED_ROOT}" "${BINARYEN_ROOT}"
[[ "$("${WASM_OPT}" --version)" == *"123"* ]] || {
    echo "[ensure-binaryen] installed version does not match ${BINARYEN_VERSION}" >&2
    exit 1
}
printf '%s\n' "${WASM_OPT}"
