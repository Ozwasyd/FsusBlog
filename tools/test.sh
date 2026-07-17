#!/usr/bin/env bash
set -euo pipefail

export FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS="${FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS:-$(date +%s%3N)}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${FSUSBLOG_NODE:-node}"
export FSUSBLOG_REPO_ROOT="${FSUSBLOG_REPO_ROOT:-$ROOT_DIR}"

if [[ $# -eq 0 || "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" help
  exit 0
fi

tier="$1"
shift || true

case "$tier" in
  production-correctness|browser-contract|browser-diagnostics|release-final)
    exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" run "$tier" "$@"
    ;;
  ci-fast|ci-production|ci-release-final|ci-job|ci-tier)
    exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" "$tier" "$@"
    ;;
  ci-plan)
    exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" ci-plan --format github-actions "$@"
    ;;
esac

exec "$NODE_BIN" "$ROOT_DIR/tools/run-test-matrix.mjs" run "$tier" "$@"
