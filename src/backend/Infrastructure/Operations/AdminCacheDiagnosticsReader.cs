using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Distribution;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Operations;

public interface IAdminCacheDiagnosticsReader
{
    Task<CacheDiagnosticsResponse> GetAsync(int? articleId, CancellationToken cancellationToken);

    SearchIndexDiagnosticsResponse GetSearchIndexDiagnostics();
}

internal sealed class AdminCacheDiagnosticsReader(
    ISqlSugarClient db,
    IWebHostEnvironment environment,
    PublicHotReadStore publicHotReadStore,
    PublicHotReadCounters publicHotReadCounters,
    PublicAotInvalidationTracker publicAotInvalidationTracker,
    CacheInvalidationRuntimeState cacheInvalidationRuntime,
    IHotStatsInvalidationCoalescer hotStatsInvalidation,
    BlogDistributionService distributionService,
    ICacheDiagnostics cache,
    ILogger<AdminCacheDiagnosticsReader> logger) : IAdminCacheDiagnosticsReader
{
    private const uint SearchManifestMagic = 0x4D495346;
    private const uint SearchManifestBinaryVersion = 1;

    public async Task<CacheDiagnosticsResponse> GetAsync(int? articleId, CancellationToken cancellationToken)
    {
        PublicHotReadRuntimeSnapshot publicHot = publicHotReadStore.CreateRuntimeSnapshot();
        PublicAotInvalidationRuntimeSnapshot invalidation = publicAotInvalidationTracker.Snapshot();
        SearchIndexDiagnosticsResponse search = GetSearchIndexDiagnostics();
        DistributionDiagnosticsResponse distribution = await GetDistributionDiagnosticsAsync(cancellationToken);
        ArticleCacheDiagnosisResponse? article = articleId is > 0
            ? await DiagnoseArticleCacheAsync(articleId.Value, cancellationToken)
            : null;
        IReadOnlyList<ArticleCachePolicyDiagnosticsResponse> articlePolicies =
            await BuildArticleCachePolicyDiagnosticsAsync(cancellationToken);

        AotDiagnosticsResponse aot = new(
            publicHot.LastBuildStatus == "failed" ? "degraded" : "ok",
            publicHot.Version,
            publicHot.LastBuildAt,
            publicHot.LastBuildStatus,
            publicHot.LastBuildReason,
            publicHot.LastError,
            invalidation.TrackedInvalidationKeys,
            invalidation.CurrentVersion,
            invalidation.TrackedInvalidationKeys);

        string status = aot.Status == "ok" && search.Status == "ok" && distribution.Status == "ok"
            ? "ok"
            : "degraded";
        return new CacheDiagnosticsResponse(
            status,
            DateTimeOffset.UtcNow,
            aot,
            search,
            distribution,
            await cacheInvalidationRuntime.SnapshotAsync(cancellationToken),
            await hotStatsInvalidation.SnapshotAsync(cancellationToken),
            new OutputCacheDiagnosticsResponse(
                "ok",
                Enabled: true,
                Tags: Enum.GetNames<CacheTag>(),
                Detail: "ASP.NET OutputCache + IHttpCacheInvalidator tag eviction"),
            articlePolicies,
            publicHotReadCounters.Snapshot(),
            article);
    }

    public SearchIndexDiagnosticsResponse GetSearchIndexDiagnostics()
    {
        string root = ResolveWebRoot();
        string manifestPath = Path.Combine(root, "search", "index.manifest.aeds");
        if (!File.Exists(manifestPath))
        {
            return new SearchIndexDiagnosticsResponse("missing", null, null, 0, 0, false, manifestPath, "manifest_missing");
        }

        try
        {
            using var stream = File.OpenRead(manifestPath);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            if (reader.ReadUInt32() != SearchManifestMagic || reader.ReadUInt32() != SearchManifestBinaryVersion)
            {
                return new SearchIndexDiagnosticsResponse(
                    "degraded",
                    null,
                    File.GetLastWriteTimeUtc(manifestPath),
                    0,
                    0,
                    true,
                    manifestPath,
                    "manifest_header_invalid");
            }

            int schemaVersion = reader.ReadInt32();
            DateTimeOffset generatedAt = new(new DateTime(reader.ReadInt64(), DateTimeKind.Utc));
            string version = ReadManifestString(reader);
            int shardCount = reader.ReadInt32();
            return new SearchIndexDiagnosticsResponse(
                "ok",
                version,
                generatedAt,
                schemaVersion,
                shardCount,
                true,
                manifestPath,
                null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new SearchIndexDiagnosticsResponse(
                "degraded",
                null,
                File.GetLastWriteTimeUtc(manifestPath),
                0,
                0,
                true,
                manifestPath,
                ex.GetType().Name);
        }
    }

    private async Task<IReadOnlyList<ArticleCachePolicyDiagnosticsResponse>> BuildArticleCachePolicyDiagnosticsAsync(
        CancellationToken cancellationToken)
    {
        CachePolicyId[] policyIds = ArticleCacheOwnershipCatalog.Policies.Keys
            .OrderBy(static policy => (int)policy)
            .ToArray();
        IReadOnlyList<CachePolicyStorageSnapshot> storage =
            await cache.GetPolicyStorageSnapshotsAsync(policyIds, cancellationToken);
        Dictionary<CachePolicyId, CachePolicyStorageSnapshot> storageByPolicy =
            storage.ToDictionary(static item => item.PolicyId);
        IReadOnlyList<CacheOperationRuntimeCounter> counters = FsusObservability.GetCacheOperationCounters();
        var result = new List<ArticleCachePolicyDiagnosticsResponse>(policyIds.Length);
        foreach (CachePolicyId policyId in policyIds)
        {
            ArticleCacheOwnership ownership = ArticleCacheOwnershipCatalog.Policies[policyId];
            storageByPolicy.TryGetValue(policyId, out CachePolicyStorageSnapshot? snapshot);
            string policyName = policyId.ToString();
            long hits = counters
                .Where(counter => string.Equals(counter.Policy, policyName, StringComparison.Ordinal)
                    && counter.Result.Contains("hit", StringComparison.OrdinalIgnoreCase))
                .Sum(static counter => counter.Count);
            long misses = counters
                .Where(counter => string.Equals(counter.Policy, policyName, StringComparison.Ordinal)
                    && counter.Result.Contains("miss", StringComparison.OrdinalIgnoreCase))
                .Sum(static counter => counter.Count);
            result.Add(new ArticleCachePolicyDiagnosticsResponse(
                policyId,
                policyName,
                ownership.Owner,
                ownership.Consumers,
                ownership.Writes,
                ownership.Invalidation,
                ownership.Retention,
                snapshot?.KeyCount ?? 0,
                snapshot?.Bytes ?? 0,
                hits,
                misses));
        }

        return result;
    }

    private async Task<DistributionDiagnosticsResponse> GetDistributionDiagnosticsAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            DistributionDiagnosticsCounts counts =
                await distributionService.GetDiagnosticsCountsAsync(cancellationToken);
            return new DistributionDiagnosticsResponse(
                "ok",
                counts.CheckedAt,
                counts.SitemapUrlCount,
                counts.FeedItemCount,
                counts.CheckedAt,
                counts.CheckedAt,
                null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "distribution diagnostics failed");
            return new DistributionDiagnosticsResponse(
                "degraded",
                DateTimeOffset.UtcNow,
                0,
                0,
                null,
                null,
                ex.GetType().Name);
        }
    }

    private async Task<ArticleCacheDiagnosisResponse> DiagnoseArticleCacheAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        Article? article = await db.Queryable<Article>().FirstAsync(item => item.Id == articleId, cancellationToken);
        if (article is null)
        {
            return new ArticleCacheDiagnosisResponse(articleId, false, false, false, false, false, "article_not_found");
        }

        bool publicVisible = ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow);
        bool frameReady = publicHotReadStore.Current.TryGetArticle(articleId, out _);
        string routeKey = PublicRouteIdentity.BuildArticleRouteKey(articleId);
        bool htmlReady = publicHotReadStore.Current.TryGetHtml(PublicHotReadRouteKeys.HtmlPath(routeKey), out _);
        return new ArticleCacheDiagnosisResponse(
            articleId,
            publicVisible,
            frameReady,
            htmlReady,
            publicVisible,
            publicVisible,
            publicVisible
                ? "published article should appear in search/sitemap and public hot read after rebuild"
                : "article is not public; search/sitemap/public cache should exclude it");
    }

    private static string ReadManifestString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > 4096)
        {
            throw new InvalidDataException("manifest_string_length_invalid");
        }

        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw new EndOfStreamException();
        }

        return Encoding.UTF8.GetString(bytes);
    }

    private string ResolveWebRoot()
        => string.IsNullOrWhiteSpace(environment.WebRootPath)
            ? Path.Combine(AppContext.BaseDirectory, "wwwroot")
            : environment.WebRootPath;
}
