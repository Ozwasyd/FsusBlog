#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

PrepareBenchmarkMeasurement()
{
    "$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
        "$NODE_BIN" "$ROOT_DIR/tools/test-matrix/dotnet-build-server-cleanup.mjs" \
        prepare-benchmark-measurement \
        --root "$ROOT_DIR"
}

# The local physical production bundle publishes and verifies this build before
# admitting benchmark consumers. Standalone logical tiers need the same
# single-writer boundary before their isolated measurement admission.
if [[ -n "${FSUSBLOG_LOCAL_PROFILE:-}" ]]; then
    "$NODE_BIN" "$ROOT_DIR/tools/test/verify-benchmark-build-ready.mjs"
    PrepareBenchmarkMeasurement
    exit 0
fi

PROJECT="$ROOT_DIR/benchmarks/core/FsusBlog.Core.Benchmarks.csproj"
if [[ -n "${FSUSBLOG_BENCHMARK_DLL:-}" ]]; then
    BENCHMARK_DLL="$FSUSBLOG_BENCHMARK_DLL"
elif [[ -n "${FSUSBLOG_PRODUCTION_BUILD_ROOT:-}" ]]; then
    BENCHMARK_DLL="$FSUSBLOG_PRODUCTION_BUILD_ROOT/dotnet/FsusBlog.Core.Benchmarks/bin/Release/net10.0/FsusBlog.Core.Benchmarks.dll"
else
    BENCHMARK_DLL="$ROOT_DIR/benchmarks/core/bin/Release/net10.0/FsusBlog.Core.Benchmarks.dll"
fi
BENCHMARK_DEPS="${BENCHMARK_DLL%.dll}.deps.json"
BENCHMARK_RUNTIMECONFIG="${BENCHMARK_DLL%.dll}.runtimeconfig.json"
NAMESPACE="${FSUSBLOG_TEST_NAMESPACE:-${FSUSBLOG_TEST_RUN_ID:-local}}"

dotnet_sdk_version="$(dotnet --version)"
fingerprint_args=(
    --root "$ROOT_DIR"
    --path Directory.Build.props
    --path Directory.Packages.props
    --path tools/build-with-data-env.sh
    --path tools/test/ensure-benchmark-release-build.sh
    --path tools/test/run-with-dotnet-release-build-lock.sh
    --value benchmark-release-build-v1
    --value "dotnet-sdk=$dotnet_sdk_version"
)
if [[ -n "${FSUSBLOG_TEST_SOURCE_COMMIT:-}" && -n "${FSUSBLOG_TEST_SOURCE_FINGERPRINT:-}" ]]; then
    # Scheduler source identity excludes ignored runtime cache/log mutations that
    # occur during the run, while commit + worktree fingerprint still bind the
    # shared producer to the exact source under test.
    fingerprint_args+=(
        --value "source-commit=${FSUSBLOG_TEST_SOURCE_COMMIT}"
        --value "source-fingerprint=${FSUSBLOG_TEST_SOURCE_FINGERPRINT}"
    )
else
    fingerprint_args+=(
        --path benchmarks/core
        --path src/backend
        --path src/core
        --path src/shared
        --path tools/architecture/FsusBlog.DiLifetimeAnalyzer
    )
fi
fingerprint="$("$NODE_BIN" "$ROOT_DIR/tools/test/run-once.mjs" fingerprint "${fingerprint_args[@]}")"

msbuild_parallelism="/m"
if [[ "${FSUSBLOG_TIER_CPU_UNITS:-}" =~ ^[1-9][0-9]*$ ]]; then
    msbuild_parallelism="/m:${FSUSBLOG_TIER_CPU_UNITS}"
fi

"$ROOT_DIR/tools/test/run-with-dotnet-release-build-lock.sh" \
    "$NODE_BIN" "$ROOT_DIR/tools/test/run-once.mjs" run \
    --root "$ROOT_DIR/.tmp/run-once" \
    --namespace "$NAMESPACE" \
    --key backend-benchmark-release-build \
    --fingerprint "$fingerprint" \
    --cwd "$ROOT_DIR" \
    --require-output "$BENCHMARK_DLL" \
    --require-output "$BENCHMARK_DEPS" \
    --require-output "$BENCHMARK_RUNTIMECONFIG" \
    -- \
    "$ROOT_DIR/tools/build-with-data-env.sh" dotnet build "$PROJECT" \
    -c Release --no-incremental -warnaserror -v minimal "$msbuild_parallelism" \
    /p:UseSharedCompilation=true /p:NuGetAudit=false

PrepareBenchmarkMeasurement
