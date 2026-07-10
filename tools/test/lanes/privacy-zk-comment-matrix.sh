#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export FSUSBLOG_RUN_PERFORMANCE_TESTS=1
node "$ROOT_DIR/tools/verify-zk-privacy-matrix.mjs"
node "$ROOT_DIR/tools/crypto/check-zk-comment-v2-manifests.mjs"
npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk
npm --prefix "$ROOT_DIR/src/frontend" run check:privacy-zk-prod-smoke
mkdir -p "$ROOT_DIR/.tmp/security"
cat > "$ROOT_DIR/.tmp/security/privacy-zk-comment-matrix.json" <<'JSON'
{
  "schema": "fsusblog.privacy-zk-comment-matrix.v1",
  "status": "ok",
  "source": "security/privacy-zk-comment-matrix.yml",
  "validatedBy": "npm --prefix src/frontend run check:privacy-zk && npm --prefix src/frontend run check:privacy-zk-prod-smoke"
}
JSON
