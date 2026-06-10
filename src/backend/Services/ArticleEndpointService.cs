using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class ArticleEndpointService(
    IArticleCoreService core,
    IArticleService articles,
    IUnifiedCache cache,
    IAedsEncoder aeds,
    IArticleDetailAedsArtifactStore detailArtifacts,
    IArticleDetailAedsArtifactBackfillScheduler detailArtifactBackfill,
    IHotArticlesCacheVersionProvider hotArticlesVersionProvider) : IArticleEndpointService
{
    public async Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        bool canReadDeleted,
        int? status,
        bool canReadPrivate,
        string? keyword = null)
    {
        if (isDeleted && !canReadDeleted)
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        if (status.HasValue && !canReadPrivate)
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        long version = await GetArticleListCacheVersionAsync();
        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        string identity = BuildArticleListCacheIdentity(version, page, size, categoryId, tagId, isDeleted, status, canReadPrivate, normalizedKeyword);
        CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleListFrame, identity);
        if (frame.Hit && frame.Value.Length > 0)
        {
            return new(frame.Value, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        Result<CorePageResult<ArticleListCoreModel>> result = await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, canReadPrivate, normalizedKeyword, version);
        if (!result.IsSuccess)
        {
            return new(default, result);
        }

        byte[] payload = PodBinaryCodec.EncodeArticlePage(result.Value);
        byte[] encodedFrame = aeds.Encode(AedsFrameType.ArticleList, payload);
        await cache.SetRawAsync(CachePolicyId.ArticleListFrame, identity, encodedFrame, TimeSpan.FromMinutes(10));
        return new(encodedFrame, result);
    }

    public Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool canReadPrivate = false)
        => core.GetByIdAsync(id, canReadPrivate);

    public async Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync(int id)
    {
        var artifact = await detailArtifacts.TryReadAsync(id);
        if (artifact.Found)
        {
            return new ArticleDetailArtifactPayload(artifact.Frame, BackfillQueued: false);
        }

        bool queued = detailArtifactBackfill.TrySchedule(id);
        return new ArticleDetailArtifactPayload(default, queued);
    }

    public async Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count)
    {
        string identity = BuildArticleHotCacheIdentity(count);
        CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleHotFrame, identity);
        if (frame.Hit && frame.Value.Length > 0)
        {
            return new(frame.Value, Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        Result<IReadOnlyList<PopularArticleCoreModel>> result = await core.GetHotArticlesAsync(count);
        if (!result.IsSuccess || result.Value is null)
        {
            return new(default, result);
        }

        byte[] payload = PodBinaryCodec.EncodePopularArticles(result.Value);
        byte[] encodedFrame = aeds.Encode(AedsFrameType.ArticleHot, payload);
        await cache.SetRawAsync(CachePolicyId.ArticleHotFrame, identity, encodedFrame, TimeSpan.FromMinutes(10));
        return new(encodedFrame, result);
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(int count)
    {
        List<FeaturedArticleSummaryDto> featured = await articles.GetFeaturedArticlesAsync(count);
        return Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Success(featured);
    }

    public Task<int> CreateAsync(ArticleWriteRequestCoreModel request)
        => articles.CreateAsync(ToCreateRequest(request));

    public Task<bool> UpdateAsync(int id, ArticleWriteRequestCoreModel request)
        => articles.UpdateAsync(id, ToUpdateRequest(request));

    public Task<int> ClearTrashAsync()
        => articles.ClearTrashAsync();

    public Task<bool> DeleteAsync(int id)
        => articles.DeleteAsync(id);

    public Task<bool> RestoreAsync(int id)
        => articles.RestoreAsync(id);

    public Task<bool> PermanentlyDeleteArticleAsync(int id)
        => articles.PermanentlyDeleteArticleAsync(id);

    private async ValueTask<long> GetArticleListCacheVersionAsync()
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main");
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
            TagIds = [.. request.TagIds],
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
            TagIds = [.. request.TagIds],
            Status = ToArticleStatus(request.Status),
            ScheduledPublishAt = request.ScheduledPublishAt
        };

    private static ArticleStatus ToArticleStatus(int status)
        => Enum.IsDefined(typeof(ArticleStatus), status) ? (ArticleStatus)status : ArticleStatus.Published;
}
