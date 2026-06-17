#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"
DUMP_PATH="${FSUS_LEGACY_20260517_DUMP_GZ:-$ROOT_DIR/.tmp/db_blog_20260517000000fjyfe.sql.gz}"
WORK_DIR="${FSUS_LEGACY_20260517_WORK_DIR:-$ROOT_DIR/.tmp/legacy-20260517-upgrade}"
DECOMPRESSED_DUMP="$WORK_DIR/db_blog_20260517000000fjyfe.pgcustom"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command gzip
require_command docker
require_command dotnet

if [[ ! -f "$DUMP_PATH" ]]; then
  echo "legacy dump not found: $DUMP_PATH" >&2
  echo "set FSUS_LEGACY_20260517_DUMP_GZ to the uploaded db_blog_20260517000000fjyfe.sql.gz path" >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
gzip -cd "$DUMP_PATH" > "$DECOMPRESSED_DUMP"

(
  cd "$ROOT_DIR"
  FSUS_ENABLE_LEGACY_DUMP_TESTS=1 \
  FSUS_LEGACY_20260517_DUMP="$DECOMPRESSED_DUMP" \
    dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
      --filter "FullyQualifiedName~RunAsync_UpgradesLegacy20260517RealDump_WhenEnabled"
)
