#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/slot-common.sh"

ACTION="${1:-}"
[[ -n "$ACTION" ]] || slot_fail "usage: deployment-control.sh <activate|drain|status> [options]"
shift

SLOT=""
RELEASE_ID=""
GENERATION=""
PORT=""
TIMEOUT_SECONDS=""
WAIT_FOR_DRAIN=0
DRY_RUN=0
AUTH_HEADER_FILE="${FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE:-}"
CONTROL_ORIGIN="${FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slot) [[ $# -ge 2 ]] || slot_fail "--slot requires a value"; SLOT="$2"; shift 2 ;;
    --release) [[ $# -ge 2 ]] || slot_fail "--release requires a value"; RELEASE_ID="$2"; shift 2 ;;
    --generation) [[ $# -ge 2 ]] || slot_fail "--generation requires a value"; GENERATION="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || slot_fail "--port requires a value"; PORT="$2"; shift 2 ;;
    --timeout-seconds) [[ $# -ge 2 ]] || slot_fail "--timeout-seconds requires a value"; TIMEOUT_SECONDS="$2"; shift 2 ;;
    --admin-header-file) [[ $# -ge 2 ]] || slot_fail "--admin-header-file requires a path"; AUTH_HEADER_FILE="$2"; shift 2 ;;
    --origin) [[ $# -ge 2 ]] || slot_fail "--origin requires an HTTPS origin"; CONTROL_ORIGIN="$2"; shift 2 ;;
    --wait) WAIT_FOR_DRAIN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) slot_fail "unknown argument: $1" ;;
  esac
done

[[ "$ACTION" == "activate" || "$ACTION" == "drain" || "$ACTION" == "status" ]] \
  || slot_fail "action must be activate, drain or status"
slot_require_command awk
slot_require_command curl
slot_require_command grep
slot_require_command jq
slot_require_command sleep
slot_require_command stat

if [[ "$ACTION" != "status" ]]; then
  slot_require "$SLOT"
  [[ "$RELEASE_ID" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{5,127}$ ]] || slot_fail "--release is invalid"
  [[ "$GENERATION" =~ ^[0-9]+$ && "$GENERATION" -ge 1 ]] || slot_fail "--generation must be a positive integer"
fi
if [[ -z "$PORT" && -n "$SLOT" ]]; then
  slot_configure "$SLOT"
  PORT="$FSUSBLOG_SLOT_PORT"
fi
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || slot_fail "--port is invalid"
[[ "$CONTROL_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
  || { [[ "${FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE:-0}" == "1" && "$CONTROL_ORIGIN" =~ ^http://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
    || slot_fail "deployment control origin must be an explicit HTTPS origin"; }
[[ -f "$AUTH_HEADER_FILE" ]] || slot_fail "deployment admin header file is missing"
header_mode="$(stat -c '%a' "$AUTH_HEADER_FILE")"
[[ "$header_mode" == "400" || "$header_mode" == "600" ]] \
  || slot_fail "deployment admin header file must have mode 0400 or 0600"
awk '
  NR > 1 { exit 1 }
  END { if (NR != 1) exit 1 }
' "$AUTH_HEADER_FILE" || slot_fail "deployment admin header file must contain exactly one header line"
grep -Eq '^(Authorization: Bearer |Cookie: )[^[:cntrl:]]+$' "$AUTH_HEADER_FILE" \
  || slot_fail "deployment admin header file must contain one Authorization Bearer or Cookie header"

endpoint="/api/ops/deployment/$ACTION"
url="http://127.0.0.1:$PORT$endpoint"
if [[ "$DRY_RUN" == "1" ]]; then
  jq -cn \
    --arg action "$ACTION" \
    --arg slot "$SLOT" \
    --arg releaseId "$RELEASE_ID" \
    --arg origin "$CONTROL_ORIGIN" \
    --arg endpoint "$url" \
    --argjson generation "${GENERATION:-0}" \
    --argjson waitForDrain "$([[ "$WAIT_FOR_DRAIN" == "1" ]] && printf true || printf false)" \
    '{status: "dry-run", action: $action, endpoint: $endpoint, trustedLoopback: true, authenticatedAdminHeaderPresent: true, origin: $origin, release: {slot: $slot, releaseId: $releaseId, generation: $generation}, waitForDrain: $waitForDrain}'
  exit 0
fi

request() {
  local method="$1"
  local request_url="$2"
  local body="${3:-}"
  local -a args=(
    -fsS
    --max-time 15
    --header "@$AUTH_HEADER_FILE"
    --header "Origin: $CONTROL_ORIGIN"
    --header "Accept: application/json"
  )
  if [[ "$method" == "POST" ]]; then
    args+=(--request POST --header "Content-Type: application/json" --data-binary @-)
    printf '%s\n' "$body" | curl "${args[@]}" "$request_url"
  else
    curl "${args[@]}" "$request_url"
  fi
}

if [[ "$ACTION" == "status" ]]; then
  response="$(request GET "$url")" || slot_fail "deployment status request failed"
  jq -e '.releaseId and .slot and .state and (.generation | type == "number")' >/dev/null <<< "$response" \
    || slot_fail "deployment status response is invalid"
  printf '%s\n' "$response"
  exit 0
fi

body="$(jq -cn \
  --arg releaseId "$RELEASE_ID" \
  --arg slot "$SLOT" \
  --argjson generation "$GENERATION" \
  --argjson timeoutSeconds "${TIMEOUT_SECONDS:-null}" \
  '{releaseId: $releaseId, slot: $slot, generation: $generation, timeoutSeconds: $timeoutSeconds}')"
response="$(request POST "$url" "$body")" || slot_fail "deployment $ACTION request failed"
jq -e '.accepted == true and .snapshot.releaseId and .snapshot.slot and (.snapshot.generation | type == "number")' >/dev/null <<< "$response" \
  || slot_fail "deployment $ACTION was rejected or returned an invalid response"

if [[ "$ACTION" != "drain" || "$WAIT_FOR_DRAIN" != "1" ]]; then
  printf '%s\n' "$response"
  exit 0
fi

wait_timeout="${TIMEOUT_SECONDS:-${FSUSBLOG_DRAIN_TIMEOUT_SECONDS:-45}}"
[[ "$wait_timeout" =~ ^[0-9]+$ && "$wait_timeout" -ge 5 && "$wait_timeout" -le 300 ]] \
  || slot_fail "drain wait timeout must be between 5 and 300 seconds"
deadline=$((SECONDS + wait_timeout + 2))
while (( SECONDS < deadline )); do
  status_response="$(request GET "http://127.0.0.1:$PORT/api/ops/deployment/status")" \
    || slot_fail "deployment drain status request failed"
  if [[ "$(jq -r '.drain.drained' <<< "$status_response")" == "true" ]]; then
    printf '%s\n' "$status_response"
    exit 0
  fi
  if [[ "$(jq -r '.drain.timedOut' <<< "$status_response")" == "true" ]]; then
    printf '[deployment-slot] fatal: drain timed out; blockers=%s\n' \
      "$(jq -c '.drain.blockers' <<< "$status_response")" >&2
    exit 1
  fi
  sleep 1
done

slot_fail "deployment drain status did not reach a terminal state before the control timeout"
