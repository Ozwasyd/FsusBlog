#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
backend_container=""
backend_container_id=""
backend_network=""
backend_network_id=""
container_env_file=""
postgres_container_id=""
redis_container_id=""
managed_pid_file=""
managed_dev_pid_file=""
managed_preview_pid_file=""
host_backend_pid=""
debug_frontend_pid=""
release_preview_pid=""
test_resource=""
runtime_admission_only=0
declare -a qualified_bootstrap_fixture_environment=()
ValidateUserSystemdCarrier() {
    local runtimeDirectory="${1:-}"
    local currentUid="${2:-}"
    local runtimeRoot="${3:-/run/user}"
    local expectedDirectory="${runtimeRoot}/${currentUid}"
    local owner mode
    [[ "$currentUid" =~ ^[0-9]+$ ]] \
        || { printf '%s\n' 'current user ID is invalid for the user-systemd carrier' >&2; return 1; }
    [[ "$runtimeDirectory" == "$expectedDirectory" ]] \
        || { printf '%s\n' "XDG_RUNTIME_DIR must equal /run/user/\$(id -u)" >&2; return 1; }
    [[ -d "$runtimeDirectory" && ! -L "$runtimeDirectory" ]] \
        || { printf '%s\n' 'XDG_RUNTIME_DIR must be a non-symlink directory' >&2; return 1; }
    read -r owner mode < <(stat -Lc '%u %a' -- "$runtimeDirectory") \
        || { printf '%s\n' 'XDG_RUNTIME_DIR ownership and mode are unavailable' >&2; return 1; }
    [[ "$owner" == "$currentUid" ]] \
        || { printf '%s\n' 'XDG_RUNTIME_DIR must be owned by the current user' >&2; return 1; }
    [[ "$mode" == "700" ]] \
        || { printf '%s\n' 'XDG_RUNTIME_DIR must have mode 0700' >&2; return 1; }
    [[ -S "$runtimeDirectory/bus" ]] \
        || { printf '%s\n' 'XDG_RUNTIME_DIR user bus must be a socket' >&2; return 1; }
}
ManagedRuntimeOwned() {
    local pidFile="$1"
    local runtimePid="$2"
    local runtimeRole="$3"
    [[ -n "$pidFile" && -n "$runtimePid" && -n "$runtimeRole" ]] || return 1
    node - "$pidFile" "${pidFile%.pid}.identity.json" "$runtimePid" "$run_id" "$namespace" "$runtimeRole" <<'NODE'
const fs = require('node:fs');
const [pidFile, identityFile, pidText, runId, namespace, role] = process.argv.slice(2);
const pid = Number(pidText);
try {
    const pidFileStat = fs.lstatSync(pidFile);
    const identityFileStat = fs.lstatSync(identityFile);
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const tail = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
    if (!Number.isInteger(pid) || pid < 2
      || !pidFileStat.isFile() || pidFileStat.isSymbolicLink()
      || !identityFileStat.isFile() || identityFileStat.isSymbolicLink()
      || pidFileStat.uid !== process.getuid() || identityFileStat.uid !== process.getuid()
      || fs.readFileSync(pidFile, 'utf8').trim() !== pidText
      || identity.schema !== 'fsusblog.local-runtime-process-identity.v1'
      || identity.pid !== pid || identity.processGroupId !== pid
      || !/^\d+$/u.test(String(identity.startTimeTicks ?? ''))
      || identity.startTimeTicks !== tail[19]
      || identity.runId !== runId || identity.namespace !== namespace || identity.role !== role
      || Number(tail[2]) !== identity.processGroupId
      || Number(tail[3]) !== identity.processGroupId) {
        process.exitCode = 1;
    }
} catch {
    process.exitCode = 1;
}
NODE
}
StopManagedRuntime() {
    local pidFile="$1"
    local runtimePid="$2"
    local runtimeRole="$3"
    if [[ -z "$runtimePid" ]] || ! kill -0 "$runtimePid" >/dev/null 2>&1; then
        return 0
    fi
    ManagedRuntimeOwned "$pidFile" "$runtimePid" "$runtimeRole" || return 1
    kill -TERM -- "-$runtimePid"
    local stopDeadline=$((SECONDS + 10))
    while kill -0 -- "-$runtimePid" >/dev/null 2>&1 && ((SECONDS < stopDeadline)); do
        sleep 0.1
    done
    if kill -0 -- "-$runtimePid" >/dev/null 2>&1; then
        ManagedRuntimeOwned "$pidFile" "$runtimePid" "$runtimeRole" || return 1
        kill -KILL -- "-$runtimePid"
    fi
    return 0
}
ManagedBackendOwned() {
    ManagedRuntimeOwned "$managed_pid_file" "$host_backend_pid" backend
}
StopManagedBackend() {
    StopManagedRuntime "$managed_pid_file" "$host_backend_pid" backend
}
RemoveOwnedContainer() {
    local containerId="$1"
    [[ -n "$containerId" ]] || return 0
    if ! docker inspect "$containerId" >/dev/null 2>&1; then
        return 0
    fi
    local binding
    binding="$(docker inspect --format '{{.Id}}|{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$containerId")"
    [[ "$binding" == "$containerId|$run_id|$namespace" ]] || return 1
    docker rm -f -v "$containerId" >/dev/null
}
RemoveOwnedNetwork() {
    local networkId="$1"
    [[ -n "$networkId" ]] || return 0
    if ! docker network inspect "$networkId" >/dev/null 2>&1; then
        return 0
    fi
    local binding
    binding="$(docker network inspect --format '{{.Id}}|{{index .Labels "io.fsusblog.test.run-id"}}|{{index .Labels "io.fsusblog.test.namespace"}}' "$networkId")"
    [[ "$binding" == "$networkId|$run_id|$namespace" ]] || return 1
    docker network rm "$networkId" >/dev/null
}
RecordBackendCrashDiagnosticStatus() {
    local diagnosticDirectory="$1"
    local message="$2"
    printf '%s\n' "$message" >> "$diagnosticDirectory/collection-status.txt"
}
CopySmallBackendCrashDiagnostic() {
    local containerId="$1"
    local containerPath="$2"
    local destination="$3"
    local diagnosticDirectory="$4"
    local temporaryDestination="${destination}.partial"
    rm -f -- "$temporaryDestination"
    if ! docker cp "${containerId}:${containerPath}" "$temporaryDestination" >/dev/null 2>&1; then
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "not available: $containerPath"
        return 0
    fi
    if [[ ! -f "$temporaryDestination" ]]; then
        rm -f -- "$temporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "rejected non-file diagnostic: $containerPath"
        return 0
    fi
    local bytes
    bytes="$(wc -c < "$temporaryDestination")"
    if [[ ! "$bytes" =~ ^[0-9]+$ ]] || ((bytes > 1048576)); then
        rm -f -- "$temporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "rejected oversized diagnostic: $containerPath"
        return 0
    fi
    mv -- "$temporaryDestination" "$destination"
    RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" "captured: $containerPath"
}
CaptureOwnedBackendCrashDiagnostics() {
    local containerId="$1"
    [[ "$containerId" =~ ^[0-9a-f]{64}$ ]] || return 0
    docker inspect "$containerId" >/dev/null 2>&1 || return 0
    local binding
    binding="$(docker inspect --format '{{.Id}}|{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$containerId")" \
        || return 1
    [[ "$binding" == "$containerId|$run_id|$namespace" ]] || return 1
    local state running exitCode
    state="$(docker inspect --format '{{json .State}}' "$containerId")" || return 1
    running="$(docker inspect --format '{{.State.Running}}' "$containerId")" || return 1
    exitCode="$(docker inspect --format '{{.State.ExitCode}}' "$containerId")" || return 1
    [[ "$running" != "true" || "$exitCode" != "0" ]] || return 0
    local diagnosticDirectory="$root/.tmp/release-reliability/${run_id}/crash-diagnostics"
    umask 077
    mkdir -p -- "$diagnosticDirectory" || return 1
    chmod 700 -- "$diagnosticDirectory" || return 1
    printf '%s\n' "$state" > "$diagnosticDirectory/container-state.json" \
        || { RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'failed to write container state'; return 0; }
    local logDestination="$diagnosticDirectory/container-logs-tail.txt"
    local logTemporaryDestination="${logDestination}.partial"
    local logBytes
    if docker logs --tail 200 "$containerId" > "$logTemporaryDestination" 2>/dev/null; then
        logBytes="$(wc -c < "$logTemporaryDestination")"
        if [[ "$logBytes" =~ ^[0-9]+$ ]] && ((logBytes <= 1048576)); then
            mv -- "$logTemporaryDestination" "$logDestination"
            RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'captured: docker logs tail'
        else
            rm -f -- "$logTemporaryDestination"
            RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'rejected oversized docker logs tail'
        fi
    else
        rm -f -- "$logTemporaryDestination"
        RecordBackendCrashDiagnosticStatus "$diagnosticDirectory" 'failed to collect docker logs tail'
    fi
    CopySmallBackendCrashDiagnostic "$containerId" /app/runtime-cache/coredump.1.crashreport.json \
        "$diagnosticDirectory/crashreport.json" "$diagnosticDirectory"
    CopySmallBackendCrashDiagnostic "$containerId" /app/runtime-cache/createdump.log \
        "$diagnosticDirectory/createdump.log" "$diagnosticDirectory"
}
CleanupQualifiedRuntimeResources() {
    local producerStatus="${1:-1}"
    set +e
    local cleanupStatus=0
    StopManagedRuntime "$managed_dev_pid_file" "$debug_frontend_pid" debug-frontend || cleanupStatus=1
    StopManagedRuntime "$managed_preview_pid_file" "$release_preview_pid" release-preview || cleanupStatus=1
    StopManagedBackend || cleanupStatus=1
    if ! CaptureOwnedBackendCrashDiagnostics "$backend_container_id"; then
        printf '%s\n' 'backend crash diagnostics could not be collected' >&2
        ((producerStatus == 0)) && cleanupStatus=1
    fi
    RemoveOwnedContainer "$backend_container_id" || cleanupStatus=1
    RemoveOwnedContainer "$postgres_container_id" || cleanupStatus=1
    RemoveOwnedContainer "$redis_container_id" || cleanupStatus=1
    RemoveOwnedNetwork "$backend_network_id" || cleanupStatus=1
    if [[ -n "$managed_pid_file" ]]; then
        rm -f -- "$managed_pid_file" "${managed_pid_file%.pid}.identity.json"
    fi
    if [[ -n "$managed_dev_pid_file" ]]; then
        rm -f -- "$managed_dev_pid_file" "${managed_dev_pid_file%.pid}.identity.json"
    fi
    if [[ -n "$managed_preview_pid_file" ]]; then
        rm -f -- "$managed_preview_pid_file" "${managed_preview_pid_file%.pid}.identity.json"
    fi
    if [[ -n "$test_resource" ]]; then
        rm -f -- "$test_resource"
    fi
    if [[ -n "$container_env_file" ]]; then
        rm -f -- "$container_env_file"
    fi
    set -e
    return "$cleanupStatus"
}
CleanupQualifiedRuntime() {
    local status=$?
    trap - EXIT
    CleanupQualifiedRuntimeResources "$status" || {
        ((status == 0)) && status=1
    }
    exit "$status"
}
BuildQualifiedBootstrapFixtureEnvironment() {
    qualified_bootstrap_fixture_environment=()
    local freeOverride
    local producerPid
    freeOverride="$(printf '%s' "${FSUSBLOG_FIXTURE_PROFILE:-}" | tr -d '[:space:]')"
    [[ -z "$freeOverride" ]] \
        || { printf '%s\n' 'correctness fixture profile cannot be overridden by FSUSBLOG_FIXTURE_PROFILE' >&2; return 1; }
    mapfile -d '' -t qualified_bootstrap_fixture_environment < <(
        node --input-type=module - "$root" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(process.argv[2]);
const { parseMatrix } = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/test-matrix/parse-matrix.mjs'
)).href);
const {
    applySealedFixtureProfileEnvironment,
    sealMatrixFixtureProfile
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/testing/fixture-catalog.mjs'
)).href);
const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'));
const bootstrapTiers = matrix.tiers.filter((tier) => tier.id === 'bootstrap');
if (bootstrapTiers.length !== 1)
{
    throw new Error(`expected one canonical bootstrap tier, got ${bootstrapTiers.length}`);
}
const sealed = applySealedFixtureProfileEnvironment(
    {},
    sealMatrixFixtureProfile(bootstrapTiers[0])
);
const keys = [
    'FSUSBLOG_SEALED_FIXTURE_PROFILE_ID',
    'FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST',
    'FSUSBLOG_SEALED_EXPANDED_CAPABILITY_DIGEST',
    'FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS',
    'FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST',
    'FSUSBLOG_SEALED_FIXTURE_EXECUTION_CLASS',
    'FSUSBLOG_FIXTURE_PROFILE_SOURCE',
    'FSUSBLOG_FIXTURE_PROFILE'
];
for (const key of keys)
{
    if (!Object.hasOwn(sealed, key) || typeof sealed[key] !== 'string')
    {
        throw new Error(`canonical bootstrap fixture environment is missing ${key}`);
    }
    process.stdout.write(`${key}=${sealed[key]}\0`);
}
NODE
    )
    producerPid="$!"
    wait "$producerPid"
    [[ "${#qualified_bootstrap_fixture_environment[@]}" -eq 8 ]] \
        || { printf '%s\n' 'canonical bootstrap fixture environment is incomplete' >&2; return 1; }
}
InvokeQualifiedAcceptanceBootstrap() {
    local bootstrapPath="${1:?bootstrap path is required}"
    BuildQualifiedBootstrapFixtureEnvironment
    env "${qualified_bootstrap_fixture_environment[@]}" \
        FSUSBLOG_RUNTIME_NO_BUILD=1 FSUSBLOG_RUNTIME_CONFIGURATION=Release \
        "$bootstrapPath"
}
trap CleanupQualifiedRuntime EXIT
trap 'exit 130' INT TERM
if [[ "${1:-}" == "--test-workflow" ]]; then
    [[ "$#" -eq 5 ]] || { printf '%s\n' '--test-workflow requires runner, verifier, receipt, and cleanup-resource paths' >&2; exit 2; }
    runner_path="$(realpath "$2")"
    verifier_path="$(realpath "$3")"
    receipt_path="$(realpath -m "$4")"
    test_resource="$(realpath -m "$5")"
    [[ "$runner_path" == /tmp/* && "$verifier_path" == /tmp/* && "$receipt_path" == /tmp/* && "$test_resource" == /tmp/* ]] \
        || { printf '%s\n' '--test-workflow is restricted to isolated /tmp fixtures' >&2; exit 2; }
    : >"$test_resource"
    "$runner_path" "$receipt_path"
    "$verifier_path" "$receipt_path"
    exit
fi
if [[ "${1:-}" == "--test-bootstrap-boundary" ]]; then
    [[ "$#" -eq 2 ]] || { printf '%s\n' '--test-bootstrap-boundary requires one bootstrap executable path' >&2; exit 2; }
    bootstrap_path="$(realpath "$2")"
    [[ "$bootstrap_path" == /tmp/* && -x "$bootstrap_path" ]] \
        || { printf '%s\n' '--test-bootstrap-boundary is restricted to an executable under /tmp' >&2; exit 2; }
    InvokeQualifiedAcceptanceBootstrap "$bootstrap_path"
    exit
fi
if [[ "${1:-}" == "--test-user-systemd-carrier" ]]; then
    [[ "$#" -eq 5 ]] \
        || { printf '%s\n' '--test-user-systemd-carrier requires runtime directory, user ID, runtime root, and producer paths' >&2; exit 2; }
    test_runtime_directory="$(realpath -m "$2")"
    test_user_id="$3"
    test_runtime_root="$(realpath -m "$4")"
    test_producer="$(realpath "$5")"
    [[ "$test_runtime_directory" == /tmp/* && "$test_runtime_root" == /tmp/* && "$test_producer" == /tmp/* && -x "$test_producer" ]] \
        || { printf '%s\n' '--test-user-systemd-carrier is restricted to isolated /tmp fixtures' >&2; exit 2; }
    ValidateUserSystemdCarrier "$test_runtime_directory" "$test_user_id" "$test_runtime_root"
    env -i "HOME=${HOME:?HOME is required}" "PATH=${PATH:?PATH is required}" \
        "XDG_RUNTIME_DIR=$test_runtime_directory" "$test_producer"
    exit
fi
if [[ "${1:-}" == "--test-managed-runtime-owned" ]]; then
    [[ "$#" -eq 6 ]] \
        || { printf '%s\n' '--test-managed-runtime-owned requires PID file, PID, run ID, namespace, and role' >&2; exit 2; }
    test_pid_file="$(realpath "$2")"
    test_pid="$3"
    run_id="$4"
    namespace="$5"
    test_runtime_role="$6"
    [[ "$test_pid_file" == /tmp/* && "$test_pid" =~ ^[1-9][0-9]*$ \
        && "$run_id" =~ ^[a-z0-9][a-z0-9_.-]*$ \
        && "$namespace" =~ ^[a-z0-9][a-z0-9_.-]*$ \
        && "$test_runtime_role" =~ ^[a-z][a-z0-9-]*$ ]] \
        || { printf '%s\n' '--test-managed-runtime-owned accepts only isolated canonical test identity' >&2; exit 2; }
    ManagedRuntimeOwned "$test_pid_file" "$test_pid" "$test_runtime_role"
    exit
fi
if [[ "${1:-}" == "--runtime-admission-only" ]]; then
    [[ "$#" -eq 1 ]] \
        || { printf '%s\n' '--runtime-admission-only does not accept additional arguments' >&2; exit 2; }
    runtime_admission_only=1
elif [[ "$#" -ne 0 ]]; then
    printf 'unknown qualified local reliability argument: %s\n' "$1" >&2
    exit 2
fi
run_id="${FSUSBLOG_RELEASE_RUN_ID:?FSUSBLOG_RELEASE_RUN_ID is required}"
namespace="${FSUSBLOG_TEST_NAMESPACE:-release-reliability-${run_id}}"
image="${FSUSBLOG_RELEASE_RUNTIME_IMAGE:?FSUSBLOG_RELEASE_RUNTIME_IMAGE is required}"
[[ "$run_id" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || { printf '%s\n' 'FSUSBLOG_RELEASE_RUN_ID must be a canonical lowercase identifier' >&2; exit 1; }
[[ "$namespace" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || { printf '%s\n' 'FSUSBLOG_TEST_NAMESPACE must be a canonical lowercase namespace' >&2; exit 1; }
[[ -z "$(git -C "$root" status --porcelain)" ]] || { printf '%s\n' 'qualified local reliability requires a clean source worktree' >&2; exit 1; }
source_commit="$(git -C "$root" rev-parse HEAD)"
source_fingerprint="$(node --input-type=module -e 'import { snapshotGitWorktree } from "./tools/test-matrix/scheduler.mjs"; const root = process.argv[1]; process.stdout.write((await snapshotGitWorktree(root)).fingerprint)' "$root")"
export FSUSBLOG_TEST_RUN_ID="$run_id" FSUSBLOG_TEST_NAMESPACE="$namespace"
export FSUSBLOG_TEST_SOURCE_COMMIT="$source_commit" FSUSBLOG_TEST_SOURCE_FINGERPRINT="$source_fingerprint"
invocation_id=""
if ((runtime_admission_only == 1)); then
    invocation_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
    export FSUSBLOG_RELEASE_INVOCATION_ID="$invocation_id"
fi
export FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT=".tmp/ci-production-build/$run_id"
export FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW="Local production"
export FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID="$run_id"
export FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT="1"
export FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB="production-build-artifacts"
export FSUSBLOG_RELEASE_RESOURCE_POLICY="config/deployment/zero-downtime-resource-policy.json"

ImportProductionBuildEnvironment() {
    local environmentRunId="${1:?production build environment run id is required}"
    local assignment key value
    local -A imported=()
    local -A allowed=(
        [FSUSBLOG_PRODUCTION_BUILD_ROOT]=1 [FSUSBLOG_FRONTEND_DIST_ROOT]=1 [FSUSBLOG_FRONTEND_CACHE_ROOT]=1
        [FSUSBLOG_FRONTEND_WASM_ROOT]=1 [FSUSBLOG_WASM_ARTIFACT_ROOT]=1 [FSUSBLOG_BACKEND_WEBROOT]=1
        [FSUSBLOG_PUBLIC_AOT_SSR_CLIENT_ROOT]=1 [FSUSBLOG_PUBLIC_AOT_SSR_WORKER_SCRIPT]=1 [FSUSBLOG_WEB_ROOT]=1
        [FSUSBLOG_RETENTION_WEBROOT_DIR]=1 [ASPNETCORE_WEBROOT]=1 [FSUSBLOG_GENERATED_OUTPUT_ROOT]=1
        [FSUSBLOG_ARTIFACT_DIGEST_TABLE]=1 [FSUSBLOG_ZK_PRODUCTION_ENABLED]=1 [FSUSBLOG_BACKEND_SERVER_DLL]=1
        [FSUSBLOG_BACKEND_TEST_DLL]=1 [FSUSBLOG_BACKEND_TEST_BIN_DIR]=1 [FSUSBLOG_BACKEND_TEST_OBJ_DIR]=1
        [FSUSBLOG_BENCHMARK_DLL]=1
    )
    while IFS= read -r -d '' assignment; do
        [[ "$assignment" == *=* ]] || { printf '%s\n' 'production build environment assignment is malformed' >&2; return 1; }
        key="${assignment%%=*}"
        value="${assignment#*=}"
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ && -n "${allowed[$key]:-}" && -z "${imported[$key]:-}" ]] \
            || { printf '%s\n' 'production build environment assignment is unknown or duplicated' >&2; return 1; }
        [[ -n "$value" ]] || { printf '%s\n' "production build environment value is missing: $key" >&2; return 1; }
        imported[$key]=1
        export "$key=$value"
    done < <(node "$root/tools/test/export-production-build-environment.mjs" --root "$root" --run-id "$environmentRunId")
    local required
    for required in "${!allowed[@]}"; do
        [[ -n "${imported[$required]:-}" ]] || { printf '%s\n' "production build environment key is missing: $required" >&2; return 1; }
    done
}

ImportProductionBuildEnvironment "$run_id"

"$root/tools/test/lanes/production-build-artifacts.sh"
build_receipt_digest="$(node - "$root/$FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT/receipt.json" \
    "$FSUSBLOG_CI_PRODUCTION_PRODUCER_WORKFLOW" "$FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ID" \
    "$FSUSBLOG_CI_PRODUCTION_PRODUCER_RUN_ATTEMPT" "$FSUSBLOG_CI_PRODUCTION_PRODUCER_JOB" <<'NODE'
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const digest = String(receipt?.contentDigest ?? '');
if (receipt?.status !== 'complete' || !/^sha256:[0-9a-f]{64}$/u.test(digest))
{
    throw new Error('production build receipt is incomplete or has an invalid content digest');
}
const expectedProducer = {
    workflow: process.argv[3],
    runId: process.argv[4],
    runAttempt: Number(process.argv[5]),
    job: process.argv[6]
};
if (JSON.stringify(receipt.producer) !== JSON.stringify(expectedProducer))
{
    throw new Error('production build receipt producer identity does not match the qualified local run');
}
process.stdout.write(digest);
NODE
)"
export FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST="$build_receipt_digest"
if [[ -z "${GITHUB_PACKAGES_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then export GITHUB_PACKAGES_TOKEN="$(gh auth token)"; fi
FSUSBLOG_FINAL_LOCAL_ONLY=1 FSUSBLOG_FINAL_IMAGE_TAG="$image" "$root/tools/build-final-image.sh"
ImportProductionBuildEnvironment "${run_id}-acceptance"
InvokeQualifiedAcceptanceBootstrap "$root/tools/bootstrap-acceptance-env.sh"
fixture_config=".tmp/env/${namespace}.env"
runtime_environment_tool="$root/tools/test/release-reliability-runtime-environment.mjs"
container_env_file="$(node "$runtime_environment_tool" project-container-environment \
    --root "$root" --namespace "$namespace" --run-id "$run_id")"
postgres_container="$(node "$runtime_environment_tool" get --root "$root" --namespace "$namespace" --run-id "$run_id" --field postgres-container)"
redis_container="$(node "$runtime_environment_tool" get --root "$root" --namespace "$namespace" --run-id "$run_id" --field redis-container)"
runtime_base_url="$(node "$runtime_environment_tool" get --root "$root" --namespace "$namespace" --run-id "$run_id" --field backend-url)"
backend_host_port="$(node "$runtime_environment_tool" get --root "$root" --namespace "$namespace" --run-id "$run_id" --field backend-port)"
postgres_container_id="$(docker inspect --format '{{.Id}}' "$postgres_container")"
redis_container_id="$(docker inspect --format '{{.Id}}' "$redis_container")"
[[ "$(docker inspect --format '{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$postgres_container_id")" == "$run_id|$namespace" ]] \
    || { printf '%s\n' 'PostgreSQL container ownership does not match the qualified run' >&2; exit 1; }
[[ "$(docker inspect --format '{{index .Config.Labels "io.fsusblog.test.run-id"}}|{{index .Config.Labels "io.fsusblog.test.namespace"}}' "$redis_container_id")" == "$run_id|$namespace" ]] \
    || { printf '%s\n' 'Redis container ownership does not match the qualified run' >&2; exit 1; }
backend_network="fsusblog-test-network-${namespace}"
if docker network inspect "$backend_network" >/dev/null 2>&1; then
    printf 'qualified runtime network already exists: %s\n' "$backend_network" >&2
    exit 1
fi
backend_network_id="$(docker network create --driver bridge \
    --label "io.fsusblog.test.run-id=$run_id" \
    --label "io.fsusblog.test.namespace=$namespace" \
    "$backend_network")"
[[ "$backend_network_id" =~ ^[0-9a-f]{64}$ ]] \
    || { printf '%s\n' 'qualified runtime network did not return one concrete ID' >&2; exit 1; }
docker network connect --alias postgres "$backend_network" "$postgres_container_id"
docker network connect --alias redis "$backend_network" "$redis_container_id"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
managed_pid_file="$root/.tmp/acceptance/${namespace}/backend.pid"
managed_dev_pid_file="$root/.tmp/acceptance/${namespace}/dev-server.pid"
managed_preview_pid_file="$root/.tmp/acceptance/${namespace}/preview.pid"
host_backend_pid="$(cat "$managed_pid_file")"
debug_frontend_pid="$(cat "$managed_dev_pid_file")"
release_preview_pid="$(cat "$managed_preview_pid_file")"
ManagedBackendOwned || { printf '%s\n' 'host bootstrap backend identity mismatch' >&2; exit 1; }
ManagedRuntimeOwned "$managed_dev_pid_file" "$debug_frontend_pid" debug-frontend \
    || { printf '%s\n' 'host bootstrap debug frontend identity mismatch' >&2; exit 1; }
ManagedRuntimeOwned "$managed_preview_pid_file" "$release_preview_pid" release-preview \
    || { printf '%s\n' 'host bootstrap release preview identity mismatch' >&2; exit 1; }
StopManagedBackend || { printf '%s\n' 'host bootstrap backend could not be stopped through its owned process group' >&2; exit 1; }
host_backend_pid=""
backend_container="fsusblog-test-app-${namespace}"
if docker inspect "$backend_container" >/dev/null 2>&1; then
    printf 'backend app container already exists: %s\n' "$backend_container" >&2
    exit 1
fi
backend_container_id="$(docker run -d --name "$backend_container" --network "$backend_network" \
    -p "127.0.0.1:${backend_host_port}:8080" --env-file "$container_env_file" \
    --tmpfs /app/data:uid=1654,gid=1654,mode=0700 \
    --tmpfs /app/.upload-sessions:uid=1654,gid=1654,mode=0700 \
    --tmpfs /app/runtime-cache:uid=1654,gid=1654,mode=0700 \
    -e FSUSBLOG_DATA_ROOT=/app/data -e PublicAot__SsrClientRoot=/app/wwwroot \
    -e ASPNETCORE_URLS=http://0.0.0.0:8080 -e "AllowedHosts=127.0.0.1;localhost" \
    -e "ConnectionStrings__DefaultConnection=Host=postgres;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true" \
    -e "ConnectionStrings__Redis=redis:6379,abortConnect=false,connectTimeout=10000" \
    -e "RedisOptions__Configuration=redis:6379,abortConnect=false,connectTimeout=10000" \
    -e DOTNET_DbgEnableMiniDump=1 -e DOTNET_DbgMiniDumpType=4 \
    -e DOTNET_DbgMiniDumpName=/app/runtime-cache/coredump.%p -e DOTNET_EnableCrashReport=1 \
    -e DOTNET_CreateDumpDiagnostics=1 -e DOTNET_CreateDumpLogToFile=/app/runtime-cache/createdump.log \
    -e "FSUSBLOG_TEST_RUN_ID=$run_id" -e "FSUSBLOG_TEST_NAMESPACE=$namespace" -e FSUSBLOG_RUNTIME_ROLE=backend \
    -e "FSUSBLOG_TEST_SOURCE_COMMIT=$source_commit" -e "FSUSBLOG_TEST_SOURCE_FINGERPRINT=$source_fingerprint" \
    --label "io.fsusblog.test.run-id=$run_id" --label "io.fsusblog.test.namespace=$namespace" "$image")"
[[ "$backend_container_id" =~ ^[0-9a-f]{64}$ ]] || { printf '%s\n' 'backend app container did not return one concrete ID' >&2; exit 1; }
runtime_health_deadline=$((SECONDS + 180))
runtime_smoke_deadline=""
runtime_smoke_observation=""
runtime_smoke_attempt_count=0
runtime_smoke_started_seconds=""
runtime_smoke_observation_file=""
runtime_smoke_probe="${root}/tools/test/probe-release-reliability-runtime-smoke.mjs"
runtime_smoke_probe_arguments=(--base-url "$runtime_base_url" --timeout-ms 1000)
if ((runtime_admission_only == 1)); then
    runtime_smoke_observation_file=".tmp/release-reliability/${invocation_id}/runtime-smoke-observation.json"
    runtime_smoke_probe_arguments+=(--out "$runtime_smoke_observation_file")
fi
while true; do
    if ! runtime_health_observation="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.State.Running}}|{{.State.ExitCode}}' "$backend_container_id" 2>/dev/null)"; then
        printf '%s\n' 'runtime image backend inspection failed during health admission' >&2
        exit 1
    fi
    IFS='|' read -r runtime_health_status runtime_running runtime_exit_code <<<"$runtime_health_observation"
    if [[ "$runtime_running" != "true" ]]; then
        printf 'runtime image backend exited before runtime smoke completed: %s\n' "$runtime_smoke_observation" >&2
        exit 1
    fi
    case "$runtime_health_status" in
        healthy)
            if [[ -z "$runtime_smoke_deadline" ]]; then
                runtime_smoke_deadline=$((SECONDS + 60))
                runtime_smoke_started_seconds="$SECONDS"
            fi
            runtime_smoke_attempt_count=$((runtime_smoke_attempt_count + 1))
            if runtime_smoke_observation=$(node "$runtime_smoke_probe" \
                "${runtime_smoke_probe_arguments[@]}" 2>&1); then
                break
            fi
            if ((SECONDS >= runtime_smoke_deadline)); then
                printf 'runtime image backend did not satisfy live/canonical AEDS route admission after becoming healthy: %s\n' "$runtime_smoke_observation" >&2
                exit 1
            fi
            ;;
        starting)
            runtime_smoke_observation="Docker health status is starting"
            if ((SECONDS >= runtime_health_deadline)); then
                printf '%s\n' 'runtime image backend did not become healthy within the native health admission window' >&2
                exit 1
            fi
            ;;
        unhealthy)
            printf '%s\n' 'runtime image backend reported unhealthy before fixture collection' >&2
            exit 1
            ;;
        *)
            printf 'runtime image backend health contract is missing or invalid: %s\n' "$runtime_health_observation" >&2
            exit 1
            ;;
    esac
    sleep 0.25
done
runtime_smoke_elapsed_seconds=$((SECONDS - runtime_smoke_started_seconds))
fixture_authority=".tmp/release-reliability/${run_id}/fixture-authority.json"
audit_retention_policy="src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs"
node "$root/tools/test/collect-release-reliability-fixture.mjs" --root "$root" --run-id "$run_id" --namespace "$namespace" --fixture-root ".tmp/fixtures/${namespace}" --config "$fixture_config" --schema "src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs" --seed "tools/data-scale/seed.sh" --audit-retention-policy "$audit_retention_policy" --postgres "$postgres_container" --redis "$redis_container" --backend-container "$backend_container_id" --network "$backend_network" --source-commit "$source_commit" --source-fingerprint "$source_fingerprint" --runtime-image "$image" --image-digest "$image_id" --out "$fixture_authority"
export FSUSBLOG_RELEASE_FIXTURE_AUTHORITY="$fixture_authority"
export FSUSBLOG_TEST_FIXTURE_ROOT=".tmp/fixtures/${namespace}" FSUSBLOG_TEST_FIXTURE_CONFIG="$fixture_config"
export FSUSBLOG_TEST_FIXTURE_SCHEMA="src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs" FSUSBLOG_TEST_FIXTURE_SEED="tools/data-scale/seed.sh"
export FSUSBLOG_TEST_FIXTURE_AUDIT_RETENTION_POLICY="$audit_retention_policy"
if [[ -z "$invocation_id" ]]; then
    invocation_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
    export FSUSBLOG_RELEASE_INVOCATION_ID="$invocation_id"
fi
current_uid="$(id -u)"
ValidateUserSystemdCarrier "${XDG_RUNTIME_DIR:-}" "$current_uid"
if ((runtime_admission_only == 1)); then
    runtime_admission_candidate=".tmp/release-reliability/${invocation_id}/runtime-admission-candidate.json"
    runtime_admission_receipt=".tmp/release-reliability/${invocation_id}/runtime-admission-receipt.json"
    runtime_admission_tool="$root/tools/test/release-reliability-runtime-admission.mjs"
    node "$runtime_admission_tool" create --root "$root" \
        --candidate "$runtime_admission_candidate" \
        --source-commit "$source_commit" \
        --source-fingerprint "$source_fingerprint" \
        --build-receipt "$FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT/receipt.json" \
        --build-receipt-digest "$build_receipt_digest" \
        --image-reference "$image" \
        --image-digest "$image_id" \
        --run-id "$run_id" \
        --namespace "$namespace" \
        --invocation-id "$invocation_id" \
        --fixture-authority "$fixture_authority" \
        --smoke-observation "$runtime_smoke_observation_file" \
        --deadline-seconds 60 \
        --attempt-count "$runtime_smoke_attempt_count" \
        --elapsed-seconds "$runtime_smoke_elapsed_seconds"
    trap - EXIT
    if ! CleanupQualifiedRuntimeResources 0; then
        printf '%s\n' 'runtime admission cleanup failed; pass receipt was not created' >&2
        exit 1
    fi
    node "$runtime_admission_tool" finalize --root "$root" \
        --candidate "$runtime_admission_candidate" \
        --receipt "$runtime_admission_receipt"
    node "$runtime_admission_tool" verify --root "$root" \
        --receipt "$runtime_admission_receipt"
    exit 0
fi
qualified_executor_environment=(
    "HOME=$HOME"
    "PATH=$PATH"
    "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
    "FSUSBLOG_RELEASE_LOAD_RUNTIME_ENVIRONMENT=1"
    "FSUSBLOG_RELEASE_INVOCATION_ID=$invocation_id"
    "FSUSBLOG_RELEASE_RUN_ID=$run_id"
    "FSUSBLOG_RELEASE_RUNTIME_IMAGE=$image"
    "FSUSBLOG_RELEASE_RESOURCE_POLICY=$FSUSBLOG_RELEASE_RESOURCE_POLICY"
    "FSUSBLOG_RELEASE_FIXTURE_AUTHORITY=$FSUSBLOG_RELEASE_FIXTURE_AUTHORITY"
    "FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT=$FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT"
    "FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST=$FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST"
    "FSUSBLOG_TEST_FIXTURE_ROOT=$FSUSBLOG_TEST_FIXTURE_ROOT"
    "FSUSBLOG_TEST_FIXTURE_CONFIG=$FSUSBLOG_TEST_FIXTURE_CONFIG"
    "FSUSBLOG_TEST_FIXTURE_SCHEMA=$FSUSBLOG_TEST_FIXTURE_SCHEMA"
    "FSUSBLOG_TEST_FIXTURE_SEED=$FSUSBLOG_TEST_FIXTURE_SEED"
    "FSUSBLOG_TEST_FIXTURE_AUDIT_RETENTION_POLICY=$FSUSBLOG_TEST_FIXTURE_AUDIT_RETENTION_POLICY"
    "FSUSBLOG_TEST_NAMESPACE=$FSUSBLOG_TEST_NAMESPACE"
    "FSUSBLOG_TEST_RUN_ID=$FSUSBLOG_TEST_RUN_ID"
    "FSUSBLOG_TEST_SOURCE_COMMIT=$FSUSBLOG_TEST_SOURCE_COMMIT"
    "FSUSBLOG_TEST_SOURCE_FINGERPRINT=$FSUSBLOG_TEST_SOURCE_FINGERPRINT"
)
for inherited_key in \
    LANG LC_ALL TMPDIR TZ \
    FSUSBLOG_AOT_CACHE_DIR FSUSBLOG_BACKEND_TEST_BIN_DIR FSUSBLOG_BACKEND_TEST_DLL \
    FSUSBLOG_BACKEND_TEST_OBJ_DIR FSUSBLOG_BACKEND_WEBROOT FSUSBLOG_PRODUCTION_BUILD_ROOT \
    FSUSBLOG_PUBLIC_AOT_CACHE_DIR FSUSBLOG_SEARCH_DIR FSUSBLOG_SEARCH_INDEX_DIR FSUSBLOG_WEB_ROOT
do
    if [[ -n "${!inherited_key:-}" ]]; then
        qualified_executor_environment+=("$inherited_key=${!inherited_key}")
    fi
done
env -i "${qualified_executor_environment[@]}" \
    node "$root/tools/test/run-release-reliability-scenarios.mjs"
candidate_receipt=".tmp/release-reliability/${invocation_id}/candidate-receipt.json"
verified_attestation=".tmp/release-reliability/${invocation_id}/verified-attestation.json"
qualified_receipt=".tmp/release-reliability/${invocation_id}/qualified-receipt.json"
node "$root/tools/test/verify-release-reliability-receipt.mjs" --root "$root" \
    --candidate "$candidate_receipt" --attestation-out "$verified_attestation"
trap - EXIT
CleanupQualifiedRuntimeResources 0
node "$root/tools/test/verify-release-reliability-receipt.mjs" --root "$root" \
    --candidate "$candidate_receipt" --attestation "$verified_attestation" \
    --finalize-out "$qualified_receipt"
node "$root/tools/test/verify-release-reliability-receipt.mjs" --root "$root" \
    --receipt "$qualified_receipt"
