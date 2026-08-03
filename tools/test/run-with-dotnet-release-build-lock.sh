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
if command -v flock >/dev/null 2>&1; then
    # `--close` keeps compiler/build-server descendants from inheriting the lock
    # descriptor after the foreground build has settled.
    flock --exclusive --close "$LOCK_FILE" "$@"
    exit $?
fi

# macOS does not ship `flock`. An atomic directory provides the same single-host
# exclusion without allowing descendants to inherit an open lock descriptor.
PORTABLE_LOCK_DIRECTORY="${LOCK_FILE}.directory"
LOCK_DEADLINE=$((SECONDS + 300))
until mkdir "$PORTABLE_LOCK_DIRECTORY" 2>/dev/null; do
    if ((SECONDS >= LOCK_DEADLINE)); then
        printf '[dotnet-release-build-lock] timed out waiting for %s\n' "$PORTABLE_LOCK_DIRECTORY" >&2
        exit 73
    fi
    sleep 0.1
done
trap 'rmdir "$PORTABLE_LOCK_DIRECTORY" 2>/dev/null || true' EXIT INT TERM
"$@"
