#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

[[ "${FSUSBLOG_ROLLOUT_ENTRY:-0}" == "1" ]] ||
    SlotFail "slot-stop is internal; use release-rollout.sh or its durable recovery entry"

SLOT=""
ROLLOUT_STATE_FILE="${FSUSBLOG_ROLLOUT_STATE_FILE:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            [[ $# -ge 2 ]] || SlotFail "--slot requires a value"
            SLOT="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || SlotFail "--env-file requires a path"
            PRODUCTION_ENV_FILE="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || SlotFail "--state-file requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        --rollout-state)
            [[ $# -ge 2 ]] || SlotFail "--rollout-state requires a path"
            ROLLOUT_STATE_FILE="$2"
            shift 2
            ;;
        *) SlotFail "unknown argument: $1" ;;
    esac
done

SlotRequire "$SLOT"
[[ -n "$ROLLOUT_STATE_FILE" && -f "$ROLLOUT_STATE_FILE" ]] ||
    SlotFail "durable rollout state is required for destructive slot stop"
SlotRequireCommand docker
SlotRequireCommand jq
SlotRequireCommand node
SlotAcquireDeploymentLock
SlotConfigure "$SLOT"

state="$(SlotStateReadCurrent)"
active_slot="$(jq -r '.activeSlot // ""' <<<"$state")"
[[ "$(jq -r '.status' <<<"$state")" == "stable" ]] || SlotFail "gateway state is not stable; recover it before stopping a slot"
[[ -n "$active_slot" ]] || SlotFail "durable active runtime identity is missing; refusing destructive slot stop"
[[ "$active_slot" != "$SLOT" ]] || SlotFail "refusing to stop active slot $SLOT"

before="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
active="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$active_slot" --state-file "$SLOT_STATE_FILE")"
verification_dir="$(mktemp -d)"
trap 'rm -rf "$verification_dir"' EXIT
printf '%s\n' "$before" >"$verification_dir/target.json"
printf '%s\n' "$active" >"$verification_dir/active.json"
verification="$(node "$ROOT_DIR/tools/deployment/verify-destructive-operation.mjs" runtime-slot-stop \
    --slot-state "$SLOT_STATE_FILE" \
    --rollout-state "$ROLLOUT_STATE_FILE" \
    --target-observation "$verification_dir/target.json" \
    --active-observation "$verification_dir/active.json")" ||
    SlotFail "runtime stop identity verification failed"
if [[ "$(jq -r '.alreadyStopped' <<<"$verification")" == "true" ]]; then
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null
    jq -cn --arg slot "$SLOT" '{status: "already-stopped", slot: $slot}'
    exit 0
fi

zero_digest="sha256:$(printf '0%.0s' {1..64})"
FSUSBLOG_RELEASE_ID="$(jq -r 'if (.release.releaseId // "") == "" then "stopped-slot" else .release.releaseId end' <<<"$before")"
FSUSBLOG_COMMIT_SHA="$(jq -r 'if (.release.commitSha // "") == "" then "0000000000000000000000000000000000000000" else .release.commitSha end' <<<"$before")"
FSUSBLOG_IMAGE_REF="$(jq -r --arg fallback "fsusblogapp@$zero_digest" 'if (.release.imageRef // "") == "" then $fallback else .release.imageRef end' <<<"$before")"
FSUSBLOG_IMAGE_DIGEST="$(jq -r --arg fallback "$zero_digest" 'if (.release.imageDigest // "") == "" then $fallback else .release.imageDigest end' <<<"$before")"
export FSUSBLOG_RELEASE_ID FSUSBLOG_COMMIT_SHA FSUSBLOG_IMAGE_REF FSUSBLOG_IMAGE_DIGEST

if ! SlotCompose down --remove-orphans; then
    SlotStateRecordFailure "$SLOT" stop "slot-scoped Compose down failed" || true
    SlotFail "failed to stop slot $SLOT"
fi
node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null

after="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
jq -cn --argjson slot "$after" '{status: "stopped", slot: $slot}'
