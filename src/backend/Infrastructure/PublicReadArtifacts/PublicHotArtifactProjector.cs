using System.Collections.Frozen;
using System.Diagnostics;
using System.Data.Common;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
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
    ILogger<PublicHotArtifactProjector> logger) : IPublicHotArtifactProjector
{
    private const int MaxPageSize = 100;
    private const int MaxHotArticlesCount = 100;
    public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct)
    {
        if (articleId <= 0 || current.ArticleFrameCount == 0)
        {
            return BuildSnapshotAsync(current.HtmlArtifacts, ct);
        }

        return dbConcurrencyGate.ExecuteAsync(
            "public-hot-read-delta",
            gateCt => BuildDeltaSnapshotCoreAsync(current, articleId, gateCt),
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
        DateTimeOffset projectionCutoff = DateTimeOffset.UtcNow;
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
        CancellationToken ct)
    {
        long started = Stopwatch.GetTimestamp();
        PublicHotReadOptions value = options.Value;
        DateTimeOffset projectionCutoff = DateTimeOffset.UtcNow;
        DateTime visibilityCutoff = projectionCutoff.UtcDateTime;
        long version = projectionCutoff.ToUnixTimeMilliseconds();
        var articleFrames = current.ArticleArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        var listFrames = current.ListArtifacts.ToDictionary(static pair => pair.Key, static pair => pair.Value);
        IReadOnlyList<ArticleDetailReadModel> changedArticles = await LoadArticleDetailsFromDbAsync([articleId], ct).ConfigureAwait(false);
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
            articleFrames[changed.Id] = EncodeFrame(AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(core), version, value);
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
        DateTimeOffset projectionCutoff = DateTimeOffset.UtcNow;
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

                changedArticleIds.Add(changed.Id);
                ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(changed);
                articleFrames[changed.Id] = EncodeFrame(AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(core), version, value);
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
        int[] pages = NormalizePositive(options.PreloadPages, [1], Math.Clamp(options.MaxPreloadPage, 1, ushort.MaxValue));
        int[] sizes = NormalizePositive(options.PreloadSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        await AddArticlePageFramesAsync(frames, PublicListKind.Home, 0, pages, sizes, null, null, version, options, ct).ConfigureAwait(false);
        rebuilt += pages.Length * sizes.Length;
        await AddArticlePageFramesAsync(frames, PublicListKind.Archive, 0, pages, sizes, null, null, version, options, ct).ConfigureAwait(false);
        rebuilt += pages.Length * sizes.Length;

        foreach (int categoryId in scope.CategoryIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Category, categoryId, pages, sizes, categoryId, null, version, options, ct).ConfigureAwait(false);
            rebuilt += pages.Length * sizes.Length;
        }

        foreach (int tagId in scope.TagIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Tag, tagId, pages, sizes, null, tagId, version, options, ct).ConfigureAwait(false);
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
        var frames = new Dictionary<int, PublicBinaryArtifact>(details.Count);
        foreach (ArticleDetailReadModel detail in details)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsPubliclyVisible(detail, visibilityCutoff))
            {
                continue;
            }

            ArticleDetailCoreModel core = ArticleProjection.ToCoreDetailModel(detail);
            frames[detail.Id] = EncodeFrame(AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(core), version, options);
        }

        return ApplyArticleAdmission(frames, articleIds, options).ToFrozenDictionary();
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
        int[] pages = NormalizePositive(options.PreloadPages, [1], Math.Clamp(options.MaxPreloadPage, 1, ushort.MaxValue));
        int[] sizes = NormalizePositive(options.PreloadSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] hotSizes = NormalizePositive(options.HotSizes, [1, 3, 5, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));
        int[] featuredSizes = NormalizePositive(options.FeaturedSizes, [3, 4, 10], Math.Clamp(options.MaxPreloadSize, 1, 100));

        await AddArticlePageFramesAsync(frames, PublicListKind.Home, 0, pages, sizes, null, null, version, options, ct).ConfigureAwait(false);
        await AddArticlePageFramesAsync(frames, PublicListKind.Archive, 0, pages, sizes, null, null, version, options, ct).ConfigureAwait(false);

        List<int> categoryIds = await QueryPublicCategoryIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int categoryId in categoryIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Category, categoryId, pages, sizes, categoryId, null, version, options, ct).ConfigureAwait(false);
        }

        List<int> tagIds = await QueryPublicTagIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int tagId in tagIds)
        {
            await AddArticlePageFramesAsync(frames, PublicListKind.Tag, tagId, pages, sizes, null, tagId, version, options, ct).ConfigureAwait(false);
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
        PublicHotReadOptions options,
        CancellationToken ct)
    {
        try
        {
            int maxRows = checked(pages.Max() * sizes.Max());
            CorePageResult<ArticleListCoreModel> window = await LoadArticlePageWindowFromDbAsync(
                    offset: 0,
                    limit: maxRows,
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
                    var result = new CorePageResult<ArticleListCoreModel>(items, window.Total);
                    frames[new PublicListKey(kind, targetId, (ushort)page, (byte)size)] =
                        EncodeFrame(AedsFrameType.ArticleList, PodBinaryCodec.EncodeArticlePage(result), version, options);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip {Kind} {TargetId}", kind, targetId);
        }
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
                EncodeFrame(AedsFrameType.ArticleHot, PodBinaryCodec.EncodePopularArticles(result), version, options);
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
                EncodeFrame(AedsFrameType.ArticleFeatured, PodBinaryCodec.EncodeFeaturedArticleCoreList(result), version, options);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "public-hot-list-project-skip featured {Size}", size);
        }
    }

    private async Task<CorePageResult<ArticleListCoreModel>> LoadArticlePageWindowFromDbAsync(
        int offset,
        int limit,
        int? categoryId,
        int? tagId,
        CancellationToken ct)
    {
        offset = Math.Max(0, offset);
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
            "(a.published_at IS NULL OR a.published_at <= @Now)",
            "(a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= @Now)"
        ];
        List<SugarParameter> parameters =
        [
            new("@IsDeleted", false),
            new("@PublishedStatus", (int)ArticleStatus.Published),
            new("@Now", DateTime.UtcNow),
            new("@Offset", offset),
            new("@Limit", limit)
        ];

        if (categoryId.HasValue)
        {
            whereClauses.Add("a.categoryid = @CategoryId");
            parameters.Add(new SugarParameter("@CategoryId", categoryId.Value));
        }

        if (tagId.HasValue)
        {
            whereClauses.Add("""
                EXISTS (
                    SELECT 1
                    FROM article_tag at
                    WHERE at.articleid = a.id AND at.tagid = @TagId
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
                a.title AS "Title",
                a.summary AS "Summary",
                a.coverimageurl AS "CoverImageUrl",
                a.views AS "Views",
                a.createtime AS "CreateTime",
                a.categoryid AS "CategoryId",
                c.name AS "CategoryName",
                a.isdeleted AS "IsDeleted",
                a.status AS "Status",
                a.scheduled_publish_at AS "ScheduledPublishAt",
                a.published_at AS "PublishedAt"
            FROM article a
            LEFT JOIN category c ON a.categoryid = c.id
            WHERE {{whereSql}}
            ORDER BY a.createtime DESC, a.id DESC
            OFFSET @Offset
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
        CancellationToken ct)
    {
        int[] ids = [.. articleIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return [];
        }

        DateTime utcNow = DateTime.UtcNow;
        var query = db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => ids.Contains(a.Id)
                && a.IsDeleted == false
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= utcNow)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= utcNow))
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.Summary,
                a.CoverImageUrl,
                a.CategoryId,
                a.Views,
                a.CreateTime,
                a.IsDeleted,
                a.Status,
                a.ScheduledPublishAt,
                a.PublishedAt,
                CategoryName = c.Name
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
            if (string.IsNullOrWhiteSpace(content) && !string.IsNullOrWhiteSpace(article.Summary))
            {
                content = article.Summary;
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
        DateTime now = DateTime.UtcNow;
        var rows = await db.Queryable<Article>()
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now))
            .OrderByDescending(a => a.Views)
            .OrderByDescending(a => a.Id)
            .Take(count)
            .Select(a => new { a.Id, a.Title, a.Views })
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
        DateTime now = DateTime.UtcNow;
        var rows = await db.Queryable<Article>()
            .LeftJoin<Category>((a, c) => a.CategoryId == c.Id)
            .Where(a => !a.IsDeleted
                && a.Status == ArticleStatus.Published
                && (a.PublishedAt == null || a.PublishedAt <= now)
                && (a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now)
                && a.CoverImageUrl != null
                && a.CoverImageUrl != "")
            .OrderByDescending(a => a.Views)
            .OrderByDescending(a => a.Id)
            .Take(candidateLimit)
            .Select((a, c) => new
            {
                a.Id,
                a.Title,
                a.CoverImageUrl,
                a.Views,
                a.CreateTime,
                a.CategoryId,
                CategoryName = c.Name
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

        var rows = await db.Queryable<ArticleBody>()
            .Where(body => ids.Contains(body.ArticleId))
            .Select(body => new { body.ArticleId, body.MarkdownContent })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        var contentMap = new Dictionary<int, string>(ids.Length);
        foreach (var row in rows)
        {
            contentMap[row.ArticleId] = row.MarkdownContent ?? string.Empty;
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
            FROM (
                SELECT DISTINCT ON (snapshot.article_id) snapshot.*
                FROM article_rights_snapshot snapshot
                WHERE snapshot.article_id IN ({idListSql})
                ORDER BY snapshot.article_id, snapshot.revision_no DESC, snapshot.created_at DESC, snapshot.id DESC
            ) rights
            LEFT JOIN LATERAL (
                SELECT proof.*
                FROM article_rights_proof proof
                WHERE proof.article_rights_snapshot_id = rights.id
                ORDER BY proof.created_at DESC, proof.id DESC
                LIMIT 1
            ) rights_proof ON TRUE;
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

        var tagRows = await db.Queryable<ArticleTag>()
            .InnerJoin<Tag>((at, t) => at.TagId == t.Id)
            .Where(at => ids.Contains(at.ArticleId))
            .Select((at, t) => new { at.ArticleId, t.Id, t.Name })
            .ToListAsync(ct)
            .ConfigureAwait(false);

        var tagMap = new Dictionary<int, List<TagReadModel>>(ids.Count);
        foreach (var row in tagRows)
        {
            if (!tagMap.TryGetValue(row.ArticleId, out var tags))
            {
                tags = [];
                tagMap[row.ArticleId] = tags;
            }

            tags.Add(new TagReadModel { Id = row.Id, Name = row.Name ?? string.Empty });
        }

        return tagMap;
    }

    private static void AttachTags(List<ArticleListItemReadModel> items, IReadOnlyDictionary<int, List<TagReadModel>> tagMap)
    {
        for (int i = 0; i < items.Count; i++)
        {
            ArticleListItemReadModel item = items[i];
            items[i] = item with { Tags = tagMap.TryGetValue(item.Id, out var tags) ? tags : [] };
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

        return EncodeFrame(AedsFrameType.CategoryList, PodBinaryCodec.EncodeCategoryList(result), version, options);
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

        return EncodeFrame(AedsFrameType.TagList, PodBinaryCodec.EncodeTagWithCountList(result), version, options);
    }

    private PublicBinaryArtifact EncodeFrame(AedsFrameType frameType, byte[] payload, long version, PublicHotReadOptions options)
        => PublicHotReadBinaryArtifactFactory.FromPayload(aeds, frameType, payload, options.CacheControl, version, options);

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
    ILogger<PublicHotReadStartupWarmupService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            store.BeginBuild("startup");
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            var projector = scope.ServiceProvider.GetRequiredService<IPublicHotArtifactProjector>();
            PublicHotReadSnapshot snapshot = await projector.BuildInitialSnapshotAsync(stoppingToken).ConfigureAwait(false);
            store.Publish(snapshot);
            logger.LogInformation("public-hot-read-snapshot-ready {Version}", snapshot.Version);
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
