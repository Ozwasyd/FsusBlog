#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/coverage/write-changed-code-coverage.mjs"
