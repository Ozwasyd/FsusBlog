#!/usr/bin/env bash
set -euo pipefail

BINARYEN_VERSION="version_123"
BINARYEN_EXPECTED_VERSION="${BINARYEN_VERSION#version_}"
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
    Darwin:arm64 | Darwin:aarch64)
        ARCHIVE="binaryen-${BINARYEN_VERSION}-arm64-macos.tar.gz"
        ARCHIVE_SHA256="74428be348c1a09863e7b642a1fa948cabf8ec9561052233d8288e941951725b"
        ;;
    Darwin:x86_64)
        ARCHIVE="binaryen-${BINARYEN_VERSION}-x86_64-macos.tar.gz"
        ARCHIVE_SHA256="cc18b14d2b673d9c66bf54f31ff2b0ceb23ba5132455b893965ae2792f9e00dd"
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
if [[ -x "${WASM_OPT}" ]] && [[ "$("${WASM_OPT}" --version)" == *"${BINARYEN_EXPECTED_VERSION}"* ]]; then
    printf '%s\n' "${WASM_OPT}"
    exit 0
fi

mkdir -p "$(dirname "${LOCK_FILE}")"
LOCK_DIR=""
WORK_DIR=""
Cleanup() {
    [[ -z "${WORK_DIR}" ]] || rm -rf "${WORK_DIR}"
    [[ -z "${LOCK_DIR}" ]] || rm -rf "${LOCK_DIR}"
}
trap Cleanup EXIT
if command -v flock >/dev/null 2>&1; then
    exec 9>"${LOCK_FILE}"
    flock 9
else
    LOCK_DIR="${LOCK_FILE}.d"
    acquired=0
    for _ in {1..600}; do
        if mkdir "${LOCK_DIR}" 2>/dev/null; then
            printf '%s\n' "$$" >"${LOCK_DIR}/owner.pid"
            acquired=1
            break
        fi
        owner_pid="$(cat "${LOCK_DIR}/owner.pid" 2>/dev/null || true)"
        if [[ "${owner_pid}" =~ ^[0-9]+$ ]] && ! kill -0 "${owner_pid}" 2>/dev/null; then
            rm -rf "${LOCK_DIR}"
            continue
        fi
        sleep 0.1
    done
    [[ "${acquired}" == "1" ]] || {
        echo "[ensure-binaryen] timed out waiting for dependency cache lock" >&2
        exit 1
    }
fi

if [[ -x "${WASM_OPT}" ]] && [[ "$("${WASM_OPT}" --version)" == *"${BINARYEN_EXPECTED_VERSION}"* ]]; then
    printf '%s\n' "${WASM_OPT}"
    exit 0
fi

WORK_DIR="$(mktemp -d "${CACHE_ROOT}/binaryen/.${BINARYEN_VERSION}.install.XXXXXX")"
URL="https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/${ARCHIVE}"
echo "[ensure-binaryen] installing pinned Binaryen ${BINARYEN_VERSION}" >&2
curl --fail --location --silent --show-error "${URL}" --output "${WORK_DIR}/${ARCHIVE}"
if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "${WORK_DIR}/${ARCHIVE}" | awk '{print $1}')"
else
    actual_sha256="$(shasum -a 256 "${WORK_DIR}/${ARCHIVE}" | awk '{print $1}')"
fi
[[ "${actual_sha256}" == "${ARCHIVE_SHA256}" ]] || {
    echo "[ensure-binaryen] archive checksum mismatch" >&2
    exit 1
}
tar -xzf "${WORK_DIR}/${ARCHIVE}" -C "${WORK_DIR}"
EXTRACTED_ROOT="${WORK_DIR}/binaryen-${BINARYEN_VERSION}"
[[ -x "${EXTRACTED_ROOT}/bin/${WASM_OPT_NAME}" ]] || {
    echo "[ensure-binaryen] archive does not contain bin/wasm-opt" >&2
    exit 1
}
rm -rf "${BINARYEN_ROOT}"
mv "${EXTRACTED_ROOT}" "${BINARYEN_ROOT}"
[[ "$("${WASM_OPT}" --version)" == *"${BINARYEN_EXPECTED_VERSION}"* ]] || {
    echo "[ensure-binaryen] installed version does not match ${BINARYEN_VERSION}" >&2
    exit 1
}
printf '%s\n' "${WASM_OPT}"
