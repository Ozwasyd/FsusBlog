#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
NowEpochMs() {
    "$NODE_BIN" -e 'process.stdout.write(String(Date.now()))'
}
export FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS="${FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS:-$(NowEpochMs)}"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
    "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" help
    exit 0
fi

tier="$1"
shift || true

# Contract: tools/test.sh dispatches one named matrix tier through the canonical Node runner.
# Input: The first argument is a tier; remaining arguments are forwarded without reinterpretation.
# Output: Standard output and artifacts belong to the selected matrix tier.
# Failure: Missing or rejected tiers return the canonical runner's nonzero status.
case "$tier" in
    production-correctness | browser-contract | browser-diagnostics | release-final)
        exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" run "$tier" "$@"
        ;;
    ci-fast | ci-production | ci-release-final | ci-job | ci-tier)
        exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" "$tier" "$@"
        ;;
    ci-plan)
        exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" ci-plan --format github-actions "$@"
        ;;
esac

exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" run "$tier" "$@"
