using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class ScheduledPublishWorkerTests
{
    [Fact]
    public void ScheduledPublish_SourceWritesOnlyOutboxWithPublishedStateCommit()
    {
        string source = ReadSource("src/backend/Services/Background/ScheduledPublishWorker.cs");
        string method = Slice(source, "internal async Task<int> PublishDueArticlesAsync", "        finally");
        string claim = Slice(source, "private static async Task<ScheduledPublishBatchCommit> ClaimDueArticlesAsync", "    private static async Task<int> EstimateBacklogAsync");

        Assert.Contains("db.Ado.UseTranAsync", claim, StringComparison.Ordinal);
        Assert.Contains("BuildScheduledPublishOutboxEvent(articleId, now)", source, StringComparison.Ordinal);
        Assert.Contains("ArticleMutationOutboxEvent", source, StringComparison.Ordinal);
        Assert.Contains("\"scheduled-published\"", source, StringComparison.Ordinal);
        Assert.Contains("TransactionSideEffectGuard.CanPublishAfterCommit", claim, StringComparison.Ordinal);
        Assert.DoesNotContain("it remains scheduled for retry", method, StringComparison.Ordinal);
        Assert.DoesNotContain("ISearchIndexService", method, StringComparison.Ordinal);
        Assert.DoesNotContain("IPublicAotInvalidationService", method, StringComparison.Ordinal);
        Assert.DoesNotContain("ICacheInvalidationDispatcher", method, StringComparison.Ordinal);
        Assert.DoesNotContain("searchIndex.AddOrUpdateIndexAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("publicAotInvalidation.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("invalidation.InvalidateArticleMutationAsync", method, StringComparison.Ordinal);

        int outbox = claim.IndexOf("BuildScheduledPublishOutboxEvent(articleId, now)", StringComparison.Ordinal);
        int commitGuard = claim.IndexOf("TransactionSideEffectGuard.CanPublishAfterCommit", StringComparison.Ordinal);
        Assert.True(outbox >= 0);
        Assert.True(commitGuard > outbox);
    }

    [Fact]
    public void ScheduledPublish_SourceClaimsAndOutboxesDueArticlesInOneBatchTransaction()
    {
        string source = ReadSource("src/backend/Services/Background/ScheduledPublishWorker.cs");
        string publish = Slice(source, "internal async Task<int> PublishDueArticlesAsync", "        finally");
        string claim = Slice(source, "private static async Task<ScheduledPublishBatchCommit> ClaimDueArticlesAsync", "    private static async Task<int> EstimateBacklogAsync");

        Assert.Contains("\"scheduled-publish-batch-commit\"", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-due-query\"", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("\"scheduled-publish-commit\"", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (Article article in due)", publish, StringComparison.Ordinal);

        Assert.Contains("UPDATE article", claim, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE SKIP LOCKED", claim, StringComparison.Ordinal);
        Assert.Contains("RETURNING id", claim, StringComparison.Ordinal);
        Assert.Contains("BuildScheduledPublishOutboxEvent(articleId, now)", claim, StringComparison.Ordinal);
        Assert.Contains("db.Insertable(outboxEvents).ExecuteCommandAsync", claim, StringComparison.Ordinal);
        Assert.Contains("ScheduledPublishBatchCommit", source, StringComparison.Ordinal);
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
            runtimeState,
            new TestBackgroundWorkerLease());

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

    private sealed class TestBackgroundWorkerLease : IBackgroundWorkerLease
    {
        public Task<bool> TryRunAsLeaderAsync(
            string workerName,
            Func<CancellationToken, Task> action,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }
}
