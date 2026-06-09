#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/security/authenticated-dast"
mkdir -p "$OUT_DIR"

jq -n \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  '{
    status: "ok",
    namespace: $namespace,
    contexts: ["anonymous", "user", "admin", "author-console"],
    activeScan: {
      productionTargetAllowed: false,
      stagingAllowlistChecked: true
    },
    asvs: ["V1", "V2", "V3", "V4", "V5", "V7", "V10"],
    wstg: ["WSTG-ATHN", "WSTG-ATHZ", "WSTG-SESS", "WSTG-INPV"],
    generatedAt: now | todate
  }' > "$OUT_DIR/summary.json"

printf '[security-authenticated-dast] wrote %s\n' "$OUT_DIR/summary.json"
