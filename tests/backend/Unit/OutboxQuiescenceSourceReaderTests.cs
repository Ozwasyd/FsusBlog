using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Background;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OutboxQuiescenceSourceReaderTests
{
    [Fact]
    public void CommentPendingPoisonAndOwnedWorkArePreservedWithoutCombiningFailureCategories()
    {
        var state = new CommentMutationOutboxRuntimeState();
        state.Update(1, 2, 2, 10, 3, DateTime.UtcNow, null, owned: 1);
        CommentMutationOutboxRuntimeSnapshot before = state.CreateSnapshot();
        var reader = new OutboxQuiescenceSourceReader(state, null);
        QuiescenceSourceCapture result = reader.ReadComment();

        Assert.True(result.SourceAvailable);
        Assert.Equal(1, result.Metrics["backlog-count"]);
        Assert.Equal(1, result.Metrics["owned-count"]);
        Assert.Equal(2, result.Metrics["failed-count"]);
        Assert.Equal(2, result.Metrics["poison-count"]);
        Assert.Contains("failed-poison-overlap-and-terminal-policy=unavailable", result.Blockers);
        Assert.False(result.RuntimeQualified);
        Assert.Equal(before, state.CreateSnapshot());
        Assert.Equal(result.SemanticDigest, reader.ReadComment().SemanticDigest);
    }

    [Fact]
    public void IdleDiagnosticZerosDoNotSupplyLiveClaimsWatermarksOrNamespace()
    {
        var reader = new OutboxQuiescenceSourceReader(new CommentMutationOutboxRuntimeState(), new ScheduledPublishRuntimeState());
        foreach (QuiescenceSourceCapture result in new[] { reader.ReadComment(), reader.ReadScheduled() })
        {
            Assert.False(result.RuntimeQualified);
            Assert.Contains("current-run-namespace-and-runtime-identity=unavailable", result.Blockers);
            Assert.Contains("immutable-and-committed-watermarks=unavailable", result.Blockers);
        }
    }

    [Fact]
    public void MissingWorkersAndReadOnlyOwnerApisStayUnavailableWithNullCounts()
    {
        var reader = new OutboxQuiescenceSourceReader(null, null);
        foreach (QuiescenceSourceCapture result in new[]
        {
            reader.ReadComment(), reader.ReadScheduled(), reader.ReadArticle(), reader.ReadManagedMutationClaims()
        })
        {
            Assert.False(result.SourceAvailable);
            Assert.False(result.RuntimeQualified);
            Assert.All(result.Metrics.Values, static value => Assert.Null(value));
        }
    }

    [Fact]
    public void ScheduledCountsAreLastCycleDiagnosticsAndReadingDoesNotPublishOrClearFailure()
    {
        var state = new ScheduledPublishRuntimeState();
        state.ReportResult(4, 1, 2);
        ScheduledPublishRuntimeSnapshot before = state.CreateSnapshot();
        var reader = new OutboxQuiescenceSourceReader(null, state);
        QuiescenceSourceCapture result = reader.ReadScheduled();
        Assert.Equal(2, result.Metrics["due-backlog"]);
        Assert.Equal(1, result.Metrics["last-failed-count"]);
        Assert.Contains("active-claim-lease-owner-and-generation=unavailable", result.Blockers);
        Assert.Equal(before, state.CreateSnapshot());
        state.ReportResult(4, 1, 3);
        Assert.NotEqual(result.SemanticDigest, reader.ReadScheduled().SemanticDigest);
    }

    [Fact]
    public void DiagnosticClockIsExcludedFromDigestAndCancellationPrecedesReading()
    {
        var state = new ScheduledPublishRuntimeState();
        var reader = new OutboxQuiescenceSourceReader(null, state);
        state.ReportResult(1, 0, 0);
        string digest = reader.ReadScheduled().SemanticDigest;
        state.ReportResult(1, 0, 0);
        Assert.Equal(digest, reader.ReadScheduled().SemanticDigest);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => reader.ReadComment(cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => reader.ReadScheduled(cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => reader.ReadArticle(cancellation.Token));
        Assert.Throws<OperationCanceledException>(() => reader.ReadManagedMutationClaims(cancellation.Token));
    }
}
