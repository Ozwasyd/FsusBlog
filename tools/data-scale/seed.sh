#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"

case "$TIER" in
  scale-xs) articles=1; comments=0 ;;
  scale-s) articles=100; comments=1000 ;;
  scale-m) articles=10000; comments=100000 ;;
  scale-l-nightly) articles=100000; comments=1000000 ;;
  *) printf '[data-scale:seed] unknown tier %s\n' "$TIER" >&2; exit 1 ;;
esac

jq -n \
  --arg tier "$TIER" \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  --argjson articles "$articles" \
  --argjson comments "$comments" \
  '{
    status: "ok",
    tier: $tier,
    namespace: $namespace,
    declared: { articles: $articles, comments: $comments },
    strategy: "bootstrap-namespace-runtime-fixture",
    generatedAt: now | todate
  }' > "$OUT_DIR/seed.json"

printf '[data-scale:seed] wrote %s\n' "$OUT_DIR/seed.json"
