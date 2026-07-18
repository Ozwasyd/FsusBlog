#!/usr/bin/env bash
set -euo pipefail

Fail() {
    printf '[image-runtime-contract] fatal: %s\n' "$1" >&2
    exit 1
}

[[ $# -eq 1 ]] || Fail "usage: image-runtime-contract.sh <immutable-image-ref>"
image_ref="$1"
[[ "$image_ref" =~ ^[a-z0-9][a-z0-9._:-]*(/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$ ]] ||
    Fail "target image reference must be immutable: <registry>/<repository>@sha256:<64 lowercase hex>"
command -v docker >/dev/null 2>&1 || Fail "docker is required"
command -v jq >/dev/null 2>&1 || Fail "jq is required"

docker pull "$image_ref" >/dev/null 2>&1 ||
    Fail "unable to pull target image: $image_ref"

ImageLabel() {
    local key="$1"
    docker image inspect "$image_ref" --format "{{ index .Config.Labels \"$key\" }}" 2>/dev/null ||
        Fail "unable to inspect target image label: $key"
}

vcpkg_commit="$(ImageLabel io.fsusblog.build.vcpkg-commit)"
node_contract="$(ImageLabel io.fsusblog.runtime.node)"
npm_contract="$(ImageLabel io.fsusblog.runtime.npm)"
ready_to_run="$(ImageLabel io.fsusblog.runtime.publish-ready-to-run)"
profile_id="$(ImageLabel io.fsusblog.runtime.profile-id)"
profile_manifest_digest="$(ImageLabel io.fsusblog.runtime.profile-manifest-digest)"
profile_digest="$(ImageLabel io.fsusblog.runtime.profile-digest)"
base_family="$(ImageLabel io.fsusblog.runtime.base-family)"
target_runtime="$(ImageLabel io.fsusblog.runtime.target-runtime)"
single_file="$(ImageLabel io.fsusblog.runtime.publish-single-file)"
tiered_pgo="$(ImageLabel io.fsusblog.runtime.tiered-pgo)"
quick_jit="$(ImageLabel io.fsusblog.runtime.quick-jit-for-loops)"
server_gc="$(ImageLabel io.fsusblog.runtime.server-gc)"
native_aot="$(ImageLabel io.fsusblog.runtime.native-aot)"
gc_heap_count_mode="$(ImageLabel io.fsusblog.runtime.gc-heap-count-mode)"
gc_heap_hard_limit_mode="$(ImageLabel io.fsusblog.runtime.gc-heap-hard-limit-mode)"
gc_heap_hard_limit_percent="$(ImageLabel io.fsusblog.runtime.gc-heap-hard-limit-percent)"
thread_pool_mode="$(ImageLabel io.fsusblog.runtime.thread-pool-mode)"
thread_pool_min_threads_per_cpu="$(ImageLabel io.fsusblog.runtime.thread-pool-min-threads-per-cpu)"
topology_mode="$(ImageLabel io.fsusblog.runtime.topology-mode)"

[[ "$vcpkg_commit" =~ ^[0-9a-f]{40}$ ]] ||
    Fail "target image vcpkg commit label must be a full lowercase Git SHA"
[[ "$node_contract" == "required" ]] ||
    Fail "target image node contract label must be required"
[[ "$npm_contract" == "forbidden" ]] ||
    Fail "target image npm contract label must be forbidden"
[[ "$profile_id" =~ ^[a-z][a-z0-9-]{2,63}$ ]] || Fail "target image runtime profile id label is invalid"
[[ "$profile_manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "target image runtime profile manifest digest label is invalid"
[[ "$profile_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || Fail "target image runtime profile digest label is invalid"
[[ "$base_family" == "musl" || "$base_family" == "glibc" ]] || Fail "target image runtime base family label is invalid"
[[ "$target_runtime" == "linux-musl-x64" || "$target_runtime" == "linux-x64" ]] || Fail "target image target runtime label is invalid"
[[ "$base_family:$target_runtime" == "musl:linux-musl-x64" || "$base_family:$target_runtime" == "glibc:linux-x64" ]] || Fail "target image runtime base family and target runtime mismatch"
for value in "$single_file" "$ready_to_run" "$tiered_pgo" "$quick_jit" "$server_gc" "$native_aot"; do
    [[ "$value" == "true" || "$value" == "false" ]] || Fail "target image runtime boolean label is invalid"
done
[[ "$server_gc" == "true" ]] || Fail "target image server GC label must remain true"
[[ "$native_aot" == "false" ]] || Fail "target full image cannot claim NativeAOT without narrow prototype parity promotion"
[[ "$gc_heap_count_mode" == "container-default" || "$gc_heap_count_mode" == "cpuset" ]] || Fail "target image GC heap count mode label is invalid"
[[ "$gc_heap_hard_limit_mode" == "container-limit" || "$gc_heap_hard_limit_mode" == "explicit-container-percent" ]] || Fail "target image GC heap hard limit mode label is invalid"
[[ "$gc_heap_hard_limit_percent" =~ ^[0-9]+$ ]] && ((gc_heap_hard_limit_percent >= 0 && gc_heap_hard_limit_percent <= 95)) || Fail "target image GC heap hard limit percent label is invalid"
[[ "$gc_heap_hard_limit_mode" == "explicit-container-percent" && "$gc_heap_hard_limit_percent" -gt 0 || "$gc_heap_hard_limit_mode" == "container-limit" && "$gc_heap_hard_limit_percent" -eq 0 ]] || Fail "target image GC heap hard limit mode/percent labels are inconsistent"
[[ "$thread_pool_mode" == "runtime-default" || "$thread_pool_mode" == "evidence-derived" || "$thread_pool_mode" == "overprovisioned-negative-control" ]] || Fail "target image thread pool mode label is invalid"
[[ "$thread_pool_min_threads_per_cpu" =~ ^[0-9]+$ ]] && ((thread_pool_min_threads_per_cpu >= 0 && thread_pool_min_threads_per_cpu <= 256)) || Fail "target image ThreadPool minimum label is invalid"
[[ "$thread_pool_mode" == "overprovisioned-negative-control" && "$thread_pool_min_threads_per_cpu" -ge 64 || "$thread_pool_mode" != "overprovisioned-negative-control" && "$thread_pool_min_threads_per_cpu" -eq 0 ]] || Fail "target image ThreadPool mode/minimum labels are inconsistent"
[[ "$topology_mode" == "smt-visible" || "$topology_mode" == "physical-core-only" || "$topology_mode" == "numa-local" ]] || Fail "target image topology mode label is invalid"

docker run --rm --entrypoint /bin/sh "$image_ref" -c 'command -v node >/dev/null 2>&1' >/dev/null 2>&1 ||
    Fail "target image runtime must provide node"
docker run --rm --entrypoint /bin/sh "$image_ref" -c '! command -v npm >/dev/null 2>&1' >/dev/null 2>&1 ||
    Fail "target image runtime must not provide npm"

jq -cn \
    --arg imageRef "$image_ref" \
    --arg vcpkgCommit "$vcpkg_commit" \
    --arg node "$node_contract" \
    --arg npm "$npm_contract" \
    --arg publishReadyToRun "$ready_to_run" \
    --arg profileId "$profile_id" \
    --arg profileManifestDigest "$profile_manifest_digest" \
    --arg profileDigest "$profile_digest" \
    --arg baseFamily "$base_family" \
    --arg targetRuntime "$target_runtime" \
    --arg singleFile "$single_file" \
    --arg tieredPgo "$tiered_pgo" \
    --arg quickJitForLoops "$quick_jit" \
    --arg serverGc "$server_gc" \
    --arg nativeAot "$native_aot" \
    --arg gcHeapCountMode "$gc_heap_count_mode" \
    --arg gcHeapHardLimitMode "$gc_heap_hard_limit_mode" \
    --argjson gcHeapHardLimitPercent "$gc_heap_hard_limit_percent" \
    --arg threadPoolMode "$thread_pool_mode" \
    --argjson threadPoolMinThreadsPerCpu "$thread_pool_min_threads_per_cpu" \
    --arg topologyMode "$topology_mode" '
  {
    schema: "fsusblog.image-runtime-contract.v1",
    status: "ok",
    imageRef: $imageRef,
    build: {vcpkgCommit: $vcpkgCommit},
    runtime: {
      node: $node,
      npm: $npm,
      profileId: $profileId,
      profileManifestDigest: $profileManifestDigest,
      profileDigest: $profileDigest,
      baseFamily: $baseFamily,
      targetRuntime: $targetRuntime,
      publishSingleFile: $singleFile,
      publishReadyToRun: $publishReadyToRun,
      tieredPgo: $tieredPgo,
      quickJitForLoops: $quickJitForLoops,
      serverGc: $serverGc,
      nativeAot: $nativeAot,
      gcHeapCountMode: $gcHeapCountMode,
      gcHeapHardLimitMode: $gcHeapHardLimitMode,
      gcHeapHardLimitPercent: $gcHeapHardLimitPercent,
      threadPoolMode: $threadPoolMode,
      threadPoolMinThreadsPerCpu: $threadPoolMinThreadsPerCpu,
      topologyMode: $topologyMode
    }
  }'
