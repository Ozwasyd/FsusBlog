#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[cache-governance] checking direct redis cache operations"
DIRECT_REDIS_MATCHES="$(
  rg -n "StringSetAsync\(|StringGetAsync\(|KeyDeleteAsync\(|GetDatabase\(\)" \
    "$ROOT_DIR/src/backend" \
    --glob '!**/bin/**' \
    --glob '!**/obj/**' | \
  grep -vE "Infrastructure/Cache/|Infrastructure/PublicAot/|Infrastructure/SSE/|Infrastructure/Operations/|Infrastructure/CoreBridge/Cache/|Services/ArticleService.cs|Services/SSE/SseMessageService.cs|Services/Security/RedisPowService.cs|Services/Security/MfaChallengeService.cs|Infrastructure/Security/AdaptivePowGovernor.cs" || true
)"

if [[ -n "$DIRECT_REDIS_MATCHES" ]]; then
  echo "[cache-governance] forbidden direct redis usages found:"
  echo "$DIRECT_REDIS_MATCHES"
  exit 1
fi

echo "[cache-governance] checking hard-coded output cache tags"
TAG_MATCHES="$(
  rg -n "EvictByTagAsync\(\"|\.Tag\(\"" \
    "$ROOT_DIR/src/backend" \
    --glob '!**/bin/**' \
    --glob '!**/obj/**' | \
  grep -vE "Infrastructure/Cache/CacheTag.cs|Infrastructure/Cache/HttpCachePolicyCatalog.cs" || true
)"

if [[ -n "$TAG_MATCHES" ]]; then
  echo "[cache-governance] hard-coded cache tag usages found:"
  echo "$TAG_MATCHES"
  exit 1
fi

echo "[cache-governance] checking machine-readable cache catalog"
node "$ROOT_DIR/tools/cache/export-cache-governance.mjs" --check

echo "[cache-governance] ok"
