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

[[ "$vcpkg_commit" =~ ^[0-9a-f]{40}$ ]] \
  || fail "target image vcpkg commit label must be a full lowercase Git SHA"
[[ "$node_contract" == "required" ]] \
  || fail "target image node contract label must be required"
[[ "$npm_contract" == "forbidden" ]] \
  || fail "target image npm contract label must be forbidden"
[[ "$ready_to_run" == "false" ]] \
  || fail "target image publish-ready-to-run label must be false"

docker run --rm --entrypoint /bin/sh "$image_ref" -c 'command -v node >/dev/null 2>&1' >/dev/null 2>&1 \
  || fail "target image runtime must provide node"
docker run --rm --entrypoint /bin/sh "$image_ref" -c '! command -v npm >/dev/null 2>&1' >/dev/null 2>&1 \
  || fail "target image runtime must not provide npm"

jq -cn \
  --arg imageRef "$image_ref" \
  --arg vcpkgCommit "$vcpkg_commit" \
  --arg node "$node_contract" \
  --arg npm "$npm_contract" \
  --arg publishReadyToRun "$ready_to_run" '
  {
    schema: "fsusblog.image-runtime-contract.v1",
    status: "ok",
    imageRef: $imageRef,
    build: {vcpkgCommit: $vcpkgCommit},
    runtime: {
      node: $node,
      npm: $npm,
      publishReadyToRun: $publishReadyToRun
    }
  }'
