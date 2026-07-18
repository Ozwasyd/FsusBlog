#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

SLOT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            [[ $# -ge 2 ]] || SlotFail "--slot requires a value"
            SLOT="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || SlotFail "--state-file requires a value"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

SlotRequireCommand jq
SlotRequireCommand node
state="$(SlotStateRead)"

InspectOne() {
    "$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$1" --state-file "$SLOT_STATE_FILE"
}

if [[ -n "$SLOT" ]]; then
    SlotRequire "$SLOT"
    InspectOne "$SLOT"
    exit 0
fi

blue="$(InspectOne blue)"
green="$(InspectOne green)"
jq -cn \
    --argjson state "$state" \
    --argjson blue "$blue" \
    --argjson green "$green" '
  {
    schema: "fsusblog.deployment-slot-status.v1",
    gatewayStatus: $state.status,
    activeSlot: $state.activeSlot,
    activeReleaseId: $state.activeReleaseId,
    activeImageDigest: $state.activeImageDigest,
    previousSlot: $state.previousSlot,
    previousReleaseId: $state.previousReleaseId,
    previousImageDigest: $state.previousImageDigest,
    switchedAtUtc: $state.switchedAtUtc,
    switchGeneration: $state.switchGeneration,
    runtimeGeneration: $state.runtimeGeneration,
    pendingTransition: $state.pendingTransition,
    lastTransition: $state.lastTransition,
    lastTrafficTransition: $state.lastTrafficTransition,
    updatedAt: $state.updatedAt,
    slots: {blue: $blue, green: $green},
    runtimeGenerationsConsistent: (
      ((($blue.exists and $blue.running) | not) or ($blue.release.deploymentGeneration == $blue.persisted.record.deploymentGeneration and $blue.release.deploymentGeneration <= $state.runtimeGeneration))
      and ((($green.exists and $green.running) | not) or ($green.release.deploymentGeneration == $green.persisted.record.deploymentGeneration and $green.release.deploymentGeneration <= $state.runtimeGeneration))
    ),
    activeStateConsistent: (
      $state.activeSlot == null
      or (($state.activeSlot == "blue" and $blue.exists and $blue.running and $blue.identityMatchesSlot and $blue.liveness == "ok" and $blue.readiness == "ok" and $blue.release.releaseId == $state.activeReleaseId and $blue.release.imageDigest == $state.activeImageDigest and $blue.release.deploymentGeneration == $blue.persisted.record.deploymentGeneration and $blue.release.deploymentGeneration <= $state.runtimeGeneration)
      or ($state.activeSlot == "green" and $green.exists and $green.running and $green.identityMatchesSlot and $green.liveness == "ok" and $green.readiness == "ok" and $green.release.releaseId == $state.activeReleaseId and $green.release.imageDigest == $state.activeImageDigest and $green.release.deploymentGeneration == $green.persisted.record.deploymentGeneration and $green.release.deploymentGeneration <= $state.runtimeGeneration))
    )
  }'
