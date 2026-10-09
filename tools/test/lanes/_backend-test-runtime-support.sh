#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    printf '[test] _backend-test-runtime-support.sh is source-only\n' >&2
    exit 2
fi

BackendTestRuntimeOutputDirectory() {
    local configuration
    configuration="$(BackendTestConfiguration)" || return $?
    if [[ -n "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" ]]; then
        printf '%s\n' "$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Server.Tests/bin/$configuration/net10.0"
    else
        printf '%s\n' "$ROOT_DIR/tests/backend/bin/$configuration/net10.0"
    fi
}

CleanupBackendTestRuntimeOutput() {
    local outputDirectory runtimePath
    outputDirectory="$(BackendTestRuntimeOutputDirectory)" || return $?
    for runtimePath in "$outputDirectory/data" "$outputDirectory/storage"; do
        case "$runtimePath" in
            "$outputDirectory/data" | "$outputDirectory/storage")
                ;;
            *)
                Fail "refusing to clean backend test runtime path outside output directory: $runtimePath"
                ;;
        esac
        if [[ -e "$runtimePath" || -L "$runtimePath" ]]; then
            rm -rf -- "$runtimePath" || return $?
        fi
    done
}

RunBackendDotnetTest() {
    local lane="$1"
    shift
    local laneSlug status=0 cleanupStatus=0
    laneSlug="$(NamespaceSlug "$lane")" || return $?
    FSUSBLOG_BACKEND_DB_NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-local}-${laneSlug}-${BASHPID}" \
        Run "$BUILD_ENV_RUNNER" dotnet test "$SERVER_TEST_PROJ" "$@" || status=$?
    CleanupBackendTestRuntimeOutput || cleanupStatus=$?
    # Preserve the test failure when both operations fail; successful tests
    # cannot hide a failed cleanup.
    if ((status != 0)); then
        return "$status"
    fi
    return "$cleanupStatus"
}
