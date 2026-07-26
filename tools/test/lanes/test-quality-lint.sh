#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/ci/check-test-quality.mjs"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/write-release-domain-assertion-report.mjs" --producer test-quality-lint
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/produce-release-domain-receipt.mjs" --producer test-quality-lint
