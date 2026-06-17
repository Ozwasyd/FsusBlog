using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ScheduledPublishWorkerTests
{
    [Fact]
    public void ScheduledPublish_SourceWritesOutboxWithPublishedStateCommit()
    {
        string source = ReadSource("src/backend/Services/Background/ScheduledPublishWorker.cs");
        string method = Slice(source, "internal async Task<int> PublishDueArticlesAsync", "        finally");

        Assert.Contains("db.Ado.UseTranAsync", method, StringComparison.Ordinal);
        Assert.Contains("BuildScheduledPublishOutboxEvent(article.Id, outboxEventId, now)", method, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationOutboxEvent", source, StringComparison.Ordinal);
        Assert.Contains("\"scheduled-published\"", source, StringComparison.Ordinal);
        Assert.Contains("TransactionSideEffectGuard.CanPublishAfterCommit", method, StringComparison.Ordinal);
        Assert.DoesNotContain("it remains scheduled for retry", method, StringComparison.Ordinal);

        int outbox = method.IndexOf("BuildScheduledPublishOutboxEvent(article.Id, outboxEventId, now)", StringComparison.Ordinal);
        int commitGuard = method.IndexOf("TransactionSideEffectGuard.CanPublishAfterCommit", StringComparison.Ordinal);
        int sideEffect = method.IndexOf("searchIndex.AddOrUpdateIndexAsync(article)", StringComparison.Ordinal);
        Assert.True(outbox >= 0);
        Assert.True(commitGuard > outbox);
        Assert.True(sideEffect > commitGuard);
    }

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

    private static string ReadSource(string relativePath)
        => BackendTestPaths.ReadAllTextFromRoot(relativePath);

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }
}
