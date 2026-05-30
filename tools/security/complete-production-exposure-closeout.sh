#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
DNS_READINESS_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"
DNS_DELEGATION_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"
REQUEST_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST:-$ROOT_DIR/.tmp/security/production-exposure-evidence-request.json}"
TODO_FILE="${FSUSBLOG_TODO_FILE:-$ROOT_DIR/TODO.md}"
STATUS_REPORTED=0
closeout_failures=()

export FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$EVIDENCE_FILE"
export FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$FIREWALL_POLICY_FILE"
export FSUSBLOG_DNS_READINESS_EVIDENCE="$DNS_READINESS_FILE"
export FSUSBLOG_DNS_DELEGATION_EVIDENCE="$DNS_DELEGATION_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$STATUS_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$REQUEST_FILE"
export FSUSBLOG_TODO_FILE="$TODO_FILE"

run_status_report() {
  set +e
  "$ROOT_DIR/tools/security/report-production-exposure-status.sh"
  local status=$?
  set -e
  STATUS_REPORTED=1
  return "$status"
}

write_failure_status() {
  local exit_code=$?
  if (( exit_code != 0 && STATUS_REPORTED == 0 )); then
    run_status_report >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}

trap write_failure_status EXIT

run_closeout_step() {
  local label="$1"
  shift

  if ! "$@"; then
    closeout_failures+=("$label")
  fi
}

if [[ -z "${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-}" ]]; then
  FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS="$("$ROOT_DIR/tools/security/collect-production-hosts.sh" | paste -sd ' ' -)"
  export FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS
fi

"$ROOT_DIR/tools/security/check-production-exposure-prereqs.sh"

run_closeout_step evidence-request "$ROOT_DIR/tools/security/write-production-exposure-evidence-request.sh" "$REQUEST_FILE"

if [[ "${FSUSBLOG_SKIP_PRODUCTION_NETWORK_BASELINE:-0}" != "1" ]]; then
  run_closeout_step network-baseline "$ROOT_DIR/tools/security/check-production-network-baseline.sh"
fi

if [[ -n "${FSUSBLOG_CLOUD_FIREWALL_SOURCE:-}" ]]; then
  run_closeout_step firewall-policy-normalizer "$ROOT_DIR/tools/security/normalize-cloud-firewall-policy-evidence.sh" "$FSUSBLOG_CLOUD_FIREWALL_SOURCE"
elif [[ "${FSUSBLOG_COLLECT_HOST_FIREWALL_POLICY:-0}" == "1" || -n "${FSUSBLOG_UFW_STATUS_FILE:-}" ]]; then
  run_closeout_step host-firewall-policy-collector "$ROOT_DIR/tools/security/collect-host-firewall-policy-evidence.sh"
fi

if [[ "${FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE:-0}" != "1" && "${FSUSBLOG_SKIP_PRODUCTION_DNS_DELEGATION:-0}" != "1" ]]; then
  run_closeout_step dns-delegation "$ROOT_DIR/tools/security/check-production-dns-delegation.sh"
fi

run_closeout_step firewall-policy "$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh" "$FIREWALL_POLICY_FILE"

if [[ "${FSUSBLOG_USE_EXISTING_PRODUCTION_EXPOSURE_EVIDENCE:-0}" != "1" ]]; then
  if [[ "${FSUSBLOG_SKIP_PRODUCTION_DNS_READINESS:-0}" != "1" ]]; then
    run_closeout_step dns-readiness "$ROOT_DIR/tools/security/check-production-dns-readiness.sh"
  fi
  run_closeout_step live-exposure "$ROOT_DIR/tools/security/check-production-exposure-live.sh"
fi

run_closeout_step live-evidence-verifier "$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh" "$EVIDENCE_FILE"
if ! run_status_report; then
  closeout_failures+=(production-exposure-status)
fi

run_closeout_step evidence-request-final "$ROOT_DIR/tools/security/write-production-exposure-evidence-request.sh" "$REQUEST_FILE"

if (( ${#closeout_failures[@]} > 0 )); then
  printf '[production-exposure-complete-closeout] failed\n' >&2
  for failure in "${closeout_failures[@]}"; do
    printf -- '- %s failed\n' "$failure" >&2
  done
  exit 1
fi

"$ROOT_DIR/tools/security/close-production-exposure-todo.sh" "$EVIDENCE_FILE"

if rg -n '^\- \[ \]' "$TODO_FILE" >/dev/null; then
  printf '[production-exposure-complete-closeout] failed\n' >&2
  printf -- '- TODO.md still contains unchecked items after production exposure closeout\n' >&2
  rg -n '^\- \[ \]' "$TODO_FILE" >&2
  exit 1
fi

printf '[production-exposure-complete-closeout] ok\n'
