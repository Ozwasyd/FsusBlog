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
DEPENDENCY_CACHE_ROOT="${FSUSBLOG_DOTNET_DEPENDENCY_CACHE_ROOT:-${ROOT_DIR}/.tmp/dependency-cache/dotnet}"

export TMPDIR="${DATA_ROOT}/tmp"
export TMP="${DATA_ROOT}/tmp"
export TEMP="${DATA_ROOT}/tmp"
export DOTNET_CLI_HOME="${DEPENDENCY_CACHE_ROOT}/dotnet-cli"
export NUGET_PACKAGES="${DEPENDENCY_CACHE_ROOT}/nuget/packages"
export NUGET_HTTP_CACHE_PATH="${DEPENDENCY_CACHE_ROOT}/nuget/http-cache"
export NUGET_SCRATCH="${DATA_ROOT}/tmp/nuget-scratch"
export XDG_CACHE_HOME="${DEPENDENCY_CACHE_ROOT}/xdg-cache"
export XDG_CONFIG_HOME="${DEPENDENCY_CACHE_ROOT}/xdg-config"
export XDG_STATE_HOME="${DEPENDENCY_CACHE_ROOT}/xdg-state"
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
