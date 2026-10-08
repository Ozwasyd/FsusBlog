using FsusBlog.Server.Services.Background;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// Reads existing worker-owned diagnostics without claiming that last-cycle counts
/// are current-namespace durable or worker-local observations. No caller-supplied
/// run coordinates can turn this source capture into qualified quiescence.
/// </summary>
public sealed class OutboxQuiescenceSourceReader(
    CommentMutationOutboxRuntimeState? comment,
    ScheduledPublishRuntimeState? scheduled)
{
    public QuiescenceSourceCapture ReadComment(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CommentMutationOutboxRuntimeSnapshot? snapshot = comment?.CreateSnapshot();
        return QuiescenceSourceCapture.Create(
            "comment-mutation-outbox",
            "CommentMutationOutboxRuntimeState.CreateSnapshot/v1",
            snapshot is not null,
            new Dictionary<string, long?>
            {
                ["backlog-count"] = snapshot?.BacklogCount,
                ["failed-count"] = snapshot?.FailedCount,
                ["poison-count"] = snapshot?.PoisonCount,
                ["owned-count"] = snapshot?.OwnedCount,
                ["processed-count"] = snapshot?.ProcessedCount,
                ["lost-count"] = snapshot?.LostCount,
                ["collector-error"] = snapshot is null ? null : snapshot.LastError is null ? 0 : 1
            },
            new[]
            {
                "current-run-namespace-and-runtime-identity=unavailable",
                "immutable-and-committed-watermarks=unavailable",
                "worker-incarnation-and-live-in-flight-claims=unavailable",
                "failed-poison-overlap-and-terminal-policy=unavailable",
                "commit-postcondition=unavailable",
                snapshot is null ? "source=unavailable" : "source=last-cycle-diagnostics"
            });
    }

    public QuiescenceSourceCapture ReadScheduled(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ScheduledPublishRuntimeSnapshot? snapshot = scheduled?.CreateSnapshot();
        return QuiescenceSourceCapture.Create(
            "scheduled-publication",
            "ScheduledPublishRuntimeState.CreateSnapshot/v1",
            snapshot is not null,
            new Dictionary<string, long?>
            {
                ["due-backlog"] = snapshot?.DueBacklog,
                ["last-published-count"] = snapshot?.LastPublishedCount,
                ["last-failed-count"] = snapshot?.LastFailedCount,
                ["collector-error"] = snapshot is null ? null : snapshot.LastError is null ? 0 : 1
            },
            new[]
            {
                "current-run-namespace-and-runtime-identity=unavailable",
                "immutable-and-committed-watermarks=unavailable",
                "active-claim-lease-owner-and-generation=unavailable",
                "live-processing-and-terminal-policy=unavailable",
                "article-publication-commit-postcondition=unavailable",
                snapshot is null ? "source=unavailable" : "source=last-cycle-diagnostics"
            });
    }

    public QuiescenceSourceCapture ReadArticle(CancellationToken cancellationToken = default)
        => ReadUnavailable("article-mutation-outbox", "ArticleMutationOutboxDispatcher:read-only-observer-absent", cancellationToken);

    public QuiescenceSourceCapture ReadManagedMutationClaims(CancellationToken cancellationToken = default)
        => ReadUnavailable("background-mutation-claims", "ActiveReleaseFencedCommit:read-only-claim-enumeration-absent", cancellationToken);

    private static QuiescenceSourceCapture ReadUnavailable(string domain, string sourceApi, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return QuiescenceSourceCapture.Create(domain, sourceApi, false,
            new Dictionary<string, long?>
            {
                ["pending-count"] = null,
                ["in-flight-count"] = null,
                ["active-claim-count"] = null,
                ["active-mutation-transaction-count"] = null,
                ["terminal-failure-count"] = null
            },
            ["read-only-owner-api=unavailable", "current-run-namespace-and-runtime-identity=unavailable",
                "immutable-watermark-and-worker-generation=unavailable", "commit-postcondition=unavailable"]);
    }
}
