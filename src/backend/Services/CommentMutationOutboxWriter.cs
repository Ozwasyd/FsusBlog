using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services;

public interface ICommentMutationOutbox
{
    Task EnqueueAsync(CommentMutationOutboxEvent item, CancellationToken cancellationToken = default);
}

public sealed class CommentMutationOutboxWriter(
    ISqlSugarClient db,
    TimeProvider? timeProvider = null) : ICommentMutationOutbox
{
    public async Task EnqueueAsync(CommentMutationOutboxEvent item, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (item.CommentId <= 0 || item.ArticleId <= 0 || item.RootId <= 0 || string.IsNullOrWhiteSpace(item.EventType))
        {
            throw new InvalidOperationException("Comment outbox event is missing its aggregate identity.");
        }

        item.EventId = string.IsNullOrWhiteSpace(item.EventId) ? Guid.NewGuid().ToString("D") : item.EventId;
        item.PayloadJson = "{}";
        item.Status = CommentMutationOutboxStatus.Pending;
        // The worker claims rows by the injected TimeProvider; clamp the first attempt
        // to that clock so producers on the wall clock stay claimable under frozen
        // temporal contexts while remaining identical in production.
        DateTime claimNow = timeProvider?.GetUtcNow().UtcDateTime ?? item.OccurredAtUtc;
        item.NextAttemptAt = item.OccurredAtUtc <= claimNow ? item.OccurredAtUtc : claimNow;
        await db.Insertable(item).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
    }
}
