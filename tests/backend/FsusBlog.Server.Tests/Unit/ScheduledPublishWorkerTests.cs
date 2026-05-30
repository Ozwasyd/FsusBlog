using FsusBlog.Server.Services.Background;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ScheduledPublishWorkerTests
{
    [Fact]
    public async Task PublishDueArticlesAsync_WhenScopeCreationFails_ReportsDegradedRuntimeState()
    {
        var scopeFactory = Substitute.For<IServiceScopeFactory>();
        scopeFactory.CreateScope().Returns(_ => throw new InvalidOperationException("scope unavailable"));
        var runtimeState = new ScheduledPublishRuntimeState();
        var worker = new ScheduledPublishWorker(
            scopeFactory,
            NullLogger<ScheduledPublishWorker>.Instance,
            TimeProvider.System,
            runtimeState);

        int published = await worker.PublishDueArticlesAsync(CancellationToken.None);

        ScheduledPublishRuntimeSnapshot snapshot = runtimeState.CreateSnapshot();
        Assert.Equal(0, published);
        Assert.Equal("degraded", snapshot.Status);
        Assert.Equal(1, snapshot.LastFailedCount);
        Assert.Equal(nameof(InvalidOperationException), snapshot.LastError);
    }
}
