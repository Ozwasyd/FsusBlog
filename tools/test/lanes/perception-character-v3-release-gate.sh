#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

"${FSUSBLOG_NODE:-node}" tools/security/run-perception-character-v3-release-gate.mjs
