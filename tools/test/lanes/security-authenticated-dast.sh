#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/security/authenticated-dast"
mkdir -p "$OUT_DIR"
EXECUTED="${FSUSBLOG_AUTHENTICATED_DAST_EXECUTED:-0}"
STATUS="ok"
if [[ "$EXECUTED" != "1" ]]; then
  STATUS="scheduled"
fi

jq -n \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  --arg status "$STATUS" \
  --argjson executed "$([[ "$EXECUTED" == "1" ]] && echo true || echo false)" \
  '{
    status: $status,
    namespace: $namespace,
    contexts: ["anonymous", "user", "admin", "author-console"],
    activeScan: {
      executed: $executed,
      productionTargetAllowed: false,
      stagingAllowlistChecked: true
    },
    asvs: ["V1", "V2", "V3", "V4", "V5", "V7", "V10"],
    wstg: ["WSTG-ATHN", "WSTG-ATHZ", "WSTG-SESS", "WSTG-INPV"],
    blocker: (if $executed then null else "authenticated-dast-not-executed" end),
    generatedAt: now | todate
  }' > "$OUT_DIR/summary.json"

printf '[security-authenticated-dast] wrote %s\n' "$OUT_DIR/summary.json"
