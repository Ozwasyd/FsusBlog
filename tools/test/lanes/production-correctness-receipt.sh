#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
OUTPUT_FILE="$ROOT_DIR/.tmp/release-evidence/browserless-correctness-receipt.json"

rm -f "$OUTPUT_FILE"
exec "$NODE_BIN" "$ROOT_DIR/tools/release/test-evidence-receipts-cli.mjs" create-correctness \
    --out "$OUTPUT_FILE"
