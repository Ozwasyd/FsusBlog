#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

WEBROOT="$TMP_ROOT/src/backend/wwwroot"
UPLOAD_ASSETS="$WEBROOT/uploads/illustration"
OUT_DIR="$TMP_ROOT/.tmp/operations"
mkdir -p \
  "$UPLOAD_ASSETS" \
  "$OUT_DIR" \
  "$TMP_ROOT/.tmp/security" \
  "$TMP_ROOT/.tmp/release-evidence" \
  "$TMP_ROOT/artifacts/coverage" \
  "$TMP_ROOT/src/backend/.upload-sessions" \
  "$WEBROOT/aot-cache" \
  "$WEBROOT/search"

referenced_asset="$UPLOAD_ASSETS/referenced.webp"
stale_asset="$UPLOAD_ASSETS/stale.webp"
printf 'referenced\n' > "$referenced_asset"
printf 'stale\n' > "$stale_asset"
touch -d '7 days ago' "$referenced_asset" "$stale_asset"

references="$TMP_ROOT/referenced-assets.json"
printf '{ "referencedAssets": ["/uploads/illustration/referenced.webp"] }\n' > "$references"

FSUSBLOG_RETENTION_DRY_RUN=0 \
FSUSBLOG_RETENTION_OUTPUT_DIR="$OUT_DIR" \
FSUSBLOG_RETENTION_SECURITY_DIR="$TMP_ROOT/.tmp/security" \
FSUSBLOG_RETENTION_RELEASE_EVIDENCE_DIR="$TMP_ROOT/.tmp/release-evidence" \
FSUSBLOG_RETENTION_COVERAGE_DIR="$TMP_ROOT/artifacts/coverage" \
FSUSBLOG_RETENTION_UPLOAD_SESSION_DIR="$TMP_ROOT/src/backend/.upload-sessions" \
FSUSBLOG_RETENTION_WEBROOT_DIR="$WEBROOT" \
FSUSBLOG_RETENTION_AOT_CACHE_DIR="$WEBROOT/aot-cache" \
FSUSBLOG_RETENTION_SEARCH_DIR="$WEBROOT/search" \
FSUSBLOG_RETENTION_UPLOAD_ASSET_DIR="$UPLOAD_ASSETS" \
FSUSBLOG_RETENTION_SCAN_UPLOAD_ASSETS=1 \
FSUSBLOG_RETENTION_REFERENCED_ASSETS="$references" \
FSUSBLOG_RETENTION_UPLOAD_ASSET_DAYS=1 \
  "$ROOT_DIR/tools/operations/cleanup-retention.sh"

[[ -f "$referenced_asset" ]] || {
  echo "[retention-cleanup-fixture] referenced asset was deleted" >&2
  exit 1
}

[[ ! -e "$stale_asset" ]] || {
  echo "[retention-cleanup-fixture] unreferenced stale asset was not deleted" >&2
  exit 1
}

jq -e '
  .assetGuard.scanEnabled == true
  and .assetGuard.referenceMode == "configured"
  and .assetGuard.candidateAssets == 2
  and .assetGuard.protectedReferencedAssets == 1
  and .assetGuard.deletedUnreferencedAssets == 1
' "$OUT_DIR/retention-cleanup.json" >/dev/null

echo "[retention-cleanup-fixture] ok"
