#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-security-matrices.mjs"
mkdir -p "$ROOT_DIR/.tmp/security"
cat > "$ROOT_DIR/.tmp/security/risk-control-test-matrix.json" <<'JSON'
{
  "schema": "fsusblog.risk-control-test-matrix.v1",
  "status": "ok",
  "source": "security/matrices/risk-control.yml",
  "validatedBy": "tools/security/check-security-matrices.mjs"
}
JSON
