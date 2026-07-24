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

ResolveProductionBuildCacheDomain() {
    if [[ -z "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" \
        || "${FSUSBLOG_PHYSICAL_BUNDLE_ID:-}" != "backend-tests" \
        || "${FSUSBLOG_BUILD_CACHE_INNER:-0}" == "1" ]]; then
        return 1
    fi
    if [[ "${1:-}" == "dotnet" && "${2:-}" == "restore" && "${3:-}" == "tests/FsusBlog.ProductionBackend.slnx" ]]; then
        printf 'dotnet-restore'
        return 0
    fi
    if [[ "${1:-}" == "dotnet" && "${2:-}" == "build" ]]; then
        case "${3:-}" in
            src/backend/FsusBlog.Server.csproj)
                printf 'backend-server-release'
                return 0
                ;;
            tests/backend/FsusBlog.Server.Tests.csproj)
                printf 'backend-tests-release'
                return 0
                ;;
            benchmarks/core/FsusBlog.Core.Benchmarks.csproj)
                printf 'backend-benchmark-release'
                return 0
                ;;
        esac
    fi
    return 1
}

if CACHE_DOMAIN="$(ResolveProductionBuildCacheDomain "$@")"; then
    export FSUSBLOG_BUILD_CACHE_COMMAND_JSON
    FSUSBLOG_BUILD_CACHE_COMMAND_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@")"
    exec node "$ROOT_DIR/tools/test-matrix/content-addressed-build-cache.mjs" run \
        --domain "$CACHE_DOMAIN" \
        -- node tools/test-matrix/run-build-cache-command.mjs
fi

exec "$@"
