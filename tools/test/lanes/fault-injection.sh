#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/.tmp/fault-injection"
mkdir -p "$OUT_DIR"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" fault-injection "$OUT_DIR"

printf '[fault-injection] wrote %s\n' "$OUT_DIR/summary.json"
