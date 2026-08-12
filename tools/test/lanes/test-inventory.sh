#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

npm --prefix "$ROOT_DIR/tools/test-inventory/ts-ast-adapter" \
    ci \
    --ignore-scripts \
    --no-audit \
    --progress=false

exec node "$ROOT_DIR/tools/test-inventory/produce.mjs"
