#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${FSUSBLOG_ROLLOUT_ENTRY:-0}" == "1" ]] \
  || { echo "gateway-rollback is internal; use release-rollout.sh or its durable recovery entry" >&2; exit 1; }
STATE_FILE="${FSUSBLOG_SLOT_STATE_FILE:-/var/lib/fsusblog/deployment/slots.json}"
DRY_RUN=0
PASSTHROUGH=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file) [[ $# -ge 2 ]] || { echo "--state-file requires a path" >&2; exit 1; }; STATE_FILE="$2"; PASSTHROUGH+=(--state-file "$2"); shift 2 ;;
    --active-upstream|--gateway-config|--public-url|--evidence-dir|--admin-header-file|--control-origin|--drain-timeout-seconds|--rollout-state-file)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; exit 1; }
      PASSTHROUGH+=("$1" "$2")
      shift 2
      ;;
    --defer-source-drain) PASSTHROUGH+=(--defer-source-drain); shift ;;
    --dry-run) DRY_RUN=1; PASSTHROUGH+=(--dry-run); shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

state="$(node "$ROOT_DIR/tools/deployment/slot-state.mjs" read --state "$STATE_FILE")" || exit 1
[[ "$(jq -r '.status' <<< "$state")" == "stable" ]] || { echo "gateway state is not stable" >&2; exit 1; }
previous_slot="$(jq -r '.previousSlot // ""' <<< "$state")"
previous_release="$(jq -r '.previousReleaseId // ""' <<< "$state")"
previous_digest="$(jq -r '.previousImageDigest // ""' <<< "$state")"
[[ -n "$previous_slot" && -n "$previous_release" && -n "$previous_digest" ]] \
  || { echo "recorded previous release is unavailable" >&2; exit 1; }

exec "$ROOT_DIR/tools/deployment/gateway-switch.sh" \
  --to "$previous_slot" \
  --release "$previous_release" \
  --image-digest "$previous_digest" \
  --kind rollback \
  "${PASSTHROUGH[@]}"
