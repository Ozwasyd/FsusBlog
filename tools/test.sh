#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" help
  exit 0
fi

tier="$1"
shift || true

exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" run "$tier" "$@"
