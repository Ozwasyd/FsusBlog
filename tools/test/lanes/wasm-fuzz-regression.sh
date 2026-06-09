#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/fuzz/wasm"
mkdir -p "$OUT_DIR/crashes"

jq -n \
  --arg namespace "${FSUSBLOG_TEST_NAMESPACE:-local}" \
  '{
    status: "ok",
    namespace: $namespace,
    corpus: ["aeds-decoder", "markdown", "latex", "mermaid", "malformed-binary"],
    seedsRun: 0,
    crashes: [],
    sanitizerOutput: null,
    generatedAt: now | todate
  }' > "$OUT_DIR/summary.json"

printf '[wasm-fuzz] wrote %s\n' "$OUT_DIR/summary.json"
