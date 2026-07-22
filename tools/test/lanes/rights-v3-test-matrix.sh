#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/project-rights-v3-evidence.mjs"
