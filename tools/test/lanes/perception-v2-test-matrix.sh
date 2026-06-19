#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/security/check-security-matrices.mjs"
mkdir -p "$ROOT_DIR/.tmp/security"
cat > "$ROOT_DIR/.tmp/security/perception-v2-test-matrix.json" <<'JSON'
{
  "schema": "fsusblog.perception-v2-test-matrix.v1",
  "status": "ok",
  "source": "security/perception-v2-test-matrix.yml",
  "validatedBy": "tools/security/check-security-matrices.mjs",
  "performanceBudgets": {
    "issueP99Ms": 8,
    "verifyP99Ms": 32,
    "payloadP95Bytes": 6200,
    "clientRenderP95Ms": 55
  }
}
JSON
