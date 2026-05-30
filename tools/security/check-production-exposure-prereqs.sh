#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

failures=()
required_commands=(awk bash curl date dig find getent grep jq mktemp paste rg sed sha256sum sort tar timeout xargs)
required_scripts=(
  tools/security/check-production-exposure-prereqs.sh
  tools/security/collect-production-hosts.sh
  tools/security/write-production-exposure-evidence-request.sh
  tools/security/check-production-exposure-handoff.sh
  tools/security/check-production-exposure-handoff-bundle.sh
  tools/security/export-production-exposure-handoff-bundle.sh
  tools/security/collect-host-firewall-policy-evidence.sh
  tools/security/normalize-cloud-firewall-policy-evidence.sh
  tools/security/check-production-dns-delegation.sh
  tools/security/check-production-dns-readiness.sh
  tools/security/check-production-exposure-live.sh
  tools/security/report-production-exposure-status.sh
  tools/security/verify-production-firewall-policy-evidence.sh
  tools/security/verify-production-exposure-evidence.sh
  tools/security/verify-production-exposure-returned-evidence.sh
  tools/security/close-production-exposure-todo.sh
  tools/security/complete-production-exposure-closeout.sh
  tools/security/complete-production-exposure-from-returned-evidence.sh
  tools/security/complete-production-exposure-from-returned-handoff-bundle.sh
  tools/security/test-production-exposure-tools.sh
)

for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    failures+=("missing required command: $command_name")
  fi
done

for script in "${required_scripts[@]}"; do
  if [[ ! -f "$ROOT_DIR/$script" ]]; then
    failures+=("missing required script: $script")
  elif [[ ! -x "$ROOT_DIR/$script" ]]; then
    failures+=("required script is not executable: $script")
  fi
done

if (( ${#failures[@]} > 0 )); then
  printf '[production-exposure-prereqs] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-exposure-prereqs] ok\n'
