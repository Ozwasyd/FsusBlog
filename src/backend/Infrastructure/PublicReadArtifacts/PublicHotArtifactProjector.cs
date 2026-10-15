using System.Buffers;
using System.Collections.Frozen;
using System.Data.Common;
using System.Diagnostics;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Options;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public interface IPublicHotArtifactProjector
{
    Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct);

    Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct);

    Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
        PublicHotReadSnapshot current,
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct);
}

public interface IVersionedPublicHotArtifactProjector
{
    Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        long? expectedReleaseId,
        CancellationToken ct);
}

public interface IPublicHotTaxonomyProjector
{
    Task<PublicHotReadSnapshot> RebuildAfterTaxonomyMutationAsync(
        PublicHotReadSnapshot current,
        CancellationToken ct);
}

internal sealed record PublicArticleFrameSelection(
    IReadOnlyList<int> ArticleIds,
    int PublicArticleCount,
    int ArticleFrameLimit);

internal sealed record PublicHotDeltaScope(
    IReadOnlyList<int> CategoryIds,
    IReadOnlyList<int> TagIds,
    bool RebuildHotFrames,
    bool RebuildFeaturedFrames);

public sealed class PublicHotArtifactProjector(
    ISqlSugarClient db,
    IAedsEncoder aeds,
    IDbConcurrencyGate dbConcurrencyGate,
    IOptions<PublicHotReadOptions> options,
    ArticleBodyRepairQueue articleBodyRepairQueue,
    IArticleListCursorCodec articleListCursorCodec,
    TimeProvider timeProvider,
    ILogger<PublicHotArtifactProjector> logger,
    IArticleDetailViewProjection? articleDetailViews = null,
    ICacheStringReader? cacheStringReader = null)
    : IPublicHotArtifactProjector, IVersionedPublicHotArtifactProjector, IPublicHotTaxonomyProjector
{
    private const int MaxPageSize = 100;
    private const int MaxHotArticlesCount = 100;
    public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct)
        => RebuildAfterArticleMutationAsync(current, articleId, null, ct);

    public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        long? expectedReleaseId,
        CancellationToken ct)
    {
        if (articleId <= 0)
        {
            return BuildSnapshotAsync(current.HtmlArtifacts, ct);
        }

        return dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-delta",
            gateCt => BuildDeltaSnapshotCoreAsync(current, articleId, expectedReleaseId, gateCt),
            _ => Task.FromException<PublicHotReadSnapshot>(
                new TimeoutException("db-gate-timeout:public-hot-read-delta")),
            ct);
    }

    public Task<PublicHotReadSnapshot> RebuildAfterViewProjectionAsync(
        PublicHotReadSnapshot current,
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct)
    {
        return dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-view-delta",
            gateCt => BuildViewProjectionSnapshotCoreAsync(current, articleIds, gateCt),
            _ => Task.FromException<PublicHotReadSnapshot>(
                new TimeoutException("db-gate-timeout:public-hot-read-view-delta")),
            ct);
    }

    public Task<PublicHotReadSnapshot> RebuildAfterTaxonomyMutationAsync(
        PublicHotReadSnapshot current,
        CancellationToken ct)
        => dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-taxonomy-delta",
            gateCt => BuildTaxonomySnapshotCoreAsync(current, gateCt),
            _ => Task.FromException<PublicHotReadSnapshot>(
                new TimeoutException("db-gate-timeout:public-hot-read-taxonomy-delta")),
            ct);

    public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct)
        => BuildSnapshotAsync([], ct);

    private Task<PublicHotReadSnapshot> BuildSnapshotAsync(
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml,
        CancellationToken ct)
        => dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-rebuild",
            gateCt => BuildSnapshotCoreAsync(existingHtml, gateCt),
            _ => Task.FromException<PublicHotReadSnapshot>(
                new TimeoutException("db-gate-timeout:public-hot-read-rebuild")),
            ct);

    private async Task<PublicHotReadSnapshot> BuildSnapshotCoreAsync(
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml,
        CancellationToken ct)
    {
        PublicHotReadOptions value = options.Value;
        DateTimeOffset projectionCutoff = timeProvider.GetUtcNow();
        DateTime utcNow = projectionCutoff.UtcDateTime;
        long version = projectionCutoff.ToUnixTimeMilliseconds();
        PublicArticleFrameSelection selection = await QueryPublicArticleIdsAsync(utcNow, value, ct).ConfigureAwait(false);
        FrozenDictionary<int, PublicBinaryArtifact> articleFrames = await BuildArticleFramesAsync(selection.ArticleIds, utcNow, version, value, ct).ConfigureAwait(false);
        FrozenDictionary<PublicListKey, PublicBinaryArtifact> listFrames = await BuildListFramesAsync(utcNow, version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact categoryFrame = await BuildCategoryFrameAsync(version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact tagFrame = await BuildTagFrameAsync(version, value, ct).ConfigureAwait(false);
        FrozenDictionary<string, PublicHtmlArtifact> html = existingHtml.ToFrozenDictionary(StringComparer.Ordinal);

        return new PublicHotReadSnapshot(
            version,
            articleFrames,
            listFrames,
            categoryFrame,
            tagFrame,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(version, projectionCutoff),
            selection.PublicArticleCount,
            selection.ArticleFrameLimit);
    }

    private async Task<PublicHotReadSnapshot> BuildDeltaSnapshotCoreAsync(
        PublicHotReadSnapshot current,
        int articleId,
        long? expectedReleaseId,
        CancellationToken ct)
    {
        long started = Stopwatch.GetTimestamp();
        PublicHotReadOptions value = options.Value;
        DateTimeOffset projectionCutoff = timeProvider.GetUtcNow();
        DateTime visibilityCutoff = projectionCutoff.UtcDateTime;
        long version = projectionCutoff.ToUnixTimeMilliseconds();
        var articleFrames = current.ArticleArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        var listFrames = current.ListArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        IReadOnlyList<ArticleDetailReadModel> changedArticles = await LoadArticleDetailsFromDbAsync(
            [articleId],
            ct,
            expectedReleaseId).ConfigureAwait(false);
        if (ArticleMutationProjectionVersionPolicy.PreserveCurrentWhenCoordinateDoesNotResolve(
            expectedReleaseId,
            changedArticles.Count > 0))
        {
            logger.LogInformation(
                "public-hot-read-version-skipped {ArticleId} {ExpectedReleaseId}",
                articleId,
                expectedReleaseId.GetValueOrDefault());
            return current;
        }
        ArticleDetailReadModel? changed = changedArticles.FirstOrDefault(article =>
            article.Id > 0 && IsPubliclyVisible(article, visibilityCutoff));
        PublicHotDeltaScope scope;
        if (changed is null)
        {
            articleFrames.Remove(articleId);
            scope = await LoadArticleDeltaScopeAsync(articleId, ct).ConfigureAwait(false);
        }
        else
        {
            ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(changed);
            articleFrames[changed.Id] = EncodeFrame(AedsFrameType.ArticleDetail, writer => PodBinaryCodec.WriteArticleDetail(core, writer), version, value);
            scope = BuildArticleDeltaScope(changed);
        }
        articleFrames = ApplyArticleAdmission(articleFrames, [articleId], value);

        int rebuiltListFrames = await AddAffectedListFramesAsync(listFrames, scope, version, value, ct).ConfigureAwait(false);
        int rebuiltTaxonomyFrames = 0;
        FrozenDictionary<string, PublicHtmlArtifact> html = current.HtmlArtifacts.ToFrozenDictionary(StringComparer.Ordinal);
        FsusObservability.RecordPublicHotDelta(
            changedArticles: 1,
            rebuiltListFrames,
            rebuiltTaxonomyFrames,
            FsusObservability.GetElapsed(started));
        logger.LogInformation(
            "public-hot-read-delta {ArticleId} {ListFrames} {CategoryCount} {TagCount} {ElapsedMs}",
            articleId,
            rebuiltListFrames,
            scope.CategoryIds.Count,
            scope.TagIds.Count,
            FsusObservability.GetElapsed(started).TotalMilliseconds);

        return new PublicHotReadSnapshot(
            version,
            articleFrames.ToFrozenDictionary(),
            listFrames.ToFrozenDictionary(),
            current.CategoryFrame,
            current.TagFrame,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(version, projectionCutoff),
            current.PublicArticleCount,
            current.ArticleFrameLimit);
    }

    private async Task<PublicHotReadSnapshot> BuildViewProjectionSnapshotCoreAsync(
        PublicHotReadSnapshot current,
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct)
    {
        long started = Stopwatch.GetTimestamp();
        PublicHotReadOptions value = options.Value;
        DateTimeOffset projectionCutoff = timeProvider.GetUtcNow();
        DateTime visibilityCutoff = projectionCutoff.UtcDateTime;
        long version = projectionCutoff.ToUnixTimeMilliseconds();
        int[] normalizedArticleIds = NormalizeIds(articleIds);
        var articleFrames = current.ArticleArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        if (normalizedArticleIds.Length > 0)
        {
            IReadOnlyList<ArticleDetailReadModel> changedArticles = await LoadArticleDetailsFromDbAsync(normalizedArticleIds, ct).ConfigureAwait(false);
            var changedArticleIds = new HashSet<int>();
            foreach (ArticleDetailReadModel changed in changedArticles)
            {
                if (!IsPubliclyVisible(changed, visibilityCutoff))
                {
                    continue;
                }

                articleDetailViews?.ApplyAuthoritative(changed.Id, changed.Views, changed.Views);
                changedArticleIds.Add(changed.Id);
                ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(changed);
                articleFrames[changed.Id] = EncodeFrame(AedsFrameType.ArticleDetail, writer => PodBinaryCodec.WriteArticleDetail(core, writer), version, value);
            }

            foreach (int articleId in normalizedArticleIds)
            {
                if (!changedArticleIds.Contains(articleId))
                {
                    articleFrames.Remove(articleId);
                }
            }
        }
        articleFrames = ApplyArticleAdmission(articleFrames, normalizedArticleIds, value);

        var listFrames = current.ListArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        int rebuiltListFrames = await AddHotRankingFramesAsync(listFrames, version, value, ct).ConfigureAwait(false);
        FrozenDictionary<string, PublicHtmlArtifact> html = current.HtmlArtifacts.ToFrozenDictionary(StringComparer.Ordinal);
        FsusObservability.RecordPublicHotDelta(
            normalizedArticleIds.Length,
            rebuiltListFrames,
            rebuiltTaxonomyFrames: 0,
            FsusObservability.GetElapsed(started));
        logger.LogInformation(
            "public-hot-read-view-delta {ArticleCount} {ListFrames} {ElapsedMs}",
            normalizedArticleIds.Length,
            rebuiltListFrames,
            FsusObservability.GetElapsed(started).TotalMilliseconds);

        return new PublicHotReadSnapshot(
            version,
            articleFrames.ToFrozenDictionary(),
            listFrames.ToFrozenDictionary(),
            current.CategoryFrame,
            current.TagFrame,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(version, projectionCutoff),
            current.PublicArticleCount,
            current.ArticleFrameLimit);
    }

    private async Task<PublicHotReadSnapshot> BuildTaxonomySnapshotCoreAsync(
        PublicHotReadSnapshot current,
        CancellationToken ct)
    {
        long started = Stopwatch.GetTimestamp();
        PublicHotReadOptions value = options.Value;
        DateTimeOffset projectionCutoff = timeProvider.GetUtcNow();
        long version = projectionCutoff.ToUnixTimeMilliseconds();
        var listFrames = current.ListArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        IReadOnlyList<int> categoryIds = await db.Queryable<Category>()
            .Select(category => category.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        IReadOnlyList<int> tagIds = await db.Queryable<Tag>()
            .Select(tag => tag.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        PublicHotDeltaScope scope = new(
            NormalizeIds(categoryIds),
            NormalizeIds(tagIds),
            RebuildHotFrames: true,
            RebuildFeaturedFrames: true);
        int rebuiltListFrames = await AddAffectedListFramesAsync(listFrames, scope, version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact categoryFrame = await BuildCategoryFrameAsync(version, value, ct).ConfigureAwait(false);
        PublicBinaryArtifact tagFrame = await BuildTagFrameAsync(version, value, ct).ConfigureAwait(false);
        FrozenDictionary<string, PublicHtmlArtifact> html = current.HtmlArtifacts.ToFrozenDictionary(StringComparer.Ordinal);
        FsusObservability.RecordPublicHotDelta(
            changedArticles: 0,
            rebuiltListFrames,
            rebuiltTaxonomyFrames: 2,
            FsusObservability.GetElapsed(started));
        return new PublicHotReadSnapshot(
            version,
            current.ArticleArtifacts.ToFrozenDictionary(),
            listFrames.ToFrozenDictionary(),
            categoryFrame,
            tagFrame,
            html,
            PublicHotReadPublicationEvidence.CreateVerified(version, projectionCutoff),
            current.PublicArticleCount,
            current.ArticleFrameLimit);
    }

    private static PublicHotDeltaScope BuildArticleDeltaScope(ArticleDetailReadModel article)
        => new(
            NormalizeIds([article.CategoryId]),
            NormalizeIds(article.Tags.Select(static tag => tag.Id)),
            RebuildHotFrames: true,
            RebuildFeaturedFrames: true);

    private async Task<PublicHotDeltaScope> LoadArticleDeltaScopeAsync(int articleId, CancellationToken ct)
    {
        if (articleId <= 0)
        {
            return new PublicHotDeltaScope([], [], RebuildHotFrames: true, RebuildFeaturedFrames: true);
        }

        var articleRows = await db.Queryable<Article>()
            .Where(article => article.Id == articleId)
            .Select(article => new { article.CategoryId })
            .ToListAsync(ct)
            .ConfigureAwait(false);
        IReadOnlyDictionary<int, List<TagReadModel>> tagMap = await LoadArticleTagMapAsync([articleId], ct).ConfigureAwait(false);
        IEnumerable<int> tagIds = tagMap.TryGetValue(articleId, out List<TagReadModel>? tags)
            ? tags.Select(static tag => tag.Id)
            : [];

        return new PublicHotDeltaScope(
            NormalizeIds(articleRows.Select(static article => article.CategoryId)),
            NormalizeIds(tagIds),
            RebuildHotFrames: true,
            RebuildFeaturedFrames: true);
    }

    private async Task<int> AddAffectedListFramesAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        PublicHotDeltaScope scope,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        int rebuilt = 0;
        int[] pages = [1];
        int[] sizes = NormalizePositive(options.PreloadSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        long queryVersion = await ReadArticleListQueryVersionAsync(ct).ConfigureAwait(false);
        await AddArticlePageFramesAsync(frames, PublicListKind.Home, 0, pages, sizes, null, null, version, queryVersion, options, ct).ConfigureAwait(false);
        rebuilt += pages.Length * sizes.Length;
        await AddArticlePageFramesAsync(frames, PublicListKind.Archive, 0, pages, sizes, null, null, version, queryVersion, options, ct).ConfigureAwait(false);
        rebuilt += pages.Length * sizes.Length;

        foreach (int categoryId in scope.CategoryIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Category, categoryId, pages, sizes, categoryId, null, version, queryVersion, options, ct).ConfigureAwait(false);
            rebuilt += pages.Length * sizes.Length;
        }

        foreach (int tagId in scope.TagIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Tag, tagId, pages, sizes, null, tagId, version, queryVersion, options, ct).ConfigureAwait(false);
            rebuilt += pages.Length * sizes.Length;
        }

        if (scope.RebuildHotFrames)
        {
            foreach (int size in hotSizes)
            {
                await AddHotFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
                rebuilt++;
            }
        }

        if (scope.RebuildFeaturedFrames)
        {
            foreach (int size in featuredSizes)
            {
                await AddFeaturedFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
                rebuilt++;
            }
        }

        return rebuilt;
    }

    private async Task<int> AddHotRankingFramesAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        int rebuilt = 0;
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        foreach (int size in hotSizes)
        {
            await AddHotFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
            rebuilt++;
        }

        foreach (int size in featuredSizes)
        {
            await AddFeaturedFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
            rebuilt++;
        }

        return rebuilt;
    }

    private async Task<PublicArticleFrameSelection> QueryPublicArticleIdsAsync(DateTime utcNow, PublicHotReadOptions options, CancellationToken ct)
    {
        int limit = Math.Clamp(options.MaxArticleFrames, 1, 1_000_000);
        ISugarQueryable<Article> publicArticles = db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow));
        int publicArticleCount = await publicArticles.CountAsync(ct).ConfigureAwait(false);
        int recentPercent = Math.Clamp(options.ArticleAdmissionRecentPercent, 0, 100);
        int recentLimit = Math.Clamp((int)Math.Ceiling(limit * (recentPercent / 100d)), 0, limit);
        int popularLimit = limit - recentLimit;
        List<int> recentIds = recentLimit == 0
            ? []
            : await publicArticles
            .OrderBy(article => article.PublishedAt, OrderByType.Desc)
            .OrderBy(article => article.Id, OrderByType.Desc)
            .Take(recentLimit)
            .Select(article => article.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        List<int> popularIds = popularLimit == 0
            ? []
            : await publicArticles
                .OrderBy(article => article.Views, OrderByType.Desc)
                .OrderBy(article => article.PublishedAt, OrderByType.Desc)
                .OrderBy(article => article.Id, OrderByType.Desc)
                .Take(popularLimit)
                .Select(article => article.Id)
                .ToListAsync(ct)
                .ConfigureAwait(false);
        int[] articleIds = MergeAdmissionSegments(popularIds, recentIds, limit);

        return new PublicArticleFrameSelection(articleIds, publicArticleCount, limit);
    }

    private async Task<FrozenDictionary<int, PublicBinaryArtifact>> BuildArticleFramesAsync(
        IReadOnlyList<int> articleIds,
        DateTime visibilityCutoff,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        if (articleIds.Count == 0)
        {
            return FrozenDictionary<int, PublicBinaryArtifact>.Empty;
        }

        IReadOnlyList<ArticleDetailReadModel> details = await LoadArticleDetailsFromDbAsync(articleIds, ct).ConfigureAwait(false);
        Dictionary<int, PublicBinaryArtifact> frames = MaterializeVisibilityCheckedArticleFrames(
            details,
            visibilityCutoff,
            version,
            options,
            aeds,
            ct);
        return ApplyArticleAdmission(frames, articleIds, options).ToFrozenDictionary();
    }

    internal static Dictionary<int, PublicBinaryArtifact> MaterializeVisibilityCheckedArticleFrames(
        IReadOnlyList<ArticleDetailReadModel> details,
        DateTime visibilityCutoff,
        long version,
        PublicHotReadOptions options,
        IAedsEncoder encoder,
        CancellationToken ct = default)
    {
        var frames = new Dictionary<int, PublicBinaryArtifact>(details.Count);
        foreach (ArticleDetailReadModel detail in details)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsPubliclyVisible(detail, visibilityCutoff))
            {
                continue;
            }

            ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(detail);
            frames[detail.Id] = PublicHotReadBinaryArtifactFactory.FromWriter(
                AedsFrameType.ArticleDetail,
                writer => PodBinaryCodec.WriteArticleDetail(core, writer),
                options.CacheControl,
                version,
                options);
        }

        return frames;
    }

    internal static bool IsPubliclyVisible(ArticleDetailReadModel article, DateTime utcNow)
        => ArticlePublication.IsPubliclyVisible(
            article.Status,
            article.IsDeleted,
            article.PublishedAt,
            article.ScheduledPublishAt,
            utcNow);

    internal static int[] MergeAdmissionSegments(
        IReadOnlyList<int> popularIds,
        IReadOnlyList<int> recentIds,
        int limit)
    {
        var result = new List<int>(Math.Max(0, limit));
        var seen = new HashSet<int>();
        int max = Math.Max(popularIds.Count, recentIds.Count);
        for (int index = 0; index < max && result.Count < limit; index++)
        {
            Add(popularIds, index);
            Add(recentIds, index);
        }
        return [.. result];

        void Add(IReadOnlyList<int> source, int index)
        {
            if (result.Count < limit && index < source.Count && source[index] > 0 && seen.Add(source[index]))
            {
                result.Add(source[index]);
            }
        }
    }

    internal static Dictionary<int, PublicBinaryArtifact> ApplyArticleAdmission(
        IReadOnlyDictionary<int, PublicBinaryArtifact> candidates,
        IEnumerable<int> priorityIds,
        PublicHotReadOptions options)
    {
        PublicHotReadBudgetLimits limits = PublicHotReadBudgetLimits.Resolve(options);
        int countLimit = Math.Clamp(options.MaxArticleFrames, 1, 1_000_000);
        long byteLimit = limits.MaxArticleResidentBytes;
        IEnumerable<int> orderedIds = priorityIds
            .Concat(candidates
                .OrderByDescending(static pair => pair.Value.Version)
                .ThenByDescending(static pair => pair.Key)
                .Select(static pair => pair.Key))
            .Distinct();
        var admitted = new Dictionary<int, PublicBinaryArtifact>(Math.Min(candidates.Count, countLimit));
        long residentBytes = 0;
        foreach (int id in orderedIds)
        {
            if (admitted.Count >= countLimit || !candidates.TryGetValue(id, out PublicBinaryArtifact artifact))
            {
                continue;
            }
            long artifactBytes = PublicHotReadResidentAccounting.EstimateArticleArtifactBytes(artifact);
            if (artifactBytes > byteLimit - residentBytes)
            {
                continue;
            }
            admitted[id] = artifact;
            residentBytes += artifactBytes;
        }
        return admitted;
    }

    private async Task<FrozenDictionary<PublicListKey, PublicBinaryArtifact>> BuildListFramesAsync(
        DateTime utcNow,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        var frames = new Dictionary<PublicListKey, PublicBinaryArtifact>();
        int[] pages = [1];
        int[] sizes = NormalizePositive(options.PreloadSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        long queryVersion = await ReadArticleListQueryVersionAsync(ct).ConfigureAwait(false);
        await AddArticlePageFramesAsync(frames, PublicListKind.Home, 0, pages, sizes, null, null, version, queryVersion, options, ct).ConfigureAwait(false);
        await AddArticlePageFramesAsync(frames, PublicListKind.Archive, 0, pages, sizes, null, null, version, queryVersion, options, ct).ConfigureAwait(false);

        List<int> categoryIds = await QueryPublicCategoryIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int categoryId in categoryIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Category, categoryId, pages, sizes, categoryId, null, version, queryVersion, options, ct).ConfigureAwait(false);
        }

        List<int> tagIds = await QueryPublicTagIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int tagId in tagIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Tag, tagId, pages, sizes, null, tagId, version, queryVersion, options, ct).ConfigureAwait(false);
        }

        foreach (int size in hotSizes)
        {
            await AddHotFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
        }

        foreach (int size in featuredSizes)
        {
            await AddFeaturedFrameAsync(frames, size, version, options, ct).ConfigureAwait(false);
        }

        return frames.ToFrozenDictionary();
    }

    private async Task<List<int>> QueryPublicCategoryIdsAsync(DateTime utcNow, CancellationToken ct)
    {
        return await db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .Select(article => article.CategoryId)
            .Distinct()
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task<List<int>> QueryPublicTagIdsAsync(DateTime utcNow, CancellationToken ct)
    {
        return await db.Queryable<ArticleTag, Article>((articleTag, article) => articleTag.ArticleId == article.Id)
            .Where((articleTag, article) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .Select((articleTag, article) => articleTag.TagId)
            .Distinct()
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task AddArticlePageFramesAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        PublicListKind kind,
        int targetId,
        int[] pages,
        int[] sizes,
        int? categoryId,
        int? tagId,
        long version,
        long queryVersion,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            int maxRows = checked(pages.Max() * sizes.Max());
            CorePageResult<ArticleListCoreModel> window = await LoadArticlePageWindowFromDbAsync(
                    maxRows,
                    categoryId,
                    tagId,
                    ct)
                .ConfigureAwait(false);

            foreach (int page in pages)
            {
                foreach (int size in sizes)
                {
                    ct.ThrowIfCancellationRequested();
                    int offset = (page - 1) * size;
                    IReadOnlyList<ArticleListCoreModel> items = offset >= window.Items.Count
                        ? []
                        : window.Items.Skip(offset).Take(size).ToList();
                    bool hasMore = offset + items.Count < window.Total && items.Count > 0;
                    ArticleListCoreModel? lastItem = items.Count > 0 ? items[^1] : null;
                    string? nextCursor = hasMore && lastItem.HasValue
                        ? articleListCursorCodec.Encode(
                            new ArticleListCursorPosition(lastItem.Value.CreateTime, lastItem.Value.Id),
                            categoryId,
                            tagId,
                            normalizedKeyword: null,
                            size,
                            queryVersion,
                            ArticleListSortMode.Latest)
                        : null;
                    var result = new CorePageResult<ArticleListCoreModel>(items, window.Total, nextCursor, hasMore);
                    frames[new PublicListKey(kind, targetId, (ushort)page, (byte)size)] =
                        EncodeFrame(AedsFrameType.ArticleList, writer => PodBinaryCodec.WriteArticlePage(result, writer), version, options);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip {Kind} {TargetId}", kind, targetId);
        }
    }

    private async ValueTask<long> ReadArticleListQueryVersionAsync(CancellationToken ct)
    {
        if (cacheStringReader is null)
        {
            return 0;
        }

        string? value = await cacheStringReader.GetStringAsync(CachePolicyId.ArticleListVersion, "main", ct).ConfigureAwait(false);
        return long.TryParse(value, out long parsed) ? parsed : 0;
    }

    private async Task AddHotFrameAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        int size,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            IReadOnlyList<PopularArticleCoreModel> result = await LoadHotArticlesFromDbAsync(size, ct).ConfigureAwait(false);
            frames[new PublicListKey(PublicListKind.Hot, 0, 1, (byte)size)] =
                EncodeFrame(AedsFrameType.ArticleHot, writer => PodBinaryCodec.WritePopularArticles(result, writer), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip hot {Size}", size);
        }
    }

    private async Task AddFeaturedFrameAsync(
        Dictionary<PublicListKey, PublicBinaryArtifact> frames,
        int size,
        long version,
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            IReadOnlyList<FeaturedArticleCoreModel> result = await LoadFeaturedArticlesFromDbAsync(size, ct).ConfigureAwait(false);
            frames[new PublicListKey(PublicListKind.Featured, 0, 1, (byte)size)] =
                EncodeFrame(AedsFrameType.ArticleFeatured, writer => PodBinaryCodec.WriteFeaturedArticleCoreList(result, writer), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip featured {Size}", size);
        }
    }

    private async Task<CorePageResult<ArticleListCoreModel>> LoadArticlePageWindowFromDbAsync(
        int limit,
        int? categoryId,
        int? tagId,
        CancellationToken ct)
    {
        limit = limit switch
        {
            < 1 => 10,
            > MaxPageSize * ushort.MaxValue => MaxPageSize * ushort.MaxValue,
            _ => limit
        };

        List<string> whereClauses =
        [
            "a.isdeleted = @IsDeleted",
            "a.status = @PublishedStatus",
            "a.current_publication_id IS NOT NULL",
            "(a.published_at IS NULL OR a.published_at <= @Now)",
            "(a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)"
        ];
        List<SugarParameter> parameters =
        [
            new("@IsDeleted", false),
            new("@PublishedStatus", (int)ArticleStatus.Published),
            new("@Now", timeProvider.GetUtcNow().UtcDateTime),
            new("@Limit", limit)
        ];

        if (categoryId.HasValue)
        {
            whereClauses.Add("EXISTS (SELECT 1 FROM article_publication fp JOIN article_revision fr ON fr.id = fp.article_revision_id WHERE fp.id = a.current_publication_id AND fr.categoryid = @CategoryId)");
            parameters.Add(new SugarParameter("@CategoryId", categoryId.Value));
        }

        if (tagId.HasValue)
        {
            whereClauses.Add("""
                EXISTS (
                    SELECT 1
                    FROM article_publication fp
                    JOIN article_revision fr ON fr.id = fp.article_revision_id
                    WHERE fp.id = a.current_publication_id
                      AND @TagId = ANY(COALESCE(string_to_array(NULLIF(fr.tag_ids, ''), ',')::integer[], ARRAY[]::integer[]))
                )
                """);
            parameters.Add(new SugarParameter("@TagId", tagId.Value));
        }

        string whereSql = string.Join(" AND ", whereClauses);
        string combinedSql = $$"""
            SELECT COUNT(1) AS "__TotalCount"
            FROM article a
            WHERE {{whereSql}};

            SELECT
                a.id AS "Id",
                revision.title AS "Title",
                revision.summary AS "Summary",
                revision.cover_image_url AS "CoverImageUrl",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                revision.categoryid AS "CategoryId",
                c.name AS "CategoryName",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt",
                revision.id AS "CurrentRevisionId",
                revision.revision_no AS "RevisionNo",
                publication.id AS "CurrentPublicationId",
                publication.publication_no AS "PublicationNo"
            FROM article a
            JOIN article_publication publication ON publication.id = a.current_publication_id
            JOIN article_revision revision ON revision.id = publication.article_revision_id
            LEFT JOIN category c ON revision.categoryid = c.id
            WHERE {{whereSql}}
            ORDER BY a.createtime DESC, a.id DESC
            LIMIT @Limit;
            """;

        int totalCount = 0;
        var list = new List<ArticleListItemReadModel>(Math.Min(limit, 1024));
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(combinedSql, parameters))
        {
            if (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                totalCount = reader.IsDBNull(0) ? 0 : Convert.ToInt32(reader.GetValue(0));
            }

            if (!await reader.NextResultAsync(ct).ConfigureAwait(false))
            {
                return new CorePageResult<ArticleListCoreModel>([], totalCount);
            }

            int fId = reader.GetOrdinal("Id");
            int fTitle = reader.GetOrdinal("Title");
            int fSum = reader.GetOrdinal("Summary");
            int fCover = reader.GetOrdinal("CoverImageUrl");
            int fViews = reader.GetOrdinal("Views");
            int fTime = reader.GetOrdinal("CreateTime");
            int fCatId = reader.GetOrdinal("CategoryId");
            int fCatName = reader.GetOrdinal("CategoryName");
            int fDel = reader.GetOrdinal("IsDeleted");
            int fStatus = reader.GetOrdinal("Status");
            int fScheduled = reader.GetOrdinal("ScheduledPublishAt");
            int fPublished = reader.GetOrdinal("PublishedAt");
            int fRevisionId = reader.GetOrdinal("CurrentRevisionId");
            int fRevisionNo = reader.GetOrdinal("RevisionNo");
            int fPublicationId = reader.GetOrdinal("CurrentPublicationId");
            int fPublicationNo = reader.GetOrdinal("PublicationNo");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                list.Add(new ArticleListItemReadModel
                {
                    Id = reader.GetInt32(fId),
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    CategoryId = reader.GetInt32(fCatId),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认" : reader.GetString(fCatName),
                    IsDeleted = reader.GetBoolean(fDel),
                    Status = (ArticleStatus)reader.GetInt32(fStatus),
                    ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : reader.GetDateTime(fScheduled),
                    PublishedAt = reader.IsDBNull(fPublished) ? null : reader.GetDateTime(fPublished),
                    CurrentRevisionId = reader.GetInt64(fRevisionId),
                    RevisionNo = reader.GetInt32(fRevisionNo),
                    CurrentPublicationId = reader.GetInt64(fPublicationId),
                    PublicationNo = reader.GetInt32(fPublicationNo),
                    Tags = []
                });
            }
        }

        if (list.Count > 0)
        {
            var ids = new List<int>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                ids.Add(list[i].Id);
            }

            IReadOnlyDictionary<int, List<TagReadModel>> tagMap = await LoadArticleTagMapAsync(ids, ct).ConfigureAwait(false);
            AttachTags(list, tagMap);
        }

        return new CorePageResult<ArticleListCoreModel>(list.Select(ArticleProjection.ToCoreListModel).ToList(), totalCount);
    }

    private async Task<ArticleDetailReadModel?> LoadArticleDetailFromDbAsync(int id, CancellationToken ct)
    {
        IReadOnlyList<ArticleDetailReadModel> articles = await LoadArticleDetailsFromDbAsync([id], ct).ConfigureAwait(false);
        return articles.Count == 0 ? null : articles[0];
    }

    private async Task<IReadOnlyList<ArticleDetailReadModel>> LoadArticleDetailsFromDbAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct,
        long? expectedReleaseId = null)
    {
        int[] ids = [.. articleIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return [];
        }

        DateTime utcNow = timeProvider.GetUtcNow().UtcDateTime;
        var query = db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<Category>((article, publication, revision, category) => revision.CategoryId == category.Id)
            .Where((article, publication, revision, category) => ids.Contains(article.Id)
                && article.IsDeleted == false
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .WhereIF(expectedReleaseId.HasValue, (article, publication, revision, category) =>
                publication.Id == expectedReleaseId!.Value)
            .Select((article, publication, revision, category) => new
            {
                article.Id,
                revision.Title,
                revision.Summary,
                revision.CoverImageUrl,
                revision.CategoryId,
                article.Views,
                article.CreateTime,
                article.IsDeleted,
                article.Status,
                article.ScheduledPublishAt,
                PublishedAt = publication.PublishedAt,
                RevisionId = revision.Id,
                revision.RevisionNo,
                PublicationId = publication.Id,
                publication.PublicationNo,
                CategoryName = category.Name
            });

        var sqlObj = query.ToSql();
        var articles = new Dictionary<int, ArticleDetailReadModel>(ids.Length);
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fTitle = reader.GetOrdinal("Title");
            int fSum = reader.GetOrdinal("Summary");
            int fCover = reader.GetOrdinal("CoverImageUrl");
            int fCatId = reader.GetOrdinal("CategoryId");
            int fViews = reader.GetOrdinal("Views");
            int fTime = reader.GetOrdinal("CreateTime");
            int fIsDel = reader.GetOrdinal("IsDeleted");
            int fStatus = reader.GetOrdinal("Status");
            int fScheduled = reader.GetOrdinal("ScheduledPublishAt");
            int fPublished = reader.GetOrdinal("PublishedAt");
            int fCatName = reader.GetOrdinal("CategoryName");
            int fRevisionId = reader.GetOrdinal("RevisionId");
            int fRevisionNo = reader.GetOrdinal("RevisionNo");
            int fPublicationId = reader.GetOrdinal("PublicationId");
            int fPublicationNo = reader.GetOrdinal("PublicationNo");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                int articleId = reader.GetInt32(fId);
                articles[articleId] = new ArticleDetailReadModel
                {
                    Id = articleId,
                    Title = reader.IsDBNull(fTitle) ? string.Empty : reader.GetString(fTitle),
                    Summary = reader.IsDBNull(fSum) ? string.Empty : reader.GetString(fSum),
                    CoverImageUrl = reader.IsDBNull(fCover) ? null : reader.GetString(fCover),
                    CategoryId = reader.GetInt32(fCatId),
                    Views = reader.GetInt32(fViews),
                    CreateTime = reader.GetDateTime(fTime),
                    IsDeleted = reader.GetBoolean(fIsDel),
                    Status = (ArticleStatus)reader.GetInt32(fStatus),
                    ScheduledPublishAt = reader.IsDBNull(fScheduled) ? null : reader.GetDateTime(fScheduled),
                    PublishedAt = reader.IsDBNull(fPublished) ? null : reader.GetDateTime(fPublished),
                    CurrentRevisionId = reader.GetInt64(fRevisionId),
                    RevisionNo = reader.GetInt32(fRevisionNo),
                    CurrentPublicationId = reader.GetInt64(fPublicationId),
                    PublicationNo = reader.GetInt32(fPublicationNo),
                    CategoryName = reader.IsDBNull(fCatName) ? "默认分类" : reader.GetString(fCatName),
                    Tags = []
                };
            }
        }

        if (articles.Count == 0)
        {
            return [];
        }

        IReadOnlyDictionary<int, string> contentMap = await LoadArticleContentMapAsync([.. articles.Keys], ct).ConfigureAwait(false);
        IReadOnlyDictionary<int, List<TagReadModel>> tagMap = await LoadArticleTagMapAsync([.. articles.Keys], ct).ConfigureAwait(false);
        IReadOnlyDictionary<int, ArticleRightsReadModel> rightsMap = await LoadArticleRightsMapAsync([.. articles.Keys], ct).ConfigureAwait(false);
        var result = new List<ArticleDetailReadModel>(articles.Count);
        foreach (int id in ids)
        {
            if (!articles.TryGetValue(id, out ArticleDetailReadModel? article))
            {
                continue;
            }

            string content = contentMap.TryGetValue(id, out string? mappedContent) ? mappedContent : string.Empty;
            if (string.IsNullOrWhiteSpace(content))
            {
                articleBodyRepairQueue.TrySchedule(id, "public-hot-read");
                logger.LogWarning("public_hot_article_body_missing {ArticleId}", id);
                FsusObservability.RecordOperation("article_body", "public_hot_read", "missing", TimeSpan.Zero);
                continue;
            }

            if (!rightsMap.TryGetValue(id, out ArticleRightsReadModel? rights) || !HasCompleteArticleRights(rights))
            {
                logger.LogWarning("public_hot_article_detail_rights_missing {ArticleId}", id);
                FsusObservability.RecordOperation("public_hot_read", "article_detail", "rights_missing", TimeSpan.Zero);
                continue;
            }

            ReadingEstimate reading = ReadingEstimator.Estimate(content);
            result.Add(article with
            {
                Content = content,
                WordCount = reading.EffectiveChars,
                EstimatedReadingMinutes = reading.Minutes,
                ShowReadingNotice = reading.ShowLongReadNotice,
                Tags = tagMap.TryGetValue(id, out var tags) ? tags : [],
                Rights = rights
            });
        }

        return result;
    }

    private async Task<IReadOnlyList<PopularArticleCoreModel>> LoadHotArticlesFromDbAsync(int count, CancellationToken ct)
    {
        count = Math.Clamp(count, 1, MaxHotArticlesCount);
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        // SqlSugar multi-table Where must use the join aliases (`article`…).
        // A discarded single-table `a` alias throws at ToSql, is swallowed by
        // AddHotFrameAsync, and leaves public hot-read without /hot/{size}.aeds.
        var rows = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .Where((article, publication, revision) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now))
            .OrderByDescending((article, publication, revision) => article.Views)
            .OrderByDescending((article, publication, revision) => article.Id)
            .Take(count)
            .Select((article, publication, revision) => new { article.Id, revision.Title, article.Views })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        return rows.Select(row => new PopularArticleCoreModel(
            PodProjector.ProjectPopularArticle(row.Id, row.Title ?? string.Empty, row.Views),
            row.Id,
            row.Title ?? string.Empty,
            row.Views)).ToList();
    }

    private async Task<IReadOnlyList<FeaturedArticleCoreModel>> LoadFeaturedArticlesFromDbAsync(int count, CancellationToken ct)
    {
        count = Math.Clamp(count, 1, 20);
        int candidateLimit = MaxHotArticlesCount;
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        var rows = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<Category>((article, publication, revision, category) => revision.CategoryId == category.Id)
            .Where((article, publication, revision, category) => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= now)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now)
                && revision.CoverImageUrl != null
                && revision.CoverImageUrl != "")
            .OrderByDescending((article, publication, revision, category) => article.Views)
            .OrderByDescending((article, publication, revision, category) => article.Id)
            .Take(candidateLimit)
            .Select((article, publication, revision, category) => new
            {
                article.Id,
                revision.Title,
                revision.CoverImageUrl,
                article.Views,
                article.CreateTime,
                revision.CategoryId,
                CategoryName = category.Name
            })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        return rows
            .Where(static row => !string.IsNullOrWhiteSpace(row.CoverImageUrl))
            .Take(count)
            .Select(row => new FeaturedArticleCoreModel(
                row.Id,
                row.Title ?? string.Empty,
                row.CoverImageUrl!.Trim(),
                row.Views,
                row.CreateTime,
                new ArticleCategoryCoreModel(row.CategoryId, row.CategoryName ?? string.Empty))).ToList();
    }

    private async Task<IReadOnlyDictionary<int, string>> LoadArticleContentMapAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct)
    {
        int[] ids = [.. articleIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return new Dictionary<int, string>();
        }

        var rows = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .LeftJoin<ArticleRevisionContentBlock>((article, publication, revision, block) => revision.ContentBlockId == block.Id)
            .LeftJoin<ArticleBody>((article, publication, revision, block, body) => article.Id == body.ArticleId)
            .Where(article => ids.Contains(article.Id))
            .Select((article, publication, revision, block, body) => new
            {
                ArticleId = article.Id,
                RevisionId = revision.Id,
                revision.ContentBlockId,
                ResolvedContentBlockId = (long?)block.Id,
                MarkdownContent = block.MarkdownContent,
                ArticleBodyContent = body.MarkdownContent
            })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        var contentMap = new Dictionary<int, string>(ids.Length);
        foreach (var row in rows)
        {
            if (row.ContentBlockId <= 0
                || row.ResolvedContentBlockId != row.ContentBlockId
                || row.MarkdownContent is null)
            {
                throw new InvalidOperationException(
                    $"article_revision_content_block_missing:{row.RevisionId}:{row.ContentBlockId}");
            }

            if (string.IsNullOrWhiteSpace(row.ArticleBodyContent))
            {
                continue;
            }

            contentMap[row.ArticleId] = row.MarkdownContent;
        }

        return contentMap;
    }

    private async Task<string> LoadArticleContentAsync(int articleId, CancellationToken ct)
    {
        IReadOnlyDictionary<int, string> contentMap = await LoadArticleContentMapAsync([articleId], ct).ConfigureAwait(false);
        return contentMap.TryGetValue(articleId, out string? content) ? content : string.Empty;
    }

    private async Task<IReadOnlyDictionary<int, ArticleRightsReadModel>> LoadArticleRightsMapAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken ct)
    {
        int[] ids = [.. articleIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return new Dictionary<int, ArticleRightsReadModel>();
        }

        var parameters = new List<SugarParameter>(ids.Length);
        var parameterNames = new List<string>(ids.Length);
        for (int i = 0; i < ids.Length; i++)
        {
            string parameterName = string.Concat("@ArticleId", i.ToString(System.Globalization.CultureInfo.InvariantCulture));
            parameterNames.Add(parameterName);
            parameters.Add(new SugarParameter(parameterName, ids[i]));
        }

        string idListSql = string.Join(", ", parameterNames);
        string sql = $"""
            SELECT
                rights.article_id AS "ArticleId",
                rights.id AS "RightsSnapshotId",
                rights.article_revision_id AS "RightsArticleRevisionId",
                rights.revision_no AS "RightsRevisionNo",
                rights.enabled AS "RightsEnabled",
                rights.license_type AS "RightsLicenseType",
                rights.copyright_holder AS "RightsCopyrightHolder",
                rights.copyright_year AS "RightsCopyrightYear",
                rights.rights_statement AS "RightsStatement",
                rights.attribution_template AS "RightsAttributionTemplate",
                rights.copy_policy AS "RightsCopyPolicy",
                rights.max_excerpt_chars AS "RightsMaxExcerptChars",
                rights.allow_code_copy AS "RightsAllowCodeCopy",
                rights.show_public_badge AS "RightsShowPublicBadge",
                rights.proof_binding_enabled AS "RightsProofBindingEnabled",
                rights.canonical_url AS "RightsCanonicalUrl",
                rights.policy_hash AS "RightsPolicyHash",
                rights.content_canonical_hash AS "RightsContentCanonicalHash",
                CASE
                    WHEN rights_proof.id IS NULL THEN NULL
                    ELSE concat('urn:fsus:rights-proof:', rights_proof.id::text)
                END AS "RightsProofUrl",
                rights_proof.proof_status AS "RightsProofStatus"
            FROM article article
            JOIN article_publication publication ON publication.id = article.current_publication_id
            JOIN article_rights_snapshot rights ON rights.id = publication.rights_snapshot_id
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = rights.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE
            WHERE article.id IN ({idListSql});
            """;

        var map = new Dictionary<int, ArticleRightsReadModel>(ids.Length);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters).ConfigureAwait(false);
        int articleIdOrdinal = reader.GetOrdinal("ArticleId");
        while (await reader.ReadAsync(ct).ConfigureAwait(false))
        {
            map[reader.GetInt32(articleIdOrdinal)] = ReadArticleRights(reader);
        }

        return map;
    }

    private static ArticleRightsReadModel ReadArticleRights(DbDataReader reader)
    {
        int snapshotId = reader.GetOrdinal("RightsSnapshotId");
        if (reader.IsDBNull(snapshotId))
        {
            return new ArticleRightsReadModel();
        }

        return new ArticleRightsReadModel
        {
            SnapshotId = reader.GetInt64(snapshotId),
            ArticleRevisionId = reader.GetInt64(reader.GetOrdinal("RightsArticleRevisionId")),
            RevisionNo = reader.GetInt32(reader.GetOrdinal("RightsRevisionNo")),
            Enabled = reader.GetBoolean(reader.GetOrdinal("RightsEnabled")),
            LicenseType = ReadStringOrDefault(reader, "RightsLicenseType", "all-rights-reserved"),
            CopyrightHolder = ReadNullableString(reader, "RightsCopyrightHolder"),
            CopyrightYear = ReadNullableInt32(reader, "RightsCopyrightYear"),
            RightsStatement = ReadNullableString(reader, "RightsStatement"),
            AttributionTemplate = ReadNullableString(reader, "RightsAttributionTemplate"),
            CopyPolicy = ReadStringOrDefault(reader, "RightsCopyPolicy", "append-attribution"),
            MaxExcerptChars = reader.GetInt32(reader.GetOrdinal("RightsMaxExcerptChars")),
            AllowCodeCopy = reader.GetBoolean(reader.GetOrdinal("RightsAllowCodeCopy")),
            ShowPublicBadge = reader.GetBoolean(reader.GetOrdinal("RightsShowPublicBadge")),
            ProofBindingEnabled = reader.GetBoolean(reader.GetOrdinal("RightsProofBindingEnabled")),
            CanonicalUrl = ReadNullableString(reader, "RightsCanonicalUrl"),
            PolicyHash = ReadStringOrDefault(reader, "RightsPolicyHash", string.Empty),
            ContentCanonicalHash = ReadStringOrDefault(reader, "RightsContentCanonicalHash", string.Empty),
            ProofUrl = ReadNullableString(reader, "RightsProofUrl"),
            ProofStatus = ReadNullableString(reader, "RightsProofStatus")
        };
    }

    private static bool HasCompleteArticleRights(ArticleRightsReadModel? rights)
        => rights is not null
            && rights.SnapshotId > 0
            && rights.ArticleRevisionId > 0
            && rights.RevisionNo > 0
            && !string.IsNullOrWhiteSpace(rights.LicenseType)
            && !string.IsNullOrWhiteSpace(rights.CopyPolicy)
            && !string.IsNullOrWhiteSpace(rights.PolicyHash)
            && !string.IsNullOrWhiteSpace(rights.ContentCanonicalHash);

    private static string ReadStringOrDefault(DbDataReader reader, string fieldName, string defaultValue)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? defaultValue : reader.GetString(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string fieldName)
    {
        int ordinal = reader.GetOrdinal(fieldName);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private async Task<Dictionary<int, List<TagReadModel>>> LoadArticleTagMapAsync(IReadOnlyCollection<int> articleIds, CancellationToken ct)
    {
        if (articleIds.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var ids = articleIds
            .Where(id => id > 0)
            .Distinct()
            .ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<int, List<TagReadModel>>();
        }

        var revisionRows = await db.Queryable<Article>()
            .InnerJoin<ArticlePublicationRecord>((article, publication) => article.CurrentPublicationId == publication.Id)
            .InnerJoin<ArticleRevision>((article, publication, revision) => publication.ArticleRevisionId == revision.Id)
            .Where(article => ids.Contains(article.Id))
            .Select((article, publication, revision) => new PublishedTagCoordinate
            {
                ArticleId = article.Id,
                TagIds = revision.TagIds
            })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        Dictionary<int, int[]> articleTagIds = revisionRows.ToDictionary(
            static row => row.ArticleId,
            static row => FsusBlog.Server.Services.Authoring.AuthoringNormalization.ParseTagIds(row.TagIds).ToArray());
        int[] allTagIds = articleTagIds.Values.SelectMany(static values => values).Distinct().ToArray();
        Dictionary<int, string> tagNames = allTagIds.Length == 0
            ? []
            : (await db.Queryable<Tag>()
                    .Where(tag => allTagIds.Contains(tag.Id))
                    .ToListAsync(ct)
                    .ConfigureAwait(false))
                .ToDictionary(static tag => tag.Id, static tag => tag.Name);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach ((int articleId, int[] tagIds) in articleTagIds)
        {
            tagMap[articleId] = tagIds
                .Where(tagNames.ContainsKey)
                .Select(tagId => new TagReadModel { Id = tagId, Name = tagNames[tagId] })
                .ToList();
        }

        return tagMap;
    }

    private sealed class PublishedTagCoordinate
    {
        public int ArticleId
        {
            get; init;
        }
        public string TagIds { get; init; } = string.Empty;
    }

    private static void AttachTags(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
    {
        for (int i = 0; i < items.Count; i++)
        {
            ArticleListItemReadModel item = items[i];
            items[i] = item with
            {
                Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : []
            };
        }
    }

    private static int[] NormalizeIds(IEnumerable<int> ids)
        => ids
            .Where(static id => id > 0)
            .Distinct()
            .Order()
            .ToArray();

    private async Task<PublicBinaryArtifact> BuildCategoryFrameAsync(long version, PublicHotReadOptions options, CancellationToken ct)
    {
        var query = db.Queryable<Category>()
            .LeftJoin<CategoryPublicArticleCount>((c, count) => c.Id == count.CategoryId)
            .OrderBy(c => c.Id)
            .Select((c, count) => new
            {
                c.Id,
                c.Name,
                ArticleCount = SqlFunc.MappingColumn<long>("COALESCE(count.article_count, 0)")
            });

        var sqlObj = query.ToSql();
        var result = new List<CategoryListItemResponse>();
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Name");
            int fCount = reader.GetOrdinal("ArticleCount");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                result.Add(ArticleProjection.ToCategoryResponse(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                    (int)reader.GetInt64(fCount)));
            }
        }

        return EncodeFrame(AedsFrameType.CategoryList, writer => PodBinaryCodec.WriteCategoryList(result, writer), version, options);
    }

    private async Task<PublicBinaryArtifact> BuildTagFrameAsync(long version, PublicHotReadOptions options, CancellationToken ct)
    {
        var query = db.Queryable<Tag>()
            .LeftJoin<TagPublicArticleCount>((t, count) => t.Id == count.TagId)
            .OrderBy(t => t.Id)
            .Select((t, count) => new
            {
                t.Id,
                t.Name,
                ArticleCount = SqlFunc.MappingColumn<long>("COALESCE(count.article_count, 0)")
            });

        var sqlObj = query.ToSql();
        var result = new List<TagWithCountDto>();
        using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sqlObj.Key, sqlObj.Value))
        {
            int fId = reader.GetOrdinal("Id");
            int fName = reader.GetOrdinal("Name");
            int fCount = reader.GetOrdinal("ArticleCount");

            while (await reader.ReadAsync(ct).ConfigureAwait(false))
            {
                result.Add(new TagWithCountDto(
                    reader.GetInt32(fId),
                    reader.IsDBNull(fName) ? string.Empty : reader.GetString(fName),
                    (int)reader.GetInt64(fCount)));
            }
        }

        return EncodeFrame(AedsFrameType.TagList, writer => PodBinaryCodec.WriteTagWithCountList(result, writer), version, options);
    }

    private static PublicBinaryArtifact EncodeFrame(
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload,
        long version,
        PublicHotReadOptions options)
        => PublicHotReadBinaryArtifactFactory.FromWriter(frameType, writePayload, options.CacheControl, version, options);

    private static int[] NormalizePositive(int[]? values, int[] fallback, int max)
    {
        int[] normalized = (values is { Length: > 0 } ? values : fallback)
            .Where(value => value > 0 && value <= max)
            .Distinct()
            .Order()
            .ToArray();

        return normalized.Length == 0 ? fallback.Where(value => value <= max).ToArray() : normalized;
    }
}

public sealed class PublicHotReadStartupWarmupService(
    IServiceScopeFactory scopeFactory,
    PublicHotReadStore store,
    PublicHotArtifactUpdateQueue updateQueue,
    ILogger<PublicHotReadStartupWarmupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            store.BeginBuild("startup");
            PublicHotReadSnapshot snapshot;
            await using (AsyncServiceScope scope = scopeFactory.CreateAsyncScope())
            {
                var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
                snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
            }
            store.Publish(snapshot);
            logger.LogInformation("public-hot-read-snapshot-ready {Version}", snapshot.Version);

            using var timer = new PeriodicTimer(store.SnapshotRefreshInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                if (!store.ShouldRefreshSnapshot())
                {
                    continue;
                }

                PublicHotArtifactEnqueueResult result = await updateQueue.EnqueueAsync(
                    PublicHotArtifactDeliveryClass.FullRebuildMarker,
                    null,
                    "sanity-age-refresh",
                    cancellationToken: stoppingToken).ConfigureAwait(false);
                PublicHotArtifactDeliveryReceipt.RequireDurable(result, "sanity-age-refresh");
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            store.ReportBuildFailure("startup", ex);
            logger.LogWarning(ex, "public-hot-read-snapshot-warmup-failed");
        }
    }
}
