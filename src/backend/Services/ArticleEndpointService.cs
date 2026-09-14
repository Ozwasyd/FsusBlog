using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services;

public sealed class ArticleEndpointService(
    IArticleCoreService core,
    IArticleMutationCommandService mutations,
    ICacheStringReader cache,
    IOwnedFrameCache ownedFrameCache,
    ICacheMissCoordinator cacheMissCoordinator,
    IArticleDetailAedsArtifactStore detailArtifacts,
    IPublicArticleProjectionStore publicArticleProjection,
    IArticleDetailAedsArtifactBackfillScheduler detailArtifactBackfill,
    IHotArticlesCacheVersionProvider hotArticlesVersionProvider,
    IArticleListCursorCodec articleListCursorCodec) : IArticleEndpointService
{
    private const int MaxPageSize = 100;
    private const int MaxGenerationBuildAttempts = 3;
    private readonly BoundedTaskSingleFlight<ArticleFrameBuildReceipt<IReadOnlyList<PopularArticleCoreModel>>> _hotFrameBuildFlights = new();
    private readonly BoundedTaskSingleFlight<ArticleFrameBuildReceipt<IReadOnlyList<FeaturedArticleSummaryDto>>> _featuredFrameBuildFlights = new();

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
        string? sort = null,
        string? cursor = null,
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

        string normalizedKeyword = NormalizeArticleListKeyword(keyword);
        bool isPublicList = ShouldBypassCoreArticleListCacheForPublicFrame(isDeleted, canReadDeleted, status, canReadPrivate);
        if (!TryResolveArticleListSort(sort, normalizedKeyword, isPublicList, out ArticleListSortMode sortMode))
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章排序参数非法"));
        }

        if ((isPublicList && ((page == 1) != (cursor is null)))
            || (!isPublicList && cursor is not null))
        {
            return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章 cursor 参数非法"));
        }

        long version = await GetArticleListCacheVersionAsync(cancellationToken);
        ArticleListCursorPosition? cursorPosition = null;
        if (cursor is not null)
        {
            if (!articleListCursorCodec.TryDecode(
                    cursor,
                    categoryId,
                    tagId,
                    normalizedKeyword,
                    size,
                    version,
                    sortMode,
                    out ArticleListCursorPosition decodedCursor))
            {
                return new(default, Result<CorePageResult<ArticleListCoreModel>>.Failure(ErrorCode.Validation, "文章 cursor 参数非法"));
            }

            cursorPosition = decodedCursor;
        }

        string identity = BuildArticleListCacheIdentity(version, page, size, categoryId, tagId, isDeleted, status, canReadPrivate, normalizedKeyword, sortMode, cursor);
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
                Result<CorePageResult<ArticleListCoreModel>> result = isPublicList
                    ? await LoadPublicArticleListFrameSourceAsync(page, size, categoryId, tagId, normalizedKeyword, sortMode, version, cursorPosition, token)
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
        await hotArticlesVersionProvider.EnsureHotArticlesVersionInitializedAsync(cancellationToken).ConfigureAwait(false);
        for (int attempt = 0; attempt < MaxGenerationBuildAttempts; attempt++)
        {
            long generation = hotArticlesVersionProvider.CurrentHotArticlesVersion;
            string identity = ArticleHotFrameIdentity.BuildHot(generation, count);
            OwnedFrameCacheReadResult initial = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleHotFrame,
                identity,
                AedsFrameType.ArticleHot,
                cancellationToken).ConfigureAwait(false);
            if (initial.Hit && initial.Lease is not null)
            {
                return new ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>(
                    initial.Lease,
                    Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"));
            }

            ArticleFrameBuildReceipt<IReadOnlyList<PopularArticleCoreModel>> receipt = await _hotFrameBuildFlights.RunAsync(
                CachePolicyId.ArticleHotFrame,
                identity,
                async buildCt =>
                {
                    ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>? coordinated = await cacheMissCoordinator.CoordinateAsync(
                        CachePolicyId.ArticleHotFrame,
                        identity,
                        async ct =>
                        {
                            if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                            {
                                return new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>>(true, ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Drifted);
                            }

                            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                                CachePolicyId.ArticleHotFrame,
                                identity,
                                AedsFrameType.ArticleHot,
                                ct);
                            return frame.Hit && frame.Lease is not null
                                ? new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>>(
                                    true,
                                    ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Completed(
                                        new ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>(
                                            frame.Lease,
                                            Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.None, "cache-hit"))))
                                : new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>>(false, default);
                        },
                        async ct =>
                        {
                            if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                            {
                                return ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Drifted;
                            }

                            FsusObservability.RecordArticleHotFrameWholeBuild("hot");
                            Result<IReadOnlyList<PopularArticleCoreModel>> result = await core.GetHotArticlesAsync(new ArticleCountQuery(count), ct);
                            if (!result.IsSuccess || result.Value is null)
                            {
                                return ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Completed(
                                    new ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>(default, result));
                            }

                            OwnedAedsFrame ownedFrame = AedsOwnedFrameBuilder.BuildOwned(
                                AedsFrameType.ArticleHot,
                                writer => PodBinaryCodec.WritePopularArticles(result.Value, writer));
                            FsusObservability.RecordArticleHotFrameBytes("hot", ownedFrame.LogicalLength);
                            OwnedAedsFrameReadLease responseLease = ownedFrame.AcquireReadLease();
                            try
                            {
                                if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                                {
                                    ownedFrame.Retire();
                                    responseLease.Dispose();
                                    return ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Drifted;
                                }

                                FsusObservability.RecordArticleHotFrameRedisPublication("hot");
                                bool published = await ownedFrameCache.TrySetOwnedFrameAsync(
                                    CachePolicyId.ArticleHotFrame,
                                    identity,
                                    ownedFrame,
                                    new OwnedFramePublicationGuard(
                                        CachePolicyId.AdminStats,
                                        IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                                        generation),
                                    l2TtlOverride: null,
                                    ct);
                                if (!published)
                                {
                                    responseLease.Dispose();
                                    return ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Drifted;
                                }

                                return ArticleFrameBuildOutcome<IReadOnlyList<PopularArticleCoreModel>>.Completed(
                                    new ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>(responseLease, result));
                            }
                            catch
                            {
                                responseLease.Dispose();
                                throw;
                            }
                        },
                        "article-hot-frame",
                        buildCt).ConfigureAwait(false);

                    if (coordinated is null)
                    {
                        return ArticleFrameBuildReceipt<IReadOnlyList<PopularArticleCoreModel>>.Completed(
                            Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.InfraFailure, "article_hot_frame_rebuild_failed"));
                    }

                    coordinated.Payload.CachedFrame?.Dispose();
                    return new ArticleFrameBuildReceipt<IReadOnlyList<PopularArticleCoreModel>>(
                        coordinated.Payload.Result,
                        coordinated.GenerationDrifted);
                },
                cancellationToken);

            if (!receipt.GenerationDrifted)
            {
                OwnedFrameCacheReadResult final = await ownedFrameCache.TryGetOwnedFrameAsync(
                    CachePolicyId.ArticleHotFrame,
                    identity,
                    AedsFrameType.ArticleHot,
                    cancellationToken).ConfigureAwait(false);
                return new ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>(final.Lease, receipt.Result);
            }

            FsusObservability.RecordArticleHotFrameGenerationRetry("hot");
        }

        return new(default, Result<IReadOnlyList<PopularArticleCoreModel>>.Failure(ErrorCode.InfraFailure, "article_hot_frame_generation_unstable"));
    }

    public async Task<ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>> GetFeaturedArticlesAsync(
        int count,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await hotArticlesVersionProvider.EnsureHotArticlesVersionInitializedAsync(cancellationToken).ConfigureAwait(false);
        for (int attempt = 0; attempt < MaxGenerationBuildAttempts; attempt++)
        {
            long generation = hotArticlesVersionProvider.CurrentHotArticlesVersion;
            string identity = ArticleHotFrameIdentity.BuildFeatured(generation, count);
            OwnedFrameCacheReadResult initial = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.TopArticlesFrame,
                identity,
                AedsFrameType.ArticleFeatured,
                cancellationToken).ConfigureAwait(false);
            if (initial.Hit && initial.Lease is not null)
            {
                return new ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>(
                    initial.Lease,
                    Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(ErrorCode.None, "cache-hit"));
            }

            ArticleFrameBuildReceipt<IReadOnlyList<FeaturedArticleSummaryDto>> receipt = await _featuredFrameBuildFlights.RunAsync(
                CachePolicyId.TopArticlesFrame,
                identity,
                async buildCt =>
                {
                    ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>? coordinated = await cacheMissCoordinator.CoordinateAsync(
                        CachePolicyId.TopArticlesFrame,
                        identity,
                        async ct =>
                        {
                            if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                            {
                                return new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>>(true, ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Drifted);
                            }

                            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                                CachePolicyId.TopArticlesFrame,
                                identity,
                                AedsFrameType.ArticleFeatured,
                                ct);
                            return frame.Hit && frame.Lease is not null
                                ? new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>>(
                                    true,
                                    ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Completed(new ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>(
                                        frame.Lease,
                                        Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(ErrorCode.None, "cache-hit"))))
                                : new CacheReadResult<ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>>(false, default);
                        },
                        async ct =>
                        {
                            if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                            {
                                return ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Drifted;
                            }

                            FsusObservability.RecordArticleHotFrameWholeBuild("featured");
                            Result<IReadOnlyList<FeaturedArticleCoreModel>> result = await core.GetFeaturedArticlesAsync(new ArticleCountQuery(count), ct);
                            if (!result.IsSuccess || result.Value is null)
                            {
                                return ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Completed(new ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>(
                                    default,
                                    Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(result.Error.Code, result.Error.Message)));
                            }

                            IReadOnlyList<FeaturedArticleSummaryDto> value = result.Value.Select(static item =>
                                new FeaturedArticleSummaryDto(
                                    item.Id,
                                    item.Title,
                                    item.CoverImageUrl,
                                    item.Views,
                                    item.CreateTime,
                                    new ArticleCategoryView(item.Category.Id, item.Category.Name))).ToArray();
                            Result<IReadOnlyList<FeaturedArticleSummaryDto>> mapped = Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Success(value);
                            OwnedAedsFrame ownedFrame = AedsOwnedFrameBuilder.BuildOwned(
                                AedsFrameType.ArticleFeatured,
                                writer => PodBinaryCodec.WriteFeaturedArticles(value, writer));
                            FsusObservability.RecordArticleHotFrameBytes("featured", ownedFrame.LogicalLength);
                            OwnedAedsFrameReadLease responseLease = ownedFrame.AcquireReadLease();
                            try
                            {
                                if (generation != hotArticlesVersionProvider.CurrentHotArticlesVersion)
                                {
                                    ownedFrame.Retire();
                                    responseLease.Dispose();
                                    return ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Drifted;
                                }

                                FsusObservability.RecordArticleHotFrameRedisPublication("featured");
                                bool published = await ownedFrameCache.TrySetOwnedFrameAsync(
                                    CachePolicyId.TopArticlesFrame,
                                    identity,
                                    ownedFrame,
                                    new OwnedFramePublicationGuard(
                                        CachePolicyId.AdminStats,
                                        IHotArticlesCacheVersionProvider.AuthorityCounterIdentity,
                                        generation),
                                    l2TtlOverride: null,
                                    ct);
                                if (!published)
                                {
                                    responseLease.Dispose();
                                    return ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Drifted;
                                }

                                return ArticleFrameBuildOutcome<IReadOnlyList<FeaturedArticleSummaryDto>>.Completed(
                                    new ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>(responseLease, mapped));
                            }
                            catch
                            {
                                responseLease.Dispose();
                                throw;
                            }
                        },
                        "article-featured-frame",
                        buildCt).ConfigureAwait(false);

                    if (coordinated is null)
                    {
                        return ArticleFrameBuildReceipt<IReadOnlyList<FeaturedArticleSummaryDto>>.Completed(
                            Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(ErrorCode.InfraFailure, "article_featured_frame_rebuild_failed"));
                    }

                    coordinated.Payload.CachedFrame?.Dispose();
                    return new ArticleFrameBuildReceipt<IReadOnlyList<FeaturedArticleSummaryDto>>(
                        coordinated.Payload.Result,
                        coordinated.GenerationDrifted);
                },
                cancellationToken);

            if (!receipt.GenerationDrifted)
            {
                OwnedFrameCacheReadResult final = await ownedFrameCache.TryGetOwnedFrameAsync(
                    CachePolicyId.TopArticlesFrame,
                    identity,
                    AedsFrameType.ArticleFeatured,
                    cancellationToken).ConfigureAwait(false);
                return new ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>(final.Lease, receipt.Result);
            }

            FsusObservability.RecordArticleHotFrameGenerationRetry("featured");
        }

        return new(default, Result<IReadOnlyList<FeaturedArticleSummaryDto>>.Failure(ErrorCode.InfraFailure, "article_featured_frame_generation_unstable"));
    }

    public Task<Result<ArticleMutationResult>> CreateAsync(
        long adminPrincipalId,
        string clientMutationId,
        string requestHash,
        ArticleWriteRequestCoreModel request,
        CancellationToken cancellationToken = default)
        => mutations.CreateAsync(
            adminPrincipalId,
            clientMutationId,
            requestHash,
            request,
            cancellationToken);

    public Task<Result<ArticleMutationResult>> UpdateAsync(
        int id,
        ArticleWriteRequestCoreModel request,
        CancellationToken cancellationToken = default)
        => mutations.UpdateAsync(id, request, cancellationToken);

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
        ArticleListSortMode sort,
        long listCacheVersion,
        ArticleListCursorPosition? cursor,
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
                UseSourceCache: false,
                Cursor: cursor,
                Sort: sort),
            cancellationToken);
    }

    private static bool ShouldBypassCoreArticleListCacheForPublicFrame(bool isDeleted, bool canReadDeleted, int? status, bool canReadPrivate)
        => !isDeleted && !canReadDeleted && status is null && !canReadPrivate;

    private static string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status, bool includePrivate, string keyword, ArticleListSortMode sort, string? cursor)
    {
        string windowIdentity = includePrivate
            ? $"page:{page}"
            : cursor is not null
                ? $"cursor:{cursor}"
                : "cursor:first";
        return $"core:v5:{(includePrivate ? "admin" : "public")}:{version}:{windowIdentity}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}:{sort}";
    }

    private static bool TryResolveArticleListSort(
        string? value,
        string normalizedKeyword,
        bool isPublicList,
        out ArticleListSortMode sort)
    {
        sort = ArticleListSortMode.Latest;
        if (!isPublicList)
        {
            return string.IsNullOrWhiteSpace(value);
        }

        string normalized = value?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalized.Length == 0)
        {
            sort = normalizedKeyword.Length == 0
                ? ArticleListSortMode.Latest
                : ArticleListSortMode.Relevance;
            return true;
        }

        sort = normalized switch
        {
            "latest" => ArticleListSortMode.Latest,
            "relevance" when normalizedKeyword.Length > 0 => ArticleListSortMode.Relevance,
            "hot" when normalizedKeyword.Length > 0 => ArticleListSortMode.Hot,
            _ => (ArticleListSortMode)byte.MaxValue
        };
        return Enum.IsDefined(sort);
    }

    private static string NormalizeArticleListKeyword(string? keyword)
        => string.IsNullOrWhiteSpace(keyword) ? string.Empty : keyword.Trim()[..Math.Min(keyword.Trim().Length, 80)];

    private sealed record ArticleFrameBuildOutcome<T>(ArticleEndpointPayload<T> Payload, bool GenerationDrifted)
    {
        internal static ArticleFrameBuildOutcome<T> Drifted { get; } = new(default, true);

        internal static ArticleFrameBuildOutcome<T> Completed(ArticleEndpointPayload<T> payload) => new(payload, false);
    }

    private sealed record ArticleFrameBuildReceipt<T>(Result<T> Result, bool GenerationDrifted)
    {
        internal static ArticleFrameBuildReceipt<T> Completed(Result<T> result) => new(result, false);
    }

}
