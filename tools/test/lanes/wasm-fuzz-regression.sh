#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
node "$ROOT_DIR/tests/frontend/checks/wasm/check-aeds-export-handle.mjs"
exec node "$ROOT_DIR/tools/security/run-wasm-fuzz.mjs"
