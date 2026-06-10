#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"

jq -n \
  --arg tier "$TIER" \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  '{
    status: "ok",
    tier: $tier,
    namespace: $namespace,
    strategy: "namespace-discard",
    generatedAt: now | todate
  }' > "$OUT_DIR/cleanup.json"

printf '[data-scale:cleanup] wrote %s\n' "$OUT_DIR/cleanup.json"
