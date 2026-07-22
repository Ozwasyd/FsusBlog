using System.Collections.Concurrent;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArticleEndpointServiceTests
{
    private static readonly TimeSpan s_concurrentColdFrameWaitTimeout = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task GetPublicArtifactBackedDetailAsync_Hit_ReturnsFrameWithoutCoreQuery()
    {
        var core = Substitute.For<IArticleCoreService>();
        var artifacts = Substitute.For<IArticleDetailAedsArtifactStore>();
        var scheduler = Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>();
        byte[] frame = [0x41, 0x45, 0x44, 0x53];
        artifacts.TryReadAsync(42, Arg.Any<CancellationToken>())
            .Returns(new ArticleDetailAedsArtifact(frame));
        var service = Create(core, artifacts, scheduler);

        ArticleDetailArtifactPayload result = await service.GetPublicArtifactBackedDetailAsync(42);

        Assert.True(result.HasPreencodedFrame);
        Assert.Equal(frame, result.PreencodedFrame.ToArray());
        await core.DidNotReceiveWithAnyArgs().GetByIdAsync(default);
        scheduler.DidNotReceiveWithAnyArgs().TrySchedule(default);
    }

    [Fact]
    public async Task GetPageListAsync_WhenCancelledBeforeCall_DoesNotTouchCacheOrCore()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetPageListAsync(
            1,
            10,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: true,
            status: null,
            canReadPrivate: true,
            cancellationToken: cts.Token));

        await cache.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
        await cache.DidNotReceiveWithAnyArgs().TryGetRawReadonlyAsync(default, (string)null!, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(1, 999999)]
    public async Task GetPageListAsync_InvalidPagination_ReturnsValidationFailureWithoutCacheOrCore(int page, int size)
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);

        var result = await service.GetPageListAsync(
            page,
            size,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: true,
            status: null,
            canReadPrivate: true);

        Assert.False(result.Result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Result.Error.Code);
        await cache.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
        await cache.DidNotReceiveWithAnyArgs().TryGetRawReadonlyAsync(default, (string)null!, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public async Task GetPageListAsync_WhenCancelledAfterCoreLoad_SkipsFrameCacheSet()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);
        using var cts = new CancellationTokenSource();
        var page = new CorePageResult<ArticleListCoreModel>([], 0);

        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns("7");
        ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleListFrame,
                Arg.Any<string>(),
                AedsFrameType.ArticleList,
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        core.GetPageListAsync(
                Arg.Any<ArticlePageQuery>(),
                Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                cts.Cancel();
                return Task.FromResult(Result<CorePageResult<ArticleListCoreModel>>.Success(page));
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.GetPageListAsync(
            1,
            10,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: true,
            status: null,
            canReadPrivate: true,
            cancellationToken: cts.Token));

        await ownedFrameCache.DidNotReceiveWithAnyArgs().SetOwnedFrameAsync(
            default,
            (string)null!,
            default!,
            default,
            default);
    }

    [Fact]
    public async Task GetPageListAsync_ConcurrentColdFrameMiss_CoalescesCoreLoadAndCacheSet()
    {
        const int Callers = 16;
        var core = Substitute.For<IArticleCoreService>();
        var cache = new CoordinatedArticleFrameCache(Callers);
        var service = Create(
            core,
            cache: cache,
            ownedFrameCache: cache,
            cacheMissCoordinator: new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance));
        var releaseCore = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstCoreLoadStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var page = new CorePageResult<ArticleListCoreModel>([], 0);
        int coreLoads = 0;

        core.GetPageListAsync(
                Arg.Any<ArticlePageQuery>(),
                Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref coreLoads) == 1)
                {
                    firstCoreLoadStarted.SetResult(true);
                }

                await releaseCore.Task;
                return Result<CorePageResult<ArticleListCoreModel>>.Success(page);
            });

        Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>>[] tasks = Enumerable.Range(0, Callers)
            .Select(_ => service.GetPageListAsync(
                1,
                10,
                categoryId: null,
                tagId: null,
                isDeleted: false,
                canReadDeleted: true,
                status: null,
                canReadPrivate: true))
            .ToArray();

        await cache.InitialColdReadsCompleted.WaitAsync(s_concurrentColdFrameWaitTimeout);
        await firstCoreLoadStarted.Task.WaitAsync(s_concurrentColdFrameWaitTimeout);
        releaseCore.SetResult(true);
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>[] results = await Task.WhenAll(tasks).WaitAsync(s_concurrentColdFrameWaitTimeout);

        Assert.All(results, result => Assert.True(result.HasCachedFrame));
        Assert.Equal(1, Volatile.Read(ref coreLoads));
        Assert.Equal(1, cache.OwnedSetCount);
        foreach (ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result in results)
        {
            result.CachedFrame!.Dispose();
        }
        cache.Dispose();
    }

    [Fact]
    public async Task GetPageListAsync_PublicFrameMiss_UsesUncachedCoreQuery()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);
        var page = new CorePageResult<ArticleListCoreModel>([], 0, "next", true);

        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns("9");
        ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleListFrame,
                Arg.Any<string>(),
                AedsFrameType.ArticleList,
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        core.GetPageListAsync(
                Arg.Is<ArticlePageQuery>(query => !query.UseSourceCache && query.Keyword == "fsus"),
                Arg.Any<CancellationToken>())
            .Returns(Result<CorePageResult<ArticleListCoreModel>>.Success(page));

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result = await service.GetPageListAsync(
            1,
            10,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            keyword: "  fsus  ");

        Assert.True(result.Result.IsSuccess);
        Assert.True(result.HasCachedFrame);
        Assert.Equal("next", result.Result.Value.NextCursor);
        Assert.True(result.Result.Value.HasMore);
        await core.Received(1).GetPageListAsync(
            Arg.Is<ArticlePageQuery>(query =>
                query.Page == 1
                && query.Size == 10
                && query.Keyword == "fsus"
                && query.ListCacheVersion == 9
                && !query.UseSourceCache),
            Arg.Any<CancellationToken>());
        await ownedFrameCache.Received(1).SetOwnedFrameAsync(
            CachePolicyId.ArticleListFrame,
            Arg.Any<string>(),
            Arg.Any<OwnedAedsFrame>(),
            TimeSpan.FromMinutes(10),
            Arg.Any<CancellationToken>());
        result.CachedFrame!.Dispose();
    }

    [Fact]
    public async Task GetPageListAsync_PublicCursor_ValidatesFilterAndUsesCursorCacheIdentity()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);
        var position = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42);
        string cursor = ArticleListCursorCodec.Encode(position, categoryId: 7, tagId: null, normalizedKeyword: string.Empty);
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>()).Returns("11");
        ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.ArticleListFrame,
                Arg.Any<string>(),
                AedsFrameType.ArticleList,
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        core.GetPageListAsync(Arg.Any<ArticlePageQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<CorePageResult<ArticleListCoreModel>>.Success(new CorePageResult<ArticleListCoreModel>([], 0)));

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result = await service.GetPageListAsync(
            2,
            10,
            categoryId: 7,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            cursor: cursor);

        Assert.True(result.Result.IsSuccess);
        await core.Received(1).GetPageListAsync(
            Arg.Is<ArticlePageQuery>(query => query.Cursor == position && !query.UseSourceCache),
            Arg.Any<CancellationToken>());
        await ownedFrameCache.Received().TryGetOwnedFrameAsync(
            CachePolicyId.ArticleListFrame,
            Arg.Is<string>(identity => identity.Contains($":cursor:{cursor}:", StringComparison.Ordinal)),
            AedsFrameType.ArticleList,
            Arg.Any<CancellationToken>());
        result.CachedFrame!.Dispose();
    }

    [Fact]
    public async Task GetPageListAsync_InvalidOrCrossFilterCursor_FailsBeforeCacheAndCore()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);
        string cursor = ArticleListCursorCodec.Encode(
            new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42),
            categoryId: 7,
            tagId: null,
            normalizedKeyword: string.Empty);
        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>()).Returns("11");

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result = await service.GetPageListAsync(
            2,
            10,
            categoryId: 8,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false,
            cursor: cursor);

        Assert.False(result.Result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Result.Error.Code);
        await cache.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
        await ownedFrameCache.DidNotReceiveWithAnyArgs().TryGetOwnedFrameAsync(default, (string)null!, default, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public async Task GetPublicArtifactBackedDetailAsync_Miss_QueuesBackfillWithoutCoreQuery()
    {
        var core = Substitute.For<IArticleCoreService>();
        var artifacts = Substitute.For<IArticleDetailAedsArtifactStore>();
        var scheduler = Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>();
        artifacts.TryReadAsync(42, Arg.Any<CancellationToken>())
            .Returns(default(ArticleDetailAedsArtifact));
        scheduler.TrySchedule(42).Returns(true);
        var service = Create(core, artifacts, scheduler);

        ArticleDetailArtifactPayload result = await service.GetPublicArtifactBackedDetailAsync(42);

        Assert.False(result.HasPreencodedFrame);
        Assert.True(result.BackfillQueued);
        await core.DidNotReceiveWithAnyArgs().GetByIdAsync(default);
        scheduler.Received(1).TrySchedule(42);
    }

    [Fact]
    public async Task GetPublicArtifactBackedDetailAsync_Miss_QueuesBackfillIndependentOfRequestToken()
    {
        var core = Substitute.For<IArticleCoreService>();
        var artifacts = Substitute.For<IArticleDetailAedsArtifactStore>();
        var scheduler = Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>();
        using var cts = new CancellationTokenSource();
        artifacts.TryReadAsync(42, cts.Token)
            .Returns(_ =>
            {
                cts.Cancel();
                return default(ArticleDetailAedsArtifact);
            });
        scheduler.TrySchedule(42).Returns(true);
        var service = Create(core, artifacts, scheduler);

        ArticleDetailArtifactPayload result = await service.GetPublicArtifactBackedDetailAsync(42, cts.Token);

        Assert.False(result.HasPreencodedFrame);
        Assert.True(result.BackfillQueued);
        await artifacts.Received(1).TryReadAsync(42, cts.Token);
        scheduler.Received(1).TrySchedule(42);
    }

    [Fact]
    public async Task GetPublicArtifactBackedDetailAsync_FileMiss_UsesBinaryProjectionAndWarmsArtifactOnce()
    {
        var core = Substitute.For<IArticleCoreService>();
        var artifacts = Substitute.For<IArticleDetailAedsArtifactStore>();
        var projection = Substitute.For<IPublicArticleProjectionStore>();
        var scheduler = Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>();
        byte[] frame = [1, 2, 3, 4];
        artifacts.TryReadAsync(42, Arg.Any<CancellationToken>()).Returns(default(ArticleDetailAedsArtifact));
        projection.TryReadAsync(42, Arg.Any<CancellationToken>()).Returns(
            new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.Found,
                7,
                frame,
                "\"etag\"",
                DateTimeOffset.UtcNow));
        var service = Create(core, artifacts, scheduler, projection: projection);

        ArticleDetailArtifactPayload result = await service.GetPublicArtifactBackedDetailAsync(42);

        Assert.True(result.HasPreencodedFrame);
        Assert.Equal(frame, result.PreencodedFrame.ToArray());
        Assert.False(result.BackfillQueued);
        await artifacts.Received(1).WriteAsync(42, Arg.Is<ReadOnlyMemory<byte>>(value => value.ToArray().SequenceEqual(frame)), Arg.Any<CancellationToken>());
        scheduler.DidNotReceiveWithAnyArgs().TrySchedule(default);
        await core.DidNotReceiveWithAnyArgs().GetByIdAsync(default);
    }

    [Fact]
    public async Task GetPublicArtifactBackedDetailAsync_CutoverDisabled_FallsBackWithoutRepairStorm()
    {
        var core = Substitute.For<IArticleCoreService>();
        var artifacts = Substitute.For<IArticleDetailAedsArtifactStore>();
        var projection = Substitute.For<IPublicArticleProjectionStore>();
        var scheduler = Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>();
        projection.TryReadAsync(42, Arg.Any<CancellationToken>()).Returns(
            new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.Unavailable,
                0,
                default,
                null,
                null,
                "cutover-disabled"));
        var service = Create(core, artifacts, scheduler, projection: projection);

        ArticleDetailArtifactPayload result = await service.GetPublicArtifactBackedDetailAsync(42);

        Assert.False(result.HasPreencodedFrame);
        Assert.False(result.BackfillQueued);
        scheduler.DidNotReceiveWithAnyArgs().TrySchedule(default);
    }

    [Fact]
    public async Task CreateAsync_PreservesLifecycleValidationDetails()
    {
        var core = Substitute.For<IArticleCoreService>();
        var mutations = Substitute.For<IArticleMutationCommandService>();
        ErrorDetail error = ErrorDetail.Create(
            ErrorCode.Validation,
            "文章状态未定义",
            ArticleStatusTransitionErrorCodes.UndefinedStatus);
        mutations.CreateAsync(Arg.Any<long>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ArticleWriteRequestCoreModel>(), Arg.Any<CancellationToken>())
            .Returns(Result<ArticleMutationResult>.Failure(error));
        var service = Create(core, mutations: mutations);

        Result<ArticleMutationResult> result = await service.CreateAsync(7, Guid.NewGuid().ToString("D"), new string('A', 64), default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ArticleStatusTransitionErrorCodes.UndefinedStatus, result.Error.Details);
    }

    [Fact]
    public async Task CreateAsync_ReturnsBoundRightsSnapshotCoordinates()
    {
        var core = Substitute.For<IArticleCoreService>();
        var mutations = Substitute.For<IArticleMutationCommandService>();
        mutations.CreateAsync(Arg.Any<long>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ArticleWriteRequestCoreModel>(), Arg.Any<CancellationToken>())
            .Returns(Result<ArticleMutationResult>.Success(new(42, 81, 2, 91, 1, 1, 9001, 3, false, 0)));
        var service = Create(core, mutations: mutations);

        Result<ArticleMutationResult> result = await service.CreateAsync(7, Guid.NewGuid().ToString("D"), new string('A', 64), default);

        Assert.True(result.IsSuccess);
        Assert.Equal(42, result.Value.ArticleId);
        Assert.Equal(9001, result.Value.RightsSnapshotId);
        Assert.Equal(3, result.Value.RightsRevisionNo);
    }

    [Fact]
    public async Task UpdateAsync_PreservesLifecycleValidationDetails()
    {
        var core = Substitute.For<IArticleCoreService>();
        var mutations = Substitute.For<IArticleMutationCommandService>();
        ErrorDetail error = ErrorDetail.Create(
            ErrorCode.Validation,
            "计划发布时间必须晚于当前时间",
            ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture);
        mutations.UpdateAsync(Arg.Any<int>(), Arg.Any<ArticleWriteRequestCoreModel>(), Arg.Any<CancellationToken>())
            .Returns(Result<ArticleMutationResult>.Failure(error));
        var service = Create(core, mutations: mutations);

        Result<ArticleMutationResult> result = await service.UpdateAsync(42, default);

        Assert.False(result.IsSuccess);
        Assert.Equal(ArticleStatusTransitionErrorCodes.ScheduledAtMustBeFuture, result.Error.Details);
    }

    [Fact]
    public async Task UpdateAsync_ReturnsBoundRightsSnapshotCoordinates()
    {
        var core = Substitute.For<IArticleCoreService>();
        var mutations = Substitute.For<IArticleMutationCommandService>();
        mutations.UpdateAsync(Arg.Any<int>(), Arg.Any<ArticleWriteRequestCoreModel>(), Arg.Any<CancellationToken>())
            .Returns(Result<ArticleMutationResult>.Success(new(42, 82, 3, 92, 2, 1, 9002, 4, false, 0)));
        var service = Create(core, mutations: mutations);

        Result<ArticleMutationResult> result = await service.UpdateAsync(42, default);

        Assert.True(result.IsSuccess);
        Assert.Equal(42, result.Value.ArticleId);
        Assert.Equal(9002, result.Value.RightsSnapshotId);
        Assert.Equal(4, result.Value.RightsRevisionNo);
    }

    private static ArticleEndpointService Create(
        IArticleCoreService core,
        IArticleDetailAedsArtifactStore? artifacts = null,
        IArticleDetailAedsArtifactBackfillScheduler? scheduler = null,
        IUnifiedCache? cache = null,
        IOwnedFrameCache? ownedFrameCache = null,
        ICacheMissCoordinator? cacheMissCoordinator = null,
        IPublicArticleProjectionStore? projection = null,
        IArticleMutationCommandService? mutations = null)
    {
        cache ??= Substitute.For<IUnifiedCache>();
        ownedFrameCache ??= CreateOwnedFrameCacheSubstitute();
        var hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
        hotVersion.BuildVersionedHotArticlesIdentity(Arg.Any<string>())
            .Returns(call => $"v1:{call.Arg<string>()}");

        return new ArticleEndpointService(
            core,
            mutations ?? Substitute.For<IArticleMutationCommandService>(),
            cache,
            ownedFrameCache,
            cacheMissCoordinator ?? new PassthroughCacheMissCoordinator(),
            artifacts ?? Substitute.For<IArticleDetailAedsArtifactStore>(),
            projection ?? Substitute.For<IPublicArticleProjectionStore>(),
            scheduler ?? Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            hotVersion);
    }

    private static IOwnedFrameCache CreateOwnedFrameCacheSubstitute()
    {
        var cache = Substitute.For<IOwnedFrameCache>();
        cache.TryGetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<AedsFrameType>(),
                Arg.Any<CancellationToken>())
            .Returns(default(OwnedFrameCacheReadResult));
        cache.SetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<OwnedAedsFrame>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                call.Arg<OwnedAedsFrame>().Retire();
                return Task.CompletedTask;
            });
        return cache;
    }

    private sealed class PassthroughCacheMissCoordinator : ICacheMissCoordinator
    {
        public async Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
        {
            CacheReadResult<T> cached = await tryReadAsync(cancellationToken);
            return cached.Hit ? cached.Value : await rebuildAsync(cancellationToken);
        }
    }

    private sealed class CoordinatedArticleFrameCache(int expectedColdReads) : IUnifiedCache, IOwnedFrameCache, IDisposable
    {
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);
        private readonly TaskCompletionSource<bool> _initialColdReadsCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private OwnedAedsFrame? _articleListFrame;
        private int _coldReads;
        private int _ownedSetCount;

        public Task InitialColdReadsCompleted => _initialColdReadsCompleted.Task;

        public int OwnedSetCount => Volatile.Read(ref _ownedSetCount);

        public async Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken = default)
        {
            OwnedAedsFrame? current = Volatile.Read(ref _articleListFrame);
            if (current is not null && current.TryAcquireReadLease(out OwnedAedsFrameReadLease? lease))
            {
                return new OwnedFrameCacheReadResult(true, lease);
            }

            if (policyId == CachePolicyId.ArticleListFrame)
            {
                if (Interlocked.Increment(ref _coldReads) >= expectedColdReads)
                {
                    _initialColdReadsCompleted.TrySetResult(true);
                }

                await _initialColdReadsCompleted.Task.WaitAsync(cancellationToken);
            }

            return default;
        }

        public Task SetOwnedFrameAsync(
            CachePolicyId policyId,
            string identity,
            OwnedAedsFrame frame,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            if (policyId == CachePolicyId.ArticleListFrame)
            {
                Interlocked.Increment(ref _ownedSetCount);
                OwnedAedsFrame? previous = Interlocked.Exchange(ref _articleListFrame, frame);
                previous?.Retire();
            }
            else
            {
                frame.Retire();
            }

            return Task.CompletedTask;
        }

        public OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot()
        {
            OwnedAedsFrame? current = Volatile.Read(ref _articleListFrame);
            return current is null
                ? default
                : new OwnedFrameCacheResidencySnapshot(1, current.LogicalLength, current.Capacity);
        }

        public void Dispose() => Interlocked.Exchange(ref _articleListFrame, null)?.Retire();

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>("7");

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public async Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            string key = $"{(int)policyId}:{identity}";
            SemaphoreSlim semaphore = _locks.GetOrAdd(key, static _ => new SemaphoreSlim(1, 1));
            await semaphore.WaitAsync(cancellationToken);
            return new AsyncReleaser(semaphore);
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{(int)policyId}:{identity}:{version}";

        private sealed class AsyncReleaser(SemaphoreSlim semaphore) : IAsyncDisposable
        {
            public ValueTask DisposeAsync()
            {
                semaphore.Release();
                return ValueTask.CompletedTask;
            }
        }
    }
}
