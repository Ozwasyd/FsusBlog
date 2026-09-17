#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
testAssembly="${FSUSBLOG_BACKEND_TEST_DLL:-}"
configuration="${FSUSBLOG_BACKEND_TEST_CONFIGURATION:-${FSUSBLOG_RUNTIME_CONFIGURATION:-}}"
if [[ -z "$configuration" ]]; then
    if [[ "$testAssembly" == */Release/* ]]; then
        configuration=Release
    else
        configuration=Debug
    fi
fi
case "$configuration" in
    Debug | Release) ;;
    *)
        printf '[csrf-browser-matrix] build configuration must be Debug or Release (got %s)\n' "$configuration" >&2
        exit 2
        ;;
esac

if [[ -z "$testAssembly" ]]; then
    if [[ -n "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" ]]; then
        testAssembly="$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/$configuration/net10.0/FsusBlog.Server.Tests.dll"
    else
        testAssembly="$ROOT_DIR/tests/backend/bin/$configuration/net10.0/FsusBlog.Server.Tests.dll"
    fi
fi

if [[ ! -f "$testAssembly" ]]; then
    if [[ "${FSUSBLOG_RUNTIME_NO_BUILD:-0}" == "1" ]]; then
        printf '[csrf-browser-matrix] immutable test assembly is missing: %s\n' "$testAssembly" >&2
        exit 1
    fi
    # shellcheck source=_suite-support.sh
    source "$ROOT_DIR/tools/test/lanes/_suite-support.sh"
    export FSUSBLOG_BACKEND_TEST_CONFIGURATION="$configuration"
    EnsureBackendFilteredBuild
fi

if [[ ! -f "$testAssembly" ]]; then
    printf '[csrf-browser-matrix] backend build completed without the expected test assembly: %s\n' "$testAssembly" >&2
    exit 1
fi

FSUSBLOG_BACKEND_TEST_DLL="$testAssembly" \
    npm --prefix "$ROOT_DIR/src/frontend" run check:security:csrf-browser-matrix
