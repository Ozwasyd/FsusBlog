#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLIENT_DIR="$ROOT_DIR/src/frontend"
SUMMARY_FILE="${FSUSBLOG_PUBLIC_HYDRATION_MATRIX_SUMMARY_FILE:-$ROOT_DIR/.tmp/release-evidence/public-hydration-matrix-nightly-full-summary.json}"

cd "$CLIENT_DIR"
FSUSBLOG_PUBLIC_HYDRATION_MATRIX_SUMMARY_FILE="$SUMMARY_FILE" \
    "${FSUSBLOG_NODE:-node}" ../../tests/frontend/checks/public/check-public-hydration-matrix-governance.mjs --lane nightly-full
