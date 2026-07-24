#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"

exec "$NODE_BIN" "$ROOT_DIR/tools/test/run-backend-qps-scenarios.mjs" "$@"
