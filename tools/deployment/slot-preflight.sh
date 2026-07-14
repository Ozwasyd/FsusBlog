#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

SLOT=""
RELEASE_MANIFEST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) [[ $# -ge 2 ]] || slot_fail "--slot requires a value"; SLOT="$2"; shift 2 ;;
    --release-manifest) [[ $# -ge 2 ]] || slot_fail "--release-manifest requires a path"; RELEASE_MANIFEST="$2"; shift 2 ;;
    --env-file) [[ $# -ge 2 ]] || slot_fail "--env-file requires a path"; PRODUCTION_ENV_FILE="$2"; shift 2 ;;
    --state-file) [[ $# -ge 2 ]] || slot_fail "--state-file requires a path"; SLOT_STATE_FILE="$2"; shift 2 ;;
    *) slot_fail "unknown argument: $1" ;;
  esac
done

slot_require "$SLOT"
[[ -n "$RELEASE_MANIFEST" ]] || slot_fail "--release-manifest is required"
slot_require_command awk
slot_require_command curl
slot_require_command df
slot_require_command docker
slot_require_command jq
slot_require_command node
slot_require_command ss
slot_configure "$SLOT"
slot_load_manifest "$RELEASE_MANIFEST" "$SLOT"
node "$ROOT_DIR/tools/deployment/slot-state.mjs" ensure --state "$SLOT_STATE_FILE" >/dev/null \
  || slot_fail "slot state path is not writable and durable"

docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || slot_fail "Docker daemon is unavailable"
[[ -d "$docker_root" ]] || slot_fail "Docker root directory is unavailable: $docker_root"
uploads_volume="$(slot_env_value FSUSBLOG_SHARED_UPLOADS_VOLUME "$PRODUCTION_ENV_FILE")"
data_protection_volume="$(slot_env_value FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME "$PRODUCTION_ENV_FILE")"
drain_timeout_value="${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-$(slot_env_optional_value FSUSBLOG_DRAIN_TIMEOUT_SECONDS "$PRODUCTION_ENV_FILE")}"
stop_grace_value="${FSUSBLOG_STOP_GRACE_PERIOD:-$(slot_env_optional_value FSUSBLOG_STOP_GRACE_PERIOD "$PRODUCTION_ENV_FILE")}"
drain_timeout_value="${drain_timeout_value:-45}"
stop_grace_value="${stop_grace_value:-60s}"
[[ "$drain_timeout_value" =~ ^[0-9]+$ ]] \
  || slot_fail "FSUSBLOG_DRAIN_TIMEOUT_SECONDS must be an integer number of seconds"
drain_timeout_seconds="$drain_timeout_value"
stop_grace_seconds="$(slot_duration_seconds "$stop_grace_value")" \
  || slot_fail "FSUSBLOG_STOP_GRACE_PERIOD must be an integer duration using seconds, s, m or h"
(( drain_timeout_seconds >= 5 && drain_timeout_seconds <= 300 )) \
  || slot_fail "FSUSBLOG_DRAIN_TIMEOUT_SECONDS must be between 5 and 300"
(( stop_grace_seconds > drain_timeout_seconds )) \
  || slot_fail "FSUSBLOG_STOP_GRACE_PERIOD must be greater than the application drain timeout"
docker volume inspect "$uploads_volume" >/dev/null 2>&1 || slot_fail "shared uploads volume does not exist: $uploads_volume"
docker volume inspect "$data_protection_volume" >/dev/null 2>&1 || slot_fail "shared DataProtection volume does not exist: $data_protection_volume"
docker network inspect fsus-infra-network >/dev/null 2>&1 || slot_fail "external infrastructure network does not exist: fsus-infra-network"

memory_available_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024); found=1 } END { if (!found) exit 1 }' /proc/meminfo)" || slot_fail "unable to read host available memory"
minimum_memory_mb="${FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB:-1536}"
[[ "$minimum_memory_mb" =~ ^[0-9]+$ ]] || slot_fail "FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB must be an integer"
(( minimum_memory_mb >= 256 )) || slot_fail "FSUSBLOG_SLOT_MIN_AVAILABLE_MEMORY_MB cannot be lower than 256"
(( memory_available_mb >= minimum_memory_mb )) || slot_fail "insufficient available memory: ${memory_available_mb}MB < ${minimum_memory_mb}MB"

disk_available_mb="$(df -Pk "$docker_root" | awk 'NR == 2 { print int($4 / 1024) }')"
minimum_free_disk_mb="${FSUSBLOG_SLOT_MIN_FREE_DISK_MB:-2048}"
image_pull_reserve_mb="${FSUSBLOG_SLOT_IMAGE_PULL_RESERVE_MB:-2048}"
[[ "$minimum_free_disk_mb" =~ ^[0-9]+$ && "$image_pull_reserve_mb" =~ ^[0-9]+$ ]] || slot_fail "disk reserve settings must be integers"
(( minimum_free_disk_mb >= 256 )) || slot_fail "FSUSBLOG_SLOT_MIN_FREE_DISK_MB cannot be lower than 256"
(( image_pull_reserve_mb >= 256 )) || slot_fail "FSUSBLOG_SLOT_IMAGE_PULL_RESERVE_MB cannot be lower than 256"
required_disk_mb=$((minimum_free_disk_mb + image_pull_reserve_mb))
(( disk_available_mb >= required_disk_mb )) || slot_fail "insufficient Docker disk space: ${disk_available_mb}MB < ${required_disk_mb}MB (free floor + image pull reserve)"

image_contract="$(bash "$ROOT_DIR/tools/deployment/image-runtime-contract.sh" "$FSUSBLOG_IMAGE_REF")" \
  || slot_fail "target image runtime contract validation failed"
manifest_contract="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" --manifest "$RELEASE_MANIFEST")" \
  || slot_fail "release manifest runtime profile validation failed"
if [[ "$(jq -r '.runtimeProfile != null' <<< "$manifest_contract")" == "true" ]]; then
  jq -e --argjson image "$image_contract" '
    .runtimeProfile.id == $image.runtime.profileId and
    .runtimeProfile.manifestDigest == $image.runtime.profileManifestDigest and
    .runtimeProfile.profileDigest == $image.runtime.profileDigest and
    .runtimeProfile.baseImageFamily == $image.runtime.baseFamily and
    .runtimeProfile.targetRuntime == $image.runtime.targetRuntime and
    (.runtimeProfile.singleFile | tostring) == $image.runtime.publishSingleFile and
    (.runtimeProfile.readyToRun | tostring) == $image.runtime.publishReadyToRun and
    (.runtimeProfile.tieredPgo | tostring) == $image.runtime.tieredPgo and
    (.runtimeProfile.quickJitForLoops | tostring) == $image.runtime.quickJitForLoops and
    (.runtimeProfile.serverGc | tostring) == $image.runtime.serverGc and
    (.runtimeProfile.nativeAot | tostring) == $image.runtime.nativeAot and
    .runtimeProfile.threadPoolMode == $image.runtime.threadPoolMode and
    .runtimeProfile.topologyMode == $image.runtime.topologyMode
  ' <<< "$manifest_contract" >/dev/null \
    || slot_fail "target image runtime profile labels do not match the release manifest"
fi

state="$(slot_state_read)"
[[ "$(jq -r '.status' <<< "$state")" == "stable" ]] || slot_fail "gateway state is not stable; recovery is required before candidate start"
active_slot="$(jq -r '.activeSlot // ""' <<< "$state")"
persisted_release="$(jq -r --arg slot "$SLOT" '.slots[$slot].releaseId // ""' <<< "$state")"
if [[ "$active_slot" == "$SLOT" && -n "$persisted_release" && "$persisted_release" != "$FSUSBLOG_RELEASE_ID" ]]; then
  slot_fail "refusing to replace active slot $SLOT release $persisted_release"
fi
if [[ -n "$active_slot" && "$active_slot" != "$SLOT" ]]; then
  active_release="$(jq -r --arg slot "$active_slot" '.slots[$slot].releaseId // ""' <<< "$state")"
  active_digest="$(jq -r --arg slot "$active_slot" '.slots[$slot].imageDigest // ""' <<< "$state")"
  [[ "$active_release" != "$FSUSBLOG_RELEASE_ID" ]] || slot_fail "candidate releaseId must differ from active releaseId"
  [[ "$active_digest" != "$FSUSBLOG_IMAGE_DIGEST" ]] || slot_fail "candidate image digest must differ from active image digest"
fi

target_inspect="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
target_exists="$(jq -r '.exists' <<< "$target_inspect")"
target_running="$(jq -r '.running' <<< "$target_inspect")"
target_identity="$(jq -r '.identityMatchesSlot // false' <<< "$target_inspect")"
if [[ "$target_exists" == "true" && "$target_identity" != "true" ]]; then
  slot_fail "target container identity does not match slot $SLOT"
fi
if slot_port_listening "$FSUSBLOG_SLOT_PORT" && [[ "$target_running" != "true" ]]; then
  slot_fail "target loopback port 127.0.0.1:$FSUSBLOG_SLOT_PORT is already occupied"
fi
if [[ "$target_running" == "true" && "$(jq -r '.loopbackOnly' <<< "$target_inspect")" != "true" ]]; then
  slot_fail "slot $SLOT is not bound exclusively to 127.0.0.1:$FSUSBLOG_SLOT_PORT"
fi

if [[ -n "$active_slot" ]]; then
  active_inspect="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$active_slot" --state-file "$SLOT_STATE_FILE")"
  if [[ "$(jq -r '.running and .identityMatchesSlot and .loopbackOnly' <<< "$active_inspect")" != "true" ]]; then
    slot_fail "persisted active slot $active_slot is not healthy enough for a safe candidate start"
  fi
  active_port="$(jq -r '.port' <<< "$active_inspect")"
  curl -fsS --max-time 5 "http://127.0.0.1:$active_port/health/ready" >/dev/null \
    || slot_fail "persisted active slot $active_slot readiness probe failed"
fi

jq -cn \
  --arg slot "$SLOT" \
  --arg activeSlot "$active_slot" \
  --arg releaseId "$FSUSBLOG_RELEASE_ID" \
  --arg imageRef "$FSUSBLOG_IMAGE_REF" \
  --arg uploadsVolume "$uploads_volume" \
  --arg dataProtectionVolume "$data_protection_volume" \
  --argjson port "$FSUSBLOG_SLOT_PORT" \
  --argjson memoryAvailableMb "$memory_available_mb" \
  --argjson minimumMemoryMb "$minimum_memory_mb" \
  --argjson diskAvailableMb "$disk_available_mb" \
  --argjson minimumFreeDiskMb "$minimum_free_disk_mb" \
  --argjson imagePullReserveMb "$image_pull_reserve_mb" \
  --argjson drainTimeoutSeconds "$drain_timeout_seconds" \
  --argjson stopGracePeriodSeconds "$stop_grace_seconds" \
  --argjson imageContract "$image_contract" \
  --argjson target "$target_inspect" '
  {
    schema: "fsusblog.deployment-slot-preflight.v1",
    status: "ok",
    slot: $slot,
    activeSlot: (if $activeSlot == "" then null else $activeSlot end),
    releaseId: $releaseId,
    imageRef: $imageRef,
    sharedState: {uploadsVolume: $uploadsVolume, dataProtectionVolume: $dataProtectionVolume, infrastructureNetwork: "fsus-infra-network"},
    endpoint: {host: "127.0.0.1", port: $port},
    resources: {
      memoryAvailableMb: $memoryAvailableMb,
      minimumMemoryMb: $minimumMemoryMb,
      dockerDiskAvailableMb: $diskAvailableMb,
      minimumFreeDiskMb: $minimumFreeDiskMb,
      imagePullReserveMb: $imagePullReserveMb
    },
    lifecycle: {
      candidateMode: true,
      drainTimeoutSeconds: $drainTimeoutSeconds,
      stopGracePeriodSeconds: $stopGracePeriodSeconds,
      stopGraceExceedsDrain: ($stopGracePeriodSeconds > $drainTimeoutSeconds)
    },
    imageContract: $imageContract,
    targetBeforeStart: $target
  }'
