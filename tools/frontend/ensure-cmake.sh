#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMAKE_VERSION="4.3.3"
CACHE_ROOT="${FSUSBLOG_DEPENDENCY_CACHE_ROOT:-${ROOT_DIR}/.tmp/dependency-cache}"
CMAKE_ROOT="${CACHE_ROOT}/cmake/${CMAKE_VERSION}"
CMAKE_BIN="${CMAKE_ROOT}/bin/cmake"
LOCK_FILE="${CACHE_ROOT}/cmake/${CMAKE_VERSION}.lock"

IsValidCmakeCache() {
    [[ -x "${CMAKE_BIN}" ]] &&
        [[ "$("${CMAKE_BIN}" --version 2>/dev/null | head -n 1)" == "cmake version ${CMAKE_VERSION}" ]]
}

case "$(uname -m)" in
    x86_64 | amd64)
        ARCHIVE_ARCH="x86_64"
        ARCHIVE_SHA256="927b2368a946c37269c3a66225ab00544e756459cdd0b5d0da438694fb9ff802"
        ;;
    aarch64 | arm64)
        ARCHIVE_ARCH="aarch64"
        ARCHIVE_SHA256="9ea38356dbd3e32e51029a3e09a0f2f8e117ef4fbcaad7a21ffb36409bbd5cb4"
        ;;
    *)
        echo "[ensure-cmake] unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

if IsValidCmakeCache; then
    printf '%s\n' "${CMAKE_BIN}"
    exit 0
fi

for command in curl flock sha256sum tar; do
    if ! command -v "${command}" >/dev/null 2>&1; then
        echo "[ensure-cmake] missing required command: ${command}" >&2
        exit 1
    fi
done

mkdir -p "$(dirname "${CMAKE_ROOT}")"
exec 9>"${LOCK_FILE}"
flock 9

if IsValidCmakeCache; then
    printf '%s\n' "${CMAKE_BIN}"
    exit 0
fi

if [[ -e "${CMAKE_ROOT}" || -L "${CMAKE_ROOT}" ]]; then
    rm -rf "${CMAKE_ROOT}"
fi

ARCHIVE_NAME="cmake-${CMAKE_VERSION}-linux-${ARCHIVE_ARCH}.tar.gz"
PRIMARY_ARCHIVE_URL="https://cmake.org/files/v4.3/${ARCHIVE_NAME}"
CURL_CONNECT_TIMEOUT_SECONDS="5"
CURL_MAX_TIME_SECONDS="120"
WORK_DIR="$(mktemp -d "${CACHE_ROOT}/cmake/.${CMAKE_VERSION}.install.XXXXXX")"
ARCHIVE_PATH="${WORK_DIR}/${ARCHIVE_NAME}"
Cleanup() {
    rm -rf "${WORK_DIR}"
}
trap Cleanup EXIT

FetchArchive() {
    local archiveUrl="$1"

    rm -f "${ARCHIVE_PATH}"
    if ! curl -fsSL \
        --connect-timeout "${CURL_CONNECT_TIMEOUT_SECONDS}" \
        --max-time "${CURL_MAX_TIME_SECONDS}" \
        "${archiveUrl}" \
        -o "${ARCHIVE_PATH}"; then
        rm -f "${ARCHIVE_PATH}"
        return 1
    fi
}

echo "[ensure-cmake] installing pinned CMake ${CMAKE_VERSION} into dependency cache" >&2
if ! FetchArchive "${PRIMARY_ARCHIVE_URL}"; then
    echo "[ensure-cmake] pinned CMake archive transfer failed on its first attempt" >&2
    exit 1
fi

if ! printf '%s  %s\n' "${ARCHIVE_SHA256}" "${ARCHIVE_PATH}" | sha256sum -c - >/dev/null; then
    echo "[ensure-cmake] downloaded CMake archive failed checksum verification" >&2
    exit 1
fi

mkdir -p "${WORK_DIR}/root"
tar -xzf "${ARCHIVE_PATH}" --strip-components=1 -C "${WORK_DIR}/root"
[[ -x "${WORK_DIR}/root/bin/cmake" ]] || {
    echo "[ensure-cmake] downloaded archive does not contain bin/cmake" >&2
    exit 1
}

# The lock serializes publishers; rename on the same filesystem makes the
# fully verified directory visible atomically to future fresh runs.
if [[ -e "${CMAKE_ROOT}" || -L "${CMAKE_ROOT}" ]]; then
    echo "[ensure-cmake] refusing to replace conflicting CMake cache root: ${CMAKE_ROOT}" >&2
    exit 1
fi
mv "${WORK_DIR}/root" "${CMAKE_ROOT}"
printf '%s\n' "${CMAKE_BIN}"
