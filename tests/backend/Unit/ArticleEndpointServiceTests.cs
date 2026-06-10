using FsusBlog.Core.Common;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleEndpointServiceTests
{
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
        var service = Create(core, cache: cache);
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
        await cache.DidNotReceiveWithAnyArgs().TryGetRawReadonlyAsync(default, default!, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default, default, default, default);
    }

    [Fact]
    public async Task GetPageListAsync_WhenCancelledAfterCoreLoad_SkipsFrameCacheSet()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var service = Create(core, cache: cache);
        using var cts = new CancellationTokenSource();
        var page = new CorePageResult<ArticleListCoreModel>([], 0);

        cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main", Arg.Any<CancellationToken>())
            .Returns("7");
        cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleListFrame, Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));
        core.GetPageListAsync(
                Arg.Any<int>(),
                Arg.Any<int>(),
                Arg.Any<int?>(),
                Arg.Any<int?>(),
                Arg.Any<bool>(),
                Arg.Any<int?>(),
                Arg.Any<bool>(),
                Arg.Any<string?>(),
                Arg.Any<long?>(),
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

        await cache.DidNotReceiveWithAnyArgs().SetRawAsync(default, default!, default!, default, default);
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

    private static ArticleEndpointService Create(
        IArticleCoreService core,
        IArticleDetailAedsArtifactStore? artifacts = null,
        IArticleDetailAedsArtifactBackfillScheduler? scheduler = null,
        IUnifiedCache? cache = null,
        IArticleService? articles = null)
    {
        var hotVersion = Substitute.For<IHotArticlesCacheVersionProvider>();
        hotVersion.BuildVersionedHotArticlesIdentity(Arg.Any<string>())
            .Returns(call => $"v1:{call.Arg<string>()}");

        return new ArticleEndpointService(
            core,
            articles ?? Substitute.For<IArticleService>(),
            cache ?? Substitute.For<IUnifiedCache>(),
            new AedsEncoder(),
            artifacts ?? Substitute.For<IArticleDetailAedsArtifactStore>(),
            scheduler ?? Substitute.For<IArticleDetailAedsArtifactBackfillScheduler>(),
            hotVersion);
    }
}
