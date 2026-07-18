#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIR="${ROOT_DIR}/src/frontend"
SERVER_PROJ="${ROOT_DIR}/src/backend/FsusBlog.Server.csproj"
FRONTEND_DIST_DIR="${FSUSBLOG_FRONTEND_DIST_ROOT:-${CLIENT_DIR}/dist}"
RUNTIME_PROFILE_ID="${FSUSBLOG_RUNTIME_PROFILE_ID:-startup-musl-r2r}"
RUNTIME_PROFILE_MANIFEST="${FSUSBLOG_RUNTIME_PROFILE_MANIFEST:-${ROOT_DIR}/tools/runtime-profiles/runtime-publish-profiles.json}"
BUILD_CONFIGURATION="${FSUSBLOG_NATIVE_CONFIGURATION:-Release}"
BUILD_CONFIGURATION_LOWER="$(printf '%s' "${BUILD_CONFIGURATION}" | tr '[:upper:]' '[:lower:]')"

Log() {
    printf '[build-native] %s\n' "$1"
}

RequireCommand() {
    if ! command -v "$1" >/dev/null 2>&1; then
        printf '[build-native] fatal: missing required command: %s\n' "$1" >&2
        exit 1
    fi
}

RequireNonEmptyEnv() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        printf '[build-native] fatal: %s is required for GitHub Packages restore\n' "$name" >&2
        exit 1
    fi
}

RequireCommand npm
RequireCommand dotnet
RequireCommand node
RequireNonEmptyEnv GITHUB_PACKAGES_TOKEN

mapfile -t runtime_profile_fields < <(node "${ROOT_DIR}/tools/runtime-profiles/resolve-runtime-publish-profile.mjs" \
    --manifest "${RUNTIME_PROFILE_MANIFEST}" \
    --profile "${RUNTIME_PROFILE_ID}" \
    --format lines)
[[ "${#runtime_profile_fields[@]}" -eq 17 ]] || {
    printf '[build-native] fatal: runtime profile resolver returned incomplete fields\n' >&2
    exit 1
}
RUNTIME_PROFILE_ID="${runtime_profile_fields[0]}"
TARGET_RUNTIME="${runtime_profile_fields[4]}"
PUBLISH_SINGLE_FILE="${runtime_profile_fields[5]}"
PUBLISH_READY_TO_RUN="${runtime_profile_fields[6]}"
TIERED_PGO="${runtime_profile_fields[7]}"
QUICK_JIT_FOR_LOOPS="${runtime_profile_fields[8]}"
SERVER_GC="${runtime_profile_fields[9]}"
NATIVE_AOT="${runtime_profile_fields[10]}"
[[ "${NATIVE_AOT}" == "false" ]] || {
    printf '[build-native] fatal: NativeAOT requires the narrow prototype executor and sealed feature/security parity evidence\n' >&2
    exit 1
}
OUTPUT_DIR="${ROOT_DIR}/build/native/${RUNTIME_PROFILE_ID}/${TARGET_RUNTIME}/${BUILD_CONFIGURATION_LOWER}"
ZK_NATIVE_ARTIFACT_DIR="${FSUSBLOG_ZK_NATIVE_ARTIFACT_DIR:-${ROOT_DIR}/build/artifacts/native-zk/${TARGET_RUNTIME}}"

Log "cleaning ${OUTPUT_DIR}"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

Log "installing client dependencies"
(
    cd "${CLIENT_DIR}"
    npm ci --no-audit --progress=false
)

Log "building client release assets"
(
    cd "${CLIENT_DIR}"
    npm run build:release
)

Log "publishing server profile ${RUNTIME_PROFILE_ID} (${TARGET_RUNTIME})"
dotnet publish "${SERVER_PROJ}" \
    -c "${BUILD_CONFIGURATION}" \
    -r "${TARGET_RUNTIME}" \
    -o "${OUTPUT_DIR}" \
    --self-contained true \
    /p:PublishSingleFile="${PUBLISH_SINGLE_FILE}" \
    /p:UseAppHost=true \
    /p:PublishTrimmed=false \
    /p:TieredPGO="${TIERED_PGO}" \
    /p:TieredCompilation=true \
    /p:TieredCompilationQuickJitForLoops="${QUICK_JIT_FOR_LOOPS}" \
    /p:ServerGarbageCollection="${SERVER_GC}" \
    /p:PublishReadyToRun="${PUBLISH_READY_TO_RUN}" \
    /p:ReadyToRunUseCrossgen2="${PUBLISH_READY_TO_RUN}"

Log "syncing frontend dist into wwwroot"
rm -rf "${OUTPUT_DIR}/wwwroot"
mkdir -p "${OUTPUT_DIR}/wwwroot"
cp -a "${FRONTEND_DIST_DIR}/." "${OUTPUT_DIR}/wwwroot/"

if [[ -d "${ZK_NATIVE_ARTIFACT_DIR}" ]]; then
    Log "syncing ZK native artifacts from ${ZK_NATIVE_ARTIFACT_DIR}"
    rm -rf "${OUTPUT_DIR}/native/zk"
    mkdir -p "${OUTPUT_DIR}/native/zk"
    cp -a "${ZK_NATIVE_ARTIFACT_DIR}/." "${OUTPUT_DIR}/native/zk/"
else
    Log "ZK native artifacts not found; native Groth16 verifier will remain fail-closed"
fi

Log "packaging client runtime for Node SSR worker"
rm -rf "${OUTPUT_DIR}/FsusBlog.ClientRuntime"
mkdir -p "${OUTPUT_DIR}/FsusBlog.ClientRuntime"
cp -a "${CLIENT_DIR}/." "${OUTPUT_DIR}/FsusBlog.ClientRuntime/"

Log "native release ready at ${OUTPUT_DIR}"
