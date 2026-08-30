#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
RELEASE_EVIDENCE_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"
OUTPUT_FILE="$RELEASE_EVIDENCE_DIR/browserless-correctness-receipt.json"

rm -f "$OUTPUT_FILE"
"$ROOT_DIR/tools/test/lanes/runtime-observation-probes.sh"
exec "$NODE_BIN" "$ROOT_DIR/tools/release/test-evidence-receipts-cli.mjs" create-correctness \
    --out "$OUTPUT_FILE"
