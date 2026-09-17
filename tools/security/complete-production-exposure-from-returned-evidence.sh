#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RETURNED_DIR="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_DIR:-}}"

Fail() {
    printf '[production-exposure-returned-closeout] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

if [[ -z "$RETURNED_DIR" ]]; then
    Fail 'missing returned evidence directory'
fi

if [[ ! -d "$RETURNED_DIR" ]]; then
    Fail "returned evidence directory does not exist: $RETURNED_DIR"
fi

RETURNED_DIR="$(cd "$RETURNED_DIR" && pwd)"
[[ -f "$RETURNED_DIR/expected-evidence-manifest.json" ]] ||
    Fail "returned evidence is missing expected-evidence-manifest.json: $RETURNED_DIR"

PARENT_DIR="$(dirname "$RETURNED_DIR")"
if [[ "$(basename "$RETURNED_DIR")" == "returned-evidence" ]] &&
    { [[ -d "$PARENT_DIR/release-evidence" ]] || [[ -f "$PARENT_DIR/SHA256SUMS" ]] || [[ -f "$PARENT_DIR/handoff-summary.json" ]]; }; then
    "$ROOT_DIR/tools/security/check-production-exposure-handoff-bundle.sh" "$PARENT_DIR" >/dev/null ||
        Fail "parent handoff bundle verification failed: $PARENT_DIR"
fi

export FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_DIR="$RETURNED_DIR"
export FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$RETURNED_DIR/production-firewall-policy.json"
export FSUSBLOG_DNS_READINESS_EVIDENCE="$RETURNED_DIR/production-dns-readiness.json"
export FSUSBLOG_DNS_DELEGATION_EVIDENCE="$RETURNED_DIR/production-dns-delegation.json"
export FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$RETURNED_DIR/production-exposure-live.json"
export FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$RETURNED_DIR/production-exposure-status.json"
export FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$RETURNED_DIR/production-exposure-evidence-request.json"

"$ROOT_DIR/tools/security/verify-production-exposure-returned-evidence.sh" "$RETURNED_DIR" >/dev/null
"$ROOT_DIR/tools/security/verify-production-exposure-closeout.sh" "$FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE" >/dev/null

printf '[production-exposure-returned-closeout] ok\n'
