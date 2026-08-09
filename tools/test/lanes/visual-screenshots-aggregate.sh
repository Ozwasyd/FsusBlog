#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Explicit run-bound locator roots (issue #1677). The lane binds the current
# run's roots; production-fresh orchestrators override them via env.
export FSUSBLOG_UX_OUTPUT_ROOT="${FSUSBLOG_UX_OUTPUT_ROOT:-$ROOT_DIR/.tmp/visual}"
export FSUSBLOG_RELEASE_EVIDENCE_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence}"

node "$ROOT_DIR/tools/visual/aggregate-screenshot-evidence.mjs"
