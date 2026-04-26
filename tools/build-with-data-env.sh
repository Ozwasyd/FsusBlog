#!/usr/bin/env bash
set -euo pipefail
export TMPDIR=/data/tmp
export TMP=/data/tmp
export TEMP=/data/tmp
export DOTNET_CLI_HOME=/data/cache/dev/dotnet-cli
export NUGET_PACKAGES=/data/cache/dev/nuget/packages
export NUGET_HTTP_CACHE_PATH=/data/cache/dev/nuget/http-cache
export NUGET_SCRATCH=/data/cache/dev/nuget/scratch
export XDG_CACHE_HOME=/data/cache/dev/xdg-cache
export XDG_CONFIG_HOME=/data/cache/dev/xdg-config
export XDG_STATE_HOME=/data/cache/dev/xdg-state
export MSBUILDDEBUGPATH=/data/tmp/msbuild
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
