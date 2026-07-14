#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-}"
OUT_DIR="${FSUSBLOG_BACKEND_QPS_OUT_DIR:-$ROOT_DIR/.tmp/perf/backend-qps}"
SUMMARY_FILE="${FSUSBLOG_BACKEND_QPS_SUMMARY_FILE:-$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json}"
RUNTIME_SEQUENTIAL_SUMMARY_FILE="${FSUSBLOG_BACKEND_QPS_RUNTIME_SEQUENTIAL_SUMMARY_FILE:-$ROOT_DIR/.tmp/release-evidence/backend-qps-runtime-sequential-summary.json}"
BACKEND_QPS_MODES=(
  view-count-flush
  visitlog-invalidation
  cache-hit
  comment-cursor
  hotread
  cache-miss-singleflight
  risk-filter
  related-reading
  list-pagination
  article-detail-miss
  cache-registry
  cache-invalidation-batch
  index-plan
)

if [[ -z "$MODE" ]]; then
  echo "usage: backend-qps.sh <mode>" >&2
  exit 2
fi

mkdir -p "$OUT_DIR" "$(dirname "$SUMMARY_FILE")" "$(dirname "$RUNTIME_SEQUENTIAL_SUMMARY_FILE")"

aggregate_summary() {
  local generated_at
  generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local files=()
  local missing=()

  for mode in "${BACKEND_QPS_MODES[@]}"; do
    local file="$OUT_DIR/$mode.json"
    if [[ -f "$file" ]]; then
      files+=("$file")
    else
      missing+=("$mode")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    printf '[backend-qps:aggregate] missing collector artifact(s): %s\n' "${missing[*]}" >&2
    exit 1
  fi

  "${FSUSBLOG_NODE:-node}" - "$generated_at" "$SUMMARY_FILE" "${BACKEND_QPS_MODES[@]}" -- "${files[@]}" <<'NODE'
const fs = require('node:fs')

const [, , generatedAt, summaryFile, ...args] = process.argv
const splitIndex = args.indexOf('--')
if (splitIndex < 0) {
  throw new Error('missing backend-qps aggregate argument separator')
}

const expectedModes = args.slice(0, splitIndex)
const files = args.slice(splitIndex + 1)
const results = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')))
const summary = {
  status: results.some((item) => item.status !== 'ok') ? 'blocked' : 'ok',
  generatedAt,
  performance_baseline: results.find((item) => item.performance_baseline != null)?.performance_baseline ?? null,
  optional_deployment_layer: results.find((item) => item.optional_deployment_layer != null)?.optional_deployment_layer ?? null,
  artifactDir: '.tmp/perf/backend-qps',
  expectedModes,
  resultCount: results.length,
  evidenceModel: 'static-implementation-plus-runtime-measurement',
  staticEvidenceResults: results.map((item) => item.staticEvidence ?? null),
  runtimeMeasurementResults: results.map((item) => item.runtimeMeasurement ?? null),
  capacityConclusion: {
    countedAsCapacity: false,
    reason: 'backend-qps summary separates static implementation evidence from runtime probes; capacity conclusions come from load or benchmark lanes'
  },
  results
}

fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
NODE

  printf '[backend-qps:aggregate] wrote %s\n' "$SUMMARY_FILE"
}

if [[ "$MODE" == "aggregate" ]]; then
  aggregate_summary
  exit 0
fi

if [[ "$MODE" == "backend-qps-runtime-sequential" || "$MODE" == "runtime-sequential" ]]; then
  artifact="$OUT_DIR/runtime-sequential.json"
  "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" backend-qps-sequential "$artifact"
  cp "$artifact" "$RUNTIME_SEQUENTIAL_SUMMARY_FILE"
  printf '[backend-qps:%s] wrote %s and %s\n' "$MODE" "$artifact" "$RUNTIME_SEQUENTIAL_SUMMARY_FILE"
  exit 0
fi

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
  visitlog-invalidation)
    route="visit-log:hot-stats-invalidation"
    traffic_mode="cache-invalidation-pressure"
    checks=(dirty-coalescer versioned-hot-cache no-empty-hot-prefix-delete diagnostics-snapshot)
    require_token "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "GetRequiredService<IHotStatsInvalidationCoalescer>()"
    require_token "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "MarkStatsDirtyAsync(\"visit-log-flush\""
    require_token "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "MarkHotArticlesDirtyAsync(\"article-read-projection\""
    reject_token "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "InvalidateStatsAsync(token)"
    reject_token "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "InvalidateHotArticlesAsync(token)"
    require_token "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "HotArticlesDebounce"
    require_token "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "StatsDebounce"
    require_token "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "FlushPendingAsync"
    require_token "src/backend/Services/ArticleEndpointService.cs" "BuildVersionedHotArticlesIdentity"
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "BuildVersionedHotArticlesIdentity"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "PublishNextHotArticlesVersion"
    reject_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveByPrefixAsync(CachePolicyId.ArticleHot, string.Empty"
    reject_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveByPrefixAsync(CachePolicyId.ArticleHotFrame, string.Empty"
    require_token "src/backend/Models/Dtos/OperationsDtos.cs" "HotStatsInvalidationSnapshot"
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
    checks=(comment-thread-frame-cache comment-reply-frame-cache user-comment-frame-cache versioned-invalidation)
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "BuildCommentThreadFrameIdentity"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "WriteCommentReplyCursor"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CachePolicyId.CommentCursorFrame"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CachePolicyId.UserCommentCursorFrame"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.CommentCursorVersion"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.UserCommentCursorVersion"
    reject_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.CommentCursorFrame"
    reject_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.UserCommentCursorFrame"
    ;;
  hotread)
    route="/api/binary/category"
    traffic_mode="early-hot-read"
    checks=(single-classification-feature dedicated-rate-risk-pow-gate generic-pipeline-bypass taxonomy-suffixless-fastpath preencoded-bodywriter)
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs" "PublicHotReadRequestFeature"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs" "UseFsusPublicHotReadRateLimiter"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs" "PublicReadSecurityGate"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs" "PublicReadSecurityGateResultFeature.Allowed"
    require_token "src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs" "public-hot-read-classifier"
    require_token "src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs" "public-hot-read-fallback-restore"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "CategoryPathWithoutSuffix"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "TagPathWithoutSuffix"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs" "BodyWriter.WriteAsync(frame"
    ;;
  cache-miss-singleflight)
    traffic_mode="db-miss"
    checks=(detail-singleflight search-singleflight hot-singleflight featured-singleflight)
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleDetail"
    require_token "src/backend/Services/ArticleService.cs" "_cacheMissCoordinator.CoordinateAsync("
    require_token "src/backend/Services/ArticleService.cs" "CachePolicyId.ArticleSearch"
    require_token "src/backend/Services/ArticleService.cs" "\"article-search\""
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleHot"
    require_token "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.TopArticles"
    ;;
  risk-filter)
    route="public_read:risk-filter"
    checks=(zero-risk-microcache no-public-read-lowercase stable-partition-key)
    require_token "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "ZeroRiskCacheTtlSeconds"
    require_token "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "zeroRiskCache"
    require_token "src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs" "GetPublicReadPartitionPath"
    ;;
  related-reading)
    route="/api/binary/article/{articleId}/related.aeds"
    checks=(versioned-related-cache output-cache-tag)
    require_token "src/backend/Services/Distribution/RelatedReadingService.cs" "GetArticleListVersionAsync"
    require_token "src/backend/Services/Distribution/RelatedReadingService.cs" "CachePolicyId.RelatedReading"
    require_token "src/backend/Services/Distribution/RelatedReadingService.cs" "CachePolicyId.ArticleListVersion"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "AedsFrameType.ArticleRelatedReading"
    require_token "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "CacheTag.ArticleList.ToOutputCacheTag()"
    ;;
  list-pagination)
    route="/api/binary/article/list/home/{page}/{size}.aeds"
    traffic_mode="db-miss"
    checks=(keyset-small-pages offset-deep-pages)
    require_token "src/backend/Services/ArticleService.cs" "ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate)"
    require_token "src/backend/Services/ArticleService.cs" "LoadPublicArticleListPageByKeysetAsync"
    require_token "src/backend/Services/ArticleService.cs" "ArticleListCursorWhereClause"
    require_token "src/backend/Services/ArticleService.cs" "OFFSET @Offset"
    ;;
  article-detail-miss)
    route="/api/binary/article/{id}.aeds"
    traffic_mode="db-miss"
    checks=(public-detail-artifact prepared-primary-key-projection sequential-binary-read classified-db-gate async-backfill preencoded-frame)
    require_token "src/backend/Services/ArticleEndpointService.cs" "GetPublicArtifactBackedDetailAsync"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "WHERE article_id = \$1"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "PrepareAsync"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "CommandBehavior.SequentialAccess | CommandBehavior.SingleRow"
    require_token "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "DbWorkloadClass.PublicShortRead"
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
  cache-invalidation-batch)
    route="cache:invalidation-batch"
    traffic_mode="cache-mutation"
    checks=(remove-many remove-prefix-many registry-setremove-batch prefix-policy-group dispatcher-batch)
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "Task RemoveManyAsync"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "Task RemoveByPrefixManyAsync"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteKeysAndRegistryMembersAtomicAsync"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "ScriptEvaluateAsync"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteKeysAndRegistryMembersScript"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "prefixes.GroupBy(static item => item.PolicyId)"
    require_token "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteRegisteredKeysByPrefixesAsync(registryKey, resolvedPrefixes"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveManyAsync"
    require_token "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.AdminStatsFrame"
    require_token "src/backend/Infrastructure/Observability/FsusObservability.cs" "fsus.cache.remove_many.keys"
    require_token "src/backend/Infrastructure/Observability/FsusObservability.cs" "fsus.cache.remove_prefix_many.registry_scans"
    ;;
  index-plan)
    route="db:index-plan"
    traffic_mode="db-miss"
    checks=(article-public-index comment-index tag-index public-article-projection-plan)
    require_token "src/backend/Entities/Article.cs" "idx_article_public_status_time"
    require_token "src/backend/Entities/Article.cs" "idx_article_public_category_status_time"
    require_token "src/backend/Entities/Comment.cs" "article_id"
    require_token "src/backend/Entities/Article.cs" "idx_article_tag_article_tag"
    require_token "src/backend/Entities/Article.cs" "idx_article_tag_tag_article"
    require_token "tools/perf/public-article-projection-plan.sql" "EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)"
    require_token "tools/perf/public-article-projection-plan.sql" "FROM public_article_projection"
    ;;
  *)
    echo "[backend-qps] unknown mode: $MODE" >&2
    exit 2
    ;;
esac

artifact="$OUT_DIR/$MODE.json"
checks_csv="$(IFS=,; echo "${checks[*]}")"
generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" backend-qps "$MODE" "$artifact"
checks_json="$(printf '%s\n' "${checks[@]}" | jq -R . | jq -s .)"
tmp_artifact="$artifact.tmp"
jq \
  --arg route "$route" \
  --arg mode "$traffic_mode" \
  --arg generatedAt "$generated_at" \
  --arg checksCsv "$checks_csv" \
  --argjson checks "$checks_json" \
  '.route = $route
    | .mode = $mode
    | .generatedAt = $generatedAt
    | .checks = $checks
    | .staticEvidence.checks = $checks
    | .runtimeMeasurement.requestPlan.route = $route
    | .runtimeMeasurement.requestPlan.trafficMode = $mode
    | .staticImplementationChecks = ($checksCsv | split(",") | map(select(length > 0)))' \
  "$artifact" > "$tmp_artifact"
mv "$tmp_artifact" "$artifact"

echo "[backend-qps:$MODE] wrote $artifact"
