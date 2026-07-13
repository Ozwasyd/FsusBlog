#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMAKE_VERSION="4.1.2"
CACHE_ROOT="${FSUSBLOG_DEPENDENCY_CACHE_ROOT:-${ROOT_DIR}/.tmp/dependency-cache}"
CMAKE_ROOT="${CACHE_ROOT}/cmake/${CMAKE_VERSION}"
CMAKE_BIN="${CMAKE_ROOT}/bin/cmake"
LOCK_FILE="${CACHE_ROOT}/cmake/${CMAKE_VERSION}.lock"

case "$(uname -m)" in
  x86_64|amd64)
    ARCHIVE_ARCH="x86_64"
    ARCHIVE_SHA256="773cc679c3a7395413bd096523f8e5d6c39f8718af4e12eb4e4195f72f35e4ab"
    ;;
  aarch64|arm64)
    ARCHIVE_ARCH="aarch64"
    ARCHIVE_SHA256="0634996f918b3bab11f45522899c81c987b09c9a64d15f6a0d2bb51c42099534"
    ;;
  *)
    echo "[ensure-cmake] unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [[ -x "${CMAKE_BIN}" ]]; then
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

if [[ -x "${CMAKE_BIN}" ]]; then
  printf '%s\n' "${CMAKE_BIN}"
  exit 0
fi

ARCHIVE_NAME="cmake-${CMAKE_VERSION}-linux-${ARCHIVE_ARCH}.tar.gz"
ARCHIVE_URL="https://cmake.org/files/v4.1/${ARCHIVE_NAME}"
WORK_DIR="$(mktemp -d "${CACHE_ROOT}/cmake/.${CMAKE_VERSION}.install.XXXXXX")"
cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

echo "[ensure-cmake] installing pinned CMake ${CMAKE_VERSION} into dependency cache" >&2
curl -fsSL --retry 3 --retry-delay 1 "${ARCHIVE_URL}" -o "${WORK_DIR}/${ARCHIVE_NAME}"
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${WORK_DIR}/${ARCHIVE_NAME}" | sha256sum -c - >/dev/null
mkdir -p "${WORK_DIR}/root"
tar -xzf "${WORK_DIR}/${ARCHIVE_NAME}" --strip-components=1 -C "${WORK_DIR}/root"
[[ -x "${WORK_DIR}/root/bin/cmake" ]] || {
  echo "[ensure-cmake] downloaded archive does not contain bin/cmake" >&2
  exit 1
}

# The lock serializes publishers; rename on the same filesystem makes the
# fully verified directory visible atomically to future fresh runs.
mv "${WORK_DIR}/root" "${CMAKE_ROOT}"
printf '%s\n' "${CMAKE_BIN}"
