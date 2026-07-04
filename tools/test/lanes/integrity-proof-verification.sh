#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

exec "$NODE_BIN" "$ROOT_DIR/tools/integrity/verify-proof-fixtures.mjs" "$@"
