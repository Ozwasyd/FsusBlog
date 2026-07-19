#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"
NODE_BIN="${NODE_BIN:-node}"

FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild
exec "$NODE_BIN" "$ROOT_DIR/tools/integrity/verify-proof-fixtures.mjs" "$@"
