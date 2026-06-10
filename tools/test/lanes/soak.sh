#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${FSUSBLOG_SOAK_MODE:-short}"
OUT_DIR="$ROOT_DIR/.tmp/soak/$MODE"
mkdir -p "$OUT_DIR"

case "$MODE" in
  short|72h|7d) ;;
  *) printf '[soak] unsupported FSUSBLOG_SOAK_MODE=%s\n' "$MODE" >&2; exit 1 ;;
esac

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" soak "$MODE" "$OUT_DIR/summary.json"

printf '[soak] wrote %s\n' "$OUT_DIR/summary.json"
