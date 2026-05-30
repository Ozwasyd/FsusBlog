#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_DATA_ROOT="${FSUSBLOG_DATA_ROOT:-/data}"

if mkdir -p "${DEFAULT_DATA_ROOT}" >/dev/null 2>&1; then
  DATA_ROOT="${DEFAULT_DATA_ROOT}"
else
  DATA_ROOT="${ROOT_DIR}/.tmp/data-root"
  mkdir -p "${DATA_ROOT}"
fi

export TMPDIR="${DATA_ROOT}/tmp"
export TMP="${DATA_ROOT}/tmp"
export TEMP="${DATA_ROOT}/tmp"
export DOTNET_CLI_HOME="${DATA_ROOT}/cache/dev/dotnet-cli"
export NUGET_PACKAGES="${DATA_ROOT}/cache/dev/nuget/packages"
export NUGET_HTTP_CACHE_PATH="${DATA_ROOT}/cache/dev/nuget/http-cache"
export NUGET_SCRATCH="${DATA_ROOT}/cache/dev/nuget/scratch"
export XDG_CACHE_HOME="${DATA_ROOT}/cache/dev/xdg-cache"
export XDG_CONFIG_HOME="${DATA_ROOT}/cache/dev/xdg-config"
export XDG_STATE_HOME="${DATA_ROOT}/cache/dev/xdg-state"
export MSBUILDDEBUGPATH="${DATA_ROOT}/tmp/msbuild"
export MSBUILDDISABLENODEREUSE=1
mkdir -p \
  "$TMPDIR" \
  "$DOTNET_CLI_HOME" \
  "$NUGET_PACKAGES" \
  "$NUGET_HTTP_CACHE_PATH" \
  "$NUGET_SCRATCH" \
  "$XDG_CACHE_HOME" \
  "$XDG_CONFIG_HOME" \
  "$XDG_STATE_HOME" \
  "$MSBUILDDEBUGPATH"
exec "$@"
