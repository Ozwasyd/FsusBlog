#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/generate-endpoint-depth-matrix.mjs"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/contracts/run-endpoint-depth-runtime.mjs"
