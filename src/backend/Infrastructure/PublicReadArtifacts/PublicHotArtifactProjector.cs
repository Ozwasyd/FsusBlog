using System.Collections.Frozen;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public interface IPublicHotArtifactProjector
{
    Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct);

    Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct);
}

public sealed class PublicHotArtifactProjector(
    ISqlSugarClient db,
    IArticleCoreService articles,
    IAedsEncoder aeds,
    ILogger<PublicHotArtifactProjector> logger) : IPublicHotArtifactProjector
{
    public Task<PublicHotReadSnapshot> RebuildAfterArticleMutationAsync(
        PublicHotReadSnapshot current,
        int articleId,
        CancellationToken ct)
        => BuildSnapshotAsync(current.HtmlArtifacts, ct);

    public Task<PublicHotReadSnapshot> BuildInitialSnapshotAsync(CancellationToken ct)
        => BuildSnapshotAsync([], ct);

    private async Task<PublicHotReadSnapshot> BuildSnapshotAsync(
        IEnumerable<KeyValuePair<string, PublicHtmlArtifact>> existingHtml,
        CancellationToken ct)
    {
        DateTime utcNow = DateTime.UtcNow;
        List<int> articleIds = await QueryPublicArticleIdsAsync(utcNow, ct).ConfigureAwait(false);
        ReadOnlyMemory<byte>[] articleFrames = await BuildArticleFramesAsync(articleIds, ct).ConfigureAwait(false);
        FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>> listFrames = await BuildListFramesAsync(utcNow, ct).ConfigureAwait(false);
        FrozenDictionary<string, PublicHtmlArtifact> html = existingHtml.ToFrozenDictionary(StringComparer.Ordinal);

        return new PublicHotReadSnapshot(
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            articleFrames,
            listFrames,
            html);
    }

    private async Task<List<int>> QueryPublicArticleIdsAsync(DateTime utcNow, CancellationToken ct)
    {
        return await db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Published
                && (article.PublishedAt == null || article.PublishedAt <= utcNow)
                && (article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow))
            .Select(article => article.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);
    }

    private async Task<ReadOnlyMemory<byte>[]> BuildArticleFramesAsync(IReadOnlyList<int> articleIds, CancellationToken ct)
    {
        if (articleIds.Count == 0)
        {
            return [];
        }

        int maxId = articleIds.Max();
        ReadOnlyMemory<byte>[] frames = new ReadOnlyMemory<byte>[maxId + 1];
        foreach (int articleId in articleIds)
        {
            ct.ThrowIfCancellationRequested();
            Result<ArticleDetailCoreModel?> detail = await articles.GetByIdAsync(articleId, includePrivate: false).ConfigureAwait(false);
            if (detail.IsFailure || detail.Value is null)
            {
                continue;
            }

            frames[articleId] = EncodeFrame(AedsFrameType.ArticleDetail, PodBinaryCodec.EncodeArticleDetail(detail.Value.Value));
        }

        return frames;
    }

    private async Task<FrozenDictionary<PublicListKey, ReadOnlyMemory<byte>>> BuildListFramesAsync(DateTime utcNow, CancellationToken ct)
    {
        var frames = new Dictionary<PublicListKey, ReadOnlyMemory<byte>>();
        int[] pages = [1];
        int[] sizes = [1, 3, 5, 10];
        int[] hotSizes = [1, 3, 5, 10];
        int[] featuredSizes = [3, 4, 10];

        foreach (int page in pages)
        {
            foreach (int size in sizes)
            {
                await AddArticlePageFrameAsync(frames, new PublicListKey(PublicListKind.Home, 0, (ushort)page, (byte)size), page, size, null, null).ConfigureAwait(false);
                await AddArticlePageFrameAsync(frames, new PublicListKey(PublicListKind.Archive, 0, (ushort)page, (byte)size), page, size, null, null).ConfigureAwait(false);
            }
        }

        List<int> categoryIds = await QueryPublicCategoryIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int categoryId in categoryIds)
        {
            foreach (int page in pages)
            {
                foreach (int size in sizes)
                {
                    await AddArticlePageFrameAsync(
                            frames,
                            new PublicListKey(PublicListKind.Category, categoryId, (ushort)page, (byte)size),
                            page,
                            size,
                            categoryId,
                            null)
                        .ConfigureAwait(false);
                }
            }
        }

        List<int> tagIds = await QueryPublicTagIdsAsync(utcNow, ct).ConfigureAwait(false);
        foreach (int tagId in tagIds)
        {
            foreach (int page in pages)
            {
                foreach (int size in sizes)
                {
                    await AddArticlePageFrameAsync(
                            frames,
                            new PublicListKey(PublicListKind.Tag, tagId, (ushort)page, (byte)size),
                            page,
                            size,
                            null,
                            tagId)
                        .ConfigureAwait(false);
                }
            }
        }

        foreach (int size in hotSizes)
        {
            await AddHotFrameAsync(frames, size).ConfigureAwait(false);
        }

        foreach (int size in featuredSizes)
        {
            await AddFeaturedFrameAsync(frames, size).ConfigureAwait(false);
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

    private async Task AddArticlePageFrameAsync(
        Dictionary<PublicListKey, ReadOnlyMemory<byte>> frames,
        PublicListKey key,
        int page,
        int size,
        int? categoryId,
        int? tagId)
    {
        Result<CorePageResult<ArticleListCoreModel>> result = await articles.GetPageListAsync(page, size, categoryId, tagId, isDeleted: false, status: null, includePrivate: false).ConfigureAwait(false);
        if (result.IsFailure)
        {
            logger.LogDebug("public-hot-list-project-skip {Kind} {TargetId} {Page} {Size} {Message}", key.Kind, key.TargetId, key.Page, key.Size, result.Error.Message);
            return;
        }

        frames[key] = EncodeFrame(AedsFrameType.ArticleList, PodBinaryCodec.EncodeArticlePage(result.Value));
    }

    private async Task AddHotFrameAsync(Dictionary<PublicListKey, ReadOnlyMemory<byte>> frames, int size)
    {
        Result<IReadOnlyList<PopularArticleCoreModel>> result = await articles.GetHotArticlesAsync(size).ConfigureAwait(false);
        if (result.IsFailure)
        {
            logger.LogDebug("public-hot-list-project-skip hot {Size} {Message}", size, result.Error.Message);
            return;
        }

        frames[new PublicListKey(PublicListKind.Hot, 0, 1, (byte)size)] =
            EncodeFrame(AedsFrameType.ArticleHot, PodBinaryCodec.EncodePopularArticles(result.Value ?? []));
    }

    private async Task AddFeaturedFrameAsync(Dictionary<PublicListKey, ReadOnlyMemory<byte>> frames, int size)
    {
        Result<IReadOnlyList<FeaturedArticleCoreModel>> result = await articles.GetFeaturedArticlesAsync(size).ConfigureAwait(false);
        if (result.IsFailure)
        {
            logger.LogDebug("public-hot-list-project-skip featured {Size} {Message}", size, result.Error.Message);
            return;
        }

        frames[new PublicListKey(PublicListKind.Featured, 0, 1, (byte)size)] =
            EncodeFrame(AedsFrameType.ArticleFeatured, PodBinaryCodec.EncodeFeaturedArticleCoreList(result.Value ?? []));
    }

    private byte[] EncodeFrame(AedsFrameType frameType, byte[] payload)
        => aeds.Encode(frameType, payload);
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
            logger.LogWarning(ex, "public-hot-read-snapshot-warmup-failed");
        }
    }
}
