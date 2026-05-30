#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_FILE="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
DNS_READINESS_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"
DNS_DELEGATION_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"
TODO_FILE="${FSUSBLOG_TODO_FILE:-$ROOT_DIR/TODO.md}"
VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh"
FIREWALL_VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh"
STATUS_SCRIPT="$ROOT_DIR/tools/security/report-production-exposure-status.sh"

export FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$EVIDENCE_FILE"
export FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$FIREWALL_POLICY_FILE"

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

"$FIREWALL_VERIFY_SCRIPT" "$FIREWALL_POLICY_FILE"
"$VERIFY_SCRIPT" "$EVIDENCE_FILE"
"$STATUS_SCRIPT"

if [[ ! -f "$TODO_FILE" ]]; then
  printf '[production-exposure-todo-closeout] failed\n' >&2
  printf -- '- missing TODO file: %s\n' "$TODO_FILE" >&2
  exit 1
fi

generated_at="$(jq -r '.generatedAt // "unknown"' "$EVIDENCE_FILE")"
hosts="$(jq -r '[.results[]? | select(.host != null and .host != "-") | .host] | unique | join(", ")' "$EVIDENCE_FILE")"
required_ports="$(jq -r '.requiredOpenPorts // "80 443"' "$EVIDENCE_FILE")"
forbidden_ports="$(jq -r '.forbiddenPublicPorts // "22 6379 5432 8080"' "$EVIDENCE_FILE")"
resolvers="$(jq -r '.dnsResolvers // "1.1.1.1 8.8.8.8"' "$EVIDENCE_FILE")"

tmp="$(mktemp)"
awk \
  -v generated_at="$generated_at" \
  -v hosts="$hosts" \
  -v required_ports="$required_ports" \
  -v forbidden_ports="$forbidden_ports" \
  -v resolvers="$resolvers" \
  -v evidence_file="$EVIDENCE_FILE" \
  -v dns_readiness_file="$DNS_READINESS_FILE" \
  -v dns_delegation_file="$DNS_DELEGATION_FILE" \
  -v status_file="$STATUS_FILE" \
  -v firewall_policy_file="$FIREWALL_POLICY_FILE" '
    BEGIN {
      in_item = 0
      closed_item = 0
      wrote_comment = 0
    }

    $0 ~ /^- 生产可信闭环：`[0-9]+\/5`$/ {
      print "- 生产可信闭环：`5/5`"
      next
    }

    $0 ~ /^- \[[ xX]\] `NB-P0-001` `P0` `production-exposure-closeout`/ {
      print "- [x] `NB-P0-001` `P0` `production-exposure-closeout`"
      in_item = 1
      closed_item = 1
      next
    }

    in_item == 1 && $0 ~ /^  Comment:/ {
      print "  Comment: Done " generated_at ". Code/gates: `tools/security/complete-production-exposure-closeout.sh`, `tools/security/verify-production-firewall-policy-evidence.sh`, `tools/security/check-production-dns-readiness.sh`, `tools/security/check-production-dns-delegation.sh`, `tools/security/verify-production-exposure-evidence.sh`, `tools/security/report-production-exposure-status.sh`. Verification: firewall policy, DNS readiness/delegation, live evidence, and status report verified for hosts `" hosts "`; required public ports `" required_ports "` reachable; forbidden public ports `" forbidden_ports "` not publicly reachable; DNS resolvers `" resolvers "` returned production A/AAAA readiness; HTTPS and HSTS checks passed. Evidence: live `" evidence_file "`, firewall policy `" firewall_policy_file "`, DNS readiness `" dns_readiness_file "`, DNS delegation `" dns_delegation_file "`, status `" status_file "`."
      in_item = 0
      wrote_comment = 1
      next
    }

    { print }

    END {
      if (closed_item != 1 || wrote_comment != 1) {
        exit 2
      }
    }
  ' "$TODO_FILE" >"$tmp" || {
    rm -f "$tmp"
    printf '[production-exposure-todo-closeout] failed\n' >&2
    printf -- '- expected NB-P0-001 production exposure TODO item and Comment field were not found in %s\n' "$TODO_FILE" >&2
    exit 1
  }

mv "$tmp" "$TODO_FILE"
printf '[production-exposure-todo-closeout] ok\n'
