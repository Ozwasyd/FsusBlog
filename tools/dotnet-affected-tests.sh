#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_TEST_PROJ="$ROOT_DIR/tests/backend/FsusBlog.Server.Tests.csproj"
BUILD_ENV_RUNNER="$ROOT_DIR/tools/build-with-data-env.sh"
BASE_REF="${FSUSBLOG_BASE_REF:-origin/main}"
CACHE_DIR="$ROOT_DIR/.tmp/test-cache"
TEST_LIST_FILE="$CACHE_DIR/dotnet-tests.txt"

log() {
  printf '[dotnet:affected] %s\n' "$1"
}

resolve_base() {
  if git -C "$ROOT_DIR" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
    git -C "$ROOT_DIR" merge-base "$BASE_REF" HEAD
    return
  fi

  git -C "$ROOT_DIR" rev-parse HEAD
}

collect_changed_files() {
  local base
  base="$(resolve_base)"
  {
    git -C "$ROOT_DIR" diff --name-only "$base"...HEAD
    git -C "$ROOT_DIR" diff --name-only
    git -C "$ROOT_DIR" diff --cached --name-only
  } | awk 'NF' | sort -u
}

mkdir -p "$CACHE_DIR"
if [[ ! -s "$TEST_LIST_FILE" || "${FSUSBLOG_REFRESH_TEST_LIST:-0}" == "1" ]]; then
  log "refreshing dotnet test list cache"
  "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --no-build --list-tests >"$TEST_LIST_FILE" || true
fi

mapfile -t changed_files < <(collect_changed_files)

if (( ${#changed_files[@]} == 0 )); then
  log "no changed files detected; skipping non-integration dotnet tests"
  exit 0
fi

requires_full=0
for file in "${changed_files[@]}"; do
  case "$file" in
    src/backend/*|src/shared/*|src/core/*|tests/backend/*|*.sln|*.slnx|Directory.Build.props|Directory.Packages.props|global.json)
      requires_full=1
      ;;
  esac
done

if (( requires_full == 0 )); then
  log "changes do not touch server/shared/core/test code; skipping non-integration dotnet tests"
  exit 0
fi

log "server/shared/core changes detected; running full non-integration dotnet tests"
"$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" -c Debug -v minimal --no-build --filter "Category!=Integration"
