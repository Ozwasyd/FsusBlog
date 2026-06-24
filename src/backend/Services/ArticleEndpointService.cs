using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class ArticleEndpointService(
    IArticleCoreService core,
    IArticleService articles,
    IUnifiedCache cache,
    ICacheMissCoordinator cacheMissCoordinator,
    IAedsEncoder aeds,
    IArticleDetailAedsArtifactStore detailArtifacts,
    IArticleDetailAedsArtifactBackfillScheduler detailArtifactBackfill,
    IHotArticlesCacheVersionProvider hotArticlesVersionProvider) : IArticleEndpointService
{
    private const int MaxPageSize = 100;

    public async Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        bool canReadDeleted,
        int? status,
        bool canReadPrivate,
        string? keyword = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (page <= 0 || size <= 0 || size > MaxPageSize)
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "分页参数非法"));
        }

        if (isDeleted && !canReadDeleted)
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        if (status.HasValue && !canReadPrivate)
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        long version = await GetArticleListCacheVersionAsync(cancellationToken);
        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        string identity = BuildArticleListCacheIdentity(version, page, size, categoryId, tagId, isDeleted, status, canReadPrivate, normalizedKeyword);
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>? coordinated = await cacheMissCoordinator.CoordinateAsync(
            CachePolicyId.ArticleListFrame,
            identity,
            async token =>
            {
                CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleListFrame, identity, token);
                return frame.Hit && frame.Value.Length > 0
                    ? new CacheReadResult<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>>(
                        true,
                        new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(
                            frame.Value,
                            Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.None, "cache-hit")))
                    : new CacheReadResult<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>>(false, default);
            },
            async token =>
            {
                token.ThrowIfCancellationRequested();
                Result<CorePageResult<ArticleListCoreModel>> result = await core.GetPageListAsync(
                    page,
                    size,
                    categoryId,
                    tagId,
                    isDeleted,
                    status,
                    canReadPrivate,
                    normalizedKeyword,
                    version,
                    token);
                if (!result.IsSuccess)
                {
                    return new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(default, result);
                }

                token.ThrowIfCancellationRequested();
                byte[] payload = PodBinaryCodec.EncodeArticlePage(result.Value);
                byte[] encodedFrame = aeds.Encode(AedsFrameType.ArticleList, payload);
                token.ThrowIfCancellationRequested();
                await cache.SetRawAsync(CachePolicyId.ArticleListFrame, identity, encodedFrame, TimeSpan.FromMinutes(10), token);
                return new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(encodedFrame, result);
            },
            "article-list-frame",
            cancellationToken);

        return coordinated ?? new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.InfraFailure, "article_list_frame_rebuild_failed"));
    }

    public Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(
        int id,
        bool canReadPrivate = false,
        CancellationToken cancellationToken = default)
        => core.GetByIdAsync(id, canReadPrivate, cancellationToken);

    public async Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync(
        int id,
        CancellationToken cancellationToken = default)
    {
        var artifact = await detailArtifacts.TryReadAsync(id, cancellationToken);
        if (artifact.Found)
        {
            return new ArticleDetailArtifactPayload(artifact.Frame, BackfillQueued: false);
        }

        bool queued = detailArtifactBackfill.TrySchedule(id);
        return new ArticleDetailArtifactPayload(default, queued);
    }

    public async Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = BuildArticleHotCacheIdentity(count);
        CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleHotFrame, identity, cancellationToken);
        if (frame.Hit && frame.Value.Length > 0)
        {
            return new(frame.Value, Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        cancellationToken.ThrowIfCancellationRequested();
        Result<IReadOnlyList<PopularArticleCoreModel>> result = await core.GetHotArticlesAsync(count, cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return new(default, result);
        }

        cancellationToken.ThrowIfCancellationRequested();
        byte[] payload = PodBinaryCodec.EncodePopularArticles(result.Value);
        byte[] encodedFrame = aeds.Encode(AedsFrameType.ArticleHot, payload);
        cancellationToken.ThrowIfCancellationRequested();
        await cache.SetRawAsync(CachePolicyId.ArticleHotFrame, identity, encodedFrame, TimeSpan.FromMinutes(10), cancellationToken);
        return new(encodedFrame, result);
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<FeaturedArticleSummaryDto> featured = await articles.GetFeaturedArticlesAsync(count, cancellationToken);
        return Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Success(featured);
    }

    public Task<int> CreateAsync(ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.CreateAsync(ToCreateRequest(request), cancellationToken);
    }

    public Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.UpdateAsync(id, ToUpdateRequest(request), cancellationToken);
    }

    public Task<int> ClearTrashAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.ClearTrashAsync(cancellationToken);
    }

    public Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.DeleteAsync(id, cancellationToken);
    }

    public Task<bool> RestoreAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.RestoreAsync(id, cancellationToken);
    }

    public Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return articles.PermanentlyDeleteArticleAsync(id, cancellationToken);
    }

    private async ValueTask<long> GetArticleListCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private static string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword)
        => $"core:v4:{(includePrivate ? "admin" : "public")}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}";

    private static string NormalizeArticleListKeyword(string? keyword)
        => string.IsNullOrWhiteSpace(keyword) ? string.Empty : keyword.Trim()[..Math.Min(keyword.Trim().Length, 80)];

    private string BuildArticleHotCacheIdentity(int count)
        => hotArticlesVersionProvider.BuildVersionedHotArticlesIdentity($"core:v2:{count}");

    private static CreateArticleRequest ToCreateRequest(ArticleWriteRequestCoreModel request)
        => new()
        {
            Title = request.Title,
            Content = request.Content,
            Summary = request.Summary,
            CoverImageUrl = request.CoverImageUrl,
            CategoryId = request.CategoryId,
            TagIds = CopyTagIds(request.TagIds),
            Status = ToArticleStatus(request.Status),
            ScheduledPublishAt = request.ScheduledPublishAt
        };

    private static UpdateArticleRequest ToUpdateRequest(ArticleWriteRequestCoreModel request)
        => new()
        {
            Title = request.Title,
            Content = request.Content,
            Summary = request.Summary,
            CoverImageUrl = request.CoverImageUrl,
            CategoryId = request.CategoryId,
            TagIds = CopyTagIds(request.TagIds),
            Status = ToArticleStatus(request.Status),
            ScheduledPublishAt = request.ScheduledPublishAt
        };

    private static ArticleStatus ToArticleStatus(int status)
        => ArticleStatusProjection.Normalize(status);

    private static List<int>? CopyTagIds(IReadOnlyList<int> tagIds)
    {
        if (tagIds.Count == 0)
        {
            return null;
        }

        var copy = new List<int>(tagIds.Count);
        for (int i = 0; i < tagIds.Count; i++)
        {
            copy.Add(tagIds[i]);
        }

        return copy;
    }
}
