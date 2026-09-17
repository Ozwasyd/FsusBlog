#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
npm --prefix "$ROOT_DIR/src/frontend" run check:security:matrices
SECURITY_OUTPUT_ROOT="${FSUSBLOG_SECURITY_OUTPUT_ROOT:-$ROOT_DIR/.tmp/security}"
mkdir -p "$SECURITY_OUTPUT_ROOT"
cat >"$SECURITY_OUTPUT_ROOT/risk-control-test-matrix.json" <<'JSON'
{
  "schema": "fsusblog.risk-control-test-matrix.v1",
  "status": "ok",
  "source": "security/matrices/risk-control.yml",
  "validatedBy": "tools/security/check-security-matrices.mjs"
}
JSON
