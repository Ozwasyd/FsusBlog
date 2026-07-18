#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_ROOT="${FSUSBLOG_PRODUCTION_BUILD_ROOT:-$ROOT_DIR/.tmp/build/local}"
LOCK_DIRECTORY="$BUILD_ROOT/coordination"
LOCK_FILE="$LOCK_DIRECTORY/dotnet-release-build.lock"

if (($# == 0)); then
    printf '[dotnet-release-build-lock] command is required\n' >&2
    exit 2
fi

mkdir -p "$LOCK_DIRECTORY"
# `--close` keeps compiler/build-server descendants from inheriting the lock
# descriptor after the foreground build has settled.
flock --exclusive --close "$LOCK_FILE" "$@"
