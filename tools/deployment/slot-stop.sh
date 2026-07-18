#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

[[ "${FSUSBLOG_ROLLOUT_ENTRY:-0}" == "1" ]] ||
    slot_fail "slot-stop is internal; use release-rollout.sh or its durable recovery entry"

SLOT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --slot)
            [[ $# -ge 2 ]] || slot_fail "--slot requires a value"
            SLOT="$2"
            shift 2
            ;;
        --env-file)
            [[ $# -ge 2 ]] || slot_fail "--env-file requires a path"
            PRODUCTION_ENV_FILE="$2"
            shift 2
            ;;
        --state-file)
            [[ $# -ge 2 ]] || slot_fail "--state-file requires a path"
            SLOT_STATE_FILE="$2"
            shift 2
            ;;
        *) slot_fail "unknown argument: $1" ;;
    esac
done

slot_require "$SLOT"
slot_require_command docker
slot_require_command jq
slot_require_command node
slot_acquire_deployment_lock
slot_configure "$SLOT"

state="$(slot_state_read)"
active_slot="$(jq -r '.activeSlot // ""' <<<"$state")"
[[ "$(jq -r '.status' <<<"$state")" == "stable" ]] || slot_fail "gateway state is not stable; recover it before stopping a slot"
[[ "$active_slot" != "$SLOT" ]] || slot_fail "refusing to stop active slot $SLOT"

before="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
if [[ "$(jq -r '.exists' <<<"$before")" != "true" ]]; then
    node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null
    jq -cn --arg slot "$SLOT" '{status: "already-stopped", slot: $slot}'
    exit 0
fi
[[ "$(jq -r '.identityMatchesSlot' <<<"$before")" == "true" ]] ||
    slot_fail "refusing to stop container whose labels do not match slot $SLOT"

zero_digest="sha256:$(printf '0%.0s' {1..64})"
export FSUSBLOG_RELEASE_ID="$(jq -r 'if (.release.releaseId // "") == "" then "stopped-slot" else .release.releaseId end' <<<"$before")"
export FSUSBLOG_COMMIT_SHA="$(jq -r 'if (.release.commitSha // "") == "" then "0000000000000000000000000000000000000000" else .release.commitSha end' <<<"$before")"
export FSUSBLOG_IMAGE_REF="$(jq -r --arg fallback "fsusblogapp@$zero_digest" 'if (.release.imageRef // "") == "" then $fallback else .release.imageRef end' <<<"$before")"
export FSUSBLOG_IMAGE_DIGEST="$(jq -r --arg fallback "$zero_digest" 'if (.release.imageDigest // "") == "" then $fallback else .release.imageDigest end' <<<"$before")"

if ! slot_compose down --remove-orphans; then
    slot_state_record_failure "$SLOT" stop "slot-scoped Compose down failed" || true
    slot_fail "failed to stop slot $SLOT"
fi
node "$ROOT_DIR/tools/deployment/slot-state.mjs" record-stop --state "$SLOT_STATE_FILE" --slot "$SLOT" >/dev/null

after="$("$ROOT_DIR/tools/deployment/slot-inspect.sh" --slot "$SLOT" --state-file "$SLOT_STATE_FILE")"
jq -cn --argjson slot "$after" '{status: "stopped", slot: $slot}'
