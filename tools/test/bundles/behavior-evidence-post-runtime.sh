#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

exec "$NODE_BIN" "$ROOT_DIR/tools/test-matrix/behavior-evidence-post-runtime.mjs" \
  --pre-runtime "${FSUSBLOG_BEHAVIOR_PRE_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-pre-runtime/receipt.json}" \
  --catalog "$ROOT_DIR/config/contracts/behavior-contracts.json" \
  --browser-contract "${FSUSBLOG_BROWSER_CONTRACT_RECEIPT:-$ROOT_DIR/.tmp/browser-contract/receipt.json}" \
  --runtime "${FSUSBLOG_CORRECTNESS_RECEIPT:-$ROOT_DIR/.tmp/release-evidence/browserless-correctness-receipt.json}" \
  --out "${FSUSBLOG_BEHAVIOR_POST_RUNTIME_RECEIPT:-$ROOT_DIR/.tmp/behavior-evidence-post-runtime/receipt.json}" \
  --release-final-spawn-count "${FSUSBLOG_RELEASE_FINAL_SPAWN_COUNT:-0}"
