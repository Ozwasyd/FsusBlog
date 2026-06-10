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

    private static ArticleEndpointService Create(
        IArticleCoreService core,
        IArticleDetailAedsArtifactStore artifacts,
        IArticleDetailAedsArtifactBackfillScheduler scheduler)
        => new(
            core,
            Substitute.For<IArticleService>(),
            Substitute.For<IUnifiedCache>(),
            new AedsEncoder(),
            artifacts,
            scheduler);
}
