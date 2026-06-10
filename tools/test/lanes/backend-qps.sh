#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
OUT_DIR="$ROOT_DIR/.tmp/perf/backend-qps"
SUMMARY_FILE="$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json"

if [[ -z "$MODE" ]]; then
  echo "usage: backend-qps.sh <mode>" >&2
  exit 2
fi

mkdir -p "$OUT_DIR" "$(dirname "$SUMMARY_FILE")"

require_token() {
  local file="$1"
  local token="$2"
  if ! grep -Fq "$token" "$ROOT_DIR/$file"; then
    echo "[backend-qps:$MODE] missing token in $file: $token" >&2
    exit 1
  fi
}

reject_token() {
  local file="$1"
  local token="$2"
  if grep -Fq "$token" "$ROOT_DIR/$file"; then
    echo "[backend-qps:$MODE] forbidden token in $file: $token" >&2
    exit 1
  fi
}

route="/api/binary/article/list/home/1/10.aeds"
traffic_mode="static-qps-guard"
checks=()

case "$MODE" in
  view-count-flush)
    route="visit-log:view-count-flush"
    checks=(batch-core-gateway batch-adapter-no-single-loop batch-db-values-update)
    require_token "src/core/Services/Gateways/IArticleCoreGateway.cs" "IncreaseViewCountsAsync("
    require_token "src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs" "core.IncreaseViewCountsAsync"
    reject_token "src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs" "for (int i = 0; i < count; i++)"
    require_token "src/backend/Services/ArticleService.cs" "FROM (VALUES"
    require_token "src/backend/Services/ArticleService.cs" "IBatch redisBatch = _redis.CreateBatch()"
    ;;
  cache-hit)
    checks=(full-frame-cache article-list-frame article-hot-frame comment-frame taxonomy-frame stats-frame)
    require_token "src/backend/Infrastructure/Cache/CachePolicyId.cs" "ArticleListFrame"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "BinaryResults.PreencodedFrame"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CommentCursorFrame"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs" "CategoryFrame"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Stats.cs" "AdminStatsFrame"
    ;;
  comment-cursor)
    route="/api/binary/comment/{articleId}"
    checks=(comment-thread-frame-cache comment-reply-frame-cache user-comment-frame-cache invalidation-prefix)
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "BuildCommentThreadFrameIdentity"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "EncodeCommentReplyCursor"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CommentCursorFrame"
    ;;
  hotread)
    route="/api/binary/category"
    traffic_mode="hot-read"
    checks=(taxonomy-suffixless-fastpath preencoded-bodywriter)
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "CategoryPathWithoutSuffix"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "TagPathWithoutSuffix"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "BodyWriter.WriteAsync(frame"
    ;;
  cache-miss-singleflight)
    traffic_mode="db-miss"
    checks=(detail-singleflight search-singleflight hot-singleflight featured-singleflight)
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleDetail"
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleSearch"
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleHot"
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.TopArticles"
    ;;
  risk-filter)
    route="public_read:risk-filter"
    checks=(zero-risk-microcache no-public-read-lowercase stable-partition-key)
    require_token "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "ZeroRiskTtl"
    require_token "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "zeroRiskCache"
    require_token "src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs" "GetPublicReadPartitionPath"
    ;;
  related-reading)
    route="/api/public/articles/{articleId}/related"
    checks=(versioned-related-cache output-cache-tag)
    require_token "src/backend/Services/Distribution/RelatedReadingService.cs" "related-reading:"
    require_token "src/backend/Services/Distribution/RelatedReadingService.cs" "ArticleListVersion"
    require_token "src/backend/Modules/Endpoints/DistributionEndpoints.cs" ".CacheOutput(static builder => builder"
    ;;
  list-pagination)
    route="/api/binary/article/list/home/{page}/{size}.aeds"
    traffic_mode="db-miss"
    checks=(keyset-small-pages offset-deep-pages)
    require_token "src/backend/Services/ArticleService.cs" "PublicKeysetWalkPageThreshold"
    require_token "src/backend/Services/ArticleService.cs" "page <= PublicKeysetWalkPageThreshold"
    require_token "src/backend/Services/ArticleService.cs" "OFFSET @Offset"
    ;;
  article-detail-miss)
    route="/api/binary/article/{id}.aeds"
    traffic_mode="db-miss"
    checks=(public-detail-artifact async-backfill preencoded-frame)
    require_token "src/backend/Services/ArticleEndpointService.cs" "GetPublicArtifactBackedDetailAsync"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs" "ArticleDetailAedsArtifactBackfillWorker"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "PreencodedFrame"
    ;;
  cache-registry)
    route="cache:registry"
    checks=(policy-register-flag exact-cache-no-registry prefix-cache-registry)
    require_token "src/backend/Infrastructure/Cache/CachePolicy.cs" "RegisterKeysForPrefixInvalidation"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "RegisterKeysForPrefixInvalidation"
    require_token "src/backend/Infrastructure/Cache/CachePolicyRegistry.cs" "ArticleListFrame"
    require_token "src/backend/Infrastructure/Cache/CachePolicyRegistry.cs" "CommentCursorFrame"
    ;;
  index-plan)
    route="db:index-plan"
    traffic_mode="db-miss"
    checks=(article-public-index comment-index tag-index)
    require_token "src/backend/Entities/Article.cs" "idx_article_public_status_time"
    require_token "src/backend/Entities/Article.cs" "idx_article_public_category_status_time"
    require_token "src/backend/Entities/Comment.cs" "article_id"
    require_token "src/backend/Entities/Article.cs" "idx_article_tag_article_tag"
    require_token "src/backend/Entities/Article.cs" "idx_article_tag_tag_article"
    ;;
  *)
    echo "[backend-qps] unknown mode: $MODE" >&2
    exit 2
    ;;
esac

artifact="$OUT_DIR/$MODE.json"
checks_csv="$(IFS=,; echo "${checks[*]}")"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
commit_sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

jq -n \
  --arg status "ok" \
  --arg route "$route" \
  --arg mode "$traffic_mode" \
  --arg scenario "$MODE" \
  --arg generatedAt "$generated_at" \
  --arg commitSha "$commit_sha" \
  --arg checks "$checks_csv" \
  --arg artifact ".tmp/perf/backend-qps/$MODE.json" \
  '{
    status: $status,
    scenario: $scenario,
    route: $route,
    mode: $mode,
    generatedAt: $generatedAt,
    commitSha: $commitSha,
    evidenceType: "static-qps-implementation-guard",
    checks: ($checks | split(",") | map(select(length > 0))),
    artifact: $artifact,
    rps: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    allocBytesPerRequest: 0,
    dbCommandsPerRequest: 0,
    redisCommandsPerRequest: 0,
    cacheHitRatio: 0,
    aedsCrcComputesPerRequest: 0,
    threadPoolAvailableWorkerThreads: 0,
    dbGateWaiting: 0
  }' > "$artifact"

jq -s \
  --arg generatedAt "$generated_at" \
  '{
    status: (if any(.[]; .status != "ok") then "blocked" else "ok" end),
    generatedAt: $generatedAt,
    artifactDir: ".tmp/perf/backend-qps",
    results: .
  }' "$OUT_DIR"/*.json > "$SUMMARY_FILE"

echo "[backend-qps:$MODE] wrote $artifact"
