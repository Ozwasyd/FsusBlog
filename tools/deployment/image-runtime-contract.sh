#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[image-runtime-contract] fatal: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: image-runtime-contract.sh <immutable-image-ref>"
image_ref="$1"
[[ "$image_ref" =~ ^[a-z0-9][a-z0-9._:-]*(/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$ ]] \
  || fail "target image reference must be immutable: <registry>/<repository>@sha256:<64 lowercase hex>"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"

docker pull "$image_ref" >/dev/null 2>&1 \
  || fail "unable to pull target image: $image_ref"

image_label() {
  local key="$1"
  docker image inspect "$image_ref" --format "{{ index .Config.Labels \"$key\" }}" 2>/dev/null \
    || fail "unable to inspect target image label: $key"
}

vcpkg_commit="$(image_label io.fsusblog.build.vcpkg-commit)"
node_contract="$(image_label io.fsusblog.runtime.node)"
npm_contract="$(image_label io.fsusblog.runtime.npm)"
ready_to_run="$(image_label io.fsusblog.runtime.publish-ready-to-run)"
profile_id="$(image_label io.fsusblog.runtime.profile-id)"
profile_manifest_digest="$(image_label io.fsusblog.runtime.profile-manifest-digest)"
profile_digest="$(image_label io.fsusblog.runtime.profile-digest)"
base_family="$(image_label io.fsusblog.runtime.base-family)"
target_runtime="$(image_label io.fsusblog.runtime.target-runtime)"
single_file="$(image_label io.fsusblog.runtime.publish-single-file)"
tiered_pgo="$(image_label io.fsusblog.runtime.tiered-pgo)"
quick_jit="$(image_label io.fsusblog.runtime.quick-jit-for-loops)"
server_gc="$(image_label io.fsusblog.runtime.server-gc)"
native_aot="$(image_label io.fsusblog.runtime.native-aot)"
thread_pool_mode="$(image_label io.fsusblog.runtime.thread-pool-mode)"
topology_mode="$(image_label io.fsusblog.runtime.topology-mode)"

[[ "$vcpkg_commit" =~ ^[0-9a-f]{40}$ ]] \
  || fail "target image vcpkg commit label must be a full lowercase Git SHA"
[[ "$node_contract" == "required" ]] \
  || fail "target image node contract label must be required"
[[ "$npm_contract" == "forbidden" ]] \
  || fail "target image npm contract label must be forbidden"
[[ "$profile_id" =~ ^[a-z][a-z0-9-]{2,63}$ ]] || fail "target image runtime profile id label is invalid"
[[ "$profile_manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "target image runtime profile manifest digest label is invalid"
[[ "$profile_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "target image runtime profile digest label is invalid"
[[ "$base_family" == "musl" || "$base_family" == "glibc" ]] || fail "target image runtime base family label is invalid"
[[ "$target_runtime" == "linux-musl-x64" || "$target_runtime" == "linux-x64" ]] || fail "target image target runtime label is invalid"
[[ "$base_family:$target_runtime" == "musl:linux-musl-x64" || "$base_family:$target_runtime" == "glibc:linux-x64" ]] || fail "target image runtime base family and target runtime mismatch"
for value in "$single_file" "$ready_to_run" "$tiered_pgo" "$quick_jit" "$server_gc" "$native_aot"; do
  [[ "$value" == "true" || "$value" == "false" ]] || fail "target image runtime boolean label is invalid"
done
[[ "$server_gc" == "true" ]] || fail "target image server GC label must remain true"
[[ "$native_aot" == "false" ]] || fail "target full image cannot claim NativeAOT without narrow prototype parity promotion"
[[ "$thread_pool_mode" == "runtime-default" || "$thread_pool_mode" == "evidence-derived" || "$thread_pool_mode" == "overprovisioned-negative-control" ]] || fail "target image thread pool mode label is invalid"
[[ "$topology_mode" == "smt-visible" || "$topology_mode" == "physical-core-only" || "$topology_mode" == "numa-local" ]] || fail "target image topology mode label is invalid"

docker run --rm --entrypoint /bin/sh "$image_ref" -c 'command -v node >/dev/null 2>&1' >/dev/null 2>&1 \
  || fail "target image runtime must provide node"
docker run --rm --entrypoint /bin/sh "$image_ref" -c '! command -v npm >/dev/null 2>&1' >/dev/null 2>&1 \
  || fail "target image runtime must not provide npm"

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
  --arg threadPoolMode "$thread_pool_mode" \
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
      threadPoolMode: $threadPoolMode,
      topologyMode: $topologyMode
    }
  }'
