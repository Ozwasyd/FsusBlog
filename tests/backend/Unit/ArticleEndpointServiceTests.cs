using System.Collections.Concurrent;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArticleEndpointServiceTests
{
    private static readonly TimeSpan s_concurrentColdFrameWaitTimeout = TimeSpan.FromSeconds(30);

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-page-list-async-when-cancelled-before-call-does-not-touch-cache-or-core")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-page-list-async-invalid-pagination-returns-validation-failure-without-cache-or-core")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-page-list-async-when-cancelled-after-core-load-skips-frame-cache-set")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
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

        Task<ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>[]> concurrentResults = RealConcurrencyHarness.RunAsync(Enumerable.Range(0, Callers),
            _ => service.GetPageListAsync(
                1,
                10,
                categoryId: null,
                tagId: null,
                isDeleted: false,
                canReadDeleted: true,
                status: null,
                canReadPrivate: true));

        try
        {
            await cache.InitialColdReadsCompleted.WaitAsync(s_concurrentColdFrameWaitTimeout);
            await firstCoreLoadStarted.Task.WaitAsync(s_concurrentColdFrameWaitTimeout);
        }
        finally
        {
            releaseCore.TrySetResult(true);
            await concurrentResults.WaitAsync(s_concurrentColdFrameWaitTimeout);
        }
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>>[] results = await concurrentResults.WaitAsync(s_concurrentColdFrameWaitTimeout);

        Assert.All(results, result => Assert.True(result.HasCachedFrame));
        Assert.Equal(1, Volatile.Read(ref coreLoads));
        Assert.Equal(1, cache.OwnedSetCount);
        foreach (ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result in results)
        {
            result.CachedFrame!.Dispose();
        }
        cache.Dispose();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(10)]
    [InlineData(50)]
    public async Task GetHotArticlesAsync_ConcurrentColdFrameMiss_CoalescesWholeFrameBuild(int count)
    {
        const int Callers = 100;
        var core = Substitute.For<IArticleCoreService>();
        var cache = new CoordinatedArticleFrameCache(Callers, CachePolicyId.ArticleHotFrame);
        var service = Create(
            core,
            cache: cache,
            ownedFrameCache: cache,
            cacheMissCoordinator: new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance));
        var releaseCore = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstCoreLoadStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        int coreLoads = 0;
        core.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref coreLoads) == 1)
                {
                    firstCoreLoadStarted.SetResult(true);
                }
                await releaseCore.Task;
                return Result<IReadOnlyList<PopularArticleCoreModel>>.Success([]);
            });

        Task<ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>>[] tasks = Enumerable.Range(0, Callers)
            .Select(_ => service.GetHotArticlesAsync(count))
            .ToArray();

        await cache.InitialColdReadsCompleted.WaitAsync(s_concurrentColdFrameWaitTimeout);
        await firstCoreLoadStarted.Task.WaitAsync(s_concurrentColdFrameWaitTimeout);
        releaseCore.SetResult(true);
        ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>>[] results = await Task.WhenAll(tasks)
            .WaitAsync(s_concurrentColdFrameWaitTimeout);

        Assert.Equal(1, Volatile.Read(ref coreLoads));
        Assert.Equal(1, cache.OwnedSetCount);
        Assert.All(results, static result => Assert.True(result.HasCachedFrame));
        foreach (ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> result in results)
        {
            result.CachedFrame!.Dispose();
        }
        cache.Dispose();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(10)]
    [InlineData(50)]
    public async Task GetFeaturedArticlesAsync_ConcurrentColdFrameMiss_CoalescesWholeFrameBuild(int count)
    {
        const int Callers = 100;
        var core = Substitute.For<IArticleCoreService>();
        var cache = new CoordinatedArticleFrameCache(Callers, CachePolicyId.TopArticlesFrame);
        var service = Create(
            core,
            cache: cache,
            ownedFrameCache: cache,
            cacheMissCoordinator: new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance));
        var releaseCore = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstCoreLoadStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        int coreLoads = 0;
        core.GetFeaturedArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(async _ =>
            {
                if (Interlocked.Increment(ref coreLoads) == 1)
                {
                    firstCoreLoadStarted.SetResult(true);
                }
                await releaseCore.Task;
                return Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success([]);
            });

        Task<ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>>[] tasks = Enumerable.Range(0, Callers)
            .Select(_ => service.GetFeaturedArticlesAsync(count))
            .ToArray();

        await cache.InitialColdReadsCompleted.WaitAsync(s_concurrentColdFrameWaitTimeout);
        await firstCoreLoadStarted.Task.WaitAsync(s_concurrentColdFrameWaitTimeout);
        releaseCore.SetResult(true);
        ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>>[] results = await Task.WhenAll(tasks)
            .WaitAsync(s_concurrentColdFrameWaitTimeout);

        Assert.Equal(1, Volatile.Read(ref coreLoads));
        Assert.Equal(1, cache.OwnedSetCount);
        Assert.All(results, static result => Assert.True(result.HasCachedFrame));
        foreach (ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>> result in results)
        {
            result.CachedFrame!.Dispose();
        }
        cache.Dispose();
    }

    [Fact]
    public async Task GetHotArticlesAsync_GenerationDrift_DoesNotPublishStaleFrame()
    {
        var core = Substitute.For<IArticleCoreService>();
        var hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
        int generation = 1;
        using var ownedFrameCache = new GenerationAwareFrameCache(() => Volatile.Read(ref generation));
        hotVersion.CurrentHotArticlesVersion.Returns(_ => Volatile.Read(ref generation));
        int coreLoads = 0;
        core.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                if (Interlocked.Increment(ref coreLoads) == 1)
                {
                    Volatile.Write(ref generation, 2);
                }
                return Result<IReadOnlyList<PopularArticleCoreModel>>.Success([]);
            });
        var service = Create(core, ownedFrameCache: ownedFrameCache, hotVersion: hotVersion);

        ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> result = await service.GetHotArticlesAsync(10);

        Assert.True(result.HasCachedFrame);
        Assert.Equal(2, Volatile.Read(ref coreLoads));
        var publication = Assert.Single(ownedFrameCache.Publications);
        Assert.Equal(CachePolicyId.ArticleHotFrame, publication.Policy);
        Assert.Equal("v2:frame:article-hot:aeds-v2:ranking-v1:count:10", publication.Identity);
        Assert.Equal(CachePolicyId.AdminStats, publication.Guard.PolicyId);
        Assert.Equal(IHotArticlesCacheVersionProvider.AuthorityCounterIdentity, publication.Guard.Identity);
        Assert.Equal(2, publication.Guard.ExpectedValue);
        Assert.True(publication.Accepted);
        result.CachedFrame!.Dispose();
    }

    [Fact]
    public async Task GetHotArticlesAsync_GenerationDriftDuringPublication_NeverPublishesOldFrame()
    {
        var core = Substitute.For<IArticleCoreService>();
        var hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
        int generation = 1;
        using var ownedFrameCache = new GenerationAwareFrameCache(
            () => Volatile.Read(ref generation),
            attempt =>
            {
                if (attempt == 1)
                {
                    Volatile.Write(ref generation, 2);
                }
            });
        hotVersion.CurrentHotArticlesVersion.Returns(_ => Volatile.Read(ref generation));
        core.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlyList<PopularArticleCoreModel>>.Success([]));
        var service = Create(core, ownedFrameCache: ownedFrameCache, hotVersion: hotVersion);

        ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> result = await service.GetHotArticlesAsync(10);

        Assert.True(result.HasCachedFrame);
        Assert.Collection(ownedFrameCache.Publications,
            first =>
            {
                Assert.Equal(CachePolicyId.ArticleHotFrame, first.Policy);
                Assert.Equal("v1:frame:article-hot:aeds-v2:ranking-v1:count:10", first.Identity);
                Assert.Equal(CachePolicyId.AdminStats, first.Guard.PolicyId);
                Assert.Equal(IHotArticlesCacheVersionProvider.AuthorityCounterIdentity, first.Guard.Identity);
                Assert.Equal(1, first.Guard.ExpectedValue);
                Assert.False(first.Accepted);
            },
            second =>
            {
                Assert.Equal(CachePolicyId.ArticleHotFrame, second.Policy);
                Assert.Equal("v2:frame:article-hot:aeds-v2:ranking-v1:count:10", second.Identity);
                Assert.Equal(CachePolicyId.AdminStats, second.Guard.PolicyId);
                Assert.Equal(IHotArticlesCacheVersionProvider.AuthorityCounterIdentity, second.Guard.Identity);
                Assert.Equal(2, second.Guard.ExpectedValue);
                Assert.True(second.Accepted);
            });
        Assert.False((await ownedFrameCache.TryGetOwnedFrameAsync(
            CachePolicyId.ArticleHotFrame,
            "v1:frame:article-hot:aeds-v2:ranking-v1:count:10",
            AedsFrameType.ArticleHot)).Hit);
        result.CachedFrame!.Dispose();
    }

    [Fact]
    public async Task GetHotArticlesAsync_FramePreservesBytesOrderCrcTypeAndPublicResidency()
    {
        IReadOnlyList<PopularArticleCoreModel> source =
        [
            new(PodProjector.ProjectPopularArticle(2, "two", 20), 2, "two", 20),
            new(PodProjector.ProjectPopularArticle(1, "one", 10), 1, "one", 10)
        ];
        var core = Substitute.For<IArticleCoreService>();
        core.GetHotArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlyList<PopularArticleCoreModel>>.Success(source));
        var cache = new CoordinatedArticleFrameCache(1, CachePolicyId.ArticleHotFrame);
        var service = Create(core, cache: cache, ownedFrameCache: cache);

        ArticleEndpointPayload<IReadOnlyList<PopularArticleCoreModel>> result = await service.GetHotArticlesAsync(2);

        Assert.True(result.HasCachedFrame);
        ReadOnlyMemory<byte> actual = result.CachedFrame!.Memory;
        using OwnedAedsFrame expectedOwner = AedsOwnedFrameBuilder.BuildOwned(
            AedsFrameType.ArticleHot,
            writer => PodBinaryCodec.WritePopularArticles(source, writer));
        using OwnedAedsFrameReadLease expected = expectedOwner.AcquireReadLease();
        Assert.True(actual.Span.SequenceEqual(expected.Memory.Span));
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(actual);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ArticleHot, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodePopularArticles(decoded.Value.Payload, out IReadOnlyList<PopularArticleCoreModel> roundTrip));
        Assert.Equal([2, 1], roundTrip.Select(static item => item.Id).ToArray());
        Assert.False(AedsFrameSensitivity.RequiresClear(AedsFrameType.ArticleHot));
        OwnedFrameCacheResidencySnapshot residency = cache.GetOwnedFrameResidencySnapshot();
        Assert.Equal(1, residency.EntryCount);
        Assert.Equal(actual.Length, residency.LogicalBytes);
        result.CachedFrame.Dispose();
        cache.Dispose();
    }

    [Fact]
    public async Task GetFeaturedArticlesAsync_FramePreservesBytesOrderCrcTypeAndPublicResidency()
    {
        DateTime created = new(2026, 8, 2, 1, 2, 3, DateTimeKind.Utc);
        IReadOnlyList<FeaturedArticleCoreModel> source =
        [
            new(2, "two", "/two.webp", 20, created, new ArticleCategoryCoreModel(7, "cat")),
            new(1, "one", "/one.webp", 10, created.AddMinutes(-1), new ArticleCategoryCoreModel(8, "other"))
        ];
        var core = Substitute.For<IArticleCoreService>();
        core.GetFeaturedArticlesAsync(Arg.Any<ArticleCountQuery>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlyList<FeaturedArticleCoreModel>>.Success(source));
        var cache = new CoordinatedArticleFrameCache(1, CachePolicyId.TopArticlesFrame);
        var service = Create(core, cache: cache, ownedFrameCache: cache);

        ArticleEndpointPayload<IReadOnlyList<FeaturedArticleSummaryDto>> result = await service.GetFeaturedArticlesAsync(2);

        Assert.True(result.HasCachedFrame);
        ReadOnlyMemory<byte> actual = result.CachedFrame!.Memory;
        IReadOnlyList<FeaturedArticleSummaryDto> projected = source.Select(static item => new FeaturedArticleSummaryDto(
            item.Id,
            item.Title,
            item.CoverImageUrl,
            item.Views,
            item.CreateTime,
            new ArticleCategoryView(item.Category.Id, item.Category.Name))).ToArray();
        using OwnedAedsFrame expectedOwner = AedsOwnedFrameBuilder.BuildOwned(
            AedsFrameType.ArticleFeatured,
            writer => PodBinaryCodec.WriteFeaturedArticles(projected, writer));
        using OwnedAedsFrameReadLease expected = expectedOwner.AcquireReadLease();
        Assert.True(actual.Span.SequenceEqual(expected.Memory.Span));
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(actual);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ArticleFeatured, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeFeaturedArticles(decoded.Value.Payload, out IReadOnlyList<FeaturedArticleSummaryDto> roundTrip));
        Assert.Equal([2, 1], roundTrip.Select(static item => item.Id).ToArray());
        Assert.False(AedsFrameSensitivity.RequiresClear(AedsFrameType.ArticleFeatured));
        OwnedFrameCacheResidencySnapshot residency = cache.GetOwnedFrameResidencySnapshot();
        Assert.Equal(1, residency.EntryCount);
        Assert.Equal(actual.Length, residency.LogicalBytes);
        result.CachedFrame.Dispose();
        cache.Dispose();
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task GetPageListAsync_PublicCursor_ValidatesFilterAndUsesCursorCacheIdentity()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var cursorCodec = CreateCursorCodec();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache, cursorCodec: cursorCodec);
        var position = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42);
        string cursor = cursorCodec.Encode(
            position,
            categoryId: 7,
            tagId: null,
            normalizedKeyword: string.Empty,
            pageSize: 10,
            queryVersion: 11,
            ArticleListSortMode.Latest);
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-page-list-async-invalid-or-cross-filter-cursor-fails-before-cache-and-core")]
    public async Task GetPageListAsync_InvalidOrCrossFilterCursor_FailsBeforeCacheAndCore()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var cursorCodec = CreateCursorCodec();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache, cursorCodec: cursorCodec);
        string cursor = cursorCodec.Encode(
            new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42),
            categoryId: 7,
            tagId: null,
            normalizedKeyword: string.Empty,
            pageSize: 10,
            queryVersion: 11,
            ArticleListSortMode.Latest);
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
        await cache.Received(1).GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>());
        await ownedFrameCache.DidNotReceiveWithAnyArgs().TryGetOwnedFrameAsync(default, (string)null!, default, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public async Task GetPageListAsync_PublicSecondPageWithoutCursor_FailsBeforeCacheAndCore()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> result = await service.GetPageListAsync(
            2,
            10,
            categoryId: null,
            tagId: null,
            isDeleted: false,
            canReadDeleted: false,
            status: null,
            canReadPrivate: false);

        Assert.False(result.Result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Result.Error.Code);
        await cache.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
        await ownedFrameCache.DidNotReceiveWithAnyArgs().TryGetOwnedFrameAsync(default, (string)null!, default, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-async-preserves-lifecycle-validation-details")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-update-async-preserves-lifecycle-validation-details")]
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
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
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
        IArticleMutationCommandService? mutations = null,
        IHotArticlesCacheVersionProvider? hotVersion = null,
        IArticleListCursorCodec? cursorCodec = null)
    {
        cache ??= Substitute.For<IUnifiedCache>();
        ownedFrameCache ??= CreateOwnedFrameCacheSubstitute();
        if (hotVersion is null)
        {
            hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
            hotVersion.CurrentHotArticlesVersion.Returns(1);
        }

        return new ArticleEndpointService(
            core,
            mutations ?? Substitute.For<IArticleMutationCommandService>(),
            cache,
            ownedFrameCache,
            cacheMissCoordinator ?? new PassthroughCacheMissCoordinator(),
            artifacts ?? Substitute.For<IArticleDetailAedsArtifactStore>(),
            projection ?? Substitute.For<IPublicArticleProjectionStore>(),
            scheduler ?? Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            hotVersion,
            cursorCodec ?? CreateCursorCodec());
    }

    private static ArticleListCursorCodec CreateCursorCodec()
        => new(new EphemeralDataProtectionProvider(), TimeProvider.System);

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
        cache.TrySetOwnedFrameAsync(
                Arg.Any<CachePolicyId>(),
                Arg.Any<string>(),
                Arg.Any<OwnedAedsFrame>(),
                Arg.Any<OwnedFramePublicationGuard>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                call.Arg<OwnedAedsFrame>().Retire();
                return true;
            });
        return cache;
    }

    private sealed class GenerationAwareFrameCache(Func<long> currentGeneration, Action<int>? beforePublication = null)
        : IOwnedFrameCache, IDisposable
    {
        private readonly Dictionary<string, OwnedAedsFrame> _frames = new(StringComparer.Ordinal);
        public List<(CachePolicyId Policy, string Identity, OwnedFramePublicationGuard Guard, bool Accepted)> Publications { get; } = [];

        public Task<OwnedFrameCacheReadResult> TryGetOwnedFrameAsync(
            CachePolicyId policyId, string identity, AedsFrameType expectedFrameType, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_frames.TryGetValue(identity, out OwnedAedsFrame? frame)
                && frame.TryAcquireReadLease(out OwnedAedsFrameReadLease? lease)
                    ? new OwnedFrameCacheReadResult(true, lease)
                    : default);
        }

        public Task<bool> TrySetOwnedFrameAsync(
            CachePolicyId policyId, string identity, OwnedAedsFrame frame,
            OwnedFramePublicationGuard publicationGuard, TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            beforePublication?.Invoke(Publications.Count + 1);
            bool accepted = currentGeneration() == publicationGuard.ExpectedValue;
            Publications.Add((policyId, identity, publicationGuard, accepted));
            if (accepted)
            {
                if (_frames.Remove(identity, out OwnedAedsFrame? old))
                {
                    old.Retire();
                }
                _frames.Add(identity, frame);
            }
            else
            {
                frame.Retire();
            }
            return Task.FromResult(accepted);
        }

        public Task SetOwnedFrameAsync(CachePolicyId policyId, string identity, OwnedAedsFrame frame,
            TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public OwnedFrameCacheResidencySnapshot GetOwnedFrameResidencySnapshot() => throw new NotSupportedException();

        public void Dispose()
        {
            foreach (OwnedAedsFrame frame in _frames.Values)
            {
                frame.Retire();
            }
            _frames.Clear();
        }
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

    private sealed class CoordinatedArticleFrameCache(
        int expectedColdReads,
        CachePolicyId coordinatedPolicy = CachePolicyId.ArticleListFrame) : IUnifiedCache, IOwnedFrameCache, IDisposable
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

            if (policyId == coordinatedPolicy)
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
            if (policyId == coordinatedPolicy)
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
