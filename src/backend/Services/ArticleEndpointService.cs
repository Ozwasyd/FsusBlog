using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class ArticleEndpointService(
    IArticleCoreService core,
    ICacheStringReader cache,
    IOwnedFrameCache ownedFrameCache,
    ICacheMissCoordinator cacheMissCoordinator,
    IArticleDetailAedsArtifactStore detailArtifacts,
    IPublicArticleProjectionStore publicArticleProjection,
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
                OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                    CachePolicyId.ArticleListFrame,
                    identity,
                    AedsFrameType.ArticleList,
                    token);
                return frame.Hit && frame.Lease is not null
                    ? new CacheReadResult<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>>(
                        true,
                        new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(
                            frame.Lease,
                            Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.None, "cache-hit")))
                    : new CacheReadResult<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>>(false, default);
            },
            async token =>
            {
                token.ThrowIfCancellationRequested();
                Result<CorePageResult<ArticleListCoreModel>> result = ShouldBypassCoreArticleListCacheForPublicFrame(isDeleted, canReadDeleted, status, canReadPrivate)
                    ? await LoadPublicArticleListFrameSourceAsync(page, size, categoryId, tagId, normalizedKeyword, version, token)
                    : await core.GetPageListAsync(
                        new ArticlePageQuery(page, size, categoryId, tagId, isDeleted, status, canReadPrivate, normalizedKeyword, version),
                        token);
                if (!result.IsSuccess)
                {
                    return new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(default, result);
                }

                token.ThrowIfCancellationRequested();
                OwnedAedsFrame ownedFrame = AedsOwnedFrameBuilder.BuildOwned(
                    AedsFrameType.ArticleList,
                    writer => PodBinaryCodec.WriteArticlePage(result.Value, writer));
                OwnedAedsFrameReadLease responseLease = ownedFrame.AcquireReadLease();
                try
                {
                    token.ThrowIfCancellationRequested();
                    await ownedFrameCache.SetOwnedFrameAsync(
                        CachePolicyId.ArticleListFrame,
                        identity,
                        ownedFrame,
                        TimeSpan.FromMinutes(10),
                        token);
                    return new ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>(responseLease, result);
                }
                catch
                {
                    responseLease.Dispose();
                    throw;
                }
            },
            "article-list-frame",
            cancellationToken);

        return coordinated ?? new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.InfraFailure, "article_list_frame_rebuild_failed"));
    }

    public Task<Result<ArticleDetailCoreModel?>> GetByIdAsync(
        int id,
        bool canReadPrivate = false,
        CancellationToken cancellationToken = default)
        => core.GetByIdAsync(new ArticleDetailQuery(id, canReadPrivate), cancellationToken);

    public async Task<ArticleDetailArtifactPayload> GetPublicArtifactBackedDetailAsync(
        int id,
        CancellationToken cancellationToken = default)
    {
        var artifact = await detailArtifacts.TryReadAsync(id, cancellationToken);
        if (artifact.Found)
        {
            return new ArticleDetailArtifactPayload(artifact.Frame, BackfillQueued: false);
        }

        PublicArticleProjectionReadResult projection = await publicArticleProjection.TryReadAsync(id, cancellationToken);
        if (projection.Found)
        {
            await detailArtifacts.WriteAsync(id, projection.Frame, cancellationToken);
            return new ArticleDetailArtifactPayload(projection.Frame, BackfillQueued: false);
        }

        bool queued = projection.Status is PublicArticleProjectionReadStatus.NotFound or PublicArticleProjectionReadStatus.Invalid
            && detailArtifactBackfill.TrySchedule(id);
        return new ArticleDetailArtifactPayload(default, queued);
    }

    public async Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>> GetHotArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string identity = BuildArticleHotCacheIdentity(count);
        OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleHotFrame,
            identity,
            AedsFrameType.ArticleHot,
            cancellationToken);
        if (frame.Hit && frame.Lease is not null)
        {
            return new(frame.Lease, Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
        }

        cancellationToken.ThrowIfCancellationRequested();
        Result<IReadOnlyList<PopularArticleCoreModel>> result = await core.GetHotArticlesAsync(new ArticleCountQuery(count), cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return new(default, result);
        }

        cancellationToken.ThrowIfCancellationRequested();
        OwnedAedsFrame ownedFrame = AedsOwnedFrameBuilder.BuildOwned(
            AedsFrameType.ArticleHot,
            writer => PodBinaryCodec.WritePopularArticles(result.Value, writer));
        OwnedAedsFrameReadLease responseLease = ownedFrame.AcquireReadLease();
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            await ownedFrameCache.SetOwnedFrameAsync(
                CachePolicyId.ArticleHotFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(10),
                cancellationToken);
            return new(responseLease, result);
        }
        catch
        {
            responseLease.Dispose();
            throw;
        }
    }

    public async Task<Result<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result<IReadOnlyList<FeaturedArticleCoreModel>> result = await core.GetFeaturedArticlesAsync(new ArticleCountQuery(count), cancellationToken);
        if (!result.IsSuccess || result.Value is null)
        {
            return Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(result.Error.Code, result.Error.Message);
        }

        return Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Success(result.Value.Select(static item =>
            new FeaturedArticleSummaryDto(
                item.Id,
                item.Title,
                item.CoverImageUrl,
                item.Views,
                item.CreateTime,
                new ArticleCategoryView(item.Category.Id, item.Category.Name))).ToArray());
    }

    public async Task<Result<ArticleMutationResponseDto>> CreateAsync(ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result<int> result = await core.CreateAsync(new CreateArticleCommand(request), cancellationToken);
        return !result.IsSuccess
            ? Result<ArticleMutationResponseDto>.Failure(result.Error)
            : await LoadArticleMutationResponseAsync(result.Value, cancellationToken);
    }

    public async Task<Result<ArticleMutationResponseDto>> UpdateAsync(int id, ArticleWriteRequestCoreModel request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result result = await core.UpdateAsync(new UpdateArticleCommand(id, request), cancellationToken);
        return !result.IsSuccess
            ? Result<ArticleMutationResponseDto>.Failure(result.Error)
            : await LoadArticleMutationResponseAsync(id, cancellationToken);
    }

    private async Task<Result<ArticleMutationResponseDto>> LoadArticleMutationResponseAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        Result<ArticleDetailCoreModel?> detail = await core.GetByIdAsync(
            new ArticleDetailQuery(articleId, IncludePrivate: true),
            cancellationToken);
        if (!detail.IsSuccess || detail.Value is null)
        {
            return Result<ArticleMutationResponseDto>.Failure(
                ErrorCode.InfraFailure,
                "article_mutation_version_unavailable");
        }

        ArticleDetailCoreModel article = detail.Value.Value;
        return Result<ArticleMutationResponseDto>.Success(new ArticleMutationResponseDto(
            articleId,
            article.Rights.SnapshotId,
            article.Rights.RevisionNo));
    }

    public async Task<int> ClearTrashAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Result<int> result = await core.ClearTrashAsync(cancellationToken);
        return result.IsSuccess ? result.Value : 0;
    }

    public async Task<bool> DeleteAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return (await core.DeleteAsync(new ArticleIdCommand(id), cancellationToken)).IsSuccess;
    }

    public Task<Result> RestoreAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return core.RestoreAsync(new ArticleIdCommand(id), cancellationToken);
    }

    public async Task<bool> PermanentlyDeleteArticleAsync(int id, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return (await core.PermanentlyDeleteArticleAsync(new ArticleIdCommand(id), cancellationToken)).IsSuccess;
    }

    private async ValueTask<long> GetArticleListCacheVersionAsync(CancellationToken cancellationToken)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken);
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    private async Task<Result<CorePageResult<ArticleListCoreModel>>> LoadPublicArticleListFrameSourceAsync(
        int page,
        int size,
        int? categoryId,
        int? tagId,
        string keyword,
        long listCacheVersion,
        CancellationToken cancellationToken)
    {
        return await core.GetPageListAsync(
            new ArticlePageQuery(
                page,
                size,
                categoryId,
                tagId,
                IsDeleted: false,
                Status: null,
                IncludePrivate: false,
                keyword,
                ListCacheVersion: listCacheVersion,
                UseSourceCache: false),
            cancellationToken);
    }

    private static bool ShouldBypassCoreArticleListCacheForPublicFrame(bool isDeleted, bool canReadDeleted, int? status, bool canReadPrivate)
        => !isDeleted && !canReadDeleted && status is null && !canReadPrivate;

    private static string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword)
        => $"core:v4:{(includePrivate ? "admin" : "public")}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}";

    private static string NormalizeArticleListKeyword(string? keyword)
        => string.IsNullOrWhiteSpace(keyword) ? string.Empty : keyword.Trim()[..Math.Min(keyword.Trim().Length, 80)];

    private string BuildArticleHotCacheIdentity(int count)
        => hotArticlesVersionProvider.BuildVersionedHotArticlesIdentity($"core:v2:{count}");

}
