#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIER="${1:-scale-xs}"
OUT_DIR="$ROOT_DIR/.tmp/scale/$TIER"
mkdir -p "$OUT_DIR"

export FSUSBLOG_DATA_SCALE_ARTIFACT_EVIDENCE="$OUT_DIR/artifact-rebuild.json"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" data-scale "$TIER" "$OUT_DIR/summary.json"
printf '[data-scale:probe] wrote %s\n' "$OUT_DIR/summary.json"
printf '[data-scale:probe] updated %s\n' "$OUT_DIR/artifact-rebuild.json"
