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

AggregateSummary() {
    local generatedAt
    generatedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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

    "${FSUSBLOG_NODE:-node}" - "$generatedAt" "$SUMMARY_FILE" "${BACKEND_QPS_MODES[@]}" -- "${files[@]}" <<'NODE'
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
    AggregateSummary
    exit 0
fi

if [[ "$MODE" == "backend-qps-runtime-sequential" || "$MODE" == "runtime-sequential" ]]; then
    artifact="$OUT_DIR/runtime-sequential.json"
    "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" backend-qps-sequential "$artifact"
    cp "$artifact" "$RUNTIME_SEQUENTIAL_SUMMARY_FILE"
    printf '[backend-qps:%s] wrote %s and %s\n' "$MODE" "$artifact" "$RUNTIME_SEQUENTIAL_SUMMARY_FILE"
    exit 0
fi

RequireToken() {
    local file="$1"
    local token="$2"
    if ! grep -Fq "$token" "$ROOT_DIR/$file"; then
        echo "[backend-qps:$MODE] missing token in $file: $token" >&2
        exit 1
    fi
}

RejectToken() {
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
        RequireToken "src/core/Services/Gateways/IArticleCoreGateway.cs" "IncreaseViewCountsAsync("
        RequireToken "src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs" "core.IncreaseViewCountsAsync"
        RejectToken "src/backend/Infrastructure/CoreBridge/Adapters/ArticleServiceCoreAdapter.cs" "for (int i = 0; i < count; i++)"
        RequireToken "src/backend/Services/ArticleService.cs" "FROM (VALUES"
        RequireToken "src/backend/Services/ArticleService.cs" "IBatch redisBatch = _redis.CreateBatch()"
        ;;
    visitlog-invalidation)
        route="visit-log:hot-stats-invalidation"
        traffic_mode="cache-invalidation-pressure"
        checks=(dirty-coalescer versioned-hot-cache no-empty-hot-prefix-delete diagnostics-snapshot)
        RequireToken "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "GetRequiredService<IHotStatsInvalidationCoalescer>()"
        RequireToken "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "MarkStatsDirtyAsync(\"read-aggregate-flush\""
        RequireToken "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "MarkHotArticlesDirtyAsync(\"article-read-projection\""
        RejectToken "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "InvalidateStatsAsync(token)"
        RejectToken "src/backend/Services/VisitLog/VisitLogProcessorService.cs" "InvalidateHotArticlesAsync(token)"
        RequireToken "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "s_hotArticlesDebounce"
        RequireToken "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "s_statsDebounce"
        RequireToken "src/backend/Infrastructure/Cache/HotStatsInvalidationCoalescer.cs" "FlushPendingAsync"
        RequireToken "src/backend/Services/ArticleEndpointService.cs" "BuildVersionedHotArticlesIdentity"
        RequireToken "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "BuildVersionedHotArticlesIdentity"
        RequireToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "PublishNextHotArticlesVersion"
        RejectToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveByPrefixAsync(CachePolicyId.ArticleHot, string.Empty"
        RejectToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveByPrefixAsync(CachePolicyId.ArticleHotFrame, string.Empty"
        RequireToken "src/backend/Models/Dtos/OperationsDtos.cs" "HotStatsInvalidationSnapshot"
        ;;
    cache-hit)
        checks=(full-frame-cache article-list-frame article-hot-frame comment-frame taxonomy-frame stats-frame)
        RequireToken "src/backend/Infrastructure/Cache/CachePolicyId.cs" "ArticleListFrame"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "BinaryResults.PreencodedFrame"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CommentCursorFrame"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs" "CategoryFrame"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Stats.cs" "AdminStatsFrame"
        ;;
    comment-cursor)
        route="/api/binary/comment/{articleId}"
        checks=(comment-thread-frame-cache comment-reply-frame-cache user-comment-frame-cache versioned-invalidation)
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "BuildCommentThreadFrameIdentity"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "WriteCommentReplyCursor"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CachePolicyId.CommentCursorFrame"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs" "CachePolicyId.UserCommentCursorFrame"
        RequireToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.CommentCursorVersion"
        RequireToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.UserCommentCursorVersion"
        RejectToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.CommentCursorFrame"
        RejectToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.UserCommentCursorFrame"
        ;;
    hotread)
        route="/api/binary/category"
        traffic_mode="early-hot-read"
        checks=(single-classification-feature dedicated-rate-risk-pow-gate generic-pipeline-bypass taxonomy-suffixless-fastpath preencoded-bodywriter)
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs" "PublicHotReadRequestFeature"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadEarlyDataPlane.cs" "UseFsusPublicHotReadRateLimiter"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs" "PublicReadSecurityGate"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSecurityGateMiddleware.cs" "PublicReadSecurityGateResultFeature.Allowed"
        RequireToken "src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs" "public-hot-read-classifier"
        RequireToken "src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs" "public-hot-read-fallback-restore"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs" "CategoryPathWithoutSuffix"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs" "TagPathWithoutSuffix"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs" "BodyWriter.WriteAsync(frame"
        ;;
    cache-miss-singleflight)
        traffic_mode="db-miss"
        checks=(detail-singleflight search-singleflight hot-singleflight featured-singleflight)
        RequireToken "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleDetail"
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "_cacheMissCoordinator.CoordinateAsync("
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "CachePolicyId.ArticleSearch"
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "\"article-search\""
        RequireToken "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.ArticleHot"
        RequireToken "src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs" "AcquireSingleFlightAsync(CachePolicyId.TopArticles"
        ;;
    risk-filter)
        route="public_read:risk-filter"
        checks=(zero-risk-microcache no-public-read-lowercase stable-partition-key)
        RequireToken "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "ZeroRiskCacheTtlSeconds"
        RequireToken "src/backend/Infrastructure/Security/CrawlerRiskService.cs" "zeroRiskCache"
        RequireToken "src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs" "GetPublicReadPartitionPath"
        ;;
    related-reading)
        route="/api/binary/article/{articleId}/related.aeds"
        checks=(versioned-related-cache output-cache-tag)
        RequireToken "src/backend/Services/Distribution/RelatedReadingService.cs" "GetArticleListVersionAsync"
        RequireToken "src/backend/Services/Distribution/RelatedReadingService.cs" "CachePolicyId.RelatedReading"
        RequireToken "src/backend/Services/Distribution/RelatedReadingService.cs" "CachePolicyId.ArticleListVersion"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "AedsFrameType.ArticleRelatedReading"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "CacheTag.ArticleList.ToOutputCacheTag()"
        ;;
    list-pagination)
        route="/api/binary/article/list/home/{page}/{size}.aeds"
        traffic_mode="db-miss"
        checks=(keyset-small-pages offset-deep-pages)
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "ShouldUsePublicKeysetPagination(isDeleted, status, includePrivate)"
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "LoadPublicArticleListPageByKeysetAsync"
        RequireToken "src/backend/Services/ArticleService.cs" "ArticleListCursorWhereClause"
        RequireToken "src/backend/Services/ArticleService.LifecycleAndReadModels.cs" "OFFSET @Offset"
        ;;
    article-detail-miss)
        route="/api/binary/article/{id}.aeds"
        traffic_mode="db-miss"
        checks=(public-detail-artifact prepared-primary-key-projection sequential-binary-read classified-db-gate async-backfill preencoded-frame)
        RequireToken "src/backend/Services/ArticleEndpointService.cs" "GetPublicArtifactBackedDetailAsync"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "WHERE article_id = \$1"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "PrepareAsync"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "CommandBehavior.SequentialAccess | CommandBehavior.SingleRow"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs" "DbWorkloadClass.PublicShortRead"
        RequireToken "src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs" "ArticleDetailAedsArtifactBackfillWorker"
        RequireToken "src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs" "PreencodedFrame"
        ;;
    cache-registry)
        route="cache:registry"
        checks=(policy-register-flag exact-cache-no-registry prefix-cache-registry)
        RequireToken "src/backend/Infrastructure/Cache/CachePolicy.cs" "RegisterKeysForPrefixInvalidation"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "RegisterKeysForPrefixInvalidation"
        RequireToken "src/backend/Infrastructure/Cache/CachePolicyRegistry.cs" "ArticleListFrame"
        RequireToken "src/backend/Infrastructure/Cache/CachePolicyRegistry.cs" "CommentCursorFrame"
        ;;
    cache-invalidation-batch)
        route="cache:invalidation-batch"
        traffic_mode="cache-mutation"
        checks=(remove-many remove-prefix-many registry-setremove-batch prefix-policy-group dispatcher-batch)
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "Task RemoveManyAsync"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "Task RemoveByPrefixManyAsync"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteKeysAndRegistryMembersAtomicAsync"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "ScriptEvaluateAsync"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteKeysAndRegistryMembersScript"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "prefixes.GroupBy(static item => item.PolicyId)"
        RequireToken "src/backend/Infrastructure/Cache/IUnifiedCache.cs" "DeleteRegisteredKeysByPrefixesAsync(registryKey, resolvedPrefixes"
        RequireToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "RemoveManyAsync"
        RequireToken "src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs" "CachePolicyId.AdminStatsFrame"
        RequireToken "src/backend/Infrastructure/Observability/FsusObservability.cs" "fsus.cache.remove_many.keys"
        RequireToken "src/backend/Infrastructure/Observability/FsusObservability.cs" "fsus.cache.remove_prefix_many.registry_scans"
        ;;
    index-plan)
        route="db:index-plan"
        traffic_mode="db-miss"
        checks=(article-public-index comment-index tag-index public-article-projection-plan)
        RequireToken "src/backend/Entities/Article.cs" "idx_article_public_status_time"
        RequireToken "src/backend/Entities/Article.cs" "idx_article_public_category_status_time"
        RequireToken "src/backend/Entities/Comment.cs" "article_id"
        RequireToken "src/backend/Entities/Article.cs" "idx_article_tag_article_tag"
        RequireToken "src/backend/Entities/Article.cs" "idx_article_tag_tag_article"
        RequireToken "tools/perf/public-article-projection-plan.sql" "EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)"
        RequireToken "tools/perf/public-article-projection-plan.sql" "FROM public_article_projection"
        ;;
    *)
        echo "[backend-qps] unknown mode: $MODE" >&2
        exit 2
        ;;
esac

artifact="$OUT_DIR/$MODE.json"
checks_csv="$(
    IFS=,
    echo "${checks[*]}"
)"
generatedAt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/lanes/runtime-evidence-probe.mjs" backend-qps "$MODE" "$artifact"
checks_json="$(printf '%s\n' "${checks[@]}" | jq -R . | jq -s .)"
tmp_artifact="$artifact.tmp"
jq \
    --arg route "$route" \
    --arg mode "$traffic_mode" \
    --arg generatedAt "$generatedAt" \
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
    "$artifact" >"$tmp_artifact"
mv "$tmp_artifact" "$artifact"

echo "[backend-qps:$MODE] wrote $artifact"
