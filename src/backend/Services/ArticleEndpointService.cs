using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class ArticleEndpointService(
    IArticleCoreService core,
    IArticleService articles,
    IUnifiedCache cache) : IArticleEndpointService
{
    public async Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>> GetPageListAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        bool isDeleted,
        bool canReadDeleted,
        int? status,
        bool canReadPrivate)
    {
        if (isDeleted && !canReadDeleted)
        {
            return new(null, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        if (status.HasValue && !canReadPrivate)
        {
            return new(null, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Forbidden, "权限不足"));
        }

        long version = await GetArticleListCacheVersionAsync();
        string identity = BuildArticleListCacheIdentity(version, page, size, categoryId, tagId, isDeleted, status, canReadPrivate);
        CacheReadResult<byte[]> raw = await cache.TryGetRawAsync(CachePolicyId.ArticleList, identity);
        if (raw.Hit && raw.Value is { Length: > 0 } payload)
        {
            return new(payload, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        return new(null, await core.GetPageListAsync(page, size, categoryId, tagId, isDeleted, status, canReadPrivate));
    }

    public Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(int id, bool canReadPrivate = false)
        => core.GetByIdAsync(id, canReadPrivate);

    public async Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(int count)
    {
        string identity = BuildArticleHotCacheIdentity(count);
        CacheReadResult<byte[]> raw = await cache.TryGetRawAsync(CachePolicyId.ArticleHot, identity);
        if (raw.Hit && raw.Value is { Length: > 0 } payload)
        {
            return new(payload, Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        return new(null, await core.GetHotArticlesAsync(count));
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

    private static string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate)
        => $"core:v3:{(includePrivate ? "admin" : "public")}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}";

    private static string BuildArticleHotCacheIdentity(int count)
        => $"core:v2:{count}";

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
