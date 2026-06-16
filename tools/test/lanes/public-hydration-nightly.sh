#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"

cd "$CLIENT_DIR"
"${FSUSBLOG_NODE:-node}" ../../tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs --lane nightly-full
