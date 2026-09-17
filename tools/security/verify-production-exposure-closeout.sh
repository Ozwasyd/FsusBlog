#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_FILE="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"
VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh"
FIREWALL_VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh"
STATUS_SCRIPT="$ROOT_DIR/tools/security/report-production-exposure-status.sh"

export FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$EVIDENCE_FILE"
export FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$FIREWALL_POLICY_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$STATUS_FILE"

Fail() {
    printf '[production-exposure-closeout] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

if [[ -z "${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-}" && -f "$EVIDENCE_FILE" ]] && command -v jq >/dev/null 2>&1; then
    FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS="$(
        jq -r '
      if (.requiredHosts | type) == "array" then
        (.requiredHosts | map(tostring) | join(" "))
      else
        (.requiredHosts // "")
      end
    ' "$EVIDENCE_FILE"
    )"
    export FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS
fi

"$FIREWALL_VERIFY_SCRIPT" "$FIREWALL_POLICY_FILE" >/dev/null
"$VERIFY_SCRIPT" "$EVIDENCE_FILE" >/dev/null
"$STATUS_SCRIPT" >/dev/null

[[ -f "$STATUS_FILE" ]] || Fail "missing production exposure status report: $STATUS_FILE"

if ! jq -e '.status == "ok"' "$STATUS_FILE" >/dev/null 2>&1; then
    printf '[production-exposure-closeout] failed\n' >&2
    printf -- '- production exposure status is not ok: %s\n' "$STATUS_FILE" >&2
    jq -r '.blockers[]? | "- " + (.source // "unknown") + ": " + (.message // "blocked")' "$STATUS_FILE" >&2 || true
    exit 1
fi

printf '[production-exposure-closeout] ok\n'
